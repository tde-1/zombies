#!/usr/bin/env node
// `npm run smoke` — the four questions we spent an afternoon answering by log archaeology.
//
// On 2026-09-21 B's packaged launcher said "client: not installed" while
// `setup-cli.js status` on the same machine printed "Installed: yes". Four separate
// things were true at once and none of them were visible:
//
//   1. THE TWO COMMANDS WERE READING DIFFERENT FOLDERS. Agents run inside the Claude
//      desktop app's MSIX container, where writes under %LOCALAPPDATA% are redirected
//      into ...\Packages\<pkg>\LocalCache\Local\. Every `setup install` an agent ran
//      installed the client into a private copy that B's launcher cannot see, and every
//      `setup status` an agent ran then confirmed it. `--sandbox` below is the check
//      that catches it: write a file, then look for it at the redirected path.
//   2. THE LOG WAS NOT BEING WRITTEN and said nothing about it (an empty `catch`).
//   3. A SECOND INSTANCE EXITED IN 177 ms WITH NO OUTPUT, so a smoke run against an
//      already-running launcher looked identical to a launcher that does not log.
//   4. The site the launcher was pinned to had gone, and `/auth/mode` had changed under
//      us from `mock` to `steam`.
//
// Nothing here launches the game, takes the game lock, or needs Electron.
//
//   node tools/smoke.js                 every check
//   node tools/smoke.js --json          machine-readable
//   node tools/smoke.js --site https://zombies.enw.gg --password CrazyTime
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { P, ENW_ROOT } from '../src/main/paths.js'
import * as setup from '../src/main/setup.js'
import * as cfg from '../src/main/config.js'
import { dirOfModule } from '../src/main/paths.js'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : (args.includes(`--${name}`) ? true : fallback)
}
const JSON_OUT = args.includes('--json')

const results = []
const check = (name, fn) => results.push({ name, fn })
const ok = (detail) => ({ ok: true, detail })
const bad = (detail) => ({ ok: false, detail })
const warn = (detail) => ({ ok: true, warn: true, detail })

// ---------------------------------------------------------------- the checks --

// 1. Where are we, and is it the same "there" everybody else means?
check('paths: the ENW folder resolves', () => {
  const lines = [`root ${ENW_ROOT}`, `game ${P.game}`, `maps ${P.maps}`]
  if (process.env.ENW_ROOT) lines.push(`(ENW_ROOT is set in the environment)`)
  return fs.existsSync(ENW_ROOT) ? ok(lines.join(' | ')) : bad(`${ENW_ROOT} does not exist — nothing has ever been installed here`)
})

// 2. THE ONE THAT WOULD HAVE SAVED THE AFTERNOON.
//
// Under MSIX (the Claude desktop app, the Store build of anything) a write to
// %LOCALAPPDATA%\X lands in %LOCALAPPDATA%\Packages\<pkg>\LocalCache\Local\X and reads
// come back from there too, so the process cannot tell by looking. The only reliable
// test is to write a file and then ask whether it turned up at the redirected path,
// which is an ordinary folder that is NOT itself redirected.
check('sandbox: this process writes to the real %LOCALAPPDATA%', () => {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const probe = path.join(ENW_ROOT, `.smoke-${process.pid}`)
  try { fs.mkdirSync(ENW_ROOT, { recursive: true }); fs.writeFileSync(probe, 'probe') } catch (e) { return bad(`cannot write into ${ENW_ROOT}: ${e.message}`) }
  let redirected = null
  try {
    for (const pkg of fs.readdirSync(path.join(local, 'Packages'))) {
      const twin = path.join(local, 'Packages', pkg, 'LocalCache', 'Local', path.basename(ENW_ROOT), path.basename(probe))
      if (fs.existsSync(twin)) { redirected = twin; break }
    }
  } catch {}
  try { fs.unlinkSync(probe) } catch {}
  if (!redirected) return ok(`writes land in ${ENW_ROOT} itself`)
  return bad(
    'THIS PROCESS IS SANDBOXED. Everything it writes under %LOCALAPPDATA% is redirected to\n' +
    `      ${path.dirname(redirected)}\n` +
    '      so an install done from here is INVISIBLE to the launcher the player starts from\n' +
    '      their Start menu, and a `setup status` from here will confirm an install that\n' +
    '      does not exist for them. Install from the launcher\'s own first-run screen.'
  )
})

