// src/services/modelsFile.js
// 模型清单文件（models.json）—— 与 WorkBuddy 的 ~/.workbuddy/models.json 同构。
//
// ── 为什么单独拆一个文件 ────────────────────────────────────────────
// 以前 models[] 塞在 config.json 里，config.json 就混了「当前生效的模型三件套 +
// 搜索渠道 + 人格 + AgentProfile + 模型清单」四类东西。拆开之后：
//   config.json   只放 Kirari 自己的运行期设置（当前模型 / 搜索 / 人格 / agentProfile）
//   models.json   纯模型清单，字段名跟 WorkBuddy 一致 → 整份文件可以直接拷给别的 agent
//
// ── 字段映射（WorkBuddy ↔ Kirari）────────────────────────────────────
//   id       模型型号（真实发给 API 的 model 名）   ↔  model
//   name     界面上显示的名字                      ↔  name
//   url      服务地址（base URL）                  ↔  endpoint
//   apiKey   密钥                                  ↔  key
//   vendor / supportsToolCall / supportsImages / supportsReasoning / reasoning
//            原样保留，Kirari 不解释但保证不丢
//   profileId  Kirari 内部主键（数字）
//
// ⚠️ profileId 是 Kirari 独有的扩展字段。WorkBuddy 读我们写的文件时会忽略它；
//    我们读 WorkBuddy 的文件时它不存在 —— 此时按顺序补编号。两边都不受影响。
//
// ⚠️ 为什么内部主键还在用数字：核心版 REST 接口是 PUT /api/models/:id，前端控制台
//    与 dbStorage 全按 Number 处理，改成字符串 id 是一次跨三端的大改，
//    收益只是「文件里少一个字段」，不值当。所以内部照旧，只在文件边界转换。
const fs = require('fs');
const path = require('path');
const { paths: HOME_PATHS } = require('../dataDir');

const MODELS_FILE = HOME_PATHS.models;

/** Kirari 认识的字段（其余字段原样保留，不丢用户手写的东西）。 */
const KNOWN_KEYS = ['profileId', 'id', 'name', 'url', 'apiKey', 'vendor'];

function maskKey(key) {
    if (!key) return '';
    if (key.length <= 6) return '****';
    return `${key.slice(0, 3)}${'*'.repeat(6)}${key.slice(-4)}`;
}

/** WorkBuddy 条目 → Kirari 内部条目。 */
function fromEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const model = typeof raw.id === 'string' ? raw.id.trim() : '';
    const endpoint = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!model && !endpoint && !raw.apiKey) return null;
    const out = {
        name: typeof raw.name === 'string' ? raw.name.trim() : model,
        model,
        endpoint,
        key: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    };
    if (Number.isSafeInteger(raw.profileId) && raw.profileId > 0) out.id = raw.profileId;
    // 其余字段（vendor / supports* / reasoning / 用户私有）原样带着
    for (const k of Object.keys(raw)) {
        if (KNOWN_KEYS.includes(k)) continue;
        out[k] = raw[k];
    }
    // WorkBuddy 的这几个能力位对 Kirari 没用但必须保留，否则写回时丢失
    if (raw.supportsToolCall !== undefined) out.supportsToolCall = raw.supportsToolCall;
    if (raw.supportsImages !== undefined) out.supportsImages = raw.supportsImages;
    if (raw.supportsReasoning !== undefined) out.supportsReasoning = raw.supportsReasoning;
    if (raw.reasoning !== undefined) out.reasoning = raw.reasoning;
    if (raw.useCustomProtocol !== undefined) out.useCustomProtocol = raw.useCustomProtocol;
    return out;
}

/** Kirari 内部条目 → WorkBuddy 条目。 */
function toEntry(m) {
    if (!m || typeof m !== 'object') return null;
    const model = String(m.model || '').trim();
    const endpoint = String(m.endpoint || '').trim();
    if (!model && !endpoint && !m.key) return null;
    const out = {
        id: model || String(m.id || ''),
        name: String(m.name || model).trim(),
        vendor: typeof m.vendor === 'string' && m.vendor ? m.vendor : 'Custom',
        url: endpoint,
        apiKey: m.key || '',
    };
    // 能力位：用户没显式写过就给一组保守默认（写了就照抄）
    out.supportsToolCall = m.supportsToolCall !== false;
    out.supportsImages = m.supportsImages === true;
    out.supportsReasoning = m.supportsReasoning === true;
    out.useCustomProtocol = m.useCustomProtocol === true;
    if (m.reasoning !== undefined) out.reasoning = m.reasoning;
    if (Number.isSafeInteger(m.id)) out.profileId = m.id;
    // 用户的私有扩展字段原样带出
    for (const k of Object.keys(m)) {
        if (['id', 'name', 'model', 'endpoint', 'key'].includes(k)) continue;
        if (k in out) continue;
        out[k] = m[k];
    }
    return out;
}

/**
 * 读模型清单。
 * 文件不存在 → 返回空数组（首次启动正常情况）；文件坏了 → 抛错（不静默当空，
 * 否则用户一保存就把整个清单覆盖没了）。
 */
function readModels() {
    if (!fs.existsSync(MODELS_FILE)) return [];
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf-8'));
    } catch (e) {
        throw new Error(`models.json 不是合法 JSON：${MODELS_FILE} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.models) ? raw.models : []);
    const out = [];
    let nextId = 1;
    const used = new Set();
    for (const item of list) {
        const m = fromEntry(item);
        if (!m) continue;
        if (!Number.isSafeInteger(m.id) || used.has(m.id)) {
            while (used.has(nextId)) nextId++;
            m.id = nextId;
        }
        used.add(m.id);
        if (m.id >= nextId) nextId = m.id + 1;
        out.push(m);
    }
    return out;
}

/** 写模型清单（保留文件里的其他结构？—— models.json 顶层就是数组，整体写）。 */
function writeModels(models) {
    const list = [];
    for (const m of Array.isArray(models) ? models : []) {
        const e = toEntry(m);
        if (e) list.push(e);
    }
    fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    fs.writeFileSync(MODELS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf-8');
    return list;
}

/** 给调用方拼快照用。 */
function listMasked(models) {
    return (Array.isArray(models) ? models : []).map((m) => ({
        id: m.id,
        name: m.name,
        endpoint: m.endpoint,
        model: m.model,
        keyMasked: maskKey(m.key),
        hasKey: !!m.key,
    }));
}

module.exports = {
    MODELS_FILE,
    KNOWN_KEYS,
    readModels,
    writeModels,
    listMasked,
    maskKey,
};
