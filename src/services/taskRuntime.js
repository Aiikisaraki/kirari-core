// src/services/taskRuntime.js
// 阶段 C 任务编排胶水（core 侧）。
//
// 共享包 kirari-agent 只放 Task/ScheduledJob 的类型 + 状态机 + 严格解析；
// 本文件把它们接到 core 的 TaskStore/JobStore 与事件流上，负责：
//   1. plan / schedule_reminder 两个工具的实际执行（建任务/建提醒 + 落库 + 记事件）
//   2. 工具执行后推进 active task 的对应步骤
//   3. 新一轮 getReply 的「未完成任务」恢复注入
//   4. 模型提前收尾但任务未完成时，给出 continue 提示（runner 保持 turn 打开）
//
// 红线：写库/事件失败只 warn 不冒泡；解析用共享包严格函数，坏参数显式报错给模型回灌。

const crypto = require('crypto');
const {
  parsePlan,
  createTask,
  advanceTask,
  nextPendingStep,
  isTaskComplete,
  parseReminder,
  createJob,
} = require('kirari-agent');

const { taskStore } = require('../session/taskStore');
const { jobStore } = require('../session/jobStore');

/**
 * 单个会话里允许同时挂着的待触发提醒上限。
 *
 * 为什么要有：schedule_reminder 原来是零闸门的——任何人、任意次数都能建，
 * 到点都会推送到归属人桌面。不给上限就等于给了一个无限闹钟/骚扰通道。
 * 数值取得比较宽松（正常使用远用不到），只挡滥用。
 */
const MAX_REMINDERS_PER_SESSION = 30;

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** plan 工具 schema（并入 buildTools 暴露给模型）。 */
const PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'plan',
    description:
      '当用户的请求包含多个连续动作（例如“先查天气再提醒我带伞”“查完资料告诉我结果并记到明天”）时，先调用本工具把它拆成线性步骤逐一完成。一步一步来，每完成一步继续下一步，最后再给主人一句自然总结。单个简单请求无需调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务的一句话标题。' },
        steps: {
          type: 'array',
          description: '按顺序执行的步骤（1~20 步）。',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['tool', 'reminder', 'text'],
                description: 'tool=调用一个工具；reminder=设置定时提醒；text=只输出文字确认。',
              },
              label: { type: 'string', description: '这一步的简短描述。' },
              toolName: { type: 'string', description: 'kind=tool 时的工具名，如 get_weather / web_search / get_current_time。' },
              toolArgs: { type: 'object', description: 'kind=tool 时的工具参数对象。' },
              text: { type: 'string', description: 'kind=reminder 时的提醒内容。' },
              delayMs: { type: 'number', description: 'kind=reminder 时，多少毫秒后提醒（如明天 8 点可算相对毫秒）。' },
              dueAt: { type: 'number', description: 'kind=reminder 时，绝对毫秒时间戳（与 delayMs 二选一）。' },
            },
            required: ['kind', 'label'],
          },
        },
      },
      required: ['title', 'steps'],
    },
  },
};

/** schedule_reminder 工具 schema：模型想“设个提醒/到点叫我”时调用。 */
const REMINDER_TOOL = {
  type: 'function',
  function: {
    name: 'schedule_reminder',
    description:
      '设置一个定时提醒，到点后宠物会主动提醒主人。例如“明天早上 8 点提醒我带伞”“30 分钟后提醒我喝水”。需要给标题、提醒内容和时间（绝对时间戳 dueAt 或相对毫秒 delayMs 二选一）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '提醒的简短标题，如“带伞提醒”。' },
        text: { type: 'string', description: '到点要提醒的具体内容。' },
        delayMs: { type: 'number', description: '相对当前时间多少毫秒后提醒。' },
        dueAt: { type: 'number', description: '绝对毫秒时间戳（与 delayMs 二选一）。' },
      },
      required: ['title', 'text'],
    },
  },
};

/** 让 buildTools 一并暴露任务工具。 */
function withTaskTools(tools) {
  return [...tools, PLAN_TOOL, REMINDER_TOOL];
}

/** 判断一个工具名是否本模块负责。 */
function isTaskTool(name) {
  return name === 'plan' || name === 'schedule_reminder';
}

/**
 * 执行 plan 工具：严格解析 → 建 Task 落库（旁路 task_created 事件）→ 回灌确认文本。
 * 解析失败把错误作为工具结果回灌，让模型自行纠正，不打断 turn。
 */
