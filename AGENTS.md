# 虚拟桌宠 API (pet-api)

## 项目概述

这是一个基于 Node.js 的虚拟桌宠 API 服务器，提供 WebSocket 实时通信和 REST API 接口，用于支持桌面宠物应用（Electron 客户端 `akisaki-kirari`）的交互功能。

服务具备三类能力：

1. **WebSocket 实时对话通道**（`/ws`）—— 客户端发消息，服务端优先调用大模型生成回复，失败时回退到本地关键词预设回复。
2. **REST API** —— 健康检查、客户端初始化配置、以及 API Token / 模型配置的管理接口。
3. **会话管理与持久化** —— 基于 `session_id` 的多会话管理，默认使用 SQLite 持久化（也可切回内存）。

> ⚠️ 大模型能力**已经接入**，不是"待开发"。是否走真实模型取决于该 `userid` 是否在后端配置过 API Token：配过则调用模型，未配则走本地预设回复。

### 主要技术栈

- **运行时**: Node.js (CommonJS)
- **Web 框架**: Express 5.2.1
- **WebSocket**: ws 8.19.0
- **AI 集成**: OpenAI SDK 6.18.0（兼容 OpenAI 协议的任意端点，默认指向智谱 bigmodel）
- **持久化**: better-sqlite3 12.x（会话、Token、客户端身份）
- **密码哈希**: bcryptjs 3.x
- **环境管理**: dotenv 17.x
- **开发工具**: nodemon 3.1.11, concurrently 9.2.1

### 项目架构

```
pet-api/
├── server.js                      # 服务器入口，仅调用 createServer()
├── package.json
├── .env                           # 环境变量（PORT / STORAGE_TYPE / MODEL_API_ENDPOINT）
├── PORTREADME.md                  # API 接口详细文档
├── 开发指南.md                     # 后端开发指南
├── res/
│   └── fallback_responses.json    # 预设回复配置（模型失败时的兜底）
└── src/
    ├── app.js                     # 创建 Express + http 服务，挂载路由/WS，启动端口探测
    ├── api/
    │   ├── routes.js              # REST 路由（/health /config /api-client /api-token(legacy) /api/auth /api/profile）
    │   └── requestSigner.js       # legacy 客户端请求签名校验（ed25519 verify + nonce/时间戳）
    ├── auth/
    │   └── sessionAuth.js         # 会话令牌 HMAC 签名/校验（Bearer 登录态）
    ├── ai/
    │   └── connectionAiContext.js # 按 userid 读取 Token，用 OpenAI SDK 构建连接上下文
    ├── db/
    │   ├── memoryStorage.js       # 内存存储实现
    │   └── dbStorage.js           # SQLite 存储实现（当前 .env 激活）
    ├── services/
    │   ├── aiReplyService.js      # 调用大模型生成回复（chat.completions）
    │   └── fallbackService.js     # 关键词匹配预设回复
    ├── session/
    │   └── sessionManager.js      # 会话管理门面（STORAGE_TYPE 切换内存/SQLite）
    ├── token/
    │   └── apiTokenManager.js     # Token / 模型 / 端点 的读写封装
    ├── utils/
    │   └── portHelper.js          # 端口可用性探测
    └── websocket/
        └── socketServer.js        # WS 消息处理核心
```

### 核心功能

1. **WebSocket 通信** - `/ws` 路径，支持实时双向消息传输。
2. **REST API** - `/health`、`/config` 以及 API Token / 模型配置管理接口。
3. **会话管理** - 基于 `session_id` 的会话状态维护与消息历史记录。
4. **大模型回复（主路径）** - 通过 OpenAI SDK 调用用户配置的模型端点；未配置 Token 时自动回退。
5. **预设回复（兜底）** - 基于关键词匹配的 `fallback_responses.json`，仅在模型调用失败时使用。
6. **账户与配置档案** - `users` 表（uid 主键，0-99999 保留，真实用户从 100000 起）+ `/api/auth/{register,login}` + `/api/profile`（GET/PUT，Token 掩码返回，按内置账户或会话令牌鉴权）。
6. **端口自适应** - 自动检测并使用可用端口。
7. **客户端签名校验** - Token 管理类接口使用 ed25519（前端私钥签名 / 后端用注册公钥验签）防篡改。

## 构建和运行

### 环境配置

1. 安装依赖：
```bash
npm install
```

