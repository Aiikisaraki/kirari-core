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
    view_password TEXT NOT NULL, client_id TEXT, model TEXT NOT NULL DEFAULT 'gpt-5.4-mini', api_endpoint TEXT, search_key TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
  CREATE TABLE IF NOT EXISTS bot_locations (
    owner_uid INTEGER NOT NULL,
    scope TEXT NOT NULL,
    location TEXT, location_raw TEXT, location_name TEXT, location_admin1 TEXT,
    location_country TEXT, location_country_code TEXT,
    latitude REAL, longitude REAL, location_source TEXT,
    location_timezone TEXT, location_asked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_uid, scope)
  );
  CREATE TABLE IF NOT EXISTS daily_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL,
    date TEXT NOT NULL,
    brief_text TEXT NOT NULL,
    topics_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userid, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_memory_user_date ON daily_memory(userid, date);
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
if (!tokenColumns.includes('search_key')) db.exec('ALTER TABLE api_tokens ADD COLUMN search_key TEXT');
if (!tokenColumns.includes('search_endpoint')) db.exec('ALTER TABLE api_tokens ADD COLUMN search_endpoint TEXT');
if (!tokenColumns.includes('search_provider')) db.exec("ALTER TABLE api_tokens ADD COLUMN search_provider TEXT NOT NULL DEFAULT 'uapis'");
if (!tokenColumns.includes('location')) db.exec('ALTER TABLE api_tokens ADD COLUMN location TEXT');
if (!tokenColumns.includes('location_source')) db.exec("ALTER TABLE api_tokens ADD COLUMN location_source TEXT");
if (!tokenColumns.includes('location_timezone')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_timezone TEXT');
if (!tokenColumns.includes('location_asked_at')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_asked_at TEXT');
// 行政区划规范化：固化坐标与国家/省级信息，保证位置唯一且明确（避免重复 geocode 与同名歧义）
if (!tokenColumns.includes('location_raw')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_raw TEXT');
if (!tokenColumns.includes('location_name')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_name TEXT');
if (!tokenColumns.includes('location_admin1')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_admin1 TEXT');
if (!tokenColumns.includes('location_country')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_country TEXT');
if (!tokenColumns.includes('location_country_code')) db.exec('ALTER TABLE api_tokens ADD COLUMN location_country_code TEXT');
if (!tokenColumns.includes('latitude')) db.exec('ALTER TABLE api_tokens ADD COLUMN latitude REAL');
if (!tokenColumns.includes('longitude')) db.exec('ALTER TABLE api_tokens ADD COLUMN longitude REAL');

// 老库（在 userid 加 UNIQUE 之前创建）没有唯一约束，导致 setApiToken 的
// ON CONFLICT(userid) 报 "does not match any PRIMARY KEY or UNIQUE constraint"。
// 用唯一索引补齐（与 UNIQUE 约束等价），幂等且不会破坏已有数据。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_userid_unique ON api_tokens(userid)');

module.exports = {
  initSession: async (sessionId) => module.exports.getSession(sessionId),
  getSession: async (sessionId) => db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC').all(sessionId),
  saveMessage: async (sessionId, role, content) => {
    // content 可能是纯文本字符串，或 [text, image_url] 多模态数组；后者序列化为 JSON 存储。
    const c = typeof content === 'string' ? content : JSON.stringify(content);
    db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, c);
    const ids = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC').all(sessionId);
    if (ids.length > 10) db.prepare(`DELETE FROM messages WHERE id IN (${ids.slice(10).map((row) => row.id).join(',')})`).run();
    return module.exports.getSession(sessionId);
  },
  getRecentMessages: async (sessionId, limit = 5) =>
    db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit * 2)
      .reverse()
      .map((m) => {
        let content = m.content;
        if (typeof content === 'string') {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) content = parsed;
          } catch {
            // 非 JSON → 纯文本，保持原样
          }
        }
        return { role: m.role, content };
      }),
  getApiToken: async (userid) => db.prepare('SELECT token, client_id, model, api_endpoint, search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?').get(userid),
  getModelConfig: async (userid) => db.prepare('SELECT model, api_endpoint FROM api_tokens WHERE userid = ?').get(userid) || { model: 'gpt-5.4-mini', api_endpoint: defaultApiEndpoint },
  hasApiToken: async (userid) => !!db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(userid),
  setApiToken: async (userid, token, viewPassword, clientId, model = 'gpt-5.4-mini', apiEndpoint = defaultApiEndpoint, searchKey = '', searchEndpoint = '', searchProvider = 'uapis') => {
    const passwordHash = await bcrypt.hash(viewPassword, 12);
    db.prepare(`INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint, search_key, search_endpoint, search_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(userid) DO UPDATE SET token=excluded.token, view_password=excluded.view_password, client_id=excluded.client_id, model=excluded.model, api_endpoint=excluded.api_endpoint, search_key=excluded.search_key, search_endpoint=excluded.search_endpoint, search_provider=excluded.search_provider`).run(userid, token, passwordHash, clientId, model, apiEndpoint, searchKey || null, searchEndpoint || null, searchProvider);
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

  // ---- 用户位置（按 uid 持久化；来源 user=对话中提供，ip=公网 IP 归属地兜底）----
  getUserLocation: async (userid, scope) => {
    // scope 非空 → 机器人客人账号的独立位置记忆（bot_locations 表）
    if (scope) {
      const r = db.prepare('SELECT location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at FROM bot_locations WHERE owner_uid = ? AND scope = ?').get(userid, scope);
      if (!r) return null;
      return {
        location: r.location || null,
        raw: r.location_raw || null,
        name: r.location_name || null,
        admin1: r.location_admin1 || null,
        country: r.location_country || null,
        countryCode: r.location_country_code || null,
        latitude: r.latitude != null ? Number(r.latitude) : null,
        longitude: r.longitude != null ? Number(r.longitude) : null,
        source: r.location_source || null,
        timezone: r.location_timezone || null,
        askedAt: r.location_asked_at || null,
      };
    }
    const r = db.prepare('SELECT location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at FROM api_tokens WHERE userid = ?').get(userid);
    if (!r) return null;
    return {
      location: r.location || null,
      raw: r.location_raw || null,
      name: r.location_name || null,
      admin1: r.location_admin1 || null,
      country: r.location_country || null,
      countryCode: r.location_country_code || null,
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
      source: r.location_source || null,
      timezone: r.location_timezone || null,
      askedAt: r.location_asked_at || null,
    };
  },
  setUserLocation: async (userid, patch = {}, scope) => {
    // scope 非空 → 客人账号独立位置（bot_locations），与桌面/owner 的 api_tokens 隔离
    if (scope) {
      const colMap = {
        location: 'location', raw: 'location_raw', name: 'location_name', admin1: 'location_admin1',
        country: 'location_country', countryCode: 'location_country_code',
        latitude: 'latitude', longitude: 'longitude', source: 'location_source',
        timezone: 'location_timezone', askedAt: 'location_asked_at',
      };
      const sets = [];
      const vals = [];
      for (const key of Object.keys(colMap)) {
        if (patch[key] !== undefined) {
          sets.push(`${colMap[key]} = ?`);
          const v = patch[key];
          vals.push(v != null ? (key === 'latitude' || key === 'longitude' ? Number(v) : v) : null);
        }
      }
      if (sets.length) {
        const existing = db.prepare('SELECT 1 FROM bot_locations WHERE owner_uid = ? AND scope = ?').get(userid, scope);
        if (existing) {
          db.prepare(`UPDATE bot_locations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE owner_uid = ? AND scope = ?`).run(...vals, userid, scope);
        } else {
          const cols = ['owner_uid', 'scope', ...sets.map((s) => s.split(' = ')[0])];
          const placeholders = cols.map(() => '?').join(', ');
          db.prepare(`INSERT INTO bot_locations (${cols.join(', ')}) VALUES (${placeholders})`).run(userid, scope, ...vals);
        }
      }
      return true;
    }
    const existing = db.prepare('SELECT 1 FROM api_tokens WHERE userid = ?').get(userid);
    if (!existing) {
      // 极少数无配置行的情况（如远程用户尚未写配置），插入最小行后再更新位置字段
      db.prepare('INSERT INTO api_tokens (userid, token, view_password, model) VALUES (?, ?, ?, ?)')
        .run(userid, '', '', 'gpt-5.4-mini');
    }
    const sets = [];
    const vals = [];
    if (patch.location !== undefined) { sets.push('location = ?'); vals.push(patch.location || null); }
    if (patch.raw !== undefined) { sets.push('location_raw = ?'); vals.push(patch.raw || null); }
    if (patch.name !== undefined) { sets.push('location_name = ?'); vals.push(patch.name || null); }
    if (patch.admin1 !== undefined) { sets.push('location_admin1 = ?'); vals.push(patch.admin1 || null); }
    if (patch.country !== undefined) { sets.push('location_country = ?'); vals.push(patch.country || null); }
    if (patch.countryCode !== undefined) { sets.push('location_country_code = ?'); vals.push(patch.countryCode || null); }
    if (patch.latitude !== undefined) { sets.push('latitude = ?'); vals.push(patch.latitude != null ? Number(patch.latitude) : null); }
    if (patch.longitude !== undefined) { sets.push('longitude = ?'); vals.push(patch.longitude != null ? Number(patch.longitude) : null); }
    if (patch.source !== undefined) { sets.push('location_source = ?'); vals.push(patch.source || null); }
    if (patch.timezone !== undefined) { sets.push('location_timezone = ?'); vals.push(patch.timezone || null); }
    if (patch.askedAt !== undefined) { sets.push('location_asked_at = ?'); vals.push(patch.askedAt || null); }
    if (sets.length) {
      vals.push(userid);
      db.prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE userid = ?`).run(...vals);
    }
    return true;
  },
  getUser: async (uid) => db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid),

  // ---- 每日简报（主动感知的"当日记忆"）----
  // 按 userid + date 去重，每天仅一份。brief_text 为 LLM 压缩后的要点文本，topics_json 为可选主题标签。
  getDailyBrief: async (userid, date) => {
    const row = db.prepare('SELECT brief_text, topics_json FROM daily_memory WHERE userid = ? AND date = ?').get(userid, date);
    if (!row) return null;
    let topics = [];
    if (row.topics_json) {
      try {
        const parsed = JSON.parse(row.topics_json);
        if (Array.isArray(parsed)) topics = parsed;
      } catch {
        topics = [];
      }
    }
    return { briefText: row.brief_text, topics };
  },
  upsertDailyBrief: async (userid, date, briefText, topics = []) => {
    if (!briefText || !briefText.trim()) return false;
    db.prepare(`INSERT INTO daily_memory (userid, date, brief_text, topics_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(userid, date) DO UPDATE SET brief_text=excluded.brief_text, topics_json=excluded.topics_json, created_at=CURRENT_TIMESTAMP`)
      .run(userid, date, briefText, JSON.stringify(topics));
    return true;
  },
  // 列出所有已配置 Token 的用户（用于定时预生成简报）
  getAllUserids: async () => {
    const rows = db.prepare("SELECT userid FROM api_tokens WHERE token IS NOT NULL AND token != ''").all();
    return rows.map((r) => r.userid);
  },

  // ---- 配置档案（复用 api_tokens 表，按 uid 存取）----
  getProfile: async (uid) => {
    const u = db.prepare('SELECT uid, username FROM users WHERE uid = ?').get(uid);
    if (!u) return null;
    const t = db.prepare('SELECT token, model, api_endpoint, search_key, search_endpoint, search_provider FROM api_tokens WHERE userid = ?').get(uid);
    return {
      uid: u.uid,
      username: u.username,
      model: t?.model || 'gpt-5.4-mini',
      api_endpoint: t?.api_endpoint || defaultApiEndpoint,
      token_masked: t?.token ? maskToken(t.token) : '',
      hasToken: !!t?.token,
      search_key_masked: t?.search_key ? maskToken(t.search_key) : '',
      hasSearchKey: !!t?.search_key,
      search_endpoint: t?.search_endpoint || '',
      search_provider: t?.search_provider || 'uapis',
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
      if (patch.search_key !== undefined) { sets.push('search_key = ?'); vals.push(patch.search_key || null); }
      if (patch.search_endpoint !== undefined) { sets.push('search_endpoint = ?'); vals.push(patch.search_endpoint || null); }
      if (patch.search_provider !== undefined) { sets.push('search_provider = ?'); vals.push(patch.search_provider || 'uapis'); }
      if (sets.length) {
        vals.push(uid);
        db.prepare(`UPDATE api_tokens SET ${sets.join(', ')} WHERE userid = ?`).run(...vals);
      }
    } else {
      db.prepare('INSERT INTO api_tokens (userid, token, view_password, client_id, model, api_endpoint, search_key, search_endpoint, search_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid, patch.token ?? '', '', null, patch.model ?? 'gpt-5.4-mini', patch.api_endpoint ?? defaultApiEndpoint, patch.search_key || null, patch.search_endpoint || null, patch.search_provider || 'uapis');
    }
    return true;
  },
};

function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 6) return '****';
  return `${token.slice(0, 3)}${'*'.repeat(6)}${token.slice(-4)}`;
}

// tags_json 等 JSON 字段的容错解析（解析失败回退空数组）
function safeJsonArray(s) {
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

module.exports.maskToken = maskToken;
module.exports.safeJsonArray = safeJsonArray;
