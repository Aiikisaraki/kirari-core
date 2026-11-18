// src/skills/skillMd.js
// 阶段 D：SKILL.md 渐进披露装载器（core 侧）。
//
// 目录约定：<数据根>/skills/<skillId>/SKILL.md（逻辑名 skillsRoot / skillsJson，
// 见 src/kirariHome.js 的 LAYOUT）。扫描这些文件，用共享包的
// parseSkillMarkdown 严格解析；进 system 的只有「name: description」目录摘要，
// 模型需要时用 load_skill(name) 才把正文注入——装十个技能也不再 full-load 吃 token。
//
// 仍然兼容旧的 skills.json prompt 型技能：若没有 SKILL.md，则将 skills.json 里的
// prompt 直接作为一个「正文即指令」的技能纳入（渐进迁移，不破坏存量配置）。

const fs = require('fs');
const path = require('path');
const { parseSkillMarkdown, skillCatalogLine } = require('kirari-agent');
const { paths } = require('../dataDir');

const SKILLS_ROOT = paths.skillsRoot;
const SKILLS_JSON = paths.skillsJson;

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
        // 第三参数 = 兜底名字（目录名）。Claude Code 等实现允许 SKILL.md 只写
        // description、以目录名当技能名；传入后这类技能也能直接用。
        parsed.push(parseSkillMarkdown(fs.readFileSync(file, 'utf8'), file, ent.name));
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

/**
 * 生成进 system 的目录摘要（不含正文）。
 *
 * 每条描述截到 160 字：标准技能常写几百字的触发条件，全文进目录会白烧 token，
 * 而目录的用途只是让模型认出「要不要加载」。真正需要全文时走 load_skill。
 */
const CATALOG_DESC_MAX = 160;

function catalogBlock() {
  const skills = getSkills();
  if (!skills.length) return '';
  return '\n\n# 可用技能（需要时用 load_skill 加载完整说明）\n' + skills.map((s) => skillCatalogLine(s, CATALOG_DESC_MAX)).join('\n');
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