2. 配置环境变量（`.env` 文件，已被 `.gitignore` 忽略）：
```env
PORT=9089
STORAGE_TYPE=db
MODEL_API_ENDPOINT=https://open.bigmodel.cn/api/paas/v4/
```

- `PORT`：首选端口（代码兜底默认值 8089，`.env` 当前设为 `9089`）。
- `STORAGE_TYPE`：`memory` 或 `db`，当前设为 `db`（SQLite 生效）。
- `MODEL_API_ENDPOINT`：模型 API 默认端点。前端"设置"页保存的端点会覆盖此默认值。

### 启动服务

**方式一：直接运行**
```bash
node server.js
```

**方式二：使用 nodemon（开发模式）**
```bash
npm run dev
```

> ⚠️ 当前 `package.json` 的 `dev` 脚本误写为两个相同的 `nodemon server.js`，
> 实际只会启动一个实例。建议后续改为 `nodemon server.js` 或 `concurrently` 同时拉起前端。

### 服务端口

服务器（`src/utils/portHelper.js`）会先尝试 `process.env.PORT`，再依次尝试备选端口，返回第一个可用端口：

- 首选：`process.env.PORT`（默认 8089，`.env` 设为 9089）
- 备选端口：`3000`, `3001`, `8089`, `5000`

> 联调风险：前端 Electron 默认连接 `ws://localhost:9089/ws`，但若后端因为端口被占用而漂移到了 `3000` 等端口，前端不会自动发现。实际联调时建议保证 `9089` 端口空闲。

### 测试接口

**健康检查：**
```bash
curl http://localhost:9089/health
# => {"status":"ok","message":"虚拟桌宠服务运行正常","version":"1.0.0","uptime":123}
```

**获取配置：**
```bash
curl http://localhost:9089/config
# => {"default_action":"idle","max_message_length":200,"supports_tts":false,"mode":"fallback","version":"1.0.0"}
```

**WebSocket 测试：**
```bash
# 安装 wscat
npm install -g wscat

# 连接
wscat -c ws://localhost:9089/ws

# 发送消息（注意：需要带 userid 字段，否则返回 INVALID_USER_ID）
{"type":"user_message","session_id":"test","userid":1,"content":"你好"}
```

## 开发规范

### 代码风格

- 使用 CommonJS 模块系统（`require`/`module.exports`）
- 采用函数式/模块化风格
- 使用异步函数处理 I/O 操作
- 关键操作使用 `console.log` 标记

### 会话管理

- 通过 `STORAGE_TYPE` 在内存存储（`memoryStorage.js`）和 SQLite 存储（`dbStorage.js`）之间切换。
- `sessionManager.js` 为统一门面，对外屏蔽底层实现。
- 会话保留最近 10 条消息（约 5 轮问答），由 `getRecentMessages(sessionId, 6)` 在模型调用时取最近 6 条作为上下文。
- 当前 `.env` 设为 `STORAGE_TYPE=db`，SQLite 文件位于 `data/pet_sessions.db`（已被 `.gitignore` 忽略）。

### 大模型回复链路

1. 客户端 WS 消息携带 `userid`。
2. `socketServer.js` 首次收到消息时为该 `userid` 创建 `aiContext`（`connectionAiContext.js`），从 `apiTokenManager` 读取该用户的 Token / 模型 / 端点。
3. `aiReplyService.getReply()` 调用 `openai.chat.completions.create`：
   - `model`：用户配置的模型（默认 `GLM-4.7-Flash`）
   - `baseURL`：用户配置的端点（默认智谱 `open.bigmodel.cn/api/paas/v4/`）
   - `max_tokens: 512`，附带系统提示与最近 6 条历史
   - 按内容长度/关键词动态设置超时（45s~90s）
4. 若用户未配置 Token，或模型调用抛错，则回退到 `fallbackService.getReply()`，回复 `source` 标记为 `"fallback"`。
5. 同一 WS 连接中途切换 `userid` 会返回 `USER_ID_CHANGED` 错误。

> 命名澄清：代码/文档里出现的 "qwen / 千问" 容易误解。实际默认端点来自**智谱（Zhipu）** `open.bigmodel.cn`，仅早期模型名默认值曾为 `qwen-turbo`，当前路由默认模型为 `GLM-4.7-Flash`。任何兼容 OpenAI 协议的端点都可配置。

### 客户端签名体系（Token 管理接口）

