#!/usr/bin/env node
// Launcher telemetry (docs/kickstart/telemetry.md §6): the shared copies, the game bundle,
// the outbox policy against a local server, and "nothing while a game is running".
//
//   node test/telemetry.js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enw-telemetry-'))
process.env.ENW_ROOT = path.join(TMP, 'enwroot')
process.env.ENW_DEV_ROOT = path.join(TMP, 'nodevbox')
const { P, ensureDirs } = await import('../src/main/paths.js')
const T = await import('../src/main/telemetry/index.js')
const { readTarGz } = await import('../src/main/telemetry/tar.cjs')
const { SiteApi } = await import('../src/main/siteapi.js')
const probe = await import('../src/main/telemetry/probe.js')
const wer = await import('../src/main/telemetry/wer.js')
ensureDirs()

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`) } catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.stack?.split('\n').slice(0, 3).join('\n         ')}`) }
}

// ------------------------------------------------------------------ fixtures --
const PID = 4242
const INVITE = `${'A1b2C3d4E5f6G7h8I9j0'}.${'x'.repeat(86)}`
const TOKEN = 'abc123def456ghi789jkl012mno345'
const BETA = 'beta-pass-hunter2'
const dirs = { ...T.defaultDirs(P), crashDumps: path.join(TMP, 'CrashDumps') }
fs.mkdirSync(dirs.crashDumps, { recursive: true })
fs.mkdirSync(P.game, { recursive: true })
fs.writeFileSync(path.join(P.game, 'binkw32.dll'), Buffer.from('MZ fake enw client'))
fs.writeFileSync(path.join(P.logs, 'launcher.log'), `2026-09-23T12:00:00Z play launching\n2026-09-23T12:00:01Z site password ${BETA} (should never be here)\n`)
fs.writeFileSync(path.join(P.logs, `enw-${PID}.log`), `12:00:02 auth: setu enw_token "${TOKEN}"\n12:00:03 invite ${INVITE}\n12:00:04 frame ok\n`)
fs.writeFileSync(path.join(P.logs, `console-${PID}.log`), '12:00:05 Server: nazi_zombie_prototype\n')
fs.writeFileSync(path.join(P.logs, `session-${PID}.json`), JSON.stringify({ pid: PID, exit_reason: 'crash', last_map: 'nazi_zombie_prototype', frames: 12345, build: '10ba8544', chat_token: 'gc1.aaaa.bbbbbbbbbbbbbbbbbbbbbbbbbb' }))
const DUMP = Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0, 1, 2, 3, 0xff, 0xfe, ...Buffer.from(`setu enw_token "${TOKEN}"`)])
fs.writeFileSync(path.join(dirs.crashDumps, `CoDWaW.exe.${PID}.dmp`), DUMP)
fs.mkdirSync(path.join(P.home, 'main'), { recursive: true })
fs.writeFileSync(path.join(P.home, 'main', 'enw_auth.cfg'), `setu enw_token "${TOKEN}"\n`)
fs.writeFileSync(P.settings, JSON.stringify({ local: { fov: 90, sitePassword: BETA } }))
const outLog = path.join(P.logs, '2026-09-23T12-00-00-000Z-stdout.log')
fs.writeFileSync(outLog, 'stdout line\n')
const errLog = path.join(P.logs, '2026-09-23T12-00-00-000Z-stderr.log')
fs.writeFileSync(errLog, '')
fs.mkdirSync(path.join(P.maps, 'nazi_zombie_prototype'), { recursive: true })
fs.writeFileSync(path.join(P.maps, 'nazi_zombie_prototype', '.enw-installed.json'), JSON.stringify({ bsp: 'nazi_zombie_prototype', files: [] }))

