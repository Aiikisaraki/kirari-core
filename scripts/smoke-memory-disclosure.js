#!/usr/bin/env node
/**
 * smoke-memory-disclosure.js — 验证记忆调度是「有判断的选择性披露」，不是硬隔离。
 *
 * ── 用户定的口径（2026-11-20）────────────────────────────────────
 *   「我觉得 agent 应该有一个统一的记忆调度系统，它需要根据自己一定程度上的
 *     思考和判断，假如我问 agent 一个关于别人的事，agent 我希望是根据实际情况
 *     做出有选择性的回答，既不是完全记忆隔离，也不是完全泄露隐私」
 *
 * 所以这个测试同时验证两头：
 *   ✅ 不是完全隔离 —— 问起别人时，关于他的事**要能检索到**
 *   ✅ 不是完全泄露 —— 但每条都带「能说到什么程度」的边界，私密条目不注入
 *   ✅ 归属正确 —— 各人的私事进各人的池，不进共享池
 *
 * 用法：node scripts/smoke-memory-disclosure.js
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// 独立数据目录，别碰真实库
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-memdisc-'));
process.env.KIRARI_HOME = TMP_HOME;
process.env.KIRARI_DATA_DIR = TMP_HOME;

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}
function section(t) { console.log(`\n=== ${t} ===`); }

async function main() {
  const memory = require(path.join(ROOT, 'src/services/memory'));

  // ── 1. 写入端：各人的私事必须进各人的池，不能进共享 self:: 池 ──────
  section('1. 写入归属：私事不进共享池');

  const ownerCtx = { sessionId: 'bot-a-private:1980308740', counterpartId: '1980308740', role: 'owner', uid: 1 };
  const friendCtx = { sessionId: 'bot-a-private:1658359753', counterpartId: '1658359753', role: 'user', uid: 1 };

  // 这正是线上真实发生过的那条：朋友的私事被标成 scope=self
  const r1 = await memory.remember({
    content: '想改掉啥都说的毛病：在公众场合控制音量，不跟家人在外人面前争吵，不随便吐槽家里事',
    scope: 'self',
    visibility: 'private',
  }, friendCtx);
  check('朋友的私事记住了', r1.ok === true);

  const listed = await memory.list(friendCtx, { limit: 100 });
  const rec = (Array.isArray(listed) ? listed : (listed.items || []))
    .find((m) => String(m.content).includes('啥都说'));
  check('这条记忆存在', !!rec);
  check('★ 没有落进共享的 self:: 池',
    !!rec && !String(rec.subject).startsWith('self::'),
    rec ? `subject=${rec.subject}` : '未找到');
  check('★ 落进了朋友自己的 person 池',
    !!rec && String(rec.subject) === 'person::1658359753',
    rec ? `subject=${rec.subject}` : '未找到');

  // 真的是关于 Kirari 自己的事，留在 self 池才合理
  const r2 = await memory.remember({
    content: '她的设定是说话简短、不卖萌、遇到不懂的会直接说不懂',
    scope: 'self',
  }, ownerCtx);
  check('关于她自己的事记住了', r2.ok === true);

  // ── 2. 披露档位：分级而不是一刀切 ────────────────────────────────
  section('2. 披露档位：四种程度，不是二元开关');

  const D = memory.DISCLOSURE;
  check('有四种披露档位', Object.keys(D).length === 4, Object.keys(D).join(','));

  // 关于对方自己的事，从别人池里浮现 → 可以关心但不能说来源
  const aboutThisPerson = { subject: 'person::999', visibility: 'private', aboutPerson: '1658359753', content: '有人提过你最近压力大' };
  const lv1 = memory.disclosureFor(aboutThisPerson, { counterpartId: '1658359753', role: 'user', isGroup: false }, ['person::1658359753']);
  check('关于本人的转述 → DEIDENTIFY（可说事实，不可说来源）', lv1 === D.DEIDENTIFY, lv1);

  // 别人的私事
  const othersPrivate = { subject: 'person::999', visibility: 'private', content: '他家里出了点事' };
  const lv2 = memory.disclosureFor(othersPrivate, { counterpartId: '1658359753', role: 'user', isGroup: false }, ['person::1658359753']);
  check('别人的私事 → VAGUE（只能模糊关心）', lv2 === D.VAGUE, lv2);

  // 硬红线
  const secret = { subject: 'person::999', visibility: 'secret', content: '他的银行卡密码是 xxx' };
  const lv3 = memory.disclosureFor(secret, { counterpartId: '1658359753', role: 'user', isGroup: false }, ['person::1658359753']);
  check('secret 且不是关于本人 → SEALED（烂在心里）', lv3 === D.SEALED, lv3);

  // 群里
  const inGroup = { subject: 'person::999', visibility: 'private', content: '他最近在闹离婚' };
  const lv4 = memory.disclosureFor(inGroup, { counterpartId: '1658359753', role: 'user', isGroup: true }, []);
  check('群聊里的私事 → SEALED', lv4 === D.SEALED, lv4);

  // 自己池里的公开事
  const ownPublic = { subject: 'person::1658359753', visibility: 'private', content: '他喜欢猫' };
  const lv5 = memory.disclosureFor(ownPublic, { counterpartId: '1658359753', role: 'user', isGroup: false }, ['person::1658359753']);
  check('自己池里的事 → OPEN（可以直说）', lv5 === D.OPEN, lv5);

  // 每条都有人话边界
  check('每个非 OPEN 档位都有说话边界说明',
    [D.DEIDENTIFY, D.VAGUE, D.SEALED].every((l) => memory.disclosureHint(l).length > 0));
  check('OPEN 档不啰嗦', memory.disclosureHint(D.OPEN) === '');

  // ── 3. ★ 不是完全隔离：问起别人时能检索到 ──────────────────────────
  section('3. 不是完全隔离：问起别人要答得上');

  const owner2 = '1111111111';
  const third = '2222222222';

  // 主人把「关于第三人的事」讲给了机器人（存在主人池里）
  await memory.remember({
    content: '小张最近在换工作，压力挺大的',
    scope: 'person',
    subjectId: owner2,
    aboutPerson: third,
    visibility: 'private',
  }, { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 });

  // 主人自己问起「小张」
  const asked = await memory.findAskedPersons('小张最近怎么样啊', { counterpartId: owner2 });
  check('能认出对方在问谁', Array.isArray(asked), `命中 ${asked.length} 个`);

  // 关键：主人自己池里关于小张的事，检索得到、且可直说
  const memBlockOwn = await memory.buildMemoryBlock(
    { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 },
    '小张最近怎么样',
  );
  check('★ 问起别人时，确实检索到了相关内容（不是完全隔离）',
    String(memBlockOwn.block).includes('小张') || (memBlockOwn.items || []).length > 0,
    `命中 ${(memBlockOwn.items || []).length} 条`);

  // ── 4. ★ 不是完全泄露：别人问不出第三人的私事 ────────────────────
  section('4. 不是完全泄露：别人套不出第三人的私事');

  const stranger = '3333333333';
  const memBlockStranger = await memory.buildMemoryBlock(
    { sessionId: `bot-a-private:${stranger}`, counterpartId: stranger, role: 'user', uid: 1 },
    '小张最近怎么样',
  );
  const leaked = String(memBlockStranger.block).includes('换工作');
  check('★ 陌生人问起小张，拿不到「换工作」这个细节',
    !leaked,
    leaked ? '泄露了具体内容' : '未泄露');

  // ── 4.5 ★ VAGUE 档必须是「话题方向」，不是原文 ──────────────────
  //
  // 这是「既不是完全隔离，也不是完全泄露」里最容易做错的一半：
  // 旧实现对 VAGUE 注原文 + 附一句「别讲出去」，等于先把秘密交出去再嘱咐保密。
  section('4.5 ★ VAGUE 档只给话题方向，原文不进 prompt');

  const gistCases = [
    ['她妈妈下周要做手术，费用还差三万', ['手术', '妈妈', '三万'], '身体状况'],
    ['小美跟张三在偷偷交往', ['交往', '张三'], '感情'],
    ['老板上个月把我辞退了，房贷还不上了', ['辞退', '房贷'], null],
  ];
  for (const [src, secrets, wantLabel] of gistCases) {
    const g = memory.vagueGist(src);
    const leakedFrag = secrets.filter((s) => g.includes(s));
    check(`★ 「${src.slice(0, 10)}…」压缩后不泄原词`,
      leakedFrag.length === 0,
      leakedFrag.length ? `泄露了：${leakedFrag.join('/')}` : `→ ${g}`);
    if (wantLabel) {
      check(`  └ 认得出是「${wantLabel}」这一类`, g.includes(wantLabel), g);
    }
  }

  // 通用断言：输出里不许出现原文的任意连续 4 字片段
  const anyFragment = memory.vagueGist('她老公欠了赌债，孩子还不知道');
  let fragmentLeaked = '';
  const raw = '她老公欠了赌债';
  for (let i = 0; i + 4 <= raw.length; i++) {
    const frag = raw.slice(i, i + 4);
    if (anyFragment.includes(frag)) { fragmentLeaked = frag; break; }
  }
  check('★ 输出不含原文任何连续 4 字片段',
    !fragmentLeaked,
    fragmentLeaked ? `泄露片段：${fragmentLeaked}` : `→ ${anyFragment}`);

  // ── 5. 注入块必须带判断口径 ──────────────────────────────────────
  section('5. 注入块带「判断口径」，让她自己权衡');
  const ctxUser = { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'user', uid: 1 };
  const blk = await memory.buildMemoryBlock(ctxUser, '小张');
  if (blk.block) {
    check('注入块写了「先想会不会伤到人」的判断口径',
      blk.block.includes('伤到人'), '');
    check('注入块明确「不必把所有知道的都讲出来」',
      blk.block.includes('不必把所有知道的都讲出来'), '');
  } else {
    check('（本轮无记忆命中，跳过注入块措辞检查）', true);
  }

  // ── 6. SEALED 条目绝不注入 ───────────────────────────────────────
  section('6. SEALED 条目不进上下文');

  await memory.remember({
    content: '他的身份证号和家庭住址都在资料里，是机密',
    scope: 'person',
    subjectId: owner2,
    aboutPerson: third,
    visibility: 'secret',
  }, { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 });

  const blkSealed = await memory.buildMemoryBlock(
    { sessionId: `bot-a-private:${stranger}`, counterpartId: stranger, role: 'user', uid: 1 },
    '身份证 住址 小张',
  );
  check('★ 机密内容没有被注入给无关的人',
    !String(blkSealed.block).includes('身份证号'),
    String(blkSealed.block).includes('身份证号') ? '泄露' : '未泄露');

  // ── 7. ★ 可信度：传闻不能当事实存 ────────────────────────────────
  // 用户原话：「谁在说话也是一个很重要的考量，要是我随便说一个别人的信息
  // 怎么办，这万一不是事实呢」
  section('7. 可信度轴：别人说的 ≠ 事实');

  // 7.1 普通用户转述第三人的负面私事 → rumor
  const r7a = await memory.remember({
    content: '小张好像出轨了，他老婆还不知道',
    scope: 'person',
    subjectId: stranger,
    aboutPerson: third,
  }, { sessionId: `bot-a-private:${stranger}`, counterpartId: stranger, role: 'user', uid: 1 });
  check('★ 普通用户传的他人负面私事被标成 rumor（不是 fact）',
    r7a.ok && r7a.epistemic === 'rumor',
    `epistemic=${r7a.epistemic}`);

  // 7.2 当事人自述自己的事 → fact（对自己最有发言权）
  const r7b = await memory.remember({
    content: '我最近在准备换工作，投了几份简历',
  }, { sessionId: `bot-a-private:${stranger}`, counterpartId: stranger, role: 'user', uid: 1 });
  check('★ 当事人自述自己的事记成 fact',
    r7b.ok && r7b.epistemic === 'fact',
    `epistemic=${r7b.epistemic}`);

  // 7.3 第三方客观小事 → hearsay（不是 rumor，也不是 fact）
  const r7c = await memory.remember({
    content: '小张养了一只橘猫',
    scope: 'person',
    subjectId: owner2,
    aboutPerson: third,
  }, { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'user', uid: 1 });
  check('第三方客观小事标成 hearsay',
    r7c.ok && r7c.epistemic === 'hearsay',
    `epistemic=${r7c.epistemic}`);

  // 7.4 ★ 身份是加权不是开关：主人说第三人客观事实 → fact
  const r7d = await memory.remember({
    content: '小张在一家做工业软件的公司上班',
    scope: 'person',
    subjectId: owner2,
    aboutPerson: third,
  }, { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 });
  check('主人陈述第三人客观事实可以记成 fact',
    r7d.ok && r7d.epistemic === 'fact',
    `epistemic=${r7d.epistemic}`);

  // 7.5 ★ 但主人说的他人负面私事仍然不能升到 fact —— 一面之词就是一面之词
  const r7e = await memory.remember({
    content: '小张欠了一屁股赌债',
    scope: 'person',
    subjectId: owner2,
    aboutPerson: third,
  }, { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 });
  check('★ 主人说的他人负面私事也不升 fact（不能替一面之词背书）',
    r7e.ok && r7e.epistemic === 'rumor',
    `epistemic=${r7e.epistemic}`);

  // 7.6 传闻在注入时必须带「听说」标记
  const blkRumor = await memory.buildMemoryBlock(
    { sessionId: `bot-a-private:${owner2}`, counterpartId: owner2, role: 'owner', uid: 1 },
    '小张 赌博 赌债',
  );
  check('★ 传闻注入时带上「听来的」措辞边界',
    String(blkRumor.block).includes('听来的') || String(blkRumor.block).includes('别人在传'),
    '');
  check('注入块明确「别人说的不等于真的」',
    String(blkRumor.block).includes('别人说的不等于真的'), '');

  // 7.7 epistemicHint 四档措辞齐全
  check('fact 不带任何削弱措辞', memory.epistemicHint('fact') === '', '');
  check('hearsay 要求带「听说」',
    memory.epistemicHint('hearsay').includes('听说'), '');
  check('rumor 要求不当事实讲',
    memory.epistemicHint('rumor').includes('真假未知'), '');

  // ── 8. 身份隔离大排查的残留漏洞（2026-11-20 审计 A3/A3b/A4/B1）────
  //
  // 这一节钉死的是「审计发现的、上一轮补丁没修干净的那几条」。
  // 其中 A3 就是用户最初报障的真实路径，必须长期防回归。
  section('8. 审计残留漏洞：指代歧义 / unknown 共享池 / 跨池注入');

  const friend = { role: 'user', counterpartId: '1658359753', uid: 1 };

  // 8.1 ★ A3：指代歧义 —— 「我」永远指说话人，不是 Kirari
  //
  // 老实现把 `我(心情|设定|人格...)` 判成「关于 Kirari 自己」，于是朋友说
  // 「我心情很糟」被留在 self::1 这个全员共享池，主人下次开口就读到了。
  // 这正是线上报障的原始路径。
  for (const [content, wantShare] of [
    ['我心情很糟', false],
    ['我今天跟我妈吵架了', false],
    ['我妈妈说我不听话', false],
    ['我设定里有个毛病', false], // 有歧义 → 宁可归人
    ['Kirari 的设定里她怕黑', true],
    ['她的性格应该更温柔', true],
  ]) {
    const out = memory.rehomeSelfSubject('self::1', friend, content);
    const isShared = out === 'self::1';
    check(`★ 指代归属：「${content}」→ ${wantShare ? '共享池' : '本人池'}`,
      isShared === wantShare,
      `实际=${out}`);
  }

  // 8.2 ★ A3：身份不明时必须拒绝写，不能落共享池
  for (const cp of ['', 'unknown', null, undefined]) {
    const out = memory.rehomeSelfSubject('self::1', { role: 'user', counterpartId: cp, uid: 1 }, '我妈住院了');
    check(`★ 身份不明（cp=${JSON.stringify(cp)}）时拒绝落共享池`, out === null, `实际=${out}`);
  }

  // 8.3 ★ A3b：person::unknown 是第三个共享池，读侧必须 fail-closed
  check('★ cp=unknown 读 person::unknown → 不可见',
    memory.isMemoryVisible({ subject: 'person::unknown', visibility: 'private' },
      { counterpartId: 'unknown' }) === false, '');
  check('★ cp=unknown 读 self::1 → 不可见',
    memory.isMemoryVisible({ subject: 'self::1', visibility: 'private' },
      { counterpartId: 'unknown' }) === false, '');
  check('cp=unknown 仍可读 global public（没有过度封锁）',
    memory.isMemoryVisible({ subject: 'global', visibility: 'public' },
      { counterpartId: 'unknown' }) === true, '');

  // 8.4 ★ A4：别人的私事注给当事人时，第三方姓名必须脱敏
  //
  // 场景：阿强(777) 私下说「小美跟张三在偷偷交往」，aboutPerson=小美(999)。
  // 小美本人出现时有权知道"有人在议论这件事"，但**张三这个名字**不该给他。
  // 老实现 sanitizeForSubject 只剥行首「A说」，句中「张三」原样泄露。
  const sanitized = memory.sanitizeForSubject('小美跟张三在偷偷交往', { dropNames: ['张三'] });
  check('★ 句中第三方姓名被脱敏',
    !sanitized.includes('张三'), `结果=${sanitized}`);
  check('脱敏后仍有信息量（不是全抹掉）',
    sanitized.includes('交往'), `结果=${sanitized}`);

  // 8.5 ★ B1：问起别人时，转述在**别人池里**的记忆也要检索到
  //
  // 这是「有选择性地回答关于别人的问题」的核心路径。老实现只查
  // person::{被问者} 自己的池，而"A 转述的关于 C 的事"存在 A 的池里，
  // 于是这段逻辑成了死代码 —— 主人问「小美最近怎么样」，一个字都答不上来。
  const fakeStore = {
    async listMemories(subjects) {
      return [
        { id: 901, subject: 'person::777', visibility: 'private', aboutPerson: '999', content: '小美跟张三在偷偷交往', epistemic: 'rumor' },
      ].filter((x) => subjects.includes(x.subject));
    },
    async listMemoriesAbout(pk) {
      return [
        { id: 901, subject: 'person::777', visibility: 'private', aboutPerson: '999', content: '小美跟张三在偷偷交往', epistemic: 'rumor' },
      ].filter((x) => String(x.aboutPerson) === String(pk));
    },
    async expandLinks() { return []; },
    async touchMemory() {},
    async listPeople() {
      return [
        { personKey: '999', displayName: '小美' },
        { personKey: '777', displayName: '阿强' },
        { personKey: '888', displayName: '张三' },
      ];
    },
  };
  const askerCtx = { sessionId: 'bot-a-private:1980308740', counterpartId: '1980308740', role: 'owner', uid: 1, store: fakeStore };
  const askedBlk = await memory.buildMemoryBlock(askerCtx, '小美最近怎么样');
  // ⚠️ 这两条以前写的是「注入块里能看到『交往』」—— 那正是要修的旧行为。
  //    「能检索到」≠「能看到原文」：她要能想起"关于这个人有件感情上的事"
  //    （否则就是完全隔离），但不能拿到可以复述的细节（否则就是完全泄露）。
  check('★ 问起别人时跨池转述能被检索到（不是完全隔离）',
    askedBlk.items.length > 0, `items=${askedBlk.items.length}`);
  check('★ 但注入的是话题方向，不是原文（不是完全泄露）',
    String(askedBlk.block).includes('感情') && !String(askedBlk.block).includes('交往'),
    `block=${String(askedBlk.block).replace(/\s+/g, ' ').slice(0, 120)}`);
  check('★ 且被标成「别人的事／别讲细节」的模糊档',
    String(askedBlk.block).includes('别人的事') || String(askedBlk.block).includes('别把细节讲出去'), '');

  // 8.6 群里绝不出现跨池转述
  const groupCtx = { sessionId: 'bot-a-group:1:999', counterpartId: '999', role: 'user', uid: 1, isGroup: true, store: fakeStore };
  const inGroupBlk = await memory.buildMemoryBlock(groupCtx, '小美 交往');
  check('★ 群聊里跨池转述一律不注入',
    !String(inGroupBlk.block).includes('交往'), '');

  // ── 收尾 ────────────────────────────────────────────────────────
  try {
    const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
    const db = dbStorage.getDb ? dbStorage.getDb() : null;
    if (db && typeof db.close === 'function') db.close();
  } catch { /* 已关 */ }
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.warn(`  （临时目录未删：${TMP_HOME}）`);
  }

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}（共 ${checks} 项检查）\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
