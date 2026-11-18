// src/kirariHome.js
// Kirari 数据根（~/.kirari）：核心版与桌宠版**共用的唯一数据真源**。
//
// ── 为什么要有这一层 ────────────────────────────────────────────────
// 历史状态：数据散在两处 —— 桌宠版按 Electron 默认把配置/库/皮肤塞在
// %APPDATA%\akisaki-kirari，核心版兜底到 <包根>/data。结果是「装过桌宠就能接管」
// 这种探测式约定，路径规则藏在三四个文件里，换机器/换部署方式就得重新猜。
//
// 现在统一成本机家目录下的一个可见目录 ~/.kirari（与 ~/.codebuddy、~/.claude
// 这类 AI agent 的数据根同一种形态）：
//   · 配置、技能、MCP、知识库、聊天库、皮肤、日志**全在一处**，可直接备份/同步；
//   · 明文可见、可手改，程序 fs.watch 后热生效；
//   · Electron 自己的 Chromium 缓存仍留在 %APPDATA%（不进 ~/.kirari），
//     数据根因此只放「有价值的东西」，不会被 Cache/GPUCache 污染。
//
// ── 目录规范（docs/home-layout.md 是给人看的同一份表）──────────────
//   ~/.kirari/
//   ├── home.json                  目录版本 + 迁移记录（程序维护）
//   ├── config.json                模型/搜索/人格/AgentProfile
//   ├── config.json                模型/搜索/人格（当前生效项 + activeModelId）
//   ├── models.json                模型清单（WorkBuddy 同构，可与它互拷）
//   ├── pet-client.config.json     桌宠本机配置（备注名/头像/适配器/窗口）
//   ├── console-appearance.json    控制台外观（仅核心版）
//   ├── knowledge/knowledge.json   私人知识库
//   ├── mcp.json                   MCP 服务（标准格式，与 Claude/codebuddy 一致）
//   ├── skills/skills.json         旧 prompt 型技能（兼容保留）
//   ├── skills/<id>/SKILL.md       渐进披露技能正文（标准 Agent Skills）
//   ├── database/pet_sessions.db   聊天记录/事件流/任务（+ -wal / -shm）
//   ├── sessions/local-session.json 本机会话 id
//   ├── network/net-state.json     组网状态
//   ├── network/net-identity.json  组网设备身份
//   ├── avatars/                   皮肤（含官方皮肤与用户自定义）
//   ├── user-avatar/               「我的头像」
//   ├── logs/                      运行日志
//   └── backups/<时间戳>/          一次性迁移前的原文件快照
//
// ── 解析优先级（从高到低，只有第一条是「换位置」）───────────────────
//   1. KIRARI_HOME                 显式指定整个数据根（测试 / 便携版 / 多开）
//   2. ~/.kirari                   默认
//   ⚠️ 旧的 PET_API_DATA_DIR / KIRARI_DESKTOP_DATA_DIR 仍然认，但语义降级为
//      「把数据根换到指定目录」，不再是「探测桌宠版 userData」。保留它们是因为
//      Docker 部署和既有脚本在用，直接删会让线上部署静默改路径。
//
// ── 迁移（只做一次，非破坏式）──────────────────────────────────────
// 首次启动若 home.json 不存在：把旧位置的已知数据**复制**进新布局，原件一律
// 留在原地不动（用户的东西不能因为我们改了目录就消失）。复制完写 home.json
// 记下「从哪来、复制了什么、跳过了什么」，之后永不再跑。
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR_NAME = '.kirari';
const HOME_META_FILE = 'home.json';
const HOME_VERSION = 1;

