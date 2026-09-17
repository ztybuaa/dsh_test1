import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './shell-harness.ts'

/**
 * 面板工具条的**判断**，不需要浏览器就能钉住。
 *
 * 这正是把 `src/toolbar.js` 与 `src/client-body.js` 分开的理由：按钮的可用性、缩放标签、
 * 状态行那句话、以及键盘快捷键该不该抢 —— 这些判断是工具条真正会出错的地方，
 * 而"它们是否正确"不该只能靠起一次 Electron 来问。
 *
 * 读的是**源文件**，不是 `client.js`：生成物由 `client-half.spec.ts` 的 `--check` 守着，
 * 而那一条只证明"生成物与源一致"，不证明"源是对的"。
 */

const require = createRequire(import.meta.url)

interface ToolbarApi {
  BUTTONS: Array<{ action: string; label: string; title: string; shortcut: string | null }>
  ACTIONS: string[]
  TOOLBAR_HEIGHT_PX: number
  ZOOM_PRESETS: number[]
  isEnabled: (
    action: string,
    state: { canGoBack: boolean; canGoForward: boolean; busy: boolean; hasShell: boolean },
  ) => boolean
  zoomLabel: (zoom: unknown) => string
  zoomReading: (zoom: unknown, mode: unknown, words?: { auto?: string; manual?: string }) => string
  zoomPresetFactor: (percent: unknown) => number | null
  currentPreset: (zoom: unknown) => number | null
  parseAddress: (input: unknown) => { ok: true; url: string } | { ok: false; reason: string }
  statusText: (state: { url?: string; message?: string; ok: boolean | null }) => string
  diagnosticText: (state: { url?: string; message?: string }) => string
  readingText: (
    state: {
      zoom: unknown
      zoomMode: unknown
      loading?: unknown
      message?: string
      ok?: boolean | null
    },
    words?: { auto?: string; manual?: string; loading?: string },
  ) => string
  titleForTab: (title: unknown, fallback: string) => string
  travelHint: (target: unknown, prefix?: string) => string | undefined
  actionForKey: (
    event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
    inTextField: boolean,
  ) => string | null
}

/**
 * 读那份源文件。
 *
 * 它同时把 API 挂在 `module.exports` 与页面全局 `DshViewToolbar` 上（和
 * `shell/panel-rect.js` 同一个形状），而这两个里**哪一个真的拿到**取决于加载器：
 * 本仓库的 `package.json` 是 `"type": "module"`，所以一个 `.js` 文件在这里是被当 ESM
 * 解释的 —— `module` 不存在，于是只有全局那一路成立。取"两路里先出现的那个"，
 * 比假定某一路更诚实，也让这条用例在两种加载器下都读的是同一份源。
 */
const loaded = require(join(REPO_ROOT, 'src', 'toolbar.js')) as Partial<ToolbarApi>
const globalApi = (globalThis as unknown as { DshViewToolbar?: ToolbarApi }).DshViewToolbar
const toolbar = (Object.keys(loaded).length > 0 ? loaded : globalApi) as ToolbarApi

if (toolbar === undefined || typeof toolbar.isEnabled !== 'function') {
  throw new Error('src/toolbar.js exported nothing usable (neither module.exports nor globalThis.DshViewToolbar)')
}

/** 一个"什么都能按"的状态，用例只改它关心的那一项。 */
const ready = { canGoBack: true, canGoForward: true, busy: false, hasShell: true }

