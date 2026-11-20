// 内置能力：self_read —— Kirari 的通用自我查询接口。
// 一个接口覆盖「我是谁 / 我有什么能力 / 我的设置 / 任务 / 提醒 / 自检 / 审计」，
// 而不是给每个领域开一个专用工具。像 lead 直接读文件那样，先读再判断，不凭空猜。
const { defineCapability } = require('kirari-agent');
const selfOps = require('../../services/selfOps');

const capability = defineCapability({
    id: 'self_read',
    name: 'self_read',
    kind: 'tool',
    scope: 'builtin',
    description:
        '查询 Kirari 自己的信息。想知道自己的设置、可用能力、当前模型、工具循环参数、任务与提醒、思考模式，或做一次自我体检时调用。topic 取值：readme/capabilities/settings/models/tasks/reminders/thinking/diagnose/logs/audit。' +
        '注意：tasks 是**合并口径**——多步任务和定时提醒都算任务，一起计数；reminders 只看提醒。' +
        '别人问「有几个任务」「还有什么事没做」时**必须**调 self_read(tasks) 拿准确数字，不要凭印象回答。' +
        '遇到「你有什么功能」「你记得我要做什么吗」「检查一下你自己」这类问题优先用它，别凭空回答。',
    parameters: {
        type: 'object',
        properties: {
            topic: {
                type: 'string',
                enum: selfOps.TOPICS,
                description:
                    '要查询的方面。不确定的话先 readme；自我排查用 diagnose。' +
                    '问「有几个任务/有什么事要做」用 tasks（含提醒）；只问提醒用 reminders。',
            },
        },
        required: ['topic'],
    },
    tags: ['builtin', 'introspection'],
    timeoutMs: 10000,
    truncateChars: 12000,
});

async function dispatch(args, ctx = {}) {
    return selfOps.read(args && args.topic, {
        sessionId: ctx.sessionId,
        uid: ctx.uid,
        capScope: ctx.capScope,
        origin: ctx.origin,
        // 角色决定能读哪些主题（owner/admin/user 阶梯），isOwner 仅为兼容旧调用
        role: ctx.role,
        isOwner: ctx.isOwner,
    });
}

module.exports = { capability, dispatch };
