'use strict'

// Friends across ENW, the online list, and the private chat the launcher chimes on
// (lane SOC, 2026-09-23; web.md "Friends across ENW, the live online list").
//
//   A. in process: the read-only sync from a stand-in Movement DB (only pairs where both
//      ends are ours, accepted only, an unfriend reaches us, soft-fail), the ssh argv, the
//      union in users.friendIds, the rail's rows (friends first, B's status words, the
//      round), friend-request pushes, /api/friends/requests, /api/chat/private.
//   B. a real server (index.js, ZM_TEST_LOGIN) with socket.io: a second player's launcher
//      socket reaches the first player's rail as `online_changed` well inside 2 s, reads
//      back as "In launcher", and is a friend through the Movement import done at start.
//
// Fake SteamIDs only (7656119800000xxxx). Nothing here touches ssh, Movement or web/data.
//
//   node test/friends.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-friends-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
delete process.env.ZM_FRIENDS_MOVEMENT_SSH
delete process.env.ZM_FRIENDS_MOVEMENT_LOCAL

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const Database = require('better-sqlite3')
const { db } = require('../server/db/database')
const users = require('../server/lib/users')
const friendSync = require('../server/lib/friendSync')
const presence = require('../server/lib/presence')
const roster = require('../server/lib/roster')
const live = require('../server/lib/live')

const A = '76561198000000501'   // deadshot
const B = '76561198000000502'   // staminup
const C = '76561198000000503'   // quick_revive
const D = '76561198000000504'   // mule_kicker
const OUTSIDER = '76561198000000599'   // on Movement only, never here
users.ensure(A, { enw_name: 'deadshot' })
users.ensure(B, { enw_name: 'staminup' })
users.ensure(C, { enw_name: 'quick_revive' })
users.ensure(D, { enw_name: 'mule_kicker' })
db.prepare('UPDATE users SET approved=1').run()

// A stand-in for Movement's matchmaker.db: its friendships table, verbatim.
function movementDb(file, rows) {
  if (fs.existsSync(file)) fs.rmSync(file)
  const m = new Database(file)
  m.exec(`CREATE TABLE friendships (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_steam_id TEXT NOT NULL,
          addressee_steam_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, updated_at INTEGER,
          UNIQUE(requester_steam_id, addressee_steam_id));
          CREATE TABLE users (steam_id TEXT PRIMARY KEY, username TEXT, email TEXT);`)
  const ins = m.prepare('INSERT INTO friendships (requester_steam_id, addressee_steam_id, status) VALUES (?,?,?)')
  for (const r of rows) ins.run(...r)
  m.prepare('INSERT INTO users VALUES (?,?,?)').run(A, 'x', 'never-read@example.invalid')
  m.close()
}

