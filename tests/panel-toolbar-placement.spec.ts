import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { installShipment, mountShipment } from './mini-react.ts'
import {
  pageForTarget,
  startShell,
  viewPlacements,
  type ShellProcess,
  type ViewPlacement,
} from './shell-harness.ts'

/**
 * 票 #18 第二处（真机）：工具条**被那块原生画面盖住**，所以用户根本看不见它。
 *
 * ## 现场读数（用户在真机外壳里量的，算术级的证据）
 *
 * ```
 * 窗口里的三个框:  工具条 [939, 38, 768, 34]
 *                  面板   [939, 72, 768, 898]
 *                  容器   [939, 38, 768, 932]     ← 34 + 898
 * 原生画面自己的 CSS 尺寸: 768 × 932
 * ```
 *
 * **画面尺寸 = 容器尺寸（工具条 + 面板），不是面板尺寸** ⇒ 外壳把画面摆在了整块上，
 * 连工具条那一行一起盖住。用户看到的就是"那一格上面空空的，没有后退/前进"。
 *
 * ## 根因（一行）
 *
 * `src/client-body.js` 里 `elementRef.current = hostRef.current`，而 `hostRef` 挂在**外层容器**上
 * —— 那个容器同时装着 `<Toolbar>` 和下面那块该被测量的 div。它自己那段注释写的是相反的：
 *
 * > *"被测量的是**下面**那一个，这是故意的……否则跟它共用矩形的工具条会被画面盖住。"*
 *
 * **注释对、代码错。**
 *
 * ## 为什么既有测试没抓到
 *
 * `tests/panel-placement.spec.ts` 的断言是"面板上报的矩形 == 外壳应用的矩形" —— 两边都是
 * **夹具的**面板元素（`#panel`），依然相等，依然绿。而**没有任何一条断言说"上报的矩形里
 * 不含工具条那一行"**：夹具那一页上根本没有工具条。T13 新增的工具条正好落进这个缝里。
 *
 * 所以这一份量的是**交付物本身**：`client.js` 生成物里的 `Panel`，装在真外壳窗口那一页
 * （有真的 `window.__dshDesktopView`，所以上报真的走到外壳）上。
 */

/**
 * 那一格的尺寸：照用户真机那一格的形状（宽 768 在测试窗口里放不下，取 440）。
 *
 * 用**明确的像素**而不是"占满父亲"：用户现场那三个框就是明确的像素。
 */
const SLOT = { width: 440, height: 800 }

