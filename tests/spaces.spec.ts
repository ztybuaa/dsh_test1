import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  SpaceManager,
  describeSpaceTable,
  parseSpaceState,
  planRequest,
  planZoom,
  spaceChannelFrom,
  type SpaceState,
} from '../src/spaces.ts'
import { desktopViewTools } from '../src/tools.ts'
import {
  pageForTarget,
  removeWhenFree,
  shellRecord,
  startShell,
  type ShellProcess,
} from './shell-harness.ts'

/**
 * T7 (票 #8) — 任务空间隔离。四条验收各自有一处**独立读回**，而且读回的东西不是实现自己的中间量：
 *
 *  1. **能创建/使用/关闭；关闭后页面与存储被释放** —— 空间表来自外壳发布的 `DSH_SHELL SPACES`
 *     与它写的 state 文件；"页面还在不在"用**直接问 CDP 端点 `/json/list`**回答（不是问插件），
 *     并额外试一次"按 targetId 领养"（领不到就是真的没了）；"存储被释放"用**重建同名空间后
 *     读页面自己渲染出来的登录状态**回答；"目录"这一半**如实**断言进程内删不掉、下次启动才删掉。
 *  2. **两个空间在同一站点登录互不影响** —— 先断言两者的 `location.origin` **逐字相同**
 *     （照 `tests/identity.spec.ts` 那条的写法），否则"看不见"能被 origin 不同解释；然后让两个
 *     空间在同一站点各自登录，用**页面自己渲染出来的 `#who`** 读回。
 *  3. **新空间继承默认档案的登录态** —— 先在默认空间登录（cookie 一处、localStorage 一处），
 *     再创建新空间，读回它自己渲染的 `#who`。**边界单独一条**：默认档案里**另一个 origin** 的
 *     localStorage **不会**被继承（这是实测出来的能力边界，见 ADR-0010 §3）。
 *  4. **所有工具只作用于当前空间** —— 用**真的工具**（`desktopViewTools`）在一个空间里导航，
 *     然后**绕开插件**、通过另一条 CDP 连接读另一个空间的页面，证明它一步没动。
 *
 * 纯逻辑那部分（空间命名、请求归一化、reconcile、"期望状态"怎么算）不起外壳也能读回，
 * 所以它单独一组用例。
 */

const require = createRequire(import.meta.url)

/** `shell/spaces.js`：空间命名与生命周期判断，纯逻辑，不 require('electron')。 */
const shellSpaces = require('../shell/spaces.js') as {
  DEFAULT_PARTITION: string
  DEFAULT_SPACE: string
  SPACE_PROTOCOL: number
  isValidSpaceName: (name: unknown) => boolean
  mergeTargetIds: (
    previous: string | undefined,
    listing: { ok: true; targetId?: string; listedPages?: number; webContentsId?: number } | { ok: false; error: string },
  ) => { targetId?: string; targetIdSource: 'resolved' | 'remembered' | 'unavailable'; targetIdReason?: string }
  parseRequest: (
    raw: unknown,
  ) =>
    | { ok: true; request: { id: number; active: string; spaces: string[]; zooms: Array<{ name: string; zoom: number }> } }
    | { ok: false; error: string }
  partitionDirectoryName: (partition: string) => string
  partitionForSpace: (name: string) => string
  reconcile: (input: { current: string[]; request: { active: string; spaces: string[] } }) => {
    create: string[]
    close: string[]
    activate: string
  }
  spaceChannel: (userDataDir: string) => {
    dir: string
    requestFile: string
    stateFile: string
    pendingDeletionFile: string
    protocol: number
  }
  spaceForPartition: (partition: string) => string | undefined
  spaceStoragePath: (userDataDir: string, name: string) => string
}

/** 工具的执行上下文这些工具用不到；给个占位。 */
const IGNORED_EXEC = undefined as unknown as Parameters<ReturnType<typeof desktopViewTools>[number]['execute']>[1]

/** 外壳写的 state 文件读回来的形状（这里**自己**解析，不用被测的解析器）。 */
interface RawSpaceRecord {
  name: string
  partition: string
  storagePath: string
  persistent: boolean
  targetId?: string
  /** 外壳对这个 targetId 怎么来的说的话（`resolved` / `remembered` / `unavailable`）。 */
  targetIdSource?: 'resolved' | 'remembered' | 'unavailable'
  /** 外壳给的原因：读不到目标时它是唯一说得清的那句话。 */
  targetIdReason?: string
  url: string
  visible: boolean
  webContentsId: number
  active: boolean
  isDefault: boolean
  cookieCount: number
  inherited?: {
    sourceUrl: string
    cookiesOffered: number
    cookiesInSpace: number
    localStorageOrigin: string | null
    localStorageKeys: number
  }
}

/** 外壳写的实际状态。 */
interface RawSpaceState {
  protocol: number
  requestId: number
  error: string | null
  active: string
  userDataDir: string
  cause?: string
  spaces: RawSpaceRecord[]
  lastRequest?: { id: number; create: string[]; close: string[]; activate: string; error: string | null }
}

/**
 * 一个把"登录态放在哪"分开的站点。
 *
 * 两个页面渲染**同一件事**（`#who` 里写着自己是谁），但一个从 cookie 读、一个从 localStorage 读。
 * 页面自己算出来的这句话就是"登录态在不在"的独立证据：测试不告诉它答案，它从自己的存储里读。
 *
 * @param source - 从哪儿读 token。
 * @returns 页面 HTML。
 */
function loginPage(source: 'cookie' | 'local'): string {
  const read =
    source === 'cookie'
      ? "const match = /(?:^|; )token=([^;]*)/.exec(document.cookie); const token = match ? match[1] : null"
      : "const token = localStorage.getItem('token')"
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>login-site</title></head><body>' +
    `<h1 id="who"></h1><script>${read}; document.getElementById('who').textContent = token === null ? 'signed out' : 'signed in as ' + token</script>` +
    '</body></html>'
  )
}

/** 一个测试自己的站点；同一个处理器挂在**两个回环字面量**上，于是它有两个 origin。 */
interface TestSite {
  /** 第一个 origin（也是空间默认落脚的地方）。 */
  origin: string
  /**
   * 第二个 origin，同一个站点、不同的 host。
   *
   * 必须是不同的 **host** 而不只是不同的端口：cookie 是按**域**存的、不认端口，所以
   * `127.0.0.1:8001` 与 `127.0.0.1:8002` 共用同一个 cookie 罐，用它去证明"跨 origin 的 cookie 也继承"
   * 会得出一个假的结论。而 `127.0.0.2` 与 `127.0.0.1` 既是两个 origin，又是两个域。
   */
  altOrigin: string
  close: () => Promise<void>
}

/**
 * 起一个站点：同一个处理器绑在 `127.0.0.1` 与 `127.0.0.2` 两个回环字面量上。
 *
 * 两个地址都是回环，不牵扯 DNS 也不对外暴露；但它们对浏览器是**两个 origin、两个 cookie 域**。
 *
 * @returns 两个 origin 与关闭函数。
 */
async function startSite(): Promise<TestSite> {
  const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (path === '/cookie-site') response.end(loginPage('cookie'))
    else if (path === '/local-site') response.end(loginPage('local'))
    else response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>other</title></head><body><p>other</p></body></html>')
  }
  const listen = async (host: string): Promise<{ server: import('node:http').Server; origin: string }> => {
    const server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, resolve)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { server, origin: `http://${host}:${port}` }
  }
  const primary = await listen('127.0.0.1')
  const alternate = await listen('127.0.0.2')
  return {
    origin: primary.origin,
    altOrigin: alternate.origin,
    close: async () => {
      await new Promise<void>((resolve) => primary.server.close(() => resolve()))
      await new Promise<void>((resolve) => alternate.server.close(() => resolve()))
    },
  }
}

/**
 * 直接读外壳写的 state 文件。
 *
 * 这里**不用** `src/spaces.ts` 的解析器：那是被测代码。读的是原始 JSON。
 *
 * @param shell - 正在跑的外壳。
 * @returns 状态。
 */
function readState(shell: ShellProcess): RawSpaceState {
  return JSON.parse(readFileSync(shell.handshake.spaceChannel.stateFile, 'utf8')) as RawSpaceState
}

/** 一个空间在外壳发布的状态里的记录。 */
function spaceOf(state: RawSpaceState, name: string): RawSpaceRecord | undefined {
  return state.spaces.find((space) => space.name === name)
}

