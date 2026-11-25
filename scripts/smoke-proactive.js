// scripts/smoke-proactive.js
// 「她会主动联系你」的回归测试（2026-11-25 用户要求）。
//
// 用户原话：「我也想要增强的逛B站的能力，尤其是她还可以主动联系我」
//
// 原来她只在 presence tick（2.5~5h 随机）那一刻才可能开口 —— 那是「她闲着」的时机，
// 不是「她想你了」的时机。聊完就消失，你一整天不找她她也不会想起你。
//
// 这份测试钉死三件事，因为这三件任意一件做错，主动联系就退化成定时通知：
//   1. 时机判断：刚聊完才有补话、久没聊才算想起，不是随时都能说；
//   2. 三重叠加防刷屏：日上限 + 安静时段 + 专注模式，三个时机共用一份账本；
//   3. 措辞：必须给许可不是任务，且明确「不想说就跳过」——
//      少了这句，她会为了完成任务硬找话，那比不主动更糟。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'src/services/presence/proactive'));

let checks = 0;
let failures = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); }
function check(name, cond, detail) {
  checks += 1;
  if (cond) console.log('  \u2713 ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures += 1; console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const now = 1795600000000;
const H = 3600000;
const MIN = 60000;

section('时机判断：两个新时机');
const fu = P.pickTiming({ now: now, lastUserAt: now - 40 * 1000, lastTurnEndAt: now - 40 * 1000, lastSelfAt: now - 5 * H });
check('刚聊完 40 秒 → 补话时机', fu && fu.timing === 'followup', fu && fu.timing);
const fuEarly = P.pickTiming({ now: now, lastUserAt: now - 10 * 1000, lastTurnEndAt: now - 10 * 1000, lastSelfAt: now - 5 * H });
check('才过 10 秒 → 还不到补话窗口', fuEarly === null, JSON.stringify(fuEarly));
const fuLate = P.pickTiming({ now: now, lastUserAt: now - 5 * MIN, lastTurnEndAt: now - 5 * MIN, lastSelfAt: now - 5 * H });
check('过了 5 分钟 → 补话窗口已过', fuLate === null, JSON.stringify(fuLate));

const idle = P.pickTiming({ now: now, lastUserAt: now - 4 * H, lastSelfAt: 0 });
check('4 小时没说话 → 想起你', idle && idle.timing === 'idle', idle && idle.timing);
const idleShort = P.pickTiming({ now: now, lastUserAt: now - 1 * H, lastSelfAt: 0 });
check('才 1 小时 → 不算久未联系', idleShort === null, JSON.stringify(idleShort));

const active = P.pickTiming({ now: now, lastUserAt: now - 4 * H, lastSelfAt: 0, userActive: true });
check('对方正在输入 → 一律不插嘴', active === null);
const recentSelf = P.pickTiming({ now: now, lastUserAt: now - 4 * H, lastSelfAt: now - 30 * MIN });
check('她半小时前刚开过口 → 不连发', recentSelf === null);

section('三重闸门：三个时机共用一份账本');
const cfg = { enabled: true, focus: false, dailyMax: 3 };
const today = '2026-11-25';
const okGate = P.gate({ cfg: cfg, ledger: null, today: today, inQuietHours: false, focus: false, now: now, chance: 1 });
check('白天 + 没说过 + 必中 → 可以说', okGate.fire === true, okGate.reason);
const quiet = P.gate({ cfg: cfg, ledger: null, today: today, inQuietHours: true, focus: false, now: now, chance: 1 });
check('安静时段 → 不说', quiet.fire === false, quiet.reason);
const focused = P.gate({ cfg: cfg, ledger: null, today: today, inQuietHours: false, focus: true, now: now, chance: 1 });
check('专注模式 → 不打扰', focused.fire === false, focused.reason);
const capped = P.gate({ cfg: cfg, ledger: { date: today, count: 3 }, today: today, inQuietHours: false, focus: false, now: now, chance: 1 });
check('今天已说满 3 次 → 不再说', capped.fire === false, capped.reason);
const notRolled = P.gate({ cfg: cfg, ledger: null, today: today, inQuietHours: false, focus: false, now: now, chance: 0, rng: function () { return 0.99; } });
check('概率没掷中 → 不说', notRolled.fire === false, notRolled.reason);
const disabled = P.gate({ cfg: { enabled: false }, ledger: null, today: today, inQuietHours: false, focus: false, now: now, chance: 1 });
check('总开关关着 → 不说', disabled.fire === false, disabled.reason);

section('账本：只记真的说出去的那次');
check('跨日重置', P.usedToday({ date: '2026-11-24', count: 3 }, today) === 0);
check('当天累计', P.usedToday({ date: today, count: 2 }, today) === 2);
const marked = P.markUsed({ date: today, count: 2 }, today, now);
check('记账 +1', marked.count === 3 && marked.date === today, JSON.stringify(marked));
check('没账本时从 1 开始', P.markUsed(null, today, now).count === 1);

section('授权措辞：许可，不是任务');
const followup = P.buildPermissionBlock({ timing: 'followup' });
check('补话块非空', followup.length > 0);
check('写明「不想说就跳过」', followup.indexOf('不想说就跳过') >= 0);
check('写明不连发', followup.indexOf('别连发') >= 0);
check('不要求汇报', followup.indexOf('汇报') < 0);

const idleBlock = P.buildPermissionBlock({ timing: 'idle', hours: 4 });
check('久未联系块带上了小时数', idleBlock.indexOf('4 个多小时') >= 0, idleBlock.slice(0, 60));
check('明确「不是任务，也不是提醒」', idleBlock.indexOf('不是任务') >= 0);
check('明确「没什么想说的完全没问题」', idleBlock.indexOf('完全没问题') >= 0);
check('禁掉「你在忙吗」式试探开场', idleBlock.indexOf('你在忙吗') >= 0);
check('禁掉「汇报看了什么」', idleBlock.indexOf('汇报') >= 0);
check('补话块也点明是自己想起来', followup.indexOf('是你自己想起来他了') >= 0);
check('久未联系块也点明', idleBlock.indexOf('是你自己想起来他了') >= 0);
check('时机非法 → 空串', P.buildPermissionBlock({ timing: 'whatever' }) === '');
check('无参数 → 空串', P.buildPermissionBlock() === '');

section('常量：窗口与门槛');
check('补话窗口 30~90 秒', P.FOLLOWUP_MIN_MS === 30 * 1000 && P.FOLLOWUP_MAX_MS === 90 * 1000);
check('久未联系门槛 3 小时', P.IDLE_MIN_MS === 3 * H);
check('检查周期 10 分钟', P.IDLE_CHECK_MS === 10 * MIN);

console.log('\n共 ' + checks + ' 项检查，失败 ' + failures + ' 项');
if (failures > 0) process.exitCode = 1;