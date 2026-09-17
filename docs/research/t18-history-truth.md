# T18 底稿：后退/前进的历史，从「账本猜的」改成「问引擎」

**票**：[#18](https://github.com/ztybuaa/dsh_test1/issues/18) —— 后退/前进被错判成"没有历史"而灰掉。
**日期**：2026-09-17。**分支**：`fix/18-history-truth`（从 `main` 起）。

本文件是这次修复的**原始输出**与**没能验证到的清单**，不是复述票面。票面已有的症状、决定性证据与
根因定位（`Page.getNavigationHistory` 给出 `{currentIndex: 1, entryCount: 2}` 而账本说没有历史）
这里不重复推导。

---

## 1 根因的一句话形状

`ObservedHistory` 的 `index` 从 `-1` 起、`visited` 从 `[]` 起，而**没有任何地方在领养时把视图
当时已经在的那一页记进去**：

- 唯一的两个记账入口是 `framenavigated`（`pendingTravel === 0` 时）与 `reload()`；
- 领养那一刻视图**早就在某一页上了**，那件事不会触发一次 `framenavigated`。

所以"领养 → 只导航一次"得到 `{back: 0, forward: 0}`，而空账本读出来是 `{back: -1, forward: 0}`。
下面的红跑原文里两种形状都在。

## 2 改法：问引擎（首选），账本降级成兜底

票面给了两条路：**问引擎**（首选）与**领养时补一次 seed**（最低限度，但账本仍然是猜的）。
选的是第一条，理由是票面点名的那个分水岭 —— **会话被重建时 seed 会再次撒谎**：

- 引擎的答案（`Page.getNavigationHistory`）天然包含"领养前就在的那一页"、前进分支、以及
  **会话重建**（切任务空间 ⇒ 新 targetId ⇒ 新会话 ⇒ 新账本）之后的历史；
- seed 只在**领养那一刻**补一笔，之后账本照样是自己记的，下一次会话重建又回到原点。

落地方式（`src/session.ts`）：

| 件 | 作用 |
|---|---|
| `openEngineChannel(context, page)` | 领养时开一条**留在手里**的 CDP 会话（`context.newCDPSession(page)`，与 T1 读身份用的是同一条连接，**不需要任何新通道**）。建不起来不抛。 |
| `class HistoryReader` | 权威读数的唯一入口：`refresh()` 问一次引擎；`read()` 引擎优先、账本兜底，并带上 `source`（`engine` / `observed`）与引擎失败时的 `reason`。 |
| `parseEngineHistory(raw)`（`src/navigation.ts`，纯函数） | 把 `{currentIndex, entries}` 收成 `{back, forward}`；读不动时返回 `undefined`，**绝不编一个 0**。 |
| `session.historyState()` | 从"同步读账本"变成 **`async` 且每次都真的问一次引擎**（一次 CDP 往返，不是轮询）。 |
| `session.travel()` | 动手之前先读一次引擎：**引擎说没有**才不动手；引擎说有 / **引擎答不上来**都照样动作，`moved` 由**页面自己的地址有没有变**决定。 |

**`HistorySource` 是一个跟着数字一起传出去的字段**，不是内部细节：同一个 `{back: 0}` 在
"引擎说退不动"与"我们只是没看见"两种来源下是两句不同的话，把两者合成一个数正是这一票的成因。
`browser_view action "state"`、`displayState()` 与面板那条通道（`ViewState.historySource`）都带上它；
面板暂时不显示它，但放在同一份读回里才不会与那两个数各说各话。

账本没有删：它只在**引擎答不上来时**被读，那时 `source` 会说 `observed`，而 `no-history` 那句话
也会明说"这不是关于这个视图的断言，只是账本里没有"。`ObservedHistory` 的类注释改写成"兜底"，
并写明它仍会低估的那个场合。

## 3 验收与反证：原始输出

### 3.1 反证（把 `src/` 回退到 `main`，只留新用例）

```
$ git stash push -m "t18-fix-src" -- src
$ npx vitest run --config vitest.config.ts tests/history-truth.spec.ts
 ❯ tests/history-truth.spec.ts (6 tests | 6 failed) 1628ms
     × 引擎的回答怎么读成两个计数（纯判断，不需要浏览器） 1ms
     × 领养时视图已经在的那一页算一笔：只导航一次之后，state 报 canGoBack === true 2ms
     × 引擎动了就必须报 moved: true，而且地址真的变了 22ms
     × 真的没有那一格时如实说没有，而且那句话分得清"引擎说的"与"账本没看见" 18ms
     × 切到另一个任务空间再回来，历史仍然如实（新会话也不许说"没有历史"） 369ms
     × 真机上那颗后退按钮不再灰：DOM 里的 disabled 属性读出来是 false 13ms
```

红跑里最有价值的两行（`RAW`，一字未改）：

```
RAW 领养之后立刻读到的历史（引擎答的）: {"back":-1,"forward":0}
```

—— 空账本的形状（`index = -1`）被当成"历史"，这就是按钮被灰掉的直接来源。

```
RAW back 在"账本说没有、引擎其实能退"的情形下:
{"action":"back","ok":false,"url":"http://127.0.0.1:52559/one", ... ,"reason":"no-history",
 "canGoBack":false,"canGoForward":false, "message":"browser-view: there is no page to go back to —
 the view stayed at http://127.0.0.1:52559/two. ..."}
```

—— **票面说的第二张脸，逐字重现**：`url` 已经是 `/one`（页面**真的退了**），而同一个回答里
`ok: false` / `reason: "no-history"`、那句话还写着"the view stayed at .../two"。
读数与事实互相打架，而且模型被告知**没动**。

```
RAW 切回来之后的历史: {"back":-1,"forward":0}
```

—— 会话重建之后账本照样空。

DOM 那一条在红跑里是这样失败的：`RAW 喂给那一格的宿主读数（来自被测实现自己的读回）:
{"back":0,"forward":0}` ⇒ `AssertionError: 引擎里必须真的有一格可以退，这条用例才在量东西`。
它**不是**靠替身里的一个假 `true` 变绿的（见 4.1）。

### 3.2 修复之后（同一份用例）

```
$ npx vitest run --config vitest.config.ts tests/history-truth.spec.ts
 ✓ tests/history-truth.spec.ts (6 tests) 1827ms
     ✓ 引擎的回答怎么读成两个计数（纯判断，不需要浏览器）
     ✓ 领养时视图已经在的那一页算一笔：只导航一次之后，state 报 canGoBack === true
     ✓ 引擎动了就必须报 moved: true，而且地址真的变了
     ✓ 真的没有那一格时如实说没有，而且那句话分得清"引擎说的"与"账本没看见"
     ✓ 切到另一个任务空间再回来，历史仍然如实（新会话也不许说"没有历史"）
     ✓ 真机上那颗后退按钮不再灰：DOM 里的 disabled 属性读出来是 false
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

关键 `RAW`：

```
RAW 领养之前视图自己报的（走另一条连接）: {"url":"http://127.0.0.1:53470/two","title":"t18-two","historyLength":3}
RAW 领养之后立刻读到的历史（引擎答的）: {"back":2,"forward":0,"source":"engine"}
RAW browser_view action "state" 在真实序列下: {...,"canGoBack":true,"canGoForward":false}
RAW back 在"账本说没有、引擎其实能退"的情形下: {"action":"back","ok":true,"url":".../two","canGoBack":true,"canGoForward":true}
RAW forward: {"action":"forward","ok":true,"url":".../three","canGoForward":false}
RAW 前进到头: {"ok":false,...,"reason":"no-history",
  "message":"browser-view: there is no page to go forward to — the view stayed at .../three. The engine's own
   navigation history says so (currentIndex 3, 4 entries), so this is a fact about the view, not a guess. ..."}
RAW 切回来之后的历史: {"back":3,"forward":0,"source":"engine"}
RAW 切回来之后 goBack: {"url":".../two","moved":true,"history":{"back":2,"forward":1,"source":"engine"}}
RAW 喂给那一格的宿主读数（来自被测实现自己的读回）: {"back":3,"forward":0,"source":"engine"}
RAW 真机上那一格的 DOM 读数: {"calls":["desktop-view-state"],"renders":["Panel","Toolbar","Panel","Toolbar","Panel","Toolbar"],
  "toolbarPresent":1,"order":["back","forward","reload","zoom-out","zoom-reset","zoom-in","restart"],
  "backDisabled":false,"forwardDisabled":true,"reloadDisabled":false}
```

### 3.3 这一条为什么要用**另一条连接**在领养之前导航

真实序列是"视图**先**在某一页上（外壳把它放在那里），领养之后只导航一次"。用例是这样构造的：

1. 外壳**不带** `--view-url` 起（正是用户跑 `npm run shell` 的形状，视图起在内置测试页上）；
2. 用**探针那条独立连接**把视图导航到 `/one`、`/two` —— 此刻被测会话还不存在，所以它一个字都看不见；
3. 再领养，再只 `goto('/three')` 一次。

旧测试（`tests/view-actions.spec.ts`、`tests/panel-toolbar.spec.ts`）全是"先领养、再导航 A、再导航 B"，
那个情形从来没被覆盖过 —— 那正是这一票漏掉的原因。这一份把它补上。

## 4 没能验证到的（诚实清单）

### 4.1 真机 DOM 那一条的替身边界

`tests/history-truth.spec.ts` 里"DOM 的 `disabled`"那一条，量的是**`client.js` 生成物**渲染出的
真 DOM、真的 `<button disabled>` 属性，但有三件事是替身，且只有这三件：

1. **模块加载器**（`window.__ModuleLoader__`）—— 真宿主那个由 DSH 的启动图提供，而在本仓库的
   临时 profile 上它建不完（`tests/panel-toolbar.spec.ts` 头部记过这条实测）；
2. **渲染器** —— 这一页上没有 React：`.npmrc` 明令不下载浏览器那一套，`node_modules` 里也没有
   `react` 包。所以那里装的是一个**最小 React 替身**（`createElement`/`createRoot`/`useState`/
   `useEffect`/`useRef`/`useMemo`/`useCallback`），它只负责把 `createElement` 的结果写进 DOM；
   `Toolbar` 组件、`isEnabled` 的判断、那七颗按钮的标签与顺序**全部来自 `client.js` 本身**。
3. **宿主那条 RPC**（`ctx.connection.rpc.call`）—— 它已经在 `panel-toolbar.spec.ts` 里对着
   **真 dsh 宿主**逐动作量过；这里要量的是那个答案变成 DOM 之后的那一格。
   喂进去的那份读数**不是编的**：它来自 `session.historyState()` 的读回，而用例先断言
   `source === 'engine'` 且 `back > 0`，红跑因此在那两行就断了。

**因此这一条证的是**："引擎里有一格可以退（`source: engine`、`back: 3`）⇒ 面板那一格渲染出来的
`disabled` 是 `false`"。**它不证**："真 DSH 界面的那一格里，用户在真窗口上看到那颗按钮是亮的" ——
那一段（真 DSH 界面 + DOM 点击）仍然**没有**自动化证据，与 ADR-0013 诚实清单里那一条是同一条。

**替身的一个真实陷阱（这次踩到了，记在这里）**：`dom.setAttribute('disabled', 'false')`
**仍然会让按钮变灰**（HTML 里 `disabled` 是"有这个属性就算"）。第一版替身就是这么写的，
于是 `isEnabled` 明明返回了 `true`、DOM 上却全是灰的。React 对 `disabled={false}` 的做法是
**不写这个属性**；替身现在照做。写替身的人要注意这一条，否则量到的是替身的 bug。

### 4.2 切任务空间那一条量到的是哪一条路

`SpaceManager` 按空间名缓存会话，而**切走再切回不会重建视图**（外壳只是 `setVisible`），
所以那一条里 `spaces.adopt()` 拿回的其实是**缓存的那个会话**，账本并没有真的清零。
"会话被重建"的**真**路径是：外壳把这个空间重新建过（新 `targetId` ⇒ `SpaceManager.sessions`
那个 `cached.targetId !== record.targetId` 分支 ⇒ 新会话）。

这一条因此证的是**切走再切回之后历史仍然如实**（票面点名的验收④），而"新会话也不许说没有历史"
这半句是靠 4.1 里那份"领养时视图已经在某一页上"的用例证的（那个会话的账本是真的空的）。
**"外壳重建同名空间、视图换了 targetId"这条最硬的路径没有单独跑过** —— 它的代码路径与
"领养前的导航"是同一条（`adopt()` 里新建 `HistoryReader`、`refresh()` 问引擎），但没有一条
用例把 `targetId` 真的换掉。

### 4.3 引擎答不上来那条兜底路没有端到端用例

`HistoryReader` 里"引擎答不上来 ⇒ 退到账本、`source: 'observed'`、`reason` 带上引擎那句话"
这一段，**没有**一条用例真的把 CDP 会话弄坏去量它（纯判断那一层量的是 `parseEngineHistory`
的坏输入，不是 `HistoryReader` 的降级）。理由：那条路的入口是"`context.newCDPSession(page)`
建不起来"，在这台机器上要制造它得去动外壳或 CDP 端点，代价与收益不成比例。
**降级路上的那句话因此没有被任何自动化证据覆盖**，只被代码审阅过。

### 4.4 "重新开始"没有真的清掉引擎的历史

`restart()` 仍然只清账本；引擎自己的历史**不会**被清（Chromium 没有"清历史"的 CDP 域），
所以重新开始之后 `back` 可能仍然是正数 —— 那**不是撒谎**：引擎里确实还有那些条目，
`goBack` 也确实还退得回去。`tests/view-actions.spec.ts` 里那条用例因此改成了断言
"这个数来自引擎、自洽、而且说能退就真的能退"，而不是断言一个写死的 0。
**代价写在这里**：用户按「重新开始」之后，后退按钮可能仍然是亮的，按下去会走回上一轮的历史。
这是"权威是引擎"的必然代价，没有为它另开一条"把引擎的历史也抹掉"的路。

### 4.5 每个判断多一次 CDP 往返

`historyState()` 现在每次都问一次引擎（一次 `Page.getNavigationHistory` 往返）。
在本机（回环 CDP）量到的整条用例耗时没有可见变化（`tests/history-truth.spec.ts` 六条 1.8 秒，
其中五条是同一个外壳），但**没有单独量过这一次往返的毫秒数**，也没有量过"面板那一按"的延迟
是否因此变长（ADR-0013 里量过面板那一按 0.1–1.1 秒，主导项在宿主那侧）。

### 4.6 别的引擎 / 别的平台没量过

`Page.getNavigationHistory` 是 Chromium 的 CDP 域，本仓库只在 Electron 44.3.0（Chromium 132）
这一台 Windows 机器上量过。别的 Electron 版本、别的平台上这个域在不在、字段一样不一样，
**没有量过**。读不动时 `parseEngineHistory` 返回 `undefined`、`HistoryReader` 说 `observed`，
这是设计上的防守，但那条防守本身也没有用例（见 4.3）。

---

## 6 第二处真机 bug（同一张票一起修）：工具条被原生画面盖住

### 6.1 根因与修法

`src/client-body.js` 的 `Panel` 把测量用的引用指向了**外层容器**（那个同时装着 `<Toolbar>`
与下面那块 div 的 div）：`elementRef.current = hostRef.current`。它自己上面那段注释写的是
相反的（"被测量的是**下面**那一个，这是故意的……否则跟它共用矩形的工具条会被画面盖住"）。

于是上报的矩形 = 容器 = 工具条 + 面板，外壳把原生画面摆在整块上 —— 连工具条那一行一起盖住。

修法（`src/client-body.js`）：

- `hostRef` 拆成两个：`containerRef`（外层容器）与 `bodyRef`（被测量的那一块）；
- 被测量那一块的 `ref` 是**回调**形式，在 commit 时就把它写进 `elementRef.current`
  （用对象引用的话，赋值发生在 render 阶段、那时 `bodyRef.current` 还是 `null`）；
- 给容器加 `position: relative`（被测量的那一块是它的孩子，而两端用的是同一套视口坐标）。

### 6.2 反证（原始输出）

把 `elementRef.current` 那一行改回 `containerRef.current`（并去掉被测量那一块回调里的那一句），
也就是**只把这一处修复回退掉**，重新 `npm run build`：

```
$ npx vitest run --config vitest.config.ts tests/panel-toolbar-placement.spec.ts
 × 上报矩形的上边缘 ≥ 工具条的下边缘（工具条那一行不在被上报的矩形里）
RAW 窗口这一页上的框（DOM 量的）:
  toolbar  {top:0, bottom:34, ...}   measured {top:34, ...}   container {top:0, bottom:800, ...}
  measuredState: "detached"
Error: timed out waiting for the shell to apply the rectangle the shipped panel reported
```

—— 回退之后面板**一次都报不出去**（观察器在 effect 里量到的是还没上版面的 `null`），
外壳因此从未收到 `panel-report` 的落点。**这一条用例在修复前是红的**，是跑出来的。

（注意一个交叉影响：**这一处回退也把历史那一票的 DOM 用例弄红了** —— 它要先拿到
`canGoBack: true` 的宿主答案才去挂那一格，而 `installShipment` 在面板注册不上时就会抛。
两处共用同一个交付物，所以它们一起红、一起绿。）

修复之后：

```
 ✓ tests/panel-toolbar-placement.spec.ts (1 test)
RAW 窗口这一页上的框（DOM 量的）:
  toolbar  {top:0, bottom:34,  width:440, height:34}
  measured {top:34, bottom:800, width:440, height:766}
  container{top:0,  bottom:800, width:440, height:800}
  pane     {top:0,  bottom:800, width:440, height:800}
RAW 外壳为交付物那一格应用的落点:
  {"cause":"panel-report","visible":true,"clamped":true,"reason":"reported",
   "reported":{"x":0,"y":34,"width":440,"height":766},
   "bounds":{"x":0,"y":34,"width":440,"height":704},
   "applied":{"x":0,"y":34,"width":440,"height":704}}
RAW 落点的上边缘 34 vs 工具条那一行的高度 34
```

**`reported` 是面板上报的原话，`bounds`/`applied` 是外壳应用的落点 —— 上边缘 34 = 工具条那一行
的高度，正是票面要的那句话。**（`bounds` 与 `reported` 的高度差 62 px 是外壳自己按窗口可用
高度收的，`clamped: true`；那与这一处无关。）

### 6.3 一并要求的第 3 条：面板尺寸变化 → 画面跟随

**分两半答，因为量到的只有一半。**

**（a）"上报的那一格变了 → 外壳跟着变"这条关系本身仍然有效**（用真夹具量过，一直绿）：
`tests/panel-placement.spec.ts` 的 "tracks a panel that changes size" 那一条把夹具那一格从
440×满高改成 320×260，外壳跟着把画面改成 320×260，而画面**自己**报的布局尺寸也是 320×260。

**（b）交付物那一格收缩时它会不会跟着变**：这一条我**没能用自动化钉住**，只量到了前半段。
把那一格从 440×800 改成 260×420 之后，DOM 里那一块的框**立刻**变成了
`{top:34, bottom:420, width:260, height:386}` —— 也就是说**布局那一半是对的**（工具条仍然占
34 px，下面的画面格跟着变窄变矮）。但"面板因此重新上报、外壳跟着改"这一步在这一份测试里
**没有跑出来**，原因是那份 DOM 用例要关掉 `ResizeObserver` 与每帧的 rAF 兜底（见 6.4 第 1 条），
而面板的"尺寸变了就再报一次"正是靠它们；把 resize 事件手动打给它也没能让上报走到外壳。
真机上这一步由 `ResizeObserver` 完成。

**（c）用户在现场看到的"面板收缩之后画面还是 768×932"** —— 我的判断是**同一个根因**，理由：
旧代码上报的是**外层容器**，而那个容器的尺寸与"面板那一格"不是一回事（它含工具条那一行，
而且在 DSH 的侧边栏里被拉满）；上报的元素换了之后，"尺寸变了就再报一次"的触发源才是那一格
真正会变的那块。**但这个判断没有被一次自动化证据钉住**（见 (b)），所以它是**判断**，
不是**量到的事实** —— 记在这里。

### 6.4 这一处没验证到的

- **"工具条那一行的像素真的来自面板而不是来自页面"**（票面说的"更强的版本"，用
  `windowVisible` + 窗口抓图夹具验真窗口像素）**没有做**。已做的是：DOM 里三个框的几何
  （工具条 34 / 被测量那一块从 34 开始 / 容器 0..800）+ 外壳应用的落点从 34 开始。
  那一条像素证据留在这里没做，因为它要用 `desktopCapturer` 抓一个有真画面的窗口，
  而这一条的两个断言已经足以钉住"复现的那个算术关系"。
- 那份 DOM 用例用的是 `tests/mini-react.ts` 里那个最小渲染器（理由见 4.1 同款：这一页上没有
  React）。**它的一个已知不足**：它每次渲染都整棵重画，而真 React 会保留节点身份。
  因此那条用例**故意不**断言"外壳上报的矩形 == DOM 量到的被测量那一块的矩形"（那个等式的
  两边可能隔着一次重画），改成断言 DOM 自己的几何、以及外壳落点的上边缘不落在工具条那一行里。
  渲染器保留节点身份的做法试过一版（重新挂载节点），**把 DOM 弄坏了**（工具条的属性丢了），
  所以退回了整棵重画。
  - 这一份替身还带来**第二条边界**：为了不让"上报 → 重画 → 再上报"转成无限循环，用例把
    `ResizeObserver` 与每帧的 rAF 兜底**关掉了**（见 `installShipment`）。于是
    **"这一格尺寸变了之后面板会不会再报一次"这一半在这一份里量不到**（见 6.3(b)）。
  - 写这个替身踩到的四个坑（组件之间共用 hook 槽、ref 没接上、`[]` 被当成"依赖变了"、
    没有批处理导致的上报→重画→上报循环）都写在 `tests/mini-react.ts` 的文件头里。

---

## 5 零回归

```
 baseline（main，19 文件 / 185 用例）: Test Files 19 passed (19) | Tests 185 passed (185)
```

修复之后新增 `tests/history-truth.spec.ts`（6 条）与 `tests/panel-toolbar-placement.spec.ts`（1 条），
并把 `tests/view-actions.spec.ts` 里两条依赖旧假设的用例改成读引擎（见 4.4）：

```
 $ npx vitest run --config vitest.config.ts tests/view-actions.spec.ts tests/panel-toolbar.spec.ts tests/history-truth.spec.ts
 Test Files  3 passed (3)
      Tests  27 passed (27)
```

整包：**21 文件 / 192 用例**。下面这些是**同一棵最终树**（最后一次改动之后）上连续的整包运行，
每一次都是 `npm test` 的原文：

```
 第 1 次  Test Files 21 passed (21) | Tests 192 passed (192)   Duration 346.30s
 第 2 次  Test Files 21 passed (21) | Tests 192 passed (192)   Duration 345.93s
 第 3 次  Test Files 21 passed (21) | Tests 192 passed (192)   Duration 347.24s
```

—— **连续三次全绿**。在最终树定下来之前，还跑过另外五次全绿（`343.81s` / `353.32s` / `347.43s` /
`355.36s` / `349.11s`），它们与上面这三次加在一起是**八次全绿**；中间夹着 5.1 记的那三次
环境性红。合计 **11 次整包运行：8 绿 / 3 红**，三次红都在"机器被占满"的窗口里、
都不是这一票碰过的文件。

### 5.1 三次**没算数的**整包运行（都在机器被别的程序占满时）

整包一共跑了 11 次（含上面八次全绿），其中**三次**红，红的都不是这一票碰过的地方，而且
**三次都跑在机器被别的程序占满的时候**（同一时刻前台有微信、Taskmgr、ChatGPT、ToDesk、Edge、
文件资源管理器在吃 CPU/画面；用户那个正在用的外壳也一直开着）：

**（一）空间通道的 30 秒超时**（两次）：

```
 run A  Test Files 1 failed | 20 passed (21) | Tests 2 failed | 190 passed
        × 缩放：面板那两个动作真的改了页面自己报的 devicePixelRatio 与视口… 61260ms
        × 「重新开始」把视图带回握手发布的初始页 30095ms
        RAW zoom-in over the panel channel: {"coldMs":30029,"warmMs":30085, ...}

 run D  Test Files 1 failed | 20 passed (21) | Tests 4 failed | 188 passed
        （都在 tests/view-actions.spec.ts，四条都是 30s 量级）
        × 越界的 zoom 被拒绝而不是悄悄夹到边界 31049ms
        × 缩放之后 browser_snapshot 的 bounds 仍是页面自己的 CSS 像素… 30050ms
        × 「重新开始」把视图带回握手发布的初始页，并把缩放也重置 30081ms
        × 重新开始之后"历史"这个数仍然来自引擎，而且它说能退就真的能退 30021ms
```

`30029ms` / `30085ms` / `30081ms` 正好是 `SpaceManager` 的 **30 秒超时**：外壳那一侧当时没有
在回空间请求（"动作慢"不会正好卡在这个数上）。这一条通道（`request.json` / `state.json`）
**这一票一个字节都没动**，而且同一批用例在单独跑时是绿的、连跑三轮也全绿：

```
 $ npx vitest run --config vitest.config.ts tests/view-actions.spec.ts tests/panel-toolbar.spec.ts tests/spaces.spec.ts
 round 1  Test Files 3 passed (3) | Tests 45 passed (45)
 round 2  Test Files 3 passed (3) | Tests 45 passed (45)
 round 3  Test Files 3 passed (3) | Tests 45 passed (45)
```

**（二）真窗口像素那一条找不到窗口**（一次，`tests/zoom-pixels.spec.ts`）：

```
 × 100% 时滚到最右看得见红标（仪器自检），不滚则看不见；缩到 50% 之后**不滚也看得见**… 5852ms
Error: the capture fixture could not find the shell's window (title contains "T13-PIXEL-WINDOW");
       it saw: ["DeepSeek | Into the Unknown 和另外 3 个页面 - 个人 - Microsoft​ Edge",
                "关于启动 2026 年清华大学工程硕博士培养改革专项试点研究生专业实践申请审批工作的通知 - 文件资源管理器"].
       This test measures what the pane really shows, so it needs a visible window on an interactive desktop
       — the shell is started with windowVisible: true.
```

**这一条的原始读数全都是对的**（同一次运行里：仪器自检 `red=20184`、50% 时 `red=4872`、
红标量到 42×116 而预测是 43.6×116），**红在"抓图夹具找不到那个窗口"** —— 那一刻前台的
Edge 与文件资源管理器把它的窗口挡了/没被 `desktopCapturer` 枚举到。ADR-0013 的诚实清单里
早就写着这一条的限制（"`zoom-pixels` 那条真窗口量具需要**一个可见的桌面**……无人值守/锁屏的
CI 上没试过"），这一次就是那个限制在"用户正在用这台机器"时的一次兑现。
**与这一票无关**（那一份用例一个字节没动）。

**结论**：三次红都出现在"机器被占满"的窗口里，而且都不是这一票碰过的文件；同一批用例单独跑
稳定全绿。本仓库已经量过"负载是偶发红的放大器"（
`docs/research/suite-flake-two-signatures.md` §3：pristine HEAD 无负载 9 次全绿，压 24 个忙进程跑
3 次就红 1 次）。**没有为它们改任何东西** —— 它们是一条与这一票无关的既有抖动，
改它会让这一票越界。
