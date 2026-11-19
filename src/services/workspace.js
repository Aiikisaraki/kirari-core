// src/services/workspace.js
// 工作空间：她自己的落盘目录（~/KirariWorkspace）。
//
// ── 为什么需要这一层 ────────────────────────────────────────────────
// 聊天记录在 SQLite 里，那是「对话」。但定期的自动化任务需要「留下东西」：
// 今天的简报、这周的数据、跑过的结果。没有落盘目录，任务跑完就什么都不剩，
// 她也没法第二天读回昨天的产出做对比。
//
// 工作空间是**产物**，不是对话；所以刻意跟 ~/.kirari（配置/数据库）分开，
// 放在用户目录下一个可见的位置，用户随手就能翻、能备份、能自己往里丢东西。
//
// ── 目录形态（用户 2026-11-19 定，2026-11-20 加入按人隔离）──────────
//   ~/KirariWorkspace/
//   ├── .kirari-workspace.json      空间元信息（版本 / 创建时间）
//   └── <owner>/
//       └── <任务 id>/               一个定期任务一个文件夹
//           ├── meta.json           标题 / 创建时间 / 最近运行 / 运行次数 / 保留策略
//           └── ...                 这个任务的产出（她自己写、自己读）
//
// ── 为什么按 owner 分一层（2026-11-20 用户原话）──────────────────────
//   「我今天把机器人转发给了我一个朋友，她是私聊我的机器人，建立了几个每日任务，
//     但是我怎么可以直接看到她的任务呢」
//   原先所有任务平铺在一个根下，listTasks() 无参扫描整个目录 —— 谁的都能看见。
//   这跟记忆那套「每人一个独立池」是同一个原则，工作空间也必须按人隔离。
//
//   owner 用**对话者标识**（QQ 号等），跟记忆池的 person::{key} 完全一致：
//   同一套身份解析，不另造一套，否则迟早两边对不上。
//
// ⚠️ 主人不是特权通道：主人默认也只看到自己那层。要看别人的必须显式点名，
//    由上层（capability）做二次确认，services 层不做「主人自动放开」的例外。
//
// 任务文件夹按 **id** 命名而不是标题：标题随时会改，文件夹名一改历史产出就散了。
// 标题存在 meta.json 里，人看的时候显示标题即可。
//
// ── 叶子节点（从机）不落盘 ──────────────────────────────────────────
// 从机的定时任务**照旧转发给主机执行**（模型算力在主机，凭证也在主机），
// 文件因此写在主机的 ~/KirariWorkspace 里，从机只拿结果。
// 具体转发在 services/workspaceTask.js 里，见那里的注释。
//
// ── 安全边界 ────────────────────────────────────────────────────────
// 所有路径必须落在 root 之内。任何 `..`、绝对路径、盘符、UNC 前缀一律拒绝；
// 解析完再用 path.relative 复核一次（防符号链接之外的拼接漏网）。
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 空间根目录名（用户目录下）。 */
const ROOT_DIR_NAME = 'KirariWorkspace';
/** 空间级元信息文件。 */
const SPACE_META_FILE = '.kirari-workspace.json';
/** 每个任务文件夹里的元信息。 */
const TASK_META_FILE = 'meta.json';
const SPACE_VERSION = 1;

/** 单次读写的上限：读要能塞进上下文，写要防止意外刷爆磁盘。 */
const LIMITS = Object.freeze({
    readBytes: 256 * 1024,
    writeBytes: 4 * 1024 * 1024,
    listEntries: 400,
});

/** 单个任务默认保留策略（超出由 prune 清理）。 */
const DEFAULT_RETENTION = Object.freeze({
    keepFiles: 200,
    keepDays: 30,
    keepBytes: 50 * 1024 * 1024,
});

// ───────────────────────── 路径解析 ─────────────────────────

