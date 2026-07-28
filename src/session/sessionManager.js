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
}

const sessionManager = new SessionManager();
module.exports = sessionManager;
module.exports.SessionManager = SessionManager;
module.exports.resolveStorageType = resolveStorageType;
