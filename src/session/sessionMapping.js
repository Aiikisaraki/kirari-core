// src/session/sessionMapping.js
// 会话映射：把「平台上的聊天对象」映射成稳定的会话 ID。
//
// 为什么需要它：
//   机器人消息天然带的是群号 / QQ 号，而不是会话 ID。原来的实现让客户端
//   自报 session_id，缺省就用 `session_${Date.now()}`——那意味着机器人在群里
//   每收一条消息就开一个新会话，上下文完全丢失，机器人「记不住事」。
//   本模块按「谁在哪个聊天里说话」生成稳定 ID：同一个群永远是同一个会话，
//   同一个人的私聊也永远是同一个会话，进程重启后依然命中。
//
// ID 格式（带平台前缀，避免不同平台的同一号码撞车）：
//   群聊     bot:{platform}:group:{groupId}
//   私聊     bot:{platform}:user:{userId}
//   群内隔离 bot:{platform}:group:{groupId}:user:{userId}
//
// 群内是否按发言人隔离上下文，由环境变量 BOT_GROUP_ISOLATE_PER_USER 决定：
//   不设 / false（默认）→ 整群共享一份上下文，符合「群聊」的直觉
//   true                → 群内每人一份上下文，避免多人发言时上下文互相污染

const crypto = require("crypto");

// 允许的平台标识。留空表示不区分平台（单平台部署，省得每处都传）。
function normalizePlatform(platform) {
  const p = String(platform || "").trim();
  return p || "default";
}

function sanitizeSegment(value) {
  // 只保留安全字符，避免 ID 里出现 / : 等分隔符导致歧义
  return String(value == null ? "" : value)
    .trim()
    .replace(/[^\w.-]/g, "_");
}

/**
 * 解析群号 / QQ 号 → 稳定的会话 ID。
 *
 * @param {Object} input
 * @param {string} [input.platform]   平台标识（如 onebot），默认 "default"
 * @param {"group"|"private"} [input.chatType] 聊天类型，缺省时按是否有 groupId 推断
 * @param {string|number} [input.groupId] 群号
 * @param {string|number} [input.userId]  QQ 号 / 用户 id
 * @param {string} [input.sessionId]   显式指定（兼容桌面端等已有客户端）；给了就直接用
 * @param {boolean} [input.isolatePerUser] 群内是否按发言人隔离，覆盖全局设置
 * @returns {{ sessionId: string, scope: string, chatType: "group"|"private", platform: string }}
 *          scope 用于位置记忆隔离（同一群共享一份位置），与 sessionId 不同：
 *          群内隔离上下文时，位置仍按群共享更符合直觉。
 */
function resolveSession(input = {}) {
  const platform = normalizePlatform(input.platform);

  // 显式指定优先：桌面端等客户端自己维护会话，不需要服务端映射。
  if (input.sessionId && String(input.sessionId).trim()) {
    const sid = String(input.sessionId).trim();
    return {
      sessionId: sid,
      scope: sid,
      chatType: input.chatType === "private" ? "private" : "group",
      platform,
    };
  }

  const groupId = sanitizeSegment(input.groupId);
  const userId = sanitizeSegment(input.userId);

  // 没给 chatType 时按有无群号推断
  const chatType =
    input.chatType === "private" || input.chatType === "group"
      ? input.chatType
      : groupId
        ? "group"
        : "private";

  const isolatePerUser =
    input.isolatePerUser !== undefined
      ? !!input.isolatePerUser
      : String(process.env.BOT_GROUP_ISOLATE_PER_USER || "").toLowerCase() === "true";

  if (chatType === "group") {
    if (!groupId) {
      throw new Error("群聊缺少 groupId，无法确定会话");
    }
    return {
      sessionId: isolatePerUser && userId
        ? `bot:${platform}:group:${groupId}:user:${userId}`
        : `bot:${platform}:group:${groupId}`,
      // 位置记忆始终按群共享：整群的人通常在同一个地方
      scope: `group:${groupId}`,
      chatType,
      platform,
    };
  }

  if (!userId) {
    throw new Error("私聊缺少 userId，无法确定会话");
  }
  return {
    sessionId: `bot:${platform}:user:${userId}`,
    scope: `user:${userId}`,
    chatType,
    platform,
  };
}

/**
 * 生成一次性访客 uid。
 *
 * 机器人侧的「用户」与账号体系无关：一个群成员就是一条独立的客人档案，
 * 位置记忆按 (uid, scope) 存储。这里用 平台+号码 的稳定哈希，
 * 保证同一个人每次来都是同一个 uid（位置记忆才能复用），
 * 不同人之间不会撞号。
 */
function resolveGuestUid(platform, userId) {
  const raw = `${normalizePlatform(platform)}:${sanitizeSegment(userId)}`;
  // 取 6~9 位十进制，落在 100000+ 区间（避开 0-99999 的内置保留区）
  const hash = crypto.createHash("sha1").update(raw).digest("hex");
  const num = parseInt(hash.slice(0, 12), 16) % 9_000_000_000;
  return 100000 + num;
}

/**
 * 解析入站消息 → 会话身份。给路由层用，一次算齐。
 * @returns {{ sessionId, scope, guestUid, chatType, platform, groupId, userId }}
 */
function resolveIdentity(input = {}) {
  const { sessionId, scope, chatType, platform } = resolveSession(input);
  return {
    sessionId,
    scope,
    chatType,
    platform,
    guestUid: resolveGuestUid(platform, input.userId),
    groupId: sanitizeSegment(input.groupId),
    userId: sanitizeSegment(input.userId),
  };
}

module.exports = {
  resolveSession,
  resolveIdentity,
  resolveGuestUid,
};
