#!/usr/bin/env node
// A player's "Restart game" (lib/restart.js; docs/kickstart/esc-menu.md §3), in-process.
// The real Referee and the real token code; the Game is a stand-in with exactly the surface
// restart.js touches (host.js's Game is not exported and boots a whole agent on import).
//
//   node test/restart.js
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Referee } from '../lib/referee.js'
import { defaultManifest } from '../lib/manifests.js'
import { issue, TokenGuard } from '../lib/tokens.js'
import * as keys from '../lib/keys.js'
import { mkdirp } from '../lib/util.js'
import { onRestartRequest, handOver } from '../lib/restart.js'

const TMP = mkdirp(path.join(os.tmpdir(), 'enw-host-restart-tests'))
let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`\x1b[32m ok  \x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`\x1b[31mFAIL \x1b[0m ${name}\n        ${e.message}`) }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }

const quiet = { info() {}, warn() {}, debug() {}, error(e) { console.error(e) } }
const site = keys.loadOrCreate(path.join(TMP, 'site-key.json'))
const LEASE = 'm_lease1'
const A = '76561198000000301', B = '76561198000000302'

class FakeGame extends EventEmitter {
  constructor(host, instance, { matchId, mode, vip, assignment, tokens, selfReported }) {
    super()
    Object.assign(this, { host, instance, matchId, mode, vip, assignment, tokens, selfReported })
    this.log = quiet
    this.events = []
    this.sent = []
    this.referee = new Referee({ instanceId: instance.id, matchId, mode: mode || 'verified', manifest: defaultManifest('nazi_zombie_prototype'), config: {}, log: quiet })
    this.referee.on('command', (c) => this.sent.push(c))
  }
  recordHostEvent(ev) { this.events.push(ev) }
  attach(conn) { this.conn = conn }
  detach() { const c = this.conn; this.conn = null; return c }
}

function makeHost() {
  return {
    byInstance: new Map(),
    tokenGuard: new TokenGuard(site.publicKey),
    retired: [],
    retire(g, why) { this.retired.push({ g, why }); return Promise.resolve(true) },
    reportStatus() {},
  }
}

function game({ players = [[0, A, 'verified']], host = makeHost() } = {}) {
  const g = new FakeGame(host, { id: 'inst-01' }, { matchId: LEASE, mode: 'verified', assignment: { match_id: LEASE }, tokens: {} })
  g.conn = { name: 'the socket' }
  host.byInstance.set('inst-01', g)
  const r = g.referee
  r.onEvent({ t: 'hello', ms: 0, instance: 'inst-01', role: 'server', pid: 7 })
  r.onEvent({ t: 'map_loaded', ms: 0, map: 'nazi_zombie_prototype', mode: 'zombies', sv_maxclients: 4 })
  for (const [slot, sid, identity] of players) {
    r.onEvent({ t: 'player_connect', ms: 0, slot, name: `p${slot}`, steamid: sid, token: 'x' })
    r.setIdentity(slot, identity)
  }
  r.onEvent({ t: 'round', ms: 1000, n: 3 })
  return g
}

console.log('\n== who may restart ==')

t('a verified player alone: accepted; run flagged; `end` carries the lease', () => {
  const g = game()
  const r = onRestartRequest(g, { t: 'restart_request', slot: 0, name: 'p0', players: 1 })
  eq(r.ok, true, 'ok')
  ok(g.referee.flags.has('abandoned') && g.referee.flags.has('player_restart'), 'flags')
  const end = g.sent.find((c) => c.t === 'end')
  eq([end.reason, end.match], ['player_restart', LEASE], 'end')
  eq(g.events[0].t, 'restart_accepted', 'recorded')
  clearTimeout(g.restartTimer)
})

t('an unverified player ALONE may restart (B: "any player in solo")', () => {
  const g = game({ players: [[0, A, 'claimed']] })
  eq(onRestartRequest(g, { slot: 0 }).ok, true)
  clearTimeout(g.restartTimer)
})

t('co-op: an unverified player is refused and nothing is sent', () => {
  const g = game({ players: [[0, A, 'verified'], [1, B, 'claimed']] })
  const r = onRestartRequest(g, { slot: 1 })
  eq(r.ok, false, 'refused')
  eq(g.sent.filter((c) => c.t === 'end').length, 0, 'no end')
  eq(g.events[0].t, 'restart_refused', 'recorded')
  ok(!g.referee.flags.has('abandoned'), 'the run is untouched')
})

t('co-op: a verified player may', () => {
  const g = game({ players: [[0, A, 'verified'], [1, B, 'claimed']] })
  eq(onRestartRequest(g, { slot: 0 }).ok, true)
  eq([...g.restartCarry], [A], 'only the verified player is carried')
  clearTimeout(g.restartTimer)
})

t('a second request while one is under way, or after the run is over, is ignored', () => {
  const g = game()
  onRestartRequest(g, { slot: 0 })
  eq(onRestartRequest(g, { slot: 0 }).ok, false, 'under way')
  clearTimeout(g.restartTimer)
  const h = game()
  h.finished = true
  eq(onRestartRequest(h, { slot: 0 }).ok, false, 'finished')
})

console.log('\n== the handover ==')

t('match_end -> a successor on the same lease with its own run id takes the link', () => {
  const host = makeHost()
  const g = game({ host })
  onRestartRequest(g, { slot: 0 })
  // what the DLL does next: game_over (reason player_restart) then match_end
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  g.matchEndSeen = true
  const next = handOver(g)
  eq(next.matchId, `${LEASE}.r2`, 'run id')
  eq(next.leaseId, LEASE, 'lease')
  eq(next.conn && next.conn.name, 'the socket', 'the link moved')
  eq(g.conn, null, 'the old run let go')
  eq(host.byInstance.get('inst-01'), next, 'the instance is the successor\'s')
  ok(g.disposed, 'the old run has its disposition (neither reuse nor teardown)')
  eq(next.events[0].t, 'run_restarted', 'recorded in the new run')
  eq(next.events[0].from_match, LEASE, 'from')
  eq(g.referee.endReason, 'player_restart', 'the old run ended as player_restart')
})

t('the successor\'s summary names the lease (the site attaches it by this)', () => {
  const host = makeHost()
  const g = game({ host })
  onRestartRequest(g, { slot: 0 })
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  const next = handOver(g)
  let seen = null
  next.referee.on('over', (s) => { seen = s })
  next.referee.onEvent({ t: 'map_loaded', ms: 0, map: 'nazi_zombie_prototype' })
  next.referee.finishGame('test')
  eq([seen.match_id, seen.lease_match_id, seen.run_of_lease, seen.restart_of], [`${LEASE}.r2`, LEASE, 2, LEASE])
})

t('a second restart on the successor is run 3 of the same lease', () => {
  const host = makeHost()
  const g = game({ host })
  onRestartRequest(g, { slot: 0 })
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  const n2 = handOver(g)
  n2.referee.onEvent({ t: 'player_connect', ms: 0, slot: 0, name: 'p0', steamid: A, token: 'x' })
  n2.referee.setIdentity(0, 'verified')
  eq(onRestartRequest(n2, { slot: 0 }).ok, true)
  eq(n2.sent.find((c) => c.t === 'end').match, LEASE, 'still the lease')
  n2.referee.onEvent({ t: 'game_over', ms: 5000, round: 1, reason: 'player_restart', players: [] })
  const n3 = handOver(n2)
  eq(n3.matchId, `${LEASE}.r3`)
})

t('the game refusing `end` tears the instance down', () => {
  const host = makeHost()
  const g = game({ host })
  onRestartRequest(g, { slot: 0 })
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  const next = handOver(g)
  next.referee.onEvent({ t: 'reply', id: g.restartCmdId, ok: false, error: 'no command buffer bound' })
  eq(host.retired.length, 1, 'retired')
  ok(host.retired[0].g === next, 'the successor is what was retired')
})

t('no link at match_end: no successor, the ordinary disposition runs', () => {
  const g = game()
  onRestartRequest(g, { slot: 0 })
  g.conn = null
  eq(handOver(g), null)
  eq(g.disposed, null, 'dispose() is left to decide')
})

console.log('\n== the players come back ==')

t('a player verified before the restart is re-admitted once, with a real check', () => {
  const host = makeHost()
  const g = game({ host })
  const tok = issue(site.privateKey, { steamid: A, matchId: LEASE })
  host.tokenGuard.admit({ token: tok, steamid: A }, LEASE)          // the first run spent it
  eq(host.tokenGuard.admit({ token: tok, steamid: A }, LEASE).reason, 'replayed', 'single use holds')
  onRestartRequest(g, { slot: 0 })
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  const next = handOver(g)
  const r = next.restartAdmit({ t: 'player_connect', slot: 0, token: tok, steamid: A })
  eq([r.allow, r.reason, r.carried], [true, 'ok', true], 'carried')
  eq(next.restartAdmit({ t: 'player_connect', slot: 0, token: tok, steamid: A }), null, 'once per run')
})

t('nobody else is carried: another steamid, another lease, a forged token', () => {
  const host = makeHost()
  const g = game({ host, players: [[0, A, 'verified'], [1, B, 'claimed']] })
  onRestartRequest(g, { slot: 0 })
  g.referee.onEvent({ t: 'game_over', ms: 5000, round: 3, reason: 'player_restart', players: [] })
  const next = handOver(g)
  const other = keys.loadOrCreate(path.join(TMP, 'forger-key.json'))
  eq(next.restartAdmit({ token: issue(site.privateKey, { steamid: B, matchId: LEASE }), steamid: B }), null, 'B was never verified')
  eq(next.restartAdmit({ token: issue(site.privateKey, { steamid: A, matchId: 'm_other' }), steamid: A }), null, 'wrong lease')
  eq(next.restartAdmit({ token: issue(other.privateKey, { steamid: A, matchId: LEASE }), steamid: A }), null, 'forged')
})

console.log(`\nrestart: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
