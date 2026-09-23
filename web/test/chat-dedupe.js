'use strict'

// The global chat's duplicate lines on joining a game (B, 2026-09-23 night), reproduced and
// then held shut. Three causes, one test block each:
//
//   1. THE OVERLAY'S FIRST POLL REPLAYED THE RING. `/api/game-chat/feed?g=0` answered with
//      `chat.tail(20)`, and the overlay stamps every line it receives with the time it
//      ARRIVED (chat_overlay.cpp `line_from_json`, `l.arrived = GetTickCount()`), so on
//      joining a game the last five lines of the ring appeared on the HUD as if just said —
//      the previous game's "myu started a game on <map>" beside this game's identical one.
//      The box drain has refused to do this since the start (routes/gameserver.js: since=0
//      is a cursor and no events); the overlay's feed now follows the same rule.
//   2. ONE GAME, SEVERAL SYSTEM LINES. The live ring holds "B's game … ended on round 1",
//      then "somebody's game on Nacht ended" and "somebody's game on Unknown map ended" for
//      the same instance: the host resets its starter on `map_loaded` (the post-game reload)
//      and the teardown sends game_over again with nobody to name. And a restart announces
//      the same player starting the same match again.
//   3. THE DOCK'S MERGE. The fill used to reset the list, dropping a live line that landed
//      before the backlog answered; a reconnect never caught up. Now one merge, by id.
//
//   node test/chat-dedupe.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-chatdup-'))
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
const chatSystem = require('../server/lib/chatSystem')
const gameChat = require('../server/lib/gameChat')
gameChat.setSecret('test-secret')

const A = '76561198000000301'
users.ensure(A, { enw_name: 'myu' })
db.prepare('UPDATE users SET approved=1').run()

