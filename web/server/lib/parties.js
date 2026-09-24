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
const gameModes = require('./gameModes')   // a map's own modes (game-modes.md)

const MAX_PLAYERS = 4       // World at War has four client slots. This is the engine, not a policy.

// ── Invites: Movement's party invites (CSGO-Matchmaker server/lib/party.js, origin/main),
//    ported onto the zombies party row. See the INVITES block near the foot of this file.
//
// An invite is good for half an hour. Movement's never expire; ours do, because an invite
// here is also a key (it opens a friends-only or private lobby, `join`), and a key that
// works forever is a key nobody remembers handing out.
const INVITE_TTL_MS = 30 * 60 * 1000
const fresh = () => now() - INVITE_TTL_MS
const { addColumn } = require('../db/database')
// The invite LINK's code. Its own column rather than `parties.code`, which public lobbies
// already show to everybody (publicLobbies): the link opens a private lobby, so its code is
// handed out by the party and nowhere else, and the leader can change it.
addColumn('parties', 'link_code', 'TEXT')
// [PC] The map the leader is switching to while the party's game runs (switchMap), and when
// they asked. The game goes on until the switch happens.
addColumn('parties', 'pending_map_key', 'TEXT')
addColumn('parties', 'pending_since', 'INTEGER')
// [PC] The match a switched-to game replaces: the launcher ends ITS game for that one only.
addColumn('assignments', 'switched_from', 'TEXT')

// ── B's defaults for a party that carries over (cloud-brief-parties.md §3). B may change
//    these; each is one named constant.
// A map switch takes everyone straight into the new game (false: back to the ready check).
const SWITCH_STRAIGHT_IN = true
// A member whose launcher has said nothing about the pending map counts as having it after
// this long (silence is not a refusal, partyProgress.pending). Somebody who IS downloading
// holds the switch until they finish, or the leader presses Switch now.
const SWITCH_SILENCE_MS = 30_000

// Socket fan-out, set by server/index.js: (steamIds[], event, payload) => void. Movement's
// realtime.emitUser, with the same event names: invite_received, invite_withdrawn,
// party_updated (with a `notice` for the toast).
let emit = null
function setEmitter(fn) { emit = fn }
function tell(steamIds, event, payload) {
  if (!emit) return
  try { emit([...new Set((steamIds || []).map(String))], event, payload) } catch { /* a dead socket must not fail a party action */ }
}
const memberIds = (partyId) => db.prepare('SELECT steam_id FROM party_members WHERE party_id=?').all(Number(partyId)).map((m) => m.steam_id)
const nameOf = (sid) => ((users.publicById(sid) || {}).name) || 'someone'
function tellParty(partyId, notice = null, except = null) {
  const ids = memberIds(partyId).filter((s) => s !== String(except || ''))
  tell(ids, 'party_updated', { party_id: Number(partyId), notice })
}

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
      // The map's own game modes (UGX's Classic / Gun Game / ...), for the leader's picker.
      modes: gameModes.forMap(map.key),
    } : null,
    // The mode this party will play: the leader's pick, or the map's default. Null for a map
    // without modes.
    game_mode: map ? gameModes.resolve(map.key, p.game_mode) : null,
    visibility: p.visibility,
    state: p.state,
    match_id: p.match_id || null,
    // [PC] The leader is switching the party's game to this map (switchMap); null otherwise.
    pending_map: pendingView(p),
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
    invited: db.prepare("SELECT * FROM party_invites WHERE party_id=? AND state='pending' AND created_at > ? ORDER BY created_at").all(p.id, fresh())
      .map((i) => ({ ...users.publicById(i.to_steam), invite_id: i.id }))
      .filter((u) => u && u.steam_id),
  }
}

