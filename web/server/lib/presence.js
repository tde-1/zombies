'use strict'

// Who is online, and where.
//
// Two files in Movement, one here because Zombies has one source of truth per fact:
//
//   presence.js      who has a live socket on the site/launcher (`onlineIds()`)
//   whereabouts.js   where they actually are
//
// THE RULE THAT CARRIES OVER (11 §9): **a box roster beats a lobby seat.** If the site
// thinks you are in a party staging Der Riese and a game box says you are connected to a
// server playing Nacht, the box wins — it is the only thing watching a real game. Movement
// learned this from people appearing in two places at once; the lobby is an intention and
// the box is a fact.

const { db, now } = require('../db/database')

const ONLINE_MS = 70_000        // a socket heartbeats every 30s; two misses is offline
const IN_GAME_MS = 90_000       // a box posts status every few seconds

const sockets = new Map()       // steam_id -> { at, sockets:Set }

function connected(steamId, socketId) {
  const sid = String(steamId)
  const e = sockets.get(sid) || { at: 0, sockets: new Set() }
  e.sockets.add(socketId)
  e.at = now()
  sockets.set(sid, e)
  mark(sid, { source: 'site' })
}

function disconnected(steamId, socketId) {
  const sid = String(steamId)
  const e = sockets.get(sid)
  if (!e) return
  e.sockets.delete(socketId)
  if (!e.sockets.size) sockets.delete(sid)
}

function heartbeat(steamId) {
  const sid = String(steamId)
  const e = sockets.get(sid)
  if (e) e.at = now()
  mark(sid, { source: 'site' })
}

function mark(steamId, { source = 'site', matchId = null, mapKey = null, box = null, partyId = null } = {}) {
  db.prepare(`INSERT INTO presence (steam_id, seen_at, source, match_id, map_key, box, party_id)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(steam_id) DO UPDATE SET seen_at=excluded.seen_at, source=excluded.source,
                match_id=COALESCE(excluded.match_id, presence.match_id),
                map_key=COALESCE(excluded.map_key, presence.map_key),
                box=COALESCE(excluded.box, presence.box),
                party_id=COALESCE(excluded.party_id, presence.party_id)`)
    .run(String(steamId), now(), source, matchId, mapKey, box, partyId)
}

/** A box told us this player is in this game. This overwrites, it does not merge. */
function markInGame(steamId, { matchId, mapKey, box }) {
  db.prepare(`INSERT INTO presence (steam_id, seen_at, source, match_id, map_key, box)
              VALUES (?,?, 'box', ?,?,?)
              ON CONFLICT(steam_id) DO UPDATE SET seen_at=excluded.seen_at, source='box',
                match_id=excluded.match_id, map_key=excluded.map_key, box=excluded.box`)
    .run(String(steamId), now(), matchId || null, mapKey || null, box || null)
}

function clearGame(steamId) {
  db.prepare(`UPDATE presence SET source='site', match_id=NULL, map_key=NULL, box=NULL, seen_at=? WHERE steam_id=?`)
    .run(now(), String(steamId))
}

function onlineIds() {
  const cut = now() - ONLINE_MS
  const live = [...sockets.entries()].filter(([, e]) => e.at > cut).map(([sid]) => sid)
  const fromBox = db.prepare("SELECT steam_id FROM presence WHERE source='box' AND seen_at > ?").all(now() - IN_GAME_MS).map((r) => r.steam_id)
  return [...new Set([...live, ...fromBox])]
}

const isOnline = (steamId) => onlineIds().includes(String(steamId))

/**
 * Where somebody is, in one line, with the box beating the lobby.
 * Returns null when they are not online at all.
 */
function whereabouts(steamId) {
  const sid = String(steamId)
  const p = db.prepare('SELECT * FROM presence WHERE steam_id=?').get(sid)
  const online = isOnline(sid)
  if (!online && !(p && p.source === 'box' && now() - p.seen_at < IN_GAME_MS)) return null

  if (p && p.source === 'box' && p.match_id && now() - p.seen_at < IN_GAME_MS) {
    const map = p.map_key ? db.prepare('SELECT title FROM maps WHERE key=?').get(p.map_key) : null
    return {
      state: 'in-game',
      match_id: p.match_id,
      map_key: p.map_key,
      map_title: map ? map.title : p.map_key,
      box: p.box,
      since: p.seen_at,
    }
  }

  const party = db.prepare(`SELECT p.* FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.steam_id=?`).get(sid)
  if (party) {
    const map = party.map_key ? db.prepare('SELECT title FROM maps WHERE key=?').get(party.map_key) : null
    return {
      state: party.state === 'in-game' ? 'in-game' : 'in-party',
      party_id: party.id,
      map_key: party.map_key,
      map_title: map ? map.title : party.map_key,
      visibility: party.visibility,
      since: party.updated_at || party.created_at,
    }
  }
  return { state: 'online' }
}

/** The friends rail: who of mine is online, and what they are doing. */
function friendsOnline(steamId) {
  const users = require('./users')
  return users.friendIds(steamId)
    .map((id) => ({ ...users.publicById(id), where: whereabouts(id) }))
    .filter((f) => f.where)
    .sort((a, b) => (a.where.state === 'in-game' ? -1 : 1) - (b.where.state === 'in-game' ? -1 : 1))
}

function stats() {
  return {
    sockets: [...sockets.values()].reduce((n, e) => n + e.sockets.size, 0),
    online: onlineIds().length,
    in_game: db.prepare("SELECT COUNT(*) c FROM presence WHERE source='box' AND seen_at > ?").get(now() - IN_GAME_MS).c,
  }
}

module.exports = {
  ONLINE_MS, IN_GAME_MS,
  connected, disconnected, heartbeat, mark, markInGame, clearGame,
  onlineIds, isOnline, whereabouts, friendsOnline, stats,
}
