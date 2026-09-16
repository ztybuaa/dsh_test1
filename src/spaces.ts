import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOWNLOAD_JOURNAL_FILE } from './downloads.ts'
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
  /**
   * 这个 `targetId` 是怎么来的 —— 外壳**显式**说的，不是这里猜的：
   *
   *  - `resolved`：这一次从 CDP 端点读回来的；
   *  - `remembered`：这一次读不回来，沿用了这块视图上一次已知的（活着的视图 target id 不会变）；
   *  - `unavailable`：确实没有，原因逐字在 {@link SpaceRecord.targetIdReason} 里。
   *
   * 旧外壳不发布这个字段，那时它是 `undefined` —— "外壳没说"，**不**当成 `resolved`。
   */
  targetIdSource?: 'resolved' | 'remembered' | 'unavailable'
  /** 外壳给的原因（`remembered` / `unavailable` 时都有），逐字保留，用来点名说清哪个空间没准备好。 */
  targetIdReason?: string
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
  /**
   * `webContents.getZoomFactor()` 的读回值（票 #13 的缩放）。
   *
   * **缩放是每块视图自己的属性**，所以它跟着空间走，而不是跟着"当前是哪个空间"走
   * —— 与 `per-space 一块视图` 同一层。缺省 = 外壳没说（旧外壳不发布这个字段，
   * 或者这块视图的 webContents 已经不在了），**不**当成 1。
   */
  zoom?: number
  /** 外壳建这个空间时真的搬过来了什么，读回来的。 */
  inherited?: {
    sourceUrl: string
    cookiesOffered: number
    cookiesInSpace: number
    localStorageOrigin: string | null
    localStorageKeys: number
  }
}

/** 外壳发布的一条**读不动**的空间记录，连同它为什么读不动。 */
export interface SkippedSpace {
  /** 它在 `state.json` 的 `spaces` 数组里排第几个（0 起）——外壳没给名字时这是唯一的指代。 */
  index: number
  /** 能读出来的名字，读不出来就是 undefined。 */
  name?: string
  /** 这条记录为什么被跳过，逐字给模型看。 */
  reason: string
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
  /**
   * 外壳发布了、但**读不动**的那些记录。
   *
   * 它不是诊断信息，是**这个状态不完整**这件事本身：只有把它带到工具输出里，
   * "某个空间不见了"才有一个说得清的原因，而不是让读的人以为它从来没存在过。
   */
  skipped: SkippedSpace[]
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
  /** 外壳写、插件读：它真正下载了什么、落在哪（与 stateFile **同方向**，ADR-0011）。 */
  downloadJournalFile: string
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
  /**
   * 外壳握手里说的初始页（`DSH_DESKTOP_VIEW_URL`），交给会话供「重新开始」用（T13）。
   *
   * 缺省 = 外壳没说，那时「重新开始」会退到空白页并**说出来**，而不是假装回到了哪一页。
   */
  initialUrl?: string
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
  return {
    dir,
    requestFile: join(dir, REQUEST_FILE_NAME),
    stateFile: join(dir, STATE_FILE_NAME),
    downloadJournalFile: join(dir, DOWNLOAD_JOURNAL_FILE),
  }
}

