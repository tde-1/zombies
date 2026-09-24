'use strict'

// Parties that carry over between games (docs/kickstart/cloud-brief-parties.md, tasks 2-4).
//
//   node test/party-carryover.js
//
// In-process, against a throwaway database, like test/run-all.js. Fake SteamIDs only.
//   2. joining a party whose game is running puts you in that game (assignments.addPlayer)
//   3. changing map while a game runs switches the party's server (parties.switchMap)
//   4. a party keeps its members, leader and settings through everything that ends a game

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-carry-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'

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
const assignments = require('../server/lib/assignments')
const parties = require('../server/lib/parties')
const progress = require('../server/lib/partyProgress')
const seats = require('../server/lib/seats')
const tokens = require('../server/lib/tokens')
const results = require('../server/lib/results')
const { execFileSync } = require('child_process')

const A = '76561198000000501'   // leads
const B = '76561198000000502'
const C = '76561198000000503'
const D = '76561198000000504'
const E = '76561198000000505'
for (const [sid, n] of [[A, 'alpha_lead'], [B, 'bravo_two'], [C, 'charlie_3'], [D, 'delta_four'], [E, 'echo_five']]) {
  users.ensure(sid, { enw_name: n })
  db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(sid)
}
for (const [key, source] of [['nazi_zombie_carry', 'custom'], ['nazi_zombie_carry2', 'custom'], ['nazi_zombie_prototype', 'stock']]) {
  maps.SERVER_PROVEN.add(key)
  db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, round_n, added_at)
              VALUES (?,?,?,'tester',?,'verified',20,?)`).run(key, key, key.replace('nazi_zombie_', 'Carry '), source, now())
  const m = db.prepare('SELECT * FROM maps WHERE key=?').get(key)
  db.prepare("INSERT INTO map_versions (map_id, version, latest, health, added_at) VALUES (?, '1.0', 1, 'verified', ?)").run(m.id, now())
}
boxes.create({ name: 'carry-box', matchKey: 'carry-secret', maxInstances: 4 })
const BOX = () => boxes.byName('carry-box')
const online = () => { db.prepare('UPDATE boxes SET last_poll=?, reserve=0 WHERE name=?').run(now(), 'carry-box'); assignments.notePoll(BOX(), 2) }
const row = (m) => db.prepare('SELECT * FROM assignments WHERE match_id=?').get(m)
const stateOf = (m) => (row(m) || {}).state

// What the sockets carried: [to, event, payload].
const sent = []
parties.setEmitter((ids, event, payload) => { for (const id of ids) sent.push([id, event, payload]) })

/** A party led by A with `members`, map `map`, launched and live. Returns the match id. */
function liveParty(members, map = 'nazi_zombie_carry') {
  for (const s of [A, ...members]) parties.leave(s)
  parties.create(A, { mode: 'custom', mapKey: map, visibility: 'public' })
  const pid = parties.forPlayer(A).id
  for (const s of members) truthy(parties.join(s, pid).ok, `${s} joins`)
  online()
  parties.startReadyCheck(A, { force: true })
  for (const s of members) parties.setReady(s, true)
  const r = parties.launch(A)
  truthy(r.ok, r.error)
  assignments.ack(BOX(), 'live', r.match_id)
  return r.match_id
}

async function main() {
  // ── task 2: joining a party mid-game puts you in the host's game ─────────────────────────
  await check('join a party whose game is live: the joiner gets a token for THAT match', async () => {
    const m = liveParty([])
    const before = assignments.forBox(BOX(), { v: 2 })
    const lease0 = before.assignments.find((x) => x.match_id === m)
    sent.length = 0
    const j = parties.join(B, parties.forPlayer(A).id)
    truthy(j.ok, j.error)
    truthy(j.game && j.game.joined, 'join says they are in the game')
    const info = parties.launchInfo(B)
    eq(info.match_id, m, 'the joiner follows the leader\'s match')
    const c = tokens.check(info.token, { matchId: m, steamid: B })
    truthy(c.ok, `the token verifies for (B, match): ${c.reason}`)
    eq(seats.phaseOf(parties.forPlayer(B), info, B), 'in-game', 'the launcher follows it (in-game)')
    truthy(sent.some((s) => s[0] === A && s[1] === 'party_updated' && s[2].notice && s[2].notice.kind === 'joined_game'), 'the party hears joined_game')

    const after = assignments.forBox(BOX(), { v: 2 })
    const lease1 = after.assignments.find((x) => x.match_id === m)
    eq(lease1.nonce, lease0.nonce, 'the lease nonce is unchanged (the box does not reboot it)')
    for (const k of ['match_id', 'map', 'fs_game', 'mode', 'vip', 'kind', 'agent', 'map_version'])
      eq(JSON.stringify(lease1[k]), JSON.stringify(lease0[k]), `lease field ${k}`)
    eq(JSON.stringify(lease1.settings), JSON.stringify(lease0.settings), 'settings')
    eq(lease1.players.length, 2, 'players now 2')
    truthy(lease1.whitelist.includes(B), 'B is on the whitelist')
    truthy(lease1.tokens[B], 'the box sees B\'s token')
    truthy(after.nonce !== before.nonce, 'the list nonce moved, so the box re-reads the players')
  })

  await check('joining again (already in the game) mints nothing new', async () => {
    const m = parties.forPlayer(A).match_id
    const t0 = JSON.parse(row(m).tokens_json)[B]
    const r = assignments.addPlayer(m, { steamid: B })
    truthy(r.ok && r.already, 'already in')
    eq(JSON.parse(row(m).tokens_json)[B], t0, 'same token')
  })

  await check('an expired joiner token (a long map download) is replaced on the poll; a live one is not', async () => {
    const m = parties.forPlayer(A).match_id
    const a = row(m)
    const tok = JSON.parse(a.tokens_json)
    tok[B] = tokens.issue({ steamid: B, matchId: m, name: 'bravo_two', now: Date.now() - 10 * 60_000 })
    db.prepare('UPDATE assignments SET tokens_json=? WHERE id=?').run(JSON.stringify(tok), a.id)
    const t1 = parties.launchInfo(B).token
    truthy(t1 !== tok[B], 'a new token')
    truthy(tokens.check(t1, { matchId: m, steamid: B }).ok, 'and it is in date')
    eq(parties.launchInfo(B).token, t1, 'an in-date token is kept')
  })

  await check('a fifth player is refused politely and STAYS in the party', async () => {
    const m = liveParty([B, C, D])
    eq(JSON.parse(row(m).players_json).length, 4, 'the game has 4')
    // D steps out of the party; the game still names D (they are playing).
    parties.leave(D)
    const j = parties.join(E, parties.forPlayer(A).id)
    truthy(j.ok, 'E is in the party')
    eq(j.game && j.game.joined, false, 'not in the game')
    eq(j.game.error, assignments.GAME_FULL, 'says why')
    truthy(parties.forPlayer(E) && parties.forPlayer(E).id === parties.forPlayer(A).id, 'E is still in the party')
    eq(JSON.parse(row(m).players_json).length, 4, 'the game still has 4')
    eq(parties.launchInfo(E).token, null, 'no token for E')
    parties.leave(E)
  })

  await check('addPlayer refuses a game that is not running', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.cancel(m, 'test')
    const r = assignments.addPlayer(m, { steamid: E })
    eq(r.ok, false); eq(r.error, 'that game is not running')
  })

  // ── task 3: changing map while a game runs switches the party's server ──────────────────
  const pid = () => parties.forPlayer(A).id
  const say = (sid, state) => parties.reportProgress(sid, pid(), { state, bytes: 1, total: 2 })

  await check('switchMap while live: the switch is PENDING and the game goes on', async () => {
    const m = liveParty([B, C])
    eq(parties.switchMap(B, 'nazi_zombie_carry2').ok, false, 'a member cannot switch')
    const r = parties.switchMap(A, 'nazi_zombie_carry2')
    truthy(r.ok, r.error)
    eq(r.pending, true, 'pending')
    eq(stateOf(m), 'live', 'the old game is still live')
    const p = parties.forPlayer(A)
    eq(p.pending_map.key, 'nazi_zombie_carry2', 'pending_map in the party')
    eq(p.map.key, 'nazi_zombie_carry', 'the party still shows the map being played')
    eq(p.pending_map.waiting.length, 3, 'waiting for three launchers to say')
  })

  await check('a member still downloading holds it; everybody installed switches everybody', async () => {
    const old = parties.forPlayer(A).match_id
    say(A, 'installed'); say(B, 'installed'); say(C, 'downloading')
    eq(parties.forPlayer(A).match_id, old, 'no switch while C downloads')
    eq(parties.forPlayer(A).pending_map.waiting.map((w) => w.state).join(), 'downloading', 'waiting names C downloading')
    say(C, 'installed')
    const p = parties.forPlayer(A)
    truthy(p.match_id && p.match_id !== old, 'a new match')
    eq(p.map.key, 'nazi_zombie_carry2', 'the party is on the new map')
    eq(p.pending_map, null, 'nothing pending')
    eq(p.leader, A, 'same leader'); eq(p.members.length, 3, 'same members')
    eq(stateOf(old), 'superseded', 'the old lease is superseded (lease rule 1)')
    eq(row(p.match_id).switched_from, old, 'the new lease says switched_from the old one')
    eq(parties.launchInfo(B).switched_from, old, 'and the launcher sees it')
    eq(JSON.parse(row(p.match_id).players_json).length, 3, 'all three in the new game')
    const onBox = assignments.forBox(BOX(), { v: 2 }).assignments.map((x) => x.match_id)
    truthy(onBox.includes(p.match_id) && !onBox.includes(old), 'the box is shown the new lease and not the old')
  })

  await check('Switch now switches while somebody is still downloading', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.ack(BOX(), 'live', m)
    truthy(parties.switchMap(A, 'nazi_zombie_carry').ok)
    say(B, 'downloading')
    eq(parties.forPlayer(A).match_id, m, 'held by B')
    eq(parties.switchNow(B).ok, false, 'a member cannot force it')
    const r = parties.switchNow(A)
    truthy(r.ok && r.switched, r.error)
    truthy(parties.forPlayer(A).match_id !== m, 'switched')
    eq(row(parties.forPlayer(A).match_id).switched_from, m)
  })

  await check('Cancel drops the pending switch; the game goes on', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.ack(BOX(), 'live', m)
    truthy(parties.switchMap(A, 'nazi_zombie_carry2').ok)
    truthy(parties.cancelSwitch(A).ok)
    eq(parties.forPlayer(A).pending_map, null)
    say(A, 'installed'); say(B, 'installed'); say(C, 'installed')
    eq(parties.forPlayer(A).match_id, m, 'no switch after cancel')
    eq(stateOf(m), 'live')
  })

  await check('silence is not a refusal: after the silence window, launchers that said nothing do not hold it', async () => {
    const m = parties.forPlayer(A).match_id
    truthy(parties.switchMap(A, 'nazi_zombie_carry2').ok)
    eq(parties.maybeSwitch(pid()).switched, false, 'inside the window: waits')
    db.prepare('UPDATE parties SET pending_since=? WHERE id=?').run(now() - parties.SWITCH_SILENCE_MS - 1, pid())
    eq(parties.maybeSwitch(pid()).switched, true, 'after it: switches')
    truthy(parties.forPlayer(A).match_id !== m)
  })

  await check('a stock map needs no download: the switch is immediate', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.ack(BOX(), 'live', m)
    const r = parties.switchMap(A, 'nazi_zombie_prototype')
    truthy(r.ok, r.error)
    eq(r.pending, false, 'not pending')
    eq(row(parties.forPlayer(A).match_id).switched_from, m)
  })

  await check('switchMap with no game running is an ordinary map change', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.cancel(m, 'test')
    const r = parties.switchMap(A, 'nazi_zombie_carry')
    truthy(r.ok, r.error)
    eq(parties.forPlayer(A).map.key, 'nazi_zombie_carry')
    eq(parties.forPlayer(A).pending_map, null)
  })

  // ── task 4: a party keeps its members, leader and settings through everything ────────────
  // The party as the people in it would describe it: who, who leads, and what they picked.
  const shape = () => {
    const p = parties.forPlayer(A)
    if (!p) return 'NO PARTY'
    return JSON.stringify({ id: p.id, leader: p.leader, members: p.members.map((m) => m.steam_id).sort(), mode: p.mode, visibility: p.visibility, map: p.map && p.map.key, settings: p.settings })
  }
  const result = (m, players) => results.ingest({ box: 'carry-box', summary: {
    match_id: m, mode: 'custom', map: 'nazi_zombie_carry', rounds: 3, finish: null,
    players: players.map((sid, i) => ({ slot: i, steamid: sid, name: 'p' + i, score: 10, stats: { kills: 1, downs: 1 } })),
    player_count: players.length, solo: players.length === 1, duration_ms: 60000, flags: [], records_eligible: false, xp_multiplier: 0.25,
    started_at: new Date(Date.now() - 60000).toISOString(), ended_at: new Date().toISOString(), fingerprint: 'fp' + m,
  } })
  const fresh3 = () => {
    const m = liveParty([B, C])
    parties.setSettings(A, { dvars: { player_sustainAmmo: '1' } })
    return m
  }

  await check('through a game over: back to forming, same people, same picks', async () => {
    const m = fresh3()
    const before = shape()
    const r = result(m, [A, B, C])
    truthy(r.ok !== false, r.error)
    eq(shape(), before)
    eq(parties.forPlayer(A).state, 'forming')
  })

  await check('through a new launch (Play again)', async () => {
    const before = shape()
    online(); parties.startReadyCheck(A, { force: true })
    const r = parties.launch(A, { force: true })
    truthy(r.ok, r.error)
    eq(shape(), before)
  })

  await check('through the × (close the server)', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.ack(BOX(), 'live', m)
    const before = shape()
    truthy(seats.end(A, m).ok)
    eq(shape(), before)
    eq(parties.forPlayer(A).state, 'forming')
  })

  await check('through an in-game Quit (a member, co-op): the quitter STAYS in the party and is not relaunched', async () => {
    const m = fresh3()
    const before = shape()
    const q = seats.quit(B, m)
    truthy(q.ok)
    eq(shape(), before, 'the party')
    eq(stateOf(m), 'live', 'the game goes on for the others')
    eq(seats.phaseOf(parties.forPlayer(B), parties.launchInfo(B), B), 'selected', 'B is not followed back in')
  })

  await check('through an in-game Quit (the last player in the game): the server goes, the party stays', async () => {
    for (const s of [B, C]) parties.leave(s)
    const m = liveParty([])
    const before = shape()
    const q = seats.quit(A, m)
    truthy(q.ok && q.cancelled, JSON.stringify(q))
    eq(shape(), before, 'the party of one')
    eq(parties.forPlayer(A).state, 'forming')
    eq(seats.phaseOf(parties.forPlayer(A), parties.launchInfo(A), A), 'selected', 'nothing to follow')
  })

  await check('through a map switch, and the OLD game\'s late result does not knock the party out of the new one', async () => {
    const old = fresh3()
    truthy(parties.switchNow(A).ok === false, 'nothing pending yet')
    truthy(parties.switchMap(A, 'nazi_zombie_prototype').ok)
    const now1 = parties.forPlayer(A).match_id
    truthy(now1 && now1 !== old, 'switched')
    const before = shape()
    // The box retires the superseded game and posts its result (host: instance_retired).
    result(old, [A, B, C])
    eq(parties.forPlayer(A).match_id, now1, 'the party still points at its NEW game')
    eq(parties.forPlayer(A).state, 'launching', 'and is still launching it')
    eq(shape(), before)
  })

  await check('a ghost-reaped OLD lease does not reset a party that is in a newer game', async () => {
    const cur = parties.forPlayer(A).match_id
    // An older live lease of the same party that the box no longer runs (a race the reaper sees).
    db.prepare(`INSERT INTO assignments (box_id, match_id, party_id, map_key, mode, settings_json, players_json, tokens_json, vip, kind, nonce, state, issued_at)
                VALUES (?, 'm_ghost_old', ?, 'nazi_zombie_carry', 'custom', '{}', '[]', '{}', 0, 'game', 'n', 'live', ?)`).run(BOX().id, pid(), now() - 3600_000)
    boxes.recordStatus(BOX(), { state: 'live', protocol: 2, max_instances: 4, instances: [{ id: 'inst-09', match_id: cur, port: 28960 }] })
    eq(stateOf('m_ghost_old'), 'ended', 'the ghost was reaped')
    eq(parties.forPlayer(A).match_id, cur, 'the party keeps its current game')
  })

  await check('create() with a party already there applies the leader\'s staged map instead of ignoring it', async () => {
    const m = parties.forPlayer(A).match_id
    assignments.cancel(m, 'test')
    const before = parties.forPlayer(A)
    const p = parties.create(A, { mapKey: 'nazi_zombie_carry2', mode: 'custom' })
    eq(p.id, before.id, 'the same party')
    eq(p.map.key, 'nazi_zombie_carry2', 'with the map the rail asked for')
    eq(p.members.length, before.members.length, 'and its members')
    // A member's create never changes the leader's pick.
    const q = parties.create(B, { mapKey: 'nazi_zombie_carry' })
    eq(q.map.key, 'nazi_zombie_carry2', 'a member cannot change the map through create')
  })

  await check('through a site restart (a new process on the same database)', async () => {
    const before = shape()
    const js = `process.env.ZM_STEAM_AVATARS='off';const p=require(${JSON.stringify(path.join(__dirname, '..', 'server', 'lib', 'parties'))});const x=p.forPlayer(${JSON.stringify(A)});` +
      `console.log(JSON.stringify({id:x.id,leader:x.leader,members:x.members.map(m=>m.steam_id).sort(),mode:x.mode,visibility:x.visibility,map:x.map&&x.map.key,settings:x.settings}))`
    const got = execFileSync(process.execPath, ['-e', js], { env: process.env, encoding: 'utf8' }).trim().split('\n').pop()
    eq(got, before)
  })

  for (const [a, b] of out) console.log(a, b)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
