// Keeping three friends' launchers current without ever breaking one.
//
// B's words: "so it doesn't break, so they can keep using the same client." That is
// the whole specification, and it means the guarantees run the other way from a normal
// updater — **the launcher must start and must play even when every part of this fails.**
// No feed, a bad feed, no network, a half-downloaded update, a corrupt one: all of them
// end with a working launcher on the version it already had.
//
// So every path here is wrapped, nothing here can throw into the caller, and an update
// is never *applied* at a moment that could interrupt anything:
//
//   check     on launch, once, in the background
//   download  in the background, gated on nothing being busy
//   apply     on quit, and only when no game is running and nothing is installing
//
// The feed is a plain static directory (electron-updater's "generic" provider), so it
// can live in whichever bucket B picks or on the site, and moving it is a config change:
// ZM_UPDATE_FEED > config.updateFeed > the site's /updates.
import { EventEmitter } from 'node:events'

export class AutoUpdater extends EventEmitter {
  constructor({ feedUrl, currentVersion, gate, log = () => {} }) {
    super()
    this.feedUrl = feedUrl || null
    this.currentVersion = currentVersion
    this.gate = gate                 // the IdleGate: blocked while in game / installing
    this.log = log
    this.state = {
      feed: this.feedUrl,
      current: currentVersion,
      checked: false,
      available: null,               // version string when there is one
      downloaded: null,
      error: null,
      enabled: !!this.feedUrl,
    }
    this.updater = null
  }

  status() { return { ...this.state } }

  // Nothing in here may throw. A friend's launcher that will not open because the
  // update check failed is the exact outcome we are avoiding.
  async start() {
    if (!this.feedUrl) {
      this.state.error = 'no update feed configured'
      this.log('updates: no feed configured; staying on', this.currentVersion)
      this.emit('status', this.status())
      return
    }
    try {
      const mod = await import('electron-updater')
      const updater = mod.autoUpdater || mod.default?.autoUpdater
      if (!updater) throw new Error('electron-updater did not export autoUpdater')
      this.updater = updater

      updater.autoDownload = false          // we decide when, see below
      updater.autoInstallOnAppQuit = false  // and we decide whether, on quit
      updater.allowDowngrade = false
      updater.logger = null
      updater.setFeedURL({ provider: 'generic', url: this.feedUrl })

      updater.on('error', (e) => {
        // Errors here are normal: no network, a feed that is not there yet, a
        // half-written file in the bucket. Record and carry on.
        this.state.error = String(e?.message || e)
        this.log('updates: check failed —', this.state.error)
        this.emit('status', this.status())
      })
      updater.on('update-available', (info) => {
        this.state.available = info?.version || null
        this.log('updates:', this.state.available, 'is available; downloading in the background')
        this.emit('status', this.status())
        // Download when nothing is busy. `when` already means "not in game, not
        // mid-install, not mid-action".
        this.gate.when(() => {
          updater.downloadUpdate().catch((e) => {
            this.state.error = String(e?.message || e)
            this.log('updates: download failed —', this.state.error)
            this.emit('status', this.status())
          })
        })
      })
      updater.on('update-not-available', () => {
        this.log('updates: already on the latest (', this.currentVersion, ')')
        this.emit('status', this.status())
      })
      updater.on('update-downloaded', (info) => {
        this.state.downloaded = info?.version || this.state.available
        this.log('updates:', this.state.downloaded, 'is ready and will be applied when you next start')
        this.emit('ready', { version: this.state.downloaded })
        this.emit('status', this.status())
      })

      this.log('updates: checking', this.feedUrl)
      this.state.checked = true
      await updater.checkForUpdates()
    } catch (e) {
      this.state.error = String(e?.message || e)
      this.log('updates: disabled —', this.state.error)
      this.emit('status', this.status())
    }
  }

  // Called on quit. Applies only a fully downloaded update, and only when nothing is
  // going on — a game running or a map installing means we leave it for next time
  // rather than restarting into an interrupted download.
  applyIfSafe() {
    try {
      if (!this.updater || !this.state.downloaded) return false
      if (this.gate?.blocked) {
        this.log('updates: not applying —', this.gate.why.join('; '))
        return false
      }
      this.log('updates: applying', this.state.downloaded)
      this.updater.quitAndInstall(true, false)
      return true
    } catch (e) {
      this.log('updates: could not apply —', e?.message || e)
      return false
    }
  }
}

// ZM_UPDATE_FEED > config.updateFeed > the site's own /updates directory. Returns null
// when there is nothing to check, which is a supported state, not an error.
export function resolveFeed({ env = process.env, config = {}, siteUrl = null } = {}) {
  const pick = env.ZM_UPDATE_FEED || config.updateFeed || null
  if (pick) return String(pick).replace(/\/$/, '')
  if (siteUrl && !siteUrl.startsWith('file:')) return `${String(siteUrl).replace(/\/$/, '')}/updates`
  return null
}
