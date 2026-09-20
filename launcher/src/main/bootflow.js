// The boot screen, as a state machine.
//
// Spec 99 §4.3: "Boot screen: map art + 'Reserving server -> Loading map -> Ready ->
// Launching WaW' + the readme."
//
// Each step is a real thing happening, and each one reports what it did, because when
// this fails a player needs to know whether it was us or them. The steps are:
//
//   reserving  POST a lease to the site; it picks a game box and mints an invite token
//              bound to (steamid, match). infra/host-agent/mock-site does this today.
//   loading    the box boots an instance and loads the map. We poll until it says so.
//   ready      the server is accepting connections.
//   launching  we start World at War with +connect <host>, token over the pipe.
//   in_game    the client is connected. (Confirmed by the host, not by us.)
//
// Anything we cannot reach falls back to a clearly-labelled simulated step, so the
// screen can be demonstrated on a machine with no host agent running — and says so.
import { EventEmitter } from 'node:events'
import { GameLaunch } from './launch.js'

const STEP_LABELS = {
  reserving: 'Reserving server',
  loading: 'Loading map',
  ready: 'Ready',
  launching: 'Launching World at War',
  in_game: 'In game',
}

async function jsonFetch(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { ok: res.ok, status: res.status, data, text }
  } finally { clearTimeout(t) }
}

