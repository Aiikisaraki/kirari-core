// src/mcp/mcpManager.js
// MCP server 配置管理 + 工具注册到内核。
//
// 配置文件：数据根的 **mcp.json**（标准格式 `{ "mcpServers": { "<名>": {...} } }`），
// 与 Claude Code / codebuddy / WorkBuddy 完全同格式 —— 用户的 MCP 配置在三者之间
// 可以直接互拷，不需要手工转换。内部仍用带 id/transport 的结构（连接池按 id 建索引），
// 边界转换集中在 src/mcp/standardMcp.js 一处。
//
// 旧版 mcp/servers.json（`{ servers: [...] }`）首次启动会被读进来转成标准格式，
// 原文件改名留档（.migrated-<时间戳>.bak），不直接删。
//
// 工具生命周期：配置保存 → 重建连接 → 拉工具清单 → setLocalTools 整体覆盖注册表。
// 这样模型下一轮对话就能看到新工具，不需要重启进程。
const fs = require('fs');
const path = require('path');
const { writeJsonMerged } = require('../settings/localSettings');
const { McpManager } = require('./mcpClient');
const { setLocalTools, getLocalToolNames } = require('../tools');
const { runSkillTool } = require('../skills/skillTools');
const standard = require('./standardMcp');
const { paths: HOME_PATHS } = require('../dataDir');

/** 标准 MCP 配置文件（mcp.json，数据根顶层）。 */
const MCP_FILE = HOME_PATHS.mcp;
/** 旧版配置（mcp/servers.json），只读一次用于迁移。 */
const MCP_LEGACY_FILE = HOME_PATHS.mcpLegacy;

const SKILLS_FILE = 'skillsJson';

const SKILL_KEYS = ['skills'];

let legacyMigration = null; // 迁移结果，供启动日志/排障读取

/**
 * 读标准 MCP 配置 → 内部结构。
 *
 * 文件坏了**抛错**而不是当空：否则用户在设置页点保存就把坏文件整体覆盖，
 * 等于把人家能手动修好的配置删了。
 */
function readMcpServers() {
    let result;
    try {
        result = standard.readStandardFile(MCP_FILE);
    } catch (e) {
        console.warn('[mcp] 读取 mcp.json 失败:', e instanceof Error ? e.message : String(e));
        return [];
    }
    if (result.dropped && result.dropped.length) {
        console.warn(`[mcp] mcp.json 里有 ${result.dropped.length} 个条目既没有 command 也没有 url，已跳过：${result.dropped.join(', ')}`);
    }
    return result.servers;
}

/** 写标准 MCP 配置（保留文件里的其他顶层键与条目里的未知字段）。 */
function writeMcpServers(servers) {
    return standard.writeStandardFile(MCP_FILE, servers);
}

/**
 * 把旧版 mcp/servers.json 迁进标准格式。幂等（迁移后旧文件已改名）。
 *
 * 只在**标准文件里还没有对应条目**时补入，绝不覆盖用户已经在新文件里改过的配置。
 */
function migrateLegacyMcp() {
    if (legacyMigration) return legacyMigration;
    const out = { ran: false, reason: '', imported: 0, skipped: 0 };
    try {
        if (!fs.existsSync(MCP_LEGACY_FILE)) {
            out.reason = 'no-legacy-file';
            legacyMigration = out;
            return out;
        }
        const legacy = JSON.parse(fs.readFileSync(MCP_LEGACY_FILE, 'utf-8'));
        // 旧格式有两种落盘形态，历史都出现过，都要认：
        //   { servers: [...] }  —— 核心版旧的 settings 包装
        //   [...]               —— 桌面版旧的 mcp-servers.json 裸数组
        const oldList = Array.isArray(legacy)
            ? legacy
            : legacy && Array.isArray(legacy.servers)
                ? legacy.servers
                : [];
        if (!oldList.length) {
            out.reason = 'legacy-empty';
            legacyMigration = out;
            return out;
        }
        const current = readMcpServers();
        const haveIds = new Set(current.map((s) => s.id));
        const merged = [...current];
        for (const s of oldList) {
            if (!s || typeof s.id !== 'string' || !s.id.trim()) { out.skipped++; continue; }
            if (haveIds.has(s.id)) { out.skipped++; continue; }
            merged.push({ ...s, name: s.name || s.id, enabled: s.enabled !== false });
            haveIds.add(s.id);
            out.imported++;
        }
        if (out.imported > 0) writeMcpServers(merged);
        // 旧文件改名留档（失败只提示，不影响运行）
        try {
            fs.renameSync(MCP_LEGACY_FILE, `${MCP_LEGACY_FILE}.migrated-${Date.now()}.bak`);
        } catch (e) {
            console.warn('[mcp] 旧 mcp/servers.json 留档改名失败（不影响运行）:', e?.message || e);
        }
        out.ran = true;
        out.reason = out.imported ? 'migrated' : 'already-present';
        console.log(
            `[mcp] 旧配置已转成标准 mcp.json：补入 ${out.imported} 个、跳过已存在 ${out.skipped} 个（旧文件已留档）`,
        );
    } catch (e) {
        out.reason = `error: ${e?.message || e}`;
        console.warn('[mcp] 旧 MCP 配置迁移失败（不影响启动，旧文件未动）:', e?.message || e);
    }
    legacyMigration = out;
    return out;
}


function readSkills() {
    // skills.json 可能不存在（新装/纯 SKILL.md 用户）：当作空清单，不是错误。
    let raw = null;
    try {
        if (fs.existsSync(SKILLS_FILE)) raw = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8'));
    } catch (e) {
        console.warn('[mcp] skills.json 解析失败，按空清单处理:', e instanceof Error ? e.message : String(e));
        raw = null;
    }
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

        // 阶段 D：MCP/技能工具注册进统一能力注册表（scope=global，所有客户端可见），
        // 走统一的超时 + 截断流水线。保留 setLocalTools 兼容旧调用方（preflight 直调）。
        setLocalTools([...mcpTools, ...skillTools]);
        const capabilities = require('../capabilities/registry');
        const total = capabilities.registerGlobal([...mcpTools, ...skillTools]);
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
        // 先把旧 mcp/servers.json 转成标准 mcp.json，再建连 —— 顺序反了会漏掉旧配置。
        migrateLegacyMcp();
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
    migrateLegacyMcp,
    readSkills,
    writeSkills,
    refreshTools,
    initTools,
    probeServer,
    getLocalToolNames,
    /** 标准 MCP 配置文件的绝对路径（mcp.json）。 */
    mcpFilePath: () => MCP_FILE,
    /** 旧版配置文件路径（迁移后仍可查，留档用）。 */
    legacyMcpFilePath: () => MCP_LEGACY_FILE,
    skillsFilePath: () => require('../settings/localSettings').filePath(SKILLS_FILE),
};