const probes = {
  machine: async () => ({ os: 'Windows_NT test', cpu: 'Test CPU', cores: 8, ram_gb: 16, ram_free_gb: 8, gpus: ['Test GPU'] }),
  events: async () => ({ events: [{ id: 1000, time: '2026-09-23T12:00:09Z', provider: 'Application Error', message: 'Faulting application name: CoDWaW.exe' }] }),
  wer: async () => ({ local_dumps: 'hklm', dump_folder: dirs.crashDumps }),
  dllSha: (p) => probe.fileSha256(p),
}

async function readBundle(p) {
  const out = {}
  await readTarGz(p, (e) => { if (e.data) { out[e.name] = e.data; return } return { max: 64 << 20 } })
  return out
}

const gameCtx = {
  pid: PID, pids: [PID], exitCode: 3221225477, startedAt: Date.now() - 600_000, endedAt: Date.now(),
  map: 'nazi_zombie_prototype', matchId: 'm_test0001', mode: 'verified',
  launchLine: `"C:\\ENW\\game\\CoDWaW.exe" +set fs_game mods/enw +set enw_token ${TOKEN} +connect 1.2.3.4:28960 ENW_TOKEN_PIPE=\\\\.\\pipe\\enw-launch-deadbeef01`,
  stdout: outLog, stderr: errLog,
}

// ------------------------------------------------------------------- (a) copies --
await test('(a) the three .cjs copies are byte-identical to shared/telemetry', () => {
  for (const n of ['scrub.cjs', 'tar.cjs', 'bundle.cjs']) {
    const a = fs.readFileSync(path.join(HERE, '..', 'src', 'main', 'telemetry', n))
    const b = fs.readFileSync(path.join(HERE, '..', '..', 'shared', 'telemetry', n))
    assert.ok(a.equals(b), `${n} differs from ../shared/telemetry/${n}; run node tools/telemetry/sync-shared.js`)
  }
})

// ------------------------------------------------------------- (b) game bundle --
let gameBundle
await test('(b) collectGameBundle: scrubbed text, no enw_auth.cfg, the dump as binary, manifest fields', async () => {
  const out = path.join(TMP, 'b1.tar.gz')
  const r = await T.collectGameBundle(gameCtx, { outPath: out, dirs, appVersion: '9.9.9', secrets: [BETA], probes, bundleId: 'ab'.repeat(16) })
  gameBundle = out
  const files = await readBundle(out)
  const names = Object.keys(files)
  assert.ok(names.includes('manifest.json'))
  assert.ok(names.includes(`files/enw-${PID}.log`), names.join(','))
  assert.ok(names.includes(`files/console-${PID}.log`))
  assert.ok(names.includes(`files/session-${PID}.json`))
  assert.ok(names.includes('files/launcher.log'))
  assert.ok(names.includes('files/game-stdout.log'), 'non-empty stdout is bundled')
  assert.ok(!names.includes('files/game-stderr.log'), 'empty stderr is not')
  assert.ok(names.includes('files/settings.json'))
  assert.ok(names.includes('files/map-nazi_zombie_prototype.enw-installed.json'))
  assert.ok(!names.some((n) => /enw_auth/i.test(n)), 'enw_auth.cfg is never bundled')
  const all = names.filter((n) => !n.endsWith('.dmp')).map((n) => files[n].toString('latin1')).join('\n')
  assert.ok(!all.includes(TOKEN), 'the enw_token value is gone from every text file and the manifest')
  assert.ok(!all.includes('x'.repeat(86)), 'the invite token is gone')
  assert.ok(!all.includes(BETA), 'the beta password is gone')
  assert.ok(!all.includes('deadbeef01'), 'the token pipe name is gone')
  assert.match(files[`files/enw-${PID}.log`].toString(), /frame ok/, 'the rest of the log is kept')
  const dump = files[`files/wer-CoDWaW.exe.${PID}.dmp`]
  assert.ok(dump && dump.equals(DUMP), 'the dump is included byte for byte (binary, not scrubbed)')
  const m = JSON.parse(files['manifest.json'])
  assert.equal(m.v, 1)
  assert.equal(m.kind, 'client')
  assert.equal(m.reason, 'game_crash')
  assert.equal(m.bundle_id, 'ab'.repeat(16))
  assert.equal(m.pid, PID)
  assert.equal(m.map, 'nazi_zombie_prototype')
  assert.equal(m.match_id, 'm_test0001')
  assert.equal(m.exit_code, 3221225477)
  assert.equal(m.launcher_version, '9.9.9')
  assert.match(m.dll_sha, /^[0-9a-f]{64}$/)
  assert.equal(m.dll_version, '10ba8544')
  assert.equal(m.session.frames, 12345)
  assert.equal(m.session.chat_token, '<redacted>')
  assert.equal(m.wer.local_dumps, 'hklm')
  assert.equal(m.machine.cores, 8)
  assert.equal(m.events.length, 1)
  assert.ok(m.duration_ms >= 600_000 - 1000)
  assert.ok(m.launch_line.includes('+connect') && !m.launch_line.includes(TOKEN))
  const f = m.files.find((x) => x.name === `wer-CoDWaW.exe.${PID}.dmp`)
  assert.equal(f.binary, true)
  assert.ok(r.bytes > 0)
})

