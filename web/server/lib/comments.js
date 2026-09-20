'use strict'

// Comments — map comments and profile comments, "exactly as Movement" (99 §4.2, 13 §3b).
//
// One table for both. They are the same object with a different subject: the same editor,
// the same removal rule, the same reports queue. The one thing that differs is WHO MAY POST,
// and that is the profile owner's "who can comment on my profile" setting.
//
// A removed comment is soft-deleted. A moderator needs to be able to see what they removed,
// and a report that points at a row which no longer exists is a report nobody can judge.

const { db, now } = require('../db/database')
const users = require('./users')

const MAX = 1200

function list(kind, subject, { limit = 100, includeRemoved = false } = {}) {
  const rows = db.prepare(`SELECT * FROM comments WHERE kind=? AND subject=? ${includeRemoved ? '' : 'AND removed=0'}
                            ORDER BY created_at DESC LIMIT ?`).all(String(kind), String(subject), limit)
  return rows.map((c) => ({
    id: c.id,
    body: c.removed ? null : c.body,
    removed: !!c.removed,
    at: c.created_at,
    edited_at: c.edited_at,
    author: users.publicById(c.steam_id),
  }))
}

function mayComment(kind, subject, steamId) {
  if (kind === 'map') return { ok: true }
  const owner = users.byId(subject)
  if (!owner) return { ok: false, error: 'no such profile' }
  const setting = owner.profile_comments || 'everyone'
  if (setting === 'nobody') return { ok: false, error: 'this profile has comments turned off' }
  if (setting === 'friends') {
    if (String(subject) === String(steamId)) return { ok: true }
    if (!users.friendIds(subject).includes(String(steamId))) return { ok: false, error: 'friends only' }
  }
  return { ok: true }
}

function add(kind, subject, steamId, body) {
  const text = String(body || '').trim().slice(0, MAX)
  if (!text) return { ok: false, error: 'say something' }
  const may = mayComment(kind, subject, steamId)
  if (!may.ok) return may
  const info = db.prepare('INSERT INTO comments (kind, subject, steam_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(String(kind), String(subject), String(steamId), text, now())
  return { ok: true, id: info.lastInsertRowid }
}

function remove(id, by, { moderator = false } = {}) {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(id))
  if (!c) return { ok: false, error: 'no such comment' }
  if (!moderator && String(c.steam_id) !== String(by)) return { ok: false, error: 'not yours' }
  db.prepare('UPDATE comments SET removed=1, removed_by=?, removed_at=? WHERE id=?').run(String(by), now(), c.id)
  return { ok: true }
}

module.exports = { list, add, remove, mayComment, MAX }
