// src/settings/localSettings.js
// 数据目录里的「用户设置文件」通用存取层。
//
// 为什么不用 SQLite：这些配置要和桌宠版**逐字节互通**（用户拍板：核心版自动接管
// 桌宠版数据）。桌宠版把这些设置存成 userData 下的 JSON 文件，核心版必须读写
// 同一份文件，而不是自己另起一张表 —— 否则两边各写各的，立刻分叉。
//
// 共同约束（用户拍板）：**不认识的字段一律原样保留**。
// 桌宠版版本可能比核心版新、手写进私有字段，写回时整体覆盖 = 删用户数据。
// 所以这里只做「按已知键合并」，绝不 new 瘦对象替换。
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../dataDir');

/** 读一个 JSON 设置文件；不存在/损坏返回 null（调用方决定兜底）。 */
function readJson(fileName) {
    const file = path.join(dataDir, fileName);
    try {
        if (!fs.existsSync(file)) return null;
        const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
        console.warn(`[settings] ${fileName} 读取失败（保留原样不动）:`, e?.message || e);
        return null;
    }
}

/**
 * 按「已知键白名单」合并写回。
 * @param {string} fileName 数据目录下的文件名
 * @param {Object} next 新值
 * @param {string[]} knownKeys 允许被覆盖的顶层键；其余键从现有文件原样搬回
 */
function writeJsonMerged(fileName, next, knownKeys) {
    const file = path.join(dataDir, fileName);
    const current = readJson(fileName) || {};
    const merged = { ...current };
    for (const k of Object.keys(next || {})) {
        if (!knownKeys || knownKeys.includes(k)) merged[k] = next[k];
    }
    try {
        fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`[settings] ${fileName} 写入失败:`, e?.message || e);
        return null;
    }
    return merged;
}

/** 整文件路径（日志/排错用）。 */
function filePath(fileName) {
    return path.join(dataDir, fileName);
}

module.exports = { readJson, writeJsonMerged, filePath, dataDir };
