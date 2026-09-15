/**
 * 下载（票 #10 第三条验收）：**落盘位置只有外壳知道，内容由自己读出来**。
 *
 * 这一层是纯数据与纯判断，不 import electron 也不 import playwright：它只做两件事 ——
 * 解析外壳发布的下载日志，以及把磁盘上那些字节变成一段**如实标注过**的预览。
 *
 * ## 为什么不是 `download.path()`
 *
 * 实测（`docs/research/dialogs-upload-download-iframes.md` 第 3 节，原始输出在
 * `.scratch/t9-probe4.txt` 的 Q4）：宿主是 Electron，下载归 `session` 的
 * `will-download` 管；只装 Playwright 时，Electron 会去走"原生另存为对话框"那条
 * 默认路径（`electron.d.ts`：*"If user doesn't set the save path via the API,
 * Electron will use the original routine to determine the save path; this usually
 * prompts a save dialog"*）。于是：
 *
 *  - `page.waitForEvent('download')` **会来**（`report.txt`，`suggestedFilename()` 正确）；
 *  - `download.path()` 会解析成一个 `playwright-artifacts-*` 里的 **GUID 路径，
 *    而那里根本没有文件**；`saveAs()` 直接 `ENOENT`；`failure()` 也问不出所以然。
 *
 * 所以插件侧**绝不**用 `download.path()` / `saveAs()` 报落盘位置，只用外壳在
 * `will-download` 里真正设过的那个路径，并且**先 `stat` 再读**：不存在或大小对不上
 * 就如实说，绝不把一个自己没验过的路径报成"文件在这里"（ADR-0011）。
 */

/** 下载日志的文件名。与 `shell/downloads.js` 里的常量是同一份协议。 */
export const DOWNLOAD_JOURNAL_FILE = 'downloads.json'

/** 下载日志的协议版本：对不上就是"这一对版本不匹配"，不当成空日志。 */
export const DOWNLOAD_JOURNAL_PROTOCOL = 1

/** 日志最多留多少条：更旧的会被丢掉，并且这件事写在结果里。 */
export const MAX_DOWNLOAD_RECORDS = 50

/**
 * 一次下载在外壳那边的状态。
 *
 * 四个值分别对应 Electron `DownloadItem` 的 `progressing` / `completed` /
 * `cancelled` / `interrupted`，名字取成"人话"。
 */
export type DownloadState = 'started' | 'completed' | 'cancelled' | 'interrupted'

/** 外壳发布的一条下载记录。 */
export interface DownloadRecord {
  /** 单调递增的编号，插件用它点名一条。 */
  id: number
  /** 被下载的 URL。 */
  url: string
  /** 浏览器给的文件名（`Content-Disposition` / URL 末段 / Electron 的 `getFilename()`）。 */
  filename: string
  /** 外壳真正设给 Electron 的落盘路径。**这是唯一的落盘位置来源。** */
  savePath: string
  /** 这一刻的状态。 */
  state: DownloadState
  /** 已经写下去多少字节；`started` 时通常为 0。 */
  bytes: number
  /** 开始时间（毫秒时间戳）。 */
  startedAt: number
  /** 结束时间（毫秒时间戳），还在跑就没有。 */
  finishedAt?: number
}

/** 外壳发布的整份日志。 */
export interface DownloadJournal {
  /** 协议版本。 */
  protocol: number
  /** 外壳最近一次写它的时间。 */
  updatedAt: number
  /** 记录，最旧的在前。 */
  downloads: DownloadRecord[]
  /** 因为超过上限而被丢掉的条数（外壳说的，插件原样带出来）。 */
  dropped: number
}

/** 一次下载此刻能不能读。 */
export function isDownloadReadable(record: DownloadRecord): boolean {
  return record.state === 'completed'
}

/**
 * 解析外壳写的下载日志。
 *
 * 形状不对就返回 `undefined`：一份读不动、读了一半、或者协议版本对不上的日志不是
 * "没有下载"，是"问不出来"。把它当成空日志会让插件说出"没有下载过任何东西"这句
 * 它没有资格说的话（与 `parseSpaceState` 同一条规则）。
 *
 * @param raw - 文件内容。
 * @returns 日志，或 undefined。
 */
