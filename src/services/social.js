// src/services/social.js
// 社交环境服务：把她「周围的真实世界」变成她真的能看见的东西。
//
// 用户 2026-11-19 的反馈（原话）：
//   「我希望她至少管理会话的能力是完整的，能看到机器人协议端的所有能力接口，
//     看到几个好友，几个群，谁加群了，谁戳一下了，群里有几个人…………一系列。
//     我希望她能完整意识到自己的人际关系和周围的环境。」
//
// 而她当时的实际回答是「这个我真答不上来——我没有能查看『加入了哪些群』的接口」。
// 那句话是**事实正确**的：OneBot 适配器从头到尾只调用过 get_login_info 和
// get_image，get_group_list / get_friend_list / get_group_member_list 一次都没调，
// notice 帧（进群/退群/戳一戳）被 post_type !== 'message' 整包丢弃。
//
// 所以这一层的职责很明确：
//   1. 把这些协议接口的结果缓存下来（social_* 表），重启后还在；
//   2. 把 notice 事件记成流水，让她知道「刚才发生了什么」；
//   3. 提供结构化摘要，供能力（social tool）和提示词注入使用。
//
// 注意：这里只做「她自己的环境」，不做社交推荐/推理。她要知道事实，联想归记忆层。

const db = require('../db/dbStorage');

/** 支持社交同步的适配器类型（目前只有 OneBot v11 有这套接口）。 */
function supportsSocial(adapter) {
  return !!adapter && typeof adapter.fetchGroupList === 'function';
}

/**
 * 全量同步一个适配器的社交环境。
 * @param {Object} adapter OneBotAdapter 实例（需有 fetchGroupList/fetchFriendList/fetchGroupMemberList）
 * @param {Object} cfg 适配器配置（用于同步"哪些群允许回复"）
 * @returns {Promise<Object>} 同步结果统计
 */
async function syncAdapter(adapter, cfg = {}) {
  const adapterId = adapter && adapter.id;
  if (!adapterId) return { ok: false, reason: 'no_adapter' };
  if (!supportsSocial(adapter)) return { ok: false, reason: 'unsupported' };

  const result = { ok: true, groups: 0, friends: 0, members: 0 };

  try {
    const groups = await adapter.fetchGroupList();
    if (Array.isArray(groups)) {
      await db.upsertSocialGroups(adapterId, groups);
      result.groups = groups.length;
    }
  } catch (e) {
    result.groupsError = e?.message || String(e);
  }

  try {
    const friends = await adapter.fetchFriendList();
    if (Array.isArray(friends)) {
      await db.upsertSocialContacts(adapterId, friends);
      result.friends = friends.length;
    }
  } catch (e) {
    result.friendsError = e?.message || String(e);
  }

  // 群成员：只同步人数合理的群（超大群拉一次很贵，且对"知道有谁"意义有限）
  try {
    const groupRows = await db.listSocialGroups(adapterId);
    for (const g of groupRows) {
      if (typeof g.memberCount === 'number' && g.memberCount > 500) continue;
      const members = await adapter.fetchGroupMemberList(g.groupId);
      if (Array.isArray(members)) {
        await db.replaceGroupMembers(adapterId, g.groupId, members);
        result.members += members.length;
      }
    }
  } catch (e) {
    result.membersError = e?.message || String(e);
  }

  // 「我在这群能不能说话」：与适配器配置保持一致，免得她以为自己在群里能随便回
  try {
    await db.syncGroupReplyFlags(adapterId, cfg || {});
  } catch (e) {
    result.flagsError = e?.message || String(e);
  }

  return result;
}

/** 只刷新单个群的成员（有人进群/退群时用，比全量便宜）。 */
async function refreshGroup(adapter, groupId) {
  if (!supportsSocial(adapter)) return { ok: false, reason: 'unsupported' };
  const members = await adapter.fetchGroupMemberList(groupId);
  if (!Array.isArray(members)) return { ok: false, reason: 'unsupported' };
  await db.replaceGroupMembers(adapter.id, String(groupId), members);
  // 顺手把群人数对齐（协议端加的群，人数就是成员表长度）
  try {
    await db.upsertSocialGroups(adapter.id, [{ groupId: String(groupId), memberCount: members.length }]);
  } catch {
    /* 人数更新失败不影响成员表 */
  }
  return { ok: true, members: members.length };
}

/**
 * 记录一条环境事件（notice / request）。
 * 进群/退群会让成员表过期，这里顺手标记待刷新，由上层决定何时拉。
 */
async function recordEvent(evt = {}) {
  const adapterId = String(evt.adapterId || '');
  const eventType = String(evt.eventType || '');
  if (!adapterId || !eventType) return false;
  await db.addSocialEvent({
    adapterId,
    eventType,
    groupId: evt.groupId || null,
    actorId: evt.actorId || null,
    targetId: evt.targetId || null,
    detail: evt.detail || null,
  });
  return true;
}

/** 成员数发生变化的事件类型（需要刷新成员表）。 */
function affectsMembership(eventType) {
  const t = String(eventType || '');
  return t.startsWith('group_increase') || t.startsWith('group_decrease');
}

