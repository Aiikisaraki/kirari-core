// src/services/reply/intent.js
// 意图预检 + 工具前置：在 LLM 调用前根据关键词预判是否需要联网工具，并处理位置设置/追问接续。
// 兼容不支持 function calling 的模型/端点：
//   时间/天气（direct=true）→ 后端调工具 → 结果交给 LLM 润色（见 conversationService 的 direct 路径）
//   搜索（direct=false）    → 后端调工具 → 结果注入 system prompt，由 LLM 总结

const { mergeTools, runTool, getFrontendToolNames, geocode } = require('../../tools');
const locationSvc = require('../locationService');
const sessionManager = require('../../session/sessionManager');
const { GREETING_MESSAGE } = require('./promptBuilder');

// 联网工具：web_search 默认可用（内置 uapis 免 key 源），始终暴露；
// 用户若在设置里填了 SearXNG 地址 / Tavily Key，dispatcher 会自动路由到对应源。
// 同时合并前端托管工具（MCP server / skill 提供的工具）：这些工具由 Electron 主进程
// 实际执行，后端只持有其 schema，模型命中时由 socketServer 回调解前端执行。
function buildTools() {
  return mergeTools();
}

// ── 意图预检模式 ──
const INTENT_PATTERNS = [
  // 时间意图：覆盖「几点」「查时间」「现在呢」「时间」等省略说法；
  // 单独说「时间」需要结合上下文理解，因此只在非首条消息或上下文出现过时间词时最稳，
  // 但这里先纳入匹配，避免模型走普通 LLM 自己编回复。
  { name: 'get_current_time', pattern: /几点|什么时间|现在几点|当前时间|日期|今天几号|星期几|现在什么时候|查时间|^时间$|^现在呢$|^几点了$/, direct: true },
  { name: 'get_weather', pattern: /天气|气温|温度|下雨|下雪|晴(?!朗)|阴天|湿度|风速|外面.*怎|冷不|热不|穿什么|带伞|查天气/, direct: true },
  { name: 'web_search', pattern: /搜[索一下]*|查[一一下]|新闻|最新.*消息|最近.*发生|热搜/, direct: false },
];

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

// 上下文接续检测：桌宠上轮因为缺位置而追问，本轮用户补充了地点。
// 不再用脆弱的「消息内容严格等于 LOCATION_ASK_MESSAGE」比对，而是直接取
// 「最近一条 assistant 消息」之前的「最近一条 user 消息」作为待接续的原始请求
// （调用方已校验 rec.askedAt 且未存位置，可信任上条 assistant 即追问语）。
// 无则返回 null。返回前会剔除其中的系统问候语噪声。
async function inferPendingLocationIntent(sessionId) {
  if (!sessionId) return null;
  const msgs = await sessionManager.getRecentMessages(sessionId, 8);
  console.log(`[aiReply] inferPendingLocationIntent messages (${msgs.length}): ${msgs.map((m) => `${m.role}:${String(m.content || '').slice(0, 20)}`).join(' | ')}`);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') {
        const txt = String(msgs[j].content || '').trim();
        if (txt && txt !== GREETING_MESSAGE) {
          console.log(`[aiReply] inferPendingLocationIntent found pending user text: "${txt}"`);
          return txt;
        }
      }
    }
    console.log('[aiReply] inferPendingLocationIntent no user text before latest assistant');
    return null;
  }
  console.log('[aiReply] inferPendingLocationIntent no assistant message found');
  return null;
}

