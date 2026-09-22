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
const zlib = require('node:zlib')
const replays = require('../lib/replays')

// Exported map geometry (tools/maps). Game-derived, so it is NEVER in git — it lives in
// ZombiesDev and is mounted read-only here. A missing map is a 404, not a fall-through
// to index.html, for the same reason /updates is (see index.js).
const MAPS_DIR = process.env.ZM_MAPS_DIR
  || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'maps')

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
  }

  apply(p) {
    this.seen = true
    if (p.pos) this.pos = p.pos
    if (p.ang) this.ang = p.ang
    if (p.health !== undefined) this.health = p.health
    if (p.score !== undefined) this.score = p.score
    if (p.alive !== undefined) this.alive = p.alive
    if (p.weapon !== undefined) this.weapon = String(p.weapon)
    if (p.stance !== undefined) this.stance = p.stance
  }
}

// Events that are worth a marker on the timeline or a line in the feed. `input` and
// `perf` are dropped: 47k input events is half the file and the viewer shows none of it.
const FEED_EVENTS = new Set([
  'round', 'points', 'down', 'revive', 'bleedout', 'chat', 'notify', 'referee',
  'player_connect', 'player_spawn', 'player_disconnect', 'game_over', 'auth_decision',
])

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

  const slots = new Map()        // slot -> SlotState
  const names = new Map()        // slot -> { name, steamid }
  const cols = new Map()         // slot -> { pos: [], ang: [], health: [], score: [], alive: [] }
  const zombies = new Map()      // key -> { id, t0, pos: [] }  (see "identity" below)
  const zLast = new Map()        // entnum -> key, so a reused entnum starts a new track
  const rounds = []
  const feed = []

  let snapIndex = -1
  let ticks = 0
  let round = 0
  let lastMs = 0
  let firstSnapMs = null

  const colsFor = (slot) => {
    if (!cols.has(slot)) {
      // A slot that appears late still needs a full-length column, so it is back-filled
      // with the tick count so far. Otherwise tick N of slot 1 is tick N-k of slot 0 and
      // every player after the first is out of sync with the scrubber.
      const c = { pos: [], ang: [], health: [], score: [], alive: [] }
      for (let i = 0; i < ticks; i++) {
        c.pos.push(0, 0, 0); c.ang.push(0, 0)
        c.health.push(0); c.score.push(0); c.alive.push(0)
      }
      cols.set(slot, c)
    }
    return cols.get(slot)
  }

  for (const e of replayLib.readEvents(file)) {
    if (e.ms !== undefined && e.ms > lastMs) lastMs = e.ms

    if (e.t === 'player_connect') names.set(e.slot, { name: e.name, steamid: e.steamid })
    if (e.t === 'round') { round = e.n; rounds.push({ ms: e.ms, n: e.n }) }

    if (FEED_EVENTS.has(e.t)) {
      const f = { ms: e.ms || 0, t: e.t }
      for (const k of ['slot', 'n', 'score', 'delta', 'why', 'text', 'name', 'label', 'id', 'kind', 'reason']) {
        if (e[k] !== undefined) f[k] = e[k]
      }
      feed.push(f)
    }

    if (e.t !== 'snap') continue
    snapIndex++
    // Every snap updates the carried-forward state -- dropping one would lose a health
    // change forever, because the next snap omits the field precisely BECAUSE it was
    // already sent. Only the *sampling* is strided, never the state machine.
    for (const p of e.players || []) {
      if (!slots.has(p.slot)) slots.set(p.slot, new SlotState())
      slots.get(p.slot).apply(p)
    }
    if (snapIndex % stride !== 0) continue
    if (firstSnapMs === null) firstSnapMs = e.ms

    for (const [slot, s] of slots) {
      const c = colsFor(slot)
      c.pos.push(r1(s.pos[0]), r1(s.pos[1]), r1(s.pos[2]))
      c.ang.push(r1(s.ang[0]), r1(s.ang[1]))
      c.health.push(s.health)
      c.score.push(s.score)
      c.alive.push(s.alive ? 1 : 0)
    }
    ticks++

    // Zombies. `zombies` absent and `zombies: []` mean the same thing (the sampler only
    // emits the list on even frames), so an absent list is NOT "they all died".
    if (Array.isArray(e.zombies)) {
      const live = new Set()
      for (const z of e.zombies) {
        live.add(z.id)
        let key = zLast.get(z.id)
        if (key === undefined) { key = `${z.id}:${e.ms}`; zLast.set(z.id, key) }
        if (!zombies.has(key)) zombies.set(key, { id: z.id, t0: ticks - 1, pos: [] })
        const zt = zombies.get(key)
        // Pad if this zombie was missing for a few ticks but kept its entnum.
        while (zt.pos.length / 3 < (ticks - 1 - zt.t0)) {
          const n = zt.pos.length
          zt.pos.push(zt.pos[n - 3] || 0, zt.pos[n - 2] || 0, zt.pos[n - 1] || 0)
        }
        zt.pos.push(r1(z.pos[0]), r1(z.pos[1]), r1(z.pos[2]))
      }
      // An entnum that stopped appearing is retired, so if the engine hands the same
      // number to a new zombie it starts a fresh track instead of teleporting across
      // the map (replay.cpp: identity is (id, first-seen), never id alone).
      for (const id of [...zLast.keys()]) if (!live.has(id)) zLast.delete(id)
    }
  }

  const players = []
  for (const [slot, c] of [...cols].sort((a, b) => a[0] - b[0])) {
    const meta = names.get(slot) || {}
    players.push({
      slot,
      name: meta.name || `Slot ${slot}`,
      steamid: meta.steamid || null,
      pos: c.pos, ang: c.ang, health: c.health, score: c.score, alive: c.alive,
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
    max_round: rounds.length ? rounds[rounds.length - 1].n : round,
    players,
    // Zombies with a single sample are spawn flicker and cost a draw call each.
    zombies: [...zombies.values()].filter((z) => z.pos.length >= 6),
    rounds,
    events: feed,
  }
}

const r1 = (v) => Math.round(Number(v) * 10) / 10

/** Answer with a pre-gzipped body, or inflate it for the rare client that says it cannot. */
function send(req, res, gz) {
  res.type('application/json')
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
  const viaDb = replays.fileFor(matchId)
  if (viaDb) return viaDb
  const id = String(matchId)
  if (!/^[ml]_[0-9a-f]{8,16}$/i.test(id)) return null
  const p = path.join(replays.REPLAY_DIR, `${id}.enwr`)
  const rel = path.relative(replays.REPLAY_DIR, p)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return fs.existsSync(p) ? p : null
}

function router() {
  const r = express.Router()

  // The decoded track. Cached in memory by (match, hz): decoding a 40-minute game is
  // ~400 ms and the file never changes once it is signed.
  const cache = new Map()

  r.get('/:matchId/track', async (req, res) => {
    const hz = Math.min(20, Math.max(2, Number(req.query.hz) || 10))
    const key = `${req.params.matchId}:${hz}`
    if (cache.has(key)) return send(req, res, cache.get(key))

    const file = fileFor(req.params.matchId)
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
      cache.set(key, body)
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

/** Mounted by index.js. Exported separately so the static mount stays out of the router. */
function mapsStatic() {
  return [MAPS_DIR, express.static(MAPS_DIR, { index: false, maxAge: '1h', fallthrough: false })]
}

module.exports = { router, mapsStatic, MAPS_DIR, buildTrack }
