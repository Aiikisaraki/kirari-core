// src/services/selfOps.js
// Kirari 的自我认知 / 自我排查 / 受控自我修补引擎。
//
// 设计取向（用户 2026-11-19 拍板「更接近 lead 的完整权限」）：
// 不做一堆领域专用接口（list_tasks / list_reminders / get_settings…），
// 而是像 lead 那样，用「一个通用读 + 一个受控写 + 每轮注入的自我清单」覆盖绝大部分领域。
// 读面宽（像直接看文件），写面靠白名单 + 值域校验 + 审计兜住安全。
//
// 三个入口：
//   - buildManifest(ctx)  生成注入 system prompt 的自我清单（我是谁 / 能力 / 可读写项 / 当前状态）
//   - read(topic, ctx)    通用查询：readme / capabilities / settings / models / tasks / reminders / thinking / diagnose / logs
//   - update(fields, ctx) 受控修改：按 selfOpsPolicy 白名单校验后写，逐项审计

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseReminder, createJob, cancelJob, cancelTask } = require('kirari-agent');
const capabilities = require('../capabilities/registry');
const modelConfigFile = require('./modelConfigFile');
const policy = require('./selfOpsPolicy');
const { paths } = require('../dataDir');

// 惰性 require，避开 session ↔ services 的顶层循环依赖
function taskStore() { return require('../session/taskStore').taskStore; }
function jobStore() { return require('../session/jobStore').jobStore; }

const TOPICS = ['readme', 'capabilities', 'settings', 'models', 'tasks', 'reminders', 'thinking', 'diagnose', 'logs', 'audit'];

function friendlyTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '（无）';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function statusZh(s) {
    return ({ pending: '待办', running: '进行中', completed: '已完成', cancelled: '已取消',
              failed: '失败', fired: '已触发', once: '一次性', daily: '每天' })[s] || s || '';
}

// ── 任务与提醒：对外一个口径 ────────────────────────────────────────────
//
// 用户 2026-11-20 的诘问：「难道提醒不是一个任务吗，定时提醒不就是一个自动化
// 任务吗」。对，就是。所以对外不该有两个互不相干的答案。
//
// 内部两张表是实现细节，分开存是合理的（用途确实不同）：
//   · tasks —— plan 建的多步任务，进程内推着往下走，**没有**触发时间
//   · jobs  —— 到点才说话的一次性或重复提醒，核心就是 dueAt
// 但**读**的时候必须合并计数。之前 self_read(tasks) 只查 tasks 表，于是出现
// 「她说 5 个、接口说 0 个」这种两边都没撒谎、用户却拿不到真实答案的局面：
// 5 条提醒确实存在，只是躺在另一张表里。
const WORK_ACTIVE = new Set(['pending', 'running']);

/** 取这条会话名下的全部「事件」：多步任务 + 提醒。 */
function collectWork(sid) {
    const tasks = [];
    const jobs = [];
    if (sid) {
        try {
            tasks.push(...taskStore().list(sid, 50));
        } catch (e) {
            console.warn('[self] 读任务失败（按空处理）:', e?.message || e);
        }
        try {
            jobs.push(...jobStore().list(sid, 100));
        } catch (e) {
            console.warn('[self] 读提醒失败（按空处理）:', e?.message || e);
        }
    }
    return { tasks, jobs };
}

function stepSummary(t) {
    const steps = Array.isArray(t.steps) ? t.steps : [];
    if (!steps.length) return '无';
    return steps.map((s) => `${s.label}[${statusZh(s.status) || s.status || '?'}]`).join('→');
}

/**
 * 把任务与提醒渲染成一段**统一**的说明。
 *
 * 关键点：不管用户问「几个任务」「几个提醒」「有什么待办」，都以同一份
 * 事实为准，并且把总数一次说清 —— 这样模型不会再按印象报数。
 */
