#!/usr/bin/env node
// A fake game instance: runs sim/engine.js and speaks game-link-v0 down a TCP socket to
// ENW_HOST. The host agent cannot tell it from the real thing except by `hello.dll_build`.
//
//   ENW_HOST=127.0.0.1:port ENW_INSTANCE=inst-01 ENW_ROLE=server node sim/sim-instance.js \
//     --players 4 --map nazi_zombie_asylum --max-round 25 --timescale 1
//
// --players N            how many bots join at the start
// --late-join-ms MS      a 5th player joins this far into the game (tests late-join)
// --afk-slot N           this player sends no input (tests the AFK ladder)
// --token-slot N=TOKEN   this player presents TOKEN at connect (tests invite tokens)
// --timescale S          run S× faster than real time (the 24 h cap in seconds)
// --max-round N          end the game after this round
// --ee-round N           fire the Easter-egg notify on this round
// --stdout               no socket; print NDJSON (handy for eyeballing the stream)
import net from 'node:net'
import { ZombiesSim, TICK_MS } from './engine.js'
import { parseArgs, ndjsonSplit } from '../lib/util.js'

const a = parseArgs(process.argv.slice(2))
const [host, port] = String(process.env.ENW_HOST || '127.0.0.1:38700').split(':')
const instance = process.env.ENW_INSTANCE || a.instance || 'sim-1'
const role = process.env.ENW_ROLE || 'server'

const timescale = Number(a.timescale ?? process.env.ENW_SIM_TIMESCALE ?? 1)
const tokens = {}
for (const t of [].concat(a['token-slot'] || [])) { const [s, v] = String(t).split('='); tokens[Number(s)] = v }
if (process.env.ENW_SIM_TOKENS) Object.assign(tokens, JSON.parse(process.env.ENW_SIM_TOKENS))

// ENW_SIM_ROSTER is the real lobby the site leased: [{slot,name,steamid,token,afk}].
// Without it we invent players. With it the SteamIDs match the ones the tokens are bound
// to, which is the whole point of the token check.
const roster = process.env.ENW_SIM_ROSTER ? JSON.parse(process.env.ENW_SIM_ROSTER) : null
const nPlayers = roster ? roster.length : Number(a.players ?? 1)

const sim = new ZombiesSim({
  instance,
  seed: Number(a.seed ?? 1337),
  map: a.map || process.env.ENW_SIM_MAP || 'nazi_zombie_asylum',
  fsGame: a['fs-game'] || process.env.ENW_SIM_FSGAME || null,
  maxRound: Number(a['max-round'] ?? process.env.ENW_SIM_MAX_ROUND ?? 15),
  eeRound: a['ee-round'] ? Number(a['ee-round']) : null,
  buyableEndingRound: a['ending-round'] ? Number(a['ending-round']) : null,
})

const NAMES = ['Dempsey', 'Nikolai', 'Takeo', 'Richtofen', 'Peters', 'Smokey']

let sock = null
let outBuf = []
let writable = true
const dropped = { snap: 0, input: 0, perf: 0 }

// WHICH EVENTS MAY BE DROPPED WHEN THE LINK BACKS UP.
// The protocol says "queue and drop oldest on overflow". Dropping blindly is wrong and
// this simulator proved it: run at 300x and `round` events get discarded, so the referee
// sees the game stuck at round 21 while the game is at round 40 — the summary, the badge
// and the record are all wrong. Only the resampleable streams may be dropped.
// Everything else is EVIDENCE and must block the queue rather than vanish.
const DROPPABLE = new Set(['snap', 'input', 'perf'])

function send(obj) {
  const line = JSON.stringify(obj) + '\n'
  if (a.stdout || !sock) { if (a.stdout) process.stdout.write(line); return }
  if (!writable) {
    outBuf.push({ t: obj.t, line })
    while (outBuf.length > 4096) {
      // Drop the oldest DROPPABLE entry; if there is none, the queue is all evidence and
      // we let it grow (a real DLL would stall its sender thread here, never the frame).
      const i = outBuf.findIndex((x) => DROPPABLE.has(x.t))
      if (i < 0) break
      dropped[outBuf[i].t] = (dropped[outBuf[i].t] || 0) + 1
      outBuf.splice(i, 1)
    }
    return
  }
  writable = sock.write(line)
}

