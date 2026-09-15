import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  REPO_ROOT,
  launchShellProcess,
  makeTempDshHome,
  pageForTarget,
  removeWhenFree,
  repoPackageName,
  resolveDshBinScript,
  shellRecord,
  startShell,
  type ShellProcess,
  type TempDshHome,
} from './shell-harness.ts'

/**
 * 票 #12「一键起外壳 + 验收清单」—— 那三条验收里**能自动化的**部分。
 *
 * 这一份 spec 存在的理由：验收清单里最容易被写成"我说它行"的三句话，今天都没有真实证据：
 *
 *  1. **一条命令起完整桌面外壳**（自己拉起 DSH、系统挑端口、不开系统浏览器）。量到的现状是
 *     `npm run shell` 只起外壳 + 内置夹具，**根本没有 DSH** —— 而面板在没有外壳时给出的
 *     那句指引正是"运行 `npm run shell`"。所以这一条不是"补个断言"，是"把承诺做成真的"。
 *  2. **插件在真宿主里挂得上，而且工具真的进了宿主的注册表本体**。T10 证的是"**没有**外壳时
 *     能加载、插件自己调了 `register()`"；宿主那一侧的注册表从来没被读过。
 *  3. **截图真的交给部署自己的附件 store**。T5 用的是一枚测试替身 store；真实
 *     `LocalAttachmentStore` 从没跑过，也就没人证明过截图能**读回来**。
 *
 * 三条都落在**真 dsh 宿主 + 真 Electron 外壳**上，且都不碰用户自己的 `~/.dsh`：
 * 每个用例都现搭一个临时 `DSH_HOME`（`makeTempDshHome`），DSH 的 profile、会话、凭据
 * 全落在临时目录里，用完 `removeWhenFree` 收掉。
 *
 * 第 3 条还差最后一段——"模型真的看见那张图"要一次真的 agent 轮次（凭据 + 网络 + 花费），
 * 那一段**只能由用户和 Agent 对话来验**，写在 `docs/acceptance-checklist.md` 里。
 */

/** 本插件的包名：它在宿主里同时是插件 id 与启动图里的键。 */
const PACKAGE_NAME = repoPackageName()

/** `dsh` 自己的"我要打开系统默认浏览器了"那句话（`dsh-web-app/lib/startup.js` 里 `--no-open` 的对照面）。 */
const OPEN_BROWSER_NOTICE = 'opening the default browser'

/**
 * 起真宿主的用例要在这么长时间内看到 DSH 的地址。
 *
 * 真 `dsh` 的启动不是毫秒级的事（要 compose 整个 profile 树），给足余量；超时失败时
 * 报错里会带外壳 stdout 的全文（见 {@link ShellProcess.waitFor}）。
 */
const DSH_BOOT_TIMEOUT_MS = 180_000

/** 一条命令（`npm run shell`）用例的总预算：npm + electron + dsh 三段串起来。 */
const ONE_COMMAND_TIMEOUT_MS = 300_000

/** 读回 DSH 的 Web 界面时要用的口子。 */
interface DshUi {
  /** `/` 的 HTTP 状态码（带 cookie 那一次）。 */
  status: number
  /** 换 cookie 那一步的状态码：量到的回答是 303。 */
  grantStatus: number
  /** 拿到几个 cookie。 */
  cookies: number
  /** 页面字符数。 */
  htmlChars: number
  /** 启动图里有没有本插件。 */
  bootListsPlugin: boolean
  /** 启动图里那一条的原文，供人核对。 */
  bootEntry: string
  /** 启动图给本插件的客户端 bundle 地址。 */
  clientUrl: string | null
  /** 那个地址的 HTTP 状态码。 */
  clientStatus: number
  /** 端出来的 bundle 里有没有本插件的 id。 */
  clientIsThisPlugin: boolean
}

