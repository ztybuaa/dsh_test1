// GENERATED FILE — do not edit.
//
// Built by `node scripts/build-client.mjs` from:
//   shell/panel-rect.js  (panel measurement, shared with the shell's fixture panel)
//   src/toolbar.js       (the panel toolbar's decisions: buttons, availability, status line)
//   src/client-body.js   (tab type, tab body, panel and toolbar components)
//
// Editing this file directly will be caught by tests/client-half.spec.ts; edit the
// sources above and regenerate instead.

window.__ModuleLoader__.load({
	id: 'dsh-desktop-view',
	factory: (require) => {
		var exports = {}
		var module = { exports }

		//#region shell/panel-rect.js — spliced verbatim, fenced in a module scope of its own
		//
		// The fence is load-bearing. This file is a UMD module, and its wrapper ends with
		// `module.exports = api`: spliced bare into this factory, that reassignment *is*
		// what the host's loader receives — an object with no `apply` — and the host
		// answers "invalid plugin, expect function or object with an apply method,
		// received object", i.e. a plugin that silently never registers its tab.
		// Giving the splice a throwaway `module` keeps that assignment harmless while the
		// file still installs `globalThis.DshPanelRect`, which is all the panel needs.
		;(function (module) {
		/*
		 * Panel measurement — the single source of truth for "which rectangle does the
		 * panel occupy, and is it visible at all".
		 *
		 * The panel does not render a web page; its entire job is to answer that
		 * question (CONTEXT.md "panel"). The answer travels to the shell, which owns the
		 * native view, and the shell places that view on the reported rectangle.
		 *
		 * This file is plain, dependency-free, and environment-free on purpose. It is
		 * consumed twice:
		 *   - the shell serves it into the fixture page (`/panel-rect.js`);
		 *   - `scripts/build-client.mjs` splices it verbatim into the shipped
		 *     `client.js`, so the plugin's client half runs *this* code, not a copy.
		 *
		 * Keeping one implementation is what makes the automated evidence about the
		 * fixture panel also evidence about the real panel.
		 */
		;(function (root, factory) {
		  var api = factory()
		  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
		  root.DshPanelRect = api
		})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
		  'use strict'

		  /*
		   * The host global object, captured as a local of THIS function rather than read
		   * from the wrapper's `root` parameter.
		   *
		   * That is not a style choice. Measured on Electron 44 (Chromium 132): a function
		   * declared inside the factory does NOT resolve the wrapper's parameter. V8 does
		   * not put `root` in the closure context it allocates for the factory, so
		   * `typeof root` inside `observe()` throws `ReferenceError: root is not defined`
		   * even though the wrapper's own `root.DshPanelRect = api` on the line above ran
		   * fine. Naming the global inside the factory makes it part of the factory's own
		   * context, which is captured reliably. `tests/client-half.spec.ts` pins this
		   * shape, and the T2 placement test fails loudly if it regresses.
		   */
		  var hostGlobal = typeof globalThis !== 'undefined' ? globalThis : root

		  /**
		   * A rectangle in CSS pixels, relative to the page viewport. This is exactly the
		   * shape `getBoundingClientRect()` returns, so no conversion is needed between
		   * the panel and the shell: both sides are the same coordinate space, because
		   * the panel *is* a page in the shell's window (measured, see
		   * docs/research/page-coordinates-map-to-view-bounds.md).
		   *
		   * @typedef {{x: number, y: number, width: number, height: number}} PanelRect
		   */

		  /** A rectangle is reported only when it is at least this many pixels in each axis. */
		  var MIN_SIDE_PX = 1

		  /**
		   * Why the panel last reported "no rectangle". Reported for diagnostics only; the
		   * shell treats every absent rectangle the same way (hide the view).
		   *
		   * @typedef {'measured' | 'detached' | 'not-displayed' | 'zero-area' | 'not-visible' | 'unmeasurable'} PanelState
		   */

		  /**
		   * Turn a `getBoundingClientRect()` result into a reportable rectangle.
		   *
		   * `null` means "the panel occupies no rectangle", which the shell answers by
		   * hiding the native view. That is deliberately the same answer for "the sidebar is
		   * collapsed", "the tab was switched away", and "the element is gone": in all three
		   * cases showing the view would draw a browser somewhere the user is not looking.
		   *
		   * @param {DOMRect | null | undefined} raw - the measured rectangle, when there is one.
		   * @returns {{rect: PanelRect | null, state: PanelState}} the rectangle and why.
		   */
		  function normalize(raw) {
		    if (raw === undefined || raw === null) return { rect: null, state: 'detached' }
		    var x = Number(raw.x)
		    var y = Number(raw.y)
		    var width = Number(raw.width)
		    var height = Number(raw.height)
		    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
		      return { rect: null, state: 'unmeasurable' }
		    }
		    // Sub-pixel layout can leave a sliver of a collapsed panel; it is not a place a
		    // browser can be drawn.
		    if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) return { rect: null, state: 'zero-area' }
		    // The shell needs integers: `setBounds` takes device-independent pixels and does
		    // its own rounding, but a fractional origin would make the view's edge shimmer
		    // against the panel's edge by a pixel. Rounding here keeps the two identical.
		    return { rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, state: 'measured' }
		  }

		  /**
		   * Whether an element currently paints anything at all.
		   *
		   * Walks up the ancestors because a panel inside a `display: none` sidebar still has
		   * its own box measured: `getBoundingClientRect()` would happily return a
		   * non-empty rectangle for a subtree nobody can see.
		   *
		   * @param {Element} element - the panel element.
		   * @returns {boolean} true when the element and every ancestor are displayed.
		   */
		  function isDisplayed(element) {
		    var node = element
		    while (node !== null && node !== undefined) {
		      if (node.nodeType === 1) {
		        var display = hostGlobal.getComputedStyle ? hostGlobal.getComputedStyle(node).display : ''
		        if (display === 'none') return false
		      }
		      node = node.parentElement
		    }
		    return true
		  }

		  /**
		   * Measure one element and say what to report.
		   *
		   * @param {Element | null | undefined} element - the panel element.
		   * @returns {{rect: PanelRect | null, state: PanelState}} the report.
		   */
		  function measure(element) {
		    if (element === null || element === undefined) return { rect: null, state: 'detached' }
		    if (!isDisplayed(element)) return { rect: null, state: 'not-displayed' }
		    return normalize(element.getBoundingClientRect())
		  }

		  /**
		   * Whether two reports describe the same rectangle.
		   *
		   * @param {PanelRect | null} left - one rectangle.
		   * @param {PanelRect | null} right - the other.
		   * @returns {boolean} true when they are the same.
		   */
		  function sameRect(left, right) {
		    if (left === null || right === null) return left === right
		    return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
		  }

		  /**
		   * Watch one element and report every change of its rectangle.
		   *
		   * Reports immediately on attach so the shell never waits for a first interaction
		   * to learn where the view belongs, then on every `ResizeObserver` callback, on
		   * window resize, and on layout changes the observer cannot see (toggling a
		   * `display: none` ancestor does not resize the element, so it is re-measured once
		   * per animation frame).
		   *
		   * Duplicate reports are suppressed: the shell must be able to treat every message
		   * as a real change without doing its own diffing.
		   *
		   * ## 谁负责什么（票 #19 之前这里有一句话是假的）
		   *
		   * 三条线各管一段，一条都不能少：
		   *
		   *   1. **`ResizeObserver`** —— 元素**自己的盒子**变了（拖分栏条就是这一种）。它必须真的
		   *      挂上去：观察者是在**第一次渲染时**建的，而那一刻 React 的 DOM 引用还没挂上
		   *      （`elementRef.current === null`），所以"建观察者的时候就 `observe` 一次"这条线
		   *      **从来没有生效过**（票 #19 第二条评论里的那个缺陷）。现在观察者在每次测量前把
		   *      自己**重新指向**当前那个节点（{@link pointObserverAt}），于是元素换了、节点后挂上
		   *      都跟得上，注释与代码是同一句话。
		   *   2. **窗口 resize** —— 视口变了，元素可能跟着变（百分比宽度）。
		   *   3. **每帧一次测量**（`tick`）—— 前两条都看不见的那些变化：把一个 `display: none` 的
		   *      祖先打开**不会**改变元素的盒子尺寸，`ResizeObserver` 因此不响。它是**安全网**，
		   *      不是主要机制：主要机制是 1 与 2。反过来说，谁把 `tick` 拿掉，1 与 2 仍然兜得住。
		   *
		   * 三条线都只是**测量**：它们不产生任何新的副作用，重复的报告由下面的 `sameRect` 挡掉。
		   *
		   * @param {{element?: Element | null, onReport: (rect: PanelRect | null, state: PanelState) => void}} options
		   *   `element` is read on every measurement, so a caller may point it at a new node;
		   *   `onReport` is called synchronously once on attach and then on changes.
		   * @returns {{report: () => void, stop: () => void, last: () => {rect: PanelRect | null, state: PanelState}}} handle.
		   */
		  function observe(options) {
		    var onReport = options.onReport
		    if (typeof onReport !== 'function') throw new Error('observe() needs an onReport callback')
		    var last = { rect: null, state: 'detached' }
		    var haveLast = false
		    var stopped = false
		    var observer = null
		    /** 观察者现在盯着的那个节点。null = 还没有节点可盯（第一次渲染时就是这样）。 */
		    var observed = null
		    var frame = 0

		    /**
		     * 把观察者重新指向 `options.element` —— 它可能在两次测量之间换了节点。
		     *
		     * 这就是"元素只在建立观察者那一刻读一次"那个缺陷的修法：读数与观察**用同一个节点**，
		     * 而且每次测量前都对一次。节点还没挂上时什么都不做（下一次测量会再对一次）。
		     *
		     * @param {Element | null | undefined} element - 现在该盯的那个节点。
		     * @returns {void}
		     */
		    function pointObserverAt(element) {
		      if (observer === null) return
		      if (element === observed) return
		      if (observed !== null && observed !== undefined) observer.unobserve(observed)
		      observed = element
		      if (element !== null && element !== undefined) observer.observe(element)
		    }

		    /**
		     * Measure and report, unless nothing changed.
		     * @param {boolean} [force] - report even when unchanged.
		     * @returns {void}
		     */
		    function report(force) {
		      if (stopped) return
		      pointObserverAt(options.element)
		      var current = measure(options.element)
		      if (force !== true && haveLast && sameRect(last.rect, current.rect) && last.state === current.state) return
		      last = current
		      haveLast = true
		      onReport(current.rect, current.state)
		    }

		    /**
		     * A cheap safety net for layout changes `ResizeObserver` cannot report: the
		     * observer fires on the element's own box changing, not on an ancestor being
		     * hidden. One measurement per animation frame while the page animates is cheaper
		     * than any event subscription that would cover the same ground.
		     * @returns {void}
		     */
		    function tick() {
		      if (stopped) return
		      report(false)
		      frame = hostGlobal.requestAnimationFrame(tick)
		    }

		    if (typeof hostGlobal.ResizeObserver === 'function') {
		      observer = new hostGlobal.ResizeObserver(function () {
		        report(false)
		      })
		      pointObserverAt(options.element)
		    }
		    if (typeof hostGlobal.addEventListener === 'function') {
		      hostGlobal.addEventListener('resize', function () {
		        report(false)
		      })
		    }
		    if (typeof hostGlobal.requestAnimationFrame === 'function') frame = hostGlobal.requestAnimationFrame(tick)
		    report(true)
		    return {
		      report: function () {
		        report(true)
		      },
		      stop: function () {
		        stopped = true
		        if (observer !== null) observer.disconnect()
		        observed = null
		        if (frame !== 0 && typeof hostGlobal.cancelAnimationFrame === 'function') hostGlobal.cancelAnimationFrame(frame)
		        frame = 0
		      },
		      last: function () {
		        return last
		      },
		    }
		  }

		  /**
		   * Read the rectangle channel.
		   *
		   * An absent `api` option means "the page's own channel, if it has one". An explicit
		   * `null` means "this page has none" — the distinction is what lets the no-shell
		   * case be tested without deleting a real global.
		   *
		   * @param {{api?: object | null}} [options] - override for testing.
		   * @returns {object | null | undefined} the channel, if any.
		   */
		  function channel(options) {
		    var opts = options !== undefined && options !== null ? options : {}
		    if (Object.prototype.hasOwnProperty.call(opts, 'api')) return opts.api
		    return hostGlobal.__dshDesktopView
		  }

		  /**
		   * Report one rectangle to the shell, through the narrow global the shell's preload
		   * exposes. Never throws: a panel that breaks the page it lives in is worse than a
		   * panel that reports nothing.
		   *
		   * @param {PanelRect | null} rect - the rectangle, or null for "no rectangle".
		   * @param {{api?: object | null, warn?: (message: string, error?: unknown) => void}} [options]
		   *   `api` defaults to `globalThis.__dshDesktopView`.
		   * @returns {{delivered: boolean, reason?: string}} what happened.
		   */
		  function deliver(rect, options) {
		    var opts = options !== undefined && options !== null ? options : {}
		    var api = channel(options)
		    if (api === null || api === undefined || typeof api.setRect !== 'function') {
		      return { delivered: false, reason: 'no-shell' }
		    }
		    try {
		      api.setRect(rect)
		      return { delivered: true }
		    } catch (error) {
		      if (typeof opts.warn === 'function') opts.warn('could not report the panel rectangle to the shell', error)
		      return { delivered: false, reason: 'refused' }
		    }
		  }

		  /**
		   * Whether this page is running inside the desktop shell (that is, whether the
		   * rectangle channel exists).
		   *
		   * The panel is the only caller: without the channel there is no rectangle to report
		   * and no browser to put in the pane, so it says so instead. That copy lives with the
		   * panel (`src/client-body.js`, both languages) rather than here — this file answers
		   * "is the shell there", not "what does the pane say about it". It used to export a
		   * second, English-only sentence for the same case; nothing rendered it, its wording
		   * had already drifted from the panel's, and two answers to one question is how the
		   * wrong one gets edited.
		   *
		   * @param {{api?: object | null}} [options] - override for testing.
		   * @returns {boolean} true when the shell exposed the channel.
		   */
		  function hasShell(options) {
		    var api = channel(options)
		    return api !== null && api !== undefined && typeof api.setRect === 'function'
		  }

		  return {
		    MIN_SIDE_PX: MIN_SIDE_PX,
		    channel: channel,
		    deliver: deliver,
		    hasShell: hasShell,
		    isDisplayed: isDisplayed,
		    measure: measure,
		    normalize: normalize,
		    observe: observe,
		    sameRect: sameRect,
		  }
		})
		})({ exports: {} })
		//#endregion

		//#region src/toolbar.js — spliced verbatim, fenced the same way
		//
		// Also a UMD module, also ending in `module.exports = api`, also installing itself
		// on the page global (`DshViewToolbar`) — the same shape as the measurement above,
		// so a plain `require()` of the source in a test reads the very same code the
		// bundle runs, and the fence keeps this file's export from becoming the plugin's.
		;(function (module) {
		/*
		 * The panel's toolbar: what it says, and what it renders.
		 *
		 * It lives beside `client-body.js` and is spliced into the generated `client.js` the same
		 * way `shell/panel-rect.js` is (see `scripts/build-client.mjs`), for the same reason: the
		 * decisions — which buttons there are, when one is unavailable, and what the status line
		 * says — are the part worth pinning down, and they must be reachable without a browser
		 * (a plain `require()` of this file in a test) and without a host.
		 *
		 * It carries **no** copy table and **no** transport. The copy arrives as arguments, because
		 * the panel already has that table; the transport is `ctx.connection.rpc`, which only
		 * `client-body.js` holds. Keeping both out of here is what lets this file be pure logic.
		 */
		;(function (root, factory) {
		  var api = factory()
		  // Both assignments, unconditionally, exactly as `shell/panel-rect.js` does it:
		  // the generated bundle needs the global, and a plain `require()` in a test needs the
		  // export. The `typeof` guard is only about environments with no `module` at all
		  // (a browser page, a worker) — not about choosing between the two.
		  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
		  root.DshViewToolbar = api
		})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
		  'use strict'
		
		  /**
		   * The buttons, in the order a person reads them.
		   *
		   * `action` is the RPC action name — the same spelling the host's endpoint table uses
		   * (`desktop-view-back`, …), so a typo here is a 404 rather than a silently different
		   * button. `label` is the glyph a person sees.
		   *
		   * `shortcut` is the keyboard key, spelled the way `KeyboardEvent.key` reports it, or
		   * `null` for a button with none. Keyboard support is not decoration: without arrow-key
		   * history a person has to aim at a 24-pixel button, and "go back" is the one thing this
		   * toolbar exists for.
		   */
		  var BUTTONS = [
		    { action: 'back', label: '\u2190', title: 'back', shortcut: 'ArrowLeft' },
		    { action: 'forward', label: '\u2192', title: 'forward', shortcut: 'ArrowRight' },
		    { action: 'reload', label: '\u21bb', title: 'reload', shortcut: 'F5' },
		    { action: 'zoom-out', label: '\u2212', title: 'zoom out', shortcut: null },
		    { action: 'zoom-reset', label: '100%', title: 'reset the zoom to 100%', shortcut: null },
		    { action: 'zoom-in', label: '+', title: 'zoom in', shortcut: null },
		    // 票 #19：把这一格**交回自动适配**（按栏宽自己缩放）。
		    //
		    // 为什么必须有这颗按钮，而不是"换页/重新开始之后自动回来"：换页不丢缩放是 #13 定下的
		    // 语义（同源换页、换站点都实测过），而这条语义与"换页就把控制权交回自动"是矛盾的 ——
		    // 二者只能留一个，留下的那个是**已经在验收里钉住**的那个。于是回到自动必须是一个
		    // **说得出口的动作**，否则手动模式就是一个人进得去出不来的状态。
		    { action: 'auto', label: 'auto', title: 'fit the page to the pane (let the pane decide the zoom)', shortcut: null },
		    { action: 'restart', label: 'restart', title: 'go back to the page this pane started on', shortcut: null },
		  ]
		
		  /** The actions in {@link BUTTONS}, for a caller that needs to check one is real. */
		  var ACTIONS = BUTTONS.map(function (button) {
		    return button.action
		  })
		
		  /**
		   * Whether one button should be pressable right now.
		   *
		   * `back` and `forward` are the only two that can be **known** to be unavailable, and the
		   * knowledge is honest about its own limits: it is what this panel has *observed* the view
		   * do since it loaded (see `src/navigation.ts`), not what the browser's history really
		   * holds. So they go grey when nothing has been seen — and every other button stays live,
		   * because "we do not know" must never be rendered as "you cannot". A button that lies in
		   * that direction is worse than one that is occasionally too eager: the latter says why
		   * when it fails, the former refuses work that would have succeeded.
		   *
		   * @param {string} action - one of {@link ACTIONS}.
		   * @param {{canGoBack: boolean, canGoForward: boolean, busy: boolean, hasShell: boolean}} state
		   * @returns {boolean} whether the button is pressable.
		   */
		  function isEnabled(action, state) {
		    if (state.hasShell !== true) return false
		    // While one request is in flight every button is off: two overlapping history moves
		    // would race, and the panel would then be showing a state neither of them produced.
		    if (state.busy === true) return false
		    if (action === 'back') return state.canGoBack === true
		    if (action === 'forward') return state.canGoForward === true
		    return true
		  }
		
		  /**
		   * The zoom percentage a person reads.
		   *
		   * A missing or unreadable zoom renders as `—`, not as `100%`: the panel's whole point is
		   * that what it shows comes from a read-back, and "the read did not come back" is a
		   * different sentence from "the zoom is 100%".
		   *
		   * @param {unknown} zoom - the read-back zoom, or anything at all.
		   * @returns {string} the label.
		   */
		  function zoomLabel(zoom) {
		    if (typeof zoom !== 'number' || !isFinite(zoom)) return '\u2014'
		    return Math.round(zoom * 100) + '%'
		  }
		
		  /**
		   * 面板上那个缩放读数，**带上是哪种模式**（票 #19）。
		   *
		   * 票面原话是"工具条的读数要说清当前是哪种模式（如 `自动 78%` / `手动 90%`），不许让人看不出来"。
		   * 所以这句话有两个来源，而且**两个都不能猜**：
		   *
		   *  - 数：外壳读回来的 `getZoomFactor()`（读不到就是 `—`，见 {@link zoomLabel}）；
		   *  - 词：调用方给的**文案表**（`{auto, manual}`）。这个词表**刻意不在这个文件里** ——
		   *    这个文件一行文案都不带（连按钮的 title 都是英文硬编码的既有事实，见文件头），
		   *    而"自动/手动"是要给用户看的、要跟着语言走的那两个词，所以它们与别的文案住在一起。
		   *
		   * 读不到模式时**退回一个光秃秃的百分比**，不编一个前缀：`78%` 说的是"这是 78%"，
		   * 而猜出来的 `自动 78%` 说的是"外壳在按栏宽适配它" —— 后者可能不成立，而面板上那句话
		   * 一旦不成立，用户就再也分不清"没适配"和"适配了但没动"了。
		   *
		   * @param {unknown} zoom - 外壳读回来的缩放值。
		   * @param {unknown} mode - `auto` / `manual` / 别的什么（读不到就是别的什么）。
		   * @param {{auto?: string, manual?: string}} [words] - 那两个词。
		   * @returns {string} 要显示的那一句。
		   */
		  function zoomReading(zoom, mode, words) {
		    var percent = zoomLabel(zoom)
		    if (percent === '\u2014') return percent
		    var table = words !== undefined && words !== null ? words : {}
		    if (mode === 'auto' && typeof table.auto === 'string') return table.auto + ' ' + percent
		    if (mode === 'manual' && typeof table.manual === 'string') return table.manual + ' ' + percent
		    return percent
		  }
		
		  /**
		   * The one line under the buttons.
		   *
		   * It always says something. `message` is the host's own sentence about the last action
		   * (including **why** it could not happen — "no page to go back to" is the answer a person
		   * needs, and it is the reason this line exists); `url` is where the view is now, read back
		   * rather than remembered. When neither is available yet the line says so instead of being
		   * blank, because a blank line under a row of buttons is indistinguishable from a toolbar
		   * that is not working.
		   *
		   * @param {{url: string, zoom: unknown, message: string, ok: boolean|null}} state
		   * @returns {string} the status text.
		   */
		  function statusText(state) {
		    var parts = []
		    if (state.ok === false) parts.push('\u2717 ' + (state.message === '' ? 'the action did not happen' : state.message))
		    else if (state.message !== undefined && state.message !== '') parts.push(state.message)
		    if (state.url !== undefined && state.url !== '') parts.push(state.url)
		    if (parts.length === 0) return 'reading the view\u2026'
		    return parts.join(' \u2014 ')
		  }
		
		  /**
		   * Whether a keystroke should be treated as a toolbar shortcut.
		   *
		   * Two refusals, both load-bearing:
		   *
		   *  - **a modifier is held** — `Ctrl`/`Cmd`+`ArrowLeft` is the operating system's, and
		   *    swallowing it would break a person's own habits;
		   *  - **the focus is in a text field** — the panel sits inside the DSH window, so the
		   *    caret may well be in the chat box, and stealing `ArrowLeft` from someone editing a
		   *    sentence would be a worse bug than having no shortcut at all.
		   *
		   * @param {{key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean}} event - the keystroke.
		   * @param {boolean} inTextField - whether the focused element takes text input.
		   * @returns {string|null} the action to run, or null.
		   */
		  function actionForKey(event, inTextField) {
		    if (inTextField === true) return null
		    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null
		    for (var index = 0; index < BUTTONS.length; index++) {
		      if (BUTTONS[index].shortcut !== null && BUTTONS[index].shortcut === event.key) return BUTTONS[index].action
		    }
		    return null
		  }
		
		  /** Height of the toolbar strip, in CSS pixels. The panel keeps the rest. */
		  var TOOLBAR_HEIGHT_PX = 34
		
		  return {
		    BUTTONS: BUTTONS,
		    ACTIONS: ACTIONS,
		    TOOLBAR_HEIGHT_PX: TOOLBAR_HEIGHT_PX,
		    isEnabled: isEnabled,
		    zoomLabel: zoomLabel,
		    zoomReading: zoomReading,
		    statusText: statusText,
		    actionForKey: actionForKey,
		  }
		})
		})({ exports: {} })
		//#endregion

		//#region src/client-body.js — spliced verbatim
	/*
	 * Registration body of the plugin's client half — spliced below the shared panel
	 * measurement into the generated `client.js`. It is not shipped as a file of its
	 * own and is not compiled by `tsc`; see `scripts/build-client.mjs`.
	 *
	 * `DshPanelRect` comes from the splice: `shell/panel-rect.js` runs first in the same
	 * factory and installs itself on the page global. Naming it here makes the
	 * dependency between the two regions explicit instead of accidental.
	 */
	var DshPanelRect = globalThis.DshPanelRect
	
	/**
	 * The toolbar's own decisions — which buttons there are, when one is unavailable, what the
	 * status line says. Spliced from `src/toolbar.js`, and readable in a plain test too.
	 */
	var DshViewToolbar = globalThis.DshViewToolbar
	
	/**
	 * @typedef {object} PanelRectApi
	 * @property {(rect: {x: number, y: number, width: number, height: number} | null) => void} setRect
	 */
	
	/**
	 * The tab type's identity in the tab system. A package name is the natural value:
	 * it is the key the body registers under in the `sidebar.right.pane.tab` seat.
	 */
	var TYPE_ID = 'dsh-desktop-view'
	
	/**
	 * Type discriminator. `openTab('desktop-view')` opens this type; a page type
	 * declares no `patterns`, so it claims no resource address.
	 */
	var TYPE_KIND = 'desktop-view'
	
	/** Copy namespace key: the tab title is read fresh on every use, so a language change needs no re-registration. */
	var NS = 'desktopView'
	
	/** Title of the tab chip in both shipped languages. */
	var DICTIONARIES = {
	  zh: {
	    'type.label': '浏览器',
	    'guide.title': '浏览器',
	    'guide.description': '把侧边栏这一格交给原生浏览器视图',
	  },
	  en: {
	    'type.label': 'Browser',
	    'guide.title': 'Browser',
	    'guide.description': 'Hand this sidebar pane to the native browser view',
	  },
	}
	
	/**
	 * Panel copy, also in both languages. Not part of the locale namespace: the panel must render before it can translate.
	 *
	 * `noShell` is the one message a person can only ever see *without* the shell — which is
	 * exactly why it has to be complete on its own. "This pane needs the desktop shell" names
	 * the problem; on its own it leaves the reader with nowhere to go, so the sentence
	 * continues with the way out (the command that starts the shell, which is the only
	 * thing that can put a browser in this pane). A notice that states a fact and no action
	 * is a slightly louder silent failure.
	 */
	var COPY = {
	  zh: {
	    noShell:
	      '这一格需要桌面外壳才能显示浏览器。外壳是本仓库自带的 Electron 应用：' +
	      '在仓库里运行 npm run shell 起它，这一格就会显示真正的浏览器视图；' +
	      '普通浏览器标签页里它没有东西可显示。',
	    ready: '桌面外壳已就位：这一格交给原生浏览器视图。',
	    missing: '这一格没有量到矩形（可能被折叠或切走了）。',
	    // 票 #19：缩放读数上那两个词。面板必须让人**看得出来**现在是谁在管这个缩放，
	    // 否则"自动适配没动"与"自动适配不在管"在界面上长得一模一样。
	    zoomAuto: '自动',
	    zoomManual: '手动',
	  },
	  en: {
	    noShell:
	      'This pane needs the desktop shell to show the browser. The shell is the Electron app that ships ' +
	      'in this repository: run npm run shell there and this pane shows the real browser view. A plain ' +
	      'browser tab has nothing to put here.',
	    ready: 'The desktop shell is here: the native browser view takes this pane.',
	    missing: 'This pane reports no rectangle (collapsed or switched away).',
	    zoomAuto: 'auto',
	    zoomManual: 'manual',
	  },
	}
	
	/** @returns {string} the two-letter language code to copy in. */
	function language() {
	  var raw = typeof navigator !== 'undefined' && navigator !== null ? navigator.language : ''
	  return typeof raw === 'string' && raw.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en'
	}
	
	/** @returns {object} the copy table for the current language. */
	function copy() {
	  var table = COPY[language()]
	  return table !== undefined ? table : COPY.en
	}
	
	/**
	 * 栏宽变化之后，工具条那个读数最多隔多久重读一次（票 #19）。
	 *
	 * 为什么要有这一条：自动适配是**外壳**按新栏宽改的缩放，而面板上那个数只在"按下某个按钮"
	 * 或"页面刚打开"时读过。拖动侧边栏之后不重读的话，画面已经 52% 了，读数还写着 `自动 100%`
	 * —— 那正是票面说的"不许让人看不出来"的反面。
	 *
	 * 为什么要节流：拖动时面板每一帧都上报一次几何，而每一次重读都要走宿主一个来回
	 * （HTTP + 一次页面读回），400ms 一次既跟得上手，又不会把宿主刷满。
	 */
	var PANEL_REFRESH_MIN_MS = 400
	
	/**
	 * The client context, kept where the toolbar can reach it.
	 *
	 * It is set once by {@link apply} and read by the strip on render. A module-scoped variable
	 * rather than a prop because the tab body is registered as a component *before* `apply` has
	 * anything to pass it, and threading `ctx` through the product's slot props is not something
	 * this plugin gets to do.
	 */
	var clientContext = null
	
	/**
	 * The channel the panel's buttons call, and the endpoints on it.
	 *
	 * It is the shared `/api` channel (ADR-0003's carrier-neutral RPC, reached through
	 * `ctx.connection.rpc.call`), and the endpoint names carry this plugin's namespace so they
	 * cannot collide with the product's own (`credentials/*`, `session/*`). Both halves of the
	 * names live in `src/view-rpc.ts`; this is the client half of that one contract.
	 */
	var RPC_CHANNEL = '/api'
	
	/** The endpoint a given action is called on: `desktop-view-back`, `desktop-view-state`, … */
	function endpointFor(action) {
	  return 'desktop-view-' + action
	}
	
	/**
	 * One button press: ask the host to do it, and hand back the state it read afterwards.
	 *
	 * Every failure is turned into a value rather than thrown onwards, because the toolbar has
	 * exactly one place to show an outcome (the status line) and a rejected promise there would
	 * leave the line showing the *previous* action's result — a toolbar that reports the wrong
	 * thing is worse than one that reports nothing.
	 *
	 * @param {object} ctx - the plugin context, carrying `connection`.
	 * @param {string} action - the action name.
	 * @returns {Promise<{ok: boolean, url: string, zoom: unknown, canGoBack: boolean,
	 *   canGoForward: boolean, message: string}>} the host's answer, or a local failure value.
	 */
	async function callView(ctx, action) {
	  try {
	    var answer = await ctx.connection.rpc.call(RPC_CHANNEL, endpointFor(action), { nonce: String(Date.now()) })
	    if (answer === null || answer === undefined || answer.ok !== true) {
	      var failure = answer !== null && answer !== undefined && answer.error !== undefined ? answer.error : undefined
	      return {
	        ok: false,
	        url: '',
	        zoom: undefined,
	        canGoBack: false,
	        canGoForward: false,
	        message:
	          failure !== undefined && typeof failure.message === 'string'
	            ? failure.message
	            : 'the desktop shell did not answer (it may not be running, or the view is gone)',
	      }
	    }
	    return answer.value
	  } catch (error) {
	    return {
	      ok: false,
	      url: '',
	      zoom: undefined,
	      canGoBack: false,
	      canGoForward: false,
	      message:
	        'this pane could not reach the shell: ' +
	        (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)),
	    }
	  }
	}
	
	/**
	 * The toolbar strip above the browser view.
	 *
	 * It is **in the panel, not in the view**: the native view parks on the rectangle this
	 * panel reports, and the panel is a page in the shell's own window, so nothing drawn here
	 * can reach the page the agent snapshots (a test pins that with "the view's snapshot is
	 * unchanged while the toolbar exists").
	 *
	 * The strip takes its height off the top and reports the remaining rectangle, so the view
	 * is not covered by its own controls. It also **loses the race on purpose** where it should:
	 * the status line is the only thing it says, and it says it from the host's read-back.
	 *
	 * @param {{ctx: object, hasShell: boolean, geometryTick?: number}} props - the plugin context, whether
	 *   the shell is here, and a counter that goes up whenever the pane's own rectangle changed.
	 * @returns {import('react').ReactElement} the toolbar element.
	 */
	function Toolbar(props) {
	  var react = require('react')
	  var toolbar = DshViewToolbar
	  var [state, setState] = react.useState({
	    ok: null,
	    url: '',
	    zoom: undefined,
	    zoomMode: undefined,
	    canGoBack: false,
	    canGoForward: false,
	    message: '',
	    busy: false,
	  })
	
	  /** 读一次"外壳现在说什么"，并把结果落到那一行上。 */
	  var refresh = react.useCallback(function () {
	    void callView(props.ctx, 'state').then(function (next) {
	      setState(function (previous) {
	        return Object.assign({}, previous, next, { busy: false })
	      })
	    })
	  }, [])
	
	  /**
	   * Run one action, then show what the host read back **after** it.
	   *
	   * The read-back is the point: the host answers with the post-action state, so the zoom
	   * label and the two history buttons come from the view rather than from a local guess
	   * that could drift the moment anything else drives the view (the agent does).
	   */
	  var run = react.useCallback(
	    function (action) {
	      setState(function (previous) {
	        return Object.assign({}, previous, { busy: true })
	      })
	      void callView(props.ctx, action).then(function (next) {
	        setState(function (previous) {
	          return Object.assign({}, previous, next, { busy: false })
	        })
	      })
	    },
	    [],
	  )
	
	  // The first read happens once the strip is on screen. It is deliberately not part of a
	  // render: a render that started a request would start one per re-render.
	  react.useEffect(function () {
	    refresh()
	  }, [])
	
	  /**
	   * 栏宽变了 ⇒ 那个读数要重读（票 #19）。
	   *
	   * 这一格自己**知道**栏宽什么时候变：面板矩形一变就上报一次，而外壳正是拿那个矩形决定
	   * 视图多大、并（在自动模式下）按新宽度重新适配页面。所以几何一动就要问一次
	   * "现在是多少、谁在管"，否则读数会停在上一次按下的那个数上。
	   *
	   * 节流到 {@link PANEL_REFRESH_MIN_MS}，并且**补最后一次**：拖动中间隔多久都行，
	   * 但停下来之后那一次必须发出去 —— 那才是最终状态。
	   */
	  var lastReadAt = react.useRef(0)
	  var pendingRead = react.useRef(0)
	  react.useEffect(
	    function () {
	      if (props.geometryTick === undefined || props.geometryTick === 0) return
	      var since = Date.now() - lastReadAt.current
	      if (since >= PANEL_REFRESH_MIN_MS) {
	        lastReadAt.current = Date.now()
	        refresh()
	        return
	      }
	      if (pendingRead.current !== 0) return
	      pendingRead.current = setTimeout(function () {
	        pendingRead.current = 0
	        lastReadAt.current = Date.now()
	        refresh()
	      }, PANEL_REFRESH_MIN_MS - since)
	    },
	    [props.geometryTick],
	  )
	
	  // 面板走了就把排着的那次读撤掉：一个卸载之后再打出去的请求只会写到一个已经不存在的状态上。
	  react.useEffect(function () {
	    return function () {
	      if (pendingRead.current !== 0) clearTimeout(pendingRead.current)
	      pendingRead.current = 0
	    }
	  }, [])
	
	  // Keyboard shortcuts. Registered on the window because the panel is one element among
	  // many in the DSH window and a person's hands are usually in the chat box.
	  react.useEffect(function () {
	    function onKeyDown(event) {
	      var target = event.target
	      var inTextField =
	        target !== null &&
	        target !== undefined &&
	        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
	      var action = toolbar.actionForKey(event, inTextField)
	      if (action === null) return
	      event.preventDefault()
	      run(action)
	    }
	    window.addEventListener('keydown', onKeyDown)
	    return function () {
	      window.removeEventListener('keydown', onKeyDown)
	    }
	  }, [])
	
	  var children = []
	  for (var index = 0; index < toolbar.BUTTONS.length; index++) {
	    var button = toolbar.BUTTONS[index]
	    var enabled = toolbar.isEnabled(button.action, {
	      canGoBack: state.canGoBack,
	      canGoForward: state.canGoForward,
	      busy: state.busy,
	      hasShell: props.hasShell,
	    })
	    children.push(
	      react.createElement(
	        'button',
	        {
	          key: button.action,
	          type: 'button',
	          'data-dsh-view-action': button.action,
	          title: button.title,
	          disabled: !enabled,
	          onClick: (function (action) {
	            return function () {
	              run(action)
	            }
	          })(button.action),
	          style: {
	            font: '12px/1 system-ui',
	            minWidth: '24px',
	            height: '22px',
	            padding: '0 6px',
	            border: '1px solid var(--dsh-color-border, #d0d7de)',
	            borderRadius: '4px',
	            background: 'var(--dsh-color-surface, #fff)',
	            color: 'inherit',
	            cursor: enabled ? 'pointer' : 'not-allowed',
	            opacity: enabled ? 1 : 0.45,
	          },
	        },
	        button.label,
	      ),
	    )
	  }
	
	  // 票 #19：那个读数带上"谁在管"（自动 / 手动）。词来自本文件前面那张文案表 ——
	  // `src/toolbar.js` 一行文案都不带，它只回答"该怎么拼"。
	  var zoomText = toolbar.zoomReading(state.zoom, state.zoomMode, {
	    auto: copy().zoomAuto,
	    manual: copy().zoomManual,
	  })
	
	  return react.createElement(
	    'div',
	    {
	      'data-dsh-view-toolbar': 'ready',
	      style: {
	        height: toolbar.TOOLBAR_HEIGHT_PX + 'px',
	        display: 'flex',
	        alignItems: 'center',
	        gap: '4px',
	        padding: '0 6px',
	        boxSizing: 'border-box',
	        borderBottom: '1px solid var(--dsh-color-border, #d0d7de)',
	        background: 'var(--dsh-color-surface, #fff)',
	        color: 'var(--dsh-color-text, #1f2328)',
	        flex: '0 0 auto',
	      },
	    },
	    children,
	    react.createElement(
	      'span',
	      {
	        'data-dsh-view-zoom': zoomText,
	        style: {
	          marginLeft: 'auto',
	          font: '11px/1.3 system-ui',
	          whiteSpace: 'nowrap',
	          overflow: 'hidden',
	          textOverflow: 'ellipsis',
	          maxWidth: '45%',
	          textAlign: 'right',
	          opacity: state.ok === false ? 1 : 0.75,
	          color: state.ok === false ? 'var(--dsh-color-danger, #b42318)' : 'inherit',
	        },
	        title: toolbar.statusText(state),
	      },
	      zoomText + ' \u00b7 ' + toolbar.statusText(state),
	    ),
	  )
	}
	
	/**
	 * The panel — the whole visible surface of this plugin in the sidebar.
	 *
	 * It renders no web page. It measures itself and reports the rectangle to the
	 * shell, which owns the native view and places it there (ADR-0004). Everything it
	 * draws is a caption describing that arrangement, because a pane that shows
	 * nothing and explains nothing is indistinguishable from a broken plugin.
	 *
	 * @param {{tabInfo: () => {sidebar: {expanded: boolean}, tab: {visible: boolean}}}} props - slot props.
	 * @returns {import('react').ReactElement} the panel element.
	 */
	function Panel(props) {
	  var react = require('react')
	  var hasShell = DshPanelRect.hasShell()
	  /** 外层容器（工具条 + 下面那块）。它**不是**被测量的那一个。 */
	  var containerRef = react.useRef(null)
	  /** 被测量的那一块（`data-dsh-desktop-view-panel` 那个 div）：原生画面就摆在这里。 */
	  var bodyRef = react.useRef(null)
	  var [report, setReport] = react.useState({ rect: null, state: 'detached' })
	  /**
	   * 面板矩形变过几次（票 #19）。工具条拿它当"栏宽可能变了"的信号：拖动侧边栏时它每一帧都涨，
	   * 而工具条那边节流之后才去重读缩放读数。涨这个数不额外引起渲染 —— 上报本来就会 setReport。
	   */
	  var [geometryTick, setGeometryTick] = react.useState(0)
	
	  // The observer outlives every render, so it is created once and its `element` is
	  // re-read on every measurement: React may replace the DOM node without the
	  // measurement ever being wrong about which node it is looking at.
	  var elementRef = react.useRef(null)
	  var observer = react.useMemo(function () {
	    if (!hasShell) return null
	    return DshPanelRect.observe({
	      get element() {
	        return elementRef.current
	      },
	      onReport: function (rect, state) {
	        setReport({ rect: rect, state: state })
	        setGeometryTick(function (previous) {
	          return previous + 1
	        })
	        DshPanelRect.deliver(rect)
	      },
	    })
	  }, [])
	
	  react.useEffect(function () {
	    // The element only exists after the first commit, so the first measurement
	    // happens here rather than during render. Reporting on every mount (not only on
	    // change) is deliberate: a remount — StrictMode's double-invoke, or React
	    // swapping the tree — runs the previous cleanup, which reported "no rectangle",
	    // and the view must come back without waiting for a resize.
	    if (observer !== null) observer.report()
	    return function () {
	      if (observer !== null) observer.stop()
	      // The panel is leaving; the view must not stay parked over whatever replaces
	      // it. Reporting "no rectangle" on teardown is the only way to say that.
	      if (hasShell) DshPanelRect.deliver(null)
	    }
	  }, [])
	
	  // 被测量的那一块，不是外层容器 —— 见下面那段注释。
	  elementRef.current = bodyRef.current
	
	  var caption = !hasShell
	    ? copy().noShell
	    : report.rect === null
	      ? copy().missing
	      : copy().ready
	
	  // Two stacked rows: the toolbar, and the rectangle the native view parks on.
	  //
	  // The measured element is the *lower* one, and that is deliberate: the view covers exactly
	  // what the panel reports (ADR-0004), so a toolbar sharing that rectangle would be painted
	  // over by the very view it drives. Reporting the rectangle below the strip is what makes
	  // the buttons visible at all — and it keeps the strip in the panel, where it cannot reach
	  // the page the agent snapshots.
	  //
	  // 票 #18 的第二处真机 bug 就出在这一句上：`elementRef.current` 曾经指向**外层容器**
	  // （它同时装着工具条与这一块），于是上报的矩形 = 容器 = 工具条 + 面板，外壳把原生画面
	  // 摆到整块上，**连工具条那一行一起盖住** —— 用户看到的是"那一格上面空空的，没有后退/前进"。
	  // 注释一直写的是"被测量的是下面那一个"，代码写的是容器：注释对、代码错。
	  // 现在两者一致，而 `tests/panel-toolbar-placement.spec.ts` 钉住"上报矩形的上边缘 ≥ 工具条
	  // 的下边缘"这一条。
	  var inner = react.createElement(
	    'div',
	    {
	      ref: containerRef,
	      style: {
	        width: '100%',
	        height: '100%',
	        overflow: 'hidden',
	        display: 'flex',
	        flexDirection: 'column',
	        boxSizing: 'border-box',
	        // 相对定位：被测量的那一块是它的孩子，`getBoundingClientRect()` 报的是视口坐标，
	        // 宿主也是按视口坐标摆画面的（T2 量过两端同一套坐标）。
	        position: 'relative',
	      },
	    },
	    hasShell ? react.createElement(Toolbar, { ctx: clientContext, hasShell: hasShell, geometryTick: geometryTick }) : null,
	    react.createElement(
	      'div',
	      {
	        // 测量用的那个引用在这里就位：React 在 commit 时调它，早于任何 effect，
	        // 所以 `observer.report()`（在 effect 里）读到的已经是这一块，不是容器。
	        ref: function (node) {
	          bodyRef.current = node
	          elementRef.current = node
	        },
	        'data-dsh-desktop-view-panel': report.state,
	        style: {
	          // 这一块**就是**上报出去的那个矩形，而它的上边缘必须紧接工具条的下边缘 ——
	          // 它被测量、被上报，外壳把原生画面摆在它上面（ADR-0004）。所以它是**工具条下面
	          // 那一格**（`flex: 1 1 auto` 把剩下的高度全拿走），不是整块。
	          flex: '1 1 auto',
	          minHeight: 0,
	          // 相对定位：原生画面要摆在这个矩形上，而这里不做任何偏移。
	          position: 'relative',
	          overflow: 'hidden',
	          display: 'flex',
	          alignItems: 'center',
	          justifyContent: 'center',
	          padding: '12px',
	          boxSizing: 'border-box',
	          textAlign: 'center',
	          opacity: report.rect === null ? 1 : 0,
	          color: 'var(--dsh-color-text-secondary, #6b7280)',
	          fontSize: '12px',
	          lineHeight: '1.5',
	        },
	      },
	      caption,
	    ),
	  )
	
	  return inner
	}
	
	/**
	 * Register this plugin's client half.
	 *
	 * @param {object} ctx - client root context; `slots`, `locale`, and `sidebarRightTabs` are read from it.
	 * @returns {void}
	 */
	function apply(ctx) {
	  var t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : function () { return 'Browser' }
	  // The toolbar reads this on render; see the note on the variable itself.
	  clientContext = ctx
	
	  // Stage one: what the type IS.
	  ctx.effect(function () {
	    return ctx.sidebarRightTabs.register({
	      id: TYPE_ID,
	      kind: TYPE_KIND,
	      // A page type ships from outside the product, which is the highest band; the
	      // literal is spelled out rather than imported so this file needs nothing from
	      // the product's runtime to declare itself. It is also what the type system
	      // defaults to, so this is documentation as much as configuration.
	      priority: 'extension',
	      // No `patterns`: a page type is opened by `kind` and recognizes no address
	      // (`tab-registry.d.ts:79-89`).
	      title: function () {
	        return t('type.label')
	      },
	      // The guide entry is the user's way in, and it is not optional in practice: a
	      // page type claims no address, so nothing in the product will open it by
	      // itself. The guide lists one capsule per entry and picking a capsule calls
	      // `openTab(entry.kind)` — with no entry, the type exists, renders nowhere, and
	      // the pane the user is looking for is simply unreachable.
	      guide: [
	        {
	          // Ascending position among every registered type's entries. The shipped
	          // Files entry is `order: 10`, so this one follows it.
	          order: 20,
	          title: function () {
	            return t('guide.title')
	          },
	          description: function () {
	            return t('guide.description')
	          },
	          // No `icon`: a glyph here would mean importing a React component from the
	          // product's primitives package, and the guide draws its own placeholder
	          // cube for an entry that registered none (`tab-registry.d.ts:60-61`).
	        },
	      ],
	    })
	  }, 'desktop-view: tab type')
	
	  ctx.effect(function () {
	    return ctx.locale.register(NS, DICTIONARIES)
	  }, 'desktop-view: dictionaries')
	
	  // Stage two: the body, under this definition's own `id`. One registration serves
	  // every tab of the kind, in every pane, docked or floating.
	  ctx.effect(function () {
	    return ctx.slots.inject('sidebar.right.pane.tab', function () {
	      return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: NS }, Panel)
	    })
	  }, 'desktop-view: tab body')
	}
	
	exports.apply = apply
	exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']
		//#endregion

		// The host's loader wants an object with an `apply` method, and says only
		// "invalid plugin ... received object" when it does not get one. Checking the
		// contract here names the failure where it happens instead of leaving a plugin
		// that loads, registers nothing, and reports nothing.
		if (typeof module.exports.apply !== 'function') {
			throw new Error(
				'dsh-desktop-view: the generated client half exported no apply(); ' +
					'regenerate it with scripts/build-client.mjs',
			)
		}
		return module.exports
	},
})
