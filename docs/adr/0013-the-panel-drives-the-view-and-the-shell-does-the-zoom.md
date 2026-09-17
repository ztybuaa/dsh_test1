# 0013 — 面板的工具条经共享 `/api` 通道驱动视图；缩放由**外壳**做（`setZoomFactor`），插件只是请它做

**状态**：已接受
**日期**：2026-09-16（决定二于 2026-09-17 依真窗口像素实测**重写**，见文末「决定二的更正」）

## 背景

票 #13 要覆盖两个面：**Agent 侧的工具**（PRD 故事 6 的「后退、前进、刷新」与故事 30 的「缩放」）
与**面板侧的控件**（用户实机反馈："这个不能回退，我想退回去，然后发现卡住了"）。面板是**外壳窗口里的
一个网页**，要驱动的是**原生视图**，而 `shell/preload.js` 顶部有一条明确的边界：

> *"Nothing else crosses here — no navigation, no identity, no commands. Driving the view stays with the plugin, over CDP (ADR-0002/0003)."*

所以工具条不能走 preload。本 ADR 记两条决定，以及它们的代价与边界。

---

## 决定一：面板 → 宿主走 `ctx.connection.fetch.register` + `ctx.connection.rpc.call('/api', …)`

### 为什么不用 `ctx.connection.rpc.handle()`

派工书点名的是 ADR-0003 那条载体无关 RPC 的 `handle()`。**实测它在 0.1.5-rc.2 上对第三方插件不可用**：
它对任何 ctx 都抛

```
cannot get property "webServer" without inject
```

栈底是：

```
at Fiber.<anonymous> (…/dsh-client-connection/lib/index.js:618:35)
at Proxy.register   (…/dsh-client-connection/lib/index.js:618:16)
at Object.handle    (…/dsh-client-connection/lib/index.js:543:39)
```

`lib/index.js:618` 那一行是：

```js
return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
```

而同一个包的 `inject` 是（`lib/index.js:736`）：

```js
const inject = ["credentials"];
```

**它注册路由要读 `owner.webServer`，自己却从不注入 `webServer`。** 三种写法都试过，都不行：
插件 `inject=['connection']`、`inject=['connection','webServer']`、
以及 `ctx.inject(['connection','webServer'], scoped => …)`（在 scoped 里 `scoped.webServer`
**读得到**，同一句 `handle` 仍然抛）。这是上游包的形状问题，不是调用方用错。

### 改用的是什么，以及依据

同一个包的**另一半公开 API**，而且第一方插件自己就是这么用的：

| 侧 | 接口 | 第一方出处 |
|---|---|---|
| 宿主 | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | `dsh-client-file-upload/lib/index.js:170-175`、`dsh-api-session-controller`、`dsh-client-ui-deliverables` |
| 客户端 | `ctx.connection.rpc.call('/api', '<ns>-<action>', payload)` | `dsh-client-connection/lib/client.js:6194-6216`（`createWebConnectionRpc`） |

两条形状上的硬约束都是量出来的，不是风格：

- **channel 必须是单段的 `/api`**：客户端 `assertTarget` 的 `CHANNEL_PATTERN` 是
  `/^\/[A-Za-z0-9._~-]+$/`（`lib/client.js:6186`），带 `/` 的 channel 连调用都发不出去。
- **一条端点一条精确路由**：宿主按 `url.pathname` 在精确路由表里查
  （`createSharedFetchHandler`，`lib/index.js:576-583`），没有前缀语义；而
  `assertFetchRoute` 要求 path 满足 `endpointFromPath('/api', path) !== undefined`（`:696-697`）。
- **端点带自己的命名空间**：`/api` 是**共享**通道，产品自己的端点也在上面，所以本插件用
  `desktop-view-<action>`，定义在 `src/view-rpc.ts` 一处，两半共用。

### 它满足派工书那三条好处

