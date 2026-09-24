'use strict'

// Seats — is THIS player in THIS match right now, did they leave it, or did they quit it?
//
// The launcher's party watcher launches the game whenever the party poll says a match is
// in a launchable phase and no launch is running (launcher main.js `onPlay`, FOLLOW_STATES).
// The poll used to say `in-game` for as long as the LEASE was live, whoever was actually in
// it. So the moment a player's game went away (a quit, a crash, Alt+F4) the watcher saw a
// live match and no launch, and launched again: the relaunch every ~25 s the coordinator
// measured at 01:03 for m_506fba68, and "the launcher keeps booting you back in" (B).
//
// The box already says who is connected: every live frame (POST /api/gs/live, and a status
// heartbeat that carries `instances[].game`) is the referee's `state()`, whose `players[]`
// have `steamid` and `connected`. This file remembers, per match, which SteamIDs have been
// seen connected and whether they still are, and turns that into the phase the launcher
// and the rail are shown (`phaseOf`):
//
//   connected now                       -> `playing`   (NOT `in-game`: `in-game` is one of
//                                          the watcher's launch triggers, and a player who
//                                          is already in the match must never be launched
//                                          into it again. Launcher lane: read `playing` as
//                                          "connected" wherever `in-game` meant that.)
//   was connected, is not, did not quit -> `resumable` (a crash or Alt+F4, B 2026-09-23:
//                                          "resumable from the server card"). NOT a phase
//                                          the watcher follows; the rail shows Resume.
//   quit on purpose (POST /api/party/quit) -> the lease is cancelled (the last player in it)
//                                          or goes on (co-op); they stay in the party
//                                          either way, and are not sent back in (`selected`).
//   never connected                     -> the lease's own phase, unchanged (`in-game` for a
//                                          live game: a party member whose leader pressed
//                                          Start, or a Resume, still gets followed in).
//
// In memory, on purpose: it is a few bytes per live game, the box re-sends it four times a
// second, and after a site restart the worst case is one extra follow for a player who was
// already gone, which is what happened for every player before this file existed.

const { db, now } = require('../db/database')

// B: resumable for ten minutes, then the server goes. [RS] B, 2026-09-23 19:10: "every player
// has been gone for 3 minutes" ends the game (the host's --idle-gone-ms, lib/idle.js), so the
// window the rail offers is the same three minutes. ZM_IDLE_GONE_MS moves both halves' default.
const RESUME_MS = Number(process.env.ZM_IDLE_GONE_MS) > 0 ? Number(process.env.ZM_IDLE_GONE_MS) : 3 * 60_000
const RESUME_CONNECT_MS = 2 * 60_000  // a Resume must connect within this, or it is `left` again
const seats = new Map()               // match_id -> Map(steamid -> { ever, connected, at, leftAt, quit, resumedAt })

function seat(matchId, steamid) {
  let m = seats.get(String(matchId))
  if (!m) { m = new Map(); seats.set(String(matchId), m) }
  let s = m.get(String(steamid))
  if (!s) { s = { ever: false, connected: false, at: 0, leftAt: null, quit: false, resumedAt: null }; m.set(String(steamid), s) }
  return s
}

/** A referee `state()` for a match: record who is connected. Called for every live frame. */
function observe(matchId, state) {
  if (!matchId || !state || !Array.isArray(state.players)) return
  const t = now()
  const present = new Set()
  for (const p of state.players) {
    if (!p || !p.steamid) continue
    const s = seat(matchId, p.steamid)
    const on = p.connected !== false
    if (on) { present.add(String(p.steamid)); s.ever = true; s.connected = true; s.leftAt = null; s.resumedAt = null }
    else if (s.connected) { s.connected = false; s.leftAt = t }
    s.at = t
  }
  // A player the referee no longer lists at all has left too.
  const m = seats.get(String(matchId))
  for (const [sid, s] of m || []) {
    if (s.connected && !present.has(sid) && !state.players.some((p) => p && String(p.steamid) === sid)) { s.connected = false; s.leftAt = t }
  }
}

/** `connected` | `left` | `quit` | `never` */
function stateOf(matchId, steamid) {
  const m = seats.get(String(matchId))
  const s = m && m.get(String(steamid))
  if (!s) return 'never'
  if (s.quit) return 'quit'
  if (s.connected) return 'connected'
  // A Resume that has not connected within two minutes is a failed resume: back to
  // `left`, so the watcher stops following it rather than relaunching for ever.
  if (s.ever && (!s.resumedAt || now() - s.resumedAt > RESUME_CONNECT_MS)) return 'left'
  return 'never'
}

/**
 * The phase the launcher's poll and the rail show. `launch` is parties.launchInfo(): the
 * lease's state and connect string for this player.
 */