/** 数据根下所有路径的**唯一真源**。任何模块拼数据路径都必须走这里。 */
const LAYOUT = Object.freeze({
    /** 目录版本 + 迁移记录 */
    meta: HOME_META_FILE,
    /** 模型 / 搜索 / 人格 / AgentProfile —— 两端同一份 */
    config: 'config.json',
    /** 模型清单（WorkBuddy models.json 同构，可与其直接互拷） */
    models: 'models.json',
    /** 桌宠本机配置：备注名 / 我的头像 / 适配器 / 窗口 / 主题 / 形象 */
    clientConfig: 'pet-client.config.json',
    /** 控制台外观（仅核心版，与桌宠主题刻意分开） */
    consoleAppearance: 'console-appearance.json',
    /** 私人知识库 */
    knowledge: 'knowledge/knowledge.json',
    /**
     * MCP 外部工具服务 —— 标准 mcp.json（`{ "mcpServers": { "<名>": ... } }`）。
     * 与 Claude Code / codebuddy / WorkBuddy 同格式，配置文件可直接互拷。
     */
    mcp: 'mcp.json',
    /** 旧版 MCP 配置（{ servers: [...] }）。首次启动读入标准格式后留档，不再写。 */
    mcpLegacy: 'mcp/servers.json',
    /** 渐进披露技能根目录（内含 <id>/SKILL.md） */
    skillsRoot: 'skills',
    /** 旧 prompt 型技能（兼容保留，两端都还能读） */
    skillsJson: 'skills/skills.json',
    /** 聊天库（messages / session_events / tasks / scheduled_jobs 同库） */
    database: 'database/pet_sessions.db',
    /** 本机会话 id（两端共用一段主对话） */
    localSession: 'sessions/local-session.json',
    /** 组网状态与设备身份 */
    netState: 'network/net-state.json',
    netIdentity: 'network/net-identity.json',
    /** 皮肤目录 */
    avatars: 'avatars',
    /** 「我的头像」目录 */
    userAvatar: 'user-avatar',
    /** 运行日志 */
    logs: 'logs',
    /** 迁移前快照 */
    backups: 'backups',
});

/** 需要预先建好的目录（其余由写入方按需建）。 */
const DIR_KEYS = ['skillsRoot', 'avatars', 'userAvatar', 'logs', 'backups'];

// ─────────────────────────── 解析 ───────────────────────────

function envDir(name) {
    const raw = process.env[name];
    if (!raw || !String(raw).trim()) return null;
    return path.resolve(String(raw).trim());
}

/**
 * 解析数据根。只决定「根在哪」，不创建任何文件（创建交给 ensureLayout），
 * 这样单测里可以对任意临时目录求值。
 * 返回 { dir, source } —— source 用于启动日志里说清用了哪一份数据。
 */
function resolveHome() {
    const explicit = envDir('KIRARI_HOME');
    if (explicit) return { dir: explicit, source: 'env:KIRARI_HOME' };

    // 旧变量降级复用：语义从「探测桌宠版 userData」变成「数据根换位置」。
    const legacyCore = envDir('PET_API_DATA_DIR');
    if (legacyCore) return { dir: legacyCore, source: 'env:PET_API_DATA_DIR(legacy)' };

    const legacyDesktop = envDir('KIRARI_DESKTOP_DATA_DIR');
    if (legacyDesktop) return { dir: legacyDesktop, source: 'env:KIRARI_DESKTOP_DATA_DIR(legacy)' };

    return { dir: path.join(os.homedir(), HOME_DIR_NAME), source: 'default:~/' + HOME_DIR_NAME };
}

/** 全部数据路径（基于给定根；不传则用默认根）。 */
function pathsFor(root) {
    const dir = root || resolveHome().dir;
    const out = { home: dir };
    for (const [key, rel] of Object.entries(LAYOUT)) {
        out[key] = path.join(dir, rel);
    }
    return out;
}

/** 统一建目录。幂等。 */
function ensureLayout(root) {
    const p = pathsFor(root);
    fs.mkdirSync(p.home, { recursive: true });
    for (const key of DIR_KEYS) fs.mkdirSync(p[key], { recursive: true });
    // 下面这些目录是「写到那里才需要」，但先建好能让用户第一次打开就看到结构。
    for (const key of ['knowledge', 'database', 'localSession', 'netState']) {
        fs.mkdirSync(path.dirname(p[key]), { recursive: true });
    }
    return p;
}

// ─────────────────────────── 迁移 ───────────────────────────

/**
 * 旧位置（扁平结构）→ 新布局的对照表。
 * copy 语义：源不存在就跳过；目标已存在也跳过（绝不覆盖用户已有的数据）。
 */
