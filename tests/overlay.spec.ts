import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  MARK_PLANS,
  OVERLAY_ID,
  OVERLAY_SELECTOR,
  clearOverlay,
  mountOverlay,
  overlayConfig,
  paintOverlay,
  readFlashNeedsSecondPaint,
  withAlpha,
  type OverlayConfig,
  type OverlayKind,
} from '../src/overlay.ts'
import { AdoptedViewSession, SNAPSHOT_SELECTOR, type PageSnapshot } from '../src/session.ts'
import { readPng } from './png-facts.ts'
import { pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T8 seam test: "you can see what the agent is doing, and seeing it does not cost the
 * abilities that were already there".
 *
 * The risk this file exists for is not "the overlay does not draw" — it is that the
 * overlay is injected **into the page**, and that page is at the same time the object of
 * the snapshot (T3), the actions (T4) and the observation (T5). So every acceptance is
 * checked by an *independent* read-back, and each of the four hazards has its own guard:
 *
 *  - pixel facts come from a PNG captured over an independent CDP connection and parsed
 *    here (`tests/png-facts.ts`), never from the implementation's own word;
 *  - "the overlay is really visible" is read from the browser's own animation timeline
 *    (`Element.getAnimations()`) and from what it does to the pixels, not from a class
 *    name the code chose;
 *  - the overlay's presence is read back around every comparison, so no guard can pass by
 *    comparing two states in which the overlay happened to be missing;
 *  - what each hazard *was* measured to be, raw output included, is in
 *    `docs/research/cursor-overlay-and-the-snapshot.md`.
 *
 * Every guard can be falsified: revert the fix it guards and it goes red. Each one was
 * checked that way by hand, and the results are in the T8 report.
 */

/** The viewport the shell gives the native view when no panel has reported a rectangle. */
const VIEW = { width: 440, height: 800 }

/** The colour of the fixture page's `#obs-box`, which must stay findable in the pixels. */
const FIXTURE_BOX_RGB = '47,111,176'

/** What one mark looks like right now, as the page itself reports it. */
interface MarkFacts {
  /** Its class list. */
  className: string
  /** Its rendered rectangle in viewport CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
  /** Whether it covers the whole viewport (a ring) or is a small mark at a point. */
  coversViewport: boolean
  /**
   * The animations really running on it, as the browser's own timeline reports them:
   * `dsh-ripple@700` means "an animation named dsh-ripple, 700ms long".
   */
  animations: string[]
}

/** Everything read back about the overlay from an independent connection. */
interface OverlayFacts {
  /** How many elements carry the overlay id. More than one is a bug. */
  containerCount: number
  /** Whether the container is in the document. */
  present: boolean
  /** Whether it sits inside `document.body` (it must not: `extract` reads body text). */
  insideBody: boolean
  /** Whether it hangs off `document.documentElement` instead. */
  parentIsRoot: boolean
  /** The container's own computed `pointer-events`. */
  pointerEvents: string
  /** `aria-hidden` as the page reports it. */
  ariaHidden: string | null
  /** How many characters of text the whole overlay subtree carries (must be 0). */
  textLength: number
  /** The marks on it, in creation order. */
  marks: MarkFacts[]
}

/** One element of a snapshot, in the shape the comparisons use. */
function shape(snapshot: PageSnapshot): unknown {
  return snapshot.elements.map((element) => ({
    ref: element.ref,
    role: element.role,
    name: element.name,
    state: element.state ?? null,
    bounds: element.bounds,
  }))
}

/** A snapshot element named `name`, or a failure saying what the snapshot did list. */
function named(snapshot: PageSnapshot, name: string): { ref: number; bounds: { x: number; y: number; width: number; height: number } } {
  const element = snapshot.elements.find((candidate) => candidate.name === name)
  if (element === undefined) {
    throw new Error(
      `no snapshot element named ${JSON.stringify(name)}; got: ${snapshot.elements.map((candidate) => candidate.name).join(', ')}`,
    )
  }
  return { ref: element.ref, bounds: element.bounds }
}

/** The centre of a rectangle: the point a pointer action uses. */
function centreOf(bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

/**
 * Read the tags and roles a snapshot selector recognises.
 *
 * The overlay's guard against hazard one has to be phrased in the selector's own terms,
 * so the real selector is split into what it can match rather than restated by hand.
 *
 * @param selector - the selector, as exported by the module that uses it.
 * @returns the tag names and the `role` values it matches.
 */
function tagsAndRolesOf(selector: string): { tags: Set<string>; roles: Set<string> } {
  const tags = new Set<string>()
  const roles = new Set<string>()
  for (const part of selector.split(',')) {
    const piece = part.trim()
    const role = /^\[role="([^"]+)"\]/.exec(piece)
    if (role !== null) {
      roles.add(role[1])
      continue
    }
    const tag = /^([a-z]+)/.exec(piece)
    if (tag !== null) tags.add(tag[1])
  }
  return { tags, roles }
}

/**
 * T8's pure half: what the overlay is made of, with no browser and no Electron.
 *
 * These run on `src/overlay.ts` alone, which is why that module imports neither
 * Playwright nor Electron: the four hazards get a data-level guard that costs
 * milliseconds, and the seam test below only has to confirm what the data promises.
 */
describe('T8 — 覆盖层的数据与画法（不需要 electron）', () => {
  const kinds = Object.keys(MARK_PLANS) as OverlayKind[]

  it('每种标记一处定义：失败与成功的形状不同，常驻的只有“正瞄着这里”', () => {
    console.log('RAW 标记表：' + JSON.stringify(MARK_PLANS))
    expect(kinds).toEqual(['aim', 'point', 'read', 'page', 'failed'])

    // 一个 class 一种标记：样式表与"摘掉同类的旧标记"都靠它认人。
    const classes = kinds.map((kind) => MARK_PLANS[kind].className)
    expect(new Set(classes).size).toBe(kinds.length)

    // 这就是"失败如实反映"的数据层保证：失败是整页一圈，成功是落点上的一个点，
    // 所以"失败被画成成功"在这份数据上不可能发生。
    expect(MARK_PLANS.failed.shape).toBe('ring')
    expect(MARK_PLANS.point.shape).toBe('point')
    expect(MARK_PLANS.failed.color).not.toBe(MARK_PLANS.point.color)
    expect(MARK_PLANS.failed.color).not.toBe(MARK_PLANS.read.color)

    // 常驻的只有光标：其余标记都会自己消失，否则它们会一直叠在后面的每一张截图上。
    expect(MARK_PLANS.aim.lifetimeMs).toBeUndefined()
    for (const kind of kinds) {
      if (kind === 'aim') continue
      expect(MARK_PLANS[kind].lifetimeMs, `${kind} 必须有时长`).toBeGreaterThan(0)
      expect(MARK_PLANS[kind].lifetimeMs, `${kind} 的时长要有界`).toBeLessThanOrEqual(2_000)
    }
  })

  it('样式表：不吃指针事件、一个字的文本都不写、时长与数据同源', () => {
    const css = overlayConfig().css
    console.log('RAW 覆盖层样式表：\n' + css)

    // 坑二：容器与后代都不吃指针事件。
    expect(css).toContain('pointer-events: none')
    expect(css).toContain(`${OVERLAY_SELECTOR} * {`)
    // 坑三：CSS 里也不许造文本（::before/::after 的 content 会变成页面上的字）。
    expect(css).not.toMatch(/\bcontent\s*:/)
    // 悬浮在页面之上，但不参与页面布局、不改底色。
    expect(css).toContain('position: fixed')
    expect(css).toContain('z-index: 2147483647')
    expect(css).toContain('background: transparent')

    for (const kind of kinds) {
      const plan = MARK_PLANS[kind]
      // 每条标记规则都带容器 id 前缀：不带会被 `#id * { border: 0 }` 的权重压掉。
      expect(css, `${kind} 的规则必须带容器 id 前缀`).toContain(`${OVERLAY_SELECTOR} .${plan.className} {`)
      expect(css, `${kind} 的颜色要在样式表里`).toContain(plan.color)
      // 时长只有一处：样式表里的毫秒数就是数据里的毫秒数。
      if (plan.shape === 'ring') expect(css).toContain(`animation: dsh-fade ${String(plan.lifetimeMs)}ms`)
      else if (plan.lifetimeMs !== undefined) expect(css).toContain(`animation: dsh-ripple ${String(plan.lifetimeMs)}ms`)
    }

    // 光标那条规则：是一个箭头，而且**没有**动画（常驻）。
    const aimRule = css.split('\n').find((line) => line.startsWith(`${OVERLAY_SELECTOR} .${MARK_PLANS.aim.className} {`))
    expect(aimRule).toBeDefined()
    expect(aimRule).toContain('clip-path')
    expect(aimRule).not.toContain('animation')
  })

  it('覆盖层造出来的元素不可能匹配快照选择器', () => {
    // 用**真的**那个选择器：抄一份出来比，等于没比。
    const { tags, roles } = tagsAndRolesOf(SNAPSHOT_SELECTOR)
    console.log('RAW 快照选择器认的标签与 role：' + JSON.stringify({ tags: [...tags], roles: [...roles] }))
    expect(tags.size).toBeGreaterThan(0)
    expect(roles.size).toBeGreaterThan(0)

    const config = overlayConfig()
    for (const tag of [config.containerTag, config.markTag]) {
      expect(tags.has(tag), `${tag} 会被快照选择器当成可操作元素（坑一）`).toBe(false)
    }
    // 属性只有 id 与 aria-hidden：没有 role、没有 contenteditable ——
    // 那两条正是"一个普通 div 也能进快照"的路。
    expect(Object.keys(config.containerAttributes).sort()).toEqual(['aria-hidden', 'id'])
    console.log(
      'RAW 覆盖层会创建的东西：' +
        JSON.stringify({
          containerTag: config.containerTag,
          markTag: config.markTag,
          attributes: config.containerAttributes,
          markClasses: kinds.map((kind) => MARK_PLANS[kind].className),
        }),
    )
  })

  it('读取提示要不要在读取结束时补画一次', () => {
    // 读得比提示还快：提示自己会亮完，不用补。
    expect(readFlashNeedsSecondPaint(20, 600)).toBe(false)
    // 读得和提示一样久、或更久：补一次，否则"读完了"没有任何可见的收尾。
    expect(readFlashNeedsSecondPaint(600, 600)).toBe(true)
    expect(readFlashNeedsSecondPaint(30_000, 600)).toBe(true)
  })

  it('颜色换算：给环的内侧辉光算出 rgba', () => {
    expect(withAlpha('#14b8ff', 0.55)).toBe('rgba(20, 184, 255, 0.55)')
    expect(withAlpha('#ff3b30', 0.55)).toBe('rgba(255, 59, 48, 0.55)')
    expect(withAlpha('#fff', 1)).toBe('rgba(255, 255, 255, 1)')
  })

  it('页面里那三段代码只靠 config：能被解析，且不引用模块常量', () => {
    // `page.evaluate` / `addInitScript` 只把函数**源码**送进页面，模块里的常量在那里
    // 是 ReferenceError。这条检查不启动浏览器就能挡住那一类错误。
    const moduleNames = [
      'MARK_PLANS',
      'OVERLAY_ID',
      'OVERLAY_SELECTOR',
      'overlayConfig',
      'overlayStyleSheet',
      'readFlashNeedsSecondPaint',
      'withAlpha',
    ]
    for (const [name, fn] of [
      ['mountOverlay', mountOverlay],
      ['paintOverlay', paintOverlay],
      ['clearOverlay', clearOverlay],
    ] as const) {
      const source = fn.toString()
      expect(() => new Function(`return (${source})`), `${name} 的源码不能被解析`).not.toThrow()
      for (const forbidden of moduleNames) {
        expect(source, `${name} 引用了模块常量 ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\b`))
      }
      expect(source, `${name} 应该从 config 拿数据`).toContain('config')
    }
  })
})

