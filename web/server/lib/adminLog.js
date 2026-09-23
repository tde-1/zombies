'use strict'

// The admin Log (2026-09-23, "admin: parity with Movement and beyond").
//
// Movement's shape (CSGO-Matchmaker server/lib/adminLog.js + LogPanel.jsx): one feed, lanes,
// a search, an actor filter, a time window, and a "Load older" cursor. Ours reads the one
// table everything already writes, `activity_log`, so there is no second source to union.
//
// Two writers:
//   * `audit(req, event, meta)`: explicit, from routes/admin.js.
//   * `guard()`: router middleware. Any successful non-GET admin request that wrote NO
//     activity_log row of its own gets a generic `admin.action` row, so no staff write can
//     go unrecorded because somebody forgot a line.

const { db, now } = require('../db/database')

// Lane = first dotted segment of the event, mostly. Order is the chip order.
const LANES = {
  boxes: ['box.', 'assignment.', 'lease.'],
  people: ['user.', 'name.', 'role.', 'approval.'],
  moderation: ['ban.', 'infraction.', 'report.', 'chat.', 'comment.'],
  records: ['record.', 'result.', 'game.', 'replay.'],
  content: ['map.', 'playlist.', 'collection.', 'guide.', 'badge.', 'week.'],
}
const LANE_KEYS = [...Object.keys(LANES), 'other']

function laneOf(event) {
  const e = String(event || '')
  for (const [k, pre] of Object.entries(LANES)) if (pre.some((p) => e.startsWith(p))) return k
  return 'other'
}

const SECRETS = /secret|match_key|token|password|key$/i
function scrub(v, depth = 0) {
  if (v == null || depth > 3) return v
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => scrub(x, depth + 1))
  if (typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = SECRETS.test(k) && k !== 'map_key' ? '[redacted]' : scrub(x, depth + 1)
    return o
  }
  if (typeof v === 'string') return v.slice(0, 300)
  return v
}

function write(event, actor, meta) {
  const info = db.prepare('INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES (?,?,?,?)')
    .run(String(event), actor || null, JSON.stringify(scrub(meta || {})), now())
  return info.lastInsertRowid
}

function audit(req, event, meta) {
  if (req) req.audited = true
  return write(event, req && req.me ? req.me.steam_id : null, meta)
}

function guard() {
  return (req, res, next) => {
    if (req.method === 'GET') return next()
    const mark = (db.prepare('SELECT MAX(id) m FROM activity_log').get().m) || 0
    res.on('finish', () => {
      if (res.statusCode >= 400 || req.audited || !req.me) return
      try {
        const wrote = db.prepare('SELECT 1 FROM activity_log WHERE id > ? AND actor = ? LIMIT 1').get(mark, req.me.steam_id)
        if (wrote) return
        write('admin.action', req.me.steam_id, { method: req.method, path: req.originalUrl.split('?')[0], body: req.body || {} })
      } catch (e) { console.warn('[adminLog] guard:', e.message) }
    })
    next()
  }
}

const WINDOWS = { today: 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 }
const isSteam = (s) => /^7656119\d{10}$/.test(String(s || ''))

/**
 * @param {object} o
 *   q       text in the event or its metadata
 *   lane    one of LANE_KEYS
 *   actor   'people' (a SteamID did it), 'auto' (a box or the site), or a SteamID
 *   window  today | 7d | 30d | all
 *   before  id cursor (Load older)
 *   limit   <= 200
 */
function read({ q = '', lane = '', actor = '', window = 'all', before = 0, limit = 60 } = {}) {
  const where = []
  const vals = []
  if (q) { where.push('(event LIKE ? OR metadata LIKE ? OR actor LIKE ?)'); const l = `%${String(q).slice(0, 80)}%`; vals.push(l, l, l) }
  if (lane && LANES[lane]) {
    where.push('(' + LANES[lane].map(() => 'event LIKE ?').join(' OR ') + ')')
    vals.push(...LANES[lane].map((p) => `${p}%`))
  } else if (lane === 'other') {
    const all = Object.values(LANES).flat()
    where.push('(' + all.map(() => 'event NOT LIKE ?').join(' AND ') + ')')
    vals.push(...all.map((p) => `${p}%`))
  }
  if (actor === 'people') where.push("actor GLOB '7656119*'")
  else if (actor === 'auto') where.push("(actor IS NULL OR actor NOT GLOB '7656119*')")
  else if (isSteam(actor)) { where.push('(actor = ? OR metadata LIKE ?)'); vals.push(actor, `%${actor}%`) }
  if (WINDOWS[window]) { where.push('logged_at >= ?'); vals.push(now() - WINDOWS[window]) }
  if (Number(before) > 0) { where.push('id < ?'); vals.push(Number(before)) }
  const n = Math.max(1, Math.min(200, Number(limit) || 60))
  const sql = `SELECT * FROM activity_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  const rows = db.prepare(sql).all(...vals, n + 1)
  const more = rows.length > n
  const users = require('./users')
  const names = new Map()
  const who = (sid) => {
    if (!isSteam(sid)) return null
    if (!names.has(sid)) { const u = users.publicById(sid); names.set(sid, u ? { steam_id: u.steam_id, name: u.name } : { steam_id: sid, name: sid }) }
    return names.get(sid)
  }
  return {
    rows: rows.slice(0, n).map((r) => {
      let meta = null
      try { meta = r.metadata ? JSON.parse(r.metadata) : null } catch { meta = r.metadata }
      return { id: r.id, at: r.logged_at, event: r.event, lane: laneOf(r.event), actor: r.actor, who: who(r.actor), meta }
    }),
    more,
    next: more ? rows[n - 1].id : null,
  }
}

function counts({ window = '7d' } = {}) {
  const since = WINDOWS[window] ? now() - WINDOWS[window] : 0
  const out = { all: 0 }
  for (const k of LANE_KEYS) out[k] = 0
  for (const r of db.prepare('SELECT event, COUNT(*) c FROM activity_log WHERE logged_at >= ? GROUP BY event').all(since)) {
    out[laneOf(r.event)] += r.c
    out.all += r.c
  }
  return out
}

module.exports = { audit, guard, read, counts, laneOf, LANE_KEYS, scrub, write }
