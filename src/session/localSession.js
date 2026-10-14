// src/session/localSession.js
// 「本机会话」真源：这台机器上「我」和这只桌宠的**同一个对话**的会话 id。
//
// ── 为什么必须有这个东西 ──────────────────────────────────────────────
// 会话 id 是聊天记录的分区键。历史上两端各生成各的随机 id：
//   · 桌宠版每次启动 `crypto.randomUUID()`，只存在内存里 → 一重启就换了 id，
//     上一段对话变成孤儿（本机实测：13 条被丢在 f2080b55…，新会话另起了 a03cabb2…）；
//   · 核心版控制台每次开页面生成 `console-<uuid>` → 永远是空会话，
//     而且压根没去读历史。
// 结果就是「明明聊过，界面却是空的」。
//
// 修法：把「本机会话 id」落成一份**两端共用、跨重启稳定**的记录
// （dataDir/local-session.json）。两端都从这里取 id，于是：
//   · 桌宠重启 → 还是同一个会话，历史立刻回来；
//   · 控制台打开 → 和桌宠同一个会话，看到的是同一段对话；
//   · 却又是**每台机器唯一**的（不是写死常量）——组网时主机按 sessionId 取上下文，
//     两台机器写死同一个 id 会把两边的上下文搅在一起。
//
// ⚠️ 机器人会话（bot-*）永远独立，不参与收口：那是 QQ 群里多方的对话，
//    和人机私聊不是一回事。唯一例外是「主人」：botManager 把主人账号的消息
//    直接以本机会话 id 入库（不走 bot- 前缀），所以天然就在主对话里。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../dataDir');

const FILE = 'local-session.json';
/** 不参与「本机会话」收口的会话前缀（每个前缀是一类独立对话）。 */
const FOREIGN_SESSION_PREFIXES = ['bot-'];

/**
 * 存储后端不自己挑 —— 直接用 sessionManager 那一个实例，
 * 保证「谁在存聊天记录」和「谁在收口会话」永远是同一个后端（惰性 require 避免环）。
 */
function loadStorage() {
    return require('./sessionManager');
}

function filePath() {
    return path.join(dataDir, FILE);
}

function readFile() {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath(), 'utf-8'));
        const id = raw && typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
        return id && /^[a-zA-Z0-9:_-]{1,80}$/.test(id) ? id : '';
    } catch {
        return '';
    }
}

/** 仅当文件不存在时创建；已存在则沿用已有 id，避免两端同时启动各写各的。 */
function createFile(sessionId) {
    try {
        fs.writeFileSync(filePath(), JSON.stringify({ sessionId }, null, 2), { encoding: 'utf-8', flag: 'wx' });
        return sessionId;
    } catch (e) {
        if (e && e.code === 'EEXIST') {
            const existing = readFile();
            if (existing) return existing;
        }
        console.warn('[local-session] 写入失败（本次用内存里的 id，重启可能换会话）:', e?.message || e);
        return sessionId;
    }
}

/** 是不是「本机人机对话」的会话（机器人会话排除在外）。 */
function isLocalSession(sessionId) {
    return !FOREIGN_SESSION_PREFIXES.some((p) => String(sessionId).startsWith(p));
}

async function safeListSessions(storage) {
    try {
        if (typeof storage.listSessions !== 'function') return [];
        const all = await storage.listSessions();
        return Array.isArray(all) ? all : [];
    } catch (e) {
        console.warn('[local-session] 读取会话列表失败:', e?.message || e);
        return [];
    }
}

/**
 * 拿到（必要时创建/收口）本机会话 id。幂等，可以每次启动都调。
 *
 * 收口逻辑：库里凡是「本机对话」的会话都并进这一个 id。
 * 修复的正是上面说的历史数据被拆成多个会话的问题 —— 消息本身、时间戳、
 * 自增 id 全都不动，只改分区键，所以顺序和内容完全不变。
 */
async function ensureLocalSessionId({ storage = loadStorage(), quiet = false } = {}) {
    let id = readFile();
    let created = false;

    if (!id) {
        // 首次：优先采纳库里已有的最近一段本机对话（用户立刻能看到老记录），
        // 库里什么都没有才新建一个。
        const all = await safeListSessions(storage);
        id = all.filter(isLocalSession)[0] || crypto.randomUUID();
        created = true;
    }

    // 收口：其余本机会话并进来
    try {
        if (typeof storage.mergeSessions === 'function') {
            const others = (await safeListSessions(storage)).filter((s) => isLocalSession(s) && s !== id);
            if (others.length) {
                const moved = (await storage.mergeSessions(others, id)) || 0;
                if (!quiet && moved > 0) {
                    console.log(`[local-session] 已把 ${others.length} 段早期会话（共 ${moved} 条记录）并进本机会话`);
                }
            }
        }
    } catch (e) {
        console.warn('[local-session] 合并早期会话失败（不影响新消息）:', e?.message || e);
    }

    if (created) {
        const finalId = createFile(id);
        if (!quiet) console.log(`[local-session] 本机会话已确定：${finalId.slice(0, 8)}…（桌宠版与控制台共用）`);
        id = finalId;
    }
    return id;
}

module.exports = { FILE, filePath, ensureLocalSessionId, isLocalSession, FOREIGN_SESSION_PREFIXES };
