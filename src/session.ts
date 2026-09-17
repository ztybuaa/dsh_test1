import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  ElementHandle,
  FileChooser,
  Frame,
  Page,
  Response,
} from 'playwright'
import { chromium } from 'playwright'
import {
  DEFAULT_DIALOG_POLICY,
  describeDialogActivity,
  planDialogAnswer,
  type DialogPolicy,
  type DialogRecord,
} from './dialogs.ts'
import {
  DOWNLOAD_JOURNAL_FILE,
  parseDownloadJournal,
  previewDownload,
  type DownloadJournal,
  type DownloadPreview,
  type DownloadRecord,
} from './downloads.ts'
import {
  MARK_PLANS,
  clearOverlay,
  mountOverlay,
  overlayConfig,
  paintOverlay,
  readFlashNeedsSecondPaint,
  type OverlayConfig,
  type OverlayKind,
  type ViewPoint,
} from './overlay.ts'
import {
  ObservedHistory,
  ZOOM_RESET,
  classifyNavigationFailure,
  normalizeZoom,
  parseEngineHistory,
  parseEngineNeighbours,
  stepZoom as nextZoomStep,
  type EngineHistoryNeighbours,
  type EngineHistoryReading,
  type HistorySource,
  type HistoryState,
  type NavigationFailureReason,
  type ZoomMode,
} from './navigation.ts'

/**
 * Adopt-mode browser session.
 *
 * The plugin never starts a browser and never creates a page. It connects to the
 * shell's loopback programmable endpoint and takes over the native view the shell
 * already parked in its sidebar slot (ADR-0002). `context.newPage()` is not merely
 * discouraged here — it throws on an Electron host, so this module has no path to it.
 */

/** Identity of the native view, as published by the shell handshake. */
export interface ViewHandle {
  /** Loopback programmable endpoint of the shell, e.g. `http://127.0.0.1:53211`. */
  cdpUrl: string
  /** CDP target id of the view. Primary identity; survives navigation. */
  targetId?: string
  /** Initial URL of the view. Fallback identity, used only when no target id was published. */
  url?: string
}

/** Options for {@link AdoptedViewSession.adopt}. */
export interface AdoptOptions extends ViewHandle {
  /** Connection and per-action timeout in milliseconds. */
  timeoutMs?: number
  /**
   * Cap on the elements one snapshot lists. A page with more interactive elements
   * than this is truncated and the snapshot says so, rather than growing without
   * bound. Defaults to {@link DEFAULT_MAX_ELEMENTS}.
   */
  maxElements?: number
  /**
   * Cap on the characters a text read returns. Long page text is cut at this many
   * characters and reported as truncated, rather than being handed over whole.
   * Defaults to {@link DEFAULT_MAX_CHARS}.
   */
  maxChars?: number
  /**
   * Where the shell publishes what it downloaded, as the shell's own space channel
   * names it (`<channel dir>/downloads.json`).
   *
   * Absent means there is no shell to ask: `downloads()` then says so instead of
   * pretending nothing was downloaded (ADR-0011).
   */
  downloadJournalFile?: string
  /**
   * 谁来真的改这块视图的缩放（票 #13）。
   *
   * 缩放**必须**由外壳做：`webContents.setZoomFactor()` 是 Electron 的 API，插件够不到。
   * 量到的理由不是"够不到所以算了"，而是**只有它同时做两件事**（见 ADR-0013 决定二）：
   * 布局视口按比例变大/变小，**并且内容真的被按比例画出来**。插件够得到的那条 CDP 路
   * 只做前一半 —— 窗格把模拟视口按 1:1 画出来然后裁掉，于是"缩小"不但没让整页进来，
   * 还因为页面不再溢出而**把滚动条也弄没了**（真窗口像素实测）。
   *
   * 缺省 = 这个会话没有外壳可问，`zoomTo` 会**如实说不能缩放**，而不是假装缩放过。
   */
  zoomPort?: ViewZoomPort
  /**
   * 领养时**外壳已经读回**的缩放值（`state.json` 里那条空间记录的 `zoom`）。
   *
   * 它只是起点：会话手里的数不许比外壳知道的更自信。外壳没说时缺省是 1。
   */
  zoom?: number
}

/**
 * 改缩放的那道口子（票 #13）。
 *
 * 它是**一道口子**而不是直接调外壳：会话只认识"把这块视图缩放到多少"，至于这件事是经
 * 空间请求文件、还是一条将来的控制通道去做的，是调用方的事。纯逻辑的会话因此照旧可以
 * 在没有外壳的情况下被测试，而"没有口子"与"有口子但外壳拒绝"是两句话。
 */
export interface ViewZoomPort {
  /**
   * 把这块视图的缩放设成 `zoom`。
   *
   * @param zoom - 目标缩放值（调用方已经用 `normalizeZoom` 校验过范围）。
   * @param mode - 谁管这个缩放（票 #19，缺省 `manual`）：指名一个值 = 这个值我说了算，
   *   于是外壳的自动适配从此让位。
   * @returns **外壳读回来**的实际缩放值（`getZoomFactor()`），不是请求里的那个数。
   */
  setZoom(zoom: number, mode?: ZoomMode): Promise<number>
  /**
   * 请外壳把这一格交回**自动适配**（票 #19）。
   *
   * 与 `setZoom` 分开，是因为这件事**没有缩放值可给**：那个值由外壳按栏宽算。缺席 = 这个
   * 调用方（测试造的假口子、没有外壳的部署）没有这条路，`useAutoZoom` 会像 `zoomTo`
   * 一样如实说"没有外壳可问"，而不是假装交回去了。
   *
   * @returns **外壳读回来**的实际缩放值 —— 而且是**适配跑完之后**的那个数。
   */
  useAutoZoom?(): Promise<number>
  /**
   * 这个空间**现在**缩放多少、谁在管（票 #19）。
   *
   * 为什么这道口子上必须有它：自动适配会在**没人请求**的时候改缩放（外壳按栏宽自己算），
   * 所以会话手里记的那个数会过期。面板上那个读数（"自动 78%" / "手动 90%"）与工具回答的
   * "现在是多少"都从这里读，而不是从会话的记忆里读。
   *
   * 缺席 = 这个调用方不提供这条读回；那时会话退回自己记的那个值，并且**不声称**任何模式 ——
   * "不知道谁在管"与"自动在管"是两句不同的话。
   *
   * @returns 外壳读回来的读数，或 undefined（读不到）。
   */
  reading?(): Promise<{ zoom: number; mode: ZoomMode } | undefined>
}

/** Outcome of a navigation: the address actually reached, and its title. */
export interface NavigationResult {
  /** Document title of the page after loading. */
  title: string
  /** Final address, which may differ from the requested one after redirects. */
  url: string
}

/**
 * 一次"回到上一页/下一页/重来一次"的结果（T13）。
 *
 * 与 {@link NavigationResult} 分开，因为**失败是这一类动作的常态**：一个刚打开的视图就是
 * 没有可后退的历史，而"没有历史"和"页面拒绝了"和"超时了"是三件不同的事，补救也不同
 * （T4 那套做法）。所以这个形状里失败**不抛**，而是如实带回分类 —— 分类是给调用方分支用的
 * **值**，那句话是给人看的。
 */
export interface HistoryActionResult {
  /** 视图现在的地址，动作成功与否都读回来。 */
  url: string
  /** 页面的标题；读不到时是空串。 */
  title: string
  /** 动作真的发生了吗。 */
  moved: boolean
  /** 没发生时是哪一类。 */
  reason?: NavigationFailureReason
  /** 没发生时那句话（含补救）。 */
  message?: string
  /**
   * 历史，动作**之后**的状态 —— 面板上的按钮亮不亮、`browser_view` 报不报得成看它。
   *
   * 票 #18 起它是**引擎的**读数（`Page.getNavigationHistory`），只有在引擎答不上来时才退回
   * 本会话观察到的账本 —— 哪一种由 {@link HistorySource} 说清楚。
   */
  history: EngineHistoryReading
}

/**
 * 一次缩放的结果。
 *
 * 每个字段都是**读回来的**，不是算出来的：`devicePixelRatio` 与视口尺寸都从页面自己那里取
 * （面板上显示的东西必须来自独立读回，不能是面板自己的局部变量）。
 */
export interface ZoomResult {
  /** 现在是多少（1 = 没有缩放），**来自外壳的读回值**。 */
  zoom: number
  /** 缩放之后布局视口的宽度，来自页面自己的 `innerWidth`。 */
  innerWidth: number
  /** 缩放之后布局视口的高度，来自页面自己的 `innerHeight`。 */
  innerHeight: number
  /** 缩放之后页面自己读到的 `devicePixelRatio`。 */
  devicePixelRatio: number
  /**
   * 没有缩放时视图本来的视口尺寸。
   *
   * 它是**算出来的**，不是另读一次的：外壳侧的缩放就是"布局视口 = 源视口 / zoom"，
   * 所以 `源视口 = 页面读到的布局视口 × zoom`（`zoom = 0.5` 时页面报 1240，源视口就是 620）。
   * 这样它和同一次读回的 `innerWidth` 必然自洽，不会出现"两次读回之间页面换了一页"。
   */
  source: { width: number; height: number }
}

/**
 * 面板要显示的那一整份状态（T13）。
 *
 * 每一个字段都注明它**从哪读来**，因为面板上显示的东西必须来自独立读回：
 * `url` 读自视图自己，`devicePixelRatio` / 视口读自页面自己，历史读自**引擎自己的历史**
 * （拿不到时退回会话的观察账本，由 `historySource` 说清是哪种），`zoom` 读自外壳（`getZoomFactor()`）。
 */
export interface ViewDisplayState {
  /** 视图现在的地址。 */
  url: string
  /** 当前页面的标题，读不到时是空串。 */
  title: string
  /** 外壳读回来的缩放值（1 = 100%），见 {@link AdoptedViewSession.zoomLevel}。 */
  zoom: number
  /**
   * 那个缩放**归谁管**（票 #19）：`auto` = 外壳按栏宽自动适配，`manual` = 人（或工具）指名的。
   *
   * 缺席 = 读不到（没有外壳、旧外壳不发布这个字段）：面板那时只显示百分比，
   * **不**编一个模式 —— "不知道谁在管"与"自动在管"是两句不同的话。
   */
  zoomMode?: ZoomMode
  /** 页面自己读到的 `devicePixelRatio`；页面正在换文档时缺席。 */
  devicePixelRatio?: number
  /** 页面自己读到的视口宽度（CSS 像素）；同上。 */
  innerWidth?: number
  /** 页面自己读到的视口高度；同上。 */
  innerHeight?: number
  /**
   * 这一页**还在加载中**吗（票 #20 F）：页面自己说的 `document.readyState !== 'complete'`。
   *
   * 缺席 = 读不到（正在换文档、页面抛了）。它与 `devicePixelRatio` 那几个是同一类：
   * 一次读不到就缺席，面板不显示那个提示，而不是猜一个。
   */
  loading?: boolean
  /** 还能后退/前进几页（引擎答的，或引擎答不上来时账本答的）。 */
  history: HistoryState
  /** 那份历史是从哪读来的（票 #18）：`engine` 或 `observed`。 */
  historySource: HistorySource
  /** 后退/前进各自会去哪一页（票 #20 F）；读不到就没有这个键。 */
  neighbours?: EngineHistoryNeighbours
  /** 外壳握手发布的初始页；没有就缺席（「重新开始」会去空白页）。 */
  initialUrl?: string
}

/**
 * A rectangle in CSS pixels, in the view's own viewport coordinate space.
 *
 * Deliberately *not* document coordinates and deliberately *not* rounded:
 *
 *  - viewport-relative is the space `document.elementFromPoint(x, y)` and a
 *    `position: fixed` overlay already use, so a consumer that wants to click or
 *    draw at these numbers can pass them straight through (see ADR-0007);
 *  - keeping the raw layout geometry means "is this element inside the viewport"
 *    is the consumer's comparison (`y + height > 0 && y < viewport height`), not a
 *    decision this module made and rounded away.
 */
export interface ElementBounds {
  /** Distance from the left edge of the viewport, as `getBoundingClientRect().left`. */
  x: number
  /** Distance from the top edge of the viewport, as `getBoundingClientRect().top`. */
  y: number
  /** Rendered width in CSS pixels. */
  width: number
  /** Rendered height in CSS pixels. */
  height: number
}

/** One interactive element in a snapshot, addressed by its 1-based `ref`. */
export interface SnapshotElement {
  /** The 1-based index the model quotes back in an action. Valid until the page changes. */
  ref: number
  /** Accessibility role, e.g. `button`, `link`, `textbox`. */
  role: string
  /** Accessible name: `aria-label` → `aria-labelledby` → `<label for>` → `placeholder` → `value` → text. */
  name: string
  /** Present only when the element actually carries one: `checked=`, `selected=`, `expanded=`, `disabled`. */
  state?: string
  /** Where the element is and how big it is, in viewport coordinates. */
  bounds: ElementBounds
  /**
   * Address of the frame the element lives in; **absent means the main frame**.
   *
   * A `ref` is not just an element: it is an element *in one document of one frame*, so
   * which frame it came from is part of what the ref means. An element inside a frame
   * has the same role/name/state/bounds fields as any other, and this one says where to
   * go looking for it — two frames of the same page can hold identical controls (T9).
   */
  frame?: string
}

/**
 * The compact snapshot the model is handed: the page's identity plus its
 * interactive elements. Body text is deliberately absent — read it with a
 * separate capability on demand, never by growing this (ADR-0005).
 */
export interface PageSnapshot {
  /** Document title of the page. */
  title: string
  /** Address of the page. */
  url: string
  /** Interactive, visible elements in document order; `ref` is the 1-based index. */
  elements: SnapshotElement[]
  /** Set when the page had more interactive elements than the cap allowed. */
  truncated?: boolean
}

/** What one `wait` call is asked to wait for: exactly one of the three forms. */
export interface WaitOptions {
  /** Wait this many milliseconds, and no longer. */
  ms?: number
  /** Wait until this CSS selector is visible. */
  selector?: string
  /** Wait until this text is part of what the page renders. */
  text?: string
  /** How long to allow, when the session's own timeout is not the right one. */
  timeoutMs?: number
}

/** What a wait observed, so a caller can say what happened rather than "done". */
export interface WaitResult {
  /** What was waited for, in words: `500ms`, `selector "#ready"`, `text "Ready"`. */
  waited: string
  /** How long it actually took. */
  elapsedMs: number
}

/**
 * The page's own rendered text, plus what the cap did to it.
 *
 * `totalChars` is the length of the text *before* the cap, read in the page in the
 * same pass that read the text, so "this is all of it" and "this was cut" are
 * distinguishable from the outside instead of by comparing against a number the
 * caller guessed (T5).
 */
export interface ExtractedText {
  /** `document.body.innerText`, cut at the cap when it was longer. */
  text: string
  /** Whether the cap cut anything off. */
  truncated: boolean
  /** How many characters the page's rendered text really had. */
  totalChars: number
}

/** One console message the page produced, as the page's console reported it. */
export interface ConsoleMessageRecord {
  /** Playwright's console type: `error`, `warning`, `log`, `info`, … or `pageerror`. */
  type: string
  /** The message text. */
  text: string
  /** Where it came from (`url:line:column`), or `<unknown>` when the page gave no location. */
  location: string
}

/**
 * One request the page made that did not succeed.
 *
 * `status` is `0` for a request that never reached a response at all (DNS, refused
 * connection, aborted), which is the one case where a status code cannot exist and
 * saying `0` beats pretending there was one.
 */
export interface FailedRequestRecord {
  /** HTTP method. */
  method: string
  /** Absolute URL that was requested. */
  url: string
  /** HTTP status, or `0` when no response arrived. */
  status: number
  /** The response's own reason phrase, e.g. `Not Found`; `(no response)` when there was none. */
  statusText: string
  /** A short readable summary: the response body excerpt, or the network failure. */
  summary: string
}

/** Everything the page reported going wrong, and what it said about itself. */
export interface PageDiagnostics {
  /** Console messages, oldest first, bounded to the most recent few. */
  console: ConsoleMessageRecord[]
  /** Requests that failed, oldest first, bounded to the most recent few. */
  failedRequests: FailedRequestRecord[]
}

/** One JSON response the page received, kept so the data is readable without the render. */
export interface JsonResponseRecord {
  /** The requested URL. */
  url: string
  /** HTTP status the payload arrived with. */
  status: number
  /** The parsed JSON body. */
  body: unknown
}

/**
 * What handing a local file to a page's file input came out as.
 *
 * Every field is read back **from the page**: the file name and size are `FileList`
 * entries of the input the page now holds, not a restatement of what was handed over.
 * A tool that reported "the file was given to the input" without that read-back would be
 * claiming something it did not check (T9).
 */
export interface UploadResult {
  /** The ref the action named. */
  ref: number
  /** `tag#id "name"` — how the trigger is named in messages. */
  element: string
  /** Which route actually delivered the file. */
  via: 'input' | 'filechooser'
  /** The absolute path that was handed over. */
  path: string
  /** How many files the input now holds. */
  count: number
  /** The first file's name, as the page's own `FileList` reports it. */
  name: string
  /** The first file's size in bytes, as the page's own `FileList` reports it. */
  size: number
}

/**
 * A download that **started** while an action ran.
 *
 * It is deliberately not "a file": where the bytes ended up is the shell's answer
 * (ADR-0011), and this record only says the page began one, which is what makes a click
 * that triggers a download reportable as such instead of as "the page changed".
 */
export interface DownloadStart {
  /** Address being downloaded. */
  url: string
  /** File name the browser proposes. */
  filename: string
  /** When the download began. */
  at: number
}

/** One download the shell recorded, together with the bytes this side really read. */
export interface DownloadReading {
  /** The shell's record: the only source of the落盘 path. */
  record: DownloadRecord
  /** The preview, present only when the file was there and readable. */
  preview?: DownloadPreview
  /** Why there is no preview, when the record says the file should be there. */
  unreadable?: string
}

/**
 * What happened *besides* the action, during one action.
 *
 * Actions have effects the model did not ask for one at a time: a click can raise a
 * `confirm`, and it can start a download. Both are things the model must be told about —
 * "clicked" alone would let it believe the page changed when in fact a file was saved,
 * or that nothing happened when in fact a dialog was answered (T9).
 */
export interface ActionActivity {
  /** Dialogs that were raised and answered while the action ran. */
  dialogs: DialogRecord[]
  /** Downloads that began while the action ran. */
  downloads: DownloadStart[]
}

/** The element a ref addresses, pinned, plus what one look at it answered. */
interface RefTarget {
  /** The node the snapshot listed. */
  handle: ElementHandle<Element>
  /** What {@link inspectElement} answered about it just now, in *view* coordinates. */
  facts: ElementFacts
}

/**
 * Everything a `ref` has to remember besides the node itself (T9).
 *
 * A ref is an element **in one document of one frame**, so the pin is three things at
 * once: the node, the frame it was read from, and that frame's document identity. The
 * origin is what turns a frame-local rectangle into a rectangle of *this view* — the
 * coordinates bounds, the overlay and the hit test all share (ADR-0007) — and the iframe
 * element is what makes "a cover in the parent document" detectable from here.
 */
interface RefEntry {
  /** The node the snapshot pinned. */
  handle: ElementHandle<Element>
  /** The frame whose document the node belongs to. */
  frame: Frame
  /** `performance.timeOrigin` of that document, as read when the snapshot was taken. */
  token: string
  /** Where that frame's viewport starts, in this view's viewport coordinates. */
  origin: ViewPoint
  /**
   * The `<iframe>` this frame hangs in, in its parent's document; absent for the main
   * frame. Kept because "is this element covered" has to ask the parent document too:
   * an element inside a frame can be covered by something drawn over the iframe itself.
   */
  frameElement?: ElementHandle<Element>
}

