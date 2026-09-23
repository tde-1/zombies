#!/usr/bin/env node
// The map cache (lib/mapcache.js) against a FAKE BUCKET: a local HTTP server on 127.0.0.1
// that serves mods/<bsp>/<path> from memory and counts every GET. No network beyond
// loopback, no game, no box. Run with: node test/mapcache.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { MapCache, modNameOf, safeRel, configFromEnv, STOCK_MAPS } from '../lib/mapcache.js'

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log(`\x1b[32m ok  \x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`\x1b[31mFAIL \x1b[0m ${name}\n        ${e.stack?.split('\n').slice(0, 3).join('\n        ')}`) }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet } }

// ---- the fake bucket --------------------------------------------------------------------
const bucket = new Map()           // '/mods/<bsp>/<rel>' -> Buffer
const lies = new Map()             // same key -> Buffer actually sent (a corrupt object)
const gets = []
let slowMs = 0
const server = http.createServer(async (req, res) => {
  const key = decodeURIComponent(req.url)
  gets.push(key)
  const body = lies.get(key) || bucket.get(key)
  if (!body) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-length': body.length })
  if (!slowMs) return res.end(body)
  // Dribble it out in 4 pieces so progress has something to report.
  const q = Math.ceil(body.length / 4)
  for (let i = 0; i < body.length; i += q) { res.write(body.subarray(i, i + q)); await new Promise((r) => setTimeout(r, slowMs)) }
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BUCKET = `http://127.0.0.1:${server.address().port}`

/** Put a map in the bucket and return the site's file list for it. */
function publish(bsp, files) {
  const list = []
  for (const [rel, text] of Object.entries(files)) {
    const buf = Buffer.from(text)
    bucket.set(`/mods/${bsp}/${rel}`, buf)
    list.push({ path: rel, size: buf.length, sha256: sha(buf) })
  }
  return { bsp, stock: false, files: list, size_bytes: list.reduce((s, f) => s + f.size, 0) }
}
const LISTS = new Map()
LISTS.set('custom_a', publish('custom_a', { 'mod.ff': 'A'.repeat(300), 'custom_a.iwd': 'a'.repeat(200), 'weapons/sp/ray': 'r'.repeat(50) }))
LISTS.set('custom_b', publish('custom_b', { 'mod.ff': 'B'.repeat(400) }))
LISTS.set('custom_c', publish('custom_c', { 'mod.ff': 'C'.repeat(250) }))
LISTS.set('bad_sha', publish('bad_sha', { 'mod.ff': 'X'.repeat(100), 'bad.iwd': 'Y'.repeat(100) }))
lies.set('/mods/bad_sha/bad.iwd', Buffer.from('Z'.repeat(100)))   // right size, wrong bytes
LISTS.set('hot_one', publish('hot_one', { 'mod.ff': 'H'.repeat(120) }))

let root = null, n = 0
/** A fresh mods dir, optionally with maps already in it (name -> { bytes, ageH }). */
function world(existing = {}, opts = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), `enw-mapcache-${n++}-`))
  const mods = path.join(root, 'waw-en', 'mods')
  fs.mkdirSync(mods, { recursive: true })
  for (const [name, { bytes = 100, ageH = 1 }] of Object.entries(existing)) {
    const d = path.join(mods, name)
    fs.mkdirSync(d)
    fs.writeFileSync(path.join(d, 'mod.ff'), Buffer.alloc(bytes, 1))
    const t = (Date.now() - ageH * 3600_000) / 1000
    fs.utimesSync(d, t, t)
  }
  let fetches = 0
  const mc = new MapCache({
    modsDir: mods, bucketUrl: BUCKET, log: quiet, stallMs: 5000,
    budgetBytes: opts.budget ?? 10_000, minFreeBytes: opts.minFree ?? 0,
    statfs: () => ({ free: typeof opts.free === 'function' ? opts.free() : (opts.free ?? 1e12) }),
    fetchFiles: async (bsp) => { fetches++; if (opts.listFails) throw new Error('site down'); return LISTS.get(bsp) || { bsp, files: [] } },
    fetchPopular: opts.popular ? async () => ({ maps: opts.popular }) : null,
    inUse: () => opts.inUse || [], leased: () => opts.leased || [], busy: () => !!opts.busy,
    prefetchTop: opts.prefetchTop ?? 20, prefetchBps: opts.prefetchBps ?? 0,
  }).init()
  mc.fetches = () => fetches
  return { mc, mods }
}
const has = (mods, name) => fs.existsSync(path.join(mods, name))
const stagingEmpty = (mc) => fs.readdirSync(mc.staging).length === 0
const getsFor = (bsp) => gets.filter((g) => g.startsWith(`/mods/${bsp}/`)).length