function phaseOf(party, launch, steamid) {
  if (!party) return 'idle'
  if (launch && launch.match_id && steamid) {
    const you = stateOf(launch.match_id, steamid)
    if (you === 'connected') return 'playing'
    if (you === 'left') return 'resumable'
    if (you === 'quit') return party.map ? 'selected' : 'idle'
  }
  if (launch && launch.state === 'live') return 'in-game'
  if (launch && launch.state === 'ready') return launch.connect ? 'ready' : 'loading'
  if (launch && launch.match_id) return 'reserving'
  if (party.state === 'ready-check') return 'ready-check'
  if (party.map) return 'selected'
  return 'idle'
}

/** What the rail's server card needs to draw Resume, or null. */
function resumeInfo(launch, steamid) {
  if (!launch || !launch.match_id || stateOf(launch.match_id, steamid) !== 'left') return null
  const s = seats.get(String(launch.match_id)).get(String(steamid))
  return { match_id: launch.match_id, left_at: s.leftAt, until: (s.leftAt || now()) + RESUME_MS }
}

/**
 * Resume: put this player back into the match they crashed out of, through the normal
 * follow path. The phase goes back to the lease's own (`in-game` for a live game), which
 * the launcher's watcher follows, with a FRESH invite token: the old one is five minutes
 * long and the box refuses a token it has already admitted (`replayed`).
 */
function resume(steamid, matchId) {
  const a = db.prepare("SELECT * FROM assignments WHERE match_id=? AND state IN ('leased','ready','live')").get(String(matchId))
  if (!a) return { ok: false, error: 'that server has gone' }
  const players = JSON.parse(a.players_json || '[]')
  const me = players.find((p) => String(p.steamid) === String(steamid))
  if (!me) return { ok: false, error: 'you were not in that game' }
  if (stateOf(matchId, steamid) !== 'left') return { ok: false, error: 'there is nothing to resume' }
  const tok = JSON.parse(a.tokens_json || '{}')
  tok[String(steamid)] = require('./tokens').issue({ steamid: String(steamid), matchId: a.match_id, name: me.name })
  db.prepare('UPDATE assignments SET tokens_json=? WHERE id=?').run(JSON.stringify(tok), a.id)
  seat(matchId, steamid).resumedAt = now()
  return { ok: true, match_id: a.match_id }
}

/**
 * Quit on purpose (the Esc menu's Exit game, POST /api/party/quit). The last player in the
 * game: the lease is cancelled, so the launcher has nothing to follow. Otherwise the game goes
 * on for the others. EITHER WAY THE PARTY STAYS (B 2026-09-24, cloud-brief-parties.md task 4:
 * "parties persist across games"): quitting a game is not leaving the party. The seat is
 * marked `quit`, so the launcher is not sent back in (phaseOf -> `selected`); Leave in the
 * party menu is how somebody leaves. (Until 2026-09-24 this called parties.leave(), which
 * dissolved a solo party and took a co-op quitter out of theirs.)
 */
function quit(steamid, matchId) {
  const parties = require('./parties')
  const assignments = require('./assignments')
  const party = parties.forPlayer(steamid)
  const m = String(matchId || (party && party.match_id) || '')
  if (m) seat(m, steamid).quit = true
  const a = m ? db.prepare('SELECT * FROM assignments WHERE match_id=?').get(m) : null
  const players = a ? JSON.parse(a.players_json || '[]') : []
  const others = players.filter((p) => String(p.steamid) !== String(steamid))
  const members = party ? party.members.length : 0
  let cancelled = false
  const mine = players.some((p) => String(p.steamid) === String(steamid))
  if (a && mine && ['leased', 'ready', 'live'].includes(a.state) && !others.length) {
    cancelled = !!assignments.cancel(a.match_id, String(steamid)).ok
  }
  const left = false
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('party.quit', ?, ?, ?)")
    .run(String(steamid), JSON.stringify({ match_id: m || null, cancelled, left, party_size: members }), now())
  return { ok: true, match_id: m || null, cancelled, left }
}

/**
 * CLOSE THE SERVER, KEEP THE PARTY (the rail's × on the server card; B 2026-09-23: "The X
 * button in the bottom left should close the server, not leave the party"). The party's
 * running game is ended for everybody in it (the lease is cancelled, the box retires the
 * instance, the host signs the run) and the party goes back to forming with its map, mode
 * and members as they were. The host of the party only (anybody else leaves through the
 * party menu); a solo party's one member is its host. `match_id` given and not the party's
 * game = a stale click: nothing changes.
 */
