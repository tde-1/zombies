#!/usr/bin/env node
// The vertical slice, driven from the launcher's own modules.
//
//   sign in -> pick an archived custom map -> install it -> launch World at War with
//   our DLL -> relay live frames to the site while it runs -> post the referee's
//   summary and the signed replay -> show the site refusing to count it.
//
// It uses the same code the Electron app uses (`SiteApi`, `library`, `GameLaunch`,
// `LocalRun`); the only thing it stands in for is the click. Run it with the app's own
// smoke harness (`ENW_SLICE=1 npx electron .`) to have the real app do it instead.
//
//   node test/slice.js --map nazi_zombie_leviathan --seconds 240
//
// It takes the game lock, launches one game, and releases. No box secret is used
// anywhere: every site call is the player's own session cookie.
import path from 'node:path'
import { SiteApi } from '../src/main/siteapi.js'
import { LocalRun } from '../src/main/localrun.js'
import * as library from '../src/main/library.js'
import { BootFlow } from '../src/main/bootflow.js'
import { P } from '../src/main/paths.js'
import * as lock from '../src/main/gamelock.js'

const argv = process.argv.slice(2)
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }
const has = (f) => argv.includes(f)

const SITE = val('--site', 'http://127.0.0.1:3200')
const DASH = val('--dash', 'http://127.0.0.1:8787')
const LINK = val('--link', '127.0.0.1:38700')
const MAP = val('--map', 'nazi_zombie_leviathan')
const SECONDS = Number(val('--seconds', '240'))
const say = (...a) => console.log(...a)
const step = (n, t) => say(`\n${n}. ${t}\n${'-'.repeat(t.length + 3)}`)

// A cookie jar for the CLI. In the app this is the wrapped page's session; here we
// sign in through the site's own mock endpoint, which is the same session either way.
// `/auth/mock` is a FORM post with a steam_id, not JSON — and it answers with a 302,
// so `redirect: 'manual'` is what lets us read the Set-Cookie.
let JAR = ''
const STEAMID = val('--steamid', '76561198126330106')
async function signIn() {
  const res = await fetch(`${SITE}/auth/mock`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `steam_id=${encodeURIComponent(STEAMID)}`,
  })
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith('zm.sid=')) JAR = c.split(';')[0]
  }
  if (!JAR) throw new Error(`no session cookie from /auth/mock (${res.status})`)
  return JAR
}

const api = new SiteApi({ baseUrl: SITE, cookieProvider: async () => JAR, appVersion: 'slice' })

async function main() {
  step(1, 'Sign in')
  await signIn()
  const hello = await api.sayHello()
  if (!hello.you) throw new Error('mock sign-in did not produce a session')
  say(`   signed in as ${hello.you.name} (${hello.you.steam_id})`)
  say(`   site protocol ${hello.protocol}, auth ${hello.auth}, local games ${hello.capabilities.local ? 'supported' : 'NOT supported'}`)

  step(2, 'Pick an archived custom map')
  const cat = library.catalogue()
  const m = cat.maps.find((x) => x.bsp === MAP)
  if (!m) throw new Error(`no map ${MAP} in the archive`)
  say(`   ${m.title}  (bsp ${m.bsp})${m.author ? ` by ${m.author}` : ''}`)
  say(`   ${(m.bytes / 1e6).toFixed(0)} MB, ${m.files} files, hashes ${m.verifiable ? 'known' : 'unknown'}`)

  step(3, 'Install it')
  if (library.isInstalled(m.bsp)) {
    say(`   already installed at ${library.installDir(m.bsp)}`)
  } else {
    const rec = library.install(m.bsp, { onProgress: () => {} })
    say(`   ${rec.files.length} files, ${(rec.bytes / 1e6).toFixed(0)} MB, every hash checked: ${rec.verified}`)
    for (const p of rec.problems || []) say(`   repair: ${p}`)
  }
  say(`   installed to ${library.installDir(m.bsp)}`)
  say('   (World at War loads custom maps from there and nowhere else — dedi)')

  step(4, 'Tell the site a local game is starting')
  const run = new LocalRun({ api, dashUrl: DASH })
  const started = await run.start(m.bsp)
  say(`   match ${started.match_id}`)
  say(`   ${started.notice}`)
  say(`   watch it at ${SITE}/live/${started.match_id}`)

  step(5, 'Register the game with the local host agent, then launch')
  // The box matches the game's `hello` against something it was told to expect, so
  // this has to happen BEFORE the spawn — and it hands back the link address, so we
  // do not guess a port.
  const exp = await run.expect({ instance: started.match_id, matchId: started.match_id, map: m.bsp })
  say(`   the box expects instance ${exp.instance} and will listen on ${exp.link}`)
  const flow = new BootFlow({
    map: m.bsp,
    localMap: m.bsp,
    fsGame: m.fsGame,
    installDir: library.installDir(m.bsp),
    // On screen: off-screen and unfocused, the tick dies at ~65 s (referee).
    windowMode: 'small',
    linkHost: exp.link,
    instance: started.match_id,
    useGameLock: !has('--no-lock'),
    lockName: 'launcher',
    connectTimeoutMs: 120000,
    nannySeconds: SECONDS + 60,
    settings: { fov: started.settings?.fov ?? 80, maxFps: started.settings?.max_fps ?? 125 },
  })
  flow.on('step', (s) => say(`   [${s.state.padEnd(6)}] ${s.label}: ${s.detail}`))

  const relay = run.relayUntilDone({ timeoutMs: SECONDS * 1000 })
  run.on('frame', (f) => { if (f.n === 1 || f.n % 25 === 0) say(`   relayed ${f.n} frames (round ${f.round}, ${f.players} player(s))`) })

  await flow.run()

  step(6, 'Relay live frames, then the result')
  const out = await relay
  run.stop()
  if (!out.ok) say(`   ${out.reason} (${out.frames} frames relayed${out.lastRound != null ? `, last round ${out.lastRound}` : ''})`)
  else {
    say(`   ${out.frames} frames relayed while it ran`)
    say(`   stored as game ${out.stored.game_id}, tracked=${out.stored.tracked}`)
    say(`   ${out.stored.notice}`)
  }

  step(7, 'What the site says it counts for')
  const v = await run.verdict()
  if (v?.game) {
    const g = v.game
    say(`   mode=${g.mode}  records_eligible=${g.records_eligible}  xp_multiplier=${g.xp_multiplier ?? 0}  self_reported=${g.self_reported}`)
    say(`   -> ${Number(g.records_eligible) ? 'ELIGIBLE (WRONG)' : 'no records, no XP, no badges — correct for a local game'}`)
  } else say('   the site has no game row yet')
  if (v?.replay) say(`   replay: ${v.replay.grade} — ${v.replay.reason}`)

  try { flow.launch?.stop('slice finished') } catch {}
  say(`\ngame lock now: ${JSON.stringify(lock.read())}`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\nFAILED: ${e.message}`)
  try { lock.release('launcher') } catch {}
  process.exit(1)
})
