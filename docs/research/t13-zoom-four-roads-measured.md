# T13 底稿二：缩放四条路各自量到了什么

> **本文有一处被推翻的结论，已更正，请看文末「更正」一节。**
> 原文把"布局视口变小"当成了"内容被缩小"，于是得出"路 C 能让 1200px 塞进 620px"。
> 后来的直接渲染测量证明：**插件够得到的任何手段都做不到这件事**。
> 下面第一至四节保留原始读数（它们本身是对的），结论那一行按更正后的说法读。

**问题**（派工书原话）：Playwright 没有缩放 API。可选路径至少三条，先量再选，并回答四个问题：

1. 哪条路真的能让一个**固定宽度（1200px）**的页面在**窄栏（620px）**里**完整显示出来**；
2. 它对 **`devicePixelRatio`** 与**截图尺寸**的影响；
3. 它**跨导航**是否保持；
4. 它是否影响页面自己读到的 `innerWidth` / `outerWidth`。

日期 2026-09-16。夹具：一个 `#bar { width: 1200px }` 的页面，视图矩形 `0,0,620,800`，
窗口 1240x860（屏幕 dpr 1.5，所以基线截图恒为 620×800 × 1.5 = **930×1200**）。
原始输出见会话工作区 `.scratch/t13-probe/zoom/`（不进仓库）。

---

## 结论表

| 路 | 布局视口变 | `innerWidth` 变 | `dpr` 变 | 截图尺寸变 | 跨导航保持 | 能让 1200px 进 620px 栏 |
|---|---|---|---|---|---|---|
| **A** `Emulation.setPageScaleFactor` | ✗ | ✗ | ✗ | ✗ | — | **✗ 完全无效** |
| **B** `Emulation.setDeviceMetricsOverride`（只给 `deviceScaleFactor`） | ✗ | ✗ | **✓** | ✗ | ✓ | ✗ |
| **C** `page.setViewportSize()`（Playwright 自己的口子） | **✓** | **✓** | **✓** | **✓** | **✓** | ✓（缩到 319px 那种） |
| **D** `mobile: true` 的设备指标覆盖 | ✓（视口变成整页宽） | ✓（1200） | ✓ | ✗ | ✓ | ✓（`visualViewport.scale=0.5167`） |
| **E** Electron `webContents.setZoomFactor()` | — | — | — | — | — | **插件够不到**（不是 CDP） |

---

## 路 A：`Emulation.setPageScaleFactor` —— 在这台宿主上**完全没有效果**

```
baseline:      {"innerWidth":620,"innerHeight":800,"dpr":1.5,"scrollWidth":1202,"barWidth":1200,"vvScale":1,"vvWidth":620}
setPageScaleFactor 2 → {"innerWidth":620,"innerHeight":800,"dpr":1.5,"scrollWidth":1227,"barWidth":1200,"vvScale":1,"vvWidth":620}
```

同一份 facts，一个字段都没动；`visualViewport.scale` 仍是 `1`。
（`scrollWidth` 在 1200/1227 之间跳是纵向滚动条出现/消失造成的，与缩放无关。）
**结论：不满足第 1 条，且对第 2/4 条零影响。排除。**

## 路 B：`Emulation.setDeviceMetricsOverride` 只给 `deviceScaleFactor`

```
dsf=1.5: dpr=1.5                innerWidth=620 scrollWidth=1200 shot=930x1200
dsf=2  : dpr=2.0000000596046448 innerWidth=620 scrollWidth=1200 shot=930x1200
dsf=2.5: dpr=2.4999999403953552 innerWidth=620 scrollWidth=1227 shot=930x1200
dsf=3  : dpr=3                  innerWidth=620 scrollWidth=1227 shot=930x1200
dsf=4  : dpr=4.0000001192092896 innerWidth=620 scrollWidth=1200 shot=930x1200
dsf=0.5: dpr=0.5000000149011612 innerWidth=620 scrollWidth=1227 shot=930x1200
```

**`deviceScaleFactor` 只改页面读到的 `devicePixelRatio`，不改布局视口，也不改截图。**
所以它单独用只能"骗页面"（`innerWidth × dpr` 的坐标换算会跟着错），不是缩放。
**不满足第 1 条。排除。**

## 路 C：`page.setViewportSize()` —— 唯一真的让布局动起来的那条

Playwright 在**领养来的**视图上 `page.viewportSize()` 本来是 `null`（上下文没有 viewport），
但显式调 `setViewportSize` 是有效的（它写的是 Playwright 自己的 `_emulatedSize`，
并且发 `Emulation.setDeviceMetricsOverride`，见 `playwright-core/lib/coreBundle.js:47091`）。