describe('票 #13 · 面板工具条（纯判断）', () => {
  it('票面点名的那些按钮一个不少，而且顺序是人读的顺序', () => {
    console.log('RAW toolbar buttons: ' + JSON.stringify(toolbar.BUTTONS.map((button) => button.action)))
    // 票面原文：**后退 · 前进 · 刷新 · 缩放(− / 百分比 / +) · 重置 · 重新开始**。
    // "百分比"是状态行上那个标签（`zoomLabel`），另外六个是按钮。
    //
    // 票 #19 加了第七个：**`auto`**（把这一格交回自动适配）。它不是多加了一颗装饰按钮 ——
    // 自动适配一旦被人指名过的缩放顶掉就不会自己回来（换页不丢缩放是 #13 钉住的语义），
    // 没有这颗按钮，手动模式就是一个进得去出不来的状态。理由写在 `src/toolbar.js` 那一行上。
    expect(toolbar.ACTIONS).toEqual([
      'back',
      'forward',
      'reload',
      'zoom-out',
      'zoom-reset',
      'zoom-in',
      'auto',
      'restart',
    ])
  })

  it('端点的命名空间与宿主那半边对得上（一个错字就是 404，不是另一个按钮）', async () => {
    // 客户端把动作叫 `desktop-view-<action>`，宿主把路由注册在 `/<channel>/desktop-view-<action>`。
    // 两边是同一组名字，这里是它们唯一的交叉点之一。
    const { viewEndpointPath } = (await import('../src/view-rpc.ts')) as typeof import('../src/view-rpc.ts')
    for (const button of toolbar.BUTTONS) {
      const action = button.action === 'zoom-reset' ? 'zoom-reset' : button.action
      const paths = ['back', 'forward', 'reload', 'restart', 'zoom-in', 'zoom-out', 'zoom-reset', 'auto', 'state']
      if (!paths.includes(action)) continue
      expect(viewEndpointPath(action)).toBe(`/api/desktop-view-${action}`)
    }
  })

  it('后退/前进没有可去的一页时是灰的；其余按钮**永远**不因为"不知道"而变灰', () => {
    // 已知的不可能：灰。
    expect(toolbar.isEnabled('back', { ...ready, canGoBack: false })).toBe(false)
    expect(toolbar.isEnabled('forward', { ...ready, canGoForward: false })).toBe(false)
    // 知道可能：亮。
    expect(toolbar.isEnabled('back', ready)).toBe(true)
    expect(toolbar.isEnabled('forward', ready)).toBe(true)
    // 其余四个**不**受历史影响 —— "我们不知道"绝不能被渲染成"你不能"。
    for (const action of ['reload', 'zoom-in', 'zoom-out', 'zoom-reset', 'restart']) {
      expect(toolbar.isEnabled(action, { ...ready, canGoBack: false, canGoForward: false }), action).toBe(true)
    }
    // 一个请求在飞的时候全灰：两次历史移动叠在一起会让面板显示一个谁都没产生过的状态。
    for (const action of toolbar.ACTIONS) {
      expect(toolbar.isEnabled(action, { ...ready, busy: true }), action).toBe(false)
    }
    // 没有外壳（普通浏览器标签页里的 DSH）：全灰，因为按了也没人接。
    for (const action of toolbar.ACTIONS) {
      expect(toolbar.isEnabled(action, { ...ready, hasShell: false }), action).toBe(false)
    }
  })

  it('缩放标签：读不到就写"—"，不写"100%"', () => {
    // "读回没回来"与"缩放是 100%"是两句不同的话，面板不许把它们说成一句。
    expect(toolbar.zoomLabel(1)).toBe('100%')
    expect(toolbar.zoomLabel(1.94)).toBe('194%')
    expect(toolbar.zoomLabel(0.5)).toBe('50%')
    expect(toolbar.zoomLabel(undefined)).toBe('\u2014')
    expect(toolbar.zoomLabel(Number.NaN)).toBe('\u2014')
    expect(toolbar.zoomLabel('1.5')).toBe('\u2014')
  })

  it('读数要说清是哪种模式（票 #19）：自动 78% / 手动 90%，而不知道就不带前缀', () => {
    const words = { auto: '自动', manual: '手动' }
    console.log(
      'RAW 缩放读数的四种形状: ' +
        JSON.stringify({
          auto: toolbar.zoomReading(0.78, 'auto', words),
          manual: toolbar.zoomReading(0.9, 'manual', words),
          unknown: toolbar.zoomReading(0.9, undefined, words),
          unreadable: toolbar.zoomReading(undefined, 'auto', words),
        }),
    )
    // 票面原话：读数的样子要像 `自动 78%` / `手动 90%`，**不许让人看不出来**。
    expect(toolbar.zoomReading(0.78, 'auto', words)).toBe('自动 78%')
    expect(toolbar.zoomReading(0.9, 'manual', words)).toBe('手动 90%')
    // 读不到模式 ⇒ 退回一个光秃秃的百分比，**不猜**：`90%` 说的是"这是 90%"，
    // 而猜出来的 `自动 90%` 说的是"外壳在按栏宽适配它" —— 后者可能不成立。
    expect(toolbar.zoomReading(0.9, undefined, words)).toBe('90%')
    expect(toolbar.zoomReading(0.9, 'something-else', words)).toBe('90%')
    // 连数都读不到时，模式也没有意义：一个 `—` 就够了。
    expect(toolbar.zoomReading(undefined, 'auto', words)).toBe('\u2014')
    expect(toolbar.zoomReading(Number.NaN, 'manual', words)).toBe('\u2014')
    // 没有词表时也只显示百分比（这个词表刻意住在文案表里，见 `src/toolbar.js`）。
    expect(toolbar.zoomReading(0.9, 'auto')).toBe('90%')
  })

  it('状态行只说用户要的：成功时**不显示**宿主的诊断话术，失败时才说为什么（票 #20 C）', () => {
    // 票面点名的那句：`nothing was changed` 是给开发者看的，不该出现在用户眼前。
    // 而它**没有被删掉** —— 它去的是 `diagnosticText`（面板把它挂在 tooltip 与
    // `data-dsh-view-diagnostic` 上，另一个通道，仍然读得到）。
    const quiet = { url: 'https://a.test/', message: 'nothing was changed', ok: true }
    console.log('RAW 票 #20 C 的两半: ' + JSON.stringify({ visible: toolbar.statusText(quiet), diagnostic: toolbar.diagnosticText(quiet) }))
    expect(toolbar.statusText(quiet)).toBe('')
    expect(toolbar.diagnosticText(quiet)).toContain('nothing was changed')
    expect(toolbar.diagnosticText(quiet)).toContain('https://a.test/')
    // 一步一步来的读数也同样只是诊断：它不进用户可见的那一行。
    expect(toolbar.statusText({ url: 'https://a.test/', message: 'zoom 100% → 200%', ok: true })).toBe('')

    // 失败时那句话**必须**在：它是用户唯一能知道"为什么这一按没成"的地方。
    const failed = toolbar.statusText({ message: 'there is no page to go back to', ok: false })
    console.log('RAW 失败那行: ' + failed)
    expect(failed).toContain('there is no page to go back to')
    // 失败时**不**把地址再抄一遍：地址的位置已经让给地址栏了（票面 C 的原话）。
    expect(failed).not.toContain('http://example.test/a')
    // 失败了但宿主一个字都没说时，也不许是空串（空行与"工具条坏了"长得一样）。
    expect(toolbar.statusText({ message: '', ok: false })).not.toBe('')
    // 还没读到任何东西时诊断那句永远有话（它也要能在 tooltip 上读）。
    expect(toolbar.diagnosticText({})).not.toBe('')
  })

  it('整行读数 = 模式 + 百分比（票 #20 C），必要时加"加载中"（F）与"为什么没成"', () => {
    const words = { auto: '自动', manual: '手动', loading: '加载中' }
    const reading = (state: Record<string, unknown>): string => toolbar.readingText(state as never, words)
    console.log(
      'RAW 读数的几种形状: ' +
        JSON.stringify({
          plain: reading({ zoom: 1, zoomMode: 'auto' }),
          loading: reading({ zoom: 0.78, zoomMode: 'auto', loading: true }),
          failed: reading({ zoom: 1, zoomMode: 'manual', ok: false, message: 'there is no page to go back to' }),
          unreadable: reading({ zoom: undefined, zoomMode: undefined }),
        }),
    )
    // 票面原话："读数只留用户要的信息（模式 + 百分比）"。
    expect(reading({ zoom: 1, zoomMode: 'auto' })).toBe('自动 100%')
    expect(reading({ zoom: 0.9, zoomMode: 'manual' })).toBe('手动 90%')
    // 加载中是真的加一段（票 #20 F 的第一条）。
    expect(reading({ zoom: 0.78, zoomMode: 'auto', loading: true })).toBe('自动 78% · 加载中')
    // 页面没在加载时不加那一段：`loading` 缺席或 false 都不说话。
    expect(reading({ zoom: 0.78, zoomMode: 'auto', loading: false })).toBe('自动 78%')
    expect(reading({ zoom: 0.78, zoomMode: 'auto' })).toBe('自动 78%')
    // 失败时那句"为什么"接在后面。
    expect(reading({ zoom: 1, zoomMode: 'manual', ok: false, message: 'nope' })).toBe('手动 100% · ✗ nope')
    // 读不到缩放时是 `—`，不编一个数（票 #20 之前就钉住的规矩）。
    expect(reading({ zoom: undefined, zoomMode: undefined })).toBe('\u2014')
  })

  it('地址栏的规则：只写主机名补 https://，回环主机补 http://，别的协议说得清是拒（票 #20 A）', () => {
    const cases: Array<[string, string]> = [
      // 票面点名的那个例子：`example.com` 补 `https://`。
      ['example.com', 'https://example.com'],
      ['example.com/a?b=1', 'https://example.com/a?b=1'],
      ['  example.com  ', 'https://example.com'],
      // 唯一的例外：回环主机（本机上跑着的东西几乎从不带 TLS）。
      ['localhost:3000', 'http://localhost:3000'],
      ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
      ['[::1]:5173', 'http://[::1]:5173'],
      // 写明协议的原样用。
      ['https://x.test/', 'https://x.test/'],
      ['http://x.test', 'http://x.test'],
      ['file:///C:/x', 'file:///C:/x'],
      ['about:blank', 'about:blank'],
      // `host:port` 里那个冒号**不是协议**。
      ['example.com:8080', 'https://example.com:8080'],
    ]
    const answers = cases.map(([input, expected]) => {
      const parsed = toolbar.parseAddress(input)
      return { input, expected, parsed }
    })
    console.log('RAW 地址栏规则: ' + JSON.stringify(answers))
    for (const answer of answers) {
      expect(answer.parsed, answer.input).toEqual({ ok: true, url: answer.expected })
    }

    // 说不清的一律**拒**，且各自说得出是哪一类：
    const refusals: Array<[string, string]> = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['hello world', 'spaces'],
      ['https://', 'host'],
      ['file:', 'host'],
      ['javascript:alert(1)', 'scheme'],
      ['mailto:a@b.c', 'scheme'],
      ['data:text/html,<b>x</b>', 'scheme'],
    ]
    for (const [input, reason] of refusals) {
      console.log(`RAW 拒收 ${JSON.stringify(input)} -> ${JSON.stringify(toolbar.parseAddress(input))}`)
      expect(toolbar.parseAddress(input), input).toEqual({ ok: false, reason })
    }
    // 非字符串也给一个说得清的原因（面板是网页，输入不可信）。
    expect(toolbar.parseAddress(undefined)).toEqual({ ok: false, reason: 'empty' })
    expect(toolbar.parseAddress(42)).toEqual({ ok: false, reason: 'empty' })
  })

  it('缩放档位：标准的那 11 个，而且**全部**落在 −/+ 走过的那串档位里（票 #20 D）', async () => {
    const { ZOOM_PRESETS } = await import('../src/view-rpc.ts')
    const { ZOOM_STEPS } = await import('../src/navigation.ts')
    const steps = ZOOM_STEPS
    console.log(
      'RAW 档位表（面板 / 宿主 / −+ 的档位串）: ' +
        JSON.stringify({ panel: toolbar.ZOOM_PRESETS, host: ZOOM_PRESETS, steps }),
    )
    // 票面点名的就是这 11 个。
    expect(toolbar.ZOOM_PRESETS).toEqual([50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200])
    // 面板这一份与宿主那一份必须逐项相同：不同就是"点了一下会被 400 掉"。
    expect(ZOOM_PRESETS).toEqual(toolbar.ZOOM_PRESETS)
    // 而且每一个都在 `−`/`+` 走的 `ZOOM_STEPS` 里 —— 否则"选了 125% 再按一次 +"会跳到一个
    // 谁也没见过的值上。
    for (const percent of toolbar.ZOOM_PRESETS) {
      expect(steps, `${String(percent)}% 必须是 −/+ 也会经过的一档`).toContain(percent / 100)
      expect(toolbar.zoomPresetFactor(percent)).toBeCloseTo(percent / 100, 10)
    }
    // 表外的一律不收（这条通道上没有"缩放到任意值"）。
    expect(toolbar.zoomPresetFactor(83)).toBeNull()
    expect(toolbar.zoomPresetFactor('125')).toBeNull()
    expect(toolbar.zoomPresetFactor(Number.NaN)).toBeNull()
    // 菜单里"你在这儿"只在**正好**是某一档时才标：自动适配算出来的 78% 一个都不标。
    expect(toolbar.currentPreset(1)).toBe(100)
    expect(toolbar.currentPreset(1.25)).toBe(125)
    expect(toolbar.currentPreset(0.78)).toBeNull()
    expect(toolbar.currentPreset(undefined)).toBeNull()
  })

  it('标签标题读不到就回落"浏览器"（票 #20 B）；悬停提示读不到就一个字都不给（F）', () => {
    console.log(
      'RAW 标签与悬停: ' +
        JSON.stringify({
          title: [toolbar.titleForTab('  机票列表  ', '浏览器'), toolbar.titleForTab('', '浏览器'), toolbar.titleForTab(null, '浏览器')],
          hint: [
            toolbar.travelHint({ title: 'Two', url: 'http://x/2' }, '后退到'),
            toolbar.travelHint({ title: '', url: 'http://x/2' }, '后退到'),
            toolbar.travelHint(undefined, '后退到'),
          ],
        }),
    )
    // 页面标题（读回来的那个）优先，两边空白都剪掉。
    expect(toolbar.titleForTab('  机票列表  ', '浏览器')).toBe('机票列表')
    // 读不到 / 空标题 ⇒ 回落。空标签比"浏览器"更坏。
    expect(toolbar.titleForTab('', '浏览器')).toBe('浏览器')
    expect(toolbar.titleForTab('   ', '浏览器')).toBe('浏览器')
    expect(toolbar.titleForTab(undefined, '浏览器')).toBe('浏览器')
    expect(toolbar.titleForTab(null, '浏览器')).toBe('浏览器')

    // 有标题用标题，没标题用地址（真浏览器也是这么做的）。
    expect(toolbar.travelHint({ title: 'Two', url: 'http://x/2' }, '后退到')).toBe('后退到 Two')
    expect(toolbar.travelHint({ title: '', url: 'http://x/2' }, '后退到')).toBe('后退到 http://x/2')
    // 读不到目标（引擎没答）⇒ 一个字都不给，而不是给一个空 tooltip。
    expect(toolbar.travelHint(undefined, '后退到')).toBeUndefined()
    expect(toolbar.travelHint(null, '后退到')).toBeUndefined()
    expect(toolbar.travelHint({ title: '', url: '' }, '后退到')).toBeUndefined()
    // 没有词表时只给目标本身（词表住在文案表里）。
    expect(toolbar.travelHint({ title: 'Two', url: '' })).toBe('Two')
  })

  it('键盘快捷键：带修饰键的不抢，焦点在文本框里也不抢', () => {
    const plain = { key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false }
    expect(toolbar.actionForKey(plain, false)).toBe('back')
    expect(toolbar.actionForKey({ ...plain, key: 'ArrowRight' }, false)).toBe('forward')
    expect(toolbar.actionForKey({ ...plain, key: 'F5' }, false)).toBe('reload')
    // 面板在 DSH 的窗口里，光标十有八九在聊天输入框里 —— 抢走 ArrowLeft 是更糟的 bug。
    expect(toolbar.actionForKey(plain, true)).toBeNull()
    // 带修饰键的是操作系统的（比如 Cmd+Left）。
    expect(toolbar.actionForKey({ ...plain, ctrlKey: true }, false)).toBeNull()
    expect(toolbar.actionForKey({ ...plain, metaKey: true }, false)).toBeNull()
    expect(toolbar.actionForKey({ ...plain, altKey: true }, false)).toBeNull()
    // 不相干的键不动。
    expect(toolbar.actionForKey({ ...plain, key: 'a' }, false)).toBeNull()
  })

  it('工具条的高度是一个正数：它是从视口里让出来的那一条，不能是 0 或负数', () => {
    expect(toolbar.TOOLBAR_HEIGHT_PX).toBeGreaterThan(16)
    expect(toolbar.TOOLBAR_HEIGHT_PX).toBeLessThan(80)
  })
})
