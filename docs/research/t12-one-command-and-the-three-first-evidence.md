# 事实底稿：一条命令起完整外壳，以及"从来没有真实证据"的三件事（票 #12）

**问题**：票 #12 的三条验收，今天各自成立还是不成立？

- 一条命令即可启动完整桌面外壳：自己拉起 DSH、**不抢端口**（系统挑空闲端口）、**不打开系统默认浏览器**
- 仓库里有一份与用户故事对应的验收清单
- 用户按清单能逐条验证：视图跟随、Agent 全功能驱动、登录态、任务空间隔离、人机共驾

**结论（先给答案，下面每一条都有原始输出）**

| 验收 | 今天的现状 | 证据在哪 |
|---|---|---|
| 1 一条命令起完整外壳 | **票前不成立（缺口），本次修好**：`npm run shell` 只起外壳 + 内置夹具，**根本没有 DSH** | §1（票前原始输出）§2（改了什么）§3（改后原始输出） |
| 1a 自己拉起 DSH | **已成立**：真 `dsh` 子进程、真界面读回、插件在启动图里 | §3.2 |
| 1b 不抢端口 | **已成立**：两个外壳同时起，六个端口两两不同，且端口持有者从操作系统读回 | §4 |
| 1c 不打开系统默认浏览器 | **成立，但只能证到"间接"**：开关在真 argv 里、DSH 那句"要开浏览器了"没出现、树里没有浏览器进程；**"屏幕上没多一个窗口"没有任何口子能观察** | §5 |
| 2 验收清单 | 本次新增 `docs/acceptance-checklist.md`（README 给入口） | 清单自身 |
| 3 用户逐条验证 | 清单里每一条都标了**谁验的**；其中三条"从来没有真实证据"的，两条本次自动化、一条只能用户与 Agent 对话 | §6 |

日期 2026-09-16。仓库起点 `7f4f1e5`（= `origin/main`），`npm test` 起点 12 文件 / 125 用例全绿（181.60s，本次实测）。

**本次没有碰用户的东西**：`%USERPROFILE%\.dsh` 一个字节没改（每个真宿主用例都现搭临时 `DSH_HOME`）；
用户自己那个外壳进程（PID 20980，`--dsh --view-url https://www.bing.com`）全程没动过；
本次起过的 electron / dsh 进程都收干净了（§7.4）。

---

## 1. 票前：`npm run shell` 到底起的是什么 —— **它不起 DSH**

票前 `package.json`：

```json
"shell": "electron shell/main.js"
```

`shell/main.js` 里 DSH 只在一个分支里被拉起（`shell/main.js:1128`）：

```js
if (options.useDsh) {           // ← 只有 argv 里有 --dsh 才为真
  const argv = ['--profile', options.dshProfile, '--no-open', '--port', '0']
  ...
  const dshUrl = await startHostProcess({ cdpUrl, targetId: resolved.targetId, viewUrl })
```

所以票前那条命令**回放**起来是这样（今天等价于 `npm run shell:fixture`；`--user-data-dir` 只是把档案挪到临时目录，不影响结论）：

```pwsh
npm run shell:fixture -- --user-data-dir %TEMP%\dsh-t12-before-fixture
```

stdout 原文（节选，全文里**没有** `DSH_SHELL DSH_ARGV`、**没有** `DSH_SHELL DSH_URL`、**没有** `dsh web:`）：

```
DSH_SHELL CDP {"cdpUrl":"http://127.0.0.1:58238"}
DSH_SHELL PROXY {"partition":"persist:dsh-view","readings":{"external":…}}
DSH_SHELL SPACES {"protocol":1,"requestId":0,"error":null,"active":"default",…}
DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"http://127.0.0.1:58238","targetId":"F03C8AA0…",
   "targetUrl":"http://127.0.0.1:58239/view", … "fixtureOrigin":"http://127.0.0.1:58239", …}
```

同一刻的进程树（`Get-CimInstance Win32_Process`，按父子关系展开）——**没有任何 `dsh` 进程**：

```
cmd.exe /d /s /c electron shell/main.js --user-data-dir …\dsh-t12-before-fixture
└ "node" …\node_modules\.bin\..\electron\cli.js shell/main.js --user-data-dir …
  └ electron.exe shell/main.js --user-data-dir …
    ├ --type=gpu-process
    ├ --type=utility --utility-sub-type=network.mojom.NetworkService
    ├ --type=renderer … -client-id=4
    └ --type=renderer … -client-id=5
```

