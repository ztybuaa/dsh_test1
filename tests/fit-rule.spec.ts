import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './shell-harness.ts'

/**
 * 票 #19 的**规则本身**：不需要 electron、不需要浏览器、不需要外壳。
 *
 * 这一份量的是"判断对不对"，`tests/fit-to-pane.spec.ts` 量的是"装到真外壳上是不是那样"。
 * 两个都要：前者能在几百毫秒里把每一种页面形态（固定宽度、响应式、跟着视口溢出的）
 * 逐条走一遍，后者才答得了"用户在窗格里看到什么"。
 *
 * ## 这里最重要的三条
 *
 * 1. **收敛**：拿一个"布局视口 = 栏宽 / zoom"的模型（ADR-0013 实测过这条关系）真的迭代，
 *    数它几步停、停在哪个值上；不是拿眼睛看规则"应该"收敛。
 * 2. **响应式页面一步都不动**：同一个模型，宽度是视口的函数 ⇒ 数它动了几次（必须是 0）。
 * 3. **不会慢慢漂**：一个"永远宽 1px"的页面（取整噪声的形状）不许被一路缩下去 ——
 *    这条是票面点名"极其重要"的那条禁止事项。
 */

const require = createRequire(import.meta.url)
const fit = require(join(REPO_ROOT, 'shell', 'fit.js')) as {
  MAX_STEPS: number
  MAX_ZOOM: number
  MIN_ZOOM: number
  contentTracksViewport: (
    previous: { viewport: number; contentWidth: number } | undefined,
    current: { viewport: number; contentWidth: number } | undefined,
  ) => boolean
  effectiveContentWidth: (input: {
    clientWidth: unknown
    scrollWidth: unknown
    contentWidth?: unknown
  }) => { clientWidth: number; scrollWidth: number; contentWidth: number; overflowing: boolean; overflow: number } | undefined
  nextFitZoom: (input: {
    zoom: unknown
    clientWidth: unknown
    scrollWidth: unknown
    contentWidth?: unknown
  }) => {
    zoom: number | null
    contentWidth: number
    overflowing: boolean
    overflow: number
    ratio?: number
    reason: string
    capped?: string
  }
  overflowSample: (input: { clientWidth: unknown; scrollWidth: unknown }) => { viewport: number; contentWidth: number } | undefined
}

/**
 * 一个**页面模型**：给定栏宽（CSS 像素）与缩放，算出页面会报的那两个宽度。
 *
 * `layoutViewport = paneWidth / zoom` 是 ADR-0013 量出来的那条关系（真外壳上的读数：
 * zoom=0.5 时 620 的栏报 `innerWidth = 1240`）。`scrollWidth` 按同一份实测取
 * `max(内容宽度, 布局视口)` —— 关键的一条：**它不会小于视口**。
 *
 * @param contentWidth - 内容宽度：常数 = 固定宽度排版；函数 = 跟着视口走。
 * @returns 一个 `{read}` 页面替身。
 */
function pageModel(contentWidth: number | ((viewport: number) => number), scrollbar = 0) {
  return {
    read(paneWidth: number, zoom: number): { clientWidth: number; scrollWidth: number } {
      const viewport = Math.floor(paneWidth / zoom) - scrollbar
      const content = typeof contentWidth === 'function' ? contentWidth(viewport) : contentWidth
      return { clientWidth: viewport, scrollWidth: Math.max(Math.floor(content), viewport) }
    },
  }
}

/**
 * 真的把规则跑一遍，直到它停手（或撞上上限）。
 *
 * 每一步都照着 `shell/main.js` 那个循环的语义做：读 → 算 → 改 → 再读（改完的读数才看得见
 * 新布局）。而 `remembered`（这一页曾经有多宽）与 `sample`（上一份溢出样本）**跟着页面走**，
 * 不跟着某一次调用走 —— 外壳里它们挂在那条空间记录上，属于**当前这份文档**（换页清空）。
 * 这一条很重要：把它们每次重置的话，"栏拖宽了回到 100%"与"1px 噪声不许累积"这两条
 * 都会被测成假的（第一版就是这么红的）。
 *
 * @param page - 页面模型。
 * @returns 一个带状态的适配器。
 */
