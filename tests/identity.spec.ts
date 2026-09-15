import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  pageForTarget,
  removeWhenFree,
  shellRecord,
  startShell,
  type ProxyRecord,
  type ShellProcess,
} from './shell-harness.ts'

/**
 * T6 — 那一格的浏览器身份与登录态。
 *
 * 四条验收在这里各自有一处**独立读回**：
 *
 *  1. "登录一次、重启仍在" —— 写进那一格的持久 cookie 与 localStorage，关掉外壳（走用户真正
 *     走的那条路：关窗口），用**同一个档案目录**重启，再读回来。必须优雅关闭：实测写完立刻
 *     `taskkill /F` 连持久 cookie 都丢（Chromium 还没刷盘），那样测的是刷盘时机而不是持久性。
 *  2. "不退化为干净档案" —— 同上；并额外断言**会话** cookie 与 sessionStorage 不活、而它们
 *     的持久版本活着，这样"读回来的是新进程的新页面"与"档案真的留下了东西"是两件事。
 *  3. "外网继承系统代理、回环不走代理" —— 外壳把 `session.resolveProxy` 的读回发布成
 *     `DSH_SHELL PROXY`；测试给它一个显式代理（`--proxy`，指向一个真实的记录型代理），
 *     于是两半都有决定性证据：外网请求**真的到了**代理、回环页面**照常打开**、代理日志里
 *     **没有**回环请求。
 *  4. "不因自动化特征被限流/拒绝登录" —— 断言机制：UA 里没有 Electron 的产品标记、
 *     `navigator.webdriver` 为假、没有 `--enable-automation`。**不访问任何真实登录站点**：
 *     端到端"站点是否因此放行"由用户在本机实测，这里不声称测过。
 *
 * 身份的一部分是纯逻辑（{@link identity}），它不起外壳也能被读回，所以那些用例不碰 Electron。
 */

const require = createRequire(import.meta.url)

/** `shell/identity.js`：那一格的身份逻辑，纯函数，不 require('electron')。 */
const identity = require('../shell/identity.js') as {
  VIEW_PARTITION: string
  AUTOMATION_BLINK_FEATURE: string
  browserUserAgent: (userAgent: string, appName: string, appVersion: string) => string
}

/** 稳定站点页面的标题，用来证明回环导航真的完成了。 */
const STABLE_TITLE = 't6-identity-view'

/** 写进那一格的登录态模拟物：持久 cookie / 会话 cookie / localStorage / sessionStorage。 */
const WRITE_JS = `(() => {
  document.cookie = 't6persist=alpha; max-age=86400; path=/'
  document.cookie = 't6session=beta; path=/'
  localStorage.setItem('t6local', 'gamma')
  sessionStorage.setItem('t6ss', 'delta')
  return {
    cookie: document.cookie,
    local: localStorage.getItem('t6local'),
    session: sessionStorage.getItem('t6ss'),
  }
})()`

/** 重启后读回同样的四样东西。 */
const READ_JS = `({
  cookie: document.cookie,
  local: localStorage.getItem('t6local'),
  session: sessionStorage.getItem('t6ss'),
  origin: location.origin,
})`

/**
 * 一个跨两次外壳运行都保持同一个 origin 的站点。
 *
 * localStorage 是按 origin（**含端口**）存的，而外壳自带的 fixture 每次启动都换端口；
 * 想断言"localStorage 还在不在"，就必须让两次运行落在同一个 origin 上。
 * 这里用测试进程自己的服务器，端口在两次外壳运行之间不变。
 *
 * @returns 站点地址与关闭函数。
 */
