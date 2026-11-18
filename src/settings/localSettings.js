// src/settings/localSettings.js
// 数据根里的「用户设置文件」通用存取层。
//
// 为什么不用 SQLite：这些配置要和桌宠版**逐字节互通**（用户拍板：核心版自动接管
// 桌宠版数据）。桌宠版把这些设置存成 JSON 文件，核心版必须读写同一份文件，
// 而不是自己另起一张表 —— 否则两边各写各的，立刻分叉。
//
// 共同约束（用户拍板）：**不认识的字段一律原样保留**。
// 桌宠版版本可能比核心版新、手写进私有字段，写回时整体覆盖 = 删用户数据。
// 所以这里只做「按已知键合并」，绝不 new 瘦对象替换。
//
// 路径：文件名 → 数据根下的相对路径由 kirariHome.LAYOUT 决定（~/.kirari/...）。
// 调用方仍按「文件名 / 逻辑名」传参，本模块负责翻译成新布局的绝对路径，
// 于是设置类模块不必各自记住自己该落在哪个子目录。
const fs = require('fs');
const path = require('path');
const { paths: HOME_PATHS, dataDir: homeDir } = require('../dataDir');

/**
 * 逻辑名 → 绝对路径。
 *
 * 支持两种入参：
 *   · 布局里的逻辑键（'clientConfig' / 'consoleAppearance' / 'mcpServers' ...）；
 *   · 旧文件名（'pet-client.config.json' / 'console-appearance.json' ...），
 *     由下面这张对照表翻译，保证既有调用点不改名也能落到新位置。
 */
const FILE_ALIASES = {
    'config.json': HOME_PATHS.config,
    'pet-client.config.json': HOME_PATHS.clientConfig,
    'console-appearance.json': HOME_PATHS.consoleAppearance,
};

function resolveFile(nameOrKey) {
    if (HOME_PATHS[nameOrKey] && path.isAbsolute(HOME_PATHS[nameOrKey])) return HOME_PATHS[nameOrKey];
    if (FILE_ALIASES[nameOrKey]) return FILE_ALIASES[nameOrKey];
    // 未登记的名字：落在数据根顶层。新增文件请优先加进 kirariHome.LAYOUT。
    return path.join(homeDir, nameOrKey);
}

/** 读一个 JSON 设置文件；不存在/损坏返回 null（调用方决定兜底）。 */
function readJson(nameOrKey) {
    const file = resolveFile(nameOrKey);
    try {
        if (!fs.existsSync(file)) return null;
        const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
        console.warn(`[settings] ${nameOrKey} 读取失败（保留原样不动）:`, e?.message || e);
        return null;
    }
}

/**
 * 按「已知键白名单」合并写回。
 * @param {string} nameOrKey 布局逻辑名或旧文件名
 * @param {Object} next 新值
 * @param {string[]} knownKeys 允许被覆盖的顶层键；其余键从现有文件原样搬回
 */
function writeJsonMerged(nameOrKey, next, knownKeys) {
    const file = resolveFile(nameOrKey);
    const current = readJson(nameOrKey) || {};
    const merged = { ...current };
    for (const k of Object.keys(next || {})) {
        if (!knownKeys || knownKeys.includes(k)) merged[k] = next[k];
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`[settings] ${nameOrKey} 写入失败:`, e?.message || e);
        return null;
    }
    return merged;
}

/** 整文件路径（日志/排错用）。 */
function filePath(nameOrKey) {
    return resolveFile(nameOrKey);
}

module.exports = { readJson, writeJsonMerged, filePath, resolveFile, dataDir: homeDir, paths: HOME_PATHS };