export class BootFlow extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.steps = []
    this.simulated = []
    this.launch = null
    this.cancelled = false
  }

  step(id, state, detail, { simulated = false } = {}) {
    const rec = { id, label: STEP_LABELS[id] || id, state, detail, simulated, at: Date.now() }
    const prev = this.steps.find((s) => s.id === id)
    if (prev) Object.assign(prev, rec)
    else this.steps.push(rec)
    if (simulated && !this.simulated.includes(id)) this.simulated.push(id)
    this.emit('step', rec)
    this.emit('update', this.snapshot())
    return rec
  }

  snapshot() {
    return {
      map: this.opts.map,
      mode: this.opts.mode || 'custom',
      steps: this.steps,
      simulated: this.simulated,
      matchId: this.matchId || null,
      host: this.host || null,
      notes: this.launch?.notes || [],
      dialogs: this.launch?.dialogs || [],
      failed: this.steps.some((s) => s.state === 'failed'),
      done: this.steps.some((s) => s.id === 'in_game' && s.state === 'done'),
    }
  }

  cancel(reason = 'cancelled') {
    this.cancelled = true
    try { this.launch?.stop(reason) } catch {}
    this.step('launching', 'failed', reason)
  }

  async run() {
    const o = this.opts
    const siteUrl = (o.siteUrl || 'http://127.0.0.1:8099').replace(/\/$/, '')

    // ---------------------------------------------------------- reserving --
    this.step('reserving', 'active', `asking ${siteUrl} for a server`)
    let token = null
    let host = o.host || null
    let matchId = null
    try {
      const r = await jsonFetch(`${siteUrl}/admin/lease`, {
        method: 'POST',
        body: {
          map: o.map,
          mode: o.mode || 'custom',
          kind: o.kind || 'sim',
          players: [{ steamid: o.steamid || '76561190000000000', name: o.playerName || 'Player' }],
        },
      })
      if (!r.ok || !r.data?.assignment) throw new Error(`the site answered ${r.status}`)
      const a = r.data.assignment
      matchId = a.match_id
      token = a.tokens?.[o.steamid] || Object.values(a.tokens || {})[0] || null
      host = host || a.host || o.fallbackHost || '127.0.0.1:28960'
      this.matchId = matchId
      this.host = host
      this.step('reserving', 'done', `match ${matchId} on ${host}${token ? ', invite token issued' : ''}`)
    } catch (e) {
      if (o.requireSite) { this.step('reserving', 'failed', `could not reach the server list: ${e.message}`); return this.snapshot() }
      matchId = `m_local_${Date.now().toString(36)}`
      host = host || o.fallbackHost || '127.0.0.1:28960'
      token = o.token || null
      this.matchId = matchId
      this.host = host
      this.step('reserving', 'done', `no host agent reachable (${e.message}); using ${host}`, { simulated: true })
    }

    if (this.cancelled) return this.snapshot()

    // ------------------------------------------------------------ loading --
    this.step('loading', 'active', `${o.map} is loading on the server`)
    const loaded = await this.waitForServer(siteUrl, matchId, o.serverTimeoutMs ?? 20000)
    if (loaded.reachable) this.step('loading', 'done', loaded.detail)
    else this.step('loading', 'done', loaded.detail, { simulated: true })

    if (this.cancelled) return this.snapshot()

    // -------------------------------------------------------------- ready --
    // waitForServer may have learned the real port the box opened, so read it back
    // from this.host rather than the address we guessed at reservation time.
    host = this.host
    this.step('ready', 'done', loaded.reachable ? `the server is ready on ${host}` : `assuming ${host} is ready (no host agent to ask)`, { simulated: !loaded.reachable })

    if (o.launch === false) return this.snapshot()

    // ---------------------------------------------------------- launching --
    // Last chance to bail: cancel() during the poll above must not still start a game.
    if (this.cancelled) return this.snapshot()
    this.step('launching', 'active', 'starting World at War')
    const l = new GameLaunch({
      host,
      token,
      map: o.localMap || null,
      settings: o.settings,
      stealth: !!o.stealth,
      instance: matchId,
      role: 'client',
      linkHost: o.linkHost,
      lockName: o.lockName || 'launcher',
      why: `launcher: ${o.map}`,
      useGameLock: o.useGameLock,
      nannySeconds: o.nannySeconds,
      tokenViaEnv: !!o.tokenViaEnv,
    })
    this.launch = l
    l.on('note', () => this.emit('update', this.snapshot()))
    l.on('dialog', (d) => { this.step('launching', 'active', d.friendly); })
    l.on('phase', (p) => {
      if (p.phase === 'loading') this.step('launching', 'active', p.detail)
      if (p.phase === 'ended' || p.phase === 'failed') {
        const ig = this.steps.find((s) => s.id === 'in_game')
        if (!ig || ig.state !== 'done') this.step('launching', 'failed', p.detail)
        this.emit('ended', p)
      }
    })
    l.on('console', (line) => this.emit('console', line))

    try {
      const started = await l.start()
      this.step('launching', 'done', `World at War is running (process ${started.pid})`)
      this.emit('launched', started)
    } catch (e) {
      this.step('launching', 'failed', e.message)
      return this.snapshot()
    }

    // -------------------------------------------------------------- in game --
    this.step('in_game', 'active', 'waiting for the game to connect')
    const connected = await this.waitForConnection(siteUrl, matchId, o.connectTimeoutMs ?? 60000)
    this.step('in_game', connected.ok ? 'done' : 'active', connected.detail, { simulated: !connected.confirmed })
    return this.snapshot()
  }

  // Two places can answer "is the server up?", and they answer different halves:
  //
  //   the SITE (/admin/state) knows a box booted an instance for this match, and on
  //     which PORT — which is how we learn where to connect;
  //   the BOX's own dashboard (:8787 /api/state) knows the live game: phase, round,
  //     who is connected. The real site will carry this eventually; today it does not,
  //     so the dashboard is a development source and is labelled as one.
  //
  // Whichever answers, the step says so. Nothing is ticked green on a guess.
  async askSite(siteUrl, matchId) {
    try {
      const r = await jsonFetch(`${siteUrl}/admin/state`, { timeoutMs: 2000 })
      if (!r.ok || !r.data) return null
      for (const box of r.data.boxes || []) {
        for (const inst of box.instances || box.lastStatus?.instances || []) {
          if (inst.match_id === matchId) return { box: box.name, inst }
        }
      }
      return { box: null, inst: null }
    } catch { return null }
  }

  async askBox(dashUrl, matchId) {
    if (!dashUrl) return null
    try {
      const r = await jsonFetch(`${dashUrl.replace(/\/$/, '')}/api/state`, { timeoutMs: 2000 })
      if (!r.ok || !r.data) return null
      const inst = (r.data.instances || []).find((x) => x.match_id === matchId)
      return inst ? { inst, game: inst.game || null } : { inst: null, game: null }
    } catch { return null }
  }

  async waitForServer(siteUrl, matchId, timeoutMs) {
    const until = Date.now() + timeoutMs
    let sawSite = false
    while (Date.now() < until && !this.cancelled) {
      const site = await this.askSite(siteUrl, matchId)
      if (site) sawSite = true
      if (site?.inst) {
        // The port the box actually opened. This is where we connect.
        if (site.inst.port) this.host = `127.0.0.1:${site.inst.port}`
        const box = await this.askBox(this.opts.hostDashboard, matchId)
        if (box?.game && ['live', 'running', 'ready'].includes(box.game.phase)) {
          return { reachable: true, detail: `${box.game.map_name || box.game.map} is up on ${this.host} (round ${box.game.round ?? 1})` }
        }
        if (site.inst.state === 'running') {
          return { reachable: true, detail: `${site.box} is running ${site.inst.assignment?.map || 'the map'} on ${this.host}` }
        }
      }
      await new Promise((r) => setTimeout(r, 750))
    }
    return {
      reachable: false,
      detail: sawSite
        ? 'no box picked up the match in time — continuing anyway'
        : 'no host agent to ask; continuing without a confirmed server',
    }
  }

  async waitForConnection(siteUrl, matchId, timeoutMs) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until && !this.cancelled) {
      const box = await this.askBox(this.opts.hostDashboard, matchId)
      const players = box?.game?.players || []
      const me = players.find((p) => !this.opts.steamid || String(p.steamid) === String(this.opts.steamid))
      if (me) return { ok: true, confirmed: true, detail: `connected as ${me.name} (slot ${me.slot}) on round ${box.game.round ?? 1}` }
      if (players.length) return { ok: true, confirmed: true, detail: `${players.length} player(s) connected` }
      // The site only learns about a game when it ends, so it cannot confirm this.
      if (this.launch?.ended) return { ok: false, confirmed: false, detail: 'the game closed before it connected' }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return { ok: false, confirmed: false, detail: 'the game is running; nothing confirmed the connection' }
  }
}
