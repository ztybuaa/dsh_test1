# 事实底稿：`browser_screenshot` 不带 `path` 时到底落在哪（票 #16）

**问题**：票 #16 —— `Config` 里 `screenshotDir: z.string().default('.')`，而 `'.'` 是**宿主 `dsh`
进程的当前工作目录**。用本仓库推荐的那条命令启动时（`npm run shell`，从仓库根运行），宿主是外壳
的子进程、cwd 继承而来，于是 Agent 每截一张图，**仓库根就多一个 `browser-<时间戳>.png`**。

**现场证据**（票上那条评论，2026-09-16）：用户实测那一轮之后，仓库根留下两个未跟踪文件
`browser-1789515887356.png`（440073 字节）/ `browser-1789515909594.png`（439465 字节）。
本次**没有动它们**：`git status --porcelain` 里它们还是 `??`，一次都没被提交。

**结论（先给答案，下面每一条都有原始输出）**

| 问题 | 答案 | 证据在哪 |
|---|---|---|
| 默认值改成什么 | **`<外壳档案目录>/screenshots`**，与下载（`<档案目录>/downloads`，ADR-0011）对称 | §2、§4 |
| 档案目录从哪来 | 外壳发布的空间状态 `state.json` 里的 `userDataDir` —— **没有新增任何通道** | §1、§4 |
| 拿不到档案目录时 | **`<系统临时目录>/dsh-desktop-view-screenshots`**（系统临时目录下的专用子目录） | §2、§3 |
| 显式配置还管用吗 | 管用，而且**永远优先** | §3、§5 |
| 不再落进 cwd 这件事怎么被读回 | 两半：① 外壳的 cwd 指到临时目录起真外壳 + 真宿主，探针**自己报** `process.cwd()`；② **真的从仓库根**跑了一次 `npm run shell --dsh`，仓库根列表跑前跑后逐项相同 | §5（绿）、§5.1（票面那句话）、§6（红） |
| 截图还是附件吗 | 是：部署自己的 store 存进又读回（13999 字节、PNG 魔数），返回的路径指向的就是那个落盘文件 | §5 |

日期 2026-09-17。仓库起点 `0f7436e`（= `origin/main`），`npm test` 起点 **14 文件 / 144 用例全绿**
（213.74s，本次实测）。本次**没有碰**用户自己的 `~/.dsh`（每个真宿主用例都现搭临时 `DSH_HOME`），
也没碰用户自己那个外壳进程。

---

## 1. 为什么档案目录只能从 `state.json` 读

外壳起宿主时交给它的环境变量只有四样（`shell/main.js:430`，`--dsh` 分支）：

```js
const argv = ['--profile', options.dshProfile, '--no-open', '--port', '0']
const child = spawn(options.dshCommand, argv, {
  env: {
    ...process.env,
    [ENV_CDP]: handshake.cdpUrl,        // DSH_DESKTOP_VIEW_CDP
    [ENV_TARGET]: handshake.targetId,   // DSH_DESKTOP_VIEW_TARGET
    [ENV_URL]: handshake.viewUrl,       // DSH_DESKTOP_VIEW_URL
    [ENV_SPACES]: state.spaceChannel.dir, // DSH_DESKTOP_VIEW_SPACES
  },
```

**`userDataDir` 不在其中**。它发布在两个地方：

1. 握手那一行 stdout（`DSH_DESKTOP_VIEW_HANDSHAKE {... "userDataDir": …}`）—— 那是给**启动外壳的人**
   看的，插件进程读不到；
2. **空间状态的 `state.json`**，字段 `userDataDir`（`shell/main.js:972`），外壳在**发布握手之前**
   就把它落盘了（`shell/main.js:1163` 的注释写明了这个顺序），而 `state.json` 的目录正是
   `DSH_DESKTOP_VIEW_SPACES` 指的通道目录 —— 插件本来就在读那个文件。

所以本票选的是第 2 条：`userDataDirFromSpaceState(stateFile)` 用**已有的** `parseSpaceState`
读出这个字段。**不需要新通道、不需要新环境变量、不需要改外壳。**

> 另一条能走但没走的路：`dirname(spacesDir)` 也能算出档案目录（通道目录就是 `<档案目录>/spaces`）。
> 不走它的理由与本仓库既有的一条规矩一致 —— **读外壳写下的那句话，而不是从别处推断**
> （`SpaceRecord` 的注释里对 `partition` vs `storagePath` 说过同一件事）。

## 2. 三条规则（`src/screenshots.ts`，纯函数）

```ts
export function resolveScreenshotDir(input: { configured?: string; userDataDir?: string }): ScreenshotDirChoice
```

