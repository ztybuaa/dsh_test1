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
 * ## 票 #20b 把这条不变量收得更紧了
 *
 * 票 #19 靠一个**模式状态机**表达这件事（`manual` = 人接管了，适配让位），而 #20b 把那个状态机
 * **整个删掉了**：适配永远开着，"谁在管这个缩放"只有一个答案。所以这一份里"启动时是 auto"
 * 不再是一条可能被谁改掉的状态，而是**一个常量**；下面几条断言量的是同一件事的两半：
 *
 *  - 启动时**没有任何请求**（`request.json` 不存在）—— 这条不变量一个字没变；
 *  - 那条曾被踩到的**形状**（一个指名了缩放值、`mode` 读作 `manual` 的请求）今天什么都关不掉了：
 *    它只会把那个值按上去，适配照旧在管。最后一条用例**亲手**写下它来钉这件事。
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

/**
 * `zoom.json` 里当前空间那一条读数（外壳每次缩放/适配都改写它）。
 *
 * 票 #20b 之后这里没有 `modeCause` 了：那个字段存在的理由是"分辨'启动时就是 manual'与'用户按过
 * 100%'"，而模式本身已经没有了 —— 那两件事今天在读数上**本来就该长得一样**（都只是"现在是多少"）。
 */
interface ZoomReading {
  zoom: number
  /** **兼容位**：适配永远开着，所以外壳永远发布 `auto`（旧插件在读这个字段，票面明令不许破）。 */
  mode: string
  fitPasses: number
  fitChanges: number
  lastFit?: { changed: number; steps: Array<Record<string, unknown>> }
}

