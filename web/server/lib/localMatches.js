'use strict'

// A Local game in flight — the state machine behind `POST /api/launcher/local/*`.
//
// ── Why this is a table and not a Map ─────────────────────────────────────────────────
//
// It was a `Map` in routes/launcher.js, and that was the biggest hole in the MVP. B's
// definition of done is *"I make a run on it; if I get a certain amount of rounds, it
// should log those rounds"*. A run is forty minutes. If the site restarts inside those
// forty minutes — a deploy, a crash, `node --watch` on a save — the Map is empty, and
// `POST /local/result` answers **"not your game"**. The run is gone, and there is nothing
// anywhere to recover it from.
//
// Reproduced before the fix, on a private instance: start a local game, restart the
// server, post the result → `404 {"error":"not your game"}`.
//
// So a local match is a row. Three things follow from that and all three are the point:
//
//   1. **A restart does not lose the run.** The result is matched against the row.
//   2. **A crash mid-run leaves a number.** Every live frame records the highest round the
//      launcher reported. A run that never posts a result is still closed out with the
//      round it reached, marked `frames_only` so nobody mistakes it for a refereed result.
//   3. **Nothing sits "live" forever.** `sweep()` closes matches that stopped heartbeating.
//
// ── What it is not ────────────────────────────────────────────────────────────────────
// It is not the game. The game is the `games` row `lib/results.ingest` writes. This table
// is the thing in between, and it is deliberately small: who, which map, how far, when
// last heard from.
//
// ── What it is worth ─────────────────────────────────────────────────────────────────
// Nothing, and that is not this file's decision to make: everything that leaves here is
// stamped `self_reported` by the caller and downgraded again by `lib/results.js`. A local
// match holds no box secret and cannot mint one — every endpoint that writes here is
// authenticated as the PLAYER by the ordinary session cookie.

const crypto = require('crypto')
const { db, now } = require('../db/database')

// No frame for this long, having had at least one, means the game is gone: the process
// died, the PC slept, or the player alt-F4'd. Twenty minutes is longer than any pause the
// launcher should produce and shorter than a run.
const STALE_MS = 20 * 60_000

// A launcher that has never sent a frame has told us nothing, so we must not conclude
// anything from its silence. Those matches are held for a full day before being closed —
// the old in-memory TTL, kept.
const SILENT_MS = 26 * 3600_000

// The highest round we will believe from a frame. WaW's round counter is a 32-bit int and
// a local game has the console open, so this is a sanity bound on OUR storage, not a claim
// about the game. Rounds past it are clamped and the row says so via `frames_only`.
const MAX_ROUND = 100_000

// How recently a match must have been heard from before a second `start` on the same map
// is treated as the SAME run resuming rather than a new one.
//
// Both mistakes cost something. Resuming too eagerly merges two runs the player meant to
// keep apart — quit at round 5, start again, and both attempts land on one game row.
// Resuming too reluctantly orphans the run a crashed launcher is coming back to. Ten
// minutes is longer than a map load and shorter than a deliberate second attempt.
const RESUME_MS = 10 * 60_000

const q = {
  insert: db.prepare(`INSERT INTO local_matches (match_id, steam_id, map_key, state, round, frames, started_at, last_seen)
                      VALUES (?,?,?, 'live', 0, 0, ?, ?)`),
  byId: db.prepare('SELECT * FROM local_matches WHERE match_id=?'),
  beat: db.prepare(`UPDATE local_matches SET last_seen=?, frames=frames+1, round=MAX(round, ?) WHERE match_id=?`),
  finish: db.prepare(`UPDATE local_matches SET state='done', game_id=?, ended_at=?, last_seen=? WHERE match_id=?`),
  abandon: db.prepare(`UPDATE local_matches SET state='abandoned', game_id=?, ended_at=? WHERE match_id=?`),
  inFlight: db.prepare(`SELECT * FROM local_matches WHERE steam_id=? AND state='live' ORDER BY started_at DESC`),
  staleWithFrames: db.prepare(`SELECT * FROM local_matches WHERE state='live' AND frames > 0 AND last_seen < ?`),
  staleSilent: db.prepare(`SELECT * FROM local_matches WHERE state='live' AND frames = 0 AND started_at < ?`),
}

/** A new local match. The id is the site's, never the client's. */
function start(steamId, mapKey) {
  const id = 'l_' + crypto.randomBytes(6).toString('hex')
  const t = now()
  q.insert.run(id, String(steamId), String(mapKey), t, t)
  return q.byId.get(id)
}

const byId = (matchId) => q.byId.get(String(matchId || '')) || null

/**
 * The row, but only for the player it belongs to.
 *
 * Every local endpoint goes through here. A local game is one PC and one player, so
 * ownership is the whole authorisation model: without it anybody could paint frames onto
 * anybody's live view, or post a result against somebody else's account.
 */
