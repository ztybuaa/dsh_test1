import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { AdoptedViewSession } from '../src/session.ts'
import { desktopViewTools } from '../src/tools.ts'
import { FAKE_DSH, forwardedHostOutput, startShell, type ShellProcess } from './shell-harness.ts'

/**
 * T1 seam test: "the agent navigates a real native browser view and reads it back".
 *
 * Nothing here is simulated. Every assertion runs against a real Electron process
 * with a real `WebContentsView`, reached through the same adoption path the plugin
 * uses in production. If any of it stops being true, this fails loudly.
 */

/** The tool's second argument is unused by `browser_navigate`; a stub is enough. */
const IGNORED_EXEC = undefined as unknown as Parameters<ReturnType<typeof desktopViewTools>[number]['execute']>[1]

describe('T1 seam — the plugin adopts the shell native view', () => {
  let shell: ShellProcess
  let session: AdoptedViewSession

  beforeAll(async () => {
    shell = await startShell()
    session = await AdoptedViewSession.adopt({
      cdpUrl: shell.handshake.cdpUrl,
      targetId: shell.handshake.targetId,
      timeoutMs: 30_000,
    })
  }, 120_000)

  afterAll(async () => {
    if (session !== undefined) await session.close().catch(() => undefined)
    if (shell !== undefined) await shell.stop()
  })

  it('publishes the view by identity, not by URL or by type', () => {
    console.log('RAW handshake: ' + JSON.stringify(shell.handshake))
    expect(shell.handshake.identification).toBe('webContents.fromDevToolsTargetId')
    expect(shell.handshake.targetType).toBe('page')
    // The window's own page is also type "page", so picking the view had to be a choice.
    expect(shell.handshake.pageTargetCount).toBeGreaterThanOrEqual(2)
    expect(shell.handshake.windowTargetId).toBeDefined()
    expect(shell.handshake.windowTargetId).not.toBe(shell.handshake.targetId)
  })

  it('reads the identical target id back through a Playwright page CDP session', async () => {
    const listed = (await (await fetch(`${shell.handshake.cdpUrl}/json/list`)).json()) as Array<{
      id: string
      type: string
      url: string
    }>
    console.log('RAW /json/list page targets: ' + JSON.stringify(listed.filter((t) => t.type === 'page')))

    // A second, independent connection: closing it must not disturb the shell.
    const probeBrowser = await chromium.connectOverCDP(shell.handshake.cdpUrl, { timeout: 30_000 })
    const observed: Array<{ sessionTargetId: string; url: string }> = []
    try {
      for (const context of probeBrowser.contexts()) {
        for (const page of context.pages()) {
          const cdp = await context.newCDPSession(page)
          const { targetInfo } = await cdp.send('Target.getTargetInfo')
          await cdp.detach()
          observed.push({ sessionTargetId: targetInfo?.targetId, url: page.url() })
        }
      }
    } finally {
      await probeBrowser.close()
    }
    console.log('RAW Target.getTargetInfo per Playwright page: ' + JSON.stringify(observed))

    const listedIds = new Set(listed.filter((target) => target.type === 'page').map((target) => target.id))
    expect(observed.length).toBeGreaterThanOrEqual(2)
    for (const entry of observed) {
      // Byte-for-byte equality with what /json/list published.
      expect(listedIds.has(entry.sessionTargetId)).toBe(true)
    }
    const viewEntry = observed.find((entry) => entry.url === shell.handshake.viewUrl)
    expect(viewEntry, 'the view page should be among the Playwright pages').toBeDefined()
    expect(viewEntry?.sessionTargetId).toBe(shell.handshake.targetId)
    // Closing that extra connection left the shell running.
    expect(shell.alive()).toBe(true)
  })

  it('adopts exactly the published view and nothing else', () => {
    expect(session.targetId).toBe(shell.handshake.targetId)
    expect(session.url()).toBe(shell.handshake.viewUrl)
  })

  it('navigates the native view', async () => {
    const target = `${shell.handshake.fixtureOrigin}/other`
    const result = await session.goto(target)
    console.log('RAW goto result: ' + JSON.stringify(result))
    expect(result.url).toBe(target)
    expect(result.title).toBe('other-page')
    expect(session.url()).toBe(target)
  })

  it('reads DOM content out of the navigated view', async () => {
    const heading = await session.textOf('#heading')
    const output = await session.textOf('#out')
    console.log('RAW DOM read: ' + JSON.stringify({ heading, output }))
    expect(heading).toBe('other-page')
    expect(output).toBe('initial-other')
    expect(await session.title()).toBe('other-page')
  })

  it('clicks in the view and observes the DOM change', async () => {
    const before = await session.textOf('#out')
    await session.click('#hit')
    const after = await session.textOf('#out')
    console.log('RAW click: ' + JSON.stringify({ before, after }))
    expect(before).toBe('initial-other')
    expect(after).toBe('clicked-other')
  })

  it('drives the same view through the browser_navigate tool', async () => {
    const tool = desktopViewTools(() => Promise.resolve(session))[0]
    expect(tool?.name).toBe('browser_navigate')
    const target = `${shell.handshake.fixtureOrigin}/view`
    const value = (await tool?.execute({ url: target }, IGNORED_EXEC)) as
      | { title: string; url: string }
      | undefined
    console.log('RAW tool result: ' + JSON.stringify(value))
    expect(value).toEqual({ title: 'view-page', url: target })
    // The tool moved the very same native view, not a page of its own.
    expect(session.url()).toBe(target)
    expect(await session.textOf('#out')).toBe('initial-view')
  })

  it('disconnects without killing the shell or its view', async () => {
    await session.close()
    expect(shell.alive()).toBe(true)
    const listed = (await (await fetch(`${shell.handshake.cdpUrl}/json/list`)).json()) as Array<{ id: string }>
    console.log('RAW /json/list ids after close: ' + JSON.stringify(listed.map((target) => target.id)))
    expect(listed.map((target) => target.id)).toContain(shell.handshake.targetId)
  })
})

