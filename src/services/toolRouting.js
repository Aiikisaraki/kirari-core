// kirari-core · src/services/toolRouting.js
//
// 「这次 MCP/skill 调用该在哪台机器上执行」的判定。
//
// 用户的原始要求（2026-11-20）：
//   「我还是觉得有必要区分一下是来自哪个叶子，就是有没有能力，判断这个请求是来自
//     叶子还是来自本机或者来自QQ，在主机上调用叶子节点的。在主机上可以列出所有叶子
//     节点，而且也可以区分哪个请求是来自哪个叶子节点。假如主机是在qq或者本机聊天窗口
//     （桌宠）或者网页端聊天窗口（核心），默认情况下操作主机下的mcp和skill。如果点明了
//     某个叶子节点或者叶子节点的别名，就操作那个叶子节点。如果请求来自某个叶子节点，
//     那也默认操作自己这个叶子节点。」
//
// 归纳成四条规则（优先级从上到下）：
//   1. 模型**明确点名**了某台设备（@device:xxx / @别名 / 「让书房的电脑…」）→ 那台
//   2. 请求**来自某台叶子** → 那台叶子自己（"默认操作自己"）
//   3. 主机本机 / QQ / 网页端 → 主机自己
//   4. 点名的设备解析不出来（拼错、没这台、离线）→ 落回 2/3 的默认，并在结果里
//      明确告诉模型「没找到那台设备」，让它能换一种说法或直接回答 —— 绝不静默
//      换到别的机器上执行（那会变成"你以为在书房电脑上查的其实是主机查的"）。
//
// 为什么不把这段塞进 capabilities/registry.js：registry 是"怎么执行"，
// 这里是"在哪执行"。混在一起后，没开组网的普通安装也要走一遍组网分支，
// 反而增加理解成本。单独一层，未开组网时整条链路直接短路返回 null。

const netBootstrap = require('../net/bootstrap');

/** 工具名里带 @device: 前缀时的分隔符。 */
const DEVICE_PREFIX_RE = /^\s*@device:([^\s:]+)\s*[:\s]\s*([\s\S]+)$/i;

/**
 * 解析工具名里内嵌的设备点名（结构化前缀，确定性最高）。
 *
 * 语法：`@device:<设备名或别名> <真实工具名>`
 * 之所以把点名塞在**工具名**里而不是参数里：模型 function-calling 的 args 是
 * 按 tool schema 校验的，多塞一个 arg 会被忽略或报错，而 name 是自由字符串，
 * 由我们自己的提示词约定，最不容易被误改。
 *
 * @returns {{ deviceHint: string, name: string } | null} 没有前缀返回 null
 */
function parseDevicePrefix(name) {
  const m = DEVICE_PREFIX_RE.exec(String(name || ''));
  if (!m) return null;
  return { deviceHint: m[1].trim(), name: m[2].trim() };
}

/**
 * 把「设备提示」解析成真实 deviceId。
 *
 * 支持三种写法，越精确越优先：
 *   1. 完整 deviceId（前缀匹配即可，用户看到的就是前 8 位）
 *   2. 设备名（完全匹配 → 忽略大小写 → 包含匹配）
 *   3. 别名（用户给设备起的名字，存在组网状态里）
 *
 * @param {string} hint
 * @returns {{ deviceId: string, name: string } | null} 找不到返回 null
 */
function resolveDevice(hint) {
  const raw = String(hint || '').trim();
  if (!raw) return null;
  const members = safeMembers();
  if (!members.length) return null;
  const lower = raw.toLowerCase();

  // 1. deviceId（完整或前缀）：用户界面上看到的就是前 8 位，所以支持前缀最实用
  const byId = members.find((m) => m.deviceId && m.deviceId.toLowerCase().startsWith(lower));
  if (byId) return { deviceId: byId.deviceId, name: byId.name || byId.deviceId.slice(0, 8) };

  // 2. 设备名：完全一致 > 忽略大小写 > 包含
  const exact = members.find((m) => String(m.name || '') === raw);
  if (exact) return { deviceId: exact.deviceId, name: exact.name };
  const ci = members.find((m) => String(m.name || '').toLowerCase() === lower);
  if (ci) return { deviceId: ci.deviceId, name: ci.name };
  const partial = members.find((m) => String(m.name || '').toLowerCase().includes(lower));
  if (partial) return { deviceId: partial.deviceId, name: partial.name };

  // 3. 别名：组网状态里 machineNames / aliases 之类的映射（有就查，没有就算了）
  const alias = safeAliasLookup(lower);
  if (alias) {
    const hit = members.find((m) => m.deviceId === alias);
    if (hit) return { deviceId: hit.deviceId, name: hit.name || hit.deviceId.slice(0, 8) };
  }
  return null;
}

