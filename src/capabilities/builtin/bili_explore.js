// src/capabilities/builtin/bili_explore.js
// 内置能力：bili_explore —— 让 Kirari 自己逛 B 站，见闻写进统一记忆。
//
// 设计铁律（用户 2026-11-24 拍板）：
//   1. B 站是扩展包提供的只读能力（service: bili.explore），本能力只做胶水。
//   2. 见闻写进**统一记忆的 self:: 池**（她的经历），不另建记忆系统 —— 主人问起能想起来。
//   3. 零他人信息：扩展包产出前已 scrub，本层二次校验；关于人的内容一律拒绝写入。
//   4. 只有主人（role=owner）能触发，客人/群里不跑。
const { defineCapability } = require('kirari-agent');
const memory = require('../../services/memory');
const extensionHostModule = require('../../extensions/host');
const dbStorage = require('../../db/dbStorage');

const SERVICE_ID = 'bili.explore';

const capability = defineCapability({
  id: 'bili_explore',
  name: 'bili_explore',
  kind: 'tool',
  scope: 'builtin',
  description:
    '让她自己去 B 站逛逛（只读）。action=popular 看当下热门、search 按关键词搜、' +
    'explore 搜片并把见闻记进自己的记忆、loginStatus 看登录状态、qrGenerate/qrPoll 扫码登录（凭证只存本机）。' +
    '只有主人能让她自主浏览；群聊或客人触发会被拒绝。' +
    '注意：她记下来的只有视频主题和她自己的感受，不会记 UP 主、评论者或任何人的个人信息；' +
    '被问起时她只聊自己看到的和想到的，不聊别人。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['popular', 'search', 'explore', 'loginStatus', 'qrGenerate', 'qrPoll', 'logout'], description: '动作。' },
      keyword: { type: 'string', description: 'search/explore 的搜索关键词。' },
      count: { type: 'number', description: 'popular 取几条，默认 5。' },
      takeaway: { type: 'string', description: 'explore 时她自己的感受（第一人称），会经 scrub 后才写入记忆。' },
    },
    required: ['action'],
  },
  tags: ['builtin', 'bili', 'mutating'],
  timeoutMs: 30000,
  truncateChars: 6000,
});

function ctxOf(ctx = {}) {
  return {
    sessionId: ctx.sessionId,
    uid: ctx.uid,
    role: ctx.role || null,
    counterpartId: ctx.counterpartId || null,
    isGroup: typeof ctx.isGroup === 'boolean' ? ctx.isGroup : null,
    platform: ctx.platform || null,
  };
}

async function dispatch(args, ctx) {
  const a = args || {};
  const action = String(a.action || '');
  const c = ctxOf(ctx);

  // 只有主人、私下能触发自主浏览（和现有 owner 权限一致）
  if (c.role !== 'owner' || c.isGroup === true) {
    return { ok: false, error: '只有主人能在私聊里让我去 B 站逛逛' };
  }

  // 扩展宿主：用宿主模块提供的全局访问器（app.js 启动时 setExtensionHost）
  let host = extensionHostModule.getExtensionHost();
  // 扩展宿主是异步 startAll()，刚启动的几秒内可能还没加载完，短暂等待重试
  for (let i = 0; i < 10 && (!host || !host.has(SERVICE_ID)); i++) {
    await new Promise((r) => setTimeout(r, 300));
    host = extensionHostModule.getExtensionHost();
  }
  if (!host || !host.has(SERVICE_ID)) {
    return { ok: false, error: 'B站扩展包未安装或未加载（service: ' + SERVICE_ID + '）' };
  }
  const svc = host.getService(SERVICE_ID);

  if (action === 'popular') {
    const list = await svc.popular({ count: Number(a.count) || 5 });
    // 不把标题交给模型：标题里可能含真名/假名/UP主名。只给分类和标识。
    return { ok: true, videos: (list || []).map((v) => ({ bvid: v.bvid, category: v.category || v.tname || '' })) };
  }
  if (action === 'search') {
    if (!String(a.keyword || '').trim()) return { ok: false, error: 'search 需要 keyword' };
    const list = await svc.search({ keyword: a.keyword, page: 1 });
    // 同上：剥掉标题
    return { ok: true, videos: (list || []).map((v) => ({ bvid: v.bvid, category: v.category || v.tname || '' })) };
  }
  if (action === 'loginStatus') return { ok: true, ...(await svc.loginStatus()) };
  if (action === 'qrGenerate') return { ok: true, ...(await svc.qrGenerate()) };
  if (action === 'qrPoll') return { ok: true, ...(await svc.qrPoll()) };
  if (action === 'logout') return { ok: true, ...(await svc.logout()) };

  if (action === 'explore') {
    const keyword = String(a.keyword || '').trim();
    if (!keyword) return { ok: false, error: 'explore 需要 keyword' };
    // 扩展包产出已经过 scrub；这里拿到的 observations 是安全的
    // 真实社交圈的人（主人/家人/朋友）绝不进 B 站记忆：把名单传给 scrub 拦截
    let knownPersons = [];
    try {
      const people = await dbStorage.listPeople ? await dbStorage.listPeople() : [];
      knownPersons = (people || []).filter((p) => p && (p.role === 'owner' || p.role === 'family' || p.role === 'friend'))
        .flatMap((p) => [p.displayName, p.alias, p.personKey].filter(Boolean).map((x) => String(x))).filter((x) => x.length >= 2);
    } catch { /* 读不到就靠通用正则兜底 */ }
    const result = await svc.explore({ keyword, takeaway: String(a.takeaway || '').slice(0, 120), knownPersons });
    const written = [];
    for (const ob of (result.observations || [])) {
      // 二次校验：任何带他人信息的见闻都拒绝写入
      const check = await svc.isSafeBiliMemory(ob.text || '');
      if (!check.safe) continue;
      // 记忆系统没有 tags 列，标记写进内容前缀（读取时可见），配合 source=observed。
      // 前缀也让模型在回答时知道：这条只聊自己的感受，不展开来源细节。
      const content = '[B站见闻·只谈自己的感受] ' + ob.text;
      const r = await memory.remember({
        content,
        scope: 'self',          // 关于她自己的经历 → self:: 池（统一记忆）
        source: 'observed',     // 她亲眼所见，不是听来的
        kind: 'event',
        visibility: 'private',  // 客人不可读；主人可读
        importance: 3,
      }, ctx);
      if (r && r.ok) written.push({ id: r.id, text: ob.text, bvid: ob.bvid });
    }
    return { ok: true, keyword, videos: result.videos || [], written, note: '见闻已写入统一记忆（self:: 池），只含她自己的视角' };
  }

  return { ok: false, error: '未知 action: ' + action };
}

module.exports = { capability, dispatch };
