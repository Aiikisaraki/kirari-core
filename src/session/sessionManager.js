// src/session/sessionManager.js

function resolveStorageType(value = process.env.STORAGE_TYPE) {
  const storageType = String(value || 'memory').trim().toLowerCase();
  if (storageType === 'memory' || storageType === 'db') return storageType;

  console.warn(`⚠️ 未知的 STORAGE_TYPE: ${storageType}，回退到内存存储`);
  return 'memory';
}

function loadStorage(storageType) {
  return storageType === 'db'
    ? require('../db/dbStorage')
    : require('../db/memoryStorage');
}

class SessionManager {
  constructor(storageType = process.env.STORAGE_TYPE) {
    this.storageType = resolveStorageType(storageType);
    this.storage = loadStorage(this.storageType);
    console.log(`📦 会话存储模式: ${this.storageType.toUpperCase()}`);
  }

  async initSession(sessionId) {
    return await this.storage.initSession(sessionId);
  }

  async getSession(sessionId) {
    return await this.storage.getSession(sessionId);
  }

  async saveMessage(sessionId, role, content) {
    return await this.storage.saveMessage(sessionId, role, content);
  }

  async getRecentMessages(sessionId, limit = 5) {
    return await this.storage.getRecentMessages(sessionId, limit);
  }

  /** 全量会话历史（聊天界面用）：带 id / 时间戳 / 情绪 / 图片。 */
  async getSessionMessages(sessionId, limit = 200) {
    return await this.storage.getSessionMessages(sessionId, limit);
  }

  /** 清空指定会话（「清空聊天记录」）。两端共用同一个会话，清的是同一份。 */
  async clearSession(sessionId) {
    return await this.storage.clearSession(sessionId);
  }

  /** 列出全部会话 id（按最近消息倒序）。本机会话的采纳与收口用它。 */
  async listSessions() {
    return await this.storage.listSessions();
  }

  /** 把若干会话的消息并进目标会话。修复「同一段对话被拆成多个会话」的历史数据。 */
  async mergeSessions(fromSessionIds, intoSessionId) {
    return await this.storage.mergeSessions(fromSessionIds, intoSessionId);
  }
}

const sessionManager = new SessionManager();
module.exports = sessionManager;
module.exports.SessionManager = SessionManager;
module.exports.resolveStorageType = resolveStorageType;
