// 内置能力：generate_image（阶段 D，一个能力一个文件）。
const { defineCapability } = require('kirari-agent');
const { generateImage } = require('../../tools');

const capability = defineCapability({
  id: 'generate_image',
  name: 'generate_image',
  kind: 'tool',
  scope: 'builtin',
  description: '根据文字描述生成一张图片（需要模型服务支持图像生成接口）。当用户要求“画一张图”“生成图片”“画个xx”“帮我画”等时使用。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '图片的文字描述，尽量具体。' },
      size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], description: '图片尺寸，默认 1024x1024。' },
    },
    required: ['prompt'],
  },
  tags: ['builtin'],
});

async function dispatch(args, ctx) {
  return await generateImage(args || {}, ctx || {});
}

module.exports = { capability, dispatch };