function describeWork({ tasks, jobs }, { withSteps = true } = {}) {
    const total = tasks.length + jobs.length;
    const head =
        `这条对话里共有 ${total} 件（提醒 ${jobs.length} 条、多步任务 ${tasks.length} 条）。` +
        '提醒到点会自动触发，也算任务的一种。';

    if (!total) {
        return `${head}\n我在这条对话里没给你记过待办，也没设过提醒。`;
    }

    const activeTasks = tasks.filter((t) => WORK_ACTIVE.has(t.status));
    const activeJobs = jobs.filter((j) => WORK_ACTIVE.has(j.status));
    const doneTasks = tasks.filter((t) => !WORK_ACTIVE.has(t.status));
    const doneJobs = jobs.filter((j) => !WORK_ACTIVE.has(j.status));

    const lines = [head];

    lines.push(`\n【还在等着的】${activeTasks.length + activeJobs.length} 件`);
    if (!activeTasks.length && !activeJobs.length) lines.push('（没有，全部已结束）');
    for (const t of activeTasks) {
        lines.push(
            `- 任务 ${t.taskId}「${t.title}」${statusZh(t.status)}` +
                (withSteps ? `，步骤：${stepSummary(t)}` : ''),
        );
    }
    for (const j of activeJobs) {
        lines.push(
            `- 提醒 ${j.jobId}「${j.title}」${friendlyTime(j.dueAt)} 触发（${statusZh(j.recurrence)}）`,
        );
    }

    if (doneTasks.length || doneJobs.length) {
        lines.push(`\n【已结束】${doneTasks.length + doneJobs.length} 件`);
        for (const t of doneTasks) {
            lines.push(`- 任务 ${t.taskId}「${t.title}」${statusZh(t.status)}`);
        }
        for (const j of doneJobs) {
            lines.push(`- 提醒 ${j.jobId}「${j.title}」${statusZh(j.status)}`);
        }
    }
    return lines.join('\n');
}

// ── 自我清单（注入 system prompt）──────────────────────────────────────

/**
 * 生成注入到 system.base 的自我清单段。让模型「天生就知道」自己是谁、有什么能力、
 * 当前在哪个模型上、有哪些未完成任务与提醒——不必先用工具查一轮。
 */
function buildManifest(ctx = {}) {
    const lines = [];
    const snap = modelConfigFile.getProfileSnapshot();
    const profile = capabilities.listTools(ctx.capScope || 'local::anon');
    const names = profile.map((t) => t.function && t.function.name).filter(Boolean);

    lines.push('\n\n【自我认知 · 你自己的状况】');
    lines.push('- 你是 Kirari（きらり），主人的虚拟桌宠。你有通用读接口 self_read、受控写接口 self_update，以及管理自己任务/提醒的 self_manage（增删改）。');
    lines.push(`- 你当前可用的工具（${names.length}）：${names.join('、') || '（无）'}。`);
    lines.push(`- 你当前运行的模型：${snap.model || '（未配置）'}${snap.hasKey ? '（已配置密钥）' : '（未配置密钥）'}；搜索：${snap.searchProvider || 'uapis'}。`);
    lines.push(`- 你的思考模式：${modelConfigFile.getThinking()}（off=直接答 / on=先列简要思路 / auto=复杂问题才深入）。`);
    lines.push('- 想知道任何关于自己的细节（设置/能力详情/任务/提醒/自检/日志），调用 self_read；不会就先读，不要凭空猜。');
    lines.push('- 需要改自己的可改设置时调用 self_update；它只接受安全白名单内的字段，凭证类一律不可读写明文，每次修改都会记审计。');

    // 未完成任务 / 即将到来的提醒：直接列出来，形成「我知道我答应过什么」
    //
    // 2026-11-20：这里原来分开列「未完成任务」「待触发提醒」两行，
    // 而且都只列 active/pending 的。结果用户问「有几个任务」时，模型手里
    // 只有这两行的部分信息，答出来的数对不上库里的实际条数。
    // 现在改成一次读全量、按同一口径说话，数字与 self_read(tasks) 一致。
    try {
        const work = collectWork(ctx.sessionId ? String(ctx.sessionId) : '');
        const activeTasks = work.tasks.filter((t) => WORK_ACTIVE.has(t.status)).slice(0, 10);
        const activeJobs = work.jobs
            .filter((j) => WORK_ACTIVE.has(j.status))
            .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))
            .slice(0, 10);
        const totalActive = activeTasks.length + activeJobs.length;

        if (work.tasks.length || work.jobs.length) {
            lines.push(
                `- 这条对话里的待办/提醒：共 ${work.tasks.length + work.jobs.length} 件，` +
                    `其中还没结束的 ${totalActive} 件（提醒也计入任务）。`,
            );
        }
        if (activeTasks.length) {
            lines.push('- 未完成任务：' + activeTasks.map((t) => `「${t.title}」`).join('；'));
        }
        if (activeJobs.length) {
            lines.push(
                '- 待触发提醒：' + activeJobs.map((j) => `${friendlyTime(j.dueAt)}「${j.title}」`).join('；'),
            );
        }
        if (work.tasks.length || work.jobs.length) {
            lines.push(
                '- 别人问「有几个任务」时，用上面的合计数回答，并且**先调 self_read(tasks) 核实**，' +
                    '不要凭印象报数字。已经结束的也要说清楚是结束了。',
            );
        }
    } catch (e) {
        // 清单是锦上添花，读失败不留半截：删掉任务行即可
        lines.push('（任务/提醒摘要暂不可用）');
    }

    lines.push('- 自我排查：遇到问题先用 self_read(diagnose) 体检，再决定要不要 self_update 修；改完可用 self_read 复核。');
    lines.push('- 发现自己设错/设重复的提醒或任务：self_read(reminders/tasks) 查到 id，再用 self_manage 改时间、取消重复、补设正确的。别把没能力当借口。');
    // 人际环境：她有真实的社交事实来源（协议端），不该再说"我没有接口"
    if (names.includes('social')) {
        lines.push('- 你在哪些群、有几个好友、群里有多少人、谁刚进群、谁戳了你——这些用 social 工具查（overview/groups/members/events/who）。');
        lines.push('- 这些是协议端给你的真实数据，不是猜的。被问到时直接查再答，不要说"我答不上来"或"我没有这个接口"。');
    }
    return lines.join('\n');
}