function create(steamId, { mode = 'verified', mapKey = null, visibility = 'friends', gameMode = null } = {}) {
  const existing = forPlayer(steamId)
  if (existing) return existing
  // The rail sends what it had staged before a party existed (Movement's idle lobby), so
  // these arrive from a request body and are checked here rather than trusted.
  if (!['verified', 'custom'].includes(mode)) mode = 'verified'
  if (!['private', 'friends', 'public'].includes(visibility)) visibility = 'friends'
  if (mapKey && !db.prepare('SELECT 1 FROM maps WHERE key=?').get(String(mapKey))) mapKey = null
  // Only a mode the map offers is kept; anything else is the map's default (stored as NULL).
  const gm = mapKey && gameMode != null && gameModes.resolve(mapKey, gameMode) === String(gameMode) ? String(gameMode) : null
  const code = shortCode(5)
  const info = db.prepare(`INSERT INTO parties (code, leader, mode, map_key, visibility, state, created_at, updated_at, game_mode)
                           VALUES (?,?,?,?,?, 'forming', ?, ?, ?)`)
    .run(code, String(steamId), mode, mapKey, visibility, now(), now(), gm)
  db.prepare('INSERT INTO party_members (party_id, steam_id, ready, joined_at) VALUES (?,?,0,?)').run(info.lastInsertRowid, String(steamId), now())
  return project(byId(info.lastInsertRowid), steamId)
}

function ensure(steamId) { return forPlayer(steamId) || create(steamId) }

function join(steamId, partyId, { viaLink = false } = {}) {
  const p = byId(partyId)
  if (!p) return { ok: false, error: 'no such party' }
  if (db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND steam_id=?').get(p.id, String(steamId))) {
    return { ok: true, party: project(p, steamId) }
  }
  const members = db.prepare('SELECT COUNT(*) c FROM party_members WHERE party_id=?').get(p.id).c
  if (members >= MAX_PLAYERS) return { ok: false, error: 'that lobby is full' }
  // A pending invite is the leader's own say-so, so it opens a friends-only lobby as well as
  // a private one. Without that, accepting an invite from somebody you are not friends with
  // (the whole point of inviting by ENW name) was refused by the lobby that sent it. So is
  // the party's invite link: holding it is the same say-so, handed over by a member.
  const invited = viaLink || !!db.prepare("SELECT 1 FROM party_invites WHERE party_id=? AND to_steam=? AND state='pending' AND created_at > ?").get(p.id, String(steamId), fresh())
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
  db.prepare("UPDATE party_invites SET state='used' WHERE party_id=? AND to_steam=? AND state='pending'").run(p.id, String(steamId))
  db.prepare('UPDATE parties SET updated_at=? WHERE id=?').run(now(), p.id)
  tellParty(p.id, { kind: 'joined', username: nameOf(steamId) }, steamId)
  // [PC] The party's game is running: the joiner inherits it (cloud-brief-parties.md task 2).
  // Their launcher follows the match as any member's does (seats.phaseOf -> `in-game`), now
  // with a token of their own. A full game refuses them politely; they stay in the party.
  let game = null
  if (p.match_id) {
    const r = assignments.addPlayer(p.match_id, { steamid: String(steamId) }, String(steamId))
    game = r.ok ? { match_id: r.match_id, joined: true } : { match_id: p.match_id, joined: false, error: r.error }
    if (r.ok && !r.already) tellParty(p.id, { kind: 'joined_game', username: nameOf(steamId), match_id: r.match_id })
  }
  return { ok: true, party: project(byId(p.id), steamId), ...(game ? { game } : {}) }
}

function leave(steamId) {
  const p = forPlayerRow(steamId)
  if (!p) return { ok: true }
  db.prepare('DELETE FROM party_members WHERE party_id=? AND steam_id=?').run(p.id, String(steamId))
  const left = db.prepare('SELECT * FROM party_members WHERE party_id=? ORDER BY joined_at').all(p.id)
  if (!left.length) {
    // Movement's detachFromParty: the party is gone, so is every invite into it, and each
    // person holding one is told rather than left with a card that errors on Accept.
    const pend = db.prepare("SELECT id, to_steam FROM party_invites WHERE party_id=? AND state='pending' AND created_at > ?").all(p.id, fresh())
    db.prepare('DELETE FROM parties WHERE id=?').run(p.id); progress.clear(p.id)
    for (const i of pend) tell([i.to_steam], 'invite_withdrawn', { invite_id: i.id, party_id: p.id, notice: { kind: 'closed', username: nameOf(steamId) } })
  } else {
    if (String(p.leader) === String(steamId)) {
      // Leadership passes to whoever has been there longest rather than dissolving the lobby.
      db.prepare('UPDATE parties SET leader=?, updated_at=? WHERE id=?').run(left[0].steam_id, now(), p.id)
    }
    tellParty(p.id, { kind: 'left', username: nameOf(steamId) })
  }
  return { ok: true }
}

