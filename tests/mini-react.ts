import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { REPO_ROOT } from './shell-harness.ts'

/**
 * 一个**最小 React**：让 `client.js` 里那两个组件在没有 React 的页面上也能渲染出来。
 *
 * ## 为什么需要它
 *
 * 交付物里 `client-body.js` 的 `Panel` / `Toolbar` 是 React 组件（`require('react')`），
 * 而本仓库的 `.npmrc` 明令不下载浏览器那一套，`node_modules` 里也没有 `react` 包 ——
 * 所以在测试页面里渲染它们必须先给一个渲染器。
 *
 * 它是**渲染器**的替身，不是被测逻辑的替身：那七颗按钮、`isEnabled` 的判断、
 * `<button disabled>` 这个属性、面板上报的那个矩形，全都来自 `client.js` 生成物本身；
 * 这里只负责把 `createElement` 出来的树写进真 DOM、并在状态变化时重画。
 *
 * ## 它是被**两条**用例共用的一份（别在用例里各抄一份）
 *
 * `tests/history-truth.spec.ts` 用它量"宿主答 `canGoBack: true` ⇒ 那颗按钮的 `disabled` 是 false"；
 * `tests/panel-toolbar-placement.spec.ts` 用它量"被测量的那一块上报的矩形里不含工具条那一行"。
 * 两条要的都是"交付物真的渲染出来了"，所以渲染器只有这一个实现 —— 本仓库对"复制出来的东西
 * 会长回来"这件事已经有过一次教训（见 `removeWhenFree` 那段注释）。
 *
 * ## 写这个替身踩过的四个坑（都写在这里，免得下一个人再踩）
 *
 * 1. **每个组件的 hook 状态必须各存一份**。第一版把 `hooks` / `cursor` 放在渲染器全局，
 *    于是 `Panel` 与它渲染出来的 `Toolbar` **共用同一串槽位**：第二次渲染的 `useEffect`
 *    读到的是别的组件的槽，判定"依赖没变"直接 return —— 效果永远不跑，面板一次都不上报，
 *    而页面上看起来一切正常（组件照样画出来了）。
 * 2. **`ref` 必须接上**。面板量的是 `elementRef.current` 指的那一块
 *    （`client-body.js` 里 `elementRef.current = hostRef.current`）。替身不实现 ref，
 *    这两个就永远是 `null`，观察器只会报 `detached`。
 * 3. **`[]` 是"依赖没变"**。把空数组判成"变了"会让 `useEffect(..., [])` 每次都重跑，
 *    而它的效果是"报一次矩形" ⇒ 无限渲染（实测 `201 renders without settling`）。
 * 4. **重画必须能被"调度"挡住**。`Panel` 的每一条上报都会 `setReport` 一个新对象
 *    ⇒ 一次重画 ⇒ 效果重跑 ⇒ 又一条上报。真 React 靠批处理把它收成几轮，替身没有批处理，
 *    所以要有一个**每次调度只让效果跑一轮**的闸（见 `scheduled` / `DEADLINE_WINDOW`）。
 *
 * 另外：`disabled={false}` 在 React 里是**不写这个属性**；写成 `disabled="false"` 按 HTML 的
 * 规矩仍然是"有这个属性"，按钮照样是灰的（第一版就是这么写的，量到一片灰）。
 */

/** 渲染器在页面里暴露的接口。 */
export interface MiniReact {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  createRoot: (node: Element) => { render: (tree: unknown) => void }
  useState: (initial: unknown) => [unknown, (next: unknown) => void]
  useRef: (initial: unknown) => { current: unknown }
  useMemo: (factory: () => unknown, deps: unknown[]) => unknown
  useCallback: (callback: unknown, deps: unknown[]) => unknown
  useEffect: (effect: () => unknown, deps?: unknown[]) => void
}

/** 页面里那个渲染器的全局名。 */
const GLOBAL = '__t18MiniReact'

/** 页面里那一小块登记簿：`client.js` 注册了什么、`require` 要什么。 */
const REGISTRY = '__t18Bundle'

/** 装载的结果写在页面全局上的名字（`page.evaluate` 的返回值必须是可序列化的）。 */
const MOUNT_RESULT = '__t18MountResult'

/**
 * 页面里那一整套替身：渲染器、`hasLoaded` 的读法、以及渲染循环的闸。
 *
 * 它是**一段源码字符串**，用 `eval` 在页面里建一个作用域。写成 `page.evaluate` 的函数体也行，
 * 但那样 `installShipment` 里会塞进一整个渲染器，读起来比这里更糟；而它用到的那一堆闭包
 * 需要一个稳定作用域。
 *
 * **不含任何 `${...}` 或反引号**：模板字符串里的转义在两种语言之间来回会变成"哪一层在转义"
 * 的问题（第一版就因为一个注释里的反引号而整个文件解析失败）。
 */