// 3. Does setup agree with itself?
check('setup: the ENW client is installed', () => {
  const s = setup.status()
  if (!s.installed) return bad(`not installed in ${s.gameDir} (CoDWaW.exe, binkw32.dll and binkw32_org.dll must all be there)`)
  return ok(`${s.clientDll.path} (${s.clientDll.size.toLocaleString()} B), source ${s.manifest?.source?.dir || 'unknown'}`)
})

// 4. The status IPC's fields, each on its own — the split that main.js now makes, so a
//    field that throws is named here rather than blanking the launcher's first screen.
check('status: every field can be read on its own', async () => {
  const settings = await import('../src/main/settings.js')
  const lock = await import('../src/main/gamelock.js')
  const updates = await import('../src/main/updates.js')
  const failed = []
  const each = {
    setup: () => setup.status(),
    session: () => settings.session(),
    settings: () => settings.get(),
    config: () => cfg.load(),
    pendingUpdate: () => updates.pending(),
    gameLock: () => (lock.enabled() ? lock.read() : null),
  }
  for (const [name, fn] of Object.entries(each)) {
    try { fn() } catch (e) { failed.push(`${name}: ${e.message}`) }
  }
  return failed.length ? bad(failed.join('; ')) : ok(`${Object.keys(each).length} fields, none threw`)
})

// 5. Logging. An empty `catch` around `appendFileSync` is why nobody noticed the folder
//    was wrong for fifteen minutes.
check('logging: launcher.log is writable', () => {
  const f = path.join(P.logs, 'launcher.log')
  try {
    fs.mkdirSync(P.logs, { recursive: true })
    const before = fs.existsSync(f) ? fs.statSync(f).size : 0
    fs.appendFileSync(f, `${new Date().toISOString()} smoke: log write check\n`)
    const after = fs.statSync(f).size
    return after > before ? ok(`${f} (${after.toLocaleString()} B)`) : bad(`${f} did not grow`)
  } catch (e) { return bad(`${f}: ${e.message}`) }
})

// 6. The site, and what it says about signing in. B's launcher spent an afternoon
//    pinned to a dead test server; `/auth/mode` changed under us the same day.
check('site: reachable, and says how to sign in', async () => {
  const conf = cfg.load()
  const base = String(flag('site') || conf.site || conf.siteUrl || cfg.PRODUCTION_SITE).replace(/\/$/, '')
  const pw = flag('password') || conf.sitePassword || null
  const headers = { accept: 'application/json' }
  if (pw) headers.authorization = 'Basic ' + Buffer.from(`enw:${pw}`).toString('base64')
  let hello
  try {
    const res = await fetch(`${base}/api/launcher/hello`, { headers, signal: AbortSignal.timeout(10000) })
    if (res.status === 401) return bad(`${base} answered 401 — the beta password is missing or wrong`)
    if (!res.ok) return bad(`${base}/api/launcher/hello answered ${res.status}`)
    hello = await res.json()
  } catch (e) { return bad(`${base} is not reachable: ${e.message}`) }
  const auth = hello.auth || 'unknown'
  const detail = `${base} · protocol ${hello.protocol} · auth ${auth} · sign in at ${hello.sign_in_url || '?'}`
  if (auth === 'steam') return ok(detail)
  return warn(`${detail} — the launcher will fall back to MOCK sign-in`)
})