/**
 * 走用户走的那条路读 DSH 的界面：`?token=` 换 cookie（303 + `Set-Cookie`），再带 cookie 取 `/`。
 *
 * 这里**不**相信任何"外壳说它加载了 DSH"的说法：这个函数的所有返回值都来自 DSH 自己的 HTTP 回答。
 *
 * @param url - 外壳从 DSH 的 stdout 里解析出来的那条地址（带 token）。
 * @returns 读回来的事实。
 */
async function readDshUi(url: string): Promise<DshUi> {
  // Node 的 `fetch` 没有 cookie 罐，所以显式走两步：跟着 303 跳过去只会以未授权身份请求 `/`。
  const granted = await fetch(url, { redirect: 'manual' })
  const cookies = (granted.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
  const origin = new URL('/', url)
  const page = await fetch(origin, { headers: { cookie } })
  const html = await page.text()
  const bootId = `"id":"${PACKAGE_NAME}"`
  const at = html.indexOf(bootId)
  const clientMatch = at === -1 ? null : /\/plugins\/\?\?[^"]*client\.js[^"]*/.exec(html.slice(at))
  const clientUrl = clientMatch === null ? null : clientMatch[0].replace(/&amp;/g, '&')
  let clientStatus = 0
  let clientIsThisPlugin = false
  if (clientUrl !== null) {
    const bundle = await fetch(new URL(clientUrl, origin), { headers: { cookie } })
    clientStatus = bundle.status
    clientIsThisPlugin = bundle.status === 200 && (await bundle.text()).includes(`id: '${PACKAGE_NAME}'`)
  }
  return {
    status: page.status,
    grantStatus: granted.status,
    cookies: cookies.length,
    htmlChars: html.length,
    bootListsPlugin: at > -1,
    bootEntry: at === -1 ? '' : html.slice(Math.max(0, at - 40), at + 160),
    clientUrl,
    clientStatus,
    clientIsThisPlugin,
  }
}

/** 操作系统里的一条进程记录。 */
interface WinProcess {
  /** 进程号。 */
  ProcessId: number
  /** 父进程号。 */
  ParentProcessId: number
  /** 真实命令行（`Get-CimInstance Win32_Process` 的原值）。 */
  CommandLine: string | null
}

/**
 * 从**操作系统**读回进程表。
 *
 * 这是"外壳到底 spawn 了什么"的独立读回：它不经过我们的任何变量、也不经过外壳自己打印的
 * `DSH_SHELL DSH_ARGV`。本项目吃过"断言 argv 反而把 bug 锁死"的亏（`--dsh` 曾经起错 profile，
 * 而当时的 argv 断言把它锁住了），所以"实际启动了什么"必须有第二条、不共因的读回口。
 *
 * @returns 全表。
 */
function windowsProcesses(): WinProcess[] {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ' +
    'ConvertTo-Json -Compress -Depth 3'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`could not read the operating system's process table: ${result.stderr ?? ''}`)
  }
  const parsed = JSON.parse(result.stdout === '' ? '[]' : result.stdout) as WinProcess | WinProcess[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * 一棵进程树里的所有后代（不含树根自己）。
 *
 * @param root - 树根的 pid。
 * @param all - 进程表。
 * @returns 后代，顺序不保证。
 */
function descendantsOf(root: number, all: WinProcess[]): WinProcess[] {
  const found: WinProcess[] = []
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const process_ of all) {
      if (process_.ParentProcessId !== pid) continue
      found.push(process_)
      queue.push(process_.ProcessId)
    }
  }
  return found
}

/**
 * 这些进程**真正在监听**的回环端口（操作系统说的，不是我们说的）。
 *
 * @param pids - 要问的进程号。
 * @returns 监听项：地址、端口、持有它的进程号。
 */
