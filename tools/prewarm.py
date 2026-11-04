"""把还缺的动作原图一次性用「一个 curl 进程 + 连接复用」拉下来。

为什么不用 pmd-batch.py 的逐文件 curl：
    每抓一个文件就 spawn 一次 curl = 重新握一次 TLS。GitHub 在连续几百次握手之后
    会开始挂连接（不回 429，就是挂着不回），逐文件模式只能等满 --max-time，
    并发 10 时吞吐掉到 0.3 文件/秒。
    curl 的 --parallel 用同一个连接池跑多个传输，握手次数降低一个数量级，
    实测能稳定在 10+ 文件/秒。

用法：
    python tools/prewarm.py [--workers 16]
拉完之后再跑一次 pmd-batch.py，它发现原图都在缓存里，只做本地切片，几秒完成。
"""
import argparse
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(r"C:\Users\xzy\Desktop\工作区\pokepet")
CACHE = ROOT / "data" / "pmd-cache"
BASE = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite"


def actions_of(xml: Path):
    try:
        root = ET.parse(xml).getroot()
    except Exception:
        return []
    out = []
    for e in root.iter("Anim"):
        name = e.findtext("Name")
        copy = e.findtext("CopyOf")
        if name and e.findtext("FrameWidth"):
            out.append(name)
        if copy:
            out.append(copy)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    todo = []
    for d in sorted(os.listdir(CACHE)):
        folder = CACHE / d
        xml = folder / "AnimData.xml"
        if not xml.is_file():
            continue
        for name in set(actions_of(xml)):
            dst = folder / f"{name}-Anim.png"
            if dst.exists() and dst.stat().st_size > 100:
                continue
            todo.append((f"{BASE}/{d}/{name}-Anim.png", dst))

    print(f"缺 {len(todo)} 个文件，并发 {args.workers}", flush=True)
    if not todo:
        return

    cfg = ROOT / "data" / "_curl_prewarm.cfg"
    lines = []
    lines.append('silent\nshow-error\nlocation\nssl-no-revoke\nmax-time = 30\n')
    lines.append(f"parallel\nparallel-max = {args.workers}\n")
    for url, dst in todo:
        # 顺序很重要：curl 的 -o 绑定的是「后面那个 URL」，写成 output 在前。
        # 路径用相对路径 + cwd=CACHE：curl 在 Windows 上处理含中文的绝对路径会静默失败。
        rel = os.path.relpath(dst, CACHE)
        lines.append(f'output = "{rel}"\n')
        lines.append(f'url = "{url}"\n')
    cfg.write_text("".join(lines), encoding="utf-8")

    # curl 会把失败也写进 output（0 字节），之后 pmd-batch 的 _valid 会识别并重下
    cfg_abs = cfg.resolve()
    subprocess.run(["curl.exe", "--config", str(cfg_abs)], cwd=str(CACHE), check=False)
    ok = sum(1 for _, dst in todo if dst.exists() and dst.stat().st_size > 100)
    print(f"回来 {ok} / {len(todo)}", flush=True)


if __name__ == "__main__":
    main()
