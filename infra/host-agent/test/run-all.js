#!/usr/bin/env node
// In-process checks for the rules and the format. No sockets, no child processes — those
// live in test/demo-network.js. Run with: node test/run-all.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Referee } from '../lib/referee.js'
import { ManifestStore, ManifestEvaluator, defaultManifest } from '../lib/manifests.js'
import { ReplayWriter, verifyFile, readFooter, readChunk, readEvents } from '../lib/replay.js'
import { issue, check, TokenGuard } from '../lib/tokens.js'
import * as keys from '../lib/keys.js'
import { mkdirp } from '../lib/util.js'

const TMP = mkdirp(path.join(os.tmpdir(), 'enw-host-tests'))
const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const manifests = new ManifestStore([path.join(REPO, 'referee', 'manifests')])

let pass = 0, fail = 0
const results = []
function t(name, fn) {
  try { fn(); pass++; results.push(['ok', name]); console.log(`\x1b[32m ok  \x1b[0m ${name}`) }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); console.log(`\x1b[31mFAIL \x1b[0m ${name}\n        ${e.message}`) }
}
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, what) { if (!c) throw new Error(what || 'expected truthy') }

const MIN = 60_000

function makeRef(opts = {}) {
  const cmds = []
  const r = new Referee({
    instanceId: 'test', matchId: 'm_test', mode: opts.mode || 'verified',
    manifest: opts.manifest || defaultManifest('nazi_zombie_prototype'),
    config: opts.config || {}, vip: opts.vip || false,
    log: { info() {}, warn() {}, debug() {}, error(e) { console.error(e) } },
  })
  r.on('command', (c) => cmds.push(c))
  r.cmds = cmds
  return r
}

function bootGame(r, { players = 1, map = 'nazi_zombie_prototype', t0 = 0 } = {}) {
  r.onEvent({ t: 'hello', ms: t0, instance: 'test', role: 'server', pid: 1 })
  r.onEvent({ t: 'map_loaded', ms: t0, map, mode: 'zombies', sv_maxclients: 4 })
  for (let i = 0; i < players; i++) {
    r.onEvent({ t: 'player_connect', ms: t0, slot: i, name: `P${i}`, steamid: `7656119800000000${i}` })
    r.onEvent({ t: 'player_spawn', ms: t0, slot: i })
  }
  r.onEvent({ t: 'round', ms: t0, n: 1 })
  return r
}

console.log('\n== manifests (enw.referee.manifest/0) ==')

t('a map with no manifest gets the built-in Round 20 default', () => {
  const m = manifests.get('nazi_zombie_totally_unknown')
  ok(m._default, 'should be the default manifest')
  eq(m.badge.round_n, 20)
})

t('Nacht (no EE, no ending) awards Round N only', () => {
  const e = new ManifestEvaluator(manifests.get('nazi_zombie_prototype'))
  e.feed({ t: 'notify', ent: 'level', name: 'enw_ee_complete' }, { round: 5 })
  eq(e.best(), null, 'a fabricated EE notify must not award on Nacht')
  e.feed({ t: 'round', n: 20 }, { round: 20 })
  eq(e.best().kind, 'round')
})

t('Der Riese: the EE needs its `requires` flag FIRST (ordering guard)', () => {
  const man = manifests.get('nazi_zombie_factory')
  // Out of order: the three sub-flags before hide_and_seek => no award.
  const bad = new ManifestEvaluator(man)
  for (const f of ['ee_exp_monkey', 'ee_bowie_bear', 'ee_perk_bear']) bad.feed({ t: 'notify', ent: 'level', name: f }, { round: 8 })
  eq(bad.best(), null, 'EE awarded without the requires flag')
  // In order.
  const good = new ManifestEvaluator(man)
  good.feed({ t: 'notify', ent: 'level', name: 'hide_and_seek' }, { round: 6 })
  for (const f of ['ee_exp_monkey', 'ee_bowie_bear', 'ee_perk_bear']) good.feed({ t: 'notify', ent: 'level', name: f }, { round: 8 })
  eq(good.best().kind, 'easter_egg')
  eq(good.badgeEarned().minted, true, 'Der Riese mints its badge on the EE')
})

