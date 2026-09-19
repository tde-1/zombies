// The referee: consumes game-link events and OWNS THE RULES.
//
// Nothing in the game process decides whether a game counts. The DLL reports facts
// (round changed, this player went down, this script notify fired); the referee decides
// what they mean, warns, ends, and produces the game summary the website stores.
//
// Rules implemented here, with their source:
//   * rounds / game over                        — vault 99 §5.3
//   * per-map finish detection + ranking        — vault 99 §4.6, manifests.js
//   * late joiners get nothing                  — vault 99 §4.4 ("no achievements and no records")
//   * 24 h cap, warnings at 30/10/1 min, clean end — vault 99 §4.4 (uncapped if a VIP is in the lobby)
//   * AFK warn at 10 min, kick at 15; everyone AFK => pause then close — vault 99 §4.4
//   * pause / resume, crash grace, "Resumed" tag — vault 10 §5
//
// CLOCK. Everything is measured on the GAME clock (`ms` on each event), not wall time, so
// a paused or stalled server does not burn a player's AFK budget and a fast-forwarded
// simulator exercises the 24 h cap in seconds. Between events the clock free-runs at wall
// speed from the last event, so a game that goes silent still hits its cap.
import { EventEmitter } from 'node:events'
import { ManifestEvaluator, defaultManifest } from './manifests.js'

const MIN = 60_000
const HOUR = 60 * MIN

export const DEFAULTS = {
  capMs: 24 * HOUR,
  capWarnMs: [30 * MIN, 10 * MIN, 1 * MIN],
  capEndGraceMs: 15_000,     // between the final warning and the clean end
  afkWarnMs: 10 * MIN,
  afkKickMs: 15 * MIN,
  allAfkPauseMs: 15 * MIN,   // everyone idle this long => pause the game
  allAfkCloseMs: 5 * MIN,    // ...then close it this long after the pause
  emptyCloseMs: 2 * MIN,     // nobody connected at all
  crashGraceMs: 7 * MIN,     // vault 10 §5: 5–10 min, then a resume countdown
  lateJoinGraceMs: 30_000,   // joining within this of go-live is not "late"
}

let SEQ = 0

export class Referee extends EventEmitter {
  constructor({ instanceId, matchId, mode = 'verified', manifest = null, config = {}, vip = false, log }) {
    super()
    this.instanceId = instanceId
    this.matchId = matchId
    this.mode = mode                  // 'local' | 'custom' | 'verified'
    this.manifest = manifest || defaultManifest(null)
    this.eval = new ManifestEvaluator(this.manifest)
    this.cfg = { ...DEFAULTS, ...config }
    this.vip = vip                    // vault 4.4: uncapped if any VIP is in the lobby
    this.log = log || { info() {}, warn() {}, debug() {}, error() {} }

    this.phase = 'boot'               // boot | loading | live | paused | ending | over
    this.map = null
    this.fsGame = null
    this.round = 0
    this.maxRound = 0
    this.players = new Map()          // slot -> player
    this.zombies = []                 // last snapshot, for the live view
    this.zombiesAliveMax = 0
    this.finish = null
    this.flags = new Set()
    this.signals = new Set()      // per-map manifest signals seen (ticks on the badge card)
    this.warnedCaps = new Set()
    this.pauses = []                  // { fromMs, toMs, reason }
    this.pausedMs = 0
    this.pauseReason = null
    this.events = 0
    this.chatLines = 0
    this.perf = null
    this.startedMs = null             // game clock at go-live
    this.endedMs = null
    this.endReason = null
    this.startedAt = Date.now()
    this.endedAt = null
    this.lastEventMs = 0
    this.lastEventWall = Date.now()
    this.allAfkSinceMs = null
    this.emptySinceMs = null
    this.pendingCommands = []
    this.dvars = {}
    this.levelVars = {}
    this.hashes = {}
  }

  // ---- clock ------------------------------------------------------------------
  /** Game-clock "now": last reported ms, advanced at wall speed since that report. */
  now() {
    if (this.phase === 'paused') return this.lastEventMs
    return this.lastEventMs + (Date.now() - this.lastEventWall)
  }

  /** Elapsed game time since go-live, paused time excluded (the boards' "in-game time"). */
  elapsed() {
    if (this.startedMs == null) return 0
    const end = this.endedMs ?? this.now()
    return Math.max(0, end - this.startedMs - this.pausedMs)
  }

