// src/web/consoleSite.js
// Web 控制台静态站点（web/dist 构建产物）的唯一入口说明。
//
// 控制台有两个入口，指向**同一份**构建产物：
//   /          ← 首页，打开就是控制台（用户拍板：不想记 /console 这段路径）
//   /console/  ← 原来的入口，保留给已经收藏/记牢的人
// 两个入口都工作，靠的是产物用相对路径（vite base: "./"），
// 所以从 / 打开时资源落在 /assets/…、从 /console/ 打开时落在 /console/assets/…。
const fs = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "..", "..", "web", "dist");
const INDEX = path.join(DIST, "index.html");

/** 构建产物在不在（没 npm run build 过就当控制台不存在，服务本体照常跑）。 */
function available() {
    try {
        return fs.existsSync(INDEX);
    } catch {
        return false;
    }
}

/** index.html 不缓存：发新版后浏览器要立刻拿到新页面。 */
function setIndexHeaders(res) {
    res.setHeader("Cache-Control", "no-cache");
}

function sendIndex(res) {
    setIndexHeaders(res);
    return res.sendFile(INDEX);
}

/** express.static 的选项（html 不缓存，带 hash 的资源照常长期缓存）。 */
function staticOptions() {
    return {
        setHeaders(res, filePath) {
            if (filePath.endsWith(".html")) setIndexHeaders(res);
        },
    };
}

module.exports = { DIST, INDEX, available, sendIndex, staticOptions };
