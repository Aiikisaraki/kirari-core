// scripts/smoke-work-report.js
// 「有几个任务」这个问题的口径测试。
//
// 背景（用户 2026-11-20 的诘问）：
//   「难道提醒不是一个任务吗，定时提醒不就是一个自动化任务吗」
//
// 对，就是。生产上出现过这样的局面：她说「5 个」，接口返回「本会话没有任务
// 记录」，两边都没撒谎 —— 5 条提醒确实在，只是躺在 scheduled_jobs 表里，
// 而 self_read(tasks) 只查 tasks 表。用户因此得到一个前后矛盾的回答。
//
// 这份测试钉死的是：**不管从哪个 topic 问，数字必须是同一份事实**。

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SID = 'test-session-9284';

let checks = 0;
let failures = 0;

function section(t) {
  console.log(`\n=== ${t} ===`);
}
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ── 用假 store 接管两张表 ──────────────────────────────────────────────
// selfOps 通过懒 require 取 taskStore()/jobStore()，所以替换这两个模块导出即可。
const taskStoreMod = require(path.join(ROOT, 'src/session/taskStore'));
const jobStoreMod = require(path.join(ROOT, 'src/session/jobStore'));

let fakeTasks = [];
let fakeJobs = [];

taskStoreMod.taskStore.list = (sid) => (sid === SID ? fakeTasks : []);
taskStoreMod.taskStore.active = (sid) => (sid === SID ? fakeTasks.filter((t) => t.status === 'pending' || t.status === 'running') : []);
jobStoreMod.jobStore.list = (sid) => (sid === SID ? fakeJobs : []);

const selfOps = require(path.join(ROOT, 'src/services/selfOps'));

function task(id, title, status) {
  return { taskId: id, sessionId: SID, title, status, steps: [{ label: '第一步', status }] };
}
function job(id, title, status, dueAt) {
  return { jobId: id, sessionId: SID, title, status, dueAt, recurrence: 'once', payload: title, kind: 'reminder' };
}

function ownerCtx() {
  return { sessionId: SID, role: 'owner' };
}

function main() {
  // ── 1. 用户遇到的真实场景：5 条提醒、0 个多步任务 ──
  section('1. 复现生产现场：5 条提醒 + 0 个任务');
  {
    fakeTasks = [];
    fakeJobs = [
      job('j1', '出去活动提醒', 'cancelled', 1),
      job('j2', '出去活动提醒', 'cancelled', 2),
      job('j3', '出去活动提醒', 'cancelled', 3),
      job('j4', '出去活动提醒', 'fired', 4),
      job('j5', '起床提醒', 'fired', 5),
    ];
    const out = selfOps.read('tasks', ownerCtx());
    check('★ 问 tasks 时不再是「没有任务记录」', !out.includes('没有任务记录'), '这是用户看到的错答案');
    check('★ 总数正确报出 5', out.includes('5 件'));
    check('  且明确说明其中提醒 5 条、多步任务 0 条', out.includes('提醒 5 条') && out.includes('多步任务 0 条'));
    check('  明确说明全部已结束', out.includes('没有，全部已结束') || out.includes('已结束'));
    check('  ★ 提醒被算作任务（用户的核心诉求）', out.includes('也算任务'));

    const rem = selfOps.read('reminders', ownerCtx());
    check('★ 问 reminders 也报 5 条（与 tasks 口径不冲突）', rem.includes('5 条'));
    check('  reminders 里也点明「提醒也算任务」', rem.includes('也算任务'));
  }

  // ── 2. 混合场景：两个 topic 的"总数"必须一致 ──
  section('2. 两个 topic 的数字必须自洽');
  {
    fakeTasks = [task('t1', '整理资料', 'pending'), task('t2', '写周报', 'completed')];
    fakeJobs = [job('j1', '喝水', 'pending', 100), job('j2', '带伞', 'fired', 200)];
    const out = selfOps.read('tasks', ownerCtx());
    const total = fakeTasks.length + fakeJobs.length;
    check(`★ 混合场景总数 = ${total}`, out.includes(`${total} 件`));
    check('  分别说明提醒与任务各几条',
      out.includes('提醒 2 条') && out.includes('多步任务 2 条'));
    check('  ★ 区分「还在等着的」与「已结束」', out.includes('还在等着的') && out.includes('已结束'));
    check('  未结束的计数正确（1 任务 + 1 提醒 = 2）', out.includes('2 件'));
  }

  // ── 3. 真的没有东西时，说没有而不是说查不到 ──
  section('3. 空的时候怎么说话');
  {
    fakeTasks = [];
    fakeJobs = [];
    const out = selfOps.read('tasks', ownerCtx());
    check('★ 空 → 明确说「没记过」而不是含糊其辞', out.includes('没给你记过'));
    check('  报出总数 0', out.includes('0 件'));
    const rem = selfOps.read('reminders', ownerCtx());
    check('reminders 空也说清楚', rem.includes('没设过提醒'));
    check('★ 不再出现「查不到」这种让用户担心的说法', !rem.includes('查不到') && !out.includes('查不到'));
  }

  // ── 4. 措辞：不再用内部术语「本会话」 ──
  section('4. 别把内部术语丢给用户');
  {
    fakeTasks = [];
    fakeJobs = [job('j1', 'x', 'pending', 1)];
    const out = selfOps.read('tasks', ownerCtx());
    check('★ 不再出现「本会话」这个内部词', !out.includes('本会话'), '用户看不懂"会话"指什么');
    check('  用「这条对话」这种说法', out.includes('这条对话'));
  }

  // ── 5. 注入清单也走同一口径 ──
  section('5. system 清单与 self_read 数字一致');
  {
    fakeTasks = [task('t1', '整理资料', 'pending')];
    fakeJobs = [job('j1', '喝水', 'pending', 100), job('j2', '昨天的事', 'fired', 50)];
    const manifest = selfOps.buildManifest({ sessionId: SID, role: 'owner', capScope: 'local::anon' });
    check('★ 清单里给出合计数 3 件', manifest.includes('3 件'));
    check('  标明未结束的是 2 件', manifest.includes('还没结束的 2 件'));
    check('  ★ 让模型先去查再回答，不许凭印象', manifest.includes('不要凭印象报数字'));
  }

  // ── 6. 跨会话不能串 ──
  section('6. 别人的任务不能算进来');
  {
    fakeTasks = [task('t1', '我的事', 'pending')];
    fakeJobs = [job('j1', '我的提醒', 'pending', 1)];
    const other = selfOps.read('tasks', { sessionId: 'someone-else', role: 'owner' });
    check('★ 另一个会话查不到我的任务', other.includes('0 件'));
    check('  也不会泄漏我的任务名', !other.includes('我的事') && !other.includes('我的提醒'));
  }

  console.log(
    `\n${failures === 0 ? '✅ 全部通过' : '❌ 有失败'}（共 ${checks} 项检查）`,
  );
  if (failures > 0) process.exitCode = 1;
  // selfOps 的依赖链会拉起一些常驻定时器（提醒调度 / 事件落库）。
  // 测试跑完就该退出，不能让 CI 挂在那里等一个永远不来的事件。
  process.exit(failures === 0 ? 0 : 1);
}

main();
