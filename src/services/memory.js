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
// ★ 2026-11-20 补充第三个轴（用户提出的）：可信度 epistemic
//   「谁在说话也是一个很重要的考量，要是我随便说一个别人的信息怎么办，
//     这万一不是事实呢」
//
//   这句话点破了一个我们差点搞错的地方：**「谁在说话」不该决定「能不能存」，
//   而该决定「存成什么可信度」**。随便一个人说「小张出轨了」，这条信息本身
//   值得记（她需要知道有人在传这件事），但它**不是事实**。
//     · 若当成 fact 存 → 她以后会把谣言当已知事实讲给别人听，等于替造谣背书
//     · 若干脆不存   → 她对社会关系失去感知，「谁和谁闹矛盾」一概不知
//   正确做法是存下来、但标成 hearsay，让她回答时自动带上「听说」。
//
//   可信度四档（epistemic，与 visibility 正交）：
//     fact      当事人自述 / 拥有者确认 / 她自己直接经历的确定事实
//     observed  她自己亲眼所见（不是听说的）
//     hearsay   从别人口中听来的第三方信息（「小张最近不太好」）
//     rumor     明确是传闻、转述的转述、匿名来源、或涉及他人隐私的负面陈述
//
//   判据的落点是 content + who：**内容是关于说话人自己的 → fact；关于第三方的
//   → 至少 hearsay；涉及负面评价/私生活且非当事人 → rumor。**
//   与「谁在说话」的关系是**加权**而非**开关**：
//     拥有者说的 → 可信度可以升到 fact（他有管理权，也最了解系统）
//     当事人自述自己的事 → fact（他对自己最有发言权）
//     普通用户说别人的事 → 一律 hearsay 起步，绝不因"他说得很确定"而升级
//
// 检索是「联想」而非精确匹配：池内相近度 + 关键词 + 重要度 + 命中史 + 关系图扩散。
// 绝不整表倒出来——那只是把上下文窗口换个地方，反而更吵。

const { paths } = require('../dataDir');

// ── subject 构造 ──────────────────────────────────────────────────────
/** 某个人自己的记忆池。 */
const PERSON = (key) => `person::${key}`;
/**
 * 她自己的长期事实池（关于她本身、她的设定、她的成长）。
 *
 * ⚠️ 2026-11-20 身份排查修正：原先用 SELF(uid) 且 uid 取 ctx.uid，
 * 而 ctx.uid 是**账号 id**（QQ 上所有人都是 BOT_MODEL_UID=1）——
 * 于是 `self::1` 变成了**所有用户共享的一个池**。线上实际后果：
 * 朋友说的私事（"啥都说"的毛病、跟家人争吵）被写进 self::1，
 * 主人一开口对话就把它读进上下文，成了「别人的记忆混到我这」。
 *
 * 现在口径改成：这个池只装**关于 Kirari 自己**的事，不装任何用户的私事。
 * 用户的私事一律进 person::{对话者}，由「每人一套池」保证隔离。
 * 保留 uid 形参只为兼容老调用点与历史 `self::1` 数据的读取。
 */
const SELF = (uid) => `self::${uid}`;
/** 某个场合（群）的公共记忆池。 */
const SCENE = (scope) => `scene::${scope}`;
/** 不属于任何人的常识与约定。 */
const GLOBAL = 'global';

/**
 * 写入记忆时，把「本该进 self:: 池」的条目重新定归属。
 *
 * 判据：这条内容是不是**关于某个用户**的？
 *   - 关于对话者本人的事（他的习惯、毛病、家里的事、要求）→ person::{对话者}
 *   - 关于 Kirari 自己（设定、成长、她的想法）→ self:: 池
 *
 * 只要此刻有明确的对话者、且内容不是纯关于她自己，就归到对方池里。
 * 拿不准时**归人不归己**：宁可少记一条她的自述，也不能把别人的私事
 * 放进一个所有人共享的池子。
 */
