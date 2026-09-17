import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    /**
     * 外壳写、插件读：它真正下载了什么、落在哪（ADR-0011）。
     *
     * 与 `stateFile` **同方向、同目录**：这是既有通道上的一个新文件，不是一条新通道。
     */
    downloadJournalFile: string
    /** Partitions whose directories are to be removed at the next startup. */
    pendingDeletionFile: string
    /** Protocol version, so a stale pair can be told apart. */
    protocol: number
  }
  /**
   * 下载落在哪（ADR-0011）：`<userDataDir>/downloads`。
   *
   * 它是外壳**说过的一句话**，所以测试可以直接拿它来断言"文件的落盘位置在外壳说的那个
   * 目录里"，而不是从别处推断。
   */
  downloadsDir: string
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
  /**
   * 外壳对这个 `targetId` 怎么来的说的话（`resolved` / `remembered` / `unavailable`）。
   * 缺省 = 旧外壳没说，**不**当成"解析到了"。
   */
  targetIdSource?: 'resolved' | 'remembered' | 'unavailable'
  /** 外壳给的原因（`remembered` / `unavailable` 时都有）：读不到目标时它是唯一说得清的那句话。 */
  targetIdReason?: string
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
  /**
   * 面板**原样报上来的**那个矩形（未经窗口裁剪），或 null。
   *
   * 与 `bounds` 分开：`bounds` 是外壳决定要用的那个（已经被窗口裁过），而这一份是"面板说
   * 这一格有多大"。票 #19 的用例要等"拖动真的把栏拖到了 620" —— 那个 620 是**报上来**的那个数，
   * 而一件宽过窗口的矩形（比如 1240 的栏在 1226 的窗口里）被裁过之后就不是它了。
   */
  reported?: { x: number; y: number; width: number; height: number } | null
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
 * **Exported, and the only removal path the suite uses.** The trap was entered twice: this
 * retry existed for T5, but it was private to this file, so T7's new spec wrote a bare
 * `rmSync` in its own `afterAll` and reproduced the identical failure —
 * `Test Files 1 failed | 7 passed` with `Tests 77 passed (77)`, `EPERM` at
 * `tests/spaces.spec.ts:467` (raw output in docs/research/suite-flake-two-signatures.md).
 * A cleanup path that is copied instead of shared is how a fixed bug comes back.
 *
 * @param dir - the directory to remove.
 */