/**
 * 空间根：env KIRARI_WORKSPACE > ~/KirariWorkspace。
 * 与 kirariHome 一样只决定「根在哪」，不创建任何东西。
 */
function resolveRoot() {
    const env = process.env.KIRARI_WORKSPACE;
    if (env && String(env).trim()) return path.resolve(String(env).trim());
    return path.join(os.homedir(), ROOT_DIR_NAME);
}

function rootDir() {
    return resolveRoot();
}

/** Windows 保留设备名，建目录会失败或行为诡异，直接拒。 */
const WIN_RESERVED = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 校验一段路径名（任务 id / 单个文件名）。
 * 允许中文（任务标题常是中文，转拼音没必要且难认），拒绝一切路径分隔与控制字符。
 */
function safeSegment(name, where = 'path') {
    const raw = String(name == null ? '' : name);
    if (!raw) throw new Error(`[${where}] 名字不能为空`);
    // 两端有空格一律拒，而不是悄悄 trim：trim 会让「写进去的名字」和「调用方以为的
    // 名字」不一致，之后按原名读回来就是 404，这种错极难查。
    if (raw !== raw.trim()) throw new Error(`[${where}] 名字两端不能有空格`);
    if (raw === '.' || raw === '..') throw new Error(`[${where}] 不允许 "${raw}"`);
    if (raw.length > 64) throw new Error(`[${where}] 名字超过 64 字符`);
    // 控制字符 + 路径分隔符 + Windows 非法字符
    if (/[\x00-\x1f\x7f/\\:*?"<>|]/.test(raw)) {
        throw new Error(`[${where}] 名字里不能有 / \\ : * ? " < > | 或控制字符`);
    }
    // Windows 会静默去掉结尾的点和空格，导致「写进去的名字」和「看到的」不一致
    if (/[. ]$/.test(raw)) throw new Error(`[${where}] 名字不能以点或空格结尾`);
    if (WIN_RESERVED.has(raw.toLowerCase())) throw new Error(`[${where}] "${raw}" 是系统保留名`);
    return raw;
}

/**
 * 把「任务内相对路径」解析成绝对路径，并保证落在该任务文件夹内。
 * 空相对路径 = 任务文件夹本身。
 */
function resolveInTask(owner, taskId, relPath = '') {
    const dir = taskDir(owner, taskId);
    const rel = String(relPath == null ? '' : relPath).trim();
    if (!rel) return dir;
    // 绝对路径 / 盘符 / UNC 一律拒绝：她不该能跳出工作空间
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
        throw new Error('[workspace] 只接受工作空间内的相对路径');
    }
    // 逐段校验，别让 "a/../../b" 混过去
    const parts = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (parts.some((s) => s === '..')) throw new Error('[workspace] 路径里不能有 ..');
    for (const seg of parts) safeSegment(seg, 'path');
    const abs = path.resolve(dir, ...parts);
    // 复核：解析结果必须仍在任务目录内（兜住大小写/软链之类的意外）
    const relBack = path.relative(dir, abs);
    if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
        throw new Error('[workspace] 路径越出了任务文件夹');
    }
    return abs;
}

/**
 * owner 目录名。owner 就是个平台账号标识（QQ 号），同样要过 safeSegment，
 * 否则一个带 `..` 的 senderId 就能越狱。
 *
 * 空 owner 一律拒 —— 不做「退化成公共目录」的兜底，那等于把隔离又抹平了。
 */
function ownerDirName(owner) {
    const raw = String(owner == null ? '' : owner).trim();
    if (!raw) throw new Error('[workspace] 缺少 owner（不知道这是谁的工作空间）');
    return safeSegment(raw, 'owner');
}

/** owner 的工作空间根。 */
function ownerRoot(owner) {
    return path.join(resolveRoot(), ownerDirName(owner));
}

/** 本机/控制台这类没有对话者的会话，工作空间归属到这个名下。 */
const LOCAL_OWNER = '_local';