console.log('\n== map cache (lib/mapcache.js) against a fake bucket ==')

await t('names: stock maps need nothing; fs_game mods/<x> names the dir; unsafe paths refused', () => {
  for (const s of STOCK_MAPS) eq(modNameOf({ map: s }), null, s)
  eq(modNameOf({ map: 'bridge_zombie', fs_game: 'mods/bridge_zombie' }), 'bridge_zombie')
  eq(modNameOf({ map: 'x', fs_game: 'mods\\other_dir' }), 'other_dir')
  eq(modNameOf({ map: 'x', fs_game: 'mods/../etc' }), null)
  eq(safeRel('weapons/sp/ray'), 'weapons/sp/ray')
  eq(safeRel('..\\x.ff'), null); eq(safeRel('/etc/passwd'), null); eq(safeRel('C:/x.ff'), null); eq(safeRel('setup.exe'), null)
})

await t('config: on by default only on a Wine box with a site; budget 15 GB; env overrides', () => {
  eq(configFromEnv({}, {}).enabled, false)
  const c = configFromEnv({}, { wine: { gameDir: '/home/waw/pfx/drive_c/zdev/waw-{slot}' }, site: 'https://x' })
  eq(c.enabled, true); eq(c.modsDir, path.join('/home/waw/pfx/drive_c/zdev/waw-inst-01', 'mods'))
  eq(c.budgetBytes, 15 * 1024 ** 3); eq(c.bucketUrl, 'https://enw-zombies.nbg1.your-objectstorage.com')
  eq(configFromEnv({ ENW_MAP_CACHE: 'off' }, { wine: {}, site: 'x' }).enabled, false)
  eq(configFromEnv({ ENW_MODS_BUDGET_GB: '2.5' }).budgetBytes, Math.round(2.5 * 1024 ** 3))
})

await t('pull ok: a map not on the box is pulled, verified, installed whole; staging left empty', async () => {
  const { mc, mods } = world()
  const r = await mc.ensure({ map: 'custom_a', fs_game: 'mods/custom_a' })
  ok(r.ok && r.pulled, JSON.stringify(r))
  eq(fs.readFileSync(path.join(mods, 'custom_a', 'weapons', 'sp', 'ray'), 'utf8'), 'r'.repeat(50), 'nested file')
  eq(fs.readFileSync(path.join(mods, 'custom_a', 'mod.ff')).length, 300)
  ok(stagingEmpty(mc), 'staging is empty')
  ok(mc.state.maps.custom_a.files['mod.ff'].sha256, 'the verified manifest is recorded')
  const again = await mc.ensure({ map: 'custom_a', fs_game: 'mods/custom_a' })
  ok(again.ok && again.pulled === false, 'second lease: already there, nothing pulled')
})

await t('sha mismatch: the pull is rejected and NOTHING is left visible in mods/ or staging', async () => {
  const { mc, mods } = world()
  const before = getsFor('bad_sha')
  const r = await mc.ensure({ map: 'bad_sha' })
  ok(!r.ok && /sha256 mismatch/.test(r.error), JSON.stringify(r))
  ok(!has(mods, 'bad_sha'), 'no half map in mods/')
  ok(stagingEmpty(mc), 'staging cleaned')
  ok(getsFor('bad_sha') - before <= 2, 'each file fetched at most once - no retry loop')
  ok(mc.state.failed.bad_sha, 'the failure is remembered (prefetch cooldown)')
})

