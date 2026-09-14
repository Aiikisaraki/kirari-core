# Kirari Core 接口合约

> 当前实现版本：`0.7.2`
> 通信方式：WebSocket 为主，REST 为辅
> 数据格式：JSON

这份文档描述当前源码实际提供的接口。桌面端本地模式的端口由客户端动态注入，示例中的 `9089` 仅代表后端直接运行时的默认端口。

## 接口总览

| 类型 | 路径 | 方法 | 说明 |
| --- | --- | --- | --- |
| WebSocket | `/ws` | 连接 | 实时对话、图片、工具和知识库桥接 |
| REST | `/health` | GET | 健康检查 |
| REST | `/config` | GET | 客户端能力和默认配置 |
| REST | `/api/auth/register` | POST | 注册独立部署账户 |
| REST | `/api/auth/login` | POST | 登录并获取会话令牌 |
| REST | `/api/auth/me` | GET | 获取当前登录账户 |
| REST | `/api/profile` | GET / PUT | 读取或更新模型配置档案 |
| REST | `/api-client/register` | POST | legacy 客户端注册 |
| REST | `/api-token/*` | 多种 | legacy Token 管理接口 |

## 地址与认证

直接运行后端时：

```text
HTTP:      http://<host>:<port>
WebSocket: ws://<host>:<port>/ws?token=<token>
```

默认端口是 `9089`，默认监听地址是 `0.0.0.0`。如果没有显式设置 `PORT` 且默认端口被占用，服务会尝试候选端口。桌面整合版会把 `HOST=127.0.0.1` 和动态端口注入后端，实际地址以启动日志或客户端状态为准。

WebSocket 在握手阶段校验令牌：

- 本地内置账户：使用 `X-Builtin-Token` 对应的令牌值作为 URL 中的 `token`。
- 独立部署账户：使用登录接口返回的会话令牌。

示例：

```text
ws://127.0.0.1:9089/ws?token=<session-or-builtin-token>
```

令牌无效或缺失时，WebSocket 升级会被拒绝。连接身份由令牌决定，消息中的 `userid` 不会改变当前身份。

## WebSocket 消息

### 普通消息

客户端发送：

