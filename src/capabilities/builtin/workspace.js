// src/capabilities/builtin/workspace.js
// 内置能力：workspace —— 她自己的工作空间文件夹。
//
// 用户 2026-11-19 原话：
//   「我想给他加入工作空间的概念……这样它可以执行一些定期的自动化任务，
//     并且保留一定量的数据。这个空间文件夹是一个独立的文件夹，放在用户目录下，
//     下面再分为不同的任务所属的文件夹」
//
// 为什么要有这个能力：
//   以前她的产出只存在于对话里，聊完就散了。定期任务跑完无处落盘，第二天也没有
//   「昨天那份」可读。工作空间把「任务」和「产物」接起来：一个任务一个文件夹，
//   写进去的东西下次还能读回来，用户也能直接翻。
//
// 目录形态见 services/workspace.js 头部注释。
//
// ── 按人隔离（2026-11-20 用户原话）──────────────────────────────
//   「我今天把机器人转发给了我一个朋友，她是私聊我的机器人，建立了几个每日任务，
//     但是我怎么可以直接看到她的任务呢，就算是主人权限，也是优先说我有几个，
//     然后再说可能还有别人的，我确认了才能看别人的啊！！」
//
// 所以这个能力里 owner **不是模型能传的参数**：它只从 ctx（此刻在跟谁说话）解析。
// 模型无法通过编造 owner 去读别人的目录 —— 参数里根本没有这个入口。
//
// 主人要看别人的，必须两步：
//   ① 调 action=others（不带 confirm）→ 只回「还有 N 个人的任务，要不要看」
//   ② 用户明确说要 → 再调 action=others + confirm=true → 才真的列出
// 第 ② 步的 confirm 是模型照着用户的话填的，不是它自己决定的。
//
// ── 叶子节点（从机）────────────────────────────────────────────────
// 从机上这个能力的**文件操作直接在本机执行**，因为工作空间是本机用户的目录；
// 但「定期任务的模型执行」照旧转发给主机（见 services/workspaceTask.js）。
// 两者不矛盾：模型算力在主机，产物落在任务所属的那台机器的空间里。
//
// ── 枚举内联 ──────────────────────────────────────────────────────
// registry 是 eager glob 加载，顶层 require 别的服务可能还没初始化（桌宠版踩过坑），
// 所以 action 枚举写死在这里，服务实例在 dispatch 里惰性 require。
const { defineCapability } = require('kirari-agent');

const ACTION_ENUM = [
    'overview',
    'tasks',
    'ls',
    'read',
    'write',
    'append',
    'mkdir',
    'rm',
    'rm_task',
    'prune',
    'others',
];

// 这些名字是任务文件夹里的保留文件，她不该随手删掉（会让元信息丢）
const RESERVED_FILES = ['meta.json'];

/** 本机/控制台这类没有对话者的会话，工作空间归属到这个名下。 */
const LOCAL_OWNER = '_local';

const capability = defineCapability({
    id: 'workspace',
    name: 'workspace',
    kind: 'tool',
    scope: 'builtin',
    description:
        '你的工作空间：一个真实的文件夹（在用户目录下的 KirariWorkspace），每个定期任务一个子文件夹，用来保存产出、跨天积累数据。'
        + '⚠️ 工作空间按人分开：你只能看到并操作**此刻正在跟你说话的那个人**的任务，看不到别人的。'
        + 'action：'
        + 'overview（空间总览：在哪、几个任务、占多少）、'
        + 'tasks（列出当前这个人的任务文件夹及其最近运行）、'
        + 'ls（看某个任务文件夹里有什么，需 taskId，可给 path 看子目录）、'
        + 'read（读一个文件，需 taskId + path）、'
        + 'write（写文件，需 taskId + path + content，父目录自动建）、'
        + 'append（往文件末尾追加，适合按天累积的日志，需 taskId + path + content）、'
        + 'mkdir（建目录）、'
        + 'rm（删文件或子目录）、'
        + 'rm_task（删整个任务文件夹，需 taskId）、'
        + 'prune（按保留策略清理旧文件，需 taskId）、'
        + 'others（只看别人有没有任务。不带 confirm 时只回答「有几个人的、要不要看」；'
        + '必须等用户明确说要之后，才能带 confirm=true 再调一次去看内容）。'
        + 'path 一律是相对任务文件夹的路径，不能越出工作空间。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ACTION_ENUM,
                description: '要执行的操作。',
            },
            taskId: {
                type: 'string',
                description: '任务文件夹名（任务的 id）。overview / tasks / others 不需要。',
            },
            path: {
                type: 'string',
                description: '任务文件夹内的相对路径，如 "2026-11-19.md" 或 "data/notes.txt"。不给则指任务文件夹本身。',
            },
            content: {
                type: 'string',
                description: 'write / append 要写入的内容。',
            },
            title: {
                type: 'string',
                description: '建任务文件夹时的人类可读标题（存进 meta.json，文件夹名仍用 taskId）。',
            },
            confirm: {
                type: 'boolean',
                description:
                    '只有 action=others 用。仅当用户已经明确表示「要看别人的任务」之后，才设为 true；'
                    + '用户没说就不要带这个参数。',
            },
        },
        required: ['action'],
    },
    tags: ['builtin', 'workspace', 'files'],
});