function fitter(page: ReturnType<typeof pageModel>) {
  let remembered = 0
  let sample: { viewport: number; contentWidth: number } | undefined
  let declined: string | undefined
  return {
    /** 在某个栏宽下把这件事跑到停手。 */
    walk(paneWidth: number, startZoom: number): { steps: number[]; final: { zoom: number; seen: { clientWidth: number; scrollWidth: number } }; held: string } {
      let zoom = startZoom
      const steps: number[] = []
      for (let round = 0; round < 40; round += 1) {
        let changedThisRound = 0
        let held = declined ?? ''
        if (declined !== undefined) return { steps, final: { zoom, seen: page.read(paneWidth, zoom) }, held }
        for (let step = 1; step <= fit.MAX_STEPS; step += 1) {
          const seen = page.read(paneWidth, zoom)
          const now = fit.overflowSample(seen)
          if (now !== undefined) {
            if (fit.contentTracksViewport(sample, now)) {
              declined = 'this page follows its viewport, so zooming cannot fix its overflow'
              zoom = 1
              return { steps, final: { zoom, seen: page.read(paneWidth, zoom) }, held: declined }
            }
            sample = now
            remembered = Math.max(remembered, now.contentWidth)
          }
          const decision = fit.nextFitZoom({ zoom, ...seen, contentWidth: remembered })
          if (decision.zoom === null) {
            held = decision.reason
            break
          }
          zoom = decision.zoom
          steps.push(zoom)
          changedThisRound += 1
        }
        if (changedThisRound === 0) return { steps, final: { zoom, seen: page.read(paneWidth, zoom) }, held }
      }
      return { steps, final: { zoom, seen: page.read(paneWidth, zoom) }, held: 'unbounded' }
    },
    get declined(): string | undefined {
      return declined
    },
  }
}

/** 同一段拖动里的值差小于这个数就算同一档（页面报的宽度是整数，量化噪声就是这个量级）。 */
const SAME_STEP = 0.005