t('Easter Egg outranks Round 20 whichever happens first', () => {
  const man = manifests.get('nazi_zombie_factory')
  const e = new ManifestEvaluator(man)
  e.feed({ t: 'round', n: 20 }, { round: 20 })
  eq(e.best().kind, 'round')
  e.feed({ t: 'notify', ent: 'level', name: 'hide_and_seek' }, { round: 21 })
  for (const f of ['ee_exp_monkey', 'ee_bowie_bear', 'ee_perk_bear']) e.feed({ t: 'notify', ent: 'level', name: f }, { round: 22 })
  eq(e.best().kind, 'easter_egg', 'priority 1 must beat priority 3')
})

t("nazi_zombie_ali: the 50k door is a decoy; level.tom_victory is the ending", () => {
  const e = new ManifestEvaluator(manifests.get('nazi_zombie_ali'))
  // The map's own 50,000-point zombie_door looks exactly like a buyable ending and is
  // not one (referee agent's scan). It must register as a SIGNAL and award nothing.
  e.feed({ t: 'notify', name: 'trigger', args: { targetname: 'zombie_door', zombie_cost: 50000 } }, { round: 9 })
  eq(e.best(), null, 'the decoy door must not award the ending')
  ok(e.seenSignals().includes('big_door'), 'but it is recorded as a signal')
  e.feed({ t: 'level_var', name: 'tom_victory', value: true }, { round: 9, levelVars: { tom_victory: true } })
  eq(e.best().kind, 'buyable_ending')
})

t('level_var also matches when the value arrives as GSC 1 rather than true', () => {
  const e = new ManifestEvaluator(manifests.get('nazi_zombie_ali'))
  e.feed({ t: 'level_var', name: 'tom_victory', value: 1 }, {})
  eq(e.best().kind, 'buyable_ending')
})

t('{"manual":true} never awards and is reported', () => {
  const e = new ManifestEvaluator({
    map: 'x', title: 'x', badge: { main_finish: 'easter_egg', round_n: 20 },
    finishes: [{ id: 'easter_egg', label: 'Unknown quest', priority: 1, when: { manual: true } }], signals: [],
  })
  for (const n of ['a', 'b', 'c']) e.feed({ t: 'notify', ent: 'level', name: n }, {})
  eq(e.best(), null)
  eq(e.manualFinishes, ['easter_egg'])
})

t('`count` needs n DISTINCT firings', () => {
  const e = new ManifestEvaluator({
    map: 'x', title: 'x', badge: { main_finish: 'easter_egg', round_n: 20 }, signals: [],
    finishes: [{ id: 'easter_egg', label: '6 pieces', priority: 1, when: { count: { of: { notify: { ent: 'any', name: 'piece' } }, n: 3 } } }],
  })
  e.feed({ t: 'notify', ent: 'level', name: 'piece', args: { i: 1 } }, {})
  e.feed({ t: 'notify', ent: 'level', name: 'piece', args: { i: 1 } }, {})   // the same one again
  eq(e.best(), null, 'repeats must not count')
  e.feed({ t: 'notify', ent: 'level', name: 'piece', args: { i: 2 } }, {})
  e.feed({ t: 'notify', ent: 'level', name: 'piece', args: { i: 3 } }, {})
  eq(e.best().kind, 'easter_egg')
})

console.log('\n== referee: cap, AFK, late join, pause ==')

t('24 h cap: warnings at 30/10/1 min then a clean end', () => {
  const r = makeRef({ config: { capMs: 60 * MIN, capWarnMs: [30 * MIN, 10 * MIN, 1 * MIN] } })
  bootGame(r)
  const warnings = []
  r.on('cap_warning', (w) => warnings.push(w.minutes))
  for (const min of [25, 31, 51, 55, 59.5, 61]) {
    r.onEvent({ t: 'round', ms: min * MIN, n: 2 + Math.floor(min) })
    r.tick()
  }
  eq(warnings, [30, 10, 1], 'warning schedule')
  ok(r.cmds.some((c) => c.t === 'end' && c.reason === 'time_cap'), 'an `end` command must be sent')
  ok(r.flags.has('cap_reached'), 'the game is flagged cap_reached')
  const says = r.cmds.filter((c) => c.t === 'say').map((c) => c.text)
  ok(says.some((s) => /30 minutes/.test(s)) && says.some((s) => /1 minute\b/.test(s)), 'players are told, in words')
})

