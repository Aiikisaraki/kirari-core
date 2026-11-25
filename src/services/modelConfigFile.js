// 模型配置文件（config.json）：核心版多模型的**唯一真源**。
//
// 📐 与桌面端 electron/model-config.ts 同构（schema、语义、掩码格式全部一致）：
//    顶层 endpoint/model/key = 当前生效；models[] + activeModelId = 所有套与当前项；
//    searchProvider/searchEndpoint/searchKey = 联网搜索渠道（所有大脑共用）。
//    basePersona = 用户自定义基础人格（桌宠版有，核心版同样读写）。
//    两端 config.json 可以直接互相拷贝迁移。
//
// 为什么从 SQLite 搬到文件：与桌面端对齐（用户拍板）——「听配置界面和配置文件的」。
// 控制台界面和手改文件是仅有的两个写入口，都热生效（fs.watch + 去抖 → 失效上下文）。
//
// ⚠️ 安全写回（用户拍板）：核心版**没有的配置字段一律原样保留**。
//    桌宠版可能手写进 searxng 私有字段、皮肤偏好等核心版不认识的东西，
//    一旦写回时整体覆盖就把用户数据删了。所有写入口必须走 writeRaw 的合并逻辑，
//    只动自己认识的键，绝不 new 一个瘦对象替换掉整个文件。
//
// 首次启动迁移（仅当 config.json 不存在时，跑一次）：
//   model_profiles 表的行 + api_tokens 的搜索配置/旧单套配置 → 写入 config.json。
//   半配置旧档案（有密钥没地址）不造模型套，顶层如实保留空地址 —— 聊天入口会明确报错。
//
// ⚠️ 半配置不允许存在（用户拍板）：模型套必须三件套齐全（endpoint/model/key），
//    缺任何一个 = 未配置，绝不静默套默认地址。
const fs = require('fs');
const path = require('path');
// AgentProfile：默认常量只在首次迁移写盘用一次；运行期读取一律走 parseAgentProfile 严格校验，
// 缺字段 / 坏值显式报错，绝不静默回退默认值（共享包红线，两端同构）。
const { parseAgentProfile, DEFAULT_AGENT_PROFILE } = require('kirari-agent');

// 数据目录统一走 src/dataDir.js → kirariHome.js 的 ~/.kirari 数据根（见 kirariHome 注释）。
const { paths: HOME_PATHS, dataDir: DATA_DIR } = require('../dataDir');
const modelsFile = require('./modelsFile');
const CONFIG_FILE = HOME_PATHS.config;

// 核心版认识的顶层字段。写回时：这些键可以改，其余一律保留原值。
// ⚠️ 'models' 已迁出到 models.json，但**仍留在白名单**：老文件里可能还有这一项，
//    要允许它被读取（只读不写），迁移完成后会用 delete 清掉，不能让写回逻辑忽略它。
const KNOWN_TOP_KEYS = [
    'model',
    'endpoint',
    'key',
    'searchProvider',
    'searchEndpoint',
    'searchKey',
    'basePersona',
    'models',
    'activeModelId',
    'seeded',
    'agentProfile',
    'thinking',
];

let initialized = false;
let config = null;
const changeCallbacks = [];
let watchHandle = null;
let debounceTimer;

function maskKey(key) {
    if (!key) return '';
    if (key.length <= 6) return '****';
    return `${key.slice(0, 3)}${'*'.repeat(6)}${key.slice(-4)}`;
}

function readRaw() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return null;
        const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null; // 文件坏了当没有 —— 但不覆盖用户文件，等用户修
    }
}

function writeRaw(next) {
    // 安全写回：以「当前文件里的真实内容」为基底合并，而不是信任调用方传进来的对象。
    // 调用方经常是 { ...config, models: nextModels } 这种展开 —— config 本身是完整的，
    // 所以 spread 通常不会丢字段；但首启动迁移等场景会传一个全新的瘦对象，
    // 此时若直接写就把桌宠版的未知字段全删了。这里统一兜底：未知键原样搬回来。
    const merged = mergePreservingUnknown(config, next);
    config = merged;
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[model-config] 写入 config.json 失败:', e instanceof Error ? e.message : String(e));
        return;
    }
    notify();
}

/** 把 next 里认识的键覆盖到 current 上，current 的其余键（桌宠版私有字段）原样保留。 */
function mergePreservingUnknown(current, next) {
    if (!current || typeof current !== 'object') return next;
    if (!next || typeof next !== 'object') return current;
    const merged = { ...current };
    for (const k of Object.keys(next)) {
        if (KNOWN_TOP_KEYS.includes(k)) merged[k] = next[k];
    }
    return merged;
}

