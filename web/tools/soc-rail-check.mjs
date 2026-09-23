// Lane SOC (web.md "friends across ENW"): headless render check of the left rail's online list.
//
//   node web/tools/soc-rail-check.mjs <shots dir> [port]
//
// Stands up its OWN scratch site (never 3200): a temp data dir with four fake accounts
// (7656119800000060x), a stand-in Movement DB (ZM_FRIENDS_MOVEMENT_LOCAL) making two of them the
// viewer's friends, ZM_TEST_LOGIN for sign-in, and web/client/dist (run `npm run build` first).
// Three other players come online over socket.io (one as the launcher, one in a party, one in a
// browser), then headless Edge (SwiftShader, CDP) signs in as the viewer and opens /maps.
// Checks: the Friends online block first with both friends, "In launcher" and "In party" words,
// Everyone else below, the FRIEND tag; then a fourth player arrives and the rail shows them
// without a reload (the push). Screenshots: rail.png, rail-pushed.png. Exits 1 on any failure.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)
const OUT = process.argv[2]
const PORT = Number(process.argv[3] || 3491)
if (!OUT) { console.error('usage: node web/tools/soc-rail-check.mjs <shots dir> [port]'); process.exit(2) }
if (PORT === 3200) { console.error('refusing: 3200 is the live site'); process.exit(2) }
if (!fs.existsSync(path.join(WEB, 'client', 'dist', 'index.html'))) { console.error('build the client first: npm run build'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const V = '76561198000000601', F1 = '76561198000000602', F2 = '76561198000000603', X = '76561198000000604', LATE = '76561198000000605'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-rail-'))
const MV = path.join(DATA, 'movement.db')
const env = { ...process.env, ZM_DATA_DIR: DATA, ZM_DB_PATH: path.join(DATA, 'zombies.db'), ZM_KEY_DIR: path.join(DATA, 'keys') }

{
  const Database = require(path.join(WEB, 'node_modules', 'better-sqlite3'))
  const m = new Database(MV)
  m.exec(`CREATE TABLE friendships (id INTEGER PRIMARY KEY, requester_steam_id TEXT, addressee_steam_id TEXT, status TEXT)`)
  m.prepare("INSERT INTO friendships (requester_steam_id, addressee_steam_id, status) VALUES (?,?, 'accepted'), (?,?, 'accepted')").run(V, F1, F2, V)
  m.close()
  const seed = spawn(process.execPath, ['-e', `
    const users = require('./server/lib/users'); const { db } = require('./server/db/database');
    users.ensure('${V}', { enw_name: 'deadshot' }); users.ensure('${F1}', { enw_name: 'staminup' });
    users.ensure('${F2}', { enw_name: 'quick_revive' }); users.ensure('${X}', { enw_name: 'mule_kicker' });
    users.ensure('${LATE}', { enw_name: 'double_tap' });
    db.prepare('UPDATE users SET approved=1').run()`], { cwd: WEB, env, stdio: 'inherit' })
  await new Promise((r) => seed.on('exit', r))
}

const BASE = `http://127.0.0.1:${PORT}`
const site = spawn(process.execPath, ['server/index.js'], {
  cwd: WEB, stdio: 'ignore',
  env: { ...env, ZM_PORT: String(PORT), ZM_TEST_LOGIN: '1', ZM_MOVEMENT_URL: 'off', ZM_STEAM_AVATARS: 'off', ZM_PUBLIC_URL: BASE,
         STEAM_API_KEY: '', ZM_SITE_PASSWORD: '', ZM_FRIENDS_MOVEMENT_LOCAL: MV },
})
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const cdpPort = 9950 + Math.floor(Math.random() * 40)
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-edge-'))
let edge = null
const socks = []
const results = []
let failed = 0
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail }); if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`)
}
const done = (code) => {
  for (const s of socks) { try { s.close() } catch { /* gone */ } }
  try { edge && edge.kill() } catch { /* gone */ }
  try { site.kill() } catch { /* gone */ }
  console.log(JSON.stringify({ passed: results.length - failed, failed }))
  process.exit(code)
}
setTimeout(() => { console.log('TIMEOUT'); done(3) }, 180000)

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break } catch { /* not yet */ } await sleep(250) }
  const login = async (sid) => {
    const r = await fetch(BASE + '/auth/test-login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steam_id: sid }) })
    return r.headers.getSetCookie().map((c) => c.split(';')[0])
  }
  const ioc = require(path.join(WEB, 'client', 'node_modules', 'socket.io-client'))
  const online = async (sid, client) => {
    const jar = (await login(sid)).join('; ')
    const s = ioc.io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: jar }, auth: { client }, reconnection: false })
    socks.push(s)
    await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j) })
    return jar
  }
  await online(F1, 'launcher')
  const jarF2 = await online(F2, 'site')
  await fetch(BASE + '/api/party/create', { method: 'POST', headers: { cookie: jarF2, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'verified', visibility: 'friends' }) })
  await online(X, 'site')

  const viewer = await login(V)
  edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${prof}`, '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader', '--window-size=1500,900', '--no-first-run', '--hide-scrollbars', '--mute-audio', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
  let ver
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() } catch { await sleep(200) } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map()
  const logs = []
  let logCount = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return }
    if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
      logCount++
      const t = m.method === 'Runtime.exceptionThrown'
        ? 'exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text)
        : m.params.type + ': ' + m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ')
      if (logs.length < 8 && !logs.includes(t.slice(0, 400))) logs.push(t.slice(0, 400))
    }
  })
  const NL = String.fromCharCode(10)
  process.on('exit', () => { if (logCount) console.log('console: ' + logCount + ' messages; first distinct:' + NL + '  ' + logs.join(NL + '  ')) })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId; pending.set(m.id, { res, rej }); ws.send(JSON.stringify(m)) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => send(m, p, sessionId)
  await S('Network.enable')
  for (const c of viewer) { const [name, ...v] = c.split('='); await S('Network.setCookie', { name, value: v.join('='), url: BASE }) }
  await S('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await S('Page.enable'); await S('Runtime.enable')
  await S('Page.navigate', { url: `${BASE}/maps` })
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
  const rail = () => ev(`(() => [...document.querySelectorAll('.prail .rblock')].map((b) => ({
    label: (b.querySelector('.rlabel') || {}).textContent || '',
    rows: [...b.querySelectorAll('.fcard')].map((r) => ({ name: r.querySelector('.pname').textContent, sub: r.querySelector('.fcard-sub').textContent, friend: !!r.querySelector('.fcard-friend'), pip: r.querySelector('.pdot').className })),
  })).filter((b) => b.rows.length || /Online|Friends|Everyone/.test(b.label)))()`)
  let blocks = []
  for (let i = 0; i < 60; i++) { blocks = await rail().catch(() => []); if (blocks.some((b) => /Friends online/.test(b.label))) break; await sleep(250) }
  const shot = async (name) => { const { data } = await S('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64')) }
  await sleep(600)
  blocks = await rail()
  await shot('rail.png')
  const fr = blocks.find((b) => /Friends online/.test(b.label))
  const rest = blocks.find((b) => /Everyone else/.test(b.label))
  check('Friends online block, first, with both Movement friends', fr && blocks.indexOf(fr) < blocks.indexOf(rest) && fr.rows.length === 2, blocks.map((b) => b.label))
  const by = Object.fromEntries((fr ? fr.rows : []).map((r) => [r.name, r]))
  check('staminup reads In launcher', by.staminup && by.staminup.sub === 'In launcher', by.staminup)
  check('quick_revive reads In party, gold pip', by.quick_revive && /^In party/.test(by.quick_revive.sub) && /in-party/.test(by.quick_revive.pip), by.quick_revive)
  check('FRIEND tag on friends only', fr && fr.rows.every((r) => r.friend) && rest && rest.rows.every((r) => !r.friend))
  check('Everyone else lists mule_kicker as Online', rest && rest.rows.some((r) => r.name === 'mule_kicker' && r.sub === 'Online'), rest)

  const t0 = Date.now()
  await online(LATE, 'launcher')
  let seenMs = -1
  for (let i = 0; i < 40; i++) { const b = await rail(); if (b.some((x) => x.rows.some((r) => r.name === 'double_tap'))) { seenMs = Date.now() - t0; break } await sleep(100) }
  await shot('rail-pushed.png')
  check('a player coming online appears without a reload (pushed)', seenMs >= 0 && seenMs < 2500, { ms: seenMs })
} catch (e) {
  check('ran', false, String(e && e.stack || e))
}
done(failed ? 1 : 0)
