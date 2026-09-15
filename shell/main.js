'use strict'

/**
 * Thin Electron shell.
 *
 * Owns exactly four things:
 *   1. a `BrowserWindow` showing the DSH web UI (or a fixture page),
 *   2. one native `WebContentsView` parked in the sidebar slot,
 *   3. the rectangle channel that tells it *where* that slot is: the panel running
 *      in the window measures itself and reports, through a preload-injected
 *      global, and the shell places the view on the reported rectangle,
 *   4. a loopback-only programmable endpoint, plus the handshake that tells the
 *      plugin *which* target is the view.
 *
 * It still never drives the view itself; that is the plugin's job (ADR-0002). The
 * rectangle channel is not a driving API: it moves a frame and nothing else.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { app, BrowserWindow, WebContentsView, ipcMain, webContents } = require('electron')

const { parseArgv, usage } = require('./args.js')
const { startFixtureServer } = require('./fixture.js')
const cdp = require('./cdp.js')
const geometry = require('./geometry.js')

/** stdout prefix carrying the view identity to whoever launched the shell. */
const HANDSHAKE_PREFIX = 'DSH_DESKTOP_VIEW_HANDSHAKE '

/** Environment variables used when the shell starts a child that hosts the plugin. */
const ENV_CDP = 'DSH_DESKTOP_VIEW_CDP'
const ENV_TARGET = 'DSH_DESKTOP_VIEW_TARGET'
const ENV_URL = 'DSH_DESKTOP_VIEW_URL'

/** Channel the preload sends the panel's rectangle on. Mirrored in `preload.js`. */
const RECT_CHANNEL = 'dsh-desktop-view:set-rect'

/** How long after a window navigation to re-place the view in case no panel re-reports. */
const PLACEMENT_SETTLE_MS = 500

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
  /**
   * The panel's latest report, or null for "the panel occupies no rectangle".
   * Starts null: before the panel has spoken, the view is shown once at
   * `--bounds` so a shell without a panel still renders something, and the first
   * report takes over from there.
   */
  reported: null,
  /** Why the panel's latest report was null; diagnostics only. */
  reportReason: 'no-report-yet',
  /** True once a panel has reported at least once. */
  haveReport: false,
  /** Latest placement the shell applied, for the observable output line. */
  placement: undefined,
  /** Latest placement as a value other modules can read (the test seam). */
  placementFile: undefined,
  /** Pending "re-place after navigation" timer. */
  settleTimer: undefined,
}

/** @param {string} line - one log line on stdout (stable, machine-readable). */
function emit(line) {
  process.stdout.write(`${line}\n`)
}

/** The window's content area, in the same pixels the panel measures in. */
function windowSize() {
  if (state.window === undefined || state.window.isDestroyed()) return { width: 0, height: 0 }
  const [width, height] = state.window.getContentSize()
  return { width: width ?? 0, height: height ?? 0 }
}

/**
 * Ask for the placement the panel's report implies and apply it to the view.
 *
 * Called on every report, on window resize, and after the window navigates. The
 * applied fact is written both to a value this process can log and to a file the
 * plugin's process can read, because the two halves of this feature live in
 * different processes and a test (or a human) needs to see the shell's side.
 *
 * @param {string} [cause] - what asked for the placement; diagnostics only.
 * @returns {object} the placement that was applied.
 */
function applyPlacement(cause) {
  const decision = geometry.placement({
    reported: state.reported,
    reason: state.reportReason,
    windowSize: windowSize(),
  })
  const view = state.view
  const live = view !== undefined && !view.webContents.isDestroyed()
  if (live) {
    if (decision.visible && decision.bounds !== null) {
      view.setBounds(decision.bounds)
      view.setVisible(true)
    } else {
      // `setVisible(false)` rather than a zero-sized view: a zero-sized view is
      // still a live, focusable, painting surface that can steal a click at the
      // window's origin, and "hidden" is the fact we actually mean.
      view.setVisible(false)
    }
  }
  const record = {
    cause: cause ?? 'report',
    visible: decision.visible,
    bounds: decision.bounds,
    // `applied` is the view's *geometry* read back from Electron, and it deliberately
    // survives hiding: `setVisible(false)` does not move the view, so the rectangle it
    // would come back at is still there to read. That is what makes "hiding is a
    // visibility change, not a resize to nothing" an observable fact.
    applied: live ? view.getBounds() : null,
    // ...and this is the *visibility* read back from Electron. Echoing
    // `decision.visible` here would prove nothing: "the shell decided to hide it" and
    // "the view is not visible" are different facts, and the whole point of the
    // rectangle channel is that a wrong decision must not be able to look right.
    appliedVisible: live ? view.getVisible() : null,
    clamped: decision.clamped,
    reason: decision.reason,
    reported: state.reported,
    windowSize: windowSize(),
  }
  state.placement = record
  if (state.placementFile !== undefined) {
    try {
      fs.writeFileSync(state.placementFile, JSON.stringify(record))
    } catch {
      /* the file is a convenience seam, never a reason to break placement */
    }
  }
  emit(`DSH_SHELL VIEW ${JSON.stringify(record)}`)
  return record
}

