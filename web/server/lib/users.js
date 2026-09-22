'use strict'

// Accounts. One row per Steam account; the ENW name and VIP status are CACHES of two narrow
// read-only ENW APIs (vault 11 §9b) and are refreshed lazily, never depended on to render.
//
// The rule that shapes this file: **a Zombies page must render with ENW switched off.** The
// name falls back to the Steam persona, VIP falls back to the last known value, and nothing
// blocks on a remote call inside a request.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const DELETED_NAME = 'Deleted player'

// The default account settings applied over WaW at launch (99 §4.1, 13 §2). They live on the
// account, not in the WaW install, and follow the player across devices. The launcher reads
// this object; the ranges are the speedrun rule values from 11 §7 so a Verified game cannot
// be configured out of its own rules by the settings page.
const DEFAULT_SETTINGS = {
  fov: 80,            // 65-120; the gun model gets odd past ~100 (99 §4.5)
  fov_scale: 1.0,
  max_fps: 125,       // 20-250, and the server enforces the allowed values
  resolution: null,   // null = leave the player's own
  fullscreen: false,
  borderless: true,
  hud_scale: 1.0,
  zombie_counter: true,   // forced off in record games (13 §4a)
  ee_helper: false,       // unranked only, and only where step data is verified
  chat_channel: 'auto',   // auto = solo Global, group Local (13 §2b)
  streamer_mode: false,
  // "Pause when using global chat" (B, 2026-09-22): a SOLO verified game freezes while the
  // in-game chat overlay is open. The game reads it from /api/game-chat/me and reports it
  // as userinfo enw_pchat (chat-overlay.md §8); co-op never pauses for typing.
  pause_on_chat: true,
  toasts: { badges: true, invites: true, friends: true },
}

