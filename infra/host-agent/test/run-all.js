#!/usr/bin/env node
// In-process checks for the rules and the format. No sockets, no child processes — those
// live in test/demo-network.js. Run with: node test/run-all.js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Referee } from '../lib/referee.js'
import { ManifestStore, ManifestEvaluator, defaultManifest } from '../lib/manifests.js'
import { ReplayWriter, verifyFile, readFooter, readChunk, readEvents } from '../lib/replay.js'
import { issue, check, TokenGuard, checkBinding } from '../lib/tokens.js'
import { BootQueue } from '../lib/bootqueue.js'
import { ramPlan, parseMeminfo, MB } from '../lib/memguard.js'
import * as keys from '../lib/keys.js'
import { mkdirp } from '../lib/util.js'
import { InstanceManager, devKnobsFor, safeLeaseDvars } from '../lib/instances.js'
import { leaseList, planLeases } from '../lib/leases.js'
import { SERVER_RULES, RULESET, effectiveFps } from '../lib/verified.js'
import { contactSummary } from '../tools/replay-contact.js'

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

t('a solo crash hold is not ended by the two-minute empty close (B: resumable for ten minutes)', () => {
  const r = makeRef({ mode: 'custom' })
  eq(r.cfg.crashGraceMs, 10 * MIN, 'the default grace is the site\'s resume window')
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'player_disconnect', ms: 3 * MIN, slot: 0, reason: 'connection lost' })
  eq(r.phase, 'paused')
  r.emptySinceMs = Date.now() - 5 * MIN        // five minutes with nobody connected
  r.tick()
  eq(r.phase, 'paused', 'still held, not closed as empty')
  r.crashGraceUntil = Date.now() - 1           // the grace window runs out
  r.tick()
  eq(r.phase, 'over')
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

t('zombie yaw, the nade list and explode survive the signed container (replay.md 8.4, 8.6)', () => {
  const f = path.join(TMP, 'nades.enwr')
  const w = new ReplayWriter({ file: f, header: { match_id: 'm_nades', map: 'nazi_zombie_prototype', mode: 'verified' }, privateKey: hostKey.privateKey, pub: hostKey.pub, keyId: hostKey.keyId, chunkMs: 1000 })
  w.append({ t: 'snap', ms: 0, zombies_alive: 1, zombies: [{ id: 40, pos: [1, 2, 3], yaw: 91.5, health: 150 }], nades: [{ id: 300, pos: [4, 5, 6] }] })
  w.append({ t: 'explode', ms: 100, id: 300, pos: [4, 5, 7] })
  w.close()
  ok(verifyFile(f, { expectPub: hostKey.pub }).ok, 'verifies')
  const ev = [...readEvents(f)]
  eq(ev[0].zombies[0].yaw, 91.5)
  eq(ev[0].nades[0].id, 300)
  eq(ev[1].t, 'explode')
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

console.log('\n== stats: the game\'s own scoreboard counters (referee.md §16, bug 7) ==')

// The exact sequence the §16 DLL sends for one real player: a baseline `stats` at connect,
// `points` on every score change, `down` + `player_down` then `stats` on a down, `revive`
// then `stats` on a revive, and `stats` on every kill. Every real result said 0 before
// this, because nothing on the link carried a kill and `points` carries no `why`.
function statsGame(r) {
  bootGame(r, { players: 2 })
  r.onEvent({ t: 'stats', ms: 1000, slot: 0, score: 500, kills: 0, headshots: 0, downs: 0, revives: 0, assists: 0 })
  r.onEvent({ t: 'points', ms: 1000, slot: 0, score: 500 })
  for (let k = 1; k <= 6; k++) {
    r.onEvent({ t: 'points', ms: 2000 + k, slot: 0, score: 500 + k * 60, delta: 60 })
    r.onEvent({ t: 'stats', ms: 2000 + k, slot: 0, score: 500 + k * 60, kills: k, headshots: k > 4 ? k - 4 : 0, downs: 0, revives: 0, assists: 0 })
  }
  r.onEvent({ t: 'down', ms: 3000, slot: 1 })
  r.onEvent({ t: 'player_down', ms: 3000, slot: 1, name: 'P1', round: 1, downs: 1 })
  r.onEvent({ t: 'stats', ms: 3000, slot: 1, score: 500, kills: 0, headshots: 0, downs: 1, revives: 0, assists: 0 })
  r.onEvent({ t: 'revive', ms: 4000, slot: 1, by: 0 })
  r.onEvent({ t: 'stats', ms: 4000, slot: 0, score: 860, kills: 6, headshots: 2, downs: 0, revives: 1, assists: 0 })
}

t('stats folds kills and headshots, and a down/revive edge plus its absolute value count once', () => {
  const r = makeRef()
  statsGame(r)
  const p0 = r.players.get(0), p1 = r.players.get(1)
  eq(p0.kills, 6, 'kills'); eq(p0.headshots, 2, 'headshots'); eq(p0.revives, 1, 'revives: the edge then the absolute value')
  eq(p1.downs, 1, 'downs: the edge then the absolute value')
  eq(p0.maxScore, 860, 'score from points'); eq(p0.pointsEarned, 360, 'points earned from the deltas')
})

t('the summary carries the reconciled counters in BOTH the row and its stats block', () => {
  const r = makeRef()
  statsGame(r)
  // The game's own result says one more kill than the link folded (it landed in the frame
  // of game over): the reconciled value is the game's, in the row AND in `stats`, which is
  // the block web/server/lib/results.js reads first.
  r.onEvent({ t: 'game_over', ms: 5000, round: 1, reason: 'end_game', kills_total: 7, players: [
    { slot: 0, name: 'P0', steamid: '76561198000000000', identity: 'verified', score: 860, downs: 0, revives: 1, kills: 7, headshots: 2, assists: 0, alive: true },
    { slot: 1, name: 'P1', steamid: '76561198000000001', identity: 'verified', score: 500, downs: 1, revives: 0, kills: 0, headshots: 0, assists: 0, alive: false },
  ] })
  const s = r.summary()
  const p0 = s.players.find((x) => x.slot === 0)
  eq(p0.kills, 7, 'row kills'); eq(p0.stats.kills, 7, 'stats kills')
  eq(p0.headshots, 2); eq(p0.stats.headshots, 2)
  eq(p0.revives, 1); eq(p0.stats.revives, 1)
  eq(p0.score, 860)
  const p1 = s.players.find((x) => x.slot === 1)
  eq(p1.downs, 1); eq(p1.stats.downs, 1)
  eq(s.reported.kills_total, 7)
  ok(s.flags.includes('result_mismatch'), 'game > ours on kills is still flagged, as for every counter')
})

t('a game_over from a DLL without native stats leaves kills_total null, not 0', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'game_over', ms: 5000, round: 1, reason: 'end_game', players: [{ slot: 0, name: 'P0', revives: 0, alive: true }] })
  eq(r.summary().reported.kills_total, null)
})

