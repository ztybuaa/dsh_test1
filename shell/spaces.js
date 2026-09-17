'use strict'

/**
 * 任务空间的命名与生命周期判断。
 *
 * 这个文件只回答四件事，而且都是"空间叫什么、它的东西存在哪、这个请求合不合法、
 * 从当前状态到目标状态要动哪几步"：
 *   1. 名字的合法形状与它对应的 partition（{@link partitionForSpace}）——默认空间
 *      **原样保留 T6 的 `persist:dsh-view`**，一个字符都不改（改了就是把用户已经登录的档案弄丢）；
 *   2. 控制通道的三个文件落在哪（{@link spaceChannel}）——目录**从 `userDataDir` 推导**，
 *      不另立位置；
 *   3. 一条来自插件的请求合不合法（{@link parseRequest}）——这里是**唯一的**名字合法性权威，
 *      插件不重复实现这条规则，非法请求由外壳把原因写进 state；
 *   4. 把"当前有哪些空间"和"请求要哪些空间"差成**创建/关闭/切到哪个**三步
 *      （{@link reconcile}）——纯函数，因此每一条判断都能在不起外壳的情况下被单独读回。
 *
 * 这里是纯逻辑：Electron 只在 `shell/main.js` 里碰，本文件不 require('electron')，
 * 也不碰文件系统（只有拼路径用的 node:path），照 `shell/identity.js` 的样子。
 */

const path = require('node:path')
const identity = require('./identity.js')

/** 默认空间的名字。它一直存在，且它的 partition 是 T6 那一格用的那个。 */
const DEFAULT_SPACE = 'default'

/**
 * 默认空间的 partition —— **就是 T6 给那一格落的那个**（`shell/identity.js` 的
 * `VIEW_PARTITION`，值 `persist:dsh-view`），原样引用而不是重写一遍字面量：
 * 两处各写一份的话，将来改一处就会出现"默认空间"与"那一格"指向两个罐子的情况。
 *
 * 用户可能已经在这个档案里登录过了。为命名整齐把它改名或"迁移"到新命名家族，
 * 等于把用户的登录态丢掉；所以命名家族从这里**长出来**，而不是从这里**改过去**。
 */
const DEFAULT_PARTITION = identity.VIEW_PARTITION

/** 新空间 partition 的前缀：`persist:` + 这个 + 空间名。 */
const SPACE_PARTITION_PREFIX = 'dsh-view-space-'

/** 落盘 partition 的前缀（Electron 的约定）。 */
const PARTITION_PREFIX = 'persist:'

/**
 * 空间名的合法形状。
 *
 * 它同时是一个**目录名**（`<userDataDir>\Partitions\<partition 去掉 persist: 前缀>`），
 * 所以形状必须比"人类好读"更严：只允许小写字母、数字与连字符，必须以字母或数字开头，
 * 长度封顶 32。斜杠、点、空格、中文、大小写混用一律拒绝——不是洁癖，是因为这些字符
 * 会让"空间名"与"磁盘上的目录"之间的对应关系变得不可预测（大小写在 Windows 上还不敏感，
 * 于是 `Task` 与 `task` 会指向同一个目录而看起来是两个空间）。
 */
const SPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 控制通道所在目录的名字（在 `userDataDir` 下）。 */
const SPACES_DIR_NAME = 'spaces'

/** 插件写的期望状态。 */
const REQUEST_FILE_NAME = 'request.json'

/** 外壳写的实际状态。 */
const STATE_FILE_NAME = 'state.json'

/**
 * 外壳写的下载日志（ADR-0011）。
 *
 * 与 `state.json` **同方向、同目录**：外壳写、插件读。它是既有通道上的一个新文件，
 * 不是一条新通道 —— 插件→外壳那一半（`request.json`）一个字节都没动。
 */
const DOWNLOAD_JOURNAL_FILE_NAME = 'downloads.json'

