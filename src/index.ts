import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { AdoptedViewSession, DEFAULT_MAX_CHARS, DEFAULT_MAX_ELEMENTS } from './session.ts'
import { resolveScreenshotDir } from './screenshots.ts'
import { SpaceManager, spaceChannelFrom, userDataDirFromSpaceState } from './spaces.ts'
import { desktopViewTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'desktop-view'

/**
 * This plugin contributes tools and publishes screenshots into the durable image store.
 *
 * `attachments` is not decoration: `browser_screenshot` hands the picture to the model
 * *through* that service, so a deployment without it would leave the tool able to write
 * a file and unable to deliver an image. Declaring it in `inject` makes the loader wait
 * for the service instead of letting the tool discover its absence at call time.
 */
export const inject = ['tools', 'attachments']

/** Plugin configuration. */
export interface Config {
  /** Loopback endpoint of the shell. Defaults to `DSH_DESKTOP_VIEW_CDP`. */
  cdpUrl?: string
  /** CDP target id of the view. Defaults to `DSH_DESKTOP_VIEW_TARGET`. */
  targetId?: string
  /**
   * Directory of the shell's task-space files. Defaults to `DSH_DESKTOP_VIEW_SPACES`.
   *
   * Setting it (or running under a shell that exports it) is what turns this plugin from "one
   * adopted view" into "a task space per task": the shell writes which spaces exist and which is
   * active, and this plugin's tools act on the active one. Without it the plugin still adopts the
   * single view the handshake named, and `browser_space` refuses with a message saying why.
   */
  spacesDir?: string
  /** Connection and per-action timeout in milliseconds. */
  timeoutMs: number
  /** Cap on the elements one snapshot lists; beyond it the snapshot is truncated. */
  maxElements: number
  /** Cap on the characters a text read returns; beyond it the text is cut and says so. */
  maxChars: number
  /**
   * Directory `browser_screenshot` writes to when the caller names no path.
   *
   * **Explicit configuration always wins.** Unset (the default) means
   * `<userDataDir>/screenshots` — the profile directory the shell publishes, which is the same
   * place its downloads go (ADR-0011) — and, when no shell published one, the system temporary
   * directory's own `dsh-desktop-view-screenshots` subdirectory.
   *
   * It is deliberately **not** the host process's working directory (#16): that is "where the
   * user happened to type the command" — for this repository's own `npm run shell`, the
   * repository root, which is how screenshots ended up in `git status`.
   */
  screenshotDir?: string
}

/** Schemastery schema validating {@link Config}. */
export const Config: z<Config> = z.object({
  cdpUrl: z.string(),
  targetId: z.string(),
  spacesDir: z.string(),
  timeoutMs: z.number().default(30000),
  maxElements: z.number().default(DEFAULT_MAX_ELEMENTS),
  maxChars: z.number().default(DEFAULT_MAX_CHARS),
  // 没有 `.default('.')`：默认值取决于**外壳发布了什么**，不是一个能写死在 schema 里的常量。
  // 见 apply() 里的 defaultScreenshotDir 与 src/screenshots.ts。
  screenshotDir: z.string(),
})

/**
 * Mount the plugin: register the desktop-view tools and disconnect from the shell
 * on unload. The shell owns the view and outlives this plugin, so teardown only
 * releases the connection.
 */
export function apply(ctx: Context, config: Config): void {
  let pending: Promise<AdoptedViewSession> | undefined

  // The handshake is read on first use, not at load: a plugin may be mounted
  // before the shell has finished publishing the view identity.
  const cdpUrl = config.cdpUrl ?? process.env.DSH_DESKTOP_VIEW_CDP
  const targetId = config.targetId ?? process.env.DSH_DESKTOP_VIEW_TARGET
  const url = process.env.DSH_DESKTOP_VIEW_URL
  const channel = spaceChannelFrom(config.spacesDir ?? process.env.DSH_DESKTOP_VIEW_SPACES)
  const spaces =
    channel === undefined
      ? undefined
      : new SpaceManager({
          dir: channel.dir,
          timeoutMs: config.timeoutMs,
          maxElements: config.maxElements,
          maxChars: config.maxChars,
        })

  /**
   * Where a screenshot goes when the caller names no path.
   *
   * Answered **each time one is needed**, not once at load — for the same reason as the
   * handshake above: the profile directory is a fact the *shell* publishes (in the space
   * channel's `state.json`; the same fact its `downloadsDir` is derived from, ADR-0011), and
   * a plugin may be mounted before the shell has written it. Answering too early and keeping
   * that answer forever is exactly the "silently degraded" shape this ticket is about.
   *
   * The three-way priority (explicit config → the shell's profile → the temporary fallback)
   * lives in `resolveScreenshotDir`, in one place, and each of the three is pinned by a test.
   */
  const defaultScreenshotDir = (): string => {
    const published = userDataDirFromSpaceState(channel?.stateFile)
    return resolveScreenshotDir({
      ...(config.screenshotDir !== undefined ? { configured: config.screenshotDir } : {}),
      ...(published !== undefined ? { userDataDir: published } : {}),
    }).dir
  }

  /**
   * Resolve the session every tool acts on.
   *
   * This is the whole of "all tools act on the current space": there is exactly one place that
   * hands out a session, and with a space channel it hands out the **active space's** session.
   * A per-tool `space` argument would have meant touching fifteen tool signatures (and would have
   * left "forgot to pass it" as a way to silently drive the wrong space).
   */
  const adopt = (): Promise<AdoptedViewSession> => {
    if (cdpUrl === undefined || cdpUrl === '') {
      throw new Error(
        'no desktop view endpoint: set the `cdpUrl` config option or run under the desktop shell, ' +
          'which exports DSH_DESKTOP_VIEW_CDP',
      )
    }
    if (spaces !== undefined) return spaces.adopt(cdpUrl)
    if (pending !== undefined) return pending
    pending = AdoptedViewSession.adopt({
      cdpUrl,
      timeoutMs: config.timeoutMs,
      maxElements: config.maxElements,
      maxChars: config.maxChars,
      ...(targetId !== undefined && targetId !== '' ? { targetId } : {}),
      ...(url !== undefined && url !== '' ? { url } : {}),
      // 没有空间通道时，外壳的下载日志也无处可寻：`browser_download` 会如实说
      // "没有外壳可问"，而不是假装没有下载过（ADR-0011）。
      ...(channel !== undefined ? { downloadJournalFile: channel.downloadJournalFile } : {}),
    }).catch((error: unknown) => {
      // Let the next call retry instead of replaying a stale rejection.
      pending = undefined
      throw error
    })
    return pending
  }

  ctx.effect(() => {
    return () => {
      const current = pending
      pending = undefined
      if (current !== undefined) {
        void current.then((session) => session.close()).catch(() => undefined)
      }
      if (spaces !== undefined) void spaces.close()
    }
  })

  // The store the screenshot publishes into is the deployment's own attachment service,
  // taken from the context rather than constructed here: the caller (the model session)
  // has to be able to read the image back, so it must be the same store the session uses.
  const attachments: AttachmentStore = ctx.attachments
  for (const tool of desktopViewTools(adopt, {
    attachments,
    // 一个**函数**，不是此刻算好的一个字符串：默认目录来自外壳发布的事实，现问现答（见上）。
    screenshotDir: defaultScreenshotDir,
    ...(spaces !== undefined ? { spaces } : {}),
  })) {
    ctx.tools.register(tool)
  }
}