/**
 * What one action can tell the overlay while it runs.
 *
 * The action body is what knows where the action is aimed and where it lands, so it
 * reports both; the wrapper in {@link AdoptedViewSession.action} is what draws them and
 * what draws the failure mark when the body throws.
 */
interface ActionOverlay {
  /**
   * Where the action is aimed, in viewport CSS pixels — the point the hit test used
   * (ADR-0007). Nothing is drawn when there is no point.
   */
  aim: (point: ViewPoint | undefined) => Promise<void>
  /**
   * Where the action lands, when that is not where it aimed.
   *
   * A drag lands on its target and a scroll-into-view only has a landing point once it
   * has scrolled, so the landing place has to be reportable on its own. Left unreported,
   * the aimed point is used.
   */
  landed: (point: ViewPoint | undefined) => void
}

/** How long a default action may take when the caller does not say. */
const DEFAULT_TIMEOUT_MS = 30_000

/** How many elements one snapshot lists before it is truncated. */
export const DEFAULT_MAX_ELEMENTS = 200

/**
 * How many characters one text read returns before it is cut.
 *
 * It exists because the alternative — handing the model a whole page's text — is what
 * makes a session unusable: the cap is paired with ADR-0005's rule that body text is
 * never carried in the snapshot, so the model asks for text only when it wants it and
 * the answer is bounded when it does (T5).
 */
export const DEFAULT_MAX_CHARS = 20_000

/** How many JSON responses are kept; past it the oldest is dropped. */
const MAX_JSON_RESPONSES = 30

/** How many console messages are kept; past it the oldest is dropped. */
const MAX_CONSOLE_MESSAGES = 50

/** How many failed requests are kept; past it the oldest is dropped. */
const MAX_FAILED_REQUESTS = 50

/** How many dialogs are kept; past it the oldest is dropped. */
const MAX_DIALOG_RECORDS = 30

/** How many download *starts* are kept; past it the oldest is dropped. */
const MAX_DOWNLOAD_STARTS = 30

/**
 * How long a control is given to open a file chooser after it is clicked.
 *
 * Measured on this host: the `filechooser` event arrives about **one millisecond** after the
 * click returns, so a control that has not opened one after five seconds is not going to.
 * The budget exists so a control that simply does not open a chooser is reported as that,
 * instead of tying up the full 30s action timeout on a click that already did its job.
 */
const FILE_CHOOSER_BUDGET_MS = 5_000

/** How much of an error response body is quoted as the failure's summary. */
const FAILURE_SUMMARY_CHARS = 200

/**
 * How long one screenshot attempt is given before another is made.
 *
 * The engine's capture against this host does not answer reliably on its own: measured on
 * Electron 44 over `connectOverCDP`, a lone `Page.captureScreenshot` waits indefinitely
 * (30s and counting) while the *next* request completes both — two captures issued
 * concurrently both return in about 0.6s. So a screenshot gets a bounded attempt budget
 * and is repeated, instead of inheriting the 30s action timeout and hanging for it. A
 * healthy capture answers in well under a second, so the cap costs nothing when the
 * engine behaves.
 */
const SCREENSHOT_ATTEMPT_MS = 3_000

/** How many capture attempts one screenshot makes before giving up with a timeout. */
const SCREENSHOT_ATTEMPTS = 4

/**
 * 一次缩放之后，最多花多久等页面自己的读数跟上（票 #20 E）。
 *
 * **它不是一个延迟，是一个上界**：第一次读就对上了就立刻返回（实测常态，整个动作 119–175 ms），
 * 只有"渲染进程还没把那个缩放应用上去"的时候才会用到它。所以给宽一点没有代价，给窄了有代价 ——
 * 预算用完就**如实返回读到的东西**，那意味着面板上那个数可能还是上一次缩放的（一次）。
 *
 * 1 秒这个数有来处：**票前那个实现等的就是一帧，而这一页不被合成时一帧正好 ~1 秒**
 * （见 `docs/research/t20-why-the-panel-button-waits-a-second.md`）。所以这个上界**等于**
 * 票前那次等待 —— 最坏情况一模一样，常态从 ~1 秒降到几十毫秒，不会更差。
 * （第一版给的是 200 ms；整包连跑时 `tests/view-actions.spec.ts` 的 dpr 那一组在机器被占满的
 * 那一轮红过一次，正是"渲染进程还没跟上"的形状，所以放宽到这个不会更差的上界。）
 *
 * 为什么不在超时之后"当作成功"：那会把一个读不到的东西说成读到了，与仓库一贯的规矩相反。
 * 超时只是不再等，返回的仍然是页面真报的那个数。
 */
const SETTLE_BUDGET_MS = 1_000

/** 上面那个预算里每次重试之间等多久。10 ms 是"不让出一个帧的时间"，也就不受出帧节奏影响。 */
const SETTLE_STEP_MS = 10

/**
 * 等一小会儿（票 #20 E 的重试间隔）。
 *
 * 它刻意**不是** `requestAnimationFrame`：这一页不出帧的时候，rAF 是那个 ~1 秒的坑，
 * 而这里要的只是"让出一个宏任务的时间"，好让渲染进程把已经收到的缩放消息处理掉。
 *
 * @param ms - 毫秒。
 * @returns 到点就 resolve。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ARIA widget roles that count as interactive even on a plain `<div>`, so a page
 * that builds its own controls is not invisible to the snapshot.
 */
const INTERACTIVE_ROLES = [
  'button', 'link', 'textbox', 'combobox', 'listbox', 'option', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio',
  'switch', 'searchbox', 'slider', 'spinbutton', 'treeitem',
] as const

/**
 * What the snapshot collects, and what is left out.
 *
 * `:visible` is Playwright's own predicate — a non-empty bounding box and no
 * `visibility: hidden` — which is exactly the inherited rule for "hidden elements
 * do not enter the snapshot" (ADR-0005). Using the engine's predicate rather than a
 * second, hand-rolled one matters: the same predicate decides what a later click can
 * act on, so the snapshot lists what can actually be acted on instead of a
 * near-miss of it.
 *
 * Exported so a test can ask the engine the *same* question with the *same* selector —
 * the guard "the cursor overlay must not match it" (T8) is only worth anything if the
 * test reads the real selector instead of a copy that can drift.
 */
export const SNAPSHOT_SELECTOR = [
  'a[href]:visible',
  'button:visible',
  'input:visible',
  'select:visible',
  'textarea:visible',
  '[contenteditable="true"]:visible',
  ...INTERACTIVE_ROLES.map((role) => `[role="${role}"]:visible`),
].join(', ')

/**
 * The second thing a snapshot may list: a visible `<label>` whose control the snapshot
 * does not list itself (ADR-0012).
 *
 * The rule is deliberately about **reachability**, not about file inputs: a real page
 * that hides the real control and styles a `<label>` is the standard way to build a file
 * picker *and* a custom checkbox. In both cases the control is `display: none` (so the
 * first selector cannot match it, by the inherited hidden-element rule) while the label
 * is what a person sees and clicks — and without this the label is an element that is
 * plainly clickable and that no `ref` can name.
 *
 * The decision is made in the page, in the same pass as everything else, because "is the
 * control listed" is only answerable against *this* frame's match set — see
 * {@link collectSnapshot}. Exported for the same reason as
 * {@link SNAPSHOT_SELECTOR}: a test must read the real selector.
 */
export const CONTROL_LABEL_SELECTOR = 'label:visible'

/** What the page computes for one matched element, before a `ref` is assigned. */
interface CollectedElement {
  role: string
  name: string
  state?: string
  bounds: ElementBounds
}

/**
 * Everything one in-page pass can answer about the current document.
 *
 * `token` is the document's own identity (see {@link AdoptedViewSession.clickRef}):
 * `performance.timeOrigin` is fixed when a document begins and is different for the
 * next document in the same frame, so it distinguishes "the document this snapshot
 * describes" from "the document that replaced it" without writing anything into the
 * page. A same-document navigation (`pushState`, a hash change) keeps it — correctly,
 * because the elements are still the ones the snapshot listed.
 */
interface CollectedSnapshot {
  /** `document.title`, read from the same document as the elements. */
  title: string
  /** Identity of the document this was read from. */
  token: string
  /** One record per kept element, in document order. */
  elements: CollectedElement[]
  /**
   * Which input each kept element came from: an index into `[...elements, ...labels]`.
   *
   * The page decides *what* is listed and in *what order* (that is where the DOM is),
   * while the handles stay on this side; these indices are how the two halves are
   * stitched back together without a second query that could disagree about positions
   * (ADR-0008).
   */
  picks: number[]
}

/** What one in-page collection pass is handed: this frame's two match sets and the overlay's id. */
interface SnapshotInput {
  /** Matches of {@link SNAPSHOT_SELECTOR} in this frame, in document order. */
  elements: Element[]
  /** Matches of {@link CONTROL_LABEL_SELECTOR} in this frame, in document order. */
  labels: Element[]
  /** Id of the cursor overlay's container, whose nodes never enter a snapshot. */
  overlayId: string
}

/**
 * Collect the document's title and identity plus one record per element that belongs in
 * a snapshot, in document order.
 *
 * Playwright serializes this function into the page and calls it **once per frame** with
 * the whole match set of that frame, so the title, the document token, and every
 * element's role/name/state/geometry all come from one evaluation of one document — the
 * parts of a snapshot cannot disagree about which document or which element they
 * describe, and a snapshot costs one round-trip per frame rather than one per element
 * (see ADR-0007 for why this beats `DOMSnapshot.captureSnapshot`).
 *
 * Three rules live here and nowhere else, because all three are questions only the DOM
 * can answer:
 *
 *  - **the overlay's own nodes are never listed.** The overlay is the agent's furniture,
 *    not the page: a mark must never be something the agent can then act on. Its markup
 *    matches neither selector today (T8), and this exclusion is the second, stronger
 *    half — it holds even if the overlay one day grows a node that does match, which is
 *    exactly what the guard test injects to prove the exclusion is load-bearing.
 *  - **a label is listed only when its control is not.** "Is the control listed" is
 *    answerable against this frame's match set and nothing else, so the base handles
 *    come in as an argument and are compared by identity (ADR-0012).
 *  - **document order**, over the union of both match sets. The engine returns each
 *    selector's matches in document order, so ordering the union is a merge by
 *    `compareDocumentPosition` — kept here rather than concatenating the two lists,
 *    because "the snapshot is in document order" is what lets a reader talk about
 *    "before" and "after" at all.
 *
 * Everything it needs is declared inside it on purpose: only this function's *source*
 * crosses into the page, so a helper defined beside it in this module would be a
 * `ReferenceError` there rather than a call.
 *
 * @param input - this frame's two match sets and the overlay container's id.
 * @returns the document facts plus one metadata record per kept element, in that order.
 */
function collectSnapshot(input: SnapshotInput): CollectedSnapshot {
  /** Roles derived from the element itself when it declares none. */
  const rolesByTag: Record<string, string> = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' }

  /** Role, accessible name, optional state, and geometry for one element. */
  const describe = (element: Element): CollectedElement => {
    const tag = element.tagName.toLowerCase()
    let role = element.getAttribute('role') ?? ''
    if (role === '') {
      if (tag === 'input') {
        const type = element.getAttribute('type') ?? 'text'
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') role = 'button'
        else if (type === 'checkbox') role = 'checkbox'
        else if (type === 'radio') role = 'radio'
        else role = 'textbox'
      } else {
        role = rolesByTag[tag] ?? tag
      }
    }

    // The inherited resolution order: each source only gets a turn when every earlier
    // one said nothing (ADR-0005).
    let name = element.getAttribute('aria-label') ?? ''
    if (name === '') {
      const labelledBy = element.getAttribute('aria-labelledby')
      if (labelledBy !== null && labelledBy !== '') {
        name = labelledBy
          .split(/\s+/)
          .map((id) => (document.getElementById(id)?.textContent ?? '').trim())
          .join(' ')
          .trim()
      }
    }
    if (name === '') {
      const elementLabels = (element as HTMLInputElement).labels
      if (elementLabels !== undefined && elementLabels !== null && elementLabels.length > 0) {
        name = (elementLabels[0].textContent ?? '').trim()
      }
    }
    if (name === '') name = element.getAttribute('placeholder') ?? ''
    if (name === '') name = element.getAttribute('value') ?? ''
    if (name === '') name = (element.textContent ?? '').trim()

    // State is carried only when the element has one: `aria-checked="false"` is a
    // value, absence is not.
    let state: string | undefined
    for (const attribute of ['aria-checked', 'aria-selected', 'aria-expanded']) {
      const value = element.getAttribute(attribute)
      if (value !== null && value !== '') {
        state = `${attribute.slice('aria-'.length)}=${value}`
        break
      }
    }
    if (state === undefined && (element as HTMLInputElement).disabled === true) state = 'disabled'

    const box = element.getBoundingClientRect()
    const collected: CollectedElement = {
      role,
      name,
      bounds: { x: box.left, y: box.top, width: box.width, height: box.height },
    }
    // Absent means absent: an optional property set to `undefined` still shows up as a
    // key once the value is serialized, and the output schema declares `state` optional.
    if (state !== undefined) collected.state = state
    return collected
  }

  const overlay = document.getElementById(input.overlayId)
  const fromOverlay = (node: Element): boolean =>
    overlay !== null && (node === overlay || overlay.contains(node))

  const nodes: Element[] = []
  const picked: number[] = []
  input.elements.forEach((element, index) => {
    if (fromOverlay(element)) return
    nodes.push(element)
    picked.push(index)
  })
  const listed = new Set(input.elements)
  input.labels.forEach((label, index) => {
    if (fromOverlay(label)) return
    const control = (label as HTMLLabelElement).control
    // A label for nothing labelled, or for a control the snapshot already lists, adds
    // nothing: the control is the thing an action wants, and it is already reachable.
    if (control === null || control === undefined) return
    if (listed.has(control)) return
    nodes.push(label)
    picked.push(input.elements.length + index)
  })

  const order = nodes.map((_, index) => index).sort((left, right) => {
    const position = nodes[left].compareDocumentPosition(nodes[right])
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1
    return left - right
  })

  return {
    title: document.title,
    token: String(performance.timeOrigin),
    elements: order.map((index) => describe(nodes[index])),
    picks: order.map((index) => picked[index]),
  }
}

/**
 * Why an action did not happen.
 *
 * These are values rather than one boolean because each one is a *different remedy*:
 * a timeout is worth retrying, an obscured element needs the cover moved or the cover
 * acted on, an invisible one needs it made visible, a missing one needs a new snapshot,
 * and a stale ref needs the page understood before anything is done to it. A single
 * "failed" would erase exactly the part the caller can act on (T4).
 */
export type ActionFailureReason =
  /** The element never became actionable within the timeout. */
  | 'timeout'
  /** Something else is on top of the element, so the action would land on that instead. */
  | 'obscured'
  /** The element is in the document but not rendered (no box, or `visibility: hidden`). */
  | 'not-visible'
  /** The element is not there: either no such ref, or the node it addressed is gone. */
  | 'not-found'
  /** The ref was read from a document the view no longer shows. */
  | 'stale-ref'
  /**
   * The page's own guard stopped it: a `beforeunload` handler refused to leave, so the
   * navigation never happened and the view is still where it was.
   *
   * It is its own reason because its remedy is its own: no amount of retrying or
   * re-snapshotting moves a page that has unsaved changes — that has to be dealt with
   * on the page first (T9).
   */
  | 'page-guard'
  /** Anything else the engine reported; the message carries its own words. */
  | 'failed'

/**
 * An action that did not happen, with the reason as a value as well as in the message.
 *
 * The message is the part that matters in production — it is what reaches the model —
 * so it always names the ref, what the element was, and what to do next; `reason` is
 * there so a caller can branch without parsing prose.
 */
export class ViewActionError extends Error {
  readonly reason: ActionFailureReason

  constructor(reason: ActionFailureReason, message: string) {
    super(message)
    this.name = 'ViewActionError'
    this.reason = reason
  }
}

/** Where a click aimed at an element's centre point would actually land. */
interface ElementHit {
  /** The point that was probed, in the same viewport CSS pixels as bounds (ADR-0007). */
  point: { x: number; y: number }
  /** True when the topmost element there is the element itself or inside it. */
  same: boolean
  /** How the topmost element is named in a failure message. */
  description: string
}

/** What one in-page look at a snapshot element answers. */
interface ElementFacts {
  /** Whether the node the snapshot pinned is still in the document. */
  connected: boolean
  /** `tag#id "name"` — how the element is named in a failure message. */
  description: string
  /** Its rectangle, viewport-relative, exactly as `getBoundingClientRect()` reports it. */
  rect: ElementBounds
  /** Whether any part of that rectangle is inside the viewport. */
  inViewport: boolean
  /** What a click at the centre would hit, or null when no part of it is in the viewport. */
  hit: ElementHit | null
}

/**
 * Everything one look at a snapshot element answers, read in the page.
 *
 * It is deliberately *one* page function: the "is it still there", "is it in the
 * viewport", "what would a click hit" answers then describe one moment of one element,
 * instead of three round-trips that could straddle a DOM change and disagree.
 *
 * It answers questions; it does not decide. In particular it does **not** decide
 * visibility — the engine's own `:visible` predicate does that at action time (see
 * {@link AdoptedViewSession.targetOf}) — because a second, hand-rolled definition of
 * "visible" is exactly what ADR-0005 and ADR-0007 rule out.
 *
 * The hit test is the other half: `document.elementFromPoint` is the same coordinate
 * space the animation-free `bounds` are in, so "the point at the element's centre is
 * covered by something else" is answerable without re-deriving any geometry. The rule
 * for "the click lands on the element" is the engine's: the topmost element must be the
 * element itself or a descendant of it (a `<button>`'s inner `<span>` is normal).
 *
 * Self-contained on purpose: only this function's source crosses into the page, so a
 * helper defined beside it in this module would be a `ReferenceError` there.
 *
 * @param element - the element the ref pinned.
 * @returns the element's identity, geometry, and what a click at its centre would hit.
 */
function inspectElement(element: Element): ElementFacts {
  const describe = (node: Element): string => {
    const tag = node.tagName.toLowerCase()
    const id = node.getAttribute('id') ?? ''
    const label = node.getAttribute('aria-label') ?? ''
    const text = (node.textContent ?? '').trim().slice(0, 40)
    let out = tag
    if (id !== '') out += `#${id}`
    if (label !== '') out += ` "${label}"`
    else if (text !== '') out += ` "${text}"`
    return out
  }

  const box = element.getBoundingClientRect()
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  const inViewport = right > left && bottom > top
  let hit: ElementHit | null = null
  if (inViewport) {
    // The centre of the part of the element the viewport can see: probing a point
    // outside the viewport would answer about a different place on the screen.
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
    const landed = document.elementFromPoint(point.x, point.y)
    hit = {
      point,
      same: landed === element || (landed !== null && element.contains(landed)),
      description: landed === null ? 'nothing (no element is at that point)' : describe(landed),
    }
  }
  return {
    connected: element.isConnected,
    description: describe(element),
    rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    inViewport,
    hit,
  }
}

/** Where the top document says a point lands, and how it names what it found. */
interface TopHit {
  /** Whether any part of the rectangle is inside *this view's* viewport. */
  inViewport: boolean
  /** The probed point in view coordinates, or null when there was nothing to probe. */
  point: ViewPoint | null
  /** Whether what is on top there is the frame (or something inside it). */
  same: boolean
  /** How the topmost element is named in a failure message. */
  description: string
}

/**
 * Ask the **top document** what a point in view coordinates lands on.
 *
 * This is the half of the hit test that a frame's own document cannot answer: an element
 * inside an iframe can be perfectly uncovered *within its frame* while the iframe itself
 * is covered by something the parent drew over it. Probing the point in the top document
 * is what makes "the click would land on that cover, not on the element" answerable
 * across the frame boundary; the answer is compared against the iframe element, because
 * the top document's `elementFromPoint` answers the `<iframe>` for any point inside it.
 *
 * The point is clamped to the viewport the same way {@link inspectElement} clamps it, so
 * the two probes agree about what "the element's visible centre" is.
 *
 * Self-contained on purpose: only this function's source crosses into the page.
 *
 * One parameter, not two: `evaluate` hands the page function exactly one argument, so the
 * iframe and the rectangle travel as a tuple.
 *
 * @param input - the `<iframe>` the element's document hangs in, and the element's
 *   rectangle already translated into view coordinates.
 * @returns what the top document answered.
 */
