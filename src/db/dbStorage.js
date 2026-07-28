const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 数据库目录：打包版由 Electron 主进程通过 PET_API_DATA_DIR 指到用户目录
// （如 %APPDATA%/akisaki-kirari/pet-api-data），实现「每台机器独立 + 可写 + 不进安装包」。
// dev 模式不设置该变量，沿用默认的 ../../data（后端项目内）。
const DB_DIR = process.env.PET_API_DATA_DIR
  ? path.resolve(process.env.PET_API_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'pet_sessions.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
const defaultApiEndpoint = process.env.MODEL_API_ENDPOINT || 'https://api.chatanywhere.tech/v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userid INTEGER NOT NULL UNIQUE, token TEXT NOT NULL,
    view_password TEXT NOT NULL, client_id TEXT, model TEXT NOT NULL DEFAULT 'gpt-5.4-mini', api_endpoint TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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

// 老库（在 userid 加 UNIQUE 之前创建）没有唯一约束，导致 setApiToken 的
// ON CONFLICT(userid) 报 "does not match any PRIMARY KEY or UNIQUE constraint"。
// 用唯一索引补齐（与 UNIQUE 约束等价），幂等且不会破坏已有数据。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_userid_unique ON api_tokens(userid)');

module.exports = {
  initSession: async (sessionId) => module.exports.getSession(sessionId),
  getSession: async (sessionId) => db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId),
  saveMessage: async (sessionId, role, content) => {
    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, content);
    const ids = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC').all(sessionId);
    if (ids.length > 10) db.prepare(`DELETE FROM messages WHERE id IN (${ids.slice(10).map((row) => row.id).join(',')})`).run();
    return module.exports.getSession(sessionId);
  },
  getRecentMessages: async (sessionId, limit = 5) => db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit * 2).reverse(),
  getApiToken: async (userid) => db.prepare('SELECT token, client_id, model, api_endpoint FROM api_tokens WHERE userid = ?').get(userid),
  getModelConfig: async (userid) => db.prepare('SELECT model, api_endpoint FROM api_tokens WHERE userid = ?').get(userid) || { model: 'gpt-5.4-mini', api_endpoint: defaultApiEndpoint },
  hasApiToken: async (userid) => !!db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(userid),
  setApiToken: async (userid, token, viewPassword, clientId, model = 'gpt-5.4-mini', apiEndpoint = defaultApiEndpoint) => {
    const passwordHash = await bcrypt.hash(viewPassword, 12);
    db.prepare(`INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(userid) DO UPDATE SET token=excluded.token, view_password=excluded.view_password, client_id=excluded.client_id, model=excluded.model, api_endpoint=excluded.api_endpoint`).run(userid, token, passwordHash, clientId, model, apiEndpoint);
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
  getUser: async (uid) => db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid),

  // ---- 配置档案（复用 api_tokens 表，按 uid 存取）----
  getProfile: async (uid) => {
    const u = db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid);
    if (!u) return null;
    const t = db.prepare('SELECT token, model, api_endpoint FROM api_tokens WHERE userid = ?').get(uid);
    return {
      uid: u.uid,
      username: u.username,
      model: t?.model || 'gpt-5.4-mini',
      api_endpoint: t?.api_endpoint || defaultApiEndpoint,
      token_masked: t?.token ? maskToken(t.token) : '',
      hasToken: !!t?.token,
    };
  },
  setProfile: async (uid, patch) => {
    const existing = db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(uid);
    if (existing) {
      const sets = [];
      const vals = [];
      if (patch.model !== undefined) { sets.push('model = ?'); vals.push(patch.model); }
      if (patch.api_endpoint !== undefined) { sets.push('api_endpoint = ?'); vals.push(patch.api_endpoint); }
      if (patch.token !== undefined) { sets.push('token = ?'); vals.push(patch.token); }
      if (sets.length) {
        vals.push(uid);
        db.prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE userid = ?`).run(...vals);
      }
    } else {
      db.prepare('INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid, patch.token ?? '', '', null, patch.model ?? 'gpt-5.4-mini', patch.api_endpoint ?? defaultApiEndpoint);
    }
    return true;
  },
};

function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 6) return '****';
  return `${token.slice(0, 3)}${'*'.repeat(6)}${token.slice(-4)}`;
}

module.exports.maskToken = maskToken;
