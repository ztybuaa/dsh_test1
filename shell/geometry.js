'use strict'

/**
 * Where the native view goes.
 *
 * Two rules live here, and both exist because the view is drawn *by the shell*
 * while its rectangle is decided *by the panel* — two processes that can disagree:
 *
 *   1. A rectangle is intersected with the window. The panel measures itself in
 *      page coordinates and the page fills the window's content area, so the two
 *      spaces coincide; but a panel can still report a rectangle that reaches past
 *      the window (a mid-drag layout, a stale measurement, a window shrunk under
 *      it). A native view is not clipped by the page, so an unclamped rectangle
 *      would paint a browser over the window frame and outside the screen.
 *   2. A rectangle with no area left after clamping is not a rectangle. `setBounds`
 *      with a zero side throws on some Electron builds and draws a hairline on
 *      others; and, more to the point, "there is no room" and "there is no panel"
 *      must reach the same place: the view is hidden.
 */

/**
 * @typedef {{x: number, y: number, width: number, height: number}} Rect
 */

/** Below this, a clamped rectangle is treated as "no room" rather than a sliver. */
const MIN_SIDE_PX = 1

/**
 * Clamp a rectangle to the window's content area.
 *
 * @param {Rect} rect - the requested rectangle, in window content coordinates.
 * @param {{width: number, height: number}} windowSize - the window's content size.
 * @returns {{rect: Rect | null, clamped: boolean, reason?: string}} the placeable rectangle, or null.
 */
function clampRect(rect, windowSize) {
  const width = Number(windowSize?.width)
  const height = Number(windowSize?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    return { rect: null, clamped: false, reason: 'window-size-unknown' }
  }
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(width, rect.x + rect.width)
  const bottom = Math.min(height, rect.y + rect.height)
  const clampedWidth = right - left
  const clampedHeight = bottom - top
  const clamped = left !== rect.x || top !== rect.y || clampedWidth !== rect.width || clampedHeight !== rect.height
  if (clampedWidth < MIN_SIDE_PX || clampedHeight < MIN_SIDE_PX) {
    return { rect: null, clamped, reason: 'no-room-in-window' }
  }
  return { rect: { x: left, y: top, width: clampedWidth, height: clampedHeight }, clamped }
}

/**
 * Decide what the view should be, given the panel's latest report and the window.
 *
 * @param {{reported: Rect | null, reason: string, windowSize: {width: number, height: number}}} state - current inputs.
 * @returns {{visible: boolean, bounds: Rect | null, clamped: boolean, reason: string}} the placement.
 */
function placement(state) {
  const reported = state.reported
  if (reported === null) {
    // "The panel reports no rectangle" covers collapsed, switched-away, floated out
    // of the window, and not-yet-measured. All of them mean: do not draw the view.
    return { visible: false, bounds: null, clamped: false, reason: state.reason }
  }
  const clamped = clampRect(reported, state.windowSize)
  if (clamped.rect === null) {
    return { visible: false, bounds: null, clamped: clamped.clamped, reason: clamped.reason ?? 'unplaceable' }
  }
  return { visible: true, bounds: clamped.rect, clamped: clamped.clamped, reason: 'reported' }
}

/**
 * Whether a reported rectangle is structurally usable.
 *
 * The preload already rejects garbage, but the shell re-checks: it is the party that
 * hands numbers to `setBounds`, and it must not depend on the page's good behaviour.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for a finite `{x,y,width,height}`.
 */
function isUsableRect(value) {
  if (value === null || typeof value !== 'object') return false
  const rect = /** @type {Record<string, unknown>} */ (value)
  for (const field of ['x', 'y', 'width', 'height']) {
    if (typeof rect[field] !== 'number' || !Number.isFinite(rect[field])) return false
  }
  return true
}

module.exports = { MIN_SIDE_PX, clampRect, isUsableRect, placement }
