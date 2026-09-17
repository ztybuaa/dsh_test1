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

import type { ZoomMode } from './navigation.ts'

/** 共享通道名。单段是客户端的硬约束。 */
export const VIEW_RPC_CHANNEL = '/api'

/** 本插件在共享通道上的命名空间前缀。 */
export const VIEW_RPC_PREFIX = 'desktop-view'

/**
 * 面板可以请求的每一个动作。
 *
 * 四个导航/生命周期动作 + 四个缩放动作 + 一个**交回自动适配**的动作（票 #19），加上一个纯读的
 * `state`：值域刻意小而封闭 —— 面板是网页，它的输入是**不可信**的，所以这里没有"带参数的通用命令"，
 * 每一个动作能做的事都在这一行里看得见。
 *
 * `auto` 是票 #19 加的那一个，也是**唯一**能让人从"手动缩放"回到"自动适配"的动作：自动适配
 * 一旦被人指名过的缩放顶掉，就不会自己回来（换页也不行 —— 那是 #13 定下的语义：换页不丢缩放）。
 * 所以必须有一个说得出口的动作把它交回去，否则那个模式就是一个出不来的状态。
 *
 * 票 #20 加了两个**带参数**的动作，它们是这条"小而封闭"的规矩下仅有的两个例外，
 * 而且各自那个参数都被**收窄进一张表**：
 *
 *  - `navigate`：地址栏回车。参数是一个地址，宿主侧按 {@link parseNavigationUrl} 收；
 *  - `zoom-to`：档位菜单里选了一个档位。参数**必须**是 `src/toolbar.js` 那张档位表里的一个，
 *    所以这条通道上依然不存在"缩放到任意值"这种通用命令（任意值是 Agent 工具那条路的）。
 */
export const VIEW_ACTIONS = [
  'back',
  'forward',
  'reload',
  'restart',
  'navigate',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'zoom-to',
  'auto',
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

/** 面板一次调用要带的东西。 */
export interface ViewRequest {
  /** 调用方随手带的关联号，原样回显，便于在日志里对上一次点击。 */
  nonce?: string
  /** `navigate` 的目标地址（票 #20 A）。别的动作不许带它。 */
  url?: string
  /** `zoom-to` 的目标倍数（票 #20 D），1 = 100%。别的动作不许带它。 */
  zoom?: number
}

/**
 * 地址栏那条路上**允许**的协议（票 #20 A）。
 *
 * 表刻意小，而且与 `src/toolbar.js` 的 {@link parseAddress} 是同一组：地址栏能去的地方就是
 * 这几类。`javascript:` / `data:` / `blob:` / `mailto:` 一律拒 —— 这条通道的另一端是**外壳窗口里
 * 的一个网页**，让它把任意协议塞进原生视图是没必要的口子。
 */
const NAVIGATION_SCHEMES = ['http:', 'https:', 'file:', 'about:']

/**
 * 面板那颗百分比给出的标准档位（票 #20 D），单位是百分比。
 *
 * **这一份与 `src/toolbar.js` 里那份是同一张表，而且是刻意写两遍的**：客户端半边是被
 * `scripts/build-client.mjs` 拼出来的**自足**脚本（它连 `src/navigation.ts` 都 require 不到），
 * 而宿主这一侧必须能**自己**判断"这个档位是不是真的存在"——不信客户端说它规范化过了。
 * 两份对不上就是一条会被拒绝的点击，所以 `tests/toolbar.spec.ts` 从两侧各读一遍逐项比对，
 * 与 `VIEW_ACTIONS` 那组名字用的是同一条规矩。
 */
export const ZOOM_PRESETS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]

/**
 * 把地址栏那一串字收成一个**能交给会话去导航**的地址。
 *
 * **不信任输入**：面板是网页，`payload.url` 是它给的。所以这里不信"客户端已经规范化过了"
 * （`parseAddress` 的那条补 `https://` 的规则在客户端，但一个被改过的页面可以直接调用端点），
 * 而是**在这里再收一次**：必须是一个能解析的 URL，而且协议在 {@link NAVIGATION_SCHEMES} 里。
 *
 * @param value - 请求里那个 `url`。
 * @returns 收好的地址。
 * @throws TypeError 当它不是字符串、解析不了、或协议不在表里。
 */
export function parseNavigationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('desktop-view: navigating needs a non-empty `url` string')
  }
  const raw = value.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new TypeError(`desktop-view: ${JSON.stringify(raw)} is not an address that can be opened here`)
  }
  if (!NAVIGATION_SCHEMES.includes(parsed.protocol)) {
    throw new TypeError(
      `desktop-view: ${JSON.stringify(parsed.protocol)} addresses cannot be opened here; ` +
        `this pane opens ${NAVIGATION_SCHEMES.join(', ')} addresses`,
    )
  }
  return raw
}

/**
 * 把档位菜单那一按收成一个缩放倍数（票 #20 D）。
 *
 * 只收**表里的档位**：面板能要的缩放值就是那几个（与 `−`/`+` 走过的 `ZOOM_STEPS` 同一串数），
 * 所以这条通道上没有"任意缩放"这种命令。任意缩放走 Agent 的工具，不在这里。
 *
 * @param value - 请求里那个 `zoom`。
 * @returns 合法且是档位的倍数。
 * @throws TypeError 当它不是数字、或不是表里的档位。
 */
export function parseZoomPreset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`desktop-view: a zoom preset needs a numeric \`zoom\`, got ${JSON.stringify(value)}`)
  }
  // 表从 `src/toolbar.js` 那一份来（面板显示的就是它）；这里用**四舍五入到整数百分比**比对，
  // 免得 0.6700000000000001 这种浮点尾巴把一次合法的选择判成非法。
  const percent = Math.round(value * 100)
  if (Math.abs(percent / 100 - value) > 1e-6 || !ZOOM_PRESETS.includes(percent)) {
    throw new TypeError(
      `desktop-view: ${String(value)} is not one of the zoom presets this pane offers ` +
        `(${ZOOM_PRESETS.join(', ')} percent)`,
    )
  }
  return percent / 100
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
  /**
   * 那个缩放**归谁管**（票 #19）：`auto` = 外壳按栏宽自动适配，`manual` = 人（或工具）指名的。
   *
   * 面板把这件事**显示出来**（"自动 78%" / "手动 90%"）：票面点名要求"不许让人看不出来"。
   * 缺席 = 读不到（旧外壳、或这会话没有可问的外壳）—— 那时面板只显示百分比，不编一个模式。
   */
  zoomMode?: ZoomMode
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
  /**
   * 这一页**还在加载中**吗（票 #20 F 的第一条），读自页面自己的 `document.readyState`。
   *
   * 它是页面说的一句话，不是外壳的猜测：`loading` 的判据就是"`readyState` 不是 `complete`"。
   * 读不到（正在换文档、页面抛了）时**缺席**，面板就不显示那个提示 —— 与别处同一条规矩：
   * 读不到 ≠ 猜一个。
   */
  loading?: boolean
  /**
   * 悬停在后退/前进上时会去哪一页（票 #20 F 的第二条），**从引擎自己的导航历史里读**
   * （当前索引的前一条/后一条），不是谁记的。读不到就缺席，那时按钮上一个字的提示都不给。
   */
  backTarget?: { title: string; url: string }
  /** 见 {@link ViewState.backTarget}。 */
  forwardTarget?: { title: string; url: string }
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