const RUNTIME = [
  '(() => {',
  '  const GLOBAL = ' + JSON.stringify(GLOBAL),
  '  const REGISTRY = ' + JSON.stringify(REGISTRY),
  '  /** 依赖变了没有。[] 与 [] 是**没变**（坑 3）。 */',
  '  const depsChanged = (a, b) => {',
  '    if (!Array.isArray(a) || !Array.isArray(b)) return true',
  '    return a.length !== b.length || a.some((value, index) => value !== b[index])',
  '  }',
  '  const container = { current: null }',
  '  /** 一批渲染里 effects 跑过了没有（坑 4 的那道闸）。 */',
  '  let scheduled = false',
  '  let renders = 0',
  '  let rendering = false',
  '  let current = null',
  '  const components = []',
  '  const componentFor = (fn) => {',
  '    let entry = components.find((candidate) => candidate.fn === fn)',
  '    if (entry === undefined) {',
  '      entry = { fn, hooks: [], cursor: 0 }',
  '      components.push(entry)',
  '    }',
  '    return entry',
  '  }',
  '  const childList = (children) => {',
  '    if (Array.isArray(children)) return children.flat(Infinity)',
  '    if (children === undefined || children === null) return []',
  '    return [children]',
  '  }',
  "  const HOST = '__miniReactTree'",
  '  /** 把 props 落到一个元素上（属性、样式、事件、ref）。 */',
  '  const applyProps = (dom, props) => {',
  '    const previous = dom[HOST]',
  '    const events = []',
  '    for (const [key, value] of Object.entries(props)) {',
  "      if (key === 'children' || key === 'key') continue",
  '      // **ref 必须接上**（坑 2）：对象引用与回调两种写法都要支持',
  '      // （`client-body.js` 用回调那种，好让引用在 commit 时就位、早于任何 effect）。',
  "      if (key === 'ref') {",
  "        if (typeof value === 'function') value(dom)",
  '        else value.current = dom',
  '        continue',
  '      }',
  "      if (typeof value === 'function' && key.startsWith('on')) {",
  '        events.push({ name: key.slice(2).toLowerCase(), handler: value })',
  '        continue',
  '      }',
  "      if (key === 'style' && typeof value === 'object' && value !== null) {",
  '        for (const [css, cssValue] of Object.entries(value)) {',
  "          const property = css.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())",
  "          dom.style[property] = cssValue === null || cssValue === undefined ? '' : String(cssValue)",
  '        }',
  '        continue',
  '      }',
  '      // disabled 这类按属性写；false 是**删掉这个属性**（写成 "false" 仍然是灰的）。',
  '      if (value === false || value === null || value === undefined) dom.removeAttribute(key)',
  "      else dom.setAttribute(key, value === true ? '' : String(value))",
  '    }',
  '    for (const event of (previous === undefined ? [] : previous.events)) {',
  '      dom.removeEventListener(event.name, event.handler)',
  '    }',
  '    for (const event of events) dom.addEventListener(event.name, event.handler)',
  '    dom[HOST] = { events }',
  '  }',
  '  const mountTree = (element, into) => {',
  '    if (element === null || element === undefined || element === false || element === true) return',
  "    if (typeof element === 'string' || typeof element === 'number') {",
  '      into.appendChild(document.createTextNode(String(element)))',
  '      return',
  '    }',
  '    if (Array.isArray(element)) {',
  '      for (const child of element) mountTree(child, into)',
  '      return',
  '    }',
  "    if (typeof element.type === 'function') {",
  '      // 换组件就换一整套槽位（坑 1）。',
  '      const previous = current',
  '      const mine = componentFor(element.type)',
  '      mine.cursor = 0',
  '      current = mine',
  '      try {',
  '        for (const child of childList(element.type({ ...element.props }))) mountTree(child, into)',
  '      } finally {',
  '        // **不要在这里清 `touched`**（票 #20 改的）：`touched` 的含义是"这一轮渲染用到了',
  '        // 这个槽位"，它由 `use()` 在渲染期间置 true、由 `clearTouched` 在**渲染之前**统一清零。',
  '        // 旧版在这里把每个槽位都清成 false，于是下一轮开始时"所有槽位都没被用到" ⇒',
  '        // `unmountUntouched` 把**每个** effect 都拆掉（跑清理、把 effect 置空），下一轮再重新',
  '        // 注册并重跑一遍 —— 于是一个在 effect 里 setState 的组件每一轮都在跑 effect，',
  '        // 一路撞上渲染闸，整棵树冻住（实测：`mini-react: 13 renders without settling`，',
  '        // 页面上看起来只是"点了没反应"）。',
  '        current = previous',
  '      }',
  '      return',
  '    }',
  '    const dom = document.createElement(String(element.type))',
  '    applyProps(dom, element.props === undefined ? {} : element.props)',
  '    mountTree((element.props === undefined ? {} : element.props).children, dom)',
  '    into.appendChild(dom)',
  '  }',
  '  /**',
  '   * 渲染之前把"这一轮用到了没有"统一清零。',
  '   *',
  '   * 渲染期间 `use()` 会把它置回 true；渲染之后仍是 false 的槽位就是**这一轮没被用到**的',
  '   * （组件没了，或者 hook 变少了），由 {@link unmountUntouched} 收尾。',
  '   */',
  '  const clearTouched = () => {',
  '    for (const entry of components) {',
  '      for (const slot of entry.hooks) if (slot !== undefined) slot.touched = false',
  '    }',
  '  }',
  '  /**',
  '   * 渲染之后跑掉**这一次新排下**的 effects。',
  '   *',
  '   * 判据是 `pending`（票 #20 加的）：它只在 `useEffect` 真的（重新）注册一个 effect 时置 true，',
  '   * 也就是"首次挂载"或"依赖变了"——与真 React 同一条规矩。',
  '   */',
  '  const runEffects = () => {',
  '    for (const entry of components) {',
  '      for (const slot of entry.hooks) {',
  '        if (slot === undefined || slot.pending !== true || slot.effect === undefined) continue',
  '        slot.pending = false',
  "        if (typeof slot.cleanup === 'function') slot.cleanup()",
  '        const cleanup = slot.effect()',
  '        slot.cleanup = typeof cleanup === \'function\' ? cleanup : undefined',
  '      }',
  '    }',
  '  }',
  '  /** 这一段树里已经不在的那些组件，它们的 effect 清理该跑了（渲染之后才判得准）。 */',
  '  const unmountUntouched = () => {',
  '    for (const entry of components) {',
  '      for (const slot of entry.hooks) {',
  '        if (slot === undefined || slot.touched !== false) continue',
  '        slot.touched = undefined',
  '        slot.pending = false',
  '        if (slot.cleanup !== undefined || slot.effect !== undefined) {',
  "          if (typeof slot.cleanup === 'function') slot.cleanup()",
  '          slot.cleanup = undefined',
  '          slot.effect = undefined',
  '          slot.deps = undefined',
  '        }',
  '      }',
  '    }',
  '  }',
  '  const draw = () => {',
  '    if (rendering || container.current === null) return',
  '    renders += 1',
  '    if (renders > 12) {',
  "      var seen = components.map((entry) => entry.hooks.map((slot) => {",
  "        if (slot === undefined) return 'undefined'",
  '        var value = slot.value',
  "        if (value !== null && typeof value === 'object' && typeof value.current !== 'undefined') return 'ref'",
  "        if (value !== null && typeof value === 'object') return JSON.stringify(value)",
  '        return typeof value',
  "      }).join('|')).join(' // ')",
  "      throw new Error('mini-react: ' + renders + ' renders without settling; hooks: ' + seen)",
  '    }',
  '    rendering = true',
  '    try {',
  '      clearTouched()',
  '      const tree = container.current.__tree',
  '      current = null',
  '      container.current.replaceChildren()',
  '      mountTree(tree, container.current)',
  '    } finally {',
  '      rendering = false',
  '      current = null',
  '    }',
  '    // 这一批的 effects 跑完了：闸重新打开，下一次状态变化才能再渲染一轮（坑 4）。',
  '    scheduled = false',
  '    runEffects()',
  '    // 收尾放在效果之后：这一轮没被碰到的槽位（组件没了 / hook 少了）现在才判得准。',
  '    unmountUntouched()',
  '  }',
  '  const schedule = () => {',
  '    if (scheduled) return',
  '    scheduled = true',
  '    queueMicrotask(draw)',
  '  }',
  '  const use = () => {',
  "    if (current === null) throw new Error('a hook was called outside a component render')",
  '    const entry = current',
  '    const index = entry.cursor++',
  '    if (entry.hooks[index] === undefined) entry.hooks[index] = { touched: true }',
  '    entry.hooks[index].touched = true',
  '    return { entry, index, slot: entry.hooks[index] }',
  '  }',
  '  const react = {',
  '    createElement(type, props, ...children) {',
  '      const rest = { ...(props === undefined || props === null ? {} : props) }',
  '      const fromProps = rest.children',
  '      delete rest.children',
  '      return { type, props: { ...rest, children: children.length > 0 ? children : fromProps } }',
  '    },',
  '    useState(initial) {',
  '      const used = use()',
  '      const slot = used.slot',
  "      if (!Object.prototype.hasOwnProperty.call(slot, 'value')) slot.value = initial",
  '      return [',
  '        slot.value,',
  '        (next) => {',
  "          const value = typeof next === 'function' ? next(slot.value) : next",
  '          if (value === slot.value) return',
  '          slot.value = value',
  '          schedule()',
  '        },',
  '      ]',
  '    },',
  '    useRef(initial) {',
  '      const slot = use().slot',
  "      if (!Object.prototype.hasOwnProperty.call(slot, 'value')) slot.value = { current: initial }",
  '      return slot.value',
  '    },',
  '    useMemo(factory, deps) {',
  '      const entry = current',
  '      const existing = entry.hooks[entry.cursor]',
  '      const used = use()',
  '      if (existing === undefined || depsChanged(existing.deps, deps)) {',
  '        used.slot.deps = deps',
  '        used.slot.value = factory()',
  '      }',
  '      return entry.hooks[used.index].value',
  '    },',
  '    useCallback(callback, deps) {',
  '      const entry = current',
  '      const existing = entry.hooks[entry.cursor]',
  '      const used = use()',
  '      if (existing === undefined || depsChanged(existing.deps, deps)) {',
  '        used.slot.deps = deps',
  '        used.slot.value = callback',
  '      }',
  '      return used.slot.value',
  '    },',
  '    useEffect(effect, deps) {',
  '      const used = use()',
  '      const slot = used.slot',
  '      if (slot.effect !== undefined && !depsChanged(slot.deps, deps)) return',
  '      slot.deps = deps',
  '      slot.effect = effect',
  '      // `pending` 才是"这个 effect 这一轮要跑"的判据（见 `runEffects`）。',
  '      // **不要**在这里动 `touched`：它是"这一轮用到了没有"（`use()` 已经置 true），',
  '      // 改它会让 `unmountUntouched` 把这个刚注册的 effect 当成"组件没了"拆掉。',
  '      slot.pending = true',
  '    },',
  '    createRoot(node) {',
  '      container.current = node',
  '      return {',
  '        render(tree) {',
  '          node.__tree = tree',
  '          schedule()',
  '        },',
  '      }',
  '    },',
  '  }',
  '  window[GLOBAL] = react',
  '  window[REGISTRY] = { entries: [] }',
  '  window.__ModuleLoader__ = {',
  '    load: (entry) => {',
  '      window[REGISTRY].entries.push(entry)',
  '    },',
  '  }',
  '})()',
].join('\n')

