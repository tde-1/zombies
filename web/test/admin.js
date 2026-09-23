'use strict'

// The admin console's API (2026-09-23, "admin: parity with Movement and beyond").
//
//   node test/admin.js
//
// 1. AUTHORISATION, by walking the router: every route carries requireMod or requireAdmin;
//    every route is 401 signed out and 403 for an approved player; every admin-only route is
//    403 for a moderator. A new route that forgets its guard fails here.
// 2. The audit log: explicit events, the catch-all for a write that logs nothing, filters,
//    the cursor.
// 3. The new surfaces: the beta gate, roles, playlists CRUD, map flags, chat, games with
//    flags, release, and the box guard (no retire/restart over a connected player without
//    a confirm naming them).
//
// A throwaway database, 127.0.0.1 only.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-admin-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'
process.env.ZM_UPDATES_DIR = path.join(TMP, 'updates')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db, now } = require('../server/db/database')
const users = require('../server/lib/users')
const maps = require('../server/lib/maps')
const boxes = require('../server/lib/boxes')
const seats = require('../server/lib/seats')
const chat = require('../server/lib/chatNetwork')
const playlists = require('../server/lib/playlists')
const { requireMod, requireAdmin } = require('../server/middleware/auth')
const adminRoutes = require('../server/routes/admin')

// ---- fixtures ---------------------------------------------------------------------
const ADMIN = '76561198000000301'
const MOD = '76561198000000302'
const PLAYER = '76561198000000303'
const FRIEND = '76561198000000304'
users.ensure(ADMIN, { enw_name: 'boss' })
users.ensure(MOD, { enw_name: 'modder' })
users.ensure(PLAYER, { enw_name: 'player' })
users.ensure(FRIEND, { enw_name: 'friend' })
db.prepare('UPDATE users SET approved=1').run()
db.prepare('UPDATE users SET is_admin=1 WHERE steam_id=?').run(ADMIN)
db.prepare('UPDATE users SET is_mod=1 WHERE steam_id=?').run(MOD)

