# 宝可梦桌宠 (PokePet)

把 1025 只宝可梦放进 Windows 桌面 —— 一只像素小人站在任务栏上方，会走动、会打瞌睡、被摸头会点头、被拖起来会挣扎、饿了能喂树果。

> 非官方粉丝作品，与 Nintendo / Game Freak / The Pokémon Company 无关。
> 不售卖、不含任何付费内容。素材来自社区与 PokeAPI，版权归各自作者（见下方「素材来源」）。

| | |
|---|---|
| 图鉴 | 1025 只 |
| 有逐帧动作 | 987 只 |
| 动作总数 | 17,609 个 |
| 叫声 | 1025 个 |
| 体积 | 约 300 MB（含 Electron 运行时） |

---

## 普通用户：怎么装

**不要下载源码**（源码里没有素材，跑不起来）。去 [Releases](../../releases/latest) 下载 `PokePet-v0.1.0-win64.zip`，解压到任意目录，双击 `宝可梦桌宠.exe`。

**或者，让 AI 帮你装。** 把下面这句话发给任意能执行命令的 AI 助手：

```
帮我把这个 Windows 桌宠装上：下载
https://github.com/xzy1220/pokepet/releases/latest/download/PokePet-v0.1.0-win64.zip
解压到 %LOCALAPPDATA%\PokePet，在桌面创建快捷方式指向里面的 宝可梦桌宠.exe，然后启动它。
```

（把 `xzy1220/pokepet` 换成实际地址。）

首次运行 Windows 可能弹 SmartScreen「未知发布者」——因为没有代码签名证书，点「更多信息 → 仍要运行」即可。

---

## 怎么玩

| 操作 | 效果 |
|---|---|
| 左键点一下 | 点头打招呼 |
| 按住拖动 | 拎起来（会挣扎），松手放下 |
| 右键 | 选宝可梦 / 喂食 / 动作 / 跟随 / 归位 |
| 托盘图标左键 | 打开选宠器 |
| 托盘菜单 | 开机自启 / 支持一下 / 关于 / 退出 |

选宠器支持**中文名、编号、英文名、属性、拼音**搜索（`pkq` → 皮卡丘，`mwzz` → 妙蛙种子），可以星标收藏、只看收藏、只看有图。

---

## 开发者：从源码构建素材

仓库里不含 `app/pmd`（20,543 张动作帧）和 `app/cries`（1025 个叫声），体积太大。它们可以完全重建：

```powershell
# 1. 下载 PMD 原始素材（约 5,800 个文件，1 分钟）
python tools\prewarm.py

# 2. 切成每只宝可梦的动作条（约 8 分钟）
python tools\pmd-batch.py --all-actions --workers 8

# 3. 下载叫声（约 90 秒）
node tools\fetch-cries.mjs --max-id 1025 --concurrency 8

# 4. 生成选宠器卡片缩略图
python tools\build-cards.py

# 5. 生成拼音索引（需要 pip install pypinyin，仅构建期）
python tools\build-pinyin.py
```

跑完就有了完整素材，然后：

```powershell
# 开发态直接跑（需要 npm 装好的 electron，或者用任意 electron 43.x 运行时）
.\启动宠物.cmd
```

打包成可分发的 zip：

```powershell
powershell -ExecutionPolicy Bypass -File tools\package-release.ps1
```

---

## 目录结构

```
app\            主程序（main.js / pet.js / picker.js / 两个信息窗口）
  pmd\          动作帧（构建产物，约 20,543 张 PNG + 987 个 JSON 索引）
  cries\        叫声（1025 个，Ogg/MP3 混合）
assets\         选宠器卡片、树果图、图鉴索引、拼音索引、赞赏码
data\           运行时数据（config.json 记位置/收藏/行为参数；不入库）
tools\          构建与打包脚本
```

---

## 素材来源

- **动作帧**：[PMD SpriteCollab](https://github.com/PMDCollab/SpriteCollab)（社区重绘的《不可思议迷宫》风格素材），**CC BY-NC 4.0** —— 禁止商用。
- **叫声 / 图鉴数据**：[PokeAPI](https://github.com/PokeAPI/pokeapi)（CC BY 4.0）。
- **树果图标**：PokeAPI/sprites items。

素材版权归原作者所有。这里只是把社区素材免费用起来，不售卖、不含任何付费内容。
如果哪位作者不希望自己的作品出现在这里，联系我立刻下架。

---

## 许可

本仓库**代码**部分可自由使用、修改、分发；**素材**部分遵循各自的 CC 协议（尤其 PMD SpriteCollab 是 CC BY-NC 4.0，不可商用）。