/**
 * 读一次 `zoom.json`（票 #19 的那份"最新读数"）。
 *
 * 解析走 `SpaceManager.zoomReading` 的那份协议以外的东西**不另写一份**：这条用例要看的是
 * 原始文件里 `mode`/`fitPasses` 这些字段（票 #20b 之后 `modeCause` 已经不在里面了），
 * 而插件读它时只用得到 `zoom`/`mode`，所以这里直接解析文件，并把它当**外壳写的原文**来断言。
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

  it('宿主进程里读回：插件装上那一刻**没有**任何缩放请求，那一格归适配管、适配一轮都没跑过', () => {
    const atMount = probe.channel
    expect(atMount, 'the probe must have read the channel as its first action').not.toBeNull()
    if (atMount === null) return
    // 一、**没有任何人下过命令**：启动时 request.json 不存在（旧插件/坏天气才会在启动时写它）。
    expect(atMount.requestPresent, 'a fresh boot must not have a plugin request on the channel').toBe(false)
    expect(atMount.request).toBeNull()
    // 二、那一刻这一格就归适配管 —— 读的是**外壳写的那份文件**，不是插件的意图。
    expect(atMount.zoomReading?.mode, 'the pane must start under the fit, before anything is pressed').toBe('auto')
    // 三、`fitPasses: 0` 是**健康的**：那一刻还没有任何摆放变化，所以适配一次都不该跑过。
    //     （本票原本的 bug 正是"那一格已经不是适配在管了，而这个 0 没人读到"。）
    expect(atMount.zoomReading?.fitPasses).toBe(0)
    expect(atMount.stateRequestId, 'a fresh boot has handled no request').toBe(0)
    expect(atMount.stateRecord?.zoomMode, 'the published table must say auto too').toBe('auto')
    // 四、驱动过这一格之后（探针自己跑的那几条工具）**这一格不许被改到别人手里**：只有"有人指名
    //     要一个缩放值"才是那件事，而 `browser_space list` / `browser_extract` 都不是。
    expect(probe.channelAfter?.zoomReading?.mode, 'reading the page must not change who owns the zoom').toBe('auto')
  }, 60_000)

  it('外壳与面板两条路读回的都是 auto：`zoom.json`、`state.json`、工具条那颗读数三处一致', async () => {
    const now = reading()
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const panel = await callPanel('state')
    console.log('RAW 面板那条通道的回答: ' + JSON.stringify({ status: panel.status, value: panel.value ?? panel.body.slice(0, 300) }))
    expect(now?.mode).toBe('auto')
    expect(published?.record?.zoomMode).toBe('auto')
    expect(published?.requestId).toBe(0)
    expect(panel.status).toBe(200)
    // 工具条那颗读数就是从**这份通道**来的（`SpaceManager.zoomReading` → `zoom.json`）。
    // 票 #20b 之后面板**不再拿这个字段做任何事**（读数只有百分比），而它照旧在回答里 ——
    // 因为外壳仍在发布它（旧插件读它，兼容不许破）。
    expect(panel.value?.zoomMode, 'the published mode is still there for older readers').toBe('auto')
    expect(panel.value?.zoom).toBeCloseTo(now?.zoom ?? -1, 6)
    expect(spaces.zoomReading('default')?.mode).toBe('auto')
  }, 60_000)

  it('再等一会儿：仍然没人写过请求，那一格仍然归适配管（不是"启动一秒钟之后被谁改掉"）', async () => {
    await new Promise((settle) => setTimeout(settle, SETTLE_MS))
    const later = reading()
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const request = readChannel(shell.handshake.spaceChannel.requestFile)
    console.log('RAW 等待之后: ' + JSON.stringify({ later: later ?? null, requestId: published?.requestId ?? null, request: request ?? null }))
    expect(later?.mode, 'nothing in a product startup may hand the pane to a person').toBe('auto')
    expect(later?.fitPasses, 'no pane movement happened, so no fit round may have run').toBe(0)
    expect(published?.requestId).toBe(0)
    expect(request, 'a fresh boot leaves no request file at all').toBeUndefined()
  }, 60_000)

  it('票 #20b：人/工具指名一个缩放值**不再**把适配关掉；「自动」端点仍然能用（=现在就重新适配一次）', async () => {
    const named = await callPanel('zoom-reset')
    console.log('RAW 面板按了 100%: ' + JSON.stringify({ status: named.status, value: named.value }))
    expect(named.status).toBe(200)
    // **这一条就是票 #20b 翻转的断言**：票 #19 时它会答 `manual`（"从此由人管"），
    // 于是自动适配再也不动这一格。今天没有模式可切，它照旧答 `auto`。
    expect(named.value?.zoomMode, 'naming a zoom value must not hand the pane to a person any more').toBe('auto')
    expect(reading()?.mode, 'and the file the plugin reads says the same thing').toBe('auto')
    expect(spaceState(shell.handshake.spaceChannel.stateFile)?.record?.zoomMode).toBe('auto')

    // 旧客户端那颗「自动」走的端点留着（票面：兼容不许破），它的意思是"现在就重新适配一次"。
    // 这里顺带量到一件真事：**适配确实还在跑** —— `fitPasses` 涨了一轮。
    const beforeRefit = reading()?.fitPasses ?? 0
    const refit = await callPanel('auto')
    console.log('RAW 旧客户端那颗「自动」: ' + JSON.stringify({ status: refit.status, value: refit.value }))
    expect(refit.status).toBe(200)
    expect(refit.value?.zoomMode).toBe('auto')
    expect(String(refit.value?.message)).toContain('fitted this pane to the pane again')
    expect(reading()?.fitPasses ?? 0, 'the fit really ran: that is what "re-fit now" means').toBeGreaterThan(beforeRefit)
  }, 90_000)

  it('反证：亲手写下"启动时那条会关掉自动适配的请求" —— 它今天什么也关不掉了', async () => {
    // 这就是本票（#19 重开时）的形状：一个**指名了缩放值、而模式按缺省读作 manual** 的请求。
    // 它上一次的来路是"把外壳发布的状态原样写回去"（一次状态回显），今天本仓库里已经没有任何
    // 调用方会这么写 —— 所以这里**亲手**写一条进来。票 #19 那一版里它会把这一格切成 `manual`、
    // 从此适配一步都不动；**票 #20b 把那个模式删掉了**，所以它现在只剩"把 100% 按上去"这一个效果。
    // 这条用例的价值在**反证**：上面那几条"永远是 auto"的断言，正是在这里会红的地方。
    const published = spaceState(shell.handshake.spaceChannel.stateFile)
    const id = (published?.requestId ?? 0) + 1
    writeFileSync(
      shell.handshake.spaceChannel.requestFile,
      JSON.stringify({ id, active: 'default', spaces: [{ name: 'default', zoom: 1, mode: 'manual' }] }),
    )
    // 等外壳那 150ms 的轮询把它处理掉（`requestId` 前进就是"处理过了"）。
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (spaceState(shell.handshake.spaceChannel.stateFile)?.requestId ?? -1) < id) {
      await new Promise((settle) => setTimeout(settle, 100))
    }
    const afterEcho = reading()
    console.log('RAW 亲手写下去的状态回显: ' + JSON.stringify({ requestId: id, reading: afterEcho ?? null }))
    // 它真的被处理了（否则下面"什么也没关掉"就只是因为压根没人读那条请求）。
    expect(spaceState(shell.handshake.spaceChannel.stateFile)?.requestId).toBe(id)
    // 而它**关不掉任何东西**：读数仍然是 auto，那片表也仍然说 auto。
    expect(afterEcho?.mode, 'a state echo can no longer turn the fit off — that is the whole point of #20b').toBe('auto')
    expect(spaceState(shell.handshake.spaceChannel.stateFile)?.record?.zoomMode).toBe('auto')
    // 再等一会儿也还是 auto（不是"过一会儿才变"）。
    await new Promise((settle) => setTimeout(settle, 1_000))
    expect(reading()?.mode, 'and it stays that way: there is no mode left to drift into').toBe('auto')

    // 收尾：**适配仍然活着**（这一条把"没关掉"与"整条路都死了"分开）：请它重新适配一次，
    // `fitPasses` 必须真的涨。
    const before = reading()?.fitPasses ?? 0
    const refit = await callPanel('auto')
    console.log('RAW 回显之后再请它适配一次: ' + JSON.stringify({ status: refit.status, value: refit.value }))
    expect(refit.status).toBe(200)
    expect(reading()?.fitPasses ?? 0).toBeGreaterThan(before)
    expect(reading()?.mode).toBe('auto')
  }, 90_000)
})
