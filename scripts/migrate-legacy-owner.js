#!/usr/bin/env node
/**
 * migrate-legacy-owner.js — 把「旧格式（不分人）」的工作空间与任务迁到「按人分目录」。
 *
 * ── 为什么需要这个脚本（2026-11-20 用户报障）─────────────────────────
 *   「我今天把机器人转发给了我一个朋友，她是私聊我的机器人，建立了几个每日任务，
 *     但是我怎么可以直接看到她的任务呢」
 *   「我合理怀疑，之前的系统里，没有对任务归属做区分，所以默认都是主人的任务」
 *
 *   用户猜得完全对。旧代码里 sessionIdFor(taskId) 只产出 `workspace:<taskId>`，
 *   **没有任何用户维度**；桌面推送又按 uid 广播（uid 对 QQ 所有人都是 1）。
 *   于是朋友建的任务：目录是平的、job 里没 owner、结果推给所有桌面。
 *
 * ── 这个脚本做什么 ────────────────────────────────────────────────
 *   对每个 legacy job（session_id 形如 `workspace:<taskId>`，无 owner）：
 *     1. 从「建任务时刻的会话」推断归属人（必须给证据，不猜）
 *     2. 把 KirariWorkspace/<taskId>/ 移到 KirariWorkspace/<owner>/<taskId>/
 *     3. 重写 meta.json，补 owner / ownerName / ownerRole
 *     4. 重写 scheduled_jobs.session_id = workspace:<owner>:<taskId>
 *     5. 重写 payload，补 owner / ownerName / ownerRole
 *
 *   ⚠️ 归属人不做「默认值」。推不出来就跳过并报错，绝不默认成主人 ——
 *      那正是这次事故的成因。
 *
 * ── 用法 ─────────────────────────────────────────────────────────
 *   node scripts/migrate-legacy-owner.js --dry-run
 *   node scripts/migrate-legacy-owner.js --apply
 *
 *   --owner-map=<taskId>=<owner>,<taskId>=<owner>   手工指定归属（可选）
 *   --force                                        已有 owner 也重写
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY = !args.includes('--apply');
const FORCE = args.includes('--force');
const ownerMapArg = (args.find((a) => a.startsWith('--owner-map=')) || '').slice('--owner-map='.length);
const ownerMap = {};
for (const pair of ownerMapArg.split(',').filter(Boolean)) {
  const [tid, ow] = pair.split('=');
  if (tid && ow) ownerMap[tid.trim()] = ow.trim();
}

function log(...a) { console.log(...a); }
function section(t) { console.log(`\n=== ${t} ===`); }

async function main() {
  const workspace = require(path.join(ROOT, 'src/services/workspace'));
  const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
  const wsTask = require(path.join(ROOT, 'src/services/workspaceTask'));

  if (DRY) {
    log('⚠️  DRY-RUN 模式：只打印将要做什么，不写任何东西。加 --apply 才真的改。');
  }

  // ── 0. 拿库和人物表（归属人名字要从这里取，不能现编）──────────
  const people = new Map();
  try {
    const rows = await dbStorage.listPeople?.() || [];
    for (const p of rows) people.set(String(p.personKey || p.person_key), p);
  } catch { /* 没有这个 API 就走下面兜底 */ }
  if (people.size === 0) {
    try {
      const db = dbStorage.getDb();
      for (const r of db.prepare('SELECT person_key, role, display_name FROM people').all()) {
        people.set(String(r.person_key), { personKey: r.person_key, role: r.role, displayName: r.display_name });
      }
    } catch (e) {
      console.warn('读 people 表失败（归属人名字将为空白）:', e?.message || e);
    }
  }
  section('人物表');
  for (const [k, p] of people) {
    log(`  ${k}\trole=${p.role || '(空)'}\tname=${p.displayName || '(无名)'}`);
  }

  // ── 1. 找出所有 legacy job ──────────────────────────────────
  // jobStore 只有 due()/list(sessionId)，没有「全表」入口；迁移要的是全表，
  // 所以这里直接查库。scheduled_jobs 的列名是 snake_case，读出来手工转成 job 形状。
  const db = dbStorage.getDb();
  const legacy = db
    .prepare("SELECT job_id, session_id, origin, uid, kind, title, payload, due_at, recurrence, status FROM scheduled_jobs WHERE kind = 'workspace_task'")
    .all()
    .map((r) => ({
      jobId: r.job_id,
      sessionId: r.session_id,
      origin: r.origin,
      uid: r.uid,
      kind: r.kind,
      title: r.title,
      payload: r.payload,
      dueAt: r.due_at,
      recurrence: r.recurrence,
      status: r.status,
    }))
    .filter((j) => {
      const sid = String(j.sessionId || '');
      // 新格式是 workspace:<owner>:<taskId>（两段冒号）；旧格式只有 workspace:<taskId>
      const parsed = wsTask.parseSessionId(sid);
      return !parsed || !parsed.owner;
    });

  section(`发现 ${legacy.length} 个 legacy 任务`);
  if (legacy.length === 0) {
    log('没有需要迁移的任务，收工。');
    return;
  }

  // ── 2. 逐个推断归属 ────────────────────────────────────────
  let planned = 0;
  let skipped = 0;

  for (const job of legacy) {
    const sid = String(job.sessionId || '');
    const taskId = wsTask.taskIdFromSession(sid);
    log(`\n─── ${job.jobId}`);
    log(`    taskId   = ${taskId}`);
    log(`    session  = ${sid}`);

    if (!taskId) {
      log('    ⚠️ 拆不出 taskId，跳过');
      skipped++;
      continue;
    }

    // 归属来源优先级：手工指定 > payload 已有 > 拒绝（不猜）
    let owner = ownerMap[taskId] || '';
    let source = owner ? '手工指定(--owner-map)' : '';

    if (!owner) {
      let payload = {};
      try { payload = wsTask.parsePayload(job.payload) || {}; } catch { /* 不是 JSON */ }
      if (payload.owner) {
        owner = String(payload.owner);
        source = 'payload 已有';
      }
    }

    if (!owner) {
      log('    ❌ 推不出归属人 —— 跳过。');
      log('       请用 --owner-map=' + taskId + '=<Q号> 明确指定。');
      log('       （绝不默认成主人：那正是这次事故的成因）');
      skipped++;
      continue;
    }

    const person = people.get(owner) || {};
    const ownerRole = String(person.role || (ownerMap[taskId] ? 'user' : ''));
    const ownerName = String(person.displayName || '');

    log(`    → 归属   = ${owner}${ownerName ? `（${ownerName}）` : ''} role=${ownerRole || '(未知)'}`);
    log(`       来源   = ${source}`);

    // ── 3. 目录搬迁 ─────────────────────────────────────────
    const flatDir = path.join(workspace.rootDir(), taskId);
    const ownerDir = workspace.taskDir(owner, taskId);
    const flatExists = fs.existsSync(flatDir);
    const ownerExists = fs.existsSync(ownerDir);

    if (flatExists && ownerExists) {
      log(`    ⚠️ 平铺目录和目标目录都在：${flatDir} / ${ownerDir}`);
      log('       两边都有内容，自动合并不安全 → 跳过，请人工处理');
      skipped++;
      continue;
    }
    if (flatExists) {
      log(`    目录：${flatDir}  →  ${ownerDir}`);
      if (!DRY) {
        fs.mkdirSync(path.dirname(ownerDir), { recursive: true });
        try {
          fs.renameSync(flatDir, ownerDir);
        } catch (e) {
          // 跨盘/占用时退化成「复制+删」
          log(`       rename 失败（${e.code}），改用复制`);
          fs.cpSync(flatDir, ownerDir, { recursive: true });
          fs.rmSync(flatDir, { recursive: true, force: true });
        }
      }
    } else if (!ownerExists) {
      log('    ⚠️ 目录原本就不存在（可能没跑过），仍会补建 meta 与 job');
    } else {
      log('    目录已经在目标位置，只补 meta 与 job');
    }

    // ── 4. 重写 meta.json ───────────────────────────────────
    try {
      const meta = workspace.ensureTask(owner, taskId, {
        title: job.title,
        ownerName,
        ownerRole,
      });
      if (!DRY) {
        log(`    meta：owner=${meta.owner} name=${meta.ownerName || '(空)'} role=${meta.ownerRole || '(空)'}`);
      }
    } catch (e) {
      log(`    ❌ 写 meta 失败：${e?.message || e}`);
      skipped++;
      continue;
    }

    // ── 5. 重写 job 行 ──────────────────────────────────────
    const newSessionId = wsTask.sessionIdFor(owner, taskId);
    let payload = {};
    try { payload = wsTask.parsePayload(job.payload) || {}; } catch { payload = {}; }
    const newPayload = wsTask.buildPayload({
      ...payload,
      taskId,
      owner,
      ownerName,
      ownerRole,
    });

    log(`    job：session_id ${sid}  →  ${newSessionId}`);
    log(`         payload 补 owner=${owner}${ownerName ? ` name=${ownerName}` : ''}${ownerRole ? ` role=${ownerRole}` : ''}`);

    if (!DRY) {
      try {
        const db = dbStorage.getDb();
        const info = db.prepare(
          'UPDATE scheduled_jobs SET session_id = ?, payload = ?, updated_at = ? WHERE job_id = ?',
        ).run(newSessionId, newPayload, Date.now(), job.jobId);
        if (!info.changes) {
          log('         ⚠️ UPDATE 影响 0 行，job 可能已不存在');
        }
      } catch (e) {
        log(`    ❌ 改 job 失败：${e?.message || e}`);
        skipped++;
        continue;
      }
    }
    planned++;
  }

  section('结果');
  log(`  ${DRY ? '将迁移' : '已迁移'}：${planned}`);
  log(`  跳过：${skipped}`);
  if (DRY && planned > 0) {
    log('\n确认无误后加 --apply 真正执行。');
  }
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