/** 主机侧成员列表；不在主机角色时返回空数组（这个模块只在主机上有意义）。 */
function safeMembers() {
  try {
    // 注意层级：bootstrap.snapshot() 返回的是 { enabled, running, state }，
    // role / members 都在 state 里（state 就是 NetManager.snapshot() 的结果）。
    const snap = netBootstrap.snapshot();
    const state = snap && snap.state ? snap.state : null;
    if (!state || state.role !== 'host') return [];
    const members = Array.isArray(state.members) ? state.members : [];
    return members;
  } catch {
    return [];
  }
}

/**
 * 别名 → deviceId。目前组网状态里没有专门的别名字段，
 * 所以先用「成员名去掉常见后缀」做一层轻量归一（「书房的电脑」↔「书房」），
 * 将来真加了 aliases 字段，只改这一个函数即可。
 */
function safeAliasLookup(lowerAlias) {
  const members = safeMembers();
  for (const m of members) {
    const name = String(m.name || '').toLowerCase();
    if (!name) continue;
    // 去掉「的电脑 / 的台式机 / 主机 / 节点」这类尾缀后再比一次
    const stripped = name.replace(/(的)?(电脑|笔记本|台式机|主机|节点|机器)$/u, '').trim();
    if (stripped && stripped === lowerAlias) return m.deviceId;
    if (name === lowerAlias) return m.deviceId;
  }
  return null;
}

/**
 * args 里可能用来点名设备的字段名。
 *
 * 模型有时不会用 @device: 前缀，而是把设备塞进参数里（{"device": "书房"}），
 * 这是它更自然的写法。这里认这几个名字，命中且**能解析出真实设备**才生效。
 */
const DEVICE_ARG_KEYS = [
  'device',
  'deviceid',
  'device_id',
  'devicename',
  'device_name',
  'machine',
  'machine_name',
  'node',
  'node_name',
  'target',
  'target_device',
  '设备',
  '设备名',
  '机器',
  '节点',
];

/**
 * 工具名前面挂了设备名、但漏了 @device: 标记的形态：
 *   「书房 read_file」「书房:read_file」「书房的电脑/read_file」
 * 只按「空白 / 冒号 / 斜杠 / 竖线 / @」切一刀，真实工具名里不会出现这些字符
 * （MCP 是 <server>__<tool>，技能是 skill__<id>__<tool>，都只用下划线）。
 */
const LOOSE_DEVICE_RE = /^\s*([^\s:：/／|@]{1,40})\s*[:：/／|@\s]\s*(\S[\s\S]*)$/u;

/**
 * 自然语言回退：模型没用 @device: 前缀，但用别的方式点明了设备。
 *
 * ⚠️ 与结构化前缀的关键差别：**只认命中的，不报失配**。
 * 这里拿到的东西未必真是设备名（比如某个工具自己的 `host` 参数），
 * 误判会把本该在本机跑的调用劫持到别的机器上 —— 那是与「静默跨机」
 * 同样严重、方向相反的错误。所以解析不出来就安静地返回 null，让调用
 * 按默认规则走；只有确实解析到一台真实设备时才改路由。
 *
 * @param {string} rawName 模型给的工具名
 * @param {object} args 模型给的参数
 * @returns {{ deviceId: string, deviceName: string, name: string, dropArgKeys: string[] } | null}
 */
function detectNaturalDevice(rawName, args) {
  if (!safeMembers().length) return null;

  // (a) 参数里点名：{"device": "书房"} / {"设备": "书房的电脑"}
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of Object.keys(args)) {
      if (!DEVICE_ARG_KEYS.includes(String(key).toLowerCase())) continue;
      const raw = args[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const hit = resolveDevice(raw);
      if (hit) {
        return {
          deviceId: hit.deviceId,
          deviceName: hit.name,
          name: String(rawName || ''),
          // 这个字段是给路由看的，转发给叶子的工具时要去掉：
          // MCP 工具的参数是按 schema 校验的，多一个未知键会直接报错。
          dropArgKeys: [key],
        };
      }
    }
  }

  // (b) 工具名前面挂了设备名但漏了标记：「书房 read_file」
  const m = LOOSE_DEVICE_RE.exec(String(rawName || ''));
  if (m) {
    const hit = resolveDevice(m[1]);
    if (hit) {
      return {
        deviceId: hit.deviceId,
        deviceName: hit.name,
        name: m[2].trim(),
        dropArgKeys: [],
      };
    }
  }
  return null;
}

/**
 * 本次调用最终要在哪台设备上执行。
 *
 * @param {object} ctx capabilities.dispatch 传下来的上下文
 * @param {string} rawName 模型给的原始工具名（可能带 @device: 前缀）
 * @param {object} [args] 模型给的参数（自然语言回退要查里面有没有点名）
 * @returns {{
 *   target: 'local' | 'remote',
 *   deviceId?: string,
 *   deviceName?: string,
 *   name: string,
 *   source: 'explicit' | 'natural' | 'from-leaf' | 'host-default',
 *   dropArgKeys?: string[],
 *   note?: string
 * }}
 */
