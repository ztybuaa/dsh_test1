import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * Test support for driving the real shell process.
 *
 * Everything here launches the actual Electron app that ships in `shell/`. There
 * is no in-process fake: the point of the T1 seam test is that a genuinely
 * separate Electron process exposes a genuinely native view.
 */

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/** Repository root, resolved from this file rather than the process cwd. */
export const REPO_ROOT = resolve(here, '..')

/** Entry point handed to the Electron binary. */
export const SHELL_MAIN = join(REPO_ROOT, 'shell', 'main.js')

/** Fake `dsh web` used to exercise the `--dsh` child-process handoff. */
export const FAKE_DSH = join(here, 'fixtures', 'fake-dsh-web.mjs')

/**
 * Resolve the Electron executable installed in this repository.
 * @returns absolute path to `electron.exe` / `electron`.
 */
export function electronExecutable(): string {
  const resolved = require('electron') as unknown
  if (typeof resolved !== 'string' || !existsSync(resolved)) {
    throw new Error(
      `the electron package did not resolve to an existing binary (got: ${String(resolved)}); ` +
        'run `npm install` with ELECTRON_MIRROR set',
    )
  }
  return resolved
}

/** The identity block the shell publishes once the native view exists. */
export interface ViewHandshake {
  /** Loopback programmable endpoint. */
  cdpUrl: string
  /** CDP target id of the native view. */
  targetId: string
  /** Which strategy produced {@link targetId}. */
  identification: string
  /** CDP target type of the view, as reported by the endpoint. */
  targetType: string
  /** URL the view had when the handshake was taken. */
  targetUrl: string
  /** Configured initial URL of the view. */
  viewUrl: string
  /** Electron webContents id of the view. */
  viewWebContentsId: number
  /** Electron webContents id of the window's page. */
  windowWebContentsId: number
  /** CDP target id of the window's page, for contrast. */
  windowTargetId?: string
  /** How many `type: "page"` targets the endpoint exposed. */
  pageTargetCount: number
  /** Chromium profile directory used by this run. */
  userDataDir: string
  /** Origin of the built-in fixture site. */
  fixtureOrigin: string
  /**
   * The view's own browser identity, read back from Electron rather than restated from
   * the shell's intentions: where its storage really is, what it really sends, and
   * whether the automation switch is really on.
   */
  browserIdentity: {
    /** Partition the view runs in. A `persist:` partition is written to disk. */
    partition: string
    /** Directory that partition's storage lives in, as `session.getStoragePath()` answers. */
    storagePath: string
    /** The user agent the view really sends, as `webContents.getUserAgent()` answers. */
    userAgent: string
    /** Whether Chromium's automation switch is on; `navigator.webdriver` follows it. */
    enableAutomationSwitch: boolean
    /** Blink features this shell disables, as Electron's own command line reports them. */
    disableBlinkFeatures: string
  }
  /**
   * Where the plugin and the shell exchange task-space requests and state (ADR-0010).
   *
   * The directory is derived from the profile the shell was given, never invented here.
   */
  spaceChannel: {
    /** Channel directory under the shell's profile. */
    dir: string
    /** The plugin writes its desired state here. */
    requestFile: string
    /** The shell writes what is really true here. */
    stateFile: string
    /** Partitions whose directories are to be removed at the next startup. */
    pendingDeletionFile: string
    /** Protocol version, so a stale pair can be told apart. */
    protocol: number
  }
  /** Which space fills the panel rectangle at startup. */
  activeSpace: string
  /** Every task space that exists at startup, each value read back from Electron. */
  spaces: ViewSpaceRecord[]
}

/**
 * One task space as the shell publishes it.
 *
 * `partition` is what the shell *asked* for; `storagePath` is the read-back that can contradict it —
 * Electron's `Session` exposes no `getPartition()`, so where the storage really is is the answer.
 */
export interface ViewSpaceRecord {
  /** Space name. */
  name: string
  /** The partition the shell put this space's view on. */
  partition: string
  /** `session.getStoragePath()` for that partition. */
  storagePath: string
  /** `session.isPersistent()`: whether that partition is written to disk. */
  persistent?: boolean
  /** CDP target id of this space's view. */
  targetId?: string
  /** The address the space's view currently has. */
  url?: string
  /** `view.getVisible()`, as Electron answers it. */
  visible?: boolean
  /** Electron webContents id of the space's view. */
  webContentsId?: number
  /** Whether this is the space filling the panel rectangle. */
  active?: boolean
  /** Whether this is the default space (the T6 pane, which cannot be closed). */
  isDefault?: boolean
  /** How many cookies that space's session really holds. */
  cookieCount?: number
  /** What the shell really copied in when it created the space, read back from Electron. */
  inherited?: {
    sourceUrl: string
    cookiesOffered: number
    cookiesInSpace: number
    localStorageOrigin: string | null
    localStorageKeys: number
  }
}

