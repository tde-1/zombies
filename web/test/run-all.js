'use strict'

// In-process checks for the site. No server, no network: every test drives the libraries
// directly against a throwaway database.
//
//   node test/run-all.js
//
// The one that matters most is the TOKEN CONTRACT test. The site signs invite tokens and
// the game box verifies them with `infra/host-agent/lib/tokens.js`. If those two ever
// disagree about the payload shape, the canonical-JSON ordering or the base64url encoding,
// every join fails with `bad_signature` and nothing on the site looks wrong. So the test
// imports the HOST AGENT'S OWN checker and verifies a token this site issued with it.

const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-test-'))
process.env.ZM_DATA_DIR = TMP
process.env.ZM_KEY_DIR = path.join(TMP, 'keys')
process.env.ZM_DB_PATH = path.join(TMP, 'test.db')
process.env.ZM_STEAM_AVATARS = 'off'

let pass = 0
let fail = 0
const results = []

function check(name, fn) {
  try {
    const r = fn()
    if (r instanceof Promise) throw new Error('use checkAsync')
    pass++; results.push(['ok  ', name])
  } catch (e) {
    fail++; results.push(['FAIL', `${name} — ${e.message}`])
  }
}

async function checkAsync(name, fn) {
  try { await fn(); pass++; results.push(['ok  ', name]) } catch (e) { fail++; results.push(['FAIL', `${name} — ${e.message}`]) }
}

const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }

const { db, now } = require('../server/db/database')
const users = require('../server/lib/users')
const badges = require('../server/lib/badges')
const maps = require('../server/lib/maps')
const records = require('../server/lib/records')
const mapRecords = require('../server/lib/mapRecords')
const results_ = require('../server/lib/results')
const xp = require('../server/lib/xp')
const boxes = require('../server/lib/boxes')
const assignments = require('../server/lib/assignments')
const parties = require('../server/lib/parties')
const partyProgress = require('../server/lib/partyProgress')
const bans = require('../server/lib/bans')
const chat = require('../server/lib/chatNetwork')
const chatSystem = require('../server/lib/chatSystem')
const discord = require('../server/lib/discord')
const live = require('../server/lib/live')
const replays = require('../server/lib/replays')
const tokens = require('../server/lib/tokens')
const achievements = require('../server/lib/achievements')
const collections = require('../server/lib/collections')
const { seedCollections } = require('../server/db/database')
const { canonical } = require('../server/lib/util')

