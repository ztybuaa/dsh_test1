'use strict'

/**
 * 自动适配栏宽（票 #19）：**什么时候**动缩放，动到多少，以及"缩了也没用"时怎么办。
 *
 * 用户的诉求是"栏宽一变，页面自动缩放到刚好塞得下，不用我按 −"。判断只有这一套，而它是本票
 * 唯一真正的策略，所以它单独一个文件，而且**纯逻辑**：不 require electron、不碰文件系统、
 * 不认识 WebContents —— 于是"固定宽度页面几步收敛""响应式页面一步都不动""不震荡"
 * "缩放治不了的溢出不许一路缩下去"这几件事都能不起外壳、不起浏览器被逐条读回
 * （`tests/fit-rule.spec.ts`）。
 *
 * ## 规则
 *
 * ```
 * C     = 这一页有多宽（CSS 像素）        // 见下面"内容宽度从哪来"
 * 溢出   = C - clientWidth                 // > 0 塞不下，< 0 有富余，== 0 正好
 * 溢出 == 0            → 不动
 * 否则                 → zoom ← clamp(zoom × clientWidth / C, 25%, 100%)
 * ```
 *
 * ## 内容宽度从哪来（这一条是量出来的，不是设计出来的）
 *
 * `document.documentElement.scrollWidth` **不会小于视口宽度** —— 它就是可滚动区域，视口本身
 * 是它的下限。所以"这一页有多宽"只有两种来源，**不能混着取较大者**：
 *
 *  - **真的溢出了**（`scrollWidth > clientWidth`）⇒ `scrollWidth` 就是内容宽度（比视口宽，
 *    没有被夹住）；
 *  - **没溢出** ⇒ `scrollWidth == clientWidth`，那**不是**内容宽度，是被夹住的结果。
 *    这时只能靠外壳**记下来的**那个"这个文档曾经溢出过时的宽度"（`contentWidth`）。
 *
 * 把两者取较大者会踩到一个实测的坑：一个**响应式**页面在宽栏里从没溢出过，于是它会被记成
 * "1226px 宽的固定布局"，栏一窄就被当成固定宽度页一路缩小 —— 真外壳上量到 `dpr` 从 1.5
 * 掉到 0.375（`tests/fit-to-pane.spec.ts` 的前身就是这么红的）。
 *
 * 而"记下来"这件事本身是**必需**的，不是缓存优化：`scrollWidth` 被夹住之后，没人再报得出
 * 这一页的内容宽度，而"栏拖宽了该回到 100%"正需要那个数（否则页面会永远停在为窄栏算出来的
 * 缩放上）。记忆属于**当前这份文档**，所以换页时清空。
 *
 * ## 为什么它对响应式页面是恒等的
 *
 * 响应式页面的宽度是视口的函数，所以它**从来不溢出** ⇒ 外壳从没记下过内容宽度 ⇒
 * `C == 0` ⇒ 规则答"没有可适配的东西"，一步都不动。这条不依赖"我们只在溢出时动手"，
 * 它靠的是"内容宽度是视口的函数"这个事实。
 *
 * ## 为什么两个方向都动（票面给的规则只写了溢出那一半）
 *
 * 只做"溢出时缩小"会在**栏拖宽**时撒谎：一个 1200px 的页面在 620 的栏里被适配到 0.52，
 * 栏拖回 1240 之后**一步都不动** —— 它塞得下，但只占半栏，而票面第 2 条验收要的是**回到
 * 100%**。乘 `clientWidth/C` 这一条本身**就是对称的**：内容恰好填满时是不动点，宽了就把
 * zoom 抬回去（封顶 100%）。
 *
 * ## 为什么它会收敛（票面要求量出来，别只推理）
 *
 * 缩放改的是**布局视口**：`clientWidth = 源视口 / zoom`（ADR-0013 实测过）。于是
 * `zoom × clientWidth / C` 恰好解出"内容宽度 == 布局视口宽度"那个不动点。实测两步到三步：
 * 第一次乘到 `620/1200`，第二次读到的 `clientWidth` 已经是内容宽度，停
 * （`tests/fit-to-pane.spec.ts` 里那两行 `DSH_SHELL FIT` 就是它）。
 *
 * ## "缩了也没用"的溢出：一次都不许白缩（这一条也是量出来的）
 *
 * 有一类溢出**缩放治不了**：`width: 100vw` 配上一条纵向滚动条（`100vw` 含滚动条宽度，
 * 而内容盒不含），或者 `calc(100% + 40px)` 这种"永远比视口宽一点"的写法。这类页面的宽度是
 * **视口的函数**：缩得越小视口越大，内容跟着一起变大，那个差在 CSS 像素里是**常数**。
 * 照上面那条规则一路乘下去，页面会被越缩越小（每一轮都"还差一点"，而那个差永远消不掉）——
 * 这正是票面点名"极其重要"的那条禁止事项（"不许把本来正常的响应式页面也缩放掉"）的另一种写法。
 *
 * 判据不能用"缩一次看看有没有变好"：拖动时**栏宽一直在变**，溢出没变小可能只是我们还没追上
 * 新的栏宽。实测就是这么误判的：一次 20 步的拖动里，页面被判定"治不了"，停在了 93%，
 * 而栏早就到 620 了（`tests/fit-to-pane.spec.ts` 的那次红）。
 *
 * 所以判据是**两份溢出样本的比较**，与"谁在动"无关：
 *
 * ```
 * 样本 = {viewport: clientWidth, contentWidth: scrollWidth}   // 只在**真的溢出**时才有
 * Δ视口 = v₂ - v₁,  Δ内容 = C₂ - C₁
 * |Δ视口| 太小（< 8px）        → 还看不出来，等等
 * |Δ内容 - Δ视口| 在噪声以内    → 内容**跟着视口走** ⇒ 缩放治不了 ⇒ 拒绝并放回 100%
 * 否则                        → 内容是**常数**（固定宽度排版）⇒ 正常适配
 * ```
 *
 * 固定宽度页面：Δ内容 = 0，Δ视口 = 606（实测）⇒ 判为常数 ✓；`calc(100% + 40px)`：
 * Δ内容 = Δ视口 = 40（实测）⇒ 判为跟着走 ✓。两种页面的差别是**数量级**，不是手感。
 */

