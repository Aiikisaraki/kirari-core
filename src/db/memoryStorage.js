// src/session/memoryStorage.js
// 内存存储（STORAGE_TYPE=memory 时用）。与 dbStorage.js 保持同一套签名与上限，
// 这样 sessionManager 换成哪个后端都不必改调用方。
const sessionStore = new Map();

/** 与 dbStorage 的 MAX_MESSAGES_PER_SESSION 一致：聊天记录真源化之后，10 条不够翻历史。 */
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
};
