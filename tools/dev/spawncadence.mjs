#!/usr/bin/env node
// Zombie spawn cadence out of a replay (.enwr) or a raw referee capture (.ndjson).
//
//   node tools/dev/spawncadence.mjs <file> [--max 40]
//
// A spawn is the first `snap` a zombie entity id appears in, or its reappearance after more
// than 1 s absent (the engine reuses entity numbers). Prints each spawn with its gap to the
// previous one, and the mean gap per round. docs/kickstart/verified-rules.md §5 is what the
// numbers are compared against: stock round 1 is 3.00 s apart, round 2 2.85 s (3 * 0.95), and
// on Shi No Numa / Der Riese each gap also includes one `wait_network_frame()`, which on a
// server is a client's snapshot acknowledgement and so grows with that client's ping.
import fs from 'node:fs'
import { readEvents } from '../../infra/host-agent/lib/replay.js'

const file = process.argv[2]
if (!file) { console.error('usage: spawncadence.mjs <replay.enwr|capture.ndjson> [--max N]'); process.exit(2) }
const maxI = process.argv.indexOf('--max')
const MAX = maxI > 0 ? Number(process.argv[maxI + 1]) || 40 : 40

const events = file.endsWith('.ndjson')
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
  : readEvents(file)

const seen = new Map()
const spawns = []
const rounds = []
let hello = null
let round = 0
for (const ev of events) {
  if (ev.t === 'hello' && !hello) hello = ev
  if (ev.t === 'round') { round = Number(ev.n ?? ev.round) || round; rounds.push({ n: round, ms: ev.ms }) }
  if (ev.t !== 'snap' || !Array.isArray(ev.zombies)) continue
  const r = Number(ev.round) || round
  for (const z of ev.zombies) {
    const last = seen.get(z.id)
    if (last == null || ev.ms - last > 1000) spawns.push({ id: z.id, ms: ev.ms, hp: z.health, round: r })
    seen.set(z.id, ev.ms)
  }
}

console.log(`${file}\nrole=${hello?.role ?? '?'} instance=${hello?.instance ?? '?'} rounds=${rounds.map((x) => `${x.n}@${(x.ms / 1000).toFixed(2)}s`).join(' ') || 'none reported'}`)
let prev = null
for (const s of spawns.slice(0, MAX)) {
  console.log(`  ${(s.ms / 1000).toFixed(2).padStart(9)} s  r${s.round}  id ${String(s.id).padStart(4)}  hp ${String(s.hp).padStart(4)}${prev != null ? `  +${((s.ms - prev) / 1000).toFixed(2)}` : ''}`)
  prev = s.ms
}
const byRound = new Map()
for (const s of spawns) { const a = byRound.get(s.round) || []; a.push(s.ms); byRound.set(s.round, a) }
for (const [r, ms] of byRound) {
  if (ms.length < 2) { console.log(`round ${r}: ${ms.length} spawn`); continue }
  const gaps = ms.slice(1).map((m, i) => m - ms[i]).filter((g) => g < 10_000)
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)
  console.log(`round ${r}: ${ms.length} spawns, mean gap ${(mean / 1000).toFixed(3)} s over ${gaps.length}`)
}