/** 直接问外壳的 CDP 端点有哪些 page 目标。 */
async function pageTargets(cdpUrl: string): Promise<Array<{ id: string; type: string; url: string; title: string }>> {
  const response = await fetch(`${cdpUrl}/json/list`)
  const list = (await response.json()) as Array<{ id: string; type: string; url: string; title: string }>
  return list.filter((target) => target.type === 'page')
}

/** 等外壳发布的某个事实出现。 */
async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((settle) => setTimeout(settle, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * 通过**另一条** CDP 连接拿到某个空间的页面，做完事再断开。
 *
 * 这条路径完全绕开 `SpaceManager`：所以"另一个空间没被动过"是用插件看不见的一双眼睛读回来的。
 *
 * @param shell - 正在跑的外壳。
 * @param name - 空间名。
 * @param action - 拿到页面后要做的事。
 * @returns `action` 的返回值。
 */
async function withSpacePage<T>(shell: ShellProcess, name: string, action: (page: Page) => Promise<T>): Promise<T> {
  const state = readState(shell)
  const record = spaceOf(state, name)
  if (record?.targetId === undefined) {
    // 这条消息是**给下一次偶发红用的**：T7 之后它只说了"没有 target id"，于是那一次红
    // 完全没法判读。现在它把外壳给的**原因**和整张表一起打出来（见 docs/research/…）。
    throw new Error(
      `the shell published no target id for the space "${name}"` +
        (record === undefined
          ? ` — it does not describe that space at all (it describes: ${state.spaces.map((space) => space.name).join(', ') || 'nothing'})`
          : ` — targetIdSource=${JSON.stringify(record.targetIdSource)}, targetIdReason=${JSON.stringify(record.targetIdReason)}`) +
        `\n--- the table the shell published ---\n` +
        JSON.stringify(
          state.spaces.map((space) => ({
            name: space.name,
            targetId: space.targetId,
            targetIdSource: space.targetIdSource,
            url: space.url,
            visible: space.visible,
          })),
          null,
          2,
        ),
    )
  }
  const opened = await pageForTarget(shell.handshake.cdpUrl, record.targetId)
  try {
    return await action(opened.page)
  } finally {
    await opened.browser.close()
  }
}

/** 在一个空间的页面里用 cookie 登录，并读回页面自己渲染出来的那句话。 */
async function signInWithCookie(page: Page, url: string, token: string): Promise<string | null> {
  await page.goto(url)
  await page.evaluate((value: string) => {
    document.cookie = `token=${value}; max-age=3600; path=/`
  }, token)
  await page.reload()
  return page.textContent('#who')
}

/** 在一个空间的页面里用 localStorage 登录，并读回页面自己渲染出来的那句话。 */
async function signInWithLocalStorage(page: Page, url: string, token: string): Promise<string | null> {
  await page.goto(url)
  await page.evaluate((value: string) => {
    localStorage.setItem('token', value)
  }, token)
  await page.reload()
  return page.textContent('#who')
}

/** 只读一次"我现在是谁"。 */
async function whoIs(page: Page, url: string): Promise<string | null> {
  await page.goto(url)
  return page.textContent('#who')
}

/**
 * 从**浏览器侧**读一个空间在那个站点的 cookie。
 *
 * 走这个空间自己那块视图的 CDP 会话（`Network.getCookies`），所以读到的是那个 partition 的罐子，
 * 而不是插件或外壳说的任何话。"这个空间真的有它自己的 cookie"因此是一件被独立读回来的事实。
 *
 * @param shell - 正在跑的外壳。
 * @param name - 空间名。
 * @param url - 要读 cookie 的地址。
 * @returns cookie 的名字与值。
 */
async function cookiesInSpace(
  shell: ShellProcess,
  name: string,
  url: string,
): Promise<Array<{ name: string; value: string; domain: string }>> {
  return withSpacePage(shell, name, async (page) => {
    const session = await page.context().newCDPSession(page)
    try {
      const result = (await session.send('Network.getCookies', { urls: [url] })) as {
        cookies: Array<{ name: string; value: string; domain: string }>
      }
      return result.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain }))
    } finally {
      await session.detach()
    }
  })
}

/** 让面板报一个矩形，这样那一格里的视图是真的显示出来的（T2 的通道，这里只当它是输入）。 */
async function reportPanelRect(shell: ShellProcess): Promise<void> {
  if (shell.handshake.windowTargetId === undefined) throw new Error('the shell published no window target id')
  const opened = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.windowTargetId)
  try {
    await opened.page.evaluate(
      `window.__dshDesktopView.setRect(${JSON.stringify({ x: 10, y: 20, width: 400, height: 600 })})`,
    )
  } finally {
    await opened.browser.close()
  }
  await shell.waitForPlacement((placement) => placement.visible && placement.bounds !== null, 'a visible placement')
}

