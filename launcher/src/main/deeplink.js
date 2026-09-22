// `enw-zombies://` — one click on the web turning into one launcher, on the right page.
//
// The web lane is building the *sending* side against exactly the two routes below, so
// the string forms here are a contract, not a convenience, and they are written down in
// `docs/protocol/launcher-v0.md` §7. Anything not in the table opens the launcher on
// home; nothing in this file may throw, because every one of these strings arrives from
// outside the launcher — a web page, a Discord message, a shortcut somebody typed — and
// a malformed one must open a working launcher, not a crash report.
//
//   enw-zombies://map/<key>     select <key> in the map browser, ready for Play / Start
//   enw-zombies://party/<id>    open on that party (join it if the player is invited)
//   anything else               home
//
// MEASURED, node 24, `new URL('enw-zombies://map/nazi_zombie_prototype')`:
//   protocol 'enw-zombies:'   hostname 'map'   pathname '/nazi_zombie_prototype'
// A non-special scheme still parses its authority, so the first segment lands in
// `hostname` and NOT in `pathname` — the naive `pathname.split('/')` reading of this URL
// returns the map key at index 0 and the route nowhere, which is how a route table like
// this usually ends up silently matching nothing. Also MEASURED: a non-special scheme's
// host is **not** lower-cased by the parser (`enw-zombies://MAP/x` keeps `MAP`), so the
// route is lower-cased here by hand.
//
// The older `enwzombies://m/<map>` scheme (config.protocol) is untouched and still
// parsed by main.js; this is a second, hyphenated scheme, because the hyphenated one is
// what the site is about to publish and both can be registered at once.

import path from 'node:path'

export const SCHEME = 'enw-zombies'

const PREFIX = new RegExp(`^${SCHEME}:`, 'i')

// Returns null when `raw` is not one of ours at all — that is how main.js knows to fall
// through to the legacy scheme and to the https:// deep links rather than treating a
// perfectly good link as a malformed one.
//
// Otherwise always an object, always with `kind`:
//   { kind:'map',   map:'<key>',  url }
//   { kind:'party', party:'<id>', url }
//   { kind:'home',  why:'…',      url }   ← and `why` is logged, so a route that the
//                                           site sends and we drop is visible in
//                                           launcher.log rather than being a shrug.
export function parse(raw) {
  if (!raw || typeof raw !== 'string' || !PREFIX.test(raw.trim())) return null
  const url = raw.trim()
  let u
  try { u = new URL(url) } catch (e) { return { kind: 'home', why: `not a URL (${e.message})`, url } }

  const route = String(u.hostname || '').toLowerCase()
  // `//map/<key>` puts the key in the path; the opaque form `enw-zombies:map/<key>`
  // (no slashes — some chat clients rewrite links into it) puts everything in the path.
  // Reading both the same way costs one line and removes a whole class of "it worked in
  // the browser and not in Discord".
  const segs = (route ? u.pathname : `/${u.pathname}`).split('/').filter(Boolean).map(decodeSafe)
  const opaque = route ? [route, ...segs] : segs
  const head = String(opaque[0] || '').toLowerCase()
  const arg = opaque[1] || null

  if (head === 'map') {
    if (!arg) return { kind: 'home', why: 'a map link with no map key', url }
    return { kind: 'map', map: arg, url }
  }
  if (head === 'party') {
    if (!arg) return { kind: 'home', why: 'a party link with no party id', url }
    return { kind: 'party', party: arg, url }
  }
  if (!head) return { kind: 'home', why: 'no route in the link', url }
  return { kind: 'home', why: `unknown route "${head}"`, url }
}

function decodeSafe(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

// Windows hands the URL to the app as a plain argv entry, and it is NOT always the last
// one: electron-builder's NSIS stub and `start` both append their own switches on some
// machines. So the argv is searched, not indexed.
export function fromArgv(argv = []) {
  for (const a of argv) if (typeof a === 'string' && PREFIX.test(a.trim())) return a.trim()
  return null
}

// The single-instance half, as a function over fakes so it can be tested without an
// Electron run.
//
// The failure this prevents is worth stating: without the lock, clicking a second link
// starts a SECOND launcher, which then fights the first one for `game.lock`, for the
// game-link port and for the update lane. The second process must hand its argument over
// and die. `onLink` is the primary's handler; `onFocus` raises its window, which is the
// whole of what a link with no route should do.
export function makeSecondInstance({ onLink = () => {}, onFocus = () => {}, log = () => {} } = {}) {
  return (argv = []) => {
    const url = fromArgv(argv)
    if (!url) {
      log('a second launcher started with no link; focusing the one already running')
      onFocus()
      return { forwarded: false, url: null, route: null }
    }
    const route = parse(url)
    log('a second launcher forwarded', url, '->', route?.kind || 'nothing')
    onFocus()
    onLink(url)
    return { forwarded: true, url, route }
  }
}

// Registration. `process.defaultApp` is true in a dev checkout (`electron .`), where the
// OS must be told to run electron.exe WITH the script path or the callback launches a
// bare Electron with no app in it. Never throws: a launcher that will not start because
// it could not claim a URL scheme is a worse failure than a link that does nothing.
export function register(app, { argv = process.argv, execPath = process.execPath, isDev = !!process.defaultApp, log = () => {} } = {}) {
  try {
    const ok = isDev && argv.length >= 2
      ? app.setAsDefaultProtocolClient(SCHEME, execPath, [resolveish(argv[1])])
      : app.setAsDefaultProtocolClient(SCHEME)
    log(`registered ${SCHEME}:// ->`, ok ? 'this launcher' : 'refused by the OS (another app may own it)')
    return !!ok
  } catch (e) {
    log(`could not register ${SCHEME}:// —`, e?.message || String(e))
    return false
  }
}

function resolveish(p) {
  try { return path.resolve(p) } catch { return p }
}
