'use strict'

// HELD map badges — the gold one. Ported from Movement's `server/lib/mapRecords.js`.
//
// The model is the whole point and it is Movement's, unchanged: a record badge is `kind:
// 'record'` with id `m:<map>`, and it is HELD, NOT EARNED. It moves with the record. Lose
// the record and the badge goes back to glass on your profile and gold on somebody else's.
// That is the only kind of badge that can leave a profile without a ban, and the history of
// who held it and when lives in `badge_holds` so the movement is auditable.
//
// Two paths, exactly as Movement has them:
//
//   onRunFinish(mapKey)   the FAST PATH. A game just ended on this map, so re-evaluate that
//                         one map now and let the player see the gold badge on the
//                         post-match screen.
//   sweep()               the periodic reconciliation, every MAP_RECORDS_SWEEP_MS. It exists
//                         because a record can also move when a run is deleted, a player is
//                         banned or a board is frozen — none of which is a run finishing.

const { db, now } = require('../db/database')
const badges = require('./badges')
const feed = require('./feed')
const records = require('./records')

const SWEEP_MS = Number(process.env.ZM_MAP_RECORDS_SWEEP_MS || 10 * 60_000)

// Who should hold the record badge for this map right now: everybody in the top row of any
// ENW-Verified board on it. A four-player world record makes four holders, which is correct
// — they all set it.
function holdersFor(mapKey) {
  const boards = db.prepare(`SELECT * FROM boards WHERE map_key=? AND profile='ENW-Verified'`).all(String(mapKey))
  const out = new Set()
  for (const b of boards) {
    const top = records.rowsFor(b.id, 1)[0]
    if (!top) continue
    for (const p of top.players) out.add(p.steam_id)
  }
  return out
}

function badgeFor(mapKey) {
  return db.prepare(`SELECT * FROM badges WHERE kind='record' AND map_key=?`).get(String(mapKey))
}

/** Re-evaluate one map's record badge. Returns { gained, lost }. */
function reconcile(mapKey) {
  const badge = badgeFor(mapKey)
  if (!badge) return { gained: [], lost: [] }
  const should = holdersFor(mapKey)
  const has = new Set(db.prepare('SELECT steam_id FROM badge_awards WHERE badge_id=?').all(badge.id).map((r) => r.steam_id))

  const gained = []
  const lost = []
  for (const sid of should) {
    if (has.has(sid)) continue
    badges.award(badge.id, sid, 'map-records', { note: 'holds the record' })
    db.prepare('INSERT INTO badge_holds (badge_id, steam_id, from_at, reason) VALUES (?,?,?,?)').run(badge.id, sid, now(), 'took the record')
    gained.push(sid)
  }
  for (const sid of has) {
    if (should.has(sid)) continue
    badges.revoke(badge.id, sid)
    db.prepare(`UPDATE badge_holds SET to_at=? WHERE badge_id=? AND steam_id=? AND to_at IS NULL`).run(now(), badge.id, sid)
    lost.push(sid)
  }
  return { gained, lost }
}

/** The fast path: one map, right after a game on it finished. */
function onRunFinish(mapKey, { announce = true } = {}) {
  const r = reconcile(mapKey)
  if (announce) {
    const map = db.prepare('SELECT title FROM maps WHERE key=?').get(String(mapKey))
    for (const sid of r.gained) {
      feed.push({ kind: 'record', steam_id: sid, map_key: String(mapKey), text: `took the record on ${map ? map.title : mapKey}` })
    }
  }
  return r
}

function sweep() {
  const maps = db.prepare('SELECT key FROM maps').all()
  let gained = 0
  let lost = 0
  for (const m of maps) {
    try { const r = reconcile(m.key); gained += r.gained.length; lost += r.lost.length } catch (e) {
      console.error(`[mapRecords] ${m.key}: ${e.message}`)
    }
  }
  return { at: now(), gained, lost }
}

/** The gold-vs-glass question a profile asks per map badge. */
function holdsRecord(steamId, mapKey) {
  const badge = badgeFor(mapKey)
  if (!badge) return false
  return !!db.prepare('SELECT 1 FROM badge_awards WHERE badge_id=? AND steam_id=?').get(badge.id, String(steamId))
}

function history(mapKey, limit = 50) {
  const badge = badgeFor(mapKey)
  if (!badge) return []
  return db.prepare('SELECT * FROM badge_holds WHERE badge_id=? ORDER BY from_at DESC LIMIT ?').all(badge.id, limit)
}

let timer = null
function startJobs() {
  if (timer) return
  sweep()
  timer = setInterval(() => { try { sweep() } catch (e) { console.error('[mapRecords] sweep:', e.message) } }, SWEEP_MS)
  timer.unref?.()
}

module.exports = { SWEEP_MS, holdersFor, badgeFor, reconcile, onRunFinish, sweep, holdsRecord, history, startJobs }
