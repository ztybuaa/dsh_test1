import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { REPO_ROOT, pageForTarget, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * The plugin's client half, loaded the way the host loads it.
 *
 * This is the file the host fetches as `/plugins/??dsh-desktop-view/client.js` and
 * materializes with `window.__ModuleLoader__.load({id, factory})`. Everything the
 * user can see of this plugin goes through here, and there is no second chance to
 * find out: a client half that loads into the wrong shape registers nothing, shows
 * nothing and reports nothing, while `npm test` stays green — which is exactly what
 * happened once already (the host's own words, from a real `--dsh` run: *"failed to
 * apply loader entry … (dsh-desktop-view): invalid plugin, expect function or object
 * with an apply method, received object"*).
 *
 * So these tests run the artifact through the same two steps the host runs it
 * through — load the entry, then `apply(ctx)` — in a real page inside the real shell,
 * where `window.__dshDesktopView` (the preload) is genuinely present.
 */

/** The generated artifact under test. */
const CLIENT_JS = join(REPO_ROOT, 'client.js')

/** Thunked copy read once per language, to prove the guide is translated and not raw keys. */
interface LanguageCopy {
  language: string
  tabTitle: string
  guideTitles: string[]
  guideDescriptions: string[]
}

/** What one load + `apply(ctx)` did, as observed through a stub context. */
interface ClientHalfReport {
  /** How many entries the loader was handed. */
  entryCount: number
  /** The entry's `id`, which the host keys the plugin by. */
  entryId: string
  /** What `factory(...)` returned, as far as the host can tell. */
  plugin: { keys: string[]; applyType: string; inject: unknown }
  /** Whether the spliced panel measurement installed itself on the page global. */
  panelInstalled: boolean
  /** The registered tab type, reduced to the facts a user-visible open depends on. */
  tabType: {
    id: string
    kind: string
    priority: string | null
    patterns: unknown
    guideEntries: number
    guideOrders: unknown[]
    perLanguage: LanguageCopy[]
  } | null
  /** The registered tab body. */
  body: { name: string; key: string; locale: string | null } | null
  /** The registered copy namespace. */
  locale: { ns: string; languages: string[] } | null
}

/** The package name the client half must identify itself by. */
function packageName(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name?: string }
  if (typeof manifest.name !== 'string') throw new Error('package.json has no name')
  return manifest.name
}

describe('client half — the artifact the host loads', () => {
  let shell: ShellProcess
  let page: Page
  /** The throwaway CDP connection used only to reach the window page. */
  let connection: { close: () => Promise<void> } | undefined
  let report: ClientHalfReport

  beforeAll(async () => {
    shell = await startShell()
    const windowTargetId = shell.handshake.windowTargetId
    if (windowTargetId === undefined) throw new Error('the shell did not publish a window target id')
    const connected = await pageForTarget(shell.handshake.cdpUrl, windowTargetId)
    connection = connected.browser
    page = connected.page

    // Exactly what the host's loader is: a global that receives one entry.
    await page.evaluate(() => {
      const host = window as unknown as { __moduleEntries?: unknown[]; __ModuleLoader__?: unknown }
      host.__moduleEntries = []
      host.__ModuleLoader__ = {
        load: (entry: unknown) => {
          ;(host.__moduleEntries as unknown[]).push(entry)
        },
      }
    })
    await page.addScriptTag({ path: CLIENT_JS })

    report = (await page.evaluate(() => {
      const host = window as unknown as {
        __moduleEntries?: Array<{ id: string; factory: (require: (name: string) => unknown) => unknown }>
        DshPanelRect?: { measure?: unknown }
      }
      const entries = host.__moduleEntries ?? []
      const entry = entries[0]
      const plugin = entry.factory(() => {
        throw new Error('the client half must not require anything while loading')
      }) as { apply?: unknown; inject?: unknown }

      /** Registered dictionaries: namespace, then language. */
      const dictionaries: Record<string, Record<string, Record<string, string>>> = {}
      /** Which language the bound translate reads; switched per read below. */
      let language = 'en'
      const calls: Array<Record<string, unknown>> = []
      const definitions: Array<Record<string, unknown>> = []
      let body: { name: string; key: string; locale: string | null } | null = null

      const ctx = {
        effect: (fn: () => unknown) => fn(),
        locale: {
          // The real `bind` returns a translate that is read fresh on every use, so
          // this one resolves through the dictionaries that `register` installed,
          // which is what makes the per-language read below meaningful.
          bind: (ns: string) => (key: string) => {
            const table = (dictionaries[ns] ?? {})[language] ?? {}
            return table[key] ?? key
          },
          register: (ns: string, dictionary: Record<string, Record<string, string>>) => {
            dictionaries[ns] = dictionary
            calls.push({ what: 'locale.register', ns, languages: Object.keys(dictionary).sort() })
            return () => {}
          },
        },
        sidebarRightTabs: {
          register: (definition: Record<string, unknown>) => {
            definitions.push(definition)
            calls.push({
              what: 'sidebarRightTabs.register',
              id: definition.id,
              kind: definition.kind,
              priority: definition.priority ?? null,
            })
            return () => {}
          },
        },
        slots: {
          inject: (seat: string, fn: () => unknown) => {
            calls.push({ what: 'slots.inject', seat })
            return fn()
          },
          register: (definition: { name: string; key: string; locale?: string }) => {
            body = { name: definition.name, key: definition.key, locale: definition.locale ?? null }
            calls.push({ what: 'slots.register', ...body })
            return () => {}
          },
        },
      }
      if (typeof plugin.apply === 'function') (plugin.apply as (c: unknown) => void)(ctx)

      const definition = definitions[0]
      const guide =
        Array.isArray(definition?.guide) === true ? (definition?.guide as Array<Record<string, unknown>>) : []
      // The copy is thunked on purpose ("read fresh on every use"), so it is read in
      // both languages rather than once.
      const perLanguage: LanguageCopy[] = ['zh', 'en'].map((code) => {
        language = code
        return {
          language: code,
          tabTitle: definition === undefined ? '' : String((definition.title as (a: string) => string)('sidebar://desktop-view')),
          guideTitles: guide.map((entry) => String((entry.title as () => string)())),
          guideDescriptions: guide.map((entry) =>
            typeof entry.description === 'function' ? String((entry.description as () => string)()) : '',
          ),
        }
      })
      const localeCall = calls.find((call) => call.what === 'locale.register')
      return {
        entryCount: entries.length,
        entryId: entry.id,
        plugin: { keys: Object.keys(plugin), applyType: typeof plugin.apply, inject: plugin.inject ?? null },
        panelInstalled: typeof host.DshPanelRect?.measure === 'function',
        tabType:
          definition === undefined
            ? null
            : {
                id: String(definition.id),
                kind: String(definition.kind),
                priority: definition.priority === undefined ? null : String(definition.priority),
                patterns: definition.patterns ?? null,
                guideEntries: guide.length,
                guideOrders: guide.map((entry) => entry.order),
                perLanguage,
              },
        body,
        locale:
          localeCall === undefined
            ? null
            : { ns: String(localeCall.ns), languages: localeCall.languages as string[] },
      }
    })) as ClientHalfReport
  }, 120_000)

  afterAll(async () => {
    if (connection !== undefined) await connection.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  it('loads into the shape the host accepts: one entry, and a plugin with apply()', () => {
    console.log('RAW client half, as loaded: ' + JSON.stringify(report.plugin))
    expect(report.entryCount).toBe(1)
    // The `id` must be the package name: it is the key the host keys the plugin by,
    // and the key the tab body registers under (see `docs/research/plugin-transport-and-panel-home.md` §6).
    expect(report.entryId).toBe(packageName())
    // This is the assertion that was missing when the real host rejected the bundle:
    // the splice used to hand back the panel API instead of the plugin object.
    expect(report.plugin.applyType).toBe('function')
    expect(report.plugin.inject).toEqual(['slots', 'locale', 'sidebarRightTabs'])
    // ...and both regions really ran: the measurement is installed on the page global.
    expect(report.panelInstalled).toBe(true)
  })

  it('registers the tab type as a page type that claims no address', () => {
    console.log('RAW tab type: ' + JSON.stringify(report.tabType).slice(0, 600))
    expect(report.tabType?.id).toBe(packageName())
    expect(report.tabType?.kind).toBe('desktop-view')
    expect(report.tabType?.priority).toBe('extension')
    // A page type is opened by `kind`, so it declares no address globs.
    expect(report.tabType?.patterns).toBeNull()
  })

  it('gives the type a guide entry the user can pick, in both languages', () => {
    // This is the difference between a tab type that exists and a tab a user can open.
    // A page type claims no address, so nothing in the product opens it by itself: the
    // guide lists one capsule per entry, and picking a capsule calls
    // `openTab(entry.kind)`. Delete the guide entry and every other test here still
    // passes while the pane becomes unreachable — so it is asserted, not assumed.
    const type = report.tabType
    console.log('RAW guide entries: ' + JSON.stringify(type?.perLanguage))
    expect(type?.guideEntries, 'the tab type must contribute a guide entry').toBeGreaterThan(0)
    expect(type?.guideOrders.length).toBe(type?.guideEntries)
    for (const order of type?.guideOrders ?? []) {
      expect(typeof order).toBe('number')
      expect(Number.isFinite(order as number)).toBe(true)
    }
    for (const copy of type?.perLanguage ?? []) {
      expect(copy.tabTitle.length, `${copy.language}: tab title`).toBeGreaterThan(0)
      expect(copy.guideTitles[0]?.length, `${copy.language}: guide title`).toBeGreaterThan(0)
      expect(copy.guideDescriptions[0]?.length, `${copy.language}: guide description`).toBeGreaterThan(0)
    }
    // ...and the guide really is translated: one shared string (or a raw key) would
    // reach the user as untranslated text in one of the two languages.
    const [first, second] = type?.perLanguage ?? []
    expect(first?.guideTitles[0]).not.toBe(second?.guideTitles[0])
    expect(first?.tabTitle).not.toBe('type.label')
  })

  it('registers the body under the same identity the guide opens', () => {
    console.log('RAW tab body: ' + JSON.stringify(report.body))
    // The chain the product runs when a guide capsule is picked: it calls
    // `openTab(entry.kind)`, the registry resolves the kind to its definition, and the
    // seat renders the body keyed by that definition's `id`. So the body's seat and
    // key must match the type registered above, or picking the capsule opens an empty
    // pane.
    expect(report.body?.name).toBe('sidebar.right.pane.tab')
    expect(report.body?.key).toBe(report.tabType?.id)
    expect(report.locale?.languages).toEqual(['en', 'zh'])
  })

  it('ships a client.js that is exactly its two sources', () => {
    // `client.js` is generated. This is the check the banner on the file promises:
    // editing it by hand, or changing one of the sources without rebuilding, fails
    // here instead of drifting silently.
    const checked = spawnSync('node', [join(REPO_ROOT, 'scripts', 'build-client.mjs'), '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
    console.log('RAW check:client: ' + JSON.stringify({ status: checked.status, stdout: checked.stdout, stderr: checked.stderr }))
    expect(checked.status).toBe(0)
  })
})
