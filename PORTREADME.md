# 虚拟桌宠 API 服务器接口规范

> **版本**: v1.1（已根据源码核对）
> **通信方式**: WebSocket 为主，REST 为辅
> **数据格式**: JSON

---

## 📋 接口概览

| 接口类型  | 路径                  | 方法 | 说明                     | 优先级 |
| --------- | --------------------- | ---- | ------------------------ | ------ |
| WebSocket | `/ws`                 | -    | 核心消息通信             | ⭐⭐⭐⭐⭐ |
| REST      | `/health`             | GET  | 服务健康检查             | ⭐⭐⭐    |
| REST      | `/config`             | GET  | 获取默认配置             | ⭐⭐     |
| REST      | `/api/auth/register`  | POST | 注册用户账号（服务端部署）| ⭐⭐⭐   |
| REST      | `/api/auth/login`     | POST | 登录换取会话令牌         | ⭐⭐⭐    |
| REST      | `/api/profile`        | GET  | 获取当前账户配置档案     | ⭐⭐⭐⭐   |
| REST      | `/api/profile`        | PUT  | 更新配置档案（模型/端点/Token）| ⭐⭐⭐⭐ |
| REST      | `/api-client/register`| POST | 注册客户端身份（legacy） | ⭐      |
| REST      | `/api-token/status`   | GET  | 查询 Token 配置状态（legacy）| ⭐   |
| REST      | `/api-token`          | POST | 设置 Token/模型/端点（legacy）| ⭐  |
| REST      | `/api-token/model`    | POST | 更新模型名（legacy）     | ⭐      |
| REST      | `/api-token/endpoint` | POST | 更新端点（legacy）       | ⭐      |
| REST      | `/api-token/verify`   | POST | 校验查看密码并取回 Token（legacy）| ⭐ |

---

## 🌐 WebSocket 接口

### 连接地址

```
ws://<your-server>:<port>/ws
```

默认端口：`9089`（代码兜底 8089，`.env` 设为 9089）。

### 消息交互流程

```
客户端 → 服务端: { "type":"user_message", "userid":1, "content":"..." }
服务端 → 大模型: 调用用户配置的 OpenAI 协议端点（chat.completions）
大模型 → 服务端: 返回文本
服务端 → 客户端: { "type":"pet_response", "source":"model", ... }
                        │
                        └─ 若未配置 Token / 模型调用失败 → 走 fallback_responses.json（source:"fallback"）
```

> 大模型为**主路径**，本地预设回复为**兜底**。是否走模型取决于该 `userid` 是否配置过 API Token。

---

## 📨 消息类型定义

### 1. 客户端 → 服务端：用户消息

```json
{
  "type": "user_message",
  "session_id": "string",
  "userid": 1,
  "content": "string",
  "timestamp": "number (可选)"
}
```

| 字段         | 类型   | 必填 | 说明                              |
| ------------ | ------ | ---- | --------------------------------- |
| `type`       | string | 否   | 当前实现不校验此字段              |
| `session_id` | string | 否   | 缺省时服务端生成                  |
| `userid`     | number | **是** | 正整数；缺失/非法 → `INVALID_USER_ID` |
| `content`    | string | **是** | 非空；缺失/空 → `INVALID_MESSAGE` |

示例：
```json
{ "type":"user_message", "session_id":"user_abc123", "userid":1, "content":"你好，小灵！" }
```

### 2. 服务端 → 客户端：宠物响应

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

| 字段        | 类型   | 必填 | 示例值                  | 说明                          |
| ----------- | ------ | ---- | ----------------------- | ----------------------------- |
| `type`      | string | 是   | `"pet_response"`        | 固定值                        |
| `speech`    | string | 是   | `"主人好呀！"`          | 宠物说的话                    |
| `action`    | string | 是   | `"idle"` / `"wave"`     | 模型路径固定 `"idle"`         |
| `mood`      | string | 是   | `"curious"` / `"happy"` | 模型路径固定 `"curious"`      |
| `source`    | string | 否   | `"model"` / `"fallback"`| 标明回复来源                  |
| `model`     | string | 否   | `"GLM-4.7-Flash"`       | 仅 model 路径返回             |
| `timestamp` | number | 否   | `1700000000000`         | 服务端生成                    |

示例（模型）：
```json
{ "type":"pet_response", "speech":"主人好呀！今天过得怎么样？", "action":"idle", "mood":"curious", "emotion":"happy", "source":"model", "model":"GLM-4.7-Flash", "timestamp":1700000000000 }
```

