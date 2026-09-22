'use strict'

// Badges — the query layer over `badges` and `badge_awards`, ported from Movement's
// `server/lib/badges.js`. Its one governing rule carries over unchanged:
//
//   NOTHING IN THIS FILE DERIVES A BADGE. It projects rows and it runs award(). The rules
//   live next door in lib/achievements.js and lib/mapRecords.js, and the only thing they
//   borrow from here is award(). Movement pulled rule logic back OUT of its query layer on
//   2026-07-26 and recorded why: a badge has to mean somebody (or some named rule) decided
//   you should have it, and that stops being visible in the code the moment the two mix.
//
// Four kinds live in one table because a profile wears them the same way:
//
//   staff        hand-awarded
//   achievement  a rule the sweep checks (round milestones, maps beaten, collections)
//   map          one per map, earned by the map's main finish, with ticks and a solo mark
//   record       HELD, not earned. Gold while you hold the record; it moves when the record
//                does. The only kind that can leave a profile without a ban.
//
// Earned is earned: there is no code path here that deletes a `map` or `achievement` award
// except `wipeForCheating()`, which exists because 99 §4.9 says a cheating ban wipes records
// and map badges and nothing else does.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const MAX_PINNED = 3
const DEFAULT_OBTAIN = 'Awarded by staff'

function project(row) {
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    obtain: row.obtain || (row.kind === 'staff' ? DEFAULT_OBTAIN : ''),
    kind: row.kind || 'staff',
    family: row.family || null,
    map_key: row.map_key || null,
    art: row.art || null,
    retired: !!row.retired,
    holders: row.holders != null ? Number(row.holders) : undefined,
    created_at: row.created_at || null,
  }
}

function list({ includeRetired = true, kind = null } = {}) {
  const where = []
  const args = []
  if (!includeRetired) where.push('b.retired = 0')
  if (kind) { where.push('b.kind = ?'); args.push(kind) }
  return db.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM badge_awards a WHERE a.badge_id = b.id) holders
      FROM badges b ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY b.sort_order ASC, b.id ASC`).all(...args).map(project)
}

const get = (id) => project(db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM badge_awards a WHERE a.badge_id=b.id) holders
                                          FROM badges b WHERE b.id=?`).get(Number(id)))
const bySlug = (slug) => db.prepare('SELECT * FROM badges WHERE slug=?').get(String(slug))
const byRule = (rule) => db.prepare('SELECT * FROM badges WHERE rule=?').get(String(rule))

function holders(badgeId, limit = 200) {
  return db.prepare(`SELECT a.steam_id, a.awarded_at, a.solo, a.ticks, u.username, u.enw_name, u.avatar, u.deleted
                       FROM badge_awards a LEFT JOIN users u ON u.steam_id=a.steam_id
                      WHERE a.badge_id=? ORDER BY a.awarded_at DESC LIMIT ?`).all(Number(badgeId), limit)
    .map((r) => ({
      steam_id: r.steam_id,
      name: r.deleted ? 'Deleted player' : (r.enw_name || r.steam_id),
      avatar: r.deleted ? null : r.avatar,
      awarded_at: r.awarded_at,
      solo: !!r.solo,
      ticks: safeJson(r.ticks, []) || [],
    }))
}

// What a profile wears. Movement's rule: a badge with NO ARTWORK is not wearable — it can be
// created, edited, awarded and listed in the directory, but it never renders a hole on
// somebody's profile. Zombies keeps that for staff and achievement badges; a MAP badge is
// always wearable because its art is the map's art, generated rather than uploaded.
function forPlayer(steamId) {
  const rows = db.prepare(`SELECT b.*, a.awarded_at, a.solo, a.ticks, a.game_id
                             FROM badge_awards a JOIN badges b ON b.id=a.badge_id
                            WHERE a.steam_id=? ORDER BY a.awarded_at DESC`).all(String(steamId))
  return rows
    .filter((r) => r.art || r.kind === 'map' || r.kind === 'record')
    .map((r) => ({
      ...project(r),
      awarded_at: r.awarded_at,
      solo: !!r.solo,
      ticks: safeJson(r.ticks, []) || [],
      game_id: r.game_id || null,
    }))
}

function parsePinned(raw) {
  const v = safeJson(raw, [])
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite).slice(0, MAX_PINNED) : []
}