function notify() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        for (const cb of changeCallbacks) {
            try {
                cb(config);
            } catch (e) {
                console.warn('[model-config] 变更回调出错:', e instanceof Error ? e.message : String(e));
            }
        }
    }, 200);
}

/**
 * 取全部模型套 —— 现在从 models.json 读（WorkBuddy 同构，可跨 agent 互拷）。
 *
 * 读失败（文件坏了）不让整个进程崩：返回空数组 + 打日志，用户在设置页能看到
 * 「一套都没有」从而重新添加，而不是聊天直接抛异常。
 */
function safeModels() {
    try {
        return modelsFile.readModels();
    } catch (e) {
        console.warn('[model-config] 读取 models.json 失败（当作没有模型套）:', e instanceof Error ? e.message : String(e));
        return [];
    }
}

/**
 * 把老 config.json 里的 models[] 迁到 models.json（一次性）。
 *
 * 触发条件：models.json 不存在的**且** config.json 里有 models[]。
 * 迁移后从 config.json 里删掉该键（否则会长期存在两份真源，改一个另一个不生效）。
 * 只删 models，其余字段（含桌宠版私有字段）原样保留。
 */
function migrateModelsOutOfConfig() {
    if (!config || !Array.isArray(config.models) || !config.models.length) return 0;
    if (fs.existsSync(modelsFile.MODELS_FILE)) return 0; // 已经有独立清单，不动
    const moved = config.models;
    try {
        modelsFile.writeModels(moved);
    } catch (e) {
        console.warn('[model-config] 迁移 models[] 到 models.json 失败（保留原样）:', e instanceof Error ? e.message : String(e));
        return 0;
    }
    const next = { ...config };
    delete next.models;
    config = next;
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[model-config] 迁移后回写 config.json 失败:', e instanceof Error ? e.message : String(e));
    }
    console.log(`[model-config] 已把 config.json 里的 ${moved.length} 套模型迁到 models.json（config.json 只保留当前生效项）`);
    return moved.length;
}

/** 迁移来源：从 SQLite 导出旧的多模型数据（惰性 require 避免循环依赖）。 */
function migrateFromDb(uid) {
    // 运行到这里时 dbStorage 一定已完成加载（首次调用方就是它），循环依赖安全。
    // eslint-disable-next-line global-require
    const { exportLegacyModelData } = require('../db/dbStorage');
    const data = exportLegacyModelData(uid);
    // 兼容旧版 .env：老用户可能只配了 MODEL_API_ENDPOINT 环境变量、没在界面里写过地址。
    // 这里**只作为一次性迁移输入**吸进 config.json —— 迁移完成后 env 即失效，不再读取。
    const envEndpoint = String(process.env.MODEL_API_ENDPOINT || '').trim();
    const legacy = { ...(data.legacy || {}), endpoint: (data.legacy && data.legacy.endpoint) || envEndpoint };
    const cfg = {
        model: typeof legacy.model === 'string' ? legacy.model : '',
        endpoint: typeof legacy.endpoint === 'string' ? legacy.endpoint : '',
        key: typeof legacy.key === 'string' ? legacy.key : '',
        searchProvider: legacy.searchProvider || 'uapis',
        searchEndpoint: legacy.searchEndpoint || '',
        searchKey: legacy.searchKey || '',
        activeModelId: null,
    };
    // models 现在归 models.json 管，这里收集出来，由 ensureInitialized 单独写盘。
    let seededModels = [];
    if (data.profiles && data.profiles.length > 0) {
        // 已有多模型数据 → 整表搬到 models.json，顶层同步成当前套
        seededModels = data.profiles;
        const active = Number.isSafeInteger(data.activeId) && data.profiles.some((m) => m.id === data.activeId)
            ? data.activeId
            : data.profiles[0].id;
        cfg.activeModelId = active;
        const cur = data.profiles.find((m) => m.id === active);
        if (cur) {
            cfg.endpoint = cur.endpoint;
            cfg.model = cur.model;
            cfg.key = cur.key;
        }
    } else if (legacy.key && legacy.endpoint) {
        // 旧单套配置三件套齐全 → 导成「默认」套（与桌面端懒迁移同语义）
        seededModels = [{ id: 1, name: '默认', endpoint: legacy.endpoint, model: legacy.model || 'gpt-5.4-mini', key: legacy.key }];
        cfg.activeModelId = 1;
        cfg.endpoint = legacy.endpoint;
        cfg.model = legacy.model || 'gpt-5.4-mini';
        cfg.key = legacy.key;
        console.log('[model-config] 已把 SQLite 里的旧单套配置迁移到 models.json（默认）');
    } else if (legacy.key || legacy.endpoint) {
        console.log('[model-config] 旧配置不完整（缺地址或密钥），不造模型套；顶层如实保留，聊天时会提示先配置');
    }
    return { cfg, seededModels };
}