**两块窗口里装的是内置夹具**（`/shell` 与 `/view`），不是 DSH 界面。

这不只是"少了个 `--dsh`"：插件面板在没有外壳时给用户的**唯一那句指引**写的正是这条命令
（`src/client-body.js` 的 `COPY.zh/en.noShell`：*"在仓库里运行 npm run shell 起它，这一格就会
显示真正的浏览器视图"*，`tests/no-shell.spec.ts` 断言它必须含 `npm run shell`）。
按那句指引去做的人，拿到的是一壳夹具 + 一个永远装不上插件的宿主 —— 一句**说到做不到的指引**，
和票 #11 要挡的"静默失效"是同一类东西。所以本票把它改成真的（§2）。

---

## 2. 改了什么：把"一条命令"做成真的（两行 `package.json`）

```json
"shell": "electron shell/main.js --dsh",
"shell:fixture": "electron shell/main.js"
```

- `npm run shell` 现在就是票面要的那条命令：**自己拉起 DSH**（`dsh --profile dshviewer --no-open --port 0`）、
  **让系统挑端口**、**不开系统浏览器**；面板文案与 README 里那句 `npm run shell` 从此是真的。
- 夹具那条路没有消失，改名 `npm run shell:fixture`（README 里也写了）。测试完全不受影响：
  它们直接 spawn Electron 二进制，从不经过 npm 脚本。
- **没有**改 `shell/main.js` 的任何行为，也**没有**改 `src/`（所以本次不需要 `npm run build`）。

> 判断留痕：把 `--dsh` 放进默认脚本，意味着"想只看夹具"的人要换一条命令。取舍是
> **面向用户的那条命令必须真的能起完整外壳**（票面验收 1 的原文），而夹具只是开发者的内部工具。

---

## 3. 改后：一条命令起完整桌面外壳（`tests/acceptance.spec.ts` 的原始输出）

用例：`票 #12 · 一条命令起完整桌面外壳 > 外壳自己拉起了 DSH：界面读得回，插件在启动图里，bundle 端得出来`。

命令就是用户会敲的那一条（`--user-data-dir` 是测试的隔离手段；`DSH_HOME` 指向临时 harness home）：

```
npm run shell -- --user-data-dir <临时档案目录>
```

### 3.1 这条命令真实 spawn 出来的进程树（操作系统读回）

```
node.exe npm-cli.js run shell -- --user-data-dir …\dsh-t12-shell-kHI5rR
└ cmd.exe /d /s /c electron shell/main.js --dsh --user-data-dir …\dsh-t12-shell-kHI5rR
  └ "node" …\node_modules\.bin\..\electron\cli.js shell/main.js --dsh --user-data-dir …
    └ electron.exe shell/main.js --dsh --user-data-dir …
      ├ --type=gpu-process / --type=utility / --type=renderer ×2
      └ cmd.exe /d /s /c "dsh --profile dshviewer --no-open --port 0"        ← 外壳自己拉起的宿主
        └ "node" F:\claude code\global\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dshviewer --no-open --port 0
```

关键点：`cmd.exe /d /s /c "dsh --profile dshviewer --no-open --port 0"` 这一行**是操作系统说的**，
不是外壳自己打印的（外壳另外也打了一行，见 §3.3；两条互相独立）。

### 3.2 那个 DSH 真的端出了界面（DSH 自己的 HTTP 回答）

```
{"status":200,"grantStatus":303,"cookies":1,"htmlChars":27888,
 "bootListsPlugin":true,
 "bootEntry":"…{\"id\":\"dsh-desktop-view\",\"url\":\"/plugins/??dsh-desktop-view/client.js&rev=8ab054b70762fac0-48\",\"rev\":\"8ab054b70762fac0-48\",\"inject\":[],\"immediately\":true}…",
 "clientUrl":"/plugins/??dsh-desktop-view/client.js&rev=8ab054b70762fac0-48",
 "clientStatus":200,"clientIsThisPlugin":true}
```

`?token=` → `303` + `Set-Cookie` → 带 cookie 取 `/` → `200`，启动图里有本插件，客户端 bundle 端得出来
且内容里是本插件的 id。**这是"插件在真宿主里挂得上"的第一层**（第二层见 §6.1）。

### 3.3 那份身份与 argv（外壳自己说的，与 §3.1 互为独立读回）

