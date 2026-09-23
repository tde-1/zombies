'use strict'

// System lines in the global chat channel.
//
//   "<handle> started a game on Verrückt"
//   "<handle> joined Verrückt"
//   "<handle> just went down on round 30 on Verrückt"
//   "<handle>'s game on Verrückt ended on round 30"
//
// They go in the SAME ring as everything else (`lib/chatNetwork.js`), because the whole
// point of them is that they read as part of the conversation: you see a friend start a
// game, you see them go down, you say something about it. A separate activity feed beside
// the chat panel would be the same information in a column nobody looks at.
//
// ── Three decisions ──────────────────────────────────────────────────────────────
//
// 1. **THE SENTENCE IS COMPOSED HERE, NOT ON THE BOX.** A box sends the fact — event,
//    name, steamid, identity, map, round — and this file writes the prose. The handle a
//    line should carry is the site's user for a `verified` identity and the in-game name
//    otherwise, and only the site holds the user table. It also means a compromised or
//    broken box cannot write an arbitrary sentence into a channel everybody reads; the
//    worst it can do is claim a wrong name, and a name is all it could ever claim.
//
// 2. **A HANDLE IS THE ACCOUNT ONLY WHEN THE IDENTITY IS `verified`.** Same gate as
//    `/api/gs/result` (web.md §11h): `claimed` means somebody sent a well-formed blob
//    naming an account and nothing has checked the signature. A chat line that prints a
//    site handle is the site saying "this was them", so it fails closed to the in-game
//    name — which is honest, because that IS what the server saw.
//
// 3. **THEY ARE DE-DUPLICATED AND RATE-LIMITED PER GAME.** A player who goes down four
//    times in a round is four lines; a box that reconnects and replays its roster is
//    not. The dedupe key is (event, map, handle, round) inside a short window, and there
//    is a floor on how often one match may produce a line at all. A chat channel that a
//    looping box can flood is a chat channel nobody can use.

const chat = require('./chatNetwork')
const users = require('./users')
const { db } = require('../db/database')

// A repeat of the same line about the same person in the same round inside this window is
// the same event arriving twice, not two events.
const DEDUPE_MS = 20_000
// No one match may produce more than this many system lines a minute, whatever it sends.
const PER_MATCH_PER_MIN = 20

// Start, join and end are said once per match; the memory of that outlives any game.
const ONCE_MS = 12 * 3600_000

const recent = new Map()   // key -> at
const once = new Map()     // match-scoped key -> at
const rate = new Map()     // match_id -> [at, ...]

const KINDS = new Set(['started', 'joined', 'down', 'ended'])

/** The name the line carries. The account only when somebody checked it. */
function handleFor({ name, steamid, identity }) {
  if (identity === 'verified' && steamid) {
    const row = db.prepare('SELECT * FROM users WHERE steam_id=?').get(String(steamid))
    const u = users.pub(row)
    if (u && u.name) return u.name
  }
  const n = String(name || '').replace(/[\r\n]+/g, ' ').trim()
  return n || 'somebody'
}

/**
 * What the map is called in a sentence. The stored title where we have one, the bsp name
 * where we do not — never a blank, and never "unknown": a line reading "joined unknown"
 * is worse than one naming the file.
 */
function mapLabel(mapKey, mapName) {
  if (mapName) return String(mapName).slice(0, 60)
  if (!mapKey) return null
  try {
    const row = db.prepare('SELECT title FROM maps WHERE key=?').get(String(mapKey))
    if (row && row.title) return String(row.title).slice(0, 60)
  } catch { /* the maps table is not a dependency of a chat line */ }
  return String(mapKey).slice(0, 60)
}

function sentence(kind, who, where, round) {
  const r = Number(round) || 0
  switch (kind) {
    case 'started': return where ? `${who} started a game on ${where}` : `${who} started a game`
    case 'joined': return where ? `${who} joined ${where}` : `${who} joined a game`
    case 'down':
      if (where && r) return `${who} just went down on round ${r} on ${where}`
      if (where) return `${who} just went down on ${where}`
      return `${who} just went down`
    case 'ended':
      if (where && r) return `${who}'s game on ${where} ended on round ${r}`
      if (where) return `${who}'s game on ${where} ended`
      return `${who}'s game ended`
    default: return null
  }
}

function allowed(matchId, now) {
  const key = String(matchId || 'nomatch')
  const hits = (rate.get(key) || []).filter((t) => now - t < 60_000)
  if (hits.length >= PER_MATCH_PER_MIN) { rate.set(key, hits); return false }
  hits.push(now)
  rate.set(key, hits)
  if (rate.size > 200) for (const [k, v] of rate) if (!v.some((t) => now - t < 60_000)) rate.delete(k)
  return true
}

/**
 * A box reported something that happened in one of its games.
 *
 * @param {string} origin  the box name — the ring's origin, so the box that sent it does
 *                         not get its own line back on the next drain and re-announce to
 *                         the very players who just watched it happen.
 * @returns {object|null}  the chat line, or null if it was a duplicate, rate-limited or
 *                         not an event we say anything about.
 */
function record(origin, ev = {}) {
  const kind = String(ev.event || '').trim()
  if (!KINDS.has(kind)) return null

  const who = handleFor(ev)
  const where = mapLabel(ev.map, ev.map_name)
  const round = Number(ev.round) || 0
  const text = sentence(kind, who, where, round)
  if (!text) return null

  // A game's end with nobody to name is the teardown's second game_over after the post-game
  // reload reset the host's starter (live ring, 2026-09-22: "B's game … ended on round 1",
  // then "somebody's game on Nacht ended", then "somebody's game on Unknown map ended"). The
  // real end line was already said.
  if (kind === 'ended' && !String(ev.name || '').trim() && !(ev.identity === 'verified' && ev.steamid)) return null

  const at = Date.now()
  const game = ev.match_id ? `m:${ev.match_id}` : `i:${ev.instance || ''}`
  // ONCE PER MATCH: a start, a join and an end are facts about a match, not about a moment.
  // The post-game restart reconnects everybody and the teardown re-sends game_over; neither
  // is a second start or a second end. Keyed on the match, so two games on the same map by
  // the same player are still two lines (the old key had no match in it and merged them).
  if (ev.match_id && kind !== 'down') {
    const onceKey = `${game}|${kind === 'ended' ? 'ended' : `in|${who}`}`
    if (once.has(onceKey)) return null
    once.set(onceKey, at)
    if (once.size > 2000) for (const [k, t] of once) if (at - t > ONCE_MS) once.delete(k)
  }
  const key = `${game}|${kind}|${ev.map || ''}|${who}|${kind === 'down' || kind === 'ended' ? round : ''}`
  const last = recent.get(key)
  if (last && at - last < DEDUPE_MS) return null
  recent.set(key, at)
  if (recent.size > 500) for (const [k, t] of recent) if (at - t > DEDUPE_MS) recent.delete(k)

  if (!allowed(ev.match_id, at)) return null

  return chat.push({
    from: 'ENW',
    text,
    kind: 'system',
    steamId: ev.identity === 'verified' && ev.steamid ? String(ev.steamid) : null,
    origin,
    mapKey: ev.map || null,
    instance: ev.instance || null,
  })
}

/** Test seam: the process-lifetime dedupe and rate state. */
function _reset() { recent.clear(); once.clear(); rate.clear() }

module.exports = { record, handleFor, mapLabel, sentence, _reset, DEDUPE_MS, PER_MATCH_PER_MIN }