t('a VIP lobby is uncapped', () => {
  const r = makeRef({ vip: true, config: { capMs: 60 * MIN } })
  bootGame(r)
  r.onEvent({ t: 'round', ms: 30 * 3600_000, n: 99 })
  r.tick()
  eq(r.cmds.filter((c) => c.t === 'end').length, 0, 'no end after 30 hours for a VIP game')
  eq(r.state().cap_ms, null)
})

t('AFK: warn at 10 min, kick at 15, and coming back clears it', () => {
  const r = makeRef({ config: { afkWarnMs: 10 * MIN, afkKickMs: 15 * MIN } })
  bootGame(r, { players: 2 })
  // Slot 1 keeps playing; slot 0 goes quiet.
  for (let m = 1; m <= 16; m++) {
    r.onEvent({ t: 'input', ms: m * MIN, slot: 1, moved: true, turned: true, buttons: 0 })
    r.tick()
  }
  const warned = r.cmds.filter((c) => c.t === 'tell' && c.slot === 0 && /AFK/.test(c.text))
  const kicked = r.cmds.filter((c) => c.t === 'kick' && c.slot === 0)
  eq(warned.length, 1, 'exactly one AFK warning')
  eq(kicked.length, 1, 'exactly one AFK kick')
  eq(r.cmds.filter((c) => c.t === 'kick' && c.slot === 1).length, 0, 'the active player is untouched')
  ok(r.flags.has('afk_kick'))
})

t('AFK: moving before the kick clears the warning', () => {
  const r = makeRef({ config: { afkWarnMs: 10 * MIN, afkKickMs: 15 * MIN } })
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 11 * MIN, n: 4 }); r.tick()
  ok(r.cmds.some((c) => c.t === 'tell' && /AFK/.test(c.text)), 'warned')
  r.onEvent({ t: 'input', ms: 12 * MIN, slot: 0, moved: true, turned: false, buttons: 0 }); r.tick()
  r.onEvent({ t: 'round', ms: 20 * MIN, n: 5 }); r.tick()
  eq(r.cmds.filter((c) => c.t === 'kick').length, 0, 'not kicked after coming back')
})

t('everyone AFK: the game pauses, then closes', () => {
  const r = makeRef({ config: { afkWarnMs: 2 * MIN, afkKickMs: 99 * MIN, allAfkPauseMs: 3 * MIN, allAfkCloseMs: 0 } })
  bootGame(r, { players: 2 })
  for (const m of [3, 5, 7, 9]) { r.onEvent({ t: 'round', ms: m * MIN, n: m }); r.tick() }
  ok(r.pauses.length > 0, 'the game paused')
  r.tick()
  eq(r.phase, 'over')
  ok(r.flags.has('all_afk'))
})

t('late joiners: the GAME is flagged and gets no records', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 5 * MIN, n: 7 })
  r.onEvent({ t: 'player_connect', ms: 5 * MIN + 10, slot: 1, name: 'Latecomer', steamid: '765611980000009' })
  ok(r.players.get(1).late, 'the player is marked late')
  ok(r.flags.has('late_join'), 'the game is flagged')
  ok(r.cmds.some((c) => c.t === 'tell' && c.slot === 1), 'they are told')
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 9, reason: 'end_game' })
  eq(r.summary().records_eligible, false, 'a late-join game must not be records-eligible')
})

t('joining within the grace window is not late', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'player_connect', ms: 10_000, slot: 1, name: 'OnTime', steamid: '76561198000009' })
  eq(r.players.get(1).late, false)
  ok(!r.flags.has('late_join'))
})

