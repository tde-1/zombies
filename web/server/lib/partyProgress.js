'use strict'

// Map download progress, per party member, while the party is forming.
//
// Every member's launcher posts its own progress for the map the leader staged; the party
// panel on the home page draws a bar per member; and the leader's **Start** stands down
// while any of them is still downloading or has failed. That last part is the whole point
// of the feature: a party of four where one person is still pulling 600 MB off MediaFire
// used to press Start and boot a game three of them could join. What "still downloading"
// means precisely — and why silence does not count as it — is `pending()` below.
//
// Three decisions, and they are `lib/live.js`'s decisions for the same reasons:
//
// 1. **PROGRESS NEVER TOUCHES SQLITE.** A launcher posts a byte count about once a second
//    for as long as a download runs. That is a number that is wrong 900 ms later, on the
//    same file that serves every page, and nothing ever reads it back. It lives in a Map
//    with a TTL and dies with the process — and a process that died is a page that reloads,
//    at which point every launcher's next post refills it.
//
// 2. **THE LAUNCHER PUSHES.** The site never dials a player's PC. Same rule as the fleet.
//
// 3. **RATE IS OUR PROBLEM, NOT THE CALLER'S.** A post that arrives too soon after the
//    last one for the same member is accepted and dropped rather than refused, so no
//    launcher ever has to care what our ceiling is. `installed` and `failed` are terminal
//    and always land: they are the two the Start button reads.
//
// What the site does NOT do here is trust the numbers. `bytes`/`total` are drawn as a bar
// and nothing else keys off them; the only value with authority is `state`, and the worst
// a lying launcher can do with it is enable a Start button for a game it then cannot join.

const MIN_POST_MS = 400          // ~2.5 Hz per member; terminal states bypass it
const TTL_MS = 30 * 60_000       // a map download can genuinely take half an hour
const STATES = ['downloading', 'installed', 'failed']

const byParty = new Map()        // party_id -> Map(steam_id -> entry)
let emit = null                  // set by the socket layer: (steamIds, payload) => void

function setEmitter(fn) { emit = fn }

const int = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 }
const str = (v, n) => (v == null ? null : String(v).slice(0, n))

/**
 * One member reported where their copy of the map has got to.
 *
 * @returns {{ok:boolean, error?:string, stored?:boolean}} `stored:false` means the post was
 *          accepted and dropped for rate. The caller still gets a 200 — see decision 3.
 */
function push(partyId, steamId, body = {}) {
  const pid = Number(partyId)
  const sid = String(steamId)
  const state = String(body.state || '').toLowerCase()
  if (!STATES.includes(state)) return { ok: false, error: `state must be one of ${STATES.join(', ')}` }

  let members = byParty.get(pid)
  if (!members) { members = new Map(); byParty.set(pid, members) }

  const prev = members.get(sid)
  const at = Date.now()
  const terminal = state === 'installed' || state === 'failed'
  if (prev && !terminal && prev.state === state && at - prev.at < MIN_POST_MS) {
    return { ok: true, stored: false, progress: prev }
  }

  const total = int(body.total)
  const bytes = Math.min(int(body.bytes), total || Number.MAX_SAFE_INTEGER)
  const entry = {
    steam_id: sid,
    map: str(body.map, 64),
    bytes,
    total,
    // A percentage the page can render without doing arithmetic on two numbers either of
    // which may be missing. `installed` is 100 whatever the byte counts say, because a
    // launcher that had the map already never counted a byte.
    pct: state === 'installed' ? 100 : total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : null,
    state,
    error: state === 'failed' ? str(body.error, 200) : null,
    at,
  }
  members.set(sid, entry)
  return { ok: true, stored: true, progress: entry }
}

/** Everything still fresh for one party, as `{ steam_id: entry }`. */
function forParty(partyId) {
  const members = byParty.get(Number(partyId))
  if (!members) return {}
  const cut = Date.now() - TTL_MS
  const out = {}
  for (const [sid, e] of members) {
    if (e.at < cut) { members.delete(sid); continue }
    out[sid] = e
  }
  if (members.size === 0) byParty.delete(Number(partyId))
  return out
}

/**
 * Which members are NOT ready to play this map, and why.
 *
 * **Silence is not a refusal.** The rule here is *known-bad blocks; silence does not*, and
 * it is the opposite of what you would write first. A member whose launcher has never
 * posted anything is not evidence that they lack the map — it is evidence of nothing at
 * all, and today it is the normal case: the launcher lane has not shipped its half yet,
 * and a player in a browser has no launcher to post from. Treating silence as "not
 * installed" would grey out Start for every party on the site until every member of it is
 * running a build that does not exist, which is a worse failure than the one this feature
 * is for.
 *
 * So the gate fires on what a launcher has actually said: someone is `downloading`, or
 * someone `failed`. Both are facts, both are temporary, and both are worth stopping a boot
 * for. "Start anyway" (13 §4b) remains the leader's way past it.
 *
 * @returns {Array<{steam_id:string,state:string,pct:number|null}>} empty when nothing is
 *          known to be outstanding.
 */
function pending(partyId, steamIds) {
  const p = forParty(partyId)
  const out = []
  for (const sid of steamIds) {
    const e = p[String(sid)]
    if (e && e.state !== 'installed') out.push({ steam_id: String(sid), state: e.state, pct: e.pct })
  }
  return out
}

/** The one-bit reading of the above, for the Start button. */
function installsOk(partyId, steamIds) { return pending(partyId, steamIds).length === 0 }

/** Drop a party's progress outright — it launched, or it dissolved. */
function clear(partyId) { byParty.delete(Number(partyId)) }

/** The socket fan-out: one payload to each member's own `user:` room. */
function broadcast(partyId, steamIds) {
  if (!emit) return
  try { emit(steamIds.map(String), { party_id: Number(partyId), progress: forParty(partyId) }) }
  catch { /* a dead socket must not fail a progress post */ }
}

// Test seam only: the suite needs a clean slate between cases, and reaching into the Map
// from outside is worse than saying so here.
function _reset() { byParty.clear() }

module.exports = { setEmitter, push, forParty, pending, installsOk, clear, broadcast, STATES, TTL_MS, MIN_POST_MS, _reset }
