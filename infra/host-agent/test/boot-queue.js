#!/usr/bin/env node
// THE 2026-09-23 12:12-12:21 UTC INCIDENTS, REPLAYED AGAINST A REAL HOST AGENT (host.md §16).
//
// A real host agent with simulated games (no WaW), `--gate-sims` so sims go through the boot
// queue like real games, a fake /proc/meminfo the test writes, and a stand-in site speaking
// the v2 pull protocol with a real invite key. The sims model the box's behaviours that
// caused the incidents (sim/sim-instance.js): a map that loads slowly, one that never loads,
// the DLL's warm-instance behaviour (--real-warm) and a warm restart that never comes back.
//
//   A. queued boots and real players first (incident a):
//      - an AGENT boot that never loads, a second agent lease queued behind it, then a
//        PLAYER's lease: the booting agent game is retired (`yielded`), the player's boots
//        next, and is reported `preparing`/`queued` while it waits;
//      - the queued agent lease is retired by the site while queued: it NEVER starts;
//      - no orphan, no "unknown instance".
//   B. the RAM guard: an agent boot under the floor waits (and says `memory`), then is failed
//      after --ram-wait-ms; a player's boot under the floor evicts the agent game.
//   C. warm reuse (incidents b and c), with --after-game end:
//      - the returning player is re-admitted to the warm instance, not DENY (wrong_match);
//      - the next lease takes the warm instance in < 5 s, the old session's game_over is
//        dropped, and no round-0 result is posted for the new lease;
//      - a warm instance that never brings the map back is torn down within ~5 s and the
//        lease boots fresh, with no result posted for it and no `failed`.
//
//   node test/boot-queue.js [--verbose]
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirp, parseArgs } from '../lib/util.js'
import * as keys from '../lib/keys.js'
import { issue } from '../lib/tokens.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-bootqueue-' + Date.now().toString(36)))
const PORTS = { site: 38921, link: 38922, base: 29700 }
const MEMINFO = path.join(RUN, 'meminfo')
const setMem = (mb) => fs.writeFileSync(MEMINFO, `MemTotal:        3884000 kB\nMemFree:          100000 kB\nMemAvailable:   ${mb * 1024} kB\n`)
setMem(1500)

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))
const step = (m) => console.log(`\n── ${m}`)

// ---- the stand-in site ---------------------------------------------------------------
const siteKey = keys.generate()
const sitePub = keys.exportPair(siteKey).pub
const P1 = '76561198000000001'
const lease = (id, { agent = false, map = 'nazi_zombie_prototype', sim = {}, steamid = P1 } = {}) => ({
  status: 'leased', match_id: id, map, mode: 'custom', settings: {}, kind: 'game', agent,
  players: [{ steamid, name: 'P1' }], whitelist: [steamid],
  tokens: { [steamid]: issue(siteKey.privateKey, { steamid, matchId: id }) }, vip: false,
  manifest: null, nonce: `n_${id}`,
  sim: { timescale: 1, max_round: 50, ...sim },
})
let leases = []
const statuses = []     // every per-game post and heartbeat, in order
const results = []
let lastBeat = null
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { /* ignore */ }
    if (u.pathname === '/api/gs/assignment') {
      return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce: leases.length ? leases.map((l) => l.nonce).join('+') : 'idle', assignments: leases })
    }
    if (u.pathname === '/api/gs/status') {
      statuses.push({ at: Date.now(), ...j })
      if (Array.isArray(j.instances)) lastBeat = j
      // What the real site does with these two (assignments.ack): the lease ends.
      if ((j.state === 'yielded' || j.state === 'failed') && j.match_id) leases = leases.filter((l) => l.match_id !== j.match_id)
      return send({ ok: true })
    }
    if (u.pathname === '/api/gs/result') {
      const mid = j.summary?.match_id
      results.push({ at: Date.now(), match_id: mid, rounds: j.summary?.rounds, flags: j.summary?.flags || [] })
      leases = leases.filter((l) => l.match_id !== mid)
      return send({ ok: true })
    }
    if (u.pathname === '/api/gs/chat-feed') return setTimeout(() => send({ ok: true, latest: 1, events: [] }), 1000)
    if (u.pathname === '/api/gs/keys') return send({ invite_pub: sitePub, key_id: 'test-site', alg: 'ed25519' })
    return send({ ok: true })
  })
})
await new Promise((r) => site.listen(PORTS.site, '127.0.0.1', r))