function handlePlan(args, ctx) {
  try {
    const parsed = parsePlan(args);
    const now = Date.now();
    const task = createTask({
      taskId: newId('task'),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      origin: ctx.origin || 'core',
      uid: ctx.uid ?? 1,
      title: parsed.title,
      steps: parsed.steps,
      now,
    });
    taskStore.save(task, 'task_created');
    const preview = task.steps.map((s, i) => `${i + 1}. ${s.label}`).join('；');
    return `已记下任务「${task.title}」，共 ${task.steps.length} 步：${preview}。请现在开始执行第 1 步，完成后继续下一步，全部完成后再给主人一句自然总结。`;
  } catch (e) {
    return `error: 任务规划失败——${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 执行 schedule_reminder 工具：严格解析 → 建 ScheduledJob 落库（job_created 事件）
 * → 若 active task 有 pending 的 reminder 步骤则推进它 → 回灌确认文本。
 */
function handleScheduleReminder(args, ctx) {
  try {
    const now = Date.now();
    const spec = parseReminder(args, now);
    // 这条提醒是谁设的、那人是不是主人。到点时只剩这条 job，
    // 不存下来就分不清「该对谁说话」—— 以前所有人都被当成主人。
    const isOwnerPerson = String(ctx.role || '') === 'owner';
    const whoName = String(ctx.displayName || '').trim();
    const target = isOwnerPerson ? '主人' : (whoName || '你');

    // ── 2026-11-20 身份排查（B1）：提醒原来**完全没有闸门** ─────────────
    // 任何人（含群里任何人）都能建提醒，无角色、无配额；而同一件事走
    // self_manage.create_reminder 那条路却是 owner-only。两条路两套权限，
    // 模型必然用宽的那条 —— 而用户报的正是「她以为自己是主人就给我下任务」。
    //
    // 现在口径统一成「谁都能给自己设提醒，但不能给别人的桌面推东西」：
    //   · 群里不建（到点会变成对全群的定时发言，不受控）
    //   · 必须能解析出提醒归属人（ownerKey），解析不出就拒绝，
    //     绝不退化成 '_local'（退化就等于推到主人桌面上，这正是 A2 的漏洞）
    if (String(ctx.isGroup) === 'true' || ctx.isGroup === true) {
      return '群里不方便设定时提醒（到点会变成对整群的发言）。你私聊我，我帮你记着。';
    }

    // ── 归属人：解析 + 归一（2026-11-20 规范化）────────────────────────
    // 以前这里只做 resolveOwnerFromCtx，拿到什么存什么。于是主人 QQ 私聊
    // （sessionId 已并成本机会话 UUID）解析出 '_local' 就直接存成 '_local'，
    // 到点投递时与 getOwnerKey()='1980308740' 对不上 → 提醒静默消失。
    //
    // 现在这里多做一步 canonicalIdentity：把 '_local' / 本机会话 UUID 这类
    // 「其实是主人」的写法统一收敛到规范身份键。存进库的永远是规范键，
    // 下游任何比较都不会再因为写法不同而认错人。
    let ownerKey = '';
    try {
      const ownerIdentity = require('./ownerIdentity');
      const workspace = require('./workspace');
      ownerKey = ownerIdentity.canonicalIdentity(
        workspace.resolveOwnerFromCtx(ctx),
      );
    } catch {
      ownerKey = '';
    }
    if (!ownerKey) {
      return '我现在还分不清这条提醒该归谁，怕设完推错人。你私聊我再说一次？';
    }

    // 每人一份配额，避免被当成无限闹钟刷爆。
    // 注：jobStore 只提供按 sessionId 的 list；同一会话就对应同一个人，够用。
    try {
      const mine = jobStore.list(ctx.sessionId, 200) || [];
      const pendingMine = mine.filter(
        (j) => String(j.kind) === 'reminder' && String(j.status) === 'pending',
      );
      if (pendingMine.length >= MAX_REMINDERS_PER_SESSION) {
        return `你手上的提醒已经有 ${pendingMine.length} 条了（上限 ${MAX_REMINDERS_PER_SESSION}），先取消几个吧。`;
      }
    } catch {
      /* 配额查不到就不拦，别因为存储异常让正常需求失败 */
    }

    const job = createJob({
      jobId: newId('job'),
      sessionId: ctx.sessionId,
      origin: ctx.origin || 'core',
      uid: ctx.uid ?? 1,
      kind: 'reminder',
      title: spec.title,
      payload: spec.payload,
      dueAt: spec.dueAt,
      recurrence: 'once',
      now,
    });
    // 归属人必须落库：到点时只有这条 job，没有会话上下文可推。
    job.ownerKey = ownerKey;
    jobStore.save(job, 'job_created');
    advancePendingStep(ctx.sessionId, 'reminder', null, `已设置：${spec.title}`, now);
    const when = new Date(spec.dueAt).toLocaleString('zh-CN');
    // 回执里带两个「硬事实」，让转述没得编：
    //   ① 这一次**只建了一条**（用户 2026-11-20 报障：她说过一次"早上8点半提醒我
    //      起床"，模型却回"你发了两遍，我就设了一条"——用户根本没发两遍，那条
    //      消息在库里也只有一条。它是在前一轮"读取被挡回来"之后心虚，自己补了
    //      个解释把这个空填上了）。
    //   ② 到点**只响一次**（recurrence 固定 once）。
    // 把"建了几条"写进工具结果，模型再想解释"为什么只设一条"时手里有真数据。
    return (
      `已设好提醒「${spec.title}」，将在 ${when} 提醒${target}：${spec.payload}`
      + `（本次共新建 1 条，提醒 id=${job.jobId}，只响一次）`
    );
  } catch (e) {
    return `error: 设置提醒失败——${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 工具执行后推进 active task 的对应步骤。
 *   - kind='tool'：toolName 与步骤的 toolName 匹配即推进
 *   - kind='reminder'：由 handleScheduleReminder 显式推进
 *   - kind='text'：模型输出文字后由本函数在 final 前推进（见 conversationService）
 * 只推进每个任务「当前第一个 pending/running 步骤」，保持线性，不跳步。
 */
function advancePendingStep(sessionId, kind, toolName, result, now = Date.now()) {
  try {
    for (const task of taskStore.active(sessionId)) {
      const step = nextPendingStep(task);
      if (!step) continue;
      let matched = false;
      if (kind === 'reminder' && step.kind === 'reminder') matched = true;
      else if (kind === 'tool' && step.kind === 'tool' && step.toolName === toolName) matched = true;
      if (!matched) continue;
      const advanced = advanceTask(task, step.id, true, result, now);
      taskStore.save(advanced, isTaskComplete(advanced) ? 'task_completed' : 'task_updated');
      return true;
    }
  } catch (e) {
    console.warn('[tasks] 推进任务步骤失败（已忽略）:', e?.message || e);
  }
  return false;
}

/** 是否仍有未完成任务（pending/running）。 */
function hasActiveTask(sessionId) {
  try {
    return taskStore.active(sessionId).length > 0;
  } catch (e) {
    console.warn('[tasks] 查询未完成任务失败（已忽略）:', e?.message || e);
    return false;
  }
}

/**
 * 新一轮 getReply 的恢复注入：把未完成任务的当前步骤告诉模型，
 * 让「新消息进来先恢复未完成任务」成立（重启后任务在库里，自然恢复）。
 */
function resumeBlock(sessionId) {
  try {
    const active = taskStore.active(sessionId);
    if (!active.length) return '';
    const lines = active.map((t) => {
      const step = nextPendingStep(t);
      return `- 「${t.title}」：下一步「${step ? step.label : '收尾总结'}」`;
    });
    return (
      '\n\n【未完成的待办 · 请接着做】\n' +
      lines.join('\n') +
      '\n（这些是之前答应主人、还没做完的事。合适时继续推进，做完一句自然总结即可，不要机械复述步骤。）'
    );
  } catch (e) {
    console.warn('[tasks] 生成任务恢复注入失败（已忽略）:', e?.message || e);
    return '';
  }
}

/**
 * 模型提前返回纯文本但任务未完成时，注入的「继续」提示（作为 user 消息进入下一轮）。
 */
function pendingNudge(sessionId) {
  try {
    const active = taskStore.active(sessionId);
    const task = active[0];
    const step = task ? nextPendingStep(task) : null;
    const hint = step ? `下一步是「${step.label}」` : '收尾总结';
    return `[系统] 你还有答应主人的任务「${task ? task.title : '未完成'}」没做完，${hint}。请继续调用相应工具完成它，不要现在就结束回复。`;
  } catch {
    return '[系统] 你还有未完成的任务，请继续完成，不要现在结束回复。';
  }
}

module.exports = {
  PLAN_TOOL,
  REMINDER_TOOL,
  withTaskTools,
  isTaskTool,
  handlePlan,
  handleScheduleReminder,
  advancePendingStep,
  hasActiveTask,
  resumeBlock,
  pendingNudge,
};
