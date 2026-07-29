from PIL import Image, ImageDraw, ImageFont
import os

W, H = 164, 314

# 创建渐变背景
img = Image.new('RGB', (W, H), '#1e3a8a')
draw = ImageDraw.Draw(img)

for y in range(H):
    # 顶部深蓝 #1e3a8a -> 中部紫 #7c3aed -> 底部粉 #db2777
    if y < H // 2:
        t = y / (H / 2)
        r = int(30 + (124 - 30) * t)
        g = int(58 + (51 - 58) * t)
        b = int(138 + (237 - 138) * t)
    else:
        t = (y - H / 2) / (H / 2)
        r = int(124 + (219 - 124) * t)
        g = int(51 + (39 - 51) * t)
        b = int(237 + (119 - 237) * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b))

# 顶部装饰圆（角色头像占位）
cx, cy, r = W // 2, 90, 42
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill='#ffffff', outline='#fde68a', width=3)

# 猫耳三角形
ear_w, ear_h = 18, 28
draw.polygon([(cx - r + 6, cy - r + 10), (cx - r - 8, cy - r - ear_h), (cx - r + 14, cy - r + 4)], fill='#ffffff', outline='#fde68a')
draw.polygon([(cx + r - 6, cy - r + 10), (cx + r + 8, cy - r - ear_h), (cx + r - 14, cy - r + 4)], fill='#ffffff', outline='#fde68a')

# 脸部元素
# 眼睛
eye_r = 4
draw.ellipse([cx - 16 - eye_r, cy - 4 - eye_r, cx - 16 + eye_r, cy - 4 + eye_r], fill='#1e1b4b')
draw.ellipse([cx + 16 - eye_r, cy - 4 - eye_r, cx + 16 + eye_r, cy - 4 + eye_r], fill='#1e1b4b')
# 腮红
draw.ellipse([cx - 22 - 3, cy + 6 - 2, cx - 22 + 3, cy + 6 + 2], fill='#f9a8d4')
draw.ellipse([cx + 22 - 3, cy + 6 - 2, cx + 22 + 3, cy + 6 + 2], fill='#f9a8d4')
# 嘴
draw.arc([cx - 6, cy + 2, cx + 6, cy + 12], start=0, end=180, fill='#1e1b4b', width=2)

# 文字
try:
    font_title = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 18)
    font_sub = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 12)
except Exception:
    font_title = ImageFont.load_default()
    font_sub = ImageFont.load_default()

# 标题
title = 'Aki Kirari'
bbox = draw.textbbox((0, 0), title, font=font_title)
tw = bbox[2] - bbox[0]
draw.text(((W - tw) // 2, 160), title, fill='#ffffff', font=font_title)

# 副标题
sub = '桌宠伴侣'
bbox = draw.textbbox((0, 0), sub, font=font_sub)
tw = bbox[2] - bbox[0]
draw.text(((W - tw) // 2, 188), sub, fill='#e9d5ff', font=font_sub)

# 底部小装饰线
draw.rounded_rectangle([42, 240, W - 42, 244], radius=2, fill='#ffffff', outline=None)

out_path = 'build-resources/icons/installer-sidebar.bmp'
img.save(out_path, 'BMP')
print(f'Saved {out_path} ({W}x{H})')
