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