function rehomeSelfSubject(subject, identity, content = '') {
  const s = String(subject || '');
  if (!s.startsWith('self::')) return subject;
  const cp = String((identity && identity.counterpartId) || '');
  // 解析不出对话者 → 不能落 person 池，但更**不能落共享池**。
  // 返回 null 表示「这次别写了，让 remember() 拒绝并让模型去追问」。
  // 老实现这里是 `return subject`，等于把所有身份不明的用户都塞进 self::1
  // 这一个共享池 —— 与 A3 同源的独立泄露通道。
  if (!cp || cp === 'unknown') return null;

  const text = String(content || '').trim();

  // ── 判据：这条是不是**真的在说 Kirari 自己** ──────────────────────
  //
  // ⚠️ 这里曾经犯过一个很典型的错：把「我」当成 Kirari。
  //    于是朋友说「我心情很糟」，被判定成"关于她自己的心情"，留在 self::1，
  //    主人下次开口就读到了。这正是用户报障的原始路径。
  //
  //    根因是**指代歧义**：
  //      · 「我」永远指说话人。一对一里说话人就是 cp，不是 Kirari。
  //        所以「我心情/我设定/我人格」→ 是说话人自己的事，必须归人。
  //      · 「她」在中文里既可能指 Kirari，也可能指任何女性第三方。
  //        单独一个"她"不足以判定，必须有明确指称（Kirari / 名字 / 全称）。
  //
  //    所以只认**无歧义**的表达。宁可把「她的设定」错归到人（只是少记一条
  //    她的自述），也不能把「我心情很糟」错放进全员共享的池子（那是泄露）。
  const aboutHer =
    // 直接点名
    /\bkirari\b|卡莉拉里|这个?ai自己|你自己(的)?(设定|人格|性格|心情|成长|想法|记忆)/i.test(text) ||
    // 第三人称 + 明确的"她自己"结构
    /^(她|你)(自己)?(的)?(设定|人格|性格|成长|心情|想法|情绪|记忆|喜好|习惯)/.test(text) ||
    // 「作为 AI/作为 Kirari」这类自指
    /^(作为|身为)(一个)?(ai|助手|kirari|虚拟)/i.test(text);

  if (aboutHer) return subject;

  // ── 注意：这里**不按身份放行** ────────────────────────────────────
  // 曾经想过「只有 owner 能写共享池」，那是错的：
  //   · 用户原话：「共享池不应该只有主人才能放，有没有办法加入更精准判断」
  //   · 共享池能不能收一条内容，取决于**这条内容是关于谁的**，与谁在说话无关。
  //     朋友说「Kirari 的设定是……」如果确实在说她，理应进共享池。
  // 「谁在说话」真正该起作用的地方是**可信度**（传闻 ≠ 事实），那一层已经在
  //   src/ai/memoryJudge.js + epistemicFor() 里建好了，见 remember() 里的复核。
  // 所以这里的启发式只管粗筛；精确归属由 remember() 里的模型复核纠正（单向：
  // 只有明确判定为「在说她本人」才允许从 person 池搬回 self 池）。
  // 粗筛阶段一律归人不归己 —— 宁可少记她的一条自述，也不能把别人的私事
  // 放进所有人共享的池子（线上真实发生过）。
  return PERSON(cp);
}

/**
 * 可信度四档。与 DISCLOSURE 完全正交：
 *   DISCLOSURE 答「该不该说」，EPISTEMIC 答「说的是不是真的」。
 * 一条 OPEN + rumor 的记忆是典型的「可以说，但必须说成『听说』」。
 */
const EPISTEMIC = {
  /** 当事人自述 / 拥有者确认过的确定事实 */
  FACT: 'fact',
  /** 她自己亲眼所见 */
  OBSERVED: 'observed',
  /** 从别人口中听来的第三方信息 */
  HEARSAY: 'hearsay',
  /** 传闻 / 转述的转述 / 涉及他人私生活的负面陈述 */
  RUMOR: 'rumor',
};

/**
 * 判定一条待写入记忆的**可信度**。
 *
 * 用户原话（2026-11-20）：
 *   「谁在说话也是一个很重要的考量，要是我随便说一个别人的信息怎么办，
 *     这万一不是事实呢」
 *
 * 这条质疑救回了一个我们差点做错的设计。原本的方案是「非 owner 不许写共享池」——
 * 用身份当开关。但那是拿错了工具：身份决定的不是**能不能存**，而是**存多可信**。
 *
 * 判据分三步，顺序不能颠倒：
 *
 *   ① 先在内容轴上问：**这条说的是谁？**
 *      - 关于说话人自己（subject === person::cp 且没填 aboutPerson）→ 他对自己最有发言权
 *      - 关于第三方（aboutPerson 存在且 ≠ cp，或 subject 是别人的池）→ 至少是转述
 *
 *   ② 再问：**是确定的事，还是评价/猜测？**
 *      - 客观可验证（「他养了只猫」）→ hearsay 够了
 *      - 主观负面/私生活（出轨、欠钱、生病、闹翻、人品）→ rumor，绝不升级
 *
 *   ③ 最后才用身份**加权**（不是开关）：
 *      - 拥有者说的 → 他对自己领域内的事可升到 fact（有管理权）
 *      - 当事人自述自己的事 → fact
 *      - 其他人说别人的事 → 一律保持 hearsay/rumor，**不因语气笃定而升级**
 *
 * 输出的 epistemic 直接决定她怎么开口：fact 可以直说，hearsay 必须带「听说」，
 * rumor 只能当"有人在传"处理。
 *
 * @returns {{epistemic: string, claimedBy: string|null}}
 */