/**
 * 她当前所处的社交环境摘要 —— 给人看的自然语言，不是 JSON。
 * 注入提示词用，让她不用查工具也知道"我在哪、周围有谁"。
 *
 * @param {Object} opts { adapterId, limit }
 * @returns {Promise<string>} 空串表示没有可取信息（不注入，免得占位）
 */
async function buildEnvironmentBlock(opts = {}) {
  const lines = [];
  try {
    const overview = await db.socialOverview(opts.adapterId || null);
    if (!overview.groups && !overview.contacts) return '';

    lines.push('\n\n【你周围的环境 · 这些是事实，不用猜】');
    if (opts.adapterId) lines.push(`- 接入方式：${opts.adapterId}（OneBot 协议端）。`);
    lines.push(`- 你在 ${overview.groups} 个群里，通讯录里有 ${overview.contacts} 个好友；这些群里一共有 ${overview.members} 个不同的人。`);
    if (overview.people) lines.push(`- 到目前为止真正跟你说过话的有 ${overview.people} 个人。`);

    const groups = await db.listSocialGroups(opts.adapterId || null);
    if (groups.length) {
      const shown = groups.slice(0, 12).map((g) => {
        const n = typeof g.memberCount === 'number' ? `${g.memberCount} 人` : '人数未知';
        const name = g.groupName || `群 ${g.groupId}`;
        return `${name}（${n}，${g.replyEnabled ? '你在群里会回话' : '你在这个群不说话'}）`;
      });
      lines.push(`- 具体的群：${shown.join('；')}${groups.length > 12 ? `；等共 ${groups.length} 个` : ''}。`);
    }

    // 最近发生的事：谁进群了、谁戳你了
    const events = await db.listSocialEvents({ adapterId: opts.adapterId || null, limit: 8 });
    if (events.length) {
      const shown = events.map((e) => `${friendlyEventTime(e.createdAt)} ${describeEvent(e)}`);
      lines.push(`- 最近周围发生的事（新的在前）：${shown.join('；')}。`);
    }

    lines.push('- 这些是协议端给的真实数据，跟"你记得什么"是两回事；被问到直接照着答，别说不清楚。');
    return lines.join('\n');
  } catch (e) {
    // 环境摘要是增强项，读失败就当没有，不能让整轮回复挂掉
    console.warn('[social] 环境摘要构建失败（已忽略）:', e?.message || e);
    return '';
  }
}

/** 一条事件的自然语言描述（提示词和工具返回共用）。 */
function describeEvent(e) {
  if (!e) return '';
  const type = String(e.eventType || '');
  const base = type.split(':')[0];
  const group = e.groupId ? `群 ${e.groupId}` : '';
  switch (base) {
    case 'group_increase':
      return `${e.actorId || '有人'} 加入了${group || '群'}`;
    case 'group_decrease':
      return `${e.actorId || '有人'} 离开了${group || '群'}`;
    case 'group_admin':
      return `${e.actorId || '有人'} 的管理员身份变了（${group}）`;
    case 'group_recall':
      return `${e.actorId || '有人'} 撤回了一条消息${group ? `（${group}）` : ''}`;
    case 'group_ban':
      return `${e.actorId || '有人'} 在${group}被禁言/解除禁言`;
    case 'group_upload':
      return `${e.actorId || '有人'} 在${group}传了文件`;
    case 'friend_add':
      return `${e.actorId || '有人'} 加你为好友`;
    case 'notify':
      return e.detail || `${e.actorId || '有人'} 戳了你一下`;
    case 'request':
      return e.detail || `${e.actorId || '有人'} 发来一个请求`;
    default:
      return e.detail || type;
  }
}

/** 事件时间措辞：刚发生的事说"刚刚"，别把时间戳直接怼出来。 */
function friendlyEventTime(ts) {
  const ms = parseDbTime(ts);
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** SQLite CURRENT_TIMESTAMP 是 UTC "YYYY-MM-DD HH:MM:SS"。 */
function parseDbTime(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  const s = String(ts);
  const parsed = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 拿一个群的完整画像（含成员），供能力返回。 */
async function groupProfile(adapterId, groupId) {
  const group = await db.getSocialGroup(adapterId, groupId);
  if (!group) return null;
  const members = await db.listGroupMembers(adapterId, groupId, 500);
  return { ...group, members };
}

/** 查一个人：好友表 + 在哪些群 + 她记得的档案。 */
async function personProfile(adapterId, userId) {
  const uid = String(userId || '');
  if (!uid) return null;
  const contacts = await db.listSocialContacts(adapterId || null);
  const contact = contacts.find((c) => c.userId === uid) || null;
  const groups = adapterId ? await db.groupsOfMember(adapterId, uid) : [];
  let person = null;
  try {
    person = await db.getPerson(uid);
  } catch {
    /* people 表读失败不影响社交信息 */
  }
  return { userId: uid, contact, groups, person };
}

module.exports = {
  supportsSocial,
  syncAdapter,
  refreshGroup,
  recordEvent,
  affectsMembership,
  buildEnvironmentBlock,
  describeEvent,
  friendlyEventTime,
  groupProfile,
  personProfile,
};