1. **同一套会话能力**服务"Agent 的工具"与"人的按钮"：两边都走 `src/index.ts` 里那一个 `adopt()`，
   拿到同一个 `AdoptedViewSession` 类、同一个活动空间。判断也没有复制：按钮可用性来自会话
   观察到的历史，缩放档位来自 `src/navigation.ts`，失败分类来自同一个 `classifyNavigationFailure`。
2. **`shell/preload.js` 一个字节没动**，那句边界注释继续为真。
3. **是既有通道**（共享 `/api` 上的精确路由），不是新 wire。

### 什么东西拦得住那一格里的恶意页面

那一格装的是**任意网站**，所以这一条必须说清楚。三层，全部实测：

```
POST /api/desktop-view-state，不带凭据        → 401 "unauthorized"
POST /api/desktop-view-state，Origin 是外域   → 403 "forbidden"
从视图那一页（另一个 origin）发起 no-cors POST → 到达，但宿主的调用**没有生效**
```

- **凭据**：通道在派发前跑 `browserAuth.isAuthenticated`；面板那一页有 DSH 用 `?token=` 换来的
  `dsh-auth-*` cookie，网站没有。
- **Host/Origin 围栏**：`isTrustedApiRequest`（`dsh-client-connection/lib/index.js:201-215`）要求
  Host 是回环或受信 authority、`Sec-Fetch-Site !== cross-site`、且 `Origin` 的 host 与 `Host` 相等。
  跨源请求在这三条上过不去。
- **信封**：`content-type` 必须是 `application/json` 且 body 必须是
  `{type:'client-request', rpcId, method:<endpoint>, payload}`，`method` 还要与路由对上。
  一个"能发出去但信封不对"的请求不会执行任何动作 —— 这正是上面第三条实测到的：
  请求到达了，视图**一点没动**。

顺带一条：`application/json` 不是 CORS 安全列表里的内容类型，所以浏览器会先发预检；
DSH 不答 CORS，那个预检过不去。**但这条不是唯一的防线**，上面三层各自独立成立 ——
把安全性押在"跨源读不到响应"上是不够的（`no-cors` 请求照样发得出去），这一点已经用实测钉住了。

---

## 决定二：缩放由**外壳**对视图做（`webContents.setZoomFactor`），经**既有**的空间请求文件传一个 `zoom` 字段

### 更正：上一版这一节写错了方向，错在**量具**

上一版写的是"采用 `page.setViewportSize()` + `setDeviceMetricsOverride`，并且**做不到**
把固定宽度页面塞进窄栏"。那两句话**都被推翻了**，而根因是量具：

- 它量的是 `innerWidth` / `scrollWidth` / `devicePixelRatio` / **截图尺寸**；
- 而**截图不是用户在窗格里看到的东西**。截图由 CDP 交付，尺寸等于**布局视口 × 屏幕 dpr**；
  `webContents.capturePage()` 也不是 —— CDP 缩放 0.5 时它交出 1860×2400（整块 1240×1600 的
  模拟视口 ×1.5），比窗格的 930×1200 还大。
- 而且那张候选表**六条全是放大**（1.94 / 1.5 / 3 倍）或移动端模拟，**没有一条是缩小** ——
  而用户要的正是缩小。

真窗口像素（`desktopCapturer` 抓真外壳的窗口，夹具 1200px 条子 + 页面最右端红标，窗格 620×800）：

| 状态 | 页面读数 | 蓝条在窗口像素里的高度 | 红标 |
|---|---|---|---|
| 基线 zoom=1 | innerWidth=620, scrollWidth=1200 | 422 px | **0** |
| zoom=0.5（CDP，先 `setViewportSize` 再发覆盖） | innerWidth=**1240**, scrollWidth=1240（"装下了"） | **422 px（一点没变）** | **0** |
| zoom=0.5（CDP，只发覆盖） | 同上 | **422 px（一点没变）** | **0** |
| zoom=1.94（CDP） | innerWidth=319 | 422 px（画出来的区域缩到 320 DIP） | **0** |
| 100% 且滚到最右（**仪器自检**） | scrollX=580 | 422 px | **20184** |
| **zoom=0.5 且试图滚到最右** | **scrollX 仍是 0**（没有溢出了） | 422 px | **0** |

