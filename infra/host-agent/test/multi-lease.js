#!/usr/bin/env node
// SEVERAL LEASES ON ONE BOX, end to end on the box's side (2026-09-23, lib/leases.js).
//
// A real host agent (simulated games, no WaW) against a stand-in site that speaks the v2
// pull protocol (`GET /api/gs/assignment?v=2` -> { v: 2, assignments: [...] }). It proves
// the rule that replaced "the newest lease wins":
//
//   1. two leases -> two instances, two match ids, both up;
//   2. one of them cancelled -> ONLY that one is retired, the other keeps its instance;
//   3. a third lease arrives -> it boots beside the survivor, which is untouched;
//   4. idle -> every leased game is retired, the box reports nothing.
//
//   node test/multi-lease.js [--verbose]
//
// The site side of the same rules (who may lease, reserve, yield, box full) is
// web/test/run-all.js "several games per box".
import http from 'node:http'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirp, parseArgs } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-multilease-' + Date.now().toString(36)))
const PORTS = { site: 38911, link: 38912, base: 29600 }

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }

// ---- the stand-in site ---------------------------------------------------------------
const lease = (id, map = 'nazi_zombie_prototype', steamid = '76561198000000001') => ({
  status: 'leased', match_id: id, map, mode: 'custom', settings: {}, kind: 'game',
  players: [{ steamid, name: 'P1' }], whitelist: [steamid], tokens: {}, vip: false,
  manifest: null, nonce: `n_${id}`,
  // The simulator plays slowly so nothing ends on its own during the run.
  sim: { timescale: 1, max_round: 50 },
})
let leases = []
let lastStatus = null
const polls = []
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/api/gs/assignment') {
      polls.push(u.searchParams.get('v'))
      return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce: leases.length ? leases.map((l) => l.nonce).join('+') : 'idle', assignments: leases })
    }
    if (u.pathname === '/api/gs/status') {
      try { const j = JSON.parse(body || '{}'); if (Array.isArray(j.instances)) lastStatus = j } catch { /* ignore */ }
      return send({ ok: true })
    }
    if (u.pathname === '/api/gs/chat-feed') return setTimeout(() => send({ ok: true, latest: 1, events: [] }), 1000)
    if (u.pathname === '/api/gs/keys') { res.statusCode = 404; return send({ error: 'no key in this test' }) }
    return send({ ok: true })
  })
})
await new Promise((r) => site.listen(PORTS.site, '127.0.0.1', r))

// ---- the host agent ---------------------------------------------------------------------
const host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'multi-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '3', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
const tee = (d) => { out += d; if (a.verbose) process.stdout.write(`\x1b[90m[box]\x1b[0m ${d}`) }
host.stdout.on('data', tee); host.stderr.on('data', tee)

// Status heartbeats are every 10 s; a per-game post can also carry the list.
const running = () => new Map((lastStatus?.instances || []).filter((i) => i.match_id && i.state === 'running').map((i) => [i.match_id, i]))
async function until(what, fn, ms = 40_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await delay(300) }
  bad(`timed out: ${what}`); return null
}

try {
  console.log('\n── 1. two leases -> two instances, both up')
  leases = [lease('m_multi_a'), lease('m_multi_b', 'nazi_zombie_asylum', '76561198000000002')]
  const two = await until('both leases running', () => { const r = running(); return r.has('m_multi_a') && r.has('m_multi_b') ? r : null })
  if (two) ok(`m_multi_a on ${two.get('m_multi_a').id} (port ${two.get('m_multi_a').port}), m_multi_b on ${two.get('m_multi_b').id} (port ${two.get('m_multi_b').port})`)
  if (two && two.get('m_multi_a').port === two.get('m_multi_b').port) bad('two leases on ONE port')
  if (/supersedes/.test(out)) bad('something was superseded')
  if (polls.length && polls.every((v) => v === '2')) ok('the agent polls with ?v=2')
  else bad(`the agent did not poll with ?v=2 (${polls.slice(0, 3).join(',')})`)
  if (lastStatus?.protocol === 2 && lastStatus?.max_instances === 3) ok('status says protocol 2, max_instances 3')
  else bad(`status protocol/max_instances: ${lastStatus?.protocol}/${lastStatus?.max_instances}`)
  const instA = two?.get('m_multi_a')

  console.log('\n── 2. m_multi_b cancelled -> only it is retired')
  leases = [lease('m_multi_a')]
  await until('m_multi_b retired', () => /retiring instance \S+: lease m_multi_b is no longer live/.test(out))
  await delay(11_000)   // one heartbeat after the retire
  const r2 = running()
  if (!r2.has('m_multi_b')) ok('m_multi_b is gone from the box')
  else bad('m_multi_b is still running')
  if (r2.has('m_multi_a') && instA && r2.get('m_multi_a').id === instA.id && r2.get('m_multi_a').pid === instA.pid) ok(`m_multi_a untouched (${instA.id}, same pid)`)
  else bad('m_multi_a did not survive its neighbour being cancelled')

  console.log('\n── 3. a third lease boots beside the survivor')
  leases = [lease('m_multi_a'), lease('m_multi_c', 'nazi_zombie_sumpf', '76561198000000003')]
  const three = await until('m_multi_c running', () => { const r = running(); return r.has('m_multi_c') ? r : null })
  if (three) ok(`m_multi_c on ${three.get('m_multi_c').id}`)
  if (three && three.get('m_multi_a')?.id === instA?.id) ok('m_multi_a still on its own instance')
  else bad('m_multi_a moved or went away')
  if (/lease m_multi_a is no longer live/.test(out)) bad('m_multi_a was retired at some point')

  console.log('\n── 4. idle -> every leased game is retired')
  leases = []
  await until('both retired', () => /lease m_multi_a is no longer live/.test(out) && /lease m_multi_c is no longer live/.test(out))
  await delay(11_000)
  if (running().size === 0) ok('nothing running')
  else bad(`still running: ${[...running().keys()].join(', ')}`)
} catch (e) {
  bad(e.stack || e.message)
} finally {
  host.kill()
  site.close()
}
if (failures) console.log(`\n\x1b[90m${out.split('\n').filter((l) => /lease|retir|booted|slot/.test(l)).slice(-40).join('\n')}\x1b[0m`)
console.log(`\n${failures ? '\x1b[31mFAIL' : '\x1b[32mPASS'}\x1b[0m multi-lease (${RUN})`)
process.exit(failures ? 1 : 0)
