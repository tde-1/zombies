// The site client: the box's half of the pull protocol, plus the chat bridge.
//
// SHAPE COPIED FROM ENW (server/routes/gameserver.js): the box polls, the site never
// connects out. Nothing here opens a listening port to the internet; every connection is
// outbound HTTP from the box. That is what makes a game box behind NAT, with no inbound
// firewall rules and no reachable RCON, work at all.
//
//   GET  /api/gs/assignment   what should this box be running right now?  (nonce-cached;
//                             `?v=2`: every live lease on the box, lib/leases.js)
//   GET  /api/gs/keys         the site's invite-token public key
//   POST /api/gs/status       booting / ready / live / idle heartbeat
//   POST /api/gs/result       the game summary + where the replay went
//   GET  /api/gs/chat-feed    long-poll drain of the cross-server chat ring
//   POST /api/gs/chat         a player said something in one of our games
//   POST /api/gs/live         a frame of each live game, for the site's spectator view
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { makeLog, sleep, mkdirp } from './util.js'
import { describe as describeLeases } from './leases.js'

export class SiteClient extends EventEmitter {
  constructor({ base, secret, boxName = 'box', pollMs = 3000, chatWaitS = 20, spoolDir = null, spoolMs = 15_000, liveHz = 4, log } = {}) {
    super()
    this.base = String(base).replace(/\/$/, '')
    this.secret = secret
    this.boxName = boxName
    this.pollMs = pollMs
    this.chatWaitS = chatWaitS
    this.spoolDir = spoolDir
    this.spoolMs = spoolMs
    // 4 Hz. The site drops anything faster than one frame per 220 ms per game and still
    // answers 200 ("rate is our problem"), so this is a courtesy, not a requirement.
    this.liveMs = Math.max(200, Math.round(1000 / Math.max(0.5, liveHz)))
    this.liveFrames = null       // set by the host: () => [{ instance, match_id, state }]
    if (spoolDir) mkdirp(spoolDir)
    this.log = log || makeLog('site')
    this.nonce = null
    // Sent on EVERY status post, so the site's stored status always says what this box
    // can run (web/server/lib/assignments.js capacity()): the protocol, and how many game
    // copies it really has. The host fills in max_instances after checkSlotCopies().
    this.statusExtra = { protocol: 2 }
    this.chatSince = 0
    this.running = false
    this.online = false
    this.stats = { polls: 0, errors: 0, chatIn: 0, chatOut: 0, results: 0, spooled: 0, liveSent: 0, liveDropped: 0, lastError: null }
  }

