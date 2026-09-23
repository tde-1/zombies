'use strict'

// `/api/admin` — the operator console's API.
//
// 2026-09-23, "admin: parity with Movement and beyond" (web.md). Movement's console is
// Now / Log / People / Maps / Reports / Mode home; ours has those plus the Zombies-only
// surfaces: boxes and their leases, the beta gate, the map catalogue flags, playlists,
// guides, results with flags, chat, and what is released.
//
// AUTH. Every route carries requireMod or requireAdmin itself (test/admin.js walks this
// router and fails on a route that carries neither). Mods moderate: reports, bans, chat,
// guides, maps, playlists, the log. Admins run the site: roles, boxes, leases, release,
// badges, collections.
//
// AUDIT. Every successful write lands in `activity_log` with the actor. Routes that know
// what they did say so (`audit(req, 'playlist.update', …)`); anything that forgets is
// caught by adminLog.guard() and logged as `admin.action` with its path and body.

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
const guides = require('../lib/guides')
const chat = require('../lib/chatNetwork')
const adminLog = require('../lib/adminLog')
const adminBoxes = require('../lib/adminBoxes')
const release = require('../lib/release')
const { safeJson, slugify } = require('../lib/util')
const { db, now } = require('../db/database')
const { requireMod, requireAdmin } = require('../middleware/auth')

const { audit } = adminLog
const isSteam = (s) => /^7656119\d{10}$/.test(String(s || ''))
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})
const page = (req, size = 50) => {
  const n = Math.max(1, Math.min(200, Number(req.query.size) || size))
  const p = Math.max(1, Number(req.query.page) || 1)
  return { n, p, off: (p - 1) * n }
}
const HEALTH = ['verified', 'playable', 'custom-only', 'broken', 'catalogued']

