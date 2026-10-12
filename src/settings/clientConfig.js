// src/settings/clientConfig.js
// 桌宠版「本机配置」pet-client.config.json 的核心版读写层。
//
// 为什么单开一个文件：桌宠版把**本机专属**的东西都塞在 userData/pet-client.config.json
// 里（主题、形象、自定义形象、备注名、我的头像、窗口位置、机器人适配器）。核心版
// 没有桌宠窗口、也没有形象，但它必须和桌宠版**共享**其中的跨端字段 —— 用户拍板：
// 「一台机子装过桌宠版，核心版直接读取桌宠版的所有配置和记录」。
//
// 于是这里只认四个跨端字段：
//   theme      外观主题（配色）—— 桌宠版「外观」页就是它，和「形象换皮肤」是两回事
//   petName    备注名（桌宠版聊天窗口标题、核心版控制台侧栏都显示它）
//   userAvatar 我的头像（useravatar:// 协议地址，指向 userData/user-avatar/avatar<ext>）
//   adapters   机器人适配器（OneBot 等）—— 桌宠版与核心版共用同一份列表
//
// 其余字段（avatar / customAvatars / window 以及未来桌宠版新增的任何键）
// **一律原样保留、一个字节都不改**。理由：核心版不认识它们，写了就是删用户数据。
// 写回走 localSettings.writeJsonMerged 的「已知键白名单合并」，天然满足这一点。
const fs = require("fs");
const path = require("path");
const { readJson, writeJsonMerged, filePath, dataDir } = require("./localSettings");

const FILE = "pet-client.config.json";
/** 允许被核心版覆盖的顶层键。之外的键一律从现有文件原样搬回。 */
const KNOWN_KEYS = ["theme", "petName", "userAvatar", "adapters"];

// 桌宠版 main.ts 的默认值，两边必须一致（loadClientConfig 里写的就是 Kirari）。
const DEFAULT_PET_NAME = "Kirari";

// 四套主题与桌宠版 stores/theme.ts 的 THEMES 一一对应（id / 名 / 副标题都照抄）。
const THEMES = [
    { id: "aurora-glass", label: "极光玻璃", sub: "Aurora Glass" },
    { id: "pet-pink", label: "樱粉", sub: "Pet Pink" },
    { id: "mint-soft", label: "薄荷嫩芽", sub: "Mint Soft" },
    { id: "lavender-mist", label: "薰衣草晨雾", sub: "Lavender Mist" },
];
const DEFAULT_THEME = "aurora-glass";
const THEME_IDS = THEMES.map((t) => t.id);

/** 头像文件所在目录（与桌宠版 userData/user-avatar 同名同位置）。 */
const AVATAR_DIR_NAME = "user-avatar";

function clientConfigPath() {
    return filePath(FILE);
}

function userAvatarDir() {
    return path.join(dataDir, AVATAR_DIR_NAME);
}

/** 文件存在且能解析成对象就返回，否则 null（调用方按缺省值兜底）。 */
function readRaw() {
    return readJson(FILE);
}

/** 桌宠版本机配置在不在（排错页显示「有没有接管到桌宠配置」用）。 */
function exists() {
    try {
        return fs.existsSync(clientConfigPath());
    } catch {
        return false;
    }
}

// ------------------------------ 外观主题 ------------------------------

/** 与桌宠版同规则：不认识的主题名一律回退默认，绝不把脏值写回去。 */
function getTheme() {
    const raw = readRaw();
    const v = raw && typeof raw.theme === "string" ? raw.theme.trim() : "";
    return THEME_IDS.includes(v) ? v : DEFAULT_THEME;
}

function setTheme(value) {
    const next = typeof value === "string" && THEME_IDS.includes(value.trim()) ? value.trim() : DEFAULT_THEME;
    writeJsonMerged(FILE, { theme: next }, KNOWN_KEYS);
    return next;
}

// ------------------------------ 备注名 ------------------------------

/** 与桌宠版 pet-name:get 同规则：去空白，空串回退默认。 */
function getPetName() {
    const raw = readRaw();
    const v = raw && typeof raw.petName === "string" ? raw.petName.trim() : "";
    return v || DEFAULT_PET_NAME;
}

function setPetName(value) {
    const next = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_PET_NAME;
    writeJsonMerged(FILE, { petName: next }, KNOWN_KEYS);
    return next;
}

// ------------------------------ 我的头像 ------------------------------

/**
 * 当前头像的协议地址（useravatar://avatar.png）或 null。
 * 与桌宠版 user-avatar:get 完全同格式 —— 桌宠版存的是引用，不是 base64，
 * 核心版也照抄，绝不把图片塞进 pet-client.config.json（那会改文件格式）。
 */
function getUserAvatar() {
    const raw = readRaw();
    const v = raw && typeof raw.userAvatar === "string" ? raw.userAvatar.trim() : "";
    return v || null;
}

