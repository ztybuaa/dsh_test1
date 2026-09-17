/**
 * 面板工具条与宿主之间那条 RPC 的**契约本身**（T13）。
 *
 * 这里只有名字与形状，没有实现 —— 因为这条契约有**两个**消费者：宿主半边（在 `dsh` 进程里，
 * 用它已有的那条 CDP 会话驱动视图）与客户端半边（在外壳窗口里那个页面里，画那条工具条）。
 * 两边都要用同一组名字，而"同一组名字写两遍"就是它们迟早对不上的地方。
 *
 * ## 为什么是这条通道，不是 `connection.rpc.handle`
 *
 * ADR-0003 定的是"走载体无关的 RPC"，本文件用的是同一个包的 **`ctx.connection.fetch.register`**
 * 那一半。原因是量出来的：`@deepseek-ai/dsh-client-connection@0.1.5-rc.2` 的
 * `ctx.connection.rpc.handle()` 对**任何** ctx 都抛 `cannot get property "webServer" without inject`
 * —— 它注册路由时读 `owner.webServer`（`lib/index.js:618`），而同一个包的 `inject` 只有
 * `["credentials"]`（`lib/index.js:736`）。`fetch.register` 是第一方插件自己在用的那条
 * （`dsh-client-file-upload/lib/index.js:170-175`、`dsh-api-session-controller`），
 * 不读 `webServer`，走的是**同一条共享 `/api` 通道**。
 * 完整原始栈、四条失败走法与门禁实测见 `docs/research/t13-the-panel-can-drive-the-view-over-rpc.md`
 * 与 `docs/adr/0013-*.md`。
 *
 * ## 通道与路径的形状（两条都是量出来的约束，不是风格）
 *
 * - **channel 必须是 `/api`**：客户端 `assertTarget` 的 `CHANNEL_PATTERN` 只允许单段
 *   （`lib/client.js:6186`），带 `/` 的 channel 连调用都发不出去。
 * - **端点带 `desktop-view-` 前缀**：`/api` 是共享通道，第一方自己的端点也在上面
 *   （`credentials/*`、`session/*`、`desktop-view-*` 必须不撞车）。前缀就是这个命名空间。
 * - **一条端点一条精确路由**：宿主侧按 `url.pathname` 精确查表（`lib/index.js:576-583`），
 *   没有前缀语义，所以端点名与路由 path 是同一个字符串。
 */

/** 共享通道名。单段是客户端的硬约束。 */
export const VIEW_RPC_CHANNEL = '/api'

/** 本插件在共享通道上的命名空间前缀。 */
export const VIEW_RPC_PREFIX = 'desktop-view'

/**
 * 面板可以请求的每一个动作。
 *
 * 四个导航/生命周期动作 + 四个缩放动作，加上一个纯读的 `state`：
 * 值域刻意小而封闭 —— 面板是网页，它的输入是**不可信**的，所以这里没有"带参数的通用命令"，
 * 每一个动作能做的事都在这一行里看得见。
 */
export const VIEW_ACTIONS = [
  'back',
  'forward',
  'reload',
  'restart',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'state',
] as const

/** 面板能请求的动作。 */
export type ViewAction = (typeof VIEW_ACTIONS)[number]

/** 端点名：`desktop-view-state`、`desktop-view-back`、…… */
export function viewEndpoint(action: ViewAction): string {
  return `${VIEW_RPC_PREFIX}-${action}`
}

/** 那条端点在 URL 上的路径：`/api/desktop-view-state`、…… */
export function viewEndpointPath(action: ViewAction): string {
  return `${VIEW_RPC_CHANNEL}/${viewEndpoint(action)}`
}

/** 面板一次调用要带的东西。`zoom` 现在没用上（缩放走固定档位的三个动作），留着是为了形状稳定。 */
export interface ViewRequest {
  /** 调用方随手带的关联号，原样回显，便于在日志里对上一次点击。 */
  nonce?: string
}

/**
 * 面板读到的那份状态 —— **每一项都来自宿主的一次独立读回**，没有一项是面板自己的局部变量。
 *
 * 这是票面明写的："面板显示的东西必须来自独立读回"。所以连"能不能后退"也是宿主那边
 * **问引擎**得到的（`Page.getNavigationHistory`，票 #18；引擎答不上来才退回会话观察到的
 * 账本，见 `src/navigation.ts`），而不是面板记的。
 */
export interface ViewState {
  /** 视图现在的地址，读自视图自己。 */
  url: string
  /** 当前页面的标题。 */
  title: string
  /** 现在是多少（1 = 100%）。 */
  zoom: number
  /** 页面自己读到的 `devicePixelRatio`（缩放会拨它）。 */
  devicePixelRatio: number
  /** 页面自己读到的视口宽度（CSS 像素）。 */
  innerWidth: number
  /** 页面自己读到的视口高度。 */
  innerHeight: number
  /** 视图的历史里还有没有可后退的一页（引擎自己的历史，不是谁记的）。 */
  canGoBack: boolean
  /** 还有没有可前进的一页。 */
  canGoForward: boolean
  /**
   * 上面那两个数是**从哪里读来**的（票 #18）：`engine` 是引擎自己的历史，`observed` 是
   * 引擎答不上来时退回本会话观察到的账本。
   *
   * 面板暂时不显示它（不多长一颗灯），但它是宿主那一侧的一件事实，放在同一份读回里
   * 才不会与那两个数各说各话。
   */
  historySource: 'engine' | 'observed'
  /** 「重新开始」会去哪一页（外壳握手发布的那句）。 */
  restartTarget: string
  /** 那次动作成不成。 */
  ok: boolean
  /** 给**人**看的那一句话（面板把它显示出来，所以失败时它就是"为什么不能"）。 */
  message: string
  /** 失败分类之一，成功时缺席。 */
  reason?: string
}

/**
 * 判定一次面板请求的动作名。
 *
 * **不信任输入**：面板是网页，虽然它只由我们自己发布，但"命令行里那个字符串到了宿主就当成
 * 已知动作"是一个不必要的信任。认不出来的名字一律抛，绝不猜一个默认动作 —— 一个悄悄变成
 * `reload` 的未知动作会让用户以为自己按的是别的按钮。
 *
 * @param value - 请求里那个动作名。
 * @returns 那个动作。
 * @throws TypeError 当它不是 {@link VIEW_ACTIONS} 里的一个。
 */
export function parseViewAction(value: unknown): ViewAction {
  if (typeof value === 'string' && (VIEW_ACTIONS as readonly string[]).includes(value)) return value as ViewAction
  throw new TypeError(
    `desktop-view: unknown view action ${JSON.stringify(value)}; it must be one of ${VIEW_ACTIONS.join(', ')}`,
  )
}
