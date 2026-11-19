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
// 主机侧如何认出这是工作空间任务：sessionId 用固定前缀 `workspace:<taskId>`，
// buildHostExecutor 看到这个前缀就转给 runLocally() —— 而不是当成普通闲聊。
// 这样主机也会正确记运行次数、清旧文件，两边的元信息不会各说各话。
//
// 主机连不上时降级：不执行、把 job 顺延，绝不因为组网断了把任务错记成跑过了。
const workspace = require('./workspace');

/** 工作空间任务的会话 ID 前缀。叶子靠它让主机认出「这是任务，不是闲聊」。 */
const SESSION_PREFIX = 'workspace:';

function sessionIdFor(taskId) {
    return `${SESSION_PREFIX}${taskId}`;
}

function isWorkspaceSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith(SESSION_PREFIX);
}

function taskIdFromSession(sessionId) {
    if (!isWorkspaceSession(sessionId)) return '';
    return String(sessionId).slice(SESSION_PREFIX.length).split(':')[0];
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
 * 字段：taskId / instruction 必存；deliver 控制要不要推给用户；
 * repeat/hour/minute/weekday/day 是 weekly、monthly 的顺延依据（daily、once 不需要）。
 */
function buildPayload({ taskId, instruction, deliver = true, repeat, hour, minute, weekday, day }) {
    const out = { taskId, instruction: String(instruction || ''), deliver: !!deliver };
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
 */
function buildInstruction(task, dateStr) {
    const lines = [
        `[定期任务 · 无人值守执行]`,
        `这是你的工作空间里任务「${task.title}」的例行执行，今天日期 ${dateStr}。`,
        `任务文件夹的 taskId 是 ${task.taskId}（工作空间里对应的文件夹名）。`,
        '',
        '要做的事：',
        task.instruction || task.description || '（这个任务没有写明具体内容，按标题理解即可。）',
        '',
        '执行要求：',
        `1. 产出请用 workspace 能力写进工作空间，taskId 固定用 ${task.taskId}，不要自己另起一个。`,
        '2. 文件名里带上日期（例如 2026-11-19.md），这样历史产出能一天一天留下来。',
        '3. 如果这个任务需要看之前的结果（比如对比、累计），先用 workspace 的 ls/read 读回来再写。',
        '4. 这次是到点自动跑的，没有人在屏幕前等你：不要反问，不要要求确认，直接做完。',
        '5. 做完后给主人一两句话说明这次做了什么、写到了哪个文件。语气自然，别写成分条报告。',
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
 * @param {Object} p { taskId, title, instruction, modelUid, deliver, sessionId }
 *   sessionId：可选覆盖。主机替叶子执行时传 net:<设备>:workspace:<taskId>，
 *   避免与主机自己跑同一个任务时共用一份对话上下文（两边会互相串）。
 * @returns {{ok:boolean, speech?:string, error?:string, skipped?:boolean}}
 */
async function runLocally({ taskId, title, instruction, modelUid = 1, deliver = true, sessionId = '' } = {}) {
    const id = workspace.safeSegment(taskId, 'taskId');
    // title 为空时不要覆盖已有 meta —— ensureTask 的 patch.title 是「给了就改」，
    // 主机替叶子执行时拿不到标题（上行 payload 里不带），传空串会把用户设的名字清掉。
    workspace.ensureTask(id, title ? { title } : {});

    // 注入到提示词里的「这个任务是什么」：从 meta 取最新标题/描述，避免 job 里存的旧标题
    const meta = workspace.readTaskMeta(id) || {};
    const runnable = {
        taskId: id,
        title: meta.title || title || id,
        instruction: instruction || meta.description || '',
        description: meta.description || '',
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
            sessionId: sessionId || sessionIdFor(id),
            // 位置/人格/技能：用本机自己的配置（主机执行时就是主机的配置，
            // 与「全网只有一个大脑出口」一致）
            locationScope: null,
            persona: null,
            skillPrompts: [],
            kbContext: null,
            ws: null,
        });

        const speech = (reply && reply.speech) || '';
        workspace.recordRun(id);

        // 清理超龄/超量文件。失败不影响任务本身（产物已经写好了）。
        try {
            workspace.pruneTask(id);
        } catch (e) {
            console.warn(`[wsTask] 清理 ${id} 失败（已忽略）:`, e?.message || e);
        }

        return { ok: true, speech };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[wsTask] 任务 ${id} 执行失败:`, reason);
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
        // sessionId 用 workspace:<taskId>，主机据此认出这是工作空间任务。
        //
        // content 传的是 **JSON 载荷**而不是已经拼好的自然语言：
        // 主机侧的 runLocally 会自己调 buildInstruction（带上主机本地日期、
        // 从主机自己的 meta 取最新标题）。传成品文本的话，日期与标题都会被冻结
        // 在叶子的时刻，跨时区或者任务改过标题时就不对了。
        const safeId = workspace.safeSegment(taskId, 'taskId');
        const content = JSON.stringify({ taskId: safeId, title, instruction });

        const startedAt = Date.now();
        const res = await netBootstrap.uplinkChat({
            sessionId: sessionIdFor(safeId),
            content,
        });

        if (!res || res.ok !== true) {
            const reason = (res && res.reason) || 'unknown';
            console.warn(`[wsTask] 叶子转发失败（taskId=${taskId}，${reason}），本轮跳过，任务顺延`);
            // 返回 true 让调度器照常 fireJob 顺延 —— 否则 pending 会让 15s 一轮热重试。
            // 但**不记运行次数**：任务其实没跑成，meta 里不该多一次。
            return true;
        }

        const frame = res.frame || {};
        const speech = frame.speech || (frame.result && frame.result.speech) || '';
        console.log(
            `[wsTask] 叶子任务 ${taskId} 已由主机执行完成（${Date.now() - startedAt}ms，产出写在主机）`,
        );

        if (deliver && speech) {
            try {
                const { pushProactiveMessage } = require('../websocket/socketServer');
                pushProactiveMessage(uid, {
                    speech,
                    sessionId: job.sessionId || sessionIdFor(taskId),
                    emotion: 'happy',
                });
            } catch (e) {
                console.warn('[wsTask] 推送任务结果失败（已忽略）:', e?.message || e);
            }
        }
        return true;
    }

    // ── 主机 / 独立运行：本机执行 ──
    const result = await runLocally({ taskId, title, instruction, modelUid: uid, deliver });

    if (deliver && result.ok) {
        try {
            const { pushProactiveMessage } = require('../websocket/socketServer');
            pushProactiveMessage(uid, {
                speech: result.speech || `「${title}」跑完了。`,
                sessionId: job.sessionId || sessionIdFor(taskId),
                emotion: 'happy',
            });
        } catch (e) {
            console.warn('[wsTask] 推送任务结果失败（已忽略）:', e?.message || e);
        }
    }
    return true;
}

module.exports = {
    SESSION_PREFIX,
    sessionIdFor,
    isWorkspaceSession,
    taskIdFromSession,
    parsePayload,
    buildPayload,
    buildInstruction,
    todayStr,
    runLocally,
    fire,
};
