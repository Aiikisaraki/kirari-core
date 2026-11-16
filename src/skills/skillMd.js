// src/skills/skillMd.js
// 阶段 D：SKILL.md 渐进披露装载器（core 侧）。
//
// 目录约定：<dataDir>/skills/<skillId>/SKILL.md。扫描这些文件，用共享包的
// parseSkillMarkdown 严格解析；进 system 的只有「name: description」目录摘要，
// 模型需要时用 load_skill(name) 才把正文注入——装十个技能也不再 full-load 吃 token。
//
// 仍然兼容旧的 skills.json prompt 型技能：若没有 SKILL.md，则将 skills.json 里的
// prompt 直接作为一个「正文即指令」的技能纳入（渐进迁移，不破坏存量配置）。

const fs = require('fs');
const path = require('path');
const { parseSkillMarkdown, skillCatalogLine } = require('kirari-agent');
const { dataDir } = require('../dataDir');

const SKILLS_ROOT = path.join(dataDir, 'skills');
const SKILLS_JSON = path.join(dataDir, 'skills.json');

let cache = null; // { parsed: ParsedSkill[] }，配置变更时由 invalidate() 清空

/** 扫描 <dataDir>/skills/*\/SKILL.md，解析为 ParsedSkill[]（失败只 warn 跳过）。 */
function scanSkillMd() {
  const parsed = [];
  if (fs.existsSync(SKILLS_ROOT)) {
    let entries = [];
    try {
      entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
    } catch { /* ignore */ }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = path.join(SKILLS_ROOT, ent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        parsed.push(parseSkillMarkdown(fs.readFileSync(file, 'utf8'), file));
      } catch (e) {
        console.warn(`[skillMd] 解析失败（跳过）：${file} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  // 兼容旧 skills.json prompt 型：包成一个「正文即指令」的技能（标 source=json）。
  if (fs.existsSync(SKILLS_JSON)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(SKILLS_JSON, 'utf8'));
      for (const s of Array.isArray(cfg.skills) ? cfg.skills : []) {
        if (s.enabled === false || !s.prompt || !String(s.prompt).trim()) continue;
        const name = String(s.name || s.id || 'skill').slice(0, 64);
        const description = String(s.description || '').slice(0, 200) || name;
        // 用 SKILL.md 语法包一层，交给共享包统一解析，保持单一解析路径。
        const md = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n${s.prompt}`;
        try {
          parsed.push(parseSkillMarkdown(md, `skills.json:${name}`));
        } catch { /* 单个坏技能跳过 */ }
      }
    } catch { /* skills.json 损坏则忽略 */ }
  }
  return parsed;
}

/** 取全部解析好的技能（带缓存）。 */
function getSkills() {
  if (!cache) cache = { parsed: scanSkillMd() };
  return cache.parsed;
}

/** 配置变更后调用，令缓存失效。 */
function invalidate() {
  cache = null;
}

/** 生成进 system 的目录摘要（不含正文）。 */
function catalogBlock() {
  const skills = getSkills();
  if (!skills.length) return '';
  return '\n\n# 可用技能（需要时用 load_skill 加载完整说明）\n' + skills.map(skillCatalogLine).join('\n');
}

/** 按 name 查正文（load_skill 用）；大小写敏感，找不到返回 undefined。 */
function loadBody(name) {
  return getSkills().find((s) => s.meta.name === name)?.body;
}

/** 目录里是否有这个技能（供 load_skill 的能力描述动态提示，可选）。 */
function hasSkill(name) {
  return getSkills().some((s) => s.meta.name === name);
}

module.exports = {
  SKILLS_ROOT,
  getSkills,
  invalidate,
  catalogBlock,
  loadBody,
  hasSkill,
};
