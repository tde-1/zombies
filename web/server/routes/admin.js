'use strict'

// `/api/admin` — the mod tools at launch (99 §4.9): the reports queue, infractions and
// bans, and record review with the replay. Plus the operator surfaces the site needs to run
// at all: the boxes and their key pins, the map of the week, playlists, badges, and leasing
// a game by hand.
//
// Everything destructive is logged to `activity_log` with the actor, because "a moderator
// decided case by case" (05) only works if you can see who decided what.

const express = require('express')
const bans = require('../lib/bans')
const boxes = require('../lib/boxes')
const badges = require('../lib/badges')
const users = require('../lib/users')
const maps = require('../lib/maps')
const mapWeek = require('../lib/mapWeek')
const playlists = require('../lib/playlists')
const collections = require('../lib/collections')
const assignments = require('../lib/assignments')
const achievements = require('../lib/achievements')
const mapRecords = require('../lib/mapRecords')
const presence = require('../lib/presence')
const enw = require('../lib/enw')
const replays = require('../lib/replays')
const { db, now } = require('../db/database')
const { requireMod, requireAdmin } = require('../middleware/auth')

function router() {
  const r = express.Router()

  // ---- overview -------------------------------------------------------------------
  r.get('/', requireMod, (req, res) => {
    res.json({
      counts: {
        ...bans.counts(),
        users: db.prepare('SELECT COUNT(*) c FROM users WHERE deleted=0').get().c,
        waiting: db.prepare('SELECT COUNT(*) c FROM users WHERE approved=0 AND deleted=0').get().c,
        maps: maps.count(),
        games: db.prepare('SELECT COUNT(*) c FROM games').get().c,
        records: db.prepare('SELECT COUNT(*) c FROM records WHERE current=1').get().c,
      },
      boxes: boxes.list(),
      presence: presence.stats(),
      enw: enw.status(),
      sweeps: { achievements: achievements.lastSweep() },
      recent_activity: db.prepare('SELECT * FROM activity_log ORDER BY logged_at DESC LIMIT 40').all(),
      // A box whose replay key changed is the loudest thing on this page for a reason.
      key_warnings: boxes.list().filter((b) => b.key.pending),
    })
  })

  // ---- reports queue ----------------------------------------------------------------
  r.get('/reports', requireMod, (req, res) => res.json({ reports: bans.queue(String(req.query.status || 'new')) }))

  r.post('/reports/:id/resolve', requireMod, (req, res) => {
    res.json(bans.resolve(Number(req.params.id), { status: (req.body && req.body.status) || 'closed', note: (req.body && req.body.note) || null, by: req.me.steam_id }))
  })

  // ---- infractions and bans ----------------------------------------------------------
  r.get('/player/:who', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json({
      player: users.pub(u),
      infractions: bans.infractionsFor(u.steam_id),
      bans: bans.bansFor(u.steam_id),
      badges: badges.forPlayer(u.steam_id),
      games: require('../lib/results').recent({ steamId: u.steam_id, limit: 25 }),
    })
  })

  r.post('/player/:who/infract', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json(bans.infract({ steamId: u.steam_id, kind: (req.body && req.body.kind) || 'other', note: (req.body && req.body.note) || null, by: req.me.steam_id }))
  })

  r.post('/player/:who/ban', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const b = req.body || {}
    // Griefing is a public-play ban by default (05). The moderator can override, but the
    // default is the policy so nobody has to remember it.
    const scope = b.scope || (b.kind === 'griefing' ? 'public' : 'site')
    res.json(bans.ban({
      steamId: u.steam_id, scope, reason: b.reason || null,
      cheating: !!b.cheating || b.kind === 'cheating',
      by: req.me.steam_id, expiresAt: b.expires_at || null,
    }))
  })

  r.post('/ban/:id/lift', requireMod, (req, res) => res.json(bans.unban(Number(req.params.id), req.me.steam_id)))

  r.post('/player/:who/approve', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    db.prepare('UPDATE users SET approved=? WHERE steam_id=?').run((req.body && req.body.approved) === false ? 0 : 1, u.steam_id)
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('user.approve', ?, ?, ?)")
      .run(req.me.steam_id, JSON.stringify({ steam_id: u.steam_id }), now())
    res.json({ ok: true })
  })

  // The ONLY rename (2026-09-23, lib/names.js). The picker is set-once on purpose: the
  // ENW name is what the invite token carries and what the referee pins into the server's
  // copy of a client's userinfo, so a self-serve rename would hand back exactly the
  // spoofing the lock removes. An admin can still fix a typo or free a name.
  r.post('/player/:who/username', requireAdmin, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const out = require('../lib/names').rename(u.steam_id, (req.body && req.body.username) || '', req.me.steam_id)
    if (!out.ok) return res.status(out.reason === 'taken' ? 409 : 400).json({ error: out.error, reason: out.reason })
    res.json({ ok: true, name: out.name, from: out.from, user: users.publicById(u.steam_id) })
  })

  r.get('/waitlist', requireMod, (req, res) => {
    res.json({ users: db.prepare('SELECT * FROM users WHERE approved=0 AND deleted=0 ORDER BY created_at').all().map(users.pub) })
  })

  r.post('/player/:who/role', requireAdmin, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const b = req.body || {}
    for (const [k, col] of [['admin', 'is_admin'], ['mod', 'is_mod'], ['archivist', 'is_archivist'], ['vip', 'vip_is']]) {
      if (b[k] !== undefined) db.prepare(`UPDATE users SET ${col}=? WHERE steam_id=?`).run(b[k] ? 1 : 0, u.steam_id)
    }
    res.json({ ok: true, player: users.publicById(u.steam_id) })
  })

  // ---- record review -------------------------------------------------------------
  // 99 §4.9: "record review with the replay". The row, the game, the roster and the replay
  // pointer in one payload, plus the one thing that decides whether it is evidence at all —
  // whether the replay's signing key matched the box's pin.
  r.get('/records/review', requireMod, (req, res) => {
    const rows = db.prepare(`SELECT r.*, b.map_key, b.category, b.player_count, b.profile, g.match_id, g.mode, g.ended_at
                               FROM records r JOIN boards b ON b.id=r.board_id LEFT JOIN games g ON g.id=r.game_id
                              WHERE r.current=1 ORDER BY r.created_at DESC LIMIT 100`).all()
    res.json({
      records: rows.map((r2) => {
        const replay = r2.game_id ? db.prepare('SELECT * FROM replays WHERE game_id=?').get(r2.game_id) : null
        return {
          id: r2.id, map_key: r2.map_key, category: r2.category, player_count: r2.player_count,
          profile: r2.profile, round: r2.round, value_ms: r2.value_ms, at: r2.created_at,
          profile_ok: !!r2.profile_ok, profile_note: r2.profile_note, verified: !!r2.verified,
          match_id: r2.match_id, mode: r2.mode,
          players: (JSON.parse(r2.roster || '[]')).map((s) => users.publicById(s)).filter(Boolean),
          // The grade and the exact verify command come from lib/replays.js, which is
          // also what /api/replays/<match> serves publicly — one source for "is this
          // evidence", so a reviewer and a rival are reading the same verdict.
          replay: replay ? replays.describe(replay.match_id, req.me) : null,
        }
      }),
    })
  })

  // Verify the actual file, against the box's PINNED key. This is the review action: it
  // re-reads every chunk, rehashes the chain, checks the footer signature, and refuses a
  // file signed by a key that is not the pin however valid that file is on its own terms.
  r.post('/records/:id/verify', requireMod, async (req, res) => {
    const rec = db.prepare('SELECT * FROM records WHERE id=?').get(Number(req.params.id))
    if (!rec) return res.status(404).json({ error: 'no such record' })
    const g = rec.game_id ? db.prepare('SELECT match_id FROM games WHERE id=?').get(rec.game_id) : null
    if (!g) return res.status(404).json({ error: 'that record has no game attached' })
    res.json(await replays.verify(g.match_id))
  })

  r.post('/records/:id/void', requireMod, (req, res) => {
    db.prepare('UPDATE records SET verified=0, current=0 WHERE id=?').run(Number(req.params.id))
    db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('record.void', ?, ?, ?)")
      .run(req.me.steam_id, JSON.stringify({ id: req.params.id, note: (req.body && req.body.note) || null }), now())
    mapRecords.sweep()
    res.json({ ok: true })
  })

  // ---- boxes and the key pin ---------------------------------------------------------
  r.get('/boxes', requireAdmin, (req, res) => res.json({ boxes: boxes.list() }))

  r.post('/boxes', requireAdmin, (req, res) => {
    const b = req.body || {}
    if (!b.name || !b.match_key) return res.status(400).json({ error: 'name and match_key' })
    res.json({ ok: true, box: boxes.create({ name: b.name, matchKey: b.match_key, region: b.region, note: b.note, maxInstances: b.max_instances || 4 }) })
  })

  r.post('/boxes/:id/enabled', requireAdmin, (req, res) => res.json({ ok: true, box: boxes.setEnabled(req.params.id, !!(req.body && req.body.enabled)) }))
  r.post('/boxes/:id/key/accept', requireAdmin, (req, res) => res.json(boxes.acceptPendingKey(req.params.id, req.me.steam_id)))
  r.post('/boxes/:id/key/reject', requireAdmin, (req, res) => res.json(boxes.rejectPendingKey(req.params.id, req.me.steam_id)))

  // Lease a game by hand. This is how a box is tested without a party: it is the same
  // lease() the party rail calls, so what works here works there.
  r.post('/lease', requireAdmin, (req, res) => {
    const b = req.body || {}
    const out = assignments.lease({
      box: b.box ? boxes.byName(b.box) : null,
      mapKey: b.map || b.map_key,
      mode: b.mode || 'verified',
      players: b.players || [{ steamid: req.me.steam_id, name: users.pub(req.me).name }],
      settings: b.settings || {},
      by: req.me.steam_id,
    })
    res.status(out.ok ? 200 : 400).json(out)
  })

  r.post('/lease/:matchId/cancel', requireAdmin, (req, res) => res.json(assignments.cancel(req.params.matchId, req.me.steam_id)))

  // ---- content -----------------------------------------------------------------------
  r.post('/map-of-week', requireMod, (req, res) => {
    const b = req.body || {}
    if (!b.map_key) return res.status(400).json({ error: 'which map?' })
    res.json({ ok: true, week: mapWeek.set(b.map_key, { note: b.note || null, by: req.me.steam_id }) })
  })

  r.post('/maps/:key', requireMod, (req, res) => {
    const m = maps.byKey(req.params.key)
    if (!m) return res.status(404).json({ error: 'no such map' })
    const b = req.body || {}
    const fields = ['title', 'author', 'year', 'health', 'hidden', 'description', 'readme', 'release_post', 'art', 'round_n']
    const sets = []
    const vals = []
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]) }
    if (sets.length) db.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE id=?`).run(...vals, m.id)
    res.json({ ok: true, map: maps.detail(m.key) })
  })

  r.post('/playlists', requireMod, (req, res) => {
    const b = req.body || {}
    if (!b.slug || !b.name) return res.status(400).json({ error: 'slug and name' })
    const pl = playlists.create({ ...b, rewardBadge: b.reward_badge || 0, by: req.me.steam_id })
    if (b.maps) playlists.setMaps(pl.id, b.maps)
    res.json({ ok: true, playlist: playlists.bySlug(pl.slug) })
  })

  r.put('/playlists/:id', requireMod, (req, res) => {
    playlists.update(Number(req.params.id), req.body || {})
    if (req.body && Array.isArray(req.body.maps)) playlists.setMaps(Number(req.params.id), req.body.maps)
    res.json({ ok: true })
  })

  // ---- badges --------------------------------------------------------------------
  r.get('/badges', requireMod, (req, res) => res.json({ badges: badges.list({ includeRetired: true }) }))

  r.post('/badges', requireAdmin, (req, res) => {
    const b = req.body || {}
    if (!b.name) return res.status(400).json({ error: 'name it' })
    const { slugify } = require('../lib/util')
    res.json({ ok: true, badge: badges.create({ ...b, slug: b.slug || slugify(b.name), createdBy: req.me.steam_id }) })
  })

  r.put('/badges/:id', requireAdmin, (req, res) => res.json({ ok: true, badge: badges.update(Number(req.params.id), req.body || {}) }))

  r.post('/badges/:id/award', requireAdmin, (req, res) => {
    const b = badges.get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such badge' })
    // An achievement is never hand-awarded — the rule is the only thing that hands it out
    // (05, and Movement's badges.js). A map badge is never hand-awarded either: it means
    // the referee saw you finish the map.
    if (b.kind !== 'staff') return res.status(400).json({ error: `a ${b.kind} badge is earned, not awarded` })
    const u = users.resolve((req.body && req.body.steam_id) || '')
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json({ ok: badges.award(b.id, u.steam_id, req.me.steam_id, { note: (req.body && req.body.note) || null }) })
  })

  r.post('/badges/:id/revoke', requireAdmin, (req, res) => {
    const b = badges.get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such badge' })
    if (b.kind === 'achievement' || b.kind === 'map') return res.status(400).json({ error: 'earned is earned; only a cheating ban removes this' })
    const u = users.resolve((req.body && req.body.steam_id) || '')
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json({ ok: badges.revoke(b.id, u.steam_id) })
  })

  // ---- collections: the home rows -----------------------------------------------------
  //
  // B, 2026-09-22: "make the row membership a collections/playlist-like table editable from
  // admin, not hard-coded". This is that console. Every write logs, for the same reason every
  // other write on this router does — a shelf that changed and nobody can say who changed it
  // is an argument waiting to happen.
  const logC = (req, event, meta) => db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)")
    .run(event, req.me.steam_id, JSON.stringify(meta), now())

  r.get('/collections', requireMod, (req, res) => {
    res.json({ collections: collections.all(), auto: collections.AUTO_KEYS })
  })

  r.post('/collections', requireAdmin, (req, res) => {
    const out = collections.create({ ...(req.body || {}), by: req.me.steam_id })
    if (!out.ok) return res.status(400).json(out)
    logC(req, 'collection.create', { slug: out.collection.slug })
    res.json(out)
  })

  r.post('/collections/:id', requireAdmin, (req, res) => {
    const out = collections.update(Number(req.params.id), req.body || {}, req.me.steam_id)
    if (!out.ok) return res.status(400).json(out)
    logC(req, 'collection.update', { id: Number(req.params.id), patch: req.body || {} })
    res.json(out)
  })

  r.post('/collections/:id/maps', requireAdmin, (req, res) => {
    const out = collections.addMap(Number(req.params.id), (req.body && req.body.map_key) || '')
    if (!out.ok) return res.status(400).json(out)
    logC(req, 'collection.add', { id: Number(req.params.id), map: req.body.map_key })
    res.json(out)
  })

  r.delete('/collections/:id/maps/:key', requireAdmin, (req, res) => {
    const out = collections.removeMap(Number(req.params.id), req.params.key)
    if (!out.ok) return res.status(400).json(out)
    logC(req, 'collection.remove', { id: Number(req.params.id), map: req.params.key })
    res.json(out)
  })

  r.post('/collections/:id/order', requireAdmin, (req, res) => {
    const out = collections.reorder(Number(req.params.id), (req.body && req.body.keys) || [])
    if (!out.ok) return res.status(400).json(out)
    res.json(out)
  })

  r.delete('/collections/:id', requireAdmin, (req, res) => {
    const out = collections.remove(Number(req.params.id))
    if (!out.ok) return res.status(400).json(out)
    logC(req, 'collection.delete', { id: Number(req.params.id) })
    res.json(out)
  })

  // ---- sweeps ------------------------------------------------------------------------
  r.post('/sweep', requireAdmin, (req, res) => {
    res.json({ achievements: achievements.sweep(), map_records: mapRecords.sweep() })
  })

  return r
}

module.exports = { router }