/**
 * 从「此刻在跟谁说话」的上下文里解析工作空间 owner。
 *
 * 这是全项目**唯一**的 owner 解析入口：能力、提示词注入块、建任务三处都调它。
 * 各写一份的话，迟早有一处规则不同，隔离就在那个入口漏了。
 *
 * 规则（顺序不能反）：
 *   1) 显式给了 counterpartId / senderId → 就是它。调用方比我们更清楚在跟谁说话。
 *   2) 会话 id 是 `bot-...` 平台会话 → 从里面拆对话者（与记忆池同一套 memory 解析）。
 *   3) 其余（uuid 本地会话、控制台、空）→ LOCAL_OWNER。
 *
 * ⚠️ 第 3 条不能用「推不出来就当 counterpartId 用」：本地会话 id 本身会被
 * memory 当成对话者返回，那样每台桌宠都会建出一堆以会话 uuid 命名的 owner 目录。
 */
function resolveOwnerFromCtx(ctx = {}) {
    const explicit = String(ctx.counterpartId || ctx.senderId || '').trim();
    if (explicit) return ownerDirName(explicit);

    const sid = String(ctx.sessionId || '');
    if (sid.startsWith('bot-')) {
        try {
            // 惰性 require：memory 依赖 dataDir，避免顶层引用参与环
            const memory = require('./memory');
            const cp = String(memory.resolveIdentity(ctx).counterpartId || '').trim();
            if (cp && cp !== 'unknown') return ownerDirName(cp);
        } catch {
            /* 解析失败退到本机 */
        }
    }
    return ownerDirName(LOCAL_OWNER);
}

function taskDir(owner, taskId) {
    const id = safeSegment(taskId, 'taskId');
    return path.join(ownerRoot(owner), id);
}

function spaceMetaPath() {
    return path.join(resolveRoot(), SPACE_META_FILE);
}

// ───────────────────────── 空间 / 任务 ─────────────────────────

function ensureRoot() {
    const root = resolveRoot();
    fs.mkdirSync(root, { recursive: true });
    const metaFile = spaceMetaPath();
    if (!fs.existsSync(metaFile)) {
        writeJson(metaFile, {
            version: SPACE_VERSION,
            name: 'Kirari 工作空间',
            createdAt: new Date().toISOString(),
            note: '这里是她的工作空间：每个定期任务一个文件夹，保存它的产出。可以随意翻看、备份。',
        });
    }
    return root;
}

/** 读 json；坏文件/不存在统一返回 null（不抛，调用方要能降级）。 */
function readJson(file) {
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** 建任务文件夹（幂等）；已有 meta 就保留原值，只补缺字段。 */
function ensureTask(owner, taskId, opts = {}) {
    ensureRoot();
    const id = safeSegment(taskId, 'taskId');
    const dir = taskDir(owner, id);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, TASK_META_FILE);
    const existing = readJson(metaFile) || {};
    const now = new Date().toISOString();
    const meta = {
        taskId: id,
        // owner 落在 meta 里是**冗余记录**（目录层级已经表达了归属），
        // 为的是「这个文件夹被单独拷走/备份还原」时还能看出它是谁的。
        owner: ownerDirName(owner),
        // 这个任务归谁、那人是不是主人。到点无人值守执行时，模型只能靠这两项
        // 决定该怎么称呼产出对象 —— 没有它就只能按模板喊「主人」。
        ownerName: opts.ownerName || existing.ownerName || '',
        ownerRole: opts.ownerRole || existing.ownerRole || '',
        title: opts.title || existing.title || id,
        description: opts.description || existing.description || '',
        createdAt: existing.createdAt || now,
        updatedAt: now,
        lastRunAt: existing.lastRunAt || null,
        runCount: typeof existing.runCount === 'number' ? existing.runCount : 0,
        retention: { ...DEFAULT_RETENTION, ...(existing.retention || {}), ...(opts.retention || {}) },
    };
    writeJson(metaFile, meta);
    return { taskId: id, dir, meta };
}