```
DSH_SHELL DSH_ARGV {"command":"dsh","argv":["--profile","dshviewer","--no-open","--port","0"]}
DSH_SHELL HOST_STDOUT {"text":"dsh web: http://127.0.0.1:63366/?token=…\n"}
DSH_SHELL DSH_URL {"url":"http://127.0.0.1:63366/?token=…"}
```

`dsh web: http://…` 是 **DSH 自己**打印的那一行（外壳把它原样转发出来）。

### 3.4 窗口里装的**确实**是 DSH 的界面（从窗口自己那一页读回）

上面两条证的是"DSH 在某个地址上端出了界面"；握手与 `DSH_URL` 都在 `loadURL` **之前**打印，
所以"窗口里显示的是 DSH"是**另一件事**，得单独读。按握手里的 `windowTargetId` 连到外壳窗口那一页：

```json
{"href":"http://127.0.0.1:57921/","title":"DeepSeek Harness","bodyElements":4,"bodyChars":271}
```

⇒ 窗口的 origin 就是 DSH 的 origin（`?token=` 已经换成 cookie，所以路径是 `/`），标题是 DSH 自己的
`DeepSeek Harness`，页面里已经渲染出内容；而内置夹具页在 `<夹具 origin>/shell` 上，两者不可能混。
用例：`tests/acceptance.spec.ts` › *外壳的窗口里装的确实是 DSH 的界面，不是内置夹具页*。

---

## 4. 「不抢端口」的行为证明

票面提醒得对：**只断言 argv 里有个 `0` 不算证明**（本项目吃过"argv 断言把 bug 锁死"的亏）。
所以这里有两条互相独立、且都能被反证的证据。

### 4.1 六个端口两两不同，而且各自有主（操作系统读回）

两个外壳**同时**跑（B 在 A 还活着的时候起），各自的 DSH 都真的端出了界面：

```
{"a":{"cdp":"http://127.0.0.1:62965","dsh":"http://127.0.0.1:55389/?token=…",
      "target":"891BEC289E5E51B5EDC82D1B79DD3F6B","fixture":"http://127.0.0.1:62966","alive":true},
 "b":{"cdp":"http://127.0.0.1:56789","dsh":"http://127.0.0.1:51567/?token=…",
      "target":"439302B7CFE48F3724A70E48C6E9B167","fixture":"http://127.0.0.1:56790","alive":true}}
RAW the six ports: {"dshA":"55389","dshB":"51567","cdpA":"62965","cdpB":"56789","fixtureA":"62966","fixtureB":"56790"}
RAW view titles read back through each shell own endpoint: ["view-page","view-page"]
```

两个界面都 `200`、都在启动图里带本插件；两块视图各自连得上、页面标题都读得回
（`targetId` 与夹具 origin 两两不同）。**"谁都没把谁挤掉"在这里是行为事实，不是推断。**

### 4.2 真正绑上的端口，持有者是那棵树里的进程

单外壳那份读回（`Get-NetTCPConnection -State Listen` 按 pid 过滤）：

```
RAW listening ports of that tree: [{"address":"127.0.0.1","port":63366,"pid":32732},
                                  {"address":"127.0.0.1","port":60529,"pid":60200},
                                  {"address":"127.0.0.1","port":60528,"pid":60200}]
RAW who listens on that port: {"address":"127.0.0.1","port":63366,"pid":32732}
```

`63366` 是 DSH 地址里那个端口，`32732` 正是上面那棵树里的 `dsh/lib/bin.js` 进程；
`60528`（CDP）与 `60529`（内置夹具）都属于外壳自己。
三个端口都是**回环**地址，都是**进程自己绑上的**（端口号各不相同、都 > 1024）。

> 反证能力：把 `--port 0` 改成固定端口，或者让两个外壳共用一个端口，
> §4.1 的六个端口就会撞、（若被挤掉）§4.1 的某个界面就不会是 `200`。

### 4.3 顺带量到的一件事：**两个外壳共用同一个档案目录**（`npm run shell` 连敲两次的默认形状）

`npm run shell` 的默认档案目录是 `%APPDATA%\dsh-desktop-shell`（实测：用户自己那个外壳
PID 20980 的渲染进程命令行里就是 `--user-data-dir="C:\Users\zhangtianyi\AppData\Roaming\dsh-desktop-shell"`），
所以"连敲两次"= 两个 Chromium 进程抢一个档案目录。这次用**临时**目录复现同一件事
（不碰用户正在跑的那个外壳的档案）：

