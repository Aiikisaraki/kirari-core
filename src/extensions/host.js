// src/extensions/host.js
//
// 核心版（Node 服务）的扩展宿主 —— 与桌宠端 electron/extensions 同一套契约。
//
// 与桌宠端的差别：**进程内直跑，不是 sidecar**。
//   桌宠端把扩展放独立进程，是因为语音栈依赖（onnxruntime / torch）与 Electron ABI 冲突；
//   核心版本来就是 Node 服务，没有 ABI 问题，起子进程纯属浪费。
//   契约层面两者一致：同一份 manifest.json、同一批动词（service.call / capability.call），
//   同一个扩展包目录（~/.kirari/extensions/<pack-id>/，两端共享，装一次两端可用）。
//
// 宿主只认两个通用动词，不认识任何业务。语音包在这里就是 "speech.tts" 这个 id。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXTENSION_API_VERSION = 1;

/** 与桌宠端 manifest.ts 同一套校验规则（这里是 JS 实现）。 */
function parseManifest(raw, dir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  const m = raw;
  const id = String(m.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)) {
    throw new Error('bad extension id: ' + id);
  }
  const version = String(m.version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('bad semver: ' + version);
  }
  const apiVersion = Number(m.apiVersion);
  if (!Number.isFinite(apiVersion)) throw new Error('apiVersion must be a number');
  if (apiVersion > EXTENSION_API_VERSION) {
    throw new Error('pack needs API v' + apiVersion + ', host supports v' + EXTENSION_API_VERSION);
  }
  const engine = m.engine || {};
  if (engine.runtime !== 'sidecar') throw new Error('unsupported runtime: ' + engine.runtime);
  if (engine.protocol !== 'jsonrpc-stdio@1') throw new Error('unsupported protocol: ' + engine.protocol);
  const command = String(engine.command || '');
  if (!command || path.isAbsolute(command) || command.includes('..')) {
    throw new Error('engine.command must be a relative path inside the pack');
  }
  const contributions = Array.isArray(m.contributions)
    ? m.contributions.filter((c) => c && typeof c.id === 'string')
    : [];
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  return { id, name: String(m.name || id), version, apiVersion, engine, contributions, permissions, dir };
}

/** 扫描扩展目录（一层子目录，各自带 manifest.json）。 */
function discover(rootDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    } catch {
      continue; // 没有 manifest 的目录不是扩展包
    }
    try {
      out.push({ manifest: parseManifest(raw, dir), dir, error: null });
    } catch (e) {
      out.push({ manifest: { id: entry.name, name: entry.name, dir }, dir, error: e.message });
    }
  }
  return out;
}

/** 一个已加载的扩展包：持有 sidecar 进程与挂起的 JSON-RPC 请求。 */
class ExtensionProcess {
  constructor(item, logger) {
    this.manifest = item.manifest;
    this.dir = item.dir;
    this.log = logger || console;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.seq = 0;
    this.idleTimer = null;
    this.disposed = false;
    this.lastError = '';
  }

  get packId() {
    return this.manifest.id;
  }

