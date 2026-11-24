// src/services/biliBiolock.js
// B站生物钟常驻调度：让 Kirari 按作息自己醒来刷 B站。
//
// 为什么在宿主侧而不是扩展 sidecar：sidecar 空闲会退出（idleTimeoutMs），撑不起常驻定时器。
// 这里只做「到点触发」——真正浏览走已验证的 bili_explore discover 链路。
const biliSettings = require('./biliSettings');

const TICK_MS = 60 * 1000;
let timer = null;
let lastTickAt = 0;
let lastWakeAt = 0;
let checking = false;

function inQuietHours(now, cfg) {
  const start = cfg.quietStart || '23:30';
  const end = cfg.quietEnd || '08:00';
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const a = toMin(start), b = toMin(end);
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  if (a === b) return false;
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

/** 按配置判断现在该不该醒：时间窗内 + 未超每日次数 + 概率通过 + 不在安静时段 */
function shouldWakeNow(now, cfg, rand = Math.random) {
  if (inQuietHours(now, cfg)) return { wake: false, reason: '安静时段' };
  const windows = Array.isArray(cfg.windows) && cfg.windows.length ? cfg.windows : [{ start: '10:00', end: '22:00', wakes: 1 }];
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const dayKey = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  for (const w of windows) {
    const toMin = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const a = toMin(w.start), b = toMin(w.end);
    const inWin = a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
    if (!inWin) continue;
    const used = (cfg.wakes && cfg.wakes[dayKey + '|' + (w.name || w.start)] || 0);
    if (used >= (Number(w.wakes) || 1)) continue;
    if (rand() < (Number(cfg.skipChance) || 0.2)) return { wake: false, reason: '这一轮跳过了' };
    return { wake: true, window: w, dayKey };
  }
  return { wake: false, reason: '不在时间窗或今日次数已用完' };
}

async function tick(now = Date.now()) {
  lastTickAt = now;
  if (checking) return;
  checking = true;
  try {
    const s = biliSettings.read();
    // 总闸 + 自主闲逛都必须开，才允许自主醒来
    if (!s.enabled || !s.autoBrowse) return;
    if (now - lastWakeAt < 30 * 60 * 1000) return; // 最小间隔
    const host = require('../extensions/host').getExtensionHost();
    if (!host || !host.has('bili.explore')) return;
    // 生物钟配置存 settings_kv
    const db = require('../db/dbStorage').getDb();
    const row = db.prepare("SELECT value FROM settings_kv WHERE key = 'bili_biolock'").get();
    let cfg = {};
    try { cfg = row ? JSON.parse(row.value) : {}; } catch {}
    const verdict = shouldWakeNow(now, cfg);
    if (!verdict.wake) return;
    lastWakeAt = now;
    const winName = verdict.window.name || verdict.window.start;
    cfg.wakes = cfg.wakes || {};
    cfg.wakes[verdict.dayKey + '|' + winName] = (cfg.wakes[verdict.dayKey + '|' + winName] || 0) + 1;
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('bili_biolock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
    const svc = host.getService('bili.explore');
    console.log('[biolock] 醒来刷B站（' + winName + '）');
    await svc.discover({ count: 3 });
  } catch (e) {
    console.warn('[biolock] 这一轮失败（已忽略）:', e?.message || e);
  } finally { checking = false; }
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[biolock] 生物钟已启动（60s 巡检，需 enabled+autoBrowse 双开）');
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function getHealth() { return { lastTickAt, lastWakeAt, running: !!timer }; }

module.exports = { start, stop, tick, getHealth, shouldWakeNow, inQuietHours };
