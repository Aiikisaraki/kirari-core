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
    // ⚠️ 必须带 fromSchedule=true：这是「内部调度自己醒来」，不是主人当面叫她。
    //
    // 这个标记原来是个**死代码**：capability 里读它来决定 autoBrowse 拦不拦，
    // 但两端都没有任何调用方真的把它置 true（workspaceTask 的提示词还写着
    // 「不要带 fromSchedule=true」）。结果是：用户关掉「自主闲逛」开关后，
    // 生物钟照样醒来刷 B 站 —— 开关形同虚设，而且没有任何报错可见。
    //
    // 这里补上真正的调用方，让 autoBrowse 开关终于生效。
    const result = await svc.discover({ count: 3, fromSchedule: true });

    // ── 看完之后：她可能想跟你说说 ────────────────────────────────
    // 原来 discover 完就结束了：见闻写进记忆，但**没有任何渠道让她开口**。
    // 用户要的是「她主动联系我」——光有记忆不算联系。
    //
    // 所以这里把「刚才看了什么」交给 presence 的关系时机通道：
    //   · 走同一条 runner（发主人私聊、支持 SKIP、带人设）；
    //   · 走同一份日账本与安静时段/专注模式闸门（不会因为她刷了B站就多刷一次屏）；
    //   · 素材用**真的读到的标题**，不是「我刷了B站」这种空话。
    try {
      const observations = (result && result.observations) || [];
      if (observations.length) {
        const presenceSchedule = require('./presence/presenceSchedule');
        const titles = observations
          .map((ob) => (ob.title ? '《' + ob.title + '》' : ''))
          .filter(Boolean)
          .slice(0, 3);
        if (titles.length) {
          const uid = Number(cfg.uid) || 1;
          const now2 = Date.now();
          const timing = 'after_browse';
          const prompt = [
            '【刚看完B站，可能想跟他说说】',
            '你刚从B站回来，看到这些：' + titles.join('、') + '。',
            '· 想跟他讲哪条就讲哪条，讲你看到的、你怎么想的。',
            '· **不想说就跳过**（不想说是正常选项）。别只是汇报「我刷了B站」——那是流水账。',
            '· 最多两三句，一行一个念头。',
            '· 他可能不回，别追。',
            '· 别说这是「系统让我发的」，也别说「刚才刷到了」这种旁白腔 —— 就像你平时跟他聊天的样子。',
          ].join('\n');
          const res = await presenceSchedule.proactiveWithTiming(uid, now2, {
            prompt: prompt,
            timing: timing,
            chance: 0.5,
          });
          if (res.fired) console.log('[biolock] 她把看到的分享出来了');
          else console.log('[biolock] 这次没主动说：' + res.reason);
        }
      }
    } catch (e) {
      console.warn('[biolock] 浏览后的主动分享失败（已忽略）:', e && e.message ? e.message : e);
    }
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