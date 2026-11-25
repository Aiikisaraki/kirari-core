
// scripts/check-persona-parity.js
// 校验「核心版 ↔ 桌宠版」人格相关模块的文案是否逐字一致。
//
// 为什么需要它：persona / style / speakingDesire / personaFile 这四份是两端共用一套文案，
// 但住在两个仓库、两种语言（JS / TS）里。以前只靠注释写「改一端必须同步另一端」，
// 事实上已经漂移过好几次（设置页的 PRESET_PERSONA 曾写成「小猫娘」，也停在旧版「活泼软萌」）。
//
//     node scripts/check-persona-parity.js
//     KIRARI_DESKTOP_DIR=D:\personal-proj\akisaki-kirari node scripts/check-persona-parity.js
//
// 做法：把两个文件里「含中文的字符串字面量」按出现顺序抽出来一一比对。
// 只比字符串内容，不管引号风格、行拼接、类型注解——那些是实现细节。
// 退出码：0 全一致；1 有差异或文件缺失（缺失也算失败，避免「看起来跑过了」）。
const fs = require('fs');

const CJK = /[\u4e00-\u9fff]/;
const LITERAL = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

function unescapeStr(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function literals(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let m;
  LITERAL.lastIndex = 0;
  while ((m = LITERAL.exec(src)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    if (raw === undefined) continue;
    const text = unescapeStr(raw);
    if (!CJK.test(text)) continue;
    out.push(text);
  }
  return out;
}

const path = require('path');
const CORE = path.resolve(__dirname, '..');
const DESK = process.env.KIRARI_DESKTOP_DIR || path.resolve(CORE, '..', 'akisaki-kirari');
const pairs = [
  ['src/services/reply/persona.js', 'electron/ai/reply/persona.ts'],
  ['src/services/reply/style.js', 'electron/ai/reply/style.ts'],
  ['src/services/reply/speakingDesire.js', 'electron/ai/reply/speakingDesire.ts'],
  ['src/services/personaFile.js', 'electron/ai/persona-file.ts'],
  // proactive 的措辞决定「主动联系」听起来像想你、还是像定时通知，必须两端一致
  ['src/services/presence/proactive.js', 'electron/ai/presence/proactive.ts'],
];

let bad = 0;
for (const pair of pairs) {
  const a = CORE + '/' + pair[0];
  const b = DESK + '/' + pair[1];
  const name = pair[0].split('/').pop();
  if (!fs.existsSync(b)) { console.log('MISSING ' + pair[1]); bad++; continue; }
  const la = literals(a);
  const lb = literals(b);
  let diff = null;
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) { diff = { i: i, a: la[i], b: lb[i] }; break; }
  }
  if (!diff) {
    console.log('OK   ' + name + '  (' + la.length + ' 条中文字面量逐字一致)');
  } else {
    bad++;
    console.log('DIFF ' + name + ' 第 ' + (diff.i + 1) + ' 条');
    console.log('  core   : ' + JSON.stringify(diff.a));
    console.log('  desktop: ' + JSON.stringify(diff.b));
  }
}
if (bad) {
  console.log('\n有 ' + bad + ' 个文件不一致，请按 docs/prompt-architecture.md 第 9 节同步。');
  process.exitCode = 1;
} else {
  console.log('\n人格相关文案两端一致。');
}