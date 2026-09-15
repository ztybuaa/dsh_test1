import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Frame, Page } from 'playwright'
import {
  AdoptedViewSession,
  CONTROL_LABEL_SELECTOR,
  SNAPSHOT_SELECTOR,
  type ElementBounds,
  type PageSnapshot,
} from '../src/session.ts'
import { desktopViewTools } from '../src/tools.ts'
import { DEFAULT_DIALOG_POLICY, describeDialog, planDialogAnswer } from '../src/dialogs.ts'
import {
  DOWNLOAD_JOURNAL_PROTOCOL,
  describeDownload,
  parseDownloadJournal,
  previewDownload,
  renderDownloadList,
} from '../src/downloads.ts'
import { pageForTarget, removeWhenFree, shellRecord, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T9 接缝测试：四条长尾能力（对话框 / 上传 / 下载 / iframe），票 #10。
 *
 * 每条验收都**独立读回**：对话框读页面自己写下的日志与工具返回的记录；上传读页面
 * `#up-log` 里那个文件的**内容**；下载读磁盘上真正落下的那些字节；iframe 读框架**自己
 * 文档**里的状态。没有任何一条断言建立在"我们调了某个 API"之上。
 *
 * 每个坑都配了**能反证**的用例，注释里点名它盯的是哪一处修复（回退那一处必须变红）：
 *
 *  - 对话框：动作在有界时间内返回（回退"立即答复"→ 处理器悬着 → 页面被挡住 → 变红）；
 *  - beforeunload：点击受保护链接迅速返回且导航被如实拒绝（回退处理器 → 挂满 30s 超时 → 变红）；
 *  - 覆盖层逐框架守卫 + 注入式鬼元素（回退"覆盖层节点不进快照" → 注入的 label 进快照 → 变红）；
 *  - 下载：落盘路径必须是外壳说的那个、文件必须真的存在且字节一致（回退外壳的
 *    `will-download` → 文件根本不落盘 → 变红）。
 */

const require = createRequire(import.meta.url)

/** 夹具模块（CJS）：跨源框架那一份页面与它共用同一份标记。 */
const fixture = require('../shell/fixture.js') as {
  frameInnerPage: (prefix: string) => string
  DOWNLOAD_BODY: string
}

/** 外壳那一侧的下载纯逻辑（同样是 CJS，且同样不 require electron）。 */
const shellDownloads = require('../shell/downloads.js') as {
  DOWNLOAD_JOURNAL_FILE_NAME: string
  DOWNLOAD_PROTOCOL: number
  MAX_DOWNLOAD_RECORDS: number
  appendRecord: (journal: unknown, record: unknown, now: number) => { downloads: unknown[]; dropped: number }
  emptyJournal: (now: number) => unknown
  mapDoneState: (state: string) => string
  safeFilename: (filename: string) => string
  uniqueTarget: (dir: string, filename: string, taken: (candidate: string) => boolean) => string
}

/** 一次动作有界返回的判据：会话自己的动作超时是 30s，所以远小于它的界才是"没卡住"。 */
const BOUND_MS = 5_000

/** 浮点坐标的比较精度：两个独立的读法（引擎的 box model 与页面的 rect）不该差出 0.5px。 */
const COORD_EPSILON = 0.5

/** 用一句带原文的话断言一件事，失败时能直接看到读数。 */
function raw(label: string, value: unknown): void {
  console.log(`RAW ${label}: ${JSON.stringify(value)}`)
}

/** 找一条快照元素的 ref，找不到就把快照里有什么说出来。 */
function refOf(snapshot: PageSnapshot, name: string): number {
  const found = snapshot.elements.find((element) => element.name === name)
  if (found === undefined) {
    throw new Error(
      `no snapshot element named ${JSON.stringify(name)}; it listed ${JSON.stringify(snapshot.elements.map((element) => element.name))}`,
    )
  }
  return found.ref
}

/** 一次动作失败时它的 reason 与 message，不让失败逃出去。 */
async function refusal(run: () => Promise<unknown>): Promise<{ reason?: string; message?: string }> {
  return (await run().then(
    () => ({ reason: undefined, message: undefined }),
    (error: { reason?: string; message?: string }) => ({ reason: error.reason, message: error.message }),
  )) as { reason?: string; message?: string }
}

describe('T9 — 对话框策略与下载日志（不需要 electron）', () => {
  it('默认策略不阻塞：alert/confirm/prompt 按策略答，beforeunload 恒定拒绝', () => {
    raw('默认策略', DEFAULT_DIALOG_POLICY)
    // 出厂策略必须是不阻塞的那一个：它决定"页面会不会等一个正在等它的模型"。
    expect(DEFAULT_DIALOG_POLICY).toEqual({ answer: 'dismiss' })

    for (const kind of ['alert', 'confirm', 'prompt']) {
      expect(planDialogAnswer(kind, DEFAULT_DIALOG_POLICY, 'page-default').answer.accept).toBe(false)
      expect(planDialogAnswer(kind, { answer: 'accept' }, 'page-default').answer.accept).toBe(true)
    }
    // beforeunload 不看策略：实测接受它既不通过导航、又让动作挂满超时。
    const guardUnderAccept = planDialogAnswer('beforeunload', { answer: 'accept' }, '')
    raw('beforeunload 在 accept 策略下的答复', guardUnderAccept)
    expect(guardUnderAccept.answer.accept).toBe(false)
    expect(guardUnderAccept.decidedBy).toContain('beforeunload')
  })

  it('prompt 的接受文本：显式给的优先，没给就用页面自己的默认值', () => {
    const withDefault = planDialogAnswer('prompt', { answer: 'accept' }, 'the page default')
    const withExplicit = planDialogAnswer('prompt', { answer: 'accept', promptText: 'typed' }, 'the page default')
    raw('prompt 答复', { withDefault: withDefault.answer, withExplicit: withExplicit.answer })
    expect(withDefault.answer.promptText).toBe('the page default')
    expect(withExplicit.answer.promptText).toBe('typed')
    // confirm 不接受文本：把 promptText 塞给它会变成一次"看不见的输入"。
    expect(planDialogAnswer('confirm', { answer: 'accept', promptText: 'typed' }, '').answer.promptText).toBeUndefined()
  })

  it('一条记录怎么写成人话：类型、文本、答复，以及"没生效"要说出来', () => {
    const lines = [
      describeDialog({
        type: 'confirm',
        message: 'proceed?',
        defaultPrompt: '',
        accept: false,
        decidedBy: 'the default answer',
        at: 1,
      }),
      describeDialog({
        type: 'prompt',
        message: 'your name?',
        defaultPrompt: 'default-name',
        accept: true,
        promptText: 'default-name',
        decidedBy: 'the answer the agent set',
        at: 2,
      }),
      describeDialog({
        type: 'alert',
        message: 'hello',
        defaultPrompt: '',
        accept: false,
        decidedBy: 'the default answer',
        answerError: 'No dialog is showing',
        at: 3,
      }),
    ]
    raw('对话框记录', lines)
    expect(lines[0]).toContain('"proceed?"')
    expect(lines[0]).toContain('dismissed')
    expect(lines[1]).toContain('accepted with "default-name"')
    expect(lines[1]).toContain("the page's own default")
    expect(lines[2]).toContain('already closed it when the answer was sent')
  })

  it('下载日志：好日志读得回，错协议与坏形状一律 undefined', () => {
    const good = JSON.stringify({
      protocol: DOWNLOAD_JOURNAL_PROTOCOL,
      updatedAt: 5,
      dropped: 2,
      downloads: [
        { id: 1, url: 'http://x/a.txt', filename: 'a.txt', savePath: 'C:\\d\\a.txt', state: 'completed', bytes: 7, startedAt: 1, finishedAt: 2 },
        { id: 2, url: 'http://x/b.txt', filename: 'b.txt', savePath: 'C:\\d\\b.txt', state: 'interrupted', bytes: 0, startedAt: 3 },
      ],
    })
    const parsed = parseDownloadJournal(good)
    raw('解析结果', parsed)
    expect(parsed?.downloads).toHaveLength(2)
    expect(parsed?.dropped).toBe(2)
    expect(parsed?.downloads[1].state).toBe('interrupted')
    // 错协议、缺字段、坏 JSON：都不是"没有下载"，是"问不出来"。
    expect(parseDownloadJournal(JSON.stringify({ protocol: 99, updatedAt: 1, downloads: [] }))).toBeUndefined()
    expect(parseDownloadJournal('{')).toBeUndefined()
    expect(parseDownloadJournal(JSON.stringify({ protocol: DOWNLOAD_JOURNAL_PROTOCOL, updatedAt: 1 }))).toBeUndefined()
    const incomplete = parseDownloadJournal(
      JSON.stringify({
        protocol: DOWNLOAD_JOURNAL_PROTOCOL,
        updatedAt: 1,
        downloads: [{ id: 1, url: 'u', filename: 'f', savePath: '', state: 'completed' }],
      }),
    )
    expect(incomplete?.downloads).toHaveLength(0)
  })

  it('内容预览：文本照读、二进制说出来、超上限按字符截断且不切开代理对', () => {
    const text = previewDownload(new TextEncoder().encode('hello\nworld\n'), 100)
    raw('文本预览', text)
    expect(text.text).toBe('hello\nworld\n')
    expect(text.binary).toBe(false)
    expect(text.truncated).toBe(false)
    expect(text.totalBytes).toBe(12)

    const binary = previewDownload(new Uint8Array([0x00, 0x01, 0xff, 0xfe]), 100)
    raw('二进制预览', binary)
    expect(binary.binary).toBe(true)
    expect(binary.text).toContain('not text')
    expect(binary.totalBytes).toBe(4)

    // 截断按字符算，且不把一对代理字符切成两半。
    const astral = previewDownload(new TextEncoder().encode('a'.repeat(3) + '😀'), 4)
    raw('截断到 4 个字符', astral)
    expect(astral.truncated).toBe(true)
    expect(astral.text).toBe('aaa')
    expect([...astral.text].every((character) => character.codePointAt(0)! <= 0xffff)).toBe(true)
  })

  it('列表把失败如实写成失败，绝不把 cancelled / interrupted 写成下载好了', () => {
    const rendered = renderDownloadList({
      protocol: DOWNLOAD_JOURNAL_PROTOCOL,
      updatedAt: 1,
      dropped: 3,
      downloads: [
        { id: 1, url: 'u1', filename: 'a.txt', savePath: 'C:\\d\\a.txt', state: 'completed', bytes: 7, startedAt: 1, finishedAt: 2 },
        { id: 2, url: 'u2', filename: 'b.txt', savePath: 'C:\\d\\b.txt', state: 'cancelled', bytes: 0, startedAt: 3 },
        { id: 3, url: 'u3', filename: 'c.txt', savePath: 'C:\\d\\c.txt', state: 'interrupted', bytes: 2, startedAt: 4 },
      ],
    })
    raw('下载列表', rendered)
    expect(rendered).toContain('#1 a.txt — completed')
    expect(rendered).toContain('#2 b.txt — cancelled')
    expect(rendered).toContain('#3 c.txt — interrupted')
    expect(rendered).toContain('3 older record(s) were dropped')
    expect(describeDownload({ id: 9, url: 'u', filename: 'z.txt', savePath: 'p', state: 'cancelled', bytes: 0, startedAt: 2, finishedAt: 5 })).toContain('cancelled')
  })

  it('外壳那一侧：重名后缀照浏览器习惯，日志有界，文件名被压平', () => {
    const dir = 'C:\\profile\\downloads'
    const taken = new Set([join(dir, 'report.txt'), join(dir, 'report (2).txt')])
    const target = shellDownloads.uniqueTarget(dir, 'report.txt', (candidate) => taken.has(candidate))
    raw('重名后缀', { target, safe: shellDownloads.safeFilename('..\\..\\evil.txt') })
    expect(target).toBe(join(dir, 'report (3).txt'))
    // 页面给的文件名说了算，所以路径成分必须被压掉，而不是被信任。
    expect(shellDownloads.safeFilename('..\\..\\evil.txt')).toBe('evil.txt')
    expect(shellDownloads.safeFilename('')).toBe('download')
    expect(shellDownloads.mapDoneState('cancelled')).toBe('cancelled')
    expect(shellDownloads.mapDoneState('interrupted')).toBe('interrupted')

    // 有界：第 N+1 条进来时最旧的一条被丢掉，而"丢过多少"记在日志自己身上。
    let journal = shellDownloads.emptyJournal(0)
    const total = shellDownloads.MAX_DOWNLOAD_RECORDS + 3
    for (let id = 1; id <= total; id++) {
      journal = shellDownloads.appendRecord(journal, { id, filename: `f${String(id)}`, savePath: `p${String(id)}` }, id)
    }
    const downloads = (journal as { downloads: Array<{ id: number }>; dropped: number }).downloads
    raw('有界日志', { kept: downloads.length, dropped: (journal as { dropped: number }).dropped, newest: downloads[downloads.length - 1] })
    expect(downloads).toHaveLength(shellDownloads.MAX_DOWNLOAD_RECORDS)
    expect((journal as { dropped: number }).dropped).toBe(3)
    expect(downloads[downloads.length - 1].id).toBe(total)
    // 同 id 是替换而不是追加：一次下载先报 started、结束时再报一次最终状态。
    const replaced = shellDownloads.appendRecord(journal, { id: total, filename: 'final', savePath: 'p', state: 'completed' }, 1)
    expect(replaced.downloads).toHaveLength(shellDownloads.MAX_DOWNLOAD_RECORDS)
    expect((replaced.downloads[replaced.downloads.length - 1] as { filename: string }).filename).toBe('final')
  })
})

describe('T9 — 四条长尾能力（真外壳）', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /**
   * 第二个连接：只用来读页面自己的事实（bounds、框架里的状态……）。
   *
   * 它是**按需**建的，因为"再多一个 Playwright 客户端"会改变被测行为本身：没有 `dialog`
   * 监听器的客户端会**自动把对话框关掉**（`dialogDidOpen` 里那条 `!hasHandlers` 分支），
   * 于是"我们的处理器有没有在答复"这件事就被另一个客户端替我们做了。对话框与
   * beforeunload 那两条因此必须只有一个客户端（生产里也只有一个）。
   */
  let probeConnection: { browser: { close: () => Promise<void> }; page: Page } | undefined
  const probePage = async (): Promise<Page> => {
    if (probeConnection === undefined) {
      probeConnection = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    }
    return probeConnection.page
  }
  /** 跨源框架的第二个 origin：外壳只起一个 HTTP 服务，跨源需要第二个端口。 */
  let crossServer: { origin: string; close: () => Promise<void> }
  let dir: string
  let uploadFile: string
  /** 上传夹具文件的内容：大小断言用它的实际字节数，而不是一个手抄的数字。 */
  const UPLOAD_BODY = 't9-upload-fixture: the file the agent hands to the page.\n'

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-t9-'))
    uploadFile = join(dir, 'upload-me.txt')
    writeFileSync(uploadFile, UPLOAD_BODY, 'utf8')
    shell = await startShell([], { windowSize: { width: 900, height: 600 } })
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
      downloadJournalFile: shell.handshake.spaceChannel.downloadJournalFile,
    })
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fixture.frameInnerPage('xo'))
    })
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    crossServer = {
      origin: `http://127.0.0.1:${port}`,
      close: () => new Promise((settle) => server.close(() => settle())),
    }
  }, 120_000)

  afterAll(async () => {
    if (probeConnection !== undefined) await probeConnection.browser.close().catch(() => undefined)
    if (session !== undefined) await session.close().catch(() => undefined)
    if (crossServer !== undefined) await crossServer.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    if (dir !== undefined) removeWhenFree(dir)
  })

  const url = (path: string): string => `${shell.handshake.fixtureOrigin}${path}`

  /**
   * 页面自己写下的那段文本，走**会话自己的连接**读回来。
   *
   * 对话框那几条必须这样读：多一个客户端就会替我们把对话框答掉，于是被测的就不再是
   * 我们的处理器了（见 {@link probeConnection}）。读到的仍然是页面自己写的文本。
   */
  const sessionText = async (id: string): Promise<string> =>
    (await session.evaluate(`document.getElementById(${JSON.stringify(id)})?.textContent ?? ''`)) as string

  /** 页面自己写下的那段文本，走独立连接读回来。 */
  const pageText = async (id: string): Promise<string> =>
    (await (await probePage()).evaluate((elementId) => document.getElementById(elementId)?.textContent ?? '', id)) as string

  /** 页面里某个元素的值（输入框的 value、复选框的 checked）。 */
  const pageValue = async (id: string): Promise<unknown> =>
    (await probePage()).evaluate((elementId) => {
      const element = document.getElementById(elementId) as HTMLInputElement | null
      if (element === null) return null
      if (element.type === 'checkbox') return element.checked
      return element.value
    }, id)

  /** 等页面自己把某段文本写出来（页面的处理是异步的：FileReader / change 事件）。 */
  const waitForPageText = async (id: string, wanted: string, waitMs = 5_000): Promise<string> => {
    const deadline = Date.now() + waitMs
    let seen = ''
    for (;;) {
      seen = await pageText(id)
      if (seen.includes(wanted) || Date.now() >= deadline) return seen
      await new Promise((settle) => setTimeout(settle, 50))
    }
  }

  /**
   * 在**指定框架自己的文档**里读一段文本或一个值，走独立连接。
   *
   * "动作落到了框架里的元素上"这句话，只有框架自己的文档能证实；从主文档读回来的是
   * 另一个东西（主文档里根本没有这些 id）。
   */
  const frameText = async (frameUrl: string, id: string): Promise<string> => {
    const frames = (await probePage()).frames()
    const frame = frames.find((candidate) => candidate.url() === frameUrl)
    if (frame === undefined) throw new Error(`no frame at ${frameUrl}; frames: ${frames.map((f) => f.url()).join(', ')}`)
    return (await frame.evaluate((elementId) => document.getElementById(elementId)?.textContent ?? '', id)) as string
  }
  const frameValue = async (frameUrl: string, id: string): Promise<string> => {
    const frame = (await probePage()).frames().find((candidate) => candidate.url() === frameUrl)
    if (frame === undefined) throw new Error(`no frame at ${frameUrl}`)
    return (await frame.evaluate((elementId) => (document.getElementById(elementId) as HTMLInputElement | null)?.value ?? '', id)) as string
  }

  it('验收一：对话框不卡住 Agent，拒绝/接受都生效，文本读得到', async () => {
    await session.goto(url('/dialogs'))
    const snapshot = await session.snapshot()
    const confirmRef = refOf(snapshot, 'open a confirm')

    // 默认策略：拒绝。动作必须在有界时间内返回 —— 这一条就是"卡住 Agent"的反证
    // （回退"立即答复"，处理器会悬着，页面被挡住，这里会走满 30s 动作超时）。
    const startedAt = Date.now()
    await session.clickRef(confirmRef)
    const elapsed = Date.now() - startedAt
    raw('默认策略下点一次 confirm 的耗时', elapsed)
    expect(elapsed).toBeLessThan(BOUND_MS)
    const dialogLog = await sessionText('dlg-log')
    raw('页面自己的日志', dialogLog)
    expect(dialogLog).toContain('confirm-returned=false')
    const seen = session.dialogRecordsSoFar()
    raw('会话记下的对话框', seen)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('confirm')
    expect(seen[0].message).toBe('the confirm asked: proceed?')
    expect(seen[0].accept).toBe(false)
    // 答复真的生效了：引擎没报"对话框已经不在了"（那不是我们的答复起的作用）。
    expect(seen[0].answerError).toBeUndefined()

    // 接受：策略说了算，效果由页面自己写出来。
    session.setDialogPolicy({ answer: 'accept' })
    const acceptRef = refOf(await session.snapshot(), 'open a confirm')
    await session.clickRef(acceptRef)
    const acceptedLog = await sessionText('dlg-log')
    raw('接受之后页面自己的日志', acceptedLog)
    expect(acceptedLog).toContain('confirm-returned=true')
    expect(session.dialogRecordsSoFar().at(-1)?.accept).toBe(true)
    expect(session.dialogRecordsSoFar().at(-1)?.answerError).toBeUndefined()

    // prompt：**这台宿主上根本弹不出来** —— Electron 的嵌入层不实现 `prompt()`，它抛
    // `prompt() is not supported.`，于是 onclick 里 prompt 之后那两行 never run、也没有任何
    // 对话框事件。这不是我们的策略的问题，而是宿主事实；诚实清单里有一条写它。
    // 我们的 prompt 策略仍然有覆盖（纯逻辑那条用例），但**这台宿主不会走到那里**。
    const promptRef = refOf(await session.snapshot(), 'open a prompt')
    await session.clickRef(promptRef)
    const promptLog = await sessionText('dlg-log')
    raw('prompt 之后页面自己的日志', promptLog)
    expect(promptLog.trim()).toMatch(/prompt-before @\d+$/)
    const diagnostics = session.diagnostics()
    raw('prompt 之后页面自己的诊断', diagnostics)
    const unsupported = diagnostics.console.find((message) => message.text.includes('prompt() is not supported'))
    expect(unsupported, 'the host must say why no prompt appeared').toBeDefined()
    expect(unsupported?.type).toBe('pageerror')
    // 而它没有把页面弄坏：页面仍然答得上来，动作仍然有界返回。
    expect(await sessionText('dlg-log')).toContain('prompt-before')
    session.setDialogPolicy({ answer: 'dismiss' })
  })

  it('验收一（坑）：beforeunload 走同一个事件，动作不被它卡住，而导航被如实拒绝', async () => {
    await session.goto(url('/dialogs'))
    // 这一页自己装的守卫是匿名的，测完摘不掉；所以这里装一个**有名**的，测完能摘。
    await session.evaluate(
      "window.__t9guard = (event) => { event.preventDefault(); return 'unsaved changes' }; " +
        "window.addEventListener('beforeunload', window.__t9guard); 'armed'",
    )
    const leaveRef = refOf(await session.snapshot(), 'leave this page')

    // 反证点：今天没有任何处理器时，这一次点击会挂满 30s 超时（实测，探针三 P5）。
    // 装了"立即 dismiss"的 async 处理器之后，它必须在有界时间内返回。
    const startedAt = Date.now()
    await session.clickRef(leaveRef)
    const clickMs = Date.now() - startedAt
    raw('点受守卫链接的耗时与落点', { clickMs, url: session.url() })
    expect(clickMs).toBeLessThan(BOUND_MS)
    expect(session.url()).toBe(url('/dialogs'))
    const guard = session.dialogRecordsSoFar().find((record) => record.type === 'beforeunload')
    raw('beforeunload 记录', guard)
    expect(guard).toBeDefined()
    // 它的文本引擎不给（Chromium 不交出来），但类型与答复都在，动作结果才有话可说。
    expect(guard?.message).toBe('')
    expect(guard?.accept).toBe(false)

    // goto 也不行，而且必须报成"这一页不让我走"，不是一句 net::ERR_ABORTED。
    const guarded = await refusal(() => session.goto(url('/other')))
    raw('受守卫页面上的一次 goto', guarded)
    expect(guarded.reason).toBe('page-guard')
    expect(guarded.message).toContain('beforeunload')
    expect(guarded.message).toContain(url('/dialogs'))
    expect(session.url()).toBe(url('/dialogs'))

    await session.evaluate("window.removeEventListener('beforeunload', window.__t9guard); 'disarmed'")
    const after = await session.goto(url('/other'))
    raw('摘掉守卫之后', after)
    expect(after.url).toBe(url('/other'))
  })

  it('验收二：藏起来的 file input 由可见 label 走 ref 点击 + file chooser 交进去', async () => {
    await session.goto(url('/upload'))
    const snapshot = await session.snapshot()
    raw('上传页的快照', snapshot)
    // 藏起来的 input 不在快照里（继承的"隐藏元素不进快照"），而它那个可见的 label 在
    // —— 否则这个页面上根本没有任何 ref 能碰得到这次上传（ADR-0012）。
    const probe = await probePage()
    expect(await probe.evaluate(() => document.getElementById('up-hidden') !== null)).toBe(true)
    expect(await probe.locator('#up-hidden').isVisible()).toBe(false)
    expect(snapshot.elements).toHaveLength(2)
    expect(snapshot.elements.map((element) => element.role).sort()).toEqual(['label', 'textbox'])
    const labelRef = refOf(snapshot, 'choose a file to upload')

    const result = await session.uploadRef(labelRef, uploadFile)
    raw('上传结果', result)
    expect(result.via).toBe('filechooser')
    expect(result.count).toBe(1)
    expect(result.name).toBe('upload-me.txt')
    expect(result.size).toBe(Buffer.byteLength(UPLOAD_BODY))
    // 独立读回：页面自己把文件名与**内容**写进了 #up-log（页面那一侧是异步的：
    // change 事件里再走一个 FileReader，所以这里等它写出来）。
    const log = await waitForPageText('up-log', 'content=')
    raw('页面自己的上传日志', log)
    expect(log).toContain('name=upload-me.txt')
    expect(log).toContain(`size=${String(Buffer.byteLength(UPLOAD_BODY))}`)
    expect(log).toContain('content=t9-upload-fixture: the file the agent hands to the page.')
    // 而那个藏起来的 input 自己确实拿到了文件：这是"交进去了"的另一半证据。
    const held = await probe.evaluate(() => {
      const input = document.getElementById('up-hidden') as HTMLInputElement | null
      return input === null ? null : { count: input.files?.length ?? -1, name: input.files?.[0]?.name ?? '' }
    })
    raw('隐藏 input 自己的 FileList', held)
    expect(held).toEqual({ count: 1, name: 'upload-me.txt' })
  })

  it('验收二：页面本来就有可见 file input 时直接用它，不绕道去点', async () => {
    await session.goto(url('/upload'))
    const snapshot = await session.snapshot()
    // 那个看得见的 file input 自己就在快照里（`:visible` 规则照旧），所以这一类不需要
    // 任何 label：直接给它就是最短的路。
    const visibleRef = snapshot.elements.find((element) => element.role === 'textbox')?.ref
    expect(visibleRef).toBeDefined()
    expect(await (await probePage()).locator('#up-visible').isVisible()).toBe(true)
    const result = await session.uploadRef(visibleRef as number, uploadFile)
    raw('直接给可见 input 的结果', result)
    expect(result.via).toBe('input')
    expect(await waitForPageText('up-log', 'content=')).toContain('content=t9-upload-fixture')
  })

  it('验收二（坑）：三类失败分得开 —— 路径读不到、点击不开 chooser', async () => {
    await session.goto(url('/download'))
    const snapshot = await session.snapshot()
    const plainButton = refOf(snapshot, 'a plain button')

    const missing = await refusal(() => session.uploadRef(plainButton, join(dir, 'no-such-file.txt')))
    raw('路径不存在', missing)
    expect(missing.message).toContain('could not read')
    expect(missing.message).toContain('no-such-file.txt')

    const noChooser = await refusal(() => session.uploadRef(plainButton, uploadFile))
    raw('点了不开 chooser 的按钮', noChooser)
    expect(noChooser.message).toContain('opened no file chooser')
    expect(noChooser.message).toContain('5000ms')
    // 失败之后页面还在原地、还能动：这不是把页面弄坏了，是一次被说清楚的拒绝。
    expect(session.url()).toBe(url('/download'))
    // 而那个按钮**自己被点到了**（它的 onclick 写了 effect）—— 这一次失败只关于
    // "它不开文件选择器"，不关于"点击没发生"。
    expect(await waitForPageText('dl-effect', 'clicked')).toBe('clicked-the-plain-button')
  })

  it('验收三：下载真的落盘，落盘位置与内容预览都是真的', async () => {
    await session.goto(url('/download'))
    const linkRef = refOf(await session.snapshot(), 'download the report')
    const mark = session.activityMark()
    await session.clickRef(linkRef)
    const activity = session.activitySince(mark)
    raw('这一次点击顺带发生的事', activity)
    // 触发下载的那次点击**结果如实**：它说"一次下载开始了"，而页面自己没有任何变化。
    expect(activity.downloads).toHaveLength(1)
    expect(activity.downloads[0].filename).toBe('report.txt')
    expect(session.describeActivity(activity).join('\n')).toContain('a download started')
    expect(await pageText('dl-effect')).toBe('none')

    // 外壳是异步写完它的日志的（先 started，结束时再报一次），所以这里等它到 completed。
    const deadline = Date.now() + 15_000
    let record = (await session.downloads()).downloads.at(-1)
    while (record !== undefined && record.state === 'started' && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 100))
      record = (await session.downloads()).downloads.at(-1)
    }
    raw('外壳记下的下载', record)
    expect(record).toBeDefined()
    expect(record?.state).toBe('completed')
    expect(record?.filename).toBe('report.txt')
    expect(record?.url).toBe(url('/download/report.txt'))

    // 落盘位置是**外壳说的那个**：在它发布的下载目录里，而且磁盘上真的存在。
    // （Playwright 自己的 download.path() 在这台宿主上指向 playwright-artifacts 里一个
    // 不存在的文件 —— 这条断言就是"我们没有用它"的可读形式。）
    expect(record?.savePath.startsWith(shell.handshake.downloadsDir)).toBe(true)
    expect(record?.savePath).not.toContain('playwright-artifacts')
    expect(existsSync(record?.savePath as string), `${String(record?.savePath)} must exist`).toBe(true)
    const onDisk = readFileSync(record?.savePath as string, 'utf8')
    raw('磁盘上的字节', onDisk)
    expect(onDisk).toBe(fixture.DOWNLOAD_BODY)
    expect(record?.bytes).toBe(Buffer.byteLength(fixture.DOWNLOAD_BODY))

    // 内容预览也是真的：工具读出来的那些字符就是磁盘上的那些。
    const reading = await session.readDownload(record?.id as number)
    raw('工具读回的下载', reading)
    expect(reading.preview?.text).toBe(fixture.DOWNLOAD_BODY)
    expect(reading.preview?.binary).toBe(false)
    expect(reading.preview?.truncated).toBe(false)
    expect(reading.unreadable).toBeUndefined()

    // 外壳自己也在 stdout 上说过同一件事：日志文件与 stdout 不许各说各的。
    const published = shellRecord<{ savePath: string; state: string; bytes: number }>(shell.stdout(), 'DOWNLOAD')
    raw('外壳发布的最后一条下载', published)
    expect(published?.state).toBe('completed')
    expect(published?.savePath).toBe(record?.savePath)
  })

  it('验收三：同名再下一次不覆盖，照浏览器习惯加后缀', async () => {
    const before = (await session.downloads()).downloads.length
    const linkRef = refOf(await session.snapshot(), 'download the report')
    await session.clickRef(linkRef)
    const deadline = Date.now() + 15_000
    let record = (await session.downloads()).downloads.at(-1)
    while ((record === undefined || record.state === 'started') && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 100))
      record = (await session.downloads()).downloads.at(-1)
    }
    raw('第二次下载', { before, record })
    expect((await session.downloads()).downloads.length).toBe(before + 1)
    expect(record?.filename).toBe('report (2).txt')
    expect(existsSync(record?.savePath as string)).toBe(true)
    expect(readFileSync(record?.savePath as string, 'utf8')).toBe(fixture.DOWNLOAD_BODY)
    // 第一份还在，没有被第二次覆盖掉。
    const first = (await session.downloads()).downloads.find((candidate) => candidate.filename === 'report.txt')
    expect(existsSync(first?.savePath as string)).toBe(true)
  })

  it('验收三（坑）：还没完成或失败的下载，不许被报成"文件在这里"', async () => {
    const journalFile = shell.handshake.spaceChannel.downloadJournalFile
    const original = readFileSync(journalFile, 'utf8')
    const journal = {
      protocol: DOWNLOAD_JOURNAL_PROTOCOL,
      updatedAt: 1,
      dropped: 0,
      downloads: [
        { id: 901, url: 'u', filename: 'pending.bin', savePath: join(dir, 'pending.bin'), state: 'started' as const, bytes: 0, startedAt: 1 },
      ],
    }
    writeFileSync(journalFile, JSON.stringify(journal))
    try {
      const reading = await session.readDownload(901)
      raw('未完成的下载被读回', reading)
      expect(reading.preview).toBeUndefined()
      expect(reading.unreadable).toContain('has not finished')
      expect(reading.record.state).toBe('started')
      // 不存在的 id 是一个被点名的失败，而不是"没有下载"。
      const missing = await refusal(() => session.readDownload(999))
      expect(missing.reason).toBe('not-found')
      expect(missing.message).toContain('#999')
      // 读不动的日志不许被当成"没有下载"。
      writeFileSync(journalFile, '{ not json')
      const broken = await refusal(() => session.downloads())
      expect(broken.message).toContain('could not be understood')
    } finally {
      writeFileSync(journalFile, original)
    }
  })

  it('验收四：同源与跨源框架里的元素都在快照里，而且带"它在哪个框架"', async () => {
    const cross = encodeURIComponent(`${crossServer.origin}/frame-inner`)
    await session.goto(url(`/frames?cross=${cross}`))
    const snapshot = await session.snapshot()
    raw('框架页的快照', snapshot)
    const byName = (name: string): { ref: number; frame?: string; bounds: ElementBounds } => {
      const found = snapshot.elements.find((element) => element.name === name)
      if (found === undefined) {
        throw new Error(`no element named ${name}; listed ${JSON.stringify(snapshot.elements.map((element) => element.name))}`)
      }
      return found
    }
    const top = byName('top button')
    // 两个框架里的控件同名：这正是"ref 必须知道自己在哪个框架"的理由。
    const frameButtons = snapshot.elements.filter((element) => element.name === 'frame button')
    expect(frameButtons).toHaveLength(2)
    expect(top.frame).toBeUndefined()
    const frameUrls = frameButtons.map((element) => element.frame)
    raw('两个框架里的 frame 字段', frameUrls)
    expect(frameUrls).toContain(url('/frame-inner'))
    expect(frameUrls).toContain(`${crossServer.origin}/frame-inner`)
  })

  it('验收四：框架内元素的 bounds 是**这一块视图**的坐标（引擎自己的盒子模型对得上）', async () => {
    const cross = encodeURIComponent(`${crossServer.origin}/frame-inner`)
    await session.goto(url(`/frames?cross=${cross}`))
    const snapshot = await session.snapshot()
    const frames = (await probePage()).frames()
    const sameFrame = frames.find((frame) => frame.url() === url('/frame-inner')) as Frame
    const crossFrame = frames.find((frame) => frame.url() === `${crossServer.origin}/frame-inner`) as Frame
    expect(sameFrame).toBeDefined()
    expect(crossFrame).toBeDefined()

    const sameBox = await sameFrame.locator('#fi-button').boundingBox()
    const crossBox = await crossFrame.locator('#xo-button').boundingBox()
    const sameInSnapshot = snapshot.elements.find((element) => element.frame === url('/frame-inner') && element.name === 'frame button')
    const crossInSnapshot = snapshot.elements.find((element) => element.frame === `${crossServer.origin}/frame-inner`)
    raw('两侧的矩形', { sameInSnapshot: sameInSnapshot?.bounds, sameBox, crossInSnapshot: crossInSnapshot?.bounds, crossBox })
    expect(sameInSnapshot).toBeDefined()
    expect(crossInSnapshot).toBeDefined()
    // 引擎自己算的 box model 也是主框架视口坐标：两条独立的路必须给出同一个矩形。
    expect(Math.abs((sameInSnapshot?.bounds.x as number) - (sameBox?.x as number))).toBeLessThan(COORD_EPSILON)
    expect(Math.abs((sameInSnapshot?.bounds.y as number) - (sameBox?.y as number))).toBeLessThan(COORD_EPSILON)
    expect(Math.abs((crossInSnapshot?.bounds.x as number) - (crossBox?.x as number))).toBeLessThan(COORD_EPSILON)
    expect(Math.abs((crossInSnapshot?.bounds.y as number) - (crossBox?.y as number))).toBeLessThan(COORD_EPSILON)
    // 而且它们**不是**框架内的局部坐标：那会让覆盖层把光标画在别的地方。
    const localBox = await sameFrame.evaluate(() => {
      const box = (document.getElementById('fi-button') as HTMLElement).getBoundingClientRect()
      return { x: box.left, y: box.top }
    })
    raw('框架内的局部坐标', localBox)
    expect(localBox.x).not.toBe(sameInSnapshot?.bounds.x)
  })

  it('验收四：动作真的落在框架里的元素上，主框架的 ref 不落到框架里，反之亦然', async () => {
    const cross = encodeURIComponent(`${crossServer.origin}/frame-inner`)
    await session.goto(url(`/frames?cross=${cross}`))
    const snapshot = await session.snapshot()
    const topRef = refOf(snapshot, 'top button')
    const frameButtons = snapshot.elements.filter((element) => element.name === 'frame button')
    const sameRef = frameButtons.find((element) => element.frame === url('/frame-inner'))?.ref as number
    const crossRef = frameButtons.find((element) => element.frame === `${crossServer.origin}/frame-inner`)?.ref as number

    await session.clickRef(topRef)
    expect(await pageText('frames-top-out')).toBe('top-button-clicked')
    // 主框架的动作没有碰任何框架里的东西。
    expect(await frameText(url('/frame-inner'), 'fi-out')).toBe('frame-initial')
    expect(await frameText(`${crossServer.origin}/frame-inner`, 'xo-out')).toBe('frame-initial')

    await session.clickRef(sameRef)
    expect(await frameText(url('/frame-inner'), 'fi-out')).toBe('frame-button-clicked')
    // 同源框架被点了，跨源框架没有被点 —— 同名控件分得开。
    expect(await frameText(`${crossServer.origin}/frame-inner`, 'xo-out')).toBe('frame-initial')
    expect(await pageText('frames-top-out')).toBe('top-button-clicked')

    await session.clickRef(crossRef)
    expect(await frameText(`${crossServer.origin}/frame-inner`, 'xo-out')).toBe('frame-button-clicked')

    // 写：往框架里的输入框填一个值，值出现在**框架自己**的文档里。
    const inputRef = snapshot.elements.find((element) => element.frame === url('/frame-inner') && element.role === 'textbox')?.ref
    expect(inputRef).toBeDefined()
    await session.fillRef(inputRef as number, 'written-into-the-frame')
    expect(await frameValue(url('/frame-inner'), 'fi-input')).toBe('written-into-the-frame')
    expect(await frameValue(`${crossServer.origin}/frame-inner`, 'xo-input')).toBe('')
  })

  it('验收四（与 T8 交叉检查）：覆盖层不进快照这条守卫在**每个框架**上都仍成立', async () => {
    const cross = encodeURIComponent(`${crossServer.origin}/frame-inner`)
    await session.goto(url(`/frames?cross=${cross}`))
    const snapshot = await session.snapshot()
    raw('逐框架的元素数', snapshot.elements.map((element) => ({ ref: element.ref, frame: element.frame ?? '<main>' })))

    const probe = await probePage()
    for (const frame of probe.frames()) {
      const label = frame === probe.mainFrame() ? '<main>' : frame.url()
      const overlayPresent = (await frame.evaluate(() => document.getElementById('dsh-cursor-overlay') !== null)) as boolean
      raw(`覆盖层是否在 ${label}`, overlayPresent)
      // T8 的覆盖层只挂最外层文档：这是它自己那条守卫，不该被 iframe 支持动过。
      expect(overlayPresent, `the overlay must not be mounted in ${label}`).toBe(frame === probe.mainFrame())

      const base = await frame.locator(SNAPSHOT_SELECTOR).count()
      const baseInsideOverlay = await frame
        .locator(SNAPSHOT_SELECTOR)
        .evaluateAll((nodes) => nodes.filter((node) => node.closest('#dsh-cursor-overlay') !== null).length)
      const labels = await frame.locator(CONTROL_LABEL_SELECTOR).count()
      const labelsInsideOverlay = await frame
        .locator(CONTROL_LABEL_SELECTOR)
        .evaluateAll((nodes) => nodes.filter((node) => node.closest('#dsh-cursor-overlay') !== null).length)
      // 这一类（可见 label）里，只有"它标注的控件没被列出"的那些才会进快照。测试在这里
      // 用**引擎自己匹配出来的那批节点**做判据（把基础匹配的句柄交给页面比身份），
      // 而不是在页面里手写一套"可见"的近似 —— 那正是 ADR-0005/0007 禁止的第二份定义。
      const baseHandles = await frame.locator(SNAPSHOT_SELECTOR).elementHandles()
      const keptTriggers = (await frame.locator(CONTROL_LABEL_SELECTOR).evaluateAll(
        (nodes, listed) => {
          const set = new Set(listed as unknown as Element[])
          return nodes.filter((node) => {
            const control = (node as HTMLLabelElement).control
            return control !== null && control !== undefined && !set.has(control)
          }).length
        },
        baseHandles as unknown as Element[],
      )) as number
      await Promise.all(baseHandles.map((handle) => handle.dispose()))
      const listed = snapshot.elements.filter((element) => (element.frame ?? '<main>') === label).length
      raw(`选择器算术 ${label}`, { base, baseInsideOverlay, labels, labelsInsideOverlay, keptTriggers, listed })
      // 精算而不是"包含"：选择器匹配数 + 新类里该进的那些 − 落在覆盖层里的 == 快照列出的数。
      expect(base - baseInsideOverlay + (keptTriggers - labelsInsideOverlay)).toBe(listed)
      // 覆盖层里的节点一个都不许被列出来（两类选择器都算）。
      expect(baseInsideOverlay).toBe(0)
      expect(labelsInsideOverlay).toBe(0)
    }
  })

  it('验收四（坑，反证）：把覆盖层做成一个 label，它照样不许进快照', async () => {
    await session.goto(url('/snapshot'))
    const before = await session.snapshot()
    // 一个"鬼元素"：注入到覆盖层容器里的、指向一个隐藏控件的可见 label。
    // 它**匹配**新增的那一类选择器 —— 也就是说，如果快照的收集里没有"覆盖层节点不进
    // 快照"那一步，它就会出现在快照里（回退那一步，这条必须变红）。
    const injected = await (await probePage()).evaluate(() => {
      const layer = document.getElementById('dsh-cursor-overlay')
      if (layer === null) return 'no overlay'
      const hidden = document.createElement('input')
      hidden.type = 'checkbox'
      hidden.id = 'ghost-control'
      hidden.style.display = 'none'
      const label = document.createElement('label')
      label.id = 'ghost-label'
      label.setAttribute('for', 'ghost-control')
      label.textContent = 'a ghost label inside the overlay'
      document.body.appendChild(hidden)
      layer.appendChild(label)
      return 'injected'
    })
    raw('注入', injected)
    expect(injected).toBe('injected')
    const probe = await probePage()
    const matchesTrigger = await probe.locator(CONTROL_LABEL_SELECTOR).evaluateAll((nodes) =>
      nodes.filter((node) => node.id === 'ghost-label').length,
    )
    raw('鬼元素被新类选择器匹配到几次', matchesTrigger)
    expect(matchesTrigger, 'the injected label must be a real match, or this test proves nothing').toBe(1)

    const after = await session.snapshot()
    raw('注入前后快照的元素名', { before: before.elements.map((element) => element.name), after: after.elements.map((element) => element.name) })
    expect(after.elements.map((element) => element.name)).toEqual(before.elements.map((element) => element.name))
    expect(after.elements.some((element) => element.name.includes('ghost'))).toBe(false)
    const ghostListed = await probe
      .locator(SNAPSHOT_SELECTOR)
      .evaluateAll((nodes) => nodes.filter((node) => node.closest('#dsh-cursor-overlay') !== null).length)
    expect(ghostListed).toBe(0)
    // 而那一类选择器**确实**认得出它 —— 所以上面那条"没进快照"不是因为它不匹配，
    // 是因为收集里那一步把它挡掉了（回退那一步，这条会变红）。
    const ghostInsideOverlay = await probe
      .locator(CONTROL_LABEL_SELECTOR)
      .evaluateAll((nodes) => nodes.filter((node) => node.closest('#dsh-cursor-overlay') !== null).length)
    raw('覆盖层里被新类选择器认出的节点数', ghostInsideOverlay)
    expect(ghostInsideOverlay).toBe(1)
  })

  it('ADR-0012：可见 label 只在它标注的控件没被列出时才进快照，既有夹具页一个元素都没变', async () => {
    // /snapshot 上有一个"标注可见文本框"的 label：它**不该**被列出来，所以这一页的
    // 元素集合与 T3 钉住的那份一字不差（T3 自己的等式断言也在跑，这是它的另一半）。
    await session.goto(url('/snapshot'))
    const snapshot = await session.snapshot()
    const probe = await probePage()
    const labelCount = await probe.locator('label').count()
    const baseMatches = await probe.locator(SNAPSHOT_SELECTOR).count()
    raw('/snapshot 的选择器匹配数、label 数、快照元素数', { baseMatches, labelCount, listed: snapshot.elements.length })
    expect(labelCount, 'this page must really have a label for the check to mean anything').toBeGreaterThan(0)
    expect(baseMatches).toBe(snapshot.elements.length)
    // 那个 label 自己不在快照里：一个 role 为 label 的元素都不该有。
    expect(snapshot.elements.some((element) => element.role === 'label')).toBe(false)

    // /labels：三种 label，只有"标注隐藏控件"的那一种进快照。
    await session.goto(url('/labels'))
    const labelsPage = await session.snapshot()
    raw('/labels 的快照', labelsPage)
    const pageFacts = await probe.evaluate(() => ({
      check: document.getElementById('lbl-check') !== null,
      text: document.getElementById('lbl-text') !== null,
      none: document.getElementById('lbl-none') !== null,
      hiddenControlVisible: (document.getElementById('lbl-hidden') as HTMLElement).offsetParent !== null,
    }))
    raw('/labels 页面事实', pageFacts)
    expect(pageFacts.hiddenControlVisible).toBe(false)
    // 三条都是 label；`lbl-text` 标注的那个**看得见**的输入框自己进了快照（名字就是
    // label 的文本），所以它那一条不是"label 进去了"，而是"输入框进去了"。
    const labelRoles = labelsPage.elements.filter((element) => element.role === 'label')
    raw('/labels 里 role=label 的元素', labelRoles)
    expect(labelRoles).toHaveLength(1)
    expect(labelRoles[0].name).toBe('a styled checkbox label')
    expect(labelsPage.elements.map((element) => element.role).sort()).toEqual(['label', 'textbox'])
    expect(labelsPage.elements.some((element) => element.name === 'a label for nothing')).toBe(false)

    // 这类元素今天"看得见却动不了"，现在它有 ref，而且点下去真的作用在隐藏的控件上。
    const labelRef = refOf(labelsPage, 'a styled checkbox label')
    await session.clickRef(labelRef)
    const log = await waitForPageText('lbl-log', 'checkbox-changed')
    raw('/labels 点击之后的页面日志', log)
    expect(log).toContain('checkbox-changed checked=true')
    expect(await pageValue('lbl-hidden')).toBe(true)
  })

  it('四个工具按声明的 schema 注册，且结果与 schema 对得上', async () => {
    const tools = desktopViewTools(() => Promise.resolve(session))
    const names = tools.map((tool) => tool.name)
    raw('注册的工具', names)
    for (const expected of ['browser_upload', 'browser_dialog', 'browser_download']) {
      expect(names).toContain(expected)
    }
    expect(tools[0]?.name).toBe('browser_navigate')
    const dialog = tools.find((tool) => tool.name === 'browser_dialog')
    const text = (await dialog?.execute({}, undefined as never)) as string
    raw('browser_dialog 的输出', text)
    expect(text).toContain('Answer in force')
    expect(text).toContain('beforeunload guard is always dismissed')
  })
})
