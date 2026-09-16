import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SCREENSHOTS_DIR_NAME, fallbackScreenshotsDir, resolveScreenshotDir } from '../src/screenshots.ts'
import { userDataDirFromSpaceState } from '../src/spaces.ts'
import {
  REPO_ROOT,
  makeTempDshHome,
  removeWhenFree,
  resolveDshBinScript,
  startShell,
  waitForProbe,
  type ProbeReport,
  type ShellProcess,
  type TempDshHome,
} from './shell-harness.ts'
import { readPng } from './png-facts.ts'

/**
 * 票 #16：`browser_screenshot` 不带 `path` 时到底落在哪。
 *
 * 现象（已经真实发生过一次）：`Config.screenshotDir` 的默认值是 `'.'`，也就是**宿主 `dsh`
 * 进程的 cwd**。用户从仓库根跑 `npm run shell`，宿主是外壳的子进程、cwd 继承而来，于是 Agent
 * 每截一张图，**仓库根就多一个 `browser-<时间戳>.png`**，直接进 `git status` 的未跟踪列表
 * （现场证据：仓库根那两个 `browser-17895…png`）。
 *
 * 这一份 spec 有两半，缺哪一半都不成立：
 *
 *  1. **纯逻辑**（不起外壳）：三个来源各是什么 —— 显式配置 → 外壳档案目录下的 `screenshots`
 *     → 系统临时目录兜底，以及"读外壳发布的状态"这件事的每一种读不动的形状。
 *  2. **真外壳 + 真宿主 + 真工具**：外壳的 cwd 指到一个**临时目录**（它就是仓库根的替身，
 *     这样万一红，被污染的是临时目录而不是仓库），宿主从那里起，探针经**宿主自己的注册表**
 *     调一次**不带 `path`** 的 `browser_screenshot`，然后三件事分开读回：
 *     (a) 那个 cwd 里没有新文件、(b) 图片真的在新默认位置、(c) 返回的路径就是落盘的那个文件。
 *
 * 为什么 cwd 这件事必须由**宿主自己**报（`shellEnvironment.cwd`）：它是继承来的，"用例以为
 * 自己把 cwd 指到哪"不是事实。前提读不回来，"cwd 里没多出文件"就是一句空话。
 */

/** 起真宿主、等探针跑完的总预算。 */
const HOST_TIMEOUT_MS = 180_000

/** 规范化一个目录，用来比较"这两个说的是不是同一个地方"（Windows 上大小写与 8.3 短名都要抹平）。 */
function samePath(one: string, other: string): boolean {
  const normalize = (value: string): string => {
    try {
      return realpathSync.native(value).replace(/\\/g, '/').toLowerCase()
    } catch {
      return resolve(value).replace(/\\/g, '/').toLowerCase()
    }
  }
  return normalize(one) === normalize(other)
}

/** 一个形状合法的空间状态文件：`parseSpaceState` 认它，`userDataDir` 在里面。 */
function stateFileWith(userDataDir: string | undefined): string {
  return JSON.stringify({
    protocol: 1,
    requestId: 3,
    error: null,
    active: 'default',
    ...(userDataDir === undefined ? {} : { userDataDir }),
    spaces: [
      {
        name: 'default',
        partition: 'persist:dsh-view',
        storagePath: 'C:\\profile\\Partitions\\dsh-view',
        url: 'https://example.invalid/',
      },
    ],
  })
}

