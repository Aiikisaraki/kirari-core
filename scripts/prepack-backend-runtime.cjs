#!/usr/bin/env node
// ============================================================================
// prepack-backend-runtime.cjs
// 打包前自动把「当前运行的 Node 运行时」复制进 build-resources/backend-runtime/，
// 由 electron-builder 的 extraResources 一并打进 resources/pet-api/runtime，
// 使单机安装包自包含 —— 用户机无需预先安装 Node 即可运行本地后端 pet-api。
//
// 路径约定（与 electron-builder.yml / backend-launcher.ts 保持一致）：
//   - 本项目根: akuari-kirari/  (__dirname 的上一级)
//   - 后端目录: ../../pet-api   (即 D:/personal-proj/pet-api)
//   - 运行时落盘: build-resources/backend-runtime/node(.exe)
//       -> extraResources -> resources/pet-api/runtime/node(.exe)
//       -> backend-launcher.resolveNodeBin 读取
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
// 后端目录：默认 ../.. /pet-api（本地开发布局）。
// CI 中通过 PET_API_SOURCE_DIR 覆盖为克隆下来的 kirari-core 仓库路径。
const PET_API_DIR = process.env.PET_API_SOURCE_DIR
  ? path.resolve(process.env.PET_API_SOURCE_DIR)
  : path.resolve(PROJECT_ROOT, "..", "..", "pet-api");
const TARGET_DIR = path.join(PROJECT_ROOT, "build-resources", "backend-runtime");
// 后端 staging 目录：electron-builder 的 extraResources 从这里打包后端（含 node_modules）。
// 直接从 pet-api 复制会被其 .gitignore 排除 node_modules，导致打包后缺少依赖。
const PET_API_STAGING_DIR = path.join(PROJECT_ROOT, "build-resources", "pet-api-bundle");
const isWin = process.platform === "win32";
const runtimeName = isWin ? "node.exe" : "node";

// 复制并校验退出码
let failed = false;
function fatal(msg) {
  console.error("[prepack] ✗ " + msg);
  failed = true;
}
function info(msg) {
  console.log("[prepack] " + msg);
}

function resolveNodeVersion(binPath) {
  try {
    return String(execSync(`"${binPath}" --version`, { windowsHide: true })).trim();
  } catch {
    return null;
  }
}

