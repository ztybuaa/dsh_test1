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

/**
 * 没有缩放时的那个值。
 */
export const ZOOM_RESET = 1

/**
 * 一块视图的缩放**归谁管**（票 #19）。
 *
 * 两个值，两句人话：
 *   - `auto`：外壳按栏宽自动适配 —— 页面真的有横向溢出时才动，响应式页面一步都不动
 *     （`shell/fit.js` 的规则）；
 *   - `manual`：人（面板上那颗 `−` / `+` / `100%`）或工具**指名**要的那个值，外壳不再动它。
 *
 * 它放在这个文件里，是因为缩放的**词表**在这里：谁在管缩放与缩放到头了是同一类判断，
 * 而它们都不该只在一块真视图上才测得到。定义放在这里同时避免了一个环：
 * `src/spaces.ts` 与 `src/session.ts` 都认识它，而它们互相认识。
 */
export type ZoomMode = 'auto' | 'manual'

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
 * 面板上那颗按钮该不该亮：还能后退/前进几页。
 *
 * 从票 #18 起，**首选答案是引擎自己的历史**（`Page.getNavigationHistory`），账本只在
 * 拿不到引擎读数时兜底（见 {@link HistorySource}）。
 */
export interface HistoryState {
  /** 还能后退几页。 */
  back: number
  /** 还能前进几页。 */
  forward: number
}

/**
 * 这份 {@link HistoryState} 是从哪读来的（票 #18）。
 *
 * 它是**面板与模型都要看见的一个字段**，不是内部细节：同一个 `{back: 0}` 在两种来源下
 * 是两句不同的话 —— "引擎说退不动"与"我们只是没看见它走过路"。把两者合成一个数
 * 正是票 #18 的成因，所以来源必须跟着数字一起传出去。
 */
export type HistorySource =
  /** 引擎答的（`Page.getNavigationHistory`）：就是这个视图真实的历史。 */
  | 'engine'
  /** 引擎答不上来，退回本会话观察到的账本：可能低估。 */
  | 'observed'

/**
 * 一次历史读数：两个计数，**加上这份数是从哪来的**。
 *
 * `HistoryState` 是它的形状（凡是只要两个数的地方照旧收 `HistoryState`），这一层多出来的
 * 只有来源与失败原因。
 */
export interface EngineHistoryReading extends HistoryState {
  /** 这份读数从哪来，见 {@link HistorySource}。 */
  source: HistorySource
  /** 引擎答不上来时它说的那句话（`source` 为 `observed` 时有）。绝不静默丢掉。 */
  reason?: string
}

/**
 * 引擎的 `Page.getNavigationHistory` 原生返回里我们用到的那两个字段。
 *
 * 只声明用到的：**缺失的那两个字段由 {@link parseEngineHistory} 判成"没读到"**，
 * 而不是当成某个默认值（一个缺字段的回答被当成 `{0, 0}` 会让"读不到"长得像"不能后退"）。
 */
export interface RawEngineHistory {
  currentIndex?: unknown
  entries?: unknown
}

/**
 * 把引擎那份历史收成 {@link HistoryState}。
 *
 * 它是**纯判断**：不碰 CDP、不碰 electron，所以"领养时已经在的那一页算不算一笔""前进分支
 * 有几笔"这些规矩可以在没有浏览器的用例里逐条钉住。
 *
 * 计数是**从索引算出来的**，不是另数一遍：`back = currentIndex`、`forward = 条目数 - 1 - currentIndex`。
 * 这与 {@link ObservedHistory.state} 是同一个算法 —— 同一个问题只许有一个答案的形状。
 *
 * @param raw - 引擎返回的那个对象（或任何东西）。
 * @returns 两个计数，读不动时 `undefined`。
 */
export function parseEngineHistory(raw: unknown): HistoryState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { currentIndex, entries } = raw as RawEngineHistory
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || currentIndex < 0) return undefined
  if (!Array.isArray(entries)) return undefined
  // 索引落在表外时整份读数作废：夹一下会得到一个"引擎没说过"的数。
  if (currentIndex >= entries.length) return undefined
  return { back: currentIndex, forward: entries.length - 1 - currentIndex }
}

