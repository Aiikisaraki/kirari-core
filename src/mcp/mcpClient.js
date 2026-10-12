// src/mcp/mcpClient.js
// MCP（Model Context Protocol）客户端：核心版直连 MCP server，把它的工具
// 注册进内核工具表（mcp__<serverId>__<toolName>），模型调用时由核心版就地执行。
//
// 为什么核心版要自己连：桌宠版里 MCP 连接跑在 Electron 主进程，工具以
// frontend__ 前缀经 WS 回调解前端执行。核心版（控制台 / 服务器部署）没有
// Electron 前端，所以必须自己实现客户端 —— 用户拍板「MCP 搬进核心版」。
//
// 支持两种 transport（与桌宠版 McpTransport 一致）：
//   http    Streamable HTTP（2024-11-05 spec）：POST {jsonrpc, method, params}
//   stdio   子进程：按行读写 JSON-RPC
//
// MCP 协议最小必要子集：initialize → tools/list → tools/call。
// 握手拿到的 session id（响应头 mcp-session-id）后续请求都要带。
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'kirari-core', version: '1.0.0' };

/** 单个 MCP server 的连接句柄（懒连接、断开可重连）。 */
class McpConnection {
    constructor(cfg) {
        this.cfg = cfg; // { id, name, transport, url?, command?, args?, enabled }
        this.sessionId = null;
        this.nextId = 1;
        this.proc = null;
        this.buffer = '';
        this.pending = new Map(); // id -> { resolve, reject }
        this.initialized = false;
        this.tools = [];
    }

    get key() {
        return this.cfg.id;
    }

    // ── http transport ────────────────────────────────────────────────

