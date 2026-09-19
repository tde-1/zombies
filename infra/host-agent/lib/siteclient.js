// The site client: the box's half of the pull protocol, plus the chat bridge.
//
// SHAPE COPIED FROM ENW (server/routes/gameserver.js): the box polls, the site never
// connects out. Nothing here opens a listening port to the internet; every connection is
// outbound HTTP from the box. That is what makes a game box behind NAT, with no inbound
// firewall rules and no reachable RCON, work at all.
//
//   GET  /api/gs/assignment   what should this box be running right now?  (nonce-cached)
//   GET  /api/gs/keys         the site's invite-token public key
//   POST /api/gs/status       booting / ready / live / idle heartbeat
//   POST /api/gs/result       the game summary + where the replay went
//   GET  /api/gs/chat-feed    long-poll drain of the cross-server chat ring
//   POST /api/gs/chat         a player said something in one of our games
import { EventEmitter } from 'node:events'
import { makeLog, sleep } from './util.js'

export class SiteClient extends EventEmitter {
  constructor({ base, secret, boxName = 'box', pollMs = 3000, chatWaitS = 20, log } = {}) {
    super()
    this.base = String(base).replace(/\/$/, '')
    this.secret = secret
    this.boxName = boxName
    this.pollMs = pollMs
    this.chatWaitS = chatWaitS
    this.log = log || makeLog('site')
    this.nonce = null
    this.chatSince = 0
    this.running = false
    this.online = false
    this.stats = { polls: 0, errors: 0, chatIn: 0, chatOut: 0, results: 0, lastError: null }
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
  }

  stop() { this.running = false }

  async loopAssignment() {
    while (this.running) {
      try {
        const a = await this.req('/api/gs/assignment', { timeoutMs: 10_000 })
        this.stats.polls++
        // Cache on the nonce, exactly like the CS box's assignment agent: the poll is
        // cheap and constant, and we only act when the site changes its mind.
        if (a && a.nonce !== this.nonce) {
          this.nonce = a.nonce
          this.log.info(`assignment changed: ${a.status} ${a.map || ''} ${a.match_id || ''} (nonce ${a.nonce})`)
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
    return this.req('/api/gs/status', { method: 'POST', body: { box: this.boxName, ...body } }).catch((e) => {
      this.log.debug(`status: ${e.message}`); return null
    })
  }

  async postResult(payload) {
    const r = await this.req('/api/gs/result', { method: 'POST', body: payload, timeoutMs: 20_000 })
    this.stats.results++
    return r
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

  sayToNetwork(msg) {
    this.stats.chatOut++
    return this.req('/api/gs/chat', { method: 'POST', body: msg }).catch((e) => { this.log.debug(`chat post: ${e.message}`); return null })
  }
}
