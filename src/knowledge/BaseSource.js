// src/knowledge/BaseSource.js
// 知识源抽象基类。所有具体源（MediaWiki、离线向量库、用户私有库…）继承此类，
// 实现 retrieve(query, opts) 返回 RetrievedPassage[]。
//
// 设计约定：
//  - 单个源的 retrieve 必须"容错"——任何网络/解析异常都应返回 [] 而非抛出，
//    上层（SourceRegistry.retrieveAcrossSources）已做兜底，但源自身也宜自愈。
//  - 检索不应有副作用，纯查询。

/**
 * @typedef {import('./types').KnowledgeSourceDef} KnowledgeSourceDef
 * @typedef {import('./types').RetrievedPassage} RetrievedPassage
 */

class BaseSource {
  /**
   * @param {KnowledgeSourceDef} def
   */
  constructor(def) {
    if (!def || !def.id) throw new Error('知识源定义缺少 id');
    this.def = def;
    this.id = def.id;
    this.name = def.name || def.id;
    this.type = def.type;
    this.auth = def.auth || 'none';
    this.enabled = def.enabled !== false;
    this.priority = typeof def.priority === 'number' ? def.priority : 100;
    this.tier = def.tier || 'A';
    this.domains = Array.isArray(def.domains) ? def.domains : [];
    this.options = def.options || {};
  }

  /** 源是否可用（registry 在检索前据此过滤） */
  isAvailable() {
    return this.enabled;
  }

  /**
   * 检索相关片段。子类必须实现。
   * @param {string} query
   * @param {Object} [opts]
   * @returns {Promise<RetrievedPassage[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async retrieve(query, opts) {
    throw new Error(`源 ${this.id} 未实现 retrieve()`);
  }
}

module.exports = BaseSource;
