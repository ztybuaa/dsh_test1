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
const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents } = require('electron')

const { parseArgv, usage } = require('./args.js')
const { startFixtureServer } = require('./fixture.js')
const cdp = require('./cdp.js')
const geometry = require('./geometry.js')
const identity = require('./identity.js')
const spaces = require('./spaces.js')

/** stdout prefix carrying the view identity to whoever launched the shell. */
const HANDSHAKE_PREFIX = 'DSH_DESKTOP_VIEW_HANDSHAKE '

/** Environment variables used when the shell starts a child that hosts the plugin. */
const ENV_CDP = 'DSH_DESKTOP_VIEW_CDP'
const ENV_TARGET = 'DSH_DESKTOP_VIEW_TARGET'
const ENV_URL = 'DSH_DESKTOP_VIEW_URL'
/** Directory of the task-space control files (see {@link publishSpaces} and ADR-0010). */
const ENV_SPACES = 'DSH_DESKTOP_VIEW_SPACES'

/** How often the shell looks for a new space request. */
const SPACE_POLL_MS = 150

/** How many times a pending-deletion directory removal is retried before it is reported. */
const SPACE_REMOVE_ATTEMPTS = 5

/** How long to wait between those attempts, in milliseconds. */
const SPACE_REMOVE_RETRY_MS = 200

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
// 上面那个调试端口是整条领养路径的地基（ADR-0002），但它单独就会让每个页面里的
// `navigator.webdriver` 变成 true，而那是登录站点最先看的一眼自动化信号。这里把它关回去。
// Blink 特性标志是进程级的，Electron 没有 per-webContents 的等价开关：取舍与备选见 ADR-0009。
app.commandLine.appendSwitch('disable-blink-features', identity.AUTOMATION_BLINK_FEATURE)

/** Live resources, all released by {@link shutdown}. */
const state = {
  fixture: undefined,
  hostProcess: undefined,
  window: undefined,
  /**
   * Every task space that exists right now, keyed by its name: one `WebContentsView` on its own
   * `persist:` partition per space (ADR-0010). The default space is the T6 pane and is never closed.
   * There is no separate "the view" field: the panel rectangle is filled by whichever space is
   * active, and the handshake publishes the default space's identity.
   */
  spaces: new Map(),
  /** Name of the space that occupies the panel rectangle right now. */
  activeSpace: spaces.DEFAULT_SPACE,
  /** Where the plugin and the shell exchange space requests and state. */
  spaceChannel: undefined,
  /** The last request id this process has finished handling. */
  spaceRequestId: 0,
  /** Why the last request was refused, or null. Published so the plugin can say what went wrong. */
  spaceError: null,
  /** What the last request actually did, for the state file and for tests to read back. */
  lastSpaceRequest: undefined,
  /** True while a request is being handled, so the poll never starts a second one. */
  spaceBusy: false,
  /** The request-polling timer. */
  spaceTimer: undefined,
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
  /** What the view's session resolved for those probe URLs, as published. */
  proxy: undefined,
  /** Pending "re-place after navigation" timer. */
  settleTimer: undefined,
}

/** @param {string} line - one log line on stdout (stable, machine-readable). */
function emit(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * Read a JSON file, answering `undefined` for anything that is not readable JSON.
 *
 * A half-written file is a normal thing to see mid-write, so "cannot read it right now" is not
 * an error here: it is the answer "nothing new".
 *
 * @param {string} file - absolute path.
 * @returns {unknown} the parsed value, or undefined.
 */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write a JSON file so a reader never sees half of it.
 *
 * The plugin polls this file while the shell rewrites it, so the write goes to a temporary name in
 * the same directory and is then renamed over the target: on Windows a rename over an existing file
 * is atomic, which makes "the reader saw a torn request" impossible rather than unlikely.
 *
 * @param {string} file - absolute path.
 * @param {unknown} value - the value to serialize.
 */
function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}