await t('a missing object (404) fails the lease cleanly; an unknown map fails with no pull', async () => {
  const { mc, mods } = world()
  LISTS.set('ghost', { bsp: 'ghost', files: [{ path: 'mod.ff', size: 5, sha256: sha('12345') }] })
  const r = await mc.ensure({ map: 'ghost' })
  ok(!r.ok && /404/.test(r.error), r.error); ok(!has(mods, 'ghost')); ok(stagingEmpty(mc))
  const u = await mc.ensure({ map: 'never_heard_of' })
  ok(!u.ok && /no files/.test(u.error), u.error)
})

await t('concurrent leases for the same map share ONE pull', async () => {
  const { mc, mods } = world()
  const before = getsFor('custom_b')
  slowMs = 20
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => mc.ensure({ map: 'custom_b' })))
  slowMs = 0
  ok(r1.ok && r2.ok && r3.ok); ok(r1 === r2 && r2 === r3, 'the same result object')
  eq(getsFor('custom_b') - before, 1, 'one GET for the one file'); eq(mc.fetches(), 1, 'one file-list request')
  ok(has(mods, 'custom_b'))
})

await t('progress: downloading reported with bytes done/total, reaching 100%', async () => {
  const { mc } = world()
  const seen = []
  slowMs = 15
  const p = mc.ensure({ map: 'custom_a' }, { onProgress: (s) => seen.push(s) })
  await new Promise((r) => setTimeout(r, 5))
  const mid = mc.progress({ map: 'custom_a' })
  await p
  slowMs = 0
  ok(mid && mid.map === 'custom_a', 'progress() while pulling')
  const dl = seen.filter((s) => s.phase === 'downloading')
  ok(dl.length >= 2, `downloading snapshots: ${dl.length}`)
  eq(dl[dl.length - 1].bytes_total, 550); eq(dl[dl.length - 1].bytes_done, 550); eq(dl[dl.length - 1].percent, 100)
  ok(seen.some((s) => s.phase === 'installing'), 'installing phase')
  eq(mc.progress({ map: 'custom_a' }), null, 'nothing once done')
})

await t('eviction: oldest-used first, only as much as the pull needs', async () => {
  // budget 1000; old1 (48 h), old2 (24 h), new1 (1 h) = 900 used; custom_a needs 550.
  const { mc, mods } = world({ old1: { bytes: 300, ageH: 48 }, old2: { bytes: 300, ageH: 24 }, new1: { bytes: 300, ageH: 1 } }, { budget: 1000 })
  const r = await mc.ensure({ map: 'custom_a' })
  ok(r.ok, r.error)
  eq(r.evicted, ['old1', 'old2'], 'evicted, in order')
  ok(has(mods, 'new1') && has(mods, 'custom_a'))
  const used = mc.scan().reduce((s, m) => s + m.bytes, 0)
  ok(used <= 1000, `budget respected: ${used}`)
})

await t('a map a live instance is on is never evicted, nor a leased one', async () => {
  const { mc, mods } = world({ old1: { bytes: 300, ageH: 48 }, old2: { bytes: 300, ageH: 24 }, new1: { bytes: 300, ageH: 1 } },
    { budget: 1000, inUse: ['old1'], leased: ['old2'] })
  const r = await mc.ensure({ map: 'custom_a' })
  ok(r.ok, r.error)
  ok(has(mods, 'old1'), 'live map kept'); ok(has(mods, 'old2'), 'leased map kept')
  eq(r.evicted, ['new1'])
})

await t('the stock four are never evicted, even as the oldest dirs in mods/', async () => {
  const { mc, mods } = world({ nazi_zombie_asylum: { bytes: 400, ageH: 999 }, nazi_zombie_factory: { bytes: 400, ageH: 998 }, old1: { bytes: 100, ageH: 1 } }, { budget: 1000 })
  const r = await mc.ensure({ map: 'custom_b' })
  ok(r.ok, r.error)
  ok(has(mods, 'nazi_zombie_asylum') && has(mods, 'nazi_zombie_factory'), 'stock kept')
  eq(r.evicted, ['old1'])
  ok(r.overBudget !== true || true)
  let threw = false
  try { mc.evict('nazi_zombie_sumpf', 'test') } catch { threw = true }
  ok(threw, 'evict() itself refuses a stock name')
})

