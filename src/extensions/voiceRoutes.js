// src/extensions/voiceRoutes.js
//
// 核心版语音扩展的 HTTP 端点：音色库列表 / 下载 / 删除 / 进度。
// 挂在 requireAdmin 之下 —— 下载会写磁盘，不能匿名调用。
//
// 与桌宠端 voiceLibrary.ts 同一套逻辑（JS 版）：
//   · 清单内置（voices.catalog.json 同源）
//   · 多源依次尝试（GitHub → hf-mirror）
//   · .tmp- 临时文件 + BZh 魔数校验 + bsdtar 解压 + 原子改名
//   · 手动放置：voices/ 下丢个带 .onnx 的目录即可，列表里标 manual

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getExtensionHost } = require("./host");

const CATALOG = [
  {
    id: "aishell3",
    name: "AISHELL3 · 174 个中文音色",
    sizeBytes: 31559701,
    sources: [
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2",
      "https://hf-mirror.com/k2-fsa/sherpa-onnx/resolve/main/tts-models/vits-icefall-zh-aishell3.tar.bz2",
    ],
    license: "模型基于 AISHELL3 数据集（Apache 2.0）；引擎 Apache-2.0",
    description: "多说话人中文语音库，男女声都有，换音色不换模型。",
  },
  {
    id: "huayan",
    name: "花燕 · 单音色女声",
    sizeBytes: 67217000,
    sources: [
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-huayan-medium.tar.bz2",
      "https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
    ],
    license: "模型训练集许可未明确（HuaYan TTS），个人使用无碍，商用前自行确认",
    description: "Piper 中文女声，自然度不错，但只有这一个音色。",
  },
];

const DEFAULT_PACK = "com.akisaki.voice.aishell3";
const activeDownloads = new Map();
let lastProgress = "";

function resolvePackDir(packId = DEFAULT_PACK) {
  const host = getExtensionHost();
  if (!host) return null;
  const found = require("./host").discover(host.rootDir);
  const hit = found.find((f) => f.manifest && f.manifest.id === packId && !f.error);
  return hit ? hit.dir : null;
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/** 已安装判断：voices/<id> 存在且有 .onnx（下载中的 .tmp- 目录不算）。 */
function scanInstalled(voicesDir) {
  const installed = new Set();
  if (!voicesDir || !fs.existsSync(voicesDir)) return installed;
  for (const e of fs.readdirSync(voicesDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".tmp-")) continue;
    try {
      if (fs.readdirSync(path.join(voicesDir, e.name)).some((f) => f.endsWith(".onnx"))) {
        installed.add(e.name);
      }
    } catch { /* 目录刚好被删 */ }
  }
  return installed;
}

function listVoiceLibs() {
  const packDir = resolvePackDir();
  const voicesDir = packDir ? path.join(packDir, "voices") : null;
  const installed = scanInstalled(voicesDir);
  const out = [];
  for (const lib of CATALOG) {
    const isInstalled = installed.has(lib.id);
    installed.delete(lib.id);
    out.push({
      ...lib,
      installed: isInstalled,
      ...(isInstalled && voicesDir ? { installedBytes: dirSize(path.join(voicesDir, lib.id)) } : {}),
    });
  }
  for (const id of installed) {
    out.push({
      id,
      name: id + "（手动放置）",
      sizeBytes: 0,
      license: "",
      description: "本地手动放入的音色库",
      installed: true,
      manual: true,
      ...(voicesDir ? { installedBytes: dirSize(path.join(voicesDir, id)) } : {}),
    });
  }
  return out;
}

/**
 * 下载一个音色库（Node 18+ 全局 fetch + 流式读取）。
 * 进度写 lastProgress，前端轮询 /api/extensions/voices/progress。
 */
