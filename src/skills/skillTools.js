// src/skills/skillTools.js
// 技能绑定的「可调用工具」执行器（与桌宠版 electron/frontend-tools.ts 的
// executeTool 中 skill 分支同语义）。
//
// 两种执行方式（与桌宠版 SkillToolDef.exec 一致）：
//   http   按配置发请求，把响应文本回给模型
//   echo   演示用透传：把参数原样返回（方便用户验证工具链路通不通）
const http = require('http');
const https = require('https');
const { URL } = require('url');

async function runHttp(exec, args) {
    const url = String(exec.url || '').trim();
    if (!url) return 'error: 这个技能工具没配请求地址';
    let u;
    try {
        u = new URL(url);
    } catch {
        return 'error: 请求地址格式不对';
    }
    const method = (exec.method || 'GET').toUpperCase();
    const headers = { ...(exec.headers || {}) };
    let body = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = JSON.stringify(args || {});
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
    } else if (args && Object.keys(args).length) {
        // GET 带参：拼 query
        for (const [k, v] of Object.entries(args)) u.searchParams.set(k, String(v));
    }

    return new Promise((resolve) => {
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(u, { method, headers }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => {
                data += c;
                if (data.length > 500_000) req.destroy();
            });
            res.on('end', () => resolve(data.slice(0, 4000) || `(空响应，HTTP ${res.statusCode})`));
        });
        req.setTimeout(15000, () => {
            req.destroy();
            resolve('error: 请求超时（15 秒）');
        });
        req.on('error', (e) => resolve(`error: ${e.message}`));
        if (body) req.write(body);
        req.end();
    });
}

/**
 * 执行一个技能工具。
 * @param {Object} toolDef SkillToolDef（含 name/exec）
 * @param {Record<string, unknown>} args 模型给的参数
 * @returns {Promise<string>} 纯文本结果（回灌模型）
 */
async function runSkillTool(toolDef, args) {
    const exec = toolDef?.exec;
    if (!exec || !exec.kind) return 'error: 这个技能工具没配执行方式';
    if (exec.kind === 'echo') {
        return JSON.stringify({ tool: toolDef.name, args: args || {} }, null, 2);
    }
    if (exec.kind === 'http') return runHttp(exec, args);
    return `error: 不认识的执行方式 ${exec.kind}`;
}

module.exports = { runSkillTool };
