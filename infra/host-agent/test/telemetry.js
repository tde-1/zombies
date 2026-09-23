#!/usr/bin/env node
// TELEMETRY on the box (lib/telemetry.js, host.md §15, telemetry.md §7).
//
//   (a) the three .cjs copies equal shared/telemetry/*.cjs byte for byte
//   (b) an instance end: secrets scrubbed, keys never bundled, manifest right, the ring
//       lines of THAT instance only
//   (c) upload against a stand-in site: headers + x-match-secret, 200 / 400 / 413 / 429 /
//       500, busy deferral, the throttle
//   (d) the daily journal on a platform without journalctl skips cleanly
//   (e) retention: a bundle past the keep window goes
//
//   node test/telemetry.js
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { makeLog, mkdirp } from '../lib/util.js'
import { Telemetry, BACKOFF_MS } from '../lib/telemetry.js'
import { SiteClient } from '../lib/siteclient.js'
import { readTarGz } from '../lib/telemetry/tar.cjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUN = mkdirp(path.join(os.tmpdir(), 'enw-telemetry-' + Date.now().toString(36)))
let pass = 0
let fail = 0
const ok = (c, m) => { if (c) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${m}`) } else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`) } }
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet } }

const SECRET = 'boxsecret-5f3a9c1e77d2'
const PRIV = 'hostPrivKeyRaw-QmFzZTY0VXJsU2VjcmV0'
const TOKEN = 'eyJzdGVhbWlkIjoiNzY1NjExOTgwMDAwMDAwMDEifQ.' + 'A'.repeat(86)

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(50) }
  return null
}

async function readBundle(file) {
  const out = {}
  await readTarGz(file, (e) => {
    if (e.data) { out[e.name] = e.data.toString('latin1'); return }
    return { max: 64 * 1024 * 1024 }
  })
  return out
}

// ---- (a) -------------------------------------------------------------------------------
console.log('\n── (a) the .cjs copies are byte-identical to shared/telemetry')
for (const f of ['bundle.cjs', 'scrub.cjs', 'tar.cjs']) {
  const mine = fs.readFileSync(path.join(ROOT, 'lib', 'telemetry', f))
  const canon = fs.readFileSync(path.join(ROOT, '..', '..', 'shared', 'telemetry', f))
  ok(Buffer.compare(mine, canon) === 0, `lib/telemetry/${f} == shared/telemetry/${f}`)
}

// ---- (b) -------------------------------------------------------------------------------
console.log('\n── (b) an instance end becomes a scrubbed bundle')
const T0 = Date.now()
const game = mkdirp(path.join(RUN, 'waw-inst-07'))
const keysDir = mkdirp(path.join(RUN, 'keys'))
fs.writeFileSync(path.join(keysDir, 'host-box.json'), JSON.stringify({ key_id: 'k', pub: 'p', priv: PRIV }))
fs.writeFileSync(path.join(RUN, 'enw-host.env'), `ENW_SECRET=${SECRET}\n`)
fs.writeFileSync(path.join(game, 'enw-2764.log'), [
  '=== enw_t4 log opened 2026-09-23 12:00:00  pid=2764 ===',
  `12:00:01 INFO  link: connecting with secret ${SECRET}`,
  `12:00:02 INFO  http: x-match-secret: ${SECRET}`,
  `12:00:03 INFO  something leaked the host key ${PRIV}`,
  `12:00:04 INFO  invite ${TOKEN}`,
  '12:00:05 INFO  map_loaded nazi_zombie_prototype',
].join('\n') + '\n')
const bigConsole = path.join(game, 'console.log')
fs.writeFileSync(bigConsole, 'x'.repeat(300_000) + '\nTHE LAST LINE\n')

const hlog = makeLog('host')
hlog.child('inst-07').info('booted inst-07 match=m_tel_a kind=game')
hlog.child('inst-08').info('booted inst-08 match=m_other kind=game')
hlog.info('instance inst-070 linked (pid 99)')
hlog.info('lease m_tel_a: nazi_zombie_prototype custom 1p')
hlog.child('inst-07').warn(`auth slot 0 with a token ${SECRET}`)
hlog.child('inst-08').info('something about inst-08 only')

