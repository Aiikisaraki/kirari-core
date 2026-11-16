// 内置能力：plan（阶段 D，一个能力一个文件）。
// schema 复用阶段 C taskRuntime 的 PLAN_TOOL（避免两处维护），dispatch 委托 handlePlan。
const { defineCapability } = require('kirari-agent');
const taskRuntime = require('../../services/taskRuntime');

const spec = taskRuntime.PLAN_TOOL.function;

const capability = defineCapability({
  id: 'plan',
  name: 'plan',
  kind: 'tool',
  scope: 'builtin',
  description: spec.description,
  parameters: spec.parameters,
  tags: ['builtin', 'task'],
});

async function dispatch(args, ctx) {
  return await taskRuntime.handlePlan(args || {}, {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    uid: ctx.uid,
    origin: ctx.origin || 'core',
  });
}

module.exports = { capability, dispatch };