export function removeWhenFree(dir: string): void {
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

/**
 * 找到 `dsh` 启动器真正要跑的脚本（`@deepseek-ai/dsh/lib/bin.js`）。
 *
 * 走 PATH 上的 `dsh` 垫片而不是把本机的绝对路径写进仓库：垫片就在安装目录顶层，
 * 它指向的 `node_modules/@deepseek-ai/dsh/lib/bin.js` 是启动器本体。`DSH_BIN` 可以
 * 直接指定本体，供装在别处的人用。
 *
 * @returns 绝对路径，找不到时 undefined。
 */
export function resolveDshBinScript(): string | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit
  const located = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const first = (located.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')[0]
  if (first === undefined) return undefined
  const candidate = join(dirname(first), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : undefined
}

/** 本仓库的包名：它在宿主里同时是插件 id 与启动图里的键。 */
export function repoPackageName(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name?: string }
  if (typeof manifest.name !== 'string') throw new Error('package.json has no name')
  return manifest.name
}

/** 一个临时 harness home，以及它那个装好本插件的 profile。 */
export interface TempDshHome {
  /** 临时 `DSH_HOME`：把它交给外壳，DSH 的一切就都落在这里，用户自己的 `~/.dsh` 一个字节都不碰。 */
  home: string
  /** profile 名（`dsh --profile <name>`）。 */
  profile: string
  /** profile 目录（`<home>/profiles/<name>`）。 */
  profileDir: string
  /** 删掉整个临时 home。**只能走 `removeWhenFree`**（Windows 上句柄还没释放时裸删会 EPERM）。 */
  remove: () => void
}

/**
 * 现搭一个临时 `DSH_HOME`，里面有一个装好本插件的 profile。
 *
 * 形状照用户 `~/.dsh/profiles/dshviewer` 抄：`dependencies` 里是本仓库的 `link:`，
 * `node_modules` 里是指向仓库的目录联接，`dsh.profile.bundles` 列三个 bundle。
 * `@deepseek-ai/dsh-base` / `dsh-web-app` 由启动器自己解析（它们在 dsh 包内部），
 * 所以不用为它们建联接。
 *
 * @param options - profile 名，以及要额外挂上去的 bundle（票 #12 的探针就是这样一个）。
 * @returns 临时 home 的描述与清理口。
 */
export function makeTempDshHome(options: {
  profile: string
  extraBundles?: Array<{ name: string; dir: string }>
}): TempDshHome {
  const name = repoPackageName()
  const extra = options.extraBundles ?? []
  const link = (dir: string): string => `link:${dir.replace(/\\/g, '/')}`
  const home = mkdtempSync(join(tmpdir(), 'dsh-t12-home-'))
  const profileDir = join(home, 'profiles', options.profile)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: `dsh-profile-${options.profile}`,
        private: true,
        dependencies: {
          [name]: link(REPO_ROOT),
          ...Object.fromEntries(extra.map((bundle) => [bundle.name, link(bundle.dir)])),
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', name, ...extra.map((b) => b.name)],
            patchReload: 'live',
          },
        },
      },
      undefined,
      2,
    ) + '\n',
  )
  // 用户层 patch 是空的：本插件的配置只能来自外壳给的环境变量（这正是"外壳起了没有"的判据）。
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  symlinkSync(REPO_ROOT, join(profileDir, 'node_modules', name), 'junction')
  for (const bundle of extra) symlinkSync(bundle.dir, join(profileDir, 'node_modules', bundle.name), 'junction')
  return { home, profile: options.profile, profileDir, remove: () => removeWhenFree(home) }
}

/** Options accepted by {@link startShell}. */
export interface StartShellOptions {
  /** How long to wait for the handshake. */
  timeoutMs?: number
  /** Window size, e.g. `{width: 900, height: 600}`. Defaults to the shell's own. */
  windowSize?: { width: number; height: number }
  /**
   * Working directory of the shell process. Defaults to the repository root.
   *
   * 票 #16 需要它：宿主 `dsh` 是外壳的**子进程**，它的 cwd 是继承来的。把外壳的 cwd 指到一个
   * 临时目录，"宿主进程的 cwd 到底是什么、它里面会不会多出文件"就能被独立读回，
   * 而且失败的那一次也不会往仓库里写任何东西。
   */
  cwd?: string
  /**
   * Profile directory to use instead of the per-run temporary one.
   *
   * The caller owns it: it is **not** removed by {@link ShellProcess.stop}. That is what
   * makes "the login survives a restart" observable at all — the second run has to be
   * handed the same profile as the first, and the profile has to outlive the first shell.
   */
  userDataDir?: string
  /**
   * 追加/覆盖外壳进程自己的环境变量。
   *
   * 票 #12 需要它：外壳用 `--dsh` 起的子进程继承**外壳自己的**环境，所以"别碰用户
   * `~/.dsh`"这件事只能在外壳这一层做——把 `DSH_HOME` 指到临时 harness home 上，
   * DSH 就会把 profile、会话、凭据全写在临时目录里。
   */
  env?: NodeJS.ProcessEnv
  /**
   * 让外壳的窗口**真的显示出来**（票 #13 的像素验收要它）。
   *
   * 缺省（false）用 `windowsHide: true` 起外壳 —— 那是本套件一直以来的做法，也**只有在那种
   * 情况下**窗口才不出现在屏幕/窗口枚举里：实测 `windowsHide: true` 会让 Windows 把该进程的
   * 第一个顶层窗口按 `SW_HIDE` 建出来，于是布局、CDP、发布的状态**一切照常**，只是没有画面。
   *
   * 量像素的那条路必须把它设成 true：没有真实画面就没有"用户在窗格里看到什么"这回事。
   */
  windowVisible?: boolean
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
  const sizeArgs =
    options.windowSize === undefined
      ? []
      : // `--window-size` reuses the rectangle parser; only width and height are read.
        ['--window-size', `0,0,${options.windowSize.width},${options.windowSize.height}`]
  // A per-run profile keeps concurrent runs (and the developer's own profile) untouched —
  // unless the caller needs the same profile twice, in which case it owns the directory.
  const ownedProfile = options.userDataDir === undefined
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-test-'))
  return launchShellProcess({
    command: electronExecutable(),
    argv: [SHELL_MAIN, '--user-data-dir', userDataDir, ...sizeArgs, ...args],
    userDataDir,
    ownedProfile,
    options,
  })
}