function listeningPortsOf(pids: number[]): Array<{ address: string; port: number; pid: number }> {
  const script =
    `$pids = @(${pids.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ` +
    'Where-Object { $pids -contains $_.OwningProcess } | ' +
    'Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`could not read the listening ports: ${result.stderr ?? ''}`)
  const raw = (result.stdout ?? '').trim()
  if (raw === '') return []
  const parsed = JSON.parse(raw) as
    | { LocalAddress: string; LocalPort: number; OwningProcess: number }
    | Array<{ LocalAddress: string; LocalPort: number; OwningProcess: number }>
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((entry) => ({ address: entry.LocalAddress, port: entry.LocalPort, pid: entry.OwningProcess }))
}

/**
 * 等外壳把它从 DSH 的 stdout 里解析出来的地址打出来，然后把它读回来。
 *
 * @param shell - 跑着的外壳。
 * @param timeoutMs - 最多等多久。
 * @returns DSH 的 Web 界面地址（带 token）。
 */
async function waitForDshUrl(shell: ShellProcess, timeoutMs = DSH_BOOT_TIMEOUT_MS): Promise<string> {
  await shell.waitFor((out) => /^DSH_SHELL DSH_URL /m.test(out), 'the shell to print the DSH address', timeoutMs)
  const record = shellRecord<{ url: string }>(shell.stdout(), 'DSH_URL')
  if (record === undefined) throw new Error('the shell printed no parsable DSH_URL record')
  return record.url
}

/**
 * `npm run shell` 这条命令的入口脚本。
 *
 * 为什么不直接 spawn `npm`：在 Windows 上 `npm` 是 `.cmd`，Node 起它要么经过 shell（引号地狱）、
 * 要么被 EINVAL 挡掉。`process.execPath` + npm 自己的 CLI 脚本是**同一条命令**（npm 照样把
 * `node_modules/.bin` 加进 PATH，所以脚本里的 `electron` 照样解析得到），只是没有中间那层 shell。
 *
 * @returns npm CLI 脚本的绝对路径。
 */
function npmCliScript(): string {
  const fromNpm = process.env.npm_execpath
  if (fromNpm !== undefined && fromNpm !== '' && existsSync(fromNpm)) return fromNpm
  const beside = join(join(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside)) return beside
  throw new Error(
    'this test runs the repository\'s own `npm run shell` command, so it needs npm\'s CLI script: ' +
      'run the suite through `npm test` (npm sets npm_execpath), or keep npm installed next to node',
  )
}