t('pause/resume: the game clock excludes paused time, RTA does not', () => {
  const r = makeRef()
  bootGame(r)
  r.onEvent({ t: 'round', ms: 10 * MIN, n: 5 })
  r.pause('operator')
  eq(r.phase, 'paused')
  ok(r.cmds.some((c) => c.t === 'pause'))
  const paused = r.pauses.at(-1)
  paused.at -= 5 * MIN                  // pretend five real minutes passed
  r.resume('operator')
  eq(r.phase, 'live')
  ok(r.pausedMs >= 5 * MIN, `pausedMs ${r.pausedMs}`)
  r.onEvent({ t: 'game_over', ms: 20 * MIN, round: 9, reason: 'end_game' })
  const s = r.summary()
  ok(s.duration_ms < s.duration_rta_ms, 'in-game time must be shorter than RTA when paused')
  ok(s.flags.includes('paused'))
})

t('solo crash: the whole game pauses for the grace window, then saves', () => {
  const r = makeRef({ config: { crashGraceMs: 0 } })
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 4 * MIN, n: 5 })
  r.onEvent({ t: 'player_disconnect', ms: 4 * MIN, slot: 0, reason: 'connection lost' })
  eq(r.phase, 'paused', 'a solo crash pauses rather than ending')
  r.tick()
  eq(r.phase, 'over')
  ok(r.flags.has('abandoned'))
  eq(r.summary().rounds, 5, 'the rounds reached are still saved')
})

t('a player who comes back inside the grace window resumes the game, after a countdown', () => {
  const r = makeRef({ config: { crashGraceMs: 10 * MIN, resumeCountdownMs: 10_000 } })
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 4 * MIN, n: 5 })
  r.onEvent({ t: 'player_disconnect', ms: 4 * MIN, slot: 0, reason: 'connection lost' })
  eq(r.phase, 'paused')
  r.onEvent({ t: 'player_connect', ms: 6 * MIN, slot: 0, name: 'P0', steamid: '76561198000000000' })
  // Not a jump cut: the freeze holds for the countdown so a player still on the loading
  // screen is not handed to a zombie.
  eq(r.phase, 'paused', 'still frozen during the resume countdown')
  ok(r.cmds.some((c) => c.t === 'say' && /Resuming in 10 seconds/.test(c.text)), 'players are counted down')
  r.resumeAt = Date.now() - 1
  r.tick()
  eq(r.phase, 'live')
  ok(r.flags.has('resumed'), 'the game is tagged Resumed')
  eq(r.players.get(0).reconnects, 1)
  eq(r.players.size, 1, 'the returning player is the same person, not a new slot')
})

t('a returning player is matched on SteamID even in a different slot', () => {
  const r = makeRef({ config: { crashGraceMs: 10 * MIN } })
  bootGame(r, { players: 2 })
  r.onEvent({ t: 'points', ms: 1000, slot: 1, score: 7250, delta: 60, why: 'kill' })
  r.onEvent({ t: 'player_disconnect', ms: 2 * MIN, slot: 1, reason: 'lost' })
  // Slot 1 freed and reused; they come back in slot 3.
  r.onEvent({ t: 'player_connect', ms: 3 * MIN, slot: 3, name: 'P1', steamid: '76561198000000001' })
  eq(r.players.size, 2, 'no ghost player was created')
  eq(r.players.get(3).steamid, '76561198000000001')
  eq(r.players.get(3).score, 7250, 'their score came with them')
  eq(r.players.get(1), undefined, 'the old slot is gone')
})

t('crash recovery: state is asked for on the drop and handed back on return', () => {
  const r = makeRef({ mode: 'custom', config: { crashGraceMs: 10 * MIN, resumeCountdownMs: 0 } })
  bootGame(r, { players: 2 })
  const wanted = []
  const restores = []
  r.on('snapshot_wanted', (x) => wanted.push(x))
  r.on('restore_wanted', (x) => restores.push(x))
  r.onEvent({ t: 'player_disconnect', ms: 2 * MIN, slot: 1, reason: 'lost' })
  eq(wanted.length, 1, 'the host is asked for a snapshot the moment they drop')
  eq(wanted[0].steamid, '76561198000000001')
  // The host answers with what the game gave back.
  r.holdState('76561198000000001', { score: 9000, weapon: 'wunderwaffe', perks: ['jugg', 'speed'], pos: [10, 20, 32], limited_weapons_held: ['wunderwaffe'] })
  eq(r.reservedWeapons(), [{ steamid: '76561198000000001', weapon: 'wunderwaffe' }], 'the Waffe stays reserved while they are away')
  r.onEvent({ t: 'player_connect', ms: 4 * MIN, slot: 1, name: 'P1', steamid: '76561198000000001' })
  eq(restores.length, 1, 'their state is handed back')
  eq(restores[0].state.score, 9000)
  eq(restores[0].state.weapon, 'wunderwaffe')
  eq(r.reservedWeapons(), [], 'and the reservation is released')
  ok(r.flags.has('resumed'))
})

