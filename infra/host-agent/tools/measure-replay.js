#!/usr/bin/env node
// Measure what a replay actually costs.
//
// The vault estimates ~4–5 MB per 4-player game-hour and ~1.5 MB solo, and the whole
// "every game is recorded, so every record is verifiable without a video" decision rests
// on those numbers. This runs a full simulated hour at the specified rates (players 20 Hz,
// zombies 10 Hz, up to 24 alive), writes REAL signed replay files, and reports the bytes.
//
//   node tools/measure-replay.js                 # 1p and 4p, one hour each
//   node tools/measure-replay.js --hours 1 --levels 3,10,19 --out ./measure.json
//
// Tiers measured, because retention differs per tier (vault 10):
//   full          every event + player tracks + zombie tracks   (90 days, VIP forever)
//   no-zombies    B's "reconstruct the zombies" idea            (how much it would save)
//   events-only   the signed event log + summary                (kept forever, everyone)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZombiesSim, TICK_MS } from '../sim/engine.js'
import { ReplayWriter, verifyFile } from '../lib/replay.js'
import * as keys from '../lib/keys.js'
import { parseArgs, fmtBytes, mkdirp } from '../lib/util.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const a = parseArgs(process.argv.slice(2))
const HOURS = Number(a.hours ?? 1)
const LEVELS = String(a.levels ?? '10').split(',').map(Number)
const PLAYER_COUNTS = String(a.players ?? '1,2,4').split(',').map(Number)
const OUTDIR = a.dir || path.join(os.tmpdir(), 'enw-replay-measure')
const R2_PER_GB_MONTH = 0.015

mkdirp(OUTDIR)
const key = keys.loadOrCreate(path.join(OUTDIR, 'measure-key.json'))

const TIERS = {
  full: () => (ev) => ev,
  'no-zombies': () => (ev) => (ev.t === 'snap' && ev.zombies ? (ev.players ? { ...ev, zombies: undefined } : null) : ev),
  'events-only': () => (ev) => (ev.t === 'snap' || ev.t === 'input' ? null : ev),
}

function runOne({ players, hours, level, tier }) {
  const sim = new ZombiesSim({ seed: 20260920, maxRound: 9999, map: 'nazi_zombie_factory', eeRound: null })
  const file = path.join(OUTDIR, `p${players}-${tier}-l${level}.enwr`)
  const w = new ReplayWriter({
    file,
    header: { match_id: `measure_p${players}`, map: 'nazi_zombie_factory', map_name: 'Der Riese', mode: 'verified', players, tier, zstd_level: level, box: 'measure' },
    privateKey: key.privateKey, pub: key.pub, keyId: key.keyId, level,
  })
  const filter = TIERS[tier]()
  const byType = Object.create(null)
  let rawTotal = 0
  let zombieSamples = 0, zombieSum = 0, zombieMax = 0

  sim.on('event', (ev) => {
    const bytes = JSON.stringify(ev).length + 1
    byType[ev.t] = (byType[ev.t] || 0) + bytes
    rawTotal += bytes
    if (ev.t === 'snap' && ev.zombies) { zombieSamples++; zombieSum += ev.zombies.length; zombieMax = Math.max(zombieMax, ev.zombies.length) }
    const keep = filter(ev)
    if (keep) w.append(keep)
  })

  for (let i = 0; i < players; i++) sim.connectPlayer({ slot: i, name: `P${i + 1}` })
  const targetMs = hours * 3600_000
  const ticks = Math.ceil(targetMs / TICK_MS)
  for (let t = 0; t < ticks; t++) if (!sim.step()) break

  const stats = w.close({ measure: { players, tier, level, hours } })
  const v = verifyFile(file)
  // Rate off the ACTUAL sim time, not the requested hours: a team wipe ends the game
  // early (as it does in WaW), and dividing by the hour we asked for would under-report
  // every run that did not survive it.
  const actualHours = Math.max(1 / 3600, (sim.ms || 1) / 3_600_000)
  return {
    players, tier, level, hours, actual_hours: Number(actualHours.toFixed(3)), wiped: sim.over,
    round_reached: sim.round,
    size: stats.size,
    raw: stats.rawBytes,
    all_events_raw: rawTotal,
    events: stats.events,
    chunks: stats.chunks,
    ratio: stats.rawBytes / stats.size,
    mb_per_hour: stats.size / 1048576 / actualHours,
    verified: v.ok,
    zombies_avg: zombieSamples ? zombieSum / zombieSamples : 0,
    zombies_max: zombieMax,
    raw_by_type: byType,
    file,
  }
}

const results = []
console.log(`Measuring ${HOURS} simulated game-hour(s) at 20 Hz players / 10 Hz zombies, zstd level(s) ${LEVELS.join(',')}`)
console.log(`Output: ${OUTDIR}\n`)

for (const players of PLAYER_COUNTS) {
  for (const level of LEVELS) {
    for (const tier of Object.keys(TIERS)) {
      const t0 = Date.now()
      const r = runOne({ players, hours: HOURS, level, tier })
      r.wall_ms = Date.now() - t0
      results.push(r)
      console.log(`  ${String(players) + 'p'} ${tier.padEnd(12)} zstd-${String(level).padEnd(2)}  ${fmtBytes(r.size).padStart(10)}  ${r.mb_per_hour.toFixed(2).padStart(6)} MB/h  ${r.ratio.toFixed(1).padStart(5)}x  round ${String(r.round_reached).padStart(2)}  ${r.actual_hours.toFixed(2)}h${r.wiped ? ' (wiped)' : ''}  ${r.verified ? 'verified' : 'VERIFY FAILED'}  (${(r.wall_ms / 1000).toFixed(1)}s)`)
    }
  }
}