function ensureInitialized() {
    if (initialized) return;
    initialized = true;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const raw = readRaw();
    if (raw === null) {
        // 首次：从 SQLite 迁移（没有可迁的就是一份空配置）
        const uid = Number(process.env.BOT_MODEL_UID || 1);
        const { cfg: migrated, seededModels } = migrateFromDb(uid);
        // 阶段 B：首次建配置时把默认 agentProfile 落盘一次。
        // 只在此处用默认值——之后运行期缺字段一律报错，不再兜底（用户拍板）。
        if (!migrated.agentProfile) migrated.agentProfile = { ...DEFAULT_AGENT_PROFILE };
        writeRaw(migrated);
        // 模型清单单独落 models.json（不存在才写，绝不覆盖用户已有的清单）
        if (seededModels.length && !fs.existsSync(modelsFile.MODELS_FILE)) {
            try {
                modelsFile.writeModels(seededModels);
                console.log(`[model-config] 已创建 ${modelsFile.MODELS_FILE}（${seededModels.length} 套）`);
            } catch (e) {
                console.warn('[model-config] 写 models.json 失败:', e instanceof Error ? e.message : String(e));
            }
        }
        console.log(`[model-config] 已创建 ${CONFIG_FILE}`);
    } else {
        config = raw;
        // 存量配置升级 1：models[] 从 config.json 搬到 models.json（一次性，幂等）
        migrateModelsOutOfConfig();
        // 存量配置升级 2：老用户 config.json 没有 agentProfile，补写一份默认值落盘（一次）。
        // 走 writeRaw → mergePreservingUnknown，手写的未知字段原样保留。
        if (!config.agentProfile) {
            writeRaw({ ...config, agentProfile: { ...DEFAULT_AGENT_PROFILE } });
            console.log('[model-config] 已为存量配置补写默认 agentProfile');
        }
    }
    startWatch();
}

/**
 * 运行期读取 agentProfile。配置不存在 / 字段缺失 / 值非法都显式抛错，不回退默认值。
 * fs.watch 已把文件内容同步进内存 config，改完配置立即生效。
 */
function getAgentProfile() {
    ensureInitialized();
    return parseAgentProfile(config.agentProfile, 'config.json.agentProfile');
}

// ── 对外：多模型 CRUD（与桌面端同语义）────────────────────────────

function listModelProfiles() {
    ensureInitialized();
    const models = safeModels();
    return {
        items: models.map((m) => ({
            id: m.id,
            name: m.name,
            endpoint: m.endpoint,
            model: m.model,
            keyMasked: maskKey(m.key),
            hasKey: !!m.key,
        })),
        activeId: typeof config.activeModelId === 'number' ? config.activeModelId : null,
    };
}

function getModelProfile(id) {
    ensureInitialized();
    return safeModels().find((m) => m.id === id) || null;
}

function addModelProfile(p) {
    ensureInitialized();
    const models = safeModels();
    const id = models.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    const profile = {
        id,
        name: String(p.name || '').trim().slice(0, 40),
        endpoint: String(p.endpoint || '').trim(),
        model: String(p.model || '').trim(),
        key: String(p.key || '').trim(),
    };
    modelsFile.writeModels([...models, profile]);
    // 第一套自动成为当前使用（没有当前套就没法聊天）—— 覆盖顶层
    const hasValidActive =
        typeof config.activeModelId === 'number' && models.some((m) => m.id === config.activeModelId);
    if (!hasValidActive) {
        writeRaw({
            ...config,
            activeModelId: id,
            endpoint: profile.endpoint,
            model: profile.model,
            key: profile.key,
        });
    }
    return id;
}

