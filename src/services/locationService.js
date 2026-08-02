// 用户位置服务：天气/时间等强地区相关查询依赖位置信息。
// 设计原则（隐私优先、少侵入）：
//   1. 不主动收集（不调用浏览器定位、不在登录时索取）。
//   2. 位置来自「用户在对话中自己提供」，按用户凭据（uid）持久化。
//   3. 若用户从未提供过位置：首次遇到地区相关问题时问一次；若仍不提供，
//      下次直接按用户公网 IP 归属地查询；访问 IP 为内网/回环时，取服务端公网 IP。
//   4. 用户之后在对话中说「更新位置/我在X」等，则更新持久化记录。

const db = require('../db/dbStorage');
const { geocode, geocodeCandidates } = require('../tools');

// 用地理编码结果拼出可读的行政区划标签（如「北京市, 中国」「鼓楼区, 南京市, 中国」）。
function buildLabel(c) {
  if (!c) return null;
  const parts = [];
  if (c.name) parts.push(c.name);
  if (c.admin1 && c.admin1 !== c.name) parts.push(c.admin1);
  if (c.country) parts.push(c.country);
  return parts.join(', ');
}

// 判断 IP 是否为私有/回环地址（IPv4 / IPv4-mapped IPv6 / 常见保留段）。
function isPrivateOrLoopback(ip) {
  if (!ip) return true;
  let s = String(ip).trim();
  if (s.includes(':')) {
    if (s === '::1' || s === '::') return true;
    if (s.toLowerCase().startsWith('::ffff:')) s = s.slice(7);
  }
  if (s === '127.0.0.1' || s === 'localhost' || s === '0.0.0.0') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  return false;
}

// 通过免费、免 key 的 ipapi.co 查询 IP 归属地（含时区/经纬度）。
// clientIp 为内网/回环或空时，省略 IP 以查询"服务端自身公网 IP"归属地。
// 为避免网络抖动/离线导致请求卡死，内部强制 5 秒超时；支持外部 AbortSignal。
const _ipCache = new Map(); // key: clientIp or '__server__', value: { ts, data }
const IP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

async function lookupIpLocation(clientIp, signal) {
  const _t0 = Date.now();
  const cacheKey = !clientIp || isPrivateOrLoopback(clientIp) ? '__server__' : String(clientIp).trim();
  console.log(`[ip] lookupIpLocation 开始 clientIp=${clientIp||'empty'} cacheKey=${cacheKey} signal=${signal?'yes':'no'} @${_t0}`);
  const cached = _ipCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < IP_CACHE_TTL_MS) {
    console.log(`[location] IP lookup cache hit for ${cacheKey === '__server__' ? 'server' : clientIp} 耗时=${Date.now()-_t0}ms`);
    return cached.data;
  }

  const useServerIp = !clientIp || isPrivateOrLoopback(clientIp);
  const url = useServerIp
    ? 'https://ipapi.co/json/'
    : `https://ipapi.co/json/${encodeURIComponent(clientIp)}/`;

  // 内部超时：即使外部没传 signal，也不允许无限等待
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const combinedSignal = signal
    ? AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal
    : controller.signal;

  try {
    console.log(`[ip] fetch 开始 url=${url} @${Date.now()}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'kirari-pet/1.0' },
      signal: combinedSignal,
    });
    clearTimeout(timeoutId);
    console.log(`[ip] fetch 结束 ok=${res.ok} 耗时=${Date.now()-_t0}ms @${Date.now()}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || d.error) return null;
    const city = d.city || d.region || '';
    const country = d.country_name || d.country || '';
    const location = city || country;
    if (!location) return null;
    const data = {
      location,
      timezone: d.timezone || null,
      latitude: d.latitude ?? null,
      longitude: d.longitude ?? null,
    };
    _ipCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') {
      console.warn(`[location] IP lookup timeout/aborted for ${cacheKey === '__server__' ? 'server' : clientIp}`);
    } else {
      console.warn(`[location] IP lookup failed for ${cacheKey === '__server__' ? 'server' : clientIp}:`, err?.message || err);
    }
    return null;
  }
}

