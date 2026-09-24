// [reconnect, 2026-09-24] What the rail's server card says while the game is paused for a
// player who dropped (host lib/referee.js drop hold; GET /api/party `hold`). Pure, so
// web/test/reconnect-hold.js can check it without a browser.
//
//   hold: { paused, away: [{ name, left_ms, returning, you }] } | null
//
// Terse, one line, the way the rest of the card talks (B's design direction).

export function clock(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function holdLabel(hold) {
  if (!hold || !Array.isArray(hold.away) || !hold.away.length) return null
  // `paused` false: the server could not freeze (ENW_NO_PAUSE on the box) -- the place is
  // kept and the points come back, but the world runs, and the card must not say otherwise.
  const paused = hold.paused !== false
  const me = hold.away.find((a) => a.you)
  if (me) {
    const lead = paused ? 'Paused for you' : 'Your place is kept'
    return me.returning ? `${lead} · loading back in` : `${lead} · ${clock(me.left_ms)} to rejoin`
  }
  const others = hold.away.filter((a) => !a.you)
  const back = others.filter((a) => a.returning)
  const waiting = others.filter((a) => !a.returning)
  if (!waiting.length) {
    const lead = paused ? 'Paused · ' : ''
    return back.length === 1 ? `${lead}${back[0].name} is loading back in` : `${lead}players loading back in`
  }
  const soonest = Math.min(...waiting.map((a) => a.left_ms))
  const who = waiting.length === 1 ? waiting[0].name : `${waiting.length} players`
  return `${who} disconnected · ${paused ? 'paused, ' : ''}waiting to reconnect (${clock(soonest)})`
}
