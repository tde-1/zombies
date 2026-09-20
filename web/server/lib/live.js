'use strict'

// The live view — web spectating (99 §4.4, 13 §4b).
//
//   "Baseline: a web live view in the launcher/site: round, players, points, downs.
//    It uses no game slot."
//
// The host agent already has every byte of this: its referee produces `snap` at 20 Hz for
// players and 10 Hz for zombies, and its own dashboard draws a 2D top-down view from them
// (host.md §6). This file is where those frames arrive on the site.
//
// ── Three decisions, and why ──────────────────────────────────────────────────────
//
// 1. **FRAMES NEVER TOUCH SQLITE.** A live frame is 1–4 Hz per game of positions that are
//    stale in 250 ms. Writing them would be thousands of rows a minute of data nobody ever
//    reads back, on the same file that serves every page — and the durable copy already
//    exists: it is the signed replay on the box. So frames live in a Map with a TTL and die
//    with the process. Losing them costs one screen refresh.
//
// 2. **THE BOX PUSHES; THE SITE STILL NEVER DIALS OUT.** A live view is the one feature
//    that tempts you to have the site poll a box, and the whole fleet design says no
//    (host.md §1: NAT, no inbound rules, no reachable RCON). So the box POSTs frames to
//    `/api/gs/live` on the same outbound connection it already uses for everything else.
//
// 3. **DOWNSAMPLED ON ARRIVAL.** The site does not need 20 Hz: a human watching a top-down
//    view cannot see the difference above about 4 Hz, and every extra frame is a broadcast
//    to every watcher. Frames arriving faster than MIN_FRAME_MS are accepted and dropped —
//    accepted so the box is never made to care, dropped so a misconfigured box cannot make
//    the site do its work.
//
// Visibility is Movement's joinability rule, applied to watching rather than joining: a
// stranger's private lobby serialises as nothing at all. It is not "the page with a
// disabled button" — the map name is itself information about a private game.

const { db, now } = require('../db/database')

const TTL_MS = 30_000          // a game with no frame for this long is not live any more
const MIN_FRAME_MS = 220       // ~4.5 Hz ceiling per game
const MAX_ZOMBIES = 64         // a frame claiming more than the engine can hold is truncated
const MAX_EVENTS = 40

const frames = new Map()       // match_id -> { at, box, instance, state, seq }
let emit = null                // set by the socket layer: (matchId, frame) => void

function setEmitter(fn) { emit = fn }

/**
 * A box reported the live state of one game.
 *
 * `state` is the referee's own `state()` (host.md §4) — the site does not reshape it beyond
 * clamping the parts a hostile or broken box could make expensive.
 *
 * @returns {boolean} true if the frame was stored and broadcast, false if it was dropped
 *                    as too soon. Either way the box gets a 200: rate is our problem.
 */
function push(box, { instance, match_id: matchId, state }) {
  if (!matchId || !state) return false
  const prev = frames.get(matchId)
  const at = Date.now()
  if (prev && at - prev.at < MIN_FRAME_MS) return false

  const frame = {
    match_id: matchId,
    box,
    instance: instance || state.instance || null,
    at,
    seq: (prev ? prev.seq : 0) + 1,
    state: clamp(state),
  }
  frames.set(matchId, frame)
  if (emit) { try { emit(matchId, frame) } catch { /* a dead socket must not fail a frame */ } }
  return true
}

// What we are willing to hold and rebroadcast. Everything here is a bound, not a
// transformation: the numbers are the box's.
function clamp(s) {
  const players = (s.players || []).slice(0, 4).map((p) => ({
    slot: p.slot, name: str(p.name, 32), steamid: p.steamid || null,
    score: int(p.score), health: int(p.health), alive: !!p.alive, down: !!p.down,
    connected: p.connected !== false, late: !!p.late,
    downs: int(p.downs), revives: int(p.revives), weapon: str(p.weapon, 40),
    pos: vec(p.pos), ang: vec(p.ang, 2),
    idle_ms: int(p.idle_ms), afk_warned: !!p.afk_warned,
  }))
  const zombies = (s.zombies || []).slice(0, MAX_ZOMBIES).map((z) => ({
    id: int(z.id), pos: vec(z.pos), health: int(z.health),
  }))
  return {
    phase: s.phase || 'live',
    mode: s.mode || 'verified',
    map: s.map || null,
    map_name: s.map_name || null,
    round: int(s.round),
    max_round: int(s.maxRound != null ? s.maxRound : s.max_round),
    elapsed_ms: int(s.elapsed_ms),
    rta_ms: int(s.rta_ms),
    cap_ms: s.cap_ms == null ? null : int(s.cap_ms),
    cap_left_ms: s.cap_left_ms == null ? null : int(s.cap_left_ms),
    paused: !!s.paused,
    pause_reason: str(s.pause_reason, 60),
    finish: s.finish ? { kind: str(s.finish.kind, 40), label: str(s.finish.label, 60) } : null,
    signals: (s.signals || []).slice(0, 40).map((x) => str(x, 40)),
    flags: (s.flags || []).slice(0, 20).map((x) => str(x, 40)),
    perf: s.perf || null,
    zombies_alive: zombies.length,
    players,
    zombies,
    events: (s.events || []).slice(-MAX_EVENTS),
  }
}