  /** Real time since go-live (RTA — pauses included; speedrun.com counts paused time). */
  elapsedRta() {
    if (this.startedMs == null) return 0
    return Math.max(0, (this.endedMs ?? this.now()) - this.startedMs)
  }

  capMs() { return this.vip ? Infinity : this.cfg.capMs }

  // ---- command sink -----------------------------------------------------------
  send(cmd) {
    const out = { id: `rf${++SEQ}`, ...cmd }
    this.pendingCommands.push(out)
    this.emit('command', out)
    return out
  }

  say(text) { this.send({ t: 'say', text, from: 'ENW' }) }
  tell(slot, text) { this.send({ t: 'tell', slot, text }) }

  // ---- event intake -----------------------------------------------------------
  /** Feed one game→host protocol event. Returns the (possibly annotated) event. */
  onEvent(ev) {
    if (!ev || typeof ev.t !== 'string') return null
    if (Number.isFinite(ev.ms)) { this.lastEventMs = Math.max(this.lastEventMs, ev.ms); this.lastEventWall = Date.now() }
    this.events++
    const h = this[`ev_${ev.t}`]
    if (typeof h === 'function') { try { h.call(this, ev) } catch (e) { this.log.error(`referee ${ev.t}: ${e.message}`) } }
    this.checkFinish(ev)
    this.emit('event', ev)
    return ev
  }

  ev_hello(ev) {
    this.pid = ev.pid
    this.role = ev.role
    this.hashes = { exe_sha256: ev.exe_sha256, dll_build: ev.dll_build }
    if (this.phase === 'boot') this.phase = 'loading'
  }

  ev_map_loaded(ev) {
    this.map = ev.map
    this.fsGame = ev.fs_game || null
    this.maxClients = ev.sv_maxclients
    this.emit('manifest_wanted', ev.map)
    this.phase = 'loading'
    this.log.info(`map_loaded ${ev.map} -> manifest "${this.manifest.title}" (${this.manifest._default ? 'built-in default' : this.manifest.confidence || 'unknown confidence'})`)
  }

  ev_round(ev) {
    const n = Number(ev.n) || 0
    if (n > 0 && this.phase === 'loading') this.goLive(ev.ms ?? this.now())
    this.round = n
    this.maxRound = Math.max(this.maxRound, n)
    if (this.phase === 'live') for (const p of this.players.values()) if (p.connected) p.roundsPlayed++
  }

  ev_player_connect(ev) {
    const slot = ev.slot
    const existing = this.players.get(slot)
    const nowMs = ev.ms ?? this.now()
    // The DLL binds our token to the slot on connect, so a reconnect inside the grace
    // window is the SAME person coming back, not a new one (vault 10 §5, "Identity").
    if (existing && existing.steamid && existing.steamid === (ev.steamid || ev.xuid)) {
      existing.connected = true
      existing.reconnects++
      existing.disconnectedMs = null
      existing.lastInputMs = nowMs
      this.flags.add('resumed')
      this.log.info(`slot ${slot} ${existing.name} reconnected (${existing.reconnects})`)
      this.maybeResumeAfterCrash()
      return
    }
    const late = this.phase === 'live' && this.startedMs != null && nowMs - this.startedMs > this.cfg.lateJoinGraceMs
    const p = {
      slot,
      steamid: ev.steamid || ev.xuid || null,
      name: ev.name || `slot${slot}`,
      score: 0, maxScore: 0, kills: 0, downs: 0, revives: 0, bleedouts: 0,
      // Field names deliberately mirror IW4MAdmin's ZombieClientStat (MIT,
      // feature/zombie-stats) so the two schemas can be merged later without a mapping
      // table. See docs/kickstart/host.md "Alignment with IW4MAdmin".
      headshots: 0, pointsEarned: 0, pointsSpent: 0, timeAliveMs: 0, lastAliveMs: nowMs,
      alive: false, down: false, connected: true, reconnects: 0,
      joinedMs: nowMs, joinedRound: this.round, late,
      roundsPlayed: 0,
      lastInputMs: nowMs, afkWarned: false, afkKicked: false,
      pos: null, ang: null, health: 100, weapon: null,
      tokenOk: ev.token ? null : false, // resolved by the host's TokenGuard
    }
    this.players.set(slot, p)
    if (late) {
      this.flags.add('late_join')
      // Vault 4.4: late joiners can join, but the GAME earns no achievements and no
      // records. Flagging the game (not just the player) is deliberate: a 4th player
      // walking in at round 40 changes the zombie count for everyone.
      this.log.warn(`late joiner slot ${slot} ${p.name} at round ${this.round} — game flagged no-records`)
      this.tell(slot, 'You joined a game in progress: no records or badges from this one.')
    }
    this.emptySinceMs = null
  }