function readTaskMeta(owner, taskId) {
    const id = safeSegment(taskId, 'taskId');
    return readJson(path.join(taskDir(owner, id), TASK_META_FILE));
}

/** 局部更新任务元信息（不存在就先建）。 */
function patchTaskMeta(owner, taskId, patch = {}) {
    const id = safeSegment(taskId, 'taskId');
    const cur = readTaskMeta(owner, id) || { taskId: id, createdAt: new Date().toISOString(), runCount: 0 };
    const next = { ...cur, ...patch, taskId: id, updatedAt: new Date().toISOString() };
    if (patch.retention) next.retention = { ...(cur.retention || DEFAULT_RETENTION), ...patch.retention };
    writeJson(path.join(taskDir(owner, id), TASK_META_FILE), next);
    return next;
}

/** 记一次运行：runCount + 1、lastRunAt 更新。 */
function recordRun(owner, taskId) {
    const cur = readTaskMeta(owner, taskId);
    const runCount = (typeof cur?.runCount === 'number' ? cur.runCount : 0) + 1;
    return patchTaskMeta(owner, taskId, { runCount, lastRunAt: new Date().toISOString() });
}

/** 列某人的所有任务文件夹（跳过空间元信息文件）。 */
function listTasks(owner) {
    const root = ownerRoot(owner);
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const id = ent.name;
        let meta = null;
        try {
            meta = readTaskMeta(owner, id);
        } catch {
            /* 文件夹名不合法就当不是我们的任务 */
            continue;
        }
        const stats = dirStats(path.join(root, id));
        out.push({
            taskId: id,
            title: meta?.title || id,
            description: meta?.description || '',
            createdAt: meta?.createdAt || null,
            lastRunAt: meta?.lastRunAt || null,
            runCount: meta?.runCount || 0,
            files: stats.files,
            bytes: stats.bytes,
        });
    }
    // 最近跑过的排前面，没跑过的按名字
    out.sort((a, b) => String(b.lastRunAt || '').localeCompare(String(a.lastRunAt || '')) || a.taskId.localeCompare(b.taskId));
    return out;
}

/**
 * 列出空间里有哪些 owner 目录（**只给管理/排查用**，不参与正常对话）。
 *
 * 刻意不叫 listOwners 摆进能力枚举里：主人要看别人的任务必须走显式确认，
 * 这个函数只是让上层有办法回答「还有别人吗、有几个」。
 */
function listOwners() {
    const root = resolveRoot();
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name === ROOT_DIR_NAME) continue;
        let tasks = [];
        try {
            tasks = listTasks(ent.name);
        } catch {
            continue;
        }
        out.push({ owner: ent.name, tasks: tasks.length });
    }
    return out;
}

/** 递归统计文件数与字节数（跳过 meta.json）。 */
function dirStats(dir) {
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
        let entries = [];
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            if (!ent.isFile()) continue;
            if (ent.name === TASK_META_FILE && path.dirname(full) === dir) continue;
            files++;
            try {
                bytes += fs.statSync(full).size;
            } catch {
                /* 统计失败忽略 */
            }
        }
    };
    walk(dir);
    return { files, bytes };
}

// ───────────────────────── 文件操作 ─────────────────────────

/** 列任务文件夹（或其中子目录）的内容。 */
function listFiles(owner, taskId, relPath = '') {
    const target = resolveInTask(owner, taskId, relPath);
    let entries = [];
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
        throw new Error(`[workspace] 读不到目录：${e?.message || e}`);
    }
    const out = entries
        .filter((ent) => !(ent.isFile() && ent.name === TASK_META_FILE && target === taskDir(owner, taskId)))
        .slice(0, LIMITS.listEntries)
        .map((ent) => {
            const full = path.join(target, ent.name);
            let size = 0;
            let mtime = null;
            try {
                const st = fs.statSync(full);
                size = st.isFile() ? st.size : 0;
                mtime = st.mtime.toISOString();
            } catch {
                /* 忽略 */
            }
            return { name: ent.name, dir: ent.isDirectory(), size, mtime };
        });
    // 目录在前，同类按名字
    out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return out;
}

