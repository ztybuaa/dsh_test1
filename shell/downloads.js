'use strict'

/**
 * 下载落盘：**外壳这一侧**的纯逻辑（票 #10 第三条验收，ADR-0011）。
 *
 * 为什么下载归外壳管，而不是插件自己接 Playwright 的 `download` 事件：宿主是 Electron，
 * 下载的落盘位置由 `session` 的 `will-download` 决定；只要没人给它设路径，Electron 就走
 * "弹原生另存为对话框"那条默认路（`electron.d.ts` 原话：*"this usually prompts a save
 * dialog"*），而 Agent 驱动下**没有第二个人去点那个对话框**，于是下载挂死、触发它的那次
 * 点击挂满超时（实测见 `docs/research/dialogs-upload-download-iframes.md` 第 3 节）。
 *
 * 所以这个文件只回答四件事，全是纯判断，都不 require('electron')，也不碰文件系统
 * （只有拼路径用的 `node:path`），照 `shell/identity.js`、`shell/spaces.js` 的样子：
 *
 *   1. 下载目录在哪（{@link downloadsDir}）——`<userDataDir>/downloads`，**人找得到的地方**；
 *   2. 重名怎么办（{@link uniqueTarget}）——照浏览器习惯加 ` (2)`，而不是给每次下载开一个
 *      GUID 子目录；
 *   3. 一条记录怎么并进日志、日志怎么保持有界（{@link appendRecord}）；
 *   4. 日志怎么读写（{@link parseJournal} / {@link serializeJournal}）——**原子写**，
 *      与 `request.json` / `state.json` 同一个通道目录、同一个写法。
 */

const path = require('node:path')

/** 日志文件名。与 `src/downloads.ts` 里的常量是同一份协议。 */
const DOWNLOAD_JOURNAL_FILE_NAME = 'downloads.json'

/** 协议版本；形状变了就加一，让两边能明确地对不上。 */
const DOWNLOAD_PROTOCOL = 1

/** 日志最多留多少条。更旧的会被丢掉，而"丢过多少条"写在日志里（有界 + 不自作沉默）。 */
const MAX_DOWNLOAD_RECORDS = 50

/** 下载目录的名字（在 `userDataDir` 下）。 */
const DOWNLOADS_DIR_NAME = 'downloads'

/**
 * 外壳给一个档案安排的下载目录。
 * @param {string} userDataDir - 外壳的档案目录。
 * @returns {string} 绝对路径。
 */
function downloadsDir(userDataDir) {
  return path.join(userDataDir, DOWNLOADS_DIR_NAME)
}

/**
 * 日志文件在通道目录里的位置。
 * @param {{dir: string}} channel - `shell/spaces.js` 的 {@link spaceChannel} 结果。
 * @returns {string} 绝对路径。
 */
function journalFile(channel) {
  return path.join(channel.dir, DOWNLOAD_JOURNAL_FILE_NAME)
}

/**
 * 把一个来自页面的文件名收拾成一个安全的、扁平的文件名。
 *
 * `getFilename()` 的来源是 `Content-Disposition` 或 URL 末段，也就是**页面说了算**：
 * 它可能带路径分隔符（`..\\..\\evil.txt`）、可能是空的、可能只是一串点。这里只做
 * 一件事——把它压成一个纯文件名；不做任何"看起来很危险就拒绝"的判断，因为拒绝会让
 * 一次正常的下载失败，而压平不会。
 *
 * @param {string} filename - Electron 报的文件名。
 * @returns {string} 可以安全地拼进下载目录的文件名。
 */
function safeFilename(filename) {
  const base = path.basename(typeof filename === 'string' ? filename : '')
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'download'
  return cleaned
}

/**
 * 给一次下载挑一个落盘路径，重名就加后缀：`report.txt` → `report (2).txt` → `report (3).txt`。
 *
 * 这是浏览器的习惯，也是"用户按路径找过去能认出自己下载的东西"的前提：给每次下载开一个
 * 唯一子目录虽然更好实现，但那样用户看到的是 `downloads/1726483.../`，等于没告诉他文件在哪。
 *
 * @param {string} dir - 下载目录。
 * @param {string} filename - 想要的文件名（页面给的，已经过 {@link safeFilename}）。
 * @param {(candidate: string) => boolean} taken - 这个路径是不是已经被占了。
 * @returns {string} 一个没被占用的绝对路径。
 */
function uniqueTarget(dir, filename, taken) {
  const safe = safeFilename(filename)
  const ext = path.extname(safe)
  const stem = path.basename(safe, ext)
  let candidate = path.join(dir, `${stem}${ext}`)
  let counter = 2
  while (taken(candidate)) {
    candidate = path.join(dir, `${stem} (${counter})${ext}`)
    counter += 1
  }
  return candidate
}

/** 一份空日志。 */
function emptyJournal(now) {
  return { protocol: DOWNLOAD_PROTOCOL, updatedAt: now, downloads: [], dropped: 0 }
}

/**
 * 把一条记录并进日志，并保持有界。
 *
 * 同 `id` 的记录是**替换**而不是追加：一次下载会先以 `started` 出现，结束时再报一次
 * 最终状态，两条说的是同一件事，日志里只该有一条。
 *
 * @param {object} journal - 现有日志。
 * @param {object} record - 新记录（必须带 id）。
 * @param {number} now - 现在的时间戳。
 * @returns {object} 新的日志（不改原对象：这样调用方可以先写文件再决定要不要留着）。
 */
function appendRecord(journal, record, now) {
  const downloads = journal.downloads.filter((entry) => entry.id !== record.id)
  downloads.push(record)
  let dropped = journal.dropped
  while (downloads.length > MAX_DOWNLOAD_RECORDS) {
    downloads.shift()
    dropped += 1
  }
  return { protocol: DOWNLOAD_PROTOCOL, updatedAt: now, downloads, dropped }
}

/**
 * 解析一份日志。
 *
 * 形状不对就返回 `undefined`：读不动或读了一半的文件不是"没有下载"，是"问不出来"。
 *
 * @param {string} raw - 文件内容。
 * @param {number} now - 现在的时间戳（用于空日志）。
 * @returns {object|undefined} 日志。
 */
function parseJournal(raw, now) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (value.protocol !== DOWNLOAD_PROTOCOL) return undefined
  if (!Array.isArray(value.downloads)) return undefined
  const downloads = value.downloads.filter(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      Number.isInteger(entry.id) &&
      typeof entry.filename === 'string' &&
      typeof entry.savePath === 'string' &&
      entry.savePath !== '',
  )
  return {
    protocol: DOWNLOAD_PROTOCOL,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    downloads,
    dropped: typeof value.dropped === 'number' && value.dropped > 0 ? value.dropped : 0,
  }
}

/**
 * 日志的文本形式。
 * @param {object} journal - 日志。
 * @returns {string} 写进文件的文本。
 */
function serializeJournal(journal) {
  return `${JSON.stringify(journal, null, 2)}\n`
}

/** 一次下载结束时 Electron 报的状态 → 日志里的四个状态之一。 */
function mapDoneState(state) {
  if (state === 'completed') return 'completed'
  if (state === 'cancelled') return 'cancelled'
  return 'interrupted'
}

module.exports = {
  DOWNLOAD_JOURNAL_FILE_NAME,
  DOWNLOAD_PROTOCOL,
  DOWNLOADS_DIR_NAME,
  MAX_DOWNLOAD_RECORDS,
  appendRecord,
  downloadsDir,
  emptyJournal,
  journalFile,
  mapDoneState,
  parseJournal,
  safeFilename,
  serializeJournal,
  uniqueTarget,
}
