// src/services/workspaceTask.js
// 定期自动化任务：让「工作空间」真正跑起来。
//
// ── 这是什么 ──────────────────────────────────────────────────────
// 一条 kind=workspace_task 的 scheduled_job，到点后：
//   1. 确保 ~/KirariWorkspace/<taskId>/ 存在
//   2. 把「这个任务要做什么」写成一段指令交给模型，**允许它用工具**
//   3. 模型自己调 workspace 能力把产出写进任务文件夹
//   4. 记一次运行、按保留策略清理旧文件、把结果推给用户
//
// 与前两种 job 的区别：reminder 只是「到点说句话」，daily_brief 是固定的天气新闻
// 采集。workspace_task 是**用户自己定的、要留下东西的**任务，所以它需要完整工具集
// 与一个落盘的去处。
//
// ── 叶子节点（从机）照旧转发给主机 ────────────────────────────────
// 用户原话：「注意，从机（叶子节点）的任务依旧转发给主机完成」。
//
// 为什么这样定：活锁模型的语义是「全网只有一个大脑出口」——叶子上没有模型凭证，
// 有凭证也不该用（那会变成两台设备各买一份、各跑一份，结果还不一致）。
//
// 所以叶子到点时不是本地跑，而是 uplinkChat() 把同一条指令上行给主机；
// 主机用自己的凭证执行，**文件也写在主机的 ~/KirariWorkspace 里**，叶子只收回结果。
// 这与用户定的「写主机、叶子只拿结果」完全一致。
//
// 主机侧如何认出这是工作空间任务：sessionId 用固定前缀 `workspace:`，
// buildHostExecutor 看到这个前缀就转给 runLocally() —— 而不是当成普通闲聊。
// 这样主机也会正确记运行次数、清旧文件，两边的元信息不会各说各话。
//
// ── 会话 id 里带上 owner（2026-11-20）────────────────────────────
// 格式：`workspace:<owner>:<taskId>`。
// 不改的话，主机只知道「要跑 taskId=X」，不知道 X 是谁的 —— 而工作空间已按 owner
// 分层，缺 owner 就只能瞎猜或退化成公共目录，隔离白做。
//
// 老格式 `workspace:<taskId>`（2026-11-19 上线的那批）继续能认：owner 缺失时
// 由调用方决定（主机本地执行时用 job.uid 的对话者，找不到就退到 '_legacy'）。
// 兼容不是为了省事，是因为线上已经跑着 5 个老格式任务，不能一升级就全失效。
//
// 主机连不上时降级：不执行、把 job 顺延，绝不因为组网断了把任务错记成跑过了。
const workspace = require('./workspace');

/** 工作空间任务的会话 ID 前缀。叶子靠它让主机认出「这是任务，不是闲聊」。 */
const SESSION_PREFIX = 'workspace:';

/** 老格式（没有 owner 层）落盘时的归属名，一眼能看出是历史遗留。 */
const LEGACY_OWNER = '_legacy';

function sessionIdFor(owner, taskId) {
    const ow = workspace.ownerDirName(owner);
    const id = workspace.safeSegment(taskId, 'taskId');
    return `${SESSION_PREFIX}${ow}:${id}`;
}

function isWorkspaceSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith(SESSION_PREFIX);
}

/**
 * 从会话 id 里拆出 { owner, taskId }。
 * 两种格式都认：
 *   workspace:<owner>:<taskId>   → { owner, taskId }
 *   workspace:<taskId>           → { owner: '', taskId }（老格式，owner 待定）
 */
function parseSessionId(sessionId) {
    if (!isWorkspaceSession(sessionId)) return { owner: '', taskId: '' };
    const rest = String(sessionId).slice(SESSION_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length >= 2) return { owner: parts[0], taskId: parts.slice(1).join(':') };
    return { owner: '', taskId: rest };
}

/** 老调用点兼容：只取 taskId。 */
function taskIdFromSession(sessionId) {
    return parseSessionId(sessionId).taskId || '';
}

/** 老调用点兼容：只取 owner（可能是空串，表示老格式）。 */
function ownerFromSession(sessionId) {
    return parseSessionId(sessionId).owner || '';
}