console.log('\n== player_down (the system-line event, game-link-v0 2026-09-23) ==')

t('player_down does NOT double-count a down: `down` is the counter, it is the sentence', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 1000, n: 30 })
  r.onEvent({ t: 'down', ms: 2000, slot: 0 })
  r.onEvent({ t: 'player_down', ms: 2000, slot: 0, name: 'P0', round: 30, map: 'nazi_zombie_prototype', downs: 1 })
  eq(r.players.get(0).downs, 1, 'one edge, one down')
})

t('an unknown-to-the-referee event is still counted and still re-emitted for the bridge', () => {
  // The protocol rule is "unknown `t` values are ignored", and the host's referee has no
  // ev_player_down. Ignored must mean "changes no ruling", NOT "dropped": the event is
  // evidence, it goes into the replay, and the host bridges it to the site's chat ring.
  const r = makeRef()
  bootGame(r, { players: 1 })
  const before = r.events
  const seen = []
  r.on('event', (e) => seen.push(e.t))
  r.onEvent({ t: 'player_down', ms: 2000, slot: 0, name: 'P0', round: 5, map: 'x' })
  ok(r.events === before + 1, 'counted')
  ok(seen.includes('player_down'), 'and re-emitted for the host to bridge')
})

t('player_down carries what a sentence needs and no account', () => {
  // The shape the site formats from. A steamid is NOT on this event by design: the host
  // takes identity from the roster it already holds, and `game-link-v0` says a steamid
  // travels only on a verified row.
  const ev = { t: 'player_down', ms: 1, slot: 2, name: 'jamie', round: 30, map: 'nazi_zombie_asylum', downs: 3 }
  ok(ev.name && Number.isFinite(ev.round) && ev.map, 'name, round and map')
  eq(ev.steamid, undefined, 'and no account on the wire')
})



console.log('\n== the players\' pause (pause_state / ui, referee.md §15, 2026-09-22) ==')

t('a solo Esc pause from the game is accounted, and nothing is sent back to the game', () => {
  const r = makeRef()
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 5 * MIN, n: 4 })
  r.onEvent({ t: 'ui', ms: 5 * MIN, slot: 0, ui: 'paused', pchat: true })
  r.onEvent({ t: 'pause_state', ms: 5 * MIN, paused: true, reason: 'solo_menu', players: 1 })
  eq(r.phase, 'paused')
  eq(r.pauseSource, 'game')
  eq(r.pauseReason, 'pause menu')
  ok(!r.cmds.some((c) => c.t === 'pause'), 'a `pause` back would become a host hold the player could never release')
  ok(!r.cmds.some((c) => c.t === 'say'), 'and the solo player is not told what he just did')
  eq(r.state().players[0].ui, 'paused')
  r.pauses.at(-1).at -= 3 * MIN
  r.onEvent({ t: 'pause_state', ms: 8 * MIN, paused: false, reason: 'none', players: 1, held_ms: 180000 })
  eq(r.phase, 'live')
  ok(!r.cmds.some((c) => c.t === 'resume'))
  ok(r.pausedMs >= 3 * MIN, `pausedMs ${r.pausedMs}`)
  r.onEvent({ t: 'game_over', ms: 20 * MIN, round: 9, reason: 'end_game' })
  const s = r.summary()
  ok(s.duration_ms <= s.duration_rta_ms - 3 * MIN, 'the players\' pause is excluded from in-game time like any other')
  eq(s.records_eligible, true, 'pausing does not cost a Verified run its records')
})

