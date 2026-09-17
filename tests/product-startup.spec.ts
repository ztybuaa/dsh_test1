import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SpaceManager } from '../src/spaces.ts'
import { viewEndpointPath } from '../src/view-rpc.ts'
import {
  makeTempDshHome,
  removeWhenFree,
  resolveDshBinScript,
  shellRecord,
  startShell,
  waitForProbe,
  type ProbeReport,
  type ShellProcess,
  type TempDshHome,
} from './shell-harness.ts'

/**
 * 票 #19（重新打开）· **真实产品的启动序列**：全新启动之后，模式是 `auto`。
 *
 * ## 为什么要单独一个 spec
 *
 * 票面把没抓到这个 bug 的原因写得很清楚：既有的用例**直接驱动适配路径**（摆放变了 → 适配），
 * 而**没有一条走"真外壳 + 真插件装上 → 此刻模式是什么"**这条真实启动序列。于是
 * `fitPasses: 0`（一次都没跑过）这个状态没有任何用例读到过 —— 而用户报的正是它：
 * shell 一起来那一格就是 `manual`，拖侧边栏什么都不发生。
 *
 * 所以这一份问的是**启动之后那一刻的读数**，而不是"某个动作之后会怎样"：
 *
 *  1. 起一个**真外壳 + 真 `dsh` 宿主 + 真插件**（临时 `DSH_HOME`，用户自己的 `~/.dsh` 不碰）；
 *  2. 从**宿主进程里面**（`tests/fixtures/dsh-probe` 探针，第一件事）读回通道：
 *     有没有人在启动时写过请求、那一刻是哪一种模式、适配跑过几轮；
 *  3. 再从面板走的那条通道（`/api/desktop-view-state`，与 `panel-toolbar.spec.ts` 同一份信封）
 *     读回**工具条那颗读数**用的是哪一份答案；
 *  4. 最后让外壳**自己**再发布一次，确认那一格仍然是 `auto`。
 *
 * ## 什么算这条用例的"坏"
 *
 * 一个**指名了缩放值、而模式按缺省读作 `manual`** 的请求 —— 无论它来自"启动时的一次状态回显"
 * 还是别的什么 —— 都会让下面的断言在**第二、三、四条**上红，而 `modeCause` 会指出它是
 * `zoom-request`（有人下过命令）而不是 `boot`（从来没人碰过）。最后一条用例**亲手构造**那个
 * 请求，把这件事钉死：它不是一句推断，是这段用例真的会红的地方。
 */

/** 真宿主的启动预算（要 compose 整个 profile 树）。 */
const DSH_BOOT_TIMEOUT_MS = 180_000

/** 探针把报告写完的预算。 */
const PROBE_TIMEOUT_MS = 180_000

/** 外壳处理一条空间请求的轮询间隔是 150ms；等它几轮再断言，读数才落定。 */
const SETTLE_MS = 3_000

