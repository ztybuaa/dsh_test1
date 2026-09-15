import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { AdoptedViewSession, type ElementBounds, type PageSnapshot } from '../src/session.ts'
import { desktopViewTools } from '../src/tools.ts'
import { pageForTarget, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T3 seam test: "the agent can find an element and knows where it is".
 *
 * Every assertion runs against a real Electron process, a real `WebContentsView`, and
 * the real fixture pages the shell serves, through the same adoption path the plugin
 * uses in production. Two things in particular are checked against something other
 * than the implementation's own word:
 *
 *  - `bounds` are compared with the page's **own** `getBoundingClientRect()`, read over
 *    an independent CDP connection, so a rectangle that merely looks plausible does not
 *    pass; and they are hit-tested with `document.elementFromPoint` at their own centre,
 *    because a rectangle that does not point at the element is useless to the ticket
 *    that acts on it (T4);
 *  - the snapshot value is run through the schema the tool declares, so a value the
 *    registry would reject in production cannot pass here.
 */

/** The tool's execution context is unused by these tools; a stub is enough. */
const IGNORED_EXEC = undefined as unknown as Parameters<ReturnType<typeof desktopViewTools>[number]['execute']>[1]

/** One fixture control the snapshot must list, with the facts to check independently. */
interface ProbeCase {
  /** Fixture id, which the page-side reads and the hit tests use. */
  id: string
  /** The accessible name the snapshot must resolve for this control. */
  name: string
  /** The role the snapshot must report. */
  role: string
  /** Whether the control sits inside the viewport, so its centre can be hit-tested. */
  hitTestable: boolean
}

/**
 * Every control `/snapshot` must list, in document order.
 *
 * Names are unique and distinct from each control's visible text where the naming
 * order matters, so "the name was resolved" and "the text was used as a fallback" are
 * different results.
 */
const PROBES: ProbeCase[] = [
  { id: 'snap-alpha', name: 'alpha', role: 'button', hitTestable: true },
  { id: 'snap-beta', name: 'beta', role: 'button', hitTestable: true },
  { id: 'snap-checked', name: 'checked control', role: 'checkbox', hitTestable: true },
  { id: 'snap-expanded', name: 'expanded control', role: 'button', hitTestable: true },
  { id: 'snap-disabled', name: 'disabled control', role: 'button', hitTestable: true },
  { id: 'snap-by-aria', name: 'labelled by aria', role: 'button', hitTestable: true },
  { id: 'snap-by-reference', name: 'labelled by reference', role: 'button', hitTestable: true },
  { id: 'snap-by-for', name: 'labelled by for', role: 'textbox', hitTestable: true },
  { id: 'snap-by-placeholder', name: 'labelled by placeholder', role: 'textbox', hitTestable: true },
  { id: 'snap-by-value', name: 'labelled by value', role: 'button', hitTestable: true },
  { id: 'snap-by-text', name: 'labelled by text', role: 'button', hitTestable: true },
  { id: 'snap-below-fold', name: 'below fold', role: 'button', hitTestable: false },
  // Real navigations the *page* starts, so "refs die with the document" can be
  // observed on a navigation the driver never asked for — including one whose
  // response is still open when the ref is used.
  { id: 'snap-to-other', name: 'to other', role: 'link', hitTestable: true },
  { id: 'snap-to-slow', name: 'to slow', role: 'link', hitTestable: true },
  // Changes the address without replacing the document (an SPA route change): the
  // boundary of "a ref belongs to its document".
  { id: 'snap-push', name: 'push state', role: 'button', hitTestable: true },
]

/** Controls `/snapshot` really contains but must never list. */
const HIDDEN_IDS = ['snap-hidden-display', 'snap-hidden-visibility', 'snap-hidden-zero'] as const

/** The element cap the fixture's truncation page exceeds. */
const DEFAULT_CAP = 200

/** How many controls the fixture's truncation page really has, measured in the page. */
const MANY_CONTROLS = 220

/** Fail with a message naming the ref instead of an opaque `undefined` dereference. */
function boundsOf(snapshot: PageSnapshot, name: string): ElementBounds {
  const found = snapshot.elements.find((element) => element.name === name)
  if (found === undefined) {
    throw new Error(`the snapshot did not list "${name}"; it listed: ${JSON.stringify(snapshot.elements.map((e) => e.name))}`)
  }
  return found.bounds
}

describe('T3 — the snapshot locates elements and reports their bounds', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession
  /** An independent connection to the same view: used only to read the page for itself. */
  let probe: { browser: { close: () => Promise<void> }; page: Page }

  beforeAll(async () => {
    shell = await startShell()
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
    })
    probe = await pageForTarget(shell.handshake.cdpUrl, shell.handshake.targetId)
  }, 120_000)

  afterAll(async () => {
    if (probe !== undefined) await probe.browser.close().catch(() => undefined)
    if (session !== undefined) await session.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  /** Navigate the view to a fixture page and snapshot it. */
  const snapshotOf = async (path: string): Promise<PageSnapshot> => {
    await session.goto(`${shell.handshake.fixtureOrigin}${path}`)
    return await session.snapshot()
  }

  /**
   * The page's own answer for one element's geometry.
   *
   * Read in the page, over the probe connection, using `getBoundingClientRect()` —
   * not through the session, not through the snapshot, and not through any helper the
   * snapshot code also uses.
   */
  const pageRect = async (id: string): Promise<ElementBounds | null> =>
    (await probe.page.evaluate((elementId) => {
      const element = document.getElementById(elementId)
      if (element === null) return null
      const box = element.getBoundingClientRect()
      return { x: box.left, y: box.top, width: box.width, height: box.height }
    }, id)) as ElementBounds | null

  it('lists the interactive elements, each with a ref and real bounds', async () => {
    const snapshot = await snapshotOf('/snapshot')
    console.log('RAW snapshot of /snapshot: ' + JSON.stringify(snapshot))

    expect(snapshot.title).toBe('snapshot-page')
    expect(snapshot.url).toBe(`${shell.handshake.fixtureOrigin}/snapshot`)
    // A page under the cap is not marked: "truncated" has to mean something.
    expect('truncated' in snapshot).toBe(false)
    expect(snapshot.elements.map((element) => element.name)).toEqual(PROBES.map((probeCase) => probeCase.name))
    expect(snapshot.elements.map((element) => element.role)).toEqual(PROBES.map((probeCase) => probeCase.role))

    for (const [index, element] of snapshot.elements.entries()) {
      expect(element.ref, `element ${index} should be 1-based`).toBe(index + 1)
      const bounds = element.bounds
      expect(bounds, `${element.name} must carry bounds`).toBeDefined()
      for (const [axis, value] of Object.entries(bounds)) {
        expect(Number.isFinite(value), `${element.name}.bounds.${axis}=${value} should be a number`).toBe(true)
      }
      expect(bounds.width, `${element.name} should have a non-empty box`).toBeGreaterThan(0)
      expect(bounds.height, `${element.name} should have a non-empty box`).toBeGreaterThan(0)
    }
  })

  it('resolves each element name in the inherited order', async () => {
    const snapshot = await snapshotOf('/snapshot')
    const byName = new Map(snapshot.elements.map((element) => [element.name, element]))
    console.log(
      'RAW names: ' +
        JSON.stringify(snapshot.elements.map((element) => ({ ref: element.ref, role: element.role, name: element.name }))),
    )
    // aria-label wins over text; aria-labelledby wins over text; <label for> wins over
    // nothing else present; placeholder and value are used when nothing else is.
    for (const [id, expected] of [
      ['snap-by-aria', 'labelled by aria'],
      ['snap-by-reference', 'labelled by reference'],
      ['snap-by-for', 'labelled by for'],
      ['snap-by-placeholder', 'labelled by placeholder'],
      ['snap-by-value', 'labelled by value'],
      ['snap-by-text', 'labelled by text'],
    ] as const) {
      expect(byName.has(expected), `${id} should be listed as "${expected}"`).toBe(true)
    }
    // The losing text really was present, so the wins above are resolutions and not
    // just "the only text on the element".
    const losing = await probe.page.evaluate(
      (ids) => ids.map((id) => (document.getElementById(id)?.textContent ?? '').trim()),
      ['snap-by-aria', 'snap-by-reference'],
    )
    console.log('RAW text that lost to the ARIA names: ' + JSON.stringify(losing))
    expect(losing[0]?.length).toBeGreaterThan(0)
    expect(losing[1]?.length).toBeGreaterThan(0)
  })

  it('leaves hidden elements out of a page that really contains them', async () => {
    const snapshot = await snapshotOf('/snapshot')
    const listedNames = snapshot.elements.map((element) => element.name)
    for (const hiddenName of ['display none', 'visibility hidden', 'zero sized']) {
      expect(listedNames, `"${hiddenName}" is hidden and must not be listed`).not.toContain(hiddenName)
    }
    // ...and they were excluded for being hidden, not for being absent or inert: ask
    // the page what those elements actually are.
    const facts = await probe.page.evaluate((ids) => {
      const read = (id: string): unknown => {
        const element = document.getElementById(id)
        if (element === null) return null
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          tag: element.tagName.toLowerCase(),
          width: box.width,
          height: box.height,
          display: style.display,
          visibility: style.visibility,
        }
      }
      return Object.fromEntries(ids.map((id) => [id, read(id)]))
    }, [...HIDDEN_IDS])
    console.log('RAW the hidden controls, as the page sees them: ' + JSON.stringify(facts))

    const displayNone = facts['snap-hidden-display'] as { tag: string; width: number; height: number; display: string }
    expect(displayNone.tag).toBe('button')
    expect(displayNone.display).toBe('none')
    expect(displayNone.width).toBe(0)
    expect(displayNone.height).toBe(0)

    const visibilityHidden = facts['snap-hidden-visibility'] as { tag: string; visibility: string; width: number }
    expect(visibilityHidden.tag).toBe('button')
    expect(visibilityHidden.visibility).toBe('hidden')
    // It has a real box, so it was excluded for its visibility and not for its size.
    expect(visibilityHidden.width).toBeGreaterThan(0)

    const zeroSized = facts['snap-hidden-zero'] as { tag: string; width: number; height: number }
    expect(zeroSized.tag).toBe('button')
    expect(zeroSized.width).toBe(0)
    expect(zeroSized.height).toBe(0)

    // Every listed element is one of the visible controls, and every visible control is
    // listed — the count is the page's, not the snapshot's own bookkeeping.
    expect(snapshot.elements.length).toBe(PROBES.length)
  })

  it('carries state only when the element has one', async () => {
    const snapshot = await snapshotOf('/snapshot')
    const byName = new Map(snapshot.elements.map((element) => [element.name, element]))
    console.log(
      'RAW states: ' +
        JSON.stringify(
          snapshot.elements.filter((element) => element.state !== undefined).map((element) => ({
            name: element.name,
            state: element.state,
          })),
        ),
    )
    expect(byName.get('checked control')?.state).toBe('checked=true')
    // A false value is a value: `aria-expanded="false"` must reach the model, because
    // "collapsed" and "unknown" lead to different actions.
    expect(byName.get('expanded control')?.state).toBe('expanded=false')
    expect(byName.get('disabled control')?.state).toBe('disabled')
    // ...and an element without a state must not carry an empty one.
    expect(Object.hasOwn(byName.get('alpha') ?? {}, 'state')).toBe(false)
    expect(byName.get('alpha')?.state).toBeUndefined()
  })

  it('reports bounds that match the page’s own geometry, and that hit-test to the element', async () => {
    const snapshot = await snapshotOf('/snapshot')

    const crossCheck: unknown[] = []
    for (const probeCase of PROBES) {
      const listed = snapshot.elements.find((element) => element.name === probeCase.name)
      expect(listed, `the snapshot should list "${probeCase.name}"`).toBeDefined()
      const rect = await pageRect(probeCase.id)
      expect(rect, `${probeCase.id} should exist in the fixture page`).not.toBeNull()
      // Exact equality, no tolerance: the snapshot's rectangle and the page's own
      // `getBoundingClientRect()` must be the same numbers. Rounding, a scroll offset,
      // or a device-pixel-ratio multiplication would all show up here.
      expect(listed?.bounds, `${probeCase.id}: snapshot bounds vs the page's own geometry`).toEqual(rect)
      crossCheck.push({ id: probeCase.id, ref: listed?.ref, snapshot: listed?.bounds, page: rect })
    }
    console.log('RAW bounds cross-check (snapshot vs the page’s own getBoundingClientRect): ' + JSON.stringify(crossCheck))

    // Equal numbers are not enough: the rectangle has to *point at the element*, which
    // is the property T4 will click with and T8 will draw with.
    const hits: unknown[] = []
    for (const probeCase of PROBES.filter((candidate) => candidate.hitTestable)) {
      const bounds = boundsOf(snapshot, probeCase.name)
      const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      const hit = (await probe.page.evaluate((point) => {
        const element = document.elementFromPoint(point.x, point.y)
        return element === null ? null : { id: element.id, tag: element.tagName.toLowerCase() }
      }, centre)) as { id: string; tag: string } | null
      hits.push({ id: probeCase.id, centre, hit })
      expect(hit?.id, `${probeCase.id}: the centre of the reported bounds must hit that element`).toBe(probeCase.id)
    }
    console.log('RAW hit test at the centre of each reported bounds: ' + JSON.stringify(hits))

    // The one control below the fold is how "is it in the viewport" becomes answerable:
    // its bounds say so, in the same coordinate space as the viewport itself.
    const viewport = (await probe.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))) as {
      width: number
      height: number
    }
    const belowFold = boundsOf(snapshot, 'below fold')
    console.log('RAW below-fold vs the view: ' + JSON.stringify({ bounds: belowFold, viewport }))
    expect(belowFold.y).toBeGreaterThanOrEqual(viewport.height)
    for (const probeCase of PROBES.filter((candidate) => candidate.hitTestable)) {
      const bounds = boundsOf(snapshot, probeCase.name)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    }
  })

  it('refuses a ref from before a navigation instead of clicking the new page', async () => {
    const before = await snapshotOf('/snapshot')
    const staleRef = before.elements[0]?.ref
    expect(before.elements[0]?.name).toBe('alpha')
    expect(staleRef).toBe(1)

    // `/other`'s only interactive element is its `#hit` button, at ref 1, and clicking
    // it is observable in `#out`. So "the stale ref was refused" and "the stale ref
    // clicked whatever now sits at index 1" are different, checkable facts.
    await session.goto(`${shell.handshake.fixtureOrigin}/other`)
    expect(await session.textOf('#out')).toBe('initial-other')

    let refusal: Error | undefined
    try {
      await session.clickRef(staleRef as number)
    } catch (error) {
      refusal = error as Error
    }
    console.log('RAW stale-ref refusal: ' + JSON.stringify(refusal?.message ?? '<nothing was thrown>'))
    expect(refusal, `ref ${staleRef} from the previous document must be refused`).toBeDefined()
    expect(refusal?.message).toContain(`ref ${staleRef}`)
    expect(refusal?.message).toContain('browser_snapshot')
    // Nothing was clicked: the new page is untouched.
    expect(await session.textOf('#out')).toBe('initial-other')

    // A fresh snapshot makes ref 1 mean the *new* page's element, and that one works —
    // so the refusal above was about staleness, not about refs being unusable.
    const after = await session.snapshot()
    const first = after.elements[0]
    console.log(
      'RAW the same ref number after navigating: ' +
        JSON.stringify({ before: { ref: staleRef, name: 'alpha' }, after: { ref: first?.ref, name: first?.name, bounds: first?.bounds } }),
    )
    expect(first?.name).toBe('hit me')
    expect(first?.ref).toBe(staleRef)
    await session.clickRef(first?.ref as number)
    expect(await session.textOf('#out')).toBe('clicked-other')
  })

  it('clears the refs when the page navigates itself, not only when the driver moves it', async () => {
    const before = await snapshotOf('/snapshot')
    const link = before.elements.find((element) => element.name === 'to other')
    expect(link?.role).toBe('link')
    expect(link?.ref).toBeDefined()

    // Wait for the navigation the click started to finish before asking for the stale
    // ref, so the refusal is about the new document and not about a click still landing.
    const loaded = probe.page.waitForEvent('load')
    await session.clickRef(link?.ref as number)
    await loaded
    console.log('RAW the view navigated itself to: ' + session.url())

    // The ref belonged to the document it was read from, which is gone. Which of the
    // two defences answers is deliberately not pinned here: the point is that a ref
    // number that would resolve to a different element on this page is refused, and
    // that nothing on the new page was clicked.
    let refusal: Error | undefined
    try {
      await session.clickRef(link?.ref as number)
    } catch (error) {
      refusal = error as Error
    }
    console.log('RAW self-navigation refusal: ' + JSON.stringify(refusal?.message ?? '<nothing was thrown>'))
    expect(refusal?.message).toContain('browser_snapshot')
    expect(await session.textOf('#out')).toBe('initial-other')
  })

  it('keeps refs usable across a same-document navigation', async () => {
    // The other side of the boundary: `history.pushState` changes the address without
    // replacing the document, so the elements the snapshot listed are still there and
    // their refs must keep working. (Treating an SPA route change as a new document
    // would make every ref unusable on exactly the sites that need them most.)
    const before = await snapshotOf('/snapshot')
    const push = before.elements.find((element) => element.name === 'push state')
    const alpha = before.elements.find((element) => element.name === 'alpha')
    expect(push?.role).toBe('button')
    expect(alpha?.role).toBe('button')
    expect(await session.textOf('#snap-effect')).toBe('none')

    await session.clickRef(push?.ref as number)
    const after = (await probe.page.evaluate(() => ({ path: location.pathname, hash: location.hash }))) as {
      path: string
      hash: string
    }
    console.log('RAW same-document navigation: ' + JSON.stringify({ url: session.url(), ...after }))
    expect(after.hash).toBe('#pushed')
    expect(session.url()).toContain('#pushed')

    // The ref taken *before* the address changed still addresses the same element.
    await session.clickRef(alpha?.ref as number)
    expect(await session.textOf('#snap-effect')).toBe('alpha-clicked')
  })

  it('refuses a ref in the window between a navigation committing and its load', async () => {
    // The narrow, dangerous window: the document has already been replaced, so a ref
    // index resolves inside the *new* document, but the new document has not finished
    // loading. `shell/fixture.js` serves `/slow` in two chunks so the window can be
    // entered deliberately instead of raced for.
    const before = await snapshotOf('/snapshot')
    const link = before.elements.find((element) => element.name === 'to slow')
    expect(link?.role).toBe('link')
    // The premise of the check below: this ref number *does* address a real control in
    // the page that is about to replace the current one, so an unguarded action would
    // click that control rather than fail for a missing element.
    expect(link?.ref).toBeLessThanOrEqual(20)

    const committed = probe.page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === probe.page.mainFrame(),
    })
    await session.clickRef(link?.ref as number)
    await committed

    // Committed, not loaded: the new document is live and the control at that same
    // index is already parsed, but the response has not ended, so `load` has not fired.
    const midway = await probe.page.evaluate(() => ({
      url: location.pathname,
      readyState: document.readyState,
      controls: document.querySelectorAll('button').length,
      title: document.title,
    }))
    console.log('RAW midway through the navigation: ' + JSON.stringify(midway))
    expect(midway.url).toBe('/slow')
    expect(midway.readyState).toBe('loading')
    expect(midway.controls).toBeGreaterThanOrEqual(link?.ref as number)

    let refusal: Error | undefined
    try {
      await session.clickRef(link?.ref as number)
    } catch (error) {
      refusal = error as Error
    }
    console.log('RAW mid-navigation refusal: ' + JSON.stringify(refusal?.message ?? '<nothing was thrown>'))
    // The document identity check answered — not "there is no such ref": the table is
    // still populated here, and the element at that index exists on the new page.
    expect(refusal?.message).toContain('no longer shows')
    expect(await probe.page.evaluate(() => location.pathname)).toBe('/slow')

    // And nothing was clicked: the telltale title never appears.
    await probe.page.waitForLoadState('load')
    console.log('RAW title after the slow page finished loading: ' + JSON.stringify(await session.title()))
    expect(await session.title()).not.toBe('WRONG-CLICK')
  })

  it('truncates past the element cap and marks the snapshot', async () => {
    const many = await snapshotOf('/snapshot-many')
    console.log(
      'RAW truncated snapshot: ' +
        JSON.stringify({
          title: many.title,
          truncated: many.truncated,
          listed: many.elements.length,
          first: many.elements[0]?.name,
          last: many.elements[many.elements.length - 1]?.name,
        }),
    )
    expect(many.title).toBe('many-page')
    expect(many.truncated).toBe(true)
    expect(many.elements.length).toBe(DEFAULT_CAP)
    expect(many.elements[many.elements.length - 1]?.name).toBe(`many-${DEFAULT_CAP}`)
    // ...and the page really had more than the cap: ask it to count its own controls, so
    // "truncated" cannot be satisfied by a page that was short to begin with.
    const controlsInPage = (await probe.page.evaluate(() => document.querySelectorAll('#many button').length)) as number
    console.log('RAW controls in /snapshot-many: ' + String(controlsInPage) + ', cap ' + String(DEFAULT_CAP))
    expect(controlsInPage).toBe(MANY_CONTROLS)
    expect(controlsInPage).toBeGreaterThan(many.elements.length)
    // The cap bounds the refs too: an element the snapshot never listed has no ref to use.
    await expect(session.clickRef(DEFAULT_CAP + 1)).rejects.toThrow(new RegExp(`ref ${DEFAULT_CAP + 1}`))

    // The cap is configured, not hard-coded: the same page under a smaller cap lists
    // fewer elements and still says it truncated.
    const capped = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
      maxElements: 5,
    })
    try {
      await capped.goto(`${shell.handshake.fixtureOrigin}/snapshot`)
      const small = await capped.snapshot()
      console.log('RAW maxElements=5 snapshot: ' + JSON.stringify({ listed: small.elements.length, truncated: small.truncated, refs: small.elements.map((element) => element.ref) }))
      expect(small.elements.length).toBe(5)
      expect(small.truncated).toBe(true)
      expect(small.elements.map((element) => element.ref)).toEqual([1, 2, 3, 4, 5])
      await expect(capped.clickRef(6)).rejects.toThrow(/ref 6/)
    } finally {
      await capped.close()
    }
  })

  it('hands the snapshot to the model through browser_snapshot, bounds included, schema-valid', async () => {
    const tools = desktopViewTools(() => Promise.resolve(session))
    // T1's test pins `browser_navigate` at index 0; adding a tool must not move it.
    expect(tools[0]?.name).toBe('browser_navigate')
    const found = tools.find((candidate) => candidate.name === 'browser_snapshot')
    if (found === undefined) {
      throw new Error(`browser_snapshot is not registered; registered: ${tools.map((tool) => tool.name).join(', ')}`)
    }
    // The declared output contract, as this test needs to call it: the schema the host
    // enforces and the renderer that produces the model-facing lines.
    const contract = found.output as {
      schema: JsonSchemaNode
      render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
    }

    const snapshotPage = await snapshotOf('/snapshot')
    const value = (await found.execute({}, IGNORED_EXEC)) as PageSnapshot
    console.log('RAW browser_snapshot value: ' + JSON.stringify(value))
    expect(value.title).toBe('snapshot-page')
    expect(value.elements.length).toBe(PROBES.length)

    // The declared output schema is what the host enforces on the way to the model:
    // validate the real value against it, so schema drift fails here rather than in
    // production. The truncated shape is validated too, since `truncated` is optional.
    assertSupportedJsonSchema(contract.schema)
    expect(validateJsonSchemaValue(contract.schema, value)).toEqual([])
    const truncatedValue = await snapshotOf('/snapshot-many')
    expect(validateJsonSchemaValue(contract.schema, truncatedValue)).toEqual([])

    // What the model actually reads: the ref and its bounds on the same line, which is
    // what makes "is it on screen" answerable without another call.
    const text = contract
      .render({}, value)
      .map((block) => block.text)
      .join('\n')
    console.log('RAW rendered snapshot lines: ' + JSON.stringify(text.split('\n').slice(0, 5)))
    expect(text).toContain('Title: snapshot-page')
    const alpha = snapshotPage.elements.find((element) => element.name === 'alpha')
    expect(alpha).toBeDefined()
    const bounds = alpha?.bounds as ElementBounds
    expect(text).toContain(
      `[${alpha?.ref}] button "alpha" {x=${bounds.x},y=${bounds.y},w=${bounds.width},h=${bounds.height}}`,
    )
  })
})