function epistemicFor(input = {}, identity = {}, subject = '', content = '') {
  const cp = String((identity && identity.counterpartId) || '');
  const about = input.aboutPerson != null ? String(input.aboutPerson) : null;
  const isOwner = String((identity && identity.role) || '') === 'owner';
  const text = String(content || '');
  const subj = String(subject || '');

  // 说话人明确要求标成"她自己观察到的" → observed（她亲眼所见，不是听来的）
  // 只接受她自己判断出来的，不接受外部把 hearsay 洗成 observed。
  const declaredObserved = String(input.source || '') === 'observed';

  // ① 这条关于谁？
  //    说话人自己：一对一里默认 subject 落在他的池，且没填 aboutPerson
  const aboutSpeaker = !about && cp && subj === PERSON(cp);
  //    第三方：显式填了 aboutPerson 且不是说话人自己
  const aboutOther = !!about && about !== cp;

  // ③ 当事人自述自己的事 —— 对自己最有发言权，直接 fact
  if (aboutSpeaker && !declaredObserved) return { epistemic: 'fact', claimedBy: cp || null };
  if (aboutSpeaker && declaredObserved) return { epistemic: 'observed', claimedBy: cp || null };

  // 她自己观察到的（source=observed），且不涉及第三方转述
  if (declaredObserved && !aboutOther) return { epistemic: 'observed', claimedBy: cp || null };

  // ② 第三方信息的性质：客观事 vs 负面评价/私生活
  //    这个正则刻意宽——宁可多标几个 rumor，也不要让谣言以 fact 的身份散出去。
  const negativePrivate =
    /(出轨|劈腿|偷|抢|骗|欠钱|欠债|赌|吸毒|酗酒|酒驾|坐牢|进监狱|生病|癌|抑郁症|精神病|自杀|离婚|分手|被开除|被辞退|被拘留|作风|人品|私生活|包养|怀孕|堕胎|打过胎|整容|整形|偷情|小三|当第三者|不干净|绿茶|渣|虚伪|造谣|骗人)/;
  const isNegative = negativePrivate.test(text);

  // 关于第三方 → 一律不是 fact。负面/私生活 → rumor，其余 → hearsay
  if (aboutOther) {
    // 拥有者确认过的第三方客观事实可以升到 fact（他有权限、也最了解系统）
    // 但**负面私生活不行**——哪怕主人说「B 出轨了」，那也是他的一面之词。
    if (isOwner && !isNegative) return { epistemic: 'fact', claimedBy: cp || null };
    return { epistemic: isNegative ? 'rumor' : 'hearsay', claimedBy: cp || null };
  }

  // 剩下的是"没说清关于谁"的模糊情况。
  // 内容涉及对某人的负面陈述 → rumor（宁可降级）。
  if (isNegative) return { epistemic: 'rumor', claimedBy: cp || null };

  // 拥有者对自己系统/世界的陈述可以当事实；其他人 → hearsay 起步。
  if (isOwner) return { epistemic: 'fact', claimedBy: cp || null };
  return { epistemic: 'hearsay', claimedBy: cp || null };
}

/**
 * 把可信度翻译成「回答时该怎么措辞」的边界提示。
 *
 * 关键点：这不是让她"闭嘴"，而是让她**不要把传闻讲成事实**。
 * 用户要的是准确，不是沉默。
 */
function epistemicHint(epistemic) {
  switch (String(epistemic || 'fact')) {
    case 'fact':
      return '';
    case 'observed':
      return '｜这是你自己看到的。可以说，但别把它说得比你实际知道的更确定。';
    case 'hearsay':
      return '｜这是**听来的**，不是你确认过的事。说的时候要带上"听说""好像是"——不要当成你已经知道的事实。对方要是追问细节或问是谁说的，就说记不太清了。';
    case 'rumor':
      return '｜这条是**别人在传的**，真假未知，还涉及别人的私事。别当成事实讲，也别替它背书；真被问到，就说"听到过这种说法，但不清楚"。';
    default:
      return '';
  }
}

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
  // 她自己的长期事实池（关于她本身、她的设定）。
  //
  // ⚠️ 2026-11-20 身份排查（用户报障：别人的记忆混到我这儿）：
  // 这个池历史上是**所有人共享**的——键是账号 uid，而 uid 对 QQ 上所有人都是 1。
  // 线上真实后果：朋友说的私事（「啥都说」的毛病、跟家人争吵）被写进 self::1，
  // 主人一开口对话就把它读进上下文。
  //
  // 处理分两头，不要一刀切成「非主人就看不到」（用户明确否掉了完全隔离）：
  //   · 写入端 rehomeSelfSubject —— 新的私事不再进这个池，各回各人的 person:: 池
  //   · 读取端 keepDisclosureTag —— 历史遗留条目照样能检索到，但打上「这是别人的事」
  //     的标签并降权，由模型自己判断该不该说、说到什么程度（见 buildMemoryBlock）
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

  // (0) 身份不明 → 一律不可读。
  //     判据缺口曾在这里：下面第 (1) 条写的是 `slice(8) !== cp`，
  //     当 cp 恰好是 'unknown' 时 `person::unknown` 的比较**通过**，
  //     于是"解析不出身份"的用户反而能读到那个共享池。
  //     fail-closed：认不出你是谁，就不给你看任何有归属的记忆。
  if (!cp || cp === 'unknown') {
    return subject === GLOBAL && vis === 'public';
  }

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
 * 注入前的脱敏：去掉"谁说的"这类来源信息，以及**第三方姓名**。
 *
 * 关于 B 的事可能是 A 转述的，B 有权知道内容本身，但无权也不该知道
 * "是 A 在背后跟我说你失恋了"——那会直接破坏 A 的信任。
 * 所以这类条目只留事、不留人。
 *
 * ⚠️ 老实现只剥**行首**的「A 说」，剥不掉**句中**的人名。
 *    实测「小美跟张三在偷偷交往」原样注入给小美本人 —— 泄露了张三。
 *    「关于你的传闻」这条路径上，第三方的名字比内容本身更该保护：
 *    小美知道"有人在议论她的感情"是可以的，
 *    但把"张三"这个名字交出去，就等于把别人也拖进来。
 *
 * @param {string} content 记忆正文
 * @param {object} [opts]
 *   dropNames 需要抹掉的姓名列表（通常是 aboutPerson 之外的第三方人名）
 */
