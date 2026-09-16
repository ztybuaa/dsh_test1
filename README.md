# dsh-desktop-view

DSH 插件 + 一枚薄 Electron 外壳,让侧边栏那一格**是一个真正的原生浏览器视图**,而且 **Agent 能操作它**。

不是截图流,不是嵌套 iframe,不需要 screencast —— 见 `docs/adr/`。本文只讲怎么跑。

```
┌─────────────── shell/ (Electron, 自建薄壳) ───────────────┐
│  BrowserWindow  ── DSH Web 界面 / 夹具页                   │
│  WebContentsView ── 目标网页(原生渲染,能登录)            │
│  CDP 端点 127.0.0.1:<系统挑的端口>  (仅回环)               │
└───────────────────────────┬───────────────────────────────┘
                            │ 握手:{cdpUrl, targetId}
                            │ stdout 一行 / 子进程环境变量
┌───────────────────────────▼───────────────────────────────┐
│  src/ (DSH 插件)                                          │
│  领养那块视图,用 Playwright 驱动它;绝不 newPage()          │
└───────────────────────────────────────────────────────────┘
```

## 安装

```pwsh
$env:ELECTRON_MIRROR = 'https://mirrors.huaweicloud.com/electron/'   # 本机直连 GitHub Releases 会超时
npm install
```

`.npmrc` 已固化了华为镜像与 `playwright_skip_browser_download`(这条链路上唯一的 Playwright 入口是
`connectOverCDP`,不需要下载任何浏览器)。npm 10 会把 `.npmrc` 里的未知键透传成
`npm_config_<key>` 环境变量,但会打 warn;若将来 npm 不再透传,请直接在环境里设
`ELECTRON_MIRROR`。

## 自己验收（用户视角）

想按自己的节奏逐条试一遍，看 **[`docs/acceptance-checklist.md`](docs/acceptance-checklist.md)**：
每条都写清「做什么 → 应该看到什么」，并标明**是谁验的**（✅ 自动化 / 🔬 实现者实测 / 👤 必须你本人），
以及**本期不做什么**（人机仲裁、多标签、旧截图流）。里面还有三条"本项目至今没有真实证据"的，
需要你和 Agent 对话来验。

## 跑接缝测试(一条命令)

```pwsh
npm test
```

它会真的拉起 `shell/main.js`(真 Electron、真窗口、真 `WebContentsView`),用插件的
`AdoptedViewSession` 领养那块视图,然后按票分层断言:T1 的身份与领养、T2 的面板矩形 → 视图摆放、
T3 的 `ref` 与 bounds、T4 的各类动作**外部效果**(点击改 DOM、填表后 `value` 真是那个值、Enter 触发提交、
悬停才出现的东西真的出现、下拉选中的值、拖拽后顺序与几何都变了、滚动到元素用页面自己的
`getBoundingClientRect()` 验证)以及**四类失败原因各自被区分开**、T5 的**读页面**(正文与页面自己的
`innerText` 逐字一致且按上限截断、表达式取到只有页面知道的值、接口数据与页面侧记录的实收载荷一致、
截图像素由测试自己解析且作为附件交付、控制台错误与失败请求先由页面自证再被工具读到)。

票 #12 那一层(`tests/acceptance.spec.ts`,9 条)走的是**用户那条路**:真的敲 `npm run shell`、
起真 `dsh` 宿主、从**操作系统**读回进程树与端口归属(两个外壳同时起,六个端口两两不同)、
从一个只读探针插件里读回**宿主自己的工具注册表**,并让工具**经注册表**真的驱动那一格、
把截图存进**部署自己的附件 store** 再读回来。它比其它 spec 慢(约 40 秒、四个真宿主),也更要紧:
那几条验收以前没有一次真实证据。

### 跑测试需要什么