export function parseDownloadJournal(raw: string): DownloadJournal | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.protocol !== DOWNLOAD_JOURNAL_PROTOCOL) return undefined
  if (typeof record.updatedAt !== 'number') return undefined
  if (!Array.isArray(record.downloads)) return undefined
  const downloads: DownloadRecord[] = []
  for (const candidate of record.downloads) {
    if (candidate === null || typeof candidate !== 'object') continue
    const entry = candidate as Record<string, unknown>
    if (typeof entry.id !== 'number' || !Number.isInteger(entry.id)) continue
    if (typeof entry.url !== 'string' || typeof entry.filename !== 'string') continue
    if (typeof entry.savePath !== 'string' || entry.savePath === '') continue
    const state = entry.state
    if (state !== 'started' && state !== 'completed' && state !== 'cancelled' && state !== 'interrupted') continue
    downloads.push({
      id: entry.id,
      url: entry.url,
      filename: entry.filename,
      savePath: entry.savePath,
      state,
      bytes: typeof entry.bytes === 'number' && Number.isFinite(entry.bytes) ? entry.bytes : 0,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
      ...(typeof entry.finishedAt === 'number' ? { finishedAt: entry.finishedAt } : {}),
    })
  }
  return {
    protocol: DOWNLOAD_JOURNAL_PROTOCOL,
    updatedAt: record.updatedAt,
    downloads,
    dropped: typeof record.dropped === 'number' && record.dropped > 0 ? record.dropped : 0,
  }
}

/** 磁盘上那些字节给出的答案：是文本吗、能读多少、是不是被截了。 */
export interface DownloadPreview {
  /** 能解码出来的文本（二进制会被替换成一段说明）。 */
  text: string
  /** 预览有没有被上限截断。 */
  truncated: boolean
  /** 文件真实的字节数。 */
  totalBytes: number
  /** 看起来不是 UTF-8 文本（有 NUL，或者解码出替换字符）。 */
  binary: boolean
}

/**
 * 把文件字节变成一段预览。
 *
 * 判"不是文本"用两条硬证据：UTF-8 解码出替换字符 `\uFFFD`，或者出现 NUL。两者都是
 * "这段字节不是给人读的文本"的充分迹象；猜错的方向也是安全的那一边 —— 一段被当成
 * 二进制的文本仍然会显示（只是带着一句说明），而一段被当成文本的二进制会污染上下文。
 *
 * 截断按**字符**算，并且不切开代理对（与 `cutText` 同一条规则：交出去的必须是合法的）。
 *
 * @param bytes - 文件内容。
 * @param maxChars - 最多返回多少字符。
 * @returns 预览。
 */
export function previewDownload(bytes: Uint8Array, maxChars: number): DownloadPreview {
  const totalBytes = bytes.byteLength
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const binary = decoded.includes('\uFFFD') || bytes.includes(0)
  if (binary) {
    const head = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    return {
      text: `(not text: the first ${String(Math.min(16, totalBytes))} byte(s) are ${head})`,
      truncated: false,
      totalBytes,
      binary: true,
    }
  }
  const cap = Math.max(0, maxChars)
  if (decoded.length <= cap) return { text: decoded, truncated: false, totalBytes, binary: false }
  let end = cap
  while (end > 0 && (decoded.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1
  return { text: decoded.slice(0, end), truncated: true, totalBytes, binary: false }
}

/** 一条记录写成给模型看的一行。 */
export function describeDownload(record: DownloadRecord): string {
  const when = record.finishedAt === undefined ? '' : `, finished ${String(record.finishedAt - record.startedAt)}ms after it started`
  return (
    `#${String(record.id)} ${record.filename} — ${record.state}, ${String(record.bytes)} byte(s)${when}; ` +
    `saved to ${record.savePath} (from ${record.url})`
  )
}

/**
 * 整份日志写成给模型看的那段话。
 *
 * 失败的下载**如实报失败**：`cancelled` 与 `interrupted` 各有各的说法，绝不写成
 * "下载好了"。而"文件在这里"这句话只在真的 `stat` 完之后才说 —— 那一步不在这里，
 * 它在会话里（这一层不碰文件系统）。
 *
 * @param journal - 外壳发布的日志。
 * @returns 一行行的文本。
 */
export function renderDownloadList(journal: DownloadJournal): string {
  const lines: string[] = []
  if (journal.downloads.length === 0) {
    lines.push('No download has been recorded by the shell for this browser profile yet.')
  } else {
    lines.push(`Downloads recorded by the shell (${String(journal.downloads.length)}, oldest first):`)
    for (const record of journal.downloads) lines.push(`  ${describeDownload(record)}`)
  }
  if (journal.dropped > 0) {
    lines.push(`(${String(journal.dropped)} older record(s) were dropped: the journal keeps the most recent ones only)`)
  }
  return lines.join('\n')
}
