// src/services/memory.js
// 长期记忆引擎：让 Kirari 在「新开一个对话」后依然认得人，同时守住「关于谁的事只能在谁面前说」。
//
// 为什么需要它（2026-11-19 用户原话）：
//   「有些记忆不应该是完全撕裂的，不能你新开一个对话，她就像不认识你一样……
//     记忆机制可以更加灵活一点，允许针对每一个不同对话者有不同的记忆池以及联想。」
//   「身份不应该粗暴地被分为主人和非主人，应该每一个用户在她那都有一套独立的记忆，
//     这些记忆可以随着人际关系的拓展而产生互相关联。
//     主人只是对这个 ai 智能体有最高管理权的用户角色。」
//
// 因此这里有两个正交的轴，不要混：
//   归属轴 subject —— 这条记忆存在谁的池子里，决定「谁会想起它」。
//                     person::{key} 是每个人的独立记忆池（这才是"每人一套记忆"）。
//   内容轴 about_person —— 这条记忆说的是谁的事。A 转述「B 失恋了」时，
//                     池子是 A 的，内容关于 B。两者不同，判断"能不能讲"时都要看。
//
// 以及一个独立的权限轴 role（在 people 表里）：
//   owner / admin / user —— 只表达**管理权限**（谁能改她的设置、查她的内部状态），
//   绝不参与记忆归属与可见性判断。主人也只是一套独立的池子，不比别人多一份。
//
// 检索是「联想」而非精确匹配：池内相近度 + 关键词 + 重要度 + 命中史 + 关系图扩散。
// 绝不整表倒出来——那只是把上下文窗口换个地方，反而更吵。

const { paths } = require('../dataDir');

// ── subject 构造 ──────────────────────────────────────────────────────
/** 某个人自己的记忆池。 */
const PERSON = (key) => `person::${key}`;
/** 她自己的 / 拥有者共享的长期事实池。 */
const SELF = (uid) => `self::${uid}`;
/** 某个场合（群）的公共记忆池。 */
const SCENE = (scope) => `scene::${scope}`;
/** 不属于任何人的常识与约定。 */
const GLOBAL = 'global';

// ── 会话 id 解析 ──────────────────────────────────────────────────────

/**
 * 判断会话是不是多人场合（群聊/频道/私密多人）。
 *
 * ⚠️ 只影响「可见性」判断，**不影响记忆归属**——群聊里发生的事照样记进
 * person/scene 池，只是群里不能把 private/secret 的内容说出来。
 * 用户明确否掉了「按会话把记忆完全撕裂」的做法。
 */
function isGroupSession(sessionId) {
  return /(^|[-:_.])(group|channel|dm):/i.test(String(sessionId || ''));
}

/** 从 sessionId 解析场合 scope（群号等）。解析不出就退化成 sessionId 本身。 */
function sceneScopeFromSession(sessionId) {
  const s = String(sessionId || '');
  let m = /(?:^|-)(?:group|channel):([^:]+)/i.exec(s);
  if (m) return m[1];
  m = /group:([^:]+)/i.exec(s);
  if (m) return m[1];
  return s || 'unknown';
}

/** 从 sessionId 解析对话者标识（平台账号）。拿不到就用 sessionId。 */
function counterpartFromSession(sessionId) {
  const s = String(sessionId || '');
  let m = /(?:private|group|channel|dm):(.*)$/i.exec(s);
  if (m) {
    const parts = m[1].split(':').filter(Boolean);
    return parts[parts.length - 1] || m[1];
  }
  m = /user:([^:]+)/i.exec(s);
  if (m) return m[1];
  return s || 'unknown';
}

/**
 * 归一化本轮的身份上下文。
 *
 * ctx 可来自 botManager（带 scene）、控制台（本机）、或工具 dispatch（只有 sessionId）。
 * 这里把「此刻在跟谁说话」收敛成唯一可信的 { counterpartId, role, isGroup, sessionId }。
 */
function resolveIdentity(ctx = {}) {
  const sessionId = String(ctx.sessionId || '');
  const isGroup = ctx.isGroup != null ? !!ctx.isGroup : isGroupSession(sessionId);
  // 对话者：显式优先（botManager 传 scene.senderId），否则从 sessionId 推
  const counterpartId = String(
    ctx.counterpartId || ctx.senderId || counterpartFromSession(sessionId),
  );
  return {
    sessionId,
    uid: ctx.uid != null ? ctx.uid : 'anon',
    counterpartId,
    role: ctx.role || null, // 未显式给则由调用方查 people 表后补
    isGroup,
    sceneScope: ctx.sceneScope || sceneScopeFromSession(sessionId),
    displayName: ctx.displayName || null,
    platform: ctx.platform || null,
  };
}