/**
 * Delete the partition directories a previous run marked as released.
 *
 * A closed space's directory **cannot** be removed while its process lives (Windows file locks,
 * measured: 11 of 15 entries EPERM even after `clearStorageData`), so closing one only records the
 * intent. This is where the intent is honoured — and it has to run before any `session.fromPartition`
 * for those partitions, because asking for the session is what takes the lock in the first place.
 *
 * @param {string} userDataDir - the shell's profile directory.
 * @returns {string[]} the partitions that are now really gone.
 */
function cleanupPendingDeletions(userDataDir) {
  const file = state.spaceChannel.pendingDeletionFile
  const recorded = readJsonFile(file)
  if (!Array.isArray(recorded) || recorded.length === 0) return []
  const removed = []
  const surviving = []
  for (const partition of recorded) {
    // 默认空间的 partition 绝不在这里：它是用户的登录档案，不是一次性空间。
    if (typeof partition !== 'string' || partition === spaces.DEFAULT_PARTITION) continue
    const dir = path.join(userDataDir, 'Partitions', spaces.partitionDirectoryName(partition))
    let gone = false
    for (let attempt = 1; attempt <= SPACE_REMOVE_ATTEMPTS; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        gone = true
        break
      } catch {
        if (attempt === SPACE_REMOVE_ATTEMPTS) break
        // Synchronous on purpose: the whole point is to finish this before any session exists.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SPACE_REMOVE_RETRY_MS)
      }
    }
    if (gone) removed.push(partition)
    else surviving.push(partition)
    emit(`DSH_SHELL SPACE_PURGE ${JSON.stringify({ partition, dir, removed: gone })}`)
  }
  writeJsonAtomic(file, surviving)
  return removed
}

/** The entry of the space that is active right now, falling back to the default space. */
function activeEntry() {
  return state.spaces.get(state.activeSpace) ?? state.spaces.get(spaces.DEFAULT_SPACE)
}

/** The view that must occupy the panel rectangle right now, or undefined before any space exists. */
function activeView() {
  return activeEntry()?.view
}

// 空间控制通道：目录**从 `userDataDir` 推导**（不另立位置），先把它建出来，插件随时可以写请求；
// 再把上一次运行关掉、但当时删不掉的空间目录真的删掉——这件事**必须**发生在任何
// `session.fromPartition` 之前，因为"要那个 session"正是把目录锁上的动作。
state.spaceChannel = spaces.spaceChannel(userDataDir)
fs.mkdirSync(state.spaceChannel.dir, { recursive: true })
cleanupPendingDeletions(userDataDir)

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
  const view = activeView()
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
    // 非当前空间**保留但不显示**：它们各自持有自己的页面与 partition，那正是"两个空间登录
    // 互不影响"成立的方式（ADR-0010 第 1 节）。切空间 = 换掉填这一格矩形的那块视图。
    for (const entry of state.spaces.values()) {
      if (entry.view === view || entry.view.webContents.isDestroyed()) continue
      entry.view.setVisible(false)
    }
  }
  const record = {
    cause: cause ?? 'report',
    // Which space's view these numbers are about: with more than one space the placement record
    // would otherwise be about "a view" rather than about a named one.
    space: state.activeSpace,
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
      // The plugin cannot create a view itself (`Target.createTarget` is not supported on
      // Electron), so it asks through these files. The directory is derived from the profile,
      // never invented: see ADR-0010 §2.
      [ENV_SPACES]: state.spaceChannel.dir,
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
  if (state.spaceTimer !== undefined) {
    clearInterval(state.spaceTimer)
    state.spaceTimer = undefined
  }
  killHostProcess()
  const fixture = state.fixture
  state.fixture = undefined
  if (fixture !== undefined) void fixture.close()
}

/**
 * Create one task space: its own view, on its own persistent partition.
 *
 * Nothing is inherited here — {@link inheritLogin} does that, and it runs after this because a
 * view has to exist before there is a session to copy into.
 *
 * @param {string} name - the space name (already validated by {@link spaces.parseRequest}).
 * @returns {{name: string, partition: string, session: object, view: object}} the new entry.
 */
