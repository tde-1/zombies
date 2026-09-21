#!/usr/bin/env node
// "Did my run get logged?" — the answer, in one command.
//
// The chain from a zombie dying to a round on the website has six links in it and
// five of them are invisible. When it works, nobody needs this. When it does not,
// the difference between "the DLL never saw the round" and "the referee saw it and
// the site refused it" is the whole diagnosis, and it is currently spread across four
// log files in three formats.
//
//   node launcher/tools/last-run.js              the most recent run
//   node launcher/tools/last-run.js --all        every run it can find
//   node launcher/tools/last-run.js --match l_x  one match
//
// On a machine with no Node, the launcher's own copy of Node will do:
//   set ELECTRON_RUN_AS_NODE=1
//   "%LOCALAPPDATA%\Programs\@enw-zombieslauncher\ENW Zombies.exe" last-run.js
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const ROOT = process.env.ENW_ROOT || path.join(LOCAL, 'ENWZombies')
const LOGS = path.join(ROOT, 'logs')
const REPLAYS = path.join(ROOT, 'replays')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const ls = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
const newest = (files) => files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f || null

const BAR = '-'.repeat(72)

function runs() {
  // A run is named by its match id, and the host agent's games_mp mirror is the one
  // file that exists for every run whether or not it ended cleanly.
  const out = []
  for (const f of ls(LOGS)) {
    const m = /^(.+)\.games_mp\.log$/.exec(f)
    if (!m) continue
    out.push({ match: m[1], gameLog: path.join(LOGS, f), at: fs.statSync(path.join(LOGS, f)).mtimeMs })
  }
  return out.sort((a, b) => b.at - a.at)
}

function report(run) {
  const lines = read(run.gameLog).split('\n').filter(Boolean)
  const rounds = lines.filter((l) => /;round;/.test(l)).map((l) => Number(l.split(';').pop()))
  const notifies = lines.filter((l) => /;notify;/.test(l)).map((l) => l.split(';').pop())
  const match = lines.find((l) => /;match;/.test(l))
  const init = lines.find((l) => /InitGame:/.test(l))
  const replay = path.join(REPLAYS, `${run.match}.enwr`)

  console.log(BAR)
  console.log(`MATCH ${run.match}       ${new Date(run.at).toLocaleString()}`)
  console.log(BAR)

  // 1. did the game reach the referee at all?
  console.log(`1. the game reached the referee   ${lines.length ? 'YES' : 'NO'}   (${lines.length} events)`)
  if (init) {
    const kv = init.split('InitGame:')[1].split('\\').filter(Boolean)
    const map = kv[kv.indexOf('mapname') + 1]
    console.log(`   map                            ${map || '?'}`)
  }

  // 2. rounds
  const top = rounds.length ? Math.max(...rounds) : null
  console.log(`2. rounds reported                ${rounds.length ? rounds.join(', ') : 'NONE'}`)
  console.log(`   highest round                  ${top ?? '-'}`)
  if (top === 1 && rounds.length === 1) {
    console.log('   ^ round 1 only. That is what an unattended game looks like: the map came')
    console.log('     up and nobody killed anything, so `between_round_over` never fired.')
    console.log('     If you PLAYED and survived round 1, this is the thing that is broken.')
  }

  // 3. what the scripts said, which is how you tell a broken hook from a quiet game
  const interesting = notifies.filter((n) => !/^(spawned_|weapon_change|intro_hud|end_respawn|end_firing)/.test(n))
  console.log(`3. script notifies seen           ${notifies.length}  (${[...new Set(interesting)].slice(0, 12).join(', ') || 'none'})`)
  if (!notifies.some((n) => n === 'between_round_over') && top && top > 1) {
    console.log('   ^ rounds advanced without between_round_over: something other than the')
    console.log('     counter reported them. Worth knowing which.')
  }

  // 4. the summary
  if (match) {
    const p = match.split(';')
    console.log(`4. the referee called the game    YES`)
    console.log(`   round / finish                 ${p[4]} / ${p[5]}`)
    console.log(`   duration                       ${Math.round(Number(p[6]) / 1000)}s`)
    console.log(`   flags                          ${p[8] || '-'}`)
  } else {
    console.log('4. the referee called the game    NO — no summary line.')
    console.log('   The game is either still running, or it went away and the referee was')
    console.log('   not there to notice. Without this the replay has no signed footer.')
  }

  // 5. the replay
  if (fs.existsSync(replay)) {
    const size = fs.statSync(replay).size
    console.log(`5. replay                         ${replay}`)
    console.log(`   size                           ${(size / 1024).toFixed(1)} KiB`)
    const verifier = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'infra', 'host-agent', 'tools', 'verify.js')
    if (fs.existsSync(verifier)) {
      const r = spawnSync(process.execPath, [verifier, replay], { encoding: 'utf8' })
      const verdict = (r.stdout || '').split('\n').filter((l) => /VALID|INVALID|FAIL/.test(l))[0]
      console.log(`   verified                       ${verdict ? verdict.replace(/\[[0-9;]*m/g, '').trim() : '(verifier said nothing)'}`)
    }
  } else {
    console.log('5. replay                         NONE at ' + replay)
  }
  console.log('')
}