describe('票 #18 第二处 · 上报的矩形里不许含工具条那一行', () => {
  let shell: ShellProcess
  let probe: Browser
  let windowPage: Page

  beforeAll(async () => {
    shell = await startShell([], { windowSize: { width: 1200, height: 800 } })
    if (shell.handshake.windowTargetId === undefined) throw new Error('the shell did not publish a window target id')
    const connected = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.windowTargetId)
    probe = connected.browser
    windowPage = connected.page
    // 清成一张白纸，再摆一格：**只有交付物**那一格会上报，于是"哪一条落点是它报的"没有歧义
    // （夹具那一页 `/panel` 自己那个面板也会上报，而且报的是同一个矩形）。
    await windowPage.goto('about:blank')
    await windowPage.evaluate((slot: { width: number; height: number }) => {
      document.body.style.margin = '0'
      const pane = document.createElement('div')
      pane.id = 'pane'
      pane.style.position = 'fixed'
      pane.style.top = '0'
      pane.style.left = '0'
      pane.style.width = `${String(slot.width)}px`
      pane.style.height = `${String(slot.height)}px`
      document.body.appendChild(pane)
      // 交付物那一格要有矩形通道才会渲染工具条（"有外壳"就是"有这条通道"）。
      // 这一页上的 `__dshDesktopView` 是**真的**（preload 装在 shell 窗口的 window 上，
      // 导航到 about:blank 之后仍然在），所以上报真的会走 IPC 到外壳。
      const channel = (window as unknown as { __dshDesktopView?: { setRect?: unknown } }).__dshDesktopView
      if (typeof channel?.setRect !== 'function') {
        throw new Error('this window has no rectangle channel, so the shipped panel would render "no shell"')
      }
    }, SLOT)
  }, 180_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  it('上报矩形的上边缘 ≥ 工具条的下边缘（工具条那一行不在被上报的矩形里）', async () => {
    await installShipment(windowPage, { stubAnimationFrame: true })
    const mounted = await mountShipment(windowPage, {
      into: '#pane',
      rpcValue: { canGoBack: true, canGoForward: false },
    })
    const raw = await windowPage.evaluate(() => {
      const box = (
        element: Element | null,
      ): { top: number; bottom: number; left: number; right: number; width: number; height: number } | null => {
        if (element === null) return null
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
      }
      const toolbar = document.querySelector('[data-dsh-view-action="back"]')?.parentElement ?? null
      const measuredElement = document.querySelector('[data-dsh-desktop-view-panel]')
      return {
        measuredState: measuredElement?.getAttribute('data-dsh-desktop-view-panel') ?? null,
        toolbarDeclaredHeight:
          toolbar === null ? null : Number((toolbar as HTMLElement).style.height.replace('px', '')),
        toolbar: box(toolbar),
        measured: box(measuredElement),
        container: box(document.getElementById('dsh-view-shipped-panel')),
        pane: box(document.getElementById('pane')),
      }
    })
    console.log(
      'RAW 窗口这一页上的框（DOM 量的）: ' +
        JSON.stringify({
          toolbar: raw.toolbar,
          measured: raw.measured,
          container: raw.container,
          pane: raw.pane,
          measuredState: raw.measuredState,
        }),
    )

    // 量具自检：那一格真的画出来了，被测量的那一块也在，而且真的向宿主问过状态。
    expect(raw.toolbar, '工具条必须在页面上真的画出来').not.toBeNull()
    expect(raw.measured, '被测量的那一块必须在页面上').not.toBeNull()
    expect(raw.toolbarDeclaredHeight, '工具条声明的高度就是那个常量').toBe(34)
    expect(raw.toolbar?.height, '工具条真的占了那一行').toBe(34)
    expect(mounted.rpcCalls, '那一格至少向宿主问过一次状态').toContain('desktop-view-state')

    // **DOM 那一侧的关系**（这一条与渲染器的时序无关，量的是**布局**）：
    // 被测量的那一块紧接工具条下面，它的高度 = 那一格 − 工具条那一行；
    // 而外层容器是**整块**（从工具条的上边缘一直到底）。回退掉修复之后这两条都会变红，
    // 因为那时上报的是容器（上边缘 0、高 738）。
    console.log(
      `RAW DOM：容器 ${JSON.stringify(raw.container)} / 工具条 ${JSON.stringify(raw.toolbar)} / 被测量的那一块 ${JSON.stringify(raw.measured)}`,
    )
    expect(Math.round(raw.container?.top ?? -1), '容器从工具条的上边缘开始').toBe(Math.round(raw.toolbar?.top ?? -2))
    expect(Math.round(raw.container?.bottom ?? -1), '容器一直到被测量那一块的下边缘').toBe(
      Math.round(raw.measured?.bottom ?? -2),
    )
    expect(Math.round(raw.measured?.top ?? -1), '被测量的那一块在工具条下面').toBe(
      Math.round(raw.toolbar?.bottom ?? -2),
    )
    expect(Math.round(raw.measured?.height ?? -1)).toBe(Math.round(SLOT.height) - 34)
    expect(Math.round(raw.measured?.top ?? -1), '它不在容器的上边缘上（那就是这个 bug）').toBeGreaterThan(
      Math.round(raw.container?.top ?? -1),
    )
    expect(Math.round(raw.pane.height)).toBe(Math.round(SLOT.height))

    // **外壳那一侧**：交付物上报的矩形真的走到了外壳，而外壳摆的就是它。
    //
    // 上报 → preload → IPC → 外壳 `view.setBounds`；外壳把 `bounds`（面板要的）与
    // `applied`（Electron 读回的）都发布出来。**上边缘**只断言"不落在工具条那一行里"，
    // 不断言"等于 DOM 里那个数"：这一份用的是替身渲染器，它每次渲染都会重挂被测量的元素
    // （真 React 不会），所以面板上报的时刻与 DOM 被量的时刻之间可能隔着一次重挂。
    const expectedWidth = Math.round(raw.measured?.width ?? -1)
    const placement = await shell
      .waitForPlacement(
        (candidate) => candidate.cause === 'panel-report' && candidate.bounds !== null && candidate.bounds.width === expectedWidth,
        'the shell to apply the rectangle the shipped panel reported',
        30_000,
      )
      .catch((error: unknown) => {
        console.log(
          'RAW 外壳发布过的每一条落点（cause/bounds）: ' +
            JSON.stringify(
              viewPlacements(shell.stdout()).map((entry) => ({ cause: entry.cause, bounds: entry.bounds, applied: entry.applied })),
            ),
        )
        throw error
      })
    console.log('RAW 外壳为交付物那一格应用的落点: ' + JSON.stringify(placement))
    expect(placement.visible).toBe(true)
    expect(placement.appliedVisible).toBe(true)
    expect(placement.bounds?.width).toBe(expectedWidth)
    // 上报的矩形比那一格**矮一条工具条**（画面不许盖住工具条那一行）。
    expect(placement.bounds?.height ?? 0).toBeLessThan(Math.round(SLOT.height))
    // 而且它的上边缘不落在工具条那一行里。
    console.log(`RAW 落点的上边缘 ${String(placement.applied?.y)} vs 工具条那一行的高度 34`)
    expect(
      placement.applied?.y ?? -1,
      '落点的上边缘必须 ≥ 工具条那一行的高度 —— 否则原生画面会盖住工具条（用户就看不见按钮了）',
    ).toBeGreaterThanOrEqual(34)
  }, 180_000)

  /**
   * 票 #20b 要求 2 在**真通道**那一侧的读回：空闲一行、展开真的让位、`Esc` 回到一行。
   *
   * 为什么非要在这一页上再量一遍（`tests/toolbar-panel.spec.ts` 已经量过 DOM 几何）：那边用的是
   * **假的**矩形通道（`setRect: () => undefined`），所以它证的是"DOM 长什么样"；而用户看到的是
   * **原生画面被摆在哪**。这一条走的是真的 `shell/preload.js` → IPC → 外壳 → Electron
   * `view.getBounds()`，读回来的是外壳**应用**的那个 y。三层（DOM、上报、外壳应用）必须一致，
   * 而其中任何一层自己说"关上了"都不算 —— 所以断言的判据是**落点**，不是面板的状态变量。
   */
  it('票 #20b 要求 2 · 真通道：空闲落点在 34、展开真的往下让、Esc 之后回到 34', async () => {
    // 上一格先清掉：`mountShipment` 每挂一次就多一个容器，而这一条量的是**这一格**。
    await windowPage.evaluate(() => {
      document.getElementById('dsh-view-shipped-panel')?.remove()
    })
    await installShipment(windowPage, { stubAnimationFrame: true })
    await mountShipment(windowPage, { into: '#pane', rpcValue: { canGoBack: true, canGoForward: false } })

    /** 这一格现在的几何（DOM 那一半）。 */
    const geometry = async (): Promise<{ height: number; measuredTop: number; measuredWidth: number }> =>
      await windowPage.evaluate(() => {
        const toolbar = document.querySelector('[data-dsh-view-toolbar]') as HTMLElement | null
        const measured = document.querySelector('[data-dsh-desktop-view-panel]') as HTMLElement | null
        return {
          height: toolbar === null ? -1 : Math.round(toolbar.getBoundingClientRect().height),
          measuredTop: measured === null ? -1 : Math.round(measured.getBoundingClientRect().top),
          measuredWidth: measured === null ? -1 : Math.round(measured.getBoundingClientRect().width),
        }
      })

    const placed = (): ViewPlacement[] => viewPlacements(shell.stdout())

    /**
     * 等外壳**新**应用一条落点（下标 ≥ `after`）并满足条件。
     *
     * 为什么带下标：`waitForPlacement` 是从头扫的，而这一页上早就有落点了 —— 一个"y === 34"的
     * 断言会在**上一格**留下的那条上直接命中，等于什么都没量。所以只认这一格之后新出现的那几条。
     *
     * @param after - 从第几条开始看。
     * @param predicate - 要什么形状的落点。
     * @param what - 超时消息里点名要等的是什么。
     * @returns 那一条落点与它的下标。
     */
    const waitForNewPlacement = async (
      after: number,
      predicate: (placement: ViewPlacement) => boolean,
      what: string,
    ): Promise<{ placement: ViewPlacement; index: number }> => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const all = placed()
        for (let index = after; index < all.length; index += 1) {
          if (predicate(all[index])) return { placement: all[index], index }
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting for ${what}; placements since index ${String(after)}:\n` +
              JSON.stringify(
                all.slice(after).map((entry) => ({ cause: entry.cause, reported: entry.reported, applied: entry.applied })),
                null,
                2,
              ),
          )
        }
        await new Promise((settle) => setTimeout(settle, 50))
      }
    }

    /**
     * 让面板**重新量一次并上报**。
     *
     * 这一份用例装的是 `stubAnimationFrame: true`（替身渲染器的需要：离屏页面里 rAF 会被连续调度，
     * 每次上报都让面板重画一轮，一路撞上渲染闸，整棵树冻住 —— 见 `tests/mini-react.ts` 顶部坑 4）。
     * 代价是 `ResizeObserver` 与每帧那次测量**都被关掉了**，于是"元素自己的盒子变了"这条线在这里
     * 不通。所以这一条用例借 {@@link 面板矩形} 观察者另一条**同样真实**的线：窗口 resize
     * （`shell/panel-rect.js` 的 `observe()` 里那三行之一）。
     *
     * 在真产品里，展开档位菜单那一行是 `ResizeObserver` 报出去的 —— 那一条线由
     * `tests/panel-observer.spec.ts` 与 `tests/panel-placement.spec.ts` 用真观察者量过。
     *
     * @returns {Promise<void>} 事件派发完就 resolve。
     */
    const remeasure = async (): Promise<void> => {
      await windowPage.evaluate(() => {
        window.dispatchEvent(new Event('resize'))
      })
      await new Promise((settle) => setTimeout(settle, 200))
    }

    // ── 空闲：工具条一行，被测量的那一块从 34 开始，而外壳**应用**的 y 就是那个数 ──
    const idle = await geometry()
    const idlePlacement = await waitForNewPlacement(
      0,
      (entry) =>
        entry.cause === 'panel-report' &&
        entry.bounds !== null &&
        entry.bounds.width === idle.measuredWidth &&
        entry.applied !== null &&
        entry.applied.y === idle.measuredTop,
      'the shell to park the view below the one-line toolbar',
    )
    console.log(
      'RAW 票 #20b 真通道 · 空闲: ' +
        JSON.stringify({ dom: idle, applied: idlePlacement.placement.applied, index: idlePlacement.index }),
    )
    expect(idle.height, '空闲时工具条严格一行').toBe(34)
    expect(idle.measuredTop, '面板矩形的上边缘就是那一行下面').toBe(34)
    expect(idlePlacement.placement.applied?.y, '外壳把原生画面摆在 34 —— 工具条那一行没被盖住').toBe(34)
    expect(idlePlacement.placement.appliedVisible).toBe(true)

    // ── 展开档位菜单：工具条真的长高，而**外壳**跟着把画面往下让 ──
    const beforeOpen = placed().length
    await windowPage.click('[data-dsh-view-zoom-menu]')
    await remeasure()
    const open = await geometry()
    const openPlacement = await waitForNewPlacement(
      beforeOpen,
      (entry) => entry.applied !== null && entry.applied.y === open.measuredTop && entry.applied.y > 34,
      'the shell to move the view down while the menu is open',
    )
    console.log(
      'RAW 票 #20b 真通道 · 展开: ' + JSON.stringify({ dom: open, applied: openPlacement.placement.applied }),
    )
    expect(open.height).toBeGreaterThan(34)
    expect(open.measuredTop).toBeGreaterThan(34)
    expect(openPlacement.placement.applied?.y, '展开的那一行真的把原生画面推下去了（菜单不会被它盖住）').toBeGreaterThan(34)

    // ── `Esc`：菜单自己收，几何整个回到一行前的那三个数 ──
    const beforeEscape = placed().length
    await windowPage.keyboard.press('Escape')
    await remeasure()
    const closed = await geometry()
    const closedPlacement = await waitForNewPlacement(
      beforeEscape,
      (entry) => entry.applied !== null && entry.applied.y === closed.measuredTop && entry.applied.y === 34,
      'the shell to bring the view back up after Esc closed the menu',
    )
    console.log(
      'RAW 票 #20b 真通道 · Esc 之后: ' + JSON.stringify({ dom: closed, applied: closedPlacement.placement.applied }),
    )
    expect(closed.height, 'Esc 之后工具条必须回到一行').toBe(34)
    expect(closed.measuredTop).toBe(34)
    expect(closedPlacement.placement.applied?.y, '外壳重新把画面摆回 34').toBe(34)
  }, 180_000)
})
