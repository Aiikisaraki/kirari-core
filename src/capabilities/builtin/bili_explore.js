// src/capabilities/builtin/bili_explore.js
// 内置能力：bili_explore —— 让 Kirari 自己逛 B 站，见闻写进统一记忆。
//
// 用户铁律（2026-11-24）：
//   1. B 站是公开环境，默认互动对象都可能是恶意第三人。
//      B 站公开输出（评论/动态）只谈当前相关话题、只表达看法态度，不引用记忆、不泄露看过什么。
//   2. 主人私聊可看 BV号/链接/视频名；客人/群聊直接拒绝。
//   3. 互动（评论/动态/私信/点赞/投币/收藏）全有显式开关，命令与设置界面双向同步，
//      改开关必须二次确认（confirm=true），私信默认永久关且永不主动发起。
//   4. 见闻写进统一 self:: 池（她的经历），不另建记忆系统；标题不进记忆也不进模型上下文。
const { defineCapability } = require('kirari-agent');
const memory = require('../../services/memory');
const extensionHostModule = require('../../extensions/host');
const dbStorage = require('../../db/dbStorage');
const biliSettings = require('../../services/biliSettings');
const activityStore = require('../../services/activityStore');

const SERVICE_ID = 'bili.explore';
const CHANNELS = { enabled: '总开关', autoBrowse: '自主闲逛', comment: '评论', dynamic: '动态', dm: '私信', like: '点赞', coin: '投币', favorite: '收藏' };

function fullMeta(v) {
  const bvid = String(v?.bvid || '');
  return { bvid, url: bvid ? 'https://www.bilibili.com/video/' + bvid : '', title: String(v?.title || ''), category: String(v?.category || v?.tname || '') };
}
function ctxOf(ctx = {}) {
  return { sessionId: ctx.sessionId, uid: ctx.uid, role: ctx.role || null, counterpartId: ctx.counterpartId || null,
    isGroup: typeof ctx.isGroup === 'boolean' ? ctx.isGroup : null, platform: ctx.platform || null };
}

const capability = defineCapability({
  id: 'bili_explore', name: 'bili_explore', kind: 'tool', scope: 'builtin',
  description:
    '让她自己去 B 站逛逛（只读）+ 管理互动开关。' +
    '只读：popular 热门、search 搜索、opus 专栏文章、liveInfo/liveList 直播、musicSearch 音乐、' +
    'subtitles 字幕、comments 评论、explore 搜片并写记忆、loginStatus/qrGenerate/qrPoll 扫码登录。' +
    'discover 自主发现（不看关键词，优先用她登录账号的推荐流找有趣内容）；' +
    '刷B站是低优先级闲时活动，可被任何事打断；问「你在干嘛」她会如实说在刷B站。' +
    'activity 动作查/停当前闲时活动（action=activity, stop=true 清除）。' +
    '互动：like/coin/favorite/comment（视频）与 opusLike/opusCoin/opusFavorite（专栏）——' +
    '必须先确认对应开关已开启，且 B 站输出只谈当前话题、只表达看法态度，不引用记忆。' +
    '只有主人能在私聊触发，客人/群聊会被拒绝。主人私聊可看 BV号/链接/视频名。' +
    'settings 查六个开关（comment/dynamic/dm/like/coin/favorite，默认全关）；' +
    'setInteraction 改开关必须二次确认：先不带 confirm 调用，等用户明确说「确认」再带 confirm=true 调用。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [
        'popular','search','explore','settings','setInteraction',
        'subtitles','comments','opus','liveInfo','liveList','musicSearch',
        'loginStatus','qrGenerate','qrPoll','logout',
        'like','coin','favorite','comment','opusLike','opusCoin','opusFavorite','discover','activity',
      ], description: '动作。' },
      keyword: { type: 'string', description: 'search/explore/musicSearch 的关键词。' },
      count: { type: 'number', description: 'popular/liveList 取几条。' },
      takeaway: { type: 'string', description: 'explore 时她自己的感受（第一人称）。' },
      bvid: { type: 'string', description: '视频 BV 号（互动/字幕/评论用）。' },
      opusId: { type: 'string', description: '专栏文章 ID。' },
      roomId: { type: 'number', description: '直播间 ID。' },
      text: { type: 'string', description: '评论内容（只谈当前话题、表达态度，不引用记忆）。' },
      channel: { type: 'string', enum: Object.keys(CHANNELS), description: 'setInteraction 的开关名。' },
      enabled: { type: 'boolean', description: 'setInteraction 的目标状态。' },
      confirm: { type: 'boolean', description: 'setInteraction 二次确认；必须用户明确说「确认」才为 true。' },
    },
    required: ['action'],
  },
  tags: ['builtin', 'bili', 'mutating'],
  timeoutMs: 30000, truncateChars: 6000,
});