const telDir = path.join(RUN, 'tel')
const tel = new Telemetry({
  dir: telDir, boxName: 'test-box', secrets: () => [SECRET, PRIV], forbiddenDirs: [keysDir],
  tickMs: 3_600_000, uploadTickMs: 3_600_000, tailBytes: 100_000, journal: false, log: quiet,
}).start()
const built = (n) => until(() => tel.sidecars().length >= n && tel.sidecars())
const id1 = await tel.instanceEnd({
  reason: 'instance_end', exit_reason: 'game_over', why: 'terminate: 5 games', match_id: 'm_tel_a', instance: 'inst-07',
  pid: 2764, linux_pid: 4242, map: 'nazi_zombie_prototype', mode: 'custom', since: T0 - 1000, duration_ms: 123456, exit_code: 0,
  summary: { match_id: 'm_tel_a', rounds: 7, end_reason: 'game_over', flags: [] },
  summary_line: 'SUMMARY nazi_zombie_prototype round 7 finish=none 2m03s flags=[] eligible=true',
  lease: { match_id: 'm_tel_a', map: 'nazi_zombie_prototype', tokens: { 76561198000000001: TOKEN } },
  dll_sha: 'ab'.repeat(32), dll_version: 'Sep 23 2026 12:44:00',
  logs: [
    { name: 'enw-2764.log', path: path.join(game, 'enw-2764.log') },
    { name: 'engine-console.log', path: bigConsole },
    { name: 'host-key.json', path: path.join(keysDir, 'host-box.json') },
    { name: 'enw-host.env', path: path.join(RUN, 'enw-host.env') },
    { name: 'missing.log', path: path.join(game, 'nope.log') },
  ],
  ring: { instance: 'inst-07', matches: ['m_tel_a'] },
  extraSecrets: [TOKEN],
})
ok(typeof id1 === 'string' && id1.length === 32, `staged, bundle id ${String(id1).slice(0, 8)}`)
const sides = await built(1)
ok(!!sides, 'built by the niced child process into the outbox')
const side1 = sides?.[0] || {}
const bfile = path.join(telDir, 'outbox', side1.file || 'x')
ok(fs.existsSync(bfile) && side1.attempts === 0 && side1.kind === 'host' && side1.reason === 'instance_end', 'sidecar: kind host, reason instance_end, attempts 0')
const B = fs.existsSync(bfile) ? await readBundle(bfile) : {}
const all = Object.values(B).join('\n')
const M = JSON.parse(B['manifest.json'] || '{}')
ok(!all.includes(SECRET), 'the box secret appears nowhere in the bundle')
ok(!all.includes(PRIV), 'the host private key appears nowhere in the bundle')
ok(!all.includes(TOKEN), 'the invite token appears nowhere in the bundle')
const dllLog = B['files/enw-2764.log'] || ''
ok(/x-match-secret: (<secret <redacted>>|<redacted>)/.test(dllLog), 'the x-match-secret line is redacted in the DLL log')
if (!/x-match-secret: (<secret <redacted>>|<redacted>)/.test(dllLog)) console.log(dllLog, Object.keys(B))
ok(!Object.keys(B).some((n) => /host-key\.json|host-box\.json|enw-host\.env/.test(n)), 'no key file and no enw-host.env in the archive')
const refused = (M.notes?.sources || []).filter((s) => s.refused).map((s) => s.name)
ok(refused.includes('host-key.json') && refused.includes('enw-host.env'), `keys dir and env file refused in the manifest (${refused.join(', ')})`)
ok((M.notes?.sources || []).some((s) => s.name === 'missing.log' && s.missing), 'a missing log is recorded as missing, not fatal')
ok(M.v === 1 && M.bundle_id === id1 && M.kind === 'host' && M.reason === 'instance_end', 'manifest v1, bundle_id, kind, reason')
ok(M.exit_reason === 'game_over' && M.match_id === 'm_tel_a' && M.instance === 'inst-07' && M.pid === 2764 && M.box === 'test-box', 'manifest exit_reason, match_id, instance, pid, box')
ok(M.summary_line?.startsWith('SUMMARY nazi_zombie_prototype round 7'), 'manifest.summary_line')
ok(M.dll_sha === 'ab'.repeat(32) && M.duration_ms === 123456, 'manifest dll_sha, duration_ms')
ok(M.host && M.host.mem_total_mb > 0 && Array.isArray(M.host.load) && (M.host.disk_free_gb == null || M.host.disk_free_gb >= 0), `manifest.host box health (${JSON.stringify(M.host)})`)
ok(M.scrub_hits && (M.scrub_hits.literal || 0) >= 3, `scrub hits recorded (${JSON.stringify(M.scrub_hits)})`)
const con = B['files/engine-console.log'] || ''
const conSrc = (M.notes?.sources || []).find((s) => s.name === 'engine-console.log')
ok(con.length <= 100_000 && con.endsWith('THE LAST LINE\n') && conSrc?.truncated === true && conSrc?.original_size > 300_000, 'a log is tailed (last bytes kept, truncation recorded)')
const ring = B['files/host-instance.log'] || ''
ok(/booted inst-07 match=m_tel_a/.test(ring) && /lease m_tel_a/.test(ring), 'the ring lines of inst-07 / m_tel_a are in host-instance.log')
ok(!/inst-08|m_other|inst-070/.test(ring), 'no other instance\'s ring lines (inst-08, inst-070) in host-instance.log')
ok(/auth slot 0 with a token <secret <redacted>>/.test(ring), 'a secret in a ring line is scrubbed too')
ok(/"tokens": "<redacted>"/.test(B['files/lease.json'] || ''), 'lease.json has its tokens redacted')
ok(JSON.parse(B['files/summary.json'] || '{}').rounds === 7, 'summary.json is the referee summary')
ok(!fs.readdirSync(path.join(telDir, 'staging')).some((d) => fs.readFileSync(path.join(telDir, 'staging', d, 'job.json'), 'utf8').includes(SECRET)), 'the job file on disk carries no secret')

