// src/tools/bridge.js
// 前端托管工具桥：在单个 WS 连接上管理「后端请求 → 前端（Electron 主进程）执行 → 结果回传」的配对。
// 模型命中 frontend__ 前缀的工具时，后端无法本地执行，须经 WS 回调解前端，这里负责调用/响应配对与超时。

const WebSocket = require('ws');

// 为某个 ws 连接创建工具桥。返回：
//  - invokeFrontendTool(name, args)：发 tool_invoke 给前端并等待 tool_result（30s 超时）
//  - handleToolResult(message)：处理前端回传的 tool_result（由 socketServer 在收到该类型消息时调用）
//  - clearPending(reason)：连接关闭/出错时拒绝所有挂起调用，避免 Promise 永久挂起
function createFrontendToolBridge(ws) {
  const pendingToolCalls = new Map();

  function invokeFrontendTool(name, args) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WS 连接已断开，无法调用前端工具'));
      }
      const callId =
        'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        pendingToolCalls.delete(callId);
        reject(new Error(`前端工具调用超时（30s 未收到结果）：${name}`));
      }, 30000);
      pendingToolCalls.set(callId, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          type: 'tool_invoke',
          call_id: callId,
          name,
          args,
        }),
      );
    });
  }

  function handleToolResult(message) {
    const callId = message.call_id;
    const pending = pendingToolCalls.get(callId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingToolCalls.delete(callId);
    const content =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
    pending.resolve(content);
    return true;
  }

  function clearPending(reason) {
    for (const [, pending] of pendingToolCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    pendingToolCalls.clear();
  }

  return { invokeFrontendTool, handleToolResult, clearPending, pendingToolCalls };
}

module.exports = { createFrontendToolBridge };
