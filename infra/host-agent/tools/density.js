#!/usr/bin/env node
// How many games can one host agent carry, and what does each one cost?
//
//   node tools/density.js --to 24 --step 4 --players 4 --settle 45
//
// Starts its own host agent, ramps instances up in steps, lets each step settle, and
// records CPU and RSS per game plus the agent's own overhead. It answers the question the
// cost model needs — vault 14's "20–55 games per box" — for the part we can measure
// tonight: the HOST AGENT and the game-link, with simulated games on the other end.
//
// IT DOES NOT MEASURE WAW. A simulated instance is a Node process doing arithmetic; a real
// CoDWaW.exe is the thing that costs 0.3–0.8 of a core. What this bounds is the overhead
// the host agent ADDS per game — the part that would otherwise be invisible until the
// fleet is full — and whether the game-link, the referee timers and the replay writers
// degrade as games are piled on.
//
// An earlier note here said `dedi` had found the engine binds a hardcoded UDP 3074 party
// socket with no dvar to move it, which "may cap real instances per machine at ONE". That
// ceiling turned out not to exist: measured on 2026-09-22, two headless servers ran at the
// same time, A on udp 3074 and B on udp 3075 -- the engine falls back. See
// docs/kickstart/host.md 10.5. The one-game-per-box limit in this codebase is ours (a shared
// game copy, homepath and game.lock), not the engine's.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs, mkdirp, fmtBytes } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const TO = Number(a.to || 16)
const STEP = Number(a.step || 4)
const PLAYERS = Number(a.players || 4)
const SETTLE = Number(a.settle || 45) * 1000
const DASH = Number(a['dash-port'] || 8891)
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-density'))

const rows = []
let host = null

