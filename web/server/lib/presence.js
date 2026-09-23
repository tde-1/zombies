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

const sockets = new Map()       // steam_id -> { at, sockets:Set, clients: Map(socketId -> 'site'|'launcher') }

// `client` is what the socket said it was at the handshake (web/client/src/socket.js sends
// `launcher` when `window.enw` exists). It only chooses the words "In launcher" over
// "Online" on somebody else's rail; nothing is gated on it, so a lie costs nothing.
function connected(steamId, socketId, client = 'site') {
  const sid = String(steamId)
  const e = sockets.get(sid) || { at: 0, sockets: new Set(), clients: new Map() }
  e.sockets.add(socketId)
  e.clients.set(socketId, client === 'launcher' ? 'launcher' : 'site')
  e.at = now()
  sockets.set(sid, e)
  mark(sid, { source: 'site' })
}

function disconnected(steamId, socketId) {
  const sid = String(steamId)
  const e = sockets.get(sid)
  if (!e) return
  e.sockets.delete(socketId)
  e.clients.delete(socketId)
  if (!e.sockets.size) sockets.delete(sid)
}

/** 'launcher' when any live socket of theirs is the launcher, 'site' for a browser, else null. */
function clientOf(steamId) {
  const e = sockets.get(String(steamId))
  if (!e || !e.sockets.size) return null
  return [...e.clients.values()].includes('launcher') ? 'launcher' : 'site'
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
  // A launcher socket counts while it is connected, heartbeat or not: a launcher sitting in
  // the tray is exactly "online, in launcher", and a hidden window's timers are throttled by
  // Chromium, so its 30 s heartbeat can arrive late. socket.io's own ping drops a dead one.
  const live = [...sockets.entries()]
    .filter(([, e]) => e.at > cut || (e.sockets.size && [...e.clients.values()].includes('launcher')))
    .map(([sid]) => sid)
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

  const client = clientOf(sid)
  if (p && p.source === 'box' && p.match_id && now() - p.seen_at < IN_GAME_MS) {
    const map = p.map_key ? db.prepare('SELECT title FROM maps WHERE key=?').get(p.map_key) : null
    return {
      state: 'in-game',
      match_id: p.match_id,
      map_key: p.map_key,
      map_title: map ? map.title : p.map_key,
      round: roundOf(p.match_id),
      box: p.box,
      client,
      since: p.seen_at,
    }
  }

  const party = db.prepare(`SELECT p.* FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.steam_id=?`).get(sid)
  if (party) {
    const map = party.map_key ? db.prepare('SELECT title FROM maps WHERE key=?').get(party.map_key) : null
    const inGame = party.state === 'in-game'
    return {
      state: inGame ? 'in-game' : 'in-party',
      party_id: party.id,
      match_id: inGame ? party.match_id || null : null,
      map_key: party.map_key,
      map_title: map ? map.title : party.map_key,
      round: inGame ? roundOf(party.match_id) : null,
      visibility: party.visibility,
      client,
      since: party.updated_at || party.created_at,
    }
  }
  return { state: 'online', client }
}

// The round a live game last reported (lib/live.js, the referee's 4 Hz frame). null when no
// fresh frame: "In game on Der Riese" without a round is better than a stale round.
function roundOf(matchId) {
  if (!matchId) return null
  try {
    const f = require('./live').get(matchId)
    const r = f && f.state && Number(f.state.round)
    return r > 0 ? r : null
  } catch { return null }
}

/**
 * One string that changes whenever anybody's line on the online list would: who is online,
 * from what, where, and the round. index.js compares it once a second and nudges every
 * socket (`online_changed`) when it moves, so the rail is never more than ~1 s behind
 * whatever moved it (a socket, a party, a box, a round) without each of those having to
 * remember to announce itself.
 */
function signature() {
  return onlineIds().sort().map((id) => {
    const w = whereabouts(id) || {}
    return [id, w.state, w.client, w.map_key, w.party_id, w.round, w.match_id].join(':')
  }).join('|')
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
  connected, disconnected, heartbeat, mark, markInGame, clearGame, clientOf, signature,
  onlineIds, isOnline, whereabouts, friendsOnline, stats,
}
