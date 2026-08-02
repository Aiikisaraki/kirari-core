const WebSocket = require("ws");
const { verifySession } = require("../auth/sessionAuth");
const sessionManager = require("../session/sessionManager");
const fallbackService = require("../services/fallbackService");
const aiReplyService = require("../services/aiReplyService");
const {
    createConnectionAiContext,
    cleanupConnectionAiContext,
} = require("../ai/connectionAiContext");

// 本地部署内置账户：uid 0-99999 保留，内置账户 uid=1；其令牌为明文字符串，不走签名会话。
const BUILTIN_UID = 1;
const BUILTIN_TOKEN = process.env.BUILTIN_ACCOUNT_TOKEN || "kirari-local-builtin";

// 从握手请求的 query 中取令牌：ws://host/ws?token=xxx
function extractToken(req) {
    try {
        const reqUrl = new URL(req.url, "http://localhost");
        return reqUrl.searchParams.get("token");
    } catch {
        return null;
    }
}

// 校验令牌，返回 uid；无效返回 null。
// 远程模式：无状态签名会话令牌（verifySession）；本地模式：内置账户明文令牌。
function authenticate(token) {
    if (typeof token !== "string" || !token) return null;
    const uid = verifySession(token);
    if (uid != null) return uid;
    if (token === BUILTIN_TOKEN) return BUILTIN_UID;
    return null;
}

function setupWebSocket(server, options = {}) {
    // requireToken 默认开启；仅测试/特殊部署可显式关闭（关闭后回退到内置账户 uid）。
    const requireToken = options.requireToken !== false;

    const wss = new WebSocket.Server({
        server,
        path: "/ws",
        // 握手阶段（HTTP 升级前）校验令牌：未通过直接拒绝升级，连接根本不会建立。
        verifyClient: (info, cb) => {
            if (!requireToken) return cb(true);
            const uid = authenticate(extractToken(info.req));
            if (uid == null) {
                console.warn("⛔ WS 握手未授权，已拒绝（缺少或无效令牌）");
                return cb(false, 4401, "未授权：缺少或无效的会话令牌");
            }
            info.req.authUid = uid;
            return cb(true);
        },
    });

    wss.on("connection", (ws, req) => {
        // authUid 已由 verifyClient 校验并写入 req；此处仅作兜底（要求令牌时必为已认证 uid）。
        const authUid = (req && req.authUid) || BUILTIN_UID;
        // 客户端真实 IP（用于位置兜底：内网/回环时回退到服务端公网 IP）
        const clientIp = (req && req.socket && req.socket.remoteAddress) || '';
        console.log(`✅ 已认证客户端连接 (uid=${authUid})`);
        let aiContext = null;

        ws.on("message", async (data) => {
            try {
            const message = JSON.parse(data.toString());
            const userMessage = (typeof message.content === 'string' ? message.content : '').trim();
            const images = Array.isArray(message.images)
              ? message.images.filter((x) => typeof x === 'string' && x.trim())
              : [];
            // 机器人适配器子命名空间：客户端在已认证 uid 下创建，用于客人账号记忆隔离；
            // 不传（或 null）表示桌面/owner，复用 api_tokens 的登录 uid 记录。
            const locationScope = typeof message.locationScope === 'string' ? message.locationScope : null;

            if (!userMessage && images.length === 0) {
                return ws.send(
                    JSON.stringify({
                        type: "error",
                        code: "INVALID_MESSAGE",
                        message: "消息不能为空",
                    }),
                );
            }

            // 身份由握手令牌决定（authUid），忽略客户端自报 userid，防止冒用/切换用户。
            const userid = authUid;

            if (!aiContext) {
                console.log(`[WS-PERF] createConnectionAiContext 调用前 @${Date.now()}`);
                aiContext = await createConnectionAiContext(userid);
                console.log(`[WS-PERF] createConnectionAiContext 完成 @${Date.now()}`);
            }

            console.log(`💬 收到消息: "${userMessage || '[图片]'}"（图片 ${images.length} 张）`);
            const _wsT0 = Date.now();
            console.log(`[WS-PERF] 消息接入 @${_wsT0} session=${message.session_id || 'new'}`);

            const sessionId = message.session_id || `session_${Date.now()}`;
            console.log(`[WS-PERF] initSession 前 @${Date.now()}`);
            await sessionManager.initSession(sessionId);
            console.log(`[WS-PERF] initSession 完成 @${Date.now()}`);
            // 存储多模态消息：有图片时 content 存为 [text, image_url] 数组，否则存纯文本。
            const storedContent = images.length
              ? [
                  ...(userMessage ? [{ type: 'text', text: userMessage }] : []),
                  ...images.map((img) => ({ type: 'image_url', image_url: { url: img } })),
                ]
              : userMessage;
            console.log(`[WS-PERF] saveMessage(user) 前 @${Date.now()}`);
            await sessionManager.saveMessage(
                sessionId,
                "user",
                storedContent,
            );
            console.log(`[WS-PERF] saveMessage(user) 完成 @${Date.now()}`);

            let reply;
            try {
                console.log(`[WS-PERF] → getReply 调用前 @${Date.now()} (距接入 ${Date.now()-_wsT0}ms)`);
                reply = await aiReplyService.getReply({
                    aiContext,
                    content: userMessage,
                    images,
                    sessionId,
                    clientIp,
                    locationScope,
                });
                console.log(`[WS-PERF] ← getReply 返回 @${Date.now()} 总耗时 ${Date.now()-_wsT0}ms`);
                } catch (error) {
                    console.error(
                        "⚠️ 模型调用失败，使用兜底回复:",
                        error.message,
                    );
                    reply = fallbackService.getReply({
                        content: userMessage,
                        sessionId,
                        userid,
                    });
                    reply.source = "fallback";
                }

                console.log(`[WS-PERF] saveMessage(assistant) 前 @${Date.now()}`);
                await sessionManager.saveMessage(
                    sessionId,
                    "assistant",
                    reply.speech,
                );
                console.log(`[WS-PERF] saveMessage(assistant) 完成 @${Date.now()}`);

                if (ws.readyState === WebSocket.OPEN && !aiContext.closed) {
                    console.log(`[WS-PERF] ws.send 前 @${Date.now()}`);
                    ws.send(
                        JSON.stringify({
                            type: "pet_response",
                            ...reply,
                            session_id: sessionId,
                            timestamp: Date.now(),
                        }),
                    );
                    console.log(`[WS-PERF] ws.send 完成 @${Date.now()}`);
                }

                console.log(`🤖 发送回复: "${reply.speech}"`);
            } catch (error) {
                console.error("❌ 消息处理错误:", error.message);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            code: "PROCESS_ERROR",
                            message: "服务器处理消息失败",
                        }),
                    );
                }
            }
        });

        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        type: "pet_response",
                        speech: "主人好呀~ (ฅ´ω`ฅ)",
                        action: "wave",
                        mood: "curious",
                        emotion: "wave",
                        timestamp: Date.now(),
                    }),
                );
            }
        }, 1500);

        ws.on("close", () => {
            cleanupConnectionAiContext(aiContext);
            aiContext = null;
            console.log("🔌 客户端断开连接");
        });

        ws.on("error", () => {
            cleanupConnectionAiContext(aiContext);
            aiContext = null;
        });
    });

    return wss;
}

module.exports = { setupWebSocket };
