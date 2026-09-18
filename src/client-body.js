/*
 * Registration body of the plugin's client half — spliced below the shared panel
 * measurement into the generated `client.js`. It is not shipped as a file of its
 * own and is not compiled by `tsc`; see `scripts/build-client.mjs`.
 *
 * `DshPanelRect` comes from the splice: `shell/panel-rect.js` runs first in the same
 * factory and installs itself on the page global. Naming it here makes the
 * dependency between the two regions explicit instead of accidental.
 */
var DshPanelRect = globalThis.DshPanelRect

/**
 * The toolbar's own decisions — which buttons there are, when one is unavailable, what the
 * status line says. Spliced from `src/toolbar.js`, and readable in a plain test too.
 */
var DshViewToolbar = globalThis.DshViewToolbar

/**
 * @typedef {object} PanelRectApi
 * @property {(rect: {x: number, y: number, width: number, height: number} | null) => void} setRect
 */

/**
 * The tab type's identity in the tab system. A package name is the natural value:
 * it is the key the body registers under in the `sidebar.right.pane.tab` seat.
 */
var TYPE_ID = 'dsh-desktop-view'

/**
 * Type discriminator. `openTab('desktop-view')` opens this type; a page type
 * declares no `patterns`, so it claims no resource address.
 */
var TYPE_KIND = 'desktop-view'

/** Copy namespace key: the tab title is read fresh on every use, so a language change needs no re-registration. */
var NS = 'desktopView'

/** Title of the tab chip in both shipped languages. */
var DICTIONARIES = {
  zh: {
    'type.label': '浏览器',
    'guide.title': '浏览器',
    'guide.description': '把侧边栏这一格交给原生浏览器视图',
  },
  en: {
    'type.label': 'Browser',
    'guide.title': 'Browser',
    'guide.description': 'Hand this sidebar pane to the native browser view',
  },
}

/**
 * Panel copy, also in both languages. Not part of the locale namespace: the panel must render before it can translate.
 *
 * `noShell` is the one message a person can only ever see *without* the shell — which is
 * exactly why it has to be complete on its own. "This pane needs the desktop shell" names
 * the problem; on its own it leaves the reader with nowhere to go, so the sentence
 * continues with the way out (the command that starts the shell, which is the only
 * thing that can put a browser in this pane). A notice that states a fact and no action
 * is a slightly louder silent failure.
 */
var COPY = {
  zh: {
    noShell:
      '这一格需要桌面外壳才能显示浏览器。外壳是本仓库自带的 Electron 应用：' +
      '在仓库里运行 npm run shell 起它，这一格就会显示真正的浏览器视图；' +
      '普通浏览器标签页里它没有东西可显示。',
    ready: '桌面外壳已就位：这一格交给原生浏览器视图。',
    missing: '这一格没有量到矩形（可能被折叠或切走了）。',
    // 票 #20b：票 #19 加在这里的 `zoomAuto` / `zoomManual` 两个词**被删掉了**。
    // 读数上不再有模式前缀（适配永远开着，那个前缀只会是一句废话），所以那两个词没有任何使用者；
    // 留在文案表里只会让下一个人以为"面板还会说出它们"。
    // 票 #20 A：地址栏。
    //
    // `addressHelp` 是那条**补协议**的规则本身，写在输入框的 title 上：规则要说得出口，
    // 而不是让人试出来（票面原话："定一条规则并说明"）。它与 `src/toolbar.js` 的
    // `parseAddress` 是同一句话的两种写法，所以两者挨着改。
    addressPlaceholder: '输入网址，回车打开',
    addressHelp: '只写主机名时补 https://（例：example.com → https://example.com）；本机地址补 http://（例：localhost:3000）；也可以直接写 http:// / https:// / file:// / about:',
    addressSend: '打开',
    addressEmpty: '先输一个网址。',
    addressSpaces: '网址里不能有空格 —— 这一格不会把一句话变成搜索。',
    addressHost: '这个地址里没有主机名。',
    addressScheme: '这一格只开 http / https / file / about 开头的地址。',
    // 票 #20 D：档位菜单。
    zoomMenuTitle: '选一个标准档位',
    // 票 #20 F 的第一条：页面还在加载。
    loading: '加载中',
    // 票 #20 F 的第二条：悬停在后退/前进上时那个"会去哪一页"。
    backTo: '后退到',
    forwardTo: '前进到',
  },
  en: {
    noShell:
      'This pane needs the desktop shell to show the browser. The shell is the Electron app that ships ' +
      'in this repository: run npm run shell there and this pane shows the real browser view. A plain ' +
      'browser tab has nothing to put here.',
    ready: 'The desktop shell is here: the native browser view takes this pane.',
    missing: 'This pane reports no rectangle (collapsed or switched away).',
    // 票 #20b：票 #19 的 `auto` / `manual` 两个词随模式一起删掉（见上面 zh 那一段的说明）。
    addressPlaceholder: 'Type an address, press Enter',
    addressHelp: 'A bare host gets https:// (example.com → https://example.com); a loopback host gets http:// (localhost:3000); http://, https://, file:// and about: are used as typed.',
    addressSend: 'open',
    addressEmpty: 'Type an address first.',
    addressSpaces: 'An address cannot contain spaces — this pane does not turn a sentence into a search.',
    addressHost: 'That address has no host name.',
    addressScheme: 'This pane opens http, https, file and about addresses only.',
    zoomMenuTitle: 'pick a standard zoom step',
    loading: 'loading',
    backTo: 'back to',
    forwardTo: 'forward to',
  },
}

/** 提交地址被拒时那几个原因码（`src/toolbar.js` 的 `parseAddress`）对应的句子。 */
var ADDRESS_REASONS = {
  empty: 'addressEmpty',
  spaces: 'addressSpaces',
  host: 'addressHost',
  scheme: 'addressScheme',
}

/**
 * 把 `parseAddress` 给的原因码翻成一句人话。
 *
 * 认不出来的原因码**照样说点什么**（`addressScheme` 那句"只开这几种"是最接近事实的兜底），
 * 而不是把 `undefined` 显示到用户眼前：一条说不清的拒绝比一句略宽的说明更让人无从下手。
 *
 * @param {string} reason - 原因码。
 * @returns {string} 那句话。
 */
