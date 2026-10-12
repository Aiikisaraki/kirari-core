const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 数据库目录：统一走 src/dataDir.js 解析（用户拍板：核心版自动接管桌宠版数据）。
//   env PET_API_DATA_DIR  >  env KIRARI_DESKTOP_DATA_DIR  >  自动探测桌宠版 userData  >  包内 data
// 探测到桌宠版 userData 时，pet_sessions.db 就落在桌宠版目录里 —— 两个版本共用一份记录。
const { dataDir: DB_DIR } = require('../dataDir');
const DB_PATH = path.join(DB_DIR, 'pet_sessions.db');
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
 * 桌宠版与控制台现在共用这张表当聊天记录真源（用户拍板），所以这个值同时是
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

module.exports = {
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
    // content 可能是纯文本字符串，或 [text, image_url] 多模态数组；后者序列化为 JSON 存储。
    const c = typeof content === 'string' ? content : JSON.stringify(content);
    const emotion = extras && typeof extras.emotion === 'string' && extras.emotion.trim() ? extras.emotion.trim() : null;
    const imagesJson = extras && Array.isArray(extras.images) && extras.images.length
      ? JSON.stringify(extras.images.filter((x) => typeof x === 'string' && x.trim()))
      : null;
    db.prepare('INSERT INTO messages (session_id, role, content, emotion, images_json) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, role, c, emotion, imagesJson);
    // 保留上限：早期是 10 条（只够当上下文窗口用）。现在这张表同时是
    // **桌宠版与控制台的聊天记录真源**（用户拍板：聊天记录统一用数据库），
    // 10 条等于看不了历史，所以提高到 500；上下文仍由 getRecentMessages 按需取，
    // 两边不耦合 —— 存得久不等于喂给模型的多。
    const ids = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC').all(sessionId);
    if (ids.length > MAX_MESSAGES_PER_SESSION) {
      db.prepare(`DELETE FROM messages WHERE id IN (${ids.slice(MAX_MESSAGES_PER_SESSION).map((row) => row.id).join(',')})`).run();
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
  // 列出所有已配置 Token 的用户（用于定时预生成简报）
  getAllUserids: async () => {
    const rows = db.prepare("SELECT userid FROM api_tokens WHERE token IS NOT NULL AND token != ''").all();
    return rows.map((r) => r.userid);
  },

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

module.exports.maskToken = maskToken;
module.exports.safeJsonArray = safeJsonArray;
