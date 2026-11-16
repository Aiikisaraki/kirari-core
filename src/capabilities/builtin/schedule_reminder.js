// 内置能力：schedule_reminder（阶段 D，一个能力一个文件）。
const { defineCapability } = require('kirari-agent');
const taskRuntime = require('../../services/taskRuntime');

const spec = taskRuntime.REMINDER_TOOL.function;

const capability = defineCapability({
  id: 'schedule_reminder',
  name: 'schedule_reminder',
  kind: 'tool',
  scope: 'builtin',
  description: spec.description,
  parameters: spec.parameters,
  tags: ['builtin', 'task'],
});

async function dispatch(args, ctx) {
  return await taskRuntime.handleScheduleReminder(args || {}, {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    uid: ctx.uid,
    origin: ctx.origin || 'core',
  });
}

module.exports = { capability, dispatch };