// 从「设置/更新位置」类语句中提取地点名；无则返回 null。
// 明确标注「位置/地址/坐标」的语句允许裸地名；「我在X」要求 X 带行政区划后缀，
// 避免把「我在吃饭」误判为地点。同时排除明显非地名的词。
function extractSetLocation(text) {
  const t = String(text || '').trim();
  const NEG = ['地图', '这儿', '那儿', '这里', '那里', '哪里', '哪儿', '哪', '此处', '该处'];
  const clean = (s) => {
    const v = (s || '').trim();
    if (!v) return null;
    if (NEG.some((w) => v.includes(w))) return null;
    return v;
  };
  // 标注式：「我的位置/地址/坐标是 X」
  const labeled = t.match(
    /(?:我的)?(?:位置|地址|坐标)[是为在]?[:：]?\s*([\u4e00-\u9fa5A-Za-z·\s]{2,16}?)(?:市|省|县|区|旗|市辖区)?/,
  );
  if (labeled) {
    const v = clean(labeled[1]);
    if (v) return v;
  }
  // 「我在/位于/住在/家在 X」：允许裸地名（如「我在常州~」「我在常州呀」），
  // 地名后遇到语气词、标点、句尾即截断，避免把后续闲聊也吞进来；
  // 后续 preflightTools 会用 validateLocation()/geocode() 再校验真伪。
  const at = t.match(
    /我(?:在|位于|住在|家在)\s*([\u4e00-\u9fa5A-Za-z·\s]{2,16}?)(?:市|省|县|区|旗|市辖区|~|！|!|。|，|,|\s|呀|呢|啊|哦|哈|呐|吧|嘛|咩|～|…|\.|\?|？|$)/,
  );
  if (at) {
    const v = clean(at[1]);
    if (v) return v;
  }
  return null;
}

// 合并句「我在X + 查询」提取：如「我在北京现在几点」「我在上海天气」。
// 与 extractSetLocation 区别：此处 X 后紧跟时间/天气等查询词，故不强求行政区划后缀，
// 用地理编码(validateLocation)来确认 X 是否真实地点，避免把「我在吃饭」误当位置。
function extractMergedLocation(text) {
  const t = String(text || '').trim();
  const NEG = ['地图', '这儿', '那儿', '这里', '那里', '哪里', '哪儿', '哪', '此处', '该处'];
  if (NEG.some((w) => t.includes(w))) return null;
  const m = t.match(
    /我(?:在|位于|家在|住在)\s*([\u4e00-\u9fa5A-Za-z·]{2,12}?)(?:市|省|县|区|旗|市辖区|现在|此刻|当前|今天|明天|这|那|今|几|什么|查询|查|天气|时间|气温|温度|几点|几号|星期|下雨|下雪|晴天|阴天|怎么|如何|多少|啥|呀|呢|啊|吗|~|，|,|\s|$)/,
  );
  if (m) {
    const v = (m[1] || '').trim();
    if (v && !NEG.some((w) => v.includes(w))) return v;
  }
  return null;
}

// 句首地名 + 查询词：如「北京现在几点」「上海天气」。仅用于「本轮一次性查询」(不持久化)。
function extractLeadCity(text) {
  const t = String(text || '').trim();
  const NEG = ['地图', '这儿', '那儿', '这里', '那里', '哪里', '哪儿', '哪', '此处', '该处'];
  if (NEG.some((w) => t.includes(w))) return '';
  const m = t.match(
    /^([\u4e00-\u9fa5]{2,8}?)(?:的)?(?:现在|此刻|当前|今天|明天|昨天|几点|几号|星期|天气|气温|温度|下雨|下雪|阴天|冷不|热不|穿什么|带伞|怎么样|怎样|如何)/,
  );
  if (!m) return '';
  const v = (m[1] || '').trim();
  if (!v || ['今天', '明天', '昨天', '现在', '此刻', '当前', '本地', '这里', '这儿', '那儿', '那里', '这', '那', '我'].includes(v)) return '';
  return v;
}

// 校验一个名字是否为真实地点（地理编码能解析即视为有效）。带内存缓存避免重复请求。
const _geoCache = new Map();
async function validateLocation(name) {
  const n = (name || '').trim();
  if (!n) return false;
  if (_geoCache.has(n)) return _geoCache.get(n);
  try {
    const g = await geocode(n);
    const ok = !!(g && (g.latitude != null || g.longitude != null || g.name));
    _geoCache.set(n, ok);
    return ok;
  } catch {
    _geoCache.set(n, false);
    return false;
  }
}