t('the game echoing our own hold (reason host) changes nothing', () => {
  const r = makeRef()
  bootGame(r)
  r.pause('operator')
  const n = r.pauses.length
  r.onEvent({ t: 'pause_state', ms: 1000, paused: true, reason: 'host', players: 1 })
  eq(r.pauses.length, n, 'no second pause')
  r.onEvent({ t: 'pause_state', ms: 2000, paused: false, reason: 'none', players: 1 })
  eq(r.phase, 'paused', 'the game cannot release a host pause by reporting')
  r.resume('operator')
  eq(r.phase, 'live')
})

t('host hold released while the players still want a pause: one clean hand-over', () => {
  const r = makeRef()
  bootGame(r)
  r.pause('operator')
  r.resume('operator')
  // The DLL is still frozen because its solo player sits in the menu: it re-reports.
  r.onEvent({ t: 'pause_state', ms: 3000, paused: true, reason: 'solo_menu', players: 1 })
  eq(r.phase, 'paused')
  eq(r.pauseSource, 'game')
})

t('a freeze during the load is shown, not accounted (no in-game time to exclude yet)', () => {
  const r = makeRef()
  r.onEvent({ t: 'hello', ms: 0, instance: 'test', role: 'server', pid: 1 })
  r.onEvent({ t: 'map_loaded', ms: 0, map: 'nazi_zombie_prototype', mode: 'zombies', sv_maxclients: 4 })
  r.onEvent({ t: 'pause_state', ms: 100, paused: true, reason: 'solo_menu', players: 1 })
  eq(r.phase, 'loading')
  eq(r.pauses.length, 0)
  ok(r.state().game_pause, 'but the dashboard/site can still say PAUSED')
})

t('the players\' pause gives way to the crash pause when the last one leaves', () => {
  const r = makeRef({ config: { crashGraceMs: 10 * MIN } })
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'round', ms: 2 * MIN, n: 3 })
  r.onEvent({ t: 'pause_state', ms: 2 * MIN, paused: true, reason: 'solo_menu', players: 1 })
  eq(r.pauseSource, 'game')
  r.onEvent({ t: 'player_disconnect', ms: 3 * MIN, slot: 0, reason: 'connection lost' })
  eq(r.phase, 'paused')
  eq(r.pauseSource, 'host', 'now OUR hold, so the grace window and the resume countdown apply')
  ok(r.flags.has('crash_pause'))
  ok(r.cmds.some((c) => c.t === 'pause'), 'and the game is told to hold')
  eq(r.pauses.length, 2, 'two accounted windows, back to back')
  // The DLL's own report that its players' pause ended must not undo our hold.
  r.onEvent({ t: 'pause_state', ms: 3 * MIN, paused: false, reason: 'none', players: 0 })
  eq(r.phase, 'paused')
})

t('a long pause does not come back as an AFK warning', () => {
  const r = makeRef()
  bootGame(r, { players: 2 })
  r.onEvent({ t: 'round', ms: 1 * MIN, n: 2 })
  r.onEvent({ t: 'pause_state', ms: 1 * MIN, paused: true, reason: 'all_menu', players: 2 })
  eq(r.pauseReason, 'everyone paused')
  r.pauses.at(-1).at -= 30 * MIN          // thirty real minutes in the menu, no ceiling
  r.onEvent({ t: 'pause_state', ms: 31 * MIN, paused: false, reason: 'none', players: 2 })
  eq(r.phase, 'live')
  r.tickAfk(31 * MIN)
  ok(!r.players.get(0).afkWarned && !r.players.get(1).afkWarned, 'nobody is AFK-warned for having paused')
})

// ---- the Verified environment (2026-09-23, lib/verified.js, verified-rules.md) -----------
console.log('\n== the Verified environment ==')

// The stock values a real dedicated server printed (verified-rules.md §3).
function stockServer(r, ms = 0) {
  for (const [name, value] of Object.entries(SERVER_RULES)) r.onEvent({ t: 'dvar', ms, name, value })
  r.onEvent({ t: 'dvar', ms, name: 'sv_fps', value: '20' })
  r.onEvent({ t: 'dvar', ms, name: 'sv_maxRate', value: '25000' })
}

t('stock server + a steady 250 FPS client: eligible, and the result carries what was enforced', () => {
  const r = makeRef()
  stockServer(r)
  r.onEvent({ t: 'client_dvar', ms: 0, slot: 0, name: 'com_maxfps', value: 250 })
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'client_dvar', ms: 1000, slot: 0, name: 'com_maxfps', value: 250 })   // a duplicate is not a change
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 9, reason: 'end_game' })
  const s = r.summary()
  eq(s.records_eligible, true)
  eq(s.verified_env.ok, true)
  eq(s.verified_env.ruleset, RULESET)
  eq(s.verified_env.enforced.server.sv_cheats, '0')
  eq(s.verified_env.observed.server.sv_maxRate, '25000', 'info dvars are on the proof too')
  eq(s.verified_env.observed.fps.P0.runs_at, 250)
  ok(!r.cmds.some((c) => c.t === 'say' && /record-eligible/.test(c.text)), 'nothing to say')
})

