'use strict'

// "Your record has been uploaded" (B, 2026-09-23): the in-game line a verified player gets
// when the site has stored the box's result for their game. It rides the overlay's own
// long-poll (/api/game-chat/feed) as a private `notice` line addressed to that player only.
// And the overlay's history=1 backlog (the DLL now asks for it on its first poll) carries
// earlier notices as backfill, never as news.
//
//   node test/record-notice.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-notice-'))
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
const chat = require('../server/lib/chatNetwork')
const results = require('../server/lib/results')
const gameChat = require('../server/lib/gameChat')
gameChat.setSecret('test-secret')

const A = '76561198000000401'   // verified in the game
const B = '76561198000000402'   // not in the game
const C = '76561198000000403'   // in the game, identity only claimed
for (const [sid, n] of [[A, 'anna'], [B, 'bob'], [C, 'cleo']]) users.ensure(sid, { enw_name: n })
db.prepare('UPDATE users SET approved=1').run()

const summary = (o = {}) => ({
  match_id: 'm_notice1', mode: 'verified', map: 'nazi_zombie_prototype', rounds: 3,
  records_eligible: true, flags: [], duration_ms: 60000, finish: null,
  players: [
    { slot: 0, name: 'anna', steamid: A, identity: 'verified' },
    { slot: 1, name: 'cleo', steamid: C, identity: 'claimed' },
  ],
  ...o,
})

const noticesFor = (sid) => gameChat.privateFor(sid, 0, { tailN: 50 }).filter((l) => l.channel === 'notice')

async function main() {
  // A fresh game client, as the DLL starts: cursors only.
  const first = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0 })
  const ringBefore = chat.latest()

  await check('a stored box result says "Your record has been uploaded." to the verified player, on the overlay\'s poll', async () => {
    const pending = gameChat.feed(users.byId(A), { g: first.g, p: first.p, wait: 3 })
    const r = results.ingest({ box: 'test-box', summary: summary() }, { requireVerifiedIdentity: true })
    truthy(r.ok, r.error)
    eq(r.notified, 1, 'one player told')
    const got = await pending
    eq(got.private.length, 1, 'one private line')
    const l = got.private[0]
    eq(l.text, 'Your record has been uploaded.')
    eq(l.channel, 'notice')
    eq(l.kind, 'system', 'drawn as a system line')
    eq(l.from, 'ENW')
    eq(l.backfill, undefined, 'news, not backlog')
  })

  await check('nobody else hears it: not a player who was not in the game, not a claimed identity, not the global ring', () => {
    eq(noticesFor(B).length, 0, 'B')
    eq(noticesFor(C).length, 0, 'C (claimed)')
    eq(chat.latest(), ringBefore, 'the global ring did not move')
  })

  await check('a retry of the same result does not say it twice', () => {
    const r = results.ingest({ box: 'test-box', summary: summary() }, { requireVerifiedIdentity: true })
    truthy(r.repeat, 'a repeat')
    eq(noticesFor(A).length, 1)
  })

  await check('a Custom (not record-eligible) game says the game is saved and is not a record', () => {
    const r = results.ingest({ box: 'test-box', summary: summary({ match_id: 'm_notice2', mode: 'custom', records_eligible: false }) },
      { requireVerifiedIdentity: true })
    truthy(r.ok, r.error)
    const n = noticesFor(A)
    eq(n.length, 2)
    eq(n[1].text, 'Your game has been saved. Not record-eligible.')
  })

  await check('a Local run (not the box path) says nothing in game', () => {
    const r = results.ingest({ summary: summary({ match_id: 'm_notice3', mode: 'local' }) })
    truthy(r.ok, r.error)
    eq(r.notified, undefined)
    eq(noticesFor(A).length, 2)
  })

  await check('history=1 (the DLL\'s first poll) hands earlier notices over as backfill, so they are not HUD news', async () => {
    const h = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0, history: true })
    const n = h.private.filter((l) => l.channel === 'notice')
    eq(n.length, 2)
    truthy(n.every((l) => l.backfill === true), 'every backlog line is backfill')
    const plain = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0 })
    eq(plain.private.length, 0, 'without history=1 a first poll is still cursors only')
  })

  await check('notify refuses a non-SteamID and an empty line', () => {
    eq(gameChat.notify('bob', 'x'), null)
    eq(gameChat.notify(A, '   '), null)
  })

  for (const [k, m] of out) console.log(`${k} ${m}`)
  console.log(`\nrecord-notice: ${pass} passed, ${fail} failed`)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* windows */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
