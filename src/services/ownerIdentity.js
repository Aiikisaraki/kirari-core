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

// ── 身份归一化（canonical identity）────────────────────────────────────
//
// ── 为什么需要这一层（2026-11-20 用户第二次拍桌）─────────────────────
//   「既然三个入口是一个身份，那我不管哪个入口都可以应该看得到啊，
//     你这 bug 也太多了」
//   「还是打补丁，你要考虑一下还有没有其他是主人但是没被存为 _local 的情况，
//     也一并处理掉，我们要规范化编码了」
//
// 她说得对。此前每次出问题都是「在比较的那一行」加一个 `|| x === FALLBACK`，
// 于是同一个 bug 换个语句又活过来。真正的问题是：**同一个人有多个表示法，
// 而没有任何一个地方负责把它们认成同一个人**。系统里同时流通着四种写法：
//
//   1. people.role='owner' 的 person_key（QQ 号 / openid）  ← 规范值
//   2. '_local'           本机自用的旧别名（FALLBACK）
//   3. 本机会话 UUID      local-session.json 那一份（身份≠会话，但历史数据混用了）
//   4. uid=1              数据库内置账户编号
//
// 只要「写入方」和「读取方」用了不同写法，人就被劈成了两个：
//   · 提醒存成 '_local'，投递时比对 '1980308740' → 判成非主人 → 静默丢弃
//   · 网页建的任务 owner 是 UUID，QQ 来查时对不上 → 「我为什么看不到」
//
// 所以这里提供**唯一**的归一入口。规矩只有两条：
//   · 所有「存身份」的地方，写之前一律过 canonicalIdentity()；
//   · 所有「比身份」的地方，比之前两侧一律过 canonicalIdentity()。
// 不再允许任何模块自己写 `x === '_local' || x === ownerKey`。
//
// 归一规则（顺序即优先级）：
//   · 空 → ''（认不出，绝不默认成主人；调用方自己决定要不要拒）
//   · '_local' / 'local' / 'uid=1' / '1' → 规范主人键
//     （这些在历史数据里**只**可能指本机主人，不会指别人）
//   · 本机会话 UUID / session_* / console-* → 规范主人键
//     （本机会话只属于本机主人；这是「三入口同一身份」的直接推论）
//   · 其余（客人 QQ 号、workspace:<owner>:、net:<device>:）→ 原样返回，
//     但去掉 net: 命名空间外壳，露出里面真正的会话键再判一次。

/** 指代「本机主人」的历史别名集合（小写比较）。 */
const OWNER_ALIASES = new Set(['_local', 'local', 'uid=1', 'uid:1', '1', '__builtin__']);

/**
 * 判断一个会话键是不是「本机人机对话」。
 *
 * ⚠️ 这里必须**正向匹配**，不能写「不是 bot- 就当本机主人」。
 * 上一版我正是那么写的，而客人的 QQ 号 `1658359753` 不以 bot- 开头，
 * 于是会被判成本机会话 → 归一到主人 → 客人的东西全被并进主人口袋。
 * 那等于把「客人隔离」这条红线直接抹掉，比原来的 bug 更严重。
 *
 * 所以只认两种**形状明确**的本机会话：
 *   · 与 local-session.json 里那份 UUID 完全相同（最权威）
 *   · UUID / session_* / console-* 这类本机入口自己生成的键
 * 其余一律不动 —— 认不出就是认不出，绝不猜。
 */
function isOwnerLocalSession(sid) {
  const s = String(sid || '').trim();
  if (!s) return false;

  // net:<device>:<原始 sessionId> —— 剥掉设备壳，用里面的键判
  if (s.startsWith('net:')) {
    const rest = s.slice('net:'.length);
    const inner = rest.includes(':') ? rest.slice(rest.indexOf(':') + 1) : '';
    return isOwnerLocalSession(inner);
  }

  // ① 与本机会话真源逐字相等（最权威，重启也稳定）
  try {
    const localSession = require('../session/localSession');
    const real = String(localSession.currentSessionIdSync?.() || '').trim();
    if (real && s === real) return true;
  } catch {
    /* 读不到就继续按形状判 */
  }

  // ② 本机入口生成键的形状：UUID / session_* / console-*
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^(?:session|console)[_-][a-zA-Z0-9_-]{1,64}$/.test(s)) return true;

  // 其余（含纯数字 QQ 号、群号、未知串）→ 不动
  return false;
}

/**
 * 把一个任意写法的主人类身份**归一**成规范身份键。
 *
 * @param {string} value 任何来源的身份值（senderId / ownerKey / sessionId / uid）
 * @param {string} [asOwner] 以谁为「主人」来做归一，默认取本机规范键。
 *        只有在调用方**明确知道**主人是谁时才传（如推送闸门里由外部传入的
 *        ownerOfSystem）。传了它就以它为基准，不去读本机 people 表 ——
 *        否则「按 A 判断主人」和「按本机 B 归一」两套基准打架，又会认错人。
 * @returns {string} 规范身份键；'' 表示认不出（不是主人，也不是可用身份）
 */
