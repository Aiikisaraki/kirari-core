// src/capabilities/registry.js
// 阶段 D：统一能力注册表（核心版侧）。
//
// 唯一真相源：所有功能（内置工具 / MCP / 技能工具 / 前端托管工具）都从这张表
// 列举 schema、选执行器、走统一的超时与截断流水线。新增一个内置能力 = 在
// builtin/ 下加一个导出 { capability, dispatch } 的文件，目录自动扫描，不碰其它文件。
//
// 纯逻辑契约来自共享包 kirari-agent（CapabilityRegistry / defineCapability /
// toOpenAITool / truncateResult / scopeKey）；本文件只做「把执行器与能力绑起来」
// 的胶水 + 超时竞速，DB / WS / 模型客户端仍由两端各自注入。

const fs = require('fs');
const path = require('path');
const {
  CapabilityRegistry,
  defineCapability,
  toOpenAITool,
  truncateResult,
  scopeKey,
  DEFAULT_CAPABILITY_TIMEOUT_MS,
} = require('kirari-agent');

// 单一实例（进程级）。真正的隔离靠 scopeId 分桶，而不是「禁止单例」——
// builtin/global 本就该全局共享，connection 级工具按调用方分桶互不覆盖。
const registry = new CapabilityRegistry();

// capability.id → dispatch(args, ctx) 执行器（builtin + global；connection 级另存）
const executorById = new Map();
// scopeId → (name → executor) —— 前端托管工具按连接隔离的执行器
const connectionExecutors = new Map();

let builtinLoaded = false;

/**
 * 扫描 builtin/ 目录，加载每个导出 { capability, dispatch } 的文件并注册。
 * 文件内部的 defineCapability 自带 schema/timeout/truncate/tags，dispatch 是执行函数。
 * 新增能力只要加一个文件 —— 这就是「只改一个文件」的落点。
 */
