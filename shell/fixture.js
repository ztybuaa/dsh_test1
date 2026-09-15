'use strict'

const http = require('node:http')

/**
 * Built-in fixture site. It exists so the shell and the T1 seam test are
 * self-sufficient: no user DSH install, no public network, no external site.
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

/** Path -> HTML. Every interactive page exposes the same `#hit` / `#out` pair. */
const ROUTES = {
  '/shell': () => page('shell-page', '<p>Stand-in for the DSH web UI inside the BrowserWindow.</p>'),
  '/view': () => page('view-page', `<p>Initial content of the native browser view.</p>${button('view')}`),
  '/other': () => page('other-page', `<p>Reached by navigating the view.</p>${button('other')}`),
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(route())
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
