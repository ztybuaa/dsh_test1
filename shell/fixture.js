'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/**
 * Built-in fixture site. It exists so the shell and the seam tests are
 * self-sufficient: no user DSH install, no public network, no external site.
 *
 * `/panel` is the T2 stand-in for the DSH right sidebar slot. It is not a mock of
 * the panel's *logic*: it loads the real `shell/panel-rect.js` and reports through
 * the real `window.__dshDesktopView` global the preload injects, so the automated
 * evidence covers the production measurement path.
 *
 * Bound to loopback on an OS-chosen port.
 */

/** @param {string} title - document title and heading. @param {string} body - extra markup. */
function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:14px system-ui;padding:12px">
<h1 id="heading">${title}</h1>
${body}
</body></html>`
}

/** Click target shared by every interactive fixture page. */
function button(tag) {
  return `<button id="hit" onclick="document.getElementById('out').textContent='clicked-${tag}'">hit me</button>
<output id="out">initial-${tag}</output>`
}

/** The real measurement module, served verbatim so the shell has one implementation. */
const PANEL_RECT_JS = fs.readFileSync(path.join(__dirname, 'panel-rect.js'), 'utf8')

/**
 * The sidebar-slot stand-in.
 *
 * The panel is laid out where the real DSH right sidebar lives (right edge, full
 * height, 440px wide) so its rectangle looks like the rectangle the shell will get
 * in production. The controls exist so a human can drive the T2 acceptance
 * checklist by hand, and so a test can move the panel without guessing at DSH's
 * internal layout classes.
 *
 * `resize` is not decoration: changing the panel's size is exactly the "drag the
 * splitter" case, and the panel must report the new rectangle by itself, with no
 * help from the shell.
 */
const PANEL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>panel-page</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { font: 13px system-ui; }
  #page { position: fixed; inset: 0 0 0 0; padding: 12px; box-sizing: border-box; }
  #panel { position: fixed; top: 0; right: 0; width: 440px; height: 100%; box-sizing: border-box;
           background: #eef3f8; border-left: 2px solid #4a6fa5; padding: 8px; }
  #panel[data-size="small"] { width: 320px; height: 260px; top: auto; bottom: 0; }
  #panel[data-size="tiny"] { width: 120px; height: 90px; top: auto; bottom: 0; }
  #panel[data-hidden="display"] { display: none; }
  #panel[data-hidden="visibility"] { visibility: hidden; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  #report { font-family: ui-monospace, monospace; white-space: pre-wrap; font-size: 11px; }
</style></head>
<body>
<div id="page">
  <h1 id="heading" style="font-size:16px">panel-page</h1>
  <p>Stand-in for the DSH right sidebar slot. The blue column on the right is the
  "browser slot"; the native view should sit exactly on top of it.</p>
  <div class="controls">
    <button id="size-default" data-size="default">440xfull</button>
    <button id="size-small" data-size="small">320x260</button>
    <button id="size-tiny" data-size="tiny">120x90</button>
    <button id="hide-display" data-hide="display">display:none</button>
    <button id="hide-visibility" data-hide="visibility">visibility:hidden</button>
    <button id="show" data-hide="">show</button>
  </div>
  <div id="report">panel report: (nothing yet)</div>
</div>
<div id="panel" data-size="default">
  <strong>browser slot</strong>
  <p style="font-size:11px">A real browser view belongs here.</p>
</div>
<script src="/panel-rect.js"></script>
<script>
(function () {
  var panel = document.getElementById('panel')
  var report = document.getElementById('report')
  var host = document.getElementById('page')

  // Fixture-only observability: the same reports that go to the shell stay on the
  // page, so a test (and a human) can see what the panel decided and why.
  window.__panelReports = []
  window.__panelObserver = window.DshPanelRect.observe({
    element: panel,
    onReport: function (rect, state) {
      window.__panelReports.push({ rect: rect, state: state })
      report.textContent = 'panel report: ' + JSON.stringify({ rect: rect, state: state }) +
        '\\nhaveShell: ' + window.DshPanelRect.hasShell() +
        '\\ndelivered: ' + JSON.stringify(window.DshPanelRect.deliver(rect))
    },
  })
  if (window.__panelObserver.last().state === 'detached') {
    report.textContent = 'panel report: the panel element was not found'
  }

  for (var i = 0; i < host.querySelectorAll('button[data-size]').length; i++) {
    var button = host.querySelectorAll('button[data-size]')[i]
    button.addEventListener('click', function (event) {
      panel.setAttribute('data-size', event.currentTarget.getAttribute('data-size'))
    })
  }
  for (var j = 0; j < host.querySelectorAll('button[data-hide]').length; j++) {
    var hideButton = host.querySelectorAll('button[data-hide]')[j]
    hideButton.addEventListener('click', function (event) {
      var mode = event.currentTarget.getAttribute('data-hide')
      if (mode === '') panel.removeAttribute('data-hidden')
      else panel.setAttribute('data-hidden', mode)
    })
  }
})()
</script>
</body></html>`

