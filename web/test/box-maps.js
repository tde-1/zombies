'use strict'
// The site's half of the box's map cache (infra/host-agent/lib/mapcache.js, host.md
// "2026-09-23 - map cache"):
//
//   * GET /api/gs/map-files/:bsp and GET /api/gs/popular-maps, box-authenticated;
//   * a lease the box reports `preparing` is NOT reaped by the 90 s ghost reaper, and the
//     launcher's /play payload carries its progress (`match.preparing`);
//   * a box reporting `failed` ends a lease that never started - never a live one.
//
//   node test/box-maps.js
//
// A throwaway database and one Express app on 127.0.0.1; nothing else.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-boxmaps-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'
process.env.ZM_ARCHIVE = path.join(TMP, 'archive')      // an archive with one map in it
delete process.env.S3_BUCKET_MAPS

// The archive report mapfiles.js reads: one custom map with two files on "disk".
const ARCH = path.join(TMP, 'archive')
const DEST = path.join(ARCH, 'mods', 'custom_pop')
fs.mkdirSync(path.join(ARCH, 'reports'), { recursive: true })
fs.mkdirSync(DEST, { recursive: true })
fs.writeFileSync(path.join(DEST, 'mod.ff'), Buffer.alloc(1000, 1))
fs.writeFileSync(path.join(DEST, 'custom_pop.iwd'), Buffer.alloc(500, 2))
// 2026-09-23 asset audit: `..` inside a NAME is a file (Neon Fighter's `HarryBos Mysterybox Pack
// V1..0.0.iwd`), a `..` SEGMENT is traversal; loose `sound/**.wav` is served.
fs.writeFileSync(path.join(DEST, 'Pack V1..0.0.iwd'), Buffer.alloc(300, 3))
fs.mkdirSync(path.join(DEST, 'sound'), { recursive: true })
fs.writeFileSync(path.join(DEST, 'sound', 'box.wav'), Buffer.alloc(200, 4))
fs.writeFileSync(path.join(ARCH, 'mods', 'evil.ff'), Buffer.alloc(100, 5))
fs.writeFileSync(path.join(ARCH, 'reports', 'extract.json'), JSON.stringify([{ mods: [{
  bsp: 'custom_pop', dest: DEST,
  files: [{ path: 'mods/custom_pop/mod.ff', sha256: 'a'.repeat(64) }, { path: 'mods/custom_pop/custom_pop.iwd', sha256: 'b'.repeat(64) },
    { path: 'mods/custom_pop/Pack V1..0.0.iwd', sha256: 'c'.repeat(64) }, { path: 'mods/custom_pop/sound/box.wav', sha256: 'd'.repeat(64) },
    { path: 'mods/custom_pop/../evil.ff', sha256: 'e'.repeat(64) }],
}] }]))

const express = require('express')
const { db, now } = require('../server/db/database')
const maps = require('../server/lib/maps')
const boxes = require('../server/lib/boxes')
const assignments = require('../server/lib/assignments')
const parties = require('../server/lib/parties')
const users = require('../server/lib/users')

