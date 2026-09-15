// GENERATED FILE — do not edit.
//
// Built by `node scripts/build-client.mjs` from:
//   shell/panel-rect.js  (panel measurement, shared with the shell's fixture panel)
//   src/client-body.js   (tab type, tab body, panel component)
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
		    var frame = 0

		    /**
		     * Measure and report, unless nothing changed.
		     * @param {boolean} [force] - report even when unchanged.
		     * @returns {void}
		     */
		    function report(force) {
		      if (stopped) return
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

		    var element = options.element
		    if (typeof hostGlobal.ResizeObserver === 'function') {
		      observer = new hostGlobal.ResizeObserver(function () {
		        report(false)
		      })
		      if (element !== null && element !== undefined) observer.observe(element)
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
		        if (frame !== 0 && typeof hostGlobal.cancelAnimationFrame === 'function') hostGlobal.cancelAnimationFrame(frame)
		        frame = 0
		      },
		      last: function () {
		        return last
		      },
		    }
		  }

		  /**
		   * The message a panel shows when the rectangle channel is absent.
		   *
		   * The panel is a browser slot; without the shell there is no browser to put in it.
		   * Saying so is the whole point: a silently empty pane looks like a broken plugin.
		   */
		  var NO_SHELL_MESSAGE =
		    'This pane needs the desktop shell to show the browser. ' +
		    'It is empty in a plain browser tab: run the shell, which hosts the native view.'

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
		   * rectangle channel exists). The panel uses it to choose between reporting and
		   * showing {@link NO_SHELL_MESSAGE}.
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
		    NO_SHELL_MESSAGE: NO_SHELL_MESSAGE,
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

	/** Panel copy, also in both languages. Not part of the locale namespace: the panel must render before it can translate. */
	var COPY = {
	  zh: {
	    noShell: '这一格需要桌面外壳才能显示浏览器。在普通浏览器标签页里它是空的。',
	    ready: '桌面外壳已就位：这一格交给原生浏览器视图。',
	    missing: '这一格没有量到矩形（可能被折叠或切走了）。',
	  },
	  en: {
	    noShell:
	      'This pane needs the desktop shell to show the browser. It is empty in a plain browser tab.',
	    ready: 'The desktop shell is here: the native browser view takes this pane.',
	    missing: 'This pane reports no rectangle (collapsed or switched away).',
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
	  var hostRef = react.useRef(null)
	  var [report, setReport] = react.useState({ rect: null, state: 'detached' })

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

	  elementRef.current = hostRef.current

	  var caption = !hasShell
	    ? copy().noShell
	    : report.rect === null
	      ? copy().missing
	      : copy().ready

	  return react.createElement(
	    'div',
	    {
	      // The panel fills its slot exactly: the shell measures this element, and any
	      // inset here would leave a strip of the pane the view does not cover.
	      ref: hostRef,
	      'data-dsh-desktop-view-panel': report.state,
	      style: {
	        position: 'relative',
	        width: '100%',
	        height: '100%',
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
	  )
	}

	/**
	 * Register this plugin's client half.
	 *
	 * @param {object} ctx - client root context; `slots`, `locale`, and `sidebarRightTabs` are read from it.
	 * @returns {void}
	 */
	function apply(ctx) {
	  var t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : function () { return 'Browser' }

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
	exports.inject = ['slots', 'locale', 'sidebarRightTabs']
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
