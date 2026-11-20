// src/net/bootstrap.js
// 核心版接入组网（活锁模型）。
//
// ── 为什么核心版必须能组网 ──
// ARCHITECTURE-PLAN §1.2 把「能力对等」列为硬约束：
//   「桌面版和核心版都能当主机，也都能当叶子」
//   「任何一侧若只能当某一种角色，即为设计缺陷；两侧共用同一套组网代码」
// 所以组网实现被抽成独立包 `kirari-net`，桌面端与核心版引用同一份，
// 本文件只做「核心版这一侧」的接线。**不含任何组网协议逻辑**（那些都在包里）。
//
// ── 与桌面端的关系：配置文件和功能都完全对等（用户拍板）──
//   配置文件：**同一个目录、同一份文件、同一种格式**。
//     NetManager 的 userDataDir 传数据根下的 network/ 目录（kirariHome 的 LAYOUT：
//     network/net-state.json、network/net-identity.json），桌宠版写的是同一对文件，
//     桌宠里配的组网核心版原样接管。
//     早期版本核心版把状态放 data/net/、角色放 .env 的 NET_ROLE，那套已废弃：
//     启动时若发现 net-state.json 不存在而 .env 有 NET_ROLE/NET_PAIRING_CODE，
//     会做一次性迁移（只搬角色，之后一律以文件为准）。
//   功能：桌面端 electron/net/ipc.ts 的每个入口，这里都有对应的 HTTP 接口
//     （见 src/api/consoleRoutes.js 的 /api/net/*），一个不少。
//
// ── 与桌面端仅剩的差异（都是宿主形态决定的，不是能力缺失）──
//   执行器：核心版用 contextPool + sessionManager（桌面端用进程内 AI 引擎）
//   二维码：桌面端用 qrcode 渲染 data URL；核心版控制台直接展示连接码文本
//           （二维码本质是同一串字符的另一种编码，复制粘贴一样能用）
//   NET_ADVERTISE_HOST：容器/多网卡部署必须显式指定「连接码里写哪个地址」。
//           这是部署层面的覆盖项，不属于用户配置；桌面端在图形环境里自动猜即可。
//
// ⚠️ **没有「密钥来源」这一条差异**：两端的地位完全一样，谁也不在构建期
//    或环境变量里带密钥。本机当主机时自己签一把，当叶子时凭一张连接码
//    在配对那一刻领（enroll）。所以 .env 里**没有** KIRARI_NET_SECRET。

const { NetManager, NET_PORT, SYNC_FIELDS } = require("kirari-net");

const contextPool = require("../ai/contextPool");
const ownerIdentity = require("../services/ownerIdentity");
const sessionManager = require("../session/sessionManager");
const aiReplyService = require("../services/aiReplyService");
const fallbackService = require("../services/fallbackService");
const modelConfigFile = require("../services/modelConfigFile");
const { paths: HOME_PATHS } = require("../dataDir");
// 组网状态/身份所在目录（NetManager 会创建 net-state.json / net-identity.json）。
const NET_DIR = require("path").dirname(HOME_PATHS.netState);

/** 允许的角色。off = 不参与组网 */
const ROLES = ["off", "host", "leaf"];
/** 允许的配对码过期档位（与桌面端 ipc.ts 一致） */
const EXPIRY_KEYS = ["1h", "1d", "7d", "30d", "forever"];

/** 单例。**启动时就创建**（与桌面端一致）—— 否则 role=off 时控制台拿不到 manager，
 *  用户点「开启组网」会得到「功能还没准备好」，而桌面端同一时刻是能点的。 */
let manager = null;
let hostExecutorAttached = false;
/**
 * 叶子侧：本次连接是否已经上报过工具能力（阶段 5）。
 * 掉线时重置，重连后重新上报 —— 期间用户可能装了新 MCP / 删了 skill。
 */
let capsReported = false;

function log(message) {
  console.log(`[net] ${message}`);
}

function pickExpiry(value) {
  return EXPIRY_KEYS.includes(value) ? value : "7d";
}

