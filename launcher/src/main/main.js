// The ENW Zombies launcher.
//
// Shape (spec 13 §2 / 99 §4.3):
//   * an Electron app that LOOKS LIKE THE LOGGED-IN SITE, because it wraps the live
//     site rather than reimplementing it;
//   * the chrome around it is ours, and it is now ONLY what a native app can do: a
//     topbar, the first-run/setup screens, settings, and a full-window boot screen.
//     The right-hand rail is GONE (2026-09-22) - see shell.js for why;
//   * window + tray — closing the window minimises, quit from the tray;
//   * deep links: zombies.enw.gg/m/<map> and enwzombies://m/<map>;
//   * NO OVERLAY, EVER. B was emphatic. The site lives in a native WebContentsView and
//     our chrome sits BESIDE it, never on top of the game. When the boot screen or
//     first-run wizard needs the whole window, the site view is hidden, not covered.
import { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, shell, dialog, nativeImage, session as electronSession } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { P, ensureDirs } from './paths.js'
import * as cfg from './config.js'
import * as detect from './detect.js'
import * as setup from './setup.js'
import * as settings from './settings.js'
import { useScreen, listDisplays, cacheDisplays } from './display.js'
import { MODES } from './gamecfg.js'
import * as crash from './crash.js'
import * as lock from './gamelock.js'
import { Updater, IdleGate, applyPending, pending } from './updates.js'
import { BootFlow } from './bootflow.js'
import * as library from './library.js'
import { SiteApi, PlayWatcher, electronCookieProvider } from './siteapi.js'
import * as partyprogress from './partyprogress.js'
import { AutoUpdater, resolveFeed } from './autoupdate.js'
import { UpdateCheck } from './updatecheck.js'
import * as deeplink from './deeplink.js'
import { makeWindowRaiser } from './focusguard.js'
import { hostAgent } from './hostagent.js'
import { LocalRun } from './localrun.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(HERE, '..', 'renderer')
// .cjs, not .js: Electron decides a preload's module type by extension, and this app
// is "type": "module". An ambiguous preload fails at load with nothing useful in it.
const PRELOAD = path.resolve(HERE, '..', 'preload', 'preload.cjs')
const TOPBAR_HEIGHT = 44

// ---------------------------------------------------------------------------
// WINDOW SIZE IS A LAYOUT DECISION, AND IT WAS THE WRONG ONE
// ---------------------------------------------------------------------------
// `RAIL_WIDTH = 320` used to come off the site view's width. The site's home is
// `grid-template-columns: var(--rail-w) minmax(0, 1fr)` and `theme.css` folds it into a
// SINGLE column at `max-width: 1080px`. The default window was 1400 wide, so the site got
// 1400 - 320 = **1080**: exactly the breakpoint, on the wrong side of it. The left column
// B asked for - party, map list, Start, Verified/Custom - therefore never appeared in the
// launcher, and appeared in any browser of the same size. At the old 1000 px minimum it
// was 680 and hopeless.
//
// So the rail is gone and the numbers below are derived from that breakpoint rather than
// picked: the minimum is the first width at which the site's home is two columns with room
// to spare, and the default leaves the map page a comfortable column beside it. (There is
// no Movement launcher to copy: Movement is a web client, and its layout IS this
// breakpoint.)
const MIN_WIDTH = 1180          // > the site's 1080px single-column fold, with 100px of slack
const MIN_HEIGHT = 700
const DEFAULT_WIDTH = 1500
const DEFAULT_HEIGHT = 940      // fits a 1080p desktop with its taskbar

const state = {
  win: null,
  siteView: null,
  tray: null,
  siteInfo: null,
  flow: null,
  quitting: false,
  gate: new IdleGate(),
  pendingDeepLink: null,
  lastError: null,
  // The player-driven "Check for updates" lane (updatecheck.js). Separate from
  // `state.updater`, which is the silent one that checks on launch and applies on quit.
  updateCheck: null,
  localRun: null,
  lastLocalResult: null,
  // The loopback listener while a browser sign-in is in flight, so a second press does
  // not bind a second port.
  signIn: null,
  // The site's own view of this player's party/map/match, refreshed by the party
  // watcher. It is what decides whether a map install is a party's business (and so
  // whether progress is reported at all) and when somebody else's Start becomes our
  // launch.
  lastPlay: null,
  playWatcher: null,
  installs: new Map(),   // bsp -> the in-flight install, so two callers share one
}

// ------------------------------------------------------------------- logging --

// `ensureDirs()` can itself fail (a read-only profile, a redirected LOCALAPPDATA), and
// when it does every later write fails too. It must not take the app with it.
let dirsError = null
try { ensureDirs() } catch (e) { dirsError = e.message }

const LOG = path.join(P.logs, 'launcher.log')
// WHY THIS IS NOT JUST `appendFileSync` IN A TRY/CATCH ANY MORE.
//
// It was, and it cost us a whole diagnosis. B's packaged launcher wrote NOTHING to
// `launcher.log` for fifteen minutes while it was plainly running, and the silence read
// as "logging broke" -- it was `appendFileSync` throwing into an empty `catch` because
// the folder was not the one we thought. A logger that cannot say it failed is worse
// than no logger: it makes every later diagnosis an argument about missing evidence.
//
// So: remember whether the last write landed, and expose it in `status()` so the UI and
// the smoke script can both see "the log you are reading is not the log this process is
// writing".
const logState = { file: LOG, writable: null, error: null, lines: 0 }
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
  try {
    fs.appendFileSync(LOG, line + '\n')
    logState.writable = true
    logState.error = null
    logState.lines++
  } catch (e) {
    logState.writable = false
    logState.error = e.message
  }
  console.log(line)
}

const setupInstalledSafe = () => { try { return !!setup.status().installed } catch { return false } }

// Raising our own window is only ever safe when no game is running: see focusguard.js.
// `state.flow` is truthy exactly while a launch/game is in flight, so it IS the
// game-running flag.
const raiser = makeWindowRaiser({
  win: () => state.win,
  busy: () => !!state.flow,
  log: (line) => log('focus', line),
})
const raiseWindow = (why) => raiser.raise(why)

// Anything unhandled is a crash report and a short plain message. Never a stack trace
// in the player's face.
function wireCrashReporting() {
  const send = async (kind, error, context) => {
    state.lastError = { kind, message: error?.message || String(error) }
    log('crash', kind, error?.message || error)
    const payload = crash.build({
      kind, error, context: { ...context, appVersion: app.getVersion() },
      logs: [LOG, path.join(P.home, 'main', 'console.log')],
    })
    const r = await crash.report(cfg.load().crashEndpoint, payload)
    push('toast', { kind: 'error', text: crash.playerMessage(kind), quiet: true })
    log('crash report', r.sent ? 'sent' : `kept on disk (${r.reason})`)
  }
  process.on('uncaughtException', (e) => send('launcher_error', e, { where: 'main' }))
  process.on('unhandledRejection', (e) => send('launcher_error', e instanceof Error ? e : new Error(String(e)), { where: 'promise' }))
  return send
}
const reportCrash = wireCrashReporting()


// ------------------------------------------------------- the closed-beta password --

// One shared password in front of the whole site (web/server/middleware/gate.js).
// Electron raises `login` on a 401 challenge, for the wrapped page and for anything
// else in that session; we answer it from config, and ask the player once if we have
// nothing. The answer is remembered so they type it once ever, not once per launch.
//
// It is a front door, not an identity: it does not identify anybody and it is not
// their account password, which the prompt says out loud so nobody types the wrong one.
async function askForPassword({ site, retry = false }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: retry ? 340 : 312,
      parent: state.win || undefined,
      modal: !!state.win,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'ENW Zombies',
      backgroundColor: '#12130e',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
    })
    let done = false
    const finish = async (value) => {
      if (done) return
      done = true
      try { win.destroy() } catch {}
      resolve(value)
    }
    // The prompt hands its answer back through the document title, which needs no
    // preload and no IPC surface for a window that only ever collects one string.
    win.webContents.on('page-title-updated', async (e, title) => {
      e.preventDefault()
      if (title === 'enw:ok') {
        const pw = await win.webContents.executeJavaScript('window.enwPassword').catch(() => null)
        finish(pw)
      } else if (title === 'enw:cancel') finish(null)
    })
    win.on('closed', () => finish(null))
    const url = `file://${path.join(RENDERER, 'password.html').split(path.sep).join('/')}` +
      `?site=${encodeURIComponent(site)}&retry=${retry ? 1 : 0}`
    win.loadURL(url)
  })
}

// Answers 401 challenges for the whole app. `attempts` stops a wrong password looping
// forever: the second challenge for the same host re-prompts and says it was rejected,
// and giving up leaves the page showing the site's own 401 rather than hanging.
function wireSitePassword() {
  const attempts = new Map()
  app.on('login', async (event, webContents, details, authInfo, callback) => {
    // Proxy authentication is somebody's corporate network, not our beta gate.
    if (authInfo?.isProxy) return
    const host = `${authInfo.host || ''}:${authInfo.port || ''}`
    event.preventDefault()

    const conf = cfg.load()
    const tries = attempts.get(host) || 0
    let pw = tries === 0 ? conf.sitePassword : null

    if (!pw) {
      const site = state.siteInfo?.url || `https://${authInfo.host || 'the site'}`
      pw = await askForPassword({ site, retry: tries > 0 })
      if (!pw) {
        attempts.set(host, 0)
        log('site password: the player cancelled')
        push('toast', { kind: 'error', text: 'ENW Zombies needs the beta password. Open Settings to enter it.' })
        return callback()
      }
      cfg.save({ sitePassword: pw })
      log('site password: stored for', host)
    }

    attempts.set(host, tries + 1)
    // Any username; the gate only reads what is after the colon.
    callback('enw', pw)
  })
}