/**
 * The snapshot probe page (T3).
 *
 * Every control is positioned and sized explicitly so a test can compare the
 * snapshot's bounds against the page's own geometry *exactly*, with no tolerance to
 * hide a rounding or offset mistake. `#snap-beta` is deliberately fractional (100.5 x
 * 21.25): reporting the raw layout rectangle is a decision, and this is the element
 * that fails if someone quietly rounds it.
 *
 * The page also carries the three "must not appear" cases — `display:none`, a
 * `visibility:hidden` box, and a zero-sized button (no render box at all) — and one
 * control below the fold, because "bounds let you tell whether it is in the viewport"
 * is only meaningful if something is outside it.
 *
 * Names are unique per control on purpose: a test can map a snapshot element back to
 * the fixture control it came from by name alone, without re-implementing the
 * snapshot's selector or trusting document order.
 */
const SNAPSHOT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>snapshot-page</title>
<style>
  html, body { margin: 0; }
  body { font: 14px system-ui; }
  .probe { position: absolute; }
  #snap-alpha { left: 40px; top: 30px; width: 120px; height: 40px; }
  #snap-beta { left: 40px; top: 90px; width: 100.5px; height: 21.25px; }
  #snap-checked { left: 260px; top: 30px; width: 150px; height: 40px; }
  #snap-expanded { left: 260px; top: 90px; width: 150px; height: 40px; }
  #snap-disabled { left: 260px; top: 150px; width: 150px; height: 40px; }
  #snap-by-aria { left: 40px; top: 150px; width: 150px; height: 40px; }
  #snap-by-reference { left: 40px; top: 210px; width: 150px; height: 40px; }
  #snap-by-for { left: 40px; top: 270px; width: 150px; height: 30px; }
  #snap-by-placeholder { left: 40px; top: 320px; width: 150px; height: 30px; }
  #snap-by-value { left: 40px; top: 370px; width: 150px; height: 30px; }
  #snap-by-text { left: 40px; top: 420px; width: 150px; height: 40px; }
  #snap-below-fold { left: 40px; top: 1400px; width: 150px; height: 40px; }
  #snap-to-other { left: 260px; top: 330px; width: 150px; height: 30px; line-height: 30px; }
  #snap-to-slow { left: 260px; top: 370px; width: 150px; height: 30px; line-height: 30px; }
  #snap-push { left: 260px; top: 420px; width: 150px; height: 40px; }
  #snap-hidden-display { display: none; }
  #snap-hidden-visibility { left: 260px; top: 210px; width: 150px; height: 40px; visibility: hidden; }
  #snap-hidden-zero { left: 260px; top: 270px; width: 0; height: 0; padding: 0; border: 0; }
  /* The non-interactive name sources live far away, so they cannot sit under a
     control and confuse a hit test taken at a control's centre. */
  #name-sources { position: absolute; left: 40px; top: 520px; width: 360px; font-size: 12px; }