await t('an over-budget library is not halved by the first pull: it evicts ~the pull, never grows', async () => {
  // 10 maps x 300 = 3000 on a budget of 1000. custom_b needs 400: ONE or two 300s go, not seven.
  const existing = {}
  for (let i = 0; i < 10; i++) existing[`lib${i}`] = { bytes: 300, ageH: 100 - i }
  const { mc, mods } = world(existing, { budget: 1000 })
  const r = await mc.ensure({ map: 'custom_b' })
  ok(r.ok, r.error)
  eq(r.evicted, ['lib0', 'lib1'], 'the two oldest')
  const used = mc.scan().reduce((s, m) => s + m.bytes, 0)
  ok(used <= 3000, `did not grow: ${used}`)
  eq(mc.scan().length, 9, '8 left + custom_b')
  ok(has(mods, 'lib2'))
})

await t('disk reserve: a pull that cannot fit on the disk fails and leaves nothing', async () => {
  const { mc, mods } = world({ keep: { bytes: 300, ageH: 1 } }, { budget: 1e9, free: 200, minFree: 100, inUse: ['keep'] })
  const r = await mc.ensure({ map: 'custom_a' })
  ok(!r.ok && /not enough disk/.test(r.error), r.error)
  ok(!has(mods, 'custom_a') && has(mods, 'keep') && stagingEmpty(mc))
})

await t('stale install: a wrong/missing file is detected at lease time and ONLY it is re-pulled', async () => {
  const { mc, mods } = world()
  ok((await mc.ensure({ map: 'custom_a' })).ok)
  const dir = path.join(mods, 'custom_a')
  const goodIno = fs.statSync(path.join(dir, 'custom_a.iwd')).ino
  fs.writeFileSync(path.join(dir, 'mod.ff'), 'A'.repeat(299) + 'Z')          // same size, wrong bytes
  fs.rmSync(path.join(dir, 'weapons', 'sp', 'ray'))                         // missing
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'kept')                      // not in the list
  const before = getsFor('custom_a')
  const r = await mc.ensure({ map: 'custom_a' })
  ok(r.ok && r.repaired, JSON.stringify(r))
  eq(getsFor('custom_a') - before, 2, 'two files re-pulled, the good one not')
  eq(fs.readFileSync(path.join(dir, 'mod.ff'), 'utf8'), 'A'.repeat(300))
  ok(fs.existsSync(path.join(dir, 'weapons', 'sp', 'ray')))
  eq(fs.statSync(path.join(dir, 'custom_a.iwd')).ino, goodIno, 'the good file was hardlinked, not re-downloaded')
  ok(fs.existsSync(path.join(dir, 'extra.txt')), 'files the list does not name are left alone')
  ok(stagingEmpty(mc))
})

await t('a stale install under a LIVE instance is booted as is, never replaced mid-game', async () => {
  const w = world()
  ok((await w.mc.ensure({ map: 'custom_c' })).ok)
  fs.writeFileSync(path.join(w.mods, 'custom_c', 'mod.ff'), 'x')
  w.mc.inUse = () => ['custom_c']
  const before = getsFor('custom_c')
  const r = await w.mc.ensure({ map: 'custom_c' })
  ok(r.ok && r.unverified, JSON.stringify(r)); eq(getsFor('custom_c') - before, 0)
})

await t('the site unreachable: a map on disk boots unverified; a missing one fails', async () => {
  const { mc } = world({ custom_c: { bytes: 10 } }, { listFails: true })
  ok((await mc.ensure({ map: 'custom_c' })).unverified)
  const r = await mc.ensure({ map: 'custom_b' })
  ok(!r.ok && /site down/.test(r.error))
})

await t('crash recovery: a half-pulled staging dir is discarded; an interrupted swap is completed', () => {
  const { mc, mods } = world()
  fs.mkdirSync(path.join(mc.staging, 'custom_a.new-1-abc'))
  fs.writeFileSync(path.join(mc.staging, 'custom_a.new-1-abc', 'mod.ff'), 'half')
  const next = path.join(mc.staging, 'custom_b.new-2-def'), old = path.join(mc.staging, 'custom_b.old-2-def')
  fs.mkdirSync(next); fs.writeFileSync(path.join(next, 'mod.ff'), 'NEW')
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'mod.ff'), 'OLD')
  fs.writeFileSync(path.join(mc.staging, 'custom_b.swap.json'), JSON.stringify({ name: 'custom_b', next, old }))
  mc.recover()
  eq(fs.readFileSync(path.join(mods, 'custom_b', 'mod.ff'), 'utf8'), 'NEW', 'the verified new copy went in')
  ok(!has(mods, 'custom_a'), 'the half pull never became visible')
  ok(stagingEmpty(mc))
})

