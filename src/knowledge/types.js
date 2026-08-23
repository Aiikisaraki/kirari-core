// src/knowledge/types.js
// 知识源相关的类型定义（JSDoc）与常量。
// 后端为 CommonJS JavaScript（"type": "commonjs"），故用 JSDoc 表达类型，不引入 TS 编译链。

/** 鉴权模式：none=免注册可直接调用；required=需用户自备凭据（仅可选启用，项目绝不依赖） */
const AUTH_MODE = {
  NONE: 'none',
  REQUIRED: 'required',
};

/** 分层（按"是否需要注册 / 分发友好度"）：
 *  A = 免注册实时 API（开箱即用）
 *  B = 离线植入索引（维护者预构建随包分发，一致体验核心）
 *  C = 需注册可选（用户自行配置凭据后启用） */
const TIER = {
  A: 'A',
  B: 'B',
  C: 'C',
};

/** 源类型 → 适配器类映射键（见 SourceRegistry.ADAPTERS） */
const SOURCE_TYPE = {
  MEDIAWIKI_API: 'mediawiki_api',
  LOCAL_VECTOR_INDEX: 'local_vector_index',
  USER_MARKDOWN: 'user_markdown',
  USER_KNOWLEDGE_DB: 'user_knowledge_db',
  REST_API: 'rest_api',
};

/**
 * 知识源声明（来自 defaultSources.json 或用户覆盖）。
 * @typedef {Object} KnowledgeSourceDef
 * @property {string} id                唯一 id（覆盖/禁用均以 id 为键）
 * @property {string} name              展示名
 * @property {string} type              SOURCE_TYPE 之一
 * @property {string} [endpoint]        API 类源的接入点
 * @property {string} [path]            离线索引/文件的本地路径
 * @property {'none'|'required'} auth   鉴权模式
 * @property {boolean} [enabled]        是否启用（默认 true）
 * @property {number} [priority]        数值越小优先级越高（检索排序与权重用）
 * @property {'A'|'B'|'C'} [tier]       分层
 * @property {string[]} [domains]       覆盖的领域标签（acgn/game/science/history/art/cs/medicine/nature/general...）
 * @property {Object} [options]         适配器私有参数（如 limit）
 */

/**
 * 单条检索结果片段。
 * @typedef {Object} RetrievedPassage
 * @property {string} text              片段正文（纯文本）
 * @property {string} [source]          来源源名称或 id
 * @property {number} [score]           相关度评分（0~1）
 * @property {string} [url]             原文链接（可选）
 * @property {'A'|'B'|'C'} [tier]       来源分层
 * @property {number} [priority]        来源优先级
 */

module.exports = { AUTH_MODE, TIER, SOURCE_TYPE };
