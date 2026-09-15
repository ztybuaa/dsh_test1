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
  var hostRef = react.useRef(null)
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

  elementRef.current = hostRef.current

  var caption = !hasShell
    ? copy().noShell
    : report.rect === null
      ? copy().missing
      : copy().ready

  return react.createElement(
    'div',
    {
      // The panel fills its slot exactly: the shell measures this element, and any
      // inset here would leave a strip of the pane the view does not cover.
      ref: hostRef,
      'data-dsh-desktop-view-panel': report.state,
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
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
  )
}

/**
 * Register this plugin's client half.
 *
 * @param {object} ctx - client root context; `slots`, `locale`, and `sidebarRightTabs` are read from it.
 * @returns {void}
 */
function apply(ctx) {
  var t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : function () { return 'Browser' }

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
exports.inject = ['slots', 'locale', 'sidebarRightTabs']
