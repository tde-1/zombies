// The 3D replay viewer's back end: one endpoint that turns a signed `.enwr` into a
// *track* the browser can scrub, and one static mount for exported map geometry.
//
// WHY A SERVER-SIDE TRANSFORM AT ALL. The on-disk format is 60-second zstd chunks of
// NDJSON, and the fields a viewer needs most — health, score, weapon, stance — are
// **omitted when unchanged** (server/components/replay/replay.cpp, and the note in
// docs/kickstart/replay.md §3). Carrying that state forward is stateful from the start
// of the file, so a browser that fetched one chunk by HTTP Range would see players with
// no score until the next time it changed. Until the columnar CBOR format of R9 §6
// exists, the server decodes the whole file once and hands the client a dense, columnar
// track with every hole already filled.
//
// The response is deliberately boring JSON: flat arrays of numbers, one per tick, so the
// viewer can index by tick rather than search by time. It is ~1 MB for a 40-minute solo
// game at 10 Hz, which gzip takes to ~250 KB.
//
// NOT OWNED BY THIS LANE: routes/site.js already serves /api/replays/<id> (the pointer
// and grade) and /download. This file adds only what the viewer needs and never touches
// those.
const express = require('express')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const zlib = require('node:zlib')
const { execFile } = require('node:child_process')
const replays = require('../lib/replays')
const waw = require('../lib/wawRules')

// Exported map geometry (tools/maps). Game-derived, so it is NEVER in git — it lives in
// ZombiesDev and is mounted read-only here. A missing map is a 404, not a fall-through
// to index.html, for the same reason /updates is (see index.js).
const MAPS_DIR = process.env.ZM_MAPS_DIR
  || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'maps')

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180

/** Sampled snapshot state for one slot, carried forward across omitted fields. */
class SlotState {
  constructor() {
    this.pos = [0, 0, 0]
    this.ang = [0, 0]
    this.health = 100
    this.score = 0
    this.alive = true
    this.weapon = ''
    this.stance = 'stand'
    this.seen = false
    this.va = null
  }

  apply(p) {
    this.seen = true
    if (p.pos) this.pos = p.pos
    if (p.ang) this.ang = p.ang
    if (p.health !== undefined) this.health = p.health
    if (p.score !== undefined) { this.score = p.score; this.sawScore = true }
    if (p.alive !== undefined) this.alive = p.alive
    if (p.weapon !== undefined) this.weapon = String(p.weapon)
    if (p.stance !== undefined) this.stance = p.stance
    if (p.cmd_ang !== undefined) this.cmd = p.cmd_ang
    // VIEW PITCH from the usercmd (replay.md §8.11). The usercmd angle is the view BEFORE
    // ps.delta_angles, which the DLL cannot read. The engine sets delta when it sets the
    // view (spawn, teleport, last stand) and the view it sets has pitch 0 on every stock
    // spawn point, so: whenever the entity-yaw-minus-usercmd-yaw offset jumps (or on the
    // first sample after a spawn), the pitch offset is re-zeroed at that moment. [H], stated.
    if (this.cmd && p.ang) {
      const dy = wrap180(p.ang[1] - this.cmd[1])
      if (this.dYaw === undefined || this.respawned || Math.abs(wrap180(dy - this.dYaw)) > 20) {
        this.dYaw = dy
        this.dPitch = -this.cmd[0]
        this.respawned = false
      }
      this.va = [wrap180(this.cmd[0] + this.dPitch)]
    }
  }
}

// Events that are worth a marker on the timeline or a line in the feed. `input` and
// `perf` are dropped: 47k input events is half the file and the viewer shows none of it.
// `kill` is here because the referee emits it now (2026-09-22 DLL builds) and §3 gap 1
// asked for it: a kill that scored no points -- and the first real game's ONE kill is
// exactly that, `{"t":"kill","id":254,"round":1,"how":"entity_gone"}` with no `points`
// beside it -- was invisible to a feed that inferred kills from `points.why`.
const FEED_EVENTS = new Set([
  'round', 'points', 'kill', 'down', 'revive', 'bleedout', 'chat', 'notify', 'referee',
  'player_connect', 'player_spawn', 'player_disconnect', 'game_over', 'auth_decision',
  'explode',
])

// THE GAME'S OWN SCOREBOARD COUNTERS (referee.md §16, bug 7, 2026-09-23). A §16 DLL reads
// kills/downs/revives/headshots out of the player's gclient and sends them as absolute
// values -- on `stats` events and, delta-coded, on snap players. They are the numbers the
// in-game Tab scoreboard shows, so the viewer's Tab scoreboard uses them in preference to
// anything it can infer. Files recorded before §16 have neither and keep the old rules.
const COUNTER_KEYS = ['kills', 'downs', 'revives', 'headshots']