function canonicalIdentity(value, asOwner) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';

  const ownerKey = asOwner !== undefined && asOwner !== null && String(asOwner).trim()
    ? String(asOwner).trim()
    : getOwnerKey();

  // ① 已经是规范键：直接返回（最常见的快路径）
  if (raw === ownerKey) return ownerKey;

  // ② 历史别名：只在「本机主人」这个语义下成立
  if (OWNER_ALIASES.has(raw.toLowerCase())) return ownerKey;

  // ③ 本机会话键（含 net: 包装）：本机人机对话只属于本机主人
  if (isOwnerLocalSession(raw)) return ownerKey;

  // ④ 其余（客人的 QQ 号等）：保持原样，不做任何"猜"。
  //    客人的隔离是红线——绝不能因为猜错把客人并进主人。
  return raw;
}

/**
 * 两个人是不是同一个人（两侧都先归一）。
 *
 * 这是所有身份比较的**唯一**正确写法：
 *   if (samePerson(job.ownerKey, getOwnerKey())) { ... }
 * 替代以前散落各处的 `a === b || a === FALLBACK || ...`。
 *
 * @param {string} a
 * @param {string} b
 * @param {string} [asOwner] 可选：显式指定「主人」的基准（见 canonicalIdentity）
 */
function samePerson(a, b, asOwner) {
  const ca = canonicalIdentity(a, asOwner);
  const cb = canonicalIdentity(b, asOwner);
  return !!ca && !!cb && ca === cb;
}

/**
 * 把「这条归属是谁」解析成规范键；认不出返回 ''。
 * 与 canonicalIdentity 的区别：空值就是认不出，不会变成主人。
 */
function canonicalOwnerKey(value) {
  return canonicalIdentity(value);
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

/**
 * 从会话 id 在**服务端**派生场合身份（用于组网 relayed 消息）。
 *
 * ── 信任模型（2026-11-20 用户拍板「叶子节点都是主人的设备」）──────────
 * 能 uplin 到主机的消息，已经通过 kirari-net 的配对码 / 长期凭据握手
 * （hostServer 未鉴权连接的 relay 帧直接丢弃），即来自主人授权的设备。
 * 叶子不单独配协议端（SYNC_FIELDS 不含 adapters/key），所以叶子上行的
 * 就是主人本人在叶子设备前打字。
 *
 * 但身份仍**只从服务端可验证的事实**派生，绝不读帧里自报的 role/isOwner：
 *   · 本机会话（UUID / session_* / local）/ net: 前缀 → 主人（ownerScene）
 *   · bot- 平台会话 → 从 sessionId 里的 QQ 号查 people 表定 role：
 *       主人私聊 → owner 且收敛到规范键；其余 → user（客人，保持隔离）
 *
 * 这样 relayed 的主人在主机侧能读到自己的记忆池、工作空间、任务，
 * 而不是被当成 `net:<device>:<uuid>` 这个认不出的身份。
 *
 * @param {string} sessionId 原始会话 id（未经 net: 命名空间包装）
 * @param {string} [platform] 平台标识
 */
function sceneFromSessionId(sessionId, platform = 'net') {
  const sid = String(sessionId || '').trim();
  const ownerKey = getOwnerKey();

  // 平台会话：从 sessionId 拆出发信人账号，服务端查 people 表定 role
  if (sid.startsWith('bot-')) {
    // bot-<adapter>-<conversationKey>，conversationKey 形如 user:<qq> / group:<gid>:<uid>
    let counterpart = '';
    const userM = /(?:^|:)user:([^:]+)/.exec(sid);
    if (userM) counterpart = userM[1];
    else {
      const lastSeg = sid.split(':').pop() || '';
      counterpart = lastSeg;
    }
    counterpart = String(counterpart || '').trim();
    const isOwnerPerson = !!counterpart && counterpart === ownerKey;
    // 群聊是多人场合，即便里面有主人也不当"主人私聊身份"。
    // 兼容两种 sessionId 形态：bot:platform:group:...（sessionMapping）与
    // bot-<adapter>-group:...（botManager），所以分隔符可能是 ':' 或 '-'。
    const isGroup = /(?:^|[:-])(?:group|channel):/.test(sid);
    return {
      chatType: isGroup ? 'group' : 'private',
      isGroup,
      senderId: isOwnerPerson ? ownerKey : counterpart,
      senderName: '',
      isOwner: isOwnerPerson && !isGroup,
      role: isOwnerPerson && !isGroup ? 'owner' : 'user',
      // 平台会话由协议端转发，不算本机可信入口
      trustedLocal: false,
      platform,
    };
  }

  // 本机会话（UUID / session_* / net: 前缀里的本机段）→ 主人本人
  // 注：executor 收到的 sessionId 未带 net: 前缀（前缀是执行器内部加的），
  // 这里仍兼容带前缀的形态，防止其它调用点传进来。
  return ownerScene({ platform, chatType: 'local' });
}

module.exports = {
  FALLBACK,
  getOwnerKey,
  canonicalIdentity,
  canonicalOwnerKey,
  samePerson,
  isOwnerLocalSession,
  ownerScene,
  sceneFromSessionId,
};
