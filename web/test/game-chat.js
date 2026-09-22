'use strict'

// The in-game chat overlay's half of the site: the chat pass, the private ring (party +
// DMs) and the long-poll, driven in-process against a throwaway database, plus the real
// routes over HTTP on an ephemeral port. No network beyond 127.0.0.1.
//
//   node test/game-chat.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-gchat-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db } = require('../server/db/database')
const users = require('../server/lib/users')
const parties = require('../server/lib/parties')
const chat = require('../server/lib/chatNetwork')
const bans = require('../server/lib/bans')
const gameChat = require('../server/lib/gameChat')
gameChat.setSecret('test-secret')

const A = '76561198000000101'
const B = '76561198000000102'
const C = '76561198000000103'   // a stranger to A
users.ensure(A, { enw_name: 'alpha' })
users.ensure(B, { enw_name: 'bravo' })
users.ensure(C, { enw_name: 'charlie' })
db.prepare('UPDATE users SET approved=1').run()

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

async function main() {
  await check('a pass verifies to its own account', () => {
    const p = gameChat.mintPass(A)
    truthy(p.token.startsWith('gc1.'), 'prefix')
    eq(gameChat.verifyPass(p.token).steam_id, A, 'steamid')
  })
  await check('a tampered pass is refused', () => {
    const p = gameChat.mintPass(A)
    const [v, body, sig] = p.token.split('.')
    const forged = Buffer.from(JSON.stringify({ s: B, e: 9999999999, n: 'x' })).toString('base64url')
    eq(gameChat.verifyPass(`${v}.${forged}.${sig}`), null, 'forged body')
    eq(gameChat.verifyPass(`${v}.${body}.${sig.slice(0, -2)}AA`), null, 'bad sig')
    eq(gameChat.verifyPass('nonsense'), null, 'garbage')
  })
  await check('an expired pass is refused', () => {
    const p = gameChat.mintPass(A, { ttl: -5 })
    eq(gameChat.verifyPass(p.token), null, 'expired')
  })
  await check('a pass from another site secret is refused', () => {
    const p = gameChat.mintPass(A)
    gameChat.setSecret('another-site')
    eq(gameChat.verifyPass(p.token), null, 'other secret')
    gameChat.setSecret('test-secret')
  })
  await check('a site-banned account loses its pass', () => {
    const p = gameChat.mintPass(C)
    truthy(gameChat.verifyPass(p.token), 'before')
    bans.ban({ steamId: C, scope: 'site', reason: 'test' })
    eq(gameChat.verifyPass(p.token), null, 'after the ban')
    db.prepare("UPDATE bans SET active=0 WHERE steam_id=?").run(C)
  })

  await check('global lines go into the SAME ring the dock and the boxes read', () => {
    const r = gameChat.send(users.byId(A), { channel: 'global', text: 'hello from the game' })
    eq(r.ok, true, 'ok')
    const tail = chat.tail(5)
    eq(tail[tail.length - 1].text, 'hello from the game', 'in chat_network')
    eq(tail[tail.length - 1].origin, 'game', 'origin is not a box name, so every box drains it')
  })

  let partyId = 0
  await check('party lines reach the party and nobody else', () => {
    const p = parties.create(A, { visibility: 'public' })
    partyId = p.id
    const j = parties.join(B, p.id)
    if (j && j.ok === false) throw new Error('join: ' + j.error)
    const r = gameChat.send(users.byId(A), { channel: 'party', text: 'box by the power' })
    eq(r.ok, true, 'sent')
    eq(gameChat.privateFor(B).some((l) => l.text === 'box by the power'), true, 'member sees it')
    eq(gameChat.privateFor(C).some((l) => l.text === 'box by the power'), false, 'stranger does not')
  })
  await check('party lines never appear in the global ring', () => {
    eq(chat.tail(50).some((l) => l.text === 'box by the power'), false, 'leaked into chat_network')
  })
  await check('party chat needs a party', () => {
    eq(gameChat.send(users.byId(C), { channel: 'party', text: 'x' }).ok, false, 'no party')
  })
  await check('a DM to a party member arrives, and only there', () => {
    const r = gameChat.send(users.byId(B), { channel: 'dm', to: A, text: 'ready when you are' })
    eq(r.ok, true, 'sent')
    eq(r.line.to, A, 'to')
    eq(gameChat.privateFor(A).some((l) => l.text === 'ready when you are'), true, 'A sees it')
    eq(gameChat.privateFor(B).some((l) => l.text === 'ready when you are'), true, 'B sees own')
    eq(gameChat.privateFor(C).some((l) => l.text === 'ready when you are'), false, 'C does not')
  })
  await check('a stranger cannot DM', () => {
    const r = gameChat.send(users.byId(C), { channel: 'dm', to: A, text: 'hi' })
    eq(r.ok, false, 'refused')
  })
  await check('/me carries pause_on_chat (default on) and the DM contacts', () => {
    const me = gameChat.meFor(users.byId(A))
    eq(me.pause_on_chat, true, 'default')
    eq(me.party.id, partyId, 'party')
    eq(me.contacts.some((c) => c.steamid === B), true, 'party member is a contact')
    users.saveSettings(A, { pause_on_chat: false })
    eq(gameChat.meFor(users.byId(A)).pause_on_chat, false, 'setting off')
    users.saveSettings(A, { pause_on_chat: true })
  })

  await check('the long-poll wakes on a new private line', async () => {
    const first = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0 })
    truthy(first.g > 0 && first.p > 0, 'cursors set to now')
    const pending = gameChat.feed(users.byId(A), { g: first.g, p: first.p, wait: 5 })
    const t0 = Date.now()
    setTimeout(() => gameChat.send(users.byId(B), { channel: 'dm', to: A, text: 'wake up' }), 150)
    // B may be rate-limited from the previous check; use a fresh window if so
    const got = await pending
    if (!got.private.some((l) => l.text === 'wake up')) {
      // B was limited: prove the wake with the party channel from A instead
      throw new Error('no wake (rate limit?) ' + JSON.stringify(got.private))
    }
    truthy(Date.now() - t0 < 4000, 'woke early')
  })

  await check('the rate limit holds at 5 per 10 s', () => {
    const u = users.byId(C)
    let refused = 0
    for (let i = 0; i < 8; i++) if (!gameChat.send(u, { channel: 'global', text: 'spam ' + i }).ok) refused++
    truthy(refused >= 3, `refused ${refused}`)
  })
  // ---- over HTTP, through the real router ----
  const express = require('express')
  const app = express()
  app.use(express.json())
  app.use('/api/game-chat', require('../server/routes/gamechat').router())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = server.address().port
  const tokA = gameChat.mintPass(A).token

  await check('HTTP: no pass, 401', async () => {
    eq((await req(port, 'GET', '/api/game-chat/me')).status, 401, 'status')
  })
  await check('HTTP: a session-style cookie is not a pass', async () => {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/game-chat/me', headers: { cookie: 'zm.sid=whatever' } },
        (res) => { res.resume(); resolve(res.statusCode) })
    })
    eq(r, 401, 'status')
  })
  await check('HTTP: /me with a pass', async () => {
    const r = await req(port, 'GET', '/api/game-chat/me', { token: tokA })
    eq(r.status, 200, 'status')
    eq(r.body.steamid, A, 'steamid')
    eq(r.body.pause_on_chat, true, 'pause_on_chat')
  })
  await check('HTTP: send + feed round trip', async () => {
    await new Promise((r) => setTimeout(r, 10))
    const f0 = await req(port, 'GET', '/api/game-chat/feed?g=0&p=0&wait=0', { token: tokA })
    eq(f0.status, 200, 'feed status')
    const s = await req(port, 'POST', '/api/game-chat/send', { token: tokA, body: { channel: 'party', text: 'over http' } })
    eq(s.status, 200, 'send status')
    const f1 = await req(port, 'GET', `/api/game-chat/feed?g=${f0.body.g}&p=${f0.body.p}&wait=1`, { token: tokA })
    eq(f1.body.private.some((l) => l.text === 'over http'), true, 'line in the feed')
  })
  await check('HTTP: a refused send is a 400 with a reason', async () => {
    const s = await req(port, 'POST', '/api/game-chat/send', { token: tokA, body: { channel: 'dm', to: C, text: 'hi' } })
    eq(s.status, 400, 'status')
    truthy(s.body.error, 'error text')
  })
  server.close()

  for (const [a, b] of out) console.log(a, b)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