await test('(b) classifyGame: dump -> crash, hang dump -> hang, code 0 -> exit, our stop -> exit', () => {
  assert.equal(T.classifyGame({ crashDumps: ['x'] }), 'game_crash')
  assert.equal(T.classifyGame({ hangDumps: ['x'], exitCode: 1 }), 'game_hang')
  assert.equal(T.classifyGame({ exitCode: 0 }), 'game_exit')
  assert.equal(T.classifyGame({ exitCode: 1, stoppedByUs: true }), 'game_exit')
  assert.equal(T.classifyGame({ exitCode: -1073741819 }), 'game_crash')
})

await test('(b) classifyGame reads the DLL verdict session.exit (lane CL: a hang with no dump file is still a hang)', () => {
  assert.equal(T.classifyGame({ exitCode: 3489660927, session: { exit: 'hang' } }), 'game_hang')
  assert.equal(T.classifyGame({ exitCode: 0, session: { exit: 'crash' } }), 'game_crash')
  assert.equal(T.classifyGame({ exitCode: 0, session: { exit: 'quit' } }), 'game_exit')
})

await test('(b) collectGameBundle noBinary leaves the dump out and says so', async () => {
  const out = path.join(TMP, 'b2.tar.gz')
  await T.collectGameBundle(gameCtx, { outPath: out, dirs, appVersion: '9.9.9', secrets: [BETA], probes, bundleId: 'cd'.repeat(16), noBinary: true })
  const files = await readBundle(out)
  assert.ok(!Object.keys(files).some((n) => n.endsWith('.dmp')))
  assert.match(JSON.parse(files['manifest.json']).notes, /without dumps/)
})

await test('(b) collectLauncherBundle manual: settings/config/detection, recent sessions, recent dumps', async () => {
  fs.writeFileSync(P.config, JSON.stringify({ siteUrl: 'https://zombies.enw.gg', sitePassword: BETA }))
  const out = path.join(TMP, 'b3.tar.gz')
  await T.collectLauncherBundle({ reason: 'manual' }, { outPath: out, dirs, appVersion: '9.9.9', secrets: [], probes, bundleId: 'ef'.repeat(16) })
  const files = await readBundle(out)
  assert.ok(files['files/config.json'])
  assert.ok(!files['files/config.json'].toString().includes(BETA), 'config.json password scrubbed by key')
  assert.ok(files[`files/enw-${PID}.log`])
  assert.ok(files[`files/CoDWaW.exe.${PID}.dmp`], 'a dump newer than 24 h is in a manual bundle')
  assert.equal(JSON.parse(files['manifest.json']).reason, 'manual')
})

