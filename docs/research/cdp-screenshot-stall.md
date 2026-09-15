# 实测：外壳原生视图的截图（Playwright 截图 API，Electron 44 + CDP）

**问题**：T5 要给 Agent 一个 `browser_screenshot`（真图、作为附件交付）。Playwright 的截图 API 打在外壳那块 `WebContentsView` 上，能不能**稳定**拿到一张真 PNG？尺寸跟视图视口对不对得上？

**结论**：能拿到，但有两条**必须处理**的实测事实：单发一次 `Page.captureScreenshot` 常常**永远不返回**；`scale: 'css'` 在页面有滚动条时给出的尺寸**不是**视口。

- 探针：`.scratch/probe-screenshot.mjs`（一次性，用完即删；结论与原始输出抄在下面）
- 日期：2026-09-15（T5 实施期间）
- 环境：Electron **44.3.0** / Playwright **1.62.1**（`connectOverCDP`）/ 视图 bounds `760,0,440,800`，`devicePixelRatio = 1.5`（系统 150% 缩放）

---

## 1. 单发截图会**挂住**，第二次请求才让它完成

同一次会话里连续发同一发截图（`page.screenshot({type:'png'})`，每次 5–7 s 上限），原始记录：

```
-- A: six raw CDP surface:true captures, 5s bound each
pattern A: FAIL,OK,FAIL,OK,FAIL,OK
-- B: two captures concurrently (does the second unblock the first?)
concurrent: ["#1 119995B 561ms","#2 119995B 592ms"]
```

- 严格交替：**奇数次**超时、**偶数次**成功（成功的一次都很快：66–1097 ms）。
- **并发发两个，两个都在 ~0.6 s 内返回**（`#1 561ms` / `#2 592ms`）。
- 换 Playwright 的哪种写法都一样交替：`page.screenshot()`、`locator('body').screenshot()`、`fullPage`、`clip`、以及裸 CDP `Page.captureScreenshot`（`captureBeyondViewport: true/false` 都试过）—— 见下节原始行。
- **第一次**请求如果在没有后续请求的情况下等，可以等到 30 s 以上（首个探针里裸 CDP 那条一直没返回，直到进程被杀）。

```
-- C: fullPage            FAIL fullPage #1: 5009ms | OK fullPage #2: 120367B 100ms
-- D: clip to the viewport FAIL clip #1: 5015ms | OK clip #2: 122041B 1083ms
-- E: element screenshot   FAIL body #1: 5015ms | OK body #2: 118758B 131ms
-- F: captureBeyond=true   FAIL beyond #1: 6007ms | OK beyond #2: 119481B 1083ms
```

**采用的应对**（`src/session.ts` 的 `screenshot`）：单次尝试给一个有界预算（`SCREENSHOT_ATTEMPT_MS = 3000`），超时就**再来一次**，最多 4 次；只有"超时"这类失败才重试（视图没了、路径写不了，重试只会更慢）。实测：第一次 3 s 超时 + 第二次约 0.1 s → 整张截图 ~4.2 s 返回。

**没有查清的**：这到底是 Electron 的合成器只在"有第二个请求"时才交付帧，还是 CDP 会话上的响应投递被推迟了一个请求。裸 CDP 与 Playwright 表现一致，所以不是 Playwright 包装层的问题；`fromSurface: false` 两种写法**都**超时，没能用"不走 surface"绕开。

## 2. `scale: 'css'` 的尺寸在有滚动条时**不是视口**

`page.screenshot({type:'png', scale:'css'})` 对同一块 440×800 的视图、两个不同页面：

```
== /observe viewport={"innerWidth":440,"innerHeight":800,"dpr":1.5,"scrollWidth":425,"clientWidth":425,"innerWidthV":424.67}
/observe device (attempt 2): {"width":660,"height":1200,...}
/observe css    (attempt 2): {"width":439,"height":799,...}      <-- 既不是 440x800，也不是 425
== /other   viewport={"innerWidth":440,"innerHeight":800,"dpr":1.5,"scrollWidth":440,"clientWidth":440}
/other   device (attempt 2): {"width":660,"height":1200,...}
/other   css    (attempt 2): {"width":440,"height":800,...}
```

- **有滚动条的页面**：css 缩放给出 **439×799**；**没滚动条**：恰好 440×800。
- Playwright 的 css 路径（`playwright-core/lib/coreBundle.js:37194-37200`）从 `Page.getLayoutMetrics()` 的 `visualViewport/contentSize` 反推尺寸再 `clip.scale /= deviceScaleFactor`，滚动条会改变这些量，于是"一个 CSS 像素一个像素"这个承诺**并不总成立**。

**采用的应对**：用**默认的 device 缩放**（不传 `scale`）。它恒等于 `innerWidth × innerHeight × devicePixelRatio`（440×800 × 1.5 = **660×1200**，两个页面都对），像素是显示器自己的、**没有重采样**（换成 css 缩放时是缩小重采样）。测试里用页面自报的 `devicePixelRatio` 双向校验：`width === round(innerWidth*dpr)` 且 `width / dpr === innerWidth`。

## 3. 没验证到的

- 只在**本机**（150% 缩放、Electron 44.3.0、Playwright 1.62.1）量过；换版本、换缩放比、或视图被面板**隐藏**（`--no-show` / panel 报 `visible:false`）时的行为**没测**。
- 没测"窗口被其他窗口遮住"或最小化时是否更容易挂住（本机测试时前台还跑着生产外壳，无法排除影响）。
- 没验证 `page.screenshot({animations:'disabled'})`、`mask`、`omitBackground`、JPEG 这些选项。
- 没测 `fullPage` 的尺寸语义（只测了"能返回"）。

## 4. 对后续票的含义

- **T9/T11**：任何"截一张图给用户看"的路径都要带上重试，否则用户会看到一次 30 s 的假卡死。
- 不要用 `scale: 'css'` 去和快照的 `bounds`（视口 CSS 像素，ADR-0007）对齐图像坐标 —— 需要对齐时用 `devicePixelRatio` 换算。
- 截图**必须**走附件服务才叫"交付给模型"：文件路径只是给人看的（见 `src/tools.ts` 的 `renderScreenshot`）。
