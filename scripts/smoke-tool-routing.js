// scripts/smoke-tool-routing.js
// 阶段 5：MCP/skill 的「执行位置」路由测试。
//
// 用户的原始要求（2026-11-20）：
//   「我还是觉得有必要区分一下是来自哪个叶子……在主机上可以列出所有叶子节点，
//     而且也可以区分哪个请求是来自哪个叶子节点。假如主机是在 QQ 或者本机聊天窗口
//     （桌宠）或者网页端聊天窗口（核心），默认情况下操作主机下的 mcp 和 skill。
//     如果点明了某个叶子节点或者叶子节点的别名，就操作那个叶子节点。如果请求来自
//     某个叶子节点，那也默认操作自己这个叶子节点。」
//
// 这份测试钉死的是**判定规则本身**（不依赖真实组网），因为规则错了以后，
// 要么"在书房的电脑上查"其实查的是主机（静默串机器，最难排查），
// 要么叶子请求把工具跑到了主机上（用户明确不要）。
//
// 覆盖：
//   1. 三条默认规则（主机/叶子来源/显式点名）各自的判定
//   2. 结构化前缀 @device: 的解析与剥离
//   3. 点名找不到设备 → 必须显式说明，不许静默换机器
//   4. 远程执行成功/失败/无通道三种结局
//   5. 设备列表（主机可列出所有叶子）
//   6. registry.dispatch 集成：本地未知工具不能被误判、前缀不影响本地工具

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const routing = require(path.join(ROOT, 'src/services/toolRouting'));

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

const DEVICE_A = { deviceId: 'aaaaaaaa-1111-2222-3333-444444444444', name: '书房的电脑', online: true };
const DEVICE_B = { deviceId: 'bbbbbbbb-1111-2222-3333-444444444444', name: '卧室笔记本', online: true };

// ── 用 net/bootstrap 的鸭子类型替换「主机侧成员」与「远程调用」 ──
// toolRouting 通过 netBootstrap.snapshot() 与 getManager() 取这两样，
// 这里直接改它们导出的对象（只在本进程内生效，不影响真实运行）。
const netBootstrap = require(path.join(ROOT, 'src/net/bootstrap'));

let fakeMembers = [];
let remoteCalls = [];
let remoteOutcome = null;

netBootstrap.snapshot = () => ({
  enabled: true,
  running: true,
  state: { role: 'host', members: fakeMembers },
});netBootstrap.getManager = () => ({
  toolCapsOf: () => null,
  allToolCaps: () => [],
  callToolOnDevice: async (deviceId, name, args, opts) => {
    remoteCalls.push({ deviceId, name, args, opts });
    return remoteOutcome || { ok: true, result: `ran on ${deviceId}`, deviceId };
  },
});

function resetNet(devices = [DEVICE_A, DEVICE_B], outcome = null) {
  fakeMembers = devices;
  remoteCalls = [];
  remoteOutcome = outcome;
}

