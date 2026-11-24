// src/services/biliSettings.js
// B 站互动开关：命令与设置界面唯一真相源（settings_kv 单键 JSON）。
// 命令改 → 写这里 → UI 读这里；UI 改 → 也写这里 → 命令读到新值。天然双向同步。
// 默认全关。dm（私信）即使开了也永不主动发起。
const KEY = 'bili_interaction';
// enabled = B站功能总闸（关掉后所有 B站动作全禁）；autoBrowse = 允许她闲时自主刷（默认关，需显式开）。
const DEFAULTS = { enabled: false, autoBrowse: false, comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false };

function read() {
  try {
    const row = require('../db/dbStorage').getDb().prepare('SELECT value FROM settings_kv WHERE key = ?').get(KEY);
    if (!row) return { ...DEFAULTS };
    const v = JSON.parse(row.value);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) out[k] = !!v[k];
    return out;
  } catch { return { ...DEFAULTS }; }
}

function write(next) {
  const v = {};
  for (const k of Object.keys(DEFAULTS)) v[k] = !!(next && next[k]);
  require('../db/dbStorage').getDb().prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(v));
  return v;
}

function setOne(channel, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, channel)) throw new Error('未知开关: ' + channel);
  const v = read();
  v[channel] = !!value;
  return write(v);
}

module.exports = { KEY, DEFAULTS, read, write, setOne };