function addressErrorText(reason) {
  var key = ADDRESS_REASONS[reason];
  var table = copy();
  var sentence = key === undefined ? undefined : table[key];
  return typeof sentence === 'string' ? sentence : table.addressScheme;
}

/** @returns {string} the two-letter language code to copy in. */
function language() {
  var raw = typeof navigator !== 'undefined' && navigator !== null ? navigator.language : ''
  return typeof raw === 'string' && raw.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en'
}

/** @returns {object} the copy table for the current language. */
function copy() {
  var table = COPY[language()]
  return table !== undefined ? table : COPY.en
}

/**
 * `ctx.locale.bind(NS)` 出来的那个翻译函数（票 #20 B）。
 *
 * 标签标题的回落词住在**类型自己的字典**里（`DICTIONARIES` 的 `type.label`，与
 * `apply()` 里注册给宿主的那句 `title()` 是同一个词），**不是**面板那份文案表 ——
 * 后者是给那一格内部用的，里面没有 `type.label`。第一版把它读成了 `copy()['type.label']`，
 * 于是回落拿到 `undefined`：页面标题读得到时看不出问题，读不到时标签就**空了**
 * （`tests/toolbar-panel.spec.ts` 的 B 那一条抓到的就是这个）。
 */
var localeText = null

/**
 * 读不到页面标题时标签上写什么。
 *
 * @returns {string} 那个词（"浏览器" / "Browser"）。
 */
function tabTitleFallback() {
  if (localeText !== null) return localeText('type.label')
  var table = DICTIONARIES[language()]
  return (table !== undefined ? table : DICTIONARIES.en)['type.label']
}

/**
 * 栏宽变化之后，工具条那个读数最多隔多久重读一次（票 #19）。
 *
 * 为什么要有这一条：自动适配是**外壳**按新栏宽改的缩放，而面板上那个数只在"按下某个按钮"
 * 或"页面刚打开"时读过。拖动侧边栏之后不重读的话，画面已经 52% 了，读数还写着 `自动 100%`
 * —— 那正是票面说的"不许让人看不出来"的反面。
 *
 * 为什么要节流：拖动时面板每一帧都上报一次几何，而每一次重读都要走宿主一个来回
 * （HTTP + 一次页面读回），400ms 一次既跟得上手，又不会把宿主刷满。
 */
var PANEL_REFRESH_MIN_MS = 400

/**
 * The client context, kept where the toolbar can reach it.
 *
 * It is set once by {@link apply} and read by the strip on render. A module-scoped variable
 * rather than a prop because the tab body is registered as a component *before* `apply` has
 * anything to pass it, and threading `ctx` through the product's slot props is not something
 * this plugin gets to do.
 */
var clientContext = null

/**
 * The channel the panel's buttons call, and the endpoints on it.
 *
 * It is the shared `/api` channel (ADR-0003's carrier-neutral RPC, reached through
 * `ctx.connection.rpc.call`), and the endpoint names carry this plugin's namespace so they
 * cannot collide with the product's own (`credentials/*`, `session/*`). Both halves of the
 * names live in `src/view-rpc.ts`; this is the client half of that one contract.
 */
var RPC_CHANNEL = '/api'

/** The endpoint a given action is called on: `desktop-view-back`, `desktop-view-state`, … */
function endpointFor(action) {
  return 'desktop-view-' + action
}

/**
 * One button press: ask the host to do it, and hand back the state it read afterwards.
 *
 * Every failure is turned into a value rather than thrown onwards, because the toolbar has
 * exactly one place to show an outcome (the status line) and a rejected promise there would
 * leave the line showing the *previous* action's result — a toolbar that reports the wrong
 * thing is worse than one that reports nothing.
 *
 * @param {object} ctx - the plugin context, carrying `connection`.
 * @param {string} action - the action name.
 * @param {{url?: string, zoom?: number}} [extra] - 那两条带参数的动作的参数（票 #20）。
 *   地址栏与档位菜单各用其中一个；别的动作一个都不带（宿主那边也只认这两个动作带参数）。
 * @returns {Promise<{ok: boolean, url: string, zoom: unknown, canGoBack: boolean,
 *   canGoForward: boolean, message: string}>} the host's answer, or a local failure value.
 */
async function callView(ctx, action, extra) {
  try {
    var payload = Object.assign({ nonce: String(Date.now()) }, extra !== undefined ? extra : {})
    var answer = await ctx.connection.rpc.call(RPC_CHANNEL, endpointFor(action), payload)
    if (answer === null || answer === undefined || answer.ok !== true) {
      var failure = answer !== null && answer !== undefined && answer.error !== undefined ? answer.error : undefined
      return {
        ok: false,
        url: '',
        zoom: undefined,
        canGoBack: false,
        canGoForward: false,
        message:
          failure !== undefined && typeof failure.message === 'string'
            ? failure.message
            : 'the desktop shell did not answer (it may not be running, or the view is gone)',
      }
    }
    return answer.value
  } catch (error) {
    return {
      ok: false,
      url: '',
      zoom: undefined,
      canGoBack: false,
      canGoForward: false,
      message:
        'this pane could not reach the shell: ' +
        (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)),
    }
  }
}

/**
 * 页面标题那一份**共享读数**（票 #20 B）。
 *
 * ## 为什么是一份共享的东西
 *
 * 侧边栏那个标签（`sidebar.right.pane.tab.title` 座位）与面板工具条是**两个**组件：宿主分别
 * 渲染它们，它们之间没有 props 通道。而它们要说的是同一件事 —— "这一格里现在是哪一页"。
 * 所以读回来的那一份只有一个地方放（这个模块作用域的对象），两边都从它读：
 * 工具条每次读回都往里写，标签订阅它。
 *
 * ## 为什么要有个心跳
 *
 * 标签要跟着页面走，而页面**不必**经过这个面板才会换（Agent 走的是另一条路：它直接驱动
 * 同一个视图）。所以只要标签还在屏幕上，就每隔 {@link TITLE_WATCH_MS} 问一次"现在是什么标题"。
 * 心跳**只在有标签订阅时**跑：没人看那个标签的时候，一次多余的读回都不发。
 *
 * 读回来的东西原样存着；拿不到就存空串，由 {@link DshViewToolbar.titleForTab} 回落到
 * 标签类型自己的名字（"浏览器"）—— 回落发生在显示的那一刻，不是一个存下来的默认值。
 */
