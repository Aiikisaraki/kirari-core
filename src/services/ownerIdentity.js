// src/services/ownerIdentity.js
// 「主人」的唯一身份真源 —— 不再有第二个表示法。
//
// ── 2026-11-20 用户拍板 ────────────────────────────────────────────────
//   「这三个入口，就是同一个身份……在这里说的话，会同步，会记录共享，
//     会共享会话窗口，会同步上下文，在这里创建的任务，同样会返回给我的 QQ
//     与她私聊的窗口，会同步到网页端……」
//
// 之前代码里"主人"有四个键（people 的 QQ 号 / '_local' / 本机会话 UUID /
// uid=1），同一个人在不同子系统里成了四个人 —— 网页查不到 QQ 建的任务、
// 别人的任务混到主人这儿、换个入口就像换了个人，全都是这一个根因的症状。
// 所以这里只定义一个身份键，其余表示法一律不承认，旧数据靠迁移收敛。
//
// ── 严格区分两个概念（此前一直被混为一谈）──────────────────────────────
//   · 身份键 identity = 主人的真实账号（people.role='owner' 的 person_key）
//       跨机器稳定，用于：记忆 person:: 池、工作空间目录、job.ownerKey、
//       推送定向、场景里 senderId。
//   · 会话键 sessionId = local-session.json 那份 UUID
//       本机这段对话的分区，网页 / 桌宠 / 主人 QQ 私聊三端共用；
//       组网时各机器按 net:<device>: 加前缀，避免串线。
//
// 身份键 ≠ 会话键。一个跨机器稳定，一个是本机对话分区，本来就不该相等。
//
// 客人不会被这里碰：客人身份永远是自己的 QQ 号，走 bot- 会话。
// 本模块只回答"主人这个身份是谁"，不参与"谁是不是主人"的判断 ——
// 后者由 selfOps.roleOf 按当场 scene 决定，只认握手/场合，不认自称。

const dbStorage = require('../db/dbStorage');

/** 全新装机还没有主人记录时的临时键。设主人后立刻变成真实账号。 */
const FALLBACK = '_local';

/**
 * 主人的规范身份键（同步）。
 * 每次现取不缓存：设主人实时改 people 表，缓存会让改动要重启才生效。
 *
 * 来源：people.role='owner' → 适配器 ownerAccount（老装机兜底）→ FALLBACK。
 */
function getOwnerKey() {
  try {
    const k = dbStorage.getOwnerKeySync();
    if (k && String(k).trim()) return String(k).trim();
  } catch {
    /* 存储未就绪，走下一档 */
  }
  try {
    const adapters = require('../settings/clientConfig').getAdapters() || [];
    for (const a of adapters) {
      if (a && a.ownerAccount && String(a.ownerAccount).trim()) {
        return String(a.ownerAccount).trim();
      }
    }
  } catch {
    /* 配置读不到，走兜底 */
  }
  return FALLBACK;
}

/**
 * 本机主人入口（网页控制台 / 桌宠对话框 / 主人 QQ 私聊）统一 scene。
 *
 * 三个入口只有 platform / chatType 不同，身份字段必须**逐字一致**，
 * 否则下游按身份分区的池子就会裂成三份（那正是要根治的 bug）。
 *
 * @param {object} opts
 * @param {string} opts.platform          'console' | 'desktop' | 适配器 id
 * @param {string} [opts.chatType]        'local' | 'private'，默认 'local'
 * @param {string} [opts.senderName]
 */
function ownerScene(opts = {}) {
  return {
    chatType: opts.chatType || 'local',
    isGroup: false,
    isOwner: true,
    role: 'owner',
    // 桌面 WS / 桌宠内嵌引擎靠这个字段认本机主人，必须显式给
    trustedLocal: true,
    // 规范身份键：三端一致，绝不是 '_local' 或会话 UUID
    senderId: getOwnerKey(),
    senderName: opts.senderName || '主人',
    platform: opts.platform || 'console',
  };
}

module.exports = { FALLBACK, getOwnerKey, ownerScene };
