#!/usr/bin/env node
'use strict'
// Build web/server/data/chronic-assets.json: per map, the asset errors ("Could not load
// xanim …", "unable to find secondary alias …") that the map's OWN boot logs already show,
// so the `asset_missing` flag only fires for errors that are new (docs/kickstart/telemetry.md §5).
//
// Sources (read-only):
//   <ZombiesDev>\archive\mods\<map>\console.log                         the archive's boot runs
//   <ZombiesDev>\archive\logs\box-console\**\<bsp>.<match>.<inst>.console.log   the box's boots
// A key seen in at least half of all the maps' logs (and at least 3) also goes under "*":
// that is engine noise, not a map's problem.
//
//   node tools/telemetry/build-chronic.js [--root C:\Users\b\ZombiesDev\archive] [--out file]
const fs = require('node:fs')
const path = require('node:path')
const { assetKey } = require('../../web/server/lib/telemetry/rules')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const ROOT = arg('--root', path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'archive'))
const OUT = arg('--out', path.join(__dirname, '..', '..', 'web', 'server', 'data', 'chronic-assets.json'))

const maps = new Map() // map -> Set(keys)
const sources = []
function scan (map, file) {
  let text
  try { text = fs.readFileSync(file, 'latin1') } catch { return }
  const set = maps.get(map) || new Set()
  for (const line of text.split(/\r?\n/)) { const k = assetKey(line); if (k) set.add(k) }
  maps.set(map, set)
  sources.push(path.relative(ROOT, file))
}

const modsDir = path.join(ROOT, 'mods')
if (fs.existsSync(modsDir)) {
  for (const d of fs.readdirSync(modsDir)) {
    const f = path.join(modsDir, d, 'console.log')
    if (fs.existsSync(f)) scan(d.toLowerCase(), f)
  }
}
function walk (dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.console\.log$/i.test(e.name)) scan(e.name.split('.')[0].toLowerCase(), p)
  }
}
walk(path.join(ROOT, 'logs', 'box-console'))

const counts = new Map()
for (const set of maps.values()) for (const k of set) counts.set(k, (counts.get(k) || 0) + 1)
const everywhere = [...counts.entries()].filter(([, c]) => c >= 3 && c >= maps.size / 2).map(([k]) => k).sort()
const out = { generated_at: new Date().toISOString(), generator: 'tools/telemetry/build-chronic.js', sources: sources.length, maps: { '*': everywhere } }
for (const [m, set] of [...maps.entries()].sort()) out.maps[m] = [...set].filter((k) => !everywhere.includes(k)).sort()
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
console.log(`chronic assets: ${maps.size} map(s) from ${sources.length} log(s); ${everywhere.length} engine-wide; ${[...maps.values()].reduce((a, s) => a + s.size, 0)} map keys -> ${path.relative(process.cwd(), OUT)}`)
