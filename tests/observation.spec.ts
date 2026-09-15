import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { inject } from '../src/index.ts'
import {
  AdoptedViewSession,
  DEFAULT_MAX_CHARS,
  type ExtractedText,
  type PageDiagnostics,
  type PageSnapshot,
} from '../src/session.ts'
import { desktopViewTools, type ToolDependencies } from '../src/tools.ts'
import { readPng } from './png-facts.ts'
import { pageForTarget, removeWhenFree, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T5 seam test: "the agent can read the page, and can find out why it is empty".
 *
 * Every assertion is about an *external* fact, and each one is read back from a source
 * that is not the implementation's own intermediate state:
 *
 *  - the extracted text is compared with the page's own `document.body.innerText`, read
 *    over an independent CDP connection, and truncation is checked against that same
 *    text's length;
 *  - the evaluated value is a value the page computed from its own DOM, so a hardcoded
 *    answer cannot pass, and it is cross-read from the page;
 *  - the captured JSON is compared with the payload the *page* recorded receiving (with
 *    a per-response nonce from the fixture server, so neither side can be a constant);
 *  - the screenshot is parsed here — signature, IHDR dimensions, unfiltered pixels —
 *    and its bytes are compared by digest with the bytes the attachment service was
 *    handed, so "delivered as an attachment" is a fact about the image, not about a path
 *    string;
 *  - the console error and the failed request are asserted *first* on the page's own
 *    counters (the fixture really logged, really threw, really got a 404) and only then
 *    in what the tool reported.
 */

/** The tool's execution context is unused by these tools; a stub is enough. */
const IGNORED_EXEC = undefined as unknown as Parameters<ReturnType<typeof desktopViewTools>[number]['execute']>[1]

/** The viewport the shell gives the native view when no panel has reported a rectangle. */
const VIEW = { width: 440, height: 800 }

/** The colour of the fixture page's `#obs-box`, which must be findable in the pixels. */
const FIXTURE_BOX_RGB = '47,111,176'

/** How many times a read is retried while an asynchronously captured fact lands. */
const CAPTURE_ATTEMPTS = 50

/** The digest the test uses to compare two byte sequences it obtained separately. */
function sha256(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/** One image the screenshot tool handed to the attachment service. */
interface SavedImage {
  data: Uint8Array
  mediaType: string
  name?: string
}

/** The attachment service stand-in, plus what it was handed. */
interface RecordingStore {
  saved: SavedImage[]
  saveImage: (input: SavedImage) => Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/**
 * Stand in for `ctx.attachments`, which only exists inside a running DSH host.
 *
 * It is a boundary double, not a stub of the behaviour under test: it parses the bytes it
 * is handed as a PNG and refuses anything that is not one, mints the id from a digest of
 * those bytes, and reports the size it read for itself. A screenshot that published
 * something other than a real PNG of the view therefore fails here, in the store, before
 * any assertion runs.
 *
 * @returns the store and the list of images it received.
 */
function recordingAttachmentStore(): RecordingStore {
  const saved: SavedImage[] = []
  return {
    saved,
    async saveImage(input: SavedImage) {
      const facts = readPng(Buffer.from(input.data))
      saved.push(input)
      return {
        attachmentId: sha256(input.data),
        mediaType: 'image/png',
        bytes: input.data.byteLength,
        width: facts.width,
        height: facts.height,
        ...(input.name !== undefined ? { name: input.name } : {}),
      }
    },
  }
}

describe('T5 — the agent reads the page, and finds out why it is empty', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /** An independent connection to the same view: used only to read the page for itself. */
  let probe: { browser: { close: () => Promise<void> }; page: Page }
  let store: RecordingStore
  let screenshotDir: string
  let tools: ReturnType<typeof desktopViewTools>

  beforeAll(async () => {
    screenshotDir = mkdtempSync(join(tmpdir(), 'dsh-t5-screenshots-'))
    store = recordingAttachmentStore()
    shell = await startShell()
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
    })
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
    tools = desktopViewTools(() => Promise.resolve(session), {
      attachments: store,
      screenshotDir,
    } as ToolDependencies)
  }, 120_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.browser.close().catch(() => undefined)
    if (session !== undefined) await session.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
    // 清理绝不决定结果：一次 EPERM 会让"用例全过"的 spec 文件报红，见 removeWhenFree 的注释。
    if (screenshotDir !== undefined) removeWhenFree(screenshotDir)
  })

  /** Navigate the view to the observation page, which reloads its own side effects. */
  const observe = async (): Promise<void> => {
    await session.goto(`${shell.handshake.fixtureOrigin}/observe`)
  }

  /** The tool with this name, or a failure naming what was registered instead. */
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`${name} is not registered; registered: ${tools.map((t) => t.name).join(', ')}`)
    return found
  }

  /**
   * Run one tool, checking that its declared schema accepts what it produced.
   *
   * The check is the registry's own: a value the host would reject in production cannot
   * pass here by accident.
   */
  const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const definition = tool(name)
    const contract = definition.output as { schema: JsonSchemaNode }
    assertSupportedJsonSchema(contract.schema)
    const value = await definition.execute(args, IGNORED_EXEC)
    expect(validateJsonSchemaValue(contract.schema, value), `${name} produced a value its schema rejects`).toEqual([])
    return value
  }

  /** The content the model actually receives from one tool call. */
  const contentOf = (name: string, args: Record<string, unknown>, value: unknown): Array<Record<string, unknown>> => {
    const contract = tool(name).output as {
      render: (args: unknown, value: unknown) => Array<Record<string, unknown>>
    }
    return contract.render(args, value)
  }

  /** The text blocks of one rendered result, joined, as the model reads them. */
  const renderedText = (name: string, args: Record<string, unknown>, value: unknown): string =>
    contentOf(name, args, value)
      .map((block) => (block.type === 'text' ? String(block.text) : `<${String(block.type)}>`))
      .join('\n')

  /** The page's own rendered text, read over the independent connection. */
  const pageInnerText = async (): Promise<string> =>
    (await probe.page.evaluate(() => document.body.innerText)) as string

  /** Poll the page's own state until `ready`, or fail saying what never happened. */
  const waitForPage = async (ready: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await ready()) return
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((settle) => setTimeout(settle, 50))
    }
  }

  it('registers the observation surface, keeps browser_navigate first, and leaves the snapshot compact', async () => {
    expect(tools[0]?.name).toBe('browser_navigate')
    const names = tools.map((candidate) => candidate.name)
    console.log('RAW registered tools: ' + JSON.stringify(names))
    for (const expected of [
      'browser_extract',
      'browser_evaluate',
      'browser_json',
      'browser_screenshot',
      'browser_diagnostics',
    ]) {
      expect(names, `the observation surface should include ${expected}`).toContain(expected)
    }

    // The service the screenshot is delivered through must be declared, or the loader may
    // mount the plugin without a store and the image would silently become a path.
    console.log('RAW plugin inject: ' + JSON.stringify(inject))
    expect(inject).toContain('tools')
    expect(inject).toContain('attachments')

    // ADR-0001 still holds on the new surface: reading does not become a second way to
    // act. The evaluate description must be explicit about being read-only and about
    // actions going through a ref.
    const evaluate = tool('browser_evaluate')
    console.log('RAW browser_evaluate description: ' + evaluate.description)
    expect(evaluate.description).toContain('read-only')
    expect(evaluate.description).toContain('ref')

    // ADR-0005: the snapshot stays the compact element list, and the page's text is
    // reachable only through the read tool.
    await observe()
    const snapshot = (await run('browser_snapshot', {})) as PageSnapshot
    const snapshotText = renderedText('browser_snapshot', {}, snapshot)
    const pageText = await pageInnerText()
    console.log(
      'RAW snapshot vs page text: ' +
        JSON.stringify({ snapshotChars: snapshotText.length, pageChars: pageText.length, elements: snapshot.elements.length }),
    )
    expect(pageText).toContain('filler line 1')
    expect(pageText.length).toBeGreaterThan(1000)
    expect(snapshotText).not.toContain('filler line 1')
    expect(snapshotText.length).toBeLessThan(2000)
  })

  it('reads the page’s text exactly as the page renders it, and cuts it at the cap', async () => {
    await observe()
    const pageText = await pageInnerText()
    // The premise for the truncation half: there is far more text than the small cap used.
    expect(pageText.length).toBeGreaterThan(200)

    const whole = (await run('browser_extract', {})) as ExtractedText
    console.log('RAW browser_extract (default cap): ' + JSON.stringify({ chars: whole.text.length, truncated: whole.truncated, totalChars: whole.totalChars }))
    expect(whole.text).toBe(pageText)
    expect(whole.truncated).toBe(false)
    expect(whole.totalChars).toBe(pageText.length)
    // The documented default, which the deployment inherits without configuring anything.
    expect(DEFAULT_MAX_CHARS).toBe(20_000)

    const small = 120
    const capped = (await run('browser_extract', { maxChars: small })) as ExtractedText
    console.log('RAW browser_extract (small cap): ' + JSON.stringify({ cap: small, chars: capped.text.length, truncated: capped.truncated, totalChars: capped.totalChars, head: capped.text.slice(0, 40) }))
    // The page's own text really is longer than the cap, so a cut is a cut of something.
    expect(pageText.length).toBeGreaterThan(small)
    expect(capped.text.length).toBeLessThanOrEqual(small)
    // …and what came back is the page's own text, cut — not a different text.
    expect(capped.text).toBe(pageText.slice(0, capped.text.length))
    expect(capped.truncated).toBe(true)
    expect(capped.totalChars).toBe(pageText.length)
    // The model is told that it was cut, in the content it reads.
    const rendered = renderedText('browser_extract', { maxChars: small }, capped)
    console.log('RAW browser_extract rendered tail: ' + JSON.stringify(rendered.slice(-120)))
    expect(rendered).toContain('truncated')
    expect(rendered).toContain(String(pageText.length))
  })

  it('evaluates an expression in the page and reads a value only the page knows', async () => {
    await observe()
    const expression =
      'JSON.stringify({ secret: window.__observeSecret, rows: document.querySelectorAll("#obs-list li").length, title: document.title })'
    const returned = (await run('browser_evaluate', { expression })) as string
    const parsed = JSON.parse(returned) as { secret: string; rows: number; title: string }

    // The same facts, read from the page itself over an independent connection.
    const fromPage = (await probe.page.evaluate(() => ({
      secret: (window as unknown as { __observeSecret: string }).__observeSecret,
      rows: document.querySelectorAll('#obs-list li').length,
      title: document.title,
    }))) as { secret: string; rows: number; title: string }
    console.log('RAW browser_evaluate: ' + JSON.stringify({ returned: parsed, page: fromPage }))

    expect(parsed).toEqual(fromPage)
    expect(parsed.rows).toBe(3)
    // The value is derived from the page's own DOM, so a constant on either side fails.
    expect(parsed.secret).toBe(`t5-${fromPage.rows}-${fromPage.rows * 7}`)
    expect(parsed.title).toBe('observe-page')

    // A string expression comes back as the string itself, not as JSON-quoted text.
    const title = (await run('browser_evaluate', { expression: 'document.title' })) as string
    console.log('RAW browser_evaluate of a bare string: ' + JSON.stringify(title))
    expect(title).toBe('observe-page')

    // An expression that cannot be evaluated is refused with the engine's words, rather
    // than reported as "no value".
    await expect(run('browser_evaluate', { expression: 'this is not javascript(' })).rejects.toThrow(
      /could not be evaluated/,
    )
  })

  it('reads the JSON the page fetched, and it is the payload the page itself received', async () => {
    await observe()
    // The page's own record: it really fetched, and this is what came back.
    await waitForPage(
      async () =>
        (await probe.page.evaluate(
          () => (window as unknown as { __observePayload: unknown }).__observePayload !== null,
        )) as boolean,
      'the fixture page to record the JSON payload it received',
    )
    const pageSide = (await probe.page.evaluate(() => ({
      payload: (window as unknown as { __observePayload: Record<string, unknown> }).__observePayload,
      fetches: (window as unknown as { __observeFetchCount: number }).__observeFetchCount,
    }))) as { payload: { nonce: string; items: number[]; source: string; ok: boolean }; fetches: number }
    console.log('RAW what the page itself received: ' + JSON.stringify(pageSide))
    expect(pageSide.fetches).toBeGreaterThan(0)
    expect(pageSide.payload.items).toEqual([1, 2, 3])
    // The server mints a fresh nonce per response, so the two sides cannot both be a
    // constant that happens to agree.
    expect(typeof pageSide.payload.nonce).toBe('string')
    expect(pageSide.payload.nonce.length).toBeGreaterThan(20)

    // The tool's copy is compared with that payload, field by field.
    let entries: Array<{ url: string; status: number; body: unknown }> = []
    let raw = ''
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      raw = (await run('browser_json', {})) as string
      entries = JSON.parse(raw) as typeof entries
      if (entries.some((entry) => String(entry.url).includes('/api/observe'))) break
      await new Promise((settle) => setTimeout(settle, 100))
    }
    const captured = entries.find((entry) => String(entry.url).includes('/api/observe'))
    console.log('RAW browser_json reported: ' + JSON.stringify({ count: entries.length, captured }))
    expect(captured, `browser_json never reported the fixture's JSON; last value: ${raw}`).toBeDefined()
    expect(captured?.status).toBe(200)
    expect(captured?.body).toEqual(pageSide.payload)

    // A 404 is not data: it is reported by diagnostics with its status, so "the API
    // answered" and "the API refused" cannot look the same here.
    expect(entries.some((entry) => String(entry.url).includes('/api/missing'))).toBe(false)
  })

  it('delivers the screenshot as an image attachment of this view, at the viewport size', async () => {
    await observe()
    store.saved.length = 0
    const viewport = (await probe.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    }))) as { width: number; height: number; dpr: number }
    console.log('RAW the view port as the page sees it: ' + JSON.stringify(viewport))
    expect(viewport.width).toBe(VIEW.width)
    expect(viewport.height).toBe(VIEW.height)

    const value = (await run('browser_screenshot', {})) as {
      path: string
      image: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
    }
    console.log('RAW browser_screenshot value: ' + JSON.stringify(value))

    // The image must cover the view and nothing else: its size is the viewport times the
    // display scale the *page* reports, both directions checked (multiply and divide), so
    // neither a resized nor an off-by-one capture passes.
    const expectedWidth = Math.round(viewport.width * viewport.dpr)
    const expectedHeight = Math.round(viewport.height * viewport.dpr)

    // 1. The file on disk is a real PNG, read here rather than trusting the tool.
    const fileFacts = readPng(readFileSync(value.path))
    console.log(
      'RAW the file, parsed here: ' +
        JSON.stringify({
          bytes: readFileSync(value.path).length,
          width: fileFacts.width,
          height: fileFacts.height,
          bitDepth: fileFacts.bitDepth,
          colorType: fileFacts.colorType,
          distinctColors: fileFacts.colors.size,
          expectedWidth,
          expectedHeight,
        }),
    )
    expect(fileFacts.width).toBe(expectedWidth)
    expect(fileFacts.height).toBe(expectedHeight)
    expect(fileFacts.width / viewport.dpr).toBe(viewport.width)
    expect(fileFacts.height / viewport.dpr).toBe(viewport.height)
    // 2. It is not a blank image: the page's own coloured box is in the pixels, which also
    //    says the picture is of *this* page rather than of an empty surface.
    expect(fileFacts.colors.size).toBeGreaterThan(1)
    expect(fileFacts.colors.has(FIXTURE_BOX_RGB)).toBe(true)
    expect(dirname(value.path).toLowerCase()).toBe(screenshotDir.toLowerCase())
    expect(basename(value.path).startsWith('browser-')).toBe(true)

    // 3. It was delivered as an attachment: the model-facing content carries the image
    //    block with the durable reference, not only the path.
    const blocks = contentOf('browser_screenshot', {}, value)
    console.log('RAW the content the model receives: ' + JSON.stringify(blocks.map((block) => (block.type === 'image' ? { type: 'image', attachment: block.attachment } : block))))
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toBe(`Screenshot saved to: ${value.path}`)
    const image = blocks[1]?.attachment as {
      attachmentId: string
      mediaType: string
      bytes: number
      width: number
      height: number
      name?: string
    }
    expect(blocks[1]?.type).toBe('image')
    expect(image.mediaType).toBe('image/png')
    expect(image.width).toBe(expectedWidth)
    expect(image.height).toBe(expectedHeight)
    // The identifier is a digest of the image bytes: the attachment *is* this PNG.
    expect(image.attachmentId).toBe(sha256(readFileSync(value.path)))
    expect(image.attachmentId).toBe(value.image.attachmentId)
    expect(image.bytes).toBe(readFileSync(value.path).length)

    // 4. The store was handed those same bytes, and it agreed about the size.
    expect(store.saved).toHaveLength(1)
    const handed = Buffer.from(store.saved[0]?.data as Uint8Array)
    console.log('RAW what the attachment service was handed: ' + JSON.stringify({ bytes: handed.length, digest: sha256(handed), name: store.saved[0]?.name }))
    expect(sha256(handed)).toBe(sha256(readFileSync(value.path)))
    expect(store.saved[0]?.mediaType).toBe('image/png')
    expect(store.saved[0]?.name).toBe(basename(value.path))
    expect(readPng(handed).height).toBe(expectedHeight)
  })

  it('reads the console errors and the failed requests the page really produced', async () => {
    await observe()
    // The premise, from the page itself: it really logged, really threw, and really saw
    // the 404 — otherwise the assertions below could pass on an empty buffer.
    await waitForPage(
      async () =>
        (await probe.page.evaluate(() => {
          const state = window as unknown as {
            __observeConsoleErrors: number
            __observePageErrors: number
            __observeFailures: number[]
            __observeFailureBody: string
          }
          return state.__observeConsoleErrors > 0 && state.__observePageErrors > 0 && state.__observeFailures.length > 0
        })) as boolean,
      'the fixture page to record its console error, its uncaught error, and its failed request',
    )
    const pageSide = (await probe.page.evaluate(() => {
      const state = window as unknown as {
        __observeConsoleErrors: number
        __observePageErrors: number
        __observeFailures: number[]
        __observeFailureBody: string
        __observeSecret: string
      }
      return {
        consoleErrors: state.__observeConsoleErrors,
        pageErrors: state.__observePageErrors,
        failures: state.__observeFailures,
        failureBody: state.__observeFailureBody,
        secret: state.__observeSecret,
      }
    })) as {
      consoleErrors: number
      pageErrors: number
      failures: number[]
      failureBody: string
      secret: string
    }
    console.log('RAW the fixture’s own record of what it did: ' + JSON.stringify(pageSide))
    expect(pageSide.consoleErrors).toBeGreaterThan(0)
    expect(pageSide.pageErrors).toBeGreaterThan(0)
    expect(pageSide.failures).toContain(404)
    expect(pageSide.failureBody).toContain('t5-fixture-404-body')

    // The tool's report of the same events.
    let diagnostics = (await run('browser_diagnostics', {})) as PageDiagnostics
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      const hasConsole = diagnostics.console.some((message) => message.text.includes('t5-fixture-console-error'))
      const hasFailure = diagnostics.failedRequests.some(
        (request) => request.url.includes('/api/missing') && request.status === 404,
      )
      if (hasConsole && hasFailure) break
      await new Promise((settle) => setTimeout(settle, 100))
      diagnostics = (await run('browser_diagnostics', {})) as PageDiagnostics
    }
    console.log('RAW browser_diagnostics value: ' + JSON.stringify(diagnostics))

    const logged = diagnostics.console.find((message) => message.text.includes('t5-fixture-console-error'))
    expect(logged, 'the console error the page produced was not reported').toBeDefined()
    expect(logged?.type).toBe('error')
    // The message carries the page's own computed value, so this is *this* page's console.
    expect(logged?.text).toContain(pageSide.secret)

    const thrown = diagnostics.console.find((message) => message.type === 'pageerror')
    expect(thrown, 'the uncaught page error was not reported').toBeDefined()
    expect(thrown?.text).toContain('t5-fixture-page-error')

    const failed = diagnostics.failedRequests.find((request) => request.url.includes('/api/missing'))
    expect(failed, 'the 404 the page received was not reported').toBeDefined()
    expect(failed?.status).toBe(404)
    expect(failed?.statusText.length).toBeGreaterThan(0)
    // The summary is the response the page really got, not a placeholder.
    expect(failed?.summary).toContain('t5-fixture-404-body')

    // And the model-facing text carries the status and the summary.
    const rendered = renderedText('browser_diagnostics', {}, diagnostics)
    console.log('RAW browser_diagnostics rendered: ' + JSON.stringify(rendered))
    expect(rendered).toContain('404')
    expect(rendered).toContain('/api/missing')
    expect(rendered).toContain('t5-fixture-404-body')
    expect(rendered).toContain('t5-fixture-console-error')
  })

  it('starts the record over when the view navigates, so nothing is attributed to the wrong page', async () => {
    await observe()
    await waitForPage(
      async () =>
        (await probe.page.evaluate(
          () => (window as unknown as { __observePayload: unknown }).__observePayload !== null,
        )) as boolean,
      'the fixture page to record its payload',
    )
    expect((await session.getJsonResponses()).length).toBeGreaterThan(0)

    await session.goto(`${shell.handshake.fixtureOrigin}/other`)
    const diagnostics = (await run('browser_diagnostics', {})) as PageDiagnostics
    const json = JSON.parse((await run('browser_json', {})) as string) as unknown[]
    console.log('RAW after navigating away: ' + JSON.stringify({ console: diagnostics.console.length, failed: diagnostics.failedRequests.length, json: json.length }))
    // Nothing the previous document produced is still attributed to this one. The check is
    // by marker rather than by exact length, because the browser's own favicon request
    // belongs to no page and may or may not be there.
    expect(diagnostics.console.some((message) => message.text.includes('t5-fixture-console-error'))).toBe(false)
    expect(diagnostics.console.some((message) => message.text.includes('t5-fixture-page-error'))).toBe(false)
    expect(diagnostics.failedRequests.some((request) => request.url.includes('/api/missing'))).toBe(false)
    expect(json.some((entry) => JSON.stringify(entry).includes('/api/observe'))).toBe(false)
  })
})
