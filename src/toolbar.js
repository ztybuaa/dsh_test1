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
    statusText: statusText,
    actionForKey: actionForKey,
  }
})