  ev_player_spawn(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    p.alive = true; p.down = false
    if (this.phase === 'loading') this.goLive(ev.ms ?? this.now())
  }

  ev_player_disconnect(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    p.connected = false
    p.alive = false
    p.disconnectedMs = ev.ms ?? this.now()
    p.disconnectReason = ev.reason || null
    this.log.info(`slot ${ev.slot} ${p.name} disconnected (${p.disconnectReason || 'unknown'})`)
    this.maybePauseForCrash(p)
  }

  ev_down(ev) { const p = this.players.get(ev.slot); if (p) { this.creditAlive(p, ev.ms); p.down = true; p.downs++ } }

  /** Time-alive accounting (IW4MAdmin's ZombieRoundClientStat tracks the same thing). */
  creditAlive(p, ms) {
    const now = ms ?? this.now()
    if (p.alive && !p.down && this.startedMs != null) p.timeAliveMs += Math.max(0, now - (p.lastAliveMs ?? now))
    p.lastAliveMs = now
  }
  ev_revive(ev) {
    const p = this.players.get(ev.slot); if (p) { p.down = false; p.lastAliveMs = ev.ms ?? this.now() }
    const by = this.players.get(ev.by); if (by) by.revives++
  }
  ev_bleedout(ev) { const p = this.players.get(ev.slot); if (p) { this.creditAlive(p, ev.ms); p.down = false; p.alive = false; p.bleedouts++ } }

  ev_points(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    p.score = Number(ev.score) || 0
    p.maxScore = Math.max(p.maxScore, p.score)
    const d = Number(ev.delta)
    if (Number.isFinite(d)) { if (d > 0) p.pointsEarned += d; else p.pointsSpent += -d }
    if (ev.why === 'kill' || ev.why === 'headshot') p.kills++
    if (ev.why === 'headshot') p.headshots++
  }

  ev_chat(ev) { this.chatLines++; this.touch(ev.slot, ev.ms) }

  ev_input(ev) {
    if (!ev.moved && !ev.turned && !ev.buttons) return
    this.touch(ev.slot, ev.ms)
  }

  ev_snap(ev) {
    if (Array.isArray(ev.players)) {
      for (const s of ev.players) {
        const p = this.players.get(s.slot); if (!p) continue
        p.pos = s.pos; p.ang = s.ang; p.health = s.health
        p.alive = s.alive !== false; p.weapon = s.weapon || p.weapon
        if (Number.isFinite(s.score)) { p.score = s.score; p.maxScore = Math.max(p.maxScore, s.score) }
      }
    }
    if (Array.isArray(ev.zombies)) {
      this.zombies = ev.zombies
      this.zombiesAliveMax = Math.max(this.zombiesAliveMax, ev.zombies.length)
    }
  }

  ev_perf(ev) { this.perf = { p50: ev.frame_ms_p50, p99: ev.frame_ms_p99, cpu: ev.cpu_pct, at: Date.now() } }

  ev_notify(ev) { /* finish/signal matching happens in checkFinish */ }

  // Not in game-link v0 as shipped; added so `{"dvar":...}` manifest conditions and the
  // vault's "dvar log" in the replay have a source. See docs/protocol/game-link-v0.md.
  ev_dvar(ev) { this.dvars[ev.name] = ev.value }

  // Also an addition to v0: the DLL polls an allow-list of `level.<name>` script
  // variables and reports changes. Needed for `{"level_var":...}` manifest conditions —
  // nazi_zombie_ali's real ending sets `level.tom_victory`, which never notifies.
  ev_level_var(ev) { this.levelVars[ev.name] = ev.value }

  ev_game_over(ev) {
    if (this.phase === 'over') return
    this.endedMs = ev.ms ?? this.now()
    this.endReason = ev.reason || 'game_over'
    if (Number.isFinite(ev.round)) this.maxRound = Math.max(this.maxRound, Number(ev.round))
    this.finishGame(this.endReason)
  }

  ev_log(ev) { if (ev.level === 'error') this.log.warn(`game: ${ev.msg}`) }

