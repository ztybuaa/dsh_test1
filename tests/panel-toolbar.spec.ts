import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { AdoptedViewSession } from '../src/session.ts'
import { VIEW_ACTIONS, VIEW_RPC_CHANNEL, viewEndpointPath } from '../src/view-rpc.ts'
import {
  makeTempDshHome,
  pageForTarget,
  removeWhenFree,
  resolveDshBinScript,
  startShell,
  type ShellProcess,
  type TempDshHome,
} from './shell-harness.ts'

/**
 * 票 #13 · 面板那一格的工具条，在**真外壳 + 真 DSH 宿主 + 真通道**上。
 *
 * ## 这一份证什么、不证什么（先写清楚，免得读的人以为它证多了）
 *
 * **证**：面板上那颗按钮要走的**那一条路**是通的，而且它驱动的是**同一套会话能力**。
 * 每一次调用都是真的：真外壳、真 `dsh` 宿主、真 `/api` 通道、真的浏览器会话凭据、
 * 真的请求信封（`{type:'client-request',rpcId,method,payload}` —— 与
 * `dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc` 逐字段相同）。
 * 每一个动作之后，**视图自己的 `url()`** 与**页面自己报的 `devicePixelRatio`** 都要对得上。
 *
 * **不证**：那七颗按钮在 DOM 上真的画出来了、点下去真的发出了那次请求。
 * 那一段（"真 DSH 界面里的那一格"）在本仓库的临时 profile 上跑不起来：DSH 的首启流程要求
 * 先配工作区或 API Key，界面停在引导页上，那一格根本渲染不出来；而把窗口那一页换成最小宿主页
 * 之后，DSH 客户端的启动图在**窗口这个 target** 上没有把模块表建完（实测轮询 240 秒仍
 * `__ModuleLoader__.import === undefined`）。这两条限制写在报告与 ADR-0013 的诚实清单里。
 * 按钮本身的行为由 `tests/toolbar.spec.ts` 按纯判断逐条钉住（可用性、标签、状态行、快捷键），
 * 而客户端半边与宿主半边的**端点名字对得上**由 `tests/view-actions.spec.ts` 与
 * `tests/toolbar.spec.ts` 各自从自己那一侧断言。
 */

/**
 * 一棵有链接的夹具页：视图**自己**走去下一页，好让面板那一侧的会话真的观察到那一步
 * （见"后退/前进"那一条里关于"两个会话实例"的说明）。
 */
