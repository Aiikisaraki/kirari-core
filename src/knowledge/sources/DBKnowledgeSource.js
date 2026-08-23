// src/knowledge/sources/DBKnowledgeSource.js
// 用户私有知识库（Layer 1，最高优先级）：读取 dbStorage.knowledge_base（按 userid 隔离）。
//
// 检索策略 v1：关键词/标签 LIKE 匹配（sqlite，个人库规模下足够快、零 embedding 依赖）。
// 后续可升级为向量检索（复用 LocalVectorSource 的 embedding 管线，索引建在用户自己资料上）。
//
// 数据来自前端"知识库"设置页录入（POST /api/knowledge），主权完全在用户自己。

const BaseSource = require('../BaseSource');
const dbStorage = require('../../db/dbStorage');

class DBKnowledgeSource extends BaseSource {
  /**
   * @param {string} query
   * @param {Object} [opts] 可携带 { userid } 以按用户隔离私有知识
   * @returns {Promise<import('../types').RetrievedPassage[]>}
   */
  async retrieve(query, opts = {}) {
    const userid = opts?.userid;
    if (!userid) return [];
    try {
      const rows = await dbStorage.searchKnowledgeEntries(userid, query, 5);
      if (!rows || !rows.length) return [];
      return rows.map((r, i) => ({
        text: `【${r.title}】${r.content}`,
        source: this.name,
        // 越靠前越相关（search 已按写入顺序，私有库小，排序权重其次）
        score: 1 / (i + 1),
        tier: this.tier,
        priority: this.priority,
      }));
    } catch {
      return [];
    }
  }
}

module.exports = DBKnowledgeSource;