// -------------------------------------------------------- (c) the outbox policy --
const server = { answers: [], seen: [] }
const srv = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    server.seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    const a = server.answers.shift() || { status: 200, body: { ok: true, id: 'inc_1', duplicate: false } }
    res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers || {}) })
    res.end(JSON.stringify(a.body || {}))
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const api = new SiteApi({ baseUrl: base, appVersion: '9.9.9', password: BETA, cookieProvider: async () => 'zm.sid=s%3Asecretsession; zm_gate=1' })

let clock = Date.parse('2026-09-23T13:00:00Z')
let gameRunning = false
const logs = []
function makeTele(over = {}) {
  const tdirs = { ...dirs, outbox: path.join(P.root, 'telemetry', over.name || 'outbox'), rejected: path.join(P.root, 'telemetry', `${over.name || 'outbox'}-rejected`), stateFile: path.join(P.state, `${over.name || 'telemetry'}.json`) }
  return new T.Telemetry({
    dirs: tdirs, api: () => api, isGameRunning: () => gameRunning, log: (l) => logs.push(l), appVersion: '9.9.9',
    secrets: () => [BETA, 's%3Asecretsession'], probes, now: () => clock, quietMs: 0,
    setTimer: () => null, clearTimer: () => {}, abortPollMs: 20, ...over,
  })
}
async function builtEntry(t, kind = 'client') {
  const id = kind === 'client' ? t.enqueueGame({ ...gameCtx, endedAt: clock - 10_000 }) : t.enqueueLauncher({ reason: 'launcher_error', error: new Error(`boom ${Math.random()}`) })
  const e = t.outbox.list().find((x) => x.id === id)
  assert.ok(await t.build(e))
  return t.outbox.list().find((x) => x.id === id)
}

await test('(c) 200: deleted, last upload time recorded, first automatic upload announced once; headers and body right', async () => {
  const t = makeTele({ name: 'c200' })
  let firsts = 0
  t.on('first_sent', () => firsts++)
  const e = await builtEntry(t)
  const bytes = fs.readFileSync(e.bundlePath)
  server.seen = []
  server.answers.push({ status: 200, body: { ok: true, id: 'inc_1', duplicate: false } })
  const r = await t.upload(e)
  assert.equal(r.ok, true)
  assert.equal(t.outbox.count(), 0)
  assert.ok(!fs.existsSync(e.bundlePath))
  assert.equal(t.status().last_upload_at, new Date(clock).toISOString())
  const req = server.seen[0]
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/api/telemetry/upload')
  assert.equal(req.headers['content-type'], 'application/gzip')
  assert.equal(req.headers['content-length'], String(bytes.length))
  assert.equal(req.headers['x-enw-bundle-id'], e.id)
  assert.equal(req.headers['x-enw-bundle-kind'], 'client')
  assert.equal(req.headers['x-enw-bundle-reason'], 'game_crash')
  assert.equal(req.headers['x-enw-launcher'], '9.9.9')
  assert.equal(req.headers.cookie, 'zm.sid=s%3Asecretsession; zm_gate=1')
  assert.equal(req.headers.authorization, 'Basic ' + Buffer.from(`enw:${BETA}`).toString('base64'))
  assert.ok(req.body.equals(bytes), 'the body is the bundle, byte for byte')
  // A duplicate answer counts as sent too, and the first-upload notice is not repeated.
  const e2 = await builtEntry(t, 'launcher')
  server.answers.push({ status: 200, body: { ok: true, duplicate: true } })
  assert.equal((await t.upload(e2)).ok, true)
  assert.equal(t.outbox.count(), 0)
  assert.equal(firsts, 1)
  assert.equal(t.status().first_sent, true)
})

