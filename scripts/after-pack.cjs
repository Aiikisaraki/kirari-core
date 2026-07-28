#!/usr/bin/env node
// ============================================================================
// after-pack.cjs — electron-builder afterPack 钩子
//
// 问题背景：
//   electron-builder 的 extraResources 有一套内置默认排除规则（DEFAULT_FILE_MAC_SRC_IGNORE），
//   会强制忽略 node_modules —— 与源目录 .gitignore 是否包含 node_modules 无关。
//   因此即便 prepack 脚本把含 node_modules 的完整后端复制到 build-resources/pet-api-bundle/
//   并修改了其中的 .gitignore，electron-builder 仍会在 extraResources 阶段把 node_modules 排除，
//   导致打包产物 resources/pet-api/ 缺少依赖 → 后端无法启动。
//
// 解决方案：
//   在 electron-builder 完成文件复制之后（afterPack），手动把源 pet-api 的 node_modules
//   强制复制进输出目录的 resources/pet-api/node_modules。
//   这一步发生在打包复制之后、asar 归档/安装包生成之前，因此不受 extraResources 的排除规则影响。
//   注：node_modules 不进 prepack 的 staging（体积大且会被排除），直接从源目录读取更可靠。
// ============================================================================
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== "win32") {
    // 当前仅支持 Windows 打包；其他平台可在此扩展
    return;
  }

  const projectRoot = path.resolve(__dirname, "..");
  // 源后端依赖目录：与 prepack 的 PET_API_DIR 保持一致。
  // 本地开发：项目根的上两级 -> pet-api；CI：PET_API_SOURCE_DIR 指向克隆的 kirari-core。
  const srcModules = process.env.PET_API_SOURCE_DIR
    ? path.resolve(path.resolve(process.env.PET_API_SOURCE_DIR), "node_modules")
    : path.resolve(projectRoot, "..", "..", "pet-api", "node_modules");
  const destDir = path.join(appOutDir, "resources", "pet-api", "node_modules");

  if (!fs.existsSync(srcModules)) {
    console.error("[afterPack] ✗ 找不到源后端依赖:", srcModules);
    console.error("[afterPack] 请先在源后端执行: cd D:/personal-proj/pet-api && npm install");
    process.exit(1);
  }

  console.log("[afterPack] 强制复制后端依赖 node_modules ...");
  console.log(`  from: ${srcModules}`);
  console.log(`  to:   ${destDir}`);

  // 若 electron-builder 残留了空/部分 node_modules 目录，先清理再整体复制
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcModules, destDir, { recursive: true, dereference: true });

  // 验证复制结果
  const count = countDirEntries(destDir);
  console.log(`[afterPack] ✓ 后端依赖已复制 (node_modules 含 ${count} 个顶层条目)`);
};

function countDirEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return "?";
  }
}