function decide(ctx, rawName, args) {
  const sourceDeviceId = ctx && ctx.sourceDeviceId ? String(ctx.sourceDeviceId) : '';
  const region = {
    target: 'local',
    name: String(rawName || ''),
    source: 'host-default',
  };

  // ── 规则 1：模型点名（结构化前缀）──
  const parsed = parseDevicePrefix(rawName);
  if (parsed) {
    const hit = resolveDevice(parsed.deviceHint);
    region.name = parsed.name;
    if (hit) {
      region.target = 'remote';
      region.deviceId = hit.deviceId;
      region.deviceName = hit.name;
      region.source = 'explicit';
      return region;
    }
    // 点名了但找不到：明确告知，绝不静默改到别的机器执行
    region.note =
      `没找到设备「${parsed.deviceHint}」。可用设备：` +
      (safeMembers()
        .map((m) => `${m.name}（${String(m.deviceId).slice(0, 8)}${m.online ? '' : '，离线'}）`)
        .join('、') || '无');
    // 仍然按默认回落执行（这样至少能给出答案），但把 note 一起回给模型
    region.source = 'explicit';
    region.explicitMiss = true;
  }

  // ── 规则 1b：自然语言回退（没写 @device:，但用别的写法点明了设备）──
  // 只在确实解析到一台真设备时才改路由；解析不出来就当作没点名。
  if (!parsed) {
    const nat = detectNaturalDevice(rawName, args);
    if (nat) {
      region.target = 'remote';
      region.deviceId = nat.deviceId;
      region.deviceName = nat.deviceName;
      region.name = nat.name;
      region.source = 'natural';
      if (nat.dropArgKeys.length) region.dropArgKeys = nat.dropArgKeys;
      return region;
    }
  }

  // ── 规则 2：请求来自叶子 → 那台叶子自己 ──
  if (sourceDeviceId) {
    region.target = 'remote';
    region.deviceId = sourceDeviceId;
    const m = safeMembers().find((x) => x.deviceId === sourceDeviceId);
    region.deviceName = m ? m.name : sourceDeviceId.slice(0, 8);
    if (!region.explicitMiss) region.source = 'from-leaf';
    return region;
  }

  // ── 规则 3：主机本机 / QQ / 网页端 → 主机自己 ──
  return region;
}

/**
 * 主机侧：列出所有叶子节点（给模型/界面看）。
 *
 * 用户明确要求「在主机上可以列出所有叶子节点，而且也可以区分哪个请求是来自哪个叶子节点」。
 * 这个函数就是那个列表的来源。
 */
function listDevices() {
  return safeMembers().map((m) => ({
    deviceId: m.deviceId,
    name: m.name || m.deviceId.slice(0, 8),
    online: !!m.online,
  }));
}

/** 这台设备上能跑哪些工具（叶子自报的能力清单）。 */
function capsOf(deviceId) {
  try {
    const mgr = netBootstrap.getManager();
    if (!mgr || typeof mgr.toolCapsOf !== 'function') return null;
    return mgr.toolCapsOf(String(deviceId || ''));
  } catch {
    return null;
  }
}

/** 所有叶子报上来的工具能力（主机侧总览）。 */
function allCaps() {
  try {
    const mgr = netBootstrap.getManager();
    if (!mgr || typeof mgr.allToolCaps !== 'function') return [];
    return mgr.allToolCaps();
  } catch {
    return [];
  }
}

/**
 * 远程执行一次工具调用（主机 → 叶子），并把结果整理成 registry 期望的字符串。
 *
 * @returns {Promise<{ content: string, isError: boolean } | null>}
 *   null 表示"没法远程执行"（没通道/没设备），调用方应以本地执行兜底。
 */
async function runRemote(ctx, target, args) {
  const callToolOnDevice =
    (ctx && ctx.callToolOnDevice) ||
    (() => {
      try {
        const mgr = netBootstrap.getManager();
        return mgr && typeof mgr.callToolOnDevice === 'function'
          ? mgr.callToolOnDevice.bind(mgr)
          : null;
      } catch {
        return null;
      }
    })();
  if (typeof callToolOnDevice !== 'function') return null;
  if (!target || !target.deviceId) return null;

  const out = await callToolOnDevice(target.deviceId, target.name, args, {
    sessionId: ctx && ctx.sessionId,
  });
  if (!out) return null;
  if (out.ok) {
    return {
      content: String(out.result == null ? '' : out.result),
      isError: false,
    };
  }
  return {
    content: `error: ${out.error || '远程执行失败'}`,
    isError: true,
  };
}

module.exports = {
  decide,
  resolveDevice,
  parseDevicePrefix,
  detectNaturalDevice,
  listDevices,
  capsOf,
  allCaps,
  runRemote,
};