async function startStableSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${STABLE_TITLE}</title></head>` +
        `<body><h1 id="heading">${STABLE_TITLE}</h1></body></html>`,
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * 一个真实的转发代理：它只记录到达它的请求，并一律回答 502。
 *
 * "外网走代理"与"回环不走代理"这两条，只有让流量真的经过一个会说话的东西才算证明；
 * `resolveProxy` 的读回说明的是决定，这里说明的是结果。
 *
 * @returns 端口、收到的请求行、关闭函数。
 */
async function startLoggingProxy(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(`${request.method ?? '?'} ${request.url ?? '?'}`)
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('t6 fixture proxy: this proxy only records what reaches it\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * 连上外壳的 CDP 端点，拿到这一格或 DSH 界面那一个页面，做完事再断开。
 *
 * @param shell - 正在跑的外壳。
 * @param which - `view` 是那一格，`window` 是外壳界面。
 * @param action - 拿到页面后要做的事。
 * @returns `action` 的返回值。
 */
async function withPage<T>(shell: ShellProcess, which: 'view' | 'window', action: (page: Page) => Promise<T>): Promise<T> {
  const targetId = which === 'view' ? shell.handshake.targetId : shell.handshake.windowTargetId
  if (targetId === undefined) throw new Error(`the shell published no ${which} target id`)
  const opened = await pageForTarget(shell.handshake.cdpUrl, targetId)
  try {
    return await action(opened.page)
  } finally {
    await opened.browser.close()
  }
}

describe('T6 — 身份里那点纯逻辑：UA 只删产品标记，不改写别的', () => {
  it('应用名被正式设置时，应用标记与 Electron 标记一起去掉', () => {
    const fallback =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'dsh-desktop-view/0.1.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36'
    const cleaned = identity.browserUserAgent(fallback, 'dsh-desktop-view', '0.1.0')
    console.log('RAW cleaned UA (named app): ' + JSON.stringify(cleaned))
    expect(cleaned).not.toContain('Electron/')
    expect(cleaned).not.toContain('dsh-desktop-view/')
    // 除了删掉那两段，别的形状一字不改：仍然是 Chrome 的 UA 形状。
    expect(cleaned).toMatch(
      /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/,
    )
  })

  it('应用名退化成 Electron 时（本仓库今天的实际形状）同样干净', () => {
    const fallback =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36'
    const cleaned = identity.browserUserAgent(fallback, 'Electron', '44.3.0')
    console.log('RAW cleaned UA (default app name): ' + JSON.stringify(cleaned))
    expect(cleaned).not.toContain('Electron/')
    expect(cleaned).toContain('Chrome/')
    expect(cleaned.endsWith('Safari/537.36')).toBe(true)
  })
})

describe('T6 — 真外壳里那一格的身份', () => {
  let shell: ShellProcess

  beforeAll(async () => {
    shell = await startShell()
  }, 120_000)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
  })

  it('UA 里没有 Electron 的产品标记，且页面里的值与外壳读回的一致', async () => {
    const measured = await withPage(shell, 'view', async (page) => {
      const userAgent = await page.evaluate(() => navigator.userAgent)
      const fullVersionList = await page.evaluate(async () => {
        const hints = navigator.userAgentData
        if (hints === undefined || typeof hints.getHighEntropyValues !== 'function') return []
        const high = await hints.getHighEntropyValues(['fullVersionList'])
        return high.fullVersionList ?? []
      })
      return { userAgent, fullVersionList }
    })
    console.log('RAW view identity: ' + JSON.stringify(measured))
    console.log('RAW shell readback: ' + JSON.stringify(shell.handshake.browserIdentity))
    expect(measured.userAgent).not.toContain('Electron/')
    // 页面里真正发出去的那个 UA，与外壳从 Electron 读回的那个是同一个。
    expect(measured.userAgent).toBe(shell.handshake.browserIdentity.userAgent)
    // 客户端提示是另一套东西：它本来就没有 Electron 品牌，这条把"本来就没有"钉住。
    expect(measured.fullVersionList.some((brand) => /electron/i.test(brand.brand))).toBe(false)
  })

  it('navigator.webdriver 为假：这一格与 DSH 界面各读一遍（影响面是量出来的）', async () => {
    const inView = await withPage(shell, 'view', (page) => page.evaluate(() => navigator.webdriver))
    const inWindow = await withPage(shell, 'window', (page) => page.evaluate(() => navigator.webdriver))
    console.log('RAW navigator.webdriver: ' + JSON.stringify({ view: inView, window: inWindow }))
    // 外壳加的 `--remote-debugging-port` 本来会让两个页面都报 true；关掉自动化标记后两个都是 false。
    expect(inView).toBe(false)
    expect(inWindow).toBe(false)
  })

  it('没有 --enable-automation：标记是被 disable-blink-features 关掉的', () => {
    console.log('RAW automation readback: ' + JSON.stringify(shell.handshake.browserIdentity))
    expect(shell.handshake.browserIdentity.enableAutomationSwitch).toBe(false)
    // 关掉的是哪一个 Blink 特性也要能读回来，否则"为什么现在是 false"就只剩推断。
    expect(shell.handshake.browserIdentity.disableBlinkFeatures).toBe(identity.AUTOMATION_BLINK_FEATURE)
  })

  it('这一格的档案与 DSH 界面的不是同一个：同源前提下互相看不见', async () => {
    const windowOrigin = await withPage(shell, 'window', (page) => page.evaluate(() => location.origin))
    const viewOrigin = await withPage(shell, 'view', (page) => page.evaluate(() => location.origin))
    console.log('RAW origins: ' + JSON.stringify({ windowOrigin, viewOrigin }))
    // 同源是这条断言的前提：同源却看不见 ⇒ 不是同一个罐子；而不是"origin 不同所以看不见"。
    expect(windowOrigin).toBe(viewOrigin)
    expect(viewOrigin).toBe(shell.handshake.fixtureOrigin)

    const written = await withPage(shell, 'window', (page) =>
      page.evaluate(`(() => {
        document.cookie = 't6fromwindow=from-window; max-age=600; path=/'
        localStorage.setItem('t6fromwindow', 'from-window')
        return { cookie: document.cookie, local: localStorage.getItem('t6fromwindow') }
      })()`),
    )
    const seenByView = await withPage(shell, 'view', (page) =>
      page.evaluate(`({
        cookie: document.cookie,
        local: localStorage.getItem('t6fromwindow'),
      })`),
    )
    console.log('RAW written in the window page: ' + JSON.stringify(written))
    console.log('RAW read in the view page: ' + JSON.stringify(seenByView))

    // 写进去了（否则下面的"看不见"什么都证明不了）……
    expect((written as { cookie: string }).cookie).toContain('t6fromwindow')
    expect((written as { local: string | null }).local).toBe('from-window')
    // ……而那一格读不到。
    expect((seenByView as { cookie: string }).cookie).not.toContain('t6fromwindow')
    expect((seenByView as { local: string | null }).local).toBeNull()
    // 档案落在它自己的目录里，不在外壳界面那份档案的根上。
    expect(shell.handshake.browserIdentity.storagePath).not.toBe(shell.handshake.userDataDir)
    expect(shell.handshake.browserIdentity.partition.startsWith('persist:')).toBe(true)
  })
})

describe('T6 — 关掉外壳再打开，登录态还在（同一个档案目录）', () => {
  let site: { origin: string; close: () => Promise<void> }
  let profile: string

  beforeAll(async () => {
    site = await startStableSite()
    profile = mkdtempSync(join(tmpdir(), 'dsh-desktop-shell-identity-'))
  }, 120_000)

  afterAll(async () => {
    if (site !== undefined) await site.close()
    // 一次 EPERM 就够让整个 spec 文件在**所有用例都过**的情况下报红，见 removeWhenFree 的注释。
    if (profile !== undefined) removeWhenFree(profile)
  })

  it('持久 cookie 与 localStorage 活过重启，会话 cookie 与 sessionStorage 不活', async () => {
    const first = await startShell([], { userDataDir: profile })
    const written = await withPage(first, 'view', async (page) => {
      await page.goto(`${site.origin}/view`)
      return await page.evaluate(WRITE_JS)
    })
    // 走用户真正走的那条路：关掉窗口。强杀会把还没刷盘的东西一起带走。
    await first.stop({ graceful: true })
    console.log('RAW first run: ' + JSON.stringify({ written, aliveAfterStop: first.alive() }))
    expect(first.alive()).toBe(false)

    const second = await startShell([], { userDataDir: profile })
    try {
      const readBack = await withPage(second, 'view', async (page) => {
        await page.goto(`${site.origin}/view`)
        return await page.evaluate(READ_JS)
      })
      console.log('RAW second run: ' + JSON.stringify(readBack))
      const state = readBack as { cookie: string; local: string | null; session: string | null; origin: string }
      expect(state.origin).toBe(site.origin)
      // 登录态就是这一类东西：带过期的 cookie + localStorage。
      expect(state.cookie).toContain('t6persist=alpha')
      expect(state.local).toBe('gamma')
      // 会话级的东西照浏览器语义消失——顺带证明读回来的是新进程的新页面，不是上一轮的回声。
      expect(state.cookie).not.toContain('t6session=beta')
      expect(state.session).toBeNull()
      // 它自己的档案真的落在了自己的目录里。
      expect(second.handshake.browserIdentity.storagePath).toBe(first.handshake.browserIdentity.storagePath)
      expect(second.handshake.userDataDir).toBe(profile)
    } finally {
      await second.stop({ graceful: true })
    }
  }, 120_000)
})

describe('T6 — 代理：外网继承，回环一律不走', () => {
  let proxy: { port: number; seen: string[]; close: () => Promise<void> }
  let shell: ShellProcess

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    // 显式给一个代理，才能把"外网真的走代理"和"回环真的不走"同时变成可观测的事实：
    // 不给代理时两半都是 DIRECT，读起来什么也证明不了。
    shell = await startShell(['--proxy', `127.0.0.1:${proxy.port}`])
  }, 120_000)

  afterAll(async () => {
    if (shell !== undefined) await shell.stop()
    if (proxy !== undefined) await proxy.close()
  })

  it('外壳读回：外网走这个代理，三个回环写法一律 DIRECT', () => {
    const record = shellRecord<ProxyRecord>(shell.stdout(), 'PROXY')
    console.log('RAW DSH_SHELL PROXY: ' + JSON.stringify(record))
    expect(record).toBeDefined()
    expect(record?.partition).toBe(identity.VIEW_PARTITION)
    expect(record?.readings.external.result).toBe(`PROXY 127.0.0.1:${proxy.port}`)
    expect(record?.readings.loopback127.result).toBe('DIRECT')
    expect(record?.readings.loopbackLocalhost.result).toBe('DIRECT')
    expect(record?.readings.loopbackV6.result).toBe('DIRECT')
  })

  it('回环页面照常打开，外网请求真的到了代理，而代理没收到任何回环请求', async () => {
    const target = `${shell.handshake.fixtureOrigin}/other`
    const title = await withPage(shell, 'view', async (page) => {
      await page.goto(target)
      return await page.title()
    })
    console.log('RAW loopback navigation with a proxy configured: ' + JSON.stringify({ target, title }))
    expect(title).toBe('other-page')

    // 外网：代理是唯一出口，它一律答 502，所以这一跳注定拿不到页面——重点是有没有到代理。
    await withPage(shell, 'view', async (page) => {
      await page.goto('http://t6-proxy-probe.invalid/').catch(() => undefined)
    })
    const fixturePort = new URL(shell.handshake.fixtureOrigin).port
    console.log('RAW proxy log: ' + JSON.stringify(proxy.seen))
    expect(proxy.seen.some((line) => line.includes('t6-proxy-probe.invalid'))).toBe(true)
    // 这一格启动时就是从回环 fixture 加载的，导航又走了一次回环；两条都不该出现在代理日志里。
    expect(proxy.seen.some((line) => line.includes(`127.0.0.1:${fixturePort}`))).toBe(false)
  }, 120_000)
})