/**
 * 把渲染器与那个模块登记簿装进页面，然后加载 `client.js`。
 *
 * 顺序是本质的：`client.js` 跑起来的第一件事就是读 `window.__ModuleLoader__.load`，
 * 所以加载器必须在 `addScriptTag` **之前**就位。
 *
 * @param page - 要装的那一页（必须是外壳窗口那一页或视图那一页 —— 有真 DOM 的页面）。
 * @param options - `withShellChannel`：给这一页装一个假的矩形通道
 *   （`window.__dshDesktopView`）。真外壳窗口那一页**有**真的 preload，不要覆盖它；
 *   视图那一页没有 preload，需要装一个假的（面板要它才知道"有外壳"）。
 *   `stubAnimationFrame`：把 rAF 收成 `setTimeout`（离屏页面里 rAF 不一定被调度，
 *   而面板的测量回路靠它兜底）。
 */
export async function installShipment(
  page: Page,
  options: { withShellChannel?: boolean; stubAnimationFrame?: boolean } = {},
): Promise<void> {
  await page.evaluate((runtime: string) => {
    // 这一整套替身就是要在页面里建一个作用域，所以这里用间接 eval（见 RUNTIME 的说明）。
    const run = eval as (source: string) => unknown
    run(runtime)
  }, RUNTIME)
  if (options.withShellChannel === true) {
    await page.evaluate(() => {
      Object.defineProperty(window, '__dshDesktopView', {
        configurable: true,
        value: { channel: 1, setRect: () => undefined },
      })
    })
  }
  if (options.stubAnimationFrame === true) {
    await page.evaluate(() => {
      // 面板的测量回路有两台"自己转的"发动机：`ResizeObserver` 与每帧一次的 rAF 兜底
      // （`shell/panel-rect.js` 的 `observe`）。在有真画面的页面里它们只在尺寸变化时说话，
      // 但在**离屏/无头**页面里 rAF 会被连续调度，而每次 `report()` 都让面板 `setReport`
      // ⇒ 一次重画 ⇒ 又一次 `report()`：实测打出几百次 `desktop-view-state`。
      //
      // 这一条用例要的是"面板上报的那个矩形"，而 `observe()` 结尾**同步**报一次
      // （`report(true)`）就够了，所以把这两台发动机关掉：只有那一次上报。
      //
      // 票 #20：这里必须**定义成 undefined**，不能 `delete`。`requestAnimationFrame` 是
      // `Window` 接口上的属性，不在 window 对象自己身上 —— `delete window.requestAnimationFrame`
      // 对一个继承来的属性是**空操作**（还返回 true），于是 rAF 那台发动机其实一直在转。
      // 后果实测过：`replaceChildren` 重画时被测量的那一块会在整数像素间抖一下，抖动喂给
      // `onReport` ⇒ 几何计数一直涨 ⇒ 工具有一直重读 ⇒ 一路撞上 `mini-react` 的渲染闸，
      // 整棵树冻住（页面上看起来只是"点了没反应"）。
      for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']) {
        Object.defineProperty(window, name, { configurable: true, writable: true, value: undefined })
      }
    })
  }
  // `client.js` 用**源码文本**注入，不用 `{ path }`：`path` 那条路让它以 `file://` 加载，
  // 而这一页是 `about:blank`/`http://` —— 实测那样注入之后脚本**没有真的跑**
  // （`__ModuleLoader__.load` 没人调用，页面上没有 `DshPanelRect`），而且不留任何异常。
  // 文本注入与真宿主那条 `<script src="/plugins/…">` 是同一种东西：都是页面自己的脚本。
  const source = readFileSync(join(REPO_ROOT, 'client.js'), 'utf8')
  await page.addScriptTag({ content: source })
  const installed = await page.evaluate((names: { global: string; registry: string }) => {
    const host = window as unknown as Record<string, unknown>
    const entries = ((host[names.registry] as { entries?: unknown[] } | undefined)?.entries ?? []) as Array<{
      factory: (require: (name: string) => unknown) => unknown
    }>
    // 自己把那个 factory 跑一遍再看（诊断：它在 `__ModuleLoader__.load` 里跑过一次，
    // 这里再跑一次就是为了看它有没有把 `DshPanelRect` 装到页面上）。
    let factoryRun: unknown
    try {
      entries[0]?.factory((name: string) => {
        throw new Error(`factory asked for ${name}`)
      })
      factoryRun = 'returned'
    } catch (error) {
      factoryRun = error instanceof Error ? error.message : String(error)
    }
    return {
      react: typeof host[names.global],
      entries: entries.length,
      panelRect: typeof (host as { DshPanelRect?: unknown }).DshPanelRect,
      toolbar: typeof (host as { DshViewToolbar?: unknown }).DshViewToolbar,
      factoryRun,
    }
  }, { global: GLOBAL, registry: REGISTRY })
  if (installed.entries === 0) {
    throw new Error(
      `the client bundle registered no module entry — did it run? (${JSON.stringify(installed)}); ` +
        'the artifact throws when window.__ModuleLoader__.load is not the host loader',
    )
  }
  console.log('RAW the bundle inside this page: ' + JSON.stringify(installed))
}

