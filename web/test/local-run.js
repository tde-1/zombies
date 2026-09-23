#!/usr/bin/env node
'use strict'

// END-TO-END CHECKS FOR B's MVP: a player finishes one local run and the website shows it.
//
//   node test/local-run.js
//
// `test/run-all.js` drives the libraries in-process, which is the right shape for badge
// rules and board profiles. It cannot see any of the bugs this file is about, because all
// of them lived in the HTTP layer and in the state machine between three requests:
//
//   * a malformed body from a half-working launcher returning 500 instead of 400
//   * a round arriving as a string and being stored as NULL
//   * a result posted after the site restarted being answered "not your game"
//   * a retried result being answered "not your game"
//   * a run whose result never came leaving nothing behind at all
//
// So this one spawns the REAL server as a child process, on its own port, with its own
// `ZM_DATA_DIR`, and talks to it over HTTP exactly as the launcher does. It starts and
// stops only the process it spawned and it never touches the live instance on 3200.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const { freePort, waitHttp } = require('./_port')

// 33991 when it is free; any free port when it is not (bug 14: another worktree's run, or a
// leftover child, holding it). Picked in main(), before the first spawn.
let PORT = Number(process.env.ZM_TEST_PORT || 33991)
let SITE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve(__dirname, '..')
// Short, because a Windows path over 260 characters makes SQLite say SQLITE_CANTOPEN and
// the message names neither the path nor the length.
const TMP = fs.mkdtempSync(path.join(process.env.ZOMBIES_DEV || os.tmpdir(), 'zmlr-'))

let pass = 0
let fail = 0
const lines = []
const ok = (name) => { pass++; lines.push(['ok  ', name]) }
const bad = (name, msg) => { fail++; lines.push(['FAIL', `${name} — ${msg}`]) }
async function check(name, fn) {
  try { await fn(); ok(name) } catch (e) { bad(name, e.message) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

// ---- HTTP ---------------------------------------------------------------------------
let cookie = ''
async function call(p, { method = 'GET', body, form, anon = false, headers = {} } = {}) {
  const res = await fetch(SITE + p, {
    method,
    headers: {
      ...headers,
      ...(cookie && !anon ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : (form || undefined),
    redirect: 'manual',
  })
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const c of set) if (c.startsWith('zm.sid=')) cookie = c.split(';')[0]
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* html */ }
  return { status: res.status, json, text }
}

// ---- the server under test ------------------------------------------------------------
const env = {
  ...process.env,
  ZM_DATA_DIR: path.join(TMP, 'data'),
  ZM_KEY_DIR: path.join(TMP, 'keys'),
  ZM_REPLAY_DIR: path.join(TMP, 'replays'),
  ZM_PORT: String(PORT),
  ZM_HOST: '127.0.0.1',
  ZM_SITE_PASSWORD: '',
  NODE_ENV: 'development',
  // The test-only sign-in (routes/auth.js) — the mock page it replaced is gone — and no
  // call out to movement.enw.gg from a test.
  ZM_TEST_LOGIN: '1',
  ZM_MOVEMENT_URL: 'off', ZM_STEAM_AVATARS: 'off',
}
fs.mkdirSync(env.ZM_REPLAY_DIR, { recursive: true })

let child = null
let childErr = ''
function startServer() {
  childErr = ''
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => {
    childErr = (childErr + d).slice(-4000)
    if (process.env.ZM_TEST_VERBOSE) process.stderr.write(d)
  })
  return child
}
// Resolves when the PID we spawned has exited (or after 5 s), so a restart never races the
// old process for the port.
function stopServer() {
  const c = child
  child = null
  // Only ever the PID we spawned. `taskkill /IM node.exe` would take the live site with it.
  if (!c || !c.pid || c.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 5000)
    c.once('exit', () => { clearTimeout(t); resolve() })
    try { c.kill() } catch { clearTimeout(t); resolve() }
  })
}
// A long, jittered wait that notices a dead child. A child that died on EADDRINUSE (the old
// one still letting go of the port) is spawned again, a few times.
async function waitUp(timeoutMs = 90000) {
  const until = Date.now() + timeoutMs
  for (let tries = 0; ; tries++) {
    try {
      await waitHttp(SITE + '/api/launcher/hello', { timeoutMs: Math.max(1000, until - Date.now()), child, stderr: () => childErr })
      return
    } catch (e) {
      if (tries < 5 && /EADDRINUSE/.test(childErr) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)))
        startServer()
        continue
      }
      throw e
    }
  }
}
async function restart() {
  await stopServer()
  startServer()
  await waitUp()
}