// ---------------------------------------------------------------- the window --

function layout() {
  if (!state.win || !state.siteView) return
  const [w, h] = state.win.getContentSize()
  // Edge to edge. The site's own left column is the only column now.
  state.siteView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width: Math.max(0, w), height: Math.max(0, h - TOPBAR_HEIGHT) })
}

// The site is hidden, never covered: an overlay over a native view is exactly the
// thing B said no to, and it also does not work reliably.
function showSite(visible) {
  if (!state.siteView) return
  state.siteView.setVisible(visible)
  if (visible) layout()
}

async function createWindow() {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#12130e',
    autoHideMenuBar: true,
    title: 'ENW Zombies',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  state.win = win
  // Anything the chrome logs -- including CSP violations, which are how a blocked
  // inline style shows up -- goes in the launcher log instead of nowhere.
  state.consoleMessages = []
  win.webContents.on('console-message', (e) => {
    const line = `[shell] ${e.message} (${e.sourceId}:${e.lineNumber})`
    state.consoleMessages.push(line)
    if (e.level === 'error' || e.level === 'warning' || /Content Security Policy/i.test(e.message)) log(line)
  })
  await win.loadFile(path.join(RENDERER, 'shell.html'))

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: PRELOAD, sandbox: false },
  })
  state.siteView = view
  win.contentView.addChildView(view)
  layout()
  win.on('resize', layout)

  // web asked how to tell "this is the launcher" server-side. This: every request the
  // wrapped page makes carries the header, navigations included, so a server-rendered
  // decision (the Play Local button, say) does not have to wait for client JS to sniff
  // `window.enw`. Both signals exist; this is the one that works before first paint.
  view.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, 'X-ENW-Launcher': app.getVersion() } })
  })

  // The wrapped site may not be ours (a placeholder, a dashboard). Treat every page in
  // it as untrusted: no new windows, external links go to the real browser.
  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  wc.on('will-navigate', (e, url) => {
    const u = new URL(url)
    const allowed = ['127.0.0.1', 'localhost', ...cfg.load().deepLinkHosts]
    if (!allowed.includes(u.hostname) && u.protocol !== 'file:') { e.preventDefault(); shell.openExternal(url) }
  })
  wc.on('did-finish-load', () => push('site', { loaded: true, url: wc.getURL() }))
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return
    push('site', { loaded: false, url, error: `${desc} (${code})` })
  })

  state.siteInfo = await cfg.resolveSiteUrl()
  log('site', state.siteInfo.url, state.siteInfo.what)
  await wc.loadURL(state.siteInfo.url).catch((e) => log('site load failed', e.message))

  await connectSiteApi()

  win.once('ready-to-show', () => win.show())
  win.show()

  // Closing minimises to the tray so invites and "lobby ready" still reach the player
  // (spec 13 §2). Quit is a deliberate act, from the tray.
  win.on('close', (e) => {
    if (state.quitting || !cfg.load().minimiseToTray) return
    e.preventDefault()
    win.hide()
    push('toast', { kind: 'info', text: 'ENW Zombies is still running in the tray.' })
  })

  return win
}

function createTray() {
  const iconPath = path.join(RENDERER, 'assets', 'tray.png')
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  const tray = new Tray(img)
  tray.setToolTip('ENW Zombies')
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open ENW Zombies', click: () => { state.win?.show(); state.win?.focus() } },
      { type: 'separator' },
      { label: state.flow ? 'Cancel the current launch' : 'Not in a game', enabled: !!state.flow, click: () => state.flow?.cancel('cancelled from the tray') },
      { type: 'separator' },
      { label: 'Quit', click: () => { state.quitting = true; app.quit() } },
    ]))
  }
  rebuild()
  tray.on('click', () => { state.win?.isVisible() ? state.win.hide() : (state.win?.show(), state.win?.focus()) })
  state.tray = { tray, rebuild }
  return tray
}

function push(channel, payload) {
  try { state.win?.webContents.send(`enw:${channel}`, payload) } catch {}
}

// ------------------------------------------------------- the update check --

// Built on first press, not at startup, and for one measured reason: the feed URL is
// derived from the site (`resolveFeed`), and at `whenReady` the site has often not
// resolved yet — a check built then would carry `feed: null` for the whole session and
// tell the player "no update server is configured" on a machine that has one. Built at
// the moment of the press, it uses whatever the launcher knows by then.
//
// Progress reaches the renderer by PUSH, on the existing `enw:` event channel. The
// alternative — the Settings page polling `updateStatus` — would mean a percentage that
// moves in steps and a poll that keeps running after the page is closed.
function updateCheck() {
  if (state.updateCheck) return state.updateCheck
  state.updateCheck = new UpdateCheck({
    feedUrl: resolveFeed({ config: cfg.load(), siteUrl: state.siteInfo?.url }),
    currentVersion: app.getVersion(),
    // The same closed-beta password the player already typed to see the site, for the
    // same reason autoupdate.js sends it: the feed is behind the gate, and a 401 there
    // surfaces as `net::ERR_ABORTED`, which reads as a broken launcher. Never logged.
    authHeader: cfg.load().sitePassword
      ? 'Basic ' + Buffer.from(`beta:${cfg.load().sitePassword}`).toString('base64')
      : null,
    // `process.defaultApp` is Electron's own "we are running from a checkout" flag, and
    // it is what electron-updater itself keys off when it refuses to run.
    isDev: !!process.defaultApp || !app.isPackaged,
    log: (...a) => log('update', ...a),
  })
  state.updateCheck.on('status', (s) => push('update_status', s))
  return state.updateCheck
}

// ----------------------------------------------------------------- deep links --

// THREE FORMS REACH THIS FUNCTION, and only the first is a contract with the web lane:
//
//   enw-zombies://map/<key>   enw-zombies://party/<id>     deeplink.js, protocol v0 §7
//   enwzombies://m/<map>      enwzombies://play/<map>      the older, unhyphenated one
//   https://zombies.enw.gg/m/<map>                         a plain web link we own
//
// The new scheme is tried first and answers for EVERY `enw-zombies:` string, including
// the malformed ones (it returns `{kind:'home', why}` rather than null), so nothing that
// starts with our scheme can fall through to the legacy reader and be misread there.
export function parseDeepLink(raw) {
  const ours = deeplink.parse(raw)
  if (ours) return ours
  if (!raw) return null
  let u
  try { u = new URL(raw) } catch { return null }
  const conf = cfg.load()
  if (u.protocol === `${conf.protocol}:`) {
    // enwzombies://m/<map>  — the host is "m" and the path is the map.
    const parts = [u.hostname, ...u.pathname.split('/')].filter(Boolean)
    if (parts[0] === 'm' && parts[1]) return { kind: 'map', map: decodeURIComponent(parts[1]) }
    if (parts[0] === 'play' && parts[1]) return { kind: 'play', map: decodeURIComponent(parts[1]) }
    return { kind: 'open' }
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && conf.deepLinkHosts.includes(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts[0] === 'm' && parts[1]) return { kind: 'map', map: decodeURIComponent(parts[1]) }
    return { kind: 'open' }
  }
  return null
}

// EVERY URL THAT ARRIVES IS LOGGED, including the ones that go nowhere.
//
// A deep link is the one feature whose failures happen on somebody else's machine, at a
// moment nobody is watching, from a string nobody kept — a friend clicks a link in
// Discord and says "it just opened the launcher". Without a line in `launcher.log`
// naming the exact URL and the exact reason it fell through, that report cannot be
// turned into a fix, and the web lane and this lane can only argue about it. So the
// `home` path logs `why`, not just the fact.
function handleDeepLink(raw) {
  const link = parseDeepLink(raw)
  if (!link) { log('deeplink', 'ignored (not one of ours):', String(raw)); return }
  log('deeplink', 'received', String(raw), '->', link.kind, link.map || link.party || link.why || '')
  if (!state.win) {
    // The COLD START case: Windows launched us *with* the URL, so this runs before
    // there is anything to send it to. The RAW string is held, not the parsed link, so
    // the replay goes through this same function and the party/home side effects below
    // happen exactly once and in the same place.
    log('deeplink', 'the window is not up yet; holding it until it is')
    state.pendingDeepLink = raw
    return
  }
  // The RAISE is deferred while a game is running; the routing below is not, so a
  // party invite still navigates the site view and is waiting when the game ends.
  raiseWindow('a deep link')
  // A party lives in the wrapped site, not in our chrome, so "open on that party" is a
  // navigation of the site view. Joining-if-invited is the SITE's decision on that page
  // — the launcher must not invent a join, because it does not know the invite list.
  if (link.kind === 'party') openSitePath(`/party/${encodeURIComponent(link.party)}`, 'a party deep link')
  // A MAP LIVES IN THE SITE NOW. This used to be handled entirely in the renderer, by
  // selecting the map in the launcher's own rail; with the rail gone the link has to
  // navigate the wrapped view to the map's own page, which is where Play Local, the
  // party's Start and the download all are. It still does not press anything.
  if (link.kind === 'map' || link.kind === 'play') openSitePath(`/m/${encodeURIComponent(link.map)}`, 'a map deep link')
  if (link.kind === 'home') { log('deeplink', 'opening home:', link.why || 'nothing to route to'); showSite(true) }
  // A cold start reaches here while the chrome is still loading, and a `send` into a
  // page that has not run its script yet is a message nobody hears — which looks, from
  // the player's side, exactly like the link doing nothing.
  const send = () => push('deeplink', link)
  try { if (state.win.webContents.isLoading()) state.win.webContents.once('did-finish-load', send); else send() } catch { send() }
}