/**
 * 外壳写的**最新缩放读数**（票 #19 的自动适配）。
 *
 * 为什么它必须是一个单独的小文件，而不是只写进 `state.json`：`state.json` 是**整张空间表**，
 * 发一版要列 CDP 目标、逐空间问 `cookies.get({})` —— 实测那一版要 ~0.9 秒（ADR-0013 的诚实清单，
 * 本票又量了一次）。而自动适配会在**拖动侧边栏的每一帧**里改缩放，面板上那个读数
 * （"自动 78%"）必须跟着走。把写一版整表的代价压在一次拖动上，等于让这个功能自己把自己拖死。
 *
 * 所以分成两件事，**方向与目录都与 `state.json` 相同**（外壳写、插件读）：
 *   - `state.json`：那张**表**（有哪些空间、各自在哪、缩放多少），按请求与启动发布；
 *   - `zoom.json`：**最新的一次缩放读数**（每块视图现在缩放多少、谁在管、适配跑了几轮），
 *     每次缩放/模式/适配变化时立刻写一次（几百字节，无轮询、无列举）。
 *
 * 两个文件里的 `zoom` 都是**读回来的** `getZoomFactor()`，所以它们不会互相矛盾 ——
 * `state.json` 那个只是可能更旧。插件优先读 `zoom.json`，读不到就退回表里那个值
 * （旧外壳不写这个文件）。
 */
const ZOOM_FILE_NAME = 'zoom.json'

/**
 * "这些 partition 的目录下次启动要删掉"。
 *
 * 关闭空间时**删不掉目录**（Windows 文件锁，实测见 docs/research/task-space-isolation.md 第 4 节），
 * 所以只能记在这里，由下一次启动、在任何 `session.fromPartition` 之前真的删掉。
 */
const PENDING_DELETION_FILE_NAME = 'pending-deletion.json'

/** 控制通道的协议版本；形状变了就加一，让两边能明确地对不上。 */
const SPACE_PROTOCOL = 2

/**
 * 「这一项是一条**缩放命令**」的那个标签（票 #19 重新打开之后加的）。
 *
 * 为什么需要它 —— 这正是那张票重新打开的根因。这条通道上的**状态**与**命令**长得很像，
 * 于是同一种形状既可以读成"这是我的命令"，也可以读成"这是我读到的状态，原样还给你"：
 *
 *   `{name: "default", zoom: 1, mode: "manual"}`
 *
 * 在**命令**里它的意思是"从今往后我手动管这一格"，在**状态**里它的意思只是"这一格现在是
 * 100%、手动"。谁把外壳发布的那条记录原样写回 `request.json`（一次状态回显、一个照抄
 * `state.json` 的启动同步），谁就在**没有任何人碰过按钮**的情况下把自动适配关掉了 ——
 * 这就是"启动瞬间变成 manual、`fitPasses` 一直是 0"的那个现象。
 *
 * 所以：**新客户端发缩放命令时必须带这个标签**，`zoom`/`mode` 只在标签下面才有"命令"的
 * 含义。旧插件那个不带标签的形状**照旧按命令解释**（它写 request.json 从来只为了发命令，
 * 见 {@link parseRequest} 里那条兼容路径），兼容语义一个字节都不变。
 */
const ZOOM_COMMAND_KIND = 'zoom'

/**
 * 一个空间名是不是合法。
 * @param {unknown} name - 候选名字。
 * @returns {boolean} 合法为真。
 */
function isValidSpaceName(name) {
  return typeof name === 'string' && SPACE_NAME_PATTERN.test(name)
}

/**
 * 空间名 → 它自己的 partition。
 * @param {string} name - 空间名。
 * @returns {string} `persist:…`。
 */
function partitionForSpace(name) {
  return name === DEFAULT_SPACE ? DEFAULT_PARTITION : `${PARTITION_PREFIX}${SPACE_PARTITION_PREFIX}${name}`
}

/**
 * partition → 空间名（{@link partitionForSpace} 的逆）。默认 partition 就是默认空间。
 * @param {string} partition - partition 字符串。
 * @returns {string | undefined} 空间名，或 undefined（不是本项目的 partition）。
 */
function spaceForPartition(partition) {
  if (partition === DEFAULT_PARTITION) return DEFAULT_SPACE
  const prefix = `${PARTITION_PREFIX}${SPACE_PARTITION_PREFIX}`
  if (!partition.startsWith(prefix)) return undefined
  const name = partition.slice(prefix.length)
  return isValidSpaceName(name) ? name : undefined
}

/**
 * partition 在档案目录里的子目录名（Electron 把 `persist:x` 放在 `Partitions/x` 下）。
 * @param {string} partition - partition 字符串。
 * @returns {string} 目录名。
 */
