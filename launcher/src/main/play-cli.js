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
import { listDisplays, pickDisplay, resolutionOf } from './display.js'
import { resolveMode } from './gamecfg.js'
import * as settings from './settings.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { P } from './paths.js'
import * as lock from './gamelock.js'
import { HostAgent } from './hostagent.js'
import { LocalRun } from './localrun.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const map = val('--map', 'nazi_zombie_prototype')
const seconds = Number(val('--seconds', '45'))
// --window offscreen|small|player. `--visible` is shorthand for `small`: on screen,
// 800x600, muted. Use it for anything longer than a minute — off-screen and unfocused
// the game's tick dies at ~65 s (referee, two identical captures).
const windowMode = val('--window', has('--visible') ? 'small' : has('--stealth') ? 'offscreen' : 'offscreen')
const stealth = windowMode === 'offscreen'
const host = val('--host', null)
const siteUrl = val('--site', 'http://127.0.0.1:8099')
// A custom map IS its own mod, so fs_game is mods/<bsp>, not mods/enw. Our DLL rides
// in on the binkw32 proxy, not on fs_game, so it does not care which mod is loaded.
const fsGame = val('--fs-game', null)

if (has('--dry-run')) {
  // The account's real settings, not a stub: the point of a dry run is to see the
  // line the player would actually get.
  const s = settings.get()
  const displays = listDisplays()
  const display = pickDisplay(displays, s.display)
  // Local play never gets a +connect: the engine would leave the map for the server
  // the moment it loaded.
  const args = buildArgs({
    host: has('--local') ? null : host || '127.0.0.1:28960',
    map: has('--local') ? map : null,
    ...(fsGame ? { fsGame } : {}),
    windowMode,
    settings: s,
    display,
  })
  const borderless = windowMode === 'player' && resolveMode(s) === 'borderless'
  console.log(`exe : ${P.game}\\CoDWaW.exe`)
  console.log(`cwd : ${P.game}`)
  console.log(`home: ${P.home}`)
  if (displays.length) {
    for (const d of displays) console.log(`disp: ${d.label} ${d.width}x${d.height} at ${d.x},${d.y}${d.primary ? ' (main)' : ''}${d === display ? '   <- chosen' : ''}`)
  } else {
    console.log('disp: no monitor list on this run (plain node, and the app has cached none yet).')
    console.log(`      Start the app once to cache it; until then the baseline uses the saved resolution (${s.resolution || 'none saved'}).`)
  }
  console.log(`mode: ${resolveMode(s)}${display ? ` at ${resolutionOf(display)}` : ''}   (windowMode ${windowMode})`)
  console.log('')
  console.log(`"${P.game}\\CoDWaW.exe" ${args.join(' ')}`)
  console.log('')
  console.log(`env : SteamAppId=10090 SteamGameId=10090 ENW_BORDERLESS=${borderless ? '1' : '0'}`)
  console.log('      ENW_HOST=... ENW_INSTANCE=... ENW_ROLE=client')
  console.log('      ENW_TOKEN_PIPE=\\\\.\\pipe\\enw-launch-<random>   <- the invite token goes here')
  console.log('')
  console.log('note: the token is NOT in the command line above, and will not be.')
  console.log(`lock: ${lock.enabled() ? `dev box detected; would take ${lock.lockFile}` : 'no dev box; no lock needed'}`)
  const cur = lock.read()
  if (cur.held) console.log(`      currently held by ${cur.name} pid ${cur.pid} (${Math.round(cur.ageMs / 1000)}s ago)${cur.stale ? ' [STALE]' : ''}: ${cur.why}`)
  process.exit(0)
}

