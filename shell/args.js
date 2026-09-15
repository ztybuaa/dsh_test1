'use strict'

/**
 * Command line surface of the shell.
 *
 * The shell is deliberately dumb: it owns a window, one native view, and a
 * loopback-only programmable endpoint. It never decides *what* to show for the
 * agent side; the URL comes from `--url`, or from a `dsh web` child process
 * started with `--dsh`, or from the built-in fixture site.
 */

/** Window size used when the caller does not care. */
const DEFAULT_WINDOW = { width: 1200, height: 800 }

/** Default view rectangle: the "sidebar slot" on the right edge of the window. */
const DEFAULT_BOUNDS = { x: 760, y: 0, width: 440, height: 800 }

/** How long to wait for the CDP endpoint and for page loads. */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * Parse a `x,y,w,h` rectangle.
 * @param {string} raw - the raw `--bounds` value.
 * @returns {{x: number, y: number, width: number, height: number}} the rectangle.
 */
function parseBounds(raw) {
  const parts = String(raw).split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`--bounds expects "x,y,w,h" with four finite numbers, got: ${raw}`)
  }
  const [x, y, width, height] = parts
  return { x, y, width, height }
}

/**
 * Parse the shell's argv (already stripped of the Electron binary and script).
 * @param {string[]} argv - raw arguments.
 * @returns {object} normalized options.
 */
function parseArgv(argv) {
  const options = {
    windowUrl: undefined,
    viewUrl: undefined,
    useDsh: false,
    bounds: { ...DEFAULT_BOUNDS },
    window: { ...DEFAULT_WINDOW },
    cdpPort: 0,
    userDataDir: undefined,
    show: true,
    dshCommand: 'dsh',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${flag} requires a value`)
      return argv[index]
    }
    switch (flag) {
      case '--url':
        options.windowUrl = value()
        break
      case '--view-url':
        options.viewUrl = value()
        break
      case '--dsh':
        options.useDsh = true
        break
      case '--dsh-command':
        options.dshCommand = value()
        break
      case '--bounds':
        options.bounds = parseBounds(value())
        break
      case '--window-size':
        {
          const rect = parseBounds(value())
          options.window = { width: rect.width, height: rect.height }
        }
        break
      case '--cdp-port':
        options.cdpPort = Number(value())
        if (!Number.isInteger(options.cdpPort) || options.cdpPort < 0) {
          throw new Error(`--cdp-port expects a non-negative integer, got: ${argv[index]}`)
        }
        break
      case '--user-data-dir':
        options.userDataDir = value()
        break
      case '--timeout-ms':
        options.timeoutMs = Number(value())
        break
      case '--no-show':
        options.show = false
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${flag}`)
    }
  }
  return options
}

/**
 * Render the CLI help text.
 * @returns {string} usage text.
 */
function usage() {
  return [
    'Usage: electron shell/main.js [options]',
    '',
    '  --url <url>              URL for the window (DSH UI or any page). Default: built-in fixture /shell',
    '  --view-url <url>         Initial URL for the native browser view. Default: built-in fixture /view',
    '  --dsh                    Start `dsh web --no-open --port 0`, parse its address, load it in the window,',
    '                           and hand the view over to it through DSH_DESKTOP_VIEW_* environment variables',
    '  --dsh-command <cmd>      Executable used by --dsh (default: dsh)',
    '  --bounds x,y,w,h         View rectangle inside the window (default: 760,0,440,800)',
    '  --window-size w,h        Window size (default: 1200,800)',
    '  --cdp-port <n>           Programmable endpoint port; 0 lets the OS choose (default: 0)',
    '  --user-data-dir <dir>    Chromium profile directory (default: <appData>/dsh-desktop-shell)',
    '  --timeout-ms <n>         Startup timeout (default: 30000)',
    '  --no-show                Create the window hidden',
    '  -h, --help               Print this text',
    '',
    'On success the shell prints one line to stdout:',
    '  DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"...","targetId":"...", ...}',
  ].join('\n')
}

module.exports = { parseArgv, parseBounds, usage, DEFAULT_BOUNDS, DEFAULT_WINDOW, DEFAULT_TIMEOUT_MS }