var pageTitle = {
  /** 最近一次从视图读回来的标题；没读过就是空串。 */
  value: '',
  /** 订阅者（标签组件）。 */
  listeners: [],
  /** 心跳的定时器句柄；0 = 没在跑。 */
  timer: 0,
  /** 心跳要用的上下文（`apply` 时给的）。 */
  ctx: null,
}

/** 标签每次问一次"现在标题是什么"的间隔。2 秒：跟得上换页，又不至于把宿主刷满。 */
var TITLE_WATCH_MS = 2000

/**
 * 记下一次读回来的标题，并告诉所有订阅者。
 *
 * @param {unknown} title - 外壳读回来的标题。
 * @returns {void}
 */
function rememberPageTitle(title) {
  var next = typeof title === 'string' ? title : ''
  if (next === pageTitle.value) return
  pageTitle.value = next
  for (var index = 0; index < pageTitle.listeners.length; index++) pageTitle.listeners[index](next)
}

/**
 * 订阅标题的变化。
 *
 * @param {(title: string) => void} listener - 新标题来了叫它。
 * @returns {() => void} 退订。
 */
function subscribePageTitle(listener) {
  pageTitle.listeners.push(listener)
  return function () {
    var at = pageTitle.listeners.indexOf(listener)
    if (at !== -1) pageTitle.listeners.splice(at, 1)
  }
}

/** 有标签在看的时候才开心跳（见 {@link pageTitle} 的说明）。 */
function startPageTitleWatch(ctx) {
  pageTitle.ctx = ctx
  if (pageTitle.timer !== 0) return
  pageTitle.timer = setInterval(function () {
    if (pageTitle.ctx === null) return
    void callView(pageTitle.ctx, 'state').then(function (next) {
      if (next.ok === true) rememberPageTitle(next.title)
    })
  }, TITLE_WATCH_MS)
}

/** 没有标签在看了：心跳停掉，一次多余的读回都不发。 */
function stopPageTitleWatch() {
  if (pageTitle.listeners.length > 0) return
  if (pageTitle.timer !== 0) clearInterval(pageTitle.timer)
  pageTitle.timer = 0
  pageTitle.ctx = null
}

/**
 * The toolbar strip above the browser view.
 *
 * It is **in the panel, not in the view**: the native view parks on the rectangle this
 * panel reports, and the panel is a page in the shell's own window, so nothing drawn here
 * can reach the page the agent snapshots (a test pins that with "the view's snapshot is
 * unchanged while the toolbar exists").
 *
 * The strip takes its height off the top and reports the remaining rectangle, so the view
 * is not covered by its own controls. It also **loses the race on purpose** where it should:
 * the status line is the only thing it says, and it says it from the host's read-back.
 *
 * @param {{ctx: object, hasShell: boolean, geometryTick?: number}} props - the plugin context, whether
 *   the shell is here, and a counter that goes up whenever the pane's own rectangle changed.
 * @returns {import('react').ReactElement} the toolbar element.
 */
