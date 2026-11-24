// src/dataDir.js — check-requires-ignore（第 11 行注释里的 require('../dataDir') 是示例文本，非真实代码）
// 数据目录解析：核心版（kirari-core）与桌宠版（kirari-desktop）**共用同一份数据**。
//
// 历史：这里原本负责「自动探测桌宠版 userData（%APPDATA%\akisaki-kirari）」，
// 没有就兜底到包内 data/。两套规则藏在多个文件里，换机器就得重新猜。
//
// 现在统一收口到 src/kirariHome.js 的 ~/.kirari 数据根（目录规范见 docs/home-layout.md）：
//   · 唯一的规则来源是 kirariHome.js 的 LAYOUT；
//   · 首次启动把旧位置（桌宠版 userData / 包内 data）的已知数据**复制**过来，原件不动；
//   · 本文件只保留「向后兼容的 dataDir 别名」，让既有的
//     `require('../dataDir').dataDir` 调用点不必一次全改。
//
// ⚠️ 新代码请直接用 kirariHome.js 的 paths（带具体文件名），
//    不要再往 dataDir 上拼文件名 —— 那正是这次迁移要消灭的扁平结构。
const fs = require('fs');
const path = require('path');
const home = require('./kirariHome');

/** 一次性迁移（只在 home.json 没有迁移记录时执行；幂等）。 */
function bootstrap() {
    try {
        return home.migrateLegacy(home.homeDir);
    } catch (e) {
        // 迁移失败不阻断启动：新目录该建的已经建好，用户原有数据仍在旧位置。
        console.warn('[home] 旧数据迁移失败（原有数据未改动，可稍后手动迁移）:', e && e.message ? e.message : e);
        try {
            home.ensureLayout(home.homeDir);
        } catch { /* ignore */ }
        return { ran: false, reason: 'error', copied: [], skipped: [], failed: [] };
    }
}

const MIGRATION = bootstrap();

/** 数据根（= ~/.kirari）。保留旧名字，兼容既有调用点。 */
const DATA_DIR = home.homeDir;
/** 全量路径对象：config / database / skillsRoot / logs ... 见 kirariHome.LAYOUT */
const PATHS = home.paths;

/** 旧的「根目录下扁平文件名」辅助：仅供尚未改写的调用点过渡使用。 */
function legacyFlat(name) {
    return path.join(DATA_DIR, name);
}

module.exports = {
    /** @deprecated 用 paths.xxx（具体文件）代替 */
    dataDir: DATA_DIR,
    dataDirSource: home.homeSource,
    dataDirDetail: DATA_DIR,
    /** 具体路径真源 */
    paths: PATHS,
    home,
    legacyFlat,
    /** 迁移结果（启动日志 / 排错用） */
    migration: MIGRATION,
    /** 旧版兼容导出（单测与排错用） */
    desktopUserDataCandidates: home.legacyRoots,
    isWritableDir,
};

function isWritableDir(dir) {
    try {
        if (!fs.existsSync(dir)) return false;
        const st = fs.statSync(dir);
        if (!st.isDirectory()) return false;
        const probe = path.join(dir, `.kirari-write-probe-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}
