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
 * "这些 partition 的目录下次启动要删掉"。
 *
 * 关闭空间时**删不掉目录**（Windows 文件锁，实测见 docs/research/task-space-isolation.md 第 4 节），
 * 所以只能记在这里，由下一次启动、在任何 `session.fromPartition` 之前真的删掉。
 */
const PENDING_DELETION_FILE_NAME = 'pending-deletion.json'

/** 控制通道的协议版本；形状变了就加一，让两边能明确地对不上。 */
const SPACE_PROTOCOL = 1

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
 * @returns {{dir: string, requestFile: string, stateFile: string, pendingDeletionFile: string, protocol: number}} 通道事实。
 */
function spaceChannel(userDataDir) {
  const dir = path.join(userDataDir, SPACES_DIR_NAME)
  return {
    dir,
    requestFile: path.join(dir, REQUEST_FILE_NAME),
    stateFile: path.join(dir, STATE_FILE_NAME),
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
 * @param {unknown} raw - 从 `request.json` 解析出来的东西。
 * @returns {{ok: true, request: {id: number, active: string, spaces: string[]}} | {ok: false, error: string}} 归一化结果。
 */
function parseRequest(raw) {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'the request is not a JSON object' }
  const id = raw.id
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: `the request id must be a positive integer, got ${JSON.stringify(id)}` }
  if (!Array.isArray(raw.spaces)) return { ok: false, error: 'the request carries no `spaces` array' }
  const names = []
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
  }
  // 默认空间一直在：一条把它丢掉的请求不是"关闭默认空间"，是插件算错了，所以拒绝而不是照做。
  if (!names.includes(DEFAULT_SPACE)) {
    return { ok: false, error: `the request must keep the "${DEFAULT_SPACE}" space: it is the profile new spaces inherit from` }
  }
  if (typeof raw.active !== 'string' || !names.includes(raw.active)) {
    return { ok: false, error: `the active space ${JSON.stringify(raw.active)} is not one of the requested spaces` }
  }
  return { ok: true, request: { id, active: raw.active, spaces: names } }
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
  PENDING_DELETION_FILE_NAME,
  REQUEST_FILE_NAME,
  SPACE_NAME_PATTERN,
  SPACE_PARTITION_PREFIX,
  SPACE_PROTOCOL,
  SPACES_DIR_NAME,
  STATE_FILE_NAME,
  isValidSpaceName,
  parseRequest,
  partitionDirectoryName,
  partitionForSpace,
  reconcile,
  spaceChannel,
  spaceForPartition,
  spaceStoragePath,
}
