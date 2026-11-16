// 内置能力：subagent（阶段 E，一个能力一个文件）。
// 把「可独立拆分的子任务」交给一个受限的子代理去跑：它有自己的一套工具循环与
// 独立的会话记录（sub::<uid>::<taskId>），不会污染主会话的消息与 UI，
// 只把最终结论作为工具结果回传。工具集自动剔除 subagent 自身，禁止递归。
const { defineCapability, scopeKey } = require('kirari-agent');
const subagentRuntime = require('../../services/subagentRuntime');

const capability = defineCapability({
  id: 'subagent',
  name: 'subagent',
  kind: 'agent',
  scope: 'builtin',
  description:
    '把一个可以独立完成的子任务交给子代理执行，返回它的结论。适合：需要多步查证/整理的独立任务（例如「分别查这三家公司的股价并对比」「帮我调研某个话题的关键事实」）。不要用于一句话就能回答的问题，也不要嵌套委派。',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: '子任务的完整描述：目标、必要的约束与期望的输出形式。子代理看不到主对话，必须自包含。',
      },
    },
    required: ['goal'],
  },
  tags: ['builtin', 'agent'],
  // 子代理内部是完整工具循环，需要比普通工具更长的预算；上限 120s 由共享包约束。
  timeoutMs: 120000,
  truncateChars: 4000,
});

async function dispatch(args, ctx = {}) {
  const scopeId =
    ctx.capScope || scopeKey('local', String(ctx.uid ?? 'anon'));
  return await subagentRuntime.runSubagent({
    goal: args?.goal,
    ctx: { ...ctx, capScope: scopeId },
    scopeId,
  });
}

module.exports = { capability, dispatch };
