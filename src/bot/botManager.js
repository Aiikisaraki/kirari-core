// src/bot/botManager.js
// 机器人适配器管理（核心版）：读 pet-client.config.json 的 adapters[] → 起
// OneBot 连接 → 把入站消息喂给内核 getReply → 回发。
//
// 从桌宠版 electron/adapter/adapter-manager.ts 移植为纯 Node 版（用户拍板：
// 机器人搬进核心版）。差异点：
//   - 配置存 pet-client.config.json 的 adapters[]，与桌宠版**同一份文件、同一个键**
//     （桌宠版从不存在 adapter.json，核心版早期那份已由 migrateLegacyAdapterFile 迁走）
//   - session_id：客人用 bot-<适配器>-<对话键>（桌宠版那套「群号:用户ID」规则不变，
//     且 bot- 前缀被 localSession 的 FOREIGN_SESSION_PREFIXES 排除，不并进主对话）；
//     被设为「主人」的账号直接用本机会话 id —— 与桌宠/控制台共用同一段主对话
//   - 知识库检索 / 人格 / 技能提示词都在核心版本地取，不再依赖 WS 回传
const clientConfig = require('../settings/clientConfig');
const { OneBotAdapter } = require('./onebotAdapter');
const aiReplyService = require('../services/aiReplyService');
const modelConfigFile = require('../services/modelConfigFile');
const userKnowledge = require('../knowledge/userKnowledge');
const { getBasePersona } = require('../services/modelConfigFile');
const mcpManager = require('../mcp/mcpManager');
const contextPool = require('../ai/contextPool');
const sessionManager = require('../session/sessionManager');
const localSession = require('../session/localSession');

/** 内置账号 uid：机器人消息与桌宠/控制台共用同一份模型配置（BOT_MODEL_UID，默认 1）。 */
function botUid() {
    const v = Number(process.env.BOT_MODEL_UID);
    return Number.isSafeInteger(v) && v > 0 ? v : 1;
}

function readAdapters() {
    return clientConfig.getAdapters();
}

function writeAdapters(adapters) {
    return clientConfig.setAdapters(adapters);
}

/** @type {Map<string, OneBotAdapter>} */
const running = new Map();

/**
 * 运行时见过的协议端账号（按适配器收集 Set）—— 控制台「设主人」下拉用。
 * 与桌宠版 adapter-manager.ts 的 knownAccounts 同语义：只存内存，重启后重新收集。
 * @type {Map<string, Set<string>>}
 */
const knownAccounts = new Map();

/** 收集启用中的技能提示词（与桌宠版 collectSkillPrompts 同格式）。 */
function collectSkillPrompts() {
    const skills = mcpManager.readSkills();
    const prompts = [];
    for (const s of skills) {
        if (s.enabled === false) continue;
        if (s.prompt && String(s.prompt).trim()) {
            prompts.push(`【技能：${s.name}】\n${String(s.prompt).trim()}`);
        }
    }
    return prompts;
}

/**
 * 记录运行时见过的账号（供控制台挑主人用）；返回是否首次出现。
 * 与桌宠版 handleIncoming 里的 knownAccounts 收集同语义。
 */
function noteAccount(adapterId, senderId) {
    if (!senderId) return false;
    let set = knownAccounts.get(adapterId);
    if (!set) {
        set = new Set();
        knownAccounts.set(adapterId, set);
    }
    const isNew = !set.has(senderId);
    set.add(senderId);
    return isNew;
}

async function handleIncoming(cfg, incoming, ownerAccount) {
    const uid = botUid();
    // 主人账号 → 并入「本机会话」（local-session.json 那份，桌宠版/控制台共用同一段主对话）；
    // 客人 → 独立 bot- 会话（前缀被 localSession 排除，永不并进主对话）。
    // 与桌宠版 adapter-manager.ts 的 isOwner 路由同语义，配置键同名（ownerAccount）。
    // ownerAccount 由适配器实例实时提供（setOwner 同步），不用启动时的 cfg 快照。
    const owner = String(ownerAccount || '');
    const isOwner = !!owner && incoming.senderId === owner;
    const sessionId = isOwner
        ? await localSession.ensureLocalSessionId()
        : `bot-${incoming.adapterId}-${incoming.conversationKey}`;
    console.log(
        `[bot] 入站 ${incoming.adapterId} ${incoming.conversationKey}${isOwner ? '（主人，并入主对话）' : ''}: "${incoming.text.slice(0, 40)}"`,
    );

    // 私人知识库：先本地检索，把片段随请求带上（与桌宠版 chat-session-service 同做法）
    let kbContext = null;
    try {
        const hits = await userKnowledge.search(incoming.text, 5);
        if (hits.length) kbContext = hits;
    } catch {
        /* 检索失败不该挡住回复 */
    }

    try {
        const aiContext = await contextPool.getContext(uid);
        await sessionManager.initSession(sessionId);
        // 图片/情绪进 extras 列（桌宠版引擎同样存）：共享历史里桌宠端原样带回
        await sessionManager.saveMessage(sessionId, 'user', incoming.text, {
            images: Array.isArray(incoming.images) ? incoming.images : [],
        });
        const reply = await aiReplyService.getReply({
            aiContext,
            content: incoming.text,
            images: incoming.images || [],
            sessionId,
            persona: getBasePersona() || null,
            skillPrompts: collectSkillPrompts(),
            kbContext,
            ws: null,
        });
        await sessionManager.saveMessage(sessionId, 'assistant', reply.speech, {
            images: Array.isArray(reply.images) ? reply.images : [],
            emotion: reply.emotion || null,
        });
        return reply;
    } catch (e) {
        console.error('[bot] 生成回复失败:', e?.message || e);
        return { speech: '（我这边出了点问题，稍后再试～）', emotion: null, images: [] };
    }
}