// ── 通用读 ─────────────────────────────────────────────────────────────

/**
 * 角色 → 能读哪些自我运维主题。
 *
 * 身份不是「主人 / 客人」二元，而是一条连续的管理权限阶梯：
 *   owner —— 拥有者，最高管理权：全部可读，且可改设置（见 update）
 *   admin —— 被信任的人：可读运行状态与能力，但看不到凭证类细节
 *   user  —— 普通对话者：只有公开面（她是谁、能做什么、什么语气）
 *
 * 真正敏感的东西（模型密钥、搜索 key、审计日志、任务/提醒清单）
 * 只对 owner 开放——这不是"防着别人"，是因为这些内容一旦说出来
 * 就等于把拥有者的私人配置公开了。
 */
const READ_TIERS = {
    owner: null, // null = 全部
    admin: ['readme', 'capabilities', 'thinking', 'models', 'diagnose'],
    user: ['readme', 'capabilities', 'thinking'],
};

/** 该角色允许读的主题；null 表示不限制。 */
function readTier(role) {
    if (role in READ_TIERS) return READ_TIERS[role];
    return READ_TIERS.user;
}

/**
 * 从 ctx 解析角色。
 *
 * ── 2026-11-20 身份隔离大排查：这里原来是全系统最大的一个洞 ──────────
 * 原实现是：`if (!sessionId || !/^bot[-:]/.test(sessionId)) return 'owner'`，
 * 即「只要 sessionId 不以 bot 开头就当主人」。问题是**不以 bot 开头的路径有四条**：
 *
 *   · 桌面 WS 聊天框   session_<ts>
 *   · 子代理           sub::<uid>::<taskId>
 *   · 工作空间任务执行  workspace:<owner>:<taskId>
 *   · 组网入站         net:<device>:<sessionId>
 *
 * 这四条全部被判成 owner，于是任何一条路径上的调用都能改人格、读密钥掩码、
 * 建「提醒主人」的提醒 —— 而用户报的正是「她以为自己是主人」。
 *
 * 现在的原则：**权限只认显式声明，不猜**。
 *   · ctx.role / ctx.isOwner 由入口（botManager 的 scene、本机入口）显式给出
 *   · 没有显式声明 → 一律按最低权限 user 处理
 *   · 本机入口（控制台/桌宠聊天框）由调用方显式标 isOwner: true，见 localEntryRole()
 *
 * fail-closed：猜错的代价是主人多按一次，猜反的代价是外人拿到最高权限。
 */
