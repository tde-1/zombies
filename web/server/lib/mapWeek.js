'use strict'

// The map of the week (13 §3 Home), ported from Movement's `server/lib/mapWeek.js`.
//
// HISTORY, NOT A MUTABLE ROW. The week IS the identity (midnight Monday, epoch ms), so a
// past week stays on the books, a slot can be filled weeks ahead, and "what was it last
// week" is answerable without crawling an audit log.

const { db, now } = require('../db/database')
const { weekStart } = require('./util')

function current() {
  const ws = weekStart()
  const row = db.prepare('SELECT * FROM map_of_week WHERE week_start=?').get(ws)
  if (!row) return null
  const maps = require('./maps')
  const map = maps.byKey(row.map_key)
  if (!map) return null
  return { week_start: ws, note: row.note || null, map: maps.project(map), runs: runsThisWeek(row.map_key, ws) }
}

function set(mapKey, { note = null, by = null, week = null } = {}) {
  const ws = week || weekStart()
  db.prepare(`INSERT INTO map_of_week (week_start, map_key, note, set_at, set_by) VALUES (?,?,?,?,?)
              ON CONFLICT(week_start) DO UPDATE SET map_key=excluded.map_key, note=excluded.note,
                set_at=excluded.set_at, set_by=excluded.set_by`)
    .run(ws, String(mapKey), note, now(), by)
  return current()
}

// Every finish on the map of the week, for the week it happened in. Movement's note applies
// unchanged: the weekly board is NOT the all-time board narrowed by date — the all-time
// board holds one row per player forever and a slower run never appears on it, so "who ran
// it most this week" is unanswerable from it. This is the other book: full capture.
function runsThisWeek(mapKey, ws = weekStart()) {
  const end = ws + 7 * 86_400_000
  const users = require('./users')
  const rows = db.prepare(`SELECT g.*, gp.steam_id FROM games g JOIN game_players gp ON gp.game_id=g.id
                            WHERE g.map_key=? AND g.ended_at >= ? AND g.ended_at < ? AND g.mode='verified'
                            ORDER BY g.rounds DESC, g.duration_ms ASC LIMIT 50`).all(String(mapKey), ws, end)
  return rows.map((r) => ({
    player: users.publicById(r.steam_id),
    rounds: r.rounds,
    finish: r.finish_kind,
    duration_ms: r.duration_ms,
    at: r.ended_at,
    match_id: r.match_id,
  }))
}

const history = (limit = 12) => db.prepare('SELECT * FROM map_of_week ORDER BY week_start DESC LIMIT ?').all(limit)

module.exports = { current, set, runsThisWeek, history, weekStart }