function Toolbar(props) {
  var react = require('react')
  var toolbar = DshViewToolbar
  var [state, setState] = react.useState({
    ok: null,
    url: '',
    zoom: undefined,
    loading: undefined,
    canGoBack: false,
    canGoForward: false,
    backTarget: undefined,
    forwardTarget: undefined,
    message: '',
    busy: false,
    /** 票 #20 F：面板刚请求了一次导航，还没听到回答 —— "加载中"的第一半。 */
    navigating: false,
  })
  /**
   * 输入框里那串字（票 #20 A）。
   *
   * 它与 `state.url` 是**两样东西**，而且必须分开：`state.url` 是"视图现在在哪"（读回来的
   * 事实），这里是"框里显示着什么"。用户正在打字的时候，一次读回把他打的字冲掉是最讨厌的
   * 那种 bug；而用户没在打字的时候，框里必须跟着页面走 —— 票面原话："跳转后框里的地址要
   * 跟着页面走（读回来，不是自己记）"。
   */
  var [address, setAddress] = react.useState('')
  /** 上一次提交被拒的那句话。空串 = 没有出错。 */
  var [addressError, setAddressError] = react.useState('')
  /** 档位菜单开着没有（票 #20 D）。它**必须自己会收**（票 #20b 的要求 2，见下面那个 effect）。 */
  var [menuOpen, setMenuOpen] = react.useState(false)
  /** 光标在地址栏里吗（决定读回要不要覆盖框里的字）。 */
  var editing = react.useRef(false)
  /**
   * 工具条那一行本身（票 #20b 的要求 2）。
   *
   * 它只有一个用途：回答"这一下按在工具条**里面**还是**外面**"。菜单展开之后必须有办法自己收
   * 回去，而"点到别处"要判的就是这件事 —— 没有这个引用就只能靠"再点一次那颗按钮"，那正是
   * 用户遇到的那个"卡在展开状态"。
   */
  var toolbarRef = react.useRef(null)

  /**
   * 把一次回答落到面板上 —— **所有**读回都从这里进。
   *
   * 三件事必须一起做，散在各处就会有两处不一致：
   *  1. 状态合并（失败的回答没有读回任何东西，不许把上一次读到的地址与缩放宽抹成空白）；
   *  2. 页面标题进共享读数（票 #20 B 的标签要它）；
   *  3. 地址栏跟着页面走（除非用户正在打字）。
   *
   * @param {object} next - 外壳答的那一份（或本地造的那份失败值）。
   * @param {{keepAddress?: boolean, quiet?: boolean}} [options] - `keepAddress`：这一按被拒了，
   *   框里留着用户打的字；`quiet`：这只是一次**顺手读回来的**（导航途中的轮询），
   *   **不是**某一次动作的回答 —— 那么它不许解开那把按钮锁（见下面那段）。
   */
  var applyAnswer = react.useCallback(function (next, options) {
    var settings = options !== undefined ? options : {}
    var keep = settings.keepAddress === true
    var quiet = settings.quiet === true
    setState(function (previous) {
      var merged = Object.assign({}, previous, next)
      // 只有**动作的回答**才解开"忙"与"导航中"这两把锁。顺手读回来的那份读数解开它们，
      // 就等于"导航还在飞的时候按钮又亮了" —— 那正是 `isEnabled` 里 `busy` 要挡的那种
      // 两次动作叠在一起（票 #20 写 F 那条轮询时踩到的）。
      if (quiet !== true) {
        merged.busy = false
        merged.navigating = false
      }
      if (next.ok === false && (next.url === '' || next.url === undefined)) {
        // 一次失败的调用**没有读回任何东西**："读不到"不等于"地址是空的、缩放是未知的"。
        merged.url = previous.url
        merged.zoom = previous.zoom
        merged.loading = previous.loading
        merged.backTarget = previous.backTarget
        merged.forwardTarget = previous.forwardTarget
      }
      return merged
    })
    rememberPageTitle(next.title)
    // 一次**成功**的读回把上一次"地址被拒"那句话收掉：那句话说的是那一按，不是永久状态。
    if (next.ok === true) setAddressError('')
    if (keep !== true && editing.current !== true && typeof next.url === 'string' && next.url !== '') {
      setAddress(next.url)
    }
  }, [])

  /**
   * 读一次"外壳现在说什么"，并把结果落到那一行上。
   *
   * @param {{quiet?: boolean}} [options] - `quiet` 见 {@link applyAnswer}（导航途中的轮询用它）。
   */
  var refresh = react.useCallback(function (options) {
    var settings = options !== undefined ? options : {}
    void callView(props.ctx, 'state').then(function (next) {
      applyAnswer(next, { quiet: settings.quiet === true })
    })
  }, [])

  /**
   * Run one action, then show what the host read back **after** it.
   *
   * The read-back is the point: the host answers with the post-action state, so the zoom
   * label and the two history buttons come from the view rather than from a local guess
   * that could drift the moment anything else drives the view (the agent does).
   *
   * @param {string} action - 动作名。
   * @param {{payload?: object, navigating?: boolean, keepAddress?: boolean}} [options]
   *   `payload` 是那两条带参数的动作的参数；`navigating` = 这是一次导航（面板要显示"加载中"）；
   *   `keepAddress` = 这一按被拒时框里留着用户打的字。
   */
  var run = react.useCallback(function (action, options) {
    var settings = options !== undefined ? options : {}
    setState(function (previous) {
      return Object.assign({}, previous, { busy: true, navigating: settings.navigating === true })
    })
    void callView(props.ctx, action, settings.payload).then(function (next) {
      applyAnswer(next, { keepAddress: settings.keepAddress === true })
    })
  }, [])

  /**
   * 地址栏回车（票 #20 A）。
   *
   * **规范化在提交的那一刻做，不在打字的时候做**：一边打字一边往框里补 `https://` 会让人
   * 没法输入（补上去的那几个字符会跟着光标跑）。规则本身是纯判断，住在 `src/toolbar.js`；
   * 这里只负责把它的拒绝显示出来。
   */
  var submitAddress = react.useCallback(function () {
    var parsed = toolbar.parseAddress(address)
    if (parsed.ok !== true) {
      setAddressError(addressErrorText(parsed.reason))
      return
    }
    setAddressError('')
    setAddress(parsed.url)
    run('navigate', { payload: { url: parsed.url }, navigating: true, keepAddress: true })
  }, [address])

  // The first read happens once the strip is on screen. It is deliberately not part of a
  // render: a render that started a request would start one per re-render.
  react.useEffect(function () {
    refresh()
  }, [])

  /**
   * 导航在飞的时候，隔一会儿问一次"那一页自己说它还在加载吗"（票 #20 F 的第一条）。
   *
   * 为什么不能只靠"请求还没回来"：那说的是**面板**在等，不是**页面**在加载。而页面自己
   * 会用 `document.readyState` 回答这件事（宿主那次读回里带着 `loading`）。所以这里一边等
   * 回答、一边把页面自己的读数刷新过来 —— 提示说的因此是页面的事实，不是面板的心情。
   *
   * 间隔与 {@link PANEL_REFRESH_MIN_MS} 同源：既不把宿主刷满，又跟得上一次换页。
   */
  react.useEffect(
    function () {
      if (state.navigating !== true) return undefined
      var timer = setInterval(function () {
        // `quiet`：这一读**不解锁**（见 `applyAnswer`）—— 导航还在飞的时候按钮必须一直是灰的。
        refresh({ quiet: true })
      }, PANEL_REFRESH_MIN_MS)
      return function () {
        clearInterval(timer)
      }
    },
    [state.navigating],
  )

  /**
   * 栏宽变了 ⇒ 那个读数要重读（票 #19）。
   *
   * 这一格自己**知道**栏宽什么时候变：面板矩形一变就上报一次，而外壳正是拿那个矩形决定
   * 视图多大、并（在自动模式下）按新宽度重新适配页面。所以几何一动就要问一次
   * "现在是多少、谁在管"，否则读数会停在上一次按下的那个数上。
   *
   * 节流到 {@link PANEL_REFRESH_MIN_MS}，并且**补最后一次**：拖动中间隔多久都行，
   * 但停下来之后那一次必须发出去 —— 那才是最终状态。
   */
  var lastReadAt = react.useRef(0)
  var pendingRead = react.useRef(0)
  react.useEffect(
    function () {
      if (props.geometryTick === undefined || props.geometryTick === 0) return
      var since = Date.now() - lastReadAt.current
      if (since >= PANEL_REFRESH_MIN_MS) {
        lastReadAt.current = Date.now()
        refresh()
        return
      }
      if (pendingRead.current !== 0) return
      pendingRead.current = setTimeout(function () {
        pendingRead.current = 0
        lastReadAt.current = Date.now()
        refresh()
      }, PANEL_REFRESH_MIN_MS - since)
    },
    [props.geometryTick],
  )

  // 面板走了就把排着的那次读撤掉：一个卸载之后再打出去的请求只会写到一个已经不存在的状态上。
  react.useEffect(function () {
    return function () {
      if (pendingRead.current !== 0) clearTimeout(pendingRead.current)
      pendingRead.current = 0
    }
  }, [])

  // Keyboard shortcuts. Registered on the window because the panel is one element among
  // many in the DSH window and a person's hands are usually in the chat box.
  react.useEffect(function () {
    function onKeyDown(event) {
      var target = event.target
      var inTextField =
        target !== null &&
        target !== undefined &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)
      var action = toolbar.actionForKey(event, inTextField)
      if (action === null) return
      event.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return function () {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  /**
   * 档位菜单**展开之后自己会收**（票 #20b 的要求 2）。
   *
   * ## 为什么这一条是必须的，而不是"顺手加一下"
   *
   * 真机上量到过：用户那一格工具条高 **61px = 34 + 26**，第二行就是那排档位 —— 代码里
   * `menuOpen` 的初值是 `false`，所以问题不在"默认展开"，而在**展开之后不收**：点别处不收、
   * `Esc` 不收，菜单于是一直挂在那里，工具条永远是两行。用户的抱怨原文是"不用去把上面的聊天栏
   * 弄乱了"，而"弄乱"的机制正是这多出来的一行 —— 它把被测量的那一块往下推，原生画面跟着让位。
   *
   * ## 三条收法，各自走一条**道理上不同**的路
   *
   *  - **选了一个档位**：那颗档位按钮自己的 `onClick` 就收了（它紧接着要发一条 zoom-to）；
   *  - **点到工具条以外**：`pointerdown`（捕获阶段）。用捕获而不是冒泡，是因为"点别处"这件事
   *    不该取决于那一页上有没有人 `stopPropagation`；判据是"落点不在 {@link toolbarRef} 里"。
   *    **量出来的一个边界**：原生画面是另一块 `WebContentsView`，点在它上面的那一下**到不了**
   *    这个页面（见报告里的诚实清单）—— 所以这里收的是"点 DSH 界面别处"，不是"点网页里"。
   *  - **`Esc`**：与真浏览器的菜单同一条习惯。它同时 `preventDefault` + `stopPropagation`：
   *    一次按键只该有一个效果，而菜单开着的时候，用户的意思显然是"把菜单收掉"。
   *
   * 两个听众**只在开着的时候挂着**（`[menuOpen]` 的依赖就是这件事），关着的时候页面上一个多余
   * 的监听器都没有 —— 这个面板住在 DSH 的窗口里，它不该替整窗口的每一次点击接手。
   */
  react.useEffect(
    function () {
      if (menuOpen !== true) return undefined
      function onPointerDown(event) {
        var root = toolbarRef.current
        var target = event.target
        if (root !== null && root !== undefined && target !== null && target !== undefined && root.contains(target)) return
        setMenuOpen(false)
      }
      function onKeyDown(event) {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        setMenuOpen(false)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      return function () {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
      }
    },
    [menuOpen],
  )

  var words = copy()
  var children = []
  for (var index = 0; index < toolbar.BUTTONS.length; index++) {
    var button = toolbar.BUTTONS[index]
    var enabled = toolbar.isEnabled(button.action, {
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      busy: state.busy,
      hasShell: props.hasShell,
    })
    // 票 #20 F 的第二条：悬停在后退/前进上要能看出"会退到哪一页"。
    // 目标来自**引擎自己的导航历史**（宿主那次读回里的 `backTarget` / `forwardTarget`），
    // 读不到时 `travelHint` 返回 undefined ⇒ tooltip 退回按钮自己那个词（"back"），
    // 而不是给一个空 tooltip 假装知道。
    var travel =
      button.action === 'back'
        ? toolbar.travelHint(state.backTarget, words.backTo)
        : button.action === 'forward'
          ? toolbar.travelHint(state.forwardTarget, words.forwardTo)
          : undefined
    children.push(
      react.createElement(
        'button',
        {
          key: button.action,
          type: 'button',
          'data-dsh-view-action': button.action,
          title: travel !== undefined ? travel : button.title,
          disabled: !enabled,
          onClick: (function (action) {
            return function () {
              run(action)
            }
          })(button.action),
          style: {
            font: '12px/1 system-ui',
            minWidth: '24px',
            height: '22px',
            padding: '0 6px',
            border: '1px solid var(--dsh-color-border, #d0d7de)',
            borderRadius: '4px',
            background: 'var(--dsh-color-surface, #fff)',
            color: 'inherit',
            cursor: enabled ? 'pointer' : 'not-allowed',
            opacity: enabled ? 1 : 0.45,
            flex: '0 0 auto',
          },
        },
        button.label,
      ),
    )
  }

  /**
   * 地址栏（票 #20 A）。
   *
   * 它在**面板里**（不在被驱动的那一页），所以它不可能进快照 —— `tests/panel-toolbar.spec.ts`
   * 有一条"工具条存在时视图快照逐项不变"的断言从视图那一侧读回这件事。而它驱动视图走的仍然是
   * **既有的那条 RPC**（`desktop-view-navigate`），`shell/preload.js` 那条"除矩形外什么都不许
   * 过境"的边界一个字节都没动：这条输入框够不到 Electron，也够不到视图。
   */
  var addressField = react.createElement('input', {
    key: 'address',
    type: 'text',
    'data-dsh-view-address': 'ready',
    value: address,
    placeholder: words.addressPlaceholder,
    title: words.addressHelp,
    spellCheck: false,
    autoComplete: 'off',
    disabled: props.hasShell !== true,
    onInput: function (event) {
      setAddress(event.target.value)
      setAddressError('')
    },
    onFocus: function () {
      editing.current = true
    },
    onBlur: function () {
      editing.current = false
      // 松手之后框里回到"页面现在在哪"（用户打了一半又走开时，框里不该留着一段没人要的字）。
      setAddress(state.url)
      setAddressError('')
    },
    onKeyDown: function (event) {
      if (event.key !== 'Enter') return
      event.preventDefault()
      submitAddress()
    },
    style: {
      flex: '1 1 60px',
      minWidth: '60px',
      height: '22px',
      padding: '0 6px',
      boxSizing: 'border-box',
      font: '12px/1 system-ui',
      border: '1px solid ' + (addressError === '' ? 'var(--dsh-color-border, #d0d7de)' : 'var(--dsh-color-danger, #b42318)'),
      borderRadius: '4px',
      background: 'var(--dsh-color-surface, #fff)',
      color: 'inherit',
      textOverflow: 'ellipsis',
    },
  })

  // 票 #19 + #20 C + #20b：读数只留用户要的那一个数（**百分比**），必要时加"加载中"（F）与
  // "为什么这一按没成"。宿主那些诊断话术一个字都没删 —— 它们在同一次渲染的
  // `data-dsh-view-diagnostic` 与 tooltip 上（另一个通道，仍然读得到）。
  //
  // 票 #20b 删掉了这里的两个词（`auto` / `manual`）：适配永远开着，"谁在管这个缩放"不再是一个
  // 会变的事实，前缀只会是一句废话。外壳**仍然在发布** `zoomMode`（旧插件在读它），
  // 但面板这一侧连读都不读它了 —— 它甚至不进 `state`（见上面那份初值）。
  var readingState = Object.assign({}, state, { message: addressError !== '' ? addressError : state.message })
  if (addressError !== '') readingState.ok = false
  var reading = toolbar.readingText(readingState, { loading: words.loading })
  var diagnostic = toolbar.diagnosticText(readingState)

  // 票 #20 D：那颗百分比是一颗**菜单按钮**。菜单展开时工具条长高一行（于是被测量的那一块
  // 自动变矮，外壳跟着把原生画面摆到新的矩形上）—— 不用浮层，因为浮层会被原生画面盖住。
  var currentPreset = toolbar.currentPreset(state.zoom)
  var presetItems = []
  for (var presetIndex = 0; presetIndex < toolbar.ZOOM_PRESETS.length; presetIndex++) {
    var percent = toolbar.ZOOM_PRESETS[presetIndex]
    presetItems.push(
      react.createElement(
        'button',
        {
          key: 'preset-' + String(percent),
          type: 'button',
          'data-dsh-view-zoom-preset': String(percent),
          'data-dsh-view-zoom-current': percent === currentPreset ? 'yes' : 'no',
          disabled: state.busy === true || props.hasShell !== true,
          onClick: (function (value) {
            return function () {
              setMenuOpen(false)
              run('zoom-to', { payload: { zoom: value / 100 } })
            }
          })(percent),
          style: {
            font: '11px/1 system-ui',
            minWidth: '40px',
            height: '20px',
            padding: '0 4px',
            border: '1px solid ' + (percent === currentPreset ? 'var(--dsh-color-accent, #0969da)' : 'var(--dsh-color-border, #d0d7de)'),
            borderRadius: '4px',
            background: 'var(--dsh-color-surface, #fff)',
            color: 'inherit',
            cursor: 'pointer',
            flex: '0 0 auto',
          },
        },
        String(percent) + '%',
      ),
    )
  }

  /**
   * 那行读数：**一个**控件，既是读数也是档位菜单的开关（票 #20b 的要求 3）。
   *
   * 票 #20 D 的代码在这里渲染了**两遍**同一句话：一颗 `<button data-dsh-view-zoom-menu>` 与一个
   * `<span data-dsh-view-zoom data-dsh-view-reading>`，两个的孩子都是 `reading`。真机上量到的
   * 就是它（用户附的证据，本轮又原样量了一遍）：
   *
   * ```
   * BUTTON[data-dsh-view-zoom-menu=closed]                         → "自动 100%"
   * SPAN  [data-dsh-view-zoom][data-dsh-view-reading][…diagnostic] → "自动 100%"
   * ```
   *
   * 用户的原话是"同一个信息渲染了两遍……一个带框、旁边又一个"，而票面把这一条定成了验收：
   * 那句话**只许出现一次**，并且要能**数**出来（必须是 1）。
   *
   * 所以这两个元素**合成一个 `<button>`**：它显示那句话，点它就是展开/收起档位（真浏览器也是
   * 点百分比选档位），而诊断话术仍旧只挂在它的 `title` 与 `data-dsh-view-diagnostic` 上
   * （票 #20 C 那条规矩一个字没改）。合成而不是"再放一颗 ▾ 按钮"，是因为代码里那段注释本来
   * 写的就是这个意思 —— *"菜单关着时它既是读数也是菜单按钮"* —— 而实现多画了一个元素。
   *
   * `aria-label` 上是"点它能做什么"（文案表里那个词）。它**不是** `title`：`title` 的位置
   * 让给诊断了，而一个只有一句话的按钮不该因为"那句话是诊断"就没有名字。
   */
  var zoomControl = react.createElement(
    'button',
    {
      key: 'zoom-menu',
      type: 'button',
      'data-dsh-view-zoom-menu': menuOpen ? 'open' : 'closed',
      // `zoomLabel` 自己就把"读不到"渲染成 `—`（票 #19 的规矩），所以这里不再判一次。
      'data-dsh-view-zoom': toolbar.zoomLabel(state.zoom),
      'data-dsh-view-reading': reading,
      'data-dsh-view-diagnostic': diagnostic,
      'aria-label': words.zoomMenuTitle,
      title: diagnostic,
      disabled: props.hasShell !== true,
      onClick: function () {
        setMenuOpen(function (open) {
          return open !== true
        })
      },
      style: {
        font: '11px/1.3 system-ui',
        height: '22px',
        padding: '0 6px',
        border: '1px solid var(--dsh-color-border, #d0d7de)',
        borderRadius: '4px',
        background: 'var(--dsh-color-surface, #fff)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: '0 1 auto',
        cursor: 'pointer',
        opacity: state.ok === false || addressError !== '' ? 1 : 0.75,
        color: state.ok === false || addressError !== '' ? 'var(--dsh-color-danger, #b42318)' : 'inherit',
      },
    },
    reading,
  )

  // 行一：导航按钮 + 地址栏 + 那颗读数/菜单按钮。行二（只在菜单展开时存在）：那一排标准档位。
  var row = react.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        width: '100%',
        height: toolbar.TOOLBAR_HEIGHT_PX + 'px',
        flex: '0 0 auto',
      },
    },
    children,
    addressField,
    zoomControl,
  )

  var rows = [row]
  if (menuOpen) {
    rows.push(
      react.createElement(
        'div',
        {
          'data-dsh-view-zoom-presets': 'open',
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '4px',
            width: '100%',
            padding: '2px 0 4px',
            flex: '0 0 auto',
          },
        },
        presetItems,
      ),
    )
  }

  return react.createElement(
    'div',
    {
      'data-dsh-view-toolbar': 'ready',
      // 票 #20b 的要求 2 靠这一个引用判"点在工具条里面还是外面"（见上面那个 effect）。
      ref: toolbarRef,
      style: {
        // 菜单展开时长高一行（`height: auto` 让内容决定），于是被测量的那一块自动变矮 ——
        // 原生画面跟着让出那一行，菜单因此**不会**被它盖住（浮层一定会）。
        //
        // 票 #20b 的要求 2：**空闲时严格一行**。这一句本来就是对的（关着就是那个常量），
        // 出问题的是"关不上" —— 展开之后点别处/按 Esc 都不收，于是一行变成常驻的两行。
        // 那三条收法在 `menuOpen` 那个 effect 里；`tests/toolbar-panel.spec.ts` 与
        // `tests/panel-toolbar-placement.spec.ts` 都**读回几何**（工具条高度、面板矩形上边缘）
        // 来钉它，不读 `menuOpen` 这个状态变量本身。
        height: menuOpen ? 'auto' : toolbar.TOOLBAR_HEIGHT_PX + 'px',
        minHeight: toolbar.TOOLBAR_HEIGHT_PX + 'px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        padding: '0 6px',
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--dsh-color-border, #d0d7de)',
        background: 'var(--dsh-color-surface, #fff)',
        color: 'var(--dsh-color-text, #1f2328)',
        flex: '0 0 auto',
      },
    },
    rows,
  )
}