const MAP = 'nazi_zombie_asylum'
const ME = '76561190000000001'

async function main() {
  PORT = await freePort(PORT)
  SITE = `http://127.0.0.1:${PORT}`
  env.ZM_PORT = String(PORT)

  // Seed the throwaway database the same way a real install does.
  await new Promise((resolve, reject) => {
    const s = spawn(process.execPath, [path.join(ROOT, 'server', 'db', 'seed.js'), '--demo'], { env, cwd: ROOT, stdio: 'ignore' })
    s.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('seed exited ' + c))))
    s.on('error', reject)
  })

  startServer()
  await waitUp()
  await call('/auth/test-login', { method: 'POST', form: `steam_id=${ME}` })
  const me = await call('/api/me')
  if (!me.json || !me.json.signed_in) throw new Error('could not sign in to the test server')

  // ══ 1. the endpoints refuse rubbish instead of storing it or crashing ══════════════

  await check('start refuses a body with no map, and a map that does not exist', async () => {
    eq((await call('/api/launcher/local/start', { method: 'POST', body: {} })).status, 400, 'no map')
    eq((await call('/api/launcher/local/start', { method: 'POST', body: { map_key: 'nope' } })).status, 400, 'unknown map')
    eq((await call('/api/launcher/local/start', { method: 'POST', body: { map_key: { a: 1 } } })).status, 400, 'object as a map key')
  })

  await check('start needs a session — there is no box secret that can stand in for one', async () => {
    const r = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP }, anon: true })
    eq(r.status, 401, 'anonymous start')
  })

  await check('a player session carrying x-match-secret is still only a player', async () => {
    // The box door and the player door are different doors. If this ever 200s, a player's
    // PC can post as a game box and every board on the site is whatever they type.
    const res = await fetch(SITE + '/api/gs/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-match-secret': 'devkey-a-guess' },
      body: JSON.stringify({ summary: { match_id: 'forged_1', map: MAP, rounds: 99 } }),
    })
    truthy(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`)
  })

  let match = null
  await check('a good start returns a match id the site chose', async () => {
    const r = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP } })
    eq(r.status, 200)
    truthy(/^l_[0-9a-f]{12}$/.test(r.json.match_id), 'match id shape: ' + r.json.match_id)
    eq(r.json.solo, true, 'local is solo')
    match = r.json.match_id
  })

  await check('live refuses a frame for somebody else’s match and a state that is not an object', async () => {
    eq((await call('/api/launcher/local/live', { method: 'POST', body: { match_id: 'l_000000000000', state: { round: 1 } } })).status, 404, 'not mine')
    eq((await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match, state: 'hello' } })).status, 400, 'string state')
    eq((await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match } })).status, 400, 'no state')
  })

  await check('a live frame records the highest round seen', async () => {
    let r = await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match, state: { round: 5, players: [] } } })
    eq(r.status, 200)
    eq(r.json.round, 5, 'round after one frame')
    // Frames are downsampled, but the round is recorded from every one of them.
    r = await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match, state: { round: 9, players: [] } } })
    eq(r.json.round, 9, 'round after a later frame')
    // A round that goes backwards (a reconnect, a bad read) never lowers it.
    r = await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match, state: { round: 2, players: [] } } })
    eq(r.json.round, 9, 'round never goes down')
  })

  await check('result never 500s on a malformed body', async () => {
    eq((await call('/api/launcher/local/result', { method: 'POST', body: {} })).status, 400, 'no summary')
    eq((await call('/api/launcher/local/result', { method: 'POST', body: { summary: 'hello' } })).status, 400, 'summary is a string')
    eq((await call('/api/launcher/local/result', { method: 'POST', body: { summary: { match_id: match, players: 'me' } } })).status, 400, 'players is a string')
    eq((await call('/api/launcher/local/result', { method: 'POST', body: { summary: { match_id: 'l_000000000000' } } })).status, 404, 'not my match')
  })

  // ══ 2. THE RUN. B's sentence, as a test. ═══════════════════════════════════════════

  const REPLAY = 'mvp_test.enwr'
  fs.writeFileSync(path.join(env.ZM_REPLAY_DIR, REPLAY), Buffer.alloc(4096, 7))

  await check('a finished run is stored with its round, as a number, on the right map', async () => {
    const r = await call('/api/launcher/local/result', {
      method: 'POST',
      body: {
        summary: {
          match_id: match,
          // The launcher does not name the map — the site knows it from `start`.
          rounds: 23,
          finish: { kind: 'round', label: 'Round 23' },
          duration_ms: 2_400_000,
          players: [{ slot: 0, steamid: ME, name: 'Dexter', stats: { kills: 412, headshots: 180 } }],
          started_at: new Date(Date.now() - 2_400_000).toISOString(),
          ended_at: new Date().toISOString(),
          end_reason: 'game_over',
        },
        replay: { file: REPLAY, size: 4096, chunks: 3, events: 900 },
      },
    })
    eq(r.status, 200)
    eq(r.json.tracked, false, 'a local game is never tracked')
    eq(r.json.stored.rounds, 23, 'the round the site stored')
    eq(r.json.stored.map_key, MAP, 'the map the site stored')
  })

  await check('a round sent as a string is a number or a refusal — never a stored NULL', async () => {
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP } })
    await call('/api/launcher/local/result', {
      method: 'POST',
      body: { summary: { match_id: s.json.match_id, rounds: 'abc', players: [{ steamid: ME }] } },
    })
    const g = await call('/api/games/' + s.json.match_id)
    eq(g.status, 200, 'the game exists')
    eq(typeof g.json.game.rounds, 'number', 'rounds is a number')
    eq(g.json.game.rounds, 0, 'an unreadable round is zero, not null')
    // And a numeric string still parses, because a box is allowed to be sloppy about types.
    const s2 = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: 'nazi_zombie_sumpf' } })
    await call('/api/launcher/local/result', {
      method: 'POST',
      body: { summary: { match_id: s2.json.match_id, rounds: '17', players: [{ steamid: ME }] } },
    })
    eq((await call('/api/games/' + s2.json.match_id)).json.game.rounds, 17, 'a numeric string parses')
  })

  await check('the site shows the run: game page, map page, profile', async () => {
    const g = await call('/api/games/' + match)
    eq(g.status, 200, 'the game detail route')
    eq(g.json.game.rounds, 23, 'the round it reached')
    eq(g.json.game.map_key, MAP, 'the map')
    eq(g.json.game.map_title, 'Verruckt', 'the map title')
    eq(g.json.game.self_reported, true, 'marked self-reported')
    eq(g.json.game.records_eligible, false, 'and worth nothing')
    eq(g.json.game.demo, false, 'and not demo scaffolding')
    truthy(g.json.game.players.some((p) => p.steam_id === ME), 'the player is on it')

    const m = await call('/api/maps/' + MAP)
    truthy((m.json.recent || []).some((x) => x.match_id === match), 'on the map page')

    const p = await call('/api/players/' + ME)
    truthy((p.json.recent || []).some((x) => x.match_id === match), 'on the profile')
  })

  // This asserted the opposite until 2026-09-21. A self-reported finish earns no badge and
  // can hold no record, so keeping it out of a records-and-badges feed was defensible — but
  // during the closed beta it is the only kind of finish that exists, and a home page that
  // never changes while four people play all evening reads as broken. So it goes in,
  // carrying the flag that says what it is. The flag is the part worth testing: without it
  // the client cannot tell a local run from a refereed one, which is the failure that
  // decision would actually cause.
  await check('a self-reported run reaches the home feed, flagged as self-reported', async () => {
    const h = await call('/api/home')
    const mine = (h.json.feed || []).filter((f) => f.map && f.map.key === MAP && /Round 23/.test(f.text || ''))
    eq(mine.length, 1, 'one feed line for the local finish')
    eq(mine[0].data && mine[0].data.self_reported, true, 'flagged self_reported')
    eq(mine[0].data && mine[0].data.rounds, 23, 'carries the round it reached')
  })

  await check('the run is visible to a signed-out visitor too', async () => {
    const g = await call('/api/games/' + match, { anon: true })
    eq(g.status, 200)
    eq(g.json.game.rounds, 23)
  })

  await check('a local run does not become a best round or a record', async () => {
    const p = await call('/api/players/' + ME)
    const shelf = (p.json.shelf || []).find((s) => s.map_key === MAP || s.key === MAP)
    if (shelf) eq(Number(shelf.best_round || 0), 0, 'best_round on the shelf')
    const board = await call('/api/records')
    const mine = JSON.stringify(board.json).includes(match)
    eq(mine, false, 'the match is on no board')
  })

  // ══ 3. the state machine is total ══════════════════════════════════════════════════

  await check('posting the same result twice is a repeat, not a rejection', async () => {
    const r = await call('/api/launcher/local/result', {
      method: 'POST',
      body: { summary: { match_id: match, rounds: 23, players: [{ steamid: ME }] } },
    })
    eq(r.status, 200, 'the retry is accepted')
    eq(r.json.repeat, true, 'and says it is a repeat')
    const g = await call('/api/games/' + match)
    eq(g.json.game.rounds, 23, 'the round did not move')
    eq(g.json.game.players.length, 1, 'no second player row')
  })

  await check('a live frame for a finished match is refused', async () => {
    const r = await call('/api/launcher/local/live', { method: 'POST', body: { match_id: match, state: { round: 99 } } })
    eq(r.status, 409, 'a finished game takes no more frames')
  })

  let survivor = null
  await check('THE RESTART: a run in flight when the site restarts is not lost', async () => {
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP } })
    survivor = s.json.match_id
    await call('/api/launcher/local/live', { method: 'POST', body: { match_id: survivor, state: { round: 12 } } })

    await restart()

    // The session is in SQLite and the match is in SQLite, so both survive.
    const still = await call('/api/launcher/local/' + survivor)
    eq(still.status, 200, 'the match is still there after a restart')
    eq(still.json.match.round, 12, 'and remembers the round the frames reported')

    const r = await call('/api/launcher/local/result', {
      method: 'POST',
      body: { summary: { match_id: survivor, rounds: 31, players: [{ steamid: ME, name: 'Dexter' }], duration_ms: 3_000_000 } },
    })
    eq(r.status, 200, 'the result is accepted after the restart')
    eq(r.json.stored.rounds, 31, 'with its round')
  })

  await check('a restarted launcher can find the match it lost', async () => {
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: 'nazi_zombie_prototype' } })
    const list = await call('/api/launcher/local')
    truthy(list.json.matches.some((x) => x.match_id === s.json.match_id), 'listed as in flight')
    // Asking to start the same map again resumes rather than orphaning the first one.
    const again = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: 'nazi_zombie_prototype' } })
    eq(again.json.match_id, s.json.match_id, 'the same match')
    eq(again.json.resumed, true, 'and it says so')
    // Clean it up so it does not sit live into the next check.
    await call('/api/launcher/local/result', { method: 'POST', body: { summary: { match_id: s.json.match_id, rounds: 1, players: [{ steamid: ME }] } } })
  })

  await check('nobody else can see or steer my local match', async () => {
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP } })
    const mineId = s.json.match_id
    const mineCookie = cookie
    cookie = ''
    await call('/auth/test-login', { method: 'POST', form: 'steam_id=76561190000000002' })
    eq((await call('/api/launcher/local/' + mineId)).status, 404, 'not visible')
    eq((await call('/api/launcher/local/live', { method: 'POST', body: { match_id: mineId, state: { round: 50 } } })).status, 404, 'no frames')
    eq((await call('/api/launcher/local/result', { method: 'POST', body: { summary: { match_id: mineId, rounds: 50, players: [{ steamid: '76561190000000002' }] } } })).status, 404, 'no result')
    cookie = mineCookie
  })

  await check('THE CRASH: a run that never posts a result is still logged, marked as such', async () => {
    // Drive the sweep directly against the same database rather than waiting twenty
    // minutes: the state machine is the thing under test, not the clock.
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: 'nazi_zombie_ali' } })
    const lost = s.json.match_id
    await call('/api/launcher/local/live', { method: 'POST', body: { match_id: lost, state: { round: 18 } } })

    await stopServer()
    const prevData = process.env.ZM_DATA_DIR
    process.env.ZM_DATA_DIR = env.ZM_DATA_DIR
    delete require.cache[require.resolve('../server/db/database')]
    const { db } = require('../server/db/database')
    db.prepare('UPDATE local_matches SET last_seen=? WHERE match_id=?').run(Date.now() - 60 * 60_000, lost)
    const localMatches = require('../server/lib/localMatches')
    const swept = localMatches.sweep()
    truthy(swept.abandoned >= 1, 'the sweep closed it')
    truthy(swept.recovered >= 1, 'and wrote the run')
    const row = db.prepare('SELECT * FROM local_matches WHERE match_id=?').get(lost)
    eq(row.state, 'abandoned', 'the match is not still live')
    const game = db.prepare('SELECT * FROM games WHERE match_id=?').get(lost)
    truthy(game, 'a game row exists for the lost run')
    eq(game.rounds, 18, 'with the round the frames reached')
    eq(game.end_reason, 'abandoned', 'and says why it stopped')
    eq(game.self_reported, 1, 'and is self-reported')
    truthy(JSON.parse(game.flags).includes('frames_only'), 'and says where the number came from')
    db.close()
    delete require.cache[require.resolve('../server/db/database')]
    delete require.cache[require.resolve('../server/lib/localMatches')]
    delete require.cache[require.resolve('../server/lib/results')]
    if (prevData === undefined) delete process.env.ZM_DATA_DIR; else process.env.ZM_DATA_DIR = prevData

    startServer()
    await waitUp()
    // And the late result, if it ever turns up, replaces the placeholder.
    const r = await call('/api/launcher/local/result', {
      method: 'POST',
      body: { summary: { match_id: lost, rounds: 21, finish: { kind: 'round', label: 'Round 21' }, players: [{ steamid: ME }] } },
    })
    eq(r.status, 200, 'a late result is accepted')
    const g = await call('/api/games/' + lost)
    eq(g.json.game.rounds, 21, 'and supersedes the frames-only number')
    eq(g.json.game.abandoned, false, 'and is no longer abandoned')
  })

  // ══ 4. replays are grabbable ═══════════════════════════════════════════════════════

  await check('the replay pointer is stored and described, with the reason it is not evidence', async () => {
    const r = await call('/api/replays/' + match)
    eq(r.status, 200)
    eq(r.json.replay.available, true, 'the file is findable')
    eq(r.json.replay.size, 4096, 'the size the launcher reported')
    eq(r.json.replay.grade, 'local', 'a local replay is never record evidence')
    eq(r.json.replay.ok, false)
    truthy(r.json.replay.reason.length > 10, 'and says why')
  })

  await check('I can download my own replay, byte for byte', async () => {
    const res = await fetch(SITE + `/api/replays/${match}/download`, { headers: { cookie } })
    eq(res.status, 200)
    const buf = Buffer.from(await res.arrayBuffer())
    eq(buf.length, 4096, 'the byte count')
    eq(buf[0], 7, 'the bytes')
    truthy(String(res.headers.get('content-disposition') || '').includes('.enwr'), 'served as a file')
  })

  await check('somebody else cannot download it, and is told the rule rather than a 404', async () => {
    const mineCookie = cookie
    cookie = ''
    await call('/auth/test-login', { method: 'POST', form: 'steam_id=76561190000000004' })
    const res = await fetch(SITE + `/api/replays/${match}/download`, { headers: { cookie } })
    eq(res.status, 403, 'refused')
    const j = await res.json()
    truthy(/VIP|public/.test(j.error), 'and the reason names the rule: ' + j.error)
    // The grade and the pointer stay public, because a record nobody can check is no record.
    eq((await call('/api/replays/' + match)).status, 200, 'the description is still public')
    cookie = mineCookie
  })

  await check('a path from a client cannot escape the replay directory', async () => {
    const s = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: MAP } })
    await call('/api/launcher/local/result', {
      method: 'POST',
      body: {
        summary: { match_id: s.json.match_id, rounds: 3, players: [{ steamid: ME }] },
        replay: { file: '..\\..\\..\\Windows\\win.ini', size: 10 },
      },
    })
    const r = await call('/api/replays/' + s.json.match_id)
    eq(r.json.replay.available, false, 'nothing outside the replay directory is servable')
    const res = await fetch(SITE + `/api/replays/${s.json.match_id}/download`, { headers: { cookie } })
    truthy(res.status !== 200, `download must not succeed, got ${res.status}`)
  })

  await check('the launcher is told replay downloads exist, because they do', async () => {
    const h = await call('/api/launcher/hello')
    eq(h.json.capabilities.replay_downloads, true)
  })

  // ══ 5. the demo data does not lie ══════════════════════════════════════════════════

  await check('every seeded game is marked demo and every real one is not', async () => {
    const g = await call('/api/games/demo_1')
    eq(g.status, 200, 'the demo games have fixed ids')
    eq(g.json.game.demo, true, 'and are marked')
    eq((await call('/api/games/' + match)).json.game.demo, false, 'a real run is not')
  })

  await check('the backfill finds every seeded game and no real one', async () => {
    // The migration only runs this when it creates the column, which on a fresh database
    // is before any game exists. B's live site is the case it is for: six seeded games
    // already sitting there in the shape of a real one. So the predicate is tested here
    // directly — unmark everything, run it, and see what it picks up.
    await stopServer()
    const prevData = process.env.ZM_DATA_DIR
    process.env.ZM_DATA_DIR = env.ZM_DATA_DIR
    delete require.cache[require.resolve('../server/db/database')]
    const { db, markSeededDemoGames } = require('../server/db/database')
    db.prepare('UPDATE games SET demo=0').run()
    const n = markSeededDemoGames()
    eq(n, 6, 'six seeded games marked')
    const marked = db.prepare('SELECT match_id FROM games WHERE demo=1').all().map((g) => g.match_id)
    eq(marked.every((id) => id.startsWith('demo_')), true, 'and only the seeded ones: ' + marked.join(', '))
    eq(db.prepare('SELECT demo FROM games WHERE match_id=?').get(match).demo, 0, 'the real run stays unmarked')
    db.close()
    delete require.cache[require.resolve('../server/db/database')]
    for (const m of ['../server/lib/localMatches', '../server/lib/results']) delete require.cache[require.resolve(m)]
    if (prevData === undefined) delete process.env.ZM_DATA_DIR; else process.env.ZM_DATA_DIR = prevData
    startServer()
    await waitUp()
  })

  await check('re-seeding demo content on a database with real games refuses', async () => {
    const out = await new Promise((resolve) => {
      let s = ''
      const p = spawn(process.execPath, [path.join(ROOT, 'server', 'db', 'seed.js'), '--demo'], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.on('data', (d) => { s += d })
      p.on('exit', () => resolve(s))
    })
    truthy(/SKIPPED/.test(out), 'it says it skipped: ' + out.split('\n').filter((l) => /demo/.test(l)).join(' | '))
    const all = await call('/api/games/demo_1')
    eq(all.json.game.demo, true, 'and the demo rows are unchanged')
  })

  // ── the play gate: is this browser the launcher's browser? ─────────────────────────
  //
  // B, 2026-09-22: a Play button pressed in a PLAIN browser must go to /download instead,
  // because nothing in a browser tab can start World at War. The client half of that is
  // `components/playGate.js`; this is the signal it reads, and it is the one that works
  // before any client JS has run — the header the launcher's wrapped view stamps on every
  // request it makes (`launcher/src/main/main.js`, offered to us in launcher-v0.md
  // §"Still open for you").
  //
  // Both directions matter. A site that never says `launcher: true` sends the launcher's
  // own users to a download page for software they are already inside; a site that says it
  // too readily lets a plain browser press Play and fail silently, which is what this
  // replaces.
  await check('/api/me says `launcher: false` to an ordinary browser', async () => {
    const r = await call('/api/me')
    eq(r.status, 200)
    eq(r.json.launcher, false, 'a plain browser was taken for the launcher')
  })

  await check('/api/me says `launcher: true` to a request carrying X-ENW-Launcher', async () => {
    const r = await call('/api/me', { headers: { 'x-enw-launcher': '0.2.0' } })
    eq(r.json.launcher, true, 'the launcher header was not read')
    eq(r.json.launcher_version, '0.2.0', 'the version was not carried')
  })

  await check('the launcher signal reaches a signed-out visitor too', async () => {
    // The gate has to answer before sign-in: the party panel's signed-out state and the map
    // page both draw a Play affordance to somebody with no session.
    const r = await call('/api/me', { anon: true, headers: { 'x-enw-launcher': '0.2.0' } })
    eq(r.json.signed_in, false, 'the anon call was not anonymous')
    eq(r.json.launcher, true, 'a signed-out launcher was taken for a browser')
  })

  await check('a header claiming to be a novel-length version is cut down, not stored whole', async () => {
    const r = await call('/api/me', { headers: { 'x-enw-launcher': 'x'.repeat(500) } })
    eq(r.json.launcher, true)
    eq(r.json.launcher_version.length, 32, 'an unbounded header value was echoed back')
  })

  // ---- the chat dock's two doors ------------------------------------------------------

  await check('the system-line door is the BOX door, and a player session is not a key to it', async () => {
    // Same reasoning as /api/gs/result above: if this ever 200s, anybody with an account
    // can write "<somebody> just went down on round 40" into a channel everybody reads.
    const res = await fetch(SITE + '/api/gs/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-match-secret': 'devkey-a-guess' },
      body: JSON.stringify({ event: 'started', name: 'forged', map: MAP }),
    })
    truthy(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`)
  })

  await check('the chat ring is readable signed out, and a line says which kind it is', async () => {
    // The dock is on every page including the ones a stranger sees, so the fill must not
    // need a session. Talking does (the socket checks it); reading does not.
    const r = await call('/api/chat?limit=5', { anon: true })
    eq(r.status, 200)
    truthy(Array.isArray(r.json.chat), 'a list came back')
    truthy(r.json.chat.every((l) => l.kind === 'chat' || l.kind === 'system'), 'every line is one of the two kinds')
  })

  // ---- the name gate (2026-09-22, B: Steam sign-in AND an ENW username) ---------------
  //
  // A fresh SteamID, through the real HTTP stack: forced to the picker, refused everything
  // else, told Movement's words for each rule, and named once it picks.
  {
    const mine = cookie
    cookie = ''
    const FRESH = '76561198999000123'
    await call('/auth/test-login', { method: 'POST', form: `steam_id=${FRESH}` })

    await check('a fresh Steam account is signed in but must choose an ENW username first', async () => {
      const me = await call('/api/me')
      eq(me.json.signed_in, true, 'not signed in')
      eq(me.json.needs_name, true, 'a nameless account was not sent to the picker')
      eq(me.json.user.name, FRESH, 'a nameless account shows something other than its SteamID')
    })

    await check('...and until it does, the site refuses it everything but the picker', async () => {
      for (const [p, method, body] of [
        ['/api/me/settings', 'PUT', { fov: 90 }],
        ['/api/launcher/local/start', 'POST', { map_key: MAP }],
        ['/api/me/settings', 'GET', undefined],
      ]) {
        const r = await call(p, { method, body })
        eq(r.status, 403, `${method} ${p}`)
        eq(r.json.needs_name, true, `${method} ${p} did not say why`)
      }
    })

    await check('the picker answers in Movement’s words (drops.ws usernameRules.js)', async () => {
      const want = {
        ab: 'Username must be at least 3 characters',
        [`${'x'.repeat(21)}`]: 'Username must be 20 characters or fewer',
        'has space': 'Username can only contain letters, numbers, underscores and hyphens',
        '2026-09-22x': 'Invalid username',
        12345: 'Usernames cannot be only numbers',
      }
      for (const [name, msg] of Object.entries(want)) {
        const r = await call('/api/me/username', { method: 'POST', body: { username: name } })
        eq(r.status, 400, `"${name}"`)
        eq(r.json.error, msg, `"${name}"`)
      }
      const blocked = await call('/api/me/username', { method: 'POST', body: { username: 'admin' } })
      eq(blocked.status, 409, 'a drops.ws-reserved name')
      eq(blocked.json.error, 'That username is not available')
      // The demo seed's Jamie holds "Jamie": case-insensitive, like drops.ws's NOCASE index.
      // (Not Dexter: "dexter" is on drops.ws's blocklist as a CS pro's handle.)
      const taken = await call('/api/me/username', { method: 'POST', body: { username: 'JAMIE' } })
      eq(taken.status, 409, 'a case-variant of a held name')
      eq(taken.json.error, 'That username is already taken')
      const chk = await call('/api/me/username/check?username=admin')
      eq(chk.json.reason, 'blocked', 'the live check does not say blocked')
    })

    await check('a good name is taken once, and /api/me then carries it as the name', async () => {
      const r = await call('/api/me/username', { method: 'POST', body: { username: 'fresh-player' } })
      eq(r.status, 200, 'the claim failed: ' + JSON.stringify(r.json))
      const me = await call('/api/me')
      eq(me.json.needs_name, false, 'still asked for a name')
      eq(me.json.user.name, 'fresh-player', '/api/me name')
      eq(me.json.user.enw_name, 'fresh-player', '/api/me enw_name')
      const again = await call('/api/me/username', { method: 'POST', body: { username: 'another-one' } })
      eq(again.status, 409, 'set-once')
      eq(again.json.error, 'You already have a username')
      eq((await call('/api/me/settings', { method: 'PUT', body: { fov: 90 } })).status, 200, 'still gated after naming')
      const hello = await call('/api/launcher/hello')
      eq(hello.json.you.name, 'fresh-player', 'the launcher would put something else behind +set name')
      eq(hello.json.needs_name, false)
    })
    cookie = mine
  }

  // ══ the profile (2026-09-22): Movement's comment wall, Top/Recent maps, Overall ══════════
  {
    const mine = cookie
    const meNow = await call('/api/me')
    const meStaff = !!(meNow.json.user.mod || meNow.json.user.admin)
    const prof = await call('/api/players/' + ME)
    await check('a profile carries Top/Recent maps, Overall and the Movement block', async () => {
      eq(prof.status, 200, 'profile')
      truthy(prof.json.maps && Array.isArray(prof.json.maps.top) && Array.isArray(prof.json.maps.recent), 'maps.top / maps.recent')
      truthy(prof.json.overall && typeof prof.json.overall.games === 'number', 'overall.games')
      truthy('member_since' in prof.json.overall, 'overall.member_since')
      eq(prof.json.movement.found, false, 'ZM_MOVEMENT_URL=off means no Movement data')
      eq(prof.json.movement.banner, null, 'and no banner')
    })

    cookie = ''
    await call('/auth/test-login', { method: 'POST', form: 'steam_id=76561198999000124' })
    await call('/api/me/username', { method: 'POST', body: { username: 'wall-poster' } })
    let cid = null
    await check('profile comments: anyone signed in posts; the answer is the row, marked mine', async () => {
      const r = await call(`/api/players/${ME}/comments`, { method: 'POST', body: { body: 'see you on round 30' } })
      eq(r.status, 200, 'post: ' + JSON.stringify(r.json))
      cid = r.json.comment.id
      eq(r.json.comment.mine, true, 'mine')
      eq(r.json.comment.can_remove, true, 'can remove own')
      eq(r.json.comment.username, 'wall-poster', 'the ENW name')
      const anon = await call(`/api/players/${ME}/comments`, { anon: true })
      eq(anon.status, 200, 'the wall reads signed out')
      truthy(anon.json.comments.some((c) => c.id === cid && !c.mine && !c.can_remove), 'a visitor sees it, and no delete')
    })
    cookie = mine
    await check('profile comments: somebody else’s post is not yours to delete, unless you are staff', async () => {
      const g = await call(`/api/players/${ME}/comments`)
      const c = g.json.comments.find((x) => x.id === cid)
      eq(c.mine, false, 'not mine')
      eq(c.can_remove, meStaff, 'can_remove follows staff')
      if (!meStaff) eq((await call(`/api/players/${ME}/comments/${cid}`, { method: 'DELETE' })).status, 403, 'refused')
    })
    cookie = ''
    await call('/auth/test-login', { method: 'POST', form: 'steam_id=76561198999000124' })
    await check('profile comments: the author deletes their own, and it is gone from the wall', async () => {
      eq((await call(`/api/players/${ME}/comments/${cid}`, { method: 'DELETE' })).status, 200, 'delete own')
      const g = await call(`/api/players/${ME}/comments`)
      eq(g.json.comments.some((x) => x.id === cid), false, 'still listed')
      eq((await call(`/api/players/${ME}/comments/${cid}`, { method: 'DELETE' })).status, 404, 'twice is a 404')
    })
    cookie = mine
  }

  // ---- report -------------------------------------------------------------------------
  for (const [s, n] of lines) console.log(`${s}  ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
}

main()
  .catch((e) => { console.error(e); fail++ })
  .finally(() => {
    stopServer()
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* windows file lock */ }
      process.exit(fail ? 1 : 0)
    }, 300)
  })
