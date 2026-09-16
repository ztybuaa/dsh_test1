# 0013 — 面板的工具条经共享 `/api` 通道驱动视图；缩放只做布局视口，塞不下固定宽度页面

**状态**：已接受
**日期**：2026-09-16

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

## 决定二：缩放只改**布局视口**，它**不解决**"固定宽度页面塞进窄栏"

### 四条路各自量到什么

夹具：`#bar { width: 1200px }`，视图矩形 `0,0,620,800`，屏幕 dpr 1.5（基线截图 930×1200）。
仪器：在页面**最右端**（x=1150..1195）放一块**红标**，看它**在不在截图里** ——
这是唯一能回答"整条可见吗"的量（`innerWidth` 变小只说明视口窄了）。

| 路 | 布局视口 | `innerWidth` | 页面读到的 dpr | 截图尺寸 | 跨导航 | 红标可见（=真的缩小了） |
|---|---|---|---|---|---|---|
| A `Emulation.setPageScaleFactor` | ✗ | ✗ | ✗ | ✗ | — | **✗（这台宿主上完全无效）** |
| B `setDeviceMetricsOverride` 只给 `deviceScaleFactor` | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ |
| C `page.setViewportSize()` | **✓** | **✓** | ✓（补一条覆盖） | **✓** | **✓** | **✗** |
| D `mobile: true` | ✓ | ✓ | ✓ | ✗ | ✓ | ✗（本轮没复现出视觉缩放；见下） |
| E Electron `webContents.setZoomFactor()` | 插件够不到 | | | | | 未量 |

**六种候选的红标都是 0 个像素。** 也就是说：**在这台宿主上，插件够得到的任何手段都不能把
固定宽度 1200px 的页面缩小到装进 620px 的栏里。** 这是本 ADR 最要紧的一句话。

> 关于 D：早先一轮量到过 `mobile: true` + `deviceScaleFactor: 1` 时
> `visualViewport.scale = 0.5167`（视觉缩放），但那**没有复现**。原因是
> `page.setViewportSize()` 会向同一个 CDP session 发 Playwright **自己**的
> `Emulation.setDeviceMetricsOverride`（`playwright-core/lib/coreBundle.js:47091`），
> 把 `mobile` 标志洗掉 —— 一旦走过 `setViewportSize`，设备模拟的拥有者就变成了 Playwright。
> 所以那条路不可靠，而它本来就是**移动端模拟语义**（改 `window.screen`、`fixedLayout`），
> 不该拿来当桌面浏览器的缩放。

### 为什么还是采用 C，以及它的准确语义

- **它能做到的**：布局视口按比例变小（`floor(620/zoom)`），于是**同屏能看到更多页面内容**，
  而且页面自己读得到（`innerWidth` 变小）、跨导航保持、重置能回去。用户能横向滚动看到右边 ——
  比"什么也做不了"强。
- **它做不到的**：**内容没有被缩小**，所以固定宽度的排版仍然被裁切。
  `tests/view-actions.spec.ts` 里有一条**反证断言**钉住这件事（缩放 194% 之后，页面最右端的
  红标仍然不可见）。将来谁把这条当 bug 去修，会先撞到它。

### 截图语义在这里被**有意作废**

T5 时代钉住的是"截图 = 视口 × 屏幕 dpr"（620×800 × 1.5 = 930×1200）。
**那条只在 `zoom = 1` 时成立**，而且只在"这个视图从来没有被模拟过"时成立。缩放之后：

```
zoom=1  → 620×800（重置之后；或未模拟过的视图 930×1200）
zoom=1.25 → 496×640
zoom=2   → 310×400
zoom=2.5 → 248×320
```

**根因**（不写下来将来一定有人把它当回归去"修"）：Playwright 在 Electron 视图上截图时，
`deviceScaleFactor` 取自它**自己**记的 `_metricsOverride`（`playwright-core/lib/coreBundle.js:37196`），
而那个值算出来是 1；画面由 Electron 的合成器给，模拟覆盖不改变交付图片的像素。
试过"先 `setViewportSize`、再发 `deviceScaleFactor = zoom` 的覆盖、再 `setViewportSize`"，
量到仍然是 `shot=310x400`。**只要走 CDP，截图尺寸就只能等于布局视口。**
新关系与新数字由 `tests/view-actions.spec.ts` 两条断言钉住（从**磁盘上的 PNG** 与**页面自己的
`devicePixelRatio`** 读出，不是从实现自己的变量）。

