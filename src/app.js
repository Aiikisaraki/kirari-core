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

// 绑定网卡（HOST）：
// - 默认 0.0.0.0（监听所有网卡），适合分离式 / 远程部署，开箱即用。
// - 本地模式由启动器（Electron 主进程）显式传入 HOST=127.0.0.1，仅监听回环，
//   既避免 Windows 上绑定 0.0.0.0 的 EACCES，也不把本地 API 暴露到局域网。
const HOST = process.env.HOST || "0.0.0.0";

function createServer() {
    const app = express();
    const server = http.createServer(app);

    // 中间件
    app.use(express.json());
    // CORS：放业务路由之前，处理跨域预检与响应头（独立网页前端 / 分离部署需要）。
    app.use(corsMiddleware);

    // 1. 挂载 HTTP 路由
    setupHttpRoutes(app);

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
📡 WebSocket: ws://${HOST}:${port}/ws
🏥 健康检查: http://${HOST}:${port}/health
            `);
        });
    }

    startServer();
}

module.exports = { createServer };
