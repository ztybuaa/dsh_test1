import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { installShipment, mountShipment } from './mini-react.ts'
import { pageForTarget, startShell, viewPlacements, type ShellProcess } from './shell-harness.ts'

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
})
