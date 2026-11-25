// src/services/reply/promptBuilder.js
// 人格基座 + 各分支 system 提示模板 + 请求超时判定 + 对话历史归一化。
// 所有分支 prompt 都由「人格基座」派生，保证无论选哪个模型、走哪条分支，人格锚点一致、不漂移。

const { DEFAULT_PERSONA, buildPersonaBlock } = require('./persona');
const { VOICE_RULES } = require('./style');

// 启动 / 打开聊天窗口时主进程直接推送的问候语。它本身不写入记忆，
// 但为防止任何误落库的情况污染 LLM 上下文，拼装给模型的对话历史时统一剔除。
const GREETING_MESSAGE = '在的。';

// 位置相关追问 / 设置提示语
const LOCATION_ASK_MESSAGE =
  '我还不知道你在哪个城市。告诉我国内外的城市名就行，之后查天气和当地时间就能对上你的作息了。（比如「北京」「上海」）';

// 事实约束：防止模型编造具体台词/情节/数据，尤其是在 ACG、历史、科学等需要准确出处的领域。
// 追加在人格基座之后，所有分支（normal/withTools/polish/locationSet）都会继承。
const GROUNDING_RULES = `在回答涉及具体事实的问题时，请遵守以下约束：
- 禁止编造具体台词、情节、数据、人物关系、作品出处或未经核实的细节。如果无法从已知信息中确认某个具体事实，请直接说“我不太确定”或“这个我不记得了”，不要为了回答完整而虚构内容。
- 如果提供了【知识库参考】或【今日背景】，请优先依据其中内容作答；当参考内容与你自己的记忆冲突时，以参考内容为准。
- 如果主人纠正或质疑了你之前说的某个事实（如“你记错了”“根本没有”“她没说过”“哪有”“编的吧”），先坦然承认自己确实可能记错了，不要硬编理由或换另一个说法圆场。若你不确定真正的正确信息，可以搜索一两下找依据后再回答（这是被允许的、也是你该做的）；但搜索要“有限度”——最多一两次，找不到明确结论就坦诚说“这个我不太确定”，不要为了自证而反复搜索、也不要和主人争辩。
- 回答作品、角色、台词、情节等事实类问题时，若参考内容没有包含该信息，请明确表达不确定，不要自行脑补名台词或剧情。`;

// 人格与声音规则已抽到同目录的两个模块（2026-11-25 分层改造，见 docs/prompt-architecture.md）：
//   persona.js —— 身份层：预设人格、优先级声明、结尾返场提醒
//   style.js   —— 声音层：说话倾向（旧的「AI 味铁律」硬禁令已下线，长度改由 speakingDesire 给档位）
// 这里保留 GROUNDING_RULES（事实约束）与 JSON 契约：它们与人格无关，任何人格都要说同样的话。
// 模型回复的 JSON 输出契约（与人格无关，始终是固定结构，永远追加在人格描述之后）。
const JSON_OUTPUT_CONTRACT = `请只输出一个 JSON 对象（不要包含任何额外文字、不要使用 markdown 代码块），格式如下：
{"speech":"你对用户的口语化回复","emotion":"见下方可选值，或 null"}
字段说明：
- speech：你真正要说的话，像随口说出来的。长短看内容需要，不必为求完整而铺陈；不要出现 JSON 或情绪标签字样。
- emotion：这轮回复表达的情绪/动作标签（从下列值中挑最贴切的一个；无明显情绪时填 null）：
  - "happy"：开心、赞同、被夸奖、送出好消息等正向情绪。
  - "wave"：打招呼、欢迎、告别、主动搭话。
  - "excited"：特别兴奋、惊喜式的好消息、雀跃（比 happy 更强烈）。
  - "surprised"：惊讶、被吓一跳、听到意料之外的事。
  - "shy"：害羞、被调戏/夸得不好意思、小声脸红。
  - "sad"：失落、委屈、被说笨/被凶、听到让人难过的事。
  - "nod"：认可、答应、表示"好的我懂了/交给我吧"。
  - "shake"：摇头拒绝、表示"不行/不可以/做不到"、轻微否定。
  - "bow"：郑重致谢、道歉、礼貌问候（如"辛苦了""谢谢你"）。
  - "thinking"：正在认真思考、权衡、准备帮主人想办法（常用于需要先想一下再答的语境）。
  - "stretch"：刚睡醒、放松伸懒腰、懒洋洋的闲聊开场（极少用，氛围对才选）。
  - 其他情况一律填 null。
- 图片展示：如需在回复中展示图片（例如搜索结果图、或你生成的图），可在 speech 的适当位置使用标准 markdown 图片语法 ![图片描述](图片URL)；系统会将该图片单独渲染。URL 必须完整且不含空格，不要用 HTML <img> 标签。`;

