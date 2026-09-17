import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { SpaceManager } from '../src/spaces.ts'
import type { AdoptedViewSession } from '../src/session.ts'
import { electronExecutable, pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #19 的**像素验收**：把栏拖窄之后，整页在窗格里**真的**看得见 —— 而且**没有人按过任何按钮**。
 *
 * ## 为什么这一条必须是"真窗口像素"，不能是数字
 *
 * 上一张票（#13）的第一版验收是拿数字做的（`innerWidth` / `scrollWidth` / 截图尺寸），
 * 结果得出一个**反的**结论：CDP 那条路让 `scrollWidth <= innerWidth` 成立、截图里也有红标，
 * 可窗格把模拟视口按 1:1 画出来再裁掉，用户看到的**一点没变**。所以这一条只用真窗口的像素说话：
 * 起外壳时让窗口真的显示出来，用一支单独的 Electron 进程 `desktopCapturer` 抓那个窗口，
 * 在画面里数两种颜色。
 *
 * ## 这一份与 `zoom-pixels.spec.ts` 的差别（不是重复）
 *
 * `zoom-pixels` 证明的是"**按下缩放按钮**之后整页进来了"（#13 的手动缩放）。
 * 这一份证明的是"**栏一变，它自己就进来了**"（#19 的自动适配），所以：
 *
 *  - 全程**没有按过任何按钮**：外壳是 `startShell` 起的（没有 `--dsh`，这条进程树里没有宿主、
 *    没有插件、没有面板那条 RPC），页面变化的唯一可能来源就是外壳自己；
 *  - 栏宽是**真的用 `setRect` 一步步拖窄的**（走面板那条通道），不是调一个内部函数；
 *  - 反证是**同一段栏宽下的 A/B**：同一个 620 的栏，自动模式下红标在画面里，
 *    按一次 `100%`（手动接管）之后它就不见了 —— 这一对读数把"是自动适配让它进来的"钉死。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_FIXTURE = join(HERE, 'fixtures', 'window-capture', 'main.cjs')

/** 窗口页的标题：抓图时按它匹配（Chromium 的窗口标题跟着文档标题走）。 */
const WINDOW_TITLE = 'T19-PIXEL-WINDOW'

/** 窗格：先宽（放得下整页），再拖到票面点名的 620。 */
const WIDE = 1240
const NARROW = 620

/** 窗口那一页：空着，只负责报面板矩形（视图要先有矩形才会显示），并支持被驱动着拖。 */
const WINDOW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${WINDOW_TITLE}</title>
<style>html,body{margin:0;background:#dddddd;font:16px system-ui}</style></head>
<body><p>stand-in for the DSH web UI — kept free of red and of the bar colour</p>
<script>
  window.sendPane = function (width) {
    window.__dshDesktopView.setRect({ x: 0, y: 0, width: width, height: 800 })
    return width
  }
  window.addEventListener('load', function () { window.sendPane(${WIDE}) })
</script>
</body></html>`

/** 一次抓图的报告（与 `zoom-pixels.spec.ts` 同一支量具、同一份形状）。 */
interface CaptureReport {
  label: string
  found: boolean
  reason?: string
  sources: string[]
  window?: string
  size?: { width: number; height: number }
  red?: { count: number; box: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null }
  bar?: { count: number; box: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null }
}

describe('票 #19 · 栏一变，整页自己进来了（真窗口像素）', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  let spaces: SpaceManager
  let browser: Browser | undefined
  let page: Page
  let windowPage: Page
  let windowBrowser: Browser | undefined
  let server: { close: () => Promise<void> }
  let origin: string
  let dir: string

  const facts = async (): Promise<Record<string, number>> =>
    JSON.parse(String(await page.evaluate(() => (window as unknown as { fitFacts: () => string }).fitFacts())))

  const setPane = async (width: number): Promise<void> => {
    await windowPage.evaluate((w: number) => (window as unknown as { sendPane: (w: number) => number }).sendPane(w), width)
  }

  /** 一段真的拖动：一步步把栏拖到目标宽度。 */
  const dragPane = async (from: number, to: number, steps: number): Promise<void> => {
    for (let step = 1; step <= steps; step += 1) {
      await setPane(Math.round(from + ((to - from) * step) / steps))
      await new Promise((settle) => setTimeout(settle, 24))
    }
  }

  /** 等外壳真的把栏摆到那个宽度（落点记录是"栏宽现在是多少"的唯一权威）。 */
  const waitForPaneWidth = async (width: number, timeoutMs = 10_000): Promise<number> => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (shell.latestPlacement()?.reported?.width === width) return Date.now() - started
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return -1
  }

  /**
   * 等页面自己报"装得下了"**并且**稳定下来，或超时。
   *
   * 两条都要：只等第一条会在拖动中途就返回（中间很多时刻页面是装得下的），
   * 于是抓图抓到的是一段半路状态 —— 整套跑的时候踩过一次（栏还在 1226 就抓了图）。
   */
  const waitForFit = async (timeoutMs = 10_000): Promise<number> => {
    const started = Date.now()
    let previous = ''
    while (Date.now() - started < timeoutMs) {
      const seen = await facts()
      const now = JSON.stringify(seen)
      if (Number(seen.scrollWidth) <= Number(seen.clientWidth) && now === previous) return Date.now() - started
      previous = now
      await new Promise((settle) => setTimeout(settle, 50))
    }
    return -1
  }

  /**
   * 抓一次真窗口，返回报告。
   *
   * 抓不到那个窗口就**失败**（不是跳过）：这一条的全部意义就是"真实画面里有什么"，
   * 一个抓不到画面的环境答不了它 —— 而答不了必须说出来，不能变成一条默默通过的测试。
   */
  const capture = async (label: string): Promise<CaptureReport> => {
    const child = spawn(electronExecutable(), [CAPTURE_FIXTURE], {
      env: {
        ...process.env,
        T13_CAPTURE_DIR: dir,
        T13_CAPTURE_LABEL: label,
        T13_CAPTURE_MATCH: WINDOW_TITLE,
        T13_CAPTURE_OUT: join(dir, `pane-${label}.png`),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    await new Promise<void>((settle) => child.once('exit', () => settle()))
    const file = join(dir, `${label}.json`)
    if (!existsSync(file)) throw new Error(`the capture fixture wrote no report for ${label}: ${output}`)
    const report = JSON.parse(readFileSync(file, 'utf8')) as CaptureReport
    if (!report.found) {
      throw new Error(
        `the capture fixture could not find the shell's window (title contains ${JSON.stringify(WINDOW_TITLE)}); ` +
          `it saw: ${JSON.stringify(report.sources)}. This test measures what the pane really shows, so it needs a ` +
          'visible window on an interactive desktop — the shell is started with windowVisible: true.',
      )
    }
    console.log(
      `RAW window pixels[${label}]: size=${String(report.size?.width)}x${String(report.size?.height)} ` +
        `red=${report.red?.count ?? -1}${report.red?.box === null || report.red?.box === undefined ? '' : `@${JSON.stringify(report.red.box)}`} ` +
        `bar=${report.bar?.count ?? -1}${report.bar?.box === null || report.bar?.box === undefined ? '' : `@${JSON.stringify(report.bar.box)}`} ` +
        `facts=${JSON.stringify(await facts())}`,
    )
    return report
  }

  beforeAll(async () => {
    const httpServer = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(WINDOW_PAGE)
    })
    await new Promise<void>((settle) => httpServer.listen(0, '127.0.0.1', () => settle()))
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    server = { close: () => new Promise((settle) => httpServer.close(() => settle())) }

    dir = mkdtempSync(join(tmpdir(), 'dsh-t19-pixels-'))
    shell = await startShell([`--url=${origin}/window`, '--bounds', `0,0,${WIDE},800`], {
      // 窗口必须真的显示出来：被隐藏（或未合成）的窗口，抓图工具是看不到的（实测）。
      windowSize: { width: WIDE, height: 900 },
      windowVisible: true,
    })
    await shell.waitForPlacement(
      (placement) => placement.visible === true && placement.appliedVisible === true,
      'the shell to show the view in the panel rectangle',
      30_000,
    )
    spaces = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
      initialUrl: shell.handshake.viewUrl,
    })
    session = await spaces.adopt(shell.handshake.cdpUrl)
    const opened = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    browser = opened.browser
    page = opened.page
    const openedWindow = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.windowTargetId ?? '')
    windowBrowser = openedWindow.browser
    windowPage = openedWindow.page
  }, 180_000)

  afterAll(async () => {
    if (spaces !== undefined) await spaces.close()
    if (session !== undefined) await session.close().catch(() => undefined)
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (windowBrowser !== undefined) await windowBrowser.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (server !== undefined) await server.close()
    if (dir !== undefined) removeWhenFree(dir)
  })

  it('把栏拖到 620：整页**自己**进来了（红标在画面里）；同一个栏宽下按一次 100% 它就出去了（反证）', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/fixed-width`)
    await waitForFit()
    await new Promise((settle) => setTimeout(settle, 400))

    // ── 零点：栏够宽（1240），1200px 的页面本来就放得下 ⇒ 适配不许动它，红标可见 ──
    const atWide = await capture('wide')
    expect(Number((await facts()).devicePixelRatio), 'a page that fits must stay at 100%').toBeGreaterThan(1)
    expect(atWide.red?.count ?? 0, 'at a wide pane the page-rightmost marker must be visible').toBeGreaterThan(0)
    const barHeightAtWide = atWide.bar?.box?.height ?? 0
    expect(barHeightAtWide, 'the fixture bar must be a real strip in the window pixels').toBeGreaterThan(100)

    // ── 拖窄：票面第一条验收。**没有任何人按过按钮**：这条进程树里连宿主都没有。 ──
    await dragPane(WIDE, NARROW, 20)
    const paneMs = await waitForPaneWidth(NARROW)
    const fittedMs = await waitForFit()
    const reading = spaces.zoomReading('default')
    const narrowFacts = await facts()
    const atNarrow = await capture('narrow-auto')
    console.log(
      'RAW 自动适配之后的读数: ' + JSON.stringify({ reading, facts: narrowFacts, paneMs, fittedMs }),
    )
    expect(paneMs, 'the drag must have reached 620').toBeGreaterThanOrEqual(0)
    expect(fittedMs, 'the page must have fitted itself').toBeGreaterThanOrEqual(0)
    // 一、布局那一半（页面自己说的）：没有横向溢出，整页在布局视口里。
    expect(Number(narrowFacts.scrollWidth)).toBeLessThanOrEqual(Number(narrowFacts.clientWidth))
    expect(Number(narrowFacts.markerLeft) + 45, 'the marker must be inside the layout viewport').toBeLessThanOrEqual(
      Number(narrowFacts.innerWidth),
    )
    // 二、渲染那一半（只有真窗口像素答得了）：**不按任何按钮**，红标出现在画面里。
    expect(
      atNarrow.red?.count ?? 0,
      'after the drag the page-rightmost marker must be INSIDE the pane, on screen, with nobody pressing anything',
    ).toBeGreaterThan(0)
    // 而且内容**真的被缩小了**（不是"视口变宽"那种假象 —— 那正是 CDP 那条路栽的地方）。
    expect(atNarrow.bar?.box?.height ?? 0, 'the content must really be scaled down: the bar is roughly half as tall').toBeLessThan(
      barHeightAtWide * 0.7,
    )
    // 三、外壳自己记的那笔账：自动模式，而且真的改过缩放。
    expect(reading?.mode).toBe('auto')
    expect(reading?.zoom ?? 1).toBeLessThan(1)
    expect(reading?.fitChanges ?? 0).toBeGreaterThan(0)

    // ── 反证：**同一个栏宽**下按一次 `100%`（手动接管）⇒ 红标必须回到看不见 ──
    const reset = await session.resetZoom()
    await new Promise((settle) => setTimeout(settle, 500))
    const atManual = await capture('narrow-manual')
    console.log('RAW 手动 100% 之后: ' + JSON.stringify({ reset: reset.zoom, reading: spaces.zoomReading('default'), facts: await facts() }))
    expect(reset.zoom).toBe(1)
    expect(
      atManual.red?.count ?? 0,
      'with the fit standing down (a manual 100%), the same pane must show the page cut off — otherwise the reading above proves nothing',
    ).toBe(0)
    // 而手动之后**栏宽再变也不许把它改回去**（票面那条"手动缩放优先"的像素版）。
    await dragPane(NARROW, 900, 8)
    await dragPane(900, NARROW, 8)
    await waitForPaneWidth(NARROW)
    await new Promise((settle) => setTimeout(settle, 400))
    const afterManualDrag = await capture('narrow-manual-dragged')
    const manualReading = spaces.zoomReading('default')
    console.log('RAW 手动模式下又拖了一轮: ' + JSON.stringify({ reading: manualReading, facts: await facts() }))
    expect(manualReading?.mode).toBe('manual')
    expect(manualReading?.zoom, 'a manual zoom must survive pane drags, on pixels too').toBeCloseTo(1, 3)
    expect(afterManualDrag.red?.count ?? 0, 'the page must still be cut off: the fit was told to stand down').toBe(0)

    // ── 再交回自动：红标又回来了（同一段栏宽，第三次读数） ──
    await session.useAutoZoom()
    await waitForFit()
    await new Promise((settle) => setTimeout(settle, 300))
    const atAutoAgain = await capture('narrow-auto-again')
    console.log('RAW 交回自动之后: ' + JSON.stringify({ reading: spaces.zoomReading('default'), facts: await facts() }))
    expect(
      atAutoAgain.red?.count ?? 0,
      'handing the pane back to automatic fitting must bring the whole page in again',
    ).toBeGreaterThan(0)
  }, 300_000)
})
