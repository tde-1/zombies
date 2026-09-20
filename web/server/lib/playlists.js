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

module.exports = { mapsOf, project, live, bySlug, create, setMaps, update }