/**
 * 引擎历史里**相邻的那一页**（票 #20 F 的第二条）。
 *
 * 悬停在后退/前进上要能说出"会退到哪一页"，而"哪一页"只有引擎知道 ——
 * `Page.getNavigationHistory` 的 `entries[]` 每条都带自己的 `title` 与 `url`，
 * 当前索引 ∓ 1 就是答案。
 */
export interface HistoryNeighbour {
  /** 引擎记下的那一页标题；它没给就是空串（**不编**）。 */
  title: string
  /** 引擎记下的那一页地址。 */
  url: string
}

/** 两个方向各自的目标，读不到的那一侧**缺席**（不是给一个空对象）。 */
export interface EngineHistoryNeighbours {
  /** 后退会去的那一页。 */
  back?: HistoryNeighbour
  /** 前进会去的那一页。 */
  forward?: HistoryNeighbour
}

/**
 * 从同一份引擎历史里读两个相邻页。
 *
 * 与 {@link parseEngineHistory} 分开是为了让"能不能退"照旧只依赖那两个计数：一条新的读法
 * 不该让旧判断多一个失败点。两份读的是**同一个** `raw`，所以不会互相矛盾。
 *
 * 索引落在表外、条目不是对象、字段不是字符串 —— 一律**缺席**，绝不编一个标题：
 * 悬停提示说"会退到 X"而 X 是编的，比什么都不说更坏。
 *
 * @param raw - 引擎返回的那个对象（或任何东西）。
 * @returns 两个方向的目标（各自可能缺席）。
 */
export function parseEngineNeighbours(raw: unknown): EngineHistoryNeighbours {
  if (typeof raw !== 'object' || raw === null) return {}
  const { currentIndex, entries } = raw as RawEngineHistory
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || currentIndex < 0) return {}
  if (!Array.isArray(entries)) return {}
  const at = (index: number): HistoryNeighbour | undefined => {
    if (index < 0 || index >= entries.length) return undefined
    const entry = entries[index] as { title?: unknown; url?: unknown } | null
    if (typeof entry !== 'object' || entry === null) return undefined
    const title = typeof entry.title === 'string' ? entry.title : ''
    const url = typeof entry.url === 'string' ? entry.url : ''
    if (title === '' && url === '') return undefined
    return { title, url }
  }
  const back = at(currentIndex - 1)
  const forward = at(currentIndex + 1)
  return { ...(back !== undefined ? { back } : {}), ...(forward !== undefined ? { forward } : {}) }
}

/**
 * 观察到的历史：两个计数，加一条"看到新文档了"的规矩。 *
 * 它是**可变的记账本**，但规矩只有一条，所以整个类就是那个规矩本身：
 * 新文档一来，前进侧清空（浏览器就是这么做的：走新路会把旧的前进分支丢掉）。
 *
 * ## 它从票 #18 起的身份：**兜底**，不是权威
 *
 * 权威是引擎的 `Page.getNavigationHistory`（见 {@link parseEngineHistory}）—— 那条路天然包含
 * "领养时视图已经在的那一页"，也不怕会话被重建。账本只在**引擎答不上来**时被读（CDP 会话
 * 建不起来、或者那台引擎不认这个域），因为它的答案有一道已知的裂缝：
 *
 * - 它**可能低估**：会话领养之前走过的路不在账上（票 #18 的症状就是这个 —— 引擎里明明有一格
 *   可以退，而账本说没有，于是工具条上的后退被灰掉）；
 * - 它**不会凭空乐观**：它不会说"可以后退"而实际退不动。
 *
 * 所以读到账本时，{@link HistorySource} 会说 `observed`。**一个数单独出现是不够的**：
 * "引擎说退不动"和"我们只是没看见它走过路"必须是两句不同的话。
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
