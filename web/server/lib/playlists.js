'use strict'

// Playlists (13 §3), Movement's system with one addition.
//
// Two kinds:
//   curated  staff-picked, ordered, with member rows ("Treyarch four", "UGX classics")
//   creator  AUTOMATIC, one per creator: all of their maps. It has no member rows at all —
//            `creator` is the definition and the maps are resolved at read time, so a newly
//            imported map by that author joins the list without anybody editing it. That is
//            the only way an auto playlist can be honest on an archive that grows weekly.
//
// Completion badges use the existing machinery: `reward_badge` holds a BADGE ID and the rule
// key is `playlist-<id>` (lib/achievements.js).

const { db, now } = require('../db/database')
const maps = require('./maps')

function mapsOf(pl) {
  if (pl.kind === 'creator' && pl.creator) {
    return db.prepare('SELECT * FROM maps WHERE author=? AND hidden=0 ORDER BY released_at, title').all(pl.creator)
  }
  return db.prepare(`SELECT m.* FROM playlist_maps pm JOIN maps m ON m.key=pm.map_key
                      WHERE pm.playlist_id=? ORDER BY pm.position`).all(pl.id)
}

function project(pl, { me = null, withMaps = true } = {}) {
  const rows = withMaps ? mapsOf(pl) : []
  const badge = pl.reward_badge ? db.prepare('SELECT id, slug, name, art FROM badges WHERE id=?').get(pl.reward_badge) : null
  const out = {
    id: pl.id,
    slug: pl.slug,
    name: pl.name,
    blurb: pl.blurb || null,
    kind: pl.kind,
    creator: pl.creator || null,
    state: pl.state,
    map_count: withMaps ? rows.length : db.prepare('SELECT COUNT(*) c FROM playlist_maps WHERE playlist_id=?').get(pl.id).c,
    reward_badge: badge,
    maps: rows.map((m) => maps.project(m, { me })),
  }
  if (me && withMaps && rows.length) {
    const beaten = db.prepare(`SELECT map_key FROM map_progress WHERE steam_id=? AND beaten=1`).all(String(me)).map((r) => r.map_key)
    const set = new Set(beaten)
    out.progress = { done: rows.filter((m) => set.has(m.key)).length, total: rows.length }
  }
  return out
}

// `scheduled` is the same invisibility as `hidden` with a live_from, and the read treats it
// as live once that time passes rather than needing a job to flip it (Movement's note).
function live({ me = null, withMaps = true } = {}) {
  const rows = db.prepare('SELECT * FROM playlists ORDER BY sort_order, id').all()
  return rows
    .filter((p) => p.state === 'live' || (p.state === 'scheduled' && p.live_from && p.live_from <= now()))
    .map((p) => project(p, { me, withMaps }))
}

const bySlug = (slug, opts = {}) => {
  const p = db.prepare('SELECT * FROM playlists WHERE slug=?').get(String(slug))
  return p ? project(p, opts) : null
}

function create({ slug, name, blurb = null, kind = 'curated', creator = null, state = 'hidden', rewardBadge = 0, by = null }) {
  const info = db.prepare(`INSERT INTO playlists (slug, name, blurb, kind, creator, state, reward_badge, created_at, created_by, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(String(slug), String(name), blurb, kind, creator, state, rewardBadge, now(), by, now())
  return db.prepare('SELECT * FROM playlists WHERE id=?').get(info.lastInsertRowid)
}

function setMaps(playlistId, mapKeys) {
  const tx = db.transaction((id, keys) => {
    db.prepare('DELETE FROM playlist_maps WHERE playlist_id=?').run(id)
    const ins = db.prepare('INSERT OR IGNORE INTO playlist_maps (playlist_id, map_key, position, added_at) VALUES (?,?,?,?)')
    keys.forEach((k, i) => ins.run(id, String(k), i, now()))
  })
  tx(Number(playlistId), mapKeys || [])
  return bySlug((db.prepare('SELECT slug FROM playlists WHERE id=?').get(Number(playlistId)) || {}).slug)
}

function update(id, patch) {
  const fields = ['name', 'blurb', 'state', 'sort_order', 'reward_badge', 'live_from']
  const sets = []
  const vals = []
  for (const f of fields) if (patch[f] !== undefined) { sets.push(`${f}=?`); vals.push(patch[f]) }
  if (!sets.length) return null
  sets.push('updated_at=?'); vals.push(now())
  db.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id=?`).run(...vals, Number(id))
  require('./achievements').bind()
  return db.prepare('SELECT * FROM playlists WHERE id=?').get(Number(id))
}

// ---- admin (2026-09-23) --------------------------------------------------------------
// Every playlist in every state, for the editor. `keys` is the member order as stored,
// including a key whose map row has gone, so the editor can show it and let staff drop it
// rather than silently losing it the way the JOIN in mapsOf() does.
function all() {
  return db.prepare('SELECT * FROM playlists ORDER BY sort_order, id').all().map((p) => {
    const keys = db.prepare('SELECT map_key FROM playlist_maps WHERE playlist_id=? ORDER BY position').all(p.id).map((r) => r.map_key)
    const known = new Map(keys.length ? db.prepare(`SELECT key, title, health, hidden FROM maps WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys).map((m) => [m.key, m]) : [])
    return {
      id: p.id, slug: p.slug, name: p.name, blurb: p.blurb || null, kind: p.kind, creator: p.creator || null,
      state: p.state, live_from: p.live_from || null, sort_order: p.sort_order || 0, reward_badge: p.reward_badge || 0,
      updated_at: p.updated_at, created_by: p.created_by || null,
      maps: p.kind === 'creator'
        ? mapsOf(p).map((m) => ({ key: m.key, title: m.title, health: m.health, hidden: !!m.hidden, missing: false, server: maps.serverLevel(m) }))
        : keys.map((k) => { const m = known.get(k); return { key: k, title: m ? m.title : k, health: m ? m.health : null, hidden: m ? !!m.hidden : false, missing: !m, server: m ? maps.serverLevel(m) : null } }),
    }
  })
}

const byId = (id) => db.prepare('SELECT * FROM playlists WHERE id=?').get(Number(id))

function remove(id) {
  const p = byId(id)
  if (!p) return { ok: false, error: 'no such playlist' }
  db.prepare('DELETE FROM playlist_maps WHERE playlist_id=?').run(p.id)
  db.prepare('DELETE FROM playlists WHERE id=?').run(p.id)
  require('./achievements').bind()
  return { ok: true, slug: p.slug }
}

/** Keys that are not map rows. The editor refuses them rather than storing a dead member. */
function unknownKeys(keys) {
  return (keys || []).map(String).filter((k) => !db.prepare('SELECT 1 FROM maps WHERE key=?').get(k))
}

module.exports = { mapsOf, project, live, bySlug, create, setMaps, update, all, byId, remove, unknownKeys }
