const crypto = require("crypto");
const apiTokenManager = require("../token/apiTokenManager");
const dbStorage = require("../db/dbStorage");
const { verifySignedRequest } = require("./requestSigner");
const { signSession, verifySession } = require("../auth/sessionAuth");

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
        const { model, api_endpoint, token } = req.body || {};
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
        await dbStorage.setProfile(auth.uid, patch);
        const profile = await dbStorage.getProfile(auth.uid);
        return res.json(profile);
    });
}

module.exports = { setupHttpRoutes };
