import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AdoptedViewSession } from './session.ts'

/**
 * 任务空间：插件这一侧。
 *
 * 票 #8 要求"所有工具只作用于当前空间"。这个模块提供两件事：
 *
 *  1. {@link planRequest} —— **纯逻辑**：把"创建一个空间 / 切到某个空间 / 关掉某个空间 / 列出空间"
 *     变成"我想要的期望状态"（`{id, active, spaces}`）。它是纯函数，所以每一条判断都能不连外壳被单测。
 *  2. {@link SpaceManager} —— 真的与外壳打交道：原子地写请求、等外壳把该请求处理完、按当前空间
 *     解析会话。
 *
 * ## 为什么是文件通道，而不是让插件自己建视图
 *
 * 实测（`docs/research/task-space-isolation.md` §1）：Electron 上 `Target.createTarget` 与
 * `Target.createBrowserContext` 都不可用，所以**插件永远建不出一块视图**，视图只能由外壳创建。
 * 而 ADR-0003 明令外壳不开任何监听端口，`--placement-file` 又是同向先例，于是"创建/关闭空间"
 * 走外壳档案目录下的两个文件（ADR-0010 §2）。
 *
 * ## 为什么工具不需要多一个 space 参数
 *
 * 每个工具的第一行都是 `await adopt()`，`adopt` 是本插件拿到会话的**唯一**一道缝。让
 * {@link SpaceManager.adopt} 按"当前空间"解析，作用域就自动落到每一个工具上：一层签名都不用改，
 * 也不存在"某个工具忘了带 space 参数"这种漏法。
 */

/** 一个空间在 shell 的 state 文件里的样子，每个值都是外壳从 Electron 读回来的。 */
export interface SpaceRecord {
  /** 空间名，插件用它来指代这个空间。 */
  name: string
  /** 它自己的 partition（外壳的*意图*；真正的读回证据是 `storagePath`）。 */
  partition: string
  /**
   * `session.getStoragePath()` 的读回值。
   *
   * Electron 的 `Session` **没有** `getPartition()`，所以"这块视图到底跑在哪个 partition 上"
   * 唯一能读回来的答案是"它的存储在哪个目录"。`partition` 与 `storagePath` 不一致时以后者为准。
   */
  storagePath: string
  /** `session.isPersistent()`：这个 partition 是不是落盘的。 */
  persistent: boolean
  /** 这块视图的 CDP target id；插件就是靠它领养这个空间。 */
  targetId?: string
  /** 它当前显示的地址。 */
  url: string
  /** `view.getVisible()` 的读回值——不是外壳"打算"显示谁。 */
  visible: boolean
  /** 这块视图的 Electron webContents id。 */
  webContentsId: number
  /** 它是不是当前空间。 */
  active: boolean
  /** 它是不是那个默认空间（新空间从它继承登录态，且它不可关闭）。 */
  isDefault: boolean
  /** `session.cookies.get({})` 的条数，读回来的。 */
  cookieCount: number
  /** 外壳建这个空间时真的搬过来了什么，读回来的。 */
  inherited?: {
    sourceUrl: string
    cookiesOffered: number
    cookiesInSpace: number
    localStorageOrigin: string | null
    localStorageKeys: number
  }
}

/** 外壳发布的实际状态。 */
export interface SpaceState {
  /** 控制通道的协议版本。 */
  protocol: number
  /** 外壳已经处理到哪个请求 id —— 插件等的就是它。 */
  requestId: number
  /** 外壳拒绝上一条请求的原因，或 null。 */
  error: string | null
  /** 当前空间的名字。 */
  active: string
  /** 外壳的档案目录。 */
  userDataDir: string
  /** 为什么发布了这一版（`startup` / `request`），诊断用。 */
  cause?: string
  /** 每个空间一条记录。 */
  spaces: SpaceRecord[]
  /** 上一条请求真的做了什么，诊断用。 */
  lastRequest?: { id: number; create: string[]; close: string[]; activate: string; error: string | null }
}

/** 控制通道的文件位置。目录由外壳的 `userDataDir` 推导，文件名是协议的一部分。 */
export interface SpaceChannel {
  /** 通道目录。 */
  dir: string
  /** 插件写、外壳读：期望状态。 */
  requestFile: string
  /** 外壳写、插件读：实际状态。 */
  stateFile: string
}

/** 默认空间的名字（外壳永远保留它，且它不可关闭）。 */
export const DEFAULT_SPACE = 'default'

/** 通道里的两个文件名。与 `shell/spaces.js` 里的常量是同一份协议。 */
const REQUEST_FILE_NAME = 'request.json'
const STATE_FILE_NAME = 'state.json'

/** 空间的四个动作。 */
export type SpaceAction = 'list' | 'create' | 'use' | 'close'

