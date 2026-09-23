// A fake WaW zombies game that speaks game-link-v0.
//
// This is NOT a claim about how WaW behaves internally. It is a plausible EVENT SOURCE at
// the real rates and shapes the protocol specifies, so the host agent, the referee, the
// replay writer and the dashboard can be built, tested and MEASURED before the DLL exists —
// and so the real DLL has something to be diffed against when it lands.
//
// What is modelled, and why it matters to the thing being measured:
//   * rounds ramping, zombie health/speed curves, max 24 alive  -> snapshot volume
//   * players training in a loop, zombies chasing in a conga line -> position entropy,
//     which is what actually decides how well zstd does on the tracks
//   * downs, revives, bleedouts, points, chat, doors, the box, an Easter egg at the end
//   * one player can be made AFK, one can join late, one can present a bad token
//
// Numbers marked [approx] are a sensible ramp, not measured WaW values. When the real DLL
// lands, replace the curves here from its logs; nothing else in the host depends on them.
import { EventEmitter } from 'node:events'
import { mulberry32 } from '../lib/util.js'

export const TICK_MS = 50            // 20 Hz — the player sample rate

const WEAPONS = ['colt', 'm1a1_carbine', 'mp40', 'thompson', 'stg44', 'ppsh', 'raygun', 'mg42', 'trenchgun']
const CHATTER = [
  'train em at the window', 'i need a revive', 'power is on', 'box moved to the other room',
  'got the ray gun', 'juggernog please', 'hold the stairs', 'kiting round 30 no problem',
  'gg', 'nice one', 'someone open the door', 'i am out of ammo', 'zombies behind you',
  'pack a punch ready', 'save the max ammo', 'wonder waffe from the box',
]

const round2 = (n) => Math.round(n * 10) / 10

// The Easter-egg / ending event sequence a given map actually produces, taken from the
// referee agent's manifests (referee/manifests/*.json). The simulator has to emit the
// REAL flags, not an invented `enw_ee_complete`: otherwise the demo proves only that the
// host can match a signal it made up itself.
const MAP_SCRIPTS = {
  nazi_zombie_factory: {
    // Der Riese "Fly Trap": hide_and_seek must come first (the manifest's `requires`),
    // then the three bear/monkey flags.
    easter_egg: [
      { t: 'notify', ent: 'level', name: 'hide_and_seek' },
      { t: 'notify', ent: 'level', name: 'ee_exp_monkey' },
      { t: 'notify', ent: 'level', name: 'ee_bowie_bear' },
      { t: 'notify', ent: 'level', name: 'ee_perk_bear' },
    ],
    power: [{ t: 'notify', ent: 'level', name: 'electricity_on' }],
  },
  nazi_zombie_asylum: { power: [{ t: 'notify', ent: 'level', name: 'electric_switch_used' }] },
  nazi_zombie_sumpf: { power: [{ t: 'notify', ent: 'level', name: 'electric_switch_used' }] },
  nazi_zombie_ali: {
    // The real ending is in the co-shipped ZCT mod, not the map: a 20,000-point
    // 'end_game' trigger sets level.tom_victory and calls end_game(). The map's own
    // 50,000-point zombie_door is just an expensive door (the manifest lists it as a
    // signal, and it is a convincing false positive — so the sim fires that FIRST).
    buyable_ending: [
      { t: 'notify', name: 'trigger', args: { targetname: 'zombie_door', zombie_cost: 50000 } },
      { t: 'notify', name: 'trigger', args: { targetname: 'end_game' } },
      { t: 'level_var', name: 'tom_victory', value: true },
      { t: 'level_var', name: 'intermission', value: true },
    ],
  },
  '*': {
    easter_egg: [{ t: 'notify', ent: 'level', name: 'enw_ee_complete' }],
    buyable_ending: [{ t: 'notify', ent: 'level', name: 'enw_buyable_ending' }],
    power: [{ t: 'notify', ent: 'level', name: 'enw_power_on' }],
  },
}

function mapScript(map, kind) {
  return MAP_SCRIPTS[map]?.[kind] || MAP_SCRIPTS['*'][kind] || null
}

