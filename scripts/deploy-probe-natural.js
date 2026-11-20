// scripts/deploy-probe-natural.js
// 生产容器内验证「自然语言点名设备」这一层真的生效。
//
// 为什么要单独跑：deploy-probe.js 只验证了结构化前缀那三条默认。
// 这次新增的是「模型没写 @device: 也能认出来」，它涉及两个必须同时成立的
// 动作 —— 认出设备、把路由专用的参数键摘掉。任何一半漏了都是静默错误：
// 前半漏了就是跑错机器，后半漏了就是 MCP schema 校验直接失败。
//
// 用鸭子类型接管 net/bootstrap 的成员与远程调用，不依赖真实组网。

const path = require('path');
const assert = require('assert');

// 生产容器里代码在 /app；本地跑就是仓库根目录。自适应，这样同一份探针
// 可以现在本地验一遍再去容器里跑（避免"探针自己有 bug"浪费一轮部署）。
const ROOT = require('fs').existsSync('/app/src/services/toolRouting.js')
  ? '/app'
  : path.resolve(__dirname, '..');

const netBootstrap = require(path.join(ROOT, 'src/net/bootstrap'));
const routing = require(path.join(ROOT, 'src/services/toolRouting'));

let checks = 0;
let failures = 0;

function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const A = { deviceId: 'aaaaaaaa-1111-2222-3333-444444444444', name: '书房的电脑', online: true };
const B = { deviceId: 'bbbbbbbb-1111-2222-3333-444444444444', name: '卧室笔记本', online: false };

const calls = [];
netBootstrap.snapshot = () => ({ enabled: true, running: true, state: { role: 'host', members: [A, B] } });
netBootstrap.getManager = () => ({
  toolCapsOf: () => null,
  allToolCaps: () => [],
  callToolOnDevice: async (deviceId, name, args) => {
    calls.push({ deviceId, name, args });
    return { ok: true, result: '远程结果', deviceId };
  },
});

function reset() {
  netBootstrap.snapshot = () => ({ enabled: true, running: true, state: { role: 'host', members: [A, B] } });
  calls.length = 0;
}

async function main() {
  console.log('\n阶段 5.b 生产探针：自然语言点名设备');

  // ── 1. 认得出 ──
  console.log('\n[1] 认得出来');
  reset();
  const byArg = routing.decide({}, 'read_file', { device: '书房', path: '/a' });
  check('★ 参数里点名 → 路由到那台设备', byArg.target === 'remote' && byArg.deviceId === A.deviceId);
  check('  来源标为 natural', byArg.source === 'natural');
  check('  工具名不受影响', byArg.name === 'read_file');

  const byCn = routing.decide({}, 'run_skill', { 设备: '卧室笔记本' });
  check('中文键「设备」也认', byCn.deviceId === B.deviceId);

  const byName = routing.decide({}, '书房 read_file', {});
  check('★「书房 read_file」漏写标记也认，且工具名被剥离',
    byName.target === 'remote' && byName.name === 'read_file');

  const bySlash = routing.decide({}, '书房的电脑/read_file', {});
  check('斜杠分隔的写法也认', bySlash.target === 'remote' && bySlash.deviceId === A.deviceId);

  // ── 2. 认不准就不动手（这层最重要的一条）──
  console.log('\n[2] 认不准时不许劫持路由');
  reset();
  check('★ 设备名不存在 → 按默认走本地', routing.decide({}, 'read_file', { device: '随便什么' }).target === 'local');
  check('★ 工具自己的 host 参数不被当成设备', routing.decide({}, 'http_get', { host: 'example.com' }).target === 'local');
  check('没有设备相关参数 → 本地', routing.decide({}, 'read_file', { path: '/a' }).target === 'local');

  // ── 3. 优先级不能被这层打乱 ──
  console.log('\n[3] 优先级');
  reset();
  const both = routing.decide({}, '@device:卧室 read_file', { device: '书房' });
  check('★ 结构化前缀优先于参数', both.deviceId === B.deviceId && both.source === 'explicit');
  const leaf = routing.decide({ sourceDeviceId: B.deviceId }, 'read_file', {});
  check('叶子来源没点名 → 仍操作自己', leaf.deviceId === B.deviceId);

  // ── 4. 端到端：参数清理 ──
  console.log('\n[4] dispatch 端到端');
  reset();
  const caps = require(path.join(ROOT, 'src/capabilities/registry'));
  const r = await caps.dispatch('probe::natural', 'read_file', { device: '书房', path: '/a.txt' });
  check('★ 真的走了远程', calls.length === 1 && calls[0].deviceId === A.deviceId);
  check('★ 转发参数里没有路由专用的 device 键', calls[0] && !('device' in calls[0].args));
  check('业务参数 path 原样保留', calls[0] && calls[0].args.path === '/a.txt');
  check('结果正常回给模型', r && r.isError === false);

  // ── 5. 单机不受影响 ──
  console.log('\n[5] 单机安装零影响');
  netBootstrap.snapshot = () => ({ enabled: true, running: true, state: { role: 'host', members: [] } });
  check('没有成员 → 自然语言层完全不生效', routing.decide({}, 'read_file', { device: '书房' }).target === 'local');

  console.log(
    `\n${failures === 0 ? '✅ 全部通过' : '❌ 有失败'}（共 ${checks} 项检查）`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n探针自身出错：', e);
  process.exitCode = 1;
});
