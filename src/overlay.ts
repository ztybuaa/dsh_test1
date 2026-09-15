/**
 * 光标覆盖层：把 Agent 的动作画在**被驱动的那个页面**上的那一层（票 #9）。
 *
 * 这一层是注入到页面里的东西，而那个页面同时是快照、动作、观测三类能力的对象，
 * 所以它的形状由四条硬约束定死（每一条都在 `docs/research/cursor-overlay-and-the-snapshot.md`
 * 里用探针量过）：
 *
 *  - **不匹配快照选择器**：覆盖层只由无 role 的 `<div>` 与一张 `<style>` 组成，
 *    `a[href] / button / input / …` 与那一串 `[role="…"]` 一个都不沾；
 *  - **不吃指针事件**：容器与所有后代的 `pointer-events` 都是 `none`，所以
 *    `document.elementFromPoint` 仍然回答页面自己的元素 —— T4 的 `obscured` 分诊
 *    建立在这个问题的答案上，覆盖层不能插进去；
 *  - **不塞文本**：容器挂在 `document.documentElement` 上（不在 `body` 里），
 *    里面一个文本节点都没有，所以 `body.innerText` 与 `browser_extract` 一字不动；
 *  - **静止时零像素**：没有标记时它对截图不贡献任何像素，T5 那条自己解析 PNG 的
 *    断言因此原样成立，不需要放宽。
 *
 * 这一层**只在 Agent 有会话时存在**：它是"Agent 在干什么"的显示，没有 Agent 就没有它。
 *
 * 本模块**不 import electron 也不 import playwright**：它是可以被直接单测的纯数据与纯判断，
 * 页面里那三个函数只靠自己的源码过界（`page.evaluate` / `page.addInitScript` 只序列化函数体，
 * 所以它们需要的一切都得从 `config` 参数进来，不能在函数里读模块常量）。
 */

/** 覆盖层容器的 id。 */
export const OVERLAY_ID = 'dsh-cursor-overlay'

/** 覆盖层容器的选择器。 */
export const OVERLAY_SELECTOR = `#${OVERLAY_ID}`

/**
 * 覆盖层上能画的标记。
 *
 * 它们各自只表示一件事，尤其是最后一条：**失败与成功画法不同**，
 * 所以"动作失败了却被画成成功"这件事在数据层面就不可能发生。
 */
export type OverlayKind =
  /** Agent 正瞄着这个点（动作发出前）。 */
  | 'aim'
  /** 动作真的落到了这个点（涟漪，一圈就完）。 */
  | 'point'
  /** Agent 正在读这一页（快照 / 读正文）。 */
  | 'read'
  /** 一次作用于整页、不针对某个元素的动作。 */
  | 'page'
  /** 动作失败了。 */
  | 'failed'

/** 视口坐标系里的一个点（与快照 bounds、命中测试同一套坐标，ADR-0007）。 */
export interface ViewPoint {
  /** 距视口左边的距离，CSS 像素。 */
  x: number
  /** 距视口上边的距离，CSS 像素。 */
  y: number
}

/** 一种标记怎么画。 */
export interface MarkPlan {
  /** 加在标记元素上的 class。 */
  className: string
  /**
   * `point` 画在落点上；`ring` 沿视口边缘画一圈。
   *
   * 圈是"整页/读取/失败"这类**没有落点**的事情的形状；点标记是"就落在这里"。
   */
  shape: 'point' | 'ring'
  /** 颜色。 */
  color: string
  /**
   * 动画时长（毫秒）。省略 = **一直留着**，直到下一个标记把它换掉。
   *
   * 只有"瞄着这里"是常驻的：人晚一步看过来，也还看得见 Agent 最后停在哪。
   * 其余都是一次性的提示，亮完就自己摘掉 —— 否则它们会一直叠在后面的每一张截图上。
   */
  lifetimeMs?: number
}

/**
 * 每种标记怎么画。
 *
 * 这份数据同时被三处消费：样式表（{@link overlayStyleSheet}）、页面里的画笔
 * （{@link paintOverlay}）、以及测试的断言。**一处定义**，所以"样式说 600ms、
 * 数据说 900ms"这种漂移不会有第二个地方可以发生。
 */
export const MARK_PLANS: Readonly<Record<OverlayKind, MarkPlan>> = {
  aim: { className: 'dsh-aim', shape: 'point', color: '#ff2d95' },
  point: { className: 'dsh-point', shape: 'point', color: '#ff2d95', lifetimeMs: 700 },
  read: { className: 'dsh-read', shape: 'ring', color: '#14b8ff', lifetimeMs: 600 },
  page: { className: 'dsh-page', shape: 'ring', color: '#f5a524', lifetimeMs: 600 },
  failed: { className: 'dsh-failed', shape: 'ring', color: '#ff3b30', lifetimeMs: 900 },
}