async function partA() {
  const MV = path.join(TMP, 'movement.db')

  await check('ssh argv: -readonly, BatchMode, SQL on stdin, and a host that is never an option', async () => {
    const args = friendSync.sshArgs('webbox', friendSync.DEFAULT_MOVEMENT_DB)
    truthy(args.includes('BatchMode=yes'), 'BatchMode')
    const remote = args[args.length - 1]
    truthy(/^sqlite3 -readonly -bail -csv '\/home\/deploy\/gonext\/data\/matchmaker\.db'$/.test(remote), `remote command: ${remote}`)
    let threw = 0
    for (const bad of ['-oProxyCommand=calc', 'a b', 'x;rm', '']) { try { friendSync.sshArgs(bad, '/x.db') } catch { threw++ } }
    eq(threw, 4, 'bad hosts refused')
    try { friendSync.sshArgs('webbox', "/x.db'; touch /tmp/p; '"); throw new Error('accepted a quoted path') } catch (e) { truthy(/bad db path/.test(e.message), e.message) }
  })

  await check('the SELECT is one read, asks only about our accounts, accepted only', async () => {
    const sql = friendSync.selectSql([A, B, 'junk', "1' OR '1'='1"])
    truthy(/^SELECT requester_steam_id, addressee_steam_id FROM friendships WHERE status='accepted'/.test(sql), sql)
    truthy(!/;\s*\S/.test(sql.replace(/;\s*$/, '')), 'one statement')
    truthy(!/junk|OR '1'/.test(sql), 'non-SteamIDs dropped')
    truthy(sql.includes(`'${A}'`) && sql.includes(`'${B}'`), 'our ids in the IN lists')
    eq(friendSync.parseCsv(`${A},${B}\r\n"${B}","${C}"\nnope\n`), [[A, B], [B, C]], 'csv')
  })

  // A–B accepted, C–A accepted, B–D pending, A–OUTSIDER accepted.
  movementDb(MV, [[A, B, 'accepted'], [C, A, 'accepted'], [B, D, 'pending'], [A, OUTSIDER, 'accepted']])
  friendSync.configure({ movement: { mode: 'local', run: friendSync.localRunner(MV) } })
  const changes = []
  friendSync.setOnChange((r) => changes.push(r))

  await check('sync imports accepted pairs where both ends are ours, and nothing else', async () => {
    const r = await friendSync.syncAll('test')
    eq(r.ok, true, 'ok')
    const edges = db.prepare('SELECT a, b, source FROM friend_edges ORDER BY a, b').all()
    eq(edges, [{ a: A, b: B, source: 'movement' }, { a: A, b: C, source: 'movement' }], 'edges')
    eq(changes.length, 1, 'one change event')
    const st = friendSync.status().sources.find((s) => s.source === 'movement')
    eq(st.edges, 2, 'status edges'); truthy(st.ok_at, 'ok_at')
  })

  await check('users.friendIds is this site\'s friends plus the imported ones', async () => {
    users.requestFriend(A, D); users.respondFriend(D, A, true)     // made here
    eq(users.friendIds(A).sort(), [B, C, D].sort(), 'A')
    eq(users.friendIds(B), [A], 'B')
    eq(users.friendState(B, A), 'friends', 'state')
    eq(users.friendSources(A, B), ['movement'], 'sources A-B')
    eq(users.friendSources(A, D), ['zombies'], 'sources A-D')
    eq(users.requestFriend(B, A).state, 'friends', 'asking an imported friend is already friends')
    const rm = users.removeFriend(A, B)
    eq(rm.ok, false, 'an imported friend is removed where it was made')
    truthy(/Movement/.test(rm.error), rm.error)
  })

  await check('an unfriend on Movement reaches us; an unchanged resync is quiet', async () => {
    await friendSync.syncAll('again')
    eq(changes.length, 1, 'no change, no event')
    movementDb(MV, [[C, A, 'accepted']])
    await friendSync.syncAll('unfriend')
    eq(users.friendIds(B), [], 'B dropped')
    eq(changes.length, 2, 'change event')
  })

  await check('a source that fails keeps the last good edges and records why', async () => {
    friendSync.configure({ movement: { mode: 'ssh', run: async () => { throw new Error('Permission denied (publickey)') } } })
    const r = await friendSync.syncAll('down')
    eq(r.ok, false, 'not ok')
    eq(users.friendIds(C), [A], 'kept')
    const st = friendSync.status().sources.find((s) => s.source === 'movement')
    truthy(/publickey/.test(st.error), 'error recorded')
    truthy(friendSync.status().not_sources.some((x) => x.source === 'drops'), 'drops is named as checked and empty')
    // Put it back for the rest.
    movementDb(MV, [[A, B, 'accepted'], [C, A, 'accepted']])
    friendSync.configure({ movement: { mode: 'local', run: friendSync.localRunner(MV) } })
    await friendSync.syncAll('back')
  })

  await check('a new account connecting triggers a sync (once, 15 s floor)', async () => {
    let runs = 0
    friendSync.configure({ movement: { mode: 'local', run: async (sql) => { runs++; return friendSync.localRunner(MV)(sql) } } })
    await friendSync.syncAll('baseline')
    eq(runs, 1, 'baseline')
    eq(friendSync.maybeSync('sign-in', A), null, 'a known account does not')
    const E = '76561198000000505'
    users.ensure(E, { enw_name: 'double_tap' })
    eq(friendSync.maybeSync('sign-in', E), null, 'inside the 15 s floor')
    friendSync.configure({ movement: { mode: 'local', run: friendSync.localRunner(MV) } })
  })

  await check('the rail: friends first, B\'s status words, the round, the client', async () => {
    presence.connected(A, 'sA', 'site')
    presence.connected(B, 'sB', 'launcher')
    presence.connected(C, 'sC', 'site')
    presence.connected(D, 'sD', 'site')
    presence.markInGame(C, { matchId: 'm_soc_1', mapKey: 'nazi_zombie_factory', box: 'box1' })
    live.push('box1', { match_id: 'm_soc_1', state: { round: 12, players: [] } })
    db.prepare("DELETE FROM friendships WHERE requester_steam_id IN (?,?) OR addressee_steam_id IN (?,?)").run(A, D, A, D)
    const r = roster.forViewer(A)
    eq(r.scope, 'online', 'scope')
    eq(r.players.map((p) => p.steam_id), [C, B, D], 'friends (in game first) then everyone else')
    const by = Object.fromEntries(r.players.map((p) => [p.steam_id, p]))
    eq(by[B].status, { kind: 'launcher', text: 'In launcher' }, 'launcher')
    truthy(/^In game on .+, round 12$/.test(by[C].status.text), by[C].status.text)
    eq(by[D].status, { kind: 'online', text: 'Online' }, 'site')
    eq(by[B].friend_sources, ['movement'], 'source')
    eq(by[D].friend, false, 'D is not a friend now')
    eq(r.friends, 2, 'friends count')
  })

  await check('a connected launcher counts as online without a heartbeat; the signature moves', async () => {
    const before = presence.signature()
    presence.connected(D, 'sD2', 'launcher')
    truthy(presence.signature() !== before, 'signature changed')
    presence.disconnected(D, 'sD2')
  })

  await check('friend requests are pushed to the other rail', async () => {
    const got = []
    users.setFriendEmitter((ids, ev, p) => got.push([ids, ev, p]))
    users.requestFriend(B, D)
    eq(got.map((g) => [g[0], g[1]]), [[[D], 'friend_request_received']], 'received')
    users.respondFriend(D, B, true)
    eq(got[1][1], 'friend_request_accepted', 'accepted'); eq(got[1][0].sort(), [B, D].sort(), 'both told')
    users.removeFriend(B, D)
    eq(got[2][1], 'friend_removed', 'removed')
    users.setFriendEmitter(null)
  })

  // HTTP through the real router.
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.session = { steam_id: req.headers['x-sid'] || null }; next() })
  app.use(require('../server/middleware/auth').attach)
  app.use('/api', require('../server/routes/site').router())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (as, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(as ? { 'x-sid': as } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    let j = null
    try { j = await r.json() } catch { /* empty */ }
    return { status: r.status, body: j }
  }

  await check('GET /api/friends/requests lists what waits on me', async () => {
    users.requestFriend(D, A)
    const r = await call(A, 'GET', '/api/friends/requests')
    eq(r.status, 200, 'status')
    eq(r.body.requests.map((q) => q.from.steam_id), [D], 'from D')
    eq((await call(null, 'GET', '/api/friends/requests')).status, 401, 'signed out')
  })

  await check('POST /api/chat/private: a DM to a friend lands; to a stranger is refused', async () => {
    const lines = []
    require('../server/lib/gameChat').setEmitter((ids, line) => lines.push([ids, line]))
    const ok = await call(A, 'POST', '/api/chat/private', { channel: 'dm', to: B, text: 'gl on 12' })
    eq(ok.status, 200, 'sent')
    eq(lines.length, 1, 'emitted'); eq(lines[0][0].sort(), [A, B].sort(), 'to both')
    const back = await call(B, 'GET', '/api/chat/private')
    truthy(back.body.lines.some((l) => l.channel === 'dm' && l.text === 'gl on 12' && l.steamid === A), 'B reads it')
    const no = await call(D, 'POST', '/api/chat/private', { channel: 'dm', to: B, text: 'hi' })
    eq(no.status, 400, 'D is not B\'s friend or party')
  })

  server.close()

  await check('the page tells the launcher about invites, DMs and party lines -- never its own, never a notice', async () => {
    const { pathToFileURL } = require('url')
    const m = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'attentionEvents.js')).href)
    const inv = m.toAttention('invite_received', { invite: { id: 9, party_id: 3, from: { name: 'deadshot', steam_id: A }, map_title: 'Der Riese' } }, B)
    eq([inv.kind, inv.invite_id, inv.title, inv.body], ['invite', 9, 'deadshot invited you', 'Party on Der Riese'], 'invite')
    eq(m.toAttention('chat-private', { id: 4, channel: 'dm', steamid: A, from: 'deadshot', text: 'hi' }, B).kind, 'dm', 'dm')
    eq(m.toAttention('chat-private', { id: 5, channel: 'party', steamid: A, from: 'deadshot', text: 'go' }, B).kind, 'party', 'party')
    eq(m.toAttention('chat-private', { id: 6, channel: 'dm', steamid: B, from: 'staminup', text: 'mine' }, B), null, 'own line')
    eq(m.toAttention('chat-private', { id: 7, channel: 'notice', kind: 'system', text: 'Your record has been uploaded.' }, B), null, 'notice')
    eq(m.toAttention('invite_received', {}, B), null, 'empty')
  })
}

