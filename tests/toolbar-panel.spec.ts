import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { attributeOf, attributesOf, clickIn, installShipment, mountShipment, typeInto } from './mini-react.ts'
import { pageForTarget, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * 票 #20 · 那一格**真的画出来**之后，A / B / C / D / F 各自的读回口。
 *
 * ## 这一份量的是什么
 *
 * 交付物本身（`client.js` 生成物里那几个组件）装在**真 Chromium 页面**上：真的 DOM、真的布局、
 * 真的 `<input>`。渲染器是 `tests/mini-react.ts` 那个替身 —— 它**只**替
 * `createElement`/hook 那一层，"按一下会发什么请求、页面上会显示什么"全都来自被测代码。
 *
 * ## 为什么挂在**视图那一页**上，而不是外壳窗口那一页
 *
 * 窗口那一页有**真的**矩形通道（preload 装的），于是面板每一次上报都会让外壳真的去摆那块原生
 * 视图 —— 摆完窗口一量又与上次不同，`ResizeObserver`/`resize` 又让面板再报一次，来回几下就把
 * `mini-react` 那道"12 次渲染还不收敛就抛"的闸顶掉了（实测：一次挂载里量到 13 次状态读回，
 * 之后整棵树冻住，后面所有交互都像"没反应"）。那是**量具**的时序，不是被测代码的行为。
 *
 * 所以这里用视图那一页 + 一个**假的**矩形通道（`withShellChannel`）：DOM 那一侧全是真的，
 * 上报不进外壳。真通道那一半由 `tests/panel-toolbar-placement.spec.ts`（真窗口页、真 preload）
 * 与 `tests/panel-toolbar.spec.ts`（真外壳 + 真 dsh 宿主）各自量过。
 *
 * ## 这一份**不**量什么
 *
 * 面板那一按在**真 dsh 宿主**上的那一趟（真 HTTP、真会话、真视图）由
 * `tests/panel-toolbar.spec.ts` 量，本文件里的宿主是一个查表替身。两边谁也不替谁：
 * 那边证"路是通的"，这边证"界面上是按票面长出来的"。
 *
 * 真 DSH 界面里那一格渲染不出来（首启流程要工作区/API Key），所以"侧边栏标签上真的显示页面
 * 标题"这件事**只做到座位注册与组件输出**这一层，剩下的写进报告里的诚实清单。
 */

describe('票 #20 · 那一格上的界面：地址栏 / 读数 / 档位 / 标签标题', () => {
  let shell: ShellProcess
  let probe: Browser
  let page: Page

  beforeAll(async () => {
    shell = await startShell([], { windowSize: { width: 1200, height: 800 } })
    const connected = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    probe = connected.browser
    page = connected.page
    // 页面里抛出来的东西要看得见：`mini-react` 那道"渲染不收敛"的闸是在一个微任务里抛的，
    // 不接住它，页面上只会表现为"点了没反应"。
    page.on('pageerror', (error: Error) => {
      console.log('RAW page error: ' + error.message)
    })
    // 这一页本来没有矩形通道（preload 只装在窗口那一页上），装一个假的：面板要它才知道
    // "有外壳"，而它不会真的把原生视图挪来挪去。
    await page.goto('about:blank')
    await page.evaluate(() => {
      document.body.style.margin = '0'
    })
  }, 180_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  /** 每一格用例都从一张白纸开始：装一次交付物，挂一次那一格。 */
  const mount = async (
    options: {
      rpcValue?: Record<string, unknown>
      rpcTable?: Record<string, Record<string, unknown>>
      mountTitle?: boolean
    } = {},
  ) => {
    await page.evaluate(() => {
      document.getElementById('dsh-view-shipped-panel')?.remove()
      document.getElementById('dsh-view-shipped-title')?.remove()
    })
    await installShipment(page, { withShellChannel: true, stubAnimationFrame: true })
    return await mountShipment(page, {
      rpcValue: {
        url: 'http://fixture.test/view',
        title: 'Fixture page',
        zoom: 1,
        // 票 #20b：这个字段**故意照旧喂进去**。外壳仍然会发它（旧插件在读它，票面明令兼容不许破），
        // 而面板这一侧一个字节都不许用它 —— "读数是 `100%` 而不是 `自动 100%`"这件事由此可反证。
        zoomMode: 'auto',
        ok: true,
        ...options.rpcValue,
      },
      ...(options.rpcTable !== undefined ? { rpcTable: options.rpcTable } : {}),
      ...(options.mountTitle === true ? { mountTitle: true } : {}),
    })
  }

  /** 页面上那几样东西现在长什么样（全部从 DOM 读回）。 */
  const surface = async () =>
    await page.evaluate(() => {
      const address = document.querySelector('[data-dsh-view-address]') as HTMLInputElement | null
      const reading = document.querySelector('[data-dsh-view-reading]')
      const zoom = document.querySelector('[data-dsh-view-zoom]')
      const toolbar = document.querySelector('[data-dsh-view-toolbar]') as HTMLElement | null
      const measured = document.querySelector('[data-dsh-desktop-view-panel]') as HTMLElement | null
      const back = document.querySelector('[data-dsh-view-action="back"]') as HTMLElement | null
      const forward = document.querySelector('[data-dsh-view-action="forward"]') as HTMLElement | null
      /**
       * 工具条里**每一个叶子节点**的文字（票 #20b 要求 3 的那把尺子）。
       *
       * 为什么是叶子：用户自己量那一遍用的就是这个办法（他贴出来的证据就是两行叶子：
       * `BUTTON[data-dsh-view-zoom-menu]` 与 `SPAN[data-dsh-view-reading]`，都写着同一句话）。
       * 数整棵树的 `textContent` 会把每一层祖先都数一遍，那样"出现几次"就没有意义了。
       */
      const leaves: Array<{ tag: string; text: string; action: string | null }> = []
      const mainLeaves: Array<{ tag: string; text: string; action: string | null }> = []
      /**
       * 收一遍叶子节点的文字。
       *
       * @param skipPresets - 展开的档位那一排**不算第一行**：它是一串"可以选哪个"的选项，其中一个
       *   选项的名字本来就叫 `100%`（真浏览器的缩放菜单也这么列）。用户量的是"**第一行**里那句话
       *   出现了几次"，所以两个名单分开收：`leaves` 是整条工具条，`mainLeaves` 是那排选项之外的第一行。
       */
      const collect = (skipPresets: boolean): Array<{ tag: string; text: string; action: string | null }> => {
        const found: Array<{ tag: string; text: string; action: string | null }> = []
        const walk = (node: Element): void => {
          if (skipPresets && node.hasAttribute('data-dsh-view-zoom-presets')) return
          if (node.children.length === 0) {
            found.push({
              tag: node.tagName,
              text: (node.textContent ?? '').trim(),
              action: node.getAttribute('data-dsh-view-action'),
            })
            return
          }
          for (const child of Array.from(node.children)) walk(child)
        }
        if (toolbar !== null) walk(toolbar)
        return found
      }
      if (toolbar !== null) {
        leaves.push(...collect(false))
        mainLeaves.push(...collect(true))
      }
      return {
        address:
          address === null ? null : { value: address.value, title: address.title, placeholder: address.placeholder },
        reading: reading?.getAttribute('data-dsh-view-reading') ?? null,
        readingText: reading?.textContent ?? null,
        diagnostic: reading?.getAttribute('data-dsh-view-diagnostic') ?? null,
        zoomAttribute: zoom?.getAttribute('data-dsh-view-zoom') ?? null,
        toolbarHeight: toolbar === null ? null : Math.round(toolbar.getBoundingClientRect().height),
        /** 工具条那一行的下边缘：被测量的那一块的**上边缘**必须紧贴着它。 */
        toolbarBottom: toolbar === null ? null : Math.round(toolbar.getBoundingClientRect().bottom),
        /** 面板矩形（外壳把原生画面摆在这一块上）的上边缘 —— 几何读回里最要紧的那个数。 */
        measuredTop: measured === null ? null : Math.round(measured.getBoundingClientRect().top),
        declaredHeight: toolbar === null ? null : toolbar.style.height,
        toolbarText: (toolbar?.textContent ?? '').trim(),
        leafTexts: leaves.map((leaf) => leaf.text),
        /** 第一行（不含展开的那排档位选项）的叶子文字 —— 票 #20b 要求 3 数的就是这一份。 */
        mainLeafTexts: mainLeaves.map((leaf) => leaf.text),
        leafTags: leaves.map((leaf) => `${leaf.tag}${leaf.action === null ? '' : `[${leaf.action}]`}=${leaf.text}`),
        autoButtons: document.querySelectorAll('[data-dsh-view-action="auto"]').length,
        readingElements: document.querySelectorAll('[data-dsh-view-reading]').length,
        menuElements: document.querySelectorAll('[data-dsh-view-zoom-menu]').length,
        backTitle: back?.getAttribute('title') ?? null,
        forwardTitle: forward?.getAttribute('title') ?? null,
      }
    })

  /**
   * 只读**几何**：工具条高度、它的下边缘、被测量的那一块的上边缘（票 #20b 要求 2 的读回口）。
   *
   * 刻意不读 `data-dsh-view-zoom-menu` 那个属性：票面明写"断言要读回几何，不是读自己的状态变量"
   * —— 一个"菜单以为自己关了但其实还占着一行"的实现必须在这三个数上露馅。
   */
  const geometry = async (): Promise<{ height: number; bottom: number; measuredTop: number; presets: number }> =>
    await page.evaluate(() => {
      const toolbar = document.querySelector('[data-dsh-view-toolbar]') as HTMLElement | null
      const measured = document.querySelector('[data-dsh-desktop-view-panel]') as HTMLElement | null
      return {
        height: toolbar === null ? -1 : Math.round(toolbar.getBoundingClientRect().height),
        bottom: toolbar === null ? -1 : Math.round(toolbar.getBoundingClientRect().bottom),
        measuredTop: measured === null ? -1 : Math.round(measured.getBoundingClientRect().top),
        presets: document.querySelectorAll('[data-dsh-view-zoom-preset]').length,
      }
    })

  it('A · 地址栏在面板里画出来了，而且框里那串字是**读回来的**地址', async () => {
    const mounted = await mount()
    const seen = await surface()
    console.log('RAW 票 #20 A 的地址栏: ' + JSON.stringify(seen))
    expect(seen.address, '地址栏必须画出来').not.toBeNull()
    // 框里那串字来自外壳那次读回（`url`），不是面板自己编的。
    expect(seen.address?.value).toBe('http://fixture.test/view')
    // 那条补协议的规则写在输入框的 title 上：规则要说得出口，不是让人试出来。
    expect(String(seen.address?.title)).toContain('https://')
    // 这一格向宿主问过状态（面板上的一切都从读回来）。
    expect(mounted.rpcCalls).toContain('desktop-view-state')
  }, 120_000)

  it('A · 输 example.com 回车 ⇒ 发出去的是一条带 url 的 navigate，补的是 https://', async () => {
    const mounted = await mount()
    const typed = await typeInto(page, '[data-dsh-view-address]', 'example.com', 'Enter')
    console.log(
      'RAW 票 #20 A 提交之后: ' +
        JSON.stringify({
          box: typed.value,
          sent: typed.payloads.filter((entry) => entry.endpoint === 'desktop-view-navigate'),
        }),
    )
    const navigate = typed.payloads.filter((entry) => entry.endpoint === 'desktop-view-navigate')
    expect(navigate.length, '回车必须发出一次 navigate').toBe(1)
    // **补协议的规则在这里读回**：发出去的 `url` 就是它对 `example.com` 的答案。
    expect(navigate[0].payload.url).toBe('https://example.com')
    expect(mounted.rpcCalls.length).toBeGreaterThan(0)
  }, 120_000)

  it('A · 非法的输入**说清楚**，而且一个请求都不发（不是悄悄跳去别处）', async () => {
    const mounted = await mount()
    const typed = await typeInto(page, '[data-dsh-view-address]', 'hello world', 'Enter')
    const seen = await surface()
    console.log('RAW 票 #20 A 拒收: ' + JSON.stringify({ calls: typed.calls.length, reading: seen.reading }))
    // 一个 navigate 都没有。
    expect(typed.payloads.filter((entry) => entry.endpoint === 'desktop-view-navigate').length).toBe(0)
    // 而页面上说出了为什么（"网址里不能有空格"）。
    expect(String(seen.reading)).toContain('空格')
    // 空输入也是同一类：说清楚，不发请求。
    await typeInto(page, '[data-dsh-view-address]', '', 'Enter')
    const empty = await surface()
    console.log('RAW 票 #20 A 空输入: ' + JSON.stringify(empty.reading))
    expect(String(empty.reading)).toContain('先输一个网址')
    expect(mounted.rpcPayloads.filter((entry) => entry.endpoint === 'desktop-view-navigate').length).toBe(0)
  }, 120_000)

  it('A · 跳转之后框里的地址跟着页面走：**读回来的**，不是自己记的', async () => {
    // 这一条的关键在"读回来"三个字：让宿主在下一次读回里说**另一个**地址，
    // 而这一次读回不是地址栏发起的（这里按的是「刷新」）。框里必须跟着变。
    await mount({
      rpcValue: { url: 'http://fixture.test/one', title: 'One', zoom: 1, zoomMode: 'auto', ok: true },
      rpcTable: {
        'desktop-view-reload': { url: 'http://fixture.test/two', title: 'Two', zoom: 1, zoomMode: 'auto', ok: true },
      },
    })
    const before = await surface()
    console.log('RAW 票 #20 A 跳转前: ' + JSON.stringify(before.address?.value))
    expect(before.address?.value).toBe('http://fixture.test/one')

    await clickIn(page, '[data-dsh-view-action="reload"]')
    const after = await surface()
    console.log('RAW 票 #20 A 读回之后: ' + JSON.stringify(after.address?.value))
    // 面板自己按的是"刷新"，它**没有**理由知道新地址 —— 这个值是读回来的。
    expect(after.address?.value).toBe('http://fixture.test/two')
  }, 120_000)

  it('C · 用户看得见的那行只有百分比（票 #20b 之后连模式前缀都没有了）；诊断话术还在，只是换了通道', async () => {
    await mount({
      rpcValue: {
        url: 'https://flights.ctrip.com/online/list/oneway',
        title: '航班',
        zoom: 1,
        // **照旧喂一个 `mode` 进去**：外壳仍在发它（旧插件读它，兼容不许破），而面板不许拿它
        // 做任何事 —— 这一条与 `tests/toolbar.spec.ts` 的纯逻辑那半边是同一句话的两处读回。
        zoomMode: 'manual',
        message: 'nothing was changed',
        ok: true,
      },
    })
    const seen = await surface()
    console.log(
      'RAW 票 #20 C 那一行: ' +
        JSON.stringify({ reading: seen.reading, diagnostic: seen.diagnostic, zoom: seen.zoomAttribute }),
    )
    // 票面点名的两句都不许出现在用户可见文本里：
    expect(String(seen.reading)).toBe('100%')
    expect(seen.readingText).not.toContain('nothing was changed')
    // 票 #20b：那句读数里**没有** `手动` / `自动` 前缀（用户要的那一条），
    expect(String(seen.reading)).not.toMatch(/自动|手动/)
    // URL 那半条也缩掉了（它的位置让给了地址栏）。
    expect(seen.readingText).not.toContain('ctrip')
    // 而诊断**没有被删**：它在这两个通道里读得回来。
    expect(String(seen.diagnostic)).toContain('nothing was changed')
    expect(String(seen.diagnostic)).toContain('https://flights.ctrip.com/online/list/oneway')
    // 地址栏里反倒是**有**这个地址的（这就是"位置让给 A"）。
    expect(seen.address?.value).toBe('https://flights.ctrip.com/online/list/oneway')
  }, 120_000)

  it('D · 点百分比给出标准档位；选一个 ⇒ 发出去的是带 zoom 的 zoom-to；菜单**自己收**（几何读回）', async () => {
    await mount()
    const closed = await surface()
    const idle = await geometry()
    console.log('RAW 票 #20 D 菜单关着: ' + JSON.stringify({ height: closed.toolbarHeight, declared: closed.declaredHeight, idle }))

    await clickIn(page, '[data-dsh-view-zoom-menu]')
    const presets = await attributesOf(page, '[data-dsh-view-zoom-preset]', 'data-dsh-view-zoom-preset')
    const currents = await attributesOf(page, '[data-dsh-view-zoom-preset]', 'data-dsh-view-zoom-current')
    console.log(
      'RAW 票 #20 D 档位: ' +
        JSON.stringify({
          presets,
          currents,
          menu: await attributeOf(page, '[data-dsh-view-zoom-menu]', 'data-dsh-view-zoom-menu'),
        }),
    )
    // 票面点名的那 11 个，一个不少，而且顺序就是票面那个顺序。
    expect(presets).toEqual(['50', '67', '75', '80', '90', '100', '110', '125', '150', '175', '200'])
    // 现在的缩放是 100% ⇒ 正好有一档被标成"你在这儿"。
    expect(currents.filter((value) => value === 'yes')).toHaveLength(1)
    expect(currents[presets.indexOf('100')]).toBe('yes')

    // 菜单展开时工具条长高一行，而且**被测量的那一块跟着往下走** —— 于是原生画面不会盖住菜单
    // （浮层一定会被它盖住，因为画面是另一块 OS 级的视图）。两个数都是几何，不是状态变量。
    const open = await surface()
    const opened = await geometry()
    console.log(
      'RAW 票 #20 D 展开之后: ' +
        JSON.stringify({ closed: closed.toolbarHeight, open: open.toolbarHeight, opened, declared: open.declaredHeight }),
    )
    expect(idle.height).toBe(34)
    expect(idle.measuredTop, '空闲时被测量的那一块紧接工具条下面（正好是那一行 34px）').toBe(34)
    expect(open.toolbarHeight).toBeGreaterThan(34)
    expect(open.declaredHeight).toBe('auto')
    expect(opened.measuredTop, '展开的那一行把面板矩形整个推下去').toBe(opened.bottom)
    expect(opened.measuredTop).toBeGreaterThan(34)

    const picked = await clickIn(page, '[data-dsh-view-zoom-preset="125"]')
    const zoomTo = picked.payloads.filter((entry) => entry.endpoint === 'desktop-view-zoom-to')
    const afterPick = await geometry()
    console.log('RAW 票 #20 D 选了 125% 之后: ' + JSON.stringify({ zoomTo, afterPick }))
    expect(zoomTo.length, '选一个档位必须发出一条 zoom-to').toBe(1)
    expect(zoomTo[0].payload.zoom).toBeCloseTo(1.25, 10)
    // **选中一个档位就收**（票 #20b 要求 2 的第一条收法）：读回来的是几何 —— 工具条回到一行，
    // 面板矩形的上边缘回到 34。
    expect(afterPick.height, '选完档位之后工具条必须回到一行').toBe(34)
    expect(afterPick.measuredTop, '选完档位之后面板矩形必须回到那一行下面').toBe(34)
    expect(afterPick.presets, '档位那一排必须真的从页面上消失').toBe(0)
  }, 120_000)

  it('票 #20b 要求 2：空闲**严格一行**，而展开之后点工具条以外 / 按 Esc 都得自己收（读几何）', async () => {
    // 真机上量到的现象（用户那台机器）：工具条高 **61px = 34 + 26**，第二行就是档位。
    // 代码里 `menuOpen` 的初值是 `false`，所以问题不在"默认展开"，而在**展开之后不收**：
    // 点别处不收、Esc 也不收，于是那一行常驻 —— 用户的抱怨"不用去把上面的聊天栏弄乱了"。
    await mount()
    const idle = await geometry()
    console.log('RAW 票 #20b 空闲: ' + JSON.stringify(idle))
    expect(idle.height, '空闲时工具条严格一行').toBe(34)
    expect(idle.measuredTop).toBe(34)
    expect(idle.presets).toBe(0)

    // ── 收法一：点到**工具条以外**（真鼠标事件，落在面板那一块上面） ──
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    const opened = await geometry()
    expect(opened.height).toBeGreaterThan(34)
    expect(opened.measuredTop, '展开的那一行真的把面板矩形推下去了（否则下面那条断言没有意义）').toBeGreaterThan(34)
    await page.mouse.click(220, 300)
    await new Promise((settle) => setTimeout(settle, 300))
    const afterOutside = await geometry()
    console.log('RAW 票 #20b 点工具条以外之后: ' + JSON.stringify(afterOutside))
    expect(afterOutside.height, '点到工具条以外必须自己收（几何）').toBe(34)
    expect(afterOutside.measuredTop, '面板矩形回到那一行下面').toBe(34)
    expect(afterOutside.presets).toBe(0)

    // ── 收法二：`Esc` ──
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    expect((await geometry()).height).toBeGreaterThan(34)
    await page.keyboard.press('Escape')
    await new Promise((settle) => setTimeout(settle, 300))
    const afterEscape = await geometry()
    console.log('RAW 票 #20b 按 Esc 之后: ' + JSON.stringify(afterEscape))
    expect(afterEscape.height, '按 Esc 必须自己收（几何）').toBe(34)
    expect(afterEscape.measuredTop).toBe(34)
    expect(afterEscape.presets).toBe(0)

    // ── 收法三：**再点一次那颗按钮**（它自己就是开关；这一条是前两条的对照，证明"展开"这件事
    //     没被前面两次收法弄坏） ──
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    expect((await geometry()).height).toBeGreaterThan(34)
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    const afterToggle = await geometry()
    console.log('RAW 票 #20b 再点一次那颗按钮: ' + JSON.stringify(afterToggle))
    expect(afterToggle.height).toBe(34)
    expect(afterToggle.measuredTop).toBe(34)

    // ── 而**点在工具条里面**（那排档位自己）不算"点别处"：菜单不许因为按了别处就抖掉。
    //    这一条量的是"判据是**落点**，不是'有没有发生过点击'"。 ──
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    await clickIn(page, '[data-dsh-view-zoom-preset="150"]')
    const afterInside = await geometry()
    console.log('RAW 票 #20b 在工具条里面选了一档: ' + JSON.stringify(afterInside))
    expect(afterInside.height).toBe(34)
  }, 120_000)

  it('票 #20b 要求 3：那句话在工具条**第一行**里只出现一次，而且数的就是文本出现次数', async () => {
    await mount()
    const idle = await surface()
    const sentence = String(idle.reading)
    // 用户自己贴出来的那份证据（票面最后一条评论）：同一句话出现在**两个**叶子上 ——
    // `BUTTON[data-dsh-view-zoom-menu]` 与 `SPAN[data-dsh-view-zoom][data-dsh-view-reading]`。
    // 现在它只许出现在一个叶子上 —— 这里数的是**叶子的文字**，不是任何状态变量。
    const occurrences = idle.mainLeafTexts.filter((text) => text === sentence)
    console.log(
      'RAW 票 #20b 那句话在第一行出现了几次: ' +
        JSON.stringify({
          sentence,
          occurrences: occurrences.length,
          leaves: idle.leafTags,
          toolbarText: idle.toolbarText,
        }),
    )
    expect(sentence, '量具自检：读数必须是一句真话（一个百分比），否则"数 0 次"也会绿').toBe('100%')
    expect(occurrences.length, '那句话在工具条里只许出现一次').toBe(1)
    // 一个元素上同时挂着"读数"与"菜单开关"这两个身份（票面要的是"只出现一次"，不是"再多一颗 ▾"）。
    expect(idle.readingElements, '带 data-dsh-view-reading 的元素只有一个').toBe(1)
    expect(idle.menuElements, '带 data-dsh-view-zoom-menu 的元素只有一个').toBe(1)

    // 整条工具条上**一个模式词都没有**，也没有那颗 `auto` 按钮（票 #20b 要求 1 的 DOM 读回）。
    expect(idle.toolbarText).not.toMatch(/自动|手动|auto/)
    expect(idle.autoButtons).toBe(0)
    // 而工具条第一行上除那句话本身之外，**没有第二个叶子的文字是一个百分比** —— 那一颗标签为
    // `100%` 的重置按钮正是这样第二处（它现在叫 `reset`，动作一个字没少）。
    const percentages = idle.mainLeafTexts.filter((text) => /^\d+(\.\d+)?%$/.test(text))
    console.log('RAW 票 #20b 第一行里像百分比的叶子: ' + JSON.stringify(percentages))
    expect(percentages).toEqual([sentence])

    // 展开档位菜单之后，**第一行**里那句读数还是只有一个。（菜单那一排是"可以选哪个"的选项，
    // 其中一个选项的名字本来就叫 `100%` —— 真浏览器的缩放菜单也这么列；用户量的也是"第一行"。）
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    const opened = await surface()
    const openedMain = opened.mainLeafTexts.filter((text) => text === sentence)
    console.log(
      'RAW 票 #20b 展开之后: ' +
        JSON.stringify({ firstRow: openedMain, wholeToolbar: opened.leafTexts.filter((text) => text === sentence) }),
    )
    expect(openedMain.length, '展开菜单不许让第一行多出第二句读数').toBe(1)
  }, 120_000)

  it('D · 档位之外的值页面上一个都没有（这条通道上没有"缩放到任意值"）', async () => {
    await mount()
    await clickIn(page, '[data-dsh-view-zoom-menu]')
    const labels = await attributesOf(page, '[data-dsh-view-zoom-preset]', 'data-dsh-view-zoom-preset')
    expect(labels).toHaveLength(11)
    expect(labels, '83% 不是档位，页面上不该有它').not.toContain('83')
  }, 120_000)

  it('B · 标签那个座位注册上来了，写的是**页面标题**；读不到时回落"浏览器"', async () => {
    const titled = await mount({
      rpcValue: { url: 'http://fixture.test/view', title: '机票列表 · 携程', zoom: 1, zoomMode: 'auto', ok: true },
      mountTitle: true,
    })
    console.log('RAW 票 #20 B 标签: ' + JSON.stringify({ text: titled.titleText, seats: titled.seats }))
    // 座位**真的注册上了**：没有它，宿主的标签条会一直显示开标签那一刻抓到的那句话。
    expect(titled.seats.title).toBe(true)
    expect(titled.seats.body).toBe(true)
    expect(titled.titleText).toBe('机票列表 · 携程')

    // 读不到标题（空串）⇒ 回落成标签类型自己的名字（语言跟着页面走，与插件的字典同一条规矩）。
    const fallback = await mount({
      rpcValue: { url: 'about:blank', title: '', zoom: 1, zoomMode: 'auto', ok: true },
      mountTitle: true,
    })
    const expectation = await page.evaluate(() =>
      (navigator.language ?? '').slice(0, 2).toLowerCase() === 'zh' ? '浏览器' : 'Browser',
    )
    console.log('RAW 票 #20 B 回落: ' + JSON.stringify({ text: fallback.titleText, expectation }))
    expect(fallback.titleText).toBe(expectation)
  }, 120_000)

  it('F · 页面说它还在加载 ⇒ 读数上出现"加载中"；不加载就不出现', async () => {
    await mount({
      rpcValue: { url: 'http://fixture.test/slow', title: 'Slow', zoom: 1, zoomMode: 'auto', loading: true, ok: true },
    })
    const loading = await surface()
    console.log('RAW 票 #20 F 加载中: ' + JSON.stringify(loading.reading))
    expect(String(loading.reading)).toContain('加载中')

    await mount({
      rpcValue: { url: 'http://fixture.test/done', title: 'Done', zoom: 1, zoomMode: 'auto', loading: false, ok: true },
    })
    const done = await surface()
    expect(String(done.reading)).not.toContain('加载中')
  }, 120_000)

  it('F · 悬停在后退/前进上，提示是**引擎说的**那两页；引擎没说就一个字都不加', async () => {
    await mount({
      rpcValue: {
        url: 'http://fixture.test/two',
        title: 'Two',
        zoom: 1,
        zoomMode: 'auto',
        ok: true,
        canGoBack: true,
        canGoForward: true,
        backTarget: { title: 'One', url: 'http://fixture.test/one' },
        forwardTarget: { title: '', url: 'http://fixture.test/three' },
      },
    })
    const said = await surface()
    console.log('RAW 票 #20 F 悬停: ' + JSON.stringify({ back: said.backTitle, forward: said.forwardTitle }))
    expect(said.backTitle).toBe('后退到 One')
    // 目标页没有标题时用地址（真浏览器也是这么做的）。
    expect(said.forwardTitle).toBe('前进到 http://fixture.test/three')

    // 引擎没答（`backTarget` 缺席）⇒ 退回按钮自己那个词，不给一个空 tooltip。
    await mount({
      rpcValue: { url: 'http://fixture.test/one', title: 'One', zoom: 1, zoomMode: 'auto', ok: true, canGoBack: true },
    })
    const silent = await surface()
    console.log('RAW 票 #20 F 没有目标时: ' + JSON.stringify({ back: silent.backTitle }))
    expect(silent.backTitle).toBe('back')
  }, 120_000)

  it('A+F · 导航还在飞的时候：按钮锁着，读数上有"加载中"；答完才解锁', async () => {
    // 这一条量的是**过程中间**的样子，不是结果：让 navigate 晚 1200ms 再答，
    // 在等待期间读一次 DOM。`navigating` 那条轮询（每 400ms 一次）**不许**把按钮锁解开 ——
    // 那正是 `isEnabled` 里 `busy` 要挡的"两次动作叠在一起"。
    await mount({
      rpcValue: { url: 'http://fixture.test/one', title: 'One', zoom: 1, zoomMode: 'auto', ok: true, canGoBack: true },
      rpcTable: {
        'desktop-view-navigate': {
          __t20DelayMs: 1200,
          url: 'http://fixture.test/two',
          title: 'Two',
          zoom: 1,
          zoomMode: 'auto',
          loading: true,
          ok: true,
          // 答完之后这一格往后有一页（宿主说的），前进那一侧没有。
          canGoBack: true,
          canGoForward: false,
        },
        'desktop-view-state': { url: 'http://fixture.test/one', title: 'One', zoom: 1, zoomMode: 'auto', loading: true, ok: true },
      },
    })
    // 打字与回车，然后**不等它答完**就读。
    const during = await page.evaluate(async () => {
      const input = document.querySelector('[data-dsh-view-address]') as HTMLInputElement
      input.value = 'example.com'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((settle) => setTimeout(settle, 50))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((settle) => setTimeout(settle, 900))
      const button = (action: string): HTMLButtonElement | null =>
        document.querySelector(`[data-dsh-view-action="${action}"]`)
      return {
        reading: document.querySelector('[data-dsh-view-reading]')?.getAttribute('data-dsh-view-reading') ?? null,
        // 票 #20b：`auto` 不在这个表里了（那颗按钮已经删掉）—— 这一条同时钉住"它真的不在页面上"。
        locked: ['back', 'forward', 'reload', 'zoom-in', 'zoom-out', 'zoom-reset', 'restart'].map(
          (action) => button(action)?.disabled ?? null,
        ),
        autoButton: button('auto') === null ? 'absent' : 'present',
      }
    })
    console.log('RAW 票 #20 导航途中的那一格: ' + JSON.stringify(during))
    // 页面自己说它在加载（宿主那次读回里的 `loading`）⇒ 读数上写着"加载中"。
    expect(String(during.reading)).toContain('加载中')
    // 而按钮**一个都不许亮** —— 动作还在飞。
    expect(during.locked).toEqual([true, true, true, true, true, true, true])
    // 那颗 `auto` 按钮确实不在页面上（票 #20b：没有模式可以交还）。
    expect(during.autoButton).toBe('absent')

    // 答完之后锁解开（否则导航一次之后这一格就废了），而两颗历史按钮回到**宿主说的**那样：
    // 后退亮着（它答 `canGoBack: true`）、前进灰着（它答 `canGoForward: false`）。
    await new Promise((settle) => setTimeout(settle, 900))
    const after = await page.evaluate(() =>
      ['back', 'forward', 'reload', 'zoom-in', 'zoom-out', 'zoom-reset', 'restart'].map(
        (action) => (document.querySelector(`[data-dsh-view-action="${action}"]`) as HTMLButtonElement | null)?.disabled ?? null,
      ),
    )
    console.log('RAW 票 #20 答完之后: ' + JSON.stringify(after))
    expect(after).toEqual([false, true, false, false, false, false, false])
  }, 120_000)

  it('工具条整体：地址栏与档位菜单都在**面板**里', async () => {
    const mounted = await mount({ mountTitle: true })
    const inPanel = await page.evaluate(() => ({
      address: document.querySelectorAll('[data-dsh-view-address]').length,
      menu: document.querySelectorAll('[data-dsh-view-zoom-menu]').length,
      toolbar: document.querySelectorAll('[data-dsh-view-toolbar]').length,
      panel: document.querySelectorAll('[data-dsh-desktop-view-panel]').length,
    }))
    console.log('RAW 票 #20 面板这一页上的控件: ' + JSON.stringify(inPanel))
    expect(inPanel).toEqual({ address: 1, menu: 1, toolbar: 1, panel: 1 })
    expect(mounted.seats.title).toBe(true)
  }, 120_000)
})
