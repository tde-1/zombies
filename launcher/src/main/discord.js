// Discord Rich Presence (B, 2026-09-23; launcher.md "Discord rich presence").
//
// Two halves, both here so the test can drive them together:
//
//   presenceFor(ctx)  pure: what the launcher knows (the boot flow, the site's /play poll,
//                     a local run's round) -> the exact SET_ACTIVITY payload, or null.
//   Presence          the IPC client: Discord's local named pipe, handshake, SET_ACTIVITY,
//                     ping/pong, reconnect with backoff. No dependency: the protocol is
//                     an 8-byte header (op, length, little-endian) and a JSON body.
//
// Nothing here may slow or break a launch. Every entry point is sync and cheap, every
// socket has an 'error' handler (an unhandled one would take the main process down), and
// Discord not running is a silent retry on a doubling timer, not an error.
//
// What is sent, and nothing else: the map's display name, solo or party size, the round,
// the game's start time, the map's picture, "Verified". No Steam ids, no names, no server
// addresses, no join secrets.
//
// Prior art checked first: ENW Movement (CSGO-Matchmaker) has no Discord Rich Presence (its
// only "rich presence" is Steam's, bot/lib/steam-real.js), so there was nothing to reuse.
import net from 'node:net'
import crypto from 'node:crypto'

export const MAX_PARTY = 4
// The ENW mark, uploaded by B to the Discord application as an Art Asset named "enw".
export const LOGO = 'enw'
export const APP_NAME = 'ENW Zombies'

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 }

// A Discord application id is a snowflake. Anything else is treated as "not configured".
export const validClientId = (id) => (/^\d{17,20}$/.test(String(id || '').trim()) ? String(id).trim() : null)

// Discord refuses a details/state shorter than 2 or longer than 128 characters.
const clip = (s) => {
  const t = String(s || '').trim()
  if (t.length < 2) return null
  return t.length > 128 ? t.slice(0, 127) + '…' : t
}

