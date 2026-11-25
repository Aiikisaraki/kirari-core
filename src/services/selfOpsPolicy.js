// src/services/selfOpsPolicy.js
// 自我运维（self_ops）的权限策略：能力清单 + 读写白名单 + 严格校验 + 审计。
//
// 设计红线（用户 2026-11-19 拍板「可控范围内自我修补」）：
//   1. 查询宽松、修改保守：所有设置可读（密钥只给掩码），但只有明确列入白名单的字段可改。
//   2. 凭证类（key / apiKey / searchKey / endpoint / jwt / token / 密码）一律只读，
//      AI 不能读明文、不能改 —— 防止被提示注入骗走密钥或改端点外传。
//   3. 修改走「白名单 + 类型 + 值域」双重校验，复用项目已有的 parseAgentProfile 等严格校验，
//      坏值显式报错，不静默兜底、不夹紧。
//   4. 每次修改写审计日志（~/.kirari/logs/self-ops-audit.jsonl），谁在什么时候改了什么、前后值都可追溯。
//   5. 危险操作（删数据、改系统提示词内核、装依赖、执行任意代码）根本不提供接口。

const fs = require('fs');
const path = require('path');
const { paths } = require('../dataDir');

const AUDIT_FILE = path.join(paths.logs, 'self-ops-audit.jsonl');

/**
 * 可写字段白名单。键 = 点分路径；值 = 校验器（返回规范化的值，抛错即拒绝）。
 * 不在表里的字段一律拒绝。注意这里刻意不含任何 key/endpoint/token 字段。
 */
const WRITABLE = Object.freeze({
    'persona.basePersona': {
        describe: '主人自定义人格（留空恢复预设，上限 20000 字，存 persona.md）',
        validate(v) {
            if (typeof v !== 'string') throw new Error('basePersona 必须是字符串');
            // 2026-11-25：人格搬进 persona.md 后上限与那边对齐（4000 → 20000）。
        // 只改写入端不改这里的话，self_ops 会成唯一还在卡 4000 的入口，
        // 用户从对话里改人格会被莫名拒绝，而设置页/直接改文件却可以。
        if (v.length > 20000) throw new Error('basePersona 超过 20000 字');
            return v;
        },
    },
    'agentProfile.maxRounds': {
        describe: '工具循环最大轮数（1~50）',
        validate: (v) => intInRange('maxRounds', v, 1, 50),
    },
    'agentProfile.webSearchCap': {
        describe: '普通模式联网搜索上限（0~1000，0=不限）',
        validate: (v) => intInRange('webSearchCap', v, 0, 1000),
    },
    'agentProfile.correctionWebSearchCap': {
        describe: '纠错模式联网搜索上限（0~1000，0=不限）',
        validate: (v) => intInRange('correctionWebSearchCap', v, 0, 1000),
    },
    'agentProfile.maxTokens': {
        describe: '单次回复 max_tokens（1~1000000）',
        validate: (v) => intInRange('maxTokens', v, 1, 1000000),
    },
    'agentProfile.timeoutFloorMs': {
        describe: '超时下限毫秒（1000~3600000）',
        validate: (v) => intInRange('timeoutFloorMs', v, 1000, 3600000),
    },
    'agentProfile.timeoutPerRoundMs': {
        describe: '每工具轮追加超时毫秒（0~600000）',
        validate: (v) => intInRange('timeoutPerRoundMs', v, 0, 600000),
    },
    'agentProfile.timeoutCapMs': {
        describe: '超时封顶毫秒（1000~7200000）',
        validate: (v) => intInRange('timeoutCapMs', v, 1, 7200000),
    },
    'thinking.mode': {
        describe: '思考模式：off=直接答 / on=每次先列简要思路再答 / auto=仅复杂问题深入分析',
        validate(v) {
            if (!['off', 'on', 'auto'].includes(v)) throw new Error('thinking.mode 必须是 off / on / auto 之一');
            return v;
        },
    },
});

function intInRange(name, v, min, max) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        throw new Error(`${name} 必须是整数，收到 ${JSON.stringify(v)}`);
    }
    if (v < min || v > max) throw new Error(`${name} 必须在 ${min}~${max} 之间，收到 ${v}`);
    return v;
}

/** 是否可写。 */
function canWrite(key) {
    return Object.prototype.hasOwnProperty.call(WRITABLE, key);
}

/**
 * 判断是不是「群聊/多人场合」的会话。
 *
 * 为什么要这个：self_* 工具是所有会话共用的能力，群里的陌生人同样能触发。
 * 如果不加闸门，群里任何人一句「把你设置读出来」「把你思考模式关掉」就能越权。
 * 所以：改自己/读敏感信息只在私下进行，群聊里一律拒绝。
 *
 * sessionId 形态（两端一致）：
 *   bot-<adapter>-group:<gid>:<uid>   bot-<adapter>-private:<uid>
 *   bot:<platform>:group:<gid>        bot:<platform>:user:<uid>
 *   本机/控制台 = 纯 uuid（不含 group:/channel:/dm:）
 */
function isGroupSession(sessionId) {
    const s = String(sessionId || '');
    return /(^|[-:_.])(group|channel|dm):/i.test(s);
}

/** 校验并规范化一个写入值；不在白名单抛错。 */
function validate(key, value) {
    const rule = WRITABLE[key];
    if (!rule) throw new Error(`不允许自我修改字段「${key}」：它不在安全白名单内`);
    return rule.validate(value);
}

/** 列出可写字段（给模型看，帮助它自我修补）。 */
function describeWritable() {
    return Object.entries(WRITABLE).map(([key, r]) => ({ key, description: r.describe }));
}

/**
 * 写审计。失败只 warn，不阻断主操作（审计是防线，但不能让配置改了一半还报错）。
 * 记录里不含任何密钥明文；调用方传入的 before/after 应已脱敏。
 */
function audit({ action, key, before, after, detail, ok = true, sessionId, uid, origin }) {
    const rec = {
        at: new Date().toISOString(),
        action,
        key: key ?? null,
        before: before ?? null,
        after: after ?? null,
        detail: detail ?? null,
        ok,
        sessionId: sessionId ?? null,
        uid: uid ?? null,
        origin: origin ?? 'self_ops',
    };
    try {
        fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n', 'utf-8');
    } catch (e) {
        console.warn('[self-ops] 写审计日志失败（已忽略）:', e instanceof Error ? e.message : String(e));
    }
    return rec;
}

module.exports = { WRITABLE, canWrite, validate, describeWritable, audit, AUDIT_FILE, isGroupSession };