t('sv_cheats 1 at any point refuses the record, even if it is put back', () => {
  const r = makeRef()
  stockServer(r)
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'dvar', ms: 2 * MIN, name: 'sv_cheats', value: '1' })
  r.onEvent({ t: 'dvar', ms: 3 * MIN, name: 'sv_cheats', value: '0' })
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 9, reason: 'end_game' })
  const s = r.summary()
  eq(s.records_eligible, false)
  ok(s.verified_env.violations.some((v) => /sv_cheats was 1/.test(v)), s.verified_env.violations.join('; '))
  ok(s.flags.includes('env_violation'))
  eq(r.cmds.filter((c) => c.t === 'say' && /record-eligible/.test(c.text)).length, 1, 'said once, in game')
})

t('timescale and a movement constant are judged numerically ("1.0" is 1, "0.75" is not 0.7)', () => {
  const r = makeRef()
  stockServer(r)
  r.onEvent({ t: 'dvar', ms: 0, name: 'timescale', value: '1.0' })
  bootGame(r)
  eq(r.verifiedEnv().ok, true, '1.0 == 1')
  r.onEvent({ t: 'dvar', ms: MIN, name: 'player_backSpeedScale', value: '0.75' })
  eq(r.verifiedEnv().ok, false)
})

t('FPS above 250, uncapped, or changed mid-game each refuse the record', () => {
  for (const [label, vals] of [['333', [333]], ['uncapped', [0]], ['changed', [250, 125]]]) {
    const r = makeRef()
    stockServer(r)
    bootGame(r, { players: 1 })
    let ms = MIN
    for (const v of vals) r.onEvent({ t: 'client_dvar', ms: ms++, slot: 0, name: 'com_maxfps', value: v })
    r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game' })
    eq(r.summary().records_eligible, false, label)
  }
})

t('verifiedAllowFpsChange (b2\'s wording) lets a change inside 20–250 stand, but never 333', () => {
  const r = makeRef({ config: { verifiedAllowFpsChange: true } })
  stockServer(r)
  bootGame(r)
  r.onEvent({ t: 'client_dvar', ms: MIN, slot: 0, name: 'com_maxfps', value: 250 })
  r.onEvent({ t: 'client_dvar', ms: 2 * MIN, slot: 0, name: 'com_maxfps', value: 125 })
  eq(r.verifiedEnv().ok, true)
  r.onEvent({ t: 'client_dvar', ms: 3 * MIN, slot: 0, name: 'com_maxfps', value: 333 })
  eq(r.verifiedEnv().ok, false)
})

t('an FPS change BEFORE go-live (menu, load) is the start value, not a mid-game change', () => {
  const r = makeRef()
  stockServer(r)
  r.onEvent({ t: 'hello', ms: 0, instance: 'test', role: 'server', pid: 1 })
  r.onEvent({ t: 'map_loaded', ms: 0, map: 'nazi_zombie_prototype', mode: 'zombies', sv_maxclients: 4 })
  r.onEvent({ t: 'player_connect', ms: 0, slot: 0, name: 'P0', steamid: '76561198000000000' })
  r.onEvent({ t: 'client_dvar', ms: 10, slot: 0, name: 'com_maxfps', value: 85 })
  r.onEvent({ t: 'client_dvar', ms: 20, slot: 0, name: 'com_maxfps', value: 250 })
  r.onEvent({ t: 'round', ms: 100, n: 1 })
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game' })
  const s = r.summary()
  eq(s.verified_env.ok, true, s.verified_env.violations.join('; '))
  eq(s.verified_env.observed.fps.P0.first, 250)
})

t('no reports at all (an old DLL and client): "unknown", not a refusal, until the config says so', () => {
  const r = makeRef()
  bootGame(r)
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game' })
  const s = r.summary()
  eq(s.records_eligible, true)
  ok(s.verified_env.unknown.length >= 2, s.verified_env.unknown.join('; '))
  const strict = makeRef({ config: { verifiedRequireFpsReport: true, verifiedRequireServerEnv: true } })
  bootGame(strict)
  strict.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game' })
  eq(strict.summary().records_eligible, false, 'required and missing = refused')
})

t('a Custom game is judged and reported, but its eligibility is not the Verified rule\'s', () => {
  const r = makeRef({ mode: 'custom' })
  stockServer(r)
  bootGame(r)
  r.onEvent({ t: 'client_dvar', ms: MIN, slot: 0, name: 'com_maxfps', value: 333 })
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game' })
  const s = r.summary()
  eq(s.verified_env.ok, false)
  eq(s.records_eligible, true, 'custom mode keeps its own rules')
  ok(!r.cmds.some((c) => c.t === 'say' && /record-eligible/.test(c.text)), 'and nobody is told off in a Custom game')
})

t('game_over\'s dvars fill in a server environment the stream lost', () => {
  const r = makeRef()
  bootGame(r)
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 5, reason: 'end_game', dvars: { ...SERVER_RULES, sv_cheats: '1' } })
  const s = r.summary()
  eq(s.records_eligible, false)
  eq(s.reported.dvars.sv_cheats, '1')
})