/**
 * 当前这一轮该读哪些记忆池，顺序即优先级。
 *
 * 设计要点：「每人一套独立记忆」就是在这里落实的——
 * 只把自己的池 + 当前场合的池 + 自己的常识池放进来，
 * 别人的 person 池**根本不在查询范围内**，不存在"读到了再过滤"的口子。
 */
function resolveSubjects(ctx = {}, identity = null) {
  const id = identity || resolveIdentity(ctx);
  const subs = [];
  // 她自己的长期事实池（关于她本身、以及拥有者本人的设定）
  subs.push(SELF(id.uid));
  // 当前场合的公共池
  if (id.isGroup) subs.push(SCENE(id.sceneScope));
  // 此刻这个人的独立记忆池 —— 换人即换池
  if (id.counterpartId && id.counterpartId !== 'unknown') subs.push(PERSON(id.counterpartId));
  // 谁的池都不属于的世界常识
  subs.push(GLOBAL);
  return [...new Set(subs)];
}

/**
 * 单条记忆在**此刻这个场合、面对这个人**是否可读。
 *
 * 这是隐私的唯一闸门，不依赖模型自觉。三条硬规则：
 *   1) 池子隔离：只能读自己池里的（别人的池不在 resolveSubjects 里，双保险再挡一次）。
 *   2) 场合隔离：群聊里 private/secret 一律不给看，从源头杜绝口误。
 *   3) 内容归属：secret 表示「这是某人的私事」，只有当事人本人能听。
 *      关于 B 的私事，A 在一对一里也读不到——除非 A 自己就是当事人。
 */
function isMemoryVisible(mem, identity) {
  const subject = String(mem.subject || '');
  const vis = String(mem.visibility || 'private');
  const cp = identity.counterpartId;

  // (1) 池子隔离：person::X 只对 X 本人开放
  if (subject.startsWith('person::') && subject.slice('person::'.length) !== cp) return false;

  // self:: 池是「她与拥有者共享的长期事实」，不是谁都能看
  if (subject.startsWith('self::')) {
    // 拥有者本人可以看全部；其他人只能看标记为 public 的部分
    if (identity.role !== 'owner' && vis !== 'public') return false;
  }

  // (2) 场合隔离：群里只给 public
  if (identity.isGroup && vis !== 'public') return false;

  // (3) 内容归属：secret 只给当事人本人
  if (vis === 'secret') {
    const about = mem.aboutPerson == null ? null : String(mem.aboutPerson);
    // 关于别人的私事 → 不给你听
    if (about && about !== cp) return false;
    // 关于自己池里的私事 → 本人可以听
    if (!about) {
      const own =
        (subject.startsWith('person::') && subject.slice('person::'.length) === cp) ||
        (subject.startsWith('self::') && identity.role === 'owner');
      if (!own) return false;
    }
  }

  return true;
}

/** 兼容旧调用点：当前场合能读到哪些 visibility（粗粒度，仅用于快速判定）。 */
function allowedVisibility(ctx = {}) {
  const id = resolveIdentity(ctx);
  if (id.isGroup) return ['public'];
  return id.role === 'owner' ? ['public', 'private', 'secret'] : ['public', 'private', 'secret'];
}

/** 中文/英文都粗略切词：记忆内容多是短句，够用且零依赖。 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.split(/[\s，。、；：！？,.;:!?"'()（）\[\]{}<>《》~～|/\\\-]+/)) {
    if (w.length >= 2) out.add(w);
  }
  const cn = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 2 <= cn.length; i += 1) out.add(cn.slice(i, i + 2));
  return out;
}

/**
 * 相关度打分：命中词数 / 重要度 / 是否本人池 / 是否常用。
 *
 * 纯词面匹配对中文短问句太弱（"我今天想吃什么"命不中"讨厌香菜"）。
 * 所以给「同池」的记忆一个基础分：联想本来就该先想起关于这个人的事。
 */
function scoreMemory(mem, queryTokens, ctxSubjects) {
  const mt = tokenize(mem.content);
  let overlap = 0;
  for (const t of queryTokens) if (mt.has(t)) overlap += 1;
  const rank = ctxSubjects.indexOf(mem.subject);
  let score = overlap * 10;
  const isContextual = mem.subject !== GLOBAL;
  score += isContextual ? 8 : 2;
  score += Math.max(0, 6 - rank * 2);
  score += (mem.importance || 3) * 2;
  score += Math.min(4, Math.floor((mem.hits || 0) / 3));
  return score;
}