/**
 * 解析外壳写的状态文件。
 *
 * 形状不对就返回 `undefined` —— 一个读不动或读了一半的状态文件不是"状态为空"，是"还没有状态"；
 * 把它当成空状态会让插件以为默认空间都不存在。
 *
 * ## 文件级的校验与**记录级**的校验是两件事
 *
 * `requestId` / `active` / `protocol` / `spaces` 是**文件级**的：读不出来就说明这压根不是一份状态，
 * 只能返回 `undefined`。而**一条记录**里少一个字段不是"整份状态不可读"，是"这一条不可用"：
 *
 *   `spaces: [{name, partition, destroyed: true, …}]` —— 视图被销毁的那条记录，没有
 *   `storagePath`/`url`；以前这里 `return undefined`，意思是**整份状态都不可读**：
 *   默认空间一起消失、所有工具都报"压根没有状态"，而那个错跟真实原因毫无关系。
 *
 * 现在的规矩：**跳过那一条**，把原因逐字记进 {@link SpaceState.skipped}（工具输出会带上它），
 * 其余空间照常可用。这是本仓库已经有过一次的同一课 —— `mergeTargetIds` 存在的理由就是
 * "**发布的表不许比它知道的更少**"（ADR-0010、`docs/research/space-table-target-id-gap.md`）：
 * 一张表不能因为一个字段读不回来就整个变成"没有表"。
 *
 * 唯一仍然"整份不可读"的记录级条件是 `spaces` 里出现**不是对象**的东西：那不是一条记录，
 * 是这个数组的形状坏了。
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
  const skipped: SkippedSpace[] = []
  for (const [index, candidate] of record.spaces.entries()) {
    if (candidate === null || typeof candidate !== 'object') {
      return undefined
    }
    const space = candidate as Record<string, unknown>
    // 一条记录要能**用**，这四样必须是字符串：名字与 partition 是它的身份，`storagePath` 是
    // "它到底在哪个罐子里"的唯一读回证据，`url` 是"它现在在哪"的唯一答案。少哪一样，
    // 这条记录就没法被采用 —— 但**只跳过它**，不是把整份状态扔掉。
    const missing = (['name', 'partition', 'storagePath', 'url'] as const).filter(
      (field) => typeof space[field] !== 'string',
    )
    if (missing.length > 0) {
      // 名字读不出来时也要能指代它：给出它在数组里的位置。外壳那条销毁记录是**有**名字的，
      // 所以正常的那个场景里这一条消息能直接点名是哪个空间坏了。
      skipped.push({
        index,
        ...(typeof space.name === 'string' ? { name: space.name } : {}),
        reason:
          `this space record is unusable: ${missing.join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} not a string` +
          (space.destroyed === true
            ? ' (the shell published it for a view that has been destroyed, and a destroyed view publishes no ' +
              'storage path or address — the shell now fills both in, so this record means an older shell)'
            : ''),
      })
      continue
    }
    spaces.push({
      name: space.name as string,
      partition: space.partition as string,
      storagePath: space.storagePath as string,
      persistent: space.persistent === true,
      ...(typeof space.targetId === 'string' && space.targetId !== '' ? { targetId: space.targetId } : {}),
      // 外壳对"这个 targetId 怎么来的"说的话要原样带过来：把它丢掉，下面的 adopt() 就只能说
      // "外壳没有发布 target id"，而真正的原因（端点那一刻读不回来 / 这块视图还没有目标）
      // 正好是模型需要看见的那一句。
      ...(space.targetIdSource === 'resolved' || space.targetIdSource === 'remembered' || space.targetIdSource === 'unavailable'
        ? { targetIdSource: space.targetIdSource }
        : {}),
      ...(typeof space.targetIdReason === 'string' && space.targetIdReason !== ''
        ? { targetIdReason: space.targetIdReason }
        : {}),
      url: space.url as string,
      visible: space.visible === true,
      webContentsId: typeof space.webContentsId === 'number' ? space.webContentsId : -1,
      active: space.active === true,
      isDefault: space.isDefault === true,
      cookieCount: typeof space.cookieCount === 'number' ? space.cookieCount : 0,
      // 缩放只在**读得回来**的时候才带上：`getZoomFactor()` 是唯一的真值来源，
      // 视图没了就没人能回答它，那时缺省比编一个 1 更诚实（工具会因此说"外壳没说"）。
      ...(typeof space.zoom === 'number' && Number.isFinite(space.zoom) && space.zoom > 0
        ? { zoom: space.zoom }
        : {}),
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
    skipped,
    ...(record.lastRequest !== undefined && record.lastRequest !== null
      ? { lastRequest: record.lastRequest as SpaceState['lastRequest'] }
      : {}),
  }
}

/**
 * 外壳发布的**档案目录**（`state.json` 的 `userDataDir`）。
 *
 * 为什么从这里读，而不是从进程环境：外壳交给宿主的变量只有 CDP 端点、targetId、视图地址与
 * **通道目录**四样，档案目录**不在**其中；而 `state.json` 里这个字段是外壳自己写下的那句话，
 * 与"下载落在 `<userDataDir>/downloads`"用的是同一份事实（ADR-0011），所以不需要新增任何通道。
 *
 * 为什么用 {@link parseSpaceState} 而不是自己 `JSON.parse` 一遍：那个文件只有一个解释，
 * 两处各读一遍迟早会有一处先漂。而整份文件读不动时返回 `undefined` —— "没有档案目录"是这一条
 * 的**兜底**，不是"外壳不在"，所以它不抛异常（读得动与读不动的每一种形状都各有一条单测）。
 *
 * @param stateFile - 通道里的 `state.json`；这个部署没配通道时是 undefined。
 * @returns 档案目录；读不到就是 undefined。
 */
export function userDataDirFromSpaceState(stateFile: string | undefined): string | undefined {
  if (stateFile === undefined) return undefined
  let raw: string
  try {
    raw = readFileSync(stateFile, 'utf8')
  } catch {
    return undefined
  }
  const state = parseSpaceState(raw)
  if (state === undefined || state.userDataDir === '') return undefined
  return state.userDataDir
}

