'use strict'

// The home rows. Movement's mode home is rows of map cards; which maps are in a row is an
// editorial decision, so it is a table (`collections`, `collection_maps`) rather than a
// constant in the client. See db/database.js for why it is not `playlists`.
//
// Two kinds:
//   auto    the row is a query, resolved here, at read time.
//   manual  the row is its `collection_maps` rows in `position` order.
//
// A manual row NEVER shows a map the list view would hide. `maps.list()` is the one place
// that knows what "playable" means (health, hidden), and a row that reached around it would
// be the only surface on the site offering a broken map — which is exactly what 99 §4.8
// forbids. So a manual row is resolved by intersecting its keys with a list() call, and a
// collection whose maps have all been retired renders as no row at all rather than as an
// empty shelf.

const { db, now } = require('../db/database')
const maps = require('./maps')

const AUTO = {
  newest: { sort: 'newest' },
  popular: { sort: 'popular' },
  rating: { sort: 'rating' },
  oldest: { sort: 'oldest' },
  stock: { sort: 'name', source: 'stock' },
}
const AUTO_KEYS = Object.keys(AUTO)

const rowOf = (slug) => db.prepare('SELECT * FROM collections WHERE slug=?').get(String(slug))
const byId = (id) => db.prepare('SELECT * FROM collections WHERE id=?').get(Number(id))

function keysOf(id) {
  return db.prepare('SELECT map_key FROM collection_maps WHERE collection_id=? ORDER BY position, rowid')
    .all(Number(id)).map((r) => r.map_key)
}

/** One row's maps, projected the same way every other map surface projects them. */
function resolve(c, { me = null } = {}) {
  const limit = c.limit_n > 0 ? c.limit_n : 12
  if (c.kind === 'auto') {
    const q = AUTO[c.auto] || AUTO.newest
    return maps.list({ ...q, limit, me }).maps
  }
  const want = keysOf(c.id)
  if (!want.length) return []
  // One list() call, then filtered — not one call per key. The order is the collection's,
  // not the list's, because the order IS part of the editorial decision.
  const have = new Map(maps.list({ sort: 'name', me }).maps.map((m) => [m.key, m]))
  return want.map((k) => have.get(k)).filter(Boolean).slice(0, limit)
}

/**
 * Every live row, in order, with its maps. Rows that resolve to nothing are dropped: an
 * empty shelf on a home page reads as a site that is broken rather than as a row nobody has
 * filled in yet.
 */
function live({ me = null } = {}) {
  const rows = db.prepare("SELECT * FROM collections WHERE state='live' ORDER BY sort_order, id").all()
  return rows.map((c) => ({
    slug: c.slug, name: c.name, blurb: c.blurb || null, kind: c.kind, auto: c.auto || null,
    maps: resolve(c, { me }),
  })).filter((r) => r.maps.length > 0)
}

/** The admin console's view: every row, live or not, with its hand-picked keys. */
function all() {
  return db.prepare('SELECT * FROM collections ORDER BY sort_order, id').all().map((c) => ({
    id: c.id, slug: c.slug, name: c.name, blurb: c.blurb || null, kind: c.kind,
    auto: c.auto || null, state: c.state, sort_order: c.sort_order, limit_n: c.limit_n,
    keys: c.kind === 'manual' ? keysOf(c.id) : [],
    resolved: resolve(c).length,
  }))
}

// ---- writes (admin only; the route does the gating) -------------------------------------

function create({ slug, name, blurb = null, kind = 'manual', auto = null, sort_order = 100, limit_n = 12, by = null }) {
  const s = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) return { ok: false, error: 'a collection needs a slug' }
  if (rowOf(s)) return { ok: false, error: 'that slug is taken' }
  const k = kind === 'auto' ? 'auto' : 'manual'
  if (k === 'auto' && !AUTO_KEYS.includes(String(auto))) return { ok: false, error: `auto must be one of ${AUTO_KEYS.join(', ')}` }
  const t = now()
  db.prepare(`INSERT INTO collections (slug, name, blurb, kind, auto, state, sort_order, limit_n, created_at, updated_at, updated_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(s, String(name || s), blurb, k, k === 'auto' ? String(auto) : null, 'live',
      Number(sort_order) || 100, Number(limit_n) || 12, t, t, by)
  return { ok: true, collection: rowOf(s) }
}

const FIELDS = ['name', 'blurb', 'state', 'sort_order', 'limit_n', 'auto']

function update(id, patch = {}, by = null) {
  const c = byId(id)
  if (!c) return { ok: false, error: 'no such collection' }
  for (const f of FIELDS) {
    if (!(f in patch)) continue
    if (f === 'state' && !['live', 'hidden'].includes(String(patch[f]))) return { ok: false, error: 'state is live or hidden' }
    if (f === 'auto' && c.kind === 'auto' && !AUTO_KEYS.includes(String(patch[f]))) return { ok: false, error: `auto must be one of ${AUTO_KEYS.join(', ')}` }
    db.prepare(`UPDATE collections SET ${f}=? WHERE id=?`).run(patch[f], c.id)
  }
  db.prepare('UPDATE collections SET updated_at=?, updated_by=? WHERE id=?').run(now(), by, c.id)
  return { ok: true }
}

function addMap(id, mapKey) {
  const c = byId(id)
  if (!c) return { ok: false, error: 'no such collection' }
  if (c.kind !== 'manual') return { ok: false, error: 'that row is a query — it has no hand-picked maps' }
  // The map has to exist. A key nobody can resolve would sit in the table for ever and
  // never draw, which is a row that is silently one shorter than the admin thinks it is.
  if (!maps.byKey(mapKey) && !maps.bySlug(mapKey)) return { ok: false, error: 'no such map' }
  const key = (maps.byKey(mapKey) || maps.bySlug(mapKey)).key
  const max = db.prepare('SELECT COALESCE(MAX(position), -1) p FROM collection_maps WHERE collection_id=?').get(c.id).p
  db.prepare('INSERT OR IGNORE INTO collection_maps (collection_id, map_key, position, added_at) VALUES (?,?,?,?)')
    .run(c.id, key, max + 1, now())
  return { ok: true, keys: keysOf(c.id) }
}

function removeMap(id, mapKey) {
  const c = byId(id)
  if (!c) return { ok: false, error: 'no such collection' }
  db.prepare('DELETE FROM collection_maps WHERE collection_id=? AND map_key=?').run(c.id, String(mapKey))
  return { ok: true, keys: keysOf(c.id) }
}

/** Whole-order rewrite: the caller sends the keys it wants, in the order it wants them. */
function reorder(id, keys) {
  const c = byId(id)
  if (!c) return { ok: false, error: 'no such collection' }
  const have = new Set(keysOf(c.id))
  const upd = db.prepare('UPDATE collection_maps SET position=? WHERE collection_id=? AND map_key=?')
  db.transaction(() => {
    (Array.isArray(keys) ? keys : []).forEach((k, i) => { if (have.has(k)) upd.run(i, c.id, k) })
  })()
  return { ok: true, keys: keysOf(c.id) }
}

function remove(id) {
  const c = byId(id)
  if (!c) return { ok: false, error: 'no such collection' }
  db.prepare('DELETE FROM collections WHERE id=?').run(c.id)
  return { ok: true }
}

module.exports = { live, all, create, update, addMap, removeMap, reorder, remove, resolve, keysOf, AUTO_KEYS }