t('a record game pauses but never restores', () => {
  const r = makeRef({ mode: 'verified', config: { crashGraceMs: 10 * MIN } })
  r.recordProfile = 'ZWR-WaW-2025-09'
  bootGame(r, { players: 2 })
  const wanted = []; const restores = []
  r.on('snapshot_wanted', (x) => wanted.push(x))
  r.on('restore_wanted', (x) => restores.push(x))
  r.onEvent({ t: 'player_disconnect', ms: 2 * MIN, slot: 1, reason: 'lost' })
  eq(wanted.length, 0, 'a record game does not even ask for the state')
  r.holdState('76561198000000001', { score: 9000 })
  r.onEvent({ t: 'player_connect', ms: 3 * MIN, slot: 1, name: 'P1', steamid: '76561198000000001' })
  eq(restores.length, 0, 'restoring by hand is not vanilla and would void the run')
  ok(r.cmds.some((c) => c.t === 'tell' && /record game/.test(c.text)), 'and they are told why')
})

t('held state goes stale when the grace window passes', () => {
  const r = makeRef({ config: { crashGraceMs: 1 } })
  bootGame(r, { players: 2 })
  r.holdState('76561198000000001', { score: 100 })
  const h = r.held.get('76561198000000001')
  h.wall -= 60_000
  eq(r.stateFor('76561198000000001'), null, 'a stale snapshot is not handed back')
})

t('the summary is the row the website stores', () => {
  const r = makeRef({ manifest: manifests.get('nazi_zombie_factory'), mode: 'custom' })
  bootGame(r, { players: 2, map: 'nazi_zombie_factory' })
  r.onEvent({ t: 'notify', ms: 1000, ent: 'level', name: 'electricity_on' })
  r.onEvent({ t: 'points', ms: 2000, slot: 0, score: 4300, delta: 60, why: 'kill' })
  r.onEvent({ t: 'down', ms: 3000, slot: 1 })
  r.onEvent({ t: 'revive', ms: 4000, slot: 1, by: 0 })
  r.onEvent({ t: 'round', ms: 30 * MIN, n: 22 })
  r.onEvent({ t: 'game_over', ms: 31 * MIN, round: 22, reason: 'end_game' })
  const s = r.summary()
  eq(s.map, 'nazi_zombie_factory'); eq(s.rounds, 22); eq(s.mode, 'custom')
  eq(s.finish.kind, 'round'); eq(s.xp_multiplier, 0.25, 'Custom games are 25% XP')
  eq(s.players.length, 2); eq(s.players[0].score, 4300); eq(s.players[1].downs, 1); eq(s.players[0].revives, 1)
  ok(s.signals.includes('power_on'), 'the power-on signal is recorded')
  ok(s.duration_ms > 0 && s.ended_at && s.started_at)
})

console.log('\n== invite tokens ==')

const site = keys.loadOrCreate(path.join(TMP, 'site-key.json'))
const other = keys.loadOrCreate(path.join(TMP, 'forger-key.json'))

t('a valid token joins', () => {
  const tok = issue(site.privateKey, { steamid: '76561198000000001', matchId: 'm_1' })
  const r = check(site.publicKey, tok, { matchId: 'm_1', steamid: '76561198000000001' })
  eq(r.ok, true); eq(r.reason, 'ok')
})

