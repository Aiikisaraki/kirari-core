<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari 绮莉" width="720">
</p>

# Kirari Core · 绮莉后端

> Kirari 的记忆、对话和工具，都在这里有一个稳定的落脚点。

Kirari Core 是桌宠项目的 Node.js 后端服务，负责 AI 对话、会话记忆、知识库、账户配置、工具调用和 WebSocket 实时通信。

当前后端版本：`0.7.2`

## 能力概览

- WebSocket 实时对话，支持文本和图片消息。
- 兼容 OpenAI API 格式的模型服务，可按账户配置模型和服务地址。
- SQLite 会话与配置持久化，也支持切换为内存存储。
- 公用知识源和私人知识库检索。
- 时间、天气、联网搜索、图片生成等工具能力。
- 桌面端托管工具、技能和个性化设定的桥接。
- 本地内置账户与独立部署账户登录。
- 模型不可用或未配置时提供本地降级回复。

## 快速启动

要求：Node.js 24，Windows、Linux 和 macOS 均可用于源码运行；原生依赖安装时请使用与运行环境匹配的 Node.js 版本。

```bash
npm install
npm start
```

开发模式：

```bash
npm run dev
```

默认情况下，服务监听 `0.0.0.0:9089`。如果没有显式设置 `PORT` 且默认端口被占用，服务会尝试其他候选端口。桌面客户端的整合版会显式注入 `HOST=127.0.0.1` 和动态端口，因此本地模式不要假定固定端口。

健康检查：

```bash
curl http://127.0.0.1:9089/health
```

实际端口以启动日志为准。

## 配置

在项目根目录创建本地 `.env`（不要提交到 Git）：

```env
HOST=0.0.0.0
PORT=9089
STORAGE_TYPE=db
MODEL_API_ENDPOINT=https://api.chatanywhere.tech/v1
```

常用配置：

| 配置 | 作用 |
| --- | --- |
| `HOST` | 监听地址；独立部署通常使用 `0.0.0.0`，本地桌面模式由客户端注入回环地址 |
| `PORT` | 服务端口；桌面整合版由客户端动态分配并注入 |
| `STORAGE_TYPE` | `db` 使用 SQLite，`memory` 使用内存存储 |
| `MODEL_API_ENDPOINT` | 默认模型服务地址，可由账户配置覆盖 |
| `BUILTIN_ACCOUNT_TOKEN` | 本地内置账户的共享凭证，请自行设置并妥善保管 |
| `SESSION_SECRET` | 独立部署账户会话签名密钥，请使用随机值 |

SQLite 数据目录可通过运行环境调整；打包模式通常由桌面端注入到用户数据目录。不要在文档、日志或 Issue 中公开模型密钥、账户凭证和会话密钥。

## 连接方式

### 桌面端本地模式

整合版和全功能版会启动本地后端，并自动注入本机回环地址、动态端口和内置账户凭证。用户不需要手工启动本服务。

### 独立部署

独立运行本服务后，在桌面端设置中填写后端地址。服务默认开放 HTTP 和 WebSocket：

- HTTP：`http://<服务器地址>:<端口>`
- WebSocket：`ws://<服务器地址>:<端口>/ws`

生产环境应通过反向代理配置 HTTPS/WSS，并限制管理接口访问范围。

## 认证与接口

推荐接口：

- `GET /health`：健康检查。
- `GET /config`：客户端能力和默认配置。
- `POST /api/auth/register`：注册独立部署账户。
- `POST /api/auth/login`：登录并获取会话凭证。
- `GET /api/auth/me`：读取当前登录账户。
- `GET /api/profile`：读取当前账户配置档案。
- `PUT /api/profile`：更新模型服务配置。
- `GET /ws`：WebSocket 对话通道。

WebSocket 默认要求在连接地址中携带令牌，例如：

```text
ws://127.0.0.1:9089/ws?token=<session-or-builtin-token>
```

连接身份由握手令牌决定，不使用客户端消息中自报的用户编号。完整的请求字段、响应格式、错误码和兼容接口请查看 [`PORTREADME.md`](./PORTREADME.md)。

旧的 `/api-client/*`、`/api-token/*` 接口仅为兼容历史客户端保留，新功能应使用 `/api/auth/*` 和 `/api/profile`。

## 与桌面端的关系

- [`kirari-desktop`](https://github.com/Aiikisaraki/kirari-desktop)：Electron + Vue 3 桌面客户端。
- 本服务：对话、记忆、知识库、账户和工具能力。
- OneBot / QQ：由桌面端适配器负责接入，再通过已认证连接转发到本服务。

桌面端还可以托管外部工具、技能和私人知识库检索，并通过 WebSocket 桥接给本服务使用。

## 当前边界

- 外部模型和数据服务可能受网络、费用、速率限制或服务条款影响。
- 模型未配置或调用失败时，会返回本地降级回复；这不代表外部模型服务已恢复。
- `PORTREADME.md` 描述的是当前实现，不保证兼容所有历史客户端。
- 速率限制和更严格的消息长度限制仍属于后续增强项。
- OneBot 场景的群号、用户与会话映射，以及富媒体消息编解码，仍需继续完善。

## 许可证与外部服务

- 代码采用 [MIT License](./LICENSE)。
- 模型、天气、搜索、知识源和图片服务均为可配置的第三方服务，使用时请遵守对应服务条款。
- 不要把真实 API 密钥、内置账户令牌、会话密钥或生产数据库提交到仓库。