// ---- fixtures -------------------------------------------------------------------
function seedMinimal() {
  // `on_server` is a MEASURED list of maps we have booted headless to game over
  // (server/lib/maps.js :: SERVER_PROVEN), not a function of `health` — so the fixture map
  // has to join it, or every lease in this suite is refused by the thing that is supposed
  // to keep un-booted maps off the box.
  maps.SERVER_PROVEN.add('nazi_zombie_test')
  db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, main_finish, round_n, has_ee, added_at)
              VALUES ('nazi_zombie_test','test','Test Map','tester','custom','verified','easter_egg',20,1,?)`).run(now())
  const m = db.prepare("SELECT * FROM maps WHERE key='nazi_zombie_test'").get()
  db.prepare("INSERT INTO map_versions (map_id, version, latest, health, added_at) VALUES (?, '1.0', 1, 'verified', ?)").run(m.id, now())
  badges.create({ slug: 'map-nazi_zombie_test', name: 'Test Map', kind: 'map', rule: 'map-nazi_zombie_test', mapKey: 'nazi_zombie_test' })
  badges.create({ slug: 'record-nazi_zombie_test', name: 'Test Map record', kind: 'record', rule: 'm:nazi_zombie_test', mapKey: 'nazi_zombie_test' })
  badges.create({ slug: 'round-30', name: 'Round 30', kind: 'achievement', rule: 'round-30', family: 'rounds', art: 'x.png' })
  for (const [sid, n] of [['76561198000000001', 'alpha'], ['76561198000000002', 'beta'], ['76561198000000003', 'gamma'], ['76561198000000004', 'delta']]) {
    users.ensure(sid, { username: n })
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(sid)
  }
  boxes.create({ name: 'test-box', matchKey: 'test-secret' })
}

const summary = (o = {}) => ({
  match_id: o.match_id || 'm_' + Math.random().toString(16).slice(2, 10),
  mode: o.mode || 'verified',
  map: o.map || 'nazi_zombie_test',
  rounds: o.rounds != null ? o.rounds : 25,
  finish: o.finish === null ? null : (o.finish || { kind: 'easter_egg', label: 'Egg' }),
  players: (o.players || ['76561198000000001']).map((sid, i) => ({
    slot: i, steamid: sid, name: 'p' + i, score: 1000, late: !!(o.late && i === o.late - 1),
    stats: { kills: 100, headshots: 10, downs: 0, revives: 0, points_earned: 1000, points_spent: 500, time_alive_ms: o.alive != null ? o.alive : 3600000, rounds_played: 25 },
  })),
  player_count: (o.players || ['76561198000000001']).length,
  solo: (o.players || ['x']).length === 1,
  duration_ms: o.duration_ms != null ? o.duration_ms : 3600000,
  duration_rta_ms: 3660000,
  paused_ms: 0,
  flags: o.flags || [],
  records_eligible: o.records_eligible !== false,
  xp_multiplier: o.mode === 'custom' ? 0.25 : 1,
  started_at: new Date(Date.now() - 3600000).toISOString(),
  ended_at: new Date().toISOString(),
  fingerprint: 'fp' + Math.random().toString(16).slice(2, 8),
  dvars: o.dvars || {},
})

// ---- run ----------------------------------------------------------------------
async function main() {
  seedMinimal()

  // ── the stock four have no payload, and that is not a failure ────────────
  check('a stock map answers "nothing to download", not "no files"', () => {
    const mapfiles = require('../server/lib/mapfiles')
    db.prepare(`INSERT INTO maps (key, slug, title, author, source, health, round_n, added_at)
                VALUES ('nazi_zombie_prototype','nacht','Nacht der Untoten','Treyarch','stock','verified',20,?)`).run(now())
    const stock = mapfiles.forMap('nazi_zombie_prototype')
    eq(stock.source, 'stock', 'source')
    eq(stock.stock, true, 'stock')
    eq(stock.needs_download, false, 'needs_download')
    // `install_known` is what the launcher used to read as "the site has no files for
    // this map yet" and refuse to launch. For a stock map the install IS known: it is
    // already installed, by Treyarch.
    eq(stock.install_known, true, 'install_known')
    eq(stock.files.length, 0, 'files')
    // A CUSTOM map we cannot serve must still say so, or a real missing download would
    // be waved through and the engine handed a map that is not there.
    const custom = mapfiles.forMap('nazi_zombie_no_such_map_' + Date.now())
    eq(custom.install_known, false, 'a custom map with no files is still unknown')
    eq(custom.needs_download, true, 'a custom map still needs downloading')
    eq(custom.stock, false, 'a custom map is not stock')
    db.prepare("DELETE FROM maps WHERE key='nazi_zombie_prototype'").run()
  })

  // ── the token contract with the game box ──────────────────────────────────
  await checkAsync('an invite token this site issues verifies with the HOST AGENT’s own checker', async () => {
    const hostTokens = await import('../../infra/host-agent/lib/tokens.js')
    const hostKeys = await import('../../infra/host-agent/lib/keys.js')
    const siteKeys = require('../server/lib/siteKeys')
    const t = tokens.issue({ steamid: '76561198000000001', matchId: 'm_abc', name: 'alpha' })
    const pub = hostKeys.publicFromRaw(siteKeys.site().pub)
    const r = hostTokens.check(pub, t, { matchId: 'm_abc', steamid: '76561198000000001' })
    truthy(r.ok, `host agent refused our token: ${r.reason}`)
  })

  await checkAsync('the box refuses a token for a different match and a different SteamID', async () => {
    const hostTokens = await import('../../infra/host-agent/lib/tokens.js')
    const hostKeys = await import('../../infra/host-agent/lib/keys.js')
    const siteKeys = require('../server/lib/siteKeys')
    const pub = hostKeys.publicFromRaw(siteKeys.site().pub)
    const t = tokens.issue({ steamid: '76561198000000001', matchId: 'm_abc' })
    eq(hostTokens.check(pub, t, { matchId: 'm_other' }).reason, 'wrong_match')
    eq(hostTokens.check(pub, t, { steamid: '76561198000000009' }).reason, 'wrong_steamid')
  })

  await checkAsync('our canonical() is byte-identical to the host agent’s', async () => {
    const hostUtil = await import('../../infra/host-agent/lib/util.js')
    const v = { z: 1, a: [3, { c: null, b: 'x' }], m: undefined, n: 'q' }
    eq(canonical(v), hostUtil.canonical(v))
  })

  // ── the pull protocol ──────────────────────────────────────────────────────
  check('a box authenticates on x-match-secret and nothing else', () => {
    truthy(boxes.authenticate({ headers: { 'x-match-secret': 'test-secret' } }), 'good secret')
    eq(boxes.authenticate({ headers: { 'x-match-secret': 'wrong' } }), null, 'bad secret')
    eq(boxes.authenticate({ headers: {} }), null, 'no secret')
  })

  check('an idle box gets a first-class idle answer, not an empty one', () => {
    const b = boxes.byName('test-box')
    eq(assignments.forBox(b).status, 'idle')
    eq(assignments.forBox(b).nonce, 'idle')
  })

  check('a lease is picked up with a stable nonce and one token per whitelisted player', () => {
    const b = boxes.byName('test-box')
    const r = assignments.lease({ box: b, mapKey: 'nazi_zombie_test', players: [{ steamid: '76561198000000001', name: 'alpha' }] })
    truthy(r.ok, r.error)
    const a = assignments.forBox(b)
    eq(a.status, 'leased')
    eq(a.map, 'nazi_zombie_test')
    eq(a.nonce, r.nonce, 'nonce')
    truthy(a.tokens['76561198000000001'], 'token for the whitelisted player')
    truthy(a.manifest !== undefined, 'the manifest travels with the lease')
  })

  // ── several games per box (2026-09-23, lib/assignments.js "SEVERAL GAMES PER BOX") ──
  // The old rule was "leasing again supersedes rather than stacking" — every live lease on
  // the box, whoever's it was. That is what kicked B out of his own game. Fake IDs only.
  const liveCount = (b) => db.prepare("SELECT COUNT(*) c FROM assignments WHERE box_id=? AND state IN ('leased','ready','live')").get(b.id).c
  const stateOf = (m) => (db.prepare('SELECT state FROM assignments WHERE match_id=?').get(m) || {}).state
  const P = (...ids) => ids.map((steamid) => ({ steamid }))

  check('an OLD-protocol box holds one game: a different player is refused, nobody is kicked', () => {
    const b = boxes.byName('test-box')
    const first = db.prepare("SELECT match_id FROM assignments WHERE box_id=? AND state='leased'").get(b.id).match_id
    eq(assignments.capacity(b).max, 1, 'no ?v=2 poll yet')
    const r = assignments.lease({ box: b, mapKey: 'nazi_zombie_test', players: P('76561198000000002') })
    eq(r.ok, false); eq(r.error, 'No free server right now'); eq(r.full, true)
    eq(stateOf(first), 'leased', 'the first game is untouched')
    eq(liveCount(b), 1)
  })

  check('the same player pressing Play again replaces their OWN game', () => {
    const b = boxes.byName('test-box')
    const first = db.prepare("SELECT match_id FROM assignments WHERE box_id=? AND state='leased'").get(b.id).match_id
    const r = assignments.lease({ box: b, mapKey: 'nazi_zombie_test', players: P('76561198000000001') })
    truthy(r.ok, r.error)
    eq(stateOf(first), 'superseded'); eq(stateOf(r.match_id), 'leased'); eq(liveCount(b), 1)
    // Leave test-box empty for the checks further down, which lease on it themselves.
    assignments.cancel(r.match_id, 'test')
  })

  boxes.create({ name: 'multi-box', matchKey: 'multi-secret', maxInstances: 3 })
  const MB = () => boxes.byName('multi-box')
  const lm = {}
  check('a v=2 box of three: capacity 3, one slot kept for agents', () => {
    assignments.notePoll(MB(), 2)
    const c = assignments.capacity(MB())
    eq(c.max, 3); eq(c.reserve, 1); eq(c.protocol, 2)
  })

  check('two agent leases (…0001, …0002) BOTH stay live; the first is not superseded', () => {
    const a = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561198000000001'), agent: true })
    const b = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561198000000002'), agent: true })
    truthy(a.ok && b.ok, a.error || b.error)
    lm.a = a.match_id; lm.b = b.match_id
    eq(stateOf(a.match_id), 'leased'); eq(stateOf(b.match_id), 'leased'); eq(liveCount(MB()), 2)
  })

  check('the v=2 poll lists every live lease with its own nonce; the old shape is the newest alone', () => {
    const v2 = assignments.forBox(MB(), { v: 2 })
    eq(v2.v, 2); eq(v2.status, 'leased')
    eq(v2.assignments.map((x) => x.match_id).join(), `${lm.a},${lm.b}`)
    truthy(v2.assignments[0].nonce !== v2.assignments[1].nonce, 'two nonces')
    truthy(v2.assignments[0].tokens['76561198000000001'], 'each lease carries its tokens')
    eq(assignments.forBox(MB()).match_id, lm.b, 'v1 shape = the newest')
    eq(assignments.forBox(boxes.byName('test-box'), { v: 2 }).nonce, 'idle')
  })

  check('a third agent lease is refused: it would take the last slot a player is owed', () => {
    const c = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561198000000003'), agent: true })
    eq(c.ok, false); eq(c.error, 'No free server right now'); eq(c.why, 'the last free slot is kept for players')
    eq(liveCount(MB()), 2)
  })

  check('a real player takes the free slot; the next one makes the OLDEST agent yield', () => {
    const r1 = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561190000000011') })
    truthy(r1.ok, r1.error); lm.r1 = r1.match_id
    eq(liveCount(MB()), 3)
    const r2 = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561190000000012') })
    truthy(r2.ok, r2.error); lm.r2 = r2.match_id
    eq(stateOf(lm.a), 'superseded', 'the oldest agent lease yields')
    eq(stateOf(lm.b), 'leased', 'the other agent lease is untouched')
    eq(stateOf(lm.r1), 'leased', 'the first real game is untouched')
    eq(liveCount(MB()), 3)
  })

  check('real players never go past max - reserve, and a full box supersedes nobody', () => {
    const r3 = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561190000000013') })
    eq(r3.ok, false); eq(r3.error, 'No free server right now')
    for (const m of [lm.b, lm.r1, lm.r2]) eq(stateOf(m), 'leased', m)
  })

  check('re-pressing Play replaces only that player\'s game, on a full box too', () => {
    const again = assignments.lease({ box: MB(), mapKey: 'nazi_zombie_test', players: P('76561190000000011') })
    truthy(again.ok, again.error)
    eq(stateOf(lm.r1), 'superseded'); eq(stateOf(again.match_id), 'leased')
    for (const m of [lm.b, lm.r2]) eq(stateOf(m), 'leased', m)
    lm.r1 = again.match_id
  })

  check('cancel is by match id: one game ends, the others do not', () => {
    truthy(assignments.cancel(lm.r2, 'test').ok)
    eq(stateOf(lm.r2), 'cancelled')
    for (const m of [lm.b, lm.r1]) eq(stateOf(m), 'leased', m)
    eq(assignments.cancel(lm.r2, 'test').already, 'cancelled', 'a second cancel changes nothing')
  })

  check('a late "ready" never takes a live game back, and an ended lease stays ended', () => {
    assignments.ack(MB(), 'live', lm.r1)
    assignments.ack(MB(), 'ready', lm.r1)
    eq(stateOf(lm.r1), 'live')
    assignments.ack(MB(), 'live', lm.r2)
    eq(stateOf(lm.r2), 'cancelled')
  })

  // ── the launcher's "give the box back" (2026-09-23 00:50, m_6d80aa20) ─────────────
  // Root cause of B's game going idle mid-round: not a timer — his launcher's failed rejoin
  // called POST /api/launcher/cancel, which cancelled the party's current (live) match.
  check('a launcher release never ends a LIVE game', () => {
    const r = assignments.release(lm.r1, { by: '76561190000000011' })
    eq(r.ok, false); eq(r.live, true)
    eq(stateOf(lm.r1), 'live', 'still live')
  })
  check('a launcher release naming another match is a no-op', () => {
    const r = assignments.release(lm.b, { by: 'x', named: 'm_somethingelse' })
    eq(r.noop, true); eq(stateOf(lm.b), 'leased')
  })
  check('a launcher release of a lease nobody got into still gives the box back', () => {
    truthy(assignments.release(lm.b, { by: 'x', named: lm.b }).ok)
    eq(stateOf(lm.b), 'cancelled')
    assignments.cancel(lm.r1, 'test')
    eq(liveCount(MB()), 0)
  })

  check('a per-game status post keeps the heartbeat\'s instance list and protocol', () => {
    boxes.recordStatus(MB(), { state: 'live', protocol: 2, max_instances: 3, instances: [{ id: 'inst-01', match_id: 'm_x', port: 28960 }] })
    boxes.recordStatus(MB(), { state: 'ready', match_id: 'm_x', port: 28960 })
    const st = JSON.parse(boxes.byName('multi-box').last_status_json)
    eq(st.instances.length, 1); eq(st.protocol, 2); eq(st.state, 'ready')
    // recordStatus stamps last_poll; the launch checks below need no box online.
    db.prepare('UPDATE boxes SET last_poll=NULL WHERE name=?').run('multi-box')
  })

  // ── quit vs crash, and the launcher never relaunching into a game (lib/seats.js) ──────
  // The launcher's watcher (launcher main.js onPlay) launches whenever the poll's phase is
  // one of these and no launch of its own is running. Modelled here exactly, so the test
  // fails the way B's launcher did: a relaunch every ~25 s after a quit, a crash, or a
  // launch flow that ended while the game was still up.
  {
    const seats = require('../server/lib/seats')
    const FOLLOW = ['reserving', 'loading', 'ready', 'in-game']
    const watcher = (sid) => {
      const w = { flow: true, launches: 0, phases: [] }
      w.poll = () => {
        const party = parties.forPlayer(sid)
        const launch = parties.launchInfo(sid)
        const ph = seats.phaseOf(party, launch, sid)
        w.phases.push(ph)
        if (!w.flow && FOLLOW.includes(ph) && launch) { w.launches++; w.flow = true }
        return ph
      }
      return w
    }
    const frame = (players) => ({ phase: 'live', players: players.map(([steamid, connected], slot) => ({ slot, steamid, connected })) })
    const startSolo = (sid) => {
      db.prepare('UPDATE boxes SET last_poll=? WHERE name=?').run(now(), 'multi-box')
      parties.leave(sid)
      parties.create(sid, { mode: 'custom', mapKey: 'nazi_zombie_test', visibility: 'private' })
      parties.startReadyCheck(sid, { force: true })
      parties.setReady(sid, true)
      const r = parties.launch(sid, {})
      db.prepare('UPDATE boxes SET last_poll=NULL WHERE name=?').run('multi-box')
      return r
    }
    const S = '76561198000000001'

    check('a party polled 20 times after launch never asks for a second launch', () => {
      const r = startSolo(S)
      truthy(r.ok, r.error)
      const w = watcher(S)
      for (let i = 0; i < 3; i++) w.poll()                       // reserving, flow running
      assignments.ack(MB(), 'live', r.match_id)
      seats.observe(r.match_id, frame([[S, true]]))
      // The launch flow ENDS while the game is still up (what 0.2.x did when it could not
      // confirm the join): nothing of the launcher's own is running any more.
      w.flow = false
      for (let i = 0; i < 20; i++) eq(w.poll(), 'playing', `poll ${i}`)
      eq(w.launches, 0, 'second launches')
    })

    check('a crash (no quit call) is resumable: no relaunch, Resume offered, lease kept', () => {
      const party = parties.forPlayer(S)
      const m = party.match_id
      const w = watcher(S); w.flow = false
      seats.observe(m, frame([[S, false]]))                       // the box: client gone
      for (let i = 0; i < 20; i++) eq(w.poll(), 'resumable', `poll ${i}`)
      eq(w.launches, 0, 'relaunches after a crash')
      eq(stateOf(m), 'live', 'the lease stays up')
      const info = seats.resumeInfo(parties.launchInfo(S), S)
      truthy(info && info.until - info.left_at === seats.RESUME_MS, 'ten minutes to resume')
    })

    check('Resume puts the player back through the normal follow path, once, with a fresh token', () => {
      const m = parties.forPlayer(S).match_id
      const before = parties.launchInfo(S).token
      truthy(seats.resume(S, m).ok)
      truthy(parties.launchInfo(S).token !== before, 'a new invite token')
      const w = watcher(S); w.flow = false
      eq(w.poll(), 'in-game'); eq(w.launches, 1, 'the resume launch')
      seats.observe(m, frame([[S, true]]))                        // they are back
      for (let i = 0; i < 20; i++) w.poll()
      eq(w.launches, 1, 'and only that one')
    })

    check('quitting on purpose (solo) cancels the server and dissolves the party: nothing to follow', () => {
      const m = parties.forPlayer(S).match_id
      const out = seats.quit(S, m)
      truthy(out.ok && out.cancelled && out.left, JSON.stringify(out))
      eq(stateOf(m), 'cancelled')
      eq(parties.forPlayer(S), null, 'no party')
      const w = watcher(S); w.flow = false
      for (let i = 0; i < 20; i++) eq(w.poll(), 'idle')
      eq(w.launches, 0)
    })

    check('quitting from a party leaves it; the game goes on for the others', () => {
      const T = '76561198000000002'
      const r = startSolo(S)
      truthy(r.ok, r.error)
      // T is in the game with S (a two-player lease on the same party).
      const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(r.match_id)
      db.prepare('UPDATE assignments SET players_json=? WHERE id=?').run(JSON.stringify([...JSON.parse(a.players_json), { steamid: T, name: 'P2' }]), a.id)
      db.prepare('INSERT INTO party_members (party_id, steam_id, ready, joined_at) VALUES (?,?,1,?)').run(a.party_id, T, now())
      const out = seats.quit(S, r.match_id)
      eq(out.cancelled, false); eq(out.left, true)
      eq(stateOf(r.match_id), 'leased', 'still up for T')
      eq(parties.forPlayer(S), null)
      truthy(parties.forPlayer(T), 'T still has the party')
      assignments.cancel(r.match_id, 'test'); parties.leave(T)
    })

    check('ten minutes with everybody gone and nobody resuming cancels the lease', () => {
      const r = startSolo(S)
      seats.observe(r.match_id, frame([[S, true]]))
      seats.observe(r.match_id, frame([[S, false]]))
      eq(seats.sweep().length, 0, 'not yet')
      // Wind the clock: the seat left eleven minutes ago.
      const real = Date.now
      Date.now = () => real() + 11 * 60_000
      try { eq(seats.sweep().includes(r.match_id), true) } finally { Date.now = real }
      eq(stateOf(r.match_id), 'cancelled')
      parties.leave(S)
    })
  }

  // ── the key pin ────────────────────────────────────────────────────────────
  check('the first replay key a box presents is pinned', () => {
    const b = boxes.byName('test-box')
    const r = boxes.offerKey(b, 'AAAApub', 'key0000000000001')
    truthy(r.pinned, 'pinned')
    truthy(r.first, 'first')
    truthy(boxes.keyMatchesPin('test-box', 'key0000000000001'), 'matches')
  })

  check('a DIFFERENT key is parked, not accepted — integrity is not authorship', () => {
    const b = boxes.byName('test-box')
    const r = boxes.offerKey(b, 'BBBBpub', 'key0000000000002')
    eq(r.pinned, false)
    eq(r.changed, true)
    eq(r.pinned_key_id, 'key0000000000001')
    eq(boxes.keyMatchesPin('test-box', 'key0000000000002'), false, 'the new key must not match the pin')
    eq(boxes.byName('test-box').replay_key_id, 'key0000000000001', 'the pin did not move')
  })

  check('an admin can accept the change, and only then does it move', () => {
    const b = boxes.byName('test-box')
    boxes.acceptPendingKey(b.id, 'admin')
    eq(boxes.byName('test-box').replay_key_id, 'key0000000000002')
    truthy(boxes.keyMatchesPin('test-box', 'key0000000000002'))
  })

  // ── ingest ─────────────────────────────────────────────────────────────────
  check('a result becomes a game, players, progress and the map badge', () => {
    const s = summary({ match_id: 'm_ingest1' })
    const r = results_.ingest({ box: 'test-box', summary: s, replay: { file: 'x.enwr', size: 1, key_id: 'key0000000000002' } })
    truthy(r.ok, r.error)
    eq(r.awarded.length, 1, 'one map badge')
    const g = db.prepare('SELECT * FROM games WHERE match_id=?').get('m_ingest1')
    eq(g.rounds, 25)
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=?').get(g.id).c, 1)
    const p = db.prepare('SELECT * FROM map_progress WHERE steam_id=? AND map_key=?').get('76561198000000001', 'nazi_zombie_test')
    eq(p.beaten, 1); eq(p.ee, 1); eq(p.solo, 1)
    eq(db.prepare('SELECT key_pinned FROM replays WHERE match_id=?').get('m_ingest1').key_pinned, 1, 'the replay key matched the pin')
  })

  check('re-posting the same result does not mint a second badge or a second level', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM badge_awards').get().c
    const beforeXp = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000001').xp_total
    const s = summary({ match_id: 'm_ingest1' })
    const r = results_.ingest({ box: 'test-box', summary: s })
    truthy(r.repeat, 'marked as a repeat')
    eq(db.prepare('SELECT COUNT(*) c FROM badge_awards').get().c, before, 'badge count unchanged')
    eq(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000001').xp_total, beforeXp, 'xp unchanged')
  })

  check('a replay signed by a key that is NOT the pin is stored unpinned', () => {
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_unpinned' }), replay: { file: 'y.enwr', size: 1, key_id: 'deadbeefdeadbeef' } })
    eq(db.prepare('SELECT key_pinned FROM replays WHERE match_id=?').get('m_unpinned').key_pinned, 0)
  })

  check('a non-main finish ticks the shelf but does not mint the map badge', () => {
    // The test map's main finish is the Easter Egg, so a Round 20 finish is a tick only.
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_round', players: ['76561198000000003'], finish: { kind: 'round', label: 'Round 25' } }) })
    const b = db.prepare("SELECT id FROM badges WHERE slug='map-nazi_zombie_test'").get()
    eq(db.prepare('SELECT COUNT(*) c FROM badge_awards WHERE badge_id=? AND steam_id=?').get(b.id, '76561198000000003').c, 0, 'no badge')
    eq(db.prepare('SELECT beaten FROM map_progress WHERE steam_id=? AND map_key=?').get('76561198000000003', 'nazi_zombie_test').beaten, 1, 'still beaten on the shelf')
  })

  check('a late joiner earns nothing from that game', () => {
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_late', players: ['76561198000000002'], late: 1, flags: ['late_join'], records_eligible: false }) })
    const b = db.prepare("SELECT id FROM badges WHERE slug='map-nazi_zombie_test'").get()
    eq(db.prepare('SELECT COUNT(*) c FROM badge_awards WHERE badge_id=? AND steam_id=?').get(b.id, '76561198000000002').c, 0)
  })

  check('a player with no SteamID gets no row rather than a made-up one', () => {
    const s = summary({ match_id: 'm_nobody' })
    s.players.push({ slot: 1, steamid: null, name: 'bot', stats: {} })
    results_.ingest({ box: 'test-box', summary: s })
    const g = db.prepare('SELECT * FROM games WHERE match_id=?').get('m_nobody')
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=?').get(g.id).c, 1)
  })

  // ── records ────────────────────────────────────────────────────────────────
  check('a run posts to the round board for its player count and to the EE board', () => {
    const boards = records.forMap('nazi_zombie_test')
    const round = boards.find((b) => b.category === 'round')
    const solo = round.counts.find((c) => c.player_count === 1)
    truthy(solo.rows.length > 0, 'a solo round board row')
    const ee = boards.find((b) => b.category === 'ee_speedrun')
    truthy(ee.counts.find((c) => c.player_count === 1).rows.length > 0, 'an EE speedrun row')
  })

  check('solo and 2p never share a board', () => {
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_2p', players: ['76561198000000001', '76561198000000002'], rounds: 40 }) })
    const round = records.forMap('nazi_zombie_test').find((b) => b.category === 'round')
    const solo = round.counts.find((c) => c.player_count === 1).rows
    const two = round.counts.find((c) => c.player_count === 2).rows
    truthy(!solo.some((r) => r.round === 40), 'the 2p run is not on the solo board')
    truthy(two.some((r) => r.round === 40), 'the 2p run is on the 2p board')
  })

  check('a ZWR-profile run outside the rules still posts, marked', () => {
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_fov', players: ['76561198000000003'], rounds: 99, dvars: { cg_fov: 140 } }) })
    const zwr = db.prepare(`SELECT r.* FROM records r JOIN boards b ON b.id=r.board_id
                             WHERE b.profile='ZWR-WaW-2025-09' AND r.match_id='m_fov'`).all()
    truthy(zwr.length > 0, 'it is on the ZWR board')
    eq(zwr[0].profile_ok, 0, 'and marked as a mismatch')
    truthy(/140/.test(zwr[0].profile_note || ''), 'with the reason')
  })

  check('a game that is not records-eligible posts to no board at all', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM records').get().c
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_noel', rounds: 200, records_eligible: false }) })
    eq(db.prepare('SELECT COUNT(*) c FROM records').get().c, before)
  })

  check('the record badge is HELD: it moves to whoever holds the record', () => {
    mapRecords.sweep()
    const holders = mapRecords.holdersFor('nazi_zombie_test')
    truthy(holders.size > 0, 'somebody holds it')
    for (const sid of holders) truthy(mapRecords.holdsRecord(sid, 'nazi_zombie_test'), `${sid} wears it`)
    // Beat it and the badge moves.
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_beat', players: ['76561198000000002'], rounds: 500 }) })
    truthy(mapRecords.holdsRecord('76561198000000002', 'nazi_zombie_test'), 'the new holder wears it')
  })

  // ── xp ─────────────────────────────────────────────────────────────────────
  check('XP is active time, Verified full and Custom a quarter', () => {
    const before = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000003').xp_total
    results_.ingest({ box: 'test-box', summary: summary({ match_id: 'm_custom', mode: 'custom', players: ['76561198000000003'], alive: 3600000 }) })
    const after = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000003').xp_total
    eq(after - before, Math.round(60 * xp.XP_PER_MINUTE * 0.25), 'a custom hour is a quarter of a verified hour')
  })

  check('an AFK-kicked player earns nothing for that game', () => {
    const s = summary({ match_id: 'm_afk', players: ['76561198000000003'] })
    s.players[0].afk_kicked = true
    const before = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000003').xp_total
    results_.ingest({ box: 'test-box', summary: s })
    eq(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000003').xp_total, before)
  })

  check('time alive is capped at the game’s own length', () => {
    const s = summary({ match_id: 'm_liar', players: ['76561198000000002'], alive: 99 * 3600000, duration_ms: 600000 })
    const before = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000002').xp_total
    results_.ingest({ box: 'test-box', summary: s })
    const gained = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000002').xp_total - before
    eq(gained, 10 * xp.XP_PER_MINUTE, 'ten minutes, not ninety-nine hours')
  })

  check('65 levels per prestige and prestige is unlimited', () => {
    eq(xp.standing(0).level, 1)
    eq(xp.standing(0).prestige, 0)
    eq(xp.standing(xp.PRESTIGE_COST).prestige, 1)
    eq(xp.standing(xp.PRESTIGE_COST).level, 1)
    eq(xp.standing(xp.PRESTIGE_COST * 40).prestige, 40, 'nothing saturates')
    eq(xp.emblemFor(11).icon, 'missing', 'prestige 11 is the missing-texture icon')
    eq(xp.emblemFor(20).finish, 'silver')
    eq(xp.emblemFor(30).finish, 'gold')
  })

  // ── achievements ───────────────────────────────────────────────────────────
  check('the round-30 milestone is swept, and the sweep never revokes', () => {
    achievements.sweep()
    const b = db.prepare("SELECT id FROM badges WHERE slug='round-30'").get()
    const holders = db.prepare('SELECT COUNT(*) c FROM badge_awards WHERE badge_id=?').get(b.id).c
    truthy(holders > 0, 'somebody cleared round 30')
    // Void every record and sweep again: nothing is taken away.
    db.prepare('UPDATE records SET current=0').run()
    achievements.sweep()
    eq(db.prepare('SELECT COUNT(*) c FROM badge_awards WHERE badge_id=?').get(b.id).c, holders, 'earned is earned')
    db.prepare('UPDATE records SET current=1 WHERE id IN (SELECT MAX(id) FROM records GROUP BY board_id)').run()
  })

  // ── moderation ─────────────────────────────────────────────────────────────
  check('a griefing ban is public-play only; the player keeps their friends', () => {
    bans.ban({ steamId: '76561198000000003', scope: 'public', reason: 'griefing' })
    truthy(bans.publicBanned('76561198000000003'), 'out of public lobbies')
    eq(bans.siteBanned('76561198000000003'), false, 'still allowed on the site')
  })

  check('a cheating ban wipes records and map badges, and nothing else does', () => {
    const sid = '76561198000000002'
    truthy(badges.forPlayer(sid).length > 0, 'they had badges')
    bans.ban({ steamId: sid, scope: 'site', cheating: true, reason: 'cheating' })
    const left = badges.forPlayer(sid).filter((b) => b.kind === 'map' || b.kind === 'record')
    eq(left.length, 0, 'map and record badges gone')
    eq(db.prepare('SELECT COUNT(*) c FROM records WHERE steam_id=? AND current=1').get(sid).c, 0, 'records voided')
  })

  // ── parties ────────────────────────────────────────────────────────────────
  check('a Verified lobby refuses custom knobs', () => {
    const p = parties.create('76561198000000001', { mode: 'verified' })
    truthy(p, 'party made')
    const r = parties.setSettings('76561198000000001', { zombies: { health: 10 } })
    eq(r.ok, false)
    parties.leave('76561198000000001')
  })

  check('the leader decides: launch refuses until everyone is ready, and says who', () => {
    // A public lobby so the join needs no friendship, and delta because the moderation
    // tests above put a public-play ban on gamma — which is itself the rule working.
    parties.create('76561198000000001', { visibility: 'public' })
    const id = parties.forPlayer('76561198000000001').id
    truthy(parties.join('76561198000000004', id).ok, 'delta joined')
    eq(parties.join('76561198000000003', id).ok, false, 'a public-play ban keeps gamma out of a public lobby')
    parties.setMap('76561198000000001', 'nazi_zombie_test')
    parties.startReadyCheck('76561198000000001')
    const a = parties.launch('76561198000000001')
    eq(a.ok, false, 'refused with somebody unready')
    eq(a.error, 'not everyone is ready')
    truthy(a.waiting && a.waiting.length === 1, 'and says who')
    eq(a.waiting[0].steam_id, '76561198000000004')
  })

  check('with nobody ready to play on, a launch says there is no box rather than pretending', () => {
    parties.setReady('76561198000000004', true)
    const a = parties.launch('76561198000000001')
    // No box has polled in this process, so pickFree() finds nothing. The refusal has to
    // name that rather than leaving a party stuck in `launching` forever.
    eq(a.ok, false)
    eq(a.error, 'no game box is online')
    eq(db.prepare('SELECT state FROM parties WHERE id=?').get(parties.forPlayer('76561198000000001').id).state, 'ready-check', 'the party is not left mid-launch')
  })

  check('a party cannot exceed World at War’s four client slots', () => {
    eq(parties.MAX_PLAYERS, 4)
  })

  // ── the rail: invite by name, the online block (lib/roster.js) ─────────────
  // Fresh ids so nothing above leaks in: echo invites, foxtrot is invited, golf is a
  // stranger, hotel is on the waiting list.
  const [E, F, G, H] = ['76561198000000011', '76561198000000012', '76561198000000013', '76561198000000014']
  for (const [sid, n, ok] of [[E, 'echo', 1], [F, 'foxtrot', 1], [G, 'golf', 1], [H, 'hotel', 0]]) {
    users.ensure(sid, { username: n })
    db.prepare('UPDATE users SET approved=?, enw_name=? WHERE steam_id=?').run(ok, n, sid)
  }

  check('an invite from somebody with no party makes one, carrying what the rail had staged', () => {
    eq(parties.forPlayer(E), null, 'echo starts with no party')
    const r = parties.invite(E, F, { map_key: 'nazi_zombie_test', mode: 'custom', visibility: 'friends' })
    truthy(r.ok, r.error)
    const p = parties.forPlayer(E)
    eq(p.map && p.map.key, 'nazi_zombie_test', 'the staged map came with it')
    eq(p.mode, 'custom', 'and the staged mode')
    eq(p.invited.length, 1, 'the roster lists who was invited')
    eq(p.invited[0].steam_id, F)
    truthy(parties.invite(E, F).ok, 'pressing + twice is fine')
    eq(db.prepare("SELECT COUNT(*) c FROM party_invites WHERE to_steam=? AND state='pending'").get(F).c, 1, 'and is still one invite')
    eq(parties.invite(E, E).ok, false, 'not yourself')
    eq(parties.invite(E, '76561198000000999').ok, false, 'not somebody with no account')
  })

  check('a staged value the server does not recognise is not written into a party', () => {
    const p = parties.create(G, { mode: 'hardcore', visibility: 'everyone', mapKey: 'nazi_zombie_nope' })
    eq(p.mode, 'verified'); eq(p.visibility, 'friends'); eq(p.map, null)
    parties.leave(G)
  })

  check('an invite opens a friends-only lobby to the person invited, and to nobody else', () => {
    const id = parties.forPlayer(E).id
    eq(parties.join(G, id).ok, false, 'a stranger is still refused')
    const inv = parties.invitesFor(F)
    eq(inv.length, 1); eq(inv[0].map_title, 'Test Map', 'the invite card can name the map')
    truthy(parties.join(F, id).ok, 'foxtrot is not a friend of echo, and the invite let them in')
    eq(parties.invitesFor(F).length, 0, 'the invite is used up')
    eq(parties.invite(E, F).ok, false, 'already in the party')
  })

  check('the invitee can decline, the party can take an invite back, and the leader can kick', () => {
    parties.invite(E, G)
    const gi = parties.invitesFor(G)[0]
    eq(parties.declineInvite(F, gi.id).ok, false, 'only the person invited can decline it')
    truthy(parties.declineInvite(G, gi.id).ok)
    eq(parties.invitesFor(G).length, 0)
    parties.invite(E, G)
    const again = parties.forPlayer(E).invited.find((u) => u.steam_id === G)
    truthy(parties.cancelInvite(E, again.invite_id).ok, 'echo takes it back')
    eq(parties.invitesFor(G).length, 0)
    eq(parties.kick(F, E).ok, false, 'a member cannot kick the leader')
    truthy(parties.kick(E, F).ok, 'the leader removes foxtrot')
    eq(parties.forPlayer(F), null)
  })

  check('the online block: everyone for an approved reader, friends only for anybody else', () => {
    const presence = require('../server/lib/presence')
    const roster = require('../server/lib/roster')
    for (const sid of [E, F, G, H]) presence.connected(sid, 'sock-' + sid)
    parties.invite(E, F)
    const forF = roster.forViewer(F)
    eq(forF.scope, 'online')
    const echo = forF.players.find((p) => p.steam_id === E)
    truthy(echo && echo.lobby, 'echo is shown sitting in a lobby')
    eq(echo.lobby.invited, true, 'with the invite to foxtrot on it')
    eq(echo.lobby.joinable, true, 'which makes it joinable for foxtrot')
    eq(forF.players.some((p) => p.steam_id === F), false, 'the reader is not in their own list')
    const forG = roster.forViewer(G)
    eq(forG.players.find((p) => p.steam_id === E).lobby.joinable, false, 'a friends-only lobby is not joinable for a stranger')
    const forE = roster.forViewer(E)
    eq(forE.players.find((p) => p.steam_id === F).held, 'invited', 'the inviter sees foxtrot as invited')
    const forH = roster.forViewer(H)
    eq(forH.scope, 'friends', 'the waiting list gets the friends scope')
    eq(forH.players.length, 0, 'and hotel has no friends online')
    eq(roster.search(E, 'fox')[0].steam_id, F, 'the invite box finds foxtrot by ENW name')
    eq(roster.search(E, 'f').length, 0, 'one character is not a search')
    for (const sid of [E, F, G, H]) presence.disconnected(sid, 'sock-' + sid)
    parties.leave(E)
  })

  // ── Not playable, and why (B, 2026-09-22 late) ─────────────────────────────
  check('a map no box will run is marked, with the reason, on the list and on the party', () => {
    const add = (key, health) => db.prepare(`INSERT OR IGNORE INTO maps (key, slug, title, source, health, main_finish, round_n, added_at)
                                              VALUES (?,?,?,'custom',?,'round',20,?)`).run(key, key, key, health, now())
    add('nazi_zombie_derberg', 'playable')
    add('nazi_zombie_unrun', 'playable')
    add('nazi_zombie_localonly', 'custom-only')
    const one = (k) => maps.project(db.prepare('SELECT * FROM maps WHERE key=?').get(k))
    eq(one('nazi_zombie_test').on_server, true, 'the proven fixture map is playable')
    eq(one('nazi_zombie_test').server_note, null, 'and carries no reason')
    eq(one('nazi_zombie_derberg').on_server, false, 'Der Berg is not')
    truthy(/engine limit/.test(one('nazi_zombie_derberg').server_note), 'and says why: ' + one('nazi_zombie_derberg').server_note)
    eq(one('nazi_zombie_unrun').server_note, 'Not tested on our servers yet')
    eq(one('nazi_zombie_localonly').server_note, 'Play Local only')
    const G = '76561198000000007'
    users.ensure(G, { username: 'golf' }); db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(G)
    const pty = parties.create(G, { mapKey: 'nazi_zombie_derberg' })
    eq(pty.map.on_server, false, 'the party card knows too')
    truthy(pty.map.server_note, 'with the reason for its hover')
    parties.leave(G)
  })

  // ── The 'box' level: loads on our servers, no client yet (B, 2026-09-23) ─────
  check('a box-proven map is offered to a party, tagged New with its caveat; a box failure says why', () => {
    const passKey = [...maps.BOX_PROVEN][0]
    const failKey = Object.keys(maps.BOX).find((k) => maps.BOX[k].result === 'fail')
    truthy(passKey, 'boxProven.json lists at least one pass')
    const add = (key, health) => db.prepare(`INSERT OR IGNORE INTO maps (key, slug, title, source, health, main_finish, round_n, added_at)
                                              VALUES (?,?,?,'custom',?,'round',20,?)`).run(key, key, key, health, now())
    add(passKey, 'playable')
    const one = (k) => maps.project(db.prepare('SELECT * FROM maps WHERE key=?').get(k))
    eq(one(passKey).on_server, true, passKey + ' may be leased')
    eq(one(passKey).server_level, 'box', 'at the box level')
    truthy(/not yet played with a client/.test(one(passKey).server_note), 'with the caveat: ' + one(passKey).server_note)
    eq(one('nazi_zombie_test').server_level, 'proven', 'the five-gate fixture is proven, not box')
    db.prepare('UPDATE maps SET health=? WHERE key=?').run('broken', passKey)
    eq(one(passKey).on_server, false, 'broken wins over a box pass')
    db.prepare('UPDATE maps SET health=? WHERE key=?').run('playable', passKey)
    if (failKey) {
      add(failKey, 'broken')
      eq(one(failKey).on_server, false, failKey + ' failed on the box')
      truthy(/^Does not run on our servers: /.test(one(failKey).server_note), 'and says why: ' + one(failKey).server_note)
    }
  })

  // ── Steam pictures, no API key (lib/steamAvatar.js) ─────────────────────────
  check('the Steam picture comes out of the public profile XML, and only from Steam’s own hosts', () => {
    const steamAvatar = require('../server/lib/steamAvatar')
    const xml = '<profile><avatarMedium><![CDATA[https://avatars.steamstatic.com/abc_medium.jpg]]></avatarMedium>' +
      '<avatarFull><![CDATA[https://avatars.fastly.steamstatic.com/abc_full.jpg]]></avatarFull></profile>'
    eq(steamAvatar.parse(xml), 'https://avatars.fastly.steamstatic.com/abc_full.jpg', 'the full size wins')
    eq(steamAvatar.parse('<avatarMedium><![CDATA[https://avatars.steamstatic.com/m.jpg]]></avatarMedium>'), 'https://avatars.steamstatic.com/m.jpg', 'medium when there is no full')
    eq(steamAvatar.parse('<avatarFull><![CDATA[https://evil.example/x.jpg]]></avatarFull>'), null, 'not somebody else’s host')
    eq(steamAvatar.parse('<avatarFull><![CDATA[http://avatars.steamstatic.com/x.jpg]]></avatarFull>'), null, 'not plain http')
    eq(steamAvatar.parse('<html>Steam is down</html>'), null, 'nothing out of an error page')
  })

  await checkAsync('the picture is read at sign-in and then at most once a day, never per render', async () => {
    const steamAvatar = require('../server/lib/steamAvatar')
    const H = '76561198000000008'
    users.ensure(H, { username: 'hotel' })
    const was = { fetch: global.fetch, env: process.env.ZM_STEAM_AVATARS }
    let calls = 0
    global.fetch = async (url) => {
      calls++
      if (!String(url).startsWith(`https://steamcommunity.com/profiles/${H}?xml=1`)) throw new Error('wrong url ' + url)
      return { ok: true, text: async () => '<avatarFull><![CDATA[https://avatars.steamstatic.com/h_full.jpg]]></avatarFull>' }
    }
    process.env.ZM_STEAM_AVATARS = 'on'
    try {
      eq(await steamAvatar.refresh(H, { force: true }), 'https://avatars.steamstatic.com/h_full.jpg', 'sign-in reads it')
      eq(users.pub(users.byId(H)).avatar, 'https://avatars.steamstatic.com/h_full.jpg', 'and every row that shows hotel has it')
      await steamAvatar.refresh(H)
      eq(calls, 1, 'a second read inside the day does not go to Steam')
      db.prepare('UPDATE users SET avatar_checked=? WHERE steam_id=?').run(now() - steamAvatar.DAY_MS - 1, H)
      await steamAvatar.refresh(H)
      eq(calls, 2, 'a day later it does')
      process.env.ZM_STEAM_AVATARS = 'off'
      await steamAvatar.refresh(H, { force: true })
      eq(calls, 2, 'ZM_STEAM_AVATARS=off keeps the suites offline')
    } finally {
      global.fetch = was.fetch
      if (was.env == null) delete process.env.ZM_STEAM_AVATARS; else process.env.ZM_STEAM_AVATARS = was.env
    }
  })

  // ── map download progress (docs/protocol/launcher-v0.md) ───────────────────
  check('a member reports progress, and only for a party they are in', () => {
    partyProgress._reset()
    const id = parties.forPlayer('76561198000000001').id
    const good = parties.reportProgress('76561198000000004', id,
      { map: 'nazi_zombie_test', bytes: 50, total: 200, state: 'downloading' })
    truthy(good.ok, 'a member may report')
    eq(good.progress.pct, 25, 'the percentage is computed for the panel')
    // A signed-in stranger naming somebody else's party id gets nothing. The session is
    // the identity; the id in the URL is only which party.
    eq(parties.reportProgress('76561198000000099', id, { state: 'installed' }).ok, false, 'a non-member is refused')
    eq(parties.reportProgress('76561198000000004', id, { state: 'nearly' }).ok, false, 'an unknown state is refused')
  })

  check('the party payload carries each member’s progress, and the Start gate', () => {
    partyProgress._reset()
    const id = parties.forPlayer('76561198000000001').id
    parties.reportProgress('76561198000000004', id, { map: 'nazi_zombie_test', bytes: 1, total: 4, state: 'downloading' })
    const p = parties.forPlayer('76561198000000001')
    const delta = p.members.find((m) => m.steam_id === '76561198000000004')
    eq(delta.progress.state, 'downloading', 'the member carries their own bar')
    eq(p.installs_ok, false, 'Start stands down while somebody is downloading')
    eq(p.installs_pending.length, 1, 'and names who')
    parties.reportProgress('76561198000000004', id, { map: 'nazi_zombie_test', state: 'installed' })
    eq(parties.forPlayer('76561198000000001').installs_ok, true, 'installed clears it')
  })

  check('silence is not "still downloading" — a party with no launchers can still start', () => {
    // The rule the whole feature turns on. Nobody in this party has ever posted, and the
    // gate must be open: today no launcher posts at all, and a Start button that greys
    // out until a build that does not exist reports in is worse than the bug it fixes.
    partyProgress._reset()
    eq(parties.forPlayer('76561198000000001').installs_ok, true)
  })

  check('a ready check waits for a download, and the leader can still override it', () => {
    partyProgress._reset()
    const id = parties.forPlayer('76561198000000001').id
    parties.cancelReadyCheck('76561198000000001')
    parties.reportProgress('76561198000000004', id, { map: 'nazi_zombie_test', bytes: 1, total: 4, state: 'downloading' })
    const r = parties.startReadyCheck('76561198000000001')
    eq(r.ok, false, 'refused while somebody downloads')
    truthy(/downloading/.test(r.error), 'and says why: ' + r.error)
    eq(r.waiting.length, 1, 'and who')
    truthy(parties.startReadyCheck('76561198000000001', { force: true }).ok, 'THE LEADER DECIDES')
  })

  check('changing the map throws the old map’s progress away', () => {
    partyProgress._reset()
    const id = parties.forPlayer('76561198000000001').id
    parties.reportProgress('76561198000000004', id, { map: 'nazi_zombie_test', state: 'installed' })
    truthy(Object.keys(partyProgress.forParty(id)).length === 1, 'stored')
    parties.setMap('76561198000000001', 'nazi_zombie_factory')
    eq(Object.keys(partyProgress.forParty(id)).length, 0, 'four green bars for the wrong map would be a lie')
    parties.setMap('76561198000000001', 'nazi_zombie_test')
  })

  check('progress is broadcast to every member of that party and to nobody else', () => {
    partyProgress._reset()
    const seen = []
    partyProgress.setEmitter((ids, payload) => seen.push({ ids, payload }))
    const id = parties.forPlayer('76561198000000001').id
    parties.reportProgress('76561198000000004', id, { map: 'nazi_zombie_test', bytes: 2, total: 4, state: 'downloading' })
    partyProgress.setEmitter(null)
    eq(seen.length, 1, 'one broadcast')
    eq(seen[0].ids.sort().join(','), ['76561198000000001', '76561198000000004'].sort().join(','), 'both members, nobody else')
    eq(seen[0].payload.progress['76561198000000004'].pct, 50)
  })

  // ── map art and the map page's facts (web.md §13) ───────────────────────────
  check("a map's picture brings its thumb, and a raw cover is left alone", () => {
    db.prepare(`INSERT INTO maps (key, slug, title, source, health, round_n, added_at, art, art_source)
                VALUES ('nazi_zombie_arttest','arttest','Art Test','custom','playable',20,?, '/media/maps/nazi_zombie_arttest.webp?v=abc123', 'iwd')`).run(now())
    const p = maps.detail('nazi_zombie_arttest')
    eq(p.thumb, '/media/maps/nazi_zombie_arttest.thumb.webp?v=abc123', 'thumb')
    eq(p.art_source, 'iwd', 'art_source')
    // A cover the importer copied (not map_art's output) has no thumb beside it: the card
    // must use the cover itself rather than a path that 404s.
    db.prepare("UPDATE maps SET art='/media/maps/nazi_zombie_arttest.jpg' WHERE key='nazi_zombie_arttest'").run()
    eq(maps.detail('nazi_zombie_arttest').thumb, '/media/maps/nazi_zombie_arttest.jpg', 'fallback thumb')
    // And a path that tries to walk out of the media directory is not dressed up as one.
    db.prepare("UPDATE maps SET art='/media/maps/../../x.webp' WHERE key='nazi_zombie_arttest'").run()
    eq(maps.detail('nazi_zombie_arttest').loadscreen, null, 'no loadscreen for a bad path')
  })

  check('the features block is the committed scan, and a map with none has none', () => {
    db.prepare(`INSERT OR IGNORE INTO maps (key, slug, title, source, health, round_n, added_at)
                VALUES ('nazi_zombie_prototype','nacht-feat','Nacht der Untoten','stock','verified',20,?)`).run(now())
    const f = maps.detail('nazi_zombie_prototype').features
    truthy(f, 'Nacht has a features entry')
    eq(f.perks.length, 0, 'Nacht has no perk machines')
    eq(f.pack_a_punch, false, 'Nacht has no Pack-a-Punch')
    eq(f.box, 1, 'Nacht has one box location')
    eq(f.entities, undefined, 'scan internals are not sent to the page')
    eq(maps.detail('nazi_zombie_arttest').features, null, 'an unscanned map gets null, not a guess')
  })

  check("the download size is the original we hold, else the largest live link", () => {
    db.prepare(`INSERT INTO archive_sources (url, site, kind, map_key, status, size_bytes, created_at)
                VALUES ('https://a.example/x','a.example','download','nazi_zombie_arttest','alive',300,?),
                       ('https://b.example/x','b.example','download','nazi_zombie_arttest','dead',900,?)`).run(now(), now())
    const dl = maps.detail('nazi_zombie_arttest').download
    eq(dl.size_bytes, 300, 'a dead link is not the size')
    eq(dl.links, 2); eq(dl.links_alive, 1); eq(dl.links_dead, 1)
    eq(dl.held, false)
  })

  // ── the wipe script, and the backup it refuses to skip ──────────────────────
  checkWipe()

  // ── the replay track (replay.md §8.4, §8.5, §8.7) ───────────────────────────
  check('the track keeps zombies whose list sits on the snap the 10 Hz sampler skips', () => {
    const { buildTrack } = require('../server/routes/replay')
    const ev = [
      { t: 'input', ms: 0, slot: 0, buttons: 1 },
      // The DLL's zombie list on the ODD snaps only -- the phase m_0afb449b had.
      { t: 'snap', ms: 0, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0], health: 100, alive: true }] },
      { t: 'snap', ms: 50, zombies_alive: 1, players: [{ slot: 0, pos: [1, 0, 0], ang: [0, 0] }], zombies: [{ id: 40, pos: [5, 5, 0], yaw: 90 }], nades: [{ id: 70, pos: [1, 1, 1] }] },
      { t: 'snap', ms: 100, players: [{ slot: 0, pos: [2, 0, 0], ang: [0, 0] }] },
      { t: 'snap', ms: 150, zombies_alive: 1, players: [{ slot: 0, pos: [3, 0, 0], ang: [0, 0] }], zombies: [{ id: 40, pos: [6, 5, 0], yaw: 91 }] },
      { t: 'snap', ms: 200, players: [{ slot: 0, pos: [4, 0, 0], ang: [0, 0] }] },
      { t: 'explode', ms: 160, id: 70, pos: [1, 1, 1] },
      { t: 'notify', ms: 210, name: 'intermission' },
      { t: 'snap', ms: 250, players: [{ slot: 0, pos: [900, 0, 0], ang: [0, 0] }] },
    ]
    const lib = { readHeader: () => ({ header: { match_id: 'm_t', map: 'nazi_zombie_test' } }), readEvents: () => ev }
    const t = buildTrack('x.enwr', lib, 10)
    eq(t.zombies.length, 1, 'the zombie was dropped by the stride')
    eq(JSON.stringify(t.zombies[0].pos.slice(0, 3)), '[5,5,0]')
    // §8.11: the sampler now lands ON the zombie frames (phase 1 here: ms 50, 150, 250), so
    // the list is read where it was written; the 250 tick carries the 150 list forward.
    eq(JSON.stringify(t.zombies[0].yaw), '[90,91,91]', 'yaw was not carried')
    eq(t.nades.length, 1, 'the grenade was dropped')
    truthy(t.events.some((e) => e.t === 'explode'), 'no explode in the feed')
    eq(t.end_ms, 210, 'the end is not the intermission')
    eq(t.players[0].fire[0], 1, 'attack bit not carried')
  })

  // ── replay.md §8.11: WaW's round total, the counters, the inputs the HUD animates ──
  check('the round total is the stock _zombiemode.gsc formula, per map family', () => {
    const { roundTotal } = require('../server/lib/wawRules')
    // Measured on m_0afb449b (Nacht, solo): round 1 sent 4 zombies, round 2 sent 9.
    eq(roundTotal('nazi_zombie_prototype', 1, 1).total, 4)
    eq(roundTotal('nazi_zombie_prototype', 2, 1).total, 9)
    eq(roundTotal('nazi_zombie_prototype', 3, 1).total, 14)
    eq(roundTotal('nazi_zombie_prototype', 5, 1).total, 24)
    eq(roundTotal('nazi_zombie_prototype', 10, 1).total, 24, 'solo adds nothing on Nacht')
    eq(roundTotal('nazi_zombie_prototype', 1, 4).total, 8, '(24 + 3*6) * 0.2')
    eq(roundTotal('nazi_zombie_prototype', 10, 4).total, 24 + 54)
    eq(roundTotal('nazi_zombie_factory', 1, 1).total, 5, 'Der Riese solo adds 0.5 * 6')
    eq(roundTotal('nazi_zombie_asylum', 1, 1).total, 6, 'Verrückt rounds 1-2 override')
    eq(roundTotal('some_custom_map', 1, 1).source, 'stock-formula-assumed')
  })

  check('the track counts zombies left, carries the buttons, and records hits and weapons', () => {
    const { buildTrack } = require('../server/routes/replay')
    const z = (id, x) => ({ id, pos: [x, 0, 0] })
    const ev = [
      { t: 'round', ms: 0, n: 1 },
      { t: 'snap', ms: 0, round: 1, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0], health: 100, alive: true, weapon: '#7' }] },
      { t: 'snap', ms: 50, round: 1, zombies_alive: 1, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0] }], zombies: [z(300, 40)] },
      { t: 'input', ms: 60, slot: 0, buttons: 0x4001 },
      { t: 'snap', ms: 100, round: 1, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0], health: 50 }] },
      { t: 'snap', ms: 150, round: 1, zombies_alive: 2, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0] }], zombies: [z(300, 40), z(301, 900)] },
      { t: 'input', ms: 170, slot: 0, buttons: 0x200 },
      { t: 'snap', ms: 250, round: 1, zombies_alive: 1, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0], weapon: '#16' }], zombies: [z(301, 890)] },
      { t: 'snap', ms: 350, round: 1, zombies_alive: 1, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 0] }], zombies: [z(301, 880)] },
    ]
    const lib = { readHeader: () => ({ header: { match_id: 'm_t2', map: 'nazi_zombie_prototype' } }), readEvents: () => ev }
    const t = buildTrack('x.enwr', lib, 10)
    eq(t.zombies_left_source, 'stock-formula')
    eq(JSON.stringify(t.tick_t), '[50,150,350]', 'each tick carries its own snap ms, not t0 + k * 100')
    eq(t.zombies_left[0], 4, 'round 1 solo on Nacht starts at 4')
    eq(t.zombies_left[t.ticks - 1], 3, 'two seen, one gone: 4 - 2 + 1')
    const p = t.players[0]
    eq(JSON.stringify(p.presses.frag), '[[60,170]]', 'the +frag press/release')
    eq(JSON.stringify(p.presses.fire), '[[60,170]]')
    eq(p.btn[t.ticks - 1], 0x200, 'the crouch bit is carried')
    eq(t.hits.length, 1)
    eq(t.hits[0].from - t.hits[0].to, 50)
    eq(JSON.stringify(t.hits[0].src), '[40,0]', 'the nearest zombie is the inferred attacker')
    const names = p.wpn.map((i) => t.weapons[i].name)
    eq(names[0], 'zombie_colt', '#7 on Nacht')
    eq(names[names.length - 1], 'm1carbine', '#16 on Nacht')
    eq(p.pitch, null, 'no usercmd angles in this file: no invented pitch')
  })

  await checkAsync('the viewer’s WaW model: weapon-file spread, the cook fuse, the chalk', async () => {
    const url = require('url').pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'replay3d', 'waw.js')).href
    const w = await import(url)
    const colt = w.WEAPONS.zombie_colt
    eq(colt.standMin, 3, 'hipSpreadStandMin from the weapon file')
    // CG_CalcReticleSpread at 480 lines: tan(3 deg) * 240 / (tan(32.5 deg) * 0.75)
    const g = w.reticleGeom(colt, 0, 'stand', 480)
    truthy(Math.abs(g.spread - 26.32) < 0.05, `spread ${g.spread}`)
    eq(g.alpha, 1)
    eq(w.reticleGeom(colt, 1, 'stand', 480).alpha, 0.5, 'cg_crosshairAlphaMin')
    // Stielhandgranate: armed 0.4 s after the press, 3.5 s fuse from there.
    const c = w.cookAt({ frag: [[1000, 2000]] }, 1500, w.WEAPONS.stielhandgranate)
    eq(c.explodeAt, 1000 + 400 + 3500)
    truthy(c.holding, 'still in hand at 1.5 s')
    eq(c.timeLeftMs, 3400)
    eq(JSON.stringify(w.roundGlyphs(7)), '{"tallies":[5,2]}')
    eq(JSON.stringify(w.roundGlyphs(12)), '{"number":12}')
    // Spread settles to 0 with no input and jumps by fireAdd per shot.
    const tr = { ticks: 3, tick_ms: 100, t0_ms: 0 }
    const pl = { pos: [0, 0, 0, 0, 0, 0, 0, 0, 0], ang: [0, 0, 0, 0, 0, 0], alive: [1, 1, 1], btn: [0, 0, 0], presses: { fire: [[150, 160]] } }
    const s = w.simulateSpread(tr, pl, () => 'zombie_colt')
    eq(s[1], 0)
    eq(s[2], 1, 'one colt shot adds hipSpreadFireAdd 1 (x255) after the decay clamp')
  })

  check('the map version changes with the export, so a re-export is a new .glb URL (§8.12)', () => {
    const { mapVersion } = require('../server/routes/replay')
    const a = mapVersion({ glb: true, built_at: '2026-09-23T00:00:00Z', mtime_ms: 1, bytes: 10 })
    const b = mapVersion({ glb: true, built_at: '2026-09-23T00:06:49Z', mtime_ms: 1, bytes: 10 })
    const c = mapVersion({ glb: true, built_at: '2026-09-23T00:00:00Z', mtime_ms: 2, bytes: 10 })
    truthy(a !== b && a !== c && b !== c, `${a} / ${b} / ${c}`)
    eq(mapVersion({ glb: false }), null)
  })

  check('usercmd angles become a view pitch, zeroed at the spawn', () => {
    const { buildTrack } = require('../server/routes/replay')
    const ev = [
      { t: 'player_spawn', ms: 0, slot: 0 },
      { t: 'snap', ms: 0, zombies_alive: 0, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 90], cmd_ang: [350, 30], health: 100, alive: true }] },
      { t: 'snap', ms: 50, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 95], cmd_ang: [5, 35] }] },
      { t: 'snap', ms: 100, zombies_alive: 0, players: [{ slot: 0, pos: [0, 0, 0], ang: [0, 95], cmd_ang: [5, 35] }] },
    ]
    const lib = { readHeader: () => ({ header: { match_id: 'm_t3', map: 'nazi_zombie_prototype' } }), readEvents: () => ev }
    const t = buildTrack('x.enwr', lib, 10)
    eq(t.players[0].pitch[0], 0, 'pitch is zero at the spawn')
    eq(t.players[0].pitch[1], 15, '350 -> 5 is 15 degrees down')
  })

  // ── Local is untracked, and the site enforces it rather than trusting the box ──
  check('a LOCAL game is stored, and earns nothing at all', () => {
    // Count the MAP badge's holders, not every badge in the table: ingest also runs the
    // held-record reconciliation, which legitimately moves `kind:'record'` badges around
    // when a board's top row changes. A loose count here fails for the right reason at
    // the wrong time and teaches you to ignore it.
    const mapBadge = db.prepare("SELECT id FROM badges WHERE slug='map-nazi_zombie_test'").get()
    const holders = () => db.prepare('SELECT COUNT(*) c FROM badge_awards WHERE badge_id=?').get(mapBadge.id).c
    const before = {
      badges: holders(),
      records: db.prepare('SELECT COUNT(*) c FROM records').get().c,
      xp: db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000001').xp_total,
    }
    const out = results_.ingest({
      box: null, instance: 'local',
      summary: summary({ match_id: 'm_local1', mode: 'local', rounds: 99, finish: { kind: 'easter_egg', label: 'Egg' } }),
    })
    truthy(out.ok, out.error)
    const g = db.prepare("SELECT * FROM games WHERE match_id='m_local1'").get()
    truthy(g, 'the game IS stored — a player should see they played it')
    eq(g.mode, 'local')
    eq(g.records_eligible, 0)
    eq(g.xp_multiplier, 0)
    eq(g.self_reported, 1)
    eq(holders(), before.badges, 'no map badge')
    eq(db.prepare('SELECT COUNT(*) c FROM records').get().c, before.records, 'no record')
    eq(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get('76561198000000001').xp_total, before.xp, 'no XP')
  })

  check('a local result claiming to be eligible is downgraded anyway', () => {
    // The box says what happened; the SITE says what it is worth, and "worth nothing" is
    // the verdict it must not be talkable out of.
    const s = summary({ match_id: 'm_liar_local', mode: 'local', rounds: 255, finish: { kind: 'easter_egg', label: 'Egg' } })
    s.records_eligible = true
    s.xp_multiplier = 1
    results_.ingest({ summary: s })
    const g = db.prepare("SELECT * FROM games WHERE match_id='m_liar_local'").get()
    eq(g.records_eligible, 0, 'refused')
    eq(g.xp_multiplier, 0, 'refused')
    eq(db.prepare('SELECT COUNT(*) c FROM xp_ledger WHERE game_id=?').get(g.id).c, 0, 'not a single ledger row')
  })

  check('a cheated local round never becomes a best round on the shelf or the profile', () => {
    // 255 rounds on a local game costs one console command. It must not show up as an
    // achievement anywhere — but the map must still show as PLAYED, because that is history.
    const p = db.prepare('SELECT * FROM map_progress WHERE steam_id=? AND map_key=?').get('76561198000000001', 'nazi_zombie_test')
    truthy(p.played, 'played')
    truthy(p.best_round < 255, `best_round leaked a local round: ${p.best_round}`)
    const career = results_.careerFor('76561198000000001')
    truthy(career.best_round < 255, `career best_round leaked a local round: ${career.best_round}`)
    truthy(career.games > 0, 'and the games still count as history')
  })

  check('a local game’s replay is not evidence however well it is signed', () => {
    const g = db.prepare("SELECT id FROM games WHERE match_id='m_local1'").get()
    db.prepare(`INSERT OR REPLACE INTO replays (match_id, game_id, box, file, size, key_id, key_pinned, created_at)
                VALUES ('m_local1', ?, 'test-box', 'x.enwr', 10, 'key0000000000002', 1, ?)`).run(g.id, now())
    const grade = replays.grade(replays.rowFor('m_local1'))
    // The key IS the pinned one — on a dev box the local host agent is the box — and it
    // still is not evidence, because the mode decides this and not the key.
    eq(grade.grade, 'local')
    eq(grade.ok, false)
  })

  // ── replays: is it evidence, and who may have it ───────────────────────────
  check('a replay signed by the pinned key is record-grade; one signed by anything else is not', () => {
    const g = db.prepare("SELECT id FROM games WHERE match_id='m_ingest1'").get()
    // m_ingest1 was ingested with key_id = the pinned key.
    const good = replays.grade(replays.rowFor('m_ingest1'))
    eq(good.grade, 'signed'); truthy(good.ok)
    const bad = replays.grade(replays.rowFor('m_unpinned'))
    eq(bad.grade, 'unpinned'); eq(bad.ok, false)
    truthy(/integrity is not authorship/.test(bad.reason), 'and it says why')
    void g
  })

  check('a replay whose key the box never told us is graded unknown, not good', () => {
    db.prepare(`INSERT OR REPLACE INTO replays (match_id, game_id, box, file, size, key_id, key_pinned, created_at)
                VALUES ('m_nokey', NULL, 'test-box', 'x.enwr', 10, NULL, 0, ?)`).run(now())
    const g = replays.grade(replays.rowFor('m_nokey'))
    eq(g.grade, 'unknown-key')
    eq(g.ok, false)
  })

  check('a recovered replay is good enough for a badge and not for a record', () => {
    db.prepare(`INSERT OR REPLACE INTO replays (match_id, game_id, box, file, size, key_id, key_pinned, recovered, created_at)
                VALUES ('m_rec', NULL, 'test-box', 'x.enwr', 10, 'key0000000000002', 1, 1, ?)`).run(now())
    const g = replays.grade(replays.rowFor('m_rec'))
    eq(g.grade, 'recovered')
    eq(g.ok, false)
    truthy(/badge/.test(g.reason))
  })

  check('Q-host-1: your own game always, a stranger needs VIP or a public game', () => {
    const row = replays.rowFor('m_ingest1')
    const mine = users.byId('76561198000000001')   // played m_ingest1
    const other = users.byId('76561198000000004')  // did not
    eq(replays.mayDownload(row, null).ok, false, 'signed out')
    truthy(replays.mayDownload(row, mine).ok, 'their own game')
    eq(replays.mayDownload(row, other).ok, false, 'a stranger, no VIP, not a public game')
    db.prepare('UPDATE users SET vip_is=1 WHERE steam_id=?').run('76561198000000004')
    truthy(replays.mayDownload(row, users.byId('76561198000000004')).ok, 'a stranger with VIP')
    db.prepare('UPDATE users SET vip_is=0 WHERE steam_id=?').run('76561198000000004')
  })

  check('the verify command names the pinned key, never a bare verify', () => {
    const d = replays.describe('m_ingest1', users.byId('76561198000000001'))
    truthy(/--pub /.test(d.verify_command) || /no key pinned/.test(d.verify_command),
      `expected a --pub or an explicit "no key pinned", got: ${d.verify_command}`)
  })

  check('a file path from a box cannot escape the replay directory', () => {
    // The stored path comes from a game box, and a box is not trusted to name a path.
    for (const evil of ['../../../../Windows/System32/config/SAM', 'C:\\Windows\\win.ini', '..\\..\\secrets.enwr']) {
      eq(replays.localPath({ file: evil }), null, evil)
    }
    eq(replays.localPath({ file: 'notareplay.txt' }), null, 'and it must be a .enwr')
  })

  // ── the live view ──────────────────────────────────────────────────────────
  check('a live frame is stored and downsampled, and the box is never told off for it', () => {
    const f = (round) => ({
      instance: 'inst-01',
      match_id: 'm_live',
      state: {
        phase: 'live', mode: 'verified', map: 'nazi_zombie_test', round, maxRound: round,
        players: [{ slot: 0, steamid: '76561198000000003', name: 'gamma', score: 500, health: 100, alive: true, connected: true, pos: [10, 20, 30], ang: [0, 90] }],
        zombies: [{ id: 1, pos: [40, 50, 30], health: 150 }],
        signals: ['box_used'], flags: [],
      },
    })
    truthy(live.push('test-box', f(5)), 'the first frame is taken')
    eq(live.push('test-box', f(6)), false, 'a frame 0 ms later is dropped')
    eq(live.get('m_live').state.round, 5, 'and the stored frame is the one that was taken')
    truthy(live.get('m_live').state.players[0].pos, 'positions survive')
  })

  check('a frame claiming more players or zombies than the engine has is clamped', () => {
    const many = { instance: 'i', match_id: 'm_big', state: { players: Array.from({ length: 40 }, (_, i) => ({ slot: i, name: 'p' + i, pos: [i, i, 0] })), zombies: Array.from({ length: 500 }, (_, i) => ({ id: i, pos: [i, i, 0] })), signals: [], flags: [] } }
    live.push('test-box', many)
    const s = live.get('m_big').state
    eq(s.players.length, 4, 'World at War has four client slots')
    truthy(s.zombies.length <= 64, 'zombies are bounded')
  })

  check('a game with no frames for a while stops being live', () => {
    live.push('test-box', { instance: 'i', match_id: 'm_stale', state: { players: [], zombies: [], signals: [], flags: [] } })
    truthy(live.get('m_stale'), 'live now')
    // Reach into the stored frame's timestamp rather than sleeping for the TTL.
    live.get('m_stale').at = Date.now() - live.TTL_MS - 1
    eq(live.get('m_stale'), null, 'and not live later')
  })

  check("a stranger cannot watch a private lobby, and it is not in their list either", () => {
    // Give the live game a private party.
    const b = boxes.byName('test-box')
    const r = assignments.lease({ box: b, mapKey: 'nazi_zombie_test', players: [{ steamid: '76561198000000003', name: 'gamma' }], matchId: 'm_priv' })
    truthy(r.ok, r.error)
    const p = parties.create('76561198000000003', { visibility: 'private' })
    db.prepare('UPDATE assignments SET party_id=? WHERE match_id=?').run(p.id, 'm_priv')
    live.push('test-box', { instance: 'i', match_id: 'm_priv', state: { map: 'nazi_zombie_test', players: [], zombies: [], signals: [], flags: [] } })

    eq(live.canWatch('m_priv', null).ok, false, 'a signed-out stranger')
    eq(live.canWatch('m_priv', '76561198000000004').ok, false, 'a signed-in stranger')
    truthy(live.canWatch('m_priv', '76561198000000003').ok, 'a member')
    eq(live.list(null).some((g) => g.match_id === 'm_priv'), false, 'and it is absent from the list, not blanked in it')
    parties.leave('76561198000000003')
  })

  check('a game with no party behind it is public — there is nobody whose privacy it could be', () => {
    truthy(live.canWatch('m_live', null).ok)
  })

  // ── chat ───────────────────────────────────────────────────────────────────
  check('a box never drains its own lines back, however many it has said', () => {
    for (let i = 0; i < 150; i++) chat.push({ from: 'p', text: `line ${i}`, origin: 'test-box' })
    const web = chat.push({ from: 'web', text: 'hello', origin: 'web' })
    // The filter must be in the query: filtering a page of 100 of its own lines in JS
    // returns empty forever and the cursor never advances.
    const got = chat.since(0, { excludeOrigin: 'test-box' })
    truthy(got.some((l) => l.id === web.id), 'the web line is reachable from cursor 0')
    eq(got.every((l) => l.origin !== 'test-box'), true, 'and none of its own')
  })

  check('a chat line is trimmed of newlines and capped', () => {
    const l = chat.push({ from: 'p', text: 'a\nb\r\nc' + 'x'.repeat(500), origin: 'web' })
    eq(l.text.includes('\n'), false)
    truthy(l.text.length <= chat.MAX_LEN)
  })

  check('a chat line carries its kind, and only `system` is a system line', () => {
    const a = chat.push({ from: 'p', text: 'hello', origin: 'web' })
    const b = chat.push({ from: 'ENW', text: 'x started a game on y', origin: 'box-a', kind: 'system' })
    eq(a.kind, 'chat', 'the default is a person talking')
    eq(b.kind, 'system')
    // A player typing the word does not make a system line: the kind is a column, not a
    // prefix on the text.
    eq(chat.push({ from: 'p', text: 'system', origin: 'web', kind: 'nonsense' }).kind, 'chat')
    truthy(chat.tail(5).some((l) => l.id === b.id && l.kind === 'system'), 'and it survives the read back')
  })

  // ── system lines (lib/chatSystem.js) ───────────────────────────────────────
  check('the four system lines read as sentences', () => {
    chatSystem._reset()
    const ev = { name: 'ingameName', map: 'nazi_zombie_asylum', map_name: 'Verrückt', round: 30, match_id: 'm_sys1', instance: 'i1' }
    eq(chatSystem.record('box-a', { ...ev, event: 'started' }).text, 'ingameName started a game on Verrückt')
    eq(chatSystem.record('box-a', { ...ev, event: 'joined' }).text, 'ingameName joined Verrückt')
    eq(chatSystem.record('box-a', { ...ev, event: 'down' }).text, 'ingameName just went down on round 30 on Verrückt')
    eq(chatSystem.record('box-a', { ...ev, event: 'ended' }).text, "ingameName's game on Verrückt ended on round 30")
  })

  check('the handle is the SITE user only for a verified identity', () => {
    chatSystem._reset()
    const sid = '76561198000000001'
    const siteName = users.pub(users.byId(sid)).name
    const base = { name: 'somethingElseEntirely', steamid: sid, map: 'nazi_zombie_asylum', round: 3, match_id: 'm_sys2' }
    const v = chatSystem.record('box-a', { ...base, event: 'down', identity: 'verified' })
    truthy(v.text.startsWith(siteName), `verified uses the account (${v.text})`)
    eq(v.steamid, sid, 'and the line carries the account')
    chatSystem._reset()
    // `claimed` is the dangerous one and it is the one that looks safe: a token arrived
    // and parsed, and nothing has checked the signature. Same gate as /api/gs/result.
    const c = chatSystem.record('box-a', { ...base, event: 'down', identity: 'claimed' })
    truthy(c.text.startsWith('somethingElseEntirely'), 'claimed falls back to the in-game name')
    eq(c.steamid, null, 'and carries no account')
    chatSystem._reset()
    eq(chatSystem.record('box-a', { ...base, event: 'down' }).steamid, null, 'an absent identity fails closed')
  })

  check('a system line goes in the ring as `system`, from the box that reported it', () => {
    chatSystem._reset()
    const l = chatSystem.record('test-box', { event: 'started', name: 'p', map: 'nazi_zombie_asylum', match_id: 'm_sys3' })
    eq(l.kind, 'system')
    // Origin is the BOX, so the box that just watched it happen does not get the line
    // back on its next drain and re-announce it to those same players.
    eq(l.origin, 'test-box')
    eq(chat.since(l.id - 1, { excludeOrigin: 'test-box' }).some((x) => x.id === l.id), false)
  })

  check('the same event arriving twice is one line, and a looping box cannot flood the room', () => {
    chatSystem._reset()
    const ev = { event: 'down', name: 'p', map: 'nazi_zombie_asylum', round: 7, match_id: 'm_sys4' }
    truthy(chatSystem.record('box-a', ev), 'the first one lands')
    eq(chatSystem.record('box-a', ev), null, 'the repeat does not')
    // A different round IS a different event, even inside the dedupe window.
    truthy(chatSystem.record('box-a', { ...ev, round: 8 }), 'round 8 is not round 7')
    chatSystem._reset()
    let taken = 0
    for (let i = 0; i < chatSystem.PER_MATCH_PER_MIN + 10; i++) {
      if (chatSystem.record('box-a', { event: 'down', name: 'p', map: 'm', round: i, match_id: 'm_flood' })) taken++
    }
    eq(taken, chatSystem.PER_MATCH_PER_MIN, 'the per-match ceiling holds')
  })

  check('an event nobody has a sentence for produces nothing', () => {
    chatSystem._reset()
    eq(chatSystem.record('box-a', { event: 'exploded', name: 'p', map: 'm' }), null)
    eq(chatSystem.record('box-a', {}), null)
  })

  check('a map with no title is named by its bsp rather than by a blank', () => {
    chatSystem._reset()
    eq(chatSystem.mapLabel('nazi_zombie_not_in_the_archive', null), 'nazi_zombie_not_in_the_archive')
    eq(chatSystem.mapLabel(null, null), null, 'and a game with no map at all says no map')
    const l = chatSystem.record('box-a', { event: 'joined', name: 'p', match_id: 'm_sys5' })
    eq(l.text, 'p joined a game', 'which reads as a sentence rather than "joined null"')
  })

  // ── the Discord invite (lib/discord.js) ────────────────────────────────────
  check('the Discord link shows until the account has linked one', () => {
    const sid = '76561198000000001'
    eq(discord.forMe(null).linked, false, 'signed out, nobody is known to be in it')
    truthy(discord.forMe(null).invite, 'so the invite is offered')
    eq(discord.forMe(sid).linked, false, 'and nothing writes discord_id yet')
    db.prepare('UPDATE users SET discord_id=? WHERE steam_id=?').run('1234567890', sid)
    eq(discord.forMe(sid).linked, true)
    eq(discord.forMe(sid).invite, null, 'a linked account is handed no URL at all to draw')
    db.prepare('UPDATE users SET discord_id=NULL WHERE steam_id=?').run(sid)
  })

  check('the invite is Movement’s constant unless this deployment names another', () => {
    const was = process.env.ENW_DISCORD_INVITE
    delete process.env.ENW_DISCORD_INVITE
    eq(discord.invite(), 'https://discord.enw.gg')
    process.env.ENW_DISCORD_INVITE = 'https://discord.gg/example'
    eq(discord.invite(), 'https://discord.gg/example')
    // An env var is a thing that gets pasted wrong at 2am, and this goes in an href.
    process.env.ENW_DISCORD_INVITE = 'javascript:alert(1)'
    eq(discord.invite(), 'https://discord.enw.gg', 'a nonsense value falls back rather than shipping')
    if (was == null) delete process.env.ENW_DISCORD_INVITE; else process.env.ENW_DISCORD_INVITE = was
  })

  // ── privacy and deletion ───────────────────────────────────────────────────
  check('deletion anonymises and keeps the records', () => {
    const sid = '76561198000000001'
    const before = db.prepare('SELECT COUNT(*) c FROM records WHERE roster LIKE ?').get(`%"${sid}"%`).c
    users.anonymise(sid)
    const u = users.publicById(sid)
    eq(u.name, 'Deleted player')
    eq(u.deleted, true)
    eq(db.prepare('SELECT COUNT(*) c FROM records WHERE roster LIKE ?').get(`%"${sid}"%`).c, before, 'records kept')
  })

  // ── the archive browse ─────────────────────────────────────────────────────
  check('a broken map is hidden from the list and visible on the archive view', () => {
    db.prepare("INSERT INTO maps (key, slug, title, source, health, added_at) VALUES ('nazi_zombie_broken','broken','Broken','custom','broken',?)").run(now())
    eq(maps.list().maps.some((m) => m.key === 'nazi_zombie_broken'), false, 'hidden from the list')
    eq(maps.list({ includeBroken: true }).maps.some((m) => m.key === 'nazi_zombie_broken'), true, 'on the archive view')
  })

  check('a lease refuses a map that is broken on our servers', () => {
    const r = assignments.lease({ box: boxes.byName('test-box'), mapKey: 'nazi_zombie_broken', players: [{ steamid: '76561198000000003' }] })
    eq(r.ok, false)
  })

  check('search ranks the map name above the author and the description', () => {
    db.prepare("INSERT INTO maps (key, slug, title, author, source, health, description, added_at) VALUES ('nazi_zombie_other','other','Other','Test Map Author','custom','verified','mentions test map',?)").run(now())
    const hits = maps.list({ q: 'test map' }).maps
    truthy(hits.length >= 2, 'both matched')
    eq(hits[0].key, 'nazi_zombie_test', 'the name wins')
  })

  check('the alias form finds a map: "factory" finds nazi_zombie_factory', () => {
    db.prepare("INSERT INTO maps (key, slug, title, source, health, added_at) VALUES ('nazi_zombie_factory','der-riese','Der Riese','stock','verified',?)").run(now())
    eq(maps.list({ q: 'factory' }).maps[0].key, 'nazi_zombie_factory')
  })

  // ── ratings ────────────────────────────────────────────────────────────────
  check('only somebody who has played it can rate it', () => {
    eq(maps.rate('nazi_zombie_test', '76561198000000099', 1).ok, false, 'a stranger cannot')
    truthy(maps.rate('nazi_zombie_test', '76561198000000003', 1).ok, 'a player can')
  })


  // ── the map browser's filters (B's morning list, 2026-09-22) ──────────────────
  //
  // Size, difficulty and style are not new columns: they are TAG KINDS, and the bar writes
  // one URL param per group. The rule the whole bar rests on is OR within a group, AND
  // across groups — get that backwards and "Large and Hard" quietly answers "Large or
  // Hard", which is most of the archive.
  check('a filter group is OR inside it and AND across groups', () => {
    const tag = (slug, label, kind) => {
      db.prepare('INSERT OR IGNORE INTO tags (slug, label, kind, sort_order) VALUES (?,?,?,0)').run(slug, label, kind)
      return db.prepare('SELECT id FROM tags WHERE slug=?').get(slug).id
    }
    const small = tag('small', 'Small', 'size')
    const large = tag('large', 'Large', 'size')
    const horror = tag('horror', 'Horror', 'style')
    const idOf = (k) => db.prepare('SELECT id FROM maps WHERE key=?').get(k).id
    const t4 = idOf('nazi_zombie_test')
    const riese = idOf('nazi_zombie_factory')
    const link = db.prepare('INSERT OR IGNORE INTO map_tags (map_id, tag_id) VALUES (?,?)')
    link.run(t4, small); link.run(t4, horror)
    link.run(riese, large)

    // OR within the group: both maps come back.
    const either = maps.list({ tagGroups: ['', 'small,large'] }).maps.map((m) => m.key).sort()
    eq(either.join(','), 'nazi_zombie_factory,nazi_zombie_test', 'OR within a group')
    // AND across groups: only the map that is BOTH small and horror.
    const both = maps.list({ tagGroups: ['', 'small,large', '', 'horror'] }).maps.map((m) => m.key)
    eq(both.join(','), 'nazi_zombie_test', 'AND across groups')
    // A group naming nothing real matches nothing — it must not quietly answer "everything".
    eq(maps.list({ tagGroups: ['', 'no-such-tag'] }).total, 0, 'an unknown slug is not ignored')
    // The single-slug spelling still works: /maps?tag=horror is on the map page, on every
    // creator page, and in whatever anybody has already pasted.
    eq(maps.list({ tag: 'horror' }).maps[0].key, 'nazi_zombie_test', 'one slug in `tag` still works')
  })

  check('"playable on our server" is narrower than "in the list"', () => {
    db.prepare(`INSERT INTO maps (key, slug, title, source, health, added_at)
                VALUES ('nazi_zombie_dlonly','dl-only','Download only','custom','custom-only',?)`).run(now())
    const listed = maps.list({}).maps.map((m) => m.key)
    truthy(listed.includes('nazi_zombie_dlonly'), 'a custom-only map is still in the list')
    const ours = maps.list({ server: true }).maps.map((m) => m.key)
    truthy(!ours.includes('nazi_zombie_dlonly'), 'a custom-only map is not on our servers')
    truthy(ours.includes('nazi_zombie_test'), 'a verified map is')
    // And the flag every card and row reads, so nothing has to re-derive it from `health`.
    eq(maps.list({ q: 'Download only' }).maps[0].on_server, false, 'on_server says so')
  })

  check('"has records" asks the boards and the replays, not the map row', () => {
    // The suite has already played games on nazi_zombie_test by the time this runs, so the
    // assertion that means anything is the SPLIT: the map with a board qualifies and the
    // one nobody has ever played does not.
    const withRecords = maps.list({ records: true }).maps.map((m) => m.key)
    truthy(withRecords.includes('nazi_zombie_test'), 'the map with a record does not qualify')
    truthy(!withRecords.includes('nazi_zombie_factory'), 'a map nobody has played qualified')
  })

  // ── the home rows (`collections`) ─────────────────────────────────────────────
  //
  // B: "make the row membership a collections/playlist-like table editable from admin, not
  // hard-coded." These four checks are the difference between that sentence being true and
  // the rows being an array in the client with a table beside it for show.
  check('the three rows are seeded, and Vanilla is the four stock maps', () => {
    const all = collections.all()
    const bySlug = Object.fromEntries(all.map((c) => [c.slug, c]))
    truthy(bySlug.new && bySlug.vanilla && bySlug['high-production'], 'a row is missing')
    eq(bySlug.new.kind, 'auto', 'New maps is a query, not a hand-picked list')
    eq(bySlug.vanilla.keys.length, 4, 'Vanilla is not the four stock maps')
    eq(bySlug['high-production'].keys.join(','), 'nazi_zombie_leviathan', 'High production was not seeded with Leviathan')
  })

  check('a row only shows maps the list view would show, in the collection’s own order', () => {
    const id = collections.all().find((c) => c.slug === 'high-production').id
    // Leviathan is not in this test database at all, so the row resolves to nothing and is
    // dropped: an empty shelf reads as a broken site.
    truthy(!collections.live().some((r) => r.slug === 'high-production'), 'an unresolvable row was drawn')
    truthy(collections.addMap(id, 'nazi_zombie_factory').ok, 'could not add a map')
    truthy(collections.addMap(id, 'nazi_zombie_test').ok, 'could not add a second map')
    const row = collections.live().find((r) => r.slug === 'high-production')
    eq(row.maps.map((m) => m.key).join(','), 'nazi_zombie_factory,nazi_zombie_test', 'the row lost the admin’s order')
    // A broken map must not reach a shelf even when an admin put it there.
    db.prepare("UPDATE maps SET health='broken' WHERE key='nazi_zombie_factory'").run()
    eq(collections.live().find((r) => r.slug === 'high-production').maps.length, 1, 'a broken map reached the shelf')
    db.prepare("UPDATE maps SET health='verified' WHERE key='nazi_zombie_factory'").run()
  })

  check('a map an admin removes stays removed when the server restarts', () => {
    const id = collections.all().find((c) => c.slug === 'vanilla').id
    truthy(collections.removeMap(id, 'nazi_zombie_prototype').ok, 'remove failed')
    eq(collections.keysOf(id).length, 3, 'the map was not removed')
    // The seeder runs on every boot. If it re-asserted its list it would be a second editor
    // quietly overruling the first, every restart, for ever.
    seedCollections()
    eq(collections.keysOf(id).length, 3, 'the seeder put a removed map back')
  })

  check('a collection refuses a map that does not exist, and a query row has no map list', () => {
    const vanilla = collections.all().find((c) => c.slug === 'vanilla').id
    eq(collections.addMap(vanilla, 'nazi_zombie_nothing').ok, false, 'an unknown key was accepted')
    const newest = collections.all().find((c) => c.slug === 'new').id
    eq(collections.addMap(newest, 'nazi_zombie_test').ok, false, 'a query row took a hand-picked map')
  })

  // ── identity: who a result may award anything to ──────────────────────────────
  //
  // Referee lane, 2026-09-22 (`docs/protocol/game-link-v0.md`): a `players[]` row carries
  // `identity` and only `verified` may be credited. `claimed` is the dangerous one — a
  // token arrived and PARSED, and its signature was never checked, so it is a claim about
  // who was playing rather than a fact.
  const identSummary = (rows) => summary({
    match_id: 'm_ident_' + Math.random().toString(16).slice(2, 8),
    players: rows.map((r) => r.sid),
  })
  const withIdentity = (sum, rows) => {
    sum.players = sum.players.map((p, i) => (rows[i].identity ? { ...p, identity: rows[i].identity } : p))
    return sum
  }

  check('a `claimed` player row is attendance: no game_players row, no XP, no map progress', () => {
    const sid = '76561198000000002'
    const before = db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(sid).xp_total
    const sum = withIdentity(identSummary([{ sid }]), [{ identity: 'claimed' }])
    const out = results_.ingest({ box: 'test-box', summary: sum }, { requireVerifiedIdentity: true })
    truthy(out.ok, 'the result itself was refused — it should be stored, just not credited')
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=?').get(out.game_id).c, 0, 'a claimed row was seated')
    eq(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(sid).xp_total, before, 'a claimed row earned XP')
    eq(out.unverified.length, 1, 'the refusal was not reported back')
    eq(out.unverified[0].identity, 'claimed')
    // The whole result is still on file, exactly as the box sent it — attendance, not a
    // deletion. And the refusal is in the audit log, because the player will ask why.
    truthy(JSON.parse(db.prepare('SELECT summary_json j FROM games WHERE id=?').get(out.game_id).j).players.length === 1,
      'the player vanished from the stored summary')
    truthy(db.prepare("SELECT COUNT(*) c FROM activity_log WHERE event='result.unverified'").get().c > 0, 'nothing was logged')
  })

  check('a `verified` player row is credited exactly as before', () => {
    const sid = '76561198000000004'
    const sum = withIdentity(identSummary([{ sid }]), [{ identity: 'verified' }])
    const out = results_.ingest({ box: 'test-box', summary: sum }, { requireVerifiedIdentity: true })
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=? AND steam_id=?').get(out.game_id, sid).c, 1, 'a verified row was not seated')
    truthy(db.prepare('SELECT xp_total FROM users WHERE steam_id=?').get(sid).xp_total > 0, 'a verified row earned no XP')
    eq(out.unverified.length, 0, 'a verified row was reported as unverified')
  })

  check('`refused`, and an absent identity, fail closed on the box path', () => {
    const sum = withIdentity(identSummary([{ sid: '76561198000000002' }, { sid: '76561198000000003' }]),
      [{ identity: 'refused' }, {}])
    const out = results_.ingest({ box: 'test-box', summary: sum }, { requireVerifiedIdentity: true })
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=?').get(out.game_id).c, 0, 'an unverified row was seated')
    eq(out.unverified.length, 2, 'both rows should have been held back')
    // An absent field is reported as `none`, which is what it means, rather than as ''.
    eq(out.unverified[1].identity, 'none', 'an absent identity was not named')
  })

  check('a Local run is not identity-gated — it never had a token, and it scores zero anyway', () => {
    const sid = '76561198000000003'
    const sum = summary({ match_id: 'm_local_' + Math.random().toString(16).slice(2, 8), mode: 'local', players: [sid] })
    const out = results_.ingest({ box: 'test-box', summary: sum }, { selfReported: true })
    eq(db.prepare('SELECT COUNT(*) c FROM game_players WHERE game_id=?').get(out.game_id).c, 1, 'the local run lost its player')
    eq(db.prepare('SELECT records_eligible, xp_multiplier FROM games WHERE id=?').get(out.game_id).records_eligible, 0,
      'a local run became records-eligible')
  })

  // ---- the ENW name, and the end of "Unknown Soldier" (2026-09-23) -----------
  //
  // B: "Make people's usernames their ENW username ... right now it says Unknown
  // Soldier." Four things have to hold, and the first is the one that actually caused it.
  const names_ = require("../server/lib/names")

  check('a result never writes the game’s idea of a name back into the account', () => {
    // THE REGRESSION TEST FOR "UNKNOWN SOLDIER". `lib/results.js` used to do
    // `users.ensure(sid, { username: p.name })`, so the engine's stock default for the
    // `name` dvar became the player's site username — which is exactly what the live
    // database was found holding. The name travels site -> token -> game now, and never
    // back.
    const sid = '76561198000000031'
    users.ensure(sid, {})
    db.prepare('UPDATE users SET enw_name=? WHERE steam_id=?').run('enw-tester', sid)
    const sum = summary({ match_id: 'm_nm_' + Math.random().toString(16).slice(2, 8), players: [sid] })
    for (const p of sum.players) { p.name = 'Unknown Soldier'; p.identity = 'verified' }
    results_.ingest({ box: 'test-box', summary: sum }, { selfReported: false })
    const row = db.prepare('SELECT username, enw_name FROM users WHERE steam_id=?').get(sid)
    eq(row.username, null, 'the game’s name was written into users.username')
    eq(row.enw_name, 'enw-tester', 'the ENW name was overwritten by the game')
  })

  check('a name is set once, unique case-insensitively, and only an admin renames', () => {
    const a = '76561198000000032'
    const b = '76561198000000033'
    users.ensure(a, {}); users.ensure(b, {})
    eq(names_.claim(a, 'Spoofer').ok, true, 'a first claim was refused')
    eq(names_.claim(a, 'somethingelse').reason, 'already_set', 'the name was not set-once')
    // Case-insensitive: "spoofer" and "Spoofer" are the same claim to a reader, and two
    // accounts answering to one name is an impersonation, not a cosmetic clash.
    eq(names_.claim(b, 'spoofer').reason, 'taken', 'a case-variant duplicate was allowed')
    eq(names_.rename(a, 'renamed-by-admin', a).ok, true, 'an admin rename was refused')
    eq(names_.displayName(a), 'renamed-by-admin', 'the rename did not take')
  })

  check('the rules refuse the names that would break the infostring or an ENW link', () => {
    // Mirrors Movement's dropsNames RULES, including its all-digits divergence: a number
    // is an ADDRESS on an ENW site, so a player called "5" would claim somebody's link.
    for (const bad of ['ab', 'x'.repeat(21), 'has space', String.raw`back\slash`, 'semi;colon',
                       'quo"te', '12345', '2026-09-22']) {
      eq(!!names_.validate(bad), true, `"${bad}" was accepted as a username`)
    }
    // `admin` and `Unknown` are the right SHAPE; they are refused by drops.ws's blocklist,
    // which check()/claim() apply after validate(), as drops.ws's availability() does.
    for (const reserved of ['admin', 'Unknown']) eq(names_.check(reserved).reason, 'blocked', `"${reserved}"`)
    eq(names_.validate('enw-tester'), null, 'a legal name was refused')
    eq(names_.validate('a'.repeat(20)), null, 'a 20-character name was refused (drops allows 20)')
  })

  // ---- one ENW name, the same on every ENW site (2026-09-22) ------------------
  check('validation speaks Movement’s words, character for character', () => {
    // CSGO-Matchmaker/server/lib/dropsNames.js:63-72 == csgo-server/src/utils/usernameRules.js:13-30.
    // If any of these drift, a player sees one sentence on Movement and another here.
    const want = [
      ['', 'Username is required'],
      ['   ', 'Username is required'],
      ['ab', 'Username must be at least 3 characters'],
      ['x'.repeat(21), 'Username must be 20 characters or fewer'],
      ['no spaces', 'Username can only contain letters, numbers, underscores and hyphens'],
      ['2026-09-22-me', 'Invalid username'],
      ['1234', 'Usernames cannot be only numbers'],
      ['  myu  ', null],   // trimmed first, as both of theirs do
    ]
    for (const [name, msg] of want) eq(names_.validate(name), msg, JSON.stringify(name))
  })

  check('the drops.ws blocklist is mirrored, leetspeak folding and allowlist included', () => {
    const bl = require('../server/lib/usernames/blocklist')
    truthy(bl.size > 700, `the copied list has ${bl.size} rows; drops.ws has 754`)
    eq(names_.check('4dmin').reason, 'blocked', 'leet on the candidate (4dmin -> admin)')
    eq(names_.check('s1mple').reason, 'blocked', 'an exact handle entry')
    eq(names_.check('Hancock').reason, 'ok', 'an allowlisted surname')
    eq(names_.check('myu').reason, 'ok', 'an ordinary handle')
    const a = '76561198000000041'
    users.ensure(a, {})
    eq(names_.claim(a, 'Administrator').reason, 'blocked', 'a claim ignored the blocklist')
    eq(names_.claim(a, 'Administrator').error, 'That username is not available')
  })

  check('the display name is the ENW name, never the Steam persona', () => {
    const sid = '76561198000000042'
    users.ensure(sid, { username: 'Some Steam Persona' })
    const nameless = users.publicById(sid)
    eq(nameless.name, sid, 'a nameless account showed its Steam persona')
    eq('username' in nameless, false, 'the persona is still on the public projection')
    eq(names_.displayName(sid), sid, 'displayName fell back to the persona')
    eq(users.resolve('Some Steam Persona'), null, 'a profile link resolved through a persona')
    // Uniqueness is on the ENW name only, like drops.ws's index: a persona is nobody's name here.
    eq(names_.check('Some-Steam-Persona').reason, 'ok')
    eq(names_.claim(sid, 'persona-free').ok, true)
    eq(users.publicById(sid).name, 'persona-free', 'the ENW name is not the name')
    eq(users.resolve('PERSONA-FREE').steam_id, sid, 'the ENW name does not resolve')
  })

  check('the name gate: a nameless session may pick a name and nothing else', () => {
    const mw = require('../server/middleware/auth')
    const sid = '76561198000000043'
    users.ensure(sid, {})
    db.prepare('UPDATE users SET approved=1 WHERE steam_id=?').run(sid)
    const run = (guard) => {
      let status = 200; let body = null; let passed = false
      const res = { status (s) { status = s; return this }, json (b) { body = b; return this } }
      guard({ me: users.byId(sid) }, res, () => { passed = true })
      return { status, body, passed }
    }
    for (const g of ['requireUser', 'requireApproved', 'requireMod', 'requireAdmin', 'requireArchivist']) {
      const r = run(mw[g])
      eq(r.passed, false, `${g} let a nameless account through`)
      eq(r.status, 403, g)
      eq(r.body.needs_name, true, `${g} did not say why`)
    }
    eq(run(mw.requireSignedIn).passed, true, 'the picker’s own guard refused a nameless account')
    names_.claim(sid, 'gate-passer')
    eq(run(mw.requireUser).passed, true, 'a named account was still gated')
    eq(run(mw.requireApproved).passed, true, 'a named, approved account was still gated')
  })

  check('the invite token carries the ACCOUNT’s name, not the one the caller asked for', () => {
    // The token's `n` is what the referee pins into the server's copy of the client's
    // userinfo, so a caller-supplied name would be a signed, server-enforced
    // impersonation — strictly worse than the spoofing it replaces.
    const sid = '76561198000000034'
    users.ensure(sid, {})
    db.prepare('UPDATE users SET enw_name=? WHERE steam_id=?').run('the-real-one', sid)
    const tokens_ = require('../server/lib/tokens')
    const names2 = require('../server/lib/names')
    eq(names2.hasEnforceableName(sid), true, 'the fixture has no enforceable name')
    // What lib/assignments.js now builds, from the row rather than from `o.players`.
    const name = names2.displayName(sid)
    eq(name, 'the-real-one', 'the account name is not what the lease would use')
    const tok = tokens_.issue({ steamid: sid, matchId: 'm_nm_tok', name })
    const payload = JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString('utf8'))
    eq(payload.n, 'the-real-one', 'the token did not carry the account name')
  })

  // ---- /settings: World at War's Options menus, per SteamID (2026-09-22) ---------------
  // The page saves one `game` object; the launcher reads it through the preload bridge.
  // launcher/test/waw-settings.js carries it the rest of the way to the +set list and the
  // engine's config.cfg; these are the site's half.
  const waw = await import('../client/src/data/wawSettings.js')

  await checkAsync('a WaW setting saved on the site is stored per SteamID and comes back in the launcher shape', async () => {
    const sid = '76561198000000041'
    const other = '76561198000000042'
    users.ensure(sid, {}); users.ensure(other, {})
    let g = waw.allDefaults()
    const item = (id) => waw.ALL.find((i) => i.id === id)
    g = waw.withValue(g, item('ai_corpseCount'), '32')
    g = waw.withValue(g, item('r_texFilterMipMode'), 'Force Trilinear')
    g = waw.withValue(g, item('fov'), 95)
    g = waw.withValue(g, item('bind:+forward'), ['UPARROW'])
    g.updatedAt = 1700000000000
    users.saveSettings(sid, { game: g })
    const back = users.settings(sid).game
    eq(back.waw.ai_corpseCount, '32')
    eq(back.waw.r_texFilterMipMode, 'Force Trilinear')
    eq(back.wawBinds['+forward'][0], 'UPARROW')
    eq(users.settings(sid).fov, 95, 'the site-wide fov did not follow the Settings page')
    eq(users.settings(other).game, undefined, 'another account picked it up')
    const p = waw.toLauncherPatch(back)
    eq(p.waw.ai_corpseCount, '32')
    eq(p.fov, 95)
    eq(p.gameUpdatedAt, 1700000000000)
    eq(p.waw.sm_enable, null, 'a game-default item must reach the launcher as null (reset)')
  })

  check('the stored game blob refuses junk: bad keys, long values, a quit smuggled into a bind', () => {
    const g = users.sanitizeGame({ fov: 400, mode: 'kiosk', waw: { 'r_gamma; quit': '1', r_gamma: 'x'.repeat(40), fx_marks: '0' }, wawBinds: { '+attack': ['MOUSE1', 'K;QUIT', 'F', 'G'] } })
    eq(g.fov, 120)
    eq(g.mode, undefined)
    eq(JSON.stringify(g.waw), JSON.stringify({ fx_marks: '0' }))
    eq(JSON.stringify(g.wawBinds['+attack']), JSON.stringify(['MOUSE1', 'F']))
  })

  check('every WaW item has a source and a section, and each section has a reset', () => {
    for (const it of waw.ALL) {
      truthy(it.src && it.src.length > 10, `${it.label} has no source`)
      truthy(waw.SECTIONS.some((s) => s.id === it.section), `${it.label} is in no section`)
    }
    for (const s of waw.SECTIONS) truthy(Object.keys(waw.sectionDefaults(s.id)).length, `${s.id} has no defaults`)
    // The launcher's whitelist is a different package; read it as text so this suite does
    // not need the launcher's ESM graph. Every dvar the page can send must be in it.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher', 'src', 'main', 'wawcfg.js'), 'utf8')
    for (const it of waw.ALL.filter((i) => i.to === 'waw')) truthy(new RegExp(`\\b${it.dvar}:`).test(src), `${it.dvar} is not in the launcher whitelist`)
  })

  // ---- the profile: Top/Recent maps, Overall, the Movement banner (2026-09-22) ----------
  {
    const profile = require('../server/lib/profile')
    const PSID = '76561198000000321'
    users.ensure(PSID, { enw_name: 'prof-tester' })
    db.prepare(`INSERT OR IGNORE INTO maps (key, slug, title, author, source, health, round_n, art, added_at)
                VALUES ('nazi_zombie_proftest','proftest','Prof Test','t','custom','playable',20,'/media/maps/nazi_zombie_proftest.jpg',?)`).run(now())
    const T0 = Date.now() - 10 * 86400000
    let n = 0
    const game = (map, { mode = 'custom', rounds = 5, dur = 0, start = null, end = null, demo = 0, rp = rounds, kills = 0 } = {}) => {
      const g = db.prepare(`INSERT INTO games (match_id, mode, map_key, rounds, player_count, duration_ms, started_at, ended_at, demo)
                            VALUES (?,?,?,?,1,?,?,?,?)`).run(`prof_${++n}`, mode, map, rounds, dur, start, end, demo)
      db.prepare('INSERT INTO game_players (game_id, steam_id, slot, rounds_played, kills) VALUES (?,?,0,?,?)').run(g.lastInsertRowid, PSID, rp, kills)
      return g.lastInsertRowid
    }
    // test map: 2 games, 30 min total (one with only start/end). proftest: 1 game, 50 min, played last.
    game('nazi_zombie_test', { dur: 20 * 60000, start: T0, end: T0 + 20 * 60000, rounds: 12, mode: 'verified' })
    game('nazi_zombie_test', { dur: 0, start: T0 + 86400000, end: T0 + 86400000 + 10 * 60000, rounds: 4 })
    game('nazi_zombie_proftest', { dur: 50 * 60000, start: T0 + 3 * 86400000, end: T0 + 3 * 86400000 + 50 * 60000, rounds: 30 })
    // seeded scaffolding must never reach a profile
    game('nazi_zombie_test', { dur: 999 * 60000, start: T0, end: T0 + 1, rounds: 99, demo: 1, kills: 500 })

    check('profile: Top maps is by time, Recent by last played, demo games left out', () => {
      const m = profile.mapsFor(PSID)
      eq(m.top[0].key, 'nazi_zombie_proftest', 'top[0]')
      eq(m.top[0].time_ms, 50 * 60000, 'top[0] time')
      eq(m.top[0].art, '/media/maps/nazi_zombie_proftest.jpg', 'art rides on the row')
      eq(m.top[1].key, 'nazi_zombie_test', 'top[1]')
      eq(m.top[1].games, 2, 'demo game not counted')
      eq(m.top[1].time_ms, 30 * 60000, 'duration, else ended-started')
      eq(m.top[1].best_round, 12, 'best round per map')
      eq(m.recent[0].key, 'nazi_zombie_proftest', 'recent[0]')
    })

    check('profile: Overall counts real games, best round is Verified-only and names its game', () => {
      const o = profile.overallFor(PSID, { user: users.byId(PSID) })
      eq(o.games, 3, 'games')
      eq(o.rounds_played, 46, 'rounds')
      eq(o.time_ms, 80 * 60000, 'time')
      eq(o.best_round.round, 12, 'best round (the 30 was a custom game)')
      truthy(o.best_round.match_id, 'best round links to its game')
      truthy(o.member_since, 'member since')
    })

    check('profile: kills/downs/revives are omitted until a real game has ever recorded one', () => {
      // The demo game above carries 500 kills; it must not switch the stat on.
      const before = profile.overallFor(PSID)
      eq('kills' in before, !!profile.recordedStats().kills, 'kills shown iff recorded')
      db.prepare('UPDATE game_players SET kills=0, downs=0, revives=0 WHERE game_id IN (SELECT id FROM games WHERE COALESCE(demo,0)=0)').run()
      const off = profile.overallFor(PSID)
      eq(off.kills, undefined, 'kills with nothing recorded')
      eq(off.downs, undefined, 'downs with nothing recorded')
      eq(off.recorded.kills, false, 'recorded.kills')
      db.prepare("UPDATE game_players SET kills=7 WHERE steam_id=? AND game_id=(SELECT id FROM games WHERE match_id='prof_1')").run(PSID)
      eq(profile.overallFor(PSID).kills, 7, 'kills once recorded')
    })

    check('movement profile: switched off it answers "not found" and never fetches', () => {
      const mp = require('../server/lib/movementProfile')
      const prev = process.env.ZM_MOVEMENT_URL
      process.env.ZM_MOVEMENT_URL = 'off'
      try {
        eq(mp.enabled(), false, 'enabled')
        const f = mp.forPlayer(PSID)
        eq(f.found, false, 'found'); eq(f.banner, null, 'banner'); eq(f.profile_url, null, 'profile_url')
      } finally { if (prev === undefined) delete process.env.ZM_MOVEMENT_URL; else process.env.ZM_MOVEMENT_URL = prev }
    })

    await checkAsync('movement profile: the banner FILE is copied (magic bytes checked), only whitelisted fields kept', async () => {
      const http = require('http')
      const mp = require('../server/lib/movementProfile')
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40)])
      let bannerHits = 0
      const srv = http.createServer((req, res) => {
        res.shouldKeepAlive = false
        if (req.url === `/api/players/${PSID}/profile`) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ user: { steam_id: PSID, username: 'ProfTester', banner: `/banners/${PSID}-aaaaaaaaaaaa.webp`, banner_pos: 30, country: 'gb', avatar: 'https://x.invalid/y.jpg', email: 'nope@example.invalid' } }))
        }
        if (req.url === `/banners/${PSID}-aaaaaaaaaaaa.webp`) { bannerHits++; res.writeHead(200, { 'content-type': 'image/webp' }); return res.end(webp) }
        if (req.url === '/api/players/76561198000000322/profile') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ user: { steam_id: '76561198000000322', banner: '/etc/passwd' } })) }
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no such player"}')
      })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const prev = process.env.ZM_MOVEMENT_URL
      process.env.ZM_MOVEMENT_URL = `http://127.0.0.1:${srv.address().port}`
      try {
        const r1 = await mp.refresh(PSID)
        eq(r1.found, true, 'found')
        truthy(r1.banner && r1.banner.startsWith('/media/banners/'), 'served from our media dir')
        const f = mp.forPlayer(PSID)
        eq(f.banner_pos, 30, 'banner_pos'); eq(f.country, 'GB', 'country')
        truthy(fs.existsSync(path.join(mp.BANNER_DIR, path.basename(f.banner))), 'file on disk')
        const row = db.prepare('SELECT * FROM movement_profiles WHERE steam_id=?').get(PSID)
        eq(Object.keys(row).some((k) => /avatar|email/.test(k)), false, 'no avatar/email column')
        eq(JSON.stringify(row).includes('example.invalid'), false, 'no email anywhere in the row')
        await mp.refresh(PSID)
        eq(bannerHits, 1, 'an unchanged banner is not fetched twice')
        // A banner path that is not Movement's generated shape is never requested.
        const r2 = await mp.refresh('76561198000000322')
        eq(r2.banner, null, 'odd path refused')
        // Gone from Movement -> not found.
        const r3 = await mp.refresh('76561198000000399')
        eq(r3.found, false, 'missing player')
      } finally {
        if (prev === undefined) delete process.env.ZM_MOVEMENT_URL; else process.env.ZM_MOVEMENT_URL = prev
        // Close fetch's keep-alive sockets too, or libuv asserts on the process.exit below.
        srv.closeAllConnections()
        await new Promise((r) => srv.close(r))
        await new Promise((r) => setTimeout(r, 300))
      }
    })
  }

  // The Gaff-shaped page (2026-09-22 late) regroups the rows into small tabbed sections;
  // data/settingsLayout.js only places them. No mapping may fall off the page, or appear twice.
  const layout = await import('../client/src/data/settingsLayout.js')
  check('/settings layout: every WaW item is placed in exactly one little section, and each resets', () => {
    const seen = new Map()
    for (const g of layout.GROUPS) {
      truthy(layout.TABS.some((t) => t.id === g.tab), `${g.id} is in no tab`)
      for (const id of g.items) seen.set(id, (seen.get(id) || 0) + 1)
      const d = waw.defaultsFor(layout.groupItems(g))
      truthy(Object.keys(d.waw).length + Object.keys(d.wawBinds).length + Object.keys(d).length > 2, `${g.id} has no defaults`)
    }
    for (const it of waw.ALL) eq(seen.get(it.id), 1, `${it.id} is placed ${seen.get(it.id) || 0} times`)
    eq(seen.size, waw.ALL.length, 'a layout id that is not in the catalogue')
    // The regroup must not change what a reset writes: the union of the group resets is
    // exactly the old whole-catalogue defaults.
    const all = { waw: {}, wawBinds: {} }
    for (const g of layout.GROUPS) { const { waw: w, wawBinds: b, ...k } = waw.defaultsFor(layout.groupItems(g)); Object.assign(all, k); Object.assign(all.waw, w); Object.assign(all.wawBinds, b) }
    const ref = waw.allDefaults()
    const flat = (o) => JSON.stringify([...Object.entries(o).filter(([k]) => k !== 'waw' && k !== 'wawBinds'), ...Object.entries(o.waw).map(([k, v]) => ['waw.' + k, v]), ...Object.entries(o.wawBinds).map(([k, v]) => ['bind.' + k, v])].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    eq(flat(all), flat(ref), 'group resets differ from the catalogue defaults')
  })

  // ---- launcher 0.2.12: update chip, Download, installed maps ---------------
  const lf = await import('../client/src/components/launcherFormat.js')
  check('the update chip shows only an update there is, and Later hides every phase', () => {
    eq(lf.chipPhase(null), null)
    eq(lf.chipPhase({ phase: 'idle' }), null)
    eq(lf.chipPhase({ phase: 'up_to_date', current: '0.2.12' }), null)
    eq(lf.chipPhase({ phase: 'unreachable' }), null, 'a failed CHECK is not an update to offer')
    eq(lf.chipPhase({ phase: 'available', available: '0.2.13' }), 'available')
    eq(lf.chipPhase({ phase: 'downloading', available: '0.2.13', percent: 40 }), 'downloading')
    eq(lf.chipPhase({ phase: 'ready', downloaded: '0.2.13', canInstall: true }), 'ready')
    eq(lf.chipPhase({ phase: 'failed', available: '0.2.13' }), 'failed', 'a broken download offers Retry')
    for (const phase of ['available', 'downloading', 'ready']) eq(lf.chipPhase({ phase, available: '0.2.13', canInstall: true, later: true }), null)
  })
  check('sizes read as GB with one decimal and MB under 1 GB; the list sorts largest first', () => {
    eq(lf.fmtSize(1.5 * 1024 ** 3), '1.5 GB')
    eq(lf.fmtSize(1024 ** 3), '1.0 GB')
    eq(lf.fmtSize(543 * 1024 ** 2), '543 MB')
    eq(lf.fmtSize(0.4 * 1024 ** 2), '410 KB')
    eq(lf.clampPct(4300), 100); eq(lf.clampPct(-3), 0); eq(lf.clampPct(37.4), 37)
    const s = lf.bySizeDesc([{ bsp: 'a', bytes: 5 }, { bsp: 'b', bytes: 50 }, { bsp: 'c', bytes: 5 }])
    eq(s.map((m) => m.bsp).join(','), 'b,a,c')
  })
  check('the launcher bridge carries every call the 0.2.12 UI uses', () => {
    const pre = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher', 'src', 'preload', 'preload.cjs'), 'utf8')
    const ui = ['launcherBridge.js', 'UpdateChip.jsx', 'MapDownload.jsx', 'LauncherBoxes.jsx']
      .map((f) => fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'components', f), 'utf8')).join('\n')
    for (const n of ['updateNow', 'updateLater', 'restartAndUpdate', 'updateStatus', 'onUpdateStatus', 'mapState', 'installedMaps', 'removeMaps', 'onMapState', 'installMap', 'onMapProgress']) {
      truthy(new RegExp(`\\b${n}\\b`).test(ui), `the UI does not use ${n}`)
      truthy(new RegExp(`\\b${n}: `).test(pre), `preload.cjs has no ${n}`)
    }
    // The browser half: Download goes to /download like Play, through the play gate.
    truthy(/guard\(\{ map: mapKey/.test(ui), 'Download in a browser must go through the play gate')
    // The Update button and the Installed maps box sit in web-settings-2's ENW slot.
    const enwSec = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'components', 'settings', 'EnwSection.jsx'), 'utf8')
    truthy(/<LauncherUpdateBox \/>/.test(enwSec) && /<InstalledMapsBox \/>/.test(enwSec), 'EnwSection must render the update and installed-maps sections')
  })

  // ---- report ---------------------------------------------------------------
  for (const [s, n] of results) console.log(`${s}  ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* windows file lock */ }
  process.exit(fail ? 1 : 0)
}

// ── tools/wipe-demo.js ────────────────────────────────────────────────────────
// Driven against a database of its OWN, built by hand in a scratch directory: the wipe
// deletes every row of play on the site, and pointing it at this suite's database would
// take the fixtures out from under every check after it.
//
// The one behaviour worth a test more than any other is the BACKUP, and specifically that
// the backup holds the rows the wipe then removes. A backup taken after the delete, or a
// plain file copy that missed the write-ahead log, would both pass a "the file exists"
// assertion and be worth nothing.
function checkWipe() {
  const Database = require('better-sqlite3')
  const { wipe } = require('../tools/wipe-demo')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-wipe-'))

  const d = new Database(path.join(dir, 'zombies.db'))
  d.exec(`CREATE TABLE games (id INTEGER PRIMARY KEY, match_id TEXT, demo INTEGER);
          CREATE TABLE game_players (id INTEGER PRIMARY KEY, game_id INTEGER);
          CREATE TABLE records (id INTEGER PRIMARY KEY, steam_id TEXT);
          CREATE TABLE comments (id INTEGER PRIMARY KEY, body TEXT);
          CREATE TABLE playlists (id INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE users (steam_id TEXT PRIMARY KEY, approved INTEGER, is_admin INTEGER, deleted INTEGER DEFAULT 0,
                              level INTEGER, prestige INTEGER, xp_total INTEGER, active_ms INTEGER, pinned_badges TEXT);
          CREATE TABLE maps (key TEXT PRIMARY KEY, plays INTEGER, beaten_by INTEGER, thumbs_up INTEGER, thumbs_down INTEGER);
          CREATE TABLE badges (slug TEXT PRIMARY KEY);
          CREATE TABLE activity_log (id INTEGER PRIMARY KEY, event TEXT);`)
  // A "real" simulated game: demo = 0, exactly like the eight on the live database.
  d.prepare("INSERT INTO games (match_id, demo) VALUES ('m_6a2e3d99', 0)").run()
  d.prepare('INSERT INTO game_players (game_id) VALUES (1)').run()
  d.prepare("INSERT INTO records (steam_id) VALUES ('76561198126330106')").run()
  d.prepare("INSERT INTO comments (body) VALUES ('nice map')").run()
  d.prepare("INSERT INTO playlists (name) VALUES ('The stock four')").run()
  d.prepare("INSERT INTO users (steam_id, approved, is_admin, level, prestige, xp_total, active_ms, pinned_badges) VALUES ('76561198126330106', 1, 1, 6, 1, 41000, 9000, '[\"a\"]')").run()
  d.prepare("INSERT INTO users (steam_id, approved, is_admin, level) VALUES ('76561190000000001', 1, 1, 3)").run()
  d.prepare("INSERT INTO maps (key, plays, beaten_by, thumbs_up, thumbs_down) VALUES ('nazi_zombie_factory', 4, 2, 3, 1)").run()
  d.prepare("INSERT INTO badges (slug) VALUES ('map-nazi_zombie_factory')").run()
  d.prepare("INSERT INTO activity_log (event) VALUES ('box.key.pinned')").run()
  d.close()

  check('the wipe dry run touches nothing and still counts what would go', () => {
    const r = wipe({ dataDir: dir, dryRun: true })
    eq(r.backup, null, 'a dry run makes no backup')
    eq(r.before.games, 1, 'it counted the game')
    eq(fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).length, 0, 'no backup directory appeared')
    const c = new Database(path.join(dir, 'zombies.db'), { readonly: true })
    eq(c.prepare('SELECT COUNT(*) c FROM games').get().c, 1, 'the game is still there')
    c.close()
  })

  let backupDir = null
  check('the wipe backs the database up BEFORE it deletes, and the backup holds the rows', () => {
    const r = wipe({ dataDir: dir })
    backupDir = r.backup
    truthy(backupDir && fs.existsSync(backupDir), 'no backup directory')
    const b = new Database(path.join(backupDir, 'zombies.db'), { readonly: true })
    // This is the assertion the whole script hangs on. The backup is only a backup if it
    // holds what the wipe removed.
    eq(b.prepare('SELECT COUNT(*) c FROM games').get().c, 1, 'the backup lost the game')
    eq(b.prepare('SELECT COUNT(*) c FROM records').get().c, 1, 'the backup lost the record')
    eq(b.prepare('SELECT COUNT(*) c FROM users').get().c, 2, 'the backup lost the accounts')
    b.close()
  })

  check('it wipes every record of play and keeps the catalogue, the users and the flags', () => {
    const c = new Database(path.join(dir, 'zombies.db'), { readonly: true })
    for (const t of ['games', 'game_players', 'records', 'comments', 'playlists']) {
      eq(c.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c, 0, t + ' survived')
    }
    eq(c.prepare('SELECT COUNT(*) c FROM maps').get().c, 1, 'the map catalogue was kept')
    eq(c.prepare('SELECT COUNT(*) c FROM badges').get().c, 1, 'the badge definitions were kept')
    eq(c.prepare('SELECT COUNT(*) c FROM activity_log').get().c, 1, 'the audit trail was kept')
    // Real account kept with its admin flag; the reserved-range demo account gone.
    const u = c.prepare('SELECT * FROM users').all()
    eq(u.length, 1, 'wrong number of accounts left')
    eq(u[0].steam_id, '76561198126330106')
    eq(u[0].is_admin, 1, 'the admin flag was kept')
    // The denormalised half: counters on rows the deletes cannot reach. A map still
    // claiming "beaten by 2" with no game in the database is worse than the demo data was.
    eq(u[0].level, 1, 'the level survived the wipe')
    eq(u[0].xp_total, 0, 'the XP total survived the wipe')
    eq(u[0].pinned_badges, null, 'a pinned badge that no longer exists survived the wipe')
    const m = c.prepare('SELECT * FROM maps').get()
    eq(m.plays, 0, 'plays survived')
    eq(m.beaten_by, 0, 'beaten_by survived')
    eq(m.thumbs_up + m.thumbs_down, 0, 'the rating survived')
    c.close()
  })

  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* windows file lock */ }
}

main().catch((e) => { console.error(e); process.exit(1) })
