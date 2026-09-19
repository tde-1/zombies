#!/usr/bin/env node
// The end-to-end demo: a mock website and TWO game boxes, exactly the shape production
// would have.
//
//   mock site :8099            — the pull protocol + the global chat ring + the web UI
//     ^ poll        ^ poll
//   host agent box-a         host agent box-b        (two separate processes)
//     |                        |
//   sim instance (2 players) sim instance (2 players)
//
// What it proves, in one run:
//   1. pull protocol   — the site leases a match; the box boots, reports ready, plays,
//                        posts the result. The site never connects out.
//   2. invite tokens   — valid tokens join; a forged one and an expired one are refused.
//   3. cross-server chat — a line typed in game A reaches game B and the web UI, and a
//                        line typed on the web reaches both games.
//   4. replays         — each box writes a signed replay and it verifies.
//
// Run: node test/demo-network.js     (nothing is left running; every PID is ours)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyFile } from '../lib/replay.js'
import { mkdirp, parseArgs } from '../lib/util.js'

const args = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-demo-' + Date.now().toString(36)))
const SITE = 'http://127.0.0.1:8099'
const VERBOSE = !!args.verbose

const procs = []
let failures = 0
const step = (n) => console.log(`\n\x1b[36m── ${n} ${'─'.repeat(Math.max(0, 66 - n.length))}\x1b[0m`)
const okmsg = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) }

function start(name, script, argv) {
  const p = spawn(process.execPath, [path.join(ROOT, script), ...argv], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ENW_LOG_LEVEL: VERBOSE ? 'debug' : 'info' },
  })
  p.name = name
  p.out = ''
  const tee = (d) => { p.out += d; if (VERBOSE) process.stdout.write(`\x1b[90m[${name}]\x1b[0m ${d}`) }
  p.stdout.on('data', tee)
  p.stderr.on('data', tee)
  procs.push(p)
  return p
}

async function stopAll() {
  for (const p of procs) { try { p.kill('SIGTERM') } catch { /* gone */ } }
  await delay(1200)
  for (const p of procs) { if (p.exitCode == null) { try { p.kill('SIGKILL') } catch { /* gone */ } } }
}

const post = (p, body, secret) => fetch(SITE + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-match-secret': secret } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.json())
const get = (p) => fetch(SITE + p).then((r) => r.json())

async function waitFor(what, fn, ms = 30_000, every = 300) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v } catch { /* not yet */ }
    await delay(every)
  }
  bad(`timed out waiting for ${what}`)
  return null
}

