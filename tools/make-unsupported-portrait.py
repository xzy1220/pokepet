# -*- coding: utf-8 -*-
"""暂时不支持的宝可梦 —— 竖屏版（1080×1920，9:16）。

同样的数据、同样的朴素风格，只是换成手机能直接看的长图排版：
按世代分块，块内两列排名字，编号右对齐。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"C:\Users\xzy\Desktop\工作区\pokepet")
OUT = ROOT / "data" / "unsupported-portrait.png"

BG = (255, 255, 255)
HEAD_BG = (246, 247, 249)
LINE = (214, 218, 224)
TEXT = (23, 26, 33)
MUTED = (110, 116, 128)

W, H = 1080, 1920
M = 72                      # 左右留白
S = 2                       # 超采样

GEN_RANGE = [(1, 151), (152, 251), (252, 386), (387, 493), (494, 649),
             (650, 721), (722, 809), (810, 905), (906, 1025)]


def gen_of(i):
    for n, (a, b) in enumerate(GEN_RANGE, 1):
        if a <= i <= b:
            return n
    return 0


def font(name, size):
    return ImageFont.truetype(str(Path(r"C:\Windows\Fonts") / name), size * S)


def main():
    dex = {d["id"]: d for d in json.loads((ROOT / "assets" / "pokedex.json").read_text("utf8"))["items"]}
    missing = json.loads((ROOT / "data" / "card-report.json").read_text("utf8"))["none"]

    groups = []
    for g in range(1, 10):
        ids = [i for i in missing if gen_of(i) == g]
        if ids:
            groups.append((g, [dex[i] for i in ids]))

    img = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(img)

    f_title = font("msyhbd.ttc", 46)
    f_sub = font("msyh.ttc", 22)
    f_sec = font("msyhbd.ttc", 36)
    f_cnt = font("msyh.ttc", 24)
    f_name = font("msyhbd.ttc", 24)
    f_no = font("msyh.ttc", 20)
    f_foot = font("msyh.ttc", 17)

    # ---------- 头部 ----------
    y = 96 * S
    d.text((M * S, y), "暂时不支持的宝可梦", font=f_title, fill=TEXT)
    y += 66 * S
    nw = d.textlength(f"{len(missing)} 只", font=f_title)
    d.text((W * S - M * S - nw, y - 66 * S), f"{len(missing)} 只", font=f_title, fill=(224, 74, 74))
    d.text((M * S, y), "按世代分组，数字是图鉴编号", font=f_sub, fill=MUTED)

    # ---------- 表格区尺寸 ----------
    y += 52 * S
    table_top = y
    footer_h = 96 * S
    avail = (H - footer_h) * S - table_top

    sec_h = 62 * S                                  # 每个世代的小标题行
    rows_needed = sum((len(items) + 1) // 2 for _, items in groups)
    row_h = (avail - sec_h * len(groups)) // rows_needed
    row_h = max(52 * S, min(row_h, 84 * S))
    col_w = (W * S - M * 2 * S - 28 * S) // 2

    # 底纹：整个表格区
    d.rounded_rectangle([M * S, table_top - 18 * S, (W - M) * S, table_top + sec_h * len(groups) + row_h * rows_needed + 14 * S],
                        16 * S, fill=(252, 252, 253), outline=LINE, width=1 * S)

    y = table_top
    for gi, (g, items) in enumerate(groups):
        # 小标题：第 N 世代 · 13 只
        d.text((M * S + 26 * S, y + 12 * S), f"第 {g} 世代", font=f_sec, fill=TEXT)
        label = f"{len(items)} 只"
        lw = d.textlength(label, font=f_cnt)
        d.text(((W - M) * S - 26 * S - lw, y + 22 * S), label, font=f_cnt, fill=MUTED)
        y += sec_h
        if gi < len(groups) - 1:
            d.line([M * S + 26 * S, y - 6 * S, (W - M) * S - 26 * S, y - 6 * S], fill=LINE, width=1 * S)

        for k, it in enumerate(items):
            col, row = k % 2, k // 2
            cx = M * S + 26 * S + col * (col_w + 28 * S)
            cy = y + row * row_h
            ny = cy + (row_h - 30 * S) // 2
            d.text((cx, ny), it["zh"], font=f_name, fill=TEXT)
            # 编号紧跟在名字后面，不右对齐——否则「编号」和「下一个名字」会像一对
            nx = cx + d.textlength(it["zh"], font=f_name) + 12 * S
            d.text((nx, ny + 4 * S), str(it["no"]), font=f_no, fill=MUTED)
        y += ((len(items) + 1) // 2) * row_h

    # ---------- 页脚 ----------
    fy = (H - 62) * S
    d.line([M * S, fy - 22 * S, (W - M) * S, fy - 22 * S], fill=LINE, width=1 * S)
    d.text((M * S, fy), "第 1～4、6 世代全部支持", font=f_foot, fill=TEXT)
    src = "素材来源：SpriteCollab community sprites（CC BY-NC 4.0）"
    sw = d.textlength(src, font=f_foot)
    d.text(((W - M) * S - sw, fy), src, font=f_foot, fill=MUTED)

    img.resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print("已生成", OUT, W, "x", H)


if __name__ == "__main__":
    main()