function sanitizeForSubject(content, opts = {}) {
  let s = String(content || '')
    // "A 说 B 失恋了" → "B 失恋了"
    .replace(/^[^\s，。]{1,12}(说|告诉我|跟我讲|提到|聊到)[，,]?\s*/, '')
    // 去掉"某人/有人"这类容易引人追问的引导语
    .replace(/^(听说|有人说|有人告诉我)[，,]?\s*/, '');

  // 句中第三方姓名脱敏：把具体人名换成"另一个人"
  const names = Array.isArray(opts.dropNames) ? opts.dropNames.filter(Boolean) : [];
  for (const name of names) {
    const n = String(name).trim();
    if (n.length < 2) continue; // 单字名容易误伤，跳过
    s = s.split(n).join('别人');
  }

  // 兜底：抹掉句中的常见指代姓名结构（「跟X在」「和X一起」「X说」）
  // 只在确实有第三方语境时生效，避免把"跟你"这类正常表达改坏。
  s = s
    .replace(/(跟|和|与)([\u4e00-\u9fa5]{2,3})(在|一起|说|聊|去)/g, '$1别人$3')
    .replace(/([\u4e00-\u9fa5]{2,3})(告诉|跟我讲|跟我说|让我)/g, '别人$2');

  return s;
}

/**
 * 把一条别人的私事压成「只知道大概方向」的一句话。
 *
 * ── 为什么要这一步（2026-11-20）────────────────────────────────────
 * 用户的原始要求是「既不是完全记忆隔离，也不是完全泄露隐私」。
 * 上一版对 DISCLOSURE.VAGUE 的处理是**把原文注进去**，后面附一句
 * 「别把细节讲出去」—— 那等于把秘密交给一个被叮嘱要保密的模型：
 * 只要有一轮没守住，细节就已经在对方屏幕上了。
 *
 * 真正的「模糊」要在**注入之前**就做到：她只拿到话题方向，
 * 拿不到可泄露的细节。知道"这位朋友在意说话分寸"是够用的，
 * 不需要知道原话是怎么写的。
 *
 * ⚠️ 不要用"截断原文 / 抽首句"来实现模糊。试过，不安全：
 *    「她妈妈下周要做手术」只有 9 个字，截断和首句都完整保留了下来 ——
 *    而医疗细节恰恰是最不该漏的那类。任何**包含原文片段**的方案都挡不住。
 *
 * 所以这里改成**按话题归类**：从内容里认出"这是关于哪一类事"，
 * 只输出那个类别的说法，**一个原文片段都不带**。
 * 好处是可以证明不会泄露 —— 输出只可能来自下面这张固定的表。
 *
 * @param {string} content 记忆正文
 * @param {object} [opts] 预留（保留签名兼容；不再需要 dropNames）
 * @returns {string} 可以安全注入的话题方向
 */
