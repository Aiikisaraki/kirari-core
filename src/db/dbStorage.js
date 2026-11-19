const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
// 事件流 / 任务 / 定时任务的 schema 由平级共享包 kirari-agent 定义，两端各自执行同一份 DDL，
// 保证同一份 pet_sessions.db 里的 session_events / tasks / scheduled_jobs 不分叉。
const {
  SESSION_EVENTS_DDL, SESSION_EVENTS_COLUMNS,
  TASKS_DDL, TASKS_COLUMNS,
  SCHEDULED_JOBS_DDL, SCHEDULED_JOBS_COLUMNS,
} = require('kirari-agent');

// 数据库位置：统一走 src/dataDir.js → kirariHome.js 的数据根（~/.kirari）。
// 解析优先级：env KIRARI_HOME > env PET_API_DATA_DIR > env KIRARI_DESKTOP_DATA_DIR > ~/.kirari
// 两端读写同一个 database/pet_sessions.db —— 桌宠里聊的、控制台里聊的是同一份记录。
// 数据库位置由 kirariHome 的 LAYOUT 决定（~/.kirari/database/pet_sessions.db）；
// 不再往数据根上拼文件名 —— 布局改动只改 kirariHome.js 一处，两端自动跟上。
const { paths } = require('../dataDir');
const DB_PATH = paths.database;
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
// 并发写保护：桌宠版的进程内引擎与核心版（本地模式是它拉起的子进程）会开**同一个**
// pet_sessions.db。WAL 让「一个写 + 多个读」可以并行，是这种双进程场景的正解；
// 桌宠版那一侧本来就在用 WAL（模式是文件级、持久生效），这里显式设一次保证一致，
// 并用 try 兜住 —— 网络文件系统上 WAL 可能开不起来，那种场景退回默认日志也能跑。
try {
  db.pragma('journal_mode = WAL');
} catch {
  /* 开不了 WAL（如网络盘）：保持默认日志模式，busy_timeout 仍能兜住大部分竞争 */
}
// busy_timeout：没有它，一端正在写时另一端立刻 SQLITE_BUSY 报错，而不是等一等。
db.pragma('busy_timeout = 5000');

/**
 * 单个会话保留的消息条数上限。
 *
 * 这张表现在是 UI 投影缓存（真源是 session_events 事件流），所以这个值同时是
 * 「界面能翻回多早」的界限。500 条足够日常使用又不至于让单文件无限膨胀；
 * 上下文窗口与此无关（由 getRecentMessages 按需取最近几条）。
 */
const MAX_MESSAGES_PER_SESSION = 500;

/** 存储的 content 还原：多模态时是 JSON 数组，否则原样返回纯文本。 */
function parseStoredContent(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // 非 JSON → 纯文本，保持原样
  }
  return raw;
}

