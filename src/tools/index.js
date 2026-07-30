// src/tools/index.js
// 桌宠联网能力工具层：天气（Open-Meteo，免费无需密钥）、当前时间（系统时钟）、
// 联网搜索/新闻（多 provider：内置 uapis.cn 免 key 默认源 + 可选 Tavily/SearXNG）。
// Node 24 自带全局 fetch，无需引入新依赖。
//
// 工具以 OpenAI「function calling」规范定义，由 aiReplyService 的 tool-call loop
// 调度：模型返回 tool_calls → 本模块执行 → 结果以 role:tool 回灌模型 → 生成最终回复。
//
// 搜索 provider 路由（webSearch dispatcher 内，由设置界面的 searchProvider 决定）：
//   - searchProvider='searxng' → 用 searchEndpoint（自建，keyless）
//   - searchProvider='tavily'  → 用 searchKey（用户配置的 key）
//   - searchProvider='uapis'(默认) → 用 searchKey 作可选 UAPI 令牌，无则匿名免 key

// WMO 天气代码 → 中文描述（精简版）
const WMO = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛雨', 53: '毛雨', 55: '大毛雨',
  56: '冻毛雨', 57: '强冻毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

function weatherText(code) {
  return (code in WMO) ? WMO[code] : '未知天气';
}

const ADMIN_SUFFIXES = ['市辖区', '市', '省', '县', '区', '旗'];

// Open-Meteo 对中文地名的匹配比较挑剔：
//   - "北京"/"上海" 裸名可命中，但"北京市"/"广州市"/"深圳市" 带后缀反而失败；
//   - "常州" 裸名失败，必须带"常州市"才命中。
// 因此对原始地名生成若干等价变体（带/不带常见行政区划后缀）逐个尝试，提高命中率。
function buildNameVariants(name) {
  const n = (name || '').trim();
  if (!n) return [];
  const variants = [n];
  const hasSuffix = ADMIN_SUFFIXES.some((s) => n.endsWith(s));
  if (hasSuffix) {
    for (const s of ADMIN_SUFFIXES) {
      if (n.endsWith(s)) {
        const stripped = n.slice(0, -s.length).trim();
        if (stripped && stripped.length >= 2) variants.push(stripped);
        break;
      }
    }
  } else {
    variants.push(n + '市');
  }
  return [...new Set(variants)];
}

async function geocodeApi(name, count = 5) {
  if (!name || !name.trim()) return [];
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.trim())}&count=${count}&language=zh`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return [];
  }
}

// 合并所有地名变体的候选结果，按人口降序排列后返回前 count 个。
// 人口大的城市（如上海、北京）通常就是用户所指，避免"上海市"命中到美国伊利诺伊州的同名小地方。
async function resolveBestCandidates(name, count = 5) {
  const variants = buildNameVariants(name);
  const all = [];
  const seen = new Set();
  for (const variant of variants) {
    const results = await geocodeApi(variant, count);
    for (const r of results) {
      const key = `${r.name}|${r.admin1 || ''}|${r.country || ''}|${r.latitude}|${r.longitude}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(r);
    }
  }
  all.sort((a, b) => (b.population || 0) - (a.population || 0));
  return all.slice(0, count);
}

// 地理编码：把地名解析为经纬度/时区（Open-Meteo，免费无需密钥）。找不到返回 null。
async function geocode(name) {
  const cands = await resolveBestCandidates(name, 1);
  return cands[0] || null;
}

// 地理编码（多候选）：返回前 count 个候选（用于行政区划歧义检测）。无结果返回 []。
async function geocodeCandidates(name, count = 5) {
  return await resolveBestCandidates(name, count);
}

async function getCurrentTime({ timezone } = {}) {
  const now = new Date();
  let dateStr = '';
  let timeStr = '';
  let hourInTz = now.getHours();
  try {
    dateStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || undefined,
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(now);
    timeStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || undefined,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
    const hourStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || undefined,
      hour: 'numeric', hour12: false,
    }).format(now);
    hourInTz = parseInt(hourStr, 10);
  } catch {
    dateStr = now.toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
  }

  let period = '凌晨';
  if (hourInTz >= 6 && hourInTz < 9) period = '早上';
  else if (hourInTz >= 9 && hourInTz < 12) period = '上午';
  else if (hourInTz >= 12 && hourInTz < 14) period = '中午';
  else if (hourInTz >= 14 && hourInTz < 18) period = '下午';
  else if (hourInTz >= 18 && hourInTz < 24) period = '晚上';

  return `现在${timezone ? '' : '本地'}时间是 ${dateStr} ${period}${timeStr}`;
}

