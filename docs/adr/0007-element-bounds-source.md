# 0007 — 元素位置尺寸（bounds）由页面内一次求值给出

**状态**：已接受
**日期**：2026-09-15
**关联**：ADR-0005（继承的四项决定）、票 T3（快照 + 元素引用带位置尺寸，issue #4）

## 背景

T3 要给快照里的每个 `ref` 补上位置与尺寸。这一步是"元素在不在视口内"的判断、以及后续光标覆盖层（T8）与点击命中（T4）的前提，所以它报的必须是**能直接拿去用**的那个矩形，而不是一个看起来合理的近似。

页面上能拿到元素矩形的路子不止一条，而且它们报的数不一定一样。必须先定死用哪一条，否则后面每一票都会对"这个 x/y 是什么坐标系"各说各话。

## 决定

**用页面内的一次 `getBoundingClientRect()`，与角色/名字/状态一起在同一个 `evaluateAll` 往返里取。**

具体到形状：

1. **一次求值给出整张快照**。`locator.evaluateAll(collectSnapshot)` 里同时读出 `document.title`、文档身份 token、以及每个匹配元素的 `role`/`name`/`state`/`bounds`。标题、元素、几何来自**同一次求值、同一个文档、同一次布局**，因此不可能出现"标题是旧页面的、bounds 是新页面的"这类自相矛盾；每个元素也不需要单独一次往返。
2. **坐标系 = 视口 CSS 像素**。`x/y/width/height` 就是 `getBoundingClientRect()` 的 `left/top/width/height`：**不加**滚动偏移（不是文档坐标）、**不乘** `devicePixelRatio`、**不四舍五入**。
3. **不取整是有意的**。取整是使用方的决定，不是快照的决定：`view.setBounds()` 需要整数（见 `docs/research/page-coordinates-map-to-view-bounds.md`），页面内画覆盖层不需要；把小数丢掉则会让"报出来的矩形"和"页面自己的矩形"不再相等，验收里那条交叉验证就只能靠容差蒙过去。
4. **元素筛选用 Playwright 的 `:visible`**（有渲染框且非 `visibility:hidden`），与 ADR-0005 的隐藏元素规则一字不差；用引擎自己的谓词而不是另写一套，是因为后续点击能不能落在元素上由同一个谓词决定。

## 为什么不是 `DOMSnapshot.captureSnapshot`

CDP 的 `DOMSnapshot.captureSnapshot` 也能给出几何，而且一次拿到整棵树的布局数据。但它要按 `backendNodeId` 再和"动作要用的那个句柄"对齐：

- 快照列的是 `ref`，而 `ref` 最终要解析成 Playwright 的 locator（它是按选择器引擎的第 N 个匹配项解析的，还能穿透 iframe / shadow DOM）。`DOMSnapshot` 给的是 `backendNodeId`，要把它变成可点击的东西，得再引一层节点句柄映射，并保证两层对"哪个元素"的判断一致——这正是最容易悄悄错位的地方。
- `DOMSnapshot` 的节点顺序与选择器引擎的匹配顺序不是同一个东西（前者含未匹配节点、含被 `:visible` 排除的节点），两边对齐需要自己重放一遍筛选规则，等于把 `:visible` 的语义抄一份、还必须抄对。
- 页面内 `getBoundingClientRect()` 与"元素在页面上真实占的位置"是同一个来源：验收要求拿页面自己的 `getBoundingClientRect()` 独立读一次来交叉验证，两边同源才可能做到**严格相等**而不是近似相等。

代价是页面内取几何依赖"快照选择器匹配到的元素"就是"要报的元素"，而这个前提由构造保证：几何是在对同一批已匹配元素求值时读的。

## 后果

- **bounds 是视口坐标**，与 `document.elementFromPoint(x, y)`、`position: fixed` 覆盖层同一套数，可以直接传；需要文档坐标的调用方自己加 `scrollX/scrollY`（当前没有这样的调用方）。
- 元素是否在视口内由**使用方**用 bounds 与视口尺寸比较得出，快照本身不下这个判断，也不为此塞进视口尺寸。
- 元素数量上限（默认 200）之外的截断标记 `truncated` 与 bounds 无关：被截断的元素既不在 `elements` 里，也没有 `ref`。
- **ref 属于它被读出的那个文档**：快照同时记下文档身份（`performance.timeOrigin`），做动作前重新核对；页面导航后旧 ref 一律被拒（事件监听只是第一道防线，因为"导航已提交、load 事件还没到"这段窗口里 locator 已经会在新文档上解析了）。同文档导航（`pushState`、hash 变化）不算换文档，ref 仍然有效。
- 本决定**不**引入完整可访问性树、不引入 MJPEG/screencast、不引入第二套元素编号；快照的体积与 ADR-0005 的紧凑约束一致。
