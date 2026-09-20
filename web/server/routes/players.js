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
      records: recordsLib.heldBy(sid),
      recent: hidden ? null : results.recent({ steamId: sid, limit: 12 }),
      history_hidden: hidden,
      favourites: maps.favouritesOf(sid),
      most_played: mostPlayed(sid),
      where: presence.whereabouts(sid),
      comments: comments.list('profile', sid),
      friend_state: req.me ? users.friendState(req.me.steam_id, sid) : 'none',
      can_comment: req.me ? comments.mayComment('profile', sid, req.me.steam_id).ok : false,
    })
  })

  r.post('/:who/comments', requireUser, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const out = comments.add('profile', u.steam_id, req.me.steam_id, (req.body && req.body.body) || '')
    res.status(out.ok ? 200 : 400).json(out)
  })

  r.post('/:who/friend', requireUser, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const action = (req.body && req.body.action) || 'request'
    if (action === 'request') return res.json(users.requestFriend(req.me.steam_id, u.steam_id))
    if (action === 'accept') return res.json(users.respondFriend(req.me.steam_id, u.steam_id, true))
    if (action === 'decline') return res.json(users.respondFriend(req.me.steam_id, u.steam_id, false))
    if (action === 'remove') return res.json(users.removeFriend(req.me.steam_id, u.steam_id))
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
