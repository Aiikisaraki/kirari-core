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
    // 身份一并带进去：提醒内容是模型生成的，它在不知道对方是谁的时候会默认
    // 写成「提醒主人」。非主人设的提醒也喊「主人」就等于让别人的话冒充主人。
    role: ctx.role,
    displayName: ctx.displayName || ctx.senderName,
  });
}

module.exports = { capability, dispatch };