describe('T8 — 光标覆盖层与页面（真外壳）', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /** An independent connection to the same view: used to read the page for itself. */
  let probe: { browser: { close: () => Promise<void> }; page: Page }
  let screenshotDir: string
  const config: OverlayConfig = overlayConfig()

  beforeAll(async () => {
    screenshotDir = mkdtempSync(join(tmpdir(), 'dsh-t8-screenshots-'))
    shell = await startShell()
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
    })
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
  }, 120_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.browser.close().catch(() => undefined)
    if (session !== undefined) await session.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    // 清理绝不决定结果：一次 EPERM 会让"用例全过"的 spec 文件报红，见 removeWhenFree 的注释。
    if (screenshotDir !== undefined) removeWhenFree(screenshotDir)
  })

  const url = (path: string): string => `${shell.handshake.fixtureOrigin}${path}`

  /** Read the overlay for itself, over the independent connection. */
  const overlayFacts = async (): Promise<OverlayFacts> =>
    (await probe.page.evaluate((id) => {
      const layer = document.getElementById(id)
      const marks =
        layer === null
          ? []
          : [...layer.children].map((child) => {
              const box = child.getBoundingClientRect()
              return {
                className: child.className,
                rect: { x: box.x, y: box.y, width: box.width, height: box.height },
                coversViewport: box.width >= window.innerWidth - 1 && box.height >= window.innerHeight - 1,
                animations: child.getAnimations().map((animation) => {
                  const name = (animation as unknown as { animationName?: string }).animationName ?? 'non-css'
                  return `${name}@${String(animation.effect?.getTiming().duration)}`
                }),
              }
            })
      return {
        containerCount: document.querySelectorAll(`#${id}`).length,
        present: layer !== null,
        insideBody: layer !== null && document.body.contains(layer),
        parentIsRoot: layer !== null && layer.parentElement === document.documentElement,
        pointerEvents: layer === null ? '' : getComputedStyle(layer).pointerEvents,
        ariaHidden: layer === null ? null : layer.getAttribute('aria-hidden'),
        textLength: layer === null ? 0 : (layer.textContent ?? '').length,
        marks,
      }
    }, OVERLAY_ID)) as OverlayFacts

  /** Take the overlay out of the document entirely — the "no overlay" control. */
  const removeOverlay = async (): Promise<void> => {
    await probe.page.evaluate((id) => {
      const layer = document.getElementById(id)
      const style = layer?.previousElementSibling ?? null
      if (style !== null && style.tagName === 'STYLE') style.remove()
      layer?.remove()
    }, OVERLAY_ID)
  }

  /** Take the marks off, leaving the container: a deterministic "nothing is drawn". */
  const clearMarks = async (): Promise<void> => {
    await probe.page.evaluate(clearOverlay, config)
  }

  /** What the page renders, read over the independent connection. */
  const pageInnerText = async (): Promise<string> => (await probe.page.evaluate(() => document.body.innerText)) as string

  /**
   * What the **whole document** renders, as `document.documentElement.innerText` defines it.
   *
   * Strictly wider than the body read `browser_extract` uses, which is the point: an
   * overlay that put text anywhere a reader of this document could see it would show up
   * here even in the case where `body.innerText` happens not to include it.
   */
  const documentInnerText = async (): Promise<string> =>
    (await probe.page.evaluate(() => document.documentElement.innerText)) as string

  /** What the page says is the topmost element at a point. */
  const hitAt = async (point: { x: number; y: number }): Promise<string | null> =>
    (await probe.page.evaluate((at) => {
      const landed = document.elementFromPoint(at.x, at.y)
      return landed === null ? null : `${landed.tagName.toLowerCase()}#${landed.id}`
    }, point)) as string | null

  /**
   * Take one screenshot over the independent connection.
   *
   * Measured (`docs/research/cdp-screenshot-stall.md`, and again for T8): a lone capture
   * waits indefinitely and the very next one answers in ~0.1s, so a capture is retried
   * rather than given one long bound. Firing two concurrently does **not** unblock them
   * over Playwright here (also measured).
   */
  const capture = async (): Promise<Buffer> => {
    let last: unknown
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await probe.page.screenshot({ type: 'png', timeout: 3_000 })
      } catch (error) {
        last = error
      }
    }
    throw new Error(`no screenshot in 4 attempts: ${String(last)}`)
  }

  /**
   * Capture a frame while keeping a transient mark repainted, so the frame shows it.
   *
   * This is a fact about the *observation*, not about the implementation: measured, a
   * frame on this host can be produced more than a second after the capture is requested,
   * by which time a 600ms flash has faded and removed itself — the mark really was on
   * screen, the camera was simply late. Repainting restarts the animation, so whenever
   * the frame lands the mark is young. The implementation stays "light up once and go
   * away"; only the reading is made patient.
   */
  const captureWhileRepainting = async (kind: OverlayKind, point?: { x: number; y: number }): Promise<Buffer> => {
    let last: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pending = probe.page.screenshot({ type: 'png', timeout: 4_000 })
      let shot: Buffer | undefined
      let failure: unknown
      void pending.then(
        (bytes) => {
          shot = bytes
        },
        (error: unknown) => {
          failure = error
        },
      )
      const started = Date.now()
      let repaints = 0
      while (shot === undefined && failure === undefined && Date.now() - started < 15_000) {
        await probe.page.evaluate(paintOverlay, point === undefined ? { config, kind } : { config, kind, point })
        repaints += 1
        await new Promise((settle) => setTimeout(settle, 120))
      }
      if (shot !== undefined) {
        console.log(`RAW 拍到 ${kind}：重画 ${String(repaints)} 次，${String(Date.now() - started)}ms，第 ${String(attempt)} 发`)
        return shot
      }
      last = failure
    }
    throw new Error(`no frame while repainting ${kind}: ${String(last)}`)
  }

  /** Fail one action and hand back what it said, without letting the failure escape. */
  const refusal = async (run: () => Promise<unknown>): Promise<{ reason?: string; message?: string }> =>
    (await run().then(
      () => ({ reason: undefined, message: undefined }),
      (error: { reason?: string; message?: string }) => ({ reason: error.reason, message: error.message }),
    )) as { reason?: string; message?: string }

  it('坑一：覆盖层存在时，快照的元素集合与它不存在时逐项一致', async () => {
    await session.goto(url('/snapshot'))

    const beforeSnapshot = await overlayFacts()
    const withOverlay = await session.snapshot()
    const afterSnapshot = await overlayFacts()
    console.log('RAW 覆盖层在不在（两次快照之间）：' + JSON.stringify({ before: beforeSnapshot, after: afterSnapshot }))

    // 非空洞：这一份快照确实是在**覆盖层挂着**的时候读的。
    expect(beforeSnapshot.present, '快照时覆盖层必须在').toBe(true)
    expect(beforeSnapshot.containerCount).toBe(1)
    expect(afterSnapshot.present).toBe(true)

    // 另一份：把覆盖层整个从文档里摘掉再读（画笔不负责挂载，所以它不会自己回来）。
    await removeOverlay()
    const withoutOverlay = await session.snapshot()
    const gone = await overlayFacts()
    console.log('RAW 覆盖层在不在（摘掉之后）：' + JSON.stringify(gone))
    expect(gone.present, '对照组的覆盖层必须真的不在，否则这条比对没有意义').toBe(false)

    console.log('RAW 有覆盖层的快照：' + JSON.stringify(shape(withOverlay)))
    console.log('RAW 无覆盖层的快照：' + JSON.stringify(shape(withoutOverlay)))
    expect(withOverlay.elements.length).toBeGreaterThan(0)
    expect(shape(withOverlay)).toEqual(shape(withoutOverlay))

    // 再用**引擎自己的选择器**独立数一遍：快照说的数、选择器数的数、以及"其中几个落在
    // 覆盖层里"，三者对上才算数。
    await session.goto(url('/snapshot'))
    const mountedAgain = await overlayFacts()
    expect(mountedAgain.present, '导航之后覆盖层要自己回来，下面这条计数才不是空转').toBe(true)
    const matched = await probe.page.locator(SNAPSHOT_SELECTOR).count()
    const insideOverlay = await probe.page
      .locator(SNAPSHOT_SELECTOR)
      .evaluateAll((nodes, id) => nodes.filter((node) => node.closest(`#${id}`) !== null).length, OVERLAY_ID)
    const listed = (await session.snapshot()).elements.length
    console.log(
      'RAW 引擎选择器：匹配 ' + String(matched) + '，其中落在覆盖层里 ' + String(insideOverlay) + '；快照列出 ' + String(listed),
    )
    expect(matched).toBe(listed)
    expect(insideOverlay, '覆盖层里的元素一个都不该被选择器认出来').toBe(0)
  })

  it('坑二：覆盖层不吃指针事件，四类失败原因一个都没变', async () => {
    await session.goto(url('/interact'))
    await probe.page.evaluate(mountOverlay, config)
    const snapshot = await session.snapshot()
    const alpha = named(snapshot, 'alpha')
    const alphaCentre = centreOf(alpha.bounds)

    const container = await overlayFacts()
    console.log('RAW 覆盖层容器：' + JSON.stringify(container))
    expect(container.pointerEvents).toBe('none')

    // 最强的形状：一个**铺满整页的环**加一个**正好压在按钮中心的光标**，
    // 再看这个点上最上面的是谁。
    await probe.page.evaluate(paintOverlay, { config, kind: 'failed' })
    await probe.page.evaluate(paintOverlay, { config, kind: 'aim', point: alphaCentre })
    const covered = await overlayFacts()
    console.log('RAW 光标与环都画上时覆盖层的 marks：' + JSON.stringify(covered.marks))
    expect(covered.marks.length).toBeGreaterThanOrEqual(2)
    console.log('RAW 覆盖层正压在按钮中心时该点的命中：' + JSON.stringify(await hitAt(alphaCentre)))
    expect(await hitAt(alphaCentre), '覆盖层不能成为命中目标').toBe('button#act-alpha')

    // 点击仍然落到真按钮上，效果由页面自己写出来。
    await session.clickRef(alpha.ref)
    const effect = await probe.page.evaluate(() => document.getElementById('act-effect')?.textContent ?? null)
    console.log('RAW 覆盖层盖着时点 alpha，页面自己的效果：' + JSON.stringify(effect))
    expect(effect).toBe('alpha-clicked')

    // 四类失败原因：timeout / obscured / not-visible / not-found，一个都不能被覆盖层带偏。
    // 每个触发器与它的目标 ref 都在动手前先取好（ref 钉住节点，页面变化不会让它换人）。
    const fresh = await session.snapshot()
    const hider = named(fresh, 'hide the target').ref
    const hiddenTarget = named(fresh, 'hide target').ref
    const remover = named(fresh, 'remove the target').ref
    const doomed = named(fresh, 'remove target').ref

    const timedOut = await refusal(() => session.wait({ selector: '#act-never', timeoutMs: 700 }))
    const obscured = await refusal(() => session.clickRef(named(fresh, 'blocked control').ref))
    await session.clickRef(hider)
    const invisible = await refusal(() => session.clickRef(hiddenTarget))
    await session.clickRef(remover)
    const missing = await refusal(() => session.clickRef(doomed))
    console.log(
      'RAW 覆盖层在场时的四类失败原因：' +
        JSON.stringify({ timedOut, obscured, invisible, missing }),
    )
    expect(timedOut.reason).toBe('timeout')
    expect(obscured.reason).toBe('obscured')
    // 遮挡者仍然是页面里那个 div，不是覆盖层 —— 这条正是"覆盖层污染 obscured"的反例。
    expect(obscured.message).toContain('act-blocker')
    expect(obscured.message).not.toContain(OVERLAY_ID)
    expect(invisible.reason).toBe('not-visible')
    expect(missing.reason).toBe('not-found')
  })

  it('坑三：覆盖层不往页面里塞文本，extract 仍与页面 innerText 逐字一致', async () => {
    await session.goto(url('/observe'))
    await probe.page.evaluate(mountOverlay, config)

    const clean = await pageInnerText()
    const wholeClean = await documentInnerText()
    // 把每一种标记都画一遍（含没有文字的环）。
    for (const kind of ['read', 'page', 'failed'] as const) {
      await probe.page.evaluate(paintOverlay, { config, kind })
    }
    await probe.page.evaluate(paintOverlay, { config, kind: 'aim', point: { x: 60, y: 90 } })
    await probe.page.evaluate(paintOverlay, { config, kind: 'point', point: { x: 60, y: 90 } })
    const painted = await pageInnerText()
    const wholePainted = await documentInnerText()
    const facts = await overlayFacts()
    const extracted = await session.extractText()

    console.log('RAW 覆盖层容器（画满标记时）：' + JSON.stringify(facts))
    console.log(
      'RAW innerText 与 extract：' +
        JSON.stringify({
          cleanChars: clean.length,
          paintedChars: painted.length,
          wholeClean: wholeClean.length,
          wholePainted: wholePainted.length,
          extractChars: extracted.text.length,
          extractTotal: extracted.totalChars,
        }),
    )

    // 结构性事实：不在 body 里、子树里一个字符都没有。
    expect(facts.present).toBe(true)
    expect(facts.insideBody).toBe(false)
    expect(facts.parentIsRoot).toBe(true)
    expect(facts.textLength).toBe(0)
    // ……所以整篇文档渲染出来的文本也没多一个字（比 body 那一读更宽的一条）。
    expect(wholePainted).toBe(wholeClean)

    // 于是 body 自己的文本一字不动，extract 仍然与它逐字一致。
    expect(painted).toBe(clean)
    expect(extracted.text).toBe(painted)
    expect(extracted.truncated).toBe(false)
    expect(extracted.totalChars).toBe(painted.length)

    // 最直接的一条：把整个覆盖层摘掉再读一次。两边页面渲染出来的文本必须逐字相同 ——
    // 覆盖层对"这一页的文本"的贡献是零，所以 extract 那条断言一个字都不用放宽。
    await removeOverlay()
    const without = await pageInnerText()
    console.log('RAW 有覆盖层/无覆盖层的 innerText 字符数：' + JSON.stringify({ painted: painted.length, without: without.length }))
    expect(without).toBe(painted)
  })

  it('验收一：点击时页面上出现可见光标与涟漪', async () => {
    await session.goto(url('/observe'))
    const snapshot = await session.snapshot()
    const target = named(snapshot, 'hit me')
    const centre = centreOf(target.bounds)

    // 点它（夹具：点它会写出 observe-clicked）。
    await clearMarks()
    await session.clickRef(target.ref)

    // 读回一：页面上真的有东西了，而且真的落在那次点击的点上。
    const facts = await overlayFacts()
    console.log('RAW 点击之后的覆盖层：' + JSON.stringify(facts))
    const aim = facts.marks.find((mark) => mark.className === MARK_PLANS.aim.className)
    const ripple = facts.marks.find((mark) => mark.className === MARK_PLANS.point.className)
    expect(aim, '点击后必须留下一个可见光标').toBeDefined()
    expect(Math.abs((aim as MarkFacts).rect.x - centre.x)).toBeLessThan(1)
    expect(Math.abs((aim as MarkFacts).rect.y - centre.y)).toBeLessThan(1)
    // 涟漪：浏览器自己的动画时间线上真的有一条在跑，而且它就是那个 700ms 的动画。
    expect(ripple, '点击瞬间必须有一条涟漪').toBeDefined()
    expect((ripple as MarkFacts).animations.join(' ')).toContain(`dsh-ripple@${String(MARK_PLANS.point.lifetimeMs)}`)
    console.log('RAW 点击后涟漪的动画时间线：' + JSON.stringify((ripple as MarkFacts).animations))

    // 读回二：像素。基准是"同一个页面状态、把标记清掉"的那一张 —— 点击自己的页面效果
    // （obs-effect 的文字）在两张图里都一样，所以差出来的只能是覆盖层。
    const point = { x: centre.x * 1.5, y: centre.y * 1.5 }
    const marked = readPng(await captureWhileRepainting('point', centre))
    await clearMarks()
    const bare = readPng(await capture())
    const local = bare.diffFrom(marked)
    console.log(
      'RAW 点击标记的像素差：' + JSON.stringify(local) + '，落点设备坐标 ' + JSON.stringify(point),
    )
    expect(local.changed).toBeGreaterThan(0)
    expect(local.box).not.toBeNull()
    expect((local.box as { left: number }).left).toBeGreaterThan(point.x - 60)
    expect((local.box as { right: number }).right).toBeLessThan(point.x + 60)
    expect((local.box as { top: number }).top).toBeGreaterThan(point.y - 60)
    expect((local.box as { bottom: number }).bottom).toBeLessThan(point.y + 60)
    // 页面自己的效果：这一下真的点到了，覆盖层没有把它吃掉。
    expect(await probe.page.evaluate(() => document.getElementById('obs-effect')?.textContent ?? null)).toBe('observe-clicked')
  })

  it('验收二：读页面时有可见提示', async () => {
    await session.goto(url('/observe'))
    await clearMarks()
    const bare = readPng(await capture())

    // 快照就是"读"：读的时候页面上要有一圈可见的提示。
    await session.snapshot()
    const facts = await overlayFacts()
    console.log('RAW 快照之后的覆盖层：' + JSON.stringify(facts))
    const flash = facts.marks.find((mark) => mark.className === MARK_PLANS.read.className)
    expect(flash, '读取时必须有可见提示').toBeDefined()
    // 它是整页一圈（不是给每个元素画框），而且浏览器自己说那条淡出动画在跑。
    expect((flash as MarkFacts).coversViewport).toBe(true)
    expect((flash as MarkFacts).animations.join(' ')).toContain(`dsh-fade@${String(MARK_PLANS.read.lifetimeMs)}`)
    // 它一个字都没有（坑三），所以"可见提示"不可能变成页面文本。
    expect(facts.textLength).toBe(0)

    // 读回二：像素。一圈边（角落变色）、页面正中不变 —— 它是边，不是蒙一层。
    // 拍的时候把标记重画着：这一台机器上"产出那一帧"可能比动画还晚（探针第 5 节）。
    await clearMarks()
    const reading = readPng(await captureWhileRepainting('read'))
    const corner = reading.rgbAt(2, 2)
    const centre = reading.rgbAt(Math.floor(reading.width / 2), Math.floor(reading.height / 2))
    console.log(
      'RAW 读提示的像素：' +
        JSON.stringify({ corner, cornerRest: bare.rgbAt(2, 2), centre, centreRest: bare.rgbAt(Math.floor(bare.width / 2), Math.floor(bare.height / 2)) }),
    )
    expect(corner).not.toBe(bare.rgbAt(2, 2))
    expect(centre, '提示是视口边缘的一圈，不该盖住页面正中').toBe(bare.rgbAt(Math.floor(bare.width / 2), Math.floor(bare.height / 2)))
    const [red, , blue] = (corner as string).split(',').map(Number)
    expect(blue, '读取提示是冷色，与失败的红色分得开').toBeGreaterThan(red)
    expect(bare.diffFrom(reading).changed).toBeGreaterThan(0)
  })

  it('验收三：真实导航之后覆盖层自动重挂，且重挂后三条守卫仍然成立', async () => {
    await session.goto(url('/snapshot'))
    const before = await overlayFacts()
    expect(before.present).toBe(true)
    // 给旧文档的容器盖个戳：新文档里这个戳必须消失，才证明那是**新挂的**一份，
    // 而不是上一层文档留下的什么东西。
    await probe.page.evaluate((id) => {
      const layer = document.getElementById(id)
      if (layer !== null) layer.setAttribute('data-dsh-probe-stamp', 'old-document')
    }, OVERLAY_ID)
    const stamped = await probe.page.evaluate((id) => document.getElementById(id)?.getAttribute('data-dsh-probe-stamp') ?? null, OVERLAY_ID)
    expect(stamped).toBe('old-document')
    const tokenBefore = await probe.page.evaluate(() => String(performance.timeOrigin))

    // 真导航：点 `to other` 这个链接（不是 pushState）。
    const snapshot = await session.snapshot()
    await session.clickRef(named(snapshot, 'to other').ref)
    await probe.page.waitForFunction((previous) => String(performance.timeOrigin) !== previous, tokenBefore, { timeout: 10_000 })

    const after = await overlayFacts()
    const stamp = await probe.page.evaluate((id) => document.getElementById(id)?.getAttribute('data-dsh-probe-stamp') ?? null, OVERLAY_ID)
    const where = await probe.page.evaluate(() => location.pathname)
    console.log('RAW 真导航之后的覆盖层：' + JSON.stringify({ after, stamp, where }))
    expect(where).toBe('/other')
    expect(after.present, '导航之后覆盖层必须自己回来').toBe(true)
    expect(after.containerCount).toBe(1)
    expect(stamp, '新文档里的容器必须是新挂的，不带旧文档的戳').toBeNull()
    expect(after.insideBody).toBe(false)
    expect(after.pointerEvents).toBe('none')

    // 重挂之后，坑一与坑三的守卫在**新文档**里仍然成立。
    const withOverlay = await session.snapshot()
    await removeOverlay()
    const withoutOverlay = await session.snapshot()
    console.log('RAW 重挂后的快照逐项一致：' + String(JSON.stringify(shape(withOverlay)) === JSON.stringify(shape(withoutOverlay))))
    expect(shape(withOverlay)).toEqual(shape(withoutOverlay))
    expect((await session.extractText()).text).toBe(await pageInnerText())

    // 同文档导航（pushState）**不该**重挂，也不该多出第二个容器。
    await session.goto(url('/snapshot'))
    await probe.page.evaluate((id) => {
      const layer = document.getElementById(id)
      if (layer !== null) layer.setAttribute('data-dsh-probe-stamp', 'same-document')
    }, OVERLAY_ID)
    const pushed = await session.snapshot()
    await session.clickRef(named(pushed, 'push state').ref)
    const sameDocument = await overlayFacts()
    const sameStamp = await probe.page.evaluate((id) => document.getElementById(id)?.getAttribute('data-dsh-probe-stamp') ?? null, OVERLAY_ID)
    console.log('RAW pushState 之后的覆盖层：' + JSON.stringify({ sameDocument, sameStamp }))
    expect(sameDocument.containerCount, 'pushState 不该挂出第二个容器').toBe(1)
    expect(sameStamp, 'pushState 是同文档导航，覆盖层该原样留着').toBe('same-document')
  })

  it('失败如实反映：动作失败时画的是失败标记，不是成功标记', async () => {
    await session.goto(url('/interact'))
    const snapshot = await session.snapshot()
    await clearMarks()
    const bare = readPng(await capture())

    // 一次**失败**的动作：被 #act-blocker 盖住的那个按钮。
    const refused = await refusal(() => session.clickRef(named(snapshot, 'blocked control').ref))
    expect(refused.reason).toBe('obscured')

    const facts = await overlayFacts()
    console.log('RAW 失败动作之后的覆盖层：' + JSON.stringify(facts))
    const failed = facts.marks.find((mark) => mark.className === MARK_PLANS.failed.className)
    const ripple = facts.marks.find((mark) => mark.className === MARK_PLANS.point.className)
    const aim = facts.marks.find((mark) => mark.className === MARK_PLANS.aim.className)
    expect(failed, '失败必须有失败标记').toBeDefined()
    expect(ripple, '失败绝不能画成成功（涟漪是"落地了"的意思）').toBeUndefined()
    // 被拒绝的动作**没有真的瞄过**（遮挡是在动手之前判出来的），所以也不该冒出一个
    // 光标来声称 Agent 指过那里。光标因此有个不变式：它只在真的动过手的地方出现。
    expect(aim, '被拒绝的动作不该画出一个它从没指过的光标').toBeUndefined()
    // 失败是整页一圈（与"落在这里"的点标记形状不同），浏览器自己说那条动画在跑。
    expect((failed as MarkFacts).coversViewport).toBe(true)
    expect((failed as MarkFacts).animations.join(' ')).toContain(`dsh-fade@${String(MARK_PLANS.failed.lifetimeMs)}`)

    // 像素：失败是整页一圈**红**的，与读取提示那圈**青**的在色相上就分得开。
    await clearMarks()
    const failedShot = readPng(await captureWhileRepainting('failed'))
    const corner = failedShot.rgbAt(2, 2)
    const centre = failedShot.rgbAt(Math.floor(failedShot.width / 2), Math.floor(failedShot.height / 2))
    console.log(
      'RAW 失败标记的像素：' +
        JSON.stringify({
          corner,
          restCorner: bare.rgbAt(2, 2),
          centre,
          restCentre: bare.rgbAt(Math.floor(bare.width / 2), Math.floor(bare.height / 2)),
        }),
    )
    expect(corner).not.toBe(bare.rgbAt(2, 2))
    expect(centre).toBe(bare.rgbAt(Math.floor(bare.width / 2), Math.floor(bare.height / 2)))
    const [red, , blue] = (corner as string).split(',').map(Number)
    expect(red, '失败是红的').toBeGreaterThan(blue)
  })

  it('坑四：静止时对像素是零，T5 的三条断言原样成立，Agent 自己截的图里没有覆盖层', async () => {
    await session.goto(url('/observe'))
    const mounted = await overlayFacts()
    console.log('RAW 刚导航完的覆盖层（应当是挂着、且一个标记都没有）：' + JSON.stringify(mounted))
    expect(mounted.present, '覆盖层应当在').toBe(true)
    expect(mounted.marks.length, '新文档里不该有任何标记').toBe(0)

    // 这一张是"覆盖层挂着、但静止"的图；下一张是把它整个摘掉之后。
    const withOverlay = readPng(await capture())
    await removeOverlay()
    const withoutOverlay = readPng(await capture())
    const zero = withOverlay.diffFrom(withoutOverlay)
    console.log('RAW 覆盖层挂着 vs 摘掉：' + JSON.stringify(zero))

    // 静止时它对像素的贡献是**零**：T5 那条自己解析 PNG 的断言因此原样成立，
    // 一个字都不用放宽 —— 这条就是"不许放宽"的证据。
    expect(zero.changed).toBe(0)

    // 把对照组拆掉的东西装回来（挂载是幂等的），后面还要用。
    await probe.page.evaluate(mountOverlay, config)
    expect((await overlayFacts()).present, '重新挂上之后覆盖层要在').toBe(true)

    // T5 的三条形状断言，原样搬过来，跑在"覆盖层挂着的图"上。
    const viewport = (await probe.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    }))) as { width: number; height: number; dpr: number }
    const expectedWidth = Math.round(viewport.width * viewport.dpr)
    const expectedHeight = Math.round(viewport.height * viewport.dpr)
    console.log(
      'RAW T5 形状断言：' +
        JSON.stringify({
          viewport,
          width: withOverlay.width,
          height: withOverlay.height,
          colors: withOverlay.colors.size,
          hasBox: withOverlay.colors.has(FIXTURE_BOX_RGB),
        }),
    )
    expect(viewport.width).toBe(VIEW.width)
    expect(viewport.height).toBe(VIEW.height)
    expect(withOverlay.width).toBe(expectedWidth)
    expect(withOverlay.height).toBe(expectedHeight)
    expect(withOverlay.width / viewport.dpr).toBe(viewport.width)
    expect(withOverlay.colors.size).toBeGreaterThan(1)
    expect(withOverlay.colors.has(FIXTURE_BOX_RGB)).toBe(true)

    // Agent 自己截的那张图里也不该有覆盖层：先留下标记，再让它截图。
    const snapshot = await session.snapshot()
    await session.clickRef(named(snapshot, 'hit me').ref)
    const marked = await overlayFacts()
    console.log('RAW 截图之前的覆盖层：' + JSON.stringify(marked.marks.map((mark) => mark.className)))
    expect(marked.marks.length, '截图之前要有标记，否则这条守卫是空的').toBeGreaterThan(0)

    const path = join(screenshotDir, 'agent.png')
    await session.screenshot(path)
    // 截完覆盖层上是干净的：它先把标记摘掉再拍。这条断言是这条守卫里**能区分**
    // 修与不修的那一半 —— 光标是常驻的，所以"两张图里都有它"会让纯像素比对看起来一样。
    const afterShot = await overlayFacts()
    console.log('RAW Agent 截图之后覆盖层上的标记：' + JSON.stringify(afterShot.marks.map((mark) => mark.className)))
    expect(afterShot.marks.length, 'Agent 自己截图之后，覆盖层上不该还留着标记').toBe(0)

    const agent = readPng(readFileSync(path))
    // 这一张是在同一次调用之后拍的、且拍之前刚确认过没有标记，所以它代表"没有标记的页面"。
    expect((await overlayFacts()).marks.length, '基准图必须是干净的一帧').toBe(0)
    const clean = readPng(await capture())
    console.log(
      'RAW Agent 的截图 vs 没有标记的页面：' +
        JSON.stringify(agent.diffFrom(clean)) +
        '，夹具色在不在 ' +
        String(agent.colors.has(FIXTURE_BOX_RGB)),
    )
    expect(agent.diffFrom(clean).changed, 'Agent 的截图里不该有覆盖层的任何像素').toBe(0)
    expect(agent.colors.has(FIXTURE_BOX_RGB)).toBe(true)
  })
})