/** job.payload 是 JSON 文本（TEXT 列）：解析失败返回 null，不抛。 */
function parsePayload(payload) {
    if (!payload) return null;
    try {
        const v = JSON.parse(payload);
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

/**
 * job.payload 是 JSON 文本（TEXT 列）。
 * 字段：taskId / owner / instruction 必存；deliver 控制要不要推给用户；
 * repeat/hour/minute/weekday/day 是 weekly、monthly 的顺延依据（daily、once 不需要）。
 *
 * owner 必须进 payload：调度器到点时手上只有 job 行，没有原始对话上下文。
 * 不存下来的话，「这是谁的任务」就永久丢了 —— 而工作空间是按 owner 分层的。
 */
function buildPayload({ taskId, owner, ownerName, ownerRole, instruction, deliver = true, repeat, hour, minute, weekday, day }) {
    const out = { taskId, instruction: String(instruction || ''), deliver: !!deliver };
    if (owner) out.owner = String(owner);
    // 创建者是谁、什么身份，一并带上：到点执行时手上的上下文只有这条 job，
    // 不存下来就永远不知道「这句提醒该对谁说话、该不该用『主人』这个称呼」。
    if (ownerName) out.ownerName = String(ownerName);
    if (ownerRole) out.ownerRole = String(ownerRole);
    if (repeat) out.repeat = String(repeat);
    if (Number.isFinite(hour)) out.hour = Number(hour);
    if (Number.isFinite(minute)) out.minute = Number(minute);
    if (Number.isFinite(weekday)) out.weekday = Number(weekday);
    if (Number.isFinite(day)) out.day = Number(day);
    return JSON.stringify(out);
}

/**
 * 交给模型的执行指令。
 *
 * 写作要点：
 *   - 明确 taskId，否则模型会自己编一个文件夹名，两次跑就分裂成两个任务
 *   - 明确「日期」并要求写进同一个文件/按天分文件，否则没有累积价值
 *   - 明确「这是无人值守的例行执行」：没有人在对面等，别反问、别等确认
 *   - 说明产出会推给用户，让结尾自然一点
 *   - **明确「这是谁的任务」**：2026-11-20 之前这里没有身份信息，模型只能按模板
 *     默认写「主人」，结果给别人建的任务也满口「主人」，用户看到别人的任务混进
 *     自己记忆里就是这么来的。称呼必须由 identityLine 显式给出，不能靠模型猜。
 */
function buildInstruction(task, dateStr) {
    const owner = String(task.owner || '');
    const isOwnerPerson = String(task.ownerRole || '') === 'owner';
    const who = String(task.ownerName || '').trim() || (isOwnerPerson ? '主人' : `用户 ${owner}`);
    // 只有确认是主人时才允许用「主人」这个称呼；其他人一律用名字，
    // 避免「非主人下达的指令被当成主人本人的意图」。
    const address = isOwnerPerson ? `${who}（就是主人本人）` : `${who}（普通用户，**不是主人**）`;

    const lines = [
        `[定期任务 · 无人值守执行]`,
        `这是工作空间里任务「${task.title}」的例行执行，今天日期 ${dateStr}。`,
        `任务的 taskId 是 ${task.taskId}（工作空间里对应的文件夹名）。`,
        `这个任务属于 owner=${owner}，写文件时必须用同一个 owner，不要写进别人的目录。`,
        '',
        `【这个任务是谁的】创建并拥有它的人是：${address}。`,
        isOwnerPerson
            ? '所以产出是给主人的，可以用「主人」称呼。'
            : '所以产出是给这位普通用户的：**不要称呼 ta 为「主人」**。'
                + '「主人」在这个系统里专指机器人的拥有者，用错会让用户以为自己下的指令在冒充主人身份。'
                + '如果原任务描述里写了「给主人发……」，那是创建时的模板话术，请按这位用户本人的口吻来写。',
        '',
        '要做的事：',
        task.instruction || task.description || '（这个任务没有写明具体内容，按标题理解即可。）',
        '',
        '执行要求：',
        `1. 产出请用 workspace 能力写进工作空间，owner 固定用 ${owner}、taskId 固定用 ${task.taskId}，不要自己另起一个。`,
        '2. 文件名里带上日期（例如 2026-11-19.md），这样历史产出能一天一天留下来。',
        '3. 如果这个任务需要看之前的结果（比如对比、累计），先用 workspace 的 ls/read 读回来再写。',
        '4. 这次是到点自动跑的，没有人在屏幕前等你：不要反问，不要要求确认，直接做完。',
        `5. 做完后给用户一两句话说明这次做了什么、写到了哪个文件。语气自然，别写成分条报告。`,
    ];
    return lines.join('\n');
}

/** 本地日期 YYYY-MM-DD（与简报一致，避免 toISOString 的 UTC 偏移）。 */
function todayStr(d = new Date()) {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

/**
 * 在本机真正执行一次任务：模型带工具跑，产出由模型自己写进工作空间。
 *
 * @param {Object} p { owner, taskId, title, instruction, ownerName, ownerRole, modelUid, deliver, sessionId }
 *   owner：这个任务属于谁（对话者标识）。必填 —— 工作空间按 owner 分层。
 *   ownerName / ownerRole：这个任务归谁、那人是不是主人。执行时用来决定称呼，
 *   不传就退回 meta 里存的（建任务时写进去的），最差情况只报 owner 数字。
 *   sessionId：可选覆盖。主机替叶子执行时传 workspace:<owner>:<taskId>，
 *   避免与主机自己跑同一个任务时共用一份对话上下文（两边会互相串）。
 * @returns {{ok:boolean, speech?:string, error?:string, skipped?:boolean}}
 */
async function runLocally({
    owner,
    taskId,
    title,
    instruction,
    ownerName = '',
    ownerRole = '',
    modelUid = 1,
    deliver = true,
    sessionId = '',
} = {}) {
    const ow = workspace.ownerDirName(owner);
    const id = workspace.safeSegment(taskId, 'taskId');
    // title 为空时不要覆盖已有 meta —— ensureTask 的 patch.title 是「给了就改」，
    // 主机替叶子执行时拿不到标题（上行 payload 里不带），传空串会把用户设的名字清掉。
    // 顺手把身份补进 meta：老任务第一次跑起来时就把 ownerName/ownerRole 落下来，
    // 之后就算 payload 丢了也知道该叫什么，不用每次依赖调用方传。
    const metaPatch = {};
    if (title) metaPatch.title = title;
    if (ownerName) metaPatch.ownerName = ownerName;
    if (ownerRole) metaPatch.ownerRole = ownerRole;
    workspace.ensureTask(ow, id, metaPatch);

    // 注入到提示词里的「这个任务是什么」：从 meta 取最新标题/描述，避免 job 里存的旧标题
    const meta = workspace.readTaskMeta(ow, id) || {};
    const runnable = {
        owner: ow,
        taskId: id,
        title: meta.title || title || id,
        instruction: instruction || meta.description || '',
        description: meta.description || '',
        // 身份优先级：本次调用传的 > 建任务时写进 meta 的。
        // 老任务 meta 里没有这两项，那就只剩 owner 数字，buildInstruction 会
        // 保守地按「普通用户」处理 —— 宁可不叫「主人」，也不能叫错。
        ownerName: ownerName || meta.ownerName || '',
        ownerRole: ownerRole || meta.ownerRole || '',
    };

    const connectionAiContext = require('../ai/connectionAiContext');
    const conversationService = require('./conversationService');

    let ctx = null;
    try {
        ctx = await connectionAiContext.createConnectionAiContext(modelUid);
        const content = buildInstruction(runnable, todayStr());

        const reply = await conversationService.getReply({
            aiContext: ctx,
            content,
            sessionId: sessionId || sessionIdFor(ow, id),
            // 位置/人格/技能：用本机自己的配置（主机执行时就是主机的配置，
            // 与「全网只有一个大脑出口」一致）
            locationScope: null,
            persona: null,
            skillPrompts: [],
            kbContext: null,
            ws: null,
        });

        const speech = (reply && reply.speech) || '';
        workspace.recordRun(ow, id);

        // 清理超龄/超量文件。失败不影响任务本身（产物已经写好了）。
        try {
            workspace.pruneTask(ow, id);
        } catch (e) {
            console.warn(`[wsTask] 清理 ${ow}/${id} 失败（已忽略）:`, e?.message || e);
        }

        return { ok: true, speech };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[wsTask] 任务 ${ow}/${id} 执行失败:`, reason);
        return { ok: false, error: reason };
    } finally {
        if (ctx) {
            try {
                connectionAiContext.cleanupConnectionAiContext(ctx);
            } catch {
                /* 忽略 */
            }
        }
    }
}

/**
 * 触发一条 workspace_task job。由 scheduledJobsService 在到点时调用。
 *
 * 叶子：上行给主机执行（产出写在主机），本机只拿结果。
 * 主机 / 独立运行：本机执行。
 *
 * @returns {boolean} true=这次真的执行了（无论成败），false=跳过（应由调度器顺延）
 */
async function fire(job, now = Date.now()) {
    const payload = parsePayload(job.payload);
    const taskId = (payload && payload.taskId) || String(job.jobId).split(':').pop();
    const instruction = (payload && payload.instruction) || '';
    const title = job.title || taskId;
    const uid = job.uid ?? 1;
    const deliver = payload ? payload.deliver !== false : true;

    // owner 三级兜底，顺序有讲究：
    //   1) payload.owner —— 建任务时就存下来的，最准
    //   2) job.sessionId 里的 owner —— 老格式没有 payload.owner 时退而求其次
    //   3) LEGACY_OWNER —— 都没有。宁可落到 _legacy 目录，也**不能**回退成「公共目录」：
    //      那会让所有历史任务重新混在一起，隔离白做。
    let owner = (payload && payload.owner) || ownerFromSession(job.sessionId) || '';
    if (!owner) owner = LEGACY_OWNER;

    // 谁的任务、那人是不是主人。到点执行时这是唯一能拿到身份的来源。
    const ownerName = (payload && payload.ownerName) || '';
    const ownerRole = (payload && payload.ownerRole) || '';

    // 惰性 require：net/bootstrap 会反过来用到不少服务，顶层引用容易出现环。
    let netBootstrap = null;
    try {
        netBootstrap = require('../net/bootstrap');
    } catch (e) {
        console.warn('[wsTask] 读取组网状态失败（按独立运行处理）:', e?.message || e);
    }

    const isLeaf = !!(netBootstrap && typeof netBootstrap.shouldUplink === 'function' && netBootstrap.shouldUplink());

    if (isLeaf) {
        // ── 叶子：转发给主机 ──
        // sessionId 用 workspace:<owner>:<taskId>，主机据此认出这是谁的工作空间任务。
        //
        // content 传的是 **JSON 载荷**而不是已经拼好的自然语言：
        // 主机侧的 runLocally 会自己调 buildInstruction（带上主机本地日期、
        // 从主机自己的 meta 取最新标题）。传成品文本的话，日期与标题都会被冻结
        // 在叶子的时刻，跨时区或者任务改过标题时就不对了。
        const safeId = workspace.safeSegment(taskId, 'taskId');
        const content = JSON.stringify({ owner, taskId: safeId, title, instruction, ownerName, ownerRole });

        const startedAt = Date.now();
        const res = await netBootstrap.uplinkChat({
            sessionId: sessionIdFor(owner, safeId),
            content,
        });

        if (!res || res.ok !== true) {
            const reason = (res && res.reason) || 'unknown';
            console.warn(`[wsTask] 叶子转发失败（${owner}/${taskId}，${reason}），本轮跳过，任务顺延`);
            // 返回 true 让调度器照常 fireJob 顺延 —— 否则 pending 会让 15s 一轮热重试。
            // 但**不记运行次数**：任务其实没跑成，meta 里不该多一次。
            return true;
        }

        const frame = res.frame || {};
        const speech = frame.speech || (frame.result && frame.result.speech) || '';
        console.log(
            `[wsTask] 叶子任务 ${owner}/${taskId} 已由主机执行完成（${Date.now() - startedAt}ms，产出写在主机）`,
        );

        if (deliver && speech) {
            // 必须 await：投递里有一条异步腿（按账号找客人通道），
            // 不 await 会让「结果没送到」在日志里看起来像已送出。
            await deliverResult(job, owner, taskId, speech);
        }
        return true;
    }

    // ── 主机 / 独立运行：本机执行 ──
    const result = await runLocally({ owner, taskId, title, instruction, ownerName, ownerRole, modelUid: uid, deliver });

    if (deliver && result.ok) {
        await deliverResult(job, owner, taskId, result.speech || `「${title}」跑完了。`);
    }
    return true;
}

/**
 * 把任务结果送到用户手上。
 *
 * ⚠️ 这里是 2026-11-20「7 点没收到提醒」的核心：
 * 原先只 pushProactiveMessage（桌面 WebSocket）。但任务往往是**在 QQ 里建的**，
 * 到点时桌面可能压根没开 —— 消息就这么静默丢了，job 却已经标成 fired。
 *
 * 所以三条腿都走：能发 QQ 就发 QQ（用户在哪建的就在哪收到），
 * 再推一次桌面（顺便让桌宠说出来）。全都失败才算真没送达。
 *
 * ── 2026-11-20 规范化：补上「按归属人发平台」这条腿（客人的任务全靠它）──
 *   用户问：「那别人的任务啊提醒啊，也会正确送达别人那里吗」
 *
 *   实测答案曾经是**不会**。客人的定期任务 session_id 是
 *   `workspace:<QQ号>:<任务名>`，不是 `bot-*`，而 pushToUserSession 只认
 *   `bot-` 前缀（第一行就 return false）。于是：
 *     · 桌面路：客人没有桌面连接 → 0
 *     · 平台路：前缀不匹配 → 直接 false
 *   两条都空，结果静默丢弃，还照样打印"结果送达"。
 *
 *   修法与提醒那条完全一致：
 *     1. 能按原会话发就按原会话发（bot-* 时最精确，回到原窗口）
 *     2. 不行就按**归属人**发：主人 → 主人私聊；客人 → 客人自己的私聊
 *     3. 全都失败时明确告警，不再假装送达
 *
 *   客人的身份键就是自己的 QQ 号，直接按它找适配器私聊，
 *   绝不会因为"不像主人"就退化成推给主人桌面（那是报障过的误投）。
 */
async function deliverResult(job, owner, taskId, speech) {
    let sentWs = 0;
    let sentQq = 0;
    const who = String(owner || '').trim();
    const body = String(speech || '').trim();

    // ⚠️ 桌面推送必须按 owner 定向，不能 pushProactiveMessage(uid)：
    // uid 对 QQ 上所有人都是同一个账号 id，那样等于把任务结果广播给所有桌面 ——
    // 「她的任务怎么跑到我这儿来了」就是这么发生的。
    try {
        const { pushProactiveMessageToOwner } = require('../websocket/socketServer');
        sentWs = pushProactiveMessageToOwner(owner, {
            speech,
            sessionId: job.sessionId || sessionIdFor(owner, taskId),
            emotion: 'happy',
        }) || 0;
    } catch (e) {
        console.warn('[wsTask] 推送桌面失败（已忽略）:', e?.message || e);
    }

    try {
        // ① 原会话通道：只有 bot-* 会话发得出去（用户在哪个窗口建的，回哪个）
        const botManager = require('../bot/botManager');
        if (typeof botManager.pushToUserSession === 'function') {
            sentQq = botManager.pushToUserSession(job.sessionId, speech) ? 1 : 0;
        }

        // ② 按归属人直发私聊 —— 客人的 workspace:/sub:: 任务只能靠这条。
        //    主人走 pushToOwnerPrivate（沿用既有做法的语义），
        //    其他人按自己的 QQ 号找适配器。
        if (!sentQq && who && body) {
            const ownerIdentity = require('./ownerIdentity');
            const isOwner = ownerIdentity.samePerson(who, ownerIdentity.getOwnerKey());
            if (isOwner && typeof botManager.pushToOwnerPrivate === 'function') {
                if (botManager.pushToOwnerPrivate(ownerIdentity.canonicalIdentity(who), body)) sentQq = 1;
            } else if (!isOwner && typeof botManager.pushToUserByAccount === 'function') {
                // 客人：按他自己的账号发，绝不进主人的窗口
                if (await botManager.pushToUserByAccount(who, body)) sentQq = 1;
            }
        }
    } catch (e) {
        console.warn('[wsTask] 回发消息失败（已忽略）:', e?.message || e);
    }

    if (sentWs > 0 || sentQq > 0) {
        console.log(
            `[wsTask] ${owner}/${taskId} 结果送达：桌面 ${sentWs} 个连接、平台 ${sentQq} 条`,
        );
    } else {
        // 与提醒那条一致：真的没送达时必须留痕，否则「任务跑了但没人收到」
        // 只能靠用户反馈才能发现（这次就是）。
        console.warn(
            `[wsTask] ⚠️ ${owner}/${taskId} 的结果没有送达任何地方`
            + `（桌面无连接、sessionId=${job.sessionId} 也发不出去）。内容：${String(speech || '').slice(0, 60)}`,
        );
    }
    return { sentWs, sentQq };
}

module.exports = {
    SESSION_PREFIX,
    LEGACY_OWNER,
    sessionIdFor,
    isWorkspaceSession,
    parseSessionId,
    taskIdFromSession,
    ownerFromSession,
    parsePayload,
    buildPayload,
    buildInstruction,
    todayStr,
    runLocally,
    deliverResult,
    fire,
};