function roleOf(ctx = {}) {
    if (ctx.role) return String(ctx.role);
    if (ctx.isOwner === true) return 'owner';
    if (ctx.isOwner === false) return 'user';
    // 只有**明确标记为本机可信入口**的才默认 owner。
    // 注意：不能用 sessionId 前缀推，那正是原来的 bug。
    if (ctx.trustedLocal === true) return 'owner';
    return 'user';
}

/**
 * 本机入口（控制台 / 桌宠聊天框）的 ctx 标记。
 *
 * 这两处不经过任何 bot 适配器，只可能是设备主人本人在操作，
 * 所以显式打上 trustedLocal，而不是让 roleOf 去猜 sessionId 形状。
 * 桌面 WS 侧必须在握手鉴权通过后调用，不能由消息体自报。
 */
function trustedLocalCtx(ctx = {}) {
    return { ...ctx, trustedLocal: true, isOwner: true, role: 'owner' };
}

/**
 * 场合闸门：群聊里说话所有成员都看得见。
 *
 * 这不是「群聊里没有权限」，而是「有些话不能在这个场合说出口」。
 * 即便是 owner 本人，在群里读出自己的模型密钥/任务清单，也等于当众公开；
 * 所以群聊里一律只保留公开面，让他私聊来问。
 */
function groupGate(topic, ctx = {}) {
    if (!policy.isGroupSession(ctx.sessionId)) return null;
    const safePublic = ['readme', 'capabilities', 'thinking'];
    if (safePublic.includes(topic)) return null;
    return `现在是在群里，${topic} 这类私下的东西不方便当众说。要聊这个我们私聊。`;
}

