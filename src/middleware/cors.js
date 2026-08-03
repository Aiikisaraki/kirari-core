/*
 * CORS 中间件：供独立网页前端（容器/分离部署）跨域调用后端。
 * 通过 env CORS_ORIGINS 控制允许的来源（逗号分隔）；未设置时允许任意来源（开发便利），
 * 但此时不携带凭证头，避免浏览器对 `*` + credentials 的拒绝。
 * 显式配置来源列表时启用 credentials，支持携带 Authorization 头（Bearer）。
 */
const ALLOWED = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ALLOW_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
const ALLOW_HEADERS =
    "Content-Type, Authorization, X-Builtin-Token, X-Client-Id, X-Client-Signature, X-Client-Timestamp, X-Client-Nonce";

module.exports = function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    // 非跨域请求（同源）直接放行，不附加 CORS 头。
    if (!origin) return next();

    let allowOrigin;
    if (ALLOWED.length === 0) {
        allowOrigin = "*";
    } else if (ALLOWED.includes(origin)) {
        allowOrigin = origin;
    }

    if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        // 仅当来源被显式允许时才开启凭证，避免 `*` 配合 credentials 被浏览器拒绝。
        if (allowOrigin !== "*") {
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }
        res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
        res.setHeader("Access-Control-Max-Age", "86400");
    }

    // 预检请求直接返回 204，不进入业务路由。
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
    }
    next();
};