/** 更新一套。key 传空串/undefined = 保持原值。 */
function updateModelProfile(id, patch) {
    ensureInitialized();
    const models = safeModels();
    const cur = models.find((m) => m.id === id);
    if (!cur) return false;
    const nextModels = models.map((m) =>
        m.id === id
            ? {
                  ...m,
                  name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 40) : m.name,
                  endpoint: typeof patch.endpoint === 'string' && patch.endpoint.trim() ? patch.endpoint.trim() : m.endpoint,
                  model: typeof patch.model === 'string' && patch.model.trim() ? patch.model.trim() : m.model,
                  key: typeof patch.key === 'string' && patch.key.trim() ? patch.key.trim() : m.key,
              }
            : m,
    );
    modelsFile.writeModels(nextModels);
    // 改的正好是当前生效那一套 → 顶层三件套跟着更新（否则聊天还用旧地址）
    if (config.activeModelId === id) {
        const cur2 = nextModels.find((m) => m.id === id);
        if (cur2) {
            writeRaw({ ...config, endpoint: cur2.endpoint, model: cur2.model, key: cur2.key });
        }
    }
    return true;
}

function deleteModelProfile(id) {
    ensureInitialized();
    const models = safeModels();
    if (!models.some((m) => m.id === id)) return false;
    modelsFile.writeModels(models.filter((m) => m.id !== id));
    // 与桌面端一致：删的是当前套 → activeId 置空，顶层字段保持（聊天还能用）
    if (config.activeModelId === id) {
        const next = { ...config };
        delete next.activeModelId;
        writeRaw(next);
    }
    return true;
}

/** 「设为当前」：把那套覆盖到顶层生效字段 + 记 activeModelId。 */
function activateModelProfile(id) {
    ensureInitialized();
    const target = safeModels().find((m) => m.id === id);
    if (!target) return false;
    writeRaw({
        ...config,
        endpoint: target.endpoint,
        model: target.model,
        key: target.key,
        activeModelId: id,
    });
    return true;
}

function getActiveModelId() {
    ensureInitialized();
    return typeof config.activeModelId === 'number' ? config.activeModelId : null;
}

/** 聊天用的「当前生效模型配置」（三件套可能为空串 = 未配置，由调用方报错指路）。 */
function getActiveModelConfig() {
    ensureInitialized();
    const models = safeModels();
    const cur = typeof config.activeModelId === 'number' ? models.find((m) => m.id === config.activeModelId) : null;
    if (cur) return { model: cur.model, endpoint: cur.endpoint, key: cur.key, source: `model#${cur.id}(${cur.name})` };
    return { model: config.model || '', endpoint: config.endpoint || '', key: config.key || '', source: 'file' };
}

/** 设置页快照（含搜索配置；密钥只给掩码）。username 由调用方补。 */
function getProfileSnapshot() {
    ensureInitialized();
    return {
        model: config.model || '',
        endpoint: config.endpoint || '',
        keyMasked: maskKey(config.key),
        hasKey: !!config.key,
        searchProvider: config.searchProvider || 'uapis',
        searchEndpoint: config.searchEndpoint || '',
        searchKeyMasked: maskKey(config.searchKey),
        hasSearchKey: !!config.searchKey,
        // 与桌宠版共用的「自定义基础人格」；空 = 用后端预设人格
        basePersona: typeof config.basePersona === 'string' ? config.basePersona : '',
    };
}

/** 顶层合并写入（设置页 /api/settings、/api/profile 的 patch）。 */
function setProfilePatch(patch) {
    ensureInitialized();
    const next = { ...config };
    for (const k of ['model', 'endpoint', 'key', 'searchKey', 'searchEndpoint', 'searchProvider', 'basePersona']) {
        if (patch[k] !== undefined) next[k] = patch[k];
    }
    if (next.searchProvider === undefined || next.searchProvider === '') next.searchProvider = 'uapis';
    writeRaw(next);
}

// ── 人格 ────────────────────────────────────────────────────────────────
//
// 2026-11-25 用户拍板：人格从 config.json 搬到独立文件 ~/.kirari/persona.md。
// 原因：4000 字上限写不细、和模型密钥一损俱损、没法当明文编辑。
//
// 但**读入口的签名不变**（仍然叫 getBasePersona 返回字符串），
// 因为它在两端有十几个调用点；改签名等于把一次文件搬家变成一次跨仓库重构。
// 真正的读写都在 services/personaFile.js 里，这里只做转发 + 兼容回退。

/** 读 config.json 里的原始 basePersona（**不**查 persona.md）。仅供迁移与回退用。 */
function getRawBasePersona() {
    ensureInitialized();
    return typeof config.basePersona === 'string' ? config.basePersona : '';
}

