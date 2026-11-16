// src/session/taskStore.js
// TaskStore 适配器：把 kirari-agent 的 TaskStore 纯契约接到核心版已有的 better-sqlite3。
// 与 eventStore.js 同构：惰性 require dbStorage 避开顶层循环依赖。
// 写操作（save）旁路记录 task_* 事件，让任务推进在轨迹里可追溯（红线：写失败只 warn）。

const { TASKS_TABLE } = require('kirari-agent');

function getDb() {
  return require('../db/dbStorage');
}

function rowToTask(row) {
  if (!row) return undefined;
  let steps = [];
  try {
    const parsed = JSON.parse(row.steps_json);
    if (Array.isArray(parsed)) steps = parsed;
  } catch (e) {
    console.warn('[tasks] steps_json 不是合法 JSON，按空步骤处理：', e?.message || e);
  }
  const task = {
    taskId: row.task_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    origin: row.origin,
    uid: row.uid,
    title: row.title,
    status: row.status,
    steps,
    currentStep: row.current_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.completed_at != null) task.completedAt = row.completed_at;
  return task;
}

function taskToRow(task) {
  return {
    task_id: task.taskId,
    session_id: task.sessionId,
    turn_id: task.turnId,
    origin: task.origin,
    uid: task.uid ?? 1,
    title: task.title,
    status: task.status,
    steps_json: JSON.stringify(task.steps ?? []),
    current_step: task.currentStep ?? 0,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    completed_at: task.completedAt ?? null,
  };
}

function enqueueTaskEvent(task, extraType) {
  try {
    const { recorder, currentTurnId } = require('./eventRecorder');
    // extraType 存在时用它是为了记 job 之外 task 的细分动作；默认 task_updated。
    recorder.enqueue({
      origin: task.origin,
      sessionId: task.sessionId,
      turnId: extraType ? currentTurnId() : (task.turnId || currentTurnId()),
      type: extraType || 'task_updated',
      payload: {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        currentStep: task.currentStep,
        stepCount: task.steps.length,
      },
    });
  } catch (e) {
    console.warn('[tasks] 记录任务事件失败（已忽略）:', e?.message || e);
  }
}

const taskStore = {
  get(taskId) {
    return rowToTask(getDb().getTaskRow(taskId));
  },

  active(sessionId) {
    return getDb().activeTaskRows(sessionId).map(rowToTask);
  },

  /**
   * upsert 并旁路事件。调用方传第二参可指定事件类型：
   *   - 'task_created' / 'task_completed' / 'task_failed'（细分事件）
   *   - 不传 → task_updated
   * 注意 save 本身是幂等的（ON CONFLICT），重复落库不会插出新行。
   */
  save(task, eventType) {
    getDb().saveTaskRow(taskToRow(task));
    enqueueTaskEvent(task, eventType);
  },

  list(sessionId, limit = 100) {
    return getDb().listTaskRows(sessionId, limit).map(rowToTask);
  },
};

module.exports = { taskStore, TASKS_TABLE };