function inspectInTopDocument(input: [Element, ElementBounds]): TopHit {
  const frameElement = input[0]
  const rect = input[1]
  const describe = (node: Element): string => {
    const tag = node.tagName.toLowerCase()
    const id = node.getAttribute('id') ?? ''
    const label = node.getAttribute('aria-label') ?? ''
    const text = (node.textContent ?? '').trim().slice(0, 40)
    let out = tag
    if (id !== '') out += `#${id}`
    if (label !== '') out += ` "${label}"`
    else if (text !== '') out += ` "${text}"`
    return out
  }

  const left = Math.max(rect.x, 0)
  const top = Math.max(rect.y, 0)
  const right = Math.min(rect.x + rect.width, window.innerWidth)
  const bottom = Math.min(rect.y + rect.height, window.innerHeight)
  if (!(right > left && bottom > top)) {
    return { inViewport: false, point: null, same: false, description: 'nothing (no part of it is in the view)' }
  }
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
  const landed = document.elementFromPoint(point.x, point.y)
  return {
    inViewport: true,
    point,
    same: landed === frameElement || (landed !== null && frameElement.contains(landed)),
    description: landed === null ? 'nothing (no element is at that point)' : describe(landed),
  }
}

/** Release handles, ignoring failures: disposal is housekeeping, never a result. */
async function disposeHandles(handles: Iterable<ElementHandle<Element>>): Promise<void> {  await Promise.all([...handles].map((handle) => handle.dispose().catch(() => undefined)))
}

/** The first line of an engine message, without the call log and the stack. */
function firstLine(message: string): string {
  const line = message.split('\n').find((candidate) => candidate.trim() !== '')
  return (line ?? message).trim()
}

/**
 * Cut text to a character cap without splitting a surrogate pair.
 *
 * The cap is a count of characters the caller receives, so a cut that left half of an
 * astral character behind would hand over something that is not the page's text any
 * more; stepping back off a low surrogate keeps every returned prefix well-formed.
 *
 * Exported because a tool that cuts its own text (the captured JSON) must cut it the
 * same way: one rule, two callers.
 *
 * @param text - the text to cut.
 * @param maxChars - the most characters to return.
 * @returns the text itself when it fits, otherwise its prefix.
 */
export function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = Math.max(0, maxChars)
  while (end > 0 && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1
  return text.slice(0, end)
}

/** Parse a JSON body, stripping common anti-XSSI prefixes. Returns undefined when it is not JSON. */
function parseJsonBody(raw: string): unknown {
  let json = raw.trim().replace(/^\)\]\}'\s*/, '').replace(/^while\(1\);\s*/, '')
  try {
    return JSON.parse(json)
  } catch {
    const start = json.search(/[{[]/)
    if (start > 0) json = json.slice(start)
    try {
      return JSON.parse(json)
    } catch {
      return undefined
    }
  }
}

/** The engine's own last word on why an action never landed, when it has one. */
function engineNote(message: string): string {
  const line = message
    .split('\n')
    .reverse()
    .find((candidate) => /intercepts pointer events|is not visible/.test(candidate))
  return line === undefined ? '' : line.replace(/^\s*-\s*/, '').trim()
}

/** Whether an engine failure is the "it never answered in time" kind. */
function isTimeoutFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bTimeout \d+ms exceeded\b/.test(message)
}

/**
 * Re-label an engine failure with the reason the caller can act on.
 *
 * The engine already knows *why* it gave up, but it says so inside a retry log whose
 * first line is always the same `Timeout … exceeded` — so reading only the first line
 * would collapse "something is on top of it", "it is not visible", "it is gone" and
 * "it never settled" into one indistinguishable failure. The classification below is
 * therefore by *evidence*, most specific first, and the covering element the engine
 * names in its log is carried into the message instead of being dropped with the log.
 *
 * @param error - whatever the engine threw.
 * @param subject - what was being attempted, already naming the ref and the element.
 * @returns the failure, with its reason.
 */
function classifyActionFailure(error: unknown, subject: string): ViewActionError {
  const message = error instanceof Error ? error.message : String(error)
  const intercepted = /(\S[^\n]*?)\s+intercepts pointer events/.exec(message)
  if (intercepted !== null) {
    return new ViewActionError(
      'obscured',
      `${subject} did not happen — ${intercepted[1].trim()} intercepts pointer events at the element's centre ` +
        'point, so the action would land on that element instead. Scroll it clear, move or dismiss the covering ' +
        'element, or act on the covering element itself.',
    )
  }
  const timedOut = /\bTimeout (\d+)ms exceeded\b/.exec(message)
  if (timedOut !== null) {
    const note = engineNote(message)
    return new ViewActionError(
      'timeout',
      `${subject} timed out after ${timedOut[1]}ms — the element never became actionable.` +
        (note === '' ? '' : ` The engine last reported: ${note}`),
    )
  }
  if (/not attached to the DOM|not connected|Node is detached/.test(message)) {
    return new ViewActionError(
      'not-found',
      `${subject} could not be done — the element is not in the document any more; ` +
        'call browser_snapshot and use a ref from that result.',
    )
  }
  if (/is not visible|Element is not visible/.test(message)) {
    return new ViewActionError(
      'not-visible',
      `${subject} could not be done — the element is not rendered (no box, or visibility: hidden).`,
    )
  }
  return new ViewActionError('failed', `${subject} failed: ${firstLine(message)}`)
}

/** Outcome of asking the endpoint for a page's own CDP target id. */
interface TargetProbe {
  /** The page's target id, when the endpoint answered. */
  targetId?: string
  /** Why the question could not be answered. Never silently dropped. */
  error?: string
}

/**
 * Read a page's CDP target id through a per-page CDP session.
 *
 * This is what turns "the shell says target X is the view" into a lookup that
 * Playwright can act on. Failures are reported rather than swallowed: a probe
 * that quietly returns nothing would look exactly like a broken handshake.
 *
 * @param context - the Playwright context owning the page.
 * @param page - the page to identify.
 * @returns the target id, or the reason it could not be read.
 */
async function probeTargetId(context: BrowserContext, page: Page): Promise<TargetProbe> {
  let cdpSession
  try {
    cdpSession = await context.newCDPSession(page)
    const { targetInfo } = await cdpSession.send('Target.getTargetInfo')
    const targetId = targetInfo?.targetId
    if (typeof targetId !== 'string' || targetId === '') {
      return { error: 'Target.getTargetInfo answered without a targetId' }
    }
    return { targetId }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (cdpSession !== undefined) await cdpSession.detach().catch(() => undefined)
  }
}

/** A page found in the shell's endpoint, tagged with the context that owns it. */
interface Candidate {
  context: BrowserContext
  page: Page
}

/**
 * 开一条**留在手里**的 CDP 会话（票 #18）。
 *
 * 与 {@link probeTargetId} 的分工是"读一次身份就关掉"与"留着问历史"：身份是一次性的问题，
 * 而"这个视图能退几格"要在会话的整个生命里反复问（领养时、每次导航之后、每次判断之前），
 * 所以这条会话不能像探针那样查完就 detach。
 *
 * 建不起来**不抛**：会话的其余能力（快照、点击、导航、缩放）都不依赖它，为一个历史读数
 * 让整个领养失败是把代价搞反了。代价是那时只剩账本兜底，而 `historyState` 会如实说
 * `source: 'observed'` —— 一句"读不到"必须说得出来，但不能变成"不能后退"。
 *
 * @param context - 拥有这块视图的 context。
 * @param page - 被领养的那块视图。
 * @returns 那条会话，或建不起来时的原因。
 */
async function openEngineChannel(
  context: BrowserContext,
  page: Page,
): Promise<{ session?: CDPSession; error?: string }> {
  try {
    return { session: await context.newCDPSession(page) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 这个视图的历史**到底**是什么：问引擎，问不到才退回账本（票 #18）。
 *
 * ## 为什么它存在
 *
 * 票 #18 的根因是"账本从来没记下**领养时视图已经在的那一页**"：`ObservedHistory` 只在
 * `framenavigated` 与 `reload()` 里记一笔，而领养那一刻视图**早就在某一页上了**。于是
 * 用户在真实外壳里的序列（视图先在内置测试页 → 只导航一次）得到账本 `[12306]`、`back = 0`，
 * 后退按钮被灰掉 —— 而引擎用**同一条 CDP 连接**答的是 `{currentIndex: 1, entryCount: 2}`：
 * 明明有一格可以退。
 *
 * 所以权威改成引擎的 `Page.getNavigationHistory`。它不是"多记一笔"的补丁：那个答案天然包含
 * 领养前就在的那一页、前进分支、以及**会话被重建**（切任务空间导致新的 targetId ⇒ 新会话）
 * 之后的历史 —— 账本在最后那种情形下会永远说"没有历史"，而引擎每次都重新答。
 *
 * 账本没有删，是因为它还有一件事可做：**引擎答不上来时**（CDP 会话建不起来、或那台引擎不认
 * 这个域）给一个可能低估的答案 —— 那时 {@link EngineHistoryReading.source} 会说 `observed`，
 * 让"引擎说退不动"与"我们只是没看见"是两句不同的话。
 *
 * ## 缓存的是"最近一次读到的"，而不是"引擎现在一定还是这样"
 *
 * 每次刷新都与引擎对一次话（一次 CDP 往返，不是轮询），而**每一次判断之前都会重新读一次**
 * （`browser_view` 的每个动作、面板的每次读回都读一遍）。所以一份过期的读数不会变成一次错的
 * 判断：判断用的一定是刚读到的那一份。
 */
class HistoryReader {
  /** 最近一次从引擎读到的历史；没读到过时缺席。 */
  private cached: EngineHistoryReading | undefined

  /** 上一次引擎答不上来时的原因；下一条把账本当读数的地方会把它带出去。 */
  private lastEngineError: string | undefined

  /**
   * @param session - 这个视图那条 CDP 会话；建不起来时缺席（那就只剩账本）。
   * @param ledger - 观察账本，兜底用。
   */
  constructor(
    private readonly session: CDPSession | undefined,
    private readonly ledger: ObservedHistory,
  ) {}

  /** 票 #20 F：最近一次引擎历史里那两个相邻页（读不到就是空，见 {@link neighbours}）。 */
  private neighbourCache: EngineHistoryNeighbours = {}

  /**
   * 问一次引擎，并把它答的记下来。
   *
   * @returns 引擎答的历史，答不上来时 {@link read} 会退到账本。
   */
  async refresh(): Promise<void> {
    if (this.session === undefined) {
      this.lastEngineError = 'this session holds no CDP channel to the engine'
      return
    }
    try {
      const raw = await this.session.send('Page.getNavigationHistory')
      const parsed = parseEngineHistory(raw)
      if (parsed === undefined) {
        this.lastEngineError = `Page.getNavigationHistory answered without a usable index and entry list: ${JSON.stringify(raw)}`
        this.cached = undefined
        this.neighbourCache = {}
        return
      }
      this.cached = { ...parsed, source: 'engine' }
      // 票 #20 F：同一份原始回答里那两个相邻页（悬停提示要的）。失败路径上它跟着清空 ——
      // 一份"上一次读到过的目标"继续当权威，与票 #18 修掉的那个毛病是同一个形状。
      this.neighbourCache = parseEngineNeighbours(raw)
      this.lastEngineError = undefined
    } catch (error) {
      // 读不到就**如实退到账本**，并把上一次那份读数丢掉：一份"曾经对过"的读数继续当权威，
      // 就是拿一个可能过期的数去回答"现在能不能退"（票 #18 的教训正是读数与事实对不上）。
      // 退到账本的代价是**可能低估**（按钮灰得多一点），而高估是让用户按一颗撒谎的按钮。
      this.lastEngineError = error instanceof Error ? error.message : String(error)
      this.cached = undefined
      this.neighbourCache = {}
    }
  }

  /**
   * 这份历史里**相邻的那两页**（票 #20 F 的悬停提示）。
   *
   * 与 {@link read} 同源同一次读：都出自最近一次 `Page.getNavigationHistory`。
   * 引擎没答上来时这里是空的 —— 那时面板一个字的提示都不给（见 `src/toolbar.js` 的
   * `travelHint`），而不是拿账本里那条只有地址的账去凑一句。
   *
   * @returns 两个方向各自的目标（可能各自缺席）。
   */
  neighbours(): EngineHistoryNeighbours {
    return this.cached === undefined ? {} : this.neighbourCache
  }

  /**
   * 现在这一份历史：引擎优先，账本次之。
   *
   * @returns 两个计数 + 它们是哪来的；引擎答不上来时带上引擎说的那句话。
   */
  read(): EngineHistoryReading {
    if (this.cached !== undefined) return this.cached
    const fromLedger = this.ledger.state()
    return {
      ...fromLedger,
      source: 'observed',
      ...(this.lastEngineError !== undefined ? { reason: this.lastEngineError } : {}),
    }
  }

  /**
   * 视图现在在这一页上。
   *
   * 引擎能答时**以引擎为准重读一次**：那是唯一一个分得清"走了一段新路"（前进分支要清掉）
   * 与"后退了一步"（前进分支要冒出来）的地方，而 `framenavigated` 对这两件事报的是同一个事件。
   * 引擎答不上来时才走账本那条老规矩（同地址去重、新地址清前进分支）。
   *
   * 它是异步的、且 `framenavigated` 那条路**不 await**（事件监听器不许把一个页面事件变成一次
   * 等待）：晚一拍变新没有代价 —— 每一个判断之前都会再问一次引擎（{@link refreshHistory}）。
   *
   * @param url - 引擎报的新文档地址；**给 `undefined` 就只问引擎、账本一个字不记**。
   *   只有"本会话自己发起的那一次"会这么调：自己发起的后退/前进不是"走了一段新路"，
   *   而账本那条兜底路分不清这两件事 —— 它的老规矩正是"看到新文档就清掉前进分支"
   *   （实测过后果：`back` 成功、`forward` 立刻说"没有可前进的一页"）。
   */
  async observe(url: string | undefined): Promise<void> {
    await this.refresh()
    if (this.cached !== undefined || url === undefined) return
    this.ledger.observe(url)
  }

  /**
   * 一次**自己发起**的导航落定之后。
   *
   * 引擎答不上来时要自己把这一步记进账本（那时才是账本的活儿）：`framenavigated` 那条路
   * 被 `pendingTravel` 拦住了，它一个字都不会记。
   *
   * @param url - 动作之后视图的地址。
   */
  async recordTravel(url: string): Promise<void> {
    await this.refresh()
    if (this.cached !== undefined) return
    this.ledger.observe(url)
  }
}

/**
 * Find the page that corresponds to the requested view.
 *
 * Primary identity is the target id the shell published. The URL is a secondary
 * fallback only, because the view navigates and URLs are not identities.
 *
 * @param browser - the connected browser.
 * @param handle - the requested identity.
 * @returns the matching candidate, or undefined when no single page matches exactly one page.
 */
async function findView(browser: Browser, handle: ViewHandle): Promise<Candidate | undefined> {
  const candidates: Candidate[] = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) candidates.push({ context, page })
  }
  if (handle.targetId !== undefined) {
    for (const candidate of candidates) {
      // A `type: "page"` target nested in a frame has its own target id; asking the
      // page-level session for its own target info keeps the match exact.
      const probe = await probeTargetId(candidate.context, candidate.page)
      if (probe.targetId === handle.targetId) return candidate
    }
    return undefined
  }
  if (handle.url !== undefined) {
    const byUrl = candidates.filter((candidate) => candidate.page.url() === handle.url)
    return byUrl.length === 1 ? byUrl[0] : undefined
  }
  return undefined
}

/** Render why adoption failed, including what the endpoint actually exposed. */
async function describeFailure(browser: Browser, handle: ViewHandle): Promise<string> {
  const seen: string[] = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const probe = await probeTargetId(context, page)
      seen.push(`${probe.targetId ?? `<unreadable: ${probe.error}>`} url=${page.url()}`)
    }
  }
  return (
    `no page matched the requested view (targetId=${handle.targetId ?? '<none>'}, ` +
    `url=${handle.url ?? '<none>'}); the endpoint exposed ${seen.length} page(s): ` +
    (seen.length === 0 ? '<none>' : seen.join(', '))
  )
}

/** One adopted native view. Disconnecting never closes the shell that owns it. */
export class AdoptedViewSession {
  private closed = false

  /**
   * `ref` (the 1-based snapshot index) → the element itself, as of the most recent
   * snapshot. Emptied by every snapshot and by every navigation, so a `ref` can only
   * ever address the document — and the node — it was read from.
   *
   * It is the *node*, not "the Nth match of the snapshot selector", and that is the
   * difference between a ref that means something and a number that happens to resolve:
   * the selector's match order is not stable, so after an in-page reorder (a framework
   * re-render, a list that moved a row) the same index resolves to a different element
   * and an action would silently act on it. Pinning costs one query per snapshot and
   * makes the opposite failure — acting on the wrong element — impossible, while the
   * right failure — the element is gone — becomes reportable (ADR-0008).
   *
   * Since T9 an entry pins the *frame* as well as the node, because "which element" is
   * not a complete answer inside a page that has frames: the same control exists in the
   * top document and in every frame that embeds the same markup, and a ref that did not
   * know its frame could land in the wrong one.
   */
  private refs = new Map<number, RefEntry>()

  /**
   * The agent's answer policy for dialogs that appear later, and the dialogs seen so far.
   *
   * Both are per session and both are *answers*, never waits: the policy is read when a
   * dialog opens, answered immediately, and recorded — so a page that raises a dialog in
   * the middle of an action never blocks, and the action can still say what was asked
   * (see {@link AdoptedViewSession.answerDialog}).
   */
  private dialogPolicy: DialogPolicy = { ...DEFAULT_DIALOG_POLICY }
  private dialogRecords: DialogRecord[] = []

  /**
   * Downloads that *began* while this session was watching.
   *
   * The event is Playwright's, and it is reliable here (measured); what it does **not**
   * carry is where the bytes went — on this host `download.path()` answers a path in
   * `playwright-artifacts-*` where no file exists (ADR-0011). So these records say
   * "a download started", and the shell's journal says what became of it.
   */
  private downloadStarts: DownloadStart[] = []

  /**
   * What the current document said about itself while the session watched: the JSON it
   * received, the console messages it produced, and the requests it made that failed.
   *
   * All three belong to the *document*, not to the session, so they are emptied when
   * the view navigates: answering "why is this page empty" with an error the previous
   * page produced is worse than answering nothing. Bounded, because a page that logs in
   * a loop must not grow the session without limit.
   *
   * They are captured by listeners rather than polled, because the interesting facts —
   * a console error, a 404 — happen once, while the page is loading, and a buffer read
   * after the fact cannot recover what nobody was listening for (T5).
   */
  private jsonResponses: JsonResponseRecord[] = []
  private consoleMessages: ConsoleMessageRecord[] = []
  private failedRequests: FailedRequestRecord[] = []

  /**
   * 这个会话**自己看着视图走过**的那些页（T13）。
   *
   * 记它的理由是"能不能后退"这个问题在本引擎上没有只读答案：Playwright 的
   * `goBack()` 是一个动作而不是一次查询，`history.length` 又跨源不可靠。所以面板上
   * 那两颗按钮亮不亮由 {@link HistoryReader} 回答：**引擎的**历史优先，这份账本兜底 ——
   * 见 {@link ObservedHistory} 里那段"它可能低估、但不会撒谎"的说明。
   */
  private readonly history = new ObservedHistory()