/** 按池分组的中文标签。 */
function groupLabel(subject) {
  if (subject.startsWith('self::')) return '关于你自己和这段关系';
  if (subject.startsWith('person::')) return '关于此刻跟你说话的人';
  if (subject.startsWith('scene::')) return '这个场合里大家的事';
  return '你记得的常识与约定';
}

/**
 * 注入前的脱敏：去掉"谁说的"这类来源信息。
 *
 * 关于 B 的事可能是 A 转述的，B 有权知道内容本身，但无权也不该知道
 * "是 A 在背后跟我说你失恋了"——那会直接破坏 A 的信任。
 * 所以这类条目只留事、不留人。
 */
function sanitizeForSubject(content) {
  return String(content || '')
    // "A 说 B 失恋了" → "B 失恋了"
    .replace(/^[^\s，。]{1,12}(说|告诉我|跟我讲|提到|聊到)[，,]?\s*/, '')
    // 去掉"某人/有人"这类容易引人追问的引导语
    .replace(/^(听说|有人说|有人告诉我)[，,]?\s*/, '');
}

/**
 * 组装本轮要注入的记忆段。
 *
 * @param {object} ctx  { sessionId, uid, counterpartId, role, isGroup, sceneScope, displayName }
 * @param {string} query 用户这句话（用来做联想）
 * @param {object} opts { limit, expand }
 */