</style></head>
<body>
<button id="snap-alpha" class="probe" onclick="document.getElementById('snap-effect').textContent='alpha-clicked'">alpha</button>
<button id="snap-beta" class="probe">beta</button>
<div id="snap-checked" class="probe" role="checkbox" aria-checked="true">checked control</div>
<button id="snap-expanded" class="probe" aria-expanded="false">expanded control</button>
<button id="snap-disabled" class="probe" disabled>disabled control</button>
<button id="snap-by-aria" class="probe" aria-label="labelled by aria">text that must lose to aria-label</button>
<button id="snap-by-reference" class="probe" aria-labelledby="snap-name-source">text that must lose to aria-labelledby</button>
<input id="snap-by-for" class="probe" type="text">
<input id="snap-by-placeholder" class="probe" type="text" placeholder="labelled by placeholder">
<input id="snap-by-value" class="probe" type="submit" value="labelled by value">
<button id="snap-by-text" class="probe">labelled by text</button>
<button id="snap-below-fold" class="probe">below fold</button>
<a id="snap-to-other" class="probe" href="/other">to other</a>
<a id="snap-to-slow" class="probe" href="/slow">to slow</a>
<button id="snap-push" class="probe" onclick="history.pushState({}, '', '/snapshot#pushed')">push state</button>
<output id="snap-effect">none</output>
<button id="snap-hidden-display" class="probe">display none</button>
<button id="snap-hidden-visibility" class="probe">visibility hidden</button>
<button id="snap-hidden-zero" class="probe">zero sized</button>
<div id="name-sources">
  <span id="snap-name-source">labelled by reference</span>
  <label for="snap-by-for">labelled by for</label>
</div>
</body></html>`

/**
 * The interaction page (T4).
 *
 * One page per action, and every action's effect is something a *different*
 * mechanism can read back: a click changes a text node, hover reveals a control
 * that was not in the snapshot, a drop reorders real children, and typing shows
 * up in `input.value` and in a keydown counter.
 *
 * Three controls exist only to be *un-actionable*, so the three non-timeout
 * failure reasons have a home:
 *
 *  - `#act-blocked` is fully covered by `#act-blocker`, which is deliberately a
 *    plain `<div>`: it is not in the snapshot, it is a perfectly ordinary visible
 *    box, and the only thing wrong with the world is that a click aimed at the
 *    button would land on it. The engine agrees — a click on `#act-blocked` would
 *    be retried forever — but the point of the fixture is that the *reason* is
 *    nameable, and the covering element's `id` is what names it.
 *  - `#act-hide-me` keeps its box and turns `visibility: hidden` on demand, so
 *    "not visible" cannot be confused with "has no box" or "is gone".
 *  - `#act-remove-me` is removed from the document on demand.
 *
 * `#act-far` sits at `top: 1500px`, well below the 800px-tall view: it is the
 * element "scroll to" has to bring into the viewport.
 *
 * `#act-keycount` is not decoration. Playwright's `fill` sets a value through the
 * editing pipeline (no key events) while `type` presses one key per character, so
 * a counter that only keydown can move is how "input" and "fill" are told apart
 * from the outside rather than from the implementation's own word.
 */
const INTERACT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>interact-page</title>
<style>
  html, body { margin: 0; }
  body { font: 13px system-ui; }
  .probe { position: absolute; box-sizing: border-box; }
  #act-alpha { left: 20px; top: 20px; width: 150px; height: 32px; }
  #act-blocked { left: 200px; top: 20px; width: 200px; height: 32px; }
  /* The cover: same rectangle, drawn on top, and not an interactive element. */
  #act-blocker { position: absolute; left: 200px; top: 20px; width: 200px; height: 32px;
                 z-index: 5; background: rgba(200, 40, 40, 0.85); color: #fff;
                 line-height: 32px; text-align: center; }
  #act-input { left: 20px; top: 64px; width: 150px; height: 32px; }
  #act-hide-trigger { left: 200px; top: 64px; width: 200px; height: 32px; }
  #act-hide-me { left: 20px; top: 108px; width: 150px; height: 32px; }
  #act-remove-trigger { left: 200px; top: 108px; width: 200px; height: 32px; }
  #act-remove-me { left: 20px; top: 152px; width: 150px; height: 32px; }
  #act-select { left: 200px; top: 152px; width: 200px; height: 32px; }
  #act-editable { left: 20px; top: 196px; width: 150px; height: 40px; border: 1px solid #888;
                  padding: 2px; overflow: hidden; }
  #act-effect { position: absolute; left: 200px; top: 196px; font-family: ui-monospace, monospace; }
  #act-keycount { position: absolute; left: 200px; top: 220px; font-family: ui-monospace, monospace; }
  #act-hover { left: 20px; top: 240px; width: 150px; height: 32px; background: #eef; border: 1px solid #88a; }
  #act-reveal { position: absolute; left: 160px; top: 0; width: 150px; height: 32px; display: none; }
  #act-hover:hover #act-reveal { display: block; }
  #act-key-input { left: 20px; top: 284px; width: 150px; height: 32px; }
  #act-submit { left: 200px; top: 284px; width: 200px; height: 32px; }
  #act-submitted { position: absolute; left: 20px; top: 320px; font-family: ui-monospace, monospace; }
  #act-delay { left: 200px; top: 328px; width: 200px; height: 32px; }
  #act-late { left: 20px; top: 372px; width: 150px; height: 32px; }
  #act-late2 { position: absolute; left: 200px; top: 372px; font-family: ui-monospace, monospace; }
  #act-list { position: absolute; left: 20px; top: 416px; width: 400px; }
  .drag-item { display: block; width: 150px; height: 32px; margin-bottom: 8px; text-align: left;
               box-sizing: border-box; }
  #act-far { left: 20px; top: 1500px; width: 150px; height: 32px; }