describe('T7 — 空间命名与生命周期里那点纯逻辑（不起外壳）', () => {
  it('默认空间就是 T6 那一格：partition 一字不改，新空间从同一命名家族长出来', () => {
    console.log('RAW partitions: ' + JSON.stringify({
      default: shellSpaces.partitionForSpace('default'),
      task1: shellSpaces.partitionForSpace('task-1'),
      directoryName: shellSpaces.partitionDirectoryName('persist:dsh-view-space-task-1'),
      storagePath: shellSpaces.spaceStoragePath('C:\\p', 'task-1'),
      backAgain: shellSpaces.spaceForPartition('persist:dsh-view-space-task-1'),
    }))
    // T6 已经把那一格落在 `persist:dsh-view` 上，用户可能已经登录过了：改它就等于弄丢登录态。
    expect(shellSpaces.partitionForSpace('default')).toBe('persist:dsh-view')
    expect(shellSpaces.DEFAULT_PARTITION).toBe('persist:dsh-view')
    expect(shellSpaces.partitionForSpace('task-1')).toBe('persist:dsh-view-space-task-1')
    // partition ↔ 名字能来回；档案目录**从 userDataDir 推导**，不另立位置。
    expect(shellSpaces.spaceForPartition('persist:dsh-view-space-task-1')).toBe('task-1')
    expect(shellSpaces.spaceForPartition('persist:dsh-view')).toBe('default')
    expect(shellSpaces.spaceForPartition('persist:something-else')).toBeUndefined()
    expect(shellSpaces.spaceStoragePath('C:\\p', 'task-1')).toBe(join('C:\\p', 'Partitions', 'dsh-view-space-task-1'))
  })

  it('空间名同时是一个目录名，所以它的形状被钉死', () => {
    const accepted = ['a', 'task-1', 't7', 'a2345678901234567890123456789012']
    const rejected = ['', 'A', 'Task 1', 'task_1', 'task/1', 'task.1', '中文', '-lead', 'a'.repeat(33), '.', '..', 'task\\1']
    console.log('RAW name check: ' + JSON.stringify({ accepted: accepted.map(shellSpaces.isValidSpaceName), rejected: rejected.map(shellSpaces.isValidSpaceName) }))
    for (const name of accepted) expect(shellSpaces.isValidSpaceName(name), `${name} should be usable`).toBe(true)
    for (const name of rejected) expect(shellSpaces.isValidSpaceName(name), `${name} should be refused`).toBe(false)
  })

  it('一条请求：先建、再关、默认空间永不关；丢掉默认空间的请求被拒绝', () => {
    const diff = shellSpaces.reconcile({ current: ['default', 'old'], request: { active: 'fresh', spaces: ['default', 'fresh'] } })
    console.log('RAW reconcile: ' + JSON.stringify(diff))
    expect(diff.create).toEqual(['fresh'])
    expect(diff.close).toEqual(['old'])
    expect(diff.activate).toBe('fresh')

    const refused = shellSpaces.parseRequest({ id: 3, active: 'task-1', spaces: ['task-1'] })
    console.log('RAW refused request: ' + JSON.stringify(refused))
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error).toContain('default')
  })

  it('请求归一化：非法名字与重复名字都有说得清的理由；合法请求原样通过', () => {
    const cases = [
      { id: 1, active: 'task-1', spaces: ['default', 'task-1'] },
      { id: 0, active: 'default', spaces: ['default'] },
      { id: 2, active: 'task-1', spaces: ['default', 'Task 1'] },
      { id: 3, active: 'task-1', spaces: ['default', 'task-1', 'task-1'] },
      { id: 4, active: 'ghost', spaces: ['default'] },
      { id: 5, active: 'default', spaces: 'default' },
    ]
    const results = cases.map((entry) => shellSpaces.parseRequest(entry))
    console.log('RAW parseRequest: ' + JSON.stringify(results))
    expect(results[0]?.ok).toBe(true)
    for (const result of results.slice(1)) expect(result.ok).toBe(false)
  })

  it('票 #13：请求里那块视图可以带上 zoom；只有**被改动的那一个**带，形状不对的拒绝', () => {
    // 一项可以只是名字，也可以是 `{name, zoom}`；归一化之后 zoom 单独成一张表。
    const named = shellSpaces.parseRequest({
      id: 9,
      active: 'default',
      spaces: ['default', { name: 'task-1', zoom: 0.5 }],
    })
    console.log('RAW parseRequest with a zoom: ' + JSON.stringify(named))
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect(named.request.spaces).toEqual(['default', 'task-1'])
    expect(named.request.zooms).toEqual([{ name: 'task-1', zoom: 0.5 }])

    // 形状不对的拒绝：0、负数、NaN、字符串都过不去，理由说得清它是什么。
    for (const bad of [0, -1, Number.NaN, '0.5']) {
      const refused = shellSpaces.parseRequest({
        id: 10,
        active: 'default',
        spaces: ['default', { name: 'task-1', zoom: bad }],
      })
      console.log(`RAW parseRequest zoom ${JSON.stringify(bad)}: ` + JSON.stringify(refused))
      expect(refused.ok, `zoom ${JSON.stringify(bad)} must be refused`).toBe(false)
      if (refused.ok) continue
      expect(refused.error).toContain('greater than 0')
    }
    // 合法的 0.25 与 5 都要过（范围是插件的策略，这里只管形状）。
    for (const good of [0.25, 5]) {
      const accepted = shellSpaces.parseRequest({
        id: 11,
        active: 'default',
        spaces: ['default', { name: 'task-1', zoom: good }],
      })
      expect(accepted.ok, `zoom ${good} must be accepted`).toBe(true)
    }
  })

  it('票 #13：协议的形状变了，版本号跟着加一（两边能明确地对不上）', () => {
    console.log('RAW SPACE_PROTOCOL: ' + JSON.stringify({ shell: shellSpaces.SPACE_PROTOCOL, channel: shellSpaces.spaceChannel('C:\\p').protocol }))
    // 请求里多了可选的 `zoom`、state 里多了每条记录的 `zoom` —— 加一。
    expect(shellSpaces.SPACE_PROTOCOL).toBe(2)
    expect(shellSpaces.spaceChannel('C:\\p').protocol).toBe(2)
  })

  it('票 #13：planZoom 把"给某一个空间换缩放"算成一条请求，只给那一个带 zoom', () => {
    const state = {
      protocol: 2,
      requestId: 4,
      error: null,
      active: 'task-1',
      userDataDir: 'C:\\p',
      spaces: [{ name: 'default' } as never, { name: 'task-1' } as never],
      skipped: [],
    }
    const planned = planZoom(state, 'default', 0.5)
    console.log('RAW planZoom: ' + JSON.stringify(planned))
    if ('error' in planned) throw new Error(planned.error)
    // id 单调加一、当前空间不动、**只有** default 带上 zoom —— 其余原样是名字。
    expect(planned.request.id).toBe(5)
    expect(planned.request.active).toBe('task-1')
    expect(planned.request.spaces).toEqual([{ name: 'default', zoom: 0.5 }, 'task-1'])

    // 不认识的空间：说得清有哪几个。
    const refused = planZoom(state, 'ghost', 0.5)
    console.log('RAW planZoom(ghost): ' + JSON.stringify(refused))
    expect('error' in refused).toBe(true)
  })

  it('插件侧：create 顺手切过去、关掉当前空间时接班的是默认空间、名字不认识时说得清', () => {
    const state = {
      protocol: 2,
      requestId: 7,
      error: null,
      active: 'default',
      userDataDir: 'C:\\p',
      spaces: [
        { name: 'default' } as never,
        { name: 'task-1' } as never,
      ],
      // 这份字面量只喂给 `planRequest`（纯逻辑，不看 skipped）；字段是必填的，所以给一个空的。
      skipped: [],
    } satisfies SpaceState
    const create = planRequest(state, { action: 'create', name: 'task-2' })
    const use = planRequest(state, { action: 'use', name: 'task-1' })
    const closeActiveSource = { ...state, active: 'task-1' }
    const close = planRequest(closeActiveSource, { action: 'close', name: 'task-1' })
    const unknown = planRequest(state, { action: 'use', name: 'nope' })
    const closeDefault = planRequest(state, { action: 'close', name: 'default' })
    console.log('RAW planRequest: ' + JSON.stringify({ create, use, close, unknown, closeDefault }))
    expect(create).toEqual({ request: { id: 8, active: 'task-2', spaces: ['default', 'task-1', 'task-2'] } })
    expect(use).toEqual({ request: { id: 8, active: 'task-1', spaces: ['default', 'task-1'] } })
    // 关掉当前空间之后不能留下"当前空间指向一个不存在的空间"。
    expect(close).toEqual({ request: { id: 8, active: 'default', spaces: ['default'] } })
    expect('error' in unknown && unknown.error).toContain('no space named "nope"')
    expect('error' in closeDefault && closeDefault.error).toContain('default')
  })

  it('读不动的 state 是"还没有状态"，不是"一个空间都没有"', () => {
    const channel = spaceChannelFrom('C:\\p\\spaces')
    console.log('RAW channel: ' + JSON.stringify(channel))
    expect(channel?.stateFile).toBe(join('C:\\p\\spaces', 'state.json'))
    expect(channel?.requestFile).toBe(join('C:\\p\\spaces', 'request.json'))
    expect(spaceChannelFrom(undefined)).toBeUndefined()
    expect(spaceChannelFrom('   ')).toBeUndefined()
    expect(parseSpaceState('{ not json')).toBeUndefined()
    expect(parseSpaceState('{}')).toBeUndefined()
    expect(parseSpaceState('{"requestId":1,"active":"default","protocol":1,"spaces":[]}')?.active).toBe('default')

    /*
     * 票 #15 改了这条断言，改的是**哪一层的失败**，不是"要不要严格"：
     *
     *  - `spaces` 里出现**不是对象**的东西 → 那不是一条记录，是这个数组的形状坏了 → 整份不可读；
     *  - 一条记录**少字段** → 那是"这一条不可用"，跳过它并说明原因，其余空间照常可用。
     *
     * 原来这里钉的是后者也整份返回 undefined，也就是"一条坏记录能让默认空间一起消失"。
     * 那是本票要消灭的单点失败，所以这条断言跟着新契约走（`docs/research/destroyed-space-record.md`）。
     */
    const notARecord = parseSpaceState('{"requestId":1,"active":"default","protocol":1,"spaces":[1]}')
    console.log('RAW a `spaces` array whose shape is broken: ' + JSON.stringify(notARecord))
    expect(notARecord).toBeUndefined()
    const oneBadRecord = parseSpaceState('{"requestId":1,"active":"default","protocol":1,"spaces":[{"name":1}]}')
    console.log('RAW one bad record among the spaces: ' + JSON.stringify({ spaces: oneBadRecord?.spaces, skipped: oneBadRecord?.skipped }))
    expect(oneBadRecord?.spaces).toEqual([])
    expect(oneBadRecord?.skipped).toHaveLength(1)
    expect(oneBadRecord?.skipped[0]?.index).toBe(0)
    expect(oneBadRecord?.skipped[0]?.reason).toContain('name, partition, storagePath, url')
  })

  it('发布的表不许比它知道的更少：解析到的 > 记住的 > 显式说没有（纯逻辑）', () => {
    const cases = {
      // 这一次读到了：以这一次为准。
      resolved: shellSpaces.mergeTargetIds('OLD', { ok: true, targetId: 'NEW', listedPages: 2, webContentsId: 3 }),
      // 列举本身失败（回环端点那一刻读不回来）：**不许**把已知的抹掉。
      listingFailed: shellSpaces.mergeTargetIds('OLD', { ok: false, error: 'socket hang up' }),
      // 列举成功但里面没有这块视图：同样不许把已知的抹掉（视图的 target id 不会变）。
      notListed: shellSpaces.mergeTargetIds('OLD', { ok: true, listedPages: 2, webContentsId: 3 }),
      // 从来没读到过：显式说明，而不是少一个字段。
      neverKnown: shellSpaces.mergeTargetIds(undefined, { ok: false, error: 'socket hang up' }),
      // 空串不是 id：它和"没有"是同一件事，不许被当成一个可用的目标。
      emptyIsNotAnId: shellSpaces.mergeTargetIds('', { ok: true, targetId: '', listedPages: 0 }),
      // 新空间（entry 上还没有 id）+ 这一次读到了：照常解析。
      fresh: shellSpaces.mergeTargetIds(undefined, { ok: true, targetId: 'FIRST', listedPages: 2 }),
    }
    console.log('RAW mergeTargetIds: ' + JSON.stringify(cases))
    expect(cases.resolved).toEqual({ targetId: 'NEW', targetIdSource: 'resolved' })
    expect(cases.fresh).toEqual({ targetId: 'FIRST', targetIdSource: 'resolved' })
    expect(cases.listingFailed.targetId).toBe('OLD')
    expect(cases.listingFailed.targetIdSource).toBe('remembered')
    expect(cases.listingFailed.targetIdReason).toContain('socket hang up')
    expect(cases.notListed.targetId).toBe('OLD')
    expect(cases.notListed.targetIdSource).toBe('remembered')
    expect(cases.neverKnown.targetId).toBeUndefined()
    expect(cases.neverKnown.targetIdSource).toBe('unavailable')
    expect(cases.neverKnown.targetIdReason).toContain('socket hang up')
    expect(cases.emptyIsNotAnId.targetIdSource).toBe('unavailable')
  })

  it('插件侧：外壳说了"这个空间还没有 target"，解析不许把它丢掉', () => {
    const raw = JSON.stringify({
      protocol: 1,
      requestId: 4,
      error: null,
      active: 'task-1',
      userDataDir: 'C:\\p',
      spaces: [
        {
          name: 'task-1',
          partition: 'persist:dsh-view-space-task-1',
          storagePath: 'C:\\p\\Partitions\\dsh-view-space-task-1',
          persistent: true,
          targetIdSource: 'unavailable',
          targetIdReason: 'the CDP endpoint could not be listed (boom)',
          url: '',
          visible: false,
          webContentsId: 2,
          active: true,
          isDefault: false,
          cookieCount: 0,
        },
      ],
    })
    const parsed = parseSpaceState(raw)
    console.log('RAW parsed unavailable record: ' + JSON.stringify(parsed?.spaces[0]))
    expect(parsed?.spaces[0]?.targetIdSource).toBe('unavailable')
    expect(parsed?.spaces[0]?.targetIdReason).toBe('the CDP endpoint could not be listed (boom)')
    // ……而且列出来的时候也不许静默省略：那一行要说清它为什么动不了。
    expect(describeSpaceTable(parsed as SpaceState)).toContain('could not be listed')
  })

  it('外壳不在时，工具拿到的是一个说得清的超时错误，而不是模糊的"等不到"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-noshell-'))
    try {
      // 手工造一份"外壳写过"的状态：这样失败点落在"这条请求没人处理"，而不是"压根没有状态"。
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          protocol: 1,
          requestId: 4,
          error: null,
          active: 'default',
          userDataDir: dir,
          spaces: [
            {
              name: 'default',
              partition: 'persist:dsh-view',
              storagePath: join(dir, 'Partitions', 'dsh-view'),
              url: '',
              visible: true,
              webContentsId: 1,
              active: true,
              isDefault: true,
              cookieCount: 0,
            },
          ],
        }),
      )
      const lonely = new SpaceManager({ dir, timeoutMs: 400, maxElements: 200, maxChars: 20_000 })
      const started = Date.now()
      const failure = await lonely.command('create', 'task-9').then(
        () => 'resolved',
        (error: Error) => error.message,
      )
      console.log('RAW no-shell failure after ' + (Date.now() - started) + 'ms: ' + JSON.stringify(failure))
      expect(failure).toMatch(/did not handle space request 5/)
      // 请求**真的写出去了**（不是"什么都没发生"）：它就摆在那里，等一个不存在的外壳。
      const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))
      console.log('RAW the request left behind: ' + JSON.stringify(request))
      expect(request).toEqual({ id: 5, active: 'task-9', spaces: ['default', 'task-9'] })
      // ……而"没有状态文件"是**另一条**不同的错误：两者不该长得一样。
      const nowhere = new SpaceManager({
        dir: join(dir, 'empty'),
        timeoutMs: 400,
        maxElements: 200,
        maxChars: 20_000,
      })
      await expect(nowhere.command('list')).rejects.toThrow(/no task-space state/)
    } finally {
      removeWhenFree(dir)
    }
  })
})

