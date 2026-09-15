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

`electron` 的 `install.js` 判定"已安装"的条件是：`dist/version` 等于包版本 **且** `path.txt` 内容为 `electron.exe`（win32）**且** `dist/electron.exe` 存在。三者满足时它会直接 `exit 0`，**不再联网**——所以手工把二进制摆到位也是一个合法解。

## 4. 一次性原型的存放约定

探针/原型一律放在**仓库外**，并且**沿用探针目录而不修改它**（它是结论的凭据）。已知的两个：

- `G:\dsh-electron-probe\` —— 原生视图 × CDP 的可行性探针（结论见 `docs/research/electron-native-view-cdp-probe.md`）
- `G:\electron-mirror\` —— 校验过的 Electron 二进制
