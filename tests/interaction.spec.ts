import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { AdoptedViewSession, ViewActionError, type ElementBounds, type PageSnapshot } from '../src/session.ts'
import { desktopViewTools } from '../src/tools.ts'
import { pageForTarget, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T4 seam test: "the agent can operate the page like a person, and when it cannot, it
 * is told why".
 *
 * Every assertion is about an *external* effect, read back over an independent CDP
 * connection rather than through the code under test:
 *
 *  - a click is a changed text node, a submitted form, a changed `<select>.value`;
 *  - typing is read from the page's own `.value` / `.textContent`, and "typed as keys"
 *    is told from "value set in one operation" by a keydown counter the page owns;
 *  - a drag is a changed child order *and* changed geometry;
 *  - "scroll to element" is checked with the page's own `getBoundingClientRect()`
 *    before and after, and never with the number the implementation reported;
 *  - the four failure reasons are checked by what their messages *name* (the awaited
 *    timeout, the covering element's id, the hidden element, the removed element), and
 *    by the messages being pairwise different.
 */

/** The tool's execution context is unused by these tools; a stub is enough. */
const IGNORED_EXEC = undefined as unknown as Parameters<ReturnType<typeof desktopViewTools>[number]['execute']>[1]

/** The viewport the shell gives the native view when no panel has reported a rectangle. */
const VIEW = { width: 440, height: 800 }

describe('T4 — the agent operates the page, and a refusal says why', () => {
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

  /** Navigate the view to the interaction page and snapshot it. */
  const interact = async (): Promise<PageSnapshot> => {
    await session.goto(`${shell.handshake.fixtureOrigin}/interact`)
    return await session.snapshot()
  }

  /** The ref of the element with this accessible name, or a failure that lists what was there. */
  const refOf = (snapshot: PageSnapshot, name: string): number => {
    const found = snapshot.elements.find((element) => element.name === name)
    if (found === undefined) {
      throw new Error(
        `the snapshot did not list "${name}"; it listed: ${JSON.stringify(snapshot.elements.map((element) => element.name))}`,
      )
    }
    return found.ref
  }

  /** The snapshot's own bounds for an element, for comparing against the page's. */
  const boundsOf = (snapshot: PageSnapshot, name: string): ElementBounds => {
    const found = snapshot.elements.find((element) => element.name === name)
    if (found === undefined) throw new Error(`the snapshot did not list "${name}"`)
    return found.bounds
  }

  /** One element's rectangle, read in the page — not through the session, not through the snapshot. */
  const pageRect = async (id: string): Promise<ElementBounds | null> =>
    (await probe.page.evaluate((elementId) => {
      const element = document.getElementById(elementId)
      if (element === null) return null
      const box = element.getBoundingClientRect()
      return { x: box.left, y: box.top, width: box.width, height: box.height }
    }, id)) as ElementBounds | null

  /** One element's `value`, as the page's own DOM reports it. */
  const pageValue = async (id: string): Promise<string> =>
    (await probe.page.evaluate((elementId) => {
      const element = document.getElementById(elementId) as HTMLInputElement | HTMLSelectElement | null
      return element === null ? '<missing>' : element.value
    }, id)) as string

  /** One element's text content, or `<missing>` when it is not in the document. */
  const pageText = async (id: string): Promise<string> =>
    (await probe.page.evaluate(
      (elementId) => document.getElementById(elementId)?.textContent ?? '<missing>',
      id,
    )) as string

  /** One element's computed visibility, so "hidden" is the page's word and not ours. */
  const pageVisibility = async (id: string): Promise<string> =>
    (await probe.page.evaluate((elementId) => {
      const element = document.getElementById(elementId)
      return element === null ? '<missing>' : getComputedStyle(element).visibility
    }, id)) as string

  /** Whether the page itself considers an element hidden (`hidden` / `display: none`). */
  const pageHidden = async (id: string): Promise<boolean> =>
    (await probe.page.evaluate((elementId) => {
      const element = document.getElementById(elementId) as HTMLElement | null
      return element === null ? true : element.hidden || element.offsetParent === null
    }, id)) as boolean

  /** The text the page renders, as the page's own `innerText` sees it. */
  const pageRenderedText = async (): Promise<string> =>
    (await probe.page.evaluate(() => document.body.innerText)) as string

  /** The viewport's own size and scroll offset. */
  const viewport = async (): Promise<{ width: number; height: number; scrollY: number }> =>
    (await probe.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollY: window.scrollY,
    }))) as { width: number; height: number; scrollY: number }

  /** What the page itself says a click at a point would hit. */
  const hitAt = async (point: { x: number; y: number }): Promise<string | null> =>
    (await probe.page.evaluate((probed) => {
      const element = document.elementFromPoint(probed.x, probed.y)
      return element === null ? null : element.id || element.tagName.toLowerCase()
    }, point)) as string | null

  /** The draggable items, in document order, as the page reports them. */
  const listOrder = async (): Promise<string[]> =>
    (await probe.page.evaluate(() =>
      [...document.querySelectorAll('#act-list .drag-item')].map((element) => element.id),
    )) as string[]

  /** Run an action that must be refused, and hand back the refusal. */
  const refusal = async (run: () => Promise<unknown>): Promise<ViewActionError> => {
    try {
      await run()
    } catch (error) {
      return error as ViewActionError
    }
    throw new Error('the action was expected to be refused, and it was not')
  }

  it('clicks the element a ref addresses, and the page really changes', async () => {
    const snapshot = await interact()
    const alpha = refOf(snapshot, 'alpha')
    expect(await pageText('act-effect')).toBe('none')

    await session.clickRef(alpha)
    const effect = await pageText('act-effect')
    console.log('RAW click by ref: ' + JSON.stringify({ ref: alpha, effect }))
    expect(effect).toBe('alpha-clicked')

    // The same through the tool the model calls, on the same page: a second click is a
    // second observable change, so the tool cannot be passing by accident.
    await probe.page.evaluate(() => {
      document.getElementById('act-effect')!.textContent = 'reset'
    })
    const tools = desktopViewTools(() => Promise.resolve(session))
    const click = tools.find((candidate) => candidate.name === 'browser_click')
    const value = (await click?.execute({ ref: alpha }, IGNORED_EXEC)) as { ok: boolean; message: string }
    console.log('RAW browser_click value: ' + JSON.stringify(value))
    expect(value.ok).toBe(true)
    expect(await pageText('act-effect')).toBe('alpha-clicked')
  })

  it('sets a value in one operation, and types into it key by key', async () => {
    const snapshot = await interact()
    const input = refOf(snapshot, 'name field')
    const editable = refOf(snapshot, 'editable note')

    // 1. Setting the value: the field holds exactly that text, and the page never saw a
    //    keydown — `Input.insertText` goes through the editing pipeline, not the keyboard.
    await session.fillRef(input, 'Ada Lovelace')
    const afterFill = { value: await pageValue('act-input'), keydowns: await pageText('act-keycount') }
    console.log('RAW fill: ' + JSON.stringify(afterFill))
    expect(afterFill.value).toBe('Ada Lovelace')
    expect(afterFill.keydowns).toBe('keydowns:0')

    // 2. Replacing it: not appending, so the second call decides the whole value.
    await session.fillRef(input, 'Grace Hopper')
    expect(await pageValue('act-input')).toBe('Grace Hopper')

    // 3. Typing: every character is a key press, so the page counts them, and the text
    //    lands after what was already there.
    await session.typeRef(input, ' II')
    const afterType = { value: await pageValue('act-input'), keydowns: await pageText('act-keycount') }
    console.log('RAW type key by key: ' + JSON.stringify(afterType))
    expect(afterType.value).toBe('Grace Hopper II')
    expect(afterType.keydowns).toBe('keydowns:3')

    // 4. The border case this ticket asks about: `[contenteditable]` has no `value`, so
    //    the observable is its text. `fill` replaces the element's whole text in one
    //    operation (`input.value = …` would be a no-op on a div, which is why the tool
    //    goes through the engine's editing path instead of assigning a property), and
    //    typing appends because that is what pressing keys does.
    expect(await pageText('act-editable')).toBe('seed text')
    await session.fillRef(editable, 'noted')
    const editableAfterFill = await pageText('act-editable')
    await session.typeRef(editable, ' again')
    const editableAfterType = await pageText('act-editable')
    console.log('RAW contenteditable: ' + JSON.stringify({ afterFill: editableAfterFill, afterType: editableAfterType }))
    expect(editableAfterFill).toBe('noted')
    expect(editableAfterType).toBe('noted again')
  })

  it('presses a key, and Enter really submits the form', async () => {
    const snapshot = await interact()
    const field = refOf(snapshot, 'key field')
    expect(await pageText('act-submitted')).toBe('nothing submitted')

    // Setting the value focuses the field, the way filling a form does; the key then goes
    // to whatever the page has focused, which is the page-level form of `press_key`.
    await session.fillRef(field, 'ada')
    await session.pressKey('Enter')
    const submitted = await pageText('act-submitted')
    console.log('RAW Enter on the focused field: ' + JSON.stringify({ submitted }))
    expect(submitted).toBe('submitted:ada')

    // …and the key can be aimed at an element by ref, without depending on where focus
    // happened to be: the form resets, the field is filled again, and the key is pressed
    // *in* the field.
    await probe.page.evaluate(() => {
      document.getElementById('act-submitted')!.textContent = 'nothing submitted'
      ;(document.getElementById('act-key-input') as HTMLInputElement).value = ''
      ;(document.getElementById('act-key-input') as HTMLInputElement).blur()
    })
    await session.fillRef(field, 'grace')
    await session.pressKey('Enter', field)
    const submittedByRef = await pageText('act-submitted')
    console.log('RAW Enter aimed at a ref: ' + JSON.stringify({ submittedByRef }))
    expect(submittedByRef).toBe('submitted:grace')
  })

  it('hovers an element so content that was not actionable becomes actionable', async () => {
    const snapshot = await interact()
    // Before: the reveal exists in the DOM but is `display: none`, so it is neither in
    // the snapshot (the engine's `:visible` predicate) nor has a box of its own.
    expect(snapshot.elements.some((element) => element.name === 'revealed control')).toBe(false)
    const before = await pageRect('act-reveal')
    console.log('RAW the hover-only control before hovering: ' + JSON.stringify(before))
    expect(before?.width).toBe(0)

    await session.hoverRef(refOf(snapshot, 'hover me'))

    const after = await pageRect('act-reveal')
    console.log('RAW the hover-only control after hovering: ' + JSON.stringify(after))
    expect(after?.width).toBeGreaterThan(0)
    expect(after?.height).toBeGreaterThan(0)

    // …and it is now something the snapshot offers a ref for, which is the point of
    // hovering: the next action can reach it.
    const revealed = await session.snapshot()
    const names = revealed.elements.map((element) => element.name)
    console.log('RAW snapshot after hovering, newly listed: ' + JSON.stringify(names.filter((name) => name === 'revealed control')))
    expect(names).toContain('revealed control')
  })

  it('selects an option and the page reports the new value', async () => {
    const snapshot = await interact()
    const select = refOf(snapshot, 'colour')
    expect(await pageValue('act-select')).toBe('green')

    const selected = await session.selectRef(select, 'blue')
    const afterValue = await pageValue('act-select')
    console.log('RAW select by value: ' + JSON.stringify({ selected, value: afterValue }))
    expect(afterValue).toBe('blue')
    expect(selected).toEqual(['blue'])

    // By label as well as by value, which is the engine's rule for a plain string.
    const selectedByLabel = await session.selectRef(select, 'Red')
    const afterLabel = {
      selected: selectedByLabel,
      value: await pageValue('act-select'),
      index: (await probe.page.evaluate(() => (document.getElementById('act-select') as HTMLSelectElement).selectedIndex)) as number,
    }
    console.log('RAW select by label: ' + JSON.stringify(afterLabel))
    expect(afterLabel.value).toBe('red')
    expect(afterLabel.index).toBe(0)
  })

  it('drags one element onto another, and the order and geometry really change', async () => {
    const snapshot = await interact()
    const first = refOf(snapshot, 'item one')
    const second = refOf(snapshot, 'item two')

    const before = {
      order: await listOrder(),
      rects: { one: await pageRect('act-item-1'), two: await pageRect('act-item-2') },
    }
    console.log('RAW before the drag: ' + JSON.stringify(before))
    expect(before.order).toEqual(['act-item-1', 'act-item-2'])
    expect(before.rects.two?.y).toBeGreaterThan(before.rects.one?.y as number)

    // Drag the *second* item onto the first: a reorder in the document, not a no-op.
    await session.dragRef(second, first)

    const after = {
      order: await listOrder(),
      rects: { one: await pageRect('act-item-1'), two: await pageRect('act-item-2') },
    }
    console.log('RAW after the drag: ' + JSON.stringify(after))
    expect(after.order).toEqual(['act-item-2', 'act-item-1'])
    // Geometry too: the two boxes really swapped places on the screen.
    expect(after.rects.two?.y).toBeLessThan(after.rects.one?.y as number)
    expect(after.rects.two?.y).toBeCloseTo(before.rects.one?.y as number, 0)
  })

  it('scrolls an element into the viewport, verified with the page’s own geometry', async () => {
    const snapshot = await interact()
    const far = refOf(snapshot, 'far control')
    const beforeView = await viewport()
    const beforeBounds = boundsOf(snapshot, 'far control')
    const beforeRect = await pageRect('act-far')

    console.log('RAW the far control before scrolling: ' + JSON.stringify({ snapshotBounds: beforeBounds, pageRect: beforeRect, view: beforeView }))
    // The fixture's layout assumes this viewport; if the shell ever hands the view a
    // different one, the premises below have to be re-read rather than silently kept.
    expect(beforeView.width).toBe(VIEW.width)
    expect(beforeView.height).toBe(VIEW.height)
    // The premise: it is outside the viewport, and the snapshot's bounds say so in the
    // same coordinate space the viewport itself is in.
    expect(beforeRect).toEqual(beforeBounds)
    expect(beforeView.scrollY).toBe(0)
    expect(beforeBounds.y).toBeGreaterThanOrEqual(beforeView.height)

    await session.scrollToRef(far)

    const afterView = await viewport()
    const afterRect = await pageRect('act-far')
    console.log('RAW the far control after scrolling: ' + JSON.stringify({ pageRect: afterRect, view: afterView }))
    expect(afterView.scrollY).toBeGreaterThan(0)
    expect(afterRect?.y).toBeLessThan(afterView.height)
    expect((afterRect?.y as number) + (afterRect?.height as number)).toBeGreaterThan(0)

    // A snapshot taken after scrolling agrees with the page's own geometry exactly, in
    // the same viewport coordinates — the one thing ADR-0007 recorded as unverified.
    const afterSnapshot = await session.snapshot()
    const afterBounds = boundsOf(afterSnapshot, 'far control')
    console.log('RAW bounds after scrolling, cross-checked: ' + JSON.stringify({ snapshot: afterBounds, page: afterRect }))
    expect(afterBounds).toEqual(afterRect)
  })

  it('waits a fixed duration, and the page moves on while it waits', async () => {
    const snapshot = await interact()
    const delay = refOf(snapshot, 'start the delayed updates')
    await session.clickRef(delay)
    // The second stage is scheduled for 900ms from the click, so "not yet" here is the
    // premise that makes the wait mean something.
    expect(await pageText('act-late2')).toBe('not yet')

    const started = Date.now()
    const result = await session.wait({ ms: 1000 })
    const elapsed = Date.now() - started
    const stage = await pageText('act-late2')
    console.log('RAW fixed wait: ' + JSON.stringify({ result, elapsed, stage }))
    expect(stage).toBe('second-stage')
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(result.waited).toBe('1000ms')
  })

  it('waits for a selector that appears later, and for text that appears later', async () => {
    const snapshot = await interact()
    const delay = refOf(snapshot, 'start the delayed updates')
    await session.clickRef(delay)
    // Not yet there for either form: the element is in the document but still `hidden`
    // (no box, and the DOM says so), and the text it will carry is not rendered.
    const before = {
      hidden: await pageHidden('act-late'),
      box: await pageRect('act-late'),
      rendered: await pageRenderedText(),
    }
    console.log('RAW the late control before its timer: ' + JSON.stringify(before))
    expect(before.hidden).toBe(true)
    expect(before.box?.width).toBe(0)
    expect(before.rendered).not.toContain('late text')

    const selectorWait = await session.wait({ selector: '#act-late', timeoutMs: 10_000 })
    const appeared = await pageRect('act-late')
    console.log('RAW wait for a selector: ' + JSON.stringify({ selectorWait, appeared, hidden: await pageHidden('act-late') }))
    expect(await pageHidden('act-late')).toBe(false)
    expect(appeared?.height).toBeGreaterThan(0)
    expect(selectorWait.elapsedMs).toBeGreaterThanOrEqual(200)

    // Fresh page for the text form, so it waits for its own appearance rather than
    // finding what the previous wait already brought in.
    await interact()
    await session.clickRef(refOf(await session.snapshot(), 'start the delayed updates'))
    expect(await pageRenderedText()).not.toContain('late text')

    const textWait = await session.wait({ text: 'late text', timeoutMs: 10_000 })
    const rendered = await pageRenderedText()
    console.log('RAW wait for text: ' + JSON.stringify({ textWait, rendered: rendered.includes('late text') }))
    expect(rendered).toContain('late text')
    expect(await pageRect('act-late')).not.toBeNull()
    expect(textWait.elapsedMs).toBeGreaterThanOrEqual(200)
  })

  it('reports a wait that never ends as a timeout that names what it waited for', async () => {
    const snapshot = await interact()
    const delay = refOf(snapshot, 'start the delayed updates')
    await session.clickRef(delay)

    const started = Date.now()
    const missingSelector = await refusal(() => session.wait({ selector: '#act-never', timeoutMs: 700 }))
    const selectorElapsed = Date.now() - started
    console.log('RAW a selector that never appears: ' + JSON.stringify({ message: missingSelector.message, reason: missingSelector.reason, elapsed: selectorElapsed }))
    expect(missingSelector.reason).toBe('timeout')
    expect(missingSelector.message).toContain('timed out')
    expect(missingSelector.message).toContain('700ms')
    expect(missingSelector.message).toContain('#act-never')
    // It really waited: a refusal that came back instantly would pass the assertions
    // above while being a different behaviour entirely.
    expect(selectorElapsed).toBeGreaterThanOrEqual(600)

    const startedText = Date.now()
    const missingText = await refusal(() => session.wait({ text: 'text that is not there', timeoutMs: 700 }))
    const textElapsed = Date.now() - startedText
    console.log('RAW text that never appears: ' + JSON.stringify({ message: missingText.message, reason: missingText.reason, elapsed: textElapsed }))
    expect(missingText.reason).toBe('timeout')
    expect(missingText.message).toContain('timed out')
    expect(missingText.message).toContain('700ms')
    expect(missingText.message).toContain('text that is not there')
    expect(textElapsed).toBeGreaterThanOrEqual(600)
  })

  it('refuses a click on an element that was removed, and says it is gone', async () => {
    const snapshot = await interact()
    const remover = refOf(snapshot, 'remove the target')
    const doomed = refOf(snapshot, 'remove target')

    await session.clickRef(remover)
    // The premise, from the page: the element the snapshot listed is really not there.
    expect(await pageRect('act-remove-me')).toBeNull()

    const gone = await refusal(() => session.clickRef(doomed))
    console.log('RAW ref whose element was removed: ' + JSON.stringify({ reason: gone.reason, message: gone.message }))
    expect(gone.reason).toBe('not-found')
    expect(gone.message).toContain(`ref ${doomed}`)
    expect(gone.message).toContain('act-remove-me')
    expect(gone.message).toContain('does not exist')
    expect(gone.message).toContain('browser_snapshot')
  })

  it('refuses a click on an element that is not visible, and says so', async () => {
    const snapshot = await interact()
    const hider = refOf(snapshot, 'hide the target')
    const hidden = refOf(snapshot, 'hide target')

    await session.clickRef(hider)
    // The premise: it is still in the document with a real box, and only its visibility
    // changed — so "hidden" and "gone" are different states of the world.
    const visibility = await pageVisibility('act-hide-me')
    const box = await pageRect('act-hide-me')
    console.log('RAW the hidden control, as the page sees it: ' + JSON.stringify({ visibility, box, stillInDocument: box !== null }))
    expect(visibility).toBe('hidden')
    expect(box?.width).toBeGreaterThan(0)

    const invisible = await refusal(() => session.clickRef(hidden))
    console.log('RAW ref whose element is hidden: ' + JSON.stringify({ reason: invisible.reason, message: invisible.message }))
    expect(invisible.reason).toBe('not-visible')
    expect(invisible.message).toContain(`ref ${hidden}`)
    expect(invisible.message).toContain('act-hide-me')
    expect(invisible.message).toContain('not visible')
    // …and it is not reported as missing, which is the distinction that matters here.
    expect(invisible.message).not.toContain('does not exist')
  })

  it('refuses a click on an element something is drawn over, and names the cover', async () => {
    const snapshot = await interact()
    const blocked = refOf(snapshot, 'blocked control')
    const bounds = boundsOf(snapshot, 'blocked control')
    const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }

    // The premise, asked of the page itself: the block is listed as clickable-looking
    // (it is visible, it has a box), and the topmost element at its centre is the cover.
    const cover = await hitAt(centre)
    console.log('RAW what the page says is on top: ' + JSON.stringify({ centre, cover }))
    expect(cover).toBe('act-blocker')

    const obscured = await refusal(() => session.clickRef(blocked))
    console.log('RAW ref whose element is covered: ' + JSON.stringify({ reason: obscured.reason, message: obscured.message }))
    expect(obscured.reason).toBe('obscured')
    expect(obscured.message).toContain(`ref ${blocked}`)
    // The requirement this exists for: the error has to name what is in the way, or the
    // four reasons collapse back into "it failed".
    expect(obscured.message).toContain('act-blocker')
    expect(obscured.message).toContain('blocker panel')
    expect(obscured.message).toContain('obscured')
    // Not reported as a timeout, which is what an unclassified intercepted click becomes.
    expect(obscured.message).not.toContain('timed out')
  })

  it('keeps the four failure reasons apart', async () => {
    const cases: Record<string, { reason: string; message: string }> = {}

    const started = Date.now()
    const timedOut = await refusal(() => session.wait({ selector: '#act-never', timeoutMs: 700 }))
    cases.timeout = { reason: timedOut.reason, message: timedOut.message }
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)

    let snapshot = await interact()
    const obscured = await refusal(() => session.clickRef(refOf(snapshot, 'blocked control')))
    cases.obscured = { reason: obscured.reason, message: obscured.message }

    snapshot = await interact()
    await session.clickRef(refOf(snapshot, 'hide the target'))
    const invisible = await refusal(() => session.clickRef(refOf(snapshot, 'hide target')))
    cases['not-visible'] = { reason: invisible.reason, message: invisible.message }

    snapshot = await interact()
    await session.clickRef(refOf(snapshot, 'remove the target'))
    const missing = await refusal(() => session.clickRef(refOf(snapshot, 'remove target')))
    cases['not-found'] = { reason: missing.reason, message: missing.message }

    console.log('RAW the four failure reasons: ' + JSON.stringify(cases))

    // One reason each, and no two of them the same.
    expect(Object.values(cases).map((entry) => entry.reason)).toEqual([
      'timeout',
      'obscured',
      'not-visible',
      'not-found',
    ])
    const messages = Object.values(cases).map((entry) => entry.message)
    expect(new Set(messages).size).toBe(4)

    // Each message carries something only its own case can produce: the timeout and what
    // it waited for, the covering element, the hidden element, the removed element.
    expect(messages[0]).toContain('timed out after 700ms')
    expect(messages[0]).toContain('#act-never')
    expect(messages[1]).toContain('obscured')
    expect(messages[1]).toContain('act-blocker')
    expect(messages[2]).toContain('not visible')
    expect(messages[2]).toContain('act-hide-me')
    expect(messages[3]).toContain('does not exist')
    expect(messages[3]).toContain('act-remove-me')

    // Every message names the ref it is about, so a caller with several in flight can
    // tell which one is which without guessing.
    for (const [reason, entry] of Object.entries(cases)) {
      if (reason === 'timeout') continue
      expect(entry.message, `${reason} should name its ref`).toMatch(/ref \d+/)
    }
  })

  it('registers the interaction tools with schema-valid results', async () => {
    const tools = desktopViewTools(() => Promise.resolve(session))
    // T1's test pins `browser_navigate` at index 0; adding tools must not move it.
    expect(tools[0]?.name).toBe('browser_navigate')
    const names = tools.map((tool) => tool.name)
    console.log('RAW registered tools: ' + JSON.stringify(names))
    for (const expected of [
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_type_keys',
      'browser_press_key',
      'browser_hover',
      'browser_select',
      'browser_drag',
      'browser_scroll',
      'browser_wait',
    ]) {
      expect(names, `browser tools should include ${expected}`).toContain(expected)
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    /** Run a tool and check its declared output schema accepts the value it produced. */
    const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const tool = byName.get(name)
      if (tool === undefined) throw new Error(`${name} is not registered`)
      const contract = tool.output as { schema: JsonSchemaNode }
      assertSupportedJsonSchema(contract.schema)
      const value = await tool.execute(args, IGNORED_EXEC)
      expect(validateJsonSchemaValue(contract.schema, value), `${name} produced a value its schema rejects`).toEqual([])
      return value
    }

    const snapshot = await interact()
    const values = {
      click: await run('browser_click', { ref: refOf(snapshot, 'alpha') }),
      type: await run('browser_type', { ref: refOf(snapshot, 'name field'), text: 'first' }),
      typeKeys: await run('browser_type_keys', { ref: refOf(snapshot, 'name field'), text: ' last' }),
      pressKey: await run('browser_press_key', { key: 'Enter', ref: refOf(snapshot, 'key field') }),
      hover: await run('browser_hover', { ref: refOf(snapshot, 'hover me') }),
      select: await run('browser_select', { ref: refOf(snapshot, 'colour'), option: 'blue' }),
      drag: await run('browser_drag', {
        fromRef: refOf(snapshot, 'item two'),
        toRef: refOf(snapshot, 'item one'),
      }),
      scrollTo: await run('browser_scroll', { ref: refOf(snapshot, 'far control') }),
      scrollBy: await run('browser_scroll', { direction: 'up', amount: 200 }),
      waitMs: await run('browser_wait', { ms: 60 }),
      waitSelector: await run('browser_wait', { selector: '#act-alpha', timeout: 2000 }),
      waitText: await run('browser_wait', { text: 'alpha', timeout: 2000 }),
    }
    console.log('RAW the interaction tools, as the model reads them: ' + JSON.stringify(values, null, 0))

    // The tools did the things, not merely returned a valid shape.
    expect(await pageText('act-effect')).toBe('alpha-clicked')
    expect(await pageValue('act-input')).toBe('first last')
    expect(await pageValue('act-select')).toBe('blue')
    expect(await listOrder()).toEqual(['act-item-2', 'act-item-1'])
    expect((await viewport()).scrollY).toBeGreaterThan(0)

    // A `browser_wait` with nothing to wait for, and one with two forms at once, are
    // refused rather than silently treated as one of them.
    const ambiguous = await refusal(async () => {
      await byName.get('browser_wait')?.execute({ ms: 10, text: 'alpha' }, IGNORED_EXEC)
    })
    console.log('RAW browser_wait with two forms: ' + JSON.stringify(ambiguous.message))
    expect(ambiguous.message).toContain('exactly one of ms, selector, or text')
  })
})