  ev_reply(ev) { this.emit('reply', ev) }

  touch(slot, ms) {
    const p = this.players.get(slot); if (!p) return
    p.lastInputMs = ms ?? this.now()
    if (p.afkWarned) { p.afkWarned = false; this.log.info(`slot ${slot} ${p.name} is back`) }
    this.allAfkSinceMs = null
  }

  // ---- lifecycle ---------------------------------------------------------------
  goLive(ms) {
    if (this.phase !== 'loading' && this.phase !== 'boot') return
    this.phase = 'live'
    this.startedMs = ms
    for (const p of this.players.values()) p.lastInputMs = ms
    this.log.info(`game live: ${this.map} (${this.mode}) cap ${this.vip ? 'none (VIP)' : fmtMin(this.capMs())}`)
    this.emit('live')
  }

  /** Swap in the manifest for the map that just loaded, before any finish is evaluated. */
  setManifest(m) {
    this.manifest = m || defaultManifest(this.map)
    this.eval = new ManifestEvaluator(this.manifest)
    if (this.eval.manualFinishes.length) {
      this.log.warn(`manifest ${this.manifest.map}: finish(es) [${this.eval.manualFinishes.join(', ')}] are {"manual":true} and will NEVER award automatically`)
    }
  }

  checkFinish(ev) {
    if (this.phase === 'over') return
    const ctx = { round: this.round, maxRound: this.maxRound, players: this.players.size, dvars: this.dvars, levelVars: this.levelVars }
    const { finishes, signals } = this.eval.feed(ev, ctx)
    for (const s of signals) {
      this.signals.add(s.id)
      this.log.info(`signal: ${s.id} (${s.label})`)
      this.emit('signal', { id: s.id, label: s.label, ms: s.atMs })
    }
    for (const f of finishes) {
      this.log.info(`FINISH: ${f.kind} "${f.label}" (priority ${f.priority}) at round ${this.round}`)
      this.emit('finish', { id: f.id, kind: f.kind, label: f.label, priority: f.priority, at_round: f.atRound })
    }
    // Best-so-far, by the schema's priority order (1 = Easter Egg beats 3 = Round N).
    // Reaching the EE does NOT end the game: people carry on, and the badge follows the
    // best finish the game ever reached.
    this.finish = this.eval.best()
  }

  pause(reason = 'manual') {
    if (this.phase === 'paused' || this.phase === 'over') return false
    this.pausePhaseBefore = this.phase
    this.phase = 'paused'
    this.pauseReason = reason
    this.pauses.push({ fromMs: this.now(), toMs: null, reason, at: Date.now() })
    this.flags.add('paused')
    this.send({ t: 'pause' })
    this.say(`Game paused (${reason}).`)
    this.log.info(`paused: ${reason}`)
    this.emit('paused', reason)
    return true
  }

  resume(reason = 'manual') {
    if (this.phase !== 'paused') return false
    const cur = this.pauses.at(-1)
    if (cur && cur.toMs == null) {
      cur.toMs = this.now()
      // Real time spent paused; the game clock does not move while frozen.
      cur.wallMs = Date.now() - cur.at
      this.pausedMs += cur.wallMs
      this.lastEventWall = Date.now()
    }
    this.phase = this.pausePhaseBefore || 'live'
    this.pauseReason = null
    this.send({ t: 'resume' })
    this.say(`Resuming (${reason}).`)
    this.log.info(`resumed: ${reason}`)
    this.emit('resumed', reason)
    return true
  }

  maybePauseForCrash(p) {
    if (this.phase !== 'live') return
    if (this.mode === 'verified' && this.recordProfile) return // record games: pause allowed, no restore
    const connected = [...this.players.values()].filter((x) => x.connected)
    if (connected.length === 0) {
      // Solo crash: hold the WHOLE game paused for the grace window. Nobody has this today.
      this.pause('player lost connection')
      this.crashGraceUntil = Date.now() + this.cfg.crashGraceMs
      this.flags.add('crash_pause')
    }
  }

  maybeResumeAfterCrash() {
    if (this.phase === 'paused' && this.crashGraceUntil) {
      this.crashGraceUntil = null
      this.resume('player is back')
      this.flags.add('resumed')
    }
  }

