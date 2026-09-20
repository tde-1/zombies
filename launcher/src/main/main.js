// The ENW Zombies launcher.
//
// Shape (spec 13 §2 / 99 §4.3):
//   * an Electron app that LOOKS LIKE THE LOGGED-IN SITE, because it wraps the live
//     site rather than reimplementing it;
//   * the chrome around it is ours: a right-hand rail whose top card is the selected
//     map + Play (Movement's party-rail top card), and a full-window boot screen;
//   * window + tray — closing the window minimises, quit from the tray;
//   * deep links: zombies.enw.gg/m/<map> and enwzombies://m/<map>;
//   * NO OVERLAY, EVER. B was emphatic. The site lives in a native WebContentsView and
//     our chrome sits BESIDE it, never on top of the game. When the boot screen or
//     first-run wizard needs the whole window, the site view is hidden, not covered.
import { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, shell, dialog, nativeImage, session as electronSession } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { P, ensureDirs } from './paths.js'
import * as cfg from './config.js'
import * as detect from './detect.js'
import * as setup from './setup.js'
import * as settings from './settings.js'
import * as crash from './crash.js'
import * as lock from './gamelock.js'
import { Updater, IdleGate, applyPending, pending } from './updates.js'
import { BootFlow } from './bootflow.js'
import * as library from './library.js'
import { SiteApi, electronCookieProvider } from './siteapi.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(HERE, '..', 'renderer')
// .cjs, not .js: Electron decides a preload's module type by extension, and this app
// is "type": "module". An ambiguous preload fails at load with nothing useful in it.
const PRELOAD = path.resolve(HERE, '..', 'preload', 'preload.cjs')
const RAIL_WIDTH = 320
const TOPBAR_HEIGHT = 44

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
}

// ------------------------------------------------------------------- logging --

ensureDirs()
const LOG = path.join(P.logs, 'launcher.log')
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
  try { fs.appendFileSync(LOG, line + '\n') } catch {}
  console.log(line)
}

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
  state.siteView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width: Math.max(0, w - RAIL_WIDTH), height: Math.max(0, h - TOPBAR_HEIGHT) })
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
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
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

  // The site API shares the page's cookie jar, so a signed-in page means signed-in API
  // calls from the main process — one session, no second auth path, nothing to leak
  // (launcher-v0 §1). Without a site we simply have no api and Play stays local-only.
  state.api = null
  if (!state.siteInfo.placeholder) {
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
    } catch (e) {
      log('site hello failed', e.message)
    }
  }

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

// ----------------------------------------------------------------- deep links --