function vagueGist(content, opts = {}) { // eslint-disable-line no-unused-vars
  const s = String(content || '').trim();
  if (!s) return '（有一件事，但细节她想不起来了）';

  // 类别表：命中即返回该类的**固定说法**，永不回显原文。
  //
  // ⚠️ 两个踩过的坑：
  //   1. 顺序有意义 —— 越敏感/越具体的类排前面。
  //   2. **不要用单字关键词。** 曾经写了 /病|妈|爸/ 之类，结果
  //      「想改掉『啥都说』的**毛病**：控制音量」被"病"命中，判成"身体状况"。
  //      单字在中文里几乎必然误伤，一律用词。
  const TOPICS = [
    [/手术|住院|生病|癌症|身体|健康|吃药|复查|治疗|体检/, '身体状况'],
    [/出轨|劈腿|交往|恋爱|感情|分手|结婚|离婚|暗恋|喜欢谁|对象/, '感情上的事'],
    [/借钱|还钱|欠钱|欠债|工资|收入|费用|花销|存钱|房贷|租金/, '钱上的事'],
    [/被开除|被辞退|辞职|找工作|面试|同事|老板|加班|工作|跳槽/, '工作上的事'],
    [/吵架|争吵|矛盾|闹翻|冷战|得罪|关系/, '跟人的关系'],
    [/说话|吐槽|音量|大声|碎嘴|多嘴|分寸|场合|礼貌|毛病/, '说话做事的分寸'],
    [/压力|心情|情绪|焦虑|难过|失眠|抑郁|疲累/, '心情状态'],
    [/考试|成绩|学习|学校|作业|毕业|挂科/, '学业上的事'],
    [/习惯|改掉|戒掉|坚持|早睡|作息|锻炼|减肥/, '想改的习惯'],
    [/家人|家里|父母|妈妈|爸爸|孩子|老婆|老公|亲戚/, '家里的事'],
  ];
  for (const [re, label] of TOPICS) {
    if (re.test(s)) return `（大概是${label}，具体细节她记不清了）`;
  }
  return '（有一件跟她有关的私事，她只记得大概，说不清细节）';
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

  // ── 关联方向三：对方**问起了另一个具体的人** ─────────────────────
  // 用户诉求：「假如我问 agent 一个关于别人的事，我希望是根据实际情况做出
  // 有选择性的回答，既不是完全记忆隔离，也不是完全泄露隐私」。
  //
  // 所以这里不再让「别人的池」完全不可达：当 A 明确问起 C（关键词命中 C 的名字/
  // 标识），把关于 C 的事**检索进来**，但一律标成 VAGUE（见 disclosureFor），
  // 由模型判断该说多少。这样她不会「装不知道」，也不会「全抖出来」。
  if (!identity.isGroup) {
    try {
      const asked = await findAskedPersons(query, identity, store);
      for (const who of asked) {
        const seen3 = new Set(rows.map((m) => m.id));
        // 两处都要查，因为「关于某人的事」物理上可能落在两种池子里：
        //   (a) 他自己池里（person::{who}）—— 他本人直接跟我说的事
        //   (b) **别人的池里**（person::{转述者}）+ aboutPerson={who}
        //       —— A 私下说「小美最近失恋了」，这条存在 A 的池里
        // 老实现只查 (a)，于是"A 转述的关于 C 的事"永远查不到，
        // 这段「有选择性地回答关于别人的问题」成了死代码（审计 B1）。
        const pools = [PERSON(who.key)];
        const aboutThem = await store.listMemories(pools, { limit: 20 });
        for (const m of aboutThem || []) {
          if (seen3.has(m.id)) continue;
          seen3.add(m.id);
          rows.push({ ...m, _askedAbout: who.key });
        }
        // (b) 谁提到过他 —— 这才是「问起别人」时最该浮现的素材
        const relayed = await store.listMemoriesAbout(who.key, { limit: 20 });
        for (const m of relayed || []) {
          if (seen3.has(m.id)) continue;
          seen3.add(m.id);
          rows.push({ ...m, _askedAbout: who.key, _relayed: true });
        }
      }
    } catch {
      /* 检索失败不影响主流程 */
    }
  }

  // ── 准入闸门：区分「本池」与「跨池检索」 ────────────────────────────
  //
  // 这里原来是一行 `isMemoryVisible` 硬闸，把整个设计掐死了：
  //   `_askedAbout`（方向三）和 `_viaLink`（方向二）检索回来的行全部属于
  //   **别人的池**，而 isMemoryVisible 对 person::X≠cp 一律返回 false ——
  //   于是那两条检索路径永远走不到下面的 disclosureFor 分级，成了死代码。
  //
  // 用户要的是「有选择性的回答，既不是完全记忆隔离，也不是完全泄露隐私」。
  // 硬隔离（查不到）恰恰是前半句要否掉的那一半。
  //
  // 现在的分工：
  //   · 本池内的行 → isMemoryVisible 把关「这个人有没有资格看到」
  //   · 跨池检索来的行 → **允许进入**，但必须带明确的披露档位，
  //     由 disclosureFor 决定能说到什么程度（VAGUE / DEIDENTIFY / SEALED）
  //   · secret 硬红线 → 跨池一律不进入，连暗示的机会都不给
  const usable = (rows || []).filter((m) => {
    const crossed = m._aboutMe || m._viaLink || m._askedAbout;
    if (crossed) {
      // 跨池素材：secret 绝不跨池；群聊里也不跨池（场合闸门优先）
      if (String(m.visibility || 'private') === 'secret') return false;
      if (identity.isGroup) return false;
      // 「关于我自己的事」可以从别人池浮现（他有权知道有人提过）；
      // 「我问起的那个人的事」也可以浮现；关系网扩散的同样允许。
      return true;
    }
    return isMemoryVisible(m, identity);
  });
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

  // 披露决策：每条素材都算出「能说到什么程度」。
  //
  // 这里是整个记忆调度的枢纽 —— 检索在前（能想起什么），披露在这一层（能说什么）。
  // 两件事分开之后：
  //   · 她不会因为"别人的事查不到"而显得一无所知
  //   · 也不会因为"查到了就照念"而泄露隐私
  // SEALED 的条目直接不注入 —— 连暗示的机会都不给。
  const tagged = scored
    .map((x) => ({ ...x, level: disclosureFor(x.m, identity, subjects) }))
    .filter((x) => x.level !== DISCLOSURE.SEALED);

  if (!tagged.length) return { block: '', items: [] };

  const buckets = new Map();
  for (const { m, level } of tagged) {
    // 别人的事单独归一类，让她一眼看出「这不是关于我的」
    const k = level === DISCLOSURE.VAGUE && !subjects.includes(String(m.subject || ''))
      ? '别人的事（可以关心，别当谈资）'
      : groupLabel(m.subject);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ m, level });
  }

  // ── 脱敏用的第三方姓名清单 ────────────────────────────────────────
  // 注进「关于你自己」那一栏的内容是别处听来的，里面可能提到**第三个人**。
  // 当事人有权知道"有人在议论这件事"，但把第三方的名字交出去就等于
  // 把另一个人也拖进来（实测原实现会把「张三」原样注给小美本人）。
  //
  // 名单 = people 表里所有人的姓名 - 当事人自己。
  // 失败就返回空数组（脱敏退化为只剥来源前缀，不阻塞注入）。
  let crossNames = [];
  try {
    if (typeof store.listPeople === 'function') {
      const people = await store.listPeople();
      const cpKey = String(identity.counterpartId || '');
      crossNames = (people || [])
        // 按 personKey 排除当事人自己 —— 他的姓名不该被抹掉，
        // 我们要遮的是**别的第三方的名字**。
        .filter((p) => String(p.personKey || p.person_key || '') !== cpKey)
        .map((p) => String(p.displayName || p.display_name || '').trim())
        .filter((n) => n.length >= 2);
    }
  } catch {
    crossNames = [];
  }

  const lines = ['\n\n【你记得的事 · 请自然运用，不要照本宣科】'];
  if (identity.isGroup) {
    lines.push('（以下是你在当前场合被允许想起的内容。别人的私事此刻看不到，也不要去猜。）');
  }
  let hasAboutMe = false;
  let hasVague = false;
  let hasUnverified = false;
  for (const [label, items] of buckets) {
    lines.push(`· ${label}：`);
    for (const { m, level } of items) {
      if (level === DISCLOSURE.DEIDENTIFY) hasAboutMe = true;
      if (level === DISCLOSURE.VAGUE) hasVague = true;
      // 可信度与披露档位是两条独立的轴，两条提示都要给：
      //   披露档位回答「该不该说」，可信度回答「说的时候该不该带『听说』」。
      // 一条 OPEN 但 epistemic=rumor 的记忆，可以说，但绝不能说成事实。
      const epi = String(m.epistemic || 'fact');
      if (epi === 'hearsay' || epi === 'rumor') hasUnverified = true;
      // 披露档位决定**注入什么内容**，不只是加一句提示：
      //   OPEN       → 原文（这就是你的、你该知道的）
      //   DEIDENTIFY → 原文但抹掉第三方姓名（当事人有权知道内容，无权知道谁在说）
      //   VAGUE      → ★ 压成话题方向，原文根本不进 prompt
      // 最后一条是这次修的：原来 VAGUE 也注入原文，只靠一句「别讲出去」约束，
      // 那等于把细节交出去再嘱咐保密 —— 漏一轮就漏了。
      let body;
      if (level === DISCLOSURE.OPEN) {
        body = m.content;
      } else if (level === DISCLOSURE.DEIDENTIFY) {
        body = sanitizeForSubject(m.content, { dropNames: crossNames });
      } else {
        body = vagueGist(m.content, { dropNames: crossNames });
      }
      const hint = disclosureHint(level) + epistemicHint(epi);
      lines.push(`  - ${body}${hint}`);
    }
  }
  if (hasAboutMe) {
    lines.push(
      '（其中有几条是关于对方本人的，可能是别处听来的。可以关心，但不要说出是从谁那里知道的——通常对方也不希望别人在背后议论自己。若对方问起"你怎么知道"，就说是自己留意到的，或者说不太记得了，别点别人的名字。）',
    );
  }
  if (hasVague) {
    lines.push(
      '（标了「别人的事」的那几条：你确实知道，但**知道不等于该说**。对方主动问起、且问的是他该知道的部分，才可以给一点模糊的方向；否则就当没想起来。别拿别人的事当聊天素材。）',
    );
  }
  if (hasUnverified) {
    lines.push(
      '（标了「听来的」「别人在传」的那几条：**这些不是你确认过的事实**。有人说给你听，不等于它就是真的。讲的时候必须带上"听说""好像是"，别用确定的语气；对方要是追问细节或问是谁说的，就说记不清了。别人身上的负面事，尤其不能由你去坐实——传话的人和听的人都会怪你。）',
    );
  }
  lines.push('用法：这些是背景，不是台词。相关时自然带出，不相关就别硬提；也不要罗列成清单念给对方听。');
  lines.push('判断口径：**先想这句话说出去会不会伤到人，再想说不说**。拿不准就少说、或者只说感受不说事实。你不必把所有知道的都讲出来——真人也不会。');
  lines.push('还有一条：**别人说的不等于真的**。听到一句关于第三个人的话，先分清"这是事实"还是"这是他说的一面之词"——大部分时候是后者。');

  try {
    await store.touchMemory(tagged.map((x) => x.m.id));
  } catch {
    /* 计数失败忽略 */
  }
  return { block: lines.join('\n'), items: tagged.map((x) => x.m) };
}

