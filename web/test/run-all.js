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

  check('leasing again supersedes rather than stacking', () => {
    const b = boxes.byName('test-box')
    assignments.lease({ box: b, mapKey: 'nazi_zombie_test', players: [{ steamid: '76561198000000002' }] })
    const live = db.prepare("SELECT COUNT(*) c FROM assignments WHERE box_id=? AND state IN ('leased','ready','live')").get(b.id).c
    eq(live, 1)
  })

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

  // ── the wipe script, and the backup it refuses to skip ──────────────────────
  checkWipe()

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