function statPath(owner, taskId, relPath = '') {
    const target = resolveInTask(owner, taskId, relPath);
    let st;
    try {
        st = fs.statSync(target);
    } catch {
        return null;
    }
    return {
        path: path.relative(taskDir(owner, taskId), target) || '.',
        dir: st.isDirectory(),
        size: st.isFile() ? st.size : 0,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
    };
}

/** 读文件。超过 readBytes 直接拒（不然塞进上下文会炸）。 */
function readFile(owner, taskId, relPath) {
    if (!relPath) throw new Error('[workspace] 读文件要给出相对路径');
    const target = resolveInTask(owner, taskId, relPath);
    let st;
    try {
        st = fs.statSync(target);
    } catch {
        throw new Error(`[workspace] 文件不存在：${relPath}`);
    }
    if (st.isDirectory()) throw new Error(`[workspace] ${relPath} 是目录，用 ls 看内容`);
    if (st.size > LIMITS.readBytes) {
        throw new Error(`[workspace] 文件 ${Math.round(st.size / 1024)}KB，超过可读上限 ${LIMITS.readBytes / 1024}KB`);
    }
    return fs.readFileSync(target, 'utf-8');
}

/** 写文件（自动建父目录）。返回写入字节数。 */
function writeFile(owner, taskId, relPath, content) {
    if (!relPath) throw new Error('[workspace] 写文件要给出相对路径');
    const buf = Buffer.from(String(content == null ? '' : content), 'utf-8');
    if (buf.length > LIMITS.writeBytes) {
        throw new Error(`[workspace] 内容超过单次写入上限 ${LIMITS.writeBytes / 1024}KB`);
    }
    const target = resolveInTask(owner, taskId, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return buf.length;
}

function mkdir(owner, taskId, relPath) {
    if (!relPath) throw new Error('[workspace] 建目录要给出相对路径');
    const target = resolveInTask(owner, taskId, relPath);
    fs.mkdirSync(target, { recursive: true });
    return path.relative(taskDir(owner, taskId), target);
}

/**
 * 删文件或目录（递归）。
 * 刻意不允许删任务文件夹本身 —— 那走 removeTask，语义更清楚，也防止误删整包。
 */
function remove(owner, taskId, relPath) {
    if (!relPath) throw new Error('[workspace] 删除要给出相对路径（不能删整个任务文件夹）');
    const target = resolveInTask(owner, taskId, relPath);
    if (target === taskDir(owner, taskId)) throw new Error('[workspace] 不能删任务文件夹本身');
    let st;
    try {
        st = fs.statSync(target);
    } catch {
        return { removed: false, reason: 'not-found' };
    }
    fs.rmSync(target, { recursive: st.isDirectory(), force: true });
    return { removed: true, dir: st.isDirectory() };
}

/** 删整个任务文件夹（含 meta）。 */
function removeTask(owner, taskId) {
    const dir = taskDir(owner, taskId);
    if (!fs.existsSync(dir)) return { removed: false, reason: 'not-found' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
}

/**
 * 按保留策略清理一个任务：依次按「天数 → 文件数 → 总字节」裁掉最旧的文件。
 * meta.json 永不删。
 * @returns {{deleted:number, freedBytes:number}}
 */
function pruneTask(owner, taskId, opts = {}) {
    const id = safeSegment(taskId, 'taskId');
    const meta = readTaskMeta(owner, id) || {};
    const policy = { ...DEFAULT_RETENTION, ...(meta.retention || {}), ...opts };
    const dir = taskDir(owner, id);

    // 收集所有产出文件（含 mtime），meta.json 排除在外
    const files = [];
    const walk = (d) => {
        let entries = [];
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) {
                walk(full);
                continue;
            }
            if (!ent.isFile()) continue;
            if (ent.name === TASK_META_FILE && d === dir) continue;
            try {
                const st = fs.statSync(full);
                files.push({ full, size: st.size, mtime: st.mtimeMs });
            } catch {
                /* 忽略 */
            }
        }
    };
    walk(dir);
    files.sort((a, b) => a.mtime - b.mtime); // 最旧在前

    let deleted = 0;
    let freedBytes = 0;
    const drop = (f) => {
        try {
            fs.rmSync(f.full, { force: true });
            deleted++;
            freedBytes += f.size;
            return true;
        } catch {
            return false;
        }
    };

    // 1) 超龄
    if (policy.keepDays > 0) {
        const cutoff = Date.now() - policy.keepDays * 24 * 60 * 60 * 1000;
        for (const f of files) {
            if (f.mtime >= cutoff) continue;
            if (drop(f)) f.deleted = true;
        }
    }
    let alive = files.filter((f) => !f.deleted);
    // 2) 超量（保留最新的 keepFiles 个）
    if (policy.keepFiles > 0 && alive.length > policy.keepFiles) {
        const excess = alive.slice(0, alive.length - policy.keepFiles);
        for (const f of excess) if (drop(f)) f.deleted = true;
    }
    alive = files.filter((f) => !f.deleted);
    // 3) 超总字节（从旧往新删，直到达标）
    if (policy.keepBytes > 0) {
        let total = alive.reduce((n, f) => n + f.size, 0);
        for (const f of alive) {
            if (total <= policy.keepBytes) break;
            if (drop(f)) {
                total -= f.size;
                f.deleted = true;
            }
        }
    }
    return { deleted, freedBytes };
}