try {
  step('1. the site comes up')
  start('site', 'mock-site/site.js', ['--port', '8099', '--key-dir', path.join(RUN, 'site-keys')])
  await waitFor('the site', async () => (await get('/admin/state')).invite_key)
  okmsg(`mock site on ${SITE} (invite key ${(await get('/admin/state')).invite_key})`)

  step('2. two game boxes come up and start polling')
  const common = (box, secret, link, dash, base) => [
    '--site', SITE, '--secret', secret, '--box', box,
    '--link-port', String(link), '--dash-port', String(dash), '--base-port', String(base),
    '--replay-dir', path.join(RUN, box, 'replays'), '--log-dir', path.join(RUN, box, 'logs'),
    '--key-dir', path.join(RUN, box, 'keys'),
    // Small rule windows so the whole demo runs in a couple of minutes.
    '--cap-ms', String(45 * 60_000), '--cap-warn-ms', '1800000,600000,60000',
  ]
  const A = start('box-a', 'host.js', common('box-a', 'devkey-a', 38731, 8791, 29100))
  const B = start('box-b', 'host.js', common('box-b', 'devkey-b', 38732, 8792, 29200))
  await waitFor('both boxes polling', async () => (await get('/admin/state')).boxes.length === 2)
  okmsg('box-a and box-b are polling /api/gs/assignment (the site never connects out)')
  for (const [p, n] of [[A, 'box-a'], [B, 'box-b']]) {
    if (/invite key .* loaded/.test(p.out)) okmsg(`${n} fetched the site invite key`)
    else bad(`${n} did not fetch the site invite key`)
  }

  step('3. the site leases a match to each box (pull protocol)')
  const leaseA = await post('/admin/lease', {
    box: 'box-a', map: 'nazi_zombie_factory', mode: 'verified',
    players: [
      { steamid: '76561198000000001', name: 'Dempsey' },
      { steamid: '76561198000000002', name: 'Nikolai' },
      { steamid: '76561198000000003', name: 'Forger', bad: 'forge' },
      { steamid: '76561198000000004', name: 'Stale', bad: 'expire' },
    ],
    // The EE fires on round 6; the manifest still needs the four Der Riese flags in
    // the right order, and the sim emits exactly those.
    sim: { timescale: 8, max_round: 14, ee_round: 6 },
  })
  const leaseB = await post('/admin/lease', {
    box: 'box-b', map: 'nazi_zombie_ali', fs_game: 'mods/nazi_zombie_ali', mode: 'custom',
    players: [{ steamid: '76561198000000011', name: 'Takeo' }, { steamid: '76561198000000012', name: 'Richtofen' }],
    sim: { timescale: 8, max_round: 12, ending_round: 8 },
  })
  okmsg(`leased ${leaseA.assignment.match_id} (Der Riese, 4 invites) to box-a`)
  okmsg(`leased ${leaseB.assignment.match_id} (nazi_zombie_ali, 2 invites) to box-b`)

  await waitFor('both boxes to report ready', async () => {
    const s = await get('/admin/state')
    return s.boxes.every((b) => ['ready', 'live'].includes(b.lastStatus?.state))
  })
  okmsg('both boxes booted an instance and POSTed status=ready — lease -> boot -> ready works')

  step('4. invite tokens at connect')
  await waitFor('auth decisions', () => /auth slot 3/.test(A.out))
  const allow = [...A.out.matchAll(/auth slot (\d) (\S*) (\d+): (ALLOW|DENY) \(([^)]+)\)/g)].map((m) => ({ slot: +m[1], name: m[2], v: m[4], why: m[5] }))
  for (const d of allow) console.log(`       slot ${d.slot} ${d.name.padEnd(10)} ${d.v === 'ALLOW' ? '\x1b[32mALLOW\x1b[0m' : '\x1b[31mDENY \x1b[0m'} (${d.why})`)
  const good = allow.filter((d) => d.v === 'ALLOW').length
  const denied = allow.filter((d) => d.v === 'DENY')
  if (good === 2) okmsg('the two genuine invites joined'); else bad(`expected 2 allowed, got ${good}`)
  if (denied.some((d) => d.why === 'bad_signature')) okmsg('the FORGED token was refused (bad_signature)'); else bad('the forged token was not refused')
  if (denied.some((d) => d.why === 'expired')) okmsg('the EXPIRED token was refused (expired)'); else bad('the expired token was not refused')

  step('5. cross-server chat')
  await waitFor('chat from the games', async () => (await get('/admin/state')).chat.some((c) => c.origin === 'box-a') && (await get('/admin/state')).chat.some((c) => c.origin === 'box-b'))
  const chat = (await get('/admin/state')).chat
  const fromA = chat.find((c) => c.origin === 'box-a')
  okmsg(`a player in game A said "${fromA.text}" and it reached the site ring`)
  const sawInB = await waitFor('A\'s line inside game B', () => {
    const logs = readInstanceLogs(path.join(RUN, 'box-b', 'logs'))
    return logs.includes(fromA.text)
  }, 20_000)
  if (sawInB) okmsg('...and box-b printed it inside its game (A -> site -> B)')

  const webLine = `hello from the website at ${new Date().toISOString().slice(11, 19)}`
  await post('/api/site/chat', { from: 'B', text: webLine })
  const both = await waitFor('the web line in both games', () => {
    const la = readInstanceLogs(path.join(RUN, 'box-a', 'logs'))
    const lb = readInstanceLogs(path.join(RUN, 'box-b', 'logs'))
    return la.includes(webLine) && lb.includes(webLine)
  }, 20_000)
  if (both) okmsg('a line typed on the website appeared in BOTH games (web -> site -> A and B)')

  step('6. the games finish and the boxes post their results')
  const games = await waitFor('two results', async () => {
    const s = await get('/admin/state')
    return s.games.length >= 2 ? s.games : null
  }, 180_000)
  for (const g of games || []) {
    const s = g.summary
    console.log(`       ${g.box}  ${s.map.padEnd(20)} round ${String(s.rounds).padStart(3)}  finish=${s.finish?.kind || 'none'}  ${(s.duration_ms / 60000).toFixed(1)} min  flags=[${s.flags.join(',')}]  eligible=${s.records_eligible}`)
    console.log(`              replay ${path.basename(g.replay?.file || '-')}  ${((g.replay?.size || 0) / 1048576).toFixed(2)} MiB  ${g.replay?.mb_per_hour} MB/game-hour  ${g.replay?.chunks} chunks`)
  }
  if ((games || []).length >= 2) okmsg('both boxes POSTed a game summary + replay pointer to /api/gs/result')

  step('6b. the 24-hour cap and the AFK ladder, on a short clock')
  // Same rules, small windows, so the whole ladder runs in about a minute of wall time.
  // The site sets the windows per lease; the box only enforces them.
  const capLease = await post('/admin/lease', {
    box: 'box-a', map: 'nazi_zombie_prototype', mode: 'custom',
    players: [{ steamid: '76561198000000021', name: 'Peters' }, { steamid: '76561198000000022', name: 'Sleeper' }],
    settings: { referee: { capMs: 8 * 60_000, capWarnMs: [5 * 60_000, 3 * 60_000, 60_000], afkWarnMs: 2 * 60_000, afkKickMs: 4 * 60_000, allAfkPauseMs: 60 * 60_000 } },
    sim: { timescale: 12, max_round: 99, afk_slot: 1 },
  })
  okmsg(`leased ${capLease.assignment.match_id} with an 8-minute cap and a 2/4-minute AFK ladder`)
  const capDone = await waitFor('the capped game to end itself', async () => {
    const s = await get('/admin/state')
    return s.games.find((g) => g.summary?.match_id === capLease.assignment.match_id)
  }, 180_000)
  if (capDone) {
    const s = capDone.summary
    console.log(`       ended: reason=${s.end_reason} round=${s.rounds} flags=[${s.flags.join(',')}] duration=${(s.duration_ms / 60000).toFixed(1)} min`)
    const warns = [...A.out.matchAll(/cap warning: (\d+) min left/g)].map((m) => +m[1])
    if (warns.join(',').includes('5,3,1')) okmsg(`players were warned at ${warns.join(', ')} minutes`)
    else bad(`expected warnings at 5,3,1 minutes, saw [${warns.join(', ')}]`)
    if (s.flags.includes('cap_reached') && s.end_reason === 'time_cap') okmsg('the cap ended the game cleanly and the run was still saved')
    else bad(`expected a clean cap end, got ${s.end_reason} flags=[${s.flags.join(',')}]`)
    if (/AFK warn: slot 1/.test(A.out)) okmsg('the idle player was warned'); else bad('no AFK warning for the idle player')
    if (/AFK kick: slot 1/.test(A.out)) okmsg('the idle player was kicked; the active one was not'); else bad('no AFK kick for the idle player')
  }

  step('7. the replays verify')
  for (const box of ['box-a', 'box-b']) {
    const dir = path.join(RUN, box, 'replays')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.enwr'))) {
      const v = verifyFile(path.join(dir, f))
      if (v.ok) okmsg(`${box}/${f}: VALID — ${v.chunks} chunks, ${v.events} events, signed by ${v.keyId.slice(0, 8)}`)
      else bad(`${box}/${f}: ${v.errors.join('; ')}`)
    }
  }

  step('8. CPU and RAM per instance, as the boxes measured it')
  const s = await get('/admin/state')
  for (const b of s.boxes) for (const i of b.instances || []) {
    console.log(`       ${b.name} ${i.id} ${i.kind}  cpu avg ${i.usage.cores_avg == null ? '?' : i.usage.cores_avg.toFixed(3)} core  rss peak ${((i.usage.rss_peak_bytes || 0) / 1048576).toFixed(0)} MiB  (${i.usage.samples} samples)`)
  }
} catch (e) {
  bad(`demo threw: ${e.stack}`)
} finally {
  await stopAll()
  console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}demo finished with ${failures} failure(s)\x1b[0m`)
  console.log(`artifacts: ${RUN}`)
  process.exit(failures ? 1 : 0)
}

function readInstanceLogs(dir) {
  try { return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') } catch { return '' }
}