```
基线:                    viewportSize=null      innerWidth=620 dpr=1.5  shot=930x1200
setViewportSize 620x800: viewportSize={620,800} innerWidth=620 dpr=1.0  shot=620x800
setViewportSize 320x800: viewportSize={320,800} innerWidth=320 dpr=1.0  shot=320x800
setViewportSize 620x400: viewportSize={620,400} innerWidth=620 dpr=1.0  shot=620x400
```

**布局真的按比例变小了，页面自己读得到，截图跟着视口走。** 第 1、3、4 条都成立。

### 已经实现好的候选组合（本票采用）

`page.setViewportSize({ width: floor(sourceW/zoom), height: floor(sourceH/zoom) })`
再补一条

`Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: zoom, mobile: false })`

（补的那条把**页面读到的 `devicePixelRatio`** 拨到 zoom —— 用户看到的"缩放百分比"
和页面算出来的 dpr 才是一致的。）

量到的四问答案（源视口 620×800）：

```
zoom=1.25: innerWidth=496 innerHeight=640 dpr=1.2499999701976776 shot=496x640   (floor(620/1.25)=496)
zoom=1.94: innerWidth=319 innerHeight=412 dpr=1.9400001168251038 shot=319x412
zoom=2.5 : innerWidth=248 innerHeight=320 dpr=2.4999999403953552 shot=248x320
导航到第二页之后（覆盖仍生效）: innerWidth=248 innerHeight=320 dpr=2.4999999403953552 shot=248x320
重置之后:                      innerWidth=620 innerHeight=800 dpr=1.0000000298023224 shot=620x800
```

- **1（能不能塞进窄栏）**：源视口 620，1200px 宽的条子在任何 zoom ≥ 1.94 时都**整条可见**
  —— 视口里能看到的页面比例变成 `1/zoom`。这正是用户那句"能不能适应侧边栏的大小"。
- **2（dpr 与截图）**：`dpr` **跟着 zoom 变**（这就是"缩放后 devicePixelRatio 跟着变"）；
  截图尺寸 = `floor(源视口/zoom)`，也就是**变小**。
- **3（跨导航）**：覆盖与视口都在，导航到另一页后仍然生效（上表倒数第二行）。
- **4（页面自己的读数）**：`innerWidth` / `innerHeight` **就是**布局视口，会变；
  `outerWidth` 不变（还是窗口的 1241）。这直接影响 `browser_evaluate` / `browser_extract`：
  缩放后页面报的坐标是**缩小后的 CSS 像素**，与快照的 bounds 同一坐标系（量过：
  zoom=2 时 `#btn` 的 bounds 是 `{x:10,y:100,width:60,height:30}`，页面自己也是 310×400）。

### 路 C 唯一不够理想的地方：截图尺寸**反向**变

T5 钉住的契约是"截图 = 视口 × dpr = 930×1200（屏幕 dpr 1.5 那一层）"，
而 zoom>1 之后截图是 `floor(620/zoom) × floor(800/zoom)` —— **是变小，不是变大**。

试过把截图**放大回源尺寸**（先 `setViewportSize`，再发 `deviceScaleFactor = zoom` 的覆盖，
再 `setViewportSize` 一次），量到：

```
scaled zoom=2  : viewportSize={310,400} dpr=2.0000000596046448 shot=310x400
scaled zoom=2.5: viewportSize={248,320} dpr=2.4999999403953552 shot=248x320
```

**不行。** 原因是 Playwright 在 Electron 视图上截图时，`deviceScaleFactor` 取自它**自己**记的
`_metricsOverride`（`coreBundle.js:37196`），而它算出来就是 1（页面 `innerWidth` 与
surface 尺寸同比例），所以交付图片就是模拟视口那么大。**截图完全由"布局视口"决定。**

要同时满足"塞进窄栏"与"截图尺寸守恒"，只有让**外壳**去缩放那块 `WebContentsView`
（`webContents.setZoomFactor()`）—— 那需要动外壳，属另一条通道的决定。

## 路 D：`mobile: true`（记录备查，未采用）

```
mobile:true dsf1: innerWidth=1200 innerHeight=1549 outerWidth=620 dpr=1.0 scrollWidth=1200
                  barWidth=1200 vvScale=0.5166666507720947 vvWidth=1200 shot=930x1200
mobile:true dsf2: innerWidth=1361 innerHeight=1757 outerWidth=620 dpr=2.0 scrollWidth=1361
                  barWidth=1200 vvScale=0.4554358422756195 vvWidth=1361.33 shot=930x1200
```