await test('(c) 500 backs off 1 min, then 5 min; network errors count the same', async () => {
  const t = makeTele({ name: 'c500' })
  const e = await builtEntry(t)
  server.answers.push({ status: 500 })
  await t.upload(e)
  let m = t.outbox.list()[0].meta
  assert.equal(m.attempts, 1)
  assert.equal(m.next_at, clock + 60_000)
  server.answers.push({ status: 503 })
  await t.upload(t.outbox.list()[0])
  m = t.outbox.list()[0].meta
  assert.equal(m.attempts, 2)
  assert.equal(m.next_at, clock + 5 * 60_000)
  assert.deepEqual(T.BACKOFF_MS.map((x) => x / 60_000), [1, 5, 30, 120, 360])
  assert.equal(T.backoff(9), 6 * 3600_000, 'then every 6 h')
})

await test('(c) 429 honours Retry-After', async () => {
  const t = makeTele({ name: 'c429' })
  const e = await builtEntry(t)
  server.answers.push({ status: 429, headers: { 'retry-after': '900' } })
  await t.upload(e)
  const m = t.outbox.list()[0].meta
  assert.equal(m.next_at, clock + 900_000)
  assert.equal(m.attempts, 0, 'a rate limit is not a failure')
})

await test('(c) 401 waits for sign-in (or 30 min), and the next sign-in releases it', async () => {
  const t = makeTele({ name: 'c401' })
  const e = await builtEntry(t)
  server.answers.push({ status: 401 })
  await t.upload(e)
  let m = t.outbox.list()[0].meta
  assert.equal(m.wait_signin, true)
  assert.equal(m.next_at, clock + 30 * 60_000)
  t.onSignedIn()
  m = t.outbox.list()[0].meta
  assert.equal(m.wait_signin, false)
  assert.equal(m.next_at, clock)
})

await test('(c) 400 moves the bundle to telemetry\\rejected and never retries', async () => {
  const t = makeTele({ name: 'c400' })
  const e = await builtEntry(t)
  server.answers.push({ status: 400, body: { error: 'not a bundle' } })
  await t.upload(e)
  assert.equal(t.outbox.count(), 0)
  assert.ok(fs.existsSync(path.join(t.dirs.rejected, `${e.id}.tar.gz`)))
  assert.match(JSON.parse(fs.readFileSync(path.join(t.dirs.rejected, `${e.id}.json`), 'utf8')).last_error, /not a bundle/)
})

await test('(c) 413 rebuilds once without dumps, then a second 413 drops it', async () => {
  const t = makeTele({ name: 'c413' })
  const e = await builtEntry(t)
  assert.ok(Object.keys(await readBundle(e.bundlePath)).some((n) => n.endsWith('.dmp')))
  server.answers.push({ status: 413 })
  await t.upload(e)
  const e2 = t.outbox.list()[0]
  assert.equal(e2.meta.no_binary, true)
  assert.equal(e2.meta.built, true)
  assert.ok(!Object.keys(await readBundle(e2.bundlePath)).some((n) => n.endsWith('.dmp')), 'the rebuild has no dumps')
  server.answers.push({ status: 413 })
  await t.upload(e2)
  assert.equal(t.outbox.count(), 0)
})

await test('(c) at most 30 days and 2 GB: the oldest go first', async () => {
  const t = makeTele({ name: 'cprune' })
  const old = t.outbox.add({ bundle_id: '11'.repeat(16), kind: 'launcher', reason: 'x', job: {}, created_at: new Date(clock - 31 * 24 * 3600_000).toISOString() })
  const keep = t.outbox.add({ bundle_id: '22'.repeat(16), kind: 'launcher', reason: 'x', job: {} })
  fs.writeFileSync(old.bundlePath, 'x'); fs.writeFileSync(keep.bundlePath, 'x')
  t.outbox.prune()
  assert.deepEqual(t.outbox.list().map((x) => x.id), ['22'.repeat(16)])
  t.outbox.maxBytes = 0
  t.outbox.prune()
  assert.equal(t.outbox.count(), 0)
})