describe('T7 — 验收 1：能创建/使用/关闭；关闭后页面真的没了，存储被抹掉，目录下次启动才删', () => {
  let shell: ShellProcess
  let profile: string
  let site: TestSite
  let manager: SpaceManager
  /** 被关掉的那个空间的 partition；"重启后目录真的不在了"要用它。 */
  let closedPartition: string | undefined
  let closedTargetId: string | undefined

  beforeAll(async () => {
    site = await startSite()
    profile = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-spaces-'))
    shell = await startShell([], { userDataDir: profile })
    manager = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
  }, 120_000)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (site !== undefined) await site.close()
    // 不裸 rmSync：刚被停掉的外壳，它的档案句柄可能还没放手，一次 EPERM 就会让
    // "15 个用例全过、整个文件报红"重演（tests/shell-harness.ts 的 removeWhenFree）。
    if (profile !== undefined) removeWhenFree(profile)
  })

  it('创建：真的多出一块视图，它有自己的 partition、自己的目标，而且能被单独领养', async () => {
    const created = await manager.command('create', 'task-1')
    const state = readState(shell)
    const record = spaceOf(state, 'task-1')
    console.log('RAW after create: ' + JSON.stringify({ record, state: { active: state.active, requestId: state.requestId } }))
    expect(record).toBeDefined()
    expect(state.active).toBe('task-1')
    // partition 是外壳的意图，storagePath 是读回来的事实：两者必须对得上。
    expect(record?.partition).toBe('persist:dsh-view-space-task-1')
    expect(record?.storagePath).toBe(shellSpaces.spaceStoragePath(profile, 'task-1'))
    expect(record?.persistent).toBe(true)
    // 默认空间一个字没动：还是 T6 那个 partition、那个目录。
    const fallback = spaceOf(state, 'default')
    expect(fallback?.partition).toBe('persist:dsh-view')
    expect(fallback?.storagePath).toBe(spaceOf(readState(shell), 'default')?.storagePath)
    expect(fallback?.storagePath).not.toBe(record?.storagePath)

    // 独立读回之一：直接问 CDP 端点，这个 targetId 是不是一个真的 page 目标。
    const targets = await pageTargets(shell.handshake.cdpUrl)
    console.log('RAW page targets after create: ' + JSON.stringify(targets))
    expect(targets.some((target) => target.id === record?.targetId)).toBe(true)
    // 独立读回之二：真按这个 targetId 领养一次，读它自己的标题。
    const title = await withSpacePage(shell, 'task-1', (page) => page.title())
    expect(title).toBe('view-page')
    // 新空间**落在默认空间当前所在的地方**：那正是"继承登录态"有意义的那个页。
    expect(record?.url).toBe(spaceOf(state, 'default')?.url)
    expect(created.space?.targetId).toBe(record?.targetId)
  })

  it('使用：切换空间换掉的是填那一格矩形的那块视图，而且只有一个空间是当前的', async () => {
    // 让面板真的报一个矩形：这样"哪一块视图显示着"才是能读回来的事实，而不是推断。
    await reportPanelRect(shell)
    const before = readState(shell)
    console.log('RAW visible before switching back: ' + JSON.stringify(before.spaces.map((space) => [space.name, space.visible])))

    await manager.command('use', 'default')
    const after = readState(shell)
    console.log('RAW after use default: ' + JSON.stringify(after.spaces.map((space) => [space.name, space.visible, space.active])))
    expect(after.active).toBe('default')
    // 只有当前空间那一块是显示的，另一块**保留**但隐藏——那正是"登录互不影响"能成立的原因。
    expect(after.spaces.filter((space) => space.visible).map((space) => space.name)).toEqual(['default'])
    expect(spaceOf(after, 'task-1')?.visible).toBe(false)
    // 而且它的页面还在（隐藏不是释放）。
    expect(spaceOf(after, 'task-1')?.url).not.toBe('')
    const placement = shell.latestPlacement()
    console.log('RAW placement after switching: ' + JSON.stringify(placement))
    expect(placement?.space).toBe('default')

    await manager.command('use', 'task-1')
    const back = readState(shell)
    expect(back.spaces.filter((space) => space.visible).map((space) => space.name)).toEqual(['task-1'])
    expect(shell.latestPlacement()?.space).toBe('task-1')
  })

  it('关闭：页面从端点消失、按 targetId 再也领养不到、旧登录态被抹掉、目录仍在（如实）', async () => {
    // 先在这个空间里留下一个只属于它的登录态。
    const signedIn = await withSpacePage(shell, 'task-1', (page) => signInWithCookie(page, `${site.origin}/cookie-site`, 'secret'))
    console.log('RAW signed in inside task-1: ' + JSON.stringify({ signedIn }))
    expect(signedIn).toBe('signed in as secret')
    // 独立读回：它的 cookie 罐里真的有这条 cookie（浏览器侧读的，不是插件说的）。
    const cookies = await cookiesInSpace(shell, 'task-1', `${site.origin}/cookie-site`)
    console.log('RAW cookies in task-1: ' + JSON.stringify(cookies))
    expect(cookies.some((cookie) => cookie.name === 'token' && cookie.value === 'secret')).toBe(true)

    const record = spaceOf(readState(shell), 'task-1')
    closedTargetId = record?.targetId
    closedPartition = record?.partition
    console.log('RAW target about to be closed: ' + JSON.stringify({ targetId: closedTargetId, partition: closedPartition }))

    await manager.command('close', 'task-1')
    const after = readState(shell)
    console.log('RAW after close: ' + JSON.stringify({ active: after.active, spaces: after.spaces.map((space) => space.name) }))
    expect(spaceOf(after, 'task-1')).toBeUndefined()
    // 当前空间不能指向一个已经不存在的空间。
    expect(after.active).toBe('default')

    // 独立读回：直接问 CDP 端点，那个目标还在不在。
    const targets = await pageTargets(shell.handshake.cdpUrl)
    console.log('RAW page targets after close: ' + JSON.stringify(targets))
    expect(targets.some((target) => target.id === closedTargetId)).toBe(false)
    // ……并且真的领养不到（不是因为"端点还没刷新"）。
    await expect(pageForTarget(shell.handshake.cdpUrl, closedTargetId ?? '')).rejects.toThrow()

    // 存储**数据**被抹掉：重建同名空间，它继承的是默认档案，而**不是**刚关掉的那个人的登录态。
    const recreated = await manager.command('create', 'task-1')
    const seen = await withSpacePage(shell, 'task-1', (page) => whoIs(page, `${site.origin}/cookie-site`))
    console.log('RAW recreated task-1 sees: ' + JSON.stringify({ seen, inherited: recreated.space?.inherited }))
    expect(seen).toBe('signed out')

    // 目录这一半**如实**：进程活着时删不掉，所以它还在磁盘上，只是被记进了待删清单。
    const dir = shellSpaces.spaceStoragePath(profile, 'task-1')
    const pending = JSON.parse(readFileSync(shell.handshake.spaceChannel.pendingDeletionFile, 'utf8')) as string[]
    console.log('RAW directory after close: ' + JSON.stringify({ dir, exists: existsSync(dir), pending }))
    expect(existsSync(dir)).toBe(true)
    expect(pending).toContain('persist:dsh-view-space-task-1')
    // ……而默认空间的 partition 永不进待删清单。
    expect(pending).not.toContain('persist:dsh-view')

    // 收拾干净：把重建的这个也关掉，让"重启后目录不在了"这条只关于它。
    await manager.command('close', 'task-1')
  })

  it('重启同一个档案目录：被记下的目录真的被删掉，默认空间的档案原封不动', async () => {
    expect(closedPartition).toBe('persist:dsh-view-space-task-1')
    // 路径按**空间名**算（`spaceStoragePath` 收的是名字，不是 partition 串）。
    const dir = shellSpaces.spaceStoragePath(profile, 'task-1')
    const defaultDir = shellSpaces.spaceStoragePath(profile, 'default')
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(defaultDir)).toBe(true)

    // 关窗口（用户真正走的那条路），再用**同一个档案目录**重启。
    await shell.stop({ graceful: true })
    expect(shell.alive()).toBe(false)

    const restarted = await startShell([], { userDataDir: profile })
    try {
      const purges = restarted.stdout().split('\n').filter((line) => line.includes('SPACE_PURGE'))
      console.log('RAW purge lines: ' + JSON.stringify(purges))
      console.log('RAW after restart: ' + JSON.stringify({ dirExists: existsSync(dir), defaultExists: existsSync(defaultDir) }))
      expect(existsSync(dir)).toBe(false)
      // 默认空间（T6 那一格）的档案一个字节都不该被这次清理碰到。
      expect(existsSync(defaultDir)).toBe(true)
      expect(spaceOf(readState(restarted), 'default')?.partition).toBe('persist:dsh-view')
      // 待删清单也被清空了：这件事只做一次。
      const pending = JSON.parse(readFileSync(restarted.handshake.spaceChannel.pendingDeletionFile, 'utf8')) as string[]
      expect(pending).toEqual([])
    } finally {
      await restarted.stop()
    }
  }, 120_000)
})

