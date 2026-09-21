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
  return db.prepare('SELECT * FROM users WHERE lower(enw_name)=lower(?) OR lower(username)=lower(?) LIMIT 1').get(s, s) || null
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
    name: row.enw_name || row.username || row.steam_id,
    username: row.username || null,
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
    // so nothing signed in through Steam can ever land in it. On this dev box the mock
    // sign-in page hands these ids out, so B himself plays as one of them — which is
    // exactly why it is a property of the ACCOUNT and never of the game. Whether a run is
    // real is `games.demo`, and nothing else.
    demo_account: isDemoId(row.steam_id),
  }
}

const isDemoId = (steamId) => /^7656119000000000\d$/.test(String(steamId || ''))

const publicById = (steamId) => pub(byId(steamId))

function settings(steamId) {
  const u = byId(steamId)
  return { ...DEFAULT_SETTINGS, ...(safeJson(u && u.settings_json) || {}) }
}

function saveSettings(steamId, patch) {
  const merged = { ...settings(steamId), ...(patch || {}) }
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
  ensure, byId, resolve, pub, publicById, settings, saveSettings, anonymise, isDemoId,
  friendIds, friendState, requestFriend, respondFriend, removeFriend, pendingRequests,
}
