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
 * DSH profile holding this plugin, used by `--dsh`.
 *
 * Spelled out rather than relying on `dsh web`, which is a hardcoded alias of
 * `--profile web` — a profile this plugin is not installed in.
 */
const DEFAULT_DSH_PROFILE = 'dshviewer'

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
    proxy: undefined,
    show: true,
    dshCommand: 'dsh',
    dshProfile: DEFAULT_DSH_PROFILE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rectChannel: true,
    placementFile: undefined,
    faultCdpList: 0,
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
      case '--dsh-profile':
        options.dshProfile = value()
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
      case '--proxy':
        options.proxy = value()
        break
      case '--timeout-ms':
        options.timeoutMs = Number(value())
        break
      case '--placement-file':
        options.placementFile = value()
        break
      case '--fault-cdp-list':
        // 测试缝（见 usage 与 docs/research/space-table-target-id-gap.md）：让处理空间请求期间的
        // 前 n 次 `GET /json/list` 失败，用来确定性复现"回环端点那一刻读不回来"。
        options.faultCdpList = Number(value())
        if (!Number.isInteger(options.faultCdpList) || options.faultCdpList < 0) {
          throw new Error(`--fault-cdp-list expects a non-negative integer, got: ${argv[index]}`)
        }
        break
      case '--no-rect-channel':
        options.rectChannel = false
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
    '  --dsh                    Start `dsh --profile <profile> --no-open --port 0`, parse its address, load it in',
    '                           the window, and hand the view over to it through DSH_DESKTOP_VIEW_* variables',
    '  --dsh-command <cmd>      Executable used by --dsh (default: dsh)',
    "  --dsh-profile <name>     DSH profile used by --dsh (default: dshviewer)",
    '                           (never `dsh web`: that is a hardcoded alias of --profile web)',
    '  --bounds x,y,w,h         View rectangle inside the window (default: 760,0,440,800)',
    '  --window-size x,y,w,h    Window size; only w and h are used (default: 1200,800)',
    '                           (e.g. --window-size 0,0,1200,800)',
    '  --cdp-port <n>           Programmable endpoint port; 0 lets the OS choose (default: 0)',
    '  --user-data-dir <dir>    Chromium profile directory (default: <appData>/dsh-desktop-shell)',
    '  --proxy <rules>          Proxy for the view only, e.g. 127.0.0.1:7897 (proxyRules syntax)',
    '                           Default: nothing is set, so the view inherits the system proxy',
    '                           Loopback is never bypassed explicitly: Chromium already leaves',
    '                           127.0.0.1 / localhost / [::1] out of any proxy it is given',
    '  --timeout-ms <n>         Startup timeout (default: 30000)',
    '  --placement-file <file>  Mirror the latest view placement into this JSON file',
    '  --fault-cdp-list <n>     TEST SEAM: make the next n `GET /json/list` calls fail *while a space',
    '                           request is being handled*, so the suite can reproduce the moment the',
    '                           loopback endpoint cannot be listed (default: 0 = never). Every injected',
    '                           failure prints DSH_SHELL CDP_LIST_FAULT, so it can never be silent.',
    '                           The startup listing is never faulted: the shell could not start at all.',
    '  --no-rect-channel        Do not inject the panel rectangle channel into the window',
    '  --no-show                Create the window hidden',
    '  -h, --help               Print this text',
    '',
    'On success the shell prints one line to stdout:',
    '  DSH_DESKTOP_VIEW_HANDSHAKE {"cdpUrl":"...","targetId":"...", ...}',
    "                           `browserIdentity` is the view's own identity, read back from",
    '                           Electron: its persistent partition, that partition directory,',
    '                           the user agent it really sends, and whether the automation',
    '                           switch is on.',
    '                           `spaceChannel` is where task spaces are managed, and `spaces`',
    '                           is the space table at startup (name, partition, storage path and',
    '                           CDP target id of each), every value read back from Electron.',
    '',
    'Task spaces: a space is a view on its own persistent partition. The plugin writes what it',
    'wants into <spaceChannel.dir>/request.json and the shell answers into state.json, so the',
    'shell stays the only thing that creates a view (Playwright cannot: ADR-0002) and no port is',
    'opened (ADR-0003). Closing a space releases its page and erases its storage data; its',
    'directory is removed at the next startup, because Windows holds it while this process lives.',
    '',
    'It also prints what the view session resolves for a foreign site and for loopback:',
    '  DSH_SHELL PROXY {"partition":"persist:dsh-view","readings":{"external":{"url":...,"result":...}, ...}}',
    '',
    'Every space table change prints one line to stdout, and the same record is written to the',
    'state file the plugin reads:',
    '  DSH_SHELL SPACES {"protocol":1,"requestId":1,"error":null,"active":"default",',
    '                    "spaces":[{"name":"default","storagePath":"...","targetId":"...", ...}]}',
    "                           `targetId` carries `targetIdSource` (resolved | remembered |",
    '                           unavailable) and, when it is not resolved, a `targetIdReason`: a',
    "                           listing that could not be read never erases an id the shell knows.",
    '                           `requestId` is how far this shell has processed the plugin\'s',
    '                           requests, which is what makes a tool call deterministic.',
    '',
    'Each partition whose directory was removed at startup prints one line:',
    '  DSH_SHELL SPACE_PURGE {"partition":"persist:dsh-view-space-task-1","dir":"...","removed":true}',
    '',
    'Every placement change prints one line to stdout:',
    '  DSH_SHELL VIEW {"cause":"panel-report","visible":true,"bounds":{...},',
    '                  "applied":{...},"appliedVisible":true,"reason":"reported"}',
    '                           `cause` is what asked for the placement (panel-report,',
    '                           panel-none, window-resize, navigation, initial-bounds);',
    '                           `reason` is why the decision came out that way.',
  ].join('\n')
}

module.exports = { parseArgv, parseBounds, usage, DEFAULT_BOUNDS, DEFAULT_DSH_PROFILE, DEFAULT_WINDOW, DEFAULT_TIMEOUT_MS }