  async req(pathname, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(this.base + pathname, {
        method,
        headers: { 'x-match-secret': this.secret, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
      if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${json?.error || text.slice(0, 120)}`)
      this.online = true
      return json
    } finally { clearTimeout(to) }
  }

  // ---- assignment loop ---------------------------------------------------------
  start() {
    if (this.running) return
    this.running = true
    this.loopAssignment()
    this.loopChat()
    this.loopSpool()
    this.loopLive()
    const held = this.spoolList().length
    if (held) this.log.warn(`${held} result(s) held in the spool from a previous run — draining`)
  }

  stop() { this.running = false }

  async loopAssignment() {
    while (this.running) {
      try {
        const a = await this.req('/api/gs/assignment?v=2', { timeoutMs: 10_000 })
        this.stats.polls++
        // Cache on the nonce, exactly like the CS box's assignment agent: the poll is
        // cheap and constant, and we only act when the site changes its mind.
        if (a && a.nonce !== this.nonce) {
          this.nonce = a.nonce
          this.log.info(`assignment changed: ${describeLeases(a)} (nonce ${a.nonce})`)
          this.emit('assignment', a)
        }
        this.stats.lastError = null
      } catch (e) {
        this.stats.errors++
        this.stats.lastError = e.message
        this.online = false
        this.log.debug(`assignment poll: ${e.message}`)
      }
      await sleep(this.pollMs)
    }
  }

  async fetchKeys() {
    const k = await this.req('/api/gs/keys')
    this.emit('keys', k)
    return k
  }

  status(body) {
    return this.req('/api/gs/status', { method: 'POST', body: { box: this.boxName, ...this.statusExtra, ...body } }).catch((e) => {
      this.log.debug(`status: ${e.message}`); return null
    })
  }

  // ---- results, with a spool ------------------------------------------------------
  // Q-host-2, answered: a game is the expensive part and the POST is one HTTP request, so
  // losing the result because the site was being redeployed is the wrong half to drop.
  // A failed result goes to disk and is drained through POST /api/gs/spool (their batch
  // endpoint) until the site takes it.
  //
  // A 400 is NOT retried. Their /result never 5xxs, so a 400 means the body is
  // permanently unacceptable and retrying it forever would wedge the spool behind one bad
  // game; it is moved aside and logged instead.
  async postResult(payload) {
    try {
      const r = await this.req('/api/gs/result', { method: 'POST', body: payload, timeoutMs: 20_000 })
      this.stats.results++
      return r
    } catch (e) {
      if (/-> 4\d\d/.test(e.message)) { this.reject(payload, e.message); throw e }
      this.spool(payload, e.message)
      throw e
    }
  }

  spoolPath(payload, sub = '') {
    const id = payload?.summary?.match_id || `unknown_${Date.now()}`
    return path.join(this.spoolDir, sub, `${String(id).replace(/[^\w.-]/g, '_')}.json`)
  }

  /** Hold a result on disk until the site will take it. */
  spool(payload, why) {
    if (!this.spoolDir) return false
    try {
      const f = this.spoolPath(payload)
      mkdirp(path.dirname(f))
      fs.writeFileSync(f, JSON.stringify({ spooled_at: new Date().toISOString(), why, payload }))
      this.stats.spooled++
      this.log.warn(`result for ${payload?.summary?.match_id} spooled to disk (${why})`)
      return true
    } catch (e) { this.log.error(`could not spool the result: ${e.message}`); return false }
  }

  reject(payload, why) {
    if (!this.spoolDir) return
    try {
      const f = this.spoolPath(payload, 'rejected')
      mkdirp(path.dirname(f))
      fs.writeFileSync(f, JSON.stringify({ rejected_at: new Date().toISOString(), why, payload }))
      this.log.error(`the site REFUSED the result for ${payload?.summary?.match_id} (${why}); kept at ${f} and not retried`)
    } catch { /* nothing more we can do */ }
  }

  spoolList() {
    if (!this.spoolDir) return []
    try { return fs.readdirSync(this.spoolDir).filter((f) => f.endsWith('.json')).map((f) => path.join(this.spoolDir, f)) } catch { return [] }
  }

  /**
   * Drain the spool in one batch POST. The site answers per match id; we delete only the
   * ones it accepted, so an entry it could not take stays for the next pass.
   */
  async drainSpool() {
    const files = this.spoolList().slice(0, 200)
    if (!files.length) return 0
    const items = []
    for (const f of files) {
      try { items.push({ f, payload: JSON.parse(fs.readFileSync(f, 'utf8')).payload }) } catch { fs.unlinkSync(f) }
    }
    if (!items.length) return 0
    let r
    try { r = await this.req('/api/gs/spool', { method: 'POST', body: items.map((x) => x.payload), timeoutMs: 30_000 }) }
    catch (e) { this.log.debug(`spool drain: ${e.message}`); return 0 }
    let taken = 0
    const byId = new Map((r?.results || []).map((x) => [String(x.match_id), x]))
    for (const { f, payload } of items) {
      const id = String(payload?.summary?.match_id)
      const res = byId.get(id)
      if (res?.ok) { try { fs.unlinkSync(f) } catch { /* ignore */ } taken++; this.stats.results++ }
      else if (res && res.error) { this.reject(payload, res.error); try { fs.unlinkSync(f) } catch { /* ignore */ } }
    }
    if (taken) this.log.info(`spool drained: the site took ${taken} held result(s), ${this.spoolList().length} left`)
    return taken
  }

  async loopSpool() {
    while (this.running) {
      if (this.online && this.spoolList().length) await this.drainSpool()
      await sleep(this.spoolMs)
    }
  }

  // ---- chat bridge -------------------------------------------------------------
  async loopChat() {
    while (this.running) {
      try {
        const q = `?since=${this.chatSince}&wait=${this.chatWaitS}`
        const f = await this.req('/api/gs/chat-feed' + q, { timeoutMs: (this.chatWaitS + 10) * 1000 })
        if (f?.latest != null) this.chatSince = Math.max(this.chatSince, f.latest)
        for (const e of f?.events || []) { this.stats.chatIn++; this.emit('chat', e) }
      } catch (e) {
        this.stats.errors++
        this.log.debug(`chat drain: ${e.message}`)
        await sleep(2000)
      }
    }
  }

  // ---- live frames -----------------------------------------------------------------
  // The site's /live page draws the same 2D view the box's own dashboard does, from the
  // same referee `state()`. The box already has every byte; this just sends it. Frames are
  // FIRE AND FORGET: a live view is worth nothing a second later, so a failed post is
  // counted and dropped, never spooled and never retried.
  async loopLive() {
    while (this.running) {
      await sleep(this.liveMs)
      if (!this.liveFrames) continue
      let frames
      try { frames = this.liveFrames() } catch { continue }
      if (!frames?.length) continue
      try {
        // The site takes at most 16 per post; a box with more live games than that has a
        // bigger problem than its spectator view.
        const r = await this.req('/api/gs/live', { method: 'POST', body: { instances: frames.slice(0, 16) }, timeoutMs: 2500 })
        this.stats.liveSent += r?.taken || 0
        this.stats.liveDropped += Math.max(0, (r?.of ?? frames.length) - (r?.taken || 0))
      } catch (e) {
        this.stats.liveDropped += frames.length
        this.log.debug(`live frame: ${e.message}`)
      }
    }
  }

  sayToNetwork(msg) {
    this.stats.chatOut++
    return this.req('/api/gs/chat', { method: 'POST', body: msg }).catch((e) => { this.log.debug(`chat post: ${e.message}`); return null })
  }

  /**
   * A thing that HAPPENED in one of our games, for the site's system lines.
   *
   * The box sends the FACT and never the sentence. Two reasons, and they are the same
   * reason twice: the handle a line should carry is the site's user for a `verified`
   * identity and the in-game name otherwise, and only the site holds the user table;
   * and a box that composed its own prose would be a box that could write any sentence
   * it liked into a channel everybody reads.
   *
   * A failure here is swallowed. A system line is a nicety and must never be able to
   * interfere with a game, a result or a replay.
   */
  postEvent(ev) {
    this.stats.eventsOut = (this.stats.eventsOut || 0) + 1
    return this.req('/api/gs/event', { method: 'POST', body: ev, timeoutMs: 2500 })
      .catch((e) => { this.log.debug(`event post: ${e.message}`); return null })
  }
}