async function main() {
  // ── 1. the overlay's first poll ────────────────────────────────────────────
  // The ring as it stood before B joined his 02:41 game: a previous game's start line.
  chatSystem._reset()
  chatSystem.record('zombies-dev', { event: 'started', name: 'myu', steamid: A, identity: 'verified', map: 'nazi_zombie_fear_mc_2', match_id: 'm_old', instance: 'inst-03' })
  gameChat.send(users.byId(A), { channel: 'global', text: 'hello' })
  // ...and this game's, the moment he connects.
  chatSystem.record('zombies-dev', { event: 'started', name: 'myu', steamid: A, identity: 'verified', map: 'nazi_zombie_fear_mc_2', match_id: 'm_new', instance: 'inst-08' })

  let first = null
  await check('first poll from a game that just joined replays no global history', async () => {
    first = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0 })
    eq(first.global.length, 0, 'lines replayed onto the HUD as new')
    eq(first.g, chat.latest(), 'the cursor is "now"')
  })
  await check('the next poll carries only what is said after joining, once', async () => {
    const pending = gameChat.feed(users.byId(A), { g: first.g, p: first.p, wait: 3 })
    setTimeout(() => gameChat.send(users.byId(A), { channel: 'global', text: 'hi' }), 50)
    const got = await pending
    eq(got.global.length, 1, 'lines')
    eq(got.global[0].text, 'hi')
    const again = await gameChat.feed(users.byId(A), { g: got.g, p: got.p, wait: 0 })
    eq(again.global.length, 0, 'the same line a second time')
  })
  await check('history is opt-in (?history=1) and every backlog line says it is backlog', async () => {
    const h = await gameChat.feed(users.byId(A), { g: 0, p: 0, wait: 0, history: true })
    truthy(h.global.length >= 3, 'backlog returned')
    eq(h.global.every((l) => l.backfill === true), true, 'backfill flag on every line')
    eq(h.g, chat.latest(), 'cursor still now')
  })

  // ── 2. one game, one line per fact ─────────────────────────────────────────
  await check('a game that ends, reloads and is torn down says "ended" once', () => {
    chatSystem._reset()
    const before = chat.latest()
    const base = { map: 'nazi_zombie_prototype', match_id: 'm_1', instance: 'inst-01' }
    chatSystem.record('zombies-dev', { ...base, event: 'started', name: 'B', steamid: A, identity: 'verified' })
    chatSystem.record('zombies-dev', { ...base, event: 'ended', name: 'B', steamid: A, identity: 'verified', round: 1 })
    // map_loaded reset the host's starter; the teardown's game_over names nobody
    chatSystem.record('zombies-dev', { ...base, event: 'ended', name: null, identity: 'none' })
    chatSystem.record('zombies-dev', { ...base, map: null, event: 'ended', name: null, identity: 'none' })
    const lines = chat.since(before).map((l) => l.text)
    eq(lines.length, 2, `lines: ${JSON.stringify(lines)}`)
    eq(lines[1], "myu's game on nazi_zombie_prototype ended on round 1")
  })
  await check('the same player starting the same match again is not a second start', () => {
    chatSystem._reset()
    const before = chat.latest()
    const base = { map: 'nazi_zombie_fear_mc_2', match_id: 'm_2', instance: 'inst-08', name: 'myu', steamid: A, identity: 'verified' }
    chatSystem.record('zombies-dev', { ...base, event: 'started' })
    // 25 s later, past the old 20 s window: the post-game restart reconnects everybody
    const realNow = Date.now
    Date.now = () => realNow() + 25_000
    try {
      chatSystem.record('zombies-dev', { ...base, event: 'started' })
      chatSystem.record('zombies-dev', { ...base, event: 'joined' })
    } finally { Date.now = realNow }
    eq(chat.since(before).length, 1, 'lines')
  })
  await check('two different games still get a line each', () => {
    chatSystem._reset()
    const before = chat.latest()
    chatSystem.record('zombies-dev', { event: 'started', name: 'myu', map: 'zm_nuked', match_id: 'm_3', instance: 'inst-01' })
    chatSystem.record('zombies-dev', { event: 'started', name: 'myu', map: 'zm_nuked', match_id: 'm_4', instance: 'inst-02' })
    eq(chat.since(before).length, 2, 'lines')
  })
  await check('downs are still one line per down', () => {
    chatSystem._reset()
    const before = chat.latest()
    const base = { event: 'down', name: 'myu', map: 'zm_nuked', match_id: 'm_5', instance: 'inst-01' }
    chatSystem.record('zombies-dev', { ...base, round: 3 })
    chatSystem.record('zombies-dev', { ...base, round: 4 })
    eq(chat.since(before).length, 2, 'lines')
  })

  // ── 3. the dock's merge (client/src/chatLines.js) ──────────────────────────
  let mod = {}
  try { mod = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'chatLines.js')).href) } catch (e) { out.push(['FAIL', 'client/src/chatLines.js — ' + e.message]); fail++ }
  const mergeLines = mod.mergeLines || (() => { throw new Error('no mergeLines') })
  const lastId = mod.lastId || (() => 0)
  const L = (id, text = 't' + id) => ({ id, text })
  await check('dock: a live line that lands before the backlog answers is kept, once', () => {
    let lines = mergeLines([], [L(5)])                    // socket, first
    lines = mergeLines(lines, [L(3), L(4), L(5)])          // the backlog, which also holds 5
    eq(lines.map((l) => l.id).join(','), '3,4,5')
  })
  await check('dock: the same id from the socket and a reconnect catch-up is drawn once', () => {
    let lines = mergeLines([], [L(1), L(2)])
    lines = mergeLines(lines, [L(3)])
    lines = mergeLines(lines, [L(2), L(3), L(4)])
    eq(lines.map((l) => l.id).join(','), '1,2,3,4')
    eq(lastId(lines), 4, 'the catch-up cursor')
  })
  await check('dock: string and number ids are the same line', () => {
    const lines = mergeLines([L(7)], [{ id: '7', text: 't7' }])
    eq(lines.length, 1)
  })
  await check('dock: the cap keeps the newest', () => {
    const many = Array.from({ length: 10 }, (_, i) => L(i + 1))
    eq(mergeLines([], many, 4).map((l) => l.id).join(','), '7,8,9,10')
  })

  // ── the server's backfill cursor ───────────────────────────────────────────
  await check('GET /api/chat?since=<id> returns only newer lines, in order', async () => {
    const express = require('express')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.me = null; next() })
    app.use('/api', require('../server/routes/site').router())
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    try {
      const mark = chat.latest()
      chat.push({ from: 'x', text: 'after the mark 1' })
      chat.push({ from: 'x', text: 'after the mark 2' })
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/chat?since=${mark}`)
      const j = await r.json()
      eq(j.chat.map((l) => l.text).join('|'), 'after the mark 1|after the mark 2')
      eq(j.latest, chat.latest(), 'latest')
    } finally { server.close() }
  })

  for (const [a, b] of out) console.log(a, b)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