/** 一次空间命令的结果，全部来自外壳读回的状态。 */
export interface SpaceCommandOutcome {
  /** 做了什么。 */
  action: SpaceAction
  /** 做完之后外壳发布的实际状态。 */
  state: SpaceState
  /** 这条命令指名的那个空间，能对上的话。 */
  space?: SpaceRecord
  /** 给模型看的一行。 */
  message: string
}

/** 插件需要一个空间通道时，能拿到的就这些。 */
export interface SpaceManagerOptions {
  /** 外壳发布的通道目录（`DSH_DESKTOP_VIEW_SPACES`）。 */
  dir: string
  /** 连接与单次动作的超时。 */
  timeoutMs: number
  /** 一次快照列出多少元素。 */
  maxElements: number
  /** 一次读取返回多少字符。 */
  maxChars: number
  /** 等外壳处理请求时的轮询间隔。 */
  pollMs?: number
}

/** 等外壳处理请求时的轮询间隔：本地小文件，快一点没有代价。 */
const DEFAULT_POLL_MS = 50

/**
 * 校验一个空间通道目录，并算出两个文件的位置。
 *
 * @param dir - `spacesDir` 配置或 `DSH_DESKTOP_VIEW_SPACES` 的值。
 * @returns 通道，或 undefined（没配或配了个空串）。
 */
export function spaceChannelFrom(dir: string | undefined): SpaceChannel | undefined {
  if (dir === undefined || dir.trim() === '') return undefined
  return { dir, requestFile: join(dir, REQUEST_FILE_NAME), stateFile: join(dir, STATE_FILE_NAME) }
}

/**
 * 解析外壳写的状态文件。
 *
 * 形状不对就返回 `undefined` —— 一个读不动或读了一半的状态文件不是"状态为空"，是"还没有状态"；
 * 把它当成空状态会让插件以为默认空间都不存在。
 *
 * @param raw - 文件内容。
 * @returns 状态，或 undefined。
 */
export function parseSpaceState(raw: string): SpaceState | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.requestId !== 'number' || !Number.isInteger(record.requestId)) return undefined
  if (typeof record.active !== 'string' || typeof record.protocol !== 'number') return undefined
  if (!Array.isArray(record.spaces)) return undefined
  const spaces: SpaceRecord[] = []
  for (const candidate of record.spaces) {
    if (candidate === null || typeof candidate !== 'object') return undefined
    const space = candidate as Record<string, unknown>
    if (typeof space.name !== 'string' || typeof space.partition !== 'string') return undefined
    if (typeof space.storagePath !== 'string' || typeof space.url !== 'string') return undefined
    spaces.push({
      name: space.name,
      partition: space.partition,
      storagePath: space.storagePath,
      persistent: space.persistent === true,
      ...(typeof space.targetId === 'string' && space.targetId !== '' ? { targetId: space.targetId } : {}),
      url: space.url,
      visible: space.visible === true,
      webContentsId: typeof space.webContentsId === 'number' ? space.webContentsId : -1,
      active: space.active === true,
      isDefault: space.isDefault === true,
      cookieCount: typeof space.cookieCount === 'number' ? space.cookieCount : 0,
      ...(space.inherited !== undefined && space.inherited !== null
        ? { inherited: space.inherited as SpaceRecord['inherited'] }
        : {}),
    })
  }
  return {
    protocol: record.protocol,
    requestId: record.requestId,
    error: typeof record.error === 'string' ? record.error : null,
    active: record.active,
    userDataDir: typeof record.userDataDir === 'string' ? record.userDataDir : '',
    ...(typeof record.cause === 'string' ? { cause: record.cause } : {}),
    spaces,
    ...(record.lastRequest !== undefined && record.lastRequest !== null
      ? { lastRequest: record.lastRequest as SpaceState['lastRequest'] }
      : {}),
  }
}

/** 一条插件想要发出去的请求。 */
export interface SpaceRequest {
  /** 单调递增：外壳处理到哪个 id 就把它写回 state，插件等它。 */
  id: number
  /** 期望的当前空间。 */
  active: string
  /** 期望存在的空间名列表。 */
  spaces: string[]
}

/**
 * 把一条命令算成"期望状态"。
 *
 * 纯函数：不碰文件、不连外壳，因此在不起外壳的情况下每条判断都能被单独读回。
 *
 * 两条**刻意**的选择：
 *
 *  - **`create` 会顺手把新空间设为当前空间**：创建一个空间却不进去，几乎总是要紧接着再发一次
 *    `use`；而"创建"在这里的语义就是"开一个新的来干活"。
 *  - **关掉当前空间时，接班的是默认空间**：不留"当前空间指向一个已经不存在的空间"这种状态。
 *
 * 名字的**形状**不在这里校验：谁是合法名字的权威是外壳（它才是拿这个名字去建目录的人），
 * 两边各写一份规则迟早会不一致。这里只拒绝"结构性"的错（没给名字、名字不认识、关默认空间）。
 *
 * @param state - 最近一次读到的实际状态。
 * @param command - 动作与（可选的）名字。
 * @returns 请求，或一条能直接给模型看的错误。
 */