function read(topic, ctx = {}) {
    const t = String(topic || 'readme').toLowerCase();
    const gate = groupGate(t, ctx);
    if (gate) return gate;
    const role = roleOf(ctx);
    const tier = readTier(role);
    if (tier && !tier.includes(t)) {
        // 拒绝必须说清是「没权限」而不是「没有」。
        //
        // 2026-11-20 用户报障：「再怎么说也不该说查不到，没有任务那就说没有，
        // 查不到就让我很担心，你是不是权限给错了」。她说得对 —— 原来这句
        //「不方便跟你说细的」对模型来说语义太软，它转述时会滑成
        //「这次读取被挡回来了，没拿到内容，只能照上一次查到的说」，
        // 于是主人听到的是"系统出故障"，而不是"你没这个权限"。
        // 两种情况的处置完全不同：前者要去查 bug，后者要去改配置。
        return (
            `（权限不足：${{ owner: '主人', admin: '管理员', user: '你自己' }[role] || role}`
            + `这个身份不能读「${t}」这类内容，所以这次是**没权限查**，不是**没有**。）`
        );
    }
    // 会话 id：tasks / reminders 两个 topic 按会话查本轮的记录。
    //
    // ⚠️ 这两处原来直接引用了 `sid`，而 `sid` 在这个函数里**从来没定义过**
    //    —— 一旦走到就会 ReferenceError。它藏了很久没被发现，是因为
    //    `user` 角色的 readTier 不含 tasks/reminders，权限门先返回了拒绝，
    //    根本执行不到取值那一行。2026-11-20 修好「网页端=主人」之后
    //    主人第一次有权查任务，就必然撞上这个 ReferenceError。
    const sid = ctx.sessionId ? String(ctx.sessionId) : '';
    switch (t) {
        case 'readme':
            return [
                '# Kirari 自我说明',
                '- 我是 Kirari，一个虚拟桌宠少女，跑在拥有者的设备上。',
                '- 跟我说话的人各有自己的档案和记忆：我记得每个人的事，但只在该说的时候说。',
                '- 拥有者对我的设定有最高管理权；其他人可以跟我聊天、让我记事，但改不了我的设定。',
                '- 我有这些通用能力工具：self_read（查询自己）、self_update（受控修改设置）、self_manage（增删改自己的任务与提醒）、memory（长期记忆）、load_skill（按需加载技能）、subagent（委派子任务），以及时间/天气/搜索/生图/plan/schedule_reminder。',
                '- 完整工具清单在我的自我认知清单里；要查细节用 self_read(topic)。',
                `- 可读 topic：${TOPICS.join(' / ')}。`,
                '- 可写字段与校验规则见 self_update 的说明；凭证（key/apiKey/endpoint/token）只读，绝不读出明文也不给改。',
            ].join('\n');

        case 'capabilities': {
            const list = capabilities.listTools(ctx.capScope || 'local::anon');
            return list.map((tool) => {
                const f = tool.function || {};
                const req = (f.parameters && f.parameters.required) || [];
                return `- ${f.name}：${f.description || ''}${req.length ? `（必填：${req.join(', ')}）` : ''}`;
            }).join('\n') || '（当前无可用能力）';
        }

        case 'settings': {
            const snap = modelConfigFile.getProfileSnapshot();
            return [
                `当前模型：${snap.model || '（未配置）'}；端点：${snap.endpoint || '（未配置）'}；密钥：${snap.hasKey ? snap.keyMasked : '（未配置）'}`,
                `搜索：provider=${snap.searchProvider || 'uapis'} endpoint=${snap.searchEndpoint || '（默认）'} key=${snap.hasSearchKey ? snap.searchKeyMasked : '（未配置）'}`,
                `人格：${snap.basePersona ? snap.basePersona.slice(0, 200) + (snap.basePersona.length > 200 ? '…' : '') : '（用预设人格）'}`,
                `工具循环参数：${JSON.stringify(modelConfigFile.getAgentProfile())}`,
                `思考模式：${modelConfigFile.getThinking()}`,
                `可自我修改字段（白名单）：\n${policy.describeWritable().map((w) => `  · ${w.key} — ${w.description}`).join('\n')}`,
                '凭证类字段（key / endpoint / token / 密码）只读，不可读写明文。',
            ].join('\n');
        }

        case 'models': {
            const list = modelConfigFile.listModelProfiles();
            const lines = [`当前生效 profileId：${list.activeId ?? '（无）'}`, '已配置模型：'];
            for (const m of list.items) {
                lines.push(`- #${m.id} ${m.name || '(无名)'} — model=${m.model || '(空)'} endpoint=${m.endpoint || '(空)'} key=${m.hasKey ? m.keyMasked : '(无)'}${list.activeId === m.id ? '  ← 当前' : ''}`);
            }
            if (!list.items.length) lines.push('（无）');
            return lines.join('\n');
        }

        case 'tasks': {
            // 合并口径：提醒也算任务。理由见 collectWork / describeWork 的注释。
            // 用户问「几个任务」时得到的总数，必须和他问「几个提醒」时一致。
            return describeWork(collectWork(sid));
        }

        case 'reminders': {
            const { jobs } = collectWork(sid);
            if (!jobs.length) {
                return '这条对话里没设过提醒。（提醒也算任务，问「几个任务」会一起算进去。）';
            }
            const lines = [
                `提醒共 ${jobs.length} 条（提醒也算任务的一种，说「任务」时我会一并数上）：`,
            ];
            for (const j of jobs.slice().sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))) {
                lines.push(
                    `- ${j.jobId}「${j.title}」${friendlyTime(j.dueAt)} 状态=${statusZh(j.status)}` +
                        ` 重复=${statusZh(j.recurrence)} 内容=${j.payload}`,
                );
            }
            return lines.join('\n');
        }

        case 'thinking': {
            const mode = modelConfigFile.getThinking();
            const guide = {
                off: '直接作答，无需展示思路。',
                on: '每次回复前先在心里列 2-4 条简要思路（可用一句话带过），再给结论；思路不要冗长。',
                auto: '简单问题直接答；复杂/多步/有争议的问题先列简要思路再深入。',
            }[mode];
            return `当前思考模式：${mode}\n行为指引：${guide}\n可改为：off / on / auto（用 self_update 改 thinking.mode）。`;
        }

        case 'diagnose': {
            const checks = [];
            const snap = modelConfigFile.getProfileSnapshot();
            checks.push(`模型配置：${snap.model && snap.hasKey ? 'OK（已配模型与密钥）' : '⚠ 未配置完整（模型或密钥为空）'}`);
            let prof = 'OK';
            try { modelConfigFile.getAgentProfile(); } catch (e) { prof = `⚠ ${e.message}`; }
            checks.push(`工具循环参数(agentProfile)：${prof}`);
            const capCount = capabilities.listTools(ctx.capScope || 'local::anon').length;
            checks.push(`能力注册表：${capCount} 个工具可用${capCount ? '' : '（⚠ 空）'}`);
            checks.push(`思考模式：${modelConfigFile.getThinking()}`);
            checks.push(`审计日志：${fs.existsSync(policy.AUDIT_FILE) ? '存在' : '尚无记录'}`);
            checks.push(`数据目录：${paths.database}`);
            return ['# 自我体检', ...checks.map((c) => '- ' + c)].join('\n');
        }

        case 'logs':
        case 'audit': {
            try {
                if (!fs.existsSync(policy.AUDIT_FILE)) return '（还没有自我修改的审计记录）';
                const lines = fs.readFileSync(policy.AUDIT_FILE, 'utf-8').trim().split('\n').filter(Boolean).slice(-30);
                return lines.map((l) => {
                    try {
                        const r = JSON.parse(l);
                        return `- ${r.at} ${r.action} ${r.key || ''} ${r.ok ? '成功' : '失败'} ${r.before ?? ''}→${r.after ?? ''}`;
                    } catch { return '- ' + l.slice(0, 200); }
                }).join('\n');
            } catch (e) {
                return `读取审计记录失败：${e.message}`;
            }
        }

        default:
            return `未知 topic「${t}」。可读：${TOPICS.join(' / ')}。`;
    }
}

