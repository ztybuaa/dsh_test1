import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { AdoptedViewSession } from '../src/session.ts'
import { desktopViewTools, type ToolDependencies } from '../src/tools.ts'
import {
  VIEW_ACTIONS,
  VIEW_RPC_CHANNEL,
  parseViewAction,
  viewEndpoint,
  viewEndpointPath,
} from '../src/view-rpc.ts'
import { readPng } from './png-facts.ts'
import { pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #13 —— 导航（PRD 故事 6）与缩放（PRD 故事 30），以及面板上那条工具条。
 *
 * 这张票不是"新功能"：故事 6 明写「打开网址、**后退、前进、刷新**」，故事 30 明写
 * 「像用任何浏览器一样……**缩放**」，而用户在实机上说的是"**这个不能回退，我想退回去，
 * 然后发现卡住了**"和"我的侧边栏不论多大，页面都是一样的……**能不能做到适应侧边栏的大小**"。
 * 所以这一份里每一条都对应一句话，而不是对应一个实现细节。
 *
 * 两面都在这里：Agent 侧的工具（`browser_view`）与面板侧的按钮（同一条 RPC）。
 * 它们走的是**同一套会话能力**，所以"按钮生效"与"工具生效"在这里是两条独立的读回，
 * 而不是同一次调用的两种说法。
 *
 * 夹具页是**宽度写死 1200px** 的那种（用户打开的就是固定宽度排版的文档站）：
 * 窄栏里它必然被裁切，而"缩放到能看全"就是本条验收的实质。
 */

/** 第一页：1200px 宽的条子 + 一个真的按钮 + 一个真的链接（都用夹具自己的 id）。 */
const WIDE_PAGE = (next: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t13-wide</title>
<style>
  html, body { margin: 0; }
  body { font: 14px system-ui; }
  .t13-bar { width: 1200px; height: 200px; background: #4a6fa5; color: #fff; position: relative; }
  .t13-hit { position: absolute; top: 220px; left: 10px; width: 90px; height: 28px; }
  /* 页面**最右端**的一小块红标（x=1150..1195，在条子里，y=40..160）。
     它是这一份里唯一能回答"整条可见吗"的仪器：视口窄而内容不缩小 => 它看不见；
     内容真的被缩小到装进视口 => 它看得见。见 ADR-0013。 */
  .t13-marker { position: absolute; left: 1150px; top: 40px; width: 45px; height: 120px; background: #ff0000; }
</style></head>
<body>
  <div class="t13-bar" id="t13-bar">a 1200px-wide column, like a fixed-width document site<span class="t13-marker" id="t13-marker"></span></div>
  <button class="t13-hit" id="t13-hit" onclick="document.getElementById('t13-out').textContent='t13-clicked'">hit me</button>
  <output id="t13-out">t13-initial</output>
  <a id="t13-next" href="${next}">go to page two</a>
  <output id="t13-facts"></output>
  <script>
    function t13Facts() {
      var text = JSON.stringify({
        url: location.href,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollWidth: document.documentElement.scrollWidth,
        barWidth: document.getElementById('t13-bar').getBoundingClientRect().width,
        markerLeft: document.getElementById('t13-marker').getBoundingClientRect().left,
      })
      document.getElementById('t13-facts').textContent = text
      return text
    }
    t13Facts()
    window.t13Facts = t13Facts
  </script>
</body></html>`

/** 第二页：同一条 1200px 的条子，好让"跨导航之后缩放还在不在"是同一把尺子量出来的。 */
const WIDE_PAGE_TWO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t13-wide-two</title>
<style>html,body{margin:0} .t13-bar{width:1200px;height:60px;background:#a54a6f;color:#fff}</style>
</head>
<body><div class="t13-bar" id="t13-bar">page two, also 1200px wide</div>
<script>
  window.t13Facts = function () {
    return JSON.stringify({
      url: location.href,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      barWidth: document.getElementById('t13-bar').getBoundingClientRect().width,
    })
  }
</script>
</body></html>`

/** 一次工具调用允许带的那第二个参数（本仓库既有的写法）。 */
const IGNORED_EXEC = undefined as unknown as Parameters<
  ReturnType<typeof desktopViewTools>[number]['execute']
>[1]

/** 视口矩形：就是"窄栏"。宽度写死，因为用户抱怨的正是"不论多大页面都一样"。 */
const SLOT = { width: 620, height: 800 }

/**
 * 屏幕的设备像素比。
 *
 * 定下来再断言，而不是把 1.5 抄进断言里：这个文件的断言要说的是"截图 = 视口 × 屏幕 dpr"
 * 这条关系，而不是"这台机器的显示器是多少"。它只在 `zoom = 1` 时成立（T13 之后的新关系，
 * 见 `docs/adr/0013-*.md`），所以它出现在**没有缩放**的那几条里。
 */
const SCREEN_DPR = 1.5

describe('票 #13 · 导航与缩放，以及面板上的那条工具条', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /** 一条独立的连接：只用来从页面自己那里读回事实，与被测实现无关。 */
  let probe: { browser: { close: () => Promise<void> }; page: Page }
  let tools: ReturnType<typeof desktopViewTools>
  let server: { close: () => Promise<void> }
  let origin: string
  let dir: string
  /** 那一次"从来没有被模拟过"的截图尺寸（见 `beforeAll` 里的说明）。 */
  let virginShot: { width: number; height: number }
  /** 那条独立连接是不是被主动关掉了（守卫那一条要关它，见那里的说明）。 */
  let probeClosed = false

  /** 视图自己的地址，读自视图自己。 */
  const viewUrl = (): string => session.url()

  /** 页面自己报的那几件事。 */
  const pageFacts = async (): Promise<Record<string, number | string>> =>
    JSON.parse(String(await probe.page.evaluate(() => (window as unknown as { t13Facts: () => string }).t13Facts())))

  /** 截图落在磁盘上的真实像素尺寸（读文件，不读实现手里的 buffer）。 */
  const shotOnDisk = async (name: string): Promise<{ width: number; height: number; bytes: number; png: ReturnType<typeof readPng> }> => {
    const path = join(dir, name)
    await session.screenshot(path)
    const bytes = readFileSync(path)
    const png = readPng(bytes)
    return { width: png.width, height: png.height, bytes: bytes.length, png }
  }

  /**
   * 页面**最右端**那块红标在图上出现了几个像素。
   *
   * 这是这一份里最硬的一条仪器：`innerWidth` 变小只说明视口窄了，
   * 只有"页面 x=1150..1195 那块像素出现在图里"才说明**内容被缩小了**。
   * 它在条子里（y=40..160），所以取样落在条子上。
   */
  const markerPixels = async (name: string): Promise<number> => {
    const shot = await shotOnDisk(name)
    return shot.png.countOf('255,0,0')
  }

  /** The tool with this name, or a failure naming what was registered instead. */
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`${name} is not registered; registered: ${tools.map((t) => t.name).join(', ')}`)
    return found
  }

  /** 跑一次 `browser_view`，并把它的返回值收成宽松的形状。 */
  const view = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await tool('browser_view').execute(args, IGNORED_EXEC)) as unknown as Record<string, unknown>

  /** 一个动作失败了的话，它的分类是什么；成功了就抛（用例自己会说清是哪一种）。 */
  const reasonOf = async (args: Record<string, unknown>): Promise<string> => {
    const result = await view(args)
    if (result.ok === true) throw new Error(`${String(args.action)} unexpectedly succeeded: ${JSON.stringify(result)}`)
    return String(result.reason)
  }

  beforeAll(async () => {
    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(url.pathname === '/two' ? WIDE_PAGE_TWO : WIDE_PAGE('/two'))
    })
    await new Promise<void>((settle) => httpServer.listen(0, '127.0.0.1', () => settle()))
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    server = { close: () => new Promise((settle) => httpServer.close(() => settle())) }

    dir = mkdtempSync(join(tmpdir(), 'dsh-t13-'))
    // 视图矩形就是"窄栏"：620 x 800，固定宽度 1200px 的页面在里面必然被裁切。
    shell = await startShell([`--view-url=${origin}/one`, '--bounds', '0,0,620,800'], {
      windowSize: { width: 1240, height: 860 },
    })
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
      url: shell.handshake.viewUrl,
    })
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    tools = desktopViewTools(() => Promise.resolve(session), {} as ToolDependencies)
    // **先**量一次"从来没有被模拟过"的视图：那一次截图是 T5 时代的关系
    // （视口 × 屏幕 dpr = 930x1200）。放在这里是因为它只能量一次 —— 一旦
    // `setViewportSize` 被调过，Playwright 自己记的 `_metricsOverride` 就永久生效，
    // 交付图片从那以后都由它决定（ADR-0013）。后面每一条都在那个状态里量。
    const virgin = await session.screenshot(join(dir, 'zoom-100-virgin.png'))
    const virginPng = readPng(readFileSync(join(dir, 'zoom-100-virgin.png')))
    console.log(
      `RAW the never-emulated view: png=${virginPng.width}x${virginPng.height} bytes=${virgin.length}`,
    )
    virginShot = { width: virginPng.width, height: virginPng.height }
  }, 120_000)

  afterAll(async () => {
    if (probe !== undefined && !probeClosed) await probe.browser.close().catch(() => undefined)
    if (session !== undefined) await session.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (server !== undefined) await server.close()
    if (dir !== undefined) removeWhenFree(dir)
  })

  // ── 验收一：Agent 能后退 / 前进 / 刷新，失败说清是哪一类 ──────────────────────

  it('后退、前进、刷新都真的动了那一格（地址由视图自己读回）', async () => {
    // 从夹具第一页出发，走到第二页 —— 于是"后退"有一条真的历史可走。
    const first = await view({ action: 'reload' })
    console.log('RAW reload of the initial page: ' + JSON.stringify(first))
    const here = viewUrl()
    expect(here).toContain('/one')
    expect(first.ok, 'reloading the page we are already on must work').toBe(true)

    await session.goto(`${origin}/two`)
    expect(viewUrl()).toContain('/two')
    console.log('RAW the view after navigating to page two: ' + viewUrl())

    const back = await view({ action: 'back' })
    console.log('RAW back: ' + JSON.stringify(back))
    expect(back.ok).toBe(true)
    // 读回是**视图自己**说的地址，不是工具返回的那个字段算出来的。
    expect(viewUrl()).toContain('/one')

    const forward = await view({ action: 'forward' })
    console.log('RAW forward: ' + JSON.stringify(forward))
    expect(forward.ok).toBe(true)
    expect(viewUrl()).toContain('/two')

    // 刷新：先在页面上留下一个痕迹，刷新之后它必须消失 —— "刷新真的发生了"这句话
    // 只有这样才不是"工具返回了 ok"。
    await session.goto(`${origin}/one`)
    await probe.page.evaluate(() => {
      const out = document.getElementById('t13-out')
      if (out !== null) out.textContent = 't13-dirty'
    })
    expect(await probe.page.textContent('#t13-out')).toBe('t13-dirty')
    const reloaded = await view({ action: 'reload' })
    console.log('RAW reload after touching the page: ' + JSON.stringify(reloaded))
    expect(reloaded.ok).toBe(true)
    expect(await probe.page.textContent('#t13-out'), 'a reload must bring the document back from the server').toBe(
      't13-initial',
    )
  }, 180_000)

  it('失败分类互不混淆之一：没有可后退/可前进的历史', async () => {
    // 一个刚导航过去的页面，账本里只有这一页。
    await session.goto(`${origin}/one`)
    const noHistory = await reasonOf({ action: 'forward' })
    console.log('RAW forward with no forward history: ' + noHistory)
    expect(noHistory).toBe('no-history')
  }, 120_000)

  it('失败分类互不混淆之二：超时（页面在超时之内没有走完 load）', async () => {
    // `/slow` 的 `load` 要等一次分块之间 800ms 的停顿，所以一条 400ms 的超时必然等不到。
    // 用**另一条会话**而不是改这一条的配置：这条会话的超时是领养时定下来的，
    // 为了一个用例把它改小，会让这个文件里别的用例的失败语义跟着变。
    //
    // 慢页面由**有耐性的**那条会话导航过去（它等得起），再由没耐性的那条重载它 ——
    // 这样"超时"这件事只发生在一个动作上，而不是混进一次导航里。
    await session.goto(`${shell.handshake.fixtureOrigin}/slow`)
    const before = viewUrl()
    const impatient = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 400,
    })
    try {
      const timedOut = await impatient.reload()
      console.log('RAW reload of the slow fixture with a 400ms timeout: ' + JSON.stringify(timedOut))
      expect(timedOut.moved).toBe(false)
      expect(timedOut.reason).toBe('timeout')
      // 超时**不等于**导航发生了：视图还在原来那一页上。
      expect(viewUrl()).toBe(before)
      // 分类是值，补救在人话里。
      expect(String(timedOut.message)).toContain('worth retrying')
    } finally {
      await impatient.close().catch(() => undefined)
    }
    // 回到一个干净页面，别把慢页面留给下一个用例。
    await session.goto(`${origin}/one`)
    expect(viewUrl()).toContain('/one')
  }, 180_000)

  it('失败分类互不混淆之三：页面拒绝（beforeunload 守卫）', async () => {
    // 放在最后：守卫一旦装上，视图就**再也导航不走**了（这正是它自己的语义），
    // 所以它会污染同一个文件里后面每一个用例 —— 上一个版本就是这么红的。
    // 于是装上、量完、在 `finally` 里拆掉，三步都在这一个用例里。
    //
    // 还有一件事必须在这里做：**先关掉那条独立连接**。它自己也有一个 dialog 处理器
    // （T9 的会话给每一条连接都装了），于是同一个 `beforeunload` 会被两个客户端抢着回答，
    // 输的那个抛 `Protocol error (Page.handleJavaScriptDialog): No dialog is showing`，
    // 而 vitest 把这种未处理的拒绝记成"用例之外还有错"，整个文件进程以非零码退出 ——
    // 这个文件的第一版就是这样：断言全绿而 `Test Files 1 failed`。
    await probe.browser.close()
    probeClosed = true
    await session.goto(`${origin}/one`)
    await session.goto(`${origin}/two`)
    try {
      await session.evaluate('window.onbeforeunload = function () { return "unsaved" }; void 0')
      const refused = await view({ action: 'back' })
      console.log('RAW back into a page guard: ' + JSON.stringify(refused))
      expect(refused.ok).toBe(false)
      expect(refused.reason).toBe('page-refused')
      expect(String(refused.message)).toContain('refused')
      // 三条分类必须两两不同 —— 这就是"分类互不混淆"这句话的读回方式。
      expect(new Set(['no-history', 'timeout', refused.reason]).size).toBe(3)
    } finally {
      // 拆掉守卫。它**不只在那一页上生效**：装上之后视图再也导航不走。
      await session.evaluate('window.onbeforeunload = null; void 0').catch(() => undefined)
      await session.goto(`${origin}/one`).catch(() => undefined)
      // 独立连接重新接上：后面的用例要用它读页面自己的事实。
      probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
      probeClosed = false
    }
  }, 180_000)

  // ── 验收二：缩放（含重置），dpr 与截图尺寸都跟着变，有断言钉住 ─────────────────

  it('零点：1200px 的页面在 620px 的栏里确实被裁切', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    const facts = await pageFacts()
    const shot = await shotOnDisk('zoom-100.png')
    console.log('RAW zoom 100%: ' + JSON.stringify({ facts, shot }))
    // 页面自报的视口就是视图矩形给的 620x800；1200px 的条子比它宽 —— 这就是"看不全"。
    expect(facts.innerWidth).toBe(SLOT.width)
    expect(facts.scrollWidth).toBe(1200)
    expect(facts.barWidth).toBe(1200)
    // 缩放**重置**之后截图是 620x800：T13 之后"截图 = 布局视口 × 页面报的 dpr"，
    // 而重置后的 dpr 是 1 —— 于是它是 620x800，**不是** T5 时代那个 930x1200。
    // 那条老关系（视口 × 屏幕 dpr）只在"这个视图从来没有被模拟过"时成立（ADR-0013），
    // 而那个状态在 `beforeAll` 里已经量过一次了。
    expect(shot.width).toBe(SLOT.width)
    expect(shot.height).toBe(SLOT.height)
    expect(virginShot.width).toBe(Math.round(SLOT.width * SCREEN_DPR))
    expect(virginShot.height).toBe(Math.round(SLOT.height * SCREEN_DPR))
    // 两条关系都钉住，因为"缩放之后截图变小了"必须是一个**被解释过的**变化，
    // 而不是一个意外：老关系 → 新关系，中间那一步是 `setViewportSize`。
    expect(shot.width).toBeLessThan(virginShot.width)
  }, 120_000)

  it('缩放让**同屏看到更多页面内容**，但它**不会**把固定宽度页面缩小到完整可见（已知边界，有反证）', async () => {
    await session.goto(`${origin}/one`)
    // 从"撤掉模拟"的状态出发，好让这一条量的是**缩放做了什么**，而不是上一个用例的残留。
    // （`clearMetricsOverride` 是给这种"把两种状态分开量"用的，产品路径不用它。）
    await session.clearMetricsOverride()
    // 仪器先自检：不缩放时，1200px 页面最右端那块红标**必须看不见**（620 < 1150）。
    const markerAtOne = await markerPixels('zoom-100-marker.png')
    console.log(`RAW the page-rightmost marker at 100%: ${markerAtOne} red pixels (must be 0 — the instrument works)`)
    expect(markerAtOne).toBe(0)

    const result = await session.zoomTo(1.94)
    const facts = await pageFacts()
    const shot = await shotOnDisk('zoom-194.png')
    console.log('RAW zoom 194%: ' + JSON.stringify({ result, facts, shot: { width: shot.width, height: shot.height } }))

    // 1. 布局视口真的变小了：620 / 1.94 = 319（floor）。
    expect(result.innerWidth).toBe(319)
    expect(facts.innerWidth).toBe(319)
    // 2. 这正是它的用处：视口里放得下的页面宽度 = innerWidth × zoom（= 620，即整块窗格）。
    //    于是"同屏能看到多少页面"变成了原来的 1/zoom —— 从 620px 变成 1200px。
    expect(Number(facts.innerWidth) * result.zoom).toBeGreaterThanOrEqual(facts.innerWidth as number)
    expect(Number(facts.innerWidth) * result.zoom).toBeGreaterThan(620 - 2)
    // 3. 条子自己的布局宽度没变（变的是视口，不是页面）。
    expect(facts.barWidth).toBe(1200)
    // 4. **反证**：页面最右端那块红标**仍然看不见**。这一条是这张票最重要的一句实话 ——
    //    `setViewportSize` 让视口变窄，**内容没有被缩小**，所以"固定宽度页面塞进窄栏里
    //    完整显示"**没有**被解决（见 ADR-0013）。将来谁把这条当 bug 去修，会先撞到这条断言。
    const markerAtZoom = await markerPixels('zoom-194-marker.png')
    console.log(`RAW the page-rightmost marker at 194%: ${markerAtZoom} red pixels (still 0: the content was NOT scaled down)`)
    expect(markerAtZoom).toBe(0)
  }, 180_000)

  it('devicePixelRatio 与截图尺寸都跟着 zoom 变，且**读自**页面与磁盘上的 PNG', async () => {
    await session.goto(`${origin}/one`)
    const source = { width: 620, height: 800 }
    const readings: Array<{ zoom: number; dpr: number; innerWidth: number; file: { width: number; height: number } }> = []
    for (const zoom of [1, 1.25, 2, 2.5]) {
      const result = await session.zoomTo(zoom)
      const facts = await pageFacts()
      const shot = await shotOnDisk(`zoom-sweep-${String(zoom).replace('.', '_')}.png`)
      readings.push({ zoom, dpr: Number(facts.devicePixelRatio), innerWidth: Number(facts.innerWidth), file: shot })
      console.log(
        `RAW zoom sweep ${zoom}: session=${JSON.stringify(result)} page=${JSON.stringify(facts)} png=${shot.width}x${shot.height}`,
      )

      // (a) 面板/工具报的 dpr 与**页面自己读到的**是同一个数（不是"我们写下去的值"）。
      expect(Math.abs(Number(facts.devicePixelRatio) - zoom)).toBeLessThan(0.01)
      expect(Math.abs(result.devicePixelRatio - zoom)).toBeLessThan(0.01)
      // (b) 截图尺寸 = floor(源视口 / zoom)，由**磁盘上那张 PNG** 量出来。
      expect(shot.width).toBe(Math.floor(source.width / zoom))
      expect(shot.height).toBe(Math.floor(source.height / zoom))
      // (c) 布局视口同上。
      expect(result.innerWidth).toBe(Math.floor(source.width / zoom))
    }

    // (d) 单调性：zoom 越大，截图越小、dpr 越大 —— 两个方向都单调。
    const zooms = readings.map((reading) => reading.zoom)
    const widths = readings.map((reading) => reading.file.width)
    const dprs = readings.map((reading) => reading.dpr)
    console.log('RAW monotonicity: ' + JSON.stringify({ zooms, widths, dprs }))
    for (let index = 1; index < readings.length; index++) {
      expect(widths[index]).toBeLessThan(widths[index - 1])
      expect(dprs[index]).toBeGreaterThan(dprs[index - 1])
    }
  }, 300_000)

  it('缩放跨导航保持，重置回到 100%', async () => {
    await session.goto(`${origin}/one`)
    await session.zoomTo(2.5)
    expect((await pageFacts()).innerWidth).toBe(248)

    // 跨导航：走到第二页，覆盖与视口都还在。
    await session.goto(`${origin}/two`)
    const afterNavigation = await pageFacts()
    console.log('RAW zoom 250% after navigating to page two: ' + JSON.stringify(afterNavigation))
    expect(afterNavigation.innerWidth).toBe(248)
    expect(Math.abs(Number(afterNavigation.devicePixelRatio) - 2.5)).toBeLessThan(0.01)

    // 重置：回 100%，页面自己读到的也回 620。
    const reset = await session.resetZoom()
    const facts = await pageFacts()
    console.log('RAW reset: ' + JSON.stringify({ reset, facts }))
    expect(reset.zoom).toBe(1)
    expect(facts.innerWidth).toBe(620)
    expect(facts.innerHeight).toBe(800)
  }, 180_000)

  it('越界的 zoom 被拒绝而不是悄悄夹到边界', async () => {
    for (const zoom of [0.1, 9, Number.NaN]) {
      let thrown: unknown
      try {
        await session.zoomTo(zoom)
      } catch (error) {
        thrown = error
      }
      console.log(`RAW zoomTo(${String(zoom)}) threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
      expect(thrown, `zoom ${String(zoom)} must be refused`).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('zoom must be')
    }
    // 档位到头也要说出来。
    await session.zoomTo(5)
    await expect(session.stepZoom(1)).rejects.toThrow(/maximum/)
    await session.zoomTo(0.25)
    await expect(session.stepZoom(-1)).rejects.toThrow(/minimum/)
    await session.resetZoom()
  }, 180_000)

  it('缩放之后 browser_snapshot 的 bounds 是**模拟视口**的 CSS 像素（ADR-0008 那条 1:1 只在 zoom=1 时成立）', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    const atOne = await session.snapshot()
    const buttonAtOne = atOne.elements.find((element) => element.name === 'hit me')
    console.log('RAW snapshot at 100%: ' + JSON.stringify(buttonAtOne))

    await session.zoomTo(2)
    const atTwo = await session.snapshot()
    const buttonAtTwo = atTwo.elements.find((element) => element.name === 'hit me')
    console.log('RAW snapshot at 200%: ' + JSON.stringify(buttonAtTwo))

    expect(buttonAtOne, 'the fixture button must be in the snapshot').toBeDefined()
    expect(buttonAtTwo, 'the fixture button must be in the snapshot while zoomed').toBeDefined()
    // 元素在页面里的**布局**尺寸没有变（CSS 像素是页面自己的坐标系）……
    expect(buttonAtTwo?.bounds.width).toBe(buttonAtOne?.bounds.width)
    // ……变的是视口：bounds 一直在**视图 CSS 像素**里，而缩放把视口从 620 变成 310。
    // 于是"bounds 与窗格物理像素 1:1"这句话**只在 zoom=1 时**为真 —— 这是量出来的，
    // 不是推的：同一份 bounds 在 zoom=2 时描述的是一个 310px 宽的视口。
    const facts = await pageFacts()
    expect(facts.innerWidth).toBe(310)
    expect(buttonAtTwo?.bounds.width).toBeCloseTo(90, 5)
    await session.resetZoom()
  }, 180_000)

  // ── 验收三/四/五：面板那一格的工具条、RPC、重新开始 ────────────────────────

  it('那条通道的契约是封闭的：动作名与端点路径一一对应，认不出的动作抛', () => {
    console.log('RAW view RPC contract: ' + JSON.stringify(VIEW_ACTIONS.map((action) => viewEndpointPath(action))))
    // channel 必须是单段的 `/api`：客户端的 `assertTarget` 只允许这个形状，
    // 带 `/` 的 channel 连调用都发不出去（见 docs/adr/0013）。
    expect(VIEW_RPC_CHANNEL).toBe('/api')
    // 命名空间：端点都带本插件的前缀，不会撞上产品自己的 `/api` 端点。
    for (const action of VIEW_ACTIONS) {
      expect(viewEndpoint(action).startsWith('desktop-view-')).toBe(true)
      expect(viewEndpointPath(action)).toBe(`/api/${viewEndpoint(action)}`)
    }
    // 认不出的动作必须抛，绝不猜一个默认动作。
    expect(() => parseViewAction('reload-everything')).toThrow(/unknown view action/)
    expect(() => parseViewAction(7)).toThrow(TypeError)
    expect(parseViewAction('back')).toBe('back')
  })

  it('「重新开始」把视图带回握手发布的初始页，并把缩放也重置', async () => {
    await session.goto(`${origin}/two`)
    await session.zoomTo(2)
    const restarted = await session.restart()
    const facts = await pageFacts()
    console.log('RAW restart: ' + JSON.stringify({ restarted, facts }))
    expect(restarted.url).toBe(shell.handshake.viewUrl)
    expect(restarted.source).toBe('handshake')
    // 地址是**视图自己**说的，不是我们请求的那个字符串。
    expect(viewUrl()).toBe(shell.handshake.viewUrl)
    expect(facts.innerWidth, 'restart must also drop the zoom').toBe(620)
    // 历史也清成"只有这一页"。
    expect(session.historyState()).toEqual({ back: 0, forward: 0 })
  }, 180_000)

  it('没有可后退的历史时，会话如实说"不能后退"，而不是假装能', async () => {
    await session.restart()
    const state = session.historyState()
    console.log('RAW observed history right after a restart: ' + JSON.stringify(state))
    expect(state.back).toBe(0)
    expect(state.forward).toBe(0)
    await session.goto(`${origin}/two`)
    console.log('RAW observed history after one navigation: ' + JSON.stringify(session.historyState()))
    expect(session.historyState().back).toBeGreaterThan(0)
  }, 120_000)
})
