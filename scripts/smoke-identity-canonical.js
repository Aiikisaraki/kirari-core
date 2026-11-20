#!/usr/bin/env node
/**
 * smoke-identity-canonical.js — 身份归一化（canonical identity）回归测试。
 *
 * ── 为什么单独有这个脚本 ─────────────────────────────────────────────
 * 用户 2026-11-20 连着说了两句：
 *   「既然三个入口是一个身份，那我不管哪个入口都可以应该看得到啊，
 *     你这bug也太多了」
 *   「还是打补丁，你要考虑一下还有没有其他是主人但是没被存为 _local 的情况，
 *     也一并处理掉，我们要规范化编码了」
 *
 * 她点出的真问题是：同一个主人，系统里有四种写法（QQ 号 / '_local' /
 * 本机会话 UUID / uid=1）。每次出故障都是「在某一行比较时少补了一个 ||」，
 * 于是人工在那一行打补丁，下一条语句又漏。这个脚本把归一化本身钉成测试：
 *
 *   ① 所有等价写法归一后**必须相等**（否则主人被劈成几个人）
 *   ② 客人身份归一后**必须不等于主人**（否则隔离被抹掉，比原 bug 更严重）
 *   ③ 空值归一后必须是 ''（绝不默认成主人）
 *
 * 用法：node scripts/smoke-identity-canonical.js
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-canon-'));
process.env.KIRARI_HOME = TMP_HOME;
process.env.KIRARI_DATA_DIR = TMP_HOME;

const OWNER_QQ = '1980308740';   // 生产 people 表：role=owner
const FRIEND_QQ = '1658359753';  // 生产 people 表：role=user

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

async function main() {
  // 先把本机会话文件写好，模拟真实装机（身份归一要用它）
  const LOCAL_SID = '9284e4f6-7123-4577-bb69-d788bd1cadce';
  fs.mkdirSync(TMP_HOME, { recursive: true });
  fs.writeFileSync(path.join(TMP_HOME, 'local-session.json'), JSON.stringify({ sessionId: LOCAL_SID }));

  const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
  // 设主人：people 表 role='owner'
  await dbStorage.upsertPerson({ personKey: OWNER_QQ, role: 'owner', displayName: '主人' });
  await dbStorage.upsertPerson({ personKey: FRIEND_QQ, role: 'user', displayName: '朋友' });

  const ownerIdentity = require(path.join(ROOT, 'src/services/ownerIdentity'));

  // ── 0. 前提：规范键取到的是 QQ 号，不是 '_local' ──────────────────────
  section('0. 规范身份键来源');
  check('getOwnerKey() 是 people 表里的 owner', ownerIdentity.getOwnerKey() === OWNER_QQ,
    `实际 ${ownerIdentity.getOwnerKey()}`);

  // ── 1. ★ 所有「其实就是主人」的写法必须归一成同一个键 ─────────────────
  section('1. 主人身份的等价写法（必须全部相等）');

  const ownerWrittenForms = [
    [OWNER_QQ, '规范 QQ 号'],
    ['_local', '历史别名 _local（本次 bug 的直接原因）'],
    ['local', '小写 local'],
    ['uid=1', '数据库 uid'],
    ['1', '裸 uid'],
    ['__builtin__', '内置账户名'],
    [LOCAL_SID, '本机会话 UUID（主人 QQ 私聊并进来的那个）'],
    [`net:device-a:${LOCAL_SID}`, 'net: 包装的本机会话'],
    ['session_1795089710522', '桌面 WS 会话键'],
    ['console-abc123', '控制台会话键'],
    ['  1980308740  ', '带空白'],
  ];

  const canonicalOwner = ownerIdentity.getOwnerKey();
  for (const [raw, desc] of ownerWrittenForms) {
    const got = ownerIdentity.canonicalIdentity(raw);
    check(`${desc} → 规范键`, got === canonicalOwner, `canonicalIdentity(${JSON.stringify(raw)}) = ${JSON.stringify(got)}`);
  }

  // ── 2. ★ samePerson 断言：这些写法两两之间都是同一个人 ────────────────
  section('2. samePerson：等价写法互相比对');
  for (let i = 0; i < ownerWrittenForms.length; i++) {
    for (let j = i + 1; j < ownerWrittenForms.length; j++) {
      const [a, da] = ownerWrittenForms[i];
      const [b, db] = ownerWrittenForms[j];
      check(`samePerson(${da}, ${db})`, ownerIdentity.samePerson(a, b) === true);
    }
  }

  // ── 3. ★ 客人绝不能被归一成主人（红线，比原 bug 更严重）───────────────
  section('3. 客人隔离红线（归一不得抹平隔离）');
  check('客人 QQ 号 ≠ 主人', ownerIdentity.canonicalIdentity(FRIEND_QQ) === FRIEND_QQ,
    `canonicalIdentity(${FRIEND_QQ}) = ${JSON.stringify(ownerIdentity.canonicalIdentity(FRIEND_QQ))}`);
  check('samePerson(客人, 主人) === false', ownerIdentity.samePerson(FRIEND_QQ, OWNER_QQ) === false);
  check('samePerson(客人, _local) === false', ownerIdentity.samePerson(FRIEND_QQ, '_local') === false);
  check('samePerson(客人, 本机UUID) === false', ownerIdentity.samePerson(FRIEND_QQ, LOCAL_SID) === false);

  // 客人的平台会话也不能被归一到主人
  const guestSessions = [
    'bot-bot-mvwi1tw3-x1b5-private:1658359753',
    'workspace:1658359753:每日提醒-说话分寸',
    'sub::1658359753::task-1',
    'net:device-b:bot-bot-x-private:1658359753',
  ];
  for (const sid of guestSessions) {
    const got = ownerIdentity.canonicalIdentity(sid);
    check(`客人会话不被归一成主人：${sid.slice(0, 42)}`,
      got !== canonicalOwner && got !== ownerIdentity.canonicalIdentity('_local'),
      `→ ${JSON.stringify(got)}`);
  }

  // ── 4. ★ 空值绝不当成主人 ─────────────────────────────────────────────
  section('4. 空值 fail-closed');
  for (const v of ['', '   ', null, undefined]) {
    check(`canonicalIdentity(${JSON.stringify(v)}) === ''`, ownerIdentity.canonicalIdentity(v) === '');
  }
  check('samePerson(空, 主人) === false', ownerIdentity.samePerson('', OWNER_QQ) === false);
  check('samePerson(主人, 空) === false', ownerIdentity.samePerson(OWNER_QQ, '') === false);

  // ── 5. ★ 真实报障场景复现：主人 QQ 私聊设的提醒必须能送到 ─────────────
  section('5. 报障复现：主人 QQ 私聊建的提醒（本次 bug 的原始场景）');
  const taskRuntime = require(path.join(ROOT, 'src/services/taskRuntime'));
  const { jobStore } = require(path.join(ROOT, 'src/session/jobStore'));

  // 主人的会话已经是本机会话 UUID（botManager 把主人私聊并进主对话的结果）
  const ownerCtx = {
    sessionId: LOCAL_SID,
    uid: 1,
    origin: 'core',
    role: 'owner',
    displayName: '主人',
  };
  const res = await taskRuntime.handleScheduleReminder(
    { title: '测试提醒', text: '一分钟后到', delayMs: 60000 },
    ownerCtx,
  );
  check('提醒创建成功', /已设好提醒/.test(String(res)), String(res).slice(0, 60));

  const jobs = jobStore.list(LOCAL_SID, 50) || [];
  const job = jobs.find((j) => String(j.title) === '测试提醒');
  check('提醒已落库', !!job);
  if (job) {
    check('落库的 ownerKey 是规范键（不是 _local）',
      String(job.ownerKey) === canonicalOwner,
      `实际 ${JSON.stringify(job.ownerKey)}`);
    check('落库的 ownerKey 能认成主人',
      ownerIdentity.samePerson(job.ownerKey, ownerIdentity.getOwnerKey()) === true);
  }

  // ── 6. ★ 历史脏数据：_local 的老 job 也要能被认成主人 ─────────────────
  section('6. 历史脏数据兼容（库里已存成 _local 的老提醒）');
  const legacyJob = {
    jobId: 'job-legacy-local-0001',
    sessionId: LOCAL_SID,
    origin: 'core',
    uid: 1,
    ownerKey: '_local',   // 老数据就是这么存的
    kind: 'reminder',
    title: '老的起床提醒',
    payload: '起床啦',
    dueAt: Date.now() + 60000,
    recurrence: 'once',
    status: 'fired',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobStore.save(legacyJob, 'job_created');

  // 关键：投递判定必须认得出这是主人（否则就是本次 bug 原样复现）
  check('老 job（ownerKey=_local）仍被认成主人',
    ownerIdentity.samePerson(legacyJob.ownerKey, ownerIdentity.getOwnerKey()) === true,
    `samePerson('_local', '${OWNER_QQ}')`);

  // ── 7. ★ 投递闸门：主人消息上桌面、客人消息不上 ───────────────────────
  section('7. 桌面投递闸门（socketServer.shouldDeliverToConn 语义）');
  // 直接复用归一化后的语义断言（shouldDeliverToConn 内部就调 samePerson）
  const ownerMsgVariants = ['_local', LOCAL_SID, OWNER_QQ];
  for (const want of ownerMsgVariants) {
    check(`want=${want === LOCAL_SID ? '本机UUID' : want} 被认成主人消息`,
      ownerIdentity.samePerson(want, ownerIdentity.getOwnerKey()) === true);
  }
  check('want=客人QQ 不被认成主人消息',
    ownerIdentity.samePerson(FRIEND_QQ, ownerIdentity.getOwnerKey()) === false);

  // ── 汇总 ──────────────────────────────────────────────────────────────
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}（共 ${checks} 项检查）\n`);
  // 显式退出：依赖链里有常驻定时器，不 exit 会挂住
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