const forPlayerRow = (steamId) => db.prepare(`SELECT p.* FROM party_members pm JOIN parties p ON p.id=pm.party_id WHERE pm.steam_id=?`).get(String(steamId))

function setMap(steamId, mapKey) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  // A new map starts on ITS default mode: another map's pick means nothing here.
  const same = String(p.party.map_key || '') === String(mapKey || '')
  db.prepare('UPDATE parties SET map_key=?, game_mode=?, updated_at=? WHERE id=?')
    .run(mapKey ? String(mapKey) : null, same ? p.party.game_mode : null, now(), p.party.id)
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

/**
 * The leader picks the map's own game mode (game-modes.md). Verified and Custom alike: the
 * mode is the map's content, not a setting, and records are kept per mode either way.
 */
function setGameMode(steamId, id) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  const offered = p.party.map_key ? gameModes.forMap(p.party.map_key) : null
  if (!offered) return { ok: false, error: 'this map has no game modes' }
  if (!offered.modes.some((m) => m.id === String(id))) return { ok: false, error: 'that mode is not on this map' }
  db.prepare('UPDATE parties SET game_mode=?, updated_at=? WHERE id=?').run(String(id), now(), p.party.id)
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

// ── [PC] SWITCHING MAP WHILE A GAME RUNS (cloud-brief-parties.md task 3) ───────────────────
//
// B: "changing map while a server is running switches the party's server, instead of
// refusing." We close the old server and open a new one rather than changing map in place (a
// custom map needs its own fs_game, so a fresh process anyway). The switch waits until nobody
// is still downloading the new map, or the leader presses Switch now; then everybody is made
// ready and the party launches with force. The new lease supersedes the old one (lease() rule
// 1: the same party) and carries `switched_from`, which is the ONE thing that lets a member's
// launcher end the game it is running (launcher followgate.js).

/** The party's game, if one is running (a live-state lease), else null. */
function runningGame(party) {
  if (!party || !party.match_id) return null
  const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(party.match_id)
  return a && ['leased', 'ready', 'live'].includes(a.state) ? a : null
}

function pendingView(p) {
  if (!p || !p.pending_map_key) return null
  const m = db.prepare('SELECT key, title FROM maps WHERE key=?').get(p.pending_map_key)
  const ids = memberIds(p.id)
  return { key: p.pending_map_key, title: (m && m.title) || p.pending_map_key, since: p.pending_since || null, waiting: switchWaiting(p, ids).map((w) => ({ ...users.publicById(w.steam_id), state: w.state, pct: w.pct == null ? null : w.pct })) }
}

// Who the switch is still waiting for: anybody downloading or failed, and, inside the silence
// window, anybody whose launcher has not said it has the map. A stock map needs nobody.
function switchWaiting(p, ids) {
  const m = db.prepare('SELECT source FROM maps WHERE key=?').get(p.pending_map_key)
  if (m && m.source === 'stock') return []
  const out = progress.pending(p.id, ids)
  if (now() - (p.pending_since || 0) >= SWITCH_SILENCE_MS) return out
  const said = progress.forParty(p.id)
  for (const sid of ids) if (!said[String(sid)]) out.push({ steam_id: String(sid), state: 'silent', pct: null })
  return out
}