</style></head>
<body>
<button id="act-alpha" class="probe" onclick="document.getElementById('act-effect').textContent='alpha-clicked'">alpha</button>
<button id="act-blocked" class="probe">blocked control</button>
<div id="act-blocker">blocker panel</div>
<input id="act-input" class="probe" type="text" placeholder="name field">
<button id="act-hide-trigger" class="probe">hide the target</button>
<button id="act-hide-me" class="probe">hide target</button>
<button id="act-remove-trigger" class="probe">remove the target</button>
<button id="act-remove-me" class="probe">remove target</button>
<select id="act-select" class="probe" aria-label="colour">
  <option value="red">Red</option>
  <option value="green" selected>Green</option>
  <option value="blue">Blue</option>
</select>
<div id="act-editable" class="probe" contenteditable="true" aria-label="editable note">seed text</div>
<output id="act-effect">none</output>
<output id="act-keycount">keydowns:0</output>
<div id="act-hover" class="probe" role="button" aria-label="hover me">hover me<button id="act-reveal">revealed control</button></div>
<form id="act-form" action="/interact">
  <input id="act-key-input" class="probe" type="text" placeholder="key field">
  <button id="act-submit" class="probe" type="submit">submit form</button>
</form>
<output id="act-submitted">nothing submitted</output>
<button id="act-delay" class="probe">start the delayed updates</button>
<button id="act-late" class="probe" hidden>late text</button>
<output id="act-late2">not yet</output>
<div id="act-list">
  <div id="act-item-1" class="drag-item" role="button" draggable="true">item one</div>
  <div id="act-item-2" class="drag-item" role="button" draggable="true">item two</div>
</div>
<button id="act-far" class="probe">far control</button>
<script>
(function () {
  var byId = function (id) { return document.getElementById(id) }

  byId('act-alpha').addEventListener('click', function () {
    byId('act-effect').textContent = 'alpha-clicked'
  })
  byId('act-hide-trigger').addEventListener('click', function () {
    // Keeps its rectangle on purpose: "hidden" must not be confusable with "no box".
    byId('act-hide-me').style.visibility = 'hidden'
  })
  byId('act-remove-trigger').addEventListener('click', function () {
    byId('act-remove-me').remove()
  })
  byId('act-form').addEventListener('submit', function (event) {
    event.preventDefault()
    byId('act-submitted').textContent = 'submitted:' + byId('act-key-input').value
  })

  // Every keydown in the text field, so "typed as keys" and "value set in one
  // operation" are different observable facts.
  var keydowns = 0
  byId('act-input').addEventListener('keydown', function () {
    keydowns += 1
    byId('act-keycount').textContent = 'keydowns:' + keydowns
  })

  byId('act-delay').addEventListener('click', function () {
    setTimeout(function () { byId('act-late').hidden = false }, 300)
    setTimeout(function () { byId('act-late2').textContent = 'second-stage' }, 900)
  })

  // HTML5 drag and drop: the source is remembered on dragstart, the drop moves it
  // to the other item's place (so a swap in either direction is a real reorder).
  var dragSource = null
  var list = byId('act-list')
  var items = list.querySelectorAll('.drag-item')
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener('dragstart', function (event) {
      dragSource = event.currentTarget
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', event.currentTarget.id)
      }
    })
  }
  list.addEventListener('dragover', function (event) { event.preventDefault() })
  list.addEventListener('drop', function (event) {
    event.preventDefault()
    var target = event.target.closest ? event.target.closest('.drag-item') : null
    if (dragSource === null || target === null || target === dragSource) return
    if (dragSource.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) {
      list.insertBefore(dragSource, target.nextSibling)
    } else {
      list.insertBefore(dragSource, target)
    }
    dragSource = null
  })
})()
</script>
</body></html>`

/**
 * The truncation page (T3): more interactive elements than the default cap of 200,
 * each with a non-empty box so none of them is excluded for being invisible. It is
 * how "the snapshot stops at maxElements and says so" is observed at the default cap,
 * on a real page, rather than only at a cap a test set itself.
 */
const MANY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>many-page</title>
<style>
  html, body { margin: 0; }
  #many button { display: block; width: 200px; height: 12px; margin: 0; padding: 0; border: 0;
                 font-size: 9px; text-align: left; }
</style></head>
<body><div id="many">${Array.from({ length: 220 }, (_, index) => `<button id="snap-many-${index + 1}">many-${index + 1}</button>`).join('')}</div></body></html>`