const int = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0)
const str = (s, n) => (s == null ? null : String(s).slice(0, n))
const vec = (v, len = 3) => (Array.isArray(v) ? v.slice(0, len).map((x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0)) : null)

const get = (matchId) => {
  const f = frames.get(String(matchId))
  if (!f) return null
  if (Date.now() - f.at > TTL_MS) { frames.delete(String(matchId)); return null }
  return f
}

/** Every game with a fresh frame. Reaps the stale ones on the way past. */
function all() {
  const out = []
  for (const [id, f] of frames) {
    if (Date.now() - f.at > TTL_MS) { frames.delete(id); continue }
    out.push(f)
  }
  return out.sort((a, b) => b.at - a.at)
}

function drop(matchId) { frames.delete(String(matchId)) }

// ---- who may watch -------------------------------------------------------------------
/**
 * Movement's joinability rule, applied to watching.
 *
 *   public   anybody, signed in or not — this is the page a YouTuber links
 *   friends  the party's members and the leader's friends
 *   private  the party's members only
 *
 * A game with no party behind it (an admin lease, a box booted by hand) is public: there is
 * nobody whose privacy it could be.
 *
 * Returns { ok, reason }. `reason` is shown to the viewer, so it is a sentence.
 */
function canWatch(matchId, viewerSteamId) {
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(matchId))
  if (!a || !a.party_id) return { ok: true }
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(a.party_id)
  if (!party) return { ok: true }
  if (party.visibility === 'public') return { ok: true }
  if (!viewerSteamId) return { ok: false, reason: 'that game is not public' }
  const sid = String(viewerSteamId)
  const member = db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND steam_id=?').get(party.id, sid)
  if (member) return { ok: true }
  if (party.visibility === 'friends') {
    const users = require('./users')
    if (users.friendIds(party.leader).includes(sid)) return { ok: true }
  }
  // A moderator can watch anything — record review and griefing reports both need it, and
  // it is logged.
  const u = db.prepare('SELECT is_mod, is_admin FROM users WHERE steam_id=?').get(sid)
  if (u && (u.is_mod || u.is_admin)) {
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('live.watch.mod', ?, ?, ?)")
      .run(sid, JSON.stringify({ match_id: matchId }), now())
    return { ok: true }
  }
  return { ok: false, reason: 'that game is not public' }
}

/**
 * The live list. Joins the frames to what the site knows about each match, and applies the
 * visibility rule per row — a private game the viewer cannot watch is simply not in the
 * list, rather than being in it with its map blanked out.
 */
function list(viewerSteamId) {
  const users = require('./users')
  return all().map((f) => {
    const v = canWatch(f.match_id, viewerSteamId)
    if (!v.ok) return null
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(f.match_id)
    return {
      match_id: f.match_id,
      box: f.box,
      map: f.state.map,
      map_title: f.state.map_name || f.state.map,
      mode: f.state.mode,
      round: f.state.round,
      phase: f.state.phase,
      paused: f.state.paused,
      player_count: f.state.players.filter((p) => p.connected).length,
      zombies_alive: f.state.zombies_alive,
      elapsed_ms: f.state.elapsed_ms,
      at: f.at,
      party_id: a ? a.party_id : null,
      players: f.state.players.map((p) => (p.steamid ? users.publicById(p.steamid) : null) || { steam_id: null, name: p.name }),
    }
  }).filter(Boolean)
}

const stats = () => ({ games: frames.size, ttl_ms: TTL_MS, min_frame_ms: MIN_FRAME_MS })

module.exports = { push, get, all, list, drop, canWatch, setEmitter, stats, TTL_MS, MIN_FRAME_MS }