describe('票 #12 · 一条命令起完整桌面外壳', () => {
  let home: TempDshHome
  let userDataDir: string
  let shell: ShellProcess
  let dshUrl: string
  let ui: DshUi
  /** 外壳自己打印的 `DSH_ARGV`（它的意图），与下面那份进程表（事实）对照着看。 */
  let declared: { command: string; argv: string[] } | undefined
  /** 外壳这棵进程树里真实跑着的进程。 */
  let tree: WinProcess[] = []
  /** 那棵树上真实在监听的回环端口。 */
  let listening: Array<{ address: string; port: number; pid: number }> = []

  beforeAll(async () => {
    if (resolveDshBinScript() === undefined) {
      throw new Error(
        'this test needs the `dsh` launcher on PATH (or DSH_BIN pointing at @deepseek-ai/dsh/lib/bin.js): ' +
          'ticket #12 acceptance #1 is about ONE command starting the whole shell, DSH included, and ' +
          'a skipped check would be exactly the silent failure this suite refuses',
      )
    }
    home = makeTempDshHome({ profile: 'dshviewer' })
    userDataDir = mkdtempSync(join(tmpdir(), 'dsh-t12-shell-'))
    // 用户会敲的那一条命令。`--` 后面那两个参数是**测试的隔离手段**，不是产品的一部分：
    // `DSH_HOME` 把 DSH 的档案挪进临时目录，`--user-data-dir` 把浏览器档案也挪走，
    // 于是用户自己的 `~/.dsh` 与他的登录态一个字节都不动。
    shell = await launchShellProcess({
      command: process.execPath,
      argv: [npmCliScript(), 'run', 'shell', '--', '--user-data-dir', userDataDir],
      userDataDir,
      ownedProfile: false,
      options: { env: { DSH_HOME: home.home }, timeoutMs: ONE_COMMAND_TIMEOUT_MS },
    })
    dshUrl = await waitForDshUrl(shell)
    ui = await readDshUi(dshUrl)
    declared = shellRecord<{ command: string; argv: string[] }>(shell.stdout(), 'DSH_ARGV')

    // 进程表必须在进程还活着的时候读。
    const rootPid = shell.child.pid
    if (rootPid === undefined) throw new Error('the shell process has no pid')
    const all = windowsProcesses()
    tree = [all.find((process_) => process_.ProcessId === rootPid), ...descendantsOf(rootPid, all)].filter(
      (process_): process_ is WinProcess => process_ !== undefined,
    )
    listening = listeningPortsOf(tree.map((process_) => process_.ProcessId))
    console.log('RAW npm run shell children: ' + JSON.stringify(tree.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine })), null, 2))
    console.log('RAW listening ports of that tree: ' + JSON.stringify(listening))
  }, ONE_COMMAND_TIMEOUT_MS)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (home !== undefined) home.remove()
    if (userDataDir !== undefined) removeWhenFree(userDataDir)
  })

  it('外壳自己拉起了 DSH：界面读得回，插件在启动图里，bundle 端得出来', async () => {
    console.log('RAW shell stdout (tail): ' + JSON.stringify(shell.stdout().slice(-2000)))
    console.log('RAW DSH UI as DSH itself answers: ' + JSON.stringify(ui))
    console.log('RAW DSH_URL: ' + JSON.stringify(dshUrl.replace(/token=[^&]*/, 'token=…')))

    // DSH 是**外壳自己起的**：`?token=` 这张票只有 DSH 能发，`__DSH_BOOT__` 也只有它写得出来。
    expect(ui.grantStatus, 'the token must be exchanged for a session cookie').toBe(303)
    expect(ui.cookies).toBeGreaterThan(0)
    expect(ui.status).toBe(200)
    expect(ui.htmlChars).toBeGreaterThan(1000)
    // 插件真的在这个宿主的启动图里，而且它的客户端 bundle 端得出来（"挂得上"的第一层）。
    expect(ui.bootListsPlugin, 'the host must list this plugin in its client boot graph').toBe(true)
    expect(ui.clientStatus).toBe(200)
    expect(ui.clientIsThisPlugin).toBe(true)
  }, 120_000)

  it('外壳的窗口里装的确实是 DSH 的界面，不是内置夹具页', async () => {
    // 上一条证的是"DSH 在某个地址上端出了界面"；这一条证的是"**外壳把那个界面装进了自己的窗口**"。
    // 少了它，"一条命令起完整桌面外壳"就还差半步：DSH 起来了，但窗口里可能仍是夹具页。
    const windowTargetId = shell.handshake.windowTargetId
    expect(windowTargetId, 'the shell must publish which of its pages is the window').toBeDefined()
    const opened = await pageForTarget(shell.handshake.cdpUrl, windowTargetId as string)
    try {
      const origin = new URL(dshUrl).origin
      // 握手与 `DSH_URL` 都在 `loadURL` **之前**打印，所以这里等窗口真的走到那个 origin。
      await opened.page.waitForFunction((expected) => location.origin === expected, origin, { timeout: 60_000 })
      const seen = await opened.page.evaluate(() => ({
        href: location.href,
        title: document.title,
        bodyElements: document.body.childElementCount,
        bodyChars: (document.body.innerText ?? '').length,
      }))
      console.log('RAW the shell window page, read from the window itself: ' + JSON.stringify(seen))

      expect(new URL(seen.href).origin).toBe(origin)
      // 夹具页在 `<夹具 origin>/shell` 上：窗口走到 DSH 的 origin 就意味着它不是夹具页。
      expect(seen.href).not.toContain(shell.handshake.fixtureOrigin)
      expect(seen.bodyElements, 'the DSH UI must have rendered something into the window').toBeGreaterThan(0)
    } finally {
      await opened.browser.close()
    }
  }, 120_000)

  it('端口是系统挑的：DSH 真正绑上的那个端口，由它自己的进程在监听', () => {
    const port = Number(new URL(dshUrl).port)
    console.log('RAW port from the DSH address: ' + port)

    // 1. 外壳**声明**的 argv：`--port 0` 是"让系统挑"，但这一条单独证明不了任何事
    //    （本项目吃过 argv 断言把 bug 锁死的亏），所以它只是两条证据里较弱的那条。
    expect(declared, 'the shell must publish the argv it used').toBeDefined()
    expect(declared?.argv).toEqual(['--profile', 'dshviewer', '--no-open', '--port', '0'])
    // 2. 操作系统里那个 **dsh 进程**自己被 spawn 出来的命令行：独立于外壳的任何变量。
    const dshProcesses = tree.filter((process_) => /dsh/i.test(process_.CommandLine ?? '') && /--port/i.test(process_.CommandLine ?? ''))
    console.log('RAW dsh processes in the tree: ' + JSON.stringify(dshProcesses.map((p) => p.CommandLine)))
    expect(dshProcesses.length, 'the tree must really contain a dsh child process').toBeGreaterThan(0)
    for (const process_ of dshProcesses) {
      expect(process_.CommandLine ?? '').toContain('--no-open')
      expect(process_.CommandLine ?? '').toMatch(/--port\s+0\b/)
    }
    // 3. 而**真正被绑上的**那个端口，是操作系统说的：持有它的正是这棵树里的进程。
    //    端口是 0 的话这一条会红，因为没有任何进程会"监听 0 号端口"。
    expect(port).toBeGreaterThan(1024)
    const owner = listening.find((entry) => entry.port === port)
    console.log('RAW who listens on that port: ' + JSON.stringify(owner ?? null))
    expect(owner, `the OS must report the DSH port ${port} as listened on by this process tree`).toBeDefined()
    expect(tree.map((process_) => process_.ProcessId)).toContain(owner?.pid)
  }, 60_000)

  it('不打开系统默认浏览器：开关在真 argv 里，而 DSH 那句"要开浏览器了"没有出现', () => {
    console.log('RAW child output the shell forwarded (first 1200 chars): ' + JSON.stringify(shell.stdout().slice(0, 1200)))

    // 这条**能**证明什么、不能证明什么，写清楚：
    //   能：外壳交给 DSH 的命令行里有 `--no-open`（进程表读回的原文），而 DSH 的
    //       `--no-open` 自己对应的那句提示（`dsh-web-app/lib/startup.js`：
    //       `dsh web: opening the default browser; pass --no-open to disable`）在整个输出里不出现；
    //       这棵树里也没有任何浏览器进程。
    //   不能：这里没有一个口子能观察"屏幕上没有多出一个浏览器窗口"——那需要用户自己看，
    //       所以它是一个**用户可见的**验收项，而不是自动化的结论。
    expect(declared?.argv).toContain('--no-open')
    expect(shell.stdout()).not.toContain(OPEN_BROWSER_NOTICE)
    expect(shell.stderr()).not.toContain(OPEN_BROWSER_NOTICE)
    const browserLike = tree.filter((process_) => /(msedge|chrome\.exe|firefox|brave\.exe|opera\.exe|safari)/i.test(process_.CommandLine ?? ''))
    console.log('RAW browser-like processes in the tree: ' + JSON.stringify(browserLike.map((p) => p.CommandLine)))
    expect(browserLike).toEqual([])
  }, 60_000)
})

