# -*- coding: utf-8 -*-
"""按世代分组的简表（同聊天里那张），输出成图片。

风格刻意保持朴素：白底、细线、无颜色块——用来核对数据，不做海报。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"C:\Users\xzy\Desktop\工作区\pokepet")
OUT = ROOT / "data" / "unsupported.png"

BG = (255, 255, 255)
HEAD_BG = (246, 247, 249)
LINE = (214, 218, 224)
TEXT = (23, 26, 33)
MUTED = (110, 116, 128)

GEN_NAME = {1: "关都", 2: "城都", 3: "丰缘", 4: "神奥", 5: "合众",
            6: "卡洛斯", 7: "阿罗拉", 8: "伽勒尔", 9: "帕底亚"}
GEN_RANGE = [(1, 151), (152, 251), (252, 386), (387, 493), (494, 649),
             (650, 721), (722, 809), (810, 905), (906, 1025)]
S = 2


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

    rows = []
    for g in range(1, 10):
        ids = [i for i in missing if gen_of(i) == g]
        if not ids:
            continue
        txt = "、".join(f"{dex[i]['zh']} {dex[i]['no']}" for i in ids)
        rows.append((f"第 {g} 世代", str(len(ids)), txt))
    rows.append(("合计", str(len(missing)), "第 1～4、6 世代一只不缺，全部支持"))

    W = 1520 * S
    M = 56 * S
    C1, C2 = 170 * S, 90 * S
    C3 = W - M * 2 - C1 - C2

    f_head = font("msyhbd.ttc", 21)
    f_body = font("msyh.ttc", 19)
    f_body_b = font("msyhbd.ttc", 19)

    # 先量高度：第三列按宽度折行，优先断在「、」之后
    def wrap(text, fnt, width):
        lines, cur = [], ""
        for ch in text:
            if fnt.getlength(cur + ch) <= width:
                cur += ch
                continue
            cut = cur.rfind("、")
            if cut >= 0:
                lines.append(cur[:cut + 1])
                cur = cur[cut + 1:] + ch
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
        return lines

    pad_y = 18 * S
    heights, wraps = [], []
    for _, _, txt in rows:
        ls = wrap(txt, f_body, C3 - 32 * S)
        wraps.append(ls)
        heights.append(max(len(ls) * 32 * S, 56 * S) + pad_y * 2)

    title_h = 120 * S
    head_h = 60 * S
    H = title_h + head_h + sum(heights) + 70 * S

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((M, 40 * S), f"暂时不支持的宝可梦（{len(missing)} 只）", font=font("msyhbd.ttc", 30), fill=TEXT)
    d.text((M, 88 * S), "按世代分组，数字是图鉴编号",
           font=font("msyh.ttc", 16), fill=MUTED)

    y = title_h
    # 表头
    d.rectangle([M, y, W - M, y + head_h], fill=HEAD_BG)
    d.text((M + 24 * S, y + 16 * S), "世代", font=f_head, fill=MUTED)
    d.text((M + C1 + 24 * S, y + 16 * S), "数量", font=f_head, fill=MUTED)
    d.text((M + C1 + C2 + 24 * S, y + 16 * S), "宝可梦", font=f_head, fill=MUTED)
    y += head_h

    for (c1, c2, _), ls, h in zip(rows, wraps, heights):
        total = c1 == "合计"
        if total:
            d.rectangle([M, y, W - M, y + h], fill=(251, 251, 252))
        d.line([M, y + h, W - M, y + h], fill=LINE, width=1 * S)
        fnt = f_body_b if total else f_body
        d.text((M + 24 * S, y + pad_y + 2 * S), c1, font=fnt, fill=TEXT)
        d.text((M + C1 + 24 * S, y + pad_y + 2 * S), c2, font=fnt, fill=TEXT)
        ty = y + pad_y
        for ln in ls:
            d.text((M + C1 + C2 + 24 * S, ty), ln, font=fnt, fill=TEXT)
            ty += 32 * S
        y += h

    # 三条竖线
    for cx in (M, M + C1, M + C1 + C2, W - M):
        d.line([cx, title_h, cx, y], fill=LINE, width=1 * S)
    d.line([M, title_h, W - M, title_h], fill=LINE, width=1 * S)

    d.text((M, H - 46 * S),
           "素材来源：SpriteCollab community sprites（CC BY-NC 4.0）",
           font=font("msyh.ttc", 14), fill=MUTED)

    img.resize((W // S, H // S), Image.LANCZOS).save(OUT, optimize=True)
    print("已生成", OUT, W // S, "x", H // S)


if __name__ == "__main__":
    main()
