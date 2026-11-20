// 内置能力：schedule_reminder（阶段 D，一个能力一个文件）。
const { defineCapability } = require('kirari-agent');
const taskRuntime = require('../../services/taskRuntime');

const spec = taskRuntime.REMINDER_TOOL.function;

const capability = defineCapability({
  id: 'schedule_reminder',
  name: 'schedule_reminder',
  kind: 'tool',
  scope: 'builtin',
  description: spec.description,
  parameters: spec.parameters,
  tags: ['builtin', 'task'],
});

async function dispatch(args, ctx) {
  return await taskRuntime.handleScheduleReminder(args || {}, {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    uid: ctx.uid,
    origin: ctx.origin || 'core',
    // 身份一并带进去：提醒内容是模型生成的，它在不知道对方是谁的时候会默认
    // 写成「提醒主人」。非主人设的提醒也喊「主人」就等于让别人的话冒充主人。
    role: ctx.role,
    displayName: ctx.displayName || ctx.senderName,
    // ── 2026-11-20 报障：主人的提醒到点没送到 ────────────────────────
    // 用户问「为什么我依旧没看到我的提醒」，日志里是
    //   [sched] ⚠️ 提醒 job=... 没有送达任何地方
    // 根因就在这一行缺失：没把对话者身份交给 resolveOwnerFromCtx，
    // 它只能从 sessionId 反推。而主人 QQ 私聊的 sessionId 已被 botManager
    // 换成本机会话 UUID（这是「三个入口同一身份」的正确设计），
    // 于是 `sid.startsWith('bot-')` 不成立 → 兜底返回 '_local'。
    // 到点投递时 ownerIdentity.getOwnerKey() 是 '1980308740'，
    // '_local' !== '1980308740'，给 QQ 私聊推送那一步被跳过，
    // 桌面又没开 → 消息静默消失，job 却照样标成 fired。
    //
    // 现在把上游 scene 里已有的规范身份键显式带下来，走
    // resolveOwnerFromCtx 的第 ① 条规则（显式 senderId 优先），不再靠猜。
    counterpartId: ctx.counterpartId || (ctx.scene && ctx.scene.senderId) || undefined,
    senderId: ctx.senderId || undefined,
  });
}

module.exports = { capability, dispatch };
