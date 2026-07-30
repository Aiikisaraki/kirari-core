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

  return {
    userid,
    model: tokenConfig.model,
    searchProvider: tokenConfig.search_provider || 'uapis',
    searchKey: tokenConfig.search_key || '',
    searchEndpoint: tokenConfig.search_endpoint || '',
    openai: new OpenAI({
      apiKey: tokenConfig.token,
      baseURL: tokenConfig.api_endpoint,
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