// ---- the host agent ---------------------------------------------------------------------
const host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'bootq-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '3', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
  '--gate-sims', '--after-game', 'end', '--meminfo-file', MEMINFO,
  '--ram-floor-mb', '700', '--ram-settle-ms', '300', '--ram-wait-ms', '6000',
  '--boot-gate-ms', '30000', '--warm-rebind-ms', '5000',
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
const booted = (mid) => new RegExp(`booted inst-\\d+ match=${mid} `).test(out)
async function drain(why) {
  leases = []
  await until(`every instance gone (${why})`, () => /* a fresh heartbeat with nothing in it */ statuses.some((s) => Array.isArray(s.instances) && s.instances.length === 0 && s.at > drain.t), 40_000)
}

try {
  await until('the host agent to come up', () => /host agent up/.test(out))

  // ======================================================================================
  step('A. an agent boot that never loads, an agent lease behind it, then a PLAYER')
  leases = [lease('m_agentA1', { agent: true, sim: { never_loads: true } })]
  await until('m_agentA1 to boot', () => booted('m_agentA1'))
  leases = [...leases, lease('m_agentA2', { agent: true })]
  await until('m_agentA2 to be reported queued', () => statuses.find((s) => s.match_id === 'm_agentA2' && s.state === 'preparing' && s.preparing?.phase === 'queued'))
  check(!booted('m_agentA2'), 'm_agentA2 waits: one game boots at a time')
  const q = posted('m_agentA2', 'preparing')
  check(q?.preparing?.ahead === 1 && q.preparing.reason === 'boot', `queued with ${q?.preparing?.ahead} ahead, reason ${q?.preparing?.reason}`)
  const tReal = Date.now()
  leases = [...leases, lease('m_realB', { sim: { load_ms: 8000 } })]
  if (await until('the agent game booting ahead of the player to be yielded', () => posted('m_agentA1', 'yielded')))
    ok('m_agentA1 (the booting agent game) was retired and reported `yielded`')
  await until('m_realB to boot', () => booted('m_realB'))
  const iB = out.search(/booted inst-\d+ match=m_realB /)
  const iA2 = out.search(/booted inst-\d+ match=m_agentA2 /)
  check(iA2 < 0 || iB < iA2, 'the player\'s boot went before the queued agent boot')
  // The site drops the queued agent lease while the player's game is still loading.
  leases = leases.filter((l) => l.match_id !== 'm_agentA2')
  if (await until('m_realB ready', () => posted('m_realB', 'ready')))
    ok(`m_realB ready ${((Date.now() - tReal) / 1000).toFixed(1)} s after its lease (map load 8 s)`)
  await delay(4000)
  check(!booted('m_agentA2'), 'the agent lease retired while QUEUED never started (12:13:36 orphan)')
  check(!/hello from unknown instance/.test(out) && !/INCIDENT orphan_hello/.test(out), 'no orphan hello, no unknown instance')
  check(lastBeat?.mem && lastBeat.mem.available_bytes === 1500 * 1024 * 1024 && lastBeat.mem.floor_bytes === 700 * 1024 * 1024, `the heartbeat carries mem (${lastBeat?.mem ? Math.round(lastBeat.mem.available_bytes / 1048576) + ' MB available' : 'none'})`)

  // ======================================================================================
  step('B. the RAM guard')
  leases = [...leases, lease('m_agentC1', { agent: true })]
  await until('m_agentC1 to boot', () => booted('m_agentC1'))
  await until('m_agentC1 ready', () => posted('m_agentC1', 'ready'))
  setMem(300)
  leases = [...leases, lease('m_agentC2', { agent: true })]
  if (await until('m_agentC2 to wait for memory', () => statuses.find((s) => s.match_id === 'm_agentC2' && s.preparing?.reason === 'memory')))
    ok('an agent boot under the 700 MB floor waits, reported `queued` for `memory`')
  await until('m_agentC2 to be failed after --ram-wait-ms', () => posted('m_agentC2', 'failed'), 15_000)
  check(!booted('m_agentC2'), 'm_agentC2 was failed, never booted')
  // A player's lease with the box under the floor: the agent game goes.
  const tR = Date.now()
  leases = [...leases, lease('m_realD')]
  if (await until('the agent game to be evicted for the player', () => posted('m_agentC1', 'yielded')))
    ok('m_agentC1 (agent) evicted for the player\'s memory (`yielded`)')
  check(/INCIDENT ram_evict/.test(out), 'the eviction is an incident')
  check(!posted('m_realB', 'yielded'), 'the other PLAYER\'s game was not touched')
  setMem(1200)   // the evicted game's memory comes back
  if (await until('m_realD ready', () => posted('m_realD', 'ready')))
    ok(`m_realD ready ${((Date.now() - tR) / 1000).toFixed(1)} s after its lease`)

  drain.t = Date.now()
  await drain('before C')
  setMem(1500)

  // ======================================================================================
  step('C. warm reuse, with the box DLL\'s behaviour (--real-warm)')
  // A short game: round 1 is the target, fast.
  leases = [lease('m_warm1', { sim: { timescale: 30, max_round: 1, games: 5, real_warm: true, stall_rebind: 2 } })]
  await until('m_warm1 to finish and the instance to go warm', () => /instance inst-\d+ is WARM/.test(out), 60_000)
  const r1 = results.find((r) => r.match_id === 'm_warm1')
  check(r1 && r1.rounds >= 1, `m_warm1 posted its result (round ${r1?.rounds})`)
  await until('the returning player to be re-admitted', () => /admitted as a returning player/.test(out), 10_000)
  check(!/DENY \(wrong_match\)/.test(out), 'the returning player was NOT refused wrong_match (12:17:02)')

  const t2 = Date.now()
  leases = [lease('m_warm2', { sim: { timescale: 30, max_round: 1 } })]
  await until('m_warm2 ready', () => posted('m_warm2', 'ready'), 15_000)
  const took = Date.now() - t2
  check(/lease m_warm2 handed to WARM instance/.test(out), 'm_warm2 went to the warm instance')
  check(took < 8000, `m_warm2 ready ${(took / 1000).toFixed(1)} s after its lease (poll + handoff; the handoff itself < 5 s)`)
  const tookMs = Number((/took lease m_warm2 in (\d+) ms/.exec(out) || [])[1])
  check(tookMs >= 0 && tookMs < 5000, `the warm instance took the lease in ${tookMs} ms`)
  check(/game_over from the session before this one/.test(out), 'the old session\'s game_over was dropped, not taken as m_warm2\'s')
  await delay(1500)
  const early = results.find((r) => r.match_id === 'm_warm2')
  check(!early || early.rounds >= 1, 'no round-0 result posted for m_warm2 at the handoff (12:19:30 ended B\'s lease this way)')
  check(!/disposition: TERMINATE — 5 game/.test(out), 'no reuse cascade to the five-game limit')
  if (await until('m_warm2 to finish with a real result', () => results.find((r) => r.match_id === 'm_warm2' && r.rounds >= 1), 60_000))
    ok('m_warm2 played and posted its own result')

  step('C2. a warm instance that never brings the map back')
  await until('the instance to go warm again', () => (out.match(/is WARM/g) || []).length >= 2, 30_000)
  const t3 = Date.now()
  leases = [lease('m_warm3', { sim: { timescale: 1, max_round: 50 } })]
  await until('the failed handoff', () => /the warm instance would not take lease m_warm3/.test(out), 15_000)
  const failedAfter = Date.now() - t3
  check(failedAfter < 9000, `torn down ${(failedAfter / 1000).toFixed(1)} s after the lease (5 s rebind deadline + poll)`)
  check(/INCIDENT warm_handoff_failed/.test(out), 'the failed handoff is an incident')
  await until('m_warm3 to boot fresh', () => booted('m_warm3'), 15_000)
  if (await until('m_warm3 ready', () => posted('m_warm3', 'ready'), 15_000))
    ok(`m_warm3 ready on a fresh boot ${((Date.now() - t3) / 1000).toFixed(1)} s after its lease`)
  check(!results.some((r) => r.match_id === 'm_warm3'), 'no result was posted for m_warm3 (its lease is still live)')
  check(!posted('m_warm3', 'failed'), 'm_warm3 was never reported failed')
  check(leases.some((l) => l.match_id === 'm_warm3'), 'the site still has m_warm3 leased')
} catch (e) {
  bad(`threw: ${e.stack}`)
} finally {
  host.kill('SIGTERM')
  await delay(1500)
  try { host.kill('SIGKILL') } catch { /* gone */ }
  site.close()
  if (failures) {
    fs.writeFileSync(path.join(RUN, 'host.out'), out)
    console.log(`\nhost output: ${path.join(RUN, 'host.out')}`)
  }
  console.log(`\n${failures ? `\x1b[31mFAIL\x1b[0m ${failures} failure(s)` : '\x1b[32mPASS\x1b[0m'} boot-queue (${RUN})`)
  process.exit(failures ? 1 : 0)
}