function end(steamid, matchId) {
  const parties = require('./parties')
  const assignments = require('./assignments')
  const party = parties.forPlayer(steamid)
  if (!party) return { ok: false, error: 'not in a party' }
  if (String(party.leader) !== String(steamid)) return { ok: false, error: 'only the party host can close the server' }
  const m = String(party.match_id || '')
  if (matchId && m && String(matchId) !== m) return { ok: true, stale: true, match_id: m }
  let cancelled = false
  if (m) {
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(m)
    // Nobody is offered Resume into a server that was closed on purpose.
    for (const p of (a ? JSON.parse(a.players_json || '[]') : [])) if (p && p.steamid) seat(m, p.steamid).quit = true
    cancelled = !!(a && ['leased', 'ready', 'live'].includes(a.state) && assignments.cancel(m, String(steamid)).ok)
  }
  // A ready check or a launch with no lease yet goes back to forming the same way.
  if (!cancelled && ['ready-check', 'launching'].includes(party.state)) parties.cancelReadyCheck(steamid)
  if (party.state === 'in-game' || party.state === 'launching') {
    db.prepare("UPDATE parties SET state='forming', match_id=NULL, ready_since=NULL, updated_at=? WHERE id=?").run(now(), party.id)
  }
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('party.end', ?, ?, ?)")
    .run(String(steamid), JSON.stringify({ match_id: m || null, cancelled, party_size: party.members.length }), now())
  return { ok: true, match_id: m || null, cancelled }
}

/**
 * The ten-minute backstop. A live lease whose every player has left (none connected, none
 * resuming) for RESUME_MS is cancelled. The referee normally ends such a game itself
 * (crash grace, then `players_did_not_return`); this is for the case where it does not.
 */
function sweep() {
  const t = now()
  const out = []
  for (const [matchId, m] of seats) {
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(matchId)
    if (!a || !['leased', 'ready', 'live'].includes(a.state)) { if (!a || t - (a.ended_at || 0) > RESUME_MS) seats.delete(matchId); continue }
    const all = [...m.values()]
    if (!all.length || all.some((s) => s.connected || (s.resumedAt && t - s.resumedAt < RESUME_MS))) continue
    const lastLeft = Math.max(...all.map((s) => s.leftAt || 0))
    if (lastLeft && t - lastLeft >= RESUME_MS) {
      require('./assignments').cancel(matchId, 'resume-window')
      out.push(matchId)
    }
  }
  return out
}

// ---- [RS] idle-server auto-close (host lib/idle.js; esc-menu.md §13) -------------------
// A player whose server the box closed for want of players is told once, tersely, by the
// launcher's poll (`/api/launcher/play` `closed`), for a few minutes after the close.
const CLOSED_TEXT = { never_joined: 'Server closed: nobody joined.', all_gone: 'Server closed: everyone left.' }
const CLOSED_SHOW_MS = 5 * 60_000
const closedNotes = new Map()   // steamid -> { match_id, rule, text, at }

function noteClosed(matchId, steamids, rule) {
  const text = CLOSED_TEXT[rule] || CLOSED_TEXT.never_joined
  for (const sid of steamids) {
    closedNotes.set(String(sid), { match_id: String(matchId), rule: rule || 'never_joined', text, at: now() })
    seat(matchId, sid).quit = true   // nobody is offered Resume into a server that was closed
    // A game that is still open (a player loading, the end screen) hears it the way it hears
    // "Your record has been uploaded.": a private notice on the overlay's feed, which the
    // lockdown's end screen repeats (esc-menu.md §10.3).
    try { require('./gameChat').notify(String(sid), text) } catch { /* no chat channel */ }
  }
  if (closedNotes.size > 5000) closedNotes.clear()
}

function closedFor(steamid) {
  const n = closedNotes.get(String(steamid))
  if (!n) return null
  if (now() - n.at > CLOSED_SHOW_MS) { closedNotes.delete(String(steamid)); return null }
  return n
}

/**
 * A JOIN IN PROGRESS, as far as the site can tell (host lib/idle.js holds the "nobody joined"
 * close while this is true): a player of the lease whose launcher is downloading the map, or
 * who pressed Resume and has not connected yet.
 */
function joinInProgress(matchId, partyId, steamids) {
  const t = now()
  const m = seats.get(String(matchId))
  for (const sid of steamids) {
    const s = m && m.get(String(sid))
    if (s && s.resumedAt && t - s.resumedAt < RESUME_CONNECT_MS && !s.connected) return true
  }
  if (!partyId) return false
  try {
    return require('./partyProgress').pending(partyId, steamids).some((p) => p.state === 'downloading')
  } catch { return false }
}

/**
 * [reconnect, 2026-09-24] Who quit this match ON PURPOSE (the Esc menu's Exit game, the × that
 * closed the server, an idle close), for the box: a quit must never hold the game the way a
 * drop does (infra/host-agent lib/referee.js markQuit). The box posts a run id, which for a
 * restarted run is `<lease>.r<n>`; the seat is kept under the lease id.
 */
function quittersFor(matchId) {
  const out = new Set()
  for (const id of [String(matchId), String(matchId).replace(/\.r\d+$/, '')]) {
    const m = seats.get(id)
    for (const [sid, s] of m || []) if (s.quit) out.add(sid)
  }
  return [...out]
}

function forget(matchId) { seats.delete(String(matchId)) }

/** Has the referee said anything about who is in this match since the site started? */
const known = (matchId) => seats.has(String(matchId))

module.exports = { observe, stateOf, phaseOf, resumeInfo, resume, quit, end, sweep, forget, known, noteClosed, closedFor, joinInProgress, quittersFor, CLOSED_TEXT, RESUME_MS }
