// src/knowledge/sources/UserMarkdownSource.js
// 兼容别名：用户私有知识库（Layer 1）现已统一由 DBKnowledgeSource 读取 knowledge_base 表。
// 保留此文件仅为向后兼容（旧清单若引用 type=user_markdown 不致崩），直接委托给 DBKnowledgeSource。
//
// 检索策略：关键词/标签 LIKE 匹配，零 embedding 依赖（见 DBKnowledgeSource）。

const DBKnowledgeSource = require('./DBKnowledgeSource');

module.exports = DBKnowledgeSource;