// Navigate the wrapped site view to one of its own paths. Never leaves the site's
// origin: a deep link may choose a PAGE, never a host.
function openSitePath(p, why) {
  try {
    const base = state.siteInfo?.url
    if (!base) { log('deeplink', 'cannot open', p, '- no site is loaded yet'); return false }
    const url = new URL(p, base)
    if (new URL(base).origin !== url.origin) { log('deeplink', 'refused', p, '- it would leave the site'); return false }
    log('deeplink', 'opening', url.href, `(${why})`)
    showSite(true)
    state.siteView?.webContents.loadURL(url.href).catch((e) => log('deeplink', 'could not open', url.href, '-', e.message))
    return true
  } catch (e) { log('deeplink', 'could not open', p, '-', e.message); return false }
}

function linkFromArgv(argv) {
  return deeplink.fromArgv(argv) ||
    argv.find((a) => /^enwzombies:/i.test(a) || /^https?:\/\/(zombies|zm)\.enw\.gg\//i.test(a)) || null
}

// -------------------------------------------------------------------- the IPC --

function wireIpc() {
  const handle = (name, fn) => ipcMain.handle(`enw:${name}`, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) } } catch (e) {
      log('ipc error', name, e.message)
      return { ok: false, error: e.message }
    }
  })

  // ONE FIELD MUST NEVER BE ABLE TO BLANK THE WHOLE SCREEN.
  //
  // `status` used to be a single object literal inside one try/catch. Every field in it
  // touches the disk or the network -- `setup.status()` hashes a 1.4 MB DLL,
  // `lock.read()` reads another agent's file, `state.updater.status()` reflects a
  // network call -- and if ANY of them threw, the handler returned `{ok:false}`, the
  // renderer's `status()` threw, and the first-run screen rendered from `undefined`.
  // Which looks, to a player, exactly like "the client is not installed".
  //
  // Now each field is evaluated on its own. A field that throws becomes `null` and its
  // message lands in `errors`, and everything the launcher DOES know still reaches the
  // UI. `installed` is never inferred from an absence.
  const field = (errors, name, fn, fallback = null) => {
    try { return fn() } catch (e) { errors[name] = e.message; return fallback }
  }

  handle('status', async () => {
    const errors = {}
    const st = {
      appVersion: app.getVersion(),
      site: state.siteInfo,
      setup: field(errors, 'setup', () => setup.status(), { installed: false, unknown: true }),
      session: field(errors, 'session', () => settings.session(), { signedIn: false }),
      settings: field(errors, 'settings', () => settings.get(), {}),
      config: field(errors, 'config', () => cfg.load(), {}),
      enwRoot: P.root,
      // Where everything actually is. B's launcher insisted the client was not
      // installed while `setup-cli.js status` on the same machine said it was -- the
      // two were reading DIFFERENT FOLDERS and nothing on screen said so. The paths are
      // now part of the status, so "not installed" can always be read as "not installed
      // HERE".
      paths: { root: P.root, game: P.game, home: P.home, maps: P.maps, logs: P.logs, state: P.state },
      logging: { ...logState, dirsError },
      pendingUpdate: field(errors, 'pendingUpdate', () => pending()),
      gameLock: field(errors, 'gameLock', () => (lock.enabled() ? lock.read() : { held: false, note: 'not a dev box' }), { held: false }),
      lastError: state.lastError,
      updates: field(errors, 'updates', () => (state.updater ? state.updater.status() : { enabled: false, current: app.getVersion() }), { enabled: false }),
      site_api: field(errors, 'site_api', () =>
        (state.api ? { protocol: 0, auth: state.api.hello?.auth, signInUrl: state.api.hello?.sign_in_url || '/auth/steam', you: state.api.who, capabilities: state.api.hello?.capabilities } : null)),
    }
    st.errors = Object.keys(errors).length ? errors : null
    return st
  })

  // The site lives in a NATIVE child view, so an HTML screen in the parent window
  // cannot be drawn over it -- it is drawn UNDER it and is invisible. Every screen has
  // to ask for the site to be hidden.
  //
  // This is the whole of "I can't install the client". `show('firstRun')` only toggled
  // a CSS class, so the Install wizard rendered behind the site view and B clicked at a
  // web page. Only the boot screen ever worked, because the PLAY path happened to call
  // `showSite(false)` from the main process.
  handle('screen', (name) => { showSite(!name); return { site: !name, screen: name || null } })

  handle('detect', (opts) => detect.detect(opts || {}))
  handle('browse', async () => {
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Where is Call of Duty: World at War?',
      properties: ['openDirectory'],
      buttonLabel: 'Use this folder',
      message: 'Pick the game folder. If you pick the wrong one we will look around it and sort it out.',
    })
    if (r.canceled || !r.filePaths[0]) return { cancelled: true }
    return detect.fromBrowse(r.filePaths[0])
  })
  handle('validate', (dir) => detect.validate(dir))

  handle('setup', async ({ gameDir, force } = {}) => {
    state.gate.block('setup', 'an install is running')
    try {
      const m = setup.install({ gameDir, force, onProgress: (s) => push('setup', s) })
      return m
    } catch (e) {
      await reportCrash('setup_failed', e, { gameDir })
      // A player gets a sentence they can act on, not an errno. The original message
      // is kept on the end for us.
      throw new Error(setup.explainSetupFailure(e))
    } finally { state.gate.unblock('setup') }
  })
  handle('storage', () => setup.storage())

  // The real map library (archive agent's 14 normalised maps). The rail shows `title`;
  // only the engine ever sees `bsp`.
  handle('maps', () => library.catalogue())
  // One route to "the map is on disk", used by the Install button AND by Play Local.
  //
  // Play Local used to have its own copy of this that only ever consulted the LOCAL
  // ARCHIVE — `ZombiesDev\archive`, which exists on exactly one machine in the world.
  // On a friend's PC the condition was false, nothing installed, and the game was
  // launched at a map that was not there. That is the first clause of B's MVP sentence
  // ("load one of the test maps -> it installs") failing silently for everyone but him.
  async function ensureMapInstalled(bsp, { announce = false, onProgress: extra = null } = {}) {
    // A stock map ships with World at War. There is nothing to download, the site
    // holds no files for it by design, and asking anyway is what failed B's Nacht der
    // Untoten launch (library.js :: STOCK_MAPS).
    if (library.isStock(bsp)) return { already: true, stock: true, skipped: 'installed: stock' }
    if (library.isInstalled(bsp)) return { already: true }
    // One install per map at a time. The party watcher starts the download the moment
    // the leader stages a map; the boot flow then asks for the same map again a minute
    // later and must WAIT for that one rather than start a second copy into the same
    // folder.
    const running = state.installs.get(bsp)
    if (running) return running
    const p = runInstall(bsp, { announce, extra }).finally(() => state.installs.delete(bsp))
    state.installs.set(bsp, p)
    return p
  }

  async function runInstall(bsp, { announce = false, extra = null } = {}) {
    // The party's progress bar (launcher-v0 §2b). `attach` returns null unless the
    // site says there is a party AND this is the map that party staged, so a library
    // install or a local game sends nothing at all.
    const reporter = partyprogress.attach(state.api, state.lastPlay, bsp, { log: (m) => log('party', m) })
    if (reporter) log('party', `reporting ${bsp} to party ${reporter.partyId}`)
    const onProgress = (p) => {
      push('mapProgress', { bsp, ...p })
      try { extra?.(p) } catch {}
      reporter?.downloading(p.done ?? p.bytes ?? 0, p.total ?? 0)
    }
    state.gate.block('mapinstall', 'a map is installing')
    try {
      // From the site when we are connected to one — that is the only route that
      // works on anybody else's machine. The local archive is the dev fallback.
      let rec = null
      if (state.api && state.api.can('map_downloads')) {
        if (announce) push('toast', { kind: 'info', text: 'Downloading the map…' })
        rec = await library.installFromSite(bsp, { api: state.api, onProgress, mapsBase: cfg.load().mapsBase })
      } else if (library.catalogue().maps.some((m) => m.bsp === bsp && m.available)) {
        if (announce) push('toast', { kind: 'info', text: 'Installing the map…' })
        rec = library.install(bsp, { onProgress })
      } else {
        // Nothing was downloaded and nothing failed. The party is told `failed`,
        // because from the leader's side "this member cannot get the map" and "this
        // member's download broke" are the same fact: do not press Start.
        reporter?.failed('there is no source for this map')
        return { skipped: 'no source for this map: the site cannot serve it and there is no local archive' }
      }
      // `installed` means the hash check passed: both install routes throw instead of
      // returning when a file does not match what the archive recorded.
      reporter?.installed(rec?.bytes ?? null)
      return rec
    } catch (e) {
      reporter?.failed(e)
      throw e
    } finally { state.gate.unblock('mapinstall') }
  }

  handle('installMap', async (bsp) => {
    try {
      return await ensureMapInstalled(bsp)
    } catch (e) {
      await reportCrash('map_failed', e, { bsp })
      throw e
    }
  })
  handle('removeMap', (bsp) => library.uninstall(bsp))

  // Spec 13 §2: "Uninstall ... asks whether to keep the downloaded maps."
  handle('uninstall', async ({ keepMaps } = {}) => {
    if (keepMaps === undefined) {
      const st = setup.storage()
      const mb = (st.folders.maps.bytes / 1e6).toFixed(0)
      const r = await dialog.showMessageBox(state.win, {
        type: 'question',
        buttons: ['Keep my maps', 'Remove everything', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Remove the ENW client',
        message: 'Remove the ENW client?',
        detail:
          `Your copy of World at War is not touched either way — we never wrote to it.\n\n` +
          `Downloaded maps: ${st.maps.length} (${mb} MB) in ${st.folders.maps.path}`,
      })
      if (r.response === 2) return ['cancelled']
      keepMaps = r.response === 0
    }
    return setup.uninstall({ keepMaps: keepMaps !== false })
  })

  handle('signIn', async ({ mock = false } = {}) => {
    // REAL STEAM SIGN-IN, when the site offers it.
    //
    // Steam sign-in is OpenID 2.0: a redirect round trip, not an API call. The window
    // goes to steamcommunity.com, THE PLAYER types their password there and nowhere
    // else, Steam redirects back to <site>/auth/steam/return, and the site's session
    // cookie lands in this app's cookie jar. Because the sign-in window uses the
    // DEFAULT Electron session -- the same one the wrapped site view uses -- the page
    // and `siteapi.js` (through `electronCookieProvider`) are then the same signed-in
    // player, with no second auth path and nothing for the launcher to hold.
    //
    // No Steam Web API key is involved. The key only buys persona names and avatars;
    // the site runs `passport-steam` with `profile: false`.
    const auth = state.api?.hello?.auth
    // Decided by what the site can DO, not by what it calls itself. Keying this on
    // `auth === 'steam'` meant a mock site silently took a completely different code
    // path, so the fallback tested nothing and the real path could only ever be tested
    // against production. The probe costs one request and creates nothing.
    if (!mock && state.api && (await supportsLoopbackSignIn())) {
      const s = await steamSignIn()
      push('session', s)
      return s
    }
    // The fallback, and it says so. Still useful while the beta password is set: it
    // separates "the launcher is broken" from "auth is broken".
    const acct = await detect.steamAccount()
    if (!acct.current) throw new Error('No Steam account is signed in on this PC, so there is nothing to sign in as yet.')
    const s = settings.signIn({ steamid: acct.current.steamid, name: acct.current.persona || acct.current.account, mock: true })
    log('sign-in', `mock, as ${s.steamid}${auth === 'steam' ? ' (the site offers Steam; this was asked for explicitly)' : ` (the site's auth mode is ${auth || 'unknown'})`}`)
    push('session', s)
    return s
  })
  handle('signOut', () => { const s = settings.signOut(); push('session', s); return s })

  handle('getSettings', () => settings.get())
  handle('setSettings', (patch) => { const s = settings.set(patch); push('settings', s); return s })
  // Display settings need the monitor list, and only the main process can get it.
  handle('getDisplays', () => ({ displays: listDisplays(), modes: MODES }))

  // ------------------------------------------------------- check for updates --
  //
  // The player's own button. It is deliberately NOT the silent lane (`state.updater`):
  // that one is allowed to fail invisibly, and this one exists to say what happened.
  // Both are safe to have at once — electron-updater is a singleton, and the worst case
  // is the background check and this one racing to the same answer.
  //
  // None of these three throw. An `{ok:false}` here becomes a red toast that says
  // nothing useful; the state machine's own message is always better than an errno.
  handle('updateStatus', () => updateCheck().status())
  handle('checkForUpdates', () => updateCheck().check())
  handle('restartAndUpdate', () => {
    const r = updateCheck().quitAndInstall()
    if (!r.ok) push('toast', { kind: 'error', text: `Could not restart to install the update: ${r.why}` })
    return r
  })

  // --------------------------------------------------- a tracked local game --
  //
  // THE MISSING LINK, and it is why no local game has ever produced a round count.
  // `localrun.js` has always known how to tell the site about a local game; what
  // nothing did was START THE REFEREE. The chain only closes if all four of these
  // happen before the game launches, in this order:
  //
  //   1. the host agent is running               (hostagent.js — it was never started)
  //   2. the site opens a match, or we mint one  (so the id is the same everywhere)
  //   3. the agent is told to EXPECT that id     (it refuses a hello it was not told about)
  //   4. the game launches pointed at the link address THE AGENT gave us
  //
  // Step 4 used to send the game at a hard-coded 127.0.0.1:28960, which is not where
  // the agent listens, so even a perfectly built game would have found nothing there.
  async function prepareLocalRun(mapKey) {
    const agent = hostAgent()
    agent.removeAllListeners('log')
    agent.on('log', (m) => log('hostagent', m))
    const info = await agent.ensure()
    log('hostagent', `ready: dash ${info.dashUrl}, link ${info.linkHost}, ${info.adopted ? 'adopted' : `pid ${info.pid}`}`)

    const run = new LocalRun({ api: state.api, dashUrl: info.dashUrl })
    // The site names the match when it can. When it cannot — no session, site down,
    // a friend playing offline — we still play and still record; the run is simply
    // never posted anywhere. A local game is worth nothing to the ladder either way,
    // so there is no reason for the site to be able to stop it happening.
    let matchId = null
    try {
      const started = await run.start(mapKey)
      matchId = started.match_id
      log('localrun', `site opened match ${matchId} for ${mapKey}`)
    } catch (e) {
      matchId = `l_${crypto.randomBytes(4).toString('hex')}`
      run.matchId = matchId
      run.offline = true
      log('localrun', `the site did not open a match (${e.message}); recording locally as ${matchId}`)
    }

    const expected = await run.expect({ instance: matchId, matchId, map: mapKey })
    const linkHost = expected.link || info.linkHost
    log('localrun', `the referee is expecting ${matchId} and listening on ${linkHost}`)
    return { run, matchId, linkHost, agent, info }
  }

  // Give the box back.
  //
  // A lease that nobody launches into is not free: the site keeps it `ready`, the box
  // keeps the instance up with the map loaded, and the ghost-lease reaper will not
  // touch it because the box is honestly reporting it. So every way a launch can end
  // without a game — a failed step, a cancel, an exception — has to say so out loud.
  // `POST /api/launcher/cancel` is the site's own route for it and it is best effort:
  // a launcher that cannot reach the site cannot free anything, and saying so in the
  // log is all it can do.
  function releaseLease(why) {
    const api = state.api
    if (!api || !api.signedIn) return
    Promise.resolve()
      .then(() => api.cancel())
      .then((r) => log('play', `released the lease (${why}): ${r?.ok ? 'the site let the box go' : JSON.stringify(r)}`))
      .catch((e) => log('play', `could NOT release the lease (${why}): ${e.message}`))
  }

  async function startPlay(opts = {}) {
    if (state.flow) throw new Error('A launch is already in progress.')

    // The client DLL this launcher ships must be the one the game loads. An
    // auto-update replaces the copy beside the app and nothing else, so before
    // 0.2.1 an updated launcher happily launched a months-old client and every
    // feature that lives in the DLL was simply absent (setup.js, "THE STALE
    // CLIENT DLL"). One hash compare and, at worst, one file copy.
    try {
      const c = setup.ensureClientDll()
      if (c.changed) {
        log('setup', `client dll: ${c.reason}`)
        push('toast', { kind: 'ok', text: 'Updated the ENW client to match this launcher.' })
      } else if (!c.ok) {
        log('setup', `client dll: ${c.reason}`)
      }
    } catch (e) {
      log('setup', `client dll: could NOT update — ${e.message}`)
      push('toast', { kind: 'warn', text: `The ENW client could not be updated: ${e.message}` })
    }

    const conf = cfg.load()
    const s = settings.get()
    const sess = settings.session()

    // The 4 GB (large address aware) flag on our own copy's CoDWaW.exe. Same place
    // as the DLL repair and for the same reason: an update that changes what the
    // game copy should look like has to reach a folder that already exists. Two
    // bytes in a PE header, idempotent, read back — and `largeAddressAware: false`
    // in settings restores the bytes we recorded before we first wrote.
    try {
      const want = s.largeAddressAware !== false
      const l = want ? setup.ensureLargeAddressAware({ enabled: true }) : setup.restoreGameExe()
      if (l.changed) {
        log('setup', `CoDWaW.exe: ${l.reason}`)
        push('toast', { kind: 'ok', text: want ? 'Enabled 4 GB memory for big custom maps.' : 'Put CoDWaW.exe back to 2 GB memory.' })
      } else if (!l.ok) {
        log('setup', `CoDWaW.exe: ${l.reason}`)
      }
    } catch (e) {
      log('setup', `CoDWaW.exe: could NOT set the 4 GB flag — ${e.message}`)
      push('toast', { kind: 'warn', text: `Could not set the 4 GB flag on the game: ${e.message}` })
    }

    // Everything a local game needs from the referee, resolved BEFORE the launch,
    // because the game only reads ENW_HOST/ENW_INSTANCE once, at startup.
    let local = null
    if (opts.local) {
      try {
        local = await prepareLocalRun(opts.map)
      } catch (e) {
        // Recording is not the point of the game. Say so plainly and play anyway.
        log('localrun', `not recording this game: ${e.message}`)
        push('toast', { kind: 'warn', text: `This game will not be recorded: ${String(e.message).split('\n')[0]}` })
      }
    }

    const flow = new BootFlow({
      map: opts.map,
      mode: opts.mode || 'custom',
      // launcher-v0: when the site is there, IT leases and we watch. The old
      // mock-site lease path stays only for a machine with no site running.
      api: opts.local ? null : state.api,
      // Somebody else pressed Start: skip POST /api/launcher/play (only the leader may
      // call it) and go straight to watching for the match the site already leased.
      follow: !!opts.follow,
      followDetail: opts.followDetail || null,
      // The map must be on disk before +connect. Shared with the party pre-download:
      // ensureMapInstalled hands back the in-flight install rather than starting a
      // second one, so a member whose download is still running simply waits for it.
      ensureMap: opts.local ? null : (bsp, onProgress) => ensureMapInstalled(bsp, { onProgress }),
      // Two questions the boot flow has to be able to ask without downloading
      // anything: is this map stock (skip the step entirely), and is it on disk
      // already (a download that failed does not matter if the map is there).
      isStock: (bsp) => library.isStock(bsp),
      mapReady: (bsp) => library.mapReady(bsp),
      siteUrl: opts.hostApi || conf.hostApi,
      hostDashboard: local?.info?.dashUrl || conf.hostDashboard,
      // The address the referee IS listening on, read back from the referee. The old
      // default (127.0.0.1:28960) was a guess that has never been right.
      linkHost: local?.linkHost || conf.linkHost,
      steamid: sess.steamid,
      playerName: sess.name,
      settings: s,
      stealth: conf.stealthLaunch,
      useGameLock: conf.useGameLock,
      localMap: opts.local ? opts.map : null,
      // The match id is the instance id: the site, the referee and the signed replay
      // then all name one game, which is what makes the replay findable afterwards.
      instance: local?.matchId || undefined,
      fsGame: opts.fsGame || undefined,
      lockName: 'launcher',
    })
    state.flow = flow
    state.gate.block('game', 'a game is starting or running')
    state.tray?.rebuild()
    showSite(false)
    push('boot', flow.snapshot())
    flow.on('update', (snap) => push('boot', snap))

    // Spec §4.3 round trip. Whatever the player changed in the game's own settings
    // menus is read out of config.cfg once the process is gone, and saved to the
    // account -- so the NEXT launch starts at that resolution and mode without them
    // touching anything twice. Only keys the game actually wrote are saved, so this
    // can never override an in-game choice with a stale one.
    flow.on('settings_readback', (r) => {
      const keys = Object.keys(r?.changed || {})
      if (!keys.length) return
      try {
        const saved = settings.set(r.changed)
        push('settings', saved)
        log('settings', `saved ${keys.length} in-game change${keys.length === 1 ? '' : 's'} to the account: ${keys.join(', ')} (from ${r.file})`)
      } catch (e) {
        log('settings', `could not save the in-game changes: ${e.message}`)
      }
    })

    // The relay runs for as long as the game does: it watches the referee, pushes
    // live frames at the site's spectator view, and posts the summary and the replay
    // pointer when the referee calls the game. It is started on 'launched' rather than
    // up front so a launch that never happens does not leave a poller running.
    if (local) {
      state.localRun = local.run
      local.run.on('frame', (f) => push('localRound', { match_id: local.matchId, round: f.round, players: f.players }))
      flow.on('launched', () => {
        log('localrun', `relaying ${local.matchId} from ${local.info.dashUrl}`)
        local.run
          .relayUntilDone({ instanceId: local.matchId })
          .then((r) => {
            state.lastLocalResult = { ...r, match_id: local.matchId, replay_dir: local.info.replayDir }
            if (r.ok) {
              const rounds = r.summary?.rounds ?? '?'
              const file = r.replay?.file || '(none)'
              log('localrun', `RUN LOGGED: match ${local.matchId}, round ${rounds}, ${r.frames} live frames, replay ${file}`)
              push('toast', { kind: 'good', text: `Run recorded: round ${rounds}. Replay saved.` })
            } else {
              log('localrun', `run NOT logged: ${r.reason} (last round ${r.lastRound ?? '?'}, ${r.frames} frames)`)
              push('toast', { kind: 'warn', text: `The run was not recorded: ${r.reason}` })
            }
            push('localResult', state.lastLocalResult)
          })
          .catch((e) => log('localrun', `relay failed: ${e.message}`))
      })
    }

    flow.on('ended', async (p) => {
      if (p.phase === 'failed') await reportCrash('game_crash', new Error(p.detail || 'the game ended unexpectedly'), { map: opts.map })
      // Give the referee a moment to notice the game is gone and write its footer,
      // then stop polling. Without the delay we stop the relay before the summary
      // exists and the replay pointer is never posted.
      if (local) setTimeout(() => local.run.stop(), 20_000).unref?.()
      state.flow = null
      state.gate.unblock('game')
      state.tray?.rebuild()
      showSite(true)
      raiser.flush()   // a raise we refused mid-game (focusguard.js) happens now
      push('boot_done', { ...flow.snapshot(), phase: p.phase, detail: p.detail })
    })
    const clear = () => {
      if (state.flow !== flow) return
      state.flow = null
      state.gate.unblock('game')
      state.tray?.rebuild()
      showSite(true)
      raiser.flush()   // a raise we refused mid-game (focusguard.js) happens now
    }
    flow.run().then((snap) => {
      push('boot', snap)
      // A step can fail without the game ever starting (no server, setup missing), in
      // which case there is no 'ended' event to clean up after us. Without this the
      // launcher refuses every later Play with "a launch is already in progress".
      if (snap.failed) {
        clear()
        // AND THE LEASE HAS TO GO BACK. A flow that failed after the site leased a box
        // left the lease `ready` and the instance parked with a map loaded for nobody:
        // measured on 2026-09-22 as m_dca96c74, still holding inst-01 three minutes
        // after B closed the boot screen. The site's own reaper cannot help — the box
        // *is* reporting that instance, so it is not a ghost.
        releaseLease('the launch failed')
        // The boot screen swaps Cancel for Close on `boot_done`, and a failed flow
        // never sent one: the screen sat with a Cancel button over a launch that had
        // already stopped. That is the "waiting forever" B saw.
        push('boot_done', { ...snap, phase: 'failed', detail: snap.steps.find((s) => s.state === 'failed')?.detail || 'the launch stopped' })
      }
    }).catch(async (e) => {
      await reportCrash('server_unreachable', e, { map: opts.map })
      push('boot', { ...flow.snapshot(), error: e.message })
      clear()
      releaseLease('the launch threw')
      push('boot_done', { ...flow.snapshot(), phase: 'failed', detail: e.message })
    })
    return flow.snapshot()
  }

  handle('play', (opts) => startPlay(opts))

  // web's `window.enw.playLocal(session)`. Accepts either a map key or the whole
  // `/local/start` response, because they offered the latter — but the launcher
  // prefers to make that call itself: it is the thing that has to INSTALL the map
  // first, and a match opened before an install that then fails is an orphan.
  handle('playLocal', async (arg = {}) => {
    // MEASURED, from B's own launcher.log on 2026-09-20: three presses of Play Local,
    // three `ipc error playLocal The "path" argument must be of type string. Received
    // an instance of Object`. The site sends `{ map: { key, bsp, … } }`, `arg.map` is
    // truthy, and an OBJECT went all the way into path.join(). So: take the first
    // candidate that is actually a string, and say what arrived if none is.
    const mapKey = [
      arg.map_key, arg.mapKey, arg.bsp,
      typeof arg.map === 'string' ? arg.map : null,
      arg?.map?.bsp, arg?.map?.key, arg?.map?.map_key,
    ].find((x) => typeof x === 'string' && x.trim())
    if (!mapKey) {
      throw new Error(
        'playLocal needs a map key (a bsp name like "nazi_zombie_prototype"). ' +
        `Got: ${JSON.stringify(arg)?.slice(0, 200)}`
      )
    }
    // Install first if we have to: the site opening a match before an install that
    // then fails would leave an orphan. Same route as the Install button — the site
    // when there is one, the local archive only as a dev fallback.
    await ensureMapInstalled(mapKey, { announce: true })
    // A CUSTOM MAP IS ITS OWN MOD. World at War loads `nazi_zombie_leviathan` out of
    // `mods\nazi_zombie_leviathan`, so fs_game has to be that and not `mods/enw` — get
    // it wrong and the engine says `Can't find map "..."` with the 450 MB fastfile
    // sitting right there. Our DLL rides in on the binkw32 proxy, not on fs_game, so
    // it does not care which mod is loaded. A stock map (prototype, asylum, sumpf,
    // factory) is not installed by us and keeps the ENW mod folder.
    //
    // `isInstalled` is the wrong test here and it cost a run: it means "WE installed
    // it", so a map the player already had — B's own `nazi_zombie_ali`, and
    // `nazi_zombie_octogonal` — came back false, fs_game stayed `mods/enw`, and the
    // engine never found the map. Whether the folder is ours or theirs is a question
    // about deleting it, not about playing it. `ownership()` answers both.
    const own = library.ownership(mapKey)
    const fsGame = arg.fs_game || arg.map?.fs_game ||
      (own.state === 'absent' ? undefined : `mods/${mapKey}`)
    return startPlay({
      map: mapKey,
      mode: 'local',
      local: true,
      fsGame,
      // If the page already called /local/start, reuse its match rather than opening
      // a second one.
      prestarted: arg.match_id ? arg : null,
    })
  })

  // Cancelling gives the box back too. Without this, every cancelled Start left a
  // lease `ready` and an instance parked on the box until somebody pressed Start
  // again — which is how m_dca96c74 outlived the boot screen that made it.
  handle('cancelPlay', () => { state.flow?.cancel('you cancelled'); releaseLease('you cancelled'); showSite(true); return true })
  handle('closeBoot', () => { showSite(true); return true })

  handle('setConfig', (patch) => {
    const next = cfg.save(patch)
    if (patch.siteUrl) reloadSite(patch.siteUrl)
    return next
  })
  handle('reloadSite', async (url) => reloadSite(url))
  handle('siteNav', (what) => {
    const wc = state.siteView?.webContents
    if (!wc) return false
    if (what === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (what === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (what === 'reload') wc.reload()
    return true
  })
  handle('openExternal', (url) => { shell.openExternal(url); return true })
  handle('openFolder', (which) => {
    const map = { root: P.root, game: P.game, logs: P.logs, maps: P.maps, crashes: P.crashes }
    shell.openPath(map[which] || P.root)
    return true
  })
  handle('installViaSteam', () => { shell.openExternal(`steam://install/${detect.APPID}`); return true })
  handle('getOnSteam', () => { shell.openExternal(`https://store.steampowered.com/app/${detect.APPID}/`); return true })

  // The site refresh gate: the wrapped page asks to refresh; we do it when idle.
  handle('requestSiteRefresh', () => {
    state.gate.when(() => state.siteView?.webContents.reload())
    return { scheduled: true, blocked: state.gate.blocked, why: state.gate.why }
  })
  handle('setBusy', ({ key, busy, why }) => {
    if (busy) state.gate.block(key, why || key)
    else state.gate.unblock(key)
    return { blocked: state.gate.blocked, why: state.gate.why }
  })

  // ------------------------------------------------------------- the party --
  //
  // One poll of `/api/launcher/play`, running whenever a site is connected, doing two
  // jobs that are really the same job — *keeping up with what the party is doing when
  // the player is not the one driving it*:
  //
  //   1. THE LEADER STAGED A MAP. Start downloading it now rather than at Start, and
  //      report every second so the party panel can draw this player's bar and the
  //      leader's Start button can stand down while it moves (launcher-v0 §2b). The
  //      reporting lives in `ensureMapInstalled`, and the gate is in
  //      `partyprogress.attach()`: no party, or a different map, and nothing is sent.
  //
  //   2. SOMEBODY ELSE PRESSED START. The site has already leased a box and minted
  //      this player's own invite token; it is in the poll body. Open the boot screen
  //      and follow it, exactly as if this player had pressed Play. Without this only
  //      the leader's launcher ever launched.
  //
  // It is deliberately not "non-leaders only". A leader who presses Start in the
  // wrapped page (rather than the launcher's corner card) is in the same position as
  // everybody else: no flow running, a match waiting. The guard is `state.flow`, so
  // the player who pressed Play in the launcher is never followed into a second one.
  const FOLLOW_STATES = ['reserving', 'loading', 'ready', 'in-game']

  function onPlay(p) {
    if (!p || p.signedOut) { state.lastPlay = null; return }
    state.lastPlay = p

    const bsp = p.map?.key || null
    const inParty = Number(p.party?.id || 0) > 0

    // 1. pre-download the party's map
    if (inParty && bsp && !library.mapReady(bsp) && !state.installs.has(bsp) && !state.flow) {
      ensureMapInstalled(bsp).catch((e) => log('party', `could not install ${bsp}: ${e.message}`))
    }

    // 2. follow somebody else's Start
    if (state.flow || !FOLLOW_STATES.includes(p.state)) return
    if (!p.match || !bsp) return
    const who = p.party?.is_leader === false ? 'your party leader started a game' : 'a game was started for you'
    log('party', `following ${p.match.match_id || '(no id yet)'} — ${who}`)
    startPlay({ map: bsp, mode: p.match.mode || p.party?.mode || 'custom', follow: true, followDetail: who })
      .catch((e) => log('party', `could not follow: ${e.message}`))
  }

  state.startPartyWatch = () => {
    if (state.playWatcher || !state.api) return
    const w = new PlayWatcher(state.api)
    w.on('poll', (p) => { try { onPlay(p) } catch (e) { log('party', `watch: ${e.message}`) } })
    w.on('error', () => {})     // a site that is down is not an error the player can act on
    state.playWatcher = w
    w.start()
    log('party', 'watching the site for the party, the staged map and somebody else pressing Start')
  }
}

// ------------------------------------------------------------ Steam sign-in --
//
// RFC 8252, "OAuth 2.0 for Native Apps": a native application sends the user to the
// SYSTEM BROWSER and collects the answer on a loopback redirect. It does not host the
// sign-in in a webview of its own.
//
// The first version of this did use an Electron window, and B caught it straight away —
// clicking through landed him in Waterfox anyway. That is not a bug to route around, it
// is the correct behaviour, and there are two hard reasons to lean into it:
//
//   * A webview has no address bar and no padlock, so a player cannot tell a real Steam
//     login from one we painted. The browser is the only thing that can prove where the
//     password is going.
//   * The process hosting a webview can read what is typed into it. A Steam password
//     must never be able to pass through ours. It now cannot: we never see that window.
//
// And it is nicer: B's browser already holds his Steam session, so this is one click.
//
// PKCE (S256) is what makes a loopback redirect safe. Any local process can bind a port
// and any local process can watch a redirect go past, but the code that comes back is
// worthless without the `verifier`, which never leaves this process except in the one
// POST that spends it. The server enforces the S256 check, burns codes on first use,
// expires them at 120 s, echoes `state`, and BUILDS the redirect from our port number,
// so there is no URL of ours for anyone to point somewhere else.

// Ask the site who we are, tolerating a site that answers in more than one shape.
async function whoAmI() {
  const r = await state.api.req('/api/me', { timeoutMs: 5000 })
  const d = r.data || {}
  const you = d.you || d.user || d
  const steamid = you.steamid || you.steam_id || you.id || null
  return { signedIn: !!(d.signed_in || d.signedIn || (steamid && you.name)), steamid, name: you.name || you.persona || null }
}

const b64url = (b) => Buffer.from(b).toString('base64url')

// Does this site speak the loopback sign-in at all?
//
// Asked with NO parameters on purpose: a site that has the route answers 400 ("you did
// not send a port/state/challenge") and a site that does not answers 404. So the probe
// distinguishes the two without minting a code that nobody will ever spend.
async function supportsLoopbackSignIn() {
  const base = String(state.siteInfo?.url || '').replace(/\/$/, '')
  if (!/^https?:/i.test(base)) return false
  try {
    const r = await fetch(`${base}/auth/launcher/start`, { redirect: 'manual', signal: AbortSignal.timeout(6000) })
    return r.status !== 404 && r.status < 500
  } catch { return false }
}

function signInPage(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>html,body{height:100%;margin:0}' +
    'body{background:#12130e;color:#e8e4d9;font:16px/1.5 "Segoe UI",system-ui,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;text-align:center}' +
    '.c{max-width:32rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .6rem;color:#f3efe3}' +
    'p{margin:.4rem 0;color:#a9a496}.m{color:#b0342c}</style></head>' +
    '<body><div class="c"><h1>' + title + '</h1>' + body + '</div></body></html>'
}

// How long the player has to finish in their browser.
//
// This was 125 seconds, to match a 120-second window on the site, and that pairing was
// the bug that stopped B signing in. Both clocks were sized for a machine spending a
// code; the thing they were actually timing is a PERSON opening a tab, signing in to
// Steam and reading a Steam Guard code off a phone. Two minutes is regularly not
// enough, and when it ran out the site redirected the browser to `/` — the closed-beta
// password box — while the launcher said "Sign-in timed out". Neither end named the
// real reason, because neither end knew it.
//
// Ten minutes here, fifteen on the site (routes/auth.js LAUNCHER_FLOW_TTL_MS), so the
// LAUNCHER is always the one that gives up first and the message the player gets is
// ours. The loopback listener is bound to 127.0.0.1, answers one callback, and checks
// `state` before it believes anything, so a longer bind is not a longer exposure.
const SIGNIN_WINDOW_MS = 10 * 60_000

// One sign-in at a time, and never a listener left bound.
function steamSignIn() {
  // Pressing Sign in again REPLACES the open attempt rather than refusing. With a
  // ten-minute window, refusing would leave a player who closed the tab — or who was
  // never shown one, because `shell.openExternal` can fail quietly — locked out of
  // their own launcher for ten minutes with nothing to press.
  if (state.signIn) {
    log('sign-in', 'a sign-in was already open; abandoning it and starting a new one')
    try { state.signIn.abandon() } catch {}
    state.signIn = null
  }

  const base = String(state.siteInfo?.url || '').replace(/\/$/, '')
  if (!/^https?:/i.test(base)) throw new Error('There is no site to sign in to yet.')

  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const stateTok = b64url(crypto.randomBytes(16))

  return new Promise((resolve, reject) => {
    let settled = false
    let claimed = false          // exactly one callback, then we stop listening
    let timer = null

    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      state.signIn = null
      try { server.close() } catch {}
      fn(arg)
    }

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname !== '/cb') { res.writeHead(404).end(); return }
      if (claimed) {
        res.writeHead(409, { 'content-type': 'text/html; charset=utf-8' })
        res.end(signInPage('Already done', '<p>This sign-in has already been used.</p>'))
        return
      }
      claimed = true

      const fail = (msg) => {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(signInPage('Sign-in did not finish', '<p class="m">' + msg + '</p><p>Close this tab and press Sign in again in ENW Zombies.</p>'))
        log('sign-in', 'failed: ' + msg)
        done(reject, new Error(msg))
      }

      if (u.searchParams.get('error')) return fail('Steam did not sign you in.')
      // A MISMATCHED STATE IS A HARD STOP. It means this callback is not the one this
      // launcher started, so the code in it is not ours to spend.
      if (u.searchParams.get('state') !== stateTok) return fail('That sign-in did not match the one this launcher started.')
      const code = u.searchParams.get('code')
      if (!code) return fail('Steam came back without a sign-in code.')

      try {
        // THROUGH THE ELECTRON SESSION, not Node's fetch. The 200 carries the `zm.sid`
        // cookie, and it has to land in the jar that the wrapped page and
        // `electronCookieProvider` both read — otherwise the launcher would be holding
        // an identity the site had never heard of.
        const ex = await electronSession.defaultSession.fetch(base + '/auth/launcher/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ code, verifier }),
        })
        const data = await ex.json().catch(() => ({}))
        if (!ex.ok || !data.ok) return fail(data.error || ('the site refused the sign-in (' + ex.status + ')'))

        const you = data.you || {}
        const steamid = you.steam_id || you.steamid || null
        if (!steamid) return fail('the site signed us in but did not say who we are')
        const s = settings.signIn({ steamid, name: you.name || you.persona || null, mock: false })
        log('sign-in', 'Steam: signed in as ' + (s.name || s.steamid))

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(signInPage('Signed in', '<p>You can close this tab and go back to ENW Zombies.</p>'))

        // The wrapped page loaded signed out; it needs to see the cookie.
        try { await state.api.sayHello() } catch {}
        try { state.siteView?.webContents.reload() } catch {}
        raiseWindow('the Steam sign-in finishing')
        done(resolve, s)
      } catch (e) {
        fail('could not reach the site to finish signing in (' + e.message + ')')
      }
    })

    server.on('error', (e) => done(reject, new Error('could not listen for the sign-in reply: ' + e.message)))

    // 127.0.0.1 EXPLICITLY. Not 0.0.0.0, not ::, not the name "localhost" — this
    // listener must not be reachable off the machine, and RFC 8252 §8.3 wants the
    // literal address. Port 0 lets the OS pick, which is always >= 1024.
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      if (port < 1024) return done(reject, new Error('the operating system gave us a privileged port'))
      state.signIn = {
        port,
        since: Date.now(),
        // What a replacing sign-in calls: close the listener and settle this promise,
        // so nothing is left bound and nothing is left pending.
        abandon: () => done(reject, new Error('That sign-in was replaced by a new one.')),
      }
      const url = base + '/auth/launcher/start?port=' + port +
        '&state=' + encodeURIComponent(stateTok) +
        '&challenge=' + encodeURIComponent(challenge)
      log('sign-in', 'Steam: listening on 127.0.0.1:' + port + ', opening your browser')
      // The beta password is NEVER in this URL. `/auth/launcher/*` and `/auth/steam` are
      // exempt from the gate precisely so a freshly opened browser — and Steam — can
      // reach them without one.
      //
      // ENW_SIGNIN_NO_BROWSER: print the URL instead of opening anything. It is how the
      // whole handshake — listener, state check, exchange, cookie — gets tested without
      // a browser and without Steam, and it is what a headless box would need.
      if (process.env.ENW_SIGNIN_NO_BROWSER) { log('sign-in', 'ENW_SIGNIN_NO_BROWSER: open this yourself ->', url); return }
      shell.openExternal(url).catch((e) => done(reject, new Error('could not open your browser: ' + e.message)))
    })

    // Time-boxed whatever happens: a listener left bound is a local service nobody
    // asked for. The message names the browser, because that is where the sign-in
    // actually lives and where the player will have left it.
    timer = setTimeout(() => {
      log('sign-in', `Steam: gave up after ${Math.round(SIGNIN_WINDOW_MS / 60000)} minutes; the listener is closed`)
      done(reject, new Error('Sign-in timed out — the browser tab was never finished. Press Sign in again to open a fresh one.'))
    }, SIGNIN_WINDOW_MS)
    timer.unref?.()
  })
}