describe('--dsh — the shell hands the view to the child it launches', () => {
  it('passes DSH_DESKTOP_VIEW_* to the child and loads the address the child prints', async () => {
    const shell = await startShell(['--dsh', '--dsh-command', `node ${FAKE_DSH}`])
    try {
      await shell.waitFor(
        (out) => /^DSH_SHELL DSH_URL /m.test(out),
        'the shell to load the address printed by its child',
        60_000,
      )
      const forwarded = forwardedHostOutput(shell.stdout()).join('')
      console.log('RAW child output: ' + JSON.stringify(forwarded))
      const match = /FAKE_DSH_HANDSHAKE (\{.*\})/.exec(forwarded)
      expect(match, 'the child should report the environment it received').not.toBeNull()
      const received = JSON.parse(match?.[1] ?? '{}') as {
        cdpUrl?: string
        targetId?: string
        viewUrl?: string
        argv?: string[]
      }
      expect(received.cdpUrl).toBe(shell.handshake.cdpUrl)
      expect(received.targetId).toBe(shell.handshake.targetId)
      expect(received.viewUrl).toBe(shell.handshake.viewUrl)
      // `dsh web` is a hardcoded alias of `--profile web`, and this plugin is not
      // installed there: the child must be started on the plugin's own profile, named
      // explicitly. The fake DSH is what makes this assertable at all (`argv` is the
      // real argv the child received), and it pins the *shape*, not a spelling.
      expect(received.argv).toEqual(['--profile', 'dshviewer', '--no-open', '--port', '0'])
      // ...and the shell publishes the argv it used, so a wrong profile is visible in
      // the shell's own output instead of only in the child's behaviour.
      const published = /^DSH_SHELL DSH_ARGV (.*)$/m.exec(shell.stdout())
      expect(JSON.parse(published?.[1] ?? '{}')).toEqual({
        command: `node ${FAKE_DSH}`,
        argv: ['--profile', 'dshviewer', '--no-open', '--port', '0'],
      })

      const loaded = /^DSH_SHELL DSH_URL (.*)$/m.exec(shell.stdout())
      expect(JSON.parse(loaded?.[1] ?? '{}')).toEqual({ url: `${shell.handshake.fixtureOrigin}/shell` })
    } finally {
      await shell.stop()
    }
  }, 120_000)

  it('starts the child on the profile the caller asked for', async () => {
    // The profile is a parameter, not a constant: pointing the shell at a different
    // profile must not need a code change. "demo-profile" does not exist anywhere; it
    // only has to reach the child's argv.
    const shell = await startShell(['--dsh', '--dsh-profile', 'demo-profile', '--dsh-command', `node ${FAKE_DSH}`])
    try {
      await shell.waitFor(
        (out) => /^DSH_SHELL DSH_URL /m.test(out),
        'the shell to load the address printed by its child',
        60_000,
      )
      const forwarded = forwardedHostOutput(shell.stdout()).join('')
      const received = JSON.parse(/FAKE_DSH_HANDSHAKE (\{.*\})/.exec(forwarded)?.[1] ?? '{}') as { argv?: string[] }
      console.log('RAW child argv with --dsh-profile: ' + JSON.stringify(received.argv))
      expect(received.argv).toEqual(['--profile', 'demo-profile', '--no-open', '--port', '0'])
    } finally {
      await shell.stop()
    }
  }, 120_000)
})
