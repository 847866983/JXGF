from PIL import Image, ImageDraw
import shutil, os

build = r"D:\镜序工坊\build"
src_png = os.path.join(build, "icon.png")
src_ico = os.path.join(build, "icon.ico")
bak_png = os.path.join(build, "icon.square.png")

# 备份原图（仅首次）
if not os.path.exists(bak_png):
    shutil.copy2(src_png, bak_png)
    print("backup ->", bak_png)
else:
    print("backup exists, skip")

img = Image.open(bak_png).convert("RGBA")
w, h = img.size
print("size", w, h)

# 圆角半径（约 22%，接近 iOS 观感）
radius = round(w * 0.225)
SS = 4  # 超采样抗锯齿

# 生成圆角遮罩
mask = Image.new("L", (w * SS, h * SS), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([0, 0, w * SS - 1, h * SS - 1], radius=radius * SS, fill=255)
mask = mask.resize((w, h), Image.LANCZOS)

out = img.copy()
out.putalpha(mask)
out.save(src_png, "PNG")
print("rounded icon.png saved")

# 重新生成多尺寸 ICO（Pillow 会把 256 缩小生成各尺寸，保留透明圆角）
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
out.save(src_ico, format="ICO", sizes=sizes)
print("icon.ico saved sizes", sizes)
print("done")
