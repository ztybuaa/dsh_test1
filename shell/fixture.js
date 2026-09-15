'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

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

/** Path -> {body, type}. Every interactive page exposes the same `#hit` / `#out` pair. */
const ROUTES = {
  '/shell': () => ({ body: page('shell-page', '<p>Stand-in for the DSH web UI inside the BrowserWindow.</p>'), type: 'text/html; charset=utf-8' }),
  '/view': () => ({ body: page('view-page', `<p>Initial content of the native browser view.</p>${button('view')}`), type: 'text/html; charset=utf-8' }),
  '/other': () => ({ body: page('other-page', `<p>Reached by navigating the view.</p>${button('other')}`), type: 'text/html; charset=utf-8' }),
  '/snapshot': () => ({ body: SNAPSHOT_PAGE, type: 'text/html; charset=utf-8' }),
  '/snapshot-many': () => ({ body: MANY_PAGE, type: 'text/html; charset=utf-8' }),
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
    response.writeHead(200, { 'content-type': resolved.type })
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
