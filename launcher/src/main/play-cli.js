#!/usr/bin/env node
// Drive the whole play path from a terminal, with no Electron and no UI.
// This is how the launch path is tested on the dev box, and it honours the game lock.
//
//   node src/main/play-cli.js --dry-run
//   node src/main/play-cli.js --map nazi_zombie_prototype --local --seconds 40 --stealth
//   node src/main/play-cli.js --map nazi_zombie_prototype --host 127.0.0.1:28960 --seconds 40
//
// --dry-run prints the exact command line and environment and starts nothing.
import { BootFlow } from './bootflow.js'
import { buildArgs } from './launch.js'
import { P } from './paths.js'
import * as lock from './gamelock.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const map = val('--map', 'nazi_zombie_prototype')
const seconds = Number(val('--seconds', '45'))
const stealth = has('--stealth') || !has('--visible')
const host = val('--host', null)
const siteUrl = val('--site', 'http://127.0.0.1:8099')

if (has('--dry-run')) {
  const args = buildArgs({
    host: host || '127.0.0.1:28960',
    map: has('--local') ? map : null,
    stealth,
    settings: { fov: 80, maxFps: 125 },
  })
  console.log(`exe : ${P.game}\\CoDWaW.exe`)
  console.log(`cwd : ${P.game}`)
  console.log('')
  console.log(`"${P.game}\\CoDWaW.exe" ${args.join(' ')}`)
  console.log('')
  console.log('env : SteamAppId=10090 SteamGameId=10090 ENW_HOST=... ENW_INSTANCE=... ENW_ROLE=client')
  console.log('      ENW_TOKEN_PIPE=\\\\.\\pipe\\enw-launch-<random>   <- the invite token goes here')
  console.log('')
  console.log('note: the token is NOT in the command line above, and will not be.')
  console.log(`lock: ${lock.enabled() ? `dev box detected; would take ${lock.lockFile}` : 'no dev box; no lock needed'}`)
  const cur = lock.read()
  if (cur.held) console.log(`      currently held by ${cur.name} pid ${cur.pid} (${Math.round(cur.ageMs / 1000)}s ago)${cur.stale ? ' [STALE]' : ''}: ${cur.why}`)
  process.exit(0)
}

const flow = new BootFlow({
  map,
  siteUrl,
  host,
  localMap: has('--local') ? map : null,
  stealth,
  useGameLock: !has('--no-lock'),
  lockName: 'launcher',
  serverTimeoutMs: Number(val('--server-timeout', '8000')),
  connectTimeoutMs: seconds * 1000,
  nannySeconds: seconds + 30,
  settings: { fov: 80, maxFps: 125 },
})

flow.on('step', (s) => {
  const icon = s.state === 'done' ? 'done' : s.state === 'failed' ? 'FAIL' : ' .. '
  console.log(`[${icon}] ${s.label.padEnd(24)} ${s.detail}${s.simulated ? '   (SIMULATED)' : ''}`)
})
flow.on('note', () => {})
if (has('--console')) flow.on('console', (l) => console.log(`    | ${l}`))

let stopping = false
const stop = (why) => {
  if (stopping) return
  stopping = true
  console.log(`\nstopping: ${why}`)
  flow.cancel(why)
  setTimeout(() => {
    const notes = flow.launch?.notes || []
    if (notes.length) { console.log('\nWhat the launcher did:'); for (const n of notes) console.log(`  - ${n}`) }
    const d = flow.launch?.dialogs || []
    if (d.length) { console.log('\nWindows dialogs answered:'); for (const x of d) console.log(`  - "${x.title}" -> ${x.answered}  [${x.buttons}]`) }
    console.log(`\nsimulated steps: ${flow.simulated.length ? flow.simulated.join(', ') : 'none'}`)
    console.log(`game lock now: ${JSON.stringify(lock.read())}`)
    process.exit(0)
  }, 1200)
}

process.on('SIGINT', () => stop('interrupted'))
const timer = setTimeout(() => stop(`test window of ${seconds}s elapsed`), seconds * 1000)

flow.run().then((snap) => {
  clearTimeout(timer)
  if (snap.failed) { stop('a step failed'); return }
  stop('boot flow finished')
})
