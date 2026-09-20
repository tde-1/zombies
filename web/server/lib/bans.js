'use strict'

// Moderation: reports, infractions, bans (05 "Staff, moderation & bans", 99 §4.9).
//
// Two rules do all the work here and both are B's:
//
//   * **Griefing gets a PUBLIC-PLAY ban, not a full ban.** The player keeps playing with
//     their friends and loses public lobbies and quick-join. That is `scope='public'`, and
//     it is checked in exactly two places (joining a public lobby, quick-join) rather than
//     at the door.
//   * **A CHEATING ban wipes records and map badges. Other bans do not.** That is the
//     `cheating` flag, and it is the only thing that calls badges.wipeForCheating().
//
// There is no fixed ladder. Moderators decide case by case, so an infraction is a note with
// a kind, not a step on a scale that automates the next one.

const { db, now } = require('../db/database')
const badges = require('./badges')

const KINDS = ['cheating', 'chat', 'afk-farming', 'griefing', 'other']

function activeBans(steamId) {
  return db.prepare(`SELECT * FROM bans WHERE steam_id=? AND active=1 AND (expires_at IS NULL OR expires_at > ?)`)
    .all(String(steamId), now())
}

const siteBanned = (steamId) => activeBans(steamId).some((b) => b.scope === 'site')
const publicBanned = (steamId) => activeBans(steamId).some((b) => b.scope === 'site' || b.scope === 'public')

function ban({ steamId, scope = 'site', reason = null, cheating = false, by = null, expiresAt = null }) {
  const info = db.prepare(`INSERT INTO bans (steam_id, scope, reason, cheating, by_steam, created_at, expires_at, active)
                           VALUES (?,?,?,?,?,?,?,1)`)
    .run(String(steamId), scope, reason, cheating ? 1 : 0, by, now(), expiresAt)
  let wiped = 0
  if (cheating) wiped = badges.wipeForCheating(steamId)
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('ban.add', ?, ?, ?)")
    .run(by, JSON.stringify({ steam_id: steamId, scope, cheating, wiped }), now())
  return { ok: true, id: info.lastInsertRowid, wiped }
}

function unban(id, by) {
  db.prepare('UPDATE bans SET active=0 WHERE id=?').run(Number(id))
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('ban.remove', ?, ?, ?)")
    .run(by, JSON.stringify({ id }), now())
  // A cheating ban's wipe is NOT undone by an unban. The records and badges are gone
  // because the runs were not real; lifting the ban says they may play again, not that the
  // runs happened. Re-awarding by hand is an admin's explicit act.
  return { ok: true }
}

function infract({ steamId, kind = 'other', note = null, by = null, reportId = null }) {
  const info = db.prepare(`INSERT INTO infractions (steam_id, kind, note, by_steam, report_id, created_at)
                           VALUES (?,?,?,?,?,?)`).run(String(steamId), kind, note, by, reportId, now())
  return { ok: true, id: info.lastInsertRowid }
}

const infractionsFor = (steamId) => db.prepare('SELECT * FROM infractions WHERE steam_id=? ORDER BY created_at DESC').all(String(steamId))
const bansFor = (steamId) => db.prepare('SELECT * FROM bans WHERE steam_id=? ORDER BY created_at DESC').all(String(steamId))

// ---- reports -----------------------------------------------------------------------
function report({ kind, subject = null, reporter, reported = null, reason = null, detail = null }) {
  const info = db.prepare(`INSERT INTO reports (kind, subject, reporter, reported, reason, detail, status, created_at)
                           VALUES (?,?,?,?,?,?, 'new', ?)`)
    .run(kind, subject, String(reporter), reported, reason, detail, now())
  return { ok: true, id: info.lastInsertRowid }
}

function queue(status = 'new') {
  const users = require('./users')
  return db.prepare('SELECT * FROM reports WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status).map((r) => ({
    id: r.id, kind: r.kind, subject: r.subject, reason: r.reason, detail: r.detail,
    status: r.status, at: r.created_at,
    reporter: users.publicById(r.reporter),
    reported: r.reported ? users.publicById(r.reported) : null,
    handled_by: r.handled_by ? users.publicById(r.handled_by) : null,
    handled_at: r.handled_at,
    note: r.note,
    // The comment a report is about, so a moderator does not have to go and find it.
    context: r.kind === 'comment' ? db.prepare('SELECT * FROM comments WHERE id=?').get(Number(r.subject)) || null : null,
  }))
}

function resolve(id, { status = 'closed', note = null, by = null } = {}) {
  db.prepare('UPDATE reports SET status=?, note=?, handled_by=?, handled_at=? WHERE id=?')
    .run(status, note, by, now(), Number(id))
  return { ok: true }
}

const counts = () => ({
  new: db.prepare("SELECT COUNT(*) c FROM reports WHERE status='new'").get().c,
  bans: db.prepare('SELECT COUNT(*) c FROM bans WHERE active=1').get().c,
})

module.exports = {
  KINDS, activeBans, siteBanned, publicBanned, ban, unban,
  infract, infractionsFor, bansFor, report, queue, resolve, counts,
}
