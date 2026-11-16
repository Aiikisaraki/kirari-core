// 内置能力：get_current_time（阶段 D，一个能力一个文件）。
// schema（含 timeout/truncate）自带；dispatch 委托既有的底层函数实现。
// 新增内置能力照抄本文件结构即可，无需改 registry / conversationService。

const { defineCapability } = require('kirari-agent');
const { getCurrentTime } = require('../../tools');

const capability = defineCapability({
  id: 'get_current_time',
  name: 'get_current_time',
  kind: 'tool',
  scope: 'builtin',
  description: '获取当前日期和时间。当用户问“现在几点”“今天几号”“现在是什么时间”等时使用。',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA 时区名，如 Asia/Shanghai、America/New_York；留空则用系统本地时区。',
      },
    },
    required: [],
  },
  tags: ['builtin', 'preflight'],
});

async function dispatch(args, ctx) {
  return await getCurrentTime(args || {});
}

module.exports = { capability, dispatch };
