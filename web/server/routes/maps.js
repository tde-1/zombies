'use strict'

// `/api/maps` — the archive browse and the map page.

const express = require('express')
const maps = require('../lib/maps')
const records = require('../lib/records')
const comments = require('../lib/comments')
const playlists = require('../lib/playlists')
const parties = require('../lib/parties')
const assignments = require('../lib/assignments')
const { db } = require('../db/database')
const { requireUser, requireApproved } = require('../middleware/auth')

function router() {
  const r = express.Router()

  // The full list plus everything the filter bar needs to draw itself, so the Maps page is
  // one request rather than five.
  r.get('/', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    const q = req.query
    const out = maps.list({
      q: q.q, finish: q.finish, author: q.author, year: q.year ? Number(q.year) : null,
      tag: q.tag, progress: q.progress, sort: q.sort, source: q.source,
      includeBroken: q.archive === '1',
      me, limit: q.limit ? Number(q.limit) : null, offset: q.offset ? Number(q.offset) : 0,
    })
    res.json({
      ...out,
      filters: {
        authors: maps.authors(),
        years: maps.years(),
        tags: maps.tagCloud(),
      },
    })
  })

  // Everything the Maps home (Movement's mode home) shows above the list.
  r.get('/home', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    const mapWeek = require('../lib/mapWeek')
    res.json({
      count: maps.count(),
      week: mapWeek.current(),
      playlists: playlists.live({ me, withMaps: true }),
      featured: maps.list({ sort: 'popular', limit: 6, me }).maps,
      newest: maps.list({ sort: 'newest', limit: 6, me }).maps,
      favourites: me ? maps.favouritesOf(me) : [],
    })
  })

  r.get('/:key', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    const d = maps.detail(req.params.key, { me })
    if (!d) return res.status(404).json({ error: 'no such map' })
    res.json({
      map: d,
      boards: records.forMap(d.key, { versionId: req.query.version ? Number(req.query.version) : d.version_id }),
      comments: comments.list('map', d.key),
      lobbies: parties.publicLobbies(d.key),
      live: assignments.live().filter((g) => g.map === d.key),
      recent: require('../lib/results').recent({ mapKey: d.key, limit: 8 }),
      // "Beaten by N players", and which of your friends are among them (05).
      friends_beaten: me ? friendsBeaten(me, d.key) : [],
    })
  })

  r.post('/:key/rate', requireUser, (req, res) => {
    res.json(maps.rate(req.params.key, req.me.steam_id, Number((req.body && req.body.thumbs) || 0), (req.body && req.body.game_id) || null))
  })

  r.post('/:key/favourite', requireUser, (req, res) => {
    res.json(maps.favourite(req.params.key, req.me.steam_id, !!(req.body && req.body.on)))
  })

  r.post('/:key/comments', requireUser, (req, res) => {
    const out = comments.add('map', req.params.key, req.me.steam_id, (req.body && req.body.body) || '')
    res.status(out.ok ? 200 : 400).json(out)
  })

  // Play / Join. The map page's big honest button ends here.
  r.post('/:key/play', requireApproved, (req, res) => {
    const party = parties.ensure(req.me.steam_id)
    const set = parties.setMap(req.me.steam_id, req.params.key)
    if (!set.ok) return res.status(400).json(set)
    void party
    res.json({ ok: true, party: set.party })
  })

  return r
}

function friendsBeaten(me, mapKey) {
  const users = require('../lib/users')
  const ids = users.friendIds(me)
  if (!ids.length) return []
  const q = db.prepare(`SELECT steam_id FROM map_progress WHERE map_key=? AND beaten=1 AND steam_id IN (${ids.map(() => '?').join(',')})`)
  return q.all(String(mapKey), ...ids).map((r) => users.publicById(r.steam_id)).filter(Boolean)
}

module.exports = { router }