/**
 * 主机执行器：组网内所有模型调用都由**主机自己的凭证**支付，叶子无需配置 Key。
 *
 * ⚠️ 会话 ID 必须加命名空间（net:<设备>:<会话>）。
 *    叶子传来的 sessionId 与核心版自己的会话（机器人群会话 bot:...、WS 会话 session_...、
 *    控制台会话 console-...）处于同一个 SQLite 空间里，不加前缀就可能撞车 ——
 *    撞车的后果是某台设备的对话串进机器人的群聊记忆，属于最难查的那类脏数据。
 *    加前缀之后，同一台设备重连仍命中同一份上下文（deviceId 稳定），性质不变。
 */
function buildHostExecutor(modelUid) {
  return async ({ sessionId, content, images, deviceId, kbContext, onDelta }) => {
    const scopedSession = `net:${deviceId}:${sessionId}`;

    // ── 工作空间定期任务：叶子到点后转发上来的 ──
    // 叶子没有模型凭证，任务照旧由主机执行（用户 2026-11-19：「从机（叶子节点）的
    // 任务依旧转发给主机完成」）。产出同样写在**主机**的 ~/KirariWorkspace 里，
    // 叶子只拿回结果 —— 这就是「写主机、叶子只拿结果」。
    //
    // 走 runLocally 而不是普通 getReply，是因为它还要记运行次数、按保留策略清旧文件；
    // 当成闲聊处理的话，主机这边的 meta 永远停在「没跑过」，两端的账对不上。
    const wsTask = (() => {
      try {
        return require("../services/workspaceTask");
      } catch (e) {
        console.warn("[net] 加载工作空间任务服务失败（按普通对话处理）:", e?.message || e);
        return null;
      }
    })();
    if (wsTask && wsTask.isWorkspaceSession(sessionId)) {
      const taskId = wsTask.taskIdFromSession(sessionId);
      const payload = wsTask.parsePayload(content);
      // owner 优先取 payload（叶子建任务时存下的，最准）；老格式的叶子没有这个字段，
      // 就从 sessionId 里拆。两者都没有才落到 _legacy —— 不回退成公共目录。
      const owner =
        (payload && payload.owner)
        || wsTask.ownerFromSession(sessionId)
        || wsTask.LEGACY_OWNER;
      const result = await wsTask.runLocally({
        owner,
        taskId,
        title: (payload && payload.title) || taskId,
        instruction: (payload && payload.instruction) || "",
        modelUid,
        // 关键词：设备命名空间要保留，否则主机自己跑同名任务时两边共用一个会话。
        sessionId: scopedSession,
      });
      if (!result.ok) {
        const reason = result.error || "未知原因";
        // 配置类错误必须显式抛出去（叶子要看到「去设置里配」而不是一句兜底闲聊）
        if (/未配置|尚未配置|还没连接|还没填写|还没选择/.test(reason)) throw new Error(reason);
        return { speech: `任务没跑成：${reason}`, emotion: null };
      }
      return { speech: result.speech || "", emotion: null };
    }

    const aiContext = await contextPool.getContext(modelUid);
    await sessionManager.initSession(scopedSession);

    // 多模态：带图时存数组，模型才看得到图（与 /v1/chat 一致）
    const list = Array.isArray(images) ? images.filter(Boolean) : [];
    const stored = list.length
      ? [
          ...(content ? [{ type: "text", text: content }] : []),
          ...list.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : content;
    await sessionManager.saveMessage(scopedSession, "user", stored);

    // 叶子自带的私人知识库检索结果：存在叶子本地，主机没有别的途径拿到。
    // 不传下去的话「叶子端配了知识库」在这条链路里就静默失效了。
    const kb = Array.isArray(kbContext) && kbContext.length ? kbContext : null;

    try {
      const reply = await aiReplyService.getReply({
        aiContext,
        content,
        images: list,
        sessionId: scopedSession,
        // 位置记忆按设备隔离：不同设备可能在不同地方，不共享
        locationScope: null,
        // 人格/技能/搜索：**一律用主机自己的配置**（活锁模型的语义：
        // 全网只有一个出口，叶子的凭证与人格都不参与）。与桌面端一致。
        persona: null,
        skillPrompts: [],
        kbContext: kb,
        // 组网身份：按真实发信人从 sessionId 服务端派生，不读帧里自报字段。
        // 叶子都是主人设备（配对凭据已鉴权），本机会话 → 主人 owner；
        // 若真是协议端转发的平台会话，则按 QQ 号查 people 表定 owner/user。
        // 不传 scene 会让 relayed 消息在主机被当成 user，读不到主人自己的记忆/任务。
        scene: ownerIdentity.sceneFromSessionId(sessionId),
        ws: null,
        // 请求来源（阶段 5）：这条对话来自哪台设备。
        // 主机据此让「模型没点名时，工具默认在请求方自己那台跑」——
        // 叶子请求自己，主机/QQ/网页端请求主机自己。
        // 空字符串一律归一成 undefined，避免 '' 被当成一台设备。
        sourceDeviceId: deviceId ? String(deviceId) : undefined,
        // 流式：叶子请求了 stream 时，路由会传 onDelta 进来 —— 转给内核逐字回调，
        // 增量由组网层转成 relay_delta 单播回叶子。没请求流式时是 undefined，行为不变。
        onDelta: typeof onDelta === "function" ? onDelta : null,
      });
      await sessionManager.saveMessage(scopedSession, "assistant", reply.speech);
      return { speech: reply.speech, emotion: reply.emotion ?? null };
    } catch (error) {
      const reason = error?.message || String(error);
      // 配置类错误（模型没填好）必须显式抛出去：叶子要看到「去设置里配」，
      // 而不是收到一句兜底闲聊，让人误以为模型是通的。
      if (/未配置|尚未配置|还没连接|还没填写|还没选择/.test(reason)) throw error;
      console.warn(`[net] 主机处理上行请求失败，改用兜底回复: ${reason}`);
      const fb = fallbackService.getReply({ content, persona: null });
      return { speech: fb.speech, emotion: fb.emotion ?? null };
    }
  };
}

/**
 * 补传入库：把叶子断线期间独立产生的对话写进主机历史。
 * **只入库、不重放模型调用** —— 重放会让其他叶子看到重复内容。
 */
async function backfillSink(msg) {
  const scoped = `net:${msg.deviceId}:${msg.sessionId}`;
  for (const entry of msg.entries || []) {
    try {
      await sessionManager.saveMessage(scoped, entry.role, entry.text);
    } catch (e) {
      console.warn(`[net] 补传入库失败（忽略本条）: ${e?.message || e}`);
    }
  }
}

/**
 * 叶子侧：执行主机指派过来的一次工具调用（阶段 5）。
 *
 * 为什么必须在叶子本地跑：MCP server 和 skill 都装在**各节点本地**，主机上没有
 * 叶子的那些配置（也刻意不同步——见 SYNC_FIELDS 不含 mcp/skill）。所以
 * 「点明书房的电脑，用它自己的技能」只能是：主机决策 → 叶子执行 → 结果回传。
 *
 * 约定：**无论成功失败都要回 tool_result**。不回主机只能等到超时，
 * 而超时无法区分「工具报错」和「设备掉线」，排障时非常难受。
 */
async function runLocalToolCall(frame) {
  const started = Date.now();
  const callId = frame && frame.callId ? String(frame.callId) : "";
  const name = frame && frame.name ? String(frame.name) : "";
  const manager = getManager();
  const reply = (out) => {
    try {
      manager?.replyToolResult({ callId, elapsedMs: Date.now() - started, ...out });
    } catch (e) {
      console.warn(`[net] 回传工具结果失败: ${e?.message || e}`);
    }
  };

  if (!callId || !name) {
    reply({ ok: false, error: "主机发来的工具调用缺少 callId 或工具名" });
    return;
  }

  // 本机没装这个工具也要明确回「没这个工具」—— 别让主机等到超时
  let capabilities;
  try {
    capabilities = require("../capabilities/registry");
  } catch (e) {
    reply({ ok: false, error: `本机能力注册表加载失败：${e?.message || e}` });
    return;
  }

  try {
    // 走 dispatch 的**本地路径**：这里绝不能带 sourceDeviceId（否则又会想远程转发），
    // 也不能带 @device: 前缀（主机发来时已经剥掉了，名字就是本机的真实工具名）。
    const dispatched = await capabilities.dispatch("net:remote", name, frame.args || {}, {
      origin: "net-remote",
      sessionId: frame.sessionId,
    });
    if (dispatched && dispatched.isError) {
      reply({ ok: false, error: String(dispatched.content || "执行失败") });
    } else {
      reply({ ok: true, result: String((dispatched && dispatched.content) || "") });
    }
  } catch (e) {
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 叶子侧：把本机可远程调用的工具清单报给主机（阶段 5）。
 *
 * 主机据此回答「这台设备能不能跑这个工具」，模型点名设备时才有依据。
 * 连上主机之后调一次；装了新 MCP 可以再调（后来者覆盖）。
 */
function reportLocalToolCaps() {
  const manager = getManager();
  if (!manager || typeof manager.reportToolCaps !== "function") return false;
  try {
    const mcp = require("../mcp/mcpManager");
    const servers = Array.isArray(mcp.readMcpServers()) ? mcp.readMcpServers() : [];
    const skills = Array.isArray(mcp.readSkills()) ? mcp.readSkills() : [];
    const toolNames = Array.isArray(mcp.getLocalToolNames()) ? mcp.getLocalToolNames() : [];
    return manager.reportToolCaps({
      mcpServers: servers
        .map((s) => (s && typeof s.name === "string" ? s.name : ""))
        .filter(Boolean),
      skills: skills.map((s) => s.id).filter(Boolean),
      toolNames: toolNames
        .map((nm) => {
          if (typeof nm !== "string" || !nm) return null;
          return {
            name: nm,
            source: nm.startsWith("skill__") ? "skill" : "mcp",
            owner: nm.split("__")[0],
          };
        })
        .filter(Boolean),
    });
  } catch (e) {
    console.warn(`[net] 上报工具能力失败: ${e?.message || e}`);
    return false;
  }
}

/**
 * 组网同步过来的配置落到本机。
 *
 * 于是组网下发的模型/人格/搜索配置，本机控制台与桌宠版都能看到。
 * 五个同步字段全部有落点（早期版本只落 model/endpoint，其余记日志丢弃——
 * 那时核心版还没有 basePersona/searchProvider 这些配置，现在有了）。
 */
function applyConfigChange(patch, fromDeviceId) {
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (typeof value !== "string") continue;
    if (!SYNC_FIELDS.includes(key)) {
      skipped.push(key);
      continue;
    }
    modelConfigFile.setProfilePatch({ [key]: value });
    applied.push(key);
  }
  // 配置变了要让上下文池里缓存的客户端失效，否则还是按旧端点/旧模型发请求
  if (applied.length) {
    const uid = Number(process.env.BOT_MODEL_UID || 1);
    contextPool.invalidate(uid);
  }
  log(`已应用来自 ${fromDeviceId || "本机"} 的配置：${applied.join("、") || "无"}`);
  if (skipped.length) {
    log(`以下配置项不在同步范围内，已忽略：${skipped.join("、")}`);
  }
}

/** 本机当前是否以「叶子」身份在工作（活锁模型核心，见 ARCHITECTURE-PLAN 3.1）。 */
function shouldUplink() {
  return !!(manager && manager.snapshot().role === "leaf");
}

/**
 * 把一条消息上行给主机并等回包。
 *
 * @param {Object} p { sessionId, content, images?, kbContext?, onDelta? }
 *   kbContext：本机（核心版作为叶子时）自己检索到的知识片段。
 *   onDelta：正文逐字回调（可选）。传了才会向主机请求流式；主机版本旧不支持时
 *            一条增量都不来 —— 调用方必须能只靠最终回包正常工作。
 * @returns {ok:true, frame} | {ok:false, reason}
 *   失败时调用方应回退到本地独立处理（组网断掉不该让机器人变砖）。
 */
function uplinkChat({ sessionId, content, images, kbContext, onDelta }) {
  if (!manager) return Promise.resolve({ ok: false, reason: "not-connected" });
  const timeoutMs = Number(process.env.NET_UPLINK_TIMEOUT_MS || 45000);
  return manager.relayAndWait(content, sessionId, {
    images,
    timeoutMs,
    kbContext,
    onDelta: typeof onDelta === "function" ? onDelta : undefined,
  });
}

/**
 * 一次性迁移：早期核心版把角色放 .env（NET_ROLE）与 data/net/ 下。
 * 现在一律以 net-state.json 为准 —— 发现文件里角色还是 off 而 .env 有配，
 * 就把角色搬进去，之后 .env 不再参与（避免「改了 .env 不生效」这种半配置状态）。
 *
 * 已经配过的一律以文件为准，绝不拿 .env 覆盖用户已有的选择。
 */
function migrateLegacyEnvRole() {
  const raw = String(process.env.NET_ROLE || "").trim().toLowerCase();
  if (!ROLES.includes(raw) || raw === "off") return;
  if (manager.snapshot().role !== "off") return; // 文件里已有角色，以文件为准
  log(`发现旧的 .env 配置 NET_ROLE=${raw}，已迁移到 net-state.json（之后以文件为准，可删掉那行）`);
  if (raw === "host") {
    manager.startHosting(pickExpiry(process.env.NET_PAIRING_EXPIRY)).catch((e) =>
      console.warn(`[net] 迁移后启动主机失败：${e?.message || e}`),
    );
  } else {
    const code = String(process.env.NET_PAIRING_CODE || "").trim();
    if (code) {
      manager.startFollowing(code).then((r) => {
        if (r.ok !== true) console.warn(`[net] 迁移后接入主机失败：${r.error}`);
      });
    } else {
      manager.resumeFollowing();
    }
  }
}

/**
 * 启动组网。由 src/app.js 在 HTTP 服务起来之后调用。
 *
 * 与桌面端的差别：桌面端创建 manager 后等用户点开关；核心版是常驻服务，
 * 没有人来点，所以按 net-state.json 里持久化的角色**自动归位**
 * （host → 起监听；leaf → 凭保存的凭据重连）。role=off 就什么都不做。
 */
async function start() {
  const modelUid = Number(process.env.BOT_MODEL_UID || 1);

  manager = new NetManager(NET_DIR, {
    // 组网包自己的日志已经带 [net] 前缀了，这里不要再加一层（否则出现 "[net] [net] ..."）
    onLog: (message) => console.log(message),
    onFallbackNotice: (message) => console.warn(`⚠️ [net] ${message}`),
    // 主机把结果广播给全网，核心版自己是无界面的 —— 对话已在执行器里入库，
    // 这里没有要展示的东西，只记一条日志便于排障。
    onRelayResult: (frame) => {
      const text = String(frame?.speech || "");
      log(`广播回复（${frame?.requestId || "?"}）：${text.slice(0, 40)}`);
    },
    onRelayBusy: (frame) => {
      log(`拒绝了上行请求：${frame?.reason || "主机忙"}`);
    },
    onConfigChanged: applyConfigChange,
    onConfigPush: (frame) => {
      // 叶子侧：收到主机下发。写进同一份 config.json（与桌面端同行为）。
      applyConfigChange(frame?.patch, "主机");
    },
    // 叶子侧：主机点名要本机跑一次工具（阶段 5）。
    // 本机的 MCP/skill 只在本机可用，所以必须在本地执行再把结果回传。
    onToolCall: (frame) => {
      void runLocalToolCall(frame);
    },
    // 叶子接上主机后把「本机有哪些工具」报一次（阶段 5）。
    // 只在 connected 上报，且同一状态不去重复刷 —— snapshot 会被各种事件触发。
    onSnapshot: (snap) => {
      if (!snap || snap.leafStatus !== "connected") {
        capsReported = false; // 掉线后重置，重连时会再报一次
        return;
      }
      if (capsReported) return;
      capsReported = true;
      // 延后一拍：此刻刚握手完成，等工具表刷新完再报更准
      setTimeout(() => {
        try {
          reportLocalToolCaps();
        } catch (e) {
          console.warn(`[net] 上报工具能力失败: ${e?.message || e}`);
        }
      }, 500);
    },
  });

  if (!hostExecutorAttached) {
    manager.attachHostExecutor(buildHostExecutor(modelUid), backfillSink);
    hostExecutorAttached = true;
  }

  // 连接码里写哪个地址：容器 / 多网卡部署必须显式指定（部署层覆盖，不属于用户配置）。
  manager.setAdvertiseHost(process.env.NET_ADVERTISE_HOST);

  // 旧版核心版把角色放 .env：做一次性迁移，之后一律以 net-state.json 为准
  // （避免「改了 .env 不生效」这种半配置状态 —— 用户拍板「不留半配置」）。
  migrateLegacyEnvRole();

  const role = manager.snapshot().role;
  if (role === "off") {
    log(`组网未开启（net-state.json 里 role=off）。配置文件：${HOME_PATHS.netState}`);
    return { started: false, reason: "role-off" };
  }

  try {
    if (role === "host") {
      const started = await manager.startHosting();
      if (!started || started.ok !== true) {
        // 端口占用等：如实报出来，别让运维以为在跑
        console.error(
          `❌ [net] 主机启动失败（端口 ${NET_PORT} 可能被占用）：${(started && started.error) || "未知原因"}`,
        );
        return { started: false, reason: "host-start-failed" };
      }
      log(`已成为主机，监听端口 ${NET_PORT}，本机地址 ${manager.addresses().join(" / ") || "（未取到）"}`);
      log(`连接码里会写这个地址：${manager.snapshot().address}`);
      log("在桌宠端「组网」页或本控制台生成连接码，即可让其他设备接入。");
    } else {
      // 叶子：凭据在 net-state.json 里，直接恢复；没有就等用户在控制台贴码
      const resumed = manager.resumeFollowing();
      if (resumed.ok === true) {
        log("已按上次保存的凭据重新接入主机。");
      } else {
        log(`还没有可用的主机凭据（${resumed.error}），请在控制台「组网」页贴入主机给的连接码。`);
      }
    }
  } catch (e) {
    console.error(`❌ [net] 启动组网时出错（不影响机器人本身）：${e?.message || e}`);
    return { started: false, reason: "exception" };
  }

  return { started: true, role };
}

/** 退出时释放：走与桌面端一致的 dispose。 */
function stop() {
  if (!manager) return;
  try {
    manager.dispose();
    log("已退出组网");
  } catch (e) {
    console.warn(`[net] 关闭组网时出错：${e?.message || e}`);
  }
  manager = null;
  hostExecutorAttached = false;
}

/**
 * 当前组网快照（控制台「组网」页的唯一数据源）。
 * manager 一定存在（启动时就建了），所以 off 状态也能拿到 deviceId/deviceName 等，
 * 用户点「开启组网」时界面已经有东西可显示。
 */
function snapshot() {
  if (!manager) return { enabled: false, running: false, state: null };
  const snap = manager.snapshot();
  return {
    enabled: snap.role !== "off",
    running: snap.role !== "off",
    state: snap,
  };
}

function getManager() {
  return manager;
}

// ── 以下为控制台 /api/net/* 的直接出口，与桌面端 electron/net/ipc.ts 一一对应 ──

function requireManager() {
  if (!manager) return { ok: false, error: "组网功能还没准备好，稍等一下再试" };
  return { ok: true, manager };
}

function withSnapshot(result) {
  return { ...result, snapshot: snapshot().state };
}

/** 本机可用于组网的地址（页面提示「用哪个地址连」）。 */
function getAddresses() {
  const r = requireManager();
  if (!r.ok) return r;
  return { ok: true, addresses: r.manager.addresses() };
}

/** 能不能开组网（UI 据此决定开关要不要灰掉）。 */
function canStart() {
  const r = requireManager();
  if (!r.ok) return r;
  return { ok: true, enabled: r.manager.canStartNetworking() };
}

/** 作为主机开启组网，并生成第一个连接码。 */
async function startHost(expiry) {
  const r = requireManager();
  if (!r.ok) return r;
  const res = await r.manager.startHosting(pickExpiry(expiry));
  if (res.ok !== true) return withSnapshot(res);
  return withSnapshot({ ok: true, code: r.manager.serializePairing(res.code) });
}

/** 再生成一个连接码（每台设备一个码）。 */
function issuePairing(expiry) {
  const r = requireManager();
  if (!r.ok) return r;
  const code = r.manager.issuePairing(pickExpiry(expiry));
  return withSnapshot({ ok: true, code: r.manager.serializePairing(code) });
}

/** 作为叶子加入：填入连接码完成首次配对。 */
async function join(pairingText) {
  const r = requireManager();
  if (!r.ok) return r;
  const text = typeof pairingText === "string" ? pairingText.trim() : "";
  if (!text) return { ok: false, error: "先把主机给你的连接码整串粘进来" };
  const res = await r.manager.startFollowing(text);
  return withSnapshot(res);
}

/** 重新加入已配对的主机（打开开关时用，不需要重新填码）。 */
function resume() {
  const r = requireManager();
  if (!r.ok) return r;
  return withSnapshot(r.manager.resumeFollowing());
}

/**
 * 关闭组网。只「暂停参与」，不清除主机地址 / 长期凭据 / 已生成的连接码 ——
 * 下次打开凭持久化信息自动归位（ARCHITECTURE-PLAN 5.7「退出不清除」铁律）。
 */
function stopNetworking() {
  const r = requireManager();
  if (!r.ok) return r;
  r.manager.stopNetworking();
  return withSnapshot({ ok: true });
}

/** 撤销某个连接码：作废配对入口，不影响已连上的设备。 */
function revokePairing(id) {
  const r = requireManager();
  if (!r.ok) return r;
  if (typeof id !== "string" || !id) return { ok: false, error: "没指定要撤销哪个" };
  r.manager.revokePairingCode(id);
  return withSnapshot({ ok: true });
}

/** 清理已过期的连接码。 */
function prunePairings() {
  const r = requireManager();
  if (!r.ok) return r;
  r.manager.prunePairings();
  return withSnapshot({ ok: true });
}

/** 移除设备：作废它的长期凭据，之后再也连不上。 */
function removeDevice(deviceId) {
  const r = requireManager();
  if (!r.ok) return r;
  if (typeof deviceId !== "string" || !deviceId) return { ok: false, error: "没指定要移除哪台设备" };
  r.manager.removeDevice(deviceId);
  return withSnapshot({ ok: true });
}

/** 叶子端「移除自己」：断开与主机的绑定并清掉本地凭据。 */
function leaveHost() {
  const r = requireManager();
  if (!r.ok) return r;
  r.manager.leaveHost();
  return withSnapshot({ ok: true });
}

/** 改本机在组网里的显示名。 */
function renameSelf(name) {
  const r = requireManager();
  if (!r.ok) return r;
  r.manager.renameSelf(typeof name === "string" ? name : "");
  return withSnapshot({ ok: true });
}

/** 立刻把待同步的离线对话补传给主机（控制台上的「立即同步」按钮）。 */
function flushBackfill() {
  const r = requireManager();
  if (!r.ok) return r;
  r.manager.flushBackfillNow();
  return withSnapshot({ ok: true });
}

/** 读配置同步白名单。只有主机侧有内容；叶子侧返回空数组（看不到也改不了）。 */
function getSyncWhitelist() {
  const r = requireManager();
  if (!r.ok) return r;
  return { ok: true, whitelist: r.manager.syncWhitelist(), fields: [...SYNC_FIELDS] };
}

/** 设置白名单。调整后立即生效，不需要叶子重新连接。 */
function setSyncWhitelist(fields) {
  const r = requireManager();
  if (!r.ok) return r;
  const clean = Array.isArray(fields) ? fields.filter((f) => SYNC_FIELDS.includes(f)) : [];
  r.manager.setSyncWhitelist(clean);
  return withSnapshot({ ok: true, whitelist: r.manager.syncWhitelist() });
}

/** 出口忙不忙（主机侧显示排队情况）。 */
function relayStats() {
  const r = requireManager();
  if (!r.ok) return r;
  return { ok: true, stats: r.manager.relayStats() };
}

/** 签发一个连接码并把文本形式返回（保留旧出口，控制台与脚本都能用）。 */
function createPairingCode(expiryKey) {
  if (!manager) return null;
  const code = expiryKey ? manager.issuePairing(expiryKey) : manager.issuePairing();
  return { text: manager.serializePairing(code), meta: code };
}

module.exports = {
  start,
  stop,
  snapshot,
  getManager,
  createPairingCode,
  shouldUplink,
  uplinkChat,
  // 控制台 /api/net/* 用（与桌面端 IPC 一一对应）
  getAddresses,
  canStart,
  startHost,
  issuePairing,
  join,
  resume,
  stopNetworking,
  revokePairing,
  prunePairings,
  removeDevice,
  leaveHost,
  renameSelf,
  flushBackfill,
  getSyncWhitelist,
  setSyncWhitelist,
  relayStats,
  // 阶段 5：叶子把本机可远程调用的工具报给主机（连上主机后调一次）
  reportLocalToolCaps,
  // 配置文件位置（设置页展示 + 排错）
  stateFilePath: () => HOME_PATHS.netState,
  identityFilePath: () => HOME_PATHS.netIdentity,
};
