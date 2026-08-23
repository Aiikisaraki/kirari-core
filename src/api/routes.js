const crypto = require("crypto");
const apiTokenManager = require("../token/apiTokenManager");
const dbStorage = require("../db/dbStorage");
const { verifySignedRequest } = require("./requestSigner");
const { signSession, verifySession } = require("../auth/sessionAuth");
const { invalidateUserContexts } = require("../websocket/socketServer");

// 保留内置账户：uid 0-99999 为程序内置（本地部署内置账户 uid=0）。
// 单独部署服务端真实用户从 100000 起。
const BUILTIN_UID = 1;
const BUILTIN_TOKEN = process.env.BUILTIN_ACCOUNT_TOKEN || "kirari-local-builtin";

// 解析请求身份：本地部署内置账户（X-Builtin-Token）或远程会话令牌（Bearer）。
function resolveAuthUid(req) {
    const builtin = req.get("x-builtin-token");
    if (builtin && builtin === BUILTIN_TOKEN) return { uid: BUILTIN_UID, kind: "builtin" };
    const auth = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match) {
        const uid = verifySession(match[1]);
        if (uid != null) return { uid, kind: "session" };
    }
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
            version: "1.0.0",
            uptime: Math.floor(process.uptime()),
        }),
    );
    app.get("/config", (_req, res) =>
        res.json({
            default_action: "idle",
            max_message_length: 200,
            supports_tts: false,
            mode: "fallback",
            version: "1.0.0",
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
        const normalizedEndpoint = parseApiEndpoint(
            apiEndpoint ||
                process.env.MODEL_API_ENDPOINT ||
                "https://api.chatanywhere.tech/v1",
        );
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

    app.get("/", (_req, res) => res.send("Virtual Pet API is running!"));

    // ---- 用户私有知识库（Layer 1，最高优先级；前端"知识库"设置页录入）----
    app.get("/api/knowledge", async (req, res) => {
        const auth = resolveAuthUid(req);
        if (!auth) return res.status(401).json({ message: "未认证" });
        if (!(await requireClient(req, res, auth.uid))) return;
        const category =
            typeof req.query.category === "string" && req.query.category.trim()
                ? req.query.category.trim().slice(0, 50)
                : undefined;
        const entries = await dbStorage.getKnowledgeEntries(auth.uid, {
            category,
            limit: 200,
        });
        return res.json({ entries });
    });

    app.post("/api/knowledge", async (req, res) => {
        const auth = resolveAuthUid(req);
        if (!auth) return res.status(401).json({ message: "未认证" });
        if (!(await requireClient(req, res, auth.uid))) return;
        const { title, content, category, tags, source } = req.body || {};
        if (
            typeof title !== "string" ||
            !title.trim() ||
            typeof content !== "string" ||
            !content.trim()
        )
            return res.status(400).json({ message: "标题和内容不能为空" });
        const id = await dbStorage.addKnowledgeEntry(auth.uid, {
            title: title.trim().slice(0, 200),
            content: content.trim().slice(0, 8000),
            category:
                typeof category === "string" && category.trim()
                    ? category.trim().slice(0, 50)
                    : null,
            tags: Array.isArray(tags)
                ? tags.map((t) => String(t).slice(0, 50)).slice(0, 20)
                : [],
            source:
                typeof source === "string" && source.trim()
                    ? source.trim().slice(0, 50)
                    : null,
        });
        if (!id) return res.status(400).json({ message: "保存失败" });
        return res.json({ id, message: "已保存" });
    });

    app.delete("/api/knowledge", async (req, res) => {
        const auth = resolveAuthUid(req);
        if (!auth) return res.status(401).json({ message: "未认证" });
        if (!(await requireClient(req, res, auth.uid))) return;
        const id = Number(
            req.body?.id ?? (typeof req.query.id === "string" ? req.query.id : undefined),
        );
        if (!Number.isSafeInteger(id) || id <= 0)
            return res.status(400).json({ message: "无效的条目 id" });
        const ok = await dbStorage.deleteKnowledgeEntry(auth.uid, id);
        return res.json({ deleted: ok });
    });

    // ---- 账号体系（独立部署服务端时使用）----
    app.post("/api/auth/register", async (req, res) => {
        const { username, password } = req.body || {};
        if (typeof username !== "string" || username.length < 3 || username.length > 32)
            return res.status(400).json({ message: "用户名需 3-32 个字符" });
        if (typeof password !== "string" || password.length < 6)
            return res.status(400).json({ message: "密码至少 6 位" });
        const uid = await dbStorage.registerUser(username, password);
        if (!uid) return res.status(409).json({ message: "用户名已被占用" });
        return res.json({ uid });
    });

    app.post("/api/auth/login", async (req, res) => {
        const { username, password } = req.body || {};
        if (typeof username !== "string" || typeof password !== "string")
            return res.status(400).json({ message: "参数无效" });
        const uid = await dbStorage.verifyUser(username, password);
        if (uid == null) return res.status(401).json({ message: "用户名或密码错误" });
        return res.json({ uid, sessionToken: signSession(uid) });
    });

    // 当前登录用户态：供桌宠在分离（远端）模式下登录后拉取自身信息（如用户名）。
    // 鉴权方式与 /api/profile 一致（内置账户 X-Builtin-Token 或 Bearer 会话令牌）。
    app.get("/api/auth/me", async (req, res) => {
        const auth = resolveAuthUid(req);
        if (!auth) return res.status(401).json({ message: "未认证" });
        const profile = await dbStorage.getProfile(auth.uid);
        if (!profile) return res.status(404).json({ message: "账户不存在" });
        return res.json(profile);
    });

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
    const { model, api_endpoint, token, search_key, search_endpoint, search_provider } = req.body || {};
    const patch = {};
    if (model !== undefined) {
      if (typeof model !== "string" || !model.trim() || model.length > 120)
        return res.status(400).json({ message: "模型名称无效" });
      patch.model = model.trim();
    }
    if (api_endpoint !== undefined) {
      const normalized = parseApiEndpoint(api_endpoint);
      if (!normalized) return res.status(400).json({ message: "模型 API 端点无效" });
      patch.api_endpoint = normalized;
    }
    if (token !== undefined) {
      if (typeof token !== "string" || !token.trim())
        return res.status(400).json({ message: "Token 不能为空" });
      patch.token = token.trim();
    }
    if (search_key !== undefined) {
      if (typeof search_key !== "string" || !search_key.trim())
        return res.status(400).json({ message: "搜索 API Key 不能为空" });
      patch.search_key = search_key.trim();
    }
    if (search_endpoint !== undefined) {
      if (typeof search_endpoint !== "string" || !search_endpoint.trim())
        return res.status(400).json({ message: "搜索服务地址不能为空" });
      // 归一化为不含末尾斜杠的 base URL
      patch.search_endpoint = search_endpoint.trim().replace(/\/+$/, '');
    }
    if (search_provider !== undefined) {
      const allowed = ['uapis', 'tavily', 'searxng'];
      if (typeof search_provider !== 'string' || !allowed.includes(search_provider))
        return res.status(400).json({ message: "搜索提供商无效" });
      patch.search_provider = search_provider;
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
    // 模型信息设置成功日志：输出用户与模型信息（token 仅打印掩码，避免泄露明文）。
    const tokenMask = profile?.token ? `${profile.token.slice(0, 4)}***${profile.token.slice(-4)}` : '(空)';
    console.log(
      `[profile] 模型信息设置成功 userid=${auth.uid} ` +
      `model=${profile?.model || '(空)'} api_endpoint=${profile?.api_endpoint || '(空)'} ` +
      `search_provider=${profile?.search_provider || '(默认)'} token=${tokenMask}`,
    );
    return res.json(profile);
  });
}

module.exports = { setupHttpRoutes };
