/**
 * T12 探针插件（测试夹具，不发布）。
 *
 * 它回答的是本项目**至今没有一次真实证据**的那几件事里，能自动化的部分：
 *
 *  1. **宿主 `ctx.tools` 注册表本体里到底有没有那 20 条 `browser_*`** —— 不是"插件自己调了
 *     `register()`"，而是从宿主那一侧的服务上读回（`ctx.tools.schemas()` / `ctx.tools.get()`）；
 *  2. **真实宿主里的工具真的能驱动那一格** —— 走 `ctx.tools.execute()`（完整的
 *     policy/dispatch/result 管线，和模型发起的调用同一条路，只差一个模型），
 *     快照 → 点击 → 再读正文，看页面**真的变了**；
 *  3. **截图真的进了部署自己的附件 store** —— 用 `ctx.attachments.readImage()` 把图片**读回来**，
 *     比对字节数与 PNG 魔数。T5 的证据用的是一枚测试替身 store，真实
 *     `LocalAttachmentStore` 在本次之前从未跑过。
 *
 * 三件事都发生在**外壳起着的真宿主**里：环境变量 `DSH_DESKTOP_VIEW_*` 由外壳交给它，
 * 探针只是把这些变量指的那块视图用起来。
 *
 * 它还把**自己的 cwd** 报出来（`shellEnvironment.cwd`）：票 #16 要问的就是"宿主进程的 cwd 是哪个
 * 目录、截图有没有落在它里面"，而这个问题只有进程自己回答得了。
 *
 * 它绝不把异常抛回宿主：所有失败都写进报告文件（`DSH_T12_PROBE_OUT`），由用例读出来判定。
 * 让探针把宿主搞崩，等于把"被测对象没起来"伪装成"探针自己的 bug"。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 't12-probe'

/** 探针要用两样东西：工具注册表本体，以及部署自己的附件 store。 */
export const inject = ['tools', 'attachments']

/**
 * 把任意值收成 JSON 能表达的东西。
 *
 * 工具结果是结构化数据，但也可能是 `Uint8Array`（截图字节）或带不可枚举字段的品牌对象；
 * 报告文件要能被人和用例读，所以二进制只留长度与前 8 个字节。
 *
 * @param {unknown} value - 任意值。
 * @param {number} [depth] - 递归深度，防御自引用。
 * @returns {unknown} 可直接 `JSON.stringify` 的值。
 */
function jsonSafe(value, depth = 0) {
  if (depth > 8) return '[too deep]'
  if (value === null) return null
  const kind = typeof value
  if (kind === 'number' || kind === 'boolean' || kind === 'string') return value
  if (kind === 'undefined') return '[undefined]'
  if (kind === 'bigint') return String(value)
  if (kind === 'function') return '[function]'
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1))
  if (ArrayBuffer.isView(value)) {
    return { byteLength: value.byteLength, head: Array.from(value.slice(0, 8)) }
  }
  if (kind === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, depth + 1)
    return out
  }
  return String(value)
}

/** 睡一会儿：探针在两个异步事实之间等待时用。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 挂载探针。
 *
 * 没有 `DSH_T12_PROBE_OUT` 时**什么都不做**：探针只在一个明确的观察点上干活，
 * 不该在任何别的宿主里留下痕迹。
 *
 * @param {object} ctx - 宿主上下文（`tools` / `attachments` 由 `inject` 担保）。
 */