function partitionDirectoryName(partition) {
  return partition.startsWith(PARTITION_PREFIX) ? partition.slice(PARTITION_PREFIX.length) : partition
}

/**
 * 空间 partition 的目录**应该**在哪。
 *
 * 它只用来算"下一个启动要从哪删"，**不是**读回来的证据：真正的证据是
 * `session.getStoragePath()`（见 `shell/main.js` 发布 state 的地方）。两者不一致时
 * 以上面那个为准，本函数只是让"该删哪个目录"能提前算出来。
 *
 * @param {string} userDataDir - 外壳的档案目录。
 * @param {string} name - 空间名。
 * @returns {string} 目录的绝对路径。
 */
function spaceStoragePath(userDataDir, name) {
  return path.join(userDataDir, 'Partitions', partitionDirectoryName(partitionForSpace(name)))
}

/**
 * 控制通道的三个文件落在哪。
 *
 * 目录**从 `userDataDir` 推导**：外壳已经有"档案在哪"这个事实，另立一个位置只会让
 * "这次运行的状态"和"上次运行的状态"有机会对不上。
 *
 * @param {string} userDataDir - 外壳的档案目录。
 * @returns {{dir: string, requestFile: string, stateFile: string, downloadJournalFile: string, zoomFile: string, pendingDeletionFile: string, protocol: number}} 通道事实。
 */
function spaceChannel(userDataDir) {
  const dir = path.join(userDataDir, SPACES_DIR_NAME)
  return {
    dir,
    requestFile: path.join(dir, REQUEST_FILE_NAME),
    stateFile: path.join(dir, STATE_FILE_NAME),
    downloadJournalFile: path.join(dir, DOWNLOAD_JOURNAL_FILE_NAME),
    zoomFile: path.join(dir, ZOOM_FILE_NAME),
    pendingDeletionFile: path.join(dir, PENDING_DELETION_FILE_NAME),
    protocol: SPACE_PROTOCOL,
  }
}

/**
 * 校验并归一化一条请求。
 *
 * 拒绝的理由都写清楚，因为这条消息会一路走到模型面前：含糊的"请求非法"没法修，
 * "空间名 `Task 1` 不合法：只允许小写字母、数字与连字符"能。
 *
 * 每一项可以只是一个名字，也可以带**这块视图的缩放命令**。命令有**两种写法**，而它们的
 * 区别是这张票重新打开的原因：
 *
 *  - **带标签**（新客户端，票 #19 重开之后）：
 *      `{name, kind: 'zoom', zoom: 0.9, mode: 'manual'}` —— 把缩放设成 0.9，从此由人管；
 *      `{name, kind: 'zoom', mode: 'auto'}`             —— 把这一格交回自动适配。
 *    带标签 = "我明确知道这是一条命令"。**光有 `kind` 而没有 `mode` 是拒绝**，不是补一个
 *    缺省：这条通道的整个麻烦就出在"没说的字段被悄悄补成 manual"上，新写法不许再走那条路。
 *
 *  - **不带标签**（旧插件，形状与 #13 时代逐字节相同）：`{name, zoom: 0.9}`
 *    —— 照旧当成 `manual`。旧插件**没有任何别的用途**会写这个文件：它不认识 `mode`，
 *    写 `zoom` 只可能是"我要这个值"。所以这个缺省不是猜，是那段历史的原义，不能动。
 *
 * `{name, mode: 'auto'}`（带 mode、不带 kind）也照旧接受：#19 第一次落地时的新插件发的就是
 * 它，而现在发布出去的客户端还可能是那一版。
 *
 * 缩放只校验**形状**（有限正数）：合法范围是插件那边的策略（`src/navigation.ts` 的
 * `ZOOM_MIN`–`ZOOM_MAX`），在这里再写一份迟早会与它不一致 —— 与空间名的方向相反，
 * 名字的形状权威在外壳（它拿名字去建目录），缩放的权威在插件。
 *
 * @param {unknown} raw - 从 `request.json` 解析出来的东西。
 * @returns {{ok: true, request: {id: number, active: string, spaces: string[], zooms: Array<{name: string, zoom?: number, mode: 'auto'|'manual'}>}} | {ok: false, error: string}} 归一化结果。
 */
