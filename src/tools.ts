import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { basename, resolve } from 'node:path'
import { describeDialog } from './dialogs.ts'
import { describeDownload, renderDownloadList } from './downloads.ts'
import type {
  AdoptedViewSession,
  DownloadReading,
  ExtractedText,
  NavigationResult,
  PageDiagnostics,
  PageSnapshot,
  UploadResult,
} from './session.ts'
import { cutText } from './session.ts'
import type { SpaceAction, SpaceCommandOutcome } from './spaces.ts'

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
          // 元素在哪一个框架里（T9）。**缺席 = 主框架**：一个页面绝大多数元素都在主框架里，
          // 给每一条都写一遍"主框架"只会把快照变长，而"缺席即最常见的那种"是这份快照
          // 一直以来的写法（`state` 也是这么处理的）。
          frame: { type: 'string' },
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

/**
 * 跑一次动作，并取回"这次动作期间顺带发生了什么"。
 *
 * 动作从来不只做一件事：一次点击可能弹出一个 `confirm`、可能开始一次下载。只报
 * "clicked ref 3" 会让模型以为页面没变，而实际上文件已经被存下来了（票 #10 明确要求
 * 这一点如实）。标记是在动作**之前**取的，所以归因不靠时间戳的比较。
 *
 * @param session - 会话。
 * @param run - 动作本身。
 * @returns 给模型看的那几行附注（可能是空的）。
 */
async function activityNotes(session: AdoptedViewSession, run: () => Promise<unknown>): Promise<string[]> {
  const mark = session.activityMark()
  await run()
  return session.describeActivity(session.activitySince(mark))
}

/** 把动作自己的那句话与附注拼成工具结果里的一行（没有附注就一字不加）。 */
function withNotes(message: string, notes: readonly string[]): string {
  return notes.length === 0 ? message : `${message}\n${notes.join('\n')}`
}

/** Render a plain string result (an expression's value, the captured JSON). */
function renderText(_args: unknown, value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/**
 * Turn whatever an evaluated expression produced into the string the model reads.
 *
 * A string is handed over as it is, because that is what the expression meant; anything
 * else is serialized, and `undefined` is said out loud rather than rendered as the text
 * `"undefined"` — "the page has no such value" and "the page's value is the string
 * undefined" are different answers.
 *
 * @param value - what the page's expression evaluated to.
 * @returns the text form of that value.
 */
function renderEvaluated(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '(the expression produced no value: it must return something to be read)'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The schema of a tool whose whole value is one string. */
const textSchema = { type: 'string' } as const

/**
 * 外壳发布了、但插件**读不动**的那些空间记录。
 *
 * 它是 `browser_space` 输出的一部分，而不是诊断日志：一条读不动的记录被跳过之后，
 * 工具输出里如果不说它为什么不在表里，读的人只会以为那个空间从来没存在过 ——
 * 也就是"报出来的错跟真实原因毫无关系"的另一种写法。
 */
const skippedSchema = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      index: { type: 'number', required: true },
      name: { type: 'string' },
      reason: { type: 'string', required: true },
    },
  },
} as const

/**
 * Canonical output of `browser_space`.
 *
 * Every field is what the **shell** published after handling the request, read back from Electron —
 * `storagePath` above all, because Electron's `Session` exposes no `getPartition()` and "where the
 * storage really is" is the one answer that can contradict the partition the shell meant to use.
 */
const spaceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true },
    active: { type: 'string', required: true },
    message: { type: 'string', required: true },
    // 读不动的记录也要出现在这里（见 {@link skippedSchema}）：一张少了一条的表必须说明它少了一条。
    skipped: skippedSchema,
    spaces: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          partition: { type: 'string', required: true },
          storagePath: { type: 'string', required: true },
          targetId: { type: 'string' },
          // 外壳对"这个 targetId 怎么来的"说的话（`resolved` / `remembered` / `unavailable` + 原因）：
          // 不放进这里就等于把它丢掉，而"这个空间为什么动不了"正是它要回答的。
          targetIdSource: { type: 'string' },
          targetIdReason: { type: 'string' },
          url: { type: 'string', required: true },
          visible: { type: 'boolean', required: true },
          active: { type: 'boolean', required: true },
          isDefault: { type: 'boolean', required: true },
          cookieCount: { type: 'number', required: true },
          inherited: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sourceUrl: { type: 'string', required: true },
              cookiesInSpace: { type: 'number', required: true },
              localStorageOrigin: { type: 'string' },
              localStorageKeys: { type: 'number', required: true },
            },
          },
        },
      },
    },
  },
} as const

