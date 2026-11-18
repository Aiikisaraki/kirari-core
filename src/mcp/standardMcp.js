// src/mcp/standardMcp.js
// 标准 MCP 配置格式 ↔ Kirari 内部结构 的唯一转换点。
//
// ── 为什么要有这一层 ────────────────────────────────────────────────
// 事实标准（Claude Code / codebuddy / WorkBuddy / Cursor 全用这个）是：
//
//   { "mcpServers": {
//       "名字": { "command": "npx", "args": ["-y", "pkg"], "env": {...} },   // stdio
//       "名字": { "url": "https://.../mcp", "headers": {...} },              // http
//   } }
//
// 而 Kirari 内部用的是带 id/transport 的对象数组（因为设置页要稳定 id、
// 两端的连接池按 id 建索引）。两边都需要，所以只在边界转换一次：
// 文件里永远是标准格式，内存里永远是内部结构。
//
// ── 转换的关键约定 ──────────────────────────────────────────────────
//   · 名字即 id：标准格式里 `mcpServers` 的键是唯一标识，直接当 id 用。
//     这样用户在一个 agent 里配的 MCP，拷到另一个 agent 里名字不变，可对得上。
//   · 缺什么补什么：标准格式没有 transport 字段 —— 有 command 就是 stdio，
//     有 url 就是 http。两者都有时以 url 为准（远程优先，与各家一致）。
//   · disabled 双向：`disabled: true`（WorkBuddy 写法）↔ `enabled: false`（内部）。
//   · 未知字段原样保留：用户可能在条目里写 `"timeout": 60` 之类各家私有键，
//     转回标准格式时必须原样带出去，否则一次保存就把人家的配置吃掉了。
const fs = require('fs');
const path = require('path');

/** 内部保留了哪些键（其余键视为「用户的未知字段」，写回时原样搬运）。 */
const INTERNAL_KEYS = ['id', 'name', 'transport', 'url', 'command', 'args', 'env', 'cwd', 'headers', 'enabled'];

/**
 * 标准条目 → 内部条目。
 * @param {string} name mcpServers 的键，作为 id/name
 * @param {object} entry 标准条目
 * @returns {object|null} 无法识别的条目返回 null（调用方跳过并计数）
 */
function entryToInternal(name, entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(name || '').trim();
    if (!id) return null;

    const hasUrl = typeof entry.url === 'string' && entry.url.trim();
    const hasCmd = typeof entry.command === 'string' && entry.command.trim();
    if (!hasUrl && !hasCmd) return null;

    const out = {
        id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
        transport: hasUrl ? 'http' : 'stdio',
        enabled: entry.disabled !== true && entry.enabled !== false,
    };
    if (hasUrl) {
        out.url = String(entry.url).trim();
        if (entry.headers && typeof entry.headers === 'object') out.headers = { ...entry.headers };
    } else {
        out.command = String(entry.command).trim();
        if (Array.isArray(entry.args)) out.args = entry.args.map((a) => String(a));
        if (entry.env && typeof entry.env === 'object') out.env = { ...entry.env };
        if (typeof entry.cwd === 'string' && entry.cwd.trim()) out.cwd = entry.cwd;
    }

    // 用户的扩展字段原样保留（内部不认识，但写回时要还给他）
    for (const k of Object.keys(entry)) {
        if (k in out || INTERNAL_KEYS.includes(k)) continue;
        if (k === 'disabled') continue; // 已转成 enabled
        out[k] = entry[k];
    }
    return out;
}

/**
 * 内部条目 → 标准条目。id 变成 mcpServers 的键，所以不写进值里。
 */
function internalToEntry(srv) {
    if (!srv || typeof srv !== 'object') return null;
    const out = {};
    if (srv.transport === 'http' && srv.url) {
        out.url = srv.url;
        if (srv.headers && typeof srv.headers === 'object' && Object.keys(srv.headers).length) {
            out.headers = { ...srv.headers };
        }
    } else if (srv.transport === 'stdio' && srv.command) {
        out.command = srv.command;
        if (Array.isArray(srv.args) && srv.args.length) out.args = [...srv.args];
        if (srv.env && typeof srv.env === 'object' && Object.keys(srv.env).length) out.env = { ...srv.env };
        if (srv.cwd) out.cwd = srv.cwd;
    } else {
        return null; // 半配置：没有 url 也没有 command
    }
    // 内部 enabled=false ↔ 标准 disabled=true（WorkBuddy 用 disabled，多数用 enabled）
    if (srv.enabled === false) out.disabled = true;
    else if (srv.disabled === true) out.disabled = true;

    // 用户的扩展字段原样带出去
    for (const k of Object.keys(srv)) {
        if (INTERNAL_KEYS.includes(k)) continue;
        out[k] = srv[k];
    }
    return out;
}

/**
 * 标准格式对象 → 内部数组。
 * @param {object} raw 文件内容（`{ mcpServers: {...} }`）
 * @returns {{ servers: object[], dropped: string[] }} dropped = 无法识别的键名
 */
function fromStandard(raw) {
    const servers = [];
    const dropped = [];
    const map = raw && typeof raw === 'object' && raw.mcpServers && typeof raw.mcpServers === 'object'
        ? raw.mcpServers
        : {};
    for (const [name, entry] of Object.entries(map)) {
        const s = entryToInternal(name, entry);
        if (s) servers.push(s);
        else dropped.push(name);
    }
    return { servers, dropped };
}

/**
 * 内部数组 → 标准格式对象（可直接写文件）。
 */
function toStandard(servers) {
    const map = {};
    for (const s of Array.isArray(servers) ? servers : []) {
        const entry = internalToEntry(s);
        if (!entry) continue;
        // 名字冲突时加序号后缀，避免静默丢一个 server
        let key = String(s.id || s.name || '').trim();
        if (!key) continue;
        if (key in map) {
            let i = 2;
            while (`${key}-${i}` in map) i++;
            key = `${key}-${i}`;
        }
        map[key] = entry;
    }
    return { mcpServers: map };
}

/**
 * 读标准 MCP 配置文件。
 * 文件不存在 → 空数组（正常：没配过）；文件坏了 → 抛错（不静默当作空，
 * 否则用户保存设置时会把坏文件整体覆盖掉，等于删配置）。
 */
function readStandardFile(file) {
    if (!fs.existsSync(file)) return { servers: [], dropped: [], missing: true };
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        throw new Error(`MCP 配置文件不是合法 JSON：${file} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const { servers, dropped } = fromStandard(raw);
    return { servers, dropped, missing: false, raw };
}

/** 写标准 MCP 配置文件（保留文件里的其他顶层键）。 */
function writeStandardFile(file, servers) {
    let existing = {};
    try {
        if (fs.existsSync(file)) {
            const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (cur && typeof cur === 'object' && !Array.isArray(cur)) existing = cur;
        }
    } catch { /* 坏文件：本次写入以新内容为准（调用方已决定要覆盖） */ }

    const next = { ...existing, ...toStandard(servers) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    return next;
}

module.exports = {
    INTERNAL_KEYS,
    entryToInternal,
    internalToEntry,
    fromStandard,
    toStandard,
    readStandardFile,
    writeStandardFile,
};
