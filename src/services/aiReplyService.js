const sessionManager = require('../session/sessionManager');

// 模型回复可携带的情绪/动作标签，需与前端白名单（PetEmotion）保持一致。
const EMOTION_WHITELIST = new Set(['happy', 'wave']);

// 把文本安全地 JSON.parse 为对象；失败返回 null。
function tryParseJson(text) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// 尽力修复残缺 JSON：剥离代码块、裁掉前后多余符号、补缺失大括号、去尾随逗号。
// 返回修复后的字符串；无法判定为 JSON 片段时返回 null。
function repairJson(text) {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s) return null;

  // 只取首个 { 到最后一个 } 之间的片段，容忍前后多余符号（如 "好的 {...} 再见"）
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  s = s.slice(start, end + 1);

  // 去尾随逗号：{, ] 之前的多余逗号
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // 配对大括号：缺右括号则在末尾补齐（容忍模型漏写闭合 }）
  const open = (s.match(/\{/g) || []).length;
  const close = (s.match(/\}/g) || []).length;
  if (open > close) s += '}'.repeat(open - close);

  return s;
}

// 末级兜底：从残缺 JSON 文本里用正则把 speech / emotion 抠出来。
function extractByRegex(text) {
  const speechMatch = text.match(/"speech"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|"\s*[a-zA-Z]|$)/);
  const speech = speechMatch
    ? speechMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim()
    : '';
  const emoMatch = text.match(/"emotion"\s*:\s*"(happy|wave)"/i);
  const emotion = emoMatch ? emoMatch[1].toLowerCase() : null;
  return {
    speech,
    emotion: EMOTION_WHITELIST.has(emotion) ? emotion : null,
  };
}

function toResult(obj) {
  if (obj && typeof obj.speech === 'string') {
    const speech = obj.speech.trim();
    if (speech) {
      const emotion =
        typeof obj.emotion === 'string' && EMOTION_WHITELIST.has(obj.emotion)
          ? obj.emotion
          : null;
      return { speech, emotion };
    }
    return { speech: '', emotion: null };
  }
  return { speech: JSON.stringify(obj), emotion: null };
}

// 从 speech 中提取 markdown 图片（![alt](url)），url 进入 images 数组并从文本移除，
// 避免气泡里出现裸 markdown 语法；前端会单独以图片网格渲染 images。
function extractImagesFromSpeech(speech) {
  const images = [];
  const cleaned = String(speech).replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (full, url) => {
    const u = String(url).trim();
    if (/^(https?:\/\/|data:image\/)/i.test(u)) images.push(u);
    return '';
  });
  return { speech: cleaned.replace(/\n{2,}/g, '\n').trim(), images };
}

function withImages(result) {
  const { speech, images } = extractImagesFromSpeech(result.speech);
  return { speech, emotion: result.emotion ?? null, images };
}

// 将模型返回内容解析为 { speech, emotion, images }。四级容错
function parseModelReply(raw) {
  if (!raw) return { speech: '', emotion: null, images: [] };
  const text = String(raw).trim();
  if (!text) return { speech: '', emotion: null, images: [] };

  const strict = tryParseJson(text);
  if (strict) return withImages(toResult(strict));

  const repaired = repairJson(text);
  if (repaired) {
    const obj = tryParseJson(repaired);
    if (obj) return withImages(toResult(obj));
  }

  const heur = extractByRegex(text);
  if (heur.speech) return withImages(heur);

  if (text.startsWith('{')) return { speech: '', emotion: null, images: [] };
  return withImages({ speech: text, emotion: null });
}

const { TOOL_DEFS, runTool, geocode } = require('../tools');
const locationSvc = require('./locationService');

// 联网工具：web_search 默认可用（内置 uapis 免 key 源），始终暴露；
// 用户若在设置里填了 SearXNG 地址 / Tavily Key，dispatcher 会自动路由到对应源。
function buildTools() {
  return TOOL_DEFS;
}