// 直接用「应用实际加载的那个 .node 文件」做 ABI 校验。
// 注意：不能用 require('better-sqlite3')（包入口）——实测它会走 lib/index.js 的
// 解析/缓存而误报成功，导致跳过重建。应用运行时真正 dlopen 的就是
// build/Release/better_sqlite3.node 这一个文件，直接 require 它最准确。
// 关键：必须用 execFileSync 数组形式（不经 shell），否则 Windows 下 cmd 会破坏
// 嵌套在 -e 参数里的引号/反斜杠，导致误报加载失败（已踩坑）。
function betterSqliteNodeBinary() {
  return path.join(PET_API_DIR, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
}
function canLoadBetterSqlite(nodeBin) {
  const bs = betterSqliteNodeBinary();
  if (!fs.existsSync(bs)) return false;
  try {
    execFileSync(nodeBin, ["-e", `require(${JSON.stringify(bs)})`], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

// 寻找与打包 Node 配套的 npm-cli.js（用于重建原生模块）。
function findNpmCli(nodeBin) {
  const nodeDir = path.dirname(nodeBin);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// 用「基准 Node」重建 pet-api 原生模块，使其 ABI 与运行时一致。
// 关键：把基准 Node 所在目录前置到 PATH，再调用 npm，确保 npm.cmd 用基准 Node 运行，
// 而不是脚本自身所在的 Node（二者可能不同，正是之前 ABI 错位的根因）。
function rebuildPetApiNative(nodeBin) {
  const nodeDir = path.dirname(nodeBin);
  // 基准 Node 目录前置到 PATH，确保 npm.cmd 解析到基准 Node 配套的 npm
  const env = { ...process.env, PATH: nodeDir + path.delimiter + (process.env.PATH || "") };
  const tryRebuild = (extra) => {
    try {
      info(`正在用基准 Node(${nodeBin}) 重建 better-sqlite3${extra ? "（源码编译）" : ""}...`);
      execSync(`npm rebuild better-sqlite3${extra}`, {
        cwd: PET_API_DIR,
        env,
        stdio: "inherit",
        windowsHide: true,
        shell: true,
      });
      return true;
    } catch {
      return false;
    }
  };
  // 先尝试预编译二进制（免 VS 工具链），失败再源码编译
  return tryRebuild("") || tryRebuild(" --build-from-source");
}

// ============================================================================
// 后端完整打包（含 node_modules）staging
// electron-builder 的 extraResources 会尊重源目录的 .gitignore，
// pet-api/.gitignore 包含 node_modules → 导致依赖被排除。
// 解决方案：把 pet-api（含 node_modules）复制到 staging 目录，
// 在 staging 中清理 .gitignore 对 node_modules 的排除，
// extraResources 改为从 staging 打包。
// ============================================================================
function stagePetApiBundle() {
  info("正在准备后端完整 bundle（含 node_modules）...");

  // 清理旧的 staging
  if (fs.existsSync(PET_API_STAGING_DIR)) {
    fs.rmSync(PET_API_STAGING_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PET_API_STAGING_DIR, { recursive: true });

  // 复制 pet-api 全部内容（含 node_modules，fs.cpSync 不受 gitignore 影响）
  info(`复制 ${PET_API_DIR} -> ${PET_API_STAGING_DIR}（源码+配置；node_modules 由 afterPack 注入）...`);
  const dataDir = path.join(PET_API_DIR, "data");
  try {
    fs.cpSync(PET_API_DIR, PET_API_STAGING_DIR, {
      recursive: true,
      dereference: true,      // 解析符号链接
      filter: (src) => {
        const basename = path.basename(src);
        // 安全/隐私与无关文件：绝不允许打进安装包
        //   .env            —— 含开发者自己的大模型 key / 连接配置
        //   data/           —— sqlite 数据库（含已配置的 token、聊天记录）
        //   *.md            —— 项目文档（README / PORTREADME 等），非运行所需
        //   .claude/.lingma —— AI 助手工作区，与分发无关
        //   .github         —— CI 配置
        //   .git            —— 版本历史
        //   *.log           —— 运行日志
        if (basename === ".env") return false;
        if (src === dataDir) return false;
        if (basename === ".claude" || basename === ".lingma" || basename === ".github") return false;
        if (basename === ".git") return false;
        // node_modules 不进 staging：体积大且会在打包阶段被 electron-builder 排除，
        // 改由 afterPack 钩子直接从源 pet-api/node_modules 注入（见 after-pack.cjs）。
        if (basename === "node_modules") return false;
        if (basename.endsWith(".md") && fs.statSync(src).isFile()) return false;
        if (basename.endsWith(".log") && fs.statSync(src).isFile()) return false;
        return true;
      },
    });
  } catch (e) {
    fatal(`复制后端到 staging 失败：${e.message}`);
    process.exit(1);
  }

  // 确保 staging 内的 .gitignore 不排除 node_modules（保险；node_modules 实际由 afterPack 注入）
  const stagingGitignore = path.join(PET_API_STAGING_DIR, ".gitignore");
  if (fs.existsSync(stagingGitignore)) {
    let content = fs.readFileSync(stagingGitignore, "utf-8");
    content = content.replace(/^\s*node_modules\s*$/gm, "# node_modules (injected by afterPack from source)");
    fs.writeFileSync(stagingGitignore, content, "utf-8");
    info("已修改 staging/.gitignore：node_modules 交由 afterPack 注入。");
  }

  // 验证关键文件（node_modules 不在此列，由 afterPack 从源 pet-api 注入）
  const checks = [
    ["server.js", path.join(PET_API_STAGING_DIR, "server.js")],
    ["src/app.js", path.join(PET_API_STAGING_DIR, "src", "app.js")],
  ];
  for (const [label, p] of checks) {
    if (!fs.existsSync(p)) {
      fatal(`staging 缺少关键文件: ${label} (${p})`);
      process.exit(1);
    }
  }

  info(`后端 bundle 已就绪: ${PET_API_STAGING_DIR}（源码 + 配置；node_modules 由 afterPack 注入）`);
}

function countFiles(dir) {
  try {
    let c = 0;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        // 只遍历前两层避免太慢（node_modules 很深）
        if (c > 100) return `${c}+`;
        try {
          const sub = fs.readdirSync(path.join(dir, item.name), { withFileTypes: true });
          c += sub.length;
        } catch { /* 权限等问题跳过 */ }
      } else {
        c++;
      }
    }
    return c;
  } catch { return "?"; }
}

function main() {
  info("准备打包后端 Node 运行时...");

  // 1) 源必须是 node 可执行文件，不能在 electron 进程内运行本脚本
  const srcNode = process.execPath;
  const base = path.basename(srcNode).toLowerCase();
  if (base !== "node.exe" && base !== "node") {
    fatal(`当前可执行文件不是 node（${srcNode}）。请使用普通 node 执行打包脚本，` +
      `不要通过 electron 运行。`);
    process.exit(1);
  }

  // 2) 后端依赖必须已安装（含原生模块 better-sqlite3 / sqlite3）
  const petApiModules = path.join(PET_API_DIR, "node_modules");
  if (!fs.existsSync(petApiModules)) {
    fatal(`未找到后端依赖目录：${petApiModules}`);
    fatal(`请先在后端项目执行安装（务必使用与打包相同的 Node 版本）：`);
    fatal(`  cd ${PET_API_DIR} && npm install`);
    process.exit(1);
  }

  // 2.5) 确定「基准 Node」：优先沿用已打包进 backend-runtime 的 Node，
  //       这样无论用哪个 Node 跑构建，runtime 与重建 Node 都保持一致，避免版本来回跳。
  //       若 backend-runtime 尚不存在（首次构建），则使用运行本脚本的 Node。
  const destForProbe = path.join(TARGET_DIR, runtimeName);
  const shipNode = fs.existsSync(destForProbe) ? destForProbe : srcNode;

  // 3) ABI 对齐：必须用「基准 Node」做校验与重建。
  //    否则会出现「运行时是 X、原生模块是按 Y 编译」的 NODE_MODULE_VERSION 错位，
  //    导致后端一启动就崩溃（正是此前连接异常的根因）。
  //    设置 FORCE_PET_API_REBUILD=1 可跳过检测、强制重建（检测偶发误判时使用）。
  const forceRebuild = process.env.FORCE_PET_API_REBUILD === "1";
  if (!forceRebuild && canLoadBetterSqlite(shipNode)) {
    info(`pet-api 原生模块与基准 Node(${shipNode}) ABI 已匹配，无需重建。`);
  } else {
    info(`pet-api 原生模块 ABI 与基准 Node 不匹配，尝试自动重建...`);
    rebuildPetApiNative(shipNode);
    if (canLoadBetterSqlite(shipNode)) {
      info("重建成功，原生模块现已匹配基准 Node。");
    } else {
      fatal("重建后仍无法加载 better-sqlite3。请手动在后端目录执行：");
      fatal(`  cd ${PET_API_DIR} && npm rebuild better-sqlite3`);
      fatal("若提示缺少编译工具，请安装对应 Node 版本的预编译二进制，或安装 Visual Studio“使用 C++ 的桌面开发”工作负载。");
      process.exit(1);
    }
  }

  // 4) 确保目标目录存在并复制基准 Node
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }
  const dest = path.join(TARGET_DIR, runtimeName);

  // 已存在且与基准 Node 版本一致则跳过复制，否则覆盖（保证与重建 Node 完全一致）
  let skip = false;
  if (fs.existsSync(dest)) {
    const existingVer = resolveNodeVersion(dest);
    const shipVer = resolveNodeVersion(shipNode);
    if (existingVer && shipVer && existingVer === shipVer) {
      info(`目标已存在相同版本 ${shipVer}，跳过复制。`);
      skip = true;
    } else {
      info(`目标版本 ${existingVer || "(未知)"} 与基准 ${shipVer || "(未知)"} 不一致，将覆盖。`);
    }
  }

  if (!skip) {
    try {
      fs.copyFileSync(shipNode, dest);
      // POSIX 下确保可执行位
      if (!isWin) fs.chmodSync(dest, 0o755);
      info(`已复制 ${shipNode} -> ${dest}`);
    } catch (e) {
      fatal(`复制 Node 运行时失败：${e.message}`);
      process.exit(1);
    }
  }

  // 5) 输出版本 / ABI 信息，并给出原生模块匹配的强提示
  const shipVer = resolveNodeVersion(shipNode);
  const abi = (() => {
    try {
      return String(execFileSync(shipNode, ["-p", "process.versions.modules"], { windowsHide: true })).trim();
    } catch {
      return "?";
    }
  })();
  info(`基准 Node 版本: ${shipVer}  (ABI NODE_MODULE_VERSION=${abi})`);
  info(`pet-api 原生模块（better-sqlite3）已按该 ABI 重建并校验通过。`);

  if (failed) process.exit(1);
  info("Node 运行时准备完成。");

  // 6) 打包后端完整 bundle（含 node_modules）到 staging 目录
  stagePetApiBundle();

  info("全部完成。可继续打包（npm run dist）。");
}

main();
