'use strict'

// The profile's two zombies reads (B, 2026-09-22): the maps a player plays — "Top maps" and
// "Recent maps" at the top, like Movement's Most played / Recently played — and "Overall".
//
// Everything here is a read of `games` + `game_players`. Nothing is sampled, estimated or
// defaulted into looking like data:
//
//   TIME on a map is the game's own duration credited to each player on it. `duration_ms`
//   is the referee's in-game clock; a game that has none (an abandoned run, an old row) falls
//   back to `ended_at - started_at`, which is what the task asked for and is an upper bound.
//
//   SEEDED DEMO GAMES ARE LEFT OUT (`games.demo`). They are scaffolding, marked as such by
//   the seeder and nothing else, and a profile is the one page where a fake game would be
//   read as something the player did.
//
//   KILLS / DOWNS / REVIVES are shown only when the game actually reports them. The columns
//   exist on every `game_players` row and default to 0, and on 2026-09-22 every real game on
//   the live site carries 0 for all three — including a game to round 2, where a kill of 0 is
//   not a fact but an absence: the real game does not yet emit the `points why:kill` event
//   the referee counts kills from (infra/host-agent/lib/referee.js ev_points). So a stat is
//   "recorded" once ANY real (non-demo) game on the site has a non-zero value for it, and
//   until then the profile does not print it at all. A zero printed beside a name reads as
//   "this player killed nothing", which would be the site making something up.
//   2026-09-23 (bug 7, referee.md §16): the cause was upstream — the DLL could not read the
//   counters at all. A §16 box DLL reads them from the game's own scoreboard fields and
//   the host folds them from `stats` events, so the first real game on such a box turns
//   each column on by itself; nothing here needs to change when it does.

const { db } = require('../db/database')

const MAP_ROWS = 5

// Time the game ran, per game row. duration_ms when the referee reported one, else the wall
// clock between start and end, never negative.
const TIME_SQL = `CASE WHEN COALESCE(g.duration_ms,0) > 0 THEN g.duration_ms
                       WHEN g.ended_at IS NOT NULL AND g.started_at IS NOT NULL AND g.ended_at > g.started_at
                         THEN g.ended_at - g.started_at
                       ELSE 0 END`

const REAL = 'COALESCE(g.demo,0)=0'

/**
 * Per-map rows for one player: key, title, art, time_ms, games, best_round, last_played.
 * `top` is by time then games; `recent` is by the last game's end.
 */
function mapsFor(steamId, { limit = MAP_ROWS } = {}) {
  const rows = db.prepare(`
    SELECT g.map_key, COUNT(*) games, SUM(${TIME_SQL}) time_ms, MAX(COALESCE(g.rounds,0)) best_round,
           MAX(COALESCE(g.ended_at, g.started_at)) last_played,
           m.title, m.art
      FROM game_players gp JOIN games g ON g.id=gp.game_id
      LEFT JOIN maps m ON m.key=g.map_key
     WHERE gp.steam_id=? AND ${REAL} AND COALESCE(g.map_key,'') <> ''
     GROUP BY g.map_key`).all(String(steamId))
  const out = rows.map((r) => ({
    key: r.map_key,
    title: r.title || r.map_key,
    art: r.art || null,
    time_ms: Number(r.time_ms) || 0,
    games: Number(r.games) || 0,
    best_round: Number(r.best_round) || 0,
    last_played: r.last_played || null,
  }))
  const top = out.slice().sort((a, b) => (b.time_ms - a.time_ms) || (b.games - a.games) || a.title.localeCompare(b.title)).slice(0, limit)
  const recent = out.slice().sort((a, b) => (b.last_played || 0) - (a.last_played || 0)).slice(0, limit)
  return { top, recent, total: out.length }
}

// Which of the per-player combat stats the pipeline has ever actually produced (see the
// header). One query, three answers.
function recordedStats() {
  const r = db.prepare(`SELECT MAX(gp.kills) k, MAX(gp.downs) d, MAX(gp.revives) v
                          FROM game_players gp JOIN games g ON g.id=gp.game_id WHERE ${REAL}`).get() || {}
  return { kills: (r.k || 0) > 0, downs: (r.d || 0) > 0, revives: (r.v || 0) > 0 }
}

/**
 * The Overall section. Games, rounds, the best round (with the game it happened in), time,
 * records held, member since — and kills/downs/revives only where recorded.
 */
function overallFor(steamId, { user = null } = {}) {
  const sid = String(steamId)
  const g = db.prepare(`SELECT COUNT(*) games, COALESCE(SUM(${TIME_SQL}),0) time_ms,
                               COALESCE(SUM(gp.rounds_played),0) rounds,
                               COALESCE(SUM(gp.kills),0) kills, COALESCE(SUM(gp.downs),0) downs,
                               COALESCE(SUM(gp.revives),0) revives
                          FROM game_players gp JOIN games g ON g.id=gp.game_id
                         WHERE gp.steam_id=? AND ${REAL}`).get(sid)
  // THE BEST ROUND answers to the same rule as the career strip always has
  // (lib/results.js careerFor / eligibleForStats): a Verified game the site refereed, not
  // self-reported, and not joined late. A Local run's round is the player's own word.
  // And only in a map's DEFAULT game mode (game-modes.md): a Gun Game or Sharpshooter round is
  // not a round of the map's own game, so it never becomes the headline number.
  const gameModes = require('./gameModes')
  const best = db.prepare(`SELECT g.id, g.match_id, g.map_key, g.rounds, g.ended_at, g.game_mode, m.title,
                                  (SELECT 1 FROM replays r WHERE r.game_id=g.id) has_replay
                             FROM game_players gp JOIN games g ON g.id=gp.game_id
                             LEFT JOIN maps m ON m.key=g.map_key
                            WHERE gp.steam_id=? AND ${REAL} AND g.mode='verified' AND COALESCE(g.self_reported,0)=0
                              AND gp.late=0 AND COALESCE(g.rounds,0) > 0
                            ORDER BY g.rounds DESC, g.ended_at ASC LIMIT 200`).all(sid)
    .find((r) => !r.game_mode || r.game_mode === gameModes.resolve(r.map_key, null)) || null
  const held = require('./records').heldBy(sid).length
  const rec = recordedStats()
  const out = {
    games: g.games,
    rounds_played: g.rounds,
    best_round: best ? {
      round: best.rounds, game_id: best.id, match_id: best.match_id, map_key: best.map_key,
      map_title: best.title || best.map_key, at: best.ended_at, replay: !!best.has_replay,
    } : null,
    time_ms: g.time_ms,
    records_held: held,
    member_since: (user && user.created_at) || null,
    recorded: rec,
  }
  if (rec.kills) out.kills = g.kills
  if (rec.downs) out.downs = g.downs
  if (rec.revives) out.revives = g.revives
  return out
}

module.exports = { mapsFor, overallFor, recordedStats, MAP_ROWS }