```
A: DSH url = http://127.0.0.1:53916/?token=…
A: alive = true
--- 现在起第二个外壳，用**同一个** --user-data-dir ---
B: booted = true | alive = true | exitCode = null
A: 仍活着 = true
A UI: {"grant":303,"status":200,"boot":true,"plugin":true}
B UI: {"grant":303,"status":200,"boot":true,"plugin":true}
两个 DSH 端口: 53916 52404
```

**两个都起来了、两个界面都读得回、端口不撞** —— 但第二个外壳的 stderr 是这样的（原文，重复多次）：

```
[9044:ERROR:net\disk_cache\cache_util_win.cc:25] Unable to move the cache: 拒绝访问。 (0x5)
[9044:ERROR:net\disk_cache\disk_cache.cc:290] Unable to create cache
[9044:ERROR:gpu\ipc\host\gpu_disk_cache.cc:737] Gpu Cache Creation failed: -2
```

第一个外壳的 stderr 里没有这些。⇒ **共用档案目录不是干净用法**：磁盘缓存被两个进程抢，
而且两个外壳还会同时打开**同一个** `persist:dsh-view` partition（登录态就在那个罐子里）。
本次**没有**测"两个进程同时写同一个 cookie 库会不会坏"——不该用用户的登录态去做这个实验。

**结论（写进了 README 与清单）**：两个外壳同时跑要用**各自的** `--user-data-dir`；
共用默认目录"能用"，但第二个外壳的缓存是坏的。

---

## 5. 「不打开系统默认浏览器」：**能**证明什么、**不能**证明什么

**能证明的（三条，全部自动断言）**

1. 真 argv 里有 `--no-open`（§3.1 的进程表原文），而 DSH 自己对这个开关的定义是
   "do not open the Web UI in the default browser"：
   `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-app\lib\startup.js:22`
   ```js
   .option("--no-open", "do not open the Web UI in the default browser")
   .option("--port <port>", "listen port; pass 0 to let the OS pick a free one")
   ```
2. **反过来那句提示没有出现**：不用 `--no-open` 时 DSH 会打印
   `dsh web: opening the default browser; pass --no-open to disable`
   （同包 `lib/index.js:205`）。整份外壳输出（含转发的子进程 stdout/stderr）里搜这句话，命中为空。
3. 外壳这棵树里**没有任何浏览器进程**（`msedge|chrome.exe|firefox|brave|opera|safari` 命中为空）。

**不能证明的（诚实条目）**：这里**没有任何口子能观察"屏幕上没有多出一个浏览器窗口"**。
反证需要真的去掉 `--no-open` 跑一次，而那次会**真的打开用户的浏览器**（在用户桌面上留一个窗口、
并且用的是他的默认浏览器），代价不该由一次自动化测试来付。所以：

- 自动化只断言上面三条（它们合起来排除了"外壳让 DSH 去开浏览器"这条路径）；
- **"我这儿没有蹦出浏览器窗口"由用户本人看一眼**（清单里是 👤 项）。

---

## 6. 三件"从来没有真实证据"的事，这次各自走到哪一步

### 6.1 ① 插件在**有外壳的**真宿主里挂得上 + 宿主 `ctx.tools` 注册表本体 —— **本次自动化了**

T10 证的是"**没有**外壳时能加载"，而且读回的是**插件自己**调了 `ctx.tools.register()`
（它自己记的账），宿主那一侧的注册表本体从来没被读过。这次用一个**只读探针插件**
（`tests/fixtures/dsh-probe/`，以额外 bundle 的形式装进临时 profile）在真宿主里问宿主自己：

```js
ctx.tools.schemas()   // 宿主服务自己的方法：这个 scope 能看见的全部工具
ctx.tools.get('browser_navigate')
```

原始结果（`atMs: 1760`，也就是宿主起来 1.8 秒后）：

```json
{"step":"registry","count":20,"names":["browser_click","browser_diagnostics","browser_dialog",
 "browser_download","browser_drag","browser_evaluate","browser_extract","browser_hover","browser_json",
 "browser_navigate","browser_press_key","browser_screenshot","browser_scroll","browser_select",
 "browser_snapshot","browser_space","browser_type","browser_type_keys","browser_upload","browser_wait"],
 "byGet":{"browser_navigate":true,"browser_screenshot":true,"browser_space":true}}
```

