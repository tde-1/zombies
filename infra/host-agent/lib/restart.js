// A PLAYER'S "RESTART GAME" — the host's half (docs/kickstart/esc-menu.md §3).
//
// The Esc menu's Restart button (client-dll/components/pause_menu.cpp) sets a userinfo key;
// the dedicated DLL (server/components/dedicated/restart_request.cpp) sees it change and
// sends us `{"t":"restart_request","slot","name","req","players","level_time"}`. The DLL
// cannot tell a verified player from anybody else — identity is decided HERE (`auth`,
// referee.md §13) — so the decision is ours:
//
//   WHO MAY    the slot's identity is `verified`, or they are the only player connected.
//              Anybody else: `restart_refused` goes in the replay and nothing happens.
//
//   WHAT HAPPENS, and why in this order (records safety is the whole point):
//     1. The run is flagged `abandoned` + `player_restart`, and the referee's own `end`
//        is sent with the LEASE's match id: `{"t":"end","reason":"player_restart",
//        "match":<lease>}`. The DLL (referee.cpp do_end) reports the result FIRST —
//        `game_over` with its player rows, reason `player_restart`, then `match_end` — and
//        only then queues `map_restart`, resets (per-match jti set, name locks, round 0,
//        recording on) and re-announces `map_loaded` on the next server frame.
//     2. `game_over` ends THIS run on our side exactly as any game over does: the replay is
//        closed and signed with the game's final word in it, and the result is posted with
//        `end_reason: 'player_restart'` and the `abandoned` flag. Nothing about it is
//        erased or merged into what follows.
//     3. At `match_end` — synchronously, before the `end` reply and the new `map_loaded`
//        can be dispatched to a finished game — the socket is handed to a SUCCESSOR Game on
//        the same instance and the same lease, with its OWN run id `<lease>.r<n>`. Its
//        replay is a new file; its result is a new row. Its summary carries
//        `lease_match_id` so the site can attach it to the lease, and the abandoned run's
//        `player_restart` end reason tells the site the lease is NOT over.
//     4. The players never left: the DLL re-reports them after its reset. Their tokens were
//        spent on the first run (the host's TokenGuard is single-use per boot), so a player
//        who was VERIFIED on the abandoned run of this lease is re-admitted once on the new
//        run after a full signature/lease/steamid check with the single-use set bypassed.
//        Nobody else gets anything they did not have.
//
// Failure modes all end in a finished, signed run and a torn-down instance — never in a
// half-restarted game that could carry one run's clock into the next.

import { check } from './tokens.js'

const RESTART_WINDOW_MS = 10_000     // `end` sent -> the game's game_over + match_end
const MAP_BACK_MS = 60_000           // handover -> the new map_loaded

/**
 * `restart_request` from the game. Returns `{ ok, why }` (also logged and recorded).
 */
export function onRestartRequest(game, ev) {
  const log = game.log
  const slot = Number(ev.slot)
  if (game.finished || game.restarting) {
    const why = game.finished ? 'the run is already over' : 'a restart is already under way'
    log.info(`restart_request slot ${slot}: ignored (${why})`)
    return { ok: false, why }
  }
  const rows = [...game.referee.players.values()]
  const connected = rows.filter((p) => p.connected)
  const p = game.referee.players.get(slot)
  const solo = connected.length <= 1
  const verified = !!(p && p.identity === 'verified')
  if (!verified && !solo) {
    const why = `slot ${slot} is ${p ? p.identity || 'unverified' : 'not in our roster'} and ${connected.length} players are connected`
    game.recordHostEvent({ t: 'restart_refused', slot, name: p?.name || ev.name || null, why })
    log.warn(`restart_request REFUSED: ${why}`)
    return { ok: false, why }
  }
  const lease = game.leaseId || game.matchId
  game.restarting = { slot, name: p?.name || ev.name || null, steamid: p?.steamid || null, at: Date.now() }
  // Who may walk straight into the next run: exactly the players this run verified.
  game.restartCarry = new Set(connected.filter((q) => q.identity === 'verified' && q.steamid).map((q) => String(q.steamid)))
  game.referee.flags.add('abandoned')
  game.referee.flags.add('player_restart')
  game.recordHostEvent({
    t: 'restart_accepted', slot, name: game.restarting.name, identity: p?.identity || null,
    solo, players: connected.length, lease_match_id: lease,
  })
  const cmd = game.referee.send({ t: 'end', reason: 'player_restart', match: lease })
  game.restartCmdId = cmd.id
  log.info(`restart_request ACCEPTED from slot ${slot} ${game.restarting.name || ''} (${verified ? 'verified' : 'alone'}, ${connected.length} connected): run ${game.matchId} ends as abandoned; \`end\` sent for lease ${lease}`)
  // The game must answer with game_over + match_end. If it does not, the run is ended from
  // our own fold and the instance goes through the ordinary disposition (a game that said
  // nothing is torn down, never reused).
  game.restartTimer = setTimeout(() => {
    if (game.matchEndSeen) return
    log.warn(`restart: no match_end ${RESTART_WINDOW_MS} ms after \`end\` — ending the run ourselves; the instance will not be reused`)
    game.referee.flags.add('restart_failed')
    game.restarting = null
    if (!game.finished) game.referee.finishGame('player_restart')
  }, RESTART_WINDOW_MS)
  game.restartTimer.unref?.()
  return { ok: true }
}

