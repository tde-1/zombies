// "Check for updates" — the button, and the five sentences behind it.
//
// This is the PLAYER-DRIVEN lane. `autoupdate.js` is the silent one: it checks once on
// launch, downloads when nothing is busy, and applies on quit. Neither of those tells
// the player anything, which is right for the background and wrong for a button. The two
// share a feed and an `electron-updater` instance shape but not a state machine, because
// their failure rules are opposite: the silent lane must be invisible when it fails, and
// this one exists precisely to SAY what happened.
//
// Everything a player can be shown is one short line, and the whole list is here:
//
//   Checking…
//   You are up to date (0.2.2)
//   Downloading 37%
//   Ready to install                      ← and only now does "Restart and update" exist
//   The update server could not be reached. Try again later. (<technical detail>)
//   Updates only work in an installed copy … (a dev checkout)
//
// "No feed reachable" is its own message on purpose. A 404 from the bucket, a DNS
// failure on a plane, and a timeout behind a captive portal are three different errnos
// and ONE fact for the player: we could not ask. B's own log has three lines of
// `updates: check failed — net::ERR_ABORTED` from what was really a 401 behind the beta
// gate (autoupdate.js says so at length), and `net::ERR_ABORTED` is exactly the kind of
// string that makes a player think their launcher is broken. The errno still goes in
// the parentheses and in launcher.log — we lose no evidence, we just stop leading with it.
import { EventEmitter } from 'node:events'

// Progress is logged at these marks and nowhere else. electron-updater emits
// `download-progress` per chunk — a 94 MB installer produces hundreds of them, and a
// launcher.log where the download drowns out the launch is a log nobody reads. The UI
// still sees every event; only the FILE is thinned.
const LOG_EVERY_PCT = 10

// The reasons that all mean "we could not ask the update server".
//
// MEASURED strings, from electron-updater and from Chromium's net stack as they have
// actually appeared in launcher.log or in these tests: `net::ERR_ABORTED`,
// `net::ERR_NAME_NOT_RESOLVED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `ECONNREFUSED`,
// `ECONNRESET`, and electron-updater's own `Cannot find latest.yml in the latest release
// artifacts` / `HttpError: 404`. INFERRED, not measured: that this list is complete. It
// is not, and it does not need to be — see `isUnreachable`, which treats any HTTP status
// it can find and any `net::`/`ERR_`/`E…` code as unreachable, so a new spelling of the
// same failure lands in the right sentence rather than in the player's face.
const UNREACHABLE = /\b(net::|ERR_[A-Z_]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|UNABLE_TO_VERIFY|CERT_)/i
const HTTP_FAIL = /\b(?:HttpError|status(?:\s*code)?[:= ]*)\s*(4\d\d|5\d\d)\b|\b(404|403|401|500|502|503|504)\b/i
const NO_MANIFEST = /cannot find (latest|.*\.yml)|latest\.yml|404 not found|not found/i

export function isUnreachable(err) {
  const s = String(err?.message || err || '')
  return UNREACHABLE.test(s) || HTTP_FAIL.test(s) || NO_MANIFEST.test(s)
}

// The one place a raw error becomes a sentence. Always returns
// `{ kind, text, detail }`; `text` is what the player reads and `detail` is the
// technical half, which is ALSO inside `text` in parentheses — the house rule is that
// the player never has to ask us what really happened.
export function explain(err) {
  const detail = String(err?.message || err || 'no detail')
  if (isUnreachable(err)) {
    return {
      kind: 'unreachable',
      detail,
      text: `The update server could not be reached. Your launcher is fine — try again later. (${detail})`,
    }
  }
  return { kind: 'failed', detail, text: `The update could not be checked. (${detail})` }
}

// The line under the button, for every state. Kept as a pure function of the state so a
// test can assert the exact strings the player sees without an Electron run — these are
// the words, and words are the feature.
export function describe(s) {
  switch (s.phase) {
    case 'idle': return ''
    case 'checking': return 'Checking…'
    case 'up_to_date': return `You are up to date (${s.current})`
    // 0.2.11: the check is automatic and the download is the player's call (B: "Update
    // now / Restart now / Update later"), so "available" no longer promises a download.
    case 'available': return `Update ${s.available} available`
    case 'downloading': return `Downloading ${Math.max(0, Math.min(100, Math.round(s.percent || 0)))}%`
    case 'ready': return 'Ready to install'
    case 'unsupported': return s.message || 'Updates are not available in this copy.'
    default: return s.message || 'The update could not be checked.'
  }
}

