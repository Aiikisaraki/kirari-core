// scripts/smoke-prompt-voice.js
// 分层提示词 + 说话欲望的回归测试（纯逻辑，不连数据库、不调模型）。
//
// 背景（2026-11-25 用户反馈）：
//   「是不是现在又太高冷了，态度和语气有点捉摸不清。另外我给的自定义性格提示词的权重
//     是不是下降了。我想好好平衡一下系统提示词和自定义提示词里的权重。」
//
// 那次改造把提示词拆成四层（身份 / 声音 / 状态 / 安全），并删掉了一串硬禁令：
//   「闲聊 1~3 句、不超过 50 字」「不要反问」「最后一句不许是结论」。
// 这份测试钉死的就是这几件事——因为**最容易的退化方式就是把硬上限再加回来**：
// 加了以后抱怨声会立刻消失，人也立刻变冷，而且要过好几天才有人发现。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const persona = require(path.join(ROOT, 'src/services/reply/persona'));
const style = require(path.join(ROOT, 'src/services/reply/style'));
const desire = require(path.join(ROOT, 'src/services/reply/speakingDesire'));
const promptBuilder = require(path.join(ROOT, 'src/services/reply/promptBuilder'));
const sceneContext = require(path.join(ROOT, 'src/services/reply/sceneContext'));
const presenceEngine = require(path.join(ROOT, 'src/services/presence/presenceEngine'));