  ensureStarted(timeoutMs = 10000) {
    if (this.disposed) return Promise.reject(new Error('pack unloaded'));
    if (this.child && !this.child.killed) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const engine = this.manifest.engine;
      const commandPath = path.join(this.dir, engine.command);
      // 桌宠端约定 launch=host-node 时用宿主 Node 跑 JS；核心版本身就是 Node，
      // 直接用 process.execPath，与桌宠端行为一致（同一份扩展包两端都能跑）。
      const isHostNode = (engine.launch || 'binary') === 'host-node';
      const child = isHostNode
        ? spawn(process.execPath, [commandPath, ...(engine.args || [])], {
            cwd: this.dir,
            env: { ...process.env, ...(engine.env || {}) },
            stdio: 'pipe',
            windowsHide: true,
          })
        : spawn(commandPath, engine.args || [], {
            cwd: this.dir,
            env: { ...process.env, ...(engine.env || {}) },
            stdio: 'pipe',
            windowsHide: true,
          });

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk) => this.onData(chunk));
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.log.warn('[ext:' + this.packId + '] ' + text);
      });
      child.on('exit', (code) => {
        this.log.warn('[ext] ' + this.packId + ' exited code=' + code);
        this.failAll('extension process exited (' + this.packId + ')');
        this.child = null;
      });
      child.on('error', (err) => {
        this.log.warn('[ext] ' + this.packId + ' spawn failed: ' + err.message);
        this.failAll('extension spawn failed (' + this.packId + ')');
        this.child = null;
        reject(err);
      });

      this.child = child;
      const timer = setTimeout(() => {
        reject(new Error('handshake timeout (' + this.packId + ')'));
      }, timeoutMs);

      this.request('host.hello', {
        apiVersion: this.manifest.apiVersion,
        hostName: 'kirari-core',
        hostVersion: null,
        userDataDir: this.dir,
      })
        .then(() => {
          clearTimeout(timer);
          this.touch();
          resolve();
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
    this.starting = this.starting.finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn('[ext:' + this.packId + '] non-JSON output ignored (log to stderr)');
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || 'extension error'));
      else pending.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs) {
    if (!this.child) return Promise.reject(new Error('extension not ready (' + this.packId + ')'));
    const id = ++this.seq;
    const t = timeoutMs || this.manifest.engine.requestTimeoutMs || 20000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('call timeout (' + method + ')'));
      }, t);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n');
    });
  }

  /** 空闲回收：一段时间没请求就把进程收掉，下次自动拉起。 */
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idle = this.manifest.engine.idleTimeoutMs || 5 * 60 * 1000;
    this.idleTimer = setTimeout(() => this.stop(), idle);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  async callService(serviceId, method, params, timeoutMs) {
    await this.ensureStarted();
    this.touch();
    return this.request('service.call', { serviceId, method, params: params ?? null }, timeoutMs);
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.stdin.end();
    } catch { /* already dead */ }
    setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
    }, 1000);
    this.failAll('extension process closed (' + this.packId + ')');
  }

  failAll(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

/** 扩展宿主。服务按 id 存取；get() 取不到返回 null（调用方走原路径）。 */
class ExtensionHost {
  constructor({ rootDir, logger } = {}) {
    this.rootDir = rootDir;
    this.log = logger || console;
    /** serviceId -> ExtensionProcess。没有包时是空 Map，getService() 恒为 null。 */
    this.services = new Map();
    this.packs = new Map();
  }

  async startAll() {
    const found = discover(this.rootDir);
    for (const item of found) {
      if (item.error) {
        this.log.warn('[ext] ' + item.manifest.id + ' unavailable: ' + item.error);
        continue;
      }
      const proc = new ExtensionProcess(item, this.log);
      try {
        await proc.ensureStarted();
        for (const c of item.manifest.contributions) {
          if (c.type === 'service') {
            if (this.services.has(c.id)) {
              this.log.warn('[ext] service ' + c.id + ' overridden by ' + proc.packId);
            }
            this.services.set(c.id, proc);
          }
        }
        this.packs.set(proc.packId, proc);
        this.log.info('[ext] loaded ' + proc.packId + '@' + item.manifest.version);
      } catch (e) {
        this.log.warn('[ext] ' + proc.packId + ' start failed: ' + e.message);
      }
    }
    return this.status();
  }

  has(serviceId) {
    return this.services.has(serviceId);
  }

  get(serviceId) {
    return this.services.get(serviceId) || null;
  }

  /** 取一个「可 await 方法」的服务对象；没有扩展提供时返回 null。 */
  getService(serviceId) {
    const proc = this.services.get(serviceId);
    if (!proc) return null;
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
        return (...args) => proc.callService(serviceId, prop, { args });
      },
    });
  }

  status() {
    return [...this.packs.values()].map((p) => ({
      packId: p.packId,
      name: p.manifest.name,
      version: p.manifest.version,
      running: !!p.child,
      error: p.lastError,
      contributions: p.manifest.contributions,
      permissions: p.manifest.permissions || [],
    }));
  }

  dispose() {
    for (const p of this.packs.values()) p.stop();
    this.packs.clear();
    this.services.clear();
  }
}

// ── 单例（与桌宠端 setExtensionHost/getExtensionHost 同一约定）──────────
let currentHost = null;

function setExtensionHost(host) {
  currentHost = host;
}

function getExtensionHost() {
  return currentHost;
}

function getService(serviceId) {
  return currentHost ? currentHost.getService(serviceId) : null;
}

module.exports = {
  EXTENSION_API_VERSION,
  ExtensionHost,
  ExtensionProcess,
  discover,
  parseManifest,
  setExtensionHost,
  getExtensionHost,
  getService,
};