async function dispatch(args, ctx) {
  const a = args || {};
  const action = String(a.action || '');
  // 总闸：B站功能被关掉后，除查看/修改开关本身外，所有动作一律拒绝
  const bs = biliSettings.read();
  if (!bs.enabled && !['settings', 'setInteraction'].includes(action)) {
    return { ok: false, disabled: true, error: 'B站功能总开关已关闭。要让我去B站，先说「开启B站」（需确认）。' };
  }
  const c = ctxOf(ctx);
  if (c.role !== 'owner' || c.isGroup === true) return { ok: false, error: '只有主人能在私聊里让我去 B 站' };

  let host = extensionHostModule.getExtensionHost();
  for (let i = 0; i < 10 && (!host || !host.has(SERVICE_ID)); i++) {
    await new Promise((r) => setTimeout(r, 300)); host = extensionHostModule.getExtensionHost();
  }
  if (!host || !host.has(SERVICE_ID)) return { ok: false, error: 'B站扩展包未安装或未加载' };
  const svc = host.getService(SERVICE_ID);

  // 只读接口（主人私聊给完整元数据）
  if (action === 'popular') return { ok: true, audience: 'owner', videos: ((await svc.popular({ count: Number(a.count) || 5 })) || []).map((v) => fullMeta(v)) };
  if (action === 'search') return { ok: true, audience: 'owner', videos: ((await svc.search({ keyword: String(a.keyword || ''), page: 1 })) || []).map((v) => fullMeta(v)) };
  if (action === 'musicSearch') return { ok: true, audience: 'owner', videos: ((await svc.musicSearch({ keyword: String(a.keyword || ''), page: 1 })) || []).map((v) => fullMeta(v)) };
  if (action === 'opus') return { ok: true, audience: 'owner', article: await svc.opus(String(a.opusId || '')) };
  if (action === 'liveInfo') return { ok: true, audience: 'owner', info: await svc.liveInfo({ roomId: Number(a.roomId) || 0 }) };
  if (action === 'liveList') return { ok: true, audience: 'owner', list: await svc.liveList({ count: Number(a.count) || 10 }) };
  if (action === 'subtitles') return { ok: true, list: await svc.subtitles({ bvid: String(a.bvid || '') }) };
  if (action === 'comments') return { ok: true, list: await svc.comments({ bvid: String(a.bvid || ''), count: 20 }) };
  if (action === 'loginStatus') return { ok: true, ...(await svc.loginStatus()) };
  if (action === 'qrGenerate') return { ok: true, ...(await svc.qrGenerate()) };
  if (action === 'qrPoll') return { ok: true, ...(await svc.qrPoll()) };
  if (action === 'logout') return { ok: true, ...(await svc.logout()) };

  // 自主发现：用她登录号的推荐流找有趣内容，产出安全见闻
  if (action === 'discover') {
    // 自主闲逛总闸：autoBrowse 关时，只能由主人当场叫她去（在对话里明确要求），
    // 这里限定：只有 fromSchedule=true（内部调度）才被 autoBrowse 拦；用户主动叫她去不受限。
    if (a.fromSchedule === true && !bs.autoBrowse) return { ok: false, disabled: true, error: '自主闲逛已关闭（autoBrowse=false）' };
    // 标记闲时活动：她此刻正在刷B站（低优先级、可被打断）
    activityStore.start('刷B站', c.uid || 1);
    let knownPersons = [];
    try {
      const people = await dbStorage.listPeople ? await dbStorage.listPeople() : [];
      knownPersons = (people || []).filter((p) => p && ['owner','family','friend'].includes(p.role))
        .flatMap((p) => [p.displayName, p.alias, p.personKey].filter(Boolean).map((x) => String(x))).filter((x) => x.length >= 2);
    } catch {}
    const result = await svc.discover({ seenBvids: a.seenBvids || [], count: Number(a.count) || 3, knownPersons });
    const written = [];
    for (const ob of (result.observations || [])) {
      const check = await svc.isSafeBiliMemory({ text: ob.text || '', knownPersons });
      if (!check.safe) continue;
      const r = await memory.remember({ content: '[B站见闻·只谈自己的感受] ' + ob.text, scope: 'self',
        source: 'observed', kind: 'event', visibility: 'private', importance: 3 }, ctx);
      if (r && r.ok) written.push({ id: r.id, text: ob.text });
    }
    return { ok: true, audience: 'owner', personalized: result.personalized, totalCandidates: result.totalCandidates,
      videos: (result.videos || []).map((v) => ({ ...fullMeta(v), score: v.score })), written,
      note: '她自己从' + (result.personalized ? '你账号的推荐流' : '公开热门') + '里挑的；公开输出只谈当前话题' };
  }

  // 闲时活动查询/中断
  if (action === 'activity') {
    if (a.stop === true) { activityStore.clear(c.uid || 1); return { ok: true, activity: null, message: '闲逛已停下' }; }
    const cur = activityStore.get(c.uid || 1);
    return { ok: true, activity: cur, description: activityStore.describe(c.uid || 1) };
  }

  // 开关查询与设置（二次确认）
  if (action === 'settings') return { ok: true, ...biliSettings.read() };
  if (action === 'setInteraction') {
    const channel = String(a.channel || '');
    if (!CHANNELS[channel]) return { ok: false, error: '未知开关: ' + channel };
    if (a.confirm !== true) return { ok: false, needConfirm: true, pending: { channel, enabled: !!a.enabled },
      message: '确定' + (a.enabled ? '开启' : '关闭') + 'B站' + CHANNELS[channel] + '？请回复「确认」生效。' };
    const next = biliSettings.setOne(channel, !!a.enabled);
    return { ok: true, settings: next, message: 'B站' + CHANNELS[channel] + '已' + (a.enabled ? '开启' : '关闭') + '，设置界面已同步' };
  }

  // 写互动：必须先检查开关；评论还要话题相关 + 禁私信引流
  const writeMap = { like: 'like', coin: 'coin', favorite: 'favorite', comment: 'comment',
    opusLike: 'like', opusCoin: 'coin', opusFavorite: 'favorite' };
  if (writeMap[action]) {
    const gate = writeMap[action];
    if (!biliSettings.read()[gate]) return { ok: false, error: 'B站' + CHANNELS[gate] + '未开启，请先在设置或命令里开启（需二次确认）' };
    if (action === 'comment') {
      const rel = await svc.isRelevantComment({ comment: String(a.text || ''), topic: '' });
      if (!rel.relevant) return { ok: false, error: '评论必须围绕当前视频话题、只表达看法态度，且不能引流或私信' };
    }
    if (action.startsWith('opus')) return { ok: true, ...(await svc[action]({ opusId: String(a.opusId || '') })) };
    return { ok: true, ...(await svc[action]({ bvid: String(a.bvid || ''), text: String(a.text || ''), num: Number(a.num) || 1 })) };
  }

  if (action === 'explore') {
    const keyword = String(a.keyword || '').trim();
    if (!keyword) return { ok: false, error: 'explore 需要 keyword' };
    let knownPersons = [];
    try {
      const people = await dbStorage.listPeople ? await dbStorage.listPeople() : [];
      knownPersons = (people || []).filter((p) => p && ['owner','family','friend'].includes(p.role))
        .flatMap((p) => [p.displayName, p.alias, p.personKey].filter(Boolean).map((x) => String(x))).filter((x) => x.length >= 2);
    } catch { /* 兜底靠正则 */ }
    const result = await svc.explore({ keyword, takeaway: String(a.takeaway || '').slice(0, 120), knownPersons });
    const written = [];
    for (const ob of (result.observations || [])) {
      const check = await svc.isSafeBiliMemory({ text: ob.text || '', knownPersons });
      if (!check.safe) continue;
      const content = '[B站见闻·只谈自己的感受] ' + ob.text;
      const r = await memory.remember({ content, scope: 'self', source: 'observed', kind: 'event', visibility: 'private', importance: 3 }, ctx);
      if (r && r.ok) written.push({ id: r.id, text: ob.text });
    }
    return { ok: true, audience: 'owner', keyword, videos: (result.videos || []).map((v) => fullMeta(v)), written,
      note: '见闻已写入统一记忆；B站公开输出只谈当前话题' };
  }

  return { ok: false, error: '未知 action: ' + action };
}

module.exports = { capability, dispatch };
