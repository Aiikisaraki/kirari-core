#!/usr/bin/env node
/**
 * 工作空间冒烟测试（core 端）
 *
 * 为什么需要它：工作空间是**真实文件夹 + 真实删除操作**，而且她会拿到完整 CRUD
 * （用户 2026-11-19 拍板「完整（含删除/新建目录）」）。这意味着路径越权不是
 * 「功能不好用」，而是「她能把文件删到工作空间外面去」。所以这里重点压三类：
 *
 *   1) 正常流程：建任务 → 写文件 → 读回来 → 列目录 → 追加 → 删 → 清理
 *   2) 越权防护：`..` / 绝对路径 / 盘符 / UNC / 保留设备名 / 结尾点号 全部要拒
 *   3) 集成链路：能力注册表能列出 workspace 与 schedule_task；
 *      建出来的 job kind/recurrence/payload 正确；提示块含真实根路径
 *
 * 全程用临时目录当 KIRARI_WORKSPACE，绝不碰用户真实的 ~/KirariWorkspace。
 *
 * 运行：node scripts/smoke-workspace.js [--keep]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');

// 独立的临时工作空间 + 临时 home，绝不碰真实数据库与真实产物
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-ws-smoke-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-ws-home-'));
process.env.KIRARI_WORKSPACE = tmpWs;
process.env.KIRARI_HOME = tmpHome;

let failures = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
    }
}

function expectThrow(name, fn) {
    try {
        fn();
        check(name, false, '应当抛错但没有');
    } catch (e) {
        check(name, true);
    }
}

async function main() {
    console.log('\n=== 1. 目录与任务文件夹 ===');
    const workspace = require(path.join(ROOT, 'src/services/workspace'));

    check('根目录指向临时目录', workspace.rootDir() === tmpWs, workspace.rootDir());
    const root = workspace.ensureRoot();
    check('根目录已创建', fs.existsSync(root));
    check('空间元信息文件已写入', fs.existsSync(path.join(root, workspace.SPACE_META_FILE)));

    // 任务文件夹名 = taskId；标题存在 meta.json 里（改标题不搬文件）
    const t1 = workspace.ensureTask('daily-news-a1b2c3', { title: '每日科技简报' });
    check('任务文件夹已建', fs.existsSync(t1.dir), t1.dir);
    check('meta.json 已写入', fs.existsSync(path.join(t1.dir, workspace.TASK_META_FILE)));
    check('meta 里存了标题', workspace.readTaskMeta('daily-news-a1b2c3').title === '每日科技简报');

    // 改标题：文件夹名不变，这是「按 id 命名」的核心承诺
    workspace.ensureTask('daily-news-a1b2c3', { title: '科技简报（改名后）' });
    check('改标题后文件夹名没变', fs.existsSync(t1.dir));
    check('改标题后 meta 已更新', workspace.readTaskMeta('daily-news-a1b2c3').title === '科技简报（改名后）');

    console.log('\n=== 2. 文件读写 / 列目录 / 追加 ===');
    const n = workspace.writeFile('daily-news-a1b2c3', 'notes/2026-11-19.md', '# 今天的新闻\nAI 有新进展');
    check('写入返回字节数', n > 0, String(n));
    check('读回来内容一致', workspace.readFile('daily-news-a1b2c3', 'notes/2026-11-19.md').includes('AI 有新进展'));
    check('父目录自动创建', fs.existsSync(path.join(t1.dir, 'notes')));

    const ls = workspace.listFiles('daily-news-a1b2c3');
    check('列目录含 notes', ls.some((e) => e.name === 'notes' && e.dir));
    check('列目录不暴露 meta.json', !ls.some((e) => e.name === workspace.TASK_META_FILE));
    check('子目录能列', workspace.listFiles('daily-news-a1b2c3', 'notes').some((e) => e.name === '2026-11-19.md'));

    workspace.writeFile('daily-news-a1b2c3', 'log.txt', 'line1');
    workspace.writeFile(
        'daily-news-a1b2c3',
        'log.txt',
        workspace.readFile('daily-news-a1b2c3', 'log.txt').replace(/\s*$/, '') + '\n\nline2',
    );
    check('追加后两行都在', workspace.readFile('daily-news-a1b2c3', 'log.txt').includes('line1')
        && workspace.readFile('daily-news-a1b2c3', 'log.txt').includes('line2'));

    check('statPath 认出目录', workspace.statPath('daily-news-a1b2c3', 'notes').dir === true);
    check('statPath 不存在返回 null', workspace.statPath('daily-news-a1b2c3', 'nope.txt') === null);
    expectThrow('读目录当文件要报错', () => workspace.readFile('daily-news-a1b2c3', 'notes'));

    console.log('\n=== 3. 越权防护（最要紧的一节）===');
    const escapes = [
        ['相对上跳 ..', () => workspace.resolveInTask('daily-news-a1b2c3', '../escape')],
        ['中途上跳 a/../../b', () => workspace.resolveInTask('daily-news-a1b2c3', 'a/../../b')],
        ['绝对路径 /etc/passwd', () => workspace.resolveInTask('daily-news-a1b2c3', '/etc/passwd')],
        ['Windows 盘符 C:/x', () => workspace.resolveInTask('daily-news-a1b2c3', 'C:/x')],
        ['Windows 盘符 D:\\x', () => workspace.resolveInTask('daily-news-a1b2c3', 'D:\\x')],
        ['UNC 路径', () => workspace.resolveInTask('daily-news-a1b2c3', '\\\\server\\share')],
        ['taskId 为 ..', () => workspace.taskDir('..')],
        ['taskId 含斜杠', () => workspace.taskDir('a/b')],
        ['taskId 含反斜杠', () => workspace.taskDir('a\\b')],
        ['taskId 是保留设备名 con', () => workspace.taskDir('con')],
        ['taskId 以点结尾', () => workspace.taskDir('abc.')],
        ['taskId 以空格结尾', () => workspace.taskDir('abc ')],
        ['taskId 为空', () => workspace.taskDir('')],
        ['文件名含冒号', () => workspace.resolveInTask('daily-news-a1b2c3', 'a:b.txt')],
        ['文件名含控制字符', () => workspace.resolveInTask('daily-news-a1b2c3', 'a\u0000b.txt')],
    ];
    for (const [name, fn] of escapes) expectThrow(`拒绝：${name}`, fn);

    // 拒绝之后必须真的没在空间外面留下东西
    check('工作空间父目录没有多余条目', !fs.existsSync(path.join(tmpWs, '..', 'escape')));

    console.log('\n=== 4. 删除与保留策略 ===');
    workspace.writeFile('daily-news-a1b2c3', 'tmp/scratch.txt', 'x');
    check('删文件成功', workspace.remove('daily-news-a1b2c3', 'tmp/scratch.txt').removed === true);
    check('删目录成功', workspace.remove('daily-news-a1b2c3', 'tmp').removed === true);
    check('删不存在的返回 not-found', workspace.remove('daily-news-a1b2c3', 'ghost.txt').removed === false);
    expectThrow('不能删任务文件夹本身', () => workspace.remove('daily-news-a1b2c3', ''));

    // 保留策略作用于**整个任务文件夹**（不只某一个子目录）：这里此刻共有
    // notes/2026-11-19.md、log.txt、old/f0..f4 共 7 个文件，keepFiles=2 应删掉最旧的 5 个。
    for (let i = 0; i < 5; i++) {
        workspace.writeFile('daily-news-a1b2c3', `old/f${i}.txt`, 'x'.repeat(10));
        // 拉开 mtime，避免同一毫秒排序不稳
        const p = path.join(t1.dir, 'old', `f${i}.txt`);
        const t = Date.now() - (5 - i) * 60000;
        fs.utimesSync(p, new Date(t), new Date(t));
    }
    const beforePrune = workspace.overview().list.find((x) => x.taskId === 'daily-news-a1b2c3').files;
    check('清理前文件数对得上', beforePrune === 7, String(beforePrune));
    const pr = workspace.pruneTask('daily-news-a1b2c3', { keepFiles: 2, keepDays: 0, keepBytes: 0 });
    check('保留策略删掉最旧的 5 个', pr.deleted === 5, String(pr.deleted));
    check('正好剩下 2 个文件', workspace.overview().list.find((x) => x.taskId === 'daily-news-a1b2c3').files === 2);
    check('最旧的 old/ 全被清掉', workspace.listFiles('daily-news-a1b2c3', 'old').length === 0);
    check('最新的两个留下', workspace.listFiles('daily-news-a1b2c3').some((e) => e.name === 'log.txt'));
    check('meta.json 没被清理', fs.existsSync(path.join(t1.dir, workspace.TASK_META_FILE)));

    // recordRun 记运行次数
    workspace.recordRun('daily-news-a1b2c3');
    workspace.recordRun('daily-news-a1b2c3');
    check('运行次数累加', workspace.readTaskMeta('daily-news-a1b2c3').runCount === 2);
    check('记了最近运行时间', !!workspace.readTaskMeta('daily-news-a1b2c3').lastRunAt);

    console.log('\n=== 5. 概览与列表 ===');
    workspace.ensureTask('weekly-summary-x9y8z7', { title: '每周汇总' });
    const ov = workspace.overview();
    check('概览统计到 2 个任务', ov.tasks === 2, String(ov.tasks));
    check('概览里根路径正确', ov.root === tmpWs);
    check('列表按最近运行排序（跑过的在前）', workspace.listTasks()[0].taskId === 'daily-news-a1b2c3');

    console.log('\n=== 6. 能力注册与 dispatch ===');
    const registry = require(path.join(ROOT, 'src/capabilities/registry'));
    const names = (registry.listTools('local:1') || []).map((t) => t.function.name);
    check('workspace 能力已注册', names.includes('workspace'));
    check('schedule_task 能力已注册', names.includes('schedule_task'));

    const wsCap = require(path.join(ROOT, 'src/capabilities/builtin/workspace'));
    const ctx = { sessionId: 'local-test', uid: 1, origin: 'core' };

    const rOverview = await wsCap.dispatch({ action: 'overview' }, ctx);
    check('overview 返回人话', typeof rOverview === 'string' && rOverview.includes(tmpWs), rOverview.slice(0, 80));

    const rTasks = await wsCap.dispatch({ action: 'tasks' }, ctx);
    check('tasks 列出两个任务', rTasks.includes('daily-news-a1b2c3') && rTasks.includes('weekly-summary-x9y8z7'));

    const rWrite = await wsCap.dispatch(
        { action: 'write', taskId: 'weekly-summary-x9y8z7', path: 'w1.md', content: '内容' },
        ctx,
    );
    check('write 成功', /已写入/.test(rWrite), rWrite);

    const rRead = await wsCap.dispatch({ action: 'read', taskId: 'weekly-summary-x9y8z7', path: 'w1.md' }, ctx);
    check('read 读回内容', rRead.includes('内容'));

    const rLs = await wsCap.dispatch({ action: 'ls', taskId: 'weekly-summary-x9y8z7' }, ctx);
    check('ls 列出文件', rLs.includes('w1.md'));

    const rBad = await wsCap.dispatch({ action: 'read', taskId: 'weekly-summary-x9y8z7', path: '../escape' }, ctx);
    check('dispatch 里越权返回 error 而不抛', String(rBad).startsWith('error:'), rBad);

    const rNoId = await wsCap.dispatch({ action: 'ls' }, ctx);
    check('缺 taskId 给出提示', String(rNoId).startsWith('error:') && String(rNoId).includes('taskId'));

    const rReserved = await wsCap.dispatch(
        { action: 'rm', taskId: 'weekly-summary-x9y8z7', path: 'meta.json' },
        ctx,
    );
    check('不许删 meta.json', String(rReserved).startsWith('error:'), rReserved);

    console.log('\n=== 7. 定期任务：时间计算与 payload ===');
    const scheduleTask = require(path.join(ROOT, 'src/capabilities/builtin/schedule_task'));
    const workspaceTask = require(path.join(ROOT, 'src/services/workspaceTask'));

    // 用本地时间构造基准：2026-11-19 是周四
    const base = new Date(2026, 10, 19, 10, 0, 0).getTime();
    const asDate = (t) => new Date(t);

    const daily8 = asDate(scheduleTask.computeDueAt({ repeat: 'daily', hour: 8 }, base));
    check('daily 8 点已过 → 顺延到明天 8 点', daily8.getDate() === 20 && daily8.getHours() === 8);
    const daily22 = asDate(scheduleTask.computeDueAt({ repeat: 'daily', hour: 22 }, base));
    check('daily 22 点未到 → 就是今天 22 点', daily22.getDate() === 19 && daily22.getHours() === 22);

    const mon = asDate(scheduleTask.computeDueAt({ repeat: 'weekly', weekday: 1, hour: 8 }, base));
    check('weekly 周一 → 下周一', mon.getDay() === 1 && mon.getDate() === 23);
    const thu12 = asDate(scheduleTask.computeDueAt({ repeat: 'weekly', weekday: 4, hour: 12 }, base));
    check('weekly 周四 12 点未到 → 今天', thu12.getDay() === 4 && thu12.getDate() === 19);

    const m1 = asDate(scheduleTask.computeDueAt({ repeat: 'monthly', day: 1, hour: 8 }, base));
    check('monthly 1 号已过 → 下月 1 号', m1.getMonth() === 11 && m1.getDate() === 1);
    const m25 = asDate(scheduleTask.computeDueAt({ repeat: 'monthly', day: 25, hour: 8 }, base));
    check('monthly 25 号未到 → 本月 25 号', m25.getMonth() === 10 && m25.getDate() === 25);

    check('weekly 触发后顺延 7 天', scheduleTask.nextDueAtAfterFire({ repeat: 'weekly' }, base) === base + 7 * 86400000);
    check('daily 交给共享包（返回 null）', scheduleTask.nextDueAtAfterFire({ repeat: 'daily' }, base) === null);
    check('monthly 顺延到下月同日', (() => {
        const n = asDate(scheduleTask.nextDueAtAfterFire({ repeat: 'monthly', day: 19 }, base));
        return n.getMonth() === 11 && n.getDate() === 19;
    })());

    // payload 往返
    const payload = workspaceTask.buildPayload({
        taskId: 'abc', instruction: '做点事', repeat: 'weekly', hour: 9, minute: 30, weekday: 3,
    });
    const parsed = workspaceTask.parsePayload(payload);
    check('payload 往返保留周期字段', parsed.repeat === 'weekly' && parsed.weekday === 3 && parsed.hour === 9);
    check('坏 payload 返回 null 而不抛', workspaceTask.parsePayload('{{{') === null);

    // 会话前缀：主机靠它认出这是任务而不是闲聊
    check('sessionId 带 workspace: 前缀', workspaceTask.sessionIdFor('abc') === 'workspace:abc');
    check('识别任务会话', workspaceTask.isWorkspaceSession('workspace:abc') === true);
    check('不误判普通群会话', workspaceTask.isWorkspaceSession('bot-x-group:1:2') === false);
    check('从会话取回 taskId', workspaceTask.taskIdFromSession('workspace:abc') === 'abc');

    console.log('\n=== 8. 提示词注入块 ===');
    const { buildWorkspaceBlock } = require(path.join(ROOT, 'src/services/reply/workspaceBlock'));
    const block = buildWorkspaceBlock();
    check('注入块非空', typeof block === 'string' && block.length > 0);
    check('注入块含真实根路径', block.includes(tmpWs));
    check('注入块含任务名', block.includes('每日科技简报') || block.includes('每周汇总'));
    check('注入块告诉它能定期跑', block.includes('schedule_task'));

    console.log('\n=== 9. 建任务（真实落库）===');
    const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
    const { jobStore } = require(path.join(ROOT, 'src/session/jobStore'));
    const schedCap = require(path.join(ROOT, 'src/capabilities/builtin/schedule_task'));

    const created = await schedCap.dispatch(
        { title: '冒烟定期任务', instruction: '每天写一条', repeat: 'daily', hour: 9, minute: 15 },
        { sessionId: 'local-test', uid: 1, origin: 'core' },
    );
    check('schedule_task 建成功', /已建好定期任务/.test(created), created);

    const jobs = dbStorage.listJobRowsByKind('workspace_task', 1, 10);
    check('job 已落库', jobs.length === 1, `共 ${jobs.length}`);
    if (jobs.length) {
        const j = jobs[0];
        check('kind 是 workspace_task', j.kind === 'workspace_task', j.kind);
        check('recurrence 是 daily', j.recurrence === 'daily', j.recurrence);
        check('session_id 带 workspace: 前缀', String(j.session_id).startsWith('workspace:'), j.session_id);
        check('status 是 pending', j.status === 'pending', j.status);
        const pl = workspaceTask.parsePayload(j.payload);
        check('payload 里有 instruction', !!pl && pl.instruction === '每天写一条');
        check('job 对应的工作空间文件夹已建', fs.existsSync(path.join(tmpWs, pl.taskId)));
    }

    // 配额：把上限塞满应该被拒
    const { MAX_TASKS_PER_UID } = scheduleTask;
    check('配额常量合理', MAX_TASKS_PER_UID > 0 && MAX_TASKS_PER_UID <= 100, String(MAX_TASKS_PER_UID));

    // 缺字段要报错（而不是建个空任务）
    const noInstruction = await schedCap.dispatch({ title: '只有标题' }, { sessionId: 's', uid: 1, origin: 'core' });
    check('缺 instruction 被拒', String(noInstruction).startsWith('error:'), noInstruction);

    console.log('\n=== 10. 叶子节点：任务转发给主机（用户明确要求）===');
    // 用户原话：「注意，从机（叶子节点）的任务依旧转发给主机完成」。
    // 这一节刻意把 net/bootstrap 与 conversationService 都替换掉：
    //   - uplinkChat 被调用 = 转发发生了
    //   - getReply 一次都没被调用 = 叶子确实没有在本地跑
    // 两个断言必须同时成立，只查「转发了」会漏掉「转发之后又本地跑一遍」这种双跑 bug。
    const bootPath = require.resolve(path.join(ROOT, 'src/net/bootstrap'));
    const csPath = require.resolve(path.join(ROOT, 'src/services/conversationService'));
    const acPath = require.resolve(path.join(ROOT, 'src/ai/connectionAiContext'));

    const uplinks = [];
    let localRuns = 0;
    const savedBoot = require.cache[bootPath];
    const savedCs = require.cache[csPath];
    const savedAc = require.cache[acPath];

    require.cache[bootPath] = {
        id: bootPath, filename: bootPath, loaded: true,
        exports: {
            shouldUplink: () => true,
            uplinkChat: async ({ sessionId, content }) => {
                uplinks.push({ sessionId, content });
                return { ok: true, frame: { speech: '主机说：已写入 2026-11-19.md' } };
            },
        },
    };
    require.cache[csPath] = {
        id: csPath, filename: csPath, loaded: true,
        exports: { getReply: async () => { localRuns += 1; return { speech: 'LOCAL' }; } },
    };
    require.cache[acPath] = {
        id: acPath, filename: acPath, loaded: true,
        exports: {
            createConnectionAiContext: async () => ({ openai: {}, closed: false }),
            cleanupConnectionAiContext: () => {},
        },
    };

    try {
        const leafJob = {
            jobId: 'wstask:leaf-forward-test',
            sessionId: 'workspace:leaf-forward-test',
            uid: 1,
            kind: 'workspace_task',
            title: '转发测试任务',
            payload: workspaceTask.buildPayload({
                taskId: 'leaf-forward-test',
                instruction: '写一条测试产出',
            }),
            dueAt: Date.now(),
            recurrence: 'daily',
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const firedOk = await workspaceTask.fire(leafJob, Date.now());
        check('叶子触发返回 true（调度器会顺延）', firedOk === true);
        check('向上行转发了一次', uplinks.length === 1, `共 ${uplinks.length} 次`);
        check('叶子没有本地执行模型', localRuns === 0, `本地跑了 ${localRuns} 次`);
        if (uplinks.length) {
            check('上行 sessionId 带 workspace: 前缀', String(uplinks[0].sessionId).startsWith('workspace:'));
            // 上行的是 JSON 载荷而不是拼好的文本：主机要按自己本地日期与最新标题重建指令
            const pl = workspaceTask.parsePayload(uplinks[0].content);
            check('上行 content 是 JSON 载荷', !!pl, String(uplinks[0].content).slice(0, 60));
            check('载荷里有 taskId', !!pl && pl.taskId === 'leaf-forward-test');
            check('载荷里有 instruction', !!pl && pl.instruction === '写一条测试产出');
        }
        check('叶子本机没建任务文件夹（产出在主机）', !fs.existsSync(path.join(tmpWs, 'leaf-forward-test')));

        // 主机不可达时必须降级：不本地跑、不记运行次数，只让 job 顺延
        uplinks.length = 0;
        localRuns = 0;
        require.cache[bootPath].exports.uplinkChat = async () => ({ ok: false, reason: 'timeout' });
        const firedFail = await workspaceTask.fire(leafJob, Date.now());
        check('主机不可达时返回 true（避免 15s 热重试）', firedFail === true);
        check('主机不可达时也不本地跑', localRuns === 0, `本地跑了 ${localRuns} 次`);
    } finally {
        // 还原模块缓存，避免影响后面的用例
        if (savedBoot) require.cache[bootPath] = savedBoot; else delete require.cache[bootPath];
        if (savedCs) require.cache[csPath] = savedCs; else delete require.cache[csPath];
        if (savedAc) require.cache[acPath] = savedAc; else delete require.cache[acPath];
    }

    console.log('\n=== 11. 清理 ===');
    const rmTask = workspace.removeTask('weekly-summary-x9y8z7');
    check('删整个任务文件夹', rmTask.removed === true);
    check('文件夹真的没了', !fs.existsSync(path.join(tmpWs, 'weekly-summary-x9y8z7')));
    check('删不存在的任务返回 not-found', workspace.removeTask('ghost-task').removed === false);

    // 收尾：Windows 上 sqlite 句柄没放干净会让 rmSync 报 EPERM，
    // 所以先显式关库，再带重试删（与 smoke-social 同一套办法）。
    try {
        const db = dbStorage.getDb ? dbStorage.getDb() : null;
        if (db && typeof db.close === 'function') db.close();
    } catch {
        /* 已经关了或没打开 */
    }
    if (!KEEP) {
        const rmOpts = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
        try {
            fs.rmSync(tmpWs, rmOpts);
            fs.rmSync(tmpHome, rmOpts);
        } catch (e) {
            // 临时目录删不掉不该判失败——测试结论已经出来了，别让收尾噪音盖过它
            console.warn(`  （临时目录未能删除，可手动清理：${tmpWs} / ${tmpHome}）: ${e?.message || e}`);
        }
    } else {
        console.log(`\n（--keep）临时目录保留：\n  工作空间 ${tmpWs}\n  home     ${tmpHome}`);
    }

    console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('\n💥 冒烟测试崩溃:', e);
    process.exit(1);
});