function switchMap(steamId, mapKey) {
  const lead = mustLead(steamId)
  if (!lead.ok) return lead
  const party = lead.party
  const key = mapKey ? String(mapKey) : ''
  const map = key ? db.prepare('SELECT * FROM maps WHERE key=?').get(key) : null
  if (!map) return { ok: false, error: 'no such map' }
  if (!runningGame(party)) return setMap(steamId, key)        // no game running: an ordinary change
  if (!maps.onServer(map)) return { ok: false, error: 'that map does not run on our servers yet' }
  if (String(party.map_key) === key) return cancelSwitch(steamId)   // back to the map being played
  db.prepare('UPDATE parties SET pending_map_key=?, pending_since=?, updated_at=? WHERE id=?').run(key, now(), now(), party.id)
  // Progress is about the pending map from here on.
  progress.clear(party.id)
  tellParty(party.id, { kind: 'switch_pending', username: nameOf(steamId), map: key }, steamId)
  const done = maybeSwitch(party.id, { by: String(steamId) })
  return { ok: true, pending: !done.switched, ...(done.switched ? { match_id: done.match_id } : {}), ...(done.error ? { error_detail: done.error } : {}), party: project(byId(party.id), steamId) }
}

function cancelSwitch(steamId) {
  const lead = mustLead(steamId)
  if (!lead.ok) return lead
  if (lead.party.pending_map_key) {
    db.prepare('UPDATE parties SET pending_map_key=NULL, pending_since=NULL, updated_at=? WHERE id=?').run(now(), lead.party.id)
    progress.clear(lead.party.id)
    tellParty(lead.party.id, { kind: 'switch_cancelled', username: nameOf(steamId) }, steamId)
  }
  return { ok: true, party: project(byId(lead.party.id), steamId) }
}

function switchNow(steamId) {
  const lead = mustLead(steamId)
  if (!lead.ok) return lead
  if (!lead.party.pending_map_key) return { ok: false, error: 'no map switch is pending' }
  const done = maybeSwitch(lead.party.id, { force: true, by: String(steamId) })
  if (done.error) return { ok: false, error: done.error }
  return { ok: true, switched: !!done.switched, ...(done.match_id ? { match_id: done.match_id } : {}), party: project(byId(lead.party.id), steamId) }
}

/**
 * Switch now if nobody is still downloading (or `force`). Called from switchMap, every
 * progress report and every launcher/rail poll, so a switch happens within a poll of the last
 * download finishing. Cheap and a no-op for a party with nothing pending.
 */
function maybeSwitch(partyId, { force = false, by = null } = {}) {
  const party = byId(partyId)
  if (!party || !party.pending_map_key) return { switched: false }
  const old = runningGame(party)
  if (!old) {
    // The game ended on its own meanwhile: the pending map is simply the party's map now.
    db.prepare('UPDATE parties SET map_key=?, game_mode=NULL, pending_map_key=NULL, pending_since=NULL, updated_at=? WHERE id=?')
      .run(party.pending_map_key, now(), party.id)
    return { switched: false, applied: true }
  }
  const ids = memberIds(party.id)
  if (!force && switchWaiting(party, ids).length) return { switched: false, waiting: true }

  const key = party.pending_map_key
  const restore = db.prepare('UPDATE parties SET map_key=?, game_mode=?, pending_map_key=?, pending_since=?, state=?, updated_at=? WHERE id=?')
  db.prepare('UPDATE parties SET map_key=?, game_mode=NULL, pending_map_key=NULL, pending_since=NULL, updated_at=? WHERE id=?').run(key, now(), party.id)
  if (!SWITCH_STRAIGHT_IN) {
    assignments.cancel(old.match_id, by || party.leader)
    db.prepare("UPDATE parties SET state='forming', match_id=NULL, ready_since=NULL WHERE id=?").run(party.id)
    clearReady(party.id)
    tellParty(party.id, { kind: 'switched', map: key, match_id: null })
    return { switched: true, match_id: null }
  }
  db.prepare('UPDATE party_members SET ready=1 WHERE party_id=?').run(party.id)
  db.prepare("UPDATE parties SET state='ready-check', ready_since=? WHERE id=?").run(now(), party.id)
  const r = launch(party.leader, { force: true })
  if (!r.ok) {
    restore.run(party.map_key, party.game_mode, key, party.pending_since, party.state, now(), party.id)
    clearReady(party.id)
    return { switched: false, error: r.error || 'the switch could not start the new game' }
  }
  db.prepare('UPDATE assignments SET switched_from=? WHERE match_id=?').run(old.match_id, r.match_id)
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('party.switch_map', ?, ?, ?)")
    .run(by || null, JSON.stringify({ party_id: party.id, from_match: old.match_id, from_map: party.map_key, to_match: r.match_id, to_map: key, forced: !!force }), now())
  tellParty(party.id, { kind: 'switched', map: key, match_id: r.match_id })
  return { switched: true, match_id: r.match_id }
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
    gameMode: party.game_mode,
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
    // [PC] The match this one replaced (a map switch): the launcher ends that game, and only that.
    switched_from: a.switched_from || null,
    // [PC] A player who has never connected to this match (a party member who joined while
    // it was running and is still downloading its map) gets their expired token replaced.
    token: (require('./seats').stateOf(a.match_id, steamId) === 'never' ? assignments.freshToken(a, steamId) : tokens[String(steamId)]) || null,
    // The connect string is filled in by the box's status report; until the box says ready
    // there is nothing to connect to and the launcher shows "Reserving server".
    connect: a.state === 'ready' || a.state === 'live' ? connectFor(a) : null,
    // The box is pulling (or checking) this game's map before it boots it: "Preparing
    // map..." with bytes, or null. From the box's own status (infra/host-agent/host.js).
    preparing: a.state === 'leased' ? preparingFor(a) : null,
  }
}

