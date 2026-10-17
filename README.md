<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari 绮莉" width="720">
</p>

# Kirari Core · 绮莉核心版

> 同一个机器人，跑在服务器上的那一半。

Kirari Core 是 Kirari 机器人的**核心运行时**：把对话、人格、记忆、知识库与工具
放在一台常年开机的机器上（VPS / NAS / 家里的常开主机），7×24 在线接消息平台。

当前版本：`0.8.1`

## 它和桌宠版的关系

| | kirari-desktop（桌宠版） | kirari-core（本仓库） |
| --- | --- | --- |
| 一句话 | 桌面上的桌宠 | 服务器上的机器人 |
| 运行位置 | 用户桌面 | VPS / NAS / 常开主机 |
| 图形界面 | 需要 | 不需要 |
| 依赖对方 | **不依赖** | **不依赖** |
| 什么时候用 | 想要桌宠、能随手关 | 想全天在线、接机器人、当组网主机 |
| 组网里的地位 | 能当主机，也能当叶子 | 能当主机，也能当叶子 |

两者是**平级关系**，各自独立部署、独立发版。桌宠自带大脑，装完即用；
把本仓库部署到服务器上，则可以获得一个不依赖任何桌面设备的在线机器人。

> **同一台机器都装了会怎样**：核心版会**自动找到并接管桌宠版的数据目录**
> （不用手动配路径），两边的模型配置、人格、技能、MCP、知识库、组网、机器人适配器和
> **聊天记录**都是同一份文件 —— 在桌宠里聊的，控制台看得到；反过来也一样。
> 核心版没有的字段（皮肤、窗口位置等）一律原样保留，不会动。

