// Who may start a game that the PLAYER did not ask for, and when. (2026-09-23)
//
// B: "the client keeps booting you back into the game and being really annoying". His
// launcher started World at War twice for the same match, 25 s apart (client sessions
// enw-35884 and enw-2200, both m_506fba68), and the box saw a new SV_DirectConnect every
// few seconds.
//
// ROOT CAUSE. The party watcher (main.js `onPlay`) runs on EVERY poll of
// `/api/launcher/play` (1 Hz with a boot screen up, 0.2 Hz otherwise), and its only guard
// was `state.flow`. That is a LEVEL trigger on a state the site holds for as long as the
// lease lives: "the party is in-game with match X". The moment the player's game exited,
// `state.flow` went null, and the next poll -- still "in-game, match X" -- launched X
// again. A launch that gave up without the game dying (a failed step clears `state.flow`
// while World at War is still up) did the same with a game still running.
//
// THE RULE NOW, and every refusal says which part of it applied:
//   * a match is followed AT MOST ONCE. After that only the player can send us back in:
//     Play in the launcher or the site, or the site's Resume (`allow(matchId)`).
//   * never while a game this launcher started (or adopted after a Steam restart) is
//     still running, whatever `state.flow` says;
//   * never without a match id -- a launch nobody can name is one nobody can dedupe.
//
// ONE EXCEPTION, AND ONLY ONE (2026-09-24, cloud-brief-parties.md task 3): the party's leader
// switched map while our game was running. The site then names a NEW match whose
// `switched_from` is the match OUR running game was launched for. decide() answers
// `{ follow: false, end: <pid> }`: main.js ends that game (the toast's End game path) and the
// next poll, with no game alive, follows the new match. A game is never ended for any other
// reason: a different `switched_from`, a game we cannot tie to a match, or no `switched_from`
// at all all leave it running.

export const FOLLOW_STATES = ['reserving', 'loading', 'ready', 'in-game']

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function makeFollowGate({ isAlive = pidAlive, now = () => Date.now() } = {}) {
  const launched = new Map()     // matchId -> { at, how, endedAt }
  const pidSets = new Set()      // GameLaunch.pids of every game we started (Sets, live)
  const setMatch = new Map()     // pid Set -> the match id it was launched for (or null)
  let lastNoted = null           // the match of the newest noteLaunch, for watchPids
  const endAsked = new Set()     // pids we have already asked main.js to end (once each)

  function gameAlive() {
    for (const set of pidSets) {
      const live = [...set].find((pid) => isAlive(pid))
      if (live) return live
    }
    return null
  }
  // The running game's pid AND the match it was launched for (null when we cannot say).
  function aliveGame() {
    for (const set of pidSets) {
      const live = [...set].find((pid) => isAlive(pid))
      if (live) return { pid: live, matchId: setMatch.get(set) || null }
    }
    return null
  }

  // p: the body of GET /api/launcher/play. Returns { follow, reason, matchId, key }.
  // `key` is stable for a repeated identical decision, so the caller can log once per
  // change instead of once per poll.
  function decide(p, { flowRunning = false } = {}) {
    const matchId = p?.match?.match_id || null
    const out = (follow, reason, key) => ({ follow, reason, matchId, key: `${follow ? 'go' : 'no'}:${key}:${matchId || ''}` })
    if (!p || p.signedOut) return out(false, 'signed out', 'signedout')
    if (!FOLLOW_STATES.includes(p.state)) return out(false, `the site says ${p.state || 'nothing'}`, `state-${p.state}`)
    if (!p.match || !p.map?.key) return out(false, 'no match or no map in the poll', 'nomatch')
    if (!matchId) return out(false, 'the site has not named the match yet', 'noid')
    // Before the flow check: the launch flow of the game being replaced is still running
    // while that game is up.
    const game = aliveGame()
    const from = p.match.switched_from || null
    if (game && from && game.matchId && String(from) === String(game.matchId) && String(matchId) !== String(game.matchId)) {
      const first = !endAsked.has(game.pid)
      endAsked.add(game.pid)
      return { ...out(false, `the party switched map: ${matchId} replaces ${from}, which our game (process ${game.pid}) is in; ending it, then following`, 'switch'), end: first ? game.pid : null }
    }
    if (flowRunning) return out(false, 'a launch is already in progress', 'flow')
    if (game) return out(false, `a game this launcher started is still running (process ${game.pid})`, 'alive')
    const prev = launched.get(matchId)
    if (prev) {
      const when = new Date(prev.at).toISOString()
      const ended = prev.endedAt ? `, and that game ended at ${new Date(prev.endedAt).toISOString()}` : ''
      return out(false, `already launched ${matchId} (${prev.how}, ${when}${ended}); only Play or Resume sends the player back in`, 'done')
    }
    return out(true, `${matchId} is ${p.state} and this launcher has not launched it`, 'follow')
  }

  function noteLaunch(matchId, how) {
    if (!matchId) return
    const prev = launched.get(matchId)
    launched.set(matchId, { at: prev?.at && prev.how === how ? prev.at : now(), how, endedAt: null })
    lastNoted = matchId
  }
  function noteEnded(matchId) {
    const r = matchId && launched.get(matchId)
    if (r) r.endedAt = now()
  }
  // `matchId` defaults to the newest noteLaunch: main.js notes the launch, then the flow's
  // `launched` event hands over its pids.
  function watchPids(set, matchId = lastNoted) {
    if (!set || typeof set[Symbol.iterator] !== 'function') return
    pidSets.add(set)
    if (!setMatch.has(set) || matchId) setMatch.set(set, matchId || null)
  }
  // The player asked to go back in (Play, Resume): the ledger no longer stands in the way.
  function allow(matchId) { return launched.delete(matchId) }

  return { decide, noteLaunch, noteEnded, watchPids, allow, gameAlive, aliveGame, get launched() { return new Map(launched) } }
}
