import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Page } from 'playwright'
import { apply } from '../src/index.ts'
import { REPO_ROOT, pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #11「无外壳时的行为」—— 三条验收各自的读回口。
 *
 * 这一份 spec 存在的理由只有一个：**今天没有任何测试读过"没有外壳时用户看到什么"**。
 * `tests/panel-placement.spec.ts` 断言的是 `DshPanelRect.deliver()` 的返回值
 * （`{delivered:false, reason:'no-shell'}`）——那是**管线**的答案，不是**那一格**的答案。
 * 面板把说明文字删成空白，票前那 118 条用例一条都不会红：这正是"静默失效"的定义。
 *
 * 所以这里每一条都从**被观察的那一端**读回，而不是读代码推断：
 *
 *  1. **真 `dsh` 宿主、真的没有外壳**（临时 `DSH_HOME` + 临时 profile，本插件装在里面，
 *     不设任何 `DSH_DESKTOP_VIEW_*`）：宿主起来了吗？报错了吗？它自己把本插件的客户端
 *     半边组合进启动图、并且在 `/plugins/…` 上端得出来吗？
 *  2. **那一格渲染出来的文本**：真的 `client.js`（宿主加载的那一份）在真的 Chromium 页面里，
 *     经由真的 `apply(ctx)` 注册出的那个 body 组件，挂进真的 DOM，读 `innerText`——
 *     中英各一遍，且断言**非空**。
 *  3. **工具调用说什么**：真的 `apply()` 在真的 `ctx.tools.register` 上注册出来的每一条工具，
 *     在没有端点时是不是都给出那条点名原因的错误（而不是崩掉或含糊）。
 *
 * 关于第 2 条里的 React：**它是本文件里唯一的替身**，而且只在"运行 hook"这一件事上。
 * 被渲染的组件、它读的 `DshPanelRect`、它落脚的那个 DOM，全部是真的；替身只回答
 * `useRef/useState/useMemo/useEffect/createElement` 五个调用（本仓库没有 React 依赖，
 * 面板的宿主有）。它因此**不**覆盖 React 的协调与并发语义——那部分由
 * `tests/client-half.spec.ts` 覆盖的"宿主真的加载这个 artifact"来兜。
 */

/** 本插件的包名：宿主用它当插件 id，启动图里也是这个键。 */
function packageName(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name?: string }
  if (typeof manifest.name !== 'string') throw new Error('package.json has no name')
  return manifest.name
}

/** 宿主加载的那一份客户端 bundle（`client.js`，由 `shell/panel-rect.js` + `src/client-body.js` 生成）。 */
const CLIENT_JS = join(REPO_ROOT, 'client.js')

/**
 * 找到 `dsh` 启动器真正要跑的脚本（`@deepseek-ai/dsh/lib/bin.js`）。
 *
 * 走 PATH 上的 `dsh` 垫片而不是把本机的绝对路径写进仓库：垫片就在安装目录顶层，
 * 它指向的 `node_modules/@deepseek-ai/dsh/lib/bin.js` 是启动器本体。`DSH_BIN` 可以
 * 直接指定本体，供装在别处的人用。
 *
 * @returns 绝对路径，找不到时 undefined。
 */
