#!/usr/bin/env node
// Install / inspect / remove the ENW client, without Electron.
//
//   node src/main/setup-cli.js install [--force] [--dll <path>] [--game <waw folder>]
//   node src/main/setup-cli.js status
//   node src/main/setup-cli.js uninstall [--delete-maps]
import { detect } from './detect.js'
import { install, uninstall, status, findClientDll } from './setup.js'
import { P } from './paths.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

if (cmd === 'status') {
  const s = status()
  console.log(`ENW folder     : ${P.root}`)
  console.log(`Installed      : ${s.installed ? 'yes' : 'no'}`)
  if (s.gameExe) console.log(`Game copy      : ${s.gameExe}`)
  if (s.clientDll) console.log(`ENW client     : ${s.clientDll.path} (${s.clientDll.size.toLocaleString()} B)`)
  if (s.manifest) {
    console.log(`Installed from : ${s.manifest.source.dir}`)
    console.log(`Source intact  : ${s.manifest.sourceUnchanged ? 'yes' : 'NO — check the manifest'}`)
    console.log(`Manifest       : ${P.setupManifest}`)
  }
  const f = findClientDll({})
  console.log(`Client DLL available: ${f.dll ? `${f.dll.path} (${f.dll.via})` : 'none found'}`)
  process.exit(0)
}

if (cmd === 'uninstall') {
  for (const line of uninstall({ keepMaps: !has('--delete-maps') })) console.log(`  ${line}`)
  process.exit(0)
}

if (cmd === 'install') {
  let gameDir = val('--game')
  if (!gameDir) {
    const d = await detect({ hash: false })
    if (!d.ok) { console.error('Could not find World at War. Pass --game <folder>.'); process.exit(1) }
    gameDir = d.game.dir
    console.log(`Found: ${gameDir} (${d.game.grade})`)
  }
  const m = install({
    gameDir,
    dllPath: val('--dll'),
    force: has('--force'),
    onProgress: (s) => console.log(`  [${s.ok ? ' ok ' : 'FAIL'}] ${s.name.padEnd(12)} ${s.detail}`),
  })
  console.log('')
  console.log(`Manifest: ${P.setupManifest}`)
  console.log(`Your install unchanged: ${m.sourceUnchanged ? 'YES' : 'NO'}`)
  process.exit(m.sourceUnchanged ? 0 : 2)
}

console.error(`unknown command: ${cmd}`)
process.exit(1)