function owned(matchId, steamId) {
  const row = byId(matchId)
  if (!row || String(row.steam_id) !== String(steamId)) return null
  return row
}

/** A live frame arrived. Returns the row. */
function heartbeat(matchId, round) {
  const r = Number(round)
  const clamped = Number.isFinite(r) && r > 0 ? Math.min(Math.floor(r), MAX_ROUND) : 0
  q.beat.run(now(), clamped, String(matchId))
  return byId(matchId)
}

/** A result arrived and became a game. */
function finish(matchId, gameId) {
  q.finish.run(gameId != null ? Number(gameId) : null, now(), now(), String(matchId))
  return byId(matchId)
}

/** Every local match this player still has open. A restarted launcher asks for this. */
const inFlight = (steamId) => q.inFlight.all(String(steamId))

/**
 * The match a second `start` on this map should resume, if any.
 *
 * Only a match that has been heard from inside RESUME_MS. An older one is left alone: it
 * stays live until the sweep closes it, which writes it out as the abandoned run it is
 * rather than quietly folding it into the next attempt.
 */
const resumable = (steamId, mapKey, at = now()) =>
  inFlight(steamId).find((x) => x.map_key === String(mapKey) && at - x.last_seen < RESUME_MS) || null

/** What a client is allowed to know about one of its own matches. */
const pub = (row) => (!row ? null : {
  match_id: row.match_id,
  map_key: row.map_key,
  state: row.state,
  round: row.round,
  frames: row.frames,
  game_id: row.game_id,
  started_at: row.started_at,
  last_seen: row.last_seen,
  ended_at: row.ended_at,
})

/**
 * Close out matches nobody finished.
 *
 * A match that reached a round and then went silent is written as a game so the run is not
 * lost — flagged `abandoned` and `frames_only`, `end_reason: 'abandoned'`, and stamped
 * self-reported like everything else through this door. A match that never reported a
 * round is closed with no game row, because there is nothing to say about it and inventing
 * a round-0 game would be noise on a profile.
 *
 * Called on a timer and on the way into the local endpoints, so it runs even on a site
 * that is only ever poked by a launcher.
 */
function sweep({ at = now() } = {}) {
  const out = { abandoned: 0, recovered: 0 }
  const rows = [...q.staleWithFrames.all(at - STALE_MS), ...q.staleSilent.all(at - SILENT_MS)]
  for (const row of rows) {
    let gameId = null
    if (row.round >= 1) {
      try {
        gameId = recoverAsGame(row)
        if (gameId) out.recovered++
      } catch (e) {
        // A sweep that throws stops sweeping, and then matches really do sit live forever.
        db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('local.recover.failed', ?, ?, ?)")
          .run(row.steam_id, JSON.stringify({ match_id: row.match_id, error: e.message }), now())
      }
    }
    q.abandon.run(gameId, now(), row.match_id)
    out.abandoned++
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('local.abandoned', ?, ?, ?)")
      .run(row.steam_id, JSON.stringify({ match_id: row.match_id, map: row.map_key, round: row.round, recovered: !!gameId }), now())
  }
  return out
}

/**
 * Write an unfinished run as a game, from the frames alone.
 *
 * This is the honest version of "a crash mid-run leaves a recoverable record". It is not a
 * referee summary and it does not pretend to be one: there is no finish, no stats, no
 * duration the game vouched for, and the flags say where the number came from. What it
 * does keep is the thing B asked for — the map, the round, and when.
 */
function recoverAsGame(row) {
  const results = require('./results')
  const users = require('./users')
  const u = users.byId ? users.byId(row.steam_id) : null
  const out = results.ingest({
    box: null,
    instance: 'local',
    summary: {
      match_id: row.match_id,
      mode: 'local',
      map: row.map_key,
      solo: true,
      player_count: 1,
      players: [{ slot: 0, steamid: row.steam_id, name: (u && u.enw_name) || null }],
      rounds: row.round,
      finish: null,
      duration_ms: Math.max(0, row.last_seen - row.started_at),
      started_at: new Date(row.started_at).toISOString(),
      ended_at: new Date(row.last_seen).toISOString(),
      end_reason: 'abandoned',
      // Said in the row itself, not only in a comment: this number came from the live
      // frames the launcher was pushing, not from a referee that watched the game end.
      flags: ['abandoned', 'frames_only'],
      records_eligible: false,
      xp_multiplier: 0,
    },
    replay: null,
  }, { selfReported: true })
  return out && out.ok ? out.game_id : null
}

module.exports = { start, byId, owned, heartbeat, finish, inFlight, resumable, pub, sweep, recoverAsGame, STALE_MS, SILENT_MS, RESUME_MS, MAX_ROUND }