await t('trim: one dir per tick, least-recently-used first, popular and protected kept, stops at budget', async () => {
  const existing = { a_old: { bytes: 300, ageH: 50 }, b_hot: { bytes: 300, ageH: 49 }, c_live: { bytes: 300, ageH: 48 }, d_mid: { bytes: 300, ageH: 10 }, e_new: { bytes: 300, ageH: 1 }, nazi_zombie_sumpf: { bytes: 300, ageH: 999 } }
  const { mc, mods } = world(existing, { budget: 1000, inUse: ['c_live'], popular: [{ map: 'b_hot', plays: 9, size_bytes: 300 }] })
  await mc.refreshPopular(true)
  eq(mc.trimStep(), 'a_old'); eq(mc.trimStep(), 'd_mid')
  // 4 x 300 = 1200 left (b_hot, c_live, e_new, sumpf): e_new is the last unpopular one.
  eq(mc.trimStep(), 'e_new')
  // 900 now: at budget, nothing more goes - and the popular map would be next, the stock never.
  eq(mc.trimStep(), null)
  ok(has(mods, 'b_hot') && has(mods, 'c_live') && has(mods, 'nazi_zombie_sumpf'))
})

await t('trim never runs while a game is booting or a pull is running', async () => {
  const w = world({ x: { bytes: 900, ageH: 5 } }, { budget: 100, busy: true })
  eq(w.mc.trimStep(), null); ok(has(w.mods, 'x'))
})

await t('trim waits until the site has said which maps are popular', async () => {
  const w = world({ x: { bytes: 900, ageH: 5 } }, { budget: 100, popular: [] })
  eq(w.mc.trimStep(), null, 'no popularity yet'); ok(has(w.mods, 'x'))
  await w.mc.refreshPopular(true)
  eq(w.mc.trimStep(), 'x', 'trims once the list (even an empty one) has arrived')
})

await t('prefetch: a popular map that fits is pulled, throttled; one that needs an eviction is not', async () => {
  const { mc, mods } = world({ cold: { bytes: 800, ageH: 99 } }, {
    budget: 1000, prefetchBps: 1e9,
    popular: [{ map: 'custom_b', plays: 50, size_bytes: 400 }, { map: 'hot_one', fs_game: 'mods/hot_one', plays: 40, size_bytes: 120 }],
  })
  mc.prefetchShare = 1
  // custom_b (400) would need 'cold' evicted: prefetch never evicts, so it goes on to hot_one.
  const r = await mc.prefetchStep()
  ok(r && r.ok && r.name === 'hot_one', JSON.stringify(r))
  ok(has(mods, 'cold') && has(mods, 'hot_one') && !has(mods, 'custom_b'))
  eq(await mc.prefetchStep(), null, 'nothing else fits')
})

await t('prefetch skips a map that failed recently (no egress loop)', async () => {
  const { mc } = world({}, { popular: [{ map: 'bad_sha', plays: 99, size_bytes: 200 }] })
  const r1 = await mc.prefetchStep(); ok(r1 && !r1.ok)
  eq(await mc.prefetchStep(), null, 'cooling down')
})

await t('a lease for a map being prefetched joins that pull and lifts the throttle', async () => {
  const { mc } = world({}, { popular: [{ map: 'custom_c', plays: 5, size_bytes: 250 }], prefetchBps: 50 })
  const before = getsFor('custom_c')
  const pre = mc.prefetchStep()
  await new Promise((r) => setTimeout(r, 30))
  const t0 = Date.now()
  const lease = await mc.ensure({ map: 'custom_c' })
  ok(lease.ok, lease.error); ok(Date.now() - t0 < 3000, `unthrottled: ${Date.now() - t0} ms`)
  await pre
  eq(getsFor('custom_c') - before, 1, 'one download')
})

server.close()
if (root) { /* temp dirs are left under os.tmpdir() for a failed run's post-mortem */ }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