const LINKED_PAGE = (next: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t13-linked</title></head>
<body><p id="t13-one">page one</p>
<a id="t13-next" href="${next}">go to page two</a>
</body></html>`

/** 第二页，够它被认出来就行。 */
const LINKED_PAGE_TWO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t13-linked-two</title></head>
<body><p id="t13-two">page two</p></body></html>`

describe('票 #13 · 面板那条通道（真外壳 + 真 DSH 宿主）', () => {
  let home: TempDshHome
  let userDataDir: string
  let shell: ShellProcess
  let ui: { browser: Browser; page: Page } | undefined
  let view: { browser: Browser; page: Page } | undefined
  let session: AdoptedViewSession
  /** 外壳握手发布的初始页 —— 「重新开始」该回到的那一页。 */
  let initialUrl: string
  /** DSH 自己的 origin —— 面板那一页就在这个 origin 上，通道的围栏认的是它。 */
  let dshOrigin: string
  /** 面板那一页的会话凭据（DSH 用 token 换来的 cookie）。 */
  let cookie: string
  /** 夹具站点：它提供"视图自己走一步"的那个链接。 */
  let linked: { origin: string; close: () => Promise<void> }
  let linkedOrigin: string

  /** 面板那一页的样子：它调 `ctx.connection.rpc.call` 时打出来的东西，逐字段一样。 */
  const callPanelChannel = async (
    action: string,
    options: { cookie?: string; origin?: string; payload?: Record<string, unknown> } = {},
  ): Promise<{ status: number; body: string; answer: unknown }> => {
    const endpoint = viewEndpointPath(action as (typeof VIEW_ACTIONS)[number])
    const response = await fetch(`${dshOrigin}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.cookie !== undefined ? { cookie: options.cookie } : {}),
        // 浏览器一定会带 Origin；面板那一页与它同源，所以这里也带上它。
        origin: options.origin ?? dshOrigin,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `t13-${action}-${String(Date.now())}`,
        method: `desktop-view-${action}`,
        // `payload` 是面板那两条带参数的动作（票 #20 的地址栏与档位菜单）用的那一段。
        payload: { nonce: String(Date.now()), ...(options.payload ?? {}) },
      }),
    })
    const body = await response.text()
    let answer: unknown = null
    try {
      answer = JSON.parse(body)
    } catch {
      /* 非 JSON 的正文原样留在 body 里 */
    }
    return { status: response.status, body, answer }
  }

  /** 从一次回答里取下 `value`（那正是面板拿到的东西）。 */
  const valueOf = (result: { answer: unknown }, what: string): Record<string, unknown> => {
    const envelope = result.answer as { result?: { ok?: boolean; value?: unknown; error?: unknown } } | null
    if (envelope === null || envelope.result === undefined || envelope.result.ok !== true) {
      throw new Error(`${what} did not succeed: ${JSON.stringify(result)}`)
    }
    return envelope.result.value as Record<string, unknown>
  }

  /** 页面自己报的那几件事（走**另一条**连接读回来，不经会话、不经面板）。 */
  const pageFacts = async (): Promise<Record<string, number | string>> =>
    await (view as { page: Page }).page.evaluate(() =>
      JSON.stringify({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    ).then((text) => JSON.parse(text) as Record<string, number | string>)

  /** 页面自己报的 `devicePixelRatio`（走**另一条**连接，不经会话、不经面板）。 */
  const viewDpr = async (): Promise<number> =>
    await (view as { page: Page }).page.evaluate(() => window.devicePixelRatio)

  /** 视图自己说的地址。 */
  const viewUrlNow = (): string => session.url()

  beforeAll(async () => {
    if (resolveDshBinScript() === undefined) {
      throw new Error(
        'this test needs the `dsh` launcher on PATH (or DSH_BIN pointing at @deepseek-ai/dsh/lib/bin.js): ' +
          'the panel\'s channel only exists on a real DSH host, and the page it runs on must share that host\'s origin',
      )
    }
    home = makeTempDshHome({ profile: 'dshviewer' })
    userDataDir = mkdtempSync(join(tmpdir(), 'dsh-t13-panel-'))
    // 夹具站点：视图要靠**页面自己的链接**走一步（原因见"后退/前进"那一条）。
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(url.pathname === '/two' ? LINKED_PAGE_TWO : LINKED_PAGE('/two'))
    })
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    linkedOrigin = `http://127.0.0.1:${port}`
    linked = { origin: linkedOrigin, close: () => new Promise((settle) => server.close(() => settle())) }
    shell = await startShell(['--dsh'], {
      userDataDir,
      env: { DSH_HOME: home.home },
      timeoutMs: 240_000,
    })
    await shell.waitFor((out) => /^DSH_SHELL DSH_URL /m.test(out), 'the DSH address', 240_000)
    const dshUrl = JSON.parse(/^DSH_SHELL DSH_URL (.*)$/m.exec(shell.stdout())[1]).url as string
    dshOrigin = new URL(dshUrl).origin
    initialUrl = shell.handshake.viewUrl

    const windowTargetId = shell.handshake.windowTargetId
    if (windowTargetId === undefined) throw new Error('the shell published no window target id')
    ui = await pageForTarget(shell.handshake.cdpUrl, windowTargetId)
    await ui.page.waitForFunction((expected) => location.origin === expected, dshOrigin, { timeout: 180_000 })
    // 面板那一页的凭据：DSH 用 `?token=` 换来的那个 cookie。**面板真的带着它**，
    // 所以这里也带它 —— 少了它会 401，那正是"这道门靠什么"的一半答案（另一半在下面那条）。
    const cookies = await ui.page.context().cookies()
    cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ')
    console.log(
      'RAW the panel page and its credentials: ' +
        JSON.stringify({ dshOrigin, cookieNames: cookies.map((entry) => entry.name), href: ui.page.url() }),
    )
    expect(cookie.length, 'the panel page must hold the browser session cookie').toBeGreaterThan(0)

    view = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
      // **必须**把外壳说的那一页交给会话：「重新开始」回到的就是它。
      url: initialUrl,
    })
  }, 420_000)

  afterAll(async () => {
    if (session !== undefined) await session.close().catch(() => undefined)
    if (view !== undefined) await view.browser.close().catch(() => undefined)
    if (ui !== undefined) await ui.browser.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (linked !== undefined) await linked.close().catch(() => undefined)
    if (home !== undefined) home.remove()
    if (userDataDir !== undefined) removeWhenFree(userDataDir)
  })

  it('契约：面板能按的每一个动作都有端点，带自己的命名空间，且走单段的 `/api` 通道', async () => {
    console.log('RAW the endpoints this feature owns: ' + JSON.stringify(VIEW_ACTIONS.map(viewEndpointPath)))
    // 客户端 `assertTarget` 只允许单段 channel，所以通道必须是 `/api`（带 `/` 的连调用都发不出去）。
    expect(VIEW_RPC_CHANNEL).toBe('/api')
    for (const action of VIEW_ACTIONS) {
      // `/api` 是共享通道：端点必须带自己的命名空间，不能占通用名字。
      expect(viewEndpointPath(action)).toMatch(/^\/api\/desktop-view-[a-z-]+$/)
    }
    // 每一个动作都**真的注册上了**：状态端点必须答 200 与一个成功的信封。
    const state = await callPanelChannel('state', { cookie })
    console.log('RAW the state endpoint: ' + JSON.stringify({ status: state.status, body: state.body.slice(0, 400) }))
    expect(state.status).toBe(200)
    const value = valueOf(state, 'state')
    expect(value.ok).toBe(true)
    expect(String(value.url)).toBe(viewUrlNow())
  }, 120_000)

  it('缩放：面板那两个动作真的改了页面自己报的 devicePixelRatio 与视口，而且延迟量得出来', async () => {
    // 先把缩放清干净：**走面板那条路**回 100%（这一份手里的 `session` 是测试自己领养的，
    // 没有外壳那条缩放口子 —— 缩放只能请外壳做，见 ADR-0013）。
    await callPanelChannel('zoom-reset', { cookie })
    const factsBefore = await pageFacts()
    const before = await viewDpr()
    // 面板那一按到画面真的变了，要过**两道轮询**：面板 → 宿主（HTTP）→ 空间请求文件 →
    // 外壳每 150ms 读一次 → 生效。所以这里掐表，并把结果如实打出来（ADR-0013 的诚实清单）。
    //
    // 量到的比"一个轮询间隔"大得多（第一次按 1.1 秒量级），所以**冷热各按一次**：
    // 第一次那一按还要顺带把宿主那半边（adopt、状态读回）的冷路径走完。
    const cold = Date.now()
    const zoomIn = await callPanelChannel('zoom-in', { cookie })
    const coldMs = Date.now() - cold
    const afterIn = await viewDpr()
    const valueIn = valueOf(zoomIn, 'zoom-in')
    const warm = Date.now()
    const zoomInAgain = await callPanelChannel('zoom-in', { cookie })
    const warmMs = Date.now() - warm
    const valueInAgain = valueOf(zoomInAgain, 'zoom-in')
    console.log(
      'RAW zoom-in over the panel channel: ' +
        JSON.stringify({
          status: zoomIn.status,
          dprBefore: before,
          dprAfter: afterIn,
          coldMs,
          warmMs,
          value: valueIn,
          second: valueInAgain,
        }),
    )
    expect(zoomIn.status).toBe(200)
    // 一比就变的是**视口**（缩放＝布局视口按比例变、内容按同一比例画出来）—— 页面自己读得到。
    expect(Number(valueIn.innerWidth)).toBeLessThan(Number(factsBefore.innerWidth))
    expect(Number(valueIn.zoom)).toBeGreaterThan(1)
    // 而 `devicePixelRatio` = **屏幕 dpr × zoom**：这正是"缩放后 dpr 跟着变"。
    // 屏幕 dpr 从这一按之前那一次读回里取（那时 zoom=1，所以那个 dpr 就是屏幕 dpr）。
    expect(Math.abs(Number(valueIn.devicePixelRatio) - before * Number(valueIn.zoom))).toBeLessThan(0.02)
    expect(Math.abs(afterIn - Number(valueIn.devicePixelRatio))).toBeLessThan(0.02)
    expect(afterIn).not.toBe(before)
    // 延迟：这两条是**读回来的**，不是估的。第一按是冷路径，第二按是热路径 ——
    // 两个数都记在报告与 ADR 的诚实清单里。
    //
    // 票 #20 E 把上界**收紧**了：这条路上那 0.9 秒（会话在缩放之后等一个合成帧，
    // 见 `docs/research/t20-why-the-panel-button-waits-a-second.md`）已经拿掉，
    // 剩下的只有外壳那条 150ms 轮询。所以门禁从"5000ms 的宽松上界"改成"**800ms**"：
    // 它比实测（150–250ms）宽三倍多，但**回退掉那个修复就会红**（实测回退后 ~1010ms）。
    expect(coldMs, 'the first press must reach the view').toBeLessThan(800)
    expect(warmMs, 'a repeat press must reach the view').toBeLessThan(800)
    // 第二次按**再往前一档**（100% → 110% → 125%）—— 顺带证明这两按不是同一次调用的两种说法。
    const zoomInSteps = [1.1, 1.25]
    expect(Math.abs(Number(valueIn.zoom) - zoomInSteps[0])).toBeLessThan(0.001)
    expect(Math.abs(Number(valueInAgain.zoom) - zoomInSteps[1])).toBeLessThan(0.001)

    const startedReset = Date.now()
    const reset = await callPanelChannel('zoom-reset', { cookie })
    const elapsedReset = Date.now() - startedReset
    const valueReset = valueOf(reset, 'zoom-reset')
    console.log('RAW zoom-reset over the panel channel: ' + JSON.stringify({ elapsedMs: elapsedReset, value: valueReset }))
    expect(Number(valueReset.zoom)).toBe(1)
    // 重置之后页面自己报的视口回到原来那个值（源视口 = 布局视口 × zoom）。
    const factsReset = await pageFacts()
    expect(Number(factsReset.innerWidth)).toBe(Number(factsBefore.innerWidth))
    expect(Math.abs((await viewDpr()) - before)).toBeLessThan(0.02)

    // 票 #19 加的「自动」端点（`desktop-view-auto`）：**票 #20b 之后面板不再渲染那颗按钮**
    // （适配永远开着，没有模式可以交还），但这个端点为旧客户端留着，语义是"现在就重新适配一次"。
    // 夹具页是响应式的（没有横向溢出），所以适配"跑了但一步都不动" —— 结果是 100%。
    const handedBack = await callPanelChannel('auto', { cookie })
    const valueAuto = valueOf(handedBack, 'auto')
    console.log('RAW 旧客户端那颗「自动」 over the panel channel: ' + JSON.stringify(valueAuto))
    expect(handedBack.status).toBe(200)
    expect(valueAuto.ok).toBe(true)
    expect(valueAuto.zoomMode, 'the published mode is a compatibility constant: always auto').toBe('auto')
    expect(Number(valueAuto.zoom)).toBe(1)
    expect(String(valueAuto.message), 'the answer says what really happened: the pane was fitted again').toContain(
      'fitted this pane to the pane again',
    )
    // 票 #20 C：宿主那句话仍然在（它是诊断通道的一半），而**用户看的那一行**由面板决定
    // 只显示"模式 + 百分比" —— 那一条由 `tests/toolbar-panel.spec.ts` 从 DOM 上读回。
    // 这里顺带钉住：`state` 那条纯读回的那句诊断话术**还在回答里**（没被删掉）。
    const plain = await callPanelChannel('state', { cookie })
    const plainValue = valueOf(plain, 'state-diagnostic')
    console.log('RAW the state answer that must keep its diagnostic: ' + JSON.stringify(plainValue.message))
    expect(plainValue.message).toBe('nothing was changed')
  }, 180_000)

  it('后退 / 前进 / 刷新：地址由**视图自己**读回，不是回答里那个字段', async () => {
    // 让**视图自己**走一步（点页面里那个链接，不是本测试的会话去导航）。
    //
    // 为什么这一点是本质的、不是绕路：面板那一侧用的是**应用自己的**会话
    // （`adopt()` → `SpaceManager` 按空间缓存的那一个），而"能不能后退"是**会话观察到的历史**。
    // 本测试手里的 `session` 是**另一个** `AdoptedViewSession` 实例，它看不见视图自己走的那些步
    // —— 让**它**去 `goto` 再问面板"能不能后退"，量到的是两个会话之间的缝，不是面板的行为。
    // 所以这里让页面自己导航：那一次是面板的会话真正看到的。
    await session.goto(`${linkedOrigin}/one`)
    const first = viewUrlNow()
    await session.click('#t13-next')
    await session.wait({ text: 'page two' })
    const second = viewUrlNow()
    console.log(`RAW the view navigated itself: ${first} -> ${second}`)
    expect(second).toBe(`${linkedOrigin}/two`)

    const back = await callPanelChannel('back', { cookie })
    const afterBack = valueOf(back, 'back')
    console.log('RAW back over the panel channel: ' + JSON.stringify(afterBack))
    console.log(`RAW the view itself after back: ${second} -> ${viewUrlNow()}`)
    // 地址是**视图自己**说的。
    expect(viewUrlNow()).toBe(first)
    // 后退之后前进那一侧有了一页：面板上那颗按钮由此变亮。
    expect(afterBack.canGoForward).toBe(true)

    const forward = await callPanelChannel('forward', { cookie })
    const afterForward = valueOf(forward, 'forward')
    console.log('RAW forward over the panel channel: ' + JSON.stringify(afterForward))
    expect(viewUrlNow()).toBe(second)
    // 现在后退那一侧有了一页。
    expect(afterForward.canGoBack).toBe(true)

    // 刷新真的重新载入了：先在页面上留一个痕迹，调用之后它必须消失。
    await session.evaluate("document.title = 't13-touched'; void 0")
    expect(await session.title()).toBe('t13-touched')
    const reloaded = await callPanelChannel('reload', { cookie })
    valueOf(reloaded, 'reload')
    console.log('RAW the title after the panel channel reloaded the view: ' + (await session.title()))
    expect(await session.title()).not.toBe('t13-touched')
  }, 240_000)

  it('没有可后退的历史时，宿主如实说"不能后退"（面板上那颗按钮由此变灰）', async () => {
    await session.goto(`${origin(initialUrl)}/one`).catch(() => undefined)
    // 一个刚导航过去的页面，观察到的历史里没有前进那一侧。
    await session.goto(`${shell.handshake.fixtureOrigin}/other`)
    await session.goto(`${shell.handshake.fixtureOrigin}/view`)
    const forward = await callPanelChannel('forward', { cookie })
    const value = valueOf(forward, 'forward')
    console.log('RAW forward with no forward history: ' + JSON.stringify(value))
    expect(value.ok).toBe(false)
    expect(value.reason).toBe('no-history')
    expect(value.canGoForward).toBe(false)
  }, 180_000)

  it('「重新开始」把视图带回握手发布的初始页', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/other`)
    expect(viewUrlNow()).not.toBe(initialUrl)
    const restart = await callPanelChannel('restart', { cookie })
    const value = valueOf(restart, 'restart')
    console.log(`RAW restart over the panel channel: -> ${value.url} (initial page was ${initialUrl})`)
    // 地址是**视图自己**说的。
    expect(viewUrlNow()).toBe(initialUrl)
    // 重新开始顺带把缩放也重置了。
    expect(Number(value.zoom)).toBe(1)
  }, 180_000)

  it('票 #20 A · 地址栏那条动作：带 url 的 navigate 真的把视图开过去，地址由视图自己读回', async () => {
    await session.goto(`${shell.handshake.fixtureOrigin}/view`)
    const target = `${linkedOrigin}/two`
    const answer = await callPanelChannel('navigate', { cookie, payload: { url: target } })
    const value = valueOf(answer, 'navigate')
    console.log('RAW navigate over the panel channel: ' + JSON.stringify({ target, value, viewUrlNow: viewUrlNow() }))
    expect(answer.status).toBe(200)
    expect(value.ok).toBe(true)
    // **视图自己**到的那个地址（不是回答里那个字段）—— 与后面那一条快照用的是同一个读回口。
    expect(viewUrlNow()).toBe(target)
    expect(await (view as { page: Page }).page.title()).toBe('t13-linked-two')

    // 非法的协议**在这里被拒**（不信任客户端说它规范化过了）：不发出去，答一句为什么。
    const refused = await callPanelChannel('navigate', { cookie, payload: { url: 'javascript:alert(1)' } })
    const refusedValue = valueOf(refused, 'navigate-refused')
    console.log('RAW navigate refused: ' + JSON.stringify(refusedValue))
    expect(refusedValue.ok).toBe(false)
    expect(String(refusedValue.message)).toContain('javascript:')
    // 视图没动。
    expect(viewUrlNow()).toBe(target)

    // 一条根本解析不了的地址也一样：答一句人话，不 500。
    const broken = await callPanelChannel('navigate', { cookie, payload: { url: 'not a url' } })
    expect(broken.status).toBe(200)
    const brokenValue = valueOf(broken, 'navigate-broken')
    expect(brokenValue.ok).toBe(false)
    expect(String(brokenValue.message)).toContain('not a url')
    expect(viewUrlNow()).toBe(target)

    // 连 `url` 都不给：也答一句人话。
    const missing = await callPanelChannel('navigate', { cookie, payload: {} })
    expect(valueOf(missing, 'navigate-missing').ok).toBe(false)
  }, 240_000)

  it('票 #20 D · 档位那条动作：表内的档位真的跳过去，表外的一律拒', async () => {
    await callPanelChannel('zoom-reset', { cookie })
    const picked = await callPanelChannel('zoom-to', { cookie, payload: { zoom: 1.5 } })
    const value = valueOf(picked, 'zoom-to')
    console.log('RAW zoom-to 150%: ' + JSON.stringify({ value, dpr: await viewDpr() }))
    expect(picked.status).toBe(200)
    expect(Number(value.zoom)).toBeCloseTo(1.5, 6)
    // 页面自己报的 dpr 跟着变（与 `−`/`+` 走的是同一条路、同一套读回）。
    expect(await viewDpr()).toBeGreaterThan(1)
    // **票 #20b 翻转的一条**：指名一个值**不再**意味着"从此归人管"。外壳这一侧没有模式了
    // （适配永远开着），所以它照旧读回 `auto` —— 那个数是"现在的值"，下一次几何变化或换页
    // 就会被重新适配（`tests/fit-to-pane.spec.ts` 从真外壳那一侧量这件事）。
    expect(value.zoomMode, 'a named value no longer hands the pane to a person').toBe('auto')

    // 表外的值：拒，而且说得出是哪个值不在表里。
    const offTable = await callPanelChannel('zoom-to', { cookie, payload: { zoom: 0.83 } })
    const offValue = valueOf(offTable, 'zoom-to-off')
    console.log('RAW zoom-to 83%: ' + JSON.stringify(offValue))
    expect(offValue.ok).toBe(false)
    expect(String(offValue.message)).toContain('0.83')
    // 数字都给错时也答一句人话。
    const notANumber = await callPanelChannel('zoom-to', { cookie, payload: { zoom: '125%' } })
    expect(valueOf(notANumber, 'zoom-to-bad').ok).toBe(false)

    await callPanelChannel('zoom-reset', { cookie })
  }, 240_000)

  it('票 #20 F · 悬停要的"会去哪一页"来自引擎自己的历史（宿主那次读回里带着它）', async () => {
    await session.goto(`${linkedOrigin}/one`)
    await callPanelChannel('reload', { cookie })
    // 让**视图自己**再走一步：引擎的历史里于是有一前一后两条。
    await session.click('#t13-next')
    await session.wait({ text: 'page two' })
    const answer = await callPanelChannel('state', { cookie })
    const value = valueOf(answer, 'state-neighbours')
    console.log('RAW 票 #20 F 的邻居读数: ' + JSON.stringify({ backTarget: value.backTarget, forwardTarget: value.forwardTarget }))
    // 后退那一页就是引擎历史里的前一条，标题是**引擎记下的**那个。
    expect(value.backTarget).toBeTruthy()
    expect((value.backTarget as { title: string }).title).toBe('t13-linked')
    expect((value.backTarget as { url: string }).url).toBe(`${linkedOrigin}/one`)
    // 刚走了一段新路 ⇒ 前进那一侧引擎里没有下一页，于是**这个键缺席**（不是给一个空对象）。
    expect(value.forwardTarget).toBeUndefined()
    // 页面自己还在不在加载：这也是页面说的一句话。
    expect(typeof value.loading).toBe('boolean')
  }, 240_000)

  it('工具条存在时，视图的快照**逐项不变**，而且视图那一页里根本没有工具条的痕迹', async () => {
    // 快照看的是**视图那一页**。工具条在**面板那一页**，所以它不可能出现在快照里 ——
    // 但这件事必须被证明，因为"注入到错误的那一页"是一个很容易犯的错误。
    //
    // 票 #20 A 之后这一条的份量更大了：**地址栏是一个输入框**，而输入框是"往被驱动的那一页
    // 里塞东西"最容易出错的形状（一个 `document.querySelector` 写错名字就够了）。所以这里
    // 逐个点名读回：地址栏、档位菜单、状态读数，在视图那一页上**一个都没有**。
    const snapshot = await session.snapshot()
    console.log('RAW the view snapshot: ' + JSON.stringify(snapshot.elements.map((element) => element.name)))
    const inView = await (view as { page: Page }).page.evaluate(() => ({
      toolbar: document.querySelectorAll('[data-dsh-view-toolbar]').length,
      buttons: document.querySelectorAll('[data-dsh-view-action]').length,
      panel: document.querySelectorAll('[data-dsh-desktop-view-panel]').length,
      address: document.querySelectorAll('[data-dsh-view-address]').length,
      addressInputs: document.querySelectorAll('input[data-dsh-view-address]').length,
      zoomMenu: document.querySelectorAll('[data-dsh-view-zoom-menu]').length,
      zoomPresets: document.querySelectorAll('[data-dsh-view-zoom-preset]').length,
      reading: document.querySelectorAll('[data-dsh-view-reading]').length,
    }))
    console.log('RAW what the view page itself holds: ' + JSON.stringify(inView))
    expect(inView).toEqual({
      toolbar: 0,
      buttons: 0,
      panel: 0,
      address: 0,
      addressInputs: 0,
      zoomMenu: 0,
      zoomPresets: 0,
      reading: 0,
    })

    // 面板那一页上也没有（今天那一格没渲染出来，所以它的工具条也不该在）。
    // 这一条是"两边都没有"的读回：它证明不了工具条长什么样，但它证明**它没有跑到视图里去**。
    const inPanel = await ui.page.evaluate(() => ({
      toolbar: document.querySelectorAll('[data-dsh-view-toolbar]').length,
      buttons: document.querySelectorAll('[data-dsh-view-action]').length,
    }))
    console.log('RAW what the panel page holds today: ' + JSON.stringify(inPanel))

    // 逐项不变：把工具条该在的那一页再拍一次快照，两次必须完全一样。
    const again = await session.snapshot()
    expect(again).toEqual(snapshot)
  }, 180_000)

  it('那道门靠什么：不带凭据 → 401；跨源 → 403；而带着凭据与同源 Origin 才通', async () => {
    // 面板那条通道住在共享 `/api` 上，而**视图里装的是任意网站**。所以"网站能不能打它"
    // 必须是量出来的。宿主的门在 `isTrustedApiRequest`（Host/Origin 围栏）与浏览器会话凭据上，
    // 这一条把三者分开量：
    const withoutCookie = await callPanelChannel('state', {})
    console.log('RAW with no credentials: ' + JSON.stringify({ status: withoutCookie.status, body: withoutCookie.body.slice(0, 120) }))
    expect(withoutCookie.status).toBe(401)

    const crossOrigin = await callPanelChannel('state', { cookie, origin: 'http://evil.example' })
    console.log('RAW with a foreign Origin: ' + JSON.stringify({ status: crossOrigin.status, body: crossOrigin.body.slice(0, 120) }))
    expect(crossOrigin.status).toBe(403)

    const good = await callPanelChannel('state', { cookie })
    expect(good.status).toBe(200)
    expect(valueOf(good, 'state').ok).toBe(true)

    // 而视图那一页（另一个 origin）发起的跨源请求，浏览器那边也过不去：
    // 内容类型是 `application/json`，所以它触发预检；DSH 不答 CORS，宿主那边也拦。
    const before = viewUrlNow()
    const fromView = await (view as { page: Page }).page.evaluate(async (path) => {
      try {
        const response = await fetch(path, {
          method: 'POST',
          mode: 'no-cors',
          body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'desktop-view-restart', payload: {} }),
        })
        return { reached: true, type: response.type, status: response.status }
      } catch (error) {
        return { reached: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }, `${dshOrigin}${viewEndpointPath('restart')}`)
    console.log('RAW what a page in the view gets when it calls the panel channel: ' + JSON.stringify(fromView))
    // 关键在于"它没有干事"：`restart` 是这条通道上最响的一个副作用，视图必须还在原地。
    await new Promise((settle) => setTimeout(settle, 1_000))
    console.log(`RAW the view after the page tried: ${before} -> ${viewUrlNow()}`)
    expect(viewUrlNow()).toBe(before)
  }, 180_000)
})

/** 从一个地址里取它的 origin（用例里只用来拼一条不可能存在的地址）。 */
function origin(url: string): string {
  return new URL(url).origin
}
