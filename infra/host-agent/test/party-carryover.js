#!/usr/bin/env node
// PARTIES THAT CARRY OVER, on the box's side (docs/kickstart/cloud-brief-parties.md tasks 1-3).
//
// A real host agent (simulated games, no WaW) against a stand-in site that speaks the v2 pull
// protocol. It proves:
//
//   1. a lease naming 2 players: the game is told `expected_players 2` when it links (task 1);
//   2. a player ADDED to that running lease (the site's assignments.addPlayer: same match id,
//      same lease nonce, a new token): no reboot, no retire, same pid, and the game is told
//      `expected_players 3` (task 2);
//   3. a map switch (the site supersedes the lease with a new match for the same party): the
//      old game is retired cleanly and the new one boots and is told its count (task 3).
//
//   node test/party-carryover.js [--verbose]
import http from 'node:http'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirp, parseArgs } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-carry-' + Date.now().toString(36)))
const PORTS = { site: 38931, link: 38932, base: 29700 }

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))

// ---- the stand-in site ---------------------------------------------------------------
const P = (n) => ({ steamid: `7656119800000070${n}`, name: `P${n}` })
const lease = (id, map, players) => ({
  status: 'leased', match_id: id, map, mode: 'custom', settings: {}, kind: 'game',
  players, whitelist: players.map((p) => p.steamid), tokens: Object.fromEntries(players.map((p) => [p.steamid, `tok-${p.steamid}`])),
  vip: false, manifest: null, nonce: `n_${id}`,          // the per-lease nonce: FIXED for the lease's life
  sim: { timescale: 1, max_round: 50 },
})
// What the real site's forBox v2 does: the list nonce carries each lease's nonce AND its players.
const listNonce = (list) => createHash('sha256').update(list.map((l) => l.nonce + '+' + l.whitelist.join(',')).join('|')).digest('hex').slice(0, 12)
let leases = []
let lastStatus = null
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/api/gs/assignment') {
      return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce: leases.length ? listNonce(leases) : 'idle', assignments: leases })
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
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'carry-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '3', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let out = ''
const tee = (d) => { out += d; if (a.verbose) process.stdout.write(`\x1b[90m[box]\x1b[0m ${d}`) }
host.stdout.on('data', tee); host.stderr.on('data', tee)

const running = () => new Map((lastStatus?.instances || []).filter((i) => i.match_id && i.state === 'running').map((i) => [i.match_id, i]))
async function until(what, fn, ms = 40_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = fn(); if (v) return v; await delay(300) }
  bad(`timed out: ${what}`); return null
}

try {
  console.log('\n── 1. a lease of 2: the game is told expected_players 2 (task 1)')
  leases = [lease('m_carry_a', 'nazi_zombie_prototype', [P(1), P(2)])]
  const up = await until('m_carry_a running', () => running().get('m_carry_a'))
  if (up) ok(`m_carry_a on ${up.id} (pid ${up.pid})`)
  check(await until('told 2', () => /expected_players 2 -> game for m_carry_a \((linked|map_loaded)\)/.test(out)), 'the host sent expected_players 2 for m_carry_a')

  console.log('\n── 2. a player added mid-game: no reboot (task 2)')
  const before = out.length
  leases = [{ ...leases[0], players: [P(1), P(2), P(3)], whitelist: [P(1), P(2), P(3)].map((p) => p.steamid), tokens: { ...leases[0].tokens, [P(3).steamid]: 'tok-new' } }]
  check(await until('added', () => /m_carry_a: P3 added mid-game \(3 player\(s\) now\) — no reboot/.test(out)), 'the host noted P3 added to m_carry_a')
  check(await until('told 3', () => /expected_players 3 -> game for m_carry_a \(players_added\)/.test(out), 10_000), 'the game was told expected_players 3')
  await delay(11_000)   // a heartbeat
  const r2 = running().get('m_carry_a')
  check(r2 && up && r2.id === up.id && r2.pid === up.pid, `same instance, same pid (${r2?.id} ${r2?.pid})`)
  const since = out.slice(before)
  check(!/retiring instance|lease m_carry_a: .* \dp$|booting/m.test(since.replace(/added mid-game/g, '')), 'nothing retired or booted')

  console.log('\n── 3. a map switch: the old game retires cleanly, the new one boots (task 3)')
  leases = [{ ...lease('m_carry_b', 'nazi_zombie_asylum', [P(1), P(2), P(3)]), switched_from: 'm_carry_a' }]
  check(await until('old retired', () => /retiring instance \S+: lease m_carry_a is no longer live/.test(out)), 'm_carry_a retired (its lease is superseded)')
  const nb = await until('m_carry_b running', () => running().get('m_carry_b'))
  if (nb) ok(`m_carry_b on ${nb.id}`)
  check(await until('told 3 for b', () => /expected_players 3 -> game for m_carry_b/.test(out), 10_000), 'the new game is told expected_players 3')
  await delay(11_000)
  check(!running().has('m_carry_a'), 'm_carry_a is gone from the box')

  leases = []
  await until('all retired', () => /lease m_carry_b is no longer live/.test(out))
} catch (e) {
  bad(e.stack || e.message)
} finally {
  host.kill()
  site.close()
}
if (failures) console.log(`\n\x1b[90m${out.split('\n').filter((l) => /lease|retir|boot|expected_players|added/.test(l)).slice(-40).join('\n')}\x1b[0m`)
console.log(`\n${failures ? '\x1b[31mFAIL' : '\x1b[32mPASS'}\x1b[0m party-carryover (${RUN})`)
process.exit(failures ? 1 : 0)
