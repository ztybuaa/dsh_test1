/**
 * 导航与缩放里那些**纯判断**。
 *
 * 为什么单独一个文件：这一票的能力有两张脸 —— Agent 的工具与面板上的按钮 —— 而两张脸
 * 共用同一套判断（"什么时候算缩放到头了""这个 zoom 该不该被接受""这次失败是哪一类"）。
 * 把这些判断留在 `session.ts` 里会让它们只能靠一块真视图才测得到；放在这里，
 * 它们**不需要 electron、不需要浏览器**就能被逐条钉住。
 *
 * 这个文件**不 require 任何东西**（连 `node:` 都不）。
 */

/**
 * 缩放档位：面板上 `−` / `+` 一步步走过的那些值。
 *
 * 它必须是**有限的一串**而不是"每次乘 1.1"：一个人按十次 `+` 之后要能回到同一个地方，
 * 而浮点乘法来回乘除不保证这一点（0.1 + 0.2 那类误差会让 `+` 十次再 `−` 十次回不到 100%）。
 */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** 没有缩放时的那个值。 */
export const ZOOM_RESET = 1

/**
 * 接受的缩放范围。
 *
 * 下界 0.25 / 上界 5 是 Chromium 自己的浏览器缩放范围，取同一对数字是为了让"缩放到头了"
 * 与用户在任何别的浏览器里得到的直觉一致。**不是**因为我们在模拟浏览器缩放（我们不模拟）。
 */
export const ZOOM_MIN = ZOOM_STEPS[0]
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/**
 * 把任意外部输入收成一个合法的缩放值。
 *
 * 收不进来的**抛**，不静默夹到边界：一个被夹过的 1 与一个真的 1 在面板上长得一模一样，
 * 而"你要的 100 倍我给了你 5 倍"是必须说出来的一句话（本仓库对"悄悄降级"的一贯取舍）。
 *
 * @param value - 调用方给的缩放值。
 * @returns 合法的缩放值。
 * @throws TypeError 当它不是一个有限的正数。
 * @throws RangeError 当它在 {@link ZOOM_MIN}–{@link ZOOM_MAX} 之外。
 */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`zoom must be a finite number, got ${JSON.stringify(value)}`)
  }
  if (value < ZOOM_MIN || value > ZOOM_MAX) {
    throw new RangeError(`zoom must be between ${ZOOM_MIN} and ${ZOOM_MAX}, got ${String(value)}`)
  }
  return value
}

/**
 * 相对当前值走一步。
 *
 * @param current - 现在是多少（可以是档位之外的任意合法值）。
 * @param direction - `1` 放大一档，`-1` 缩小一档。
 * @returns 下一档。
 * @throws RangeError 当已经到头（再走就出界）—— "到头了"是一个必须说出来的结果，
 *   不是"什么也没发生"。
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    for (const step of ZOOM_STEPS) {
      if (step > current + 1e-9) return step
    }
    throw new RangeError(`zoom is already at its maximum (${ZOOM_MAX}); it cannot go higher`)
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index--) {
    const step = ZOOM_STEPS[index]
    if (step < current - 1e-9) return step
  }
  throw new RangeError(`zoom is already at its minimum (${ZOOM_MIN}); it cannot go lower`)
}

/**
 * 把一个缩放值变成"布局视口该有多大"。
 *
 * 缩放的定义就是**视口按比例变小**：`1200px` 宽的页面在 `zoom = 2` 时落在 `600` 个 CSS 像素里，
 * 于是它在屏幕上占的**物理**面积不变，而能看到的内容翻倍。这也是量出来的唯一一条真的
 * 会改变布局视口的路（见 `docs/research/t13-zoom-four-roads-measured.md`）。
 *
 * `floor` 而不是 `round`：宁可多给一个像素的视口，也不要因为四舍五入把最后一条像素挤出去
 * （缩放到 `1.94` 时 `620 / 1.94 = 319.58` —— 取 319 时内容整条可见，取 320 时会多出一条缝）。
 *
 * @param source - 视图**本来**的视口尺寸（没有缩放时的那些 CSS 像素）。
 * @param zoom - 缩放值。
 * @returns 该用的模拟视口尺寸，两边都不小于 1。
 */
export function scaledViewport(
  source: { width: number; height: number },
  zoom: number,
): { width: number; height: number } {
  const normalize = (value: number): number => Math.max(1, Math.floor(value / zoom))
  return { width: normalize(source.width), height: normalize(source.height) }
}

/**
 * 一次导航类动作为什么没做成。
 *
 * 三个值而不是一个 `failed`，因为它们各自的**补救**不同：`no-history` 要用户先走一段路，
 * `page-refused` 要在页面上处理（未保存的改动），`timeout` 值得重试（T4 的做法）。
 */
export type NavigationFailureReason =
  /** 视图没有那一段历史：没有可后退/可前进的那一页。 */
  | 'no-history'
  /** 页面自己的守卫拦住了（`beforeunload`），导航没有发生。 */
  | 'page-refused'
  /** 在超时之内没有走完。 */
  | 'timeout'
  /** 引擎报的别的错，原文在 message 里。 */
  | 'failed'

