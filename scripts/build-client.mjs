// Build (or verify) the shipped client half of the plugin.
//
// The published `client.js` must be ONE self-contained file: DSH's web loader
// fetches a single script per plugin, materializes it lazily through
// `window.__ModuleLoader__.load`, and inside the factory `require()` only reaches
// the platform's own modules. There is no bundler in the published artifact.
//
// But the panel's measurement must not be a copy of `shell/panel-rect.js` either:
// the automated evidence exercises that file through the fixture panel, and a copy
// would make that evidence about a different implementation. So this script splices
// the two together.
//
//   node scripts/build-client.mjs            write client.js
//   node scripts/build-client.mjs --check    fail if client.js is not up to date
//
// `npm run build` runs the write form, so the two sources and the artifact cannot
// drift apart unnoticed.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const checkOnly = process.argv.includes('--check')

/** Read a file that must exist; a missing one is a repository error, not a fallback case. */
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8')

/** The source of truth for panel measurement, shared with the shell's fixture site. */
const PANEL_RECT = read(join('shell', 'panel-rect.js'))
/** The registration body (tab type + body + panel). */
const CLIENT_BODY = read(join('src', 'client-body.js'))

/**
 * Re-indent a spliced file so the generated bundle reads as one unit.
 * @param {string} source - file contents.
 * @returns {string} contents with one leading tab on every line.
 */
const indent = (source) =>
  source
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line === '' ? '' : `\t${line}`))
    .join('\n')

const banner = `// GENERATED FILE — do not edit.
//
// Built by \`node scripts/build-client.mjs\` from:
//   shell/panel-rect.js  (panel measurement, shared with the shell's fixture panel)
//   src/client-body.js   (tab type, tab body, panel component)
//
// Editing this file directly will be caught by tests/client-half.spec.ts; edit the
// sources above and regenerate instead.
`

const bundle = `${banner}
window.__ModuleLoader__.load({
	id: 'dsh-desktop-view',
	factory: (require) => {
		var exports = {}
		var module = { exports }

		//#region shell/panel-rect.js — spliced verbatim, fenced in a module scope of its own
		//
		// The fence is load-bearing. This file is a UMD module, and its wrapper ends with
		// \`module.exports = api\`: spliced bare into this factory, that reassignment *is*
		// what the host's loader receives — an object with no \`apply\` — and the host
		// answers "invalid plugin, expect function or object with an apply method,
		// received object", i.e. a plugin that silently never registers its tab.
		// Giving the splice a throwaway \`module\` keeps that assignment harmless while the
		// file still installs \`globalThis.DshPanelRect\`, which is all the panel needs.
		;(function (module) {
${indent(indent(PANEL_RECT))}
		})({ exports: {} })
		//#endregion

		//#region src/client-body.js — spliced verbatim
${indent(CLIENT_BODY)}
		//#endregion

		// The host's loader wants an object with an \`apply\` method, and says only
		// "invalid plugin ... received object" when it does not get one. Checking the
		// contract here names the failure where it happens instead of leaving a plugin
		// that loads, registers nothing, and reports nothing.
		if (typeof module.exports.apply !== 'function') {
			throw new Error(
				'dsh-desktop-view: the generated client half exported no apply(); ' +
					'regenerate it with scripts/build-client.mjs',
			)
		}
		return module.exports
	},
})
`

const target = join(repoRoot, 'client.js')

if (checkOnly) {
  let current
  try {
    current = read('client.js')
  } catch {
    process.stderr.write('client.js is missing; run `node scripts/build-client.mjs`\n')
    process.exit(1)
  }
  if (current !== bundle) {
    process.stderr.write(
      'client.js is stale: it does not match shell/panel-rect.js + src/client-body.js.\n' +
        'Run `node scripts/build-client.mjs` and commit the result.\n',
    )
    process.exit(1)
  }
  process.stdout.write('client.js is up to date\n')
} else {
  writeFileSync(target, bundle)
  process.stdout.write(
    `wrote ${relative(process.cwd(), target)} (${bundle.length} bytes) from ` +
      `shell/panel-rect.js + src/client-body.js\n`,
  )
}
