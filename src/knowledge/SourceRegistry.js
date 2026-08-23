// src/knowledge/SourceRegistry.js
// 知识源注册表：加载声明式清单（默认随包 + 用户覆盖），实例化已启用源，
// 提供跨源检索入口 retrieveAcrossSources。这是"可插拔数据源"的核心。
//
// 借鉴现有 tools/index.js 的「注册表 + dispatcher」范式：源以声明式清单描述，
// 按 type 映射适配器类；检索时并行跑所有可用源，合并/去重/截断为 top-k。

const fs = require('fs');
const path = require('path');
const { SOURCE_TYPE } = require('./types');
const MediaWikiSource = require('./sources/MediaWikiSource');
const LocalVectorSource = require('./sources/LocalVectorSource');
const UserMarkdownSource = require('./sources/UserMarkdownSource');
const DBKnowledgeSource = require('./sources/DBKnowledgeSource');
const RestApiSource = require('./sources/RestApiSource');

// 源类型 → 适配器类
const ADAPTERS = {
  [SOURCE_TYPE.MEDIAWIKI_API]: MediaWikiSource,
  [SOURCE_TYPE.LOCAL_VECTOR_INDEX]: LocalVectorSource,
  [SOURCE_TYPE.USER_MARKDOWN]: UserMarkdownSource,
  [SOURCE_TYPE.USER_KNOWLEDGE_DB]: DBKnowledgeSource,
  [SOURCE_TYPE.REST_API]: RestApiSource,
};

// 默认清单（随包，零配置，全部 auth:none）
const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'defaultSources.json');

class SourceRegistry {
  constructor() {
    /** @type {import('./types').KnowledgeSourceDef[]} */
    this.defs = [];
    /** @type {BaseSource[]} */
    this.instances = [];
    this._loaded = false;
  }

  /**
   * 加载默认清单 + 用户覆盖（用户覆盖预留接口，当前由调用方传入 {}）。
   * @param {Object<string, Partial<import('./types').KnowledgeSourceDef>>} [userOverrides]
   */
  load(userOverrides = {}) {
    let defs = [];
    try {
      const raw = fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8');
      defs = JSON.parse(raw)?.sources || [];
    } catch (e) {
      console.warn('[kb] 默认知识源清单读取失败：', e?.message || e);
      defs = [];
    }

    // 合并用户覆盖（按 id；覆盖可改 enabled/auth/endpoint 等）
    const byId = new Map();
    for (const d of defs) byId.set(d.id, { ...d });
    for (const [id, patch] of Object.entries(userOverrides || {})) {
      byId.set(id, { ...(byId.get(id) || { id }), ...patch });
    }
    this.defs = [...byId.values()];

    // 实例化已启用且类型已知的源（实例化失败不致命，跳过）
    this.instances = this.defs
      .filter((d) => d.enabled !== false && ADAPTERS[d.type])
      .map((d) => {
        try {
          return new (ADAPTERS[d.type])(d);
        } catch (e) {
          console.warn(`[kb] 源 ${d.id} 实例化失败：`, e?.message || e);
          return null;
        }
      })
      .filter(Boolean);
    this._loaded = true;
    return this;
  }

  /** 懒加载单例帮助方法 */
  ensureLoaded() {
    if (!this._loaded) this.load();
    return this;
  }

  /** 列出全部声明的源（供设置页渲染/开关） */
  listSources() {
    return this.defs.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      auth: d.auth,
      enabled: d.enabled !== false,
      tier: d.tier,
      domains: d.domains || [],
    }));
  }

  /**
   * 跨所有已启用源并行检索，合并 + 去重 + 截断，返回 top-k 片段。
   * @param {string} query
   * @param {Object} [opts] { topK, maxChars, domains }
   * @returns {Promise<import('./types').RetrievedPassage[]>}
   */
  async retrieveAcrossSources(query, opts = {}) {
    this.ensureLoaded();
    const topK = opts.topK || 5;
    const maxChars = opts.maxChars || 1200;
    const domainFilter = Array.isArray(opts.domains) && opts.domains.length ? opts.domains : null;

    const candidates = this.instances.filter(
      (s) =>
        s.isAvailable() &&
        (!domainFilter || s.domains.length === 0 || s.domains.some((d) => domainFilter.includes(d))),
    );
    if (!candidates.length) return [];

    const results = await Promise.all(
      candidates.map((s) => s.retrieve(query, opts).catch(() => [])),
    );
    let flat = results.flat();

    // 去重（按文本前缀近似；骨架用精确去重，后续可升级语义去重）
    const seen = new Set();
    flat = flat.filter((p) => {
      const key = (p.text || '').slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 排序：分数降序，其次源优先级升序
    flat.sort(
      (a, b) => (b.score || 0) - (a.score || 0) || (a.priority || 100) - (b.priority || 100),
    );

    // 截断到 maxChars（保证注入不撑爆上下文）
    const out = [];
    let used = 0;
    for (const p of flat) {
      if (out.length >= topK) break;
      const len = (p.text || '').length;
      if (used + len > maxChars && out.length > 0) break;
      out.push(p);
      used += len;
    }
    return out;
  }
}

// 单例（进程内共享，避免重复实例化/重复读清单）
let _singleton = null;
function getRegistry() {
  if (!_singleton) _singleton = new SourceRegistry().load();
  return _singleton;
}

module.exports = { SourceRegistry, getRegistry, ADAPTERS };
