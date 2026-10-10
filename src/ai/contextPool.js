// src/ai/contextPool.js
// AI 上下文池：按 uid 复用 AI 上下文。
//
// 为什么需要：
//   原来的实现把上下文挂在 WebSocket 连接上（每条连接一个），进程重启或客户端
//   断开就没了。机器人走 HTTP 接入时没有「连接」这个概念，如果不复用，
//   每收一条消息都要新建 OpenAI 客户端 + 重新读一遍配置，既慢又没必要。
//
// 复用带来的副作用是「改了模型配置不会立刻生效」，所以提供 invalidate()
//   供配置变更后主动清缓存（见 routes 的 /api-token 相关接口）。
//
// 上下文本身持有 activeRequests（用于统一取消），并发调用同一个 uid 的上下文是安全的：
// OpenAI 客户端无状态，activeRequests 是 Set，天然支持并发。

const { createConnectionAiContext, cleanupConnectionAiContext } = require("./connectionAiContext");

/** uid → AiContext */
const pool = new Map();

/** 单个上下文的空闲存活时间：超过这个时间没人用就释放，避免长期占着不必要资源。 */
const IDLE_TTL_MS = Number(process.env.AI_CONTEXT_IDLE_TTL_MS || 30 * 60 * 1000);

/** uid → 最后使用时间戳 */
const lastUsed = new Map();

/**
 * 取得（必要时创建）某 uid 的 AI 上下文。
 * @throws 配置缺失（未填模型地址/型号/密钥）时抛出，错误文案已可展示给用户
 */
async function getContext(uid) {
  lastUsed.set(uid, Date.now());
  const existing = pool.get(uid);
  if (existing && !existing.closed) {
    return existing;
  }
  const ctx = await createConnectionAiContext(uid);
  pool.set(uid, ctx);
  console.log(`[ctxPool] 已创建 AI 上下文 uid=${uid}（当前共 ${pool.size} 个）`);
  return ctx;
}

/** 主动失效某 uid 的上下文（配置改了调用，下次会重建） */
function invalidate(uid) {
  const ctx = pool.get(uid);
  if (!ctx) return false;
  cleanupConnectionAiContext(ctx);
  pool.delete(uid);
  lastUsed.delete(uid);
  console.log(`[ctxPool] 已失效 AI 上下文 uid=${uid}`);
  return true;
}

/** 清空全部（进程退出时调用） */
function invalidateAll() {
  for (const ctx of pool.values()) {
    cleanupConnectionAiContext(ctx);
  }
  pool.clear();
  lastUsed.clear();
}

/**
 * 空闲回收：定时把超过 TTL 没人用的上下文释放掉。
 * 由 app 启动时调用一次即可，返回定时器句柄（测试可用 unref 停掉）。
 */
function startIdleSweeper(intervalMs = 60000) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [uid, ts] of lastUsed.entries()) {
      if (now - ts > IDLE_TTL_MS) invalidate(uid);
    }
  }, intervalMs);
  // 不要因为这个定时器阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  getContext,
  invalidate,
  invalidateAll,
  startIdleSweeper,
  poolSize: () => pool.size,
};
