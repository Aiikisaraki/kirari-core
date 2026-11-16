// src/services/briefSchedule.js
// 阶段 E：每日简报从「进程内 setTimeout 递归」迁到落库调度（scheduled_jobs）。
//
// 迁移动机（设计文档 §10）：
//   1) 原 setTimeout 递归没有任何持久化，服务重启就丢了下一次触发；也没 unref，
//      还在某些环境下把进程钉住。
//   2) 停机跨过 08/16/22 档时完全没有补偿，用户当天可能一份简报都没有。
//   3) 三档 × N 用户全靠一个闭包循环，失败只 warn，无从追溯。
//
// 现在的形态：每个 uid × 三档一条 kind=daily_brief、recurrence=daily 的 job，
// 交给阶段 C 的 scheduledJobsService 统一扫描。启动时 ensureJobs() 补齐/校正记录，
// 到点的旧记录会被调度器扫到并补跑一次（fireJob 的 computeNextRun 会一次性跳到未来，
// 不会把停机期间错过的每一档都补一遍）。
//
// 两端（core / desktop）共库：用 settings_kv 的 brief_done:<uid>:<date>:<slot> 抢占锁，
// 保证同一档只有一个进程真正去采集 + 压缩，另一进程只顺延 job。

const { createJob } = require('kirari-agent');
const { jobStore } = require('../session/jobStore');
const dbStorage = require('../db/dbStorage');

const BRIEF_SLOTS = [8, 16, 22];
const JOB_ID_PREFIX = 'brief';

function jobIdFor(uid, slot) {
  return `${JOB_ID_PREFIX}:${uid}:${slot}`;
}

function sessionIdFor(uid) {
  return `${JOB_ID_PREFIX}:${uid}`;
}

/** 下一个 slot 整点（本地时区）。已过则顺延到明天同一档。 */
function nextSlotAt(slot, now) {
  const d = new Date(now);
  d.setHours(slot, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 从 jobId 尾段取档位；解析不出时按 dueAt 的小时数兜底。 */
function slotOf(job) {
  const tail = Number(String(job.jobId).split(':').pop());
  if (BRIEF_SLOTS.includes(tail)) return tail;
  const h = new Date(job.dueAt).getHours();
  return BRIEF_SLOTS.includes(h) ? h : BRIEF_SLOTS[0];
}

/**
 * 补齐/校正每个用户的简报任务。启动时调用一次即可。
 * 只补「不存在的」和「已终态（fired/cancelled）的」记录；pending 记录一律不动 ——
 * 它可能是停机期间已过期的那一档，正是要留给调度器补跑的补偿信号。
 */
async function ensureJobs(now = Date.now()) {
  let created = 0;
  let revived = 0;
  const uids = await dbStorage.getAllUserids();
  for (const uid of uids) {
    for (const slot of BRIEF_SLOTS) {
      const jobId = jobIdFor(uid, slot);
      const existing = jobStore.get(jobId);
      if (!existing) {
        jobStore.save(
          createJob({
            jobId,
            sessionId: sessionIdFor(uid),
            origin: 'core',
            uid,
            kind: 'daily_brief',
            title: `每日简报 ${String(slot).padStart(2, '0')}:00`,
            payload: '',
            dueAt: nextSlotAt(slot, now),
            recurrence: 'daily',
            now,
          }),
          'job_created',
        );
        created++;
        continue;
      }
      // 已终态（once 语义被误用 / 被取消）时重新激活；pending 不碰（见函数头注释）。
      if (existing.status !== 'pending') {
        jobStore.save(
          {
            ...existing,
            kind: 'daily_brief',
            recurrence: 'daily',
            status: 'pending',
            dueAt: nextSlotAt(slot, now),
            updatedAt: now,
          },
          'job_created',
        );
        revived++;
      }
    }
  }
  if (created || revived) {
    console.log(`[brief] 简报任务已就绪：新建 ${created} 条，恢复 ${revived} 条（用户 ${uids.length} 个）`);
  }
  return { users: uids.length, created, revived };
}

/**
 * 触发一条简报任务。返回 true=本进程实际生成了简报，false=被别人抢到或跳过。
 * 锁的粒度是「uid + 本地日期 + 档位」：同一天同一档只跑一次；生成失败会回滚锁，
 * 让另一进程或 15s 后的下一轮扫描还能补。
 */
async function fireDailyBrief(job, now = Date.now()) {
  const slot = slotOf(job);
  const date = require('./dailyBriefingService').todayStr();
  const lockKey = `brief_done:${job.uid}:${date}:${slot}`;
  if (!dbStorage.claimSetting(lockKey, String(now))) {
    console.log(`[brief] ${date} ${slot}:00 已由另一进程生成，本进程跳过`);
    return false;
  }

  const connectionAiContext = require('../ai/connectionAiContext');
  const dailyBriefing = require('./dailyBriefingService');
  let ctx = null;
  try {
    ctx = await connectionAiContext.createConnectionAiContext(job.uid);
    const brief = await dailyBriefing.generateDailyBrief(ctx);
    if (!brief) throw new Error('简报内容为空');
    console.log(`[brief] ${date} ${slot}:00 生成完成 uid=${job.uid} len=${brief.length}`);
    return true;
  } catch (e) {
    // 未配置模型 / 采集全失败：回滚锁，交回调度器顺延到下一档。
    // 这里不抛错——否则 job 保持 pending，每 15s 重试一次变成热循环；
    // 当天缺简报由对话时的 ensureDailyBrief 惰性兜底。
    dbStorage.releaseSetting(lockKey);
    console.warn(`[brief] ${date} ${slot}:00 生成失败 uid=${job.uid}:`, e?.message || e);
    return false;
  } finally {
    if (ctx) {
      try {
        connectionAiContext.cleanupConnectionAiContext(ctx);
      } catch {
        /* 忽略 */
      }
    }
  }
}

module.exports = {
  BRIEF_SLOTS,
  ensureJobs,
  fireDailyBrief,
  nextSlotAt,
  jobIdFor,
  slotOf,
};
