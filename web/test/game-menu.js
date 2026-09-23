'use strict'

// The in-game Esc menu's half of the site (routes/gamemenu.js; docs/kickstart/esc-menu.md):
// friends online with where they are, Invite, invites to me with Accept / Decline — the
// rail's own lib/roster.js + lib/parties.js behind the chat pass. Throwaway database, the
// real router over HTTP on an ephemeral port, nothing beyond 127.0.0.1.
//
//   node test/game-menu.js                 the checks
//   node test/game-menu.js --serve 3399    a private site for an in-game capture run: the
//                                          seeded accounts below, the chat AND menu routes,
//                                          a stub /api/party/quit (the site lane owns the
//                                          real one), and it prints ENW_CHAT_BASE/_BEARER.
//
// Every account here is invented (ids 76561198000000201..206); nothing touches web/data.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-gmenu-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')

const { db } = require('../server/db/database')
const users = require('../server/lib/users')
const parties = require('../server/lib/parties')
const presence = require('../server/lib/presence')
const gameChat = require('../server/lib/gameChat')
gameChat.setSecret('test-secret')

const ME = '76561198000000201'        // menu_tester: the player in the game
const LOBBY = '76561198000000202'     // staminup: a friend in a lobby on Verruckt
const INGAME = '76561198000000203'    // deadshot: a friend in a box game on Der Riese
const IDLE = '76561198000000204'      // juggernog: a friend, online, doing nothing
const HOST = '76561198000000205'      // mule_kicker: not a friend; invites ME to Shi No Numa
const STRANGER = '76561198000000206'  // quickrevive: online, not a friend of anybody

function seed() {
  users.ensure(ME, { enw_name: 'menu_tester' })
  users.ensure(LOBBY, { enw_name: 'staminup' })
  users.ensure(INGAME, { enw_name: 'deadshot' })
  users.ensure(IDLE, { enw_name: 'juggernog' })
  users.ensure(HOST, { enw_name: 'mule_kicker' })
  users.ensure(STRANGER, { enw_name: 'quickrevive' })
  db.prepare('UPDATE users SET approved=1').run()
  // ME is NOT approved-for-everyone in the roster's sense: approved accounts see the whole
  // site. Friends scope is what most players get, so keep it: ME sees friends only.
  db.prepare('UPDATE users SET approved=0 WHERE steam_id=?').run(ME)
  const t = Date.now()
  const map = (key, title) => db.prepare('INSERT OR IGNORE INTO maps (key, title, added_at) VALUES (?,?,?)').run(key, title, t)
  map('nazi_zombie_asylum', 'Verruckt')
  map('nazi_zombie_factory', 'Der Riese')
  map('nazi_zombie_sumpf', 'Shi No Numa')
  map('nazi_zombie_prototype', 'Nacht der Untoten')
  for (const f of [LOBBY, INGAME, IDLE]) { users.requestFriend(ME, f); users.requestFriend(f, ME) }
  // staminup sits in a public lobby on Verruckt.
  parties.create(LOBBY, { mode: 'verified', mapKey: 'nazi_zombie_asylum', visibility: 'public' })
  // deadshot is in a game a box reports.
  presence.markInGame(INGAME, { matchId: 'm_seed', mapKey: 'nazi_zombie_factory', box: 'box-1' })
  // mule_kicker, a stranger to ME, invites ME to their lobby on Shi No Numa.
  parties.create(HOST, { mode: 'verified', mapKey: 'nazi_zombie_sumpf', visibility: 'friends' })
  parties.invite(HOST, ME, null)
  // ME is in their own launched game on Nacht.
  parties.create(ME, { mode: 'verified', mapKey: 'nazi_zombie_prototype', visibility: 'friends' })
  for (const s of [ME, LOBBY, IDLE, HOST, STRANGER]) presence.connected(s, 'sock-' + s)
}