  /** Clean end: warn, record, tell the game to end, produce the summary. */
  finishGame(reason) {
    if (this.phase === 'over') return this.summary()
    if (this.endedMs == null) this.endedMs = this.now()
    this.phase = 'over'
    this.endReason = reason
    this.endedAt = Date.now()
    // Last look at the round finish: a game that ended AT the target round never emitted
    // another event for the evaluator to see.
    this.checkFinish({ t: 'round', n: this.maxRound, ms: this.endedMs })
    this.finish = this.eval.best()
    const s = this.summary()
    this.log.info(`game over: ${reason}, round ${this.maxRound}, ${fmtMin(this.elapsed())}`)
    this.emit('over', s)
    return s
  }

  // ---- periodic rules ----------------------------------------------------------
  /** Call ~1 Hz. Drives the cap, the warnings, AFK and the grace timers. */
  tick() {
    if (this.phase === 'over') return
    const now = this.now()
    this.tickCap(now)
    this.tickAfk(now)
    this.tickGrace(now)
    this.emit('tick', now)
  }

  tickCap(now) {
    const cap = this.capMs()
    if (!Number.isFinite(cap) || this.startedMs == null || this.phase === 'over') return
    const used = now - this.startedMs
    const left = cap - used
    for (const w of this.cfg.capWarnMs) {
      if (left <= w && !this.warnedCaps.has(w)) {
        this.warnedCaps.add(w)
        const mins = Math.round(w / MIN)
        this.say(`This game reaches the ${Math.round(cap / HOUR)}-hour limit in ${mins} minute${mins === 1 ? '' : 's'}. Everything so far is saved. VIP games are uncapped.`)
        this.log.info(`cap warning: ${mins} min left`)
        this.emit('cap_warning', { minutes: mins, leftMs: left })
      }
    }
    if (left <= 0 && this.phase !== 'ending') {
      this.phase = 'ending'
      this.flags.add('cap_reached')
      this.say('Time limit reached — ending the game and saving your run. Thanks for playing.')
      this.send({ t: 'end', reason: 'time_cap' })
      this.endingAt = Date.now()
      this.log.info('cap reached: clean end requested')
      // If the game does not confirm with game_over, end it ourselves after the grace.
      setTimeout(() => { if (this.phase === 'ending') this.finishGame('time_cap') }, this.cfg.capEndGraceMs).unref?.()
    }
  }

  tickAfk(now) {
    if (this.phase !== 'live') return
    const connected = [...this.players.values()].filter((p) => p.connected)
    if (!connected.length) return
    for (const p of connected) {
      const idle = now - (p.lastInputMs ?? now)
      if (idle < this.cfg.afkWarnMs) continue
      if (!p.afkWarned) {
        p.afkWarned = true
        const kickIn = Math.round((this.cfg.afkKickMs - this.cfg.afkWarnMs) / MIN)
        this.tell(p.slot, `You look AFK. Move within ${kickIn} minute${kickIn === 1 ? '' : 's'} or you will be removed.`)
        this.log.info(`AFK warn: slot ${p.slot} ${p.name} (${fmtMin(idle)} idle)`)
        this.emit('afk_warn', { slot: p.slot, name: p.name, idleMs: idle })
      }
      if (idle >= this.cfg.afkKickMs && !p.afkKicked) {
        p.afkKicked = true
        this.flags.add('afk_kick')
        this.send({ t: 'kick', slot: p.slot, reason: 'AFK' })
        this.log.warn(`AFK kick: slot ${p.slot} ${p.name}`)
        this.emit('afk_kick', { slot: p.slot, name: p.name, idleMs: idle })
      }
    }
    // Everyone idle => pause, then close (vault 4.4).
    const everyoneIdle = connected.every((p) => now - (p.lastInputMs ?? now) >= this.cfg.afkWarnMs)
    if (everyoneIdle) {
      if (this.allAfkSinceMs == null) this.allAfkSinceMs = now
      const idleFor = now - this.allAfkSinceMs
      if (idleFor >= this.cfg.allAfkPauseMs && this.phase === 'live') {
        this.pause('everyone is AFK')
        this.allAfkPausedAt = Date.now()
      }
    } else this.allAfkSinceMs = null
  }