/** Render the space table as the lines the model reads. */
function renderSpace(_args: unknown, value: SpaceCommandValue): { type: 'text'; text: string }[] {
  const lines = [value.message, `Active space: ${value.active}`]
  for (const space of value.spaces) {
    const marks = [space.active ? 'active' : undefined, space.isDefault ? 'default' : undefined]
      .filter((mark) => mark !== undefined)
      .join(', ')
    lines.push(
      `  ${space.name}${marks === '' ? '' : ` (${marks})`} — ${space.url === '' ? '(no page)' : space.url}` +
        ` partition=${space.partition} storage=${space.storagePath} cookies=${space.cookieCount}` +
        // 没有 target 这件事不许静默省略：这一行就是"这个空间为什么动不了"的答案。
        (space.targetId === undefined
          ? ` — no CDP target yet: ${space.targetIdReason ?? 'the shell did not say why'}`
          : ''),
    )
  }
  for (const entry of value.skipped) {
    lines.push(
      `  ${entry.name ?? `<record ${entry.index}>`} — NOT USABLE, skipped: ${entry.reason}` +
        ' (the other spaces are unaffected)',
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The schema-shaped value `browser_space` returns. */
interface SpaceCommandValue {
  action: string
  active: string
  message: string
  skipped: Array<{ index: number; name?: string; reason: string }>
  spaces: Array<{
    name: string
    partition: string
    storagePath: string
    targetId?: string
    targetIdSource?: string
    targetIdReason?: string
    url: string
    visible: boolean
    active: boolean
    isDefault: boolean
    cookieCount: number
    inherited?: {
      sourceUrl: string
      cookiesInSpace: number
      localStorageOrigin?: string
      localStorageKeys: number
    }
  }>
}

/**
 * Canonical output of `browser_extract`.
 *
 * The text plus what the cap did to it: `truncated` and `totalChars` are separate from
 * the string so a caller never has to infer "was this all of it" from the text itself.
 */
const extractedSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    totalChars: { type: 'number', required: true },
  },
} as const

/** Render extracted text, saying plainly when the cap cut it. */
function renderExtracted(_args: unknown, value: ExtractedText): { type: 'text'; text: string }[] {
  if (!value.truncated) return [{ type: 'text', text: value.text }]
  return [
    {
      type: 'text',
      text:
        `${value.text}\n\n(truncated: the page renders ${value.totalChars} characters and this read returned ` +
        `${value.text.length}; call browser_extract with a larger maxChars to read further)`,
    },
  ]
}

/**
 * Canonical output of `browser_diagnostics`: what the page said about itself.
 *
 * Both halves are shaped rather than pasted together as prose, because "which request
 * failed and with what status" is something a caller may want to branch on.
 */
const diagnosticsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    console: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', required: true },
          text: { type: 'string', required: true },
          location: { type: 'string', required: true },
        },
      },
    },
    failedRequests: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true },
          url: { type: 'string', required: true },
          status: { type: 'number', required: true },
          statusText: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** Render the page's own account of what went wrong. */
function renderDiagnostics(_args: unknown, value: PageDiagnostics): { type: 'text'; text: string }[] {
  const lines = [
    `Console messages: ${value.console.length}`,
    ...value.console.map((message) => `  [${message.type}] ${message.text} (${message.location})`),
    `Failed requests: ${value.failedRequests.length}`,
    ...value.failedRequests.map(
      (request) =>
        `  ${request.method} ${request.url} → ${request.status} ${request.statusText}: ${request.summary}`,
    ),
  ]
  if (value.console.length === 0 && value.failedRequests.length === 0) {
    lines.push('(the page reported no console messages and no failed requests)')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The schema-shaped (unbranded) image metadata a screenshot outcome carries. */
interface ScreenshotImageMeta {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** Canonical screenshot outcome: where the PNG was written, plus its durable image reference. */
interface ScreenshotOutcome {
  path: string
  image: ScreenshotImageMeta
}

/** The screenshot output schema: a path plus a durable image reference. */
const screenshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    image: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'number', required: true },
        width: { type: 'number', required: true },
        height: { type: 'number', required: true },
        name: { type: 'string' },
      },
    },
  },
} as const