/** {@link launchShellProcess} 的输入：一条命令、它的参数，以及谁拥有那个档案目录。 */
export interface LaunchShellInput {
  /** 要跑的可执行文件（默认路径下是 Electron 本身）。 */
  command: string
  /** 完整参数，已经拼好——这里不再补 `shell/main.js`。 */
  argv: string[]
  /** 本次运行用的档案目录。 */
  userDataDir: string
  /** 档案目录是不是这次调用自己建的（是的话 {@link ShellProcess.stop} 会删掉它）。 */
  ownedProfile: boolean
  /** 超时与环境变量。 */
  options: StartShellOptions
}

/**
 * 起一个"会把握手打到 stdout"的外壳进程，并等它的第一行握手。
 *
 * {@link startShell} 是它的常规用法（Electron + `shell/main.js`）。票 #12 需要它多做一件事：
 * **跑一条真正的命令**（`npm run shell`），因为那张票的验收就是"一条命令起得来"——
 * 只断言 `package.json` 里那个字符串，等于把一个可能写错的命令锁进测试里。
 *
 * @param input - 命令、参数、档案目录与环境。
 * @returns 跑起来的外壳。
 */
export async function launchShellProcess(input: LaunchShellInput): Promise<ShellProcess> {
  const { options, userDataDir, ownedProfile } = input
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS
  const child = spawn(
    input.command,
    input.argv,
    {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 只有"要量像素"的那条路才把窗口显示出来（见 {@link StartShellOptions.windowVisible}）。
      windowsHide: options.windowVisible !== true,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
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

/** 探针写出来的那一份报告（字段见 `tests/fixtures/dsh-probe/index.js`）。 */
export interface ProbeReport {
  /** 探针看到的 `DSH_DESKTOP_VIEW_*`（外壳交给载体的那份身份），加上它自己的 cwd。 */
  shellEnvironment: Record<string, string | null>
  /** 按步骤记下的事实。 */
  steps: Array<Record<string, unknown>>
  /** 经宿主注册表执行的每一次工具调用。 */
  toolCalls: Array<{
    tool: string
    isError?: boolean
    error?: unknown
    threw?: string
    value?: unknown
    content?: unknown
  }>
  /** 附件读回的结果。 */
  attachment: Record<string, unknown> | null
  /** 探针是否跑完了。 */
  done: boolean
  /** 探针自己炸了的话，原因在这里。 */
  fatal?: string
}

/**
 * 等探针把 `done: true` 写出来。
 *
 * **放在这里，不放在某个 spec 里**：票 #12 与票 #16 各要起一次真宿主、各要读同一份报告，
 * 两处各抄一遍的话，"报告还没写完"这件事迟早会有一处处理得不一样（本仓库为同一形状的复制
 * 付过代价，见 {@link removeWhenFree}）。
 *
 * @param file - 探针的报告文件。
 * @param timeoutMs - 最多等多久。
 * @returns 解析好的报告。
 */
export async function waitForProbe(file: string, timeoutMs: number): Promise<ProbeReport> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      const raw = readFileSync(file, 'utf8')
      last = raw
      const parsed = JSON.parse(raw) as ProbeReport
      if (parsed.done === true) return parsed
      if (typeof parsed.fatal === 'string') throw new Error(`the probe failed: ${parsed.fatal}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('the probe failed')) throw error
      // 文件还没出现，或者正读到一半：接着等。
    }
    if (Date.now() >= deadline) {
      throw new Error(`the probe did not finish within ${timeoutMs}ms; last report was:\n${last}`)
    }
    await new Promise((settle) => setTimeout(settle, 250))
  }
}