> Action / Mood 枚举建议值参见旧文档。**当前模型路径产出 `action:"idle"`、`mood:"curious"`，并会按回复语义附带 `emotion`（`happy` / `wave`）；兜底回复同样按分类附带 `emotion`**（greeting→wave、praise→happy、goodbye→wave，其余 `null`）。前端仅消费 `emotion` 字段用于“情绪优先”动画（先播情绪/动作再说话）。

### 3. 服务端 → 客户端：错误响应

```json
{
  "type": "error",
  "code": "string",
  "message": "string",
  "timestamp": "number (可选)"
}
```

| code               | message            | 触发条件                         |
| ------------------ | ------------------ | -------------------------------- |
| `INVALID_MESSAGE`  | "消息不能为空"     | `content` 缺失或为空             |
| `INVALID_USER_ID`  | "用户 ID 无效"     | `userid` 缺失或非安全正整数      |
| `USER_ID_CHANGED`  | "同一连接不能切换用户" | 同一 WS 连接中途换了 `userid` |
| `PROCESS_ERROR`    | "服务器处理消息失败" | 其他未预期错误                 |

> 旧文档提到的 `MODEL_ERROR` / `RATE_LIMITED` / `SESSION_EXPIRED` **当前未使用**。

### 4. 连接欢迎消息

