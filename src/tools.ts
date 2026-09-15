import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AdoptedViewSession, NavigationResult, PageSnapshot } from './session.ts'

/** Canonical output of `browser_navigate`: where the view ended up. */
const navigationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
} as const

/**
 * Canonical output of `browser_snapshot`.
 *
 * The element list is the whole point, and `bounds` is required on every element:
 * "where is it and how big is it" is what turns a ref into something an action or an
 * overlay can use, so an element without bounds is not a snapshot element.
 */
const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    elements: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'number', required: true },
          role: { type: 'string', required: true },
          name: { type: 'string', required: true },
          state: { type: 'string' },
          bounds: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
        },
      },
    },
    truncated: { type: 'boolean' },
  },
} as const

/**
 * Canonical output of an action: it either happened, or it threw.
 *
 * `ok` is always true in a value that came back — an action that did not happen
 * reports *why* by throwing a {@link ViewActionError} whose message names the ref, the
 * element, and the reason — so there is no shape in which a failed action is handed to
 * the model as a successful result carrying `ok: false`.
 */
const actionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
} as const

/** Render one action outcome as the single line the model reads. */
function renderAction(_args: unknown, value: { message: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.message }]
}

/** Render one navigation result as a single text block. */
function renderNavigation(
  _args: unknown,
  value: NavigationResult,
): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `${value.title}\n${value.url}` }]
}

/**
 * Render a snapshot as the lines the model reads.
 *
 * `bounds` is on every line, not in a side channel: the model needs "is this thing in
 * the viewport" to decide whether to scroll, and it can only decide that if the
 * coordinates reach it alongside the ref it will quote back.
 *
 * @param _args - unused; the snapshot tool takes no arguments.
 * @param value - the snapshot to render.
 * @returns one text block.
 */
