import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AdoptedViewSession, DEFAULT_MAX_ELEMENTS } from './session.ts'
import { desktopViewTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'desktop-view'

/** This plugin only contributes tools; the view itself is owned by the shell. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Loopback endpoint of the shell. Defaults to `DSH_DESKTOP_VIEW_CDP`. */
  cdpUrl?: string
  /** CDP target id of the view. Defaults to `DSH_DESKTOP_VIEW_TARGET`. */
  targetId?: string
  /** Connection and per-action timeout in milliseconds. */
  timeoutMs: number
  /** Cap on the elements one snapshot lists; beyond it the snapshot is truncated. */
  maxElements: number
}

/** Schemastery schema validating {@link Config}. */
export const Config: z<Config> = z.object({
  cdpUrl: z.string(),
  targetId: z.string(),
  timeoutMs: z.number().default(30000),
  maxElements: z.number().default(DEFAULT_MAX_ELEMENTS),
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
  const adopt = (): Promise<AdoptedViewSession> => {
    if (pending !== undefined) return pending
    const cdpUrl = config.cdpUrl ?? process.env.DSH_DESKTOP_VIEW_CDP
    const targetId = config.targetId ?? process.env.DSH_DESKTOP_VIEW_TARGET
    const url = process.env.DSH_DESKTOP_VIEW_URL
    if (cdpUrl === undefined || cdpUrl === '') {
      throw new Error(
        'no desktop view endpoint: set the `cdpUrl` config option or run under the desktop shell, ' +
          'which exports DSH_DESKTOP_VIEW_CDP',
      )
    }
    pending = AdoptedViewSession.adopt({
      cdpUrl,
      timeoutMs: config.timeoutMs,
      maxElements: config.maxElements,
      ...(targetId !== undefined && targetId !== '' ? { targetId } : {}),
      ...(url !== undefined && url !== '' ? { url } : {}),
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
    }
  })

  for (const tool of desktopViewTools(adopt)) {
    ctx.tools.register(tool)
  }
}