  tickGrace(now) {
    // Crash grace expired with nobody back: close the game and save what we have.
    if (this.crashGraceUntil && Date.now() >= this.crashGraceUntil) {
      this.crashGraceUntil = null
      this.flags.add('abandoned')
      this.finishGame('players_did_not_return')
      return
    }
    if (this.allAfkPausedAt && Date.now() - this.allAfkPausedAt >= this.cfg.allAfkCloseMs) {
      this.allAfkPausedAt = null
      this.flags.add('all_afk')
      this.finishGame('everyone_afk')
      return
    }
    if (this.phase === 'live' || this.phase === 'paused') {
      const any = [...this.players.values()].some((p) => p.connected)
      if (!any && this.startedMs != null) {
        if (this.emptySinceMs == null) this.emptySinceMs = now
        else if (now - this.emptySinceMs >= this.cfg.emptyCloseMs) this.finishGame('empty')
      } else this.emptySinceMs = null
    }
  }

  // ---- outputs -----------------------------------------------------------------
  /** What the website stores. One row in `games` plus `game_players` (vault 99 §5.5). */
  summary() {
    const endMs = this.endedMs ?? this.now()
    const players = [...this.players.values()].map((p) => {
      this.creditAlive(p, endMs)
      return {
        slot: p.slot, steamid: p.steamid, name: p.name,
        score: p.maxScore, kills: p.kills, downs: p.downs, revives: p.revives, bleedouts: p.bleedouts,
        rounds_played: p.roundsPlayed, joined_round: p.joinedRound, late: p.late,
        reconnects: p.reconnects, afk_kicked: p.afkKicked, connected_at_end: p.connected,
        // IW4MAdmin ZombieClientStat-shaped block (MIT, feature/zombie-stats).
        stats: {
          kills: p.kills, deaths: p.bleedouts, headshots: p.headshots,
          downs: p.downs, revives: p.revives,
          points_earned: p.pointsEarned, points_spent: p.pointsSpent,
          highest_points: p.maxScore, time_alive_ms: p.timeAliveMs, rounds_played: p.roundsPlayed,
        },
      }
    })
    const eligible = this.mode !== 'local' && !this.flags.has('late_join') && !this.flags.has('all_afk')
    return {
      match_id: this.matchId,
      instance: this.instanceId,
      mode: this.mode,
      map: this.map,
      fs_game: this.fsGame,
      map_name: this.manifest.title || null,
      manifest: this.manifest.map || null,
      manifest_confidence: this.manifest.confidence || null,
      badge: this.eval.badgeEarned(),
      signals: [...this.signals],
      players,
      player_count: players.length,
      solo: players.length === 1,
      rounds: this.maxRound,
      finish: this.finish,
      duration_ms: this.elapsed(),
      duration_rta_ms: this.elapsedRta(),
      paused_ms: this.pausedMs,
      pauses: this.pauses.length,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      end_reason: this.endReason,
      flags: [...this.flags],
      records_eligible: eligible,
      xp_multiplier: this.mode === 'verified' ? 1 : this.mode === 'custom' ? 0.25 : 0,
      zombies_alive_max: this.zombiesAliveMax,
      chat_lines: this.chatLines,
      events: this.events,
      hashes: this.hashes,
      dvars: this.dvars,
      vip_uncapped: !!this.vip,
    }
  }

  /** The compact state the dashboard renders at ~4 Hz. */
  state() {
    return {
      instance: this.instanceId, match: this.matchId, phase: this.phase, mode: this.mode,
      map: this.map, map_name: this.manifest.title || null, round: this.round, maxRound: this.maxRound,
      elapsed_ms: this.elapsed(), rta_ms: this.elapsedRta(),
      cap_ms: Number.isFinite(this.capMs()) ? this.capMs() : null,
      cap_left_ms: Number.isFinite(this.capMs()) && this.startedMs != null ? this.capMs() - (this.now() - this.startedMs) : null,
      paused: this.phase === 'paused', pause_reason: this.pauseReason,
      finish: this.finish ? { kind: this.finish.kind, label: this.finish.label } : null,
      signals: [...this.signals],
      flags: [...this.flags], perf: this.perf,
      players: [...this.players.values()].map((p) => ({
        slot: p.slot, name: p.name, steamid: p.steamid, score: p.score, health: p.health,
        alive: p.alive, down: p.down, connected: p.connected, late: p.late,
        downs: p.downs, revives: p.revives, weapon: p.weapon, pos: p.pos, ang: p.ang,
        idle_ms: Math.max(0, this.now() - (p.lastInputMs ?? this.now())), afk_warned: p.afkWarned,
      })),
      zombies: this.zombies,
    }
  }
}

function fmtMin(ms) {
  if (!Number.isFinite(ms)) return 'none'
  const m = Math.floor(ms / MIN)
  return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`
}