// ── 意图预检：在 LLM 调用前根据关键词预判是否需要联网工具 ──
// 兼容不支持 function calling 的模型/端点：
//   时间/天气（direct=true）→ 后端调工具 → 结果交给 LLM 润色（见 getReply 的 direct 路径）
//   搜索（direct=false）    → 后端调工具 → 结果注入 system prompt，由 LLM 总结
// 返回 { direct, injected, needLocation, setLocation }
const INTENT_PATTERNS = [
  // 时间意图：覆盖「几点」「查时间」「现在呢」「时间」等省略说法；
  // 单独说「时间」需要结合上下文理解，因此只在非首条消息或上下文出现过时间词时最稳，
  // 但这里先纳入匹配，避免模型走普通 LLM 自己编回复。
  { name: 'get_current_time', pattern: /几点|什么时间|现在几点|当前时间|日期|今天几号|星期几|现在什么时候|查时间|^时间$|^现在呢$|^几点了$/, direct: true },
  { name: 'get_weather', pattern: /天气|气温|温度|下雨|下雪|晴(?!朗)|阴天|湿度|风速|外面.*怎|冷不|热不|穿什么|带伞|查天气/, direct: true },
  { name: 'web_search', pattern: /搜[索一下]*|查[一一下]|新闻|最新.*消息|最近.*发生|热搜/, direct: false },
];

// 位置相关追问 / 设置提示语
const LOCATION_ASK_MESSAGE =
  '主人~我还不知道你在哪个城市呢 (｡•ᴗ•｡) 告诉我国内外的城市名，我就能帮你查天气和当地时间啦~（比如「北京」「上海」）';
// 启动 / 打开聊天窗口时主进程直接推送的问候语。它本身不写入记忆，
// 但为防止任何误落库的情况污染 LLM 上下文，拼装给模型的对话历史时统一剔除。
const GREETING_MESSAGE = '主人好呀~ (ฅ´ω`ฅ)';
function locationSetMessage(loc, ambiguous) {
  let msg = `好哒，我已经记住你在${loc}啦~ 以后查天气和时间就按那里来 (ฅ´ω\`ฅ)`;
  if (ambiguous) {
    msg += '（不过这个名字在好几个地方都有，我先按最可能的那个记了；要是不对，告诉我正确城市就好～）';
  }
  return msg;
}

// 把"已记录的行政区划"整理成给 LLM 润色的原始事实文本（数字/地名不可改动）。
function buildLocationSetRaw(loc, ambiguous) {
  let raw = `已记录的用户位置（行政区划，请勿改动其中的地名）：${loc}`;
  if (ambiguous) {
    raw += '\n备注：该地名在多个地方都有重名，系统按最可能的候选记录，若记错请等待主人纠正。';
  }
  return raw;
}

// 从天气类语句里提取用户"本轮"明确提到的城市（仅本次查询使用，不覆盖已存默认）。
// 优先匹配带行政区划后缀的地名，其次匹配「X天气 / X的天气」（X 排除时间词），避免把"今天"当城市。
function extractExplicitCity(text) {
  let m = text.match(/([\u4e00-\u9fa5]{2,8}(?:市|省|县|区|旗|市辖区))/);
  if (m) return m[1];
  m = text.match(/([\u4e00-\u9fa5]{2,4})(?:的)?天气/);
  if (m) {
    const cand = m[1];
    if (!/^(今天|明天|昨天|现在|此刻|当前|本地|这里|这儿|那儿|那里|这|那)$/.test(cand)) return cand;
  }
  return '';
}

// 检测文本命中哪些 direct 意图（时间/天气），返回意图名数组。
function detectDirectIntents(text) {
  const t = String(text || '');
  return INTENT_PATTERNS.filter((intent) => intent.direct && intent.pattern.test(t)).map((intent) => intent.name);
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

// 上下文接续检测：桌宠上轮因为缺位置而追问，本轮用户补充了地点。
// 不再用脆弱的「消息内容严格等于 LOCATION_ASK_MESSAGE」比对，而是直接取
// 「最近一条 assistant 消息」之前的「最近一条 user 消息」作为待接续的原始请求
// （调用方在 block D 已校验 rec.askedAt 且未存位置，可信任上条 assistant 即追问语）。
// 无则返回 null。返回前会剔除其中的系统问候语噪声。
async function inferPendingLocationIntent(sessionId) {
  if (!sessionId) return null;
  const msgs = await sessionManager.getRecentMessages(sessionId, 8);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') {
        const txt = String(msgs[j].content || '').trim();
        if (txt && txt !== GREETING_MESSAGE) return txt;
      }
    }
    return null;
  }
  return null;
}

