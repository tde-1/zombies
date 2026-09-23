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
//   quit on purpose (POST /api/party/quit) -> the lease is cancelled (solo) or they left
//                                          the party (co-op); either way no match for them.
//   never connected                     -> the lease's own phase, unchanged (`in-game` for a
//                                          live game: a party member whose leader pressed
//                                          Start, or a Resume, still gets followed in).
//
// In memory, on purpose: it is a few bytes per live game, the box re-sends it four times a
// second, and after a site restart the worst case is one extra follow for a player who was
// already gone, which is what happened for every player before this file existed.

const { db, now } = require('../db/database')

const RESUME_MS = 10 * 60_000         // B: resumable for ten minutes, then the server goes
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
 * Quit on purpose (the Esc menu's Exit game, POST /api/party/quit). Solo: the lease is
 * cancelled and the party dissolved, so the launcher has nothing to follow. In a party:
 * this player leaves the party, and the game goes on for the others.
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
  // Dissolve a solo party; leave a shared one. `leave()` deletes a party whose last member
  // goes, so both are the same call.
  const left = party ? !!parties.leave(steamid).ok : false
  db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('party.quit', ?, ?, ?)")
    .run(String(steamid), JSON.stringify({ match_id: m || null, cancelled, left, party_size: members }), now())
  return { ok: true, match_id: m || null, cancelled, left }
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

function forget(matchId) { seats.delete(String(matchId)) }

/** Has the referee said anything about who is in this match since the site started? */
const known = (matchId) => seats.has(String(matchId))

module.exports = { observe, stateOf, phaseOf, resumeInfo, resume, quit, sweep, forget, known, RESUME_MS }