/**
 * 侧边栏那个标签上的字（票 #20 B）。
 *
 * 它注册在 `sidebar.right.pane.tab.title` 座位上（key = 本插件的 `id`），于是**取代**宿主在
 * 开标签时抓到的那句 `title(address)` —— 那句话是**开标签那一刻**的，永远不会变，而这里要的是
 * "这一格现在装的是哪一页"。
 *
 * 它读的是 {@link pageTitle} 那份共享读数（工具条每次读回都往里写），并在这段时间里开着心跳
 * （见 {@link startPageTitleWatch}）—— 因为换页不必经过这个面板（Agent 直接驱动那个视图）。
 *
 * 读不到就回落到"浏览器"（{@link DshViewToolbar.titleForTab}）：一个空标签比一个说得不准的
 * 名字更坏，因为空标签让人看不出那一格里是什么。
 *
 * @returns {string} 标签上那串字。
 */
function TabTitle() {
  var react = require('react')
  var [title, setTitle] = react.useState(pageTitle.value)
  react.useEffect(function () {
    var unsubscribe = subscribePageTitle(setTitle)
    startPageTitleWatch(clientContext)
    // 挂上来的这一刻先读一次：标签可能比工具条先出现（比如切到别的标签之后再展开侧边栏）。
    if (pageTitle.value === '' && clientContext !== null) {
      void callView(clientContext, 'state').then(function (next) {
        if (next.ok === true) rememberPageTitle(next.title)
      })
    }
    return function () {
      unsubscribe()
      stopPageTitleWatch()
    }
  }, [])
  return DshViewToolbar.titleForTab(title, tabTitleFallback())
}

