// The launcher's half of `docs/protocol/launcher-v0.md`.
//
// The important inversion, and web is right about it: **the launcher never leases a
// box.** A lease picks a game box, mints invite tokens for a roster and burns real
// server time, so a client that can ask for one turns the fleet into free hosting and
// lets the caller name its own Verified roster. The site leases, because the site is
// the thing that knows the party, the map, the mode and who is actually ready. The
// launcher presses Play and then *watches*.
//
// Auth is the session cookie, shared with the wrapped page. There is no second auth
// path and no token for the launcher to hold, which is the whole point — but the main
// process has its own cookie jar, so `cookieProvider` is injected by main.js from the
// Electron session. Without it (the CLIs) the client is simply signed out and says so.
import { EventEmitter } from 'node:events'

export const PROTOCOL = 0

export class SiteApi extends EventEmitter {
  constructor({ baseUrl, cookieProvider = null, appVersion = '0.0.0' } = {}) {
    super()
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:3200').replace(/\/$/, '')
    this.cookieProvider = cookieProvider
    this.appVersion = appVersion
    this.hello = null
  }

  async req(path, { method = 'GET', body = null, timeoutMs = 6000 } = {}) {
    const headers = {
      accept: 'application/json',
      // Web asked how to tell "this is the launcher, not a browser" — this, plus
      // `window.enw` existing in the page for the client side.
      'x-enw-launcher': this.appVersion,
    }
    if (body) headers['content-type'] = 'application/json'
    const cookie = this.cookieProvider ? await this.cookieProvider(this.baseUrl).catch(() => null) : null
    if (cookie) headers.cookie = cookie

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { ok: res.ok, status: res.status, data, text }
  }

  // Once at startup. Replaces probing ports and guessing what the site can do.
  async sayHello() {
    const r = await this.req('/api/launcher/hello')
    if (!r.ok || !r.data) throw new Error(`the site did not answer /api/launcher/hello (${r.status})`)
    if (r.data.protocol !== PROTOCOL) {
      // Not fatal: say so and carry on. A version mismatch that bricks the launcher is
      // worse than one that degrades.
      this.emit('protocol_mismatch', { site: r.data.protocol, launcher: PROTOCOL })
    }
    this.hello = r.data
    return r.data
  }

  can(cap) { return !!this.hello?.capabilities?.[cap] }
  get signedIn() { return !!this.hello?.you }
  get who() { return this.hello?.you || null }

  // The boot screen's source of truth. `state` is decided by the site so the two
  // cannot disagree about what is happening.
  async play() {
    const r = await this.req('/api/launcher/play')
    if (r.status === 401) return { signedOut: true }
    if (!r.ok) throw new Error(r.data?.error || `the site answered ${r.status}`)
    return r.data
  }

  async startPlay({ mapKey, mode = 'custom', force = false }) {
    const r = await this.req('/api/launcher/play', { method: 'POST', body: { map_key: mapKey, mode, force } })
    if (r.ok) return { ok: true, ...r.data }
    // 409/403 carry a message written for a player to read. Show it, do not rewrite it.
    return { ok: false, status: r.status, error: r.data?.error || `the site answered ${r.status}`, party: r.data?.party || null }
  }

  async cancel() {
    const r = await this.req('/api/launcher/cancel', { method: 'POST', body: {} })
    return { ok: r.ok, ...(r.data || {}) }
  }

  // What the launcher is doing, so a party member's screen can say "Dexter is
  // installing the map" instead of showing an unexplained wait. Fire and forget.
  async state(phase, detail, { progress = null, map = null } = {}) {
    try { await this.req('/api/launcher/state', { method: 'POST', body: { phase, detail, progress, map }, timeoutMs: 3000 }) } catch {}
  }

  // Silent error reporting. Always treated as best-effort: a crash reporter that can
  // fail is a crash reporter that produces a second crash to report.
  async report(kind, message, context = {}) {
    try {
      const r = await this.req('/api/launcher/report', { method: 'POST', body: { kind, message, context }, timeoutMs: 4000 })
      return r.ok
    } catch { return false }
  }

  async getSettings() {
    const r = await this.req('/api/me/settings')
    return r.ok ? r.data : null
  }

  async putSettings(patch) {
    const r = await this.req('/api/me/settings', { method: 'PUT', body: patch })
    return r.ok ? r.data : null
  }
}

// Poll `/api/launcher/play` at the rate web suggested and we agreed: 1 Hz while a boot
// screen is up, 0.2 Hz otherwise. Emits only on change, so a caller can subscribe
// without filtering.
export class PlayWatcher extends EventEmitter {
  constructor(api) {
    super()
    this.api = api
    this.timer = null
    this.last = null
    this.fast = false
  }

  setFast(on) {
    if (this.fast === on) return
    this.fast = on
    if (this.timer) { this.stop(); this.start() }
  }

  start() {
    if (this.timer) return
    const tick = async () => {
      try {
        const p = await this.api.play()
        const key = JSON.stringify([p?.state, p?.match?.state, p?.match?.connect, p?.map?.key, p?.signedOut])
        if (key !== this.last) { this.last = key; this.emit('change', p) }
        this.emit('poll', p)
      } catch (e) { this.emit('error', e) }
    }
    this.timer = setInterval(tick, this.fast ? 1000 : 5000)
    this.timer.unref?.()
    tick()
  }

  stop() { clearInterval(this.timer); this.timer = null }
}

// Read the site's session cookie out of an Electron session so main-process calls are
// the same signed-in player as the page. This is the only place the two halves meet.
export function electronCookieProvider(electronSession) {
  return async (baseUrl) => {
    const cookies = await electronSession.cookies.get({ url: baseUrl })
    if (!cookies?.length) return null
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  }
}