t('a token signed by someone else is refused', () => {
  const forged = issue(other.privateKey, { steamid: '76561198000000001', matchId: 'm_1' })
  eq(check(site.publicKey, forged, { matchId: 'm_1' }).reason, 'bad_signature')
})

t('an edited payload is refused (the signature covers it)', () => {
  const tok = issue(site.privateKey, { steamid: '76561198000000001', matchId: 'm_1' })
  const [b, s] = tok.split('.')
  const p = JSON.parse(Buffer.from(b, 'base64url').toString())
  p.sid = '76561198000009999'                                    // promote a different player
  const edited = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${s}`
  eq(check(site.publicKey, edited, { matchId: 'm_1' }).reason, 'bad_signature')
})

t('an expired token is refused', () => {
  const tok = issue(site.privateKey, { steamid: '1', matchId: 'm_1', ttlMs: 1000, now: Date.now() - 600_000 })
  eq(check(site.publicKey, tok, { matchId: 'm_1' }).reason, 'expired')
})

t("a token for another match is refused", () => {
  const tok = issue(site.privateKey, { steamid: '1', matchId: 'm_other' })
  eq(check(site.publicKey, tok, { matchId: 'm_1' }).reason, 'wrong_match')
})

t('a token for another player is refused', () => {
  const tok = issue(site.privateKey, { steamid: '111', matchId: 'm_1' })
  eq(check(site.publicKey, tok, { matchId: 'm_1', steamid: '222' }).reason, 'wrong_steamid')
})

t('a re-used token is refused (single use per boot)', () => {
  const g = new TokenGuard(site.publicKey)
  const tok = issue(site.privateKey, { steamid: '333', matchId: 'm_1' })
  eq(g.admit({ slot: 0, steamid: '333', token: tok }, 'm_1').allow, true)
  eq(g.admit({ slot: 1, steamid: '333', token: tok }, 'm_1').reason, 'replayed')
})

t('no token, and no site key, both FAIL CLOSED when checks are required', () => {
  eq(new TokenGuard(site.publicKey).admit({ slot: 0, steamid: '1' }, 'm_1'), { allow: false, reason: 'invite_required' })
  eq(new TokenGuard(null).admit({ slot: 0, steamid: '1', token: 'x.y' }, 'm_1'), { allow: false, reason: 'server_not_ready' })
})

t('garbage tokens do not crash the guard', () => {
  const g = new TokenGuard(site.publicKey)
  for (const bad of ['', 'x', 'a.b', '....', 'null', Buffer.alloc(9000).toString('base64url') + '.zz', '$%^&.*()']) {
    const r = g.admit({ slot: 0, steamid: '1', token: bad }, 'm_1')
    eq(r.allow, false, `"${String(bad).slice(0, 12)}" must be refused`)
  }
})

console.log('\n== replay format ==')

const hostKey = keys.loadOrCreate(path.join(TMP, 'host-key.json'))

function writeSample(file, { events = 5000, chunkMs = 1000 } = {}) {
  const w = new ReplayWriter({
    file, header: { match_id: 'm_sample', map: 'nazi_zombie_factory', mode: 'verified' },
    privateKey: hostKey.privateKey, pub: hostKey.pub, keyId: hostKey.keyId, chunkMs,
  })
  for (let i = 0; i < events; i++) {
    w.append({ t: 'snap', ms: i * 50, players: [{ slot: 0, pos: [i * 1.5, -i * 0.7, 32], ang: [0, i % 360], health: 100, score: i, weapon: 'mp40', stance: 'stand', alive: true }] })
  }
  return { w, stats: w.close({ summary: { rounds: 12 } }) }
}

const sample = path.join(TMP, 'sample.enwr')
const { stats } = writeSample(sample)

t('a fresh replay verifies', () => {
  const v = verifyFile(sample)
  ok(v.ok, v.errors.join('; '))
  eq(v.events, stats.events)
  ok(v.chunks > 3, 'the sample should span several chunks')
})

t('the signing key is pinned when asked', () => {
  ok(verifyFile(sample, { expectPub: hostKey.pub }).ok)
  const v = verifyFile(sample, { expectPub: keys.exportPair(keys.generate()).pub })
  ok(!v.ok && v.errors.some((e) => /unexpected key/.test(e)), 'a different expected key must fail')
})

t('flipping one byte inside a chunk breaks the chain', () => {
  const f = path.join(TMP, 'tampered-body.enwr')
  fs.copyFileSync(sample, f)
  const { footer } = readFooter(f)
  const target = footer.chunks[1]
  const fd = fs.openSync(f, 'r+')
  const b = Buffer.alloc(1); const at = target.off + 9 + 20
  fs.readSync(fd, b, 0, 1, at); b[0] ^= 1; fs.writeSync(fd, b, 0, 1, at); fs.closeSync(fd)
  const v = verifyFile(f)
  ok(!v.ok, 'a tampered chunk must not verify')
  ok(v.errors.some((e) => /chunk 1: content hash/.test(e)))
  ok(v.errors.some((e) => /chain/.test(e)), 'and the chain must break too')
})

t('editing the header breaks verification', () => {
  const f = path.join(TMP, 'tampered-head.enwr')
  const buf = fs.readFileSync(sample)
  const i = buf.indexOf(Buffer.from('nazi_zombie_factory'))
  ok(i > 0, 'map name should be in the header')
  buf[i] = 'N'.charCodeAt(0)
  fs.writeFileSync(f, buf)
  const v = verifyFile(f)
  ok(!v.ok && v.errors.some((e) => /header hash/.test(e)), v.errors.join('; '))
})

t('re-signing a tampered file with a different key is still detectable', () => {
  // The attacker owns a key but not OURS. The file verifies against its own embedded key,
  // so integrity alone is not enough — this is why the site pins the box's public key.
  const f = path.join(TMP, 'resigned.enwr')
  const attacker = keys.loadOrCreate(path.join(TMP, 'attacker.enwr.json'))
  const w = new ReplayWriter({ file: f, header: { match_id: 'm_sample', map: 'nazi_zombie_factory', mode: 'verified' }, privateKey: attacker.privateKey, pub: attacker.pub, keyId: attacker.keyId, chunkMs: 1000 })
  w.append({ t: 'round', ms: 0, n: 115 })
  w.close()
  ok(verifyFile(f).ok, 'internally consistent')
  ok(!verifyFile(f, { expectPub: hostKey.pub }).ok, 'but not signed by the box that claims to have run it')
})

t('a truncated file is detected', () => {
  const f = path.join(TMP, 'truncated.enwr')
  const buf = fs.readFileSync(sample)
  fs.writeFileSync(f, buf.subarray(0, buf.length - 200))
  const v = verifyFile(f)
  ok(!v.ok, 'a truncated replay must not verify')
})

t('chunks are seekable by their index entry alone', () => {
  const { footer } = readFooter(sample)
  const mid = footer.chunks[2]
  const c = readChunk(sample, mid)
  eq(c.events.length, mid.n)
  ok(c.events[0].ms >= mid.t0 && c.events.at(-1).ms <= mid.t1, 'the chunk covers its declared time range')
  // Byte range a browser would ask R2 for:
  ok(mid.off > 0 && mid.len > 0)
})

t('every event comes back out in order', () => {
  let n = 0, lastMs = -1
  for (const ev of readEvents(sample)) { ok(ev.ms >= lastMs, 'out of order'); lastMs = ev.ms; n++ }
  eq(n, stats.events)
})

t('a 60-second chunk boundary is honoured', () => {
  const f = path.join(TMP, 'chunking.enwr')
  const w = new ReplayWriter({ file: f, header: { match_id: 'c' }, privateKey: hostKey.privateKey, pub: hostKey.pub, keyId: hostKey.keyId, chunkMs: 60_000 })
  for (let ms = 0; ms < 5 * 60_000; ms += 50) w.append({ t: 'snap', ms, players: [] })
  const s = w.close()
  eq(s.chunks, 5, 'five minutes of game time => five 60-second chunks')
  ok(verifyFile(f).ok)
})


// ---- identity: what a steamid is worth, and where that is enforced ---------------------
// game-link-v0 `game_over`.`identity`, referee.md §13.2. The rule the site leans on is that
// an account reaches a RESULT only when somebody checked the signature, and `summary()` is
// the only place on the host side where that gate exists.
function identityGame(r, { identity, reason = null, steamid = '76561190000000001', reportedRow = undefined }) {
  r.onEvent({ t: 'map_loaded', ms: 0, map: 'nazi_zombie_prototype', mode: 'zombies', sv_maxclients: 4 })
  r.onEvent({ t: 'player_connect', ms: 10, slot: 0, name: 'Subject', steamid, identity: 'claimed', token: 't', party_slot: 0 })
  r.setIdentity(0, identity, reason)
  r.onEvent({ t: 'player_spawn', ms: 20, slot: 0 })
  r.onEvent({ t: 'round', ms: 20, n: 1 })
  r.onEvent({ t: 'game_over', ms: 60_000, round: 1, reason: 'end_game', ...(reportedRow === undefined ? {} : { players: [reportedRow] }) })
  return r.summary().players[0]
}

t('a VERIFIED player carries their steamid into the result', () => {
  const p = identityGame(makeRef(), {
    identity: 'verified', reason: 'ok',
    reportedRow: { slot: 0, name: 'Subject', identity: 'verified', steamid: '76561190000000001', connected: true, score: 500, score_total: 500, downs: 0, revives: 0, alive: true },
  })
  eq(p.identity, 'verified')
  eq(p.steamid, '76561190000000001')
  eq(p.party_slot, 0)
})

t('a CLAIMED row posts through with no steamid', () => {
  // A token was presented and parsed and nothing checked the signature. Attendance, not an
  // account: the site records the name in summary_json and creates no game_players row.
  const p = identityGame(makeRef(), {
    identity: 'claimed', reason: 'token_check_disabled', steamid: '76561190000000002',
    reportedRow: { slot: 0, name: 'Subject', identity: 'claimed', connected: true, score: 500, score_total: 500, downs: 0, revives: 0, alive: true },
  })
  eq(p.identity, 'claimed')
  eq(p.steamid, null, 'an unchecked claim must never reach the result as an account')
  eq(p.claimed_steamid, '76561190000000002', 'but what it claimed is still recorded')
  eq(p.name, 'Subject', 'and they are still on the sheet')
})

t('a REFUSED row posts through with no steamid either, and says why', () => {
  const p = identityGame(makeRef(), {
    identity: 'refused', reason: 'bad_signature', steamid: '76561190000000009',
    reportedRow: { slot: 0, name: 'Subject', identity: 'refused', identity_reason: 'bad_signature', connected: false, score: 0, score_total: 0, downs: 0, revives: 0, alive: false },
  })
  eq(p.identity, 'refused')
  eq(p.steamid, null)
  eq(p.identity_reason, 'bad_signature')
})

t('token_check_disabled is an admission, not a check, so it promotes nothing', () => {
  // With no `players` on the game_over at all, the host falls back to its own fold — and
  // the gate must still hold.
  const p = identityGame(makeRef(), { identity: 'claimed', reason: 'token_check_disabled', steamid: '76561190000000003' })
  eq(p.identity, 'claimed')
  eq(p.steamid, null, 'an admission is not a check')
})

t('a player the GAME reports and we never saw is carried through with no account', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'game_over', ms: 60_000, round: 1, reason: 'end_game', players: [
    { slot: 0, name: 'P0', identity: 'verified', steamid: '76561198000000000', connected: true, score: 0, score_total: 0, downs: 0, revives: 0, alive: true },
    { slot: 3, name: 'Ghost', identity: 'claimed', connected: false, score: 0, score_total: 0, downs: 0, revives: 0, alive: false },
  ] })
  const s = r.summary()
  const ghost = s.players.find((x) => x.name === 'Ghost')
  ok(ghost, 'the row is carried through rather than dropped')
  eq(ghost.steamid, null)
  eq(ghost.unseen_on_link, true)
  ok(s.flags.includes('result_mismatch'), 'and the disagreement is flagged')
})

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
if (fail) { for (const [s, n, m] of results) if (s === 'FAIL') console.log(`  FAIL ${n}: ${m}`) }
process.exit(fail ? 1 : 0)
