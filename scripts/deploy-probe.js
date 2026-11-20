// 部署后探针：验证 0.9.15 的身份派生与新增路由在真实容器里成立。
//
// 这些是「上线前必须确认没被改坏」的既有契约，不是新功能：
//   - 三入口（网页 / 桌宠 / QQ 私聊）是同一个主人身份
//   - 陌生人（好友 1658359753）仍是 guest，看不到主人的东西
//   - 群聊派生成 user + isGroup，不是 owner
//   - 新增的 /api/net/devices 在组网关闭时返回空列表而不是报错
const assert = require('assert');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e && e.message ? e.message : e}`);
  }
}

const ownerKey = require('/app/src/services/ownerIdentity').getOwnerKey();
const { sceneFromSessionId } = require('/app/src/services/ownerIdentity');

console.log('阶段 5 部署探针');
console.log(`  主人身份键 = ${ownerKey}`);

check('主人身份键是 1980308740（仅生产：开发机没有 people 数据）', () => {
  if (String(ownerKey) === '_local') {
    console.log('      （开发机兜底键 _local，跳过这项生产断言）');
    return;
  }
  assert.strictEqual(String(ownerKey), '1980308740');
});

check('本机（网页/桌宠）会话派生成主人', () => {
  const sc = sceneFromSessionId('local:x', 'net');
  assert.strictEqual(sc.isOwner, true, `实际 ${JSON.stringify(sc)}`);
});

check('主人 QQ 私聊 → 主人', () => {
  // 用本机实际的主人键拼 sessionId：开发机没有 production 的 people 数据，
  // 键会是 _local，此时不该把「键不对」误判成「身份派生坏了」。
  const sc = sceneFromSessionId(`bot-qq:user:${ownerKey}`, 'net');
  assert.strictEqual(sc.isOwner, true, `实际 ${JSON.stringify(sc)}`);
  assert.strictEqual(String(sc.senderId), String(ownerKey));
});

check('陌生人 QQ 私聊 → 不是主人（guest 隔离没被破坏）', () => {
  // 用一个一定不等于主人键的账号，避免开发机 _local 时误判
  const stranger = String(ownerKey) === '1658359753' ? '1658359754' : '1658359753';
  const sc = sceneFromSessionId(`bot-qq:user:${stranger}`, 'net');
  assert.strictEqual(sc.isOwner, false, `实际 ${JSON.stringify(sc)}`);
});

check('群聊 → 不是主人，且标为群', () => {
  const sc = sceneFromSessionId('bot-qq:group:123456', 'net');
  assert.strictEqual(sc.isOwner, false, `实际 ${JSON.stringify(sc)}`);
  assert.strictEqual(sc.isGroup, true, `实际 ${JSON.stringify(sc)}`);
});

check('组网关闭时设备列表为空且不抛错', () => {
  const routing = require('/app/src/services/toolRouting');
  const list = routing.listDevices();
  assert.ok(Array.isArray(list), 'listDevices 应返回数组');
  assert.strictEqual(list.length, 0);
});

check('toolRouting 的默认落点符合三条规则', () => {
  const routing = require('/app/src/services/toolRouting');
  // 主机本体发起、又没点名 → 主机自己跑
  const d1 = routing.decide({}, 'get_current_time');
  assert.strictEqual(d1.target, 'local', `实际 ${JSON.stringify(d1)}`);
  assert.strictEqual(d1.source, 'host-default', `实际 ${JSON.stringify(d1)}`);
  // 请求来自某台叶子 → 就在那台叶子上跑（哪怕它此刻不在成员表里，
  // 也绝不能悄悄改到主机本地执行：那正是"静默跨机"）
  const d2 = routing.decide({ sourceDeviceId: 'ghost' }, 'get_current_time');
  assert.strictEqual(d2.target, 'remote', `实际 ${JSON.stringify(d2)}`);
  assert.strictEqual(d2.source, 'from-leaf', `实际 ${JSON.stringify(d2)}`);
  assert.strictEqual(d2.deviceId, 'ghost', `实际 ${JSON.stringify(d2)}`);
  // 点名不存在的设备：不远程执行，但要给出"没找到"的提示
  const d3 = routing.decide({}, '@device:不存在 __x');
  assert.strictEqual(d3.target, 'local', `实际 ${JSON.stringify(d3)}`);
  assert.ok(d3.note && d3.note.includes('没找到'), `实际 ${JSON.stringify(d3)}`);
  // 剥前缀：交给工具的是真实名，不是带 @device: 的整串
  assert.strictEqual(d3.name, '__x', `实际 ${JSON.stringify(d3)}`);
});

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