**20 条 `browser_*` 全部在宿主的注册表里**，而且是**外壳起着**的那个宿主
（探针同时读到了外壳交给载体的身份：`cdpUrl=http://127.0.0.1:53166`、
`spacesDir=…\dsh-t12-probe-shell-7Vz73M\spaces`）。
T10 §1.4 那条"读不回来、只能靠间接支撑"的诚实条目，**在有外壳这一侧关掉了**；
无外壳那一侧（`tests/no-shell.spec.ts`）仍然只读到插件自己那一段——但那不是本票的范围。

### 6.2 ② 截图真的送到模型面前 —— **自动化了"送到门口"，最后一步仍要用户**

T5 的证据用的是一枚**测试替身** store（`saveImage` 是测试自己实现的），真实
`LocalAttachmentStore` 从没跑过。这次让探针经**宿主注册表**执行 `browser_screenshot`，
再用 `ctx.attachments.readImage()` 把图片**读回来**（这个读回会按内容寻址的摘要校验字节）：

```json
{"attachmentId":"sha256:8d0f2aa6a3f683448cc2e23f05961fecdc2c2e702c5ab7b921b9e8ba81f4d54d",
 "mediaType":"image/png","width":660,"height":1200,
 "declaredBytes":13999,"readBackBytes":13999,
 "pngMagic":[137,80,78,71,13,10,26,10]}
```

而模型会收到的那份 `content` 也在报告里（工具结果的模型面）：

```json
[{"type":"text","text":"Screenshot saved to: …\\probe-screenshot.png"},
 {"type":"image","attachment":{"attachmentId":"sha256:8d0f2aa6…","mediaType":"image/png",
  "bytes":13999,"width":660,"height":1200,"name":"browser-1789502452290.png"}}]
```

⇒ **图片真的作为图片内容块交付、真的落在部署自己的附件 store 里、真的能按引用校验读回。**
**没验到的那一步**：模型**真的"看见"了这张图**——那要一次真的 agent 轮次
（凭据 + 网络 + 花费），本票不做，写进清单让用户与 Agent 对话去验（清单 §9.2）。

### 6.3 ③ 真实 DSH Agent 真的能调工具驱动那一格 —— **自动化到"同一条管线"，差一个模型**

T1–T10 的全部证据都来自夹具与替身，**没有一次是真实会话里的 Agent 调用**。这次探针走的不是
`ToolDefinition.execute`（那是绕开管线的捷径），而是 **`ctx.tools.execute({callId,name,arguments,signal})`**
——注册表自己的完整管线（参数快照 → policy → dispatch → 结果归一化），和模型发起的调用同一条路：

```
browser_evaluate  → {"url":"http://127.0.0.1:53167/view","title":"view-page"}      （页面自己说的）
browser_snapshot  → elements:1  [{"ref":1,"role":"button","name":"hit me",bounds…}]
browser_click     → {"ok":true,"message":"clicked ref 1"}
browser_extract   → "…hit me initial-view"   →   "…hit me clicked-view"             （页面真的变了）
browser_space     → {"active":"default","spaces":[{"name":"default", … }]}
```

⇒ 在**外壳起着的真宿主**里，工具**真的驱动了那一格**：点击落在那块原生视图上、页面按夹具自己的
逻辑从 `initial-view` 变成 `clicked-view`。**没验到的那一步**：真的是**模型**决定去调它、
并把结果读进对话（同样要一次真 agent 轮次）——清单里交给用户（清单 §9.3）。

---

## 7. 本次改动与收尾

### 7.1 改了哪些文件

| 文件 | 改动 |
|---|---|
| `package.json` | `shell` 脚本加 `--dsh`（一条命令真的起完整外壳）；新增 `shell:fixture`（原来的夹具那条路） |
| `tests/acceptance.spec.ts` | **新增** 9 条用例：一条命令起完整外壳、不抢端口（两个外壳同时）、不打开系统浏览器、真宿主的注册表本体、经注册表驱动那一格、截图进真 store 并读回、任务空间通道 |
| `tests/fixtures/dsh-probe/` | **新增** 只读探针插件（`package.json` / `cordis.patch.yml` / `index.js`），装进临时 profile 用 |
| `tests/shell-harness.ts` | 新增 `resolveDshBinScript` / `repoPackageName` / `makeTempDshHome`（临时 `DSH_HOME`）/ `launchShellProcess`（可以跑**任意一条命令**并等握手，`startShell` 变成它的一层薄封装）/ `StartShellOptions.env` |
| `docs/acceptance-checklist.md` | **新增**：给用户看的验收清单（本次主要交付物）；每条标明谁验的，并写清本期不做的三条，以及 PRD 已要求但本期尚未实现、跟踪在 #13 的导航/缩放 |
| `README.md` | 新增"自己验收"入口；"直接用外壳"一节写清三条命令的分工（① 完整产品 `npm run shell`、② 离线夹具 `shell:fixture`、③ `npx electron shell/main.js` 的各种开关照旧）；写明两个外壳同时跑要各给一个档案目录 |
| `docs/research/t12-one-command-and-the-three-first-evidence.md` | 本文件 |

