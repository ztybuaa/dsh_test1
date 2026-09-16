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
 * 票 #13 的**像素验收**：缩小到 50% 之后，页面最右端在**窗格里**真的看得见。
 *
 * ## 为什么必须有这一份
 *
 * 用户的原话是"稍微小一点页面就不能全部显示了，能不能做到适应侧边栏的大小"。而上一轮
 * 这条验收是拿**数字**做的（`innerWidth` / `scrollWidth` / 截图尺寸），于是得出了一个
 * **反的**结论：CDP 那条路让 `scrollWidth <= innerWidth` 成立、截图里也有红标，可窗格
 * 把模拟视口按 1:1 画出来再裁掉，用户看到的**一点没变**，而且页面不再溢出之后连滚动条
 * 都没了。数字全部"对"，用户什么都没得到。
 *
 * 所以这一条只用**真窗口的像素**说话：起外壳时让窗口真的显示出来
 * （`windowVisible: true`），用一支单独的 Electron 进程 `desktopCapturer` 抓那个窗口，
 * 在画面里数两种颜色：
 *
 *  - **红标**（页面 x=1150..1195 那一块）：它在不在画面里，就是"整页进来没有"；
 *  - **蓝条**（200 CSS px 高的那条 1200px 列）：它在窗口像素里的**高度**，就是"内容有没有
 *    真的被缩放" —— 缩到 50% 时它必须变成一半。
 *
 * ## 仪器的自检（这一份里最重要的一步）
 *
 * 量到 0 之前必须先证明这支量具**看得见**红标：100% 时把页面横向滚到最右，红标必须出现在
 * 画面里。没有这一步，"0 就是 0"这句话没有分量 —— 这正是上一轮栽的地方。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_FIXTURE = join(HERE, 'fixtures', 'window-capture', 'main.cjs')

/** 窗口页的标题：抓图时按它匹配（Chromium 的窗口标题跟着文档标题走）。 */
const WINDOW_TITLE = 'T13-PIXEL-WINDOW'

/** 视口/窗格：窄栏。 */
const SLOT = { width: 620, height: 800 }