async function downloadVoiceLib(libId) {
  const key = DEFAULT_PACK + "/" + libId;
  if (activeDownloads.has(key)) return { ok: false, error: "这个音色库已经在下载中了" };
  const lib = CATALOG.find((l) => l.id === libId);
  if (!lib) return { ok: false, error: "清单里没有这个音色库：" + libId };

  const packDir = resolvePackDir();
  if (!packDir) return { ok: false, error: "语音扩展包未安装" };
  const voicesDir = path.join(packDir, "voices");
  const targetDir = path.join(voicesDir, libId);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).some((f) => f.endsWith(".onnx"))) {
    return { ok: false, error: "这个音色库已经安装了" };
  }

  fs.mkdirSync(voicesDir, { recursive: true });
  const tmpArchive = path.join(voicesDir, ".tmp-" + libId + "-" + Date.now() + ".tar.bz2");
  const active = { cancelled: false };
  activeDownloads.set(key, active);
  const report = (msg) => { lastProgress = msg; console.log("[voice] " + libId + ": " + msg); };

  try {
    let ok = false;
    let lastErr = "";
    for (const url of lib.sources) {
      if (active.cancelled) return { ok: false, error: "已取消" };
      try {
        report("连接 " + new URL(url).host + "…");
        // 连接/首字节超时 20s：被墙的源会 TCP 半开挂死，必须主动掐断换下一个源
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        const total = Number(res.headers.get("content-length") || lib.sizeBytes);
        const chunks = [];
        let downloaded = 0;
        let lastPct = -1;
        const reader = res.body.getReader();
        for (;;) {
          if (active.cancelled) {
            await reader.cancel();
            return { ok: false, error: "已取消" };
          }
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          downloaded += value.byteLength;
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              report("下载 " + pct + "%（" + (downloaded / 1024 / 1024).toFixed(1) + "MB）");
            }
          }
        }
        const buf = Buffer.concat(chunks);
        if (buf.length < 1024 * 1024) throw new Error("下载不完整（" + buf.length + " 字节）");
        if (buf.toString("ascii", 0, 3) !== "BZh") throw new Error("不是合法的 tar.bz2 文件");
        fs.writeFileSync(tmpArchive, buf);
        ok = true;
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        console.warn("[voice] 源失败 " + url + "：" + lastErr);
      }
    }
    if (!ok) return { ok: false, error: "下载失败：" + lastErr };

    report("解压中…");
    const tmpExtract = path.join(voicesDir, ".tmp-" + libId + "-x");
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.mkdirSync(tmpExtract, { recursive: true });
    const extractCode = await new Promise((resolve) => {
      const ex = spawn("tar", ["-xjf", tmpArchive, "-C", tmpExtract], { windowsHide: true });
      ex.on("close", (code) => resolve(code ?? -1));
      ex.on("error", () => resolve(-1));
    });
    if (extractCode !== 0) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return { ok: false, error: "解压失败（exit " + extractCode + "）" };
    }

    const inner = fs.readdirSync(tmpExtract, { withFileTypes: true });
    const subDirs = inner.filter((e) => e.isDirectory());
    const sourceDir = subDirs.length === 1 ? path.join(tmpExtract, subDirs[0].name) : tmpExtract;
    if (!fs.readdirSync(sourceDir).some((f) => f.endsWith(".onnx"))) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return { ok: false, error: "解压后没找到 .onnx 模型文件" };
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(sourceDir, targetDir);
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    fs.rmSync(tmpArchive, { force: true });
    report("完成");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    activeDownloads.delete(key);
    try { fs.rmSync(tmpArchive, { force: true }); } catch { /* 已清理 */ }
  }
}

function removeVoiceLib(libId) {
  if (typeof libId !== "string" || libId.includes("..") || path.isAbsolute(libId)) {
    return { ok: false, error: "非法的库 id" };
  }
  const packDir = resolvePackDir();
  if (!packDir) return { ok: false, error: "语音扩展包未安装" };
  const target = path.join(packDir, "voices", libId);
  if (!fs.existsSync(target)) return { ok: false, error: "这个音色库不存在" };
  fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
}

/** 把语音相关端点挂到 express app 上（setupHttpRoutes 内调用）。 */
function setupVoiceRoutes(app) {
  // 已安装扩展提供的服务 id（与桌宠端 ext:installed 同契约）——
  // 前端据此决定是否显示 requiresExtension 的设置页（语音/B站…）。
  app.get("/api/extensions/installed", (_req, res) => {
    try {
      const host = require('./host').getExtensionHost();
      const packs = host ? host.status().map((p) => ({ packId: p.packId, contributions: p.contributions || [] })) : [];
      const serviceIds = [];
      for (const p of packs) for (const c of (p.contributions || [])) if (c.type === 'service' && c.id) serviceIds.push(c.id);
      return res.json({ ok: true, packs, serviceIds });
    } catch (e) { return res.status(500).json({ ok: false, message: e?.message || '读取失败' }); }
  });

  app.get("/api/extensions/voices", async (_req, res) => {
    try {
      return res.json({ ok: true, libs: listVoiceLibs() });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e?.message || "读取失败" });
    }
  });

  app.post("/api/extensions/voices/:libId/download", async (req, res) => {
    const result = await downloadVoiceLib(String(req.params.libId || ""));
    return res.json(result);
  });

  app.delete("/api/extensions/voices/:libId", (req, res) => {
    return res.json(removeVoiceLib(String(req.params.libId || "")));
  });

  app.get("/api/extensions/voices/progress", (_req, res) => {
    return res.json({ progress: lastProgress });
  });
}

module.exports = { setupVoiceRoutes, listVoiceLibs, downloadVoiceLib, removeVoiceLib };