// 根据「用户自定义人格（优先）或预设人格」构建系统提示基座。persona 为空/缺省回退 DEFAULT_PERSONA。
// 无论前端切换哪个模型、走哪条分支，人格锚点都保持不变，不会发生人格偏移。
function buildBasePrompt(persona) {
  // 分层顺序固定：身份层（人格 + 优先级声明）→ 声音层（倾向）→ 事实约束 → JSON 契约。
  // 身份层排第一是为了让模型先建立「她是谁」，声音层紧跟其后给倾向；
  // 结尾再补一次 buildPersonaEcho（在 conversationService 里追加），防止中间上千字的
  // 准则与清单把人格稀释掉。
  return buildPersonaBlock(persona) + '\n\n' + VOICE_RULES + '\n\n' + GROUNDING_RULES + '\n\n' + JSON_OUTPUT_CONTRACT;
}
// 由人格基座派生四条分支 system 提示（与 getReply 内原定义逐字一致）：
//  - withTools：非 direct 工具（如搜索）命中时，把工具结果注入，让模型用口语回答
//  - polish：direct 工具（时间/天气）命中时，把原始数据交给模型润色成口语
//  - locationSet：位置设置确认专用润色
//  - normal：无工具命中时的常规提示
function buildSystemPrompts(base) {
  const withTools = base +
    `\n以下是通过工具获取到的实时数据，请据此用口语化方式回答用户的问题（不要提及「工具」二字）：\n{{TOOL_RESULTS}}`;

  const polish = base +
    `\n请根据下面的「用户问题」和「已查到的实时数据」生成回复。
用户问题：{{USER_QUESTION}}
实时数据：{{TOOL_RESULTS}}
要求：
- 用你平时说话的自然口吻，直接回答用户问题；
- 严格使用实时数据中的数字、时间、地点，不得改动；
- 直接回答，不要反问，不要问"要看天气还是时间"之类的问题；
- 不要说你还需要查询、获取、等待或刷新，数据已经是最新的；
- 禁止照搬原始格式：不要输出 "Asia/Shanghai" 这类时区ID，不要输出 "2026-07-31T01:15" 这类ISO时间，不要输出"观测时间"等字段名；
- 时间用"凌晨/早上/上午/中午/下午/晚上"自然表达；天气不要把所有数字列表式报完，挑重点组织成一句流畅的话；
- 可以顺带一句关心或闲聊，但绝对不要编造数据，不要提「工具」二字。

示例（只作「信息怎么取舍」和「同一个问题可以怎么说」的参考，数字以实时数据为准）：
用户问题：现在几点
实时数据：现在本地时间是 2026年7月31日 星期五 凌晨01:15:06
可以这样回：{"speech":"凌晨一点十五了。","emotion":"stretch"}
也可以这样回：{"speech":"星期五，凌晨 1 点 15。这个点还没睡？","emotion":null}
不要这样（把字段名、时区原样倒出来）：{"speech":"当前时间：2026年7月31日星期五 01:15:06（时区 Asia/Shanghai）","emotion":null}

用户问题：常州现在天气怎么样
实时数据：常州市现在晴，气温 30.4°C（体感 36.8°C），相对湿度 73%，风速 1.8 km/h。
可以这样回：{"speech":"常州晴，30 度出头，体感快 37 了，挺闷的。","emotion":null}
也可以这样回：{"speech":"晴着，30.4°C，体感 36.8°C，风很小——这种天气容易中暑。","emotion":"happy"}
不要这样（把数字和字段名列表式念一遍）：{"speech":"明天在常州市，天气晴，气温 30.4℃，体感 36.8℃，湿度 73%，风速 1.8 km/h，观测时间 2026-07-31T01:15","emotion":null}

注意：上面两组「可以这样回」是同一个问题的两种说法，不是要你每次都照着第一种写。
你的回答应该随当时的心情、和对方的关系、问题急不急而变化——不要每次都套同一个句子结构。

只输出约定的 JSON。`;

  const locationSet = base +
    `\n下面是刚刚发生的「位置设置」事实（已经确定的事实，请勿改动其中的地名）：
{{TOOL_RESULTS}}
请用你平时说话的口吻，自然地告诉对方"位置已经记成上面这个行政区划"，
并请对方确认一下：如果记错了（比如同名城市选错、或者更具体的区县/街道没记到），补充一下具体地址就好。
可以顺带闲聊一句，但绝对不要编造地名，也不要提「工具」二字。只输出约定的 JSON。`;

  const normal = base +
    '\n如果用户询问实时信息（如当前时间、天气、最新新闻或需要联网检索的事实），你可以使用提供的工具获取最新数据，再据此组织口语化回复。' +
    '\n对于作品、角色、台词、情节、数据等事实类问题，优先使用【知识库参考】和工具结果；若参考内容无法确认该事实，请明确表达不确定，不要自行脑补或编造细节。';

  return { withTools, polish, locationSet, normal };
}