连接成功后约 **1.5 秒**，服务端主动推送一条 `pet_response`（演示性质）：
```json
{ "type":"pet_response", "speech":"主人好呀~ (ฅ´ω`ฅ)", "action":"wave", "mood":"curious", "emotion":"wave", "timestamp":1700000000000 }
```

---

## 🌐 REST 接口

### 公共接口（无需签名）

#### `GET /health`
```json
{ "status":"ok", "message":"虚拟桌宠服务运行正常", "version":"1.0.0", "uptime": 123 }
```
> 注意：**无 `model` 字段**（旧文档示例有误）。

#### `GET /config`
```json
{ "default_action":"idle", "max_message_length":200, "supports_tts":false, "mode":"fallback", "version":"1.0.0" }
```

---

### 账户与配置档案（推荐路径，前端设置界面使用）

这套接口按**账户凭证**驱动，对前端无感，取代了旧的 ed25519 签名 + 查看密码流程。

**鉴权方式二选一**：
- 本地部署：请求头 `X-Builtin-Token: <builtinToken>`，对应保留内置账户 `uid=0`。该令牌与客户端 `pet-client.config.json` 的 `builtinToken`、服务端 `.env` 的 `BUILTIN_ACCOUNT_TOKEN` 一致（仅本地端到端部署时使用）。
- 远程/服务端部署：先 `POST /api/auth/login` 拿到 `sessionToken`，后续请求带 `Authorization: Bearer <sessionToken>`。

#### `POST /api/auth/register`
独立部署服务端时注册用户账号（前端"注册"入口）。
```json
请求: { "username":"alice", "password":"secret123" }
成功: { "uid": 100000 }
冲突: 409 { "message":"用户名已被占用" }
```
> uid 分配：保留区间 `0-99999` 为程序内置账户，真实用户从 `100000` 起递增。

#### `POST /api/auth/login`
```json
请求: { "username":"alice", "password":"secret123" }
成功: { "uid": 100000, "sessionToken":"<jwt-like>" }
失败: 401 { "message":"用户名或密码错误" }
```

#### `GET /api/profile`
返回当前账户配置档案（Token 以掩码返回，无需查看密码）。
```json
// 头: X-Builtin-Token 或 Authorization: Bearer <token>
{ "uid":0, "username":"__builtin__", "model":"qwen-turbo", "api_endpoint":"https://open.bigmodel.cn/api/paas/v4/", "token_masked":"sk-****abcd", "hasToken": true }
未认证: 401 { "message":"未认证" }
```

#### `PUT /api/profile`
更新配置档案。模型/端点始终可改；Token 仅在新值非空时替换（留空不修改）。
```json
// 头同上
请求: { "model":"GLM-4.7-Flash", "api_endpoint":"https://...", "token":"sk-new..." }
成功: { "uid":0, "username":"__builtin__", "model":"GLM-4.7-Flash", "api_endpoint":"https://...", "token_masked":"sk-****wxyz", "hasToken": true }
```

---

### 需签名的接口（Token 管理，legacy）

> 以下为旧接口，仅向后兼容，前端设置界面已不再使用。需客户端 ed25519 签名头：
> `X-Client-Id`、`X-Client-Timestamp`、`X-Client-Nonce`、`X-Client-Signature`。
> 后端 `requestSigner.js` 用公钥做 ed25519 校验 + 时间戳/nonce 防重放。

#### `POST /api-client/register`
注册客户端身份，绑定 `userid`。
```json
请求: { "userid": 1, "clientId": "<uuid>", "publicKey": "<PEM>" }
成功: { "registered": true }
冲突: 409 { "message":"客户端已绑定其他身份" }
```

#### `GET /api-token/status?userid=1`
```json
{ "configured": true, "model":"GLM-4.7-Flash", "api_endpoint":"https://open.bigmodel.cn/api/paas/v4/" }
```

#### `POST /api-token`
设置 Token / 查看密码 / 模型 / 端点（端点缺省用 `MODEL_API_ENDPOINT`）。
```json
请求: { "userid":1, "token":"sk-...", "viewPassword":"1234", "model":"GLM-4.7-Flash", "apiEndpoint":"https://..." }
成功: { "message":"API令牌设置成功" }
```

#### `POST /api-token/model`
```json
请求: { "userid":1, "model":"GLM-4.7-Flash" }
成功: { "model":"GLM-4.7-Flash" }
```

#### `POST /api-token/endpoint`
```json
请求: { "userid":1, "apiEndpoint":"https://open.bigmodel.cn/api/paas/v4/" }
成功: { "api_endpoint":"https://open.bigmodel.cn/api/paas/v4/" }
```

#### `POST /api-token/verify`
用查看密码校验并取回 Token。
```json
请求: { "userid":1, "viewPassword":"1234" }
成功: { "valid": true, "token":"sk-..." }
失败: 403 { "valid": false, "message":"查看密码错误" }
```

---

## 🔒 安全与限制

1. **API Token 与模型配置**
   - Token / 模型名 / 端点由前端"设置"页提交并加密存入 SQLite。
   - 未配置端点时使用 `.env` 的 `MODEL_API_ENDPOINT`（内置默认 ChatAnywhere `api.chatanywhere.tech`；本地 `.env` 可覆盖为智谱 `open.bigmodel.cn` 等）。
   - 读取档案时 Token 以掩码（`sk-****abcd`）返回，**不再需要"查看密码"**。改动 Token 只需填入新值直接替换。

2. **账户鉴权**
   - 本地部署：内置账户（uid=0）+ 共享 `X-Builtin-Token`，仅在客户端与服务端同在本地时使用。
   - 服务端部署：用户名/密码登录换取 HMAC 会话令牌（`SESSION_SECRET` 签名，7 天有效），请求带 `Authorization: Bearer`。
   - 旧的 ed25519 客户端签名仅保留给 legacy `/api-token/*` 接口。

3. **uid 规则**
   - `0-99999` 为程序保留账户（本地内置账户 = 0）。
   - 独立部署服务端注册的真实用户从 `100000` 起。

4. **待实现**
   - 速率限制（按 `uid` / `session_id`）
   - `content` 长度硬性限制（当前 `/config` 声明 200，但 WS 未强制）
   - 更细粒度错误码

---

## 🧪 测试方法

### WebSocket
```bash
wscat -c ws://localhost:9089/ws
{"type":"user_message","session_id":"test","userid":1,"content":"你好"}
```

### REST
```bash
curl http://localhost:9089/health
curl http://localhost:9089/config
```

---

## 🚀 未来扩展

1. **OneBot / QQ 适配器**：把 QQ 消息桥接进 `/ws` 的消息处理逻辑（当前最大缺口）。
2. 多 `userid` 映射（多 QQ 号 / 群）→ `session_id`。
3. CQ 码（表情/图片/@）编解码。
4. 新增 WS 消息类型：`system_event` / `memory_update` / `tool_result`。
5. 新增 REST：`POST /tools/weather`、`POST /memory/save`、`GET /memory/load`。

---

## ✅ 总结

当前已实现：WebSocket 主通道、REST 健康检查与配置、大模型回复（主）+ 预设兜底（次）、SQLite 持久化、API Token 签名体系。
最关键的待办是 **OneBot / QQ 适配器**，使桌宠能从纯本地客户端演进为可接入 QQ 的机器人。