/** 起一个适配器（内部）：连接 + 绑定消息处理 + 回发。 */
function startAdapter(cfg) {
    if (running.has(cfg.id)) return running.get(cfg.id);
    const adapter = new OneBotAdapter(cfg, async (incoming) => {
        noteAccount(cfg.id, incoming.senderId);
        // ownerAccount 从实例实时读（设主人后即时生效，不等重启）
        const reply = await handleIncoming(cfg, incoming, adapter.ownerAccount);
        try {
            await adapter.sendMessage(incoming, {
                text: reply.speech || '',
                images: Array.isArray(reply.images) ? reply.images : [],
            });
        } catch (e) {
            console.warn(`[bot] 回发失败（${incoming.conversationKey}）:`, e?.message || e);
        }
    });
    adapter.setOwner(cfg.ownerAccount || null);
    adapter.connect();
    running.set(cfg.id, adapter);
    return adapter;
}

/** 按当前配置整表重建（保存设置时调用）。 */
function applyConfig() {
    const configs = readAdapters().filter((a) => a.enabled !== false && a.type === 'onebot');
    // 停掉不在新配置里的
    for (const [id, ad] of running) {
        if (!configs.some((c) => c.id === id)) {
            ad.dispose();
            running.delete(id);
            knownAccounts.delete(id);
        }
    }
    for (const cfg of configs) {
        const existing = running.get(cfg.id);
        if (existing) {
            // 运行中改配置（WS 地址/令牌/群设置）→ 断开重连，与桌宠版 update() 同语义；
            // 主人变更也在这里同步到实例（setOwner 只改路由，不重连）
            existing.updateConfig(cfg.config || {});
            existing.setOwner(cfg.ownerAccount || null);
        } else {
            startAdapter(cfg);
        }
    }
    return running.size;
}

/**
 * 设置某账号为主人：之后该账号的消息并入「本机会话」（与桌宠/控制台共用同一段主对话）。
 * accountKey 为空表示取消主人。写盘 + 实时同步到运行中的实例（与桌宠版 setOwner 同语义：
 * 改的是路由决策，不重连适配器）。
 */
function setOwner(adapterId, accountKey) {
    const adapters = readAdapters();
    const c = adapters.find((a) => a.id === adapterId);
    if (!c) throw new Error('适配器不存在');
    c.ownerAccount = String(accountKey || '').trim() || null;
    writeAdapters(adapters);
    const inst = running.get(adapterId);
    if (inst) inst.setOwner(c.ownerAccount);
    console.log(`[bot] 适配器 ${adapterId} 主人已${c.ownerAccount ? `设为 ${c.ownerAccount}` : '取消'}`);
    return c.ownerAccount;
}

/** 服务启动时调用一次（顺带把核心版早期的 adapter.json 迁进桌宠版那份配置）。 */
function initBots() {
    try {
        clientConfig.migrateLegacyAdapterFile();
    } catch (e) {
        console.warn('[bot] 适配器配置迁移失败（不影响服务）:', e?.message || e);
    }
    try {
        const n = applyConfig();
        if (n > 0) console.log(`[bot] 已启动 ${n} 个机器人适配器`);
    } catch (e) {
        console.warn('[bot] 启动适配器失败（不影响服务）:', e?.message || e);
    }
}

function listStatus() {
    const configs = readAdapters();
    return configs.map((c) => {
        const ad = running.get(c.id);
        return {
            id: c.id,
            name: c.name,
            type: c.type,
            enabled: c.enabled !== false,
            connected: ad ? ad.connected : false,
            lastError: ad ? ad.lastError : '',
            selfQQ: ad ? ad.selfQQ : '',
            // 主人绑定状态 + 运行时见过的账号（控制台挑主人用），与桌宠版 list() 同形状
            ownerAccount: c.ownerAccount || null,
            knownAccounts: [...(knownAccounts.get(c.id) || [])],
            config: c.config || {},
        };
    });
}

function stopAll() {
    for (const [, ad] of running) ad.dispose();
    running.clear();
}

module.exports = {
    readAdapters,
    writeAdapters,
    applyConfig,
    initBots,
    listStatus,
    stopAll,
    setOwner,
    botUid,
    collectSkillPrompts,
    adapterFilePath: () => clientConfig.clientConfigPath(),
};
