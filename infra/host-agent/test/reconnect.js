#!/usr/bin/env node
// DISCONNECT -> PAUSE -> RECONNECT AGAINST A REAL HOST AGENT (lib/referee.js drop hold,
// server/components/referee/reconnect_rules.hpp; host.md "2026-09-24 cloud: disconnect pause").
//
// B, 2026-09-24: "If someone disconnects from the game, it pauses and allows people to
// reconnect and continue as if nothing happened." A real host agent, simulated games that
// speak the new events (`reconnect: 1`, player_lost / player_ready, `restore`), and a stand-in
// site:
//
//   A. co-op, P2's game crashes and P2 relaunches: the whole game freezes (`pause` sent, the
//      live frame says paused and names P2 as away), P2 comes back in another slot with a
//      fresh token, their state is sent back (`restore`), the countdown runs once they are in,
//      the game resumes and later posts a result tagged rejoined + resumed;
//   B. co-op, P2 quits on purpose (the site's live-frame reply says so): nothing freezes;
//   C. co-op, P2 crashes and never comes back: after the grace their body is kicked and P1
//      plays on.
//
//   node test/reconnect.js [--verbose]
import fs from 'node:fs'
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
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-reconnect-' + Date.now().toString(36)))
const PORTS = { site: 38951, link: 38952, base: 29850 }
const GONE_MS = 6000   // --idle-gone-ms and --drop-hold-ms (separate settings since 2026-09-24)

let failures = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }
const check = (c, m) => (c ? ok(m) : bad(m))
const step = (m) => console.log(`\n── ${m}`)

const siteKey = keys.generate()
const sitePub = keys.exportPair(siteKey).pub
const P1 = '76561198000000001'
const P2 = '76561198000000002'
const tok = (sid, id) => issue(siteKey.privateKey, { steamid: sid, matchId: id })
const lease = (id, sim = {}) => ({
  status: 'leased', match_id: id, map: 'nazi_zombie_prototype', mode: 'custom', settings: {}, kind: 'game', agent: false,
  players: [{ steamid: P1, name: 'P1' }, { steamid: P2, name: 'P2' }], whitelist: [P1, P2],
  tokens: { [P1]: tok(P1, id), [P2]: tok(P2, id) }, vip: false,
  manifest: null, nonce: `n_${id}`,
  sim: { timescale: 1, max_round: 50, reconnect: true, ...sim },
})
let leases = []
let quits = {}            // what the site's live-frame reply says: { match_id: [steamid] }
const frames = []         // every live frame the box posted: { at, match_id, state }
const results = []
const site = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
    const u = new URL(req.url, 'http://x')
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { /* ignore */ }
    if (u.pathname === '/api/gs/assignment') {
      const nonce = leases.length ? leases.map((l) => l.nonce).join('+') : 'idle'
      return send({ v: 2, status: leases.length ? 'leased' : 'idle', nonce, assignments: leases })
    }
    if (u.pathname === '/api/gs/live') {
      for (const it of j.instances || []) frames.push({ at: Date.now(), match_id: it.match_id, state: it.state })
      const q = {}
      for (const it of j.instances || []) if (quits[it.match_id]) q[it.match_id] = quits[it.match_id]
      return send({ ok: true, taken: (j.instances || []).length, of: (j.instances || []).length, ...(Object.keys(q).length ? { quit: q } : {}) })
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
  '--site', `http://127.0.0.1:${PORTS.site}`, '--secret', 'x', '--box', 'reconnect-test',
  '--link-port', String(PORTS.link), '--base-port', String(PORTS.base), '--dash', 'off',
  '--max-instances', '3', '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'),
  '--key-dir', path.join(RUN, 'keys'), '--spool-dir', path.join(RUN, 'spool'),
  '--idle-ready-ms', '60000', '--idle-gone-ms', String(GONE_MS), '--drop-hold-ms', String(GONE_MS), '--restart-grace-ms', '0',
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
const framesOf = (mid) => frames.filter((f) => f.match_id === mid)
// What the players saw: the sims print every say/tell into their instance logs.
const gameLogs = () => {
  try { return fs.readdirSync(path.join(RUN, 'logs')).filter((f) => /^inst-\d+\.log$/.test(f)).map((f) => fs.readFileSync(path.join(RUN, 'logs', f), 'utf8')).join('\n') } catch { return '' }
}

