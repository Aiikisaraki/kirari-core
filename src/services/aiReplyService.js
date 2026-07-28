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
// 即使引号未闭合、结构破碎，只要含 "speech":"..." 就能捞出可读文案。
// 终止条件：遇到闭合引号后的 , } 结尾，或下一个键名（未闭合字符串时提前截止）。
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

// 把解析出的对象转成 { speech, emotion } 结果：
//  - 含 speech 字符串且非空 → 正常返回（emotion 走白名单）
//  - 含 speech 但为空 → 返回空 speech，让上层走规则兜底（不把空消息甩给用户）
//  - 根本无 speech 键（模型未按协议包裹，直接回了业务 JSON / 用户索要的 JSON）
//    → 把整对象序列化作为回复，避免把用户真正想要的 JSON 当残骸丢弃（误伤）
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

// 将模型返回内容解析为 { speech, emotion }。四级容错：
//   1) 严格 JSON.parse
//   2) 残缺修复（补括号 / 去尾逗号）后再次解析
//   3) 正则抠值（JSON 破碎但含 speech 字段）
//   4) 纯文本兜底（内容本就不是 JSON 时安全展示）
// 关键点：只要文本形似 JSON 却捞不出 speech，就返回空 speech 让上层走规则兜底，
// 绝不直接把 JSON 残骸当消息甩给用户；但若模型直接回了合法 JSON（用户索要的
// 配置等）则整体序列化展示，不会误伤。
function parseModelReply(raw) {
  if (!raw) return { speech: '', emotion: null };
  const text = String(raw).trim();
  if (!text) return { speech: '', emotion: null };

  // 1) 严格解析
  const strict = tryParseJson(text);
  if (strict) return toResult(strict);

  // 2) 残缺修复后解析
  const repaired = repairJson(text);
  if (repaired) {
    const obj = tryParseJson(repaired);
    if (obj) return toResult(obj);
  }

  // 3) 正则抠值
  const heur = extractByRegex(text);
  if (heur.speech) return heur;

  // 4) 兜底：形似 JSON 但完全捞不出 speech → 返回空，交给上层走 fallback；
  //    否则视为纯文本，安全展示给用户。
  if (text.startsWith('{')) return { speech: '', emotion: null };
  return { speech: text, emotion: null };
}

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
    const recentMessages = await sessionManager.getRecentMessages(sessionId, 6);
    const completion = await aiContext.openai.chat.completions.create(
      {
        model: aiContext.model,
        messages: [
          {
            role: 'system',
            content: `你是一个友善、简洁的虚拟桌宠助手。
请只输出一个 JSON 对象（不要包含任何额外文字、不要使用 markdown 代码块），格式如下：
{"speech":"你对用户的口语化回复","emotion":"happy 或 wave 或 null"}
字段说明：
- speech：你对用户的口头回复，保持口语化、简洁；不要出现 JSON 或情绪标签字样。
- emotion：这轮回复表达的情绪/动作标签。
  - "happy"：回复表达开心、兴奋、赞同、被夸奖、送出好消息等正向情绪。
  - "wave"：回复用于打招呼、欢迎、告别、主动搭话。
  - 其他情况一律填 null。`,
          },
          ...recentMessages,
          { role: 'user', content: content.trim() },
        ],
        max_tokens: 640,
      },
      { signal: controller.signal },
    );

    const rawContent = completion.choices?.[0]?.message?.content?.trim();
    if (!rawContent) throw new Error('模型返回内容为空');

    // 解析模型输出：期望 JSON {speech, emotion}，解析失败回退为纯文本。
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
  } finally {
    clearTimeout(timeoutId);
    aiContext.activeRequests.delete(controller);
  }
}

module.exports = { getReply, getRequestTimeout };
