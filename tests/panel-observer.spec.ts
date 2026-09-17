import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './shell-harness.ts'

/**
 * 票 #19 第二条评论里那个缺陷：**`ResizeObserver` 那条线是断的**。
 *
 * 评论里的原话是：`observer.observe()` 是在面板的 `useMemo` 里、**第一次渲染时**被调用的，
 * 而那一刻 DOM 引用还没挂上（`elementRef.current === null`）⇒ 它从来没有被执行过。
 * 今天没出问题是因为第 200 行那个每帧测量一次的循环把它兜住了 —— 但那行注释
 * （"`element` is read on every measurement, so a caller may point it at a new node"）
 * 与代码不一致，而**将来有人"优化"掉那个每帧循环，跟随就会断**。
 *
 * 这一份就是钉住修好之后的那条线（`shell/panel-rect.js` 的 `pointObserverAt`）：
 *
 *  - 建观察者时元素**还没挂上**（正是面板的形状）⇒ 第一次测量时它必须**真的挂上去**；
 *  - 元素换了节点 ⇒ 观察者必须**跟过去**（旧的解绑、新的挂上），一个都不许漏；
 *  - `stop()` ⇒ 断得干净。
 *
 * 它跑在纯 node 里，不需要浏览器：这个模块**故意**不认识 electron、也不认识 DOM 的类型，
 * 它只读 `globalThis` 上的那几个东西（`ResizeObserver` / `requestAnimationFrame` /
 * `getComputedStyle`），所以替身可以直接装在全局上。读的是**源文件**，不是生成物。
 */

const require = createRequire(import.meta.url)

interface PanelRectApi {
  observe: (options: {
    element?: unknown
    onReport: (rect: { x: number; y: number; width: number; height: number } | null, state: string) => void
  }) => { report: () => void; stop: () => void; last: () => { rect: unknown; state: string } }
}

/** 与 `tests/toolbar.spec.ts` 同一条取法：两路里先出现的那个（ESM 下只有全局那一路成立）。 */
const loaded = require(join(REPO_ROOT, 'shell', 'panel-rect.js')) as Partial<PanelRectApi>
const globalApi = (globalThis as unknown as { DshPanelRect?: PanelRectApi }).DshPanelRect
const panelRect = (Object.keys(loaded).length > 0 ? loaded : globalApi) as PanelRectApi

if (panelRect === undefined || typeof panelRect.observe !== 'function') {
  throw new Error('shell/panel-rect.js exported nothing usable (neither module.exports nor globalThis.DshPanelRect)')
}

/** 一个假的 `ResizeObserver`：它只记录"谁被观察了"，不假装触发事件。 */
interface FakeObserver {
  observed: Set<object>
  observe: (node: object) => void
  unobserve: (node: object) => void
  disconnect: () => void
  disconnected: number
}

/** 造一个节点替身：这个模块只问它 `nodeType` / `parentElement` / `getBoundingClientRect()`。 */
function fakeNode(width: number, height = 100): object {
  const current = { width, height }
  return {
    nodeType: 1,
    parentElement: null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: current.width, height: current.height }),
  }
}

interface Harness {
  observers: FakeObserver[]
  frames: Array<() => void>
  runFrame: () => void
}

/** 装上替身。返回的 `runFrame()` 手动跑一帧（不跑的话那个循环永远不会自己动）。 */
function installHarness(): Harness {
  const observers: FakeObserver[] = []
  const frames: Array<() => void> = []
  const globals = globalThis as unknown as Record<string, unknown>
  globals.ResizeObserver = function ResizeObserverStub() {
    const observed = new Set<object>()
    const record: FakeObserver = {
      observed,
      observe: (node: object) => {
        observed.add(node)
      },
      unobserve: (node: object) => {
        observed.delete(node)
      },
      disconnect: () => {
        observed.clear()
        record.disconnected += 1
      },
      disconnected: 0,
    }
    observers.push(record)
    return record
  }
  globals.requestAnimationFrame = (callback: () => void) => {
    frames.push(callback)
    return frames.length
  }
  globals.cancelAnimationFrame = () => undefined
  globals.getComputedStyle = () => ({ display: 'block' })
  return {
    observers,
    frames,
    runFrame: () => {
      const next = frames.shift()
      if (next !== undefined) next()
    },
  }
}

