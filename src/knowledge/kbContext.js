// src/knowledge/kbContext.js
// 私人知识库「随请求携带」的入口净化。
//
// 背景：私人知识库存在**客户端本地**（数据主权在用户），后端零存储。
// 客户端发消息前先在本地检索好，把结果附到请求上（WS 的 kbContext 字段、
// HTTP 的 body.kbContext、组网的 relay_request.kbContext），后端把它当
// Layer 1 最高优先级参考注入提示词。
//
// 为什么必须净化：这是**调用方发来的内容**，会被拼进提示词。
// 不设上限的话，一个异常调用方就能用超大 kbContext 把上下文窗口撑爆、把额度烧光。
// WS 那条路目前只判了「是不是数组」，这里给出统一的口径，HTTP 与组网共用。

/** 单条片段正文上限（字符）。超长截断比照单全收诚实 —— 提示词空间有限。 */
const PASSAGE_MAX_CHARS = 2000;
/** 一条请求最多带几条片段（与叶子端本地检索的 top 5 对齐） */
const PASSAGE_MAX_COUNT = 5;

/**
 * 收敛调用方带来的知识片段。
 * @param {unknown} input 期望是 [{ text, source?, url?, score? }]
 * @returns {Array<{text:string, source?:string, url?:string, score?:number}> | null}
 *   没有可用片段时返回 null（与「未携带」同义，不要返回空数组让下游误判）。
 */
function sanitizeKbContext(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, PASSAGE_MAX_CHARS) : '';
    if (!text) continue;
    out.push({
      text,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 80) : undefined,
      url: typeof raw.url === 'string' ? raw.url.slice(0, 500) : undefined,
      score: typeof raw.score === 'number' && raw.score >= 0 && raw.score <= 1 ? raw.score : undefined,
    });
    if (out.length >= PASSAGE_MAX_COUNT) break;
  }
  return out.length ? out : null;
}

module.exports = { sanitizeKbContext, PASSAGE_MAX_CHARS, PASSAGE_MAX_COUNT };