// 判断一段文本是否"看起来像一个地名"（用于：我们刚问过位置、用户简短回应时）。
function looksLikeLocation(text) {
  const t = String(text || '').trim();
  if (t.length > 16) return false;
  // 排除常见会误命中为地名的非地名词（如用户说"查时间""天气""东西"）
  const NON_PLACES = new Set([
    // 原有关键词
    '时间', '天气', '查时间', '查天气', '东西', '事情', '问题', '名字', '密码', '账号', '电话', '地址',
    '这边', '那边', '这里', '那里', '哪儿', '哪里',
    '你好', '谢谢', '在吗', '嗨', '早安', '晚安', '吃饭', '睡觉', '游戏', '电影', '音乐', '朋友', '家人',
    // 日常口语短语（否定 / 应答 / 招呼 / 闲聊 / 疑问 / 连词）——避免被误判为地名
    '不是', '不要', '不行', '不对', '不会', '不能', '不愿', '没空', '没用', '别闹', '别急',
    '可以', '好的', '行吧', '好吧', '是的', '对的', '没错', '对呀', '好呀', '好哒',
    '知道', '明白', '了解', '懂了', '嗯嗯', '哦哦',
    '拜拜', '再见', '干嘛', '干啥',
    '哈哈', '呵呵', '嘻嘻', '哎呀', '哎哟',
    '怎么', '什么', '为什么', '谁呀', '因为', '所以', '然后', '但是', '如果',
    // 常见英文应答
    'no', 'yes', 'ok', 'hi', 'bye', 'nah', 'nope', 'sure', 'wait', 'ya',
  ]);
  // 去掉句末语气词/标点后再比对一次，避免"不是啊""不要呀"漏网
  const base = t.replace(
    /(?:了|啦|咯|嘞|啊|呀|呢|吧|嘛|哦|哈|呐|咩|噻|~|～|！|!|。|，|、|．|\.|\?|？|…)+$/g,
    '',
  );
  if (NON_PLACES.has(t) || NON_PLACES.has(t.toLowerCase()) || NON_PLACES.has(base) || NON_PLACES.has(base.toLowerCase())) {
    return false;
  }
  // 允许结尾跟语气词/标点（"常州~""常州呀""Changzhou."），与 extractSetLocation 的容错保持一致
  if (/^[\u4e00-\u9fa5]{2,8}(市|省|县|区|旗|市辖区)?(?:~|～|！|!|。|，|、|．|\.|\?|？|呀|呢|啊|哦|哈|呐|吧|嘛|咩|…)*$/.test(t)) return true;
  if (/^[A-Za-z]{2,20}(?:~|～|！|!|。|\.|\?|？)*$/.test(t)) return true;
  return false;
}

// 用户用「不知道/不用了」等委婉拒绝提供位置 → 视为未提供，走 IP 兜底。
const DECLINE_WORDS = [
  '不知道', '不清楚', '不用了', '算了', '随便', '没有', '不想', '暂不', '稍后',
  '等下', '之后', '再说', '不告诉', '不提供', '隐私', '不用', '别问',
];
function isDecline(text) {
  const t = String(text || '').trim();
  if (t.length > 20) return true;
  return DECLINE_WORDS.some((w) => t.includes(w));
}

// 保存用户提供的位置（来源 user）。关键：把原始输入地理编码为规范行政区划并固化坐标，
// 保证位置的「唯一性 + 正确性」，而非存原始字符串（"北京"/"北京市"/"Beijing" 都能归一）。
// 返回 { location(规范标签), raw(原始输入), ambiguous(是否同名多地点), candidates }。
async function saveUserLocation(userid, location, scope) {
  const name = (location || '').trim();
  if (!name) return null;
  const cands = await geocodeCandidates(name, 5);
  if (!cands.length) {
    // 无法地理编码（地名不存在 / 离线）：仅记录原始输入，待用户纠正
    await db.setUserLocation(userid, { location: name, raw: name, source: 'user' }, scope);
    return { location: name, raw: name, ambiguous: false, candidates: [] };
  }
  // 取最相关候选（Open-Meteo 已按相关度/人口排序，首位通常最可能是用户所指）
  const top = cands[0];
  // 歧义检测：存在多个不同「省/国家」的同名地点（如「朝阳」→ 北京/辽宁；「鼓楼区」→ 多市）
  const distinct = new Set(cands.map((c) => `${c.admin1 || ''}|${c.country || ''}`));
  const ambiguous = distinct.size > 1;
  const label = buildLabel(top);
  await db.setUserLocation(userid, {
    location: label,
    raw: name,
    name: top.name,
    admin1: top.admin1 || null,
    country: top.country || null,
    countryCode: top.country_code || null,
    latitude: top.latitude,
    longitude: top.longitude,
    timezone: top.timezone || null,
    source: 'user',
  }, scope);
  return { location: label, raw: name, ambiguous, candidates: cands.slice(0, 5) };
}