/** 一条插件想要发出去的请求。 */
export interface SpaceRequest {
  /** 单调递增：外壳处理到哪个 id 就把它写回 state，插件等它。 */
  id: number
  /** 期望的当前空间。 */
  active: string
  /**
   * 期望存在的空间。每一项可以只是一个名字，也可以带上**这块视图期望的缩放**
   * （`{name, zoom}`，票 #13）。
   *
   * 为什么缩放挂在空间这一层，而不是单开一条通道：缩放本来就是**每块视图自己的属性**，
   * 而"每空间一块视图"正是这张表已经在表达的事实；单开一条通道就是拿一条通道干两件事。
   * 为什么只有被改动的那个空间带 `zoom`：这条请求是**期望状态的快照**，把没打算动的空间
   * 也写上一个值，就等于"外壳按这个值把它改回去"，用户用 Ctrl+滚轮在别处调过的缩放会被抹掉。
   */
  spaces: Array<string | { name: string; zoom: number }>
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
 * 把"给某一个空间换缩放"算成一条请求（票 #13）。
 *
 * 与 {@link planRequest} 分开，是因为它服务的是**另一件事**：`planRequest` 管的是
 * "有哪些空间、当前是哪个"，而这条只管"这块视图的缩放该是多少"。混进 `planRequest`
 * 会把 `browser_space` 的动作表也拖上一个 `zoom` 参数，那不是这张票要的形状。
 *
 * 纯函数：不碰文件、不连外壳，所以"给不存在的空间设缩放"这类判断能不起外壳被单独读回。
 *
 * @param state - 最近一次读到的实际状态。
 * @param name - 要改缩放的空间名。
 * @param zoom - 期望的缩放值（范围由 `src/navigation.ts` 的 `normalizeZoom` 负责，这里只管名字）。
 * @returns 请求，或一条能直接给模型看的错误。
 */
export function planZoom(
  state: SpaceState,
  name: string,
  zoom: number,
): { request: SpaceRequest } | { error: string } {
  const wanted = name.trim()
  if (!state.spaces.some((space) => space.name === wanted)) {
    return {
      error:
        `there is no space named "${wanted}" in the desktop shell ` +
        `(it has: ${state.spaces.map((space) => space.name).join(', ')}); ` +
        'call browser_space with action "list" to see which spaces exist',
    }
  }
  return {
    request: {
      id: state.requestId + 1,
      active: state.active,
      // 只有这一个空间带 `zoom`，其余原样是名字（理由见 {@link SpaceRequest.spaces}）。
      spaces: state.spaces.map((space) => (space.name === wanted ? { name: space.name, zoom } : space.name)),
    },
  }
}

/**
 * 把状态渲染成给模型看的几行。
 *
 * 跳过的记录**在这里说**：一张少了一条的表如果不说明它少了一条，读的人只会以为那个空间
 * 从来没存在过 —— 那正是"报出来的错跟真实原因毫无关系"的另一种写法。
 *
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
        ` partition=${space.partition} storage=${space.storagePath}` +
        // 没有 target 这件事**不静默省略**：模型看到的每一行都要能解释"为什么这个空间动不了"。
        (space.targetId === undefined
          ? ` — no CDP target yet: ${space.targetIdReason ?? 'the shell did not say why'}`
          : ''),
    )
  }
  for (const entry of state.skipped) {
    lines.push(
      `  ${entry.name ?? `<record ${entry.index}>`} — NOT USABLE, skipped: ${entry.reason}` +
        ' (the other spaces are unaffected)',
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
  /**
   * 外壳握手里说的**初始页**（`DSH_DESKTOP_VIEW_URL`），「重新开始」要回到的就是它（T13）。
   *
   * 为什么不从状态表里那个 `url` 取：那是**视图现在在哪**（它会跟着导航变），而"重新开始"
   * 要的是**外壳当初把它放在哪**。两句话长得像，意思不同。
   */
  private readonly initialUrl: string | undefined
  private readonly sessions = new Map<string, AdoptedViewSession>()

  /** @param options - 通道目录、超时与两个读取上限。 */
  constructor(options: SpaceManagerOptions) {
    this.channel = {
      dir: options.dir,
      requestFile: join(options.dir, REQUEST_FILE_NAME),
      stateFile: join(options.dir, STATE_FILE_NAME),
      downloadJournalFile: join(options.dir, DOWNLOAD_JOURNAL_FILE),
    }
    this.timeoutMs = options.timeoutMs
    this.maxElements = options.maxElements
    this.maxChars = options.maxChars
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.initialUrl = options.initialUrl
  }

