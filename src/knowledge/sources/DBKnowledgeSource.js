// src/knowledge/sources/DBKnowledgeSource.js
// 用户私人知识库（Layer 1，最高优先级）：从前端获取（请求携带 kbContext，或反向拉取）。
//
// 检索策略 v2：前端本地存储、本地检索（关键词 LIKE 匹配），后端通过以下两种方式之一拿到结果：
//  1. 主动携带：客户端（桌宠/机器人）发消息前在本地检索，把结果附到请求体 opts.kbContext。
//  2. 反向拉取：请求未携带时，后端通过 WS 向前端发 kb_request，前端本地检索并回 kb_response。
//
// 后端对私人知识库零存储、零状态；数据主权完全在前端本地文件。

const BaseSource = require('../BaseSource');
const { requestKnowledgeFromFrontend } = require('../../websocket/socketServer');

class DBKnowledgeSource extends BaseSource {
  /**
   * @param {string} query
   * @param {Object} [opts] 可携带 { kbContext: RetrievedPassage[], ws: WebSocket }
   * @returns {Promise<import('../types').RetrievedPassage[]>}
   */
  async retrieve(query, opts = {}) {
    // 1. 优先用请求携带的 kbContext（前端主动检索并附上）
    if (Array.isArray(opts.kbContext) && opts.kbContext.length > 0) {
      return opts.kbContext.map((p) => ({
        text: p.text || '',
        source: this.name,
        score: typeof p.score === 'number' ? p.score : 1,
        tier: this.tier,
        priority: this.priority,
      }));
    }
    // 2. fallback：请求未携带 → 通过 WS 反向向前端拉取（kb_request → kb_response）
    if (opts.ws) {
      try {
        const results = await requestKnowledgeFromFrontend(opts.ws, query, 3000);
        return results.map((r, i) => ({
          text: r.text || '',
          source: this.name,
          score: typeof r.score === 'number' ? r.score : 1 / (i + 1),
          tier: this.tier,
          priority: this.priority,
        }));
      } catch {
        return [];
      }
    }
    // 3. 无 kbContext 也无 ws → 旧客户端或异常，返回空（不阻塞推理）
    return [];
  }
}

module.exports = DBKnowledgeSource;
