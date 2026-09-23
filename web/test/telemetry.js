'use strict'

// Telemetry (docs/kickstart/telemetry.md): the scrubber, the bundle format, the flag rules,
// the two ingest routes and their auth, the bucket hand-off, the admin Issues routes, the
// AI brief, the digest and the site's own incidents.
//
//   node test/telemetry.js
//
// A throwaway database and data dir, 127.0.0.1 only, a fake bucket (no network).

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const zlib = require('zlib')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-telemetry-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'
process.env.ZM_TELEMETRY_PER_DAY = '6'
process.env.ZM_SITE_PASSWORD = 'SitePassw0rd!'
const CHRONIC = path.join(TMP, 'chronic.json')
fs.writeFileSync(CHRONIC, JSON.stringify({ maps: { '*': ['material:engine_noise'], nazi_zombie_test: ['xanim:known_anim'] } }))
process.env.ZM_CHRONIC_ASSETS = CHRONIC

const REPO = path.resolve(__dirname, '..', '..')
const scrub = require('../../shared/telemetry/scrub.cjs')
const tar = require('../../shared/telemetry/tar.cjs')
const { writeBundle } = require('../../shared/telemetry/bundle.cjs')

let pass = 0
let fail = 0
const out = []
async function check (name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }
const has = (s, sub, what) => { if (!String(s).includes(sub)) throw new Error(`${what || 'text'} lacks ${JSON.stringify(sub)}: ${String(s).slice(0, 300)}`) }
const lacks = (s, sub, what) => { if (String(s).includes(sub)) throw new Error(`${what || 'text'} still has ${JSON.stringify(sub)}`) }

const INVITE = 'eyJzIjoiNzY1NjExOTgwMDAwMDAwMDEiLCJtIjoibV8xMjM0NTYiLCJlIjoxNzAwMDAwMDAwfQ.' + 'Ab_-'.repeat(21) + 'xy'
const CHATPASS = 'gc1.eyJzIjoiNzY1NjExOTgwMDAwMDAwMDEifQ.' + 'q'.repeat(43)
const BOXSECRET = 'b0x-s3cret-value-1234567890'