**没有改 `src/`**（因此不需要 `npm run build`，`client.js` 与两个源文件仍然同步）。

### 7.2 测试计数

- 票前：12 文件 / 125 用例（本次实测 181.60s，全绿）
- 票后：**13 文件 / 135 用例**（新增 `tests/acceptance.spec.ts` 的 10 条）
- 连续三次整包的结果（改动冻结之后，摘要原样贴出）：

```
RUN 1  Test Files  13 passed (13)   Tests  135 passed (135)   Duration  221.16s
RUN 2  Test Files  13 passed (13)   Tests  135 passed (135)   Duration  217.39s
RUN 3  Test Files  13 passed (13)   Tests  135 passed (135)   Duration  223.55s
```

三次都 `exit=0`；票前的 12 文件 / 125 用例一条都没红（零回归）。本票新增的
`tests/acceptance.spec.ts` 单独跑是 10 条 / 约 38 秒（它自己会起 4 个真 dsh 宿主：
`npm run shell` 一个、「不抢端口」两个、探针一个）。整包从 181.60s 涨到约 221s，涨的就是它。

### 7.3 诚实清单（本次**没能**验证到的）

1. **"没有打开系统默认浏览器窗口"本身**没有可观察的口子（§5）：只证到开关、那句提示不出现、
   树里没有浏览器进程。"我屏幕上没蹦出浏览器"只能用户看一眼。
2. **模型真的看见截图 / 真的自己发起工具调用**要一次真 agent 轮次（凭据 + 网络 + 花费），本次不做（§6.2、§6.3）。
3. **无外壳那一侧的宿主注册表**仍然读不回来（`tests/no-shell.spec.ts` 读的是插件自己那一段）：
   那条路要有外壳（§6.1 的做法）才成立。本票不改 T10 的结论。
4. **"视图跟随"里"浮动/停靠"这条用户故事（PRD #1 故事 5）**没有自动化：
   自动化的只有"面板报矩形/不报矩形"两种（T2）；真 DSH 里把标签浮动出去没有测过（清单里是 👤）。
5. **用户直接用鼠标键盘操作那一格**（选中/复制/右键/输入法/缩放，故事 30）没有自动化：
   它由"那一格是原生 `WebContentsView`"（T1/T2 已证）**在构造上**成立，但没有人真的试过输入法与缩放（清单里是 👤）。
6. **整套测试"无图形界面能不能跑"（故事 37）没有验证过**：本套件起的是真 Electron 真窗口，
   没有任何 headless 的跑法被试过。
7. **两个外壳同时跑时，两个宿主用的是两份独立 `DSH_HOME`**（测试的隔离手段）。
   共用**一个档案目录**的那一轮量过了（§4.3）：两个都能起来、界面都读得回，但第二个外壳的
   磁盘缓存报 `Unable to move the cache: 拒绝访问`；而"两个进程同时写同一个 cookie 库会不会坏"
   **没有测**（那要用登录态做实验）。README 与清单因此都建议"同时开两个就给两个档案目录"。
8. **`browser_screenshot` 的默认落盘目录是宿主进程的 cwd**（`screenshotDir` 默认 `.`）。
   用 `npm run shell` 从仓库根起外壳时，Agent 不给路径的截图会落在**仓库根**。
   这是既有行为（不在本票范围），本次只在探针里显式指定路径避免污染仓库；**没有改它**。
9. **PRD 故事 6 的"后退/前进/刷新"、故事 30 的"缩放"今天不存在**（`browser_navigate` 只有 `url`；
   `src/session.ts` 里没有 `goBack`/`goForward`/`reload`，也没有任何缩放手段）。
   这是**范围内漏做的功能**，不是"本期不做"；已跟踪在 **#13**（导航与缩放：Agent 工具 + 面板控件）。
   验收票不实现它，只如实写进清单第 11 节。
