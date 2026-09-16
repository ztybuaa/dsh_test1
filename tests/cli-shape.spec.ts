import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  REPO_ROOT,
  SHELL_MAIN,
  electronExecutable,
  pageForTarget,
  removeWhenFree,
  startShell,
  type ShellProcess,
} from './shell-harness.ts'

/**
 * 票 #14 —— "照 README 抄下来的命令会把外壳弄死"。
 *
 * 现象：`npx electron shell/main.js --url https://example.com --view-url https://example.org`
 * 让 electron.exe 在**应用代码跑起来之前**退出：**零输出**、退出码 `0xFFFFFFFF`。
 *
 * 这条 bug 只能靠"文档只用已证明安全的形状" + "一条跑文档命令的守卫"来挡，因为失败发生在
 * 应用代码**之前** —— `shell/args.js` 里的 argv 校验永远不会执行，**外壳运行时救不了自己**。
 * 所以这里不测外壳的行为，测的是**文档的形状**：
 *
 *  1. **规则本体**（纯函数）：把本轮实测刻画的判据编码下来，两边样本都钉住（会死的 / 不会死的）；
 *  2. **文档门禁**：`README.md` 与 `--help` 里**每一条**外壳命令都必须是已证明安全的形状；
 *  3. **动态守卫**：把 README 里那条命令原样拿来跑（只把 URL **值**换成本机回环地址，
 *     token 个数 / 开关名 / `=` / 顺序一字不动），必须拿到握手、两个 URL 都真的生效；
 *  4. **反证**：同一个 URL 值、换成**旧形状**，必须秒退 `0xFFFFFFFF` 且零输出 ——
 *     这一条红了，说明第 3 条守的正是那个坑；它要是**不再**红，说明 Electron 改了行为，
 *     `docs/research/t14-cli-url-token-kills-electron.md` 里的规则要重新量一遍。
 *
 * 规则表、原始输出与"没能验证到什么"的清单都在
 * `docs/research/t14-cli-url-token-kills-electron.md`。
 */

const require = createRequire(import.meta.url)

/** `shell/args.js`：命令行解析与 `--help` 文本（纯逻辑，不 require('electron')）。 */
const shellArgs = require('../shell/args.js') as {
  parseArgv: (argv: string[]) => { windowUrl?: string; viewUrl?: string; useDsh: boolean; bounds: { x: number } }
  usage: () => string
}

/**
 * 一个独立 token 是不是"看起来像 URL"。
 *
 * 判据按本轮实测：**`<字母><字母数字/+/-/. 至少一个>:`，冒号后面是什么都不影响**。
 * 量到的边界（原始输出见底稿）：
 *
 *  - 算：`https://example.com`、`foo:`、`foo:bar`、`mailto:a@b`、`tel:+123`、`http:\example.com`、`HTTPS://x`；
 *  - 不算：`C:\x\y`、`a:b`（单字母 = 盘符）、`1a:b`（方案不能以数字开头）、`:foo`、`//example.com`、
 *    `./a.html`、`example.com`、`a/b`、`\\server\share`。
 *
 * @param token - 命令行里的一个 token。
 * @returns 会不会被 Electron 当成"要打开的地址"。
 */
function looksLikeUrl(token: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(token)
}

/**
 * 致命形状：命令行里**第一个"像 URL 的独立 token"后面还跟着另一个独立 token**。
 *
 * 开关（以 `-` 开头的 token）不算"跟着的 token"，所以 `--url https://x --no-show` 是安全的；
 * `--url https://x --view-url y` 里的 `y` 是独立 token，所以会死（实测 J4）。
 *
 * @param argv - Electron 看到的那份 argv（含 app 路径）。
 * @returns 那个 URL token；形状安全时返回 null。
 */
function fatalUrlToken(argv: string[]): string | null {
  const bare = argv.filter((token) => !token.startsWith('-'))
  for (let index = 0; index < bare.length - 1; index += 1) {
    const token = bare[index]
    if (looksLikeUrl(token)) return token
  }
  return null
}

/**
 * 实测**会死**的形状，逐个对应底稿里的一行原始输出：
 * A1 / A2 / J11 / J4 / J3 / M3 / M12 / K4 / K6 / Q3 / Q4 / Q7 / Q16 / Q17。
 */