// --track: the whole MVP from a terminal — start the referee, register the match,
// launch the game pointed at it, and print the round count and the replay path when
// the run ends. Exactly what the app's Play Local button does, minus Electron, so a
// failure can be told apart from a UI problem.
let agent = null
let run = null
let matchId = val('--match', `l_${crypto.randomBytes(4).toString('hex')}`)
let linkHost = val('--link', null)
if (has('--track')) {
  agent = new HostAgent()
  agent.on('log', (m) => console.log(`[ .. ] referee                  ${m}`))
  const info = await agent.ensure()
  run = new LocalRun({ api: null, dashUrl: info.dashUrl })
  run.offline = true            // no site from the CLI; the run is still recorded
  run.matchId = matchId
  const expected = await run.expect({ instance: matchId, matchId, map })
  linkHost = expected.link || info.linkHost
  console.log(`[done] referee                  match ${matchId} on ${linkHost}; dashboard ${info.dashUrl}`)
  console.log(`[done] replays                  ${info.replayDir}`)
}

const flow = new BootFlow({
  map,
  siteUrl,
  host,
  localMap: has('--local') ? map : null,
  fsGame,
  windowMode,
  instance: has('--track') ? matchId : undefined,
  linkHost,
  installDir: fsGame ? path.join(P.maps, fsGame.split('/').pop()) : null,
  useGameLock: !has('--no-lock'),
  lockName: 'launcher',
  hostDashboard: agent?.dashUrl || val('--dash', 'http://127.0.0.1:8787'),
  serverTimeoutMs: Number(val('--server-timeout', '8000')),
  connectTimeoutMs: seconds * 1000,
  nannySeconds: seconds + 30,
  settings: settings.get(),
})

flow.on('step', (s) => {
  const icon = s.state === 'done' ? 'done' : s.state === 'failed' ? 'FAIL' : ' .. '
  console.log(`[${icon}] ${s.label.padEnd(24)} ${s.detail}${s.simulated ? '   (SIMULATED)' : ''}`)
})
flow.on('note', () => {})
if (has('--console')) flow.on('console', (l) => console.log(`    | ${l}`))

let lastRound = null
// --track: watch the referee the way the app does, and say out loud what it sees.
// This is the instrumentation that turns "did my run get logged?" into a line of text.
if (run) {
  run.on('frame', (f) => { if (f.n === 1 || f.round !== lastRound) { lastRound = f.round; console.log(`[ .. ] round                     ${f.round} (${f.players} player${f.players === 1 ? '' : 's'})`) } })
  run.relayUntilDone({ instanceId: matchId, timeoutMs: (seconds + 120) * 1000 }).then((r) => {
    console.log('')
    if (r.ok) {
      console.log(`RUN LOGGED  match ${matchId}`)
      console.log(`  round           ${r.summary?.rounds}`)
      console.log(`  finish          ${r.summary?.finish?.label || r.summary?.end_reason || '-'}`)
      console.log(`  duration        ${Math.round((r.summary?.duration_ms || 0) / 1000)}s`)
      console.log(`  flags           ${(r.summary?.flags || []).join(', ') || '-'}`)
      console.log(`  replay          ${r.replay?.file || '(none)'}`)
      console.log(`  verify it with  node infra\\host-agent\\tools\\verify.js "${r.replay?.file || ''}"`)
    } else {
      console.log(`RUN NOT LOGGED: ${r.reason}  (last round seen: ${r.lastRound ?? 'none'}, ${r.frames} frames)`)
    }
  }).catch((e) => console.log(`relay failed: ${e.message}`))
}


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
    // Give the referee time to notice the game is gone, end it and sign the replay.
    if (run) {
      console.log('waiting for the referee to close the game and sign the replay…')
      setTimeout(() => { run.stop(); agent?.stop(); process.exit(0) }, 25_000)
    } else {
      agent?.stop()
      process.exit(0)
    }
  }, 1200)
}

process.on('SIGINT', () => stop('interrupted'))
const timer = setTimeout(() => stop(`test window of ${seconds}s elapsed`), seconds * 1000)

flow.run().then((snap) => {
  clearTimeout(timer)
  if (snap.failed) { stop('a step failed'); return }
  stop('boot flow finished')
})
