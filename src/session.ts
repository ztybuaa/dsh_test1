import type { Browser, BrowserContext, Page } from 'playwright'
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
}

/** Outcome of a navigation: the address actually reached, and its title. */
export interface NavigationResult {
  /** Document title of the page after loading. */
  title: string
  /** Final address, which may differ from the requested one after redirects. */
  url: string
}

/** How long a default action may take when the caller does not say. */
const DEFAULT_TIMEOUT_MS = 30_000

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

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    /** CDP target id of the adopted view. */
    readonly targetId: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Connect to the shell and take over the view it published.
   * @param options - endpoint, view identity, and timeouts.
   * @returns a session bound to the view.
   * @throws when no single page matches the published identity.
   */
  static async adopt(options: AdoptOptions): Promise<AdoptedViewSession> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
      return new AdoptedViewSession(browser, match.context, match.page, probe.targetId, timeoutMs)
    } catch (error) {
      // A failed adoption must not leave a dangling connection behind.
      await browser.close().catch(() => undefined)
      throw error
    }
  }

  /** Navigate the view and report where it landed. */
  async goto(url: string): Promise<NavigationResult> {
    this.assertOpen()
    await this.page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs })
    return { title: await this.page.title(), url: this.page.url() }
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