const FATAL_SHAPES: string[][] = [
  ['--url', 'https://example.com', '--view-url', 'https://example.org'],
  ['--view-url', 'https://example.org', '--url', 'https://example.com'],
  ['--url', 'https://example.com', 'x'],
  ['--url', 'https://example.com', '--view-url', 'x'],
  ['--url', 'https://example.com', '--no-show', 'x'],
  ['https://example.com', 'https://example.org'],
  ['x', 'https://example.com', 'y'],
  ['--url', 'https://example.com', '--view-url', 'foo://bar'],
  ['--url', 'https:/example.com', '--view-url', 'https://example.org'],
  ['ab:', 'z'],
  ['foo:', 'z'],
  ['a1:', 'z'],
  ['mailto:a@b', 'z'],
  ['tel:+123', 'z'],
]

/**
 * 实测**安全**的形状。等号形式排在前面：它就是文档推荐的那一种。
 *
 * 注意 `['--url', 'https://example.com']` 这类"空格形式但 URL 在最后"也在表里：
 * 它今天安全是**位置**安全（后面再追加一个参数就变成上面那张表里的形状），
 * 所以文档只能把它当历史事实，不能当推荐写法。
 */
const SAFE_SHAPES: string[][] = [
  ['--url=https://example.com', '--view-url=https://example.org'],
  ['--url=https://example.com', '--view-url=https://example.org', '--dsh'],
  ['--url=https://example.com', '--view-url', 'https://example.org'],
  ['--url=https://example.com', 'x'],
  ['--url=https://example.com', '--no-show'],
  ['--url', 'https://example.com'],
  ['--url', 'https://example.com', '--view-url'],
  ['--url', 'https://example.com', '--no-show', '--no-show'],
  ['x', 'https://example.com'],
  ['C:\\x\\y', 'z'],
  ['a:b', 'z'],
  ['1http://x', 'z'],
  [':foo', 'z'],
  ['--url', 'C:\\x\\y', '--view-url', 'C:\\a\\b'],
  ['--url', 'example.com', '--view-url', 'example.org'],
  ['--url', '//example.com', '--view-url', 'https://example.org'],
  // 外壳自己 spawn 的 `dsh` 子进程那条 argv（`shell/main.js` 里的 `--profile … --no-open --port 0`）：
  // 里面一个 URL token 都没有，而 `dsh` 本身跑的是 Node（实测 Node 对同一形状免疫）。
  ['--profile', 'dshviewer', '--no-open', '--port', '0'],
]

/** README 里"调用外壳 CLI"的命令，外加它在文件里出现的位置。 */
interface DocumentedCommand {
  /** 出处，写在断言消息里让人一眼找到。 */
  where: string
  /** 命令原文（trim 过的）。 */
  text: string
}

/** 一条命令是不是在调这个外壳：`npx electron shell/main.js …`、`electron shell/main.js …`、`npm run shell[:fixture] …`。 */
function invokesTheShell(text: string): boolean {
  return /^(?:npx\s+electron\s+shell\/main\.js|electron\s+shell\/main\.js|npm\s+run\s+shell(?::fixture)?)(?:\s|$)/.test(
    text,
  )
}

/**
 * README 里所有在调外壳的命令：代码块里整行的那种，加上行内反引号里的那种。
 *
 * 两条都收，是因为这份 README 两种都用了（代码块里是 ①②③，正文里的"往脚本上追加参数也一样"
 * 是行内反引号）。漏收一种，这条门禁就有一半示例是"没人管"的。
 *
 * @returns 命令与出处，按出现顺序。
 */