// The site API shares the page's cookie jar, so a signed-in page means signed-in API
// calls from the main process — one session, no second auth path, nothing to leak
// (launcher-v0 §1). Without a site we simply have no api and Play stays local-only.
//
// Called at startup AND from reloadSite: a launcher opened while the site was down
// (2026-09-22, the keepalive loop had died with its shell) used to stay on the
// placeholder with no api for its whole life, reload button or not, and Play never
// came back until the player restarted the launcher.
async function connectSiteApi() {
  // A watcher from an earlier connect holds the earlier api; drop it so the new one starts fresh.
  if (state.playWatcher) { state.playWatcher.stop(); state.playWatcher = null }
  state.api = null
  if (state.siteInfo.placeholder) return
  const api = new SiteApi({
    baseUrl: state.siteInfo.url,
    cookieProvider: electronCookieProvider(electronSession.defaultSession),
    appVersion: app.getVersion(),
    password: cfg.load().sitePassword,
  })
  try {
    const hello = await api.sayHello()
    state.api = api
    log('site hello', `protocol ${hello.protocol}, auth ${hello.auth}, signed in as ${hello.you?.name || 'nobody'}`)
    // From here the launcher keeps up with the party by itself: the staged map is
    // downloaded and reported, and somebody else's Start becomes our launch.
    state.startPartyWatch?.()
  } catch (e) {
    log('site hello failed', e.message)
  }
}