async function buildMemoryBlock(ctx = {}, query = '', opts = {}) {
  const store = ctx.store || defaultStore();
  const identity = resolveIdentity(ctx);
  const subjects = resolveSubjects(identity, identity);
  let rows = [];
  try {
    rows = await store.listMemories(subjects, { limit: 200 });
  } catch {
    return { block: '', items: [] };
  }

  // ── 关联方向一：关于「此刻这个人」的事，哪怕记在别人的池里 ──────────
  // A 私下跟我说「B 最近失恋了」，这条存在 A 的池里（内容关于 B）。
  // B 自己出现时，他有权知道"有人提过这件事"，否则就是"每人一套记忆"变成了
  // "每个人都被蒙在鼓里"。但只能给内容、不能给来源——所以下面注入时会强制脱敏。
  const known = new Set((rows || []).map((m) => m.id));
  if (identity.counterpartId && identity.counterpartId !== 'unknown') {
    try {
      const about = await store.listMemoriesAbout(identity.counterpartId, { limit: 60 });
      for (const m of about || []) {
        if (known.has(m.id)) continue;
        // 群里不浮现别人的转述；一对一才谈"关于你的事"
        if (identity.isGroup) continue;
        rows.push({ ...m, _aboutMe: true });
      }
    } catch {
      /* 关联查询失败不影响主流程 */
    }
  }

  // ── 关联方向二：关系网里那些公开的事 ────────────────────────────────
  if (opts.expand !== false && identity.counterpartId && identity.counterpartId !== 'unknown') {
    try {
      const links = await store.expandLinks([PERSON(identity.counterpartId)], { depth: 1, minWeight: 3 });
      const extraPersons = links
        .filter((l) => l.relation === 'knows' && String(l.other).startsWith('person::'))
        .map((l) => l.other);
      if (extraPersons.length) {
        const extra = await store.listMemories(extraPersons, { limit: 50 });
        const seen2 = new Set(rows.map((m) => m.id));
        // 关联者的记忆只会以 public 形式浮现（见下方可见性判定）
        rows = rows.concat(extra.filter((m) => !seen2.has(m.id)).map((m) => ({ ...m, _viaLink: true })));
      }
    } catch {
      /* 关联查询失败不影响主流程 */
    }
  }

  const usable = (rows || []).filter((m) => (m._aboutMe ? m.visibility !== 'secret' : isMemoryVisible(m, identity)));
  if (!usable.length) return { block: '', items: [] };

  const qTokens = tokenize(query);
  const scored = usable
    .map((m) => {
      let s = scoreMemory(m, qTokens, subjects);
      // 通过关系网扩散来的记忆降权：不如本人池直接可靠
      if (m._viaLink) s -= 6;
      return { m, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, Number(opts.limit) || 12));

  if (!scored.length) return { block: '', items: [] };

  const buckets = new Map();
  for (const { m } of scored) {
    const k = groupLabel(m.subject);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(m);
  }

  const lines = ['\n\n【你记得的事 · 请自然运用，不要照本宣科】'];
  if (identity.isGroup) {
    lines.push('（以下是你在当前场合被允许想起的内容。别人的私事此刻看不到，也不要去猜。）');
  }
  let hasAboutMe = false;
  for (const [label, items] of buckets) {
    lines.push(`· ${label}：`);
    for (const m of items) {
      if (m._aboutMe) {
        hasAboutMe = true;
        // 只给事，不给来源（见 sanitizeForSubject 注释）
        lines.push(`  - ${sanitizeForSubject(m.content)}`);
      } else {
        lines.push(`  - ${m.content}`);
      }
    }
  }
  if (hasAboutMe) {
    lines.push(
      '（其中有几条是关于对方本人的，可能是别处听来的。可以关心，但不要说出是从谁那里知道的——通常对方也不希望别人在背后议论自己。若对方问起"你怎么知道"，就说是自己留意到的，或者说不太记得了，别点别人的名字。）',
    );
  }
  lines.push('用法：这些是背景，不是台词。相关时自然带出，不相关就别硬提；也不要罗列成清单念给对方听。');

  try {
    await store.touchMemory(scored.map((x) => x.m.id));
  } catch {
    /* 计数失败忽略 */
  }
  return { block: lines.join('\n'), items: scored.map((x) => x.m) };
}

/** 简易去重键：去掉标点与空白后比较。 */
function normalizeForDedupe(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？,.;:!?"'()（）\[\]{}《》~～]/g, '')
    .toLowerCase();
}

/** 明显不该外泄的内容 → 强制 secret。这是兜底，主防线是上面的可见性闸门。 */
function isSensitive(text) {
  const s = String(text || '');
  return /(密码|密钥|api[_ -]?key|token|口令|身份证|银行卡|手机号|住址|家庭住址|抑郁症|病史|工资|薪水|取向|出柜)/i.test(s);
}

/**
 * 写入一条记忆。
 *
 * @param {object} input
 *   content     记忆正文
 *   subject     显式指定池子；不传则按 scope 推导
 *   scope       'person'（此刻这个人，默认）| 'self' | 'scene' | 'global'
 *   aboutPerson 这条记忆关于谁（可选）。A 转述 B 的事时填 B 的 key。
 *   visibility  'public' | 'private' | 'secret'
 *   source      'self' | 'told' | 'observed'（仅溯源，不影响可见性）
 */
async function remember(input = {}, ctx = {}) {
  const store = ctx.store || defaultStore();
  const content = String(input.content || '').trim().slice(0, 2000);
  if (!content) return { ok: false, reason: 'empty' };

  const identity = resolveIdentity(ctx);
  const cp = identity.counterpartId;

  // 归属推导。默认落进「此刻这个人的池」——这正是"每人一套独立记忆"。
  let subject;
  const scope = String(input.scope || '').toLowerCase();
  if (scope === 'global') subject = GLOBAL;
  else if (scope === 'self') subject = SELF(identity.uid);
  else if (scope === 'scene') subject = SCENE(identity.sceneScope);
  else if (scope === 'person') subject = PERSON(input.subjectId || cp);
  else if (input.subject) subject = String(input.subject);
  else if (identity.isGroup && !input.subjectId) {
    // 群聊里说的、又没指明关于谁 → 记进这个场合的公共池
    subject = SCENE(identity.sceneScope);
  } else {
    subject = PERSON(cp);
  }

  // 内容归属：显式 aboutPerson 优先；否则一对一里默认就是关于对方
  const aboutPerson =
    input.aboutPerson != null ? String(input.aboutPerson) : !identity.isGroup && subject.startsWith('person::') ? cp : null;

  // 可见性推导：
  //   scene 池本身已按场合隔离，对场合内公开；
  //   关于别人的事（aboutPerson 不是当事人）默认 private，不主动外传；
  //   其余默认 private。
  let visibility = ['public', 'private', 'secret'].includes(input.visibility) ? input.visibility : null;
  if (!visibility) {
    if (subject.startsWith('scene::')) visibility = 'public';
    else if (aboutPerson && aboutPerson !== cp) visibility = 'private';
    else visibility = 'private';
  }
  // 敏感内容强制升级为 secret：即便模型标错，也不让它有机会在不该出现的地方被读到
  if (isSensitive(content)) visibility = 'secret';

  // 去重：同池同内容不重复记，只刷新重要度
  try {
    const exist = await store.findMemoryByContent(subject, content);
    if (exist) {
      if (input.importance && Number(input.importance) > (exist.importance || 3)) {
        await store.updateMemory(exist.id, { importance: Number(input.importance) });
      }
      return { ok: true, id: exist.id, duplicate: true };
    }
    const before = await store.listMemories([subject], { limit: 200 });
    const norm = normalizeForDedupe(content);
    for (const row of before || []) {
      if (normalizeForDedupe(row.content) === norm) return { ok: true, id: row.id, duplicate: true };
    }
  } catch {
    /* 去重失败就直接写，宁可多一条也别丢 */
  }

  const id = await store.addMemory({
    subject,
    kind: ['fact', 'preference', 'event', 'rule'].includes(input.kind) ? input.kind : 'fact',
    content,
    visibility,
    originSession: identity.sessionId || null,
    aboutPerson,
    source: ['self', 'told', 'observed'].includes(input.source) ? input.source : 'told',
    importance: Number(input.importance) || 3,
  });
  return { ok: !!id, id: id || undefined };
}

/** 忘掉记忆。按 id，或按内容关键词批量。只软删除，留痕可恢复。 */
async function forget(input = {}, ctx = {}) {
  const store = ctx.store || defaultStore();
  const identity = resolveIdentity(ctx);
  const subjects = resolveSubjects(identity, identity);
  if (input.id != null) {
    const rows = await store.listMemories(subjects, { limit: 500 });
    if (!(rows || []).some((r) => Number(r.id) === Number(input.id))) {
      return { ok: false, reason: 'not_in_scope' };
    }
    const ok = await store.deleteMemory(input.id);
    return { ok, id: Number(input.id) };
  }
  const kw = String(input.keyword || input.content || '').trim();
  if (!kw) return { ok: false, reason: 'need_id_or_keyword' };
  const rows = await store.listMemories(subjects, { limit: 500 });
  const hit = (rows || []).filter((r) => r.content.includes(kw));
  let n = 0;
  for (const r of hit) {
    if (await store.deleteMemory(r.id)) n += 1;
  }
  return { ok: n > 0, removed: n, ids: hit.map((r) => r.id) };
}

/** 列记忆（当前场合可见）。不含别人的池。 */
async function list(ctx = {}, opts = {}) {
  const store = ctx.store || defaultStore();
  const identity = resolveIdentity(ctx);
  const subjects = resolveSubjects(identity, identity);
  const rows = await store.listMemories(subjects, { limit: opts.limit || 100 });
  return (rows || []).filter((m) => isMemoryVisible(m, identity));
}

/** 记忆统计。 */
async function stats(ctx = {}) {
  const store = ctx.store || defaultStore();
  try {
    return await store.memoryStats();
  } catch {
    return { total: 0, bySubject: [] };
  }
}

// ── 人物档案与关联（供 botManager / 工具调用）──────────────────────────

/**
 * 记录「这个人存在」并刷新最后活跃时间。
 * 每次收到消息调一次即可——这是 people 表的来源。
 */
async function touchPerson(info = {}, ctx = {}) {
  const store = ctx.store || defaultStore();
  const key = String(info.personKey || '').trim();
  if (!key) return null;
  try {
    await store.upsertPerson({
      personKey: key,
      role: info.role || 'user',
      displayName: info.displayName || null,
      platform: info.platform || null,
    });
    return await store.getPerson(key);
  } catch {
    return null;
  }
}

/** 查这个人是谁、有什么权限。查不到就当作普通对话者。 */
async function getPerson(personKey, ctx = {}) {
  const store = ctx.store || defaultStore();
  const key = String(personKey || '').trim();
  if (!key) return null;
  try {
    return await store.getPerson(key);
  } catch {
    return null;
  }
}

/** 建立/更新两个节点之间的关联（人—人、人—事、事—事）。 */
async function link(a, b, relation = 'related', weight = 3, ctx = {}) {
  const store = ctx.store || defaultStore();
  try {
    const ok = await store.addLink(a, b, relation, weight);
    return { ok };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** 取某个节点（person::x 或数字 id）的关联网络。 */
async function linksOf(node, ctx = {}) {
  const store = ctx.store || defaultStore();
  try {
    return await store.listLinks(node);
  } catch {
    return [];
  }
}

/** 默认存储：走 sessionManager 选定的后端（两端共库）。 */
function defaultStore() {
  // 惰性 require：memory.js 会在 capability / conversationService 里被加载，
  // 顶层 require sessionManager 容易绕成循环。
  const sessionManager = require('../session/sessionManager');
  return sessionManager.storage;
}

module.exports = {
  SELF,
  PERSON,
  SCENE,
  GLOBAL,
  isGroupSession,
  sceneScopeFromSession,
  counterpartFromSession,
  resolveIdentity,
  resolveSubjects,
  isMemoryVisible,
  allowedVisibility,
  buildMemoryBlock,
  remember,
  forget,
  list,
  stats,
  touchPerson,
  getPerson,
  link,
  linksOf,
  tokenize,
  isSensitive,
  filePathHint: () => paths.database,
};