/**
 * 缩放的上下界。上界 100%：自动适配只会**缩小**，不会替用户放大。
 *
 * 下界与 `src/navigation.ts` 的 `ZOOM_MIN` 是同一个数（25%，Chromium 自己的下限）：适配
 * 不该走到用户用按钮都走不到的档位上去。
 */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 1

/**
 * 一次"栏宽变化"最多改几次缩放。
 *
 * 它是**有界**这件事本身：一段连续拖动里每一次几何变化都可能触发一轮适配，而一轮适配
 * 最多改 {@link MAX_STEPS} 次 —— 撞上限就停手（并如实记下），绝不无限追下去。
 */
const MAX_STEPS = 4

/**
 * 前后两次算出来的目标值差小于这个数，就当成"改了也没有意义"，停手。
 *
 * 它接住两种情形：**够不到**（一个 5000px 的页面在 620 的栏里，算出来的目标小于
 * {@link MIN_ZOOM}，夹住之后下一次算出来还是同一个值），以及**已经满了**
 * （栏比内容宽，目标是 100%，而当前就是 100%）。
 */
const NO_PROGRESS = 1e-4

/**
 * 两份溢出样本差多少就算"看不出来"（上限）。
 *
 * 两个宽度都是页面报的**整数**，所以 1–2px 的差在取整噪声范围内。
 */
const TRACK_ABSOLUTE_NOISE = 2

/**
 * 视口至少要差这么多，才拿两份样本下结论。
 *
 * **8 是量出来的，不是拍的**：页面报的宽度是整数，而同一页在不同缩放下 `scrollWidth` 会
 * 在 1199 / 1200 之间抖（真外壳上两种都见过，因为内容宽度是 1199.98 那种数）。
 * 门槛设成 1 的话，两份"视口差 1px、内容差 1px"的样本会被判成"内容跟着视口走" ——
 * 一个**固定宽度**的页面因此被误判成"治不了"、缩放被放回 100% 并且此文档不再适配
 * （整套跑的时候踩过一次：页面停在 100%，而栏早就到 620 了）。
 *
 * 代价是"永远宽 1px 的页面"要多挪几步才被认出来：每一步只把视口挪一像素，约八步之后
 * `Δ视口` 够大、判据生效。那八步里它一共缩了约 1.3%，而判定之后缩放会被**放回 100%** ——
 * 所以最终状态仍然是对的（`tests/fit-rule.spec.ts` 里那条用例量的是"拖三十轮之后还是 100%"）。
 */