export function planRequest(
  state: SpaceState,
  command: { action: SpaceAction; name?: string },
): { request: SpaceRequest } | { error: string } {
  const names = state.spaces.map((space) => space.name)
  const id = state.requestId + 1
  const name = command.name?.trim()
  if (command.action === 'list') return { error: 'list is answered from the state the shell already published' }
  if (name === undefined || name === '') {
    return { error: `browser_space needs a \`name\` for action "${command.action}"` }
  }
  if (command.action === 'create') {
    if (names.includes(name)) {
      return {
        error:
          `the space "${name}" already exists in the desktop shell; use action "use" to switch to it, ` +
          'or pick another name',
      }
    }
    return { request: { id, active: name, spaces: [...names, name] } }
  }
  if (!names.includes(name)) {
    return {
      error:
        `there is no space named "${name}" in the desktop shell (it has: ${names.join(', ')}); ` +
        'create it first, or call browser_space with action "list"',
    }
  }
  if (command.action === 'use') return { request: { id, active: name, spaces: names } }
  if (name === DEFAULT_SPACE) {
    return {
      error:
        `the "${DEFAULT_SPACE}" space cannot be closed: it holds the profile every new space inherits its ` +
        'login state from',
    }
  }
  return {
    request: {
      id,
      active: state.active === name ? DEFAULT_SPACE : state.active,
      spaces: names.filter((candidate) => candidate !== name),
    },
  }
}

/**
 * 把状态渲染成给模型看的几行。
 * @param state - 外壳发布的实际状态。
 * @returns 多行文本。
 */
export function describeSpaceTable(state: SpaceState): string {
  const lines = [`Active space: ${state.active}`]
  for (const space of state.spaces) {
    const marks = [space.active ? 'active' : undefined, space.isDefault ? 'default' : undefined]
      .filter((mark) => mark !== undefined)
      .join(', ')
    lines.push(
      `  ${space.name}${marks === '' ? '' : ` (${marks})`} — ${space.url === '' ? '(no page)' : space.url}` +
        ` partition=${space.partition} storage=${space.storagePath}`,
    )
  }
  if (state.error !== null) lines.push(`Last request was refused: ${state.error}`)
  return lines.join('\n')
}

/** 等一会儿。 */
function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms))
}

/**
 * 与外壳的空间通道打交道，并把"当前空间"解析成会话。
 *
 * 会话按空间缓存：同一个空间连续调用工具不该反复重连 CDP。外壳重建了一个空间（新的 targetId）
 * 时，缓存的那一个会被关掉再重领养，而不是被悄悄指过去。
 */
export class SpaceManager {
  private readonly channel: SpaceChannel
  private readonly timeoutMs: number
  private readonly maxElements: number
  private readonly maxChars: number
  private readonly pollMs: number
  private readonly sessions = new Map<string, AdoptedViewSession>()

