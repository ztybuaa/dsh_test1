'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

/**
 * The shell side of the shell <-> plugin handshake.
 *
 * Electron puts every `WebContents` (the window's page *and* the native view's
 * page) into one flat CDP target list, all with `type: "page"`. So the view
 * cannot be recognised by its type or guessed from its URL: the shell has to
 * publish its identity. It does that by mapping each CDP target id back to a
 * `WebContents` with `webContents.fromDevToolsTargetId(id)` and comparing it
 * with `view.webContents`.
 */

/** Milliseconds between polls while waiting for the endpoint or the port file. */
const POLL_INTERVAL_MS = 100

/** @param {number} ms - delay. @returns {Promise<void>} resolves after the delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * GET a JSON document from the loopback endpoint.
 * @param {string} url - absolute URL.
 * @param {number} [timeoutMs] - request timeout.
 * @returns {Promise<unknown>} parsed body.
 */
function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GET ${url} -> HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`GET ${url} returned non-JSON: ${error.message}`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

/**
 * Read the port Chromium picked for `--remote-debugging-port=0`.
 * @param {string} userDataDir - the profile directory.
 * @returns {number | undefined} the port, or undefined when not written yet.
 */
function readActivePortFile(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const first = raw.split('\n')[0]?.trim()
  const port = Number(first)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/**
 * Wait until the programmable endpoint answers.
 * @param {{requestedPort: number, userDataDir: string, timeoutMs: number}} options - startup facts.
 * @returns {Promise<number>} the live port.
 */
async function waitForCdpPort(options) {
  const deadline = Date.now() + options.timeoutMs
  let lastReason = 'nothing tried yet'
  while (Date.now() < deadline) {
    let port = options.requestedPort
    if (port === 0) {
      port = readActivePortFile(options.userDataDir)
      if (port === undefined) {
        lastReason = `DevToolsActivePort not written under ${options.userDataDir} yet`
        await delay(POLL_INTERVAL_MS)
        continue
      }
    }
    try {
      const version = await getJson(`http://127.0.0.1:${port}/json/version`, 2000)
      if (typeof version?.webSocketDebuggerUrl === 'string') return port
      lastReason = 'GET /json/version answered but carried no webSocketDebuggerUrl'
    } catch (error) {
      lastReason = error.message
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(
    `programmable endpoint on 127.0.0.1 did not come up within ${options.timeoutMs}ms (last: ${lastReason})`,
  )
}

/**
 * List CDP targets exposed by the endpoint.
 * @param {number} port - endpoint port.
 * @returns {Promise<Array<{id: string, type?: string, title?: string, url?: string}>>} targets.
 */
async function listTargets(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json/list`, 5000)
  if (!Array.isArray(list)) {
    throw new Error(`unexpected /json/list payload: ${JSON.stringify(list).slice(0, 200)}`)
  }
  return list
}

/**
 * Map CDP targets back to one `WebContents` through `fromDevToolsTargetId`.
 *
 * This is the identity half of the handshake: it is exact (it does not care what
 * URL the page currently has) and it works because both the window's page and the
 * native view are ordinary `WebContents` to Electron.
 *
 * @param {{webContents: object, targets: Array, webContentsId: number}} options - lookup inputs.
 * @returns {Array | undefined} matching targets, or undefined when the API is unavailable.
 */
function matchTargetsByIdentity(options) {
  const { webContents, targets, webContentsId } = options
  if (typeof webContents.fromDevToolsTargetId !== 'function') return undefined
  const matches = []
  for (const target of targets) {
    let resolved
    try {
      resolved = webContents.fromDevToolsTargetId(target.id)
    } catch {
      resolved = undefined
    }
    if (resolved !== undefined && resolved !== null && resolved.id === webContentsId) {
      matches.push(target)
    }
  }
  return matches
}

/**
 * Find the CDP target id that belongs to a given `WebContents`.
 * @param {{webContents: object, targets: Array, webContentsId: number}} options - lookup inputs.
 * @returns {string | undefined} the target id, when exactly one target matched.
 */
function targetIdForWebContents(options) {
  const matches = matchTargetsByIdentity(options)
  return matches !== undefined && matches.length === 1 ? matches[0].id : undefined
}

/**
 * Find the CDP target that belongs to the native view.
 *
 * Primary strategy is the identity match through `fromDevToolsTargetId`. The URL
 * fallback exists only for hosts where that API is unavailable; the method that
 * actually ran is reported so the caller can see which one it was.
 *
 * @param {{webContents: object, view: object, targets: Array}} options - resolution inputs.
 * @returns {{targetId: string, method: string, matchedUrl: string}} the resolution result.
 */
function resolveViewTarget(options) {
  const { webContents, view, targets } = options
  const viewWebContentsId = view.webContents.id
  const pages = targets.filter((target) => target.type === 'page')
  if (pages.length === 0) {
    throw new Error(
      `no CDP target of type "page" was listed (saw: ${JSON.stringify(targets.map((t) => t.type))})`,
    )
  }
  const matches = matchTargetsByIdentity({ webContents, targets: pages, webContentsId: viewWebContentsId })
  if (matches !== undefined) {
    if (matches.length === 1) {
      return { targetId: matches[0].id, method: 'webContents.fromDevToolsTargetId', matchedUrl: matches[0].url }
    }
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} CDP targets map back to view webContents ${viewWebContentsId}: ` +
          `${JSON.stringify(matches.map((t) => t.id))}`,
      )
    }
  }
  const viewUrl = view.webContents.getURL()
  const byUrl = pages.filter((target) => target.url === viewUrl)
  if (byUrl.length === 1) {
    return { targetId: byUrl[0].id, method: 'url-fallback', matchedUrl: byUrl[0].url }
  }
  throw new Error(
    `could not identify the view target (identity mapping ` +
      `${matches === undefined ? 'unavailable' : 'found no match'}; url fallback matched ${byUrl.length} ` +
      `targets for ${viewUrl}; listed pages: ${JSON.stringify(pages.map((t) => `${t.id}=${t.url}`))})`,
  )
}

module.exports = {
  getJson,
  listTargets,
  matchTargetsByIdentity,
  readActivePortFile,
  resolveViewTarget,
  targetIdForWebContents,
  waitForCdpPort,
}