// The site's own rule for a title (web/client/src/data/mapText.js prettyTitle), copied
// because the packaged launcher does not carry web/: a title with any lower case is kept
// as its author wrote it, an all-caps one is title-cased, and no title at all falls back
// to the bsp without its `nazi_zombie_` prefix.
const SMALL = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'de', 'der', 'die', 'das', 'von'])
export function mapName(title, key) {
  const t = String(title || '').trim()
  if (!t) {
    const k = String(key || '').replace(/^nazi_zombie_/, '').replace(/_/g, ' ').trim()
    return k ? k.replace(/\b\w/g, (c) => c.toUpperCase()) : null
  }
  if (/[a-z]/.test(t)) return t
  return t.toLowerCase().replace(/[^\s\-/]+/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
}

// The map's card as an https URL Discord can fetch. The catalogue's `art` is
// `/media/maps/<stem>.webp?v=<hash>` (960 px); the 400 px thumb beside it is plenty for a
// Discord large image. A site that is not https (a dev box on 127.0.0.1) cannot be fetched
// by Discord, so that gives null and the caller falls back to the logo.
export function mapImage(siteUrl, art) {
  if (!art || !siteUrl || !/^https:\/\//i.test(siteUrl)) return null
  const m = /^\/media\/maps\/([a-z0-9_-]+)\.webp(\?v=[0-9a-f]+)?$/.exec(String(art))
  if (!m) return /^https:\/\//i.test(art) ? String(art) : null
  return `${siteUrl.replace(/\/$/, '')}/media/maps/${m[1]}.thumb.webp${m[2] || ''}`
}

const partySize = (party) => {
  const n = Array.isArray(party?.members) ? party.members.length : Number(party?.members) || 0
  return Math.max(0, Math.min(MAX_PARTY, n))
}

// ctx = {
//   enabled,                   the setting
//   game: { map, title, mode, matchId, startedAt } | null   a boot flow is running;
//                               startedAt is set once the game process started
//   play,                      the last /api/launcher/play poll (party, map, match.round)
//   localRound,                the round a Play Local run last reported
//   siteUrl,                   for the map picture
// }
export function presenceFor(ctx = {}) {
  const { enabled = true, game = null, play = null, localRound = null, siteUrl = null } = ctx
  if (!enabled) return null
  const p = play && !play.signedOut ? play : null

  if (game) {
    // The poll describes this game only when it names the same match (or, before the flow
    // knows its match id, the same map): a stale party must not lend its size or round.
    const same = !!(p && p.match && ((game.matchId && p.match.match_id === game.matchId) || (!game.matchId && p.map?.key === game.map)))
    const siteMap = p?.map && p.map.key === game.map ? p.map : null
    const title = clip(mapName(game.title || siteMap?.title, game.map)) || APP_NAME
    const n = Math.max(1, same ? partySize(p.party) : 1)
    const r = Number(same && p.match.round) || Number(localRound) || 0
    const round = r > 0 ? r : null
    const verified = String(game.mode || '').toLowerCase() === 'verified' ||
      (same && String(p.party?.mode || p.match.mode || '').toLowerCase() === 'verified')
    const img = mapImage(siteUrl, siteMap?.art)

    let state
    if (!game.startedAt) state = 'Loading'
    else if (n > 1) state = round ? `Round ${round}` : 'In game'
    else state = round ? `Solo · Round ${round}` : 'Solo'

    const a = { details: title, state }
    if (n > 1) a.party = { size: [n, MAX_PARTY] }
    if (game.startedAt) a.timestamps = { start: Math.floor(Number(game.startedAt)) }
    a.assets = img
      ? { large_image: img, large_text: title, small_image: LOGO, small_text: verified ? 'Verified' : APP_NAME }
      : { large_image: LOGO, large_text: verified ? `${APP_NAME} · Verified` : APP_NAME }
    a.instance = false
    return a
  }

  const n = partySize(p?.party)
  if (p?.party && n >= 2) {
    const staged = p.map ? clip(mapName(p.map.title, p.map.key)) : null
    return {
      details: 'In a party',
      state: staged || 'In the lobby',
      party: { size: [n, MAX_PARTY] },
      assets: { large_image: LOGO, large_text: APP_NAME },
      instance: false,
    }
  }

  return { details: 'Browsing maps', assets: { large_image: LOGO, large_text: APP_NAME }, instance: false }
}

// ------------------------------------------------------------------- the pipe --

export function defaultPipe(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp'
  return `${dir.replace(/\/$/, '')}/discord-ipc-${i}`
}

export function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const h = Buffer.alloc(8)
  h.writeInt32LE(op, 0)
  h.writeInt32LE(body.length, 4)
  return Buffer.concat([h, body])
}

// Pull every whole frame off the front of `buf`. Returns { frames, rest }.
export function decode(buf) {
  const frames = []
  let off = 0
  while (buf.length - off >= 8) {
    const op = buf.readInt32LE(off)
    const len = buf.readInt32LE(off + 4)
    if (len < 0 || len > 1 << 20) return { frames, rest: Buffer.alloc(0), bad: true }
    if (buf.length - off - 8 < len) break
    let data = null
    try { data = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8')) } catch { data = null }
    frames.push({ op, data })
    off += 8 + len
  }
  return { frames, rest: buf.subarray(off) }
}

export class Presence {
  // clientId   the Discord application id (validClientId); none = do nothing at all
  // pipe(i)    the path of pipe i (0..9); injectable for the test's fake Discord
  // backoff    [first, max] ms between connection attempts, doubling
  // minGapMs   Discord allows ~5 SET_ACTIVITY per 20 s; updates closer than this coalesce
  constructor({ clientId = null, enabled = true, log = () => {}, pipe = defaultPipe, pipes = 10,
    backoff = [2000, 60000], minGapMs = 4000, handshakeMs = 10000, pid = process.pid } = {}) {
    this.clientId = validClientId(clientId)
    this.enabled = !!enabled
    this.log = log
    this.pipe = pipe
    this.pipes = pipes
    this.backoff = backoff
    this.minGapMs = minGapMs
    this.handshakeMs = handshakeMs
    this.pid = pid
    this.want = null          // the activity we want Discord to show (null = none)
    this.sentKey = undefined  // JSON of what Discord was last told
    this.sock = null
    this.ready = false
    this.stopped = false
    this.attempt = 0
    this.retryTimer = null
    this.sendTimer = null
    this.lastSendAt = 0
    this.buf = Buffer.alloc(0)
    this.saidNoId = false
    this.lastError = null
    this.user = null
    this.connecting = false
    this.connect()
  }

  status() {
    return {
      enabled: this.enabled, configured: !!this.clientId, connected: this.ready,
      attempt: this.attempt, retrying: !!this.retryTimer, showing: this.sentKey ? JSON.parse(this.sentKey) : null,
      lastError: this.lastError,
    }
  }

  setClientId(id) {
    const v = validClientId(id)
    if (v === this.clientId) return
    this.clientId = v
    this.log(v ? `application id ${v}` : 'no Discord application id configured; presence is off')
    this.drop()
    this.attempt = 0
    this.connect()
  }

  setEnabled(on) {
    on = !!on
    if (on === this.enabled) return
    this.enabled = on
    this.log(on ? 'rich presence on' : 'rich presence off; clearing it')
    if (!on) {
      // Clear now, not at the next throttle slot: the player just asked for it gone.
      if (this.ready) this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: this.pid }, nonce: crypto.randomUUID() })
      this.want = null
      this.drop()
    } else {
      this.attempt = 0
      this.connect()
    }
  }

  // The activity to show (presenceFor's answer). Deduplicated and throttled.
  update(activity) {
    this.want = activity || null
    this.flush()
  }

  // The launcher is quitting: clear, close, never reconnect. Discord also clears an
  // activity by itself when the pipe that set it closes.
  stop() {
    if (this.stopped) return
    if (this.ready && this.sentKey && this.sentKey !== 'null') {
      this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: this.pid }, nonce: crypto.randomUUID() })
    }
    this.stopped = true
    this.drop()
  }

  // ---- internals ------------------------------------------------------------------

  drop() {
    clearTimeout(this.retryTimer); this.retryTimer = null
    clearTimeout(this.sendTimer); this.sendTimer = null
    clearTimeout(this.hsTimer); this.hsTimer = null
    const s = this.sock
    this.sock = null
    this.ready = false
    this.connecting = false
    this.sentKey = undefined
    this.buf = Buffer.alloc(0)
    if (s) { try { s.end() } catch {} try { s.destroy() } catch {} }
  }

  connect() {
    if (this.stopped || !this.enabled || this.sock || this.connecting || this.retryTimer) return
    if (!this.clientId) {
      if (!this.saidNoId) { this.saidNoId = true; this.log('no Discord application id configured; presence is off') }
      return
    }
    this.connecting = true
    this.tryPipe(0)
  }

  tryPipe(i) {
    if (this.stopped || !this.enabled) { this.connecting = false; return }
    if (i >= this.pipes) { this.connecting = false; this.scheduleRetry('Discord is not running'); return }
    let s
    try { s = net.connect(this.pipe(i)) } catch { this.tryPipe(i + 1); return }
    let opened = false
    s.on('error', (e) => {
      if (!opened) { try { s.destroy() } catch {} this.tryPipe(i + 1); return }
      this.lastError = e.message
    })
    s.once('connect', () => {
      opened = true
      if (this.stopped || !this.enabled || !this.clientId) { try { s.destroy() } catch {} this.connecting = false; return }
      this.connecting = false
      this.sock = s
      this.buf = Buffer.alloc(0)
      s.on('data', (d) => this.onData(s, d))
      s.on('close', () => this.onClose(s))
      this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId })
      this.hsTimer = setTimeout(() => { if (this.sock === s && !this.ready) { this.lastError = 'no READY from Discord'; try { s.destroy() } catch {} } }, this.handshakeMs)
      this.hsTimer.unref?.()
    })
  }

  scheduleRetry(why) {
    if (this.stopped || !this.enabled || !this.clientId || this.retryTimer) return
    const [first, max] = this.backoff
    const ms = Math.min(max, first * 2 ** this.attempt)
    if (this.attempt === 0 || ms === max && this.attempt < 20) this.log(`${why}; next try in ${Math.round(ms / 1000)} s`)
    this.attempt++
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect() }, ms)
    this.retryTimer.unref?.()
  }

  onClose(s) {
    if (this.sock !== s) return
    const wasReady = this.ready
    this.sock = null
    this.ready = false
    this.sentKey = undefined
    clearTimeout(this.hsTimer); this.hsTimer = null
    clearTimeout(this.sendTimer); this.sendTimer = null
    if (wasReady) this.log('Discord closed the connection')
    this.scheduleRetry(this.lastError || 'Discord went away')
  }

  onData(s, d) {
    if (this.sock !== s) return
    const { frames, rest, bad } = decode(Buffer.concat([this.buf, d]))
    this.buf = rest
    if (bad) { try { s.destroy() } catch {} return }
    for (const f of frames) {
      if (f.op === OP.PING) this.write(OP.PONG, f.data)
      else if (f.op === OP.CLOSE) {
        // e.g. 4000 "Invalid Client ID": wait the longest before trying again.
        this.lastError = `Discord refused: ${f.data?.message || f.data?.code || 'closed'}`
        this.log(this.lastError)
        this.attempt = Math.max(this.attempt, 30)
        try { s.destroy() } catch {}
      } else if (f.op === OP.FRAME && f.data?.evt === 'READY') {
        clearTimeout(this.hsTimer); this.hsTimer = null
        this.ready = true
        this.attempt = 0
        this.lastError = null
        this.log('connected to Discord')
        this.flush()
      } else if (f.op === OP.FRAME && f.data?.evt === 'ERROR') {
        this.lastError = `Discord: ${f.data?.data?.message || 'error'}`
        this.log(this.lastError)
      }
    }
  }

  write(op, obj) {
    const s = this.sock
    if (!s || s.destroyed) return false
    try { s.write(encode(op, obj)); return true } catch { return false }
  }

  flush() {
    if (!this.ready || !this.enabled || this.stopped) return
    const key = JSON.stringify(this.want)
    if (key === this.sentKey) return
    const wait = this.lastSendAt + this.minGapMs - Date.now()
    if (wait > 0) {
      if (!this.sendTimer) {
        this.sendTimer = setTimeout(() => { this.sendTimer = null; this.flush() }, wait)
        this.sendTimer.unref?.()
      }
      return
    }
    const args = { pid: this.pid }
    if (this.want) args.activity = this.want
    if (this.write(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: crypto.randomUUID() })) {
      this.sentKey = key
      this.lastSendAt = Date.now()
    }
  }
}