function startHost() {
  host = spawn(process.execPath, [path.join(ROOT, 'host.js'),
    '--box', 'density', '--link-port', String(Number(a['link-port'] || 38891)),
    '--dash-port', String(DASH), '--base-port', String(Number(a['base-port'] || 29900)),
    '--max-instances', String(TO + 4),
    '--replay-dir', path.join(RUN, 'replays'), '--log-dir', path.join(RUN, 'logs'), '--key-dir', path.join(RUN, 'keys'),
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  host.out = ''
  const tee = (d) => { host.out += d; if (a.verbose) process.stdout.write(`\x1b[90m[host]\x1b[0m ${d}`) }
  host.stdout.on('data', tee); host.stderr.on('data', tee)
}

const get = (p) => fetch(`http://127.0.0.1:${DASH}${p}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json())
const post = (p, body) => fetch(`http://127.0.0.1:${DASH}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000),
}).then((r) => r.json())

async function waitUp() {
  for (let i = 0; i < 60; i++) { try { await get('/api/state'); return true } catch { await delay(500) } }
  return false
}

/** Average several samples: one reading of a 5-second CPU window is noise. */
async function measure(n) {
  const took = []
  for (let i = 0; i < 6; i++) {
    await delay(5000)
    const s = await get('/api/state')
    const live = s.instances.filter((x) => x.game && !x.finished)
    const cores = s.instances.map((x) => x.usage.cores_now).filter((x) => x != null)
    took.push({
      live: live.length,
      coresTotal: cores.reduce((x, y) => x + y, 0),
      rssTotal: s.instances.reduce((t, x) => t + (x.usage.rss_bytes || 0), 0),
      agentRss: s.agent_rss_bytes || 0,
      dropped: (s.link.conns || []).reduce((t, c) => t + (c.dropped || 0), 0),
      rx: (s.link.conns || []).reduce((t, c) => t + (c.rx || 0), 0),
      p99: Math.max(0, ...live.map((x) => x.game?.perf?.p99 || 0)),
      rounds: live.reduce((t, x) => t + (x.game?.round || 0), 0),
    })
  }
  const avg = (k) => took.reduce((t, x) => t + x[k], 0) / took.length
  const rxRate = (took.at(-1).rx - took[0].rx) / ((took.length - 1) * 5)
  return {
    asked: n,
    live: Math.round(avg('live')),
    cores_total: Number(avg('coresTotal').toFixed(3)),
    cores_per_game: Number((avg('coresTotal') / Math.max(1, avg('live'))).toFixed(4)),
    rss_total_mib: Number((avg('rssTotal') / 1048576).toFixed(1)),
    rss_per_game_mib: Number((avg('rssTotal') / Math.max(1, avg('live')) / 1048576).toFixed(1)),
    agent_rss_mib: Number((avg('agentRss') / 1048576).toFixed(1)),
    events_per_s: Math.round(rxRate),
    events_per_s_per_game: Math.round(rxRate / Math.max(1, avg('live'))),
    dropped: took.at(-1).dropped,
    sim_p99_ms: Number(avg('p99').toFixed(1)),
    rounds_total: Math.round(avg('rounds')),
  }
}

try {
  console.log(`Ramping to ${TO} simulated instances (${PLAYERS} players each), +${STEP} per step, ${SETTLE / 1000}s to settle.`)
  console.log(`Host: ${os.cpus()[0].model.trim()}, ${os.cpus().length} cores\n`)
  startHost()
  if (!await waitUp()) throw new Error('the host agent did not come up')

  let running = 0
  while (running < TO) {
    const add = Math.min(STEP, TO - running)
    for (let i = 0; i < add; i++) {
      await post('/api/boot', { players: PLAYERS, timescale: 1, max_round: 9999, map: 'nazi_zombie_factory', seed: 1000 + running + i })
      await delay(300)   // stagger: booting ten Node processes at once measures the boot, not the load
    }
    running += add
    process.stdout.write(`  ${String(running).padStart(3)} instances … settling`)
    await delay(SETTLE)
    const r = await measure(running)
    rows.push(r)
    process.stdout.write(`\r  ${String(r.live).padStart(3)} live · ${r.cores_total.toFixed(2)} cores (${r.cores_per_game.toFixed(4)}/game) · ${r.rss_total_mib} MiB games + ${r.agent_rss_mib} MiB agent · ${r.events_per_s}/s events (${r.events_per_s_per_game}/game) · ${r.dropped} dropped\n`)
    if (r.live < running) console.log(`       NOTE: only ${r.live} of ${running} are live — the box did not keep up`)
  }

  console.log('\n' + '='.repeat(100))
  console.log('SIMULATED-INSTANCE DENSITY ON ONE HOST AGENT')
  console.log('='.repeat(100))
  console.log('live  cores  core/game  games MiB  MiB/game  agent MiB  events/s  ev/s/game  drops  rounds')
  for (const r of rows) {
    console.log(`${String(r.live).padStart(4)}  ${r.cores_total.toFixed(2).padStart(5)}  ${r.cores_per_game.toFixed(4).padStart(9)}  ${String(r.rss_total_mib).padStart(9)}  ${String(r.rss_per_game_mib).padStart(8)}  ${String(r.agent_rss_mib).padStart(9)}  ${String(r.events_per_s).padStart(8)}  ${String(r.events_per_s_per_game).padStart(9)}  ${String(r.dropped).padStart(5)}  ${String(r.rounds_total).padStart(6)}`)
  }
  const first = rows[0]; const last = rows.at(-1)
  if (first && last && last.live > first.live) {
    const agentSlope = (last.agent_rss_mib - first.agent_rss_mib) / (last.live - first.live)
    console.log(`\nThe agent itself costs ~${agentSlope.toFixed(2)} MiB per extra game (${first.agent_rss_mib} MiB at ${first.live} games -> ${last.agent_rss_mib} MiB at ${last.live}).`)
    console.log(`Per-game CPU went ${first.cores_per_game.toFixed(4)} -> ${last.cores_per_game.toFixed(4)} cores; ${last.dropped ? `${last.dropped} link messages were dropped` : 'nothing was dropped on the game link'}.`)
  }
  fs.writeFileSync(path.join(RUN, 'density.json'), JSON.stringify({ at: new Date().toISOString(), host: { cpu: os.cpus()[0].model.trim(), cores: os.cpus().length }, players: PLAYERS, rows }, null, 2))
  console.log(`\nfull numbers -> ${path.join(RUN, 'density.json')}`)
} catch (e) {
  console.error(`density run failed: ${e.message}`)
} finally {
  if (host) { try { host.kill('SIGTERM') } catch { /* gone */ } await delay(2000); if (host.exitCode == null) { try { host.kill('SIGKILL') } catch { /* gone */ } } }
  // Belt and braces: the sims are the host's children and die with it, but on Windows a
  // TerminateProcess'd parent can leave them, and they are OUR pids.
  await delay(1000)
}