/**
 * Decode a replay into a dense track.
 *
 * @param file     absolute path to the .enwr
 * @param hz       target sample rate; 20 is every snap, 10 is every other one
 */
function buildTrack(file, replayLib, hz = 10) {
  const { header } = replayLib.readHeader(file)
  const stride = Math.max(1, Math.round(20 / hz))
  const tickMs = stride * 50

  // POSITION ACCURACY (replay.md §8.11). The DLL writes the zombie list on every other server
  // frame. Sampling players on the OTHER phase put every zombie 50 ms behind the players it
  // was chasing (a running zombie is ~5 units at that age) and made the list step. So the
  // sampling phase is chosen to land ON the zombie frames: one cheap pre-pass finds the first
  // snap that carries the zombie-frame marker (`zombies_alive`), and every sampled tick after
  // that is a zombie frame. Players are recorded every frame, so any phase suits them.
  let phase = 0
  {
    let k = -1
    for (const e of replayLib.readEvents(file)) {
      if (e.t !== 'snap') continue
      k++
      if (e.zombies_alive !== undefined || Array.isArray(e.zombies)) { phase = k % stride; break }
    }
  }

  const slots = new Map()        // slot -> SlotState
  const names = new Map()        // slot -> { name, steamid }
  const cols = new Map()         // slot -> { pos: [], ang: [], health: [], score: [], alive: [] }
  const zombies = new Map()      // key -> { id, t0, pos: [] }  (see "identity" below)
  const zLast = new Map()        // entnum -> key, so a reused entnum starts a new track
  const rounds = []
  const feed = []
  // slot -> [[ms, kills, downs, revives, headshots], ...], one entry per change.
  const counters = new Map()
  const counterCur = new Map()
  const noteCounters = (slot, ms, src) => {
    if (slot === undefined || slot === null) return
    const cur = counterCur.get(slot) || { kills: 0, downs: 0, revives: 0, headshots: 0 }
    let changed = !counterCur.has(slot)
    for (const k of COUNTER_KEYS) {
      if (src[k] === undefined) continue
      const v = Number(src[k])
      if (Number.isFinite(v) && v !== cur[k]) { cur[k] = v; changed = true }
    }
    if (!COUNTER_KEYS.some((k) => src[k] !== undefined)) return
    counterCur.set(slot, cur)
    if (!changed) return
    if (!counters.has(slot)) counters.set(slot, [])
    counters.get(slot).push([ms || 0, cur.kills, cur.downs, cur.revives, cur.headshots])
  }

  // `snap.zombies_alive` is the number of zombie AI entities ALIVE at that sample -- the
  // DLL's own comment says so (replay.cpp: "MEASURED: live AI entities this sample ... NOT
  // how many are left in the round"). An earlier version of this comment called it the
  // round's remainder and the HUD labelled it "Zombies left"; that was wrong (§8.11). The
  // round's remainder is `zombies_left` below. `kills_round` is the DLL's kill counter,
  // which undercounts on real games (§8.11: its seen[] array stops at entnum 255). Both are delta-coded like every other snap
  // field, so they are carried forward, and both are `null` for every file recorded before
  // they existed -- which is why they are separate arrays with a `has_` flag rather than
  // zeros the HUD could not tell apart from a quiet round.
  const zAlive = []
  const kRound = []
  let zAliveCur = null
  let kRoundCur = null
  let sawCounters = false

  // 2026-09-22 (replay.md §8.4): the DLL writes the zombie list on EVEN server frames,
  // and this reader samples every OTHER snap at 10 Hz. On a real game the two phases
  // can disagree -- on m_0afb449b every zombie list sat on an odd snap index -- and the
  // track came out with ZERO zombies from a file holding 995 zombie lists. So the latest
  // list is carried forward and read on the sampled tick, whatever its phase. `nades`
  // (§8.6) is the same shape and the same rule.
  let zCur = null
  let nCur = null
  const nades = new Map()        // key -> { id, t0, pos: [] }
  const nLast = new Map()
  // §8.5: the end of the game, not the end of the file. The sampler kept writing through
  // the intermission on m_0afb449b (no game_over event), and the tail is the
  // intermission camera -- the player capsule "flies". First of game_over / intermission.
  let endMs = null
  // §8.7: `input` carries `buttons` on change. Bit 0x1 is read as attack [H]; the
  // crosshair and the placeholder viewmodel use it.
  const fireCur = new Map()      // slot -> 0|1
  // §8.11: the whole usercmd button mask, carried per slot (stance, ADS, frag, use -- the IW3
  // layout in lib/wawRules.js BTN), and the press/release edges of the buttons the HUD
  // animates, at full millisecond resolution rather than the 10 Hz tick.
  const btnCur = new Map()       // slot -> mask
  const presses = new Map()      // slot -> { fire: [[down, up|null]], frag: [...], ads: [...] }
  const pressOf = (slot) => {
    if (!presses.has(slot)) presses.set(slot, { fire: [], frag: [], ads: [] })
    return presses.get(slot)
  }
  const edge = (list, was, now, ms) => {
    if (now && !was) list.push([ms, null])
    else if (!now && was && list.length && list[list.length - 1][1] === null) list[list.length - 1][1] = ms
  }
  // Health drops at snap resolution (20 Hz), with the nearest zombie at that moment as the
  // inferred attacker -- the DLL records no damage direction (§8.11 "recorded vs inferred").
  const hits = []
  const lastHealth = new Map()
  // Weapons: the per-tick column holds an index into `weapons`.
  const weaponTable = ['']
  const weaponIdx = new Map([['', 0]])
  const wIndex = (raw) => {
    const key = String(raw || '')
    if (!weaponIdx.has(key)) { weaponIdx.set(key, weaponTable.length); weaponTable.push(key) }
    return weaponIdx.get(key)
  }
  // Zombies-left bookkeeping: identities first seen in the current round.
  const zLeft = []
  const zTotal = []
  let roundForCount = 0
  let spawnedThisRound = 0
  let totalThisRound = null
  let leftSource = null
  const roundTotals = []
  let playersNow = 1

  let snapIndex = -1
  let ticks = 0
  // §8.11: the real time of every sampled tick. Server frames are not exactly 50 ms apart,
  // and `t0 + k * tick_ms` was 674 ms off the snaps' own clock by the end of m_0afb449b --
  // every event (a hit, a down, a weapon change) then landed 0.7 s away from the positions it
  // belongs with. The viewer maps time to tick through this array.
  const tickT = []
  let round = 0
  let lastMs = 0
  let firstSnapMs = null

  const colsFor = (slot) => {
    if (!cols.has(slot)) {
      // A slot that appears late still needs a full-length column, so it is back-filled
      // with the tick count so far. Otherwise tick N of slot 1 is tick N-k of slot 0 and
      // every player after the first is out of sync with the scrubber.
      const c = { pos: [], ang: [], health: [], score: [], alive: [], fire: [], btn: [], wpn: [], pitch: [] }
      for (let i = 0; i < ticks; i++) {
        c.pos.push(0, 0, 0); c.ang.push(0, 0)
        c.health.push(0); c.score.push(0); c.alive.push(0); c.fire.push(0)
        c.btn.push(0); c.wpn.push(0); c.pitch.push(null)
      }
      cols.set(slot, c)
    }
    return cols.get(slot)
  }

  for (const e of replayLib.readEvents(file)) {
    if (e.ms !== undefined && e.ms > lastMs) lastMs = e.ms

    if (e.t === 'player_connect') names.set(e.slot, { name: e.name, steamid: e.steamid })
    if (e.t === 'player_spawn' && slots.has(e.slot)) slots.get(e.slot).respawned = true
    if (e.t === 'round') { round = e.n; rounds.push({ ms: e.ms, n: e.n }) }
    if (endMs === null && (e.t === 'game_over' || (e.t === 'notify' && e.name === 'intermission'))) endMs = e.ms
    if (e.t === 'input' && e.slot !== undefined) {
      const was = btnCur.get(e.slot) || 0
      const now = e.buttons | 0
      fireCur.set(e.slot, (now & waw.BTN.ATTACK) ? 1 : 0)
      btnCur.set(e.slot, now)
      const pr = pressOf(e.slot)
      edge(pr.fire, was & waw.BTN.ATTACK, now & waw.BTN.ATTACK, e.ms)
      edge(pr.frag, was & waw.BTN.FRAG, now & waw.BTN.FRAG, e.ms)
      edge(pr.ads, was & waw.BTN.ADS, now & waw.BTN.ADS, e.ms)
    }

    if (FEED_EVENTS.has(e.t)) {
      const f = { ms: e.ms || 0, t: e.t }
      for (const k of ['slot', 'by', 'n', 'score', 'delta', 'why', 'text', 'name', 'label', 'id', 'kind', 'reason', 'how', 'round']) {
        if (e[k] !== undefined) f[k] = e[k]
      }
      feed.push(f)
    }

    if (e.t === 'stats') noteCounters(e.slot, e.ms, e)
    if (e.t !== 'snap') continue
    snapIndex++
    // Every snap updates the carried-forward state -- dropping one would lose a health
    // change forever, because the next snap omits the field precisely BECAUSE it was
    // already sent. Only the *sampling* is strided, never the state machine.
    for (const p of e.players || []) {
      if (!slots.has(p.slot)) slots.set(p.slot, new SlotState())
      const st = slots.get(p.slot)
      st.apply(p)
      noteCounters(p.slot, e.ms, p)
      const was = lastHealth.get(p.slot)
      if (st.alive && was !== undefined && st.health < was && (endMs === null || e.ms < endMs)) {
        let src = null
        let best = 140 * 140   // a zombie swipe reaches ~64; 140 leaves room for the 10 Hz list's age
        for (const z of zCur || []) {
          const dx = z.pos[0] - st.pos[0], dy = z.pos[1] - st.pos[1]
          const d2 = dx * dx + dy * dy
          if (d2 < best) { best = d2; src = [r1(z.pos[0]), r1(z.pos[1])] }
        }
        hits.push({ slot: p.slot, ms: e.ms, from: was, to: st.health, src })
      }
      lastHealth.set(p.slot, st.health)
    }
    if (Array.isArray(e.players) && e.players.length) playersNow = e.players.length
    if (e.zombies_alive !== undefined) { zAliveCur = e.zombies_alive; sawCounters = true }
    if (e.kills_round !== undefined) { kRoundCur = e.kills_round; sawCounters = true }
    if (Array.isArray(e.zombies)) zCur = e.zombies
    else if (e.zombies_alive === 0) zCur = []   // a zombie frame with none out
    if (Array.isArray(e.nades)) nCur = e.nades
    else if (e.zombies_alive !== undefined) nCur = []   // a 10 Hz frame with no nade list
    if ((((snapIndex - phase) % stride) + stride) % stride !== 0) continue
    if (firstSnapMs === null) firstSnapMs = e.ms

    for (const [slot, s] of slots) {
      const c = colsFor(slot)
      c.pos.push(r1(s.pos[0]), r1(s.pos[1]), r1(s.pos[2]))
      c.ang.push(r1(s.ang[0]), r1(s.ang[1]))
      c.health.push(s.health)
      c.score.push(s.score)
      c.alive.push(s.alive ? 1 : 0)
      c.fire.push(fireCur.get(slot) || 0)
      c.btn.push(btnCur.get(slot) || 0)
      c.wpn.push(wIndex(s.weapon))
      c.pitch.push(s.va ? r1(s.va[0]) : null)
    }
    zAlive.push(zAliveCur)
    kRound.push(kRoundCur)
    tickT.push(e.ms)
    ticks++

    // Zombies. `zombies` absent and `zombies: []` mean the same thing (the sampler only
    // emits the list on even frames), so an absent list is NOT "they all died".
    const track = (list, all, last, withYaw) => {
      const live = new Set()
      for (const z of list) {
        live.add(z.id)
        let key = zLast.get(z.id)
        if (key === undefined) { key = `${z.id}:${e.ms}`; last.set(z.id, key) }
        if (!all.has(key)) all.set(key, withYaw ? { id: z.id, t0: ticks - 1, pos: [], yaw: [] } : { id: z.id, t0: ticks - 1, pos: [] })
        const zt = all.get(key)
        // Pad if this zombie was missing for a few ticks but kept its entnum.
        while (zt.pos.length / 3 < (ticks - 1 - zt.t0)) {
          const n = zt.pos.length
          zt.pos.push(zt.pos[n - 3] || 0, zt.pos[n - 2] || 0, zt.pos[n - 1] || 0)
          if (withYaw) zt.yaw.push(zt.yaw.length ? zt.yaw[zt.yaw.length - 1] : 0)
        }
        zt.pos.push(r1(z.pos[0]), r1(z.pos[1]), r1(z.pos[2]))
        // Yaw is recorded from the 2026-09-22 (late) DLL on; older files have none and
        // the viewer faces the zombie along its motion instead.
        if (withYaw) zt.yaw.push(z.yaw === undefined ? null : r1(z.yaw))
      }
      // An entnum that stopped appearing is retired, so if the engine hands the same
      // number to a new zombie it starts a fresh track instead of teleporting across
      // the map (replay.cpp: identity is (id, first-seen), never id alone).
      for (const id of [...last.keys()]) if (!live.has(id)) last.delete(id)
    }
    const before = zombies.size
    if (zCur) track(zCur, zombies, zLast, true)
    if (nCur) track(nCur, nades, nLast, false)

    // Zombies left in the round (§8.11): the stock total for (map, round, players) minus the
    // zombies this round that have come and gone. `spawned - alive` is the dead, so
    // left = total - spawned + alive. Recorded inputs: round, the zombie list; the total is
    // the game's own formula (lib/wawRules.js).
    const rNow = e.round !== undefined ? e.round : round
    if (rNow !== roundForCount && rNow > 0) {
      roundForCount = rNow
      spawnedThisRound = 0
      const t = waw.roundTotal(header.map, rNow, playersNow)
      totalThisRound = t.total
      leftSource = t.source
      roundTotals.push({ n: rNow, total: t.total, players: playersNow })
    }
    spawnedThisRound += zombies.size - before
    const aliveNow = zCur ? zCur.length : 0
    zTotal.push(totalThisRound)
    zLeft.push(totalThisRound === null ? null : Math.max(0, totalThisRound - spawnedThisRound + aliveNow))
  }

  const players = []
  for (const [slot, c] of [...cols].sort((a, b) => a[0] - b[0])) {
    const meta = names.get(slot) || {}
    players.push({
      slot,
      name: meta.name || `Slot ${slot}`,
      steamid: meta.steamid || null,
      pos: c.pos, ang: c.ang, health: c.health, score: c.score, alive: c.alive, fire: c.fire,
      btn: c.btn, wpn: c.wpn,
      // View pitch is NOT in any file recorded so far: `ang[0]` is the player ENTITY's pitch,
      // which the engine keeps at 0 (§8.11). `pitch` is filled from the DLL's view angles
      // (`va`, 2026-09-22 late build) when the file has them; otherwise it is null.
      pitch: c.pitch.some((v) => v !== null) ? c.pitch : null,
      presses: presses.get(slot) || { fire: [], frag: [], ads: [] },
      // §8.12: whether `score` was ever recorded for this player. The real DLL does not
      // record it yet (player_int("score") is unbound), and a column of zeros must not be
      // shown as points.
      has_score: !!(slots.get(slot) && slots.get(slot).sawScore),
      // §16: [[ms, kills, downs, revives, headshots], ...] from the game's own counters, or
      // null for a file recorded before the DLL could read them.
      counters: counters.get(slot) || null,
    })
  }

  return {
    match_id: header.match_id,
    map: header.map,
    map_name: header.map_name || header.map,
    mode: header.mode,
    started_at: header.started_at,
    box: header.box,
    dll_build: header.dll_build,
    hz: 20 / stride,
    tick_ms: tickMs,
    t0_ms: firstSnapMs || 0,
    ticks,
    duration_ms: lastMs,
    // Where the viewer's scrubber stops: game over or the intermission, whichever came
    // first; null when the file has neither (then it is the last snap).
    end_ms: endMs,
    max_round: rounds.length ? rounds[rounds.length - 1].n : round,
    // Whether this map has geometry on this machine, and which version of it. The viewer
    // needs both before it fetches anything: see mapExportFor.
    map_export: mapExportFor(header.map),
    // Absent on every file older than the counters, and the viewer must say "Zombies up"
    // off its own zombie tracks in that case rather than draw a confident 0.
    has_counters: sawCounters,
    zombies_alive: sawCounters ? zAlive : null,
    kills_round: sawCounters ? kRound : null,
    players,
    // Zombies with a single sample are spawn flicker and cost a draw call each.
    zombies: [...zombies.values()].filter((z) => z.pos.length >= 6)
      .map((z) => (z.yaw.every((v) => v === null) ? { id: z.id, t0: z.t0, pos: z.pos } : z)),
    // A thrown grenade is short-lived; one sample is still a grenade, so no filter.
    nades: [...nades.values()],
    rounds,
    events: feed,
    // §8.11 additions.
    tick_t: tickT,
    phase_note: `sampled on zombie frames (snap phase ${phase} of ${stride})`,
    weapons: weaponTable.map((raw) => ({ raw, ...waw.weaponName(header.map, raw) })),
    zombies_left: zLeft,
    zombies_total: zTotal,
    zombies_left_source: leftSource,
    round_totals: roundTotals,
    hits,
  }
}