describe('T7 — 验收 2/3/4：继承、同站互不影响、工具只作用于当前空间', () => {
  let shell: ShellProcess
  let site: TestSite
  let manager: SpaceManager

  beforeAll(async () => {
    site = await startSite()
    shell = await startShell()
    manager = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
  }, 120_000)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (site !== undefined) await site.close()
  })

  it('验收 3：新空间继承默认档案的登录态（cookie 全量；localStorage 是它落脚的那个 origin）', async () => {
    // 默认档案先登录：cookie 一处、localStorage 一处，然后停在 local-site 上。
    const defaultWho = await withSpacePage(shell, 'default', async (page) => {
      const cookie = await signInWithCookie(page, `${site.origin}/cookie-site`, 'default-user')
      const local = await signInWithLocalStorage(page, `${site.origin}/local-site`, 'default-local')
      return { cookie, local }
    })
    console.log('RAW default space after signing in: ' + JSON.stringify(defaultWho))
    expect(defaultWho).toEqual({ cookie: 'signed in as default-user', local: 'signed in as default-local' })

    // 新空间：它从默认档案继承，并且**落在默认空间当前所在的 origin** 上。
    const created = await manager.command('create', 'inh-1')
    console.log('RAW inheritance: ' + JSON.stringify(created.space?.inherited))
    expect(created.space?.inherited?.sourceUrl).toBe(`${site.origin}/local-site`)
    expect(created.space?.inherited?.localStorageOrigin).toBe(site.origin)
    expect((created.space?.inherited?.cookiesInSpace ?? 0) > 0).toBe(true)

    const seen = await withSpacePage(shell, 'inh-1', async (page) => ({
      cookie: await whoIs(page, `${site.origin}/cookie-site`),
      local: await whoIs(page, `${site.origin}/local-site`),
      origin: await page.evaluate(() => location.origin),
    }))
    console.log('RAW the new space sees: ' + JSON.stringify(seen))
    // 两半都读回：cookie 是全局复制的，localStorage 是"它落脚的那个 origin"复制过来的。
    expect(seen.cookie).toBe('signed in as default-user')
    expect(seen.local).toBe('signed in as default-local')
    expect(seen.origin).toBe(site.origin)
    // 默认空间的原件也还在（继承是复制，不是搬家）。
    const stillThere = await withSpacePage(shell, 'default', (page) => whoIs(page, `${site.origin}/cookie-site`))
    expect(stillThere).toBe('signed in as default-user')
  })

  it('验收 3 的边界：默认档案里**另一个 origin** 的 localStorage 不会被继承（cookie 会）', async () => {
    // 默认档案在另一个 origin 上也有一份登录态。cookie 是按域存的，localStorage 是按 origin 存的。
    const otherWho = await withSpacePage(shell, 'default', async (page) => {
      const local = await signInWithLocalStorage(page, `${site.altOrigin}/local-site`, 'default-other')
      const cookie = await signInWithCookie(page, `${site.altOrigin}/cookie-site`, 'default-other-cookie')
      return { local, cookie }
    })
    console.log('RAW default space on the other origin: ' + JSON.stringify({ altOrigin: site.altOrigin, ...otherWho }))
    expect(otherWho).toEqual({ local: 'signed in as default-other', cookie: 'signed in as default-other-cookie' })
    // 两个地址确实是两个 origin、两个 cookie 域（否则下面那条"跨 origin 也继承"什么也证明不了）。
    const domains = await cookiesInSpace(shell, 'default', `${site.altOrigin}/cookie-site`)
    console.log('RAW default cookie domains: ' + JSON.stringify({ domains, altOrigin: site.altOrigin }))
    expect(new URL(site.altOrigin).hostname).not.toBe(new URL(site.origin).hostname)
    // 让它停在第一个 origin 上：新空间会落到这里，localStorage 的复制只覆盖"它落脚的那个 origin"。
    const landed = await withSpacePage(shell, 'default', (page) => whoIs(page, `${site.origin}/local-site`))
    expect(landed).toBe('signed in as default-local')

    await manager.command('create', 'inh-2')
    const seen = await withSpacePage(shell, 'inh-2', async (page) => ({
      otherLocal: await whoIs(page, `${site.altOrigin}/local-site`),
      otherCookie: await whoIs(page, `${site.altOrigin}/cookie-site`),
      thisLocal: await whoIs(page, `${site.origin}/local-site`),
    }))
    console.log('RAW the new space on both origins: ' + JSON.stringify(seen))
    // 这一条就是那张能力边界表：另一个域的 cookie 也继承得到（cookie 是按 domain 全量复制的）……
    expect(seen.otherCookie).toBe('signed in as default-other-cookie')
    // ……而另一个 origin 的 localStorage 继承不到（没有 API 能枚举"哪些 origin 有 localStorage"，
    // 而且给一个本 partition 没有 frame 的 origin 写 localStorage 会被 CDP 直接拒绝）。
    expect(seen.otherLocal).toBe('signed out')
    // 它落脚的那个 origin 上的 localStorage 是继承到了的。
    expect(seen.thisLocal).toBe('signed in as default-local')
  })

  it('验收 2：两个空间在同一站点各自登录，互相看不见（先证明同源）', async () => {
    await manager.command('create', 'iso-a')
    await manager.command('create', 'iso-b')
    // 两个空间**明确**站在同一个地址上，这样"同源"是被摆出来的，不是碰巧的。
    const landing = await withSpacePage(shell, 'iso-a', (page) => whoIs(page, `${site.origin}/cookie-site`))
    const landingB = await withSpacePage(shell, 'iso-b', (page) => whoIs(page, `${site.origin}/cookie-site`))
    console.log('RAW where the two spaces stand: ' + JSON.stringify({ landing, landingB }))

    const signedIn = await withSpacePage(shell, 'iso-a', (page) => signInWithCookie(page, `${site.origin}/cookie-site`, 'alpha'))
    expect(signedIn).toBe('signed in as alpha')

    // 先证明同源：否则"看不见"能被 origin 不同解释。
    const origins = await withSpacePage(shell, 'iso-b', (page) => page.evaluate(() => location.origin))
    console.log('RAW origins: ' + JSON.stringify({ a: site.origin, b: origins }))
    expect(origins).toBe(site.origin)

    const bSees = await withSpacePage(shell, 'iso-b', (page) => whoIs(page, `${site.origin}/cookie-site`))
    console.log('RAW what iso-b sees while iso-a is alpha: ' + JSON.stringify(bSees))
    // 同源、却看不见 alpha：那不是一个罐子。
    expect(bSees).not.toBe('signed in as alpha')

    const betaSeen = await withSpacePage(shell, 'iso-b', (page) => signInWithCookie(page, `${site.origin}/cookie-site`, 'beta'))
    expect(betaSeen).toBe('signed in as beta')

    // 两个空间各自还在自己的那个人身上，谁也没把谁挤掉；默认档案也没被碰到。
    const readBack = {
      a: await withSpacePage(shell, 'iso-a', (page) => whoIs(page, `${site.origin}/cookie-site`)),
      b: await withSpacePage(shell, 'iso-b', (page) => whoIs(page, `${site.origin}/cookie-site`)),
      fallback: await withSpacePage(shell, 'default', (page) => whoIs(page, `${site.origin}/cookie-site`)),
    }
    console.log('RAW three spaces, same site, after two logins: ' + JSON.stringify(readBack))
    expect(readBack.a).toBe('signed in as alpha')
    expect(readBack.b).toBe('signed in as beta')
    expect(readBack.fallback).toBe('signed in as default-user')

    // 语言上也对得上：三个空间各在自己的 partition 上，罐子也确实各是各的。
    const state = readState(shell)
    const paths = ['default', 'iso-a', 'iso-b'].map((name) => spaceOf(state, name)?.storagePath)
    const jars = {
      a: await cookiesInSpace(shell, 'iso-a', `${site.origin}/cookie-site`),
      b: await cookiesInSpace(shell, 'iso-b', `${site.origin}/cookie-site`),
    }
    console.log('RAW storage paths and cookie jars: ' + JSON.stringify({ paths, jars }))
    expect(new Set(paths).size).toBe(3)
    expect(jars.a.some((cookie) => cookie.value === 'alpha')).toBe(true)
    expect(jars.b.some((cookie) => cookie.value === 'beta')).toBe(true)
    expect(jars.a.some((cookie) => cookie.value === 'beta')).toBe(false)
    expect(jars.b.some((cookie) => cookie.value === 'alpha')).toBe(false)
  })

  it('验收 4：所有工具只作用于当前空间（另一个空间一步都没动）', async () => {
    const cdpUrl = shell.handshake.cdpUrl
    const tools = desktopViewTools(() => manager.adopt(cdpUrl), { spaces: manager })
    const navigate = tools.find((tool) => tool.name === 'browser_navigate')
    const evaluate = tools.find((tool) => tool.name === 'browser_evaluate')
    const space = tools.find((tool) => tool.name === 'browser_space')
    const names = tools.map((tool) => tool.name)
    console.log('RAW registered tools: ' + JSON.stringify(names))
    expect(navigate).toBeDefined()
    expect(evaluate).toBeDefined()
    expect(space).toBeDefined()

    // 两个空间都摆到一个已知地址上：否则"另一个没动"可能只是因为它本来就在那儿。
    await withSpacePage(shell, 'iso-a', (page) => page.goto(`${site.origin}/cookie-site`))
    await withSpacePage(shell, 'iso-b', (page) => page.goto(`${site.origin}/cookie-site`))

    await manager.command('use', 'iso-a')
    const moved = await navigate?.execute({ url: `${site.origin}/other` }, IGNORED_EXEC)
    const readByTool = await evaluate?.execute({ expression: 'location.href' }, IGNORED_EXEC)
    // 另一个空间用**绕开插件**的那条连接读回来：它必须一步没动。
    const untouched = await withSpacePage(shell, 'iso-b', (page) => page.url())
    console.log('RAW scoped navigation: ' + JSON.stringify({ moved, readByTool, untouched }))
    expect(readByTool).toBe(`${site.origin}/other`)
    expect(untouched).toBe(`${site.origin}/cookie-site`)

    // 换一个当前空间，同一个工具调用落在另一块视图上：作用域是"当前空间"，不是"那一个会话"。
    const switched = await space?.execute({ action: 'use', name: 'iso-b' }, IGNORED_EXEC)
    console.log('RAW switch through the tool: ' + JSON.stringify(switched?.message))
    await navigate?.execute({ url: `${site.origin}/local-site` }, IGNORED_EXEC)
    const readBack = {
      b: await withSpacePage(shell, 'iso-b', (page) => page.url()),
      a: await withSpacePage(shell, 'iso-a', (page) => page.url()),
    }
    console.log('RAW after switching the space: ' + JSON.stringify(readBack))
    expect(readBack.b).toBe(`${site.origin}/local-site`)
    // A 停在它自己上一次被驱动到的地方：B 的动作一步也没落在它身上。
    expect(readBack.a).toBe(`${site.origin}/other`)

    // 工具报出来的空间表也是外壳读回的那一份。
    const table = await space?.execute({ action: 'list' }, IGNORED_EXEC)
    const published = shellRecord<{ active: string; spaces: Array<{ name: string }> }>(shell.stdout(), 'SPACES')
    console.log('RAW tool table vs published state: ' + JSON.stringify({ tool: table?.active, published: published?.active }))
    expect(table?.active).toBe('iso-b')
    expect(published?.active).toBe('iso-b')
    expect(table?.spaces.map((entry) => entry.name).sort()).toEqual(published?.spaces.map((entry) => entry.name).sort())
  })
})

