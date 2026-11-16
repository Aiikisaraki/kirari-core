// src/services/subagentRuntime.js
// 阶段 E：按需子 agent（核心版侧）。
//
// 设计要点（用户拍板）：
//   1) 以「内置能力」形态暴露：模型在需要拆解子任务时调用 subagent(goal)，
//      和调用其它工具没有区别，不需要额外的协议或 UI。
//   2) 独立会话：子 agent 的 request / tool_* / assistant 事件写进
//      sub::<uid>::<taskId>，主会话只留一条 tool_result（结果摘要）。
//      —— 这就是「子 agent 不触碰主会话 UI」的落地方式：UI 只订阅主 sessionId。
//   3) 不递归：子 agent 的工具集显式剔除 subagent 自身，避免无限套娃。
//   4) 有界：轮数取 profile 与 4 的较小值，结果统一交给 dispatch 的截断流水线。
//
// IO 仍全在本机：模型调用走 reply/streaming（与主对话同一条路径），工具执行走
// 能力注册表的统一 dispatch（同 scope，前端工具/技能/MCP 都可用）。

const { AgentRunner } = require('kirari-agent');
const modelConfigFile = require('./modelConfigFile');
const capabilities = require('../capabilities/registry');
const { recorder } = require('../session/eventRecorder');
const { streamChatCompletion } = require('./reply/streaming');

const SUBAGENT_NAME = 'subagent';
const MAX_GOAL_CHARS = 2000;
const MAX_SUBAGENT_ROUNDS = 4;

const SYSTEM_PROMPT =
  '你是桌宠 Kirari 的子代理，只负责完成主人交办的这一个子任务。\n' +
  '规则：\n' +
  '1. 专注、直接，不要寒暄，不要扮演人格，不要输出与子任务无关的内容。\n' +
  '2. 需要事实时先用工具查证，不要凭空编造。\n' +
  '3. 完成后用简洁的中文给出结果（要点式即可），这就是要回传给主代理的全部内容。';

function newTaskId() {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 子 agent 可见的工具：当前 scope 的全部工具，剔除自身（防递归）。 */
function subagentTools(scopeId) {
  return capabilities.listTools(scopeId).filter((t) => t?.function?.name !== SUBAGENT_NAME);
}

/**
 * 跑一个子任务，返回最终文本。
 * 任何异常都转成 `error: ...` 文本（与工具失败约定一致），不打断主对话。
 * @param {{goal: string, ctx: object, scopeId: string}} args
 */
async function runSubagent({ goal, ctx = {}, scopeId }) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  if (!text) return 'error: 子任务描述不能为空';
  if (text.length > MAX_GOAL_CHARS) return `error: 子任务描述超过 ${MAX_GOAL_CHARS} 字符`;
  if (!ctx.openai || !ctx.model) return 'error: 子 agent 缺少模型客户端（未配置大脑）';

  const base = modelConfigFile.getAgentProfile();
  const profile = { ...base, maxRounds: Math.min(base.maxRounds || MAX_SUBAGENT_ROUNDS, MAX_SUBAGENT_ROUNDS) };
  const taskId = newTaskId();
  const sessionId = `sub::${ctx.uid ?? 1}::${taskId}`;
  const turnId = `t-${taskId}`;
  const tools = subagentTools(scopeId || capabilities.scopeKey('local', String(ctx.uid ?? 'anon')));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];

  recorder.enqueue({
    origin: ctx.origin || 'core',
    sessionId,
    turnId,
    type: 'user_message',
    payload: { content: text, subagent: true, parentSessionId: ctx.sessionId || null },
  });

  const runner = new AgentRunner(profile);
  try {
    const finalText = await runner.run(async (round, r) => {
      recorder.enqueue({
        origin: ctx.origin || 'core',
        sessionId,
        turnId,
        type: 'request',
        payload: {
          round,
          callSite: 'subagent',
          params: {
            model: ctx.model,
            max_tokens: profile.maxTokens,
            toolsCount: tools.length,
          },
          messages: JSON.parse(JSON.stringify(messages)),
        },
      });

      const completion = await streamChatCompletion(ctx.openai, {
        model: ctx.model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        max_tokens: profile.maxTokens,
      });
      const msg = completion?.choices?.[0]?.message || { role: 'assistant', content: '' };
      messages.push(msg);

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!toolCalls.length) {
        return { kind: 'final', value: String(msg.content || '').trim() };
      }

      const ids = toolCalls.map((tc, i) => tc.id || `sub-call-${round}-${i}`);
      runner.note(ids);
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const id = ids[i];
        const name = tc.function?.name || '';
        let args = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          /* 参数解析失败交给 dispatch 报错 */
        }
        recorder.enqueue({
          origin: ctx.origin || 'core',
          sessionId,
          turnId,
          type: 'tool_call',
          payload: { round, tool_call_id: id, name, args },
        });
        let result;
        try {
          const dispatched = await capabilities.dispatch(scopeId, name, args, ctx);
          result = dispatched.content;
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({ role: 'tool', tool_call_id: id, content: String(result) });
        recorder.enqueue({
          origin: ctx.origin || 'core',
          sessionId,
          turnId,
          type: 'tool_result',
          payload: {
            round,
            tool_call_id: id,
            name,
            content: String(result),
            isError: String(result).startsWith('error:'),
          },
        });
        r.settle(id);
      }
      return { kind: 'tools', toolCallIds: ids };
    });

    const out = finalText || '（子代理没有产出内容）';
    recorder.enqueue({
      origin: ctx.origin || 'core',
      sessionId,
      turnId,
      type: 'assistant_message',
      payload: { content: out, source: 'subagent' },
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recorder.enqueue({
      origin: ctx.origin || 'core',
      sessionId,
      turnId,
      type: 'assistant_message',
      payload: { content: `error: ${msg}`, source: 'subagent', failed: true },
    });
    return `error: 子代理执行失败：${msg}`;
  }
}

module.exports = { runSubagent, SUBAGENT_NAME, MAX_SUBAGENT_ROUNDS };
