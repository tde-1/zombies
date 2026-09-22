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
  download: 'Downloading the map',
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

  step(id, state, detail, { simulated = false, label = null } = {}) {
    const rec = { id, label: label || STEP_LABELS[id] || id, state, detail, simulated, at: Date.now() }
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
      // The bsp is not the title (dev-box rule). The boot screen used to look the title
      // up in the launcher's own map rail; there is no rail any more, so the flow carries
      // it - from the site when the site knows it, and never invented when it does not.
      title: this.mapTitle || this.opts.mapTitle || null,
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

  // The launch is over and it did not get there. Every step that never ran is written
  // down as stopped rather than left absent, because an absent step is drawn as
  // "waiting" and a screen that says "waiting" about something that has already given
  // up is the worst thing this screen can do: B sat in front of one.
  stop(why) {
    const order = ['download', 'reserving', 'loading', 'ready', 'launching', 'in_game']
    for (const id of order) {
      const s = this.steps.find((x) => x.id === id)
      if (!s) { if (id !== 'download') this.step(id, 'failed', `stopped: ${why}`) }
      else if (s.state === 'active') this.step(id, 'failed', `stopped: ${why}`)
    }
    this.stopped = why
    return this.snapshot()
  }

  cancel(reason = 'cancelled') {
    this.cancelled = true
    try { this.launch?.stop(reason) } catch {}
    // Closing a game you got into is not a failure. Only mark the launch failed if it
    // never got there — otherwise a finished session shows a red step, which is both
    // wrong and the sort of thing a player reports as a bug.
    const inGame = this.steps.find((s) => s.id === 'in_game')
    if (inGame && inGame.state === 'done') this.step('launching', 'done', reason)
    else this.step('launching', 'failed', reason)
  }

  async run() {
    const o = this.opts
    const siteUrl = (o.siteUrl || 'http://127.0.0.1:8099').replace(/\/$/, '')

    // Play Local is a different journey (spec 13 §4): the map runs on the player's own
    // PC as a normal client, solo, with nothing tracked. There is no server to reserve
    // and no token to carry — and critically no `+connect`, or the engine would leave
    // the local map and go to the server the moment it loaded.
    if (o.localMap) return this.runLocal()

    // The site path (launcher-v0). `POST /admin/lease` against the mock site is gone:
    // a client must never be able to lease a box.
    if (o.api) return this.runViaSite(o.api)

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
    const chat = await this.chatPass()
    const l = new GameLaunch({
      chat,
      host,
      map: o.map,
      token,
      settings: o.settings,
      stealth: !!o.stealth,
      windowMode: o.windowMode || null,
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
    this.wireLaunch(l)

    try {
      const started = await l.start()
      this.step('launching', 'done', `World at War is running (process ${started.pid})`)
      this.emit('launched', started)
    } catch (e) {
      this.step('launching', 'failed', e.message)
      return this.stop(e.message)
    }

    // -------------------------------------------------------------- in game --
    this.step('in_game', 'active', 'waiting for the game to connect')
    const connected = await this.waitForConnection(siteUrl, matchId, o.connectTimeoutMs ?? 60000)
    this.step('in_game', connected.ok ? 'done' : 'active', connected.detail, { simulated: !connected.confirmed })
    return this.snapshot()
  }

  // The site-driven path (launcher-v0). The launcher presses Play and then watches:
  // the SITE leases the box, because it is the thing that knows the party, the map,
  // the mode and who is ready. `state` comes from the site so the boot screen and the
  // site can never disagree about what is happening.
  // The in-game chat pass, if the launcher can get one (main.js hands us the provider;
  // siteapi.js :: chatPass). Never allowed to hold up or fail a launch.
  async chatPass() {
    const f = this.opts.chatPass
    if (typeof f !== 'function') return null
    try {
      return await Promise.race([f(), new Promise((r) => setTimeout(() => r(null), 4000))])
    } catch {
      return null
    }
  }

  async runViaSite(api) {
    const o = this.opts
    const { PlayWatcher } = await import('./siteapi.js')

    // FOLLOW MODE: somebody else pressed Start.
    //
    // `POST /api/launcher/play` is "I am pressing Play", and only the leader may. A
    // member whose leader pressed Start on the site has nothing to ask for — the site
    // has already leased the box and minted a token per whitelisted SteamID, and this
    // player's own token is sitting in `/api/launcher/play`'s `match`. So the follower
    // skips straight to the watching half, which is identical from here down: the same
    // poll, the same boot screen, the same `+connect` and the same named pipe.
    //
    // Without this a party of four produced one player in the game and three staring at
    // a site that said "in game".
    if (o.follow) {
      this.step('reserving', 'active', o.followDetail || 'your party leader started a game')
    } else {
      this.step('reserving', 'active', 'asking the site for a server')
      const started = await api.startPlay({ mapKey: o.map, mode: o.mode || 'custom' })
      if (!started.ok) {
        // 409/403 messages are written for a player to read.
        this.step('reserving', 'failed', started.error)
        return this.snapshot()
      }
    }

    const watcher = new PlayWatcher(api)
    watcher.setFast(true)
    this.watcher = watcher

    const SITE_STEP = {
      idle: ['reserving', 'active', 'waiting for the site'],
      selected: ['reserving', 'active', 'the map is selected'],
      'ready-check': ['reserving', 'active', 'waiting for everyone to be ready'],
      reserving: ['reserving', 'active', 'the site is picking a server'],
      loading: ['loading', 'active', 'the server is loading the map'],
      ready: ['ready', 'done', 'the server is ready'],
      'in-game': ['in_game', 'done', 'in game'],
    }

    const done = await new Promise((resolve) => {
      const until = Date.now() + (o.serverTimeoutMs ?? 120000)
      watcher.on('change', (p) => {
        if (!p || p.signedOut) { resolve({ error: 'you are signed out on the site' }); return }
        const s = SITE_STEP[p.state]
        if (s) this.step(s[0], s[1], s[2])
        if (p.state === 'loading') this.step('reserving', 'done', `match ${p.match?.match_id || ''}`)
        if (p.map?.title) this.mapTitle = p.map.title
        if (p.match?.connect) {
          this.matchId = p.match.match_id
          this.host = p.match.connect
          this.step('reserving', 'done', `match ${p.match.match_id}${p.match.token ? ', invite token issued' : ''}`)
          this.step('loading', 'done', 'the server loaded the map')
          this.step('ready', 'done', `the server is ready on ${p.match.connect}`)
          resolve({ play: p })
        }
      })
      watcher.on('error', () => {})
      const timer = setInterval(() => {
        if (this.cancelled) { clearInterval(timer); resolve({ error: 'cancelled' }); return }
        if (Date.now() > until) { clearInterval(timer); resolve({ error: 'the server did not become ready in time' }) }
      }, 1000)
      watcher.start()
    })
    watcher.stop()

    if (done.error) {
      const stepId = this.steps.find((s) => s.state === 'active')?.id || 'ready'
      this.step(stepId, 'failed', done.error)
      return this.stop(done.error)
    }

    const p = done.play
    if (this.cancelled) return this.snapshot()

    // The map has to be on disk before `+connect`, or the engine connects and drops
    // straight back out. For a party member this has usually already finished while
    // the party was forming (main.js starts it the moment the leader stages a map, and
    // the party panel has been watching the bar) — `ensureMap` then returns in
    // milliseconds. This is the backstop for the member who joined late.
    const bsp0 = p.map?.key || o.map
    // A STOCK MAP IS ALREADY THERE. Nacht der Untoten, Verrückt, Shi No Numa and Der
    // Riese are inside World at War; the site's row for them says `source: stock` and
    // its file list is empty because there is nothing to serve. Asking anyway is what
    // stopped B's launch — step 1 failed with "The site has no files for
    // nazi_zombie_prototype yet" while the server sat ready on 2.28.235.236:28960.
    //
    // The site is asked as well as the local list, and either answer is enough: a
    // launcher that is one release behind the map table still gets this right.
    const stock = o.isStock?.(bsp0) || p.map?.source === 'stock' || p.map?.stock === true
    if (stock) {
      this.step('download', 'done', 'installed: stock')
    } else if (o.ensureMap) {
      const bsp = bsp0
      this.step('download', 'active', 'checking the map')
      try {
        const r = await o.ensureMap(bsp, (pr) => {
          const pct = pr.total ? Math.round(((pr.done ?? pr.bytes ?? 0) / pr.total) * 100) : null
          this.step('download', 'active', pct == null
            ? `${pr.file || bsp}`
            : `${pct}% of ${(pr.total / 1e6).toFixed(0)} MB${pr.file ? ` — ${pr.file}` : ''}`)
        })
        this.step('download', 'done', r?.stock ? 'installed: stock' : r?.already ? 'already installed' : r?.skipped || 'installed and hash-checked')
      } catch (e) {
        // A download that failed on a map that is nonetheless ON DISK is not a reason
        // to refuse to play: the server is ready, the engine can load the map, and the
        // only thing that broke is a check.
        if (o.mapReady?.(bsp)) {
          this.step('download', 'done', `already on this PC (the site could not be asked: ${e.message})`)
        } else {
          // A GENUINE failure stops the launch, and SAYS it stopped. The steps after
          // this one used to be left with no record at all, which the boot screen draws
          // as "waiting" — so a launch that had already given up looked like one that
          // was still trying, for ever. B watched that happen.
          this.step('download', 'failed', e.message)
          return this.stop(`the map could not be downloaded: ${e.message}`)
        }
      }
      if (this.cancelled) return this.snapshot()
    }

    if (o.launch === false) return this.snapshot()
    this.step('launching', 'active', 'starting World at War')
    const chat = await this.chatPass()
    const l = new GameLaunch({
      chat,
      host: p.match.connect,
      // The map name is not decoration here: CL_ConnectLocal takes one, and without it
      // the client never dials the server at all (launch.js :: connectEnv).
      map: p.map?.key || o.map,
      token: p.match.token,
      fsGame: p.match.fs_game || p.map?.fs_game || undefined,
      settings: o.settings,
      stealth: !!o.stealth,
      windowMode: o.windowMode || null,
      instance: p.match.match_id,
      role: 'client',
      linkHost: o.linkHost,
      lockName: o.lockName || 'launcher',
      why: `launcher: ${o.map}`,
      useGameLock: o.useGameLock,
      nannySeconds: o.nannySeconds,
    })
    this.launch = l
    this.wireLaunch(l)
    try {
      const st = await l.start()
      this.step('launching', 'done', `World at War is running (process ${st.pid})`)
      this.emit('launched', st)
    } catch (e) {
      this.step('launching', 'failed', e.message)
      return this.stop(e.message)
    }

    this.step('in_game', 'active', 'waiting for the game to connect')
    watcher.setFast(true)
    const joined = await new Promise((resolve) => {
      const until = Date.now() + (o.connectTimeoutMs ?? 90000)
      watcher.on('poll', (x) => { if (x?.state === 'in-game') resolve(true) })
      const timer = setInterval(() => {
        if (this.cancelled || l.ended || Date.now() > until) { clearInterval(timer); resolve(false) }
      }, 1000)
      watcher.start()
    })
    watcher.stop()
    this.step('in_game', joined ? 'done' : 'active',
      joined ? 'connected' : 'the game is running; the site has not seen you join yet',
      { simulated: !joined })
    return this.snapshot()
  }

  // Play Local: no server, no token, no tracking. Two steps, both real.
  async runLocal() {
    const o = this.opts
    this.step('reserving', 'done', 'this game runs on your PC, so there is no server to reserve and nothing is tracked', { label: 'Playing locally' })
    this.step('loading', 'done', `${o.localMap}`, { label: 'Map' })
    this.step('ready', 'done', 'ready', { label: 'Ready' })
    if (o.launch === false) return this.snapshot()
    if (this.cancelled) return this.snapshot()

    this.step('launching', 'active', 'starting World at War')
    const chat = await this.chatPass()
    const l = new GameLaunch({
      chat,
      host: null,                 // never both +map and +connect
      token: null,                // untracked: there is nothing to authorise
      map: o.localMap,
      fsGame: o.fsGame,
      installDir: o.installDir,
      settings: o.settings,
      stealth: !!o.stealth,
      windowMode: o.windowMode || null,
      // The site's match id, so the site, the box and the replay name one game.
      instance: o.instance || `local-${o.localMap}`,
      // 'client', not 'solo'. referee's capture recipe is explicit about why: a run
      // with no connected CLIENT has no player entities, so `_zombiemode` sits on
      // `flag_wait "all_players_connected"` and never starts a round — which shows up
      // as a game that loads perfectly and reports round 0 with 0 players forever.
      role: 'client',
      // A local game still reports to a host agent when there is one on this PC: that
      // is how the player gets their own rounds, stats and replay. "Untracked" is a
      // property of the MODE — the site files it as local, self-reported, worth no
      // records and no XP — not of whether anyone was watching. With no agent the
      // link simply stays dormant.
      linkHost: o.linkHost || null,
      lockName: o.lockName || 'launcher',
      why: `launcher: local ${o.localMap}`,
      useGameLock: o.useGameLock,
      nannySeconds: o.nannySeconds,
    })
    this.launch = l
    this.wireLaunch(l)
    try {
      const started = await l.start()
      this.step('launching', 'done', `World at War is running (process ${started.pid})`)
      this.emit('launched', started)
    } catch (e) {
      this.step('launching', 'failed', e.message)
      return this.stop(e.message)
    }
    this.step('in_game', 'active', 'loading the map on your PC', { label: 'In game (untracked)' })
    // The only honest confirmation for a local game is the engine's own log, and the
    // line that means "playable" is the zombies level-start autosave — not "Loading
    // fastfile", which fires a dozen times before any map exists.
    const loaded = await new Promise((resolve) => {
      const until = Date.now() + (o.connectTimeoutMs ?? 90000)
      const onUp = (ev) => { cleanup(); resolve(ev.map ? `${ev.map} is up and playable` : 'the map is up and playable') }
      const timer = setInterval(() => {
        if (this.cancelled || l.ended || Date.now() > until) { cleanup(); resolve(null) }
      }, 500)
      const cleanup = () => { clearInterval(timer); l.off('map_up', onUp) }
      l.on('map_up', onUp)
    })
    // If a custom map does not come up, the FIRST thing anyone needs to know is where
    // we installed it — World at War loads custom maps from exactly one folder and a
    // wrong location fails silently, looking for all the world like a broken map.
    let detail
    const diag = l.diagnose?.()
    if (loaded) detail = `the map is loading on your PC: ${loaded}`
    else if (diag) detail = `${diag.problem}. ${diag.why}${diag.check ? ` ENW installed it to ${diag.check}.` : ''}`
    else if (o.installDir) detail = `the game is running but has not reported the map. ENW installed it to ${o.installDir}.`
    else detail = 'the game is running; the engine has not reported a map yet'
    this.step('in_game', loaded ? 'done' : 'active', detail, { simulated: !loaded, label: 'In game (untracked)' })
    return this.snapshot()
  }

  wireLaunch(l) {
    l.on('note', () => this.emit('update', this.snapshot()))
    l.on('dialog', (d) => { this.step('launching', 'active', d.friendly) })
    l.on('phase', (p) => {
      if (p.phase === 'loading') this.step('launching', 'active', p.detail)
      if (p.phase === 'ended' || p.phase === 'failed') {
        const ig = this.steps.find((s) => s.id === 'in_game')
        if (!ig || ig.state !== 'done') this.step('launching', 'failed', p.detail)
        this.emit('ended', p)
      }
    })
    l.on('console', (line) => this.emit('console', line))
    // Spec §4.3 round trip: what the player changed in the game's own menus, read out
    // of config.cfg after the process is gone. Forwarded, not applied -- main.js owns
    // the account store.
    l.on('settings_readback', (r) => this.emit('settings_readback', r))
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
