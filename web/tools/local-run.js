#!/usr/bin/env node
'use strict'

// THE LAUNCHER'S HALF OF A LOCAL GAME, as a script.
//
// This is not a mock of the site — it drives the real site over HTTP exactly as the
// launcher will, so it doubles as the reference implementation of the launcher's side of
// `docs/protocol/launcher-v0.md` §6. `launcher`: read this, then delete it.
//
// What it does, in the order the launcher will do it:
//
//   1. sign in            (the launcher already has the session; here we post to /auth/mock)
//   2. POST /api/launcher/local/start   -> a match id, the map, and the account's settings
//   3. …the launcher installs the map and launches World at War with our DLL…
//   4. POST /api/launcher/local/live    -> frames, so a friend can watch on the site
//   5. POST /api/launcher/local/result  -> the referee's summary and the replay pointer
//
// Steps 3-5's *data* comes from a real host agent here: the script reads its dashboard
// (`/api/state`), relays the live frames, and posts the summary it produces. The launcher
// will instead run the game itself and read the same host agent on the same PC, which is
// the same data by a shorter path.
//
//   node tools/local-run.js --steamid 76561190000000001 --dash http://127.0.0.1:8797
//
// **Nothing this script sends is trusted.** It holds no box secret and cannot get one:
// every local endpoint is authenticated as the PLAYER, and the site stamps the result
// `self_reported`. That is the point — a player's PC must never be able to post as a box.

const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[String(process.argv[i]).replace(/^--/, '')] = process.argv[i + 1]

const SITE = (args.site || 'http://127.0.0.1:3200').replace(/\/$/, '')
const DASH = (args.dash || 'http://127.0.0.1:8797').replace(/\/$/, '')
const STEAMID = args.steamid || '76561190000000001'
const HZ = Number(args.hz || 4)

let cookie = ''

async function call(path, { method = 'GET', body = null, form = null } = {}) {
  const res = await fetch(SITE + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? JSON.stringify(body) : (form || undefined),
    redirect: 'manual',
  })
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const c of set) if (c.startsWith('zm.sid=')) cookie = c.split(';')[0]
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* redirect or html */ }
  if (!res.ok && res.status !== 302) throw new Error(`${method} ${path} -> ${res.status} ${(json && json.error) || text.slice(0, 160)}`)
  return json
}

const dash = async () => {
  const r = await fetch(`${DASH}/api/state`, { signal: AbortSignal.timeout(2500) })
  if (!r.ok) throw new Error(`host agent dashboard ${r.status}`)
  return r.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`site ${SITE}   host agent ${DASH}   player ${STEAMID}`)

  // 1. sign in
  await call('/auth/mock', { method: 'POST', form: `steam_id=${encodeURIComponent(STEAMID)}` })
  const me = await call('/api/me')
  if (!me.signed_in) throw new Error('sign-in failed')
  console.log(`signed in as ${me.user.name}`)

  // 2. what the launcher can do, and starting a local game
  const hello = await call('/api/launcher/hello')
  if (!hello.capabilities.local) throw new Error('this site does not support local games')

  // Wait for the host agent to have a game, and take its map so the two agree.
  let st = await dash()
  for (let i = 0; i < 60 && !st.instances.some((x) => x.game); i++) { await sleep(1000); st = await dash() }
  const inst = st.instances.find((x) => x.game)
  if (!inst) throw new Error('the host agent has no game running — start one first')
  const mapKey = inst.game.map

  const start = await call('/api/launcher/local/start', { method: 'POST', body: { map_key: mapKey } })
  console.log(`local game ${start.match_id} on ${start.map.title}`)
  console.log(`  ${start.notice}`)
  console.log(`  install known: ${start.map.install_known}${start.map.fs_game ? `, fs_game ${start.map.fs_game}` : ''}`)
  console.log(`  settings to apply: fov ${start.settings.fov}, max_fps ${start.settings.max_fps}`)
  console.log(`  watch it at ${SITE}/live/${start.match_id}`)

  // 3-4. the game runs; relay frames until it finishes
  let frames = 0
  let last = null
  for (;;) {
    let s
    try { s = await dash() } catch { await sleep(1000); continue }
    const i2 = s.instances.find((x) => x.id === inst.id)
    if (!i2) break
    if (i2.game && !i2.finished) {
      last = i2.game
      await call('/api/launcher/local/live', { method: 'POST', body: { match_id: start.match_id, state: i2.game } })
      frames++
      if (frames % 20 === 0) console.log(`  round ${i2.game.round}, ${i2.game.players.length} players, ${frames} frames relayed`)
    }
    const done = s.games.find((g) => g.summary && g.summary.instance === inst.id)
    if (done) {
      // 5. the result
      console.log(`game over: round ${done.summary.rounds}, ${done.summary.finish ? done.summary.finish.label : 'no finish'}`)
      const out = await call('/api/launcher/local/result', {
        method: 'POST',
        body: { summary: { ...done.summary, match_id: start.match_id }, replay: done.replay || null },
      })
      console.log(`stored: game ${out.game_id}, tracked=${out.tracked}`)
      console.log(`  ${out.notice}`)
      const g = await call(`/api/games/${start.match_id}`)
      console.log(`  site says: mode=${g.game.mode} records_eligible=${g.game.records_eligible} self_reported=${g.game.self_reported}`)
      const rp = await call(`/api/replays/${start.match_id}`).catch(() => null)
      if (rp) console.log(`  replay: ${rp.replay.grade} — ${rp.replay.reason}`)
      return
    }
    if (i2.finished) break
    await sleep(Math.round(1000 / HZ))
  }
  console.log(`the instance ended without a summary (${frames} frames relayed, last round ${last && last.round})`)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
