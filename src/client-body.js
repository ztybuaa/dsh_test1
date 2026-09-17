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
  },
  en: {
    noShell:
      'This pane needs the desktop shell to show the browser. The shell is the Electron app that ships ' +
      'in this repository: run npm run shell there and this pane shows the real browser view. A plain ' +
      'browser tab has nothing to put here.',
    ready: 'The desktop shell is here: the native browser view takes this pane.',
    missing: 'This pane reports no rectangle (collapsed or switched away).',
  },
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
 * @returns {Promise<{ok: boolean, url: string, zoom: unknown, canGoBack: boolean,
 *   canGoForward: boolean, message: string}>} the host's answer, or a local failure value.
 */
async function callView(ctx, action) {
  try {
    var answer = await ctx.connection.rpc.call(RPC_CHANNEL, endpointFor(action), { nonce: String(Date.now()) })
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
 * @param {{ctx: object, hasShell: boolean}} props - the plugin context, and whether the shell is here.
 * @returns {import('react').ReactElement} the toolbar element.
 */
function Toolbar(props) {
  var react = require('react')
  var toolbar = DshViewToolbar
  var [state, setState] = react.useState({
    ok: null,
    url: '',
    zoom: undefined,
    canGoBack: false,
    canGoForward: false,
    message: '',
    busy: false,
  })

  /** Ask the host what is true right now, and show that. */
  var refresh = react.useCallback(function () {
    void callView(props.ctx, 'state').then(function (next) {
      setState(function (previous) {
        return Object.assign({}, previous, next, { busy: false })
      })
    })
  }, [])

  /**
   * Run one action, then show what the host read back **after** it.
   *
   * The read-back is the point: the host answers with the post-action state, so the zoom
   * label and the two history buttons come from the view rather than from a local guess
   * that could drift the moment anything else drives the view (the agent does).
   */
  var run = react.useCallback(
    function (action) {
      setState(function (previous) {
        return Object.assign({}, previous, { busy: true })
      })
      void callView(props.ctx, action).then(function (next) {
        setState(function (previous) {
          return Object.assign({}, previous, next, { busy: false })
        })
      })
    },
    [],
  )

  // The first read happens once the strip is on screen. It is deliberately not part of a
  // render: a render that started a request would start one per re-render.
  react.useEffect(function () {
    refresh()
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

  var children = []
  for (var index = 0; index < toolbar.BUTTONS.length; index++) {
    var button = toolbar.BUTTONS[index]
    var enabled = toolbar.isEnabled(button.action, {
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      busy: state.busy,
      hasShell: props.hasShell,
    })
    children.push(
      react.createElement(
        'button',
        {
          key: button.action,
          type: 'button',
          'data-dsh-view-action': button.action,
          title: button.title,
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
          },
        },
        button.label,
      ),
    )
  }

  return react.createElement(
    'div',
    {
      'data-dsh-view-toolbar': 'ready',
      style: {
        height: toolbar.TOOLBAR_HEIGHT_PX + 'px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 6px',
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--dsh-color-border, #d0d7de)',
        background: 'var(--dsh-color-surface, #fff)',
        color: 'var(--dsh-color-text, #1f2328)',
        flex: '0 0 auto',
      },
    },
    children,
    react.createElement(
      'span',
      {
        'data-dsh-view-zoom': toolbar.zoomLabel(state.zoom),
        style: {
          marginLeft: 'auto',
          font: '11px/1.3 system-ui',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '45%',
          textAlign: 'right',
          opacity: state.ok === false ? 1 : 0.75,
          color: state.ok === false ? 'var(--dsh-color-danger, #b42318)' : 'inherit',
        },
        title: toolbar.statusText(state),
      },
      toolbar.zoomLabel(state.zoom) + ' \u00b7 ' + toolbar.statusText(state),
    ),
  )
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
    hasShell ? react.createElement(Toolbar, { ctx: clientContext, hasShell: hasShell }) : null,
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
}

exports.apply = apply
exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']