function renderSnapshot(_args: unknown, value: PageSnapshot): { type: 'text'; text: string }[] {
  const lines = [`Title: ${value.title}`, `URL: ${value.url}`, '', 'Interactive elements:']
  for (const element of value.elements) {
    const { x, y, width, height } = element.bounds
    const name = element.name === '' ? '(unnamed)' : `"${element.name}"`
    const state = element.state === undefined ? '' : ` (${element.state})`
    lines.push(`[${element.ref}] ${element.role} ${name}${state} {x=${x},y=${y},w=${width},h=${height}}`)
  }
  if (value.elements.length === 0) lines.push('(none)')
  if (value.truncated === true) {
    lines.push(
      `(truncated at ${value.elements.length} elements: the page has more interactive elements than one snapshot may list)`,
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Build the tools of this plugin.
 *
 * T1 registers `browser_navigate`, T3 adds `browser_snapshot`, and T4 adds the
 * interaction surface that consumes the snapshot's refs: click, type (replace) and
 * type_keys (keystroke by keystroke), press_key, hover, select, drag, scroll (by ref
 * or by pixels), and the three forms of waiting. Element actions name their element by
 * `ref` and never by a selector (ADR-0001); `browser_wait` is the one tool that takes a
 * selector or text, because "has it appeared yet" is a question about the page rather
 * than about an element the snapshot has already located.
 *
 * @param adopt - resolves the adopted view session, connecting on first use.
 * @returns the tool definitions to register, `browser_navigate` first.
 */
export function desktopViewTools(adopt: () => Promise<AdoptedViewSession>): ToolDefinition[] {
  return [
    defineTool({
      name: 'browser_navigate',
      description:
        'Open a URL in the desktop browser view and return the title and final address of the loaded page.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute URL to open' },
      },
      output: { schema: navigationSchema, render: renderNavigation },
      async execute(args): Promise<NavigationResult> {
        const session = await adopt()
        return await session.goto(args.url)
      },
    }),
    defineTool({
      name: 'browser_snapshot',
      description:
        'Snapshot the page in the desktop browser view: its title, its address, and the visible interactive ' +
        'elements you can act on, each with a numeric ref, an accessible name, its state, and its bounds ' +
        '(x/y/width/height in viewport CSS pixels). Refer to an element by its ref from this result; the refs ' +
        'are invalidated by any navigation, so snapshot again after the page changes.',
      parameters: {},
      output: { schema: snapshotSchema, render: renderSnapshot },
      async execute(): Promise<PageSnapshot> {
        const session = await adopt()
        return await session.snapshot()
      },
    }),
    defineTool({
      name: 'browser_click',
      description:
        'Click the interactive element referenced by `ref` from the most recent snapshot. If the click cannot ' +
        'land — the element is gone, hidden, covered by something else, or never becomes clickable — the error ' +
        'says which of those it is.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.clickRef(args.ref)
        return { ok: true, message: `clicked ref ${args.ref}` }
      },
    }),
    defineTool({
      name: 'browser_type',
      description:
        'Set the text of the element referenced by `ref` from the most recent snapshot, replacing whatever it ' +
        'held (works on <input>, <textarea> and [contenteditable]). Use this to fill a field; it sets the value ' +
        'in one operation, so it produces no key events — use browser_type_keys when a widget has to see the ' +
        'keystrokes.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
        text: { type: 'string', required: true, description: 'The text the element must end up holding' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.fillRef(args.ref, args.text)
        return { ok: true, message: `set ref ${args.ref} to ${JSON.stringify(args.text)}` }
      },
    }),
    defineTool({
      name: 'browser_type_keys',
      description:
        'Type text into the element referenced by `ref` one key at a time, as a person would: every character is ' +
        'a real key event. Use it for widgets that react to typing (autocomplete, masks). It appends to what is ' +
        'already there — use browser_type to replace the content.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
        text: { type: 'string', required: true, description: 'The text to type, key by key' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.typeRef(args.ref, args.text)
        return { ok: true, message: `typed ${JSON.stringify(args.text)} into ref ${args.ref} key by key` }
      },
    }),
    defineTool({
      name: 'browser_press_key',
      description:
        'Press a keyboard key (e.g. Enter to submit a form, Escape to close a modal, Tab to move focus). Without ' +
        '`ref` the key goes to whatever the page has focused; with `ref` that element is focused first.',
      parameters: {
        key: { type: 'string', required: true, description: 'The key to press, e.g. Enter, Escape, Tab, ArrowDown' },
        ref: {
          type: 'number',
          description: 'Optional 1-based ref of the element to focus before pressing the key',
        },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.pressKey(args.key, args.ref)
        return {
          ok: true,
          message: args.ref === undefined ? `pressed ${args.key}` : `pressed ${args.key} in ref ${args.ref}`,
        }
      },
    }),
    defineTool({
      name: 'browser_hover',
      description:
        'Hover the interactive element referenced by `ref` from the most recent snapshot, so hover-only content ' +
        '(menus, tooltips) appears. Snapshot again to act on what it revealed.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.hoverRef(args.ref)
        return { ok: true, message: `hovered ref ${args.ref}` }
      },
    }),
    defineTool({
      name: 'browser_select',
      description:
        'Select an option in the <select> referenced by `ref` from the most recent snapshot. The option matches ' +
        'an option\'s value or its visible label.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the <select> from the snapshot' },
        option: { type: 'string', required: true, description: 'The option value or label to select' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        const selected = await session.selectRef(args.ref, args.option)
        return { ok: true, message: `selected ${JSON.stringify(args.option)} in ref ${args.ref} (now: ${selected.join(', ')})` }
      },
    }),
    defineTool({
      name: 'browser_drag',
      description:
        'Drag the element referenced by `fromRef` onto the element referenced by `toRef` (both from the most ' +
        'recent snapshot), e.g. to reorder a list or move an item into a drop zone.',
      parameters: {
        fromRef: { type: 'number', required: true, description: 'The 1-based ref of the element to drag' },
        toRef: { type: 'number', required: true, description: 'The 1-based ref of the element to drop it on' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        await session.dragRef(args.fromRef, args.toRef)
        return { ok: true, message: `dragged ref ${args.fromRef} onto ref ${args.toRef}` }
      },
    }),
    defineTool({
      name: 'browser_scroll',
      description:
        'Scroll the page. With `ref`, scroll until that element (from the most recent snapshot) is inside the ' +
        'viewport — the useful form, because a snapshot can list elements that are off-screen. Without `ref`, ' +
        'scroll by `amount` pixels in a direction.',
      parameters: {
        ref: { type: 'number', description: 'Optional 1-based ref of the element to bring into the viewport' },
        direction: { type: 'string', description: 'Either "up" or "down"; used when no ref is given' },
        amount: { type: 'number', description: 'Pixels to scroll when no ref is given; defaults to 500' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        if (args.ref !== undefined) {
          const bounds = await session.scrollToRef(args.ref)
          return {
            ok: true,
            message:
              `scrolled ref ${args.ref} into view: {x=${bounds.x},y=${bounds.y},w=${bounds.width},h=${bounds.height}} ` +
              '(viewport coordinates, as in the snapshot)',
          }
        }
        if (args.direction !== 'up' && args.direction !== 'down') {
          throw new Error(
            `browser-view: browser_scroll needs a ref, or direction "up"/"down" ` +
              `(got direction=${JSON.stringify(args.direction)})`,
          )
        }
        const amount = args.amount ?? 500
        await session.scroll(args.direction, amount)
        return { ok: true, message: `scrolled ${args.direction} by ${amount}px` }
      },
    }),
    defineTool({
      name: 'browser_wait',
      description:
        'Wait for page content to appear: a fixed delay (`ms`), a visible CSS selector (`selector`), or text the ' +
        'page renders (`text`). Use exactly one of the three, after an action that starts asynchronous loading. ' +
        'If it never appears the error says what was awaited and how long it was given.',
      parameters: {
        ms: { type: 'number', description: 'Wait this many milliseconds' },
        selector: { type: 'string', description: 'Wait until this CSS selector becomes visible' },
        text: { type: 'string', description: 'Wait until this text appears in the page body' },
        timeout: { type: 'number', description: 'Max wait in ms; defaults to timeoutMs' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        const result = await session.wait({
          ...(args.ms !== undefined ? { ms: args.ms } : {}),
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.timeout !== undefined ? { timeoutMs: args.timeout } : {}),
        })
        return { ok: true, message: `waited ${result.elapsedMs}ms for ${result.waited}` }
      },
    }),
  ]
}