除 `/health`、`/config` 外，所有 `/api-client`、`/api-token` 接口都需要签名：

- 前端（`akisaki-kirari`）在 `userData/client-identity.json` 生成 **ed25519** 密钥对，`clientId` 为 UUID。
- 请求时携带头：`X-Client-Id`、`X-Client-Timestamp`、`X-Client-Nonce`、`X-Client-Signature`（对 `method\npath\ntimestamp\nnonce\nbody` 签名）。
- 后端 `requestSigner.js` 用客户端注册时上传的 **ed25519 公钥** 做 `crypto.verify`（algorithm=null，按公钥类型自动走 ed25519）校验签名与时间戳/nonce，防重放与篡改。
- 用户身份 `userid` 当前在前端硬编码为 `"1"`。

### 消息格式

**客户端 → 服务端（WebSocket）：**
```json
{
  "type": "user_message",
  "session_id": "string",
  "userid": 1,
  "content": "string",
  "timestamp": "number (可选)"
}
```
- `userid` 为必填正整数，缺失或非法返回 `INVALID_USER_ID`。
- `content` 为必填非空字符串，缺失返回 `INVALID_MESSAGE`。
- 当前实现**不严格校验 `type` 字段**，直接读取 `content` / `userid` / `session_id`。

**服务端 → 客户端：**
```json
{
  "type": "pet_response",
  "speech": "string",
  "action": "string",
  "mood": "string",
  "source": "model | fallback",
  "model": "string (仅 model 路径)",
  "timestamp": "number"
}
```
- 模型路径固定返回 `action: "idle"`、`mood: "curious"`。
- 连接成功后约 1.5 秒会主动推送一条欢迎 `pet_response`（演示性质）。

**错误响应：**
```json
{ "type": "error", "code": "string", "message": "string", "timestamp": "number (可选)" }
```
实际错误码：`INVALID_MESSAGE`、`INVALID_USER_ID`、`USER_ID_CHANGED`、`PROCESS_ERROR`。
（旧文档提到的 `MODEL_ERROR` / `RATE_LIMITED` / `SESSION_EXPIRED` 当前未使用。）

### 预设回复配置

- 配置文件：`res/fallback_responses.json`
- 分类：greeting, goodbye, praise, scold, status, time, weather, default
- 支持动态变量替换（如 `{{current_time}}`）

## 当前状态

- ✅ WebSocket 通信已实现
- ✅ REST API 基础接口已完成（`/health` `/config`）
- ✅ 预设回复系统正常工作（作为兜底）
- ✅ 大模型 API 集成已实现（OpenAI SDK，按 userid 配置）
- ✅ SQLite 持久化已实现（`dbStorage.js`，`STORAGE_TYPE=db` 生效）
- ✅ 客户端签名校验已实现（ed25519 前后端共用一套密钥，前端私钥签名、后端用注册公钥验签）
- ✅ API Token / 模型 / 端点管理接口已实现
- ⏳ 单元测试（待添加）
- ⏳ 速率限制 / 消息长度限制（待实现）
- ⏳ OneBot / QQ 机器人适配器（尚未接入，见下方）

## 开发注意事项

1. **端口冲突**: 服务器会自动尝试多个端口，确保至少有一个可用。
2. **会话持久化**: SQLite 模式重启后可恢复；内存模式重启即丢失。
3. **API 安全**: API Key 通过环境变量 + 数据库管理，`.env` 不要提交到版本控制。
4. **签名一致性**: Token 接口依赖前后端签名算法一致，修改签名逻辑需同步两端。
5. **userid 来源**: 当前前端硬编码 `userid=1`，多用户/多 QQ 号场景需重新设计映射。

## 扩展方向

1. **OneBot / QQ 适配器**: 接入 NapCat / LLOneBot 等 OneBot 实现，把 QQ 消息桥接进本服务的 `socketServer`（当前最大缺口）。
2. **多会话映射**: QQ 群号/用户 → `session_id`，复用现有会话与持久化。
3. **CQ 码处理**: 表情/图片/@ 等富媒体的编解码。
4. **工具调用**: 天气查询、提醒等。
5. **多模态**: 图片、语音交互。

## 相关文档

- `PORTREADME.md` - 详细的 API 接口规范文档
- `开发指南.md` - 后端开发指南（架构、流程、配置）
- `res/fallback_responses.json` - 预设回复配置
- `.env` - 环境变量配置（本地文件，不入库）