/**
 * 一次导航类动作的结果：发生了就带地址，没发生就带原因。
 *
 * 与 `ViewActionError` 同一形状（值 + 人话），因为同一个理由：调用方要能**不解析散文**地分支。
 */
export interface NavigationOutcome {
  /** 动作是否真的发生了。 */
  ok: boolean
  /** 动作之后视图的地址（`ok` 为真时才有意义，但仍然如实带回）。 */
  url: string
  /** 页面的标题，读不到时是空串。 */
  title: string
  /** 没做成时的分类。 */
  reason?: NavigationFailureReason
  /** 没做成时那句话。 */
  message?: string
}

/**
 * 把引擎/引擎之上的一个错误归到三类里。
 *
 * 判定只依赖**错误本身带着的事实**，不依赖调用点：Playwright 对"没有那一页历史"报的是
 * 一句固定措辞的 `Error`，超时报的是 `TimeoutError`，页面守卫那条由调用方先判（它要先看
 * 对话框记录，见 `session.goto` 的 T9 做法）。分类**互不混淆**是这一票的验收之一，
 * 所以每一条都有一个自己的正则/名字，且顺序明确。
 *
 * @param error - 抛出来的东西。
 * @param guarded - 调用方是否已经判定"页面守卫拦住了"。
 * @returns 分类与那句人话。
 */
export function classifyNavigationFailure(
  error: unknown,
  guarded: boolean,
): { reason: NavigationFailureReason; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (guarded) return { reason: 'page-refused', message }
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || /\btimeout\b/i.test(message)) return { reason: 'timeout', message }
  // Playwright 在历史到头时抛的那一句（"Cannot go back" / "Cannot go forward"）。
  // 它是**唯一**能区分"没有那一页"与"页面拒绝了"的信号，所以按原文匹配而不是按名字。
  if (/cannot go (back|forward)/i.test(message)) return { reason: 'no-history', message }
  if (/no (page|history|entry)/i.test(message)) return { reason: 'no-history', message }
  return { reason: 'failed', message }
}

/**
 * 面板上那颗按钮该不该亮。
 *
 * **为什么是"观察到的历史"而不是"问引擎"**：Playwright 没有"能不能后退"这种只读 API
 * （`goBack`/`goForward` 是动作，不是查询），而 `history.length` 在同源内是对的、跨源就不可靠。
 * 所以这里回答的是**这个会话自己看着它走过的那些页**：每挂上一个新文档就记一笔，
 * 从 A 走到 B 再走到 C 就有两笔可后退；后退之后前进那一侧又有了一笔。
 *
 * 它因此**可能低估**（会话领养之前走过的路不在账上），也**不可能凭空乐观**
 * （它不会说"可以后退"而实际退不动）。低估的代价是按钮一开始是灰的，而用户按一次
 * 真正的动作就会把它点亮；高估的代价是用户按了一颗撒谎的按钮 —— 后者更糟。
 */
export interface HistoryState {
  /** 还能后退几页（会话自己观察到的）。 */
  back: number
  /** 还能前进几页（会话自己观察到的）。 */
  forward: number
}

/**
 * 观察到的历史：两个计数，加一条"看到新文档了"的规矩。
 *
 * 它是**可变的记账本**，但规矩只有一条，所以整个类就是那个规矩本身：
 * 新文档一来，前进侧清空（浏览器就是这么做的：走新路会把旧的前进分支丢掉）。
 */
export class ObservedHistory {
  private visited: string[] = []
  private index = -1

  /**
   * 记下"视图现在在这个地址上"。
   *
   * 同一个地址连着来两次只记一笔：`framenavigated` 会对一次导航报多次
   * （同文档导航、重定向都算），而把同一页记成两笔会让"还能后退 2 页"变成谎话。
   *
   * @param url - 新文档的地址。
   */
  observe(url: string): void {
    if (this.visited[this.index] === url) return
    this.visited = this.visited.slice(0, this.index + 1)
    this.visited.push(url)
    this.index = this.visited.length - 1
  }

  /**
   * 记下"后退/前进发生了"。
   *
   * 它不问引擎，只按方向挪一格：能挪才挪，挪不动就**如实说挪不动**（返回 false）。
   *
   * @param direction - `-1` 后退，`1` 前进。
   * @returns 是否真的挪动了。
   */
  move(direction: -1 | 1): boolean {
    const next = this.index + direction
    if (next < 0 || next >= this.visited.length) return false
    this.index = next
    return true
  }

  /** 现在的两个计数。 */
  state(): HistoryState {
    return { back: this.index, forward: Math.max(0, this.visited.length - 1 - this.index) }
  }

  /**
   * 把账本清成"只有这一页"。
   *
   * 「重新开始」用它：重新开始之后视图走的那一段是**新**的历史，
   * 留着上一轮的账会让"还能后退 3 页"指向一些再也回不去的地址。
   *
   * @param url - 现在这一页的地址。
   */
  reset(url: string): void {
    this.visited = [url]
    this.index = 0
  }

  /** 会话自己观察到的那些地址，最旧在前（测试与诊断用）。 */
  entries(): readonly string[] {
    return this.visited
  }
}