check('site: /auth/steam really redirects to Steam', async () => {
  const conf = cfg.load()
  const base = String(flag('site') || conf.site || conf.siteUrl || cfg.PRODUCTION_SITE).replace(/\/$/, '')
  const pw = flag('password') || conf.sitePassword || null
  const headers = {}
  if (pw) headers.authorization = 'Basic ' + Buffer.from(`enw:${pw}`).toString('base64')
  try {
    const res = await fetch(`${base}/auth/steam`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) })
    const loc = res.headers.get('location') || ''
    if (res.status !== 302 && res.status !== 301) return bad(`answered ${res.status}, expected a redirect`)
    if (!/steamcommunity\.com\/openid/.test(loc)) return bad(`redirected somewhere that is not Steam: ${loc.slice(0, 80)}`)
    const realm = decodeURIComponent((loc.match(/openid\.realm=([^&]+)/) || [])[1] || '')
    const ret = decodeURIComponent((loc.match(/openid\.return_to=([^&]+)/) || [])[1] || '')
    return ok(`302 to steamcommunity.com · realm ${realm} · return_to ${ret}`)
  } catch (e) { return bad(`could not ask: ${e.message}`) }
})

// 7. The dialog nanny. A PowerShell script that does not PARSE emits nothing at all,
//    which is indistinguishable from a script that ran and saw no dialogs — so
//    "no dialogs appeared" has meant "the watcher was never alive" for weeks.
//    One second is enough to tell the difference.
check('nanny: window-nanny.ps1 parses and starts', () => {
  const script = path.join(dirOfModule(import.meta.url), 'window-nanny.ps1')
  if (!fs.existsSync(script)) return bad(`${script} is missing`)
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Seconds', '1'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = out.split(/\r?\n/).filter(Boolean)
    const events = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (!events.length) return bad(`emitted no NDJSON at all in one second — it almost certainly failed to parse:\n      ${lines.slice(0, 3).join('\n      ') || '(nothing on stdout)'}`)
    const kinds = events.map((e) => e.t || e.event || '?')
    if (!kinds.includes('nanny_up')) return bad(`started but never said nanny_up: ${kinds.join(', ')}`)
    const up = events.find((e) => e.t === 'nanny_up')
    // `-Park` is DEV ONLY. A player-mode launch that parks the game's windows at
    // -32000 puts every dialog somewhere B cannot read it.
    return ok(`${kinds.join(', ')} · park=${up.park === true}`)
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' / ')
    return bad(`did not run: ${err}`)
  }
})

// 7b. `-Park` is the dev-only switch that moves the game's windows to -4000,-4000. The
//     ONLY route to it in a player launch is `stealthLaunch` in the config
//     (`launch.js` adds it when windowMode resolves to 'offscreen'), so that is the
//     thing to assert. A parked player-mode launch puts every error box where B cannot
//     read it, which is exactly what he has been describing.
check('launch: the player path does not park windows off-screen', () => {
  const conf = cfg.load()
  if (conf.stealthLaunch) return bad('config.stealthLaunch is true — a player launch will pass -Park and hide the game (and its dialogs) at -4000,-4000')
  return ok('stealthLaunch is off, so windowMode is "player" and -Park is not passed')
})

// 8. Is a launcher already running? Everything above is still true if one is, but a
//    packaged smoke run would have quietly exited, so say so out loud.
check('no other launcher is holding the single-instance lock', () => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-Process -Name 'ENW Zombies' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8', timeout: 20000 }).trim()
    if (!out) return ok('nothing running')
    return warn(`ENW Zombies is already running (pid ${out}). A second copy exits immediately and writes nothing — close it before running a packaged smoke test.`)
  } catch { return ok('could not ask; assuming nothing is running') }
})

// ------------------------------------------------------------------ the run --

const run = async () => {
  const out = []
  for (const { name, fn } of results) {
    let r
    try { r = await fn() } catch (e) { r = bad(`the check itself threw: ${e.message}`) }
    out.push({ name, ...r })
  }
  const failed = out.filter((r) => !r.ok)
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failed.length === 0, root: ENW_ROOT, checks: out }, null, 2))
  } else {
    console.log('')
    for (const r of out) {
      const tag = !r.ok ? 'FAIL' : r.warn ? 'warn' : 'ok  '
      console.log(`  ${tag}  ${r.name}`)
      console.log(`        ${r.detail}`)
    }
    console.log('')
    console.log(failed.length ? `  ${failed.length} of ${out.length} checks failed.` : `  ${out.length} checks, all passed.`)
    console.log('')
  }
  process.exit(failed.length ? 1 : 0)
}

run()