function ensure(steamId, patch = {}) {
  const sid = String(steamId)
  const existing = db.prepare('SELECT * FROM users WHERE steam_id=?').get(sid)
  if (!existing) {
    db.prepare(`INSERT INTO users (steam_id, username, avatar, enw_name, settings_json, created_at, last_seen)
                VALUES (?,?,?,?,?,?,?)`)
      .run(sid, patch.username || null, patch.avatar || null, patch.enw_name || null,
        JSON.stringify(DEFAULT_SETTINGS), now(), now())
    return db.prepare('SELECT * FROM users WHERE steam_id=?').get(sid)
  }
  const sets = []
  const vals = []
  for (const k of ['username', 'avatar', 'enw_name']) {
    if (patch[k] != null && patch[k] !== existing[k]) { sets.push(`${k}=?`); vals.push(patch[k]) }
  }
  sets.push('last_seen=?'); vals.push(now())
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE steam_id=?`).run(...vals, sid)
  return db.prepare('SELECT * FROM users WHERE steam_id=?').get(sid)
}

const byId = (steamId) => db.prepare('SELECT * FROM users WHERE steam_id=?').get(String(steamId))

// One resolver for every spelling of "who". A profile URL may carry a SteamID64, an ENW name
// or a username, and the page and its link preview must never disagree about who a link is —
// which is exactly the bug Movement's users.js resolveSteamId exists to prevent.
function resolve(who) {
  const s = String(who || '').trim()
  if (!s) return null
  if (/^7656119\d{10}$/.test(s)) return byId(s) || null
  // The ENW name only (2026-09-22). It used to match `username` too, which is the Steam
  // persona: a persona is not unique and is not a name the site shows, so a link that
  // resolved through it could land on whoever happened to share it.
  return db.prepare('SELECT * FROM users WHERE lower(enw_name)=lower(?) AND deleted=0 LIMIT 1').get(s) || null
}

// What the API hands out about somebody else. Never the settings blob, never the raw VIP
// timestamps, never an email — there isn't one.
function pub(row) {
  if (!row) return null
  if (row.deleted) {
    return {
      steam_id: row.steam_id, name: DELETED_NAME, enw_name: null, avatar: null,
      deleted: true, vip: false, level: 0, prestige: 0,
    }
  }
  return {
    steam_id: row.steam_id,
    // THE ENW USERNAME, and nothing else (B, 2026-09-22). This is what the launcher puts
    // behind `+set name`, what the invite token's `n` carries and what every page draws, so
    // it is never the Steam persona in `username` and never a word the site made up. A row
    // with no ENW name (a verified player who has never opened the site) shows its SteamID,
    // which looks unfinished because it is; a signed-in account cannot get past the name
    // gate without one (middleware/auth.js).
    name: row.enw_name || row.steam_id,
    enw_name: row.enw_name || null,
    avatar: row.avatar || null,
    vip: !!row.vip_is,
    admin: !!row.is_admin,
    mod: !!row.is_mod,
    archivist: !!row.is_archivist,
    approved: !!row.approved,
    level: row.level || 1,
    prestige: row.prestige || 0,
    xp: row.xp_total || 0,
    created_at: row.created_at || null,
    last_seen: row.last_seen || null,
    // A seeded account, so the client can mark it rather than hardcoding the id range.
    //
    // It is derived, not stored: `7656119000000000x` is outside the real SteamID64 space,
    // so nothing signed in through Steam can ever land in it. (The mock sign-in page that
    // used to hand these ids out is gone, 2026-09-22; the seed and the test-only hook are
    // the only things that make them now.) It is a property of the ACCOUNT and never of the
    // game. Whether a run is real is `games.demo`, and nothing else.
    demo_account: isDemoId(row.steam_id),
  }
}

const isDemoId = (steamId) => /^7656119000000000\d$/.test(String(steamId || ''))

const publicById = (steamId) => pub(byId(steamId))

function settings(steamId) {
  const u = byId(steamId)
  return { ...DEFAULT_SETTINGS, ...(safeJson(u && u.settings_json) || {}) }
}

// The Settings page's `game` object (web /settings, laid out like World at War's own
// Options menus; client/src/data/wawSettings.js is the catalogue). The LAUNCHER is the
// strict gate - launcher/src/main/wawcfg.js refuses anything the game's menus do not
// offer before it reaches a command line or a config.cfg. This only keeps the stored blob
// the right shape and size, so a hand-made PUT cannot park junk on the account.
const GAME_KEYS = {
  mode: (v) => (['borderless', 'fullscreen', 'windowed'].includes(v) ? v : undefined),
  display: (v) => (v == null ? undefined : String(v).slice(0, 64)),
  resolution: (v) => (v === '' || /^\d{3,5}x\d{3,5}$/.test(String(v)) ? String(v) : undefined),
  vsync: (v) => !!v,
  fov: (v) => (Number.isFinite(Number(v)) ? Math.min(120, Math.max(65, Math.round(Number(v)))) : undefined),
  maxFps: (v) => (Number.isFinite(Number(v)) ? Math.min(250, Math.max(20, Math.round(Number(v)))) : undefined),
  showFps: (v) => !!v,
  sensitivity: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100 ? Number(v) : undefined),
  rawMouse: (v) => v !== false,
}
function sanitizeGame(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return undefined
  const out = { waw: {}, wawBinds: {} }
  for (const [k, f] of Object.entries(GAME_KEYS)) {
    if (!(k in g)) continue
    const v = f(g[k])
    if (v !== undefined) out[k] = v
  }
  for (const [d, v] of Object.entries(g.waw || {}).slice(0, 80)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{1,40}$/.test(d)) continue
    if (v === null || (typeof v === 'string' && v.length <= 24)) out.waw[d] = v
  }
  for (const [c, keys] of Object.entries(g.wawBinds || {}).slice(0, 80)) {
    if (!/^[+A-Za-z_][A-Za-z0-9_ ]{1,30}$/.test(c) || !Array.isArray(keys)) continue
    out.wawBinds[c] = keys.map((k) => String(k).toUpperCase()).filter((k) => /^[A-Z0-9_\-=[\]',./\\]{1,12}$/.test(k)).slice(0, 2)
  }
  out.updatedAt = Number.isFinite(Number(g.updatedAt)) ? Number(g.updatedAt) : Date.now()
  return out
}

function saveSettings(steamId, patch) {
  patch = { ...(patch || {}) }
  if ('game' in patch) {
    const g = sanitizeGame(patch.game)
    if (g) {
      patch.game = g
      // The two the rest of the site already reads (Profile, /api/launcher/play) stay in
      // step with the Settings page rather than becoming a second opinion.
      if (g.fov !== undefined) patch.fov = g.fov
      if (g.maxFps !== undefined) patch.max_fps = g.maxFps
    } else delete patch.game
  }
  const merged = { ...settings(steamId), ...patch }
  db.prepare('UPDATE users SET settings_json=? WHERE steam_id=?').run(JSON.stringify(merged), String(steamId))
  return merged
}

// Deletion is ANONYMISATION (99 §4.1). The row stays because records, replays and badges
// hang off it and 99 §4.7 keeps them; what goes is the identity.
function anonymise(steamId) {
  db.prepare(`UPDATE users SET deleted=1, username=NULL, avatar=NULL, enw_name=NULL,
              settings_json=NULL, pinned_badges=NULL WHERE steam_id=?`).run(String(steamId))
  db.prepare('DELETE FROM comments WHERE steam_id=?').run(String(steamId))
  db.prepare('DELETE FROM friendships WHERE requester_steam_id=? OR addressee_steam_id=?').run(String(steamId), String(steamId))
}

// ---- friends -------------------------------------------------------------------------
function friendIds(steamId) {
  const sid = String(steamId)
  return db.prepare(`
    SELECT CASE WHEN requester_steam_id=? THEN addressee_steam_id ELSE requester_steam_id END AS id
      FROM friendships
     WHERE status='accepted' AND (requester_steam_id=? OR addressee_steam_id=?)
  `).all(sid, sid, sid).map((r) => r.id)
}

function friendState(a, b) {
  const row = db.prepare(`SELECT * FROM friendships
                           WHERE (requester_steam_id=? AND addressee_steam_id=?)
                              OR (requester_steam_id=? AND addressee_steam_id=?)`).get(a, b, b, a)
  if (!row) return 'none'
  if (row.status === 'accepted') return 'friends'
  return row.requester_steam_id === String(a) ? 'sent' : 'incoming'
}

function requestFriend(from, to) {
  if (String(from) === String(to)) return { ok: false, error: 'that is you' }
  const existing = db.prepare(`SELECT * FROM friendships
                                WHERE (requester_steam_id=? AND addressee_steam_id=?)
                                   OR (requester_steam_id=? AND addressee_steam_id=?)`).get(from, to, to, from)
  if (existing && existing.status === 'accepted') return { ok: true, state: 'friends' }
  if (existing && existing.requester_steam_id === String(to)) {
    db.prepare('UPDATE friendships SET status=?, updated_at=? WHERE id=?').run('accepted', now(), existing.id)
    return { ok: true, state: 'friends' }
  }
  if (existing) return { ok: true, state: 'sent' }
  db.prepare(`INSERT INTO friendships (requester_steam_id, addressee_steam_id, status, created_at, updated_at)
              VALUES (?,?, 'pending', ?, ?)`).run(String(from), String(to), now(), now())
  return { ok: true, state: 'sent' }
}

function respondFriend(me, other, accept) {
  const row = db.prepare('SELECT * FROM friendships WHERE requester_steam_id=? AND addressee_steam_id=?').get(String(other), String(me))
  if (!row) return { ok: false, error: 'no request' }
  if (accept) db.prepare('UPDATE friendships SET status=?, updated_at=? WHERE id=?').run('accepted', now(), row.id)
  else db.prepare('DELETE FROM friendships WHERE id=?').run(row.id)
  return { ok: true, state: accept ? 'friends' : 'none' }
}

function removeFriend(me, other) {
  db.prepare(`DELETE FROM friendships WHERE (requester_steam_id=? AND addressee_steam_id=?)
                                          OR (requester_steam_id=? AND addressee_steam_id=?)`)
    .run(String(me), String(other), String(other), String(me))
  return { ok: true, state: 'none' }
}

function pendingRequests(steamId) {
  return db.prepare(`SELECT * FROM friendships WHERE addressee_steam_id=? AND status='pending' ORDER BY created_at DESC`)
    .all(String(steamId))
    .map((r) => ({ from: publicById(r.requester_steam_id), at: r.created_at }))
    .filter((x) => x.from)
}

module.exports = {
  DEFAULT_SETTINGS, DELETED_NAME,
  ensure, byId, resolve, pub, publicById, settings, saveSettings, sanitizeGame, anonymise, isDemoId,
  friendIds, friendState, requestFriend, respondFriend, removeFriend, pendingRequests,
}
