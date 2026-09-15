import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { pageForTarget, startShell, viewPlacements, type ShellProcess, type ViewPlacement } from './shell-harness.ts'

/**
 * T2 seam test: "the sidebar slot is the native view, and it follows the layout".
 *
 * The panel and the shell are two processes, and the whole feature is the message
 * between them. So this test does not assert on either side alone:
 *
 *   - the panel side is a real Chromium page inside the shell window, running the
 *     real `shell/panel-rect.js` (the same file the shipped client bundle splices
 *     in), reporting through the real `window.__dshDesktopView` global the preload
 *     exposes — nothing about the fixture fakes the measurement;
 *   - the shell side is observed through `DSH_SHELL VIEW` lines, which the shell
 *     prints from inside its own process whenever it applies a placement;
 *   - and the view's own document is asked how big it ended up, because "the shell
 *     says it moved the view" and "the view is somewhere else" are different facts
 *     and only the second one is what the user sees.
 */

/** The panel's own default rectangle, as laid out by the fixture page: right edge, full height, 440 wide. */
const PANEL_WIDTH = 440

/** Rectangle reported when the fixture's "320x260" control is used: bottom-right corner. */
const PANEL_SMALL_WIDTH = 320
const PANEL_SMALL_HEIGHT = 260

/** Where the fixture parks the small panel: flush to the bottom-right of the window. */
const smallPanelRect = (windowSize: { width: number; height: number }) => ({
  x: windowSize.width - PANEL_SMALL_WIDTH,
  y: windowSize.height - PANEL_SMALL_HEIGHT,
  width: PANEL_SMALL_WIDTH,
  height: PANEL_SMALL_HEIGHT,
})

/**
 * Ask the view's own page how big the native view is.
 *
 * `Page.getLayoutMetrics` and `window.innerWidth/innerHeight` are the view's document
 * answering for itself, over a connection that has nothing to do with the shell's
 * bookkeeping: if `setBounds` resized the native view, the page inside it lays out at
 * the new size and says so. That is the difference the test cares about — "the shell
 * says it moved the view" and "the view is somewhere else" are different facts.
 *
 * Only the *size* can be cross-checked this way. Electron 44 implements neither
 * `Browser.getWindowForTarget` nor `Browser.getWindowBounds` (measured: both answer
 * "wasn't found", on a page session and on a browser session alike), so the view's
 * screen *position* is not readable through CDP at all.
 *
 * @param browser - the CDP connection.
 * @param page - the view's page.
 * @returns the layout viewport size, as CSS pixels and as the page's own window.
 */
async function viewLayoutSize(
  browser: Browser,
  page: Page,
): Promise<{ css: { width: number; height: number }; inner: { width: number; height: number } }> {
  const context = page.context()
  const session = await context.newCDPSession(page)
  try {
    const layout = await session.send('Page.getLayoutMetrics')
    const size = layout.cssLayoutViewport as { clientWidth: number; clientHeight: number }
    const inner = (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))) as {
      width: number
      height: number
    }
    return { css: { width: size.clientWidth, height: size.clientHeight }, inner }
  } finally {
    await session.detach()
  }
}

/** Whether `applied` sits inside `windowSize`, allowing a pixel of rounding. */
function withinWindow(
  applied: { x: number; y: number; width: number; height: number },
  windowSize: { width: number; height: number },
): boolean {
  return (
    applied.x >= 0 &&
    applied.y >= 0 &&
    applied.x + applied.width <= windowSize.width + 1 &&
    applied.y + applied.height <= windowSize.height + 1
  )
}