async function getWeather({ location, latitude, longitude, displayName, units = 'metric' } = {}) {
  const metric = units !== 'imperial';
  try {
    // 优先使用已解析的坐标（由位置服务固化，唯一且明确，避免重复地理编码与歧义）
    let lat = latitude != null ? Number(latitude) : null;
    let lon = longitude != null ? Number(longitude) : null;
    let place = displayName || location || '';
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
      if (!location || !location.trim()) return '缺少地点参数（location）';
      const f = await geocode(location);
      if (!f) return `找不到地点：${location}`;
      lat = f.latitude;
      lon = f.longitude;
      place = `${f.name}${f.country ? `（${f.country}）` : ''}`;
    }

    const wRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&timezone=auto&units=${metric ? 'metric' : 'imperial'}`,
    );
    if (!wRes.ok) return '天气查询失败';
    const w = await wRes.json();
    const cur = w?.current;
    if (!cur) return '天气数据缺失';

    const unit = metric ? '°C' : '°F';
    // 用自然短句组织事实，不输出 ISO 观测时间、不用方括号/分号等机器感符号；
    // 最终口语化润色交给 LLM，但原始数据要先像人话。
    return `${place}现在${weatherText(cur.weather_code)}，` +
      `气温 ${cur.temperature_2m}${unit}（体感 ${cur.apparent_temperature}${unit}），` +
      `相对湿度 ${cur.relative_humidity_2m}%，风速 ${cur.wind_speed_10m} km/h。`;
  } catch (e) {
    return `天气查询出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

const UAPIS_ENDPOINT = 'https://uapis.cn/api/v1/search/aggregate';

// 默认源：uapis.cn 聚合搜索，免 key、零部署；可选传入令牌（searchKey）以提升额度。
// 返回 results[].{title,url,snippet,score}
async function uapiSearch({ query, topic = 'general' } = {}, searchKey) {
  if (!query || !query.trim()) return '缺少搜索关键词（query）';
  const body = { query: query.trim(), limit: 5 };
  if (topic === 'news') body.time_range = 'week'; // 新闻偏向近期
  const doFetch = (authKey) => {
    const headers = { 'content-type': 'application/json' };
    // UAPI 令牌（访问令牌）按 Bearer 传入；文档未明确 header 名，此为最常用约定。
    // 若平台使用其他头（如 x-api-key），按实际调整此行即可，不影响匿名路径。
    if (authKey) headers['Authorization'] = `Bearer ${authKey}`;
    return fetch(UAPIS_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  };
  try {
    let res = await doFetch(searchKey);
    // 带了令牌却被拒（401），多半是头格式不对或令牌无效 —— 降级匿名重试，保证联网能力不中断
    if (res.status === 401 && searchKey) res = await doFetch(null);
    if (!res.ok) return `搜索失败（HTTP ${res.status}）`;
    const data = await res.json();
    const items = (data?.results || []).slice(0, 5)
      .map((r) => `- ${r.title}：${r.snippet}\n  ${r.url}`)
      .join('\n');
    return `搜索结果：\n${items || '（无结果）'}`;
  } catch (e) {
    return `搜索出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

// 可选源：Tavily（用户填 key 时使用）
async function tavilySearch({ query, topic = 'general' } = {}, searchKey) {
  if (!searchKey) return '未配置 Tavily Key，无法使用该搜索源。';
  if (!query || !query.trim()) return '缺少搜索关键词（query）';
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: searchKey,
        query: query.trim(),
        topic: topic === 'news' ? 'news' : 'general',
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      }),
    });
    if (!res.ok) return `搜索失败（HTTP ${res.status}）`;
    const data = await res.json();
    const answer = data?.answer ? `摘要：${data.answer}\n` : '';
    const items = (data?.results || [])
      .map((r) => `- ${r.title}：${r.content}`)
      .join('\n');
    const imgs = (data?.images || [])
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
      .slice(0, 3)
      .map((u) => `![相关图片](${u})`)
      .join('\n');
    return `${answer}搜索结果：\n${items || '（无结果）'}${imgs ? '\n\n' + imgs : ''}`;
  } catch (e) {
    return `搜索出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

// 可选源：SearXNG（用户自建实例，keyless，需填 endpoint）
async function searxngSearch({ query, topic = 'general' } = {}, endpoint) {
  if (!endpoint) return '未配置 SearXNG 地址，无法使用该搜索源。';
  if (!query || !query.trim()) return '缺少搜索关键词（query）';
  try {
    const u = new URL('/search', endpoint);
    u.searchParams.set('q', query.trim());
    u.searchParams.set('format', 'json');
    if (topic === 'news') u.searchParams.set('categories', 'news');
    const res = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!res.ok) return `搜索失败（HTTP ${res.status}）`;
    const data = await res.json();
    const items = (data?.results || []).slice(0, 5)
      .map((r) => `- ${r.title}：${r.content}\n  ${r.url}`)
      .join('\n');
    const imgs = (data?.results || [])
      .map((r) => r.img_src || r.thumbnail)
      .filter(Boolean)
      .slice(0, 3)
      .map((u) => `![相关图片](${u})`)
      .join('\n');
    return `搜索结果：\n${items || '（无结果）'}${imgs ? '\n\n' + imgs : ''}`;
  } catch (e) {
    return `搜索出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

// dispatcher：按 ctx.searchProvider 选择搜索源（设置界面用户可选）。
//   - 'searxng'      → 用 searchEndpoint（用户自建，keyless，必填地址）
//   - 'tavily'       → 用 searchKey（用户配置的 key，必填）
//   - 'uapis'（默认）→ 用 searchKey 作为可选 UAPI 令牌（无则匿名免 key）
//   - 未设 provider（旧数据兼容）→ 回退原优先级：searchEndpoint > searchKey > uapis
async function webSearch(args = {}, ctx = {}) {
  const provider = (ctx?.searchProvider || '').toLowerCase();
  if (provider === 'searxng') {
    return ctx?.searchEndpoint
      ? await searxngSearch(args, ctx.searchEndpoint)
      : '未配置 SearXNG 地址，无法使用自建搜索。请在设置里填写地址，或把搜索提供商改回「UAPI（默认）」。';
  }
  if (provider === 'tavily') {
    return ctx?.searchKey
      ? await tavilySearch(args, ctx.searchKey)
      : '未配置 Tavily Key，无法使用 Tavily 搜索。请在设置里填写 Key，或把搜索提供商改回「UAPI（默认）」。';
  }
  if (provider === 'uapis' || provider === '') {
    return await uapiSearch(args, ctx?.searchKey);
  }
  // 未知 provider 兜底
  if (ctx?.searchEndpoint) return await searxngSearch(args, ctx.searchEndpoint);
  if (ctx?.searchKey) return await tavilySearch(args, ctx.searchKey);
  return await uapiSearch(args);
}

// AI 生图工具：调用 OpenAI 兼容图像生成接口（复用用户配置的模型 Key 与 endpoint），
// 以 markdown 图片语法返回，由 aiReplyService 的 parseModelReply 提取到 images 字段统一渲染。
async function generateImage({ prompt, size = '1024x1024' } = {}, ctx = {}) {
  if (!prompt || !prompt.trim()) return '缺少图片描述（prompt）';
  const openai = ctx?.openai;
  if (!openai || !openai.images || typeof openai.images.generate !== 'function') {
    return '当前模型服务不支持图像生成（openai.images.generate 不可用）。';
  }
  try {
    const res = await openai.images.generate({
      model: ctx?.imageModel || 'dall-e-3',
      prompt: prompt.trim(),
      size,
      response_format: 'b64_json',
      n: 1,
    });
    const b64 = res?.data?.[0]?.b64_json;
    if (!b64) return '图片生成失败：未返回图像数据。';
    const url = `data:image/png;base64,${b64}`;
    return `已为你生成图片：![生成图](${url})`;
  } catch (e) {
    return `图片生成失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期和时间。当用户问“现在几点”“今天几号”“现在是什么时间”等时使用。',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA 时区名，如 Asia/Shanghai、America/New_York；留空则用系统本地时区。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定地点的实时天气（温度、体感、湿度、风速、天气状况）。当用户问天气时使用。',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: '城市或地点名，如 北京、上海、Tokyo。' },
          units: { type: 'string', enum: ['metric', 'imperial'], description: 'metric=摄氏度，imperial=华氏度。默认 metric。' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息、新闻或资料（默认使用内置免费搜索，用户也可在设置里改用 SearXNG/Tavily）。当用户问最新新闻、实时股价、模糊事实、或天气/时间之外的实时信息时，优先使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或问题。' },
          topic: { type: 'string', enum: ['general', 'news'], description: 'general=综合搜索，news=新闻。默认 general。' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: '根据文字描述生成一张图片（需要模型服务支持图像生成接口）。当用户要求“画一张图”“生成图片”“画个xx”“帮我画”等时使用。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片的文字描述，尽量具体。' },
          size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], description: '图片尺寸，默认 1024x1024。' },
        },
        required: ['prompt'],
      },
    },
  },
];

// 执行工具。ctx 含 searchProvider / searchKey / searchEndpoint，由 dispatcher 按 provider 路由。
async function runTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'get_current_time':
      return await getCurrentTime(args);
    case 'get_weather':
      return await getWeather(args);
    case 'web_search':
      return await webSearch(args, ctx);
    case 'generate_image':
      return await generateImage(args, ctx);
    default:
      return `未知工具：${name}`;
  }
}

module.exports = { TOOL_DEFS, runTool, geocode, geocodeCandidates };
