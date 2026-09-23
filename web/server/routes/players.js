'use strict'

// `/api/players` — profiles, the map shelf, friends.
//
// The privacy rule is 99 §4.1 and it is enforced HERE, not in the client: game history is
// public by default and hideable; **records and badges are always public**. So a private
// profile still shows its badges, its shelf and its records, and hides only `recent`.

const express = require('express')
const users = require('../lib/users')
const badges = require('../lib/badges')
const achievements = require('../lib/achievements')
const results = require('../lib/results')
const recordsLib = require('../lib/records')
const xp = require('../lib/xp')
const presence = require('../lib/presence')
const comments = require('../lib/comments')
const maps = require('../lib/maps')
const profile = require('../lib/profile')
const movementProfile = require('../lib/movementProfile')
const { db } = require('../db/database')
const { requireUser } = require('../middleware/auth')

function router() {
  const r = express.Router()

  r.get('/:who', (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const sid = u.steam_id
    const isSelf = req.me && req.me.steam_id === sid
    const hidden = u.privacy_history === 'private' && !isSelf && !(req.me && req.me.is_mod)
    res.json({
      player: users.pub(u),
      standing: xp.forPlayer(sid),
      career: results.careerFor(sid),
      badges: badges.forPlayer(sid),
      pinned: badges.pinnedFor(sid),
      progress: achievements.progressFor(sid),
      shelf: shelf(sid),
      records: recordsLib.heldBy(sid).map((r) => ({ ...r, art: (db.prepare('SELECT art FROM maps WHERE key=?').get(r.map_key) || {}).art || null })),
      recent: hidden ? null : results.recent({ steamId: sid, limit: 12 }),
      history_hidden: hidden,
      favourites: maps.favouritesOf(sid),
      most_played: mostPlayed(sid),
      where: presence.whereabouts(sid),
      comments: comments.list('profile', sid),
      friend_state: req.me ? users.friendState(req.me.steam_id, sid) : 'none',
      can_comment: req.me ? comments.mayComment('profile', sid, req.me.steam_id).ok : false,
      // Movement's profile, on ours (2026-09-22): the banner they set on ENW Movement
      // (copied here, lib/movementProfile.js), the top/recent maps, and the Overall block.
      // `maps` is history, so it follows the history privacy setting; Overall is the career
      // strip it replaced, which never did.
      movement: movementProfile.forPlayer(sid),
      maps: hidden ? null : profile.mapsFor(sid),
      overall: profile.overallFor(sid, { user: u }),
    })
    // A copy older than a few hours is refreshed AFTER this answer, never in front of it.
    movementProfile.refreshIfStale(sid)
  })

  // ── Profile comments, Movement's API shape (CSGO-Matchmaker routes/players.js comments) ──
  // GET is public; the rows carry `mine` / `can_remove` for THIS viewer, and `post_block` is
  // the reason a signed-in viewer may not post (friends-only, closed) or null. Stored in the
  // one `comments` table as kind='profile', subject=<steamid>, beside map comments, so there
  // is one reports queue and one moderation surface.
  const wallRow = (c, me) => {
    const a = users.publicById(c.steam_id) || {}
    const mine = !!(me && String(me.steam_id) === String(c.steam_id))
    return {
      id: c.id, steam_id: c.steam_id, username: a.name || c.steam_id, avatar: a.avatar || null,
      body: c.body, created_at: c.created_at, mine,
      can_remove: mine || !!(me && (me.is_mod || me.is_admin)),
    }
  }
  const wallList = (sid, me) => require('../db/database').db
    .prepare(`SELECT * FROM comments WHERE kind='profile' AND subject=? AND removed=0 ORDER BY created_at ASC, id ASC LIMIT 300`)
    .all(String(sid)).map((c) => wallRow(c, me))

  r.get('/:who/comments', (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const may = req.me ? comments.mayComment('profile', u.steam_id, req.me.steam_id) : null
    res.json({ comments: wallList(u.steam_id, req.me), post_block: may && !may.ok ? may.error : null })
  })

  r.post('/:who/comments', requireUser, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const out = comments.add('profile', u.steam_id, req.me.steam_id, (req.body && req.body.body) || '')
    if (!out.ok) return res.status(out.error === 'friends only' || /turned off/.test(out.error || '') ? 403 : 400).json(out)
    const row = db.prepare('SELECT * FROM comments WHERE id=?').get(Number(out.id))
    res.json({ ...out, comment: row ? wallRow(row, req.me) : null })
  })

  // Delete: your own, or anybody's if you are staff. Soft, like every removal here
  // (lib/comments.js): a moderator must be able to see what was removed.
  r.delete('/:who/comments/:id', requireUser, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const c = db.prepare("SELECT * FROM comments WHERE id=? AND kind='profile' AND subject=? AND removed=0").get(Number(req.params.id), String(u.steam_id))
    if (!c) return res.status(404).json({ error: 'no such comment' })
    const out = comments.remove(c.id, req.me.steam_id, { moderator: !!(req.me.is_mod || req.me.is_admin) })
    res.status(out.ok ? 200 : 403).json(out)
  })

  r.post('/:who/friend', requireUser, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const action = (req.body && req.body.action) || 'request'
    if (action === 'request') return res.json(users.requestFriend(req.me.steam_id, u.steam_id))
    if (action === 'accept') return res.json(users.respondFriend(req.me.steam_id, u.steam_id, true))
    if (action === 'decline') return res.json(users.respondFriend(req.me.steam_id, u.steam_id, false))
    if (action === 'remove') { const out = users.removeFriend(req.me.steam_id, u.steam_id); return res.status(out.ok ? 200 : 409).json(out) }
    res.status(400).json({ error: 'unknown action' })
  })

  r.get('/:who/friends', (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json({ friends: users.friendIds(u.steam_id).map((id) => ({ ...users.publicById(id), where: presence.whereabouts(id) })) })
  })

  return r
}

// The map shelf (05): EVERY map, greyed until beaten, with ticks. It is the collection view,
// so it lists the whole archive and not only what the player has touched — the empty slots
// are the point.
function shelf(steamId) {
  const all = db.prepare(`SELECT key, title, main_finish, round_n, has_ee, has_buyable, art
                            FROM maps WHERE hidden=0 AND health IN ('verified','playable','custom-only')
                           ORDER BY title`).all()
  const prog = new Map(db.prepare('SELECT * FROM map_progress WHERE steam_id=?').all(String(steamId)).map((p) => [p.map_key, p]))
  const mapRecords = require('../lib/mapRecords')
  return all.map((m) => {
    const p = prog.get(m.key)
    return {
      key: m.key,
      title: m.title,
      art: m.art,
      played: !!(p && p.played),
      beaten: !!(p && p.beaten),
      solo: !!(p && p.solo),
      ee: !!(p && p.ee),
      buyable: !!(p && p.buyable),
      best_round: (p && p.best_round) || 0,
      games: (p && p.games) || 0,
      // Gold while they hold a record on that map.
      gold: mapRecords.holdsRecord(steamId, m.key),
    }
  })
}

function mostPlayed(steamId, limit = 5) {
  return db.prepare(`SELECT mp.map_key, mp.games, mp.time_ms, m.title FROM map_progress mp
                       JOIN maps m ON m.key=mp.map_key WHERE mp.steam_id=?
                      ORDER BY mp.time_ms DESC LIMIT ?`).all(String(steamId), limit)
    .map((r) => ({ key: r.map_key, title: r.title, games: r.games, time_ms: r.time_ms }))
}

module.exports = { router, shelf }