describe('票 #16 · 默认截图目录的判断（纯逻辑，不起外壳）', () => {
  /** 一个假的档案目录：这一半不碰文件系统，只是"外壳说它的档案在这里"。 */
  const PROFILE = join('C:', 'fake-profile')

  it('显式配置永远优先：给了 screenshotDir 就以它为准', () => {
    const configured = join('D:', 'shots')
    const chosen = resolveScreenshotDir({ configured, userDataDir: PROFILE })
    console.log('RAW configured wins: ' + JSON.stringify(chosen))
    expect(chosen.source).toBe('configured')
    expect(chosen.dir).toBe(resolve(configured))

    // 空串 / 纯空白不是"当前目录"，是"没配"：否则 `screenshotDir: ''` 又会把截图送回 cwd。
    for (const blank of ['', '   ']) {
      const fallback = resolveScreenshotDir({ configured: blank, userDataDir: PROFILE })
      expect(fallback.source).toBe('shell-profile')
      expect(fallback.dir).toBe(join(resolve(PROFILE), SCREENSHOTS_DIR_NAME))
    }
  })

  it('没配就落在外壳档案目录下的 screenshots：与下载（<档案>/downloads）对称', () => {
    const chosen = resolveScreenshotDir({ userDataDir: PROFILE })
    console.log('RAW the shell profile decides: ' + JSON.stringify(chosen))
    expect(chosen.source).toBe('shell-profile')
    expect(chosen.dir).toBe(join(resolve(PROFILE), SCREENSHOTS_DIR_NAME))
    // 是档案目录**下面**的一层，不是档案目录本身（往档案目录根部丢 PNG 仍然不算"有归属"）。
    expect(chosen.dir).not.toBe(resolve(PROFILE))
  })

  it('连档案目录都拿不到时，落到系统临时目录下的**专用**子目录（兜底说清楚）', () => {
    for (const input of [{}, { userDataDir: '' }, { userDataDir: '  ' }]) {
      const chosen = resolveScreenshotDir(input)
      console.log('RAW the fallback: ' + JSON.stringify(chosen))
      expect(chosen.source).toBe('fallback')
      expect(chosen.dir).toBe(join(tmpdir(), 'dsh-desktop-view-screenshots'))
      // 兜底目录自带归属：它说的是"谁把它放在这的"，不是一个谁都能往里写的裸 `screenshots`。
      expect(basename(chosen.dir)).toBe('dsh-desktop-view-screenshots')
    }
  })

  it('反证：两个默认值都不许是宿主进程的 cwd', () => {
    const cwd = resolve('.')
    console.log('RAW the host cwd this test process has: ' + cwd)
    // 这一条就是本票的那句话。回退修复（`'.'` 或 `?? process.cwd()`）之后它会红。
    expect(resolveScreenshotDir({}).dir).not.toBe(cwd)
    expect(resolveScreenshotDir({ userDataDir: PROFILE }).dir).not.toBe(cwd)
    expect(fallbackScreenshotsDir()).not.toBe(cwd)
    // 绕开 cwd 的方式只能是"显式配置"，别的路都不许走到这里。
    expect(resolveScreenshotDir({ configured: '.' }).dir).toBe(cwd)
  })
})

describe('票 #16 · 从外壳发布的状态里读档案目录（纯逻辑）', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-t16-state-'))
  })

  afterAll(() => {
    if (dir !== undefined) removeWhenFree(dir)
  })

  /** 写一个状态文件，返回它的路径。 */
  const write = (name: string, content: string): string => {
    const file = join(dir, name)
    writeFileSync(file, content)
    return file
  }

  it('读得出外壳写下的那个字段', () => {
    const file = write('good.json', stateFileWith('C:\\published-profile'))
    const read = userDataDirFromSpaceState(file)
    console.log('RAW userDataDir read from the published state: ' + JSON.stringify({ file, read }))
    expect(read).toBe('C:\\published-profile')
  })

  it('读不动的每一种形状都一律 undefined（兜底接住，不抛）', () => {
    const cases: Array<{ why: string; file: string | undefined }> = [
      // 这个部署压根没有空间通道（没有外壳）—— 最普通的那个原因。
      { why: 'no channel configured', file: undefined },
      { why: 'the state file does not exist yet', file: join(dir, 'absent.json') },
      { why: 'the file is not JSON', file: write('broken.json', '{ not json') },
      { why: 'the state names no profile directory', file: write('no-profile.json', stateFileWith(undefined)) },
      // 外壳还没写过状态：文件在、但形状不是它能发布的东西（少了文件级必填项）。
      { why: 'the file is not a state the shell published', file: write('half.json', '{"requestId":1}') },
    ]
    for (const input of cases) {
      const read = userDataDirFromSpaceState(input.file)
      console.log('RAW unreadable state: ' + JSON.stringify({ why: input.why, file: input.file, read }))
      expect(read, `${input.why} must fall back instead of throwing`).toBeUndefined()
    }
  })
})