仪器自检那一条是关键：红标 45×120 CSS px，画面 1.9355 px/DIP ⇒ 预期 87×232，**量到 87×232**。
量具有效，所以上面那些 0 是真的 0。

**CDP 那条路因此被删除，理由有两条，第二条更重**：

1. 它只做一半：布局视口变了，而窗格把模拟视口按 **1:1 的 DIP** 画出来再裁掉 —— 内容一个
   像素都没被缩放（蓝条高度四种状态下恒为 422 px）。
2. 它在缩小方向上是**负功能**：`zoom=0.5` 让 `scrollWidth(1240) <= innerWidth(1240)` 成立，
   于是**横向溢出消失** —— 用户连滚都滚不到最右端了，而 100% 时他明明还能滚过去。
   一个"把能滚到变成滚不到"的功能比没有功能更糟。

### 采用的是什么

`webContents.setZoomFactor(zoom)`，由**外壳**对那块 `WebContentsView` 调用。插件够不到
Electron API（ADR-0003：外壳不开任何监听端口），所以经**既有**那条空间请求文件走一趟：

- `request.json` 里那块视图可以带上期望的 `zoom`（`{name, zoom}`，其余空间仍是一个名字）；
- 外壳按它 `setZoomFactor()`，并**把 `getZoomFactor()` 的读回值写进 `state.json`**；
- 插件等的那个数**是读回来的那个**（`SpaceManager.setZoom`），不是自己写下去的愿望。

为什么挂在空间那一层而不是单开一条通道：缩放本来就是**每块视图自己的属性**，而"每空间一块视图"
正是那张表已经在表达的事实；单开一条通道就是拿一条通道干两件事。
为什么只有**被改动的那一个**空间带 `zoom`：这条请求是期望状态的快照，给没打算动的空间也写一个值，
就等于"外壳按这个值把它改回去"，会把用户用 Ctrl+滚轮在别处调过的缩放抹掉。

量到的结果（真外壳，`tests/zoom-pixels.spec.ts` 就是这条验收）：

```
zoom 1   : red=0        bar 高 422 px      innerWidth=620  dpr=1.5
zoom 0.5 : red=4872@42x116   bar 高 227 px   innerWidth=1240 dpr=0.75   scrollX=0
zoom 1   : red=0        bar 高 422 px      （反证：撤掉缩放，红标回到看不见）
```

红标在 0.5 档的预测值是 `45×0.5×1.9355 = 43.6`、`120×0.5×1.9355 = 116`，量到 **42×116**
—— 整页真的进了那一格，而且是按比例缩小的。

### 缩放归谁：**跟视图走**，不跟站点走（量出来的，不是选的）

Chromium 自己的页面缩放是**按站点**记的。实测：在 `127.0.0.1:PORT` 上设的 50%，走到
`localhost:PORT`（另一个主机名）就**没了**，而 `state.json` 里那个数还是旧的 0.5 ——
即"跟站点走"不但让用户点一个链接就失去缩放，还会让面板显示一个撒谎的数。

所以定下的语义是 **缩放是这块视图自己的属性**：外壳在每次主文档导航（`did-navigate`）之后
把它重新按上去。实测：同源换页保持 ✓，换到另一个站点保持 ✓，**重启外壳不保持**（新进程 =
新视图，回 100%）。代价写在诚实清单里。

### 截图语义：**不是**"作废"，而是"那条关系本来就在，只是上一版把它读错了"

上一版写着"T5 那句『截图 = 视口 × 屏幕 dpr』在缩放≠1 时被作废"。**那句话只对 CDP 那条路成立，
已随那条路一起删掉。** 采用外壳侧缩放之后，实测（真外壳，从**磁盘上的 PNG** 量）：

| zoom | 布局视口 | 页面读到的 dpr | 截图尺寸 | 布局视口 × 屏幕dpr |
|---|---|---|---|---|
| 1 | 620 | 1.5 | 930×1200 | 930 ✓ |
| 0.5 | 1240 | 0.75 | 1860×2400 | 1860 ✓ |
| 1.25 | 496 | 1.875 | 744×960 | 744 ✓ |
| 2 | 310 | 3 | 465×600 | 465 ✓ |
| 2.5 | 248 | 3.75 | 372×480 | 372 ✓ |