await test('(c) the same launcher error is bundled at most once per 10 min', () => {
  const t = makeTele({ name: 'cerr' })
  assert.ok(t.enqueueLauncher({ reason: 'uncaught', error: new Error('same thing') }))
  assert.equal(t.enqueueLauncher({ reason: 'uncaught', error: new Error('same thing') }), null)
  clock += 11 * 60_000
  assert.ok(t.enqueueLauncher({ reason: 'uncaught', error: new Error('same thing') }))
})

await test('(c) backlog: crashes\\*.json are bundled once', async () => {
  const t = makeTele({ name: 'cbacklog' })
  fs.writeFileSync(path.join(P.crashes, '2026-09-22T10-00-00-000Z-launcher_error.json'), JSON.stringify({ kind: 'launcher_error', error: { message: 'x' } }))
  assert.ok(t.enqueueBacklog())
  assert.equal(t.enqueueBacklog(), null, 'not twice')
  const e = t.outbox.list().find((x) => x.meta.reason === 'backlog')
  assert.ok(await t.build(e))
  const files = await readBundle(t.outbox.list().find((x) => x.id === e.id).bundlePath)
  assert.ok(files['files/crash-2026-09-22T10-00-00-000Z-launcher_error.json'])
})

// ------------------------------------------------------- (d) game running --
await test('(d) nothing is built or uploaded while a game is running; it all goes after', async () => {
  const t = makeTele({ name: 'dgame' })
  server.seen = []
  gameRunning = true
  t.enqueueGame({ ...gameCtx, endedAt: clock })
  t.enqueueLauncher({ reason: 'launcher_error', error: new Error('while playing') })
  await t.run()
  assert.equal(server.seen.length, 0, 'no upload while the game runs')
  assert.ok(t.outbox.list().every((e) => !e.meta.built), 'no bundle built while the game runs')
  assert.ok(logs.some((l) => /paused: a game is running/.test(l)))
  gameRunning = false
  await t.run()
  assert.equal(server.seen.length, 2, 'both go once the game has gone')
  assert.equal(t.outbox.count(), 0)
})

await test('(d) the quiet period after a game exit holds the queue', async () => {
  const t = makeTele({ name: 'dquiet', quietMs: 5000 })
  server.seen = []
  t.enqueueGame({ ...gameCtx, endedAt: clock })
  await t.run()
  assert.equal(server.seen.length, 0)
  clock += 5001
  await t.run()
  assert.equal(server.seen.length, 1)
})

await test('(d) an upload in flight is stopped when a game starts, not counted', async () => {
  const t = makeTele({ name: 'dabort' })
  const e = await builtEntry(t)
  // A server that never answers until the abort.
  const hang = http.createServer(() => {})
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  const slow = new SiteApi({ baseUrl: `http://127.0.0.1:${hang.address().port}`, appVersion: '9.9.9' })
  t.api = () => slow
  setTimeout(() => { gameRunning = true }, 50)
  const r = await t.upload(e)
  gameRunning = false
  hang.closeAllConnections?.(); hang.close()
  assert.equal(r.ok, false)
  assert.equal(t.outbox.list()[0].meta.attempts, 0)
})

await test('Send logs now builds a manual bundle and uploads it at once', async () => {
  const t = makeTele({ name: 'manual' })
  server.seen = []
  const r = await t.sendNow()
  assert.equal(r.ok, true)
  assert.equal(r.message, 'Logs sent')
  assert.equal(server.seen[0].headers['x-enw-bundle-reason'], 'manual')
  assert.equal(server.seen[0].headers['x-enw-bundle-kind'], 'launcher')
  assert.equal(t.outbox.count(), 0)
  assert.equal(t.status().first_sent, false, 'a manual send is not the automatic first-upload notice')
})