/** One view placement the shell applied, as published on stdout. */
export interface ViewPlacement {
  /** What asked for this placement (`initial-bounds`, `panel-report`, `panel-none`, `window-resize`, …). */
  cause: string
  /** Which space's view this placement is about. */
  space?: string
  /** What the shell *decided*: whether the view should be shown. */
  visible: boolean
  /** The rectangle the panel asked for, or null when it asked for none. */
  bounds: { x: number; y: number; width: number; height: number } | null
  /** What `view.getBounds()` actually answered after the placement ran. */
  applied: { x: number; y: number; width: number; height: number } | null
  /**
   * What `view.getVisible()` actually answered after the placement ran, or null when
   * no view existed yet. This is Electron's answer, not the shell's decision: it is
   * the only way to tell "the shell intended to hide the view" from "the view is
   * hidden".
   */
  appliedVisible: boolean | null
  /** Whether the window clipped the requested rectangle. */
  clamped: boolean
  /** Why the placement came out the way it did. */
  reason: string
  /** The window's content size at the time. */
  windowSize: { width: number; height: number }
}

/**
 * Connect to the shell's CDP endpoint and return the page whose CDP target id is `targetId`.
 *
 * `Target.getTargetInfo` is what makes this a lookup by *identity* rather than by
 * URL or by type: the window's page and the native view are both CDP `page` targets,
 * so neither of the cheap answers is the right one.
 *
 * @param cdpUrl - the shell's loopback endpoint.
 * @param targetId - the target to find.
 * @returns the opened connection and the matching page. The caller closes the connection.
 */
export async function pageForTarget(cdpUrl: string, targetId: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 })
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page)
        const { targetInfo } = await session.send('Target.getTargetInfo')
        await session.detach()
        if (targetInfo?.targetId === targetId) return { browser, page }
      }
    }
  } catch (error) {
    await browser.close()
    throw error
  }
  await browser.close()
  throw new Error(`no page in ${cdpUrl} had target id ${targetId}`)
}

/** A running shell process under test. */
export interface ShellProcess {
  /** The Electron child process. */
  child: ChildProcess
  /** View identity published at startup. */
  handshake: ViewHandshake
  /** Everything the shell has written to stdout so far. */
  stdout: () => string
  /** Everything the shell has written to stderr so far. */
  stderr: () => string
  /** Whether the Electron process is still running. */
  alive: () => boolean
  /** Resolve once `predicate(stdout)` holds, or reject on timeout. */
  waitFor: (predicate: (stdout: string) => boolean, description: string, timeoutMs?: number) => Promise<void>
  /**
   * Wait until a placement satisfying `predicate` has been published, and return it.
   * @param predicate - which placement counts.
   * @param description - what is being waited for, for the failure message.
   * @param timeoutMs - how long to wait.
   * @returns the matching placement.
   */
  waitForPlacement: (
    predicate: (placement: ViewPlacement) => boolean,
    description: string,
    timeoutMs?: number,
  ) => Promise<ViewPlacement>
  /** The latest placement published so far, or undefined when none has been. */
  latestPlacement: () => ViewPlacement | undefined
  /**
   * Terminate the shell, optionally the way a user would.
   * @param options - `{graceful: true}` closes the window and waits instead of killing.
   */
  stop: (options?: StopOptions) => Promise<void>
}

/** Default time to wait for the shell to publish its handshake. */
const START_TIMEOUT_MS = 90_000

/** How many times a temporary directory removal is retried before it is only reported. */
const REMOVE_ATTEMPTS = 10

/** How long to wait between removal attempts, in milliseconds. */
const REMOVE_RETRY_MS = 250

/** Wait synchronously, so a retry loop can live inside a synchronous cleanup path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Remove a temporary directory, tolerating a file handle that is still closing.
 *
 * Measured on Windows: `rmSync` immediately after killing an Electron shell sometimes
 * throws `EPERM` because the profile's handles have not been released yet — and that threw
 * out of `afterAll`, failing the whole spec file *after* every assertion in it had passed
 * (seen as `Test Files 1 failed | 5 passed` with `Tests 53 passed`, several times a day).
 * Cleanup is housekeeping, never a result: it is retried briefly, and a directory that is
 * still held is reported on stderr rather than allowed to fail an unrelated suite.
 *
 * @param dir - the directory to remove.
 */
