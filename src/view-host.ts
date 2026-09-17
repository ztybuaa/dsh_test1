import type { Context } from '@deepseek-ai/cordis'
import type { AdoptedViewSession } from './session.ts'
import {
  VIEW_ACTIONS,
  VIEW_RPC_CHANNEL,
  parseViewAction,
  viewEndpointPath,
  type ViewAction,
  type ViewState,
} from './view-rpc.ts'

/**
 * 工具条那半边：面板点一下，宿主去驱动视图（T13）。
 *
 * ## 它为什么长这样
 *
 * 面板是**外壳窗口里的一个网页**，要驱动的是**原生视图**。仓库里有一条明确的边界
 * （`shell/preload.js` 顶部）：那条 preload 桥只搬矩形，别的什么都不许过境，驱动视图走 CDP。
 * 所以这里不新增任何"命令通道"：宿主半边用的是**它已经在用的那条 CDP 会话**，经 ADR-0003
 * 那条载体无关的 RPC 接进来。于是：
 *
 *  1. **同一套会话能力**同时服务 Agent 的工具与人的按钮 —— 两边都走 `adopt()`，拿到的是同一个
 *     `AdoptedViewSession` 类，同一个活动空间；
 *  2. `shell/preload.js` 一个字节不动，那句边界注释继续为真；
 *  3. 这是**既有**通道（共享 `/api` 通道上的精确路由），不是新通道。
 *
 * ## 它与工具的关系
 *
 * 这里**不**复制任何判断："能不能后退"来自会话观察到的历史，"缩放到头了"来自
 * `src/navigation.ts` 的档位表，失败分类来自同一个 `classifyNavigationFailure`。
 * 这一层只做三件事：把动作名翻译成一次会话调用、把结果收成 {@link ViewState}、把异常收成
 * 一句话而不是一个 500 —— 面板上那颗按钮按下之后必须**总能**说点什么。
 */

/** 注册进宿主的那条路由（`fetch.register` 的形状，见 `docs/adr/0013-*.md`）。 */
interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

/** 宿主连接服务上我们要用的那一小块。 */
interface ConnectionLike {
  fetch: { register(route: FetchRoute): () => Promise<void> }
}

/**
 * 把会话那半边的一次调用收成面板要的一份状态。
 *
 * 状态是**动作之后**读的（`displayState()` 一次读完），所以面板上那几样东西
 * 描述的是同一个瞬间，而不是"动作前读了两样、动作后读了三样"。
 *
 * @param session - 活动会话。
 * @param action - 已经解析过的动作。
 * @returns 给面板的 {@link ViewState}。
 */