// ---- (c) -------------------------------------------------------------------------------
console.log('\n── (c) upload against a stand-in site')
let answer = { status: 200, body: { ok: true, id: 'x', duplicate: false }, headers: {} }
const seen = []
const siteSrv = http.createServer((req, res) => {
  const h = crypto.createHash('sha256')
  let n = 0
  req.on('data', (d) => { h.update(d); n += d.length })
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, bytes: n, sha: h.digest('hex') })
    if (req.headers['x-match-secret'] !== SECRET) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad secret"}') }
    res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
    res.end(JSON.stringify(answer.body))
  })
})
await new Promise((r) => siteSrv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${siteSrv.address().port}`
const client = new SiteClient({ base, secret: SECRET, log: quiet })
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const setNextNow = (s) => tel.writeSidecar(path.join(telDir, 'outbox'), { ...JSON.parse(fs.readFileSync(path.join(telDir, 'outbox', `${s}.json`), 'utf8')), next_at: 0 })
const sideOf = (id, dir = 'outbox') => { try { return JSON.parse(fs.readFileSync(path.join(telDir, dir, `${id}.json`), 'utf8')) } catch { return null } }
async function newBundle(tag) {
  // Built with no site attached, so the pump that follows a build cannot send it before
  // the scenario has set the stand-in's answer.
  const site = tel.site
  tel.site = null
  const before = new Set(tel.sidecars().map((s) => s.bundle_id))
  const id = await tel.instanceEnd({ match_id: `m_${tag}`, instance: 'inst-09', since: Date.now() - 1000, exit_reason: 'retired', logs: [{ name: 'enw-2764.log', path: path.join(game, 'enw-2764.log') }] })
  await until(() => tel.sidecars().some((s) => s.bundle_id === id && !before.has(s.bundle_id)))
  tel.site = site
  return id
}

// busy: nothing leaves while a game boots
tel.site = client
let busy = true
tel.busy = () => busy
ok((await tel.uploadNext()) === false && seen.length === 0, 'busy (a game booting/preparing): no upload is attempted')
busy = false

// 200
const f1 = bfile
const f1sha = sha(f1)
const f1size = fs.statSync(f1).size
ok((await tel.uploadNext()) === true, '200: uploadNext says sent')
const s0 = seen.at(-1) || { headers: {} }
ok(s0.method === 'POST' && s0.url === '/api/gs/telemetry', 'POST /api/gs/telemetry')
ok(s0.headers['x-match-secret'] === SECRET, 'x-match-secret is the box secret')
ok(s0.headers['content-type'] === 'application/gzip' && Number(s0.headers['content-length']) === f1size && s0.bytes === f1size, `content-type application/gzip, content-length ${f1size} = bytes received`)
ok(s0.sha === f1sha, 'the body is the bundle file, byte for byte')
ok(s0.headers['x-enw-bundle-id'] === id1 && s0.headers['x-enw-bundle-kind'] === 'host' && s0.headers['x-enw-bundle-reason'] === 'instance_end', 'x-enw-bundle-id / -kind / -reason')
ok(!fs.existsSync(f1) && !sideOf(id1) && !fs.existsSync(side1.staging), '200: bundle, sidecar and staging deleted')

// 200 duplicate
const idDup = await newBundle('dup')
answer = { status: 200, body: { ok: true, id: 'x', duplicate: true }, headers: {} }
await tel.uploadNext()
ok(!sideOf(idDup), '200 duplicate: treated as sent')

// 400
const id400 = await newBundle('400')
answer = { status: 400, body: { ok: false, error: 'not a bundle' }, headers: {} }
await tel.uploadNext()
ok(!sideOf(id400) && sideOf(id400, 'rejected')?.last_error?.startsWith('400') && fs.existsSync(path.join(telDir, 'rejected', `${id400}.tar.gz`)), '400: moved to rejected/, not retried')
const n400 = seen.length
await tel.uploadNext()
ok(seen.length === n400, '400: a rejected bundle is never sent again')

// 413 -> rebuilt once, then rejected
const id413 = await newBundle('413')
answer = { status: 413, body: { ok: false, error: 'too big' }, headers: {} }
await tel.uploadNext()
const s413 = sideOf(id413)
ok(s413?.rebuilt === true && s413?.next_at <= Date.now() && fs.existsSync(path.join(telDir, 'outbox', `${id413}.tar.gz`)), '413: rebuilt once (smaller tails) and due again at once')
const reb = await readBundle(path.join(telDir, 'outbox', `${id413}.tar.gz`))
ok(JSON.parse(reb['manifest.json']).notes?.rebuilt_after_413 === true, '413: the rebuilt manifest says so')
await tel.uploadNext()
ok(!sideOf(id413) && sideOf(id413, 'rejected')?.last_error === '413 after a rebuild', '413 again after the rebuild: rejected/')

// 429 with Retry-After
const id429 = await newBundle('429')
answer = { status: 429, body: { ok: false, error: 'slow down' }, headers: { 'retry-after': '120' } }
const t429 = Date.now()
await tel.uploadNext()
const s429 = sideOf(id429)
ok(s429 && s429.attempts === 1 && Math.abs(s429.next_at - (t429 + 120_000)) < 5000, `429: Retry-After 120 s honoured (next in ${Math.round((s429?.next_at - t429) / 1000)} s)`)
const n429 = seen.length
await tel.uploadNext()
ok(seen.length === n429, '429: not sent again before Retry-After')

// 500 -> 1 m, then 5 m
setNextNow(id429)
answer = { status: 500, body: { ok: false, error: 'boom' }, headers: {} }
let t5 = Date.now()
await tel.uploadNext()
let s500 = sideOf(id429)
ok(s500 && s500.attempts === 2 && Math.abs(s500.next_at - (t5 + BACKOFF_MS[1])) < 5000, `500: backoff grows (attempt 2 -> ${Math.round((s500?.next_at - t5) / 60_000)} min)`)
setNextNow(id429)
t5 = Date.now()
await tel.uploadNext()
s500 = sideOf(id429)
ok(s500 && s500.attempts === 3 && Math.abs(s500.next_at - (t5 + BACKOFF_MS[2])) < 5000, `500 again: 30 min (attempt 3)`)
ok(JSON.stringify(BACKOFF_MS) === JSON.stringify([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]), 'the schedule is 1 m, 5 m, 30 m, 2 h, 6 h')

// site unreachable: stays in the outbox
tel.site = new SiteClient({ base: 'http://127.0.0.1:9', secret: SECRET, log: quiet })
setNextNow(id429)
await tel.uploadNext()
ok(sideOf(id429)?.attempts === 4 && /network/.test(sideOf(id429)?.last_error || ''), 'site unreachable: the bundle waits in the outbox (attempt 4)')

// the throttle
const big = path.join(RUN, 'big.bin')
fs.writeFileSync(big, crypto.randomBytes(600 * 1024))
answer = { status: 200, body: { ok: true }, headers: {} }
const tt = Date.now()
const rThr = await client.uploadTelemetry(big, { bundleId: 'b'.repeat(32), kind: 'host', reason: 'box_warning', bytesPerSec: 400 * 1024 })
const took = Date.now() - tt
ok(rThr.status === 200 && seen.at(-1).bytes === 600 * 1024 && took >= 1200, `throttle: 600 KB at 400 KB/s took ${took} ms (>= 1200)`)

// ---- (d) -------------------------------------------------------------------------------
console.log('\n── (d) the daily journal where there is no journalctl')
const noon = () => Date.parse('2026-09-23T12:00:00Z')
const tj = new Telemetry({ dir: path.join(RUN, 'tj'), platform: 'linux', journalctl: 'enw-no-such-journalctl-7f3e', now: noon, log: quiet, tickMs: 3_600_000, uploadTickMs: 3_600_000 }).start()
const rj = await tj.journalTick()
ok(rj?.skipped === 'no journalctl', `linux without journalctl: skipped (${JSON.stringify(rj)})`)
ok(fs.readdirSync(path.join(RUN, 'tj', 'staging')).length === 0 && tj.jobs.length === 0, 'nothing staged, nothing queued')
ok((await tj.journalTick())?.skipped === 'no journalctl', 'and it does not try again every minute')
tj.stop()
const tw = new Telemetry({ dir: path.join(RUN, 'tw'), platform: 'win32', now: noon, log: quiet, tickMs: 3_600_000, uploadTickMs: 3_600_000 }).start()
ok((await tw.journalTick())?.skipped === 'not linux (win32)', 'Windows: skipped')
tw.stop()
const early = new Telemetry({ dir: path.join(RUN, 'te'), platform: 'linux', journalctl: 'enw-no-such-journalctl-7f3e', now: () => Date.parse('2026-09-23T00:05:00Z'), log: quiet, tickMs: 3_600_000, uploadTickMs: 3_600_000 }).start()
ok((await early.journalTick()) === null, 'before 00:10 UTC: not due yet')
early.stop()

// ---- (e) -------------------------------------------------------------------------------
console.log('\n── (e) retention')
const idOld = await newBundle('old')
tel.writeSidecar(path.join(telDir, 'outbox'), { ...sideOf(idOld), created_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
const ret = await tel.retention()
ok(!sideOf(idOld) && sideOf(id429), `a bundle older than 7 days is dropped, a young one kept (${ret.dropped} dropped)`)
tel.maxBytes = 1
await tel.retention()
ok(tel.sidecars().length === 0, 'over the size cap: oldest first until under it')

tel.stop()
siteSrv.close()
console.log(`\n${fail ? '\x1b[31mFAIL' : '\x1b[32mPASS'}\x1b[0m telemetry: ${pass} passed, ${fail} failed (${RUN})`)
process.exit(fail ? 1 : 0)