**截图 = 布局视口 × 屏幕 dpr**，每一档都成立。T5 那句话里的"视口"指的是**窗格**的视口；
缩放≠1 时窗格视口 ≠ 布局视口，所以要按上面这一行读。
**注意别把它写成"截图尺寸恒定"**：它随缩放变（因为布局视口随缩放变）。CDP 那条路的问题不是
"变了"，而是它**连屏幕 dpr 都不乘**（Playwright 的交付缩放取自它自己的 `_metricsOverride`，
`playwright-core/lib/coreBundle.js:37196`，算出来是 1），于是 zoom=2 时给 310×400 的图，
而窗格是 930×1200 —— 那才叫漂移。

### `bounds` 的坐标系（对 ADR-0008 的影响）

ADR-0008 说元素的 `bounds` 是"视口 CSS 像素、与视图 1:1"。**这条没有变，只是要把"窗格"与
"CSS 像素"分开说**：bounds 一直是**页面自己的 CSS 像素**（实测 zoom=1 / 0.5 / 2 三档，
`#hit` 都是 `{x:10,y:220,width:90,height:28}`，而 `innerWidth` 分别是 620 / 1240 / 310；
变的是"1 CSS 像素等于几个窗格像素"，那由 `dpr = 屏幕dpr × zoom` 决定）。
`620 DIP` 的窗格在 `dpr = 1.5` 的屏幕上一直是 930 **物理**像素，所以"bounds == 窗格物理像素"
**在 zoom=1 时也不成立**（那是两套单位）。

**没有任何流水线依赖"bounds == 窗格物理像素"** —— 这一条是**验**的，不是推的：

1. 最可能依赖它的那条就是"按 ref 点击"（它拿 bounds 决定点哪里）。在 zoom = 1 / 0.5 / 2
   三档各点一次，读**页面自己写下的效果**（`out` 变成 `t13-clicked`），**三次都中**；
2. 面板的摆放用的是**面板矩形**（`DshPanelRect` 量出来的那个），不碰元素 bounds；
3. 覆盖层画在页面里、用的是与 `getBoundingClientRect()` 同一套坐标（`tests/overlay.spec.ts` 已钉住）。

---

## 后果

- 面板上那七颗按钮的可用性里，只有 `back` / `forward` 可能因为"已知不可能"而变灰，
  而那个"已知"是**会话观察到的历史**，不是浏览器的真值：它**可能低估**（会话领养之前走过的
  路不在账上）、**不会高估**。低估的代价是按钮一开始是灰的；高估的代价是按钮撒谎 —— 后者更糟。

  > **票 #18 更正（2026-09-17）**：这一段写于 T13，当时以为"引擎没有只读的历史 API"。
  > **那句话是错的**：`Page.getNavigationHistory` 就在同一条 CDP 连接上（T1 读身份用的就是它），
  > 它答的是 `{currentIndex, entries}` —— 这个视图**真实**的历史，天然包含"领养时视图已经
  > 在的那一页"、前进分支、以及会话被重建之后的历史。所以 `back`/`forward` 的权威改成了
  > **引擎**，观察账本降级成"引擎答不上来时"的兜底，读数带上它从哪来（`ViewState.historySource`）。
  > 用户实机上"从内置测试页导航到 12306 之后后退按钮是灰的"就是旧假设的直接后果：
  > 引擎里明明有一格可以退，而账本说没有。详见 `docs/research/t18-history-truth.md`。
  > **代价**：每次问一次引擎是一次 CDP 往返；`restart()` 之后引擎的历史**不会**被清，
  > 所以"重新开始"之后后退仍可能亮着（那是事实：那些条目真的还在）。

- 面板与视图之间**没有推送通道**：视图自己导航（用户点页面里的链接、Agent 调工具）之后，
  面板那颗"后退"要到**下一次动作**之后才会亮。这不是缺陷的托词，是"面板只显示读回来的东西"
  这条取舍的直接后果，写在诚实清单里。