let pass = 0
let fail = 0
async function check (name, fn) {
  try { await fn(); pass++; console.log(`ok    ${name}`) } catch (e) { fail++; console.log(`FAIL  ${name} — ${e.message}`) }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

function addMap (key, source = 'custom') {
  maps.SERVER_PROVEN.add(key)
  db.prepare(`INSERT INTO maps (key, slug, title, source, health, round_n, added_at) VALUES (?,?,?,?, 'verified', 20, ?)`).run(key, key, key, source, now())
  const m = db.prepare('SELECT id FROM maps WHERE key=?').get(key)
  db.prepare("INSERT INTO map_versions (map_id, version, latest, health, fs_game, added_at) VALUES (?, '1.0', 1, 'verified', ?, ?)")
    .run(m.id, source === 'stock' ? null : `mods/${key}`, now())
}

async function main () {
  addMap('custom_pop'); addMap('custom_rare'); addMap('custom_agent'); addMap('nazi_zombie_asylum', 'stock')
  for (const sid of ['76561198000000001', '76561198000000002', '76561198000000003']) {
    users.ensure(sid, { username: 'u' + sid.slice(-1) })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(sid)
  }
  boxes.create({ name: 'mc-box', matchKey: 'mc-secret', maxInstances: 8 })
  const B = () => boxes.byName('mc-box')
  const P = (sid) => [{ steamid: sid }]
  const lease = (map, sid, extra = {}) => {
    const r = assignments.lease({ box: B(), mapKey: map, players: P(sid), ...extra })
    if (!r.ok) throw new Error(r.error)
    return r.match_id
  }

  // ---- popular maps -----------------------------------------------------------------
  const ended = (id) => db.prepare("UPDATE assignments SET state='ended' WHERE match_id=?").run(id)
  for (let i = 0; i < 3; i++) ended(lease('custom_pop', '7656119800000000' + (i + 1)))
  ended(lease('custom_rare', '76561198000000001'))
  ended(lease('nazi_zombie_asylum', '76561198000000002'))
  for (let i = 0; i < 5; i++) ended(lease('custom_agent', '76561198000000003', { agent: true }))
  // An old lease (60 days) does not count in a 30-day window.
  const old = lease('custom_rare', '76561198000000002'); ended(old)
  db.prepare('UPDATE assignments SET issued_at=? WHERE match_id=?').run(now() - 60 * 86400_000, old)

  await check('popular(): real leases only, stock left out, most played first, with fs_game and size', () => {
    const p = assignments.popular({ days: 30 })
    eq(p.map((x) => x.map), ['custom_pop', 'custom_rare'])
    eq(p[0].plays, 3); eq(p[0].fs_game, 'mods/custom_pop'); eq(p[0].size_bytes, 2000)  // 1000 + 500 + the two 2026-09-23 fixture files (300 + 200)
    eq(p[1].plays, 1, 'the 60-day-old lease is outside the window'); eq(p[1].size_bytes, 0, 'no files -> 0')
  })

  // ---- the routes ---------------------------------------------------------------------
  const app = express()
  app.use('/api/gs', require('../server/routes/gameserver').router())
  const srv = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${srv.address().port}/api/gs`
  // http.request, not fetch: exiting with fetch's keep-alive sockets mid-close trips a
  // libuv assertion on Windows (see test/bucket.js).
  const req = (method, p, { secret = 'mc-secret', body = null } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(base + p, { method, agent: false, headers: { 'x-match-secret': secret, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => { let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
  const get = (p, secret) => req('GET', p, { secret })
  const post = (p, body) => req('POST', p, { body })

  await check('GET /api/gs/map-files/:bsp: the file list with size and sha256, box secret required', async () => {
    const r = await get('/map-files/custom_pop')
    eq(r.status, 200)
    eq(r.body.files.map((f) => [f.path, f.size, f.sha256.slice(0, 1)]).sort(), [['Pack V1..0.0.iwd', 300, 'c'], ['custom_pop.iwd', 500, 'b'], ['mod.ff', 1000, 'a'], ['sound/box.wav', 200, 'd']])
    eq((await get('/map-files/nazi_zombie_asylum')).body.stock, true)
    eq((await get('/map-files/custom_pop', 'wrong')).status, 401)
  })

  await check('asset gate: a blocking asset_audit verdict is hidden on import, whatever site_hidden says', async () => {
    const g = require('../server/lib/assetgate')
    eq(g.hiddenFor({ site_hidden: false, asset_audit: { verdict: 'hide' } }), { hidden: 1, hidden_set: 1 })
    eq(g.hiddenFor({ asset_audit: { verdict: 'fix' } }), { hidden: 1, hidden_set: 1 })
    eq(g.hiddenFor({ site_hidden: false, asset_audit: { verdict: 'minor' } }), { hidden: 0, hidden_set: 1 })
    eq(g.hiddenFor({ asset_audit: { verdict: 'unproven' } }), { hidden: 0, hidden_set: 0 })
    eq(g.hiddenFor({ site_hidden: true }), { hidden: 1, hidden_set: 1 })
  })

  await check('GET /api/gs/popular-maps', async () => {
    const r = await get('/popular-maps')
    eq(r.status, 200); eq(r.body.maps[0].map, 'custom_pop')
  })

  // ---- preparing: the reaper, the launcher's view -------------------------------------
  const S = '76561198000000001'
  parties.create(S, { mode: 'custom', mapKey: 'custom_rare', visibility: 'private' })
  parties.startReadyCheck(S, { force: true })
  parties.setReady(S, true)
  db.prepare('UPDATE boxes SET last_poll=? WHERE name=?').run(now(), 'mc-box')
  const L = parties.launch(S, {})
  truthy(L.ok, L.error)
  const mid = parties.launchInfo(S).match_id
  // Issued two minutes ago: past the 90 s grace a lease the box does not list is reaped on.
  db.prepare('UPDATE assignments SET issued_at=? WHERE match_id=?').run(now() - 120_000, mid)

  await check('a lease the box lists as `preparing` survives the ghost reaper, and /play shows its progress', async () => {
    const prog = { phase: 'downloading', bytes_done: 250, bytes_total: 1000, percent: 25 }
    const r = await post('/status', { state: 'live', protocol: 2, max_instances: 3, instances: [{ id: null, match_id: mid, state: 'preparing', port: null, preparing: prog }] })
    eq(r.status, 200)
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(mid).state, 'leased', 'not reaped')
    const li = parties.launchInfo(S)
    eq(li.preparing, prog); eq(li.connect, null, 'no connect string while preparing')
  })

  await check('the per-game `preparing` post acks the lease without moving it', async () => {
    await post('/status', { state: 'preparing', match_id: mid, preparing: { phase: 'downloading', bytes_done: 900, bytes_total: 1000, percent: 90 } })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(mid).state, 'leased')
    eq(parties.launchInfo(S).preparing.percent, 90, 'the per-game post is read too (the heartbeat list is carried over)')
  })

  await check('without the listing the same lease IS reaped (the reaper still works)', async () => {
    const other = lease('custom_pop', '76561198000000002')
    db.prepare('UPDATE assignments SET issued_at=? WHERE match_id=?').run(now() - 120_000, other)
    boxes.recordStatus(B(), { state: 'live', protocol: 2, instances: [{ id: null, match_id: mid, state: 'preparing', preparing: { percent: 1 } }] })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(other).state, 'ended')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(mid).state, 'leased')
  })

  await check('`failed` from the box ends a lease that never started and frees the party', async () => {
    await post('/status', { state: 'failed', match_id: mid, error: 'sha256 mismatch' })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(mid).state, 'cancelled')
    eq(parties.launchInfo(S), null, 'the party has no match any more')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='assignment.box_failed'").get(), 'logged')
  })

  await check('`failed` never ends a ready or live game', () => {
    const g = lease('custom_pop', '76561198000000003')
    assignments.ack(B(), 'live', g)
    assignments.ack(B(), 'failed', g, 'nope')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(g).state, 'live')
  })

  // ---- host.md §16: a queued boot, `yielded`, and the RAM figure ------------------------
  const S2 = '76561198000000002'
  parties.create(S2, { mode: 'custom', mapKey: 'custom_rare', visibility: 'private' })
  parties.startReadyCheck(S2, { force: true })
  parties.setReady(S2, true)
  const L2 = parties.launch(S2, {})
  truthy(L2.ok, L2.error)
  const qid = parties.launchInfo(S2).match_id
  db.prepare('UPDATE assignments SET issued_at=? WHERE match_id=?').run(now() - 120_000, qid)

  await check('a lease whose boot is QUEUED on the box survives the reaper, and /play says how many are ahead', async () => {
    // The heartbeat lists the instance the box created for it (state `new`, no process yet)
    // with `preparing: { phase: 'queued', ahead, reason }` (host.js reportStatus).
    await post('/status', { state: 'live', protocol: 2, max_instances: 3, mem: { available_bytes: 900 * 1048576, total_bytes: 3800 * 1048576, floor_bytes: 700 * 1048576 },
      instances: [{ id: 'inst-61', match_id: qid, state: 'new', phase: 'queued', port: 28960, preparing: { phase: 'queued', ahead: 1, reason: 'boot', since: new Date().toISOString() } }] })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(qid).state, 'leased', 'not reaped')
    const p = parties.launchInfo(S2).preparing
    eq([p.phase, p.ahead, p.reason], ['queued', 1, 'boot'])
    eq(parties.launchInfo(S2).connect, null, 'no connect string while queued')
    // The per-game post the box sends while it waits for memory.
    await post('/status', { state: 'preparing', match_id: qid, preparing: { phase: 'queued', ahead: 0, reason: 'memory' } })
    eq(parties.launchInfo(S2).preparing.reason, 'memory')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(qid).state, 'leased')
  })

  await check('the admin Boxes view carries the RAM figure, across per-game posts', async () => {
    const d = require('../server/lib/adminBoxes').detail().find((x) => x.name === 'mc-box')
    eq(Math.round(d.mem.available_bytes / 1048576), 900, 'available')
    eq(Math.round(d.mem.floor_bytes / 1048576), 700, 'floor')
  })

  await check('`yielded` ends an AGENT lease the box retired for a player, never a player\'s', async () => {
    const ag = lease('custom_agent', '76561198000000003', { agent: true })
    assignments.ack(B(), 'live', ag)
    await post('/status', { state: 'yielded', match_id: ag, error: 'a player\'s lease needs the boot slot' })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(ag).state, 'superseded')
    await post('/status', { state: 'yielded', match_id: qid })
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(qid).state, 'leased', 'a real lease is untouched')
  })

  srv.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