const MIN_VIEWPORT_DELTA = 8

/** 把数收成一个有限的数，收不进来就是 undefined（页面换了文档、读回一半都会这样）。 */
function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 从页面报的两个宽度（与"记下来的内容宽度"）算出"这一页到底塞不塞得下"。
 *
 * 单独一个函数是因为**两处**要用同一条解释：决定该改成多少的时候（{@link nextFitZoom}），
 * 以及判断"两份溢出样本差多少"的时候（{@link overflowSample} 与
 * {@link contentTracksViewport}）。两处各写一遍的话，"内容宽度从哪来"这条规则迟早有一处先漂。
 *
 * @param {{clientWidth: unknown, scrollWidth: unknown, contentWidth?: unknown}} input
 *   `clientWidth`/`scrollWidth` 是页面自己报的；`contentWidth` 是外壳记下来的"这个文档曾经
 *   在溢出时有多宽"（从没溢出过就是 0/缺席）。
 * @returns {{clientWidth: number, scrollWidth: number, contentWidth: number, overflowing: boolean, overflow: number} | undefined}
 *   读不出可用的宽度就是 undefined；`overflow > 0` = 塞不下，`< 0` = 有富余，`== 0` = 正好
 *   （`contentWidth == 0` 表示"这一页从没溢出过"，那时的 `overflow` 是 0）。
 */
function effectiveContentWidth(input) {
  const clientWidth = finite(input.clientWidth)
  const scrollWidth = finite(input.scrollWidth)
  const remembered = finite(input.contentWidth) ?? 0
  if (clientWidth === undefined || scrollWidth === undefined || clientWidth <= 0 || scrollWidth <= 0) return undefined
  const overflowing = scrollWidth > clientWidth
  const contentWidth = overflowing ? scrollWidth : Math.max(remembered, 0)
  return { clientWidth, scrollWidth, contentWidth, overflowing, overflow: contentWidth - clientWidth }
}

/**
 * 给定这几个数，缩放该是多少。
 *
 * @param {{zoom: unknown, clientWidth: unknown, scrollWidth: unknown, contentWidth?: unknown}} input
 *   `zoom` 是**当前**缩放（外壳从 `getZoomFactor()` 读的），其余见 {@link effectiveContentWidth}。
 * @returns {{zoom: number | null, clientWidth: number, contentWidth: number, overflowing: boolean, overflow: number, ratio?: number, reason: string, capped?: 'min' | 'max'}}
 *   `zoom` 为 `null` = 一步都不动，`reason` 说清为什么；否则是要换上去的值。
 *   `contentWidth`/`overflowing` 是这一次读到的实情（调用方拿它去更新那份记忆）。
 */
function nextFitZoom(input) {
  const zoom = finite(input.zoom)
  if (zoom === undefined || zoom <= 0) {
    return { zoom: null, clientWidth: 0, contentWidth: 0, overflowing: false, overflow: 0, reason: 'the view reported no usable zoom factor' }
  }
  const seen = effectiveContentWidth(input)
  if (seen === undefined) {
    return {
      zoom: null,
      clientWidth: 0,
      contentWidth: 0,
      overflowing: false,
      overflow: 0,
      reason: 'the page reported no usable width (it may be mid-navigation)',
    }
  }
  const base = { clientWidth: seen.clientWidth, contentWidth: seen.contentWidth, overflowing: seen.overflowing, overflow: seen.overflow }
  if (seen.contentWidth <= 0) {
    return { ...base, zoom: null, reason: 'this page has never overflowed its pane, so there is nothing to fit' }
  }
  if (seen.overflow === 0) {
    return { ...base, zoom: null, ratio: 1, reason: 'the page fills this pane already' }
  }
  const ratio = seen.clientWidth / seen.contentWidth
  let wanted = zoom * ratio
  let capped
  if (wanted > MAX_ZOOM) {
    wanted = MAX_ZOOM
    capped = 'max'
  } else if (wanted < MIN_ZOOM) {
    wanted = MIN_ZOOM
    capped = 'min'
  }
  if (Math.abs(wanted - zoom) <= NO_PROGRESS) {
    return {
      ...base,
      zoom: null,
      ratio,
      reason:
        capped === 'min'
          ? `this page cannot fit even at ${Math.round(MIN_ZOOM * 100)}% (it is ${String(seen.contentWidth)}px wide in a ` +
            `${String(seen.clientWidth)}px viewport), so there is nothing left to try`
          : capped === 'max'
            ? 'the page already fills this pane, and automatic fitting never zooms past 100%'
            : 'the next step would not change anything',
      ...(capped !== undefined ? { capped } : {}),
    }
  }
  return {
    ...base,
    zoom: wanted,
    ratio,
    reason: `zoom × ${ratio.toFixed(4)} (= ${seen.clientWidth}/${seen.contentWidth})`,
    ...(capped !== undefined ? { capped } : {}),
  }
}