/** images_json 列 → string[]；坏 JSON 当空数组（不抛，历史记录不该让界面崩）。 */
function safeJsonArray(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** SQLite 的 CURRENT_TIMESTAMP 是 UTC "YYYY-MM-DD HH:MM:SS"，转成毫秒时间戳。 */
function toEpochMs(ts) {
  if (ts == null) return Date.now();
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(`${String(ts).replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** 给查询结果补上 UI 扩展字段（情绪 / 图片），保持返回形状统一。 */
function withUiExtras(row) {
  return {
    role: row.role,
    content: parseStoredContent(row.content),
    emotion: row.emotion || null,
    images: safeJsonArray(row.images_json),
  };
}

// ── 模型配置的路由层 ──────────────────────────────────────────────
// 控制台账号（BOT_MODEL_UID，默认 1）的多模型/搜索配置走 **config.json 文件**
// （src/services/modelConfigFile.js，与桌面端同构）；其他 uid 走下面的 SQLite 旧路径。
// 为什么这样分：控制台只管一个账号，文件可手改、可和桌面端互相拷贝；
// 旧的多账号表保留给历史数据，不再为它加新功能。
const modelConfigFile = require('../services/modelConfigFile');

function fileOwnedUid() {
    const v = Number(process.env.BOT_MODEL_UID);
    return Number.isSafeInteger(v) && v > 0 ? v : 1;
}
const isFileOwned = (uid) => uid === fileOwnedUid();
// 模型配置的唯一入口是**多模型系统**（控制台 /api/models，存 SQLite）。
// ⚠️ .env 不提供、也不允许提供模型地址（旧 MODEL_ENDPOINT/MODEL_API_ENDPOINT 已删除）。
// 半配置状态（有密钥没地址）一律视为「未配置」：读出来是空串，聊天入口会给
// 「先去控制台配置大脑」的明确报错，绝不静默套一个默认地址。

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 桌宠版聊天界面需要的两个扩展字段（可空）。核心版自己的消息不写它们，
    -- 但读历史时要原样带回 —— 两端聊天记录互通靠的就是这两列。
    -- 老库由下面的 ALTER TABLE 迁移补上。
    emotion TEXT, images_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userid INTEGER NOT NULL UNIQUE, token TEXT NOT NULL,
    view_password TEXT NOT NULL, client_id TEXT, model TEXT NOT NULL DEFAULT 'gpt-5.4-mini', api_endpoint TEXT, search_key TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_userid ON api_tokens(userid);
  CREATE TABLE IF NOT EXISTS api_clients (
    client_id TEXT PRIMARY KEY, userid INTEGER NOT NULL UNIQUE, public_key TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    uid INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bot_locations (
    owner_uid INTEGER NOT NULL,
    scope TEXT NOT NULL,
    location TEXT, location_raw TEXT, location_name TEXT, location_admin1 TEXT,
    location_country TEXT, location_country_code TEXT,
    latitude REAL, longitude REAL, location_source TEXT,
    location_timezone TEXT, location_asked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_uid, scope)
  );
  CREATE TABLE IF NOT EXISTS daily_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL,
    date TEXT NOT NULL,
    brief_text TEXT NOT NULL,
    topics_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userid, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_memory_user_date ON daily_memory(userid, date);
  -- ── 长期记忆（2026-11-19 用户拍板：记忆不能随会话撕裂）────────────────
  -- 旧模型只有「按 session_id 存的消息」，于是新开一个对话她就像不认识你。
  -- 现在引入 subject 分层：一层记忆挂在谁身上、在哪个场合可见，两个维度都存字段里。
  --
  -- subject 分层（决定「谁会记得这件事」）：
  --   person::{key}        某个具体的对话者（平台账号）→ 只在这个人相关的场合可见
  --   self::{uid}          关于她自己 / 拥有者本人的长期事实 → 一对一时可见
  --   scene::{scope}       某个场合（某群）的公共记忆 → 只在这个场合可见
  --   global               世界知识、约定、不需要归属的事实 → 所有场合可见
  --
  -- visibility 是**相对对话者**的，不是相对「是不是主人」的：
  --   public   任何场合都能提（如"她喜欢猫"这类无害事实）
  --   private  只在私下/一对一能提，群聊里绝不外泄
  --   secret   只有当这段记忆本来就是「关于此刻这个人」时才可读
  --            （关于 B 的私事，A 在一对一里也读不到 —— 这才是"每人一套独立记忆"）
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    -- 这条记忆是在哪个会话产生的（用于溯源与"别在来源场合之外复述"判断）
    origin_session TEXT,
    -- 这条记忆说的是「谁的事」（平台账号）。与 subject 不同：
    --   subject 决定存进谁的池子，about_person 决定内容是关于谁的。
    -- 例：A 跟我说「B 最近失恋了」→ subject=person:A（A 转述的，存在 A 的池），
    --     about_person=B（内容关于 B）。这样 B 问起时她知道，也能判断对 A 该不该讲。
    about_person TEXT,
    -- 谁说的：owner / guest / self（她自己观察得出）。仅溯源，不参与可见性判断。
    source TEXT NOT NULL DEFAULT 'owner',
    -- 重要度 1-5：检索排序用，也是"要不要主动想起"的门槛
    importance INTEGER NOT NULL DEFAULT 3,
    -- 命中次数与最近命中时间：让"反复用到"的记忆自然浮上来
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at DATETIME,
    -- 软删除：用户说"忘掉"时置位，保留审计痕迹而不是物理抹除
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject, deleted);
  CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, deleted);

  -- ── 人（每个对话者一份稳定档案）────────────────────────────────────
  -- 身份不是「主人 / 客人」二元。每个跟她说过话的人都在这里有自己的一条记录，
  -- 各自有独立的记忆池。role 只表达**管理权限**（谁能改她的设置、看她的内部状态），
  -- 不决定她记得谁、也不决定记忆给谁看。
  --
  -- key：平台内稳定的对话者标识（如 onebot 的 QQ 号）。跨平台同名不加协商，
  --      因为不同平台的同一个人无法自动确认（宁可不合并，也不要张冠李戴）。
  CREATE TABLE IF NOT EXISTS people (
    person_key TEXT PRIMARY KEY,
    -- owner: 拥有者（最高管理权，可改设置/查内部状态）
    -- admin: 被信任的人（可用自我运维只读）
    -- user : 普通对话者（默认）
    role TEXT NOT NULL DEFAULT 'user',
    -- 显示用昵称/群名片，随每次对话更新（不覆盖成空）
    display_name TEXT,
    -- 平台来源（onebot / qqofficial / desktop ...），仅用于溯源
    platform TEXT,
    -- 她对这个人的称呼偏好（对方让我怎么叫他），空则用 display_name
    alias TEXT,
    -- 她对这个人的整体印象/说话方式备注（自由文本，她自己维护）
    notes TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ── 记忆关联（联想网络）────────────────────────────────────────────
  -- 「这些记忆可以随着人际关系的拓展而产生互相关联」：
  --   a 通常是 memories.id 或 person key，b 同理，relation 描述怎么关联。
  -- 例：(person:1001) --knows--> (person:2002)  A 和 B 认识
  --     (memories:12)  --about--> (person:1001)  这条记忆是关于 A 的
  --     (memories:12)  --related--> (memories:33) 两件事相关
  CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    -- 关联强度 1-5：影响联想扩散的深度
    weight INTEGER NOT NULL DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(a, b, relation)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_links_a ON memory_links(a, relation);
  CREATE INDEX IF NOT EXISTS idx_memory_links_b ON memory_links(b, relation);

  -- ── 社交环境快照（她所处的真实世界）────────────────────────────────
  -- 用户 2026-11-19：「我希望她能完整意识到自己的人际关系和周围的环境」——
  -- 「我在几个群」「有几个好友」「群里有多少人」这些是**协议端就知道**的事实，
  -- 不该靠猜。这些表缓存 get_group_list / get_friend_list / get_group_member_list
  -- 的结果，以及 notice 事件（谁加群/退群/戳一戳），让她随时能查到自己的处境。
  --
  -- adapter_id + external_id 是协议端的原生标识（群号/QQ号/群成员 QQ）。
  CREATE TABLE IF NOT EXISTS social_groups (
    adapter_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    group_name TEXT,
    member_count INTEGER,
    max_member_count INTEGER,
    -- 她对这群的观感/氛围备注（自由文本，她自己维护）
    notes TEXT,
    -- 是否在群回复白名单里（与适配器配置同步，方便她判断"我在这群能不能说话"）
    reply_enabled INTEGER NOT NULL DEFAULT 0,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (adapter_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS social_contacts (
    adapter_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT,
    remark TEXT,
    -- 与 people.person_key 对齐：QQ 号即 person_key，方便两表互查
    person_key TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (adapter_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_social_contacts_person ON social_contacts(person_key);

  CREATE TABLE IF NOT EXISTS social_group_members (
    adapter_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT,
    card TEXT,
    role TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (adapter_id, group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_social_members_group ON social_group_members(adapter_id, group_id);
  CREATE INDEX IF NOT EXISTS idx_social_members_user ON social_group_members(adapter_id, user_id);

  -- 环境事件流：notice 帧（进群/退群/戳一戳/名片变更…）。
  -- 让她知道"身边发生了什么"，而不只是"谁说了什么"。
  CREATE TABLE IF NOT EXISTS social_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    adapter_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    group_id TEXT,
    actor_id TEXT,
    target_id TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_social_events_time ON social_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_social_events_group ON social_events(adapter_id, group_id, created_at);
  -- 多模型：用户自己配的多套「服务地址 + 型号 + 密钥」，任选一套当前使用。
  -- 旧的 api_tokens 单套配置保留不动（搜索配置仍存在那里）；模型套只在聊天取配置时覆盖那三个字段。
  -- 字段约定与桌面端 config.json 完全一致：endpoint / key（2026-10-11 统一，旧列名 api_endpoint/token 由下方迁移）。
  CREATE TABLE IF NOT EXISTS model_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    "key" TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_model_profiles_uid ON model_profiles(userid);
  -- 轻量 KV：存「当前使用哪套模型」之类的运行配置（避免为单值再开一张表）
  CREATE TABLE IF NOT EXISTS settings_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── 事件流真源 ─────────────────────────────────────────────────────
// DDL 文本来自 kirari-agent，两端各自执行同一份；补列清单也由包导出，
// 未来加列只改包里一处，两端不会分叉。
// seq 用 AUTOINCREMENT：两个进程直写同一个文件，应用层各自维护 seq 必然冲突，
// SQLite 文件锁分配的 rowid 才是全局唯一且单调的因果序。
db.exec(SESSION_EVENTS_DDL);
const eventColumns = db.prepare('PRAGMA table_info(session_events)').all().map((c) => c.name);
for (const col of SESSION_EVENTS_COLUMNS) {
  if (!eventColumns.includes(col.name)) db.exec(`ALTER TABLE session_events ADD COLUMN ${col.ddl}`);
}

// ── 阶段 C：任务与定时任务表 ───────────────────────────────────────
// 与事件表同构：DDL 来自共享包，PRAGMA 补列保证老库升级不丢数据。
db.exec(TASKS_DDL);
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
for (const col of TASKS_COLUMNS) {
  if (!taskColumns.includes(col.name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col.ddl}`);
}
db.exec(SCHEDULED_JOBS_DDL);
const jobColumns = db.prepare('PRAGMA table_info(scheduled_jobs)').all().map((c) => c.name);
for (const col of SCHEDULED_JOBS_COLUMNS) {
  if (!jobColumns.includes(col.name)) db.exec(`ALTER TABLE scheduled_jobs ADD COLUMN ${col.ddl}`);
}

// ── 2026-11-20 身份排查（A2）：给定时任务补 owner_key 列 ──────────────
//
// 为什么必须落到列上，而不是塞进 payload：
//   · 到点触发时，调度器手上只有任务行（jobStore.due 返回的 rowToJob），
//     没有会话上下文、没有 ctx.counterpartId。
//   · 唯一能从行里反推归属的是 session_id，但 workspace_task 的 session_id
//     形如 `workspace:<taskId>`，里面**根本没有用户标识** ——
//     resolveOwnerFromCtx 只能返回 '_local'，于是别人的提醒推到了主人桌面。
//     这正是用户报障的路径：「朋友的任务结果跑到了我这儿」。
//
// 之前 taskRuntime / selfOps 确实往 job 对象上写了 `job.ownerKey`，
// 但 jobToRow 的白名单把它丢掉了，写进库的是「没有归属」的一条任务。
// 现在两侧都补齐：列存在 + 白名单保留。
const JOB_OWNER_DDL = "owner_key TEXT NOT NULL DEFAULT ''";
if (!jobColumns.includes('owner_key')) {
  db.exec(`ALTER TABLE scheduled_jobs ADD COLUMN ${JOB_OWNER_DDL}`);
}
// 索引：推送与按人查任务都要按 owner 过滤
db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_owner ON scheduled_jobs(owner_key, status)');

// 保留账户区间：uid 0-99999 为程序内置账户（本地部署内置账户固定 uid=1）。
// 单独部署服务端时，真实用户注册从 100000 起，绝不占用保留区间。
const BUILTIN_UID = 1;
db.prepare('INSERT OR IGNORE INTO users (uid, username, password_hash) VALUES (?, ?, ?)').run(BUILTIN_UID, '__builtin__', '');

// 迁移：旧版内置账户曾使用 uid=0。把 uid=0 的配置档案并入 uid=1（仅当 uid=1 尚无配置时），
// 并清理 uid=0 的残留用户/配置行，避免两套保留身份并存导致本地设置与聊天对不齐。
(() => {
  const src = db.prepare('SELECT token, model, api_endpoint FROM api_tokens WHERE userid = 0').get();
  const hasTarget = db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(BUILTIN_UID);
  if (src && !hasTarget) {
    db.prepare('INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint) VALUES (?, ?, ?, ?, ?, ?)')
      .run(BUILTIN_UID, src.token, '', null, src.model || 'gpt-5.4-mini', src.api_endpoint);
  }
  db.prepare('DELETE FROM api_tokens WHERE userid = 0').run();
  db.prepare('DELETE FROM users WHERE uid = 0').run();
})();

// Migrate databases created before the token password columns existed.
const tokenColumns = db.prepare('PRAGMA table_info(api_tokens)').all().map((column) => column.name);
if (!tokenColumns.includes('view_password')) db.exec("ALTER TABLE api_tokens ADD COLUMN view_password TEXT NOT NULL DEFAULT ''");
if (!tokenColumns.includes('client_id')) db.exec('ALTER TABLE api_tokens ADD COLUMN client_id TEXT');
if (!tokenColumns.includes('model')) db.exec("ALTER TABLE api_tokens ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5.4-mini'");
if (!tokenColumns.includes('api_endpoint')) db.exec('ALTER TABLE api_tokens ADD COLUMN api_endpoint TEXT');
if (!tokenColumns.includes('search_key')) db.exec('ALTER TABLE api_tokens ADD COLUMN search_key TEXT');
if (!tokenColumns.includes('search_endpoint')) db.exec('ALTER TABLE api_tokens ADD COLUMN search_endpoint TEXT');
if (!tokenColumns.includes('search_provider')) db.exec("ALTER TABLE api_tokens ADD COLUMN search_provider TEXT NOT NULL DEFAULT 'uapis'");
if (!tokenColumns.includes('location')) db.exec('ALTER TABLE api_tokens ADD COLUMN location TEXT');
if (!tokenColumns.includes('location_source')) db.exec("ALTER TABLE api_tokens ADD COLUMN location_source TEXT");

// 字段约定统一（2026-10-11）：model_profiles 的列名与桌面端 config.json 对齐 —— endpoint / key。
// 旧库迁移：SQLite 的 RENAME COLUMN（better-sqlite3 内置版本远高于 3.25，直接可用）。
// 只在「表已存在且还是旧列名」时执行；新建库上面已经是新列名，跳过。
(() => {
  const cols = db.prepare('PRAGMA table_info(model_profiles)').all().map((c) => c.name);
  if (cols.length === 0) return; // 表还不存在（首启动会走上面的 CREATE TABLE）
  if (cols.includes('api_endpoint')) db.exec('ALTER TABLE model_profiles RENAME COLUMN api_endpoint TO endpoint');
  if (cols.includes('token')) db.exec('ALTER TABLE model_profiles RENAME COLUMN token TO "key"');
})();
if (!tokenColumns.includes('location_timezone')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_timezone TEXT');
if (!tokenColumns.includes('location_asked_at')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_asked_at TEXT');
// 行政区划规范化：固化坐标与国家/省级信息，保证位置唯一且明确（避免重复 geocode 与同名歧义）
if (!tokenColumns.includes('location_raw')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_raw TEXT');
if (!tokenColumns.includes('location_name')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_name TEXT');
if (!tokenColumns.includes('location_admin1')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_admin1 TEXT');
if (!tokenColumns.includes('location_country')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_country TEXT');
if (!tokenColumns.includes('location_country_code')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_country_code TEXT');
if (!tokenColumns.includes('latitude')) db.exec('ALTER TABLE api_tokens ADD COLUMN latitude REAL');
if (!tokenColumns.includes('longitude')) db.exec('ALTER TABLE api_tokens ADD COLUMN longitude REAL');

// 老库（在 userid 加 UNIQUE 之前创建）没有唯一约束，导致 setApiToken 的
// ON CONFLICT(userid) 报 "does not match any PRIMARY KEY or UNIQUE constraint"。
// 用唯一索引补齐（与 UNIQUE 约束等价），幂等且不会破坏已有数据。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_userid_unique ON api_tokens(userid)');

// messages 表的 UI 扩展列（emotion / images_json）。老库没有这两列，
// 补上才能与桌宠版互通 —— 桌宠版写入时带情绪标签和图片，核心版读历史要原样带回。
// 幂等：已存在就跳过（SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，只能先查）。
const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!messageColumns.includes('emotion')) db.exec('ALTER TABLE messages ADD COLUMN emotion TEXT');
if (!messageColumns.includes('images_json')) db.exec('ALTER TABLE messages ADD COLUMN images_json TEXT');

// memories 表的老库补列：about_person 是「这条记忆关于谁」，与 subject 正交。
// 幂等：先查再加（SQLite 的 ADD COLUMN 没有 IF NOT EXISTS）。
const memoryColumns = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
if (memoryColumns.length && !memoryColumns.includes('about_person')) {
  db.exec('ALTER TABLE memories ADD COLUMN about_person TEXT');
}
// ── 可信度轴（2026-11-20）─────────────────────────────────────────────
// 用户提出的关键一问：「谁在说话也是一个很重要的考量，要是我随便说一个
// 别人的信息怎么办，这万一不是事实呢」。
//
// 于是「谁在说话」不再决定**能不能存**，而是决定**存成什么可信度**：
//   fact        —— 当事人自述，或拥有者亲自确认过
//   observed    —— 她自己亲眼所见（不是听说的）
//   hearsay     —— 从别人口中听来的第三方信息（「小张出轨了」）
//   rumor       —— 明确是传闻/转述别人的转述/匿名来源
//
// 这决定了她在回答时该怎么说：「小张最近不太好」vs「听说小张出轨了」——
// 后者必须带「听说」，绝不能当已知事实讲。
//
// 默认 'fact' 只为兼容老数据（老数据没有这个信息，标成已知最安全地保留原行为）。
// 新写入一律由 epistemicFor() 显式判定。
if (memoryColumns.length && !memoryColumns.includes('epistemic')) {
  db.exec("ALTER TABLE memories ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'fact'");
}
// 这条信息是谁提供的（平台账号）。用于回答「你听谁说的」，也用于
// 判断两个互相矛盾的传闻谁更可信。与 source（owner/guest）不同：那是类别，
// 这是具体的人。
if (memoryColumns.length && !memoryColumns.includes('claimed_by')) {
  db.exec('ALTER TABLE memories ADD COLUMN claimed_by TEXT');
}
// 索引放在补列之后建，新旧两种表结构都能成功。
// （不能在 DDL 模板里建：老库的 memories 表没有该列，
//   CREATE TABLE IF NOT EXISTS 对它是空操作，紧接着建索引会报 no such column 并中断初始化。）
if (memoryColumns.length) db.exec('CREATE INDEX IF NOT EXISTS idx_memories_about ON memories(about_person, deleted)');

module.exports = {
  /** 事件流适配器复用同一个连接，不在外部另开 DB。 */
  getDb: () => db,
  initSession: async (sessionId) => module.exports.getSession(sessionId),
  getSession: async (sessionId) =>
    db.prepare('SELECT role, content, emotion, images_json FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId)
      .map((m) => withUiExtras(m)),
  /**
   * 存一条消息。
   *
   * extras 是桌宠版聊天界面需要的额外信息（情绪标签、图片），存在两个可空列里。
   * 核心版自己的调用方不传 —— 控制台只展示文字，图片在当轮会话里已经有了。
   * 桌宠版传入后，核心版读历史时能原样带回（两端记录完全互通的关键）。
   */
  saveMessage: async (sessionId, role, content, extras = null) => {
    // 事件流旁路记录真源；原有 SQL 一字不动。
    // 惰性 require 是为了避开 dbStorage ↔ eventRecorder ↔ eventStore 的顶层循环：
    // 只有真正存消息时才加载记录器，那时 dbStorage 已经导出完毕。
    try {
      const { recorder, currentTurnId } = require('../session/eventRecorder');
      recorder.enqueue({
        origin: 'core',
        sessionId,
        turnId: currentTurnId(),
        type: role === 'user' ? 'user_message' : 'assistant_message',
        payload: { role, content, extras: extras || undefined },
      });
    } catch (e) {
      // 红线：事件写失败只警告，绝不冒泡到用户、绝不打断存消息。
      console.warn('[events] 记录消息事件失败（已忽略）:', e?.message || e);
    }
    // content 可能是纯文本字符串，或 [text, image_url] 多模态数组；后者序列化为 JSON 存储。
    const c = typeof content === 'string' ? content : JSON.stringify(content);
    const emotion = extras && typeof extras.emotion === 'string' && extras.emotion.trim() ? extras.emotion.trim() : null;
    const imagesJson = extras && Array.isArray(extras.images) && extras.images.length
      ? JSON.stringify(extras.images.filter((x) => typeof x === 'string' && x.trim()))
      : null;
    db.prepare('INSERT INTO messages (session_id, role, content, emotion, images_json) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, role, c, emotion, imagesJson);
    // 保留上限：早期是 10 条（只够当上下文窗口用）。现在这张表是 UI 投影缓存，
    // 10 条等于看不了历史，所以提高到 500；上下文仍由 getRecentMessages 按需取，
    // 两边不耦合 —— 存得久不等于喂给模型的多。
    const ids = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC').all(sessionId);
    if (ids.length > MAX_MESSAGES_PER_SESSION) {
      db.prepare(`DELETE FROM messages WHERE id IN (${ids.slice(MAX_MESSAGES_PER_SESSION).map((row) => row.id).join(',')})`).run();
      // 只记审计信息：这里拿到的是 messages 表的 id，与事件流 seq 不是同一个编号空间，
      // 不能拿来给投影器当 keptFromSeq 用。投影器自己按 UI_HISTORY_LIMIT 收口。
      try {
        const { recorder, currentTurnId } = require('../session/eventRecorder');
        recorder.enqueue({
          origin: 'core',
          sessionId,
          turnId: currentTurnId(),
          type: 'messages_pruned',
          payload: {
            droppedCount: ids.length - MAX_MESSAGES_PER_SESSION,
            remaining: MAX_MESSAGES_PER_SESSION,
          },
        });
        void recorder.flush();
      } catch (e) {
        console.warn('[events] 记录裁剪事件失败（已忽略）:', e?.message || e);
      }
    }
    return module.exports.getSession(sessionId);
  },
  /**
   * 全量会话历史（聊天界面用）：带 id / 时间戳 / 情绪 / 图片。
   * 与 getSession 的区别是返回形状面向 UI（桌宠版 ChatMessage、控制台消息列表），
   * 而不是面向模型上下文（只要 role + content）。
   */
  getSessionMessages: async (sessionId, limit = 200) => {
    // ⚠️ 取的是**最近** limit 条（先倒序取再翻回正序）。
    // 直接 `ORDER BY id ASC LIMIT n` 拿到的是最老的 n 条 —— 会话长过 limit 时
    // 界面上永远停在开头，新消息反而看不到。
    const n = Math.min(500, Math.max(1, limit));
    const rows = db.prepare(
      'SELECT id, session_id, role, content, emotion, images_json, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    ).all(sessionId, n).reverse();
    return rows.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: parseStoredContent(m.content),
      emotion: m.emotion || null,
      images: safeJsonArray(m.images_json),
      timestamp: toEpochMs(m.timestamp),
    }));
  },
  /** 清空指定会话（用户点了「清空聊天记录」）。两端共用同一个会话，清的是同一份。 */
  clearSession: async (sessionId) => {
    // 事件流不删自身，只记 tombstone：投影据此截断 UI 缓存，历史仍可审计。
    try {
      const { recorder, currentTurnId } = require('../session/eventRecorder');
      recorder.enqueue({
        origin: 'core',
        sessionId,
        turnId: currentTurnId(),
        type: 'session_cleared',
        payload: { reason: 'clearSession' },
      });
      void recorder.flush();
    } catch (e) {
      console.warn('[events] 记录清空事件失败（已忽略）:', e?.message || e);
    }
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    return true;
  },
  /**
   * 列出全部会话 id（最近有消息的排前面），用于「本机会话」的采纳与收口。
   *
   * ⚠️ 排序键用自增 id 而不是 timestamp：timestamp 是秒级精度，同一秒里写入的多条
   * （欢迎语+首轮问答、批量迁移等）时间完全相同，按时间排会有平局、顺序不确定 ——
   * 「采纳最近一段对话」就可能挑错。自增 id 严格单调，没有这个问题。
   */
  listSessions: async () => {
    const rows = db.prepare('SELECT session_id, MAX(id) AS mx FROM messages GROUP BY session_id ORDER BY mx DESC').all();
    return rows.map((r) => r.session_id);
  },
  /**
   * 把若干会话的消息并进目标会话（只改 session_id，消息本身与时间戳、id 全部不动，
   * 所以时间顺序天然保持）。用于修复「同一段本机对话被拆成多个会话」的历史数据。
   */
  mergeSessions: async (fromSessionIds, intoSessionId) => {
    const from = (Array.isArray(fromSessionIds) ? fromSessionIds : [])
      .filter((s) => typeof s === 'string' && s && s !== intoSessionId);
    if (!from.length) return 0;
    // 事件里 session_id 保持原值不改，靠 messages_merged 表达「归属变了」。
    try {
      const { recorder, currentTurnId } = require('../session/eventRecorder');
      recorder.enqueue({
        origin: 'core',
        sessionId: intoSessionId,
        turnId: currentTurnId(),
        type: 'messages_merged',
        payload: { fromSessionIds: from, intoSessionId },
      });
      void recorder.flush();
    } catch (e) {
      console.warn('[events] 记录合并事件失败（已忽略）:', e?.message || e);
    }
    const stmt = db.prepare('UPDATE messages SET session_id = ? WHERE session_id = ?');
    let moved = 0;
    for (const s of from) moved += stmt.run(intoSessionId, s).changes;
    return moved;
  },
  getRecentMessages: async (sessionId, limit = 5) =>
    db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit * 2)
      .reverse()
      .map((m) => ({ role: m.role, content: parseStoredContent(m.content) })),
  getApiToken: async (userid) => db.prepare('SELECT token, client_id, model, api_endpoint, search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?').get(userid),
  getModelConfig: async (userid) => db.prepare('SELECT model, api_endpoint FROM api_tokens WHERE userid = ?').get(userid) || { model: 'gpt-5.4-mini', api_endpoint: '' },
  hasApiToken: async (userid) => !!db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(userid),
  setApiToken: async (userid, token, viewPassword, clientId, model = 'gpt-5.4-mini', apiEndpoint = '', searchKey = '', searchEndpoint = '', searchProvider = 'uapis') => {
    const passwordHash = await bcrypt.hash(viewPassword, 12);
    db.prepare(`INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint, search_key, search_endpoint, search_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userid) DO UPDATE SET token=excluded.token, view_password=excluded.view_password, client_id=excluded.client_id, model=excluded.model, api_endpoint=excluded.api_endpoint, search_key=excluded.search_key, search_endpoint=excluded.search_endpoint, search_provider=excluded.search_provider`).run(userid, token, passwordHash, clientId, model, apiEndpoint, searchKey || null, searchEndpoint || null, searchProvider);
  },
  setModelConfig: async (userid, model) => {
    const result = db.prepare('UPDATE api_tokens SET model = ? WHERE userid = ?').run(model, userid);
    return result.changes > 0;
  },
  setApiEndpoint: async (userid, apiEndpoint) => {
    const result = db.prepare('UPDATE api_tokens SET api_endpoint = ? WHERE userid = ?').run(apiEndpoint, userid);
    return result.changes > 0;
  },
  verifyViewPassword: async (userid, viewPassword) => {
    const result = db.prepare('SELECT view_password FROM api_tokens WHERE userid = ?').get(userid);
    return !!result?.view_password && bcrypt.compare(viewPassword, result.view_password);
  },
  registerClient: async (clientId, userid, publicKey) => {
    const existing = db.prepare('SELECT client_id, public_key FROM api_clients WHERE userid = ?').get(userid);
    if (existing && (existing.client_id !== clientId || existing.public_key !== publicKey)) return false;
    db.prepare('INSERT INTO api_clients (client_id, userid, public_key) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET public_key=excluded.public_key, userid=excluded.userid').run(clientId, userid, publicKey);
    return true;
  },
  getClient: async (clientId) => db.prepare('SELECT client_id, userid, public_key FROM api_clients WHERE client_id = ?').get(clientId),

  // ---- 用户账号（独立部署服务端时使用，uid 从 100000 起）----
  allocateUid: async () => {
    const row = db.prepare('SELECT MAX(uid) AS m FROM users WHERE uid >= 100000').get();
    return (row?.m ?? 99999) + 1;
  },
  registerUser: async (username, password) => {
    const uid = await module.exports.allocateUid();
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      db.prepare('INSERT INTO users (uid, username, password_hash) VALUES (?, ?, ?)').run(uid, username, passwordHash);
      return uid;
    } catch {
      return null; // 用户名唯一约束冲突
    }
  },
  verifyUser: async (username, password) => {
    const row = db.prepare('SELECT uid, password_hash FROM users WHERE username = ?').get(username);
    if (!row || !row.password_hash) return null;
    const ok = await bcrypt.compare(password, row.password_hash);
    return ok ? row.uid : null;
  },

  // ---- 用户位置（按 uid 持久化；来源 user=对话中提供，ip=公网 IP 归属地兜底）----
  getUserLocation: async (userid, scope) => {
    // scope 非空 → 机器人客人账号的独立位置记忆（bot_locations 表）
    if (scope) {
      const r = db.prepare('SELECT location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at FROM bot_locations WHERE owner_uid = ? AND scope = ?').get(userid, scope);
      if (!r) return null;
      return {
        location: r.location || null,
        raw: r.location_raw || null,
        name: r.location_name || null,
        admin1: r.location_admin1 || null,
        country: r.location_country || null,
        countryCode: r.location_country_code || null,
        latitude: r.latitude != null ? Number(r.latitude) : null,
        longitude: r.longitude != null ? Number(r.longitude) : null,
        source: r.location_source || null,
        timezone: r.location_timezone || null,
        askedAt: r.location_asked_at || null,
      };
    }
    const r = db.prepare('SELECT location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at FROM api_tokens WHERE userid = ?').get(userid);
    if (!r) return null;
    return {
      location: r.location || null,
      raw: r.location_raw || null,
      name: r.location_name || null,
      admin1: r.location_admin1 || null,
      country: r.location_country || null,
      countryCode: r.location_country_code || null,
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
      source: r.location_source || null,
      timezone: r.location_timezone || null,
      askedAt: r.location_asked_at || null,
    };
  },
  setUserLocation: async (userid, patch = {}, scope) => {
    // scope 非空 → 客人账号独立位置（bot_locations），与桌面/owner 的 api_tokens 隔离
    if (scope) {
      const colMap = {
        location: 'location', raw: 'location_raw', name: 'location_name', admin1: 'location_admin1',
        country: 'location_country', countryCode: 'location_country_code',
        latitude: 'latitude', longitude: 'longitude', source: 'location_source',
        timezone: 'location_timezone', askedAt: 'location_asked_at',
      };
      const sets = [];
      const vals = [];
      for (const key of Object.keys(colMap)) {
        if (patch[key] !== undefined) {
          sets.push(`${colMap[key]} = ?`);
          const v = patch[key];
          vals.push(v != null ? (key === 'latitude' || key === 'longitude' ? Number(v) : v) : null);
        }
      }
      if (sets.length) {
        const existing = db.prepare('SELECT 1 FROM bot_locations WHERE owner_uid = ? AND scope = ?').get(userid, scope);
        if (existing) {
          db.prepare(`UPDATE bot_locations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE owner_uid = ? AND scope = ?`).run(...vals, userid, scope);
        } else {
          const cols = ['owner_uid', 'scope', ...sets.map((s) => s.split(' = ')[0])];
          const placeholders = cols.map(() => '?').join(', ');
          db.prepare(`INSERT INTO bot_locations (${cols.join(', ')}) VALUES (${placeholders})`).run(userid, scope, ...vals);
        }
      }
      return true;
    }
    const existing = db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(userid);
    if (!existing) {
      // 极少数无配置行的情况（如远程用户尚未写配置），插入最小行后再更新位置字段
      db.prepare('INSERT INTO api_tokens (userid, token, view_password, model) VALUES (?, ?, ?, ?)')
        .run(userid, '', '', 'gpt-5.4-mini');
    }
    const sets = [];
    const vals = [];
    if (patch.location !== undefined) { sets.push('location = ?'); vals.push(patch.location || null); }
    if (patch.raw !== undefined) { sets.push('location_raw = ?'); vals.push(patch.raw || null); }
    if (patch.name !== undefined) { sets.push('location_name = ?'); vals.push(patch.name || null); }
    if (patch.admin1 !== undefined) { sets.push('location_admin1 = ?'); vals.push(patch.admin1 || null); }
    if (patch.country !== undefined) { sets.push('location_country = ?'); vals.push(patch.country || null); }
    if (patch.countryCode !== undefined) { sets.push('location_country_code = ?'); vals.push(patch.countryCode || null); }
    if (patch.latitude !== undefined) { sets.push('latitude = ?'); vals.push(patch.latitude != null ? Number(patch.latitude) : null); }
    if (patch.longitude !== undefined) { sets.push('longitude = ?'); vals.push(patch.longitude != null ? Number(patch.longitude) : null); }
    if (patch.source !== undefined) { sets.push('location_source = ?'); vals.push(patch.source || null); }
    if (patch.timezone !== undefined) { sets.push('location_timezone = ?'); vals.push(patch.timezone || null); }
    if (patch.askedAt !== undefined) { sets.push('location_asked_at = ?'); vals.push(patch.askedAt || null); }
    if (sets.length) {
      vals.push(userid);
      db.prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE userid = ?`).run(...vals);
    }
    return true;
  },
  getUser: async (uid) => db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid),

  // ---- 每日简报（主动感知的"当日记忆"）----
  // 按 userid + date 去重，每天仅一份。brief_text 为 LLM 压缩后的要点文本，topics_json 为可选主题标签。
  getDailyBrief: async (userid, date) => {
    const row = db.prepare('SELECT brief_text, topics_json FROM daily_memory WHERE userid = ? AND date = ?').get(userid, date);
    if (!row) return null;
    let topics = [];
    if (row.topics_json) {
      try {
        const parsed = JSON.parse(row.topics_json);
        if (Array.isArray(parsed)) topics = parsed;
      } catch {
        topics = [];
      }
    }
    return { briefText: row.brief_text, topics };
  },
  upsertDailyBrief: async (userid, date, briefText, topics = []) => {
    if (!briefText || !briefText.trim()) return false;
    db.prepare(`INSERT INTO daily_memory (userid, date, brief_text, topics_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(userid, date) DO UPDATE SET brief_text=excluded.brief_text, topics_json=excluded.topics_json, created_at=CURRENT_TIMESTAMP`)
      .run(userid, date, briefText, JSON.stringify(topics));
    return true;
  },
  // 列出所有需要预生成简报的用户。
  // 阶段 E 修正：过去只查 api_tokens，控制台账户（模型套存在 model_profiles /
  // settings_kv，且 uid=1 靠 config.json）根本没有 token 行，于是永远漏跑。
  // 现在以 users 为主表并集 api_tokens：注册过就有资格，配置不全由生成时跳过。
  getAllUserids: async () => {
    const rows = db
      .prepare(
        `SELECT uid AS userid FROM users
         UNION
         SELECT userid FROM api_tokens WHERE token IS NOT NULL AND token != ''
         ORDER BY userid`,
      )
      .all();
    return rows.map((r) => r.userid);
  },

  // ---- 长期记忆 DAO（memories 表）----
  // 只做存取，不做「该不该记」的判断——判断在 services/memory.js。
  // 两端共库，桌宠版用同一张表（列名与语义必须保持一致）。
  addMemory: async (row = {}) => {
    const content = String(row.content || '').trim();
    if (!content) return null;
    // epistemic：这条信息有多可信（fact / observed / hearsay / rumor）。
    // 与 visibility 正交：visibility 管"能不能说出去"，epistemic 管"说的时候
    // 该不该带『听说』"。老调用点不传时落 'fact'，保持既有行为。
    const epistemic = ['fact', 'observed', 'hearsay', 'rumor'].includes(row.epistemic)
      ? row.epistemic
      : 'fact';
    const info = db
      .prepare(
        `INSERT INTO memories (subject, kind, content, visibility, origin_session, about_person, source, importance, epistemic, claimed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(row.subject || 'global'),
        String(row.kind || 'fact'),
        content.slice(0, 2000),
        ['public', 'private', 'secret'].includes(row.visibility) ? row.visibility : 'private',
        row.originSession || null,
        row.aboutPerson || null,
        String(row.source || 'owner'),
        Math.min(5, Math.max(1, Number(row.importance) || 3)),
        epistemic,
        row.claimedBy || null,
      );
    return Number(info.lastInsertRowid);
  },

  /** 按 subject 列表取记忆。includeDeleted 仅内部排查用。 */
  listMemories: async (subjects = [], opts = {}) => {
    const subs = (Array.isArray(subjects) ? subjects : [subjects]).filter(Boolean).map(String);
    if (!subs.length) return [];
    const ph = subs.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE subject IN (${ph}) ${opts.includeDeleted ? '' : 'AND deleted = 0'}
         ORDER BY importance DESC, id DESC LIMIT ?`,
      )
      .all(...subs, Math.min(500, Math.max(1, Number(opts.limit) || 120)));
    return rows.map(mapMemoryRow);
  },

  /** 按「这条记忆关于谁」取（跨 subject 池）。用于想起某个人相关的事。 */
  listMemoriesAbout: async (personKey, opts = {}) => {
    const k = String(personKey || '').trim();
    if (!k) return [];
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE about_person = ? AND deleted = 0
         ORDER BY importance DESC, id DESC LIMIT ?`,
      )
      .all(k, Math.min(500, Math.max(1, Number(opts.limit) || 120)));
    return rows.map(mapMemoryRow);
  },

  /** 去重判断：同一 subject 下是否已有等价内容（避免反复记同一件事）。 */
  findMemoryByContent: async (subject, content) => {
    const row = db
      .prepare('SELECT * FROM memories WHERE subject = ? AND deleted = 0 AND content = ? LIMIT 1')
      .get(String(subject), String(content || '').trim().slice(0, 2000));
    return row ? mapMemoryRow(row) : null;
  },

  updateMemory: async (id, patch = {}) => {
    const sets = [];
    const vals = [];
    if (patch.content !== undefined) {
      const c = String(patch.content || '').trim();
      if (!c) return false;
      sets.push('content = ?');
      vals.push(c.slice(0, 2000));
    }
    if (patch.visibility !== undefined && ['public', 'private', 'secret'].includes(patch.visibility)) {
      sets.push('visibility = ?');
      vals.push(patch.visibility);
    }
    if (patch.importance !== undefined) {
      sets.push('importance = ?');
      vals.push(Math.min(5, Math.max(1, Number(patch.importance) || 3)));
    }
    if (!sets.length) return false;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(Number(id));
    const info = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return info.changes > 0;
  },

  /** 软删除（用户说「忘掉」）。保留行以便审计与误删恢复。 */
  deleteMemory: async (id) => {
    const info = db.prepare('UPDATE memories SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Number(id));
    return info.changes > 0;
  },

  /** 批量软删除某 subject 下的记忆（清空一段关系/一个场合的记忆）。 */
  deleteMemoriesBySubject: async (subject) => {
    const info = db.prepare('UPDATE memories SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE subject = ? AND deleted = 0').run(String(subject));
    return info.changes;
  },

  /** 命中计数：检索命中后调用，让常用记忆权重上升、久不用的自然下沉。 */
  touchMemory: async (ids = []) => {
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    if (!list.length) return 0;
    const stmt = db.prepare('UPDATE memories SET hits = hits + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?');
    let n = 0;
    for (const id of list) n += stmt.run(id).changes;
    return n;
  },

  /** 记忆统计（自我认知 / 控制台展示用）。 */
  memoryStats: async () => {
    const rows = db
      .prepare('SELECT subject, COUNT(*) AS n FROM memories WHERE deleted = 0 GROUP BY subject ORDER BY n DESC LIMIT 200')
      .all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted = 0').get();
    return { total: total ? total.n : 0, bySubject: rows.map((r) => ({ subject: r.subject, count: r.n })) };
  },

  // ---- 人物档案（people 表）----
  // 每个跟她说过话的人一条记录。role 只表达管理权限，不影响记忆归属。
  upsertPerson: async (row = {}) => {
    const key = String(row.personKey || '').trim();
    if (!key) return false;
    // COALESCE 保护：新消息里没带昵称时不要把已有昵称覆盖成空
    db.prepare(
      `INSERT INTO people (person_key, role, display_name, platform, alias)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(person_key) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, people.display_name),
         platform     = COALESCE(excluded.platform, people.platform),
         role         = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE people.role END,
         last_seen_at = CURRENT_TIMESTAMP`,
    ).run(
      key,
      ['owner', 'admin', 'user'].includes(row.role) ? row.role : 'user',
      row.displayName || null,
      row.platform || null,
      row.alias || null,
    );
    return true;
  },

  getPerson: async (personKey) => {
    const r = db.prepare('SELECT * FROM people WHERE person_key = ?').get(String(personKey || ''));
    if (!r) return null;
    return {
      personKey: r.person_key,
      role: r.role,
      displayName: r.display_name,
      platform: r.platform,
      alias: r.alias,
      notes: r.notes,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    };
  },

  listPeople: async (limit = 200) =>
    db.prepare('SELECT * FROM people ORDER BY last_seen_at DESC LIMIT ?').all(Math.min(500, Math.max(1, Number(limit) || 200))).map((r) => ({
      personKey: r.person_key,
      role: r.role,
      displayName: r.display_name,
      platform: r.platform,
      alias: r.alias,
      notes: r.notes,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    })),

  setPersonRole: async (personKey, role) => {
    if (!['owner', 'admin', 'user'].includes(role)) return false;
    const info = db.prepare('UPDATE people SET role = ? WHERE person_key = ?').run(role, String(personKey || ''));
    return info.changes > 0;
  },

  setPersonNotes: async (personKey, notes) => {
    const info = db.prepare('UPDATE people SET notes = ? WHERE person_key = ?').run(String(notes || '').slice(0, 2000), String(personKey || ''));
    return info.changes > 0;
  },

  setPersonAlias: async (personKey, alias) => {
    const info = db.prepare('UPDATE people SET alias = ? WHERE person_key = ?').run(String(alias || '').slice(0, 100), String(personKey || ''));
    return info.changes > 0;
  },

  /** 谁是拥有者（用于「管理权」判定）。可能有多个，取最早看到的那个。 */
  getOwnerKey: async () => {
    const r = db.prepare("SELECT person_key FROM people WHERE role = 'owner' ORDER BY first_seen_at ASC LIMIT 1").get();
    return r ? r.person_key : null;
  },
  /**
   * 同步版（推送路径专用）。
   *
   * pushProactiveMessageToOwner 是同步函数，要被调度器在触发瞬间直接调用，
   * 而它需要知道「这台没上报联动的桌面到底是不是主人自己的」——不查这个就只能
   * 把「没上报 = 主人」当成默认，那正是所有人的提醒都进主人桌面的原因。
   * 返回 null 表示还没有 owner 记录（全新装机），调用方按 fail-closed 处理。
   */
  getOwnerKeySync: () => {
    try {
      const r = db.prepare("SELECT person_key FROM people WHERE role = 'owner' ORDER BY first_seen_at ASC LIMIT 1").get();
      return r ? String(r.person_key) : null;
    } catch {
      return null;
    }
  },

  // ---- 记忆关联（memory_links 表）----
  // 「人际关系的拓展会产生互相关联」：人—人、人—事、事—事。
  addLink: async (a, b, relation = 'related', weight = 3) => {
    const A = String(a || '').trim();
    const B = String(b || '').trim();
    if (!A || !B || A === B) return false;
    const info = db
      .prepare(
        `INSERT INTO memory_links (a, b, relation, weight) VALUES (?, ?, ?, ?)
         ON CONFLICT(a, b, relation) DO UPDATE SET weight = excluded.weight`,
      )
      .run(A, B, String(relation || 'related'), Math.min(5, Math.max(1, Number(weight) || 3)));
    return info.changes > 0;
  },

  /** 取某个节点（person::x / memory::12 等）的所有关联。双向都查。 */
  listLinks: async (node, relation = null) => {
    const n = String(node || '').trim();
    if (!n) return [];
    const sql = relation
      ? 'SELECT * FROM memory_links WHERE (a = ? OR b = ?) AND relation = ? ORDER BY weight DESC LIMIT 200'
      : 'SELECT * FROM memory_links WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT 200';
    const args = relation ? [n, n, String(relation)] : [n, n];
    return db.prepare(sql).all(...args).map((r) => ({
      id: r.id,
      a: r.a,
      b: r.b,
      relation: r.relation,
      weight: r.weight,
      /** 相对于查询节点的另一端 */
      other: r.a === n ? r.b : r.a,
    }));
  },

  removeLink: async (a, b, relation = 'related') => {
    const info = db
      .prepare('DELETE FROM memory_links WHERE a = ? AND b = ? AND relation = ?')
      .run(String(a || ''), String(b || ''), String(relation || 'related'));
    return info.changes > 0;
  },

  /**
   * 联想扩散：从一组起点节点出发，沿 memory_links 走 1-2 跳，收集相关节点。
   * 用于「A 和 B 是朋友，所以 B 的事在 A 面前也可以自然想起」这类关联记忆。
   */
  expandLinks: async (nodes = [], opts = {}) => {
    const seen = new Set((Array.isArray(nodes) ? nodes : []).map(String).filter(Boolean));
    if (!seen.size) return [];
    const depth = Math.min(2, Math.max(1, Number(opts.depth) || 1));
    const maxWeight = opts.minWeight != null ? Number(opts.minWeight) : 1;
    let frontier = [...seen];
    const found = [];
    for (let d = 0; d < depth; d += 1) {
      const next = [];
      for (const node of frontier) {
        const links = await module.exports.listLinks(node);
        for (const l of links) {
          if (l.weight < maxWeight) continue;
          if (seen.has(l.other)) continue;
          seen.add(l.other);
          next.push(l.other);
          found.push(l);
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    return found;
  },

  // ---- 社交环境（social_* 表）----
  // 用户要求：「能看到几个好友，几个群，谁加群了，谁戳一下了，群里有几个人」。
  // 这些全是协议端就知道的事实，缓存下来让她随时能查，而不是靠猜或说不知道。

  /** 整表替换某适配器的群列表（sync 时调用；不删已有 notes/reply_enabled）。 */
  upsertSocialGroups: async (adapterId, groups = []) => {
    const ad = String(adapterId || '');
    if (!ad) return 0;
    let n = 0;
    const stmt = db.prepare(
      `INSERT INTO social_groups (adapter_id, group_id, group_name, member_count, max_member_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(adapter_id, group_id) DO UPDATE SET
         group_name = COALESCE(excluded.group_name, social_groups.group_name),
         member_count = COALESCE(excluded.member_count, social_groups.member_count),
         max_member_count = COALESCE(excluded.max_member_count, social_groups.max_member_count),
         last_synced_at = CURRENT_TIMESTAMP`,
    );
    for (const g of groups) {
      const gid = String(g.groupId || g.group_id || '').trim();
      if (!gid) continue;
      n += stmt.run(ad, gid, g.groupName || g.group_name || null, toInt(g.memberCount ?? g.member_count), toInt(g.maxMemberCount ?? g.max_member_count)).changes;
    }
    return n;
  },

  listSocialGroups: async (adapterId = null) => {
    const sql = adapterId
      ? 'SELECT * FROM social_groups WHERE adapter_id = ? ORDER BY member_count DESC, group_id ASC'
      : 'SELECT * FROM social_groups ORDER BY adapter_id ASC, member_count DESC';
    const rows = adapterId ? db.prepare(sql).all(String(adapterId)) : db.prepare(sql).all();
    return rows.map(mapSocialGroupRow);
  },

  getSocialGroup: async (adapterId, groupId) => {
    const r = db.prepare('SELECT * FROM social_groups WHERE adapter_id = ? AND group_id = ?').get(String(adapterId || ''), String(groupId || ''));
    return r ? mapSocialGroupRow(r) : null;
  },

  setSocialGroupNotes: async (adapterId, groupId, notes) => {
    const info = db
      .prepare('UPDATE social_groups SET notes = ? WHERE adapter_id = ? AND group_id = ?')
      .run(String(notes || '').slice(0, 2000), String(adapterId || ''), String(groupId || ''));
    return info.changes > 0;
  },

  /** 同步适配器配置里"哪些群允许回复"，让她知道自己在这群能不能开口。 */
  syncGroupReplyFlags: async (adapterId, cfg = {}) => {
    const ad = String(adapterId || '');
    if (!ad) return 0;
    db.prepare('UPDATE social_groups SET reply_enabled = 0 WHERE adapter_id = ?').run(ad);
    const mode = String(cfg.groupReplyMode || 'off');
    if (mode === 'off') return 0;
    const filter = String(cfg.groupFilter || 'whitelist');
    let allow = [];
    if (filter === 'whitelist') allow = (cfg.groupAllowlist || []).map(String).filter(Boolean);
    else {
      const block = new Set((cfg.groupBlocklist || []).map(String).filter(Boolean));
      allow = db.prepare('SELECT group_id FROM social_groups WHERE adapter_id = ?').all(ad).map((r) => r.group_id).filter((g) => !block.has(g));
    }
    const stmt = db.prepare('UPDATE social_groups SET reply_enabled = 1 WHERE adapter_id = ? AND group_id = ?');
    let n = 0;
    for (const g of allow) n += stmt.run(ad, g).changes;
    return n;
  },

  upsertSocialContacts: async (adapterId, contacts = []) => {
    const ad = String(adapterId || '');
    if (!ad) return 0;
    let n = 0;
    const stmt = db.prepare(
      `INSERT INTO social_contacts (adapter_id, user_id, nickname, remark, person_key)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(adapter_id, user_id) DO UPDATE SET
         nickname = COALESCE(excluded.nickname, social_contacts.nickname),
         remark = COALESCE(excluded.remark, social_contacts.remark),
         person_key = COALESCE(excluded.person_key, social_contacts.person_key),
         last_synced_at = CURRENT_TIMESTAMP`,
    );
    for (const c of contacts) {
      const uid = String(c.userId || c.user_id || '').trim();
      if (!uid) continue;
      n += stmt.run(ad, uid, c.nickname || null, c.remark || null, uid).changes;
    }
    return n;
  },

  listSocialContacts: async (adapterId = null) => {
    const sql = adapterId
      ? 'SELECT * FROM social_contacts WHERE adapter_id = ? ORDER BY user_id ASC'
      : 'SELECT * FROM social_contacts ORDER BY adapter_id ASC, user_id ASC';
    const rows = adapterId ? db.prepare(sql).all(String(adapterId)) : db.prepare(sql).all();
    return rows.map(mapSocialContactRow);
  },

  /** 整组替换某群的成员表（成员变动后重新拉一遍最省事）。 */
  replaceGroupMembers: async (adapterId, groupId, members = []) => {
    const ad = String(adapterId || '');
    const gid = String(groupId || '');
    if (!ad || !gid) return 0;
    db.prepare('DELETE FROM social_group_members WHERE adapter_id = ? AND group_id = ?').run(ad, gid);
    const stmt = db.prepare(
      `INSERT INTO social_group_members (adapter_id, group_id, user_id, nickname, card, role)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(adapter_id, group_id, user_id) DO UPDATE SET
         nickname = excluded.nickname, card = excluded.card, role = excluded.role,
         last_synced_at = CURRENT_TIMESTAMP`,
    );
    let n = 0;
    for (const m of members) {
      const uid = String(m.userId || m.user_id || '').trim();
      if (!uid) continue;
      n += stmt.run(ad, gid, uid, m.nickname || null, m.card || null, m.role || null).changes;
    }
    return n;
  },

  listGroupMembers: async (adapterId, groupId, limit = 500) => {
    // 排序：群主 → 管理员 → 普通成员，同级按账号。role 是文本，
    // 直接 ORDER BY role ASC 会得到 admin/member/owner 的字母序（群主垫底），
    // 所以显式给出权重。
    const rows = db
      .prepare(
        `SELECT * FROM social_group_members WHERE adapter_id = ? AND group_id = ?
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END ASC, user_id ASC
         LIMIT ?`,
      )
      .all(String(adapterId || ''), String(groupId || ''), Math.min(2000, Math.max(1, Number(limit) || 500)));
    return rows.map(mapSocialMemberRow);
  },

  /** 某人在哪些群里（反查「他和我共同在哪个群」）。 */
  groupsOfMember: async (adapterId, userId) =>
    db
      .prepare(
        `SELECT g.* FROM social_groups g
         JOIN social_group_members m ON m.adapter_id = g.adapter_id AND m.group_id = g.group_id
         WHERE m.adapter_id = ? AND m.user_id = ?
         ORDER BY g.member_count DESC`,
      )
      .all(String(adapterId || ''), String(userId || ''))
      .map(mapSocialGroupRow),

  addSocialEvent: async (row = {}) => {
    const ad = String(row.adapterId || row.adapter_id || '');
    const type = String(row.eventType || row.event_type || '').trim();
    if (!ad || !type) return false;
    db.prepare(
      `INSERT INTO social_events (adapter_id, event_type, group_id, actor_id, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ad,
      type,
      strOrNull(row.groupId ?? row.group_id),
      strOrNull(row.actorId ?? row.actor_id),
      strOrNull(row.targetId ?? row.target_id),
      strOrNull(row.detail),
    );
    return true;
  },

  listSocialEvents: async ({ adapterId = null, groupId = null, limit = 50 } = {}) => {
    const where = [];
    const args = [];
    if (adapterId) { where.push('adapter_id = ?'); args.push(String(adapterId)); }
    if (groupId) { where.push('group_id = ?'); args.push(String(groupId)); }
    const sql = `SELECT * FROM social_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    args.push(Math.min(500, Math.max(1, Number(limit) || 50)));
    return db.prepare(sql).all(...args).map(mapSocialEventRow);
  },

  /** 整体社交概况：几个群、几个好友、多少成员、最近事件。 */
  socialOverview: async (adapterId = null) => {
    const whereAd = adapterId ? ' WHERE adapter_id = ?' : '';
    const args = adapterId ? [String(adapterId)] : [];
    const groups = db.prepare(`SELECT COUNT(*) AS n FROM social_groups${whereAd}`).get(...args).n;
    const contacts = db.prepare(`SELECT COUNT(*) AS n FROM social_contacts${whereAd}`).get(...args).n;
    const members = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM social_group_members${whereAd}`).get(...args).n;
    const people = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
    const events = db.prepare(`SELECT COUNT(*) AS n FROM social_events${whereAd}`).get(...args).n;
    return { groups, contacts, members, people, events };
  },

  /** 尝试写入一个键；返回 true=抢到（此前不存在），false=已被占用。 */
  claimSetting: (key, value = '1') => {
    const info = db.prepare('INSERT OR IGNORE INTO settings_kv (key, value) VALUES (?, ?)').run(key, value);
    return info.changes > 0;
  },
  /** 释放抢占（生成失败时回滚锁，让另一进程/下一轮还能补）。 */
  releaseSetting: (key) => {
    db.prepare('DELETE FROM settings_kv WHERE key = ?').run(key);
  },

  // ---- 阶段 C：tasks / scheduled_jobs 行级 CRUD ----
  // 对象 ↔ 行的转换放在 taskStore/jobStore 适配器里；这里只提供最小 SQL，
  // 便于两端各自实现共享包定义的 TaskStore / JobStore 契约。
  getTaskRow: (taskId) => db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) || null,
  saveTaskRow: (row) => db.prepare(`
    INSERT INTO tasks (task_id, session_id, turn_id, origin, uid, title, status, steps_json, current_step, created_at, updated_at, completed_at)
    VALUES (@task_id, @session_id, @turn_id, @origin, @uid, @title, @status, @steps_json, @current_step, @created_at, @updated_at, @completed_at)
    ON CONFLICT(task_id) DO UPDATE SET
      session_id=excluded.session_id, turn_id=excluded.turn_id, title=excluded.title,
      status=excluded.status, steps_json=excluded.steps_json, current_step=excluded.current_step,
      updated_at=excluded.updated_at, completed_at=excluded.completed_at
  `).run(row),
  activeTaskRows: (sessionId) => db.prepare(
    "SELECT * FROM tasks WHERE session_id = ? AND status IN ('pending','running') ORDER BY created_at ASC",
  ).all(sessionId),
  listTaskRows: (sessionId, limit) => db.prepare(
    'SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(sessionId, limit),
  getJobRow: (jobId) => db.prepare('SELECT * FROM scheduled_jobs WHERE job_id = ?').get(jobId) || null,
  saveJobRow: (row) => db.prepare(`
    INSERT INTO scheduled_jobs (job_id, session_id, origin, uid, kind, title, payload, due_at, recurrence, status, created_at, updated_at, last_fired_at, owner_key)
    VALUES (@job_id, @session_id, @origin, @uid, @kind, @title, @payload, @due_at, @recurrence, @status, @created_at, @updated_at, @last_fired_at, @owner_key)
    ON CONFLICT(job_id) DO UPDATE SET
      title=excluded.title, payload=excluded.payload, due_at=excluded.due_at,
      status=excluded.status, updated_at=excluded.updated_at, last_fired_at=excluded.last_fired_at,
      owner_key=excluded.owner_key
  `).run({ owner_key: '', ...row }),
  dueJobRows: (now, limit) => db.prepare(
    "SELECT * FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
  ).all(now, limit),
  listJobRows: (sessionId, limit) => db.prepare(
    'SELECT * FROM scheduled_jobs WHERE session_id = ? ORDER BY due_at DESC LIMIT ?',
  ).all(sessionId, limit),
  /** 某 uid 某 kind 的未结束任务数（用于「一个人最多挂几个定期任务」的配额判断）。 */
  countJobRowsByKind: (kind, uid) => db.prepare(
    "SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = ? AND uid = ? AND status = 'pending'",
  ).get(kind, uid).n,
  /** 某 uid 某 kind 的全部任务（含已取消，供列表展示时自行过滤）。 */
  listJobRowsByKind: (kind, uid, limit = 100) => db.prepare(
    'SELECT * FROM scheduled_jobs WHERE kind = ? AND uid = ? ORDER BY due_at ASC LIMIT ?',
  ).all(kind, uid, limit),
  /** 取消即删除：定期任务没有「历史」价值，留着只会让配额越算越大。 */
  deleteJobRow: (jobId) => db.prepare('DELETE FROM scheduled_jobs WHERE job_id = ?').run(jobId),

  // ---- 配置档案（复用 api_tokens 表，按 uid 存取）----
  // ⚠️ 字段约定：对外的形状与桌面端 config.json 一致（endpoint / key / keyMasked / hasKey /
  //    searchKey / searchEndpoint / searchProvider / searchKeyMasked / hasSearchKey，camelCase）。
  //    api_tokens 的老列名（api_endpoint / token / search_key ...）只是**存储细节**，不对外。
  getProfile: async (uid) => {
    const u = db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid);
    if (!u) return null;
    if (isFileOwned(uid)) {
      return { uid: u.uid, username: u.username, ...modelConfigFile.getProfileSnapshot() };
    }
    const t = db.prepare('SELECT token, model, api_endpoint, search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?').get(uid);
    return {
      uid: u.uid,
      username: u.username,
      model: t?.model || 'gpt-5.4-mini',
      endpoint: t?.api_endpoint || '',
      keyMasked: t?.token ? maskToken(t.token) : '',
      hasKey: !!t?.token,
      searchKeyMasked: t?.search_key ? maskToken(t.search_key) : '',
      hasSearchKey: !!t?.search_key,
      searchEndpoint: t?.search_endpoint || '',
      searchProvider: t?.search_provider || 'uapis',
    };
  },
  setProfile: async (uid, patch) => {
    if (isFileOwned(uid)) {
      modelConfigFile.setProfilePatch(patch);
      return true;
    }
    const existing = db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(uid);
    if (existing) {
      const sets = [];
      const vals = [];
      if (patch.model !== undefined) { sets.push('model = ?'); vals.push(patch.model); }
      if (patch.endpoint !== undefined) { sets.push('api_endpoint = ?'); vals.push(patch.endpoint); }
      if (patch.key !== undefined) { sets.push('token = ?'); vals.push(patch.key); }
      if (patch.searchKey !== undefined) { sets.push('search_key = ?'); vals.push(patch.searchKey || null); }
      if (patch.searchEndpoint !== undefined) { sets.push('search_endpoint = ?'); vals.push(patch.searchEndpoint || null); }
      if (patch.searchProvider !== undefined) { sets.push('search_provider = ?'); vals.push(patch.searchProvider || 'uapis'); }
      if (sets.length) {
        vals.push(uid);
        db.prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE userid = ?`).run(...vals);
      }
    } else {
      db.prepare('INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint, search_key, search_endpoint, search_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid, patch.key ?? '', '', null, patch.model ?? 'gpt-5.4-mini', patch.endpoint ?? '', patch.searchKey || null, patch.searchEndpoint || null, patch.searchProvider || 'uapis');
    }
    return true;
  },

  // ---- 多模型（config.json 文件 + SQLite 旧路径）----
  //
  // 控制台账号（BOT_MODEL_UID，默认 1）的模型/搜索配置已迁移到 **config.json 文件**
  // （src/services/modelConfigFile.js，与桌面端同构）；下面的 model_profiles /
  // settings_kv / api_tokens 路径只服务于其他 uid 的历史数据，不再加新功能。

  /** 迁移数据源：modelConfigFile 首次建文件时导出旧数据（只读，不动 DB）。 */
  exportLegacyModelData: (uid) => {
    const profiles = db
      .prepare('SELECT id, name, endpoint, model, "key" FROM model_profiles WHERE userid = ? ORDER BY id')
      .all(uid);
    const t = db
      .prepare('SELECT token, model, api_endpoint, search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?')
      .get(uid);
    const activeRow = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(`active_model:${uid}`);
    return {
      profiles,
      activeId: activeRow ? Number(activeRow.value) : null,
      legacy: t
        ? {
            model: t.model,
            endpoint: t.api_endpoint,
            key: t.token,
            searchProvider: t.search_provider,
            searchEndpoint: t.search_endpoint,
            searchKey: t.search_key,
          }
        : null,
    };
  },

  /** 搜索配置明文（聊天内核用）：控制台账号读 config.json，其他 uid 读 api_tokens。 */
  getSearchConfig: (uid) => {
    if (isFileOwned(uid)) return modelConfigFile.getSearch();
    const t = db
      .prepare('SELECT search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?')
      .get(uid);
    return {
      searchProvider: t?.search_provider || 'uapis',
      searchEndpoint: t?.search_endpoint || '',
      searchKey: t?.search_key || '',
    };
  },

  /** 懒迁移：该 uid 列表为空但 api_tokens 已有配置时，导入为第一套并设为当前。 */
  _ensureModelsMigrated: (uid) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM model_profiles WHERE userid = ?').get(uid).n;
    if (count > 0) return;
    const old = db.prepare('SELECT token, model, api_endpoint FROM api_tokens WHERE userid = ?').get(uid);
    // 密钥或地址缺一个就不迁移 —— 一套「模型套」必须三件套齐全，
    // 半配置的套还不如不建（聊天入口会明确提示去控制台配置）。
    if (!old?.token || !old.api_endpoint) return;
    const info = db
      .prepare('INSERT INTO model_profiles (userid, name, endpoint, model, "key") VALUES (?, ?, ?, ?, ?)')
      .run(uid, '默认', old.api_endpoint, old.model || 'gpt-5.4-mini', old.token);
    db.prepare("INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)").run(`active_model:${uid}`, String(info.lastInsertRowid));
    console.log(`[models] 已把原有单套配置导入模型列表（id=${info.lastInsertRowid}）`);
  },

  listModelProfiles: async (uid) => {
    // ⚠️ 返回形状统一为 { items, activeId }（文件/DB 两条路径必须一致）
    if (isFileOwned(uid)) return modelConfigFile.listModelProfiles();
    module.exports._ensureModelsMigrated(uid);
    const items = db
      .prepare('SELECT id, name, endpoint, model, "key" FROM model_profiles WHERE userid = ? ORDER BY id')
      .all(uid)
      .map((r) => ({
        id: r.id,
        name: r.name,
        model: r.model,
        endpoint: r.endpoint,
        keyMasked: maskToken(r.key),
        hasKey: !!r.key,
      }));
    return { items, activeId: module.exports.getActiveModelId(uid) };
  },

  /** 明文读取（内部用：聊天取配置、编辑回显不需要明文，编辑走「留空不改」）。 */
  getModelProfile: (uid, id) => {
    if (isFileOwned(uid)) return modelConfigFile.getModelProfile(id);
    return db.prepare('SELECT id, name, endpoint, model, "key" FROM model_profiles WHERE userid = ? AND id = ?').get(uid, id) || null;
  },

  addModelProfile: async (uid, p) => {
    if (isFileOwned(uid)) return modelConfigFile.addModelProfile(p);
    const info = db
      .prepare('INSERT INTO model_profiles (userid, name, endpoint, model, "key") VALUES (?, ?, ?, ?, ?)')
      .run(uid, p.name, p.endpoint, p.model, p.key);
    const id = Number(info.lastInsertRowid);
    // 第一套自动成为当前使用 —— 没有当前项的列表没法聊天
    if (!module.exports.getActiveModelId(uid)) {
      module.exports.setActiveModelId(uid, id);
    }
    return id;
  },

  /** 更新一套模型配置。key 传空串/undefined 表示保持原值不变。返回是否真的改了。 */
  updateModelProfile: async (uid, id, patch) => {
    if (isFileOwned(uid)) return modelConfigFile.updateModelProfile(id, patch);
    const cur = module.exports.getModelProfile(uid, id);
    if (!cur) return false;
    db.prepare('UPDATE model_profiles SET name = ?, endpoint = ?, model = ?, "key" = ? WHERE userid = ? AND id = ?').run(
      typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 40) : cur.name,
      typeof patch.endpoint === 'string' && patch.endpoint.trim() ? patch.endpoint : cur.endpoint,
      typeof patch.model === 'string' && patch.model.trim() ? patch.model.trim() : cur.model,
      typeof patch.key === 'string' && patch.key.trim() ? patch.key.trim() : cur.key,
      uid,
      id,
    );
    return true;
  },

  deleteModelProfile: async (uid, id) => {
    if (isFileOwned(uid)) return modelConfigFile.deleteModelProfile(id);
    // ⚠️ 要在**删除之前**判断它是不是当前使用的那套 —— 删完再查，
    //    getActiveModelId 的存在性检查会发现行没了而返回 null，回退分支永远走不到。
    const wasActive = module.exports.getActiveModelId(uid) === id;
    const info = db.prepare('DELETE FROM model_profiles WHERE userid = ? AND id = ?').run(uid, id);
    if (info.changes === 0) return false;
    if (wasActive) {
      // 删的是当前使用的那套 → 切到剩余的第一套（没有就清掉，聊天会得到「先去配置」的明确提示）
      const rest = db.prepare('SELECT id FROM model_profiles WHERE userid = ? ORDER BY id LIMIT 1').get(uid);
      if (rest) module.exports.setActiveModelId(uid, rest.id);
      else db.prepare('DELETE FROM settings_kv WHERE key = ?').run(`active_model:${uid}`);
    }
    return true;
  },

  getActiveModelId: (uid) => {
    if (isFileOwned(uid)) return modelConfigFile.getActiveModelId();
    const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(`active_model:${uid}`);
    if (!row) return null;
    const id = Number(row.value);
    // 当前项可能已被外部改动/删除：指不到就当没有（聊天取配置时回退 api_tokens）
    const exists = Number.isSafeInteger(id) && db.prepare('SELECT 1 FROM model_profiles WHERE userid = ? AND id = ?').get(uid, id);
    return exists ? id : null;
  },

  setActiveModelId: (uid, id) => {
    // 文件路径走 activateModelProfile：覆盖顶层生效字段 + 记 activeModelId（与桌面端「设为当前」同语义）
    if (isFileOwned(uid)) return modelConfigFile.activateModelProfile(id);
    const exists = db.prepare('SELECT 1 FROM model_profiles WHERE userid = ? AND id = ?').get(uid, id);
    if (!exists) return false;
    db.prepare('INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?, ?)').run(`active_model:${uid}`, String(id));
    return true;
  },

  /**
   * 聊天用的「当前生效模型配置」。
   * 有当前选中的模型套 → 用它；否则回退旧的 api_tokens 单套配置（懒迁移会把它导进列表）。
   * 搜索配置始终来自 api_tokens（搜索是渠道配置，不跟着模型套走）。
   */
  getActiveModelConfig: async (uid) => {
    if (isFileOwned(uid)) return modelConfigFile.getActiveModelConfig();
    module.exports._ensureModelsMigrated(uid);
    const activeId = module.exports.getActiveModelId(uid);
    if (activeId != null) {
      const p = module.exports.getModelProfile(uid, activeId);
      if (p) return { model: p.model, endpoint: p.endpoint, key: p.key, source: `model#${p.id}(${p.name})` };
    }
    // ⚠️ 必须 await：getModelConfig 是 async，漏了 await 拿到的是 Promise，
    // t.model/t.api_endpoint 全是 undefined（曾靠 aiContext 的回退意外掩盖）。
    const t = await module.exports.getModelConfig(uid);
    return { model: t.model, endpoint: t.api_endpoint, key: null, source: 'legacy' };
  },
};

function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 6) return '****';
  return `${token.slice(0, 3)}${'*'.repeat(6)}${token.slice(-4)}`;
}

// tags_json 等 JSON 字段的容错解析（解析失败回退空数组）
function safeJsonArray(s) {
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// memories 行 → 驼峰对象（与两端调用方的字段名保持一致）
function mapMemoryRow(r) {
  return {
    id: r.id,
    subject: r.subject,
    kind: r.kind,
    content: r.content,
    visibility: r.visibility,
    originSession: r.origin_session,
    aboutPerson: r.about_person || null,
    source: r.source,
    // 可信度轴：fact / observed / hearsay / rumor。
    // 老数据没有这一列的值（DDL 默认 'fact'），保持已知事实的旧行为。
    epistemic: r.epistemic || 'fact',
    // 这条信息是谁提供的（平台账号）。用来回答「你听谁说的」，
    // 也用来在两条矛盾传闻之间判断谁更可信。
    claimedBy: r.claimed_by || null,
    importance: r.importance,
    hits: r.hits,
    lastHitAt: r.last_hit_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── 社交环境行映射 ────────────────────────────────────────────────────
/** 安全转整数：NaN/空值一律给 null，避免把 undefined 写进 SQLite。 */
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 2000) : null;
}

function mapSocialGroupRow(r) {
  return {
    adapterId: r.adapter_id,
    groupId: r.group_id,
    groupName: r.group_name || null,
    memberCount: r.member_count,
    maxMemberCount: r.max_member_count,
    notes: r.notes || null,
    replyEnabled: !!r.reply_enabled,
    firstSeenAt: r.first_seen_at,
    lastSyncedAt: r.last_synced_at,
  };
}

function mapSocialContactRow(r) {
  return {
    adapterId: r.adapter_id,
    userId: r.user_id,
    nickname: r.nickname || null,
    remark: r.remark || null,
    personKey: r.person_key || null,
    firstSeenAt: r.first_seen_at,
    lastSyncedAt: r.last_synced_at,
  };
}

function mapSocialMemberRow(r) {
  return {
    adapterId: r.adapter_id,
    groupId: r.group_id,
    userId: r.user_id,
    nickname: r.nickname || null,
    card: r.card || null,
    role: r.role || null,
    lastSyncedAt: r.last_synced_at,
  };
}

function mapSocialEventRow(r) {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    eventType: r.event_type,
    groupId: r.group_id || null,
    actorId: r.actor_id || null,
    targetId: r.target_id || null,
    detail: r.detail || null,
    createdAt: r.created_at,
  };
}

module.exports.maskToken = maskToken;
module.exports.safeJsonArray = safeJsonArray;