#!/usr/bin/env node
/**
 * 社交环境层冒烟测试（core 端）
 *
 * 为什么需要它：用户 2026-11-19 报「她答不上来自己在哪些群」——那不是提示词问题，
 * 是适配器从来没调过 get_group_list / get_friend_list / get_group_member_list，
 * notice 帧还被整包丢弃。这条链路的每一环都只能靠"真的发一帧、真的收回来"来证明，
 * 单测 mock 掉协议端就失去意义了。
 *
 * 用假的 WebSocket 顶替 `ws` 库，模拟协议端：
 *   1) callAction 能把 action 发出去并等到回包
 *   2) notice / request 帧能被解析成事件
 *   3) 事件与群/好友/成员能落库
 *   4) social 能力的每个 action 都能返回人话
 *   5) 环境摘要块非空且含关键事实
 *
 * 运行：node scripts/smoke-social.js [--keep]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');

// 独立的临时 home，绝不碰真实数据库
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-social-smoke-'));
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

// ── 假 WebSocket：只实现 adapter 用到的部分 ──────────────────────────────
const sentActions = [];
class FakeWS {
    constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        FakeWS.last = this;
        setTimeout(() => this.onopen && this.onopen(), 0);
    }
    on(evt, fn) {
        this[`on${evt}`] = fn;
    }
    send(raw) {
        const frame = JSON.parse(raw);
        sentActions.push(frame.action);
        const respond = (data, retcode = 0) =>
            setTimeout(
                () =>
                    this.onmessage &&
                    this.onmessage(
                        JSON.stringify({ post_type: 'meta_event', echo: frame.echo, retcode, data }),
                    ),
                0,
            );
        switch (frame.action) {
            case 'get_login_info':
                respond({ user_id: 9999, nickname: 'Kirari' });
                break;
            case 'get_group_list':
                respond([
                    { group_id: 111, group_name: '朋友的群', member_count: 12, max_member_count: 200 },
                    { group_id: 222, group_name: '大群', member_count: 480, max_member_count: 500 },
                ]);
                break;
            case 'get_friend_list':
                respond([
                    { user_id: 1001, nickname: '白尔', remark: '' },
                    { user_id: 1002, nickname: '小明', remark: '老同学' },
                ]);
                break;
            case 'get_group_member_list':
                respond([
                    { user_id: 1001, nickname: '白尔', card: '群主白尔', role: 'owner' },
                    { user_id: 1002, nickname: '小明', card: '', role: 'member' },
                ]);
                break;
            default:
                respond(null, 1404); // 未实现的接口：retcode 非 0 → 上层应拿到 null
        }
    }
    close() {
        this.readyState = 3;
    }
}
FakeWS.OPEN = 1;
FakeWS.CONNECTING = 0;
FakeWS.CLOSING = 2;
FakeWS.CLOSED = 3;

// 必须在 require 适配器之前把 'ws' 换掉（适配器内部 require('ws')）
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'ws') return FakeWS;
    return origLoad.call(this, request, ...rest);
};

const { OneBotAdapter } = require(path.join(ROOT, 'src/bot/onebotAdapter'));

(async () => {
    console.log('社交环境层冒烟测试');
    console.log(`  临时 home: ${tmpHome}`);

    console.log('\n[1] 协议端接口调用（callAction）');
    const adapter = new OneBotAdapter({ id: 'qq', name: 'qq', config: { wsUrl: 'ws://fake' } }, () => {});
    adapter.connect();
    await new Promise((r) => setTimeout(r, 60));

    const groups = await adapter.fetchGroupList();
    check('get_group_list 返回 2 个群', Array.isArray(groups) && groups.length === 2);
    check('群名解析正确', groups && groups[0].groupName === '朋友的群');
    check('人数解析为数字', groups && groups[0].memberCount === 12);

    const friends = await adapter.fetchFriendList();
    check('get_friend_list 返回 2 个好友', Array.isArray(friends) && friends.length === 2);
    check('备注保留', friends && friends.find((f) => f.userId === '1002').remark === '老同学');

    const members = await adapter.fetchGroupMemberList('111');
    check('get_group_member_list 返回 2 个成员', Array.isArray(members) && members.length === 2);
    check('角色保留', members && members.some((m) => m.role === 'owner'));

    // 未实现的接口应该安静地返回 null（降级），不能抛异常卡住
    const nope = await adapter.callAction('do_not_exist', {});
    check('未实现接口返回 null 而非抛错', nope === null);

    console.log('\n[2] notice / request 帧解析');
    const events = [];
    adapter.onNotice = (e) => events.push(e);
    const frame = (o) => adapter.handleFrame(JSON.stringify(o));
    await frame({ post_type: 'notice', self_id: 9999, notice_type: 'group_increase', sub_type: 'approve', group_id: 111, user_id: 3003 });
    await frame({ post_type: 'notice', self_id: 9999, notice_type: 'notify', sub_type: 'poke', group_id: 111, user_id: 1002, target_id: 9999 });
    await frame({ post_type: 'notice', self_id: 9999, notice_type: 'group_decrease', sub_type: 'leave', group_id: 111, user_id: 1002 });
    await frame({ post_type: 'notice', self_id: 9999, notice_type: 'notify', sub_type: 'honor', group_id: 111, user_id: 1002 }); // 噪声
    await frame({ post_type: 'request', sub_type: 'friend', user_id: 4004, comment: '你好' });

    check('识别出 4 条事件（噪声被丢弃）', events.length === 4, `实际 ${events.length}`);
    check('事件类型归一化', events.some((e) => e.eventType === 'group_increase:approve'));
    check('戳一戳有描述', events.some((e) => e.eventType === 'notify:poke' && e.detail.includes('戳')));
    check('好友申请只记录不自动同意', events.some((e) => e.eventType === 'request:friend'));

    console.log('\n[3] 落库（social_* 表）');
    const social = require(path.join(ROOT, 'src/services/social'));
    const db = require(path.join(ROOT, 'src/db/dbStorage'));
    for (const e of events) await social.recordEvent(e);
    await db.upsertSocialGroups('qq', groups);
    await db.upsertSocialContacts('qq', friends);
    await db.replaceGroupMembers('qq', '111', members);
    await db.syncGroupReplyFlags('qq', { groupReplyMode: 'mention', groupFilter: 'whitelist', groupAllowlist: ['111'] });

    const ov = await db.socialOverview('qq');
    check('概况：2 个群', ov.groups === 2, JSON.stringify(ov));
    check('概况：2 个好友', ov.contacts === 2);
    check('概况：4 条事件', ov.events === 4);

    const ownerFirst = await db.listGroupMembers('qq', '111');
    check('群主排在成员表最前', ownerFirst[0].role === 'owner', ownerFirst.map((m) => m.role).join(','));

    const g111 = await db.getSocialGroup('qq', '111');
    const g222 = await db.getSocialGroup('qq', '222');
    check('白名单内的群会回话', g111.replyEnabled === true);
    check('白名单外的群不说话', g222.replyEnabled === false);

    console.log('\n[4] social 能力各 action');
    const { dispatch } = require(path.join(ROOT, 'src/capabilities/builtin/social'));
    const ctx = { sessionId: 'bot-qq-group:111:1001', adapterId: 'qq' };
    const call = (args) => dispatch(args, ctx);

    const overview = await call({ action: 'overview' });
    check('overview 报出群数/好友数/事件数', /2 个/.test(overview) && /4 条/.test(overview), overview.replace(/\n/g, ' | '));

    const groupsOut = await call({ action: 'groups' });
    check('groups 列出两个群（limit 缺省不截断）', groupsOut.includes('朋友的群') && groupsOut.includes('大群'), groupsOut.replace(/\n/g, ' | '));

    const friendsOut = await call({ action: 'friends' });
    check('friends 列出两个好友', friendsOut.includes('白尔') && friendsOut.includes('小明'));

    const membersOut = await call({ action: 'members', groupId: '111' });
    check('members 报出成员与群主标记', membersOut.includes('1001') && membersOut.includes('群主'), membersOut.replace(/\n/g, ' | '));

    const eventsOut = await call({ action: 'events' });
    check('events 报出进群/戳/加好友', eventsOut.includes('戳') && eventsOut.includes('好友'));

    const whoOut = await call({ action: 'who', userId: '1001' });
    check('who 查出这个人是谁、在哪个群', whoOut.includes('白尔') && whoOut.includes('朋友的群'), whoOut.replace(/\n/g, ' | '));

    const groupOut = await call({ action: 'group', groupId: '111' });
    check('group 报出群档案', groupOut.includes('朋友的群') && groupOut.includes('12'), groupOut.replace(/\n/g, ' | '));

    const limitOut = await call({ action: 'groups', limit: 1 });
    // 群按人数降序，limit:1 命中的是人多的那个（大群）；关键是只返回一个
    check(
        '显式 limit 生效（只返回 1 个群）',
        limitOut.includes('大群') && !limitOut.includes('朋友的群'),
        limitOut.replace(/\n/g, ' | '),
    );

    const badOut = await call({ action: 'nonsense' });
    check('未知 action 给可读错误', badOut.startsWith('error:'));

    const noGid = await call({ action: 'members' });
    check('缺 groupId 时提示怎么补', noGid.includes('groupId') || noGid.includes('群号'));

    // 回归：适配器 id 自带连字符（线上真实形态是 bot-mvwi1tw3-x1b5）。
    // 早期用 /^bot-([^-]+)-/ 切 sessionId，只抓到第一段，社交查询全被
    // 错误的 adapterId 过滤成空 —— 她就又"答不上来"了。
    console.log('\n[4b] 带连字符的适配器 id（线上真实形态）');
    const hyphenId = 'adp-abc-123';
    await db.upsertSocialGroups(hyphenId, [{ groupId: '900', groupName: '连字符群', memberCount: 5 }]);
    const hyOverview = await dispatch({ action: 'overview' }, { sessionId: `bot-${hyphenId}-private:1001` });
    check(
        '带连字符的 adapterId 能被正确切出来',
        hyOverview.includes('1 个') && !hyOverview.includes('还没同步'),
        hyOverview.replace(/\n/g, ' | '),
    );
    // 三种会话键前缀都要能切（group:/private:/channel:/dm:）
    for (const key of ['group:900:1001', 'private:1001', 'channel:chan1', 'dm:u1']) {
        const o = await dispatch({ action: 'overview' }, { sessionId: `bot-${hyphenId}-${key}` });
        check(`会话键 ${key} 也能切出 adapterId`, o.includes('1 个'), o.replace(/\n/g, ' | '));
    }

    console.log('\n[5] 环境摘要块（注入提示词用）');
    const block = await social.buildEnvironmentBlock({ adapterId: 'qq' });
    check('摘要非空', block.length > 0);
    check('点明群名与人数', block.includes('朋友的群') && block.includes('12 人'));
    check('点明最近事件', block.includes('戳') || block.includes('加'));
    check('明确"这些是事实、别说不清楚"', block.includes('别说不清楚'));
    check('不是 JSON', !block.trim().startsWith('{'));

    console.log('\n[6] 实际发出的协议 action');
    const uniq = [...new Set(sentActions)];
    console.log(`  ${uniq.join(', ')}`);
    check('确实调用了协议端的三个查询接口', ['get_group_list', 'get_friend_list', 'get_group_member_list'].every((a) => uniq.includes(a)));

    console.log('');
    if (failures) {
        console.error(`✗ ${failures} 项失败`);
    } else {
        console.log('✓ 全部通过');
    }

    adapter.disconnect();
    if (!KEEP) {
        setTimeout(() => {
            try {
                fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch {
                /* Windows 上 sqlite 句柄可能还没释放，留给系统临时目录清理 */
            }
            process.exit(failures ? 1 : 0);
        }, 100);
    } else {
        console.log(`（保留了临时目录：${tmpHome}）`);
        process.exit(failures ? 1 : 0);
    }
})().catch((e) => {
    console.error('冒烟测试异常中止:', e);
    process.exit(1);
});