// 把"已记录的行政区划"整理成给 LLM 润色的原始事实文本（数字/地名不可改动）。
function buildLocationSetRaw(loc, ambiguous) {
  let raw = `已记录的用户位置（行政区划，请勿改动其中的地名）：${loc}`;
  if (ambiguous) {
    raw += '\n备注：该地名在多个地方都有重名，系统按最可能的候选记录，若记错请等待主人纠正。';
  }
  return raw;
}

function locationSetMessage(loc, ambiguous) {
  let msg = `位置记成${loc}了，之后查天气和时间按这里算。`;
  if (ambiguous) {
    msg += '（这个名字好几个地方都有，我先按最可能的记了；不对的话告诉我城市名就行。）';
  }
  return msg;
}

/**
 * 组网设备段：告诉模型「现在能操作哪些机器、怎么点名」。
 *
 * 用户 2026-11-20 的规则：
 *   「假如主机是在 QQ 或者本机聊天窗口（桌宠）或者网页端聊天窗口（核心），
 *     默认情况下操作主机下的 mcp 和 skill。如果点明了某个叶子节点或者叶子节点的
 *     别名，就操作那个叶子节点。如果请求来自某个叶子节点，那也默认操作自己这个
 *     叶子节点。」
 *
 * 这段只负责让模型**知道**有这回事、以及点名的语法；"默认在哪跑"由
 * services/toolRouting.js 在服务端判定（不靠模型自觉），模型只在需要
 * 换机器时才需要显式点名。
 *
 * @param {object} opts
 * @param {Array<{deviceId: string, name: string, online: boolean}>} opts.devices 可用叶子
 * @param {string} [opts.selfDeviceId] 本次请求来源设备（叶子自己提问时）
 * @param {string} [opts.selfDeviceName] 来源设备名
 * @returns {string} 拼进 system 的段落；没有组网设备时返回空串（不打扰单机用户）
 */
function buildDeviceBlock({ devices = [], selfDeviceId = '', selfDeviceName = '' } = {}) {
  const list = Array.isArray(devices) ? devices : [];
  const fromLeaf = !!selfDeviceId;
  // 单机安装（没有别的设备、也不是从叶子来的）：完全不注入，避免污染提示词
  if (!list.length && !fromLeaf) return '';

  const lines = ['\n\n【设备与工具执行位置】'];
  if (fromLeaf) {
    lines.push(
      `这次请求来自「${selfDeviceName || selfDeviceId.slice(0, 8)}」这台设备。` +
        '你不特别说明时，MCP 与 skill 都在这台设备上执行（那是它自己的机器）。',
    );
  } else {
    lines.push(
      '这次请求来自主机本体（本机聊天窗口 / QQ / 网页端）。' +
        '你不特别说明时，MCP 与 skill 都在主机自己身上执行。',
    );
  }

  if (list.length) {
    const shown = list
      .map((d) => `- ${d.name}（${d.online ? '在线' : '离线'}）`)
      .join('\n');
    lines.push(`\n组网里还有这些设备，可以把工具调用指到其中某一台：\n${shown}`);
    lines.push(
      '\n要指定设备时，把设备名或它的别名写在工具名前面，格式是：\n' +
        '  @device:<设备名> <原来的工具名>\n' +
        '例如想在那台机器的文件系统上读文件，就用 @device:书房的电脑 read_file；' +
        '设备名可以只写能唯一认出来的部分（比如「书房」），大小写无所谓。\n' +
        '这套写法最稳，能用就用它。实在忘了写前缀、把设备名当成参数传（比如 ' +
        '{"device": "书房"}）也认得出，但那是兜底，别当常规用法。',
    );
    lines.push(
      '注意：' +
        '① 只在**确实需要换机器**时才加这个前缀；不加就在上面说的默认设备上执行。' +
        '② 如果我说了要某台机器但你没找到这台设备，工具结果里会明确告诉你没找到，' +
        '你要把这件事如实说出来，不要假装在别处查过。',
    );
  } else {
    lines.push('\n（当前没有其它在线设备，工具都在上面说的那台机器上执行。）');
  }
  return lines.join('');
}