function documentedShellCommands(): DocumentedCommand[] {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
  const found: DocumentedCommand[] = []
  readme.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (invokesTheShell(trimmed)) found.push({ where: `README.md:${index + 1}`, text: trimmed })
    for (const match of trimmed.matchAll(/`([^`]+)`/g)) {
      const inside = (match[1] ?? '').trim()
      if (invokesTheShell(inside)) found.push({ where: `README.md:${index + 1}（行内反引号）`, text: inside })
    }
  })
  return found
}

/** 从 package.json 里展开 `npm run <script>`：脚本改了，这里跟着改，不写死第二份。 */
function scriptArgv(script: string): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const text = manifest.scripts?.[script]
  if (text === undefined) throw new Error(`package.json has no script named ${script}`)
  const tokens = text.split(/\s+/).filter((token) => token !== '')
  return tokens[0] === 'electron' ? tokens.slice(1) : tokens
}

/**
 * 一条文档命令 → Electron 真正看到的那份 argv。
 *
 * `npm run shell -- ARGS` 展开成 `shell/main.js --dsh ARGS`（脚本原文从 package.json 读），
 * `npx electron shell/main.js ARGS` 去掉前面的 `npx`。
 *
 * @param command - 文档里的命令原文。
 * @returns argv（第一个 token 是 app 路径）。
 */
function electronArgvOf(command: string): string[] {
  const tokens = command.split(/\s+/).filter((token) => token !== '')
  if (tokens[0] === 'npx') return tokens.slice(2)
  if (tokens[0] === 'electron') return tokens.slice(1)
  const rest = tokens.slice(3)
  return [...scriptArgv(tokens[2] ?? ''), ...(rest[0] === '--' ? rest.slice(1) : rest)]
}

/**
 * 一条文档命令 → 交给 `startShell` / `runShellOnce` 的那份参数。
 *
 * app 路径（`shell/main.js`）由 harness 自己补在最前面，所以这里去掉它 —— 上面那个
 * `electronArgvOf` 留的是"Electron 真正看到的那份 argv"（含 app 路径），门禁用它，
 * 这里用它跑。
 *
 * @param command - 文档里的命令原文。
 * @returns 不含 app 路径的参数。
 */
function shellArgumentsOf(command: string): string[] {
  const argv = electronArgvOf(command)
  return argv[0] === 'shell/main.js' ? argv.slice(1) : argv
}

/** 这条命令里有没有 URL（无论等号形式还是空格形式）：决定它要不要被**真的跑一遍**。 */
function carriesUrl(argv: string[]): boolean {
  return argv.some((token) => looksLikeUrl(token) || /^--(?:view-)?url(?:=|$)/.test(token))
}

/**
 * 把命令里的 URL **值**换成本机回环地址，别的一字不动。
 *
 * 只换值不换形状，是因为"会不会死"只由形状决定（URL 文本只要还像 URL 就行）——这一点是量过的：
 * 同一批形状把 `https://example.com` 换成 `http://127.0.0.1:<port>/shell`，会死的照样死
 * （下面那条反证用的就是换过值的旧形状）。这样守卫才既不依赖外网、又跑的是文档里的形状。
 *
 * @param argv - 文档命令展开出来的 argv。
 * @param origin - 本机回环站点的 origin。
 * @returns 换过 URL 值的 argv。
 */
function localizeUrls(argv: string[], origin: string): string[] {
  /** 哪个开关的值该换成哪个页面。 */
  const valueFor = (name: string): string => `${origin}${name === '--url' ? '/shell' : '/view'}`
  let pending: string | undefined
  return argv.map((token) => {
    if (token === '--url' || token === '--view-url') {
      pending = token
      return token
    }
    if (/^--(?:view-)?url=/.test(token)) {
      const name = token.slice(0, token.indexOf('='))
      pending = undefined
      return `${name}=${valueFor(name)}`
    }
    if (looksLikeUrl(token)) {
      const name = pending ?? '--view-url'
      pending = undefined
      return valueFor(name)
    }
    // 别的开关：它后面那个 token 不是 URL 值（`--dsh` 这种没有值）。
    if (token.startsWith('-')) pending = undefined
    return token
  })
}

/** 一次"跑起来然后看它怎么结束"的结果。 */
interface RunOutcome {
  /** 退出码；被超时打断时为 null。 */
  exitCode: number | null
  /** stdout 全文。 */
  stdout: string
  /** stderr 全文。 */
  stderr: string
  /** 从起进程到结束的毫秒数。 */
  durationMs: number
  /** 是不是到点还活着、被 `taskkill` 收掉的（坑的形状**不该**走到这一步）。 */
  killedMyTree: boolean
}

/**
 * 起一个真 Electron 外壳进程，等它**自己**退；到点还活着就杀掉**我自己起的这棵树**。
 *
 * 为什么不直接用 `launchShellProcess`：那一个是"等握手"的语义，进程提前退出会让它 reject，
 * 而 reject 时不返回子进程句柄。这里要断言的恰恰是"提前退出"，并且万一 Electron 哪天不再秒退，
 * 这条命令会**活着**（还开着窗口）——那时必须有句柄才收得干净（`taskkill /pid <pid> /T /F`
 * 只杀这个 pid 的树，用户自己那个外壳进程一根汗毛都不动）。
 *
 * @param argv - 完整 argv（app 路径在最前面）。
 * @param timeoutMs - 最多等多久。
 * @returns 量到的结果。
 */
async function runShellOnce(argv: string[], timeoutMs: number): Promise<RunOutcome> {
  const started = Date.now()
  const child = spawn(electronExecutable(), argv, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const settled = await new Promise<{ timedOut: boolean; code: number | null }>((settle) => {
    const timer = setTimeout(() => settle({ timedOut: true, code: null }), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      settle({ timedOut: false, code })
    })
  })
  let killedMyTree = false
  if (settled.timedOut) {
    killedMyTree = true
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
    await new Promise((settle) => setTimeout(settle, 800))
  }
  return { exitCode: settled.code, stdout, stderr, durationMs: Date.now() - started, killedMyTree }
}

/** Electron 在 Windows 上"自己按掉了自己"时那个退出码：`0xFFFFFFFF`（Node 报成 4294967295）。 */
const KILLED_BEFORE_APP_CODE = 0xffffffff

/** 本机回环站点：守卫测试用的 URL 值不能靠外网，否则这条守卫会靠网络吃饭。 */
let pages: { origin: string; close: () => Promise<void> }

describe('票 #14 · 照 README 抄的命令不许把外壳弄死', () => {
  beforeAll(async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>t14</title><p>t14 local page</p>')
    })
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
    const address = server.address() as AddressInfo
    pages = {
      origin: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((settle) => {
          server.close(() => settle())
        }),
    }
  })

  afterAll(async () => {
    if (pages !== undefined) await pages.close()
  })

  it('规则：像 URL 的独立 token 后面还跟着 token → electron.exe 在应用代码之前退出', () => {
    for (const shape of FATAL_SHAPES) {
      expect(fatalUrlToken(shape), `这个形状实测会死，判据却说它安全：${JSON.stringify(shape)}`).not.toBeNull()
    }
    for (const shape of SAFE_SHAPES) {
      expect(fatalUrlToken(shape), `这个形状实测安全，判据却说它会死：${JSON.stringify(shape)}`).toBeNull()
    }
    console.log(`RAW 判据: 会死 ${FATAL_SHAPES.length} 例 / 安全 ${SAFE_SHAPES.length} 例，全部对上`)
  })

  it('args.js 同时接受 --url=<url> 与 --view-url=<url>，空格形式与其它开关的语义没变', () => {
    const equals = shellArgs.parseArgv(['--url=https://example.com', '--view-url=https://example.org', '--dsh'])
    expect(equals.windowUrl).toBe('https://example.com')
    expect(equals.viewUrl).toBe('https://example.org')
    expect(equals.useDsh).toBe(true)
    // 空格形式照旧。
    const spaced = shellArgs.parseArgv(['--url', 'https://example.com', '--view-url', 'https://example.org'])
    expect(spaced.windowUrl).toBe('https://example.com')
    expect(spaced.viewUrl).toBe('https://example.org')
    // 等号形式**只**对这两个开关生效：别的开关没变，未知参数仍然要报错（本票不重排 CLI 语义）。
    expect(() => shellArgs.parseArgv(['--user-data-dir=C:\\x'])).toThrow(/unknown argument/)
    expect(() => shellArgs.parseArgv(['--bounds=0,0,1,1'])).toThrow(/unknown argument/)
    console.log('RAW parseArgv 等号形式: ' + JSON.stringify({ windowUrl: equals.windowUrl, viewUrl: equals.viewUrl }))
  })

  it('--help 写了等号形式，也写了这个坑的后果', () => {
    const help = shellArgs.usage()
    expect(help).toContain('--url=<url>')
    expect(help).toContain('--view-url=<url>')
    // 坑的三个特征都要在帮助里说清：发生在应用代码之前、零输出、退出码 0xFFFFFFFF。
    expect(help).toContain('0xFFFFFFFF')
    expect(help, '--help 必须点出"外壳自己救不了自己"这件事').toMatch(/before this program runs/)
    expect(help, '--help 必须指向规则底稿').toContain('docs/research/t14-cli-url-token-kills-electron.md')
    console.log('RAW --help 里的等号形式与坑: 都在')
  })

  it('README 与 --help 里每一条外壳命令都是已证明安全的形状', () => {
    const commands = documentedShellCommands()
    // 非空门禁：文档被大改时，这条门禁不许"零条示例 = 全绿"地失效。
    expect(commands.length, 'README 里应当至少有几条调用外壳的命令').toBeGreaterThanOrEqual(4)
    const offenders = commands
      .map((one) => ({ ...one, fatal: fatalUrlToken(electronArgvOf(one.text)) }))
      .filter((one) => one.fatal !== null)
    console.log(
      'RAW README 里的外壳命令: ' +
        JSON.stringify(commands.map((one) => ({ where: one.where, argv: electronArgvOf(one.text) })), null, 2),
    )
    expect(
      offenders.map((one) => `${one.where}: ${one.text}（致命 token: ${String(one.fatal)}）`),
      '文档里出现了"独立 URL token 后面还跟着参数"的形状：那条命令会让 electron.exe 在应用代码之前退掉',
    ).toEqual([])
  })

  it('README 里那条带 URL 的命令真的跑得起来，而且两个 URL 都真的生效', async () => {
    const withUrls = documentedShellCommands().filter((one) => carriesUrl(shellArgumentsOf(one.text)))
    expect(withUrls.length, 'README 里应当至少有一条带 URL 的外壳命令').toBeGreaterThan(0)

    /** 真的被跑过的例子。`--dsh` 的那种要真宿主（几十秒、要 `dsh` 在 PATH 上），见下面那行说明。 */
    const ran: string[] = []
    for (const one of withUrls) {
      const argv = localizeUrls(shellArgumentsOf(one.text), pages.origin)
      if (argv.includes('--dsh')) {
        // **不是静默跳过**：这一条只做了形状门禁（上一条测试），原因写在这里和 stdout 上。
        console.log(`RAW 只做形状门禁（起真宿主要几十秒，URL 开关与 --dsh 无关）: ${one.where}: ${one.text}`)
        continue
      }
      const profile = mkdtempSync(join(tmpdir(), 'dsh-t14-doc-shape-'))
      let shell: ShellProcess | undefined
      try {
        console.log(`RAW 真跑文档形状: ${one.where}: ${one.text} → argv=${JSON.stringify(argv)}`)
        shell = await startShell(argv, { userDataDir: profile, timeoutMs: 90_000 })
        console.log(
          'RAW 握手: ' +
            JSON.stringify({ viewUrl: shell.handshake.viewUrl, targetUrl: shell.handshake.targetUrl }),
        )
        // 握手本身就证明它没有秒退；再把文档里写了的那个 URL 读回来，证明开关真的被解析了。
        // 只对"文档里确实写了"的那个开关下断言，这样将来文档只写 `--url=` 也不会误红。
        const asksWindowUrl = argv.some((token) => /^--url(?:=|$)/.test(token))
        const asksViewUrl = argv.some((token) => /^--view-url(?:=|$)/.test(token))
        expect(asksWindowUrl || asksViewUrl, '带 URL 的文档命令里至少得有一个 URL 开关').toBe(true)
        if (asksViewUrl) expect(shell.handshake.viewUrl).toBe(`${pages.origin}/view`)
        if (asksWindowUrl) {
          const windowTargetId = shell.handshake.windowTargetId
          expect(windowTargetId, '外壳必须说出哪个页面是窗口').toBeDefined()
          const opened = await pageForTarget(shell.handshake.cdpUrl, windowTargetId as string)
          try {
            const seen = await opened.page.evaluate(() => location.href)
            console.log('RAW 窗口地址（从窗口自己读回来）: ' + seen)
            expect(new URL(seen).origin).toBe(pages.origin)
          } finally {
            await opened.browser.close()
          }
        }
        ran.push(one.where)
      } finally {
        if (shell !== undefined) await shell.stop()
        removeWhenFree(profile)
      }
    }
    expect(ran.length, '至少要有一条带 URL 的文档命令被真的跑过').toBeGreaterThan(0)
  })

  it('反证：同一个 URL 值，换成 README 的旧形状就秒退 0xFFFFFFFF 且零输出', async () => {
    // README 旧形状（`82c3fc2` 那版第 82 行）。它**就是**这条票的起因，留着当反证。
    const oldShape = ['--url', 'https://example.com', '--view-url', 'https://example.org']
    const argv = localizeUrls(oldShape, pages.origin)
    const profile = mkdtempSync(join(tmpdir(), 'dsh-t14-old-shape-'))
    try {
      const outcome = await runShellOnce([SHELL_MAIN, '--user-data-dir', profile, ...argv], 20_000)
      console.log(
        'RAW 旧形状: ' +
          JSON.stringify({
            argv,
            exitCode: outcome.exitCode,
            exitCodeHex: outcome.exitCode === null ? null : `0x${outcome.exitCode.toString(16)}`,
            durationMs: outcome.durationMs,
            stdoutBytes: outcome.stdout.length,
            stderrBytes: outcome.stderr.length,
            killedMyTree: outcome.killedMyTree,
          }),
      )
      expect(outcome.killedMyTree, '这个形状会自己秒退；它要是还活着，说明 Electron 改了行为').toBe(false)
      expect(
        outcome.exitCode,
        '这个形状必须在应用代码之前退掉（0xFFFFFFFF）。若不是，Electron 改了行为：' +
          '请重新量一遍 docs/research/t14-cli-url-token-kills-electron.md 里的规则',
      ).toBe(KILLED_BEFORE_APP_CODE)
      expect(outcome.stdout, '这个形状是零输出的：连 `--help` 都打不出来').toBe('')
      expect(outcome.stderr, '这个形状不会说任何话（连 DSH_SHELL 前缀都没有）').not.toContain('DSH_SHELL')
    } finally {
      removeWhenFree(profile)
    }
  })
})
