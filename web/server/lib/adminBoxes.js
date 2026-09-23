'use strict'

// The admin Boxes page (2026-09-23). Everything here is READ from what the host agent
// already sends and what the site already stores (host.md §13):
//
//   boxes.last_status_json   the agent's 10 s heartbeat: instances[] with state, phase, map,
//                            warm, leased, usage; host; protocol; max_instances
//   assignments              the leases (the v2 poll hands the agent every live one)
//   lib/seats.js             who the referee says is connected to which match, from /api/gs/live
//   games.summary_json       the last result per box, whose `hashes` carry the DLL build stamp
//                            and the game exe's sha256 as the referee heard them at `hello`
//
// The site never dials a box. "Retire" and "Restart" are lease changes the agent picks up on
// its next poll: a lease missing from the list is retired (host.md §13.2), and a restart is a
// fresh lease for the same players, which supersedes their old one (assignments rule 1).
//
// THE GUARD. Neither goes through while somebody is in the game unless the request names
// exactly who: `confirm` must be the sorted SteamIDs of the players the referee reports
// connected. The panel shows those names in the dialog and sends them back. A stale dialog
// (somebody joined since) gets the 409 again with the new list.

const { db, now } = require('../db/database')
const { safeJson } = require('./util')
const boxes = require('./boxes')
const assignments = require('./assignments')
const seats = require('./seats')
const users = require('./users')

const LIVE = "('leased','ready','live')"

function lastHashes(boxName) {
  const g = db.prepare('SELECT match_id, summary_json, received_at FROM games WHERE box=? ORDER BY received_at DESC LIMIT 1').get(boxName)
  if (!g) return null
  const s = safeJson(g.summary_json, {}) || {}
  const h = s.hashes || {}
  return { match_id: g.match_id, at: g.received_at, dll_build: h.dll_build || null, exe_sha256: h.exe_sha256 || null }
}

function playersOf(row) {
  const list = safeJson(row.players_json, []) || []
  return list.map((p) => {
    const u = users.publicById(p.steamid)
    return {
      steam_id: String(p.steamid),
      name: (u && u.name) || p.name || String(p.steamid),
      seat: seats.stateOf(row.match_id, p.steamid),
      demo: users.isDemoId ? users.isDemoId(p.steamid) : false,
    }
  })
}

/** Who a retire/restart would throw out: players the referee says are connected now. */
function occupants(row) {
  return playersOf(row).filter((p) => p.seat === 'connected')
}

const confirmKey = (list) => list.map((p) => p.steam_id).sort().join(',')

function leaseView(row, status) {
  const inst = ((status && status.instances) || []).find((i) => i && i.match_id === row.match_id) || null
  const players = playersOf(row)
  return {
    match_id: row.match_id,
    map: row.map_key,
    mode: row.mode,
    state: row.state,
    agent: !!row.agent,
    party_id: row.party_id || null,
    issued_at: row.issued_at,
    ready_at: row.ready_at,
    players,
    in_game: players.filter((p) => p.seat === 'connected').length,
    instance: inst ? { id: inst.id, port: inst.port, state: inst.state, phase: inst.phase, map_loaded: !!inst.map_loaded, uptime_ms: inst.uptime_ms, usage: inst.usage || null, restarts: inst.restarts || 0 } : null,
  }
}

function detail() {
  return boxes.list().map((b) => {
    const row = boxes.byId(b.id)
    const status = b.status || {}
    const leases = db.prepare(`SELECT * FROM assignments WHERE box_id=? AND state IN ${LIVE} ORDER BY id`).all(b.id)
    const leased = new Set(leases.map((l) => l.match_id))
    const cap = assignments.capacity(row)
    return {
      id: b.id,
      name: b.name,
      region: b.region,
      note: b.note,
      address: row.address || null,
      enabled: b.enabled,
      online: b.online,
      last_poll: b.last_poll,
      last_state: b.last_state,
      key: b.key,
      capacity: { max: cap.max, reserve: cap.reserve, protocol: cap.protocol, configured_max: b.max_instances, configured_reserve: b.reserve },
      host: status.host || null,
      live_games: status.live_games ?? null,
      leases: leases.map((l) => leaseView(l, status)),
      // Instances the agent has that no live lease names: warm spares, or a game still
      // finishing. Shown so an operator can see every slot, not only the leased ones.
      spare: (status.instances || []).filter((i) => i && !leased.has(i.match_id)).map((i) => ({
        id: i.id, port: i.port, state: i.state, phase: i.phase || null, warm: !!i.warm, match_id: i.match_id || null, usage: i.usage || null,
      })),
      build: lastHashes(b.name),
    }
  })
}

function guarded(matchId, confirm) {
  const row = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(String(matchId))
  if (!row) return { status: 404, body: { error: 'no such lease' } }
  if (!['leased', 'ready', 'live'].includes(row.state)) return { status: 400, body: { error: `that lease is already ${row.state}` } }
  const who = occupants(row)
  if (who.length && String(confirm || '') !== confirmKey(who)) {
    return { status: 409, body: { error: 'players are in this game', needs_confirm: true, players: who, confirm: confirmKey(who) } }
  }
  return { row, who }
}

function retire(matchId, { confirm, by } = {}) {
  const g = guarded(matchId, confirm)
  if (!g.row) return g
  const out = assignments.cancel(g.row.match_id, by)
  return { status: 200, body: { ...out, kicked: g.who } }
}

function restart(matchId, { confirm, by } = {}) {
  const g = guarded(matchId, confirm)
  if (!g.row) return g
  const row = g.row
  const out = assignments.lease({
    box: boxes.byId(row.box_id),
    mapKey: row.map_key,
    mode: row.mode,
    players: (safeJson(row.players_json, []) || []).map((p) => ({ steamid: p.steamid })),
    settings: safeJson(row.settings_json, {}) || {},
    partyId: row.party_id || null,
    agent: !!row.agent,
    by,
  })
  if (!out.ok) return { status: 400, body: out }
  if (row.party_id) db.prepare("UPDATE parties SET state='launching', match_id=?, updated_at=? WHERE id=?").run(out.match_id, now(), row.party_id)
  return { status: 200, body: { ok: true, from: row.match_id, match_id: out.match_id, box: out.box, kicked: g.who } }
}

module.exports = { detail, retire, restart, occupants, confirmKey, lastHashes }
