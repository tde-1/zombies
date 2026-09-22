'use strict'

// The routes that are the site itself rather than one noun: home, records, badges,
// playlists, the party rail, chat, and the game view.

const express = require('express')
const maps = require('../lib/maps')
const mapWeek = require('../lib/mapWeek')
const feed = require('../lib/feed')
const presence = require('../lib/presence')
const assignments = require('../lib/assignments')
const records = require('../lib/records')
const badges = require('../lib/badges')
const achievements = require('../lib/achievements')
const playlists = require('../lib/playlists')
const parties = require('../lib/parties')
const results = require('../lib/results')
const chat = require('../lib/chatNetwork')
const live = require('../lib/live')
const replays = require('../lib/replays')
const enw = require('../lib/enw')
const users = require('../lib/users')
const { safeJson } = require('../lib/util')
const { db } = require('../db/database')
const { requireUser, requireApproved } = require('../middleware/auth')

function router() {
  const r = express.Router()

  // ---- home (13 §3) --------------------------------------------------------------
  // Top to bottom, exactly the order B gave: live games + friends online, map of the week
  // + featured, latest records + badges.
  r.get('/home', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    res.json({
      live: assignments.live(),
      // Which of those are actually sending frames, so home can offer Watch on the ones
      // where it would work and stay quiet on the ones where it would not.
      watchable: live.list(me),
      friends: me ? presence.friendsOnline(me) : [],
      online: presence.stats(),
      week: mapWeek.current(),
      featured: maps.list({ sort: 'popular', limit: 4, me }).maps,
      feed: feed.recent(24),
      map_count: maps.count(),
      // What is real and what is not, stated on the page rather than in a document.
      // Nobody opening this for the first time should have to wonder whether something is
      // broken or simply not built yet.
      build: {
        auth: require('./auth').effectiveMode(),
        enw: enw.status().enabled,
        archive_total: db.prepare('SELECT COUNT(*) c FROM maps').get().c,
        // Each of these is a thing a visitor can see and might reasonably expect to work.
        stubbed: [
          require('./auth').effectiveMode() === 'mock'
            && 'Sign-in is a local development page, not Steam. Pick any name; it makes a local account and nothing leaves this machine.',
          !enw.status().enabled && 'ENW names and VIP are not connected, so names come from the Steam persona and VIP is whatever is set locally.',
          'Map art is missing everywhere, so cards show the map’s engine name instead.',
          'The launcher is not installed here, so Play Local and map downloads have nothing to launch or fetch.',
          'Badge art is not drawn yet — every badge is a hexagon with the map name in it.',
        ].filter(Boolean),
      },
      // No "rescued" counter anywhere in v1 (13 §3). This is the map count the way Movement
      // shows it, and nothing else.
    })
  })

  // ---- records hub ----------------------------------------------------------------
  r.get('/records', (req, res) => {
    res.json({
      records: records.hub({
        category: req.query.category || null,
        playerCount: req.query.players ? Number(req.query.players) : null,
        profile: req.query.profile || 'ENW-Verified',
      }),
      categories: records.categories(),
      profiles: records.profiles(),
    })
  })

  r.get('/records/board/:id', (req, res) => {
    const b = db.prepare('SELECT * FROM boards WHERE id=?').get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such board' })
    res.json({ board: b, rows: records.rowsFor(b.id, 100) })
  })

  // ---- badges directory -----------------------------------------------------------
  r.get('/badges', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    res.json({
      badges: badges.list({ includeRetired: false }),
      progress: me ? achievements.progressFor(me) : {},
      held: me ? badges.forPlayer(me).map((b) => b.id) : [],
    })
  })

  r.get('/badges/:slug', (req, res) => {
    const b = badges.bySlug(req.params.slug)
    if (!b) return res.status(404).json({ error: 'no such badge' })
    res.json({ badge: badges.get(b.id), holders: badges.holders(b.id) })
  })

  // ---- playlists ------------------------------------------------------------------
  r.get('/playlists', (req, res) => {
    res.json({ playlists: playlists.live({ me: req.me ? req.me.steam_id : null, withMaps: true }) })
  })

  r.get('/playlists/:slug', (req, res) => {
    const p = playlists.bySlug(req.params.slug, { me: req.me ? req.me.steam_id : null })
    if (!p) return res.status(404).json({ error: 'no such playlist' })
    res.json({ playlist: p })
  })

  // ---- the archive page ---------------------------------------------------------
  // The story and the numbers, all counted rather than typed. The map list itself comes
  // from /api/maps?archive=1, which paginates.
  r.get('/archive', (req, res) => {
    res.json({
      stats: maps.archiveStats(),
      broken: maps.list({ includeBroken: true, sort: 'name' }).maps.filter((m) => m.health === 'broken').slice(0, 50),
      newest: maps.list({ sort: 'newest', limit: 8 }).maps,
      // Where the links point, so the page can say which sites the archive actually rests
      // on rather than claiming a number.
      hosts: db.prepare(`SELECT site, COUNT(*) n,
                                SUM(CASE WHEN status IN ('alive','fetched') THEN 1 ELSE 0 END) alive,
                                SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) dead
                           FROM archive_sources WHERE site IS NOT NULL
                          GROUP BY site ORDER BY n DESC LIMIT 12`).all(),
    })
  })

  // ---- creators -------------------------------------------------------------------
  r.get('/creators', (req, res) => res.json({ creators: maps.authors({ all: true }) }))

  r.get('/creators/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name)
    const rows = maps.list({ author: name, sort: 'oldest', me: req.me ? req.me.steam_id : null })
    if (!rows.total) return res.status(404).json({ error: 'no such creator' })
    const c = db.prepare('SELECT * FROM creators WHERE lower(name)=lower(?)').get(name)
    res.json({
      creator: {
        name,
        slug: c ? c.slug : null,
        bio: c ? c.bio : null,
        claimed_by: c && c.claimed_by ? users.publicById(c.claimed_by) : null,
      },
      maps: rows.maps,
      plays: rows.maps.reduce((n, m) => n + (m.plays || 0), 0),
    })
  })

  // ---- the party rail --------------------------------------------------------------
  r.get('/party', (req, res) => {
    if (!req.me) return res.json({ party: null })
    res.json({
      party: parties.forPlayer(req.me.steam_id),
      launch: parties.launchInfo(req.me.steam_id),
      invites: parties.invitesFor(req.me.steam_id),
    })
  })

  const partyAction = (fn) => (req, res) => {
    const out = fn(req)
    res.status(out && out.ok === false ? 400 : 200).json(out)
  }

  r.post('/party/create', requireApproved, partyAction((req) => ({ ok: true, party: parties.create(req.me.steam_id, req.body || {}) })))
  r.post('/party/join', requireApproved, partyAction((req) => parties.join(req.me.steam_id, Number((req.body && req.body.party_id) || 0))))
  r.post('/party/leave', requireUser, partyAction((req) => parties.leave(req.me.steam_id)))
  r.post('/party/map', requireApproved, partyAction((req) => parties.setMap(req.me.steam_id, (req.body && req.body.map_key) || null)))
  r.post('/party/mode', requireApproved, partyAction((req) => parties.setMode(req.me.steam_id, (req.body && req.body.mode) || 'verified')))
  r.post('/party/visibility', requireApproved, partyAction((req) => parties.setVisibility(req.me.steam_id, (req.body && req.body.visibility) || 'friends')))
  r.post('/party/settings', requireApproved, partyAction((req) => parties.setSettings(req.me.steam_id, (req.body && req.body.settings) || {})))
  r.post('/party/ready-check', requireApproved, partyAction((req) => parties.startReadyCheck(req.me.steam_id, { force: !!(req.body && req.body.force) })))
  // Every member's launcher posts its own map download here while the party forms
  // (docs/protocol/launcher-v0.md). requireUser, not requireApproved: a member of a party
  // is already somebody the leader let in, and refusing the download report of an
  // unapproved friend would leave the panel showing a bar that never moves.
  r.post('/party/:id/progress', requireUser, partyAction((req) => parties.reportProgress(req.me.steam_id, Number(req.params.id), req.body || {})))
  r.post('/party/ready', requireApproved, partyAction((req) => parties.setReady(req.me.steam_id, !!(req.body && req.body.ready))))
  r.post('/party/cancel', requireApproved, partyAction((req) => parties.cancelReadyCheck(req.me.steam_id)))
  r.post('/party/launch', requireApproved, partyAction((req) => parties.launch(req.me.steam_id, { force: !!(req.body && req.body.force) })))
  r.post('/party/invite', requireApproved, partyAction((req) => parties.invite(req.me.steam_id, String((req.body && req.body.steam_id) || ''))))
  r.post('/party/quick-join', requireApproved, partyAction((req) => parties.quickJoin(req.me.steam_id, (req.body && req.body.map_key) || null)))

  // ---- presets (the Custom knobs) ---------------------------------------------------
  r.get('/presets', (req, res) => {
    const rows = db.prepare('SELECT * FROM presets ORDER BY locked DESC, featured DESC, created_at DESC').all()
    res.json({
      presets: rows.map((p) => ({
        id: p.id, code: p.code, name: p.name, blurb: p.blurb,
        knobs: JSON.parse(p.knobs_json || '{}'), locked: !!p.locked, featured: !!p.featured,
        mine: req.me ? p.owner === req.me.steam_id : false,
      })),
      // The eight knob groups of 13 §4c, with their ranges. The UI draws itself from this so
      // the caps live in one place — and the caps are the spec's: "wide but capped".
      groups: KNOB_GROUPS,
    })
  })

  r.post('/presets', requireApproved, (req, res) => {
    const { shortCode } = require('../lib/util')
    const b = req.body || {}
    if (!b.name) return res.status(400).json({ error: 'name it' })
    const code = shortCode(6)
    db.prepare(`INSERT INTO presets (code, owner, name, blurb, knobs_json, created_at)
                VALUES (?,?,?,?,?,?)`).run(code, req.me.steam_id, String(b.name).slice(0, 60), b.blurb || null,
      JSON.stringify(b.knobs || {}), Date.now())
    res.json({ ok: true, code })
  })

  r.get('/presets/:code', (req, res) => {
    const p = db.prepare('SELECT * FROM presets WHERE code=?').get(String(req.params.code).toUpperCase())
    if (!p) return res.status(404).json({ error: 'no such share code' })
    db.prepare('UPDATE presets SET uses=COALESCE(uses,0)+1 WHERE id=?').run(p.id)
    res.json({ preset: { code: p.code, name: p.name, blurb: p.blurb, knobs: JSON.parse(p.knobs_json || '{}'), locked: !!p.locked } })
  })

  // ---- games ------------------------------------------------------------------------
  r.get('/games/:id', (req, res) => {
    const g = /^\d+$/.test(req.params.id) ? results.byId(req.params.id) : results.byMatch(req.params.id)
    if (!g) return res.status(404).json({ error: 'no such game' })
    res.json({ game: g })
  })

  // ---- live games and the live view --------------------------------------------------
  // `/api/live` is the lobby-level list (what has been leased); `/api/live/watch` is the
  // list of games actually sending frames, which is the one the spectator list wants.
  // ---- replays ------------------------------------------------------------------
  // The pointer and the evidence grade are PUBLIC for every game: 99 §4.7 rests records
  // on a signed replay, and a record nobody can check is a record nobody should believe.
  // The bytes are gated (Q-host-1).
  r.get('/replays/:matchId', (req, res) => {
    const d = replays.describe(req.params.matchId, req.me)
    if (!d) return res.status(404).json({ error: 'no replay for that game' })
    res.json({ replay: d })
  })

  r.get('/replays/:matchId/download', (req, res) => {
    const row = replays.rowFor(req.params.matchId)
    const may = replays.mayDownload(row, req.me)
    if (!may.ok) return res.status(row ? 403 : 404).json({ error: may.reason })
    const f = replays.fileFor(req.params.matchId)
    if (!f) {
      return res.status(503).json({
        error: 'the file is on the game box and there is no object store yet',
        // Say where it is rather than pretending it does not exist — on a dev box the
        // person asking can just go and get it.
        file: row.file || null,
      })
    }
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-length', f.size)
    res.setHeader('content-disposition', `attachment; filename="${f.name}"`)
    require('fs').createReadStream(f.path).pipe(res)
  })

  r.get('/live', (req, res) => res.json({
    live: assignments.live(),
    watchable: live.list(req.me ? req.me.steam_id : null),
    stats: live.stats(),
  }))

  r.get('/live/:matchId', (req, res) => {
    const id = String(req.params.matchId)
    const may = live.canWatch(id, req.me ? req.me.steam_id : null)
    if (!may.ok) return res.status(403).json({ error: may.reason })
    const frame = live.get(id)
    const game = db.prepare('SELECT * FROM games WHERE match_id=?').get(id)
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(id)
    if (!frame && !game && !a) return res.status(404).json({ error: 'no such game' })
    const mapKey = (frame && frame.state.map) || (game && game.map_key) || (a && a.map_key) || null
    res.json({
      match_id: id,
      frame,
      // A game that has ENDED still resolves here, and says so rather than 404ing: a
      // spectator watching the last round should land on the result, not on a dead page.
      ended: game ? results.project(game) : null,
      state: frame ? 'live' : game ? 'ended' : a ? String(a.state) : 'unknown',
      map: mapKey ? maps.project(maps.byKey(mapKey), { me: req.me ? req.me.steam_id : null }) : null,
      // The manifest's signals, so the view can say WHICH of them have fired rather than
      // printing the raw ids the box sends.
      signal_labels: mapKey ? signalLabels(mapKey) : {},
    })
  })

  // ---- global chat --------------------------------------------------------------
  r.get('/chat', (req, res) => res.json({ chat: chat.tail(Number(req.query.limit || 40)), latest: chat.latest() }))

  r.post('/chat', requireUser, (req, res) => {
    const text = (req.body && req.body.text) || ''
    if (!text) return res.status(400).json({ error: 'no text' })
    // origin 'web' is nobody's box, so every box picks it up on its next drain.
    const line = chat.push({ from: users.pub(req.me).name, text, steamId: req.me.steam_id, origin: 'web' })
    res.json({ ok: true, line })
  })

  // ---- reports -----------------------------------------------------------------------
  r.post('/report', requireUser, (req, res) => {
    const bansLib = require('../lib/bans')
    const b = req.body || {}
    if (!b.kind) return res.status(400).json({ error: 'what kind of report?' })
    res.json(bansLib.report({
      kind: String(b.kind), subject: b.subject != null ? String(b.subject) : null,
      reporter: req.me.steam_id, reported: b.reported ? String(b.reported) : null,
      reason: b.reason || null, detail: b.detail || null,
    }))
  })

  r.delete('/comments/:id', requireUser, (req, res) => {
    const out = require('../lib/comments').remove(Number(req.params.id), req.me.steam_id, { moderator: !!(req.me.is_mod || req.me.is_admin) })
    res.status(out.ok ? 200 : 403).json(out)
  })

  // ---- search (the one box) ---------------------------------------------------------
  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ maps: [], players: [] })
    const me = req.me ? req.me.steam_id : null
    res.json({
      maps: maps.list({ q, limit: 8, me }).maps,
      players: db.prepare(`SELECT * FROM users WHERE deleted=0 AND (lower(enw_name) LIKE ? OR lower(username) LIKE ?) LIMIT 6`)
        .all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`).map(users.pub),
    })
  })

  return r
}

// `signal_id -> human label`, read from the map's referee manifest. The box reports
// `power_on`; the manifest calls it "Power turned on"; the live view should say the second.
function signalLabels(mapKey) {
  const m = db.prepare(`SELECT mf.json FROM manifests mf JOIN map_versions v ON v.id=mf.map_version_id
                         JOIN maps mp ON mp.id=v.map_id WHERE mp.key=? AND v.latest=1`).get(String(mapKey))
  const j = m ? safeJson(m.json, {}) : {}
  const out = {}
  for (const s of (j && j.signals) || []) if (s && s.id) out[s.id] = s.label || s.id
  for (const f of (j && j.finishes) || []) if (f && f.id) out[f.id] = f.label || f.id
  return out
}

// 13 §4c. Defaults are WaW's stock values; the ranges are wide but capped, and anything
// beyond them is what the host console is for.
const KNOB_GROUPS = [
  { key: 'start', label: 'Start', knobs: [
    { key: 'round', label: 'Starting round', type: 'int', min: 1, max: 255, default: 1 },
    { key: 'points', label: 'Starting points', type: 'int', min: 0, max: 1000000, default: 500 },
  ] },
  { key: 'perks', label: 'Perks & power', knobs: [
    { key: 'all_perks', label: 'Start with all perks', type: 'bool', default: false },
    { key: 'power_on', label: 'Power on from the start', type: 'bool', default: false },
    { key: 'no_limit', label: 'Perk limit off', type: 'bool', default: false },
  ] },
  { key: 'box', label: 'Box & weapons', knobs: [
    { key: 'starting_weapon', label: 'Starting weapon', type: 'string', default: null },
    { key: 'pap_cost', label: 'Pack-a-Punch cost', type: 'int', min: 0, max: 20000, default: 5000 },
    { key: 'infinite_ammo', label: 'Infinite ammo', type: 'bool', default: false },
  ] },
  { key: 'zombies', label: 'Zombies', knobs: [
    { key: 'health', label: 'Health multiplier', type: 'float', min: 0.1, max: 10, default: 1 },
    { key: 'speed', label: 'Speed', type: 'enum', options: ['walk', 'run', 'sprint'], default: null },
    { key: 'max_alive', label: 'Max alive', type: 'int', min: 1, max: 64, default: 24 },
    { key: 'dogs', label: 'Dog rounds', type: 'bool', default: true },
  ] },
  { key: 'powerups', label: 'Powerups & drops', knobs: [
    { key: 'drop_rate', label: 'Drop rate', type: 'float', min: 0, max: 5, default: 1 },
    { key: 'max_ammo_every', label: 'Max ammo frequency', type: 'int', min: 0, max: 20, default: 0 },
  ] },
  { key: 'players', label: 'Player rules', knobs: [
    { key: 'downs', label: 'Downs allowed', type: 'int', min: 0, max: 99, default: 3 },
    { key: 'bleedout', label: 'Bleedout time (s)', type: 'int', min: 5, max: 300, default: 45 },
    { key: 'revive_speed', label: 'Revive speed', type: 'float', min: 0.1, max: 5, default: 1 },
    { key: 'friendly_fire', label: 'Friendly fire', type: 'bool', default: false },
    { key: 'respawn_each_round', label: 'Respawn each round', type: 'bool', default: true },
  ] },
  { key: 'speed', label: 'Game speed & gravity', knobs: [
    { key: 'timescale', label: 'Timescale', type: 'float', min: 0.25, max: 4, default: 1 },
    { key: 'g_speed', label: 'Player speed', type: 'int', min: 50, max: 500, default: 190 },
    { key: 'jump_height', label: 'Jump height', type: 'int', min: 10, max: 512, default: 39 },
    { key: 'gravity', label: 'Gravity', type: 'int', min: 50, max: 1600, default: 800 },
  ] },
  { key: 'console', label: 'Console', knobs: [
    { key: 'host_console', label: 'Host gets the dev console', type: 'bool', default: true },
  ] },
]

module.exports = { router, KNOB_GROUPS }
