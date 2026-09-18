import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { installShipment, mountShipment } from './mini-react.ts'
import { parseEngineHistory } from '../src/navigation.ts'
import { AdoptedViewSession } from '../src/session.ts'
import { SpaceManager } from '../src/spaces.ts'
import { desktopViewTools, type ToolDependencies } from '../src/tools.ts'
import { pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #18 —— 后退/前进被错判成"没有历史"而灰掉。
 *
 * ## 这一份要钉住的那个真实序列
 *
 * 用户在真机上的序列是：外壳把视图**先**放在一页上（没给 `--view-url` 时是内置测试页），
 * 之后 AI 才把它导航到 12306。也就是说**视图在领养之前就已经在某一页上了**，而领养之后
 * 只导航了一次。
 *
 * 旧账本（`ObservedHistory`）只记"会话看着它走过的那些页"，所以那个序列得到账本 `[12306]`、
 * `back = 0` ⇒ 工具条上的后退被灰掉 —— 而引擎用插件自己那条 CDP 连接答的是
 * `{currentIndex: 1, entryCount: 2}`：明明有一格可以退。
 *
 * 所以这一份的每一条都按**真实序列**构造：先在领养之前把视图导航到某一页（走**另一条连接**，
 * 会话一个字都看不见），再领养，再只导航一次。旧测试全是"先领养、再导航 A、再导航 B"，
 * 那个情形从来没被覆盖过 —— 那正是这张票漏掉的原因。
 *
 * ## 反证（把修复回退掉之后哪一条会变红）
 *
 * | 用例 | 回退掉修复之后 |
 * |---|---|
 * | 领养时已经在的那一页算一笔 | `canGoBack` 为 false（账本只有一笔） |
 * | 引擎动了就必须报 `moved: true` | 账本 `move()` 返回 false ⇒ 报 `moved: false` / `no-history` |
 * | 切任务空间再回来仍然如实 | 新会话账本为空 ⇒ 报"不能后退" |
 * | 真机上那颗按钮不再灰 | 宿主答 `canGoBack: false` ⇒ DOM 上 `disabled` 为 true |
 *
 * 「回退之后必须变红」这件事是真的跑出来的，原始输出在 `docs/research/t18-history-truth.md`。
 */

/** 一步就能看出来的夹具页：标题与正文明写自己是第几页。 */
const PAGE = (name: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t18-${name}</title></head>
<body><p id="t18-where">${name}</p></body></html>`

/** 一次工具调用允许带的第二个参数（与 `tests/view-actions.spec.ts` 同一写法）。 */
const IGNORED_EXEC = undefined as unknown as Parameters<
  ReturnType<typeof desktopViewTools>[number]['execute']
>[1]

describe('票 #18 · 历史是引擎说的，不是账本猜的', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /** 一条独立连接：被测实现看不见它，用它模拟"领养之前视图就已经在某一页上"。 */
  let probe: { browser: { close: () => Promise<void> }; page: Page }
  /** 空间/缩放那条既有通道：让会话拿到真外壳（以及一个真实的会话生命周期）。 */
  let spaces: SpaceManager
  let tools: ReturnType<typeof desktopViewTools>
  let server: { close: () => Promise<void> }
  let origin: string
  let dir: string

  /** 视图自己的地址，读自视图自己。 */
  const viewUrl = (): string => session.url()

  /** 跑一次 `browser_view`，并把它的返回值收成宽松的形状。 */
  const view = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const found = tools.find((candidate) => candidate.name === 'browser_view')
    if (found === undefined) throw new Error('browser_view is not registered')
    return (await found.execute(args, IGNORED_EXEC)) as unknown as Record<string, unknown>
  }

  beforeAll(async () => {
    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const name = url.pathname.replace(/^\//, '')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE(name === '' ? 'root' : name))
    })
    await new Promise<void>((settle) => httpServer.listen(0, '127.0.0.1', () => settle()))
    const address = httpServer.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    server = { close: async () => await new Promise<void>((settle) => httpServer.close(() => settle())) }

    dir = mkdtempSync(join(tmpdir(), 'dsh-t18-'))
    // 外壳**没给** `--view-url`：这正是用户跑 `npm run shell` 的形状（视图起在内置测试页上），
    // 也是"领养时视图已经在某一页上"这句话的来源。
    shell = await startShell(['--bounds', '0,0,620,800'], { windowSize: { width: 1240, height: 900 } })
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    spaces = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
    // **先**让视图走到别的页面上去（走探针那条连接：本会话此刻还不存在，所以它一个字都看不见）。
    await probe.page.goto(`${origin}/one`, { waitUntil: 'load' })
    await probe.page.goto(`${origin}/two`, { waitUntil: 'load' })
    const beforeAdoption = await probe.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      historyLength: window.history.length,
    }))
    console.log('RAW 领养之前视图自己报的（走另一条连接）: ' + JSON.stringify(beforeAdoption))
    session = await spaces.adopt(shell.handshake.cdpUrl)
    tools = desktopViewTools(() => Promise.resolve(session), {} as ToolDependencies)
  }, 180_000)

  afterAll(async () => {
    if (spaces !== undefined) await spaces.close()
    if (session !== undefined) await session.close().catch(() => undefined)
    if (probe !== undefined) await probe.browser.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (server !== undefined) await server.close()
    if (dir !== undefined) removeWhenFree(dir)
  })

  // ── 纯判断：引擎那份回答怎么读 ───────────────────────────────────────────────

  it('引擎的回答怎么读成两个计数（纯判断，不需要浏览器）', () => {
    // 票面那份决定性证据的原文：`{currentIndex: 1, entryCount: 2}` —— 一格可以退。
    const evidence = parseEngineHistory({
      currentIndex: 1,
      entries: [{ url: 'http://127.0.0.1:49500/view' }, { url: 'https://kyfw.12306.cn/otn/leftTicket/init' }],
    })
    console.log('RAW 票面那份证据读出来: ' + JSON.stringify(evidence))
    expect(evidence).toEqual({ back: 1, forward: 0 })

    // 前进分支：退一步之后引擎自己会这么答。
    expect(parseEngineHistory({ currentIndex: 0, entries: [{}, {}, {}] })).toEqual({ back: 0, forward: 2 })
    // 只有一页：两边的 0 是**事实**（引擎说的），不是"没看见"。
    expect(parseEngineHistory({ currentIndex: 0, entries: [{}] })).toEqual({ back: 0, forward: 0 })
    // 读不动就**说读不动**，绝不编一个 0：一个缺字段的回答被当成 `{0, 0}` 正是"读不到"
    // 长得像"不能后退"的成因。
    for (const bad of [
      {},
      { currentIndex: 0 },
      { entries: [{}] },
      { currentIndex: 1, entries: [{}] },
      { currentIndex: -1, entries: [{}] },
      { currentIndex: 0.5, entries: [{}, {}] },
      { currentIndex: 0, entries: 'two' },
      null,
      'nope',
    ]) {
      expect(parseEngineHistory(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  // ── 验收①③：真实序列（视图先在某一页上，领养之后只导航一次） ────────────────

  it('领养时视图已经在的那一页算一笔：只导航一次之后，state 报 canGoBack === true', async () => {
    // 领养那一刻视图在 `/two` 上，而它是在领养**之前**走过去的 —— 账本因此是空的。
    expect(viewUrl()).toBe(`${origin}/two`)
    const atAdoption = await session.historyState()
    console.log('RAW 领养之后立刻读到的历史（引擎答的）: ' + JSON.stringify(atAdoption))
    // 引擎里此刻是 [内置测试页, /one, /two] —— 有两格可以退，而这个会话一页都没看着走过。
    expect(atAdoption.source, '历史必须来自引擎，而不是本会话的账本').toBe('engine')
    expect(atAdoption.back).toBeGreaterThan(0)

    // 只导航**一次**（真实序列的那一步）。
    await session.goto(`${origin}/three`)
    expect(viewUrl()).toBe(`${origin}/three`)

    const state = await view({ action: 'state' })
    console.log('RAW browser_view action "state" 在真实序列下: ' + JSON.stringify(state))
    expect(state.canGoBack, '引擎里明明有一格可以退').toBe(true)
    expect(state.canGoForward).toBe(false)
  }, 120_000)

  it('引擎动了就必须报 moved: true，而且地址真的变了', async () => {
    // 这一条构造的正是"账本说没有、引擎其实能退"：账本里此刻只有 `/three`（领养之后
    // 唯一被这个会话看见过的一次导航），所以旧实现会 `move(-1)` 返回 false ⇒ 报 `moved: false`。
    const back = await view({ action: 'back' })
    console.log('RAW back 在"账本说没有、引擎其实能退"的情形下: ' + JSON.stringify(back))
    expect(back.ok, '引擎真的退了，就不许报没退').toBe(true)
    // 地址是**视图自己**说的，不是回答里那个字段。
    expect(viewUrl()).toBe(`${origin}/two`)

    const state = await view({ action: 'state' })
    console.log('RAW 后退之后的 state: ' + JSON.stringify(state))
    expect(state.canGoBack).toBe(true)
    expect(state.canGoForward, '退回来之后前进那一侧必须还在').toBe(true)

    // 前进也真的动（同一根因的另一半）。
    const forward = await view({ action: 'forward' })
    console.log('RAW forward: ' + JSON.stringify(forward))
    expect(forward.ok).toBe(true)
    expect(viewUrl()).toBe(`${origin}/three`)
    // 回到 `/three` 之后前进那一侧又没了（引擎说的）。
    expect((await view({ action: 'state' })).canGoForward).toBe(false)
  }, 120_000)

  it('真的没有那一格时如实说没有，而且那句话分得清"引擎说的"与"账本没看见"', async () => {
    // `/three` 是引擎里最新的一笔：前进侧没有东西，所以这一条是**真的**没有。
    const forward = await view({ action: 'forward' })
    console.log('RAW 前进到头: ' + JSON.stringify(forward))
    expect(forward.ok).toBe(false)
    expect(forward.reason).toBe('no-history')
    // 那句话必须与"账本没看见"分得开 —— 这里是引擎答的事实。
    expect(String(forward.message)).toContain("engine's own navigation history")
  }, 120_000)

  // ── 验收④：切任务空间再回来（会话可能被重建） ──────────────────────────────

  it('切到另一个任务空间再回来，历史仍然如实（新会话也不许说"没有历史"）', async () => {
    const before = probe.page.url()
    await spaces.command('create', 't18-other')
    const away = spaces.readState()
    console.log(
      'RAW 切走之后外壳发布的表: ' +
        JSON.stringify({ active: away?.active, spaces: away?.spaces.map((space) => space.name) }),
    )
    expect(away?.active).toBe('t18-other')

    await spaces.command('use', 'default')
    const back2 = spaces.readState()
    console.log('RAW 切回来之后外壳发布的表: ' + JSON.stringify({ active: back2?.active }))
    expect(back2?.active).toBe('default')

    // 会话是**重新领养**的：这里的 `again` 是一份新的 `AdoptedViewSession`，它的账本从零开始
    // —— 而历史必须照样如实（这条正是"问引擎"与"只在领养时补一笔 seed"的分水岭）。
    const again = await spaces.adopt(shell.handshake.cdpUrl)
    const reading = await again.historyState()
    console.log('RAW 切回来之后的历史: ' + JSON.stringify(reading))
    // 视图的位置一点没变（同一个空间、同一块视图）。
    expect(await probe.page.url()).toBe(before)
    expect(reading.source, '重建出来的会话也必须问引擎').toBe('engine')
    expect(reading.back, '回到的这块视图里仍然有一格可以退').toBeGreaterThan(0)

    // 而且真的退得动 —— 它读的与它做的是同一份事实。
    const result = await again.goBack()
    console.log('RAW 切回来之后 goBack: ' + JSON.stringify(result))
    expect(result.moved).toBe(true)
    expect(await probe.page.url()).not.toBe(before)
  }, 180_000)

  // ── 验收②：真机层面那颗按钮不再灰（读 DOM 的 `disabled`，不读实现自己的变量） ──

  it('真机上那颗后退按钮不再灰：DOM 里的 disabled 属性读出来是 false', async () => {
    // 这一条量的是**交出去的那份东西**：`client.js` 生成物、真 DOM，以及那个 `disabled` 属性本身。
    //
    // 三件事是替身，且只有这三件（每条都有明确理由）：
    //  1. 模块加载器（`window.__ModuleLoader__`）—— 真宿主那个由 DSH 的启动图提供，而在本仓库的
    //     临时 profile 上它建不完（`tests/panel-toolbar.spec.ts` 头部记过这条实测）；
    //  2. 渲染器 —— 这一页上没有 React（本仓库 `.npmrc` 明令不下载浏览器与它那一套），
    //     所以用的是 `tests/mini-react.ts` 里那个最小渲染器（那份文件头部写了它的边界与坑）；
    //  3. 宿主那条 RPC（`ctx.connection.rpc.call`）—— 它已经在 `panel-toolbar.spec.ts` 里对着
    //     **真宿主**逐动作量过了；这里要量的是那个答案变成 DOM 之后的那一格。
    //
    // 被量的那一段是真的：`client.js` 生成物里那七颗按钮、`isEnabled` 的判断、以及
    // `disabled` 这个 **DOM 属性本身** —— 读的不是实现手里的任何一个变量。
    const target = probe.page
    // 先把视图走到一页**新**地方：一次 `goto` 会把前进那一侧丢掉，于是"后退有一格、
    // 前进没有"这两个条件同时成立，而它们正是这一条要量的那一对。
    await session.goto(`${origin}/four`)
    // 这一条**不自己编那份读数**：它先把宿主真正答的那两个数读出来（同一条 CDP 连接问引擎，
    // 也就是面板那条通道背后同一个会话），再把它们喂给那一格。
    //
    // 为什么必须这样：这一页上没有宿主（真宿主那半条通道由 `panel-toolbar.spec.ts` 对着
    // **真 dsh 宿主**量过），所以 DOM 这一条能证的边界是"宿主答 A ⇒ DOM 上就是 A"。让 A 来自
    // 被测实现自己的读回，整条链才是"引擎里有一格可以退 ⇒ 那颗按钮不灰"，而不是
    // "我在替身里写了个 true ⇒ 它不灰"。
    const engineReading = await session.historyState()
    console.log('RAW 喂给那一格的宿主读数（来自被测实现自己的读回）: ' + JSON.stringify(engineReading))
    const answer = { canGoBack: engineReading.back > 0, canGoForward: engineReading.forward > 0 }
    expect(engineReading.source, '这份读数必须是引擎答的，否则下面量的不是票面那条路').toBe('engine')
    expect(answer.canGoBack, '引擎里必须真的有一格可以退，这条用例才在量东西').toBe(true)
    // 刚走了一段新路，前进那一侧必须已经被丢掉 —— 那一格正好当量具自检。
    expect(answer.canGoForward, '一次 goto 之后前进那一侧必须没了').toBe(false)

    // 视图那一页上本来**没有**矩形通道，所以给这一页装一个假的（面板要它才知道"有外壳"）。
    await installShipment(target, { withShellChannel: true, stubAnimationFrame: true })
    const mounted = await mountShipment(target, { rpcValue: answer })
    const raw = await target.evaluate(() => {
      const buttonFor = (action: string): HTMLButtonElement | null =>
        document.querySelector(`[data-dsh-view-action="${action}"]`)
      return {
        toolbarPresent: document.querySelectorAll('[data-dsh-view-toolbar]').length,
        order: Array.from(document.querySelectorAll('[data-dsh-view-action]')).map((node) =>
          node.getAttribute('data-dsh-view-action'),
        ),
        // **票面要的就是这三个读回**：DOM 上那个属性本身。
        backDisabled: buttonFor('back')?.disabled ?? null,
        forwardDisabled: buttonFor('forward')?.disabled ?? null,
        reloadDisabled: buttonFor('reload')?.disabled ?? null,
      }
    })
    console.log('RAW 真机上那一格的 DOM 读数: ' + JSON.stringify(raw))
    console.log('RAW 那一格向宿主问过什么: ' + JSON.stringify(mounted.rpcCalls))
    expect(raw.toolbarPresent, '那一格必须在页面上真的画出来了').toBe(1)
    expect(mounted.rpcCalls, '那一格至少向宿主问过一次状态').toContain('desktop-view-state')
    // 票 #20b：那颗 `auto` 按钮**没有了**（适配永远开着，没有模式可以交还）—— 顺序里也就没有它。
    expect(raw.order).toEqual(['back', 'forward', 'reload', 'zoom-out', 'zoom-reset', 'zoom-in', 'restart'])
    // **这一条就是票面要的那句话**：读的是 DOM 的 `disabled` 属性本身。
    expect(raw.backDisabled, '宿主答 canGoBack: true，那一格就不许还是灰的').toBe(false)
    // 量具自检：没有前进分支时它照旧是灰的 —— 否则上面那一条可能只是"这个属性永远是 false"。
    expect(raw.forwardDisabled, '没有前进分支时那一格还是灰的').toBe(true)
    // 与历史无关的按钮不受影响（"不知道"不许被渲染成"你不能"）。
    expect(raw.reloadDisabled).toBe(false)
  }, 180_000)
})