describe('票 #16 · 临时 cwd 起真外壳：不带 path 的截图不进 cwd', () => {
  let home: TempDshHome
  /** **仓库根的替身**：外壳从这里起，宿主 `dsh` 是它的子进程、cwd 继承而来。 */
  let cwd: string
  let profile: string
  let probeDir: string
  let shell: ShellProcess
  let probe: ProbeReport
  /** cwd 里在外壳起来**之前**就有的东西（空目录，那就该是空的）。 */
  let beforeStart: string[]
  /** 探针跑完之后 cwd 里的东西。 */
  let afterProbe: string[]
  /** 探针那次截图返回的路径。 */
  let shotPath: string

  beforeAll(async () => {
    if (resolveDshBinScript() === undefined) {
      throw new Error(
        'this test needs the `dsh` launcher on PATH (or DSH_BIN pointing at @deepseek-ai/dsh/lib/bin.js): ' +
          'the whole point of #16 is where a screenshot lands when the *host* process runs it, and there ' +
          'is no host without dsh — a skipped check would be exactly the silent failure this suite refuses',
      )
    }
    // 探针以一个额外 bundle 的形式装进临时 profile（与用户装本插件的方式同形）。
    home = makeTempDshHome({
      profile: 'dshviewer',
      extraBundles: [{ name: 'dsh-t12-probe', dir: join(REPO_ROOT, 'tests', 'fixtures', 'dsh-probe') }],
    })
    cwd = mkdtempSync(join(tmpdir(), 'dsh-t16-cwd-'))
    profile = mkdtempSync(join(tmpdir(), 'dsh-t16-profile-'))
    probeDir = mkdtempSync(join(tmpdir(), 'dsh-t16-probe-'))
    const probeFile = join(probeDir, 'probe.json')
    beforeStart = readdirSync(cwd)

    shell = await startShell(['--dsh'], {
      cwd,
      userDataDir: profile,
      env: {
        // 隔离手段，不是产品的一部分：DSH 的 profile、会话、凭据全落进临时目录。
        DSH_HOME: home.home,
        DSH_T12_PROBE_OUT: probeFile,
        DSH_T12_PROBE_TIMEOUT_MS: '180000',
        // **刻意不设** `DSH_T12_PROBE_SHOT`：探针于是调一次**不带 `path`** 的
        // `browser_screenshot` —— 那正是本票要问的那条路。
      },
      timeoutMs: HOST_TIMEOUT_MS,
    })
    probe = await waitForProbe(probeFile, HOST_TIMEOUT_MS)
    afterProbe = readdirSync(cwd)

    const shot = probe.toolCalls.find((call) => call.tool === 'browser_screenshot')
    shotPath = String((shot?.value as { path?: string } | undefined)?.path ?? '')

    console.log('RAW the host cwd, as the host itself reports it: ' + JSON.stringify(probe.shellEnvironment.cwd))
    console.log('RAW the substitute-repo cwd before/after: ' + JSON.stringify({ cwd, beforeStart, afterProbe }))
    console.log('RAW browser_screenshot (no path) returned: ' + JSON.stringify(shot ?? null))
    console.log('RAW the shell handshake said its profile is: ' + shell.handshake.userDataDir)
  }, 300_000)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (home !== undefined) home.remove()
    // 临时目录一律走 removeWhenFree：Windows 上句柄还没释放时裸删会 EPERM，
    // 让"用例全过、整个 spec 文件报红"重演（tests/cleanup.spec.ts 有守门用例）。
    if (cwd !== undefined) removeWhenFree(cwd)
    if (profile !== undefined) removeWhenFree(profile)
    if (probeDir !== undefined) removeWhenFree(probeDir)
  })

  it('前提：宿主自己的 cwd 就是那个临时目录，而它整轮一个文件都没多', () => {
    // 这一条是下面两条的地基：cwd 是**继承**来的，用例"以为自己指到哪"不算事实。
    console.log('RAW cwd comparison: ' + JSON.stringify({ reported: probe.shellEnvironment.cwd, expected: cwd }))
    expect(typeof probe.shellEnvironment.cwd).toBe('string')
    expect(samePath(String(probe.shellEnvironment.cwd), cwd)).toBe(true)
    expect(probe.shellEnvironment.spacesDir).toBeTruthy()

    // 前提之下的结论：从"仓库根"起外壳、让 Agent 截一张不带路径的图，那个目录**不新增任何文件**。
    expect(beforeStart, 'the substitute repo root must start empty, or "no new files" proves nothing').toEqual([])
    expect(afterProbe, 'the host process cwd must gain no file at all').toEqual(beforeStart)
    expect(afterProbe.filter((entry) => entry.endsWith('.png'))).toEqual([])
  })

  it('截图落在外壳档案目录下的 screenshots，而不是 cwd，也不是本仓库', () => {
    const shot = probe.toolCalls.find((call) => call.tool === 'browser_screenshot')
    expect(shot, 'the probe must have taken the screenshot').toBeDefined()
    expect(shot?.threw).toBeUndefined()
    expect(shot?.isError ?? true).toBe(false)
    expect(shotPath, 'the tool must still return the path it wrote').not.toBe('')

    // 独立读回：这个位置由**外壳自己在握手里说的**档案目录算出来，而不是问插件要一个答案。
    // 与下载那条决定对称（ADR-0011：下载落 `<档案目录>/downloads`）。
    const expected = join(resolve(shell.handshake.userDataDir), SCREENSHOTS_DIR_NAME, basename(shotPath))
    console.log('RAW where it landed vs where the shell profile says it should: ' + JSON.stringify({ shotPath, expected }))
    expect(samePath(shotPath, expected)).toBe(true)
    expect(basename(shotPath)).toMatch(/^browser-\d+\.png$/)
    expect(existsSync(shotPath), 'the path the tool returned must be a file that is really there').toBe(true)

    // 它不在宿主进程的 cwd 里，也不在仓库里 —— 本票的两个"不许"。
    expect(samePath(dirname(shotPath), cwd), 'a screenshot must not land in the host cwd').toBe(false)
    expect(shotPath.toLowerCase().startsWith(cwd.toLowerCase()), 'a screenshot must not land in the host cwd').toBe(false)
    expect(
      shotPath.toLowerCase().startsWith(REPO_ROOT.toLowerCase()),
      'a screenshot must not land inside the repository',
    ).toBe(false)

    // 落盘的那张图就是它交付的那张图：字节数与声明的对得上，而且真的是一张 PNG。
    const bytes = readFileSync(shotPath)
    const image = (shot?.value as { image?: { bytes?: number } } | undefined)?.image
    const facts = readPng(bytes)
    console.log(
      'RAW the file on disk, parsed here: ' +
        JSON.stringify({ bytes: bytes.length, declaredBytes: image?.bytes, width: facts.width, height: facts.height }),
    )
    expect(bytes.length).toBe(Number(image?.bytes))
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(facts.width).toBeGreaterThan(0)
    expect(facts.height).toBeGreaterThan(0)
  })

  it('截图仍然作为附件交付：部署自己的 store 读得回来，路径也照旧如实返回', () => {
    const attachment = probe.attachment ?? {}
    console.log('RAW attachment read-back: ' + JSON.stringify(attachment))
    // 为不污染而把路径藏起来不是修法：模型面既有图片内容块，也有那条路径。
    const shot = probe.toolCalls.find((call) => call.tool === 'browser_screenshot')
    const blocks = Array.isArray(shot?.content) ? (shot?.content as Array<Record<string, unknown>>) : []
    const imageBlock = blocks.find((block) => block?.type === 'image')
    console.log('RAW the content the model receives: ' + JSON.stringify(blocks))
    expect(imageBlock, 'the screenshot must still be delivered as an image block').toBeDefined()
    expect(blocks.some((block) => block?.type === 'text' && String(block.text).includes(shotPath))).toBe(true)

    // `readImage` 不只是"读回来"：它按内容寻址的摘要校验字节与记录的引用是否一致，
    // 所以读得回来 = 那份图片真的在部署自己的 store 里。
    expect(attachment.error, 'the screenshot must reach the deployment\'s own attachment store').toBeUndefined()
    expect(attachment.mediaType).toBe('image/png')
    expect(Number(attachment.declaredBytes)).toBeGreaterThan(0)
    expect(Number(attachment.readBackBytes)).toBe(Number(attachment.declaredBytes))
    expect(attachment.pngMagic).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    // 附件里那几个字节，与落盘那个文件是同一份（路径指向的不是别的东西）。
    expect(Number(attachment.declaredBytes)).toBe(statSync(shotPath).size)
  })
})
