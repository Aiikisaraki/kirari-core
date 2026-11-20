const WebSocket = require("ws");
const ownerIdentity = require("../services/ownerIdentity");
const { verifySession } = require("../auth/sessionAuth");
const sessionManager = require("../session/sessionManager");
const fallbackService = require("../services/fallbackService");
const aiReplyService = require("../services/aiReplyService");
const toolsModule = require("../tools");
const capabilities = require("../capabilities/registry");
const { createConnectionAiContext, cleanupConnectionAiContext } = require("../ai/connectionAiContext");
const { createFrontendToolBridge } = require("../tools/bridge");
const { normalizeImages } = require("./imageNormalizer");

// 全局 WebSocket.Server 实例引用（setupWebSocket 内赋值），供 invalidateUserContexts
// 在 HTTP 路由层（/api/profile 保存成功后）跨模块遍历并失效指定用户的缓存上下文。
let wss = null;

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

    wss = new WebSocket.Server({
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
        // ── 2026-11-20 身份排查：本机可信入口的判定 ────────────────────
        // 桌面 WS 连接全都是同一个内置账号 uid=1，uid 区分不了人。但**握手用的令牌**
        // 可以区分「这台机器自己的桌面」和「拿着令牌从别处连进来的客户端」：
        //   · 内置令牌（BUILTIN_ACCOUNT_TOKEN）只写在桌面端本机配置里
        //   · 握手还要求来自回环/内网地址
        // 两者同时满足才认定 trustedLocal。这条不再靠 sessionId 前缀猜（那是原来的 bug）。
        const tokenWasBuiltin =
            String(extractToken(req) || '') !== '' &&
            String(extractToken(req) || '') === BUILTIN_TOKEN;
        const fromLocalAddr = /^(127\.|::1|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
            String(clientIp || ''),
        );
        ws.trustedLocal = tokenWasBuiltin && fromLocalAddr;
        console.log(`✅ 已认证客户端连接 (uid=${authUid})${ws.trustedLocal ? ' [本机]' : ''}`);
        ws.authUid = authUid; // 供 invalidateUserContexts 按 uid 精确匹配连接
        // ── 2026-11-20 身份排查（A1）：桌面连接「当前在跟谁联动」────────────────
        // 空串 = 没联动任何具体的人（纯本机使用）。这个值决定定向推送能不能落到
        // 这条连接上，见 pushProactiveMessageToOwner。
        //
        // ⚠️ 老实现里这个字段**从来没有被赋过值**（全项目零个赋值点），
        //    于是下面推送过滤永远走 `cp` 为空那条分支 → 等于「谁是主人就推给谁」
        //    → 语义上退化成广播。
        //
        // 这个值只反映**本体状态**（本机自用 = 空），不接受客户端上报：
        // 桌面的身份由握手（内置令牌 + 内网来源）决定，不由连接自己说。
        ws.counterpartId = '';
        // 阶段 D：每条连接一个唯一能力作用域，frontend 工具按此隔离，互不覆盖。
        ws.__capScopeId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        ws.__capScope = capabilities.scopeKey('ws', ws.__capScopeId);
        ws.aiContext = null;
        // 前端托管工具（MCP server / skill 提供的工具）schema 列表，由前端通过
        // register_tools 消息上报；后端把它们并入模型的 function-calling 工具集。
        ws.frontendTools = [];
        ws.skillPrompts = [];
        ws.persona = null;
        // 私人知识库反向请求：记录待前端回复的请求（requestId → { resolve, reject, timer }）
        ws.kbRequests = new Map();
        // 前端托管工具桥：管理「后端请求 → Electron 主进程执行 → 结果回传」的配对与超时。
        const toolBridge = createFrontendToolBridge(ws);
        ws.toolBridge = toolBridge;

        ws.on("message", async (data) => {
            try {
            const message = JSON.parse(data.toString());

            // ── 前端托管工具：注册 / 结果回传（不是聊天消息，单独处理）──
            if (message.type === 'register_tools') {
                const list = Array.isArray(message.tools) ? message.tools : [];
                ws.frontendTools = list.filter(
                    (t) => t && t.function && typeof t.function.name === 'string',
                );
                // 阶段 D：按连接作用域注册 schema + 执行器（替换旧 setFrontendTools 全局覆盖，
                // 那是多客户端串线的根因）。执行器是 (name, args) → 该连接的 toolBridge。
                capabilities.registerConnection(
                    ws.__capScope,
                    ws.frontendTools,
                    (toolName, args) => ws.toolBridge.invokeFrontendTool(toolName, args),
                );
                console.log(`🔧 前端注册工具 ${ws.frontendTools.length} 个 (scope=${ws.__capScope}): ${ws.frontendTools.map((t) => t.function.name).join(', ')}`);
                return;
            }
            if (message.type === 'register_skills') {
                const prompts = Array.isArray(message.prompts) ? message.prompts : [];
                ws.skillPrompts = prompts.filter((p) => typeof p === 'string' && p.trim());
                console.log(`🧩 前端注册技能指令 ${ws.skillPrompts.length} 条`);
                return;
            }
            // 基础人格：用户自定义的基础人格文本（自由段落）。为空则后端回退到预设人格。
            // 所有回答（含工具润色、降级）都基于此人格，与所选模型无关，避免人格偏移。
            if (message.type === 'register_persona') {
                const p = typeof message.persona === 'string' ? message.persona : '';
                ws.persona = p.trim() ? p : null;
                console.log(`🎭 前端注册基础人格：${ws.persona ? '自定义人格（已应用）' : '预设人格'}`);
                return;
            }
            // 私人知识库响应：前端本地检索完成，回传结果给后端等待中的检索请求
            if (message.type === 'kb_response') {
                const rid = message.requestId;
                if (typeof rid === 'string' && ws.kbRequests.has(rid)) {
                    const pend = ws.kbRequests.get(rid);
                    clearTimeout(pend.timer);
                    ws.kbRequests.delete(rid);
                    const results = Array.isArray(message.results) ? message.results : [];
                    pend.resolve(results);
                }
                return;
            }
            // 前端工具执行结果回传：交给工具桥配对并 resolve 对应 Promise。
            if (message.type === 'tool_result') {
                toolBridge.handleToolResult(message);
                return;
            }

            const userMessage = (typeof message.content === 'string' ? message.content : '').trim();
            let images = Array.isArray(message.images)
              ? message.images.filter((x) => typeof x === 'string' && x.trim())
              : [];
            // 机器人适配器子命名空间：客户端在已认证 uid 下创建，用于客人账号记忆隔离；
            // 不传（或 null）表示桌面/owner，复用 api_tokens 的登录 uid 记录。
            const locationScope = typeof message.locationScope === 'string' ? message.locationScope : null;
            // 私人知识库上下文：前端本地检索后主动携带的结果（优先用此，减轻反向拉取延迟）
            const kbContext = Array.isArray(message.kbContext) ? message.kbContext : null;

            if (!userMessage && images.length === 0) {
                return ws.send(
                    JSON.stringify({
                        type: "error",
                        code: "INVALID_MESSAGE",
                        message: "消息不能为空",
                    }),
                );
            }

            // 图片兜底：客户端已自动压缩，这里用 sharp 在服务端做真实解码 + 像素级缩放，
            // 避免超大原图（绕过客户端直连 / 极端大图）喂给模型导致推理失败。
            const imageGate = await normalizeImages(images);
            if (imageGate.error) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            code: "MODEL_IMAGE_TOO_LARGE",
                            message: imageGate.error,
                        }),
                    );
                }
                return;
            }
            images = imageGate.images;

            // 身份由握手令牌决定（authUid），忽略客户端自报 userid，防止冒用/切换用户。
            const userid = authUid;

            if (!ws.aiContext) {
                console.log(`[WS-PERF] createConnectionAiContext 调用前 @${Date.now()}`);
                try {
                    ws.aiContext = await createConnectionAiContext(userid);
                } catch (ctxErr) {
                    // 大模型未配置（缺 API Token / 模型名称 / Endpoint）属于配置缺失，
                    // 应向前端返回明确、可操作的错误，而不是让外层 catch 兜底成笼统的
                    // “服务器处理消息失败”，更不是只留在后端日志里。
                    const reason = ctxErr && ctxErr.message ? ctxErr.message : '大模型尚未配置';
                    console.warn(`⚠️ 用户 ${userid} 大模型未配置：${reason}`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: 'error',
                                code: 'MODEL_NOT_CONFIGURED',
                                message: `大模型尚未配置（${reason}）。请先在「设置 → 模型」中填写 API 地址、模型名称与密钥，保存后即可对话。`,
                            }),
                        );
                    }
                    return;
                }
                // 把「前端托管工具执行器」挂到 aiContext，供 aiReplyService 的 tool loop 回调。
                ws.aiContext.invokeFrontendTool = toolBridge.invokeFrontendTool;
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
                    aiContext: ws.aiContext,
                    content: userMessage,
                    images,
                    sessionId,
                    clientIp,
                    locationScope,
                    skillPrompts: ws.skillPrompts || [],
                    persona: ws.persona || null,
                    kbContext,
                    ws,
                    scopeId: ws.__capScope, // 阶段 D：能力作用域，前端工具按连接隔离
                    // ── 2026-11-20 身份排查（A3）：WS 入口原来**不传 scene** ──────
                    // 后果：下游拿到 role/isOwner/counterpartId 全是 null，于是
                    //   · selfOps.roleOf 走 sessionId 前缀兜底 → 误判 owner
                    //   · memory.resolveIdentity 把 session_<ts> 当成"一个新的人"
                    //   · 本机自己的桌面被当成"没有身份的陌生人"
                    // 这里显式补上。
                    //
                    // ⚠️ 桌面连接的身份**只由握手决定**（内置令牌 + 内网来源），
                    //    不由连接自己上报。桌宠只有这一台，连上它的就是主人本人；
                    //    别人的话是通过 QQ 那些人際渠道进来的，走的是别的入口。
                    //    所以这里不需要"替别人说话"的分支 —— 曾经设想过，但那会造出
                    //    「senderId 是别人、role 却是 owner」的组合，正是用户最担心的
                    //    「她以为自己是主人，任务真的向我执行」。
                    // 本机主人入口与网页控制台 / 主人 QQ 私聊用同一个身份键。
                    // 这里必须由握手（trustedLocal）认定，不接受客户端自报身份。
                    scene: ws.trustedLocal
                        ? ownerIdentity.ownerScene({ platform: 'desktop' })
                        : {
                              chatType: 'remote',
                              isGroup: false,
                              isOwner: false,
                              role: 'user',
                              senderId: `ws-${ws.authUid || 'anon'}`,
                              senderName: '',
                              platform: 'desktop',
                          },
                    trustedLocal: ws.trustedLocal === true,
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
                        persona: ws.persona || null,
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

                if (ws.readyState === WebSocket.OPEN && !ws.aiContext.closed) {
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
                        speech: "在的。",
                        action: "wave",
                        mood: "curious",
                        emotion: "wave",
                        timestamp: Date.now(),
                    }),
                );
            }
        }, 1500);

        ws.on("close", () => {
            // 拒绝所有未完成的前端工具调用，避免 Promise 永久挂起。
            if (ws.toolBridge) {
                ws.toolBridge.clearPending('WS 连接关闭，前端工具调用中断');
            }
            // 阶段 D：注销该连接的能力作用域，避免工具/schema 残留到后续连接。
            if (ws.__capScope) capabilities.unregisterConnection(ws.__capScope);
            cleanupConnectionAiContext(ws.aiContext);
            ws.aiContext = null;
            console.log("🔌 客户端断开连接");
        });

        ws.on("error", () => {
            if (ws.toolBridge) {
                ws.toolBridge.clearPending('WS 连接出错，前端工具调用中断');
            }
            if (ws.__capScope) capabilities.unregisterConnection(ws.__capScope);
            cleanupConnectionAiContext(ws.aiContext);
            ws.aiContext = null;
        });
    });

    return wss;
}

