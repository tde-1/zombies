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
//   * the Verified environment (server dvars, client FPS cap) — verified-rules.md, verified.js
//
// CLOCK. Everything is measured on the GAME clock (`ms` on each event), not wall time, so
// a paused or stalled server does not burn a player's AFK budget and a fast-forwarded
// simulator exercises the 24 h cap in seconds. Between events the clock free-runs at wall
// speed from the last event, so a game that goes silent still hits its cap.
import { EventEmitter } from 'node:events'
import { ManifestEvaluator, defaultManifest } from './manifests.js'
import { EnvLog, judge } from './verified.js'

const MIN = 60_000
const HOUR = 60 * MIN
// Flags a game may put on its own `game_over` (game-link-v0). Anything else is ignored.
export const GAME_FLAGS = new Set(['server_freeze'])

export const DEFAULTS = {
  capMs: 24 * HOUR,
  capWarnMs: [30 * MIN, 10 * MIN, 1 * MIN],
  capEndGraceMs: 15_000,     // between the final warning and the clean end
  afkWarnMs: 10 * MIN,
  afkKickMs: 15 * MIN,
  allAfkPauseMs: 15 * MIN,   // everyone idle this long => pause the game
  allAfkCloseMs: 5 * MIN,    // ...then close it this long after the pause
  emptyCloseMs: 2 * MIN,     // nobody connected at all
  // vault 10 §5: 5–10 min, then a resume countdown. Ten since 2026-09-23: B's "resumable
  // from the server card" window, which the site keeps for the same ten minutes
  // (web/server/lib/seats.js RESUME_MS).
  crashGraceMs: 5 * MIN,     // a dropped player's window to come back (B 2026-09-24: 5-10 min)
  resumeCountdownMs: 10_000, // told to the players before the freeze lifts
  // DISCONNECT -> PAUSE -> RECONNECT (B 2026-09-24: "If someone disconnects from the game, it
  // pauses and allows people to reconnect and continue as if nothing happened"; vault 10 §5).
  // Any player who drops without quitting holds the WHOLE game -- co-op too, not only solo --
  // for `crashGraceMs`, each on their own clock. `dropPause:false` (host --drop-pause off,
  // ENW_DROP_PAUSE=off) is the old rule: only a solo game is held.
  dropPause: true,
  // A returning player on a DLL that sends `player_ready` (map_loaded.reconnect >= 1) is
  // counted down only once their input flows, i.e. they are past the loading screen. If it
  // never comes, the countdown starts anyway after this.
  readyWaitMs: 90_000,
  // A player whose connection came back by itself (`player_back`, a network blip) was never
  // gone from the world: a short countdown, not the full one.
  backResumeMs: 3_000,
  lateJoinGraceMs: 30_000,   // joining within this of go-live is not "late"
  // The Verified environment (lib/verified.js, verified-rules.md). Both OFF until the
  // 2026-09-23 DLL (server dvars) and a client with fps_guard are what everyone runs; a
  // missing report is then "unknown" on the result rather than a refusal. A value that WAS
  // reported and breaks the rule always refuses the record.
  verifiedRequireFpsReport: false,
  verifiedRequireServerEnv: false,
  // b2 allows FPS changes inside 20–250; the default refuses any change after go-live (the
  // strictest reading, clean on every board). A decision for the coordinator/B.
  verifiedAllowFpsChange: false,
}

let SEQ = 0

// The DLL's pause reasons (pause_policy.hpp), in the words the dashboard and summary use.
const PAUSE_LABEL = {
  solo_menu: 'pause menu',
  solo_chat: 'typing in chat',
  all_menu: 'everyone paused',
  operator: 'operator trigger',
}

