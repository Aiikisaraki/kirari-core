// src/services/aiReplyService.js
// 门面层（facade）：原 aiReplyService 在 v0.5.x 是 1000+ 行的"上帝服务"。
// 现已拆分为：
//   - ./conversationService  对话主流程编排（getReply）
//   - ./reply/parser         模型回复解析（四级容错）
//   - ./reply/promptBuilder  人格基座 + 分支 system 提示 + 超时/历史归一化
//   - ./reply/intent         意图预检 + 工具前置 + 位置追问接续
//   - ./reply/streaming      LLM 流式调用封装 + 工具结果润色
// 本文件仅做转发，保持对外导出签名（getReply / getRequestTimeout / DEFAULT_PERSONA / buildBasePrompt）不变，
// 调用方（socketServer）无需任何改动。

const { getReply } = require('./conversationService');
const {
  DEFAULT_PERSONA,
  buildBasePrompt,
  getRequestTimeout,
} = require('./reply/promptBuilder');

module.exports = {
  getReply,
  getRequestTimeout,
  DEFAULT_PERSONA,
  buildBasePrompt,
};
