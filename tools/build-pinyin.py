"""生成 assets/pinyin.json：每只宝可梦的中文名 → 全拼 + 首字母。

用法：python tools/build-pinyin.py
依赖：pypinyin（构建期一次性，运行时不依赖）

产物结构（按 id 索引，值 = [全拼, 首字母]）：
    {"1": ["miaowazhongzi", "mwzz"], "25": ["pikaqiu", "pkq"], ...}

多音字用 pypinyin 的默认读音；宝可梦译名里没有需要特殊纠正的（如「乐」在名字里都读 le）。
"""

import json
import sys
from pathlib import Path

from pypinyin import Style, lazy_pinyin

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DEX = ROOT / "assets" / "pokedex.json"
OUT = ROOT / "assets" / "pinyin.json"


def main() -> None:
    dex = json.loads(DEX.read_text(encoding="utf-8"))
    items = dex["items"] if isinstance(dex, dict) else dex

    table: dict[str, list[str]] = {}
    for it in items:
        zh = (it.get("zh") or "").strip()
        if not zh:
            continue
        syllables = lazy_pinyin(zh, style=Style.NORMAL, errors="ignore")
        full = "".join(syllables).lower()
        ini = "".join(s[0] for s in syllables if s).lower()
        if full:
            table[str(it["id"])] = [full, ini]

    OUT.write_text(
        json.dumps(table, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"已生成 {OUT.relative_to(ROOT)}：{len(table)} 条，{OUT.stat().st_size / 1024:.1f} KB")
    for pid in ("1", "25", "150", "1008"):
        if pid in table:
            print(f"  #{pid:>4}  {table[pid]}")


if __name__ == "__main__":
    main()