async function reloadSite(url) {
  if (url) cfg.save({ siteUrl: url })
  state.siteInfo = await cfg.resolveSiteUrl()
  log('site', state.siteInfo.url, state.siteInfo.what)
  await state.siteView?.webContents.loadURL(state.siteInfo.url).catch(() => {})
  await connectSiteApi()
  push('site', { loaded: true, url: state.siteInfo.url, what: state.siteInfo.what, placeholder: state.siteInfo.placeholder })
  return state.siteInfo
}

// -------------------------------------------------------------------- startup --

const single = app.requestSingleInstanceLock()
if (!single) {
  // A SECOND INSTANCE USED TO EXIT IN 177 ms WITH NO OUTPUT AT ALL, and that silence
  // cost real time: `ENW_SMOKE_MS=… ENW Zombies.exe` against an already-running
  // launcher produced an empty stdout and an unchanged log, which reads exactly like
  // "the packaged app does not log". It is now said out loud, in both places anyone
  // would look.
  const note = 'another ENW Zombies is already running; this one handed its arguments over and quit'
  try { fs.appendFileSync(path.join(P.logs, 'launcher.log'), `${new Date().toISOString()} second instance: ${note}\n`) } catch {}
  console.log('ENW_SECOND_INSTANCE ' + note)
  app.quit()
} else {
  // A SECOND LAUNCH IS A MESSAGE, NOT AN APP. Clicking `enw-zombies://map/...` while the
  // launcher is already open starts a second process; that process hands its argv to
  // this one and quits (the `!single` branch above), and this is where it arrives. The
  // legacy `enwzombies://` and https:// forms are still recognised — `linkFromArgv`
  // reads both — while the new scheme's own forwarding is `deeplink.makeSecondInstance`,
  // which is the half the tests drive against fakes.
  const forward = deeplink.makeSecondInstance({
    onLink: (url) => handleDeepLink(url),
    onFocus: () => raiseWindow('a second launch of the launcher'),
    log: (...a) => log('deeplink', ...a),
  })
  app.on('second-instance', (_e, argv) => {
    const r = forward(argv)
    if (r.forwarded) return
    // Not the new scheme: it may still be one of the older forms.
    const link = linkFromArgv(argv)
    if (link) handleDeepLink(link)
  })

  app.whenReady().then(async () => {
    // The monitor list, for the Display settings and for the borderless geometry.
    // It is cached to state/displays.json so play-cli.js and the boot flow -- which
    // are plain node and have no `screen` -- can still build a correct command line.
    try {
      const { screen } = await import('electron')
      useScreen(screen)
      const list = listDisplays()
      cacheDisplays(list)
      log('display', `${list.length} display${list.length === 1 ? '' : 's'}: ${list.map((d) => `${d.label} ${d.width}x${d.height} @ ${d.x},${d.y}${d.primary ? ' (primary)' : ''}`).join('; ')}`)
    } catch (e) {
      log('display', `could not read the monitor list (${e.message}); the game will keep its own resolution`)
    }
    // THE FIRST LINE OF EVERY RUN NAMES THE FOLDER THIS PROCESS IS USING.
    //
    // B's launcher said "client: not installed" while `setup-cli.js status` on the same
    // machine printed "Installed: yes", and the two disagreed because they were looking
    // at two different `%LOCALAPPDATA%` trees. Nothing on screen or in the log said
    // which folder either of them meant. Now it does, before anything else can fail.
    log('root', P.root, `(client ${setupInstalledSafe() ? 'installed' : 'NOT installed'} here)`,
      `log ${LOG}`, dirsError ? `- could not create our folders: ${dirsError}` : '')

    // One-time repairs of saved settings. Same moment as the pending update and for
    // the same reason: never mid-game. Evidence: B's account held `maxFps: 60` and
    // `fov: 65`, the engine's 2008 stock defaults, written there by the 0.2.3
    // read-back bug rather than chosen (settings.js MIGRATIONS).
    try {
      const m = settings.migrate({ log: (line) => log('settings', line) })
      if (!m.ran.length) log('settings', 'no settings migrations to run')
    } catch (e) { log('settings', `could not run the settings migrations: ${e.message}`) }

    // Updates are applied HERE, before anything opens: the only moment that is never
    // mid-game and never mid-action (spec 13 §2).
    try {
      const r = applyPending({ gameDir: P.game })
      if (r.applied) log('applied a pending update', r.version, r.done.join('; '))
    } catch (e) { log('could not apply a pending update', e.message) }

    // Deep-link protocol registration. Harmless if it fails (unpackaged dev run).
    //
    // TWO schemes are claimed: the hyphenated `enw-zombies://` the site is about to
    // publish (protocol v0 §7) and the older `enwzombies://` that is already in the
    // smoke report and in people's shortcuts. Windows is happy to hand one app both,
    // and dropping the old one would break links that already exist.
    deeplink.register(app, { log: (...a) => log('deeplink', ...a) })
    try {
      const proto = cfg.load().protocol
      if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(proto, process.execPath, [path.resolve(process.argv[1])])
      else app.setAsDefaultProtocolClient(proto)
    } catch {}

    // Nothing from the wrapped site may reach the machine: no camera, no mic, no
    // notifications, no geolocation. It is a web page, not a partner.
    electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    // ENW_SMOKE_FRESH: start as a brand-new install would — no cookies, so the
    // closed-beta gate really challenges us. Without this the `zm_gate` cookie from a
    // previous run masks the whole password path.
    if (process.env.ENW_SMOKE_FRESH) {
      await electronSession.defaultSession.clearStorageData().catch(() => {})
      log('cleared the session (ENW_SMOKE_FRESH)')
    }

    wireIpc()
    wireSitePassword()
    await createWindow()
    createTray()

    if (state.pendingDeepLink) { const held = state.pendingDeepLink; state.pendingDeepLink = null; handleDeepLink(held) }
    const link = linkFromArgv(process.argv)
    if (link) handleDeepLink(link)

    // Silently send anything that failed to send last time, then start the update lane.
    crash.flush(cfg.load().crashEndpoint).then((r) => { if (r.sent) log('flushed crash reports', r) })
    // The updater. Everything about it is allowed to fail: a friend's launcher that
    // will not open because an update check failed is the outcome we are avoiding.
    const feed = resolveFeed({ config: cfg.load(), siteUrl: state.siteInfo?.url })
    state.updater = new AutoUpdater({
      feedUrl: feed,
      currentVersion: app.getVersion(),
      gate: state.gate,
      log: (...a) => log('updater', ...a),
      // The same password the player already typed to see the site. Never logged.
      sitePassword: cfg.load().sitePassword || null,
    })
    state.updater.on('ready', (r) => push('toast', {
      kind: 'info',
      text: `Version ${r.version} is ready. It will be applied the next time you start ENW Zombies — never during a game.`,
    }))
    state.updater.on('status', () => push('update', state.updater.status()))
    state.updater.start()

    // ENW_SMOKE_MS: boot, report what came up, quit. Lets the whole app be tested on a
    // machine somebody is using without leaving a window on their screen, and makes
    // "does it start" a command rather than a look.
    if (process.env.ENW_SMOKE_MS) {
      if (process.env.ENW_SMOKE_HIDDEN !== '0') state.win?.hide()
      setTimeout(async () => {
        const wc = state.siteView?.webContents
        const report = {
          ok: true,
          appVersion: app.getVersion(),
          electron: process.versions.electron,
          window: !!state.win,
          tray: !!state.tray,
          site: { url: wc?.getURL(), title: wc?.getTitle(), loading: wc?.isLoading(), what: state.siteInfo?.what, probed: state.siteInfo?.probed },
          shellTitle: state.win?.webContents.getTitle(),
          setup: setup.status().installed,
          preloadApi: await state.win?.webContents.executeJavaScript('Object.keys(window.enw||{}).length').catch((e) => `ERROR ${e.message}`),
          shellRendered: await state.win?.webContents.executeJavaScript(
            // `rail` is reported so it can be asserted ABSENT: the launcher draws no map
            // list and no Play button of its own any more, and a smoke run that stopped
            // mentioning it could not tell a removal from a regression.
            'JSON.stringify({rail:!!document.getElementById("rail"),mapList:!!document.getElementById("mapList"),screen:[...document.querySelectorAll(".screen.on")].map(x=>x.id),status:document.getElementById("statusBody").innerText.replace(/\\n/g," | ")})'
          ).catch((e) => `ERROR ${e.message}`),
          consoleMessages: state.consoleMessages.slice(0, 20),
          deepLink: parseDeepLink('https://zombies.enw.gg/m/nazi_zombie_sumpf'),
          deepLinkProto: parseDeepLink('enwzombies://m/nazi_zombie_ali'),
        }
        // ENW_SMOKE_BOOT: render the boot screen from a synthetic snapshot, so its
        // layout can be checked without a game and without the game lock.
        if (process.env.ENW_SMOKE_BOOT) {
          showSite(false)
          push('boot', {
            map: 'nazi_zombie_prototype',
            mode: 'verified',
            matchId: 'm_cb6efc86',
            host: '127.0.0.1:28964',
            steps: [
              { id: 'reserving', state: 'done', detail: 'match m_cb6efc86, invite token issued' },
              { id: 'loading', state: 'done', detail: 'Nacht der Untoten is up on 127.0.0.1:28964 (round 1)' },
              { id: 'ready', state: 'done', detail: 'the server is ready on 127.0.0.1:28964' },
              { id: 'launching', state: 'done', detail: 'World at War is running (process 31204)' },
              { id: 'in_game', state: 'active', detail: 'waiting for the game to connect', simulated: true },
            ],
            simulated: ['in_game'],
            notes: [
              'invite token offered over a private pipe (\\\\.\\pipe\\enw-launch-1f3c…) — never on the command line',
              'cleared a leftover crash marker (dead process 27156) that would have shown "Run In Safe Mode?"',
              'World at War asked to change your graphics settings; ENW answered No and kept yours.',
              'Steam restarted the game as process 31204',
            ],
            dialogs: [],
          })
          await new Promise((r) => setTimeout(r, 400))
        }
        // ENW_SMOKE_SETUP=1: press the first-run Install button, the way a player
        // does. This is the path that shipped broken — the package had no client DLL,
        // so setup had nothing to install and the rail just said "not installed yet".
        if (process.env.ENW_SMOKE_SETUP) {
          report.setup_click = await state.win?.webContents.executeJavaScript(
            `(async () => {
               const btn = [...document.querySelectorAll('#frActions button')]
                 .find((b) => /Install the ENW client/i.test(b.textContent))
               if (!btn) return 'no install button; first-run screen shows: ' +
                 (document.getElementById('frBody').innerText || '').slice(0, 200)
               btn.click()
               await new Promise((r) => setTimeout(r, 8000))
               // \\s, not \\s-in-a-template-literal: this code is inside a JS template
               // string, so a single backslash is eaten before the page ever sees it
               // and the regex becomes /s+/g — which replaces every letter "s" with a
               // space. The smoke report read "In talling ... c:\\program file (x86)"
               // and we nearly went looking for an encoding bug that was not there.
               return (document.getElementById('frBody').innerText || '').replace(/\\s+/g, ' ').slice(0, 400)
             })()`
          ).catch((e) => `ERROR ${e.message}`)
        }

        // ENW_SMOKE_SIGNIN=1: press Sign in the way a player does and wait for the
        // round trip to finish. With ENW_SIGNIN_NO_BROWSER the URL is logged instead of
        // opened, so the whole handshake can be driven from a script.
        if (process.env.ENW_SMOKE_SIGNIN) {
          report.signIn = await state.win?.webContents.executeJavaScript(
            `window.enw.signIn().then((s) => 'signed in as ' + (s.name || s.steamid) + (s.mock ? ' (MOCK)' : ' (real)'), (e) => 'ERROR ' + e.message)`
          ).catch((e) => `ERROR ${e.message}`)
          report.signIn_session = settings.session()
          try { report.signIn_me = (await state.api.req('/api/me')).data } catch (e) { report.signIn_me = `ERROR ${e.message}` }
        }

        // ENW_SMOKE_SCREEN=settings|detail: open that screen before the screenshot.
        if (process.env.ENW_SMOKE_SCREEN) {
          const id = { settings: 'settingsPill', detect: 'setupPill' }[process.env.ENW_SMOKE_SCREEN] || 'settingsPill'
          await state.win?.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`).catch(() => {})
          showSite(false)
          await new Promise((r) => setTimeout(r, 900))
        }
        // ENW_SMOKE_PLAYLOCAL=<bsp>: start a local game the way the SITE does.
        //
        // It used to click the launcher rail's map row and then its Play Local button.
        // There is no rail: Play Local is on the site's own map page and it calls
        // `window.enw.playLocal`, which is exactly what this calls. The button it used
        // to press is the site's now, and the site has its own tests for it.
        if (process.env.ENW_SMOKE_PLAYLOCAL) {
          const bsp = process.env.ENW_SMOKE_PLAYLOCAL
          report.playLocal = await state.win?.webContents.executeJavaScript(
            `(async () => {
               try { await window.enw.playLocal(${JSON.stringify(bsp)}) } catch (e) { return 'ERROR ' + e.message }
               await new Promise((r) => setTimeout(r, 4000))
               return 'started; boot screen: ' + [...document.querySelectorAll('#bootSteps .step')]
                 .map((s) => s.querySelector('.title').textContent + '=' + (s.className.replace('step ','') || 'pending')).join(' | ')
             })()`
          ).catch((e) => `ERROR ${e.message}`)
        }
        if (process.env.ENW_SMOKE_SHOT) {
          // The site lives in a native child view, so the window's own webContents
          // captures the chrome only. Grab both and say so.
          //
          // TIME-BOXED, because `capturePage()` on a view that is NOT VISIBLE never
          // resolves. The moment a screen hides the site view -- which is now every
          // first-run and settings screen -- an untimed capture hangs the whole smoke
          // run with the report already built and never printed, which looks exactly
          // like a crash. A screenshot is the least important thing here; it must never
          // be the thing that stops the report.
          for (const [name, target] of [['chrome', state.win?.webContents], ['site', wc]]) {
            try {
              const img = await Promise.race([
                target.capturePage(),
                new Promise((_r, rej) => setTimeout(() => rej(new Error('capturePage timed out (the view is probably hidden)')), 5000)),
              ])
              const f = path.join(P.logs, `smoke-${name}.png`)
              fs.writeFileSync(f, img.toPNG())
              report[`shot_${name}`] = f
            } catch (e) { report[`shot_${name}`] = `ERROR ${e.message}` }
          }
        }
        console.log('ENW_SMOKE_REPORT ' + JSON.stringify(report))
        state.quitting = true
        app.quit()
      }, Number(process.env.ENW_SMOKE_MS))
    }
  })

  app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url) })
  app.on('window-all-closed', () => { /* tray keeps us alive */ })
  app.on('before-quit', () => {
    state.quitting = true
    try { state.flow?.cancel('the launcher is closing') } catch {}
    // The referee is our child and it dies with us. An orphan would hold the game-link
    // port and referee games for a launcher that no longer exists — and it would only
    // ever be noticed as "the next game recorded nothing".
    try { state.localRun?.stop() } catch {}
    try { if (hostAgent().stop()) log('hostagent', 'stopped the host agent we started') } catch {}
    // Applying is the only moment an update can disturb anything, so it happens here,
    // and only when no game is running and nothing is installing.
    try { state.updater?.applyIfSafe() } catch {}
  })
}
