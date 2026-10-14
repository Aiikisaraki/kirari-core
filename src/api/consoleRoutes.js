// src/api/consoleRoutes.js
// Web 控制台后端（阶段 5）。
//
// 鉴权模型（用户拍板）：**注册登录整套下线**，收敛成单一管理口令。
//   - .env 里配 ADMIN_PASSWORD（不配 = 控制台整体禁用，接口返回 503 并说明）
//   - 请求头 X-Admin-Token: <ADMIN_PASSWORD>
//   为什么默认禁用而不是「没配就放行」：控制台能改模型凭证、能读聊天，
//   裸奔等于把大脑钥匙挂在门上。宁可 503 让运维去配，不做危险兜底。
//
// 接口一览：
//   GET  /api/status    服务状态（版本 / 运行时长 / 组网 / 大脑是否就绪）
//   GET  /api/settings  读模型配置（token 打码）
//   PUT  /api/settings  写模型配置（即机器人那份 profile）
//   POST /api/chat      聊天（SSE 事件流）

const crypto = require("crypto");
const dbStorage = require("../db/dbStorage");
const { invalidateUserContexts } = require("../websocket/socketServer");
const { invalidate: invalidateCtx } = require("../ai/contextPool");
const netBootstrap = require("../net/bootstrap");
const { sanitizeKbContext } = require("../knowledge/kbContext");
const modelConfigFile = require("../services/modelConfigFile");
// 智能机器人助手本体的各能力模块（用户拍板：桌宠版的聊天功能核心版全都有）
const userKnowledge = require("../knowledge/userKnowledge");
const mcpManager = require("../mcp/mcpManager");
const botManager = require("../bot/botManager");
const clientConfig = require("../settings/clientConfig");
const consoleAppearance = require("../settings/consoleAppearance");
const localSession = require("../session/localSession");
const { dataDir } = require("../dataDir");
// 说明：头像上传走 JSON（base64，最大 5MB 图片→约 6.7MB 文本），体积限制在
// app.js 里对 /api/avatar/user 单独放宽，其余接口维持 express.json 的默认 100kb。

// 控制台管理的配置归属：与机器人聊天用的是同一份（默认内置账号）。
// 运维用 BOT_MODEL_UID 把机器人指到别的账号时，控制台自动跟着指过去。
function consoleModelUid() {
    // 与 dbStorage 的 fileOwnedUid 同一规则：非法值一律归 1，保证两边路由到同一个存储
    const v = Number(process.env.BOT_MODEL_UID);
    return Number.isSafeInteger(v) && v > 0 ? v : 1;
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

/**
 * 管理口令校验。通过返回 true；没通过时已经写好响应，调用方直接 return。
 */
function requireAdmin(req, res) {
    const pass = String(process.env.ADMIN_PASSWORD || "").trim();
    if (!pass) {
        res.status(503).json({
            error: "ADMIN_PASSWORD_NOT_CONFIGURED",
            message: "控制台未启用：请在服务端 .env 里设置 ADMIN_PASSWORD（一串够长的管理口令），然后重启服务。",
        });
        return false;
    }
    const token = String(req.get("x-admin-token") || "");
    if (token !== pass) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "管理口令不对" });
        return false;
    }
    return true;
}

/** token 掩码：与桌面端同一格式（头 3 + 6 星 + 尾 4；太短只给 ****）。 */
function maskToken(token) {
    if (!token) return "";
    if (token.length <= 6) return "****";
    return `${token.slice(0, 3)}${"*".repeat(6)}${token.slice(-4)}`;
}

/**
 * 写模型/人格/搜索配置，并（开着组网时）把改动传播给全网。
 *
 * 与桌宠版 main.ts 的 onModelConfigChanged → netManager.notifyLocalConfigChanged
 * 完全对等：主机按白名单广播，叶子无条件上报由主机裁决。
 * 少了这一步，桌宠端改了配置能同步、核心版改了却传不出去 —— 那就是功能不对等。
 */
function applyLocalConfigPatch(patch) {
    modelConfigFile.setProfilePatch(patch);
    try {
        const mgr = netBootstrap.getManager();
        if (mgr) mgr.notifyLocalConfigChanged(patch);
    } catch (e) {
        // 组网没起来或不在场：本机配置照常生效，只是不往外传
        console.warn("[console] 组网传播配置失败（可忽略）:", e?.message || e);
    }
}

