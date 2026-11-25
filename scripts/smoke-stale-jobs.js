// scripts/smoke-stale-jobs.js
// 「过期的一次性提醒不该在每次启动时补发」——2026-11-25 报障的回归。
//
// 报障原话（桌宠端）：「能不能把这测试任务清理掉，我每次启动都会触发」
//
// 根因：once 任务的 status 只有 pending / fired / cancelled，没有「已过期」终态；
// 停机期间的 once 任务一直躺在 pending 里，每次启动首扫把 due_at <= now 的
// pending 全部补发一次 —— 两周前的测试提醒，每次开机都会再念一遍。
//
// 为什么只测 isStaleOnceReminder 这个纯函数：真正的送达要连 WS / QQ 通道，
// 单测里给不了；而所有「被旧提醒刷屏」的事故都发生在「该不该送」这一步。
// 判定错了，后面的送达再正确也只是把错误的内容送出去。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const sched = require(path.join(ROOT, 'src/services/scheduledJobsService'));

let checks = 0;
let failures = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); }
function check(name, cond, detail) {
  checks += 1;
  if (cond) console.log('  \u2713 ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures += 1; console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const now = Date.now();
const H = 3600000;
const stale = function (ago, rec) { return sched.isStaleOnceReminder({ recurrence: rec || 'once', dueAt: now - ago }, now); };

section('窗口大小');
check('补发窗口是 6 小时', sched.ONCE_CATCHUP_WINDOW_MS === 6 * H);

section('过期判定');
check('两周前的 once → 过期', stale(14 * 24 * H) === true);
check('6 小时零 1 分钟 → 过期（边界精确到分钟）', stale(6 * H + 60000) === true);
check('正好 6 小时 → 不过期（用 > 而不是 >=）', stale(6 * H) === false);
check('两小时前 → 不过期（关机补发的原意）', stale(2 * H) === false);
check('刚好到点 → 不过期', stale(0) === false);
check('未来时间的任务 → 不过期', stale(-H) === false);

section('周期任务永不过期');
check('daily 迟到一天 → 不过期', stale(24 * H, 'daily') === false);
check('daily 迟到一年 → 不过期', stale(365 * 24 * H, 'daily') === false);

section('异常输入不该误杀');
check('缺 dueAt → 不过期', sched.isStaleOnceReminder({ recurrence: 'once' }, now) === false);
check('dueAt 非数字 → 不过期', sched.isStaleOnceReminder({ recurrence: 'once', dueAt: 'x' }, now) === false);
check('空对象 → 不过期', sched.isStaleOnceReminder({}, now) === false);
check('null → 不过期', sched.isStaleOnceReminder(null, now) === false);

section('主动联系：检查周期已挂上');
check('久未联系检查周期 10 分钟', sched.PROACTIVE_CHECK_MS === 10 * 60000);
check('tickProactiveIdle 已导出', typeof sched.tickProactiveIdle === 'function');

console.log('\n共 ' + checks + ' 项检查，失败 ' + failures + ' 项');
if (failures > 0) process.exitCode = 1;