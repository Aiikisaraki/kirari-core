// src/session/memoryStorage.js
const sessionStore = new Map();

module.exports = {
  initSession: async (sessionId) => {
    if (!sessionStore.has(sessionId)) {
      sessionStore.set(sessionId, []);
    }
    return sessionStore.get(sessionId);
  },
  
  getSession: async (sessionId) => {
    return sessionStore.get(sessionId) || null;
  },
  
  saveMessage: async (sessionId, role, content) => {
    const session = await module.exports.initSession(sessionId);
    session.push({ role, content });
    
    // 限制会话长度（保留最近5轮对话）
    if (session.length > 10) {
      session.shift(); // 移除最早消息
      session.shift(); // 移除对应消息
    }
    
    return session;
  },
  
  getRecentMessages: async (sessionId, limit = 5) => {
    const session = await module.exports.getSession(sessionId);
    if (!session) return [];
    
    // 返回最近的limit轮对话（每轮2条消息）
    return session.slice(-limit * 2);
  }
};