// ---- the report ------------------------------------------------------------------
const pick = (players, tier, level = LEVELS[0]) => results.find((r) => r.players === players && r.tier === tier && r.level === level)

console.log('\n' + '='.repeat(92))
console.log('REPLAY SIZE AND COST  (zstd level ' + LEVELS[0] + ', one simulated game-hour)')
console.log('='.repeat(92))
console.log('players  tier          MB/game-hour   20h game    R2 $/mo per 1000 game-hours   vs vault estimate')
for (const players of PLAYER_COUNTS) {
  for (const tier of Object.keys(TIERS)) {
    const r = pick(players, tier)
    if (!r) continue
    const gbPer1000h = (r.mb_per_hour * 1000) / 1024
    const vault = tier === 'full' ? (players === 1 ? 1.5 : players === 4 ? 4.5 : null) : null
    const cmp = vault ? `${(r.mb_per_hour / vault).toFixed(2)}x the ~${vault} MB/h estimate` : ''
    console.log(
      `${String(players).padStart(4)}p    ${tier.padEnd(13)} ${r.mb_per_hour.toFixed(2).padStart(9)}    ${(r.mb_per_hour * 20).toFixed(0).padStart(6)} MB    $${(gbPer1000h * R2_PER_GB_MONTH).toFixed(2).padStart(8)}                  ${cmp}`)
  }
}

const full4 = pick(4, 'full') || pick(PLAYER_COUNTS.at(-1), 'full')
const nz4 = pick(full4.players, 'no-zombies')
const ev4 = pick(full4.players, 'events-only')

console.log('\nWHERE THE BYTES GO (' + full4.players + ' players, uncompressed, one hour)')
const tot = Object.values(full4.raw_by_type).reduce((x, y) => x + y, 0)
for (const [t, b] of Object.entries(full4.raw_by_type).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${t.padEnd(16)} ${fmtBytes(b).padStart(10)}  ${((b / tot) * 100).toFixed(1).padStart(5)}%`)
}
console.log(`  ${'TOTAL'.padEnd(16)} ${fmtBytes(tot).padStart(10)}   -> ${fmtBytes(full4.size)} compressed (${full4.ratio.toFixed(1)}x)`)

console.log('\nB\'S "DON\'T STORE THE ZOMBIES" IDEA (vault 10 §4b)')
console.log(`  full        ${full4.mb_per_hour.toFixed(2)} MB/h`)
console.log(`  no zombies  ${nz4.mb_per_hour.toFixed(2)} MB/h   saves ${(full4.mb_per_hour - nz4.mb_per_hour).toFixed(2)} MB/h (${(100 - (nz4.mb_per_hour / full4.mb_per_hour) * 100).toFixed(0)}%)`)
console.log(`  events only ${ev4.mb_per_hour.toFixed(2)} MB/h   (the keep-forever tier)`)

console.log('\nR2 AT $0.015/GB-MONTH (full tier, 90-day retention, games running 24/7)')
for (const conc of [25, 100, 400]) {
  const gb = (full4.mb_per_hour * 24 * 90 * conc) / 1024
  console.log(`  ${String(conc).padStart(3)} concurrent games -> ${gb.toFixed(0).padStart(6)} GB stored, $${(gb * R2_PER_GB_MONTH).toFixed(2)}/month`)
}
console.log('  (the keep-forever event log adds ' + (ev4.mb_per_hour).toFixed(2) + ' MB per game-hour and never expires)')

console.log(`\nZOMBIE LOAD SEEN (${full4.players} players): ${full4.zombies_avg.toFixed(1)} alive on average, ${full4.zombies_max} peak, round ${full4.round_reached} reached in the hour`)

if (LEVELS.length > 1) {
  console.log('\nZSTD LEVEL (full tier, ' + full4.players + ' players, one hour)')
  const base = pick(full4.players, 'full', LEVELS[0])
  for (const level of LEVELS) {
    const r = pick(full4.players, 'full', level)
    if (!r) continue
    const d = (r.mb_per_hour / base.mb_per_hour - 1) * 100
    const rel = level === LEVELS[0] ? 'baseline' : `${d > 0 ? '+' : ''}${d.toFixed(1)}% vs level ${LEVELS[0]}`
    console.log(`  level ${String(level).padStart(2)}  ${r.mb_per_hour.toFixed(2)} MB/h  ${rel.padEnd(22)} ${(r.wall_ms / 1000).toFixed(1)}s of CPU to write an hour of game`)
  }
}

const out = a.out || path.join(OUTDIR, 'measurement.json')
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), hours: HOURS, r2_per_gb_month: R2_PER_GB_MONTH, results }, null, 2))
console.log(`\nfull numbers -> ${out}`)
if (!a.keep) for (const r of results) { try { fs.unlinkSync(r.file) } catch { /* ignore */ } }