/** 读自定义人格。优先 persona.md；没有再回退 config.json 的老字段；都空 = 未自定义。 */
function getBasePersona() {
    ensureInitialized();
    try {
        const { resolvePersona } = require('./personaFile');
        const r = resolvePersona();
        if (r.text) return r.text;
    } catch (e) {
        // persona.md 读写异常不能让人格变成空：继续走下面的老字段
        console.warn('[model-config] 读 persona.md 失败，回退 config.json:', e && e.message ? e.message : e);
    }
    return typeof config.basePersona === 'string' ? config.basePersona : '';
}

/**
 * 写自定义人格。传空串 = 「恢复预设」（删掉 persona.md，真正回到内置预设）。
 *
 * 同时**清空 config.json 里的老字段**：不清的话回退链会立刻把它读回来，
 * 用户点「恢复预设」看起来毫无反应 —— 这是这类双层存储最典型的坑。
 */
function setBasePersona(value) {
    ensureInitialized();
    const v = typeof value === 'string' ? value : '';
    let saved = '';
    try {
        const { writePersonaFile } = require('./personaFile');
        const w = writePersonaFile(v);
        if (w.truncated) console.warn('[model-config] 人格超过上限，已截断到', w.saved.length, '字');
        saved = w.saved;
    } catch (e) {
        console.warn('[model-config] 写 persona.md 失败:', e && e.message ? e.message : e);
    }
    // 老字段跟着清（不留旧值，否则回退链会把刚删掉的人格读回来）
    writeRaw({ ...config, basePersona: '' });
    return saved;
}

// ── 思考模式（self_ops 可改；存 config.json 的 thinking.mode）──────────

/** 读思考模式：off=直接答 / on=每次先列思路 / auto=仅复杂问题深入。缺省 off。 */
function getThinking() {
    ensureInitialized();
    const mode = config.thinking && config.thinking.mode;
    return ['off', 'on', 'auto'].includes(mode) ? mode : 'off';
}

/**
 * 整体写 agentProfile（自我修补用）。复用已有 parseAgentProfile 做严格校验：
 * 坏值抛错、不落盘。只碰 agentProfile 键，不动模型/密钥。
 */
function setAgentProfilePatch(profile) {
    ensureInitialized();
    const parsed = parseAgentProfile(profile, 'self_ops.agentProfile');
    writeRaw({ ...config, agentProfile: parsed });
    return parsed;
}

/** 写思考模式。只碰 thinking 键，不动模型/密钥字段。 */
function setThinking(mode) {
    ensureInitialized();
    const m = ['off', 'on', 'auto'].includes(mode) ? mode : 'off';
    writeRaw({ ...config, thinking: { ...(config.thinking || {}), mode: m } });
    return m;
}

/** 搜索配置明文（聊天内核用）。 */
function getSearch() {
    ensureInitialized();
    return {
        searchProvider: config.searchProvider || 'uapis',
        searchEndpoint: config.searchEndpoint || '',
        searchKey: config.searchKey || '',
    };
}

// ── 文件监听（外部编辑器手改 → 热生效）────────────────────────────

function startWatch() {
    if (watchHandle) return;
    try {
        watchHandle = fs.watch(CONFIG_FILE, () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const raw = readRaw();
                if (raw === null) return; // 编辑器保存的中间态（空文件）忽略
                const changed = JSON.stringify(raw) !== JSON.stringify(config);
                config = raw;
                if (changed) notify();
            }, 200);
        });
        watchHandle.on('error', (e) => {
            console.warn('[model-config] 监听 config.json 出错（外部编辑不会实时同步）:', e instanceof Error ? e.message : String(e));
        });
    } catch (e) {
        console.warn('[model-config] 无法监听 config.json（外部编辑不会实时同步）:', e instanceof Error ? e.message : String(e));
    }
}

function onConfigChanged(cb) {
    changeCallbacks.push(cb);
}

module.exports = {
    listModelProfiles,
    getModelProfile,
    addModelProfile,
    updateModelProfile,
    deleteModelProfile,
    activateModelProfile,
    getActiveModelId,
    getActiveModelConfig,
    getProfileSnapshot,
    setProfilePatch,
    getBasePersona,
    getRawBasePersona,
    setBasePersona,
    setAgentProfilePatch,
    getThinking,
    setThinking,
    getSearch,
    onConfigChanged,
    startWatch,
    getAgentProfile,
    migrateModelsOutOfConfig,
    getConfigPath: () => CONFIG_FILE,
    getDataDir: () => DATA_DIR,
};
