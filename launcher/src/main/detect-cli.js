#!/usr/bin/env node
// Run the detector from a terminal, with no Electron. This is how detection gets
// tested and how a support conversation gets a straight answer out of a player.
//
//   node src/main/detect-cli.js
//   node src/main/detect-cli.js --browse "C:\Program Files (x86)\Steam"
//   node src/main/detect-cli.js --json
//   node src/main/detect-cli.js --validate "<folder>"
import { detect, fromBrowse, validate } from './detect.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const json = has('--json')
const noHash = has('--no-hash')

function mark(ok) { return ok ? '  ok ' : ' FAIL' }

function printChecks(checks) {
  for (const c of checks || []) console.log(`      [${mark(c.ok)}] ${c.id.padEnd(14)} ${c.detail}`)
}

const browse = val('--browse')
const only = val('--validate')

if (only) {
  const r = validate(only, { hash: !noHash })
  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1) }
  console.log(`\n${r.ok ? 'ACCEPTED' : 'REJECTED'} (${r.grade})  ${r.dir}`)
  console.log(`  ${r.reason}`)
  printChecks(r.checks)
  process.exit(r.ok ? 0 : 1)
}

const r = browse ? await fromBrowse(browse, { hash: !noHash }) : await detect({ hash: !noHash })

if (json) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}

console.log('')
if (browse) {
  console.log(`You picked: ${r.picked}`)
  if (r.corrected) console.log(`Corrected to: ${r.game.dir}   (${r.how})`)
  console.log(`Folders looked at: ${r.tried.length} (${r.scanned} scanned)`)
} else {
  console.log('Routes tried')
  for (const rt of r.routes) {
    if (rt.route === 'steam_libraries') {
      for (const lib of JSON.parse(rt.detail)) {
        console.log(`  steam_libraries  ${lib.steam}`)
        console.log(`                   libraryfolders.vdf: ${lib.vdfFound ? lib.vdfPath : 'not found'}${lib.vdfError ? ' ERROR ' + lib.vdfError : ''}`)
        for (const l of lib.libraries) console.log(`                   library: ${l}`)
      }
      continue
    }
    console.log(`  ${rt.route.padEnd(16)} ${rt.found ? `${rt.found} hit(s)` : 'nothing'}`)
    console.log(`                   ${rt.detail}`)
  }
  console.log('')
  console.log(`Steam account: ${r.steamAccount ? `${r.steamAccount.persona || r.steamAccount.account} (${r.steamAccount.steamid})` : 'none found'}`)
  console.log(`Owns 10090 (as far as this PC knows): ${r.owned ? 'yes' : 'no evidence'}`)
}

console.log('')
console.log(`Candidates (${r.candidates.length})`)
for (const c of r.candidates) {
  console.log(`  ${c.ok ? 'ACCEPT' : 'REJECT'}  [${c.grade}]  ${c.dir}`)
  if (c.via) console.log(`          via: ${c.via}`)
  if (c.how) console.log(`          how: ${c.how}`)
  console.log(`          ${c.reason}`)
  printChecks(c.checks)
}

console.log('')
if (r.ok) {
  console.log(`RESULT: ${r.game.dir}`)
  console.log(`        ${r.game.exe}`)
  console.log(`        grade=${r.game.grade} version=${r.game.version} knownBuild=${r.game.knownBuild}`)
  if (r.game.sha256) console.log(`        sha256=${r.game.sha256}`)
} else {
  console.log(`RESULT: not found. state=${r.state ?? 'n/a'}`)
  if (r.reason) console.log(`        ${r.reason}`)
}
if (r.tookMs != null) console.log(`        (${r.tookMs} ms)`)
process.exit(r.ok ? 0 : 1)
