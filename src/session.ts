import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright'
import { chromium } from 'playwright'

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
}

/** Outcome of a navigation: the address actually reached, and its title. */
export interface NavigationResult {
  /** Document title of the page after loading. */
  title: string
  /** Final address, which may differ from the requested one after redirects. */
  url: string
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

/** The element a ref addresses, pinned, plus what one look at it answered. */
interface RefTarget {
  /** The node the snapshot listed. */
  handle: ElementHandle
  /** What {@link inspectElement} answered about it just now. */
  facts: ElementFacts
}

/** How long a default action may take when the caller does not say. */
const DEFAULT_TIMEOUT_MS = 30_000

/** How many elements one snapshot lists before it is truncated. */
export const DEFAULT_MAX_ELEMENTS = 200

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
 */
const SNAPSHOT_SELECTOR = [
  'a[href]:visible',
  'button:visible',
  'input:visible',
  'select:visible',
  'textarea:visible',
  '[contenteditable="true"]:visible',
  ...INTERACTIVE_ROLES.map((role) => `[role="${role}"]:visible`),
].join(', ')

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
  /** One record per matched element, in document order. */
  elements: CollectedElement[]
}

/**
 * Collect the document's title and identity plus one record per matched element.
 *
 * Playwright serializes this function into the page and calls it **once** with the
 * whole match set, so the title, the document token, and every element's
 * role/name/state/geometry all come from one evaluation of one document — the parts of
 * a snapshot cannot disagree about which document or which element they describe, and a
 * snapshot costs one round-trip rather than one per element (see ADR-0007 for why this
 * beats `DOMSnapshot.captureSnapshot`).
 *
 * Everything it needs is declared inside it on purpose: only this function's *source*
 * crosses into the page, so a helper defined beside it in this module would be a
 * `ReferenceError` there rather than a call.
 *
 * @param elements - the elements the snapshot selector matched, in document order.
 * @returns the document facts plus one metadata record per element, in that order.
 */
