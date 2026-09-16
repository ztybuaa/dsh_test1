import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { AdoptedViewSession } from '../src/session.ts'
import { SpaceManager } from '../src/spaces.ts'
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
        // 按钮自己写下的效果：用来证明"按 ref 点击真的落在那个元素上"（读效果，不读坐标）。
        out: document.getElementById('t13-out').textContent,
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
 * 定下来再断言，而不是把 1.5 抄进断言里：这个文件的断言要说的是"布局视口 × 屏幕 dpr"
 * 这条关系，而不是"这台机器的显示器是多少"。
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
  /** 缩放那条通道：插件请外壳改缩放，走的就是它（T13）。 */
  let spaces: SpaceManager
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
   * 页面**最右端**那块红标在**截图**里出现了几个像素。
   *
   * 注意它回答的是"**布局视口**里看得见它吗"，**不是**"窗格里看得见吗"：截图由 CDP 交付，
   * 尺寸等于布局视口 × 屏幕 dpr，**不等于窗格的物理像素**。真窗口像素那条证据在
   * `tests/zoom-pixels.spec.ts` 里（`desktopCapturer` 抓真窗口），这一支只用来量布局。
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
      windowSize: { width: 1240, height: 900 },
    })
    // **缩放经真外壳走**（票 #13 的决定，ADR-0013 决定二）：`setZoomFactor()` 是 Electron 的
    // API，插件够不到，所以会话拿到的那个缩放口子绑在空间通道上。会话由 `SpaceManager` 领养，
    // 于是这一份里"缩放生效了吗"的答案来自**外壳读回的 `getZoomFactor()`**，不是我们写下去的值。
    spaces = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
      initialUrl: shell.handshake.viewUrl,
    })
    session = await spaces.adopt(shell.handshake.cdpUrl)
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    tools = desktopViewTools(() => Promise.resolve(session), {} as ToolDependencies)
  }, 120_000)

  afterAll(async () => {
    if (probe !== undefined && !probeClosed) await probe.browser.close().catch(() => undefined)
    if (spaces !== undefined) await spaces.close()
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

  it('零点：1200px 的页面在 620px 的栏里确实被裁切，而截图正是 T5 那条关系', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    const facts = await pageFacts()
    const shot = await shotOnDisk('zoom-100.png')
    console.log('RAW zoom 100%: ' + JSON.stringify({ facts, shot }))
    // 页面自报的视口就是视图矩形给的 620x800；1200px 的条子比它宽 —— 这就是"看不全"。
    expect(facts.innerWidth).toBe(SLOT.width)
    expect(facts.scrollWidth).toBe(1200)
    expect(facts.barWidth).toBe(1200)
    // 100% 时截图就是窗格的物理像素：**布局视口 × 屏幕 dpr** = 620×800 × 1.5（T5 那条关系）。
    // 缩放≠1 时同一条关系照样成立，只是布局视口变了 —— 见下一条。
    expect(shot.width).toBe(Math.round(SLOT.width * SCREEN_DPR))
    expect(shot.height).toBe(Math.round(SLOT.height * SCREEN_DPR))
  }, 120_000)

  it('缩小到 50% 才真的把 1200px 的页面带进那一格：布局视口 1240、内容按 1/zoom 画出来', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    // 仪器先自检：100% 时页面最右端的红标**不该**出现在布局视口里（620 < 1150）。
    const markerAtOne = await markerPixels('zoom-100-marker.png')
    console.log(`RAW the page-rightmost marker at 100%: ${markerAtOne} red pixels (must be 0 — the instrument works)`)
    expect(markerAtOne).toBe(0)

    const result = await session.zoomTo(0.5)
    const facts = await pageFacts()
    const shot = await shotOnDisk('zoom-50.png')
    console.log(
      'RAW zoom 50%: ' +
        JSON.stringify({ result, facts, shot: { width: shot.width, height: shot.height } }),
    )

    // 1. 布局视口**变宽**了：620 / 0.5 = 1240（页面自己读得到）。
    expect(result.innerWidth).toBe(1240)
    expect(facts.innerWidth).toBe(1240);
    // 2. 于是那条 1200px 的条子**装得下**：没有横向溢出，整页在同屏里。
    expect(facts.barWidth).toBe(1200)
    expect(Number(facts.scrollWidth)).toBeLessThanOrEqual(Number(facts.innerWidth))
    // 3. 页面读到的 dpr = 屏幕 dpr × zoom —— 内容真的被按一半画出来了。
    expect(Math.abs(Number(facts.devicePixelRatio) - SCREEN_DPR * 0.5)).toBeLessThan(0.01)
    // 4. 同一支红标量具在**布局**里看得见它了（真窗口像素那条在 tests/zoom-pixels.spec.ts）。
    const markerAtHalf = await markerPixels('zoom-50-marker.png')
    console.log(`RAW the page-rightmost marker at 50%: ${markerAtHalf} red pixels (in the layout viewport)`)
    expect(markerAtHalf).toBeGreaterThan(0)
    // 5. 缩放算出来的源视口回到那块窗格：1240 × 0.5 = 620。
    expect(result.source.width).toBe(620)
    expect(shot.width).toBe(Math.round(1240 * SCREEN_DPR))
  }, 180_000)

  it('dpr 与截图尺寸都跟着 zoom 变，而且读自页面与磁盘上的 PNG', async () => {
    await session.goto(`${origin}/one`)
    const source = { width: 620, height: 800 }
    const readings: Array<{ zoom: number; dpr: number; innerWidth: number; file: { width: number; height: number } }> = []
    for (const zoom of [0.5, 1, 1.25, 2, 2.5]) {
      const result = await session.zoomTo(zoom)
      const facts = await pageFacts()
      const shot = await shotOnDisk(`zoom-sweep-${String(zoom).replace('.', '_')}.png`)
      readings.push({ zoom, dpr: Number(facts.devicePixelRatio), innerWidth: Number(facts.innerWidth), file: shot })
      console.log(
        `RAW zoom sweep ${zoom}: session=${JSON.stringify(result)} page=${JSON.stringify(facts)} png=${shot.width}x${shot.height}`,
      )

      // (a) 页面读到的 dpr = 屏幕 dpr × zoom（外壳侧缩放的定义），工具报的与它同一个数。
      expect(Math.abs(Number(facts.devicePixelRatio) - SCREEN_DPR * zoom)).toBeLessThan(0.02)
      expect(Math.abs(result.devicePixelRatio - SCREEN_DPR * zoom)).toBeLessThan(0.02)
      // (b) 布局视口 = 源视口 / zoom（允许 1px 的取整）。
      expect(Math.abs(Number(facts.innerWidth) - source.width / zoom)).toBeLessThanOrEqual(1)
      // (c) 截图 = **布局视口 × 屏幕 dpr**，由磁盘上那张 PNG 量出来 —— T5 那条关系在缩放≠1 时成立，
      //     因为它说的视口是**布局视口**，而布局视口本来就随缩放变。
      expect(Math.abs(shot.width - Math.round(Number(facts.innerWidth) * SCREEN_DPR))).toBeLessThanOrEqual(1)
      expect(Math.abs(shot.height - Math.round(Number(facts.innerHeight) * SCREEN_DPR))).toBeLessThanOrEqual(1)
    }

    // (d) 单调性：zoom 越大，布局视口越小、截图越小、dpr 越大 —— 三个方向都单调。
    const zooms = readings.map((reading) => reading.zoom)
    const widths = readings.map((reading) => reading.file.width)
    const dprs = readings.map((reading) => reading.dpr)
    console.log('RAW monotonicity: ' + JSON.stringify({ zooms, widths, dprs }))
    for (let index = 1; index < readings.length; index++) {
      expect(zooms[index]).toBeGreaterThan(zooms[index - 1])
      expect(widths[index]).toBeLessThan(widths[index - 1])
      expect(dprs[index]).toBeGreaterThan(dprs[index - 1])
    }
  }, 300_000)

  it('缩放跟着**视图**走，不跟着网站走：同源换页与换到另一个站点都还在', async () => {
    await session.goto(`${origin}/one`)
    await session.zoomTo(0.5)
    expect((await pageFacts()).innerWidth).toBe(1240)

    // 同源的下一页：缩放还在。
    await session.goto(`${origin}/two`)
    const afterNavigation = await pageFacts()
    console.log('RAW zoom 50% after navigating to page two: ' + JSON.stringify(afterNavigation))
    expect(afterNavigation.innerWidth).toBe(1240)
    expect(Math.abs(Number(afterNavigation.devicePixelRatio) - SCREEN_DPR * 0.5)).toBeLessThan(0.02)

    // **另一个站点**（同一个服务器的另一个主机名）：Chromium 自己的缩放是按站点记的，
    // 换站点会回到那个站点的默认值 —— 所以这件事必须由外壳在导航之后重新按上去，
    // 否则"点了链接缩放就没了"。这一条量的正是那条重新按上去的规矩（见 ADR-0013）。
    const otherSite = origin.replace('127.0.0.1', 'localhost')
    const moved = await session.goto(`${otherSite}/one`)
    const afterSiteChange = await pageFacts()
    console.log('RAW zoom 50% after moving to another site: ' + JSON.stringify({ moved, afterSiteChange }))
    expect(afterSiteChange.url).toContain('localhost')
    expect(afterSiteChange.innerWidth, 'the zoom must follow the view, not the site').toBe(1240)
    expect(Math.abs(Number(afterSiteChange.devicePixelRatio) - SCREEN_DPR * 0.5)).toBeLessThan(0.02)

    // 重置：回 100%，页面自己读到的也回 620。
    const reset = await session.resetZoom()
    const facts = await pageFacts()
    console.log('RAW reset: ' + JSON.stringify({ reset, facts }))
    expect(reset.zoom).toBe(1)
    expect(facts.innerWidth).toBe(620)
    expect(facts.innerHeight).toBe(800)
  }, 180_000)

  it('缩放由外壳做、值由外壳读回：state.json 里那个数就是 getZoomFactor()', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    for (const zoom of [0.5, 2, 1]) {
      const result = await session.zoomTo(zoom)
      const state = spaces.readState()
      const active = state?.spaces.find((space) => space.name === state.active)
      console.log(
        `RAW published zoom after zoomTo(${zoom}): ` +
          JSON.stringify({ published: active?.zoom, session: result.zoom, protocol: state?.protocol }),
      )
      // 会话报的那个数**必须**是外壳读回来的那个数：一个"写下去就当成了"的实现会在这里露馅。
      expect(active?.zoom).toBeDefined()
      expect(Math.abs(Number(active?.zoom) - zoom)).toBeLessThan(0.001)
      expect(Math.abs(result.zoom - Number(active?.zoom))).toBeLessThan(0.001)
    }
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

  it('缩放之后 browser_snapshot 的 bounds 仍是**页面自己的 CSS 像素**，点它还是中', async () => {
    await session.goto(`${origin}/one`)
    await session.resetZoom()
    const atOne = await session.snapshot()
    const buttonAtOne = atOne.elements.find((element) => element.name === 'hit me')
    console.log('RAW snapshot at 100%: ' + JSON.stringify(buttonAtOne))

    for (const zoom of [0.5, 2]) {
      await session.zoomTo(zoom)
      const snapshot = await session.snapshot()
      const button = snapshot.elements.find((element) => element.name === 'hit me')
      const facts = await pageFacts()
      console.log(
        `RAW snapshot at ${String(zoom * 100)}%: ` +
          JSON.stringify({ button, innerWidth: facts.innerWidth, dpr: facts.devicePixelRatio }),
      )
      expect(button, 'the fixture button must be in the snapshot while zoomed').toBeDefined()
      // bounds 是页面自己的坐标系（CSS 像素）：**布局**没变，所以同一份 bounds 在每一档都一样。
      expect(button?.bounds.width).toBe(buttonAtOne?.bounds.width)
      expect(button?.bounds.x).toBe(buttonAtOne?.bounds.x)
      // 变的是"1 CSS 像素等于几个窗格像素"：那是 dpr，而 dpr = 屏幕 dpr × zoom。
      // 所以"bounds 与窗格 1:1"这句话只在 zoom = 1 **且** 屏幕 dpr = 1 时为真；
      // 它一直是"bounds 与视图的 CSS 像素 1:1"（ADR-0008 的原话），这一点没有变。
      expect(Math.abs(Number(facts.devicePixelRatio) - SCREEN_DPR * zoom)).toBeLessThan(0.02)

      // **验证而不是推断**：没有任何流水线依赖"bounds == 窗格物理像素"。
      // 最可能依赖它的那条就是"按 ref 点击"—— 它拿 bounds 去决定点哪里。所以真的点一次，
      // 并且读**页面自己写下的效果**，而不是读坐标。
      await session.clickRef(button?.ref ?? 0)
      const clicked = await pageFacts()
      console.log(`RAW click by ref at ${String(zoom * 100)}%: out=${JSON.stringify(clicked.out)}`)
      expect(clicked.out, 'a click by ref must land on the element at every zoom').toBe('t13-clicked')
      await session.goto(`${origin}/one`)
    }
    await session.resetZoom()
  }, 300_000)

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
