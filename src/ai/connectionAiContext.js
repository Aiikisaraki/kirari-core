const OpenAI = require('openai');
const apiTokenManager = require('../token/apiTokenManager');

async function createConnectionAiContext(userid) {
  const tokenConfig = await apiTokenManager.getApiToken(userid);

  if (!tokenConfig?.token) {
    throw new Error('用户尚未配置 API Token');
  }

  if (!tokenConfig.model) {
    throw new Error('模型名称未配置');
  }

  if (!tokenConfig.api_endpoint) {
    throw new Error('API Endpoint 未配置');
  }

  // 兼容用户把完整 /chat/completions 地址粘进「API 地址」字段的情况：
  // OpenAI SDK 会在 baseURL 之后自动追加 /chat/completions，若已包含则会出现
  // .../chat/completions/chat/completions 的重复路径，导致 404 或空响应。
  // 这里统一裁掉尾部 /chat/completions，只保留服务根（或 /v1）。
  let endpoint = String(tokenConfig.api_endpoint).trim();
  if (endpoint.endsWith('/chat/completions')) {
    endpoint = endpoint.slice(0, -'/chat/completions'.length);
    console.warn('[aiContext] 检测到 endpoint 以 /chat/completions 结尾，已自动裁掉（SDK 会自动补回）');
  }
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {
    /* 非合法 URL 时保留原值，交给后续校验 */
  }
  console.log(`[aiContext] 创建 AI 上下文 userid=${userid} model=${tokenConfig.model} host=${host}`);

  return {
    userid,
    model: tokenConfig.model,
    searchProvider: tokenConfig.search_provider || 'uapis',
    searchKey: tokenConfig.search_key || '',
    searchEndpoint: tokenConfig.search_endpoint || '',
    openai: new OpenAI({
      apiKey: tokenConfig.token,
      baseURL: endpoint,
      timeout: 60000,
      maxRetries: 0,
    }),
    activeRequests: new Set(),
    closed: false,
  };
}

function cleanupConnectionAiContext(context) {
  if (!context || context.closed) return;

  context.closed = true;
  for (const controller of context.activeRequests) {
    controller.abort();
  }
  context.activeRequests.clear();
  context.openai = null;
}

module.exports = {
  createConnectionAiContext,
  cleanupConnectionAiContext,
};