    httpPost(payload, timeout = 15000) {
        return new Promise((resolve, reject) => {
            let u;
            try {
                u = new URL(this.cfg.url);
            } catch {
                return reject(new Error('MCP 地址格式不对'));
            }
            if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('只支持 http/https'));
            const mod = u.protocol === 'https:' ? https : http;
            const body = JSON.stringify(payload);
            const headers = {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body),
            };
            if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
            const req = mod.request(
                u,
                { method: 'POST', headers },
                (res) => {
                    const sid = res.headers['mcp-session-id'];
                    if (sid) this.sessionId = sid;
                    let data = '';
                    res.setEncoding('utf-8');
                    res.on('data', (c) => (data += c));
                    res.on('end', () => {
                        // 可能是裸 JSON，也可能是 SSE（event: message\ndata: {...}）
                        const json = extractJson(data);
                        if (!json) return reject(new Error(`MCP 响应无法解析（HTTP ${res.statusCode}）`));
                        resolve(json);
                    });
                },
            );
            req.setTimeout(timeout, () => req.destroy(new Error('MCP 请求超时')));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    // ── stdio transport ───────────────────────────────────────────────

    ensureProc() {
        if (this.proc) return;
        const cmd = String(this.cfg.command || '').trim();
        if (!cmd) throw new Error('stdio 型 MCP 没配启动命令');
        const args = Array.isArray(this.cfg.args) ? this.cfg.args.map(String) : [];
        this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdout.setEncoding('utf-8');
        this.proc.stdout.on('data', (chunk) => this.onStdoutData(chunk));
        this.proc.stderr.on('data', () => {
            /* MCP server 的 stderr 日志对调用方无意义，吞掉避免刷屏 */
        });
        this.proc.on('exit', (code) => {
            this.proc = null;
            this.initialized = false;
            this.sessionId = null;
            for (const [, p] of this.pending) p.reject(new Error(`MCP 进程退出（${code}）`));
            this.pending.clear();
        });
    }

    onStdoutData(chunk) {
        this.buffer += chunk;
        // MCP stdio 用「换行分隔的 JSON」（不是 LSP 那种 Content-Length 头）
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message || 'MCP 错误'));
                else p.resolve(msg.result);
            }
        }
    }

    /** stdio 输出按行分帧后派发（绑定在 ensureProc，见 this.onStdoutData）。 */
    onStdioData(chunk) {
        this.onStdoutData(chunk);
    }

    stdioCall(method, params, timeout = 15000) {
        this.ensureProc();
        const id = this.nextId++;
        const payload = { jsonrpc: '2.0', id, method, params: params || {} };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('MCP 请求超时'));
            }, timeout);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            try {
                this.proc.stdin.write(JSON.stringify(payload) + '\n');
            } catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    // ── 统一入口 ──────────────────────────────────────────────────────

    async rpc(method, params, timeout) {
        if (this.cfg.transport === 'stdio') return this.stdioCall(method, params, timeout);
        return this.httpPost({ jsonrpc: '2.0', id: this.nextId++, method, params: params || {} }, timeout);
    }

    async connect() {
        if (this.initialized) return;
        await this.rpc(
            'initialize',
            { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
            10000,
        );
        // initialize 之后必须回一个 notifications/initialized，否则部分 server 不认后续请求
        if (this.cfg.transport === 'stdio') {
            this.ensureProc();
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        } else {
            // http 型：空 params 的通知，服务器可能不回响应 —— 不 await
            this.httpPost({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => {});
        }
        this.initialized = true;
    }

    async listTools() {
        await this.connect();
        const res = await this.rpc('tools/list', {}, 10000);
        this.tools = Array.isArray(res?.tools) ? res.tools : [];
        return this.tools;
    }

    async callTool(name, args) {
        await this.connect();
        const res = await this.rpc('tools/call', { name, arguments: args || {} }, 30000);
        // MCP 规定结果是 content 数组；拼成纯文本喂给模型
        const content = Array.isArray(res?.content) ? res.content : [];
        const text = content
            .map((c) => (c?.type === 'text' ? c.text : c?.type === 'resource' ? JSON.stringify(c.resource) : JSON.stringify(c)))
            .filter(Boolean)
            .join('\n');
        if (res?.isError) return `error: ${text || 'MCP 工具执行失败'}`;
        return text || '(无返回内容)';
    }

    close() {
        if (this.proc) {
            try {
                this.proc.kill();
            } catch {
                /* 已退出 */
            }
            this.proc = null;
        }
        this.initialized = false;
        this.sessionId = null;
        this.tools = [];
    }
}

/** 从裸 JSON 或 SSE 帧里抠出 JSON-RPC 对象。 */
function extractJson(raw) {
    const t = String(raw || '').trim();
    if (!t) return null;
    if (t.startsWith('{')) {
        try {
            return JSON.parse(t);
        } catch {
            /* 继续按 SSE 试 */
        }
    }
    // SSE：取最后一个 data: 行
    const lines = t.split('\n').map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('data:')) {
            try {
                return JSON.parse(lines[i].slice(5).trim());
            } catch {
                /* 跳过坏帧 */
            }
        }
    }
    return null;
}

// ── 多 server 管理 ────────────────────────────────────────────────────

class McpManager {
    constructor() {
        /** @type {Map<string, McpConnection>} */
        this.conns = new Map();
    }

    /** 按配置整表重建连接（配置变了就重连，与 setLocalTools 的整体覆盖语义一致）。 */
    applyConfig(servers) {
        for (const [, c] of this.conns) c.close();
        this.conns.clear();
        for (const s of Array.isArray(servers) ? servers : []) {
            if (!s || s.enabled === false) continue;
            this.conns.set(s.id, new McpConnection(s));
        }
    }

    /** 拉起所有 server 的工具清单，转成内核可注册的本地工具。失败不致命。 */
    async collectTools() {
        const out = [];
        for (const [id, conn] of this.conns) {
            try {
                const tools = await conn.listTools();
                for (const t of tools) {
                    if (!t?.name) continue;
                    out.push({
                        name: `mcp__${id}__${t.name}`,
                        description: `[MCP ${conn.cfg.name || id}] ${t.description || t.name}`,
                        parameters: t.inputSchema || { type: 'object', properties: {} },
                        execute: async (args) => conn.callTool(t.name, args),
                    });
                }
            } catch (e) {
                console.warn(`[mcp] server ${id} 连接失败（已跳过）:`, e?.message || e);
            }
        }
        return out;
    }

    closeAll() {
        for (const [, c] of this.conns) c.close();
        this.conns.clear();
    }
}

module.exports = { McpManager, McpConnection };