// 根据已保存的位置，为之前 pending 的时间/天气意图运行工具并返回原始结果字符串。
async function runDirectToolsByIntents(intents, userid, clientIp, searchCtx) {
  const loc = await locationSvc.resolveForQuery(userid, clientIp, '');
  if (loc.needAsk || !loc.location) return null;
  const results = [];
  for (const intentName of intents) {
    try {
      let args = {};
      if (intentName === 'get_weather') {
        args = {
          location: loc.displayName || loc.location || '',
          latitude: loc.latitude,
          longitude: loc.longitude,
          displayName: loc.displayName || loc.location,
        };
      } else if (intentName === 'get_current_time') {
        args = { timezone: loc.timezone || null };
      }
      const result = await runTool(intentName, args, {
        searchKey: searchCtx.searchKey,
        searchEndpoint: searchCtx.searchEndpoint,
      });
      results.push(result);
    } catch (e) {
      results.push(`${intentName} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return results.length ? results.join('；') : null;
}

// 位置刚保存后，若存在待接续的时间/天气意图，则一并返回 direct 工具结果，
// 让 getReply 走"时间/天气润色 + 设置确认"的拼接路径；否则返回 null（由调用方走纯确认）。
async function maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved) {
  if (!sessionId || !saved) return null;
  const pendingText = await inferPendingLocationIntent(sessionId);
  if (!pendingText) return null;
  const intents = detectDirectIntents(pendingText);
  if (!intents.length) return null;
  const combined = await runDirectToolsByIntents(intents, userid, clientIp, searchCtx);
  if (!combined) return null;
  console.log(`[aiReply] continue pending intent after location set: ${intents.join(',')} -> ${combined.slice(0, 60)}`);
  return {
    direct: { speech: combined, emotion: 'happy', raw: combined },
    injected: null,
    needLocation: false,
    setLocation: { location: saved.location, ambiguous: saved.ambiguous },
  };
}

async function preflightTools(content, searchCtx = {}, clientIp = '', sessionId = '') {
  const text = content.trim();
  const userid = searchCtx?.userid;

  // —— A. 纯「设置/更新位置」语句（无查询意图）：持久化后直接确认 ——
  //   如「我的位置是上海」「更新地址为广州」「我在北京市」「我在常州~」
  const setLoc = locationSvc.extractSetLocation(text);
  console.log(`[aiReply] extractSetLocation("${text.slice(0, 30)}") -> ${setLoc || 'null'}`);
  if (setLoc) {
    const valid = await locationSvc.validateLocation(setLoc);
    console.log(`[aiReply] validateLocation("${setLoc}") -> ${valid}`);
    if (!valid) {
      // 校验失败：当作普通对话处理，避免把「我在吃饭」之类误当位置保存
      console.log(`[aiReply] "${setLoc}" geocode 校验失败，不走设置分支`);
    } else {
      const saved = await locationSvc.saveUserLocation(userid, setLoc);
      console.log(`[aiReply] set location -> ${saved?.location || 'null'} (ambiguous=${saved?.ambiguous})`);
      // 上下文接续：上轮因缺位置而追问，本轮用户补充地点 → 自动执行原时间/天气请求
      const continued = await maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved);
      if (continued) return continued;
      return { direct: null, injected: null, needLocation: false, setLocation: { location: saved.location, ambiguous: saved.ambiguous } };
    }
  }

  // —— A2. 冷启动裸地名：用户没加"我在"前缀、也没有查询意图，直接丢了个短地名 ——
  //   如首条消息就是"常州"、"北京"，或用户想更新已存位置。经 looksLikeLocation + geocode 校验后保存。
  //   注意：如果当前存在「已追问但未获得位置」的 pending 状态，让给 D 分支处理（支持上下文接续）。
  if (userid != null && !setLoc && detectDirectIntents(text).length === 0) {
    const rec = await locationSvc.getUserLocation(userid);
    if (rec && rec.askedAt && !rec.location) {
      console.log('[aiReply] bare-place skipped: pending location ask exists, let block-D handle continuation');
    } else {
      const bareLooksLike = locationSvc.looksLikeLocation(text);
      const bareDecline = locationSvc.isDecline(text);
      console.log(`[aiReply] bare-place looksLike=${bareLooksLike} decline=${bareDecline}`);
      if (bareLooksLike && !bareDecline) {
        const bareOk = await locationSvc.validateLocation(text);
        console.log(`[aiReply] bare-place validateLocation("${text.slice(0, 16)}") -> ${bareOk}`);
        if (bareOk) {
          const saved = await locationSvc.saveUserLocation(userid, text);
          if (saved) {
            console.log(`[aiReply] set location (bare place name) -> ${saved.location} (ambiguous=${saved.ambiguous})`);
            return { direct: null, injected: null, needLocation: false, setLocation: { location: saved.location, ambiguous: saved.ambiguous } };
          }
        }
      }
    }
  }

  // —— B. 解析本轮要用的位置 ——
  //   · 合并句「我在X + 查询」(如「我在北京现在几点」「我在上海天气」)：
  //       地理编码校验通过后持久化为默认位置，且用于本次查询（设位置+回答一步到位）
  //   · 显式城市「X天气 / X现在几点」：仅本次查询使用，不持久化；
  //     但若此前已追问过位置（用户用「X+查询」回应），则一并持久化为默认位置。
  //   用地理编码校验，避免把「我在吃饭」之类误当位置。
  let queryLoc = '';
  let setLocInfo = null; // 本轮"设置操作"记录（合并句/追问回复式 设置+查询 时，除返回 direct 数据外也要确认）
  const merged = locationSvc.extractMergedLocation(text);
  console.log(`[aiReply] extractMergedLocation("${text.slice(0, 30)}") -> ${merged || 'null'}`);
  if (merged) {
    const mergedValid = await locationSvc.validateLocation(merged);
    console.log(`[aiReply] validateLocation("${merged}") -> ${mergedValid}`);
    if (mergedValid) {
      if (userid != null) {
        const saved = await locationSvc.saveUserLocation(userid, merged);
        queryLoc = ''; // 已持久化为规范记录（含坐标），交给 resolveForQuery 读存储
        setLocInfo = { location: saved.location, ambiguous: saved.ambiguous };
        console.log(`[aiReply] merged set+query location -> ${saved.location} (ambiguous=${saved.ambiguous})`);
      } else {
        queryLoc = merged;
      }
    }
  } else {
    const oneOff = extractExplicitCity(text) || locationSvc.extractLeadCity(text);
    console.log(`[aiReply] explicit/lead city -> ${oneOff || 'null'}`);
    if (oneOff) {
      const oneOffValid = await locationSvc.validateLocation(oneOff);
      console.log(`[aiReply] validateLocation("${oneOff}") -> ${oneOffValid}`);
      if (oneOffValid) {
        queryLoc = oneOff;
        // 已追问过位置、用户用「X+查询」回应 → 一并设为默认位置，避免下次再问
        if (userid != null) {
          const rec = await locationSvc.getUserLocation(userid);
          if (rec && rec.askedAt && !rec.location) {
            const saved = await locationSvc.saveUserLocation(userid, oneOff);
            setLocInfo = { location: saved.location, ambiguous: saved.ambiguous };
            console.log(`[aiReply] follow-up set location via query -> ${saved.location} (ambiguous=${saved.ambiguous})`);
          }
        }
      }
    }
  }

  // —— C. 意图匹配（时间/天气/搜索）——
  const matched = [];
  for (const intent of INTENT_PATTERNS) {
    if (intent.pattern.test(text)) matched.push(intent);
  }

  // —— D. 对「位置追问」的回复：此前已问过、用户本轮简短地名回应（哪怕不含查询意图）——
  //   仅当本轮未解析出位置、且消息本身没有触发任何工具意图时才视为"回答追问"。
  if (userid != null && !queryLoc && matched.length === 0) {
    const rec = await locationSvc.getUserLocation(userid);
    console.log(`[aiReply] block-D rec=${rec ? JSON.stringify({loc: rec.location, askedAt: rec.askedAt}) : 'null'}`);
    if (rec && rec.askedAt && !rec.location) {
      const looksLike = locationSvc.looksLikeLocation(text);
      const decline = locationSvc.isDecline(text);
      console.log(`[aiReply] block-D looksLike=${looksLike} decline=${decline}`);
      if (looksLike && !decline) {
        const ok = await locationSvc.validateLocation(text);
        console.log(`[aiReply] block-D validateLocation("${text.slice(0, 16)}") -> ${ok}`);
        if (ok) {
          const saved = await locationSvc.saveUserLocation(userid, text);
          if (saved) {
            console.log(`[aiReply] set location (follow-up reply) -> ${saved.location} (ambiguous=${saved.ambiguous})`);
            // 上下文接续：用户用纯地名回应追问 → 若上轮是时间/天气请求，一并执行
            const continued = await maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved);
            if (continued) return continued;
            return { direct: null, injected: null, needLocation: false, setLocation: { location: saved.location, ambiguous: saved.ambiguous } };
          }
        }
      }
      // 拒绝提供（不知道/不用了…）或非法地名：不持久化，落到下方走 IP 兜底
    }
  }

  if (matched.length === 0) {
    return { direct: null, injected: null, needLocation: false, setLocation: setLocInfo };
  }

  console.log(`[aiReply] preflight matched tools: ${matched.map((m) => m.name).join(', ')}`);

  const allDirect = matched.every((m) => m.direct);
  const results = [];
  let needLocation = false;

  for (const intent of matched) {
    try {
      let args = {};
      if (intent.name === 'get_weather' || intent.name === 'get_current_time') {
        const loc = await locationSvc.resolveForQuery(userid, clientIp, queryLoc);
        console.log(`[aiReply] resolveForQuery intent=${intent.name} explicit="${queryLoc}" -> ${JSON.stringify({location: loc.location, lat: loc.latitude, lon: loc.longitude, tz: loc.timezone, needAsk: loc.needAsk, source: loc.source})}`);
        if (loc.needAsk) { needLocation = true; break; }
        if (!loc.location && loc.latitude == null && loc.longitude == null) { results.push('缺少地点参数（location）'); continue; }
        if (intent.name === 'get_weather') {
          // 直接下发固化坐标 + 显示名，天气按坐标查询，唯一且明确
          args.location = loc.displayName || loc.location || '';
          args.latitude = loc.latitude;
          args.longitude = loc.longitude;
          args.displayName = loc.displayName || loc.location || '';
        } else {
          args.timezone = loc.timezone;
          // 兜底补全时区（存储记录缺失时区且地理编码可用时）
          if (!args.timezone && loc.location) {
            try {
              const g = await geocode(loc.location);
              if (g && g.timezone) args.timezone = g.timezone;
            } catch {
              /* ignore */
            }
          }
        }
        // 无 location 也无坐标（极端兜底失败）时时间查询走服务器本地时间降级
      }
      const result = await runTool(intent.name, args, { searchKey: searchCtx.searchKey, searchEndpoint: searchCtx.searchEndpoint });
      console.log(`[aiReply] preflight ${intent.name} OK: ${result.slice(0, 80)}`);
      results.push(result);
    } catch (e) {
      const errText = `${intent.name} error: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[aiReply] preflight ${intent.name} ERR:`, e);
      results.push(errText);
    }
  }

  if (needLocation) {
    console.log('[aiReply] preflight needLocation (ask user once)');
    return { direct: null, injected: null, needLocation: true, setLocation: setLocInfo };
  }

  if (allDirect) {
    // direct 工具（时间/天气）：先把原始数据拼好，交给 LLM 润色（见 getReply 的 direct 路径）；
    // raw 字段保存原始文本，供 LLM 润色失败后回退使用。
    const combined = results.join('；');
    console.log(`[aiReply] preflight DIRECT (will polish via LLM): ${combined.slice(0, 60)}`);
    return { direct: { speech: combined, emotion: 'happy', raw: combined }, injected: null, needLocation: false, setLocation: setLocInfo };
  }

  // 非 direct 工具（如 search）：收集结果用于注入 system prompt
  return { direct: null, injected: results.map((r) => `[tool] ${r}`), needLocation: false, setLocation: setLocInfo };
}

// 系统提示模板
const SYSTEM_PROMPT_BASE = `你是一个友善、简洁的虚拟桌宠助手。
请只输出一个 JSON 对象（不要包含任何额外文字、不要使用 markdown 代码块），格式如下：
{"speech":"你对用户的口语化回复","emotion":"happy 或 wave 或 null"}
字段说明：
- speech：你对用户的口头回复，保持口语化、简洁；不要出现 JSON 或情绪标签字样。
- emotion：这轮回复表达的情绪/动作标签。
  - "happy"：回复表达开心、兴奋、赞同、被夸奖、送出好消息等正向情绪。
  - "wave"：回复用于打招呼、欢迎、告别、主动搭话。
  - 其他情况一律填 null。
- 图片展示：如需在回复中展示图片（例如搜索结果图、或你生成的图），可在 speech 的适当位置使用标准 markdown 图片语法 ![图片描述](图片URL)；系统会将该图片单独渲染。URL 必须完整且不含空格，不要用 HTML <img> 标签。`;

// 带 tool 数据注入的系统提示（仅 web_search 等非 direct 工具命中时使用）
const SYSTEM_PROMPT_WITH_TOOLS = SYSTEM_PROMPT_BASE +
`\n以下是通过工具获取到的实时数据，请据此用口语化方式回答用户的问题（不要提及「工具」二字）：\n{{TOOL_RESULTS}}`;

// 仅 direct 工具（时间/天气）命中时使用：把工具原始数据交给 LLM 润色成符合人设的口语，
// 而不是生硬地直接吐出数据；若 LLM 调用失败则回退到原始数据直接返回（见 getReply）。
const SYSTEM_PROMPT_POLISH = SYSTEM_PROMPT_BASE +
`\n请根据下面的「用户问题」和「已查到的实时数据」生成回复。
用户问题：{{USER_QUESTION}}
实时数据：{{TOOL_RESULTS}}
要求：
- 用你平时跟主人聊天的自然口吻，直接回答用户问题；
- 严格使用实时数据中的数字、时间、地点，不得改动；
- 直接回答，不要反问，不要问"要看天气还是时间"之类的问题；
- 不要说你还需要查询、获取、等待或刷新，数据已经是最新的；
- 禁止照搬原始格式：不要输出 "Asia/Shanghai" 这类时区ID，不要输出 "2026-07-31T01:15" 这类ISO时间，不要输出"观测时间"等字段名；
- 时间用"凌晨/早上/上午/中午/下午/晚上"自然表达；天气不要把所有数字列表式报完，挑重点组织成一句流畅的话；
- 可以顺带一句关心或闲聊，但绝对不要编造数据，不要提「工具」二字。

示例（仅作格式参考，数字请以实时数据为准）：
用户问题：现在几点
实时数据：现在本地时间是 2026年7月31日星期五 凌晨01:15:06
好的回复：{"speech":"主人，现在是星期五凌晨 1 点 15 分啦～还没睡吗？","emotion":"happy"}
不好的回复：{"speech":"当前时间：2026年7月31日星期五 01:15:06（时区 Asia/Shanghai）","emotion":null}

用户问题：常州现在天气怎么样
实时数据：常州市现在晴，气温 30.4°C（体感 36.8°C），相对湿度 73%，风速 1.8 km/h。
好的回复：{"speech":"常州现在晴着呢，气温 30.4°C，体感 36.8°C，有点闷热，记得多喝水防暑哦～","emotion":"happy"}
不好的回复：{"speech":"明天在常州市，天气晴，气温 30.4℃，体感 36.8℃，湿度 73%，风速 1.8 km/h，观测时间 2026-07-31T01:15","emotion":null}

只输出约定的 JSON。`;

// 位置设置确认专用润色提示：把"已记录的行政区划"交给 LLM，用桌宠口吻告诉主人"我记成了 X"，
// 并友好地请主人确认/纠正（若记错，主人往往会给出更精确的地址，便于后续查询）。
const SYSTEM_PROMPT_LOCATION_SET = SYSTEM_PROMPT_BASE +
`\n下面是刚刚发生的「位置设置」事实（已经确定的事实，请勿改动其中的地名）：
{{TOOL_RESULTS}}
请用你平时跟主人聊天的口吻，自然地告诉主人"我已经把你的位置记成了上面这个行政区划啦"，
并友好地请主人确认一下：如果记错了（比如同名城市选错、或者更具体的区县/街道没记到），让主人再补充一下具体地址就好。
可以顺带关心两句，但绝对不要编造地名，也不要提「工具」二字。只输出约定的 JSON。`;

// 普通 system prompt（无工具命中时，提示模型可用 function calling）
const SYSTEM_PROMPT_NORMAL = SYSTEM_PROMPT_BASE +
'\n如果用户询问实时信息（如当前时间、天气、最新新闻或需要联网检索的事实），你可以使用提供的工具获取最新数据，再据此组织口语化回复。';

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

// 把工具的原始数据交给 LLM 润色成符合人设的口语回复。
// 成功返回模型解析结果；失败（异常 / 模型空回复 / 解析不出 speech）则抛出，由调用方回退到工具原始结果。
// systemPromptOverride 可选：传入自定义 system 提示（如位置设置确认），此时仍用 {{TOOL_RESULTS}} 占位符注入事实。
async function polishToolResult(rawToolText, aiContext, sessionId, userText, controller, systemPromptOverride) {
  // 润色任务只聚焦「当前用户问题 + 工具数据」，不引入完整对话历史。
  // 完整历史容易让模型把上一轮的反问/确认当成当前任务，导致"请稍等我获取"、"天气还是时间"等幻觉。
  const systemPrompt = (systemPromptOverride || SYSTEM_PROMPT_POLISH)
    .replace('{{TOOL_RESULTS}}', rawToolText)
    .replace('{{USER_QUESTION}}', userText || '请帮我看看上面的信息');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText || '请帮我看看上面查到的信息。' },
  ];

  const completion = await aiContext.openai.chat.completions.create(
    {
      model: aiContext.model,
      messages,
      max_tokens: 800,
    },
    { signal: controller.signal },
  );

  const msg = completion.choices?.[0]?.message;
  if (!msg || !msg.content || !msg.content.trim()) {
    throw new Error('模型润色返回为空');
  }
  const { speech, emotion, images } = parseModelReply(msg.content.trim());
  if (!speech) throw new Error('模型润色结果为空');
  return {
    speech,
    emotion,
    images: Array.isArray(images) ? images : [],
    action: 'idle',
    mood: 'curious',
    source: 'model',
    model: completion.model,
    usage: completion.usage,
    sessionId,
    userid: aiContext.userid,
  };
}

async function getReply({ aiContext, content = '', images = [], sessionId, clientIp = '' } = {}) {
  if (!aiContext || aiContext.closed || !aiContext.openai) {
    throw new Error('AI 连接上下文不可用');
  }

  const text = content.trim();
  const imgList = Array.isArray(images) ? images.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!text && imgList.length === 0) {
    throw new Error('消息不能为空');
  }

  const controller = new AbortController();
  const timeout = getRequestTimeout(text || '[用户发送了图片]');
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  aiContext.activeRequests.add(controller);

  try {
    // ── Step 1: 意图预检 ──
    //   时间/天气等 direct 工具 → 取回数据后交给 LLM 润色（见下方 direct 路径）
    //   搜索类非 direct 工具 → 收集结果用于后续注入 prompt
    //   位置相关：未存位置先追问一次；用户说"我在X/更新位置"则持久化
    const preflight = await preflightTools(text || '[用户发送了图片]', aiContext, clientIp, sessionId);

    // 需要位置但未获取：先问用户一次（不调工具、不调 LLM，直接返回追问语）
    if (preflight.needLocation) {
      console.log('[aiReply] location required but missing, asking user once');
      return {
        speech: LOCATION_ASK_MESSAGE,
        emotion: 'wave',
        action: 'idle',
        mood: 'curious',
        source: 'location_ask',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
    }

    // 位置设置确认：把"已记录的行政区划"交给 LLM，用桌宠口吻告诉主人"我记成了 X"，
    // 并友好请其确认/纠正（若记错，主人往往会补更精确的地址，便于后续查询）。
    // LLM 润色失败则回退到兜底提示语（locationSetMessage）。
    let confirmSpeech = null;
    if (preflight.setLocation) {
      const raw = buildLocationSetRaw(preflight.setLocation.location, preflight.setLocation.ambiguous);
      try {
        console.log('[aiReply] location set, polishing confirmation via LLM...');
        const c = await polishToolResult(raw, aiContext, sessionId, text, controller, SYSTEM_PROMPT_LOCATION_SET);
        confirmSpeech = c.speech;
      } catch (e) {
        console.warn('[aiReply] 位置设置确认润色失败，回退到底层提示语：', e?.message || e);
        confirmSpeech = locationSetMessage(preflight.setLocation.location, preflight.setLocation.ambiguous);
      }
    }

    // direct 命中（时间/天气）：先取回工具原始数据，再交给 LLM 润色成符合人设的口语；
    // 若 LLM 调用失败 / 无有效回复，则回退到工具原始结果直接返回，保证永远有应答。
    // 若本轮同时进行了位置设置（合并句/追问回复式 设置+查询），把设置确认语拼接在正文之后。
    if (preflight.direct) {
      const rawText = preflight.direct.raw || preflight.direct.speech;
      const fallback = {
        speech: preflight.direct.speech,
        emotion: preflight.direct.emotion,
        action: 'idle',
        mood: 'curious',
        source: 'tool_direct',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
      try {
        console.log('[aiReply] direct tool hit, polishing via LLM...');
        const polished = await polishToolResult(rawText, aiContext, sessionId, text, controller);
        console.log('[aiReply] polished reply via LLM OK');
        if (confirmSpeech) {
          // 合并句：时间/天气答复 + 位置设置确认（两者均经 LLM 润色）
          return { ...polished, speech: `${polished.speech}\n${confirmSpeech}`, source: 'model' };
        }
        return polished;
      } catch (e) {
        console.warn('[aiReply] LLM 润色失败，回退到工具直接回复：', e?.message || e);
        if (confirmSpeech) {
          return { ...fallback, speech: `${fallback.speech}\n${confirmSpeech}` };
        }
        return fallback;
      }
    }

    // 仅有位置设置确认（无 direct 查询）：返回润色后的确认语
    if (confirmSpeech) {
      console.log('[aiReply] location set confirmation (no query), returning polished confirm');
      return {
        speech: confirmSpeech,
        emotion: 'happy',
        action: 'idle',
        mood: 'curious',
        source: 'location_set',
        model: aiContext.model,
        usage: null,
        sessionId,
        userid: aiContext.userid,
      };
    }

    // ── Step 2: 构建 messages 并调用 LLM ──
    const recentMessages = await sessionManager.getRecentMessages(sessionId, 6);

    const systemPrompt = preflight.injected
      ? SYSTEM_PROMPT_WITH_TOOLS.replace('{{TOOL_RESULTS}}', preflight.injected.join('\n'))
      : SYSTEM_PROMPT_NORMAL;

    // 历史消息 content 可能是字符串，或 [text, image_url] 多模态数组（JSON 序列化存储）；
    // 统一归一化为 OpenAI 消息格式，确保发送过的图片在上下文里不被丢弃。
    // 同时剔除启动问候语等系统噪声，避免污染 LLM 上下文。
    const normalizedRecent = stripNonConversational(recentMessages).map((m) => {
      const c = m.content;
      if (Array.isArray(c)) return { role: m.role, content: c };
      if (typeof c === 'string') return { role: m.role, content: c };
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed)) return { role: m.role, content: parsed };
      } catch {
        // 非 JSON，按纯文本处理
      }
      return { role: m.role, content: String(c) };
    });

    // 本轮用户消息：文本 + 图片（base64 data URL 或图片 URL）构成多模态 content 数组。
    const userParts = [];
    if (text) userParts.push({ type: 'text', text });
    for (const img of imgList) {
      userParts.push({ type: 'image_url', image_url: { url: img } });
    }
    const userContent =
      userParts.length > 1 || (userParts.length === 1 && userParts[0].type !== 'text')
        ? userParts
        : (text || '');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...normalizedRecent,
      { role: 'user', content: userContent },
    ];

    const tools = buildTools();
    const toolChoice = tools.length ? 'auto' : undefined;

    // tool-call loop：模型可多次调用工具，直到产出最终文本
    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await aiContext.openai.chat.completions.create(
        {
          model: aiContext.model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: toolChoice,
          max_tokens: 800,
        },
        { signal: controller.signal },
      );

      const msg = completion.choices?.[0]?.message;
      if (!msg) throw new Error('模型返回为空');

      // 诊断日志
      console.log(
        `[aiReply] round=${round} finish_reason=${completion.choices?.[0]?.finish_reason} ` +
        `has_content=${!!msg.content} content_len=${(msg.content || '').length} ` +
        `tool_calls_count=${msg.tool_calls?.length || 0} ` +
        `tool_names=${(msg.tool_calls || []).map((t) => t.function?.name).join(',') || '(none)'}`,
      );
      if (msg.tool_calls?.length > 0) {
        console.log(`[aiReply] tool_calls detail:`, JSON.stringify(msg.tool_calls));
      }

      messages.push(msg);

      // 无工具调用 → 最终回复
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const rawContent = msg.content?.trim();
        if (!rawContent) throw new Error('模型返回内容为空');
        const { speech, emotion, images } = parseModelReply(rawContent);
        if (!speech) throw new Error('模型返回内容为空');
        return {
          speech,
          emotion,
          images: Array.isArray(images) ? images : [],
          action: 'idle',
          mood: 'curious',
          source: 'model',
          model: completion.model,
          usage: completion.usage,
          sessionId,
          userid: aiContext.userid,
        };
      }

      // 有工具调用 → 执行并回灌
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
          result = await runTool(tc.function?.name, args, {
            searchKey: aiContext.searchKey,
            searchEndpoint: aiContext.searchEndpoint,
            searchProvider: aiContext.searchProvider,
            openai: aiContext.openai,
          });
        } catch (e) {
          result = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
      }
    }

    throw new Error('工具调用轮次过多，未能生成最终回复');
  } finally {
    clearTimeout(timeoutId);
    aiContext.activeRequests.delete(controller);
  }
}

module.exports = { getReply, getRequestTimeout };