```json
{
    "type": "user_message",
    "session_id": "desktop-main",
    "content": "你好，绮莉",
    "images": [],
    "locationScope": null,
    "kbContext": []
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 否 | 客户端通常填写 `user_message`；当前服务主要按内容字段处理 |
| `session_id` | string | 否 | 会话标识；缺省时由服务端生成 |
| `content` | string | 与图片二选一 | 文本内容，不能为空 |
| `images` | string[] | 与文字二选一 | 图片数据或数据 URL；服务端会解码和尺寸检查 |
| `locationScope` | string / null | 否 | 机器人适配器使用的隔离范围 |
| `kbContext` | object[] | 否 | 客户端私人知识库检索结果 |

文本和图片都为空时返回 `INVALID_MESSAGE`。客户端传入的 `userid` 仅为历史字段，不应作为认证或会话身份依据。

### 服务端回复

```json
{
    "type": "pet_response",
    "speech": "主人好呀，今天也一起加油。",
    "action": "idle",
    "mood": "curious",
    "emotion": "happy",
    "source": "model",
    "model": "模型名称",
    "timestamp": 1700000000000
}
```

- `speech`：回复文本。
- `action`、`mood`：桌宠动作和基础情绪。
- `emotion`：可选的情绪动画提示。
- `source`：`model` 或 `fallback`。
- `model`：模型路径可能返回，降级路径通常没有。
- `timestamp`：服务端生成的时间戳。

### 错误回复

```json
{
    "type": "error",
    "code": "MODEL_NOT_CONFIGURED",
    "message": "大模型尚未配置",
    "timestamp": 1700000000000
}
```

当前主要错误码：

| 错误码 | 说明 |
| --- | --- |
| `INVALID_MESSAGE` | 文本和图片均为空 |
| `MODEL_NOT_CONFIGURED` | 当前账户没有完整的模型服务配置 |
| `MODEL_IMAGE_TOO_LARGE` | 图片无法通过服务端尺寸或解码检查 |
| `PROCESS_ERROR` | 未预期的处理错误 |

### 桌面端桥接消息

这些消息由桌面端在已认证连接中使用：

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `register_tools` | 客户端 → 服务端 | 注册桌面端托管工具 |
| `tool_result` | 客户端 → 服务端 | 回传工具执行结果 |
| `register_skills` | 客户端 → 服务端 | 注册技能说明 |
| `register_persona` | 客户端 → 服务端 | 注册用户自定义人格 |
| `kb_response` | 客户端 → 服务端 | 回传私人知识库检索结果 |

服务端可能向客户端发送工具调用或知识库请求，客户端应按 `requestId` 回传对应结果。具体工具字段由注册内容决定。

## REST 接口

### `GET /health`

无需账户认证。

```json
{
    "status": "ok",
    "message": "虚拟桌宠服务运行正常",
    "version": "0.7.2",
    "uptime": 123
}
```

### `GET /config`

无需账户认证。

```json
{
    "default_action": "idle",
    "max_message_length": 200,
    "supports_tts": false,
    "mode": "fallback",
    "version": "0.7.2"
}
```

### `POST /api/auth/register`

用于独立部署服务注册账户：

```json
{
    "username": "alice",
    "password": "请使用足够强的密码"
}
```

成功返回：

```json
{
    "uid": 100000
}
```

程序保留 UID 为 `0-99999`，独立部署注册账户从 `100000` 起分配。不要在示例或日志中使用真实密码。

### `POST /api/auth/login`

请求：

```json
{
    "username": "alice",
    "password": "你的密码"
}
```

成功返回 `uid` 和会话令牌。之后访问账户接口时使用：

```text
Authorization: Bearer <session-token>
```

### `GET /api/auth/me`

使用 Bearer 会话令牌，返回当前登录账户信息。

### `GET /api/profile`

使用以下任一种凭证：

- `X-Builtin-Token: <builtin-token>`
- `Authorization: Bearer <session-token>`

返回当前账户的模型配置档案。密钥只返回掩码和是否已配置状态，不返回完整密钥。

### `PUT /api/profile`

请求示例：

```json
{
    "model": "模型名称",
    "api_endpoint": "https://example.com/v1",
    "token": "新的模型服务密钥"
}
```

模型名和地址可更新；`token` 为空时保留原值。提交真实密钥时请使用 HTTPS，并避免写入日志。

## legacy 接口

以下接口只为旧客户端兼容保留：

- `POST /api-client/register`
- `GET /api-token/status`
- `POST /api-token`
- `POST /api-token/model`
- `POST /api-token/endpoint`
- `POST /api-token/verify`

这些接口需要客户端 ed25519 签名头：

```text
X-Client-Id
X-Client-Timestamp
X-Client-Nonce
X-Client-Signature
```

新客户端和新功能应使用 `/api/auth/*`、`/api/auth/me` 与 `/api/profile`，不要继续扩展 legacy 接口。

## 最小联调

启动服务后，先确认：

```bash
curl http://127.0.0.1:9089/health
curl http://127.0.0.1:9089/config
```

然后使用带令牌的 WebSocket 客户端连接：

```bash
wscat -c "ws://127.0.0.1:9089/ws?token=<session-or-builtin-token>"
```

连接成功后发送 JSON 消息。端口不是 `9089` 时，以服务启动日志显示的端口替换示例值。

## 安全边界

- `.env`、模型密钥、内置令牌、会话密钥、生产数据库和用户数据不得提交到仓库。
- 独立部署建议使用 HTTPS/WSS、反向代理和访问控制，不要直接把管理接口暴露到公网。
- 不要把 `X-Builtin-Token` 用作公网服务的长期认证方案。
- 第三方模型、天气、搜索和知识源服务有各自的费用、速率和使用限制。