function createSpace(name) {
  const partition = spaces.partitionForSpace(name)
  const viewSession = session.fromPartition(partition)
  const view = new WebContentsView({ webPreferences: { partition } })
  // 身份：与 T6 那一格同一条规则——只把 Electron 追加的产品标记从 UA 里去掉，且只动这一块
  // webContents（T6 已把这件事记在 ADR-0009 第 5 节，新空间不能悄悄用回默认 UA）。
  view.webContents.setUserAgent(
    identity.browserUserAgent(app.userAgentFallback, app.getName(), app.getVersion()),
  )
  // A `target=_blank` in any space must not spawn a second native window: the shell owns exactly
  // one rectangle, and a new window would sit outside it. Navigate the same view instead.
  view.webContents.setWindowOpenHandler(({ url }) => {
    void view.webContents.loadURL(url)
    return { action: 'deny' }
  })
  state.window.contentView.addChildView(view)
  view.setBounds(options.bounds)
  // Hidden until it is the active space: adding it as a child view made it a painting surface in
  // the same rectangle as the current one, and two visible views in one rectangle is a race.
  view.setVisible(false)
  const entry = { name, partition, session: viewSession, view, inherited: undefined }
  state.spaces.set(name, entry)
  return entry
}

/**
 * Copy the default space's login state into a new space.
 *
 * Two different mechanisms, because the two kinds of state have different reach (measured, see
 * `docs/research/task-space-isolation.md` §3):
 *
 *  - **cookies** can be enumerated and written wholesale, so all of them go over, with the
 *    `url` each one needs (`cookies.set` refuses a bare domain/path with `Missing required
 *    option 'url'`);
 *  - **localStorage** cannot: no API lists which origins have any, and writing an entry for an
 *    origin this partition has no frame on is refused (`Frame not found for the given storage
 *    id`). So it is copied for exactly one origin — the one the new space is navigated to, which
 *    is where the default space currently is. That limit is stated in ADR-0010 rather than hidden.
 *
 * The order matters: cookies before the first load (so a login-walled site never sees the request
 * without them), localStorage after it (so there is a frame on that origin to write into).
 *
 * @param {object} source - the default space's entry.
 * @param {object} target - the new space's entry.
 * @returns {Promise<object>} what really ended up in the target, read back from Electron.
 */
async function inheritLogin(source, target) {
  const report = { sourceUrl: '', cookiesOffered: 0, cookiesInSpace: 0, localStorageOrigin: null, localStorageKeys: 0 }
  if (source === undefined || source.view.webContents.isDestroyed()) return report
  const sourceUrl = source.view.webContents.getURL()
  report.sourceUrl = sourceUrl

  const jar = await source.session.cookies.get({})
  report.cookiesOffered = jar.length
  for (const cookie of jar) {
    try {
      await target.session.cookies.set({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
        url: `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain).replace(/^\./, '')}${cookie.path}`,
      })
    } catch {
      // A cookie Chromium refuses to re-create is reported by the counts below, not by a crash:
      // the numbers are read back from the target, so a skipped cookie shows up as a difference.
    }
  }
  report.cookiesInSpace = (await target.session.cookies.get({})).length

  let origin
  try {
    origin = new URL(sourceUrl).origin
  } catch {
    return report
  }
  if (!/^https?:$/.test(new URL(sourceUrl).protocol)) return report
  // The new space starts where the default one is: that is the site whose login state matters,
  // and it is also the only origin whose localStorage this partition can be given.
  await target.view.webContents.loadURL(sourceUrl)
  const entries = await source.view.webContents.executeJavaScript(
    'Object.fromEntries(Object.entries(localStorage))',
    true,
  )
  const copy = await target.view.webContents.executeJavaScript(
    `(() => {
      const entries = ${JSON.stringify(entries)}
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
      return Object.fromEntries(Object.entries(localStorage))
    })()`,
    true,
  )
  report.localStorageOrigin = origin
  report.localStorageKeys = Object.keys(copy ?? {}).length
  return report
}

/**
 * Make one space the one that fills the panel rectangle.
 * @param {string} name - the space to activate.
 */
function activateSpace(name) {
  const entry = state.spaces.get(name)
  if (entry === undefined) throw new Error(`no such space: ${name}`)
  state.activeSpace = name
  applyPlacement('space-activate')
}

