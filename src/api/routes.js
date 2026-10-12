const crypto = require("crypto");
// 版本号统一来自 package.json，避免 /health、/config 与发版版本漂移。
const { version: APP_VERSION } = require("../../package.json");
const apiTokenManager = require("../token/apiTokenManager");
const dbStorage = require("../db/dbStorage");
const { verifySignedRequest } = require("./requestSigner");
// 组网：本机作为叶子时要改走上行（不在这里 require 组网实现本身，只借它的判定与上行）
const netBootstrap = require("../net/bootstrap");
// 私人知识库片段净化（/v1/chat 的 body.kbContext）
const { sanitizeKbContext } = require("../knowledge/kbContext");
// Web 控制台（单一管理口令鉴权，注册登录已下线）
const { setupConsoleRoutes } = require("./consoleRoutes");
const consoleSite = require("../web/consoleSite");
const { invalidateUserContexts } = require("../websocket/socketServer");

// 保留内置账户：uid 0-99999 为程序内置（本地部署内置账户 uid=0）。
// 单独部署服务端真实用户从 100000 起。
const BUILTIN_UID = 1;
const BUILTIN_TOKEN = process.env.BUILTIN_ACCOUNT_TOKEN || "kirari-local-builtin";

// 解析请求身份：本地部署内置账户（X-Builtin-Token）。
// ⚠️ 注册登录整套已下线（用户拍板）：Bearer 会话令牌不再被接受。
// 远端桌宠的 WebSocket 鉴权走 socketServer 自己的 verifySession，与这里无关。
function resolveAuthUid(req) {
    const builtin = req.get("x-builtin-token");
    if (builtin && builtin === BUILTIN_TOKEN) return { uid: BUILTIN_UID, kind: "builtin" };
    return null;
}

function parseUserid(value) {
    const userid = Number(value);
    return Number.isSafeInteger(userid) && userid > 0 ? userid : null;
}

function parseApiEndpoint(value) {
    if (typeof value !== "string" || value.length > 500) return null;
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol)) return null;
        url.hash = "";
        return `${url.toString().replace(/\/$/, "")}/`;
    } catch {
        return null;
    }
}

async function requireClient(req, res, userid) {
    const clientId = req.get("x-client-id");
    const client = await dbStorage.getClient(clientId);
    if (!client || client.userid !== userid) {
        res.status(401).json({ message: "客户端身份无效" });
        return null;
    }
    const valid = verifySignedRequest({
        clientId,
        publicKey: client.public_key,
        signature: req.get("x-client-signature"),
        method: req.method,
        // 用 originalUrl 而非 path：前端会把 query string（如 ?userid=1）一并签入 path，
        // 而 req.path 会剥离 query，导致规范化字符串不一致、验签失败。
        path: req.originalUrl,
        timestamp: req.get("x-client-timestamp"),
        nonce: req.get("x-client-nonce"),
        body: req.body,
    });
    if (!valid) {
        res.status(401).json({ message: "请求签名无效或已过期" });
        return null;
    }
    return client;
}