// zombies.enw.gg/m/<map>  and  enwzombies://m/<map>
export function parseDeepLink(raw) {
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

function handleDeepLink(raw) {
  const link = parseDeepLink(raw)
  if (!link) return
  log('deep link', raw, link)
  if (!state.win) { state.pendingDeepLink = link; return }
  state.win.show(); state.win.focus()
  push('deeplink', link)
}

function linkFromArgv(argv) {
  return argv.find((a) => /^enwzombies:/i.test(a) || /^https?:\/\/(zombies|zm)\.enw\.gg\//i.test(a)) || null
}

// -------------------------------------------------------------------- the IPC --

function wireIpc() {
  const handle = (name, fn) => ipcMain.handle(`enw:${name}`, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) } } catch (e) {
      log('ipc error', name, e.message)
      return { ok: false, error: e.message }
    }
  })

  handle('status', async () => ({
    appVersion: app.getVersion(),
    site: state.siteInfo,
    setup: setup.status(),
    session: settings.session(),
    settings: settings.get(),
    config: cfg.load(),
    enwRoot: P.root,
    pendingUpdate: pending(),
    gameLock: lock.enabled() ? lock.read() : { held: false, note: 'not a dev box' },
    lastError: state.lastError,
    site_api: state.api ? { protocol: 0, auth: state.api.hello?.auth, you: state.api.who, capabilities: state.api.hello?.capabilities } : null,
  }))

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
      throw e
    } finally { state.gate.unblock('setup') }
  })
  handle('storage', () => setup.storage())

  // The real map library (archive agent's 14 normalised maps). The rail shows `title`;
  // only the engine ever sees `bsp`.
  handle('maps', () => library.catalogue())
  handle('installMap', async (bsp) => {
    state.gate.block('mapinstall', 'a map is installing')
    try {
      // From the site when we are connected to one — that is the only route that
      // works on anybody else's machine. The local archive is the dev fallback.
      const onProgress = (p) => push('mapProgress', { bsp, ...p })
      if (state.api && state.api.can('map_downloads')) {
        return await library.installFromSite(bsp, { api: state.api, onProgress })
      }
      return library.install(bsp, { onProgress })
    } catch (e) {
      await reportCrash('map_failed', e, { bsp })
      throw e
    } finally { state.gate.unblock('mapinstall') }
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

  handle('signIn', async () => {
    // MOCK. Real sign-in is Steam OpenID in a browser window against the site; there is
    // no site and no secret locally, so we use the Steam account this PC is signed into
    // — which is at least a real SteamID, and makes the rest of the flow honest.
    const acct = await detect.steamAccount()
    if (!acct.current) throw new Error('No Steam account is signed in on this PC, so there is nothing to sign in as yet.')
    const s = settings.signIn({ steamid: acct.current.steamid, name: acct.current.persona || acct.current.account, mock: true })
    push('session', s)
    return s
  })
  handle('signOut', () => { const s = settings.signOut(); push('session', s); return s })

  handle('getSettings', () => settings.get())
  handle('setSettings', (patch) => { const s = settings.set(patch); push('settings', s); return s })

  async function startPlay(opts = {}) {
    if (state.flow) throw new Error('A launch is already in progress.')
    const conf = cfg.load()
    const s = settings.get()
    const sess = settings.session()
    const flow = new BootFlow({
      map: opts.map,
      mode: opts.mode || 'custom',
      // launcher-v0: when the site is there, IT leases and we watch. The old
      // mock-site lease path stays only for a machine with no site running.
      api: opts.local ? null : state.api,
      siteUrl: opts.hostApi || conf.hostApi,
      hostDashboard: conf.hostDashboard,
      linkHost: conf.linkHost,
      steamid: sess.steamid,
      playerName: sess.name,
      settings: s,
      stealth: conf.stealthLaunch,
      useGameLock: conf.useGameLock,
      localMap: opts.local ? opts.map : null,
      fsGame: opts.fsGame || undefined,
      lockName: 'launcher',
    })
    state.flow = flow
    state.gate.block('game', 'a game is starting or running')
    state.tray?.rebuild()
    showSite(false)
    push('boot', flow.snapshot())
    flow.on('update', (snap) => push('boot', snap))
    flow.on('ended', async (p) => {
      if (p.phase === 'failed') await reportCrash('game_crash', new Error(p.detail || 'the game ended unexpectedly'), { map: opts.map })
      state.flow = null
      state.gate.unblock('game')
      state.tray?.rebuild()
      showSite(true)
      push('boot_done', { ...flow.snapshot(), phase: p.phase, detail: p.detail })
    })
    const clear = () => {
      if (state.flow !== flow) return
      state.flow = null
      state.gate.unblock('game')
      state.tray?.rebuild()
      showSite(true)
    }
    flow.run().then((snap) => {
      push('boot', snap)
      // A step can fail without the game ever starting (no server, setup missing), in
      // which case there is no 'ended' event to clean up after us. Without this the
      // launcher refuses every later Play with "a launch is already in progress".
      if (snap.failed) clear()
    }).catch(async (e) => {
      await reportCrash('server_unreachable', e, { map: opts.map })
      push('boot', { ...flow.snapshot(), error: e.message })
      clear()
    })
    return flow.snapshot()
  }

  handle('play', (opts) => startPlay(opts))

  // web's `window.enw.playLocal(session)`. Accepts either a map key or the whole
  // `/local/start` response, because they offered the latter — but the launcher
  // prefers to make that call itself: it is the thing that has to INSTALL the map
  // first, and a match opened before an install that then fails is an orphan.
  handle('playLocal', async (arg = {}) => {
    const mapKey = arg.map_key || arg.map || arg.mapKey || arg?.map?.key
    if (!mapKey) throw new Error('playLocal needs a map key')
    // Install first if we have to: the site opening a match before an install that
    // then fails would leave an orphan.
    if (!library.isInstalled(mapKey) && library.catalogue().maps.some((m) => m.bsp === mapKey && m.available)) {
      push('toast', { kind: 'info', text: 'Downloading the map…' })
      library.install(mapKey, { onProgress: (p) => push('mapProgress', { bsp: mapKey, ...p }) })
    }
    return startPlay({
      map: mapKey,
      mode: 'local',
      local: true,
      fsGame: arg.fs_game || arg.map?.fs_game || null,
      // If the page already called /local/start, reuse its match rather than opening
      // a second one.
      prestarted: arg.match_id ? arg : null,
    })
  })

  handle('cancelPlay', () => { state.flow?.cancel('you cancelled'); showSite(true); return true })
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
}

async function reloadSite(url) {
  if (url) cfg.save({ siteUrl: url })
  state.siteInfo = await cfg.resolveSiteUrl()
  await state.siteView?.webContents.loadURL(state.siteInfo.url).catch(() => {})
  push('site', { loaded: true, url: state.siteInfo.url, what: state.siteInfo.what })
  return state.siteInfo
}

// -------------------------------------------------------------------- startup --

const single = app.requestSingleInstanceLock()
if (!single) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const link = linkFromArgv(argv)
    if (link) handleDeepLink(link)
    else { state.win?.show(); state.win?.focus() }
  })

  app.whenReady().then(async () => {
    // Updates are applied HERE, before anything opens: the only moment that is never
    // mid-game and never mid-action (spec 13 §2).
    try {
      const r = applyPending({ gameDir: P.game })
      if (r.applied) log('applied a pending update', r.version, r.done.join('; '))
    } catch (e) { log('could not apply a pending update', e.message) }

    // Deep-link protocol registration. Harmless if it fails (unpackaged dev run).
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

    if (state.pendingDeepLink) { push('deeplink', state.pendingDeepLink); state.pendingDeepLink = null }
    const link = linkFromArgv(process.argv)
    if (link) handleDeepLink(link)

    // Silently send anything that failed to send last time, then start the update lane.
    crash.flush(cfg.load().crashEndpoint).then((r) => { if (r.sent) log('flushed crash reports', r) })
    const up = new Updater({ feed: cfg.load().updateFeed, currentVersion: app.getVersion() })
    up.on('staged', (s) => push('toast', { kind: 'info', text: `An update is ready and will be applied ${s.appliesWhen}.` }))
    up.start()

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
            'JSON.stringify({rail:!!document.getElementById("rail"),maps:document.querySelectorAll("#mapList button").length,screen:[...document.querySelectorAll(".screen.on")].map(x=>x.id),status:document.getElementById("statusBody").innerText.replace(/\\n/g," | ")})'
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
        // ENW_SMOKE_SCREEN=settings|detail: open that screen before the screenshot.
        if (process.env.ENW_SMOKE_SCREEN) {
          const id = { settings: 'settingsPill', detect: 'setupPill' }[process.env.ENW_SMOKE_SCREEN] || 'settingsPill'
          await state.win?.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`).catch(() => {})
          showSite(false)
          await new Promise((r) => setTimeout(r, 900))
        }
        // ENW_SMOKE_PLAYLOCAL=<bsp>: click the rail's map and press Play Local, the
        // way B will. Proves the button, not just the plumbing behind it.
        if (process.env.ENW_SMOKE_PLAYLOCAL) {
          const bsp = process.env.ENW_SMOKE_PLAYLOCAL
          report.playLocal = await state.win?.webContents.executeJavaScript(
            `(async () => {
               const btns = [...document.querySelectorAll('#mapList button')]
               const b = btns.find((x) => (x.title || '').includes(${JSON.stringify(bsp)}))
               if (!b) return 'no such map in the rail'
               b.click()
               await new Promise((r) => setTimeout(r, 300))
               // If the map is not installed the primary button says Install. Press it
               // and wait: these are hundreds of MB, so the wait is the point.
               const primary = document.getElementById('playBtn')
               if (/^Install/.test(primary.textContent)) {
                 primary.click()
                 const until = Date.now() + 600000
                 while (Date.now() < until && !document.getElementById('playLocalBtn').disabled === false) {
                   await new Promise((r) => setTimeout(r, 1000))
                   if (!document.getElementById('playLocalBtn').disabled) break
                 }
               }
               const pl = document.getElementById('playLocalBtn')
               if (pl.disabled) return 'Play Local is disabled: ' + document.getElementById('cardNote').textContent
               pl.click()
               await new Promise((r) => setTimeout(r, 4000))
               return 'clicked; boot screen: ' + [...document.querySelectorAll('#bootSteps .step')]
                 .map((s) => s.querySelector('.title').textContent + '=' + (s.className.replace('step ','') || 'pending')).join(' | ')
             })()`
          ).catch((e) => `ERROR ${e.message}`)
        }
        if (process.env.ENW_SMOKE_SHOT) {
          // The site lives in a native child view, so the window's own webContents
          // captures the chrome only. Grab both and say so.
          for (const [name, target] of [['chrome', state.win?.webContents], ['site', wc]]) {
            try {
              const img = await target.capturePage()
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
  })
}