t('effectiveFps is the engine\'s whole-millisecond cap', () => {
  eq([250, 240, 200, 125, 333, 400, 0].map(effectiveFps), [250, 250, 200, 125, 333, 500, 0])
})

t('a Verified lease never passes its own dvars to the server', () => {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet } }
  const m = new InstanceManager({ root: TMP, logDir: path.join(TMP, 'vdvars'), linkHost: '127.0.0.1', linkPort: 1, dryRun: true, log: quiet })
  const v = m.create({ kind: 'game', assignment: { map: 'nazi_zombie_prototype', mode: 'verified', settings: { dvars: { sv_cheats: '1', timescale: '2' } } } })
  const c = m.create({ kind: 'game', assignment: { map: 'nazi_zombie_prototype', mode: 'custom', settings: { dvars: { timescale: '2' } } } })
  ok(!v.gameArgs().some((a) => /sv_cheats|timescale/.test(a)), v.gameArgs().join(' '))
  ok(c.gameArgs().includes('+set timescale 2'), 'a Custom lease still gets its dvars')
})

// ---- dev knobs and lease-dvar injection (dedi.md §23, 2026-09-23) -----------------------
t('enw_dev_knobs 1 (a dev-knob process, e.g. the soak god mode) refuses the record', () => {
  const r = makeRef()
  stockServer(r)
  bootGame(r, { players: 1 })
  r.onEvent({ t: 'dvar', ms: 0, name: 'enw_dev_knobs', value: '1' })
  r.onEvent({ t: 'game_over', ms: 10 * MIN, round: 9, reason: 'end_game' })
  const s = r.summary()
  eq(s.records_eligible, false)
  ok(s.verified_env.violations.some((v) => /enw_dev_knobs was 1/.test(v)), s.verified_env.violations.join('; '))
})

t('a Custom lease dvar cannot inject command-line commands, and host-owned dvars stay the host\'s', () => {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet } }
  const m = new InstanceManager({ root: TMP, logDir: path.join(TMP, 'vdvars2'), linkHost: '127.0.0.1', linkPort: 1, dryRun: true, log: quiet })
  const c = m.create({ kind: 'game', assignment: { map: 'nazi_zombie_prototype', mode: 'custom', settings: { dvars: {
    timescale: '1 +set developer 1', 'g_speed +quit': '1', developer: '1', logfile: '0', net_port: '1', player_sustainAmmo: '1',
  } } } })
  const args = c.gameArgs()
  ok(!args.some((a) => /developer|\+quit|logfile 0|net_port 1\b/.test(a)), args.join(' '))
  ok(args.includes('+set player_sustainAmmo 1'), 'a plain one still passes')
  const { ok: pass, refused } = safeLeaseDvars([['a b', '1'], ['sv_cheats', '1'], ['x', '"q"'], ['Dedicated', '0']])
  eq(pass, [['sv_cheats', '1']])
  eq(refused.length, 3)
})