describe('T2 — the panel reports its rectangle and the shell moves the view', () => {
  let shell: ShellProcess
  let windowPage: Page
  let probe: Browser
  /**
   * The size the view's own document reported once the panel's rectangle was applied,
   * or undefined when that read-back never happened. Recorded so the last test can say
   * whether the cross-check actually ran instead of skipping silently.
   */
  let viewSizeReadBack: { css: { width: number; height: number }; inner: { width: number; height: number } } | undefined
  /** The placement that put the view on the panel's rectangle; read back in the last test. */
  let placedOnPanel: ViewPlacement | undefined

  beforeAll(async () => {
    shell = await startShell([], { windowSize: { width: 1200, height: 800 } })
    if (shell.handshake.windowTargetId === undefined) throw new Error('the shell did not publish a window target id')
    const connected = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.windowTargetId)
    probe = connected.browser
    windowPage = connected.page

    // The shell already loaded the fixture `/shell` page into the window. Navigating
    // that same window to `/panel` is what a user does in DSH: the window host stays
    // the same, its page — and with it the panel — is replaced.
    await windowPage.goto(`${shell.handshake.fixtureOrigin}/panel`, { waitUntil: 'load' })
    await windowPage.waitForFunction(
      () => (window as unknown as { __panelReports?: unknown[] }).__panelReports !== undefined,
      undefined,
      { timeout: 30_000 },
    )
  }, 180_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  it('reports the panel rectangle and moves the view onto it', async () => {
    // The panel's own report, read from the page: what the user's sidebar would say.
    const panelRect = await windowPage.evaluate(() => {
      const reports = (window as unknown as { __panelReports: Array<{ rect: unknown }> }).__panelReports
      return reports[0]?.rect ?? null
    })
    console.log('RAW panel report: ' + JSON.stringify(panelRect))
    expect(panelRect).not.toBeNull()

    // The shell's side: it applied exactly that rectangle.
    //
    // The trigger is `cause` ("what asked for this placement"), not `reason` ("why
    // the placement came out the way it did"): a panel report whose decision came out
    // as a placeable rectangle has `cause: "panel-report"` and `reason: "reported"`.
    const applied = await shell.waitForPlacement(
      (placement) => placement.cause === 'panel-report',
      'the shell to place the view on the panel rectangle',
    )
    console.log('RAW shell placement: ' + JSON.stringify(applied))
    placedOnPanel = applied
    expect(applied.visible).toBe(true)
    expect(applied.appliedVisible).toBe(true)
    expect(applied.clamped).toBe(false)
    expect(applied.bounds).toEqual(panelRect)
    expect(applied.applied).toEqual(applied.bounds)

    // The shell starts the view at `--bounds` (760,0,440,800) before any panel
    // speaks. The panel's default rectangle is deliberately a *different* one, so
    // "the rectangle reached the shell" cannot be satisfied by the initial value.
    //
    // That initial rectangle is in `applied`, not in `bounds`: `bounds` is the
    // rectangle a *panel* asked for, and when this placement is published no panel
    // has spoken yet. `applied` is `view.getBounds()` read back out of Electron, so
    // it is the view's real geometry — which is the thing `--bounds` sets.
    const initial = viewPlacements(shell.stdout()).find((placement) => placement.cause === 'initial-bounds')
    console.log('RAW initial placement: ' + JSON.stringify(initial))
    expect(initial, 'the shell should publish the rectangle it starts the view at').toBeDefined()
    expect(initial?.applied).toEqual({ x: 760, y: 0, width: 440, height: 800 })
    expect(applied.applied).not.toEqual(initial?.applied)

    // And the view is really there at that size: ask the view's *own* page, which
    // lays out at whatever size the shell gave the native view.
    const viewTarget = { cdpUrl: shell.handshake.cdpUrl, targetId: shell.handshake.targetId }
    const { browser: viewBrowser, page: viewPage } = await pageForTarget(viewTarget.cdpUrl, viewTarget.targetId)
    try {
      const observed = await viewLayoutSize(viewBrowser, viewPage)
      console.log('RAW view layout size (read from the view itself): ' + JSON.stringify(observed))
      expect(observed.css.width).toBe(applied.applied?.width)
      expect(observed.css.height).toBe(applied.applied?.height)
      expect(observed.inner.width).toBe(applied.applied?.width)
      expect(observed.inner.height).toBe(applied.applied?.height)
      viewSizeReadBack = observed
    } finally {
      await viewBrowser.close()
    }
  }, 120_000)

  it('hides the view when the panel reports no rectangle, and shows it again', async () => {
    const before = shell.latestPlacement()
    expect(before?.visible).toBe(true)

    // A tab switched away / a collapsed sidebar / a detached panel all look like
    // this from the panel's side: the element stops occupying a rectangle.
    await windowPage.click('#hide-display')
    const hidden = await shell.waitForPlacement(
      (placement) => placement.cause === 'panel-none',
      'the shell to hide the view after the panel reported no rectangle',
    )
    console.log('RAW placement after panel hid: ' + JSON.stringify(hidden))
    // `visible` is the shell's decision, `appliedVisible` is Electron's own answer.
    // Asserting both is the difference between "the shell meant to hide the view" and
    // "the view is hidden".
    expect(hidden.visible).toBe(false)
    expect(hidden.appliedVisible).toBe(false)
    expect(hidden.bounds).toBeNull()
    // Hiding must be a *visibility* change, not a resize to nothing: the view keeps
    // the rectangle it already had, so showing it again needs no re-measure. `applied`
    // is `view.getBounds()` read back from Electron, and it survives the hide verbatim.
    expect(hidden.applied).toEqual(before?.applied)
    expect(hidden.applied).not.toBeNull()
    const hiddenState = await windowPage.evaluate(() => {
      const reports = (window as unknown as { __panelReports: Array<{ rect: unknown; state: string }> }).__panelReports
      return reports[reports.length - 1]
    })
    console.log('RAW panel report after hide: ' + JSON.stringify(hiddenState))
    expect(hiddenState?.rect).toBeNull()
    expect(hiddenState?.state).toBe('not-displayed')

    await windowPage.click('#show')
    const shown = await shell.waitForPlacement(
      (placement) => placement.cause === 'panel-report' && placement.visible,
      'the shell to show the view again after the panel reported a rectangle',
    )
    console.log('RAW placement after panel returned: ' + JSON.stringify(shown))
    expect(shown.visible).toBe(true)
    expect(shown.appliedVisible).toBe(true)
    expect(shown.bounds).not.toBeNull()
  }, 120_000)

  it('tracks a panel that changes size, and keeps the view inside the window', async () => {
    const windowSize = shell.latestPlacement()?.windowSize ?? { width: 1200, height: 800 }

    await windowPage.click('#size-small')
    const small = await shell.waitForPlacement(
      (placement) => placement.visible && placement.bounds?.width === PANEL_SMALL_WIDTH,
      'the shell to follow the panel to its smaller rectangle',
    )
    console.log('RAW placement after resize to 320x260: ' + JSON.stringify(small))
    expect(small.bounds).toEqual(smallPanelRect(windowSize))
    expect(small.appliedVisible).toBe(true)
    expect(withinWindow(small.applied ?? { x: 0, y: 0, width: 0, height: 0 }, windowSize)).toBe(true)

    // Shrink the window under the panel. The shell cannot shrink the panel — it is
    // the shell that must refuse to draw a view outside the window it owns.
    const smaller = { width: Math.round(windowSize.width / 2), height: Math.round(windowSize.height / 2) }
    await windowPage.evaluate((size) => window.resizeTo(size.width, size.height), smaller)
    const clamped = await shell.waitForPlacement(
      (placement) => placement.visible && placement.windowSize.width <= smaller.width + 2,
      'the shell to re-place the view after the window shrank',
      60_000,
    )
    console.log('RAW placement after window shrink: ' + JSON.stringify(clamped))
    expect(clamped.windowSize.width).toBeLessThan(windowSize.width)
    expect(withinWindow(clamped.applied ?? { x: 0, y: 0, width: 0, height: 0 }, clamped.windowSize)).toBe(true)
    expect(clamped.applied).not.toBeNull()
    expect(clamped.appliedVisible).toBe(true)

    // Every placement that actually *drew* the view stayed inside the window it was
    // in: this is the "not out of bounds" property across the whole run, not one
    // sample.
    //
    // The sweep is scoped to the placements where the view was visible, because for a
    // hidden placement `applied` is only `view.getBounds()` read back — the geometry
    // the view would come back at, not something anything draws. Folding those in
    // would assert that the shell must also resize a view it has hidden, which is not
    // the property this test is about (and the hide is precisely a refusal to touch
    // the geometry). What must never happen is a *painted* view sticking out.
    const violations = viewPlacements(shell.stdout())
      .filter((placement) => placement.appliedVisible === true)
      .filter((placement) => placement.applied !== null)
      .filter((placement) => !withinWindow(placement.applied!, placement.windowSize))
    console.log('RAW out-of-window visible placements: ' + JSON.stringify(violations))
    expect(violations).toEqual([])

    // The sweep would be vacuous if nothing had ever been drawn, so say how many
    // placements it actually covered.
    const drawn = viewPlacements(shell.stdout()).filter((placement) => placement.appliedVisible === true)
    console.log('RAW visible placements covered by the sweep: ' + String(drawn.length))
    expect(drawn.length).toBeGreaterThan(0)

    // And the view itself followed the panel: after all that moving, its own document
    // lays out at the smaller rectangle, not at the size it had before. Same read-back
    // as in the first test, taken after a change.
    const viewTarget = { cdpUrl: shell.handshake.cdpUrl, targetId: shell.handshake.targetId }
    const { browser: viewBrowser, page: viewPage } = await pageForTarget(viewTarget.cdpUrl, viewTarget.targetId)
    try {
      const observed = await viewLayoutSize(viewBrowser, viewPage)
      console.log('RAW view layout size after the shrink: ' + JSON.stringify(observed))
      expect(observed.css.width).toBe(PANEL_SMALL_WIDTH)
      expect(observed.css.height).toBe(PANEL_SMALL_HEIGHT)
      expect(observed.css.width).toBe(clamped.applied?.width)
      expect(observed.css.height).toBe(clamped.applied?.height)
    } finally {
      await viewBrowser.close()
    }
  }, 120_000)

  it('renders an explicit notice instead of failing when there is no shell', async () => {
    // A plain `dsh web` in a browser tab has no preload, so no rectangle channel.
    // The panel must say so, and must not report anything anywhere.
    const result = await windowPage.evaluate(() => {
      const global = window as unknown as { DshPanelRect: { deliver: (r: unknown, o?: unknown) => unknown } }
      return global.DshPanelRect.deliver({ x: 1, y: 1, width: 10, height: 10 }, { api: undefined })
    })
    console.log('RAW deliver without a shell: ' + JSON.stringify(result))
    expect(result).toEqual({ delivered: false, reason: 'no-shell' })
  }, 60_000)

  it('cross-checks the shell rectangle against the view’s own layout size', () => {
    // A real cross-check, not a skip: the first test reads the size out of the view's
    // own document, and this one compares it with the rectangle the shell published.
    // (Electron exposes no CDP command for a native view's screen position, so the
    // size is the part of "where the view is" that can be observed from both ends —
    // see `viewLayoutSize`.)
    console.log('RAW view size read back from the view itself: ' + JSON.stringify(viewSizeReadBack))
    console.log('RAW rectangle the shell applied: ' + JSON.stringify(placedOnPanel?.applied))
    expect(placedOnPanel, 'the first test must have placed the view on the panel rectangle').toBeDefined()
    expect(viewSizeReadBack, 'the first test must have read the view’s own layout size').toBeDefined()
    expect(viewSizeReadBack?.css).toEqual({
      width: placedOnPanel?.applied?.width,
      height: placedOnPanel?.applied?.height,
    })
    expect(viewSizeReadBack?.inner).toEqual(viewSizeReadBack?.css)
    expect(shell.alive()).toBe(true)
  })
})
