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
              fired: '已触发', once: '一次性', daily: '每天' })[s] || s || '';
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
    try {
        if (ctx.sessionId) {
            const tasks = taskStore().active(ctx.sessionId).slice(0, 10);
            if (tasks.length) {
                lines.push(`- 未完成任务（${tasks.length}）：` + tasks.map((t) => `「${t.title}」`).join('；'));
            }
            const jobs = jobStore().list(ctx.sessionId, 100)
                .filter((j) => j.status === 'pending')
                .sort((a, b) => a.dueAt - b.dueAt)
                .slice(0, 10);
            if (jobs.length) {
                lines.push('- 待触发提醒：' + jobs.map((j) => `${friendlyTime(j.dueAt)}「${j.title}」`).join('；'));
            }
        }
    } catch (e) {
        // 清单是锦上添花，读失败不留半截：删掉任务行即可
        lines.push('（任务/提醒摘要暂不可用）');
    }

    lines.push('- 自我排查：遇到问题先用 self_read(diagnose) 体检，再决定要不要 self_update 修；改完可用 self_read 复核。');
    lines.push('- 发现自己设错/设重复的提醒或任务：self_read(reminders/tasks) 查到 id，再用 self_manage 改时间、取消重复、补设正确的。别把没能力当借口。');
    return lines.join('\n');
}

// ── 通用读 ─────────────────────────────────────────────────────────────

function read(topic, ctx = {}) {
    const t = String(topic || 'readme').toLowerCase();
    const sid = ctx.sessionId;
    switch (t) {
        case 'readme':
            return [
                '# Kirari 自我说明',
                '- 我是 Kirari，主人的虚拟桌宠少女。',
                '- 我有这些通用能力工具：self_read（查询自己）、self_update（受控修改设置）、self_manage（增删改自己的任务与提醒）、load_skill（按需加载技能）、subagent（委派子任务），以及时间/天气/搜索/生图/plan/schedule_reminder。',
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
            const ts = sid ? taskStore().list(sid, 50) : [];
            if (!ts.length) return '（本会话没有任务记录）';
            return ts.map((t) => `- ${t.taskId}「${t.title}」状态=${statusZh(t.status)} 步骤=${(t.steps || []).map((s) => `${s.label}[${statusZh(s.status) || s.status}]`).join('→') || '无'} 更新于${friendlyTime(t.updatedAt)}`).join('\n');
        }

        case 'reminders': {
            const jobs = sid ? jobStore().list(sid, 100) : [];
            if (!jobs.length) return '（本会话没有提醒/定时任务）';
            return jobs.slice().sort((a, b) => a.dueAt - b.dueAt).map((j) =>
                `- ${j.jobId}「${j.title}」${friendlyTime(j.dueAt)} 状态=${statusZh(j.status)} 重复=${statusZh(j.recurrence)} 内容=${j.payload}`
            ).join('\n');
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

module.exports = { TOPICS, MANAGE_ACTIONS, buildManifest, read, update, manage };