| 顺序 | 结果 | `source` | 什么时候走这条 |
|---|---|---|---|
| 1 | `resolve(configured)` | `configured` | `screenshotDir` 非空（空串/纯空白算**没配**：`''` 的意思不可能是"当前目录"） |
| 2 | `<档案目录>/screenshots` | `shell-profile` | 没配，而且外壳发布了档案目录 |
| 3 | `<系统临时目录>/dsh-desktop-view-screenshots` | `fallback` | 既没配、也没有档案目录（例如没跑外壳） |

**为什么第 2 条是它**：档案目录是"这一格的档案"，与下载同一个归属（ADR-0011 已经为下载定过：
`<userDataDir>/downloads`）；截图与下载是同一类东西（Agent 产生的、人要找的文件），两条决定对称
比各自发明一套好。而且它是**人的目录**：`npm run shell` 起的那一轮里，用户翻 `%APPDATA%` 下那个
profile 就能看见 `screenshots\`，不是散落在"他敲命令的地方"。

**为什么第 3 条是它**：那种情况下确实没有更合适的归属地；系统临时目录下的**专用**子目录名自带归属
（`%TEMP%` 是几千进程共用的地方，一个叫 `screenshots` 的裸目录是谁的都说不清）。

**`process.cwd()` 不在任何一条里。** 这一点由两条纯逻辑用例钉住（§3 第 4 条）。

## 3. 原始输出：纯逻辑（不起外壳）

```
stdout | 票 #16 · 默认截图目录的判断（纯逻辑，不起外壳） > 显式配置永远优先：给了 screenshotDir 就以它为准
RAW configured wins: {"dir":"D:\\shots","source":"configured"}

stdout | … > 没配就落在外壳档案目录下的 screenshots：与下载（<档案>/downloads）对称
RAW the shell profile decides: {"dir":"C:\\fake-profile\\screenshots","source":"shell-profile"}

stdout | … > 连档案目录都拿不到时，落到系统临时目录下的**专用**子目录（兜底说清楚）
RAW the fallback: {"dir":"C:\\Users\\ZHANGT~1\\AppData\\Local\\Temp\\dsh-desktop-view-screenshots","source":"fallback"}

stdout | … > 反证：两个默认值都不许是宿主进程的 cwd
RAW the host cwd this test process has: G:\dsh_test1
```

命令：

```pwsh
npx vitest run --config vitest.config.ts tests/screenshot-dir.spec.ts -t "纯逻辑"
# ✓ tests/screenshot-dir.spec.ts (9 tests | 3 skipped) 31ms
#      Tests  6 passed | 3 skipped (9)
```

"读外壳发布的状态"那一半的每一种读不动的形状（**一律 `undefined`，不抛**）：

```
RAW userDataDir read from the published state: {"file":"…\\dsh-t16-state-…\\good.json","read":"C:\\published-profile"}
RAW unreadable state: {"why":"no channel configured"}
RAW unreadable state: {"why":"the state file does not exist yet","file":"…\\absent.json"}
RAW unreadable state: {"why":"the file is not JSON","file":"…\\broken.json"}
RAW unreadable state: {"why":"the state names no profile directory","file":"…\\no-profile.json"}
RAW unreadable state: {"why":"the file is not a state the shell published","file":"…\\half.json"}
```

读不动就是**兜底**，不是"外壳不在"：所以它返回 `undefined` 由 §2 的第 3 条接住，不抛异常。

## 4. 独立读回：外壳的 cwd 指到临时目录，起真外壳 + 真宿主

票面那条验收（"从仓库根跑 `npm run shell` 后让 Agent 截一张图，仓库根不新增任何文件"）如果**照字面**
做，一次回归就会往仓库里写一张 PNG —— 正是本票要消灭的东西。所以同一件事被搬到**临时目录**上做，
那个临时目录就是"仓库根"的替身：

```ts
// tests/screenshot-dir.spec.ts
cwd = mkdtempSync(join(tmpdir(), 'dsh-t16-cwd-'))
shell = await startShell(['--dsh'], {
  cwd,                                   // ← 宿主 dsh 是外壳的子进程，cwd 继承而来
  userDataDir: profile,                  // 临时档案目录
  env: { DSH_HOME: home.home, DSH_T12_PROBE_OUT: probeFile, DSH_T12_PROBE_TIMEOUT_MS: '180000' },
  // **刻意不设** DSH_T12_PROBE_SHOT：探针于是调一次**不带 path** 的 browser_screenshot
})
probe = await waitForProbe(probeFile, HOST_TIMEOUT_MS)
afterProbe = readdirSync(cwd)
```

三件事**分行**读回，谁也不替谁作证：

1. **那个 cwd 是什么** —— 由**宿主进程自己**报（探针 `shellEnvironment.cwd = process.cwd()`），
   不是用例推算的。这条是前提：cwd 是继承来的，"用例以为自己指到哪"不算事实。
2. **cwd 里有没有新文件** —— 起外壳**之前**列一次，探针跑完**之后**再列一次，两次逐项相同。
3. **图片落在哪** —— 返回的路径与"外壳自己在握手里说的档案目录 + `screenshots`"逐项相同；
   而且那个文件真的存在、字节数与 PNG 尺寸是**从磁盘读回来**的。

`cwd` 这个开关是新加的（`StartShellOptions.cwd`，`tests/shell-harness.ts`）：默认仍是仓库根，
票 #12 那条"照 README 抄的命令"一个字都没变。

## 5. 原始输出：绿的那一次

```
RAW the host cwd, as the host itself reports it: "C:\\Users\\ZHANGT~1\\AppData\\Local\\Temp\\dsh-t16-cwd-oRvT6w"
RAW the substitute-repo cwd before/after: {"cwd":"…\\dsh-t16-cwd-oRvT6w","beforeStart":[],"afterProbe":[]}
RAW browser_screenshot (no path) returned: {"tool":"browser_screenshot","arguments":{},"isError":false,
  "value":{"path":"…\\dsh-t16-profile-LIbNFN\\screenshots\\browser-1789521203310.png",
           "image":{"attachmentId":"sha256:8d0f2aa6…","mediaType":"image/png","bytes":13999,"width":660,"height":1200,
                    "name":"browser-1789521203310.png"}},
  "content":[{"type":"text","text":"Screenshot saved to: …\\dsh-t16-profile-LIbNFN\\screenshots\\browser-1789521203310.png"},
             {"type":"image","attachment":{…}}]}