const LEGACY_FILES = [
    // 配置文件：位置没变，逐个搬
    { from: 'config.json', to: LAYOUT.config },
    { from: 'pet-client.config.json', to: LAYOUT.clientConfig },
    { from: 'console-appearance.json', to: LAYOUT.consoleAppearance },
    // 新增分组
    { from: 'knowledge.json', to: LAYOUT.knowledge },
    // 旧扁平 mcp-servers.json 先原样落到 legacy 位置，由 mcpManager 转成标准 mcp.json。
    // 直接改名成 mcp.json 会失败：两者 schema 不同（数组 vs mcpServers 对象）。
    { from: 'mcp-servers.json', to: LAYOUT.mcpLegacy },
    { from: 'skills.json', to: LAYOUT.skillsJson },
    { from: 'local-session.json', to: LAYOUT.localSession },
    { from: 'net-state.json', to: LAYOUT.netState },
    { from: 'net-identity.json', to: LAYOUT.netIdentity },
    // 数据库三件套（WAL 模式下缺 -wal 会丢最后一批事务）
    { from: 'pet_sessions.db', to: LAYOUT.database },
    { from: 'pet_sessions.db-wal', to: LAYOUT.database + '-wal' },
    { from: 'pet_sessions.db-shm', to: LAYOUT.database + '-shm' },
];

/** 目录整体搬运（递归复制，已存在的文件跳过，不覆盖）。 */
const LEGACY_DIRS = [
    { from: 'skills', to: LAYOUT.skillsRoot },
    { from: 'avatars', to: LAYOUT.avatars },
    { from: 'user-avatar', to: LAYOUT.userAvatar },
    { from: 'logs', to: LAYOUT.logs },
];

/**
 * 旧版遗留物：桌宠版的 chat-session*.json 与 kirari.db 由 legacy-chat/legacy-db
 * 两个迁移器**从数据根里读**再入库，所以它们必须留在根目录（不能挪进子目录），
 * 否则那两条迁移链就断了。
 */
const LEGACY_LEFTOVERS = [
    { from: 'chat-session.json' },
    { from: 'chat-session.local.json' },
    { from: 'kirari.db' },
    // 旧版机器人适配器（core 的 migrateLegacyAdapterFile 会读它再改名留档）
    { from: 'adapter.json' },
];

/** 旧位置的候选根：桌宠版 userData（Electron 默认）+ 核心版包内 data + 桌宠 fallback。 */
function legacyRoots() {
    const home = os.homedir();
    const out = [];
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        out.push(path.join(appData, 'akisaki-kirari'));
    } else if (process.platform === 'darwin') {
        out.push(path.join(home, 'Library', 'Application Support', 'akisaki-kirari'));
    } else {
        const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        out.push(path.join(xdg, 'akisaki-kirari'));
    }
    // 桌宠版 storage.ts 的 fallbackPath()（Electron 未就绪时用）
    out.push(path.join(home, '.akisaki-kirari'));
    // 核心版旧兜底：<包根>/data
    out.push(path.resolve(__dirname, '..', 'data'));
    return out;
}

function copyFileIfAbsent(src, dest) {
    if (!fs.existsSync(src)) return 'absent';
    if (fs.existsSync(dest)) return 'exists';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 'copied';
}

function copyDirIfAbsent(srcDir, destDir, relBase) {
    const result = { copied: [], skipped: [], failed: [] };
    const walk = (rel) => {
        const src = path.join(srcDir, rel);
        const dest = path.join(destDir, rel);
        let entries = [];
        try {
            entries = fs.readdirSync(src, { withFileTypes: true });
        } catch (e) {
            result.failed.push({ path: rel || '.', error: String(e && e.message ? e.message : e) });
            return;
        }
        for (const ent of entries) {
            const childRel = rel ? path.join(rel, ent.name) : ent.name;
            if (ent.isDirectory()) {
                walk(childRel);
                continue;
            }
            if (!ent.isFile()) continue;
            const s = path.join(srcDir, childRel);
            const d = path.join(destDir, childRel);
            try {
                if (fs.existsSync(d)) {
                    result.skipped.push(path.join(relBase, childRel));
                    continue;
                }
                fs.mkdirSync(path.dirname(d), { recursive: true });
                fs.copyFileSync(s, d);
                result.copied.push(path.join(relBase, childRel));
            } catch (e) {
                result.failed.push({
                    path: path.join(relBase, childRel),
                    error: String(e && e.message ? e.message : e),
                });
            }
        }
    };
    walk('');
    return result;
}

