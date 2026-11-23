// src/services/scheduledJobsService.js
// 阶段 C 定时任务调度器（core 侧 IO，不进共享包）。
//
// 职责：周期扫描 scheduled_jobs 里到点的任务（isDue 来自共享包），
// 通过 WS 主动推送提醒给对应 uid，再用 fireJob 落库（once 置 fired / daily 顺延）。
// 调度状态不落库在别处——「哪些没跑」直接以 job 的 status+dueAt 为准，重启后扫表即恢复。

const { isDue, fireJob } = require('kirari-agent');
const { jobStore } = require('../session/jobStore');

let timer = null;
let scanning = false;
const SCAN_INTERVAL_MS = 15 * 1000;

/**
 * 这条提醒属于谁？到点触发时**唯一**的归属来源解析。
 *
 * 顺序（不能反）：
 *   1) job.ownerKey —— 建任务时从 ctx 解析并持久化的，最准
 *   2) payload.owner —— 老的 workspace_task 把 owner 写在 JSON 里
 *   3) sessionId 反推 —— 只对"确实是本机自用"的会话可信
 *
 * 拆成独立函数是为了能单测：这段判断决定了提醒会不会投错人，
 * 而它以前藏在 setTimeout 触发的调度路径里，只能靠"用户说没收到"发现问题。
 *
 * @returns {string} 归属人；'' 表示认不出来（调用方不应把空当成 _local 用）
 */
function resolveJobOwner(job = {}) {
  let owner = String(job.ownerKey || '').trim();

  // ② 老 workspace_task 把 owner 放在 payload JSON 里
  if (!owner) {
    try {
      const workspaceTask = require('./workspaceTask');
      const parsed = workspaceTask.parsePayload ? workspaceTask.parsePayload(job.payload) : null;
      if (parsed && parsed.owner) owner = String(parsed.owner).trim();
    } catch {
      /* 非 JSON payload，走下一步 */
    }
  }

  // ③ 从 sessionId 反推
  if (!owner) {
    try {
      const workspace = require('./workspace');
      owner = String(workspace.resolveOwnerFromCtx({ sessionId: job.sessionId }) || '').trim();
    } catch {
      owner = '';
    }
  }

  // ── '_local' 到底是不是可信答案？取决于**会话 id 的形状**，不能一概而论 ──
  //   · 纯 uuid / 桌面聊天框 → 真的"本机自用"，_local 正确（主人的桌面提醒）
  //   · `workspace:<taskId>` / `sub::<uid>::<taskId>` → 这类会话**永远属于某个人**，
  //     但 sessionId 里根本不含用户标识。反推出 _local 不是"本地自用"，而是
  //     "我没认出来" —— 而 _local 会推到没联动任何人的桌面，也就是主人的桌面。
  //     这正是用户报障「朋友的任务结果跑到我这儿」的路径。
  //     所以这类会话只接受显式归属，推不出来就返回空。
  const sid = String(job.sessionId || '');
  const isPerPersonSession = sid.startsWith('workspace:') || sid.startsWith('sub::');
  if (isPerPersonSession && (!owner || owner === '_local')) {
    console.warn(
      `[sched] ⚠️ 个人会话（${sid.slice(0, 40)}）里的任务查不到归属人，`
      + `不推桌面以免误投给主人。`,
    );
    return '';
  }

  // ── 2026-11-20 规范化：返回前归一 ────────────────────────────────────
  // 历史数据里 owner 可能是 '_local'（主人本机建的提醒），也可能是本机会话
  // UUID。这两种写法在语义上就是主人，但如果不归一，调用方拿它跟规范键
  // '1980308740' 一比就认不出来 —— 提醒静默消失那个 bug 就是这么来的。
  // 这里统一收敛，让「存的是什么」与「比的是什么」永远是同一种写法。
  if (!owner) return '';
  try {
    return require('./ownerIdentity').canonicalIdentity(owner);
  } catch {
    return owner;
  }
}

/**
 * 把一条提醒真正送到用户手上，返回送达的通道数。
 *
 * ── 为什么不能只推桌面（2026-11-20 用户报障）────────────────────
 *   「六点多的时候，它还知道要7点提醒我，但是到了7点也没提醒我」
 *
 * 原因：提醒几乎都是在 QQ 里定的，而原先只有 pushProactiveMessage（桌面 WebSocket）。
 * 到点那一刻桌面没开 → 推给 0 个连接 → 消息静默消失，job 却仍然被标成 fired。
 * 用户视角就是「说好的提醒没来」，而且事后查库还显示「已触发」，无从追。
 *
 * 所以改成两条腿：
 *   ① 桌面 WebSocket（桌宠能开口说出来）—— 必须按归属人定向，见 resolveJobOwner
 *   ② 原会话所在平台（QQ 私聊/群）——用户在哪儿定的，就在哪儿收到
 * 两条都失败时**明确告警**，不再假装成功。
 */
