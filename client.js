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
		    // 票 #20b：**这颗按钮的标签原来是 `100%`，现在是 `reset`**，而这是一条验收要求逼出来的，
		    // 不是口味问题。读数去掉了 `手动`/`自动` 前缀之后，工具条上那句读数就是 `100%`；而标签为
		    // `100%` 的它会在同一行里**第二次**说出那句话 —— 票面要求"那句话只许出现一次，且要能数出
		    // 次数（必须是 1）"，所以同一句话不能同时是一颗动作按钮的名字。动作一个没少：它仍然把缩放
		    // 送回 100%，那句话仍在 `title` 上（"reset the zoom to 100%"）。
		    // 词形与旁边的 `restart` 一致（都是词，不是百分比）—— 见 `tests/toolbar-panel.spec.ts` 里
		    // 那条"数出现次数"的断言。
		    { action: 'zoom-reset', label: 'reset', title: 'reset the zoom to 100%', shortcut: null },
		    { action: 'zoom-in', label: '+', title: 'zoom in', shortcut: null },
		    // 票 #20b：**这里原来有一颗 `auto` 按钮（票 #19 加的），现在没有了。**
		    //
		    // 它当初存在的唯一理由是"手动缩放是一个进得去出不来的状态"：一旦有人指名过缩放值，自动适配
		    // 就永远让位（#19 的语义），所以必须有一颗按钮把控制权交回去。票 #20b 把那条让位规则整个
		    // 去掉了 —— 适配**永远开着**，一次手动缩放只是"现在的值"，下一次几何变化或换页都会被重新
		    // 适配（见 `shell/main.js` 的 `applyZoom` 与 `did-navigate`）。没有模式可以交还，于是那颗
		    // 按钮没有意义了。**通道那头那个动作端点还在**（旧客户端仍在调它），但面板不再渲染它。
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
		   * 面板上那个缩放读数（票 #20b：**只有百分比，没有模式前缀**）。
		   *
		   * 票 #19 时这里长这样：`zoomReading(zoom, mode, words)` —— 按外壳说的模式拼出 `自动 78%` /
		   * `手动 90%`，读不到模式就退回光秃秃的百分比。**票 #20b 把模式这一整套去掉了**：适配永远开着，
		   * 所以"谁在管这个缩放"不再是一个会变的事实，前缀因此只会是一句废话（还会跟旁边那颗动作按钮
		   * 抢同一句话，见 {@link BUTTONS} 里 `zoom-reset` 那一段）。
		   *
		   * 外壳**仍然会发布** `mode`/`zoomMode`（旧插件在读它，兼容不许破，见 `shell/main.js` 的
		   * `writeZoomFile`），但面板这一侧**一个字节都不用它**：这个函数只收一个数，多给一个参数也
		   * 不会变出前缀来（`tests/toolbar.spec.ts` 有一条断言专门钉这件事）。
		   *
		   * 读不到那个数时仍然是 `—`，不是 `100%`：{@link zoomLabel} 的规矩没变 —— 面板上那句话
		   * 一旦不成立，用户就再也分不清"没读数"和"读到了 100%"。
		   *
		   * @param {unknown} zoom - 外壳读回来的缩放值。
		   * @returns {string} 要显示的那一句（就是一个百分比，或 `—`）。
		   */
		  function zoomReading(zoom) {
		    return zoomLabel(zoom)
		  }
		
		  /**
		   * 那行读数上**该给用户看**的那半句（票 #20 C）。
		   *
		   * 票面原话：`nothing was changed` 是给开发者看的诊断话术，不该出现在用户眼前；读数只留
		   * 用户要的信息。所以这里只有一种情况会说话：**上一次动作没成** —— 那时"为什么没成"
		   * 正是用户需要的那句话（"没有可后退的一页"），它也是这行字存在的理由。
		   *
		   * 成功时这里返回空串，**不是**因为宿主没话说，而是因为宿主那句话是诊断：一次普通状态读回
		   * 的 `message`、一次缩放里"布局视口现在是多少 CSS 像素"，都是给读日志的人看的。
		   * 它们没有被删掉 —— {@link diagnosticText} 把它们原样留着，面板把它们挂在
		   * `title` 与 `data-dsh-view-diagnostic` 上（另一个通道，仍然读得到）。
		   *
		   * @param {{message: string, ok: boolean|null}} state
		   * @returns {string} 要显示的那半句（可能为空串）。
		   */
		  function statusText(state) {
		    if (state.ok !== false) return ''
		    var message = state.message === undefined || state.message === '' ? 'the action did not happen' : state.message
		    return '\u2717 ' + message
		  }
		
		  /**
		   * 同一行读数上**给读日志的人看**的那半句（票 #20 C）。
		   *
		   * 它就是票前那行字原来的内容：宿主那句原话，加上视图现在在哪。票面要求"诊断本身不要删，
		   * 只是从用户可见文本里移走"，所以它从这里出去，落到面板元素的 `title`（悬停看得到）与
		   * `data-dsh-view-diagnostic`（机器读得到）上。
		   *
		   * 还没有读到任何东西时给一句"正在读"，而不是空串：空的诊断与"通道坏了"长得一样。
		   *
		   * @param {{url?: string, message?: string}} state
		   * @returns {string} 诊断全文。
		   */
		  function diagnosticText(state) {
		    var parts = []
		    if (state.message !== undefined && state.message !== '') parts.push(state.message)
		    if (state.url !== undefined && state.url !== '') parts.push(state.url)
		    if (parts.length === 0) return 'reading the view\u2026'
		    return parts.join(' \u2014 ')
		  }
		
		  /**
		   * 那行读数整个的样子（票 #20 C 定的形状，票 #20b 把模式前缀去掉了）：**百分比**，必要时再加两样。
		   *
		   *  - 页面还在加载 ⇒ 加一个"加载中"（票 #20 F 的第一条）；
		   *  - 上一次动作没成 ⇒ 加那句"为什么"（{@link statusText}）。
		   *
		   * 三样之间用 ` · ` 连起来。URL **不在**这一行里 —— 它的位置让给了地址栏（票面 C 的原话）。
		   *
		   * @param {{zoom: unknown, loading?: unknown, message?: string, ok?: boolean|null}} state
		   * @param {{loading?: string}} [words] - 要显示的那几个词（住在文案表里）。
		   * @returns {string} 要显示的那一行。
		   */
		  function readingText(state, words) {
		    var table = words !== undefined && words !== null ? words : {}
		    var parts = [zoomReading(state.zoom)]
		    if (state.loading === true && typeof table.loading === 'string' && table.loading !== '') parts.push(table.loading)
		    var note = statusText(state)
		    if (note !== '') parts.push(note)
		    return parts.join(' \u00b7 ')
		  }
		
		  /**
		   * 标准缩放档位（票 #20 D）：真浏览器点百分比能选的那些。
		   *
		   * 单位是**百分比**，因为这就是面板上要显示的东西；{@link zoomPresetFactor} 负责把它换成
		   * 会话与外壳用的那个 1 = 100% 的倍数。每一个都必须在 `src/navigation.ts` 的 `ZOOM_STEPS`
		   * 里 —— 面板给出的档位与 `−`/`+` 走过的档位必须是同一串数，否则"选 125% 再按一次 +"
		   * 会跳到一个谁也没见过的值上。这一条由 `tests/toolbar.spec.ts` 从两侧读回。
		   */
		  var ZOOM_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
		
		  /**
		   * 一个档位的倍数（100 ⇒ 1）。
		   *
		   * 不在表里的百分比**不收**：这条通道上没有一个"缩放到任意值"的动作，面板能要的只有这些
		   * 档位（`src/view-rpc.ts` 的 `zoom-to`）。
		   *
		   * @param {unknown} percent - 面板上那个数。
		   * @returns {number|null} 倍数，或 null（不是档位）。
		   */
		  function zoomPresetFactor(percent) {
		    if (typeof percent !== 'number' || !isFinite(percent)) return null
		    for (var index = 0; index < ZOOM_PRESETS.length; index++) {
		      if (ZOOM_PRESETS[index] === percent) return percent / 100
		    }
		    return null
		  }
		
		  /**
		   * 现在的缩放在档位表里对应哪一个（用来在菜单里标出"你在这儿"）。
		   *
		   * 对不上任何一个就返回 `null`：自动适配算出来的 78% 不在档位表里，那时**一个都不标**，
		   * 而不是硬说最接近的那个 —— 标错一个档位比不标更坏，因为人会以为自己在那儿。
		   *
		   * @param {unknown} zoom - 外壳读回来的缩放值。
		   * @returns {number|null} 百分比，或 null。
		   */
		  function currentPreset(zoom) {
		    if (typeof zoom !== 'number' || !isFinite(zoom)) return null
		    for (var index = 0; index < ZOOM_PRESETS.length; index++) {
		      if (Math.abs(ZOOM_PRESETS[index] / 100 - zoom) < 1e-6) return ZOOM_PRESETS[index]
		    }
		    return null
		  }
		
		  /** 带 `//` 的协议：写明了就用它，而且 `//` 后面必须真有主机名。 */
		  var AUTHORITY_SCHEMES = ['http://', 'https://']
		
		  /**
		   * 不带主机名的地址（或者主机名可以是空的那些）：前缀之后还有东西就接受。
		   *
		   * `file:///C:/x` 的 `//` 后面直接就是路径，`about:blank` 后面是那一页的名字 —— 两者都不该
		   * 被"没有主机名"这条规矩拒掉。
		   *
		   * 表刻意小：地址栏能去的地方只有这几类 + 上面那两种。`javascript:` / `data:` /
		   * `mailto:` / `blob:` 一律**拒**（不是"补个 https 试试"）—— 一条说不清的地址比一句
		   * "这个我不开"更容易骗人。
		   */
		  var OPAQUE_ADDRESSES = ['about:', 'file:']
		
		  /**
		   * 回环主机：它们补的是 `http://`，不是 `https://`。
		   *
		   * 这是那条规则唯一的例外，理由是本项目自己的日常：本机上跑着的东西（夹具站点、开发服务器）
		   * 几乎从不带 TLS，而"localhost:3000 被我们悄悄改成 https"会让最常敲的那个地址打不开。
		   */
		  var LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']
		
		  /**
		   * 地址栏里那串字**该变成哪个地址**（票 #20 A）。
		   *
		   * ## 规则（票面要求"定一条规则并说明"）
		   *
		   * 1. **写明了协议的**（`http://` / `https://`）或 **`about:` / `file:`** —— 原样用；
		   * 2. **只写了主机名的** —— **补 `https://`**（`example.com` ⇒ `https://example.com`）；
		   * 3. **唯一的例外：回环主机**（`localhost` / `127.0.0.1` / `[::1]` / `::1` / `0.0.0.0`）
		   *    —— 补 `http://`（`localhost:3000` ⇒ `http://localhost:3000`，理由见 {@link LOOPBACK_HOSTS}）；
		   * 4. **别的协议一律拒**，而且**说得出是拒**（`reason: 'scheme'`），不是悄悄补一个
		   *    `https://` 让引擎去报一个看不懂的错。
		   *
		   * `host:port` 里的那个冒号**不是协议**：`example.com:8080` 与 `localhost:3000` 都按第 1/3 条
		   * 走。判据是"冒号后面到下一个 `/?#` 之前全是数字"——协议名后面不会只有数字。
		   *
		   * 这个函数**只判断，不联网、不碰页面**：所以"我输的那串字会去哪儿"这件事可以在没有浏览器的
		   * 用例里逐条钉住（`tests/toolbar.spec.ts`）。
		   *
		   * @param {unknown} input - 输入框里那串字。
		   * @returns {{ok: true, url: string} | {ok: false, reason: 'empty'|'spaces'|'host'|'scheme'}}
		   *   那个地址，或一条说得清的原因（原因是一**个词**，文案住在 `src/client-body.js` 的文案表里）。
		   */
		  function parseAddress(input) {
		    var raw = typeof input === 'string' ? input.trim() : ''
		    if (raw === '') return { ok: false, reason: 'empty' }
		    // 网址里没有空格。有空格的多半是一句想搜索的话 —— 我们不搜索（本期不做），所以如实说。
		    if (/\s/.test(raw)) return { ok: false, reason: 'spaces' }
		    var lower = raw.toLowerCase()
		    var index
		    for (index = 0; index < AUTHORITY_SCHEMES.length; index++) {
		      if (lower.indexOf(AUTHORITY_SCHEMES[index]) === 0) {
		        return authority(raw) ? { ok: true, url: raw } : { ok: false, reason: 'host' }
		      }
		    }
		    for (index = 0; index < OPAQUE_ADDRESSES.length; index++) {
		      if (lower.indexOf(OPAQUE_ADDRESSES[index]) === 0) {
		        return lower.length > OPAQUE_ADDRESSES[index].length
		          ? { ok: true, url: raw }
		          : { ok: false, reason: 'host' }
		      }
		    }
		    // 这里开始：没有协议。先看那个冒号是不是端口号。
		    // 以 `[` 开头的是括号里的 IPv6（`[::1]:5173`）—— 里面那些冒号是地址的一部分，不是协议。
		    var colon = raw.indexOf(':')
		    var slash = raw.search(/[/?#]/)
		    var schemeLike = raw.charAt(0) !== '[' && colon > 0 && (slash === -1 || colon < slash)
		    if (schemeLike) {
		      var after = slash === -1 ? raw.slice(colon + 1) : raw.slice(colon + 1, slash)
		      if (!/^[0-9]+$/.test(after)) return { ok: false, reason: 'scheme' }
		    }
		    var host = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase()
		    // 括号里的 IPv6（`[::1]:5173`）里那个冒号是地址的一部分，不是端口分隔符。
		    var hostname = host.charAt(0) === '[' ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
		    var prefix = LOOPBACK_HOSTS.indexOf(hostname) !== -1 ? 'http://' : 'https://'
		    var url = prefix + raw
		    return authority(url) ? { ok: true, url: url } : { ok: false, reason: 'host' }
		  }
		
		  /** `scheme://` 后面到底有没有主机名（`https://` 与 `https:///x` 都没有）。 */
		  function authority(url) {
		    var after = url.slice(url.indexOf('//') + 2)
		    var end = after.search(/[/?#]/)
		    var host = end === -1 ? after : after.slice(0, end)
		    return host !== ''
		  }
		
		  /**
		   * 侧边栏那个标签该写什么（票 #20 B）。
		   *
		   * 页面标题来自**一次独立读回**（宿主问视图那一页），不是面板猜的；读不到（还没读过、
		   * 正在换文档、标题是空的）就回落到标签类型自己的名字 —— 一个空标签比"浏览器"更坏，
		   * 因为一个空标签看不出那一格里是什么，而"浏览器"至少说出了它是个浏览器。
		   *
		   * @param {unknown} title - 外壳读回来的那个标题。
		   * @param {string} fallback - 读不到时写什么（文案表里那个词）。
		   * @returns {string} 标签上那串字。
		   */
		  function titleForTab(title, fallback) {
		    if (typeof title !== 'string') return fallback
		    var trimmed = title.trim()
		    return trimmed === '' ? fallback : trimmed
		  }
		
		  /**
		   * 悬停在后退/前进上时那句"会退到哪一页"（票 #20 F 的第二条）。
		   *
		   * 目标**来自引擎自己的导航历史**（`Page.getNavigationHistory` 里当前索引的前/后一条），
		   * 所以它是"那一页是什么"，不是"我们记得那一页是什么"。读不到（引擎答不上来、或者那边
		   * 没有一页）就返回 `undefined` —— 那时按钮上**一个字的提示都不给**，而不是给一个空 tooltip：
		   * 空的与"这一页没有标题"长得一模一样，而后者会让人以为目标页真的没有标题。
		   *
		   * 有标题用标题，没有标题用地址（真浏览器也是这么做的：标题拿不到时显示 URL）。
		   *
		   * @param {{title?: unknown, url?: unknown} | undefined | null} target - 那一页。
		   * @param {string} [prefix] - 前缀那个词（住在文案表里；缺省就只给目标本身）。
		   * @returns {string|undefined} tooltip 上那句话。
		   */
		  function travelHint(target, prefix) {
		    if (target === undefined || target === null || typeof target !== 'object') return undefined
		    var title = typeof target.title === 'string' ? target.title.trim() : ''
		    var url = typeof target.url === 'string' ? target.url.trim() : ''
		    var label = title !== '' ? title : url
		    if (label === '') return undefined
		    if (typeof prefix !== 'string' || prefix === '') return label
		    return prefix + ' ' + label
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
		    ZOOM_PRESETS: ZOOM_PRESETS,
		    isEnabled: isEnabled,
		    zoomLabel: zoomLabel,
		    zoomReading: zoomReading,
		    zoomPresetFactor: zoomPresetFactor,
		    currentPreset: currentPreset,
		    parseAddress: parseAddress,
		    statusText: statusText,
		    diagnosticText: diagnosticText,
		    readingText: readingText,
		    titleForTab: titleForTab,
		    travelHint: travelHint,
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
	    // 票 #20b：票 #19 加在这里的 `zoomAuto` / `zoomManual` 两个词**被删掉了**。
	    // 读数上不再有模式前缀（适配永远开着，那个前缀只会是一句废话），所以那两个词没有任何使用者；
	    // 留在文案表里只会让下一个人以为"面板还会说出它们"。
	    // 票 #20 A：地址栏。
	    //
	    // `addressHelp` 是那条**补协议**的规则本身，写在输入框的 title 上：规则要说得出口，
	    // 而不是让人试出来（票面原话："定一条规则并说明"）。它与 `src/toolbar.js` 的
	    // `parseAddress` 是同一句话的两种写法，所以两者挨着改。
	    addressPlaceholder: '输入网址，回车打开',
	    addressHelp: '只写主机名时补 https://（例：example.com → https://example.com）；本机地址补 http://（例：localhost:3000）；也可以直接写 http:// / https:// / file:// / about:',
	    addressSend: '打开',
	    addressEmpty: '先输一个网址。',
	    addressSpaces: '网址里不能有空格 —— 这一格不会把一句话变成搜索。',
	    addressHost: '这个地址里没有主机名。',
	    addressScheme: '这一格只开 http / https / file / about 开头的地址。',
	    // 票 #20 D：档位菜单。
	    zoomMenuTitle: '选一个标准档位',
	    // 票 #20 F 的第一条：页面还在加载。
	    loading: '加载中',
	    // 票 #20 F 的第二条：悬停在后退/前进上时那个"会去哪一页"。
	    backTo: '后退到',
	    forwardTo: '前进到',
	  },
	  en: {
	    noShell:
	      'This pane needs the desktop shell to show the browser. The shell is the Electron app that ships ' +
	      'in this repository: run npm run shell there and this pane shows the real browser view. A plain ' +
	      'browser tab has nothing to put here.',
	    ready: 'The desktop shell is here: the native browser view takes this pane.',
	    missing: 'This pane reports no rectangle (collapsed or switched away).',
	    // 票 #20b：票 #19 的 `auto` / `manual` 两个词随模式一起删掉（见上面 zh 那一段的说明）。
	    addressPlaceholder: 'Type an address, press Enter',
	    addressHelp: 'A bare host gets https:// (example.com → https://example.com); a loopback host gets http:// (localhost:3000); http://, https://, file:// and about: are used as typed.',
	    addressSend: 'open',
	    addressEmpty: 'Type an address first.',
	    addressSpaces: 'An address cannot contain spaces — this pane does not turn a sentence into a search.',
	    addressHost: 'That address has no host name.',
	    addressScheme: 'This pane opens http, https, file and about addresses only.',
	    zoomMenuTitle: 'pick a standard zoom step',
	    loading: 'loading',
	    backTo: 'back to',
	    forwardTo: 'forward to',
	  },
	}
	
	/** 提交地址被拒时那几个原因码（`src/toolbar.js` 的 `parseAddress`）对应的句子。 */
	var ADDRESS_REASONS = {
	  empty: 'addressEmpty',
	  spaces: 'addressSpaces',
	  host: 'addressHost',
	  scheme: 'addressScheme',
	}
	
	/**
	 * 把 `parseAddress` 给的原因码翻成一句人话。
	 *
	 * 认不出来的原因码**照样说点什么**（`addressScheme` 那句"只开这几种"是最接近事实的兜底），
	 * 而不是把 `undefined` 显示到用户眼前：一条说不清的拒绝比一句略宽的说明更让人无从下手。
	 *
	 * @param {string} reason - 原因码。
	 * @returns {string} 那句话。
	 */
	function addressErrorText(reason) {
	  var key = ADDRESS_REASONS[reason];
	  var table = copy();
	  var sentence = key === undefined ? undefined : table[key];
	  return typeof sentence === 'string' ? sentence : table.addressScheme;
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
	 * `ctx.locale.bind(NS)` 出来的那个翻译函数（票 #20 B）。
	 *
	 * 标签标题的回落词住在**类型自己的字典**里（`DICTIONARIES` 的 `type.label`，与
	 * `apply()` 里注册给宿主的那句 `title()` 是同一个词），**不是**面板那份文案表 ——
	 * 后者是给那一格内部用的，里面没有 `type.label`。第一版把它读成了 `copy()['type.label']`，
	 * 于是回落拿到 `undefined`：页面标题读得到时看不出问题，读不到时标签就**空了**
	 * （`tests/toolbar-panel.spec.ts` 的 B 那一条抓到的就是这个）。
	 */
	var localeText = null
	
	/**
	 * 读不到页面标题时标签上写什么。
	 *
	 * @returns {string} 那个词（"浏览器" / "Browser"）。
	 */
	function tabTitleFallback() {
	  if (localeText !== null) return localeText('type.label')
	  var table = DICTIONARIES[language()]
	  return (table !== undefined ? table : DICTIONARIES.en)['type.label']
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
	 * @param {{url?: string, zoom?: number}} [extra] - 那两条带参数的动作的参数（票 #20）。
	 *   地址栏与档位菜单各用其中一个；别的动作一个都不带（宿主那边也只认这两个动作带参数）。
	 * @returns {Promise<{ok: boolean, url: string, zoom: unknown, canGoBack: boolean,
	 *   canGoForward: boolean, message: string}>} the host's answer, or a local failure value.
	 */
	async function callView(ctx, action, extra) {
	  try {
	    var payload = Object.assign({ nonce: String(Date.now()) }, extra !== undefined ? extra : {})
	    var answer = await ctx.connection.rpc.call(RPC_CHANNEL, endpointFor(action), payload)
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
	 * 页面标题那一份**共享读数**（票 #20 B）。
	 *
	 * ## 为什么是一份共享的东西
	 *
	 * 侧边栏那个标签（`sidebar.right.pane.tab.title` 座位）与面板工具条是**两个**组件：宿主分别
	 * 渲染它们，它们之间没有 props 通道。而它们要说的是同一件事 —— "这一格里现在是哪一页"。
	 * 所以读回来的那一份只有一个地方放（这个模块作用域的对象），两边都从它读：
	 * 工具条每次读回都往里写，标签订阅它。
	 *
	 * ## 为什么要有个心跳
	 *
	 * 标签要跟着页面走，而页面**不必**经过这个面板才会换（Agent 走的是另一条路：它直接驱动
	 * 同一个视图）。所以只要标签还在屏幕上，就每隔 {@link TITLE_WATCH_MS} 问一次"现在是什么标题"。
	 * 心跳**只在有标签订阅时**跑：没人看那个标签的时候，一次多余的读回都不发。
	 *
	 * 读回来的东西原样存着；拿不到就存空串，由 {@link DshViewToolbar.titleForTab} 回落到
	 * 标签类型自己的名字（"浏览器"）—— 回落发生在显示的那一刻，不是一个存下来的默认值。
	 */
	var pageTitle = {
	  /** 最近一次从视图读回来的标题；没读过就是空串。 */
	  value: '',
	  /** 订阅者（标签组件）。 */
	  listeners: [],
	  /** 心跳的定时器句柄；0 = 没在跑。 */
	  timer: 0,
	  /** 心跳要用的上下文（`apply` 时给的）。 */
	  ctx: null,
	}
	
	/** 标签每次问一次"现在标题是什么"的间隔。2 秒：跟得上换页，又不至于把宿主刷满。 */
	var TITLE_WATCH_MS = 2000
	
	/**
	 * 记下一次读回来的标题，并告诉所有订阅者。
	 *
	 * @param {unknown} title - 外壳读回来的标题。
	 * @returns {void}
	 */
	function rememberPageTitle(title) {
	  var next = typeof title === 'string' ? title : ''
	  if (next === pageTitle.value) return
	  pageTitle.value = next
	  for (var index = 0; index < pageTitle.listeners.length; index++) pageTitle.listeners[index](next)
	}
	
	/**
	 * 订阅标题的变化。
	 *
	 * @param {(title: string) => void} listener - 新标题来了叫它。
	 * @returns {() => void} 退订。
	 */
	function subscribePageTitle(listener) {
	  pageTitle.listeners.push(listener)
	  return function () {
	    var at = pageTitle.listeners.indexOf(listener)
	    if (at !== -1) pageTitle.listeners.splice(at, 1)
	  }
	}
	
	/** 有标签在看的时候才开心跳（见 {@link pageTitle} 的说明）。 */
	function startPageTitleWatch(ctx) {
	  pageTitle.ctx = ctx
	  if (pageTitle.timer !== 0) return
	  pageTitle.timer = setInterval(function () {
	    if (pageTitle.ctx === null) return
	    void callView(pageTitle.ctx, 'state').then(function (next) {
	      if (next.ok === true) rememberPageTitle(next.title)
	    })
	  }, TITLE_WATCH_MS)
	}
	
	/** 没有标签在看了：心跳停掉，一次多余的读回都不发。 */
	function stopPageTitleWatch() {
	  if (pageTitle.listeners.length > 0) return
	  if (pageTitle.timer !== 0) clearInterval(pageTitle.timer)
	  pageTitle.timer = 0
	  pageTitle.ctx = null
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
	    loading: undefined,
	    canGoBack: false,
	    canGoForward: false,
	    backTarget: undefined,
	    forwardTarget: undefined,
	    message: '',
	    busy: false,
	    /** 票 #20 F：面板刚请求了一次导航，还没听到回答 —— "加载中"的第一半。 */
	    navigating: false,
	  })
	  /**
	   * 输入框里那串字（票 #20 A）。
	   *
	   * 它与 `state.url` 是**两样东西**，而且必须分开：`state.url` 是"视图现在在哪"（读回来的
	   * 事实），这里是"框里显示着什么"。用户正在打字的时候，一次读回把他打的字冲掉是最讨厌的
	   * 那种 bug；而用户没在打字的时候，框里必须跟着页面走 —— 票面原话："跳转后框里的地址要
	   * 跟着页面走（读回来，不是自己记）"。
	   */
	  var [address, setAddress] = react.useState('')
	  /** 上一次提交被拒的那句话。空串 = 没有出错。 */
	  var [addressError, setAddressError] = react.useState('')
	  /** 档位菜单开着没有（票 #20 D）。它**必须自己会收**（票 #20b 的要求 2，见下面那个 effect）。 */
	  var [menuOpen, setMenuOpen] = react.useState(false)
	  /** 光标在地址栏里吗（决定读回要不要覆盖框里的字）。 */
	  var editing = react.useRef(false)
	  /**
	   * 工具条那一行本身（票 #20b 的要求 2）。
	   *
	   * 它只有一个用途：回答"这一下按在工具条**里面**还是**外面**"。菜单展开之后必须有办法自己收
	   * 回去，而"点到别处"要判的就是这件事 —— 没有这个引用就只能靠"再点一次那颗按钮"，那正是
	   * 用户遇到的那个"卡在展开状态"。
	   */
	  var toolbarRef = react.useRef(null)
	
	  /**
	   * 把一次回答落到面板上 —— **所有**读回都从这里进。
	   *
	   * 三件事必须一起做，散在各处就会有两处不一致：
	   *  1. 状态合并（失败的回答没有读回任何东西，不许把上一次读到的地址与缩放宽抹成空白）；
	   *  2. 页面标题进共享读数（票 #20 B 的标签要它）；
	   *  3. 地址栏跟着页面走（除非用户正在打字）。
	   *
	   * @param {object} next - 外壳答的那一份（或本地造的那份失败值）。
	   * @param {{keepAddress?: boolean, quiet?: boolean}} [options] - `keepAddress`：这一按被拒了，
	   *   框里留着用户打的字；`quiet`：这只是一次**顺手读回来的**（导航途中的轮询），
	   *   **不是**某一次动作的回答 —— 那么它不许解开那把按钮锁（见下面那段）。
	   */
	  var applyAnswer = react.useCallback(function (next, options) {
	    var settings = options !== undefined ? options : {}
	    var keep = settings.keepAddress === true
	    var quiet = settings.quiet === true
	    setState(function (previous) {
	      var merged = Object.assign({}, previous, next)
	      // 只有**动作的回答**才解开"忙"与"导航中"这两把锁。顺手读回来的那份读数解开它们，
	      // 就等于"导航还在飞的时候按钮又亮了" —— 那正是 `isEnabled` 里 `busy` 要挡的那种
	      // 两次动作叠在一起（票 #20 写 F 那条轮询时踩到的）。
	      if (quiet !== true) {
	        merged.busy = false
	        merged.navigating = false
	      }
	      if (next.ok === false && (next.url === '' || next.url === undefined)) {
	        // 一次失败的调用**没有读回任何东西**："读不到"不等于"地址是空的、缩放是未知的"。
	        merged.url = previous.url
	        merged.zoom = previous.zoom
	        merged.loading = previous.loading
	        merged.backTarget = previous.backTarget
	        merged.forwardTarget = previous.forwardTarget
	      }
	      return merged
	    })
	    rememberPageTitle(next.title)
	    // 一次**成功**的读回把上一次"地址被拒"那句话收掉：那句话说的是那一按，不是永久状态。
	    if (next.ok === true) setAddressError('')
	    if (keep !== true && editing.current !== true && typeof next.url === 'string' && next.url !== '') {
	      setAddress(next.url)
	    }
	  }, [])
	
	  /**
	   * 读一次"外壳现在说什么"，并把结果落到那一行上。
	   *
	   * @param {{quiet?: boolean}} [options] - `quiet` 见 {@link applyAnswer}（导航途中的轮询用它）。
	   */
	  var refresh = react.useCallback(function (options) {
	    var settings = options !== undefined ? options : {}
	    void callView(props.ctx, 'state').then(function (next) {
	      applyAnswer(next, { quiet: settings.quiet === true })
	    })
	  }, [])
	
	  /**
	   * Run one action, then show what the host read back **after** it.
	   *
	   * The read-back is the point: the host answers with the post-action state, so the zoom
	   * label and the two history buttons come from the view rather than from a local guess
	   * that could drift the moment anything else drives the view (the agent does).
	   *
	   * @param {string} action - 动作名。
	   * @param {{payload?: object, navigating?: boolean, keepAddress?: boolean}} [options]
	   *   `payload` 是那两条带参数的动作的参数；`navigating` = 这是一次导航（面板要显示"加载中"）；
	   *   `keepAddress` = 这一按被拒时框里留着用户打的字。
	   */
	  var run = react.useCallback(function (action, options) {
	    var settings = options !== undefined ? options : {}
	    setState(function (previous) {
	      return Object.assign({}, previous, { busy: true, navigating: settings.navigating === true })
	    })
	    void callView(props.ctx, action, settings.payload).then(function (next) {
	      applyAnswer(next, { keepAddress: settings.keepAddress === true })
	    })
	  }, [])
	
	  /**
	   * 地址栏回车（票 #20 A）。
	   *
	   * **规范化在提交的那一刻做，不在打字的时候做**：一边打字一边往框里补 `https://` 会让人
	   * 没法输入（补上去的那几个字符会跟着光标跑）。规则本身是纯判断，住在 `src/toolbar.js`；
	   * 这里只负责把它的拒绝显示出来。
	   */
	  var submitAddress = react.useCallback(function () {
	    var parsed = toolbar.parseAddress(address)
	    if (parsed.ok !== true) {
	      setAddressError(addressErrorText(parsed.reason))
	      return
	    }
	    setAddressError('')
	    setAddress(parsed.url)
	    run('navigate', { payload: { url: parsed.url }, navigating: true, keepAddress: true })
	  }, [address])
	
	  // The first read happens once the strip is on screen. It is deliberately not part of a
	  // render: a render that started a request would start one per re-render.
	  react.useEffect(function () {
	    refresh()
	  }, [])
	
	  /**
	   * 导航在飞的时候，隔一会儿问一次"那一页自己说它还在加载吗"（票 #20 F 的第一条）。
	   *
	   * 为什么不能只靠"请求还没回来"：那说的是**面板**在等，不是**页面**在加载。而页面自己
	   * 会用 `document.readyState` 回答这件事（宿主那次读回里带着 `loading`）。所以这里一边等
	   * 回答、一边把页面自己的读数刷新过来 —— 提示说的因此是页面的事实，不是面板的心情。
	   *
	   * 间隔与 {@link PANEL_REFRESH_MIN_MS} 同源：既不把宿主刷满，又跟得上一次换页。
	   */
	  react.useEffect(
	    function () {
	      if (state.navigating !== true) return undefined
	      var timer = setInterval(function () {
	        // `quiet`：这一读**不解锁**（见 `applyAnswer`）—— 导航还在飞的时候按钮必须一直是灰的。
	        refresh({ quiet: true })
	      }, PANEL_REFRESH_MIN_MS)
	      return function () {
	        clearInterval(timer)
	      }
	    },
	    [state.navigating],
	  )
	
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
	
	  /**
	   * 档位菜单**展开之后自己会收**（票 #20b 的要求 2）。
	   *
	   * ## 为什么这一条是必须的，而不是"顺手加一下"
	   *
	   * 真机上量到过：用户那一格工具条高 **61px = 34 + 26**，第二行就是那排档位 —— 代码里
	   * `menuOpen` 的初值是 `false`，所以问题不在"默认展开"，而在**展开之后不收**：点别处不收、
	   * `Esc` 不收，菜单于是一直挂在那里，工具条永远是两行。用户的抱怨原文是"不用去把上面的聊天栏
	   * 弄乱了"，而"弄乱"的机制正是这多出来的一行 —— 它把被测量的那一块往下推，原生画面跟着让位。
	   *
	   * ## 三条收法，各自走一条**道理上不同**的路
	   *
	   *  - **选了一个档位**：那颗档位按钮自己的 `onClick` 就收了（它紧接着要发一条 zoom-to）；
	   *  - **点到工具条以外**：`pointerdown`（捕获阶段）。用捕获而不是冒泡，是因为"点别处"这件事
	   *    不该取决于那一页上有没有人 `stopPropagation`；判据是"落点不在 {@link toolbarRef} 里"。
	   *    **量出来的一个边界**：原生画面是另一块 `WebContentsView`，点在它上面的那一下**到不了**
	   *    这个页面（见报告里的诚实清单）—— 所以这里收的是"点 DSH 界面别处"，不是"点网页里"。
	   *  - **`Esc`**：与真浏览器的菜单同一条习惯。它同时 `preventDefault` + `stopPropagation`：
	   *    一次按键只该有一个效果，而菜单开着的时候，用户的意思显然是"把菜单收掉"。
	   *
	   * 两个听众**只在开着的时候挂着**（`[menuOpen]` 的依赖就是这件事），关着的时候页面上一个多余
	   * 的监听器都没有 —— 这个面板住在 DSH 的窗口里，它不该替整窗口的每一次点击接手。
	   */
	  react.useEffect(
	    function () {
	      if (menuOpen !== true) return undefined
	      function onPointerDown(event) {
	        var root = toolbarRef.current
	        var target = event.target
	        if (root !== null && root !== undefined && target !== null && target !== undefined && root.contains(target)) return
	        setMenuOpen(false)
	      }
	      function onKeyDown(event) {
	        if (event.key !== 'Escape') return
	        event.preventDefault()
	        event.stopPropagation()
	        setMenuOpen(false)
	      }
	      document.addEventListener('pointerdown', onPointerDown, true)
	      document.addEventListener('keydown', onKeyDown, true)
	      return function () {
	        document.removeEventListener('pointerdown', onPointerDown, true)
	        document.removeEventListener('keydown', onKeyDown, true)
	      }
	    },
	    [menuOpen],
	  )
	
	  var words = copy()
	  var children = []
	  for (var index = 0; index < toolbar.BUTTONS.length; index++) {
	    var button = toolbar.BUTTONS[index]
	    var enabled = toolbar.isEnabled(button.action, {
	      canGoBack: state.canGoBack,
	      canGoForward: state.canGoForward,
	      busy: state.busy,
	      hasShell: props.hasShell,
	    })
	    // 票 #20 F 的第二条：悬停在后退/前进上要能看出"会退到哪一页"。
	    // 目标来自**引擎自己的导航历史**（宿主那次读回里的 `backTarget` / `forwardTarget`），
	    // 读不到时 `travelHint` 返回 undefined ⇒ tooltip 退回按钮自己那个词（"back"），
	    // 而不是给一个空 tooltip 假装知道。
	    var travel =
	      button.action === 'back'
	        ? toolbar.travelHint(state.backTarget, words.backTo)
	        : button.action === 'forward'
	          ? toolbar.travelHint(state.forwardTarget, words.forwardTo)
	          : undefined
	    children.push(
	      react.createElement(
	        'button',
	        {
	          key: button.action,
	          type: 'button',
	          'data-dsh-view-action': button.action,
	          title: travel !== undefined ? travel : button.title,
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
	            flex: '0 0 auto',
	          },
	        },
	        button.label,
	      ),
	    )
	  }
	
	  /**
	   * 地址栏（票 #20 A）。
	   *
	   * 它在**面板里**（不在被驱动的那一页），所以它不可能进快照 —— `tests/panel-toolbar.spec.ts`
	   * 有一条"工具条存在时视图快照逐项不变"的断言从视图那一侧读回这件事。而它驱动视图走的仍然是
	   * **既有的那条 RPC**（`desktop-view-navigate`），`shell/preload.js` 那条"除矩形外什么都不许
	   * 过境"的边界一个字节都没动：这条输入框够不到 Electron，也够不到视图。
	   */
	  var addressField = react.createElement('input', {
	    key: 'address',
	    type: 'text',
	    'data-dsh-view-address': 'ready',
	    value: address,
	    placeholder: words.addressPlaceholder,
	    title: words.addressHelp,
	    spellCheck: false,
	    autoComplete: 'off',
	    disabled: props.hasShell !== true,
	    onInput: function (event) {
	      setAddress(event.target.value)
	      setAddressError('')
	    },
	    onFocus: function () {
	      editing.current = true
	    },
	    onBlur: function () {
	      editing.current = false
	      // 松手之后框里回到"页面现在在哪"（用户打了一半又走开时，框里不该留着一段没人要的字）。
	      setAddress(state.url)
	      setAddressError('')
	    },
	    onKeyDown: function (event) {
	      if (event.key !== 'Enter') return
	      event.preventDefault()
	      submitAddress()
	    },
	    style: {
	      flex: '1 1 60px',
	      minWidth: '60px',
	      height: '22px',
	      padding: '0 6px',
	      boxSizing: 'border-box',
	      font: '12px/1 system-ui',
	      border: '1px solid ' + (addressError === '' ? 'var(--dsh-color-border, #d0d7de)' : 'var(--dsh-color-danger, #b42318)'),
	      borderRadius: '4px',
	      background: 'var(--dsh-color-surface, #fff)',
	      color: 'inherit',
	      textOverflow: 'ellipsis',
	    },
	  })
	
	  // 票 #19 + #20 C + #20b：读数只留用户要的那一个数（**百分比**），必要时加"加载中"（F）与
	  // "为什么这一按没成"。宿主那些诊断话术一个字都没删 —— 它们在同一次渲染的
	  // `data-dsh-view-diagnostic` 与 tooltip 上（另一个通道，仍然读得到）。
	  //
	  // 票 #20b 删掉了这里的两个词（`auto` / `manual`）：适配永远开着，"谁在管这个缩放"不再是一个
	  // 会变的事实，前缀只会是一句废话。外壳**仍然在发布** `zoomMode`（旧插件在读它），
	  // 但面板这一侧连读都不读它了 —— 它甚至不进 `state`（见上面那份初值）。
	  var readingState = Object.assign({}, state, { message: addressError !== '' ? addressError : state.message })
	  if (addressError !== '') readingState.ok = false
	  var reading = toolbar.readingText(readingState, { loading: words.loading })
	  var diagnostic = toolbar.diagnosticText(readingState)
	
	  // 票 #20 D：那颗百分比是一颗**菜单按钮**。菜单展开时工具条长高一行（于是被测量的那一块
	  // 自动变矮，外壳跟着把原生画面摆到新的矩形上）—— 不用浮层，因为浮层会被原生画面盖住。
	  var currentPreset = toolbar.currentPreset(state.zoom)
	  var presetItems = []
	  for (var presetIndex = 0; presetIndex < toolbar.ZOOM_PRESETS.length; presetIndex++) {
	    var percent = toolbar.ZOOM_PRESETS[presetIndex]
	    presetItems.push(
	      react.createElement(
	        'button',
	        {
	          key: 'preset-' + String(percent),
	          type: 'button',
	          'data-dsh-view-zoom-preset': String(percent),
	          'data-dsh-view-zoom-current': percent === currentPreset ? 'yes' : 'no',
	          disabled: state.busy === true || props.hasShell !== true,
	          onClick: (function (value) {
	            return function () {
	              setMenuOpen(false)
	              run('zoom-to', { payload: { zoom: value / 100 } })
	            }
	          })(percent),
	          style: {
	            font: '11px/1 system-ui',
	            minWidth: '40px',
	            height: '20px',
	            padding: '0 4px',
	            border: '1px solid ' + (percent === currentPreset ? 'var(--dsh-color-accent, #0969da)' : 'var(--dsh-color-border, #d0d7de)'),
	            borderRadius: '4px',
	            background: 'var(--dsh-color-surface, #fff)',
	            color: 'inherit',
	            cursor: 'pointer',
	            flex: '0 0 auto',
	          },
	        },
	        String(percent) + '%',
	      ),
	    )
	  }
	
	  /**
	   * 那行读数：**一个**控件，既是读数也是档位菜单的开关（票 #20b 的要求 3）。
	   *
	   * 票 #20 D 的代码在这里渲染了**两遍**同一句话：一颗 `<button data-dsh-view-zoom-menu>` 与一个
	   * `<span data-dsh-view-zoom data-dsh-view-reading>`，两个的孩子都是 `reading`。真机上量到的
	   * 就是它（用户附的证据，本轮又原样量了一遍）：
	   *
	   * ```
	   * BUTTON[data-dsh-view-zoom-menu=closed]                         → "自动 100%"
	   * SPAN  [data-dsh-view-zoom][data-dsh-view-reading][…diagnostic] → "自动 100%"
	   * ```
	   *
	   * 用户的原话是"同一个信息渲染了两遍……一个带框、旁边又一个"，而票面把这一条定成了验收：
	   * 那句话**只许出现一次**，并且要能**数**出来（必须是 1）。
	   *
	   * 所以这两个元素**合成一个 `<button>`**：它显示那句话，点它就是展开/收起档位（真浏览器也是
	   * 点百分比选档位），而诊断话术仍旧只挂在它的 `title` 与 `data-dsh-view-diagnostic` 上
	   * （票 #20 C 那条规矩一个字没改）。合成而不是"再放一颗 ▾ 按钮"，是因为代码里那段注释本来
	   * 写的就是这个意思 —— *"菜单关着时它既是读数也是菜单按钮"* —— 而实现多画了一个元素。
	   *
	   * `aria-label` 上是"点它能做什么"（文案表里那个词）。它**不是** `title`：`title` 的位置
	   * 让给诊断了，而一个只有一句话的按钮不该因为"那句话是诊断"就没有名字。
	   */
	  var zoomControl = react.createElement(
	    'button',
	    {
	      key: 'zoom-menu',
	      type: 'button',
	      'data-dsh-view-zoom-menu': menuOpen ? 'open' : 'closed',
	      // `zoomLabel` 自己就把"读不到"渲染成 `—`（票 #19 的规矩），所以这里不再判一次。
	      'data-dsh-view-zoom': toolbar.zoomLabel(state.zoom),
	      'data-dsh-view-reading': reading,
	      'data-dsh-view-diagnostic': diagnostic,
	      'aria-label': words.zoomMenuTitle,
	      title: diagnostic,
	      disabled: props.hasShell !== true,
	      onClick: function () {
	        setMenuOpen(function (open) {
	          return open !== true
	        })
	      },
	      style: {
	        font: '11px/1.3 system-ui',
	        height: '22px',
	        padding: '0 6px',
	        border: '1px solid var(--dsh-color-border, #d0d7de)',
	        borderRadius: '4px',
	        background: 'var(--dsh-color-surface, #fff)',
	        whiteSpace: 'nowrap',
	        overflow: 'hidden',
	        textOverflow: 'ellipsis',
	        flex: '0 1 auto',
	        cursor: 'pointer',
	        opacity: state.ok === false || addressError !== '' ? 1 : 0.75,
	        color: state.ok === false || addressError !== '' ? 'var(--dsh-color-danger, #b42318)' : 'inherit',
	      },
	    },
	    reading,
	  )
	
	  // 行一：导航按钮 + 地址栏 + 那颗读数/菜单按钮。行二（只在菜单展开时存在）：那一排标准档位。
	  var row = react.createElement(
	    'div',
	    {
	      style: {
	        display: 'flex',
	        alignItems: 'center',
	        gap: '4px',
	        width: '100%',
	        height: toolbar.TOOLBAR_HEIGHT_PX + 'px',
	        flex: '0 0 auto',
	      },
	    },
	    children,
	    addressField,
	    zoomControl,
	  )
	
	  var rows = [row]
	  if (menuOpen) {
	    rows.push(
	      react.createElement(
	        'div',
	        {
	          'data-dsh-view-zoom-presets': 'open',
	          style: {
	            display: 'flex',
	            flexWrap: 'wrap',
	            alignItems: 'center',
	            gap: '4px',
	            width: '100%',
	            padding: '2px 0 4px',
	            flex: '0 0 auto',
	          },
	        },
	        presetItems,
	      ),
	    )
	  }
	
	  return react.createElement(
	    'div',
	    {
	      'data-dsh-view-toolbar': 'ready',
	      // 票 #20b 的要求 2 靠这一个引用判"点在工具条里面还是外面"（见上面那个 effect）。
	      ref: toolbarRef,
	      style: {
	        // 菜单展开时长高一行（`height: auto` 让内容决定），于是被测量的那一块自动变矮 ——
	        // 原生画面跟着让出那一行，菜单因此**不会**被它盖住（浮层一定会）。
	        //
	        // 票 #20b 的要求 2：**空闲时严格一行**。这一句本来就是对的（关着就是那个常量），
	        // 出问题的是"关不上" —— 展开之后点别处/按 Esc 都不收，于是一行变成常驻的两行。
	        // 那三条收法在 `menuOpen` 那个 effect 里；`tests/toolbar-panel.spec.ts` 与
	        // `tests/panel-toolbar-placement.spec.ts` 都**读回几何**（工具条高度、面板矩形上边缘）
	        // 来钉它，不读 `menuOpen` 这个状态变量本身。
	        height: menuOpen ? 'auto' : toolbar.TOOLBAR_HEIGHT_PX + 'px',
	        minHeight: toolbar.TOOLBAR_HEIGHT_PX + 'px',
	        display: 'flex',
	        flexDirection: 'column',
	        alignItems: 'stretch',
	        padding: '0 6px',
	        boxSizing: 'border-box',
	        borderBottom: '1px solid var(--dsh-color-border, #d0d7de)',
	        background: 'var(--dsh-color-surface, #fff)',
	        color: 'var(--dsh-color-text, #1f2328)',
	        flex: '0 0 auto',
	      },
	    },
	    rows,
	  )
	}
	
	/**
	 * 侧边栏那个标签上的字（票 #20 B）。
	 *
	 * 它注册在 `sidebar.right.pane.tab.title` 座位上（key = 本插件的 `id`），于是**取代**宿主在
	 * 开标签时抓到的那句 `title(address)` —— 那句话是**开标签那一刻**的，永远不会变，而这里要的是
	 * "这一格现在装的是哪一页"。
	 *
	 * 它读的是 {@link pageTitle} 那份共享读数（工具条每次读回都往里写），并在这段时间里开着心跳
	 * （见 {@link startPageTitleWatch}）—— 因为换页不必经过这个面板（Agent 直接驱动那个视图）。
	 *
	 * 读不到就回落到"浏览器"（{@link DshViewToolbar.titleForTab}）：一个空标签比一个说得不准的
	 * 名字更坏，因为空标签让人看不出那一格里是什么。
	 *
	 * @returns {string} 标签上那串字。
	 */
	function TabTitle() {
	  var react = require('react')
	  var [title, setTitle] = react.useState(pageTitle.value)
	  react.useEffect(function () {
	    var unsubscribe = subscribePageTitle(setTitle)
	    startPageTitleWatch(clientContext)
	    // 挂上来的这一刻先读一次：标签可能比工具条先出现（比如切到别的标签之后再展开侧边栏）。
	    if (pageTitle.value === '' && clientContext !== null) {
	      void callView(clientContext, 'state').then(function (next) {
	        if (next.ok === true) rememberPageTitle(next.title)
	      })
	    }
	    return function () {
	      unsubscribe()
	      stopPageTitleWatch()
	    }
	  }, [])
	  return DshViewToolbar.titleForTab(title, tabTitleFallback())
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
	  // 标签标题的回落词也从这里出（同一个词，同一份字典）：见 `localeText` 的说明。
	  localeText = t
	
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
	
	  // Stage three（票 #20 B）：标签上那串字。
	  //
	  // 这一个座位是**为"会变的标题"存在的**，而且这不是猜的：宿主的类型声明把它写成了
	  // 一句话 —— *"A tab's title as its chip shows it… A type with a live title — a terminal
	  // named after its shell, a chat after its first line — registers here and reads its own
	  // store; one without registers nothing and the chip shows the registry's `title(address)`
	  // text captured at open time."*（`dsh-client-ui-sidebar-right/lib/types/client/contract/
	  // slots.d.ts` 的 `sidebar.right.pane.tab.title`）。产品自己那个 Files 插件就是这么做的
	  // （`dsh-client-ui-sidebar-files/lib/client.js` 的 FilesTitle）。
	  //
	  // 所以我们**不需要**任何"改标签标题"的运行时 API：座位本身就是那条路。
	  ctx.effect(function () {
	    return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
	      return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, TabTitle)
	    })
	  }, 'desktop-view: tab title')
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