// 失效指定用户所有活跃 WS 连接的缓存 AI 上下文。
// 调用时机：用户通过 /api/profile 修改模型/token/端点后，配置已写入 DB，
// 但 WS 连接在首次消息时已用旧配置建好 aiContext 并缓存复用，不失效则改动要等重连才生效。
// 这里主动把该用户每个 open 连接的 ws.aiContext 清空，下一条消息会用新配置重建。
function invalidateUserContexts(uid) {
    if (!wss) return;
    let n = 0;
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client.authUid === uid && client.aiContext) {
            cleanupConnectionAiContext(client.aiContext);
            client.aiContext = null;
            n++;
        }
    }
    if (n) {
        console.log(`[ws] 已为用户 ${uid} 失效 ${n} 个缓存的 AI 上下文（模型配置已更新，下条消息将用新配置重建）`);
    }
}

// 向前端发起私人知识库检索请求，等待 kb_response 回传结果（Promise + 超时）。
// 用于 DBKnowledgeSource 在请求未携带 kbContext 时，fallback 从前端实时拉取。
// @param ws WebSocket 连接（已建立并注册 kbRequests Map）
// @param query 检索词
// @param timeout 超时毫秒（默认 3000）
// @returns Promise<Array<{text, source, score, tier, priority}>>，超时/失败返回 []
function requestKnowledgeFromFrontend(ws, query, timeout = 3000) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve([]);
    }
    return new Promise((resolve) => {
        const requestId = `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
            ws.kbRequests.delete(requestId);
            console.warn(`[kb] 前端知识库请求超时 requestId=${requestId}`);
            resolve([]);
        }, timeout);
        ws.kbRequests.set(requestId, { resolve, timer });
        try {
            ws.send(JSON.stringify({ type: 'kb_request', requestId, query }));
        } catch (e) {
            clearTimeout(timer);
            ws.kbRequests.delete(requestId);
            console.error('[kb] 发送 kb_request 失败:', e);
            resolve([]);
        }
    });
}

// 阶段 C：向某 uid 的所有活跃连接主动推送一条提醒（定时任务到点触发）。
// 不经过 getReply——提醒内容已在 scheduled_jobs.payload 里，直接以 pet_response 形状送达，
// 桌宠端收到后按既有协议渲染。返回送达的连接数。
//
// ⚠️ 2026-11-20 身份排查：这个函数按 uid 匹配，而 uid 对 QQ 上所有人都是同一个账号
// id（BOT_MODEL_UID=1），所以它实际是**广播**：朋友建的任务，结果会推给所有开着
// 桌宠的人。调用方如果明确知道这条消息属于某个人，必须用下面的
// pushProactiveMessageToOwner 或按 sessionId 精确投递，别直接用这个。
function pushProactiveMessage(uid, message) {
    if (!wss || !message) return 0;
    let n = 0;
    const payload = JSON.stringify({
        type: "pet_response",
        speech: String(message.speech || message.text || ''),
        action: message.action || 'idle',
        mood: message.mood || 'curious',
        emotion: message.emotion || 'happy',
        source: 'scheduled_reminder',
        session_id: message.sessionId,
        timestamp: Date.now(),
    });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && client.authUid === uid) {
            try { client.send(payload); n++; } catch (e) {
                console.warn('[ws] 主动提醒推送失败:', e?.message || e);
            }
        }
    }
    return n;
}

/**
 * 只推给「主人这个人的桌宠」，不推给别人的。
 *
 * ── 这里到底在防什么（2026-11-20 用户澄清后重写）────────────────────
 *   「桌面端本就只有主人能连，这是我自己的桌宠，机器人是它的智能核心，
 *     别人怎么可能连接我的机器人的大脑呢」
 *
 * 说得对，所以这道闸要防的**不是"别人的桌面"**（那东西不存在），而是：
 *
 *   桌宠只有一台，但她在 QQ 上跟很多人说话。朋友的提醒到点时，
 *   如果直接推给"所有桌面连接"，那条本该送去 QQ 的提醒就会**在她自己的
 *   桌面上弹出来** —— 用户看到的是「她的任务怎么跑到我这儿来了」。
 *
 * 所以判据是「这条消息归谁」对不对得上「这台桌面归谁」，而不是「连接属于谁」：
 *   · 本机自用的推送（_local）  → 桌面收
 *   · 主人自己的提醒            → 桌面收
 *   · 朋友的提醒                → 桌面**不收**，走平台那条腿回给朋友
 *
 * @param {string} ownerKey 这条消息的归属人（QQ 号/openid）
 * @param {Object} message { speech/text, sessionId, ... }
 * @returns {number} 送达的连接数
 */
/**
 * 一条桌面连接该不该收到「发给 want 的这条消息」？
 *
 * 抽成纯函数是为了能直接测 —— 这段判断是整个定向推送的唯一闸门，
 * 而它曾经因为 `client.counterpartId` 从来没被赋值而恒定放行（=广播）。
 * 用真实 wss 测太绕（要起 http server + 手搓握手），把语义单独拎出来更可靠。
 *
 * @param {Object} p
 *   want           这条消息的归属人（'_local' 表示本机/控制台）
 *   cp             这条连接当前的联动对象（本体状态；不会是别人手动上报的）
 *   trustedLocal   这条连接是不是本机可信连接（握手通过内置令牌 + 内网来源）
 *   ownerOfSystem  系统里谁是主人（people 表里 role='owner' 的那位）
 * @returns {boolean}
 */
function shouldDeliverToConn({ want, cp, trustedLocal, ownerOfSystem }) {
    // ── 2026-11-20 规范化：身份比较只走 samePerson ────────────────────────
    // 原来这里是手写的
    //   const isOwnerMessage = want === ownerKey || want === FALLBACK
    //   if (isOwnerMessage && (cpKey === ownerKey || cpKey === FALLBACK))
    // 每多一种历史写法就要再补一个 ||，补漏一处就又出一次「提醒没送到」。
    // 现在统一交给 ownerIdentity.samePerson：两侧都先归一再比。
    //
    // ⚠️ 归一必须**以调用方给的 ownerOfSystem 为基准**（第三个参数）。
    // 不能让它去读本机 people 表：这个函数是纯函数、要能单测，
    // 而且「按传进来的 owner 判断主人」和「按进程里那份 owner 归一」
    // 两套基准打架时，会把人判成两个 —— 正是要根治的那种 bug。
    const asOwner = String(ownerOfSystem || '').trim();

    // 这条消息是不是发给主人的（_local / UUID / 规范键都认）
    const isOwnerMessage = !!asOwner && ownerIdentity.samePerson(want, asOwner, asOwner);

    // 这条连接正在替某个具体的人说话：只有对得上才收。
    // 主人自己的联动连接记的也是规范 owner 键，所以主人消息仍只对主人连接可见。
    if (cp) {
        if (isOwnerMessage && ownerIdentity.samePerson(cp, asOwner, asOwner)) {
            return !!trustedLocal;
        }
        return ownerIdentity.samePerson(cp, want, asOwner);
    }

    // 没在替谁说话（= 没上报联动、纯本机使用）：只有**主人自己的**消息才上桌面。
    // 不能反过来"没联动就都收" —— 那正是把朋友的提醒送进主人桌面的错逻辑。
    // 这里必须是本机可信连接（内置令牌 + 内网握手）。
    return isOwnerMessage && !!trustedLocal;
}

function pushProactiveMessageToOwner(ownerKey, message) {
    if (!wss || !message) return 0;
    const want = String(ownerKey || '').trim();
    if (!want) {
        console.warn('[ws] 推送被拒：不知道这条消息属于谁（ownerKey 为空）');
        return 0;
    }
    let n = 0;
    const payload = JSON.stringify({
        type: "pet_response",
        speech: String(message.speech || message.text || ''),
        action: message.action || 'idle',
        mood: message.mood || 'curious',
        emotion: message.emotion || 'happy',
        source: 'scheduled_reminder',
        session_id: message.sessionId,
        owner: want,
        timestamp: Date.now(),
    });
    let skipped = 0;
    // 系统里谁是主人？用于判断「没有上报联动的本机桌面」能不能收这条消息。
    // 查不到 owner 记录（全新装机）→ 视为没有主人，未上报连接的桌面一律不收，
    // 宁可少推一条也不误投（fail-closed）。
    let ownerOfSystem = null;
    try {
        const dbStorage = require('../db/dbStorage');
        if (typeof dbStorage.getOwnerKeySync === 'function') ownerOfSystem = dbStorage.getOwnerKeySync();
    } catch {
        ownerOfSystem = null;
    }

    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        // 桌面连接的归属：
        //   cp 有值   → 这台桌面正在替 cp 这个人联动，只能收 cp 自己的消息
        //   cp 为空   → 没上报联动（纯本机自用或还没上报）。**不能默认算主人**，
        //               要看这条消息是不是主人的，并且这条连接得是本机可信连接。
        //
        // ⚠️ A1：修复前 client.counterpartId 全项目零个赋值点，cp 恒为空，
        //    两个分支都放行 → 定向推送退化成广播，朋友的任务提醒全落到主人桌面。
        const cp = String(client.counterpartId || '').trim();
        // 取舍全部收在 shouldDeliverToConn 里（可单测），这里只负责发。
        if (!shouldDeliverToConn({ want, cp, trustedLocal: client.trustedLocal, ownerOfSystem })) {
            skipped++;
            continue;
        }

        try { client.send(payload); n++; } catch (e) {
            console.warn('[ws] 定向推送失败:', e?.message || e);
        }
    }
    // 有连接但全被归属过滤挡掉时，留一行可诊断日志（以前这种情况完全静默，
    // 只能靠"用户说没收到"来发现问题）。
    if (n === 0 && skipped > 0) {
        console.log(
            `[ws] 定向推送 owner=${want}：${skipped} 个连接因归属不符被跳过（未误投）`,
        );
    }
    return n;
}

module.exports = {
    setupWebSocket,
    invalidateUserContexts,
    requestKnowledgeFromFrontend,
    // ⚠️ 2026-11-20 身份排查（A4）：这里**故意不再导出** pushProactiveMessage。
    // 那个函数按 uid 匹配连接，而 uid 对 QQ 上所有人都是同一个账号（BOT_MODEL_UID=1），
    // 所以它语义上等于「广播给所有桌面」——朋友建的任务会推到每位主人的桌宠上。
    // 现在只导出定向投递：调用方必须指明这条消息属于谁，说不出来就推不出去。
    // 内部如有本机广播需求，请通过 pushProactiveMessageToOwner('_local', ...)。
    pushProactiveMessageToOwner,
    /** 定向推送的过滤判据（纯函数，供测试与审计复核） */
    shouldDeliverToConn,
};
