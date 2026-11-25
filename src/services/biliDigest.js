// src/services/biliDigest.js
// B 站「最近看过什么」：把当天她真正看过的内容整理成一块可直接注入 system 的东西。
//
// ── 为什么需要它（2026-11-25 用户报障）─────────────────────────────
//   「我今天问她看过什么，她依旧记不得东西，不知道视频名和视频内容，
//     啥都不记得，我感觉没什么有用价值啊」
//
// 这条链上其实有三处断裂，这里补的是第三处：
//   ① 扩展 0.3.0 重构时丢了 discover / explore → 每次醒来「未知方法：discover」，
//      **一条内容都没读到**（已在 kirari-ext-bili/lib/discover.cjs 补回）
//   ② 隐私正则把公开标题里的正常成分误杀 → 记忆只剩「刷到点东西」
//      （已拆出 scrubPublicTitle + publicContent 模式）
//   ③ ★ 就算写进了 memories 表，也**从来没被主动注入过**：
//      buildMemoryBlock 是按「当前这句问话」做相关度打分的，
//      用户问「你今天看过什么」，句子里的词跟记忆正文一个都不重合，
//      于是那段记忆根本不进上下文——她当然答不上来。
//
// ③ 是最隐蔽的一处：数据在库里，注入路径却只认「关键词命中」。
// 这件事没法靠调权重解决，只能给「她自己的经历」单开一条**时间线**注入。
//
// ── 参考实现 ────────────────────────────────────────────────────────
// dsh-bili-humanism 的「信笺 + 固定读取入口」：经历落盘成专用文档，
// 主提示里只留一个读取入口，模型按需读；不把全部内容堆进 system。
// 这里用的是同一思路的轻量版：当天见闻做成摘要块，常驻注入（很短），
// 完整条目留给 bili_explore 的 notesRecall / 记忆检索去取。
//
// 纪律：
//   · 只读库，不写库；失败返回空串，绝不阻塞对话；
//   · 只给主人本人的私聊注入（见闻是她和主人之间的经历，群里不该被搬出来）；
//   · 块要短：只放「最近看过的 N 条 + 标题 + 一句内容」，不放大段正文。

const dbStorage = require('../db/dbStorage');

/** 见闻记忆的标记前缀（写入端在 capabilities/builtin/bili_explore.js） */
const MARK = '[B站';
/** 默认最多列几条 */
const MAX_ITEMS = 6;
/** 标题最长字符数 */
const MAX_TITLE_CHARS = 60;

/**
 * 从一条记忆正文里抠出标题、分区、简介、作者与 BV。
 *
 * 写入格式（见 bili_explore.js）：
 *   [B站见闻·她自己的经历] 刷到《标题》（分区） 简介里说：… 作者是…（BV1xxx）
 *
 * @param {string} content 记忆正文
 * @returns {{bvid:string,title:string,category:string,desc:string,owner:string}|null}
 */
function parseNote(content) {
  const s = String(content || '');
  const bvid = (s.match(/BV[0-9A-Za-z]{10}/) || [''])[0];
  // 标题用「贪婪到最后一个》」的方式取：标题内部可能自带《》嵌套
  // （例如「刷到《所罗门群岛》第2集：…》」），非贪婪会只抓到第一段就停。
  const title = (s.match(/《(.{1,120})》/) || [])[1] || '';
  // 分区：只从**标题结束之后**的文本里找第一个（…），避免把标题里的括号当分区。
  const afterTitle = title ? s.slice(s.indexOf(title + '》') + title.length + 1) : s;
  // 取 afterTitle 里第一个短括号作分区；不用 ^ 锚定，标题里带括号时也能兜住
  const category = (afterTitle.match(/（([^）]{1,20})）/) || [])[1] || '';
  // 简介截到「作者是」「（BV」或句末为止——不截的话会把后面的字段一起吞掉
  const desc = (s.match(/简介里说：([^；。（]{1,80})/) || [])[1] || '';
  const owner = (s.match(/作者是([^；。（]{1,30})/) || [])[1] || '';
  if (!title && !bvid) return null;
  return { bvid: bvid, title: title.slice(0, MAX_TITLE_CHARS), category: category, desc: desc, owner: owner };
}

/**
 * 把毫秒时间戳转成库里的 UTC 字符串（YYYY-MM-DD HH:MM:SS）。
 * created_at 用的是 SQLite 的 CURRENT_TIMESTAMP，那是 **UTC**，
 * 所以这里必须 toISOString 而不是本地时间，否则时区偏 8 小时、筛不到当天。
 */
function toDbTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 取最近 N 天的见闻条目，按时间倒序，最多 limit 条。
 *
 * @param {object} [opts]
 * @param {number} [opts.now] 当前毫秒（测试注入）
 * @param {number} [opts.days=1] 往回看几天（1 = 只有今天）
 * @param {number} [opts.limit] 最多几条
 * @param {string} [opts.subject] 只取某个池（默认不限制，见闻都写在 self:: 池）
 * @returns {Array<object>}
 */
function readRecentNotes(opts) {
  const o = opts || {};
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const days = Math.max(1, Number(o.days) || 1);
  const limit = Math.max(1, Math.min(20, Number(o.limit) || MAX_ITEMS));
  const since = toDbTime(now - days * 24 * 3600 * 1000);
  let rows = [];
  try {
    const db = dbStorage.getDb();
    const sql =
      'SELECT content, created_at FROM memories WHERE deleted = 0 AND content LIKE ? AND created_at >= ?' +
      ' ORDER BY created_at DESC, id DESC LIMIT ?';
    rows = db.prepare(sql).all(MARK + '%', since, limit);
  } catch (e) {
    console.warn('[biliDigest] 读见闻失败（已忽略）:', e && e.message ? e.message : e);
    return [];
  }
  const out = [];
  for (const row of rows) {
    const n = parseNote(row.content);
    if (n) {
      n.at = String(row.created_at || '');
      out.push(n);
    }
  }
  return out;
}

/**
 * 告诉她「最近看过什么」。返回可直接拼进 system 的段落；没内容返回空串。
 *
 * 措辞要点：
 *   · 只陈事实，不要求她一定要说；
 *   · 明确「想不起细节就说想不起」，别让她编（编了比忘更糟）；
 *   · 明确这是她自己的经历，不是别人告诉她的。
 *
 * @param {object} [opts] 同 readRecentNotes
 * @returns {string}
 */
function buildDigestBlock(opts) {
  const notes = readRecentNotes(opts);
  if (!notes.length) return '';
  const o = opts || {};
  const days = Math.max(1, Number(o.days) || 1);
  const when = days > 1 ? '最近' : '今天';
  const lines = ['', '', '【你' + when + '在B站看过什么 · 你自己的经历】'];
  for (const n of notes) {
    let line = '· 《' + n.title + '》';
    if (n.category) line += '（' + n.category + '）';
    if (n.owner) line += ' — ' + n.owner;
    if (n.bvid) line += ' ' + n.bvid;
    lines.push(line);
    if (n.desc && n.desc !== '-' && n.desc.length >= 4) lines.push('  ' + n.desc);
  }
  lines.push(
    '这些是你自己刷到的，不是别人告诉你的。被问起时按上面说——' +
      '记得标题就报标题，记得内容就讲内容。' +
      '**细节真想不起来就说想不起来，不要编**：说「具体讲啥我记不清了」比编一个假的强。',
  );
  return lines.join('\n');
}

module.exports = { readRecentNotes, buildDigestBlock, parseNote, toDbTime, MARK, MAX_ITEMS };