/**
 * Close a space: release its page now, erase its storage data now, and schedule its directory.
 *
 * The three are deliberately separate facts, because they come out differently (measured):
 * the page really is gone immediately, the stored data really is erased, and the **directory**
 * cannot be removed while this process lives — so it is recorded and removed at the next startup.
 *
 * @param {string} name - the space to close.
 * @returns {Promise<void>} resolves once the page is released.
 */
async function closeSpace(name) {
  const entry = state.spaces.get(name)
  if (entry === undefined) return
  if (name === spaces.DEFAULT_SPACE) {
    throw new Error(
      `the "${spaces.DEFAULT_SPACE}" space cannot be closed: it holds the profile every new space inherits from`,
    )
  }
  state.spaces.delete(name)
  state.window.contentView.removeChildView(entry.view)
  // 留一份引用再 close：`view.webContents` 在 close 之后变成 undefined（实测）。
  const contents = entry.view.webContents
  contents.close()
  await entry.session.clearStorageData()
  const recorded = readJsonFile(state.spaceChannel.pendingDeletionFile)
  const pending = Array.isArray(recorded) ? recorded.filter((item) => typeof item === 'string') : []
  if (!pending.includes(entry.partition)) pending.push(entry.partition)
  writeJsonAtomic(state.spaceChannel.pendingDeletionFile, pending)
  if (state.activeSpace === name) state.activeSpace = spaces.DEFAULT_SPACE
}

/**
 * Describe every space as it really is, every value read back from Electron.
 *
 * `storagePath` is the load-bearing one: Electron's `Session` exposes no `getPartition()`, so the
 * only way to say which partition a view really runs on is to ask where its storage really is and
 * compare that with the directory the requested partition implies. `partition` is therefore the
 * *request*; `storagePath` and `persistent` are the read-back that can contradict it.
 *
 * @returns {Promise<Array<object>>} one record per space, default first, then by name.
 */
async function describeSpaces() {
  const targets = await cdp.listTargets(state.cdpPort).catch(() => [])
  const pageTargets = targets.filter((target) => target.type === 'page')
  const names = [...state.spaces.keys()].sort((left, right) =>
    left === spaces.DEFAULT_SPACE ? -1 : right === spaces.DEFAULT_SPACE ? 1 : left.localeCompare(right),
  )
  const records = []
  for (const name of names) {
    const entry = state.spaces.get(name)
    // Deliberately not called `webContents`: that name is the Electron module here, and
    // `cdp.targetIdForWebContents` asks *it* to map an id back to a WebContents. Shadowing the
    // module with a view's own webContents makes that lookup answer "unavailable" and the target id
    // silently come out undefined.
    const contents = entry.view.webContents
    if (contents.isDestroyed()) {
      records.push({ name, partition: entry.partition, destroyed: true })
      continue
    }
    records.push({
      name,
      partition: entry.partition,
      storagePath: entry.session.getStoragePath(),
      persistent: entry.session.isPersistent(),
      targetId: cdp.targetIdForWebContents({ webContents, targets: pageTargets, webContentsId: contents.id }),
      url: contents.getURL(),
      visible: entry.view.getVisible(),
      webContentsId: contents.id,
      active: name === state.activeSpace,
      isDefault: name === spaces.DEFAULT_SPACE,
      cookieCount: (await entry.session.cookies.get({})).length,
      ...(entry.inherited !== undefined ? { inherited: entry.inherited } : {}),
    })
  }
  return records
}

/**
 * Publish the space table: to the plugin (through the state file) and to the launcher (stdout).
 *
 * `requestId` is what makes a tool call deterministic rather than hopeful: the plugin waits until
 * the id it wrote has been handled, and this file is where it reads that (ADR-0010 §2).
 *
 * @param {string} cause - what made the table change; diagnostics only.
 * @returns {Promise<object>} the published record.
 */
