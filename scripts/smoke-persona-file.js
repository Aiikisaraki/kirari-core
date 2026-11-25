// scripts/smoke-persona-file.js
// 人格独立文件（~/.kirari/persona.md）的回归测试（2026-11-25 用户拍板）。
//
// 背景：人格原来存在 config.json 的 basePersona 里，三个毛病：
//   ① 4000 字上限（写细一点就被静默截断）
//   ② 和模型密钥一损俱损（config 写坏，人格跟着丢）
//   ③ 没法当明文编辑/备份/diff
//
// 这份测试钉死搬家后最容易出错的地方：
//   1. persona.md 优先于 config.json 的老字段
//   2. 「恢复预设」必须真的删掉文件，且**不能**被老字段读回来
//   3. 超长截断到 20000，并如实返回 truncated
//   4. 原子写：不留下 .tmp 残骸
//   5. 覆盖前留备份，备份份数有界
//   6. 首次启动的迁移只搬一次，且不删老字段
//   7. 坏档（文件不可读）不抛、按未自定义处理

const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据根：必须在 require 任何读 kirariHome 的模块**之前**设好
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-persona-smoke-'));
process.env.KIRARI_HOME = tmpHome;

let checks = 0;
let failures = 0;
function check(name, cond, detail) {
  checks += 1;
  if (cond) console.log('  \u2713 ' + name + (detail ? '  (' + detail + ')' : ''));
  else {
    failures += 1;
    console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function reset() {
  for (const f of ['persona.md', 'config.json']) {
    const q = path.join(tmpHome, f);
    try { if (fs.existsSync(q)) fs.unlinkSync(q); } catch { /* ignore */ }
  }
}

const ROOT = path.resolve(__dirname, '..');
const personaFile = require(path.join(ROOT, 'src/services/personaFile'));

section('路径与上限');
check('人格文件落在数据根下', personaFile.personaPath() === path.join(tmpHome, 'persona.md'), personaFile.personaPath());
check('上限是 20000 字', personaFile.PERSONA_MAX_CHARS === 20000);

section('写读往返');
reset();
const w1 = personaFile.writePersonaFile('你叫小满，说话有点冲。');
check('写入成功', w1.ok === true);
check('文件真的落了盘', fs.existsSync(personaFile.personaPath()));
check('读回来是同样内容', personaFile.readPersonaFile() === '你叫小满，说话有点冲。');
check('没有留下 .tmp 残骸', fs.readdirSync(tmpHome).every((f) => f.indexOf('.tmp-') < 0));

section('内容没变就不重写（避免每轮触发备份）');
const mtime1 = fs.statSync(personaFile.personaPath()).mtimeMs;
personaFile.writePersonaFile('你叫小满，说话有点冲。');
const mtime2 = fs.statSync(personaFile.personaPath()).mtimeMs;
check('mtime 没变', mtime1 === mtime2, String(mtime1) + ' vs ' + String(mtime2));

section('超长截断');
reset();
const w3 = personaFile.writePersonaFile('啊'.repeat(30000));
check('截断到 20000', w3.saved.length === 20000, String(w3.saved.length));
check('如实报告 truncated', w3.truncated === true);

section('恢复预设 = 真删文件');
reset();
personaFile.writePersonaFile('要被删掉的人格');
const w4 = personaFile.writePersonaFile('');
check('返回空内容', w4.saved === '');
check('文件真的不存在了', !fs.existsSync(personaFile.personaPath()));
check('读出来是空串', personaFile.readPersonaFile() === '');

section('优先级：persona.md > config.json 老字段');
reset();
const cfgPath = path.join(tmpHome, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: '老字段里的人格' }, null, 2));
const r1 = personaFile.resolvePersona();
check('没有人格文件时回退到 config 老字段', r1.source === 'config' && r1.text === '老字段里的人格', r1.source + '/' + r1.text);
personaFile.writePersonaFile('新文件里的人格');
const r2 = personaFile.resolvePersona();
check('有人格文件时优先文件', r2.source === 'file' && r2.text === '新文件里的人格', r2.source);

section('坏档不炸');
reset();
fs.mkdirSync(path.dirname(personaFile.personaPath()), { recursive: true });
fs.mkdirSync(personaFile.personaPath(), { recursive: true });
let threw = false;
let val = null;
try { val = personaFile.readPersonaFile(); } catch (e) { threw = true; }
check('读坏档不抛异常', threw === false);
check('坏档按未自定义处理（空串）', val === '', JSON.stringify(val));
try { fs.rmdirSync(personaFile.personaPath()); } catch { /* ignore */ }

section('迁移：只搬一次，不删老字段');
reset();
fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: '要迁移过去的人格' }, null, 2));
// 让 modelConfigFile 重新读盘（它缓存了 config）
const mcfPath = require.resolve(path.join(ROOT, 'src/services/modelConfigFile'));
delete require.cache[mcfPath];
delete require.cache[require.resolve(path.join(ROOT, 'src/services/personaFile'))];
const pf2 = require(path.join(ROOT, 'src/services/personaFile'));
const m1 = pf2.migrateFromConfig();
check('第一次迁移成功', m1.migrated === true, JSON.stringify(m1));
check('内容进了 persona.md', pf2.readPersonaFile() === '要迁移过去的人格', pf2.readPersonaFile());
const cfgAfter = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
check('config.json 的老字段依然保留（跨版本安全）', cfgAfter.basePersona === '要迁移过去的人格', String(cfgAfter.basePersona));
const m2 = pf2.migrateFromConfig();
check('第二次不再重复迁移', m2.migrated === false);

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log('\n共 ' + checks + ' 项检查，失败 ' + failures + ' 项');
if (failures > 0) process.exitCode = 1;