/** { phase, bytes_done, bytes_total, percent } while the box prepares this lease's map. */
function preparingFor(a) {
  const box = db.prepare('SELECT last_status_json FROM boxes WHERE id=?').get(a.box_id) || {}
  const st = safeJson(box.last_status_json, null)
  if (!st) return null
  // The newest word first: a per-game `preparing` post (every ~2 s) beats the heartbeat's
  // instance list (every 10 s), which the per-game post carries over unchanged.
  const inst = Array.isArray(st.instances) ? st.instances.find((i) => i && i.match_id === a.match_id && i.preparing) : null
  const p = (st.state === 'preparing' && st.match_id === a.match_id ? st.preparing : null) || (inst && inst.preparing)
  if (!p || typeof p !== 'object') return null
  const n = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0)
  const out = { phase: String(p.phase || 'downloading').slice(0, 20), bytes_done: n(p.bytes_done), bytes_total: n(p.bytes_total), percent: Math.min(100, n(p.percent)) }
  // `queued` (host.md §16): the box has the lease and is waiting to start its game - one game
  // boots at a time, a player's first - or waiting for memory. `ahead` is how many boots go
  // first; the launcher says so instead of a silent "Reserving server" (B cancelled at 30 s).
  if (out.phase === 'queued') {
    out.ahead = Math.min(16, n(p.ahead))
    out.reason = p.reason === 'memory' ? 'memory' : 'boot'
  }
  return out
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
  if (party.pending_map_key) maybeSwitch(party.id)
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
    create(from, { mode: st.mode || 'verified', mapKey: st.map_key || null, visibility: st.visibility || 'friends', gameMode: st.game_mode || null })
  }
  const party = forPlayerRow(from)
  if (db.prepare('SELECT 1 FROM party_members WHERE party_id=? AND steam_id=?').get(party.id, target.steam_id)) {
    return { ok: false, error: 'they are already in your party' }
  }
  const n = db.prepare('SELECT COUNT(*) c FROM party_members WHERE party_id=?').get(party.id).c
  if (n >= MAX_PLAYERS) return { ok: false, error: 'your party is full' }
  // One pending invite per person per party: pressing + twice is one invite, not two rows
  // on the invitee's rail. An EXPIRED one is closed and a fresh one made, so inviting
  // somebody again after the half hour works and restarts the clock.
  db.prepare("UPDATE party_invites SET state='expired' WHERE party_id=? AND to_steam=? AND state='pending' AND created_at <= ?").run(party.id, target.steam_id, fresh())
  const pending = db.prepare("SELECT id FROM party_invites WHERE party_id=? AND to_steam=? AND state='pending'").get(party.id, target.steam_id)
  let inviteId = pending ? pending.id : null
  if (!pending) {
    inviteId = db.prepare(`INSERT INTO party_invites (party_id, from_steam, to_steam, state, created_at) VALUES (?,?,?, 'pending', ?)`)
      .run(party.id, String(from), target.steam_id, now()).lastInsertRowid
    // Movement: invite_received to the invitee (their toast), party_updated to the party.
    const card = invitesFor(target.steam_id).find((i) => Number(i.id) === Number(inviteId)) || null
    tell([target.steam_id], 'invite_received', { invite: card })
    tellParty(party.id, null)
  }
  return { ok: true, to: users.pub(target), invite_id: Number(inviteId), party: project(byId(party.id), from) }
}