async function publishSpaces(cause) {
  const records = await describeSpaces()
  const record = {
    protocol: spaces.SPACE_PROTOCOL,
    requestId: state.spaceRequestId,
    error: state.spaceError,
    active: state.activeSpace,
    userDataDir,
    cause,
    spaces: records,
    ...(state.lastSpaceRequest !== undefined ? { lastRequest: state.lastSpaceRequest } : {}),
  }
  try {
    fs.mkdirSync(state.spaceChannel.dir, { recursive: true })
    writeJsonAtomic(state.spaceChannel.stateFile, record)
  } catch (error) {
    emit(`DSH_SHELL SPACES_WRITE_FAILED ${JSON.stringify({ message: error?.message ?? String(error) })}`)
  }
  emit(`DSH_SHELL SPACES ${JSON.stringify(record)}`)
  return record
}

/**
 * Handle one request from the plugin: create what is missing, close what is gone, activate one.
 *
 * A refused request still advances `requestId`, and its reason is published: the plugin is waiting
 * on that id, and "your request was refused because …" is an answer while silence is a hang.
 *
 * @param {object} raw - the parsed `request.json`.
 * @returns {Promise<void>} resolves once the request has been handled and published.
 */
async function applySpaceRequest(raw) {
  state.spaceError = null
  const plan = { create: [], close: [], activate: state.activeSpace }
  const parsed = spaces.parseRequest(raw)
  if (!parsed.ok) {
    state.spaceError = parsed.error
  } else {
    try {
      const diff = spaces.reconcile({ current: [...state.spaces.keys()], request: parsed.request })
      plan.create = diff.create
      plan.close = diff.close
      plan.activate = diff.activate
      for (const name of diff.create) {
        const entry = createSpace(name)
        entry.inherited = await inheritLogin(state.spaces.get(spaces.DEFAULT_SPACE), entry)
      }
      for (const name of diff.close) await closeSpace(name)
      activateSpace(diff.activate)
    } catch (error) {
      state.spaceError = error?.message ?? String(error)
    }
  }
  state.spaceRequestId = raw.id
  state.lastSpaceRequest = { id: raw.id, ...plan, error: state.spaceError }
  await publishSpaces('request')
}

/**
 * Look for a request the plugin has written since the last one was handled.
 *
 * Polling rather than `fs.watch`: the request is a tiny file written atomically, the plugin is
 * local, and a poll loop has no platform-specific event semantics to get wrong. Requests are
 * handled one at a time, so a slow create never races the next request.
 *
 * @returns {Promise<void>} resolves when the poll has finished.
 */
async function pollSpaceRequest() {
  if (state.spaceBusy || state.shuttingDown) return
  // Before the window exists there is nothing to hang a new space's view on.
  if (state.window === undefined || state.window.isDestroyed()) return
  const request = readJsonFile(state.spaceChannel.requestFile)
  if (request === null || typeof request !== 'object' || !Number.isInteger(request.id)) return
  if (request.id === state.spaceRequestId) return
  state.spaceBusy = true
  try {
    await applySpaceRequest(request)
  } finally {
    state.spaceBusy = false
  }
}

/**
 * Publish what the view's session resolves for a foreign site and for loopback.
 *
 * 票面第 3 条验收的读回：这里发布的不是"我们打算怎么走代理"，而是 Electron 对那几个地址的回答。
 * 外网那一条取到的就是系统设置的结果（默认模式是 system）；三条回环预期一律 `DIRECT`。
 *
 * @param {object} target - 视图所在的 session。
 * @returns {Promise<object>} 发布出去的记录。
 */
