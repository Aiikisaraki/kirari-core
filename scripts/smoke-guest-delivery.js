#!/usr/bin/env node
/**
 * smoke-guest-delivery.js — 「别人的任务/提醒会不会送到别人那里」回归测试。
 *
 * ── 为什么单独有这个脚本 ─────────────────────────────────────────────
 * 身份归一化修好之后，用户追问了一句：
 *   「那别人的任务啊提醒啊，也会正确送达别人那里吗」
 *
 * 实测答案是**不会**。这不是猜测，是生产日志：
 *   [wsTask] 1658359753/每日提醒-说话分寸-8cf4bc 结果送达：桌面 0 个连接、平台 0 条
 *
 * 两条腿都断了：
 *   · 桌面：客人没有联动桌面 → 0 个连接（正确，绝不能推到主人桌面）
 *   · 平台：session_id 是 workspace:<QQ号>:<任务名>，不是 bot-*，
 *           pushToUserSession 第一行就 return false
 * 于是结果静默丢弃，日志还写着"结果送达"。
 *
 * 更早的那个 bug（修提醒时）同源：主人 QQ 私聊建提醒，owner 存成 '_local'，
 * 到点比 '1980308740' === '_local' 为假 → 跳过 QQ → 静默消失。
 *
 * 所以这个脚本要锁死三件事：
 *   ① 主人的东西只到主人（_local / UUID / 规范键都认，绝不漏）
 *   ② 客人的东西只到客人（绝不进主人窗口，也绝不被丢掉）
 *   ③ 真的送不到时必须**告警**，不能假装成功
 *
 * 用法：node scripts/smoke-guest-delivery.js
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-guest-'));
process.env.KIRARI_HOME = TMP_HOME;
process.env.KIRARI_DATA_DIR = TMP_HOME;

const OWNER_QQ = '1980308740';   // people.role='owner'
const FRIEND_QQ = '1658359753';  // people.role='user'（真客人）
const OTHER_QQ = '2233445566';   // 从没说过话的陌生人

let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (ok) console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

async function main() {
  fs.mkdirSync(TMP_HOME, { recursive: true });

  const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
  await dbStorage.upsertPerson({ personKey: OWNER_QQ, role: 'owner', displayName: '主人' });
  await dbStorage.upsertPerson({ personKey: FRIEND_QQ, role: 'user', displayName: '朋友' });

  const ownerIdentity = require(path.join(ROOT, 'src/services/ownerIdentity'));

  // ═══════════════════════════════════════════════════════════════════
  section('1. 归属人判定：主人 / 客人 / 陌生人 各归各的');
  // ═══════════════════════════════════════════════════════════════════
  check('主人 QQ 号 → 主人',
    ownerIdentity.samePerson(OWNER_QQ, ownerIdentity.getOwnerKey()));
  check("\u2018_local\u2019 归一到主人",
    ownerIdentity.canonicalIdentity('_local') === OWNER_QQ);
  check('客人 QQ 号 ≠ 主人',
    !ownerIdentity.samePerson(FRIEND_QQ, ownerIdentity.getOwnerKey()),
    `canonical(${FRIEND_QQ}) = ${ownerIdentity.canonicalIdentity(FRIEND_QQ)}`);
  check('陌生人 QQ 号 ≠ 主人',
    !ownerIdentity.samePerson(OTHER_QQ, ownerIdentity.getOwnerKey()));
  check('客人 ≠ 陌生人',
    !ownerIdentity.samePerson(FRIEND_QQ, OTHER_QQ));
  check('客人不会被归一到主人（隔离红线）',
    ownerIdentity.canonicalIdentity(FRIEND_QQ) !== OWNER_QQ);

  // ═══════════════════════════════════════════════════════════════════
  section('2. 会话 id 形状：哪些发得出去，哪些发不出去');
  // ═══════════════════════════════════════════════════════════════════
  const botManager = require(path.join(ROOT, 'src/bot/botManager'));

  // 没有运行中的适配器 → 一切都发不出去，但**不能抛异常**
  const guestBotSid = `bot-onebot-private:${FRIEND_QQ}`;
  const guestWsSid = `workspace:${FRIEND_QQ}:每日提醒-说话分寸`;
  const ownerWsSid = `workspace:${OWNER_QQ}:我自己的任务`;

  check('没有适配器时 pushToUserSession 不抛异常',
    (() => { try { botManager.pushToUserSession(guestBotSid, 'x'); return true; } catch { return false; } })());
  check('workspace: 会话 pushToUserSession 发不出去（这是 bug 的一半）',
    botManager.pushToUserSession(guestWsSid, 'x') === false);
  check('主人的 workspace: 会话同样发不出去',
    botManager.pushToUserSession(ownerWsSid, 'x') === false);
  check('pushToOwnerPrivate 存在',
    typeof botManager.pushToOwnerPrivate === 'function');
  check('pushToUserByAccount 存在（给客人的那条腿）',
    typeof botManager.pushToUserByAccount === 'function');

  // ═══════════════════════════════════════════════════════════════════
  section('3. 客人通道：必须证明有通道才发，绝不乱发');
  // ═══════════════════════════════════════════════════════════════════
  // 没有适配器时，谁都不该发出去（fail-closed），
  // 但也不能因为"查不到"就抛异常。
  for (const [who, desc] of [[FRIEND_QQ, '有档案的客人'], [OTHER_QQ, '陌生人']]) {
    let got = null;
    try { got = await botManager.pushToUserByAccount(who, '内容'); } catch (e) { got = `抛异常:${e.message}`; }
    check(`${desc} 在无适配器时返回 false 而不是抛异常`,
      got === false, `实际 ${JSON.stringify(got)}`);
  }
  check('空账号直接 false', (await botManager.pushToUserByAccount('', 'x')) === false);
  check('空内容直接 false', (await botManager.pushToUserByAccount(FRIEND_QQ, '')) === false);

  // ── ⚠️ 本轮踩到的真 bug：botManager 里 require('./memory') 路径写错 ──
  // 本文件在 src/bot/ 下，memory 在 src/services/ 下，正确是 '../services/memory'。
  // 写错会抛 MODULE_NOT_FOUND，被空 catch 吞掉 → 判定恒为 false →
  // 客人永远收不到，而日志只说"没有该账号的人物档案"，看起来像数据问题。
  // 这里直接把两条路径都试一遍，钉死"必须是能加载到人的那条"。
  let goodLoad = false;
  let badLoad = false;
  try {
    const m = require(path.join(ROOT, 'src/services/memory'));
    goodLoad = typeof m.getPerson === 'function';
  } catch { goodLoad = false; }
  try {
    // 从 botManager 所在目录出发的相对路径（应有尽有）
    require(path.join(ROOT, 'src/bot/memory'));
    badLoad = true;
  } catch { badLoad = false; }
  check('src/services/memory 可以加载且提供 getPerson', goodLoad);
  check('★ src/bot/memory 不存在（证明 ./memory 是错误路径）', badLoad === false);
  check('★ 有档案的人能被 getPerson 查到（通道证据可用）',
    !!(await require(path.join(ROOT, 'src/services/memory')).getPerson(FRIEND_QQ)));

  // ═══════════════════════════════════════════════════════════════════
  section('4. ★ 投递闸门：主人的只到主人，客人的绝不到主人');
  // ═══════════════════════════════════════════════════════════════════
  const { shouldDeliverToConn } = require(path.join(ROOT, 'src/websocket/socketServer'));
  const LOCAL_SID = '9284e4f6-7123-4577-bb69-d788bd1cadce';

  // 一台"没上报联动"的本机可信桌面（主人自己的电脑）
  const ownerDesktop = { cp: '', trustedLocal: true, ownerOfSystem: OWNER_QQ };
  // 一台替客人联动的连接
  const guestConn = { cp: FRIEND_QQ, trustedLocal: false, ownerOfSystem: OWNER_QQ };

  const cases = [
    // [want, conn, 期望, 说明]
    [OWNER_QQ, ownerDesktop, true, '主人的提醒 → 主人桌面（收）'],
    ['_local', ownerDesktop, true, "主人提醒存成 '_local' → 主人桌面（收，本次 bug）"],
    [LOCAL_SID, ownerDesktop, true, '主人提醒存成本机会话 UUID → 主人桌面（收）'],
    [FRIEND_QQ, guestConn, true, '客人的提醒 → 客人自己的连接（收）'],
    [FRIEND_QQ, ownerDesktop, false, '★ 客人的提醒 → 主人桌面（必须拒，原报障）'],
    [LOCAL_SID, guestConn, false, '★ 主人的提醒 → 客人连接（必须拒，防泄露）'],
    [OWNER_QQ, guestConn, false, '★ 主人规范键 → 客人连接（必须拒）'],
  ];
  for (const [want, conn, expect, desc] of cases) {
    const got = shouldDeliverToConn({
      want, cp: conn.cp, trustedLocal: conn.trustedLocal, ownerOfSystem: conn.ownerOfSystem,
    });
    check(desc, got === expect, `want=${want} cp=${conn.cp || '(空)'} → ${got}，期望 ${expect}`);
  }

  // 不可信连接（外部浏览器）一律不收，哪怕它是主人的消息
  check('不可信连接收不到主人的消息',
    shouldDeliverToConn({ want: OWNER_QQ, cp: '', trustedLocal: false, ownerOfSystem: OWNER_QQ }) === false);

  // ═══════════════════════════════════════════════════════════════════
  section('5. ★ 结果投递：三条腿都不通时必须告警，不能假装送达');
  // ═══════════════════════════════════════════════════════════════════
  const workspaceTask = require(path.join(ROOT, 'src/services/workspaceTask'));

  const warns = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  console.log = () => { /* 静默正常日志 */ };

  let guestRes = null;
  let ownerRes = null;
  try {
    guestRes = await workspaceTask.deliverResult(
      { jobId: 'g1', sessionId: guestWsSid },
      FRIEND_QQ, '每日提醒-说话分寸', '该注意说话分寸了',
    );
    ownerRes = await workspaceTask.deliverResult(
      { jobId: 'o1', sessionId: OWNER_QQ ? `workspace:${OWNER_QQ}:t` : 'x' },
      OWNER_QQ, 't', '主人自己的任务结果',
    );
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }

  check('deliverResult 返回结构化结果（sentWs / sentQq）',
    guestRes && typeof guestRes.sentWs === 'number' && typeof guestRes.sentQq === 'number',
    JSON.stringify(guestRes));
  check('没有通道时客人结果确实没送出',
    guestRes.sentWs === 0 && guestRes.sentQq === 0, JSON.stringify(guestRes));
  check('没有通道时主人结果确实没送出',
    ownerRes.sentWs === 0 && ownerRes.sentQq === 0, JSON.stringify(ownerRes));

  const guestWarned = warns.some((w) => w.includes('没有送达任何地方') && w.includes(FRIEND_QQ));
  const ownerWarned = warns.some((w) => w.includes('没有送达任何地方') && w.includes(OWNER_QQ));
  check('★ 客人结果没送出时有明确告警（不再静默）', guestWarned,
    warns.filter((w) => w.includes('没有送达')).slice(0, 2).join(' | ') || '(无告警)');
  check('★ 主人结果没送出时有明确告警', ownerWarned);
  check('★ 告警里点明了是谁的结果（可定位）',
    warns.some((w) => w.includes('没有送达任何地方') && /1658359753|1980308740/.test(w)));

  // ═══════════════════════════════════════════════════════════════════
  section('6. 客人的任务归属不会被顺手改成主人');
  // ═══════════════════════════════════════════════════════════════════
  const scheduledJobs = require(path.join(ROOT, 'src/services/scheduledJobsService'));
  // resolveJobOwner 对个人会话且归属不明时必须返回 ''（不猜成主人桌面）
  const unknownOwner = scheduledJobs.resolveJobOwner
    ? scheduledJobs.resolveJobOwner({ jobId: 'x', sessionId: guestWsSid, ownerKey: '' })
    : '';
  check('★ workspace: 会话查不到归属时返回空，不 fallback 成主人',
    String(unknownOwner || '') !== OWNER_QQ,
    `实际 ${JSON.stringify(unknownOwner)}`);

  // 总结
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 有失败项'}（共 ${checks} 项检查）`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