/**
 * The panel — the whole visible surface of this plugin in the sidebar.
 *
 * It renders no web page. It measures itself and reports the rectangle to the
 * shell, which owns the native view and places it there (ADR-0004). Everything it
 * draws is a caption describing that arrangement, because a pane that shows
 * nothing and explains nothing is indistinguishable from a broken plugin.
 *
 * @param {{tabInfo: () => {sidebar: {expanded: boolean}, tab: {visible: boolean}}}} props - slot props.
 * @returns {import('react').ReactElement} the panel element.
 */
function Panel(props) {
  var react = require('react')
  var hasShell = DshPanelRect.hasShell()
  /** 外层容器（工具条 + 下面那块）。它**不是**被测量的那一个。 */
  var containerRef = react.useRef(null)
  /** 被测量的那一块（`data-dsh-desktop-view-panel` 那个 div）：原生画面就摆在这里。 */
  var bodyRef = react.useRef(null)
  var [report, setReport] = react.useState({ rect: null, state: 'detached' })
  /**
   * 面板矩形变过几次（票 #19）。工具条拿它当"栏宽可能变了"的信号：拖动侧边栏时它每一帧都涨，
   * 而工具条那边节流之后才去重读缩放读数。涨这个数不额外引起渲染 —— 上报本来就会 setReport。
   */
  var [geometryTick, setGeometryTick] = react.useState(0)

  // The observer outlives every render, so it is created once and its `element` is
  // re-read on every measurement: React may replace the DOM node without the
  // measurement ever being wrong about which node it is looking at.
  var elementRef = react.useRef(null)
  var observer = react.useMemo(function () {
    if (!hasShell) return null
    return DshPanelRect.observe({
      get element() {
        return elementRef.current
      },
      onReport: function (rect, state) {
        setReport({ rect: rect, state: state })
        setGeometryTick(function (previous) {
          return previous + 1
        })
        DshPanelRect.deliver(rect)
      },
    })
  }, [])

  react.useEffect(function () {
    // The element only exists after the first commit, so the first measurement
    // happens here rather than during render. Reporting on every mount (not only on
    // change) is deliberate: a remount — StrictMode's double-invoke, or React
    // swapping the tree — runs the previous cleanup, which reported "no rectangle",
    // and the view must come back without waiting for a resize.
    if (observer !== null) observer.report()
    return function () {
      if (observer !== null) observer.stop()
      // The panel is leaving; the view must not stay parked over whatever replaces
      // it. Reporting "no rectangle" on teardown is the only way to say that.
      if (hasShell) DshPanelRect.deliver(null)
    }
  }, [])

  // 被测量的那一块，不是外层容器 —— 见下面那段注释。
  elementRef.current = bodyRef.current

  var caption = !hasShell
    ? copy().noShell
    : report.rect === null
      ? copy().missing
      : copy().ready

  // Two stacked rows: the toolbar, and the rectangle the native view parks on.
  //
  // The measured element is the *lower* one, and that is deliberate: the view covers exactly
  // what the panel reports (ADR-0004), so a toolbar sharing that rectangle would be painted
  // over by the very view it drives. Reporting the rectangle below the strip is what makes
  // the buttons visible at all — and it keeps the strip in the panel, where it cannot reach
  // the page the agent snapshots.
  //
  // 票 #18 的第二处真机 bug 就出在这一句上：`elementRef.current` 曾经指向**外层容器**
  // （它同时装着工具条与这一块），于是上报的矩形 = 容器 = 工具条 + 面板，外壳把原生画面
  // 摆到整块上，**连工具条那一行一起盖住** —— 用户看到的是"那一格上面空空的，没有后退/前进"。
  // 注释一直写的是"被测量的是下面那一个"，代码写的是容器：注释对、代码错。
  // 现在两者一致，而 `tests/panel-toolbar-placement.spec.ts` 钉住"上报矩形的上边缘 ≥ 工具条
  // 的下边缘"这一条。
  var inner = react.createElement(
    'div',
    {
      ref: containerRef,
      style: {
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        // 相对定位：被测量的那一块是它的孩子，`getBoundingClientRect()` 报的是视口坐标，
        // 宿主也是按视口坐标摆画面的（T2 量过两端同一套坐标）。
        position: 'relative',
      },
    },
    hasShell ? react.createElement(Toolbar, { ctx: clientContext, hasShell: hasShell, geometryTick: geometryTick }) : null,
    react.createElement(
      'div',
      {
        // 测量用的那个引用在这里就位：React 在 commit 时调它，早于任何 effect，
        // 所以 `observer.report()`（在 effect 里）读到的已经是这一块，不是容器。
        ref: function (node) {
          bodyRef.current = node
          elementRef.current = node
        },
        'data-dsh-desktop-view-panel': report.state,
        style: {
          // 这一块**就是**上报出去的那个矩形，而它的上边缘必须紧接工具条的下边缘 ——
          // 它被测量、被上报，外壳把原生画面摆在它上面（ADR-0004）。所以它是**工具条下面
          // 那一格**（`flex: 1 1 auto` 把剩下的高度全拿走），不是整块。
          flex: '1 1 auto',
          minHeight: 0,
          // 相对定位：原生画面要摆在这个矩形上，而这里不做任何偏移。
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '12px',
          boxSizing: 'border-box',
          textAlign: 'center',
          opacity: report.rect === null ? 1 : 0,
          color: 'var(--dsh-color-text-secondary, #6b7280)',
          fontSize: '12px',
          lineHeight: '1.5',
        },
      },
      caption,
    ),
  )

  return inner
}

