const sessionManager = require('../session/sessionManager');

// 模型回复可携带的情绪/动作标签，需与前端白名单（PetEmotion）保持一致。
const EMOTION_WHITELIST = new Set(['happy', 'wave']);

// 把文本安全地 JSON.parse 为对象；失败返回 null。
function tryParseJson(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// 尽力修复残缺 JSON：剥离代码块、裁掉前后多余符号、补缺失大括号、去尾随逗号。
// 返回修复后的字符串；无法判定为 JSON 片段时返回 null。
function repairJson(text) {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s) return null;

  // 只取首个 { 到最后一个 } 之间的片段，容忍前后多余符号（如 "好的 {...} 再见"）
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  s = s.slice(start, end + 1);

  // 去尾随逗号：{, ] 之前的多余逗号
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // 配对大括号：缺右括号则在末尾补齐（容忍模型漏写闭合 }）
  const open = (s.match(/\{/g) || []).length;
  const close = (s.match(/\}/g) || []).length;
  if (open > close) s += '}'.repeat(open - close);

  return s;
}

// 末级兜底：从残缺 JSON 文本里用正则把 speech / emotion 抠出来。
function extractByRegex(text) {
  const speechMatch = text.match(/"speech"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|"\s*[a-zA-Z]|$)/);
  const speech = speechMatch
    ? speechMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim()
    : '';
  const emoMatch = text.match(/"emotion"\s*:\s*"(happy|wave)"/i);
  const emotion = emoMatch ? emoMatch[1].toLowerCase() : null;
  return {
    speech,
    emotion: EMOTION_WHITELIST.has(emotion) ? emotion : null,
  };
}

function toResult(obj) {
  if (obj && typeof obj.speech === 'string') {
    const speech = obj.speech.trim();
    if (speech) {
      const emotion =
        typeof obj.emotion === 'string' && EMOTION_WHITELIST.has(obj.emotion)
          ? obj.emotion
          : null;
      return { speech, emotion };
    }
    return { speech: '', emotion: null };
  }
  return { speech: JSON.stringify(obj), emotion: null };
}

// 将模型返回内容解析为 { speech, emotion }。四级容错
function parseModelReply(raw) {
  if (!raw) return { speech: '', emotion: null };
  const text = String(raw).trim();
  if (!text) return { speech: '', emotion: null };

  const strict = tryParseJson(text);
  if (strict) return toResult(strict);

  const repaired = repairJson(text);
  if (repaired) {
    const obj = tryParseJson(repaired);
    if (obj) return toResult(obj);
  }

  const heur = extractByRegex(text);
  if (heur.speech) return heur;

  if (text.startsWith('{')) return { speech: '', emotion: null };
  return { speech: text, emotion: null };
}

const { TOOL_DEFS, runTool } = require('../tools');

// 联网工具过滤：无 searchKey 时不暴露 web_search
function buildTools(searchKey) {
  if (!searchKey) {
    return TOOL_DEFS.filter((t) => t.function.name !== 'web_search');
  }
  return TOOL_DEFS;
}

// ── 意图预检：在 LLM 调用前根据关键词预判是否需要联网工具 ──
// 兼容不支持 function calling 的模型/端点：
//   时间/天气（direct=true）→ 后端调工具 → 直接格式化为 speech 返回，跳过 LLM
//   搜索（direct=false）    → 后端调工具 → 结果注入 system prompt，由 LLM 总结
// 返回 { direct: {speech, emotion} | null, injected: string[] | null }
const INTENT_PATTERNS = [
  { name: 'get_current_time', pattern: /几点|什么时间|现在几点|当前时间|日期|今天几号|星期几|现在什么时候/, direct: true },
  { name: 'get_weather', pattern: /天气|气温|温度|下雨|下雪|晴(?!朗)|阴天|湿度|风速|外面.*怎|冷不|热不|穿什么|带伞/, direct: true },
  { name: 'web_search', pattern: /搜[索一下]*|查[一一下]|新闻|最新.*消息|最近.*发生|热搜/, direct: false },
];

async function preflightTools(content, searchKey) {
  const text = content.trim();
  const matched = [];
  for (const intent of INTENT_PATTERNS) {
    if (intent.name === 'web_search' && !searchKey) continue;
    if (intent.pattern.test(text)) matched.push(intent);
  }
  if (matched.length === 0) return { direct: null, injected: null };

  console.log(`[aiReply] preflight matched tools: ${matched.map((m) => m.name).join(', ')}`);

  const allDirect = matched.every((m) => m.direct);
  const results = [];

  for (const intent of matched) {
    try {
      let args = {};
      if (intent.name === 'get_weather') {
        const cityMatch = text.match(/([\u4e00-\u9fa5]{2,5}(?:市|省|县|区|旗)?)/);
        if (cityMatch) args.location = cityMatch[1];
      }
      const result = await runTool(intent.name, args, { searchKey });
      console.log(`[aiReply] preflight ${intent.name} OK: ${result.slice(0, 80)}`);
      results.push(result);
    } catch (e) {
      const errText = `${intent.name} error: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[aiReply] preflight ${intent.name} ERR:`, e);
      results.push(errText);
    }
  }

  if (allDirect) {
    // direct 工具（时间/天气）：结果即答案，直接拼成 speech 返回，跳过 LLM 调用
    const combined = results.join('；');
    console.log(`[aiReply] preflight DIRECT RETURN (skip LLM): ${combined.slice(0, 60)}`);
    return { direct: { speech: combined, emotion: 'happy' }, injected: null };
  }

  // 非 direct 工具（如 search）：收集结果用于注入 system prompt
  return { direct: null, injected: results.map((r) => `[tool] ${r}`) };
}