function deliverReminder(job) {
  const text = String(job.payload || '');
  if (!text) {
    console.warn(`[sched] 提醒 job=${job.jobId} 内容为空，跳过`);
    return 0;
  }

  let sentWs = 0;
  let sentPlatform = 0;

  // 这条提醒属于谁？拆不出来就**不推桌面**——宁可不推，也不能因为
  // 「不知道是谁」就广播给所有人（2026-11-20 报障正是这么来的）。
  const owner = resolveJobOwner(job);

  // ① 桌面。⚠️ 只有**主人自己**的提醒才推桌面：
  //    pushProactiveMessageToOwner 会按连接上报的对话者过滤，
  //    别人的提醒推到这个桌面上就变成「她的任务跑到我这儿来了」。
  if (owner) {
    try {
      const { pushProactiveMessageToOwner } = require('../websocket/socketServer');
      sentWs = pushProactiveMessageToOwner(owner, {
        speech: text,
        sessionId: job.sessionId,
        emotion: 'happy',
      }) || 0;
    } catch (e) {
      console.warn(`[sched] 提醒 job=${job.jobId} 推送桌面失败:`, e?.message || e);
    }
  } else {
    console.warn(
      `[sched] 提醒 job=${job.jobId} 解析不出归属人，**不推桌面**（避免误投给主人）`,
    );
  }

  // ② 原会话所在平台。sessionId 是 `bot-<adapterId>-<conversationKey>` 才发得出去；
  //    桌面/网页本地会话（纯 uuid）没有平台通道，走下面的 ③。
  let sentBySession = false;
  try {
    const botManager = require('../bot/botManager');
    if (typeof botManager.pushToUserSession === 'function') {
      sentBySession = !!botManager.pushToUserSession(job.sessionId, text);
      if (sentBySession) sentPlatform = 1;
    }

    // ③ 主人从网页/桌宠建的提醒（本地会话）必须也能回到她的 QQ 私聊窗口。
    //    用户 2026-11-20 拍板：「在这里创建的任务，同样会返回给我的 QQ 与她
    //    私聊的窗口」。按主人身份键直发，绝不按 job.sessionId（那是 UUID）。
    //    只对主人自己的 job 做——客人的任务只回客人自己的平台会话（②），
    //    绝不进主人 QQ。
    //
    // ── 2026-11-20 规范化：结论必须用 samePerson 比，不能 === ────────────
    // 原来这行是 `getOwnerKey() === owner`。主人 QQ 私聊建提醒时，owner 被存
    // 成了 '_local'（因为 sessionId 已并成本机会话 UUID），于是
    // '1980308740' === '_local' 为假 → 这一步被跳过 → 桌面又没开 →
    // 整条提醒静默消失，job 却照样标成 fired。用户看到的就是「说好的提醒没来」。
    //
    // 现在两侧都过 canonicalIdentity 再比：'_local'、本机会话 UUID、
    // '1980308740' 会被认成同一个人。以后不管写入方用哪种写法都不会再错。
    if (!sentBySession && owner) {
      const ownerIdentity = require('./ownerIdentity');
      if (ownerIdentity.samePerson(owner, ownerIdentity.getOwnerKey())
          && typeof botManager.pushToOwnerPrivate === 'function') {
        // 发出去时一律用规范键，别把历史别名递给下游
        if (botManager.pushToOwnerPrivate(ownerIdentity.canonicalIdentity(owner), text)) sentPlatform = 1;
      }
    }
  } catch (e) {
    console.warn(`[sched] 提醒 job=${job.jobId} 发回平台失败:`, e?.message || e);
  }

  const total = sentWs + sentPlatform;
  if (total > 0) {
    console.log(
      `[sched] 提醒 job=${job.jobId} uid=${job.uid} 已送达（桌面 ${sentWs} 个连接 / 平台 ${sentPlatform ? 1 : 0} 条）`,
    );
  } else {
    // 这个 warn 是刻意留的：以前这种情况完全静默，出了问题只能靠猜。
    console.warn(
      `[sched] ⚠️ 提醒 job=${job.jobId} 没有送达任何地方`
      + `（桌面无连接、sessionId=${job.sessionId} 也不是平台会话）。内容：${text.slice(0, 60)}`,
    );
  }
  return total;
}