async function main () {
  // ---- 1. the scrubber ---------------------------------------------------------------
  await check('scrub: the three copies of scrub/tar/bundle are byte-identical', () => {
    for (const f of ['scrub.cjs', 'tar.cjs', 'bundle.cjs']) {
      const a = fs.readFileSync(path.join(REPO, 'shared', 'telemetry', f))
      for (const d of [['launcher', 'src', 'main', 'telemetry'], ['infra', 'host-agent', 'lib', 'telemetry']]) {
        truthy(a.equals(fs.readFileSync(path.join(REPO, ...d, f))), `${d.join('/')}/${f} matches shared (run tools/telemetry/sync-shared.js)`)
      }
    }
  })
  const S = (t, o) => scrub.scrubText(t, o).text
  await check('scrub: our cvars (setu enw_token "…", seta enw_auth …)', () => {
    eq(S('setu enw_token "abcDEF1234567890"'), 'setu enw_token "<redacted>"')
    eq(S('seta enw_auth abc123xyz789'), 'seta enw_auth "<redacted>"')
    eq(S('set enw_chat_pass hello-there-1234'), 'set enw_chat_pass "<redacted>"')
  })
  await check('scrub: invite tokens and gc1 chat passes', () => {
    const t = S(`joining with ${INVITE} and ${CHATPASS} ok`)
    lacks(t, INVITE.slice(0, 30)); lacks(t, CHATPASS.slice(4, 30)); has(t, '<token <redacted>>'); has(t, ' ok')
  })
  await check('scrub: name=value, "name": "value", env lines, query strings', () => {
    eq(S('S3_SECRET_KEY=abcdefgh/1234+xyz'), 'S3_SECRET_KEY=<redacted>')
    eq(S('S3_ACCESS_KEY="AKIA0123456789ABCDEF"'), 'S3_ACCESS_KEY=<redacted>')
    eq(S('{"x-match-secret":"hunter2hunter2","map_key":"nazi_zombie_asylum","token_ok":true}'), '{"x-match-secret":"<redacted>","map_key":"nazi_zombie_asylum","token_ok":true}')
    eq(S('GET https://x/api?token=abcdef123456&map=asylum'), 'GET https://x/api?token=<redacted>&map=asylum')
    eq(S('password: hunter22'), 'password: <redacted>')
  })
  await check('scrub: headers, cookies, the token pipe, deep links', () => {
    eq(S('Authorization: Basic ZW53OkNyYXp5VGltZQ=='), 'Authorization: Basic <redacted>')
    eq(S('authorization: Bearer abcdefghijklmnop'), 'authorization: Bearer <redacted>')
    has(S('cookie zm.sid=s%3Aabc.def; zm_gate=0123456789abcdef'), 'zm.sid=<redacted>')
    has(S('cookie zm.sid=s%3Aabc.def; zm_gate=0123456789abcdef'), 'zm_gate=<redacted>')
    eq(S('pipe \\\\.\\pipe\\enw-launch-0a1b2c3d4e'), 'pipe \\\\.\\pipe\\enw-launch-<redacted>')
    eq(S('open enw-zombies://join/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'open enw-zombies://join/<redacted>')
  })
  await check('scrub: literal secrets the caller knows, counted', () => {
    const r = scrub.scrubText(`box secret ${BOXSECRET} twice ${BOXSECRET}`, { secrets: [BOXSECRET, 'abc'] })
    lacks(r.text, BOXSECRET); eq(r.hits.literal, 2, 'literal hits')
  })
  await check('scrub: leaves ordinary log lines alone (security, tokens: 3, token_ok, sha256)', () => {
    for (const l of ['security: high', 'tokens: 3 seen', 'token_ok=true', 'secret=false', 'sha256=' + 'a'.repeat(64), '[12:00:00.000] [INFO] auth: token accepted for slot 1', 'dll 10ba8544 (sha 10ba854400aa)']) eq(S(l), l, l)
  })
  await check('scrub: JSON keys, forbidden files', () => {
    const j = scrub.scrubJson({ a: { secret: 'x', map_key: 'm', chat_token: 'y', n: [{ password: 'p' }] }, note: 'setu enw_token "q1234567"', key_id: 'k1' })
    eq(j.a.secret, '<redacted>'); eq(j.a.map_key, 'm'); eq(j.a.chat_token, '<redacted>'); eq(j.a.n[0].password, '<redacted>'); eq(j.key_id, 'k1')
    has(j.note, '<redacted>')
    for (const f of ['C:/x/main/enw_auth.cfg', 'iraq_loser.maFile', 'infra/s3.env', '/root/enw-host.env', 'site.env', 'id_ed25519', 'host.key']) truthy(scrub.isForbiddenFile(f), f)
    for (const f of ['enw-1.log', 'console-2.log', 'settings.json']) eq(scrub.isForbiddenFile(f), false, f)
  })

  // ---- 2. the bundle format ------------------------------------------------------------
  const FIX = path.join(TMP, 'fix')
  fs.mkdirSync(FIX, { recursive: true })
  const dllLog = [
    '[12:00:00.000] [INFO] enw: build 10ba8544',
    '[12:00:01.000] [INFO] auth: setu enw_token "' + 'z'.repeat(40) + '"',
    `[12:00:02.000] [INFO] join with ${INVITE}`,
    '[12:00:03.000] [WARN] dedi_join_in_progress: the dvar at [0x0339A774] never appeared - joins would have been refused with EXE_ERR_CANNOTJOININPROGRESS',
    '[12:00:04.000] [INFO] overlay_guard: address space +60 s: largest free block 41.5 MB of 300.0 MB free; DiscordHook loads refused 1, allowed 0',
    '[12:00:05.000] [INFO] frametime: window 3 -- 900 frames, 42.0 fps avg | p1 1.00 ms  p50 20.00 ms  p95 30.00 ms  p99 40.00 ms  max 90.00 ms  sd 5.00 ms | over 16.7ms: 800 (88.00%)  over 33.3ms: 90 (10.00%)  over 50ms: 3',
    '[12:00:06.000] [ERROR] === Com_Error TRAPPED ===',
    '[12:00:06.001] [ERROR]   arg1 = 00000001 ',
    '[12:00:06.002] [ERROR]   arg3 = 04DEA3F8 "EXE_ERR_SERVER_TIMEOUT"',
    ...Array.from({ length: 40 }, (_, i) => `[12:00:07.${String(i).padStart(3, '0')}] [INFO] filler ${i}`),
    '[12:01:00.000] [ERROR] overlay_guard: UNHANDLED EXCEPTION 0xC0000005 (read of 0x00000010) at 0x0062B7B2 (CoDWaW.exe+0x22B7B2) on thread 1234, +60000 ms; largest free address block 38.0 MB of 290.0 MB free.',
  ].join('\n')
  fs.writeFileSync(path.join(FIX, 'enw-4242.log'), dllLog)
  fs.writeFileSync(path.join(FIX, 'console-4242.log'), [
    'Error: Could not load xanim "known_anim".',
    'Error: Could not load material "engine_noise".',
    'Error: Could not load xmodel "brand_new_model".',
    '******* script runtime error *******',
    'undefined is not an object: (file \'maps/_zombiemode.gsc\', line 12)',
    'Error: unable to find secondary alias \'shell_eject_rifle\'',
  ].join('\n'))
  fs.writeFileSync(path.join(FIX, 'enw_auth.cfg'), 'setu enw_token "secret"')
  fs.writeFileSync(path.join(FIX, 'CoDWaW.exe.4242.dmp'), Buffer.alloc(300000, 7))
  fs.writeFileSync(path.join(FIX, 'launcher.log'), `2026-09-23T12:00:00.000Z play launching with password=${process.env.ZM_SITE_PASSWORD} ok\n`)

  const bundlePath = path.join(TMP, 'b1.tar.gz')
  let built
  await check('bundle: writeBundle scrubs text, refuses enw_auth.cfg, streams the dump, writes the manifest', async () => {
    built = await writeBundle(bundlePath, {
      manifest: { kind: 'client', reason: 'game_crash', launcher_version: '0.2.25', dll_sha: '10ba8544aa', map: 'nazi_zombie_test', match_id: 'm_123', pid: 4242, exit_code: 3221225477, machine: { os: 'Windows 10.0.26200', ram_gb: 32 }, session: { exit: 'crash', largest_free_block_mb: 38 } },
      files: [
        { name: 'enw-4242.log', path: path.join(FIX, 'enw-4242.log') },
        { name: 'console-4242.log', path: path.join(FIX, 'console-4242.log') },
        { name: 'enw_auth.cfg', path: path.join(FIX, 'enw_auth.cfg') },
        { name: 'CoDWaW.exe.4242.dmp', path: path.join(FIX, 'CoDWaW.exe.4242.dmp') },
        { name: 'launcher.log', path: path.join(FIX, 'launcher.log') },
      ],
      secrets: [process.env.ZM_SITE_PASSWORD],
    })
    const seen = {}
    await tar.readTarGz(bundlePath, (e) => { if (e.data) { seen[e.name] = e.data; return } return /\.(log|json)$/.test(e.name) ? { max: 1e6 } : false })
    const m = JSON.parse(seen['manifest.json'])
    eq(m.kind, 'client'); eq(m.v, 1); truthy(/^[0-9a-f]{32}$/.test(m.bundle_id), 'bundle_id is 128-bit hex')
    truthy(m.files.some((f) => f.name === 'enw_auth.cfg' && f.refused), 'enw_auth.cfg refused')
    truthy(m.files.some((f) => f.name === 'CoDWaW.exe.4242.dmp' && f.binary && f.size === 300000), 'dump listed as binary')
    lacks(seen['files/enw-4242.log'].toString(), 'z'.repeat(40), 'the bundled DLL log')
    lacks(seen['files/enw-4242.log'].toString(), INVITE.slice(0, 40), 'the bundled DLL log')
    lacks(seen['files/launcher.log'].toString(), process.env.ZM_SITE_PASSWORD, 'the bundled launcher log')
    truthy(!Object.keys(seen).some((k) => /enw_auth/.test(k)), 'no enw_auth.cfg entry')
  })
  await check('tar: sink streaming, the last-n-bytes tail, a corrupt archive rejects', async () => {
    let n = 0
    await tar.readTarGz(bundlePath, (e) => (/\.dmp$/.test(e.name) ? { sink: { write: (b) => { n += b.length }, end: () => {} } } : false))
    eq(n, 300000, 'dump bytes through the sink')
    let tail = null
    await tar.readTarGz(bundlePath, (e) => { if (e.data) { tail = e; return } return e.name === 'files/console-4242.log' ? { max: 20 } : false })
    eq(tail.data.length, 20); eq(tail.truncated, true); has(tail.data.toString(), 'rifle')
    const bad = path.join(TMP, 'bad.tar.gz')
    fs.writeFileSync(bad, zlib.gzipSync(Buffer.alloc(1024, 65)))
    let threw = false
    try { await tar.readTarGz(bad, () => false) } catch { threw = true }
    truthy(threw, 'a corrupt tar throws')
  })

  // ---- 3. the flag rules ----------------------------------------------------------------
  const { evaluate, _resetChronic } = require('../server/lib/telemetry/flags')
  _resetChronic()
  const ev = (manifest, texts, files = []) => evaluate({ manifest: { kind: 'client', ...manifest }, files: [...files, ...Object.keys(texts).map((n) => ({ name: n, size: 1 }))], texts: new Map(Object.entries(texts)) })
  await check('flags: the crash fixture — crash P1 first, com_error with its code, fps, address space, assets new vs known, script errors', () => {
    const r = ev({ reason: 'game_crash', map: 'nazi_zombie_test', exit_code: 3221225477, session: { exit: 'crash' } },
      { 'enw-4242.log': dllLog, 'console-4242.log': fs.readFileSync(path.join(FIX, 'console-4242.log'), 'utf8') },
      [{ name: 'CoDWaW.exe.4242.dmp', size: 300000, binary: true }])
    eq(r.severity, 1); eq(r.flags[0], 'crash')
    for (const f of ['com_error', 'disconnect', 'script_error', 'fps_low', 'low_address_space', 'asset_missing', 'asset_missing_known', 'discord_refused']) truthy(r.flags.includes(f), `flag ${f} in ${r.flags}`)
    eq(r.flags.includes('join_failed'), false, 'the "would have been refused" warning is not a join failure')
    eq(r.flags.includes('exit_abnormal'), false, 'no abnormal-exit on top of a crash')
    has(r.hits.com_error.detail, 'EXE_ERR_SERVER_TIMEOUT')
    has(r.hits.asset_missing.detail, 'xmodel:brand_new_model')
    lacks(r.hits.asset_missing.detail, 'known_anim'); eq(r.hits.asset_missing.count, 2, 'new assets (xmodel + the alias)')
    eq(r.hits.asset_missing_known.count, 2, 'known: the map one and the engine one')
    has(r.hits.fps_low.detail, '42')
    has(r.hits.low_address_space.detail, '38')
    truthy(r.hits.crash.excerpts.length && r.hits.crash.excerpts.some((e) => e.lines.some((l) => l.includes('UNHANDLED EXCEPTION'))), 'crash excerpt holds the exception line')
    truthy(r.hits.crash.excerpts[0].lines.length > 20, 'crash excerpt is a wide window')
  })
  await check('flags: hang (dump + watchdog line), join_failed, auth_deny, exit_abnormal alone', () => {
    const h = ev({ reason: 'game_exit' }, { 'enw-1.log': '[1] [ERROR] hang_watchdog: the MAIN THREAD (tid 1) has not ticked for 8000 ms in a map.' }, [{ name: 'hang-1-20260923-034238.dmp', size: 0, binary: true }])
    eq(h.severity, 1); truthy(h.flags.includes('hang')); has(h.hits.hang.detail, 'empty')
    const j = ev({}, { 'enw-2.log': '[1] [ERROR] join_retry: GIVING UP after 60.0 s and 5 refusal(s); last answer x' })
    truthy(j.flags.includes('join_failed')); eq(j.severity, 2)
    const a = ev({ kind: 'host' }, { 'host.log': '10:00:00.000 warn  host/m_1 auth slot 1 bob 7656: DENY (wrong_match) -> identity refused' })
    truthy(a.flags.includes('auth_deny'))
    const x = ev({ exit_code: 1 }, { 'enw-3.log': 'nothing' })
    eq(x.flags.join(), 'exit_abnormal'); eq(x.severity, 2)
  })
  await check('flags (lane CL): overlay_guard\'s start-up INFO line is not a crash; the hang verdict reaches the detail', () => {
    const quiet = ev({ reason: 'game_exit', exit_code: 0, session: { exit: 'quit' } }, { 'enw-5.log': "[15:12:40.694] [INFO ] overlay_guard: unhandled exceptions are named before the engine's filter (previous 005FF510)." })
    eq(quiet.flags.includes('crash'), false, String(quiet.flags))
    const real = ev({ reason: 'game_crash' }, { 'enw-6.log': '[1] [ERROR] overlay_guard: UNHANDLED EXCEPTION 0xC0000005 at 0x0041A2B3' })
    truthy(real.flags.includes('crash'))
    const h = ev({ reason: 'game_hang', session: { exit: 'hang', hang_where: 'main waits on the render lock; holder tid 7 at 0x0070E370 (CoDWaW.exe)' } }, { 'enw-7.log': '[1] [ERROR] hang_watchdog: the MAIN THREAD (tid 1) has not ticked for 8000 ms in a map.' })
    has(h.hits.hang.detail, 'render lock; holder tid 7')
  })
  await check('flags: host — instance crash, pull failure, lease refused, host errors, oom, box resources, result spooled', () => {
    const r = evaluate({ manifest: { kind: 'host', reason: 'pull_failed', host: { disk_free_gb: 1.2, mem_free_mb: 900 } }, files: [], texts: new Map([
      ['host.log', [
        '10:00:00.000 warn  host/m_1 instance exited unexpectedly — saving the game up to the crash',
        '10:00:01.000 error host lease m_1: could not prepare nazi_zombie_x: sha256 mismatch',
        '10:00:02.000 warn  host no free instance slot for lease m_2 (3/3)',
        '10:00:03.000 error host/m_1 instance failed: exited 3 times',
        '10:00:04.000 warn  host result post failed (fetch failed) — held in the spool, not lost',
      ].join('\n')],
      ['kernel.log', 'Sep 23 10:00:00 box kernel: Out of memory: Killed process 1234 (wine)'],
    ]) })
    for (const f of ['crash', 'host_pull_failed', 'lease_refused', 'host_error', 'oom_kill', 'box_resources', 'result_spooled']) truthy(r.flags.includes(f), `flag ${f} in ${r.flags}`)
    eq(r.severity, 1)
  })
  await check('flags: the box agent\'s real file names (host-instance / engine-console / journal-unit) and its ISO ring lines', () => {
    // Names and line format from infra/host-agent/lib/telemetry.js + util.js ringFormat.
    const r = evaluate({ manifest: { kind: 'host', reason: 'instance_end' }, files: [], texts: new Map([
      ['host-instance.log', '2026-09-23T12:24:50.978Z error host/inst-07 instance failed: exited 3 times\n2026-09-23T12:24:51.000Z warn  host result post failed (fetch failed)'],
      ['engine-console.log', '******* script runtime error *******\nundefined is not an array'],
      ['host-box-context.log', '2026-09-23T12:24:50.978Z warn  host/inst-08 instance exited unexpectedly'],
    ]) })
    for (const f of ['host_error', 'result_spooled', 'script_error']) truthy(r.flags.includes(f), `flag ${f} in ${r.flags}`)
    truthy(!r.flags.includes('crash'), 'another instance\'s crash line in host-box-context.log does not flag this one')
    const j = evaluate({ manifest: { kind: 'journal', reason: 'daily_journal' }, files: [], texts: new Map([
      ['journal-unit.log', '2026-09-22T10:00:00+0000 zombies-dev node[812]: 10:00:00.000 error host KEY MISMATCH'],
      ['journal-kernel.log', '2026-09-22T10:00:00+0000 zombies-dev kernel: Out of memory: Killed process 1234 (wine)'],
    ]) })
    truthy(j.flags.includes('host_error') && j.flags.includes('oom_kill'), `journal flags ${j.flags}`)
  })
  await check('flags: launcher — error, update failure, manual send; journal-only rules do not fire on a client', () => {
    const r = evaluate({ manifest: { kind: 'launcher', reason: 'uncaught', notes: 'TypeError: x is undefined' }, files: [], texts: new Map([['launcher.log', '2026-09-23T11:00:00Z update check failed: error code: 502\n2026-09-23T11:00:01Z uncaught TypeError: x is undefined']]) })
    truthy(r.flags.includes('launcher_error')); truthy(r.flags.includes('launcher_update_failed')); eq(r.severity, 2)
    const m = ev({ reason: 'manual' }, { 'enw-1.log': 'fine' })
    eq(m.flags.join(), 'manual_report'); eq(m.severity, 3)
    const c = ev({}, { 'enw-1.log': 'Out of memory: Killed process 1' })
    eq(c.flags.includes('oom_kill'), false, 'oom_kill is a box rule')
    const n = ev({ reason: 'game_exit', exit_code: 0 }, { 'enw-1.log': '[1] [INFO] all good' })
    eq(n.flags.length, 0); eq(n.severity, 4)
  })
  await check('flags: record refused, excerpts capped at 300 lines per flag', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? `[1] [WARN] fps_guard: com_maxfps 333 is outside the Verified rule (85..250) -> set to 250 ${i}` : `[1] [INFO] x ${i}`)).join('\n')
    const r = ev({}, { 'enw-1.log': lines })
    truthy(r.flags.includes('record_refused'))
    const n = r.hits.record_refused.excerpts.reduce((a, e) => a + e.lines.length, 0)
    truthy(n <= 300 && n > 250, `excerpt lines ${n}`)
    has(r.hits.record_refused.excerpts.at(-1).lines.join('\n'), 'set to 250 1998', 'the newest lines are kept')
  })

  // ---- 4. the routes -----------------------------------------------------------------------
  const { db, now } = require('../server/db/database')
  const users = require('../server/lib/users')
  const boxes = require('../server/lib/boxes')
  const store = require('../server/lib/telemetry/store')
  const incidents = require('../server/lib/telemetry/incidents')
  const siteLog = require('../server/lib/telemetry/siteLog')
  const ADMIN = '76561198000000401'
  const MOD = '76561198000000402'
  const PLAYER = '76561198000000403'
  const NEWBIE = '76561198000000404'
  users.ensure(ADMIN, { enw_name: 'boss' }); users.ensure(MOD, { enw_name: 'modder' }); users.ensure(PLAYER, { enw_name: 'player' }); users.ensure(NEWBIE)
  db.prepare('UPDATE users SET approved=1 WHERE steam_id<>?').run(NEWBIE)
  db.prepare('UPDATE users SET is_admin=1 WHERE steam_id=?').run(ADMIN)
  db.prepare('UPDATE users SET is_mod=1 WHERE steam_id=?').run(MOD)
  boxes.create({ name: 'box-t', matchKey: BOXSECRET, maxInstances: 3 })

  // A fake bucket.
  const bucket = new Map()
  store._setConfig({ keys: true, bucket: 'enw-zombies', c: { endpoint: 'https://nbg1.your-objectstorage.com' } })
  store._setPut(async (key, { file, body }) => { bucket.set(key, file ? fs.readFileSync(file) : body); return { key, url: `https://enw-zombies.nbg1.your-objectstorage.com/${key}` } })

  const express = require('express')
  const app = express()
  app.use(express.json())
  // x-test-user, or (for the launcher's own SiteApi, which only sends a cookie) zm_test=<id>.
  app.use((q, _r, next) => { const who = q.headers['x-test-user'] || (/(?:^|;\s*)zm_test=(\d+)/.exec(q.headers.cookie || '') || [])[1]; q.me = who ? users.byId(String(who)) : null; next() })
  app.use(siteLog.middleware())
  app.use('/api/gs', require('../server/routes/gameserver').router())
  app.use('/api/telemetry', require('../server/routes/telemetry').router())
  app.use('/api/admin', require('../server/routes/admin').router())
  app.get('/boom', () => { throw new Error('kaboom 12345') })
  app.use(siteLog.errorHandler())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port

  const call = (method, p, { as, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null)
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(as ? { 'x-test-user': as } : {}),
      ...(data ? { 'content-type': raw ? 'application/gzip' : 'application/json', 'content-length': data.length } : {}),
      ...headers,
    } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, body: j, text: t, headers: res.headers }) })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
  const bytes = fs.readFileSync(bundlePath)
  const up = (as, buf = bytes, headers = {}) => call('POST', '/api/telemetry/upload', { as, raw: buf, headers: { 'x-enw-bundle-id': built.bundle_id, 'x-enw-bundle-kind': 'client', 'x-enw-bundle-reason': 'game_crash', ...headers } })

  let first
  await check('ingest: signed out is 401; a nameless, unapproved account may send', async () => {
    eq((await up(null)).status, 401)
    const n = await up(NEWBIE, bytes, { 'x-enw-bundle-id': 'a'.repeat(32) })
    eq(n.status, 200, `newbie: ${n.text}`)
  })
  await check('ingest: 200 with id, severity and flags; a retry of the same bundle is a duplicate', async () => {
    first = await up(PLAYER)
    eq(first.status, 200, first.text); eq(first.body.severity, 1); truthy(first.body.flags.includes('crash'))
    const again = await up(PLAYER)
    eq(again.status, 200); eq(again.body.duplicate, true); eq(again.body.id, first.body.id)
  })
  await check('ingest: the row — who, versions, map, bucket key under logs/client/<date>/<steamid>/<128-bit>.tar.gz', async () => {
    await store.idle()
    const row = incidents.byRowId(first.body.id)
    eq(row.steam_id, PLAYER); eq(row.launcher_version, '0.2.25'); eq(row.map_key, 'nazi_zombie_test'); eq(row.match_id, 'm_123'); eq(row.kind, 'client')
    truthy(new RegExp(`^logs/client/\\d{4}-\\d\\d-\\d\\d/${PLAYER}/[0-9a-f]{32}\\.tar\\.gz$`).test(row.bucket_key), row.bucket_key)
    eq(row.upload_state, 'uploaded'); eq(row.local_path, null, 'the local copy is removed once uploaded')
    truthy(bucket.has(row.bucket_key), 'the fake bucket has it')
    truthy(bucket.get(row.bucket_key).equals(bytes), 'the bucket copy is the bundle as sent (nothing to re-scrub)')
    has(row.summary, 'player'); has(row.summary, 'Crash')
  })
  await check('ingest: a chunked body with no content-length is accepted, and capped while it streams', async () => {
    const chunked = (buf, id) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/telemetry/upload', headers: { 'x-test-user': MOD, 'content-type': 'application/gzip', 'transfer-encoding': 'chunked', 'x-enw-bundle-id': id } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => resolve({ status: res.statusCode, text: t }))
      })
      r.on('error', reject)
      for (let i = 0; i < buf.length; i += 1000) r.write(buf.subarray(i, i + 1000))
      r.end()
    })
    const ok = await chunked(bytes, '1'.repeat(32))
    eq(ok.status, 200, ok.text)
    process.env.ZM_TELEMETRY_MAX_MB = '0.001'
    const big = await chunked(Buffer.alloc(8192, 3), '2'.repeat(32)).catch((e) => ({ status: 'err ' + e.message }))
    delete process.env.ZM_TELEMETRY_MAX_MB
    eq(big.status, 413)
    db.prepare('DELETE FROM incidents WHERE steam_id=?').run(MOD) // keep MOD's day budget for later checks
  })
  await check('ingest: 413 over the cap (by content-length), 400 for junk, 400 for a box kind', async () => {
    process.env.ZM_TELEMETRY_MAX_MB = '0.001' // ~1 KB for this one check
    const big = await call('POST', '/api/telemetry/upload', { as: PLAYER, raw: Buffer.alloc(4096, 1), headers: { 'x-enw-bundle-id': 'f'.repeat(32) } }).catch((e) => ({ status: 'err ' + e.message }))
    delete process.env.ZM_TELEMETRY_MAX_MB
    eq(big.status, 413); truthy(big.body.max_bytes > 0, 'says the cap')
    const junk = await up(PLAYER, Buffer.from('not a gzip at all'), { 'x-enw-bundle-id': 'b'.repeat(32) })
    eq(junk.status, 400)
    const hostKind = path.join(TMP, 'hostkind.tar.gz')
    await writeBundle(hostKind, { manifest: { kind: 'host', reason: 'instance_end' }, files: [{ name: 'host.log', text: 'x' }] })
    eq((await up(PLAYER, fs.readFileSync(hostKind), { 'x-enw-bundle-id': 'c'.repeat(32) })).status, 400)
    eq(fs.readdirSync(store.DIRS.incoming).length, 0, 'nothing left in incoming')
  })
  await check('ingest: the server re-scrubs what a sender missed, and rebuilds the bundle', async () => {
    const raw = path.join(TMP, 'raw.tar.gz')
    const man = { v: 1, kind: 'client', reason: 'game_exit', bundle_id: 'd'.repeat(32), launch_line: 'x' }
    await tar.packTarGz(raw, [
      { name: 'manifest.json', buffer: Buffer.from(JSON.stringify(man)) },
      { name: 'files/enw-9.log', buffer: Buffer.from(`[1] [INFO] setu enw_token "leakedleakedleaked"\n[2] [INFO] pw ${process.env.ZM_SITE_PASSWORD}\n[3] [ERROR] === Com_Error TRAPPED ===\n`) },
      { name: 'files/x.dmp', buffer: Buffer.alloc(5000, 1) },
    ])
    const r = await up(PLAYER, fs.readFileSync(raw), { 'x-enw-bundle-id': 'd'.repeat(32) })
    eq(r.status, 200, r.text)
    await store.idle()
    const row = incidents.byRowId(r.body.id)
    const stored = bucket.get(row.bucket_key)
    truthy(stored, 'uploaded')
    const back = {}
    await tar.readTarGz(require('stream').Readable.from([stored]), (e) => { if (e.data) { back[e.name] = e.data.toString('latin1'); return } return { max: 1e6 } })
    lacks(back['files/enw-9.log'], 'leakedleaked'); lacks(back['files/enw-9.log'], process.env.ZM_SITE_PASSWORD)
    eq(back['files/x.dmp'].length, 5000, 'the binary came through')
    truthy(JSON.parse(back['manifest.json']).server_rescrubbed, 'marked')
    lacks(row.hits, 'leakedleaked', 'the stored excerpts')
  })
  await check('ingest: 429 with Retry-After past the per-day count', async () => {
    let last
    for (let i = 0; i < 8; i++) last = await up(PLAYER, bytes, { 'x-enw-bundle-id': String(i).repeat(32).slice(0, 32).replace(/./g, (c) => 'abcdef0123456789'[Number(c) || 0]) + '' })
    eq(last.status, 429); truthy(Number(last.headers['retry-after']) > 0, 'retry-after')
  })
  await check('gs: the box route needs the box secret; a host bundle lands under the box name', async () => {
    const hb = path.join(TMP, 'host.tar.gz')
    const b = await writeBundle(hb, { manifest: { kind: 'host', reason: 'instance_end', match_id: 'm_77', map: 'nazi_zombie_asylum', exit_reason: 'crashed' },
      files: [{ name: 'host.log', text: `10:00:00.000 warn  host/m_77 instance exited unexpectedly\nsecret is x-match-secret: ${BOXSECRET}` }], secrets: [BOXSECRET] })
    const buf = fs.readFileSync(hb)
    eq((await call('POST', '/api/gs/telemetry', { raw: buf, headers: { 'x-match-secret': 'wrong', 'x-enw-bundle-id': b.bundle_id } })).status, 401)
    const ok = await call('POST', '/api/gs/telemetry', { raw: buf, headers: { 'x-match-secret': BOXSECRET, 'x-enw-bundle-id': b.bundle_id, 'x-enw-bundle-kind': 'host' } })
    eq(ok.status, 200, ok.text); truthy(ok.body.flags.includes('crash'))
    await store.idle()
    const row = incidents.byRowId(ok.body.id)
    eq(row.box, 'box-t'); eq(row.steam_id, null); truthy(row.bucket_key.startsWith('logs/host/'), row.bucket_key); has(row.bucket_key, '/box-t/')
    lacks(row.hits, BOXSECRET)
    const cl = path.join(TMP, 'clientkind.tar.gz')
    const c = await writeBundle(cl, { manifest: { kind: 'client', reason: 'x' }, files: [] })
    eq((await call('POST', '/api/gs/telemetry', { raw: fs.readFileSync(cl), headers: { 'x-match-secret': BOXSECRET, 'x-enw-bundle-id': c.bundle_id } })).status, 400, 'a box cannot send a client bundle')
  })

  // ---- 5. the admin routes ---------------------------------------------------------------
  await check('admin: the Issues routes are mod-guarded (401/403) and the digest is admin-only', async () => {
    for (const [m, p] of [['GET', '/api/admin/incidents'], ['GET', '/api/admin/incidents/rules'], ['GET', `/api/admin/incidents/${first.body.id}`], ['GET', `/api/admin/incidents/${first.body.id}/brief`], ['GET', `/api/admin/incidents/${first.body.id}/bundle`], ['POST', `/api/admin/incidents/${first.body.id}/review`], ['POST', '/api/admin/incidents/digest']]) {
      eq((await call(m, p, { body: m === 'POST' ? {} : null })).status, 401, `${m} ${p} signed out`)
      eq((await call(m, p, { as: PLAYER, body: m === 'POST' ? {} : null })).status, 403, `${m} ${p} player`)
    }
    eq((await call('POST', '/api/admin/incidents/digest', { as: MOD, body: {} })).status, 403, 'digest is admin-only')
  })
  await check('admin: list — filters, facets, the unreviewed P1/P2 count; the Now page carries it', async () => {
    const all = await call('GET', '/api/admin/incidents?size=100', { as: MOD })
    eq(all.status, 200); truthy(all.body.total >= 4, `total ${all.body.total}`)
    truthy(all.body.facets.flags.some((f) => f.flag === 'crash' && f.label === 'Crash' && f.severity === 1), 'crash facet')
    truthy(all.body.facets.people.some((p) => p.who === PLAYER && p.name === 'player'), 'people facet')
    truthy(all.body.facets.people.some((p) => p.who === 'box-t'), 'box in the people facet')
    truthy(all.body.unreviewed.p1 >= 2, 'unreviewed p1')
    const crash = await call('GET', '/api/admin/incidents?flag=crash&kind=host', { as: MOD })
    eq(crash.body.total, 1); eq(crash.body.rows[0].box, 'box-t'); eq(crash.body.rows[0].who, null)
    const byWho = await call('GET', `/api/admin/incidents?who=${PLAYER}&severity=1&sort=size&dir=asc`, { as: MOD })
    truthy(byWho.body.rows.length >= 1 && byWho.body.rows.every((r) => r.steam_id === PLAYER && r.severity === 1), 'who + severity filter')
    const now1 = await call('GET', '/api/admin', { as: MOD })
    truthy(now1.body.counts.incidents_p1 >= 2, 'Now: incidents_p1')
  })
  await check('admin: detail has hits with excerpts, files, manifest, a download URL', async () => {
    const d = await call('GET', `/api/admin/incidents/${first.body.id}`, { as: MOD })
    eq(d.status, 200)
    const it = d.body.incident
    truthy(it.hits.crash.excerpts.length, 'crash excerpts'); truthy(it.files.some((f) => f.name === 'CoDWaW.exe.4242.dmp'), 'files'); eq(it.manifest.pid, 4242)
    truthy(/^https:\/\/enw-zombies\.nbg1\.your-objectstorage\.com\/logs\/client\//.test(it.download), it.download)
    eq((await call('GET', '/api/admin/incidents/999999', { as: MOD })).status, 404)
  })
  await check('admin: the AI brief — metadata, summary, every flag, the lines around it, under 60 KB, no secrets', async () => {
    const b = await call('GET', `/api/admin/incidents/${first.body.id}/brief`, { as: MOD })
    eq(b.status, 200); has(b.headers['content-type'], 'text/plain')
    for (const s of ['ENW Zombies incident #', 'P1 crash/hang', 'launcher: 0.2.25', 'SUMMARY:', '=== FLAG crash', '=== FLAG com_error', 'UNHANDLED EXCEPTION', 'EXE_ERR_SERVER_TIMEOUT', 'DLL session:']) has(b.text, s)
    truthy(b.text.length <= 61 * 1024, `brief ${b.text.length} bytes`)
    lacks(b.text, INVITE.slice(0, 30)); lacks(b.text, 'z'.repeat(40))
  })
  await check('admin: review is saved and audit-logged; reopen clears it', async () => {
    const r = await call('POST', `/api/admin/incidents/${first.body.id}/review`, { as: MOD, body: { reviewed: true, bug: 'bug 21: crash in CL_ParseSnapshot on fear_mc_2', note: 'asked Dexter' } })
    eq(r.status, 200); eq(r.body.incident.reviewed, true); eq(r.body.incident.bug, 'bug 21: crash in CL_ParseSnapshot on fear_mc_2'); eq(r.body.incident.reviewed_by.steam_id, MOD)
    const log = db.prepare("SELECT * FROM activity_log WHERE event='incident.review' ORDER BY id DESC").get()
    truthy(log && log.actor === MOD, 'audit row')
    const open = await call('POST', `/api/admin/incidents/${first.body.id}/review`, { as: MOD, body: { reviewed: false } })
    eq(open.body.incident.reviewed, false); eq(open.body.incident.bug, 'bug 21: crash in CL_ParseSnapshot on fear_mc_2', 'bug line kept')
  })
  await check('admin: bundle download 302s to the bucket once uploaded; served from disk while pending', async () => {
    const d = await call('GET', `/api/admin/incidents/${first.body.id}/bundle`, { as: MOD })
    eq(d.status, 302); has(d.headers.location, 'enw-zombies.nbg1')
    // A bundle whose upload failed stays on disk and is served from there.
    store._setPut(async () => { throw new Error('bucket down') })
    const again = path.join(TMP, 'b2.tar.gz')
    await writeBundle(again, { manifest: { kind: 'client', reason: 'game_exit' }, files: [{ name: 'enw-5.log', text: 'hi' }] })
    const r = await call('POST', '/api/telemetry/upload', { as: MOD, raw: fs.readFileSync(again), headers: { 'x-enw-bundle-id': 'e'.repeat(32) } })
    eq(r.status, 200, r.text)
    await store.idle()
    const row = incidents.byRowId(r.body.id)
    eq(row.upload_state, 'failed'); has(row.upload_error, 'bucket down'); truthy(fs.existsSync(row.local_path), 'kept on disk')
    const dl = await call('GET', `/api/admin/incidents/${row.id}/bundle`, { as: MOD })
    eq(dl.status, 200); eq(dl.headers['content-type'], 'application/gzip')
    store._setPut(async (key, { file, body }) => { bucket.set(key, file ? fs.readFileSync(file) : body); return { key, url: `https://enw-zombies.nbg1.your-objectstorage.com/${key}` } })
    eq(store.retryAll() >= 1, true, 'retry picks it up')
    await store.idle()
    eq(incidents.byRowId(row.id).upload_state, 'uploaded', 'uploaded on retry')
  })
  await check('admin: the digest groups the day by flag and goes to logs/digest/<date>.json', async () => {
    const r = await call('POST', '/api/admin/incidents/digest', { as: ADMIN, body: {} })
    eq(r.status, 200, r.text)
    const date = new Date().toISOString().slice(0, 10)
    eq(r.body.key, `logs/digest/${date}.json`)
    const d = JSON.parse(bucket.get(r.body.key).toString())
    truthy(d.total >= 4, 'total'); eq(d.groups[0].severity, 1)
    truthy(d.groups.some((g) => g.flag === 'crash' && g.count >= 2 && g.incidents[0].admin.startsWith('/admin?tab=issues&incident=')), 'crash group')
  })

  // ---- 6. the site's own incidents -------------------------------------------------------
  await check('site: a thrown route is a 500 JSON answer and one site_5xx incident; repeats coalesce', async () => {
    const a = await call('GET', '/boom')
    eq(a.status, 500); has(a.text, 'logged')
    await call('GET', '/boom')
    const rows = db.prepare("SELECT * FROM incidents WHERE kind='site' AND reason='site_5xx'").all()
    eq(rows.length, 1, 'one incident'); eq(rows[0].count, 2, 'counted twice'); eq(rows[0].severity, 2)
    truthy(JSON.parse(rows[0].flags).includes('site_5xx'))
  })
  await check('site: recordSite coalesces by fingerprint and a new message is a new incident', () => {
    const a = incidents.recordSite({ reason: 'site_error', fingerprint: 'x1', notes: '[gs] result ingest failed: boom', lines: ['l1', 'l2'] })
    const b = incidents.recordSite({ reason: 'site_error', fingerprint: 'x1', notes: '[gs] result ingest failed: boom', lines: ['l3'] })
    eq(a.id, b.id); eq(b.count, 2)
    const c = incidents.recordSite({ reason: 'uncaught', fingerprint: 'x2', notes: 'TypeError: boom', lines: [] })
    truthy(c.id !== a.id); eq(c.severity, 1); truthy(JSON.parse(c.flags).includes('site_crash'))
  })
  await check('site: the nightly site-log bundle is flagged, stored and uploaded', async () => {
    const jobs = require('../server/lib/telemetry/jobs')
    fs.mkdirSync(siteLog.LOG_DIR, { recursive: true })
    const day = '2026-09-22'
    fs.writeFileSync(path.join(siteLog.LOG_DIR, `site-${day}.log`), `2026-09-22T10:00:00Z info  hello\n2026-09-22T10:00:01Z error [gs] result ingest failed: nope password=${process.env.ZM_SITE_PASSWORD}\n`)
    const r = await jobs.uploadSiteLog(day)
    truthy(r.id, 'incident id')
    await store.idle()
    const row = incidents.byRowId(r.id)
    eq(row.kind, 'site'); eq(row.reason, 'site_daily'); eq(row.upload_state, 'uploaded')
    truthy(row.bucket_key.startsWith(`logs/site/${day}/site/`), row.bucket_key)
    const back = {}
    await tar.readTarGz(require('stream').Readable.from([bucket.get(row.bucket_key)]), (e) => { if (e.data) { back[e.name] = e.data.toString(); return } return { max: 1e6 } })
    lacks(back[`files/site-${day}.log`], process.env.ZM_SITE_PASSWORD)
  })

  // ---- 7. the other two lanes' real upload code against these real routes ---------------
  await check('cross-lane: the launcher SiteApi.uploadBundle -> /api/telemetry/upload (cookie, streamed, no content-length surprises)', async () => {
    const { SiteApi } = await import('../../launcher/src/main/siteapi.js')
    const lb = path.join(TMP, 'from-launcher.tar.gz')
    const b = await writeBundle(lb, { manifest: { kind: 'client', reason: 'game_crash', map: 'nazi_zombie_prototype' },
      files: [{ name: 'enw-4242.log', text: '[1] [ERROR] overlay_guard: UNHANDLED EXCEPTION 0xC0000005 at 0x0041A2B3' }] })
    const api = new SiteApi({ baseUrl: `http://127.0.0.1:${port}`, appVersion: '9.9.9', cookieProvider: async () => `zm_test=${NEWBIE}` })
    const r = await api.uploadBundle(lb, { bundleId: b.bundle_id, kind: 'client', reason: 'game_crash' })
    eq(r.status, 200, r.text); truthy(r.data.flags.includes('crash'), String(r.data.flags)); eq(r.data.severity, 1)
    const again = await api.uploadBundle(lb, { bundleId: b.bundle_id, kind: 'client', reason: 'game_crash' })
    eq(again.status, 200); eq(again.data.duplicate, true)
    const out401 = await new SiteApi({ baseUrl: `http://127.0.0.1:${port}` }).uploadBundle(lb, { bundleId: b.bundle_id, kind: 'client', reason: 'game_crash' })
    eq(out401.status, 401, 'signed out: 401, the launcher keeps it')
    await store.idle()
    const row = incidents.byRowId(r.data.id)
    eq(row.steam_id, NEWBIE); truthy(row.bucket_key.startsWith('logs/client/'), row.bucket_key); eq(row.upload_state, 'uploaded')
  })
  await check('cross-lane: the host agent SiteClient.uploadTelemetry -> /api/gs/telemetry (x-match-secret, throttled stream)', async () => {
    const { SiteClient } = await import('../../infra/host-agent/lib/siteclient.js')
    const hb = path.join(TMP, 'from-host.tar.gz')
    const b = await writeBundle(hb, { manifest: { kind: 'host', reason: 'pull_failed', match_id: 'm_x1', map: 'nazi_zombie_pull' },
      files: [{ name: 'host-lease.log', text: '2026-09-23T12:00:00.000Z error host lease m_x1: could not prepare nazi_zombie_pull: sha256 mismatch' }] })
    const quiet = { debug () {}, info () {}, warn () {}, error () {}, child () { return quiet } }
    const sc = new SiteClient({ base: `http://127.0.0.1:${port}`, secret: BOXSECRET, boxName: 'box-t', log: quiet })
    const r = await sc.uploadTelemetry(hb, { bundleId: b.bundle_id, kind: 'host', reason: 'pull_failed' })
    eq(r.status, 200, r.text); truthy(r.json.flags.includes('host_pull_failed'), String(r.json.flags)); eq(r.json.severity, 2)
    const bad = await new SiteClient({ base: `http://127.0.0.1:${port}`, secret: 'wrong', log: quiet }).uploadTelemetry(hb, { bundleId: b.bundle_id, kind: 'host', reason: 'pull_failed' })
    eq(bad.status, 401)
    await store.idle()
    const row = incidents.byRowId(r.json.id)
    eq(row.box, 'box-t'); truthy(row.bucket_key.startsWith('logs/host/') && row.bucket_key.includes('/box-t/'), row.bucket_key)
  })

  // Close the sockets the launcher's fetch (undici) kept alive before exiting: a
  // process.exit with them still open trips a libuv assertion on Windows (exit 127).
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\ntelemetry: ${pass} passed, ${fail} failed`)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exitCode = fail ? 1 : 0
  setTimeout(() => process.exit(process.exitCode), 5000).unref()
}

main().catch((e) => { console.error(e); process.exit(1) })
