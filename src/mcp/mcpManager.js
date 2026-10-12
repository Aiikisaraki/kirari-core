// src/mcp/mcpManager.js
// MCP server 配置管理 + 工具注册到内核。
//
// 配置文件：数据目录 mcp-servers.json，与桌宠版 userData/mcp-servers.json 同格式
// （{ servers: McpServerConfig[] }），两端互通（用户拍板：核心版接管桌宠版数据）。
//
// 工具生命周期：配置保存 → 重建连接 → 拉工具清单 → setLocalTools 整体覆盖注册表。
// 这样模型下一轮对话就能看到新工具，不需要重启进程。
const { readJson, writeJsonMerged } = require('../settings/localSettings');
const { McpManager } = require('./mcpClient');
const { setLocalTools, getLocalToolNames } = require('../tools');
const { runSkillTool } = require('../skills/skillTools');

const MCP_FILE = 'mcp-servers.json';
const SKILLS_FILE = 'skills.json';

const MCP_KEYS = ['servers'];
const SKILL_KEYS = ['skills'];

function readMcpServers() {
    const raw = readJson(MCP_FILE);
    const servers = raw && Array.isArray(raw.servers) ? raw.servers : [];
    // 形状校正：坏行跳过（不写回，避免把用户文件改坏）
    return servers.filter(
        (s) =>
            s &&
            typeof s.id === 'string' &&
            s.id.trim() &&
            typeof s.name === 'string' &&
            (s.transport === 'http' ? typeof s.url === 'string' && s.url.trim() : s.transport === 'stdio'),
    );
}

function writeMcpServers(servers) {
    return writeJsonMerged(MCP_FILE, { servers }, MCP_KEYS);
}

function readSkills() {
    const raw = readJson(SKILLS_FILE);
    const skills = raw && Array.isArray(raw.skills) ? raw.skills : [];
    return skills.filter((s) => s && typeof s.id === 'string' && s.id.trim() && typeof s.name === 'string');
}

function writeSkills(skills) {
    return writeJsonMerged(SKILLS_FILE, { skills }, SKILL_KEYS);
}

const manager = new McpManager();
let refreshTimer = null;

/**
 * 重建 MCP 连接 + 汇总「MCP 工具 + 技能工具」→ 注册进内核。
 * 防抖：设置页连续保存时不反复重连。
 */
async function refreshTools({ immediate = false } = {}) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const run = async () => {
        const mcpServers = readMcpServers();
        manager.applyConfig(mcpServers);
        const mcpTools = await manager.collectTools();

        // 技能工具：prompt 型不进工具表（走 system 指令），只有 tools 型才注册
        const skills = readSkills();
        const skillTools = [];
        for (const s of skills) {
            if (s.enabled === false || !Array.isArray(s.tools)) continue;
            for (const t of s.tools) {
                if (!t || typeof t.name !== 'string' || !t.name.trim()) continue;
                skillTools.push({
                    name: `skill__${s.id}__${t.name}`,
                    description: `[技能 ${s.name}] ${t.description || t.name}`,
                    parameters: t.parameters || { type: 'object', properties: {} },
                    execute: async (args) => runSkillTool(t, args),
                });
            }
        }

        const total = setLocalTools([...mcpTools, ...skillTools]);
        console.log(`[mcp] 已注册本地工具 ${total} 个（MCP ${mcpTools.length} + 技能 ${skillTools.length}）`);
        return { total, mcp: mcpTools.length, skill: skillTools.length };
    };
    if (immediate) return run();
    return new Promise((resolve) => {
        refreshTimer = setTimeout(() => resolve(run()), 300);
    });
}

/** 启动时调用一次（失败不影响服务起来）。 */
async function initTools() {
    try {
        await refreshTools({ immediate: true });
    } catch (e) {
        console.warn('[mcp] 初始化工具体系失败（不影响启动）:', e?.message || e);
    }
}

/** 设置页「测试连接」用：只连一个 server，返回工具清单或错误原因。 */
async function probeServer(cfg) {
    const conn = new (require('./mcpClient').McpConnection)(cfg);
    try {
        const tools = await conn.listTools();
        return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description || '' })) };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    } finally {
        conn.close();
    }
}

module.exports = {
    readMcpServers,
    writeMcpServers,
    readSkills,
    writeSkills,
    refreshTools,
    initTools,
    probeServer,
    getLocalToolNames,
    mcpFilePath: () => require('../settings/localSettings').filePath(MCP_FILE),
    skillsFilePath: () => require('../settings/localSettings').filePath(SKILLS_FILE),
};
