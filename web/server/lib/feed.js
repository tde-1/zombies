'use strict'

// The home page's "latest records + badges" (13 §3). One append-only table; the page reads
// the tail. Kept deliberately dumb: a feed row is a RENDERED FACT, not a join waiting to
// happen, because the thing it describes (a record, a badge holding) may have moved on and
// the feed is a log of what happened, not a view of what is.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const KEEP = 500

function push({ kind, steam_id = null, map_key = null, badge_id = null, game_id = null, text = null, data = null }) {
  db.prepare(`INSERT INTO feed (kind, steam_id, map_key, badge_id, game_id, text, data_json, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(kind, steam_id, map_key, badge_id, game_id, text, data ? JSON.stringify(data) : null, now())
  // Trim occasionally rather than on every insert: this runs on the result-ingest path and
  // a DELETE with a subselect on every badge is a waste.
  if (Math.random() < 0.05) {
    db.prepare('DELETE FROM feed WHERE id NOT IN (SELECT id FROM feed ORDER BY id DESC LIMIT ?)').run(KEEP)
  }
}

function recent(limit = 30) {
  const rows = db.prepare(`SELECT f.*, u.username, u.enw_name, u.avatar, u.deleted,
                                  b.name AS badge_name, b.slug AS badge_slug, b.art AS badge_art,
                                  m.title AS map_title
                             FROM feed f
                             LEFT JOIN users u ON u.steam_id=f.steam_id
                             LEFT JOIN badges b ON b.id=f.badge_id
                             LEFT JOIN maps m ON m.key=f.map_key
                            ORDER BY f.created_at DESC, f.id DESC LIMIT ?`).all(limit)
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    at: r.created_at,
    text: r.text,
    data: safeJson(r.data_json, null),
    player: r.steam_id ? {
      steam_id: r.steam_id,
      name: r.deleted ? 'Deleted player' : (r.enw_name || r.username || r.steam_id),
      avatar: r.deleted ? null : r.avatar,
    } : null,
    map: r.map_key ? { key: r.map_key, title: r.map_title || r.map_key } : null,
    badge: r.badge_id ? { id: r.badge_id, slug: r.badge_slug, name: r.badge_name, art: r.badge_art } : null,
    game_id: r.game_id || null,
  }))
}

module.exports = { push, recent }
