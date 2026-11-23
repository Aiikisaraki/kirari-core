// src/services/presence/presenceSchedule.js
// 目的机制的调度层（核心版，CommonJS）。与桌面端 presenceSchedule.ts 对称。
//
// 核心端跑在服务器上，载体是**机器人**（QQ 私聊/群），不是桌宠气泡：
// runner 由 app.js 启动时注入 —— 生成一句话后交给 botManager 回发给主人私聊。
//
// 身份边界（用户 2026-11-24 明确要求，与桌面端同一把门）：
//   状态按 uid 分键（settings_kv），uid 即主人账号 —— 客人/群聊不写主人的驱动与心情。
//   主动搭话的素材只取该 uid 自己的简报与记忆，不跨人。

const { createJob } = require('kirari-agent');
const { jobStore } = require('../session/jobStore');
const dbStorage = require('../db/dbStorage');
const engine = require('./presenceEngine');
const { loadOrInitPresenceState, savePresenceState, localDateKey } = require('./stateStore');

const PRESENCE_JOB_ID = (uid) => 'presence:tick:' + uid;
const FALLBACK_SCAN_MS = 60 * 60000;

let runner = null; // async ({ prompt, uid }) => true=真的发出去了
let focusProvider = null; // () => boolean（按 uid）

function setPresenceRunner(r) {
  runner = r;
}
function setFocusProvider(p) {
  focusProvider = p;
}

function presenceConfig(uid) {
  const focus = typeof focusProvider === 'function' ? !!focusProvider(uid) : false;
  return { ...engine.DEFAULT_PRESENCE_CONFIG, focus };
}

/** 读该 uid 的今日简报当素材（纯读，不触发生成）。 */
async function briefMaterials(uid) {
  try {
    const dailyBriefing = require('./dailyBriefingService');
    const brief = await dailyBriefing.readTodayBrief(uid);
    if (!brief) return [];
    return [{ id: 'brief-' + dailyBriefing.todayStr(), source: 'brief', text: brief, at: Date.now(), ownerRef: true }];
  } catch (e) {
    console.warn('[presence] 读简报素材失败（跳过）:', e?.message || e);
    return [];
  }
}

/** 跑一次 tick。闸门 → 目标 → 提示词 → runner。返回 { fired, reason }。 */
async function tickPresence(uid, now = Date.now()) {
  const state = loadOrInitPresenceState(now, uid);
  const cfg = presenceConfig(uid);
  const materials = await briefMaterials(uid);
  const plan = engine.planOutreach({ state, cfg, now, materials });

  if (!plan.fire) {
    savePresenceState(plan.state, uid);
    return { fired: false, reason: plan.reason };
  }

  if (!runner) {
    console.warn('[presence] 到点了但没有 runner，这轮放弃');
    return { fired: false, reason: 'no runner' };
  }

  const prompt = engine.buildOutreachPrompt({ goal: plan.goal, goals: plan.goals, state: plan.state, now, cfg });
  let ok = false;
  try {
    ok = await runner({ prompt, uid, goal: plan.goal });
  } catch (e) {
    console.warn('[presence] runner 抛错:', e?.message || e);
    ok = false;
  }

  const after = engine.commitOutreach(plan.state, { goal: plan.goal, now, kind: ok ? 'sent' : 'failed', cfg });
  savePresenceState(after, uid);
  return { fired: ok, reason: ok ? (plan.goal ? plan.goal.intent : '') : 'runner failed' };
}

/**
 * 补齐/校正该 uid 的 presence_tick 任务。app.js 启动时对每个活跃 uid 调一次。
 * job kind 沿用 daily（kirari-agent 的 JobKind 是闭联联合）；间隔由 scanOnce 的
 * 覆盖段用状态档 nextFireAt 修正（fireJob 的 +24h 只是个中间值）。
 */
function ensureJob(uid, now = Date.now()) {
  const state = loadOrInitPresenceState(now, uid);
  const dueAt = Math.max(now + 60000, state.nextFireAt || now + FALLBACK_SCAN_MS);
  const jobId = PRESENCE_JOB_ID(uid);
  const existing = jobStore.get(jobId);
  if (!existing) {
    jobStore.save(
      createJob({
        jobId,
        sessionId: 'presence:' + uid,
        origin: 'core',
        uid,
        kind: 'daily_brief',
        title: '主动搭话 tick',
        payload: '',
        dueAt,
        recurrence: 'daily',
        now,
      }),
      'job_created',
    );
    console.log('[presence] tick 任务已创建 uid=' + uid + '，下次 ' + new Date(dueAt).toLocaleString());
    return;
  }
  if (existing.status !== 'pending') {
    jobStore.save(
      {
        ...existing,
        kind: 'daily_brief',
        recurrence: 'daily',
        status: 'pending',
        dueAt,
        updatedAt: now,
      },
      'job_created',
    );
    console.log('[presence] tick 任务已恢复 uid=' + uid + '，下次 ' + new Date(dueAt).toLocaleString());
  }
}

/** 今天主动说过几次（控制台展示用）。 */
function outreachToday(uid, now = Date.now()) {
  const state = loadOrInitPresenceState(now, uid);
  return state.outreachDate === localDateKey(now) ? state.outreachToday : 0;
}

module.exports = { setPresenceRunner, setFocusProvider, tickPresence, ensureJob, outreachToday, PRESENCE_JOB_ID };