function removeWhenFree(dir: string): void {
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === REMOVE_ATTEMPTS) {
        process.stderr.write(
          `warning: the temporary directory ${dir} could not be removed after ${REMOVE_ATTEMPTS} attempts ` +
            `(a process may still hold it): ${error instanceof Error ? error.message : String(error)}\n`,
        )
        return
      }
      sleepSync(REMOVE_RETRY_MS)
    }
  }
}

/** Options accepted by {@link startShell}. */
export interface StartShellOptions {
  /** How long to wait for the handshake. */
  timeoutMs?: number
  /** Window size, e.g. `{width: 900, height: 600}`. Defaults to the shell's own. */
  windowSize?: { width: number; height: number }
  /**
   * Profile directory to use instead of the per-run temporary one.
   *
   * The caller owns it: it is **not** removed by {@link ShellProcess.stop}. That is what
   * makes "the login survives a restart" observable at all — the second run has to be
   * handed the same profile as the first, and the profile has to outlive the first shell.
   */
  userDataDir?: string
}

/** Options accepted by {@link ShellProcess.stop}. */
export interface StopOptions {
  /**
   * Close the shell's own window through CDP and wait for the process to exit, instead of
   * killing the process tree.
   *
   * This is the path a user actually takes (close the window ⇒ `window-all-closed` ⇒
   * `app.quit()`), and it is the only path on which Chromium flushes cookies and
   * localStorage into the profile: measured, a force-kill issued right after a write lost
   * both, so a "does it persist" test that force-kills would be measuring flush timing
   * rather than persistence. Falls back to the force path if the window does not close.
   */
  graceful?: boolean
}

/**
 * Launch the Electron shell and wait for it to publish the view identity.
 * @param args - extra shell arguments.
 * @param options - timeout and window size.
 * @returns the running shell.
 */