function resolveDshBinScript(): string | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit
  const located = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const first = (located.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')[0]
  if (first === undefined) return undefined
  const candidate = join(dirname(first), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : undefined
}

/** 一个真在跑的 `dsh` 宿主，以及读它说了什么的口子。 */
interface RealHost {
  /** 宿主自己打印的 Web UI 地址（带 token）。 */
  url: string
  /** 它到目前为止写到 stdout 的全文。 */
  stdout: () => string
  /** 它到目前为止写到 stderr 的全文。 */
  stderr: () => string
  /** 临时 harness home，停掉之后由调用方删除。 */
  home: string
  /** 杀掉进程树并释放 home 目录。 */
  stop: () => Promise<void>
}

/** 宿主没在这么长时间内打印地址就算失败。 */
const BOOT_TIMEOUT_MS = 180_000

/**
 * 起一个**真的** `dsh` 宿主：临时 `DSH_HOME` + 临时 profile，里面装着本插件。
 *
 * 用户自己的 `~/.dsh` 一个字节都不碰——`DSH_HOME` 指到临时目录，profile 也建在那里，
 * 依赖用目录联接（junction）指向本仓库，和用户在 profile 里装本插件的方式同形。
 *
 * @returns 跑起来的宿主。
 */
async function bootRealHost(): Promise<RealHost> {
  const bin = resolveDshBinScript()
  if (bin === undefined) {
    throw new Error(
      'this test needs the `dsh` launcher on PATH (or DSH_BIN pointing at ' +
        '@deepseek-ai/dsh/lib/bin.js): acceptance #1 of ticket #11 is about a REAL host without the shell, ' +
        'and a skipped check would be the silent failure the ticket is about',
    )
  }
  const name = packageName()
  const home = mkdtempSync(join(tmpdir(), 'dsh-t11-home-'))
  const profileDir = join(home, 'profiles', 't11-noshell')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-t11-noshell',
        private: true,
        dependencies: { [name]: `link:${REPO_ROOT.replace(/\\/g, '/')}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', name], patchReload: 'live' } },
      },
      undefined,
      2,
    ) + '\n',
  )
  // 用户层的 patch 是空的：本插件的每一份配置都只能来自外壳给的环境变量，
  // 而这里一个都没有——这就是"没有外壳"的定义。
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  symlinkSync(REPO_ROOT, join(profileDir, 'node_modules', name), 'junction')

  // `bin` is a JS file, not an executable: on Windows spawning it directly is EFTYPE.
  const child: ChildProcess = spawn(process.execPath, [bin, '--profile', 't11-noshell', '--no-open', '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })

  const kill = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
    await new Promise<void>((settle) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        settle()
        return
      }
      const timer = setTimeout(settle, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        settle()
      })
    })
  }

  // 启动失败也要把这个 150+ 文件的临时 home 收掉。失败路径漏目录正是这个仓库已经踩过的坑
  // （`removeWhenFree` 的存在理由就是"清理永远不该被当成结果"），而一次 401 就够漏一个。
  try {
    const url = await new Promise<string>((settle, fail) => {
      const timer = setTimeout(() => {
        fail(
          new Error(`dsh did not serve the web UI within ${BOOT_TIMEOUT_MS}ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`),
        )
      }, BOOT_TIMEOUT_MS)
      const scan = (): void => {
        const match = /^dsh web: (http:\/\/\S+)$/m.exec(out)
        if (match !== null) {
          clearTimeout(timer)
          settle(match[1])
        }
      }
      child.stdout?.on('data', scan)
      child.once('exit', (code) => {
        clearTimeout(timer)
        fail(new Error(`dsh exited with code ${code} before serving\n--- stdout ---\n${out}\n--- stderr ---\n${err}`))
      })
      scan()
    })

    const stop = async (): Promise<void> => {
      await kill()
      removeWhenFree(home)
    }

    return { url, stdout: () => out, stderr: () => err, home, stop }
  } catch (error) {
    await kill()
    removeWhenFree(home)
    throw error
  }
}

describe('票 #11 · 真宿主、没有外壳 —— 插件照常加载', () => {
  let host: RealHost

  beforeAll(async () => {
    host = await bootRealHost()
  }, 240_000)

  afterAll(async () => {
    if (host !== undefined) await host.stop()
  })

  it('boots a real host with no loader error and no desktop-view endpoint in sight', () => {
    console.log('RAW dsh stdout: ' + JSON.stringify(host.stdout()))
    console.log('RAW dsh stderr: ' + JSON.stringify(host.stderr()))
    // 宿主把地址打出来了，说明它一路 compose 到了应用层。剩下要看的是"路上有没有抱怨"：
    // loader 的失败是响亮的一句话（客户端半边那次真实事故的原文就在这下面），
    // 所以这里断言的是**它没说过**这些话，而不是"日志看起来还行"。
    expect(host.stdout()).not.toMatch(/failed to apply loader entry/i)
    expect(host.stdout()).not.toMatch(/invalid plugin/i)
    expect(host.stderr()).not.toMatch(/failed to apply loader entry/i)
    expect(host.stderr()).not.toMatch(/cannot resolve profile bundle/i)
    expect(host.stderr()).not.toMatch(/Error:/)
  })

  it('composes this plugin into the client boot graph and serves its bundle', async () => {
    // `?token=` 不是"页面本身"：它是一次授权跳转——量到的回答是 `303` + `Set-Cookie`，
    // 而 Node 的 `fetch` 没有 cookie 罐，跟着跳过去就会以未授权身份请求 `/`（401）。
    // 所以显式走两步：先拿这张票换 cookie，再带着 cookie 请求页面。
    const granted = await fetch(host.url, { redirect: 'manual' })
    const cookies = (granted.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    expect(granted.status).toBe(303)
    expect(cookies.length, 'the token must be exchanged for a browser session cookie').toBeGreaterThan(0)
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ')

    const origin = new URL('/', host.url)
    const page = await fetch(origin, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('__DSH_BOOT__')

    // 宿主自己说出来的启动图里有没有我们这一条，以及它给了哪个地址。
    const bootId = `"id":"${packageName()}"`
    const at = html.indexOf(bootId)
    console.log('RAW boot graph entry: ' + JSON.stringify(html.slice(Math.max(0, at - 40), at + 160)))
    expect(at, 'the host must list this plugin in the client boot graph').toBeGreaterThan(-1)
    const clientUrl = /\/plugins\/\?\?[^"]*client\.js[^"]*/.exec(html.slice(at))
    expect(clientUrl, 'the boot graph entry must carry the client bundle url').not.toBeNull()

    // 那个地址真的端得出来，而且端出来的就是本插件的 bundle（`id` 是包名这件事在这里读回）。
    const bundle = await fetch(new URL(clientUrl![0].replace(/&amp;/g, '&'), origin), { headers: { cookie } })
    console.log('RAW client bundle: ' + JSON.stringify({ url: clientUrl![0], status: bundle.status }))
    expect(bundle.status).toBe(200)
    const source = await bundle.text()
    expect(source).toContain(`id: '${packageName()}'`)
    expect(source).toContain('__ModuleLoader__.load')
  }, 60_000)
})

/**
 * 面板那一格：真的 artifact + 真的页面 + 真的 DOM。
 *
 * 页面用的是外壳的**原生视图**那一页，不是窗口那一页：`shell/preload.js` 只把矩形通道
 * 装进窗口（它自己的注释说明了原因——视图那页要是拿到 `setRect`，任意网站就能挪自己的框），
 * 所以视图页上**没有** `__dshDesktopView`，这正是普通浏览器标签页的形状。
 * 测试先把这一点断言掉，再谈渲染——否则"没有外壳"这个前提就是嘴上说的。
 */
describe('票 #11 · 那一格渲染的是说明文字，不是空白', () => {
  let shell: ShellProcess
  let page: Page
  let connection: { close: () => Promise<void> } | undefined

  beforeAll(async () => {
    shell = await startShell()
    const connected = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    connection = connected.browser
    page = connected.page

    // 加载宿主加载的那一份 artifact，然后走宿主走的那两步：`factory(require)` 与 `apply(ctx)`。
    // 之后页面上留下 `__t11`：注册出来的那个 body 组件，以及按语言渲染一次的口子。
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>
      const entries: Array<{ id: string; factory: (require: (name: string) => unknown) => unknown }> = []
      host.__moduleEntries = entries
      host.__ModuleLoader__ = {
        load: (entry: unknown) => {
          entries.push(entry as (typeof entries)[number])
        },
      }
    })
    await page.addScriptTag({ path: CLIENT_JS })
    await page.evaluate(() => {
      /**
       * 本仓库没有 React 依赖（面板的宿主有），所以这里只补上面板真正用到的那五个调用：
       * `createElement` 直接建成**真的 DOM 节点**（不是虚拟树），挂上去就是真渲染。
       *
       * hook 只回答"首次渲染"的那一次，因为这一段面板在无外壳时不重渲染：没有通道就没有
       * observer，`setReport` 永远不会被调用。它因此**不**覆盖 React 的协调与并发语义。
       */
      const makeReact = () => ({
        useRef: (initial: unknown) => ({ current: initial }),
        useState: (initial: unknown) => [initial, () => {}],
        useMemo: (compute: () => unknown) => compute(),
        useEffect: () => {},
        createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => {
          const element = document.createElement(type)
          for (const [key, value] of Object.entries(props ?? {})) {
            if (key === 'ref' || key === 'children') continue
            if (key === 'style') Object.assign(element.style, value as object)
            else if (typeof value === 'string') element.setAttribute(key, value)
          }
          for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) continue
            element.append(String(child))
          }
          return element
        },
      })

      const host = window as unknown as Record<string, unknown> & {
        __moduleEntries: Array<{ id: string; factory: (require: (name: string) => unknown) => unknown }>
        DshPanelRect: { deliver: (rect: unknown) => unknown; hasShell: () => boolean }
      }
      const entry = host.__moduleEntries[0]
      if (entry === undefined) throw new Error('the artifact registered no module entry')

      /** 加载期 `require` 过的名字：这一段半边在 factory 里不该要任何东西。 */
      const requiredWhileLoading: string[] = []
      const plugin = entry.factory((name: string) => {
        if (name === 'react') return makeReact()
        requiredWhileLoading.push(name)
        throw new Error(`the panel asked for something this test does not have: ${name}`)
      }) as { apply?: (ctx: unknown) => void }

      /** `apply()` 真正注册出来的那个 body 组件——这就是宿主会渲染的东西。 */
      let body: ((props: unknown) => HTMLElement) | null = null
      const ctx = {
        effect: (fn: () => unknown) => fn(),
        locale: { bind: () => (key: string) => key, register: () => () => {} },
        sidebarRightTabs: { register: () => () => {} },
        slots: {
          inject: (_seat: string, fn: () => unknown) => fn(),
          register: (_definition: { key: string }, component: (props: unknown) => HTMLElement) => {
            body = component
            return () => {}
          },
        },
      }
      if (typeof plugin.apply === 'function') plugin.apply(ctx)
      if (body === null) throw new Error('the client half registered no tab body')

      /** 按 `navigator.language` 渲染一次，挂进真 DOM，读回它显示的文字。 */
      const render = (language: string) => {
        Object.defineProperty(navigator, 'language', { configurable: true, get: () => language })
        const element = (body as unknown as (props: unknown) => HTMLElement)({
          tabInfo: () => ({ sidebar: { expanded: true }, tab: { visible: true } }),
        })
        document.body.replaceChildren(element)
        return {
          language,
          text: (element.innerText ?? '').trim(),
          state: element.getAttribute('data-dsh-desktop-view-panel'),
          delivered: host.DshPanelRect.deliver({ x: 0, y: 0, width: 10, height: 10 }),
        }
      }

      host.__t11 = {
        requiredWhileLoading,
        render,
      }
    })
  }, 180_000)

  afterAll(async () => {
    if (connection !== undefined) await connection.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  it('has no rectangle channel on this page — the premise of everything below', async () => {
    const observed = await page.evaluate(() => {
      const host = window as unknown as {
        __dshDesktopView?: unknown
        DshPanelRect: { hasShell: () => boolean }
        __t11: { requiredWhileLoading: string[] }
      }
      return {
        channel: typeof host.__dshDesktopView,
        hasShell: host.DshPanelRect.hasShell(),
        requiredWhileLoading: host.__t11.requiredWhileLoading,
      }
    })
    console.log('RAW no-shell premise: ' + JSON.stringify(observed))
    expect(observed.channel).toBe('undefined')
    expect(observed.hasShell).toBe(false)
    // 这一段半边在加载期不该 require 任何东西：真发生过的话，宿主那边是"插件加载失败"。
    expect(observed.requiredWhileLoading).toEqual([])
  })

  it('renders the notice — in both languages, never an empty pane', async () => {
    const rendered = await page.evaluate(() => {
      const host = window as unknown as {
        __t11: { render: (language: string) => { language: string; text: string; state: string | null; delivered: unknown } }
      }
      return { zh: host.__t11.render('zh-CN'), en: host.__t11.render('en-US') }
    })

    console.log('RAW rendered panel (zh): ' + JSON.stringify(rendered.zh))
    console.log('RAW rendered panel (en): ' + JSON.stringify(rendered.en))

    for (const view of [rendered.zh, rendered.en]) {
      // "空白"就是这条票要挡的东西，所以先断言它不是空的、也不是几个字符的占位。
      expect(view.text.length, `${view.language}: the pane must not be blank`).toBeGreaterThan(20)
      // 也不许报错——deliver 在没有通道时如实回答，而不是抛。
      expect(view.delivered).toEqual({ delivered: false, reason: 'no-shell' })
      expect(view.state).toBe('detached')
    }

    // 中英各一遍，且各自说清"这一格需要桌面外壳"，以及**怎么办**（起外壳的那条命令）。
    expect(rendered.zh.text).toContain('这一格需要桌面外壳才能显示浏览器')
    expect(rendered.en.text.toLowerCase()).toContain('needs the desktop shell')
    expect(rendered.zh.text).toContain('npm run shell')
    expect(rendered.en.text).toContain('npm run shell')
    // 两种语言不是同一串字：一份共享文案会在其中一种语言里显示成外语。
    expect(rendered.zh.text).not.toBe(rendered.en.text)
  }, 60_000)
})

/**
 * 工具注册面：真的 `apply()`，真的注册调用，真的执行。
 *
 * 这里**不**经过模型——`dsh` 里调一次工具要一个 agent 轮次（要凭据、要网）。
 * 覆盖的是插件自己那一段：工具注册进 `ctx.tools` 之后，在没有端点时每条工具的回答是什么。
 */
describe('票 #11 · 无外壳时工具的注册面与回答', () => {
  /** 真的 `apply()` 注册出来的工具，原样留着。 */
  let registered: ToolDefinition[] = []
  /** 执行工具时的第二个参数，本仓库既有测试的写法。 */
  const IGNORED_EXEC = undefined as unknown as Parameters<ToolDefinition['execute']>[1]
  /** 被临时摘掉的环境变量，测完放回去。 */
  const ENV_KEYS = ['DSH_DESKTOP_VIEW_CDP', 'DSH_DESKTOP_VIEW_TARGET', 'DSH_DESKTOP_VIEW_URL', 'DSH_DESKTOP_VIEW_SPACES']
  let savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    registered = []
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      attachments: {},
      tools: { register: (tool: ToolDefinition) => registered.push(tool) },
    }
    apply(ctx as never, {
      timeoutMs: 30_000,
      maxElements: 200,
      maxChars: 20_000,
      screenshotDir: '.',
    } as never)
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('registers the whole browser_* surface without a shell', () => {
    const names = registered.map((tool) => tool.name)
    console.log('RAW registered tools (' + names.length + '): ' + JSON.stringify(names))
    expect(names.length).toBeGreaterThanOrEqual(20)
    for (const name of names) expect(name).toMatch(/^browser_[a-z_]+$/)
    expect(new Set(names).size).toBe(names.length)
    // 名字里有就说明"这个能力存在"，所以核心面缺一个就是缺一个能力。
    for (const required of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_wait',
      'browser_extract',
      'browser_evaluate',
      'browser_json',
      'browser_screenshot',
      'browser_download',
      'browser_space',
    ]) {
      expect(names, `the registry must carry ${required}`).toContain(required)
    }
  })

  it('ships no screenshot-stream tool: the retired pipeline is not in the registry', () => {
    // 票 #11 第三条验收的可反证形式：**注册表里没有任何截图流名字的工具**。
    // 谁要是把 `Page.startScreencast` / MJPEG 那条路捡回来并挂成工具，这里就红。
    const names = registered.map((tool) => tool.name)
    const streamLike = names.filter((name) => /(screencast|mjpg|mjpeg|screen_?stream|frame_?stream|video_?frame)/i.test(name))
    console.log('RAW screenshot-stream tool names: ' + JSON.stringify(streamLike))
    expect(streamLike).toEqual([])
  })

  it('answers every tool call with a named reason instead of crashing', async () => {
    /**
     * 每条工具按自己的必填参数喂一份说得过去的入参。
     *
     * 不这么做的后果已经量到过：`defineTool` 先校验参数，缺一个必填项就抛
     * `invalid arguments: missing required property "url"` —— 那也是一句话，但它避开了
     * 这条票要问的那句话（"没有端点时工具说什么"），测出来的东西就不是本票的东西。
     */
    const ARGUMENTS: Record<string, Record<string, unknown>> = {
      browser_navigate: { url: 'https://example.invalid/' },
      browser_click: { ref: 1 },
      browser_hover: { ref: 1 },
      browser_type: { ref: 1, text: 'x' },
      browser_type_keys: { ref: 1, text: 'x' },
      browser_press_key: { key: 'Enter' },
      browser_select: { ref: 1, option: 'x' },
      browser_drag: { fromRef: 1, toRef: 2 },
      browser_evaluate: { expression: '1' },
      browser_upload: { ref: 1, path: 'x' },
      browser_space: { action: 'list' },
    }

    const answers: Array<{ tool: string; args: Record<string, unknown>; message: string }> = []
    for (const tool of registered) {
      const args = ARGUMENTS[tool.name] ?? {}
      let message = ''
      try {
        await tool.execute(args, IGNORED_EXEC)
        message = '(resolved: no error at all)'
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      answers.push({ tool: tool.name, args, message })
    }
    console.log('RAW tool answers without a shell: ' + JSON.stringify(answers, null, 2))

    for (const answer of answers) {
      // 每一条都必须说得出话：崩掉是"没有答案"，含糊是"答案没用"。
      expect(answer.message.length, `${answer.tool} must answer with a reason`).toBeGreaterThan(0)
      expect(answer.message, `${answer.tool} must not have succeeded without an endpoint`).not.toBe(
        '(resolved: no error at all)',
      )
      if (answer.tool === 'browser_space') {
        // 唯一一条**不**走端点就能说清自己为什么不能干活的能力：空间通道也不在。
        expect(answer.message).toContain('browser_space has no shell to manage spaces in')
      } else {
        // 其余每一条都点名原因，并且给出两条出路（配置项 / 到外壳下跑）。
        expect(answer.message, `${answer.tool} must name the missing endpoint`).toContain('no desktop view endpoint')
        expect(answer.message).toContain('DSH_DESKTOP_VIEW_CDP')
        expect(answer.message).toContain('desktop shell')
      }
    }
  }, 60_000)
})