/** 窗口那一页：空着，只负责报面板矩形（视图要先有矩形才会显示）。 */
const WINDOW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${WINDOW_TITLE}</title>
<style>html,body{margin:0;background:#dddddd;font:16px system-ui}</style></head>
<body><p>stand-in for the DSH web UI — kept free of red and of the bar colour</p>
<script>
  window.addEventListener('load', function () {
    try {
      window.__dshDesktopView.setRect({ x: 0, y: 0, width: ${SLOT.width}, height: ${SLOT.height} })
      window.__t13Reported = true
    } catch (error) {
      window.__t13Reported = String(error)
    }
  })
</script>
</body></html>`

/** 视图那一页：1200px 的蓝条 + 页面最右端（x=1150..1195）的红标。 */
const VIEW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t13-pixel-view</title>
<style>
  html, body { margin: 0; }
  #bar { width: 1200px; height: 200px; background: #4a6fa5; color: #fff; font: 20px system-ui; position: relative; }
  #marker { position: absolute; left: 1150px; top: 40px; width: 45px; height: 120px; background: #ff0000; }
</style></head>
<body>
  <div id="bar">a 1200px-wide column<span id="marker"></span></div>
  <script>
    window.t13Facts = function () {
      return JSON.stringify({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollWidth: document.documentElement.scrollWidth, scrollX: window.scrollX,
        markerLeft: document.getElementById('marker').getBoundingClientRect().left,
      })
    }
  </script>
</body></html>`

/** 一次抓图的报告。 */
interface CaptureReport {
  label: string
  found: boolean
  reason?: string
  sources: string[]
  window?: string
  size?: { width: number; height: number }
  red?: { count: number; box: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null }
  bar?: { count: number; box: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null }
  sampleBar?: number[]
}

describe('票 #13 · 缩放真的让那一格把整页装进来了（真窗口像素）', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  let spaces: SpaceManager
  let browser: Browser | undefined
  let page: Page
  let server: { close: () => Promise<void> }
  let origin: string
  let dir: string

  const facts = async (): Promise<Record<string, number>> =>
    JSON.parse(String(await page.evaluate(() => (window as unknown as { t13Facts: () => string }).t13Facts())))

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
      `RAW window pixels[${label}]: window=${JSON.stringify(report.window)} size=${String(report.size?.width)}x${String(report.size?.height)} ` +
        `red=${report.red?.count ?? -1}${report.red?.box === null || report.red?.box === undefined ? '' : `@${JSON.stringify(report.red.box)}`} ` +
        `bar=${report.bar?.count ?? -1}${report.bar?.box === null || report.bar?.box === undefined ? '' : `@${JSON.stringify(report.bar.box)}`} ` +
        `facts=${JSON.stringify(await facts())}`,
    )
    return report
  }

  beforeAll(async () => {
    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(url.pathname === '/view' ? VIEW_PAGE : WINDOW_PAGE)
    })
    await new Promise<void>((settle) => httpServer.listen(0, '127.0.0.1', () => settle()))
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    server = { close: () => new Promise((settle) => httpServer.close(() => settle())) }

    dir = mkdtempSync(join(tmpdir(), 'dsh-t13-pixels-'))
    shell = await startShell(
      [`--url=${origin}/window`, `--view-url=${origin}/view`, '--bounds', `0,0,${SLOT.width},${SLOT.height}`],
      // 窗口必须真的显示出来：被隐藏（或未合成）的窗口，抓图工具是看不到的（实测）。
      { windowSize: { width: 1240, height: 900 }, windowVisible: true },
    )
    // 视图要被显示出来才有画面：外壳只在面板报了矩形之后显示它。
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
  }, 180_000)

  afterAll(async () => {
    if (spaces !== undefined) await spaces.close()
    if (session !== undefined) await session.close().catch(() => undefined)
    if (browser !== undefined) await browser.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (server !== undefined) await server.close()
    if (dir !== undefined) removeWhenFree(dir)
  })

  it('100% 时滚到最右看得见红标（仪器自检），不滚则看不见；缩到 50% 之后**不滚也看得见**，而且内容真的减半', async () => {
    // ── 一、仪器自检：先证明这支量具看得见红标 ────────────────────────────────
    await session.resetZoom()
    await session.evaluate('window.scrollTo(0, 0); void 0')
    await new Promise((settle) => setTimeout(settle, 400))
    const atOne = await capture('zoom100')
    expect(atOne.red?.count ?? 0, 'at 100% the page-rightmost marker must NOT be in the pane (620 < 1150)').toBe(0)
    expect(atOne.bar?.box, 'the fixture bar must be visible, or nothing is being measured').not.toBeNull()
    const barHeightAtOne = atOne.bar?.box?.height ?? 0
    expect(barHeightAtOne, 'the bar must be a real strip in the window pixels').toBeGreaterThan(100)

    await session.evaluate('window.scrollTo(580, 0); void 0')
    await new Promise((settle) => setTimeout(settle, 400))
    const scrolled = await capture('zoom100-scrolled')
    console.log('RAW instrument self-check: ' + JSON.stringify({ scrollX: (await facts()).scrollX, red: scrolled.red }))
    expect(
      scrolled.red?.count ?? 0,
      'the instrument is only valid if it CAN see the marker: scrolled right at 100%, it must appear',
    ).toBeGreaterThan(0)
    // 而且它出现的位置就是预测的那个位置：标记 45x120 CSS 像素，按下 1 屏幕像素 = 1/dpr CSS 像素。
    expect((scrolled.red?.box?.width ?? 0) / (scrolled.red?.box?.height ?? 1)).toBeGreaterThan(0.2)

    // ── 二、缩小到 50%：不滚也看得见，蓝条高度减半 ────────────────────────────
    await session.evaluate('window.scrollTo(0, 0); void 0')
    await session.zoomTo(0.5)
    await new Promise((settle) => setTimeout(settle, 500))
    const factsAtHalf = await facts()
    const atHalf = await capture('zoom50')
    console.log(
      'RAW the acceptance reading: ' +
        JSON.stringify({ facts: factsAtHalf, red: atHalf.red, barHeight: atHalf.bar?.box?.height }),
    )
    // 布局这一半（截图能答）：页面装得下，而且没有横向溢出。
    expect(factsAtHalf.innerWidth).toBe(1240)
    expect(Number(factsAtHalf.scrollWidth)).toBeLessThanOrEqual(Number(factsAtHalf.innerWidth))
    // 渲染这一半（只有真窗口像素能答）：最右端**真的出现在窗格里**，
    // 而且内容**真的被缩小了** —— 蓝条在窗口像素里的高度减半，不是"视口变窄"。
    expect(
      atHalf.red?.count ?? 0,
      'zooming out to 50% must put the page-rightmost marker INSIDE the pane, on screen',
    ).toBeGreaterThan(0)
    expect(atHalf.bar?.box?.height ?? 0, 'the content must really be scaled down: the bar is half as tall').toBeLessThan(
      barHeightAtOne * 0.6,
    )
    // 红标落在**窗格**的右半边：它是页面最右端，而窗格的左半边是条子的起点。
    // 窗格在窗口画面里有多宽，用 100% 时那条蓝条的宽度量（条子比窗格宽，所以它就是窗格宽）。
    const paneWidthInWindowPixels = atOne.bar?.box?.width ?? 0
    expect(atHalf.red?.box?.left ?? 0).toBeGreaterThan(paneWidthInWindowPixels * 0.5)

    // ── 三、反证：把缩放撤掉，红标必须回到"看不见" ─────────────────────────────
    await session.resetZoom()
    await new Promise((settle) => setTimeout(settle, 500))
    const backToOne = await capture('zoom100-again')
    console.log('RAW the counter-proof: ' + JSON.stringify({ facts: await facts(), red: backToOne.red }))
    expect(
      backToOne.red?.count ?? 0,
      'with the zoom removed the marker must be out of the pane again — otherwise the reading above proves nothing',
    ).toBe(0)
    expect(Math.abs((backToOne.bar?.box?.height ?? 0) - barHeightAtOne)).toBeLessThan(barHeightAtOne * 0.15)
  }, 300_000)
})