export class ZombiesSim extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.rng = mulberry32(opts.seed ?? 1337)
    this.instance = opts.instance || 'sim-1'
    this.map = opts.map || 'nazi_zombie_asylum'
    this.fsGame = opts.fsGame || null
    this.mapName = opts.mapName || 'Verruckt'
    this.maxRound = opts.maxRound ?? 25
    this.eeRound = opts.eeRound ?? null            // fire the Easter egg on this round
    this.buyableEndingRound = opts.buyableEndingRound ?? null
    this.roundSeconds = opts.roundSeconds ?? null  // null = derived from the zombie count
    this.ms = 0
    this.round = 0
    this.phase = 'loading'
    this.paused = false
    this.over = false
    this.tick = 0
    this.zombies = []
    this.zid = 0
    this.spawnQueue = 0
    this.roundKills = 0
    this.roundTotal = 0
    this.nextSpawnMs = 0
    this.betweenUntil = 0
    this.players = new Map()
    this.pendingAuth = new Map()
    this.frameSamples = []
    this.lastPerfMs = 0
    this.powerOn = false
    this.papBuilt = false
    this.games = 0                                 // matches played on this instance
    this.gone = []                                 // players who left mid-match
    this.dead = false                              // the process is finished, not just the game
    this.endFails = !!opts.endFails                // model `reply.ok:false` on `end`
    // THE LEASE THIS PROCESS IS SERVING. The referee reads it from ENW_MATCH once at
    // process start and clears it on every reset, so a warm instance serving a match the
    // process never heard of has to be TOLD, in the `end` message, before the map_restart
    // (game-link-v0 `end`.`match`, referee.md §13.4). Null means "no lease": tokens bound
    // to any match are `wrong_match`, which is the safe direction.
    this.matchId = opts.matchId || null
    this.noMatchEnd = !!opts.noMatchEnd            // model a server that never says it is idle
    // THE REAL DLL ON A WARM INSTANCE (host.md §15.4, box journal 2026-09-23 12:17-12:19):
    // a client still connected when its game ended comes straight back into the restarted
    // map with its old token, and an `end` then reports a result for that session if
    // anybody connected since the last restart - round or no round. Off by default.
    this.realWarm = !!opts.realWarm
    this.connectedSinceRestart = 0
    // --stall-rebind N: the Nth restart that carries a match id accepts `end` and then never
    // brings the map back (inst-64, 12:19:30: "no map_loaded within 60000 ms"). 0 = never.
    this.stallRebind = Number(opts.stallRebind || 0)
    this.matchedRestarts = 0
    this.startedMs = 0
    this.loadedMs = 0

    // A rough playable box in WaW map units. Real maps are ~±2000.
    this.bounds = opts.bounds || { x: [-1800, 1800], y: [-1400, 1400], z: [0, 120] }
    this.spawnPoints = [[-1600, -1200], [1600, -1200], [1600, 1200], [-1600, 1200], [0, 1350], [0, -1350]]
  }

  emitEv(ev) { this.emit('event', { ms: Math.round(this.ms), ...ev }); return ev }

  // ---- players ---------------------------------------------------------------
  addPlayer(spec) {
    const slot = spec.slot ?? this.players.size
    const p = {
      slot,
      name: spec.name || `Player${slot + 1}`,
      steamid: spec.steamid || String(76561198000000000n + BigInt(slot + 1)),
      token: spec.token ?? null,
      afk: !!spec.afk,
      score: spec.score ?? 500,
      health: 100,
      alive: false,
      down: false,
      downUntil: 0,
      weapon: 'colt',
      stance: 'stand',
      kills: 0,
      // Counters the enriched `game_over` reports (game-link-v0, referee.md §10.2).
      // `scoreTotal` is CUMULATIVE points earned — `score` is the wallet and goes down
      // when they buy a door, so the two are different numbers and the result wants both.
      downs: 0,
      revives: 0,
      bleedouts: 0,
      scoreTotal: 0,                                 // points EARNED, matching referee.js pointsEarned (the 500 you start with is not earned)
      // Each player trains a different loop, at a different phase and radius.
      radius: 500 + this.rng() * 700,
      phase: this.rng() * Math.PI * 2,
      speed: 0.22 + this.rng() * 0.12,             // radians/second around the loop
      centre: [(this.rng() - 0.5) * 900, (this.rng() - 0.5) * 700],
      pos: [0, 0, 32],
      ang: [0, 0],
      trail: [],                                   // recent positions, for zombie chase lag
      lastInputState: null,
      lastInputMs: -99999,
      authed: spec.token == null,                  // no token flow => already in
      // WHAT THIS PLAYER'S ACCOUNT IS WORTH (game-link-v0 `player_connect`.`identity`,
      // referee.md §13.2). `none` = no token at all; `claimed` = a token was presented and
      // parsed and NOTHING has checked the signature; `verified` = the host answered
      // `auth allow:true` after a real check; `refused` = the host said no.
      identity: spec.identity || (spec.token != null ? 'claimed' : 'none'),
      identityReason: null,
      partySlot: spec.party_slot ?? null,
    }
    this.players.set(slot, p)
    return p
  }

  /** A client connecting: announce it and (if it presented a token) wait for `auth`. */
  connectPlayer(spec) {
    const p = this.addPlayer(spec)
    this.connectedSinceRestart++
    this.emitEv({
      t: 'player_connect', slot: p.slot, name: p.name,
      // `steamid`/`xuid` carry the id the SITE put in the invite token. It is sent on
      // `player_connect` even when only `claimed`, because the host needs it to decide;
      // what it must NOT do is reach the RESULT unchecked, and that gate is in `endGame`.
      steamid: p.steamid, xuid: p.steamid,
      identity: p.identity, ...(p.partySlot != null ? { party_slot: p.partySlot } : {}),
      ...(p.token ? { token: p.token } : {}),
    })
    if (p.token != null) this.pendingAuth.set(p.slot, p)
    else this.spawnPlayer(p)
    return p
  }

  spawnPlayer(p) {
    p.alive = true
    p.authed = true
    const a = this.rng() * Math.PI * 2
    p.pos = [round2(p.centre[0] + Math.cos(a) * p.radius), round2(p.centre[1] + Math.sin(a) * p.radius), 32]
    this.emitEv({ t: 'player_spawn', slot: p.slot })
  }

  disconnectPlayer(slot, reason) {
    const p = this.players.get(slot); if (!p) return
    // Keep the row: "a player who left mid-match still gets a row" (referee.md 10.2).
    ;(this.gone || (this.gone = [])).push({
      slot: p.slot, name: p.name, identity: p.identity, identity_reason: p.identityReason,
      ...(p.identity === 'verified' ? { steamid: p.steamid } : {}),
      score: p.score, score_total: p.scoreTotal, downs: p.downs, revives: p.revives,
    })
    this.players.delete(slot)
    this.zombies = this.zombies.filter((z) => z.target !== slot)
    this.emitEv({ t: 'player_disconnect', slot, reason })
  }

  // ---- rounds ------------------------------------------------------------------
  /** [approx] total zombies in a round, and how many may live at once (WaW caps at 24). */
  roundBudget(round, players) {
    const p = Math.max(1, players)
    const total = Math.round((p === 1 ? 6 : 6 * p) + 0.9 * p * Math.pow(round, 1.28))
    const maxAlive = Math.min(24, 6 + Math.floor(p * 1.5) + Math.floor(round * 1.2))
    return { total, maxAlive }
  }

  /** [approx] WaW-ish: 150 hp at round 1, +100 to round 9, then ×1.1 a round. */
  zombieHealth(round) {
    if (round <= 9) return 150 + (round - 1) * 100
    return Math.round(950 * Math.pow(1.1, round - 9))
  }

  zombieSpeed(round) {
    if (round <= 4) return 40 + round * 6                 // walkers
    if (round <= 8) return 90 + (round - 4) * 12          // runners
    return Math.min(210, 140 + (round - 8) * 4)           // sprinters
  }

  startRound(n) {
    this.round = n
    const { total, maxAlive } = this.roundBudget(n, this.livePlayers().length)
    this.roundTotal = total
    this.roundKills = 0
    this.spawnQueue = total
    this.maxAlive = maxAlive
    this.nextSpawnMs = this.ms + 500
    this.emitEv({ t: 'round', n })
    if (n === 1) this.phase = 'live'
    if (this.eeRound && n === this.eeRound) this.scheduleEe = this.ms + 25_000
    if (this.buyableEndingRound && n === this.buyableEndingRound) this.scheduleEnding = this.ms + 20_000
  }

  /** Everyone who has been admitted (including the downed and the bled-out). */
  livePlayers() { return [...this.players.values()].filter((p) => p.authed) }

  /** Everyone who can actually shoot: admitted, alive, on their feet. */
  shooters() { return [...this.players.values()].filter((p) => p.authed && p.alive && !p.down && !p.afk) }

  /** Anyone still in the game at all — up, or down and revivable. */
  standingOrDown() { return [...this.players.values()].filter((p) => p.authed && (p.alive || p.down)) }

  // ---- the loop ----------------------------------------------------------------
  /** Advance the simulation by one 50 ms tick and emit everything that happened. */
  step() {
    if (this.dead) return false
    if (this.paused) { return true }            // frozen: the clock does not move either
    this.ms += TICK_MS
    this.tick++

    // IDLE AFTER GAME OVER. The real dedicated server does not die at game over any more
    // (dedi.md 12.3 / no_save_reload.cpp): it sits there simulating an empty intermission
    // until the host sends `end` or kills it, and `match_end` exists to end that state.
    // This is that, so the host's disposition path has something honest to run against.
    // A `perf` line every 10 s is the only thing it still emits - a server that has gone
    // quiet and one that is idle must not look the same on the wire.
    if (this.over) { this.perf(); return true }

    if (this.phase === 'loading') {
      // ROUND 1 NEEDS SOMEBODY IN THE SERVER. It used to start 2 s after the map loaded
      // whatever the lobby held, which was harmless while a map load only ever happened
      // at boot with a roster behind it — and wrong the moment `end` made a map come back
      // on an EMPTY server, where it produced a `round` event on a warm instance with no
      // players in it. The real referee starts round 1 on `all_players_connected`.
      // --real-warm: the clients that came back into an unleased warm map sit in it; the
      // box's DLL reported that session at round 0 when the next lease's `end` arrived.
      const holding = this.realWarm && !this.matchId && this.games > 0
      if (!holding && this.ms > (this.loadedMs || 0) + 2000 && this.players.size) this.startRound(1)
      return true
    }

    this.movePlayers()
    this.spawnZombies()
    this.moveZombies()
    this.combat()
    this.chatter()
    this.scripted()
    this.wipeCheck()
    if (this.over) return true
    this.snapshot()
    this.perf()
    this.roundTransition()
    return true
  }

  movePlayers() {
    const dt = TICK_MS / 1000
    for (const p of this.players.values()) {
      if (!p.authed) continue
      if (p.down) {
        if (this.ms >= p.downUntil) this.bleedout(p)
        continue
      }
      if (p.afk) {
        // AFK is the absence of input, not the absence of a body: the player stands still.
        this.reportInput(p, { moved: false, turned: false, buttons: 0 })
        continue
      }
      p.phase += p.speed * dt
      // Training: a loop with a wobble, so the path is not a perfect circle (which would
      // compress unrealistically well).
      const wob = Math.sin(p.phase * 3.1) * 90
      const x = p.centre[0] + Math.cos(p.phase) * (p.radius + wob)
      const y = p.centre[1] + Math.sin(p.phase) * (p.radius * 0.8 + wob)
      const nx = clamp(x, this.bounds.x[0], this.bounds.x[1])
      const ny = clamp(y, this.bounds.y[0], this.bounds.y[1])
      const yaw = Math.atan2(ny - p.pos[1], nx - p.pos[0]) * 180 / Math.PI
      p.pos = [round2(nx), round2(ny), round2(32 + Math.sin(p.phase * 2) * 4)]
      // Keep ~2 s of history: a zombie chases where you WERE, which is what turns a
      // crowd into a conga line behind a training player instead of a pile on top of one.
      p.trail.push(p.pos)
      if (p.trail.length > 40) p.trail.shift()
      p.ang = [round2(-6 + Math.sin(p.phase * 5) * 9), round2(yaw + (this.rng() - 0.5) * 6)]
      p.health = Math.min(100, p.health + 1.5)   // ~3 s to full, WaW-ish, not 0.8 s
      this.reportInput(p, { moved: true, turned: true, buttons: this.rng() < 0.4 ? 1 : 0 })
    }
  }

  // Protocol: `input` is at most 10 Hz and only on change. A continuously-moving player
  // would otherwise emit 10/s forever, so: emit on a CHANGE of the moved/turned/fire
  // state, plus a 1 Hz heartbeat while active. That is what a sane DLL does and it is
  // what AFK scoring actually needs.
  reportInput(p, s) {
    const key = `${s.moved ? 1 : 0}${s.turned ? 1 : 0}${s.buttons ? 1 : 0}`
    const changed = key !== p.lastInputState
    const heartbeat = this.ms - p.lastInputMs >= 1000
    if (!changed && !heartbeat) return
    p.lastInputState = key
    p.lastInputMs = this.ms
    this.emitEv({ t: 'input', slot: p.slot, buttons: s.buttons, moved: s.moved, turned: s.turned })
  }

  spawnZombies() {
    if (this.betweenUntil > this.ms) return
    while (this.spawnQueue > 0 && this.zombies.length < this.maxAlive && this.ms >= this.nextSpawnMs) {
      const sp = this.spawnPoints[Math.floor(this.rng() * this.spawnPoints.length)]
      const targets = this.shooters()
      if (!targets.length) return
      const tgt = targets[Math.floor(this.rng() * targets.length)]
      this.zombies.push({
        id: ++this.zid,
        pos: [round2(sp[0] + (this.rng() - 0.5) * 120), round2(sp[1] + (this.rng() - 0.5) * 120), 32],
        health: this.zombieHealth(this.round),
        maxHealth: this.zombieHealth(this.round),
        speed: this.zombieSpeed(this.round) * (0.85 + this.rng() * 0.3),
        target: tgt.slot,
        lag: 0.15 + this.rng() * 0.85,   // seconds of chase lag; spreads the train out
      })
      this.spawnQueue--
      this.nextSpawnMs = this.ms + 400 + this.rng() * 700
    }
  }

  moveZombies() {
    const dt = TICK_MS / 1000
    for (const z of this.zombies) {
      let t = this.players.get(z.target)
      if (!t || !t.authed || t.down || !t.alive) {
        const alt = this.shooters()
        if (!alt.length) continue
        t = alt[Math.floor(this.rng() * alt.length)]
        z.target = t.slot
      }
      // Chase the player's position from a moment ago -> the conga line a trainer sees.
      // z.lag is 0–0.5 s, so the tail of a train is spread over half a second of the
      // player's path rather than standing in it.
      const back = Math.min(t.trail.length - 1, Math.round((z.lag * 1000) / TICK_MS))
      const aim = back > 0 ? t.trail[t.trail.length - 1 - back] : t.pos
      const dx = aim[0] - z.pos[0]
      const dy = aim[1] - z.pos[1]
      const d = Math.hypot(dx, dy) || 1
      const step = z.speed * dt
      z.pos = [round2(z.pos[0] + (dx / d) * step), round2(z.pos[1] + (dy / d) * step), 32]
    }
  }

  combat() {
    const shooters = this.shooters()
    if (!shooters.length || !this.zombies.length) return
    // [approx] Kill rate falls as zombie health climbs, so from the mid rounds the
    // spawn rate wins and a full train of 24 builds up and STAYS up. Getting this wrong
    // matters beyond looking right: the number of zombies alive is what sets the size of
    // the 10 Hz zombie track, which is most of a replay. An earlier version killed ~3/s
    // at round 4 and kept the map nearly empty, which under-measured replays badly.
    const hp = this.zombieHealth(this.round)
    const perSec = Math.max(0.15, Math.min(3, shooters.length * 0.5 * Math.pow(150 / hp, 0.25)))
    if (this.rng() < perSec * (TICK_MS / 1000)) {
      const i = Math.floor(this.rng() * this.zombies.length)
      const z = this.zombies[i]
      const killer = shooters[Math.floor(this.rng() * shooters.length)]
      this.zombies.splice(i, 1)
      this.roundKills++
      killer.kills++
      const head = this.rng() < 0.35
      const delta = head ? 100 : 60
      killer.score += delta
      killer.scoreTotal += delta
      this.emitEv({ t: 'points', slot: killer.slot, score: killer.score, delta, why: head ? 'headshot' : 'kill' })
      if (this.rng() < 0.02) this.emitEv({ t: 'notify', ent: 'level', name: 'powerup_drop', args: { kind: ['max_ammo', 'insta_kill', 'double_points', 'nuke', 'carpenter'][Math.floor(this.rng() * 5)] } })
    }
    // A zombie reaching a player hurts. PER HIT, not per tick: a zombie swings about once
    // a second, so applying a full hit 20 times a second (which the first version did)
    // killed a 4-player team by round 14 every time and made the measured game-hour a
    // third of an hour. ~1.1 s between swings is the WaW-ish figure.
    const swing = (TICK_MS / 1000) / 1.1
    for (const p of shooters) {
      // At most four bodies can reach you at once, however many are in the train. Without
      // this cap the conga line stacks on the player's exact position and a solo run dies
      // at round 11 every time, which is not what solo zombies looks like.
      const near = Math.min(4, this.zombies.filter((z) => Math.hypot(z.pos[0] - p.pos[0], z.pos[1] - p.pos[1]) < 45).length)
      if (!near) continue
      p.health -= near * (6 + this.round * 0.7) * swing
      if (p.health <= 0 && !p.down) this.goDown(p)
    }
    // Buys, doors and the box, at a plausible trickle.
    if (this.rng() < 0.004) {
      const p = shooters[Math.floor(this.rng() * shooters.length)]
      const kind = ['door', 'box', 'perk', 'wall_weapon', 'trap'][Math.floor(this.rng() * 5)]
      const cost = { door: 1000, box: 950, perk: 2500, wall_weapon: 1200, trap: 1000 }[kind]
      if (p.score >= cost) {
        p.score -= cost
        this.emitEv({ t: 'points', slot: p.slot, score: p.score, delta: -cost, why: kind })
        this.emitEv({ t: 'notify', ent: `player:${p.slot}`, name: 'trigger', args: { targetname: kind === 'door' ? 'zombie_door' : kind, zombie_cost: cost } })
        if (kind === 'box') { p.weapon = WEAPONS[Math.floor(this.rng() * WEAPONS.length)]; this.emitEv({ t: 'notify', ent: 'any', name: 'user_grabbed_weapon', args: { weapon: p.weapon, slot: p.slot } }) }
        if (kind === 'door' && !this.powerOn && this.rng() < 0.4) {
          this.powerOn = true
          for (const e of mapScript(this.map, 'power') || []) this.emitEv(e)
        }
      }
    }
  }

  // EVERYONE DOWN OR DEAD = THE GAME IS OVER. Without this the simulation deadlocks:
  // with no shooters left nothing kills a zombie, so the round never ends, so the
  // bled-out never respawn, and the clock runs forever at round 9. That is also what
  // actually happens in WaW — a team wipe ends the game — and the referee has to see the
  // `game_over` rather than a game that simply stops producing rounds.
  wipeCheck() {
    if (this.phase !== 'live' || this.over) return
    const inPlay = this.livePlayers()
    if (!inPlay.length) return
    if (this.shooters().length) { this.wipeSince = null; return }
    // A downed player with a revive on the way is not a wipe yet.
    const revivable = this.standingOrDown().some((p) => p.down) && (this.reviveAt?.length > 0)
    if (revivable) { this.wipeSince = null; return }
    // Every AFK player still counts as a body; a lobby of nothing but AFK players is the
    // referee's problem (it pauses then closes), not a wipe.
    if (inPlay.every((p) => p.afk)) { this.wipeSince = null; return }
    if (this.wipeSince == null) this.wipeSince = this.ms
    if (this.ms - this.wipeSince > 5000) this.endGame('all_players_down')
  }

  goDown(p) {
    p.down = true
    p.health = 0
    p.downUntil = this.ms + 30_000
    p.downs++
    this.emitEv({ t: 'down', slot: p.slot })
    // The same edge said in full, for the site's system line. Both are emitted, as the
    // real referee does (`server/components/referee/referee.cpp`): `down` is what the
    // host's fold counts, `player_down` is what a sentence needs.
    this.emitEv({ t: 'player_down', slot: p.slot, name: p.name, round: this.round, map: this.map, downs: p.downs })
    // A team-mate usually gets there.
    const helpers = this.shooters().filter((x) => x.slot !== p.slot)
    if (helpers.length && this.rng() < 0.8) {
      const by = helpers[Math.floor(this.rng() * helpers.length)]
      const at = this.ms + 3000 + this.rng() * 8000
      this.reviveAt = this.reviveAt || []
      this.reviveAt.push({ at, slot: p.slot, by: by.slot })
    }
  }

  bleedout(p) {
    p.down = false
    p.alive = false
    p.health = 0
    p.score = Math.max(0, Math.floor(p.score * 0.8))
    p.bleedouts++
    this.emitEv({ t: 'bleedout', slot: p.slot })
    // In WaW you respawn at the start of the next round; approximate that.
    p.respawnRound = this.round + 1
  }

  chatter() {
    if (this.rng() > 0.0025) return
    // An AFK player does not type. (They did in the first version, which quietly reset
    // their idle timer through the referee's `chat` -> touch path and meant the AFK kick
    // never fired — a real bug in the SIMULATOR, but exactly the kind of "activity" the
    // real scoring has to get right.)
    const ps = this.livePlayers().filter((p) => !p.afk && (p.alive || p.down)); if (!ps.length) return
    const p = ps[Math.floor(this.rng() * ps.length)]
    this.emitEv({ t: 'chat', slot: p.slot, text: CHATTER[Math.floor(this.rng() * CHATTER.length)], team: false })
  }

  scripted() {
    if (this.reviveAt?.length) {
      for (let i = this.reviveAt.length - 1; i >= 0; i--) {
        const r = this.reviveAt[i]
        if (this.ms < r.at) continue
        this.reviveAt.splice(i, 1)
        const p = this.players.get(r.slot)
        if (p?.down) {
          p.down = false; p.health = 100; p.alive = true
          // `revives` is credited to the REVIVER, which is what referee.js `ev_revive`
          // does off the same event. Crediting the revived player is the easy mistake.
          const by = this.players.get(r.by); if (by) by.revives++
          this.emitEv({ t: 'revive', slot: r.slot, by: r.by })
        }
      }
    }
    if (this.scheduleEe && this.ms >= this.scheduleEe) {
      this.scheduleEe = null
      const seq = mapScript(this.map, 'easter_egg') || []
      // One step every few seconds, in order, so the ordering guard in the manifest is
      // actually exercised rather than satisfied by a single burst.
      seq.forEach((e, i) => { this.eeQueue = this.eeQueue || []; this.eeQueue.push({ at: this.ms + i * 4000, ev: e }) })
    }
    if (this.eeQueue?.length) {
      for (let i = this.eeQueue.length - 1; i >= 0; i--) {
        if (this.ms < this.eeQueue[i].at) continue
        this.emitEv(this.eeQueue[i].ev)
        this.eeQueue.splice(i, 1)
      }
    }
    if (this.scheduleEnding && this.ms >= this.scheduleEnding) {
      this.scheduleEnding = null
      const seq = mapScript(this.map, 'buyable_ending') || []
      seq.forEach((e, i) => { this.eeQueue = this.eeQueue || []; this.eeQueue.push({ at: this.ms + i * 3000, ev: e }) })
    }
    if (!this.papBuilt && this.powerOn && this.rng() < 0.002) { this.papBuilt = true; this.emitEv({ t: 'notify', ent: 'level', name: 'enw_pap_built' }) }
  }

  snapshot() {
    const players = [...this.players.values()].filter((p) => p.authed).map((p) => ({
      slot: p.slot, pos: p.pos, ang: p.ang, health: Math.max(0, Math.round(p.health)),
      score: p.score, weapon: p.weapon, stance: p.down ? 'down' : p.stance, alive: p.alive && !p.down,
    }))
    const ev = { t: 'snap', players }
    // Zombies at 10 Hz — every other 20 Hz player tick, as the protocol allows.
    if (this.tick % 2 === 0) ev.zombies = this.zombies.map((z) => ({ id: z.id, pos: z.pos, health: Math.round(z.health) }))
    this.emitEv(ev)
  }

  perf() {
    if (this.ms - this.lastPerfMs < 10_000) return
    this.lastPerfMs = this.ms
    const load = this.zombies.length / 24
    this.emitEv({
      t: 'perf',
      frame_ms_p50: round2(8 + load * 6 + this.rng() * 2),
      frame_ms_p99: round2(18 + load * 22 + this.rng() * 8),
      cpu_pct: round2(18 + load * 30 + this.rng() * 5),
    })
  }

  roundTransition() {
    if (this.spawnQueue > 0 || this.zombies.length > 0) return
    if (this.betweenUntil > this.ms) return
    if (!this.betweenUntil || this.betweenUntil <= this.ms) {
      // Respawn anyone who bled out — in WaW you come back at the start of the next round.
      for (const p of this.players.values()) if (p.respawnRound && p.respawnRound <= this.round + 1) {
        p.alive = true; p.down = false; p.health = 100; p.respawnRound = null; p.score = Math.max(p.score, 500)
        this.emitEv({ t: 'player_spawn', slot: p.slot })
      }
      this.emitEv({ t: 'notify', ent: 'level', name: 'between_round_over' })
      if (this.round >= this.maxRound) return this.endGame('round_target')
      this.betweenUntil = this.ms + 9000
      this.pendingRound = this.round + 1
      setTimeoutish(this, () => this.startRound(this.pendingRound), 9000)
    }
  }

  /**
   * GAME OVER, in the shape the referee lane settled on 2026-09-22 (referee.md 10.2/10.3,
   * game-link-v0 `game_over` + `match_end`). Three things, in order, and the order is the
   * contract:
   *
   *   1. THE RESULT - one enriched `game_over` carrying the whole answer, so a host that
   *      loses the link a second later still has it without re-folding the stream.
   *   2. THE REPLAY STOPS - nothing after `game_over` belongs to the match.
   *   3. THE LEASE - `match_end`, AFTER `game_over`, saying only "this process is idle and
   *      the instance can be reclaimed".
   *
   * And then the simulated server does NOTHING, exactly like the real one: it stays up,
   * idle, for ever, until the host sends `end` or kills it. Before tonight this simulator
   * stopped stepping at game over, which is the behaviour `no_save_reload.cpp` removed
   * from the real server - so the host agent's game-over path had never been exercised
   * against a server that survives its own game over.
   */
  endGame(reason) {
    if (this.over) return
    this.over = true
    this.endedMs = this.ms
    const players = [...this.players.values()].map((p) => ({
      slot: p.slot, name: p.name, connected: true,
      // **A `steamid` appears on a row here ONLY when `identity` is `verified`** — the one
      // message a host may post a result from must not carry an account nobody checked
      // (game-link-v0 `game_over`, referee.md §13.2). The name is attendance; the id is a
      // claim on somebody's leaderboard.
      identity: p.identity, identity_reason: p.identityReason,
      ...(p.identity === 'verified' ? { steamid: p.steamid } : {}),
      ...(p.partySlot != null ? { party_slot: p.partySlot } : {}),
      score: p.score, score_total: p.scoreTotal,
      downs: p.downs, revives: p.revives, alive: !!p.alive && !p.down,
    }))
    // A player who left mid-match still gets a row (referee.md 10.2). `this.players`
    // no longer holds them, so the departed are kept in `gone` as they go.
    for (const g of this.gone || []) players.push({ ...g, connected: false, alive: false })
    players.sort((x, y) => x.slot - y.slot)
    const durationMs = Math.round(this.ms - (this.startedMs || 0))
    this.emitEv({
      t: 'game_over',
      round: this.round,
      reason,
      duration_ms: durationMs,
      points_total: players.reduce((n, p) => n + (p.score_total || 0), 0),
      downs_total: players.reduce((n, p) => n + (p.downs || 0), 0),
      players_alive: players.filter((p) => p.alive).length,
      players,
    })
    // A server that reports its result and then says NOTHING about being idle. This is
    // what every dedicated server did before `match_end` existed, and the host must treat
    // it as "I do not know whether this process is alive" — never as "it is gone".
    if (this.noMatchEnd) { this.games++; this.emit('end', reason); return }
    this.emitEv({
      t: 'match_end',
      round: this.round,
      reason,
      duration_ms: durationMs,
      replay_closed: true,       // the GAME's sampler has stopped; the host closes the file
      server_alive: true,        // ...and this process is still here. That is the whole point.
      awaiting: 'end_or_terminate',
    })
    this.games++
    this.emit('end', reason)
  }

  /**
   * The host answered `match_end` with `end`: `map_restart`, reset the per-match state,
   * re-announce `map_loaded`. Clients stay connected through a `map_restart` on this
   * engine, so the roster comes back with it - that is what makes an instance "warm".
   *
   * `endFails` models the one failure the contract names: `reply.ok:false` means the
   * command buffer was unavailable and the instance MUST NOT be reused.
   */
  restart(reason = 'map_restart', matchId = null) {
    if (this.endFails) return false
    const roster = [...this.players.values()].map((p) => ({ slot: p.slot, name: p.name, steamid: p.steamid, token: p.token }))
    this.players.clear()
    this.pendingAuth.clear()
    this.zombies = []
    this.reviveAt = []
    this.gone = []
    this.round = 0
    this.roundKills = 0
    this.roundTotal = 0
    this.spawnQueue = 0
    this.betweenUntil = 0
    this.pendingRound = null
    this.powerOn = false
    this.papBuilt = false
    this.scheduleEe = null
    this.scheduleEnding = null
    this.over = false
    this.phase = 'loading'
    this.startedMs = this.ms
    this.loadedMs = this.ms
    // The referee CLEARS the lease id rather than keep the finished match's — a stale id
    // refuses every legitimate token with `wrong_match`, which is the worse failure
    // (referee.md §13.4). So does this.
    this.matchId = matchId || null
    this.connectedSinceRestart = 0
    this.emitEv({ t: 'log', level: 'info', msg: 'map_restart (' + reason + ')' })
    if (matchId && this.stallRebind && ++this.matchedRestarts === this.stallRebind) {
      this.emitEv({ t: 'log', level: 'warn', msg: `map_restart for ${matchId}: the map never comes back (--stall-rebind)` })
      this.pendingSimRoster = null
      return true
    }
    this.emitEv({ t: 'map_loaded', map: this.map, fs_game: this.fsGame, mode: 'zombies', sv_maxclients: 4 })
    this.emit('restart', { reason, roster, matchId: this.matchId, simRoster: this.pendingSimRoster || null })
    this.pendingSimRoster = null
    return true
  }

  // ---- host -> game commands ------------------------------------------------------
  onCommand(cmd) {
    switch (cmd.t) {
      case 'say': this.emit('say', cmd); this.emitEv({ t: 'log', level: 'info', msg: `[say] ${cmd.from ? `(${cmd.from}) ` : ''}${cmd.text}` }); break
      case 'tell': this.emit('tell', cmd); this.emitEv({ t: 'log', level: 'info', msg: `[tell ${cmd.slot}] ${cmd.text}` }); break
      case 'exec': this.reply(cmd, true, { ran: cmd.cmd }); break
      case 'set': this.dvars = { ...(this.dvars || {}), [cmd.dvar]: cmd.value }; this.reply(cmd, true, { [cmd.dvar]: cmd.value }); break
      case 'pause': this.paused = true; this.emitEv({ t: 'notify', ent: 'level', name: 'enw_paused' }); this.reply(cmd, true); break
      case 'resume': this.paused = false; this.emitEv({ t: 'notify', ent: 'level', name: 'enw_resumed' }); this.reply(cmd, true); break
      case 'kick': this.disconnectPlayer(cmd.slot, cmd.reason || 'kicked'); this.reply(cmd, true); break
      case 'auth': {
        const p = this.pendingAuth.get(cmd.slot)
        this.pendingAuth.delete(cmd.slot)
        if (!p) break
        p.identityReason = cmd.reason || null
        if (cmd.allow) {
          // `token_check_disabled` is what TokenGuard answers when it holds no site key or
          // is not enforcing. That is not a check and must not promote a claim to a
          // verified account (game-link-v0 `auth`, referee.md §13.3).
          if (cmd.reason !== 'token_check_disabled') p.identity = 'verified'
          this.spawnPlayer(p)
        } else {
          p.identity = 'refused'
          // A refused player still gets a row in the result — with no account on it.
          this.disconnectPlayer(cmd.slot, `auth: ${cmd.reason || 'denied'}`)
        }
        break
      }
      // `end` is BOTH "end this game now" and the answer to `match_end`. If the match had
      // not already ended, the result is reported first (so a forced end still leaves a
      // complete record instead of a hole), and then the map restarts. `reply.ok:false`
      // means the command buffer was unavailable and the host must tear the instance down.
      case 'end': {
        const ok = !this.endFails
        // Report the result first — but only if a match had actually STARTED. `end` is
        // also how a warm instance is told its next lease id, and an instance that has
        // never seen a round has no result to report; emitting one would post a game
        // nobody played.
        if (ok && !this.over && (this.round > 0 || (this.realWarm && this.connectedSinceRestart > 0))) this.endGame(cmd.reason || 'host_end')
        this.reply(cmd, ok, undefined, ok ? undefined : 'command buffer unavailable')
        // `sim_roster` is a SIMULATOR-ONLY field and a real DLL ignores it, which the
        // protocol's "unknown fields are ignored by both sides" rule guarantees. It exists
        // because the sim INVENTS its players and so has to be handed the next party's
        // invite tokens; real clients bring their own when they connect, and the real DLL
        // needs nothing but `match`.
        this.pendingSimRoster = Array.isArray(cmd.sim_roster) ? cmd.sim_roster : null
        if (ok) this.restart(cmd.reason || 'host end', cmd.match || null)
        break
      }
      case 'snapshot_state': this.reply(cmd, true, this.restorableState()); break
      case 'restore': {
        // Put a returning player back as they were. In the real DLL this is the builtins
        // the stock scripts already use (score, giveweapon + _upgraded, the perk list and
        // its HUD, setorigin/setplayerangles). Here it is assignment, but the SHAPE — one
        // command, one player, answered — is the contract the DLL has to meet.
        const p = this.players.get(cmd.slot)
        if (!p) { this.reply(cmd, false, null, 'no such slot'); break }
        const st = cmd.state || {}
        if (Number.isFinite(st.score)) p.score = st.score
        if (st.weapon) p.weapon = st.weapon
        if (Array.isArray(st.perks)) p.perks = st.perks
        if (Array.isArray(st.pos)) p.pos = st.pos
        if (Array.isArray(st.ang)) p.ang = st.ang
        p.health = 100
        p.down = false
        p.alive = true
        this.emitEv({ t: 'notify', ent: `player:${p.slot}`, name: 'enw_restored', args: { score: p.score, weapon: p.weapon } })
        this.emitEv({ t: 'points', slot: p.slot, score: p.score, delta: 0, why: 'restore' })
        this.reply(cmd, true, { slot: p.slot, score: p.score, weapon: p.weapon })
        break
      }
      default: this.reply(cmd, false, null, `unknown command ${cmd.t}`)
    }
  }

  reply(cmd, ok, value, error) {
    if (!cmd.id) return
    this.emitEv({ t: 'reply', id: cmd.id, ok, ...(value !== undefined ? { value } : {}), ...(error ? { error } : {}) })
  }

  /** What a crash-recovery restore would need (vault 10 §5). */
  restorableState() {
    return {
      round: this.round,
      players: [...this.players.values()].map((p) => ({
        slot: p.slot, steamid: p.steamid, score: p.score, weapon: p.weapon, weapon_upgraded: p.weapon?.startsWith('raygun') || false,
        perks: p.perks || [], pos: p.pos, ang: p.ang, health: p.health, down: p.down,
      })),
      power_on: this.powerOn, pap_built: this.papBuilt,
      limited_weapons_held: [...this.players.values()].filter((p) => p.weapon === 'wunderwaffe').map((p) => p.slot),
    }
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v }

// Timer in SIM TIME, not wall time — the whole point is that the simulation can run at
// 1× for a demo and at 3000× for a measurement, with identical output.
function setTimeoutish(sim, fn, ms) {
  const at = sim.ms + ms
  const h = () => { if (sim.ms >= at) { sim.off('event', h); fn() } }
  sim.on('event', h)
}