/** 把服务层的同步异常转成模型能读懂的 error 文本（不打断 turn）。 */
function fail(e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * 解析「这个工作空间属于谁」。
 *
 * 只认 ctx，绝不看模型传的参数 —— 这是隔离的根，参数化就等于把钥匙给了模型。
 * 具体规则收敛在 services/workspace.resolveOwnerFromCtx 里，这里只是转发；
 * 建任务、提示词注入块都用同一份，避免三处判断漂移。
 */
function resolveOwner(ctx = {}) {
    const ws = require('../../services/workspace');
    return ws.resolveOwnerFromCtx(ctx);
}

/** 摘要一行：给 tasks / others 共用。 */
function taskLine(t) {
    return (
        `- ${t.taskId}「${t.title}」：${t.files} 个文件 / ${(t.bytes / 1024).toFixed(1)}KB，` +
        `运行 ${t.runCount || 0} 次${t.lastRunAt ? `，最近 ${t.lastRunAt}` : ''}`
    );
}

async function dispatch(args, ctx = {}) {
    // 惰性 require：见文件头「枚举内联」的说明
    const ws = require('../../services/workspace');
    const a = args || {};
    const action = String(a.action || '').trim().toLowerCase();
    if (!ACTION_ENUM.includes(action)) {
        return `error: 未知 action「${a.action}」，可用：${ACTION_ENUM.join(' / ')}`;
    }

    let owner;
    try {
        owner = resolveOwner(ctx);
    } catch (e) {
        return fail(e);
    }

    // ── others：看别人的任务，必须两步 ──
    if (action === 'others') {
        try {
            // 统一走 selfOps.roleOf —— 全仓只留一个角色判定入口。
            // 原来这里直接读 ctx.role，而 self_read/self_manage 走 roleOf 兜底，
            // 造成「安全侧误伤主人（others 拒绝）、危险侧放行外人（settings 可读）」
            // 的判据分裂。身份判定必须只有一个真相源。
            const selfOps = require('../../services/selfOps');
            const isOwner = selfOps.roleOf(ctx) === 'owner';
            if (!isOwner) {
                // 连「有两三个别人」都不该泄露给普通用户 —— 那本身就是别人的信息。
                return '你的工作空间里只有你自己的任务，没有别的可看。';
            }
            // 2026-11-20 规范化：过滤「别人」也是身份比较，两侧先归一。
            // 否则同一主人可能以 '_local' / UUID 等形式在工作空间里占了两个
            // 目录，主人会在「别人」列表里看到自己。
            const ownerIdentity = require('../../services/ownerIdentity');
            const others = ws.listOwners()
                .filter((o) => !ownerIdentity.samePerson(o.owner, owner));
            if (!others.length) return '除了你自己，没有别人在这里建过任务。';

            const brief = others
                .map((o) => `- ${o.owner}：${o.tasks} 个任务`)
                .join('\n');

            if (a.confirm !== true) {
                // 第一次只报「有几个人的」，不给内容。等用户点头再调一次带 confirm。
                return (
                    `你自己有 ${ws.listTasks(owner).length} 个任务。`
                    + `\n另外还有 ${others.length} 个用户的 ${others.reduce((n, o) => n + o.tasks, 0)} 个任务：\n${brief}`
                    + '\n\n要看他们的具体内容吗？你说要，我再看。'
                );
            }

            // 第二次（用户已确认）：真的列出来
            const blocks = others.map((o) => {
                const lines = ws.listTasks(o.owner).map(taskLine);
                return `【${o.owner}】${o.tasks} 个任务：\n${lines.join('\n')}`;
            });
            return `你自己有 ${ws.listTasks(owner).length} 个任务。\n\n${blocks.join('\n\n')}`;
        } catch (e) {
            return fail(e);
        }
    }

    // 空间概览：不需要 taskId
    if (action === 'overview') {
        try {
            const o = ws.overview(owner);
            const lines = [
                `工作空间位置：${o.root}`,
                `已存在：${o.exists ? '是' : '否（首次写入时会自动创建）'}`,
                `任务文件夹：${o.tasks} 个，共 ${o.files} 个文件、${(o.bytes / 1024).toFixed(1)}KB`,
            ];
            if (o.list.length) {
                lines.push('', '任务列表：');
                for (const t of o.list.slice(0, 20)) lines.push(taskLine(t));
                if (o.list.length > 20) lines.push(`（还有 ${o.list.length - 20} 个未列出，用 tasks 看全部）`);
            }
            return lines.join('\n');
        } catch (e) {
            return fail(e);
        }
    }

    if (action === 'tasks') {
        try {
            const list = ws.listTasks(owner);
            if (!list.length) return '你的工作空间里还没有任务文件夹。';
            return list.map(taskLine).join('\n');
        } catch (e) {
            return fail(e);
        }
    }

    // 其余操作都要 taskId
    const taskId = String(a.taskId || '').trim();
    if (!taskId) return 'error: 这个操作需要 taskId（任务文件夹名）。先用 tasks 看看有哪些。';
    const relPath = a.path == null ? '' : String(a.path);

    try {
        switch (action) {
            case 'ls': {
                const entries = ws.listFiles(owner, taskId, relPath);
                const where = relPath || `${taskId} 根目录`;
                if (!entries.length) return `${where}：空`;
                const lines = entries.map(
                    (e) => `${e.dir ? '[目录]' : '[文件]'} ${e.name}${e.dir ? '' : `  ${(e.size / 1024).toFixed(1)}KB`}`,
                );
                return `${where}（${entries.length} 项）：\n${lines.join('\n')}`;
            }

            case 'read': {
                if (!relPath) return 'error: read 需要 path（要读哪个文件）。';
                const text = ws.readFile(owner, taskId, relPath);
                return `=== ${taskId}/${relPath} ===\n${text}`;
            }

            case 'write': {
                if (!relPath) return 'error: write 需要 path（写到哪个文件）。';
                const bytes = ws.writeFile(owner, taskId, relPath, a.content ?? '');
                // 写文件视为「这个任务今天动过」，顺便把 meta 建起来
                ws.ensureTask(owner, taskId, { title: a.title });
                return `已写入 ${taskId}/${relPath}（${bytes} 字节）。`;
            }

            case 'append': {
                if (!relPath) return 'error: append 需要 path。';
                // 用读+写实现而不是 fs.appendFileSync：这样上限检查、路径校验、
                // 父目录创建全部复用同一套逻辑，不会出现「append 绕过大小限制」。
                let old = '';
                try {
                    old = ws.readFile(owner, taskId, relPath);
                } catch {
                    old = ''; // 文件不存在就当新建
                }
                const next = old ? `${old.replace(/\s*$/, '')}\n\n${a.content ?? ''}` : String(a.content ?? '');
                const bytes = ws.writeFile(owner, taskId, relPath, next);
                ws.ensureTask(owner, taskId, { title: a.title });
                return `已追加到 ${taskId}/${relPath}（现在 ${bytes} 字节）。`;
            }

            case 'mkdir': {
                if (!relPath) return 'error: mkdir 需要 path。';
                const made = ws.mkdir(owner, taskId, relPath);
                ws.ensureTask(owner, taskId, { title: a.title });
                return `已建目录 ${taskId}/${made}。`;
            }

            case 'rm': {
                if (!relPath) return 'error: 删文件要给 path；要删整个任务文件夹请用 rm_task。';
                if (RESERVED_FILES.includes(relPath.split(/[\\/]/).pop())) {
                    return `error: ${relPath} 是任务元信息，不能删（要删整个任务用 rm_task）。`;
                }
                const r = ws.remove(owner, taskId, relPath);
                return r.removed ? `已删除 ${taskId}/${relPath}。` : `${taskId}/${relPath} 本来就不存在。`;
            }

            case 'rm_task': {
                const r = ws.removeTask(owner, taskId);
                return r.removed ? `已删除任务文件夹 ${taskId}（连同里面的所有产出）。` : `任务文件夹 ${taskId} 不存在。`;
            }

            case 'prune': {
                const meta = ws.readTaskMeta(owner, taskId) || {};
                const policy = meta.retention || ws.DEFAULT_RETENTION;
                const r = ws.pruneTask(owner, taskId);
                return `已按保留策略清理 ${taskId}：删掉 ${r.deleted} 个文件，释放 ${(r.freedBytes / 1024).toFixed(1)}KB。`
                    + `（策略：保留 ${policy.keepFiles} 个 / ${policy.keepDays} 天 / ${(policy.keepBytes / 1024 / 1024).toFixed(0)}MB）`;
            }

            default:
                return `error: 未实现的 action「${action}」`;
        }
    } catch (e) {
        return fail(e);
    }
}

module.exports = {
    capability,
    dispatch,
    ACTION_ENUM,
    RESERVED_FILES,
    LOCAL_OWNER,
    resolveOwner,
};