function req(port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

function app({ withChat = false, quitStub = false } = {}) {
  const express = require('express')
  const a = express()
  a.use(express.json())
  a.use('/api/game-chat/menu', require('../server/routes/gamemenu').router())
  if (withChat) a.use('/api/game-chat', require('../server/routes/gamechat').router())
  if (quitStub) {
    // STUB. The real `POST /api/party/quit` belongs to the site lane (esc-menu.md, "quit vs
    // crash"). This only proves the game makes the call, with the pass, before it quits.
    a.post('/api/party/quit', (q, r) => {
      const u = gameChat.verifyPass(String(q.headers.authorization || '').replace(/^Bearer\s+/i, ''))
      console.log(`[stub] POST /api/party/quit from ${u ? u.steam_id : '(no valid pass)'} body=${JSON.stringify(q.body)}`)
      r.status(u ? 200 : 401).json(u ? { ok: true, stub: true } : { error: 'no valid chat pass' })
    })
  }
  return a
}

async function serve(port) {
  seed()
  // An approved player (B's friends are): Invite works, and the block is the site's Online.
  db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(ME)
  const pass = gameChat.mintPass(ME).token
  // A few lines for the embedded chat panel to show.
  const say = (sid, channel, text, to) => gameChat.send(users.byId(sid), { channel, text, to })
  say(LOBBY, 'global', 'anyone up for Verruckt? lobby is open')
  say(INGAME, 'global', 'round 14 on Der Riese, the trap is carrying')
  say(IDLE, 'dm', 'want in on the next one?', ME)
  const a = app({ withChat: true, quitStub: true })
  // DEV ONLY (lockdown lane, esc-menu.md §10.3): stands in for the box-authenticated
  // POST /api/gs/result. tools/dev/authhost.mjs --result posts here on the game's game_over;
  // the site's own ingest runs exactly as the box route runs it.
  a.post('/dev/result', (q, r) => {
    const out = require('../server/lib/results').ingest(q.body, { requireVerifiedIdentity: true })
    console.log(`[dev] result ${q.body && q.body.summary && q.body.summary.match_id} -> ok=${out.ok} notified=${out.notified} ${out.error || ''}`)
    r.status(out.ok ? 200 : 400).json({ ok: out.ok, notified: out.notified, error: out.error })
  })
  const server = a.listen(port, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  // Keep the seeded friends "online" (presence is a 2-minute window).
  setInterval(() => {
    for (const s of [ME, LOBBY, IDLE, HOST, STRANGER]) presence.heartbeat(s)
    presence.markInGame(INGAME, { matchId: 'm_seed', mapKey: 'nazi_zombie_factory', box: 'box-1' })   // the box keeps reporting
  }, 20_000).unref()
  const logReq = (q) => console.log(`[site] ${q.method} ${q.originalUrl}`)
  server.on('request', logReq)
  console.log(`private site on http://127.0.0.1:${port}  (db ${TMP})`)
  console.log(`ENW_CHAT_BASE=http://127.0.0.1:${port}`)
  console.log(`ENW_CHAT_BEARER=${pass}`)
}

async function tests() {
  let pass = 0, fail = 0
  const out = []
  async function check(name, fn) {
    try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
  }
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
  const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

  seed()
  const server = app().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  const tok = gameChat.mintPass(ME).token

  await check('no pass: 401 on every route', async () => {
    eq((await req(port, 'GET', '/api/game-chat/menu/state')).status, 401, 'state')
    eq((await req(port, 'POST', '/api/game-chat/menu/invite', { body: { steam_id: IDLE } })).status, 401, 'invite')
    eq((await req(port, 'GET', '/api/game-chat/menu/state', { token: 'gc1.forged.sig' })).status, 401, 'forged')
  })

  let st
  await check('state: friends scope, three friends online with where they are', async () => {
    const r = await req(port, 'GET', '/api/game-chat/menu/state', { token: tok })
    eq(r.status, 200, 'status')
    st = r.body
    eq(st.scope, 'friends', 'scope for an unapproved reader')
    const by = Object.fromEntries(st.friends.map((f) => [f.name, f]))
    truthy(by.staminup && by.deadshot && by.juggernog, 'all three friends listed')
    eq(by.quickrevive, undefined, 'a stranger is not in a friends-scope list')
    eq(by.deadshot.where, 'In game: Der Riese', 'box-reported game')
    eq(by.deadshot.where_kind, 'game', 'kind')
    eq(by.staminup.where, 'Lobby: Verruckt (1/4)', 'lobby')
    eq(by.juggernog.where, 'Online', 'idle')
  })

  await check('state: the invite to me, with the map', async () => {
    eq(st.invites.length, 1, 'one invite')
    eq(st.invites[0].from, 'mule_kicker', 'from')
    eq(st.invites[0].map_title, 'Shi No Numa', 'map')
    eq(st.party && st.party.members, 1, 'my party of one')
  })

  await check('invite: refused for an unapproved account (the rail\'s own gate)', async () => {
    const r = await req(port, 'POST', '/api/game-chat/menu/invite', { token: tok, body: { steam_id: IDLE } })
    eq(r.status, 403, 'status')
  })

  db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(ME)

  await check('invite: approved -> a pending invite on MY party; the row turns to INVITED', async () => {
    const r = await req(port, 'POST', '/api/game-chat/menu/invite', { token: tok, body: { steam_id: IDLE } })
    eq(r.status, 200, 'status')
    eq(r.body.to, 'juggernog', 'to')
    const s = (await req(port, 'GET', '/api/game-chat/menu/state', { token: tok })).body
    const j = s.friends.find((f) => f.name === 'juggernog')
    eq(j.held, 'invited', 'held')
    eq(j.can_invite, false, 'no second Invite button')
  })

  await check('invite: junk steam id is refused, not a 500', async () => {
    const r = await req(port, 'POST', '/api/game-chat/menu/invite', { token: tok, body: { steam_id: 'x' } })
    eq(r.status, 400, 'status')
  })

  await check('accept: a forged invite id is refused', async () => {
    const r = await req(port, 'POST', '/api/game-chat/menu/accept', { token: tok, body: { invite_id: 999999 } })
    eq(r.status, 400, 'status')
  })

  await check('accept: joins the inviter\'s party (the site half; the launcher does the rest)', async () => {
    const id = st.invites[0].id
    const r = await req(port, 'POST', '/api/game-chat/menu/accept', { token: tok, body: { invite_id: id } })
    eq(r.status, 200, 'status')
    eq(r.body.from, 'mule_kicker', 'from')
    const mine = parties.forPlayer(ME)
    eq(String(mine.leader), HOST, 'now in mule_kicker\'s party')
    const s = (await req(port, 'GET', '/api/game-chat/menu/state', { token: tok })).body
    eq(s.invites.length, 0, 'the invite is used')
  })

  await check('decline: only the invitee, only a pending invite', async () => {
    parties.create(LOBBY, { mode: 'verified', mapKey: 'nazi_zombie_asylum', visibility: 'public' })
    const inv = parties.invite(LOBBY, ME, null)
    truthy(inv.ok, 'invite made')
    const id = parties.invitesFor(ME)[0].id
    const other = gameChat.mintPass(IDLE).token
    eq((await req(port, 'POST', '/api/game-chat/menu/decline', { token: other, body: { invite_id: id } })).status, 400, 'someone else')
    eq((await req(port, 'POST', '/api/game-chat/menu/decline', { token: tok, body: { invite_id: id } })).status, 200, 'the invitee')
    eq(parties.invitesFor(ME).length, 0, 'gone')
  })

  server.close()
  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\ngame-menu: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

const si = process.argv.indexOf('--serve')
if (si >= 0) serve(Number(process.argv[si + 1] || 3399))
else tests()