/** 通道文件的内容，读不到就是 undefined（还没写过）。 */
function readChannel(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** `zoom.json` 里当前空间那一条读数（外壳每次缩放/模式/适配都改写它）。 */
interface ZoomReading {
  zoom: number
  mode: string
  /** 这个模式是**谁**改成现在这样的（票 #19 重开时加的字段）。 */
  modeCause?: string
  fitPasses: number
  fitChanges: number
  lastFit?: { changed: number; steps: Array<Record<string, unknown>> }
}

/**
 * 读一次 `zoom.json`（票 #19 的那份"最新读数"）。
 *
 * 解析走 `SpaceManager.zoomReading` 的那份协议以外的东西**不另写一份**：这条用例要看的是
 * 原始文件里 `modeCause`/`fitPasses` 这些字段，而插件读它时只用得到 `zoom`/`mode`，
 * 所以这里直接解析文件，并把它当**外壳写的原文**来断言。
 *
 * @param file - 通道里的 `zoom.json`。
 * @returns 当前空间那条读数，或 undefined。
 */
function zoomReading(file: string): (ZoomReading & { cause?: string }) | undefined {
  const text = readChannel(file)
  if (text === undefined) return undefined
  const parsed = JSON.parse(text) as { cause?: string; spaces?: Record<string, ZoomReading> }
  const first = Object.values(parsed.spaces ?? {})[0]
  return first === undefined ? undefined : { ...first, cause: parsed.cause }
}

/** 外壳发布的空间表里，当前空间那条记录。 */
interface StateRecord {
  name: string
  zoom?: number
  zoomMode?: string
}

/**
 * 读一次 `state.json`：`requestId` 是"外壳处理到哪条请求了"（启动时是 0），
 * 每条记录的 `zoomMode` 是外壳**发布**出去的那份状态。
 */
function spaceState(file: string): { requestId: number; cause?: string; record: StateRecord | undefined } | undefined {
  const text = readChannel(file)
  if (text === undefined) return undefined
  const parsed = JSON.parse(text) as {
    requestId?: number
    cause?: string
    active?: string
    spaces?: StateRecord[]
  }
  return {
    requestId: typeof parsed.requestId === 'number' ? parsed.requestId : -1,
    cause: parsed.cause,
    record: (parsed.spaces ?? []).find((entry) => entry.name === (parsed.active ?? 'default')),
  }
}

/** 探针报告里那两次通道读数的形状（见 `tests/fixtures/dsh-probe/index.js`）。 */
interface ChannelObservation {
  atMs: number
  stateRecord: StateRecord | null
  stateRequestId: number | null
  stateCause: string | null
  zoomReading: ZoomReading | null
  zoomCause: string | null
  requestPresent: boolean
  request: unknown
  requestRaw: string | null
}

/** 探针报告的通道部分。 */
interface ProbeWithChannel extends ProbeReport {
  channel: ChannelObservation | null
  channelAfter: ChannelObservation | null
}

/** 面板那条通道上的一次回答。 */
interface PanelAnswer {
  status: number
  value: Record<string, unknown> | undefined
  body: string
}

describe('票 #19 重新打开 · 真外壳 + 真插件装上之后，模式是 auto（真实产品的启动序列）', () => {
  let home: TempDshHome
  let userDataDir: string
  let probeDir: string
  let shell: ShellProcess
  let probe: ProbeWithChannel
  let dshOrigin: string
  let cookie: string
  let spaces: SpaceManager

  /**
   * 走**面板那条通道**调一个动作，信封与 `dsh-client-connection` 的 `createWebConnectionRpc` 逐字段相同
   * （与 `panel-toolbar.spec.ts` 同一份写法：那是"面板上那颗按钮真的发了什么"的最接近的复现）。
   *
   * @param action - 动作名（`state` / `auto` / `zoom-reset` …）。
   * @returns 状态码、信封里的 `value`（失败时 undefined）与原文。
   */
  const callPanel = async (action: string): Promise<PanelAnswer> => {
    const response = await fetch(`${dshOrigin}${viewEndpointPath(action as never)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: dshOrigin },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `t19-startup-${action}-${String(Date.now())}`,
        method: `desktop-view-${action}`,
        payload: { nonce: String(Date.now()) },
      }),
    })
    const body = await response.text()
    const envelope = JSON.parse(body) as { result?: { ok?: boolean; value?: Record<string, unknown> } }
    return {
      status: response.status,
      value: envelope.result?.ok === true ? envelope.result.value : undefined,
      body,
    }
  }

  /** 现在这一格是什么模式：直接读外壳写的那份最新读数。 */
  const reading = (): (ZoomReading & { cause?: string }) | undefined => zoomReading(shell.handshake.spaceChannel.zoomFile)

  beforeAll(async () => {
    if (resolveDshBinScript() === undefined) {
      throw new Error(
        'this test needs the `dsh` launcher on PATH (or DSH_BIN pointing at @deepseek-ai/dsh/lib/bin.js): the ' +
          'whole point is the real product startup sequence, and that sequence is the shell starting a real host',
      )
    }
    // 探针以一个**额外 bundle** 的形式装进这个临时 profile（与用户装本插件的方式同形）。
    home = makeTempDshHome({
      profile: 'dshviewer',
      extraBundles: [{ name: 'dsh-t12-probe', dir: join(process.cwd(), 'tests', 'fixtures', 'dsh-probe') }],
    })
    userDataDir = mkdtempSync(join(tmpdir(), 'dsh-t19-startup-shell-'))
    probeDir = mkdtempSync(join(tmpdir(), 'dsh-t19-startup-probe-'))
    const probeFile = join(probeDir, 'probe.json')
    shell = await startShell(['--dsh'], {
      userDataDir,
      env: { DSH_HOME: home.home, DSH_T12_PROBE_OUT: probeFile, DSH_T12_PROBE_TIMEOUT_MS: '180000' },
      timeoutMs: DSH_BOOT_TIMEOUT_MS,
    })
    await shell.waitFor((out) => /^DSH_SHELL DSH_URL /m.test(out), 'the DSH address', DSH_BOOT_TIMEOUT_MS)
    const dshUrl = shellRecord<{ url: string }>(shell.stdout(), 'DSH_URL')?.url
    if (dshUrl === undefined) throw new Error('the shell printed no parsable DSH_URL record')
    const granted = await fetch(dshUrl, { redirect: 'manual' })
    cookie = ((granted.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [])
      .map((value) => value.split(';')[0])
      .join('; ')
    dshOrigin = new URL(dshUrl).origin
    probe = (await waitForProbe(probeFile, PROBE_TIMEOUT_MS)) as ProbeWithChannel
    spaces = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
      initialUrl: shell.handshake.viewUrl,
    })
    console.log('RAW 启动之后通道里的原文: ' + JSON.stringify({
      request: readChannel(shell.handshake.spaceChannel.requestFile) ?? null,
      state: spaceState(shell.handshake.spaceChannel.stateFile) ?? null,
      zoom: reading() ?? null,
    }))
    console.log('RAW 探针在装上那一刻读到的通道: ' + JSON.stringify(probe.channel))
  }, 2 * DSH_BOOT_TIMEOUT_MS)

  afterAll(async () => {
    if (spaces !== undefined) await spaces.close()
    if (shell !== undefined) await shell.stop()
    if (home !== undefined) home.remove()
    if (userDataDir !== undefined) removeWhenFree(userDataDir)
    if (probeDir !== undefined) removeWhenFree(probeDir)
  })

  it('宿主进程里读回：插件装上那一刻**没有**任何缩放请求，模式是 auto、适配一轮都没跑过', () => {
    const atMount = probe.channel
    expect(atMount, 'the probe must have read the channel as its first action').not.toBeNull()
    if (atMount === null) return
    // 一、**没有任何人下过命令**：启动时 request.json 不存在（旧插件/坏天气才会在启动时写它）。
    expect(atMount.requestPresent, 'a fresh boot must not have a plugin request on the channel').toBe(false)
    expect(atMount.request).toBeNull()
    // 二、那一刻这一格就是 auto —— 读的是**外壳写的那份文件**，不是插件的意图。
    expect(atMount.zoomReading?.mode, 'the pane must start in auto, before anything is pressed').toBe('auto')
    expect(atMount.zoomReading?.modeCause, 'and nothing may have set it: the cause of `auto` here is the boot').toBe('boot')
    // 三、`fitPasses: 0` 是**健康的**：那一刻还没有任何摆放变化，所以适配一次都不该跑过。
    //     （本票原本的 bug 正是"模式已经不是 auto 了，而这个 0 没人读到"。）
    expect(atMount.zoomReading?.fitPasses).toBe(0)
    expect(atMount.stateRequestId, 'a fresh boot has handled no request').toBe(0)
    expect(atMount.stateRecord?.zoomMode, 'the published table must say auto too').toBe('auto')
    // 四、驱动过这一格之后（探针自己跑的那几条工具）**模式不许变**：只有"有人指名要一个缩放值"
    //     才允许把它变成 manual，而 `browser_space list` / `browser_extract` 都不是那件事。
    expect(probe.channelAfter?.zoomReading?.mode, 'reading the page must not change who owns the zoom').toBe('auto')
  }, 60_000)

  it('外壳与面板两条路读回的都是 auto：`zoom.json`、`state.json`、工具条那颗读数三处一致', async () => {
    const now = reading()
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const panel = await callPanel('state')
    console.log('RAW 面板那条通道的回答: ' + JSON.stringify({ status: panel.status, value: panel.value ?? panel.body.slice(0, 300) }))
    expect(now?.mode).toBe('auto')
    expect(now?.modeCause).toBe('boot')
    expect(published?.record?.zoomMode).toBe('auto')
    expect(published?.requestId).toBe(0)
    expect(panel.status).toBe(200)
    // 工具条那颗读数就是从**这份通道**来的（`SpaceManager.zoomReading` → `zoom.json`），
    // 所以这里同时钉住"它写的是 `自动 100%`"：模式来自外壳，百分比来自外壳读回的 `getZoomFactor()`。
    expect(panel.value?.zoomMode, 'the toolbar must be told the pane is automatic').toBe('auto')
    expect(panel.value?.zoom).toBeCloseTo(now?.zoom ?? -1, 6)
    expect(spaces.zoomReading('default')?.mode).toBe('auto')
  }, 60_000)

  it('再等一会儿：仍然没人写过请求，模式仍然是 auto（不是"启动一秒钟之后被谁改掉"）', async () => {
    await new Promise((settle) => setTimeout(settle, SETTLE_MS))
    const later = reading()
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const request = readChannel(shell.handshake.spaceChannel.requestFile)
    console.log('RAW 等待之后: ' + JSON.stringify({ later: later ?? null, requestId: published?.requestId ?? null, request: request ?? null }))
    expect(later?.mode, 'nothing in a product startup may hand the pane to manual').toBe('auto')
    expect(later?.modeCause).toBe('boot')
    expect(later?.fitPasses, 'no pane movement happened, so no fit round may have run').toBe(0)
    expect(published?.requestId).toBe(0)
    expect(request, 'a fresh boot leaves no request file at all').toBeUndefined()
  }, 60_000)

  it('人/工具真的动了缩放：切到 manual；按「自动」交还；再发布一次仍然是 auto', async () => {
    const manual = await callPanel('zoom-reset')
    console.log('RAW 面板按了 100%: ' + JSON.stringify({ status: manual.status, value: manual.value }))
    expect(manual.status).toBe(200)
    expect(manual.value?.zoomMode, 'a manual zoom must be reported as manual').toBe('manual')
    expect(reading()?.modeCause, 'and the reason must be the command, not the boot').toBe('zoom-request')

    const handedBack = await callPanel('auto')
    console.log('RAW 面板按了「自动」: ' + JSON.stringify({ status: handedBack.status, value: handedBack.value }))
    expect(handedBack.status).toBe(200)
    expect(handedBack.value?.zoomMode).toBe('auto')
    expect(reading()?.modeCause).toBe('auto-request')
    // 交回自动之后再发布一次：`state.json` 那条记录也要说 auto（两处读数不许互相矛盾）。
    expect(spaceState(shell.handshake.spaceChannel.stateFile)?.record?.zoomMode).toBe('auto')
  }, 90_000)

  it('反证：把"启动时那条会关掉自动适配的请求"亲手写下去 —— 上面那几条断言正是在这里变红的', async () => {
    // 这就是本票重新打开时的形状：一个**指名了缩放值、而模式按缺省读作 manual** 的请求。
    // 它上一次的来路是"把外壳发布的状态原样写回去"（一次状态回显），今天本仓库里已经没有任何
    // 调用方会这么写 —— 所以这里**亲手**写一条，用来证明"启动时不许有请求"这条断言不是空话：
    // 只要真出现这样一条，`mode` 就会变成 manual、`modeCause` 会变成 `zoom-request`，
    // 上面两条用例的第二、三处断言必然红。
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const id = (published?.requestId ?? 0) + 1
    writeFileSync(
      shell.handshake.spaceChannel.requestFile,
      JSON.stringify({ id, active: 'default', spaces: [{ name: 'default', zoom: 1, mode: 'manual' }] }),
    )
    // 等外壳那 150ms 的轮询把它处理掉。
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (reading()?.modeCause ?? '') !== 'zoom-request') {
      await new Promise((settle) => setTimeout(settle, 100))
    }
    const hijacked = reading()
    console.log('RAW 亲手写下去的状态回显: ' + JSON.stringify({ requestId: id, reading: hijacked ?? null }))
    expect(hijacked?.mode, 'a state echo that names a zoom value DOES hand the pane to manual — that is the bug').toBe('manual')
    expect(hijacked?.modeCause).toBe('zoom-request')
    // 而且从这一刻起**它不再自己动**：模式不是 auto，所以没有任何一轮适配会碰它。
    // （前一条用例里那次「自动」留下的 `fitPasses: 1` 是"跑过一轮、判断不动手"，`fitChanges`
    //   是 0 —— 这里不动 `fitPasses`，因为那是外壳的历史，不是"现在还会不会动"。）
    expect(hijacked?.fitChanges).toBe(0)
    await new Promise((settle) => setTimeout(settle, 2_000))
    expect(reading()?.mode, 'and it stays manual: nothing hands it back on its own').toBe('manual')
    expect(reading()?.fitPasses, 'no further fit round may run while a person owns the zoom').toBe(hijacked?.fitPasses)
    // 旧插件的兼容语义就在这一条里：**指名了缩放值、没带 mode** ⇒ manual，一字不变。
    expect(spaceState(shell.handshake.spaceChannel.stateFile)?.requestId).toBe(id)

    // 收尾：把这一格交回自动，「自动」这颗按钮**必须仍然出得来**（手动不是一个进得去出不来的状态）。
    const handedBack = await callPanel('auto')
    console.log('RAW 交回自动: ' + JSON.stringify({ status: handedBack.status, value: handedBack.value }))
    expect(handedBack.status).toBe(200)
    expect(handedBack.value?.zoomMode).toBe('auto')
    expect(reading()?.modeCause).toBe('auto-request')
  }, 90_000)
})
