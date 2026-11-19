// scripts/smoke-memory-judge.js
// 记忆可信度的「大模型复核」层测试。
//
// 用户要求：「必要时我觉得需要大模型思考和二次确认」
// 这份测试要钉死的不是"模型答得对不对"（那不可测），而是**安全边界**：
//   1. 没配模型时，记忆照样写得进去（绝不阻塞）
//   2. 模型调用抛异常/超时/返回垃圾时，静默退化为启发式，绝不升级可信度
//   3. 想把涉及第三方的信息认定为 fact 时，必须过二次确认
//   4. 二次确认失败 → 退回低可信度，**永远不因复核而变 fact**
//   5. 不该复核的日常记忆不花模型调用（成本可控）
//
// 这些是一条都不能破的：判成 rumor 只是话说得谨慎，判成 fact 却是替谣言背书。

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const judge = require(path.join(ROOT, 'src/ai/memoryJudge'));

let checks = 0;
let failures = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(name, cond, detail = '') {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

/** 造一个假 AI 上下文：按顺序返回预设回复，并记录调用次数。 */
function fakeAi(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    model: 'fake-model',
    openai: {
      chat: {
        completions: {
          create: async (req) => {
            calls.push(req);
            const r = replies[i++];
            if (r instanceof Error) throw r;
            return { choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
          },
        },
      },
    },
  };
}

async function main() {
  console.log('记忆可信度复核层 smoke test');

  // ── 1. 成本闸门：不该复核的就不复核 ──────────────────────────────
  section('1. 成本闸门：日常记忆不花模型调用');

  check('主人说「我不吃辣」不触发复核',
    judge.shouldConsult({
      content: '我不吃辣，点菜别放辣椒',
      aboutPerson: null,
      heuristicLevel: 'fact',
      negativeHit: false,
    }) === false, '');

  check('涉及第三方 → 必须复核',
    judge.shouldConsult({
      content: '小张最近在换工作',
      aboutPerson: '123',
      heuristicLevel: 'hearsay',
      negativeHit: false,
    }) === true, '');

  check('命中负面词 → 必须复核',
    judge.shouldConsult({
      content: '他欠了很多钱',
      aboutPerson: null,
      heuristicLevel: 'fact',
      negativeHit: true,
    }) === true, '');

  check('启发式已判 rumor → 复核（只可能维持或降级）',
    judge.shouldConsult({
      content: '不知道真的假的',
      aboutPerson: null,
      heuristicLevel: 'rumor',
      negativeHit: false,
    }) === true, '');

  check('出现第三人称指代且够长 → 复核',
    judge.shouldConsult({
      content: '他昨天跟我说了挺多事',
      aboutPerson: null,
      heuristicLevel: 'fact',
      negativeHit: false,
    }) === true, '');

  // ── 2. 没配模型：绝不阻塞 ────────────────────────────────────────
  section('2. 没配模型时静默退化，绝不阻塞');

  const r2 = await judge.judgeMemory({
    aiContext: null,
    content: '小张出轨了',
    identity: { counterpartId: '1658359753', role: 'user' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('aiContext 为 null 时返回启发式结果，不抛异常',
    r2 && r2.epistemic === 'rumor' && r2.consulted === false,
    `epistemic=${r2 && r2.epistemic}`);

  // ── 3. 模型调用失败：退化为启发式，绝不升级 ──────────────────────
  section('3. 模型故障时绝不升级可信度');

  const aiThrow = fakeAi([new Error('network timeout')]);
  const r3 = await judge.judgeMemory({
    aiContext: aiThrow,
    content: '小张欠了赌债',
    identity: { counterpartId: '1', role: 'user' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 模型抛异常时保持启发式的 rumor（不升级成 fact）',
    r3.epistemic === 'rumor', `epistemic=${r3.epistemic}`);
  check('模型抛异常时 consulted=false（记为未复核）',
    r3.consulted === false, '');

  const aiGarbage = fakeAi(['这不是 JSON，只是一句废话']);
  const r3b = await judge.judgeMemory({
    aiContext: aiGarbage,
    content: '小张欠了赌债',
    identity: { counterpartId: '1', role: 'user' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 模型返回垃圾时保持启发式的 rumor',
    r3b.epistemic === 'rumor', `epistemic=${r3b.epistemic}`);

  // ── 4. 二次确认：想升 fact 必须过两关 ────────────────────────────
  section('4. 二次确认：涉及第三方升 fact 必须过两关');

  // 4.1 第一道判 fact，第二道也同意 → 才可以 fact
  const aiBoth = fakeAi([
    { subject: 'third', epistemic: 'fact', confidence: 0.9, reason: '他知道' },
    { agree: true, epistemic: 'fact', why: '亲历' },
  ]);
  const r4 = await judge.judgeMemory({
    aiContext: aiBoth,
    content: '小张确实离婚了，我陪他去的民政局',
    identity: { counterpartId: '1', role: 'owner' },
    heuristicLevel: 'hearsay',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('两道判断都认为是事实 → 允许 fact',
    r4.epistemic === 'fact' && r4.confirmed === true,
    `epistemic=${r4.epistemic} confirmed=${r4.confirmed}`);
  check('二次确认确实调用了两次模型',
    aiBoth.calls.length === 2, `调用 ${aiBoth.calls.length} 次`);

  // 4.2 第一道判 fact，第二道反对 → 不升
  const aiRefute = fakeAi([
    { subject: 'third', epistemic: 'fact', confidence: 0.8, reason: '他说的' },
    { agree: false, epistemic: 'hearsay', why: '转述' },
  ]);
  const r4b = await judge.judgeMemory({
    aiContext: aiRefute,
    content: '小张出轨了',
    identity: { counterpartId: '1', role: 'owner' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 二次确认反对 → 不升 fact', r4b.epistemic !== 'fact',
    `epistemic=${r4b.epistemic}`);
  check('二次确认反对时 confirmed=false', r4b.confirmed === false, '');

  // 4.3 第一道判 fact，第二道**失败** → 不升（失败不等于同意）
  const aiSecondFail = fakeAi([
    { subject: 'third', epistemic: 'fact', confidence: 0.8, reason: '他说的' },
    new Error('second call failed'),
  ]);
  const r4c = await judge.judgeMemory({
    aiContext: aiSecondFail,
    content: '小张出轨了',
    identity: { counterpartId: '1', role: 'owner' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 二次确认调用失败 → 不升 fact（失败不等于默认同意）',
    r4c.epistemic !== 'fact', `epistemic=${r4c.epistemic}`);

  // 4.4 第二道返回 fact 但 agree=false → 也不能变 fact
  const aiWeird = fakeAi([
    { subject: 'third', epistemic: 'fact', confidence: 0.8, reason: 'x' },
    { agree: false, epistemic: 'fact', why: '矛盾返回' },
  ]);
  const r4d = await judge.judgeMemory({
    aiContext: aiWeird,
    content: '小张出轨了',
    identity: { counterpartId: '1', role: 'owner' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 自相矛盾的返回（agree=false 却给 fact）不会变成 fact',
    r4d.epistemic !== 'fact', `epistemic=${r4d.epistemic}`);

  // ── 5. 只允许往保守方向修 ───────────────────────────────────────
  section('5. 模型只能让判断更保守，不能更乐观');

  const aiUpgrade = fakeAi([
    { subject: 'third', epistemic: 'fact', confidence: 0.99, reason: '强硬' },
    { agree: false, epistemic: 'rumor', why: '传闻' },
  ]);
  const r5 = await judge.judgeMemory({
    aiContext: aiUpgrade,
    content: '听说小张人品不行',
    identity: { counterpartId: '1', role: 'user' },
    heuristicLevel: 'rumor',
    negativeHit: true,
    aboutPerson: '999',
  });
  check('★ 启发式 rumor + 模型想升 fact + 复核反对 → 仍是 rumor',
    r5.epistemic === 'rumor', `epistemic=${r5.epistemic}`);

  // 模型把 rumor 判得更低（hearsay 更"高"于 rumor 在数组里，注意顺序）
  const aiLower = fakeAi([
    { subject: 'third', epistemic: 'rumor', confidence: 0.9, reason: '夸大了' },
  ]);
  const r5b = await judge.judgeMemory({
    aiContext: aiLower,
    content: '小张最近好像不太顺',
    identity: { counterpartId: '1', role: 'user' },
    heuristicLevel: 'hearsay',
    negativeHit: false,
    aboutPerson: '999',
  });
  check('模型判定更保守（hearsay→rumor）时采纳',
    r5b.epistemic === 'rumor', `epistemic=${r5b.epistemic}`);

  // ── 6. JSON 解析容错 ────────────────────────────────────────────
  section('6. 模型输出解析容错');

  check('能解析纯 JSON',
    judge.parseJsonLoose('{"a":1}')?.a === 1, '');
  check('能解析 ```json 围栏包裹的',
    judge.parseJsonLoose('```json\n{"a":2}\n```')?.a === 2, '');
  check('能解析前后带废话的',
    judge.parseJsonLoose('好的，我的判断是：{"a":3} 以上。')?.a === 3, '');
  check('纯废话返回 null',
    judge.parseJsonLoose('我觉得这个人不太行') === null, '');

  // ── 7. 归属判定也要能用 ─────────────────────────────────────────
  section('7. 归属判定：模型能纠正"这是在说谁"');

  const aiKirari = fakeAi([
    { subject: 'kirari', epistemic: 'fact', confidence: 0.9, reason: '设定' },
  ]);
  const r7 = await judge.judgeMemory({
    aiContext: aiKirari,
    content: 'Kirari 的设定里她怕黑',
    identity: { counterpartId: '1658359753', role: 'user' },
    heuristicLevel: 'hearsay',
    negativeHit: false,
    aboutPerson: null,
  });
  check('模型认定"在说她本人"时返回 subjectKind=kirari',
    r7.subjectKind === 'kirari', `subjectKind=${r7.subjectKind}`);

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}（共 ${checks} 项检查）\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