  /**
   * 这个视图**真实**的历史（票 #18）：引擎优先，账本兜底。
   *
   * 记它的理由是"能不能后退"这个问题在 Playwright 那一层没有只读答案（`goBack`/`goForward`
   * 是动作而不是查询），但**引擎自己有**：`Page.getNavigationHistory` 就在同一条 CDP 连接上
   * （`context.newCDPSession(page)` —— T1 用它读身份，这条连接早已存在，不是新通道）。
   * 见 {@link HistoryReader} 里那段"票 #18 的根因"。
   */
  private readonly historyReader: HistoryReader

  /**
   * 谁来真的改这块视图的缩放，以及外壳上次读回来的那个数（T13）。
   *
   * 两者一起进来：口子回答"怎么改"，起点回答"现在是多少"。少了口子，`zoomTo` 会如实
   * 说不能缩放；少了起点，会话只会说 1（100%），而那是**不知道**，不是事实 ——
   * 面板上显示的数因此永远来自外壳的读回。
   */
  /**
   * 现在是多少（1 = 没缩放）。
   *
   * 它**只在外壳读回来之后**才被改写：请求里的那个数是愿望，`getZoomFactor()` 那个数才是事实。
   * 它与页面读到的 `devicePixelRatio` 不是一回事（外壳侧是 `屏幕dpr × zoom`），见 {@link zoomTo}。
   */
  private currentZoom: number

  /**
   * 上一次从页面读回来的那三件事（票 #20 E）。
   *
   * 它是 {@link settle} 唯一的参照物：判"页面跟上新缩放了没有"时，拿**上一次的实测读数**按
   * 比例推这一次该是多少 —— 于是没有"记住屏幕 dpr"这种会过期的常数。会话没有这一步时
   * （还没做过任何缩放）它是 `undefined`，那就没有参照，也就不用等。
   */
  private lastViewport: { zoom: number; innerWidth: number; innerHeight: number; devicePixelRatio: number } | undefined

  /**
   * What the injected cursor overlay is told to draw (T8).
   *
   * It is data, not behaviour: the page-side functions receive this object whole, so
   * there is exactly one place that says what a mark looks like — and that place can be
   * unit-tested without a browser.
   */
  private readonly overlay: OverlayConfig = overlayConfig()

