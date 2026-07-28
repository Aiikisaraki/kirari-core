// src/tools/index.js
// 桌宠联网能力工具层：天气（Open-Meteo，免费无需密钥）、当前时间（系统时钟）、
// 联网搜索/新闻（Tavily，需用户配置的 searchKey）。
// Node 24 自带全局 fetch，无需引入新依赖。
//
// 工具以 OpenAI「function calling」规范定义，由 aiReplyService 的 tool-call loop
// 调度：模型返回 tool_calls → 本模块执行 → 结果以 role:tool 回灌模型 → 生成最终回复。

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

async function getCurrentTime({ timezone } = {}) {
  const now = new Date();
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || undefined,
      dateStyle: 'full',
      timeStyle: 'medium',
    }).format(now);
  } catch {
    formatted = now.toString();
  }
  const tzNote = timezone ? `（时区 ${timezone}）` : '（本地时区）';
  return `当前时间：${formatted} ${tzNote}`;
}

async function getWeather({ location, units = 'metric' } = {}) {
  if (!location || !location.trim()) return '缺少地点参数（location）';
  const metric = units !== 'imperial';
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=1&language=zh`,
    );
    if (!geoRes.ok) return '地理编码查询失败';
    const geo = await geoRes.json();
    const f = geo?.results?.[0];
    if (!f) return `找不到地点：${location}`;

    const wRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${f.latitude}&longitude=${f.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&timezone=auto&units=${metric ? 'metric' : 'imperial'}`,
    );
    if (!wRes.ok) return '天气查询失败';
    const w = await wRes.json();
    const cur = w?.current;
    if (!cur) return '天气数据缺失';

    const place = `${f.name}${f.country ? `（${f.country}）` : ''}`;
    const unit = metric ? '°C' : '°F';
    return `【${place}】${weatherText(cur.weather_code)}；` +
      `气温 ${cur.temperature_2m}${unit}（体感 ${cur.apparent_temperature}${unit}）；` +
      `湿度 ${cur.relative_humidity_2m}%；风速 ${cur.wind_speed_10m} km/h。` +
      `观测时间：${cur.time}`;
  } catch (e) {
    return `天气查询出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function webSearch({ query, topic = 'general' } = {}, searchKey) {
  if (!searchKey) return '未配置搜索 API Key，无法联网搜索。请在「设置」中填写 Tavily Key。';
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
    return `${answer}搜索结果：\n${items || '（无结果）'}`;
  } catch (e) {
    return `搜索出错：${e instanceof Error ? e.message : String(e)}`;
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
      description: '联网搜索实时信息、新闻或资料。当用户问最新新闻、实时股价、模糊事实、或天气/时间之外的实时信息时，优先使用。',
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
];

// 执行工具。ctx.searchKey 为可选的 Tavily Key。
async function runTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'get_current_time':
      return await getCurrentTime(args);
    case 'get_weather':
      return await getWeather(args);
    case 'web_search':
      return await webSearch(args, ctx?.searchKey);
    default:
      return `未知工具：${name}`;
  }
}

module.exports = { TOOL_DEFS, runTool };