- **两个会话实例**：应用用自己的会话（`adopt()` → `SpaceManager` 缓存的那一个），而测试若另开一条
  `AdoptedViewSession` 去导航，面板**看不见**那一步（观察到的历史是会话自己的）。
  这是"同一套能力"这句话的边界：能力同源，但**观察是每个会话各自的**。

  > **票 #18 更正（2026-09-17）**：这句在"历史"这件事上**已经不再成立** —— 历史问的是**引擎**，
  > 而引擎是那一块视图共用的。两个会话实例现在读到的是同一份真实历史。剩下的差别只在
  > 那个**兜底账本**上（引擎答不上来时它才被读）。
- `src/spaces.ts` 现在把握手说的 `initialUrl` 往下传给会话（`SpaceManagerOptions.initialUrl`），
  因为**空间状态表里那个 `url` 不是它** —— 那个值是"视图现在在哪"，会跟着导航变。
- **通道协议版本从 1 加到 2**：请求里多了可选的 `zoom`、state 里每条记录多了 `zoom`。
- **缩放的唯一权威是外壳**：一个没有空间通道的会话（比如测试自己 `AdoptedViewSession.adopt`
  出来的那个）**不能**缩放，`zoomTo` 会如实说"没有外壳可问"，而不是假装缩放过。
  测试里要缩放就得走 `SpaceManager` 领养，或者用面板那条通道。
- 缩放**不跨外壳重启**：它是那块视图的属性，新进程是新视图。

## 这一条没证明到的（诚实清单）

- **官方 Electron 桌面宿主**上这条通道通不通，没量过（本票的宿主是 `dsh web`）。
- **那七颗按钮在真 DSH 界面的那一格里真的画出来了、点下去真的发出了请求**，没有自动化证据：
  DSH 的首启流程要求先配工作区或 API Key，界面停在引导页上，那一格渲染不出来；把窗口那一页
  换成最小宿主页之后，DSH 客户端的启动图在**窗口这个 target** 上没有把模块表建完
  （实测轮询 240 秒仍 `__ModuleLoader__.import === undefined`）。这部分由
  `tests/toolbar.spec.ts`（纯判断逐条钉住）与 `tests/panel-toolbar.spec.ts`（真通道逐动作读回）
  从两侧夹住，中间那一段（DOM 点击）**没有**自动化证据。
- **面板那一按慢**：实测**0.1–1.1 秒**（多数在 1 秒上下，反复按也慢），而插件侧同一个动作只要
  0.07–0.2 秒。多出来的约 0.9 秒在宿主那一侧（HTTP 往返 + 外壳每次发布都要去 CDP 端点列举目标、
  并对每个空间问一次 `cookies.get({})`）。**没有为它动任何东西**：轮询间隔没改，
  `shell/preload.js` 那条边界一个字节没动 —— 拿一条边界去换一次按钮的响应速度，是把架构卖给
  一个可以单独优化的问题。拆开这 0.9 秒是**另一张票**的事。
- **用户自己用 Ctrl+滚轮调过的缩放，会被下一次导航覆盖回插件的期望值。** 一个属性只能有一个
  主子 —— 这是"跟视图走"这条选择的必然代价（跟站点走会让点一个链接就失去缩放，见上）。
- 屏幕 dpr 不是 1.5 的机器上（尤其多显示器 dpr 不同时）缩放与截图尺寸会是什么样，**没量过**。
- 缩放对**光标覆盖层画在哪**没有像素断言：覆盖层与快照同系（页面 CSS 像素），所以它跟着缩放走；
  "缩放后点击仍然命中"已经验了（上面第 1 条），但"覆盖层画在元素正上方"没有一条像素用例。
- `zoom-pixels` 那条真窗口量具需要**一个可见的桌面**（窗口被隐藏或最小化时抓不到画面）。
  本机（交互式桌面）稳定通过；**无人值守/锁屏的 CI 上没试过**。