// ---- B: a real server, real sockets ------------------------------------------------
async function partB() {
  let ioc
  try { ioc = require(path.join(__dirname, '..', 'client', 'node_modules', 'socket.io-client')) } catch {
    out.push(['skip', 'B: web/client/node_modules/socket.io-client not installed']); return
  }
  const { freePort, waitHttp } = require('./_port')
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-friends-srv-'))
  const MV = path.join(DATA, 'movement.db')
  movementDb(MV, [[A, B, 'accepted']])
  // Seed the server's DB before it starts: two named, approved accounts.
  {
    const s = new Database(path.join(DATA, 'zombies.db'))
    s.close()
    const env = { ...process.env, ZM_DATA_DIR: DATA, ZM_DB_PATH: path.join(DATA, 'zombies.db'), ZM_KEY_DIR: path.join(DATA, 'keys') }
    const seed = spawn(process.execPath, ['-e', `
      const users = require('./server/lib/users'); const { db } = require('./server/db/database');
      users.ensure('${A}', { enw_name: 'deadshot' }); users.ensure('${B}', { enw_name: 'staminup' });
      db.prepare('UPDATE users SET approved=1').run()`], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' })
    await new Promise((r) => seed.on('exit', r))
  }
  const PORT = await freePort(34620)
  const BASE = `http://127.0.0.1:${PORT}`
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZM_PORT: String(PORT), ZM_DATA_DIR: DATA, ZM_DB_PATH: path.join(DATA, 'zombies.db'), ZM_KEY_DIR: path.join(DATA, 'keys'),
           ZM_TEST_LOGIN: '1', ZM_MOVEMENT_URL: 'off', ZM_STEAM_AVATARS: 'off', ZM_PUBLIC_URL: BASE, STEAM_API_KEY: '',
           ZM_FRIENDS_MOVEMENT_LOCAL: MV, ZM_SITE_PASSWORD: '' },
    stdio: 'ignore',
  })
  const socks = []
  try {
    await waitHttp(BASE + '/api/health', { child, ok: () => true })
    const login = async (sid) => {
      const r = await fetch(BASE + '/auth/test-login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steam_id: sid }) })
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    }
    const jarA = await login(A)
    const jarB = await login(B)
    const connect = (jar, client) => new Promise((resolve, reject) => {
      const s = ioc.io(BASE, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie: jar }, auth: { client }, reconnection: false })
      socks.push(s)
      s.once('connect', () => resolve(s))
      s.once('connect_error', reject)
    })
    const sa = await connect(jarA, 'site')
    await new Promise((r) => setTimeout(r, 400))           // let A's own arrival nudge pass
    let t0 = 0
    const nudged = new Promise((resolve) => sa.on('online_changed', () => { if (t0) resolve(Date.now() - t0) }))
    t0 = Date.now()
    await connect(jarB, 'launcher')
    const ms = await Promise.race([nudged, new Promise((r) => setTimeout(() => r(-1), 3000))])

    await check(`B: a launcher coming online reaches another rail as a push (${ms} ms)`, async () => {
      truthy(ms >= 0, 'no online_changed within 3 s')
      truthy(ms < 2000, `took ${ms} ms`)
    })
    await check('B: the row reads In launcher, and is a friend through the Movement import at start', async () => {
      const r = await (await fetch(BASE + '/api/party/online', { headers: { cookie: jarA } })).json()
      const row = r.players.find((p) => p.steam_id === B)
      truthy(row, 'B listed')
      eq(row.status.text, 'In launcher', 'status')
      eq(row.friend, true, 'friend')
      eq(row.friend_sources, ['movement'], 'from Movement')
    })
    await check('B: a DM is pushed to its recipient\'s socket (the launcher\'s chime trigger)', async () => {
      const sb = socks[1]
      const got = new Promise((resolve) => sb.once('chat-private', resolve))
      const r = await fetch(BASE + '/api/chat/private', { method: 'POST', headers: { cookie: jarA, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'dm', to: B, text: 'invite coming' }) })
      eq(r.status, 200, 'sent')
      const line = await Promise.race([got, new Promise((res) => setTimeout(() => res(null), 2000))])
      truthy(line && line.text === 'invite coming' && line.steamid === A, 'B heard it')
    })
  } finally {
    for (const s of socks) { try { s.close() } catch { /* gone */ } }
    child.kill()
  }
}

;(async () => {
  try { await partA() } catch (e) { fail++; out.push(['FAIL', `part A crashed — ${e.stack}`]) }
  try { await partB() } catch (e) { fail++; out.push(['FAIL', `part B crashed — ${e.stack}`]) }
  for (const [k, n] of out) console.log(`${k} ${n}`)
  console.log(`\nfriends: ${pass} passed, ${fail} failed`)
  // Not process.exit() straight away: on Windows (node 24) exiting while a handle from
  // part A is still closing trips libuv's `!(handle->flags & UV_HANDLE_CLOSING)` assertion
  // (0xC0000409), which breaks npm test's && chain after a green run. Let handles close first.
  process.exitCode = fail ? 1 : 0
  setTimeout(() => process.exit(process.exitCode), 500).unref()
})()
