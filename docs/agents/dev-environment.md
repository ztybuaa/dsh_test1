# 开发环境须知（本机实测）

本文件记录在这台机器上开发时**会真实绊倒你**的环境事实。每条都有出处或实测依据。

## 1. 这里是 Windows PowerShell 5.1，不是 pwsh 7

`pwsh` **不在 PATH** 上；命令实际由 **Windows PowerShell 5.1** 执行。三个后果：

- **`Get-Content` 默认按 ANSI 解码**。用它在终端里打印一个 UTF-8 文件（尤其是中文）会看到乱码——**文件本身是好的**，只是读法错了。要判断文件是否真的坏，用能按 UTF-8 解码的读取方式。
- **`.ps1` 脚本文件如果没有 BOM，5.1 会按 ANSI 解析它**，于是脚本里的中文全部被写坏。含非 ASCII 的脚本**必须先加 UTF-8 BOM**：
  ```powershell
  $p = 'path\to\script.ps1'
  $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($p))
  [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))
  ```
- 给外部命令（`gh` 等）传中文标题时用 `--body-file` 传文件，比把中文放进命令行参数更稳。

## 2. GitHub 的可达性是分片的，而且是间歇的

实测（同一时刻）：

| 目标 | 结果 |
|---|---|
| `api.github.com` | ✅ 通（200） |
| `raw.githubusercontent.com` | ✅ 通 |
| `github.com`（网页 HEAD 请求） | ❌ 超时 |
| **`github.com:443`（`git push` 走的就是这里）** | ❌ **有时连不上**（`Failed to connect to github.com port 443`），有时又通 |

**含义**：`gh` 的 API 操作（建 issue、读仓库）通常没问题；**`git push` 会间歇性失败**。失败时不要判定为配置错误，**重试**即可。

**GitHub Releases 直连下载基本不可用**（超时），所以任何从 Releases 抓二进制的事都要走镜像。

## 3. 下 Electron 必须走镜像

| 镜像 | 实测吞吐 |
|---|---|
| `https://mirrors.huaweicloud.com/electron/` | ✅ **约 10 MB/s**（首选） |
| `https://registry.npmmirror.com/-/binary/electron/` | ⚠️ 约 0.4 KB/s（等同不可用） |
| `https://npmmirror.com/mirrors/electron/` | ⚠️ 约 0.4 KB/s |

```pwsh
$env:ELECTRON_MIRROR = 'https://mirrors.huaweicloud.com/electron/'
```

注意：**`electron` 的 npm 包本身能装**（npm registry 是通的），失败的只是它 postinstall 去 GitHub Releases 抓那个约 150 MB 二进制的步骤。所以"包装上了但没有 `dist/`"就是这个原因。

**已经校验过的现成产物**：`G:\electron-mirror\electron-v44.3.0-win32-x64.zip`，150.82 MB，SHA256 `26bf9a617d58d81772b3d68305d59ee48272969c15083c06db634a77358a8d9d`，与 `electron@44.3.0` 包内 `checksums.json` 一致。

**为什么 `.npmrc` 里的 `electron_mirror=` 确实生效**（源码依据）：`@electron/get` 的 `dist/artifact-utils.js:20-34` 的 `mirrorVar()` **第一个**就读 `process.env.npm_config_electron_mirror`，而 npm 正是把 `.npmrc` 的 `electron_mirror` 转成这个环境变量。所以镜像键不必再另外设 `ELECTRON_MIRROR`。

**缓存已经命中**：`%LOCALAPPDATA%\electron\Cache` 里已经躺着 `electron-v44.3.0-win32-x64.zip`（150.82 MB）。因此后续的 `npm install` **通常不需要再下载**，直接从缓存解包。判断"下载是否真的在跑"要看这个缓存目录与 `node_modules/electron/dist` 是否出现，而不是看安装耗时。

`electron` 的 `install.js` 判定"已安装"的条件是：`dist/version` 等于包版本 **且** `path.txt` 内容为 `electron.exe`（win32）**且** `dist/electron.exe` 存在。三者满足时它会直接 `exit 0`，**不再联网**——所以手工把二进制摆到位也是一个合法解。

## 4. 一次性原型的存放约定

探针/原型一律放在**仓库外**，并且**沿用探针目录而不修改它**（它是结论的凭据）。已知的两个：

- `G:\dsh-electron-probe\` —— 原生视图 × CDP 的可行性探针（结论见 `docs/research/electron-native-view-cdp-probe.md`）
- `G:\electron-mirror\` —— 校验过的 Electron 二进制

## 5. npm 能装，但不代表官方 registry 可达

实测（同一时刻）：`registry.npmjs.org` **超时**，`registry.npmmirror.com` **通**。

好消息是 `npm config get registry` **已经指向** `https://registry.npmmirror.com`，所以 **`npm install` 不受影响**——失败的只是"直连官方 registry"。需要显式指定时用 `npm install --registry=https://registry.npmmirror.com`。

**不要**把"`registry.npmjs.org` 打不开"误判成"npm 装不了东西"。

## 6. Playwright 的浏览器缓存已经存在，而且本项目根本不需要浏览器

`%LOCALAPPDATA%\ms-playwright` 已有约 **711 MB** 缓存：`chromium-1234` 426.7 MB、`chromium_headless_shell-1234` 270.8 MB、`ffmpeg-1011`、`winldd-1007`、`daemon`。所以 `npm install` 里 playwright 那一步通常**不需要真的下载浏览器**。

本项目**从不 `launch` 任何浏览器**——它只 `connectOverCDP` 连外壳里那块原生视图。因此即使缓存为空，也可以直接跳过浏览器下载：

```pwsh
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
```

（也可写进仓库 `.npmrc` 的 `playwright_skip_browser_download=1`。但**不要**为这条去打断一个正在正常进行的安装。）
