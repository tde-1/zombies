'use strict'

// Parties, the ready check, and the launch (13 §4b).
//
// The flow B described, in order, and the code follows it literally:
//
//   1. the leader picks the map + Verified/Custom and presses Start
//   2. every member gets a Ready prompt
//   3. when all are ready the server boots
//   4. every member's launcher auto-launches WaW and connects
//
//   "Not everyone ready? THE LEADER DECIDES." — they see who is not ready and either start
//   anyway (the others can late-join, earning nothing from it) or keep waiting. There is no
//   timeout that starts the game for them, because a game that starts itself with half the
//   party missing is the thing the ready check exists to prevent.
//
// Visibility is private / friends / public, and the serialiser enforces it: see the
// joinability rule in lib/assignments.live().

const { db, now } = require('../db/database')
const { shortCode, safeJson } = require('./util')
const users = require('./users')
const assignments = require('./assignments')
const bans = require('./bans')
const progress = require('./partyProgress')
const maps = require('./maps')
const serverNotes = require('./serverNotes')

const MAX_PLAYERS = 4       // World at War has four client slots. This is the engine, not a policy.

function forPlayer(steamId) {
  const row = db.prepare(`SELECT p.* FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.steam_id=?`).get(String(steamId))
  return row ? project(row, steamId) : null
}

const byId = (id) => db.prepare('SELECT * FROM parties WHERE id=?').get(Number(id))
const byCode = (code) => db.prepare('SELECT * FROM parties WHERE code=?').get(String(code).toUpperCase())

function project(p, viewer = null) {
  if (!p) return null
  const members = db.prepare('SELECT * FROM party_members WHERE party_id=? ORDER BY joined_at').all(p.id)
  const map = p.map_key ? db.prepare('SELECT * FROM maps WHERE key=?').get(p.map_key) : null
  const prog = progress.forParty(p.id)
  return {
    id: p.id,
    code: p.code,
    leader: p.leader,
    mode: p.mode,
    map: map ? {
      key: map.key, title: map.title, art: map.art, main_finish: map.main_finish, round_n: map.round_n,
      // The card's Play stands down for a map no box will run, and says why on hover.
      on_server: maps.onServer(map), server_level: maps.serverLevel(map),
      server_note: serverNotes.noteFor(map, maps.onServer(map), maps.serverLevel(map)),
    } : null,
    visibility: p.visibility,
    state: p.state,
    match_id: p.match_id || null,
    settings: safeJson(p.settings_json, {}) || {},
    ready_since: p.ready_since || null,
    is_leader: viewer ? String(viewer) === String(p.leader) : false,
    members: members.map((m) => ({
      ...users.publicById(m.steam_id),
      ready: !!m.ready,
      joined_at: m.joined_at,
      // Where this member's copy of the staged map has got to, from their own launcher
      // (lib/partyProgress.js). Null is "their launcher has not said", which the panel
      // draws as nothing rather than as 0%.
      progress: prog[String(m.steam_id)] || null,
    })),
    full: members.length >= MAX_PLAYERS,
    all_ready: members.length > 0 && members.every((m) => m.ready),
    // The two halves of the Start button, kept apart so the panel can say WHICH one is
    // missing rather than just greying the control out.
    installs_ok: progress.installsOk(p.id, members.map((m) => m.steam_id)),
    installs_pending: progress.pending(p.id, members.map((m) => m.steam_id)),
    // The rail's roster draws these under the members, the way Movement's idle roster draws
    // the people it will invite: a row with a × that takes the invite back.
    invited: db.prepare("SELECT * FROM party_invites WHERE party_id=? AND state='pending' ORDER BY created_at").all(p.id)
      .map((i) => ({ ...users.publicById(i.to_steam), invite_id: i.id }))
      .filter((u) => u && u.steam_id),
  }
}