function router() {
  const r = express.Router()
  r.use(adminLog.guard())

  // ---- Now: the overview and the to-do strip ------------------------------------------
  r.get('/', requireMod, (req, res) => {
    const list = boxes.list()
    const weekAgo = now() - 7 * 86400_000
    const flagged = db.prepare("SELECT COUNT(*) c FROM games WHERE received_at >= ? AND flags IS NOT NULL AND flags <> '[]'").get(weekAgo).c
    res.json({
      counts: {
        ...bans.counts(),
        users: db.prepare('SELECT COUNT(*) c FROM users WHERE deleted=0').get().c,
        waiting: db.prepare('SELECT COUNT(*) c FROM users WHERE approved=0 AND deleted=0').get().c,
        maps: maps.count(),
        games: db.prepare('SELECT COUNT(*) c FROM games').get().c,
        records: db.prepare('SELECT COUNT(*) c FROM records WHERE current=1').get().c,
        playlists: db.prepare("SELECT COUNT(*) c FROM playlists WHERE state='live'").get().c,
        flagged_7d: flagged,
        guides_hidden: db.prepare("SELECT COUNT(*) c FROM map_guides WHERE state='hidden'").get().c,
        live_leases: db.prepare("SELECT COUNT(*) c FROM assignments WHERE state IN ('leased','ready','live')").get().c,
        boxes_online: list.filter((b) => b.online).length,
        boxes: list.length,
      },
      boxes: list,
      presence: presence.stats(),
      enw: enw.status(),
      sweeps: { achievements: achievements.lastSweep() },
      recent_activity: db.prepare('SELECT * FROM activity_log ORDER BY logged_at DESC LIMIT 40').all(),
      // A box whose replay key changed is the loudest thing on this page for a reason.
      key_warnings: list.filter((b) => b.key.pending),
      release: (() => { try { const f = release.feed(); return { version: f.version || null, published: f.published } } catch { return null } })(),
    })
  })

  // ---- Log ------------------------------------------------------------------------
  r.get('/log', requireMod, (req, res) => {
    const q = req.query
    res.json(adminLog.read({ q: q.q || '', lane: q.lane || '', actor: q.actor || '', window: q.window || 'all', before: q.before || 0, limit: q.limit || 60 }))
  })
  r.get('/log/counts', requireMod, (req, res) => res.json({ counts: adminLog.counts({ window: req.query.window || '7d' }), lanes: adminLog.LANE_KEYS }))

  // ---- People ---------------------------------------------------------------------
  // filter: all | waiting | approved | staff | banned | nameless
  r.get('/users', requireMod, (req, res) => {
    const { n, p, off } = page(req)
    const where = ['u.deleted=0']
    const vals = []
    const q = String(req.query.q || '').trim()
    if (q) { where.push('(u.steam_id LIKE ? OR u.enw_name LIKE ? OR u.username LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    const f = String(req.query.filter || 'all')
    if (f === 'waiting') where.push('u.approved=0')
    else if (f === 'approved') where.push('u.approved=1')
    else if (f === 'staff') where.push('(u.is_admin=1 OR u.is_mod=1 OR u.is_archivist=1)')
    else if (f === 'nameless') where.push('u.enw_name IS NULL')
    else if (f === 'banned') {
      where.push('EXISTS (SELECT 1 FROM bans b WHERE b.steam_id=u.steam_id AND b.active=1 AND (b.expires_at IS NULL OR b.expires_at > ?))')
      vals.push(now())
    }
    const SORT = { name: 'COALESCE(u.enw_name, u.steam_id) COLLATE NOCASE', created: 'u.created_at', seen: 'u.last_seen', level: 'u.xp_total', games: 'games' }
    const sort = SORT[req.query.sort] || SORT.seen
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC'
    const W = where.join(' AND ')
    const total = db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${W}`).get(...vals).c
    const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM game_players gp WHERE gp.steam_id=u.steam_id) games,
                               (SELECT COUNT(*) FROM bans b WHERE b.steam_id=u.steam_id AND b.active=1) bans
                               FROM users u WHERE ${W} ORDER BY ${sort} ${dir}, u.steam_id LIMIT ? OFFSET ?`).all(...vals, n, off)
    res.json({
      total, page: p, size: n,
      users: rows.map((u) => ({ ...users.pub(u), games: u.games, bans: u.bans, persona: u.username || null, online: presence.isOnline(u.steam_id) })),
    })
  })

  r.get('/player/:who', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    res.json({
      player: { ...users.pub(u), persona: u.username || null, online: presence.isOnline(u.steam_id), where: presence.whereabouts(u.steam_id) },
      infractions: bans.infractionsFor(u.steam_id),
      bans: bans.bansFor(u.steam_id),
      badges: badges.forPlayer(u.steam_id),
      games: require('../lib/results').recent({ steamId: u.steam_id, limit: 25 }),
      activity: adminLog.read({ actor: u.steam_id, limit: 30 }).rows,
    })
  })

  r.post('/player/:who/infract', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const b = body(req)
    const out = bans.infract({ steamId: u.steam_id, kind: bans.KINDS.includes(b.kind) ? b.kind : 'other', note: b.note || null, by: req.me.steam_id })
    audit(req, 'infraction.add', { steam_id: u.steam_id, kind: b.kind || 'other', note: b.note || null })
    res.json(out)
  })

  r.post('/player/:who/ban', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    if (u.steam_id === req.me.steam_id) return res.status(400).json({ error: 'not yourself' })
    if (u.is_admin && !req.me.is_admin) return res.status(403).json({ error: 'a moderator cannot ban an admin' })
    const b = body(req)
    // Griefing is a public-play ban by default (05). The moderator can override, but the
    // default is the policy so nobody has to remember it.
    const scope = b.scope === 'public' || b.scope === 'site' ? b.scope : (b.kind === 'griefing' ? 'public' : 'site')
    res.json(bans.ban({
      steamId: u.steam_id, scope, reason: b.reason || null,
      cheating: !!b.cheating || b.kind === 'cheating',
      by: req.me.steam_id, expiresAt: b.expires_at || null,
    }))
  })

  r.get('/bans', requireMod, (req, res) => {
    const active = req.query.active !== '0'
    const rows = db.prepare(`SELECT * FROM bans ${active ? 'WHERE active=1 AND (expires_at IS NULL OR expires_at > ?)' : ''} ORDER BY created_at DESC LIMIT 300`)
      .all(...(active ? [now()] : []))
    res.json({ bans: rows.map((b) => ({ ...b, cheating: !!b.cheating, active: !!b.active, player: users.publicById(b.steam_id), by: isSteam(b.by_steam) ? users.publicById(b.by_steam) : null })) })
  })

  r.post('/ban/:id/lift', requireMod, (req, res) => res.json(bans.unban(Number(req.params.id), req.me.steam_id)))

  // THE BETA GATE. Steam is the only sign-in; `approved` is who may play. One or many, by
  // SteamID64, including accounts that have never signed in (tools/approve.js did this from
  // a shell; it runs the same statements). `approved:false` takes it back.
  r.post('/approve', requireMod, (req, res) => {
    const b = body(req)
    const ids = [...new Set((Array.isArray(b.steam_ids) ? b.steam_ids : [b.steam_id]).map((s) => String(s || '').trim()).filter(Boolean))]
    if (!ids.length) return res.status(400).json({ error: 'which SteamID64?' })
    const bad = ids.filter((s) => !isSteam(s))
    if (bad.length) return res.status(400).json({ error: `not a SteamID64: ${bad.slice(0, 3).join(', ')}` })
    const on = b.approved === false ? 0 : 1
    for (const sid of ids) {
      users.ensure(sid)
      db.prepare('UPDATE users SET approved=? WHERE steam_id=?').run(on, sid)
    }
    audit(req, on ? 'user.approve' : 'user.unapprove', { steam_ids: ids })
    res.json({ ok: true, count: ids.length })
  })

  r.post('/player/:who/approve', requireMod, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const on = body(req).approved === false ? 0 : 1
    db.prepare('UPDATE users SET approved=? WHERE steam_id=?').run(on, u.steam_id)
    audit(req, on ? 'user.approve' : 'user.unapprove', { steam_id: u.steam_id })
    res.json({ ok: true })
  })

  // The ONLY rename (2026-09-23, lib/names.js). Set-once for players; an admin can fix a
  // typo or free a name.
  r.post('/player/:who/username', requireAdmin, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const out = require('../lib/names').rename(u.steam_id, body(req).username || '', req.me.steam_id)
    if (!out.ok) return res.status(out.reason === 'taken' ? 409 : 400).json({ error: out.error, reason: out.reason })
    res.json({ ok: true, name: out.name, from: out.from, user: users.publicById(u.steam_id) })
  })

  r.get('/waitlist', requireMod, (req, res) => {
    res.json({ users: db.prepare('SELECT * FROM users WHERE approved=0 AND deleted=0 ORDER BY created_at').all().map(users.pub) })
  })

  // Movement's rule: nobody changes their own standing, and the last admin stays an admin.
  r.post('/player/:who/role', requireAdmin, (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const b = body(req)
    if (u.steam_id === req.me.steam_id && b.admin === false) return res.status(400).json({ error: 'you cannot remove your own admin' })
    if (b.admin === false && u.is_admin && db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin=1 AND deleted=0').get().c <= 1) {
      return res.status(400).json({ error: 'that is the last admin' })
    }
    const changed = {}
    for (const [k, col] of [['admin', 'is_admin'], ['mod', 'is_mod'], ['archivist', 'is_archivist'], ['vip', 'vip_is']]) {
      if (b[k] !== undefined) { db.prepare(`UPDATE users SET ${col}=? WHERE steam_id=?`).run(b[k] ? 1 : 0, u.steam_id); changed[k] = !!b[k] }
    }
    audit(req, 'user.role', { steam_id: u.steam_id, ...changed })
    res.json({ ok: true, player: users.publicById(u.steam_id) })
  })

  // ---- Reports --------------------------------------------------------------------
  r.get('/reports', requireMod, (req, res) => {
    const status = String(req.query.status || 'new')
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM reports GROUP BY status').all().map((x) => [x.status, x.c]))
    res.json({ reports: bans.queue(status), counts })
  })

  r.post('/reports/:id/resolve', requireMod, (req, res) => {
    const b = body(req)
    const status = ['closed', 'actioned', 'dismissed', 'new', 'looking'].includes(b.status) ? b.status : 'closed'
    const out = bans.resolve(Number(req.params.id), { status, note: b.note || null, by: req.me.steam_id })
    audit(req, 'report.resolve', { id: Number(req.params.id), status, note: b.note || null })
    res.json(out)
  })

  // ---- Records --------------------------------------------------------------------
  // 99 §4.9: "record review with the replay". The row, the game, the roster and the replay
  // pointer in one payload, plus whether the replay's signing key matched the box's pin.
  r.get('/records/review', requireMod, (req, res) => {
    const rows = db.prepare(`SELECT r.*, b.map_key, b.category, b.player_count, b.profile, g.match_id, g.mode, g.ended_at
                               FROM records r JOIN boards b ON b.id=r.board_id LEFT JOIN games g ON g.id=r.game_id
                              WHERE r.current=1 ORDER BY r.created_at DESC LIMIT 200`).all()
    res.json({
      records: rows.map((r2) => {
        const replay = r2.game_id ? db.prepare('SELECT * FROM replays WHERE game_id=?').get(r2.game_id) : null
        return {
          id: r2.id, map_key: r2.map_key, category: r2.category, player_count: r2.player_count,
          profile: r2.profile, round: r2.round, value_ms: r2.value_ms, at: r2.created_at,
          profile_ok: !!r2.profile_ok, profile_note: r2.profile_note, verified: !!r2.verified,
          match_id: r2.match_id, mode: r2.mode, game_id: r2.game_id,
          players: (JSON.parse(r2.roster || '[]')).map((s) => users.publicById(s)).filter(Boolean),
          replay: replay ? replays.describe(replay.match_id, req.me) : null,
        }
      }),
    })
  })

  // Verify the actual file against the box's PINNED key.
  r.post('/records/:id/verify', requireMod, async (req, res) => {
    const rec = db.prepare('SELECT * FROM records WHERE id=?').get(Number(req.params.id))
    if (!rec) return res.status(404).json({ error: 'no such record' })
    const g = rec.game_id ? db.prepare('SELECT match_id FROM games WHERE id=?').get(rec.game_id) : null
    if (!g) return res.status(404).json({ error: 'that record has no game attached' })
    const out = await replays.verify(g.match_id)
    audit(req, 'record.verify', { id: rec.id, match_id: g.match_id, ok: !!out.ok })
    res.json(out)
  })

  r.post('/records/:id/void', requireMod, (req, res) => {
    const rec = db.prepare('SELECT id FROM records WHERE id=?').get(Number(req.params.id))
    if (!rec) return res.status(404).json({ error: 'no such record' })
    db.prepare('UPDATE records SET verified=0, current=0 WHERE id=?').run(rec.id)
    audit(req, 'record.void', { id: rec.id, note: body(req).note || null })
    mapRecords.sweep()
    res.json({ ok: true })
  })

  // ---- Games: results and their flags ---------------------------------------------
  // The referee's flags (result_mismatch, instance_retired, frames_only, ...) are the
  // reasons a result may not be what it looks like. Filter by one, read the summary.
  r.get('/games', requireMod, (req, res) => {
    const { n, p, off } = page(req)
    const where = []
    const vals = []
    const flag = String(req.query.flag || '')
    if (flag === 'any') where.push("g.flags IS NOT NULL AND g.flags <> '[]'")
    else if (flag) { where.push('EXISTS (SELECT 1 FROM json_each(g.flags) j WHERE j.value = ?)'); vals.push(flag) }
    const q = String(req.query.q || '').trim()
    if (q) { where.push('(g.match_id LIKE ? OR g.map_key LIKE ? OR g.box LIKE ? OR EXISTS (SELECT 1 FROM game_players gp LEFT JOIN users u ON u.steam_id=gp.steam_id WHERE gp.game_id=g.id AND (gp.steam_id LIKE ? OR u.enw_name LIKE ?)))'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) }
    if (req.query.mode) { where.push('g.mode = ?'); vals.push(String(req.query.mode)) }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM games g ${W}`).get(...vals).c
    const rows = db.prepare(`SELECT g.id, g.match_id, g.box, g.instance, g.mode, g.map_key, g.rounds, g.player_count, g.flags, g.end_reason,
                               g.records_eligible, g.self_reported, g.started_at, g.ended_at, g.received_at, g.finish_label, m.title map_title,
                               (SELECT key_pinned FROM replays rp WHERE rp.game_id=g.id) key_pinned
                               FROM games g LEFT JOIN maps m ON m.key=g.map_key ${W}
                              ORDER BY COALESCE(g.ended_at, g.received_at) DESC LIMIT ? OFFSET ?`).all(...vals, n, off)
    const flags = db.prepare("SELECT j.value flag, COUNT(*) c FROM games g, json_each(g.flags) j WHERE g.flags IS NOT NULL AND json_valid(g.flags) GROUP BY j.value ORDER BY c DESC").all()
    res.json({
      total, page: p, size: n, flags,
      games: rows.map((g) => ({
        ...g, flags: safeJson(g.flags, []) || [], records_eligible: !!g.records_eligible, self_reported: !!g.self_reported,
        key_pinned: g.key_pinned == null ? null : !!g.key_pinned,
        players: db.prepare('SELECT steam_id, name FROM game_players WHERE game_id=? ORDER BY slot').all(g.id).map((x) => {
          const u = users.publicById(x.steam_id)
          return { steam_id: x.steam_id, name: (u && u.enw_name) || x.name || x.steam_id }
        }),
      })),
    })
  })

  r.get('/games/:id', requireMod, (req, res) => {
    const g = db.prepare('SELECT * FROM games WHERE id=?').get(Number(req.params.id))
    if (!g) return res.status(404).json({ error: 'no such game' })
    res.json({ game: { ...g, flags: safeJson(g.flags, []), summary: safeJson(g.summary_json, null), summary_json: undefined } })
  })

  // ---- Chat -------------------------------------------------------------------------
  // The global channel (chat_network): every line, removed ones included, newest first.
  // Party lines and DMs are private and are not listed here.
  r.get('/chat', requireMod, (req, res) => {
    const where = []
    const vals = []
    const q = String(req.query.q || '').trim()
    if (q) { where.push('(text LIKE ? OR from_name LIKE ? OR steam_id = ?)'); vals.push(`%${q}%`, `%${q}%`, q) }
    if (req.query.origin) { where.push('origin = ?'); vals.push(String(req.query.origin)) }
    if (req.query.removed === '1') where.push('removed = 1')
    if (req.query.kind) { where.push('kind = ?'); vals.push(String(req.query.kind)) }
    if (Number(req.query.before) > 0) { where.push('id < ?'); vals.push(Number(req.query.before)) }
    const n = Math.max(1, Math.min(200, Number(req.query.limit) || 80))
    const rows = db.prepare(`SELECT * FROM chat_network ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...vals, n + 1)
    const origins = db.prepare('SELECT origin, COUNT(*) c FROM chat_network GROUP BY origin ORDER BY c DESC').all()
    res.json({
      lines: rows.slice(0, n).map((x) => ({ id: x.id, at: x.at, origin: x.origin, kind: x.kind, from: x.from_name, steam_id: x.steam_id, text: x.text, map: x.map_key, removed: !!x.removed })),
      more: rows.length > n, next: rows.length > n ? rows[n - 1].id : null, origins,
    })
  })

  r.post('/chat/:id/remove', requireMod, (req, res) => {
    const row = db.prepare('SELECT id FROM chat_network WHERE id=?').get(Number(req.params.id))
    if (!row) return res.status(404).json({ error: 'no such line' })
    chat.remove(row.id, req.me.steam_id)
    res.json({ ok: true })
  })

  r.post('/chat/:id/restore', requireMod, (req, res) => {
    const row = db.prepare('SELECT id FROM chat_network WHERE id=?').get(Number(req.params.id))
    if (!row) return res.status(404).json({ error: 'no such line' })
    db.prepare('UPDATE chat_network SET removed=0 WHERE id=?').run(row.id)
    audit(req, 'chat.restore', { id: row.id })
    res.json({ ok: true })
  })

  // ---- Maps: the catalogue ----------------------------------------------------------
  r.get('/maps', requireMod, (req, res) => {
    const { n, p, off } = page(req)
    const where = []
    const vals = []
    const q = String(req.query.q || '').trim()
    if (q) { where.push('(m.key LIKE ? OR m.title LIKE ? OR m.author LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    if (req.query.health && HEALTH.includes(req.query.health)) { where.push('m.health = ?'); vals.push(req.query.health) }
    else if (req.query.health !== 'all') where.push("m.health <> 'catalogued'")
    if (req.query.hidden === '1') where.push('m.hidden = 1')
    if (req.query.source) { where.push('m.source = ?'); vals.push(String(req.query.source)) }
    const SORT = { title: 'm.title COLLATE NOCASE', key: 'm.key', plays: 'm.plays', added: 'm.added_at', health: 'm.health', year: 'm.year' }
    const sort = SORT[req.query.sort] || SORT.title
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC'
    const W = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM maps m ${W}`).get(...vals).c
    const rows = db.prepare(`SELECT m.* FROM maps m ${W} ORDER BY ${sort} ${dir}, m.key LIMIT ? OFFSET ?`).all(...vals, n, off)
    const counts = Object.fromEntries(db.prepare('SELECT health, COUNT(*) c FROM maps GROUP BY health').all().map((x) => [x.health, x.c]))
    counts.hidden = db.prepare('SELECT COUNT(*) c FROM maps WHERE hidden=1').get().c
    const inRows = (key) => db.prepare('SELECT c.name FROM collection_maps cm JOIN collections c ON c.id=cm.collection_id WHERE cm.map_key=?').all(key).map((x) => x.name)
    const inLists = (key) => db.prepare('SELECT p.name FROM playlist_maps pm JOIN playlists p ON p.id=pm.playlist_id WHERE pm.map_key=?').all(key).map((x) => x.name)
    res.json({
      total, page: p, size: n, counts, week: mapWeek.current(),
      maps: rows.map((m) => ({
        key: m.key, title: m.title, author: m.author, year: m.year, source: m.source, health: m.health, hidden: !!m.hidden,
        plays: m.plays || 0, added_at: m.added_at, server: maps.serverLevel ? maps.serverLevel(m) : null,
        guides: db.prepare("SELECT COUNT(*) c FROM map_guides WHERE map_key=? AND state='live'").get(m.key).c,
        rows: inRows(m.key), playlists: inLists(m.key),
      })),
    })
  })

  r.post('/map-of-week', requireMod, (req, res) => {
    const b = body(req)
    if (!b.map_key || !maps.byKey(b.map_key)) return res.status(400).json({ error: 'which map?' })
    const week = mapWeek.set(b.map_key, { note: b.note || null, by: req.me.steam_id })
    audit(req, 'week.set', { map: b.map_key, note: b.note || null })
    res.json({ ok: true, week })
  })

  r.post('/maps/:key', requireMod, (req, res) => {
    const m = maps.byKey(req.params.key)
    if (!m) return res.status(404).json({ error: 'no such map' })
    const b = body(req)
    if (b.health !== undefined && !HEALTH.includes(b.health)) return res.status(400).json({ error: `health is ${HEALTH.join(', ')}` })
    if (b.hidden !== undefined) b.hidden = b.hidden ? 1 : 0
    const fields = ['title', 'author', 'year', 'health', 'hidden', 'description', 'readme', 'release_post', 'art', 'round_n']
    const sets = []
    const vals = []
    const changed = {}
    for (const f of fields) if (b[f] !== undefined && b[f] !== m[f]) { sets.push(`${f}=?`); vals.push(b[f]); changed[f] = { from: m[f], to: b[f] } }
    if (sets.length) {
      db.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE id=?`).run(...vals, m.id)
      audit(req, 'map.edit', { map: m.key, changed })
    }
    res.json({ ok: true, map: maps.detail(m.key) })
  })

  // Easter egg / power / song guides (lib/guides.js). Weakest first; hide is reversible;
  // delete leaves a tombstone the importer respects.
  r.get('/guides', requireMod, (req, res) => res.json(guides.adminList({ state: req.query.state ? String(req.query.state) : null })))
  r.post('/guides/:id', requireMod, (req, res) => {
    const out = guides.setState(Number(req.params.id), String(body(req).state || ''), req.me.steam_id)
    res.status(out.ok ? 200 : out.error === 'no such guide' ? 404 : 400).json(out)
  })

  // ---- Playlists --------------------------------------------------------------------
  r.get('/playlists', requireMod, (req, res) => res.json({ playlists: playlists.all() }))

  const PL_STATES = ['live', 'hidden', 'scheduled']
  const plCheck = (b) => {
    if (b.state !== undefined && !PL_STATES.includes(b.state)) return `state is ${PL_STATES.join(', ')}`
    if (b.maps !== undefined) {
      if (!Array.isArray(b.maps)) return 'maps is a list of map keys'
      const bad = playlists.unknownKeys(b.maps)
      if (bad.length) return `no such map: ${bad.slice(0, 3).join(', ')}`
    }
    return null
  }

  r.post('/playlists', requireMod, (req, res) => {
    const b = body(req)
    if (!b.name) return res.status(400).json({ error: 'name it' })
    const slug = slugify(b.slug || b.name)
    const err = plCheck(b)
    if (err) return res.status(400).json({ error: err })
    if (db.prepare('SELECT 1 FROM playlists WHERE slug=?').get(slug)) return res.status(409).json({ error: `/${slug} is taken` })
    const kind = b.kind === 'creator' ? 'creator' : 'curated'
    const pl = playlists.create({ slug, name: String(b.name).slice(0, 80), blurb: b.blurb || null, kind, creator: kind === 'creator' ? (b.creator || null) : null, state: b.state || 'hidden', rewardBadge: b.reward_badge || 0, by: req.me.steam_id })
    if (b.sort_order !== undefined) playlists.update(pl.id, { sort_order: Number(b.sort_order) || 0 })
    if (Array.isArray(b.maps)) playlists.setMaps(pl.id, b.maps)
    audit(req, 'playlist.create', { id: pl.id, slug, maps: Array.isArray(b.maps) ? b.maps.length : 0 })
    res.json({ ok: true, playlist: playlists.all().find((x) => x.id === pl.id) })
  })

  r.put('/playlists/:id', requireMod, (req, res) => {
    const pl = playlists.byId(req.params.id)
    if (!pl) return res.status(404).json({ error: 'no such playlist' })
    const b = body(req)
    const err = plCheck(b)
    if (err) return res.status(400).json({ error: err })
    const patch = {}
    for (const k of ['name', 'blurb', 'state', 'sort_order', 'reward_badge', 'live_from']) if (b[k] !== undefined) patch[k] = b[k]
    if (Object.keys(patch).length) playlists.update(pl.id, patch)
    if (Array.isArray(b.maps)) playlists.setMaps(pl.id, b.maps)
    audit(req, 'playlist.update', { id: pl.id, slug: pl.slug, ...patch, ...(Array.isArray(b.maps) ? { maps: b.maps.length } : {}) })
    res.json({ ok: true, playlist: playlists.all().find((x) => x.id === pl.id) })
  })

  r.delete('/playlists/:id', requireAdmin, (req, res) => {
    const out = playlists.remove(req.params.id)
    if (!out.ok) return res.status(404).json(out)
    audit(req, 'playlist.delete', { id: Number(req.params.id), slug: out.slug })
    res.json(out)
  })

  // ---- Boxes ------------------------------------------------------------------------
  r.get('/boxes', requireAdmin, (req, res) => res.json({ boxes: boxes.list() }))
  r.get('/boxes/live', requireAdmin, (req, res) => res.json({ boxes: adminBoxes.detail(), at: now() }))

  // Box CREATION stays in tools/register-box.js: it mints the shared secret, and a secret
  // shown in a browser is a secret in a screenshot. This route is kept for API parity.
  r.post('/boxes', requireAdmin, (req, res) => {
    const b = body(req)
    if (!b.name || !b.match_key) return res.status(400).json({ error: 'name and match_key' })
    const box = boxes.create({ name: b.name, matchKey: b.match_key, region: b.region, note: b.note, maxInstances: b.max_instances || 4 })
    audit(req, 'box.create', { name: b.name })
    res.json({ ok: true, box: { id: box.id, name: box.name } })
  })

  // { max_instances: 3 }   { reserve: 1 }   { reserve: null }  (null = the default)
  r.post('/boxes/:name/capacity', requireAdmin, (req, res) => {
    const b = body(req)
    try {
      const box = boxes.setCapacity(req.params.name, { maxInstances: b.max_instances, reserve: b.reserve })
      if (!box) return res.status(404).json({ error: 'no such box' })
      audit(req, 'box.capacity', { box: box.name, max_instances: b.max_instances, reserve: b.reserve })
      res.json({ ok: true, box: boxes.list().find((x) => x.name === box.name), capacity: assignments.capacity(box) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  r.post('/boxes/:name/address', requireAdmin, (req, res) => {
    if (!boxes.byName(req.params.name)) return res.status(404).json({ error: 'no such box' })
    try {
      const box = boxes.setAddress(req.params.name, body(req).address)
      audit(req, 'box.address', { box: box.name, address: box.address })
      res.json({ ok: true, address: box.address })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  r.post('/boxes/:id/enabled', requireAdmin, (req, res) => {
    const box = boxes.setEnabled(req.params.id, !!body(req).enabled)
    if (!box) return res.status(404).json({ error: 'no such box' })
    audit(req, box.enabled ? 'box.enable' : 'box.disable', { box: box.name })
    res.json({ ok: true, box: { id: box.id, name: box.name, enabled: !!box.enabled } })
  })
  r.post('/boxes/:id/key/accept', requireAdmin, (req, res) => res.json(boxes.acceptPendingKey(req.params.id, req.me.steam_id)))
  r.post('/boxes/:id/key/reject', requireAdmin, (req, res) => res.json(boxes.rejectPendingKey(req.params.id, req.me.steam_id)))

  // Retire / restart one lease. 409 with the names while anybody is connected, until the
  // request carries `confirm` = exactly those SteamIDs (lib/adminBoxes.js).
  r.post('/leases/:matchId/retire', requireAdmin, (req, res) => {
    const out = adminBoxes.retire(req.params.matchId, { confirm: body(req).confirm, by: req.me.steam_id })
    if (out.status === 200) audit(req, 'lease.retire', { match_id: req.params.matchId, kicked: (out.body.kicked || []).map((p) => p.steam_id) })
    res.status(out.status).json(out.body)
  })
  r.post('/leases/:matchId/restart', requireAdmin, (req, res) => {
    const out = adminBoxes.restart(req.params.matchId, { confirm: body(req).confirm, by: req.me.steam_id })
    if (out.status === 200) audit(req, 'lease.restart', { from: req.params.matchId, to: out.body.match_id, kicked: (out.body.kicked || []).map((p) => p.steam_id) })
    res.status(out.status).json(out.body)
  })

  // Lease a game by hand: the same lease() the party rail calls.
  r.post('/lease', requireAdmin, (req, res) => {
    const b = body(req)
    const out = assignments.lease({
      box: b.box ? boxes.byName(b.box) : null,
      mapKey: b.map || b.map_key,
      mode: b.mode || 'verified',
      players: b.players || [{ steamid: req.me.steam_id }],
      settings: b.settings || {},
      // An operator's test lease is an agent lease unless they say otherwise: it may use
      // the reserve, and a real player's Play takes its slot back.
      agent: b.agent !== false,
      by: req.me.steam_id,
    })
    res.status(out.ok ? 200 : 400).json(out)
  })

  r.post('/lease/:matchId/cancel', requireAdmin, (req, res) => {
    // The old cancel is the guarded retire now: it would otherwise end a game with people
    // in it on one click.
    const out = adminBoxes.retire(req.params.matchId, { confirm: body(req).confirm, by: req.me.steam_id })
    res.status(out.status).json(out.body)
  })

  // ---- Release ----------------------------------------------------------------------
  r.get('/release', requireAdmin, (req, res) => res.json(release.status()))
  r.post('/release/box/:name', requireAdmin, (req, res) => {
    if (!boxes.byName(req.params.name)) return res.status(404).json({ error: 'no such box' })
    const out = release.setNote(req.params.name, body(req), req.me.steam_id)
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'box.dll', { box: req.params.name, sha256: out.noted.sha256, commit: out.noted.commit })
    res.json(out)
  })

  // ---- Badges -----------------------------------------------------------------------
  r.get('/badges', requireMod, (req, res) => res.json({ badges: badges.list({ includeRetired: true }) }))

  r.post('/badges', requireAdmin, (req, res) => {
    const b = body(req)
    if (!b.name) return res.status(400).json({ error: 'name it' })
    const slug = b.slug || slugify(b.name)
    if (badges.bySlug(slug)) return res.status(409).json({ error: `/${slug} is taken` })
    const badge = badges.create({ ...b, kind: 'staff', slug, createdBy: req.me.steam_id })
    audit(req, 'badge.create', { slug })
    res.json({ ok: true, badge })
  })

  r.put('/badges/:id', requireAdmin, (req, res) => {
    const out = badges.update(Number(req.params.id), body(req))
    audit(req, 'badge.update', { id: Number(req.params.id), patch: body(req) })
    res.json({ ok: true, badge: out })
  })

  r.get('/badges/:id/holders', requireMod, (req, res) => {
    const b = badges.get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such badge' })
    res.json({ badge: b, holders: badges.holders(b.id, 200) })
  })

  r.post('/badges/:id/award', requireAdmin, (req, res) => {
    const b = badges.get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such badge' })
    // An achievement or map badge is earned, never hand-awarded (05).
    if (b.kind !== 'staff') return res.status(400).json({ error: `a ${b.kind} badge is earned, not awarded` })
    const u = users.resolve(body(req).steam_id || '')
    if (!u) return res.status(404).json({ error: 'no such player' })
    const ok = badges.award(b.id, u.steam_id, req.me.steam_id, { note: body(req).note || null })
    audit(req, 'badge.award', { badge: b.slug, steam_id: u.steam_id })
    res.json({ ok })
  })

  r.post('/badges/:id/revoke', requireAdmin, (req, res) => {
    const b = badges.get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such badge' })
    if (b.kind === 'achievement' || b.kind === 'map') return res.status(400).json({ error: 'earned is earned; only a cheating ban removes this' })
    const u = users.resolve(body(req).steam_id || '')
    if (!u) return res.status(404).json({ error: 'no such player' })
    const ok = badges.revoke(b.id, u.steam_id)
    audit(req, 'badge.revoke', { badge: b.slug, steam_id: u.steam_id })
    res.json({ ok })
  })

  // ---- Collections: the home rows ---------------------------------------------------
  r.get('/collections', requireMod, (req, res) => {
    res.json({ collections: collections.all(), auto: collections.AUTO_KEYS })
  })

  r.post('/collections', requireAdmin, (req, res) => {
    const out = collections.create({ ...body(req), by: req.me.steam_id })
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.create', { slug: out.collection.slug })
    res.json(out)
  })

  r.post('/collections/:id', requireAdmin, (req, res) => {
    const out = collections.update(Number(req.params.id), body(req), req.me.steam_id)
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.update', { id: Number(req.params.id), patch: body(req) })
    res.json(out)
  })

  r.post('/collections/:id/maps', requireAdmin, (req, res) => {
    const out = collections.addMap(Number(req.params.id), body(req).map_key || '')
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.add', { id: Number(req.params.id), map: body(req).map_key })
    res.json(out)
  })

  r.delete('/collections/:id/maps/:key', requireAdmin, (req, res) => {
    const out = collections.removeMap(Number(req.params.id), req.params.key)
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.remove', { id: Number(req.params.id), map: req.params.key })
    res.json(out)
  })

  r.post('/collections/:id/order', requireAdmin, (req, res) => {
    const out = collections.reorder(Number(req.params.id), body(req).keys || [])
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.order', { id: Number(req.params.id) })
    res.json(out)
  })

  r.delete('/collections/:id', requireAdmin, (req, res) => {
    const out = collections.remove(Number(req.params.id))
    if (!out.ok) return res.status(400).json(out)
    audit(req, 'collection.delete', { id: Number(req.params.id) })
    res.json(out)
  })

  // ---- Sweeps -----------------------------------------------------------------------
  r.post('/sweep', requireAdmin, (req, res) => {
    const out = { achievements: achievements.sweep(), map_records: mapRecords.sweep() }
    audit(req, 'admin.sweep', {})
    res.json(out)
  })

  return r
}

module.exports = { router }