function readMeta(root) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(root, HOME_META_FILE), 'utf-8'));
        return raw && typeof raw === 'object' ? raw : null;
    } catch {
        return null;
    }
}

function writeMeta(root, meta) {
    const file = path.join(root, HOME_META_FILE);
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf-8');
    return file;
}

/**
 * 一次性迁移：旧位置 → 新布局。**只复制，不删除、不移动。**
 *
 * 幂等判据是 home.json 里的 migration 记录，而不是「目标目录空不空」——
 * 用户后来手动删掉某个文件时不该触发第二次整体迁移。
 *
 * @returns {{ran:boolean, reason:string, from?:string, copied?:string[], skipped?:string[], failed?:object[]}}
 */
function migrateLegacy(root, opts = {}) {
    const dir = root || resolveHome().dir;
    fs.mkdirSync(dir, { recursive: true });
    const paths = ensureLayout(dir);

    const meta = readMeta(dir);
    if (meta && meta.migration && meta.migration.at) {
        return { ran: false, reason: 'already-migrated', from: meta.migration.from, copied: [], skipped: [], failed: [] };
    }

    const candidates = opts.from ? [opts.from] : legacyRoots();
    // 选第一个「看起来真有数据」的旧根；全空则只建结构，不写迁移记录以外的东西。
    const chosen = candidates.find((c) => {
        try {
            return fs.existsSync(c) && fs.statSync(c).isDirectory() && fs.readdirSync(c).length > 0;
        } catch {
            return false;
        }
    });

    const copied = [];
    const skipped = [];
    const failed = [];

    if (chosen) {
        for (const item of LEGACY_FILES) {
            const r = copyFileIfAbsent(path.join(chosen, item.from), path.join(dir, item.to));
            if (r === 'copied') copied.push(item.to);
            else if (r === 'exists') skipped.push(item.to);
        }
        for (const item of LEGACY_DIRS) {
            const srcDir = path.join(chosen, item.from);
            if (!fs.existsSync(srcDir)) continue;
            const r = copyDirIfAbsent(srcDir, path.join(dir, item.to), item.to);
            copied.push(...r.copied);
            skipped.push(...r.skipped);
            failed.push(...r.failed);
        }
        for (const item of LEGACY_LEFTOVERS) {
            const r = copyFileIfAbsent(path.join(chosen, item.from), path.join(dir, item.from));
            if (r === 'copied') copied.push(item.from);
            else if (r === 'exists') skipped.push(item.from);
        }
    }

    const nextMeta = meta && typeof meta === 'object' ? meta : {};
    nextMeta.version = HOME_VERSION;
    nextMeta.createdAt = nextMeta.createdAt || new Date().toISOString();
    nextMeta.migration = {
        at: new Date().toISOString(),
        from: chosen || null,
        copiedCount: copied.length,
        skippedCount: skipped.length,
        failed,
    };
    // 明细单独存一份，home.json 本身保持精简（它会被频繁读）。
    if (copied.length || skipped.length) {
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.mkdirSync(path.join(dir, LAYOUT.backups), { recursive: true });
            fs.writeFileSync(
                path.join(dir, LAYOUT.backups, `migration-${stamp}.json`),
                JSON.stringify({ from: chosen, copied, skipped, failed }, null, 2),
                'utf-8',
            );
        } catch {
            /* 明细写不了不影响主流程，home.json 里已有计数 */
        }
    }
    writeMeta(dir, nextMeta);

    return {
        ran: true,
        reason: chosen ? 'migrated' : 'empty-legacy',
        from: chosen || null,
        copied,
        skipped,
        failed,
    };
}

// ─────────────────────────── 对外 ───────────────────────────

const RESOLVED = resolveHome();

module.exports = {
    HOME_DIR_NAME,
    HOME_VERSION,
    LAYOUT,
    /** 数据根绝对路径 */
    homeDir: RESOLVED.dir,
    homeSource: RESOLVED.source,
    /** 全量路径对象（含 home） */
    paths: pathsFor(RESOLVED.dir),
    resolveHome,
    pathsFor,
    ensureLayout,
    migrateLegacy,
    legacyRoots,
    readMeta,
    writeMeta,
};
