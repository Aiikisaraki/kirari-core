// src/services/activityStore.js
// 她「此刻在做什么」——轻量闲时活动状态，不是正式任务。
// 用户 2026-11-24：刷B站应该是低优先级闲时活动，可查（问「你在干嘛」能答），
// 且随时能被别的事打断——不进 job 调度、不落工作空间任务文件夹。
// 与 presence 同构：settings_kv 单键 JSON，坏档自愈。
const dbStorage = require('../db/dbStorage');

const KEY = (uid) => 'current_activity:' + uid;

/** 读当前活动。无/坏档 → null。 */
function get(uid = 1) {
  try {
    const row = dbStorage.getDb().prepare('SELECT value FROM settings_kv WHERE key = ?').get(KEY(uid));
    if (!row || !row.value) return null;
    const v = JSON.parse(row.value);
    if (!v || typeof v.name !== 'string' || !Number.isFinite(v.startedAt)) return null;
    // 过期自动消失：闲时活动是临时的，不需要显式清除
    if (Date.now() - v.startedAt > (v.ttlMs || 10 * 60000)) return null;
    return v;
  } catch { return null; }
}

/** 开始一项活动（同一时刻只有一项，新的会覆盖旧的——这就是「可被替代/打断」）。 */
function start(name, uid = 1, detail = '') {
  const v = { name: String(name || '').slice(0, 24), startedAt: Date.now(), ttlMs: 10 * 60000, detail: String(detail || '').slice(0, 80) };
  try {
    dbStorage.getDb().prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY(uid), JSON.stringify(v));
  } catch (e) { console.warn('[activity] 状态写入失败:', e?.message || e); }
  return v;
}

/** 结束当前活动（被打断/做完）。 */
function clear(uid = 1) {
  try { dbStorage.getDb().prepare('DELETE FROM settings_kv WHERE key = ?').run(KEY(uid)); } catch {}
  return { ok: true };
}

/** 给模型看的一句人话：「正在刷B站（3分钟前开始）」。 */
function describe(uid = 1, now = Date.now()) {
  const v = get(uid);
  if (!v) return null;
  const mins = Math.max(0, Math.round((now - v.startedAt) / 60000));
  return mins < 1 ? '正在' + v.name : '正在' + v.name + '（' + mins + '分钟前开始）';
}

module.exports = { get, start, clear, describe };
