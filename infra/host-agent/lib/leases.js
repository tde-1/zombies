// Several leases on one box: what the pull protocol's answer means for the games we run.
//
// Until 2026-09-23 the site handed a box ONE lease and superseded every other, and
// `host.js onAssignment` retired every game whose match id was not that one. So a box ran
// one game at a time whatever `--max-instances` said, and any second Play (an agent's
// fake-ID proof, a friend's party) kicked the first. B was kicked at 19:21 and several
// times after.
//
// Protocol v2 (`GET /api/gs/assignment?v=2`, web/server/lib/assignments.js forBox):
//
//   { v: 2, status: 'leased'|'idle', nonce, assignments: [ <the old one-lease shape>, ... ] }
//
// An old site ignores `?v=2` and answers the old shape, which `leaseList()` reads as a
// list of one (or none). The rule for the games is then simple and has no "newest wins":
//
//   * a leased game whose match id is NOT in the list is retired (its lease was
//     cancelled, ended, superseded by its own party, or yielded by an agent);
//   * a lease in the list with no game is booted — once per agent lifetime, so a game
//     that already finished is never booted again because the site has not yet heard
//     its result;
//   * everything else (other leases' games, warm instances, --boot sims) is left alone.
//
// Pure functions, so `test/run-all.js` can drive them without a box.

/** The assignment poll's answer as a list of leases, whichever protocol the site spoke. */
export function leaseList(msg) {
  if (!msg || typeof msg !== 'object') return []
  if (Array.isArray(msg.assignments)) return msg.assignments.filter((a) => a && a.match_id && (a.status || 'leased') === 'leased')
  return msg.status === 'leased' && msg.match_id ? [msg] : []
}

/**
 * @param {object[]} list     leaseList() of the latest poll
 * @param {object[]} games    live Game objects: { matchId, finished, assignment, instance: { id } }
 * @param {object}   o
 * @param {Set}      o.started  match ids this agent has ever booted or handed a warm instance
 * @param {Set}      o.warm     instance ids that are warm (no lease; kept for reuse)
 * @returns {{ retire: object[], boot: object[] }}
 */
export function planLeases(list, games, { started = new Set(), warm = new Set() } = {}) {
  const wanted = new Set(list.map((a) => a.match_id))
  const running = new Set(games.filter((g) => !g.finished).map((g) => g.matchId))
  const retire = games.filter((g) =>
    !g.finished && g.assignment && !warm.has(g.instance?.id) && !wanted.has(g.matchId))
  const boot = list.filter((a) => !running.has(a.match_id) && !started.has(a.match_id))
  return { retire, boot }
}

/** One line for the journal: `leased 2: m_a (map), m_b (map)` or `idle`. */
export function describe(msg) {
  const list = leaseList(msg)
  if (!list.length) return 'idle'
  return `leased ${list.length}: ${list.map((a) => `${a.match_id} (${a.map})`).join(', ')}`
}
