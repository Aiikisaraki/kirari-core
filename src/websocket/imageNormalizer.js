// src/websocket/imageNormalizer.js
// 图片尺寸/体积兜底：客户端已自动压缩（最长边≤1280 + JPEG q0.8），这里用 sharp 做服务端真兜底——
// 真正解码图片，超出像素上限的直接在服务端缩放成 JPEG q0.8（而非只按字节估算后报错）。
// 拦住「绕过客户端直连后端」或极端大图，避免超大原图喂给模型导致推理失败。
// 远程 http(s) URL、解码/缩放失败的原图一律原样透传（不阻塞、不抛出），只有数量超限才报错。

const sharp = require('sharp');

const MAX_IMAGE_COUNT = 8; // 单次消息最多 8 张
const MAX_IMAGE_LONG_EDGE = 1280; // 像素最长边上限（与客户端一致）
const IMAGE_JPEG_QUALITY = 80; // 缩放后 JPEG 质量（与客户端一致）

// 返回 { error } 或 { images }。
async function normalizeImages(images) {
  if (images.length > MAX_IMAGE_COUNT) {
    return { error: `单次最多发送 ${MAX_IMAGE_COUNT} 张图片，请分批发送。` };
  }
  const out = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    // 远程 URL（模型自行拉取）不做服务端处理，原样透传。
    if (typeof img !== 'string' || !img.startsWith('data:')) {
      out.push(img);
      continue;
    }
    const comma = img.indexOf(',');
    if (comma === -1) {
      out.push(img);
      continue;
    }
    const base64 = img.slice(comma + 1);
    let buf;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      out.push(img);
      continue;
    }
    try {
      const image = sharp(buf);
      const meta = await image.metadata();
      const longEdge = Math.max(meta.width || 0, meta.height || 0);
      if (longEdge > MAX_IMAGE_LONG_EDGE) {
        const resized = await image
          .resize({
            width: MAX_IMAGE_LONG_EDGE,
            height: MAX_IMAGE_LONG_EDGE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: IMAGE_JPEG_QUALITY })
          .toBuffer();
        out.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
        console.warn(
          `[image] 服务端自动缩放第 ${i + 1} 张：原 ${meta.width}x${meta.height} → 最长边≤${MAX_IMAGE_LONG_EDGE}`,
        );
      } else {
        // 像素未超限：保留原图，避免无意义转码导致质量损失。
        out.push(img);
      }
    } catch (e) {
      console.warn(`[image] 第 ${i + 1} 张解码/缩放失败，回退原图：`, e && e.message);
      out.push(img);
    }
  }
  return { images: out };
}

module.exports = { normalizeImages, MAX_IMAGE_COUNT, MAX_IMAGE_LONG_EDGE, IMAGE_JPEG_QUALITY };