/**
 * 从这句话里认出「对方正在问起谁」。
 *
 * 只在一对一里做。判据很克制：对方提到的人名/标识必须能在 people 表里对上，
 * 且不是他自己 —— 否则会把「随便一个词」当成一个人去翻记忆。
 *
 * @returns {Promise<Array<{key: string, name: string}>>}
 */
async function findAskedPersons(query, identity, storeOverride) {
  const text = String(query || '').trim();
  if (!text || text.length < 2) return [];
  const self = String(identity.counterpartId || '');

  let people = [];
  try {
    // 用调用方传进来的 store（默认才是真实存储）。
    // 老实现无条件 defaultStore()，导致「问起谁」这条路径在
    // 传入自定义 store 的场景（测试、子代理、离线重放）里静默失效。
    const store = storeOverride || defaultStore();
    if (typeof store.listPeople === 'function') people = await store.listPeople();
  } catch {
    return [];
  }
  if (!Array.isArray(people) || !people.length) return [];

  const hits = [];
  for (const p of people) {
    const key = String(p.personKey || p.person_key || '');
    if (!key || key === self) continue;
    const name = String(p.displayName || p.display_name || '').trim();
    // 有名字就按名字命中；没名字就按账号号命中（用户可能直接说「1658359753 怎么样」）
    const needle = name || key;
    if (needle.length >= 2 && text.includes(needle)) {
      hits.push({ key, name: name || key });
    }
  }
  return hits.slice(0, 3);
}

