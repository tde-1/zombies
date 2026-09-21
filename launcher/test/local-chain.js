#!/usr/bin/env node
// The whole Play Local chain, with a stand-in for the one part we cannot automate.
//
//   launcher  ->  starts the host agent            (hostagent.js)
//             ->  registers the match with it      (/api/local/expect)
//   "game"    ->  speaks game-link v0 at it        (this file, in place of the DLL)
//   launcher  ->  relays and files the result      (localrun.js)
//   assert    ->  a signed replay exists on disk and verifies
//
// The stand-in sends EXACTLY the messages the DLL now sends, in the order it sends
// them — `hello`, `map_loaded` off the command line, `round` counted from
// `between_round_over`, `game_over` from `stop_intermission`. Every other part of the
// chain here is the real code: the real host agent process, the real referee, the real
// replay writer and verifier, and the launcher's own hostagent.js and localrun.js.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the plumbing end to end and it
// proves the message shapes are the ones the host agent understands. It does not prove
// that World at War fires `between_round_over` where we think it does — only a human
// playing can prove that, which is what TESTME.md is for.
//
//   node test/local-chain.js            # rounds 1..8, then game over
//   node test/local-chain.js --rounds 3
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const ROUNDS = Number(arg('--rounds', 8))

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-chain-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
fs.mkdirSync(process.env.ENW_ROOT, { recursive: true })

const { HostAgent } = await import('../src/main/hostagent.js')
const { LocalRun } = await import('../src/main/localrun.js')

let pass = 0
let fail = 0
const check = (ok, name, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------- the stand-in game --
// game-link v0: NDJSON over TCP, one UTF-8 JSON object per line.
class FakeGame {
  constructor(hostPort, instance, map) {
    const [host, port] = String(hostPort).split(':')
    this.host = host; this.port = Number(port)
    this.instance = instance; this.map = map
    this.t0 = Date.now()
    this.received = []
  }
  ms() { return Date.now() - this.t0 }
  send(o) { this.sock.write(JSON.stringify({ ms: this.ms(), ...o }) + '\n') }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.host, port: this.port }, () => resolve())
      this.sock.on('error', reject)
      let buf = ''
      this.sock.on('data', (d) => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (line.trim()) { try { this.received.push(JSON.parse(line)) } catch {} }
        }
      })
    })
  }
  close() { this.sock?.end() }
}

console.log(`\nPlay Local, end to end (${TMP})\n`)

// 1. The launcher starts the referee ------------------------------------------------
const agent = new HostAgent()
agent.on('log', (m) => console.log(`       hostagent: ${m}`))
let info
try {
  info = await agent.ensure()
  check(true, 'the launcher started a host agent', `${info.dashUrl}, link ${info.linkHost}, pid ${info.pid ?? 'adopted'}`)
} catch (e) {
  check(false, 'the launcher started a host agent', e.message)
  process.exit(1)
}

const state0 = await (await fetch(`${info.dashUrl}/api/state`)).json()
check(state0.local?.enabled === true, 'it is in local mode', `mode=${state0.local?.mode}`)
check(state0.local?.lease_held === false, 'and holds no lease, so it will adopt our game')

// 2. Register the match -------------------------------------------------------------
const MATCH = 'l_chaintest01'
const MAP = 'nazi_zombie_prototype'
const run = new LocalRun({ api: null, dashUrl: info.dashUrl })
run.offline = true            // no site in this test; the run must still be recorded
run.matchId = MATCH
let expected
try {
  expected = await run.expect({ instance: MATCH, matchId: MATCH, map: MAP })
  check(!!expected.link, 'the referee was told to expect the match', `link ${expected.link}`)
} catch (e) {
  check(false, 'the referee was told to expect the match', e.message)
  agent.stop(); process.exit(1)
}

// 3. The game connects and plays ----------------------------------------------------
const game = new FakeGame(expected.link, MATCH, MAP)
await game.connect()
game.send({ t: 'hello', v: 0, instance: MATCH, role: 'client', pid: process.pid,
  exe_sha256: '732900d158982c33e3121f0b86d22230be79839bbcbfe3bdfc1238f408a7d64d',
  dll_build: 'chain-test' })
