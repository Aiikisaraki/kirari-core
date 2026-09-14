# Kirari Core 开发说明

## 项目定位

Kirari Core 是 Kirari 桌宠的后端服务，当前版本 `0.7.2`。它负责对话、会话记忆、知识库、账户配置、工具调用和 WebSocket 实时通信；桌面窗口、动画、点穿、换肤和 OneBot 平台连接由 `kirari-desktop` 负责。

本仓库的旧项目名是 `pet-api`，但对外项目名统一使用 `kirari-core`。

## 技术栈

- Node.js 24，CommonJS
- Express 5
- `ws` WebSocket 服务
- `better-sqlite3` / SQLite
- OpenAI SDK，兼容 OpenAI API 格式
- `sharp` 图片解码与处理
- `bcryptjs`、`dotenv`
- `nodemon`、`concurrently`

## 目录职责

```text
server.js                         # 入口
src/app.js                        # 创建 HTTP 服务，挂载 REST 与 WebSocket
src/api/routes.js                 # REST 路由和账户鉴权
src/api/requestSigner.js          # legacy 客户端签名校验
src/auth/sessionAuth.js           # 会话令牌签发与校验
src/websocket/socketServer.js     # WS 认证、消息和连接状态
src/services/                     # 对话、降级回复、简报等业务服务
src/knowledge/                    # 知识源注册与检索
src/tools/                        # 后端工具和桌面端工具桥
src/db/                           # 内存 / SQLite 存储实现
src/session/                      # 会话管理门面
src/token/                        # 模型配置读写
res/fallback_responses.json       # 模型不可用时的本地回复
PORTREADME.md                     # 当前接口合约
```

模块边界要求：路由只负责协议和鉴权，服务层负责业务，存储层只负责持久化，WebSocket 层负责连接和消息编排。不要把桌面 UI 逻辑、OneBot 平台细节或持久化业务规则混进无关模块。

## 运行与端口

安装依赖：

```bash
npm install
```

直接运行：

```bash
npm start
```

开发运行：

```bash
npm run dev
```

默认监听 `HOST=0.0.0.0`、`PORT=9089`。只有在未显式设置 `PORT` 时，服务才会在默认端口不可用时尝试候选端口。桌面整合版由 `kirari-desktop/electron/backend-launcher.ts` 注入 `HOST=127.0.0.1` 和动态端口，后端不要写死桌面端端口，也不要自行覆盖启动器传入的端口。

`npm run dev` 当前用于启动后端开发进程。前端开发服务需要在 `kirari-desktop` 仓库单独启动。

## 配置约定

`.env` 只保存在本地，不入库。常用变量：

```env
HOST=0.0.0.0
PORT=9089
STORAGE_TYPE=db
MODEL_API_ENDPOINT=https://api.chatanywhere.tech/v1
BUILTIN_ACCOUNT_TOKEN=请设置随机值
SESSION_SECRET=请设置随机值
```

- `STORAGE_TYPE=db` 使用 SQLite，`memory` 用于临时测试。
- 模型端点可由账户档案配置覆盖。
- `BUILTIN_ACCOUNT_TOKEN` 只用于本地内置账户；必须与桌面端配置一致。
- 独立部署必须设置随机的 `SESSION_SECRET`。
- 不要提交 `.env`、真实 Token、数据库、日志或用户数据。

## 认证事实

推荐的新接口使用账户凭证：

- 本地内置账户：`X-Builtin-Token`。
- 独立部署账户：登录后使用 `Authorization: Bearer <session-token>`。
- WebSocket：连接 `/ws?token=<token>`，握手阶段完成认证。

WebSocket 连接身份来自握手令牌对应的 UID，客户端消息中的 `userid` 不再作为身份来源。内置账户 UID 当前为 `1`；独立注册账户从 `100000` 起分配。旧 `/api-client/*`、`/api-token/*` 接口使用 ed25519 请求签名，仅为历史客户端兼容保留。

## WebSocket 约定

当前连接除了聊天消息，还支持桌面端上报或回传：

- `register_tools`：注册桌面端托管工具。
- `tool_result`：回传工具执行结果。
- `register_skills`：注册技能说明。
- `register_persona`：注册用户人格设定。
- `kb_response`：回传私人知识库检索结果。
- 普通消息可包含 `content`、`images`、`session_id`、`locationScope` 和 `kbContext`。

图片进入模型前会经过服务端解码和尺寸检查。模型调用失败或未完成配置时，服务会按实现返回明确错误或本地降级回复。完整字段和错误码以 [`PORTREADME.md`](./PORTREADME.md) 为准。

## 版本与接口

项目版本唯一来源是 `package.json`。`/health` 和 `/config` 应通过同一版本来源返回版本号，不要在路由中写死旧版本。

修改接口时必须同步更新 `PORTREADME.md`，并检查桌面端的 `electron/chat-session-service.ts`、适配器和后端启动器。改动认证、消息字段、端口或图片处理时，应进行真实联调。

## 联调检查

最小检查路径：

1. `npm install` 成功，原生依赖与当前 Node.js ABI 匹配。
2. 启动后确认日志中的 HOST、PORT 和 `/health` 可访问。
3. 用有效内置令牌或会话令牌连接 `/ws`。
4. 验证文本、图片、降级回复、会话恢复和配置保存。
5. 若修改工具、技能或知识库，分别验证注册、回传、超时和断线行为。
6. 前端改动还要验证拖动、逐像素点穿、动画、换肤和安装包。

当前没有完整自动化测试套件，发布前不能只依赖构建成功判断功能正常。

## 当前待办

- OneBot 群号 / 用户与 `session_id` 的稳定映射。
- QQ 富媒体和 CQ 码编解码。
- 按 UID / 会话的速率限制和消息长度限制。
- 后端接口与跨版本客户端的自动化测试。

## 相关文档

- [`README.md`](./README.md)：面向部署和使用者的快速入口。
- [`PORTREADME.md`](./PORTREADME.md)：WebSocket / REST 当前接口合约。
- [`res/fallback_responses.json`](./res/fallback_responses.json)：本地降级回复配置。
