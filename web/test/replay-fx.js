'use strict'

// Lane R3 (replay.md §12): the replay viewer's event -> scene-state reducer, and the track
// builder's pass-through of the R1 events.
//
//   node test/replay-fx.js
//
// The reducer (client/src/replay3d/fx.js) is ESM with no three.js, so it is imported straight
// into node, the way run-all.js imports waw.js. The track is built from the same synthetic
// events tools/make-fx-replay.mjs writes into a signed .enwr (FIXTURE below is that list).

const path = require('path')
const url = require('url')
const { buildTrack } = require('../server/routes/replay')
const { fixtureEvents } = require('./fixtures/fx-events.js')

let pass = 0
let fail = 0
const out = []
async function check(name, fn) {
  try { await fn(); pass++; out.push(['ok  ', name]) } catch (e) { fail++; out.push(['FAIL', `${name} — ${e.message}`]) }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what || 'value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const truthy = (a, what) => { if (!a) throw new Error(`${what || 'value'} is falsy`) }
const near = (a, b, eps, what) => { if (!(Math.abs(a - b) <= eps)) throw new Error(`${what || 'value'}: expected ~${b}, got ${a}`) }

const trackOf = (events, header = { match_id: 'm_fx000001', map: 'nazi_zombie_prototype' }) =>
  buildTrack('x.enwr', { readHeader: () => ({ header }), readEvents: () => events }, 20)

async function main() {
  const fx = await import(url.pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'replay3d', 'fx.js')).href)
  const waw = await import(url.pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'replay3d', 'waw.js')).href)
  const ev = fixtureEvents()
  const track = trackOf(ev)
  const F = fx.buildFx(track, null)

  await check('the track carries every R1 event kind in `fx`, and none of them in the feed', () => {
    const kinds = new Set(track.fx.map((e) => e.t))
    for (const k of fx.FX_KINDS) truthy(kinds.has(k), `fx has ${k}`)
    truthy(!track.events.some((e) => fx.FX_KINDS.includes(e.t)), 'the feed stays as it was')
    const w = track.fx.find((e) => e.t === 'weapon')
    eq(w.pid, 0); eq(w.name, 'zombie_colt'); eq(typeof w.ms, 'number')
    const p = track.fx.find((e) => e.t === 'powerup' && e.state === 'spawn')
    truthy(Number.isFinite(p.x) && Number.isFinite(p.z), 'a power-up keeps its position')
  })

  await check('the snapshot weapon column still fills from `weapon` on the players (20 Hz snaps)', () => {
    const p = track.players[0]
    const names = new Set(p.wpn.map((i) => track.weapons[i].name))
    truthy(names.has('zombie_colt') && names.has('mp40'), [...names].join(','))
  })

  await check('an old replay (no FX events) indexes to nothing and every query answers "nothing"', () => {
    const old = trackOf(ev.filter((e) => !fx.FX_KINDS.includes(e.t)))
    eq(old.fx.length, 0)
    const G = fx.buildFx(old, null)
    eq(G.count, 0); eq(G.cues.length, 0)
    eq(fx.fireAge(G, 0, 5000), Infinity)
    eq(fx.hitMarkerAt(G, 0, 5000, {}).alpha, 0)
    eq(fx.bloodAt(G, 0, 5000, {}).alpha, 0)
    eq(fx.powerupsAt(G, 5000, []).length, 0)
    eq(fx.chipsAt(G, 5000, []).length, 0)
    eq(fx.weaponAt(G, 0, 5000, () => 'mp40', {}).name, 'mp40', 'the snapshot column is the fallback')
    eq(fx.buildFx(null, null).count, 0, 'no track at all')
  })

  await check('both field conventions: {t:kind, ms, slot} and {t:ms, type, pid}', () => {
    const a = fx.normEvent({ t: 'fire', ms: 10, slot: 2, name: 'mp40' })
    const b = fx.normEvent({ type: 'fire', t: 10, pid: 2, name: 'mp40' })
    eq(JSON.stringify(a), JSON.stringify(b))
    eq(fx.normEvent({ t: 'snap', ms: 1 }), null, 'not an FX event')
    eq(fx.normEvent({ t: 'fire' }), null, 'no time')
    const p = fx.normEvent({ t: 'powerup', ms: 1, id: 3, kind: 'nuke', pos: [1, 2, 3], state: 'spawn' })
    eq(p.x + p.y + p.z, 6, 'pos[] is accepted for x,y,z')
  })

  await check('weapon at t: events win, PaP from the event or a later PaP done, snapshot fallback before the first', () => {
    const o = {}
    eq(fx.weaponAt(F, 0, 900, () => 'from_col', o).name, 'from_col', 'before the first weapon event')
    eq(fx.weaponAt(F, 0, 1000, null, o).name, 'zombie_colt')
    eq(o.pap, false)
    eq(fx.weaponAt(F, 0, 4000, null, o).name, 'mp40')
    eq(o.pap, false, 'before the PaP')
    eq(fx.weaponAt(F, 0, 9100, null, o).pap, true, 'after pap done (same base weapon)')
    eq(fx.weaponAt(F, 0, 12000, null, o).name, 'mp40_upgraded')
    eq(o.pap, true, 'the upgraded weapon event')
    eq(fx.weaponAt(F, 1, 5000, null, o).name, 'ray_gun', 'second player')
  })

  await check('muzzle flash lasts ~60 ms after each shot', () => {
    const shot = ev.find((e) => e.t === 'fire' && e.pid === 0)
    eq(fx.fireAge(F, 0, shot.ms), 0)
    truthy(fx.fireAge(F, 0, shot.ms + 59) < fx.FX_MS.flash, 'on at 59 ms')
    truthy(fx.fireAge(F, 0, shot.ms + 61) >= fx.FX_MS.flash, 'off at 61 ms')
    eq(fx.fireAge(F, 0, shot.ms - 1) === Infinity || fx.fireAge(F, 0, shot.ms - 1) > 60, true, 'nothing before it')
  })

  await check('hit marker: full on the hit, fading over 1 s, head vs body kept', () => {
    const h = ev.find((e) => e.t === 'hit' && e.part === 'head')
    const o = {}
    eq(fx.hitMarkerAt(F, 0, h.ms, o).alpha, 1)
    eq(o.part, 'head')
    near(fx.hitMarkerAt(F, 0, h.ms + 500, o).alpha, 0.5, 1e-9, 'half way')
    eq(fx.hitMarkerAt(F, 0, h.ms + 1000, o).alpha, 0, 'gone at 1 s')
    eq(fx.hitMarkerAt(F, 1, h.ms, o).alpha, 0, 'another player saw nothing')
  })

  await check('blood: on the swipe, stronger at lower health, gone by 1.2 s', () => {
    const d = ev.filter((e) => e.t === 'damage')
    const o = {}
    const a1 = fx.bloodAt(F, 0, d[0].ms, o).alpha
    const a2 = fx.bloodAt(F, 0, d[1].ms, o).alpha
    truthy(a1 > 0 && a2 > a1, `second (lower hp) hit reads stronger: ${a1} < ${a2}`)
    eq(fx.bloodAt(F, 0, d[1].ms + 1200, o).alpha, 0)
  })

  await check('PaP: busy between start and done; the jingle is a cue at the start', () => {
    const s = ev.find((e) => e.t === 'pap' && e.state === 'start')
    const d = ev.find((e) => e.t === 'pap' && e.state === 'done')
    truthy(fx.papBusyAt(F, 0, s.ms + 100), 'busy')
    truthy(!fx.papBusyAt(F, 0, d.ms + 1), 'done')
    truthy(F.cues.some((c) => c.kind === 'pap' && c.ms === s.ms), 'jingle cue')
    truthy(F.feed.some((l) => l.t === 'pap' && l.state === 'done'), 'a feed line')
  })

  await check('power-ups: drawn from spawn to pickup/expire; an uncollected one times out', () => {
    const arr = []
    const spawn = ev.find((e) => e.t === 'powerup' && e.kind === 'insta_kill' && e.state === 'spawn')
    const pick = ev.find((e) => e.t === 'powerup' && e.kind === 'insta_kill' && e.state === 'pickup')
    eq(fx.powerupsAt(F, spawn.ms - 1, arr).filter((p) => p.kind === 'insta_kill').length, 0, 'not before the drop')
    eq(fx.powerupsAt(F, spawn.ms + 10, arr).filter((p) => p.kind === 'insta_kill').length, 1, 'there after')
    eq(fx.powerupsAt(F, pick.ms, arr).filter((p) => p.kind === 'insta_kill').length, 0, 'gone at the pickup')
    const lone = ev.find((e) => e.t === 'powerup' && e.kind === 'carpenter' && e.state === 'spawn')
    eq(fx.powerupsAt(F, lone.ms + fx.POWERUP_TIMEOUT_MS - 1, arr).filter((p) => p.kind === 'carpenter').length, 1, 'still there before the timeout')
    eq(fx.powerupsAt(F, lone.ms + fx.POWERUP_TIMEOUT_MS, arr).filter((p) => p.kind === 'carpenter').length, 0, 'timed out')
    const exp = ev.find((e) => e.t === 'powerup' && e.kind === 'max_ammo' && e.state === 'expire')
    eq(fx.powerupsAt(F, exp.ms, arr).filter((p) => p.kind === 'max_ammo').length, 0, 'expired drop gone')
    // The pooled array is reused, not reallocated.
    const before = arr[0]
    fx.powerupsAt(F, spawn.ms + 10, arr)
    truthy(before === undefined || arr[0] === before, 'pool objects are reused')
  })

  await check('timed chips: `until` on the event clock, tenths of a second, one per kind, expire cuts it', () => {
    const pick = ev.find((e) => e.t === 'powerup' && e.kind === 'insta_kill' && e.state === 'pickup')
    const chips = []
    fx.chipsAt(F, pick.ms + 2660, chips)
    const ik = chips.find((c) => c.kind === 'insta_kill')
    truthy(ik, 'insta-kill chip')
    eq(ik.leftMs, pick.until - pick.ms - 2660)
    eq(ik.text, fx.fmtTenths(ik.leftMs))
    eq(fx.fmtTenths(27340), '27.3'); eq(fx.fmtTenths(99), '0.0'); eq(fx.fmtTenths(61000), '1:01.0')
    eq(fx.chipsAt(F, pick.until, chips).filter((c) => c.kind === 'insta_kill').length, 0, 'gone exactly at until')
    // double points has no `until`: 30 s default, cut short by its expire event.
    const dp = ev.find((e) => e.t === 'powerup' && e.kind === 'double_points' && e.state === 'pickup')
    const dpx = ev.find((e) => e.t === 'powerup' && e.kind === 'double_points' && e.state === 'expire')
    truthy(fx.chipsAt(F, dp.ms + 1000, chips).some((c) => c.kind === 'double_points'), 'double points running')
    eq(fx.chipsAt(F, dpx.ms, chips).some((c) => c.kind === 'double_points'), false, 'cut by expire')
    eq(fx.chipsAt(F, dp.ms + 1000, chips).some((c) => c.kind === 'max_ammo' || c.kind === 'nuke'), false, 'instant kinds have no chip')
    // the manifest's durationMs is used when the event has no until
    const G = fx.buildFx(track, { powerups: { double_points: { durationMs: 5000 } } })
    eq(fx.chipsAt(G, dp.ms + 5000, []).some((c) => c.kind === 'double_points'), false, 'durationMs from _assets.json')
  })

  await check('sounds: from the manifest only; none at all without one; PaP fire sound differs', () => {
    const fire = F.cues.find((c) => c.kind === 'fire')
    eq(fx.soundsFor(fire, null, false), null, 'no manifest, no sound')
    const assets = {
      weapons: { mp40: { sounds: { fire: 'mp40_fire', fire_pap: 'mp40_fire_pap' } } },
      powerups: { insta_kill: { sounds: { pickup: 'pu_grab', announce: 'ann_instakill' } } },
      sounds: { hit_marker: 'hitmark', player_hit: 'plr_hit', pap_upgrade: 'pap_jingle' },
    }
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40' }, assets, false)[0], 'mp40_fire')
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40_upgraded' }, assets, true)[0], 'mp40_fire_pap')
    eq(fx.soundsFor({ kind: 'hit', part: 'head' }, assets)[0], 'hitmark', 'no head variant: the plain one')
    eq(fx.soundsFor({ kind: 'damage' }, assets)[0], 'plr_hit')
    eq(fx.soundsFor({ kind: 'pap' }, assets)[0], 'pap_jingle')
    eq(fx.soundsFor({ kind: 'powerup_pickup', pkind: 'insta_kill' }, assets).join(','), 'pu_grab,ann_instakill')
    eq(fx.soundUrl('mp40_fire'), '/mapdata/_sounds/mp40_fire.ogg')
    eq(fx.soundUrl('_sounds/x.wav'), '/mapdata/_sounds/x.wav')
  })

  await check('the audio scheduler: plays inside the lookahead, drops on seek/scrub, never plays what was skipped', () => {
    const G = { cues: [100, 200, 300, 5000, 5100].map((ms) => ({ ms, kind: 'fire' })) }
    G.cueMs = G.cues.map((c) => c.ms)
    const s = new fx.CueScheduler(G)
    let dropped = 0
    s.onDrop = () => { dropped++ }
    const got = []
    const emit = (c, d) => got.push([c.ms, +d.toFixed(3)])
    s.seek(0)
    s.update(0, true, 1, emit)
    eq(JSON.stringify(got), '[[100,0.1],[200,0.2]]', 'the first 250 ms')
    s.update(100, true, 1, emit)
    eq(got.length, 3, '300 is now inside the window')
    // A scrub to 5050: 5000 is behind the clock and is NOT played late.
    const d0 = dropped
    s.update(5050, true, 1, emit)
    truthy(dropped > d0, 'the queue was dropped on the jump')
    eq(JSON.stringify(got.slice(3)), '[[5100,0.05]]', 'only what is ahead')
    // Paused: nothing plays, the cursor follows the clock.
    got.length = 0
    s.seek(0)
    eq(s.update(150, false, 1, emit), 0)
    eq(s.update(150, true, 1, emit), 2, 'resume at 150: 200 and 300')
    eq(got[0][0], 200)
    // Speed change: dropped and restretched (4x: delays are a quarter).
    got.length = 0
    s.seek(0)
    s.update(0, true, 4, emit)
    eq(JSON.stringify(got), '[[100,0.025],[200,0.05],[300,0.075]]', '1000 ms of replay ahead at 4x')
  })

  await check('display names: manifest first, WaW PaP names, readable fallback; weapon class for the placeholder', () => {
    eq(fx.displayName('zombie_colt', false, null), 'M1911')
    eq(fx.displayName('zombie_colt', true, null), 'Mustang & Sally')
    eq(fx.displayName('mp40_upgraded', true, null), 'The Afterburner')
    eq(fx.displayName('some_custom_gun', false, null), 'Some Custom Gun')
    eq(fx.displayName('mp40', false, { weapons: { mp40: { displayName: 'MP-40' } } }), 'MP-40')
    eq(fx.weaponClass('mp40', waw.WEAPONS), 'smg')
    eq(fx.weaponClass('mp40_upgraded', waw.WEAPONS), 'smg')
    eq(fx.weaponClass('ray_gun', waw.WEAPONS), 'raygun')
    eq(fx.weaponClass('zombie_colt', waw.WEAPONS), 'pistol')
    eq(fx.weaponClass('tesla_gun', waw.WEAPONS), 'wonder')
    eq(fx.weaponClass('unknown_thing', waw.WEAPONS), 'rifle')
  })

  await check('the state at a time is the same whether reached by playing or by seeking', () => {
    const t = 9150
    const a = JSON.stringify([fx.weaponAt(F, 0, t, null, {}), fx.hitMarkerAt(F, 0, t, {}), fx.bloodAt(F, 0, t, {}),
      fx.chipsAt(F, t, []), fx.powerupsAt(F, t, [])])
    // "play": walk every 16 ms up to t with the same pooled objects
    const w = {}, h = {}, b = {}, c = [], p = []
    for (let m = 0; m <= t; m += 16) { fx.weaponAt(F, 0, m, null, w); fx.hitMarkerAt(F, 0, m, h); fx.bloodAt(F, 0, m, b); fx.chipsAt(F, m, c); fx.powerupsAt(F, m, p) }
    fx.weaponAt(F, 0, t, null, w); fx.hitMarkerAt(F, 0, t, h); fx.bloodAt(F, 0, t, b); fx.chipsAt(F, t, c); fx.powerupsAt(F, t, p)
    eq(JSON.stringify([w, h, b, c, p]), a)
  })

  for (const [s, n] of out) console.log(`${s} ${n}`)
  console.log(`\nreplay-fx: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