// Pins are FILTERED against real awards on read, so a record badge that moved away drops off
// the header with no migration and no broken image.
function pinnedFor(steamId) {
  const u = db.prepare('SELECT pinned_badges FROM users WHERE steam_id=?').get(String(steamId))
  const ids = parsePinned(u && u.pinned_badges)
  if (!ids.length) return []
  const held = new Set(db.prepare('SELECT badge_id FROM badge_awards WHERE steam_id=?').all(String(steamId)).map((r) => r.badge_id))
  return ids.filter((id) => held.has(id)).map((id) => get(id)).filter(Boolean)
}

function setPinned(steamId, ids) {
  const held = new Set(db.prepare('SELECT badge_id FROM badge_awards WHERE steam_id=?').all(String(steamId)).map((r) => r.badge_id))
  const clean = (Array.isArray(ids) ? ids : []).map(Number).filter((id) => held.has(id)).slice(0, MAX_PINNED)
  db.prepare('UPDATE users SET pinned_badges=? WHERE steam_id=?').run(JSON.stringify(clean), String(steamId))
  return clean
}

// ---- writes ---------------------------------------------------------------------------

// The composite primary key IS the "award it twice" guard: an admin double-clicking Award,
// or two sweeps racing, must not mint a second holding. Returns true only on a NEW award, so
// the caller knows whether to write a feed line and fire a toast.
function award(badgeId, steamId, by = 'system', { note = null, solo = false, ticks = null, gameId = null } = {}) {
  const r = db.prepare(`INSERT OR IGNORE INTO badge_awards (badge_id, steam_id, awarded_at, awarded_by, note, solo, ticks, game_id)
                        VALUES (?,?,?,?,?,?,?,?)`)
    .run(Number(badgeId), String(steamId), now(), by, note, solo ? 1 : 0, ticks ? JSON.stringify(ticks) : null, gameId)
  return r.changes > 0
}

// Ticks accumulate on the map badge: "Easter Egg · Buyable Ending · Round 30" on the hover
// card (05). A tick is added to an existing award without re-awarding it, and a solo mark is
// sticky — doing it again in a group never removes it.
function addTicks(badgeId, steamId, ticks, { solo = false } = {}) {
  const a = db.prepare('SELECT * FROM badge_awards WHERE badge_id=? AND steam_id=?').get(Number(badgeId), String(steamId))
  if (!a) return false
  const have = new Set(safeJson(a.ticks, []) || [])
  let changed = false
  for (const t of ticks || []) if (t && !have.has(t)) { have.add(t); changed = true }
  const nextSolo = a.solo || (solo ? 1 : 0)
  if (!changed && nextSolo === a.solo) return false
  db.prepare('UPDATE badge_awards SET ticks=?, solo=? WHERE badge_id=? AND steam_id=?')
    .run(JSON.stringify([...have]), nextSolo, Number(badgeId), String(steamId))
  return true
}

function revoke(badgeId, steamId) {
  return db.prepare('DELETE FROM badge_awards WHERE badge_id=? AND steam_id=?').run(Number(badgeId), String(steamId)).changes > 0
}

function create({ slug, name, description, obtain, kind = 'staff', rule = null, family = null, mapKey = null, art = null, createdBy = 'admin' }) {
  db.prepare(`INSERT INTO badges (slug, name, description, obtain, kind, rule, family, map_key, art, created_at, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(slug), String(name), description || null, obtain || null, kind, rule, family, mapKey, art, now(), createdBy)
  return bySlug(slug)
}

function update(id, patch) {
  const fields = ['name', 'description', 'obtain', 'art', 'sort_order', 'retired']
  const sets = []
  const vals = []
  for (const f of fields) if (patch[f] !== undefined) { sets.push(`${f}=?`); vals.push(patch[f]) }
  if (!sets.length) return get(id)
  db.prepare(`UPDATE badges SET ${sets.join(', ')} WHERE id=?`).run(...vals, Number(id))
  return get(id)
}

// 99 §4.9: a CHEATING ban wipes records and map badges. Other bans do not, and no other code
// path removes an earned badge. Held record badges go too, because they are records.
function wipeForCheating(steamId) {
  const sid = String(steamId)
  const n = db.prepare(`DELETE FROM badge_awards WHERE steam_id=? AND badge_id IN
                        (SELECT id FROM badges WHERE kind IN ('map','record'))`).run(sid).changes
  db.prepare('UPDATE records SET current=0, verified=0 WHERE steam_id=?').run(sid)
  db.prepare('DELETE FROM map_progress WHERE steam_id=?').run(sid)
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('badges.wipe', ?, ?, ?)")
    .run(sid, JSON.stringify({ badges: n }), now())
  return n
}

module.exports = {
  MAX_PINNED, project, list, get, bySlug, byRule, holders, forPlayer,
  pinnedFor, setPinned, award, addTicks, revoke, create, update, wipeForCheating,
}