/**
 * The observation page (T5).
 *
 * It exists so "the agent can read the page" is checkable from *both* sides. Every fact
 * the reading tools are supposed to find is also recorded by the page itself, so a test
 * can prove the fixture really produced it before asserting that the tool found it —
 * otherwise a diagnostics test could pass on an empty buffer and prove nothing:
 *
 *  - `window.__observeSecret` is derived from this page's own DOM, so the value under
 *    `browser_evaluate` cannot be a hardcoded answer;
 *  - the page really `fetch`es `/api/observe` and stores what came back in
 *    `window.__observePayload`, so `browser_json` can be compared against the payload
 *    the page actually received rather than against "something came back";
 *  - the page really `console.error`s and the error event really fires
 *    (`window.__observeConsoleErrors` / `window.__observePageErrors` count them);
 *  - the page really requests `/api/missing`, which really answers 404, and the page
 *    records the status it saw (`window.__observeFailures`) and the body it read.
 *
 * `#obs-long` renders far more text than a small `maxChars`, so truncation can be
 * observed with the page's own `innerText` as the yardstick.
 */
const OBSERVE_LONG_TEXT = Array.from(
  { length: 40 },
  (_, index) => `filler line ${index + 1} of the observe page, long enough to be worth cutting`,
).join(' ')

const OBSERVE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>observe-page</title>
<style>
  html, body { margin: 0; }
  body { font: 13px system-ui; }
  #obs-box { width: 120px; height: 60px; background: #2f6fb0; color: #fff; padding: 4px; box-sizing: border-box; }
  #obs-long { font-size: 12px; color: #333; }
  #obs-list { font-family: ui-monospace, monospace; }
</style></head>
<body>
<h1 id="obs-heading">observe-page</h1>
<div id="obs-box">pixel probe</div>
<button id="obs-hit" onclick="document.getElementById('obs-effect').textContent='observe-clicked'">hit me</button>
<ul id="obs-list"><li>row-one</li><li>row-two</li><li>row-three</li></ul>
<output id="obs-effect">none</output>
<p id="obs-long">${OBSERVE_LONG_TEXT}</p>
<script>
(function () {
  var list = document.getElementById('obs-list')

  // A value only this page can produce: derived from its own DOM, so a hardcoded
  // answer on the reading side cannot match it.
  window.__observeSecret = 't5-' + list.children.length + '-' + (list.children.length * 7)
  window.__observeFetchCount = 0
  window.__observePayload = null
  window.__observeFailures = []
  window.__observeFailureBody = ''
  window.__observeConsoleErrors = 0
  window.__observePageErrors = 0

  // The payload the page really received, kept on the page so the tool's copy of it can
  // be compared against this one, field by field.
  fetch('/api/observe').then(function (response) { return response.json() }).then(function (data) {
    window.__observeFetchCount += 1
    window.__observePayload = data
  })

  // A request that really fails, with the status the page itself saw.
  fetch('/api/missing').then(function (response) {
    window.__observeFailures.push(response.status)
    return response.text()
  }).then(function (body) {
    window.__observeFailureBody = body
  })

  window.__observeConsoleErrors += 1
  console.error('t5-fixture-console-error ' + window.__observeSecret)

  // An uncaught exception too: it is what most often leaves a page blank, and the page
  // counts its own error events so the test can prove one really happened.
  window.addEventListener('error', function () { window.__observePageErrors += 1 })
  setTimeout(function () { throw new Error('t5-fixture-page-error ' + window.__observeSecret) }, 0)
})()
</script>
</body></html>`

/**
 * The slow page (T3): its first chunk is sent immediately and the rest only after a
 * pause, so the document is committed (and has its own identity and its own parsed
 * controls) while it is still loading. That is the window "a navigation has replaced
 * the document but its load event has not fired yet" is observable in — and every one
 * of its controls sets the same telltale title if anything ever clicks one.
 */
const SLOW_PAGE = {
  head: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>slow-page</title></head>
<body style="font:14px system-ui"><h1>slow-page</h1>${Array.from(
    { length: 20 },
    (_, index) => `<button id="slow-${index + 1}" onclick="document.title='WRONG-CLICK'">slow-${index + 1}</button>`,
  ).join('')}`,
  tail: '<p>the rest of the slow response</p></body></html>',
}

