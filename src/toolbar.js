/*
 * The panel's toolbar: what it says, and what it renders.
 *
 * It lives beside `client-body.js` and is spliced into the generated `client.js` the same
 * way `shell/panel-rect.js` is (see `scripts/build-client.mjs`), for the same reason: the
 * decisions — which buttons there are, when one is unavailable, and what the status line
 * says — are the part worth pinning down, and they must be reachable without a browser
 * (a plain `require()` of this file in a test) and without a host.
 *
 * It carries **no** copy table and **no** transport. The copy arrives as arguments, because
 * the panel already has that table; the transport is `ctx.connection.rpc`, which only
 * `client-body.js` holds. Keeping both out of here is what lets this file be pure logic.
 */
;(function (root, factory) {
  var api = factory()
  // Both assignments, unconditionally, exactly as `shell/panel-rect.js` does it:
  // the generated bundle needs the global, and a plain `require()` in a test needs the
  // export. The `typeof` guard is only about environments with no `module` at all
  // (a browser page, a worker) — not about choosing between the two.
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
  root.DshViewToolbar = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /**
   * The buttons, in the order a person reads them.
   *
   * `action` is the RPC action name — the same spelling the host's endpoint table uses
   * (`desktop-view-back`, …), so a typo here is a 404 rather than a silently different
   * button. `label` is the glyph a person sees.
   *
   * `shortcut` is the keyboard key, spelled the way `KeyboardEvent.key` reports it, or
   * `null` for a button with none. Keyboard support is not decoration: without arrow-key
   * history a person has to aim at a 24-pixel button, and "go back" is the one thing this
   * toolbar exists for.
   */
  var BUTTONS = [
    { action: 'back', label: '\u2190', title: 'back', shortcut: 'ArrowLeft' },
    { action: 'forward', label: '\u2192', title: 'forward', shortcut: 'ArrowRight' },
    { action: 'reload', label: '\u21bb', title: 'reload', shortcut: 'F5' },
    { action: 'zoom-out', label: '\u2212', title: 'zoom out', shortcut: null },
    { action: 'zoom-reset', label: '100%', title: 'reset the zoom to 100%', shortcut: null },
    { action: 'zoom-in', label: '+', title: 'zoom in', shortcut: null },
    // 票 #19：把这一格**交回自动适配**（按栏宽自己缩放）。
    //
    // 为什么必须有这颗按钮，而不是"换页/重新开始之后自动回来"：换页不丢缩放是 #13 定下的
    // 语义（同源换页、换站点都实测过），而这条语义与"换页就把控制权交回自动"是矛盾的 ——
    // 二者只能留一个，留下的那个是**已经在验收里钉住**的那个。于是回到自动必须是一个
    // **说得出口的动作**，否则手动模式就是一个人进得去出不来的状态。
    { action: 'auto', label: 'auto', title: 'fit the page to the pane (let the pane decide the zoom)', shortcut: null },
    { action: 'restart', label: 'restart', title: 'go back to the page this pane started on', shortcut: null },
  ]

  /** The actions in {@link BUTTONS}, for a caller that needs to check one is real. */
  var ACTIONS = BUTTONS.map(function (button) {
    return button.action
  })

  /**
   * Whether one button should be pressable right now.
   *
   * `back` and `forward` are the only two that can be **known** to be unavailable, and the
   * knowledge is honest about its own limits: it is what this panel has *observed* the view
   * do since it loaded (see `src/navigation.ts`), not what the browser's history really
   * holds. So they go grey when nothing has been seen — and every other button stays live,
   * because "we do not know" must never be rendered as "you cannot". A button that lies in
   * that direction is worse than one that is occasionally too eager: the latter says why
   * when it fails, the former refuses work that would have succeeded.
   *
   * @param {string} action - one of {@link ACTIONS}.
   * @param {{canGoBack: boolean, canGoForward: boolean, busy: boolean, hasShell: boolean}} state
   * @returns {boolean} whether the button is pressable.
   */
  function isEnabled(action, state) {
    if (state.hasShell !== true) return false
    // While one request is in flight every button is off: two overlapping history moves
    // would race, and the panel would then be showing a state neither of them produced.
    if (state.busy === true) return false
    if (action === 'back') return state.canGoBack === true
    if (action === 'forward') return state.canGoForward === true
    return true
  }

  /**
   * The zoom percentage a person reads.
   *
   * A missing or unreadable zoom renders as `—`, not as `100%`: the panel's whole point is
   * that what it shows comes from a read-back, and "the read did not come back" is a
   * different sentence from "the zoom is 100%".
   *
   * @param {unknown} zoom - the read-back zoom, or anything at all.
   * @returns {string} the label.
   */
  function zoomLabel(zoom) {
    if (typeof zoom !== 'number' || !isFinite(zoom)) return '\u2014'
    return Math.round(zoom * 100) + '%'
  }

  /**
   * 面板上那个缩放读数，**带上是哪种模式**（票 #19）。
   *
   * 票面原话是"工具条的读数要说清当前是哪种模式（如 `自动 78%` / `手动 90%`），不许让人看不出来"。
   * 所以这句话有两个来源，而且**两个都不能猜**：
   *
   *  - 数：外壳读回来的 `getZoomFactor()`（读不到就是 `—`，见 {@link zoomLabel}）；
   *  - 词：调用方给的**文案表**（`{auto, manual}`）。这个词表**刻意不在这个文件里** ——
   *    这个文件一行文案都不带（连按钮的 title 都是英文硬编码的既有事实，见文件头），
   *    而"自动/手动"是要给用户看的、要跟着语言走的那两个词，所以它们与别的文案住在一起。
   *
   * 读不到模式时**退回一个光秃秃的百分比**，不编一个前缀：`78%` 说的是"这是 78%"，
   * 而猜出来的 `自动 78%` 说的是"外壳在按栏宽适配它" —— 后者可能不成立，而面板上那句话
   * 一旦不成立，用户就再也分不清"没适配"和"适配了但没动"了。
   *
   * @param {unknown} zoom - 外壳读回来的缩放值。
   * @param {unknown} mode - `auto` / `manual` / 别的什么（读不到就是别的什么）。
   * @param {{auto?: string, manual?: string}} [words] - 那两个词。
   * @returns {string} 要显示的那一句。
   */
  function zoomReading(zoom, mode, words) {
    var percent = zoomLabel(zoom)
    if (percent === '\u2014') return percent
    var table = words !== undefined && words !== null ? words : {}
    if (mode === 'auto' && typeof table.auto === 'string') return table.auto + ' ' + percent
    if (mode === 'manual' && typeof table.manual === 'string') return table.manual + ' ' + percent
    return percent
  }

  /**
   * 那行读数上**该给用户看**的那半句（票 #20 C）。
   *
   * 票面原话：`nothing was changed` 是给开发者看的诊断话术，不该出现在用户眼前；读数只留
   * 用户要的信息。所以这里只有一种情况会说话：**上一次动作没成** —— 那时"为什么没成"
   * 正是用户需要的那句话（"没有可后退的一页"），它也是这行字存在的理由。
   *
   * 成功时这里返回空串，**不是**因为宿主没话说，而是因为宿主那句话是诊断：一次普通状态读回
   * 的 `message`、一次缩放里"布局视口现在是多少 CSS 像素"，都是给读日志的人看的。
   * 它们没有被删掉 —— {@link diagnosticText} 把它们原样留着，面板把它们挂在
   * `title` 与 `data-dsh-view-diagnostic` 上（另一个通道，仍然读得到）。
   *
   * @param {{message: string, ok: boolean|null}} state
   * @returns {string} 要显示的那半句（可能为空串）。
   */
  function statusText(state) {
    if (state.ok !== false) return ''
    var message = state.message === undefined || state.message === '' ? 'the action did not happen' : state.message
    return '\u2717 ' + message
  }

  /**
   * 同一行读数上**给读日志的人看**的那半句（票 #20 C）。
   *
   * 它就是票前那行字原来的内容：宿主那句原话，加上视图现在在哪。票面要求"诊断本身不要删，
   * 只是从用户可见文本里移走"，所以它从这里出去，落到面板元素的 `title`（悬停看得到）与
   * `data-dsh-view-diagnostic`（机器读得到）上。
   *
   * 还没有读到任何东西时给一句"正在读"，而不是空串：空的诊断与"通道坏了"长得一样。
   *
   * @param {{url?: string, message?: string}} state
   * @returns {string} 诊断全文。
   */
  function diagnosticText(state) {
    var parts = []
    if (state.message !== undefined && state.message !== '') parts.push(state.message)
    if (state.url !== undefined && state.url !== '') parts.push(state.url)
    if (parts.length === 0) return 'reading the view\u2026'
    return parts.join(' \u2014 ')
  }

  /**
   * 那行读数整个的样子（票 #20 C 定的形状）：**模式 + 百分比**，必要时再加两样东西。
   *
   *  - 页面还在加载 ⇒ 加一个"加载中"（票 #20 F 的第一条）；
   *  - 上一次动作没成 ⇒ 加那句"为什么"（{@link statusText}）。
   *
   * 三样之间用 ` · ` 连起来。URL **不在**这一行里 —— 它的位置让给了地址栏（票面 C 的原话）。
   *
   * @param {{zoom: unknown, zoomMode: unknown, loading?: unknown, message?: string, ok?: boolean|null}} state
   * @param {{auto?: string, manual?: string, loading?: string}} [words] - 那几个词（住在文案表里）。
   * @returns {string} 要显示的那一行。
   */
  function readingText(state, words) {
    var table = words !== undefined && words !== null ? words : {}
    var parts = [zoomReading(state.zoom, state.zoomMode, table)]
    if (state.loading === true && typeof table.loading === 'string' && table.loading !== '') parts.push(table.loading)
    var note = statusText(state)
    if (note !== '') parts.push(note)
    return parts.join(' \u00b7 ')
  }

  /**
   * 标准缩放档位（票 #20 D）：真浏览器点百分比能选的那些。
   *
   * 单位是**百分比**，因为这就是面板上要显示的东西；{@link zoomPresetFactor} 负责把它换成
   * 会话与外壳用的那个 1 = 100% 的倍数。每一个都必须在 `src/navigation.ts` 的 `ZOOM_STEPS`
   * 里 —— 面板给出的档位与 `−`/`+` 走过的档位必须是同一串数，否则"选 125% 再按一次 +"
   * 会跳到一个谁也没见过的值上。这一条由 `tests/toolbar.spec.ts` 从两侧读回。
   */
  var ZOOM_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]

  /**
   * 一个档位的倍数（100 ⇒ 1）。
   *
   * 不在表里的百分比**不收**：这条通道上没有一个"缩放到任意值"的动作，面板能要的只有这些
   * 档位（`src/view-rpc.ts` 的 `zoom-to`）。
   *
   * @param {unknown} percent - 面板上那个数。
   * @returns {number|null} 倍数，或 null（不是档位）。
   */
  function zoomPresetFactor(percent) {
    if (typeof percent !== 'number' || !isFinite(percent)) return null
    for (var index = 0; index < ZOOM_PRESETS.length; index++) {
      if (ZOOM_PRESETS[index] === percent) return percent / 100
    }
    return null
  }

  /**
   * 现在的缩放在档位表里对应哪一个（用来在菜单里标出"你在这儿"）。
   *
   * 对不上任何一个就返回 `null`：自动适配算出来的 78% 不在档位表里，那时**一个都不标**，
   * 而不是硬说最接近的那个 —— 标错一个档位比不标更坏，因为人会以为自己在那儿。
   *
   * @param {unknown} zoom - 外壳读回来的缩放值。
   * @returns {number|null} 百分比，或 null。
   */
  function currentPreset(zoom) {
    if (typeof zoom !== 'number' || !isFinite(zoom)) return null
    for (var index = 0; index < ZOOM_PRESETS.length; index++) {
      if (Math.abs(ZOOM_PRESETS[index] / 100 - zoom) < 1e-6) return ZOOM_PRESETS[index]
    }
    return null
  }

  /** 带 `//` 的协议：写明了就用它，而且 `//` 后面必须真有主机名。 */
  var AUTHORITY_SCHEMES = ['http://', 'https://']

  /**
   * 不带主机名的地址（或者主机名可以是空的那些）：前缀之后还有东西就接受。
   *
   * `file:///C:/x` 的 `//` 后面直接就是路径，`about:blank` 后面是那一页的名字 —— 两者都不该
   * 被"没有主机名"这条规矩拒掉。
   *
   * 表刻意小：地址栏能去的地方只有这几类 + 上面那两种。`javascript:` / `data:` /
   * `mailto:` / `blob:` 一律**拒**（不是"补个 https 试试"）—— 一条说不清的地址比一句
   * "这个我不开"更容易骗人。
   */
  var OPAQUE_ADDRESSES = ['about:', 'file:']

  /**
   * 回环主机：它们补的是 `http://`，不是 `https://`。
   *
   * 这是那条规则唯一的例外，理由是本项目自己的日常：本机上跑着的东西（夹具站点、开发服务器）
   * 几乎从不带 TLS，而"localhost:3000 被我们悄悄改成 https"会让最常敲的那个地址打不开。
   */
  var LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']

  /**
   * 地址栏里那串字**该变成哪个地址**（票 #20 A）。
   *
   * ## 规则（票面要求"定一条规则并说明"）
   *
   * 1. **写明了协议的**（`http://` / `https://`）或 **`about:` / `file:`** —— 原样用；
   * 2. **只写了主机名的** —— **补 `https://`**（`example.com` ⇒ `https://example.com`）；
   * 3. **唯一的例外：回环主机**（`localhost` / `127.0.0.1` / `[::1]` / `::1` / `0.0.0.0`）
   *    —— 补 `http://`（`localhost:3000` ⇒ `http://localhost:3000`，理由见 {@link LOOPBACK_HOSTS}）；
   * 4. **别的协议一律拒**，而且**说得出是拒**（`reason: 'scheme'`），不是悄悄补一个
   *    `https://` 让引擎去报一个看不懂的错。
   *
   * `host:port` 里的那个冒号**不是协议**：`example.com:8080` 与 `localhost:3000` 都按第 1/3 条
   * 走。判据是"冒号后面到下一个 `/?#` 之前全是数字"——协议名后面不会只有数字。
   *
   * 这个函数**只判断，不联网、不碰页面**：所以"我输的那串字会去哪儿"这件事可以在没有浏览器的
   * 用例里逐条钉住（`tests/toolbar.spec.ts`）。
   *
   * @param {unknown} input - 输入框里那串字。
   * @returns {{ok: true, url: string} | {ok: false, reason: 'empty'|'spaces'|'host'|'scheme'}}
   *   那个地址，或一条说得清的原因（原因是一**个词**，文案住在 `src/client-body.js` 的文案表里）。
   */
  function parseAddress(input) {
    var raw = typeof input === 'string' ? input.trim() : ''
    if (raw === '') return { ok: false, reason: 'empty' }
    // 网址里没有空格。有空格的多半是一句想搜索的话 —— 我们不搜索（本期不做），所以如实说。
    if (/\s/.test(raw)) return { ok: false, reason: 'spaces' }
    var lower = raw.toLowerCase()
    var index
    for (index = 0; index < AUTHORITY_SCHEMES.length; index++) {
      if (lower.indexOf(AUTHORITY_SCHEMES[index]) === 0) {
        return authority(raw) ? { ok: true, url: raw } : { ok: false, reason: 'host' }
      }
    }
    for (index = 0; index < OPAQUE_ADDRESSES.length; index++) {
      if (lower.indexOf(OPAQUE_ADDRESSES[index]) === 0) {
        return lower.length > OPAQUE_ADDRESSES[index].length
          ? { ok: true, url: raw }
          : { ok: false, reason: 'host' }
      }
    }
    // 这里开始：没有协议。先看那个冒号是不是端口号。
    // 以 `[` 开头的是括号里的 IPv6（`[::1]:5173`）—— 里面那些冒号是地址的一部分，不是协议。
    var colon = raw.indexOf(':')
    var slash = raw.search(/[/?#]/)
    var schemeLike = raw.charAt(0) !== '[' && colon > 0 && (slash === -1 || colon < slash)
    if (schemeLike) {
      var after = slash === -1 ? raw.slice(colon + 1) : raw.slice(colon + 1, slash)
      if (!/^[0-9]+$/.test(after)) return { ok: false, reason: 'scheme' }
    }
    var host = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase()
    // 括号里的 IPv6（`[::1]:5173`）里那个冒号是地址的一部分，不是端口分隔符。
    var hostname = host.charAt(0) === '[' ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    var prefix = LOOPBACK_HOSTS.indexOf(hostname) !== -1 ? 'http://' : 'https://'
    var url = prefix + raw
    return authority(url) ? { ok: true, url: url } : { ok: false, reason: 'host' }
  }

  /** `scheme://` 后面到底有没有主机名（`https://` 与 `https:///x` 都没有）。 */
  function authority(url) {
    var after = url.slice(url.indexOf('//') + 2)
    var end = after.search(/[/?#]/)
    var host = end === -1 ? after : after.slice(0, end)
    return host !== ''
  }

  /**
   * 侧边栏那个标签该写什么（票 #20 B）。
   *
   * 页面标题来自**一次独立读回**（宿主问视图那一页），不是面板猜的；读不到（还没读过、
   * 正在换文档、标题是空的）就回落到标签类型自己的名字 —— 一个空标签比"浏览器"更坏，
   * 因为一个空标签看不出那一格里是什么，而"浏览器"至少说出了它是个浏览器。
   *
   * @param {unknown} title - 外壳读回来的那个标题。
   * @param {string} fallback - 读不到时写什么（文案表里那个词）。
   * @returns {string} 标签上那串字。
   */
  function titleForTab(title, fallback) {
    if (typeof title !== 'string') return fallback
    var trimmed = title.trim()
    return trimmed === '' ? fallback : trimmed
  }

  /**
   * 悬停在后退/前进上时那句"会退到哪一页"（票 #20 F 的第二条）。
   *
   * 目标**来自引擎自己的导航历史**（`Page.getNavigationHistory` 里当前索引的前/后一条），
   * 所以它是"那一页是什么"，不是"我们记得那一页是什么"。读不到（引擎答不上来、或者那边
   * 没有一页）就返回 `undefined` —— 那时按钮上**一个字的提示都不给**，而不是给一个空 tooltip：
   * 空的与"这一页没有标题"长得一模一样，而后者会让人以为目标页真的没有标题。
   *
   * 有标题用标题，没有标题用地址（真浏览器也是这么做的：标题拿不到时显示 URL）。
   *
   * @param {{title?: unknown, url?: unknown} | undefined | null} target - 那一页。
   * @param {string} [prefix] - 前缀那个词（住在文案表里；缺省就只给目标本身）。
   * @returns {string|undefined} tooltip 上那句话。
   */
  function travelHint(target, prefix) {
    if (target === undefined || target === null || typeof target !== 'object') return undefined
    var title = typeof target.title === 'string' ? target.title.trim() : ''
    var url = typeof target.url === 'string' ? target.url.trim() : ''
    var label = title !== '' ? title : url
    if (label === '') return undefined
    if (typeof prefix !== 'string' || prefix === '') return label
    return prefix + ' ' + label
  }

  /**
   * Whether a keystroke should be treated as a toolbar shortcut.
   *
   * Two refusals, both load-bearing:
   *
   *  - **a modifier is held** — `Ctrl`/`Cmd`+`ArrowLeft` is the operating system's, and
   *    swallowing it would break a person's own habits;
   *  - **the focus is in a text field** — the panel sits inside the DSH window, so the
   *    caret may well be in the chat box, and stealing `ArrowLeft` from someone editing a
   *    sentence would be a worse bug than having no shortcut at all.
   *
   * @param {{key: string, ctrlKey: boolean, metaKey: boolean, altKey: boolean}} event - the keystroke.
   * @param {boolean} inTextField - whether the focused element takes text input.
   * @returns {string|null} the action to run, or null.
   */
  function actionForKey(event, inTextField) {
    if (inTextField === true) return null
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null
    for (var index = 0; index < BUTTONS.length; index++) {
      if (BUTTONS[index].shortcut !== null && BUTTONS[index].shortcut === event.key) return BUTTONS[index].action
    }
    return null
  }

  /** Height of the toolbar strip, in CSS pixels. The panel keeps the rest. */
  var TOOLBAR_HEIGHT_PX = 34

  return {
    BUTTONS: BUTTONS,
    ACTIONS: ACTIONS,
    TOOLBAR_HEIGHT_PX: TOOLBAR_HEIGHT_PX,
    ZOOM_PRESETS: ZOOM_PRESETS,
    isEnabled: isEnabled,
    zoomLabel: zoomLabel,
    zoomReading: zoomReading,
    zoomPresetFactor: zoomPresetFactor,
    currentPreset: currentPreset,
    parseAddress: parseAddress,
    statusText: statusText,
    diagnosticText: diagnosticText,
    readingText: readingText,
    titleForTab: titleForTab,
    travelHint: travelHint,
    actionForKey: actionForKey,
  }
})