/**
 * Turn stored image metadata back into the durable reference an image block carries.
 *
 * The output value is schema-shaped (plain strings and numbers) while the model-facing
 * block needs the branded reference, so this is where the two meet — and it is the only
 * place that needs to know the metadata's fields line up.
 *
 * @param image - the metadata the outcome carries.
 * @returns the attachment reference for the image block.
 */
function imageRefFromMeta(image: ScreenshotImageMeta): ImageAttachmentRef {
  return {
    attachmentId: image.attachmentId as AttachmentId,
    mediaType: image.mediaType as ImageMediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name !== undefined ? { name: image.name } : {}),
  }
}

/**
 * Render a screenshot as the model actually receives it: the path for the record, and
 * the image itself as an attachment block.
 *
 * The block is the point. A path alone asks the model to trust that a file exists and
 * leaves it unable to see the page; the attachment is the pixels (T5).
 *
 * @param _args - unused; the path argument is already reflected in the value.
 * @param value - the screenshot outcome.
 * @returns a text block naming the file, then the image block.
 */
function renderScreenshot(_args: unknown, value: ScreenshotOutcome): ContentBlock[] {
  return [
    { type: 'text', text: `Screenshot saved to: ${value.path}` },
    { type: 'image', attachment: imageRefFromMeta(value.image) },
  ]
}

/** Resolve the requested screenshot path, defaulting under `screenshotDir`. */
function screenshotPath(screenshotDir: string, requested?: string): string {
  if (requested !== undefined && requested.trim() !== '') return resolve(requested)
  return resolve(screenshotDir, `browser-${Date.now()}.png`)
}

/**
 * The slice of the attachment service the screenshot tool needs.
 *
 * Narrow on purpose: the screenshot publishes one PNG and reads back its durable
 * reference, and depending on the whole store would make the seam wider than the use.
 */
export type ImageAttachmentSink = Pick<AttachmentStore, 'saveImage'>

/**
 * What the tools need besides the adopted view.
 *
 * `attachments` is the DSH attachment service (`ctx.attachments`). It is optional here,
 * not because a screenshot may quietly do without it, but so that a caller which never
 * takes a screenshot — several tests build the tools to check the action surface — does
 * not have to stand up a store it will not use. A screenshot with no store is refused
 * with a message saying so, because returning a path and calling it delivered would be a
 * false claim (T5).
 */
export interface ToolDependencies {
  /** Durable image store the screenshot is published into. */
  attachments?: ImageAttachmentSink
  /** Directory a screenshot lands in when the caller names no path. Defaults to the process cwd. */
  screenshotDir?: string
  /**
   * The task spaces the shell is hosting. Absent when the plugin runs somewhere with no shell to
   * ask (a browser, a deployment with no space channel configured) — and then `browser_space`
   * refuses with a message saying so rather than pretending there is one space.
   */
  spaces?: SpaceController
}

/**
 * The slice of the task-space manager the space tool needs.
 *
 * Narrow on purpose, and structural: the tool needs "run this action and tell me what the shell
 * answered", not the channel, the sessions, or the parsing in {@link SpaceManager}.
 */
export interface SpaceController {
  /**
   * Run one space action against the shell.
   * @param action - `list`, `create`, `use`, or `close`.
   * @param name - the space the action is about; unused by `list`.
   * @returns what the shell published after handling it.
   */
  command(action: SpaceAction, name?: string): Promise<SpaceCommandOutcome>
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
    // 框架里的元素单独标出来：同一个页面里两个框架可以有长得一模一样的控件，
    // 而 ref 落在哪一个框架里是它含义的一部分（T9）。
    const frame = element.frame === undefined ? '' : ` (in frame ${element.frame})`
    lines.push(`[${element.ref}] ${element.role} ${name}${state} {x=${x},y=${y},w=${width},h=${height}}${frame}`)
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
 * T1 registers `browser_navigate`, T3 adds `browser_snapshot`, T4 adds the interaction
 * surface that consumes the snapshot's refs (click, type, type_keys, press_key, hover,
 * select, drag, scroll, wait), and T5 adds the *reading* surface: `browser_extract` for
 * the page's text, `browser_evaluate` for state that never reaches the DOM,
 * `browser_json` for the data the page fetched, `browser_screenshot` for the pixels, and
 * `browser_diagnostics` for why a page came back empty.
 *
 * The two halves stay apart on purpose. Reading is done by asking for what is wanted
 * (`browser_extract` on demand), never by growing the snapshot: the snapshot stays the
 * compact list of what can be acted on (ADR-0005). Acting is done by `ref` (ADR-0001),
 * and `browser_evaluate` is a reading capability — its description says so, because a
 * model that reached for an expression to locate an element would end up with an element
 * no later action can name.
 *
 * @param adopt - resolves the adopted view session, connecting on first use.
 * @param deps - the attachment store screenshots are published into, and where they land.
 * @returns the tool definitions to register, `browser_navigate` first.
 */
