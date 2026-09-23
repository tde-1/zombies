'use strict'

// A map's own game modes (docs/kickstart/game-modes.md, lane UGX, 2026-09-23): Battlestar
// Galactica's UGX vote (Classic / Gun Game / Sharpshooter ...) picked by the party leader,
// carried on the lease to the box, and records kept per mode. Uses the real catalogue,
// server/data/map-modes.json (archive/scan_modes.py), and the real routers.
//
//   node test/game-modes.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-modes-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db, now } = require('../server/db/database')
const users = require('../server/lib/users')
const maps = require('../server/lib/maps')
const boxes = require('../server/lib/boxes')
const parties = require('../server/lib/parties')
const assignments = require('../server/lib/assignments')
const results = require('../server/lib/results')
const records = require('../server/lib/records')
const gameModes = require('../server/lib/gameModes')

const MAP = 'battlestar_galactica'
const PLAIN = 'nazi_zombie_test'
const LEAD = '76561198000000501'
const MATE = '76561198000000502'
for (const [key, title] of [[MAP, 'Battlestar Galactica'], [PLAIN, 'Test Map']]) {
  maps.SERVER_PROVEN.add(key)
  db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, main_finish, round_n, has_ee, added_at)
              VALUES (?,?,?,'tester','custom','verified','none',20,0,?)`).run(key, key, title, now())
  const m = db.prepare('SELECT * FROM maps WHERE key=?').get(key)
  db.prepare("INSERT INTO map_versions (map_id, version, latest, health, fs_game, added_at) VALUES (?, '1.0', 1, 'verified', ?, ?)")
    .run(m.id, `mods/${key}`, now())
}
users.ensure(LEAD, { enw_name: 'lead_one' })
users.ensure(MATE, { enw_name: 'mate_two' })
db.prepare('UPDATE users SET approved=1').run()
boxes.create({ name: 'test-box', matchKey: 'test-secret' })
db.prepare('UPDATE boxes SET last_poll=?').run(now())

const summary = (matchId, o = {}) => ({
  match_id: matchId, mode: 'verified', map: MAP, rounds: o.rounds ?? 12, finish: null,
  players: [{ slot: 0, steamid: LEAD, name: 'lead_one', identity: 'verified', score: 1000,
    stats: { kills: 50, headshots: 5, downs: 0, revives: 0, points_earned: 1000, points_spent: 0, time_alive_ms: 600000, rounds_played: 12 } }],
  player_count: 1, solo: true, duration_ms: 600000, duration_rta_ms: 600000, paused_ms: 0,
  flags: [], records_eligible: true, xp_multiplier: 1,
  started_at: new Date(Date.now() - 600000).toISOString(), ended_at: new Date().toISOString(),
  fingerprint: 'fp' + matchId, dvars: {},
  ...o,
})

function play(gameMode, { applied = true, reported, silent = false } = {}) {
  parties.leave(LEAD)
  parties.create(LEAD, { mode: 'verified', mapKey: MAP, visibility: 'private' })
  if (gameMode) { const s = parties.setGameMode(LEAD, gameMode); if (!s.ok) throw new Error(s.error) }
  parties.startReadyCheck(LEAD, { force: true })
  const l = parties.launch(LEAD, {})
  if (!l.ok) throw new Error(`launch: ${l.error}`)
  const asg = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(l.match_id)
  const r = results.ingest({ box: 'test-box', summary: summary(l.match_id, {
    game_mode: reported === undefined ? asg.game_mode : reported, game_mode_applied: silent ? undefined : applied,
  }) }, { requireVerifiedIdentity: false })
  if (!r.ok) throw new Error(`ingest: ${r.error}`)
  return { lease: l, asg, game: db.prepare('SELECT * FROM games WHERE match_id=?').get(l.match_id) }
}

async function main() {
  await check('the catalogue: Battlestar is UGX 1.0 with Classic as its default; a plain map has no modes', () => {
    const m = gameModes.forMap(MAP)
    truthy(m, 'battlestar has modes')
    eq(m.default, 'classic')
    eq(m.mechanism, 'ugx_vote_1')
    for (const id of ['classic', 'gungame', 'sharpshooter']) truthy(m.modes.some((x) => x.id === id), id)
    eq(gameModes.forMap(PLAIN), null)
    eq(gameModes.resolve(MAP, 'nonsense'), 'classic', 'unknown -> default')
    eq(gameModes.resolve(PLAIN, 'gungame'), null, 'a map without modes never gets one')
  })

  await check('the lease spec the box gets: hide both vote menus, answer the host menu with the pick then start', () => {
    eq(gameModes.leaseSpec(MAP, 'gungame'), {
      id: 'gungame', label: 'Gun Game', mechanism: 'ugx_vote_1', hide: ['ugxm_vote_host', 'ugxm_vote_players'],
      answer_menu: 'ugxm_vote_host', responses: ['gg', 'start'], done: 'ugxm_voting_complete',
    })
    eq(gameModes.leaseSpec(MAP, 'sharpshooter').responses, ['ss', 'start'])
    eq(gameModes.leaseSpec(MAP, 'nope'), null)
  })

  await check('the party: default mode shown, leader only, only a mode the map offers, a new map resets it', () => {
    parties.leave(LEAD); parties.leave(MATE)
    const p0 = parties.create(LEAD, { mode: 'verified', mapKey: MAP, visibility: 'private' })
    eq(p0.game_mode, 'classic')
    truthy(p0.map.modes && p0.map.modes.modes.length >= 3, 'the picker gets the modes')
    parties.join(MATE, p0.id)
    eq(parties.setGameMode(MATE, 'gungame').ok, false, 'not the leader')
    eq(parties.setGameMode(LEAD, 'wallrun').ok, false, 'not on this map')
    eq(parties.setGameMode(LEAD, 'gungame').party.game_mode, 'gungame')
    eq(parties.setMap(LEAD, PLAIN).party.game_mode, null, 'a map without modes')
    eq(parties.setGameMode(LEAD, 'gungame').ok, false, 'and it cannot be given one')
    eq(parties.setMap(LEAD, MAP).party.game_mode, 'classic', 'back on Battlestar: its default, not the old pick')
    const staged = (parties.leave(LEAD), parties.leave(MATE), parties.create(LEAD, { mapKey: MAP, gameMode: 'sharpshooter' }))
    eq(staged.game_mode, 'sharpshooter', 'a staged pick survives create')
    parties.leave(LEAD)
    eq(parties.create(LEAD, { mapKey: PLAIN, gameMode: 'sharpshooter' }).game_mode, null, 'a staged pick for a map without modes is dropped')
    parties.leave(LEAD)
  })

  let gg
  await check('Play in Gun Game: the lease row and the box payload carry the mode', () => {
    gg = play('gungame')
    eq(gg.asg.game_mode, 'gungame')
    const box = boxes.byName ? boxes.byName('test-box') : db.prepare("SELECT * FROM boxes WHERE name='test-box'").get()
    const shaped = assignments.forBox(box, { v: 2 })
    // The lease is closed by the ingest, so read the shape of a live one instead.
    parties.leave(LEAD)
    parties.create(LEAD, { mapKey: MAP, visibility: 'private' })
    parties.setGameMode(LEAD, 'sharpshooter')
    parties.startReadyCheck(LEAD, { force: true })
    const l = parties.launch(LEAD, {})
    const live = assignments.forBox(box, { v: 2 }).assignments.find((a) => a.match_id === l.match_id)
    truthy(live, `live lease on the box (had ${shaped.assignments.length})`)
    eq(live.game_mode.id, 'sharpshooter')
    eq(live.game_mode.responses, ['ss', 'start'])
    eq(live.game_mode.hide, ['ugxm_vote_host', 'ugxm_vote_players'])
    db.prepare("UPDATE assignments SET state='done' WHERE match_id=?").run(l.match_id)
  })

  await check('a plain map\'s lease carries no game mode at all', () => {
    parties.leave(LEAD)
    parties.create(LEAD, { mapKey: PLAIN, visibility: 'private' })
    parties.startReadyCheck(LEAD, { force: true })
    const l = parties.launch(LEAD, {})
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(l.match_id)
    eq(a.game_mode, null)
    const box = db.prepare("SELECT * FROM boxes WHERE name='test-box'").get()
    const live = assignments.forBox(box, { v: 2 }).assignments.find((x) => x.match_id === l.match_id)
    eq('game_mode' in live, false, 'no game_mode key for an old host agent to trip on')
    db.prepare("UPDATE assignments SET state='done' WHERE match_id=?").run(l.match_id)
  })

  await check('the Gun Game result: the game row carries the mode and it goes on a Gun Game board', () => {
    eq(gg.game.game_mode, 'gungame')
    eq(gg.game.records_eligible, 1)
    const b = db.prepare("SELECT * FROM boards WHERE map_key=? AND game_mode='gungame' AND profile='ENW-Verified'").get(MAP)
    truthy(b, 'a gungame board')
    eq(b.category, 'round@gungame')
    eq(b.label, 'Highest round · Gun Game')
    eq(results.project(gg.game).game_mode_label, 'Gun Game')
  })

  await check('a Classic run is on its OWN board: a mode is only ranked against itself', () => {
    const cl = play(null, { applied: true })   // the party's default
    eq(cl.game.game_mode, 'classic')
    const groups = records.forMap(MAP)
    const byMode = Object.fromEntries(groups.filter((g) => g.base === 'round').map((g) => [g.game_mode, g]))
    truthy(byMode.gungame && byMode.classic, `both boards: ${Object.keys(byMode)}`)
    eq(byMode.gungame.counts[0].rows.length, 1, 'one run on the gungame board')
    eq(byMode.classic.counts[0].rows.length, 1, 'one run on the classic board')
    eq(byMode.gungame.game_mode_label, 'Gun Game')
    eq(records.forMap(MAP, { gameMode: 'gungame' }).every((g) => g.game_mode === 'gungame'), true, 'the filter')
    eq(records.hub({ gameMode: 'classic' }).every((r) => r.game_mode === 'classic'), true, 'the hub filter')
    truthy(records.hub({ category: 'round' }).length >= 2, 'the hub base category spans modes')
  })

  await check('a mode the server did not prove took is kept, flagged, and never a record', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM records').get().c
    const r = play('sharpshooter', { applied: false })
    eq(r.game.game_mode, 'sharpshooter')
    eq(r.game.records_eligible, 0)
    truthy(JSON.parse(r.game.flags).includes('game_mode_unconfirmed'), 'flagged')
    const other = play('sharpshooter', { applied: true, reported: 'gungame' })
    eq(other.game.records_eligible, 0, 'the box ran a different mode')
    const old = play('sharpshooter', { silent: true, reported: null })
    eq(old.game.records_eligible, 0, 'an old host agent that says nothing')
    eq(db.prepare('SELECT COUNT(*) c FROM records').get().c, before, 'no record rows')
  })

  await check('the profile\'s best round counts only a map\'s default mode', () => {
    play('gungame', { applied: true })
    db.prepare("UPDATE games SET rounds=40 WHERE game_mode='gungame'").run()
    db.prepare("UPDATE games SET rounds=12 WHERE game_mode='classic'").run()
    eq(results.careerFor(LEAD).best_round, 12)
    const prof = require('../server/lib/profile')
    const fn = prof.statsFor || prof.stats || prof.summary
    if (typeof fn === 'function') {
      const s = fn(LEAD)
      if (s && s.best_round) eq(s.best_round.round, 12, 'profile headline')
    }
  })

  await check('HTTP: /api/party/game-mode and /api/records?game_mode= go through the real router', async () => {
    const express = require('express')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.session = { steam_id: req.headers['x-sid'] || null }; next() })
    app.use(require('../server/middleware/auth').attach)
    app.use('/api', require('../server/routes/site').router())
    app.use('/api/maps', require('../server/routes/maps').router())
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const call = async (as, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { ...(as ? { 'x-sid': as } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      let j = null
      try { j = await r.json() } catch { /* empty */ }
      return { status: r.status, body: j }
    }
    try {
      parties.leave(LEAD); parties.leave(MATE)
      const c = await call(LEAD, 'POST', '/api/party/create', { mapKey: MAP, game_mode: 'sharpshooter' })
      eq(c.status, 200); eq(c.body.party.game_mode, 'sharpshooter', 'create takes the staged pick')
      const g = await call(LEAD, 'POST', '/api/party/game-mode', { game_mode: 'gungame' })
      eq(g.status, 200); eq(g.body.party.game_mode, 'gungame')
      const bad = await call(LEAD, 'POST', '/api/party/game-mode', { game_mode: 'x;quit' })
      eq(bad.status, 400)
      const rec = await call(null, 'GET', '/api/records?game_mode=gungame')
      eq(rec.status, 200)
      truthy(rec.body.records.length && rec.body.records.every((r) => r.game_mode === 'gungame'), 'only gungame')
      const mp = await call(null, 'GET', `/api/maps/${MAP}`)
      if (mp.status === 200) {
        eq(mp.body.map.modes.default, 'classic', 'the map page gets the modes')
        truthy(mp.body.boards.some((b) => b.game_mode === 'gungame'), 'and the per-mode boards')
      }
    } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
  })

  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
  setTimeout(() => process.exit(process.exitCode), 200).unref()
}

main().catch((e) => { console.error(e); process.exit(1) })
