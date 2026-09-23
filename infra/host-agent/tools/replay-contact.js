#!/usr/bin/env node
// Did the player ever get close to a zombie in this game? One line per replay.
//
//   node tools/replay-contact.js <file.enwr> [more.enwr ...] [--near 150] [--json]
//
// WHY (mod-compat.md §10, the invisible zombies on fear_mc_2, 2026-09-23). "It worked last
// night" is only evidence if last night's player actually met a zombie. The replay knows:
// every zombie snap carries positions, so the closest approach and the first time a zombie
// came within `--near` units of slot 0 say whether a session can count as a known-good
// sighting. A 40-second game that ended with every zombie 1,600 units away proves nothing
// about how zombies render.
//
// Reads the replay through lib/replay.js (no verification: run tools/verify.js for that).
import { readHeader, readEvents } from '../lib/replay.js'

/**
 * Pure: the contact summary of one game's events (snaps as written by
 * server/components/replay/replay.cpp). `near` is in world units.
 */
export function contactSummary(events, { near = 150 } = {}) {
  let first = null, last = null, maxAlive = 0, minDist = Infinity, nearSamples = 0, firstNear = null
  let kills = 0, downs = 0
  for (const ev of events) {
    if (ev.t !== 'snap') continue
    if (first == null) first = ev.ms
    last = ev.ms
    if ((ev.zombies_alive || 0) > maxAlive) maxAlive = ev.zombies_alive
    const p = (ev.players || []).find((x) => x.slot === 0) || (ev.players || [])[0]
    if (!p) continue
    if (p.kills != null) kills = p.kills
    if (p.downs != null) downs = p.downs
    if (!p.pos) continue
    for (const z of ev.zombies || []) {
      if (!z.pos) continue
      const d = Math.hypot(z.pos[0] - p.pos[0], z.pos[1] - p.pos[1], z.pos[2] - p.pos[2])
      if (d < minDist) minDist = d
      if (d < near) {
        nearSamples++
        if (firstNear == null) firstNear = ev.ms
      }
    }
  }
  return {
    seconds: first == null ? 0 : Math.round((last - first) / 1000),
    maxAlive,
    minDist: Number.isFinite(minDist) ? Math.round(minDist) : null,
    nearSamples,
    firstNearS: firstNear == null ? null : Math.round((firstNear - first) / 1000),
    kills,
    downs,
    met: nearSamples > 0,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const ni = args.indexOf('--near')
  const near = ni >= 0 ? Number(args[ni + 1]) : 150
  const files = args.filter((a, i) => !a.startsWith('--') && !(ni >= 0 && i === ni + 1))
  if (!files.length) {
    console.error('usage: replay-contact.js <file.enwr> [...] [--near 150] [--json]')
    process.exit(2)
  }
  for (const f of files) {
    const h = readHeader(f).header
    const s = contactSummary(readEvents(f), { near })
    const row = { file: f.split(/[\\/]/).pop(), map: h.map, dll_build: h.dll_build || null, ...s }
    if (json) { console.log(JSON.stringify(row)); continue }
    console.log(`${row.file}  ${row.map}  dll ${row.dll_build}  ${row.seconds}s  zombies<=${row.maxAlive}  ` +
      `closest ${row.minDist ?? '-'}u  <${near}u: ${row.nearSamples} samples` +
      (row.firstNearS != null ? ` (first at ${row.firstNearS}s)` : '') +
      `  kills ${row.kills} downs ${row.downs}  ${row.met ? 'MET ZOMBIES' : 'never met a zombie'}`)
  }
}