describe('票 #12 · 不抢端口：两个外壳同时起，各自的 DSH 与视图都读得回', () => {
  let homeA: TempDshHome
  let homeB: TempDshHome
  let dirA: string
  let dirB: string
  let shellA: ShellProcess
  let shellB: ShellProcess
  let urlA: string
  let urlB: string
  let uiA: DshUi
  let uiB: DshUi

  beforeAll(async () => {
    // 两份独立的临时 home：两个外壳各自起自己的 DSH，各用各的档案，谁都不等谁。
    homeA = makeTempDshHome({ profile: 'dshviewer' })
    homeB = makeTempDshHome({ profile: 'dshviewer' })
    dirA = mkdtempSync(join(tmpdir(), 'dsh-t12-two-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'dsh-t12-two-b-'))
    shellA = await startShell(['--dsh'], {
      userDataDir: dirA,
      env: { DSH_HOME: homeA.home },
      timeoutMs: ONE_COMMAND_TIMEOUT_MS,
    })
    urlA = await waitForDshUrl(shellA)
    // B 在 A **还活着**的时候起：这才是"同时两个"。
    shellB = await startShell(['--dsh'], {
      userDataDir: dirB,
      env: { DSH_HOME: homeB.home },
      timeoutMs: ONE_COMMAND_TIMEOUT_MS,
    })
    urlB = await waitForDshUrl(shellB)
    expect(shellA.alive(), 'the first shell must still be up when the second one starts').toBe(true)
    uiA = await readDshUi(urlA)
    uiB = await readDshUi(urlB)
    console.log('RAW two shells at once: ' + JSON.stringify({ a: { cdp: shellA.handshake.cdpUrl, dsh: urlA.replace(/token=[^&]*/, 'token=…'), target: shellA.handshake.targetId, fixture: shellA.handshake.fixtureOrigin, alive: shellA.alive() }, b: { cdp: shellB.handshake.cdpUrl, dsh: urlB.replace(/token=[^&]*/, 'token=…'), target: shellB.handshake.targetId, fixture: shellB.handshake.fixtureOrigin, alive: shellB.alive() } }, null, 2))
  }, 2 * ONE_COMMAND_TIMEOUT_MS)

  afterAll(async () => {
    if (shellA !== undefined) await shellA.stop()
    if (shellB !== undefined) await shellB.stop()
    if (homeA !== undefined) homeA.remove()
    if (homeB !== undefined) homeB.remove()
    if (dirA !== undefined) removeWhenFree(dirA)
    if (dirB !== undefined) removeWhenFree(dirB)
  })

  it('两个 DSH 同时活着，各自的界面都读得回，端口一个都不撞', () => {
    const portA = new URL(urlA).port
    const portB = new URL(urlB).port
    const cdpA = new URL(shellA.handshake.cdpUrl).port
    const cdpB = new URL(shellB.handshake.cdpUrl).port
    const fixtureA = new URL(shellA.handshake.fixtureOrigin).port
    const fixtureB = new URL(shellB.handshake.fixtureOrigin).port
    console.log('RAW the six ports: ' + JSON.stringify({ dshA: portA, dshB: portB, cdpA, cdpB, fixtureA, fixtureB }))

    expect(shellA.alive() && shellB.alive(), 'both shells must be running at the same time').toBe(true)
    expect(uiA.status).toBe(200)
    expect(uiB.status).toBe(200)
    expect(uiA.bootListsPlugin && uiB.bootListsPlugin).toBe(true)
    // "不抢端口"的实证：六个端口两两不同 —— 没有任何一个外壳去要一个固定端口，
    // 也没有谁把谁挤掉（两个界面都真的端出来了）。
    expect(new Set([portA, portB, cdpA, cdpB, fixtureA, fixtureB]).size).toBe(6)
  }, 120_000)

  it('各自的视图也是各自的：两个不同的 CDP 目标，两个不同端口的夹具站点', async () => {
    // 读回"那一格真的存在"，而不是"外壳说它建了一块视图"：连上各自的可编程端点，
    // 按 targetId 找到那块视图，问它自己的页面标题。
    const titles: string[] = []
    for (const shell of [shellA, shellB]) {
      const opened = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
      try {
        titles.push(await opened.page.title())
      } finally {
        await opened.browser.close()
      }
    }
    console.log('RAW view titles read back through each shell own endpoint: ' + JSON.stringify(titles))

    expect(shellA.handshake.targetId).not.toBe(shellB.handshake.targetId)
    expect(shellA.handshake.fixtureOrigin).not.toBe(shellB.handshake.fixtureOrigin)
    expect(titles).toEqual(['view-page', 'view-page'])
  }, 120_000)
})

/** 探针写出来的那一份报告（字段见 `tests/fixtures/dsh-probe/index.js`）。 */
interface ProbeReport {
  /** 探针看到的 `DSH_DESKTOP_VIEW_*`（外壳交给载体的那份身份）。 */
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
 * @param file - 探针的报告文件。
 * @param timeoutMs - 最多等多久。
 * @returns 解析好的报告。
 */
async function waitForProbe(file: string, timeoutMs: number): Promise<ProbeReport> {
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

describe('票 #12 · 真宿主里：注册表本体、真的驱动那一格、截图进真实附件 store', () => {
  let home: TempDshHome
  let userDataDir: string
  let probeDir: string
  let shell: ShellProcess
  let probe: ProbeReport

  beforeAll(async () => {
    // 探针以一个**额外 bundle** 的形式装进这个临时 profile（形状与用户装本插件的方式同形）。
    home = makeTempDshHome({
      profile: 'dshviewer',
      extraBundles: [{ name: 'dsh-t12-probe', dir: join(REPO_ROOT, 'tests', 'fixtures', 'dsh-probe') }],
    })
    userDataDir = mkdtempSync(join(tmpdir(), 'dsh-t12-probe-shell-'))
    probeDir = mkdtempSync(join(tmpdir(), 'dsh-t12-probe-out-'))
    const probeFile = join(probeDir, 'probe.json')
    shell = await startShell(['--dsh'], {
      userDataDir,
      env: {
        DSH_HOME: home.home,
        DSH_T12_PROBE_OUT: probeFile,
        // 截图落哪也由用例指定：工具默认落在**宿主进程的 cwd**（外壳起宿主时就是仓库根），
        // 不指定的话一次测试就往仓库里丢一张 PNG。
        DSH_T12_PROBE_SHOT: join(probeDir, 'probe-screenshot.png'),
        DSH_T12_PROBE_TIMEOUT_MS: '180000',
      },
      timeoutMs: ONE_COMMAND_TIMEOUT_MS,
    })
    await waitForDshUrl(shell)
    probe = await waitForProbe(probeFile, DSH_BOOT_TIMEOUT_MS)
    console.log('RAW probe report: ' + JSON.stringify(probe, null, 2))
    console.log('RAW shell stdout (tail): ' + JSON.stringify(shell.stdout().slice(-1500)))
  }, 2 * ONE_COMMAND_TIMEOUT_MS)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (home !== undefined) home.remove()
    if (userDataDir !== undefined) removeWhenFree(userDataDir)
    if (probeDir !== undefined) removeWhenFree(probeDir)
  })

  it('探针拿到的是外壳交给载体的那份身份，而且壳里的工具注册表本体有这些工具', () => {
    const registry = probe.steps.find((step) => step.step === 'registry') as
      | { names: string[]; count: number; byGet: Record<string, boolean> }
      | undefined
    expect(registry, 'the probe must have read the registry back').toBeDefined()
    const names = registry?.names ?? []
    console.log('RAW registry names read from the host: ' + JSON.stringify(names))
    // 这几条是**宿主那一侧**的回答（`ctx.tools.schemas()` 是宿主服务自己的方法），
    // 不是"插件调了 register()"（T10 读的是后者）。
    for (const required of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_extract',
      'browser_evaluate',
      'browser_screenshot',
      'browser_space',
    ]) {
      expect(names, `the host registry must carry ${required}`).toContain(required)
    }
    expect(names.length).toBeGreaterThanOrEqual(20)
    expect(registry?.byGet.browser_screenshot).toBe(true)
    expect(probe.shellEnvironment.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(probe.shellEnvironment.spacesDir).toBeTruthy()
  }, 60_000)

  it('经宿主注册表执行：快照、点击真的改了那一格的页面', async () => {
    const byName = (name: string): ProbeReport['toolCalls'][number] | undefined =>
      probe.toolCalls.find((call) => call.tool === name && call.threw === undefined)
    const where = byName('browser_evaluate')
    const snapshot = byName('browser_snapshot')
    const click = byName('browser_click')
    const extracts = probe.toolCalls.filter((call) => call.tool === 'browser_extract')
    console.log('RAW where the tools acted: ' + JSON.stringify(where?.value ?? null))
    console.log('RAW snapshot value: ' + JSON.stringify(snapshot?.value ?? null))
    console.log('RAW click result: ' + JSON.stringify(click ?? null))
    console.log('RAW extract before/after: ' + JSON.stringify(extracts.map((call) => call.value)))

    // 工具真的落在了外壳那块视图上：它报的地址就是外壳握手里的视图地址。
    expect(String(where?.value ?? '')).toContain(shell.handshake.viewUrl)
    expect(snapshot?.isError ?? true).toBe(false)
    expect(click?.isError ?? true).toBe(false)
    expect(extracts.length).toBeGreaterThanOrEqual(2)
    // 点击**真的改了页面**：两次正文不同，而且外壳夹具上那个按钮的效果词出现了。
    expect(JSON.stringify(extracts[0]?.value ?? null)).not.toBe(JSON.stringify(extracts[1]?.value ?? null))
    expect(JSON.stringify(extracts[1]?.value ?? null)).toContain('clicked-view')
  }, 60_000)

  it('截图交给的是真实附件 store：能按引用读回来，字节数与 PNG 魔数都对得上', () => {
    console.log('RAW attachment read-back: ' + JSON.stringify(probe.attachment))
    const attachment = probe.attachment ?? {}
    const screenshot = probe.toolCalls.find((call) => call.tool === 'browser_screenshot')
    // 落盘位置是调用方指定的那一个，不是"随手落在哪都行"。
    expect(String((screenshot?.value as { path?: string } | undefined)?.path ?? '')).toContain(probeDir)
    // T5 的证据用的是一枚测试替身 store（`saveImage` 是测试自己实现的）。这里 `saveImage`
    // 与 `readImage` 都是**部署自己的**那一份：图片只有真的落进内容寻址存储，才读得回同样多的字节。
    expect(attachment.error, 'the screenshot must reach an attachment store that can read it back').toBeUndefined()
    expect(Number(attachment.declaredBytes)).toBeGreaterThan(0)
    expect(Number(attachment.readBackBytes)).toBe(Number(attachment.declaredBytes))
    expect(attachment.mediaType).toBe('image/png')
    expect(attachment.pngMagic).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    // 内容寻址的引用（本机实现带 `sha256:` 前缀）：读回来的那个 id 就是截图时拿到的那个。
    expect(String(attachment.attachmentId ?? '')).toMatch(/^(sha256:)?[0-9a-f]{64}$/)
  }, 60_000)

  it('任务空间在外壳的通道上说得清（真宿主 + 真外壳）', () => {
    const spaceCall = probe.toolCalls.find((call) => call.tool === 'browser_space')
    console.log('RAW browser_space answer: ' + JSON.stringify(spaceCall ?? null))
    expect(spaceCall, 'the probe must have asked the shell about its spaces').toBeDefined()
    expect(spaceCall?.threw).toBeUndefined()
    expect(spaceCall?.isError ?? true).toBe(false)
    expect(JSON.stringify(spaceCall?.value ?? null)).toContain('default')
  }, 60_000)
})