/**
 * Accept a rectangle report from the page's preload.
 *
 * @param {unknown} payload - `null`, or a `{x,y,width,height}` of finite numbers.
 * @returns {void}
 */
function acceptRectReport(payload) {
  if (payload === null) {
    state.reported = null
    state.reportReason = 'panel-reported-none'
    state.haveReport = true
    applyPlacement('panel-none')
    return
  }
  if (!geometry.isUsableRect(payload)) {
    emit(`DSH_SHELL RECT_REJECTED ${JSON.stringify({ payload })}`)
    return
  }
  state.reported = { x: payload.x, y: payload.y, width: payload.width, height: payload.height }
  state.reportReason = 'panel-reported'
  state.haveReport = true
  applyPlacement('panel-report')
}
// Registered before any window exists: the panel may report while the window is
// still loading, and a report that arrived before a listener existed would be lost
// silently — the view would then sit at `--bounds` forever with nothing to show why.
ipcMain.on(RECT_CHANNEL, (_event, payload) => {
  acceptRectReport(payload)
})

/**
 * Start the plugin host process, hand it the view identity through the
 * environment, and return the address it printed.
 *
 * The profile is passed explicitly and is never left to a `dsh web`-style alias:
 * `dsh web` is a hardcoded alias of `--profile web`, and the plugin is not installed
 * there. Getting this wrong produces the worst kind of failure — a DSH UI that
 * starts normally, shows no tab, no native view, and no error.
 *
 * @param {{cdpUrl: string, targetId: string, viewUrl: string}} handshake - view identity.
 * @returns {Promise<string>} the DSH web address.
 */
function startHostProcess(handshake) {
  const argv = ['--profile', options.dshProfile, '--no-open', '--port', '0']
  const child = spawn(options.dshCommand, argv, {
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
          `"${options.dshCommand} ${argv.join(' ')}" did not print an address within ` +
            `${options.timeoutMs}ms. Output so far:\n${buffered}`,
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
  if (state.settleTimer !== undefined) {
    clearTimeout(state.settleTimer)
    state.settleTimer = undefined
  }
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
  state.placementFile = options.placementFile
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
    webPreferences: {
      // The rectangle channel. Window only, never `state.view`: that page is an
      // arbitrary website, and `setRect` moves the view that draws it.
      ...(options.rectChannel ? { preload: path.join(__dirname, 'preload.js') } : {}),
    },
  })
  state.window.on('closed', () => {
    state.window = undefined
  })
  // A resize is a layout change the panel also sees, but the shell cannot count on
  // a report for it: the panel's rectangle is unchanged when the window grows, while
  // the window's clamping is not. Re-place from the last report.
  state.window.on('resize', () => {
    if (state.haveReport) applyPlacement('window-resize')
  })
  // A navigation replaces the page that measured the panel, so the last report is
  // stale by definition. Dropping it hides the view until the new page measures —
  // and if the new page has no panel, the view stays hidden instead of being
  // painted over whatever is there now.
  state.window.webContents.on('did-navigate', () => {
    state.reported = null
    state.reportReason = 'stale-after-navigation'
    state.haveReport = false
    applyPlacement('navigation')
    if (state.settleTimer !== undefined) clearTimeout(state.settleTimer)
    state.settleTimer = setTimeout(() => {
      state.settleTimer = undefined
      if (state.window !== undefined && !state.window.isDestroyed()) applyPlacement('settle')
    }, PLACEMENT_SETTLE_MS)
  })
  await state.window.loadURL(windowUrl)

  state.view = new WebContentsView()
  // Placement only: real-time sidebar tracking belongs to a later ticket.
  state.window.contentView.addChildView(state.view)
  state.view.setBounds(options.bounds)
  // A `target=_blank` in the view must not spawn a second native window: this shell
  // owns exactly one view, and a new window would sit outside the panel rectangle
  // the plugin is tracking. Navigate the same view instead.
  state.view.webContents.setWindowOpenHandler(({ url }) => {
    void state.view?.webContents.loadURL(url)
    return { action: 'deny' }
  })
  await state.view.webContents.loadURL(viewUrl)
  // The initial `--bounds` are a stand-in for a panel that has not spoken yet; make
  // that placement observable like any other, so "nothing has moved the view" is a
  // visible fact rather than an absence.
  applyPlacement('initial-bounds')

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
    const argv = ['--profile', options.dshProfile, '--no-open', '--port', '0']
    // Published as well as run: which profile the plugin host was started with is
    // exactly the fact that silently ruins this feature when it is wrong, so it is
    // part of the shell's observable output, not just its behaviour.
    emit(`DSH_SHELL DSH_ARGV ${JSON.stringify({ command: options.dshCommand, argv })}`)
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
