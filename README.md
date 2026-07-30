<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari" width="720">
</p>

# Kirari Core · 虚拟桌宠后端服务

Kirari绮莉 的 WebSocket + REST 后端，负责大模型对话、记忆持久化、位置与天气/时间工具调用，以及账户与模型配置管理。

## 特性

- **WebSocket 主通道**：实时双向通信，支持文本与图片消息。
- **大模型驱动**：兼容任意 OpenAI 协议端点，可自由切换模型与 API 地址。
- **记忆持久化**：SQLite 保存对话上下文与用户信息。
- **位置感知**：用户可在对话中设置所在城市，自动用于天气、时间查询。
- **工具调用**：内置时间、天气等实时工具，结果经大模型润色后自然回复。
- **账户体系**：本地内置账户（`X-Builtin-Token`）+ 服务端账号密码登录。

## 快速开始

```bash
npm install
npm start          # 默认监听 9089 端口（.env 可改）
```

服务启动后，前端或 `wscat` 即可连接 `ws://localhost:9089/ws`。

## 接口文档

详见 [`PORTREADME.md`](./PORTREADME.md)（WebSocket / REST 接口完整规范）。

## 关联项目

- 桌面客户端（Electron + Vue 3）：[`Aiikisaraki/kirari-desktop`](https://github.com/Aiikisaraki/kirari-desktop)

---

> 🤖 **本项目由 AI 辅助创建并持续维护**。核心代码、架构设计与日常迭代均在 AI 协作下完成，欢迎反馈与共建。