function parseRequest(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'the request is not a JSON object' }
  const id = raw.id
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: `the request id must be a positive integer, got ${JSON.stringify(id)}` }
  if (!Array.isArray(raw.spaces)) return { ok: false, error: 'the request carries no `spaces` array' }
  const names = []
  const zooms = []
  for (const candidate of raw.spaces) {
    const name = typeof candidate === 'string' ? candidate : candidate?.name
    if (!isValidSpaceName(name)) {
      return {
        ok: false,
        error:
          `"${String(name)}" is not a usable space name: use 1-32 characters of lowercase letters, ` +
          'digits and dashes, starting with a letter or a digit',
      }
    }
    if (names.includes(name)) return { ok: false, error: `the space "${name}" is listed twice` }
    names.push(name)
    const bare = typeof candidate === 'string'
    const kind = bare ? undefined : candidate?.kind
    const wanted = bare ? undefined : candidate?.zoom
    const askedMode = bare ? undefined : candidate?.mode
    // 认不出的标签一律拒绝：一个"悄悄当成旧形状"的实现会让新客户端以为自己在发命令，
    // 而外壳按另一套读法执行 —— 那正是本票要消灭的那类错误。
    if (kind !== undefined && kind !== null && kind !== ZOOM_COMMAND_KIND) {
      return {
        ok: false,
        error:
          `the space "${name}" carries a zoom command of kind ${JSON.stringify(kind)}, but this shell only ` +
          `knows ${JSON.stringify(ZOOM_COMMAND_KIND)} (or no \`kind\` at all, which is the legacy form: ` +
          'a request that names a zoom value and no mode means "I set this value by hand")',
      }
    }
    if (askedMode !== undefined && askedMode !== null && askedMode !== 'auto' && askedMode !== 'manual') {
      return {
        ok: false,
        error:
          `the zoom mode for the space "${name}" must be "auto" or "manual", got ${JSON.stringify(askedMode)}. ` +
          '"auto" means the shell fits the page to the pane; anything else is the plugin\'s business, not this channel\'s',
      }
    }
    const labelled = kind === ZOOM_COMMAND_KIND
    // 带标签的命令必须自己说清模式。不补缺省，是因为"补了 manual"正是本 bug 的来源：
    // 一个把状态回显出来的客户端会因此把自动适配关掉，而它一个字都没打算说这件事。
    if (labelled && askedMode !== 'auto' && askedMode !== 'manual') {
      return {
        ok: false,
        error:
          `the zoom command for the space "${name}" must say which mode it is: "auto" (fit the page to the ` +
          `pane) or "manual" (this value is the user's). Without it there is no way to tell a command from a ` +
          'state report being echoed back, and that ambiguity is what set the mode to "manual" on startup',
      }
    }
    const hasZoom = wanted !== undefined && wanted !== null
    const hasMode = askedMode === 'auto' || askedMode === 'manual'
    if (!hasZoom && !hasMode) continue
    if (hasZoom && (typeof wanted !== 'number' || !Number.isFinite(wanted) || wanted <= 0)) {
      return {
        ok: false,
        error:
          `the zoom for the space "${name}" must be a finite number greater than 0, got ${JSON.stringify(wanted)}. ` +
          'The range a person may pick (0.25-5) is the plugin\'s policy, not this channel\'s',
      }
    }
    zooms.push({ name, ...(hasZoom ? { zoom: wanted } : {}), mode: labelled || hasMode ? askedMode : 'manual' })
  }
  // 默认空间一直在：一条把它丢掉的请求不是"关闭默认空间"，是插件算错了，所以拒绝而不是照做。
  if (!names.includes(DEFAULT_SPACE)) {
    return { ok: false, error: `the request must keep the "${DEFAULT_SPACE}" space: it is the profile new spaces inherit from` }
  }
  if (typeof raw.active !== 'string' || !names.includes(raw.active)) {
    return { ok: false, error: `the active space ${JSON.stringify(raw.active)} is not one of the requested spaces` }
  }
  return { ok: true, request: { id, active: raw.active, spaces: names, zooms } }
}

