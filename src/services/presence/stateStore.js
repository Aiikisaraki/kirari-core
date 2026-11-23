// src/services/presence/stateStore.js
// PresenceState 的落盘层（核心版，CommonJS）。与桌面端 electron/ai/presence/stateStore.ts 对称：
// settings_kv 单键 JSON，坏档自愈（解析失败重置而非抛错 —— 状态是可再生数据，
// 绝不能让一个坏 JSON 挂掉对话主流程）。
//
// 两侧读写同一张表（共库部署时核心与桌宠共享状态）：键名带 uid 隔离。

const dbStorage = require('../db/dbStorage');

const KEY = (uid) => 'presence_state:' + uid;

function createInitialState(now) {
  return {
    version: 1,
    drives: { connect: 0.45, care: 0.3, play: 0.35, learn: 0.3, share: 0.35, create: 0.25, rest: 0.3 },
    drivesAt: now,
    mood: null,
    affinity: 0.15,
    lastUserAt: now,
    lastSelfAt: now,
    lastOutreachAt: 0,
    outreachDate: localDateKey(now),
    outreachToday: 0,
    goals: [],
    observations: {},
    pending: [],
    nextFireAt: now + 20 * 60000,
    lastGoalId: '',
    recentNeeds: [],
  };
}

function localDateKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 读状态。没有/坏档/版本不认 → null。 */
function loadPresenceState(uid = 1) {
  try {
    const db = dbStorage.getDb();
    const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(KEY(uid));
    if (!row || !row.value) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || parsed.version !== 1 || typeof parsed.drives !== 'object' || !parsed.drives) {
      console.warn('[presence] 状态档版本/形状不认，按全新状态处理');
      return null;
    }
    if (!Array.isArray(parsed.recentNeeds)) parsed.recentNeeds = [];
    return parsed;
  } catch (e) {
    console.warn('[presence] 状态档解析失败（按全新状态处理）:', e?.message || e);
    return null;
  }
}

function loadOrInitPresenceState(now, uid = 1) {
  return loadPresenceState(uid) || createInitialState(now);
}

/** 写状态。失败只告警 —— 内在状态丢一轮可以接受，对话主流程不能挂。 */
function savePresenceState(state, uid = 1) {
  try {
    const db = dbStorage.getDb();
    db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY(uid), JSON.stringify(state));
  } catch (e) {
    console.warn('[presence] 状态写入失败（本轮改动丢弃）:', e?.message || e);
  }
}

module.exports = { loadPresenceState, loadOrInitPresenceState, savePresenceState, createInitialState, localDateKey };
