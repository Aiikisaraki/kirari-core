#!/usr/bin/env node
// ============================================================================
// write-edition-nsh.cjs — 生成 build-resources/edition.nsh
//
// 用途：打包前根据命令行参数（frontend | integrated | full）写出
//   build-resources/edition.nsh，其中仅一行：
//     !define EDITION "frontend"
//   installer.nsh 通过 !include "edition.nsh" 拿到 EDITION，
//   据此条件编译「选择默认模式」页与「模型配置」页（仅 full 版显示选模式页，
//   纯前端版跳过模型配置页等）。
//
// 调用方式：node scripts/write-edition-nsh.cjs <frontend|integrated|full>
// 注：pack:frontend / pack:integrated / pack:full 脚本已各自先调用本脚本。
// ============================================================================
const fs = require("fs");
const path = require("path");

const VALID = ["frontend", "integrated", "full"];
const arg = (process.argv[2] || "integrated").toLowerCase();

if (!VALID.includes(arg)) {
  console.error(`[write-edition-nsh] ✗ 非法 edition: "${arg}"，应为 ${VALID.join(" / ")}`);
  process.exit(1);
}

const buildResourcesDir = path.resolve(__dirname, "..", "build-resources");
if (!fs.existsSync(buildResourcesDir)) {
  fs.mkdirSync(buildResourcesDir, { recursive: true });
}

const outPath = path.join(buildResourcesDir, "edition.nsh");
// 同时输出 EDITION 字符串与 EDITION_<UPPER> 标志位：installer.nsh 优先用 !ifdef 标志位
// 做 edition 分支（比 !if 字符串比较更稳健，避免 NSIS 引号匹配的细微差异）。
const content =
  `# 本文件由 scripts/write-edition-nsh.cjs 自动生成，请勿手动编辑。\n` +
  `# 打包时通过 PACKAGE_EDITION 决定具体版本（frontend / integrated / full）。\n` +
  `!define EDITION "${arg}"\n` +
  `!define EDITION_${arg.toUpperCase()}\n`;

fs.writeFileSync(outPath, content, "utf-8");
console.log(`[write-edition-nsh] ✓ 已写入 ${outPath} (EDITION="${arg}")`);