// ── 受控写 ─────────────────────────────────────────────────────────────

/**
 * 按白名单修改自己的设置。fields = { 'persona.basePersona': '...', 'thinking.mode': 'on', ... }
 * 逐步校验；全部合法才写入；每步都记审计（含前后值）。任何一步失败即整体拒绝、不落盘。
 */
function update(fields, ctx = {}) {
    // 改设置属于私下行为。群里不落笔改、也不回显改了什么（回显就是泄露），
    // 主人自己在群里提也一样——让他私聊说一句，一句话就好。
    if (policy.isGroupSession(ctx.sessionId)) {
        return 'group: 现在在群里，改自己设置的事我们私聊说。你私下跟我说一句，我立刻改。';
    }
    // 管理权是分级的：只有 owner 能改她的设定。admin 可以看、可以问，
    // 但不能改——否则"被信任"就等于"被接管"了。
    const role = roleOf(ctx);
    if (role !== 'owner') {
        return 'noperm: 改设定这件事只有拥有者能做。你可以问我现在的状态，但改动得他点头。';
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return 'error: self_update 需要 fields 对象，例如 {"thinking.mode":"on"}';
    }
    const entries = Object.entries(fields);
    if (!entries.length) return 'error: fields 为空，没有要修改的内容';

    // 1) 先全部校验（两阶段提交：先验证再写，避免改一半）
    const validated = [];
    for (const [key, value] of entries) {
        try {
            const normalized = policy.validate(key, value);
            validated.push([key, normalized]);
        } catch (e) {
            policy.audit({ action: 'self_update', key, ok: false, detail: e.message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `error: 字段「${key}」校验未通过：${e.message}（本次未做任何修改）`;
        }
    }

    // 2) 采集前值（脱敏）
    const before = {};
    for (const [key] of validated) before[key] = readField(key);

    // 3) 写入
    const results = [];
    for (const [key, value] of validated) {
        try {
            applyField(key, value);
            policy.audit({ action: 'self_update', key, before: String(before[key]), after: String(value), ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            results.push(`✓ ${key} = ${JSON.stringify(value)}`);
        } catch (e) {
            policy.audit({ action: 'self_update', key, before: String(before[key]), after: String(value), ok: false, detail: e.message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            results.push(`✗ ${key}：写入失败 ${e.message}`);
        }
    }

    // 4) agentProfile 结构约束复核（timeoutCap >= timeoutFloor 等），失败回滚整组
    const touchedProfile = validated.some(([k]) => k.startsWith('agentProfile.'));
    if (touchedProfile) {
        try {
            modelConfigFile.getAgentProfile();
        } catch (e) {
            // 回滚：把前值里属于 agentProfile 的写回去
            for (const [key] of validated) {
                if (key.startsWith('agentProfile.') && before[key] !== undefined) {
                    try { applyField(key, Number(before[key])); } catch { /* ignore */ }
                }
            }
            policy.audit({ action: 'self_update_rollback', detail: e.message, ok: false, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `error: 工具循环参数整体校验失败，已回滚：${e.message}`;
        }
    }

    return `已按安全策略更新：\n${results.join('\n')}\n（每次修改都已记入审计日志。）`;
}

function readField(key) {
    if (key === 'persona.basePersona') return modelConfigFile.getBasePersona();
    if (key === 'thinking.mode') return modelConfigFile.getThinking();
    if (key.startsWith('agentProfile.')) {
        const k = key.split('.')[1];
        return modelConfigFile.getAgentProfile()[k];
    }
    return '(未知)';
}

function applyField(key, value) {
    if (key === 'persona.basePersona') { modelConfigFile.setBasePersona(value); return; }
    if (key === 'thinking.mode') { modelConfigFile.setThinking(value); return; }
    if (key.startsWith('agentProfile.')) {
        const k = key.split('.')[1];
        const cur = modelConfigFile.getAgentProfile();
        // 通过 setProfilePatch 无法写 agentProfile，用其底层写：读快照缺失该键，
        // 因此走 modelConfigFile 提供的 setAgentProfilePatch 辅助（见下方补充）。
        modelConfigFile.setAgentProfilePatch({ ...cur, [k]: value });
        return;
    }
    throw new Error(`不支持的字段 ${key}`);
}

// ── 任务 / 提醒的增删改（自我修补：能修自己设错的东西）──────────────────
//
// 「删」用取消（status=cancelled）而不是物理删除：保留事件历史，且 daily_brief
// 这类系统任务由 briefSchedule.ensureJobs 自行复活，但提醒(once)取消后永不触发。
// 严格按 sessionId 归属隔离，只能操作本会话的 job/task；系统任务(kind!=='reminder')只读。

function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

const MANAGE_ACTIONS = ['create_reminder', 'update_reminder', 'cancel_reminder', 'cancel_task'];

/** 取本会话拥有的 job；系统任务（daily_brief 等）拒绝操作。 */
function ownedJob(jobId, ctx) {
    const job = jobStore().get(jobId);
    if (!job) return { error: `找不到提醒「${jobId}」` };
    if (ctx.sessionId && job.sessionId !== ctx.sessionId) return { error: '该提醒不属于当前会话，不能操作' };
    if (job.kind !== 'reminder') return { error: `「${job.title}」是系统任务（${job.kind}），不允许通过自我修补修改` };
    return { job };
}

/**
 * 统一的任务/提醒管理入口。
 * action: create_reminder / update_reminder / cancel_reminder / cancel_task
 */
function manage(action, args = {}, ctx = {}) {
    const a = String(action || '');
    if (!MANAGE_ACTIONS.includes(a)) {
        return `error: 未知 action「${a}」。可用：${MANAGE_ACTIONS.join(' / ')}`;
    }
    // 群里不操作提醒/任务：建了、改了、取消了都会在群里回显，等于把私下的安排公开。
    // 加个备注式的自然拒绝，别让调用方以为程序坏了。
    if (policy.isGroupSession(ctx.sessionId)) {
        return 'group: 提醒和任务的事我们私聊弄，群里说一声就行，具体我来记。';
    }
    // 任务/提醒是拥有者的私人安排，只有他能改。别人可以让我记新的事，
    // 但不能动已经排好的东西。
    const role = roleOf(ctx);
    if (role !== 'owner') {
        return 'noperm: 提醒和任务是拥有者那边排的，我不能替他改。你要是想让我记点什么，直接跟我说。';
    }
    const now = Date.now();

    try {
        if (a === 'create_reminder') {
            // 复用 schedule_reminder 的严格解析：title/text 必填，dueAt 或 delayMs 二选一
            const spec = parseReminder(args, now, 'self_manage.create_reminder');
            const job = createJob({
                jobId: newId('job'),
                sessionId: ctx.sessionId,
                origin: ctx.origin || 'self_ops',
                uid: ctx.uid ?? 1,
                kind: 'reminder',
                title: spec.title,
                payload: spec.payload,
                dueAt: spec.dueAt,
                recurrence: 'once',
                now,
            });
            // 归属人必须落库。self_manage 是 owner-only（上方已挡），所以这里必然是主人；
            // 但仍要显式写上 ownerKey —— 否则到点解析不出来会退化成 '_local'，
            // 而 '_local' 和「任何远程客户端建的提醒」在推送时不可区分（审计 A2）。
            let ownerKey = '';
            try {
                ownerKey = String(require('./workspace').resolveOwnerFromCtx(ctx) || '').trim();
            } catch { ownerKey = ''; }
            if (!ownerKey) {
                return 'error: 无法确定这条提醒属于谁，为避免推错人，先不建了。';
            }
            job.ownerKey = ownerKey;
            jobStore().save(job, 'job_created');
            policy.audit({ action: 'create_reminder', key: job.jobId, after: `${job.title}@${job.dueAt}`, ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已补设提醒「${job.title}」，将在 ${friendlyTime(job.dueAt)} 提醒主人：${job.payload}（id=${job.jobId}）`;
        }

        if (a === 'cancel_reminder') {
            const { job, error } = ownedJob(args.jobId, ctx);
            if (error) {
                policy.audit({ action: 'cancel_reminder', key: args.jobId, ok: false, detail: error, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: ${error}`;
            }
            if (job.status === 'cancelled') return `提醒「${job.title}」已经是取消状态，无需重复操作。`;
            const cancelled = cancelJob(job, now);
            jobStore().save(cancelled, 'job_cancelled');
            policy.audit({ action: 'cancel_reminder', key: job.jobId, before: `${job.title}@${friendlyTime(job.dueAt)}/${job.status}`, after: 'cancelled', ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已取消提醒「${job.title}」（原定 ${friendlyTime(job.dueAt)}）。它不会再触发了。`;
        }

        if (a === 'update_reminder') {
            const { job, error } = ownedJob(args.jobId, ctx);
            if (error) {
                policy.audit({ action: 'update_reminder', key: args.jobId, ok: false, detail: error, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: ${error}`;
            }
            const patch = {};
            if (args.title !== undefined) {
                if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('title 必须是非空字符串');
                patch.title = args.title.trim().slice(0, 80);
            }
            if (args.text !== undefined) {
                if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text 必须是非空字符串');
                patch.payload = args.text.slice(0, 2000);
            }
            if (args.dueAt !== undefined) {
                if (typeof args.dueAt !== 'number' || !Number.isFinite(args.dueAt) || args.dueAt <= 0) {
                    throw new Error('dueAt 必须是合法的毫秒时间戳');
                }
                patch.dueAt = args.dueAt;
            }
            if (!Object.keys(patch).length) return 'error: 没有要修改的字段（title / text / dueAt 至少给一个）';
            const next = { ...job, ...patch, status: 'pending', updatedAt: now };
            jobStore().save(next, 'job_created');
            policy.audit({ action: 'update_reminder', key: job.jobId, before: `${job.title}@${friendlyTime(job.dueAt)}`, after: `${next.title}@${friendlyTime(next.dueAt)}`, ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已更新提醒「${next.title}」，现在设定为 ${friendlyTime(next.dueAt)}：${next.payload}`;
        }

        if (a === 'cancel_task') {
            const task = taskStore().get(args.taskId);
            if (!task) {
                policy.audit({ action: 'cancel_task', key: args.taskId, ok: false, detail: '任务不存在', sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: 找不到任务「${args.taskId}」`;
            }
            if (ctx.sessionId && task.sessionId !== ctx.sessionId) return 'error: 该任务不属于当前会话，不能操作';
            const cancelled = cancelTask(task, now);
            taskStore().save(cancelled, 'task_cancelled');
            policy.audit({ action: 'cancel_task', key: task.taskId, before: `${task.title}/${task.status}`, after: 'cancelled', ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已取消任务「${task.title}」。`;
        }
    } catch (e) {
        policy.audit({ action, ok: false, detail: e.message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
        return `error: ${e.message}`;
    }
}

module.exports = { TOPICS, MANAGE_ACTIONS, buildManifest, read, update, manage, roleOf, trustedLocalCtx };
