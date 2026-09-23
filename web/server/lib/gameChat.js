'use strict'

// Chat for the GAME CLIENT: the in-game overlay (client-dll/components/chat_overlay.cpp,
// docs/kickstart/chat-overlay.md) talks to the site directly, never through the engine's
// net path and never through the box. Three things live here:
//
//   1. A CHAT PASS. The game must not hold the player's site session (a session can do
//      everything the player can), so the launcher asks for a narrow bearer
//      (`POST /api/launcher/chat-token`, session auth) and hands it to the game on its
//      one-shot token pipe. The pass is an HMAC over {steamid, expiry}, good for
//      `/api/game-chat/*` only, for twelve hours. Stateless, so a site restart does not
//      sign anybody out of chat mid-game; a ban is checked on every use.
//
//   2. The PRIVATE RING: party lines and direct messages. A separate table from the
//      global ring (`chat_network`) ON PURPOSE: the global ring is drained by every box
//      and emitted to every browser, and a DM must never be one filter away from that.
//      Nothing that reads `chat_network` can see a row of this table.
//
//   3. The long-poll the overlay uses for both rings at once.
//
// Party lines are visible to whoever is in that party NOW (join late and you see the
// party's recent lines, leave and you stop). DMs go only to friends or party members —
// a stranger cannot open a message box on you.

const crypto = require('crypto')
const { db, now } = require('../db/database')
const chat = require('./chatNetwork')
const users = require('./users')
const parties = require('./parties')
const bans = require('./bans')

const PASS_TTL_S = 12 * 3600
const MAX_LEN = chat.MAX_LEN || 300
const KEEP = 2000

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_private (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    channel   TEXT NOT NULL,            -- 'party' | 'dm'
    party_id  INTEGER,                  -- party lines
    from_sid  TEXT NOT NULL,
    from_name TEXT,
    to_sid    TEXT,                     -- dm lines
    to_name   TEXT,
    text      TEXT NOT NULL,
    removed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chat_private_party ON chat_private(party_id, id);
  CREATE INDEX IF NOT EXISTS idx_chat_private_from ON chat_private(from_sid, id);
  CREATE INDEX IF NOT EXISTS idx_chat_private_to ON chat_private(to_sid, id);
`)

// ---------------------------------------------------------------- the chat pass --
let secret = null
function setSecret(s) { secret = crypto.createHash('sha256').update('zm-game-chat-v1:' + String(s)).digest() }
function key() {
  if (!secret) setSecret(process.env.ZM_SESSION_SECRET || crypto.randomBytes(32).toString('hex'))
  return secret
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function mintPass(steamId, { ttl = PASS_TTL_S } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttl
  const body = b64u(JSON.stringify({ s: String(steamId), e: exp, n: b64u(crypto.randomBytes(9)) }))
  const sig = b64u(crypto.createHmac('sha256', key()).update('gc1.' + body).digest())
  return { token: `gc1.${body}.${sig}`, expires_at: exp }
}

// -> the user row, or null. Never throws.
function verifyPass(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3 || parts[0] !== 'gc1') return null
    const want = crypto.createHmac('sha256', key()).update('gc1.' + parts[1]).digest()
    const got = unb64u(parts[2])
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
    const p = JSON.parse(unb64u(parts[1]).toString('utf8'))
    if (!p || typeof p.s !== 'string' || !Number.isFinite(p.e)) return null
    if (p.e < Math.floor(Date.now() / 1000)) return null
    const u = users.byId(p.s)
    if (!u || u.deleted) return null
    if (bans.siteBanned(u.steam_id)) return null
    return u
  } catch {
    return null
  }
}

// ------------------------------------------------------------ the private ring --
let waiters = []     // [{ resolve, timer }]
let emit = null      // (steamIds[], line) => void, set by the socket layer

function setEmitter(fn) { emit = fn }

function wake() {
  const ws = waiters
  waiters = []
  for (const w of ws) { clearTimeout(w.timer); w.resolve() }
}

const clean = (text) => String(text || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_LEN).trim()
const nameOf = (sid) => { const p = users.publicById(sid); return (p && p.name) || 'player' }

function project(r) {
  return {
    id: r.id, at: r.at, channel: r.channel, kind: 'chat',
    from: r.from_name, steamid: r.from_sid,
    to: r.to_sid || null, to_name: r.to_name || null,
    party_id: r.party_id || null, text: r.text,
  }
}

// Who may this player DM? Friends and current party members.
function contactsOf(steamId) {
  const sid = String(steamId)
  const out = new Map()
  const party = parties.forPlayer(sid)
  if (party) for (const m of party.members) if (m.steam_id !== sid) out.set(m.steam_id, { steamid: m.steam_id, name: m.name, party: true })
  for (const f of users.friendIds(sid)) if (!out.has(f)) out.set(f, { steamid: f, name: nameOf(f), party: false })
  return [...out.values()]
}

// Rate limit: 5 lines per 10 s per player, across every channel.
const recent = new Map()
function limited(sid) {
  const t = Date.now()
  const list = (recent.get(sid) || []).filter((x) => t - x < 10_000)
  if (list.length >= 5) { recent.set(sid, list); return true }
  list.push(t)
  recent.set(sid, list)
  return false
}

function send(me, { channel, to, text }) {
  const sid = String(me.steam_id)
  const body = clean(text)
  if (!body) return { ok: false, error: 'nothing to send' }
  if (limited(sid)) return { ok: false, error: 'slow down' }
  const from = users.pub(me).name
  if (channel === 'global' || !channel) {
    // The same ring the website's dock and every box already read. `origin` is not a box
    // name, so every box picks the line up on its drain, as it does for the website's.
    const line = chat.push({ from, text: body, steamId: sid, origin: 'game' })
    return line ? { ok: true, line } : { ok: false, error: 'nothing to send' }
  }
  if (channel === 'party') {
    const party = parties.forPlayer(sid)
    if (!party) return { ok: false, error: 'you are not in a party' }
    const info = db.prepare(`INSERT INTO chat_private (at, channel, party_id, from_sid, from_name, text)
                             VALUES (?,?,?,?,?,?)`).run(now(), 'party', party.id, sid, from, body)
    const line = project(db.prepare('SELECT * FROM chat_private WHERE id=?').get(info.lastInsertRowid))
    trim()
    wake()
    if (emit) { try { emit(party.members.map((m) => m.steam_id), line) } catch { /* a dead socket must not fail a line */ } }
    return { ok: true, line }
  }
  if (channel === 'dm') {
    const target = String(to || '')
    if (!target || target === sid) return { ok: false, error: 'who to?' }
    if (!contactsOf(sid).some((c) => c.steamid === target)) return { ok: false, error: 'you can only message friends and your party' }
    const info = db.prepare(`INSERT INTO chat_private (at, channel, from_sid, from_name, to_sid, to_name, text)
                             VALUES (?,?,?,?,?,?,?)`).run(now(), 'dm', sid, from, target, nameOf(target), body)
    const line = project(db.prepare('SELECT * FROM chat_private WHERE id=?').get(info.lastInsertRowid))
    trim()
    wake()
    if (emit) { try { emit([sid, target], line) } catch { /* as above */ } }
    return { ok: true, line }
  }
  return { ok: false, error: 'unknown channel' }
}

function trim() {
  if (Math.random() < 0.05) db.prepare('DELETE FROM chat_private WHERE id NOT IN (SELECT id FROM chat_private ORDER BY id DESC LIMIT ?)').run(KEEP)
}

// Private lines this player may see, newer than `cursor` (or the latest `tailN` when 0;
// `tailN: 0` makes 0 an ordinary cursor).
function privateFor(steamId, cursor = 0, { tailN = 30, limit = 100 } = {}) {
  const sid = String(steamId)
  const party = parties.forPlayer(sid)
  const pid = party ? party.id : -1
  const where = `removed=0 AND ((channel='party' AND party_id=?) OR (channel='dm' AND (from_sid=? OR to_sid=?)))`
  if (!Number(cursor) && tailN > 0) {
    return db.prepare(`SELECT * FROM chat_private WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(pid, sid, sid, tailN).reverse().map(project)
  }
  return db.prepare(`SELECT * FROM chat_private WHERE id > ? AND ${where} ORDER BY id ASC LIMIT ?`)
    .all(Number(cursor), pid, sid, sid, limit).map(project)
}