await sleep(400)

const afterHello = await (await fetch(`${info.dashUrl}/api/state`)).json()
const inst = afterHello.instances.find((i) => i.id === MATCH)
check(!!inst, 'the referee adopted it', inst ? `instance ${inst.id}, foreign=${inst.foreign !== false}` : 'no instance appeared')
check(inst?.self_reported === true, 'and stamped it self-reported (no XP, no records)')

// map_loaded: what referee.cpp now sends on the first SV_Frame.
game.send({ t: 'map_loaded', map: MAP, fs_game: 'mods/enw', mode: 'zombies', sv_maxclients: 4 })
game.send({ t: 'player_connect', slot: 0, name: 'B', steamid: '76561198126330106' })
game.send({ t: 'player_spawn', slot: 0 })
await sleep(300)

// The rounds. Round 1 comes from `all_players_connected`; every later round from one
// more `between_round_over`.
for (let n = 1; n <= ROUNDS; n++) {
  game.send({ t: 'round', n })
  game.send({ t: 'points', slot: 0, score: n * 500 })
  game.send({ t: 'snap', players: [{ slot: 0, pos: [10 * n, 20, 30], ang: [0, 90], health: 100, score: n * 500, alive: true }] })
  await sleep(120)
}
await sleep(400)

const live = await (await fetch(`${info.dashUrl}/api/state`)).json()
const g = live.instances.find((i) => i.id === MATCH)?.game
check(g?.round === ROUNDS, `the referee is tracking the round`, `round=${g?.round} (sent ${ROUNDS})`)
check(g?.map === MAP, 'and knows the map', `map=${g?.map}`)
check(g?.players?.length === 1, 'and the player')

// The relay: what main.js starts once the game is up.
const relay = run.relayUntilDone({ instanceId: MATCH, timeoutMs: 60_000 })

// 4. Game over ----------------------------------------------------------------------
await sleep(600)
game.send({ t: 'game_over', round: ROUNDS, reason: 'stop_intermission notify' })
await sleep(1200)
game.close()

const result = await relay
check(result.ok === true, 'the relay produced a result', result.reason || '')
check(result.summary?.rounds === ROUNDS, 'the summary has the round count', `rounds=${result.summary?.rounds}`)
check(result.summary?.map === MAP, 'and the map', `map=${result.summary?.map}`)
check(result.summary?.records_eligible === false, 'and refuses to call a local game eligible')
check(result.frames > 0, 'live frames were produced for the site', `${result.frames} frames`)

// 5. The replay ---------------------------------------------------------------------
const file = result.replay?.file
check(!!file, 'the run left a replay pointer', file || 'none')
check(!!file && fs.existsSync(file), 'and the file is on disk', file ? `${fs.statSync(file).size} bytes` : '')
check(!!file && path.dirname(file) === agent.replayDir, 'in the folder the launcher told it to use', agent.replayDir)

if (file && fs.existsSync(file)) {
  const verifier = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'infra', 'host-agent', 'tools', 'verify.js')
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [verifier, file, '--tamper'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    p.stdout.on('data', (d) => { s += d })
    p.stderr.on('data', (d) => { s += d })
    p.on('exit', (code) => resolve({ code, s }))
  })
  check(out.code === 0, 'the replay verifies, and fails when one bit is flipped', out.s.split('\n').filter((l) => /verif|tamper|SIGNAT|ok|FAIL/i.test(l)).slice(-3).join(' | '))
  const header = JSON.parse(fs.readFileSync(file).subarray(12, 12 + fs.readFileSync(file).readUInt32LE(8)).toString())
  check(header.self_reported === true, 'and the replay header itself says self-reported', `match ${header.match_id}, map ${header.map}`)
}

// 6. Nothing is left running --------------------------------------------------------
const pid = agent.pid
agent.stop()
await sleep(2500)
let alive = true
try { process.kill(pid, 0) } catch { alive = false }
check(!alive, 'the host agent died with the launcher', `pid ${pid}`)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