function create(steamId, { mode = 'verified', mapKey = null, visibility = 'friends' } = {}) {
  const existing = forPlayer(steamId)
  if (existing) return existing
  // The rail sends what it had staged before a party existed (Movement's idle lobby), so
  // these arrive from a request body and are checked here rather than trusted.
  if (!['verified', 'custom'].includes(mode)) mode = 'verified'
  if (!['private', 'friends', 'public'].includes(visibility)) visibility = 'friends'
  if (mapKey && !db.prepare('SELECT 1 FROM maps WHERE key=?').get(String(mapKey))) mapKey = null
  const code = shortCode(5)
  const info = db.prepare(`INSERT INTO parties (code, leader, mode, map_key, visibility, state, created_at, updated_at)
                           VALUES (?,?,?,?,?, 'forming', ?, ?)`)
    .run(code, String(steamId), mode, mapKey, visibility, now(), now())
  db.prepare('INSERT INTO party_members (party_id, steam_id, ready, joined_at) VALUES (?,?,0,?)').run(info.lastInsertRowid, String(steamId), now())
  return project(byId(info.lastInsertRowid), steamId)
}

function ensure(steamId) { return forPlayer(steamId) || create(steamId) }

function join(steamId, partyId) {
  const p = byId(partyId)
  if (!p) return { ok: false, error: 'no such party' }
  const members = db.prepare('SELECT COUNT(*) c FROM party_members WHERE party_id=?').get(p.id).c
  if (members >= MAX_PLAYERS) return { ok: false, error: 'that lobby is full' }
  // A pending invite is the leader's own say-so, so it opens a friends-only lobby as well as
  // a private one. Without that, accepting an invite from somebody you are not friends with
  // (the whole point of inviting by ENW name) was refused by the lobby that sent it.
  const invited = !!db.prepare("SELECT 1 FROM party_invites WHERE party_id=? AND to_steam=? AND state='pending'").get(p.id, String(steamId))
  if (p.visibility === 'private' && !invited) return { ok: false, error: 'that lobby is private' }
  if (p.visibility === 'friends' && !invited) {
    const friends = users.friendIds(p.leader)
    if (!friends.includes(String(steamId))) return { ok: false, error: "that lobby is friends-only" }
  }
  // A public-play ban keeps the player out of public lobbies and quick-join, and out of
  // nothing else — they can still play with their friends (05).
  if (p.visibility === 'public' && bans.publicBanned(steamId)) return { ok: false, error: 'you are banned from public lobbies' }
  leave(steamId)
  db.prepare('INSERT OR IGNORE INTO party_members (party_id, steam_id, ready, joined_at) VALUES (?,?,0,?)').run(p.id, String(steamId), now())
  db.prepare("UPDATE party_invites SET state='used' WHERE party_id=? AND to_steam=?").run(p.id, String(steamId))
  db.prepare('UPDATE parties SET updated_at=? WHERE id=?').run(now(), p.id)
  return { ok: true, party: project(byId(p.id), steamId) }
}

function leave(steamId) {
  const p = forPlayerRow(steamId)
  if (!p) return { ok: true }
  db.prepare('DELETE FROM party_members WHERE party_id=? AND steam_id=?').run(p.id, String(steamId))
  const left = db.prepare('SELECT * FROM party_members WHERE party_id=? ORDER BY joined_at').all(p.id)
  if (!left.length) { db.prepare('DELETE FROM parties WHERE id=?').run(p.id); progress.clear(p.id) }
  else if (String(p.leader) === String(steamId)) {
    // Leadership passes to whoever has been there longest rather than dissolving the lobby.
    db.prepare('UPDATE parties SET leader=?, updated_at=? WHERE id=?').run(left[0].steam_id, now(), p.id)
  }
  return { ok: true }
}

const forPlayerRow = (steamId) => db.prepare(`SELECT p.* FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.steam_id=?`).get(String(steamId))