export class Referee extends EventEmitter {
  constructor({ instanceId, matchId, mode = 'verified', manifest = null, config = {}, vip = false, gameMode = null, log }) {
    super()
    this.instanceId = instanceId
    this.matchId = matchId
    this.mode = mode                  // 'local' | 'custom' | 'verified'
    // The map's own game mode the lease asked for (game-modes.md), e.g. 'gungame', or null
    // for a map without one. `gameModeSeen` is what the DLL said it did about it.
    this.gameMode = gameMode
    this.gameModeSeen = { hidden: 0, answered: [], done: false, problem: null }
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
    this.recordCut = null          // [reconnect] the leaderboard stops here (applyRecordCut)
    this.signals = new Set()      // per-map manifest signals seen (ticks on the badge card)
    this.warnedCaps = new Set()
    this.pauses = []                  // { fromMs, toMs, reason }
    this.pausedMs = 0
    this.pauseReason = null
    this.pauseSource = null           // 'host' (we sent `pause`) | 'game' (its players did)
    this.gamePause = null             // the game's last `pause_state`, while paused
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
    this.recentCommands = []   // last 200, for diagnostics only
    this.dvars = {}
    this.env = new EnvLog()           // every server dvar value and client FPS report, in order
    this.envTold = new Set()          // violations already said in game (once each)
    this.levelVars = {}
    // Crash recovery: SteamID -> the state the game handed back when they dropped.
    // Keyed to the person, not the slot, and dropped when the grace window expires.
    this.held = new Map()
    this.resumeAt = null
    // Who the game is being held for: SteamID (or `slot:N` for a solo player with no account)
    // -> { slot, name, since, until, lost, down }. The drop hold lasts while this is not empty.
    this.away = new Map()
    this.quitters = new Set()      // SteamIDs the site says quit on purpose (no hold for them)
    this.reconnectV = 0            // map_loaded.reconnect: the DLL's reconnect support
    this.hashes = {}
    this.reported = null       // the game's own final result, verbatim (enriched game_over)
    this.matchEnd = null       // the game's "I am idle" (match_end)
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
    // A ring, not a log. This used to grow for the life of the game: harmless in a
    // 20-minute test, an unbounded array in a 24-hour one, and the referee is the one
    // object in the host that is guaranteed to live as long as the longest game.
    this.recentCommands.push(out)
    if (this.recentCommands.length > 200) this.recentCommands.shift()
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

  /**
   * The DLL answering the map's own mode menu (server/components/game_mode). `done` is the
   * map's own "vote over" notify, the only proof the mode took; `refused` / `lost` /
   * `timeout` mean the map's menu may have been shown and somebody picked by hand.
   */
  ev_game_mode(ev) {
    const g = this.gameModeSeen
    if (ev.state === 'hidden') g.hidden++
    else if (ev.state === 'answered') g.answered.push(String(ev.response || ''))
    else if (ev.state === 'done') g.done = true
    else if (['refused', 'lost', 'timeout'].includes(ev.state)) g.problem = `${ev.state}${ev.note ? `: ${ev.note}` : ''}`
    if (ev.mode && this.gameMode && ev.mode !== this.gameMode) g.problem = `the server ran '${ev.mode}', the lease asked for '${this.gameMode}'`
  }

  /** Did the requested mode demonstrably take? null when the lease asked for none. */
  gameModeApplied() {
    if (!this.gameMode) return null
    const g = this.gameModeSeen
    return g.done && !g.problem
  }

  ev_map_loaded(ev) {
    this.map = ev.map
    this.fsGame = ev.fs_game || null
    this.maxClients = ev.sv_maxclients
    this.reconnectV = Number(ev.reconnect) || 0
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
    // The same person coming back — matched on SteamID, never on the slot, because slots
    // are reused. The DLL binds our token to the slot on connect, so this is reliable.
    const returning = existing?.steamid === (ev.steamid || ev.xuid) ? existing
      : [...this.players.values()].find((x) => !x.connected && x.steamid && x.steamid === (ev.steamid || ev.xuid))
    if (returning) {
      if (returning.slot !== slot) {
        // Back in a different slot. Move the record; everything we know about them is
        // keyed to the person, and the held state is keyed to the SteamID anyway.
        this.players.delete(returning.slot)
        returning.slot = slot
        this.players.set(slot, returning)
      }
      this.welcomeBack(returning, slot, nowMs)
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
      // WHAT THIS PLAYER'S ACCOUNT IS WORTH (game-link-v0 `player_connect`.`identity`,
      // referee.md §13.2). `steamid` above is what the connect claimed; `identity` decides
      // whether it is allowed to reach the RESULT, and that gate is in `summary()`.
      identity: ev.identity || (ev.token ? 'claimed' : 'none'),
      identityReason: ev.identity_reason || null,
      partySlot: ev.party_slot ?? null,
      tokenOk: ev.token ? null : false, // resolved by the host's TokenGuard
    }
    this.players.set(slot, p)
    // A solo game with no account (Local/dev) cannot match its player coming back: whoever
    // connects is them.
    for (const [k, a] of [...this.away]) if (!a.steamid) this.releaseAway(k, 'back')
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

  /**
   * The same person, back in `slot` (a new connection, or the engine re-seating their old
   * slot). Restore what the policy allows, and release the hold once they are in the world.
   */
  welcomeBack(p, slot, nowMs) {
    const wasAway = this.away.get(this.awayKey(p))
    p.connected = true
    p.lost = false
    p.reconnects++
    p.disconnectedMs = null
    p.lastInputMs = nowMs
    p.alive = true
    p.afkWarned = false
    this.flags.add('rejoined')
    this.applyRecordCut(wasAway?.cut || p.dropCut || null, p.name)
    p.dropCut = null
    // "Resumed" is the casual-game tag (vault 10 §5): the game was held and the player put
    // back. A record game's rejoin is vanilla and is not tagged (records.js voids `resumed`).
    if (this.restoreAllowed()) this.flags.add('resumed')
    this.log.info(`slot ${slot} ${p.name} reconnected (${p.reconnects})`)
    const state = this.restoreAllowed() ? this.stateFor(p.steamid) : null
    if (state) {
      this.emit('restore_wanted', { slot, steamid: p.steamid, state })
      this.releaseState(p.steamid)
      this.tell(slot, this.reconnectV >= 1
        ? 'Welcome back. Your points and scoreboard are being put back.'
        : 'Welcome back — your points, weapons and perks have been restored.')
    } else if (!this.restoreAllowed()) {
      this.tell(slot, 'Welcome back. This is a record game, so nothing is restored — you rejoin as the game left you.')
    }
    // Vault 10 §5, "Always: block rejoin-after-bleedout". The server cannot stop the level's
    // own spawn script from standing a returning player up, so a player who dropped while
    // down (or dead) gets that for free -- the b2-banned ghost-spawn trick. The game says so.
    if (wasAway?.down) {
      this.flags.add('rejoined_while_down')
      this.log.warn(`${p.name} came back after dropping while down: game flagged rejoined_while_down`)
      this.tell(slot, 'You dropped while down. The record stops where you dropped; your stats still track.')
    }
    if (!wasAway) { this.maybeResumeAfterCrash(); return }
    if (this.reconnectV >= 1) {
      // Still on the loading screen: the countdown waits for their input (`player_ready`).
      wasAway.returnedAt = Date.now()
      wasAway.slot = slot
      wasAway.awaitingReady = true
      this.say(`${p.name} is back and loading in.`)
      this.emit('player_returning', { slot, name: p.name, steamid: p.steamid })
    } else {
      this.releaseAway(p, 'back')
    }
  }

  awayKey(p) { return p.steamid ? String(p.steamid) : `slot:${p.slot}` }

  /**
   * [reconnect] A snapshot of the run for the leaderboard (B 2026-09-24): "rejoined runs should
   * not be eligible to go onto the leaderboard ... you could submit the record up to the point
   * that they crash, but not the point after they rejoin." The round the game was on, the game
   * time and real time so far, and the finish only if it had already happened.
   */
  cutNow() {
    return {
      round: this.maxRound || 0,
      duration_ms: this.elapsed(),
      duration_rta_ms: this.elapsedRta(),
      finish: this.finish ? { ...this.finish } : null,
      at: new Date().toISOString(),
    }
  }

  /** Keep the EARLIEST cut: the leaderboard stops at the first crash anybody came back from. */
  applyRecordCut(cut, name) {
    const c = cut || this.cutNow()
    const first = !this.recordCut
    if (first || c.duration_ms < this.recordCut.duration_ms) this.recordCut = c
    if (first) {
      this.flags.add('record_cut')
      this.log.info(`${name} rejoined: the leaderboard takes this run up to round ${this.recordCut.round} (${this.recordCut.duration_ms} ms game time); stats go on`)
      this.say(`${name} rejoined. Your record is no longer eligible for leaderboards past round ${this.recordCut.round}, but your stats will still track.`)
    }
  }

  /**
   * The drop hold (vault 10 §5): a player who dropped without quitting holds the WHOLE game
   * for `crashGraceMs`, co-op included. The world is frozen by our `pause`; nothing moves
   * until they are back, their grace runs out, or the party host presses Continue without.
   */
  holdForDrop(p, { lost = false, state = null } = {}) {
    if (this.phase === 'ending' || this.phase === 'over') return
    const key = this.awayKey(p)
    if (p.steamid && this.quitters.has(String(p.steamid))) {
      this.log.info(`${p.name} quit on purpose: no hold`)
      return
    }
    if (p.kickedByUs || p.identity === 'refused') return
    const connected = [...this.players.values()].filter((x) => x.connected)
    // The old rule, kept behind the switch: only a solo game is held.
    if (!this.cfg.dropPause && connected.length > 0) return
    // A co-op hold needs to know who comes back; a solo one does not (anyone back is them).
    if (connected.length > 0 && !p.steamid) return
    // The players' own pause (e.g. the last one left from the Esc menu) gives way to the
    // drop hold: close its accounting, then hold the game ourselves.
    if (this.phase === 'paused' && this.pauseSource === 'game') this.resume('a player left', { fromGame: true })
    // Already holding for somebody: frozen by our pause, or -- when the game cannot freeze
    // (pauseUnavailable, ENW_NO_PAUSE on the box) -- waiting with the world running.
    const holding = this.away.size > 0 && (this.pauseUnavailable || (this.phase === 'paused' && this.pauseSource === 'host'))
    if (this.phase !== 'live' && !holding) return
    const until = Date.now() + this.cfg.crashGraceMs
    const down = !!(state && (state.down || state.alive === false)) || !!p.down
    const prev = this.away.get(key)
    // THE RECORD CUT (B 2026-09-24): where the run stood the moment they dropped. If they come
    // back, the leaderboard takes the run up to here and no further (welcomeBack).
    const cut = prev?.cut || this.cutNow()
    p.dropCut = p.dropCut || cut
    this.away.set(key, { slot: p.slot, name: p.name, steamid: p.steamid || null, since: prev?.since || Date.now(), until: prev?.until || until, lost, down: prev?.down || down, cut })
    this.crashGraceUntil = Math.max(...[...this.away.values()].map((a) => a.until))
    this.flags.add('crash_pause')
    const mins = Math.max(1, Math.round(this.cfg.crashGraceMs / MIN))
    if (!holding && this.pauseUnavailable) {
      // The game refused a freeze earlier in this match: wait for them, world running.
      if (connected.length) this.say(`${p.name} lost connection. Keeping their place for up to ${mins} min while they reconnect.`)
    } else if (!holding) {
      this.pause(connected.length ? `${p.name} lost connection` : 'player lost connection', { quiet: connected.length > 0 })
      // Remembered so a refusal ("pause not armed") can be told from any other reply.
      this.dropPauseId = this.recentCommands.at(-1)?.t === 'pause' ? this.recentCommands.at(-1).id : null
      this.resumeAt = null
      if (connected.length) this.say(`${p.name} lost connection. Paused for up to ${mins} min while they reconnect. The host can continue without them.`)
    } else if (!prev) {
      this.resumeAt = null   // a countdown for someone else is off: another one just dropped
      this.say(`${p.name} lost connection too. ${this.pauseUnavailable ? 'Keeping their place too.' : 'Still paused.'}`)
    }
    this.emit('player_away', { slot: p.slot, name: p.name, steamid: p.steamid || null, until: this.away.get(key).until })
  }

  /** One away player is dealt with (back, gone for good, quit). Resume when none is left. */
  releaseAway(p, why) {
    const key = typeof p === 'string' ? p : this.awayKey(p)
    const a = this.away.get(key)
    if (!a) return
    this.away.delete(key)
    this.emit('player_home', { name: a.name, steamid: a.steamid, why })
    if (this.away.size) {
      this.crashGraceUntil = Math.max(...[...this.away.values()].map((x) => x.until))
      return
    }
    this.crashGraceUntil = null
    if (why === 'back') { this.maybeResumeAfterCrash(); return }
    if (why === 'blip') { this.countdown(this.cfg.backResumeMs, `${a.name}'s connection is back`); return }
    // Gone for good (grace over, quit, Continue without): if nobody is left at all, the game ends.
    if (![...this.players.values()].some((x) => x.connected)) {
      this.flags.add('abandoned')
      this.flags.add('no_players')   // [RS] idle auto-close, lib/idle.js "ALL GONE"
      this.finishGame('players_did_not_return')
      return
    }
    if ((this.phase === 'paused' && this.pauseSource === 'host') || this.pauseUnavailable) this.countdown(this.cfg.resumeCountdownMs, why === 'continue' ? 'playing on' : `${a.name} did not come back`)
  }

  countdown(ms, why) {
    // Nothing to count down when the game never froze (pauseUnavailable): just say it.
    if (this.phase !== 'paused') { this.say(`${why[0].toUpperCase()}${why.slice(1)}.`); return }
    const secs = Math.max(0, Math.round(ms / 1000))
    if (secs > 0) {
      this.say(`${why[0].toUpperCase()}${why.slice(1)}. Resuming in ${secs} seconds.`)
      this.resumeAt = Date.now() + ms
      this.resumeWhy = why
      this.emit('resume_countdown', { seconds: secs })
    } else this.resume(why)
  }

  /**
   * The site says this player quit on purpose (the Esc menu's Exit game, POST
   * /api/party/quit; host.js reads it off the live-frame reply). A quit never holds the game;
   * if it already did (the quit reached us after the drop), let go.
   */
  markQuit(steamid) {
    const sid = String(steamid || '')
    if (!sid || this.quitters.has(sid)) return false
    this.quitters.add(sid)
    this.releaseState(sid)
    if (this.away.has(sid)) {
      const a = this.away.get(sid)
      this.log.info(`${a.name} quit on purpose: the hold for them is released`)
      this.kickGhost(a)
      this.releaseAway(sid, 'quit')
    }
    return true
  }

  /** A lost player's body is still seated; take it out before the world moves again. */
  kickGhost(a) {
    const p = this.players.get(a.slot)
    if (p && p.lost && (!a.steamid || String(p.steamid) === String(a.steamid))) {
      p.kickedByUs = true
      this.send({ t: 'kick', slot: a.slot, reason: 'did not reconnect' })
    }
  }

  /**
   * `player_lost` (reconnect_rules.hpp): no input from this slot for ~5 s, world running. The
   * body is still in the engine's slot; to us the player is gone, and the game is held now,
   * before the zombies finish what the drop started.
   */
  ev_player_lost(ev) {
    const p = this.players.get(ev.slot); if (!p || !p.connected) return
    p.connected = false
    p.lost = true
    p.disconnectedMs = ev.ms ?? this.now()
    p.disconnectReason = 'lost connection'
    this.log.info(`slot ${ev.slot} ${p.name} LOST (no input for ${ev.silent_ms ?? '?'} ms)`)
    if (ev.state && this.restoreAllowed() && p.steamid) this.holdState(p.steamid, ev.state)
    this.holdForDrop(p, { lost: true, state: ev.state || null })
  }

  /** `player_back`: the lost slot's input moves again. A blip, unless the engine re-seated it. */
  ev_player_back(ev) {
    const p = this.players.get(ev.slot); if (!p || !p.lost) return
    if (ev.reseated) { this.welcomeBack(p, ev.slot, ev.ms ?? this.now()); return }
    p.connected = true
    p.lost = false
    p.disconnectedMs = null
    p.lastInputMs = ev.ms ?? this.now()
    // Never left the world: the body kept everything, so nothing is restored.
    if (p.steamid) this.releaseState(p.steamid)
    this.log.info(`slot ${ev.slot} ${p.name}: connection back after ${ev.lost_ms ?? '?'} ms`)
    this.releaseAway(p, 'blip')
  }

  /** `player_ready`: a new connection's input flows -- they are in the world. */
  ev_player_ready(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    const a = this.away.get(this.awayKey(p))
    if (a && a.awaitingReady) this.releaseAway(p, 'back')
  }

  /** `restored`: the DLL applied (or could not apply) a restore. Recorded, not ruled on. */
  ev_restored(ev) {
    const p = this.players.get(ev.slot)
    if (ev.ok) this.log.info(`slot ${ev.slot} ${p?.name || ''} restored: score ${ev.score}, kills ${ev.kills}${ev.not_restored ? ` (not restored: ${ev.not_restored.join(', ')})` : ''}`)
    else this.log.warn(`slot ${ev.slot} ${p?.name || ''} NOT restored: ${ev.error || 'unknown'}`)
    this.emit('restored', { slot: ev.slot, ok: !!ev.ok, error: ev.error || null, not_restored: ev.not_restored || [] })
  }

  /**
   * The host's TokenGuard has answered. `verified` is the ONLY value that lets a steamid
   * out of `summary()` and onto somebody's leaderboard, and `token_check_disabled` — what
   * TokenGuard says when it holds no site key or is not enforcing — deliberately does not
   * grant it: that is not a check (game-link-v0 `auth`, referee.md §13.3).
   */
  setIdentity(slot, identity, reason = null) {
    const p = this.players.get(slot); if (!p) return
    p.identity = identity
    p.identityReason = reason
    if (identity === 'refused') p.steamid = null
  }

  ev_player_spawn(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    p.alive = true; p.down = false
    if (this.phase === 'loading') this.goLive(ev.ms ?? this.now())
  }

  ev_player_disconnect(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    if (p.lost) {
      // The body of a player we already called lost: the engine's own timeout, or our kick.
      // Everything about the drop was decided at `player_lost`.
      p.lost = false
      p.alive = false
      p.disconnectReason = ev.reason || p.disconnectReason
      if (ev.state && this.restoreAllowed() && p.steamid && !this.held.has(String(p.steamid))) this.holdState(p.steamid, ev.state)
      this.log.info(`slot ${ev.slot} ${p.name}: the lost connection's slot is free (${ev.reason || 'unknown'})`)
      return
    }
    p.connected = false
    p.alive = false
    p.disconnectedMs = ev.ms ?? this.now()
    p.disconnectReason = ev.reason || null
    this.log.info(`slot ${ev.slot} ${p.name} disconnected (${p.disconnectReason || 'unknown'})`)
    if (this.restoreAllowed()) {
      // The DLL now carries the state as of the player's last input on the event itself; an
      // older one is asked, NOW, while the level may still have it.
      if (ev.state && p.steamid) this.holdState(p.steamid, ev.state)
      else this.emit('snapshot_wanted', { slot: ev.slot, steamid: p.steamid, reason: 'disconnect' })
    }
    this.holdForDrop(p, { state: ev.state || null })
  }

  /**
   * Vault 10 §5, the policy table: casual and badge games get a FULL restore (points,
   * weapons incl. _upgraded, perks, position) and the game is tagged "Resumed". Record-
   * profile games get the pause but NO restore — putting a player back by hand is not
   * vanilla and would disqualify the run on ZWR/b2. So the restore is a mode decision,
   * not a capability decision, and it is made here rather than at the game.
   */
  restoreAllowed() { return !this.recordProfile && this.mode !== 'local' }

  /** The host hands back what `snapshot_state` returned, keyed to the person. */
  holdState(steamid, state) {
    if (!steamid || !state) return false
    this.held.set(String(steamid), { at: this.now(), wall: Date.now(), state })
    const limited = state.limited_weapons_held || []
    this.log.info(`holding state for ${steamid}${limited.length ? ` (limited weapons reserved: ${limited.join(', ')})` : ''}`)
    this.emit('state_held', { steamid, state })
    return true
  }

  /** What to give back to a returning player, or null if there is nothing (or it is stale). */
  stateFor(steamid) {
    const h = this.held.get(String(steamid))
    if (!h) return null
    if (Date.now() - h.wall > this.cfg.crashGraceMs) { this.held.delete(String(steamid)); return null }
    return h.state
  }

  releaseState(steamid) { this.held.delete(String(steamid)) }

  /** Limited weapons (Waffe, flamethrower) still counted as held by absent players. */
  reservedWeapons() {
    const out = []
    for (const [steamid, h] of this.held) for (const w of h.state.limited_weapons_held || []) out.push({ steamid, weapon: w })
    return out
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

  /**
   * STATS — the game's own scoreboard counters, absolute, whenever one moves (referee.md
   * §16, 2026-09-23). The real DLL has no kill event that names a player and its `points`
   * carry no `why`, so this is the ONLY source of kills and headshots from a real game;
   * before it, every real result said 0. Counters are monotonic within a connection, so
   * each is folded as a high-water mark: a `down`/`revive` edge folded a moment earlier
   * and the absolute value that follows it agree instead of double counting.
   */
  ev_stats(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    const hw = (k, v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0) p[k] = Math.max(p[k] || 0, n) }
    hw('kills', ev.kills)
    hw('headshots', ev.headshots)
    hw('downs', ev.downs)
    hw('revives', ev.revives)
    hw('assists', ev.assists)
    p.sawStats = true
  }

  ev_chat(ev) {
    this.chatLines++
    this.touch(ev.slot, ev.ms)
  }

  /**
   * CONTINUE WITHOUT (B 2026-09-24; replaces the `!continue` chat command). The party's host
   * pressed the button on the pause screen or the rail; the site checked it was the host
   * (web lib/seats.js continueWithout) and handed it over on a live-frame reply. The world
   * goes on, and the away players can still rejoin the game as it has moved on.
   */
  continueWithout(by = null) {
    if (!this.away.size) return false
    this.log.info(`the party host${by ? ` (${by})` : ''} pressed Continue without: no longer waiting for ${[...this.away.values()].map((a) => a.name).join(', ')}`)
    for (const [key, a] of [...this.away]) {
      this.releaseState(a.steamid)
      this.kickGhost(a)
      this.releaseAway(key, 'continue')
    }
    return true
  }

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
  ev_dvar(ev) {
    this.dvars[ev.name] = ev.value
    this.env.dvar(ev.name, ev.value, ev.ms)
    this.tellEnv()
  }

  // The client's FPS cap, as it reported it in userinfo `enw_fps` (client-dll fps_guard.cpp,
  // relayed by the server's referee). Keyed to the account when we know it, so a reconnect
  // into another slot keeps one history.
  ev_client_dvar(ev) {
    if (ev.name !== 'com_maxfps') return
    const p = this.players.get(ev.slot)
    this.env.clientFps(this.fpsKey(p, ev.slot), {
      name: p?.name ?? null, slot: ev.slot, value: ev.value, ms: ev.ms ?? null,
      live: this.startedMs != null,
    })
    this.tellEnv()
  }

  fpsKey(p, slot = p?.slot) {
    if (p?.steamid && this.env.fps.has(p.steamid)) return p.steamid
    if (this.env.fps.has(`slot${slot}`)) return `slot${slot}`
    return p?.steamid || `slot${slot}`
  }

  verifiedEnv() {
    const keys = []
    const names = {}
    for (const p of this.players.values()) {
      const k = this.fpsKey(p)
      keys.push(k)
      names[k] = p.name || k
    }
    return judge(this.env, {
      players: keys, names,
      requireFpsReport: !!this.cfg.verifiedRequireFpsReport,
      requireServerEnv: !!this.cfg.verifiedRequireServerEnv,
      allowFpsChange: !!this.cfg.verifiedAllowFpsChange,
    })
  }

  // A Verified game that has just stopped being record-eligible says so, once per reason,
  // in plain words. Not before go-live: the load is when settings settle.
  tellEnv() {
    if (this.mode !== 'verified' || this.startedMs == null) return
    for (const v of this.verifiedEnv().violations) {
      if (this.envTold.has(v)) continue
      this.envTold.add(v)
      this.flags.add('env_violation')
      this.say(`Not record-eligible any more: ${v}.`)
      this.log.warn(`verified env: ${v}`)
    }
  }

  // Also an addition to v0: the DLL polls an allow-list of `level.<name>` script
  // variables and reports changes. Needed for `{"level_var":...}` manifest conditions —
  // nazi_zombie_ali's real ending sets `level.tom_victory`, which never notifies.
  ev_level_var(ev) { this.levelVars[ev.name] = ev.value }

  /**
   * GAME OVER, and since 2026-09-22 it carries THE RESULT (game-link-v0, referee.md
   * §10.2): round, reason, duration, and a row per player including the ones who left.
   *
   * The contract says the host posts the result FROM THIS MESSAGE, not from a re-fold of
   * the stream — because a host that loses the link a second later still has the whole
   * answer in one line. So it is kept verbatim as `reported` and reconciled in
   * `summary()`; it is not allowed to quietly overwrite what we folded, because the two
   * are measured differently and a disagreement is information.
   */
  ev_game_over(ev) {
    if (this.phase === 'over') return
    this.endedMs = ev.ms ?? this.now()
    this.endReason = ev.reason || 'game_over'
    if (Number.isFinite(ev.round)) this.maxRound = Math.max(this.maxRound, Number(ev.round))
    this.reported = {
      round: Number.isFinite(ev.round) ? Number(ev.round) : null,
      reason: ev.reason || null,
      duration_ms: Number.isFinite(ev.duration_ms) ? Number(ev.duration_ms) : null,
      points_total: Number.isFinite(ev.points_total) ? Number(ev.points_total) : null,
      downs_total: Number.isFinite(ev.downs_total) ? Number(ev.downs_total) : null,
      // Only from a DLL whose native scoreboard fields verified (referee.md §16); absent,
      // not 0, from one that could not read them.
      kills_total: Number.isFinite(ev.kills_total) ? Number(ev.kills_total) : null,
      players_alive: Number.isFinite(ev.players_alive) ? Number(ev.players_alive) : null,
      players: Array.isArray(ev.players) ? ev.players.filter((x) => x && typeof x === 'object') : [],
      dvars: ev.dvars && typeof ev.dvars === 'object' ? ev.dvars : null,
      flags: Array.isArray(ev.flags) ? ev.flags.filter((f) => typeof f === 'string').slice(0, 8) : [],
      at: new Date().toISOString(),
    }
    // Flags the GAME raises about itself. Only the known ones reach the record, so a DLL
    // cannot write an arbitrary word onto a result. `server_freeze` (dedi.md §23): the
    // server stopped simulating and its watchdog ended the match; the result stands as it
    // was at the freeze and is marked, not refused.
    for (const f of this.reported.flags) if (GAME_FLAGS.has(f)) this.flags.add(f)
    this.env.seedFromGameOver(ev.dvars)
    this.finishGame(this.endReason)
  }

  /**
   * MATCH END — "this game process is idle and the instance can be reclaimed" and nothing
   * else. It changes no rule and decides no result; the DISPOSITION is the host's, in
   * host.js `Game.dispose()`. It is recorded here only so the summary can say whether the
   * game ever told us it was idle, which is what decides reuse from teardown.
   */
  ev_match_end(ev) {
    this.matchEnd = {
      round: Number.isFinite(ev.round) ? Number(ev.round) : null,
      reason: ev.reason || null,
      duration_ms: Number.isFinite(ev.duration_ms) ? Number(ev.duration_ms) : null,
      replay_closed: ev.replay_closed !== false,
      server_alive: ev.server_alive !== false,
      awaiting: ev.awaiting || null,
      at: new Date().toISOString(),
    }
    this.log.info(`match_end: the game process says it is idle (server_alive=${this.matchEnd.server_alive}) at round ${this.matchEnd.round ?? '?'}`)
    this.emit('match_end', this.matchEnd)
  }

  ev_log(ev) { if (ev.level === 'error') this.log.warn(`game: ${ev.msg}`) }

  ev_reply(ev) {
    // [reconnect] Our drop-hold `pause` refused by the game ("pause not armed": the box's
    // ENW_NO_PAUSE=1, a listen server, a gate that failed its byte check). The world is NOT
    // frozen, so the referee must not account it as paused or tell the site it is: undo the
    // accounting, keep waiting for the away players (held state, restore, kick at the end of
    // the grace) without the freeze.
    if (!ev.ok && ev.id && ev.id === this.dropPauseId) {
      this.dropPauseId = null
      this.pauseUnavailable = true
      this.flags.add('pause_unavailable')
      this.log.warn(`the game refused the drop-hold pause (${ev.error || 'no reason'}): waiting for the away player(s) WITHOUT a freeze`)
      if (this.phase === 'paused' && this.pauseSource === 'host') {
        const cur = this.pauses.at(-1)
        if (cur && cur.toMs == null) this.pauses.pop()
        this.phase = this.pausePhaseBefore || 'live'
        this.pauseReason = null
        this.pauseSource = null
        this.resumeAt = null
      }
      if (this.away.size) this.say('This server cannot pause right now, so the game carries on while they reconnect.')
    }
    this.emit('reply', ev)
  }

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

  /**
   * `fromGame`: the GAME froze itself because its players asked (Esc menu / typing, the rule
   * in server/components/pause/pause_policy.hpp, reported as `pause_state`). The referee only
   * accounts it -- sending `pause` back would turn the players' pause into a host hold that
   * their unpausing could never release. Every pause, whoever asked, is excluded from in-game
   * time the same way (referee.md §15).
   */
  pause(reason = 'manual', { fromGame = false, quiet = false } = {}) {
    if (this.phase === 'paused' || this.phase === 'over') return false
    this.pausePhaseBefore = this.phase
    this.phase = 'paused'
    this.pauseReason = reason
    this.pauseSource = fromGame ? 'game' : 'host'
    this.pauses.push({ fromMs: this.now(), toMs: null, reason, source: this.pauseSource, at: Date.now() })
    this.flags.add('paused')
    if (!fromGame) {
      this.send({ t: 'pause' })
      if (!quiet) this.say(`Game paused (${reason}).`)
    }
    this.log.info(`paused: ${reason}${fromGame ? ' (the players)' : ''}`)
    this.emit('paused', reason)
    return true
  }

  resume(reason = 'manual', { fromGame = false } = {}) {
    if (this.phase !== 'paused') return false
    const cur = this.pauses.at(-1)
    if (cur && cur.toMs == null) {
      cur.toMs = this.now()
      // Real time spent paused; the game clock does not move while frozen.
      cur.wallMs = Date.now() - cur.at
      this.pausedMs += cur.wallMs
      this.lastEventWall = Date.now()
      // Nobody gives input from a pause menu. Without this a twelve-minute pause resumes
      // straight into an AFK warning (and a sixteen-minute one into a kick).
      for (const p of this.players.values()) if (p.lastInputMs != null) p.lastInputMs += cur.wallMs
      if (this.allAfkSinceMs != null) this.allAfkSinceMs += cur.wallMs
    }
    const src = this.pauseSource
    if (!fromGame && this.away.size) {
      // Our hold lifted with players still away (an operator, or the countdown after
      // Continue without): their bodies leave now, and they rejoin the game as it has moved on.
      for (const a of this.away.values()) { this.kickGhost(a); this.releaseState(a.steamid) }
      this.away.clear()
      this.crashGraceUntil = null
    }
    this.phase = this.pausePhaseBefore || 'live'
    this.pauseReason = null
    this.pauseSource = null
    if (!fromGame) {
      this.send({ t: 'resume' })
      this.say(`Resuming (${reason}).`)
    }
    // No ceiling on a pause (B, 2026-09-22) -- so every one is logged with its length.
    this.log.info(`resumed: ${reason} (${src || 'host'} pause, ${Math.round((cur?.wallMs || 0) / 1000)} s, ${[...this.players.values()].filter((p) => p.connected).length} connected)`)
    this.emit('resumed', reason)
    return true
  }

  /**
   * The game's own pause state (game-link-v0 `pause_state`). `reason` is the DLL's:
   * host | solo_menu | solo_chat | all_menu | none. A `host` state is our own hold echoed
   * back, already accounted by pause()/resume(), so it changes nothing here.
   */
  ev_pause_state(ev) {
    this.gamePause = ev.paused ? { reason: ev.reason || 'unknown', players: ev.players ?? null } : null
    if (ev.reason === 'host') return
    const label = PAUSE_LABEL[ev.reason] || String(ev.reason || 'paused')
    if (ev.paused) {
      // Only a LIVE game has in-game time to exclude; a freeze during the load is shown
      // (gamePause) but not accounted.
      if (this.phase === 'live') this.pause(label, { fromGame: true })
      else if (this.phase === 'paused' && this.pauseSource === 'game') this.pauseReason = label
    } else if (this.phase === 'paused' && this.pauseSource === 'game') {
      this.resume('the players unpaused', { fromGame: true })
    }
  }

  /** One client's pause-menu / chat state (game-link-v0 `ui`). Shown, never ruled on here. */
  ev_ui(ev) {
    const p = this.players.get(ev.slot); if (!p) return
    p.ui = ev.ui || 'clear'
    p.pauseOnChat = ev.pchat !== false
  }

  /** Everyone the drop hold was for is back: count down, then let the world go. */
  maybeResumeAfterCrash() {
    if (this.phase !== 'paused' || this.pauseSource !== 'host' || this.away.size) return
    this.crashGraceUntil = null
    // A countdown, not a jump cut: unfreezing a player who is still reading the loading
    // screen hands them to a zombie. Vault 10 §5 calls this "a resume countdown".
    const secs = Math.max(0, Math.round(this.cfg.resumeCountdownMs / 1000))
    if (secs > 0) {
      this.say(`Everyone is back. Resuming in ${secs} seconds.`)
      this.resumeAt = Date.now() + this.cfg.resumeCountdownMs
      this.resumeWhy = null
      this.emit('resume_countdown', { seconds: secs })
    } else this.resume('player is back')
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
        p.kickedByUs = true   // our kick is not a drop: no hold for it
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
    if (this.resumeAt && Date.now() >= this.resumeAt) { this.resumeAt = null; this.resume(this.resumeWhy || 'everyone is back'); this.resumeWhy = null }
    // The drop hold: each away player has their own grace. A returning player who never gets
    // past the loading screen is counted down anyway after readyWaitMs. When the last grace
    // runs out with nobody connected, releaseAway closes the game and saves what we have.
    if (this.away.size) {
      const t = Date.now()
      const all = this.crashGraceUntil != null && t >= this.crashGraceUntil
      for (const [key, a] of [...this.away]) {
        if (a.awaitingReady && t - a.returnedAt >= this.cfg.readyWaitMs) {
          this.log.warn(`${a.name} came back but sent no input for ${Math.round(this.cfg.readyWaitMs / 1000)} s: counting down anyway`)
          this.releaseAway(key, 'back')
        } else if (!a.awaitingReady && (all || t >= a.until)) {
          this.log.info(`${a.name} did not come back within the grace window`)
          this.releaseState(a.steamid)
          this.kickGhost(a)
          this.releaseAway(key, 'gone')
        }
        if (this.phase === 'over') return
      }
    } else if (this.crashGraceUntil && Date.now() >= this.crashGraceUntil) {
      this.crashGraceUntil = null
    }
    if (this.allAfkPausedAt && Date.now() - this.allAfkPausedAt >= this.cfg.allAfkCloseMs) {
      this.allAfkPausedAt = null
      this.flags.add('all_afk')
      this.finishGame('everyone_afk')
      return
    }
    if (this.phase === 'live' || this.phase === 'paused') {
      const any = [...this.players.values()].some((p) => p.connected)
      // Not while a crash hold is open: the empty close (two minutes) used to end a solo
      // crash-paused game long before its grace window, so nobody could ever resume one.
      if (!any && this.startedMs != null && !this.crashGraceUntil) {
        if (this.emptySinceMs == null) this.emptySinceMs = now
        else if (now - this.emptySinceMs >= this.cfg.emptyCloseMs) { this.flags.add('no_players'); this.finishGame('empty') }
      } else this.emptySinceMs = null
    }
  }

  // ---- outputs -----------------------------------------------------------------
  /** What the website stores. One row in `games` plus `game_players` (vault 99 §5.5). */
  summary() {
    const endMs = this.endedMs ?? this.now()
    // The game's own row for this slot, if it sent one. Matched on steamid first — a slot
    // number is reused when somebody leaves and somebody else joins, and attaching one
    // person's score to another is the worst failure this file has.
    const rep = this.reported
    const mismatches = []
    const reportedFor = (p) => {
      if (!rep) return null
      return rep.players.find((r) => r.steamid != null && String(r.steamid) === String(p.steamid))
          || rep.players.find((r) => r.steamid == null && Number(r.slot) === Number(p.slot))
          || null
    }
    // BOTH NUMBERS ARE LOWER BOUNDS, so the larger is the better estimate and neither is
    // a lie. The game's figure is a poll of a script variable and reads 0 when script
    // variables are unbound (referee.md §10.2 is explicit that `0 point(s)` is honest, not
    // a bug); ours is a fold of a stream the link is allowed to drop nothing from but
    // which starts when we attach, so a late-attached host under-counts. Taking the max
    // of two floors is correct for a monotonic counter — and any disagreement is recorded
    // rather than resolved silently.
    const reconcile = (name, folded, reportedVal, who) => {
      if (!Number.isFinite(reportedVal)) return folded
      // ONLY `game > folded` IS AN ANOMALY, and this is the whole of the asymmetry:
      //   game < folded  is EXPECTED and honest. The game's figures are polls of script
      //     variables that read 0 when the variables are unbound (referee.md 10.2), and
      //     `score` is the wallet AT GAME OVER while ours is the highest wallet ever held
      //     — a player who bled out or bought a door ends below their peak, every time.
      //   game > folded  means the game counted something that never reached us, which is
      //     the one direction that says evidence went missing. That gets flagged.
      if (Number.isFinite(folded) && reportedVal > folded) mismatches.push(`${who}.${name}: game=${reportedVal} > ours=${folded}`)
      return Math.max(Number(folded) || 0, reportedVal)
    }
    const players = [...this.players.values()].map((p) => {
      this.creditAlive(p, endMs)
      const r = reportedFor(p) || {}
      const who = p.name || `slot${p.slot}`
      // IDENTITY GATES THE ACCOUNT, and this is the only place it is enforced on the way
      // out. The game's own row wins if it sent one, because the game is what decided
      // whether the token survived its own checks (single use, bound to the lease, one
      // account one slot — referee.md §13.4); ours is the fallback for a row it did not
      // send. Anything short of `verified` posts with NO steamid: the site then records
      // attendance in `summary_json` and creates no `game_players` row, so nothing is
      // credited to an account nobody checked.
      const identity = r.identity || p.identity || 'none'
      const verified = identity === 'verified'
      const claimed = r.steamid ?? p.steamid ?? null
      // ONE reconciled value per counter, used for BOTH the top-level field and the
      // `stats` block. The site reads `stats.<x>` first (web results.js), and `stats` used
      // to carry the raw fold — so a count the game reported and the link never folded
      // was reconciled here and then thrown away on the way into game_players.
      const kills = reconcile('kills', p.kills, Number(r.kills), who)
      const headshots = reconcile('headshots', p.headshots, Number(r.headshots), who)
      const downs = reconcile('downs', p.downs, Number(r.downs), who)
      const revives = reconcile('revives', p.revives, Number(r.revives), who)
      return {
        slot: p.slot,
        steamid: verified ? claimed : null,
        claimed_steamid: verified ? null : claimed,
        identity,
        identity_reason: r.identity_reason ?? p.identityReason ?? null,
        party_slot: r.party_slot ?? p.partySlot ?? null,
        name: p.name,
        // `score` is the HIGHEST WALLET the player held, which is what the boards have
        // always meant by score and what the site reads. The game's `score` is the wallet
        // at game over and its `score_total` is cumulative points EARNED — three
        // different numbers, and reconciling across them (which the first version of this
        // did) flags a mismatch on every game that ever bought a door.
        score: reconcile('score', p.maxScore, Number(r.score), who),
        score_total: reconcile('score_total', p.pointsEarned, Number(r.score_total), who),
        kills,
        headshots,
        downs,
        revives,
        bleedouts: p.bleedouts,
        // What the GAME said about this player, kept verbatim beside what we folded. The
        // site reads the fields above; this is here so a dispute can be settled from the
        // replay without re-deriving anything.
        reported: r.slot == null && r.steamid == null ? null : { ...r },
        folded: { score: p.maxScore, score_total: p.pointsEarned, kills: p.kills, headshots: p.headshots, downs: p.downs, revives: p.revives },
        rounds_played: p.roundsPlayed, joined_round: p.joinedRound, late: p.late,
        reconnects: p.reconnects, afk_kicked: p.afkKicked, connected_at_end: p.connected,
        // IW4MAdmin ZombieClientStat-shaped block (MIT, feature/zombie-stats).
        stats: {
          kills, deaths: p.bleedouts, headshots,
          downs, revives,
          points_earned: p.pointsEarned, points_spent: p.pointsSpent,
          highest_points: p.maxScore, time_alive_ms: p.timeAliveMs, rounds_played: p.roundsPlayed,
        },
      }
    })
    // A player the GAME reported and we never saw connect. It should not happen; if it
    // does, the row is carried through rather than dropped, flagged, and given no
    // SteamID-bearing identity it did not come with.
    if (rep) {
      for (const r of rep.players) {
        const seen = players.some((p) => (r.steamid != null && String(p.steamid) === String(r.steamid)) || (r.steamid == null && Number(p.slot) === Number(r.slot)))
        if (seen) continue
        mismatches.push(`slot${r.slot}: in the game's result, never seen on the link`)
        players.push({
          slot: r.slot ?? null,
          steamid: r.identity === 'verified' ? (r.steamid ?? null) : null,
          claimed_steamid: r.identity === 'verified' ? null : (r.steamid ?? null),
          identity: r.identity || 'none',
          identity_reason: r.identity_reason ?? null,
          party_slot: r.party_slot ?? null,
          name: r.name ?? null,
          score: Number(r.score) || 0, score_total: Number(r.score_total) || 0, kills: Number(r.kills) || 0,
          headshots: Number(r.headshots) || 0,
          downs: Number(r.downs) || 0, revives: Number(r.revives) || 0, bleedouts: 0,
          reported: { ...r }, folded: null,
          rounds_played: 0, joined_round: null, late: false, reconnects: 0,
          afk_kicked: false, connected_at_end: r.connected !== false,
          unseen_on_link: true,
          stats: { kills: Number(r.kills) || 0, deaths: 0, headshots: Number(r.headshots) || 0, downs: Number(r.downs) || 0, revives: Number(r.revives) || 0,
                   points_earned: 0, points_spent: 0, highest_points: Number(r.score_total ?? r.score) || 0,
                   time_alive_ms: 0, rounds_played: 0 },
        })
      }
      players.sort((x, y) => (x.slot ?? 99) - (y.slot ?? 99))
    }
    if (mismatches.length) {
      this.flags.add('result_mismatch')
      this.log.warn(`the game counted ${mismatches.length} thing(s) we never saw on the link: ${mismatches.slice(0, 6).join('; ')}`)
    }
    // The Verified environment: a reported setting outside the rules refuses the record
    // (lib/verified.js). What it enforced and what it saw go on the result either way, so a
    // record carries its own proof.
    const verifiedEnv = this.verifiedEnv()
    if (this.mode === 'verified' && !verifiedEnv.ok) this.flags.add('env_violation')
    // A mode that did not demonstrably take means the map's menu may have been shown and
    // somebody chose by hand: the run is real, but nobody can say which board it belongs on.
    const modeApplied = this.gameModeApplied()
    if (modeApplied === false) {
      this.flags.add('game_mode_unconfirmed')
      this.log.warn(`game mode '${this.gameMode}' not confirmed by the server (${this.gameModeSeen.problem || 'no done notify'}); not record-eligible`)
    }
    const eligible = this.mode !== 'local' && !this.flags.has('late_join') && !this.flags.has('all_afk') &&
      !(this.mode === 'verified' && !verifiedEnv.ok) && modeApplied !== false
    return {
      match_id: this.matchId,
      instance: this.instanceId,
      mode: this.mode,
      map: this.map,
      fs_game: this.fsGame,
      game_mode: this.gameMode,
      game_mode_applied: modeApplied,
      game_mode_seen: this.gameMode ? { ...this.gameModeSeen, answered: [...this.gameModeSeen.answered] } : null,
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
      // The game's own final word, verbatim, and whether it told us it was idle. The
      // replay carries the raw events too; this is so the SITE has them without parsing
      // a signed container.
      reported: rep,
      match_end: this.matchEnd,
      result_mismatches: mismatches.length ? mismatches : null,
      duration_rta_ms: this.elapsedRta(),
      paused_ms: this.pausedMs,
      pauses: this.pauses.length,
      restores: [...this.players.values()].filter((p) => p.reconnects > 0).map((p) => ({ steamid: p.steamid, reconnects: p.reconnects })),
      states_held_at_end: [...this.held.keys()],
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      end_reason: this.endReason,
      flags: [...this.flags],
      // [reconnect] Somebody dropped and rejoined: the leaderboard takes the run up to here
      // (the earliest such drop) and no further. Stats, XP and achievements use the whole game.
      record_cut: this.recordCut || null,
      records_eligible: eligible,
      verified_env: verifiedEnv,
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
      paused: this.phase === 'paused', pause_reason: this.pauseReason, pause_source: this.pauseSource || null,
      game_pause: this.gamePause || null,
      finish: this.finish ? { kind: this.finish.kind, label: this.finish.label } : null,
      signals: [...this.signals],
      flags: [...this.flags], perf: this.perf,
      players: [...this.players.values()].map((p) => ({
        slot: p.slot, name: p.name, steamid: p.steamid, score: p.score, health: p.health,
        alive: p.alive, down: p.down, connected: p.connected, late: p.late,
        downs: p.downs, revives: p.revives, weapon: p.weapon, pos: p.pos, ang: p.ang,
        idle_ms: Math.max(0, this.now() - (p.lastInputMs ?? this.now())), afk_warned: p.afkWarned,
        ui: p.ui || 'clear', lost: !!p.lost,
      })),
      // The drop hold: who the game is paused for, and for how much longer (the site's rail
      // shows "<name> disconnected: paused, waiting to reconnect (m:ss)").
      away: [...this.away.values()].map((a) => ({
        name: a.name, steamid: a.steamid, slot: a.slot,
        left_ms: Math.max(0, a.until - Date.now()),
        returning: !!a.awaitingReady,
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