// The DLL's own view, which is the only place that says WHY a round was reported.
function dllView() {
  const logs = ls(LOGS).filter((f) => /^enw-\d+\.log$/.test(f)).map((f) => path.join(LOGS, f))
  const f = newest(logs)
  if (!f) { console.log('No client log in ' + LOGS + ' — the DLL never loaded.'); return }
  const txt = read(f)
  console.log(BAR)
  console.log(`THE CLIENT'S OWN LOG   ${f}`)
  console.log(BAR)
  const want = [
    [/game-link: connected to (\S+)/, 'connected to the referee at'],
    [/game-link: ENW_HOST is not set/, 'ENW_HOST WAS NOT SET — the game was not told where the referee is'],
    [/referee\/bind: (notify=\S+.*)/, 'what the client can see'],
    [/referee: map_loaded (.*)/, 'map'],
  ]
  for (const [re, label] of want) {
    const m = re.exec(txt)
    if (m) console.log(`  ${label.padEnd(34)} ${m[1] || ''}`)
  }
  const rounds = [...txt.matchAll(/referee: ROUND (\d+) \(([^)]+)\)/g)]
  console.log(`  rounds the client reported         ${rounds.length ? rounds.map((m) => `${m[1]} (${m[2]})`).join(', ') : 'NONE'}`)
  const over = /referee: game over at round (\d+) \(([^)]+)\)/.exec(txt)
  console.log(`  game over                          ${over ? `round ${over[1]} via ${over[2]}` : 'not seen'}`)

  // A GSC runtime error at map load kills the server script, and then NOTHING else
  // works: no rounds, no map_loaded, no replay. It looks like our bug and it is the
  // map's. MEASURED on nazi_zombie_dt2: "entity already has linkTo enabled".
  const err = /Com_Error TRAPPED[\s\S]{0,600}?arg3 = \w+ "([^"]+)"/.exec(txt)
  if (err) {
    console.log('')
    console.log(`  THE MAP'S OWN SCRIPTS FAILED: "${err[1]}"`)
    console.log('  That is a GSC runtime error inside the map, at load. The server script')
    console.log('  stops, so there are no rounds to report and nothing to record. Nothing')
    console.log('  on our side can fix it — try a different map.')
  }
  console.log('')
}

const all = runs()
if (!all.length) {
  console.log(`No runs found in ${LOGS}.`)
  console.log('Nothing has been refereed on this machine yet — the referee writes')
  console.log('<match>.games_mp.log there the moment a game connects to it.')
  process.exit(1)
}
const pick = val('--match') ? all.filter((r) => r.match === val('--match')) : has('--all') ? all : [all[0]]
for (const r of pick) report(r)
dllView()
console.log(`(${all.length} run${all.length === 1 ? '' : 's'} on this machine; --all to see them, --match <id> for one)`)
