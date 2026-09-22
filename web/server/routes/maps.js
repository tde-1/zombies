'use strict'

// `/api/maps` — the archive browse and the map page.

const express = require('express')
const maps = require('../lib/maps')
const mapfiles = require('../lib/mapfiles')
const records = require('../lib/records')
const comments = require('../lib/comments')
const playlists = require('../lib/playlists')
const collections = require('../lib/collections')
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
    const archive = q.archive === '1'
    // The playable list is a few dozen maps and is sent whole; the ARCHIVE is the whole
    // crawl — 2,284 rows and 1.1 MB of JSON if you ask for it in one go, which is a page
    // nobody can use and a tab that janks. So the archive view paginates by default and
    // the caller has to ask for more.
    const out = maps.list({
      q: q.q, finish: q.finish, author: q.author, year: q.year ? Number(q.year) : null,
      // One param per CHIP GROUP on the bar, ORed inside and ANDed across (lib/maps.js).
      // `tag` is the catch-all and still takes a single slug, so /maps?tag=top-100 — which
      // is on the map page, on every creator page and in whatever anyone has pasted — keeps
      // meaning exactly what it meant.
      tagGroups: [q.tag, q.size, q.difficulty, q.style],
      progress: q.progress, sort: q.sort, source: q.source,
      // B's morning list (2026-09-22): playable-on-our-server, stock vs custom (`source`,
      // which already existed) and has-a-replay-or-record. Size, difficulty and style are
      // not new params — they are TAG KINDS, and `tag` takes a comma-separated list now, so
      // every chip group on the bar writes the same one param.
      server: q.server === '1', records: q.records === '1',
      includeBroken: archive,
      me,
      limit: q.limit ? Math.min(500, Number(q.limit)) : (archive ? 60 : null),
      offset: q.offset ? Number(q.offset) : 0,
    })
    res.json({
      ...out,
      offset: q.offset ? Number(q.offset) : 0,
      // The filter lists describe the PLAYABLE pool even on the archive view: an author
      // dropdown with 900 names in it is not a filter, it is a scrolling exercise.
      filters: {
        authors: maps.authors(),
        years: maps.years(),
        tags: maps.tagCloud(),
      },
    })
  })

  // Everything the Maps home (Movement's mode home) shows above the grid.
  //
  // `rows` is the whole of it now: New maps, Vanilla, High production and whatever else an
  // admin has made, in the order they set, from the `collections` table (lib/collections.js).
  // The four hard-coded blocks that used to be here — map of the week, your favourites, New,
  // Playlists — are gone as a SHAPE: three of them were a row of maps under a heading, which
  // is what a collection is, and keeping them as their own fields meant four payload keys and
  // four blocks of JSX to say one thing.
  //
  // `week` and `playlists` stay on the wire because the map-of-the-week hero and the playlist
  // machinery are real and are read elsewhere; nothing on the maps page draws them now.
  r.get('/home', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    const mapWeek = require('../lib/mapWeek')
    res.json({
      count: maps.count(),
      rows: collections.live({ me }),
      week: mapWeek.current(),
      playlists: playlists.live({ me, withMaps: true }),
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
      // Where the original came from and whether those links still work (04). On a
      // catalogued-only map this is the whole page.
      sources: maps.sourcesFor(d.key),
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

  // ---- downloading a map -------------------------------------------------------
  //
  // Behind the site password like everything else (the gate is app-wide), so these are
  // not open to the internet. Two routes: what to fetch, and the bytes.

  // What the launcher needs to install this map: every file, its size, its SHA-256.
  r.get('/:key/files', (req, res) => {
    res.json(mapfiles.forMap(req.params.key))
  })

  // The bytes. `Range` is supported because these are 200 MB - 1 GB over a tunnel from
  // a home connection, and a download that cannot resume is a download that fails.
  r.get('/:key/files/:name', (req, res) => {
    const f = mapfiles.resolveFile(req.params.key, req.params.name)
    if (!f) return res.status(404).json({ error: 'no such file for that map' })

    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('accept-ranges', 'bytes')
    // The hash the archive recorded, so a client can verify without a second request.
    if (f.sha256) res.setHeader('x-enw-sha256', f.sha256)
    // These files never change once normalised, so let anything in the middle cache
    // them and let a re-install be free.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')

    const range = req.headers.range
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
      if (!m) { res.setHeader('content-range', `bytes */${f.size}`); return res.status(416).end() }
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      if (start === null) { start = Math.max(0, f.size - (end || 0)); end = f.size - 1 }
      if (end === null || end >= f.size) end = f.size - 1
      if (!(start >= 0) || start > end) { res.setHeader('content-range', `bytes */${f.size}`); return res.status(416).end() }
      res.status(206)
      res.setHeader('content-range', `bytes ${start}-${end}/${f.size}`)
      res.setHeader('content-length', String(end - start + 1))
      if (req.method === 'HEAD') return res.end()
      return require('node:fs').createReadStream(f.full, { start, end }).pipe(res)
    }

    res.setHeader('content-length', String(f.size))
    if (req.method === 'HEAD') return res.end()
    require('node:fs').createReadStream(f.full).pipe(res)
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