// ------------------------------------------------------------- WER detection --
await test('WER: HKLM global key covers; nothing -> our HKCU key (never HKLM)', async () => {
  const keys = new Map()
  const query = async (k) => (keys.has(k) ? { ok: true, values: keys.get(k) } : { ok: false, values: {} })
  keys.set(`HKLM\\${wer.BASE}`, {})
  let d = await wer.detectWer({ query, ourFolder: dirs.ourDumps })
  assert.equal(d.local_dumps, 'hklm')
  assert.equal(d.dump_folder, '%LOCALAPPDATA%\\CrashDumps')
  keys.clear()
  const writes = []
  const add = async (key, name, type, data) => {
    writes.push({ key, name, type, data })
    const v = keys.get(key) || {}; v[name] = { type, value: type === 'REG_DWORD' ? `0x${Number(data).toString(16)}` : data }; keys.set(key, v)
    return { ok: true }
  }
  d = await wer.ensureWer({ ourFolder: dirs.ourDumps, query, add })
  assert.equal(d.local_dumps, 'hkcu-ours')
  assert.equal(d.created, true)
  // One HKCU key per image name: CoDWaW.exe and ENWZombies.exe (gameexe.js, lane DP1).
  assert.deepEqual([...new Set(writes.map((w) => w.key))], [`HKCU\\${wer.BASE}\\CoDWaW.exe`, `HKCU\\${wer.BASE}\\ENWZombies.exe`])
  assert.deepEqual(writes.slice(0, 3).map((w) => `${w.name}=${w.data}`), [`DumpFolder=${dirs.ourDumps}`, 'DumpCount=10', 'DumpType=1'])
  assert.deepEqual(writes.slice(3).map((w) => `${w.name}=${w.data}`), [`DumpFolder=${dirs.ourDumps}`, 'DumpCount=10', 'DumpType=1'])
  assert.equal(d.also[0].exe, 'ENWZombies.exe')
  assert.equal(d.also[0].local_dumps, 'hkcu-ours')
  assert.ok(fs.existsSync(dirs.ourDumps))
  assert.equal((await wer.regAdd('HKLM\\Software\\x', 'a', 'REG_SZ', 'b')).ok, false, 'regAdd refuses HKLM')
})

await test('main.js wiring: every game exit, launcher errors, sign-in, start, Settings, quit', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'main', 'main.js'), 'utf8')
  const ended = src.slice(src.indexOf("flow.on('ended'"), src.indexOf("flow.on('ended'") + 1600)
  assert.match(ended, /telemetry\.enqueueGame\(/, 'the flow end enqueues a game bundle, whatever the phase')
  assert.ok(ended.indexOf('enqueueGame') < ended.indexOf("p.phase === 'failed'"), 'before, not inside, the failed-only branch')
  assert.match(src, /isGameRunning: \(\) => !!state\.flow \|\| !!followGate\.gameAlive\(\)/)
  assert.match(src, /telemetry\.enqueueLauncher\(\{ reason: uncaught \? 'uncaught' : 'launcher_error'/)
  assert.match(src, /process\.on\('uncaughtException'/, 'the existing handlers stay')
  assert.match(src, /crash\.report\(cfg\.load\(\)\.crashEndpoint/, 'the existing silent report stays')
  assert.match(src, /telemetry\.onSignedIn\(\)/)
  assert.match(src, /telemetry\.start\(\)/)
  assert.match(src, /handle\('sendLogs'/)
  assert.match(src, /telemetry\.stop\(\)/)
  const pre = fs.readFileSync(path.join(HERE, '..', 'src', 'preload', 'preload.cjs'), 'utf8')
  assert.match(pre, /sendLogs: \(\) => call\('sendLogs'\)/)
  assert.ok(!/s3|bucket|S3_/i.test(fs.readdirSync(path.join(HERE, '..', 'src', 'main', 'telemetry')).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(HERE, '..', 'src', 'main', 'telemetry', f), 'utf8')).join('\n').replace(/bucket keys|no bucket|bucket copy/gi, '')), 'no bucket keys in the launcher')
})

srv.close()
console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