export function apply(ctx) {
  const out = process.env.DSH_T12_PROBE_OUT
  if (typeof out !== 'string' || out === '') return
  const budgetMs = Number(process.env.DSH_T12_PROBE_TIMEOUT_MS ?? '120000')
  const deadline = Date.now() + (Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 120000)
  const report = {
    plugin: name,
    startedAt: new Date().toISOString(),
    /** 外壳交给这个进程的视图身份：探针要驱动的就是它指的那块视图。 */
    shellEnvironment: {
      cdpUrl: process.env.DSH_DESKTOP_VIEW_CDP ?? null,
      targetId: process.env.DSH_DESKTOP_VIEW_TARGET ?? null,
      viewUrl: process.env.DSH_DESKTOP_VIEW_URL ?? null,
      spacesDir: process.env.DSH_DESKTOP_VIEW_SPACES ?? null,
      /**
       * 宿主进程自己的工作目录 —— **由宿主自己报**，不是用例推算的。
       *
       * 票 #16 要问的正是这个值：截图以前默认落在它里面（`screenshotDir` 默认 `'.'`）。
       * 把它读回来，"cwd 到底是哪个目录""那个目录里有没有多出文件"才是两句可以分开核对的话。
       */
      cwd: process.cwd(),
    },
    steps: [],
    toolCalls: [],
    attachment: null,
    /**
     * 这一格**刚装上时**是什么模式，以及此后有没有人下过缩放命令（票 #19 重开）。
     *
     * 形状与 `channel` 那一步的字段一一对应，见 {@link observeChannel}：本插件自己的工具
     * （`browser_view` 的 restart/zoom）走的就是这条通道，所以"探针自己动了这一格"也会
     * 如实出现在这里，而不是被漏掉。
     */
    channel: null,
    /** 走完整套工具调用（含 `browser_space list`）之后再读一次同一份读数。 */
    channelAfter: null,
    done: false,
  }
  const save = () => {
    try {
      writeFileSync(out, JSON.stringify(report, null, 2))
    } catch {
      // 报告写不出去也不是宿主的事：用例会因为读不到文件而失败，那是它该有的样子。
    }
  }
  const note = (step, detail) => {
    report.steps.push({ step, atMs: Date.now() - Date.parse(report.startedAt), ...detail })
    save()
  }
  save()

  /**
   * 读一次空间通道：外壳发布的空间表与缩放读数，加上"插件有没有写过请求"。
   *
   * 票 #19 重新打开时要问的正是这几件事，而且**只有从宿主进程里问**才作数：真外壳 + 真插件
   * 装上之后，这一格到底是 `auto` 还是 `manual`、`fitPasses` 是不是 0、有没有人在启动时
   * 写过一条请求 —— 从前没有一条用例读过，于是"启动瞬间就是 manual"这个状态谁也没看见。
   *
   * @returns {object} 一份读数（读不到的字段是 null，并带上为什么）。
   */
  const observeChannel = () => {
    const dir = process.env.DSH_DESKTOP_VIEW_SPACES
    const read = (file) => {
      if (typeof dir !== 'string' || dir === '') return { present: false, reason: 'no channel directory was handed to us' }
      try {
        return { present: true, text: readFileSync(join(dir, file), 'utf8') }
      } catch (error) {
        return { present: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    const parse = (file) => {
      const raw = read(file)
      if (raw.present !== true) return { present: false, reason: raw.reason }
      try {
        return { present: true, value: JSON.parse(raw.text) }
      } catch (error) {
        return { present: true, value: null, reason: `unreadable JSON: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const state = parse('state.json')
    const zoom = parse('zoom.json')
    const request = parse('request.json')
    const active = state.value?.active ?? null
    const record = (value) => {
      const spaces = Array.isArray(value?.spaces) ? value.spaces : []
      return spaces.find((entry) => entry?.name === active) ?? null
    }
    return {
      atMs: Date.now() - Date.parse(report.startedAt),
      /** 外壳发布的那张表里，**当前空间**那条记录（`zoom` 与 `zoomMode` 都在里面）。 */
      stateRecord: record(state.value),
      stateRequestId: typeof state.value?.requestId === 'number' ? state.value.requestId : null,
      stateCause: typeof state.value?.cause === 'string' ? state.value.cause : null,
      /** 最新读数（外壳每次缩放/模式/适配都改写它）：`mode`、`modeCause`、两个适配计数。 */
      zoomReading: zoom.value?.spaces?.[active] ?? null,
      zoomCause: typeof zoom.value?.cause === 'string' ? zoom.value.cause : null,
      /** 插件写下去的那条请求，**原样**（有没有人在启动时写过命令，看这里）。 */
      requestPresent: request.present,
      request: request.value ?? null,
      requestRaw: request.present === true ? read('request.json').text : null,
    }
  }

  // 第一件事就把它读下来：此刻还没有任何工具被调用过，所以"启动时这一格是什么模式"问的
  // 就是这一份。后面的步骤会再读一次，两次一比就知道有没有人在启动之后动过它。
  report.channel = observeChannel()
  note('channel-at-mount', report.channel)

  void (async () => {
    const abort = new AbortController()
    let calls = 0

    /**
     * 经**宿主注册表**执行一条工具。
     *
     * `ctx.tools.execute()` 是模型调用走的同一条管线（参数快照、policy、dispatch、结果归一化），
     * 所以它比直接抓 `ToolDefinition.execute` 更接近"Agent 真的调了一次工具"。
     * 原始结果与 JSON 化结果都留着：附件的品牌引用只有原始那个能用。
     *
     * @param {string} toolName - 工具名。
     * @param {object} args - 入参。
     * @returns {Promise<{raw: unknown, safe: object}>} 原始结果与可序列化的摘要。
     */
    const call = async (toolName, args) => {
      calls += 1
      const summary = { tool: toolName, arguments: jsonSafe(args) }
      let raw
      try {
        raw = await ctx.tools.execute({
          callId: `${name}-${calls}`,
          name: toolName,
          arguments: args,
          signal: abort.signal,
        })
        summary.isError = raw?.isError === true
        if (raw?.error !== undefined) summary.error = jsonSafe(raw.error)
        summary.value = jsonSafe(raw?.value)
        summary.content = jsonSafe(raw?.content)
      } catch (error) {
        summary.threw = error instanceof Error ? error.message : String(error)
      }
      report.toolCalls.push(summary)
      save()
      return { raw, safe: summary }
    }

    try {
      // ── 1. 注册表本体：等本插件的工具真的出现，再把整张表读回来 ──────────────
      const waitStart = Date.now()
      while (Date.now() < deadline && ctx.tools.get('browser_navigate') === undefined) {
        await sleep(200)
      }
      const schemas = ctx.tools.schemas() ?? []
      const names = schemas
        .map((schema) => schema?.name)
        .filter((item) => typeof item === 'string')
        .sort()
      note('registry', {
        waitedMs: Date.now() - waitStart,
        count: names.length,
        names,
        byGet: {
          browser_navigate: ctx.tools.get('browser_navigate') !== undefined,
          browser_screenshot: ctx.tools.get('browser_screenshot') !== undefined,
          browser_space: ctx.tools.get('browser_space') !== undefined,
        },
      })
      if (names.length === 0) {
        note('registry-empty', { note: '宿主注册表里一条工具都没有：不是本插件的问题就是探针没挂上' })
        report.done = true
        save()
        return
      }

      // ── 2. 那一格是谁：先问页面自己 ────────────────────────────────────────
      const where = await call('browser_evaluate', {
        expression: 'JSON.stringify({ url: location.href, title: document.title })',
      })
      note('where', { value: where.safe.value ?? null })

      // ── 3. 驱动那一格：读 → 快照 → 点 → 再读 ──────────────────────────────
      const before = await call('browser_extract', {})
      const snapshot = await call('browser_snapshot', {})
      const elements = Array.isArray(snapshot.raw?.value?.elements) ? snapshot.raw.value.elements : []
      const button = elements.find((element) => element?.role === 'button')
      note('snapshot', { elements: elements.length, firstButtonRef: button?.ref ?? null })
      if (button !== undefined) await call('browser_click', { ref: button.ref })
      const after = await call('browser_extract', {})
      note('drove-the-page', {
        beforeChars: typeof before.raw?.value?.text === 'string' ? before.raw.value.text.length : null,
        afterChars: typeof after.raw?.value?.text === 'string' ? after.raw.value.text.length : null,
        changed: JSON.stringify(before.raw?.value ?? null) !== JSON.stringify(after.raw?.value ?? null),
      })

      // ── 4. 截图：图片真的进了部署自己的附件 store，而且读得回来 ──────────────
      // 路径**由调用方决定**：`DSH_T12_PROBE_SHOT` 给了就用它（票 #12 的用例要"落在它指定的
      // 那一个"），没给就**不给 path** —— 那正是票 #16 要问的那条路：默认落盘目录是谁。
      // 走默认的那一轮，用例把外壳的 cwd 指到一个临时目录，于是它落哪、cwd 里多没多出文件，
      // 都是可以分开读回的两件事。
      const shotPath = process.env.DSH_T12_PROBE_SHOT
      const shot = await call(
        'browser_screenshot',
        typeof shotPath === 'string' && shotPath !== '' ? { path: shotPath } : {},
      )
      const image = Array.isArray(shot.raw?.content)
        ? shot.raw.content.find((block) => block?.type === 'image')
        : undefined
      if (image?.attachment === undefined) {
        report.attachment = { error: '截图结果里没有 image 内容块：模型面前不会出现图片' }
      } else {
        const ref = image.attachment
        try {
          // `readImage` 不只是"读回来"：它按内容寻址的摘要**校验**字节与记录的引用是否一致
          // （见 `@deepseek-ai/dsh-attachment` 的类型注释），所以读得回来 = 那份图片真的在 store 里。
          const stored = await ctx.attachments.readImage(ref)
          const raw = stored?.data
          const view = ArrayBuffer.isView(raw) ? raw : new Uint8Array(raw ?? [])
          report.attachment = {
            attachmentId: stored?.ref?.attachmentId ?? ref.attachmentId ?? null,
            mediaType: stored?.ref?.mediaType ?? null,
            width: stored?.ref?.width ?? null,
            height: stored?.ref?.height ?? null,
            declaredBytes: ref.bytes ?? null,
            readBackBytes: view.byteLength,
            pngMagic: Array.from(view.slice(0, 8)),
          }
        } catch (error) {
          report.attachment = {
            attachmentId: ref.attachmentId ?? null,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }

      // ── 5. 任务空间：外壳的文件通道在真宿主里同样说得清 ─────────────────────
      await call('browser_space', { action: 'list' })

      // ── 6. 再读一次通道：驱动过这一格之后，模式与两个计数有没有被工具顺手改掉 ──
      // `browser_space list` 只读，`browser_view state` 也在这份报告里 —— 这条读数是"没人碰过
      // 缩放"的那一半证据（另一半是 mounting 那一刻那一份）。
      report.channelAfter = observeChannel()
      note('channel-after-tools', report.channelAfter)

      report.done = true
    } catch (error) {
      report.fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    } finally {
      report.finishedAt = new Date().toISOString()
      save()
    }
  })()
}