它把布局视口放到"整页宽"（1200），再让 **visual viewport 缩放**去适配 —— 页面确实整条可见，
`innerWidth` 也稳定。但：它把 `window.screen` 也改成 620（`screenW:620`），
走的是移动端模拟那条语义（`fixedLayout`），和"浏览器缩放"不是一回事；
而且**截图仍然是 930×1200**（视觉缩放不改布局）。**未采用**，记录备查。

## 没量到的

- 屏幕 dpr 不是 1.5 的机器上，`floor(source/zoom)` 的取整误差会不会让某个 zoom 档
  出现 1px 的边框。本机固定 1.5，**没量到别的**。
- `page.setViewportSize` 在**官方 Electron 桌面宿主**上是否同样有效（本票宿主是 `dsh web`
  + 本项目外壳）。没量过。
- 缩放对**光标覆盖层**（T8）坐标的影响没有单独量：覆盖层画在页面里，用的是视图 CSS 像素，
  所以它与快照同系；但没有一条断言钉住"缩放后点击仍然命中"（见代码里的说明与诚实清单）。

---

# 更正：四条路**都不能**把固定宽度页面塞进窄栏（2026-09-16 追加）

## 上面哪里错了

前面几节量的是 `innerWidth` / `devicePixelRatio` / 截图尺寸，**没有量渲染**。
"视口变窄"与"内容被缩小"是两件事，而前者不蕴含后者 —— 上面那张结论表把两件事当成了一件。

## 正确的仪器：页面最右端的一块红标

夹具在页面自己的 **x=1150..1195**（条子内，y=40..160）放一块 `#ff0000` 的标，
然后**在截图里逐像素数红色**：

- 视口窄而内容不缩小 ⇒ 红标**看不见**（1150 > 视口宽）；
- 内容真的被缩小到装进视口 ⇒ 红标**看得见**。

**仪器自检**：620px 栏、不缩放时 `redPixels=0`（1150 > 620，应当看不见）—— 量到了 0，仪器有效。

## 六种候选，红标**一次都没出现**

```
基线（620 栏，不缩放）  png=620x800   redPixels=0   ✓ 仪器有效
A setViewportSize(620/1.94) + dsf=1.94, mobile:false
     png=319x412  facts={innerWidth:319, clientWidth:319, scrollWidth:1200, barWidth:1200,
                         markerLeft:1150, vvScale:1, dpr:1}          redPixels=0
B 裸 CDP mobile:true  width=1200 dsf=1.94
     png=620x800  facts={innerWidth:1200, clientWidth:1200, scrollWidth:1200, vvScale:1}  redPixels=0
C 裸 CDP 只改 dsf=1.94（视口不动）
     png=620x800  facts={innerWidth:620, dpr:1.94, scrollWidth:1200}   redPixels=0
D 裸 CDP mobile:true width=620 dsf=1.94                                redPixels=0
E 裸 CDP mobile:true width=930（=620×1.5）dsf=1.5                       redPixels=0
F 裸 CDP mobile:true width=930 dsf=3                                   redPixels=0
```

**另一条独立读回**（不靠像素）：`visualViewport.scale` 在六种候选里**全都是 1**。视觉缩放没有发生。

## 为什么 D/E/F 那条 `mobile: true` 这轮不生效

早先一轮（见正文路 D）量到过 `mobile:true dsf=1 → vvScale=0.5167`。这一轮复现不出来，原因是
**`page.setViewportSize()` 会向同一个 CDP session 发 Playwright 自己的
`Emulation.setDeviceMetricsOverride`**（`playwright-core/lib/coreBundle.js:47091`），
把 `mobile` 标志洗掉。一旦走过 `setViewportSize`，设备模拟的拥有者就变成 Playwright，
我们再发的 mobile 覆盖会被盖掉。

而即使它生效，那也是**移动端模拟语义**（会改 `window.screen`、走 `fixedLayout`），
不是桌面浏览器的缩放，本来就不该拿来做这件事。

## 结论（更正）

**在这台宿主上，插件够得到的任何手段都不能把固定宽度 1200px 的页面缩小到装进 620px 的栏里。**
唯一的机制是外壳侧的 `webContents.setZoomFactor()`（插件够不到），或者一条新的
"插件 → 外壳"控制通道。决定与理由见 `docs/adr/0013-*.md` 决定二。

采用的 `page.setViewportSize` 那条的准确语义是：**布局视口按比例变小 ⇒ 同屏看到更多页面内容**，
而**内容本身没有被缩小**，所以固定宽度排版仍然被裁切。
`tests/view-actions.spec.ts` 里有一条**反证断言**钉住这件事。