sim.on('event', send)

// A real game prints chat to its console; the host agent captures that console into the
// per-instance log. Keeping that true here is what makes "the line from game A showed up
// in game B" something you can SEE rather than something a test asserts about.
sim.on('say', (c) => console.error(`[chat] ${c.from ? `(${c.from}) ` : ''}${c.text}`))
sim.on('tell', (c) => console.error(`[chat->${c.slot}] ${c.text}`))

function connectAndRun() {
  if (a.stdout) return run()
  sock = net.createConnection({ host, port: Number(port) }, () => {
    sock.setNoDelay(true)
    run()
  })
  sock.on('drain', () => { writable = true; while (outBuf.length && writable) writable = sock.write(outBuf.shift().line) })
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    const { lines, rest } = ndjsonSplit(buf, 1 << 20)
    buf = rest
    for (const l of lines) { try { sim.onCommand(JSON.parse(l.toString('utf8'))) } catch { /* ignore junk */ } }
  })
  sock.on('error', (e) => { console.error(`[sim ${instance}] link error: ${e.message}`); process.exit(3) })
  sock.on('close', () => { console.error(`[sim ${instance}] link closed`); process.exit(0) })
}

function run() {
  send({ t: 'hello', v: 0, instance, role, pid: process.pid, exe_sha256: '732900D158982C33E3121F0B86D22230BE79839BBCBFE3BDFC1238F408A7D64D', dll_build: `sim-${process.version}` })
  send({ t: 'map_loaded', ms: 0, map: sim.map, fs_game: sim.fsGame, mode: 'zombies', sv_maxclients: 4 })

  for (let i = 0; i < nPlayers; i++) {
    const r = roster?.[i] || {}
    sim.connectPlayer({
      slot: i,
      name: r.name || NAMES[i % NAMES.length],
      steamid: r.steamid || undefined,
      afk: r.afk ?? (a['afk-slot'] != null && Number(a['afk-slot']) === i),
      token: r.token ?? tokens[i] ?? null,
    })
  }

  if (a['late-join-ms']) {
    const at = Number(a['late-join-ms'])
    const h = () => { if (sim.ms >= at) { sim.off('event', h); sim.connectPlayer({ slot: nPlayers, name: NAMES[nPlayers % NAMES.length], token: tokens[nPlayers] ?? null }) } }
    sim.on('event', h)
  }

  // Wall-clock pacing: `interval` ms of real time carries `perTick` 50 ms sim ticks, so
  // sim time advances `timescale` times faster than the clock on the wall. Timers never
  // fire faster than ~200 Hz, so above 10x we batch ticks instead of shortening the
  // interval. (Getting this wrong once made a "30x" run go 300x, which is how the drop
  // policy above got found.)
  const interval = Math.max(5, Math.round(TICK_MS / timescale))
  const perTick = Math.max(1, Math.round((timescale * interval) / TICK_MS))
  console.error(`[sim ${instance}] ${timescale}x = ${perTick} tick(s) every ${interval} ms`)
  const timer = setInterval(() => {
    for (let i = 0; i < perTick; i++) if (!sim.step()) { clearInterval(timer); setTimeout(() => process.exit(0), 250); return }
  }, interval)

  sim.on('end', (r) => {
    const d = Object.entries(dropped).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ')
    console.error(`[sim ${instance}] game over: ${r} at round ${sim.round}, sim time ${(sim.ms / 3600000).toFixed(2)}h${d ? `, dropped ${d}` : ''}`)
  })
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { try { sim.endGame('shutdown') } catch { /* ignore */ } process.exit(0) })

connectAndRun()
