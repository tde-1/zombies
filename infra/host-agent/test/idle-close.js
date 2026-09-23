#!/usr/bin/env node
// IDLE-SERVER AUTO-CLOSE AGAINST A REAL HOST AGENT (lib/idle.js; esc-menu.md §13).
//
// B's lease m_5a28dcbe (zm_nuked) went `ready` at 16:36 UTC 2026-09-23, nobody joined, and it
// held the box for 95 minutes. A real host agent with simulated games and a stand-in site:
//
//   A. nobody joins: the lease is closed --idle-ready-ms after `ready` -- a per-game status
//      `no_players` (rule never_joined) reaches the site, the instance is retired, and NO
//      result is posted (no game was played);
//   B. a join in progress (`hold_idle` on the lease: a download, a Resume): nothing closes
//      while it is held; the close comes after the hold is lifted;
//   C. the player joins and plays, then everybody leaves: the run ends --idle-gone-ms later,
//      its result is posted with the `no_players` flag (the site's ingest ends the lease);
//   D. a player who stays connected is never closed.
//
//   node test/idle-close.js [--verbose]
import http from 'node:http'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirp, parseArgs } from '../lib/util.js'
import * as keys from '../lib/keys.js'
import { issue } from '../lib/tokens.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-idleclose-' + Date.now().toString(36)))
const PORTS = { site: 38941, link: 38942, base: 29800 }
const READY_MS = 4000
const GONE_MS = 4000

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))
const step = (m) => console.log(`\n── ${m}`)

const siteKey = keys.generate()
const sitePub = keys.exportPair(siteKey).pub
const P1 = '76561198000000001'
const lease = (id, { sim = {}, hold = false } = {}) => ({
  status: 'leased', match_id: id, map: 'nazi_zombie_prototype', mode: 'custom', settings: {}, kind: 'game', agent: false,
  players: [{ steamid: P1, name: 'P1' }], whitelist: [P1],
  tokens: { [P1]: issue(siteKey.privateKey, { steamid: P1, matchId: id }) }, vip: false,
  manifest: null, nonce: `n_${id}`, ...(hold ? { hold_idle: true } : {}),
  sim: { timescale: 1, max_round: 50, ...sim },
})
let leases = []
const statuses = []
const results = []
const topNonce = () => leases.length ? leases.map((l) => l.nonce + (l.hold_idle ? '+hold' : '')).join('+') : 'idle'
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { /* ignore */ }
    if (u.pathname === '/api/gs/assignment') return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce: topNonce(), assignments: leases })
    if (u.pathname === '/api/gs/status') {
      statuses.push({ at: Date.now(), ...j })
      // What the real site does (assignments.ack): `no_players` ends the lease.
      if (j.state === 'no_players' && j.match_id) leases = leases.filter((l) => l.match_id !== j.match_id)
      return send({ ok: true })
    }
    if (u.pathname === '/api/gs/result') {
      results.push({ at: Date.now(), match_id: j.summary?.match_id, end_reason: j.summary?.end_reason, flags: j.summary?.flags || [] })
      leases = leases.filter((l) => l.match_id !== j.summary?.match_id)
      return send({ ok: true })
    }
    if (u.pathname === '/api/gs/chat-feed') return setTimeout(() => send({ ok: true, latest: 1, events: [] }), 1000)
    if (u.pathname === '/api/gs/keys') return send({ invite_pub: sitePub, key_id: 'test-site', alg: 'ed25519' })
    return send({ ok: true })
  })
})
await new Promise((r) => site.listen(PORTS.site, '127.0.0.1', r))

const host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'idle-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '3', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
  '--idle-ready-ms', String(READY_MS), '--idle-gone-ms', String(GONE_MS), '--restart-grace-ms', '0',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
const tee = (d) => { out += d; if (a.verbose) process.stdout.write(`\x1b[90m[box]\x1b[0m ${d}`) }
host.stdout.on('data', tee); host.stderr.on('data', tee)

async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await delay(200) }
  bad(`timed out waiting for ${what}`)
  return null
}
const posted = (mid, state) => statuses.find((s) => s.match_id === mid && s.state === state)

try {
  await until('the host agent to come up', () => /host agent up/.test(out))

  step('A. nobody joins')
  leases = [lease('m_idleA', { sim: { no_join: true } })]
  const rA = await until('m_idleA ready', () => posted('m_idleA', 'ready'))
  const cA = await until('m_idleA closed `no_players`', () => posted('m_idleA', 'no_players'), READY_MS + 15_000)
  if (rA && cA) {
    const after = cA.at - rA.at
    check(after >= READY_MS - 500 && after < READY_MS + 4000, `closed ${after} ms after ready (--idle-ready-ms ${READY_MS})`)
    check(cA.rule === 'never_joined' && /nobody joined/.test(cA.error || ''), `rule ${cA.rule}: ${cA.error}`)
  }
  await until('m_idleA retired', () => /retiring instance inst-\d+: no_players: nobody joined/.test(out))
  await delay(1500)
  check(!results.some((r) => r.match_id === 'm_idleA'), 'no result posted for a game nobody played')

  step('B. a join in progress holds it')
  leases = [lease('m_idleB', { sim: { no_join: true }, hold: true })]
  const rB = await until('m_idleB ready', () => posted('m_idleB', 'ready'))
  await delay(READY_MS + 3000)
  check(!posted('m_idleB', 'no_players'), `held for ${READY_MS + 3000} ms past ready while the site says a join is in progress`)
  delete leases[0].hold_idle   // the download finished; the nonce moves, the box re-reads the list
  const cB = await until('m_idleB closed after the hold', () => posted('m_idleB', 'no_players'), 15_000)
  if (rB && cB) ok(`closed ${cB.at - rB.at} ms after ready, once the hold was lifted`)

  step('C. the player plays, then everybody leaves')
  leases = [lease('m_idleC', { sim: { leave_ms: 6000 } })]
  const rC = await until('m_idleC ready', () => posted('m_idleC', 'ready'))
  // The sim's clock starts at map_loaded (timescale 1): everybody leaves ~6 s after ready.
  const left = rC ? rC.at + 6000 : null
  const resC = await until('m_idleC result', () => results.find((r) => r.match_id === 'm_idleC'), GONE_MS + 20_000)
  if (resC) {
    check(resC.flags.includes('no_players'), `result flags [${resC.flags.join(',')}] carry no_players (end_reason ${resC.end_reason})`)
    if (left) check(resC.at - left >= GONE_MS - 1500, `ended ${resC.at - left} ms after everybody left (--idle-gone-ms ${GONE_MS})`)
  }
  check(!posted('m_idleC', 'no_players'), 'a game that was played is not a "nobody joined" close')

  step('D. a player who stays is never closed')
  leases = [lease('m_idleD')]
  const rD = await until('m_idleD ready', () => posted('m_idleD', 'ready'))
  await delay(READY_MS + GONE_MS + 2000)
  check(!posted('m_idleD', 'no_players') && !results.some((r) => r.match_id === 'm_idleD'), `still running ${READY_MS + GONE_MS + 2000} ms after ready with its player in it`)
  void rD
} catch (e) {
  bad(`threw: ${e.stack || e.message}`)
} finally {
  host.kill('SIGTERM')
  await delay(500)
  site.close()
}
console.log(failures ? `\n\x1b[31mFAIL\x1b[0m idle-close: ${failures} failure(s) (${RUN})` : `\n\x1b[32mPASS\x1b[0m idle-close (${RUN})`)
process.exit(failures ? 1 : 0)