function setupConsoleRoutes(app) {
    // config.json 外部手改 → 热生效：失效上下文缓存，下一条消息用新配置。
    // （控制台自己的写操作走 afterModelsChanged，这里兜的是「绕过界面直接改文件」。）
    modelConfigFile.onConfigChanged(() => {
        const uid = consoleModelUid();
        try {
            invalidateCtx(uid);
        } catch {}
        try {
            invalidateUserContexts(uid);
        } catch {}
    });
    modelConfigFile.startWatch();

    // ---- 服务状态 ----
    app.get("/api/status", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        // 大脑是否就绪 = 当前生效模型的三件套（地址 / 型号 / 密钥）齐不齐。
        //
        // ⚠️ 之前这里读 `dbStorage.getProfile(uid).key` —— 那是**掩码**字段
        //    （getProfile 只对外给 keyMasked，从不回明文），所以 profile.key 恒为
        //    undefined，界面上永远写着「还没配大脑」，哪怕模型早配好了。
        //    真源是 config.json（modelConfigFile），直接问它要当前生效那套。
        let brainReady = false;
        try {
            const active = modelConfigFile.getActiveModelConfig();
            brainReady = Boolean(active.key && active.endpoint && active.model);
        } catch {
            // 配置读不出来时按未就绪处理，不让状态接口整个 500
        }
        // 组网叶子：模型由主机支付，本机没配也算「能用」（与桌宠版同语义）
        if (!brainReady) {
            try {
                const snap = netBootstrap.snapshot();
                const leaf = snap && snap.state ? snap.state : null;
                if (leaf && leaf.role === "leaf" && leaf.leafStatus === "connected") brainReady = true;
            } catch {
                /* 组网没起来就忽略 */
            }
        }
        return res.json({
            version: require("../../package.json").version,
            uptime: Math.floor(process.uptime()),
            brainReady,
            net: typeof netBootstrap.snapshot === "function" ? netBootstrap.snapshot() : null,
        });
    });

    // ---- 模型配置读写 ----
    app.get("/api/settings", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const profile = await dbStorage.getProfile(consoleModelUid());
        if (!profile) return res.status(404).json({ message: "还没有配置，先保存一次" });
        // token 不回传明文，只给掩码 + 「是否已配置」标志
        // 字段约定与桌面端 config.json 一致（endpoint / key / searchKey ...，camelCase）
        return res.json({
            model: profile.model || "",
            endpoint: profile.endpoint || "",
            keyMasked: profile.keyMasked || "",
            hasKey: Boolean(profile.hasKey),
            searchProvider: profile.searchProvider || "",
            searchEndpoint: profile.searchEndpoint || "",
            searchKeyMasked: profile.searchKeyMasked || "",
            hasSearchKey: Boolean(profile.hasSearchKey),
        });
    });

    app.put("/api/settings", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        const { model, endpoint, key, searchKey, searchEndpoint, searchProvider } = req.body || {};
        const patch = {};
        if (model !== undefined) {
            if (typeof model !== "string" || !model.trim() || model.length > 120)
                return res.status(400).json({ message: "模型名称无效" });
            patch.model = model.trim();
        }
        if (endpoint !== undefined) {
            const normalized = parseApiEndpoint(endpoint);
            if (!normalized) return res.status(400).json({ message: "模型服务地址无效" });
            patch.endpoint = normalized;
        }
        if (key !== undefined) {
            if (typeof key !== "string" || !key.trim())
                return res.status(400).json({ message: "密钥不能为空" });
            patch.key = key.trim();
        }
        if (searchKey !== undefined) {
            if (typeof searchKey !== "string" || !searchKey.trim())
                return res.status(400).json({ message: "搜索密钥不能为空" });
            patch.searchKey = searchKey.trim();
        }
        if (searchEndpoint !== undefined) {
            if (typeof searchEndpoint !== "string" || !searchEndpoint.trim())
                return res.status(400).json({ message: "搜索服务地址不能为空" });
            patch.searchEndpoint = searchEndpoint.trim().replace(/\/+$/, "");
        }
        if (searchProvider !== undefined) {
            const allowed = ["uapis", "tavily", "searxng"];
            if (typeof searchProvider !== "string" || !allowed.includes(searchProvider))
                return res.status(400).json({ message: "搜索提供商无效" });
            patch.searchProvider = searchProvider;
        }
        await dbStorage.setProfile(uid, patch);
        // 组网传播：主机按白名单广播、叶子上报由主机裁决（与桌宠版对等）
        applyLocalConfigPatch(patch);
        // 与 PUT /api/profile 一致：立刻失效活跃 WS 连接的缓存上下文，下一条消息用新配置
        try {
            invalidateUserContexts(uid);
        } catch (e) {
            console.warn("[console] 失效 WS 上下文失败（可忽略）:", e?.message || e);
        }
        const profile = await dbStorage.getProfile(uid);
        console.log(
            `[console] 配置已更新 model=${profile?.model || "(空)"} endpoint=${profile?.endpoint || "(空)"}`,
        );
        // 响应与 GET 同形，前端保存后直接刷新表单
        return res.json({
            model: profile?.model || "",
            endpoint: profile?.endpoint || "",
            keyMasked: profile?.keyMasked || "",
            hasKey: Boolean(profile?.hasKey),
            searchProvider: profile?.searchProvider || "",
            searchEndpoint: profile?.searchEndpoint || "",
            searchKeyMasked: profile?.searchKeyMasked || "",
            hasSearchKey: Boolean(profile?.hasSearchKey),
        });
    });

    // ---- 多模型（用户自建多套「地址 + 型号 + 密钥」，任选一套当前使用）----
    //
    // 模型套只管模型三件套；搜索配置不跟着套走（见 /api/settings 的搜索区）。
    // 聊天取配置时：当前选中的套 > 旧的单套配置（首次访问列表会把旧配置自动导进来）。
    // 任何写操作之后立刻失效上下文池缓存 —— 下一条消息就用新配置，不用重启。

    function afterModelsChanged(uid) {
        try {
            invalidateCtx(uid);
        } catch {}
        try {
            invalidateUserContexts(uid);
        } catch {}
    }

    function checkModelPayload(body, { requireToken }) {
        const { name, endpoint, model, key } = body || {};
        if (typeof name !== "string" || !name.trim() || name.length > 40) return "名字要填（40 字以内）";
        if (typeof model !== "string" || !model.trim() || model.length > 120) return "模型型号无效";
        const normalized = parseApiEndpoint(endpoint);
        if (!normalized) return "模型服务地址无效";
        if (requireToken && (typeof key !== "string" || !key.trim())) return "密钥不能为空";
        return null;
    }

    app.get("/api/models", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        // listModelProfiles 统一返回 { items, activeId }（文件/DB 两条路径同形状），直接透传
        return res.json(await dbStorage.listModelProfiles(uid));
    });

    app.post("/api/models", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        const err = checkModelPayload(req.body, { requireToken: true });
        if (err) return res.status(400).json({ message: err });
        const { name, model, key } = req.body;
        const endpoint = parseApiEndpoint(req.body.endpoint);
        const id = await dbStorage.addModelProfile(uid, {
            name: name.trim().slice(0, 40),
            endpoint,
            model: model.trim(),
            key: key.trim(),
        });
        afterModelsChanged(uid);
        console.log(`[console] 新增模型套 id=${id} name=${name.trim()} model=${model.trim()}`);
        return res.json({ id });
    });

    app.put("/api/models/active", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        const id = Number(req.body?.id);
        if (!Number.isSafeInteger(id)) return res.status(400).json({ message: "模型 id 无效" });
        const ok = dbStorage.setActiveModelId(uid, id);
        if (!ok) return res.status(404).json({ message: "这套模型不存在（可能已被删除）" });
        afterModelsChanged(uid);
        console.log(`[console] 已切换当前使用的模型 id=${id}`);
        return res.json({ activeId: id });
    });

    app.put("/api/models/:id", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) return res.status(400).json({ message: "模型 id 无效" });
        // 编辑：name/model/endpoint 必须过校验（但留空表示不改 —— 与「key 留空不改」同一套语义）
        const body = req.body || {};
        const cur = dbStorage.getModelProfile(uid, id);
        if (!cur) return res.status(404).json({ message: "这套模型不存在（可能已被删除）" });
        if (body.name !== undefined && body.name !== "" && (typeof body.name !== "string" || body.name.trim().length > 40))
            return res.status(400).json({ message: "名字要填（40 字以内）" });
        if (body.model !== undefined && body.model !== "" && (typeof body.model !== "string" || !body.model.trim() || body.model.length > 120))
            return res.status(400).json({ message: "模型型号无效" });
        if (body.endpoint !== undefined && body.endpoint !== "" && !parseApiEndpoint(body.endpoint))
            return res.status(400).json({ message: "模型服务地址无效" });
        const ok = await dbStorage.updateModelProfile(uid, id, {
            name: body.name === "" ? undefined : body.name,
            endpoint: body.endpoint === "" ? undefined : body.endpoint,
            model: body.model === "" ? undefined : body.model,
            key: typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined,
        });
        if (!ok) return res.status(404).json({ message: "这套模型不存在（可能已被删除）" });
        afterModelsChanged(uid);
        console.log(`[console] 模型套已更新 id=${id}`);
        return res.json({ ok: true });
    });

    app.delete("/api/models/:id", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const uid = consoleModelUid();
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) return res.status(400).json({ message: "模型 id 无效" });
        const ok = await dbStorage.deleteModelProfile(uid, id);
        if (!ok) return res.status(404).json({ message: "这套模型不存在（可能已被删除）" });
        afterModelsChanged(uid);
        console.log(`[console] 模型套已删除 id=${id}`);
        return res.json({ ok: true });
    });

    // ---- 聊天（SSE 事件流）----
    //
    // 正文逐字流：内核 getReply 支持 onDelta 回调，这里转成 delta 事件。
    // 注意 done 事件仍带完整正文（解析掉情绪标签后的 speech）——
    // delta 流的是模型原始输出，done 才是权威内容，前端以 done 为准做最终替换。
    //
    // 事件：
    //   start  { sessionId }              已受理，开始处理
    //   delta  { text }                   正文增量（逐字流）。text 为空对象 { reset:true } 表示
    //                                     之前流出的内容作废（工具轮碎片），前端应清空重流
    //   done   { speech, emotion, model } 回复完成（完整正文，以前端替换流式缓冲为准）
    //   error  { message }                出错（之后连接关闭）
    // 空闲时每 15 秒发一行 `: ping` 注释，防中间层超时断链。
    app.post("/api/chat", async (req, res) => {
        if (!requireAdmin(req, res)) return;

        const body = req.body || {};
        const content = typeof body.content === "string" ? body.content.trim() : "";
        const images = Array.isArray(body.images)
            ? body.images.filter((x) => typeof x === "string" && x.trim()).slice(0, 9)
            : [];
        if (!content && images.length === 0) {
            return res.status(400).json({ error: "EMPTY_MESSAGE", message: "消息是空的" });
        }

        // SSE 头：禁缓冲、禁代理改写
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        // 心跳：客户端收到 done/error 前连接必须活着
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        const finish = () => {
            clearInterval(ping);
            res.end();
        };
        // 客户端主动断开（关页面 / 点停止）时清掉心跳
        req.on("close", () => clearInterval(ping));

        // 控制台就是「本机这台机器和人机对话」的那一个会话 —— 与桌宠版同一个 id。
        //
        // ⚠️ 以前这里没传 sessionId 就用 `console-<uuid>` 现生成一个，于是：
        //    刷新页面 = 换会话 = 记录看不见；也永远看不到桌宠版那边的对话。
        //    现在默认落到 local-session.json 里那份共享 id，两端记录天然互通。
        const sessionId =
            typeof body.sessionId === "string" && /^[a-zA-Z0-9:_-]{1,80}$/.test(body.sessionId)
                ? body.sessionId
                : await localSession.ensureLocalSessionId();
        send("start", { sessionId });

        const uid = consoleModelUid();
        // 私人知识库片段随请求携带（控制台也可以带，与 /v1/chat 同一净化规则）
        const kbContext = sanitizeKbContext(body.kbContext);

        // ── 组网叶子：优先上行主机（活锁模型，全网唯一出口）──
        if (netBootstrap.shouldUplink()) {
            const up = await netBootstrap.uplinkChat({
                sessionId,
                content,
                images,
                kbContext,
                // 流式：主机是新版时会单播 relay_delta 回来，转成同样的 delta 事件。
                // 旧主机不认识 stream 标志 → 一条 delta 都没有，done 一次性送达，前端天然兼容。
                onDelta: (chunk) => {
                    send("delta", chunk === null ? { reset: true } : { text: String(chunk) });
                },
            });
            if (up.ok) {
                console.log(`[console] "${content.slice(0, 40)}" → 已由组网主机回复`);
                send("done", { speech: up.frame.speech, emotion: up.frame.emotion ?? null, model: "（组网主机）" });
                return finish();
            }
            console.warn(`[console] 上行组网主机失败（${up.reason}），回退到本机独立处理`);
        }

        try {
            const contextPool = require("../ai/contextPool");
            const aiReplyService = require("../services/aiReplyService");
            const sessionManager = require("../session/sessionManager");
            const aiContext = await contextPool.getContext(uid);
            await sessionManager.initSession(sessionId);
            const storedContent = images.length
                ? [
                      ...(content ? [{ type: "text", text: content }] : []),
                      ...images.map((img) => ({ type: "image_url", image_url: { url: img } })),
                  ]
                : content;
            await sessionManager.saveMessage(sessionId, "user", storedContent);
            console.log(`[console] "${content.slice(0, 40)}"（图片 ${images.length} 张）`);
            const reply = await aiReplyService.getReply({
                aiContext,
                content,
                images,
                sessionId,
                // 人格：读 config.json 的 basePersona（与桌宠版同一字段），空 = 用预设
                persona: modelConfigFile.getBasePersona() || null,
                // 技能提示词：启用中技能的 prompt 模板（与桌宠版 collectSkillPrompts 同格式）
                skillPrompts: botManager.collectSkillPrompts(),
                kbContext,
                ws: null,
                // 正文逐字流出（onDelta(null) = 之前流的作废，清空重流）
                onDelta: (chunk) => {
                    send("delta", chunk === null ? { reset: true } : { text: String(chunk) });
                },
            });
            await sessionManager.saveMessage(sessionId, "assistant", reply.speech, {
                // 情绪/图片进 extras 列（桌宠版引擎同样存）：共享历史里桌宠端原样带回
                emotion: reply.emotion ?? null,
                images: Array.isArray(reply.images) ? reply.images : [],
            });
            send("done", {
                speech: reply.speech,
                emotion: reply.emotion ?? null,
                model: reply.model || "",
            });
            finish();
        } catch (error) {
            const reason = error?.message || String(error);
            console.error(`[console] 处理失败:`, reason);
            send("error", { message: reason });
            finish();
        }
    });

    // ---- 控制台外观（配色 + 明暗）----
    // 与桌宠版「外观」页**不互通**：网页后台和桌面小窗是两种场景，一套设置两头改
    // 只会互相干扰。核心版存自己的 data/console-appearance.json，字段名也叫
    // consoleAppearance 而不是 theme，跟 pet-client.config.json 的 theme 彻底分开。
    // （桌宠版保存配置是整体覆盖写回，塞进共享文件的陌生键会被它抹掉 —— 详见
    //  src/settings/consoleAppearance.js 的文件头注释。）
    app.get("/api/appearance", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const now = consoleAppearance.getAppearance();
        return res.json({
            ...now,
            themes: consoleAppearance.THEMES,
            modes: consoleAppearance.MODES,
        });
    });

    app.put("/api/appearance", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        const patch = {};
        if (body.theme !== undefined) {
            if (typeof body.theme !== "string" || !consoleAppearance.THEME_IDS.includes(body.theme.trim())) {
                return res.status(400).json({ message: "没有这个配色" });
            }
            patch.theme = body.theme;
        }
        if (body.mode !== undefined) {
            if (typeof body.mode !== "string" || !consoleAppearance.MODE_IDS.includes(body.mode.trim())) {
                return res.status(400).json({ message: "没有这个明暗模式" });
            }
            patch.mode = body.mode;
        }
        const saved = consoleAppearance.setAppearance(patch);
        console.log(`[console] 控制台外观已切换为 ${saved.theme} / ${saved.mode}`);
        return res.json(saved);
    });

    // ---- 通用：备注名（pet-client.config.json 的 petName，与桌宠版同一份文件同一个键）----
    // 桌宠版改了备注名，核心版控制台打开就是新的；反过来也一样。
    app.get("/api/pet-name", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ petName: clientConfig.getPetName() });
    });

    app.put("/api/pet-name", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const value = req.body?.petName;
        if (typeof value !== "string") return res.status(400).json({ message: "备注名只能是一段文字" });
        const v = value.trim();
        if (!v) return res.status(400).json({ message: "备注名不能为空" });
        if (v.length > 16) return res.status(400).json({ message: "备注名太长了（16 字以内）" });
        const saved = clientConfig.setPetName(v);
        console.log(`[console] 备注名已更新为 ${saved}`);
        return res.json({ petName: saved });
    });

    // ---- 我的头像（文件在 userData/user-avatar/，配置里只存引用）----
    // 与桌宠版严格同构：pet-client.config.json 里存 useravatar://avatar<ext>，
    // 真正的图片躺在 user-avatar/ 目录里。绝不把 base64 塞进配置（那会改文件格式，
    // 桌宠版读不懂）。核心版没有 useravatar:// 协议，所以用这个接口把文件吐给前端。
    app.get("/api/avatar/user", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const file = clientConfig.resolveUserAvatarFile();
        if (!file) return res.status(404).json({ message: "还没有设置头像" });
        return res.sendFile(file);
    });

    app.post("/api/avatar/user", (req, res) => {
        if (!requireAdmin(req, res)) return;
        // 前端读图转 data URL 传上来；这里只认「图片 + base64」这一个形状。
        const dataUrl = String(req.body?.dataUrl || "").trim();
        const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!m) return res.status(400).json({ message: "只能上传图片文件" });
        const buf = Buffer.from(m[2], "base64");
        if (!buf.length) return res.status(400).json({ message: "图片是空的" });
        if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ message: "图片太大了（5MB 以内）" });
        const EXT_MAP = { jpeg: ".jpg", jpg: ".jpg", png: ".png", gif: ".gif", webp: ".webp", bmp: ".bmp" };
        const ext = EXT_MAP[m[1].toLowerCase()] || ".png";
        try {
            const ref = clientConfig.saveUserAvatarFile(buf, ext);
            console.log(`[console] 我的头像已更新（${ext}，${buf.length} 字节）`);
            // 带时间戳的 URL：换图后浏览器缓存不会让界面还显示旧图
            return res.json({ userAvatar: ref, url: `/api/avatar/user?t=${Date.now()}` });
        } catch (e) {
            console.warn("[console] 头像保存失败:", e?.message || e);
            return res.status(500).json({ message: "头像保存失败" });
        }
    });

    app.delete("/api/avatar/user", (req, res) => {
        if (!requireAdmin(req, res)) return;
        clientConfig.clearUserAvatar();
        console.log("[console] 我的头像已移除");
        return res.json({ ok: true });
    });

    // ---- 人格（自定义基础人格，与桌宠版共用 config.json 的 basePersona）----
    app.get("/api/persona", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ basePersona: modelConfigFile.getBasePersona() });
    });

    app.put("/api/persona", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const value = req.body?.basePersona;
        if (value !== undefined && typeof value !== "string") {
            return res.status(400).json({ message: "人格只能是一段文字" });
        }
        if (typeof value === "string" && value.length > 4000) {
            return res.status(400).json({ message: "人格太长了（4000 字以内）" });
        }
        const saved = modelConfigFile.setBasePersona(value || "");
        // 组网传播：人格在同步白名单里，开了组网要照Desktop 同行为传出去
        applyLocalConfigPatch({ basePersona: saved });
        console.log(`[console] 人格已更新（${saved ? `${saved.length} 字` : "恢复预设"}）`);
        return res.json({ basePersona: saved });
    });

    // ---- 技能（skills.json，与桌宠版同格式）----
    app.get("/api/skills", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ items: mcpManager.readSkills() });
    });

    app.post("/api/skills", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        const name = String(body.name || "").trim();
        if (!name || name.length > 40) return res.status(400).json({ message: "名字要填（40 字以内）" });
        const skills = mcpManager.readSkills();
        const id = `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const created = {
            id,
            name,
            description: String(body.description || "").trim().slice(0, 200),
            enabled: body.enabled !== false,
            prompt: String(body.prompt || "").slice(0, 4000),
            tools: Array.isArray(body.tools) ? body.tools.slice(0, 20) : [],
        };
        skills.push(created);
        mcpManager.writeSkills(skills);
        mcpManager.refreshTools();
        console.log(`[console] 新增技能 id=${id} name=${name}`);
        return res.json({ id });
    });

    app.put("/api/skills/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const skills = mcpManager.readSkills();
        const idx = skills.findIndex((s) => s.id === req.params.id);
        if (idx < 0) return res.status(404).json({ message: "这个技能不存在（可能已被删除）" });
        const body = req.body || {};
        const next = { ...skills[idx] };
        if (body.name !== undefined) {
            const n = String(body.name).trim();
            if (!n || n.length > 40) return res.status(400).json({ message: "名字要填（40 字以内）" });
            next.name = n;
        }
        if (body.description !== undefined) next.description = String(body.description).slice(0, 200);
        if (body.enabled !== undefined) next.enabled = !!body.enabled;
        if (body.prompt !== undefined) next.prompt = String(body.prompt).slice(0, 4000);
        if (body.tools !== undefined) next.tools = Array.isArray(body.tools) ? body.tools.slice(0, 20) : [];
        skills[idx] = next;
        mcpManager.writeSkills(skills);
        mcpManager.refreshTools();
        console.log(`[console] 技能已更新 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    app.delete("/api/skills/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const skills = mcpManager.readSkills();
        const next = skills.filter((s) => s.id !== req.params.id);
        if (next.length === skills.length) return res.status(404).json({ message: "这个技能不存在" });
        mcpManager.writeSkills(next);
        mcpManager.refreshTools();
        console.log(`[console] 技能已删除 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    // ---- MCP 外部工具服务（mcp-servers.json，与桌宠版同格式）----
    app.get("/api/mcp", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ items: mcpManager.readMcpServers() });
    });

    app.post("/api/mcp", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        const name = String(body.name || "").trim();
        const transport = body.transport === "stdio" ? "stdio" : "http";
        if (!name || name.length > 60) return res.status(400).json({ message: "名字要填（60 字以内）" });
        if (transport === "http") {
            const url = String(body.url || "").trim();
            if (!url || !/^wss?:\/\/|^https?:\/\//i.test(url)) {
                return res.status(400).json({ message: "HTTP 型要填合法的服务地址（http/https）" });
            }
        } else if (!String(body.command || "").trim()) {
            return res.status(400).json({ message: "stdio 型要填启动命令" });
        }
        const servers = mcpManager.readMcpServers();
        const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        servers.push({
            id,
            name,
            transport,
            url: transport === "http" ? String(body.url).trim() : undefined,
            command: transport === "stdio" ? String(body.command).trim() : undefined,
            args: transport === "stdio" && Array.isArray(body.args) ? body.args.map(String).slice(0, 30) : undefined,
            enabled: body.enabled !== false,
        });
        mcpManager.writeMcpServers(servers);
        mcpManager.refreshTools();
        console.log(`[console] 新增 MCP server id=${id} name=${name} transport=${transport}`);
        return res.json({ id });
    });

    app.put("/api/mcp/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const servers = mcpManager.readMcpServers();
        const idx = servers.findIndex((s) => s.id === req.params.id);
        if (idx < 0) return res.status(404).json({ message: "这个 MCP 服务不存在（可能已被删除）" });
        const body = req.body || {};
        const next = { ...servers[idx] };
        if (body.name !== undefined) {
            const n = String(body.name).trim();
            if (!n || n.length > 60) return res.status(400).json({ message: "名字要填（60 字以内）" });
            next.name = n;
        }
        if (body.url !== undefined) next.url = String(body.url).trim();
        if (body.command !== undefined) next.command = String(body.command).trim();
        if (body.args !== undefined) next.args = Array.isArray(body.args) ? body.args.map(String).slice(0, 30) : [];
        if (body.enabled !== undefined) next.enabled = !!body.enabled;
        servers[idx] = next;
        mcpManager.writeMcpServers(servers);
        mcpManager.refreshTools();
        console.log(`[console] MCP server 已更新 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    app.delete("/api/mcp/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const servers = mcpManager.readMcpServers();
        const next = servers.filter((s) => s.id !== req.params.id);
        if (next.length === servers.length) return res.status(404).json({ message: "这个 MCP 服务不存在" });
        mcpManager.writeMcpServers(next);
        mcpManager.refreshTools();
        console.log(`[console] MCP server 已删除 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    // 保存前先试连：把「地址填错」暴露在点保存的那一刻，而不是等聊天时才发现
    app.post("/api/mcp/probe", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        const transport = body.transport === "stdio" ? "stdio" : "http";
        if (transport === "http" && !String(body.url || "").trim()) {
            return res.status(400).json({ message: "先填服务地址再测试" });
        }
        if (transport === "stdio" && !String(body.command || "").trim()) {
            return res.status(400).json({ message: "先填启动命令再测试" });
        }
        const result = await mcpManager.probeServer({
            id: "probe",
            name: String(body.name || "测试"),
            transport,
            url: String(body.url || "").trim(),
            command: String(body.command || "").trim(),
            args: Array.isArray(body.args) ? body.args.map(String) : [],
            enabled: true,
        });
        return res.json(result);
    });

    // ---- 私人知识库（knowledge.json，与桌宠版同格式）----
    app.get("/api/kb", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ items: userKnowledge.listEntries() });
    });

    // 远程源试抓：填了地址就能立刻知道通不通，不用等聊天时才发现
    app.post("/api/kb/probe", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const url = String(req.body?.url || "").trim();
        const sourceType = ["mediawiki", "markdown", "html", "rss"].includes(req.body?.sourceType)
            ? req.body.sourceType
            : "html";
        if (!url) return res.status(400).json({ message: "先填地址再测试" });
        try {
            const { fetchRemoteKnowledge } = require("../knowledge/remoteFetchers");
            const results = await fetchRemoteKnowledge(url, sourceType, "测试", 2, 5000);
            return res.json({ ok: results.length > 0, count: results.length, message: results.length ? "" : "连上了但没抓到内容" });
        } catch (e) {
            return res.json({ ok: false, count: 0, message: e?.message || "抓取失败" });
        }
    });

    app.post("/api/kb", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        if (body.type === "remote") {
            const name = String(body.name || "").trim();
            const url = String(body.url || "").trim();
            if (!name || !url) return res.status(400).json({ message: "名字和地址都要填" });
            const created = userKnowledge.addRemoteSource(body);
            console.log(`[console] 新增远程知识源 id=${created.id} name=${name}`);
            return res.json({ id: created.id });
        }
        const title = String(body.title || "").trim();
        const content = String(body.content || "").trim();
        if (!title || !content) return res.status(400).json({ message: "标题和内容都要填" });
        const created = userKnowledge.addEntry(body);
        console.log(`[console] 新增知识条目 id=${created.id} title=${title}`);
        return res.json({ id: created.id });
    });

    app.put("/api/kb/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const id = Number(req.params.id);
        const body = req.body || {};
        // 远程源与本地条目都能改（按 id 找，两类分别更新）
        const isRemote = userKnowledge.listRemoteSources().some((s) => s.id === id);
        const updated = isRemote ? userKnowledge.updateRemoteSource(id, body) : userKnowledge.updateEntry(id, body);
        if (!updated) return res.status(404).json({ message: "这条知识不存在（可能已被删除）" });
        console.log(`[console] 知识已更新 id=${id}`);
        return res.json({ ok: true });
    });

    app.delete("/api/kb/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const id = Number(req.params.id);
        const isRemote = userKnowledge.listRemoteSources().some((s) => s.id === id);
        const ok = isRemote ? userKnowledge.deleteRemoteSource(id) : userKnowledge.deleteEntry(id);
        if (!ok) return res.status(404).json({ message: "这条知识不存在" });
        console.log(`[console] 知识已删除 id=${id}`);
        return res.json({ ok: true });
    });

    // ---- 机器人适配器（pet-client.config.json 的 adapters[]，与桌宠版同一份）----
    app.get("/api/bot", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ items: botManager.listStatus() });
    });

    app.post("/api/bot", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const body = req.body || {};
        const name = String(body.name || "").trim();
        const type = body.type === "qqofficial" ? "qqofficial" : "onebot";
        if (!name || name.length > 60) return res.status(400).json({ message: "名字要填（60 字以内）" });
        if (type === "onebot" && !String(body.config?.wsUrl || "").trim()) {
            return res.status(400).json({ message: "OneBot 要填 WS 地址" });
        }
        const adapters = botManager.readAdapters();
        const id = `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        adapters.push({
            id,
            type,
            name,
            enabled: body.enabled !== false,
            // 主人账号（可后补）：被设为 owner 的协议端账号，其消息并入本机会话
            ownerAccount:
                typeof body.ownerAccount === "string" && body.ownerAccount.trim() ? body.ownerAccount.trim() : null,
            config: body.config && typeof body.config === "object" ? body.config : {},
        });
        botManager.writeAdapters(adapters);
        botManager.applyConfig();
        console.log(`[console] 新增机器人适配器 id=${id} name=${name} type=${type}`);
        return res.json({ id });
    });

    app.put("/api/bot/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const adapters = botManager.readAdapters();
        const idx = adapters.findIndex((a) => a.id === req.params.id);
        if (idx < 0) return res.status(404).json({ message: "这个适配器不存在（可能已被删除）" });
        const body = req.body || {};
        const next = { ...adapters[idx] };
        if (body.name !== undefined) {
            const n = String(body.name).trim();
            if (!n || n.length > 60) return res.status(400).json({ message: "名字要填（60 字以内）" });
            next.name = n;
        }
        if (body.enabled !== undefined) next.enabled = !!body.enabled;
        if (body.ownerAccount !== undefined) {
            // 空串/空白 = 取消主人；桌宠版 update() 同样透传该字段
            next.ownerAccount = String(body.ownerAccount || "").trim() || null;
        }
        if (body.config !== undefined && typeof body.config === "object") next.config = body.config;
        adapters[idx] = next;
        botManager.writeAdapters(adapters);
        botManager.applyConfig();
        console.log(`[console] 机器人适配器已更新 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    /**
     * 设/取消机器人主人。主人账号之后发来的消息并入「本机会话」
     * （与桌宠版、控制台共用同一段主对话）；account 为空 = 取消。
     * 对应桌宠版 IPC adapter:set-owner，配置键同名、同一份 pet-client.config.json。
     * 走 botManager.setOwner：写盘 + 实时同步到运行中的适配器（不用重启即生效）。
     */
    app.post("/api/bot/:id/owner", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const account = String((req.body || {}).account || "").trim();
        try {
            const ownerAccount = botManager.setOwner(req.params.id, account);
            console.log(`[console] 机器人适配器主人已${account ? `设为 ${account}` : "取消"} id=${req.params.id}`);
            return res.json({ ok: true, ownerAccount });
        } catch (e) {
            return res.status(404).json({ message: e?.message || "设置失败" });
        }
    });

    app.delete("/api/bot/:id", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const adapters = botManager.readAdapters();
        const next = adapters.filter((a) => a.id !== req.params.id);
        if (next.length === adapters.length) return res.status(404).json({ message: "这个适配器不存在" });
        botManager.writeAdapters(next);
        botManager.applyConfig();
        console.log(`[console] 机器人适配器已删除 id=${req.params.id}`);
        return res.json({ ok: true });
    });

    // ---- 聊天记录（读后端存储，桌宠版同源）----
    // 桌宠版聊天记录已改为走这里（用户拍板：聊天记录统一用数据库）。
    // 前端只需要「拉历史 + 发消息」，存储全在服务端（SQLite / 内存由 STORAGE_TYPE 决定）。
    // 返回的是面向 UI 的形状（id / 角色 / 内容 / 情绪 / 图片 / 时间戳），
    // 桌宠版那边读同一个表、同一个函数，两边记录完全互通。
    app.get("/api/history", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        // 不传 sessionId 就取本机会话（与桌宠版同一段对话）——控制台打开即看到记录
        const sessionId =
            typeof req.query.sessionId === "string" && req.query.sessionId
                ? req.query.sessionId
                : await localSession.ensureLocalSessionId();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        try {
            const sessionManager = require("../session/sessionManager");
            const items = (await sessionManager.getSessionMessages(sessionId, limit)) || [];
            return res.json({ sessionId, items });
        } catch (e) {
            console.warn("[console] 读取聊天记录失败:", e?.message || e);
            return res.status(500).json({ message: "读取聊天记录失败" });
        }
    });

    /** 本机会话 id（前端开页面时先问一次，历史和发送都用它）。 */
    app.get("/api/session", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ sessionId: await localSession.ensureLocalSessionId() });
    });

    /**
     * 清空聊天记录。清的就是本机会话 —— 两端共用同一个会话，
     * 所以桌宠版那边也会一起清掉（这本来就是「清空和绮莉的聊天记录」的语义）。
     */
    app.delete("/api/history", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const sessionId =
            typeof req.query.sessionId === "string" && req.query.sessionId
                ? req.query.sessionId
                : await localSession.ensureLocalSessionId();
        try {
            const sessionManager = require("../session/sessionManager");
            await sessionManager.clearSession(sessionId);
            console.log(`[console] 聊天记录已清空（会话 ${sessionId.slice(0, 8)}…）`);
            return res.json({ ok: true, sessionId });
        } catch (e) {
            console.warn("[console] 清空聊天记录失败:", e?.message || e);
            return res.status(500).json({ message: "清空失败" });
        }
    });

    // ---- 数据目录信息（设置页显示「读的是哪份数据」，排错用）----
    app.get("/api/data-info", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({
            dataDir,
            configFile: modelConfigFile.getConfigPath(),
            knowledgeFile: userKnowledge.filePath(),
            mcpFile: mcpManager.mcpFilePath(),
            skillsFile: mcpManager.skillsFilePath(),
            // 机器人适配器就存在这份桌宠版本机配置里（adapters[]）
            adapterFile: botManager.adapterFilePath(),
            clientConfigFile: clientConfig.clientConfigPath(),
            clientConfigFound: clientConfig.exists(),
            userAvatarFile: clientConfig.resolveUserAvatarFile(),
            localSessionFile: localSession.filePath(),
            netStateFile: netBootstrap.stateFilePath(),
            netIdentityFile: netBootstrap.identityFilePath(),
        });
    });

    // ---- 组网（与桌宠版 electron/net/ipc.ts 的入口一一对应）----
    //
    // 配置文件与桌宠版**同一个目录、同一份文件、同一种格式**（net-state.json /
    // net-identity.json，都在 dataDir 下）。本机装过桌宠版时，桌宠里配的组网
    // 核心版原样接管；反过来在控制台里改，桌宠端也看得到。
    //
    // 所有写操作都返回最新 snapshot，前端拿到直接刷新，不用再查一次。

    /** 当前组网状态（页面渲染的唯一数据源） */
    app.get("/api/net/state", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json({ ok: true, snapshot: netBootstrap.snapshot().state });
    });

    /** 本机可用于组网的地址（提示「用哪个地址连」） */
    app.get("/api/net/addresses", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.getAddresses());
    });

    /** 能不能开组网（UI 据此决定开关要不要灰掉） */
    app.get("/api/net/can-start", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.canStart());
    });

    /** 作为主机开启组网，并生成第一个连接码 */
    app.post("/api/net/host", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = await netBootstrap.startHost(req.body?.expiry);
        console.log(`[console] 组网：${r.ok ? "已作为主机开启" : `开启主机失败（${r.error}）`}`);
        return res.json(r);
    });

    /** 再生成一个连接码（每台设备一个码） */
    app.post("/api/net/pairing", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.issuePairing(req.body?.expiry);
        if (r.ok) console.log("[console] 组网：已签发连接码");
        return res.json(r);
    });

    /** 作为叶子加入：填入连接码完成首次配对 */
    app.post("/api/net/join", async (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = await netBootstrap.join(req.body?.code);
        console.log(`[console] 组网：${r.ok ? "已接入主机" : `接入失败（${r.error}）`}`);
        return res.json(r);
    });

    /** 重新加入已配对的主机（打开开关时用，不需要重新填码） */
    app.post("/api/net/resume", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.resume();
        console.log(`[console] 组网：${r.ok ? "已重新接入主机" : `重连失败（${r.error}）`}`);
        return res.json(r);
    });

    /**
     * 关闭组网。只「暂停参与」，不清除主机地址 / 长期凭据 / 已生成的连接码 ——
     * 下次打开凭持久化信息自动归位，用户零成本反复切换。
     */
    app.post("/api/net/stop", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.stopNetworking();
        console.log("[console] 组网：已关闭（配置保留，下次打开自动归位）");
        return res.json(r);
    });

    /** 撤销某个连接码：作废配对入口，不影响已连上的设备 */
    app.post("/api/net/pairing/:id/revoke", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.revokePairing(req.params.id);
        if (r.ok) console.log(`[console] 组网：已撤销连接码 ${req.params.id}`);
        return res.json(r);
    });

    /** 清理已过期的连接码 */
    app.post("/api/net/pairing/prune", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.prunePairings());
    });

    /** 移除设备：作废它的长期凭据，之后再也连不上 */
    app.post("/api/net/device/:id/remove", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.removeDevice(req.params.id);
        if (r.ok) console.log(`[console] 组网：已移除设备 ${req.params.id}`);
        return res.json(r);
    });

    /** 叶子端「移除自己」：断开与主机的绑定并清掉本地凭据 */
    app.post("/api/net/leave", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.leaveHost();
        console.log("[console] 组网：已断开与主机的绑定");
        return res.json(r);
    });

    /** 改本机在组网里的显示名 */
    app.put("/api/net/name", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.renameSelf(req.body?.name);
        if (r.ok) console.log(`[console] 组网：本机改名 -> ${String(req.body?.name || "").trim()}`);
        return res.json(r);
    });

    /** 立刻把待同步的离线对话补传给主机（页面上的「立即同步」按钮） */
    app.post("/api/net/flush", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.flushBackfill());
    });

    /** 读配置同步白名单。只有主机侧有内容；叶子侧返回空数组（看不到也改不了）。 */
    app.get("/api/net/sync", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.getSyncWhitelist());
    });

    /** 设置白名单。调整后立即生效，不需要叶子重新连接。 */
    app.put("/api/net/sync", (req, res) => {
        if (!requireAdmin(req, res)) return;
        const r = netBootstrap.setSyncWhitelist(req.body?.fields);
        if (r.ok) console.log(`[console] 组网：同步项已更新（${(r.whitelist || []).join("、") || "无"}）`);
        return res.json(r);
    });

    /** 出口忙不忙（主机侧显示排队情况） */
    app.get("/api/net/relay-stats", (req, res) => {
        if (!requireAdmin(req, res)) return;
        return res.json(netBootstrap.relayStats());
    });
}

module.exports = { setupConsoleRoutes };
