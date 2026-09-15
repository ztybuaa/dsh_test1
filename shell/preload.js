'use strict'

/*
 * The rectangle channel, page side.
 *
 * The shell (Electron) and DSH are two processes: the plugin's server half runs in
 * the `dsh` node process, and the panel — the part that knows where the view
 * belongs — runs as a page *inside the shell's window*. The smallest honest bridge
 * between them is a contextBridge global on that page.
 *
 * It carries one message: "the panel occupies this rectangle" or "the panel
 * occupies nothing". Nothing else crosses here — no navigation, no identity, no
 * commands. Driving the view stays with the plugin, over CDP (ADR-0002/0003).
 *
 * It is created for the window only. The native view's own page must NOT get it:
 * `setRect` re-enters the shell and re-places that very view, so exposing it to
 * arbitrary websites would let a page move its own frame.
 */

const { contextBridge, ipcRenderer } = require('electron')

/** Channel the shell listens on for rectangle reports. */
const RECT_CHANNEL = 'dsh-desktop-view:set-rect'

/** Above this, a number is not a CSS pixel count but a broken measurement. */
const MAX_COORDINATE = 1e6

/**
 * Decide whether a value is a usable rectangle.
 *
 * A non-finite or absurd coordinate would make `view.setBounds` throw or place the
 * view off-screen; rejecting here keeps the shell's own validation from being the
 * only line of defence.
 *
 * @param {unknown} value - the candidate.
 * @returns {boolean} true when it is a finite, in-range `{x,y,width,height}`.
 */
function isUsableRect(value) {
  if (value === null || typeof value !== 'object') return false
  const rect = /** @type {Record<string, unknown>} */ (value)
  for (const field of ['x', 'y', 'width', 'height']) {
    const number = rect[field]
    if (typeof number !== 'number' || !Number.isFinite(number)) return false
    if (number < -MAX_COORDINATE || number > MAX_COORDINATE) return false
  }
  return true
}

/**
 * Report the panel's rectangle to the shell.
 *
 * @param {{x: number, y: number, width: number, height: number} | null} rect - the rectangle, or null for "none".
 * @returns {void}
 */
function setRect(rect) {
  if (rect === null) {
    ipcRenderer.send(RECT_CHANNEL, null)
    return
  }
  if (!isUsableRect(rect)) {
    // Reporting garbage is a bug in the panel, not a reason to move the view to a
    // nonsense place; the shell would clamp it anyway and the user would see the
    // browser jump somewhere unrelated to the sidebar.
    throw new TypeError(`setRect expects {x,y,width,height} of finite numbers or null, got: ${JSON.stringify(rect)}`)
  }
  ipcRenderer.send(RECT_CHANNEL, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

contextBridge.exposeInMainWorld('__dshDesktopView', {
  /** Version of this channel, so a panel can refuse to talk to an older shell. */
  channel: 1,
  setRect,
})