  /** @param options - 通道目录、超时与两个读取上限。 */
  constructor(options: SpaceManagerOptions) {
    this.channel = {
      dir: options.dir,
      requestFile: join(options.dir, REQUEST_FILE_NAME),
      stateFile: join(options.dir, STATE_FILE_NAME),
    }
    this.timeoutMs = options.timeoutMs
    this.maxElements = options.maxElements
    this.maxChars = options.maxChars
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  /** 通道的文件位置，诊断用。 */
  get files(): SpaceChannel {
    return this.channel
  }

  /**
   * 读外壳发布的实际状态。
   * @returns 状态，或 undefined（外壳还没写过、或写坏了）。
   */
  readState(): SpaceState | undefined {
    try {
      return parseSpaceState(readFileSync(this.channel.stateFile, 'utf8'))
    } catch {
      return undefined
    }
  }

  /**
   * 领养**当前空间**的会话。
   *
   * @param cdpUrl - 外壳的可编程端点。
   * @returns 绑定到当前空间那块视图的会话。
   * @throws 外壳还没发布状态、当前空间没有 targetId、或目标已经不在端点上时。
   */
  async adopt(cdpUrl: string): Promise<AdoptedViewSession> {
    const state = this.requireState()
    const record = state.spaces.find((space) => space.name === state.active)
    if (record === undefined) {
      throw new Error(
        `the desktop shell reports "${state.active}" as the active space but does not describe it ` +
          `(it describes: ${state.spaces.map((space) => space.name).join(', ') || 'nothing'})`,
      )
    }
    if (record.targetId === undefined) {
      throw new Error(
        `the desktop shell published no CDP target id for the active space "${record.name}"; ` +
          'without it there is no page to adopt',
      )
    }
    const cached = this.sessions.get(record.name)
    if (cached !== undefined && cached.targetId === record.targetId) return cached
    if (cached !== undefined) {
      // 外壳把这个空间重建过（新的 targetId）：旧会话连着的那块视图已经不在了。
      this.sessions.delete(record.name)
      void cached.close().catch(() => undefined)
    }
    const session = await AdoptedViewSession.adopt({
      cdpUrl,
      targetId: record.targetId,
      timeoutMs: this.timeoutMs,
      maxElements: this.maxElements,
      maxChars: this.maxChars,
    })
    this.sessions.set(record.name, session)
    return session
  }

  /**
   * 执行一条空间命令，**等外壳真的处理完**再返回。
   *
   * 这就是"工具调用必须是确定的"那一条：写下去的请求带一个单调递增的 id，外壳把已处理到哪个 id
   * 写进 state，这里阻塞等到它，超时即给出一个说得清的错误（而不是"写完了，希望它生效了"）。
   *
   * @param action - 四个动作之一。
   * @param name - 空间名（`list` 不需要）。
   * @returns 外壳读回的状态与这条命令指名的那个空间。
   */
  async command(action: SpaceAction, name?: string): Promise<SpaceCommandOutcome> {
    const before = this.requireState()
    if (action === 'list') {
      return { action, state: before, message: describeSpaceTable(before) }
    }
    const planned = planRequest(before, { action, name })
    if ('error' in planned) throw new Error(planned.error)
    this.writeRequest(planned.request)
    const after = await this.awaitRequest(planned.request.id)
    if (after.error !== null) {
      throw new Error(`the desktop shell refused space request ${planned.request.id}: ${after.error}`)
    }
    const record = name === undefined ? undefined : after.spaces.find((space) => space.name === name.trim())
    if (action === 'close' && name !== undefined) {
      const closed = this.sessions.get(name.trim())
      this.sessions.delete(name.trim())
      if (closed !== undefined) void closed.close().catch(() => undefined)
    }
    const message =
      action === 'create'
        ? record === undefined
          ? `created the space "${name}"`
          : `created the space "${record.name}" on ${record.partition} (${record.storagePath}), which is now active` +
            (record.inherited === undefined
              ? ''
              : `; inherited ${record.inherited.cookiesInSpace} cookie(s) from ${record.inherited.sourceUrl}` +
                (record.inherited.localStorageOrigin === null
                  ? ''
                  : ` and ${record.inherited.localStorageKeys} localStorage entr(ies) for ${record.inherited.localStorageOrigin}`))
        : action === 'use'
          ? `the active space is now "${after.active}"`
          : `closed the space "${name}" and erased its storage; its directory is removed when the shell next starts`
    return { action, state: after, ...(record !== undefined ? { space: record } : {}), message }
  }

  /** Close every adopted session. Disconnecting never closes the shell that owns the views. */
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)))
  }

  /**
   * 读状态，读不到就给一个说得清的错误。
   * @returns 外壳发布的实际状态。
   */
  private requireState(): SpaceState {
    const state = this.readState()
    if (state === undefined) {
      throw new Error(
        `no task-space state at ${this.channel.stateFile}: the desktop shell writes it once it is up ` +
          '(and only the shell can create a browser view, so there is nothing to do without it)',
      )
    }
    return state
  }

  /**
   * 原子地写下期望状态。
   *
   * 临时文件 + rename：外壳每 150ms 读一次这个文件，直接覆写会让它有机会读到半个 JSON。
   *
   * @param request - 期望状态。
   */
  private writeRequest(request: SpaceRequest): void {
    const temporary = `${this.channel.requestFile}.tmp`
    writeFileSync(temporary, JSON.stringify(request))
    renameSync(temporary, this.channel.requestFile)
  }

  /**
   * 等外壳把某个请求 id 处理完。
   * @param id - 请求 id。
   * @returns 处理完之后的状态。
   */
  private async awaitRequest(id: number): Promise<SpaceState> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const state = this.readState()
      if (state !== undefined && state.requestId >= id) return state
      if (Date.now() >= deadline) {
        throw new Error(
          `the desktop shell did not handle space request ${id} within ${this.timeoutMs}ms ` +
            `(the request is in ${this.channel.requestFile}, the state it publishes is in ${this.channel.stateFile}; ` +
            `the last state it published reported requestId=${state?.requestId ?? '<none>'})`,
        )
      }
      await delay(this.pollMs)
    }
  }
}