/**
 * 披露档位：这条记忆「能说到什么程度」。
 *
 * ── 为什么要有这一层（2026-11-20 用户定的原则）────────────────────
 *   「我觉得 agent 应该有一个统一的记忆调度系统，它需要根据自己一定程度上的
 *     思考和判断……既不是完全记忆隔离，也不是完全泄露隐私」
 *
 * 所以「能不能检索到」和「该不该说出来」是**两件事**，不能用一个布尔挡：
 *   · 硬隔离（查不到）→ 她想关心朋友时反而什么都不知道，朋友出事也察觉不到
 *   · 全放行（查得到且无标注）→ 模型分不清哪条是别人的私事，顺口就抖出来
 *
 * 这里给她的是**分级素材 + 明确的说话边界**，让她自己判断怎么开口。
 * 代码不做最终裁决，只负责把「这条的敏感程度」和「说的时候要守什么」
 * 一起交到她手上 —— 判断权在人（模型）身上，这符合用户说的"根据实际情况"。
 */
const DISCLOSURE = {
  /** 可以随便说，包括来源 */
  OPEN: 'open',
  /** 内容可以说，但不能说出"是谁告诉我的" */
  DEIDENTIFY: 'deidentify',
  /** 只能模糊处理（「听说你最近不太顺」），不能讲细节 */
  VAGUE: 'vague',
  /** 烂在肚子里：查到也不用，绝不能主动提 */
  SEALED: 'sealed',
};

/**
 * 判定一条记忆的披露档位。
 *
 * 输入是这条记忆 + 此刻的身份。输出是给模型的**指令**，不是给代码的分支。
 * 注意：这里**不看池子归属**决定"查不查得到"——那是 resolveSubjects 的事。
 * 这里只回答"假如她想起了这件事，该怎么用"。
 */
function disclosureFor(mem, identity, ownSubjects = []) {
  const subject = String(mem.subject || '');
  const vis = String(mem.visibility || 'private');
  const about = mem.aboutPerson == null ? null : String(mem.aboutPerson);
  const cp = String(identity.counterpartId || '');
  const isGroup = !!identity.isGroup;

  const aboutMe = !!cp && cp !== 'unknown' && about === cp;
  const inMyPool = ownSubjects.includes(subject);
  // 这条是「对方刚问起的那个人」的记忆（见 findAskedPersons）
  const askedAbout = !!mem._askedAbout;

  // ① 涉及密码/病史/财务这类硬红线 → 一律封死，群聊里更加封死
  if (vis === 'secret') {
    // 关于对方本人的私事，一对一里可以给到「模糊关心」的余地
    if (aboutMe && !isGroup) return DISCLOSURE.VAGUE;
    return DISCLOSURE.SEALED;
  }

  // ② 群里：一切非 public 都不许点名、不许讲细节
  if (isGroup) {
    if (vis === 'public') return DISCLOSURE.OPEN;
    return DISCLOSURE.SEALED;
  }

  // ③ 一对一里，关于「此刻这个人」的事：
  //    他知道别人知道他这件事本身是合理的（"有人提过你的近况"），
  //    但来源必须脱敏。这就是原有的 _aboutMe 机制，升级成显式档位。
  if (aboutMe) {
    // 是我自己池里的事 → 直说无妨
    if (inMyPool) return DISCLOSURE.OPEN;
    // 从别人池里浮现的 → 能关心，但不能说谁讲的
    return DISCLOSURE.DEIDENTIFY;
  }

  // ④ 对方主动问起了某个人：允许给到「模糊但有信息量」的程度。
  //    用户要的正是这个 —— 问起来要答得上，但不能变成背档案。
  if (askedAbout) {
    // 他自己池里已有的（= 他跟这个人的事），本来就能说
    if (inMyPool) return DISCLOSURE.OPEN;
    return DISCLOSURE.VAGUE;
  }

  // ⑤ 别人的私事（不是关于此刻这个人，也不在我自己的池里）
  if (!inMyPool) {
    // 转述别人的私事：可以知道、可以用来理解关系，但不能当谈资
    return DISCLOSURE.VAGUE;
  }

  // ⑤.5 在我自己的池里，但内容是**关于第三方的传闻**。
  //      这是「谁在说话」真正该起作用的地方：他跟我讲的别人私事，
  //      我知道归知道，但不该由我转手讲给下一个人听。
  //      注意这不是封死 —— 是降到「可以关心、别讲细节」。
  const epi = String(mem.epistemic || 'fact');
  if (about && about !== cp && (epi === 'rumor' || epi === 'hearsay') && vis !== 'public') {
    return DISCLOSURE.VAGUE;
  }

  // ⑥ 我自己池里、关于别人的事 —— 正常可用，但不必主动扩散
  return DISCLOSURE.OPEN;
}

/**
 * 把披露档位翻译成「给她看的说话边界」。
 * 每档都写清楚「能做什么」和「不能做什么」，让判断有依据而不是靠猜。
 */
