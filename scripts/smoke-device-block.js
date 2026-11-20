// 阶段 5 · 设备段注入的单元验证。
//
// 这段文字是「点名某个叶子」这条规则能被触发的前提：如果模型不知道
// 有 @device: 这个语法、也不知道现在有哪些设备，它就只会在主机本地
// 老老实实跑工具，用户那句「让书房的电脑……」永远落不到实处。
//
// 反过来，单机用户（绝大多数）不该看到这段 —— 提示词每多一段都在挤
// 上下文、也在给模型多一个分心的由头。所以"没有设备时返回空串"同样是
// 被测行为，不是顺手写的早退。

const assert = require('assert');
const { buildDeviceBlock } = require('../src/services/reply/promptBuilder');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}

console.log('\n阶段 5 · 设备段注入');

console.log('\n[1] 单机安装：一个字都不注入');
check('无设备、无来源设备 → 空串', () => {
  assert.strictEqual(buildDeviceBlock({}), '');
  assert.strictEqual(buildDeviceBlock(), '');
  assert.strictEqual(buildDeviceBlock({ devices: [] }), '');
});

console.log('\n[2] 主机视角：说清默认在哪跑 + 列出设备');
const HOST_VIEW = buildDeviceBlock({
  devices: [
    { deviceId: 'aaa', name: '书房的电脑', online: true },
    { deviceId: 'bbb', name: '客厅的平板', online: false },
  ],
});
check('明确说了默认在主机自己身上执行', () => {
  assert.ok(HOST_VIEW.includes('主机'));
  assert.ok(/不特别说明|默认/.test(HOST_VIEW));
});
check('列出了每台设备和在线状态', () => {
  assert.ok(HOST_VIEW.includes('书房的电脑'));
  assert.ok(HOST_VIEW.includes('客厅的平板'));
  assert.ok(HOST_VIEW.includes('在线'));
  assert.ok(HOST_VIEW.includes('离线'));
});
check('教了 @device: 语法（否则规则永远不会被触发）', () => {
  assert.ok(HOST_VIEW.includes('@device:'));
});
check('给了可照抄的例子', () => {
  assert.ok(HOST_VIEW.includes('read_file'));
});

console.log('\n[3] 叶子视角：默认操作自己那台');
const LEAF_VIEW = buildDeviceBlock({
  devices: [{ deviceId: 'aaa', name: '书房的电脑', online: true }],
  selfDeviceId: 'aaa',
  selfDeviceName: '书房的电脑',
});
check('说明了请求来自哪台设备', () => {
  assert.ok(LEAF_VIEW.includes('书房的电脑'));
  assert.ok(LEAF_VIEW.includes('这台设备'));
});
check('说明默认在这台设备上执行', () => {
  assert.ok(/不特别说明|默认/.test(LEAF_VIEW));
});
check('同时仍给出其它可点名设备', () => {
  assert.ok(LEAF_VIEW.includes('@device:'));
});

console.log('\n[4] 边界');
check('设备名缺失时用 deviceId 前 8 位兜底，不显示 undefined', () => {
  const s = buildDeviceBlock({
    devices: [],
    selfDeviceId: 'abcdefgh-1234',
    selfDeviceName: '',
  });
  assert.ok(!s.includes('undefined'));
  assert.ok(s.includes('abcdefgh'));
});
check('devices 传 null/非数组不炸', () => {
  assert.strictEqual(buildDeviceBlock({ devices: null }), '');
  assert.strictEqual(buildDeviceBlock({ devices: 'nope' }), '');
});
check('叶子来源但列表为空时，不谎称"没有其它在线设备"之外的错话', () => {
  const s = buildDeviceBlock({ devices: [], selfDeviceId: 'aaa', selfDeviceName: '书房的电脑' });
  assert.ok(s.includes('书房的电脑'));
  assert.ok(!s.includes('undefined'));
});

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（共 ${pass + fail} 项检查）`);
process.exit(fail === 0 ? 0 : 1);