  /**
   * Resolves once the overlay exists in the current document.
   *
   * Marks wait on it, so an action taken immediately after adoption is not drawn into a
   * document that has no overlay yet. It is never awaited by an action's result: the
   * overlay is a hint, and a hint must not be able to fail an action.
   */
  private overlayReady: Promise<void> = Promise.resolve()

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    /** CDP target id of the adopted view. */
    readonly targetId: string,
    private readonly timeoutMs: number,
    private readonly maxElements: number,
    /**
     * Cap on the characters a text read returns. Read by the tools that cut their own
     * text (T5), so one cap governs every read that can be long.
     */
    readonly maxChars: number,
    /**
     * Where the shell publishes its downloads, when there is a shell that does. Absent
     * means `downloads()` has to say "there is nothing to ask" rather than "none" (T9).
     */
    private readonly downloadJournalFile: string | undefined,
    /**
     * 外壳在握手里说的**初始页**（`viewUrl`），「重新开始」用它（T13）。
     *
     * 它是一次快照，不是"视图现在在哪"：视图会导航走，而这个值说的是外壳当初把它放在哪。
     */
    private readonly initialUrl: string | undefined,
    /**
     * 缩放那道口子（T13）。缺省 = 这个会话没有外壳可问，`zoomTo` 会如实说不能缩放。
     */
    private readonly zoomPort: ViewZoomPort | undefined,
    /**
     * 领养时外壳**已经读回**的缩放值。
     *
     * 它只是起点：之后每一次缩放都以 `getZoomFactor()` 的读回值为准。外壳没说时是 1 ——
     * 那表示"不知道"，而面板上显示 `100%` 与"没缩放过"在这个部署里是同一个状态。
     */
    zoom: number,
    /**
     * 这个视图**真实**的历史从哪读（票 #18）：拿在手里的那条 CDP 会话。
     *
     * 它缺席时（建不起来）会话只剩账本那条兜底路，{@link historyState} 会如实说 `observed`。
     */
    private readonly cdp: CDPSession | undefined,
  ) {
    this.currentZoom = zoom
    this.historyReader = new HistoryReader(cdp, this.history)
    // A `ref` is an index into *this* document. When the view navigates on its own —
    // a link, a form submit, a redirect — the next element at that index is a
    // different element, and resolving the old index against it would act on
    // something the model never named. Dropping the table once the new document has
    // finished loading is housekeeping, not the guarantee: every action compares the
    // document identities itself, because from the moment a navigation commits until
    // its load event a reference taken from the old document is meaningless — and, on
    // a pinned node, already dead. A handle does not survive a document swap either:
    // it belongs to an execution context, so the token check stays the thing that
    // answers with the reason, and this listener only releases what it can (ADR-0008).
    page.on('load', () => {
      void this.forgetRefs()
    })
    // The observations above belong to one document, so they start again with the next
    // one. The event is the main frame's navigation *commit* rather than its load, because
    // a document that is still loading already has its own console and its own requests,
    // and clearing at load would throw away exactly the errors that explain a page that
    // never finishes.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      this.forgetPageObservations()
      // 历史（T13 / 票 #18）：一次导航等于"视图现在在这一页上"。交给 {@link HistoryReader}：
      // 引擎答得上就以引擎为准**重读一次**（只有它分得清"走了一段新路"与"后退了一步"——
      // 前者要清掉前进分支，后者要让它冒出来，而 `framenavigated` 对两件事报的是同一个事件）；
      // 引擎答不上来才走账本那条老规矩（同地址由 {@link ObservedHistory.observe} 去重）。
      //
      // 不 await：这是页面事件，不许让一个事件变成一次等待。晚一拍变新没有代价 ——
      // 每一个判断之前都会重新问一次引擎（见 {@link historyState} 与 {@link travel}）。
      void this.observeNavigation(page.url())
      // The overlay lives in the document, so the next document needs its own. Two
      // mechanisms, both idempotent, because they cover different windows: the init
      // script gets the overlay in before the new document can paint anything, and this
      // hook re-asserts it on the commit the observation buffers already hang off — one
      // lifecycle instead of two. Measured (T8): an `evaluate` alone does *not* survive a
      // navigation, either mechanism on its own *does* re-mount on a real navigation, and
      // the init script runs while `document.documentElement` is still null — which is
      // why the mount carries its own `DOMContentLoaded` fallback.
      void this.mountOverlayInPage()
    })
    page.on('console', (message) => {
      const location = message.location()
      this.pushConsole({
        type: message.type(),
        text: message.text(),
        location:
          location.url === ''
            ? '<unknown>'
            : `${location.url}:${location.lineNumber}:${location.columnNumber}`,
      })
    })
    // An uncaught exception is what most often leaves a page empty, and the console does
    // not always carry it in a readable form, so it is recorded under its own type.
    page.on('pageerror', (error) => {
      this.pushConsole({ type: 'pageerror', text: firstLine(error.message), location: '<uncaught>' })
    })
    page.on('response', (response) => {
      void this.captureResponse(response)
    })
    page.on('requestfailed', (request) => {
      this.pushFailedRequest({
        method: request.method(),
        url: request.url(),
        status: 0,
        statusText: '(no response)',
        summary: request.failure()?.errorText ?? 'the request failed with no reason reported',
      })
    })
    // Dialogs (T9). The handler is `async` **on purpose**: measured against this engine,
    // a handler that returns nothing counts as "nobody is handling this dialog" and
    // Playwright closes it itself, while a handler that returns a promise takes
    // responsibility — and a promise that never settles blocks the page for as long as it
    // hangs. This one always settles, immediately, from the policy.
    page.on('dialog', async (dialog) => {
      await this.answerDialog(dialog)
    })
    // Downloads (T9). Only the *beginning* is observable from here; where the bytes go is
    // the shell's answer, because on this host Playwright's own `download.path()` points
    // at a file that does not exist (ADR-0011). Recording the start is what lets a click
    // that saved a file say so instead of reporting a page that never changed.
    page.on('download', (download) => {
      this.pushDownloadStart({
        url: download.url(),
        filename: download.suggestedFilename(),
        at: Date.now(),
      })
    })
    // The overlay (T8): the document the session adopted right now gets one, and every
    // later document gets one from the init script registered here. Both are fire and
    // forget — a hint that cannot be drawn is not a reason for adopting a view to fail.
    // The promise is kept only so a mark drawn immediately after adoption waits for the
    // mount instead of landing in a document that has no overlay yet.
    this.overlayReady = page
      .addInitScript(mountOverlay, this.overlay)
      .then(async () => await this.mountOverlayInPage())
      .catch(() => undefined)
  }

  /**
   * Connect to the shell and take over the view it published.
   * @param options - endpoint, view identity, timeouts, and the read caps.
   * @returns a session bound to the view.
   * @throws when no single page matches the published identity.
   */
  static async adopt(options: AdoptOptions): Promise<AdoptedViewSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
    const browser = await chromium.connectOverCDP(options.cdpUrl, { timeout: timeoutMs })
    try {
      const match = await findView(browser, options)
      if (match === undefined) {
        throw new Error(await describeFailure(browser, options))
      }
      const probe = await probeTargetId(match.context, match.page)
      if (probe.targetId === undefined) {
        throw new Error(`the adopted view's target id could not be read: ${probe.error}`)
      }
      // 历史那条路（票 #18）：**同一条** CDP 连接上的一个会话，留在手里反复问
      // `Page.getNavigationHistory`。不需要任何新通道 —— T1 读身份用的就是它。
      const engine = await openEngineChannel(match.context, match.page)
      return new AdoptedViewSession(
        browser,
        match.context,
        match.page,
        probe.targetId,
        timeoutMs,
        maxElements,
        maxChars,
        options.downloadJournalFile,
        // 「重新开始」要回到的那一页：**外壳在握手里说的**那句 `viewUrl`（T13）。
        // 没给就没有初始页，`restart()` 会如实退到 `about:blank` 并说出来。
        options.url,
        // 缩放（T13）：口子与"外壳读回来的起点"。两个一起传，因为"怎么改"和"现在是多少"
        // 是同一件事的两半；少了口子，`zoomTo` 会如实说不能缩放。
        options.zoomPort,
        options.zoom ?? 1,
        engine.session,
      )
    } catch (error) {
      // A failed adoption must not leave a dangling connection behind.
      await browser.close().catch(() => undefined)
      throw error
    }
  }

  /** Navigate the view and report where it landed. */
  async goto(url: string): Promise<NavigationResult> {
    this.assertOpen()
    // Belt and braces beside the `load` listener: a navigation is the one event that
    // definitely invalidates every ref, and it is about to happen, not merely possible.
    // The handles are released here rather than merely dropped, so a page that is
    // navigated over and over does not leave the previous document's nodes pinned.
    void this.forgetRefs()
    const mark = this.activityMark()
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs })
    } catch (error) {
      // A page with a `beforeunload` guard cannot be navigated away from, and the engine
      // reports that as a bare `net::ERR_ABORTED` — which reads like a network problem
      // and is not one. The dialog that was answered on the way is the evidence that says
      // what really happened, so it is what the failure is built from (T9).
      const guarded = this.activitySince(mark).dialogs.find((record) => record.type === 'beforeunload')
      if (guarded !== undefined) throw new ViewActionError('page-guard', this.pageGuardMessage(url))
      throw error
    }
    return { title: await this.page.title(), url: this.page.url() }
  }

  /** Why a navigation did not happen: the page's own guard refused to leave. */
  private pageGuardMessage(url: string): string {
    return (
      `browser-view: the page refused to leave, so the view is still at ${this.page.url()} — it has a ` +
      `beforeunload guard (unsaved changes) and the navigation to ${url} was cancelled. Answering that ` +
      'dialog with "accept" does not help: measured on this host it neither lets the navigation through nor ' +
      'returns promptly. Deal with the page first (save, or drop the guard with browser_evaluate), then navigate.'
    )
  }

  /**
   * 这个会话正在等一次**自己发起**的后退/前进。
   *
   * 它只剩一个用处：**账本那条兜底路**（引擎答不上来时）不许把"后退了一步"记成"走了一段新路"
   * —— 后者会清掉前进那一侧，实测过它的后果（`back` 成功、`forward` 立刻说"没有可前进的一页"）。
   * 引擎那条路上它没有意义：{@link HistoryReader} 读的是引擎自己的历史，而引擎本来就分得清
   * 那两件事。
   *
   * 记账的入口是 {@link travel}（自己发起）与 `framenavigated`（别的来源），这里只说明为什么
   * 前者要拦一下 {@link HistoryReader.observe}。
   */
  private pendingTravel = 0

  /**
   * 一次导航上报的处理（`framenavigated` 与 `reload()` 都走它）。
   *
   * 引擎答得上时它只是"以引擎为准重读一次"：引擎本来就分得清"走了一段新路"与"后退了一步"，
   * 所以**自己发起的那一次不需要特殊对待**。引擎答不上来时它落到账本上，而那条规矩
   * （自己发起的那一次让路）由调用方先拦住 —— 见 {@link pendingTravel}。
   *
   * @param url - 引擎报的新文档地址。
   */
  private async observeNavigation(url: string): Promise<void> {
    // 自己发起的那一次（`pendingTravel > 0`）在**引擎答不上来**时不许喂账本：那一步是后退/前进，
    // 不是"走了一段新路"。引擎答得上时这条判断不生效（读数来自引擎，账本不参与）。
    await this.historyReader.observe(this.pendingTravel > 0 ? undefined : url)
  }

  /**
   * 重新问一次引擎（票 #18），并让账本跟着走。
   *
   * 每一个判断之前都调它：一张过期的读数会变成一次错的判断，而一次 CDP 往返换一句"这是引擎
   * 刚说的"是划算的。
   */
  private async refreshHistory(): Promise<void> {
    await this.historyReader.observe(this.page.url())
  }

  /**
   * 这个视图的历史：还能后退/前进几页，**以及这份数是从哪来的**（T13 / 票 #18）。
   *
   * 它是异步的，因为它每次都**真的去问一次引擎**，而不是读一个可能过期的缓存：票 #18 的
   * 全部教训就是"面板上/工具里那个数必须来自一次真的读回"。引擎答不上来时退到账本，
   * 读数里的 `source` 会说 `observed`、`reason` 会带上引擎说的那句话。
   *
   * @returns 两个计数 + 来源，面板上的两颗按钮与 `browser_view` 的 `canGoBack` 都看它。
   */
  async historyState(): Promise<EngineHistoryReading> {
    if (this.closed) return this.historyReader.read()
    await this.refreshHistory()
    return this.historyReader.read()
  }

  /**
   * 回到上一页（T13）。
   *
   * @returns 发生了就 `moved: true` 并带新地址；没发生就带**分类**（`no-history` /
   *   `page-refused` / `timeout` / `failed`），不抛 —— 见 {@link HistoryActionResult}。
   */
  async goBack(): Promise<HistoryActionResult> {
    return await this.travel('back')
  }

  /**
   * 走到下一页（T13）。
   *
   * @returns 与 {@link goBack} 同一形状。
   */
  async goForward(): Promise<HistoryActionResult> {
    return await this.travel('forward')
  }

  /**
   * 重新加载当前页（T13）。
   *
   * 与后退/前进分开写，因为它的失败只有两类：页面自己的 `beforeunload` 拦住了（未保存的改动），
   * 或者超时 —— "没有历史"对它没有意义，把它硬塞进同一个分类会让模型去查一件不存在的事。
   *
   * @returns 与 {@link goBack} 同一形状。
   */
  async reload(): Promise<HistoryActionResult> {
    this.assertOpen()
    // 重载会换文档，所以 ref 立即作废（与 `goto` 同一个理由）。
    void this.forgetRefs()
    const mark = this.activityMark()
    try {
      await this.page.reload({ waitUntil: 'load', timeout: this.timeoutMs })
      await this.observeNavigation(this.page.url())
      return {
        url: this.page.url(),
        title: await this.titleQuietly(),
        moved: true,
        history: await this.historyState(),
      }
    } catch (error) {
      const guarded = this.activitySince(mark).dialogs.find((record) => record.type === 'beforeunload') !== undefined
      const classified = classifyNavigationFailure(error, guarded)
      return {
        url: this.page.url(),
        title: await this.titleQuietly(),
        moved: false,
        reason: classified.reason,
        message: await this.navigationFailureMessage('reload', classified.reason, error),
        history: await this.historyState(),
      }
    }
  }

  /**
   * 后退或前进的共同实现。
   *
   * ## 票 #18：先问引擎，再动手 —— 判断与动作必须是同一份事实
   *
   * 这张脸的旧写法是"引擎先真的退一步，再看账本 `move()` 成不成"，而账本可能压根不知道有
   * 那一格（领养时视图已经在的那一页从来没进过账本）。于是**页面真的动了，模型却被告知没动**
   * —— 工具报 `moved: false` / `no-history`，而那一步已经走掉了。
   *
   * 现在反过来：动手之前先问一次引擎（`Page.getNavigationHistory`）。**引擎说**没有那一格就
   * **不碰页面**，如实报 `no-history`；引擎说有（或者引擎答不上来 —— 见下）就动作，而 `moved`
   * 是**页面自己说的**（地址真的变了没有），不是账本推断的。两句话因此不可能再打架：
   *
   * - 引擎答"没有" ⇒ 页面一动不动 + `moved: false`，两者一致；
   * - 引擎答"有" ⇒ 动作 + `moved: true`，两者一致；
   * - **引擎答不上来**（`source: 'observed'`）⇒ 照样动作，让引擎自己去试。这一条是要害：
   *   账本说"没有"时**不许**因此拒绝动手 —— 那正是票 #18 的第二张脸（账本说没有、引擎其实能退，
   *   于是页面动了而模型被告知没动）。引擎这条路上"能不能"由动作本身回答：`goBack()` 在没有
   *   那一页时返回 `null` 且地址不变，那才是"真的没有"。
   *
   * @param direction - 往哪边走。
   * @returns 与 {@link goBack} 同一形状。
   */
  private async travel(direction: 'back' | 'forward'): Promise<HistoryActionResult> {
    this.assertOpen()
    void this.forgetRefs()
    const mark = this.activityMark()
    const before = this.page.url()
    // 自己发起的那一次：`framenavigated` 那条账本路让路（见 `pendingTravel`），
    // 落定之后由下面那句 `historyReader.recordTravel` 记账。
    this.pendingTravel += 1
    try {
      // 动手之前那一次读数：它是"有没有那一格"的唯一依据，也是 `no-history` 那句话写什么
      // 的依据（`source` 为 `observed` 时那句话必须说清"我们读到的是账本"，而不是断言引擎）。
      const reading = await this.historyState()
      const available = direction === 'back' ? reading.back > 0 : reading.forward > 0
      if (!available && reading.source === 'engine') {
        return {
          url: before,
          title: await this.titleQuietly(),
          moved: false,
          reason: 'no-history',
          message: this.noHistoryMessage(direction, before, reading),
          history: reading,
        }
      }
      const response = direction === 'back' ? await this.page.goBack({ timeout: this.timeoutMs }) : await this.page.goForward({ timeout: this.timeoutMs })
      const after = this.page.url()
      const moved = response !== null || after !== before
      await this.historyReader.recordTravel(after)
      const settled = this.historyReader.read()
      return {
        url: after,
        title: await this.titleQuietly(),
        moved,
        ...(moved ? {} : { reason: 'no-history' as const, message: this.noHistoryMessage(direction, before, settled) }),
        history: settled,
      }
    } catch (error) {
      const guarded = this.activitySince(mark).dialogs.find((record) => record.type === 'beforeunload') !== undefined
      const classified = classifyNavigationFailure(error, guarded)
      // "没有那一页"那句话要用**刚读到**的那一份，所以先刷新再写：一次失败的导航之后立刻
      // 报一份旧读数，正好会复现票 #18 那种"说的与做的不一致"。
      return {
        url: this.page.url(),
        title: await this.titleQuietly(),
        moved: false,
        reason: classified.reason,
        message: await this.navigationFailureMessage(direction, classified.reason, error),
        history: this.historyReader.read(),
      }
    } finally {
      // 自己发起的那一次结束了：`framenavigated` 重新开始记账。
      this.pendingTravel = Math.max(0, this.pendingTravel - 1)
    }
  }

  /**
   * "没有那一页"那句话（T13 / 票 #18）。
   *
   * 它必须分得清两种情形，因为补救不同 —— 而把两者说成一句正是票 #18 的成因：
   * 引擎答"退不动"时那是一句事实；只有账本可读时那只是**没看见**，用户按一次真的后退
   * 说不定就成了（旧写法在这里让模型去查一件不存在的事）。
   *
   * @param direction - 走哪个方向。
   * @param where - 视图现在在哪。
   * @param reading - 判断用的那份读数（含它从哪来）。
   * @returns 那句人话。
   */
  private noHistoryMessage(direction: 'back' | 'forward', where: string, reading: EngineHistoryReading): string {
    if (reading.source === 'engine') {
      return (
        `browser-view: there is no page to go ${direction} to — the view stayed at ${where}. The engine's own ` +
        `navigation history says so (currentIndex ${reading.back}, ${reading.back + reading.forward + 1} entries), ` +
        `so this is a fact about the view, not a guess. Use browser_navigate to open a page first.`
      )
    }
    return (
      `browser-view: no page to go ${direction} to could be found — the view stayed at ${where}. This is **not** a ` +
      `statement about the view: the engine could not be asked for its navigation history ` +
      `(${reading.reason ?? 'no reason reported'}), so all this session has is the history it watched itself, and ` +
      `that ledger does not contain a page to go ${direction} to. A page the view was already on before this ` +
      'session adopted it is not in that ledger. Try the action anyway, or use browser_navigate.'
    )
  }

  /** 失败那句话：分类 + 引擎原文 + 补救。分类是**值**，所以调用方不必解析这段散文。 */
  private async navigationFailureMessage(
    action: string,
    reason: NavigationFailureReason,
    error: unknown,
  ): Promise<string> {
    const raw = firstLine(error instanceof Error ? error.message : String(error))
    const where = this.page.url()
    if (reason === 'page-refused') return this.pageGuardMessage(where)
    if (reason === 'no-history') {
      // 走这条路说明**引擎真的抛了**"没有那一页"（`goBack` 在别的引擎上抛，本引擎返回
      // `null`），所以那句话以引擎的原话为准；状态先刷新一次，好让紧随其后的那份读数是刚读到的。
      await this.refreshHistory()
      return (
        `browser-view: there is no page to go ${action} to — the view stayed at ${where}. The engine itself said: ` +
        `${raw}. This is a fact about the view, not a guess (see its own navigation history). ` +
        'Use browser_navigate to open a page first.'
      )
    }
    if (reason === 'timeout') {
      return (
        `browser-view: ${action} did not finish within ${this.timeoutMs}ms — the view is at ${where} and may be ` +
        `mid-navigation. The engine said: ${raw}. This one is worth retrying; a page that never finishes loading ` +
        'is a different problem (see browser_diagnostics).'
      )
    }
    return `browser-view: ${action} failed and the view is still at ${where}. The engine said: ${raw}.`
  }

  /** 标题，读不到就给空串（导航失败那一刻页面可能正在换文档，读标题本身会抛）。 */
  private async titleQuietly(): Promise<string> {
    try {
      return await this.page.title()
    } catch {
      return ''
    }
  }

  /**
   * 面板要显示的那一整份状态，**一次读完**（T13）。
   *
   * 为什么是一个方法而不是五六个 getter：票面要求"面板显示的东西必须来自独立读回"，
   * 而"独立"要经得起一次读一半——分成六次调用的话，面板上那个 URL、缩放百分比与两个按钮
   * 的可用性可能来自**不同的瞬间**（中间隔着一次用户按下的动作），于是面板显示的是一个
   * 从未存在过的组合。一次读完，它们描述的是同一刻。
   *
   * @returns 读自视图自己与页面自己的事实；读不到的那些如实缺席，不编。
   */
  async displayState(): Promise<ViewDisplayState> {
    this.assertOpen()
    let innerWidth: number | undefined
    let innerHeight: number | undefined
    let devicePixelRatio: number | undefined
    let loading: boolean | undefined
    try {
      const seen = await this.page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        // 票 #20 F：这一页还在加载中吗 —— 页面自己说的，不是我们猜的。
        loading: document.readyState !== 'complete',
      }))
      innerWidth = seen.innerWidth
      innerHeight = seen.innerHeight
      devicePixelRatio = seen.devicePixelRatio
      loading = seen.loading
    } catch {
      // 页面正在换文档时读不到：如实缺席，面板那边显示"读不到"比显示一个旧值好。
    }
    // 历史读一次、用两处：面板上的两颗按钮与"这份数是从哪来的"必须描述同一个瞬间
    // （票 #18 加的那个来源字段说的就是这份读数的来源，分成两次读就会自相矛盾）。
    const reading = await this.historyState()
    // 缩放（票 #19）**当场读回来**，不是报会话记的那个数：自动适配会在没人请求的时候改它，
    // 而这份读数的用途正是让人看见"现在是多少、谁在管"。读不到就退回会话记的值，
    // 并且**不声称**任何模式（`zoomMode` 缺席）—— "不知道谁在管"不该被渲染成"自动在管"。
    const fresh = await this.readZoomQuietly()
    const neighbours = this.historyReader.neighbours()
    return {
      url: this.page.url(),
      title: await this.titleQuietly(),
      zoom: fresh?.zoom ?? this.currentZoom,
      ...(fresh !== undefined ? { zoomMode: fresh.mode } : {}),
      ...(devicePixelRatio !== undefined ? { devicePixelRatio } : {}),
      ...(innerWidth !== undefined ? { innerWidth } : {}),
      ...(innerHeight !== undefined ? { innerHeight } : {}),
      ...(loading !== undefined ? { loading } : {}),
      history: { back: reading.back, forward: reading.forward },
      historySource: reading.source,
      ...(neighbours.back !== undefined || neighbours.forward !== undefined ? { neighbours } : {}),
      ...(this.initialUrl !== undefined && this.initialUrl !== '' ? { initialUrl: this.initialUrl } : {}),
    }
  }

  /**
   * 现在是多少（1 = 没有缩放）。它是**会话记的**那个数。
   *
   * 票 #19 起这句话要加一个限定：自动适配会在没人请求的时候改缩放，所以这个数可能比外壳
   * 知道的旧。要"现在真的是多少"就用 {@link displayState}（那次读数当场问外壳），
   * 或者 {@link refreshZoom}（把会话记的这个数刷新到外壳说的那个）。
   */
  zoomLevel(): number {
    return this.currentZoom
  }

  /**
   * 把会话记的那个缩放刷新到**外壳现在说的那个**（票 #19）。
   *
   * 为什么需要它：自动适配会在没人请求的时候改缩放（外壳按栏宽自己算），于是 `currentZoom`
   * 会过期；而 `−` / `+` 是**相对**当前值走一档的，起点错了就走到错的档位上。
   *
   * 读不到（没有那条读回、外壳已关、文件还没写过）就**什么都不做**：沿用自己记的值，
   * 不编一个。它不抛 —— 缩放的起点读不回来不该让一次缩放动作失败。
   *
   * @returns 刷新之后的值（刷新不了就是原来的那个）。
   */
  async refreshZoom(): Promise<number> {
    const fresh = await this.readZoomQuietly()
    if (fresh !== undefined) this.currentZoom = fresh.zoom
    return this.currentZoom
  }

  /**
   * 问一次"外壳现在说这块视图缩放多少、谁在管"，答不上来就是 `undefined`。
   *
   * @returns 读数，或 undefined。
   */
  private async readZoomQuietly(): Promise<{ zoom: number; mode: ZoomMode } | undefined> {
    if (this.zoomPort === undefined || typeof this.zoomPort.reading !== 'function') return undefined
    try {
      return await this.zoomPort.reading()
    } catch {
      // 读回这条路是"面板上那句话的来源"，它坏了不该让任何动作失败：把它当作"读不到"。
      return undefined
    }
  }

  /**
   * 缩放到某个值（T13）。`1` 就是重置。
   *
   * ## 缩放由**外壳**做，插件只是请它做
   *
   * `webContents.setZoomFactor()` 是 Electron 的 API，插件够不到（ADR-0003 明令外壳不开
   * 控制端口），所以这条路经**既有的空间请求文件**走一趟：请求里那块视图带上期望的 `zoom`，
   * 外壳改完把 `getZoomFactor()` 的读回值写进 `state.json`，会话拿回来的是**读回的那个数**，
   * 不是我们写下去的那个愿望（见 `src/spaces.ts` 的 `SpaceManager.setZoom`）。
   *
   * ## 为什么不是"让页面以为窗格更宽"那条 CDP 路（本轮量到后推翻的结论）
   *
   * 上一轮采用的是 `page.setViewportSize(源视口/zoom)` + `Emulation.setDeviceMetricsOverride`。
   * 它**只做了一半**：布局视口确实变了（页面读得到、跨导航保持、截图跟着变），
   * 但**内容一个像素都没被缩放** —— 窗格把那个模拟视口按 1:1 的 DIP 画出来，然后裁掉。
   *
   * 真窗口像素实测（`docs/research/t13-zoom-out-measured.md`，夹具是 1200px 的条子 +
   * 页面最右端一块红标，视口 620×800）：
   *
   * ```
   * 基线 100%             : 蓝条在窗口像素里高 388px，红标 0
   * zoom=0.5(CDP)         : innerWidth=1240、scrollWidth=1240（"装下了"）、蓝条仍高 388px、红标 0
   * zoom=0.5(只发覆盖)     : 同上
   * zoom=1.94(CDP)        : 画出来的区域缩到 320 DIP，蓝条仍高 388px、红标 0
   * 100% 且滚到最右        : 红标 20184 像素（工具自检：量具有效）
   * zoom=0.5 且试图滚到最右 : scrollX 仍是 0 —— 页面不再溢出，**连滚都滚不到**
   * ```
   *
   * 最后两行是这条路被否掉的关键：CDP 的"缩小"不但没让整页进来，还把 100% 时**能滚到**的
   * 最右端变成了**滚不到**。它不是没功能，是负功能。同一次实测里外壳侧那条
   * （`setZoomFactor(0.5)`）蓝条高度 391→195px（正好一半）、红标出现在半尺寸位置上。
   *
   * ## 截图语义因此**回到** T5 那句话，而不是被作废
   *
   * 外壳侧缩放让页面读到的 `devicePixelRatio = 屏幕dpr × zoom`，布局视口 = `源视口 / zoom`，
   * 两者相乘恒等于窗格的物理像素：`1240 × 0.75 = 930`，与 `620 × 1.5 = 930` 是同一个数。
   * 所以 **"截图 = 视口 × 屏幕 dpr"（T5）在缩放≠1 时照样成立** —— 漂移是 CDP 那条路
   * 特有的毛病（Playwright 截图用的 dsf 取自它自己的 `_metricsOverride`,
   * `playwright-core/lib/coreBundle.js:37196`，算出来是 1），它随那条路一起被删掉了。
   *
   * @param zoom - 目标缩放值，必须在 `ZOOM_MIN`–`ZOOM_MAX` 之内（`src/navigation.ts`）。
   * @param mode - 谁管这个缩放（票 #19，缺省 `manual`）。会话里每一个"指名要一个缩放值"的
   *   动作都走这条默认值：`−` / `+` / `100%` / 工具里的 `zoom`——它们的意思都是"这个值我说了算"，
   *   于是外壳的自动适配从此让位（票面那条"手动缩放优先"的验收）。
   * @returns 缩放之后**从外壳与页面各自读回来**的视口、dpr 与源视口。
   * @throws RangeError 当 zoom 出界（悄悄夹到边界会让"100 倍"变成"5 倍"而不说一声）。
   * @throws ViewActionError 当这个会话没有可问的外壳 —— 那时**不能**假装缩放过。
   */
  async zoomTo(zoom: number, mode: ZoomMode = 'manual'): Promise<ZoomResult> {
    this.assertOpen()
    const wanted = normalizeZoom(zoom)
    if (this.zoomPort === undefined) {
      throw new ViewActionError(
        'failed',
        'browser-view: the view cannot be zoomed — this session has no shell to ask. Zooming is ' +
          "`webContents.setZoomFactor()` on the view's webContents, which only the shell can reach " +
          '(the plugin never gets an Electron handle, ADR-0003), so the request goes through the task-space ' +
          'channel the shell already reads. This session was adopted without that channel (no `DSH_DESKTOP_VIEW_SPACES`), ' +
          'so the zoom is unchanged.',
      )
    }
    // 请外壳去改，并**用它读回来的值**当结果：请求里的那个数是愿望，`getZoomFactor()` 才是事实。
    const applied = await this.zoomPort.setZoom(wanted, mode)
    this.currentZoom = applied
    await this.settle(applied)
    return await this.zoomReading(applied)
  }

  /**
   * 缩放一档（`+` / `−`）。
   *
   * 步进的起点**先读回来**（票 #19）：自动适配会在没人请求的时候改缩放，所以会话手里记的
   * 那个数可能是旧的 —— 从一个旧的 100% 往上走一步会跳到 110%，而画面其实在 52%，
   * 用户按的是"再大一点"，得到的却是"大了一倍多"。读回来那一步的问法是"外壳现在说多少"，
   * 答不上来（没有那条读回）就沿用自己记的值，不编。
   *
   * @param direction - `1` 放大，`-1` 缩小。
   * @returns 与 {@link zoomTo} 同一形状。
   * @throws RangeError 当已经到头 —— 到头是一个结果，不是"什么也没发生"。
   */
  async stepZoom(direction: 1 | -1): Promise<ZoomResult> {
    await this.refreshZoom()
    return await this.zoomTo(nextZoomStep(this.currentZoom, direction))
  }

  /** 回到 100%（T13 的"重置"之一）。 */
  async resetZoom(): Promise<ZoomResult> {
    return await this.zoomTo(ZOOM_RESET)
  }

  /**
   * 把这一格**交回自动适配**（票 #19 的那颗「自动」）。
   *
   * 与 {@link resetZoom} 的差别是它没有终点：缩放到多少由外壳按当前栏宽算（页面塞不下就缩小，
   * 塞得下就是 100%）。所以结果是**读回来的**，与其它缩放动作同一条规矩。
   *
   * @returns 缩放之后从外壳与页面各自读回来的视口、dpr 与源视口。
   * @throws ViewActionError 当这个会话没有可问的外壳 —— 那时**不能**假装交回去了。
   */
  async useAutoZoom(): Promise<ZoomResult> {
    this.assertOpen()
    if (this.zoomPort === undefined || typeof this.zoomPort.useAutoZoom !== 'function') {
      throw new ViewActionError(
        'failed',
        'browser-view: this view cannot be handed back to automatic fitting — this session has no shell to ask. ' +
          'Fitting is `webContents.setZoomFactor()` computed from the page\'s own overflow, which only the shell can ' +
          'reach (the plugin never gets an Electron handle, ADR-0003), so it goes through the task-space channel. ' +
          'This session was adopted without that channel (no `DSH_DESKTOP_VIEW_SPACES`), so the zoom is unchanged.',
      )
    }
    const applied = await this.zoomPort.useAutoZoom()
    this.currentZoom = applied
    await this.settle(applied)
    return await this.zoomReading(applied)
  }

  /**
   * 把视图导航回**初始页**（T13 的「重新开始」）。
   *
   * 地址来自握手发布的那句 `viewUrl`（外壳说这一格一开始是什么），拿不到就退到 `about:blank`
   * —— "没有初始页"是一个必须说出来的事实，而不是"什么也不做"（那看起来跟按钮坏了没区别）。
   *
   * 它**顺带把缩放也重置**：一次"重新开始"如果留着上一轮的 250%，那么"回到初始状态"
   * 就只做了一半。
   *
   * @returns 落在哪一页，以及用的是什么地址。
   */
  async restart(): Promise<{ url: string; title: string; target: string; source: 'handshake' | 'blank' }> {
    this.assertOpen()
    const target = this.initialUrl !== undefined && this.initialUrl !== '' ? this.initialUrl : 'about:blank'
    await this.resetZoom()
    const landed = await this.goto(target)
    // 重新开始是一段**新**的历史，不是接着旧账走：把账本清成"只有这一页"。
    this.history.reset(landed.url)
    return {
      url: landed.url,
      title: landed.title,
      target,
      source: this.initialUrl !== undefined && this.initialUrl !== '' ? 'handshake' : 'blank',
    }
  }

  /**
   * 从**页面自己**读回缩放之后的三件事，并算出源视口。
   *
   * 源视口是算的：外壳侧的缩放就是"布局视口 = 源视口 / zoom"，所以 `源视口 = 布局视口 × zoom`。
   * 这样它必然与同一次读回的 `innerWidth` 自洽 —— 另读一次的话，两次读回之间页面换了一页就会
   * 报出一对互相矛盾的数。
   *
   * @param zoom - 外壳读回来的缩放值。
   * @returns 收成 {@link ZoomResult}。
   */
  private async zoomReading(zoom: number): Promise<ZoomResult> {
    const seen = await this.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }))
    return {
      zoom,
      innerWidth: seen.innerWidth,
      innerHeight: seen.innerHeight,
      devicePixelRatio: seen.devicePixelRatio,
      source: {
        width: Math.max(1, Math.round(seen.innerWidth * zoom)),
        height: Math.max(1, Math.round(seen.innerHeight * zoom)),
      },
    }
  }

  /**
   * 一次缩放之后，等页面**自己的读数**追上外壳已经应用的那个缩放（票 #20 E）。
   *
   * ## 为什么不是"等一帧"（票前的写法，实测 570–952 ms）
   *
   * 原来的实现是等一个 `requestAnimationFrame`。票 #20 亲测：这一页在**没有前台焦点 / 不被合成**
   * 的时候几乎不出帧（500 ms 里 0–1 帧，而页面上有一个一直在排队的 rAF 回调），
   * 于是"等一帧"变成"等最多一秒" —— 那就是用户按一次缩放要等的那 0.9 秒，
   * 也是这条路上**唯一**一笔超过 200 ms 的开销（HTTP 往返 10–20 ms、外壳一次发布 4–8 ms、
   * 外壳侧轮询 12–137 ms 都量过，完整数据见 `docs/research/t20-why-the-panel-button-waits-a-second.md`）。
   * 而 `requestAnimationFrame` 从来不是我们要的那个事实：我们要的是"**布局已经按新缩放算过**"。
   *
   * ## 现在等的那个事实
   *
   * 1. 一次**同步强制布局**（读 `documentElement.scrollHeight`）把布局冲出来。它不经过合成器，
   *    所以不受出帧节奏影响 —— 这是它与"等一帧"的本质差别；
   * 2. 拿这一次读到的三件事与**上一次从页面读回来的那一份**对照，看它有没有跟上外壳说的那个缩放
   *    （`dpr` 与布局视口都按 `zoom` 的比例走，这是同一次读回里自洽的换算，不是记一个常数）；
   * 3. 跟不上就在一个**有界**的窗口内重试几次（窗口本身不是延迟：第一次就对上了就立刻返回）。
   *    窗口用完就**如实返回读到的东西**，绝不编 —— 对不上的那个读数照样会被返回、照样会显示，
   *    读数与事实的差别因此看得见，而不是被一段等待盖住。
   *
   * 实测：改完之后同一个动作从 ~1010 ms 降到 ~119–175 ms（降下去的正是那一帧的钱，
   * 剩下的那段是外壳那条 150 ms 轮询，票面明令不许为了好看去缩它）。
   *
   * @param zoom - 外壳**读回来**的那个缩放值（1 = 100%）。
   * @returns 页面最后报的那三件事（成功与否都返回读到的那个）。
   */
  private async settle(zoom: number): Promise<{ innerWidth: number; innerHeight: number; devicePixelRatio: number }> {
    const deadline = Date.now() + SETTLE_BUDGET_MS
    for (;;) {
      const seen = await this.page.evaluate(() => {
        // 同步强制布局：读一次 scrollHeight 就把待处理的样式与布局算完。
        // 这一句是**这个函数存在的理由**，删掉它就退回"读到一个还没跟上缩放的视口"。
        void document.documentElement.scrollHeight
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        }
      })
      const last = this.lastViewport
      const followed = last === undefined || zoom === last.zoom || this.viewportFollows(last, zoom, seen)
      if (followed || Date.now() >= deadline) {
        // 参照物**每次都以这一次的读数为准**（跟上了、没跟上、没有参照物，三种都一样）：
        // 只在对上时才记，会让"某一次没跟上"永远留在参照物里，之后每一次缩放都要白等一遍上界。
        // 记下一个可能没对上的配对不会造成"假的成功" —— 下一轮的判据只会因此更保守（多等一会儿）。
        this.lastViewport = { zoom, ...seen }
        return seen
      }
      await delay(SETTLE_STEP_MS)
    }
  }

  /**
   * 页面报的这一份读数，跟上新的缩放了吗（票 #20 E 的判据）。
   *
   * 两条关系都来自"缩放就是布局视口按比例变、`devicePixelRatio` 按同一比例变"这一件事，
   * 而**参照物是上一次从页面读回来的那一份**（不是记下来的屏幕 dpr）：
   * 于是显示器换了、dpr 变了，判据自己就跟着变，不需要任何缓存失效逻辑。
   *
   * 容差与 `tests/panel-toolbar.spec.ts` 里那条验收同源：`dpr` 用 0.02，宽度用 2 个 CSS 像素
   * （四舍五入与子像素布局都会带来一点差）。
   *
   * @param last - 上一次从页面读回来的那一份。
   * @param zoom - 外壳刚读回来的缩放值。
   * @param seen - 这一次读到的。
   * @returns 跟上了就是 true。
   */
  private viewportFollows(
    last: { zoom: number; innerWidth: number; devicePixelRatio: number },
    zoom: number,
    seen: { innerWidth: number; devicePixelRatio: number },
  ): boolean {
    if (last.zoom <= 0) return true
    const ratio = zoom / last.zoom
    const wantedDpr = last.devicePixelRatio * ratio
    const wantedWidth = last.innerWidth / ratio
    return Math.abs(seen.devicePixelRatio - wantedDpr) < 0.02 && Math.abs(seen.innerWidth - wantedWidth) <= 2
  }


  /**
   * Project the current page into a snapshot: title, address, and the visible
   * interactive elements with their bounds, in document order.
   *
   * The 1-based `ref` of each element is what the action tools resolve against, and it
   * is captured by this call and this call only: taking a snapshot replaces the ref
   * table and the document identity together, so refs never outlive the document they
   * were read from. Replacing the table also releases the handles it held, so taking
   * snapshots in a loop does not accumulate them.
   *
   * Two engine calls, and the order matters. `elementHandles()` asks the engine's own
   * `:visible` predicate for the match set and pins each match as a node; the metadata
   * is then read from *those nodes* in a single evaluation, so the title, the document
   * token, and every element's role/name/state/bounds still come from one document and
   * one pass — and there is no second query whose index could disagree with the first
   * about which element is at which position (ADR-0007, ADR-0008).
   *
   * @returns the snapshot; `truncated` is set when the page exceeded the element cap.
   */
  async snapshot(): Promise<PageSnapshot> {
    this.assertOpen()
    return await this.withReadFlash(async () => await this.collectSnapshot())
  }

  /**
   * The snapshot itself, without the overlay's read flash.
   *
   * Split out so the public entry point can wrap exactly one thing — the read — in the
   * visible hint, instead of the hint being threaded through the collection.
   *
   * **One pass per frame** (T9). The frames are visited in a stable order — the main
   * frame first, then the child frames in the order the engine reports them (document
   * order of their `<iframe>` elements) — and each frame's own match set is read from that
   * frame's own document. So an element inside an iframe is a snapshot element like any
   * other, while the *frame* it came from is what {@link RefEntry} pins along with the
   * node: two frames of one page can hold identical controls, and a ref that did not know
   * its frame could land in the wrong one.
   *
   * The frame's origin is measured from the parent document (`frame.frameElement()`), not
   * from inside the frame: `window.frameElement` is null for a cross-origin frame, while
   * the *parent* can always measure the box it laid out. That is what lets a frame
   * element's bounds be published in this view's own viewport coordinates, which is the
   * only coordinate space bounds, the overlay and the hit test share (ADR-0007).
   */
  private async collectSnapshot(): Promise<PageSnapshot> {
    const mainFrame = this.page.mainFrame()
    const frames = [mainFrame, ...this.page.frames().filter((frame) => frame !== mainFrame)]
    interface FrameCollection {
      frame: Frame
      /** Every handle this frame contributed, in the order the page function indexes them. */
      pool: ElementHandle<Element>[]
      collected: CollectedSnapshot
      origin: ViewPoint
      frameElement?: ElementHandle<Element>
    }
    const collections: FrameCollection[] = []
    for (const frame of frames) {
      const handles = (await frame.locator(SNAPSHOT_SELECTOR).elementHandles()) as ElementHandle<Element>[]
      const labels = (await frame.locator(CONTROL_LABEL_SELECTOR).elementHandles()) as ElementHandle<Element>[]
      // The handles go in as the page function's argument, and Playwright resolves them to
      // the nodes they reference, so the metadata is read from exactly the elements that
      // were pinned. Reaching `evaluate` through a bound, explicitly typed reference is
      // what keeps that call expressible: the public typings model the handle→node
      // translation with a recursive conditional type that the compiler refuses to
      // instantiate for an array of elements.
      const evaluate = frame.evaluate.bind(frame) as unknown as (
        pageFunction: (input: SnapshotInput) => CollectedSnapshot,
        arg: { elements: readonly ElementHandle[]; labels: readonly ElementHandle[]; overlayId: string },
      ) => Promise<CollectedSnapshot>
      const collected = await evaluate(collectSnapshot, {
        elements: handles,
        labels,
        overlayId: this.overlay.id,
      })
      const frameElement = frame === mainFrame ? undefined : ((await frame.frameElement()) as ElementHandle<Element>)
      collections.push({
        frame,
        pool: [...handles, ...labels],
        collected,
        origin: await this.frameOrigin(frame),
        ...(frameElement !== null && frameElement !== undefined ? { frameElement } : {}),
      })
    }

    const elements: SnapshotElement[] = []
    const refs = new Map<number, RefEntry>()
    const consumed = new Set<ElementHandle>()
    let truncated = false
    for (const collection of collections) {
      for (let index = 0; index < collection.collected.elements.length; index++) {
        if (refs.size >= this.maxElements) {
          truncated = true
          break
        }
        const handle = collection.pool[collection.collected.picks[index]]
        const record = collection.collected.elements[index]
        const ref = refs.size + 1
        consumed.add(handle)
        elements.push({
          ref,
          ...record,
          // 框架里的元素，bounds 要**搬进这一块视图的视口坐标**：快照的 bounds 与覆盖层、
          // 命中测试共用一套坐标（ADR-0007），而框架内那个矩形是相对框架自己视口的。
          // 主框架的 origin 是 (0,0)，所以主框架元素这一行等于没动。
          bounds: {
            x: record.bounds.x + collection.origin.x,
            y: record.bounds.y + collection.origin.y,
            width: record.bounds.width,
            height: record.bounds.height,
          },
          ...(collection.frame === mainFrame ? {} : { frame: collection.frame.url() }),
        })
        refs.set(ref, {
          handle,
          frame: collection.frame,
          token: collection.collected.token,
          origin: collection.origin,
          ...(collection.frameElement !== undefined ? { frameElement: collection.frameElement } : {}),
        })
      }
      if (truncated) break
    }

    const previous = this.refs
    this.refs = refs
    // Anything the snapshot did not list has no ref, so nothing can ever act on it: the
    // matches past the cap, and every label the rule in the page decided against.
    for (const collection of collections) {
      void disposeHandles(collection.pool.filter((handle) => !consumed.has(handle)))
    }
    // 旧表的节点与它记下的 `<iframe>` 一起放掉：框架句柄是**每个 ref 都要用的**，所以它
    // 只在整张表被换掉时才该释放（上一版把它当成"没被用上的匹配"当场释放了，于是同一个
    // 框架里的第二个动作会因为句柄已经没了而失败）。
    void disposeHandles([...previous.values()].map((entry) => entry.handle))
    void disposeHandles(
      [...previous.values()]
        .map((entry) => entry.frameElement)
        .filter((handle): handle is ElementHandle<Element> => handle !== undefined),
    )
    return {
      title: collections[0].collected.title,
      url: this.page.url(),
      elements,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  /**
   * Where one frame's viewport starts, in this view's viewport coordinates.
   *
   * Walked upwards one `<iframe>` at a time, each measured **in its own parent document**
   * (`getBoundingClientRect()` of the frame element, plus its border widths, because the
   * child document's viewport starts inside the border, not at the border box). The main
   * frame's origin is `(0, 0)` by definition, so a main-frame element's bounds are the
   * ones `getBoundingClientRect()` reported and nothing is added.
   *
   * @param frame - the frame to locate.
   * @returns the frame viewport's origin in view coordinates.
   */
  private async frameOrigin(frame: Frame): Promise<ViewPoint> {
    let x = 0
    let y = 0
    let current = frame
    const mainFrame = this.page.mainFrame()
    while (current !== mainFrame) {
      const parent = current.parentFrame()
      if (parent === null) break
      const raw = await current.frameElement()
      if (raw === null) break
      const element = raw as ElementHandle<Element>
      const box = (await element.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          x: rect.left + (Number.parseFloat(style.borderLeftWidth) || 0),
          y: rect.top + (Number.parseFloat(style.borderTopWidth) || 0),
        }
      })) as ViewPoint
      x += box.x
      y += box.y
      current = parent
    }
    return { x, y }
  }

  /**
   * Click the element a `ref` from the most recent snapshot addressed.
   *
   * This is the narrowest way to *use* a ref, and it is what makes "the refs were
   * cleared" observable from the outside: a stale ref is refused here rather than
   * silently resolving to whatever element happens to sit at that index now.
   *
   * @param ref - 1-based ref from the most recent snapshot on this page.
   * @throws when no snapshot has been taken, when the document has changed since, when
   *   the element is gone or hidden, or when something is drawn over it.
   */
  async clickRef(ref: number): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'clicked', true)
      this.assertClickable(ref, target.facts, 'clicked')
      await overlay.aim(target.facts.hit?.point)
      await this.perform(`click on ref ${ref} (${target.facts.description})`, () =>
        target.handle.click({ timeout: this.timeoutMs }),
      )
    })
  }

  /**
   * Hover the element a ref addressed, so `:hover` states apply.
   *
   * It is a pointer action like a click, so it is refused for the same reasons: an
   * element that is hidden or covered cannot be hovered any more than it can be clicked.
   *
   * @param ref - 1-based ref from the most recent snapshot.
   */
  async hoverRef(ref: number): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'hovered', true)
      this.assertClickable(ref, target.facts, 'hovered')
      await overlay.aim(target.facts.hit?.point)
      await this.perform(`hover on ref ${ref} (${target.facts.description})`, () =>
        target.handle.hover({ timeout: this.timeoutMs }),
      )
    })
  }

  /**
   * Type text into the element a ref addressed, one key at a time.
   *
   * "One key at a time" is the whole point of this method existing beside
   * {@link fillRef}: every character is a real key press, so widgets that listen for
   * key events (autocomplete, masking, input handlers that care about *how* the text
   * arrived) see what a person would produce. The cost is the same: it appends to what
   * is already there, because that is what pressing keys does.
   *
   * @param ref - 1-based ref from the most recent snapshot.
   * @param text - the text to type, character by character.
   */
  async typeRef(ref: number, text: string): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'typed into')
      await overlay.aim(target.facts.hit?.point)
      await this.perform(`typing into ref ${ref} (${target.facts.description})`, () =>
        target.handle.type(text, { timeout: this.timeoutMs }),
      )
    })
  }

  /**
   * Replace the content of the element a ref addressed, in one operation.
   *
   * The trade-off against {@link typeRef} is deliberate and is documented where the
   * tool is declared: this sets the value through the editing pipeline, so the field
   * ends up holding exactly `value` (including on a `[contenteditable]`, where it
   * replaces the element's whole text) at the cost of producing no key events. A form
   * field wants this; a widget that watches keystrokes wants {@link typeRef}.
   *
   * @param ref - 1-based ref from the most recent snapshot.
   * @param value - the exact value the element must end up holding.
   */
  async fillRef(ref: number, value: string): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'filled')
      await overlay.aim(target.facts.hit?.point)
      await this.perform(`filling ref ${ref} (${target.facts.description})`, () =>
        target.handle.fill(value, { timeout: this.timeoutMs }),
      )
    })
  }

  /**
   * Press one keyboard key, on the page or in a specific element.
   *
   * Without a ref the key goes to whatever the page has focused — which is what makes
   * "type a value, then press Enter" work. With a ref the element is focused first, so
   * a form can be submitted without a snapshot that happens to leave focus in the
   * right place.
   *
   * @param key - the key name, e.g. `Enter`, `Escape`, `Tab`, `ArrowDown`.
   * @param ref - optional 1-based ref to focus before pressing.
   */
  async pressKey(key: string, ref?: number): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      if (ref === undefined) {
        // No ref means no element, hence no point to aim at: the key goes wherever the
        // page put focus, and the overlay says that with a ring rather than a cursor.
        await this.perform(`key press ${JSON.stringify(key)}`, () => this.page.keyboard.press(key))
        return
      }
      const target = await this.targetOf(ref, 'pressed')
      await overlay.aim(target.facts.hit?.point)
      await this.perform(`key press ${JSON.stringify(key)} in ref ${ref} (${target.facts.description})`, () =>
        target.handle.press(key, { timeout: this.timeoutMs }),
      )
    })
  }

  /**
   * Select an option in the `<select>` a ref addressed.
   *
   * The option is matched by value **or** label, which is the engine's own rule for a
   * plain string and the one a caller can predict from the page: the model does not
   * have to know whether the site wrote `value="1"` or `value="Red"`.
   *
   * @param ref - 1-based ref of the `<select>` from the most recent snapshot.
   * @param option - the option's value or its visible label.
   * @returns the values that ended up selected, as the page reports them.
   */
  async selectRef(ref: number, option: string): Promise<string[]> {
    this.assertOpen()
    return await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'used to select an option')
      await overlay.aim(target.facts.hit?.point)
      try {
        return await target.handle.selectOption(option, { timeout: this.timeoutMs })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Did not find some options/.test(message)) {
          throw new ViewActionError(
            'failed',
            `browser-view: ref ${ref} (${target.facts.description}) has no option matching ${JSON.stringify(option)} — ` +
              "the string is matched against each option's value or its label; call browser_snapshot to see the control.",
          )
        }
        throw classifyActionFailure(error, `selecting ${JSON.stringify(option)} in ref ${ref} (${target.facts.description})`)
      }
    })
  }

  /**
   * Drag the element a ref addressed onto the element another ref addressed.
   *
   * Both ends are resolved and checked like any other pointer action — pinned to the
   * nodes the snapshot listed, scrolled into view if needed, refused when hidden, and
   * refused when something else covers the point the drag would start or end at — and
   * then the drag itself is a real mouse gesture: press at the source's centre, move in
   * steps (a single jump is one `mousemove`, which drag handlers do not act on), and
   * release over the target's centre.
   *
   * @param fromRef - 1-based ref of the element to drag.
   * @param toRef - 1-based ref of the element to drop it on.
   */
  async dragRef(fromRef: number, toRef: number): Promise<void> {
    this.assertOpen()
    await this.action(async (overlay) => {
      const source = await this.targetOf(fromRef, 'dragged', true)
      this.assertClickable(fromRef, source.facts, 'dragged')
      const target = await this.targetOf(toRef, 'dropped on', true)
      this.assertClickable(toRef, target.facts, 'dropped on')
      const from = await source.handle.boundingBox()
      const to = await target.handle.boundingBox()
      if (from === null || to === null) {
        throw new ViewActionError(
          'not-visible',
          `browser-view: ref ${fromRef} (${source.facts.description}) or ref ${toRef} (${target.facts.description}) ` +
            'has no box, so there is no point to drag between.',
        )
      }
      const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
      const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
      // The two ends of a drag are two different places on the page: the cursor goes to
      // where the drag starts, the ripple to where it lands. Drawing both at one of them
      // would misreport the gesture.
      await overlay.aim(start)
      overlay.landed(end)
      await this.perform(
        `drag of ref ${fromRef} (${source.facts.description}) onto ref ${toRef} (${target.facts.description})`,
        async () => {
          await this.page.mouse.move(start.x, start.y)
          await this.page.mouse.down()
          await this.page.mouse.move(end.x, end.y, { steps: 12 })
          await this.page.mouse.up()
        },
      )
    })
  }

  /**
   * Scroll the view until the element a ref addressed is inside the viewport.
   *
   * The rectangle that comes back is read from the element *after* the scroll, so the
   * caller can see it is now inside the viewport instead of taking this method's word
   * for it — and it is the same viewport-relative space the snapshot's bounds use.
   *
   * @param ref - 1-based ref from the most recent snapshot.
   * @returns the element's rectangle after scrolling.
   */
  async scrollToRef(ref: number): Promise<ElementBounds> {
    this.assertOpen()
    return await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'scrolled to')
      await this.perform(`scroll to ref ${ref} (${target.facts.description})`, () =>
        target.handle.scrollIntoViewIfNeeded({ timeout: this.timeoutMs }),
      )
      // The rectangle that comes back is read from the element *after* the scroll, so the
      // caller can see it is now inside the viewport instead of taking this method's word
      // for it. The ripple's point comes out of the same single pass: aiming *before* the
      // scroll would be aiming at nothing, because the element this action exists for is
      // typically the one that was outside the viewport (ADR-0007). A frame element goes
      // through {@link viewFacts} again, so the rectangle that is returned is in view
      // coordinates — the only space "is it in the viewport now" is a question in.
      const entry = this.refs.get(ref) as RefEntry
      const after = await this.viewFacts(entry, (await target.handle.evaluate(inspectElement)) as ElementFacts)
      overlay.landed(after.hit?.point)
      return after.rect
    })
  }

  /**
   * Scroll the page by a pixel amount, without aiming at an element.
   *
   * @param direction - which way to scroll.
   * @param amount - how many pixels.
   */
  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.assertOpen()
    const delta = direction === 'down' ? amount : -amount
    // A direction scroll has no element and no point, so the overlay shows a ring: a
    // cursor would claim the agent pointed somewhere, and it did not.
    await this.action(async () => {
      await this.page.evaluate((pixels) => window.scrollBy(0, pixels), delta)
    })
  }

  /**
   * Wait for one of three things: a fixed delay, a visible selector, or body text.
   *
   * The selector and text forms are explicit capabilities, not a way around refs: an
   * action still names its element by ref, but "has it appeared yet" is a question
   * about the page rather than about an element the snapshot has already seen.
   *
   * @param options - exactly one of `ms`, `selector`, or `text`, plus an optional timeout.
   * @returns what was waited for and how long it took.
   * @throws a timeout failure naming what never appeared, or an argument failure when
   *   none or several of the three forms were given.
   */
  async wait(options: WaitOptions): Promise<WaitResult> {
    this.assertOpen()
    const requested = [options.ms, options.selector, options.text].filter((value) => value !== undefined)
    if (requested.length !== 1) {
      throw new ViewActionError(
        'failed',
        `browser-view: browser_wait needs exactly one of ms, selector, or text (got ${requested.length}); ` +
          'to wait for an element you can see, use its ref with an action instead.',
      )
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const started = Date.now()
    if (options.ms !== undefined) {
      await this.page.waitForTimeout(options.ms)
      return { waited: `${options.ms}ms`, elapsedMs: Date.now() - started }
    }
    if (options.selector !== undefined) {
      const selector = options.selector
      // A wait that ends without what it waited for is exactly the case the overlay must
      // not draw as a success, so both branches run through the same outcome contract.
      return await this.action(async () => {
        try {
          await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
        } catch (error) {
          throw this.timedOutWaiting(`selector ${JSON.stringify(selector)}`, timeoutMs, error)
        }
        return { waited: `selector ${selector}`, elapsedMs: Date.now() - started }
      })
    }
    const text = options.text as string
    return await this.action(async () => {
      try {
        // `innerText` is what the page *renders*, so text that exists only inside a
        // `display:none` subtree does not count as having appeared.
        await this.page.waitForFunction(
          (wanted) => (document.body.innerText ?? '').includes(wanted),
          text,
          { timeout: timeoutMs },
        )
      } catch (error) {
        throw this.timedOutWaiting(`text ${JSON.stringify(text)}`, timeoutMs, error)
      }
      return { waited: `text ${JSON.stringify(text)}`, elapsedMs: Date.now() - started }
    })
  }

  /**
   * Read the text the page renders, as the page's own `innerText` defines it.
   *
   * `innerText` and not `textContent`, and not a tree walk: it is what a person reading
   * the page would see, so text that only exists inside `display: none` markup does not
   * arrive pretending to be content. This is the capability ADR-0005 says the snapshot
   * does *not* carry — the snapshot lists what can be acted on, and the text is fetched
   * on demand, bounded by the cap.
   *
   * The cap is reported as data (`truncated`, `totalChars`) rather than only as a marker
   * inside the string, so a caller can tell "this is the whole page" from "this was cut"
   * without guessing at the length of what it did not receive.
   *
   * @param maxChars - cut the text at this many characters; defaults to the session's cap.
   * @returns the rendered text, whether it was cut, and how long it really was.
   */
  async extractText(maxChars?: number): Promise<ExtractedText> {
    this.assertOpen()
    const cap = Math.max(0, maxChars ?? this.maxChars)
    return await this.withReadFlash(async () => {
      // Self-contained on purpose: only this function's source crosses into the page.
      const read = await this.page.evaluate(() => {
        const body = document.body
        const text = body === null ? '' : body.innerText
        return { text, totalChars: text.length }
      })
      const text = cutText(read.text, cap)
      return { text, truncated: read.totalChars > text.length, totalChars: read.totalChars }
    })
  }

  /**
   * Evaluate one read-only expression in the page and hand back what it produced.
   *
   * It is an explicit capability for reading state that never reaches the DOM — a model
   * object, a computed configuration, a counter the app keeps in JS — and it is *not* a
   * second way to locate an element: acting on an element still goes through its `ref`
   * (ADR-0001), because an expression that resolves an element gives the model something
   * no later action can address.
   *
   * @param expression - a JavaScript expression, e.g. `document.title`, `JSON.stringify(window.__state)`.
   * @returns whatever the expression produced, serialized by the engine.
   * @throws a failure naming the engine's words when the expression cannot be evaluated.
   */
  async evaluate(expression: string): Promise<unknown> {
    this.assertOpen()
    try {
      return await this.page.evaluate(expression)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ViewActionError(
        'failed',
        `browser-view: the expression could not be evaluated in the page (${this.page.url()}): ${firstLine(message)}`,
      )
    }
  }

  /**
   * Capture the view as a PNG and return its bytes.
   *
   * The capture is the viewport at the *device* pixel ratio, which is Playwright's default
   * and the only scale this host produces a truthful size for. `scale: 'css'` was measured
   * here and rejected: the image comes back one pixel per CSS pixel only while the page has
   * no scrollbar, and 439x799 for a 440x800 viewport as soon as one appears (Playwright
   * derives the size from layout metrics, which the scrollbar changes). At device scale the
   * image is exactly `innerWidth × innerHeight × devicePixelRatio` — read from the page, that
   * is how "the screenshot is this view, at this size" is verified — and the pixels are the
   * display's own, with no resampling.
   *
   * The type is pinned to PNG rather than inferred from the file name, so the bytes and the
   * declared media type cannot disagree.
   *
   * Writing the file and publishing the bytes as an attachment are separate steps for a
   * reason: the file is for a human, and the attachment is what the model actually
   * receives (T5).
   *
   * @param path - where to write the PNG.
   * @returns the encoded PNG bytes.
   * @throws a timeout naming how many attempts were made, when no image is produced.
   */
  async screenshot(path: string): Promise<Buffer> {
    this.assertOpen()
    // The agent asked for the page, so the page is what it gets: the marks come off
    // first. Without this a cursor left over from the click just before would end up in
    // the model's image of the site.
    await this.clearOverlayMarks()
    const attemptMs = Math.max(1_000, Math.min(this.timeoutMs, SCREENSHOT_ATTEMPT_MS))
    let lastError: unknown
    for (let attempt = 1; attempt <= SCREENSHOT_ATTEMPTS; attempt++) {
      try {
        return await this.page.screenshot({ path, type: 'png', timeout: attemptMs })
      } catch (error) {
        // Only the stall is retried: a view that is gone, or a path that cannot be
        // written, fails the same way every time and retrying it would only be slower.
        if (!isTimeoutFailure(error)) throw error
        lastError = error
      }
    }
    throw new ViewActionError(
      'timeout',
      `browser-view: the view produced no screenshot in ${SCREENSHOT_ATTEMPTS} attempts of ${attemptMs}ms each ` +
        `(the engine last said: ${firstLine(lastError instanceof Error ? lastError.message : String(lastError))}). ` +
        'The page may still be busy, or the view may not be being painted.',
    )
  }

  /**
   * The JSON the current document received, oldest first.
   *
   * Bounded and reset with the document: a response from the page before this one could
   * be mistaken for the data behind the page in front of the model, which is exactly the
   * mistake this capability exists to prevent.
   *
   * @returns a copy, so a caller cannot mutate what the session is still filling.
   */
  getJsonResponses(): JsonResponseRecord[] {
    this.assertOpen()
    return [...this.jsonResponses]
  }

  /**
   * What the current document said about itself: console messages and failed requests.
   *
   * It answers "why is this page empty" with the page's own words — a thrown error, a
   * 404 — instead of leaving "nothing rendered" as the only observable fact.
   *
   * @returns a copy of both buffers.
   */
  diagnostics(): PageDiagnostics {
    this.assertOpen()
    return { console: [...this.consoleMessages], failedRequests: [...this.failedRequests] }
  }

  /**
   * The dialogs this session has answered, oldest first.
   *
   * @returns a copy, so a caller cannot mutate what the session is still filling.
   */
  dialogRecordsSoFar(): DialogRecord[] {
    this.assertOpen()
    return [...this.dialogRecords]
  }

  /** The answer policy dialogs raised from now on will be given. */
  currentDialogPolicy(): DialogPolicy {
    return { ...this.dialogPolicy }
  }

  /**
   * Set the answer this session gives to dialogs that appear later.
   *
   * It is a *policy*, not an answer to a dialog that is already on screen — because there
   * never is one: dialogs are answered the moment they appear (see
   * {@link AdoptedViewSession.answerDialog}), so the only way to answer one is to have
   * said in advance what the answer should be. That is the whole design: a page can never
   * be left waiting for a model that is itself waiting for the page.
   *
   * @param policy - the answer to give, and the text a `prompt` should be accepted with.
   * @returns the policy in force after the change.
   */
  setDialogPolicy(policy: DialogPolicy): DialogPolicy {
    this.assertOpen()
    this.dialogPolicy = policy.promptText === undefined ? { answer: policy.answer } : { ...policy }
    return this.currentDialogPolicy()
  }

  /**
   * A reading of "what has happened so far", for attributing events to one action.
   *
   * Actions are not the only things that happen on a page: a click can raise a dialog and
   * start a download. Both are recorded with a timestamp-free counter, so an action can
   * ask "what was raised while I ran" without depending on wall-clock ordering.
   *
   * @returns an opaque mark to hand to {@link AdoptedViewSession.activitySince}.
   */
  activityMark(): { dialogs: number; downloads: number } {
    return { dialogs: this.dialogRecords.length, downloads: this.downloadStarts.length }
  }

  /**
   * Everything raised since a mark: the dialogs answered and the downloads started.
   *
   * @param mark - a mark from {@link AdoptedViewSession.activityMark}.
   * @returns the activity, each list possibly empty.
   */
  activitySince(mark: { dialogs: number; downloads: number }): ActionActivity {
    return {
      dialogs: this.dialogRecords.slice(mark.dialogs),
      downloads: this.downloadStarts.slice(mark.downloads),
    }
  }

  /**
   * Hand a local file to the page's file input.
   *
   * Two routes, and which one is used is decided by what the `ref` points at — never by
   * what the page looks like from here:
   *
   *  - the ref **is** a file input: `setInputFiles` puts the file in it directly. This is
   *    the only route that works on a `display: none` input, and it is why an input the
   *    snapshot lists is used as-is instead of being clicked.
   *  - the ref is the **visible trigger** of a hidden one (a `<label>` the snapshot lists
   *    because its control is not listed, ADR-0012): the trigger is clicked and the file
   *    chooser that click opens is what receives the file. Measured on this host: the
   *    `filechooser` event arrives about a millisecond *after* the click returns, and
   *    `setFiles` really does put the bytes into the page's own `FileList`.
   *
   * Every answer is read back from the page afterwards. "The file was given to the input"
   * is not something this method is allowed to assert: the input's own `files` list is
   * what says whether it landed, and its name and size are what the caller is told.
   *
   * @param ref - 1-based ref of the file input or of a control that opens one.
   * @param path - absolute path of the local file to hand over.
   * @returns what the page now holds, read from the page.
   * @throws a named failure when the path is not a readable file, when the click opened no
   *   file chooser within the action timeout, or when the chooser refused the files.
   */
  async uploadRef(ref: number, path: string): Promise<UploadResult> {
    this.assertOpen()
    const absolute = resolve(path)
    const info = await stat(absolute).catch((error: unknown) => {
      throw new ViewActionError(
        'failed',
        `browser-view: browser_upload could not read ${absolute} — ${error instanceof Error ? firstLine(error.message) : String(error)}. ` +
          'The path must name a file that exists on the machine running this agent.',
      )
    })
    if (!info.isFile()) {
      throw new ViewActionError(
        'failed',
        `browser-view: browser_upload was given ${absolute}, which is not a file. Point it at one file.`,
      )
    }
    return await this.action(async (overlay) => {
      const target = await this.targetOf(ref, 'used to give a file to')
      await overlay.aim(target.facts.hit?.point)
      const isFileInput = (await target.handle.evaluate(
        (element) => element.tagName.toLowerCase() === 'input' && (element as HTMLInputElement).type === 'file',
      )) as boolean
      if (isFileInput) {
        await this.perform(`giving ${basename(absolute)} to ref ${ref} (${target.facts.description})`, () =>
          target.handle.setInputFiles(absolute, { timeout: this.timeoutMs }),
        )
        return await this.readUpload(target.handle, ref, target.facts.description, 'input', absolute)
      }
      // Not an input: it opens one. The chooser is what the engine hands over, so the
      // file is delivered through the route the page itself uses.
      const chooser = await this.openFileChooser(target.handle, ref, target.facts.description)
      try {
        await chooser.setFiles(absolute)
      } catch (error) {
        throw new ViewActionError(
          'failed',
          `browser-view: the file chooser ref ${ref} (${target.facts.description}) opened refused ` +
            `${basename(absolute)}: ${firstLine(error instanceof Error ? error.message : String(error))}`,
        )
      }
      const element = await chooser.element()
      return await this.readUpload(element, ref, target.facts.description, 'filechooser', absolute)
    })
  }

  /**
   * Click a control and hand back the file chooser it opened.
   *
   * @param handle - the control to click.
   * @param ref - the ref it was addressed by, for the failure message.
   * @param description - how the control is named in a failure message.
   * @returns the chooser the engine reported.
   * @throws when no chooser appeared within the action timeout — named as such, because
   *   "this control does not open a file chooser" and "the file was refused" have
   *   different remedies.
   */
  private async openFileChooser(handle: ElementHandle, ref: number, description: string): Promise<FileChooser> {
    const budgetMs = Math.max(1_000, Math.min(this.timeoutMs, FILE_CHOOSER_BUDGET_MS))
    const pending = this.page.waitForEvent('filechooser', { timeout: budgetMs })
    // The rejection is handled where the chooser is awaited; this only stops an unhandled
    // rejection if the click below fails first.
    pending.catch(() => undefined)
    try {
      await handle.click({ timeout: this.timeoutMs })
    } catch (error) {
      throw classifyActionFailure(error, `clicking ref ${ref} (${description}) to open a file chooser`)
    }
    try {
      return await pending
    } catch (error) {
      throw new ViewActionError(
        'failed',
        `browser-view: clicking ref ${ref} (${description}) opened no file chooser within ${budgetMs}ms — ` +
          'the element is clickable but it is not a file input and it does not open one, so there is nothing to ' +
          'give the file to. Use the ref of the file input itself, or of the control that really opens the picker ' +
          `(the engine said: ${firstLine(error instanceof Error ? error.message : String(error))}).`,
      )
    }
  }

  /**
   * Read back what the page's own `FileList` holds after a file was handed over.
   *
   * @param handle - the input the files went into.
   * @param ref - the ref the action named.
   * @param description - how the element is named in messages.
   * @param via - which route delivered the file.
   * @param path - the absolute path that was handed over.
   * @returns the page's own answer.
   */
  private async readUpload(
    handle: ElementHandle,
    ref: number,
    description: string,
    via: 'input' | 'filechooser',
    path: string,
  ): Promise<UploadResult> {
    const held = (await handle.evaluate((element) => {
      const input = element as HTMLInputElement
      const files = input.files
      if (files === null || files.length === 0) return { count: 0, name: '', size: 0 }
      return { count: files.length, name: files[0].name, size: files[0].size }
    })) as { count: number; name: string; size: number }
    if (held.count === 0) {
      throw new ViewActionError(
        'failed',
        `browser-view: ${basename(path)} was handed to ref ${ref} (${description}) but the input still holds no ` +
          'files, so the page never received it. Nothing was uploaded.',
      )
    }
    return { ref, element: description, via, path, count: held.count, name: held.name, size: held.size }
  }

  /**
   * What the shell recorded about downloads, newest last.
   *
   * The journal is the shell's own file in the space channel (ADR-0011), read on demand:
   * a download that happened while nothing was watching is still there, and a download
   * that is still running says so rather than being reported as a finished file.
   *
   * @returns the journal.
   * @throws when there is no shell to ask, or when the shell's journal cannot be read.
   */
  async downloads(): Promise<DownloadJournal> {
    this.assertOpen()
    const raw = await this.readDownloadJournal()
    return raw
  }

  /**
   * One download's record plus a preview of the bytes really on disk.
   *
   * The preview is read here, by this process, **after** checking that the file the shell
   * named exists and is as large as the shell said. A preview of a path that was not
   * checked would be exactly the kind of claim this project refuses elsewhere: the answer
   * to "where did my download go" has to be a file that was actually opened.
   *
   * @param id - the record's id, as listed by {@link AdoptedViewSession.downloads}.
   * @param maxChars - cut the preview at this many characters; defaults to the session cap.
   * @returns the record and, when it was readable, its preview.
   * @throws when there is no such record, or when the journal cannot be read.
   */
  async readDownload(id: number, maxChars?: number): Promise<DownloadReading> {
    this.assertOpen()
    const journal = await this.readDownloadJournal()
    const record = journal.downloads.find((candidate) => candidate.id === id)
    if (record === undefined) {
      const known = journal.downloads.map((candidate) => `#${String(candidate.id)} ${candidate.filename}`).join(', ')
      throw new ViewActionError(
        'not-found',
        `browser-view: there is no download #${String(id)} in the shell's journal (it knows: ${known === '' ? 'none' : known}). ` +
          'Call browser_download without an id to list them.',
      )
    }
    if (record.state !== 'completed') {
      return {
        record,
        unreadable:
          record.state === 'started'
            ? 'the shell says this download has not finished yet, so there are no bytes to read'
            : `the shell says this download was ${record.state}, so there is no file to read`,
      }
    }
    const bytes = await readFile(record.savePath).catch((error: unknown) => {
      throw new ViewActionError(
        'failed',
        `browser-view: the shell recorded download #${String(id)} at ${record.savePath}, but that file could not be ` +
          `read (${error instanceof Error ? firstLine(error.message) : String(error)}). The path the shell published ` +
          'is the only one this plugin will report — nothing is guessed from the download event.',
      )
    })
    if (bytes.byteLength !== record.bytes) {
      return {
        record,
        unreadable:
          `the file at ${record.savePath} is ${String(bytes.byteLength)} byte(s) while the shell recorded ` +
          `${String(record.bytes)}, so it is not the file the shell finished writing`,
      }
    }
    return { record, preview: previewDownload(bytes, maxChars ?? this.maxChars) }
  }

  /** Read and parse the shell's download journal, saying plainly when it cannot be read. */
  private async readDownloadJournal(): Promise<DownloadJournal> {
    if (this.downloadJournalFile === undefined) {
      throw new ViewActionError(
        'failed',
        'browser-view: there is no shell to ask about downloads — this plugin was mounted without a task-space ' +
          'channel, so nothing is publishing what was downloaded or where it was saved. The download event alone ' +
          'cannot answer that on this host (its own path points at a file that does not exist).',
      )
    }
    const raw = await readFile(this.downloadJournalFile, 'utf8').catch((error: unknown) => {
      throw new ViewActionError(
        'failed',
        `browser-view: the shell has published no download journal at ${this.downloadJournalFile} ` +
          `(${error instanceof Error ? firstLine(error.message) : String(error)}). No download has completed under ` +
          'this browser profile yet.',
      )
    })
    const journal = parseDownloadJournal(raw)
    if (journal === undefined) {
      throw new ViewActionError(
        'failed',
        `browser-view: the download journal at ${this.downloadJournalFile} could not be understood, so what was ` +
          'downloaded and where it was saved cannot be answered from here. It may be mid-write; try again.',
      )
    }
    return journal
  }

  /**
   * Answer one dialog, right now, from the policy.
   *
   * The handler is asynchronous because the engine requires it to be — a handler that
   * does not return a promise is not "handling" anything, it is just watching, and
   * Playwright closes the dialog itself. But nothing here ever *waits*: the answer is
   * computed from data and sent immediately, so the page is never left blocked on a model
   * that is itself waiting for the page (see `src/dialogs.ts` for the measurements).
   *
   * @param dialog - the dialog the engine just reported.
   */
  private async answerDialog(dialog: Dialog): Promise<void> {
    const plan = planDialogAnswer(dialog.type(), this.dialogPolicy, dialog.defaultValue())
    const record: DialogRecord = {
      type: dialog.type(),
      message: dialog.message(),
      defaultPrompt: dialog.defaultValue(),
      accept: plan.answer.accept,
      ...(plan.answer.promptText !== undefined ? { promptText: plan.answer.promptText } : {}),
      decidedBy: plan.decidedBy,
      at: Date.now(),
    }
    this.dialogRecords.push(record)
    if (this.dialogRecords.length > MAX_DIALOG_RECORDS) this.dialogRecords.shift()
    try {
      if (plan.answer.accept) await dialog.accept(plan.answer.promptText)
      else await dialog.dismiss()
    } catch (error) {
      // A dialog that is already gone is not a failure of the action that raised it, but
      // it *is* a fact about this record: the answer did not take effect.
      record.answerError = firstLine(error instanceof Error ? error.message : String(error))
    }
  }

  /** Keep one download start, dropping the oldest past the bound. */
  private pushDownloadStart(start: DownloadStart): void {
    this.downloadStarts.push(start)
    if (this.downloadStarts.length > MAX_DOWNLOAD_STARTS) this.downloadStarts.shift()
  }

  /** The dialogs-and-downloads note for one action, as lines a caller can append. */
  describeActivity(activity: ActionActivity): string[] {
    const lines = describeDialogActivity(activity.dialogs)
    for (const start of activity.downloads) {
      lines.push(
        `a download started while this action ran: ${start.filename} from ${start.url} — where it was saved is the ` +
          'shell\'s answer; ask browser_download',
      )
    }
    return lines
  }

  /**
   * Decide whether one response is data to keep, a failure to report, or neither.
   *
   * The split is by status: a payload that came back `ok` is data the page loaded, while
   * a 4xx/5xx is a failure whose *reason* is what the model needs. Keeping a 404 JSON
   * body in the data list as well would let "the API answered" and "the API refused"
   * look the same in `browser_json`.
   *
   * @param response - the response the page received.
   */
  private async captureResponse(response: Response): Promise<void> {
    try {
      const status = response.status()
      if (status >= 400) {
        let summary = ''
        try {
          summary = cutText((await response.text()).replace(/\s+/g, ' ').trim(), FAILURE_SUMMARY_CHARS)
        } catch {
          // A body that cannot be read leaves the status and the reason phrase, which is
          // still a diagnosis; the failure is reported either way.
          summary = ''
        }
        this.pushFailedRequest({
          method: response.request().method(),
          url: response.url(),
          status,
          statusText: response.statusText(),
          summary: summary === '' ? '(the response body could not be read)' : summary,
        })
        return
      }
      const contentType = (response.headers()['content-type'] ?? '').toLowerCase()
      if (!contentType.includes('json') && !contentType.includes('javascript')) return
      const body = parseJsonBody(await response.text())
      if (body === undefined) return
      this.jsonResponses.push({ url: response.url(), status, body })
      if (this.jsonResponses.length > MAX_JSON_RESPONSES) this.jsonResponses.shift()
    } catch {
      // Reading a response that the page itself cancelled is not a diagnosis; the
      // request-failed listener reports that case with the engine's own reason.
    }
  }

  /** Keep one console message, dropping the oldest past the bound. */
  private pushConsole(message: ConsoleMessageRecord): void {
    this.consoleMessages.push(message)
    if (this.consoleMessages.length > MAX_CONSOLE_MESSAGES) this.consoleMessages.shift()
  }

  /** Keep one failed request, dropping the oldest past the bound, without duplicates. */
  private pushFailedRequest(request: FailedRequestRecord): void {
    const duplicate = this.failedRequests.some(
      (seen) => seen.method === request.method && seen.url === request.url && seen.status === request.status,
    )
    if (duplicate) return
    this.failedRequests.push(request)
    if (this.failedRequests.length > MAX_FAILED_REQUESTS) this.failedRequests.shift()
  }

  /**
   * Start the observation buffers over.
   *
   * Called when the main frame navigates: the console, the JSON and the failures that
   * have been collected so far describe a document the view no longer shows.
   */
  private forgetPageObservations(): void {
    this.jsonResponses = []
    this.consoleMessages = []
    this.failedRequests = []
  }

  /**
   * The element a ref addresses, checked before anything is done to it.
   *
   * Every ref-based action goes through this, so the answers "is this the document the
   * snapshot was read from", "is the element still there", "is it rendered", and "is it
   * in the viewport" cannot differ between actions — the failure a caller gets depends
   * on the page, never on which tool happened to be called.
   *
   * The order is the order of the remedies: a ref from another document is refused
   * before anything is asked about the node (a handle from the old document is already
   * dead), a missing node before a hidden one, and a hidden one before the hit test —
   * a hidden element has a rectangle only sometimes, so covering it is not the reason
   * it cannot be acted on.
   *
   * @param ref - 1-based ref from the most recent snapshot.
   * @param action - how the action is described in a failure message.
   * @param scrollIntoView - scroll the element into the viewport before judging it.
   * @returns the pinned element and what was learned about it.
   */
  private async targetOf(ref: number, action: string, scrollIntoView = false): Promise<RefTarget> {
    const entry = this.refs.get(ref)
    if (entry === undefined) throw new ViewActionError('not-found', this.unknownRefMessage(ref))
    if (!(await this.isEntryDocument(entry))) {
      throw new ViewActionError('stale-ref', this.staleDocumentMessage(ref))
    }
    let facts = (await entry.handle.evaluate(inspectElement)) as ElementFacts
    if (!facts.connected) throw new ViewActionError('not-found', this.missingElementMessage(ref, facts))
    // The engine's own predicate, not a second definition of "visible": this is the
    // same function behind the `:visible` in the snapshot's selector, so what the
    // snapshot listed is what can be acted on (ADR-0005, ADR-0007).
    if (!(await entry.handle.isVisible())) {
      throw new ViewActionError('not-visible', this.notVisibleMessage(ref, facts, action))
    }
    let view = await this.viewFacts(entry, facts)
    if (scrollIntoView && !view.inViewport) {
      // The engine scrolls before a pointer action anyway; doing it here means the hit
      // test below is taken at the point the action will really use.
      await entry.handle.scrollIntoViewIfNeeded({ timeout: this.timeoutMs })
      facts = (await entry.handle.evaluate(inspectElement)) as ElementFacts
      view = await this.viewFacts(entry, facts)
    }
    return { handle: entry.handle, facts: view }
  }

  /**
   * Translate one frame-local look at an element into this view's coordinates.
   *
   * For a main-frame element this is the identity — its own `getBoundingClientRect()` *is*
   * a view-coordinate rectangle — so nothing extra is asked of the page.
   *
   * For an element inside a frame, two things change and both are about the frame
   * boundary:
   *
   *  - **the rectangle moves** by the frame's origin, because bounds mean "where this is
   *    in the view", and the overlay (which only ever exists in the top document) draws in
   *    that space. The raw numbers are still the page's own, unrounded; this adds one
   *    translation and nothing else.
   *  - **"is it in the viewport" and "is it covered" become questions for two documents.**
   *    A frame-local probe cannot see something the *parent* drew over the iframe, so the
   *    point is probed in the top document as well and has to land on the frame. A frame
   *    element off the edge of the view is reported as out of the viewport even when it
   *    sits comfortably inside its own frame's viewport.
   *
   * @param entry - the pinned element's frame bookkeeping.
   * @param facts - what the element's own document answered.
   * @returns facts with `rect`, `inViewport` and `hit` expressed in view coordinates.
   */
  private async viewFacts(entry: RefEntry, facts: ElementFacts): Promise<ElementFacts> {
    if (entry.frameElement === undefined) return facts
    const viewRect: ElementBounds = {
      x: facts.rect.x + entry.origin.x,
      y: facts.rect.y + entry.origin.y,
      width: facts.rect.width,
      height: facts.rect.height,
    }
    const evaluate = this.page.evaluate.bind(this.page) as unknown as (
      pageFunction: (input: [Element, ElementBounds]) => TopHit,
      arg: [ElementHandle<Element>, ElementBounds],
    ) => Promise<TopHit>
    const top = await evaluate(inspectInTopDocument, [entry.frameElement, viewRect])
    // A cover inside the frame is named by the frame's own answer (it knows the node); a
    // cover in the parent is named by the top document's. Which one is reported matters:
    // the remedy is on whichever side of the boundary the covering element lives.
    if (facts.hit !== null && !facts.hit.same) {
      return { ...facts, rect: viewRect, inViewport: top.inViewport, hit: { ...facts.hit, point: top.point ?? facts.hit.point } }
    }
    if (!top.inViewport || top.point === null) {
      return { ...facts, rect: viewRect, inViewport: false, hit: null }
    }
    if (!top.same) {
      return {
        ...facts,
        rect: viewRect,
        inViewport: true,
        hit: { point: top.point, same: false, description: top.description },
      }
    }
    return { ...facts, rect: viewRect, inViewport: true, hit: { point: top.point, same: true, description: facts.hit?.description ?? facts.description } }
  }

  /**
   * Refuse a pointer action that would land on some other element.
   *
   * Being listed by the snapshot and being clickable are not the same thing: an overlay
   * that is not an interactive element at all, or one that simply sits on top, leaves
   * the element visible and covered. Without this check that case is only distinguishable
   * from an element that never settles by reading a retry log after a full timeout.
   *
   * No verdict is given when no part of the element is in the viewport: there is no
   * point to probe, and a pointer action would scroll first, which changes the answer.
   * That boundary is recorded in ADR-0008 rather than guessed at here.
   *
   * @param ref - 1-based ref the action named.
   * @param facts - what {@link targetOf} learned about the element.
   * @param action - how the action is described in a failure message.
   */
  private assertClickable(ref: number, facts: ElementFacts, action: string): void {
    if (facts.hit === null || facts.hit.same) return
    throw new ViewActionError('obscured', this.obscuredMessage(ref, facts, action))
  }

  /**
   * Run an engine action, turning its failure into a named reason.
   *
   * @param subject - what was attempted, naming the ref and the element.
   * @param run - the engine call.
   */
  private async perform(subject: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      throw classifyActionFailure(error, subject)
    }
  }

  /**
   * Make sure the overlay exists in the current document.
   *
   * Idempotent by construction (the page-side mount looks before it creates, measured:
   * running it twice in one document leaves exactly one container), so every caller can
   * just ask for it rather than track whether it already happened.
   */
  private async mountOverlayInPage(): Promise<void> {
    try {
      await this.page.evaluate(mountOverlay, this.overlay)
    } catch {
      // An evaluation that lands in the gap between two documents is refused by a
      // destroyed execution context. That is not a failure: the next document mounts its
      // own overlay through the init script registered in the constructor.
    }
  }

  /**
   * Draw one mark on the overlay.
   *
   * The overlay is a hint for a person watching, so a draw that cannot happen is dropped
   * rather than raised: it must never be a reason for an action to fail. There is one
   * case where it is dropped silently — a document whose overlay is not there (the page
   * removed it, or the mount for this document has not landed yet) — and the marks simply
   * do not appear in it. Mounting has its own three paths (this document on adoption,
   * every new document through the init script, and `framenavigated`) and a fourth, hidden
   * one inside the painter would only make "who mounts" unanswerable (T8).
   *
   * @param kind - which mark to draw.
   * @param point - where, in viewport CSS pixels; only point-shaped marks use it.
   */
  private async paint(kind: OverlayKind, point?: ViewPoint): Promise<void> {
    try {
      await this.overlayReady
      await this.page.evaluate(
        paintOverlay,
        point === undefined ? { config: this.overlay, kind } : { config: this.overlay, kind, point },
      )
    } catch {
      /* a mark that cannot be drawn is not an action failure */
    }
  }

  /**
   * The overlay half of one action: aim before, and the *outcome* after.
   *
   * It wraps the **whole** action body, including "resolve the element and decide whether
   * it can be acted on" — three of the four failure reasons (not-visible, obscured,
   * not-found) are thrown there, before the action has begun. Only a contract that
   * encloses that step can promise "a failure is drawn as a failure, wherever it came
   * from"; a wrapper around the engine call alone would show a failure mark only when the
   * engine was the one that failed.
   *
   * The two halves say different things on purpose: the cursor means "the agent is aiming
   * here", the ripple means "it landed here", and a failure draws a red ring over the
   * whole viewport instead — so a click that never happened is never drawn as a click
   * that did.
   *
   * @param body - the action; it reports where it aims and, when that differs, where it
   *   lands, through the {@link ActionOverlay} it is handed.
   * @returns whatever the body returned.
   */
  private async action<T>(body: (overlay: ActionOverlay) => Promise<T>): Promise<T> {
    let aimed: ViewPoint | undefined
    let where: ViewPoint | undefined
    let reported = false
    const overlay: ActionOverlay = {
      aim: async (point) => {
        aimed = point
        if (point !== undefined) await this.paint('aim', point)
      },
      landed: (point) => {
        where = point
        reported = true
      },
    }
    let result: T
    try {
      result = await body(overlay)
    } catch (error) {
      await this.paint('failed')
      throw error
    }
    const landed = reported ? where : aimed
    // No point at all means the action was about the page as a whole (a direction scroll,
    // a key press with no ref): a ring around the view is the honest shape for that, where
    // a cursor would claim the agent pointed somewhere it did not.
    await this.paint(landed === undefined ? 'page' : 'point', landed)
    return result
  }

  /**
   * The overlay half of one read: the viewport lights up while the page is being read.
   *
   * The flash carries no text on purpose — a text node anywhere in the overlay would
   * put characters into the page's own `innerText`, and `browser_extract` promises to
   * return exactly that (T8's measurement three).
   *
   * It is drawn at the *start* of the read, because a slow read is the case a person
   * most needs to see; and if the read outlasts the flash it is drawn again at the end,
   * so a long read does not end with no visible sign that it finished.
   *
   * @param read - the read itself.
   * @returns whatever the read returned.
   */
  private async withReadFlash<T>(read: () => Promise<T>): Promise<T> {
    const started = Date.now()
    await this.paint('read')
    try {
      return await read()
    } finally {
      if (readFlashNeedsSecondPaint(Date.now() - started, MARK_PLANS.read.lifetimeMs ?? 0)) {
        await this.paint('read')
      }
    }
  }

  /**
   * Take the marks off the overlay before the agent photographs the page.
   *
   * The image `browser_screenshot` returns is the page, for a model that asked to see
   * the page: a leftover cursor or ring in it would be the agent photographing its own
   * furniture. Measured: with no marks on it the overlay contributes exactly zero
   * pixels, so what the capture contains is the page and nothing else (T8).
   */
  private async clearOverlayMarks(): Promise<void> {
    try {
      await this.page.evaluate(clearOverlay, this.overlay)
    } catch {
      /* as above: housekeeping for a hint */
    }
  }

  /**
   * Why a wait ended without the page changing.
   *
   * A wait that ends without what it waited for is a timeout by construction; anything
   * else (a selector the engine cannot even parse) is reported with the engine's words
   * rather than dressed up as one.
   *
   * @param what - what was awaited, in words a model can act on.
   * @param timeoutMs - how long it was given.
   * @param error - what the engine threw.
   */
  private timedOutWaiting(what: string, timeoutMs: number, error: unknown): ViewActionError {
    const message = error instanceof Error ? error.message : String(error)
    if (!/\bTimeout \d+ms exceeded\b/.test(message)) {
      return new ViewActionError('failed', `browser-view: waiting for ${what} failed: ${firstLine(message)}`)
    }
    return new ViewActionError(
      'timeout',
      `browser-view: waiting for ${what} timed out after ${timeoutMs}ms — it never appeared (the view is at ` +
        `${this.page.url()}). The page may still be loading, or nothing may match: check it with browser_snapshot.`,
    )
  }

  /**
   * Whether the frame a ref came from still shows the document that ref was read from.
   *
   * This is the check that makes "a ref belongs to one document" enforceable rather
   * than merely intended: an event listener that clears the table can only run after
   * the navigation it observes, so in the window between a navigation committing and
   * its `load` event the table still holds entries that mean nothing. Reading the
   * current document's own identity at action time has no such window, and it is also
   * the check that can *name* the reason — a pinned node from a dead document reports
   * only that it is disconnected, which would be indistinguishable from a node the
   * page removed (ADR-0008).
   *
   * Since T9 the question is asked of **the ref's own frame**: a ref into an iframe is
   * invalidated by that frame navigating, and *not* by the main document navigating —
   * except that a main-document navigation takes the whole frame tree with it, which the
   * frame's own disappearance (a rejected evaluation) reports as the same "no".
   *
   * @param entry - the pinned element's frame bookkeeping.
   * @returns true only when that frame's current document is the one the ref came from.
   */
  private async isEntryDocument(entry: RefEntry): Promise<boolean> {
    try {
      return (await entry.frame.evaluate(() => String(performance.timeOrigin))) === entry.token
    } catch {
      // A destroyed execution context — or a frame that is gone — means the document is
      // gone, which is exactly the case this check exists to catch, so it is a "no", not
      // a failure to report.
      return false
    }
  }

  /** Drop the ref table, releasing every node it pinned. */
  private async forgetRefs(): Promise<void> {
    const previous = this.refs
    this.refs = new Map()
    const entries = [...previous.values()]
    await disposeHandles(entries.map((entry) => entry.handle))
    await disposeHandles(
      entries
        .map((entry) => entry.frameElement)
        .filter((handle): handle is ElementHandle<Element> => handle !== undefined),
    )
  }

  /** Why a ref number is not one the most recent snapshot handed out. */
  private unknownRefMessage(ref: number): string {
    return (
      `browser-view: ref ${ref} is not in the most recent snapshot (${this.refs.size} ref(s) available) — ` +
      'call browser_snapshot and use a ref from that result'
    )
  }

  /** Why a ref that a snapshot did hand out can no longer be used. */
  private staleDocumentMessage(ref: number): string {
    return (
      `browser-view: ref ${ref} belongs to a document the view no longer shows ` +
      `(it is now at ${this.page.url()}) — call browser_snapshot again and use a ref from that result`
    )
  }

  /**
   * Why the element a snapshot listed is not there any more.
   *
   * This is the one case a positional ref could not report: with the index resolving
   * to "the Nth match", a removed element made the *next* element take its ref, and the
   * action landed on a different control without a word. A pinned node cannot do that,
   * so the honest answer — it is gone — is also the only one available (ADR-0008).
   */
  private missingElementMessage(ref: number, facts: ElementFacts): string {
    return (
      `browser-view: ref ${ref} (${facts.description}) does not exist any more — the element the snapshot ` +
      'listed has been removed from the document, so there is nothing to act on; ' +
      'call browser_snapshot and use a ref from that result'
    )
  }

  /** Why an element that is in the document cannot be acted on. */
  private notVisibleMessage(ref: number, facts: ElementFacts, action: string): string {
    return (
      `browser-view: ref ${ref} (${facts.description}) is not visible, so it cannot be ${action} — it has no ` +
      'rendered box, or it is visibility: hidden. That is the same :visible rule the snapshot uses, so an ' +
      'element can be listed and stop being visible afterwards (a page may hide it); make it visible first, ' +
      'or call browser_snapshot to see what is actionable now'
    )
  }

  /** Why a pointer action would not land on the element it named. */
  private obscuredMessage(ref: number, facts: ElementFacts, action: string): string {
    const hit = facts.hit as ElementHit
    return (
      `browser-view: ref ${ref} (${facts.description}) is obscured, so it cannot be ${action} — the element at ` +
      `its centre point (x=${hit.point.x}, y=${hit.point.y}) is ${hit.description}, which is what the action ` +
      'would land on. Scroll it clear, move or dismiss the covering element, or act on that element by its own ref'
    )
  }

  /** Current document title of the view. */
  async title(): Promise<string> {
    this.assertOpen()
    return await this.page.title()
  }

  /** Current address of the view. */
  url(): string {
    this.assertOpen()
    return this.page.url()
  }

  /**
   * Text content of the first element matching `selector`.
   * @throws when no element matches within the timeout.
   */
  async textOf(selector: string): Promise<string> {
    this.assertOpen()
    const text = await this.page.locator(selector).first().textContent({ timeout: this.timeoutMs })
    return text ?? ''
  }

  /**
   * Click the first element matching `selector`.
   * @throws when no element matches or it is not actionable within the timeout.
   */
  async click(selector: string): Promise<void> {
    this.assertOpen()
    await this.page.locator(selector).first().click({ timeout: this.timeoutMs })
  }

  /** Underlying Playwright context, for callers that need a CDP session. */
  get cdpContext(): BrowserContext {
    return this.context
  }

  /** Disconnect from the shell. The shell and its view stay alive. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    void this.forgetRefs()
    await this.browser.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('the adopted view session is already closed')
  }
}