function disclosureHint(level) {
  switch (level) {
    case DISCLOSURE.OPEN:
      return '';
    case DISCLOSURE.DEIDENTIFY:
      return '｜可以说这件事，但**别说从谁那里知道的**。对方追问就说是自己留意到的，或者说记不太清了。';
    case DISCLOSURE.VAGUE:
      return '｜这是别人的事。可以关心、可以顺着问，但**别把细节讲出去**，也别评价当事人。用模糊的说法带过。';
    case DISCLOSURE.SEALED:
      return '｜极私密，**烂在心里**。不要提、不要暗示、不要顺着问。';
    default:
      return '';
  }
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

  // ★ 2026-11-20 身份排查：拦住「用户私事被写进共享 self:: 池」。
  // 模型很容易把「对方让我记住的事」标成 scope=self（因为它以为那是"关于主人"），
  // 而 self:: 池的键是账号 uid，对所有人都是 1 —— 一写进去，所有用户共享。
  // 线上已经真实发生过：朋友的私事进了 self::1，主人对话时读到了。
  // 这里在落库前重新定归属：不是关于 Kirari 自己的事，就归到对话者自己的池。
  const rehomed = rehomeSelfSubject(subject, identity, content);

  // 身份不明（解析不出对话者）时，rehomeSelfSubject 返回 null。
  // 这种时候**宁可不记，也不能落共享池**：
  //   · 落 self::1 → 所有用户共享，线上事故的老路
  //   · 落 person::unknown → 所有"身份不明"的人共享，另一条同样的通道
  // 返回 ok:false 让模型知道"这人我还没认出来，先问清楚再记"，
  // 而不是悄悄存进一个她自己都分不清是谁的池子里。
  if (rehomed === null) {
    return { ok: false, reason: 'unknown_subject' };
  }
  subject = rehomed;

  // ★ 同源漏洞的另一半：`person::unknown` 也是一个全员共享池。
  // 读侧 resolveSubjects 用 `!== 'unknown'` 把它挡在可读池之外（好设计），
  // 但写侧没有对称保护 —— 所有"解析不出对话者"的人都会写进同一个
  // person::unknown。而 isMemoryVisible 对 person:: 的判据是
  // `subject.slice(8) !== cp`，当 cp 恰好是 'unknown' 时比较通过，
  // 于是这块池对该用户反而可读。读写两侧必须对称，否则就是另一条泄露通道。
  if (subject === PERSON('unknown') || subject === PERSON('')) {
    return { ok: false, reason: 'unknown_subject' };
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

  // ★ 可信度：这条信息到底有多可信。
  //   「谁在说话」在这里起作用 —— 但它是**加权**，不是「能不能存」的开关。
  //   随便一个人说「小张出轨了」：这条值得记（她要知道有人在传），
  //   但它是 rumor，不是 fact。存下来但带标记，她回答时自然会带「听说」。
  let epi = epistemicFor(input, identity, subject, content);

  // ── 大模型复核（用户要求：「必要时需要大模型思考和二次确认」）────────
  // 正则只认字面，遇到否定句（「小张没出轨，别乱说」）、转述层级
  // （「听说他说……」）、或拿不准的第三人称指代就会判错。
  // 所以在**拿不准或风险高**的时候（见 memoryJudge.shouldConsult），
  // 让模型真的读一遍，并且只允许它往更保守的方向修。
  //
  // 安全约束（memoryJudge.judgeMemory 内强制）：
  //   · 模型故障/超时 → 静默保留启发式结果，绝不阻塞写入
  //   · 想把涉及第三方的信息认定为 fact → 必须过二次确认
  //   · 任何情况下 epistemic 都不会因模型调用而变得比启发式更乐观
  if (ctx.aiContext) {
    try {
      const judge = require('../ai/memoryJudge');
      const negativeHit = /(出轨|劈腿|偷|抢|骗|欠钱|欠债|赌|吸毒|酗酒|酒驾|坐牢|进监狱|生病|癌|抑郁症|精神病|自杀|离婚|分手|被开除|被辞退|被拘留|作风|人品|私生活|包养|怀孕|堕胎|整容|整形|偷情|小三|不三不四|虚伪|造谣|骗人)/.test(
        content,
      );
      const verdict = await judge.judgeMemory({
        aiContext: ctx.aiContext,
        content,
        identity,
        heuristicLevel: epi.epistemic,
        negativeHit,
        aboutPerson,
      });
      if (verdict && verdict.epistemic) {
        epi = { ...epi, epistemic: verdict.epistemic };
        // 归属也能被模型纠正：模型认定为「说她自己」时，才允许重新落进共享池。
        // 注意方向 —— 只有「明确判定为 kirari」才允许从 person 池搬回 self 池，
        // 其余情况一律保持 rehomeSelfSubject 的「归人不归己」。
        if (verdict.subjectKind === 'kirari' && subject.startsWith('person::')) {
          subject = SELF(identity.uid);
        }
      }
    } catch (e) {
      // 复核层任何异常都不许影响写入 —— 这是硬约束。
      console.warn(`[memory] 可信度复核失败（已退化为启发式）: ${e?.message || e}`);
    }
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
    epistemic: epi.epistemic,
    claimedBy: epi.claimedBy,
  });
  return { ok: !!id, id: id || undefined, epistemic: epi.epistemic };
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
  DISCLOSURE,
  disclosureFor,
  disclosureHint,
  /** 可信度四档（fact / observed / hearsay / rumor），与 DISCLOSURE 正交 */
  EPISTEMIC,
  epistemicFor,
  epistemicHint,
  findAskedPersons,
  rehomeSelfSubject,
  /** 注入前脱敏（去处来源 + 第三方姓名），供测试与跨池注入复用 */
  sanitizeForSubject,
  vagueGist,
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