// 解析一次天气/时间查询应使用的位置。返回：
//   { location, latitude, longitude, timezone, displayName, source, needAsk, askedNow }
//   - 本轮消息里明确带了城市 → 仅本次使用（不覆盖已存默认），并固化坐标。
//   - 已存位置 → 直接用固化坐标（唯一且明确）。
//   - 问过一次但用户没给 → 公网 IP 归属地兜底（内网/回环取服务端公网 IP），并落库。
//   - 从未问过 → 标记已问，返回 needAsk（由调用方追问一次）。
async function resolveForQuery(userid, clientIp, explicitLocation, signal, scope) {
  const _t0 = Date.now();
  console.log(`[resolve] 进入 userid=${userid} clientIp=${clientIp||'empty'} explicit="${explicitLocation||''}" signal=${signal?'yes':'no'} @${_t0}`);
  if (explicitLocation && explicitLocation.trim()) {
    const name = explicitLocation.trim();
    const g = await geocode(name);
    if (g) {
      return {
        location: g.name,
        latitude: g.latitude,
        longitude: g.longitude,
        timezone: g.timezone || null,
        displayName: buildLabel(g),
        source: 'text',
        needAsk: false,
        askedNow: false,
      };
    }
    // 显式城市地理编码失败：当作无效，走后续兜底
  }

  console.log(`[resolve] db.getUserLocation 调用前 @${Date.now()}`);
  const rec = await db.getUserLocation(userid, scope);
  console.log(`[resolve] db.getUserLocation 返回 rec=${rec?JSON.stringify({location:rec.location,askedAt:rec.askedAt}):'null'} 耗时=${Date.now()-_t0}ms`);
  if (rec && rec.location) {
    console.log(`[resolve] 命中已存位置分支 @${Date.now()} 耗时=${Date.now()-_t0}ms`);
    return {
      location: rec.location,
      latitude: rec.latitude ?? null,
      longitude: rec.longitude ?? null,
      timezone: rec.timezone || null,
      displayName: rec.location,
      source: rec.source || 'user',
      needAsk: false,
      askedNow: false,
    };
  }

  if (rec && rec.askedAt) {
    // 之前已问过、用户未提供 → 按公网 IP 归属地兜底
    console.log(`[resolve] 命中 askedAt 分支，即将调用 lookupIpLocation @${Date.now()}`);
    const ipLoc = await lookupIpLocation(clientIp, signal);
    console.log(`[resolve] lookupIpLocation 返回 ipLoc=${ipLoc?JSON.stringify({location:ipLoc.location,tz:ipLoc.timezone}):'null'} 耗时=${Date.now()-_t0}ms`);
    if (ipLoc && ipLoc.location) {
      await db.setUserLocation(userid, {
        location: ipLoc.location,
        raw: ipLoc.location,
        name: ipLoc.location,
        latitude: ipLoc.latitude ?? null,
        longitude: ipLoc.longitude ?? null,
        timezone: ipLoc.timezone || null,
        source: 'ip',
        askedAt: rec.askedAt,
      }, scope);
      return {
        location: ipLoc.location,
        latitude: ipLoc.latitude ?? null,
        longitude: ipLoc.longitude ?? null,
        timezone: ipLoc.timezone || null,
        displayName: ipLoc.location,
        source: 'ip',
        needAsk: false,
        askedNow: false,
      };
    }
    // IP 定位也失败：不卡死、不反复追问，用服务器本地时区作为临时兜底回答时间；
    // 天气需要坐标，这里无法兜底，返回 needAsk 让用户补充城市。
    console.warn('[location] IP lookup failed, returning fallback local timezone (no coordinates)');
    const fallbackTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return {
      location: '本地',
      latitude: null,
      longitude: null,
      timezone: fallbackTz,
      displayName: '本地（服务器时区）',
      source: 'fallback',
      needAsk: false,
      askedNow: false,
    };
  }

  // 从未问过 → 先问一次，并打上 askedAt 标记
  console.log(`[resolve] 首次询问，db.setUserLocation(askedAt) 前 @${Date.now()}`);
  await db.setUserLocation(userid, { askedAt: new Date().toISOString() }, scope);
  console.log(`[resolve] 首次询问，已写 askedAt，返回 needAsk @${Date.now()} 耗时=${Date.now()-_t0}ms`);
  return { location: null, latitude: null, longitude: null, timezone: null, displayName: null, source: null, needAsk: true, askedNow: true };
}

module.exports = {
  isPrivateOrLoopback,
  lookupIpLocation,
  extractSetLocation,
  extractMergedLocation,
  extractLeadCity,
  looksLikeLocation,
  isDecline,
  validateLocation,
  saveUserLocation,
  resolveForQuery,
  getUserLocation: (userid, scope) => db.getUserLocation(userid, scope),
};