/**
 * T7 之后的第二种偶发红是"外壳发布的表里目标不见了"。这一组**确定性地**把那件事造出来。
 *
 * `--fault-cdp-list` 是外壳上的一条**测试缝**：它让处理空间请求期间的前 n 次 `GET /json/list`
 * 失败，也就是回环端点那一刻读不回来的样子。为什么要注入：这条路径原来写着
 * `cdp.listTargets(...).catch(() => [])` —— 一次瞬时失败被变成了"这张表里的目标全没了"，
 * 于是外壳发布一张缺 `targetId` 的表：读它的人会炸（`withSpacePage` 抛"没有 target id"），
 * 插件侧则去领养一个没有目标的会话。成因、探针与原始输出见
 * `docs/research/space-table-target-id-gap.md`。
 *
 * 两条用例各钉住修复的一半，而且都先断言**故障真的发生过**（外壳每注入一次就打一行
 * `DSH_SHELL CDP_LIST_FAULT`）——否则"绿"可能只是这条用例什么也没验到：
 *
 *  1. 故障只发生一次 → 外壳**等到**目标可解析才发布：新空间拿到的是真的、能被领养的 id；
 *  2. 故障一直发生 → 已经知道的 id **不许被抹掉**（`targetIdSource: 'remembered'`，而且那个 id
 *     仍然真的指向那块视图）；确实没有的那个**显式写明**（`unavailable` + 原因），插件据此
 *     点名那个空间说"还没准备好"，而不是去领养一个没有目标的会话。
 *
 * 反证：把修复回退掉（`describeSpaces` 直接发布 `targetIdForWebContents` 的结果、去掉
 * `awaitCreatedTargets`），这两条都变红 —— 原始输出在同一份文档里。
 */
