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
const bans = require('../server/lib/bans')
const chat = require('../server/lib/chatNetwork')
const tokens = require('../server/lib/tokens')
const achievements = require('../server/lib/achievements')
const { canonical } = require('../server/lib/util')

// ---- fixtures -------------------------------------------------------------------
function seedMinimal() {
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

  // ---- report ---------------------------------------------------------------
  for (const [s, n] of results) console.log(`${s}  ${n}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* windows file lock */ }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
