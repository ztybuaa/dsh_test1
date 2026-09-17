# T19：自动适配栏宽 —— 量出来的那些数

票 [#19](https://github.com/ztybuaa/dsh_test1/issues/19)。这份记的是**原始读数**与踩到的坑，
结论写在 [ADR-0014](../adr/0014-fit-to-pane-is-the-shells-job.md) 里。每条都标了它从哪来
（哪条用例、哪一行 stdout），**没有一条是推出来的**。

---

## 1. 跟手延迟：外壳侧 vs 面板那条路（这一条决定这张票能不能用）

票面点名"拖动侧边栏时如果有 1 秒延迟，这个功能就是废的"。两条路都量了：

| 路径 | 实测 | 出处 |
|---|---|---|
| 面板 → 宿主 → 请求文件 → 外壳 150ms 轮询 → 生效 | `coldMs 1016` / `warmMs 1008` / `zoom-reset 1005`（另一次整套跑：`1142` / `1017` / `1015`） | `tests/panel-toolbar.spec.ts` 每次跑都重新印 |
| 外壳自己：落点变 → 读页面两个数 → `setZoomFactor` | **26ms / 28ms / 22ms**（一次跳变 1226→620 三次不同的跑） | `tests/fit-to-pane.spec.ts` 的 `RAW 跟手延迟` |
| 同上，一段 24 步的拖动结束之后 | **32ms / 59ms / 0ms / 31ms** | 同上，`dragLatency` |
| 拖回宽处 | **12ms / 1ms / 3ms / 4ms** | 同上，`widenLatency` |

一次原样的原始行（`tests/fit-to-pane.spec.ts`，整套跑里的那一次）：

```
RAW 跟手延迟（一次跳变 1226→620）: {"jumpLatency":22,"settleMs":117,"jumpPaneMs":0,
  "frames":15,"firstFitFrame":{"at":1789649054952,"innerWidth":1200,"scrollWidth":1200,
  "clientWidth":1200,"dpr":0.7749999761581421,"fits":true},"jumpSentAt":1789649054930}
```

延迟是这么量的：窗口那一页 `setRect` 的那一刻（它自己 `Date.now()`）→ **页面自己**那一帧报出
`scrollWidth <= clientWidth` 的时刻（视图那一页的 rAF 时间线）。两个进程同一台机器、同一个时钟，
中间没有第三方。

`settleMs`（117ms）比 `jumpLatency`（22ms）大，是因为它是**测试自己**每 50ms 轮询一次看到的
稳定时刻 —— 那是量具的分辨率，不是功能的延迟。

---

## 2. 收敛：几步行、停在哪个值上

外壳每一次改缩放都发一行 `DSH_SHELL FIT`。固定宽度夹具（内容 1200px）拖到 620 的栏之后：

```
DSH_SHELL FIT {"space":"default","cause":"trailing","ms":36,"changed":2,"steps":[
  {"step":1,"clientWidth":1072,"scrollWidth":1199,"contentWidth":1199,
   "from":0.6024531218743335,"to":0.5386403224764683,"ratio":0.8940783986655546},
  {"step":2,"clientWidth":1151,"scrollWidth":1200,"contentWidth":1200,
   "from":0.5386403224764683,"to":0.5166458426420125,"ratio":0.9591666666666666},
  {"step":3,"clientWidth":1200,"scrollWidth":1200,"contentWidth":1200,
   "zoom":0.5166458426420125,"hold":"the page fills this pane already"}]}
```

读法：第 1、2 步各改一次；第 3 步读到"内容宽度 == 布局视口"（1200 == 1200）就停手。
**两次修改 + 一次确认**，与 `shell/fit.js` 顶部那段推演一致。

纯逻辑那一份（`tests/fit-rule.spec.ts`，用一个"布局视口 = 栏宽 / zoom"的模型）走的是同一个形状：

```
RAW 固定宽度 1200 在 620 的栏里: {"steps":[0.5166666666666667,0.5162361111111111,0.5166663078703704],
  "final":{"zoom":0.5166663078703704,"seen":{"clientWidth":1200,"scrollWidth":1200}},
  "held":"the page fills this pane already"}
```

（中间那个 0.51624 是**取整**造成的：`clientWidth` 是整数，所以目标值会在千分之一以内来回蹭一下，
第四次读回就停在"内容填满视口"上，`SAME_STEP = 0.005` 以内算同一档。）

---

## 3. 响应式页面：一步都不动（而且是"跑了但没改"）

真外壳，`/fluid`（宽度全是百分比），**来回拖 48 步**：

```
RAW 响应式页面来回拖了 48 步: {"before":{"zoom":1,"mode":"auto","fitPasses":28,"fitChanges":23},
  "after":{"zoom":1,"mode":"auto","fitPasses":45,"fitChanges":23},
  "dprBefore":1.5,"dprAfter":1.5,
  "facts":{"innerWidth":1226,"scrollWidth":1226,"clientWidth":1226,"barWidth":1226}}
```

`fitPasses` 涨了 17（适配真的跑了 17 轮），`fitChanges` **一次没涨**，`dpr` 1.5 → 1.5。
"没动"是**判断的结果**，不是"没跑" —— 这是这一条的读数里最重要的那一半。

纯逻辑那一份（`tests/fit-rule.spec.ts`）：八个栏宽来回走，每一步改的次数是 `[0,0,0,0,0,0,0,0]`。

---

## 4. 不震荡：缩放的**时间线**（页面自己逐帧写的）

`dpr = 屏幕dpr × zoom`（ADR-0013 量过），所以逐帧采 `devicePixelRatio` 就得到一条
由**页面自己**写的缩放时间线。

```
RAW 拖动时的时间线: {"dprAtRest":1.5,
  "narrowed":[1,0.969,0.947,0.883,0.861,0.84,0.775,0.753,0.689,0.668,0.625,0.603,0.582,0.56,0.538,1],
  ...
```

——等等，那一条最后有个 `1`，那是**一次误判**留下的痕迹，见下面第 6 节。修好之后同一段拖动是：

```
RAW 拖动时的时间线: {"dprAtRest":1.5,
  "narrowed":[1,0.969,0.947,0.883,0.861,0.84,0.775,0.753,0.689,0.668,0.603,0.582,0.56,0.538,0.517],
  "widened":[0.517,0.538,0.603,0.624,0.646,0.711,0.731,0.797,0.819,0.883,0.904,0.97,0.99,1],
  "framesNarrowing":47,"framesWidening":81,"dragLatency":0,"widenLatency":3}
```

变窄那一列**单调不增**、变宽那一列**单调不减**，一共 15 + 13 次变化。

---

## 5. 像素：整页真的在窗格里（而且同一个栏宽下 A/B 说得清）

`tests/fit-pixels.spec.ts`，真窗口、`desktopCapturer`、数两种颜色（与 `zoom-pixels.spec.ts`
同一支量具）。红标是页面最右端那一块（x=1150..1195），它**在不在画面里**就是"整页进来没有"。

```
RAW window pixels[wide]:               red=20184@{left:2245,top:186,width:87,height:232}  bar高 422
RAW window pixels[narrow-auto]:        red=5400 @{left:1163,top:148,width:45,height:120}  bar高 234   ← 拖到 620 之后（没人按过任何按钮）
RAW window pixels[narrow-manual]:      red=0                                              bar高 422   ← 同一个栏宽，按了一次 100%
RAW window pixels[narrow-manual-dragged]: red=0                                           bar高 422   ← 手动模式下又拖了一轮
RAW window pixels[narrow-auto-again]:  red=5400 @{left:1163,top:148,width:45,height:120}  bar高 234   ← 再交回自动
```

四个读数一起才成立：
**同一个 620 的栏**下，自动模式里红标在画面里（并且蓝条高度 422 → 234，内容真的被缩小了，
不是"视口变宽"那种假象），手动模式里它就不见了；再交回自动又回来。

---

## 6. 踩到的四个坑（每一个都是先红后改）

### 6.1 `setZoomFactor` 之后立刻读，读到的可能还是旧布局 ⇒ 同一个比例被乘两次

第一版没有等重新排版，结果：1200px 的页面在 620 的栏里被缩到 **0.2668**（`dpr` 0.4），
而"刚好塞下"是 0.5167 —— 正好是 `0.5166²`。页面被缩得**远小于**刚好塞下。
修法：两次读之间等页面自己报的数真的变了（`waitForRelaidOut`，5ms 轮询、300ms 上限）。

### 6.2 `documentElement.scrollWidth` 不会小于视口宽度 ⇒ 票面那条规则回不到 100%

实测：夹具页在 620 的栏里、`zoom=0.5166` 时页面报的是 `scrollWidth = 2400 = clientWidth`
（"塞得下"，因为它是被视口夹住的）。于是"栏拖回宽处"这一步**永远看不到自己还有富余**。
修法：外壳记下"这一页**曾经溢出时**有多宽"（只增不减、换页清空），用它当内容宽度。

### 6.3 把"没溢出时的 scrollWidth"也记下来 ⇒ 响应式页面被当成固定宽度页

第一次修 6.2 时是 `max(scrollWidth, 记忆)`，于是响应式页面在宽栏里被记成"1226px 宽的固定布局"，
栏一窄就被一路缩小：**`dpr` 从 1.5 掉到 0.375**（真外壳上量到的）。
修法：记忆**只在真的溢出时**更新。

### 6.4 "缩一次看看有没有变好"在拖动时是错的 ⇒ 页面停在 93% 而栏早就到了 620

复核式判据（"溢出没变小 ⇒ 缩放治不了"）在拖动里会误判：栏宽一直在变，"没变小"可能只是没追上。

```
DSH_SHELL FIT {...,"changed":4,"steps":[{"step":1,...,"to":0.6977712563063798},
  {"step":2,...,"to":0.6716048341948906},{"step":3,...,"to":0.6458599822174198},
  {"step":4,...,"to":0.6194873662768752}]}      ← 一步比一步小，而栏还在往下走
```
最终页面停在 `zoom=0.9295`（`innerWidth=667`，而栏是 620）。修法：改成**两份溢出样本的比较**
（判"内容宽度跟不跟着视口走"），与"谁在动"无关。见 ADR-0014 决定二"偏离三"。

### 6.5 `MIN_VIEWPORT_DELTA = 1` ⇒ 固定宽度页面被误判成"治不了"

判据第一版把门槛设成 1px（"只要视口动过就能比"）。整套跑的时候踩到：`Δ视口 = 1, Δ内容 = 1`
（页面报的内容宽度在 1199/1200 之间抖，而拖动中"视口差 1px"很常见）被判成"跟着视口走" ⇒
页面被判"治不了"、缩放被放回 100%、这份文档此后不再适配：

```
RAW 拖动时的时间线: {...,"narrowed":[1,0.969,...,0.538,1],"dragLatency":-1,...}
AssertionError: narrowing must not bounce back up: [...,0.538,1]: expected 1 to be less than or equal to 0.543
```

修法：门槛回到 8px（明确的信号才算证据）。回归用例：
`tests/fit-rule.spec.ts` › *内容宽度抖 1px 的固定宽度页面，不许被误判成"治不了"* ——
把门槛改回 1 它就红（这正是当时那条断言的红法）。

### 6.6 在飞的那一轮会把用户刚按的值改回去

面板上按 `100%` 之后，一次已经在跑的适配轮把它又改回 0.5167，而模式已经是 `manual`：

```
RAW 按下 100% 之后: {"reset":{"zoom":0.5166666666666667,...},
  "reading":{"zoom":0.5166666666666667,"mode":"manual","fitChanges":5}}
```
修法：每条空间记录一个 `zoomToken`，任何"指名改缩放/交回自动"都 +1，适配轮在**落笔之前**
再对一次。

---

## 7. 缩放治不了的溢出：试一次、放回 100%、此后不再碰

夹具 `/unfixable`（`width: calc(100% + 40px)`：内容永远比视口宽 40px，缩得越小视口越大、
内容跟着一起大，差消不掉）。真外壳：

```
DSH_SHELL FIT {"space":"default","cause":"navigation","ms":14,"changed":1,"steps":[
 {"step":1,"clientWidth":1226,"scrollWidth":1266,"contentWidth":1266,
  "from":1,"to":0.9684044233807267,"ratio":0.9684044233807267},
 {"step":2,"clientWidth":1266,"scrollWidth":1306,
  "declined":"this page's width follows its viewport, so its overflow (40px) cannot be removed by zooming
              — automatic fitting leaves this document at 100%","revertedTo":1}]}
```

然后**又拖了 30 步**：

```
RAW 治不了的溢出页（拖了 30 步之后）: {"facts":{"innerWidth":1100,"scrollWidth":1140,"clientWidth":1100,
  "devicePixelRatio":1.5},"reading":{"zoom":1,"mode":"auto","fitChanges":49}}
```

`fitChanges` 一个都没涨（49 → 49），`dpr` 还是 1.5。纯逻辑那一份同样：
"永远宽 1px"的页面走三十轮之后 `zoom = 1` 且 `declined` 有值。

---

## 8. `ResizeObserver` 那条断掉的线（票面第二条评论）

缺陷本来的形状（`tests/panel-observer.spec.ts`，纯 node，不需要浏览器）：

```
RAW 建立观察者那一刻（元素还没挂上）: {"observers":1,"observed":0,"reports":[null]}
RAW 元素挂上之后再测一次:            {"observed":1,"reports":[null,{"width":440}]}   ← 修好之后
RAW 换节点之后观察者盯着谁:          {"size":1,"onNew":true,"onOld":false}
RAW 每帧安全网:                      {"framesBefore":1,"framesAfter":1,"reports":2}
RAW stop 之后:                       {"disconnected":1,"framesAfterStop":1,"framesNow":0}
```

第一行是"从来没有执行过 `observe()`"那一刻的真实读数（`observed: 0`）；第二行是同一次挂载之后
的读数（`observed: 1`）。把 `pointObserverAt` 改回缺陷的样子，三条用例全红
（`the observer must really be watching the node: expected false to be true`）。

---

## 9. 面板上那句话：三种形状

```
RAW 缩放读数的四种形状: {"auto":"自动 78%","manual":"手动 90%","unknown":"90%","unreadable":"—"}
```

`unknown` 是"读不到模式"（旧外壳、或没有外壳那条读回）—— 那时**只显示百分比**，不猜一个前缀。

---

## 10. 这一票改到的既有断言（都为"多了一个控件/多了一个字段"，不是行为回归）

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `tests/toolbar.spec.ts` | 动作表多一个 `auto` | 面板上真的多了一颗按钮（票面要求"说清模式"，而手动模式必须有一条出路） |
| `tests/history-truth.spec.ts` | DOM 顺序多一个 `auto` | 同上（那条断言本来就是枚举按钮顺序） |
| `tests/spaces.spec.ts` | `zooms` 那一项多一个 `mode` | 请求协议多了"谁管这个缩放"，缺省 `manual`（旧插件的行为一字不变） |
| `tests/panel-toolbar.spec.ts` | 多一段「自动」调用 | 新端点 `desktop-view-auto` 需要一条真的走 RPC 的证据 |

**没有一条既有断言被放松或删掉。**
