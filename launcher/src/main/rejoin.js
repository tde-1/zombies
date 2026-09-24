// REJOIN (2026-09-24, disconnect pause + reconnect).
//
// B: "If someone disconnects from the game, it pauses and allows people to reconnect and
// continue as if nothing happened." The box now holds the whole game for a player who dropped
// (host lib/referee.js drop hold) and the site offers Resume on the rail. The launcher is where
// the player IS when their World at War has just died, so it says so too: one toast with a
// Rejoin button, once per match, when the site's poll says this player left a game that is
// still up (`state: 'resumable'`, lib/seats.js) -- never on its own, because followgate.js's rule
// stands: after a game ends, only the player sends themselves back in.
//
// Pure: main.js feeds it the poll body (GET /api/launcher/play) and what it remembers; the
// test is test/run-all.js "rejoin".

export function clock(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * @param p      the poll body: { state, resume: {match_id, until}, hold: {away:[{you, left_ms}]} }
 * @param opts   { offered: Set<matchId>, endedMatchId, flowRunning, gameAlive, now }
 * @returns      null, or { matchId, text, label } -- offer it once and add matchId to `offered`
 */
export function rejoinOffer(p, { offered = new Set(), endedMatchId = null, flowRunning = false, gameAlive = false, now = Date.now() } = {}) {
  if (!p || p.signedOut || p.state !== 'resumable') return null
  const matchId = p.resume?.match_id || null
  if (!matchId || offered.has(matchId)) return null
  // Only the game THIS launcher just watched end: a stale resumable from another PC, or from
  // before the launcher started, is the rail's business.
  if (endedMatchId && matchId !== endedMatchId) return null
  if (!endedMatchId) return null
  if (flowRunning || gameAlive) return null
  const mine = (p.hold?.away || []).find((a) => a && a.you)
  const leftMs = mine ? Number(mine.left_ms) || 0 : Math.max(0, (Number(p.resume.until) || now) - now)
  if (leftMs <= 0) return null
  const text = mine && p.hold.paused !== false
    ? `The game is paused for you. Rejoin within ${clock(leftMs)} and carry on where you left off.`
    : `Your game is still up. Rejoin within ${clock(leftMs)}.`
  return { matchId, text, label: 'Rejoin' }
}