const latestPrivate = () => (db.prepare('SELECT MAX(id) m FROM chat_private').get().m || 0)

function waitPrivate(seconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters = waiters.filter((w) => w.timer !== timer); resolve() }, seconds * 1000)
    timer.unref?.()
    waiters.push({ resolve, timer })
  })
}

// The overlay's one request: both rings, long-polled. `g` / `p` are the two cursors.
//
// 0 means "I have just started" and gets THE CURSOR AND NO LINES — the box drain's rule
// (routes/gameserver.js, since=0). It used to get the recent tail, and the overlay stamps
// every line with the moment it ARRIVED (chat_overlay.cpp line_from_json), so joining a game
// put the last five lines of the ring on the HUD as if just said: the previous game's
// "myu started a game on <map>" beside this one's. That was B's "duplicate messages when you
// first join" (2026-09-23; web.md, profile/records/invites/chat dedupe). A client that wants
// the backlog asks for it (`history`), and every line of it carries `backfill: true` so it
// can file it as history rather than news.
async function feed(me, { g = 0, p = 0, wait = 20, history = false, isClosed = () => false } = {}) {
  const sid = String(me.steam_id)
  // The cursors are taken BEFORE any wait, so a fresh client that waits is handed exactly
  // what was said after it asked — never the backlog, and never a gap.
  const g0 = Number(g) || chat.latest()
  const p0 = Number(p) || latestPrivate()
  const back = (l) => ({ ...l, backfill: true })
  let first = true
  const collect = () => {
    const withHistory = first && history
    first = false
    const global = withHistory && !Number(g) ? chat.tail(20).map(back) : chat.since(g0)
    const priv = withHistory && !Number(p) ? privateFor(sid, 0).map(back) : privateFor(sid, p0, { tailN: 0 })
    return { global, priv }
  }
  let out = collect()
  const secs = Math.min(25, Math.max(0, Number(wait) || 0))
  if (!out.global.length && !out.priv.length && secs > 0) {
    await Promise.race([chat.wait(secs, 'game'), waitPrivate(secs)])
    if (isClosed()) return null
    out = collect()
  }
  const newest = (rows) => rows.filter((l) => !l.backfill).reduce((m, l) => Math.max(m, l.id), 0)
  return {
    ok: true,
    // Cursors never go backwards: the last line handed over, or "now" for a fresh client.
    g: Math.max(g0, newest(out.global)),
    p: Math.max(p0, newest(out.priv)),
    global: out.global,
    private: out.priv,
  }
}

function meFor(u) {
  const sid = String(u.steam_id)
  const party = parties.forPlayer(sid)
  const s = users.settings(sid)
  return {
    steamid: sid,
    name: users.pub(u).name,
    pause_on_chat: s.pause_on_chat !== false,
    party: party ? { id: party.id, members: party.members.map((m) => ({ steamid: m.steam_id, name: m.name })) } : null,
    contacts: contactsOf(sid),
  }
}

module.exports = { setSecret, mintPass, verifyPass, send, feed, privateFor, meFor, contactsOf, setEmitter, PASS_TTL_S }
