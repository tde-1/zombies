// COPIED FROM MOVEMENT, `movement-client/src/comments.js`, unchanged. Here it serves the profile
// wall (components/ProfileComments.jsx); the map thread it names below is Movement's.
//
// Reconciliation for the per-map comment thread (components/MapComments.jsx).
//
// THREE things can hand the thread the same comment:
//
//   - the optimistic copy the author sees the instant they hit Post
//   - the socket push — the server broadcasts to the `map:<name>` room BEFORE it answers the
//     POST (server/routes/movement.js), and the author is sitting in that room themselves, so
//     the push routinely wins the race against their own HTTP response
//   - the 60s poll
//
// They all funnel through mergeComment(), which is the only place a row enters the list. That
// is what makes a double insert impossible rather than merely unlikely: the thread used to
// append the POST answer unconditionally beside a push it had already accepted, and the same
// comment appeared twice until the next poll swept it.
//
// Lives outside the component so scripts/test-map-comments.js can assert the orderings
// directly — the bug was a race, and a race is not something to re-verify by clicking.

// Oldest first. A post still in flight has no id yet, so it sorts after everything sharing its
// timestamp — i.e. at the bottom, where the author just typed it.
export const idOf = (c) => (typeof c.id === 'number' ? c.id : Number.MAX_SAFE_INTEGER)
export const bySeq = (a, b) => (a.created_at - b.created_at) || (idOf(a) - idOf(b))
export const rowKey = (c) => (c.id != null ? 'c' + c.id : 't' + c.tmp)

const same = (a, b) => String(a) === String(b)

// The ONE point at which a comment enters the thread, whatever brought it in.
//
//   0. it was deleted here     -> drop it. A push or a poll already in flight when the delete
//                                 happened must not resurrect it.
//   1. we already hold this id -> replace in place. A socket push and the POST answer are the
//                                 same row seen twice; the later, better-scoped view wins.
//   2. one of OUR posts is still in flight with this exact text -> that pending entry IS this
//                                 row. Promote it instead of appending beside it.
//   3. otherwise               -> new; append and re-sort.
//
// Rule 2 can only ever match your own steam_id, so the worst it can do is fold together two
// identical messages you posted yourself — which the server's per-author cooldown makes
// impossible anyway, and which would be the right call even then.
export function mergeComment(list, c, removed) {
  if (c.id != null && removed && removed.has(c.id)) return list
  let i = c.id != null ? list.findIndex((x) => x.id === c.id) : -1
  if (i < 0) i = list.findIndex((x) => x.pending && same(x.steam_id, c.steam_id) && x.body === c.body)
  if (i < 0) return [...list, c].sort(bySeq)
  const next = list.slice()
  next[i] = { ...next[i], ...c, pending: false }
  return next.sort(bySeq)
}

// A poll (or the first load) landing on the thread. The server list is the truth for confirmed
// rows, but it does NOT know about a post of ours still in flight — so a poll mid-post must
// not wipe the optimistic entry off screen and put it back a moment later.
export function mergeServerList(current, rows, removed) {
  const next = rows.filter((r) => !(removed && removed.has(r.id)))
  for (const p of current) {
    if (p.pending && !next.some((r) => same(r.steam_id, p.steam_id) && r.body === p.body)) next.push(p)
  }
  return next.sort(bySeq)
}