export class UpdateCheck extends EventEmitter {
  // `loadUpdater` is injected so the whole state machine can be driven by a fake in
  // test/run-all.js. In the app it is `() => import('electron-updater')`.
  constructor({
    feedUrl = null,
    currentVersion = '0.0.0',
    authHeader = null,
    isDev = false,
    log = () => {},
    loadUpdater = () => import('electron-updater'),
  } = {}) {
    super()
    this.feedUrl = feedUrl
    this.currentVersion = currentVersion
    this.authHeader = authHeader
    this.isDev = isDev
    this.log = log
    this.loadUpdater = loadUpdater
    this.updater = null
    this.busy = false
    this._lastLoggedPct = -LOG_EVERY_PCT
    this.state = {
      phase: 'idle',
      current: currentVersion,
      available: null,
      downloaded: null,
      percent: 0,
      message: '',
      detail: null,
      canInstall: false,
      // "Later" (0.2.11): the player hid the nav chip for this session. Held in the main
      // process, not the page, so a reload or the fallback page does not bring it back;
      // the next launch does, because this object is new.
      later: false,
      feed: feedUrl,
    }
  }

  status() { return { ...this.state, message: describe(this.state) || this.state.message } }

  _set(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.status())
  }

  _fail(err, where) {
    const e = explain(err)
    this.log(`${where} failed — ${e.kind === 'unreachable' ? 'no feed reachable' : 'error'}: ${e.detail}`)
    this._set({ phase: e.kind === 'unreachable' ? 'unreachable' : 'failed', message: e.text, detail: e.detail, canInstall: false })
    return this.status()
  }

  // Never throws. The button must always come back to a state, and "it threw" is not a
  // state a player can read.
  async check() {
    if (this.busy) { this.log('check ignored: one is already running'); return this.status() }
    this.busy = true
    this._lastLoggedPct = -LOG_EVERY_PCT
    try {
      this._set({ phase: 'checking', percent: 0, available: null, downloaded: null, detail: null, canInstall: false })
      this.log('check started, feed', this.feedUrl || '(none configured)', 'current', this.currentVersion)

      // A DEV CHECKOUT IS NOT A FAILURE, and electron-updater says so by throwing
      // `Skip checkForUpdates because application is not packed and dev update config
      // is not forced`. Thrown out of an IPC handler that becomes a red error toast
      // that reads like the updater is broken, in the one situation where it is working
      // exactly as designed. So it is answered before it is asked.
      if (this.isDev) {
        const message = 'Updates only work in an installed copy of ENW Zombies. This is a development checkout, so there is nothing to update to.'
        this.log('not checking: development checkout (electron-updater refuses to run unpacked)')
        this._set({ phase: 'unsupported', message })
        return this.status()
      }
      if (!this.feedUrl) {
        const message = 'No update server is configured for this copy, so there is nothing to check.'
        this.log('not checking: no feed configured')
        this._set({ phase: 'unsupported', message })
        return this.status()
      }

      const updater = await this._updater()
      const r = await updater.checkForUpdates()
      // `checkForUpdates()` resolves BEFORE the events settle, and on the
      // already-latest path it may resolve with no `updateInfo` at all. The events
      // below are what move the state; this only records what the call itself returned.
      this.log('check returned', r?.updateInfo?.version ? `version ${r.updateInfo.version}` : 'no version in the result')
      return this.status()
    } catch (e) {
      return this._fail(e, 'check')
    } finally {
      this.busy = false
    }
  }

  async _updater() {
    if (this.updater) return this.updater
    const mod = await this.loadUpdater()
    const updater = mod.autoUpdater || mod.default?.autoUpdater || mod.default || mod
    if (!updater || typeof updater.checkForUpdates !== 'function') throw new Error('electron-updater did not export a usable autoUpdater')

    // ~~autoDownload = true, "the player asked"~~ — 0.2.11: the check runs by itself on
    // every launch (`attach()` + the silent lane), so the download waits for Update now
    // (`download()` below).
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false  // applying is still ours to time
    updater.allowDowngrade = false
    updater.logger = null
    if (this.authHeader) {
      updater.requestHeaders = { ...(updater.requestHeaders || {}), Authorization: this.authHeader }
      this.log('sending the beta password with update requests')
    }
    try { updater.setFeedURL({ provider: 'generic', url: this.feedUrl }) } catch (e) { this.log('setFeedURL refused —', e.message) }

    updater.on('error', (e) => this._fail(e, 'update'))
    updater.on('update-available', (info) => {
      const v = info?.version || null
      this.log('update available:', v)
      this._set({ phase: 'available', available: v, percent: 0 })
    })
    updater.on('update-not-available', () => {
      this.log('result: already on', this.currentVersion)
      this._set({ phase: 'up_to_date', percent: 0, canInstall: false })
    })
    updater.on('download-progress', (p) => {
      const pct = Number(p?.percent) || 0
      this._set({ phase: 'downloading', percent: pct })
      if (pct >= this._lastLoggedPct + LOG_EVERY_PCT || pct >= 100) {
        this._lastLoggedPct = Math.floor(pct / LOG_EVERY_PCT) * LOG_EVERY_PCT
        this.log(`downloading ${Math.round(pct)}%`)
      }
    })
    updater.on('update-downloaded', (info) => {
      const v = info?.version || this.state.available
      this.log('downloaded', v, '— ready to install')
      this._set({ phase: 'ready', downloaded: v, percent: 100, canInstall: true })
    })

    this.updater = updater
    return updater
  }

  // 0.2.11: listen to the shared electron-updater WITHOUT checking. The silent lane
  // (autoupdate.js) runs the launch-time check; attaching first means its
  // `update-available` moves THIS state machine too, which is what puts "Update 0.2.11"
  // in the nav. Never throws; a dev checkout and a missing feed attach to nothing.
  async attach() {
    if (this.isDev || !this.feedUrl) return this.status()
    try { await this._updater() } catch (e) { this.log('attach failed —', e?.message || String(e)) }
    return this.status()
  }

  // Update now. Only meaningful once a check has found something. electron-updater hands
  // back the in-flight promise when a download is already running, so a double press is
  // one download. Progress and the end arrive as events, like everything else.
  download() {
    const s = this.state
    if (s.phase === 'ready' || s.phase === 'downloading') return this.status()
    if (!this.updater || !s.available) {
      this.log('download refused: no update has been found yet')
      return { ...this.status(), refused: 'no update has been found yet' }
    }
    this.log('download started by the player:', s.available)
    this._set({ phase: 'downloading', percent: 0, later: false })
    Promise.resolve()
      .then(() => this.updater.downloadUpdate())
      .catch((e) => this._fail(e, 'download'))
    return this.status()
  }

  // Later: hide the chip for this session. Nothing is cancelled — a download already
  // running finishes, and a finished one is still applied on quit by the silent lane.
  later() {
    this.log('player chose Later for', this.state.downloaded || this.state.available || '(nothing)')
    this._set({ later: true })
    return this.status()
  }

  // "Restart and update". Only reachable when something is actually downloaded — the
  // button does not exist otherwise — but the guard is here too, because
  // `quitAndInstall()` with nothing staged closes the launcher and opens nothing, which
  // to a player is the launcher vanishing.
  quitAndInstall() {
    try {
      if (!this.state.canInstall || !this.updater) {
        this.log('restart-and-update refused: nothing is downloaded')
        return { ok: false, why: 'nothing is downloaded yet' }
      }
      this.log('quitAndInstall called for', this.state.downloaded)
      this.updater.quitAndInstall(true, true)
      return { ok: true, version: this.state.downloaded }
    } catch (e) {
      this.log('quitAndInstall failed —', e?.message || String(e))
      return { ok: false, why: e?.message || String(e) }
    }
  }
}

// ENW_FAKE_UPDATE=<version>, a DEV CHECKOUT ONLY (main.js ignores it in a packaged app):
// an electron-updater stand-in that finds <version>, downloads it in twenty steps of
// `stepMs`, and "installs" by logging. It is how the nav chip's phases were shown in a
// dev window without publishing a release, and the tests drive the same object.
export function fakeUpdater(version, { stepMs = 300, log = () => {} } = {}) {
  const u = new EventEmitter()
  u.setFeedURL = () => {}
  u.checkForUpdates = async () => {
    setTimeout(() => u.emit('update-available', { version }), stepMs)
    return { updateInfo: { version } }
  }
  let running = null
  u.downloadUpdate = () => {
    if (running) return running
    running = new Promise((resolve) => {
      let pct = 0
      const tick = () => {
        pct = Math.min(100, pct + 5)
        u.emit('download-progress', { percent: pct })
        if (pct >= 100) { u.emit('update-downloaded', { version }); resolve([]) } else setTimeout(tick, stepMs)
      }
      setTimeout(tick, stepMs)
    })
    return running
  }
  u.quitAndInstall = (...a) => log('fake quitAndInstall', JSON.stringify(a), '(a dev checkout does not restart)')
  return u
}