export function desktopViewTools(
  adopt: () => Promise<AdoptedViewSession>,
  deps: ToolDependencies = {},
): ToolDefinition[] {
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
        const notes = await activityNotes(session, () => session.clickRef(args.ref))
        return { ok: true, message: withNotes(`clicked ref ${args.ref}`, notes) }
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
        const notes = await activityNotes(session, () => session.fillRef(args.ref, args.text))
        return { ok: true, message: withNotes(`set ref ${args.ref} to ${JSON.stringify(args.text)}`, notes) }
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
        const notes = await activityNotes(session, () => session.typeRef(args.ref, args.text))
        return {
          ok: true,
          message: withNotes(`typed ${JSON.stringify(args.text)} into ref ${args.ref} key by key`, notes),
        }
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
        const notes = await activityNotes(session, () => session.pressKey(args.key, args.ref))
        return {
          ok: true,
          message: withNotes(
            args.ref === undefined ? `pressed ${args.key}` : `pressed ${args.key} in ref ${args.ref}`,
            notes,
          ),
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
        const notes = await activityNotes(session, () => session.hoverRef(args.ref))
        return { ok: true, message: withNotes(`hovered ref ${args.ref}`, notes) }
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
        const mark = session.activityMark()
        const selected = await session.selectRef(args.ref, args.option)
        const notes = session.describeActivity(session.activitySince(mark))
        return {
          ok: true,
          message: withNotes(
            `selected ${JSON.stringify(args.option)} in ref ${args.ref} (now: ${selected.join(', ')})`,
            notes,
          ),
        }
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
        const notes = await activityNotes(session, () => session.dragRef(args.fromRef, args.toRef))
        return {
          ok: true,
          message: withNotes(`dragged ref ${args.fromRef} onto ref ${args.toRef}`, notes),
        }
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
        const mark = session.activityMark()
        let message: string
        if (args.ref !== undefined) {
          const bounds = await session.scrollToRef(args.ref)
          message =
            `scrolled ref ${args.ref} into view: {x=${bounds.x},y=${bounds.y},w=${bounds.width},h=${bounds.height}} ` +
            '(viewport coordinates, as in the snapshot)'
        } else {
          if (args.direction !== 'up' && args.direction !== 'down') {
            throw new Error(
              `browser-view: browser_scroll needs a ref, or direction "up"/"down" ` +
                `(got direction=${JSON.stringify(args.direction)})`,
            )
          }
          const amount = args.amount ?? 500
          await session.scroll(args.direction, amount)
          message = `scrolled ${args.direction} by ${amount}px`
        }
        return { ok: true, message: withNotes(message, session.describeActivity(session.activitySince(mark))) }
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
        const mark = session.activityMark()
        const result = await session.wait({
          ...(args.ms !== undefined ? { ms: args.ms } : {}),
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.timeout !== undefined ? { timeoutMs: args.timeout } : {}),
        })
        return {
          ok: true,
          message: withNotes(
            `waited ${result.elapsedMs}ms for ${result.waited}`,
            session.describeActivity(session.activitySince(mark)),
          ),
        }
      },
    }),
    defineTool({
      name: 'browser_extract',
      description:
        'Read the text the page renders (its `innerText`) — the readable content, and the way to get at body text ' +
        'the snapshot deliberately does not carry. The text is cut at `maxChars` (20000 by default) and the result ' +
        'says whether it was cut and how long the page really was. Use it before re-snapshotting when what you ' +
        'need is what the page *says* rather than which elements it has.',
      parameters: {
        maxChars: {
          type: 'number',
          description: 'Cut the text at this many characters; defaults to the configured cap (20000)',
        },
      },
      output: { schema: extractedSchema, render: renderExtracted },
      async execute(args): Promise<ExtractedText> {
        const session = await adopt()
        return await session.extractText(args.maxChars)
      },
    }),
    defineTool({
      name: 'browser_evaluate',
      description:
        'Evaluate a read-only JavaScript expression in the page and return its value as text (e.g. ' +
        '"document.title", "JSON.stringify(window.__state)"). Use it for state that never reaches the DOM. It ' +
        'only reads: to click, type, hover, select or drag, name the element by its `ref` from browser_snapshot, ' +
        'because an element produced by an expression is one no later action can address.',
      parameters: {
        expression: {
          type: 'string',
          required: true,
          description: 'A JavaScript expression to evaluate, e.g. JSON.stringify(window.__data)',
        },
      },
      output: { schema: textSchema, render: renderText },
      async execute(args): Promise<string> {
        const session = await adopt()
        return renderEvaluated(await session.evaluate(args.expression))
      },
    }),
    defineTool({
      name: 'browser_json',
      description:
        'Return the JSON the current page has loaded through fetch/XHR, as a JSON array of {url, status, body} ' +
        '(newest last, only what the document now showing has received). Use it when the page has not rendered ' +
        'its data — the responses often still carry it. A 4xx/5xx is not data here: it is reported by ' +
        'browser_diagnostics, with its status.',
      parameters: {},
      output: { schema: textSchema, render: renderText },
      async execute(): Promise<string> {
        const session = await adopt()
        const text = JSON.stringify(session.getJsonResponses())
        if (text.length <= session.maxChars) return text
        return `${cutText(text, session.maxChars)}\n…(truncated at ${session.maxChars} characters of ${text.length})`
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description:
        'Capture the current page as a PNG and deliver the image itself, along with the path it was saved to. ' +
        'The image covers the view the agent is driving: its size is the viewport in CSS pixels times the ' +
        'display scale (read `devicePixelRatio` in the page to get back to viewport coordinates). Use it when ' +
        'the question is visual — layout, styles, a canvas, a chart.',
      parameters: {
        path: {
          type: 'string',
          description: 'Optional file path for the PNG; defaults to browser-<timestamp>.png under the screenshot dir',
        },
      },
      output: { schema: screenshotSchema, render: renderScreenshot },
      async execute(args): Promise<ScreenshotOutcome> {
        const session = await adopt()
        const attachments = deps.attachments
        if (attachments === undefined) {
          throw new Error(
            'browser-view: browser_screenshot cannot deliver an image — this plugin was mounted without the ' +
              '`attachments` service, so there is nothing to hand the picture to. Nothing was captured; ' +
              'mount the plugin with the attachments service available (it is declared in `inject`).',
          )
        }
        const path = screenshotPath(deps.screenshotDir ?? process.cwd(), args.path)
        const data = await session.screenshot(path)
        const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(path) })
        return {
          path,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          },
        }
      },
    }),
    defineTool({
      name: 'browser_diagnostics',
      description:
        'Report what the current page said about itself: the console messages it produced (errors and uncaught ' +
        'exceptions included) and the requests that failed, each with its HTTP status and a short summary of the ' +
        'response. Use it when the page is empty, content is missing, or an action had no visible effect — it is ' +
        'how "nothing is there" becomes "this error, this 404".',
      parameters: {},
      output: { schema: diagnosticsSchema, render: renderDiagnostics },
      async execute(): Promise<PageDiagnostics> {
        const session = await adopt()
        return session.diagnostics()
      },
    }),
    defineTool({
      name: 'browser_upload',
      description:
        'Give a local file to a file input on the page, named by `ref` from the most recent snapshot. Point it at ' +
        'the file input itself when the snapshot lists one; when the real input is hidden behind a styled control, ' +
        'point it at that control (the label the snapshot lists) and the file chooser it opens is what receives the ' +
        'file. The result reports the file name and size the input now holds, read back from the page — not merely ' +
        'that the call was made.',
      parameters: {
        ref: {
          type: 'number',
          required: true,
          description: 'The 1-based ref of the file input, or of the control that opens its file chooser',
        },
        path: { type: 'string', required: true, description: 'Absolute path of the local file to hand over' },
      },
      output: { schema: actionSchema, render: renderAction },
      async execute(args): Promise<{ ok: boolean; message: string }> {
        const session = await adopt()
        const mark = session.activityMark()
        const result: UploadResult = await session.uploadRef(args.ref, args.path)
        const notes = session.describeActivity(session.activitySince(mark))
        return {
          ok: true,
          message: withNotes(
            `gave ${result.path} to ref ${result.ref} (${result.element}) through the ${result.via === 'input' ? 'file input itself' : 'file chooser it opened'}; ` +
              `the input now holds ${result.count} file(s): ${result.name} (${result.size} bytes)`,
            notes,
          ),
        }
      },
    }),
    defineTool({
      name: 'browser_dialog',
      description:
        'Dialogs (alert / confirm / prompt / beforeunload) are answered the moment they appear, so a page can never ' +
        'be left waiting: with no argument this reports the dialogs that have appeared and the answer being given. ' +
        'Pass `answer` to change what happens from now on — "accept" makes the next confirm/prompt be accepted ' +
        '(with `text` for a prompt, defaulting to the page\'s own default), "dismiss" refuses them. A beforeunload ' +
        'guard is always refused: accepting it neither lets the navigation through nor returns promptly, and the ' +
        'refusal is what makes the navigation report itself as refused instead of hanging.',
      parameters: {
        answer: {
          type: 'string',
          description: 'Optional: "accept" or "dismiss", the answer to give dialogs from now on',
        },
        text: {
          type: 'string',
          description: 'With answer "accept": the text to type into a prompt; defaults to the page\'s own default',
        },
      },
      output: { schema: textSchema, render: renderText },
      async execute(args): Promise<string> {
        const session = await adopt()
        const lines: string[] = []
        if (args.answer !== undefined) {
          if (args.answer !== 'accept' && args.answer !== 'dismiss') {
            throw new Error(
              `browser-view: browser_dialog needs answer to be "accept" or "dismiss" (got ${JSON.stringify(args.answer)})`,
            )
          }
          const policy = session.setDialogPolicy({
            answer: args.answer,
            ...(args.text !== undefined ? { promptText: args.text } : {}),
          })
          lines.push(
            `Dialogs from now on are ${policy.answer === 'accept' ? 'accepted' : 'dismissed'}` +
              (policy.promptText === undefined ? '' : `; a prompt is accepted with ${JSON.stringify(policy.promptText)}`) +
              '.',
          )
        }
        const policy = session.currentDialogPolicy()
        lines.push(
          `Answer in force: ${policy.answer === 'accept' ? 'accept' : 'dismiss'}` +
            (policy.promptText === undefined ? '' : ` (prompt text: ${JSON.stringify(policy.promptText)})`) +
            '. A beforeunload guard is always dismissed.',
        )
        const records = session.dialogRecordsSoFar()
        if (records.length === 0) {
          lines.push('No dialog has appeared in this view yet.')
        } else {
          lines.push(`Dialogs seen (${records.length}, oldest first):`)
          for (const record of records) lines.push(`  ${describeDialog(record)}`)
        }
        return lines.join('\n')
      },
    }),
    defineTool({
      name: 'browser_download',
      description:
        'Report what the desktop shell downloaded and where the files really are. Downloads are saved silently into ' +
        'the browser profile\'s own downloads directory (a native "save as" dialog would block an agent-driven ' +
        'browser forever), and the shell records every one of them with the path it actually wrote. Call it with no ' +
        'argument to list them, or with an `id` to get one download\'s path plus a preview of the bytes on disk. A ' +
        'click that starts a download says so in its own result — a download is not a page change.',
      parameters: {
        id: {
          type: 'number',
          description: 'Optional: the download to read, as listed (its `#id`) — its path and a content preview',
        },
        maxChars: {
          type: 'number',
          description: 'With an id: cut the preview at this many characters; defaults to the configured cap (20000)',
        },
      },
      output: { schema: textSchema, render: renderText },
      async execute(args): Promise<string> {
        const session = await adopt()
        if (args.id === undefined) {
          const journal = await session.downloads()
          const started = session
            .activitySince({ dialogs: 0, downloads: 0 })
            .downloads.filter((start) => !journal.downloads.some((record) => record.url === start.url))
          const lines = [renderDownloadList(journal)]
          if (started.length > 0) {
            lines.push(
              `Seen by this session but not yet recorded by the shell: ${started
                .map((start) => `${start.filename} (${start.url})`)
                .join(', ')} — a download that is still running has no file yet.`,
            )
          }
          return lines.join('\n')
        }
        const reading: DownloadReading = await session.readDownload(args.id, args.maxChars)
        const lines = [describeDownload(reading.record)]
        if (reading.unreadable !== undefined) {
          lines.push(`No content preview: ${reading.unreadable}.`)
          return lines.join('\n')
        }
        const preview = reading.preview
        if (preview === undefined) return lines.join('\n')
        lines.push(
          `Content (${preview.binary ? 'not text' : 'text'}, ${String(preview.totalBytes)} byte(s)` +
            `${preview.truncated ? `, cut at ${String(preview.text.length)} characters` : ''}):`,
        )
        lines.push(preview.text)
        return lines.join('\n')
      },
    }),
    defineTool({
      name: 'browser_space',
      description:
        'Manage the task spaces of the desktop browser. A task space is a browser state of its own — ' +
        'its own cookies and storage — so two spaces can be logged in to the same site without seeing ' +
        'each other. Every other browser_* tool acts on the **active** space only. Actions: "list" shows ' +
        'the spaces and which one is active; "create" makes a new one (named by `name`), inherits the ' +
        "default space's login state, and makes it active; \"use\" switches to an existing one; \"close\" " +
        "releases a space's page and erases its storage (the default space cannot be closed).",
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'One of "list", "create", "use", "close"',
        },
        name: {
          type: 'string',
          description:
            'The space to act on: 1-32 characters of lowercase letters, digits and dashes. Required ' +
            'for create/use/close; not used by list.',
        },
      },
      output: { schema: spaceSchema, render: renderSpace },
      async execute(args): Promise<SpaceCommandValue> {
        const controller = deps.spaces
        if (controller === undefined) {
          throw new Error(
            'browser-view: browser_space has no shell to manage spaces in — this plugin was mounted ' +
              'without a task-space channel (no desktop shell published one, and no `spacesDir` was ' +
              'configured), so there is exactly one browser view and no way to create another. Only ' +
              'the shell can create a view: Playwright cannot (ADR-0002).',
          )
        }
        const action = args.action as SpaceAction
        if (action !== 'list' && action !== 'create' && action !== 'use' && action !== 'close') {
          throw new Error(
            `browser-view: browser_space needs action to be "list", "create", "use" or "close" ` +
              `(got ${JSON.stringify(args.action)})`,
          )
        }
        const outcome = await controller.command(action, args.name)
        return {
          action: outcome.action,
          active: outcome.state.active,
          message: outcome.message,
          // 读不动的记录原样带出去（`parseSpaceState` 已经把它们连同原因收好了）。
          skipped: outcome.state.skipped.map((entry) => ({
            index: entry.index,
            ...(entry.name !== undefined ? { name: entry.name } : {}),
            reason: entry.reason,
          })),
          spaces: outcome.state.spaces.map((space) => ({
            name: space.name,
            partition: space.partition,
            storagePath: space.storagePath,
            ...(space.targetId !== undefined ? { targetId: space.targetId } : {}),
            ...(space.targetIdSource !== undefined ? { targetIdSource: space.targetIdSource } : {}),
            ...(space.targetIdReason !== undefined ? { targetIdReason: space.targetIdReason } : {}),
            url: space.url,
            visible: space.visible,
            active: space.active,
            isDefault: space.isDefault,
            cookieCount: space.cookieCount,
            ...(space.inherited !== undefined
              ? {
                  inherited: {
                    sourceUrl: space.inherited.sourceUrl,
                    cookiesInSpace: space.inherited.cookiesInSpace,
                    ...(space.inherited.localStorageOrigin !== null
                      ? { localStorageOrigin: space.inherited.localStorageOrigin }
                      : {}),
                    localStorageKeys: space.inherited.localStorageKeys,
                  },
                }
              : {}),
          })),
        }
      },
    }),
  ]
}
