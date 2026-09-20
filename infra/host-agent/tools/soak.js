#!/usr/bin/env node
// Watch a running host agent and record what it costs over time.
//
//   node tools/soak.js --dash http://127.0.0.1:8871 --out soak.csv [--every 30]
//
// The vault's §5.2 targets are per GAME: server frame p99 <= 60 ms, CPU <= 0.5 core
// average, no memory growth over 20 h. We have no evidence for any of them, because until
// the real dedicated server exists there is no real game to measure. What this DOES
// measure, and what nothing else does, is the HOST AGENT: whether the thing that referees,
// records and reports leaks or drifts when it is left running with several games on it.
//
// One row per sample: wall time, per-instance CPU/RSS, the agent's own RSS, rounds, events.
// A leak shows as a line that keeps climbing after the games have settled into a rhythm.
import fs from 'node:fs'
import { parseArgs, mkdirp, fmtDur } from '../lib/util.js'
import path from 'node:path'

const a = parseArgs(process.argv.slice(2))
const DASH = (a.dash || 'http://127.0.0.1:8871').replace(/\/$/, '')
const EVERY = Math.max(5, Number(a.every || 30)) * 1000
const OUT = a.out || path.join(process.cwd(), 'soak.csv')

mkdirp(path.dirname(path.resolve(OUT)))
const started = Date.now()
let first = null
let rows = 0

const HEAD = 'elapsed_s,instances,live,agent_rss_mib,agent_heap_mib,inst_rss_total_mib,inst_rss_max_mib,cores_total,cores_per_game,rounds_total,events_total,replay_bytes_total,frame_p99_max,link_rx_total,link_dropped\n'
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEAD)

async function sample() {
  let s
  try { s = await (await fetch(`${DASH}/api/state`, { signal: AbortSignal.timeout(5000) })).json() }
  catch (e) { console.warn(`[soak] ${e.message}`); return }

  const live = s.instances.filter((i) => i.game && !i.finished)
  const rssEach = s.instances.map((i) => (i.usage.rss_bytes || 0) / 1048576)
  const coresEach = s.instances.map((i) => i.usage.cores_now).filter((x) => x != null)
  const p99 = live.map((i) => i.game?.perf?.p99).filter((x) => x != null)
  const rx = (s.link.conns || []).reduce((t, c) => t + (c.rx || 0), 0)
  const dropped = (s.link.conns || []).reduce((t, c) => t + (c.dropped || 0), 0)
  const row = {
    elapsed_s: Math.round((Date.now() - started) / 1000),
    instances: s.instances.length,
    live: live.length,
    agent_rss_mib: Number(((s.agent_rss_bytes || 0) / 1048576).toFixed(1)),
    // RSS alone cannot tell a leak from a buffer arena. The JS heap can: if heapUsed is
    // flat while RSS climbs, the growth is native (Buffers — and the replay path concats
    // and zstd-compresses ~500 KB per chunk per game), which reuses rather than leaks.
    agent_heap_mib: Number(((s.agent_heap_bytes || 0) / 1048576).toFixed(1)),
    inst_rss_total_mib: Number(rssEach.reduce((x, y) => x + y, 0).toFixed(1)),
    inst_rss_max_mib: Number(Math.max(0, ...rssEach).toFixed(1)),
    cores_total: Number(coresEach.reduce((x, y) => x + y, 0).toFixed(3)),
    cores_per_game: live.length ? Number((coresEach.reduce((x, y) => x + y, 0) / live.length).toFixed(3)) : 0,
    rounds_total: live.reduce((t, i) => t + (i.game?.round || 0), 0),
    events_total: rx,
    replay_bytes_total: 0,
    frame_p99_max: p99.length ? Math.max(...p99) : 0,
    link_rx_total: rx,
    link_dropped: dropped,
  }
  try {
    const dir = a['replay-dir']
    if (dir && fs.existsSync(dir)) row.replay_bytes_total = fs.readdirSync(dir).filter((f) => f.endsWith('.enwr')).reduce((t, f) => t + fs.statSync(path.join(dir, f)).size, 0)
  } catch { /* ignore */ }

  if (!first) first = row
  fs.appendFileSync(OUT, `${row.elapsed_s},${row.instances},${row.live},${row.agent_rss_mib},${row.agent_heap_mib},${row.inst_rss_total_mib},${row.inst_rss_max_mib},${row.cores_total},${row.cores_per_game},${row.rounds_total},${row.events_total},${row.replay_bytes_total},${row.frame_p99_max},${row.link_rx_total},${row.link_dropped}\n`)
  rows++

  const grow = first.inst_rss_total_mib ? ((row.inst_rss_total_mib / first.inst_rss_total_mib - 1) * 100).toFixed(1) : '0.0'
  const agentGrow = first.agent_rss_mib ? ((row.agent_rss_mib / first.agent_rss_mib - 1) * 100).toFixed(1) : '0.0'
  console.log(`[soak ${fmtDur(Date.now() - started).padStart(7)}] ${row.live} live · games ${row.inst_rss_total_mib} MiB (${grow}%) max ${row.inst_rss_max_mib} · agent ${row.agent_rss_mib} MiB rss / ${row.agent_heap_mib} heap (${agentGrow}%) · ${row.cores_total} cores (${row.cores_per_game}/game) · rounds ${row.rounds_total} · p99 ${row.frame_p99_max} ms · ${(row.link_rx_total / 1000).toFixed(0)}k events · ${row.link_dropped} dropped`)
}

console.log(`[soak] watching ${DASH} every ${EVERY / 1000}s -> ${OUT}`)
sample()
setInterval(sample, EVERY)