/**
 * The invitee says yes: Movement's acceptInvite (`POST /api/party/invites/:id/accept`). Only
 * the invitee, only a pending invite, only inside its half hour; then it is `join`, which
 * the invite itself lets through a friends-only or private lobby.
 */
function acceptInvite(steamId, inviteId) {
  const inv = db.prepare('SELECT * FROM party_invites WHERE id=? AND to_steam=?').get(Number(inviteId), String(steamId))
  if (!inv || inv.state !== 'pending') return { ok: false, error: 'that invite is gone' }
  if (inv.created_at <= fresh()) {
    db.prepare("UPDATE party_invites SET state='expired' WHERE id=?").run(inv.id)
    return { ok: false, error: 'that invite expired' }
  }
  if (!byId(inv.party_id)) return { ok: false, error: 'that party no longer exists' }
  return join(steamId, inv.party_id)
}

/** The invitee says no. Only the invitee can, and only to an invite addressed to them. */
function declineInvite(steamId, inviteId) {
  const inv = db.prepare("SELECT * FROM party_invites WHERE id=? AND to_steam=? AND state='pending'").get(Number(inviteId), String(steamId))
  if (!inv) return { ok: false, error: 'no such invite' }
  db.prepare("UPDATE party_invites SET state='declined' WHERE id=?").run(inv.id)
  // Movement's notice: the party sees "<name> declined."
  tellParty(inv.party_id, { kind: 'declined', username: nameOf(steamId) })
  return { ok: true }
}

/** A member takes back an invite their party sent: the × on an "invited" row. */
function cancelInvite(steamId, inviteId) {
  const party = forPlayerRow(steamId)
  if (!party) return { ok: false, error: 'you are not in a party' }
  const inv = db.prepare("SELECT * FROM party_invites WHERE id=? AND party_id=? AND state='pending'").get(Number(inviteId), party.id)
  if (!inv) return { ok: false, error: 'no such invite' }
  db.prepare("UPDATE party_invites SET state='cancelled' WHERE id=?").run(inv.id)
  // Movement's withdrawInvite: the invitee's card goes, with a word about why.
  tell([inv.to_steam], 'invite_withdrawn', { invite_id: inv.id, party_id: party.id, notice: { kind: 'withdrawn', username: nameOf(steamId) } })
  tellParty(party.id, null, steamId)
  return { ok: true, party: project(byId(party.id), steamId) }
}

/** The leader removes a member: Movement's × on a roster row, the host's alone. */
function kick(steamId, target) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  if (String(target) === String(steamId)) return { ok: false, error: 'leave instead' }
  const r = db.prepare('DELETE FROM party_members WHERE party_id=? AND steam_id=?').run(p.party.id, String(target))
  if (!r.changes) return { ok: false, error: 'they are not in your party' }
  clearReady(p.party.id)
  tell([String(target)], 'party_updated', { party_id: p.party.id, notice: { kind: 'kicked', username: nameOf(steamId) } })
  tellParty(p.party.id, { kind: 'removed', username: nameOf(target) }, steamId)
  return { ok: true, party: project(byId(p.party.id), steamId) }
}

function invitesFor(steamId) {
  return db.prepare(`SELECT i.*, p.map_key, p.mode, m.title AS map_title, m.art AS map_art,
                            (SELECT COUNT(*) FROM party_members pm WHERE pm.party_id=p.id) AS size
                       FROM party_invites i JOIN parties p ON p.id=i.party_id
                       LEFT JOIN maps m ON m.key=p.map_key
                      WHERE i.to_steam=? AND i.state='pending' AND i.created_at > ? ORDER BY i.created_at DESC`).all(String(steamId), fresh())
    .map((i) => ({
      id: i.id, party_id: i.party_id, from: users.publicById(i.from_steam),
      map_key: i.map_key, map_title: i.map_title || null, map_art: i.map_art || null, mode: i.mode, at: i.created_at,
      size: i.size, expires_at: i.created_at + INVITE_TTL_MS,
    }))
}