/** 从 useravatar://avatar.png 解析出文件名，防目录穿越（与 main.ts 同一条规则）。 */
function avatarFileFromRef(ref) {
    if (typeof ref !== "string" || !ref.trim()) return "";
    const rel = decodeURIComponent(ref.replace(/^useravatar:\/\//i, "")).split("?")[0];
    // ../ 往上爬的一律拒绝
    const safe = rel.replace(/^(\.\.[/\\])+/, "").replace(/[/\\]/g, "");
    if (!safe || safe === "." || safe === "..") return "";
    return safe;
}

/** 头像文件绝对路径；没配 / 配了但文件不在 → null。 */
function resolveUserAvatarFile() {
    const ref = getUserAvatar();
    const name = avatarFileFromRef(ref);
    if (!name) return null;
    const file = path.join(userAvatarDir(), name);
    try {
        return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
    } catch {
        return null;
    }
}

/**
 * 存新头像：先清空目录（避免不同扩展名的残留图被误引用，与桌宠版同一做法），
 * 再写入 avatar<ext>，最后把引用写回配置。返回协议地址。
 */
function saveUserAvatarFile(buffer, ext) {
    const dir = userAvatarDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
        try {
            fs.rmSync(path.join(dir, f), { force: true });
        } catch {
            /* 单个文件清理失败不影响换头像 */
        }
    }
    const safeExt = String(ext || "").toLowerCase().replace(/[^a-z0-9.]/g, "") || ".png";
    const fileName = "avatar" + (safeExt.startsWith(".") ? safeExt : "." + safeExt);
    fs.writeFileSync(path.join(dir, fileName), buffer);
    const url = "useravatar://" + fileName;
    writeJsonMerged(FILE, { userAvatar: url }, KNOWN_KEYS);
    return url;
}

/** 移除头像：删文件 + 清配置里的引用（键直接消失，与桌宠版 undefined 效果一致）。 */
function clearUserAvatar() {
    const dir = userAvatarDir();
    try {
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                try {
                    fs.rmSync(path.join(dir, f), { force: true });
                } catch {
                    /* 忽略 */
                }
            }
        }
    } catch {
        /* 目录清理失败不阻塞配置清除 */
    }
    // undefined 会被 JSON.stringify 直接丢掉，等于把键删掉，和桌宠版一个效果
    writeJsonMerged(FILE, { userAvatar: undefined }, KNOWN_KEYS);
    return null;
}

// ------------------------------ 机器人适配器 ------------------------------

const LEGACY_ADAPTER_FILE = "adapter.json";

/** 与桌宠版 loadClientConfig 同一条过滤规则。 */
function getAdapters() {
    const raw = readRaw();
    const list = raw && Array.isArray(raw.adapters) ? raw.adapters : [];
    return list.filter(
        (a) => a && typeof a.id === "string" && a.id.trim() && typeof a.type === "string",
    );
}

function setAdapters(list) {
    const next = Array.isArray(list) ? list : [];
    writeJsonMerged(FILE, { adapters: next }, KNOWN_KEYS);
    return next;
}

/**
 * 一次性迁移：核心版早期把适配器写在 adapter.json 里，桌宠版从来都是存在
 * pet-client.config.json 的 adapters[] 中 —— 同机并存时会各读各的、立刻分叉。
 * 现在统一到桌宠版那份：把 adapter.json 里的适配器搬进 pet-client.config.json
 * （仅当目标还没有适配器，绝不覆盖已有配置），然后把旧文件改名留档。
 */
function migrateLegacyAdapterFile() {
    const legacyPath = filePath(LEGACY_ADAPTER_FILE);
    let legacy = null;
    try {
        if (!fs.existsSync(legacyPath)) return false;
        legacy = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    } catch {
        return false;
    }
    const legacyList = legacy && Array.isArray(legacy.adapters) ? legacy.adapters : [];
    const valid = legacyList.filter(
        (a) => a && typeof a.id === "string" && a.id.trim() && typeof a.type === "string",
    );
    if (valid.length > 0 && getAdapters().length === 0) {
        setAdapters(valid);
        console.log(`[config] 已把 ${valid.length} 个机器人适配器从 ${LEGACY_ADAPTER_FILE} 迁进 ${FILE}`);
    }
    try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}.bak`);
    } catch (e) {
        console.warn(`[config] ${LEGACY_ADAPTER_FILE} 留档改名失败（不影响运行）:`, e?.message || e);
    }
    return true;
}

module.exports = {
    FILE,
    KNOWN_KEYS,
    DEFAULT_PET_NAME,
    THEMES,
    DEFAULT_THEME,
    THEME_IDS,
    clientConfigPath,
    userAvatarDir,
    exists,
    readRaw,
    getTheme,
    setTheme,
    getPetName,
    setPetName,
    getUserAvatar,
    avatarFileFromRef,
    resolveUserAvatarFile,
    saveUserAvatarFile,
    clearUserAvatar,
    getAdapters,
    setAdapters,
    migrateLegacyAdapterFile,
};
