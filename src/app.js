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

function createServer() {
    const app = express();
    const server = http.createServer(app);

    // 中间件
    app.use(express.json());

    // 1. 挂载 HTTP 路由
    setupHttpRoutes(app);

    // 2. 挂载 WebSocket 逻辑
    setupWebSocket(server);

    async function startServer() {
        const envPort = process.env.PORT;
        let port;
        if (envPort) {
            // 打包版由启动器显式传入 PORT（严格模式），不再做端口偏移，
            // 避免本地打包后前端连接端口错位。
            port = Number(envPort);
        } else {
            const CANDIDATES = [3000, 3001, 8089, 5000];
            port = await findAvailablePort(8089, CANDIDATES);
        }

        if (!port) {
            console.error("❌ 无法找到可用端口，请检查网络权限。");
            process.exit(1);
        }

        server.listen(port, () => {
            console.log(`
✨ 虚拟桌宠 API 服务启动成功！
✅ 运行地址: http://localhost:${port}
📡 WebSocket: ws://localhost:${port}/ws
🏥 健康检查: http://localhost:${port}/health
            `);
        });
    }

    startServer();
}

module.exports = { createServer };
