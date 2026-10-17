# Kirari Core 开发说明

## 项目定位

Kirari Core 是 Kirari 的智能机器人助手本体，当前版本 `0.8.1`。它负责对话、会话记忆、
知识库、模型配置、工具调用（MCP 与技能）、机器人平台接入（OneBot）和 WebSocket 实时通信；
只有桌面窗口、动画、点穿、换肤属于 `kirari-desktop`。

**同机共存时，核心版自动接管桌宠版的数据目录**（`src/dataDir.js` 探测 Electron 的
`userData`）：配置、知识库、组网、聊天记录全部读写同一份文件，无需任何手动配置。
详见下面的「与桌宠版共用同一份数据」。

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
src/app.js                        # 创建 HTTP 服务，挂载控制台、REST 与 WebSocket
src/api/routes.js                 # REST 路由和账户鉴权（含首页 / → 控制台）
src/api/consoleRoutes.js          # Web 控制台全部接口（单一管理口令鉴权）
src/api/requestSigner.js          # legacy 客户端签名校验
src/auth/sessionAuth.js           # 会话令牌签发与校验
src/websocket/socketServer.js     # WS 认证、消息和连接状态
src/services/modelConfigFile.js   # 模型配置真源（data/config.json，与桌宠版同构）
src/services/                     # 对话、降级回复、简报等业务服务
src/dataDir.js                    # 数据目录解析（自动探测桌宠版 userData）
src/settings/localSettings.js     # 数据目录下 JSON 设置文件的「已知键白名单」安全读写
src/settings/clientConfig.js      # 桌宠版 pet-client.config.json 的跨端字段读写
src/knowledge/                    # 知识源注册与检索（含与桌宠版同格式的私人知识库）
src/mcp/                          # MCP 客户端与工具注册（搬进核心版）
src/bot/                          # 机器人适配器：OneBot 正向 WS（搬进核心版）
src/tools/                        # 后端工具和桌面端工具桥
src/db/                           # 内存 / SQLite 存储实现（聊天记录真源）
src/session/                      # 会话管理门面
src/session/localSession.js       # 本机会话 id 真源（与桌宠版共用同一段对话）
src/web/consoleSite.js            # 控制台静态站点（web/dist）的两个入口
src/net/bootstrap.js              # 组网接线（角色、执行器、状态目录；协议在 kirari-net 包里）
web/                              # 控制台前端（Vue 3 + Vite，产物 web/dist）
res/fallback_responses.json       # 模型不可用时的本地回复
PORTREADME.md                     # 当前接口合约
```

模块边界要求：路由只负责协议和鉴权，服务层负责业务，存储层只负责持久化，WebSocket 层负责连接和消息编排。不要把桌面 UI 逻辑、OneBot 平台细节或持久化业务规则混进无关模块。

`src/net/` 里**只放宿主的接线**（读 `.env`、把本机 AI 引擎包成执行器、启动/停止），
**不要**往里加协议、加密或配对逻辑 —— 那些属于独立包 `kirari-net`，桌面端与核心版共用同一份。
核心版与桌面端都必须能当主机、也都能当叶子（能力对等是硬约束）；改协议要改包，
两侧同时受益，不要在这里复制一份。

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

**端口 19760 是组网固定端口**（`NET_ROLE=host` 时才监听）。它不是 HTTP，
不要试图用反代去代理它，也不要在 `.env` 里改 —— 它写在 `kirari-net` 的 `protocol.ts` 里，
两侧必须一致。局域网放行用 `firewall-cmd --add-port=19760/tcp`。

**依赖布局**：`package.json` 里有 `"kirari-net": "file:../kirari-net"`，
所以 `kirari-net` 必须与 `kirari-core` 平级。`npm ci` 对 `file:` 依赖**不校验目标是否存在**，
目标缺失时只会在 `node_modules` 里留一个悬空软链（安装日志一切正常），
启动时才 `MODULE_NOT_FOUND`。动依赖或部署脚本时务必保留一次真实的 `require("kirari-net")` 自检。

## 配置约定

`.env` 只保存在本地，不入库。常用变量：

```env
HOST=0.0.0.0
PORT=9089
STORAGE_TYPE=db
BUILTIN_ACCOUNT_TOKEN=请设置随机值
SESSION_SECRET=请设置随机值
```

- `STORAGE_TYPE=db` 使用 SQLite，`memory` 用于临时测试。
- **模型配置不在 `.env` 里**：控制台账号（`BOT_MODEL_UID`，默认 1）读 `data/config.json`
  （`src/services/modelConfigFile.js`，与桌面端 `electron/model-config.ts` 同构），
  其他老账号仍走 SQLite 旧路径（`model_profiles`/`api_tokens`，保留不发展）。
  `.env` 里配模型的老写法已删除，写了也没用。
- `BUILTIN_ACCOUNT_TOKEN` 只用于本地内置账户；必须与桌面端配置一致。
- 独立部署必须设置随机的 `SESSION_SECRET`。
- 不要提交 `.env`、真实 Token、数据库、日志或用户数据。
- 组网相关（都可选，不配就是 `off`，行为与升级前一致）：
  `NET_ROLE`（`off` / `host` / `leaf`）、
  `NET_STATE_DIR`（默认 `data/net`）、`NET_PAIRING_CODE`（叶子首次接入用一次）、
  `NET_ADVERTISE_HOST`（主机在容器/多网卡环境下**必填**，否则连接码里写的是
  容器内网地址或猜错的网卡）、`NET_PRINT_PAIRING=1`（把连接码打进启动日志）。
  **没有组网密钥这一项**：两端地位完全一样，谁也不带密钥出厂 ——
  当主机时本机自签一把（落 `data/net/net-state.json`，权限 600），
  当叶子时凭连接码在配对那一刻领（enroll）。历史变量 `KIRARI_NET_SECRET` 已删除，
  写了也没用。细节见 `kirari-net` 的 `secure.ts` / `enroll.ts`。

## 与桌宠版共用同一份数据

同一台机器上装过桌宠版时，核心版**自动接管它的数据目录**（`PET_API_DATA_DIR` →
`KIRARI_DESKTOP_DATA_DIR` → 自动探测 Electron `userData` → 回落 `<pkg>/data`，
见 `src/dataDir.js`）。两端对这些文件是同一份、同一种格式：

| 内容 | 文件（都在数据目录下） | 说明 |
| --- | --- | --- |
| 模型 / 人格 | `config.json` | 与桌宠版 `electron/model-config.ts` 同构，可直接互拷 |
| 技能 | `skills.json` | 同格式 |
| MCP 服务 | `mcp-servers.json` | 同格式 |
| 私人知识库 | `knowledge.json` | 同格式 |
| 外观主题 / 备注名 / 我的头像 / 机器人适配器 | `pet-client.config.json` | `theme` `petName` `userAvatar` `adapters` |
| 我的头像文件 | `user-avatar/avatar<ext>` | 配置里只存 `useravatar://avatar<ext>` 引用 |
| 组网 | `net-state.json` `net-identity.json` | 两端角色能力对等 |
| 聊天记录 | `pet_sessions.db` | 同一个 SQLite 文件（WAL + busy_timeout 并发安全） |
| 本机会话 id | `local-session.json` | 下面那条 |