// 系统提示模板
const SYSTEM_PROMPT_BASE = `你是一个友善、简洁的虚拟桌宠助手。
请只输出一个 JSON 对象（不要包含任何额外文字、不要使用 markdown 代码块），格式如下：
{"speech":"你对用户的口语化回复","emotion":"happy 或 wave 或 null"}
字段说明：
- speech：你对用户的口头回复，保持口语化、简洁；不要出现 JSON 或情绪标签字样。
- emotion：这轮回复表达的情绪/动作标签。
  - "happy"：回复表达开心、兴奋、赞同、被夸奖、送出好消息等正向情绪。
  - "wave"：回复用于打招呼、欢迎、告别、主动搭话。
  - 其他情况一律填 null。`;

// 带 tool 数据注入的系统提示（仅 web_search 等非 direct 工具命中时使用）
const SYSTEM_PROMPT_WITH_TOOLS = SYSTEM_PROMPT_BASE +
`\n以下是通过工具获取到的实时数据，请据此用口语化方式回答用户的问题（不要提及「工具」二字）：\n{{TOOL_RESULTS}}`;

// 普通 system prompt（无工具命中时，提示模型可用 function calling）
const SYSTEM_PROMPT_NORMAL = SYSTEM_PROMPT_BASE +
'\n如果用户询问实时信息（如当前时间、天气、最新新闻或需要联网检索的事实），你可以使用提供的工具获取最新数据，再据此组织口语化回复。';

const COMPLEXITY_RULES = [
  { pattern: /什么模型|哪个模型|由什么驱动|模型驱动|为什么|原理|分析|比较|区别|设计|实现/, timeout: 90000 },
  { pattern: /详细|具体|举例|步骤|代码|方案|如何接入|怎么实现/, timeout: 90000 },
];

function getRequestTimeout(content) {
  const matchedRule = COMPLEXITY_RULES.find((rule) => rule.pattern.test(content));
  if (matchedRule) return matchedRule.timeout;
  if (content.length > 120) return 90000;
  if (content.length > 40) return 60000;
  return 45000;
}

async function getReply({ aiContext, content = '', sessionId } = {}) {
  if (!aiContext || aiContext.closed || !aiContext.openai) {
    throw new Error('AI 连接上下文不可用');
  }

  if (!content.trim()) {
    throw new Error('消息不能为空');
  }

  const controller = new AbortController();
  const timeout = getRequestTimeout(content.trim());
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  aiContext.activeRequests.add(controller);

  try {
    // ── Step 1: 意图预检 ──
    //   时间/天气等 direct 工具 → 直接返回结果，跳过 LLM（兼容不支持 FC 的模型）
    //   搜索类非 direct 工具 → 收集结果用于后续注入 prompt
    const preflight = await preflightTools(content.trim(), aiContext.searchKey);

    // direct 命中：直接返回工具结果，不走 LLM
    if (preflight.direct) {
      console.log('[aiReply] returning direct tool result (skipped LLM)');
      return {
        speech: preflight.direct.speech,
        emotion: preflight.direct.emotion,
        action: 'idle',
        mood: 'curious',
        source: 'tool_direct',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
    }

    // ── Step 2: 构建 messages 并调用 LLM ──
    const recentMessages = await sessionManager.getRecentMessages(sessionId, 6);

    const systemPrompt = preflight.injected
      ? SYSTEM_PROMPT_WITH_TOOLS.replace('{{TOOL_RESULTS}}', preflight.injected.join('\n'))
      : SYSTEM_PROMPT_NORMAL;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentMessages,
      { role: 'user', content: content.trim() },
    ];

    const tools = buildTools(aiContext.searchKey);
    const toolChoice = tools.length ? 'auto' : undefined;

    // tool-call loop：模型可多次调用工具，直到产出最终文本
    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await aiContext.openai.chat.completions.create(
        {
          model: aiContext.model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: toolChoice,
          max_tokens: 800,
        },
        { signal: controller.signal },
      );

      const msg = completion.choices?.[0]?.message;
      if (!msg) throw new Error('模型返回为空');

      // 诊断日志
      console.log(
        `[aiReply] round=${round} finish_reason=${completion.choices?.[0]?.finish_reason} ` +
        `has_content=${!!msg.content} content_len=${(msg.content || '').length} ` +
        `tool_calls_count=${msg.tool_calls?.length || 0} ` +
        `tool_names=${(msg.tool_calls || []).map((t) => t.function?.name).join(',') || '(none)'}`,
      );
      if (msg.tool_calls?.length > 0) {
        console.log(`[aiReply] tool_calls detail:`, JSON.stringify(msg.tool_calls));
      }

      messages.push(msg);

      // 无工具调用 → 最终回复
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const rawContent = msg.content?.trim();
        if (!rawContent) throw new Error('模型返回内容为空');
        const { speech, emotion } = parseModelReply(rawContent);
        if (!speech) throw new Error('模型返回内容为空');
        return {
          speech,
          emotion,
          action: 'idle',
          mood: 'curious',
          source: 'model',
          model: completion.model,
          usage: completion.usage,
          sessionId,
          userid: aiContext.userid,
        };
      }

      // 有工具调用 → 执行并回灌
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
          result = await runTool(tc.function?.name, args, { searchKey: aiContext.searchKey });
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
      }
    }

    throw new Error('工具调用轮次过多，未能生成最终回复');
  } finally {
    clearTimeout(timeoutId);
    aiContext.activeRequests.delete(controller);
  }
}

module.exports = { getReply, getRequestTimeout };