function setMap(steamId, mapKey) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  db.prepare('UPDATE parties SET map_key=?, updated_at=? WHERE id=?').run(mapKey ? String(mapKey) : null, now(), p.party.id)
  clearReady(p.party.id)
  // A different map means every member's download progress is about a file nobody is
  // going to play. Keeping it would show four green bars for the wrong map.
  progress.clear(p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function setMode(steamId, mode) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  if (!['verified', 'custom'].includes(mode)) return { ok: false, error: 'unknown mode' }
  db.prepare('UPDATE parties SET mode=?, updated_at=? WHERE id=?').run(mode, now(), p.party.id)
  clearReady(p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function setVisibility(steamId, visibility) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  if (!['private', 'friends', 'public'].includes(visibility)) return { ok: false, error: 'unknown visibility' }
  db.prepare('UPDATE parties SET visibility=?, updated_at=? WHERE id=?').run(visibility, now(), p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function setSettings(steamId, settings) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  // A Verified lobby never gets custom knobs (05). The refusal is here rather than in the
  // UI because the UI is not the boundary.
  if (p.party.mode !== 'custom') return { ok: false, error: 'Verified games use the map’s stock settings' }
  db.prepare('UPDATE parties SET settings_json=?, updated_at=? WHERE id=?').run(JSON.stringify(settings || {}), now(), p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function mustLead(steamId) {
  const party = forPlayerRow(steamId)
  if (!party) return { ok: false, error: 'you are not in a party' }
  if (String(party.leader) !== String(steamId)) return { ok: false, error: 'only the leader can change that' }
  return { ok: true, party }
}

const clearReady = (partyId) => db.prepare('UPDATE party_members SET ready=0 WHERE party_id=?').run(partyId)

/** Step 1-2: the leader presses Start; everybody gets a Ready prompt. */
function startReadyCheck(steamId, { force = false } = {}) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  if (!p.party.map_key) return { ok: false, error: 'pick a map first' }
  // Nobody has the map yet? Then a ready check is asking people to promise something they
  // cannot keep. The refusal names who, so the panel says "waiting for X" rather than
  // greying a button for no stated reason, and `force` is the leader's override — the same
  // "THE LEADER DECIDES" this flow is built on.
  if (!force) {
    const ids = db.prepare('SELECT steam_id FROM party_members WHERE party_id=?').all(p.party.id).map((m) => m.steam_id)
    const waiting = progress.pending(p.party.id, ids)
    if (waiting.length) {
      return {
        ok: false,
        error: waiting.some((w) => w.state === 'failed') ? 'somebody could not install the map' : 'somebody is still downloading the map',
        waiting: waiting.map((w) => ({ ...users.publicById(w.steam_id), progress: w })),
      }
    }
  }
  db.prepare("UPDATE parties SET state='ready-check', ready_since=?, updated_at=? WHERE id=?").run(now(), now(), p.party.id)
  // The leader is ready by pressing Start. Making them click twice is the kind of ceremony
  // B's tone note is about.
  db.prepare('UPDATE party_members SET ready=1 WHERE party_id=? AND steam_id=?').run(p.party.id, String(steamId))
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function setReady(steamId, ready) {
  const party = forPlayerRow(steamId)
  if (!party) return { ok: false, error: 'you are not in a party' }
  db.prepare('UPDATE party_members SET ready=? WHERE party_id=? AND steam_id=?').run(ready ? 1 : 0, party.id, String(steamId))
  return { ok: true, party: project(byId(party.id), steamId) }
}

function cancelReadyCheck(steamId) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  db.prepare("UPDATE parties SET state='forming', ready_since=NULL, updated_at=? WHERE id=?").run(now(), p.party.id)
  clearReady(p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

/**
 * Step 3: the leader launches. `force` is "start anyway" — the leader's call when somebody
 * is not ready. The unready members are not dropped: they can late-join, and the referee
 * will mark the game `late_join` and give them nothing from it.
 */
function launch(steamId, { force = false } = {}) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  const party = p.party
  if (!party.map_key) return { ok: false, error: 'pick a map first' }
  const members = db.prepare('SELECT * FROM party_members WHERE party_id=? ORDER BY joined_at').all(party.id)
  const ready = members.filter((m) => m.ready)
  if (!force && ready.length !== members.length) {
    return { ok: false, error: 'not everyone is ready', waiting: members.filter((m) => !m.ready).map((m) => users.publicById(m.steam_id)) }
  }
  const players = (force ? ready : members).map((m) => {
    const u = users.publicById(m.steam_id)
    return { steamid: m.steam_id, name: (u && u.name) || m.steam_id }
  })
  if (!players.length) return { ok: false, error: 'nobody is ready' }

  const res = assignments.lease({
    mapKey: party.map_key,
    mode: party.mode,
    players,
    settings: safeJson(party.settings_json, {}) || {},
    partyId: party.id,
    by: String(steamId),
  })
  if (!res.ok) return res
  db.prepare("UPDATE parties SET state='launching', match_id=?, updated_at=? WHERE id=?").run(res.match_id, now(), party.id)
  progress.clear(party.id)
  return { ok: true, match_id: res.match_id, box: res.box, party: project(byId(party.id), steamId) }
}

/**
 * The connect details ONE player is allowed to see: their own invite token and nothing
 * anybody else's. The token never goes out in a party payload that another member can read.
 */
function launchInfo(steamId) {
  const party = forPlayerRow(steamId)
  if (!party || !party.match_id) return null
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(party.match_id)
  if (!a) return null
  const tokens = safeJson(a.tokens_json, {}) || {}
  return {
    match_id: a.match_id,
    map: a.map_key,
    fs_game: a.fs_game,
    mode: a.mode,
    state: a.state,
    token: tokens[String(steamId)] || null,
    // The connect string is filled in by the box's status report; until the box says ready
    // there is nothing to connect to and the launcher shows "Reserving server".
    connect: a.state === 'ready' || a.state === 'live' ? connectFor(a) : null,
  }
}

// The string the player's game dials. Two halves, from two different places on purpose:
//
//   the PORT comes from the box's status, because only the box knows which instance got
//   which port;
//   the ADDRESS comes from `boxes.address`, which is provision-time data, and only falls
//   back to the box's own `host.public_ip` when nobody has set one.
//
// That asymmetry is the point. A box that can name its own connect address can name
// somebody else's, and this string is what a client connects to — so the site prefers the
// value an operator wrote down over the value a box asserts.
function connectFor(a) {
  const box = db.prepare('SELECT address, last_status_json FROM boxes WHERE id=?').get(a.box_id) || {}
  const st = safeJson(box.last_status_json, null)
  if (!st || !Array.isArray(st.instances)) return null
  // THIS match's instance and no other. Falling back to `instances[0]` was harmless while
  // a box ran one game; with several (lib/assignments.js) it hands a player another
  // party's server. No instance yet means no connect yet, and the launcher keeps waiting.
  const inst = st.instances.find((i) => i.match_id === a.match_id)
  if (!inst || !inst.port) return null
  const host = box.address || (st.host && st.host.public_ip) || null
  return host ? `${host}:${inst.port}` : null
}

/**
 * A member's launcher reporting its map download (`docs/protocol/launcher-v0.md`).
 *
 * The caller has to BE a member of the party it names — the session cookie is the identity,
 * the party id in the URL is only which party, and a launcher cannot report on anybody
 * else's behalf. It is also refused once the party has left `forming`/`ready-check`: after
 * the lease there is nothing left for a download to be in time for.
 */
function reportProgress(steamId, partyId, body) {
  const party = byId(partyId)
  if (!party) return { ok: false, error: 'no such party' }
  const member = db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND steam_id=?').get(party.id, String(steamId))
  if (!member) return { ok: false, error: 'you are not in that party' }
  const out = progress.push(party.id, steamId, body || {})
  if (!out.ok) return out
  const ids = db.prepare('SELECT steam_id FROM party_members WHERE party_id=? ORDER BY joined_at').all(party.id).map((m) => m.steam_id)
  if (out.stored) progress.broadcast(party.id, ids)
  return { ok: true, stored: !!out.stored, progress: out.progress, installs_ok: progress.installsOk(party.id, ids) }
}

/**
 * Invite somebody into your party: by SteamID or by ENW name, the rail's two ways in.
 *
 * On Movement you are always a lobby of one, and inviting before anything is spun up just
 * stages the name. Here a party is a row, so an invite from somebody with no party MAKES
 * one, carrying what the rail had staged (`stage`: map_key, mode, visibility). Same outcome,
 * and the invitee has a real lobby to accept into.
 */
function invite(from, to, stage = null) {
  const target = users.byId(String(to || ''))
  if (!target || target.deleted) return { ok: false, error: 'no player by that name' }
  if (String(target.steam_id) === String(from)) return { ok: false, error: 'that is you' }
  if (!forPlayerRow(from)) {
    const st = stage || {}
    create(from, { mode: st.mode || 'verified', mapKey: st.map_key || null, visibility: st.visibility || 'friends' })
  }
  const party = forPlayerRow(from)
  if (db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND steam_id=?').get(party.id, target.steam_id)) {
    return { ok: false, error: 'they are already in your party' }
  }
  const n = db.prepare('SELECT COUNT(*) c FROM party_members WHERE party_id=?').get(party.id).c
  if (n >= MAX_PLAYERS) return { ok: false, error: 'your party is full' }
  // One pending invite per person per party: pressing + twice is one invite, not two rows
  // on the invitee's rail.
  const pending = db.prepare("SELECT id FROM party_invites WHERE party_id=? AND to_steam=? AND state='pending'").get(party.id, target.steam_id)
  if (!pending) {
    db.prepare(`INSERT INTO party_invites (party_id, from_steam, to_steam, state, created_at) VALUES (?,?,?, 'pending', ?)`)
      .run(party.id, String(from), target.steam_id, now())
  }
  return { ok: true, to: users.pub(target), party: project(byId(party.id), from) }
}

/** The invitee says no. Only the invitee can, and only to an invite addressed to them. */
function declineInvite(steamId, inviteId) {
  const r = db.prepare("UPDATE party_invites SET state='declined' WHERE id=? AND to_steam=? AND state='pending'").run(Number(inviteId), String(steamId))
  return r.changes ? { ok: true } : { ok: false, error: 'no such invite' }
}

/** A member takes back an invite their party sent: the × on an "invited" row. */
function cancelInvite(steamId, inviteId) {
  const party = forPlayerRow(steamId)
  if (!party) return { ok: false, error: 'you are not in a party' }
  const r = db.prepare("UPDATE party_invites SET state='cancelled' WHERE id=? AND party_id=? AND state='pending'").run(Number(inviteId), party.id)
  return r.changes ? { ok: true, party: project(byId(party.id), steamId) } : { ok: false, error: 'no such invite' }
}

/** The leader removes a member: Movement's × on a roster row, the host's alone. */
function kick(steamId, target) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  if (String(target) === String(steamId)) return { ok: false, error: 'leave instead' }
  const r = db.prepare('DELETE FROM party_members WHERE party_id=? AND steam_id=?').run(p.party.id, String(target))
  if (!r.changes) return { ok: false, error: 'they are not in your party' }
  clearReady(p.party.id)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

const invitesFor = (steamId) => db.prepare(`SELECT i.*, p.map_key, p.mode, m.title AS map_title, m.art AS map_art
                                              FROM party_invites i JOIN parties p ON p.id=i.party_id
                                              LEFT JOIN maps m ON m.key=p.map_key
                                             WHERE i.to_steam=? AND i.state='pending' ORDER BY i.created_at DESC`).all(String(steamId))
  .map((i) => ({
    id: i.id, party_id: i.party_id, from: users.publicById(i.from_steam),
    map_key: i.map_key, map_title: i.map_title || null, map_art: i.map_art || null, mode: i.mode, at: i.created_at,
  }))

/** "Find a game": any public lobby on this map with room, or nothing. */
function quickJoin(steamId, mapKey) {
  if (bans.publicBanned(steamId)) return { ok: false, error: 'you are banned from public lobbies' }
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM party_members m WHERE m.party_id=p.id) n
                             FROM parties p WHERE p.visibility='public' AND p.state IN ('forming','ready-check')
                             ${mapKey ? 'AND p.map_key=?' : ''} ORDER BY n DESC`).all(...(mapKey ? [String(mapKey)] : []))
  const target = rows.find((r) => r.n < MAX_PLAYERS)
  if (!target) return { ok: false, error: 'no open lobby' }
  return join(steamId, target.id)
}

function publicLobbies(mapKey = null) {
  const rows = db.prepare(`SELECT * FROM parties WHERE visibility='public' AND state IN ('forming','ready-check','in-game')
                           ${mapKey ? 'AND map_key=?' : ''} ORDER BY updated_at DESC`).all(...(mapKey ? [String(mapKey)] : []))
  return rows.map((r) => project(r))
}

module.exports = {
  MAX_PLAYERS, forPlayer, byId, byCode, project, create, ensure, join, leave,
  setMap, setMode, setVisibility, setSettings,
  startReadyCheck, setReady, cancelReadyCheck, launch, launchInfo, reportProgress,
  invite, invitesFor, declineInvite, cancelInvite, kick, quickJoin, publicLobbies, forPlayerRow,
}