/** `#14b8ff` + 0.55 → `rgba(20, 184, 255, 0.55)`，给环的内侧辉光用。 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith('#') ? color.slice(1) : color
  const full = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join('') : hex
  const red = Number.parseInt(full.slice(0, 2), 16)
  const green = Number.parseInt(full.slice(2, 4), 16)
  const blue = Number.parseInt(full.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/**
 * 整张样式表，由 {@link MARK_PLANS} 生成。
 *
 * 每一条标记规则都带容器 id 前缀，这不是风格问题：`#id *` 那条重置的权重（1-0-0）
 * 高于单个 class（0-1-0），不带前缀的 `.dsh-point { border: 3px solid }` 会被它的
 * `border: 0` 压掉，涟漪就变成了一个实心方块。
 */
export function overlayStyleSheet(): string {
  const rules = (Object.keys(MARK_PLANS) as OverlayKind[]).map((kind) => {
    const plan = MARK_PLANS[kind]
    const selector = `${OVERLAY_SELECTOR} .${plan.className}`
    if (plan.shape === 'ring') {
      return (
        `${selector} { left: 0; top: 0; width: 100%; height: 100%; ` +
        `box-shadow: inset 0 0 0 3px ${plan.color}, inset 0 0 18px ${withAlpha(plan.color, 0.55)}; ` +
        `animation: dsh-fade ${String(plan.lifetimeMs)}ms ease-out forwards; }`
      )
    }
    if (plan.lifetimeMs === undefined) {
      // 光标：一个指向上左的箭头，尖端点在被瞄的那个点上。
      return (
        `${selector} { width: 14px; height: 20px; background: ${plan.color}; ` +
        'clip-path: polygon(0 0, 0 100%, 4px 74%, 7px 92%, 10px 88%, 7px 70%, 13px 70%); }'
      )
    }
    return (
      `${selector} { width: 12px; height: 12px; border: 3px solid ${plan.color}; border-radius: 50%; ` +
      `transform: translate(-50%, -50%); animation: dsh-ripple ${String(plan.lifetimeMs)}ms ease-out forwards; }`
    )
  })
  return [
    `${OVERLAY_SELECTOR} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; ` +
      'pointer-events: none; z-index: 2147483647; overflow: hidden; margin: 0; padding: 0; ' +
      'border: 0; background: transparent; }',
    // 后代一律不吃指针事件：覆盖层盖住的那个点上，"最上面是谁"必须还是页面自己的元素。
    `${OVERLAY_SELECTOR} * { position: absolute; pointer-events: none; margin: 0; padding: 0; ` +
      'border: 0; box-sizing: border-box; }',
    ...rules,
    '@keyframes dsh-ripple { from { opacity: 0.9; transform: translate(-50%, -50%) scale(0.4); } ' +
      'to { opacity: 0; transform: translate(-50%, -50%) scale(5); } }',
    '@keyframes dsh-fade { from { opacity: 1; } to { opacity: 0; } }',
  ].join('\n')
}

/**
 * 交给页面的全部数据。
 *
 * 页面里那两个函数只拿得到这个对象（序列化过去的参数），所以**凡是在页面里要用到的
 * 事实都必须在这里**：容器叫什么、用什么标签、挂什么属性、画什么、多久摘。
 */
export interface OverlayConfig {
  /** 容器 id，也是查它的唯一方式。 */
  id: string
  /** 容器元素的标签名。 */
  containerTag: string
  /** 容器元素挂的属性。**里面没有 role**：有了就会进快照（坑一）。 */
  containerAttributes: Readonly<Record<string, string>>
  /** 标记元素的标签名。 */
  markTag: string
  /** 整张样式表。 */
  css: string
  /** 每种标记怎么画。 */
  marks: Readonly<Record<OverlayKind, MarkPlan>>
  /**
   * 环标记的 class 列表：新环出现时旧环要摘掉。
   *
   * 同时两个圈只会让人看不懂 —— 一个红的失败圈外面套着一个青的读取圈，
   * 谁也说不清刚才到底发生了什么。
   */
  ringClasses: readonly string[]
  /**
   * 动画之外的一道保险（毫秒）。
   *
   * `animationend` 是主路径，但窗口被遮住时动画可能根本不推进、事件也就一直不来，
   * 标记就会永远留在页面上。到点自己摘，标记就绝不会变成常驻垃圾。
   */
  removalSlackMs: number
}

/** 构造交给页面的数据。 */
export function overlayConfig(): OverlayConfig {
  return {
    id: OVERLAY_ID,
    containerTag: 'div',
    containerAttributes: { id: OVERLAY_ID, 'aria-hidden': 'true' },
    markTag: 'div',
    css: overlayStyleSheet(),
    marks: MARK_PLANS,
    ringClasses: (Object.keys(MARK_PLANS) as OverlayKind[])
      .filter((kind) => MARK_PLANS[kind].shape === 'ring')
      .map((kind) => MARK_PLANS[kind].className),
    removalSlackMs: 1_500,
  }
}