  /**
   * 外壳发布的下载日志在哪。
   *
   * 与会话需要的是同一个路径，所以它从通道算出来一次、两处共用：一个地方说
   * "下载日志在通道目录里叫什么"，比两处各写一遍字符串可靠。
   */
  get downloadJournalFile(): string {
    return this.channel.downloadJournalFile
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
      // 当前空间不在表里时，"表里有哪些"还不够 —— 它可能是**被跳过的那一条**，
      // 那种情况下真正的原因（它为什么读不动）才是模型要看的那句话。
      const skippedActive = state.skipped.find((entry) => entry.name === state.active)
      throw new Error(
        `the desktop shell reports "${state.active}" as the active space but does not describe it ` +
          `(it describes: ${state.spaces.map((space) => space.name).join(', ') || 'nothing'})` +
          (skippedActive === undefined
            ? ''
            : `; that space's own record was published but is not usable: ${skippedActive.reason}`),
      )
    }
    if (record.targetId === undefined) {
      // 不"领养一个没有目标的会话"：那会把"这块视图还没准备好"变成一会儿连到别的页面、
      // 一会儿报一个跟真实原因无关的错。这里点名是哪个空间、并把外壳给的原因一并说出来。
      throw new Error(
        `the desktop shell has no usable CDP target for the active space "${record.name}" yet: ` +
          `${record.targetIdReason ?? 'it published no target id and no reason for that'}. ` +
          'The space is not ready to be driven — its view exists, but nothing can be adopted through it ' +
          'until the shell can name its target; retry in a moment, or call browser_space with action ' +
          '"list" to see what the shell says about it.',
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
      // 「重新开始」要回到的那一页来自**握手**，不是状态表里那个会跟着导航变的 `url`（T13）。
      ...(this.initialUrl !== undefined && this.initialUrl !== '' ? { url: this.initialUrl } : {}),
      // 下载日志与空间状态**在同一个通道目录里**：都是外壳写、插件读的那一半
      // （ADR-0011）。没有通道就没有下载日志，`browser_download` 会如实说"没人可问"。
      ...(this.downloadJournalFile !== undefined ? { downloadJournalFile: this.downloadJournalFile } : {}),
      // 缩放（T13）：插件够不到 Electron 的 `setZoomFactor`，所以缩放**只能**请外壳去做，
      // 而做与读回走的是同一条既有通道（ADR-0013）。会话拿到的是一个绑到**这个空间**上的口子，
      // 所以"缩哪个视图"这件事不需要再传一次空间名。
      zoomPort: {
        setZoom: async (value: number) => (await this.setZoom(record.name, value)).zoom,
      },
      // 领养时的缩放用外壳**已经发布的读回值**当起点：会话手里那个数不许比外壳知道的更自信。
      ...(record.zoom !== undefined ? { zoom: record.zoom } : {}),
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

  /**
   * 把某一个空间的视图缩放到某个值，**等外壳真的做完并读回**（票 #13）。
   *
   * 这就是"工具调用必须是确定的"那一条在缩放上的写法：写下去的请求带一个单调递增的 id，
   * 外壳做完它、把 `getZoomFactor()` 的读回值写进 state，这里等那个 id 并把**读回的那个数**
   * 返回给调用方。外壳没发布 zoom（旧外壳，或那块视图已经没了）时**抛**，不编一个数 ——
   * 一个没读回来的"我已经缩放了"正是这张票要消灭的形状。
   *
   * @param name - 空间名。
   * @param zoom - 期望的缩放值。
   * @returns 外壳读回来的缩放值，以及它发布的那条空间记录。
   * @throws 没有这个空间、外壳拒绝了请求、或外壳没发布读回值时。
   */
  async setZoom(name: string, zoom: number): Promise<{ zoom: number; space: SpaceRecord }> {
    const before = this.requireState()
    const planned = planZoom(before, name, zoom)
    if ('error' in planned) throw new Error(planned.error)
    this.writeRequest(planned.request)
    const after = await this.awaitRequest(planned.request.id)
    if (after.error !== null) {
      throw new Error(`the desktop shell refused space request ${planned.request.id}: ${after.error}`)
    }
    const record = after.spaces.find((space) => space.name === name.trim())
    if (record === undefined) {
      throw new Error(`the desktop shell stopped describing the space "${name.trim()}" while its zoom was being set`)
    }
    if (record.zoom === undefined) {
      throw new Error(
        `the desktop shell handled zoom request ${planned.request.id} but published no zoom for "${record.name}": ` +
          'the view cannot be reported as zoomed without the factor the shell read back from Electron',
      )
    }
    return { zoom: record.zoom, space: record }
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