/**
 * Register this plugin's client half.
 *
 * @param {object} ctx - client root context; `slots`, `locale`, and `sidebarRightTabs` are read from it.
 * @returns {void}
 */
function apply(ctx) {
  var t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : function () { return 'Browser' }
  // The toolbar reads this on render; see the note on the variable itself.
  clientContext = ctx
  // 标签标题的回落词也从这里出（同一个词，同一份字典）：见 `localeText` 的说明。
  localeText = t

  // Stage one: what the type IS.
  ctx.effect(function () {
    return ctx.sidebarRightTabs.register({
      id: TYPE_ID,
      kind: TYPE_KIND,
      // A page type ships from outside the product, which is the highest band; the
      // literal is spelled out rather than imported so this file needs nothing from
      // the product's runtime to declare itself. It is also what the type system
      // defaults to, so this is documentation as much as configuration.
      priority: 'extension',
      // No `patterns`: a page type is opened by `kind` and recognizes no address
      // (`tab-registry.d.ts:79-89`).
      title: function () {
        return t('type.label')
      },
      // The guide entry is the user's way in, and it is not optional in practice: a
      // page type claims no address, so nothing in the product will open it by
      // itself. The guide lists one capsule per entry and picking a capsule calls
      // `openTab(entry.kind)` — with no entry, the type exists, renders nowhere, and
      // the pane the user is looking for is simply unreachable.
      guide: [
        {
          // Ascending position among every registered type's entries. The shipped
          // Files entry is `order: 10`, so this one follows it.
          order: 20,
          title: function () {
            return t('guide.title')
          },
          description: function () {
            return t('guide.description')
          },
          // No `icon`: a glyph here would mean importing a React component from the
          // product's primitives package, and the guide draws its own placeholder
          // cube for an entry that registered none (`tab-registry.d.ts:60-61`).
        },
      ],
    })
  }, 'desktop-view: tab type')

  ctx.effect(function () {
    return ctx.locale.register(NS, DICTIONARIES)
  }, 'desktop-view: dictionaries')

  // Stage two: the body, under this definition's own `id`. One registration serves
  // every tab of the kind, in every pane, docked or floating.
  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.pane.tab', function () {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: NS }, Panel)
    })
  }, 'desktop-view: tab body')

  // Stage three（票 #20 B）：标签上那串字。
  //
  // 这一个座位是**为"会变的标题"存在的**，而且这不是猜的：宿主的类型声明把它写成了
  // 一句话 —— *"A tab's title as its chip shows it… A type with a live title — a terminal
  // named after its shell, a chat after its first line — registers here and reads its own
  // store; one without registers nothing and the chip shows the registry's `title(address)`
  // text captured at open time."*（`dsh-client-ui-sidebar-right/lib/types/client/contract/
  // slots.d.ts` 的 `sidebar.right.pane.tab.title`）。产品自己那个 Files 插件就是这么做的
  // （`dsh-client-ui-sidebar-files/lib/client.js` 的 FilesTitle）。
  //
  // 所以我们**不需要**任何"改标签标题"的运行时 API：座位本身就是那条路。
  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, TabTitle)
    })
  }, 'desktop-view: tab title')
}

exports.apply = apply
exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']