/**
 * 读取提示要不要在读取结束时**再画一次**。
 *
 * 提示是在读取**开始**时画的（慢读取期间人也该看得到"它在读"），所以读取比提示自己
 * 还久的时候，提示会在读取结束前就淡掉，看着像"读完没有任何反应"。这时补一次。
 *
 * @param readMs - 这次读取花了多久。
 * @param flashMs - 提示自己亮多久。
 * @returns 是否要补画一次。
 */
export function readFlashNeedsSecondPaint(readMs: number, flashMs: number): boolean {
  return readMs >= flashMs
}

/**
 * 把覆盖层挂到当前文档上。**在页面里运行**，必须自包含。
 *
 * 两条实测事实决定了它的形状：
 *
 *  - `addInitScript` 跑的时刻 `document.readyState === 'loading'` 且
 *    `document.documentElement === null`，所以这里必须有一条 `DOMContentLoaded` 兜底；
 *  - 同一个文档里被调用第二次是常事（`addInitScript` 一次、`framenavigated` 再一次、
 *    画笔自己还会补一次），所以它必须幂等 —— 实测重复执行后容器个数仍然是 1。
 *
 * @param config - 容器叫什么、用什么标签、挂什么属性、以及整张样式表。
 */
export function mountOverlay(config: OverlayConfig): void {
  // 只挂在最外层文档：快照本来就不进 iframe（ADR-0008），覆盖层也不该跑到别人家里去。
  if (window.top !== window) return
  const mount = (): void => {
    if (document.getElementById(config.id) !== null) return
    const root = document.documentElement
    if (root === null) return
    const style = document.createElement('style')
    style.textContent = config.css
    const layer = document.createElement(config.containerTag)
    for (const [name, value] of Object.entries(config.containerAttributes)) layer.setAttribute(name, value)
    root.appendChild(style)
    root.appendChild(layer)
  }
  mount()
  if (document.getElementById(config.id) === null) document.addEventListener('DOMContentLoaded', mount)
}

/**
 * 画一个标记。**在页面里运行**，必须自包含。
 *
 * 它**不负责挂载**：容器不在（页面把它删了、或者接管时那一次挂载还没落地）就什么都不做，
 * 返回 `false` 让调用方知道。挂载有自己的三条路径 —— 接管当前文档、每个新文档的
 * init script、`framenavigated` —— 画笔再插一条只会让"谁负责挂"变得说不清。
 *
 * 标记元素**只从配置数据里造**：页面里不推导标签、不推导 class、不推导时长。
 *
 * @param input - 配置、画哪种、画在哪个点（点标记才用）。
 * @returns 是否真的画上了。
 */
export function paintOverlay(input: {
  config: OverlayConfig
  kind: OverlayKind
  point?: ViewPoint
}): boolean {
  const { config, kind } = input
  const layer = document.getElementById(config.id)
  if (layer === null) return false
  const plan = config.marks[kind]
  if (
    plan.shape === 'point' &&
    (input.point === undefined || !Number.isFinite(input.point.x) || !Number.isFinite(input.point.y))
  ) {
    return false
  }
  // 同类的旧标记先摘掉：这是"重新开始一次动画"，不是"再叠一层"。
  const stale =
    plan.shape === 'ring'
      ? config.ringClasses.map((className) => `.${className}`).join(', ')
      : `.${plan.className}`
  for (const old of [...layer.querySelectorAll(stale)]) old.remove()

  const mark = document.createElement(config.markTag)
  mark.className = plan.className
  if (plan.shape === 'point' && input.point !== undefined) {
    mark.style.left = `${String(input.point.x)}px`
    mark.style.top = `${String(input.point.y)}px`
  }
  layer.appendChild(mark)

  if (plan.lifetimeMs !== undefined) {
    const remove = (): void => {
      mark.remove()
    }
    mark.addEventListener('animationend', remove)
    setTimeout(remove, plan.lifetimeMs + config.removalSlackMs)
  }
  return true
}

/**
 * 把覆盖层上的标记全摘掉，容器留着。**在页面里运行**，必须自包含。
 *
 * 一个用处是"Agent 自己截的那张图里不该有覆盖层"：截之前先清干净，拍到的是页面本身。
 *
 * @param config - 覆盖层配置。
 * @returns 摘掉了几个标记。
 */
export function clearOverlay(config: OverlayConfig): number {
  const layer = document.getElementById(config.id)
  if (layer === null) return 0
  const marks = layer.children.length
  layer.replaceChildren()
  return marks
}
