# 让 AI 帮你装（给非技术用户看的一段话）

把下面**整段**复制给任意能执行命令的 AI 助手（DeepSeek、Claude、ChatGPT 带终端插件都行）。
它需要能在这台 Windows 上运行 PowerShell。

---

```
帮我把宝可梦桌宠装到这台电脑上，按下面步骤来，装完告诉我结果：

1. 下载这个文件（约 184 MB）：
   https://github.com/xzy1220/pokepet/releases/latest/download/PokePet-v0.1.0-win64.zip
2. 解压到 %LOCALAPPDATA%\PokePet（也就是 C:\Users\<你的用户名>\AppData\Local\PokePet）
3. 在桌面创建一个快捷方式，名字叫「宝可梦桌宠」，指向 PokePet.exe
4. 启动它

注意：这个 exe 没有代码签名，Windows 可能弹 SmartScreen「未知发布者」，
如果弹了就选「更多信息 → 仍要运行」。
```

上面的地址已经填好（`xzy1220/pokepet`）。如果以后换了仓库名，把这段里的两处 `xzy1220/pokepet` 一起改掉即可。

---

## 不想让 AI 动手？手动三步

1. 下载上面那个 zip
2. 解压到任意位置（别放 C:\Program Files，那里写不了配置）
3. 双击里面的 `PokePet.exe`

---

## 给 AI 用的脚本版（更稳）

仓库里带了一个安装脚本 `tools/install.ps1`，它会做完整流程（下载 → 解压 → 建快捷方式 → 启动）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1 `
  -Url "https://github.com/xzy1220/pokepet/releases/latest/download/PokePet-v0.1.0-win64.zip"
```

可选参数：

| 参数 | 作用 |
|---|---|
| `-Dest <路径>` | 装到别处，默认 `%LOCALAPPDATA%\PokePet` |
| `-NoShortcut` | 不建桌面快捷方式 |
| `-NoLaunch` | 装完不启动 |

脚本只做四件事：下载、解压、建快捷方式、启动。不写注册表、不装服务、不改系统设置。

---

## 卸载

删掉 `%LOCALAPPDATA%\PokePet` 文件夹和桌面快捷方式即可。
如果开过「开机自启」，先在托盘菜单里取消勾选，否则会留下一条指向已删除文件的启动项。
