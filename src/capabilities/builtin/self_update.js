// 内置能力：self_update —— Kirari 的受控自我修补接口。
// 白名单 + 值域校验 + 全量审计 + 两阶段提交（先全校验再写）。凭证类字段根本不在白名单里。
// 用户 2026-11-19 拍板「更接近 lead 的完整权限」，但仍要求「在可控权限范围内」。
const { defineCapability } = require('kirari-agent');
const selfOps = require('../../services/selfOps');
const policy = require('../../services/selfOpsPolicy');

const writableList = policy.describeWritable().map((w) => `${w.key}（${w.description}）`).join('；');

const capability = defineCapability({
    id: 'self_update',
    name: 'self_update',
    kind: 'tool',
    scope: 'builtin',
    description:
        '在安全白名单内修改 Kirari 自己的设置，实现自我修补。只能改：' + writableList +
        '。凭证类（key/endpoint/token/密码）一律不可改。每次修改都会写审计日志，可先用 self_read(audit) 查看。不确定当前值时先 self_read(settings)。fields 是一个「字段路径→新值」对象。',
    parameters: {
        type: 'object',
        properties: {
            fields: {
                type: 'object',
                description: '要修改的字段对象，例如 {"thinking.mode":"on"} 或 {"persona.basePersona":"...","agentProfile.maxRounds":8}。键必须是白名单内的路径。',
                additionalProperties: true,
            },
            reason: {
                type: 'string',
                description: '为什么要改（写入审计，便于主人事后查看）。',
            },
        },
        required: ['fields'],
    },
    tags: ['builtin', 'introspection', 'mutating'],
    timeoutMs: 10000,
    truncateChars: 4000,
});

async function dispatch(args, ctx = {}) {
    if (args && typeof args.reason === 'string' && args.reason.trim()) {
        policy.audit({ action: 'self_update_reason', detail: args.reason.trim(), sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
    }
    return selfOps.update(args && args.fields, {
        sessionId: ctx.sessionId,
        uid: ctx.uid,
        origin: ctx.origin,
    });
}

module.exports = { capability, dispatch };