async function runAction(session: AdoptedViewSession, action: ViewAction): Promise<ViewState> {
  /** 动作做完之后，一次读回面板要显示的一切。 */
  const readBack = async (ok: boolean, message: string, reason?: string): Promise<ViewState> => {
    const state = await session.displayState()
    return {
      url: state.url,
      title: state.title,
      zoom: state.zoom,
      ...(state.zoomMode !== undefined ? { zoomMode: state.zoomMode } : {}),
      devicePixelRatio: state.devicePixelRatio ?? Number.NaN,
      innerWidth: state.innerWidth ?? Number.NaN,
      innerHeight: state.innerHeight ?? Number.NaN,
      canGoBack: state.history.back > 0,
      canGoForward: state.history.forward > 0,
      historySource: state.historySource,
      restartTarget:
        state.initialUrl ?? '(no initial page: the shell published none, so this goes to a blank page)',
      ok,
      message,
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  try {
    if (action === 'state') return await readBack(true, 'nothing was changed')
    if (action === 'restart') {
      const restarted = await session.restart()
      return await readBack(true, `restarted at ${restarted.url} and reset the zoom to 100%`)
    }
    // 票 #19：「自动」——把这一格交回按栏宽自动适配。它没有目标值可给（那个值由外壳按
    // 页面自己的溢出算），所以结果只能**读回来**：`useAutoZoom` 返回的是外壳在适配跑完之后
    // 读回的那个数。
    if (action === 'auto') {
      const result = await session.useAutoZoom()
      return await readBack(
        true,
        `handed this pane back to automatic fitting: the zoom is now ${Math.round(result.zoom * 100)}% ` +
          `(layout viewport ${result.innerWidth}x${result.innerHeight} CSS px)`,
      )
    }
    if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
      const before = session.zoomLevel()
      const result =
        action === 'zoom-reset'
          ? await session.resetZoom()
          : await session.stepZoom(action === 'zoom-in' ? 1 : -1)
      return await readBack(
        true,
        `zoom ${Math.round(before * 100)}% → ${Math.round(result.zoom * 100)}% (layout viewport is now ` +
          `${result.innerWidth}x${result.innerHeight} CSS px)`,
      )
    }
    const result =
      action === 'back' ? await session.goBack() : action === 'forward' ? await session.goForward() : await session.reload()
    return await readBack(
      result.moved,
      result.moved
        ? `${action === 'reload' ? 'reloaded' : `went ${action} to`} ${result.url}`
        : (result.message ?? `${action} did not happen`),
      result.reason,
    )
  } catch (error) {
    // 到头了、会话关了、页面正在换文档读不回来…… 都会到这里。面板上那颗按钮按下之后必须
    // **总能**说点什么，所以这里绝不把异常漏成 500：那句话就是面板要显示的东西。
    const message = error instanceof Error ? error.message : String(error)
    try {
      return await readBack(false, message, error instanceof RangeError ? 'at-limit' : 'failed')
    } catch {
      // 连读回都失败了（会话已经关了）：给一句话，字段用空值，面板显示"读不到"。
      return {
        url: '',
        title: '',
        zoom: Number.NaN,
        devicePixelRatio: Number.NaN,
        innerWidth: Number.NaN,
        innerHeight: Number.NaN,
        canGoBack: false,
        canGoForward: false,
        historySource: 'observed',
        restartTarget: '',
        ok: false,
        message,
        reason: 'unreadable',
      }    }
  }
}

/**
 * 注册面板那条通道。
 *
 * 每条动作**一条精确路由**（共享通道按 `url.pathname` 精确查表，没有前缀语义），
 * 端点名就是路由 path 的最后一段 —— 客户端的 `rpc.call('/api', 'desktop-view-back')`
 * 发出的正是 `POST /api/desktop-view-back`。
 *
 * @param ctx - 宿主上下文；`connection` 必须已经被注入（调用方负责）。
 * @param adopt - 与工具用的是**同一个**会话解析器（同一套能力的那半句话在这里落地）。
 * @returns 注册出去的那些 disposer。
 */
export function registerViewRpc(
  ctx: Context,
  adopt: () => Promise<AdoptedViewSession>,
): Array<() => Promise<void>> {
  const connection = (ctx as unknown as { connection?: ConnectionLike }).connection
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
    // 说清是哪一样东西不在，而不是让调用方去对着 `reading 'fetch'` 猜。
    // `inject` 里已经声明了 `connection`，所以这条正常情况下不会走到 ——
    // 它存在是为了"某个宿主把服务拿掉"时这里有一句人话。
    throw new Error(
      'desktop-view: this host does not expose the carrier-neutral RPC service (`ctx.connection.fetch`), so the ' +
        'panel\'s toolbar has nothing to call. The tools are unaffected; the buttons will report this on press. ' +
        'Declaring `connection` in this plugin\'s `inject` is what normally guarantees it is here.',
    )
  }
  const disposers: Array<() => Promise<void>> = []
  for (const action of VIEW_ACTIONS) {
    const path = viewEndpointPath(action)
    disposers.push(
      connection.fetch.register({
        path,
        methods: ['POST'],
        // JSON 信封就够：这里一次调用最多带一个 nonce。`streaming` 是给上传那种字节流用的。
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown } = {}
          try {
            envelope = (await request.json()) as typeof envelope
          } catch {
            return new Response('body is not JSON', { status: 400 })
          }
          // 信封的三件事都要对得上：方向、终点、关联号。对不上就**不执行** ——
          // 一个"信封不对但动作照做"的实现会让关联号与结果对不上而没人发现。
          if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string') {
            return Response.json({
              type: 'server-response',
              rpcId: 'invalid-request',
              result: { ok: false, error: { code: 'desktop-view/bad-envelope', message: 'invalid client-request message', details: {} } },
            })
          }
          const expected = `${path.slice(VIEW_RPC_CHANNEL.length + 1)}`
          if (envelope.method !== expected) {
            return Response.json({
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'desktop-view/bad-endpoint',
                  message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(expected)}`,
                  details: {},
                },
              },
            })
          }
          let value: ViewState
          try {
            const requested = parseViewAction(action)
            const session = await adopt()
            value = await runAction(session, requested)
          } catch (error) {
            // 到这里只可能是"解析动作"或"领养视图"失败：动作名来自我们自己的常量表，
            // 领养失败则要如实说（没有外壳、端点连不上），不能变成一句没有下文的 500。
            const message = error instanceof Error ? error.message : String(error)
            return Response.json({
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: { ok: false, error: { code: 'desktop-view/unavailable', message, details: {} } },
            })
          }
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
        },
      }),
    )
  }
  return disposers
}
