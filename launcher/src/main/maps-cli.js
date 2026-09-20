#!/usr/bin/env node
// The map library from a terminal.
//
//   node src/main/maps-cli.js list
//   node src/main/maps-cli.js install nazi_zombie_leviathan
//   node src/main/maps-cli.js installed
//   node src/main/maps-cli.js remove nazi_zombie_leviathan
import { catalogue, install, uninstall, installedMaps, verify } from './library.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const arg = argv[1]
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`)

if (cmd === 'list') {
  const c = catalogue()
  console.log(`archive: ${c.archive}`)
  console.log(`${c.maps.length} maps\n`)
  console.log('  ' + 'TITLE'.padEnd(32) + 'BSP (what the engine calls it)'.padEnd(30) + 'SIZE'.padEnd(10) + 'STATE')
  for (const m of c.maps) {
    console.log('  ' + m.title.padEnd(32) + m.bsp.padEnd(30) + mb(m.bytes).padEnd(10) +
      (m.installed ? 'installed' : m.available ? 'available' : 'not on this machine') +
      (m.author ? `   by ${m.author}` : ''))
  }
  process.exit(0)
}

if (cmd === 'installed') {
  const rows = installedMaps()
  if (!rows.length) { console.log('No maps installed.'); process.exit(0) }
  for (const r of rows) {
    console.log(`${r.title}  (${r.bsp})  ${mb(r.bytes)}  ${r.files.length} files  verified=${r.verified}`)
    console.log(`   library: ${r.dir}`)
    console.log(`   engine sees: fs_game ${r.fsGame}`)
    for (const p of r.problems || []) console.log(`   note: ${p}`)
  }
  process.exit(0)
}

if (cmd === 'verify') {
  const rows = verify()
  if (!rows.length) { console.log('No maps installed.'); process.exit(0) }
  for (const r of rows) console.log(`  ${r.ok ? ' ok ' : 'FAIL'}  ${r.title} (${r.bsp})  ${r.files}/${r.expected} files`)
  process.exit(rows.every((r) => r.ok) ? 0 : 1)
}

if (cmd === 'remove') {
  if (!arg) { console.error('which map?'); process.exit(1) }
  for (const line of uninstall(arg)) console.log(`  ${line}`)
  process.exit(0)
}

if (cmd === 'install') {
  if (!arg) { console.error('which map? (use the bsp name from `list`)'); process.exit(1) }
  const t0 = Date.now()
  let last = 0
  const rec = install(arg, {
    onProgress: (p) => {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
      if (pct >= last + 10 || p.done === 0) { last = pct; console.log(`  ${String(pct).padStart(3)}%  ${p.file}`) }
    },
  })
  const secs = (Date.now() - t0) / 1000
  console.log('')
  console.log(`Installed ${rec.title} (${rec.bsp})`)
  console.log(`  ${rec.files.length} files, ${mb(rec.bytes)} in ${secs.toFixed(1)}s (${mb(rec.bytes / secs)}/s)`)
  console.log(`  every file checked against the archive's SHA-256: ${rec.verified}`)
  console.log(`  library     : ${rec.dir}`)
  console.log(`  engine sees : ${rec.dir}  (fs_game ${rec.fsGame})`)
  console.log(`  play it     : node src/main/play-cli.js --map ${rec.bsp} --local --fs-game ${rec.fsGame}`)
  for (const p of rec.problems || []) console.log(`  note: ${p}`)
  process.exit(0)
}

console.error(`unknown command: ${cmd}`)
process.exit(1)