RAW the shell handshake said its profile is: C:\Users\ZHANGT~1\AppData\Local\Temp\dsh-t16-profile-LIbNFN

RAW cwd comparison: {"reported":"…\\dsh-t16-cwd-oRvT6w","expected":"…\\dsh-t16-cwd-oRvT6w"}
RAW where it landed vs where the shell profile says it should:
  {"shotPath":"…\\dsh-t16-profile-LIbNFN\\screenshots\\browser-1789521203310.png",
   "expected":"…\\dsh-t16-profile-LIbNFN\\screenshots\\browser-1789521203310.png"}
RAW the file on disk, parsed here: {"bytes":13999,"declaredBytes":13999,"width":660,"height":1200}
RAW attachment read-back: {"attachmentId":"sha256:8d0f2aa6…","mediaType":"image/png","width":660,"height":1200,
  "declaredBytes":13999,"readBackBytes":13999,"pngMagic":[137,80,78,71,13,10,26,10]}
```

```
 ✓ tests/screenshot-dir.spec.ts (9 tests) 8861ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  9.35s
```

读的时候注意这几处：

- `beforeStart` 与 `afterProbe` **都是空数组** —— 宿主整轮**一个文件都没往 cwd 里写**；
- 路径里的 `dsh-t16-profile-LIbNFN` 是**档案目录**，与 cwd（`dsh-t16-cwd-oRvT6w`）是两棵树；
- `declaredBytes`（附件声明的）与磁盘上那个文件的字节数都是 **13999**，`readBackBytes` 也是 13999：
  路径指向的**就是**交付给模型的那张图，路径没有被藏起来，也没有指向别的东西；
- 整个 spec 文件 **9.35 秒**（一次真外壳 + 一次真宿主启动），加进整包是可以接受的。

## 5.1 票面那句话，真的跑了一次：从仓库根 `npm run shell -- --dsh`

自动化那半条把 cwd 换成了临时目录（§4 说了为什么）。为了不让"仓库根本不新增文件"只停在推理上，
这次**照票面字面**跑了一遍：工作目录 = `G:\dsh_test1`，命令就是用户会敲的那条，临时 `DSH_HOME`
里装上本插件与探针，**不设** `DSH_T12_PROBE_SHOT`。这一轮不进套件（它真往仓库根跑），原始输出：

```
BEFORE repo root entries: .git, docs, lib, node_modules, scripts, shell, src, tests, .gitignore, .npmrc,
  AGENTS.md, browser-1789515887356.png, browser-1789515909594.png, client.js, CONTEXT.md, cordis.patch.yml,
  package-lock.json, package.json, README.md, tsconfig.json, vitest.config.ts