/**
 * Called from `onMatchEnd` of a game that is restarting. Synchronous on purpose: the
 * lines after `match_end` (the `end` reply, the new `map_loaded`, the players' fresh
 * `player_connect`s) must reach the successor, never the finished run.
 */
export function handOver(old) {
  const host = old.host
  const inst = old.instance
  const lease = old.leaseId || old.matchId
  const run = (old.runOfLease || 1) + 1
  clearTimeout(old.restartTimer)
  // The finished run has had its disposition made for it: it is neither reused nor torn
  // down, its instance lives on under the successor.
  old.disposed = Promise.resolve({ action: 'restart', why: 'a player restarted the game' })
  clearTimeout(old.disposeTimer)
  const conn = old.detach()
  if (!conn) {
    old.log.warn('restart: the link is gone at match_end — nothing to hand over; tearing the instance down')
    old.disposed = null
    return null
  }
  const next = new old.constructor(host, inst, {
    matchId: `${lease}.r${run}`,
    mode: old.mode,
    vip: old.vip,
    assignment: old.assignment,
    tokens: old.tokens,
    selfReported: old.selfReported,
  })
  next.leaseId = lease
  next.runOfLease = run
  next.restartOf = old.matchId
  // Same process: `hello` is not said again (host.md §12.3).
  next.referee.hashes = { ...old.referee.hashes }
  next.referee.pid = old.referee.pid
  next.referee.role = old.referee.role
  next.referee.phase = 'loading'
  next.inheritedFrom = old.matchId
  const carry = old.restartCarry || new Set()
  next.restartAdmit = (ev) => admitCarried(host, next, carry, ev)
  // Before finish() reads it: the site attaches this run to the lease by this field.
  next.referee.prependListener('over', (s) => {
    s.lease_match_id = lease
    s.run_of_lease = run
    s.restart_of = old.matchId
  })
  host.byInstance.set(inst.id, next)
  next.attach(conn)
  next.recordHostEvent({
    t: 'run_restarted', lease_match_id: lease, run, from_match: old.matchId,
    by_slot: old.restarting?.slot ?? null, by: old.restarting?.name || null, carried: carry.size,
  })
  old.log.info(`restart: run ${old.matchId} closed; run ${next.matchId} (lease ${lease}, run ${run}) takes the link and waits for the map`)
  // A refused `end` (no command buffer) or a map that never comes back: tear down.
  const onReply = (ev) => {
    if (ev.id !== old.restartCmdId) return
    next.referee.off('reply', onReply)
    if (!ev.ok) {
      next.log.warn(`restart: the game refused \`end\` (${ev.error || 'no reason'}) — tearing the instance down`)
      host.retire(next, 'restart refused by the game')
    }
  }
  next.referee.on('reply', onReply)
  const t = setTimeout(() => {
    if (next.mapEv || next.finished) return
    next.log.warn(`restart: no map_loaded ${MAP_BACK_MS / 1000} s after the handover — tearing the instance down`)
    host.retire(next, 'no map_loaded after a player restart')
  }, MAP_BACK_MS)
  t.unref?.()
  next.once('map_loaded', () => { clearTimeout(t); next.log.info(`restart: map back; run ${next.matchId} is recording`) })
  host.reportStatus?.()
  return next
}

/** A player verified on the abandoned run of this lease, back after the reset. */
function admitCarried(host, game, carry, ev) {
  const sid = String(ev.steamid || ev.xuid || '')
  if (!sid || !carry.has(sid) || !ev.token) return null
  const pk = host.tokenGuard?.publicKey
  if (!pk) return null
  const r = check(pk, ev.token, { matchId: game.leaseId, steamid: sid, seen: null })
  if (!r.ok) return null
  carry.delete(sid)   // once per run
  game.log.info(`restart: ${sid} was verified on the abandoned run of lease ${game.leaseId}; re-admitted to run ${game.runOfLease}`)
  return { allow: true, reason: 'ok', payload: r.payload, carried: true }
}