/** 扫一次到点任务并逐个触发。供定时器与手动调用（测试/启动补跑）共用。 */
async function scanOnce() {
  if (scanning) return 0;
  scanning = true;
  let fired = 0;
  try {
    const now = Date.now();
    const due = jobStore.due(now, 100);
    for (const job of due) {
      if (!isDue(job, now)) continue; // 双保险：sql 已过滤，这里再按共享包语义核对
      try {
        let delivered = 0;
        if (job.kind === 'reminder') {
          delivered = deliverReminder(job);
        } else if (job.kind === 'daily_brief') {
          // 阶段 E：简报任务（每 uid × 08/16/22 三档）。生成成功与否都顺延，
          // 失败时 briefSchedule 内部已回滚档位锁并 warn，不会形成 15s 热循环。
          const briefSchedule = require('./briefSchedule');
          await briefSchedule.fireDailyBrief(job, now);
        } else if (job.kind === 'workspace_task') {
          // 工作空间定期任务：到点让它自己去执行并把产出写进任务文件夹。
          // 叶子节点在这里会**转发给主机**执行（见 services/workspaceTask.js），
          // 产出落在主机，叶子只拿结果——用户 2026-11-19 明确要求的行为。
          const workspaceTask = require('./workspaceTask');
          await workspaceTask.fire(job, now);
        } else if (job.kind === 'presence_tick') {
          // 在场感主动搭话（presence:tick:<uid> job）：tickPresence 内部自己判闸门
          // （安静时段/每日上限/素材）。没 fire 也会更新状态档的 nextFireAt，
          // 由下方覆盖段把 job 顺延到那个点。
          const presenceSchedule = require('./presence/presenceSchedule');
          const uid = Number(job.uid) || 1;
          const result = await presenceSchedule.tickPresence(uid, now);
          if (result.fired) {
            console.log(`[sched] presence 主动搭话完成 uid=${uid}：${result.reason}`);
          }
        }
        // 没有在线连接也算触发过：once 任务不能因为「没连上」而永远 pending 反复推。
        const next = fireJob(job, now);

        // ★ 归属人要跟着任务走到下一次。
        //   fireJob 是共享包的纯函数，不认识 ownerKey；如果这里不补，
        //   周期任务**从第二次起就没有归属**了 —— 到点又只能靠 sessionId 猜，
        //   而 workspace: 会话猜出来的永远是 _local（= 主人桌面）。
        //   一次性任务的 bug 会被"只错一次"掩盖，周期任务则是每天错一次。
        if (next && job.ownerKey && !next.ownerKey) next.ownerKey = job.ownerKey;

        // weekly / monthly 的间隔不是 24h，共享包的 computeNextRun 只会 +24h。
        // 这里按 payload 里存的周期字段把 dueAt 覆盖成正确的下一次。
        // once / daily 走共享包的原有语义，不碰。
        if (job.kind === 'workspace_task' && next.status === 'pending') {
          try {
            const workspaceTask = require('./workspaceTask');
            const payload = workspaceTask.parsePayload(next.payload) || {};
            const scheduleTask = require('../capabilities/builtin/schedule_task');
            const overridden = scheduleTask.nextDueAtAfterFire(payload, next.dueAt);
            if (overridden != null) next.dueAt = overridden;
          } catch (e) {
            console.warn(`[sched] 重算 job=${job.jobId} 下次时间失败（沿用共享包结果）:`, e?.message || e);
          }
        }

        // presence_tick 的间隔不是 24h：2.5~5h 区间随机 + 安静时段避让，
        // 都算在状态档的 nextFireAt 里。fireJob 的 daily +24h 必须在这里覆盖回去。
        // ⚠️ nextFireAt 已经过去时（到点被安静时段挡下）不能退回 now+60s ——
        // 那会变成安静时段里每分钟热循环；改用 quietEndAfter 推到安静时段结束。
        if (job.kind === 'presence_tick' && next.status === 'pending') {
          try {
            const presenceEngine = require('./presence/presenceEngine');
            const { loadOrInitPresenceState } = require('./presence/stateStore');
            const uid = Number(job.uid) || 1;
            const state = loadOrInitPresenceState(now, uid);
            const want = state.nextFireAt || 0;
            next.dueAt = want > now ? want : presenceEngine.quietEndAfter({ quietStart: '23:30', quietEnd: '08:00' }, now);
          } catch (e) {
            console.warn(`[sched] presence 重算下次时间失败（兜底 1h）:`, e?.message || e);
            next.dueAt = now + 60 * 60000;
          }
        }

        jobStore.save(next, 'job_fired');
        fired++;
      } catch (e) {
        // 单条失败不影响其他任务；保留 pending 让下一轮重试（不是无限——到点仍 pending）。
        console.warn(`[sched] 触发 job=${job.jobId} 失败（稍后重试）:`, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[sched] 扫表失败（稍后重试）:', e?.message || e);
  } finally {
    scanning = false;
  }
  if (fired > 0) {
    // 让 job_fired 事件及时落库；失败只 warn（旁路语义）。
    try { await require('../session/eventRecorder').recorder.flush(); } catch (e) { console.warn('[sched] 事件 flush 失败:', e?.message || e); }
  }
  return fired;
}

/** 启动调度器：先补跑一次（覆盖服务停机期间到点的任务），再挂周期定时。 */
function start() {
  if (timer) return;
  void scanOnce();
  timer = setInterval(() => { void scanOnce(); }, SCAN_INTERVAL_MS);
  // 定时器不该阻止进程退出。
  if (timer.unref) timer.unref();
  console.log('[sched] 定时任务调度器已启动（每 15s 扫描）');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, scanOnce, resolveJobOwner };