组网（多台设备共用一个大脑）由独立包 [`kirari-net`](https://github.com/Aiikisaraki/kirari-net)
提供，两边**共用同一份实现**。组网**没有需要配置的密钥**：当主机时本机自签一把，
当叶子时凭一张连接码在配对那一刻领 —— 所以同一个镜像发给不同的人，
是互不相通、也互不可见的若干张网。详见 `deploy/README.md` 的组网一节。

> 部署形态由你决定：只要桌面聊天就别装本仓库；需要全天在线才部署它。

## 能力概览

- WebSocket 与控制台两种对话入口，都支持文本和图片消息。
- 兼容 OpenAI API 格式的模型服务（可配多套，随时切换当前使用）。
- SQLite 会话与配置持久化，也支持切换为内存存储。
- 公用知识源和私人知识库检索。
- 时间、天气、联网搜索、图片生成等内置工具。
- **外部工具服务（MCP）与技能**：连接 MCP server、把工具注册给内核。
- **机器人平台接入**：内置 OneBot 正向 WebSocket 适配器，收到消息直接走内核回复。
- 网页控制台：外观、备注名、我的头像、人格、大脑、技能、知识库、工具服务、机器人、组网。
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

默认情况下，服务监听 `0.0.0.0:9089`。如果没有显式设置 `PORT` 且默认端口被占用，服务会尝试其他候选端口。部署到服务器时建议在 `.env` 里显式指定 `PORT`，避免与同机其他服务冲突。

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
```

模型配置**不在 `.env` 里**：唯一入口是控制台首页 `/` 的「大脑」页（存 `data/config.json`，
与桌面端同构，可配多套并选当前使用）。`.env` 里配模型的老写法（`MODEL_API_ENDPOINT` 等）
已删除，写了也没用。

常用配置：

| 配置 | 作用 |
| --- | --- |
| `HOST` | 监听地址；独立部署通常使用 `0.0.0.0`，本地桌面模式由客户端注入回环地址 |
| `PORT` | 服务端口 |
| `STORAGE_TYPE` | `db` 使用 SQLite，`memory` 使用内存存储 |
| `BOT_TOKEN` | 机器人接入（`POST /v1/chat`）的口令，不设则接口拒绝 |
| `ADMIN_PASSWORD` | Web 控制台管理口令（打开服务地址即进入，也可走 `/console/`），不设则控制台整体禁用 |
| `BUILTIN_ACCOUNT_TOKEN` | 本地内置账户的共享凭证，请自行设置并妥善保管 |
| `SESSION_SECRET` | 独立部署账户会话签名密钥，请使用随机值 |

SQLite 数据目录可通过运行环境调整；打包模式通常由桌面端注入到用户数据目录。不要在文档、日志或 Issue 中公开模型密钥、账户凭证和会话密钥。

## 连接方式

### 机器人接入（推荐）

这是服务器版的主入口。任何能发 HTTP 请求的机器人框架都能调用，**不需要适配本项目协议**：

```bash
curl -X POST http://127.0.0.1:9089/v1/chat \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"onebot","chatType":"group","groupId":"87654321","userId":"10001","content":"今天天气怎么样"}'
```

会话由服务端按「群号 / QQ 号」映射成稳定 ID（`bot:onebot:group:87654321`），
同一个群**进程重启后仍接着上次聊**。完整字段、会话规则与鉴权说明见
[`deploy/README.md`](./deploy/README.md)。

### WebSocket 对话通道

服务默认开放 HTTP 与 WebSocket：

- HTTP：`http://<服务器地址>:<端口>`
- WebSocket：`ws://<服务器地址>:<端口>/ws`

生产环境应通过反向代理配置 HTTPS/WSS，并限制管理接口访问范围。

## 部署

```bash
# Linux（systemd，崩溃自动重启 + 开机自启）
sudo ./deploy/install-service.sh

# Docker（数据卷持久化）
cp .env.example .env      # 改 BIND_ADDR / PORT / BOT_TOKEN / SESSION_SECRET
docker compose -f deploy/docker-compose.yml up -d
```

Windows / NAS 的 nssm、PM2 方式，以及常见问题排查，见 [`deploy/README.md`](./deploy/README.md)。

## 认证与接口

推荐接口：

- `GET /health`：健康检查。
- `POST /v1/chat`：**机器人接入主入口**，群号 / QQ 号自动映射会话。
- `GET /config`：客户端能力和默认配置。
- `GET /api/profile`：读取当前账户配置档案。
- `PUT /api/profile`：更新模型服务配置。
- `GET /ws`：WebSocket 对话通道。
- `GET /`：**网页控制台**（`/console/` 也可用），鉴权用 `X-Admin-Token`。

注册登录（`/api/auth/*`）已整体下线：管理配置走 Web 控制台（单一管理口令），
机器人接入走 `BOT_TOKEN`，桌面本地模式走内置账户。

WebSocket 默认要求在连接地址中携带令牌，例如：

```text
ws://127.0.0.1:9089/ws?token=<session-or-builtin-token>
```

连接身份由握手令牌决定，不使用客户端消息中自报的用户编号。完整的请求字段、响应格式、错误码和兼容接口请查看 [`PORTREADME.md`](./PORTREADME.md)。

旧的 `/api-client/*`、`/api-token/*` 接口仅为兼容历史客户端保留，新功能应使用 `/api/profile` 和 `POST /v1/chat`。

## 与桌面端的关系

- [`kirari-desktop`](https://github.com/Aiikisaraki/kirari-desktop)：Electron + Vue 3 桌宠，**自带大脑，不依赖本服务**。
- 本服务：服务器上的机器人核心运行时，对话、记忆、知识库、账户、工具（MCP / 技能）与
  机器人平台接入（内置 OneBot 正向 WebSocket 适配器，控制台「机器人」页直接配）。
- 机器人接入：除了内置适配器，也可以用 `POST /v1/chat`，自行在机器人侧对接其他平台。

两端**能力对等、配置互通**：MCP 与技能、机器人适配器、组网在两端都是同一套文件格式与
同一种行为；同一台机器上核心版自动接管桌宠版的数据目录（配置、知识库、组网、聊天记录
同一份文件），核心版不认识的字段一律原样保留。

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
