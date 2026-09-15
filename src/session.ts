import type { Browser, BrowserContext, Locator, Page } from 'playwright'
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
   * `ref` (the 1-based snapshot index) → the live locator it resolved to, as of the
   * most recent snapshot. Emptied by every snapshot and by every navigation, so a
   * `ref` can only ever address the document it was read from.
   */
  private refs = new Map<number, Locator>()

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
    // finished loading is housekeeping, not the guarantee: `clickRef` compares the
    // document identities itself, because from the moment a navigation commits until
    // its load event a locator already resolves inside the new document.
    page.on('load', () => {
      this.refs.clear()
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
    this.refs.clear()
    await this.page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs })
    return { title: await this.page.title(), url: this.page.url() }
  }

  /**
   * Project the current page into a snapshot: title, address, and the visible
   * interactive elements with their bounds, in document order.
   *
   * The 1-based `ref` of each element is what {@link clickRef} resolves against, and
   * it is captured by this call and this call only: taking a snapshot replaces the ref
   * table and the document identity together, so refs never outlive the document they
   * were read from.
   *
   * @returns the snapshot; `truncated` is set when the page exceeded the element cap.
   */
  async snapshot(): Promise<PageSnapshot> {
    this.assertOpen()
    const locator = this.page.locator(SNAPSHOT_SELECTOR)
    const collected = await locator.evaluateAll(collectSnapshot)
    const url = this.page.url()
    const truncated = collected.elements.length > this.maxElements
    const kept = truncated ? collected.elements.slice(0, this.maxElements) : collected.elements
    const elements: SnapshotElement[] = []
    const refs = new Map<number, Locator>()
    for (let index = 0; index < kept.length; index++) {
      const ref = index + 1
      elements.push({ ref, ...kept[index] })
      refs.set(ref, locator.nth(index))
    }
    this.refs = refs
    this.documentToken = collected.token
    return { title: collected.title, url, elements, ...(truncated ? { truncated: true } : {}) }
  }

  /**
   * Click the element a `ref` from the most recent snapshot addressed.
   *
   * This is the narrowest way to *use* a ref, and it is what makes "the refs were
   * cleared" observable from the outside: a stale ref is refused here rather than
   * silently resolving to whatever element happens to sit at that index now. The
   * wider interaction surface (typing, hovering, pressing keys) is a later ticket's
   * job and is built on the same table.
   *
   * @param ref - 1-based ref from the most recent snapshot on this page.
   * @throws when no snapshot has been taken, when the document has changed since, or
   *   when the ref was beyond the element cap.
   */
  async clickRef(ref: number): Promise<void> {
    this.assertOpen()
    const locator = this.refs.get(ref)
    if (locator === undefined) throw new Error(this.unknownRefMessage(ref))
    if (!(await this.isSnapshotDocument())) throw new Error(this.staleDocumentMessage(ref))
    await locator.click({ timeout: this.timeoutMs })
  }

  /**
   * Whether the view still shows the document the most recent snapshot was read from.
   *
   * This is the check that makes "a ref belongs to one document" enforceable rather
   * than merely intended: an event listener that clears the table can only run after
   * the navigation it observes, while a locator index resolves against whatever the
   * page shows *now*. Reading the current document's own identity at action time has
   * no such window.
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
    await this.browser.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('the adopted view session is already closed')
  }
}