describe('T7 — 端点那一刻读不回来：发布的表不许比它知道的更少（故障注入，确定性）', () => {
  /**
   * 这个组里**每一块**起过的外壳。
   *
   * 一条用例一块（两条用例的注入次数不同），而 `shell` 只有一个变量：第二条一赋值，
   * 第一条那块外壳就没人停了 —— 配置文件留在 %TEMP% 里（实测：每跑一次套件漏一个 156 个文件的
   * 档案目录，而且漏得**不声不响**，因为没人调用清理）。所以这里收的是**列表**。
   */
  const started: ShellProcess[] = []

  afterAll(async () => {
    for (const each of started) await each.stop()
  })

  it('故障只发生一次：外壳等到目标可解析才发布，新空间拿到的是真的、能被领养的 id', async () => {
    const shell = await startShell(['--fault-cdp-list', '1'])
    started.push(shell)
    const manager = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
    const created = await manager.command('create', 'flaky-once')
    const record = spaceOf(readState(shell), 'flaky-once')
    console.log('RAW record after the injected fault: ' + JSON.stringify({ record, wait: shellRecord(shell.stdout(), 'SPACE_TARGET_WAIT') }))
    // 故障**真的发生了**：否则这条用例什么也没验到。
    expect(shellRecord<{ injected: boolean }>(shell.stdout(), 'CDP_LIST_FAULT')?.injected).toBe(true)
    // 新空间的那次列举是"等它可解析再发布"救回来的，而不是运气。
    expect(shellRecord<{ resolved: string[] }>(shell.stdout(), 'SPACE_TARGET_WAIT')?.resolved).toContain('flaky-once')
    // 发布出去的是**真的** id：端点上有这个目标，而且真能按它领养到那块视图。
    expect(record?.targetIdSource).toBe('resolved')
    expect(record?.targetId).toBeDefined()
    const targets = await pageTargets(shell.handshake.cdpUrl)
    expect(targets.some((target) => target.id === record?.targetId)).toBe(true)
    expect(await withSpacePage(shell, 'flaky-once', (page) => page.title())).toBe('view-page')
    // 插件读到的也是同一个 id（解析没有把它丢掉）。
    expect(created.space?.targetId).toBe(record?.targetId)
  }, 120_000)

  it('故障一直发生：已知的 id 不许被抹掉，确实没有的要显式说明，插件点名那个空间报错', async () => {
    const shell = await startShell(['--fault-cdp-list', '1000'])
    started.push(shell)
    const manager = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
    // 开局那张表是**真的**：故障只在处理空间请求期间生效（否则外壳压根起不来）。
    const atStartup = shell.handshake.spaces.find((space) => space.name === 'default')
    console.log('RAW the default space at startup: ' + JSON.stringify(atStartup))
    expect(atStartup?.targetId).toBeDefined()
    expect(atStartup?.targetIdSource).toBe('resolved')

    await manager.command('create', 'flaky-always')

    const state = readState(shell)
    const fallback = spaceOf(state, 'default')
    const fresh = spaceOf(state, 'flaky-always')
    console.log(
      'RAW the table published while the endpoint could not be listed: ' +
        JSON.stringify({ default: fallback, 'flaky-always': fresh, faults: shell.stdout().split('\n').filter((line) => line.includes('CDP_LIST_FAULT')).length }),
    )
    // 1) 它**知道的**没被抹掉：默认空间还是开局那个 id……
    expect(fallback?.targetId).toBe(atStartup?.targetId)
    expect(fallback?.targetIdSource).toBe('remembered')
    expect(fallback?.targetIdReason).toContain('could not be listed')
    // ……而且那个 id 现在**真的**还指向那块视图（记住不等于编一个出来）。
    const opened = await pageForTarget(shell.handshake.cdpUrl, fallback?.targetId ?? '')
    try {
      expect(await opened.page.title()).toBe('view-page')
    } finally {
      await opened.browser.close()
    }
    // 2) 确实没有的那个**显式写明**，不是静默省略字段。
    expect(fresh?.targetId).toBeUndefined()
    expect(fresh?.targetIdSource).toBe('unavailable')
    expect(fresh?.targetIdReason).toContain('could not be listed')
    // 3) 插件侧不再"去领养一个没有目标的会话"：报错点名那个空间，并带上外壳给的原因。
    const refusal = await manager.adopt(shell.handshake.cdpUrl).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    console.log('RAW the plugin refused to adopt: ' + JSON.stringify(refusal))
    expect(refusal).toContain('flaky-always')
    expect(refusal).toContain('could not be listed')
  }, 120_000)
})

/**
 * 票 #15 —— "一个空间坏了，别的空间连同默认空间都得还能用"。
 *
 * ## 先说清楚这条路径**真的是什么**（实测，别信推断）
 *
 * 票面假设的是"`describeSpaces` 走 `destroyed: true` 分支，发布一条缺 `storagePath`/`url`
 * 的记录"。探针量下来**不是那样**（原始输出见 `docs/research/destroyed-space-record.md`）：
 *
 *  1. `webContents.isDestroyed()` **从没为真过**——渲染进程崩溃、`contents.close()`、页面自己
 *     `window.close()` 三条途径都量过。一块被销毁的视图，`view.webContents` 直接变成
 *     **undefined**，于是那个"读一下再看它销毁没销毁"的写法在这里是**抛**
 *     （`TypeError: Cannot read properties of undefined (reading 'isDestroyed')`），
 *     而不是走 `destroyed: true` 分支；
 *  2. 抛了以后 `publishSpaces` 整份不写、`requestId` **永不前进**：插件一直等到超时，
 *     报出来的错是"外壳没在规定时间内处理请求"，跟真实原因（某个空间的视图被销毁了）
 *     毫无关系——正是本票要消灭的那类错误。
 *
 * 所以这一组钉住两件事，而且第 1 条**先断言故障真的发生了**（`Page.close` 事件真的到了、
 * 那个空间的 `targetId` 之后真的没了），否则"绿"可能只是这条用例什么也没验到。
 */