t('dev knobs only for an AGENT lease in CUSTOM mode that asks, and explicitly empty otherwise', () => {
  const dev = { god: true }
  eq(devKnobsFor({ agent: true, mode: 'custom', settings: { dev } }), { ENW_DEV_KNOBS: '1', ENW_DEV_GOD: '1' })
  for (const a of [
    { agent: false, mode: 'custom', settings: { dev } },          // a player's Custom game
    { mode: 'custom', settings: { dev } },                          // no agent flag (old site)
    { agent: true, mode: 'verified', settings: { dev } },           // Verified, never
    { agent: 'true', mode: 'custom', settings: { dev } },           // not a real boolean
    { agent: true, mode: 'custom', settings: {} },                  // did not ask
    null,
  ]) eq(devKnobsFor(a), { ENW_DEV_KNOBS: '', ENW_DEV_GOD: '' }, JSON.stringify(a))
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet } }
  const m = new InstanceManager({ root: TMP, logDir: path.join(TMP, 'vdvars3'), linkHost: '127.0.0.1', linkPort: 1, dryRun: true, log: quiet })
  const g = m.create({ kind: 'game', assignment: { map: 'nazi_zombie_prototype', mode: 'verified', settings: {} } })
  eq(g.gameEnv().ENW_DEV_KNOBS, '', 'a player game overrides anything inherited from the agent\'s env')
})
// ---- game copies by SLOT, not by id (dedi.md §19, 2026-09-23) --------------------------
// MEASURED on the box 2026-09-22 23:27-23:32: ids grow for the agent's whole life, the copy
// was `waw-{id}`, and after four boots every lease failed with `no game copy at
// .../waw-inst-05` (...inst-24) until the agent restarted — B's own Play among them.
console.log('\n== game copies by slot (the inst-05 outage) ==')
{
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet } }
  const mgr = new InstanceManager({
    root: TMP, logDir: path.join(TMP, 'slots'), linkHost: '127.0.0.1', linkPort: 1, maxInstances: 3,
    wine: { gameDir: '/home/waw/pfx/drive_c/zdev/waw-{slot}', homeWin: 'C:\zdev\homes\{slot}' },
    dryRun: true, log: quiet,
  })
  const COPIES = new Set(['waw-inst-01', 'waw-inst-02', 'waw-inst-03'])
  const copyOf = (i) => path.posix.basename(i.winePaths().gameDir)
  let churnOk = true, churnWhy = ''
  // Forty leases one after another (retire, boot), with two others held throughout.
  const a = mgr.create({ kind: 'game' }), b = mgr.create({ kind: 'game' })
  for (let n = 0; n < 40; n++) {
    const c = mgr.create({ kind: 'game' })
    if (!COPIES.has(copyOf(c))) { churnOk = false; churnWhy = `${c.id} -> ${copyOf(c)}`; break }
    await mgr.remove(c.id)
  }
  t('three live instances get three different existing copies, homepaths and lobby ports', () => {
    const c = mgr.create({ kind: 'game' })
    eq([a, b, c].map(copyOf), ['waw-inst-01', 'waw-inst-02', 'waw-inst-03'])
    eq([a, b, c].map((i) => i.winePaths().homeWin), ['C:\zdev\homes\inst-01', 'C:\zdev\homes\inst-02', 'C:\zdev\homes\inst-03'])
    eq([a, b, c].map((i) => i.gameEnv().ENW_LOBBY_PORT), ['3074', '3075', '3076'])
    ok(c.id === 'inst-43', `the id still counts up (${c.id}); only the copy is by slot`)
  })
  t('forty leases in a row never map to a copy past the three that exist', () => ok(churnOk, churnWhy))
  await mgr.remove(b.id)
  t('a retired slot is reused: the next boot takes the lowest free copy', () => {
    const d = mgr.create({ kind: 'game' })
    eq(copyOf(d), 'waw-inst-02'); eq(d.gameEnv().ENW_LOBBY_PORT, '3075')
  })
  t('the cap still holds at --max-instances', () => {
    let threw = false
    try { mgr.create({ kind: 'game' }) } catch { threw = true }
    ok(threw, 'a fourth instance on a three-instance box must be refused')
  })
  t('--lobby-base moves every instance\'s lobby port together', () => {
    const m2 = new InstanceManager({ root: TMP, logDir: path.join(TMP, 'slots2'), linkHost: '127.0.0.1', linkPort: 1, basePort: 28962, lobbyBase: 3075, dryRun: true, log: quiet })
    eq([m2.create({}), m2.create({})].map((i) => i.gameEnv().ENW_LOBBY_PORT), ['3075', '3076'])
  })
}
// ---- several leases per box (2026-09-23, lib/leases.js) ----------------------------------
// The old onAssignment retired every game whose match id was not the newest lease's. That
// is what kicked B whenever anybody else pressed Play. test/multi-lease.js runs the same
// rules against a real host agent; these are the planner's cases.
console.log('\n== several leases per box ==')
{
  const L = (id) => ({ status: 'leased', match_id: id, map: 'nazi_zombie_prototype', nonce: `n_${id}` })
  const G = (matchId, id, o = {}) => ({ matchId, finished: false, assignment: { match_id: matchId }, instance: { id }, ...o })
  t('v2 answer -> every lease; old shape -> one; idle -> none', () => {
    eq(leaseList({ v: 2, status: 'leased', assignments: [L('m_a'), L('m_b')] }).map((x) => x.match_id), ['m_a', 'm_b'])
    eq(leaseList(L('m_a')).map((x) => x.match_id), ['m_a'])
    eq(leaseList({ status: 'idle', nonce: 'idle' }), [])
    eq(leaseList({ v: 2, status: 'idle', nonce: 'idle', assignments: [] }), [])
  })
  t('a second lease boots beside the first and retires NOTHING', () => {
    const p = planLeases([L('m_a'), L('m_b')], [G('m_a', 'inst-01')], { started: new Set(['m_a']) })
    eq(p.retire.length, 0, 'retired')
    eq(p.boot.map((x) => x.match_id), ['m_b'])
  })
  t('a cancelled lease retires only its own game', () => {
    const p = planLeases([L('m_a')], [G('m_a', 'inst-01'), G('m_b', 'inst-02')], { started: new Set(['m_a', 'm_b']) })
    eq(p.retire.map((g) => g.matchId), ['m_b']); eq(p.boot.length, 0)
  })
  t('idle retires every leased game, but never a warm instance or a --boot sim', () => {
    const warm = G('m_w', 'inst-03', { assignment: null })
    const sim = G('m_s', 'inst-04', { assignment: null })
    const p = planLeases([], [G('m_a', 'inst-01'), warm, sim], { warm: new Set(['inst-03']) })
    eq(p.retire.map((g) => g.matchId), ['m_a'])
  })
  t('a lease whose game already finished is never booted again', () => {
    const p = planLeases([L('m_a')], [G('m_a', 'inst-01', { finished: true })], { started: new Set(['m_a']) })
    eq(p.boot.length, 0); eq(p.retire.length, 0)
  })
  t('after an agent restart, a live lease with no game is booted', () => {
    eq(planLeases([L('m_a')], [], {}).boot.map((x) => x.match_id), ['m_a'])
  })
}
// tools/replay-contact.js (mod-compat.md §10): "it worked last night" only counts if the
// player met a zombie in that game.
t('replay-contact: a game where the zombies never came near is not a sighting', () => {
  const snap = (ms, p, zs) => ({ t: 'snap', ms, zombies_alive: zs.length, players: [{ slot: 0, pos: p }], zombies: zs.map((z, i) => ({ id: 100 + i, pos: z })) })
  const far = contactSummary([snap(1000, [0, 0, 0], [[2000, 0, 0]]), snap(41000, [0, 0, 0], [[1644, 0, 0]])])
  eq([far.seconds, far.minDist, far.nearSamples, far.met], [40, 1644, 0, false])
  const met = contactSummary([
    { t: 'snap', ms: 0, players: [{ slot: 0, pos: [0, 0, 0], kills: 0, downs: 0 }] },   // players-only frame
    snap(27000, [0, 0, 0], [[500, 0, 0], [96, 0, 0]]),
    { t: 'snap', ms: 28000, players: [{ slot: 0, pos: [0, 0, 0], kills: 2, downs: 1 }], zombies: [{ id: 1, pos: [30, 0, 0] }] },
    { t: 'kill', ms: 28500, id: 1 },
  ], { near: 150 })
  eq([met.seconds, met.minDist, met.nearSamples, met.firstNearS, met.kills, met.downs, met.met], [28, 30, 2, 27, 2, 1, true])
})
// ---- the boot queue, the RAM guard, the returning player (host.md §15) ---------------------
console.log('\n== boot queue / RAM guard / returning player (host.md §15) ==')
async function at(name, fn) {
  try { await fn(); pass++; results.push(['ok', name]); console.log(`\x1b[32m ok  \x1b[0m ${name}`) }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); console.log(`\x1b[31mFAIL \x1b[0m ${name}\n        ${e.message}`) }
}
{
  const tick = () => new Promise((r) => setImmediate(r))
  const mkq = (o = {}) => {
    const started = []
    const q = new BootQueue({ gateMs: 60_000, retryMs: 20, ...o })
    const E = (id, real = false, extra = {}) => ({ id, real, start: () => { started.push(id); return true }, ...extra })
    return { q, started, E }
  }
  await at('boot queue: one boot at a time; the next starts only when the one before settles', async () => {
    const { q, started, E } = mkq()
    q.add(E('a')); q.add(E('b')); await tick()
    eq(started, ['a']); eq(q.position('b'), 1)
    q.settle('a', 'map_loaded'); await tick()
    eq(started, ['a', 'b'])
    q.clear()
  })
  await at('boot queue: a lease retired while its boot is QUEUED never starts (12:12:46 -> 12:13:36 orphan)', async () => {
    const { q, started, E } = mkq()
    q.add(E('inst-59')); q.add(E('inst-60')); q.add(E('inst-61')); await tick()
    eq(q.cancel('inst-60', 'lease gone'), 'queued')
    q.settle('inst-59', 'map_loaded'); await tick()
    q.settle('inst-61', 'map_loaded'); await tick()
    eq(started, ['inst-59', 'inst-61'])
    q.clear()
  })
  await at('boot queue: cancelling the ACTIVE boot releases the gate at once', async () => {
    const { q, started, E } = mkq()
    q.add(E('a')); q.add(E('b')); await tick()
    eq(q.cancel('a', 'retired'), 'active'); await tick()
    eq(started, ['a', 'b'])
    q.clear()
  })
  await at('boot queue: a real player\'s boot goes ahead of every queued agent boot, FIFO among players', async () => {
    const { q, started, E } = mkq()
    q.add(E('agent-1')); await tick()
    q.add(E('agent-2')); q.add(E('agent-3'))
    q.add(E('real-1', true)); q.add(E('real-2', true)); await tick()
    eq(q.queue.map((e) => e.id), ['real-1', 'real-2', 'agent-2', 'agent-3'])
    for (const id of ['agent-1', 'real-1', 'real-2', 'agent-2']) { q.settle(id); await tick() }
    eq(started, ['agent-1', 'real-1', 'real-2', 'agent-2', 'agent-3'])
    q.clear()
  })
  await at('boot queue: a player\'s boot queued while an agent\'s is still being admitted goes first', async () => {
    const { q, started, E } = mkq()
    q.add(E('agent-1')); q.add(E('real-1', true)); await tick(); await tick()
    eq(started, ['real-1'])
    q.clear()
  })
  await at('boot queue: the gate counts from a boot\'s START, not from when it was queued', async () => {
    const { q, started, E } = mkq({ gateMs: 60 })
    q.add(E('a')); q.add(E('b')); await tick()
    await new Promise((r) => setTimeout(r, 40))
    eq(started, ['a'], 'b must still be waiting at 40 ms')
    await new Promise((r) => setTimeout(r, 40)); await tick()
    eq(started, ['a', 'b'], 'the 60 ms gate let b go')
    await new Promise((r) => setTimeout(r, 30))
    eq(q.active?.id, 'b', 'b holds its own full gate, not what was left of a\'s')
    q.clear()
  })
  await at('boot queue: admit -> wait retries, drop removes the entry and says why', async () => {
    let n = 0
    const dropped = []
    const { q, started, E } = mkq({ admit: async (e) => (e.id === 'x' ? { drop: 'no memory' } : (++n < 3 ? { wait: 'low' } : { go: true })) })
    q.on('dropped', (e, why) => dropped.push([e.id, why]))
    q.add(E('x')); q.add(E('y'))
    await new Promise((r) => setTimeout(r, 120))
    eq(dropped, [['x', 'no memory']]); eq(started, ['y']); ok(n >= 3, 'asked again after each wait')
    q.clear()
  })
  await at('boot queue: an entry whose start() refuses (its lease went) does not hold the gate', async () => {
    const { q, started, E } = mkq()
    q.add({ id: 'gone', start: () => false }); q.add(E('next')); await tick(); await tick()
    eq(started, ['next'])
    q.clear()
  })

  const G = (id, o = {}) => ({ id, rssBytes: 400 * MB, loaded: true, warm: false, agent: false, real: false, startedAt: 1, ...o })
  t('RAM guard: enough memory -> boot', () => {
    eq(ramPlan({ availBytes: 1500 * MB, floorBytes: 700 * MB, instances: [] }).action, 'go')
  })
  t('RAM guard: a booting game\'s growth still to come is counted (a boot 1 s old has not grown yet)', () => {
    const p = ramPlan({ availBytes: 1000 * MB, floorBytes: 700 * MB, instances: [G('i1', { loaded: false, rssBytes: 50 * MB, agent: true })] })
    eq(p.action, 'wait'); eq(Math.round(p.effective / MB), 600)
  })
  t('RAM guard: an AGENT boot under the floor waits; it may retire a warm instance but never a game', () => {
    eq(ramPlan({ availBytes: 300 * MB, floorBytes: 700 * MB, instances: [G('a1', { agent: true }), G('r1', { real: true })] }).action, 'wait')
    const p = ramPlan({ availBytes: 400 * MB, floorBytes: 700 * MB, instances: [G('w1', { warm: true }), G('a1', { agent: true })] })
    eq([p.action, p.victims.map((v) => v.id)], ['evict', ['w1']])
  })
  t('RAM guard: a PLAYER under the floor evicts warm first, then the OLDEST agent game, never a player\'s', () => {
    const p = ramPlan({ availBytes: 4 * MB, floorBytes: 700 * MB, real: true, instances: [
      G('r1', { real: true, startedAt: 0 }), G('a-new', { agent: true, startedAt: 9 }), G('a-old', { agent: true, startedAt: 2 }), G('w1', { warm: true, startedAt: 5 }),
    ] })
    eq([p.action, p.victims.map((v) => v.id)], ['evict', ['w1', 'a-old']])
  })
  t('RAM guard: a player with nothing left to evict boots anyway (and it says so)', () => {
    const p = ramPlan({ availBytes: 100 * MB, floorBytes: 700 * MB, real: true, instances: [G('r1', { real: true })] })
    eq(p.action, 'go'); ok(/anyway/.test(p.why), p.why)
  })
  t('RAM guard: no /proc/meminfo (Windows) -> the guard is off', () => {
    eq(ramPlan({ availBytes: null, floorBytes: 700 * MB, instances: [] }).action, 'go')
  })
  t('RAM guard: /proc/meminfo is parsed (MemAvailable, and the old-kernel fallback)', () => {
    eq(parseMeminfo('MemTotal:        3884000 kB\nMemFree:          100000 kB\nMemAvailable:       4096 kB\n'), { availableBytes: 4096 * 1024, totalBytes: 3884000 * 1024 })
    eq(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 10 kB\nCached: 20 kB\n').availableBytes, 130 * 1024)
    eq(parseMeminfo('nonsense'), null)
  })

  const site = keys.generate()
  t('returning player: a verified client\'s OLD token re-admits them (wrong_match, replayed and expired do not apply)', () => {
    const tok = issue(site.privateKey, { steamid: '76561198126330106', matchId: 'm_78666e6c', now: Date.now() - 20 * MIN })
    const g = new TokenGuard(site.publicKey)
    eq(g.admit({ token: tok, steamid: '76561198126330106' }, 'm_20612b68').reason, 'expired')
    eq(checkBinding(site.publicKey, tok, { matchIds: ['m_78666e6c'], steamid: '76561198126330106' }).ok, true)
  })
  t('returning player: never for another SteamID, another match, or a token the site did not sign', () => {
    const tok = issue(site.privateKey, { steamid: '76561198126330106', matchId: 'm_a' })
    eq(checkBinding(site.publicKey, tok, { matchIds: ['m_a'], steamid: '76561198000000001' }).reason, 'wrong_steamid')
    eq(checkBinding(site.publicKey, tok, { matchIds: ['m_b'], steamid: '76561198126330106' }).reason, 'wrong_match')
    const other = keys.generate()
    const forged = issue(other.privateKey, { steamid: '76561198126330106', matchId: 'm_a' })
    eq(checkBinding(site.publicKey, forged, { matchIds: ['m_a'], steamid: '76561198126330106' }).reason, 'bad_signature')
  })
}
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
if (fail) { for (const [s, n, m] of results) if (s === 'FAIL') console.log(`  FAIL ${n}: ${m}`) }
process.exit(fail ? 1 : 0)