/**
 * 给一次读回做一份"溢出样本"，供 {@link contentTracksViewport} 两份一比。
 *
 * @param {{clientWidth: unknown, scrollWidth: unknown}} input - 页面自己报的两个宽度。
 * @returns {{viewport: number, contentWidth: number} | undefined} **只有真的溢出时**才给样本
 *   （没溢出时 `scrollWidth` 是被视口夹住的结果，拿来比会得出相反的结论）。
 */
function overflowSample(input) {
  const seen = effectiveContentWidth(input)
  if (seen === undefined || seen.overflowing !== true) return undefined
  return { viewport: seen.clientWidth, contentWidth: seen.scrollWidth }
}

/**
 * 这两份样本说的是不是"内容的宽度**跟着视口走**"。
 *
 * 跟着走 ⇒ 缩放治不了这个溢出（缩得越小，视口越大，内容跟着一起变大）⇒ 该拒绝并放回 100%。
 * 不跟着走 ⇒ 内容是常数（固定宽度排版）⇒ 正常适配。
 *
 * 两个门一起把关，缺一不可：
 *
 *  - **视口差得够多**（{@link MIN_VIEWPORT_DELTA}）—— 差一两个像素时两种页面看起来一样；
 *  - **内容差与视口差对得上**，容差随 `Δ视口` 收缩（`min(2, |Δ视口|/2)`），
 *    于是"差得多"的时候一点点抖动不算数，而"差得少"的时候本来也不比较。
 *
 * 判错的代价是不对称的：把**固定宽度**页面误判成"跟着走"，页面会停在 100% 且这份文档不再适配
 * （一个功能没了）；把"跟着走"的页面当成固定宽度，它会被一路缩小（一个功能错了）。
 * 所以门槛宁可高一点。
 *
 * @param {{viewport: number, contentWidth: number} | undefined} previous - 上一份样本。
 * @param {{viewport: number, contentWidth: number} | undefined} current - 这一份。
 * @returns {boolean} 判定"跟着视口走"为真。
 */
function contentTracksViewport(previous, current) {
  if (previous === undefined || current === undefined) return false
  const deltaViewport = current.viewport - previous.viewport
  const deltaContent = current.contentWidth - previous.contentWidth
  if (Math.abs(deltaViewport) < MIN_VIEWPORT_DELTA) return false
  const tolerance = Math.min(TRACK_ABSOLUTE_NOISE, Math.abs(deltaViewport) / 2)
  return Math.abs(deltaContent - deltaViewport) <= tolerance
}

/**
 * 这一轮适配该停手了吗（`changed` 是这一轮已经改过的次数）。
 *
 * 存在的理由：收敛判据写在 {@link nextFitZoom} 的返回值里，而"一轮跑完了没有"是调用方
 * （外壳那个循环）的事。把它放这里，纯逻辑的那一半就完整了。
 *
 * @param {{zoom: number | null}} decision - {@link nextFitZoom} 的答案。
 * @param {number} changed - 这一轮已经改了几次。
 * @returns {boolean} 该停手了为真。
 */
function shouldStop(decision, changed) {
  if (decision.zoom === null) return true
  return changed >= MAX_STEPS
}

module.exports = {
  MAX_STEPS,
  MAX_ZOOM,
  MIN_VIEWPORT_DELTA,
  MIN_ZOOM,
  NO_PROGRESS,
  TRACK_ABSOLUTE_NOISE,
  contentTracksViewport,
  effectiveContentWidth,
  nextFitZoom,
  overflowSample,
  shouldStop,
}
