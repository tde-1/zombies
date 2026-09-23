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
// --games N              play N matches on this one process (default 1). After the Nth
//                        game over the roster does NOT come back, so the instance sits
//                        idle exactly as a real server does and the host's disposition
//                        has something to dispose of.
// --end-fails            answer `end` with reply.ok:false (the contract's "command buffer
//                        unavailable" — the instance must be torn down, never reused)
// --no-match-end         report the result and then say nothing about being idle, the way
//                        every server did before match_end existed
// --gatecrash            seat one EXTRA player at the start with no invite token, so a box
//                        that is enforcing has something to refuse. Their row still reaches
//                        the result — with no account on it, which is the whole rule
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
// How many matches this process plays before it goes quiet for good. A real dedicated
// server plays as many as the host asks for; the number here is only so a test can say
// "and then it stayed idle" and have that mean something.
const maxGames = Number(a.games ?? process.env.ENW_SIM_GAMES ?? 1)

const sim = new ZombiesSim({
  instance,
  seed: Number(a.seed ?? 1337),
  map: a.map || process.env.ENW_SIM_MAP || 'nazi_zombie_asylum',
  fsGame: a['fs-game'] || process.env.ENW_SIM_FSGAME || null,
  maxRound: Number(a['max-round'] ?? process.env.ENW_SIM_MAX_ROUND ?? 15),
  endFails: !!a['end-fails'] || process.env.ENW_SIM_END_FAILS === '1',
  noMatchEnd: !!a['no-match-end'] || process.env.ENW_SIM_NO_MATCH_END === '1',
  realWarm: !!a['real-warm'],
  // The lease this process was started for. The real referee reads exactly this variable,
  // once, at process start (game-link-v0 `end`.`match`).
  matchId: process.env.ENW_MATCH || a.match || null,
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
  // A real map takes 5-10 s to load on the box, and one (nazi_zombie_displace, 12:12) never
  // did. --load-ms / --never-loads model both, so the boot queue has something to wait on.
  if (a['never-loads']) { console.error(`[sim ${instance}] linked; this map never loads (--never-loads)`); return }
  const loadMs = Number(a['load-ms'] || 0)
  if (loadMs > 0) { setTimeout(play, loadMs); return }
  play()
}

function play() {
  send({ t: 'map_loaded', ms: 0, map: sim.map, fs_game: sim.fsGame, mode: 'zombies', sv_maxclients: 4 })

  seatRoster()
  // The gatecrasher joins with the lobby, not late: a late join flags the whole game
  // no-records (vault 4.4) and this is a test of IDENTITY, not of the late-join rule.
  if (a.gatecrash) {
    sim.connectPlayer({ slot: nPlayers, name: 'Gatecrasher', steamid: '76561190000000009', token: 'not.a.real.token' })
  }

  if (a['late-join-ms']) {
    const at = Number(a['late-join-ms'])
    const h = () => { if (sim.ms >= at) { sim.off('event', h); sim.connectPlayer({ slot: nPlayers, name: NAMES[nPlayers % NAMES.length], token: tokens[nPlayers] ?? null }) } }
    sim.on('event', h)
  }

  // Wall-clock pacing: sim time must advance `timescale` times faster than the clock on
  // the wall, whatever the timer actually does.
  //
  // It used to ask for `TICK_MS / timescale` ms and step a FIXED number of ticks each
  // fire, which silently under-runs on Windows: a plain `setInterval(6)` fires at
  // 15.65 ms here (measured, 63.9 Hz), not at 6 ms, because nothing in this process
  // raises the system timer resolution. `--timescale 8` therefore advanced at 3.2x, and
  // an 8-round solo game that should take 46 s took 116 s — which is what made
  // `test/demo-local.js` fail on an 80 s deadline while nothing was actually wrong.
  //
  // So: measure the elapsed wall time on every fire and step as many 50 ms ticks as it
  // has earned. A slow timer now costs a bigger batch, not a slower game. `owed` is
  // capped so a stalled process cannot come back and spin for minutes.
  // (Getting this wrong the other way once made a "30x" run go 300x, which is how the
  // drop policy above got found — hence the cap rather than an unbounded catch-up.)
  const interval = Math.max(5, Math.min(TICK_MS, Math.round(TICK_MS / timescale)))
  const MAX_BATCH = 400          // at most 20 s of sim time in one fire
  let owed = 0
  let last = Date.now()
  console.error(`[sim ${instance}] ${timescale}x = ~${((timescale * 15.6) / TICK_MS).toFixed(1)} tick(s) per fire, asking for every ${interval} ms`)
  const timer = setInterval(() => {
    const now = Date.now()
    owed = Math.min(owed + ((now - last) * timescale) / TICK_MS, MAX_BATCH)
    last = now
    let n = Math.floor(owed)
    owed -= n
    while (n-- > 0) if (!sim.step()) { clearInterval(timer); setTimeout(() => process.exit(0), 250); return }
  }, interval)

  sim.on('end', (r) => {
    const d = Object.entries(dropped).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ')
    console.error(`[sim ${instance}] game over: ${r} at round ${sim.round}, sim time ${(sim.ms / 3600000).toFixed(2)}h${d ? `, dropped ${d}` : ''}`)
    console.error(`[sim ${instance}] match_end sent; the process is ALIVE and idle, waiting for \`end\` or a kill (game ${sim.games} of ${maxGames})`)
  })

  // THE INSTANCE IS REUSED. `end` made the engine map_restart and re-announce
  // `map_loaded`; on a real server the clients are still connected through a map_restart,
  // so the same roster comes back with it. After the last game they do not, and the
  // process sits there idle — which is the state the host has to notice and clean up.
  sim.on('restart', ({ reason, roster: back, matchId, simRoster }) => {
    // A WARM SERVER HAS NO LEASE AND ADMITS NOBODY. The referee clears its match id on
    // every reset, so until the host tells it the next one (`end`.`match`) every invite
    // token is `wrong_match` — and there is nothing for anyone to be admitted TO. That is
    // what keeps a reused instance idle between leases instead of immediately replaying
    // the same party under a match id the site never issued.
    if (!matchId) {
      // --real-warm: what the DLL on the box does instead (12:17:02). The clients were never
      // disconnected by the map_restart, so they re-announce themselves with the tokens
      // they joined the last match with, and the host has to decide what to do with them.
      if (a['real-warm'] && back.length) {
        console.error(`[sim ${instance}] map_restart (${reason}) — no match id, but ${back.length} client(s) still connected come back with their old tokens (--real-warm)`)
        setTimeout(() => seatRoster(back), 50)
        return
      }
      console.error(`[sim ${instance}] map_restart (${reason}) — no match id: WARM and idle, admitting nobody`)
      return
    }
    if (sim.games >= maxGames) {
      console.error(`[sim ${instance}] map_restart (${reason}) — ${sim.games} game(s) played, staying idle`)
      return
    }
    // `simRoster` is the next party and its invite tokens, handed over in the `end`
    // message. It is a SIMULATOR-ONLY affordance and the real DLL ignores it: a real
    // client brings its own token in its userinfo when it connects, so the real server
    // needs nothing but the match id to check it against.
    const seat = simRoster && simRoster.length ? simRoster : back
    console.error(`[sim ${instance}] map_restart (${reason}) — match ${matchId}, seating ${seat.length} player(s)${simRoster ? ' from the new lease' : ' still connected'}`)
    setTimeout(() => seatRoster(seat), 50)
  })
}

/** Seat the lobby: the leased roster on a cold boot, whoever survived the map_restart after. */
function seatRoster(back = null) {
  if (back) {
    for (const r of back) sim.connectPlayer({ slot: r.slot, name: r.name, steamid: r.steamid, token: r.token ?? null, party_slot: r.party_slot ?? r.slot })
    return
  }
  for (let i = 0; i < nPlayers; i++) {
    const r = roster?.[i] || {}
    sim.connectPlayer({
      slot: i,
      name: r.name || NAMES[i % NAMES.length],
      steamid: r.steamid || undefined,
      afk: r.afk ?? (a['afk-slot'] != null && Number(a['afk-slot']) === i),
      token: r.token ?? tokens[i] ?? null,
      party_slot: r.party_slot ?? i,
    })
  }
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { try { sim.dead = true; sim.endGame('shutdown') } catch { /* ignore */ } process.exit(0) })

connectAndRun()