function setupHttpRoutes(app) {
    app.get("/health", (_req, res) =>
        res.json({
            status: "ok",
            message: "虚拟桌宠服务运行正常",
            version: APP_VERSION,
            uptime: Math.floor(process.uptime()),
        }),
    );
    app.get("/config", (_req, res) =>
        res.json({
            default_action: "idle",
            max_message_length: 200,
            supports_tts: false,
            mode: "fallback",
            version: APP_VERSION,
        }),
    );

    app.post("/api-client/register", async (req, res) => {
        const userid = parseUserid(req.body.userid);
        const { clientId, publicKey } = req.body;
        if (
            !userid ||
            typeof clientId !== "string" ||
            !/^[a-f0-9-]{16,128}$/i.test(clientId) ||
            typeof publicKey !== "string"
        ) {
            return res.status(400).json({ message: "客户端注册参数无效" });
        }
        const registered = await dbStorage.registerClient(
            clientId,
            userid,
            publicKey,
        );
        if (!registered)
            return res.status(409).json({ message: "客户端已绑定其他身份" });
        return res.json({ registered: true });
    });

    app.get("/api-token/status", async (req, res) => {
        const userid = parseUserid(req.query.userid);
        if (!userid || !(await requireClient(req, res, userid))) return;
        return res.json({
            configured: await dbStorage.hasApiToken(userid),
            ...(await apiTokenManager.getModelConfig(userid)),
        });
    });

    app.post("/api-token", async (req, res) => {
        const userid = parseUserid(req.body.userid);
        const {
            token,
            viewPassword,
            model = "gpt-5.4-mini",
            apiEndpoint,
        } = req.body;
        // 模型地址必须由调用方提供 —— .env 不再提供任何模型配置（模型只走控制台多模型）
        const normalizedEndpoint = parseApiEndpoint(apiEndpoint || "");
        if (
            !userid ||
            typeof token !== "string" ||
            !token ||
            typeof viewPassword !== "string" ||
            !viewPassword ||
            typeof model !== "string" ||
            !model.trim() ||
            model.length > 120 ||
            !normalizedEndpoint
        )
            return res
                .status(400)
                .json({ message: "参数不能为空或模型端点无效" });
        if (!(await requireClient(req, res, userid))) return;
        await apiTokenManager.setApiToken(
            userid,
            token,
            viewPassword,
            req.get("x-client-id"),
            model.trim(),
            normalizedEndpoint,
        );
        const tokenMask = typeof token === "string" && token ? `${token.slice(0, 4)}***${token.slice(-4)}` : "(空)";
        console.log(`[api-token] 模型信息设置成功 userid=${userid} model=${model.trim()} api_endpoint=${normalizedEndpoint} token=${tokenMask}`);
        return res.json({ message: "API令牌设置成功" });
    });

    app.post("/api-token/model", async (req, res) => {
        const userid = parseUserid(req.body.userid);
        const model =
            typeof req.body.model === "string" ? req.body.model.trim() : "";
        if (!userid || !model || model.length > 120)
            return res.status(400).json({ message: "模型名称无效" });
        if (!(await requireClient(req, res, userid))) return;
        if (!(await apiTokenManager.setModelConfig(userid, model)))
            return res.status(404).json({ message: "请先设置API令牌" });
        console.log(`[api-token/model] 模型信息设置成功 userid=${userid} model=${model}`);
        return res.json({ model });
    });
    app.post("/api-token/endpoint", async (req, res) => {
        const userid = parseUserid(req.body.userid);
        const apiEndpoint = parseApiEndpoint(req.body.apiEndpoint);
        if (!userid || !apiEndpoint)
            return res.status(400).json({ message: "模型 API 端点无效" });
        if (!(await requireClient(req, res, userid))) return;
        if (!(await apiTokenManager.setApiEndpoint(userid, apiEndpoint)))
            return res.status(404).json({ message: "请先设置API令牌" });
        console.log(`[api-token/endpoint] 模型信息设置成功 userid=${userid} api_endpoint=${apiEndpoint}`);
        return res.json({ api_endpoint: apiEndpoint });
    });
    app.post("/api-token/verify", async (req, res) => {
        const userid = parseUserid(req.body.userid);
        const { viewPassword } = req.body;
        if (!userid || typeof viewPassword !== "string" || !viewPassword)
            return res.status(400).json({ message: "参数不能为空" });
        if (!(await requireClient(req, res, userid))) return;
        if (!(await apiTokenManager.verifyViewPassword(userid, viewPassword)))
            return res
                .status(403)
                .json({ valid: false, message: "查看密码错误" });
        const tokenData = await apiTokenManager.getApiToken(userid);
        return tokenData
            ? res.json({ valid: true, token: tokenData.token })
            : res.status(404).json({ valid: false, message: "未找到API令牌" });
    });

    // 首页 = 网页控制台（用户拍板：不想记 /console 这段路径）。
    // 控制台没构建过（纯 API 部署）才回落到原来那行服务状态。
    app.get("/", (_req, res) =>
        consoleSite.available() ? consoleSite.sendIndex(res) : res.send("Virtual Pet API is running!"),
    );

    // ---- 账号体系：已整体下线 ----
    // 注册 / 登录 / 会话令牌全部移除（用户拍板「现在没有用户登录注册的概念了」）。
    // 管理面收敛为单一管理口令（见 consoleRoutes.js），机器人接入仍走 BOT_TOKEN。

    // ---- 配置档案（替代旧的 /api-token/*，认证后无感读写）----
    app.get("/api/profile", async (req, res) => {
        const auth = resolveAuthUid(req);
        if (!auth) return res.status(401).json({ message: "未认证" });
        const profile = await dbStorage.getProfile(auth.uid);
        if (!profile) return res.status(404).json({ message: "账户不存在" });
        return res.json(profile);
    });

  app.put("/api/profile", async (req, res) => {
    const auth = resolveAuthUid(req);
    if (!auth) return res.status(401).json({ message: "未认证" });
    // 字段约定与桌面端 config.json 一致（endpoint / key / searchKey ...，camelCase）
    const { model, endpoint, key, searchKey, searchEndpoint, searchProvider } = req.body || {};
    const patch = {};
    if (model !== undefined) {
      if (typeof model !== "string" || !model.trim() || model.length > 120)
        return res.status(400).json({ message: "模型名称无效" });
      patch.model = model.trim();
    }
    if (endpoint !== undefined) {
      const normalized = parseApiEndpoint(endpoint);
      if (!normalized) return res.status(400).json({ message: "模型 API 端点无效" });
      patch.endpoint = normalized;
    }
    if (key !== undefined) {
      if (typeof key !== "string" || !key.trim())
        return res.status(400).json({ message: "Token 不能为空" });
      patch.key = key.trim();
    }
    if (searchKey !== undefined) {
      if (typeof searchKey !== "string" || !searchKey.trim())
        return res.status(400).json({ message: "搜索 API Key 不能为空" });
      patch.searchKey = searchKey.trim();
    }
    if (searchEndpoint !== undefined) {
      if (typeof searchEndpoint !== "string" || !searchEndpoint.trim())
        return res.status(400).json({ message: "搜索服务地址不能为空" });
      // 归一化为不含末尾斜杠的 base URL
      patch.searchEndpoint = searchEndpoint.trim().replace(/\/+$/, '');
    }
    if (searchProvider !== undefined) {
      const allowed = ['uapis', 'tavily', 'searxng'];
      if (typeof searchProvider !== 'string' || !allowed.includes(searchProvider))
        return res.status(400).json({ message: "搜索提供商无效" });
      patch.searchProvider = searchProvider;
    }
    await dbStorage.setProfile(auth.uid, patch);
    // 配置已写入 DB，但用户可能正持有一条 WS 连接，其 aiContext 在首条消息时已用旧配置建好并缓存复用。
    // 立即失效该用户所有活跃 WS 连接的缓存上下文，下一条消息会用新配置重建，无需重启/重连。
    try {
      invalidateUserContexts(auth.uid);
    } catch (invErr) {
      console.warn('[profile] 失效 WS 上下文失败（可忽略，下次重连自动生效）:', invErr?.message || invErr);
    }
    const profile = await dbStorage.getProfile(auth.uid);
    // 模型信息设置成功日志：getProfile 只回掩码，直接用它（不泄明文；原来读 profile?.token 恒为 undefined）
    console.log(
      `[profile] 模型信息设置成功 userid=${auth.uid} ` +
      `model=${profile?.model || '(空)'} endpoint=${profile?.endpoint || '(空)'} ` +
      `searchProvider=${profile?.searchProvider || '(默认)'} key=${profile?.keyMasked || '(空)'}`,
    );
    return res.json(profile);
  });

  // Web 控制台：状态 / 设置 / 聊天（SSE），单一管理口令鉴权
  setupConsoleRoutes(app);

  setupBotChatRoute(app);
}

