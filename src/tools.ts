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
 * T1 registers `browser_navigate`; T3 adds `browser_snapshot`. The snapshot is the
 * T3 deliverable — title, address, and indexed interactive elements with bounds — and
 * the interaction tools that *consume* those refs are a later ticket's surface, not
 * this one's.
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
  ]
}
