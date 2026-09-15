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