/** How long the slow page holds its response open after the first chunk. */
const SLOW_PAGE_DELAY_MS = 2500

/**
 * Path -> {body, type, status}. Every interactive page exposes the same `#hit` / `#out` pair.
 *
 * `status` is optional and defaults to 200; the T5 routes are the only ones that use it,
 * because "the request failed with a status" needs a route that really fails.
 */
const ROUTES = {
  '/shell': () => ({ body: page('shell-page', '<p>Stand-in for the DSH web UI inside the BrowserWindow.</p>'), type: 'text/html; charset=utf-8' }),
  '/view': () => ({ body: page('view-page', `<p>Initial content of the native browser view.</p>${button('view')}`), type: 'text/html; charset=utf-8' }),
  '/other': () => ({ body: page('other-page', `<p>Reached by navigating the view.</p>${button('other')}`), type: 'text/html; charset=utf-8' }),
  '/snapshot': () => ({ body: SNAPSHOT_PAGE, type: 'text/html; charset=utf-8' }),
  '/interact': () => ({ body: INTERACT_PAGE, type: 'text/html; charset=utf-8' }),
  '/snapshot-many': () => ({ body: MANY_PAGE, type: 'text/html; charset=utf-8' }),
  '/observe': () => ({ body: OBSERVE_PAGE, type: 'text/html; charset=utf-8' }),
  // The JSON the observation page loads: a fresh nonce per response, so the payload the
  // page records and the payload a tool reports cannot both be a stale constant.
  '/api/observe': () => ({
    body: JSON.stringify({ source: 't5-fixture', nonce: randomUUID(), items: [1, 2, 3], ok: true }),
    type: 'application/json; charset=utf-8',
  }),
  // A request that really fails, with a body a reader can summarise.
  '/api/missing': () => ({
    status: 404,
    body: 't5-fixture-404-body: /api/missing was requested on purpose and does not exist',
    type: 'text/plain; charset=utf-8',
  }),
  '/slow': () => ({ slow: SLOW_PAGE, type: 'text/html; charset=utf-8' }),
  '/panel': () => ({ body: PANEL_PAGE, type: 'text/html; charset=utf-8' }),
  '/panel-rect.js': () => ({ body: PANEL_RECT_JS, type: 'text/javascript; charset=utf-8' }),
}

/**
 * Start the fixture site on loopback.
 * @param {{host?: string}} [options] - bind host.
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>}>} handle.
 */
async function startFixtureServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${host}`)
    const route = ROUTES[url.pathname]
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page('not-found', `<p>No fixture route for ${url.pathname}</p>`))
      return
    }
    const resolved = route()
    response.writeHead(resolved.status ?? 200, { 'content-type': resolved.type })
    if (resolved.slow !== undefined) {
      // Two chunks with a pause between them: the browser commits the document on the
      // first, and only sees `load` after the second.
      response.flushHeaders()
      response.write(resolved.slow.head)
      setTimeout(() => response.end(resolved.slow.tail), SLOW_PAGE_DELAY_MS)
      return
    }
    response.end(resolved.body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

module.exports = { startFixtureServer, ROUTES }
