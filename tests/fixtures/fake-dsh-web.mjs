// Stand-in for `dsh web --no-open --port 0`.
//
// It exists to prove two things the real DSH install is not needed for:
//   1. the shell hands the view identity to the child it launches through the
//      environment (DSH_DESKTOP_VIEW_CDP / _TARGET / _URL), and
//   2. the shell parses the address that child prints on stdout and loads it.
//
// It reports what it received on stdout, then answers with an address derived
// from the fixture origin the shell already told it about.

const viewUrl = process.env.DSH_DESKTOP_VIEW_URL
const handshake = {
  cdpUrl: process.env.DSH_DESKTOP_VIEW_CDP,
  targetId: process.env.DSH_DESKTOP_VIEW_TARGET,
  viewUrl,
  argv: process.argv.slice(2),
}

process.stdout.write(`FAKE_DSH_HANDSHAKE ${JSON.stringify(handshake)}\n`)

let origin = 'http://127.0.0.1:1'
if (typeof viewUrl === 'string' && viewUrl !== '') origin = new URL(viewUrl).origin
process.stdout.write(`dsh web: ${origin}/shell\n`)

process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
