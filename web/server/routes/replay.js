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
// `kill` is here because the referee emits it now (2026-09-22 DLL builds) and §3 gap 1
// asked for it: a kill that scored no points -- and the first real game's ONE kill is
// exactly that, `{"t":"kill","id":254,"round":1,"how":"entity_gone"}` with no `points`
// beside it -- was invisible to a feed that inferred kills from `points.why`.
const FEED_EVENTS = new Set([
  'round', 'points', 'kill', 'down', 'revive', 'bleedout', 'chat', 'notify', 'referee',
  'player_connect', 'player_spawn', 'player_disconnect', 'game_over', 'auth_decision',
  'explode',
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

  // §3 gap 2, closed by the referee: `snap.zombies_alive` is the number the ROUND has
  // left to send, which is not `snap.zombies.length` (the engine only ever has 24-31 out
  // at once). `kills_round` is its other half. Both are delta-coded like every other snap
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
      const c = { pos: [], ang: [], health: [], score: [], alive: [], fire: [] }
      for (let i = 0; i < ticks; i++) {
        c.pos.push(0, 0, 0); c.ang.push(0, 0)
        c.health.push(0); c.score.push(0); c.alive.push(0); c.fire.push(0)
      }
      cols.set(slot, c)
    }
    return cols.get(slot)
  }

  for (const e of replayLib.readEvents(file)) {
    if (e.ms !== undefined && e.ms > lastMs) lastMs = e.ms

    if (e.t === 'player_connect') names.set(e.slot, { name: e.name, steamid: e.steamid })
    if (e.t === 'round') { round = e.n; rounds.push({ ms: e.ms, n: e.n }) }
    if (endMs === null && (e.t === 'game_over' || (e.t === 'notify' && e.name === 'intermission'))) endMs = e.ms
    if (e.t === 'input' && e.slot !== undefined) fireCur.set(e.slot, (e.buttons & 1) ? 1 : 0)

    if (FEED_EVENTS.has(e.t)) {
      const f = { ms: e.ms || 0, t: e.t }
      for (const k of ['slot', 'n', 'score', 'delta', 'why', 'text', 'name', 'label', 'id', 'kind', 'reason', 'how', 'round']) {
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
    if (e.zombies_alive !== undefined) { zAliveCur = e.zombies_alive; sawCounters = true }
    if (e.kills_round !== undefined) { kRoundCur = e.kills_round; sawCounters = true }
    if (Array.isArray(e.zombies)) zCur = e.zombies
    else if (e.zombies_alive === 0) zCur = []   // a zombie frame with none out
    if (Array.isArray(e.nades)) nCur = e.nades
    else if (e.zombies_alive !== undefined) nCur = []   // a 10 Hz frame with no nade list
    if (snapIndex % stride !== 0) continue
    if (firstSnapMs === null) firstSnapMs = e.ms

    for (const [slot, s] of slots) {
      const c = colsFor(slot)
      c.pos.push(r1(s.pos[0]), r1(s.pos[1]), r1(s.pos[2]))
      c.ang.push(r1(s.ang[0]), r1(s.ang[1]))
      c.health.push(s.health)
      c.score.push(s.score)
      c.alive.push(s.alive ? 1 : 0)
      c.fire.push(fireCur.get(slot) || 0)
    }
    zAlive.push(zAliveCur)
    kRound.push(kRoundCur)
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
    if (zCur) track(zCur, zombies, zLast, true)
    if (nCur) track(nCur, nades, nLast, false)
  }

  const players = []
  for (const [slot, c] of [...cols].sort((a, b) => a[0] - b[0])) {
    const meta = names.get(slot) || {}
    players.push({
      slot,
      name: meta.name || `Slot ${slot}`,
      steamid: meta.steamid || null,
      pos: c.pos, ang: c.ang, health: c.health, score: c.score, alive: c.alive, fire: c.fire,
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
 * `built_at` is the cache key: the `.glb` is served `immutable` for a year, so a re-export
 * has to change the URL, and the sidecar is the only thing that knows it changed.
 */
function mapExportFor(bsp) {
  const out = { bsp: bsp || null, glb: false, meta: false, built_at: null, bytes: 0, world_shell: null }
  if (!bsp || !/^[A-Za-z0-9._-]+$/.test(bsp)) return out
  const dir = path.join(MAPS_DIR, bsp)
  try { const st = fs.statSync(path.join(dir, `${bsp}.glb`)); out.glb = st.isFile(); out.bytes = st.size } catch { /* not exported */ }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${bsp}.meta.json`), 'utf8'))
    out.meta = true
    out.built_at = meta.built_at || null
    out.world_shell = !!meta.world_shell
  } catch { /* geometry without a sidecar still draws */ }
  return out
}

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
    if (cache.has(key)) return send(req, res, cache.get(key))

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
      if (filePath.endsWith('.meta.json')) res.setHeader('Cache-Control', 'no-cache')
      else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
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

module.exports = { router, mapsStatic, listMaps, MAPS_DIR, buildTrack }
