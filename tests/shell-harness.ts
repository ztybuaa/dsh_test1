import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  /** Terminate the shell and its descendants, and drop the temporary profile. */
  stop: () => Promise<void>
}

/** Default time to wait for the shell to publish its handshake. */
const START_TIMEOUT_MS = 90_000

/**
 * Launch the Electron shell and wait for it to publish the view identity.
 * @param args - extra shell arguments.
 * @param options - timeout override.
 * @returns the running shell.
 */
export async function startShell(
  args: string[] = [],
  options: { timeoutMs?: number } = {},
): Promise<ShellProcess> {
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS
  // A per-run profile keeps concurrent runs (and the developer's own profile) untouched.
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-test-'))
  const child = spawn(electronExecutable(), [SHELL_MAIN, '--user-data-dir', userDataDir, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
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

  const stop = async (): Promise<void> => {
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
    rmSync(userDataDir, { recursive: true, force: true })
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

  return {
    child,
    handshake,
    stdout: () => out,
    stderr: () => err,
    alive,
    waitFor,
    stop,
  }
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
