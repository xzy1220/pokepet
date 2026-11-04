# -*- coding: utf-8 -*-
"""批量把 PMD SpriteCollab 的「日常动作」抓下来裁好，供 1025 只桌宠使用。

和 pmd-build.py 的区别：
  - pmd-build.py 是单只、全 35 动作（调研用）
  - 本脚本是批量、只抓日常要用的动作（DAILY），并发下载，可断点续传

输出：
  app/pmd/NNN.json + app/pmd/NNN-{Action}-{Dir}.png
  data/pmd-batch-report.json  记录成功 / 不存在 / 失败

用法：
  python tools/pmd-batch.py --workers 16
  python tools/pmd-batch.py --from 1 --to 151        # 只补第一代
"""
import argparse
import json
import random
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(r"C:\Users\xzy\Desktop\工作区\pokepet")
CACHE = ROOT / "data" / "pmd-cache"
OUT = ROOT / "app" / "pmd"
REPORT = ROOT / "data" / "pmd-batch-report.json"

MIRRORS = [
    # raw 放第一位：jsDelivr 对大 PNG 现在一律 301 跳到 raw，白白多一次往返，
    # 而且在被限流时会挂在重定向上（实测并发跑几分钟后每个文件都要等满 max-time）。
    "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite",
    "https://cdn.jsdelivr.net/gh/PMDCollab/SpriteCollab@master/sprite",
    "https://raw.gitmirror.com/PMDCollab/SpriteCollab/master/sprite",
]

ROWS = {"S": 0, "E": 2, "N": 4, "W": 6}
DIR_ORDER = ["S", "E", "W", "N"]

# 日常要用的动作：待机、走、睡、坐、醒、点头、受击、吃、蹦、转圈、抬头、放电
DAILY = ["Idle", "Walk", "Sleep", "Sit", "Wake", "Nod", "Hurt", "Eat", "Hop", "Rotate", "LookUp", "Shock"]
DIRS = {"Walk": ["S", "E", "W", "N"]}
# 这四个动作按「四方向」出图，但打包成一张 PNG（纵向四行），避免文件数翻四倍。
# 宠物待机时会根据鼠标方位切到对应的行，看起来就是「转头看你」。
MULTI = set()   # 四方向打包已撤（跟随视角没用了），只出「朝下」
DEFAULT_DIRS = ["S"]

# --all-actions 时改成「XML 里写了什么就出什么」（35 个左右），只给少数几只开
ALL_ACTIONS = False

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def fetch(tail, dst, expect="png"):
    """tail 形如 0025/Idle-Anim.png；按镜像依次试。返回 True 表示拿到了。

    只按「文件非空」判断是不够的：镜像被限流时会返回 200 + 一小段错误文本，
    文件非空但根本不是图片/XML，后面解析就炸。所以要校验文件魔数。
    """
    if dst.exists() and _valid(dst, expect):
        return True
    if dst.exists():
        dst.unlink()
    dst.parent.mkdir(parents=True, exist_ok=True)
    for m in MIRRORS:
        # --ssl-no-revoke 是必须的：这台机器默认会做证书吊销检查，
        # 直连 raw.githubusercontent 会报 CRYPT_E_NO_REVOCATION_CHECK 直接失败；
        # 另外 jsDelivr 对深层路径的 PNG 会 301 跳到 raw，跟着跳同样需要这个开关。
        subprocess.run(["curl.exe", "-sL", "--ssl-no-revoke", "--max-time", "40",
                        "-o", str(dst), f"{m}/{tail}"], check=False)
        if dst.exists() and _valid(dst, expect):
            return True
        if dst.exists():
            dst.unlink()
        time.sleep(random.uniform(0.05, 0.25))
    return False


def _valid(p, expect):
    try:
        if p.stat().st_size < 64:
            return False
        head = p.read_bytes()[:8]
    except OSError:
        return False
    if expect == "png":
        return head.startswith(b"\x89PNG")
    if not (head.startswith(b"<?xml") or head.startswith(b"\xef\xbb\xbf<?xml")):
        return False
    # 被中断的 curl 会留下「开头像 XML、后面是残片」的半截文件，光看开头的魔数不够
    try:
        return b"</AnimData>" in p.read_bytes()
    except OSError:
        return False