**两条硬规矩**：

1. **不认识的字段一律原样保留**。核心版只写自己认识的键（`localSettings.js` 的
   「已知键白名单合并」），桌宠版手写的私有字段、未来新增的键一个字节都不许动 ——
   整体覆盖写回等于删用户数据。
2. **本机会话 id 必须落盘且两端共用**（`local-session.json`，见
   `src/session/localSession.js`）。会话 id 是聊天记录的分区键，
   一旦某端每次启动重掷随机 id，上一段对话就变成没人认领的孤儿（已真实发生过：
   桌宠版重启一次丢一段历史）。规则：文件在就用它，顺手把库里其它「本机会话」
   并进来；文件不在就采纳库里最近一段本机对话，全空才新建。
   机器人会话 `bot-*` **永远不参与收口** —— 那是群里多方的对话。

## 认证事实

推荐的新接口使用账户凭证：

- 本地内置账户：`X-Builtin-Token`。
- WebSocket：连接 `/ws?token=<token>`，握手阶段完成认证。

WebSocket 连接身份来自握手令牌对应的 UID，客户端消息中的 `userid` 不再作为身份来源。内置账户 UID 当前为 `1`。旧 `/api-client/*`、`/api-token/*` 接口使用 ed25519 请求签名，仅为历史客户端兼容保留。注册登录（`/api/auth/*`）已整体下线，不要在新代码里引用。

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
7. 改组网时，`cd ../kirari-net && npm test` 必须先过 —— 那里有真的起两端、
   真走握手加密与上行的端到端用例（含「叶子重启后重连仍能上行」这条回归）。
   协议、加密、配对、路由都在那个包里，核心版这边只验「接线对不对」：
   `/v1/chat` 上行成功时返回的 `model` 是 `（组网主机）`，失败会回退本机独立处理。

核心版自身仍没有完整自动化测试套件，发布前不能只依赖构建成功判断功能正常
（组网层的用例在 `kirari-net`，不覆盖核心版的宿主接线）。