// ── the invite LINK ─────────────────────────────────────────────────────────────
// `https://<site>/party/<CODE>` and `enw-zombies://party/<CODE>` (the launcher opens the
// second as the first: launcher/src/main/deeplink.js, launcher-v0 §7). Movement's closest
// thing is GOnext's custom-lobby join code (lib/codes.js alphabet, `/custom/join/:code`);
// the code here is the party's, so anyone a member hands it to can join while the party
// lasts. The leader can change it, which kills the old link.
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const LINK_LEN = 8
function newLinkCode() {
  const crypto = require('crypto')
  for (let tries = 0; tries < 20; tries++) {
    const b = crypto.randomBytes(LINK_LEN)
    let c = ''
    for (let i = 0; i < LINK_LEN; i++) c += LINK_ALPHABET[b[i] % 32]
    if (!db.prepare('SELECT 1 FROM parties WHERE link_code=?').get(c)) return c
  }
  throw new Error('could not mint a link code')
}
const isLinkCode = (s) => new RegExp(`^[${LINK_ALPHABET}]{${LINK_LEN}}$`).test(String(s || '').toUpperCase())

/** Your party's link (any member may share it). A party of one is made from `stage`, as invite() does. */
function link(steamId, stage = null) {
  if (!forPlayerRow(steamId)) {
    const st = stage || {}
    create(steamId, { mode: st.mode || 'verified', mapKey: st.map_key || null, visibility: st.visibility || 'friends', gameMode: st.game_mode || null })
  }
  const p = forPlayerRow(steamId)
  let code = p.link_code
  if (!code) {
    code = newLinkCode()
    db.prepare('UPDATE parties SET link_code=? WHERE id=?').run(code, p.id)
  }
  return { ok: true, code, path: `/party/${code}`, deeplink: `enw-zombies://party/${code}` }
}

function resetLink(steamId) {
  const p = mustLead(steamId)
  if (!p.ok) return p
  db.prepare('UPDATE parties SET link_code=? WHERE id=?').run(newLinkCode(), p.party.id)
  return link(steamId)
}

const byLink = (code) => (isLinkCode(code) ? db.prepare('SELECT * FROM parties WHERE link_code=?').get(String(code).toUpperCase()) : null)

/** What the link's landing card shows: whose party, which map, how full. Nothing else. */
function linkPreview(code, viewer = null) {
  const p = byLink(code)
  if (!p) return { ok: false, error: 'that link is dead' }
  const n = memberIds(p.id).length
  const map = p.map_key ? db.prepare('SELECT key, title, art FROM maps WHERE key=?').get(p.map_key) : null
  return {
    ok: true,
    party: {
      id: p.id, leader: users.publicById(p.leader), size: n, full: n >= MAX_PLAYERS, mode: p.mode, state: p.state,
      map: map ? { key: map.key, title: map.title, art: map.art } : null,
      mine: viewer ? memberIds(p.id).includes(String(viewer)) : false,
    },
  }
}

function joinByLink(steamId, code) {
  const p = byLink(code)
  if (!p) return { ok: false, error: 'that link is dead' }
  return join(steamId, p.id, { viaLink: true })
}

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
  setMap, setMode, setGameMode, setVisibility, setSettings,
  startReadyCheck, setReady, cancelReadyCheck, launch, launchInfo, reportProgress,
  invite, invitesFor, acceptInvite, declineInvite, cancelInvite, kick, quickJoin, publicLobbies, forPlayerRow,
  link, resetLink, linkPreview, joinByLink, isLinkCode, setEmitter, INVITE_TTL_MS,
  switchMap, switchNow, cancelSwitch, maybeSwitch, SWITCH_STRAIGHT_IN, SWITCH_SILENCE_MS,
}
