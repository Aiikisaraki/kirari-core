// src/dataDir.js
// 数据目录解析：核心版（kirari-core）与桌宠版（kirari-desktop）**共用同一份数据**。
//
// 为什么要有这个模块（用户拍板）：核心版是「智能机器人助手本体」，
// 桌宠版装了核心版就直接读它的配置和记录，不需要用户手动配任何路径。
// 规则只有一条：**核心版没有的配置字段一律不碰，保持原样**，绝不因为
// 「核心版不认识」就把桌宠版的字段删掉。
//
// 解析优先级（从高到低）：
//   1. PET_API_DATA_DIR           显式指定（Docker / 服务器部署 / 高级用户）
//   2. KIRARI_DESKTOP_DATA_DIR    显式指定桌宠版 userData（跨平台测试用）
//   3. 自动探测桌宠版 userData     按 Electron 默认规则拼路径，存在且可写就用
//   4. <包根>/data                兜底（服务器全新部署，本机没装过桌宠版）
//
// 桌宠版 userData 的 Electron 默认规则（app.getPath('userData')）：
//   Windows  %APPDATA%\<name>         例：C:\Users\X\AppData\Roaming\akisaki-kirari
//   macOS    ~/Library/Application Support/<name>
//   Linux    ~/.config/<name>         （XDG_CONFIG_HOME 可覆盖）
// <name> 取桌宠版 package.json 的 name 字段（未设 productName，故就是 name）。
const fs = require('fs');
const path = require('path');
const os = require('os');

// 与桌宠版 package.json 的 name 保持一致；改名时两边都要改。
const DESKTOP_APP_NAME = 'akisaki-kirari';

function desktopUserDataCandidates() {
    const home = os.homedir();
    const out = [];

    if (process.platform === 'win32') {
        // Electron 在 Windows 上读 %APPDATA%（而不是 %LOCALAPPDATA%）
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        out.push(path.join(appData, DESKTOP_APP_NAME));
    } else if (process.platform === 'darwin') {
        out.push(path.join(home, 'Library', 'Application Support', DESKTOP_APP_NAME));
    } else {
        const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        out.push(path.join(xdg, DESKTOP_APP_NAME));
    }
    return out;
}

function isWritableDir(dir) {
    try {
        if (!fs.existsSync(dir)) return false;
        const st = fs.statSync(dir);
        if (!st.isDirectory()) return false;
        // 真正探一下可写：目录可能存在但属于别的用户 / 只读
        const probe = path.join(dir, `.kirari-write-probe-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 解析数据目录。只做「选目录」这一件事，不创建文件、不写日志噪音。
 * 返回 { dir, source, detail } —— source 用于启动日志里说清用了哪份数据。
 */
function resolveDataDir() {
    // 1. 显式覆盖（最高优先级，兼容 Docker / 服务器既有部署）
    if (process.env.PET_API_DATA_DIR && process.env.PET_API_DATA_DIR.trim()) {
        const dir = path.resolve(process.env.PET_API_DATA_DIR.trim());
        return { dir: ensureDir(dir), source: 'env:PET_API_DATA_DIR', detail: dir };
    }

    // 2. 显式指定桌宠版 userData
    if (process.env.KIRARI_DESKTOP_DATA_DIR && process.env.KIRARI_DESKTOP_DATA_DIR.trim()) {
        const dir = path.resolve(process.env.KIRARI_DESKTOP_DATA_DIR.trim());
        if (isWritableDir(dir)) {
            return { dir, source: 'env:KIRARI_DESKTOP_DATA_DIR', detail: dir };
        }
        console.warn(`[data-dir] KIRARI_DESKTOP_DATA_DIR 指向的目录不可写，已忽略：${dir}`);
    }

    // 3. 自动探测桌宠版 userData
    for (const candidate of desktopUserDataCandidates()) {
        if (isWritableDir(candidate)) {
            return { dir: candidate, source: 'auto:desktop-userData', detail: candidate };
        }
    }

    // 4. 兜底：包内 data 目录
    const fallback = ensureDir(path.resolve(__dirname, '..', '..', 'data'));
    return { dir: fallback, source: 'fallback:package-data', detail: fallback };
}

const RESOLVED = resolveDataDir();

module.exports = {
    dataDir: RESOLVED.dir,
    dataDirSource: RESOLVED.source,
    dataDirDetail: RESOLVED.detail,
    /** 桌宠版 userData 的候选路径（探测逻辑单测 / 排错用） */
    desktopUserDataCandidates,
    isWritableDir,
};