const r1 = (v) => Math.round(Number(v) * 10) / 10

/**
 * What geometry exists for a bsp, answered by the server rather than discovered by the
 * browser through a failed 38 MB fetch.
 *
 * The viewer used to find out by asking for the `.glb` and catching the error, which made
 * "this map has never been exported" indistinguishable from "the network died halfway"
 * and drew a red error string over a black page either way. Telling it up front is one
 * `statSync` on a path it was going to build anyway, and it is what lets the page say
 * *no world model yet* and still play the game over a floor.
 *
 * `version` is the cache key (§8.12): `built_at` from the sidecar plus the .glb's own mtime
 * and size, so even an export whose sidecar did not change (or a hand-copied .glb) is a new
 * URL. The .glb itself is `no-cache` with an ETag; the version makes the URL change too.
 */
/** The one string that changes whenever the served geometry does. */
function mapVersion(ex) {
  if (!ex || !ex.glb) return null
  return `${ex.built_at || 'na'}.${ex.mtime_ms || 0}.${ex.bytes || 0}`
}

function mapExportFor(bsp) {
  const out = { bsp: bsp || null, glb: false, meta: false, built_at: null, bytes: 0, world_shell: null }
  if (!bsp || !/^[A-Za-z0-9._-]+$/.test(bsp)) return out
  const dir = path.join(MAPS_DIR, bsp)
  try {
    const st = fs.statSync(path.join(dir, `${bsp}.glb`))
    out.glb = st.isFile(); out.bytes = st.size; out.mtime_ms = Math.round(st.mtimeMs)
  } catch { /* not exported */ }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${bsp}.meta.json`), 'utf8'))
    out.meta = true
    out.built_at = meta.built_at || null
    out.world_shell = !!meta.world_shell
    out.world_obj_scale = meta.world_obj_scale || null
  } catch { /* geometry without a sidecar still draws */ }
  out.version = mapVersion(out)
  return out
}

/** Answer with a pre-gzipped body, or inflate it for the rare client that says it cannot. */
function send(req, res, gz) {
  res.type('application/json')
  // Revalidate every time: the track names the map export's version (§8.12).
  res.setHeader('Cache-Control', 'no-cache')
  if (/gzip/i.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip')
    return res.end(gz)
  }
  res.end(zlib.gunzipSync(gz))
}

/**
 * The file for a match, preferring the database row and falling back to the replay
 * directory's own naming.
 *
 * The fallback matters more than it looks: the host agent writes `<match>.enwr` the
 * moment a game starts, and the `replays` row is only inserted when the site ingests
 * the *result*. A game that ended on a box the site has not heard from yet -- or, on
 * this dev box, every replay the simulator has ever written -- has a perfectly good
 * signed file and no row. Watching one should not require the result to have landed.
 *
 * `matchId` is never trusted as a path. It must match the host agent's own id shape,
 * and the resolved path must still be inside REPLAY_DIR.
 */
function fileFor(matchId) {
  // `replays.fileFor` answers with a DESCRIPTOR -- { path, name, size, row } -- not a
  // path, and this took the object straight through to `readHeader(file)`, which threw
  // `The "path" argument must be of type string ... Received an instance of Object` and
  // came back as a 422 "unsigned or truncated replay". It never showed up in testing
  // because the only replays on this box were the simulator's, which have NO `replays`
  // row, so every test went down the fallback branch below -- which does return a string.
  // The first replay that ever had a row was the first real game, and the viewer had
  // never once been down this path. Found 2026-09-23 against game 2 (`m_5de3842b`).
  const viaDb = replays.fileFor(matchId)
  if (viaDb) return viaDb.path
  const id = String(matchId)
  if (!/^[ml]_[0-9a-f]{8,16}$/i.test(id)) return null
  const p = path.join(replays.REPLAY_DIR, `${id}.enwr`)
  const rel = path.relative(replays.REPLAY_DIR, p)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return fs.existsSync(p) ? p : null
}

// ---- pulling the bytes off the box that recorded them --------------------------------
//
// THE PROBLEM THIS SOLVES, and it is the one that stopped the viewer being usable for a
// real game. A box posts a *pointer* on `/api/gs/result` — `file` is an absolute path on
// ITS filesystem — and it never posts the bytes. On the dev box that was invisible,
// because the box and the site were the same machine. The Hetzner box is not: game 2's
// replay row says `/home/waw/zdev-host/replays/m_5de3842b.enwr`, which does not exist on
// B's PC, so `/api/replay/m_5de3842b/track` answered 404 for every real game ever played.
//
// The right long-term fix is object storage (lib/replays.js's `object_key` seam) or the
// host agent POSTing the file. Both are other lanes'. What this does instead is the
// smallest thing that makes a real game watchable tonight: when the file is missing
// locally, `scp` it once from the box over the ssh alias that is already configured for
// it, into REPLAY_DIR, where every other part of the site already looks. After the first
// watch it is a local file like any other.
//
// What is NOT trusted: the box's path string. Only the BASENAME is used, it must be
// exactly `<matchId>.enwr`, and the destination is resolved back inside REPLAY_DIR. The
// remote directory comes from the row's own dirname but is required to be a plain
// absolute POSIX path with no shell metacharacters, and `scp` is spawned with execFile,
// so there is no shell to inject into.
const PULL_ENABLED = process.env.ZM_REPLAY_PULL !== 'off'
const PULL_TIMEOUT_MS = Number(process.env.ZM_REPLAY_PULL_TIMEOUT_MS || 60_000)
const inflight = new Map()      // matchId -> Promise<string|null>
const failedAt = new Map()      // matchId -> ms, so a dead box is not dialled per request
const FAIL_BACKOFF_MS = 60_000

/** The ssh host alias for a box name. Defaults to the box name itself, which is how
 *  `zombies-dev` is already spelled in B's `~/.ssh/config`. */
function sshHostFor(box) {
  if (!box) return null
  try {
    const map = JSON.parse(process.env.ZM_REPLAY_PULL_HOSTS || '{}')
    if (map && map[box]) return String(map[box])
  } catch { /* a malformed map is not a reason to refuse the default */ }
  if (process.env.ZM_REPLAY_PULL_HOST) return String(process.env.ZM_REPLAY_PULL_HOST)
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(box) ? box : null
}

function pullFromBox(matchId) {
  if (!PULL_ENABLED) return Promise.resolve(null)
  const id = String(matchId)
  if (!/^m_[0-9a-f]{8,16}$/i.test(id)) return Promise.resolve(null)   // local games are already local
  if (inflight.has(id)) return inflight.get(id)
  const failed = failedAt.get(id)
  if (failed && Date.now() - failed < FAIL_BACKOFF_MS) return Promise.resolve(null)

  const row = replays.rowFor(id)
  const host = sshHostFor(row && row.box)
  if (!row || !row.file || !host) return Promise.resolve(null)

  // The box's own path, split into a directory we re-use and a basename we do not.
  const remote = String(row.file).replace(/\\/g, '/')
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(remote)) return Promise.resolve(null)
  const dir = remote.slice(0, remote.lastIndexOf('/'))
  if (path.posix.basename(remote) !== `${id}.enwr`) return Promise.resolve(null)

  const dest = path.join(replays.REPLAY_DIR, `${id}.enwr`)
  const rel = path.relative(replays.REPLAY_DIR, dest)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return Promise.resolve(null)

  // Written to a temp name and renamed, so a half-copied file is never readable as a
  // replay — `readEvents` on a truncated container fails a long way from the cause.
  const tmp = path.join(os.tmpdir(), `zm-pull-${id}-${process.pid}.part`)
  const p = new Promise((resolve) => {
    fs.mkdirSync(replays.REPLAY_DIR, { recursive: true })
    execFile('scp', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
      `${host}:${dir}/${id}.enwr`, tmp,
    ], { timeout: PULL_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (err) {
        console.warn(`[replay] could not pull ${id} from ${host}: ${err.message.trim()}`)
        try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
        failedAt.set(id, Date.now())
        return resolve(null)
      }
      try {
        fs.renameSync(tmp, dest)
      } catch {
        // Different volumes: copy then remove.
        try { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp) } catch (e2) {
          console.warn(`[replay] pulled ${id} but could not place it: ${e2.message}`)
          failedAt.set(id, Date.now())
          return resolve(null)
        }
      }
      console.log(`[replay] pulled ${id}.enwr from ${host} (${fs.statSync(dest).size} B)`)
      failedAt.delete(id)
      resolve(dest)
    })
  }).finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

function router() {
  const r = express.Router()

  // The decoded track. Cached in memory by (match, hz): decoding a 40-minute game is
  // ~400 ms and the file never changes once it is signed.
  const cache = new Map()

  r.get('/:matchId/track', async (req, res) => {
    const hz = Math.min(20, Math.max(2, Number(req.query.hz) || 10))
    const key = `${req.params.matchId}:${hz}`
    // §8.12: the cached track carries `map_export.built_at`, which is the viewer's cache key
    // for the 38 MB .glb. A re-export while the site runs used to leave the OLD built_at in
    // this cache until a restart, so browsers kept asking for (and getting from their own
    // cache) the old geometry under the old URL. A hit is only a hit if the export is still
    // the one the track was built against.
    const hit = cache.get(key)
    if (hit && mapVersion(mapExportFor(hit.map)) === hit.built) return send(req, res, hit.body)

    let file = fileFor(req.params.matchId)
    // Not here yet? It may still be on the box that recorded it. One scp, then the
    // normal path — including the REPLAY_DIR containment check — decides.
    if (!file) {
      await pullFromBox(req.params.matchId)
      file = fileFor(req.params.matchId)
    }
    if (!file) return res.status(404).json({ error: 'no replay file for that match on this machine' })

    let lib
    try {
      const url = require('node:url').pathToFileURL(
        path.resolve(__dirname, '..', '..', '..', 'infra', 'host-agent', 'lib', 'replay.js'),
      ).href
      lib = await import(url)
    } catch (e) {
      return res.status(503).json({ error: `the replay reader is not available (${e.message})` })
    }

    try {
      const track = buildTrack(file, lib, hz)
      // Gzipped here rather than left to a proxy in front. A track is flat arrays of
      // one-decimal numbers, which is about the most compressible JSON there is --
      // a 79-minute solo game is 4.4 MB raw and well under a megabyte gzipped -- and
      // the Express app has no compression middleware, so without this the browser
      // downloads all of it. Compressed once and cached with the track: the file is
      // immutable the moment it is signed.
      const body = zlib.gzipSync(Buffer.from(JSON.stringify(track)), { level: 6 })
      if (cache.size > 8) cache.clear()
      cache.set(key, { body, map: track.map, built: mapVersion(track.map_export) })
      send(req, res, body)
    } catch (e) {
      // An unsigned or truncated replay has no footer, and readEvents refuses it. That
      // is the right answer -- it is exactly the check the download endpoint makes -- so
      // it is reported as a 422 rather than dressed up as an empty track.
      res.status(422).json({ error: String(e.message || e) })
    }
  })

  return r
}

/**
 * Mounted by index.js. Exported separately so the static mount stays out of the router.
 *
 * CACHING. A `.glb` is 38 MB and the URL is stable, so a one-hour cache (what this was)
 * meant a browser re-downloaded the whole map on the second visit of the afternoon. It is
 * a year now, and the re-export problem §5 warned about is solved by the viewer asking
 * for `?v=<built_at>` — a query string is part of the cache key, so a new export is a new
 * URL and an old one is never served stale. The `.meta.json` is small and is the thing
 * that CARRIES `built_at`, so it is the one file that must revalidate: `no-cache` on it,
 * a year on everything else.
 *
 * RANGES. `express.static` answers `Range` with 206 by itself; the viewer does not use
 * ranges, but a browser that resumes an interrupted 38 MB download does, and so does
 * anything that ever proxies this. Nothing here disables it.
 */
function mapsStatic() {
  return [MAPS_DIR, express.static(MAPS_DIR, {
    index: false,
    // Fall through to index.js's plain-text 404 for a map nobody has exported, rather
    // than to express's default HTML error page. It must never fall through to the
    // React app — a loader handed index.html to parse as a glb fails a long way from
    // the cause — and index.js's own `/mapdata` catch-all is what guarantees that.
    fallthrough: true,
    setHeaders(res, filePath) {
      // §8.12: `no-cache` on everything. The .glb URL is versioned (`?v=<built_at>`), and
      // express.static sends an ETag and Last-Modified, so an unchanged map is a 304 -- one
      // round trip, no bytes. `immutable` for a year saved that round trip and cost a stale
      // map for as long as anything anywhere named the old version.
      res.setHeader('Cache-Control', 'no-cache')
    },
  })]
}

/** Which maps have an export, for the viewer and for anyone asking what is served. */
function listMaps() {
  try {
    return fs.readdirSync(MAPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => {
        const glb = path.join(MAPS_DIR, d.name, `${d.name}.glb`)
        if (!fs.existsSync(glb)) return null
        let meta = null
        try { meta = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, d.name, `${d.name}.meta.json`), 'utf8')) } catch { /* geometry without a sidecar still draws */ }
        return {
          bsp: d.name,
          bytes: fs.statSync(glb).size,
          built_at: (meta && meta.built_at) || null,
          world_shell: meta ? !!meta.world_shell : null,
        }
      })
      .filter(Boolean)
  } catch { return [] }
}

module.exports = { router, mapsStatic, listMaps, MAPS_DIR, buildTrack, mapExportFor, mapVersion }