function loadBuiltin() {
  if (builtinLoaded) return;
  builtinLoaded = true;
  const dir = path.join(__dirname, 'builtin');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      const cap = mod.capability;
      if (!cap || typeof cap.id !== 'string') {
        console.warn(`[capabilities] 跳过 ${file}：未导出合法 capability`);
        continue;
      }
      registry.register(cap);
      if (typeof mod.dispatch === 'function') executorById.set(cap.id, mod.dispatch);
    } catch (e) {
      // 单个能力加载失败不能拖垮整个注册表（警惕但不致命）。
      console.warn(`[capabilities] 加载 ${file} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 注册一批全局能力（核心版自执行的 MCP / 技能工具，配置驱动，所有 scope 可见）。 */
function registerGlobal(tools) {
  let n = 0;
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== 'string' || !t.name.trim() || typeof t.execute !== 'function') continue;
    const id = t.name; // mcp__ / skill__ 前缀由注册方保证
    const cap = defineCapability({
      id,
      name: t.name,
      kind: 'tool',
      scope: 'global',
      description: String(t.description || '').slice(0, 500) || id,
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
      ...(t.truncateChars ? { truncateChars: t.truncateChars } : {}),
    });
    registry.register(cap);
    executorById.set(id, t.execute);
    n++;
  }
  return n;
}

/**
 * 按连接注册前端托管工具（MCP/技能由 Electron 主进程执行）。
 * 关键不同：schema 与执行器都挂在 scopeId 上，A 连接注册的工具不会出现在 B 连接，
 * 彻底消除过去 setFrontendTools 全局整表覆盖导致的串线。
 * @param {string} scopeId 连接作用域 id
 * @param {Array} tools 前端上报的工具 schema（{ function: { name, ... } }）
 * @param {(name:string,args:any)=>Promise<string>} executor 该连接的前端执行器
 */
function registerConnection(scopeId, tools, executor) {
  const key = String(scopeId || 'anonymous');
  // 前端 register_tools 是整表覆盖语义：同一 scope 重复注册时先清掉旧桶，
  // 避免删掉的工具残留在注册表里。registry.unregisterScope 只清 connection 桶，
  // 不影响 builtin/global。
  registry.unregisterScope(key);
  const nameExec = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || !t.function || typeof t.function.name !== 'string') continue;
    const name = t.function.name;
    const id = `${key}::${name}`;
    let cap;
    try {
      cap = defineCapability({
        id,
        name,
        kind: 'tool',
        scope: 'connection',
        description: String(t.function.description || '').slice(0, 500) || name,
        ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
        // 前端工具走 WS/进程内桥，30s 超时；结果统一截断 4000（共享包默认）。
      });
    } catch (e) {
      console.warn(`[capabilities] 前端工具 ${name} schema 非法，跳过：${e.message}`);
      continue;
    }
    registry.registerFor(key, cap);
    // 绑定工具名：外部执行器是 (name, args) 形态（即 invokeFrontendTool），
    // 这里包成统一的 (args, ctx) 形态，供 dispatch 流水线一致调用。
    if (typeof executor === 'function') nameExec.set(name, (args) => executor(name, args));
  }
  connectionExecutors.set(key, nameExec);
  return nameExec.size;
}

/** 连接关闭时整桶清理，避免能力残留到下一个连接。 */
function unregisterConnection(scopeId) {
  const key = String(scopeId || 'anonymous');
  registry.unregisterScope(key);
  connectionExecutors.delete(key);
}

/** 列出该 scope 可见的全部工具 schema（OpenAI function 形态），供模型 function-calling。 */
function listTools(scopeId, opts) {
  loadBuiltin();
  return registry.list(String(scopeId || 'anonymous'), opts).map(toOpenAITool);
}

/** 该 scope 是否可见某个名字的工具（替换旧 getFrontendToolNames + runTool 分流）。 */
function has(scopeId, name) {
  loadBuiltin();
  return registry.has(String(scopeId || 'anonymous'), name);
}

/** 按 name 取能力描述（含 scope/timeout/truncate），供 dispatch 与事件记录。 */
function resolve(scopeId, name) {
  loadBuiltin();
  return registry.resolve(String(scopeId || 'anonymous'), name);
}

async function withTimeout(promise, timeoutMs, name) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`能力调用超时（${timeoutMs}ms）：${name}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 统一执行流水线：resolve → 选执行器 → 超时 → 截断。
 * 返回 { content, isError, capability }，由调用方回灌模型并记事件。
 * 任何执行异常都转成 isError 结果，不冒泡打断对话循环（与旧 runTool 语义一致）。
 */
async function dispatch(scopeId, name, args, ctx = {}) {
  loadBuiltin();
  const key = String(scopeId || 'anonymous');
  const cap = registry.resolve(key, name);
  if (!cap) return { content: `未知工具：${name}`, isError: true, capability: null };

  // 选执行器：connection 优先（按 scope 分桶），其次 builtin/global 的 id 执行器。
  let executor;
  if (cap.scope === 'connection') {
    executor =
      connectionExecutors.get(key)?.get(name) ||
      (typeof ctx.invokeFrontendTool === 'function'
        ? (args) => ctx.invokeFrontendTool(name, args)
        : undefined);
  } else {
    executor = executorById.get(cap.id);
  }
  if (typeof executor !== 'function')
    return { content: `error: 能力 ${name} 无可用执行器`, isError: true, capability: cap };

  const timeoutMs = cap.timeoutMs || DEFAULT_CAPABILITY_TIMEOUT_MS;
  try {
    const raw = await withTimeout(Promise.resolve(executor(args || {}, ctx || {})), timeoutMs, name);
    const content = truncateResult(String(raw), cap.truncateChars);
    return { content, isError: false, capability: cap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: truncateResult(`error: ${msg}`, cap.truncateChars),
      isError: true,
      capability: cap,
    };
  }
}

module.exports = {
  registry,
  loadBuiltin,
  registerGlobal,
  registerConnection,
  unregisterConnection,
  listTools,
  has,
  resolve,
  dispatch,
  scopeKey,
};