try {
  await until('the host agent to come up', () => /host agent up/.test(out))

  step('A. P2 crashes and relaunches: the game holds, P2 comes back, the game goes on')
  const idA = 'm_rcA'
  leases = [lease(idA, { drop_ms: 4000, rejoin_after: 3000, rejoin_token: tok(P2, idA), timescale: 4, max_round: 3 })]
  await until('P2 lost', () => /slot 1 P2 LOST/.test(out))
  await until('the game frozen for P2', () => /paused: P2 lost connection/.test(out))
  const held = await until('a live frame that says paused, waiting for P2', () => framesOf(idA).find((f) => f.state.paused && (f.state.away || []).some((x) => x.name === 'P2')))
  if (held) {
    const w = held.state.away.find((x) => x.name === 'P2')
    check(w.left_ms > 0 && w.left_ms <= GONE_MS, `the site is told how long is left (${w.left_ms} ms of ${GONE_MS})`)
  }
  await until('P2 back in a new slot', () => /slot 2 P2 reconnected/.test(out), 20_000)
  check(/restoring 76561198000000002 into slot 2/.test(out), 'their state is sent back to the game (`restore`)')
  await until('the countdown after player_ready', () => /Everyone is back\. Resuming in 10 seconds/.test(gameLogs()), 20_000)
  await until('resumed', () => /resumed: everyone is back/.test(out), 20_000)
  const resA = await until('m_rcA result', () => results.find((r) => r.match_id === idA), 120_000)
  if (resA) {
    check(resA.flags.includes('rejoined') && resA.flags.includes('resumed') && resA.flags.includes('crash_pause'),
      `result flags [${resA.flags.join(',')}] carry crash_pause, rejoined, resumed`)
  }

  step('B. P2 quits on purpose: nothing freezes')
  const idB = 'm_rcB'
  quits = { [idB]: [P2] }   // the Esc menu's Exit reached the site before the disconnect
  leases = [lease(idB, { quit_ms: 3000 })]
  const fromB = out.length
  await until('P2 disconnected', () => /slot 1 P2 disconnected/.test(out.slice(fromB)), 30_000)
  await delay(2000)
  check(!framesOf(idB).some((f) => f.state.paused), 'no live frame of m_rcB was ever paused')
  check(/P2 quit on purpose: no hold/.test(out.slice(out.indexOf(idB))), 'the host says why it did not hold')
  leases = []
  quits = {}
  await delay(3000)

  step('C. P2 crashes and never comes back: kicked after the grace, P1 plays on')
  const idC = 'm_rcC'
  leases = [lease(idC, { drop_ms: 3000 })]
  await until('P2 lost', () => framesOf(idC).some((f) => f.state.paused), 30_000)
  await until('P2 given up on', () => /P2 did not come back within the grace window/.test(out), GONE_MS + 15_000)
  await until('the game resumes for P1', () => /resumed: P2 did not come back/.test(out) && framesOf(idC).some((f, i, all) => i > 0 && all[i - 1].state.paused && !f.state.paused), 30_000)
  const lastC = framesOf(idC).at(-1)
  check(lastC && !lastC.state.paused && lastC.state.phase === 'live', `the game is live again (phase ${lastC?.state.phase})`)
  check(!results.some((r) => r.match_id === idC), 'and it did not end')
  check(/P2: the lost connection's slot is free \(did not reconnect\)/.test(out), 'P2\'s seated body was kicked (the host sent `kick`)')
} catch (e) {
  bad(`threw: ${e.stack || e.message}`)
} finally {
  host.kill('SIGTERM')
  await delay(500)
  site.close()
}
console.log(failures ? `\n\x1b[31mFAIL\x1b[0m reconnect: ${failures} failure(s) (${RUN})` : `\n\x1b[32mPASS\x1b[0m reconnect (${RUN})`)
process.exit(failures ? 1 : 0)