/**
 * 在页面里 `apply()` 一次交付物、把注册上来的面板组件渲染进一个新容器。
 *
 * 宿主那条 RPC 用 `rpcValue` 回答（真宿主那半条通道由 `tests/panel-toolbar.spec.ts` 对着
 * **真 dsh 宿主**量过；这里要量的是"宿主答 A ⇒ 页面上就是 A"）。票 #20 起还可以给一个
 * `rpcHandler`：地址栏与档位那两条动作的**参数**要跟着一起量，而"每次回答什么"也要能逐次变
 * （比如"这一按之后地址变了 ⇒ 框里跟着变"）。
 *
 * @param page - 已经 {@link installShipment} 过的那一页。
 * @param options - 宿主对每一次 RPC 的回答，以及要挂进哪个元素。
 * @returns 页面里量到的几个框、那一格向宿主打过哪些调用，以及两个座位各自注册上来的组件。
 */
export async function mountShipment(
  page: Page,
  options: {
    /** 宿主对每一次 `rpc.call` 的回答（`value` 那一段），作为缺省答案。 */
    rpcValue?: Record<string, unknown>
    /**
     * 按端点覆盖回答（票 #20）。
     *
     * 键是端点名（`desktop-view-navigate`、`desktop-view-state`、……），值是那一段 `value`。
     * 有了它，"按一下之后地址变了 ⇒ 框里跟着变"这种事不需要一个会变的函数，
     * 只需要**两次不同的调用**各自的答案不同。
     */
    rpcTable?: Record<string, Record<string, unknown>>
    /** 挂进哪个元素（CSS 选择器）；缺省挂到 `document.body` 下一层 440×600 的容器里。 */
    into?: string
    /** 诊断：把 `DshPanelRect.observe` 包一层，记下每一次上报时 `element` 是哪一块。 */
    traceObserve?: boolean
    /** 把标签座位（`sidebar.right.pane.tab.title`）那个组件也渲染一次（票 #20 B）。 */
    mountTitle?: boolean
  },
): Promise<{
  rpcCalls: string[]
  rpcPayloads: Array<{ endpoint: string; payload: Record<string, unknown> }>
  observeTrace?: unknown[]
  parent: { top: number; bottom: number; left: number; right: number; width: number; height: number }
  container: { top: number; bottom: number; left: number; right: number; width: number; height: number }
  /** 注册到 `sidebar.right.pane.tab.title` 上那个组件渲染出来的文字（没注册就是 null）。 */
  titleText: string | null
  /** 两个座位各自有没有注册上来（有 = 宿主那个位置会被我们取代）。 */
  seats: { body: boolean; title: boolean }
}> {
  return await page.evaluate(
    async (input: {
      rpcTable: Record<string, Record<string, unknown>>
      into: string | null
      traceObserve: boolean
      mountTitle: boolean
      globalName: string
      registryName: string
      resultName: string
    }) => {
      const host = window as unknown as Record<string, unknown>
      const react = host[input.globalName] as MiniReact
      const observeTrace: unknown[] = []
      if (input.traceObserve) {
        const api = (window as unknown as { DshPanelRect: { observe: (options: unknown) => unknown } }).DshPanelRect
        const original = api.observe.bind(api)
        api.observe = (options: unknown) => {
          const source = options as { element: Element | null; onReport: (rect: unknown, state: string) => void }
          const describe = (element: unknown): unknown => {
            if (element === null || element === undefined) return null
            const dom = element as Element
            const rect = dom.getBoundingClientRect()
            return {
              tag: dom.tagName,
              marker: dom.getAttribute('data-dsh-desktop-view-panel'),
              top: rect.top,
              height: rect.height,
            }
          }
          observeTrace.push({ at: 'created', element: describe(source.element) })
          return original({
            get element() {
              return source.element
            },
            onReport: (rect: unknown, state: string) => {
              observeTrace.push({ at: 'report', state, reported: rect, element: describe(source.element) })
              source.onReport(rect, state)
            },
          })
        }
      }
      const registry = host[input.registryName] as {
        entries: Array<{ factory: (require: (name: string) => unknown) => unknown }>
      }
      const entry = registry.entries[0]
      if (entry === undefined) throw new Error('the bundle registered no module entry')
      const plugin = entry.factory((name: string) => {
        if (name === 'react') return react
        throw new Error(`the client half asked for a module this test does not provide: ${name}`)
      }) as { apply?: unknown }

      const rpcCalls: string[] = []
      const rpcPayloads: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
      /** 每个座位注册上来的组件（票 #20 起有两个：正文与标签标题）。 */
      const seats: Record<string, unknown> = {}
      /**
       * 宿主那份 locale 服务的替身（票 #20 修的）。
       *
       * 它**按插件自己注册的那份字典**回答 `bind(ns)(key)`，而不是把 key 原样返回：
       * 标签标题的回落词就是从这条路上来的（`src/client-body.js` 的 `tabTitleFallback`），
       * 一个"原样返回 key"的替身会让标签上写着 `type.label` —— 那不是被测代码的行为，
       * 是这个替身不够用（第一版就是这么绿着的，直到 B 那条断言把它抓出来）。
       */
      const dictionaries: Record<string, Record<string, Record<string, string>>> = {}
      const language = (): string => {
        const raw = typeof navigator !== 'undefined' && navigator !== null ? navigator.language : ''
        return typeof raw === 'string' && raw.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en'
      }
      const ctx = {
        effect: (fn: () => unknown) => fn(),
        locale: {
          bind: (ns: string) => (key: string) => {
            const table = dictionaries[ns]
            const entry = table === undefined ? undefined : table[language()]
            const word = entry === undefined ? undefined : entry[key]
            return typeof word === 'string' ? word : key
          },
          register: (ns: string, table: Record<string, Record<string, string>>) => {
            dictionaries[ns] = table
            return () => undefined
          },
        },
        sidebarRightTabs: { register: () => () => undefined },
        slots: {
          inject: (_seat: string, fn: () => unknown) => fn(),
          // 座位那条 API 的形状照第一方用它的样子（`dsh-client-ui-sidebar-files/lib/client.js:701`）：
          // `register({name, key, locale}, Component)` —— 组件是**第二个参数**。
          register: (definition: unknown, component?: unknown) => {
            const name = (definition as { name?: unknown } | null)?.name
            seats[typeof name === 'string' ? name : 'unknown'] = component
            return () => undefined
          },
        },
        connection: {
          rpc: {
            call: async (_channel: string, endpoint: string, payload: unknown) => {
              rpcCalls.push(endpoint)
              const sent = (payload ?? {}) as Record<string, unknown>
              rpcPayloads.push({ endpoint, payload: sent })
              // `rpcTable` 的键是端点名，`default` 是缺省答案 —— 页面这一侧只有一个查表动作，
              // 没有"会变的函数"（函数过不了 `page.evaluate` 那道边界）。
              const table = input.rpcTable
              const next = table[endpoint] ?? table.default
              // 票 #20：某一格可以要求"晚一点再答"（`__t20DelayMs`），用来量**在飞的那一段时间里**
              // 页面长什么样（导航中的按钮锁与"加载中"）。它不是回答的一部分，所以取完就摘掉。
              const wait = typeof next?.__t20DelayMs === 'number' ? next.__t20DelayMs : 0
              const answer = { ...(next ?? {}) }
              delete answer.__t20DelayMs
              if (wait > 0) await new Promise((settle) => setTimeout(settle, wait))
              return {
                ok: true,
                value: {
                  url: location.href,
                  zoom: 1,
                  message: 'nothing was changed',
                  ok: true,
                  ...answer,
                },
              }
            },
          },
        },
      }
      if (typeof plugin.apply === 'function') (plugin.apply as (c: unknown) => void)(ctx)
      const shippedPanel = seats['sidebar.right.pane.tab']
      if (typeof shippedPanel !== 'function') throw new Error('applying the client half registered no panel component')

      const parent = input.into === null ? document.body : document.querySelector(input.into)
      if (parent === null) throw new Error(`no element matched ${String(input.into)}`)
      const mount = document.createElement('div')
      mount.id = 'dsh-view-shipped-panel'
      if (input.into === null) {
        mount.style.width = '440px'
        mount.style.height = '600px'
      } else {
        // 挂进真的一格：占满它，与 DSH 里那一格的形状一致。
        mount.style.position = 'absolute'
        mount.style.top = '0'
        mount.style.left = '0'
        mount.style.width = '100%'
        mount.style.height = '100%'
      }
      parent.appendChild(mount)
      react.createRoot(mount).render(
        react.createElement(shippedPanel, { tabInfo: () => ({ sidebar: { expanded: true }, tab: { visible: true } }) }),
      )

      /** 等那一格真的长出来（渲染是异步的 —— `createRoot().render()` 只排一次调度）。 */
      const deadline = Date.now() + 15_000
      while (document.querySelector('[data-dsh-view-toolbar]') === null && Date.now() < deadline) {
        await new Promise((settle) => setTimeout(settle, 25))
      }
      const box = (element: Element): { top: number; bottom: number; left: number; right: number; width: number; height: number } => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
      }

      // 票 #20 B：把标签座位那个组件也渲染一次，读回它写的字。
      // 它挂在**另一个**容器里，因为真宿主也是分开渲染这两个座位的（标签在标签条上，正文在格里）。
      let titleText: string | null = null
      const titleComponent = seats['sidebar.right.pane.tab.title']
      if (input.mountTitle && typeof titleComponent === 'function') {
        const titleMount = document.createElement('div')
        titleMount.id = 'dsh-view-shipped-title'
        document.body.appendChild(titleMount)
        react.createRoot(titleMount).render(react.createElement(titleComponent, {}))
        const titleDeadline = Date.now() + 5_000
        // 标签那棵树只有一个文本节点，等它非空就行（心跳/首读是异步的）。
        while ((titleMount.textContent ?? '') === '' && Date.now() < titleDeadline) {
          await new Promise((settle) => setTimeout(settle, 25))
        }
        titleText = titleMount.textContent ?? ''
      }

      const summary = {
        rpcCalls,
        rpcPayloads,
        observeTrace,
        parent: box(parent),
        container: box(mount),
        titleText,
        seats: {
          body: typeof seats['sidebar.right.pane.tab'] === 'function',
          title: typeof seats['sidebar.right.pane.tab.title'] === 'function',
        },
      }
      host[input.resultName] = summary
      return summary
    },
    {
      rpcTable: { default: options.rpcValue ?? {}, ...(options.rpcTable ?? {}) },
      into: options.into ?? null,
      traceObserve: options.traceObserve === true,
      mountTitle: options.mountTitle === true,
      globalName: GLOBAL,
      registryName: REGISTRY,
      resultName: MOUNT_RESULT,
    },
  )
}