function collectSnapshot(elements: Element[]): CollectedSnapshot {
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
      const labels = (element as HTMLInputElement).labels
      if (labels !== undefined && labels !== null && labels.length > 0) name = (labels[0].textContent ?? '').trim()
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

  return {
    title: document.title,
    token: String(performance.timeOrigin),
    elements: elements.map(describe),
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

/** Release handles, ignoring failures: disposal is housekeeping, never a result. */
async function disposeHandles(handles: Iterable<ElementHandle>): Promise<void> {
  await Promise.all([...handles].map((handle) => handle.dispose().catch(() => undefined)))
}

/** The first line of an engine message, without the call log and the stack. */
function firstLine(message: string): string {
  const line = message.split('\n').find((candidate) => candidate.trim() !== '')
  return (line ?? message).trim()
}

/** The engine's own last word on why an action never landed, when it has one. */
function engineNote(message: string): string {
  const line = message
    .split('\n')
    .reverse()
    .find((candidate) => /intercepts pointer events|is not visible/.test(candidate))
  return line === undefined ? '' : line.replace(/^\s*-\s*/, '').trim()
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
   */
  private refs = new Map<number, ElementHandle>()

  /**
   * Identity of the document the ref table was read from, or undefined when no
   * snapshot has been taken. Checked before every ref-based action.
   */
  private documentToken: string | undefined

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    /** CDP target id of the adopted view. */
    readonly targetId: string,
    private readonly timeoutMs: number,
    private readonly maxElements: number,
  ) {
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
      void disposeHandles(this.refs.values())
      this.refs = new Map()
    })
  }

  /**
   * Connect to the shell and take over the view it published.
   * @param options - endpoint, view identity, timeouts, and the snapshot cap.
   * @returns a session bound to the view.
   * @throws when no single page matches the published identity.
   */
  static async adopt(options: AdoptOptions): Promise<AdoptedViewSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
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
      return new AdoptedViewSession(browser, match.context, match.page, probe.targetId, timeoutMs, maxElements)
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
    void disposeHandles(this.refs.values())
    this.refs = new Map()
    await this.page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs })
    return { title: await this.page.title(), url: this.page.url() }
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
    const locator = this.page.locator(SNAPSHOT_SELECTOR)
    const handles = await locator.elementHandles()
    // The handles go in as the page function's argument, and Playwright resolves them to
    // the nodes they reference, so the metadata is read from exactly the elements that
    // were pinned. Reaching `evaluate` through a bound, explicitly typed reference is
    // what keeps that call expressible: the public typings model the handle→node
    // translation with a recursive conditional type that the compiler refuses to
    // instantiate for an array of elements.
    const evaluate = this.page.evaluate.bind(this.page) as unknown as (
      pageFunction: (elements: Element[]) => CollectedSnapshot,
      arg: readonly ElementHandle[],
    ) => Promise<CollectedSnapshot>
    const collected = await evaluate(collectSnapshot, handles)
    const url = this.page.url()
    const truncated = collected.elements.length > this.maxElements
    const kept = truncated ? collected.elements.slice(0, this.maxElements) : collected.elements
    const elements: SnapshotElement[] = []
    const refs = new Map<number, ElementHandle>()
    for (let index = 0; index < kept.length; index++) {
      const ref = index + 1
      elements.push({ ref, ...kept[index] })
      refs.set(ref, handles[index])
    }
    const previous = this.refs
    this.refs = refs
    this.documentToken = collected.token
    // The matches past the cap have no ref, so nothing can ever act on them.
    void disposeHandles(handles.slice(refs.size))
    void disposeHandles(previous.values())
    return { title: collected.title, url, elements, ...(truncated ? { truncated: true } : {}) }
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
    const target = await this.targetOf(ref, 'clicked', true)
    this.assertClickable(ref, target.facts, 'clicked')
    await this.perform(`click on ref ${ref} (${target.facts.description})`, () =>
      target.handle.click({ timeout: this.timeoutMs }),
    )
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
    const target = await this.targetOf(ref, 'hovered', true)
    this.assertClickable(ref, target.facts, 'hovered')
    await this.perform(`hover on ref ${ref} (${target.facts.description})`, () =>
      target.handle.hover({ timeout: this.timeoutMs }),
    )
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
    const target = await this.targetOf(ref, 'typed into')
    await this.perform(`typing into ref ${ref} (${target.facts.description})`, () =>
      target.handle.type(text, { timeout: this.timeoutMs }),
    )
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
    const target = await this.targetOf(ref, 'filled')
    await this.perform(`filling ref ${ref} (${target.facts.description})`, () =>
      target.handle.fill(value, { timeout: this.timeoutMs }),
    )
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
    if (ref === undefined) {
      await this.perform(`key press ${JSON.stringify(key)}`, () => this.page.keyboard.press(key))
      return
    }
    const target = await this.targetOf(ref, 'pressed')
    await this.perform(`key press ${JSON.stringify(key)} in ref ${ref} (${target.facts.description})`, () =>
      target.handle.press(key, { timeout: this.timeoutMs }),
    )
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
    const target = await this.targetOf(ref, 'used to select an option')
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
    await this.perform(
      `drag of ref ${fromRef} (${source.facts.description}) onto ref ${toRef} (${target.facts.description})`,
      async () => {
        await this.page.mouse.move(start.x, start.y)
        await this.page.mouse.down()
        await this.page.mouse.move(end.x, end.y, { steps: 12 })
        await this.page.mouse.up()
      },
    )
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
    const target = await this.targetOf(ref, 'scrolled to')
    await this.perform(`scroll to ref ${ref} (${target.facts.description})`, () =>
      target.handle.scrollIntoViewIfNeeded({ timeout: this.timeoutMs }),
    )
    const after = (await target.handle.evaluate(inspectElement)) as ElementFacts
    return after.rect
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
    await this.page.evaluate((pixels) => window.scrollBy(0, pixels), delta)
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
      try {
        await this.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
      } catch (error) {
        throw this.timedOutWaiting(`selector ${JSON.stringify(selector)}`, timeoutMs, error)
      }
      return { waited: `selector ${selector}`, elapsedMs: Date.now() - started }
    }
    const text = options.text as string
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
    const handle = this.refs.get(ref)
    if (handle === undefined) throw new ViewActionError('not-found', this.unknownRefMessage(ref))
    if (!(await this.isSnapshotDocument())) throw new ViewActionError('stale-ref', this.staleDocumentMessage(ref))
    let facts = (await handle.evaluate(inspectElement)) as ElementFacts
    if (!facts.connected) throw new ViewActionError('not-found', this.missingElementMessage(ref, facts))
    // The engine's own predicate, not a second definition of "visible": this is the
    // same function behind the `:visible` in the snapshot's selector, so what the
    // snapshot listed is what can be acted on (ADR-0005, ADR-0007).
    if (!(await handle.isVisible())) throw new ViewActionError('not-visible', this.notVisibleMessage(ref, facts, action))
    if (scrollIntoView && !facts.inViewport) {
      // The engine scrolls before a pointer action anyway; doing it here means the hit
      // test below is taken at the point the action will really use.
      await handle.scrollIntoViewIfNeeded({ timeout: this.timeoutMs })
      facts = (await handle.evaluate(inspectElement)) as ElementFacts
    }
    return { handle, facts }
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
   * Whether the view still shows the document the most recent snapshot was read from.
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
   * @returns true only when a snapshot exists and its document is still the current one.
   */
  private async isSnapshotDocument(): Promise<boolean> {
    if (this.documentToken === undefined) return false
    try {
      return (await this.page.evaluate(() => String(performance.timeOrigin))) === this.documentToken
    } catch {
      // A destroyed execution context means the document is gone — exactly the case
      // this check exists to catch, so it is a "no", not a failure to report.
      return false
    }
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
    void disposeHandles(this.refs.values())
    this.refs = new Map()
    await this.browser.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('the adopted view session is already closed')
  }
}
