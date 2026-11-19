// src/session/memoryStorage.js
// 内存存储（STORAGE_TYPE=memory 时用）。与 dbStorage.js 保持同一套签名与上限，
// 这样 sessionManager 换成哪个后端都不必改调用方。
const sessionStore = new Map();

/** 与 dbStorage 的 MAX_MESSAGES_PER_SESSION 一致：作为 UI 投影缓存，10 条不够翻历史。 */
const MAX_MESSAGES_PER_SESSION = 500;

module.exports = {
  initSession: async (sessionId) => {
    if (!sessionStore.has(sessionId)) {
      sessionStore.set(sessionId, []);
    }
    return sessionStore.get(sessionId);
  },

  getSession: async (sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session) return null;
    // 与 dbStorage 同形状：带上 UI 扩展字段（内存里没有就补空值）
    return session.map((m) => ({
      role: m.role,
      content: m.content,
      emotion: m.emotion || null,
      images: Array.isArray(m.images) ? m.images : [],
    }));
  },

  /** extras = { emotion?, images? }，桌宠版传入；核心版自己的调用方不传。 */
  saveMessage: async (sessionId, role, content, extras = null) => {
    // 与 dbStorage 同口径：事件流旁路记录真源，原有内存逻辑一字不动。
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
      console.warn('[events] 记录消息事件失败（已忽略）:', e?.message || e);
    }
    const session = await module.exports.initSession(sessionId);
    session.push({
      role,
      content,
      emotion: extras && typeof extras.emotion === 'string' && extras.emotion.trim() ? extras.emotion.trim() : null,
      images: extras && Array.isArray(extras.images) ? extras.images.filter((x) => typeof x === 'string' && x.trim()) : [],
    });
    // 超长时从头删（与 dbStorage 的「保留最近 N 条」同语义）
    while (session.length > MAX_MESSAGES_PER_SESSION) session.shift();
    return session;
  },

  /** 全量历史（聊天界面用）：带 id / 时间戳 / 情绪 / 图片。 */
  getSessionMessages: async (sessionId, limit = 200) => {
    const session = (await module.exports.getSession(sessionId)) || [];
    return session.slice(-Math.min(500, Math.max(1, limit))).map((m, i) => ({
      id: `${sessionId}:${i}`,
      role: m.role,
      content: m.content,
      emotion: m.emotion || null,
      images: Array.isArray(m.images) ? m.images : [],
      timestamp: Date.now(),
    }));
  },

  getRecentMessages: async (sessionId, limit = 5) => {
    const session = await module.exports.getSession(sessionId);
    if (!session) return [];
    return session.slice(-limit * 2).map((m) => ({ role: m.role, content: m.content }));
  },

  /** 清空指定会话（与 dbStorage 同语义）。 */
  clearSession: async (sessionId) => {
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
    sessionStore.delete(sessionId);
    return true;
  },

  /** 列出全部会话 id。内存模式没有时间戳真源，用插入顺序充数（仅用于兜底）。 */
  listSessions: async () => Array.from(sessionStore.keys()),

  /** 把若干会话的消息并进目标会话（内存模式：按 Map 插入顺序拼接）。 */
  mergeSessions: async (fromSessionIds, intoSessionId) => {
    const from = (Array.isArray(fromSessionIds) ? fromSessionIds : []).filter(
      (s) => typeof s === 'string' && s && s !== intoSessionId,
    );
    if (!from.length) return 0;
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
    const target = sessionStore.get(intoSessionId) || [];
    let moved = 0;
    for (const s of from) {
      const rows = sessionStore.get(s) || [];
      moved += rows.length;
      target.push(...rows);
      sessionStore.delete(s);
    }
    sessionStore.set(intoSessionId, target);
    return moved;
  },

  // ── 长期记忆：转发到 dbStorage ──────────────────────────────────────
  // 记忆必须在重启、换会话之后依然存在，内存 Map 做不到（进程一退就没了）。
  // 而 memories 表在 pet_sessions.db 里、两端共库——所以即使 STORAGE_TYPE=memory
  // （开发态只把"消息"放内存），长期记忆也照常落库。此处透传，语义与 dbStorage 一致。
  ...memoryDaoForwarding(),
};

/** 惰性转发：避免 memoryStorage ↔ dbStorage 的顶层循环 require。 */
function memoryDaoForwarding() {
  const methods = [
    'addMemory',
    'listMemories',
    'listMemoriesAbout',
    'findMemoryByContent',
    'updateMemory',
    'deleteMemory',
    'deleteMemoriesBySubject',
    'touchMemory',
    'memoryStats',
    'upsertPerson',
    'getPerson',
    'listPeople',
    'setPersonRole',
    'setPersonNotes',
    'setPersonAlias',
    'getOwnerKey',
    'addLink',
    'listLinks',
    'removeLink',
    'expandLinks',
  ];
  const out = {};
  for (const m of methods) {
    out[m] = async (...args) => {
      const dao = require('./dbStorage');
      return dao[m](...args);
    };
  }
  return out;
}