export async function startShell(
  args: string[] = [],
  options: StartShellOptions = {},
): Promise<ShellProcess> {
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS
  const sizeArgs =
    options.windowSize === undefined
      ? []
      : // `--window-size` reuses the rectangle parser; only width and height are read.
        ['--window-size', `0,0,${options.windowSize.width},${options.windowSize.height}`]
  // A per-run profile keeps concurrent runs (and the developer's own profile) untouched —
  // unless the caller needs the same profile twice, in which case it owns the directory.
  const ownedProfile = options.userDataDir === undefined
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-test-'))
  const child = spawn(
    electronExecutable(),
    [SHELL_MAIN, '--user-data-dir', userDataDir, ...sizeArgs, ...args],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })

  const handshake = await new Promise<ViewHandshake>((settle, fail) => {
    const timer = setTimeout(() => {
      fail(
        new Error(
          `the shell did not publish a handshake within ${timeoutMs}ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
        ),
      )
    }, timeoutMs)
    const scan = (): void => {
      const fatal = /^DSH_SHELL FATAL (.*)$/m.exec(out)
      if (fatal !== null) {
        clearTimeout(timer)
        fail(new Error(`the shell reported a fatal startup error: ${fatal[1]}\n--- stderr ---\n${err}`))
        return
      }
      const match = /^DSH_DESKTOP_VIEW_HANDSHAKE (.*)$/m.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        settle(JSON.parse(match[1]) as ViewHandshake)
      }
    }
    child.stdout?.on('data', scan)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the shell exited with code ${code} before publishing a handshake\n--- stderr ---\n${err}`))
    })
    scan()
  })

  const alive = (): boolean => child.exitCode === null && child.signalCode === null

  /**
   * Close the shell's own window through CDP, the way a user closes it.
   * @returns whether the window was reached and asked to close.
   */
  const closeWindow = async (): Promise<boolean> => {
    if (handshake.windowTargetId === undefined) return false
    try {
      const opened = await pageForTarget(handshake.cdpUrl, handshake.windowTargetId)
      try {
        await opened.page.evaluate(() => window.close())
      } finally {
        await opened.browser.close()
      }
      return true
    } catch {
      return false
    }
  }

  const stop = async (options: StopOptions = {}): Promise<void> => {
    if (alive() && options.graceful === true) {
      await closeWindow()
      const exited = await new Promise<boolean>((settle) => {
        if (!alive()) {
          settle(true)
          return
        }
        const timer = setTimeout(() => settle(false), 15_000)
        child.once('exit', () => {
          clearTimeout(timer)
          settle(true)
        })
      })
      // A window that refused to close is not a result: the profile still has to be
      // released, so the force path below finishes the job.
      if (!exited) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
    if (alive()) {
      if (process.platform === 'win32' && child.pid !== undefined) {
        // `shell/main.js` may itself own children; kill the whole tree.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
      await new Promise<void>((settle) => {
        if (!alive()) {
          settle()
          return
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          settle()
        }, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          settle()
        })
      })
    }
    if (ownedProfile) removeWhenFree(userDataDir)
  }

  const waitFor = async (
    predicate: (stdout: string) => boolean,
    description: string,
    waitMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (predicate(out)) return
      await new Promise((settle) => setTimeout(settle, 100))
    }
    throw new Error(`timed out waiting for ${description}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`)
  }

  const latestPlacement = (): ViewPlacement | undefined => {
    const all = viewPlacements(out)
    return all.length === 0 ? undefined : all[all.length - 1]
  }

  const waitForPlacement = async (
    predicate: (placement: ViewPlacement) => boolean,
    description: string,
    waitMs = 30_000,
  ): Promise<ViewPlacement> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const match = viewPlacements(out).find(predicate)
      if (match !== undefined) return match
      if (Date.now() >= deadline) break
      await new Promise((settle) => setTimeout(settle, 50))
    }
    throw new Error(
      `timed out waiting for ${description}\n--- placements seen ---\n` +
        `${JSON.stringify(viewPlacements(out), null, 2)}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
    )
  }

  return {
    child,
    handshake,
    stdout: () => out,
    stderr: () => err,
    alive,
    waitFor,
    waitForPlacement,
    latestPlacement,
    stop,
  }
}

/**
 * The last record the shell published under one of its `DSH_SHELL <NAME> {...}` prefixes.
 *
 * The shell states its own half of a fact on stdout (placements, the proxy its view session
 * resolves, …); reading it back here is how a test sees what the shell really resolved rather
 * than what the test expected it to resolve.
 *
 * @param stdout - the shell's accumulated stdout.
 * @param name - the record name, e.g. `PROXY`.
 * @returns the parsed record, or undefined when the shell has not published one.
 */
export function shellRecord<T>(stdout: string, name: string): T | undefined {
  const prefix = `DSH_SHELL ${name} `
  let latest: T | undefined
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(prefix)) continue
    try {
      latest = JSON.parse(trimmed.slice(prefix.length)) as T
    } catch {
      /* ignore a partially flushed line */
    }
  }
  return latest
}

/** One proxy reading the shell published for the view's session. */
export interface ProxyReading {
  /** The URL the reading was taken on. */
  url: string
  /** Electron's answer: `DIRECT`, or `PROXY host:port`. */
  result: string
}

/** What the shell published about the view session's proxy resolution. */
export interface ProxyRecord {
  /** Partition the readings came from. */
  partition: string
  /** One reading per probe URL. */
  readings: {
    external: ProxyReading
    loopback127: ProxyReading
    loopbackLocalhost: ProxyReading
    loopbackV6: ProxyReading
  }
}

/**
 * Every view placement the shell published, in order.
 *
 * The shell prints one `DSH_SHELL VIEW {...}` line per placement — this is how the
 * test sees the shell's own half of the rectangle channel, in the shell's own
 * process, rather than inferring it from the panel's side.
 *
 * @param stdout - the shell's accumulated stdout.
 * @returns the placements, in the order they were applied.
 */
export function viewPlacements(stdout: string): ViewPlacement[] {
  const placements: ViewPlacement[] = []
  for (const line of stdout.split('\n')) {
    const match = /^DSH_SHELL VIEW (.*)$/.exec(line.trim())
    if (match === null) continue
    try {
      placements.push(JSON.parse(match[1]) as ViewPlacement)
    } catch {
      /* ignore a partially flushed line */
    }
  }
  return placements
}

/**
 * Extract every child-process output chunk the shell forwarded.
 * @param stdout - the shell's accumulated stdout.
 * @returns the forwarded texts, in order.
 */
export function forwardedHostOutput(stdout: string): string[] {
  const texts: string[] = []
  for (const line of stdout.split('\n')) {
    const match = /^DSH_SHELL HOST_(?:STDOUT|STDERR) (.*)$/.exec(line.trim())
    if (match === null) continue
    try {
      texts.push((JSON.parse(match[1]) as { text: string }).text)
    } catch {
      /* ignore a partially flushed line */
    }
  }
  return texts
}
