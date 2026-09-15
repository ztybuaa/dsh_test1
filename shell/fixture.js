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

/** Path -> {body, type}. Every interactive page exposes the same `#hit` / `#out` pair. */
const ROUTES = {
  '/shell': () => ({ body: page('shell-page', '<p>Stand-in for the DSH web UI inside the BrowserWindow.</p>'), type: 'text/html; charset=utf-8' }),
  '/view': () => ({ body: page('view-page', `<p>Initial content of the native browser view.</p>${button('view')}`), type: 'text/html; charset=utf-8' }),
  '/other': () => ({ body: page('other-page', `<p>Reached by navigating the view.</p>${button('other')}`), type: 'text/html; charset=utf-8' }),
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
