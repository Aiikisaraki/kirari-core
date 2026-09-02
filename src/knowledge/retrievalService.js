// src/knowledge/retrievalService.js
// 知识检索编排：把"跨源检索结果"格式化为可注入 system prompt 的参考块。
// 被 conversationService 在构建消息前调用。
//
// 优先级遵循整体架构：
//   Layer 1 私有知识库（用户主权）> Layer 2 推荐源（离线植入 > 免注册实时）> Layer 3 联网搜索兜底
// 本服务只负责 Layer 2 的"推荐源"检索与格式化；Layer 1（UserMarkdownSource）启用后自然排在最高。

const { getRegistry } = require('./SourceRegistry');

/**
 * 检索并格式化为提示词片段。失败/无结果返回空串,绝不阻塞主对话。
 * @param {Object} aiContext 含 userid（用于 Layer1 私有知识隔离）
 * @param {string} query
 * @param {Object} [opts] { topK, maxChars, domains, kbContext, ws }
 * @returns {Promise<string>}
 */
async function retrieveForPrompt(aiContext, query, opts = {}) {
  if (!query || !query.trim()) return '';
  try {
    const registry = getRegistry();
    const passages = await registry.retrieveAcrossSources(query, {
      topK: opts.topK || 5,
      maxChars: opts.maxChars || 1200,
      domains: opts.domains,
      // 透传 userid：私有知识库（DBKnowledgeSource）据此按用户隔离检索。
      userid: aiContext?.userid,
      // 透传前端携带的 kbContext 和 ws（DBKnowledgeSource 用于主动携带/反向拉取）
      kbContext: opts.kbContext,
      ws: opts.ws,
    });
    if (!passages.length) return '';

    const lines = passages.map((p) => `- （来源：${p.source || '知识库'}${p.url ? ` ${p.url}` : ''}）${p.text}`);
    return (
      '\n\n【知识库 · 检索到的参考信息】\n' +
      '（仅供作答参考，以你自身知识为准；若与你的知识冲突，或你不确定具体事实，可用工具核实）\n' +
      lines.join('\n')
    );
  } catch (e) {
    console.warn('[kb] 检索失败：', e?.message || e);
    return '';
  }
}

module.exports = { retrieveForPrompt };