async function publishProxyReadings(target) {
  const readings = {}
  for (const [label, url] of Object.entries(identity.PROXY_PROBE_URLS)) {
    readings[label] = { url, result: await target.resolveProxy(url) }
  }
  const record = { partition: identity.VIEW_PARTITION, readings }
  emit(`DSH_SHELL PROXY ${JSON.stringify(record)}`)
  return record
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
      // The rectangle channel. Window only, never a space's view: that page is an
      // arbitrary website, and `setRect` moves whichever view draws the rectangle.
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

  // 默认空间：T6 那一格。它的 partition 是 `persist:dsh-view`，**原样不动**——用户可能已经在
  // 里面登录过了，为命名整齐改名或迁移等于把登录态丢掉（ADR-0010 §1）。
  const defaultSpace = createSpace(spaces.DEFAULT_SPACE)
  // 代理：默认**什么都不设**。Chromium 的默认模式就是 system，所以外网站点自动继承系统代理；
  // 而它对回环地址本来就有隐含 bypass，`127.0.0.1` / `localhost` / `[::1]` 都不会被推进代理
  // （两条都实测过，见 docs/research/browser-identity-and-profile.md 第 6 节）。只有调用方
  // 显式给了 `--proxy` 才覆盖它。这里刻意**不设** `proxyBypassRules`：写 `<-loopback>` 会把
  // 隐含 bypass 反过来，连回环也一起走代理。新空间继承同一条规则。
  if (options.proxy !== undefined) {
    await defaultSpace.session.setProxy({ proxyRules: options.proxy })
  }
  state.proxy = await publishProxyReadings(defaultSpace.session)
  await defaultSpace.view.webContents.loadURL(viewUrl)
  // The initial `--bounds` are a stand-in for a panel that has not spoken yet; make
  // that placement observable like any other, so "nothing has moved the view" is a
  // visible fact rather than an absence.
  applyPlacement('initial-bounds')

  const targets = await cdp.listTargets(state.cdpPort)
  const pageTargets = targets.filter((target) => target.type === 'page')
  const resolved = cdp.resolveViewTarget({ webContents, view: defaultSpace.view, targets })
  // The window's own page is also a `page` target; publishing its id proves the
  // view was chosen deliberately rather than being the only candidate.
  const windowTargetId = cdp.targetIdForWebContents({
    webContents,
    targets: pageTargets,
    webContentsId: state.window.webContents.id,
  })

  // 空间状态**先落盘，再发布握手**：握手会告诉插件"状态文件在哪"，而插件第一件事就是读它。
  // 反过来做会留一个窗口——握手已经能读到了、文件却还没有——插件在那里只能报错。
  const published = await publishSpaces('startup')
  state.handshake = {
    cdpUrl,
    targetId: resolved.targetId,
    identification: resolved.method,
    targetType: 'page',
    targetUrl: resolved.matchedUrl,
    viewUrl,
    viewWebContentsId: defaultSpace.view.webContents.id,
    windowWebContentsId: state.window.webContents.id,
    ...(windowTargetId !== undefined ? { windowTargetId } : {}),
    pageTargetCount: pageTargets.length,
    userDataDir,
    fixtureOrigin: fixture.origin,
    // 这一格的浏览器身份：档案落在哪、真正会发出去的 UA、自动化开关在不在——每个值都是
    // **从 Electron 读回**的实际值，而不是我们的意图。把"身份"交给插件是视图契约的一半，
    // 票面第 1/2/4 条验收也都要能从这里独立读回。
    browserIdentity: {
      partition: identity.VIEW_PARTITION,
      storagePath: defaultSpace.session.getStoragePath(),
      userAgent: defaultSpace.view.webContents.getUserAgent(),
      enableAutomationSwitch: app.commandLine.hasSwitch('enable-automation'),
      disableBlinkFeatures: app.commandLine.getSwitchValue('disable-blink-features'),
    },
    // 空间控制通道与开局的空间表：插件从这里知道"空间开关往哪写、现在有哪些空间、
    // 每个空间的 targetId 是什么"。表里的值全部从 Electron 读回（见 describeSpaces）。
    spaceChannel: { ...state.spaceChannel },
    activeSpace: published.active,
    spaces: published.spaces,
  }
  // stdout is the seam for a caller that launched the shell itself; the env vars
  // on the child process are the seam for a child the shell launches.
  emit(`${HANDSHAKE_PREFIX}${JSON.stringify(state.handshake)}`)
  // Only now: creating a space needs the window to hang its view on.
  state.spaceTimer = setInterval(() => {
    void pollSpaceRequest()
  }, SPACE_POLL_MS)

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

module.exports = { HANDSHAKE_PREFIX, ENV_CDP, ENV_TARGET, ENV_URL, ENV_SPACES }
