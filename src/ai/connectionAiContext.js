const OpenAI = require('openai');
const apiTokenManager = require('../token/apiTokenManager');
const dbStorage = require('../db/dbStorage');

async function createConnectionAiContext(userid) {
  const tokenConfig = await apiTokenManager.getApiToken(userid);

  // 多模型：当前选中的模型套（地址/型号/密钥）优先于旧的单套配置。
  // 用户在控制台里加了多套并选了一套时，聊天就用那套 —— 搜索配置仍在旧档案里。
  // ⚠️ 校验必须在合并之后：全新部署可能只通过控制台加了模型套、从没写过旧档案，
  //    此时旧档案是空的，不能拿「旧档案没密钥」把人挡在门外。
  let active = null;
  try {
    const ac = await dbStorage.getActiveModelConfig(userid);
    if (ac && ac.key) {
      active = ac;
    }
  } catch (e) {
    console.warn('[aiContext] 读取当前模型套失败（回退旧配置）:', e?.message || e);
  }

  // 字段约定：模型套（新）是 endpoint / key（与桌面端一致）；旧档案 api_tokens 行仍是
  // api_endpoint / token（存储细节，apiTokenManager 原样返回）。
  const effModel = active?.model || tokenConfig?.model;
  const effEndpoint = active?.endpoint || tokenConfig?.api_endpoint;
  const effToken = active?.key || tokenConfig?.token;

  if (!effToken || !effEndpoint) {
    // 半配置（有密钥没地址 / 有地址没密钥）一律视为未配置，绝不静默套默认值
    throw new Error('还没配置大脑：先去控制台「大脑」里添加一套（服务地址 + 型号 + 钥匙）并设为当前');
  }

  if (!effModel) {
    throw new Error('还没配置大脑：模型型号没填，去控制台把这套大脑补上型号');
  }

  // 兼容用户把完整 /chat/completions 地址粘进「API 地址」字段的情况：
  // OpenAI SDK 会在 baseURL 之后自动追加 /chat/completions，若已包含则会出现
  // .../chat/completions/chat/completions 的重复路径，导致 404 或空响应。
  // 这里统一裁掉尾部 /chat/completions，只保留服务根（或 /v1）。
  let endpoint = String(effEndpoint).trim();
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
  // token 指纹：仅取前4+后4，便于用户在日志中核对「设置保存时写的 key」与「实际生效的 key」是否一致
  // （全链路对其他位置均为掩码，此处是唯一能把「保存日志」与「生效日志」对照起来的落点）。
  const tokenMask = effToken ? `${effToken.slice(0, 4)}***${effToken.slice(-4)}` : '(空)';
  console.log(`[aiContext] 创建 AI 上下文 userid=${userid} model=${effModel} host=${host} token=${tokenMask}${active?.source ? ` 来源=${active.source}` : ''}`);

  // 搜索配置：统一走 getSearchConfig（控制台账号读 config.json，其他账号读旧档案）。
  // 搜索是渠道配置，不跟着模型套走 —— 与桌面端「搜索区独立」同一语义。
  const searchCfg = await dbStorage.getSearchConfig(userid);

  return {
    userid,
    model: effModel,
    searchProvider: searchCfg.searchProvider || 'uapis',
    searchKey: searchCfg.searchKey || '',
    searchEndpoint: searchCfg.searchEndpoint || '',
    openai: new OpenAI({
      apiKey: effToken,
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