| 需要 | 为什么 | 缺了会怎样 |
|---|---|---|
| Node + 已 `npm install`(含 Electron) | 大多数用例真的要起真 Electron 外壳 | 起不来 |
| **`dsh` 启动器在 PATH 上**(或用 `DSH_BIN` 指向 `@deepseek-ai/dsh/lib/bin.js`) | `tests/no-shell.spec.ts` 要起一个**真 `dsh` 宿主**来验"没有外壳时插件照常加载"(票 #11 的验收 1);`tests/acceptance.spec.ts` 要起**四个**真宿主(票 #12 的验收 1 与"注册表本体/附件 store") | **明确失败,不会静默跳过** |
| Windows | `tests/cleanup.spec.ts` 那条 EPERM 断言是 Windows 文件锁的事实 | 该用例失败 |

那两条依赖是**故意**的:一个永远被跳过的检查,正是票 #11 要消灭的那种"静默失效"。
找不到 `dsh` 时的报错会写明该装什么、或该把 `DSH_BIN` 指向哪里。

## 直接用外壳

```pwsh
# ① 一条命令:完整产品 —— 外壳 + DSH + 那一格
npm run shell

# ② 只要外壳 + 内置夹具(离线、不起 DSH、不碰你的 ~/.dsh)
npm run shell:fixture

# ③ 手工写法与全部开关,仍然照旧(--help 有全部开关)
#    URL 开关一律写等号形式(`--url=<url>`),理由见下面那段
npx electron shell/main.js
npx electron shell/main.js --url=https://example.com --view-url=https://example.org
npx electron shell/main.js --dsh
```

> **URL 开关一律写等号形式**(`--url=<url>` / `--view-url=<url>`)。
> 写成空格形式(`--url <url>`)时,只要那个 URL 参数**后面还有任何别的参数**,Electron 就会在
> **应用代码跑起来之前**直接退出:**零输出**,退出码 `0xFFFFFFFF` —— 连 `shell/args.js` 的 argv 校验
> 都轮不到执行,也就是说**外壳运行时救不了自己**,`--help` 也不会打出来。用户看到的是"命令敲了,
> 什么都没发生"。
>
> 已经量到的边界(完整规则表与原始输出见
> [`docs/research/t14-cli-url-token-kills-electron.md`](docs/research/t14-cli-url-token-kills-electron.md)):
> 等号形式**在任何位置都免疫**;空格形式只在"这个 URL 就是最后一个参数"时才安全 ——
> 所以 `--view-url https://…` 写在末尾能用只是**位置**安全,后面再追加一个参数就立刻变成上面那条。
> 单字母"方案"(`C:\x`、`a:b`)不算 URL,开关叫什么名字不影响这条规则;外壳自己 spawn 的 `dsh`
> 子进程跑的是 Node、argv 里也没有 URL,不受影响。

- **①** 就是 `electron shell/main.js --dsh`:外壳**自己拉起** DSH、**让系统挑端口**(`--port 0`)、
  **不打开你的系统默认浏览器**(`--no-open`);窗口里装的是 DSH 的界面,侧边栏那一格交给原生浏览器视图。
  这三件事怎么被**行为**证明(而不是靠断言 argv 里有几个字符),见
  [`docs/research/t12-one-command-and-the-three-first-evidence.md`](docs/research/t12-one-command-and-the-three-first-evidence.md)。
- **②** 是开发用的那条路:没有 DSH,窗口与视图都装内置夹具页(`/shell`、`/view`)。
- **③** `shell/main.js` 的所有开关(`--url` / `--view-url` / `--bounds` / `--cdp-port` / `--proxy` …)
  照旧可用;往脚本上追加参数也一样:`npm run shell -- --view-url=https://www.bing.com`。
- **同时开两个外壳**:给每个一个自己的档案目录
  (`npm run shell -- --user-data-dir $env:TEMP\dsh-shell-2`)。共用默认目录"能用",但第二个外壳的
  磁盘缓存会报 `Unable to move the cache: 拒绝访问`(实测,见上面那份底稿 §4.3)。

它需要 **`dsh` 在 PATH 上**(外壳自己起不动宿主时会明确报错,不会静默给你一个空壳)。

`--dsh` 默认拉起 **`dshviewer`** 这个 profile(本插件装在那里),即
`dsh --profile dshviewer --no-open --port 0`。**不要**用 `dsh web`:它是 `--profile web` 的
硬编码别名(`dsh --help` 原文 *"alias of --profile web"*),而本插件不在 `web` 里 —— 那样启动出来的
界面看起来完全正常,但**没有标签页、没有原生视图、也不报错**。换 profile 用 `--dsh-profile <name>`,
不必改代码。

启动成功后,外壳在 stdout 上打印一行握手:

```
DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"http://127.0.0.1:63668","targetId":"FB9F…","identification":"webContents.fromDevToolsTargetId","targetType":"page","targetUrl":"…/view","viewUrl":"…/view","viewWebContentsId":2,"windowWebContentsId":1,"windowTargetId":"70C5…","pageTargetCount":2,"userDataDir":"…","fixtureOrigin":"http://127.0.0.1:63669",
   "browserIdentity":{"partition":"persist:dsh-view","storagePath":"…\\Partitions\\dsh-view",
                      "userAgent":"… Chrome/152.0.7977.78 Safari/537.36",
                      "enableAutomationSwitch":false,"disableBlinkFeatures":"AutomationControlled"}}
```

`browserIdentity` 里的每个值都是**从 Electron 读回来的实际值**(`session.getStoragePath()`、
`webContents.getUserAgent()`、`app.commandLine.hasSwitch/getSwitchValue`),不是外壳的意图。

### 在侧边栏里打开那一格(T2 验收)

`--dsh` 起来之后:

1. 窗口里是 DSH 的 Web 界面。右侧边栏标签条上的 **「+」(`新标签页`)** → 打开 guide 页;
2. guide 页里有胶囊:**「浏览器」**(副标题「把侧边栏这一格交给原生浏览器视图」,英文环境是
   *Browser*),旁边是内置的「工作区文件」;
3. **点「浏览器」** → 那一格出现的是**原生浏览器视图本身**(真渲染、能登录的那个浏览器),
   不是截图、不是 iframe;
4. 折叠侧边栏 / 切走那个标签 → 视图**隐藏**(不是被缩成 0 像素);再打开 → 它回到同一个矩形。

外壳每摆一次视图都会在 stdout 打一行,可以直接用它验证:

```
DSH_SHELL VIEW {"cause":"panel-report","visible":true,"bounds":{"x":680,"y":38,"width":506,"height":700},
                "applied":{"x":680,"y":38,"width":506,"height":700},"appliedVisible":true,
                "clamped":false,"reason":"reported", …}
DSH_SHELL VIEW {"cause":"panel-none","visible":false,"bounds":null,"appliedVisible":false, …}
```

`bounds` 是面板上报的矩形,`applied` 是 `view.getBounds()` 读回来的实际几何,`appliedVisible` 是
`view.getVisible()` 读回来的实际可见性 —— 三者一致才叫"那一格真的就是这个浏览器"。
`--placement-file <file>` 可以把最新一次摆放镜像到 JSON 文件里,方便脚本化观察。

`--dsh` 时,同一份身份还会通过子进程环境变量交给载体无关的 DSH 进程:

| 变量 | 含义 |
|---|---|
| `DSH_DESKTOP_VIEW_CDP` | 外壳的可编程端点,例如 `http://127.0.0.1:63668` |
| `DSH_DESKTOP_VIEW_TARGET` | 视图的 CDP `targetId`(身份,不是地址) |
| `DSH_DESKTOP_VIEW_URL` | 视图当时的地址(仅兜底识别用) |
| `DSH_DESKTOP_VIEW_SPACES` | 任务空间控制通道的目录(默认空间所在档案下的 `spaces\`),见下文 T7 一节 |

`--help` 有全部开关。

**没有外壳时这一格会说明自己**:在拿不到矩形通道的页面里(普通浏览器标签页、或外壳里那页原生
视图自身),那一格渲染的是**说明文字**——它说清这一格需要桌面外壳,并给出起外壳的那条命令
(`npm run shell`)。空白的一格看起来和坏掉的插件没有区别,而这正是票 #11 要挡的东西;
三条验收的现状、原始输出与反证见
[`docs/research/without-the-desktop-shell.md`](docs/research/without-the-desktop-shell.md)。

### 那一格的身份(T6):持久、专属、不被当成自动化

那一格是**它自己的浏览器**,不是外壳界面的一部分:

- **它有自己的持久档案**(`persist:dsh-view`,落在 `<userDataDir>\Partitions\dsh-view`)。
  **手动登录一次,关掉外壳再打开仍然是登录状态**;外壳界面那一路是另一个罐子 ——
  实测同源前提下,一边写的 cookie 与 localStorage 另一边**读不到**。
  > 走"关窗口"才保得住:实测**写完立刻强杀**会连持久 cookie 与 localStorage 一起丢
  > (Chromium 还没刷盘)。这是 Chromium 的行为,不是档案不持久。
- **UA 里没有 Electron 的产品标记**:只对这一格的 `webContents` 删掉 `<应用名>/<版本>` 与
  `Electron/<版本>` 两段,其余一字不改;外壳界面那个窗口的 UA **不动**。
  客户端提示(UA-CH)**本来就不带 Electron 品牌**,实测确认。
- **`navigator.webdriver` 为假**。注意它的根因是**我们自己**加的 `--remote-debugging-port`
  (没有它就没有整条领养路径,ADR-0002),Blink 特性标志只能在**进程级**关掉,所以这条影响面
  包括外壳界面那个窗口(两个页面都实测读回为 `false`)。取舍与备选方案见 `docs/adr/0009`。
- **代理什么都不设**:Chromium 的默认模式就是 system,所以外网站点**自动继承系统代理**;
  回环地址本来就有隐含 bypass,`127.0.0.1` / `localhost` / `[::1]` **都不会**被推进代理。
  启动时把读回发布成一行:

```
DSH_SHELL PROXY {"partition":"persist:dsh-view","readings":{
  "external":{"url":"https://example.com/","result":"DIRECT"},
  "loopback127":{"url":"http://127.0.0.1:9/","result":"DIRECT"},
  "loopbackLocalhost":{"url":"http://localhost:9/","result":"DIRECT"},
  "loopbackV6":{"url":"http://[::1]:9/","result":"DIRECT"}}}
```

`--proxy <rules>` 是"系统代理不是我要的那个"时的显式口子(直接交给 `session.setProxy({proxyRules})`)。
**不要顺手加 `proxyBypassRules`**:实测 `<-loopback>` 会把隐含 bypass **反过来**,连回环都推进代理;
只列 `localhost,127.0.0.1` 又会漏掉 `[::1]`。原始证据在
`docs/research/browser-identity-and-profile.md` 第 6 节。

### 任务空间(T7):每个任务一个罐子,切换空间 = 换掉那一格里的视图

一个**任务空间** = 一块自己的原生视图,跑在**自己的持久 partition** 上。所以两个空间可以在
**同一个站点各自登录**,互相看不到对方的 cookie 与 localStorage;所有 `browser_*` 工具**只作用于
当前空间**。用**一个**工具管它们:

| 工具 | 作用 |
|---|---|
| `browser_space` | `action: "list"` 列出空间与当前空间;`"create"`(带 `name`)建一个新的、继承默认档案的登录态、并切过去;`"use"` 切到已有的;`"close"` 关掉一个(释放页面 + 抹掉存储数据) |

默认空间就是 T6 那一格,**partition 原样是 `persist:dsh-view`**(改它等于把用户已经登录的档案弄丢);
新空间用 `persist:dsh-view-space-<名字>`,与默认空间**同时存在**、各自持有自己的页面,
**只有当前空间那块是显示的**(切换 = 换掉填那一格矩形的那块视图,不是做标签条)。

几条**量出来的**边界,别当成坑踩:

- **"独立浏览器上下文"在 Electron 上不存在**。实测 `Target.getBrowserContexts` 回
  `{browserContextIds:[], defaultBrowserContextId:"…"}`、`Target.createBrowserContext` 报
  `Failed to create browser context.`、`Target.createTarget` 报 `Not supported` ——
  所有 partition 都挤在**同一个** CDP browser context 里,所以 `browser.newContext()` 用不了。
  隔离强度是 **partition 级**(cookie / localStorage / sessionStorage / 缓存都隔离)。
- **继承登录态: cookie 全量、localStorage 只覆盖新空间落脚的那个 origin**。
  cookie 能枚举也能整批写(`cookies.set` **必须带 `url`**,只给 domain 会抛
  `Missing required option 'url'`);localStorage **没有任何 API 能枚举"哪些 origin 有它"**,
  而且给一个本 partition 没有 frame 的 origin 写会被 CDP 拒绝(`Frame not found for the given storage id`)。
  所以默认档案里**其它 origin 的 localStorage 不会**跟过去 —— 事实与取舍见 `docs/adr/0010` 第 3 节。
- **关闭空间: 页面立即释放、存储数据立即抹掉、磁盘目录下次启动才删**。实测关掉视图后目标立刻从
  `/json/list` 消失、`clearStorageData()` 之后同 partition 的新页面读不到任何旧 cookie/localStorage;
  但目录在**进程存活期间删不掉**(Windows 文件锁,15 个子项里 11 个 EPERM,`clearCache()` 也解不开),
  只能记进 `spaces\pending-deletion.json`,由**下一次启动**在任何 `session.fromPartition` 之前删掉。
  这三件事分开写、也分开测。

**创建/关闭走一条外壳侧的文件通道**(ADR-0003 明令外壳不开端口):插件写
`<档案目录>\spaces\request.json`(期望状态,带单调递增的 id),外壳轮询后 reconcile,把**读回来的**
实际状态写进 `state.json` 并打印一行 `DSH_SHELL SPACES {...}`;工具**阻塞等 state 报告该 id 已处理**,
所以从工具视角它是同步的,外壳不在时是一个说得清的超时错误。原始测量(含 `newContext` 的逐条 CDP
回答、cookie/localStorage 的能力边界、EPERM 的逐项清单)在 `docs/research/task-space-isolation.md`。

表里的 `targetId` 是**三态**的,因为它是唯一可能暂时读不回来的值,而它又是插件领养会话的唯一把手:
`targetIdSource` 取 `resolved`(这一次读回来的)/ `remembered`(这次读不回来,沿用这块视图已知的 ——
活着的视图 target id 不会变)/ `unavailable`(确实没有,原因逐字在 `targetIdReason` 里)。
**发布的表永远不比它知道的更少**:一次读不回来的列举不许把已知的 id 抹掉,真的没有就显式写明,
插件据此报一个点名那个空间的错误,而不是去领养一个没有目标的会话(成因与原始输出见
`docs/research/space-table-target-id-gap.md`)。

同一条规矩也管**一整条记录**:`state.json` 里有一条读不动的记录(比如外壳为一块**已被销毁**的视图
发布的记录),插件**只跳过那一条**并把原因写进 `SpaceState.skipped` —— `browser_space` 的输出里带着它,
被跳过的那一条会明确写出"NOT USABLE, skipped: 为什么",**其余空间照常可用**。外壳那一侧也不许因为
一块视图没了就少发字段或整份不写:`storagePath` / `url` 照样发布,并显式写 `destroyed: true`。
(一条坏记录让**整份状态**不可读曾是一个真的单点失败;三条销毁途径的原始测量、端到端复现与两处回证
见 `docs/research/destroyed-space-record.md`,决定记在 `docs/adr/0010` 第 2.2 节。)

### 让 Agent 操作那一格(T4 交互面)

`browser_snapshot` 给出带 `ref` 的可交互元素;下面这些工具**只按 `ref` 定位元素**,不让模型手写选择器:

| 工具 | 作用 | 关键点 |
|---|---|---|
| `browser_click` | 点击 `ref` | 点不到时错误里会写清是哪一种 |
| `browser_type` | 把 `ref` 的内容**替换**成 `text` | 一次设定值,不产生按键事件;`<input>` / `<textarea>` / `[contenteditable]` 都可用 |
| `browser_type_keys` | 往 `ref` 里**逐键**输入 `text` | 每个字符都是真按键事件(自动补全、掩码这类控件要的就是这个);追加在已有内容之后 |
| `browser_press_key` | 按一个键 | 不带 `ref` 时发给页面当前焦点(先 `browser_type` 再 `Enter` 就是提交表单);带 `ref` 则先聚焦该元素 |
| `browser_hover` | 悬停 `ref` | 悬停后才出现的东西,再拍一次快照就有 `ref` 了 |
| `browser_select` | 选中 `ref` 这个 `<select>` 里的某个选项 | 选项按 **value 或 label** 匹配 |
| `browser_drag` | 把 `fromRef` 拖到 `toRef` | 真鼠标手势:按住源元素中心、分步移动、在目标中心松开 |
| `browser_scroll` | 带 `ref`:滚动到该元素进入视口;不带 `ref`:按 `direction`/`amount` 滚像素 | |
| `browser_wait` | 等 `ms` 固定时长 / 等 `selector` 出现 / 等 `text` 出现(三选一,`timeout` 限时) | |

**动作失败一定说得出原因**,四类互不混淆(每类都在夹具页上有对应用例):

| 失败原因 | 什么情况 | 错误里带着什么 |
|---|---|---|
| 超时 `timeout` | 等待没等到 | 等的是什么、给了多少毫秒、当前地址 |
| 被遮挡 `obscured` | 元素可见、可点,但中心点上压着别的东西 | 遮挡者的描述(如 `div#act-blocker "blocker panel"`)与探测点坐标 |
| 不可见 `not-visible` | 元素还在文档里,但没渲染(无渲染框或 `visibility: hidden`) | 元素描述 + "这就是快照用的那条 `:visible` 规则" |
| 不存在 `not-found` | `ref` 不在最近一次快照里,或它钉住的那个节点已被移除 | `ref` 编号 + 元素描述 + 让它重拍快照 |

另有一类 `stale-ref`:`ref` 属于视图已经不再显示的那个文档(导航之后),错误会给出当前地址。

### 让 Agent 看懂那一格(T5 观测面)

快照仍然只列**能操作的元素**(ADR-0005,历史上把完整可访问性树塞进快照曾膨胀到约 10MB 把会话卡死),
所以"页面说了什么"是**按需读**的:

| 工具 | 作用 | 关键点 |
|---|---|---|
| `browser_extract` | 读页面渲染出来的正文(页面自己的 `innerText`) | 默认上限 20000 字符;超限就截断,并把 `truncated` 与 `totalChars` 作为数据一起返回,不用猜"是不是全的" |
| `browser_evaluate` | 在页面里求值一条**只读**表达式并返回结果 | 用来读只活在 JS 里的状态;**不是**绕过 `ref` 的捷径 —— 要点击/输入/悬停仍用快照的 `ref`(ADR-0001) |
| `browser_json` | 页面通过 `fetch`/XHR 加载到的 JSON(`[{url,status,body}]`) | 页面没渲染出来、数据只在响应里时用它;4xx/5xx **不算数据**,由 `browser_diagnostics` 带状态码报告 |
| `browser_screenshot` | 截当前视图为 PNG,**把图片本身作为附件交付**(同时给出落盘路径) | 尺寸 = 视口 CSS 像素 × 显示器缩放(页面里的 `devicePixelRatio`);走 Playwright 截图 API,**没有** screencast;不给 `path` 时落哪见下面那张表 |
| `browser_diagnostics` | 页面自己报的**控制台消息**(含未捕获异常)与**失败请求**(方法、URL、状态码、响应摘要) | 页面空白/内容缺失/动作没反应时先看它 |

`browser_navigate` 仍是注册表里的第 0 个工具;新增的观测工具只读,不改变元素定位方式。

> 实测坑(记录在 `docs/research/cdp-screenshot-stall.md`):这块视图上**单发**一次截图常常**永远不返回**,
> 而第二个请求会让两次都完成(并发发两个,两个都在 ~0.6s 内返回);`scale: 'css'` 在页面有滚动条时
> 给出 439×799(视口是 440×800)。因此截图走**默认的 device 缩放**,并在超时时有界重试。

#### 不带 `path` 的截图落在哪(票 #16)

不给 `path` 时,PNG 落在一个**有明确归属**的目录里,显式永远优先:

| 顺序 | 落在哪 | 什么时候走这条 |
|---|---|---|
| 1 | `screenshotDir` 显式配置的那个目录 | 配了就一定用它(相对路径照常按进程 cwd 解析) |
| 2 | **`<外壳档案目录>/screenshots`** | 没配,而且外壳发布了档案目录 —— `npm run shell` 起的正常一轮 |
| 3 | **`<系统临时目录>/dsh-desktop-view-screenshots`** | 既没配、也没有外壳发布档案目录(例如没跑外壳) |

第 2 条与**下载**那条决定对称(下载落 `<档案目录>/downloads`,ADR-0011):档案目录是外壳自己在
空间通道的 `state.json` 里发布的 `userDataDir`,插件照读即可,**不需要任何新通道**;截图因此与
"这一格的档案"待在一起,人在自己家里也找得到。第 3 条是兜底,目录名自带归属,`%TEMP%` 里一眼能认出
是谁放的。**`process.cwd()` 不在这条判断链里**。

> 原来的默认值是 `'.'`,也就是**宿主 `dsh` 进程的 cwd**:从仓库根跑 `npm run shell` 时宿主继承的
> 就是仓库根,于是 Agent 每截一张图,仓库根就多一个 `browser-<时间戳>.png` —— 实测发生过一次
> (2026-09-16,仓库根留下两个未跟踪 PNG)。三条决定各自的证据、独立读回怎么做的、以及反证的原始
> 输出在 [`docs/research/t16-screenshot-default-dir.md`](docs/research/t16-screenshot-default-dir.md)。

## 身份握手为什么这么做

同一个 Electron 应用里,**窗口页面和视图都是 CDP 的 `type: "page"`**,所以类型和 URL 都不能用来
认视图(URL 还会随导航失效)。外壳用 `webContents.fromDevToolsTargetId(target.id)` 把每个 CDP 目标
反查回 `WebContents`,与 `view.webContents.id` 比对,得到**唯一确定**的 `targetId`;插件侧用
`context.newCDPSession(page)` + `Target.getTargetInfo` 拿回同一个 id 再比对。两侧自洽,已实测一致。

> `webContents.getType()` 对 `WebContentsView` 报 `window`,而 CDP 报 `page` —— 两套词汇,别混。

## 目录

| 路径 | 职责 |
|---|---|
| `shell/main.js` | Electron 主进程:窗口、视图摆放、CDP 端点、握手、子进程与环境变量交接、退出清理 |
| `shell/args.js` | 命令行开关解析 |
| `shell/geometry.js` | 摆放决定:面板矩形 ↔ 窗口裁剪,以及"没有矩形"与"没有地方"的区别 |
| `shell/panel-rect.js` | 面板测量的**唯一事实源**:`getBoundingClientRect()` → 上报,null = 没有矩形 |
| `shell/preload.js` | 矩形通道的页面半边:`contextBridge` 暴露 `window.__dshDesktopView`(只给窗口) |
| `shell/fixture.js` | 内置离线夹具站点(回环、系统挑端口):`/shell`、`/view`、`/other`、`/panel`、`/snapshot`、`/snapshot-many`、`/slow`、`/interact`、`/observe` + `/api/observe`、`/api/missing` |
| `shell/cdp.js` | 端点等待、`/json/list`、`webContents` ↔ `targetId` 身份映射 |
| `shell/identity.js` | 那一格的浏览器身份(纯逻辑,不 require electron):专属档案 partition、去掉产品标记的 UA、自动化 Blink 特性名、代理读回用的探针地址 |
| `shell/spaces.js` | 任务空间的命名与生命周期判断(纯逻辑,不 require electron):名字形状、partition ↔ 名字、控制通道三个文件的位置、请求归一化、reconcile 差量 |
| `src/spaces.ts` | 插件侧的任务空间:期望状态怎么算(纯函数 `planRequest`)、原子写请求、等外壳处理完、按当前空间解析会话 |
| `src/client-body.js` | 客户端半边:右栏 tab 类型(含 guide 入口)+ body + 面板组件,由构建脚本拼进 `client.js` |
| `src/session.ts` | 领养模式会话:导航 / 快照 / 按 `ref` 的动作与失败原因定性,以及 T5 的观测(读正文、求值、抓 JSON 响应、控制台与失败请求、截图) |
| `src/screenshots.ts` | 截图落盘位置的判断(**纯函数**,不 require electron,也不碰文件):显式配置 → 外壳档案目录下的 `screenshots` → 系统临时目录兜底(票 #16) |
| `src/tools.ts` | 工具面:`browser_navigate`、`browser_snapshot`,T4 的 `browser_click` / `_type` / `_type_keys` / `_press_key` / `_hover` / `_select` / `_drag` / `_scroll` / `_wait`,T5 的 `browser_extract` / `_evaluate` / `_json` / `_screenshot` / `_diagnostics`,T7 的 `browser_space` |
| `src/index.ts` | 插件入口:`name` / `inject`(`tools` + `attachments`) / `Config` / `apply`;`adopt()` 是唯一的会话缝,按**当前空间**解析 |
| `scripts/build-client.mjs` | 把 `shell/panel-rect.js` + `src/client-body.js` 拼成 `client.js`(带 `--check`) |
| `client.js` | **生成文件**:宿主 `/plugins/…` 拉取的那一份,别手改 |
| `tests/adopt-view.spec.ts` | T1 接缝测试 + `--dsh` 环境变量与 profile 交接测试 |
| `tests/panel-placement.spec.ts` | T2 接缝测试:面板报矩形 → 外壳摆放视图 → 视图自己被读回 |
| `tests/snapshot.spec.ts` | T3 接缝测试:ref 与 bounds,以及跨文档的 ref 失效语义 |
| `tests/interaction.spec.ts` | T4 接缝测试:各类动作的外部效果,以及四类失败原因各自被区分开 |
| `tests/observation.spec.ts` | T5 接缝测试:正文/表达式/接口数据/截图附件/控制台与失败请求,每条都有独立读回 |
| `tests/identity.spec.ts` | T6 接缝测试:UA 与读回一致、两个页面的 `navigator.webdriver`、档案互不可见、优雅重启后登录态还在、代理两半(含真实日志代理) |
| `tests/spaces.spec.ts` | T7 接缝测试:空间命名与请求的纯逻辑、创建/使用/关闭、页面与存储的释放(含重启后目录真的被删)、同站两空间互不影响、继承默认档案及其边界、工具只作用于当前空间 |
| `tests/client-half.spec.ts` | 客户端半边:宿主加载契约、tab 类型 + guide 入口、body、生成物是否陈旧 |
| `tests/shell-harness.ts` | 测试用外壳进程夹具(也能跑**任意一条会打印握手的命令**——票 #12 用它跑真的 `npm run shell`;`makeTempDshHome` 现搭一个临时 `DSH_HOME`,用户自己的 `.dsh` 一个字节都不碰;`cwd` 可以把外壳的工作目录指到别处——票 #16 用它做"宿主 cwd 里没多出文件"的独立读回;探针报告的读法 `waitForProbe` 也在这里,票 #12 与 #16 共用一份) |
| `tests/acceptance.spec.ts` | 票 #12 的验收:`npm run shell` 一条命令起完整外壳、不抢端口(两个外壳同时)、不打开系统浏览器、真宿主 `ctx.tools` 注册表本体、经注册表驱动那一格、截图进真附件 store 并读回 |
| `tests/screenshot-dir.spec.ts` | 票 #16 的验收:默认截图目录的三选一(纯逻辑),以及**把外壳的 cwd 指到临时目录**起真外壳 + 真宿主,调一次**不带 `path`** 的 `browser_screenshot`,再分行读回"那个 cwd 没多出文件""图片在新默认位置""返回的路径就是落盘那个文件" |
| `tests/cli-shape.spec.ts` | 票 #14 的守卫:**本文档里每一条外壳命令都是已证明安全的形状**,而且带 URL 的那条会被**原样跑一遍**;反证 = 旧形状必须秒退 `0xFFFFFFFF`(规则与原始测量见 [`docs/research/t14-cli-url-token-kills-electron.md`](docs/research/t14-cli-url-token-kills-electron.md)) |
| `tests/fixtures/dsh-probe/` | 只读探针插件:装进临时 profile,在真宿主里读回注册表本体并驱动那一格(票 #12 用) |
| `docs/acceptance-checklist.md` | 给用户看的验收清单(每条标明谁验的、以及本期不做什么) |
| `tests/fixtures/fake-dsh-web.mjs` | 假的 DSH,用来验证环境变量与 argv 交接 |

## 本仓库**不**包含

screencast、MJPEG、`webServer`、mirror、`dsh-better-sidebar`、光标覆盖层(T8)—— 都是被淘汰或属于后续票的东西。