const COMPLEXITY_RULES = [
  { pattern: /什么模型|哪个模型|由什么驱动|模型驱动|为什么|原理|分析|比较|区别|设计|实现/, timeout: 90000 },
  { pattern: /详细|具体|举例|步骤|代码|方案|如何接入|怎么实现/, timeout: 90000 },
];

function getRequestTimeout(content) {
  const matchedRule = COMPLEXITY_RULES.find((rule) => rule.pattern.test(content));
  if (matchedRule) return matchedRule.timeout;
  if (content.length > 120) return 90000;
  if (content.length > 40) return 60000;
  return 45000;
}

// ── 气泡拆分 ────────────────────────────────────────────────────────────
// 把一条回复拆成多条"独立气泡"。参考 feiyu-os 角色卡：「每个换行 = 通道上一条独立气泡，
// 一条一个念头，一般 3~8 条」。真人聊天是连发短消息，不是一整段。
//
// 拆分规则（按优先级）：
//   1. 模型输出的换行是天然的气泡边界——提示词已引导模型按念头换行
//   2. 无换行的长文本按句末标点（。？！…）切，每条 ≥2 字
//   3. 单条超长（>120 字）不再硬切——宁可不拆也不破坏语义
//   4. 最多 5 条——连发超过 5 条在 IM 里是刷屏
//   5. 全部为空的行被丢弃；结果为空时返回 [原文]（空内容不拆）
// 用于：QQ 发送逐条、三个落地存储逐条 —— 三端看到一致的拆分气泡。
function splitSpeechBubbles(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // 按换行拆
  let lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // 只有单行且较长时按句末标点切（保留标点）
  if (lines.length === 1 && lines[0].length > 40) {
    const sentences = lines[0].split(/(?<=[。？！…])/).map((s) => s.trim()).filter(Boolean);
    // 切出来至少 2 段才有意义，且每段不产生超短碎片
    if (sentences.length >= 2 && sentences.every((s) => s.length >= 2)) lines = sentences;
  }
  // 过滤空行、限制条数（超长条不硬切，宁缺毋滥）
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (out.length >= 5) {
      // 超出 5 条：把剩余内容并回最后一条，避免丢内容
      out[out.length - 1] += '\n' + line;
      continue;
    }
    out.push(line);
  }
  return out.length ? out : [raw];
}

// 剔除交给 LLM 的对话历史中的系统噪声消息（如启动问候语），避免污染上下文。
function stripNonConversational(messages) {
  return messages.filter((m) => {
    const c = m.content;
    let text = '';
    if (Array.isArray(c)) {
      const t = c.find((p) => p && p.type === 'text');
      text = t ? String(t.text || '') : '';
    } else {
      text = typeof c === 'string' ? c : String(c || '');
    }
    return text.trim() !== GREETING_MESSAGE;
  });
}

module.exports = {
    splitSpeechBubbles,
  DEFAULT_PERSONA,
  GREETING_MESSAGE,
  LOCATION_ASK_MESSAGE,
  buildBasePrompt,
  buildSystemPrompts,
  buildDeviceBlock,
  buildLocationSetRaw,
  locationSetMessage,
  getRequestTimeout,
  stripNonConversational,
};