### `bounds` 的坐标系（对 ADR-0008 的影响）

ADR-0008 说元素的 `bounds` 是"视口 CSS 像素、与视图 1:1"。**那条只在 `zoom = 1` 时成立。**
实测 zoom=2 时：`#t13-hit` 的 bounds 仍是 `{x:10,y:90,width:90,height:28}`（页面自己的布局没变），
但视口从 620 变成了 310 —— 同一份 bounds 描述的是一个更窄的视口。

**没有任何流水线依赖"bounds == 窗格物理像素"**（考据与实测）：
面板的摆放用的是**面板矩形**（`DshPanelRect` 量出来的那个），不碰元素 bounds；
覆盖层画在页面里、用的是与 `getBoundingClientRect()` 同一套坐标（它随后者一起缩放）；
`browser_extract` / `browser_evaluate` 的结果也跟着 `innerWidth` 走 —— 这三条都是"页面自己的坐标系"，
而缩放改变的正是那个坐标系本身。所以缩放**不破坏**任何现有流水线，它只改变它们的单位。

### 外壳侧那条路为什么本期不做

要让"塞进窄栏"与"截图尺寸守恒"同时成立，只能由外壳去 `webContents.setZoomFactor()`
缩放那块 `WebContentsView`。插件够不到 Electron API。够到它需要**新增一条"插件 → 外壳"的
控制通道**（既有那条文件通道是给任务空间用的，硬塞进去就是拿一条通道干两件事）。
**代价比想象的小**（加一个 `zoom` 字段进 `request.json` 是十几行外壳代码），
但那仍然是"一条通道干两件事"的架构取舍，且与"要真浏览器语义就得先定那条通道怎么走"这个
更大的问题绑在一起。所以本期**不做**，留给单独一张票；本 ADR 把前提写在这里。

---

## 后果

- 面板上那七颗按钮的可用性里，只有 `back` / `forward` 可能因为"已知不可能"而变灰，
  而那个"已知"是**会话观察到的历史**，不是浏览器的真值：它**可能低估**（会话领养之前走过的
  路不在账上）、**不会高估**。低估的代价是按钮一开始是灰的；高估的代价是按钮撒谎 —— 后者更糟。
- 面板与视图之间**没有推送通道**：视图自己导航（用户点页面里的链接、Agent 调工具）之后，
  面板那颗"后退"要到**下一次动作**之后才会亮。这不是缺陷的托词，是"面板只显示读回来的东西"
  这条取舍的直接后果，写在诚实清单里。
- **两个会话实例**：应用用自己的会话（`adopt()` → `SpaceManager` 缓存的那一个），而测试若另开一条
  `AdoptedViewSession` 去导航，面板**看不见**那一步（观察到的历史是会话自己的）。
  这是"同一套能力"这句话的边界：能力同源，但**观察是每个会话各自的**。
- `src/spaces.ts` 现在把握手说的 `initialUrl` 往下传给会话（`SpaceManagerOptions.initialUrl`），
  因为**空间状态表里那个 `url` 不是它** —— 那个值是"视图现在在哪"，会跟着导航变。

## 这一条没证明到的（诚实清单）

- **官方 Electron 桌面宿主**上这条通道通不通，没量过（本票的宿主是 `dsh web`）。
- **那七颗按钮在真 DSH 界面的那一格里真的画出来了、点下去真的发出了请求**，没有自动化证据：
  DSH 的首启流程要求先配工作区或 API Key，界面停在引导页上，那一格渲染不出来；把窗口那一页
  换成最小宿主页之后，DSH 客户端的启动图在**窗口这个 target** 上没有把模块表建完
  （实测轮询 240 秒仍 `__ModuleLoader__.import === undefined`）。这部分由
  `tests/toolbar.spec.ts`（纯判断逐条钉住）与 `tests/panel-toolbar.spec.ts`（真通道逐动作读回）
  从两侧夹住，中间那一段（DOM 点击）**没有**自动化证据。
- 屏幕 dpr 不是 1.5 的机器上 `floor(源视口/zoom)` 的取整会不会露出 1px 的缝，没量过。
- 缩放对光标覆盖层（T8）与点击命中的影响没有单独断言：覆盖层与快照同系，但没有一条
  "缩放后点击仍然命中"的用例。
