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
  isEnabled: (
    action: string,
    state: { canGoBack: boolean; canGoForward: boolean; busy: boolean; hasShell: boolean },
  ) => boolean
  zoomLabel: (zoom: unknown) => string
  statusText: (state: { url: string; zoom: unknown; message: string; ok: boolean | null }) => string
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
    expect(toolbar.ACTIONS).toEqual([
      'back',
      'forward',
      'reload',
      'zoom-out',
      'zoom-reset',
      'zoom-in',
      'restart',
    ])
  })

  it('端点的命名空间与宿主那半边对得上（一个错字就是 404，不是另一个按钮）', async () => {
    // 客户端把动作叫 `desktop-view-<action>`，宿主把路由注册在 `/<channel>/desktop-view-<action>`。
    // 两边是同一组名字，这里是它们唯一的交叉点之一。
    const { viewEndpointPath } = (await import('../src/view-rpc.ts')) as typeof import('../src/view-rpc.ts')
    for (const button of toolbar.BUTTONS) {
      const action = button.action === 'zoom-reset' ? 'zoom-reset' : button.action
      const paths = ['back', 'forward', 'reload', 'restart', 'zoom-in', 'zoom-out', 'zoom-reset', 'state']
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

  it('状态行永远说点什么，失败时那句话是主句', () => {
    const failed = toolbar.statusText({
      url: 'http://example.test/a',
      zoom: 1,
      message: 'there is no page to go back to',
      ok: false,
    })
    console.log('RAW status line on failure: ' + failed)
    expect(failed).toContain('there is no page to go back to')
    expect(failed).toContain('http://example.test/a')
    // 还没有读到任何东西时不许是空的：空行与"工具条坏了"长得一模一样。
    expect(toolbar.statusText({ url: '', zoom: undefined, message: '', ok: null })).not.toBe('')
    // 成功时把宿主那句原话显示出来（它就是"我按下去发生了什么"）。
    expect(toolbar.statusText({ url: 'http://x.test/', zoom: 2, message: 'zoom 100% → 200%', ok: true })).toContain(
      'zoom 100% → 200%',
    )
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