## 当前待办

- ~~Web 控制台~~ **已完成（阶段 5）**：`web/` 是 Vue 3 + Vite 工程，构建产物 `web/dist/`
  由 `app.js` 检测后挂载，**首页 `/` 直接就是控制台**（`/console/` 作为老入口保留，
  两个入口指向同一份产物 —— 所以产物必须用相对路径，vite `base: "./"`，
  写死 `/console/` 时从 `/` 打开会去请求不存在的 `/assets/…`）。
  首页的 `GET /` 在 `routes.js` 里：控制台没构建过才回落到「Virtual Pet API is running!」。
  设置页共 10 项（外观 / 通用 / 个人 / 人格 / 大脑 / 技能 / 知识库 / 工具服务 /
  机器人 / 组网），只差桌宠专属的「形象」（换皮肤）。
  后端接口在 `src/api/consoleRoutes.js`：`GET /api/status`、`GET|PUT /api/settings`、
  `/api/models*`、`GET|PUT /api/persona`、`GET|PUT /api/theme`、`GET|PUT /api/pet-name`、
  `GET|POST|DELETE /api/avatar/user`、`/api/skills*`、`/api/mcp*`（+ `/api/mcp/probe`）、
  `/api/kb*`、`/api/bot*`、`GET /api/session`、`GET|DELETE /api/history`、
  `POST /api/chat`（SSE）、`/api/net/*`（组网全量入口）、`GET /api/data-info`。
  鉴权 = 单一管理口令 `ADMIN_PASSWORD` + 请求头 `X-Admin-Token`，没配 = 控制台整体 503 禁用；
  注册登录（`/api/auth/*`）已整体删除。
  ⚠️ `brainReady` 只能从 `modelConfigFile.getActiveModelConfig()` 判三件套 ——
  `dbStorage.getProfile()` 对外只给 `keyMasked` 掩码，读它的 `.key` 恒为 undefined
  （曾导致「明明配好了模型，界面永远写没连大脑」）。
  SSE 是逐字流：内核 `getReply` 支持 `onDelta` 回调
  （`onDelta(text)` 追加增量 / `onDelta(null)` 作废重流，工具轮碎片靠它清空），
  转成 `delta` 事件；`done` 仍带解析后的完整正文，前端以 done 为准做最终替换。
  ⚠️ Docker 的 webbuild 阶段没实测过（本机无 Docker）；systemd 路径里 install-service.sh
  会优先用源目录自带的 web/dist。
- **多模型（已完成，2026-10 起改为文件方案）**：控制台账号（`BOT_MODEL_UID`，默认 1）的
  模型配置存 `data/config.json`（`src/services/modelConfigFile.js`），与桌面端
  `electron/model-config.ts` **同构**——同一份文件拷到另一端即可用；字段约定以桌面端为真源
  （`{id,name,endpoint,model,key,keyMasked,hasKey}`、`activeId`，全 camel）。
  首次启动从 SQLite 懒迁移；外部手改文件经 `fs.watch`（200ms 去抖）热生效。
  非 `BOT_MODEL_UID` 的老账号仍走 SQLite 旧路径（`model_profiles`/`api_tokens`，保留不发展）。
  `dbStorage` 按 uid 路由两条路径，`listModelProfiles` 统一返回 `{items, activeId}`。
  搜索配置不跟着模型套走（顶层 `searchProvider/searchEndpoint/searchKey`）。
  ⚠️ 修过的坑：`deleteModelProfile` 必须**删除前**判断被删的是不是当前套；密钥校验必须在
  合并**之后**；文件路径与 DB 路径的返回形状必须一致（曾出现双重包裹 `{"items":{"items":…}}`）。
- 组网层 `kirari-net` 的正式分发方式（现在靠 `file:../kirari-net` 平级目录，
  部署时必须把两个仓库放一起）；考虑发 npm 包或改成 git 依赖。
- 账号体系服务化：目前机器人共用 `BOT_MODEL_UID`（默认 1）一个账号的模型配置。
- OneBot 群号 / 用户与 `session_id` 的稳定映射（已落地，补 Q 富媒体与限流）。
- QQ 富媒体和 CQ 码编解码。
- 按 UID / 会话的速率限制和消息长度限制。
- 后端接口与跨版本客户端的自动化测试。

## 相关文档

- [`README.md`](./README.md)：面向部署和使用者的快速入口。
- [`PORTREADME.md`](./PORTREADME.md)：WebSocket / REST 当前接口合约。
- [`res/fallback_responses.json`](./res/fallback_responses.json)：本地降级回复配置。