const installed: Array<keyof typeof globalThis | string> = [
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
]

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of installed) delete globals[name as string]
})

describe('票 #19 · 面板矩形的三条观察线（纯 node，不需要浏览器）', () => {
  it('建观察者时元素还没挂上（面板的形状）⇒ 第一次测量必须真的把它挂上去', () => {
    const harness = installHarness()
    const reports: Array<{ width: number } | null> = []
    const target = fakeNode(440)
    /** 这正是 React `useMemo` 里的形状：`element` 是个 getter，此刻还是 null。 */
    let pointedAt: object | null = null
    const handle = panelRect.observe({
      get element() {
        return pointedAt
      },
      onReport: (rect) => {
        reports.push(rect === null ? null : { width: rect.width })
      },
    })
    console.log(
      'RAW 建立观察者那一刻（元素还没挂上）: ' +
        JSON.stringify({ observers: harness.observers.length, observed: [...(harness.observers[0]?.observed ?? [])].length, reports }),
    )
    // 第一步：观察者建起来了，但**什么都没观察** —— 这就是缺陷本来的样子。
    expect(harness.observers.length).toBe(1)
    expect(harness.observers[0]?.observed.size).toBe(0)
    // 第二步：React 把节点交上来（面板在 effect 里调 `report()`）。
    pointedAt = target
    handle.report()
    console.log(
      'RAW 元素挂上之后再测一次: ' + JSON.stringify({ observed: harness.observers[0]?.observed.size, reports }),
    )
    expect(harness.observers[0]?.observed.has(target), 'the observer must really be watching the node').toBe(true)
    expect(reports[reports.length - 1]).toEqual({ width: 440 })

    // 第三步：拖栏宽 —— 那只是"盒子变了"，只有 ResizeObserver 看得见。替身不假装触发事件，
    // 所以这里证明的是**它挂着**（挂上了才可能收到回调，那是这条线的全部内容）。
    handle.stop()
    expect(harness.observers[0]?.disconnected).toBe(1)
  })

  it('元素换了节点 ⇒ 观察者跟过去（旧的解绑、新的挂上），一个都不漏', () => {
    const harness = installHarness()
    const first = fakeNode(440)
    const second = fakeNode(620)
    let pointedAt: object | null = first
    let reports = 0
    const handle = panelRect.observe({
      get element() {
        return pointedAt
      },
      onReport: () => {
        reports += 1
      },
    })
    expect(harness.observers[0]?.observed.has(first)).toBe(true)
    // React 换掉了那个 DOM 节点（它可能重挂子树）。
    pointedAt = second
    handle.report()
    const observed = harness.observers[0]?.observed ?? new Set()
    console.log('RAW 换节点之后观察者盯着谁: ' + JSON.stringify({ size: observed.size, onNew: observed.has(second), onOld: observed.has(first) }))
    expect(observed.has(second), 'the new node must be observed').toBe(true)
    expect(observed.has(first), 'the old node must be let go').toBe(false)
    expect(observed.size, 'exactly one node at a time').toBe(1)
    // 而每帧那条安全网仍然在跑（它兜的是"祖先被隐藏"这类 ResizeObserver 看不见的变化）。
    const framesBefore = harness.frames.length
    harness.runFrame()
    console.log('RAW 每帧安全网: ' + JSON.stringify({ framesBefore, framesAfter: harness.frames.length, reports }))
    expect(harness.frames.length, 'the per-frame safety net must keep re-scheduling itself').toBeGreaterThan(0)
    handle.stop()
  })

  it('stop() 断得干净：断开观察者、把节点忘掉、不再重排下一帧', () => {
    const harness = installHarness()
    const target = fakeNode(440)
    const handle = panelRect.observe({ element: target, onReport: () => undefined })
    expect(harness.observers[0]?.observed.has(target)).toBe(true)
    handle.stop()
    const framesAfterStop = harness.frames.length
    harness.runFrame()
    console.log(
      'RAW stop 之后: ' + JSON.stringify({ disconnected: harness.observers[0]?.disconnected, framesAfterStop, framesNow: harness.frames.length }),
    )
    expect(harness.observers[0]?.disconnected).toBe(1)
    expect(harness.frames.length).toBe(0)
  })
})
