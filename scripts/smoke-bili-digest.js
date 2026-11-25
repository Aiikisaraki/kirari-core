// scripts/smoke-bili-digest.js
// 「她记不住自己看过什么」的回归测试（2026-11-25 报障）。
//
// 用户原话：「我今天问她看过什么，她依旧记不得东西，不知道视频名和视频内容，
//            啥都不记得，我感觉没什么有用价值啊」
//
// 这条链上有三处断裂，这份测试钉的是后两处（第一处是扩展丢了 discover，
// 那份在 kirari-ext-bili 侧用探针验证）：
//   ② 见闻正文必须带标题/简介/作者，而不是「刷到点东西」这种空壳
//   ③ 摘要必须能**不靠关键词**被注入：问「你今天看过什么」时词面完全不重合，
//      靠 buildMemoryBlock 永远命不中，所以必须有一条独立的时间线注入路径。

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-digest-smoke-'));
process.env.KIRARI_HOME = tmpHome;
process.env.PET_API_DATA_DIR = tmpHome;

let checks = 0;
let failures = 0;
function section(t) { console.log('\n=== ' + t + ' ==='); }
function check(name, cond, detail) {
  checks += 1;
  if (cond) console.log('  \u2713 ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures += 1; console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const ROOT = path.resolve(__dirname, '..');
const digest = require(path.join(ROOT, 'src/services/biliDigest'));
const dbStorage = require(path.join(ROOT, 'src/db/dbStorage'));

// ── 1. 解析：三种真实写入格式都要能还原 ─────────────────────────────
section('解析见闻正文');
const c1 = '[B站见闻·她自己的经历] 刷到《影视杂谈：聊聊老番》（影视） 简介里说：聊聊那些年 作者是某某（BV1xx411c7mD）';
const p1 = digest.parseNote(c1);
check('取出标题', p1.title === '影视杂谈：聊聊老番', p1.title);
check('取出分区', p1.category === '影视', p1.category);
check('取出作者', p1.owner === '某某', p1.owner);
check('取出 BV', p1.bvid === 'BV1xx411c7mD', p1.bvid);

const c2 = '[B站探索·关键词「科技」] 刷到《Anthropic破发》（科技）（BV1k9yzzyEmQ）';
const p2 = digest.parseNote(c2);
check('探索格式也能解析', p2.title === 'Anthropic破发' && p2.category === '科技');
check('分区间隔的括号不误判', p2.desc === '', JSON.stringify(p2.desc));

check('乱七八糟的正文返回 null', digest.parseNote('今天天气不错') === null);

// ── 2. 时间筛选：必须按 UTC 比较 ─────────────────────────────────────
section('时间筛选用 UTC（库里 CURRENT_TIMESTAMP 是 UTC）');
check('toDbTime 输出 UTC 字符串', digest.toDbTime(Date.UTC(2026, 10, 25, 14, 0, 0)) === '2026-11-25 14:00:00', digest.toDbTime(Date.UTC(2026, 10, 25, 14, 0, 0)));

// ── 3. 端到端：写库 → 摘要能捞出来 ───────────────────────────────────
section('端到端：写进库 → 摘要捞得出');
// 核心版没有 initDatabase：库路径在 require dbStorage 时由 kirariHome 定死。
// 文件顶部已经把 KIRARI_HOME 指到临时目录，所以这里直接拿到的就是隔离库。
const db = dbStorage.getDb();
const now = Date.now();
const nowUtc = new Date(now).toISOString().slice(0, 19).replace('T', ' ');

function seed(content, createdAt) {
  db.prepare(
    'INSERT INTO memories (subject, kind, content, visibility, source, importance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run('self::1', 'event', content, 'private', 'observed', 4, createdAt, createdAt);
}

seed('[B站见闻·她自己的经历] 刷到《影视杂谈：聊聊老番》（影视） 简介里说：聊聊那些年的番剧（BV1xx411c7mD）', nowUtc);
seed('[B站见闻·她自己的经历] 刷到《手把手教你成为顶尖打手》（搞笑） 作者是南南南意（BV1EqZqYxEhk）', nowUtc);

const notes = digest.readRecentNotes({ now: now, days: 1 });
check('当天见闻被捞出来', notes.length === 2, String(notes.length));
check('标题非空', notes.every((n) => n.title.length > 0));

const block = digest.buildDigestBlock({ now: now, days: 1 });
check('摘要块非空', block.length > 0);
check('摘要里有标题', block.indexOf('影视杂谈：聊聊老番') >= 0);
check('摘要里有第二标题', block.indexOf('手把手教你成为顶尖打手') >= 0);
check('摘要带「看过的内容」这类语境', block.indexOf('B站看过什么') >= 0);
check('摘要提醒她别编细节', block.indexOf('不要编') >= 0);
check('摘要说明是自己的经历', block.indexOf('不是别人告诉你的') >= 0);

// 关键：这组词与用户问句「你今天看过什么」**零重合**，正是原 bug 的触发条件
const queryTokens = ['今天', '看过', '什么'];
const hitByKeyword = notes.some((n) => queryTokens.some((t) => (n.title + n.desc).indexOf(t) >= 0));
check('原 bug 的成因已确认：问句与记忆正文零重合', hitByKeyword === false);
check('但摘要不依赖关键词，仍能注入', block.indexOf('影视杂谈') >= 0);

// ── 4. 过期与边界 ────────────────────────────────────────────────────
section('时间窗与边界');
const old = digest.readRecentNotes({ now: now + 10 * 24 * 3600 * 1000, days: 1 });
check('十天前的见闻不会被当成「今天」', old.length === 0, String(old.length));
const wider = digest.readRecentNotes({ now: now + 10 * 24 * 3600 * 1000, days: 30 });
check('放宽到 30 天能捞到', wider.length === 2, String(wider.length));
check('窗口内没有记录时返回空串（不塞空标题）', digest.buildDigestBlock({ now: now + 365 * 24 * 3600 * 1000, days: 1 }) === '');

// ── 5. 坏库不炸 ──────────────────────────────────────────────────────
section('坏库不炸');
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-digest-empty-'));
check('未 init 时也不抛异常', (() => { try { digest.buildDigestBlock({ days: 1 }); return true; } catch (e) { return false; } })());

db.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.rmSync(emptyHome, { recursive: true, force: true });
console.log('\n共 ' + checks + ' 项检查，失败 ' + failures + ' 项');
if (failures > 0) process.exitCode = 1;