/**
 * 在已经挂好的那一格上按一个键（票 #20 的地址栏用）。
 *
 * 真 React 把 `onChange` 接在 `input` 事件上，`mini-react` 也是按名字接的 `addEventListener`；
 * 两者都认 `onInput`。所以这里**先改 DOM 的值、再派发 `input`**，然后派发 `keydown` ——
 * 那条顺序与真浏览器里"用户打了字再按回车"是同一条。
 *
 * @param page - 已经 {@link mountShipment} 过的那一页。
 * @param selector - 要操作的元素。
 * @param value - 要打进输入框的字（不给就不打字，只按键）。
 * @param key - 要按的键（`KeyboardEvent.key`）。
 * @returns 页面里那一刻读到的元素事实。
 */
export async function typeInto(
  page: Page,
  selector: string,
  value: string | undefined,
  key: string,
): Promise<{ value: string; calls: string[]; payloads: Array<{ endpoint: string; payload: Record<string, unknown> }> }> {
  return await page.evaluate(
    async (input: { selector: string; value: string | null; key: string; resultName: string }) => {
      const host = window as unknown as Record<string, unknown>
      const find = (): HTMLInputElement => {
        const element = document.querySelector(input.selector) as HTMLInputElement | null
        if (element === null) throw new Error(`no element matched ${input.selector}`)
        return element
      }
      if (input.value !== null) {
        const element = find()
        element.value = input.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        // **让出一个宏任务再按下一个键**：真正的用户是"打完字、再按回车"，中间隔着一次重画；
        // 两次事件在同一个同步块里连着发，读到的会是同一个渲染里那份还没更新的状态 ——
        // 那是这个量具的时序，不是被测代码的行为。
        await new Promise((settle) => setTimeout(settle, 50))
      }
      find().dispatchEvent(new KeyboardEvent('keydown', { key: input.key, bubbles: true }))
      // 状态更新 → 重画 → RPC 都是异步的，等一下再读。
      await new Promise((settle) => setTimeout(settle, 300))
      const summary = host[input.resultName] as {
        rpcCalls: string[]
        rpcPayloads: Array<{ endpoint: string; payload: Record<string, unknown> }>
      }
      // **读回时重新取一次元素**：一次重画会把整棵树换掉，手里那个节点已经不在页面上了，
      // 它的 `value` 停在旧值上（第一版就是这么被骗过去的）。
      return { value: find().value, calls: summary.rpcCalls, payloads: summary.rpcPayloads }
    },
    { selector, value: value ?? null, key, resultName: MOUNT_RESULT },
  )
}

