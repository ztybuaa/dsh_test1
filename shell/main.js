'use strict'

/**
 * Thin Electron shell.
 *
 * Owns exactly three things:
 *   1. a `BrowserWindow` showing the DSH web UI (or a fixture page),
 *   2. one native `WebContentsView` parked in the sidebar slot,
 *   3. a loopback-only programmable endpoint, plus the handshake that tells the
 *      plugin *which* target is the view.
 *
 * It never drives the view itself; that is the plugin's job (ADR-0002).
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { app, BrowserWindow, WebContentsView, webContents } = require('electron')

const { parseArgv, usage } = require('./args.js')
const { startFixtureServer } = require('./fixture.js')
const cdp = require('./cdp.js')

/** stdout prefix carrying the view identity to whoever launched the shell. */
const HANDSHAKE_PREFIX = 'DSH_DESKTOP_VIEW_HANDSHAKE '

/** Environment variables used when the shell starts a child that hosts the plugin. */
const ENV_CDP = 'DSH_DESKTOP_VIEW_CDP'
const ENV_TARGET = 'DSH_DESKTOP_VIEW_TARGET'
const ENV_URL = 'DSH_DESKTOP_VIEW_URL'

let options
try {
  options = parseArgv(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`shell: ${error.message}\n\n${usage()}\n`)
  process.exit(2)
}
if (options.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}

// The profile directory is the shell's own, never the shared "Electron" default,
// so two shells (and concurrent test runs) never fight over one profile lock.
const userDataDir = options.userDataDir ?? path.join(app.getPath('appData'), 'dsh-desktop-shell')
fs.mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)
// A stale port file from an earlier run would point at an endpoint nobody owns.
try {
  fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true })
} catch {
  /* best effort */
}

// Must happen before the browser process parses its command line, i.e. before ready.
// Port 0 means "let the OS choose"; Chromium then writes the real port into
// <userDataDir>/DevToolsActivePort, which is how this process learns it.
app.commandLine.appendSwitch('remote-debugging-port', String(options.cdpPort))
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

/** Live resources, all released by {@link shutdown}. */
const state = {
  fixture: undefined,
  hostProcess: undefined,
  window: undefined,
  view: undefined,
  cdpPort: 0,
  handshake: undefined,
  shuttingDown: false,
}

