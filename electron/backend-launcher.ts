// electron/backend-launcher.ts
// 本地模式（单机打包版）后端 API 子进程管理器。
// 职责：把 pet-api（Node 服务）作为子进程拉起；关闭前端时同步终止。
// dev 模式（VITE_DEV_SERVER_URL）与 remote 模式不启动本地后端，沿用既有行为。
import { spawn, execSync, type ChildProcess } from "child_process";
import { app } from "electron";
import fs from "fs";
import path from "path";

// 固定端口，需与前端 local 模式（pet-client.config / DEFAULT_LOCAL）及后端严格监听端口一致。
export const BACKEND_PORT = 9089;

// 与后端 routes.js / backendEnv 保持一致的本地内置账户令牌。
// 安装向导写入的 config.json 正是用它注入到 /api/profile。
const BUILTIN_TOKEN = process.env.BUILTIN_ACCOUNT_TOKEN || "kirari-local-builtin";

let child: ChildProcess | null = null;

function isDev(): boolean {
  return !!process.env.VITE_DEV_SERVER_URL;
}

// 打包版后端位于 resources/pet-api；dev 不调用本函数（startBackendIfLocal 已早退）。
function resolveBackendDir(): string {
  const resourcesPath = (process as unknown as { resourcesPath: string }).resourcesPath;
  return path.join(resourcesPath, "pet-api");
}

// Node 运行时选择：优先使用打包进 pet-api/runtime 的 node（自包含，无需用户装机有 Node），
// 缺失时回退系统 PATH 的 node（要求目标机已安装匹配 ABI 的 Node）。
function resolveNodeBin(backendDir: string): string | null {
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  const bundled = path.join(backendDir, "runtime", runtimeName);
  if (!isDev() && fs.existsSync(bundled)) return bundled;
  // 回退：检查系统 PATH 中是否有 node
  try {
    const systemNode = execSync(`${runtimeName} --version`, { encoding: "utf-8", windowsHide: true }).trim();
    if (systemNode) return runtimeName;
  } catch {
    // 系统没有 node
  }
  return null;
}

// 注入运行所需环境变量，等价于后端 .env，避免安装包依赖外部 .env 文件存在性。
// 若外层已设置（如打包机 CI 注入）则尊重外部值。
function backendEnv(): NodeJS.ProcessEnv {
  // 数据库目录外置到用户目录：每台机器独立、可写、且不进安装包（避免泄露开发者自己的 token/库）。
  const dataDir = path.join(app.getPath("userData"), "pet-api-data");
  return {
    ...process.env,
    PORT: String(BACKEND_PORT),
    STORAGE_TYPE: process.env.STORAGE_TYPE || "db",
    MODEL_API_ENDPOINT: process.env.MODEL_API_ENDPOINT || "https://api.chatanywhere.tech/v1",
    BUILTIN_ACCOUNT_TOKEN: process.env.BUILTIN_ACCOUNT_TOKEN || "kirari-local-builtin",
    SESSION_SECRET: process.env.SESSION_SECRET || "kirari-dev-session-secret",
    PET_API_DATA_DIR: dataDir,
    NODE_ENV: "production",
  };
}