let checks = 0;
let failures = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); }
function check(name, cond, detail) {
  checks += 1;
  if (cond) console.log('  \u2713 ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures += 1; console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. 默认人格 ─────────────────────────────────────────────────────────
section('默认人格：有性子、不肉麻');
const P = persona.DEFAULT_PERSONA;
check('包含名字', P.indexOf('Kirari') >= 0);
check('写到了性格，不只有外形', P.indexOf('好奇心') >= 0 || P.indexOf('自己主意') >= 0);
check('允许话多话少随心情浮动', P.indexOf('话多话少') >= 0 && P.indexOf('多讲') >= 0);
check('明确不收撒娇腔/不堆甜腻称呼（防肉麻闸门）', P.indexOf('不撒娇腔') >= 0 || P.indexOf('不堆甜腻') >= 0);
for (const word of ['活泼软萌', '可爱', '亲爱的', '宝贝', '喵', '撒娇嘛']) {
  check('不含肉麻词「' + word + '」', P.indexOf(word) < 0);
}
check('「主人」只作为权限称号出现', P.indexOf('带权限含义') >= 0);
check('没有把「主人」写成默认昵称', !/直接叫|称呼主人为/.test(P));

// ── 2. 自定义人格的包裹与截断 ───────────────────────────────────────────
section('自定义人格：包成身份层 + 优先级声明');
const custom = '你叫小满，说话有点冲，但对熟人黏。';
const blk = persona.buildPersonaBlock(custom);
check('以【身份 · 你是谁】开头', blk.indexOf('【身份 · 你是谁】') === 0);
check('标明是主人亲手写的', blk.indexOf('主人亲手写的设定') >= 0);
check('带优先级声明（冲突时以人格为准）', blk.indexOf('以它为准') >= 0);
check('声明里给安全底线留了口子', blk.indexOf('根本准则') >= 0);
check('正文原样保留', blk.indexOf(custom) >= 0);
check('上限常量是 20000', persona.PERSONA_MAX_CHARS === 20000);

// ── 3. 返场提醒 ────────────────────────────────────────────────────────
section('返场提醒：结尾把口吻拉回人格');
const echo = persona.buildPersonaEcho(custom);
check('有标题', echo.indexOf('【返场提醒') === 0);
check('指向开头的「身份」', echo.indexOf('身份') >= 0);
check('说清状态只调语气', echo.indexOf('语气') >= 0);
check('堵住「中性助手」', echo.indexOf('中性') >= 0);
check('自定义人格时强调优先于语气规则', echo.indexOf('优先于') >= 0);

// ── 4. 声音层：倾向，不是禁令 ───────────────────────────────────────────
section('声音层：允许多说、允许追问');
const styleText = style.CONVERSATIONAL_RULES;
check('明确写「是倾向，不是禁令」', styleText.indexOf('倾向') >= 0);
check('允许碰到感兴趣的展开讲', styleText.indexOf('展开讲') >= 0);
check('允许分多条短消息（配合气泡拆分）', styleText.indexOf('几条短消息') >= 0);
check('允许主动追问', styleText.indexOf('想追问就追问') >= 0);
check('保留去 AI 味黑名单', styleText.indexOf('客服') >= 0 || styleText.indexOf('三段式') >= 0);
check('不再写字数上限', !/不超过\s*\d+\s*字|字以内|\d+~\d+ 句/.test(styleText));
check('不再禁反问', styleText.indexOf('不要反问') < 0);
check('不再用「最后一句不许」这种绝对禁令', styleText.indexOf('不许是结论') < 0);

// ── 5. 说话欲望的档位 ───────────────────────────────────────────────────
section('说话欲望：五个信号算档位');
const base = { energy: 0.6, mood: { emotion: 'content', intensity: 0.4 }, drives: { connect: 0.4, share: 0.35 } };
const dullTurn = desire.computeSpeakingDesire(Object.assign({}, base, { text: '嗯' }));
const livelyTurn = desire.computeSpeakingDesire(Object.assign({}, base, {
  energy: 0.9,
  mood: { emotion: 'excited', intensity: 0.8 },
  drives: { connect: 0.7, share: 0.6 },
  text: '你为什么总是这个点还不睡啊，是不是又在赶那个东西',
  knowledge: { memHit: true },
}));
check('一句「嗯」→ 低档位', dullTurn.score < livelyTurn.score, dullTurn.level + ' < ' + livelyTurn.level);
check('兴奋 + 问得认真 + 有底 → 高档位', livelyTurn.level === 'eager' || livelyTurn.level === 'engaged', String(livelyTurn.score));
check('档位落在四档之内', ['eager', 'engaged', 'steady', 'brief'].indexOf(dullTurn.level) >= 0);
const tired = desire.computeSpeakingDesire(Object.assign({}, base, { energy: 0.15, mood: { emotion: 'tired', intensity: 0.8 }, text: '你为什么总是这个点还不睡啊' }));
check('深夜 + 累 → 不高于平常', ['brief', 'steady'].indexOf(tired.level) >= 0, String(tired.score));
const group = desire.computeSpeakingDesire(Object.assign({}, livelyTurn, { isGroup: true }));
check('群聊里收敛一档', group.level !== 'eager', group.level);
check('知识命中会加底气', desire.knowledgeScore({ kbHit: true }) > desire.knowledgeScore({}));
check('分数恒在 0~1', [dullTurn, livelyTurn, tired, group].every((d) => d.score >= 0 && d.score <= 1));
check('空输入不炸', (() => { try { return !!desire.computeSpeakingDesire(); } catch (e) { return false; } })());

// ── 6. 说话欲望的提示块 ────────────────────────────────────────────────
section('说话欲望提示块：只给倾向');
const blockText = desire.buildDesireBlock(livelyTurn);
check('有标题且带档位名', blockText.indexOf('此刻的说话欲望') >= 0);
check('不写字数上限', blockText.indexOf('不超过') < 0 && blockText.indexOf('字以内') < 0);
check('明确「是倾向不是上限」', blockText.indexOf('不是上限') >= 0);
check('堵住「拿简短当冷淡」', blockText.indexOf('没有温度') >= 0);
check('空输入返回空串', desire.buildDesireBlock(null) === '');

// ── 7. 整段基座拼装顺序 ────────────────────────────────────────────────
section('基座顺序：身份 → 声音 → 事实 → 契约');
const built = promptBuilder.buildBasePrompt(null);
check('身份层在最前', built.indexOf('【身份') === 0);
check('声音层在身份之后、事实之前',
  built.indexOf('【说话方式') > built.indexOf('【身份') &&
  built.indexOf('【说话方式') < built.indexOf('在回答涉及具体事实的问题时'));
check('事实约束在声音层之后', built.indexOf('在回答涉及具体事实的问题时') > built.indexOf('【说话方式'));
check('JSON 契约在最后', built.lastIndexOf('请只输出一个 JSON 对象') > built.indexOf('在回答涉及具体事实的问题时'));
check('基座里不再有旧的硬上限', built.indexOf('不超过 50 字') < 0 && built.indexOf('不要反问') < 0);
const customBuilt = promptBuilder.buildBasePrompt(custom);
check('自定义人格走同一个基座', customBuilt.indexOf(custom) >= 0 && customBuilt.indexOf('【说话方式') >= 0);

// ── 8. 场合层与在场感：不再把长度压死 ──────────────────────────────────
section('场合层与在场感：不再压长度');
const sceneText = sceneContext.buildSceneContext({ isOwner: true });
check('场合层不再写「短一点更像真人」', sceneText.indexOf('短一点更像真人') < 0);
check('场合层改成「长短看有没有得说」', sceneText.indexOf('长短看有没有得说') >= 0);
check('反问从「不要每句」改成「别每句」', sceneText.indexOf('不要每句都用反问') < 0);

const deepNight = { version: 1, mood: { emotion: 'tired', intensity: 0.8, at: Date.now(), reason: '累' }, drives: { connect: 0.4, care: 0.3, play: 0.3, learn: 0.3, share: 0.3, create: 0.2, rest: 0.5 }, lastUserAt: Date.now() - 3600000, lastSelfAt: 0, pending: [], outreachToday: 0 };
const nightAt = new Date(2026, 10, 25, 3, 0, 0).getTime();
const pace = presenceEngine.buildPaceBlock(deepNight, nightAt);
check('深夜的节奏块不再写「40 字」', pace.indexOf('40 字') < 0);
check('深夜的节奏块不再写「不要反问」', pace.indexOf('不要反问') < 0);
check('深夜仍会说「困」这层状态', pace.indexOf('困') >= 0 || pace.indexOf('心情不高') >= 0);

const noonAt = new Date(2026, 10, 25, 14, 0, 0).getTime();
const calmState = Object.assign({}, deepNight, { mood: { emotion: 'content', intensity: 0.2, at: Date.now(), reason: null } });
check('白天心情正常时返回空串（不打扰）', presenceEngine.buildPaceBlock(calmState, noonAt) === '');

console.log('\n共 ' + checks + ' 项检查，失败 ' + failures + ' 项');
if (failures > 0) process.exitCode = 1;