async function main() {
  // ───────────────────────────────────────────────────────────────
  section('1. 结构化前缀解析');
  {
    assert.deepStrictEqual(routing.parseDevicePrefix('@device:书房 mcp__fs__read'), {
      deviceHint: '书房',
      name: 'mcp__fs__read',
    });
    check('@device:名 工具 —— 解析正确', true);

    const colon = routing.parseDevicePrefix('@device:书房:mcp__fs__read');
    check('冒号分隔也接受', colon && colon.deviceHint === '书房' && colon.name === 'mcp__fs__read');

    check('普通工具名不误判', routing.parseDevicePrefix('mcp__fs__read') === null);
    check('skill 工具名不误判', routing.parseDevicePrefix('skill__demo__run') === null);
  }

  // ───────────────────────────────────────────────────────────────
  section('2. 设备解析：名 / id 前缀 / 别名 / 大小写');
  {
    resetNet();
    check('按完整设备名', routing.resolveDevice('书房的电脑')?.deviceId === DEVICE_A.deviceId);
    check('按去尾缀别名（书房）', routing.resolveDevice('书房')?.deviceId === DEVICE_A.deviceId);
    check('按 deviceId 前缀', routing.resolveDevice('aaaaaaaa')?.deviceId === DEVICE_A.deviceId);
    check('找不到返回 null（不猜）', routing.resolveDevice('阳台的平板') === null);

    resetNet([{ deviceId: 'cccc', name: 'Living Room PC', online: true }]);
    check('大小写不敏感', routing.resolveDevice('living room pc')?.deviceId === 'cccc');
  }

  // ───────────────────────────────────────────────────────────────
  section('3. 三条默认规则');
  {
    // 规则 3：主机本机 / QQ / 网页端 → 主机自己
    resetNet();
    const hostSide = routing.decide({}, 'mcp__fs__read');
    check('★ 主机本机 / QQ / 网页端 → 主机自己执行', hostSide.target === 'local');
    check('  判定来源标记为 host-default', hostSide.source === 'host-default');

    // 规则 2：请求来自叶子 → 那台叶子自己
    const fromLeaf = routing.decide({ sourceDeviceId: DEVICE_A.deviceId }, 'mcp__fs__read');
    check('★ 请求来自某台叶子 → 默认在那台叶子自己身上执行', fromLeaf.target === 'remote');
    check('  目标设备就是请求方', fromLeaf.deviceId === DEVICE_A.deviceId);
    check('  判定来源标记为 from-leaf', fromLeaf.source === 'from-leaf');

    // 规则 1：显式点名 → 那台设备（覆盖来源）
    const explicit = routing.decide(
      { sourceDeviceId: DEVICE_A.deviceId },
      '@device:卧室笔记本 mcp__fs__read',
    );
    check('★ 点名设备 → 覆盖来源，去点名的那台执行', explicit.deviceId === DEVICE_B.deviceId);
    check('  判定来源标记为 explicit', explicit.source === 'explicit');
    check('  前缀已从工具名剥掉', explicit.name === 'mcp__fs__read');
  }

  // ───────────────────────────────────────────────────────────────
  section('4. 点名却找不到设备：必须显式说明，不许静默换机器');
  {
    resetNet();
    const miss = routing.decide({ sourceDeviceId: DEVICE_A.deviceId }, '@device:阳台平板 mcp__fs__read');
    check('★ 标记为 explicitMiss', miss.explicitMiss === true);
    check('★ note 里带上了点名的名字', String(miss.note || '').includes('阳台平板'));
    check('note 里列出了可用设备（便于模型换说法）', String(miss.note || '').includes('书房的电脑'));
    check('回落到「来源那台」，而不是随便挑一台', miss.deviceId === DEVICE_A.deviceId);
    check('工具名已剥前缀（否则执行必找不到）', miss.name === 'mcp__fs__read');

    // 主机侧点名找不到：回落主机本地，同样带说明
    const missHost = routing.decide({}, '@device:阳台平板 mcp__fs__read');
    check('主机侧点名找不到 → 回落本地执行', missHost.target === 'local');
    check('  同样带 explicitMiss 说明', missHost.explicitMiss === true);
  }

  // ───────────────────────────────────────────────────────────────
  section('5. 远程执行：成功 / 失败 / 无通道');
  {
    resetNet([DEVICE_A], { ok: true, result: '文件内容', deviceId: DEVICE_A.deviceId });
    const ok = await routing.runRemote({}, { deviceId: DEVICE_A.deviceId, name: 'mcp__fs__read' }, {
      path: '/tmp/a',
    });
    check('远程成功 → 原样返回结果', ok && ok.content === '文件内容' && ok.isError === false);
    check('调用带上了目标设备与工具名', remoteCalls.length === 1 && remoteCalls[0].deviceId === DEVICE_A.deviceId);
    check('参数原样透传', remoteCalls[0].args && remoteCalls[0].args.path === '/tmp/a');

    resetNet([DEVICE_A], { ok: false, error: '目标设备不在线', deviceId: DEVICE_A.deviceId });
    const bad = await routing.runRemote({}, { deviceId: DEVICE_A.deviceId, name: 'x' }, {});
    check('远程失败 → isError=true', bad && bad.isError === true);
    check('★ 失败原因写进内容（不是静默空串）', String(bad.content).includes('目标设备不在线'));

    // 没有远程通道：返回 null，调用方回退本地执行（普通单机安装就是这条路）
    netBootstrap.getManager = () => null;
    const none = await routing.runRemote({}, { deviceId: DEVICE_A.deviceId, name: 'x' }, {});
    check('★ 没有组网通道 → 返回 null（让调用方回退本地，不报错）', none === null);

    // 恢复，便于后续小节
    netBootstrap.getManager = () => ({
      toolCapsOf: () => null,
      allToolCaps: () => [],
      callToolOnDevice: async (deviceId, name, args, opts) => {
        remoteCalls.push({ deviceId, name, args, opts });
        return remoteOutcome || { ok: true, result: `ran on ${deviceId}`, deviceId };
      },
    });
  }

  // ───────────────────────────────────────────────────────────────
  section('6. 设备列表与能力上报');
  {
    resetNet();
    const list = routing.listDevices();
    check('★ 主机能列出所有叶子节点', list.length === 2);
    check('列表带设备名与在线状态', list[0].name === '书房的电脑' && list[0].online === true);
    check('非主机角色 → 列表为空（不冒充主机）', (() => {
      netBootstrap.snapshot = () => ({ enabled: true, running: true, state: { role: 'leaf', members: fakeMembers } });
      const empty = routing.listDevices().length === 0;
      netBootstrap.snapshot = () => ({ enabled: true, running: true, state: { role: 'host', members: fakeMembers } });
      return empty;
    })());
    check('未知设备的能力查询返回 null 而不是抛错', routing.capsOf('nope') === null);
    check('能力总览在没有上报时是空数组', Array.isArray(routing.allCaps()));
  }

  // ───────────────────────────────────────────────────────────────
  section('7. registry.dispatch 集成：不误伤本地工具');
  {
    resetNet();
    const caps = require(path.join(ROOT, 'src/capabilities/registry'));

    // 普通本地工具：没有来源、没有前缀 → 必须仍然走本地，且能正常执行
    const local = await caps.dispatch('smoke::routing', 'get_current_time', {});
    check('★ 普通工具仍走本地并成功执行', local && local.isError === false);

    // 未知工具：仍然报未知（而不是被路由吞掉）
    const unknown = await caps.dispatch('smoke::routing', 'definitely_not_a_tool', {});
    check('★ 未知工具仍然明确报未知', unknown && unknown.isError === true);
    check('  未知工具报错里带工具名', String(unknown.content).includes('definitely_not_a_tool'));

    // 带前缀但设备不存在：本地执行时用剥掉前缀的名字 —— 仍然能跑起来
    const prefixedMiss = await caps.dispatch(
      'smoke::routing',
      '@device:阳台平板 get_current_time',
      {},
    );
    check('★ 点名不存在设备时，本地仍能用真实工具名执行', prefixedMiss && prefixedMiss.isError === false);
    check('  结果里明确说明了没找到那台设备', String(prefixedMiss.content).includes('阳台平板'));
  }

  // ───────────────────────────────────────────────────────────────
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures === 0 ? '全部通过' : '有失败'}（共 ${checks} 项检查）`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n测试脚本自身出错：', e);
  process.exitCode = 1;
});
