#!/usr/bin/env node
// 相对 require 路径体检：解析所有源文件的相对 require，逐个对磁盘验证目标存在。
//
// 背景：1.1.0 的 presence 模块出现过三次 require 路径少一层（'../session/jobStore'
// 写成 './session/jobStore' 之类），CI 构建绿灯但运行即崩（COPY 不校验 require）。
// 这个脚本就是那类错误的闸门：坏路径当场报错退出，进不了镜像。
//
// 用法：node scripts/check-requires.cjs [源码根目录]   （缺省 = src/）
// 退出码：0 = 全部有效；1 = 存在失效路径

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(process.argv[2] || path.join(__dirname, "..", "src"));
const problems = [];
let checked = 0;

/** 解析 require 目标：补 .js / /index.js，任一命中即存在。 */
function exists(baseDir, spec) {
    const resolved = path.resolve(baseDir, spec);
    const candidates = [resolved, resolved + ".js", path.join(resolved, "index.js")];
    return candidates.some((c) => {
        try { return fs.statSync(c).isFile(); } catch { return false; }
    });
}

function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith(".js")) continue;

        const content = fs.readFileSync(full, "utf-8");
        const rel = path.relative(SRC, full);
        const re = /require\(\s*(['\"])(\.\.?\/[^'\"]+)\1\s*\)/g;
        let m;
        while ((m = re.exec(content)) !== null) {
            checked++;
            const spec = m[2];
            const line = content.slice(0, m.index).split("\n").length;
            if (!exists(path.dirname(full), spec)) {
                problems.push(rel + ":" + line + "  require(" + JSON.stringify(spec) + ")");
            }
        }
        // 注释里的示例字符串也会被正则匹配到 —— 误报时把该行注释成不含 require 字样的写法，
        // 或者在本文件顶部加一行 check-requires-ignore 标记跳过该文件。
        if (content.includes("check-requires-ignore")) {
            for (let i = problems.length - 1; i >= 0; i--) {
                if (problems[i].startsWith(rel + ":")) problems.splice(i, 1);
            }



        }
    }
}

if (!fs.existsSync(SRC)) die("源码目录不存在：" + SRC);

walk(SRC);

console.log("[check-requires] 解析 " + checked + " 个相对 require（src = " + SRC + "）");
if (problems.length) {
    console.error("[check-requires] 失效路径 " + problems.length + " 个：");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}
console.log("[check-requires] 全部有效")

function die(msg) { console.error("[check-requires] " + msg); process.exit(1); }