const addMap = (key, title, health = 'verified') => {
  db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, main_finish, round_n, added_at)
              VALUES (?,?,?,?, 'custom', ?, 'round', 20, ?)`).run(key, key, title, 'someone', health, now())
  const m = db.prepare('SELECT id FROM maps WHERE key=?').get(key)
  db.prepare("INSERT INTO map_versions (map_id, version, latest, health, added_at) VALUES (?, '1.0', 1, ?, ?)").run(m.id, health, now())
}
addMap('nazi_zombie_test', 'Test Map')
addMap('nazi_zombie_two', 'Second Map')
addMap('nazi_zombie_broke', 'Broken Map', 'broken')
maps.SERVER_PROVEN.add('nazi_zombie_test')

function req(port, method, p, { as, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(as ? { 'x-test-user': as } : {}),
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let t = ''
      res.on('data', (c) => { t += c })
      res.on('end', () => { let j = null; try { j = JSON.parse(t) } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

async function main() {
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use((q, _r, next) => { const who = q.headers['x-test-user']; q.me = who ? users.byId(String(who)) : null; next() })
  const router = adminRoutes.router()
  app.use('/api/admin', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  const call = (m, p, o) => req(port, m, p, o)

  // ---- 1. authorisation ------------------------------------------------------------
  const routes = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => ({
    method: m.toUpperCase(), path: l.route.path, handles: l.route.stack.map((s) => s.handle),
  })))
  const fill = (p) => p.replace(/:matchId/g, 'm_x').replace(/:name/g, 'nobox').replace(/:who/g, PLAYER).replace(/:key/g, 'nazi_zombie_test').replace(/:[a-zA-Z]+/g, '999999')

  await check(`auth: every one of the ${routes.length} admin routes carries requireMod or requireAdmin`, () => {
    truthy(routes.length > 40, 'the walk found the routes')
    const bare = routes.filter((r) => !r.handles.includes(requireMod) && !r.handles.includes(requireAdmin))
    eq(bare.map((r) => `${r.method} ${r.path}`).join(', '), '', 'unguarded routes')
  })
  await check('auth: every route is 401 signed out and 403 for an approved player', async () => {
    const wrong = []
    for (const r of routes) {
      const anon = await call(r.method, `/api/admin${fill(r.path)}`, { body: r.method === 'GET' ? null : {} })
      if (anon.status !== 401) wrong.push(`${r.method} ${r.path} anon=${anon.status}`)
      const pl = await call(r.method, `/api/admin${fill(r.path)}`, { as: PLAYER, body: r.method === 'GET' ? null : {} })
      if (pl.status !== 403) wrong.push(`${r.method} ${r.path} player=${pl.status}`)
    }
    eq(wrong.join('; '), '', 'wrong answers')
  })
  const adminOnly = routes.filter((r) => r.handles.includes(requireAdmin))
  await check(`auth: the ${adminOnly.length} admin-only routes are 403 for a moderator`, async () => {
    truthy(adminOnly.length >= 25, 'admin-only routes found')
    for (const must of ['GET /boxes/live', 'POST /leases/:matchId/retire', 'POST /leases/:matchId/restart', 'GET /release', 'POST /player/:who/role', 'DELETE /playlists/:id', 'POST /lease']) {
      truthy(adminOnly.some((r) => `${r.method} ${r.path}` === must), `${must} is admin-only`)
    }
    const wrong = []
    for (const r of adminOnly) {
      const m = await call(r.method, `/api/admin${fill(r.path)}`, { as: MOD, body: r.method === 'GET' ? null : {} })
      if (m.status !== 403) wrong.push(`${r.method} ${r.path} mod=${m.status}`)
    }
    eq(wrong.join('; '), '', 'wrong answers')
  })
  await check('auth: a moderator reaches the moderation routes; an admin reaches everything', async () => {
    for (const p of ['/', '/log', '/users', '/reports', '/chat', '/maps', '/games', '/playlists', '/guides', '/bans']) {
      eq((await call('GET', `/api/admin${p}`, { as: MOD })).status, 200, `mod GET ${p}`)
    }
    for (const p of ['/boxes/live', '/release', '/collections', '/badges']) eq((await call('GET', `/api/admin${p}`, { as: ADMIN })).status, 200, `admin GET ${p}`)
  })

  // ---- 2. the beta gate and roles --------------------------------------------------------
  const NEW = '76561198000000399'
  await check('gate: approve by SteamID creates the account and logs it; a bad id is a 400', async () => {
    eq((await call('POST', '/api/admin/approve', { as: MOD, body: { steam_ids: ['nope'] } })).status, 400, 'bad id')
    const r = await call('POST', '/api/admin/approve', { as: MOD, body: { steam_ids: [NEW, FRIEND] } })
    eq(r.status, 200, 'status'); eq(r.body.count, 2, 'count')
    eq(users.byId(NEW).approved, 1, 'approved')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='user.approve' AND actor=? AND metadata LIKE ?").get(MOD, `%${NEW}%`), 'logged')
    eq((await call('POST', '/api/admin/approve', { as: MOD, body: { steam_ids: [NEW], approved: false } })).status, 200, 'revoke')
    eq(users.byId(NEW).approved, 0, 'revoked')
    const w = await call('GET', '/api/admin/users?filter=waiting', { as: MOD })
    truthy(w.body.users.some((u) => u.steam_id === NEW), 'on the waiting filter')
  })
  await check('roles: nobody removes their own admin; a role change is logged', async () => {
    eq((await call('POST', `/api/admin/player/${ADMIN}/role`, { as: ADMIN, body: { admin: false } })).status, 400, 'self')
    eq((await call('POST', `/api/admin/player/${PLAYER}/role`, { as: ADMIN, body: { mod: true } })).status, 200, 'grant')
    eq(users.byId(PLAYER).is_mod, 1, 'is mod')
    eq((await call('POST', `/api/admin/player/${PLAYER}/role`, { as: ADMIN, body: { mod: false } })).status, 200, 'take back')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='user.role' AND actor=?").get(ADMIN), 'logged')
  })
  await check('people: search, filter and paging', async () => {
    const r = await call('GET', '/api/admin/users?q=modd', { as: MOD })
    eq(r.body.total, 1, 'one match'); eq(r.body.users[0].name, 'modder', 'the mod')
    const s = await call('GET', '/api/admin/users?filter=staff&sort=name&dir=asc', { as: MOD })
    eq(s.body.users.map((u) => u.name).join(','), 'boss,modder', 'staff by name')
    const p = await call('GET', '/api/admin/users?size=2&page=2&sort=name&dir=asc', { as: MOD })
    eq(p.body.users.length, 2, 'page 2 of 2-size'); eq(p.body.page, 2, 'page')
  })
  await check('bans: a moderator cannot ban an admin or themselves; a ban shows in the list', async () => {
    eq((await call('POST', `/api/admin/player/${ADMIN}/ban`, { as: MOD, body: { kind: 'chat' } })).status, 403, 'admin')
    eq((await call('POST', `/api/admin/player/${MOD}/ban`, { as: MOD, body: { kind: 'chat' } })).status, 400, 'self')
    eq((await call('POST', `/api/admin/player/${FRIEND}/ban`, { as: MOD, body: { kind: 'griefing' } })).status, 200, 'ban')
    const b = await call('GET', '/api/admin/bans', { as: MOD })
    eq(b.body.bans.length, 1, 'one'); eq(b.body.bans[0].scope, 'public', 'griefing is public-play')
    eq((await call('POST', `/api/admin/ban/${b.body.bans[0].id}/lift`, { as: MOD })).status, 200, 'lift')
    eq((await call('GET', '/api/admin/bans', { as: MOD })).body.bans.length, 0, 'none active')
  })

  // ---- 3. playlists --------------------------------------------------------------------
  let plId = null
  await check('playlists: create with ordered maps; an unknown key is a 400; a taken slug is a 409', async () => {
    eq((await call('POST', '/api/admin/playlists', { as: MOD, body: { name: 'Bad', maps: ['nope_map'] } })).status, 400, 'unknown key')
    const r = await call('POST', '/api/admin/playlists', { as: MOD, body: { name: 'Starter pack', maps: ['nazi_zombie_two', 'nazi_zombie_test'] } })
    eq(r.status, 200, 'status')
    plId = r.body.playlist.id
    eq(r.body.playlist.slug, 'starter-pack', 'slug from name')
    eq(r.body.playlist.state, 'hidden', 'hidden until published')
    eq(r.body.playlist.maps.map((m) => m.key).join(','), 'nazi_zombie_two,nazi_zombie_test', 'order kept')
    eq((await call('POST', '/api/admin/playlists', { as: MOD, body: { name: 'Starter pack' } })).status, 409, 'taken')
  })
  await check('playlists: reorder, publish, and the public list shows it; delete is admin-only', async () => {
    eq(playlists.live().length, 0, 'not live yet')
    const r = await call('PUT', `/api/admin/playlists/${plId}`, { as: MOD, body: { maps: ['nazi_zombie_test', 'nazi_zombie_two'], state: 'live' } })
    eq(r.status, 200, 'status')
    eq(playlists.live()[0].maps.map((m) => m.key).join(','), 'nazi_zombie_test,nazi_zombie_two', 'new order is public')
    eq((await call('PUT', `/api/admin/playlists/${plId}`, { as: MOD, body: { state: 'bogus' } })).status, 400, 'bad state')
    eq((await call('DELETE', `/api/admin/playlists/${plId}`, { as: MOD })).status, 403, 'mod cannot delete')
    eq((await call('DELETE', `/api/admin/playlists/${plId}`, { as: ADMIN })).status, 200, 'admin deletes')
    eq(db.prepare('SELECT COUNT(*) c FROM playlist_maps WHERE playlist_id=?').get(plId).c, 0, 'members gone')
    eq(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE event LIKE 'playlist.%'").get().c, 3, 'three logged')
  })
  await check('seed-playlists: the plan skips keys this DB lacks and broken maps, and writes nothing', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM playlists').get().c
    const { plan } = require('../tools/seed-playlists')
    const p = plan()
    const stock = p.find((x) => x.slug === 'stock')
    eq(stock.keep.length, 0, 'no stock maps in the fixture')
    eq(stock.skipped.length, 4, 'all four named')
    eq(db.prepare('SELECT COUNT(*) c FROM playlists').get().c, before, 'nothing written')
  })

  // ---- 4. maps, chat, games, release -------------------------------------------------------
  await check('maps: hide and a health flag are validated and logged with from/to', async () => {
    eq((await call('POST', '/api/admin/maps/nazi_zombie_two', { as: MOD, body: { health: 'excellent' } })).status, 400, 'bad health')
    eq((await call('POST', '/api/admin/maps/nazi_zombie_two', { as: MOD, body: { hidden: true, health: 'broken' } })).status, 200, 'set')
    const m = maps.byKey('nazi_zombie_two')
    eq(m.hidden, 1, 'hidden'); eq(m.health, 'broken', 'broken')
    const log = db.prepare("SELECT metadata FROM activity_log WHERE event='map.edit' ORDER BY id DESC").get()
    eq(JSON.parse(log.metadata).changed.health.from, 'verified', 'from')
    const list = await call('GET', '/api/admin/maps?hidden=1', { as: MOD })
    eq(list.body.maps.map((x) => x.key).join(','), 'nazi_zombie_two', 'hidden filter')
  })
  await check('chat: remove and restore a line; both logged; removed lines listed on request', async () => {
    chat.push({ from: 'player', text: 'something rude', steamId: PLAYER, origin: 'web' })
    const id = db.prepare('SELECT MAX(id) m FROM chat_network').get().m
    eq((await call('POST', `/api/admin/chat/${id}/remove`, { as: MOD })).status, 200, 'remove')
    eq(chat.tail(10).some((l) => l.id === id), false, 'gone from the channel')
    const rem = await call('GET', '/api/admin/chat?removed=1', { as: MOD })
    eq(rem.body.lines[0].id, id, 'listed as removed')
    eq((await call('POST', `/api/admin/chat/${id}/restore`, { as: MOD })).status, 200, 'restore')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='chat.remove' AND actor=?").get(MOD), 'remove logged')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='chat.restore' AND actor=?").get(MOD), 'restore logged')
    eq((await call('POST', '/api/admin/chat/999999/remove', { as: MOD })).status, 404, 'no such line')
  })
  await check('games: filter by a referee flag, with the flag counts', async () => {
    const ins = db.prepare(`INSERT INTO games (match_id, box, mode, map_key, rounds, player_count, flags, ended_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    ins.run('m_flag1', 'box-t', 'verified', 'nazi_zombie_test', 5, 1, '["result_mismatch"]', now(), now())
    ins.run('m_flag2', 'box-t', 'verified', 'nazi_zombie_test', 7, 1, '["instance_retired","frames_only"]', now(), now())
    ins.run('m_clean', 'box-t', 'verified', 'nazi_zombie_test', 9, 1, '[]', now(), now())
    const r = await call('GET', '/api/admin/games?flag=instance_retired', { as: MOD })
    eq(r.body.games.map((g) => g.match_id).join(','), 'm_flag2', 'one')
    eq((await call('GET', '/api/admin/games?flag=any', { as: MOD })).body.total, 2, 'any flag')
    truthy(r.body.flags.some((f) => f.flag === 'result_mismatch' && f.c === 1), 'counts')
  })
  await check('release: latest.yml parsed; a box DLL sha noted, validated and logged', async () => {
    fs.mkdirSync(process.env.ZM_UPDATES_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.ZM_UPDATES_DIR, 'latest.yml'),
      "version: 0.2.20\nfiles:\n  - url: ENW-Zombies-Launcher-Setup-0.2.20.exe\n    sha512: abc==\n    size: 5\npath: ENW-Zombies-Launcher-Setup-0.2.20.exe\nsha512: abc==\nreleaseDate: '2026-09-23T02:03:28.145Z'\n")
    fs.writeFileSync(path.join(process.env.ZM_UPDATES_DIR, 'ENW-Zombies-Launcher-Setup-0.2.20.exe'), 'hello')
    boxes.create({ name: 'box-t', matchKey: 'secret-t', maxInstances: 2 })
    const r = await call('GET', '/api/admin/release', { as: ADMIN })
    eq(r.body.feed.version, '0.2.20', 'version'); eq(r.body.feed.size, 5, 'size'); eq(r.body.feed.on_disk.matches, true, 'installer on disk')
    eq((await call('POST', '/api/admin/release/box/box-t', { as: ADMIN, body: { sha256: 'zz' } })).status, 400, 'bad sha')
    eq((await call('POST', '/api/admin/release/box/box-t', { as: ADMIN, body: { sha256: '6B1CCFC5', commit: 'fd29f8f' } })).status, 200, 'noted')
    const again = await call('GET', '/api/admin/release', { as: ADMIN })
    eq(again.body.boxes.find((b) => b.name === 'box-t').noted.sha256, '6b1ccfc5', 'lower-cased')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='box.dll'").get(), 'logged')
    eq(JSON.stringify(again.body).includes('secret-t'), false, 'the box secret is never in a response')
  })

  // ---- 5. the box guard -----------------------------------------------------------------
  const box = boxes.byName('box-t')
  boxes.touch(box)
  let first = null
  await check('boxes: the live view lists the lease and its players, never the secret', async () => {
    const l = await call('POST', '/api/admin/lease', { as: ADMIN, body: { box: 'box-t', map: 'nazi_zombie_test', players: [{ steamid: PLAYER }, { steamid: FRIEND }], agent: false } })
    eq(l.status, 200, `lease: ${JSON.stringify(l.body && l.body.error)}`)
    first = l.body.match_id
    const v = await call('GET', '/api/admin/boxes/live', { as: ADMIN })
    const b = v.body.boxes.find((x) => x.name === 'box-t')
    eq(b.leases.length, 1, 'one lease'); eq(b.leases[0].players.length, 2, 'two players')
    eq(b.leases[0].in_game, 0, 'nobody connected yet')
    eq(JSON.stringify(v.body).includes('secret-t'), false, 'no secret')
  })
  await check('boxes: retire over a connected player is a 409 naming them, until confirmed with exactly them', async () => {
    seats.observe(first, { players: [{ steamid: PLAYER, connected: true }, { steamid: FRIEND, connected: false }] })
    const r = await call('POST', `/api/admin/leases/${first}/retire`, { as: ADMIN, body: {} })
    eq(r.status, 409, 'refused'); eq(r.body.players.map((p) => p.name).join(','), 'player', 'names who is in')
    eq((await call('POST', `/api/admin/leases/${first}/retire`, { as: ADMIN, body: { confirm: `${PLAYER},${FRIEND}` } })).status, 409, 'wrong list')
    // the old cancel route is the same guard
    eq((await call('POST', `/api/admin/lease/${first}/cancel`, { as: ADMIN, body: {} })).status, 409, 'old cancel guarded')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(first).state, 'leased', 'still running')
  })
  let second = null
  await check('boxes: restart with the confirm is a fresh lease for the same players; the old one is superseded', async () => {
    const r = await call('POST', `/api/admin/leases/${first}/restart`, { as: ADMIN, body: { confirm: PLAYER } })
    eq(r.status, 200, `restart: ${JSON.stringify(r.body)}`)
    second = r.body.match_id
    truthy(second && second !== first, 'a new match')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(first).state, 'superseded', 'old superseded')
    eq(JSON.parse(db.prepare('SELECT players_json FROM assignments WHERE match_id=?').get(second).players_json).length, 2, 'same players')
    truthy(db.prepare("SELECT 1 FROM activity_log WHERE event='lease.restart' AND metadata LIKE ?").get(`%${PLAYER}%`), 'logged with who was kicked')
  })
  await check('boxes: retire with nobody connected needs no confirm, and is logged', async () => {
    const r = await call('POST', `/api/admin/leases/${second}/retire`, { as: ADMIN, body: {} })
    eq(r.status, 200, 'retired')
    eq(db.prepare('SELECT state FROM assignments WHERE match_id=?').get(second).state, 'cancelled', 'cancelled')
    eq((await call('POST', `/api/admin/leases/${second}/retire`, { as: ADMIN, body: {} })).status, 400, 'already over')
    eq((await call('POST', '/api/admin/leases/m_nope/retire', { as: ADMIN, body: {} })).status, 404, 'no such lease')
  })

  await check('boxes: a live game the site has no seat data on is guarded too (everybody leased, marked unknown); presence counts', async () => {
    const assignments = require('../server/lib/assignments')
    const l = await call('POST', '/api/admin/lease', { as: ADMIN, body: { box: 'box-t', map: 'nazi_zombie_test', players: [{ steamid: MOD }, { steamid: FRIEND }], agent: false } })
    eq(l.status, 200, 'lease')
    assignments.ack(box, 'live', l.body.match_id)
    const r = await call('POST', `/api/admin/leases/${l.body.match_id}/retire`, { as: ADMIN, body: {} })
    eq(r.status, 409, 'refused while unknown'); eq(r.body.unknown, true, 'says unknown'); eq(r.body.players.length, 2, 'everybody leased')
    require('../server/lib/presence').markInGame(FRIEND, { matchId: l.body.match_id, mapKey: 'nazi_zombie_test', box: 'box-t' })
    const p = await call('POST', `/api/admin/leases/${l.body.match_id}/retire`, { as: ADMIN, body: {} })
    eq(p.status, 409, 'refused'); eq(p.body.unknown, false, 'known from presence'); eq(p.body.players.map((x) => x.steam_id).join(','), FRIEND, 'just the one in it')
    eq((await call('POST', `/api/admin/leases/${l.body.match_id}/retire`, { as: ADMIN, body: { confirm: FRIEND } })).status, 200, 'confirmed')
  })

  // ---- 6. the log ----------------------------------------------------------------------
  await check('log: a write that logs nothing itself is caught as admin.action', async () => {
    const before = db.prepare("SELECT COUNT(*) c FROM activity_log WHERE event='admin.action'").get().c
    eq((await call('POST', '/api/admin/boxes/box-t/capacity', { as: ADMIN, body: { max_instances: 2 } })).status, 200, 'explicit one')
    eq(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE event='admin.action'").get().c, before, 'explicit is not doubled')
    eq((await call('POST', `/api/admin/boxes/${box.id}/key/reject`, { as: ADMIN })).status, 200, 'a lib that logs')
    eq((await call('POST', '/api/admin/sweep', { as: ADMIN })).status, 200, 'sweep')
    // a failed write is not logged
    eq((await call('POST', '/api/admin/maps/nope', { as: MOD, body: { hidden: 1 } })).status, 404, '404')
    eq(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE metadata LIKE '%maps/nope%'").get().c, 0, 'failed write not logged')
    // A route that forgets to log: the guard writes admin.action with the path and body.
    const mini = express()
    mini.use(express.json())
    mini.use((q, _r, next) => { q.me = users.byId(ADMIN); next() })
    mini.use(require('../server/lib/adminLog').guard())
    mini.post('/forgetful', (q, s) => s.json({ ok: true }))
    const ms = mini.listen(0, '127.0.0.1')
    await new Promise((r) => ms.once('listening', r))
    eq((await req(ms.address().port, 'POST', '/forgetful', { body: { x: 1 } })).status, 200, 'forgetful')
    ms.close()
    await new Promise((r) => setTimeout(r, 20))
    const row = db.prepare("SELECT * FROM activity_log WHERE event='admin.action' ORDER BY id DESC").get()
    truthy(row && row.actor === ADMIN && JSON.parse(row.metadata).path === '/forgetful', 'caught')
  })
  await check('log: lanes, actor, search and the Load older cursor', async () => {
    const all = await call('GET', '/api/admin/log?limit=5', { as: MOD })
    eq(all.body.rows.length, 5, 'page'); truthy(all.body.more, 'more'); truthy(all.body.next, 'cursor')
    const older = await call('GET', `/api/admin/log?limit=5&before=${all.body.next}`, { as: MOD })
    truthy(older.body.rows[0].id < all.body.rows[4].id + 1, 'older rows')
    const lane = await call('GET', '/api/admin/log?lane=content', { as: MOD })
    truthy(lane.body.rows.length && lane.body.rows.every((r) => r.lane === 'content'), 'content lane')
    const mine = await call('GET', `/api/admin/log?actor=${MOD}`, { as: MOD })
    truthy(mine.body.rows.length && mine.body.rows.every((r) => r.actor === MOD || JSON.stringify(r.meta).includes(MOD)), 'actor')
    truthy(mine.body.rows.some((r) => r.who && r.who.name === 'modder'), 'actor named')
    const q = await call('GET', '/api/admin/log?q=starter-pack', { as: MOD })
    truthy(q.body.rows.length >= 1, 'search')
    const c = await call('GET', '/api/admin/log/counts', { as: MOD })
    truthy(c.body.counts.all > 10 && c.body.counts.content > 0, 'counts')
  })
  await check('log: a secret in a request body is redacted', async () => {
    eq((await call('POST', '/api/admin/boxes', { as: ADMIN, body: { name: 'box-z', match_key: 'hush-hush' } })).status, 200, 'create')
    eq(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE metadata LIKE '%hush-hush%'").get().c, 0, 'not in the log')
  })

  server.close()
  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  try { db.close() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
