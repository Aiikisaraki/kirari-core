const sharp = require('sharp');

(async () => {
  // 1) 造一张远超上限的大图（3000x2000）
  const big = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${big.toString('base64')}`;
  console.log('原图 base64 长度(KB):', Math.round(dataUrl.length / 1024));

  // 2) 复刻 socketServer.normalizeImages 的核心逻辑
  const comma = dataUrl.indexOf(',');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const image = sharp(buf);
  const meta = await image.metadata();
  console.log('解码元信息:', meta.width + 'x' + meta.height, 'format=' + meta.format);

  const MAX_IMAGE_LONG_EDGE = 1280;
  if (Math.max(meta.width, meta.height) > MAX_IMAGE_LONG_EDGE) {
    const resized = await image
      .resize({ width: MAX_IMAGE_LONG_EDGE, height: MAX_IMAGE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const rmeta = await sharp(resized).metadata();
    console.log('缩放后:', rmeta.width + 'x' + rmeta.height, 'format=' + rmeta.format, 'KB=' + Math.round(resized.length / 1024));
    console.log('RESULT: 像素级缩放生效 (原 ' + meta.width + 'x' + meta.height + ' -> ' + rmeta.width + 'x' + rmeta.height + ')');
  } else {
    console.log('RESULT: 未触发缩放（逻辑有误）');
    process.exit(1);
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