/**
 * 对某人的所有任务跑一遍清理。
 * owner 不传就清全部 owner（定时兜底清理用）；传了就只清那一个。
 */
function pruneAll(owner, opts = {}) {
    const out = [];
    const owners = owner ? [ownerDirName(owner)] : listOwners().map((o) => o.owner);
    for (const ow of owners) {
        for (const t of listTasks(ow)) {
            try {
                out.push({ owner: ow, taskId: t.taskId, ...pruneTask(ow, t.taskId, opts) });
            } catch (e) {
                out.push({ owner: ow, taskId: t.taskId, deleted: 0, freedBytes: 0, error: String(e?.message || e) });
            }
        }
    }
    return out;
}

/** 给某人看的空间概览（只统计他自己的那层）。 */
function overview(owner) {
    const root = ownerRoot(owner);
    const meta = readJson(spaceMetaPath());
    const tasks = listTasks(owner);
    return {
        root,
        owner: ownerDirName(owner),
        exists: fs.existsSync(root),
        createdAt: meta?.createdAt || null,
        tasks: tasks.length,
        files: tasks.reduce((n, t) => n + t.files, 0),
        bytes: tasks.reduce((n, t) => n + t.bytes, 0),
        list: tasks,
    };
}

module.exports = {
    ROOT_DIR_NAME,
    SPACE_META_FILE,
    TASK_META_FILE,
    LIMITS,
    DEFAULT_RETENTION,
    resolveRoot,
    rootDir,
    safeSegment,
    ownerDirName,
    ownerRoot,
    LOCAL_OWNER,
    resolveOwnerFromCtx,
    taskDir,
    resolveInTask,
    ensureRoot,
    ensureTask,
    readTaskMeta,
    patchTaskMeta,
    recordRun,
    listTasks,
    listOwners,
    listFiles,
    statPath,
    readFile,
    writeFile,
    mkdir,
    remove,
    removeTask,
    pruneTask,
    pruneAll,
    overview,
};