// 根据已保存的位置，为之前 pending 的时间/天气意图运行工具并返回原始结果字符串。
async function runDirectToolsByIntents(intents, userid, clientIp, searchCtx, scope) {
  const loc = await locationSvc.resolveForQuery(userid, clientIp, '', null, scope);
  if (loc.needAsk || !loc.location) return null;
  const results = [];
  for (const intentName of intents) {
    try {
      let args = {};
      if (intentName === 'get_weather') {
        if (loc.source === 'fallback' || loc.latitude == null || loc.longitude == null) {
          results.push('我还不知道你具体在哪个城市，告诉我城市名才能帮你查天气哦~');
          continue;
        }
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
async function maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved, scope) {
  if (!sessionId || !saved) return null;
  const pendingText = await inferPendingLocationIntent(sessionId);
  if (!pendingText) return null;
  const intents = detectDirectIntents(pendingText);
  console.log(`[aiReply] pending intents detected from "${pendingText.slice(0, 40)}": ${intents.join(',') || '(none)'}`);
  if (!intents.length) return null;
  const combined = await runDirectToolsByIntents(intents, userid, clientIp, searchCtx, scope);
  if (!combined) return null;
  console.log(`[aiReply] continue pending intent after location set: ${intents.join(',')} -> ${combined.slice(0, 60)}`);
  return {
    direct: { speech: combined, emotion: 'happy', raw: combined, userText: pendingText },
    injected: null,
    needLocation: false,
    setLocation: { location: saved.location, ambiguous: saved.ambiguous },
  };
}

async function preflightTools(content, searchCtx = {}, clientIp = '', sessionId = '', locationScope = null) {
  const scope = locationScope || null;
  const _pt = Date.now();
  console.log(`[preflight] 进入 content="${String(content).slice(0, 40)}" userid=${searchCtx?.userid} clientIp=${clientIp || 'empty'} scope=${scope || 'null'} @${_pt}`);
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
      const saved = await locationSvc.saveUserLocation(userid, setLoc, scope);
      console.log(`[aiReply] set location -> ${saved?.location || 'null'} (ambiguous=${saved?.ambiguous})`);
      // 上下文接续：上轮因缺位置而追问，本轮用户补充地点 → 自动执行原时间/天气请求
      const continued = await maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved, scope);
      if (continued) return continued;
      return { direct: null, injected: null, needLocation: false, setLocation: { location: saved.location, ambiguous: saved.ambiguous } };
    }
  }

  // —— A2. 冷启动裸地名：用户没加"我在"前缀、也没有查询意图，直接丢了个短地名 ——
  //   如首条消息就是"常州"、"北京"，或用户想更新已存位置。经 looksLikeLocation + geocode 校验后保存。
  //   注意：如果当前存在「已追问但未获得位置」的 pending 状态，让给 D 分支处理（支持上下文接续）。
  if (userid != null && !setLoc && detectDirectIntents(text).length === 0) {
    const rec = await locationSvc.getUserLocation(userid, scope);
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
          const saved = await locationSvc.saveUserLocation(userid, text, scope);
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
          const rec = await locationSvc.getUserLocation(userid, scope);
          if (rec && rec.askedAt && !rec.location) {
            const saved = await locationSvc.saveUserLocation(userid, oneOff, scope);
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
    const rec = await locationSvc.getUserLocation(userid, scope);
    console.log(`[aiReply] block-D rec=${rec ? JSON.stringify({ loc: rec.location, askedAt: rec.askedAt }) : 'null'}`);
    if (rec && rec.askedAt && !rec.location) {
      const looksLike = locationSvc.looksLikeLocation(text);
      const decline = locationSvc.isDecline(text);
      console.log(`[aiReply] block-D looksLike=${looksLike} decline=${decline}`);
      if (looksLike && !decline) {
        const ok = await locationSvc.validateLocation(text);
        console.log(`[aiReply] block-D validateLocation("${text.slice(0, 16)}") -> ${ok}`);
        if (ok) {
          const saved = await locationSvc.saveUserLocation(userid, text, scope);
          if (saved) {
            console.log(`[aiReply] set location (follow-up reply) -> ${saved.location} (ambiguous=${saved.ambiguous})`);
            // 上下文接续：用户用纯地名回应追问 → 若上轮是时间/天气请求，一并执行
            const continued = await maybeContinuePendingLocationQuery(sessionId, userid, clientIp, searchCtx, saved, scope);
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
        console.log(`[preflight] resolveForQuery 调用前 intent=${intent.name} @${Date.now()}`);
        const loc = await locationSvc.resolveForQuery(userid, clientIp, queryLoc, null, scope);
        console.log(`[preflight] resolveForQuery 返回 ${JSON.stringify({ location: loc.location, tz: loc.timezone, needAsk: loc.needAsk, source: loc.source })} 耗时=${Date.now() - _pt}ms`);
        if (loc.needAsk) { needLocation = true; break; }
        if (!loc.location && loc.latitude == null && loc.longitude == null) { results.push('缺少地点参数（location）'); continue; }
        if (intent.name === 'get_weather') {
          // IP 兜底失败时只有时区没有坐标，无法查天气，友好提示用户补充城市
          if (loc.source === 'fallback' || loc.latitude == null || loc.longitude == null) {
            results.push('我还不知道你具体在哪个城市，告诉我城市名才能帮你查天气哦~');
            continue;
          }
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

module.exports = { preflightTools, buildTools, detectDirectIntents, INTENT_PATTERNS };
