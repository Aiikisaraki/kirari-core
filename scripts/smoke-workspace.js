// scripts/smoke-workspace.js
// 工作空间 + 定期任务的冒烟测试（不连网、不调真模型，全部落临时目录）。
//
// 跑法：node scripts/smoke-workspace.js [--keep]
//
// 2026-11-20 起工作空间按 owner 隔离，所以**每一节都要显式带 owner**：
// 这本身就是对「隔离是默认、不是特例」的一次回归。凡是还能不带 owner 就拿到
// 全量数据的调用，都是漏了口子，测试应该红。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');

// 两个"人"：主人和她的朋友。用真实 QQ 号形态，顺便验证纯数字 owner 不会被 safeSegment 拦。
const OWNER = '1658359753';
const FRIEND = '1980308740';

const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-ws-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-home-'));
process.env.KIRARI_WORKSPACE = tmpWs;
process.env.KIRARI_HOME = tmpHome;

let failures = 0;
let checks = 0;

function check(name, ok, detail) {
    checks += 1;
    if (ok) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
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
    const t1 = workspace.ensureTask(OWNER, 'daily-news-a1b2c3', { title: '每日科技简报' });
    check('任务文件夹已建', fs.existsSync(t1.dir), t1.dir);
    check('任务文件夹在 owner 层之下', t1.dir.includes(path.join(tmpWs, OWNER)), t1.dir);
    check('meta.json 已写入', fs.existsSync(path.join(t1.dir, workspace.TASK_META_FILE)));
    check('meta 里存了标题', workspace.readTaskMeta(OWNER, 'daily-news-a1b2c3').title === '每日科技简报');
    check('meta 里记了 owner', workspace.readTaskMeta(OWNER, 'daily-news-a1b2c3').owner === OWNER);

    // 改标题：文件夹名不变，这是「按 id 命名」的核心承诺
    workspace.ensureTask(OWNER, 'daily-news-a1b2c3', { title: '科技简报（改名后）' });
    check('改标题后文件夹名没变', fs.existsSync(t1.dir));
    check('改标题后 meta 已更新', workspace.readTaskMeta(OWNER, 'daily-news-a1b2c3').title === '科技简报（改名后）');

    console.log('\n=== 2. 文件读写 / 列目录 / 追加 ===');
    const n = workspace.writeFile(OWNER, 'daily-news-a1b2c3', 'notes/2026-11-19.md', '# 今天的新闻\nAI 有新进展');
    check('写入返回字节数', n > 0, String(n));
    check('读回来内容一致', workspace.readFile(OWNER, 'daily-news-a1b2c3', 'notes/2026-11-19.md').includes('AI 有新进展'));
    check('父目录自动创建', fs.existsSync(path.join(t1.dir, 'notes')));

    const ls = workspace.listFiles(OWNER, 'daily-news-a1b2c3');
    check('列目录含 notes', ls.some((e) => e.name === 'notes' && e.dir));
    check('列目录不暴露 meta.json', !ls.some((e) => e.name === workspace.TASK_META_FILE));
    check('子目录能列', workspace.listFiles(OWNER, 'daily-news-a1b2c3', 'notes').some((e) => e.name === '2026-11-19.md'));

    workspace.writeFile(OWNER, 'daily-news-a1b2c3', 'log.txt', 'line1');
    workspace.writeFile(
        OWNER,
        'daily-news-a1b2c3',
        'log.txt',
        workspace.readFile(OWNER, 'daily-news-a1b2c3', 'log.txt').replace(/\s*$/, '') + '\n\nline2',
    );
    check('追加后两行都在', workspace.readFile(OWNER, 'daily-news-a1b2c3', 'log.txt').includes('line1')
        && workspace.readFile(OWNER, 'daily-news-a1b2c3', 'log.txt').includes('line2'));

    check('statPath 认出目录', workspace.statPath(OWNER, 'daily-news-a1b2c3', 'notes').dir === true);
    check('statPath 不存在返回 null', workspace.statPath(OWNER, 'daily-news-a1b2c3', 'nope.txt') === null);
    expectThrow('读目录当文件要报错', () => workspace.readFile(OWNER, 'daily-news-a1b2c3', 'notes'));

    console.log('\n=== 3. 越权防护（最要紧的一节）===');
    const escapes = [
        ['相对上跳 ..', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', '../escape')],
        ['中途上跳 a/../../b', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', 'a/../../b')],
        ['绝对路径 /etc/passwd', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', '/etc/passwd')],
        ['Windows 盘符 C:/x', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', 'C:/x')],
        ['Windows 盘符 D:\\x', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', 'D:\\x')],
        ['UNC 路径', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', '\\\\server\\share')],
        ['taskId 为 ..', () => workspace.taskDir(OWNER, '..')],
        ['taskId 含斜杠', () => workspace.taskDir(OWNER, 'a/b')],
        ['taskId 含反斜杠', () => workspace.taskDir(OWNER, 'a\\b')],
        ['taskId 是保留设备名 con', () => workspace.taskDir(OWNER, 'con')],
        ['taskId 以点结尾', () => workspace.taskDir(OWNER, 'abc.')],
        ['taskId 以空格结尾', () => workspace.taskDir(OWNER, 'abc ')],
        ['taskId 为空', () => workspace.taskDir(OWNER, '')],
        ['文件名含冒号', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', 'a:b.txt')],
        ['文件名含控制字符', () => workspace.resolveInTask(OWNER, 'daily-news-a1b2c3', 'a\u0000b.txt')],
        // ── owner 本身也是路径，也必须过校验 ──
        ['owner 为 ..', () => workspace.ownerRoot('..')],
        ['owner 含斜杠', () => workspace.ownerRoot('a/b')],
        ['owner 含反斜杠', () => workspace.ownerRoot('a\\b')],
        ['owner 为空', () => workspace.ownerRoot('')],
        ['owner 是保留名 con', () => workspace.ownerRoot('con')],
        ['owner 试图上跳', () => workspace.ownerRoot('../..')],
    ];
    for (const [name, fn] of escapes) expectThrow(`拒绝：${name}`, fn);

    // 拒绝之后必须真的没在空间外面留下东西
    check('工作空间父目录没有多余条目', !fs.existsSync(path.join(tmpWs, '..', 'escape')));

    console.log('\n=== 4. 删除与保留策略 ===');
    workspace.writeFile(OWNER, 'daily-news-a1b2c3', 'tmp/scratch.txt', 'x');
    check('删文件成功', workspace.remove(OWNER, 'daily-news-a1b2c3', 'tmp/scratch.txt').removed === true);
    check('删目录成功', workspace.remove(OWNER, 'daily-news-a1b2c3', 'tmp').removed === true);
    check('删不存在的返回 not-found', workspace.remove(OWNER, 'daily-news-a1b2c3', 'ghost.txt').removed === false);
    expectThrow('不能删任务文件夹本身', () => workspace.remove(OWNER, 'daily-news-a1b2c3', ''));

    // 保留策略作用于**整个任务文件夹**（不只某一个子目录）：这里此刻共有
    // notes/2026-11-19.md、log.txt、old/f0..f4 共 7 个文件，keepFiles=2 应删掉最旧的 5 个。
    for (let i = 0; i < 5; i++) {
        workspace.writeFile(OWNER, 'daily-news-a1b2c3', `old/f${i}.txt`, 'x'.repeat(10));
        // 拉开 mtime，避免同一毫秒排序不稳
        const p = path.join(t1.dir, 'old', `f${i}.txt`);
        const t = Date.now() - (5 - i) * 60000;
        fs.utimesSync(p, new Date(t), new Date(t));
    }
    const beforePrune = workspace.overview(OWNER).list.find((x) => x.taskId === 'daily-news-a1b2c3').files;
    check('清理前文件数对得上', beforePrune === 7, String(beforePrune));
    const pr = workspace.pruneTask(OWNER, 'daily-news-a1b2c3', { keepFiles: 2, keepDays: 0, keepBytes: 0 });
    check('保留策略删掉最旧的 5 个', pr.deleted === 5, String(pr.deleted));
    check('正好剩下 2 个文件', workspace.overview(OWNER).list.find((x) => x.taskId === 'daily-news-a1b2c3').files === 2);
    check('最旧的 old/ 全被清掉', workspace.listFiles(OWNER, 'daily-news-a1b2c3', 'old').length === 0);
    check('最新的两个留下', workspace.listFiles(OWNER, 'daily-news-a1b2c3').some((e) => e.name === 'log.txt'));
    check('meta.json 没被清理', fs.existsSync(path.join(t1.dir, workspace.TASK_META_FILE)));

    // recordRun 记运行次数
    workspace.recordRun(OWNER, 'daily-news-a1b2c3');
    workspace.recordRun(OWNER, 'daily-news-a1b2c3');
    check('运行次数累加', workspace.readTaskMeta(OWNER, 'daily-news-a1b2c3').runCount === 2);
    check('记了最近运行时间', !!workspace.readTaskMeta(OWNER, 'daily-news-a1b2c3').lastRunAt);

    console.log('\n=== 5. 概览与列表 ===');
    workspace.ensureTask(OWNER, 'weekly-summary-x9y8z7', { title: '每周汇总' });
    const ov = workspace.overview(OWNER);
    check('概览统计到 2 个任务', ov.tasks === 2, String(ov.tasks));
    check('概览里根路径是 owner 那层', ov.root === path.join(tmpWs, OWNER), ov.root);
    check('概览里带 owner', ov.owner === OWNER, ov.owner);
    check('列表按最近运行排序（跑过的在前）', workspace.listTasks(OWNER)[0].taskId === 'daily-news-a1b2c3');

    console.log('\n=== 6. 按人隔离（2026-11-20 用户报障的核心）===');
    // 用户原话：「她是私聊我的机器人，建立了几个每日任务，但是我怎么可以直接看到她的任务呢」
    // 这一节就是那条报障的回归：朋友的目录、任务、产物，主人一个都不该在自己的列表里看到。
    workspace.ensureTask(FRIEND, 'friend-secret-task', { title: '朋友的私密任务' });
    workspace.writeFile(FRIEND, 'friend-secret-task', 'diary.md', '这是朋友写的东西');

    const ownerTasks = workspace.listTasks(OWNER).map((t) => t.taskId);
    const friendTasks = workspace.listTasks(FRIEND).map((t) => t.taskId);
    check('朋友的任务在自己列表里', friendTasks.includes('friend-secret-task'));
    check('朋友的任务没混进主人的列表', !ownerTasks.includes('friend-secret-task'), ownerTasks.join(','));
    check('主人的任务没混进朋友的列表', !friendTasks.includes('daily-news-a1b2c3'), friendTasks.join(','));
    check('两人的目录物理分开',
        workspace.taskDir(OWNER, 'weekly-summary-x9y8z7') !== workspace.taskDir(FRIEND, 'weekly-summary-x9y8z7'));

    // 同名 taskId 在两人各自空间里互不干扰（这是按 owner 分层最实际的好处）
    workspace.ensureTask(FRIEND, 'daily-news-a1b2c3', { title: '朋友也建了个同名任务' });
    workspace.writeFile(FRIEND, 'daily-news-a1b2c3', 'log.txt', '朋友的内容');
    check('同名 taskId 两份内容互不覆盖',
        workspace.readFile(OWNER, 'daily-news-a1b2c3', 'log.txt') !== '朋友的内容');
    check('同名 taskId 的标题也各自独立',
        workspace.readTaskMeta(FRIEND, 'daily-news-a1b2c3').title === '朋友也建了个同名任务');

    // 主人不能借自己的 owner 读到朋友的产物
    expectThrow('用主人身份读朋友的产物会被路径挡下',
        () => workspace.readFile(OWNER, 'friend-secret-task', 'diary.md'));

    // 概览也只算自己那层
    check('主人概览不含朋友任务数', workspace.overview(OWNER).tasks === 2, String(workspace.overview(OWNER).tasks));
    check('朋友概览只算自己的', workspace.overview(FRIEND).tasks === 2, String(workspace.overview(FRIEND).tasks));

    // listOwners 是管理视角，能看出"还有别人"，但只是数字
    const owners = workspace.listOwners().map((o) => o.owner).sort();
    check('listOwners 能看出有两个人的空间',
        owners.includes(OWNER) && owners.includes(FRIEND), owners.join(','));

    // pruneAll 不带 owner 时清全部；带 owner 时只清那一个
    check('pruneAll 能按 owner 限定范围',
        workspace.pruneAll(FRIEND, { keepDays: 0, keepFiles: 0, keepBytes: 0 }).every((r) => r.owner === FRIEND));

    console.log('\n=== 7. 能力注册与 dispatch ===');
    const registry = require(path.join(ROOT, 'src/capabilities/registry'));
    const names = (registry.listTools('local:1') || []).map((t) => t.function.name);
    check('workspace 能力已注册', names.includes('workspace'));
    check('schedule_task 能力已注册', names.includes('schedule_task'));

    const wsCap = require(path.join(ROOT, 'src/capabilities/builtin/workspace'));
    // 能力的 owner 只从 ctx 解析：这里模拟"主人在本地会话里"，会话里没有对话者 → _local
    const ctxLocal = { sessionId: 'local-test', uid: 1, origin: 'core' };
    // 模拟"主人在 QQ 私聊里"：counterpartId 就是他自己的 QQ 号
    const ctxOwner = {
        sessionId: `bot-adapter-x-private:${OWNER}`,
        uid: 1,
        origin: 'core',
        counterpartId: OWNER,
        role: 'owner',
        isGroup: false,
    };
    // 模拟"朋友在 QQ 私聊里"
    const ctxFriend = {
        sessionId: `bot-adapter-x-private:${FRIEND}`,
        uid: 1,
        origin: 'core',
        counterpartId: FRIEND,
        role: 'user',
        isGroup: false,
    };

    check('能力能认出本机 owner', wsCap.resolveOwner(ctxLocal) === wsCap.LOCAL_OWNER);
    check('能力能从 ctx 认出主人', wsCap.resolveOwner(ctxOwner) === OWNER);
    check('能力能从 ctx 认出朋友', wsCap.resolveOwner(ctxFriend) === FRIEND);

    const rOverview = await wsCap.dispatch({ action: 'overview' }, ctxOwner);
    check('overview 返回人话', typeof rOverview === 'string' && rOverview.includes(path.join(tmpWs, OWNER)), rOverview.slice(0, 80));

    const rTasks = await wsCap.dispatch({ action: 'tasks' }, ctxOwner);
    check('主人的 tasks 列出自己的两个任务',
        rTasks.includes('daily-news-a1b2c3') && rTasks.includes('weekly-summary-x9y8z7'), rTasks);
    check('主人的 tasks 完全不提朋友的任务', !rTasks.includes('friend-secret-task'), rTasks);

    const rFriendTasks = await wsCap.dispatch({ action: 'tasks' }, ctxFriend);
    check('朋友的 tasks 只看到自己的', rFriendTasks.includes('friend-secret-task'), rFriendTasks);
    check('朋友的 tasks 看不到主人的', !rFriendTasks.includes('weekly-summary-x9y8z7'), rFriendTasks);

    // 朋友不能通过传 taskId 偷看主人的任务（owner 不从参数取，所以压根找不到）
    const rSteal = await wsCap.dispatch({ action: 'read', taskId: 'weekly-summary-x9y8z7', path: 'notes/2026-11-19.md' }, ctxFriend);
    check('朋友读主人的文件失败', String(rSteal).startsWith('error:'), rSteal);

    // others：两步确认
    const rOthersNoConfirm = await wsCap.dispatch({ action: 'others' }, ctxOwner);
    check('主人未确认时只报数量不报内容',
        rOthersNoConfirm.includes('要不要看') || rOthersNoConfirm.includes('要看'),
        rOthersNoConfirm);
    check('主人未确认时不泄露任务名', !rOthersNoConfirm.includes('friend-secret-task'), rOthersNoConfirm);

    const rOthersConfirmed = await wsCap.dispatch({ action: 'others', confirm: true }, ctxOwner);
    check('主人确认后才看到朋友的任务名', rOthersConfirmed.includes('friend-secret-task'), rOthersConfirmed);
    check('确认后仍然先报自己的数量', rOthersConfirmed.indexOf(`你自己有`) < rOthersConfirmed.indexOf('friend-secret-task'), rOthersConfirmed.slice(0, 120));

    const rFriendOthers = await wsCap.dispatch({ action: 'others' }, ctxFriend);
    check('普通用户连"还有别人"都看不到', !/还有\s*\d+\s*个用户/.test(rFriendOthers), rFriendOthers);

    // 写入只落在自己那层
    const rWrite = await wsCap.dispatch(
        { action: 'write', taskId: 'weekly-summary-x9y8z7', path: 'w1.md', content: '内容' },
        ctxOwner,
    );
    check('write 成功', /已写入/.test(rWrite), rWrite);
    check('write 落在主人自己那层',
        fs.existsSync(path.join(tmpWs, OWNER, 'weekly-summary-x9y8z7', 'w1.md')));

    const rRead = await wsCap.dispatch({ action: 'read', taskId: 'weekly-summary-x9y8z7', path: 'w1.md' }, ctxOwner);
    check('read 读回内容', rRead.includes('内容'));

    const rLs = await wsCap.dispatch({ action: 'ls', taskId: 'weekly-summary-x9y8z7' }, ctxOwner);
    check('ls 列出文件', rLs.includes('w1.md'));

    const rBad = await wsCap.dispatch({ action: 'read', taskId: 'weekly-summary-x9y8z7', path: '../escape' }, ctxOwner);
    check('dispatch 里越权返回 error 而不抛', String(rBad).startsWith('error:'), rBad);

    const rNoId = await wsCap.dispatch({ action: 'ls' }, ctxOwner);
    check('缺 taskId 给出提示', String(rNoId).startsWith('error:') && String(rNoId).includes('taskId'));

    const rReserved = await wsCap.dispatch(
        { action: 'rm', taskId: 'weekly-summary-x9y8z7', path: 'meta.json' },
        ctxOwner,
    );
    check('不许删 meta.json', String(rReserved).startsWith('error:'), rReserved);

    console.log('\n=== 8. 定期任务：时间计算与 payload ===');
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

    // payload 往返（owner 必须过得去，否则主机侧不知道写进谁的目录）
    const payload = workspaceTask.buildPayload({
        taskId: 'abc', owner: OWNER, instruction: '做点事', repeat: 'weekly', hour: 9, minute: 30, weekday: 3,
    });
    const parsed = workspaceTask.parsePayload(payload);
    check('payload 往返保留周期字段', parsed.repeat === 'weekly' && parsed.weekday === 3 && parsed.hour === 9);
    check('payload 往返保留 owner', parsed.owner === OWNER, String(parsed.owner));
    check('坏 payload 返回 null 而不抛', workspaceTask.parsePayload('{{{') === null);

    // 会话 id：前缀 + owner + taskId，主机靠它认出「这是谁的任务」
    check('sessionId 带 owner', workspaceTask.sessionIdFor(OWNER, 'abc') === `workspace:${OWNER}:abc`);
    check('识别任务会话', workspaceTask.isWorkspaceSession(`workspace:${OWNER}:abc`) === true);
    check('不误判普通群会话', workspaceTask.isWorkspaceSession('bot-x-group:1:2') === false);
    check('从新格式会话取回 taskId', workspaceTask.taskIdFromSession(`workspace:${OWNER}:abc`) === 'abc');
    check('从新格式会话取回 owner', workspaceTask.ownerFromSession(`workspace:${OWNER}:abc`) === OWNER);
    // 老格式（2026-11-19 上线那批，线上还有 5 个在跑）必须继续认
    check('老格式会话仍能取回 taskId', workspaceTask.taskIdFromSession('workspace:abc') === 'abc');
    check('老格式会话的 owner 是空（由调用方兜底）', workspaceTask.ownerFromSession('workspace:abc') === '');
    check('parseSessionId 两段拆得开', (() => {
        const p = workspaceTask.parseSessionId(`workspace:${OWNER}:abc`);
        return p.owner === OWNER && p.taskId === 'abc';
    })());

    console.log('\n=== 9. 提示词注入块 ===');
    const { buildWorkspaceBlock } = require(path.join(ROOT, 'src/services/reply/workspaceBlock'));
    // 注入块按人隔离：必须带上「在跟谁说话」，否则走的是 _local 那层（本机/控制台）
    const block = buildWorkspaceBlock({ sessionId: `bot-adapter-x-private:${OWNER}`, counterpartId: OWNER });
    check('注入块非空', typeof block === 'string' && block.length > 0);
    check('注入块含真实根路径', block.includes(tmpWs));
    check('注入块指向 owner 那层', block.includes(path.join(tmpWs, OWNER)), block.slice(0, 160));
    check('注入块含任务名', block.includes('每日科技简报') || block.includes('每周汇总'), block);
    check('注入块不含别人的任务名', !block.includes('朋友的私密任务'), block);
    check('注入块告诉它能定期跑', block.includes('schedule_task'));
    check('注入块说明了按人隔离', block.includes('按人分开') || block.includes('别人的任务你看不到'), block);

    // 换个 owner，注入块就该换成另一个人的内容
    const friendBlock = buildWorkspaceBlock({ sessionId: `bot-adapter-x-private:${FRIEND}`, counterpartId: FRIEND });
    check('朋友的注入块只含自己的任务', friendBlock.includes('朋友的私密任务'), friendBlock);
    check('朋友的注入块不含主人的任务', !friendBlock.includes('每日科技简报'), friendBlock);

    // 不带 ctx（本机/控制台）→ 走 _local，看不到别人建在 QQ 下的任务
    const localBlock = buildWorkspaceBlock();
    check('控制台注入块不含 QQ 用户的任务', !localBlock.includes('每日科技简报'), localBlock);

    console.log('\n=== 10. 建任务（真实落库）===');
    const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));
    const { jobStore } = require(path.join(ROOT, 'src/session/jobStore'));
    const schedCap = require(path.join(ROOT, 'src/capabilities/builtin/schedule_task'));

    const created = await schedCap.dispatch(
        { title: '冒烟定期任务', instruction: '每天写一条', repeat: 'daily', hour: 9, minute: 15 },
        ctxOwner,
    );
    check('schedule_task 建成功', /已建好定期任务/.test(created), created);

    const jobs = dbStorage.listJobRowsByKind('workspace_task', 1, 10);
    check('job 已落库', jobs.length === 1, `共 ${jobs.length}`);
    if (jobs.length) {
        const j = jobs[0];
        check('kind 是 workspace_task', j.kind === 'workspace_task', j.kind);
        check('recurrence 是 daily', j.recurrence === 'daily', j.recurrence);
        check('session_id 带 workspace: 前缀', String(j.session_id).startsWith('workspace:'), j.session_id);
        check('session_id 里带 owner', String(j.session_id).includes(OWNER), j.session_id);
        check('status 是 pending', j.status === 'pending', j.status);
        const pl = workspaceTask.parsePayload(j.payload);
        check('payload 里有 instruction', !!pl && pl.instruction === '每天写一条');
        check('payload 里有 owner', !!pl && pl.owner === OWNER, String(pl && pl.owner));
        check('job 对应的工作空间文件夹已建（在 owner 层下）',
            fs.existsSync(path.join(tmpWs, OWNER, pl.taskId)), path.join(tmpWs, OWNER, pl.taskId));
    }

    // 朋友建任务：自己的任务数按 owner 算，不跟主人抢同一个配额
    const friendCreated = await schedCap.dispatch(
        { title: '朋友的每日任务', instruction: '每天记一笔', repeat: 'daily', hour: 8 },
        ctxFriend,
    );
    check('朋友也能建任务（配额不按 uid 共享）', /已建好定期任务/.test(friendCreated), friendCreated);
    const friendDir = workspace.listTasks(FRIEND).some((t) => t.title === '朋友的每日任务');
    check('朋友的任务落在朋友那层', friendDir);
    check('朋友的任务没落进主人那层',
        !workspace.listTasks(OWNER).some((t) => t.title === '朋友的每日任务'));

    // 去重：同样的标题 + 内容不该再建一个
    const dupCreated = await schedCap.dispatch(
        { title: '冒烟定期任务', instruction: '每天写一条', repeat: 'daily', hour: 9, minute: 15 },
        ctxOwner,
    );
    check('重复任务被识别并复用', /已经有一个一样的任务/.test(dupCreated), dupCreated);

    // 缺字段要报错（而不是建个空任务）
    const noInstruction = await schedCap.dispatch({ title: '只有标题' }, ctxOwner);
    check('缺 instruction 被拒', String(noInstruction).startsWith('error:'), noInstruction);

    // 配额常量合理
    check('配额常量合理', scheduleTask.MAX_TASKS_PER_UID > 0 && scheduleTask.MAX_TASKS_PER_UID <= 100,
        String(scheduleTask.MAX_TASKS_PER_UID));

    console.log('\n=== 11. 叶子节点：任务转发给主机（用户明确要求）===');
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
            jobId: `wstask:${OWNER}:leaf-forward-test`,
            sessionId: `workspace:${OWNER}:leaf-forward-test`,
            uid: 1,
            kind: 'workspace_task',
            title: '转发测试任务',
            payload: workspaceTask.buildPayload({
                taskId: 'leaf-forward-test',
                owner: OWNER,
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
            check('上行 sessionId 带 owner',
                String(uplinks[0].sessionId) === `workspace:${OWNER}:leaf-forward-test`, uplinks[0].sessionId);
            // 上行的是 JSON 载荷而不是拼好的文本：主机要按自己本地日期与最新标题重建指令
            const pl = workspaceTask.parsePayload(uplinks[0].content);
            check('上行 content 是 JSON 载荷', !!pl, String(uplinks[0].content).slice(0, 60));
            check('载荷里有 taskId', !!pl && pl.taskId === 'leaf-forward-test');
            check('载荷里有 owner', !!pl && pl.owner === OWNER, String(pl && pl.owner));
            check('载荷里有 instruction', !!pl && pl.instruction === '写一条测试产出');
        }
        check('叶子本机没建任务文件夹（产出在主机）',
            !fs.existsSync(path.join(tmpWs, OWNER, 'leaf-forward-test')));

        // 主机不可达时必须降级：不本地跑、不记运行次数，只让 job 顺延
        uplinks.length = 0;
        localRuns = 0;
        require.cache[bootPath].exports.uplinkChat = async () => ({ ok: false, reason: 'timeout' });
        const firedFail = await workspaceTask.fire(leafJob, Date.now());
        check('主机不可达时返回 true（避免 15s 热重试）', firedFail === true);
        check('主机不可达时也不本地跑', localRuns === 0, `本地跑了 ${localRuns} 次`);

        // 主机替叶子执行时拿不到标题（上行 payload 里不带 title），传空 title
        // 不能把用户在主机上设的名字清掉 —— 否则每次叶子任务跑完，主机那边的
        // meta.json 标题都会被抹成一个 taskId。
        workspace.ensureTask(OWNER, 'host-side-task', { title: '用户设的标题' });
        await workspaceTask.runLocally({
            owner: OWNER,
            taskId: 'host-side-task',
            title: '',
            instruction: '主机代跑',
            deliver: false,
        });
        check('空 title 不会清空已有 meta 标题',
            workspace.readTaskMeta(OWNER, 'host-side-task').title === '用户设的标题',
            `实际=${JSON.stringify(workspace.readTaskMeta(OWNER, 'host-side-task').title)}`);

        // 主机代跑必须写进 owner 那层，不能落到根目录
        check('主机代跑落在 owner 层下',
            fs.existsSync(path.join(tmpWs, OWNER, 'host-side-task')));
    } finally {
        // 还原模块缓存，避免影响后面的用例
        if (savedBoot) require.cache[bootPath] = savedBoot; else delete require.cache[bootPath];
        if (savedCs) require.cache[csPath] = savedCs; else delete require.cache[csPath];
        if (savedAc) require.cache[acPath] = savedAc; else delete require.cache[acPath];
    }

    console.log('\n=== 12. 提醒送达（2026-11-20 用户报障：7 点没收到）===');
    // 用户原话：「六点多的时候，它还知道要7点提醒我，但是到了7点也没提醒我」
    // 根因：reminder 只推桌面 WebSocket，QQ 里定的提醒到点桌面没开就静默丢了。
    // 这一节验证 deliverReminder 会走两条腿，并且都失败时不再假装成功。
    const schedSvcPath = require.resolve(path.join(ROOT, 'src/services/scheduledJobsService'));
    const socketPath = require.resolve(path.join(ROOT, 'src/websocket/socketServer'));
    const botPath = require.resolve(path.join(ROOT, 'src/bot/botManager'));
    const savedSocket = require.cache[socketPath];
    const savedBot = require.cache[botPath];

    const wsPushes = [];
    const qqPushes = [];
    let wsOnline = 0;

    require.cache[socketPath] = {
        id: socketPath, filename: socketPath, loaded: true,
        exports: {
            // 老接口保留（别的地方可能还在用），但**不该再被提醒逻辑调用**
            pushProactiveMessage: (uid, msg) => {
                wsPushes.push({ kind: 'broadcast', uid, msg });
                return wsOnline;
            },
            // 新接口：按 owner 定向。测试桩记录 owner，供断言「推给了谁」
            pushProactiveMessageToOwner: (ownerKey, msg) => {
                wsPushes.push({ kind: 'directed', ownerKey, msg });
                return wsOnline;
            },
        },
    };
    require.cache[botPath] = {
        id: botPath, filename: botPath, loaded: true,
        exports: {
            pushToUserSession: (sessionId, text) => {
                // 复刻真实实现的守卫：非平台会话（本地 uuid）没有回发通道。
                // 测试桩必须照抄这条，否则「本地会话只走桌面」那条断言永远是假的。
                if (!String(sessionId || '').startsWith('bot-')) return false;
                qqPushes.push({ sessionId, text });
                return true;
            },
        },
    };

    try {
        delete require.cache[schedSvcPath];
        const schedSvc = require(schedSvcPath);

        // ① 桌面不在线，但 sessionId 是 QQ 私聊 → 必须走平台发出去
        wsOnline = 0;
        wsPushes.length = 0;
        qqPushes.length = 0;
        const remindJob = {
            jobId: 'job-reminder-test',
            sessionId: `bot-adapter-x-private:${OWNER}`,
            uid: 1,
            kind: 'reminder',
            title: '出去活动提醒',
            payload: '该出去活动活动啦',
        };
        // 通过 scanOnce 的同一入口验证：这里直接调模块内部不便，改用 jobStore 走一遍
        const { jobStore: js } = require(path.join(ROOT, 'src/session/jobStore'));
        const remindRow = require('kirari-agent').createJob({
            jobId: 'job-reminder-test',
            sessionId: remindJob.sessionId,
            origin: 'core',
            uid: 1,
            kind: 'reminder',
            title: '出去活动提醒',
            payload: '该出去活动活动啦',
            dueAt: Date.now() - 1000,
            recurrence: 'once',
            now: Date.now(),
        });
        js.save(remindRow, 'job_created');
        await schedSvc.scanOnce();
        check('提醒推了桌面一次', wsPushes.length === 1, `共 ${wsPushes.length} 次`);
        // ★ 身份隔离的核心断言：推桌面必须是「定向到人」，不能是按 uid 广播。
        //   之前 pushProactiveMessage(uid) 因为 uid 对所有人都是 1，等于推给所有桌面。
        check('桌面推送是定向到人的，不是广播',
            wsPushes.every((p) => p.kind === 'directed'),
            wsPushes.map((p) => p.kind).join(',') || '无');
        check('桌面推送的目标就是这条提醒的归属人',
            wsPushes.length > 0 && wsPushes[0].ownerKey === OWNER,
            wsPushes.length ? String(wsPushes[0].ownerKey) : '无');
        check('桌面不在线时改走平台发送', qqPushes.length === 1, `共 ${qqPushes.length} 次`);
        check('平台发送用的是原会话 id',
            qqPushes.length > 0 && qqPushes[0].sessionId === remindJob.sessionId,
            qqPushes.length ? qqPushes[0].sessionId : '');

        // ② 桌面在线时两条都发（桌宠能说出来 + QQ 也留一份）
        wsOnline = 2;
        wsPushes.length = 0;
        qqPushes.length = 0;
        const remindRow2 = require('kirari-agent').createJob({
            jobId: 'job-reminder-test-2',
            sessionId: `bot-adapter-x-private:${OWNER}`,
            origin: 'core',
            uid: 1,
            kind: 'reminder',
            title: '第二条提醒',
            payload: '第二条内容',
            dueAt: Date.now() - 1000,
            recurrence: 'once',
            now: Date.now(),
        });
        js.save(remindRow2, 'job_created');
        await schedSvc.scanOnce();
        check('桌面在线时也推了桌面', wsPushes.length === 1, `共 ${wsPushes.length} 次`);
        check('桌面在线时平台照样发一份', qqPushes.length === 1, `共 ${qqPushes.length} 次`);
        check('② 仍然是定向推送，目标仍是归属人',
            wsPushes.every((p) => p.kind === 'directed') && wsPushes[0]?.ownerKey === OWNER,
            wsPushes.map((p) => `${p.kind}:${p.ownerKey}`).join(',') || '无');

        // ③ 桌面本地会话（纯 uuid）没有平台通道 → 只推桌面，且不崩
        wsOnline = 1;
        wsPushes.length = 0;
        qqPushes.length = 0;
        const localRemind = require('kirari-agent').createJob({
            jobId: 'job-reminder-test-3',
            sessionId: '9284e4f6-7123-4577-bb69-d788bd1cadce',
            origin: 'core',
            uid: 1,
            kind: 'reminder',
            title: '本地会话提醒',
            payload: '本地提醒内容',
            dueAt: Date.now() - 1000,
            recurrence: 'once',
            now: Date.now(),
        });
        js.save(localRemind, 'job_created');
        await schedSvc.scanOnce();
        check('本地会话提醒只走桌面', wsPushes.length === 1 && qqPushes.length === 0,
            `桌面 ${wsPushes.length} / 平台 ${qqPushes.length}`);
        // 纯 uuid 会话 = 本机自用 → owner 解析成 _local，只落在「没联动任何人」的桌面上
        check('本地会话的桌面推送目标是 _local（本机）',
            wsPushes.length > 0 && wsPushes[0].ownerKey === '_local',
            wsPushes.length ? String(wsPushes[0].ownerKey) : '无');
        check('本地会话也没走广播',
            wsPushes.every((p) => p.kind === 'directed'),
            wsPushes.map((p) => p.kind).join(',') || '无');
    } finally {
        if (savedSocket) require.cache[socketPath] = savedSocket; else delete require.cache[socketPath];
        if (savedBot) require.cache[botPath] = savedBot; else delete require.cache[botPath];
        delete require.cache[schedSvcPath];
    }

    console.log('\n=== 13. 清理 ===');
    const rmTask = workspace.removeTask(OWNER, 'weekly-summary-x9y8z7');
    check('删整个任务文件夹', rmTask.removed === true);
    check('文件夹真的没了', !fs.existsSync(path.join(tmpWs, OWNER, 'weekly-summary-x9y8z7')));
    check('删不存在的任务返回 not-found', workspace.removeTask(OWNER, 'ghost-task').removed === false);
    check('删朋友的任务要用朋友的 owner', workspace.removeTask(FRIEND, 'friend-secret-task').removed === true);
    check('主人的同名任务没被删掉', fs.existsSync(workspace.taskDir(OWNER, 'daily-news-a1b2c3')));

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

    console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}（共 ${checks} 项检查）\n`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('\n💥 冒烟测试崩溃:', e);
    process.exit(1);
});
