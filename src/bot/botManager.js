// src/bot/botManager.js
// 机器人适配器管理（核心版）：读 pet-client.config.json 的 adapters[] → 起
// OneBot 连接 → 把入站消息喂给内核 getReply → 回发。
//
// 从桌宠版 electron/adapter/adapter-manager.ts 移植为纯 Node 版（用户拍板：
// 机器人搬进核心版）。差异点：
//   - 配置存 pet-client.config.json 的 adapters[]，与桌宠版**同一份文件、同一个键**
//     （桌宠版从不存在 adapter.json，核心版早期那份已由 migrateLegacyAdapterFile 迁走）
//   - session_id 直接用 conversationKey（桌宠版那套「群号:用户ID」规则不变）
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

async function handleIncoming(incoming) {
    const uid = botUid();
    const sessionId = `bot-${incoming.adapterId}-${incoming.conversationKey}`;
    console.log(`[bot] 入站 ${incoming.adapterId} ${incoming.conversationKey}: "${incoming.text.slice(0, 40)}"`);

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
        await sessionManager.saveMessage(sessionId, 'user', incoming.text);
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
        await sessionManager.saveMessage(sessionId, 'assistant', reply.speech);
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
        const reply = await handleIncoming(incoming);
        try {
            await adapter.sendMessage(incoming, {
                text: reply.speech || '',
                images: Array.isArray(reply.images) ? reply.images : [],
            });
        } catch (e) {
            console.warn(`[bot] 回发失败（${incoming.conversationKey}）:`, e?.message || e);
        }
    });
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
        }
    }
    for (const cfg of configs) startAdapter(cfg);
    return running.size;
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
    botUid,
    collectSkillPrompts,
    adapterFilePath: () => clientConfig.clientConfigPath(),
};
