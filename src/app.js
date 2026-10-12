/*
 * @Author: Aii如樱如月 morikawa@kimisui56.work
 * @Date: 2026-02-12 17:47:06
 * @LastEditors: Aii如樱如月 morikawa@kimisui56.work
 * @LastEditTime: 2026-07-16 23:55:55
 * @FilePath: \pet-api\src\app.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// src/app.js

const dotenv = require("dotenv");

// 加载配置
dotenv.config();

const http = require("http");
const express = require("express");
const { setupHttpRoutes } = require("./api/routes");
const { setupWebSocket } = require("./websocket/socketServer");
const { findAvailablePort } = require("./utils/portHelper");
const corsMiddleware = require("./middleware/cors");
const dbStorage = require("./db/dbStorage");
const { createConnectionAiContext, cleanupConnectionAiContext } = require("./ai/connectionAiContext");
const contextPool = require("./ai/contextPool");
const dailyBriefing = require("./services/dailyBriefingService");
const netBootstrap = require("./net/bootstrap");
// 智能机器人助手本体（用户拍板：MCP + 机器人都搬进核心版）：
//   工具具体系启动时连 MCP server、注册本地工具；
//   机器人适配器启动时连 OneBot，收到消息直接走内核回复。
const mcpManager = require("./mcp/mcpManager");
const botManager = require("./bot/botManager");
const consoleSite = require("./web/consoleSite");
const { dataDir, dataDirSource, dataDirDetail } = require("./dataDir");

// 每天 08:00 / 16:00 / 22:00 各主动刷新一次当日简报（"每日记忆"）。
// 三次均强制重新采集（generateDailyBrief），覆盖当天同一份简报，使注入的【今日背景】
// 始终为最新快照；对话时的 ensureDailyBrief 仍作兜底（三档全错过时首句也有简报）。
const BRIEF_SLOTS = [8, 16, 22]; // 每天这几个整点刷新

function msToNextSlot(now) {
  const candidates = BRIEF_SLOTS.map((h) => {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  });
  candidates.sort((a, b) => a - b);
  return candidates[0] - now;
}

function scheduleDailyBriefing() {
  const now = new Date();
  const ms = msToNextSlot(now);
  setTimeout(async () => {
    try {
      const userids = await dbStorage.getAllUserids();
      for (const uid of userids) {
        try {
          const ctx = await createConnectionAiContext(uid);
          await dailyBriefing.generateDailyBrief(ctx);
          cleanupConnectionAiContext(ctx);
        } catch (e) {
          console.warn(`[dailyBrief-sched] 用户 ${uid} 简报生成失败:`, e?.message || e);
        }
      }
    } catch (e) {
      console.warn("[dailyBrief-sched] 定时生成失败:", e?.message || e);
    }
    scheduleDailyBriefing();
  }, ms);
}

// 绑定网卡（HOST）：
// - 默认 0.0.0.0（监听所有网卡），适合分离式 / 远程部署，开箱即用。
// - 本地模式由启动器（Electron 主进程）显式传入 HOST=127.0.0.1，仅监听回环，
//   既避免 Windows 上绑定 0.0.0.0 的 EACCES，也不把本地 API 暴露到局域网。
const HOST = process.env.HOST || "0.0.0.0";

function createServer() {
    const app = express();
    const server = http.createServer(app);

    // 数据目录一句话说清：自动接管桌宠版数据时，用户能立刻看到「读的是哪一份」。
    console.log(`[data-dir] 数据目录 = ${dataDir}（来源：${dataDirSource}）`);

    // 中间件
    // 头像上传是 base64（5MB 图片≈6.7MB 文本），只对这条路径放宽体积限制；
    // 它必须排在全局 express.json 之前，否则 100kb 的默认限制会先把请求挡掉。
    app.use("/api/avatar/user", express.json({ limit: "8mb" }));
    app.use(express.json());
    // CORS：放业务路由之前，处理跨域预检与响应头（独立网页前端 / 分离部署需要）。
    app.use(corsMiddleware);

    // Web 控制台静态页（web/ 目录构建产物），与 API 同端口共存。
    // 两个入口指向同一份产物：/（首页，不用记路径）和 /console/（老入口，保留）。
    // 没构建过就都不挂 —— 服务本体不依赖控制台的存在。
    const consoleReady = consoleSite.available();
    if (consoleReady) {
        app.use("/console", express.static(consoleSite.DIST, consoleSite.staticOptions()));
    }

    // 1. 挂载 HTTP 路由（首页 / 在这里面：控制台可用就送界面，否则回落到服务状态一行字）
    setupHttpRoutes(app);

    // 控制台的资源文件也在**根路径**下备一份：首页从 / 打开时，相对路径的
    // ./assets/xxx.js 就落在 /assets/xxx.js。放在 HTTP 路由之后注册，
    // 保证 /api、/health 这些永远优先于静态文件匹配。
    if (consoleReady) {
        app.use("/", express.static(consoleSite.DIST, consoleSite.staticOptions()));
        console.log("[console] 网页控制台已启用: /（/console/ 也可用）");
    }

    // 2. 挂载 WebSocket 逻辑
    setupWebSocket(server);

    async function startServer() {
        const DEFAULT_PORT = 9089;
        const envPort = process.env.PORT;
        let port;
        if (envPort) {
            // 由启动器（本地模式）或运维（分离部署）显式注入 PORT（严格模式），
            // 不再做端口偏移，避免本地打包后前端连接端口错位。
            port = Number(envPort);
        } else {
            // 未注入时默认监听 9089；若该端口被占用则向后试探若干候选端口。
            port = await findAvailablePort(DEFAULT_PORT, [3000, 3001, 8089, 5000]);
        }

        if (!port) {
            console.error("❌ 无法找到可用端口，请检查网络权限。");
            process.exit(1);
        }

        server.listen(port, HOST, () => {
            console.log(`
✨ 虚拟桌宠 API 服务启动成功！
✅ 运行地址: http://${HOST}:${port}
🖥️  网页控制台: http://127.0.0.1:${port}/${consoleReady ? "（首页直接进）" : "（未构建，先 npm run build）"}
📡 WebSocket: ws://${HOST}:${port}/ws
🏥 健康检查: http://${HOST}:${port}/health
            `);
            // 组网在主服务起来之后才启动：它是可选的，任何配置问题都只跳过组网，
            // 不阻断机器人接消息。角色由 .env 的 NET_ROLE 决定（默认 off）。
            netBootstrap.start();

            // 工具与机器人：服务真的在监听后才起，避免启动期报错掩盖监听失败。
            // 两者都是可选能力，失败只打警告、不影响 API 本体。
            mcpManager.initTools();
            botManager.initBots();
        });
    }

    startServer();
    scheduleDailyBriefing();
    // 回收闲置的 AI 上下文（HTTP 接入没有连接概念，靠空闲超时释放）。
    // 定时器已 unref，不会阻止进程退出。
    contextPool.startIdleSweeper();

    // 退出时释放所有上下文，避免 OpenAI 客户端的连接池悬挂。
    const shutdown = () => {
        console.log("[exit] 正在释放资源…");
        // 先退组网：主机退出后其他设备会自动转为独立工作（组网铁律：不留半死状态）
        netBootstrap.stop();
        botManager.stopAll();
        contextPool.invalidateAll();
    };
    process.on("SIGINT", () => { shutdown(); process.exit(0); });
    process.on("SIGTERM", () => { shutdown(); process.exit(0); });
}

module.exports = { createServer };