/** @param {string} line - one log line on stdout (stable, machine-readable). */
function emit(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * Start `dsh web --no-open --port 0`, hand it the view identity through the
 * environment, and return the address it printed.
 * @param {{cdpUrl: string, targetId: string, viewUrl: string}} handshake - view identity.
 * @returns {Promise<string>} the DSH web address.
 */
function startHostProcess(handshake) {
  const child = spawn(options.dshCommand, ['web', '--no-open', '--port', '0'], {
    env: {
      ...process.env,
      [ENV_CDP]: handshake.cdpUrl,
      [ENV_TARGET]: handshake.targetId,
      [ENV_URL]: handshake.viewUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  state.hostProcess = child
  return new Promise((resolve, reject) => {
    let buffered = ''
    let settled = false
    const timer = setTimeout(() => {
      reject(
        new Error(
          `"${options.dshCommand} web" did not print an address within ${options.timeoutMs}ms. ` +
            `Output so far:\n${buffered}`,
        ),
      )
    }, options.timeoutMs)
    // Deliberately strict: it must not match a loopback URL that merely appears
    // somewhere else in the child's output. Quotes and backslashes are excluded so
    // an already-forwarded, JSON-escaped copy of that output cannot match either.
    const addressWithoutPrefix = /https?:\/\/127\.0\.0\.1:\d+\/\?[^\s"\\]*token=[^\s"\\]*/
    const announcedAddress = /dsh web:\s*(\S+)/
    const tryResolve = (text) => {
      if (settled) return
      // Only complete lines may use the loose "dsh web:" prefix form.
      const complete = text.slice(0, text.lastIndexOf('\n') + 1)
      const announced = announcedAddress.exec(complete)
      const candidate = announced !== null ? announced[1].replace(/\r$/, '') : addressWithoutPrefix.exec(text)?.[0]
      if (candidate === undefined) return
      try {
        void new URL(candidate)
      } catch {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(candidate)
    }
    const inspect = (channel) => (chunk) => {
      const text = chunk.toString('utf8')
      buffered += text
      // Forward verbatim so the launcher can see what the child actually said.
      emit(`DSH_SHELL HOST_${channel} ${JSON.stringify({ text })}`)
      tryResolve(buffered)
    }
    child.stdout.on('data', inspect('STDOUT'))
    child.stderr.on('data', inspect('STDERR'))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`could not start "${options.dshCommand}": ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`"${options.dshCommand} web" exited early (code ${code}, signal ${signal})`))
    })
  })
}

/** Kill the host child and its descendants. */
function killHostProcess() {
  const child = state.hostProcess
  if (child === undefined || child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* best effort */
  }
  state.hostProcess = undefined
}

/** Release the fixture site and the host child. */
function shutdown() {
  if (state.shuttingDown) return
  state.shuttingDown = true
  killHostProcess()
  const fixture = state.fixture
  state.fixture = undefined
  if (fixture !== undefined) void fixture.close()
}

/**
 * Build the window, the view, and the handshake.
 * @returns {Promise<void>} resolves once the view identity has been published.
 */
async function main() {
  state.fixture = await startFixtureServer()
  const fixture = state.fixture

  state.cdpPort = await cdp.waitForCdpPort({
    requestedPort: options.cdpPort,
    userDataDir,
    timeoutMs: options.timeoutMs,
  })
  const cdpUrl = `http://127.0.0.1:${state.cdpPort}`
  emit(`DSH_SHELL CDP ${JSON.stringify({ cdpUrl })}`)

  const windowUrl = options.windowUrl ?? `${fixture.origin}/shell`
  const viewUrl = options.viewUrl ?? `${fixture.origin}/view`

  state.window = new BrowserWindow({
    width: options.window.width,
    height: options.window.height,
    show: options.show,
    title: 'DSH desktop shell',
  })
  state.window.on('closed', () => {
    state.window = undefined
  })
  await state.window.loadURL(windowUrl)

  state.view = new WebContentsView()
  // Placement only: real-time sidebar tracking belongs to a later ticket.
  state.window.contentView.addChildView(state.view)
  state.view.setBounds(options.bounds)
  await state.view.webContents.loadURL(viewUrl)

  const targets = await cdp.listTargets(state.cdpPort)
  const pageTargets = targets.filter((target) => target.type === 'page')
  const resolved = cdp.resolveViewTarget({ webContents, view: state.view, targets })
  // The window's own page is also a `page` target; publishing its id proves the
  // view was chosen deliberately rather than being the only candidate.
  const windowTargetId = cdp.targetIdForWebContents({
    webContents,
    targets: pageTargets,
    webContentsId: state.window.webContents.id,
  })

  state.handshake = {
    cdpUrl,
    targetId: resolved.targetId,
    identification: resolved.method,
    targetType: 'page',
    targetUrl: resolved.matchedUrl,
    viewUrl,
    viewWebContentsId: state.view.webContents.id,
    windowWebContentsId: state.window.webContents.id,
    ...(windowTargetId !== undefined ? { windowTargetId } : {}),
    pageTargetCount: pageTargets.length,
    userDataDir,
    fixtureOrigin: fixture.origin,
  }
  // stdout is the seam for a caller that launched the shell itself; the env vars
  // on the child process are the seam for a child the shell launches.
  emit(`${HANDSHAKE_PREFIX}${JSON.stringify(state.handshake)}`)

  if (options.useDsh) {
    const dshUrl = await startHostProcess({
      cdpUrl,
      targetId: resolved.targetId,
      viewUrl,
    })
    emit(`DSH_SHELL DSH_URL ${JSON.stringify({ url: dshUrl })}`)
    await state.window.loadURL(dshUrl)
  }
}

app.whenReady().then(main).catch((error) => {
  emit(`DSH_SHELL FATAL ${JSON.stringify({ message: error?.message ?? String(error) })}`)
  process.stderr.write(`${error?.stack ?? error}\n`)
  shutdown()
  app.exit(1)
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  shutdown()
})

module.exports = { HANDSHAKE_PREFIX, ENV_CDP, ENV_TARGET, ENV_URL }