/**
 * 机器人接入接口：POST /v1/chat
 *
 * 这是「服务器版机器人」的主入口。任何能发 HTTP 请求的机器人框架
 * （OneBot 侧脚本、NoneBot、LangChain、自建 webhook…）都能调用它，
 * 不需要额外适配本项目的协议。
 *
 * 鉴权：Bearer <BOT_TOKEN>。BOT_TOKEN 在 .env 里配置（见 .env.example）。
 *   没配置时本接口直接拒绝并说明原因，不做「默认放行」这种危险兜底。
 *
 * 请求体：
 *   {
 *     "platform": "onebot",          // 可选，平台标识，用于隔离不同平台的同号
 *     "chatType": "group" | "private",
 *     "groupId": "123456",           // 群聊必填
 *     "userId": "789",               // 私聊必填；群聊填了可标识发言人
 *     "nickname": "小明",             // 可选，仅日志用
 *     "content": "今天天气怎么样",     // 必填（或给 images）
 *     "images": ["https://..."],      // 可选
 *     "persona": "自定义人格"          // 可选，不传则用预设
 *   }
 *
 * 响应体：
 *   { "sessionId", "speech", "emotion", "images", "model" }
 */
function setupBotChatRoute(app) {
  const { resolveIdentity } = require("../session/sessionMapping");
  const contextPool = require("../ai/contextPool");
  const aiReplyService = require("../services/aiReplyService");
  const fallbackService = require("../services/fallbackService");
  const sessionManager = require("../session/sessionManager");

  app.post("/v1/chat", async (req, res) => {
    const botToken = String(process.env.BOT_TOKEN || "").trim();
    if (!botToken) {
      return res.status(503).json({
        error: "BOT_TOKEN_NOT_CONFIGURED",
        message: "机器人接入未启用：请在 .env 里设置 BOT_TOKEN（随便一串够长的随机字符），然后重启服务。",
      });
    }
    const auth = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match || match[1].trim() !== botToken) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "接入口令不对。检查请求头 Authorization: Bearer <BOT_TOKEN> 是否与服务端 .env 里一致。",
      });
    }

    const body = req.body || {};
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const images = Array.isArray(body.images)
      ? body.images.filter((x) => typeof x === "string" && x.trim()).slice(0, 9)
      : [];
    if (!content && images.length === 0) {
      return res.status(400).json({
        error: "EMPTY_MESSAGE",
        message: "消息是空的。至少要传 content 或 images 其中之一。",
      });
    }

    // 会话映射：群号 / QQ 号 → 稳定会话 ID。进程重启后同一个群仍然命中同一份上下文。
    let identity;
    try {
      identity = resolveIdentity({
        platform: body.platform,
        chatType: body.chatType,
        groupId: body.groupId,
        userId: body.userId,
        sessionId: body.sessionId,
      });
    } catch (e) {
      return res.status(400).json({
        error: "BAD_CHAT_TARGET",
        message: `${e.message}。群聊请传 groupId，私聊请传 userId。`,
      });
    }

    const who = identity.chatType === "group"
      ? `群 ${identity.groupId}${body.nickname ? `（${String(body.nickname).slice(0, 20)}）` : ""}`
      : `用户 ${identity.userId}${body.nickname ? `（${String(body.nickname).slice(0, 20)}）` : ""}`;

    // 模型配置取自哪个账号：默认用内置账号，运维可在 .env 里改。
    const modelUid = Number(process.env.BOT_MODEL_UID || BUILTIN_UID);

    // 私人知识库随请求携带（客户端本地检索好附上来，后端零存储）。
    // 不带就是 null，公用知识源照常在服务端检索 —— 两条路互不影响。
    const kbContext = sanitizeKbContext(body.kbContext);

    // ── 组网叶子：本机不再调模型，把消息上行给主机 ──
    // 这是活锁模型的核心（ARCHITECTURE-PLAN 3.1「全网只有主机一个出口」），
    // 也是「叶子端不需要配置 Key」的原因：花钱的是主机。
    //
    // ⚠️ 上行成功时**不再本地存一份**：主机那边按 net:<本机设备号>:<sessionId>
    //    记录了这次对话，本地再存一遍只会产生两套会分叉的历史。
    //    上行失败则回退到本机独立处理（组网断掉不该让机器人变砖）。
    if (netBootstrap.shouldUplink()) {
      const up = await netBootstrap.uplinkChat({
        sessionId: identity.sessionId,
        content,
        images,
        kbContext,
      });
      if (up.ok) {
        console.log(`[bot] ${who}: "${content.slice(0, 40)}"（图片 ${images.length} 张）→ 已由组网主机回复`);
        return res.json({
          sessionId: identity.sessionId,
          speech: up.frame.speech,
          emotion: up.frame.emotion ?? null,
          // 组网回包协议目前只带 speech / emotion，不带图片
          images: [],
          model: "（组网主机）",
        });
      }
      console.warn(`[bot] 上行组网主机失败（${up.reason}），回退到本机独立处理`);
    }

    let reply;
    try {
      const aiContext = await contextPool.getContext(modelUid);
      await sessionManager.initSession(identity.sessionId);
      // 多模态：带图时 content 存为数组，模型才能看到图
      const storedContent = images.length
        ? [
            ...(content ? [{ type: "text", text: content }] : []),
            ...images.map((img) => ({ type: "image_url", image_url: { url: img } })),
          ]
        : content;
      await sessionManager.saveMessage(identity.sessionId, "user", storedContent);

      console.log(`[bot] ${who}: "${content.slice(0, 40)}"（图片 ${images.length} 张）`);
      reply = await aiReplyService.getReply({
        aiContext,
        content,
        images,
        sessionId: identity.sessionId,
        // 位置记忆按 scope 隔离：同一群共享一份位置
        locationScope: identity.scope,
        persona: typeof body.persona === "string" ? body.persona : null,
        skillPrompts: [],
        kbContext,
        ws: null,
      });
      await sessionManager.saveMessage(identity.sessionId, "assistant", reply.speech);
    } catch (error) {
      const reason = error?.message || String(error);
      console.error(`[bot] ${who} 处理失败:`, reason);
      // 配置类错误直接告诉运维怎么改；其余错误让机器人也能有个兜底回复，不至于在群里装死。
      const isConfigError = /未配置|尚未配置|还没连接|还没填写|还没选择/.test(reason);
      if (isConfigError) {
        return res.status(503).json({ error: "MODEL_NOT_CONFIGURED", message: reason });
      }
      reply = fallbackService.getReply({ content, persona: null });
      reply = { ...reply, images: [] };
    }

    return res.json({
      sessionId: identity.sessionId,
      speech: reply.speech,
      emotion: reply.emotion ?? null,
      images: Array.isArray(reply.images) ? reply.images : [],
      model: reply.model || "",
    });
  });
}

module.exports = { setupHttpRoutes };