/**
 * 把"上一版为这块视图发布过的 target id"与"这一次列举的答案"合成发布记录里的那几个字段。
 *
 * 存在的理由是**发布的表不许比它知道的更少**。一块活着的视图，它的 CDP target id
 * **不会变**（换页、reload、切前后台都不变；实测见 docs/research/space-table-target-id-gap.md），
 * 所以"这一次没读到"和"没有"是两件不同的事，必须给出不同的答案：
 *
 *  1. 这一次读到了 → `resolved`（以这一次为准）；
 *  2. 这一次没读到，但以前读到过 → `remembered`（沿用已知的，并说明为什么这一次没读到）；
 *  3. 从来就没读到过 → `unavailable`（**显式**说明，绝不静默省略字段）。
 *
 * 为什么这不是"把陈旧数据当新鲜数据"：唯一会让 id 真的失效的事情是**这块视图被销毁**
 * （`closeSpace` 时 `webContents.close()`；那时空间名也从表里消失了），而调用方
 * （`shell/main.js` 的 `describeSpaces`）对销毁的视图走的是另一条分支。
 *
 * 纯逻辑：不 require electron、不碰文件系统，所以每一条判断都能不起外壳被单独读回
 * （`tests/spaces.spec.ts`）。
 *
 * @param {string | undefined} previous - 上一版为**同一块视图**发布过的 target id。
 * @param {{ok: true, targetId?: string, listedPages?: number, webContentsId?: number} | {ok: false, error: string}} listing -
 *   这一次的答案：`ok:false` 表示**列举本身**失败了（回环端点读不回来），`ok:true` 而 `targetId` 为空
 *   表示列举成功但里面没有这块视图的目标。
 * @returns {{targetId?: string, targetIdSource: 'resolved' | 'remembered' | 'unavailable', targetIdReason?: string}} 要发布的那几个字段。
 */
function mergeTargetIds(previous, listing) {
  const known = typeof previous === 'string' && previous !== '' ? previous : undefined
  const listed = listing.ok === true && typeof listing.targetId === 'string' && listing.targetId !== '' ? listing.targetId : undefined
  if (listed !== undefined) return { targetId: listed, targetIdSource: 'resolved' }
  const why =
    listing.ok === true
      ? `the CDP endpoint listed no target for this view (webContents ${listing.webContentsId ?? '<unknown>'}); ` +
        `it listed ${listing.listedPages ?? 0} page target(s)`
      : `the CDP endpoint could not be listed (${listing.error})`
  if (known !== undefined) {
    return {
      targetId: known,
      targetIdSource: 'remembered',
      targetIdReason: `${why}; keeping the id this view already had, because a live view's target id does not change`,
    }
  }
  return {
    targetIdSource: 'unavailable',
    targetIdReason: `${why}, and no target id was ever read for this view, so there is nothing to remember`,
  }
}

/**
 * 把"现在有哪些空间"与"请求要哪些空间"差成要做的三步。
 *
 * 做成一个纯函数而不是散在 `main.js` 的循环里，是因为这里最容易出错的地方不是
 * "怎么建一块视图"，而是**顺序**：先建（否则 `active` 可能指向一个还不存在的空间）、
 * 再关、最后切。纯函数让这个顺序能被单独读回，也让"关掉当前空间时谁接班"有唯一的答案。
 *
 * @param {{current: string[], request: {active: string, spaces: string[]}}} input - 现状与目标。
 * @returns {{create: string[], close: string[], activate: string}} 三步。
 */
function reconcile(input) {
  const current = input.current
  const wanted = input.request.spaces
  return {
    create: wanted.filter((name) => !current.includes(name)),
    // 默认空间永远不关，哪怕一条（会被 `parseRequest` 拒掉的）请求漏了它。
    close: current.filter((name) => name !== DEFAULT_SPACE && !wanted.includes(name)),
    activate: input.request.active,
  }
}

module.exports = {
  DEFAULT_PARTITION,
  DEFAULT_SPACE,
  DOWNLOAD_JOURNAL_FILE_NAME,
  PENDING_DELETION_FILE_NAME,
  REQUEST_FILE_NAME,
  SPACE_NAME_PATTERN,
  SPACE_PARTITION_PREFIX,
  SPACE_PROTOCOL,
  SPACES_DIR_NAME,
  STATE_FILE_NAME,
  ZOOM_COMMAND_KIND,
  ZOOM_FILE_NAME,
  isValidSpaceName,
  mergeTargetIds,
  parseRequest,
  partitionDirectoryName,
  partitionForSpace,
  reconcile,
  spaceChannel,
  spaceForPartition,
  spaceStoragePath,
}
