import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { SpaceManager } from '../src/spaces.ts'
import type { AdoptedViewSession } from '../src/session.ts'
import { pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #19 的**行为验收**：栏宽一变，页面自己缩放到刚好塞得下；而它不许动那些本来就正常的页面。
 *
 * ## 为什么这一份必须存在，而且必须是这一种形状
 *
 * 用户的诉求只有一句话："栏宽一变，页面自动缩放到刚好塞得下（不用我按 −）"。这句话里
 * **每一个词都要能被量出来**，而这个文件就是那把尺子：
 *
 *  - **"栏宽一变"** —— 栏宽由测试从窗口那一页真的改（`setRect`，与面板走的是同一条通道），
 *    不是调一个内部函数假装改过；
 *  - **"自动"** —— 全程**没有任何人按过按钮**：外壳是用 `startShell` 起的（没有 `--dsh`，
 *    这条进程树里根本没有宿主、没有插件、没有面板那条 RPC），所以"页面自己变了"这件事
 *    没有第二个可能的来源；
 *  - **"刚好塞得下"** —— 读的是**页面自己**报的 `scrollWidth` / `clientWidth`（`fitFacts()`），
 *    以及页面最右端那块红标**在不在布局视口里**；
 *  - **"不用我按 −"** —— 见上；而且反过来，手动按过之后自动适配必须**让位**，这一条也在这里量。
 *
 * ## 被量下来的两件事（票面点名要求，不许只推理）
 *
 * 1. **收敛**：固定宽度页面（内容写死 1200px）几步之内稳定；响应式页面（`/fluid`）
 *    **一步都不动** —— 后者的证据不是"缩放没变"这一句，而是外壳自己记的
 *    `fitPasses > 0` **且** `fitChanges === 0`：适配真的跑了，而且每一次都决定不动手。
 * 2. **不震荡**：连续拖动时把页面自己报的 `devicePixelRatio` 逐帧采下来（`dpr = 屏幕dpr × zoom`，
 *    ADR-0013 量过），于是缩放的**时间线**是页面自己写的。变窄时它必须单调不增，变宽时单调不减。
 *
 * ## 跟手延迟
 *
 * 票面把这一条点成"这张票能不能用的关键"：走"面板 → 宿主 → 请求文件 → 外壳 150ms 轮询"那条路
 * 实测一次要 ~1 秒（ADR-0013 的诚实清单，`tests/panel-toolbar.spec.ts` 每次跑都会重新印一遍
 * `coldMs`/`warmMs`），所以本票把适配放在**外壳**这一侧：几何一变就自己算。
 * 这里量三个数，全部来自两个进程各自的 `Date.now()`（同一台机器，同一个时钟）：
 *
 *  - **一次跳变**：窗口那一页 `setRect` 的那一刻 → 页面自己报"装得下了"的第一帧；
 *  - **一次拖动**：`setRect` 的最后一次 → 同一件事；
 *  - **读数的延迟**：页面装得下的那一刻 → 插件能读到新读数的那一刻（`zoom.json` 的 `at`）。
 */

const HERE_TITLE = 'T19-FIT-WINDOW'

/** 栏拖窄时用的那个宽度（票面点名的 620）。 */
const NARROW = 620

/** 栏的初始宽度：宽到能完整放下那张 1200px 的夹具页。 */
const WIDE = 1240

/**
 * 窗口那一页：它只做一件事 —— 把"这一格占多大"报给外壳，并按测试的要求改。
 *
 * 每一次上报都打一个时间戳（`Date.now()`），于是"栏宽是哪一刻变的"由**窗口自己**说，
 * 而不是由测试进程猜。这与真面板走的是同一条通道（`window.__dshDesktopView.setRect`，
 * 由 `shell/preload.js` 注入）。
 */
const WINDOW_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${HERE_TITLE}</title>
<style>html,body{margin:0;background:#dddddd;font:16px system-ui}</style></head>
<body><p>stand-in for the DSH web UI — the pane is the rectangle reported below</p>
<script>
  window.paneSends = []
  window.sendPane = function (width, height) {
    var rect = { x: 0, y: 0, width: width, height: height }
    window.__dshDesktopView.setRect(rect)
    window.paneSends.push({ at: Date.now(), width: width })
    return window.paneSends.length
  }
  window.addEventListener('load', function () { window.sendPane(${WIDE}, 800) })
</script>
</body></html>`

/**
 * 页面那一侧的取证器：每一帧记一次"我自己现在什么样"，留在页面上供测试读回。
 *
 * 为什么逐帧而不是等测试来问：适配是**外壳**改的缩放，测试来问的时候一切都已经结束了；
 * 而"变窄的过程中有没有来回跳"只有时间线答得出来。记的东西全是页面自己的读数，
 * 没有一个是测试塞进去的期望值。
 */
const RECORDER = `(() => {
  window.__t19 = { frames: [] }
  const step = () => {
    const root = document.documentElement
    window.__t19.frames.push({
      at: Date.now(),
      innerWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      dpr: window.devicePixelRatio,
      fits: root.scrollWidth <= root.clientWidth,
    })
    // 有界：一份时间线不该把页面自己撑爆。
    if (window.__t19.frames.length > 900) window.__t19.frames.splice(0, 300)
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
  return true
})()`

/** 页面那一侧的一帧。 */
interface Frame {
  at: number
  innerWidth: number
  scrollWidth: number
  clientWidth: number
  dpr: number
  fits: boolean
}

describe('票 #19 · 栏宽一变，页面自己缩放到刚好塞得下（真外壳 + 真页面）', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  let spaces: SpaceManager
  let browser: Browser | undefined
  let page: Page
  let windowPage: Page
  let windowBrowser: Browser | undefined
  let server: { close: () => Promise<void> }
  let origin: string

  /** 视图那一页自己报的事实（`shell/fixture.js` 的 `fitFacts()`）。 */
  const facts = async (): Promise<Record<string, number>> =>
    JSON.parse(String(await page.evaluate(() => (window as unknown as { fitFacts: () => string }).fitFacts())))

  /** 窗口那一页记下来的每一次栏宽变化。 */
  const paneSends = async (): Promise<Array<{ at: number; width: number }>> =>
    (await windowPage.evaluate(() => (window as unknown as { paneSends: Array<{ at: number; width: number }> }).paneSends)) ?? []

  /** 页面自己写的那条时间线。 */
  const frames = async (): Promise<Frame[]> =>
    (await page.evaluate(() => (window as unknown as { __t19?: { frames: Frame[] } }).__t19?.frames ?? [])) ?? []

  /**
   * 在**当前这份文档**上装取证器。
   *
   * 每次 `goto` 之后都要重装一次：换页就是换文档，页面上的东西（包括这个取证器）全都没了。
   * 这不是防御，是这一份用例的构造：它量的是"页面自己看到了什么"，而页面每次换页都是新的一个。
   */
  const armRecorder = async (): Promise<void> => {
    await page.evaluate(RECORDER)
  }

  /** 把时间线清空，好让下一段只留下这一段的事。 */
  const clearFrames = async (): Promise<void> => {
    await page.evaluate(() => {
      const seen = (window as unknown as { __t19?: { frames: Frame[] } }).__t19
      if (seen !== undefined) seen.frames.length = 0
    })
  }

  /** 改栏宽（走的是真面板那条通道：`setRect`）。 */
  const setPane = async (width: number): Promise<void> => {
    await windowPage.evaluate((w: number) => (window as unknown as { sendPane: (w: number, h: number) => number }).sendPane(w, 800), width)
  }

  /**
   * 一段**连续的**拖动：每 ~16ms 改一像素宽度，像人拖分栏条那样。
   *
   * @param from - 起始宽度。
   * @param to - 结束宽度。
   * @param steps - 分几步走完。
   */
  const dragPane = async (from: number, to: number, steps: number): Promise<void> => {
    for (let step = 1; step <= steps; step += 1) {
      await setPane(Math.round(from + ((to - from) * step) / steps))
      await new Promise((settle) => setTimeout(settle, 16))
    }
  }

  /**
   * 等页面**既装得下、又不再变化**，或超时。
   *
   * 两条都要：拖动中间那几帧里页面常常已经"装得下"了（对着当时的栏宽），而拖动还没走完 ——
   * 只等第一条会读到一个中途状态，断言就会拿着半路的数据说话（实测踩过一次：栏还在 712，
   * 用例却以为它已经是 620）。
   *
   * @param timeoutMs - 最多等多久。
   * @returns 它花了多久（毫秒），超时返回 -1。
   */
  const waitForFit = async (timeoutMs = 8000): Promise<number> => {
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
   * 改一次栏宽，并把它**在窗口那一页记下的时刻**带回来。
   *
   * 延迟就是从这一刻开始算的：那一刻之前的页面状态与之后要发生的事无关，而"栏宽是哪一刻变的"
   * 只有窗口那一页说得准（它自己 `Date.now()`）。
   *
   * @param width - 新的栏宽。
   * @returns 窗口那一页记下的时间戳。
   */
  const setPaneStamped = async (width: number): Promise<number> => {
    await setPane(width)
    const sends = await paneSends()
    return sends[sends.length - 1]?.at ?? 0
  }

  /** 等到页面自己的读数稳定下来（连续两次一样），这样"改栏宽之前"是确定的。 */
  const settle = async (timeoutMs = 4000): Promise<void> => {
    const started = Date.now()
    let previous = ''
    while (Date.now() - started < timeoutMs) {
      const now = JSON.stringify(await facts())
      if (now === previous) return
      previous = now
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  /**
   * 等**外壳真的把栏摆到那个宽度**，或超时。
   *
   * 为什么不能只等"页面装得下了"：拖动中间有很多时刻页面是装得下的（比如第一步 1214 还放得下
   * 1200 的整页），于是那一条会**在拖动中途就返回**，用例随后读到的是一段半路的时间线
   * （整套跑的时候踩过一次：时间线最后一个值是 100%，而拖动其实还没走完）。
   * 外壳自己的落点记录是"栏宽现在是多少"的唯一权威。
   *
   * @param width - 期望的栏宽（与 `setRect` 报出去的那个数一样）。
   * @param timeoutMs - 最多等多久。
   * @returns 它花了多久（毫秒），超时返回 -1。
   */
  const waitForPaneWidth = async (width: number, timeoutMs = 10_000): Promise<number> => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const placement = shell.latestPlacement()
      if (placement?.reported?.width === width) return Date.now() - started
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return -1
  }

  /** 外壳自己记的适配读数（`zoom.json`，插件读的就是它）。 */
  const reading = (): ReturnType<SpaceManager['zoomReading']> => spaces.zoomReading('default')

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

    // 视图那一页用外壳**自带**的夹具站（`/fixed-width`、`/fluid`）：它就在外壳进程里，
    // 所以测试与"人自己跑 `npm run shell:fixture` 时看到的那一页"是同一份标记。
    shell = await startShell([`--url=${origin}/window`, '--bounds', `0,0,${WIDE},800`], {
      windowSize: { width: WIDE, height: 900 },
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
  })

  it('固定宽度页面：把栏拖窄，整页自己进来了（没有任何人按过按钮），拖回宽处又回到 100%', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/fixed-width`)
    await armRecorder()
    await new Promise((settle) => setTimeout(settle, 600))

    // ── 零点：栏 1240 宽，页面 1200 宽 —— **它本来就塞得下**，所以适配一步都不许动 ──
    const atWide = await facts()
    console.log('RAW 栏 1240 时的页面读数: ' + JSON.stringify(atWide))
    expect(atWide.barWidth, 'the fixture must really be 1200px wide').toBe(1200)
    expect(Number(atWide.scrollWidth), 'a page that fits must report no overflow').toBeLessThanOrEqual(
      Number(atWide.clientWidth),
    )
    expect(Number(atWide.devicePixelRatio), 'a page that already fits must not be zoomed').toBeGreaterThan(1)
    const dprAtWide = Number(atWide.devicePixelRatio)
    const readingAtWide = reading()
    console.log('RAW 栏 1240 时外壳的读数: ' + JSON.stringify(readingAtWide))
    expect(readingAtWide?.mode).toBe('auto')
    expect(readingAtWide?.zoom, 'nothing to fit at 1240 — the zoom must still be 100%').toBeCloseTo(1, 3)

    // ── 拖窄：这是票面第一条验收（"把栏拖到 620 宽，整页自动可见"） ──
    const beforeDrag = reading()
    await dragPane(WIDE, NARROW, 20)
    const paneMs = await waitForPaneWidth(NARROW)
    const tookMs = await waitForFit()
    const atNarrow = await facts()
    const afterDrag = reading()
    console.log(
      'RAW 拖到 620 之后: ' +
        JSON.stringify({ facts: atNarrow, reading: afterDrag, waitedMs: tookMs, paneMs, earlier: beforeDrag }),
    )
    expect(paneMs, 'the shell must have applied the pane width the drag ended on').toBeGreaterThanOrEqual(0)
    expect(tookMs, 'the page must fit itself after the drag, with nobody pressing anything').toBeGreaterThanOrEqual(0)
    expect(Number(atNarrow.scrollWidth), 'the whole page must be inside the layout viewport now').toBeLessThanOrEqual(
      Number(atNarrow.clientWidth),
    )
    // **"整页可见"** —— 页面最右端那块红标（x=1150..1195）必须落在布局视口里。
    expect(Number(atNarrow.markerLeft) + 45).toBeLessThanOrEqual(Number(atNarrow.innerWidth))
    // 而且它**真的被缩小了**，不是"视口变宽了"那种假象（那是 CDP 那条路，ADR-0013 已否决）。
    expect(Number(atNarrow.devicePixelRatio)).toBeLessThan(dprAtWide)
    // 外壳记的那笔账：模式仍是自动，缩放被改过，而且改的值就是"刚好塞下"那个。
    expect(afterDrag?.mode).toBe('auto')
    expect(afterDrag?.zoom ?? 1).toBeLessThan(1)
    expect(afterDrag?.fitChanges ?? 0).toBeGreaterThan(0)
    // 布局视口 × zoom == 源视口（栏宽）：这正是"缩放到刚好塞下"的算术形态。
    expect(Math.abs(Number(atNarrow.innerWidth) * Number(afterDrag?.zoom ?? 1) - NARROW)).toBeLessThan(8)
    // 外壳真的为此发过一行 FIT，且那一行说得清改了哪几步。
    const fitLines = shell
      .stdout()
      .split(/\r?\n/)
      .filter((line) => line.startsWith('DSH_SHELL FIT '))
    console.log('RAW 外壳的适配记录: ' + JSON.stringify(fitLines.slice(-2)))
    expect(fitLines.length, 'the shell must publish what the fit did').toBeGreaterThan(0)

    // ── 拖回宽处：票面第二条验收（回到 100%） ──
    await dragPane(NARROW, WIDE, 20)
    await new Promise((settle) => setTimeout(settle, 400))
    const backWide = await facts()
    const readingBackWide = reading()
    console.log('RAW 拖回 1240 之后: ' + JSON.stringify({ facts: backWide, reading: readingBackWide }))
    expect(readingBackWide?.zoom, 'widening the pane must put the zoom back to 100%').toBeCloseTo(1, 3)
    expect(Number(backWide.devicePixelRatio)).toBeCloseTo(dprAtWide, 2)
  }, 300_000)

  it('响应式页面：拖多少次栏宽都一步都不动（跑了，但一次都没改）', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/fluid`)
    await new Promise((settle) => setTimeout(settle, 600))
    // 先回宽处：上一条用例可能把栏留在别的地方。
    await setPane(WIDE)
    await new Promise((settle) => setTimeout(settle, 400))

    const before = reading()
    const dprBefore = Number((await facts()).devicePixelRatio)
    // 一段"来回拖"：窄 → 宽 → 窄 → 宽。震荡如果存在，这里最容易被逼出来。
    await dragPane(WIDE, NARROW, 12)
    await dragPane(NARROW, WIDE, 12)
    await dragPane(WIDE, 420, 12)
    await dragPane(420, WIDE, 12)
    await new Promise((settle) => setTimeout(settle, 600))

    const after = reading()
    const atEnd = await facts()
    console.log(
      `RAW 响应式页面来回拖了 48 步: ` +
        JSON.stringify({ before, after, dprBefore, dprAfter: atEnd.devicePixelRatio, facts: atEnd }),
    )
    // **这一条才是那张票点名"极其重要"的**：本来正常的响应式页面不许被缩放掉。
    expect(Number(atEnd.devicePixelRatio), 'a responsive page must not be zoomed').toBeCloseTo(dprBefore, 3)
    expect(after?.zoom).toBeCloseTo(1, 3)
    // 而"没动"必须是**判断的结果**，不是"适配压根没跑"：跑过的轮数要涨，改过的次数要一动不动。
    expect(after?.fitPasses ?? 0, 'the fit must have run — silence must not be confused with agreement').toBeGreaterThan(
      before?.fitPasses ?? 0,
    )
    expect(after?.fitChanges ?? 0, 'a responsive page gives the fit nothing to correct').toBe(before?.fitChanges ?? 0)
    // 页面自己也没有横向溢出 —— 上面那句"不许动"量的是一个真的不需要动的页面。
    expect(Number(atEnd.scrollWidth)).toBeLessThanOrEqual(Number(atEnd.clientWidth))
  }, 300_000)

  it('手动缩放优先：按过之后拖栏宽不会把用户的值改回去；「自动」再把这一格交回来', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/fixed-width`)
    await new Promise((settle) => setTimeout(settle, 400))
    await setPane(NARROW)
    await new Promise((settle) => setTimeout(settle, 600))

    // 起点：自动适配已经把这一页缩到 620 的栏里了（换页之后它自己适配的，没人按过任何按钮）。
    const fitted = await facts()
    const autoReading = reading()
    console.log('RAW 自动适配之后: ' + JSON.stringify({ facts: fitted, reading: autoReading }))
    expect(Number(fitted.barWidth), 'the fixture is a fixed-width page: 1200px of content').toBeCloseTo(1200, 0)
    expect(autoReading?.mode).toBe('auto')
    expect(autoReading?.zoom ?? 1, 'a 1200px page in a 620px pane has to be shrunk to fit').toBeLessThan(1)

    // 用户按了一次 `100%`（走的是会话那条真通道：请求文件 → 外壳）。这一按就是"我说了算"。
    const reset = await session.resetZoom()
    const manualFacts = await facts()
    console.log('RAW 按下 100% 之后: ' + JSON.stringify({ reset, facts: manualFacts, reading: reading() }))
    expect(reset.zoom).toBe(1)
    expect(reading()?.mode, 'an explicit zoom means the person is in charge now').toBe('manual')
    // 现在这一页**真的塞不下了** —— 这就是"手动接管"的可见代价，也是下面那条断言的前提。
    expect(Number(manualFacts.scrollWidth)).toBeGreaterThan(Number(manualFacts.clientWidth))

    // 再拖栏宽两次：自动适配必须**让位**（它明明有能力把这一页塞进来，但不许动手）。
    await dragPane(NARROW, 900, 8)
    await dragPane(900, NARROW, 8)
    await new Promise((settle) => setTimeout(settle, 600))
    const afterDrag = await facts()
    const readingAfterDrag = reading()
    console.log('RAW 手动模式下拖完栏宽: ' + JSON.stringify({ facts: afterDrag, reading: readingAfterDrag }))
    expect(readingAfterDrag?.mode).toBe('manual')
    expect(readingAfterDrag?.zoom, 'a manual zoom must survive a pane drag').toBeCloseTo(1, 3)
    expect(
      Number(afterDrag.scrollWidth),
      'the page must still be cut off: the fit was told to stand down, and it did',
    ).toBeGreaterThan(Number(afterDrag.clientWidth))

    // 「自动」把它交回来：适配立刻接手，页面又刚好塞得下。
    const handedBack = await session.useAutoZoom()
    const afterAuto = await facts()
    const readingAfterAuto = reading()
    console.log('RAW 按下「自动」之后: ' + JSON.stringify({ handedBack, facts: afterAuto, reading: readingAfterAuto }))
    expect(readingAfterAuto?.mode).toBe('auto')
    expect(readingAfterAuto?.zoom ?? 1).toBeLessThan(1)
    expect(Number(afterAuto.scrollWidth)).toBeLessThanOrEqual(Number(afterAuto.clientWidth))
    // 交回去之后，栏宽再变它又跟着走了（这才叫"交回来了"，而不是只有那一次例外）。
    await setPane(700)
    await new Promise((settle) => setTimeout(settle, 600))
    const afterSecondDrag = await facts()
    console.log('RAW 交回自动之后再拖一次: ' + JSON.stringify(afterSecondDrag))
    expect(Number(afterSecondDrag.scrollWidth)).toBeLessThanOrEqual(Number(afterSecondDrag.clientWidth))
    expect(Number(afterSecondDrag.devicePixelRatio)).not.toBeCloseTo(Number(manualFacts.devicePixelRatio), 3)
  }, 300_000)

  it('不震荡：连续拖动时缩放单调收敛，而且跟手延迟量得出来', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/fixed-width`)
    await armRecorder()
    await new Promise((settle) => setTimeout(settle, 400))
    await setPane(WIDE)
    await settle()
    // 从"交回自动"开始：上一条用例把它留在手动上。
    await session.useAutoZoom()
    await settle()
    expect(reading()?.zoom, 'the starting point of this measurement is 100% at a pane wide enough').toBeCloseTo(1, 3)

    // ── 一次跳变：栏宽一口气从 1240 到 620 ──
    await clearFrames()
    const jumpSentAt = await setPaneStamped(NARROW)
    const jumpPaneMs = await waitForPaneWidth(NARROW)
    const settleMs = await waitForFit()
    // 让时间线把"装得下了"那一刻记下来再读（读得太早会漏掉最后那一帧）。
    await new Promise((resolve) => setTimeout(resolve, 120))
    const jumpTimeline = await frames()
    const firstFitFrame = jumpTimeline.find((frame) => frame.fits && frame.at >= jumpSentAt)
    const jumpLatency = firstFitFrame === undefined ? -1 : firstFitFrame.at - jumpSentAt
    console.log(
      `RAW 跟手延迟（一次跳变 1226→620）: ` +
        JSON.stringify({ jumpLatency, settleMs, jumpPaneMs, frames: jumpTimeline.length, firstFitFrame, jumpSentAt }),
    )
    expect(firstFitFrame, 'the page timeline must contain the moment it fitted').toBeDefined()
    expect(jumpLatency, 'the pane change must reach the page as a fitted page, not as a report to a host').toBeGreaterThanOrEqual(0)
    expect(jumpLatency, 'the ticket draws the line at 200ms: past that it is not "instant"').toBeLessThan(200)
    // 而那条路**要多久**：同一个动作经面板 → 宿主 → 请求文件 → 150ms 轮询 —— 每次按 ~1 秒
    // （ADR-0013 的诚实清单，`tests/panel-toolbar.spec.ts` 每次跑都重新印一遍 coldMs/warmMs）。
    // 这条断言把两个数量级摆在一起：适配这条路必须是几十毫秒那一档。
    expect(jumpLatency, 'this is the number that decides whether the feature is usable at all').toBeLessThan(1000 / 5)

    // ── 一段拖动：变窄 → 变宽，缩放的**时间线**必须单调 ──
    await setPane(WIDE)
    await settle()
    await session.useAutoZoom()
    await settle()
    await clearFrames()
    const beforeNarrowing = (await paneSends()).length
    await dragPane(WIDE, NARROW, 24)
    const narrowPaneMs = await waitForPaneWidth(NARROW)
    const lastNarrowAt = (await paneSends())[(await paneSends()).length - 1]?.at ?? 0
    const narrowFitMs = await waitForFit()
    const narrowing = await frames()
    console.log(
      'RAW 变窄这一段之后: ' +
        JSON.stringify({
          paneMs: narrowPaneMs,
          fitMs: narrowFitMs,
          reading: reading(),
          facts: await facts(),
          lastFit: shell
            .stdout()
            .split(/\r?\n/)
            .filter((line) => line.startsWith('DSH_SHELL FIT '))
            .slice(-1)[0],
        }),
    )
    await clearFrames()
    const beforeWidening = (await paneSends()).length
    await dragPane(NARROW, WIDE, 24)
    const widePaneMs = await waitForPaneWidth(WIDE)
    const lastWideAt = (await paneSends())[(await paneSends()).length - 1]?.at ?? 0
    await new Promise((resolve) => setTimeout(resolve, 600))
    const widening = await frames()
    if (beforeNarrowing === 0 || beforeWidening === 0) throw new Error('the pane timeline is empty — nothing was measured')
    expect(Math.min(narrowPaneMs, widePaneMs), 'both drags must have reached the width they aimed at').toBeGreaterThanOrEqual(0)

    /** 把逐帧的 dpr 折成"缩放变过几次、按什么顺序变"。同一档连着多少帧只算一次。 */
    const zoomSteps = (timeline: Frame[], screenDpr: number): number[] => {
      const steps: number[] = []
      for (const frame of timeline) {
        const zoom = Math.round((frame.dpr / screenDpr) * 1000) / 1000
        if (steps.length === 0 || Math.abs(steps[steps.length - 1] - zoom) > 0.005) steps.push(zoom)
      }
      return steps
    }
    const screenDpr = Number((await facts()).devicePixelRatio) // 已经回到 100%，所以这就是屏幕 dpr
    const narrowed = zoomSteps(narrowing, screenDpr)
    const widened = zoomSteps(widening, screenDpr)
    const firstFitAfterNarrowing = narrowing.find((frame) => frame.fits && frame.at >= lastNarrowAt)
    const dragLatency = firstFitAfterNarrowing === undefined ? -1 : firstFitAfterNarrowing.at - lastNarrowAt
    const wideningFit = widening.find((frame) => frame.fits && frame.at >= lastWideAt)
    const widenLatency = wideningFit === undefined ? -1 : wideningFit.at - lastWideAt
    console.log(
      'RAW 拖动时的时间线: ' +
        JSON.stringify({
          dprAtRest: screenDpr,
          narrowed,
          widened,
          framesNarrowing: narrowing.length,
          framesWidening: widening.length,
          dragLatency,
          widenLatency,
          firstFitAfterNarrowing,
          lastNarrowAt,
          lastWideAt,
        }),
    )
    // 单调：变窄时每一步都不许变大，变宽时每一步都不许变小。这就是"不震荡"。
    for (let index = 1; index < narrowed.length; index += 1) {
      expect(narrowed[index], `narrowing must not bounce back up: ${JSON.stringify(narrowed)}`).toBeLessThanOrEqual(
        narrowed[index - 1] + 0.005,
      )
    }
    for (let index = 1; index < widened.length; index += 1) {
      expect(widened[index], `widening must not bounce back down: ${JSON.stringify(widened)}`).toBeLessThanOrEqual(
        1.005,
      )
      expect(widened[index] + 0.005, `widening must not bounce back down: ${JSON.stringify(widened)}`).toBeGreaterThanOrEqual(
        widened[index - 1],
      )
    }
    expect(narrowed.length, 'the zoom must really have moved while the pane narrowed').toBeGreaterThan(1)
    expect(narrowed.length, 'a drag must not take an unbounded number of zoom changes').toBeLessThanOrEqual(30)
    expect(dragLatency, 'after the last pixel of a drag, the page must fit itself quickly').toBeLessThan(200)
    expect(widenLatency, 'widening back must also be picked up quickly').toBeLessThan(200)
    expect(narrowed[narrowed.length - 1], 'at 620 the 1200px page must be zoomed out').toBeLessThan(0.9)
    expect(widened[widened.length - 1], 'back at 1226 it must be 100% again').toBeCloseTo(1, 2)
  }, 300_000)

  it('缩放治不了的溢出：试一次、放回原处、此后不再碰这一页（也不许一路缩下去）', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/unfixable`)
    await new Promise((settle) => setTimeout(settle, 400))
    await setPane(NARROW)
    await settle()

    const atRest = await facts()
    const firstReading = reading()
    const changesAtRest = firstReading?.fitChanges ?? 0
    console.log('RAW 治不了的溢出页: ' + JSON.stringify({ facts: atRest, reading: firstReading }))
    // 前提：这一页在**任何** zoom 下都塞不下（宽 40px 是常数），所以"没被缩放"是判据本身。
    expect(Number(atRest.barWidth) - Number(atRest.clientWidth), 'the fixture must overflow by a fixed amount').toBeCloseTo(40, 0)
    expect(firstReading?.zoom, 'the fit must have declined, not shrunk').toBeCloseTo(1, 3)

    // 反复拖栏宽：每一次都给它一次"再试一次"的机会，而它必须每次都拒绝。
    await dragPane(NARROW, 900, 10)
    await dragPane(900, NARROW, 10)
    await dragPane(NARROW, 1100, 10)
    await settle()
    const afterDrags = await facts()
    const lastReading = reading()
    console.log('RAW 治不了的溢出页（拖了 30 步之后）: ' + JSON.stringify({ facts: afterDrags, reading: lastReading }))
    expect(lastReading?.zoom, 'thirty drag steps must not shrink a page that no zoom can fix').toBeCloseTo(1, 3)
    expect(Number(afterDrags.devicePixelRatio)).toBeCloseTo(Number(atRest.devicePixelRatio), 3)
    expect(
      (lastReading?.fitChanges ?? 0) - changesAtRest,
      'it may try once, but it must not keep "correcting" forever',
    ).toBeLessThanOrEqual(2)
    // 而"拒绝了"这件事要说出来：整屏安静与"适配坏了"在界面上长得一模一样。
    const declined = shell
      .stdout()
      .split(/\r?\n/)
      .filter((line) => line.includes('"declined"'))
    console.log('RAW 拒绝的记录: ' + JSON.stringify(declined.slice(-1)))
    expect(declined.length, 'a refusal must be published, otherwise silence looks like a broken fit').toBeGreaterThan(0)
  }, 300_000)
})