describe('票 #15 — 一个空间的视图被销毁之后，外壳照常发布表，默认空间照常可用', () => {
  /**
   * 这个组里起过的每一块外壳都收进列表：一条用例一块，谁也不能漏停。
   * （漏停的后果实测过：每跑一次套件在 %TEMP% 里留一个 156 个文件的档案目录，而且不声不响。）
   */
  const started: ShellProcess[] = []

  afterAll(async () => {
    for (const each of started) await each.stop()
  })

  it('一个空间自己关掉自己的视图：state.json 照常更新、那条记录字段齐全、默认空间仍能领养', async () => {
    const shell = await startShell()
    started.push(shell)
    const manager = new SpaceManager({
      dir: shell.handshake.spaceChannel.dir,
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
    })
    const stateFile = shell.handshake.spaceChannel.stateFile

    await manager.command('create', 'doomed')
    const doomed = spaceOf(readState(shell), 'doomed')
    console.log('RAW doomed before it closes itself: ' + JSON.stringify({ targetId: doomed?.targetId, url: doomed?.url }))
    expect(doomed?.targetId).toBeDefined()

    // 故障注入用**真的机制**：在那块视图里执行 `window.close()`。它的 webContents 会被真的销毁，
    // 而外壳的表里那条 entry 还在——只有 `closeSpace` 会把 entry 摘掉，这条路上没人调用它。
    const opened = await pageForTarget(shell.handshake.cdpUrl, doomed?.targetId ?? '')
    let closed = 'no close event'
    try {
      const closing = opened.page.waitForEvent('close', { timeout: 15_000 }).then(
        () => 'page closed',
        (error: unknown) => `no close event: ${error instanceof Error ? error.message : String(error)}`,
      )
      await opened.page.evaluate(() => window.close())
      closed = await closing
    } finally {
      await opened.browser.close().catch(() => undefined)
    }
    console.log('RAW the doomed view closed itself: ' + JSON.stringify({ closed }))
    // 故障**真的发生了**：不是"我们以为它关掉了"。
    expect(closed).toBe('page closed')
    // ……而且那个视图真的没了：端点上再也找不到它的目标。
    const targets = await pageTargets(shell.handshake.cdpUrl)
    expect(targets.some((target) => target.id === doomed?.targetId)).toBe(false)

    // 触发一次发布（这就是崩掉的那一行所在的路径：处理空间请求 → describeSpaces → publishSpaces）。
    await manager.command('use', 'default')

    // 1) 表照常发布：state.json 真的被改写了、requestId 前进到 2。
    //    **反证点**：修复前这一行写着 `TypeError: Cannot read properties of undefined (reading 'isDestroyed')`
    //    (shell/main.js 的 describeSpaces)，state.json 停在 requestId=1，这条请求永远等不到答案。
    const published = readState(shell)
    console.log('RAW published after the view was gone: ' + JSON.stringify({ requestId: published.requestId, spaces: published.spaces }))
    expect(published.requestId).toBe(2)
    expect(published.spaces.map((space) => space.name).sort()).toEqual(['default', 'doomed'])
    // 2) 那条记录**字段齐全**：视图没了不等于这个空间的档案位置与地址没了。
    const after = spaceOf(published, 'doomed')
    expect(after?.destroyed).toBe(true)
    expect(after?.storagePath).toBe(shellSpaces.spaceStoragePath(shell.handshake.userDataDir, 'doomed'))
    expect(after?.url).toBe(doomed?.url)
    expect(after?.partition).toBe('persist:dsh-view-space-doomed')
    expect(after?.webContentsId).toBe(-1)
    expect(after?.targetIdSource).toBe('unavailable')
    expect(after?.targetIdReason).toContain('destroyed')
    // 3) **默认空间一点没受影响**：插件侧那份 state 还能读，而且真的能领养到会话。
    const state = manager.readState()
    console.log('RAW what the plugin read back: ' + JSON.stringify({ spaces: state?.spaces.map((space) => space.name), skipped: state?.skipped }))
    expect(state?.spaces.map((space) => space.name).sort()).toEqual(['default', 'doomed'])
    expect(state?.skipped).toEqual([])
    const session = await manager.adopt(shell.handshake.cdpUrl)
    try {
      // 领养到的确实是默认空间那块视图：读它自己的标题。
      expect(await session.title()).toBe('view-page')
    } finally {
      await session.close()
    }
    // 4) 外壳还把这件事**显式写在 stdout 上**（诊断用），而不是静默地少发一条。
    const table = shellRecord<{ spaces: Array<{ name: string; destroyed?: boolean }> }>(shell.stdout(), 'SPACES')
    expect(table?.spaces.find((space) => space.name === 'doomed')?.destroyed).toBe(true)
  }, 180_000)

  /**
   * 插件侧那一条：**一条读不动的记录不许让整份状态不可读**。
   *
   * 输入是**外壳真会发布的那种形状**的 state.json（上面那条用例已经证明了外壳现在会补全字段；
   * 这里用的是"旧的/坏的外壳"会写出来的形状——`destroyed: true` 而没有 `storagePath`/`url`，
   * 也就是票面点名的那条记录）。整段不起外壳：这是纯解析 + 工具输出的读回。
   */
  it('一条 destroyed 记录缺 storagePath/url：跳过它并说明原因，默认空间照常可用（纯解析 + 真工具）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-skipped-'))
    try {
      const raw = JSON.stringify({
        protocol: 1,
        requestId: 9,
        error: null,
        active: 'default',
        userDataDir: dir,
        cause: 'request',
        spaces: [
          {
            name: 'default',
            partition: 'persist:dsh-view',
            storagePath: join(dir, 'Partitions', 'dsh-view'),
            persistent: true,
            targetId: 'DEFAULT-TARGET',
            targetIdSource: 'resolved',
            url: 'http://127.0.0.1:1/view',
            visible: true,
            webContentsId: 2,
            active: true,
            isDefault: true,
            cookieCount: 3,
          },
          // 票面那条记录，逐字：视图已销毁的空间，**没有** storagePath、**没有** url。
          { name: 'ghost', partition: 'persist:dsh-view-space-ghost', destroyed: true, targetIdSource: 'unavailable', targetIdReason: 'this space\'s view has been destroyed, so it has no target any more' },
        ],
      })
      writeFileSync(join(dir, 'state.json'), raw)
      const manager = new SpaceManager({ dir, timeoutMs: 400, maxElements: 200, maxChars: 20_000 })
      const state = manager.readState()
      console.log('RAW parsed a state with one unusable record: ' + JSON.stringify({ spaces: state?.spaces.map((space) => space.name), skipped: state?.skipped }))
      // 1) **整份状态可读**：默认空间还在，坏的那条被跳过并带着原因。
      expect(state).toBeDefined()
      expect(state?.spaces.map((space) => space.name)).toEqual(['default'])
      expect(state?.skipped).toHaveLength(1)
      expect(state?.skipped[0]?.name).toBe('ghost')
      expect(state?.skipped[0]?.index).toBe(1)
      expect(state?.skipped[0]?.reason).toContain('storagePath, url')
      expect(state?.skipped[0]?.reason).toContain('destroyed')
      // 2) 给模型看的表里也说了这件事（不是静默少一条）。
      const table = describeSpaceTable(state as SpaceState)
      console.log('RAW the table the model would read:\n' + table)
      expect(table).toContain('Active space: default')
      expect(table).toContain('ghost')
      expect(table).toContain('NOT USABLE')
      expect(table).toContain('storagePath, url')
      // 3) **真的是工具的输出**，不只是这个函数：`browser_space` 也带着 skipped。
      const tools = desktopViewTools(() => Promise.reject(new Error('adopt is not used by "list"')), { spaces: manager })
      const space = tools.find((tool) => tool.name === 'browser_space')
      const value = await space?.execute({ action: 'list' }, IGNORED_EXEC)
      console.log('RAW browser_space output with one unusable record: ' + JSON.stringify(value))
      expect(value?.spaces.map((entry) => entry.name)).toEqual(['default'])
      expect(value?.skipped).toHaveLength(1)
      expect(value?.skipped[0]?.reason).toContain('storagePath, url')
      expect(value?.message).toContain('NOT USABLE')
      // 4) 当前空间正好是**被跳过的那一条**时，报错必须点名它并带上原因，
      //    而不是笼统地说"外壳没有描述当前空间"——那句话跟真实原因毫无关系。
      const adoptDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-lost-'))
      try {
        writeFileSync(join(adoptDir, 'state.json'), JSON.stringify({ ...(JSON.parse(raw) as object), active: 'ghost' }))
        const lonely = new SpaceManager({ dir: adoptDir, timeoutMs: 400, maxElements: 200, maxChars: 20_000 })
        const refusal = await lonely.adopt('http://127.0.0.1:1').then(
          () => 'resolved',
          (error: Error) => error.message,
        )
        console.log('RAW adopting a space whose record was skipped: ' + JSON.stringify(refusal))
        expect(refusal).toContain('"ghost"')
        expect(refusal).toContain('not usable')
        expect(refusal).toContain('storagePath, url')
      } finally {
        removeWhenFree(adoptDir)
      }
    } finally {
      removeWhenFree(dir)
    }
  })
})
