// src/session/jobStore.js
// JobStore 适配器：把 kirari-agent 的 JobStore 纯契约接到核心版已有的 better-sqlite3。
// 与 taskStore / eventStore 同构：惰性 require、写操作旁路 job_* 事件（失败只 warn）。

const { SCHEDULED_JOBS_TABLE } = require('kirari-agent');

function getDb() {
  return require('../db/dbStorage');
}

function rowToJob(row) {
  if (!row) return undefined;
  const job = {
    jobId: row.job_id,
    sessionId: row.session_id,
    origin: row.origin,
    uid: row.uid,
    kind: row.kind,
    title: row.title,
    payload: row.payload,
    dueAt: row.due_at,
    recurrence: row.recurrence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // ── 2026-11-20 身份排查（A2）：任务归属必须跟着任务走 ────────────────
    // 到点触发时调度器只有这一行数据。没有 ownerKey 就只能在推送时
    // 从 sessionId 猜归属，而 workspace:<taskId> 猜不出来 → 退化成 _local
    // → 推到主人桌面。这是「别人的任务跑到我这儿」的根因。
    ownerKey: String(row.owner_key || ''),
  };
  if (row.last_fired_at != null) job.lastFiredAt = row.last_fired_at;
  return job;
}

function jobToRow(job) {
  return {
    job_id: job.jobId,
    session_id: job.sessionId,
    origin: job.origin,
    uid: job.uid ?? 1,
    kind: job.kind,
    title: job.title,
    payload: job.payload,
    due_at: job.dueAt,
    recurrence: job.recurrence ?? 'once',
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    last_fired_at: job.lastFiredAt ?? null,
    // ⚠️ 这个字段以前就在白名单外 —— 上游 taskRuntime/selfOps 明明写了
    //    `job.ownerKey`，到了这里被静默丢掉，存进库的是一条无主任务。
    //    上游写、下游读，中间这一层必须透传，否则修了上游也白修。
    owner_key: String(job.ownerKey || ''),
  };
}

function enqueueJobEvent(job, type) {
  try {
    const { recorder, currentTurnId } = require('./eventRecorder');
    recorder.enqueue({
      origin: job.origin,
      sessionId: job.sessionId,
      turnId: currentTurnId(),
      type,
      payload: { jobId: job.jobId, kind: job.kind, title: job.title, dueAt: job.dueAt, status: job.status },
    });
  } catch (e) {
    console.warn('[jobs] 记录定时任务事件失败（已忽略）:', e?.message || e);
  }
}

const jobStore = {
  get(jobId) {
    return rowToJob(getDb().getJobRow(jobId));
  },

  due(now, limit = 100) {
    return getDb().dueJobRows(now, limit).map(rowToJob);
  },

  /** upsert 并旁路事件；eventType 默认 job_created，触发时传 job_fired / job_cancelled。 */
  save(job, eventType) {
    getDb().saveJobRow(jobToRow(job));
    enqueueJobEvent(job, eventType || 'job_created');
  },

  list(sessionId, limit = 100) {
    return getDb().listJobRows(sessionId, limit).map(rowToJob);
  },
};

module.exports = { jobStore, SCHEDULED_JOBS_TABLE };