/**
 * 在已经挂好的那一格上点一个元素（票 #20 的档位菜单用）。
 *
 * @param page - 已经 {@link mountShipment} 过的那一页。
 * @param selector - 要点的元素。
 * @returns 页面里那一刻读到的调用表。
 */
export async function clickIn(
  page: Page,
  selector: string,
): Promise<{ calls: string[]; payloads: Array<{ endpoint: string; payload: Record<string, unknown> }> }> {
  return await page.evaluate(
    async (input: { selector: string; resultName: string }) => {
      const host = window as unknown as Record<string, unknown>
      const element = document.querySelector(input.selector) as HTMLElement | null
      if (element === null) throw new Error(`no element matched ${input.selector}`)
      element.click()
      await new Promise((settle) => setTimeout(settle, 300))
      const summary = host[input.resultName] as {
        rpcCalls: string[]
        rpcPayloads: Array<{ endpoint: string; payload: Record<string, unknown> }>
      }
      return { calls: summary.rpcCalls, payloads: summary.rpcPayloads }
    },
    { selector, resultName: MOUNT_RESULT },
  )
}

/**
 * 页面里那一刻某个元素的属性（票 #20 的读回口）。
 *
 * @param page - 已经 {@link mountShipment} 过的那一页。
 * @param selector - 要读的元素。
 * @param attribute - 属性名。
 * @returns 属性值，元素不在就是 null。
 */
export async function attributeOf(page: Page, selector: string, attribute: string): Promise<string | null> {
  return await page.evaluate(
    (input: { selector: string; attribute: string }) =>
      document.querySelector(input.selector)?.getAttribute(input.attribute) ?? null,
    { selector, attribute },
  )
}

/**
 * 页面里那一刻所有匹配元素的某个属性（票 #20 的档位表用）。
 *
 * @param page - 已经 {@link mountShipment} 过的那一页。
 * @param selector - 要读的那一组元素。
 * @param attribute - 属性名。
 * @returns 每一匹配项的属性值（按文档顺序）。
 */
export async function attributesOf(page: Page, selector: string, attribute: string): Promise<Array<string | null>> {
  return await page.evaluate(
    (input: { selector: string; attribute: string }) =>
      Array.from(document.querySelectorAll(input.selector)).map((element) => element.getAttribute(input.attribute)),
    { selector, attribute },
  )
}