// 轮询后端 /health，直到就绪或超时。不阻塞主流程太久。
async function waitForHealth(timeoutMs = 15000): Promise<{ ok: boolean; reason?: string }> {
  const url = `http://localhost:${BACKEND_PORT}/health`;
  const start = Date.now();
  let lastError: string | undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log("[backend] 健康检查通过");
        return { ok: true };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[backend] 健康检查超时 (${timeoutMs}ms)，最后错误: ${lastError}`);
  return { ok: false, reason: lastError };
}

// 把 userData/config.json（用户级可编辑配置文件）的模型配置同步到后端 DB。
// config.json 是「权威配置」：仅以其中「非空」的字段覆盖后端，空字段不触碰后端现有值。
// 既用于首次启动播种，也用于用户（设置界面或外部编辑器）修改 config.json 后的实时同步。
export async function applyConfigToBackend(): Promise<void> {
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    if (!fs.existsSync(cfgPath)) {
      console.log("[backend] 未找到模型配置（config.json），跳过同步");
      return;
    }
    let cfg: { endpoint?: string; model?: string; key?: string };
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch {
      console.warn("[backend] config.json 解析失败，跳过同步");
      return;
    }
    const endpoint = typeof cfg.endpoint === "string" ? cfg.endpoint.trim() : "";
    const model = typeof cfg.model === "string" ? cfg.model.trim() : "";
    const key = typeof cfg.key === "string" ? cfg.key.trim() : "";
    if (!endpoint && !model && !key) {
      console.log("[backend] config.json 未填写模型配置，跳过同步");
      return;
    }

    const headers = {
      "x-builtin-token": BUILTIN_TOKEN,
      "content-type": "application/json",
    };

    // 仅以 config.json 中的非空字段覆盖后端；空字段保持后端现状（config.json 为权威但不越界清零）。
    const patch: Record<string, string> = {};
    if (key) patch.token = key;
    if (model) patch.model = model;
    if (endpoint) patch.api_endpoint = endpoint;

    const res = await fetch(`http://localhost:${BACKEND_PORT}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      console.log(`[backend] 已将 config.json 同步到后端: ${Object.keys(patch).join(", ")}`);
    } else {
      console.warn(`[backend] config.json 同步到后端失败 HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(
      "[backend] 同步 config.json 到后端出错（可稍后在程序「设置」中手动配置）:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// 后端就绪后，把 config.json 的模型配置同步进后端 DB（config.json 为权威配置）。
async function seedBackendFromConfig(): Promise<void> {
  await applyConfigToBackend();
}

// 本地模式且非 dev 时自启动后端 API。返回时后端应已在监听（或已超时告警）。
export async function startBackendIfLocal(opts: { isLocal: boolean }): Promise<void> {
  if (!opts.isLocal) return; // 远程模式：连远程服务器，不启动本地后端
  if (isDev()) return; // dev：沿用独立运行的后端

  const backendDir = resolveBackendDir();
  const entryFile = path.join(backendDir, "server.js");

  // ---- 启动前校验关键文件 ----
  const checks: [string, string][] = [
    ["后端入口", entryFile],
    ["后端依赖", path.join(backendDir, "node_modules")],
    ["路由模块", path.join(backendDir, "src", "api", "routes.js")],
    ["WebSocket 模块", path.join(backendDir, "src", "websocket", "socketServer.js")],
  ];
  for (const [label, p] of checks) {
    if (!fs.existsSync(p)) {
      console.error(`[backend] 缺少${label}: ${p}`);
      console.error("[backend] 后端文件不完整，跳过自启动。安装包可能损坏或 extraResources 未正确打包。");
      return;
    }
  }

  const nodeBin = resolveNodeBin(backendDir);
  if (!nodeBin) {
    console.error("[backend] 未找到 Node 运行时（打包的 runtime/ 下没有 node.exe，系统中也没有安装 Node）。");
    console.error("[backend] 无法启动后端 API。");
    return;
  }

  console.log(`[backend] 后端将监听端口 ${BACKEND_PORT} | HTTP http://localhost:${BACKEND_PORT} | WS ws://localhost:${BACKEND_PORT}/ws`);
  console.log(`[backend] 准备启动: ${nodeBin} server.js (cwd=${backendDir})`);
  console.log(`[backend] 注入环境变量: PORT=${BACKEND_PORT} MODEL_API_ENDPOINT=${backendEnv().MODEL_API_ENDPOINT}`);

  // 用 pipe 捕获输出以便排查问题（之前 ignore 导致启动失败完全无日志）
  child = spawn(nodeBin, ["server.js"], {
    cwd: backendDir,
    env: backendEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // 捕获子进程输出用于调试
  child.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString("utf-8").trim();
    if (msg) console.log(`[backend:stdout] ${msg}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString("utf-8").trim();
    if (msg) console.error(`[backend:stderr] ${msg}`);
  });

  child.on("error", (e) => console.error("[backend] 子进程启动失败:", e.message));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.warn(`[backend] 子进程退出 code=${code} signal=${signal}`);
  });
  if (child.pid) console.log(`[backend] 已启动后端子进程 pid=${child.pid}`);

  const health = await waitForHealth();
  if (!health.ok) {
    console.error(`[backend] 后端未能就绪: ${health.reason || "未知原因"}`);
    console.error("[backend] 可能的原因：端口被占用、原生模块 ABI 不匹配、缺少运行依赖。");
    return;
  }

  // 后端已就绪：把安装向导的配置播种进 DB（若用户尚未在设置里配置）
  await seedBackendFromConfig();
}

// 关闭前端时同步终止后端子进程及其进程树。
export function stopBackend(): void {
  if (!child) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      // /T 杀进程树，/F 强制。等同任务管理器结束进程及其子进程。
      execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
    } else if (pid) {
      // 类 Unix：detached 子进程自成进程组，负号向整组发信号。
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // 进程可能已退出，忽略
  }
  child = null;
}

// 导出当前子进程 PID（供外部查询调试）
export function getBackendPid(): number | undefined {
  return child?.pid;
}