describe('票 #19 · 自动适配的规则（纯逻辑，不需要外壳）', () => {
  it('固定宽度页面：几步之内收敛到"刚好塞下"，而且不 overshoot', () => {
    // 内容写死 1200px（夹具页就是这一种），栏 620。
    const fitterUnderTest = fitter(pageModel(1200))
    const walked = fitterUnderTest.walk(620, 1)
    console.log('RAW 固定宽度 1200 在 620 的栏里: ' + JSON.stringify(walked))
    expect(walked.steps.length, 'it must converge, and in a bounded number of changes').toBeLessThanOrEqual(fit.MAX_STEPS)
    expect(walked.steps.length).toBeGreaterThan(0)
    // 收在"内容宽度 == 布局视口"上：这正是"刚好塞下"。
    expect(walked.final.seen.scrollWidth).toBeLessThanOrEqual(walked.final.seen.clientWidth)
    expect(walked.final.zoom).toBeCloseTo(620 / 1200, 2)
    // 单调：一路上只会越缩越小，不会来回跳（`SAME_STEP` 以内算同一档 —— 页面报的宽度是整数，
    // 量化本身就会让目标值差千分之一，那不是震荡）。
    for (let index = 1; index < walked.steps.length; index += 1) {
      expect(walked.steps[index]).toBeLessThanOrEqual(walked.steps[index - 1] + SAME_STEP)
    }
  })

  it('固定宽度页面：栏拖宽之后回到 100%（缩下去回不来是不行的）', () => {
    const fitterUnderTest = fitter(pageModel(1200))
    const narrowed = fitterUnderTest.walk(620, 1).final.zoom // 先缩到刚好塞下
    // 栏拖回 1240：从那个缩小值出发，规则必须把它抬回去。
    const widened = fitterUnderTest.walk(1240, narrowed)
    console.log('RAW 620 → 1240: ' + JSON.stringify({ narrowed, widened }))
    expect(widened.final.zoom).toBeCloseTo(1, 3)
    // 再拖窄一次：又是同一条路，值也一样（"按同一规则重新适配"）。
    const again = fitterUnderTest.walk(620, widened.final.zoom)
    expect(again.final.zoom).toBeCloseTo(narrowed, 2)
  })

  it('响应式页面：一步都不动（跑了，但改的次数是 0）', () => {
    // 宽度是视口的函数：栏怎么变它都跟着变，永远没有横向溢出。
    const page = pageModel((viewport) => viewport)
    const fitterUnderTest = fitter(page)
    let zoom = 1
    const changes: number[] = []
    for (const pane of [1226, 900, 620, 420, 620, 900, 1226, 300]) {
      const walked = fitterUnderTest.walk(pane, zoom)
      changes.push(walked.steps.length)
      zoom = walked.final.zoom
      expect(walked.final.seen.scrollWidth, `a responsive page must never report overflow (pane ${pane})`).toBe(
        walked.final.seen.clientWidth,
      )
    }
    console.log('RAW 响应式页面来回拖 8 次，每一步改了几次: ' + JSON.stringify({ changes, zoom }))
    expect(changes.every((count) => count === 0), 'a responsive page gives the fit nothing to correct').toBe(true)
    expect(zoom).toBe(1)
  })

  it('取整噪声不会累积（1px 的差，拖几十次也不许把它缩小）', () => {
    // 一个"永远比视口宽 1px"的页面：跟着视口走的溢出，缩放治不了它。
    const page = pageModel((viewport) => viewport + 1)
    const fitterUnderTest = fitter(page)
    let zoom = 1
    for (let round = 0; round < 30; round += 1) {
      const pane = 620 + (round % 5) * 137
      zoom = fitterUnderTest.walk(pane, zoom).final.zoom
    }
    console.log('RAW 30 轮之后那个"永远宽 1px"的页面: ' + JSON.stringify({ zoom, declined: fitterUnderTest.declined }))
    expect(zoom, 'a 1px rounding artifact must not shrink the page at all').toBe(1)
    expect(fitterUnderTest.declined, 'and it must be able to say why it stopped').toBeDefined()
  })

  it('内容宽度抖 1px 的固定宽度页面，不许被误判成"治不了"（一套跑的时候踩过这一次）', () => {
    /*
     * 这一条是一个**真跑出来的回归**：整套跑的时候，"不震荡"那条用例里页面被一路适配到 0.538
     * 之后又跳回 100%，而栏早就到了 620 —— 原因是"内容跟着视口走"的判据把一次抖动当成了证据：
     * 页面报的内容宽度在 1199 / 1200 之间抖（真外壳上量到过，因为内容宽度是 1199.98 那种数），
     * 而拖动中"视口差 1px"很常见（适配改的缩放刚好抵消掉栏的移动）。
     * 于是 `Δ视口 = 1, Δ内容 = 1` 被判成"跟着走" ⇒ 页面被判"治不了"、缩放被放回 100%、
     * 而且这份文档此后不再适配。
     *
     * 判据要的是**明确的**信号（`MIN_VIEWPORT_DELTA = 8`），所以这一条必须绿：
     * 一次细粒度的拖动之后，页面收在"刚好塞下"，而且从来没有被判过"治不了"。
     */
    let reads = 0
    const jittery = {
      read(paneWidth: number, zoom: number): { clientWidth: number; scrollWidth: number } {
        const viewport = Math.floor(paneWidth / zoom)
        // 内容固定在 1200 附近，读出来在两个整数之间抖 —— 就是取整噪声的形状。
        const content = reads++ % 2 === 0 ? 1200 : 1199
        return { clientWidth: viewport, scrollWidth: Math.max(content, viewport) }
      },
    }
    const fitterUnderTest = fitter(jittery)
    let zoom = 1
    for (let pane = 1240; pane >= 620; pane -= 1) {
      zoom = fitterUnderTest.walk(pane, zoom).final.zoom
    }
    const atNarrow = jittery.read(620, zoom)
    console.log(
      'RAW 抖 1px 的固定宽度页面走完一次细粒度拖动: ' +
        JSON.stringify({ zoom, atNarrow, declined: fitterUnderTest.declined }),
    )
    expect(fitterUnderTest.declined, 'a 1px jitter is not evidence that zooming cannot fix the page').toBeUndefined()
    expect(zoom, 'it must end up fitted to the narrow pane, not reverted to 100%').toBeLessThan(0.6)
    expect(atNarrow.scrollWidth).toBeLessThanOrEqual(atNarrow.clientWidth + 1)
  })

  it('跟着视口走的溢出被认出来；固定宽度的不会被误判', () => {
    // 固定宽度：内容常数（真实夹具在两个缩放之间会在 1199/1200 之间抖 1px）⇒ Δ内容 ≈ 0。
    const fixed = fit.contentTracksViewport({ viewport: 620, contentWidth: 1200 }, { viewport: 1226, contentWidth: 1200 })
    const fixedWithJitter = fit.contentTracksViewport(
      { viewport: 1199, contentWidth: 1199 },
      { viewport: 1200, contentWidth: 1200 },
    )
    // 跟着走：Δ内容 == Δ视口（真实夹具：`calc(100% + 40px)` 在两个视口之间差 40）。
    const tracking = fit.contentTracksViewport({ viewport: 620, contentWidth: 660 }, { viewport: 660, contentWidth: 700 })
    // 差得太少时不下结论（那时两种页面看起来一样）—— 这一条是量出来的：门槛设成 1px 时，
    // 上面那个"抖 1px"的固定宽度页面会被误判成"跟着走"，缩放被放回 100% 且此文档不再适配。
    const tooClose = fit.contentTracksViewport({ viewport: 620, contentWidth: 1200 }, { viewport: 623, contentWidth: 1200 })
    // 只有一份样本时也一样：不知道。
    const noSample = fit.contentTracksViewport(undefined, { viewport: 620, contentWidth: 1200 })
    console.log('RAW 两个方向上的判断: ' + JSON.stringify({ fixed, fixedWithJitter, tracking, tooClose, noSample }))
    expect(fixed, 'a fixed-width page keeps its content width while the viewport moves').toBe(false)
    expect(fixedWithJitter, 'a 1px jitter in the reported widths is not evidence of tracking').toBe(false)
    expect(tracking, 'a viewer-tracking page grows with the viewport').toBe(true)
    expect(tooClose, 'a 3px difference is not enough to tell the two apart').toBe(false)
    expect(noSample, 'one sample is not a comparison').toBe(false)
  })

  it('够不到的页面：夹在 25% 上并如实说"再试也没用"，不无限追下去', () => {
    // 5000px 的页面在 620 的栏里：25% 也塞不下。
    const walked = fitter(pageModel(5000)).walk(620, 1)
    console.log('RAW 5000px 在 620 的栏里: ' + JSON.stringify(walked))
    expect(walked.final.zoom).toBeCloseTo(fit.MIN_ZOOM, 3)
    expect(walked.steps.length, 'it must give up instead of walking forever').toBeLessThanOrEqual(fit.MAX_STEPS)
    expect(walked.held.length).toBeGreaterThan(0)
  })

  it('纵向滚动条被算进去：适配之后内容仍然塞得下（不是"少了 15px 就装作塞下了"）', () => {
    // 内容 1200，栏 620，但页面有一条 15px 的纵向滚动条（`clientWidth` 少 15）。
    const walked = fitter(pageModel(1200, 15)).walk(620, 1)
    console.log('RAW 带纵向滚动条: ' + JSON.stringify(walked))
    expect(walked.final.seen.scrollWidth).toBeLessThanOrEqual(walked.final.seen.clientWidth)
    // 而它没有为了那 15px 一路缩下去：收在"内容填满内容盒"那一点上。
    expect(walked.final.seen.clientWidth).toBeGreaterThanOrEqual(1200)
  })

  it('绝不放大：自动适配的上界是 100%', () => {
    // 300px 的内容在任何栏宽下都塞得下 ⇒ 一次都不许动（而 100% 本来就是"不动"）。
    const small = fitter(pageModel(300)).walk(1226, 1)
    console.log('RAW 300px 的内容在 1226 的栏里: ' + JSON.stringify(small))
    expect(small.steps.length, 'nothing to do — a small page must be left alone').toBe(0)
    expect(small.final.zoom).toBe(fit.MAX_ZOOM)
    // 从一个人为缩小过的值出发也一样：它最多抬回到 100%，不会超过。
    //（`remembered` 要先有 —— 只有**曾经溢出过**的页面才知道自己有多宽，见规则的文件头。）
    const fitterUnderTest = fitter(pageModel(1200))
    fitterUnderTest.walk(620, 1) // 这一趟让它溢出过一次，内容宽度被记下来
    const recovered = fitterUnderTest.walk(1226, 0.4)
    console.log('RAW 从 40% 出发、栏够宽: ' + JSON.stringify(recovered))
    expect(recovered.final.zoom).toBeCloseTo(fit.MAX_ZOOM, 3)
    expect(recovered.steps.every((zoom) => zoom <= fit.MAX_ZOOM + 1e-9), 'never above 100%').toBe(true)
  })

  it('两个宽度读不回来时一步都不动（页面正在换文档）', () => {
    const broken = fit.nextFitZoom({ zoom: 1, clientWidth: 0, scrollWidth: 0, contentWidth: 1200 })
    const nan = fit.nextFitZoom({ zoom: 1, clientWidth: Number.NaN, scrollWidth: 1200, contentWidth: 1200 })
    const noZoom = fit.nextFitZoom({ zoom: Number.NaN, clientWidth: 620, scrollWidth: 1200, contentWidth: 1200 })
    console.log('RAW 读不回来的三种形状: ' + JSON.stringify({ broken, nan, noZoom }))
    for (const decision of [broken, nan, noZoom]) {
      expect(decision.zoom).toBeNull()
      expect(decision.reason.length).toBeGreaterThan(0)
    }
  })
})
