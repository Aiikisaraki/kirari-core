// src/settings/consoleAppearance.js
// 控制台外观（配色 + 明暗）的核心版读写层。
//
// 为什么不用 pet-client.config.json 的 theme 字段（桌宠版「外观」页那个）：
// 桌面小窗和网页后台是两种完全不同的场景，一套设置两头改只会互相干扰 ——
// 在这边切成深色，桌宠那边跟着变，反过来也一样。用户拍板：核心版外观不互通。
//
// 那为什么不只是「在共享文件里换个键名」：桌宠版 saveClientConfig() 是
// JSON.stringify(它自己 parseClientConfig 出来的对象) 整体覆盖写回的，
// 内存里没有的键会被直接抹掉 —— 把 consoleAppearance 塞进那份文件，
// 桌宠端下次保存配置就没了。所以另存一份 data/console-appearance.json：
//   theme  配色（极光玻璃 / 樱粉 / 薄荷嫩芽 / 薰衣草晨雾）
//   mode   明暗（light / dark / auto，auto = 跟随系统）
//
// 配色 id 沿用桌宠版那四个名字（style.css 的变量选择器就是它们），
// 但归属已经解耦：桌宠版增删主题不再影响控制台，反过来也一样。
const { readJson, writeJsonMerged, filePath } = require('./localSettings');

const FILE = 'console-appearance.json';
/** 允许被覆盖的顶层键。之外的键一律从现有文件原样搬回。 */
const KNOWN_KEYS = ['theme', 'mode'];

// 控制台配色（对应 style.css 里的 :root[data-theme="..."]）
const THEMES = [
    { id: 'aurora-glass', label: '极光玻璃', sub: 'Aurora Glass' },
    { id: 'pet-pink', label: '樱粉', sub: 'Pet Pink' },
    { id: 'mint-soft', label: '薄荷嫩芽', sub: 'Mint Soft' },
    { id: 'lavender-mist', label: '薰衣草晨雾', sub: 'Lavender Mist' },
];
const DEFAULT_THEME = 'aurora-glass';
const THEME_IDS = THEMES.map((t) => t.id);

// 明暗模式。auto 由前端按 prefers-color-scheme 落到 light/dark 上再呈现，
// 服务端只存用户选的那个「意图」，不猜系统。
const MODES = [
    { id: 'light', label: '浅色', sub: 'Light' },
    { id: 'dark', label: '深色', sub: 'Dark' },
    { id: 'auto', label: '跟随系统', sub: 'Auto' },
];
const DEFAULT_MODE = 'light';
const MODE_IDS = MODES.map((m) => m.id);

/** 值不在白名单里一律回退默认，绝不把脏值写回去。 */
function getAppearance() {
    const raw = readJson(FILE) || {};
    const theme = typeof raw.theme === 'string' && THEME_IDS.includes(raw.theme.trim())
        ? raw.theme.trim()
        : DEFAULT_THEME;
    const mode = typeof raw.mode === 'string' && MODE_IDS.includes(raw.mode.trim())
        ? raw.mode.trim()
        : DEFAULT_MODE;
    return { theme, mode };
}

/** 只认 theme / mode 两个键；传什么不必填，留空即保持原值。 */
function setAppearance(next) {
    const patch = {};
    if (next && typeof next.theme === 'string') {
        const t = next.theme.trim();
        patch.theme = THEME_IDS.includes(t) ? t : DEFAULT_THEME;
    }
    if (next && typeof next.mode === 'string') {
        const m = next.mode.trim();
        patch.mode = MODE_IDS.includes(m) ? m : DEFAULT_MODE;
    }
    writeJsonMerged(FILE, patch, KNOWN_KEYS);
    return getAppearance();
}

module.exports = {
    THEMES,
    THEME_IDS,
    DEFAULT_THEME,
    MODES,
    MODE_IDS,
    DEFAULT_MODE,
    getAppearance,
    setAppearance,
    appearanceFilePath: () => filePath(FILE),
};