started pid 38152 : npm run shell -- --user-data-dir "…\dsh-t16-manual-profile-19d110" --dsh
AFTER  repo root entries: .git, docs, lib, node_modules, scripts, shell, src, tests, .gitignore, .npmrc,
  AGENTS.md, browser-1789515887356.png, browser-1789515909594.png, client.js, CONTEXT.md, cordis.patch.yml,
  package-lock.json, package.json, README.md, tsconfig.json, vitest.config.ts
ADDED:   (none)
REMOVED: (none)
probe.done = True
host cwd, reported by the host itself = G:\dsh_test1
host spacesDir = …\dsh-t16-manual-profile-19d110\spaces
browser_screenshot call = {"tool":"browser_screenshot","arguments":{},"isError":false,"value":{"path":
  "…\\dsh-t16-manual-profile-19d110\\screenshots\\browser-1789522071096.png","image":{"attachmentId":
  "sha256:8d0f2aa6…","mediaType":"image/png","bytes":13999,"width":660,"height":1200,"name":
  "browser-1789522071096.png"}},"content":[{"type":"text","text":"Screenshot saved to: …\\screenshots\\
  browser-1789522071096.png"},{"type":"image","attachment":{…}}]}
file exists = True
file bytes = 13999
attachment read-back = {"attachmentId":"sha256:8d0f2aa6…","mediaType":"image/png","width":660,"height":1200,
  "declaredBytes":13999,"readBackBytes":13999,"pngMagic":[137,80,78,71,13,10,26,10]}
cleaned …\dsh-t16-manual-home-19d110 -> still exists = False
cleaned …\dsh-t16-manual-profile-19d110 -> still exists = False
cleaned …\dsh-t16-manual-out-19d110 -> still exists = False
```

四处值得看的：

- **`host cwd … = G:\dsh_test1`** —— 宿主自己报的，就是仓库根。以前 `'.'` 解析成的正是它。
- **`ADDED: (none)`** —— 仓库根的列表跑前跑后**逐项相同**，那两个用户的 PNG 原样还在。
- **`arguments: {}`** —— 这一次真的**没有给 `path`**（探针的入参原样记在报告里）。
- 落盘路径在**临时档案目录**的 `screenshots\` 下，文件真的在（13999 字节），附件读回来同样 13999 字节。

这一轮起过的进程只杀了它自己那一棵树（`taskkill /pid 38152 /T /F`）；用户自己那个外壳
（2026/09/16 07:29 起的四个 `electron`）在跑之前、跑之后都在，全程没碰。

## 6. 反证：把修复退回去，它必须变红

做法：把 `resolveScreenshotDir` 里本票新加的那一支（`shell-profile`）关掉、兜底回到修复前的
`'.'`，`npm run build` 之后跑同一条命令。原始输出：

```
RAW the substitute-repo cwd before/after: {"cwd":"…\\dsh-t16-cwd-r4Zs1Y","beforeStart":[],
  "afterProbe":["browser-1789521287892.png"]}
RAW browser_screenshot (no path) returned: … "path":"…\\dsh-t16-cwd-r4Zs1Y\\browser-1789521287892.png" …
RAW where it landed vs where the shell profile says it should:
  {"shotPath":"…\\dsh-t16-cwd-r4Zs1Y\\browser-1789521287892.png",
   "expected":"…\\dsh-t16-profile-WolhFQ\\screenshots\\browser-1789521287892.png"}

 ❯ tests/screenshot-dir.spec.ts (9 tests | 6 failed) 9454ms
     × 显式配置永远优先：给了 screenshotDir 就以它为准
     × 没配就落在外壳档案目录下的 screenshots：与下载（<档案>/downloads）对称
     × 连档案目录都拿不到时，落到系统临时目录下的**专用**子目录（兜底说清楚）
     × 反证：两个默认值都不许是宿主进程的 cwd
     × 前提：宿主自己的 cwd 就是那个临时目录，而它整轮一个文件都没多
     × 截图落在外壳档案目录下的 screenshots，而不是 cwd，也不是本仓库
 Test Files  1 failed (1)
      Tests  6 failed | 3 passed (9)
```

红的那两条正是本票的两句话：**cwd 里多出了 `browser-1789521287892.png`**；**返回的路径就是 cwd 里
那一个**。三条没有跟着红的是对的：附件交付（图片本身还是送出去了，只是落在错的地方）、
以及"读得出外壳发布的那个字段 / 读不动就 `undefined`"（它们问的是另一件事）。

> 还有一次**不是故意**的反证，值得记一笔：修复写完之后第一次跑这条 spec 时忘了 `npm run build`，
> 于是 profile 里装的是**旧 `lib/`**（`package.json` 的 `main` 指向 `lib/index.js`，profile 消费的是
> 编译产物）。那一次的原始输出与上面这次几乎逐字相同（`afterProbe:["browser-1789521183577.png"]`、
> 路径落在 cwd 里），也就是说：**这条 spec 对"修复前的真实代码"是红的**，而不只是对"我手工改坏的
> 那一段"红。

## 7. 既有测试零回归 + 连续 3 次整包

改动定稿、`npm run build` 之后**连续跑了三次整包**（每次完整 `npm test`，中间没改任何文件）：

```
=== FINAL RUN 1 ===
 Test Files  15 passed (15)
      Tests  153 passed (153)
   Duration  225.20s (transform 359ms, setup 0ms, import 3.63s, tests 218.94s, environment 1ms)

=== FINAL RUN 2 ===
 Test Files  15 passed (15)
      Tests  153 passed (153)
   Duration  226.18s (transform 361ms, setup 0ms, import 3.64s, tests 219.91s, environment 1ms)

=== FINAL RUN 3 ===
 Test Files  15 passed (15)
      Tests  153 passed (153)
   Duration  226.54s (transform 365ms, setup 0ms, import 3.64s, tests 220.26s, environment 1ms)
```

起点是 **14 文件 / 144 用例**（213.74s，本次实测），终点是 **15 文件 / 153 用例**：多的那 9 条
全部在 `tests/screenshot-dir.spec.ts` 里，**既有 14 个文件一条都没红**。整包从约 214s 涨到约 226s
（涨的就是这一次真外壳 + 真宿主那一轮，约 9–10 秒）。每次都是完整 `npm test`，三次之间没有改过
任何被测试读到的文件。

## 8. 本次**没有**碰的东西

- **截图的重试 / 缩放 / 尺寸**：一个字节没动（`SCREENSHOT_ATTEMPT_MS`、`SCREENSHOT_ATTEMPTS`、
  `page.screenshot({type:'png'})` 的默认 device 缩放都原样）。既有事实见
  `docs/research/cdp-screenshot-stall.md`。
- **下载那条路径**：`<userDataDir>/downloads`（ADR-0011）一个字没改，本票只是**借**它做对称。
- **没有做**"截图自动清理 / 轮转"：本票只解决"默认落在哪"。
- **用户那两个 PNG**：没动、没提交、没删（`git status` 里仍是 `??`）。

## 9. 诚实清单（本次**没能**验证到的）

1. **"用户自己那一轮"没有重跑过**：没有人再对 Agent 说一次「去百度搜天气并截图」。本次做到的
   最接近的一件事是 §5.1 —— **从仓库根真的敲了一次 `npm run shell -- --dsh`**，让探针经真宿主的
   注册表调一次不带 `path` 的 `browser_screenshot`，读回"仓库根列表跑前跑后逐项相同"。
   差的只是"发起截图的是一个真模型"（要有凭据、要联网、要花钱），不是机制。
   套件里那半条用的是**临时目录**当 cwd（刻意的：万一回归，被污染的是临时目录而不是仓库），
   它证明的是同一句话：宿主进程的 cwd 不新增任何文件。
2. **"模型真的看见了那张图"**仍然只能由用户和 Agent 对话来验（与票 #12 的诚实清单第 2 条同一个缺口）。
   本次证到的是"图片进了部署自己的附件 store、能按引用读回、字节数与落盘文件一致"，三次：
   §5（临时 cwd）、§5.1（仓库根）、`tests/acceptance.spec.ts`（显式 path 那一轮）。
3. **没有外壳时那条兜底（`%TEMP%\\dsh-desktop-view-screenshots`）只在纯逻辑层被验过**：
   三种"读不到档案目录"的输入都断言了它的精确路径，但**没有任何一次真的往那里写过一张截图**
   —— 要真的写，得有一个"能连上 CDP 端点、却没有空间通道"的部署，本次没有搭。
4. **`state.json` 在插件挂载时是否一定已经存在**没有单独策过。外壳的代码顺序（先落盘、再发布握手、
   最后起宿主）是那样写的，本次的真宿主那一轮也事实上读到了；但"外壳写慢了会怎样"没有造过。
   选"每次落盘时现读一次"而不是"挂载时读一次"正是为了不依赖这个顺序。
5. **Linux / macOS 没跑过**：本套件是 Windows + 真 Electron 真窗口，路径比较里的
   `realpathSync.native`（抹平大小写与 8.3 短名）是按 Windows 的毛病写的。