def build_one(pid, prefix=""):
    """返回 (状态, 详情)。状态：'ok' / 'missing' / 'fail'。

    prefix 是形态子目录（如 "0002" 或 "0000/0000/0002"）：有些宝可梦根目录什么都没有，
    素材全在形态目录里，例如 #668 火炎狮 在 sprite/0668/0000/0000/0002/。
    """
    base = f"{pid:04d}/{prefix + '/' if prefix else ''}"
    tail_xml = f"{base}AnimData.xml"
    xml = CACHE / f"{pid:04d}" / "AnimData.xml"
    if not fetch(tail_xml, xml, "xml"):
        return ("missing", pid)

    try:
        root = ET.parse(xml).getroot()
        info = {}
        copies = {}
        for a in root.find("Anims"):
            name = a.findtext("Name")
            copyof = (a.findtext("CopyOf") or "").strip()
            if name and copyof:
                # 有些动作不单独出图，只在 XML 里写「复制自哪个动作」，
                # 例如 #015 大针蜂 / #266 甲壳茧 的 Idle 就是 <CopyOf>Walk</CopyOf>
                copies[name] = copyof
            fw, fh = a.findtext("FrameWidth"), a.findtext("FrameHeight")
            durs = a.find("Durations")
            # 有些动作（事件睡、躺平等）在 XML 里只占位、不写帧宽高，直接跳过
            if not name or not fw or not fh or durs is None:
                continue
            pts = [d.text for d in durs if d.text]
            if not pts:
                continue
            info[name] = {"fw": int(fw), "fh": int(fh), "durs": [int(d) for d in pts]}
    except Exception as e:
        return ("fail", f"{pid} xml 解析失败 {type(e).__name__}: {e}")

    # 别名表：name → 真正有图的动作名（CopyOf 链条解析一次即可，社区里没有多级套娃）
    alias = {n: b for n, b in copies.items() if n not in info and b in info}

    result = {"id": pid, "anims": {}}
    idle_h = None
    made = []

    if ALL_ACTIONS:
        names = list(info.keys())
        names += [k for k in alias if k not in info]
    else:
        names = DAILY

    for name in names:
        # 没有独立文件时按 CopyOf 找替代（Idle 常常就是「复制自 Walk」）
        src = name if name in info else alias.get(name)
        if not src:
            continue
        meta = info[src]
        if not meta.get("fw") or not meta.get("fh"):
            continue   # XML 里少数动作只有 Name、没有帧宽高（昏睡/躺平），跳过
        png = CACHE / f"{pid:04d}" / f"{src}-Anim.png"
        if not fetch(f"{base}{src}-Anim.png", png, "png"):
            continue
        try:
            sheet = Image.open(png).convert("RGBA")
        except Exception:
            continue

        n = max(1, sheet.width // meta["fw"])
        n = min(n, len(meta["durs"]))
        if n < 1 or sheet.height < meta["fh"]:
            continue

        want = DIRS.get(name, DIR_ORDER if name in MULTI else DEFAULT_DIRS)

        if name in MULTI and len(want) > 1:
            # 四个方向先各自取包围盒，再求并集，用同一个纵向区间裁所有行：
            # 这样四行等高、脚底在同一水平线上，切换方向时不会上下跳。
            band, rows_ok = None, []
            for tag in want:
                r = ROWS[tag]
                if (r + 1) * meta["fh"] > sheet.height:
                    continue
                probe = sheet.crop((0, r * meta["fh"], meta["fw"] * n, (r + 1) * meta["fh"]))
                bb = probe.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
                if not bb:
                    continue
                rows_ok.append(tag)
                band = bb if band is None else (min(band[0], bb[0]), min(band[1], bb[1]),
                                                max(band[2], bb[2]), max(band[3], bb[3]))
            if len(rows_ok) > 1 and band and band[3] - band[1] >= 2:
                tile_h = band[3] - band[1]
                tiles = []
                for tag in rows_ok:
                    r = ROWS[tag]
                    tiles.append(sheet.crop((0, r * meta["fh"] + band[1],
                                             meta["fw"] * n, r * meta["fh"] + band[3])))
                stacked = Image.new("RGBA", (tiles[0].width, tile_h * len(tiles)))
                for i, tl in enumerate(tiles):
                    stacked.alpha_composite(tl, (0, i * tile_h))
                fn = f"{pid:03d}-{name}-all.png"
                stacked.save(OUT / fn, optimize=True)
                base_entry = {
                    "file": fn,
                    "w": stacked.width,
                    "h": tile_h,
                    "rowH": tile_h,
                    "fw": meta["fw"],
                    "frames": n,
                    "frameMs": [round(d * 1000 / 60) for d in meta["durs"][:n]],
                }
                for i, tag in enumerate(rows_ok):
                    e = dict(base_entry)
                    e["row"] = i
                    result["anims"].setdefault(name, {})[tag] = e
                made.append(fn)

                if name == "Idle" and "S" in rows_ok:
                    idle_h = tile_h
                    first = stacked.crop((0, 0, stacked.width, tile_h))
                    union = None
                    for i in range(n):
                        cell = first.crop((i * meta["fw"], 0, (i + 1) * meta["fw"], tile_h))
                        b = cell.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
                        if not b:
                            continue
                        union = b if union is None else (
                            min(union[0], b[0]), min(union[1], b[1]),
                            max(union[2], b[2]), max(union[3], b[3]))
                    if union:
                        result["hit"] = {"fw": meta["fw"], "stripH": tile_h,
                                         "x0": union[0], "y0": union[1],
                                         "x1": union[2], "y1": union[3]}
                continue

        for tag in want:
            r = ROWS[tag]
            if (r + 1) * meta["fh"] > sheet.height:
                continue
            row = sheet.crop((0, r * meta["fh"], meta["fw"] * n, (r + 1) * meta["fh"]))
            # 横向保留完整「帧数 × 帧宽」，只按纵向裁掉空白
            bb = row.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
            if not bb:
                continue
            row = row.crop((0, bb[1], row.width, bb[3]))
            if row.height < 2:
                continue

            fn = f"{pid:03d}-{name}-{tag}.png"
            row.save(OUT / fn, optimize=True)
            result["anims"].setdefault(name, {})[tag] = {
                "file": fn,
                "w": row.width,
                "h": row.height,
                "rowH": row.height,
                "row": 0,
                "fw": meta["fw"],
                "frames": n,
                "frameMs": [round(d * 1000 / 60) for d in meta["durs"][:n]],
            }
            made.append(fn)

            if name == "Idle" and tag == "S":
                idle_h = row.height
                union = None
                for i in range(n):
                    cell = row.crop((i * meta["fw"], 0, (i + 1) * meta["fw"], row.height))
                    b = cell.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
                    if not b:
                        continue
                    union = b if union is None else (
                        min(union[0], b[0]), min(union[1], b[1]),
                        max(union[2], b[2]), max(union[3], b[3]))
                if union:
                    result["hit"] = {"fw": meta["fw"], "stripH": row.height,
                                     "x0": union[0], "y0": union[1], "x1": union[2], "y1": union[3]}

    if "Idle" not in result["anims"]:
        return ("missing", f"{pid} 无 Idle")

    if idle_h:
        result["idleH"] = idle_h
    (OUT / f"{pid:03d}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf8")
    return ("ok", f"{pid} {len(made)} 帧文件 {len(result['anims'])} 动作")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="lo", type=int, default=1)
    ap.add_argument("--to", dest="hi", type=int, default=1025)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--skip", default="", help="逗号分隔的 id，已有更全的构建结果（如 25 有 35 动作）")
    ap.add_argument("--retry", action="store_true", help="只重跑上次报告里 missing/fail 的 id")
    ap.add_argument("--ids", default="", help="逗号分隔的 id 列表，只跑这些")
    ap.add_argument("--prefix", default="", help="形态目录，写法 668=0000/0000/0002,870=0002")
    ap.add_argument("--all-actions", action="store_true",
                    help="按 XML 出全部动作（约 35 个），只给少数几只开")
    args = ap.parse_args()

    global ALL_ACTIONS
    ALL_ACTIONS = bool(args.all_actions)

    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    skip = {int(x) for x in args.skip.split(",") if x.strip()}
    if args.ids.strip():
        ids = [int(x) for x in args.ids.split(",") if x.strip() and int(x) not in skip]
        log(f"指定 {len(ids)} 只")
    elif args.retry and REPORT.exists():
        old = json.loads(REPORT.read_text("utf8"))
        retry_ids = set(old.get("missing", []))
        for f in old.get("fail", []):
            try:
                retry_ids.add(int(str(f).split()[0]))
            except ValueError:
                pass
        ids = sorted(i for i in retry_ids if i not in skip)
        log(f"重跑 {len(ids)} 只：{ids[:20]}{' ...' if len(ids) > 20 else ''}")
    else:
        ids = [i for i in range(args.lo, args.hi + 1) if i not in skip]
    ok, missing, fail = [], [], []
    prev = None
    if args.retry and REPORT.exists():
        prev = json.loads(REPORT.read_text("utf8"))
    done = 0
    prefixes = {}
    for item in args.prefix.split(","):
        if "=" in item:
            k, v = item.split("=", 1)
            prefixes[int(k.strip())] = v.strip().strip("/")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(build_one, pid, prefixes.get(pid, "")): pid for pid in ids}
        for fut in as_completed(futs):
            pid = futs[fut]
            done += 1
            try:
                status, detail = fut.result()
            except Exception:
                status, detail = "fail", f"{pid} {traceback.format_exc(limit=1)}"
            if status == "ok":
                ok.append(pid)
            elif status == "missing":
                missing.append(pid)
            else:
                fail.append(detail)
            if done % 50 == 0:
                log(f"[{done}/{len(ids)}] ok={len(ok)} missing={len(missing)} fail={len(fail)}")

    if prev:   # 重跑模式：和上次报告合并，成功的从 missing/fail 里剔掉
        ok = sorted(set(prev.get("ok", [])) | set(ok))
        fixed = set(ok)
        old_missing = set(prev.get("missing", []))
        old_fail = []
        for f in prev.get("fail", []):
            try:
                if int(str(f).split()[0]) not in fixed:
                    old_fail.append(f)
            except ValueError:
                old_fail.append(f)
        missing = sorted((old_missing | set(missing)) - fixed)
        fail = old_fail + fail

    ok.sort()
    missing.sort()
    REPORT.write_text(json.dumps({"ok": ok, "missing": missing, "fail": fail}, ensure_ascii=False, indent=1), "utf8")
    total = sum(f.stat().st_size for f in OUT.glob("*.png"))
    log(f"\n完成：成功 {len(ok)}，不存在 {len(missing)}，失败 {len(fail)}")
    log(f"app/pmd 合计 {total/1024/1024:.1f} MB / {len(list(OUT.glob('*.png')))} 个帧文件")
    if missing:
        log("不存在：" + ",".join(map(str, missing[:40])) + (" ..." if len(missing) > 40 else ""))


if __name__ == "__main__":
    main()
