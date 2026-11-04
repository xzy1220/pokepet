# -*- coding: utf-8 -*-
"""生成选宠器用的卡片小图：PMD 像素优先，没有 PMD 才退回水彩缩略图。

为什么要预生成：
  选宠器一次铺 1025 张卡。如果直接加载 640×360 的立绘，浏览器解码是
  按原始尺寸算的：640×360×4 ≈ 921 KB/张 → 1025 张差不多 1 GB 内存。
  预生成 64px 高的小图后，每张只用 80×64×4 ≈ 20 KB，合计约 20 MB。

尺寸约定：
  - 像素：Idle-S 第 0 帧 × 2 倍最近邻 = 80×60，下方补透明到 64 高
  - 水彩：按 alpha 包围盒裁紧，等比缩到 64 高
两者都在 64 高的框里按 1:1 显示，不做二次缩放。
"""
import json
import sys
from pathlib import Path

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"C:\Users\xzy\Desktop\工作区\pokepet")
PMD = ROOT / "app" / "pmd"
STAGE = ROOT / "assets" / "stage"
OUT = ROOT / "assets" / "card"

H = 64           # 卡片框高度
TARGET = 56      # 希望精灵本体占的高度（留一点上下余量）
MAX_W = 108      # 卡片宽度上限（.thumb 的 108px）


def pad_to(img, h=H):
    if img.height >= h:
        return img
    c = Image.new("RGBA", (img.width, h), (0, 0, 0, 0))
    c.alpha_composite(img, (0, h - img.height))   # 脚底对齐，和桌面上一样
    return c


def from_pmd(pid):
    j = PMD / f"{pid:03d}.json"
    if not j.exists():
        return None
    try:
        meta = json.loads(j.read_text("utf8"))
        v = meta["anims"]["Idle"]["S"]
        strip = Image.open(PMD / v["file"]).convert("RGBA")
        fw, h = v["fw"], v["h"]
        frame = strip.crop((0, 0, min(fw, strip.width), h))
        # 裁掉帧内空白，让小人占满卡片
        bb = frame.split()[3].point(lambda a: 255 if a > 8 else 0).getbbox()
        if bb:
            frame = frame.crop(bb)
        # 整数倍放大：小个子多放大几倍，大个子少放，保证卡片里大致同样饱满
        k = max(1, min(4, round(TARGET / max(1, frame.height))))
        img = frame.resize((frame.width * k, frame.height * k), Image.NEAREST)
        if img.width > MAX_W:
            sc = MAX_W / img.width
            img = img.resize((MAX_W, max(1, round(img.height * sc))), Image.NEAREST)
        return pad_to(img)
    except Exception as e:
        print(f"  {pid} pmd 卡片失败 {type(e).__name__}: {e}")
        return None


def from_stage(pid):
    p = STAGE / f"{pid:03d}.webp"
    if not p.exists():
        return None
    try:
        im = Image.open(p).convert("RGBA")
        bb = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
        if bb:
            im = im.crop(bb)
        sc = H / im.height
        img = im.resize((max(1, round(im.width * sc)), H), Image.LANCZOS)
        if img.width > MAX_W:
            img = img.resize((MAX_W, H), Image.LANCZOS)
        return img
    except Exception as e:
        print(f"  {pid} stage 卡片失败 {type(e).__name__}: {e}")
        return None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pmd_n = stage_n = none_n = 0
    stats = {"pmd": [], "stage": [], "none": []}
    for pid in range(1, 1026):
        img = from_pmd(pid)
        if img is not None:
            pmd_n += 1
            stats["pmd"].append(pid)
        else:
            img = from_stage(pid)
            if img is not None:
                stage_n += 1
                stats["stage"].append(pid)
            else:
                none_n += 1
                stats["none"].append(pid)
                continue
        img.save(OUT / f"{pid:03d}.png", optimize=True)

    total = sum(f.stat().st_size for f in OUT.glob("*.png"))
    (ROOT / "data" / "card-report.json").write_text(
        json.dumps(stats, ensure_ascii=False), "utf8")
    print(f"像素 {pmd_n}  水彩 {stage_n}  无图 {none_n}")
    print(f"{OUT} 合计 {total/1024/1024:.2f} MB / {len(list(OUT.glob('*.png')))} 张")
    if stats["none"]:
        print("无素材：" + ",".join(map(str, stats["none"][:40])))


if __name__ == "__main__":
    main()
