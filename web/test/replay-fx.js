'use strict'

// Lane R3 (replay.md §12): the replay viewer's event -> scene-state reducer, and the track
// builder's pass-through of the R1 events.
//
//   node test/replay-fx.js
//
// The reducer (client/src/replay3d/fx.js) is ESM with no three.js, so it is imported straight
// into node, the way run-all.js imports waw.js. The track is built from the same synthetic
// events tools/make-fx-replay.mjs writes into a signed .enwr (FIXTURE below is that list), in
// replay-events-v1's own shapes (docs/protocol/replay-events-v1.md); the manifest cases use lane
// R2's _assets.json shape (docs/kickstart/assets-pipeline.md §3).

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
    eq(w.pid, 0, 'v1 slot -> pid'); eq(w.name, 'colt'); eq(w.raw, 'zombie_colt'); eq(typeof w.ms, 'number')
    truthy(track.fx.some((e) => e.t === 'hit' && e.kill === true), 'hit.kill passes through')
    const p = track.fx.find((e) => e.t === 'powerup' && e.state === 'spawn')
    truthy(Number.isFinite(p.x) && Number.isFinite(p.z), 'a power-up keeps its position')
  })

  await check('the snapshot weapon column still fills from `weapon` on the players (20 Hz snaps)', () => {
    const p = track.players[0]
    const names = new Set(p.wpn.map((i) => track.weapons[i].name))
    truthy(names.has('zombie_colt') && names.has('mp40') && names.has('mp40_upgraded'), [...names].join(','))
  })

  await check('the header\'s replay_events / snap_hz reach the track (v1 §1); an old file says 0', () => {
    const t = trackOf(ev, { match_id: 'm_fx000001', map: 'nazi_zombie_prototype', replay_events: 1, snap_hz: 20, zombie_hz: 20 })
    eq(t.replay_events, 1); eq(t.snap_hz, 20); eq(t.zombie_hz, 20)
    eq(track.replay_events, 0, 'a header without it')
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

  await check('weapon at t: events win (name + raw), knuckle crack, PaP from the event or a later done, snapshot fallback', () => {
    const o = {}
    eq(fx.weaponAt(F, 0, 900, () => 'from_col', o).name, 'from_col', 'before the first weapon event')
    eq(o.source, 'snapshot')
    eq(fx.weaponAt(F, 0, 1000, null, o).name, 'colt')
    eq(o.raw, 'zombie_colt'); eq(o.pap, false)
    eq(fx.weaponAt(F, 0, 4000, null, o).name, 'mp40')
    eq(o.pap, false, 'before the PaP')
    eq(fx.weaponAt(F, 0, 5500, null, o).name, 'knuckle_crack', 'at the machine')
    eq(fx.weaponClass(o.name, null, o.raw), 'none', 'knuckle crack = empty hands')
    eq(fx.weaponAt(F, 0, 7000, null, o).name, 'colt', 'the pistol while it works')
    eq(fx.weaponAt(F, 0, 9100, null, o).name, 'mp40')
    eq(o.pap, true, 'the upgraded gun (v1: name stripped, pap true, raw _upgraded)')
    eq(fx.weaponAt(F, 1, 5000, null, o).name, 'ray_gun', 'second player')
    // PaP from a later `done` when the weapon event itself did not say so.
    const G = fx.buildFx({ fx: [
      { t: 'weapon', ms: 10, slot: 0, name: 'thompson', pap: false, raw: 'zombie_thompson' },
      { t: 'pap', ms: 20, slot: 0, name: 'thompson', raw: 'zombie_thompson_upgraded', state: 'done' },
    ] }, null)
    eq(fx.weaponAt(G, 0, 15, null, o).pap, false)
    eq(fx.weaponAt(G, 0, 25, null, o).pap, true)
  })

  await check('muzzle flash lasts ~60 ms after each shot', () => {
    const shot = ev.find((e) => e.t === 'fire' && e.slot === 0)
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

  await check('timed chips: `until` on the event clock, tenths, one per kind, the latest until wins, expire cuts, 30 s default', () => {
    const pick = ev.find((e) => e.t === 'powerup' && e.kind === 'insta_kill' && e.state === 'pickup')
    const chips = []
    fx.chipsAt(F, pick.ms + 2660, chips)
    const ik = chips.find((c) => c.kind === 'insta_kill')
    truthy(ik, 'insta-kill chip')
    eq(ik.leftMs, pick.until - pick.ms - 2660)
    eq(ik.text, fx.fmtTenths(ik.leftMs))
    eq(fx.fmtTenths(27340), '27.3'); eq(fx.fmtTenths(99), '0.0'); eq(fx.fmtTenths(61000), '1:01.0')
    // A second insta-kill (19.2 s, until 49.2 s) refreshes the timer: the chip shows the latest.
    eq(fx.chipsAt(F, 19500, chips).find((c) => c.kind === 'insta_kill').leftMs, 49200 - 19500, 'refreshed')
    eq(fx.chipsAt(F, 49200, chips).filter((c) => c.kind === 'insta_kill').length, 0, 'gone exactly at the latest until')
    // v1 sends no until for the others: 30 s (fire sale picked at 16 s -> 46 s).
    eq(fx.chipsAt(F, 17500, chips).find((c) => c.kind === 'fire_sale').text, '28.5', '30 s default')
    eq(fx.chipsAt(F, 17500, chips).some((c) => c.kind === 'max_ammo' || c.kind === 'nuke'), false, 'instant kinds have no chip')
    // An expire after a pickup cuts the effect; the manifest's durationMs replaces the default.
    const E = fx.buildFx({ fx: [
      { t: 'powerup', ms: 0, id: 1, kind: 'fire_sale', x: 0, y: 0, z: 0, state: 'spawn' },
      { t: 'powerup', ms: 100, id: 1, kind: 'fire_sale', x: 0, y: 0, z: 0, state: 'pickup', slot: 0 },
      { t: 'powerup', ms: 5000, id: 1, kind: 'fire_sale', x: 0, y: 0, z: 0, state: 'expire' },
    ] }, null)
    truthy(fx.chipsAt(E, 4999, []).length === 1, 'running')
    eq(fx.chipsAt(E, 5000, []).length, 0, 'cut by expire')
    const D = fx.buildFx({ fx: [{ t: 'powerup', ms: 100, id: 1, kind: 'death_machine', x: 0, y: 0, z: 0, state: 'pickup', slot: 0 }] },
      { powerups: { death_machine: { durationMs: 5000 } } })
    eq(fx.chipsAt(D, 5100, []).length, 0, 'durationMs from _assets.json')
    // The end cue (insta_kill_end etc.) at the end of the LAST window only.
    const ends = F.cues.filter((c) => c.kind === 'powerup_end' && c.pkind === 'insta_kill').map((c) => c.ms)
    eq(JSON.stringify(ends), '[49200]', 'one end sound, when the refreshed timer runs out')
  })

  await check('sounds: R2’s manifest shape; none at all without one; PaP and first-person fire sounds differ', () => {
    const fire = F.cues.find((c) => c.kind === 'fire')
    eq(fx.soundsFor(fire, null, false), null, 'no manifest, no sound')
    // The shape of /mapdata/_assets.json (assets-pipeline.md §3), trimmed.
    const assets = {
      base: '/mapdata/',
      weapons: {
        mp40: { sounds: { fire: '_sounds/mp40_fire.ogg', fire_plr: '_sounds/mp40_fire_plr.ogg', fire_pap: '_sounds/uber_fire.ogg', fire_pap_plr: '_sounds/uber_fire_plr.ogg' },
          pap: { sounds: { fire: '_sounds/uber_fire.ogg', fire_plr: '_sounds/uber_fire_plr.ogg' } } },
        colt: { sounds: { fire: '_sounds/colt_fire.ogg' } },
      },
      weaponByEngineName: { zombie_colt: { weapon: 'colt', pap: false }, zombie_mp40_upgraded: { weapon: 'mp40', pap: true } },
      powerups: { insta_kill: { spawnSound: '_sounds/powerup_spawn.ogg', sounds: { pickup: '_sounds/powerup_grab.ogg', announce: '_sounds/ann_insta_kill.ogg', end: '_sounds/insta_kill_end.ogg' } },
        max_ammo: { sounds: { pickup: '_sounds/powerup_grab.ogg', announce: '_sounds/ann_max_ammo.ogg', sting: '_sounds/max_ammo_sting.ogg' } } },
      sounds: { general: { hit_marker: '_sounds/hit_marker.ogg', player_hit: '_sounds/player_hit.ogg', zombie_swipe: '_sounds/zombie_swipe.ogg', pap_upgrade: '_sounds/pap_upgrade.ogg', pap_ready: '_sounds/pap_ready.ogg', powerup_spawn: '_sounds/powerup_spawn.ogg' } },
    }
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40' }, assets, false)[0], '_sounds/mp40_fire.ogg')
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40' }, assets, false, true)[0], '_sounds/mp40_fire_plr.ogg', 'first person')
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40' }, assets, true)[0], '_sounds/uber_fire.ogg', 'upgraded')
    eq(fx.soundsFor({ kind: 'fire', name: 'mp40' }, assets, true, true)[0], '_sounds/uber_fire_plr.ogg', 'upgraded, first person')
    eq(fx.soundsFor({ kind: 'fire', name: 'colt' }, assets, false)[0], '_sounds/colt_fire.ogg', 'v1 stripped name')
    eq(fx.soundsFor({ kind: 'fire', name: 'zombie_colt' }, assets, false)[0], '_sounds/colt_fire.ogg', 'engine name via weaponByEngineName')
    eq(fx.soundsFor({ kind: 'fire', name: 'colt' }, assets, false, true)[0], '_sounds/colt_fire.ogg', 'no _plr: the one sound')
    eq(fx.soundsFor({ kind: 'hit', part: 'head' }, assets)[0], '_sounds/hit_marker.ogg', 'no head variant: the plain one')
    eq(fx.soundsFor({ kind: 'damage' }, assets).join(','), '_sounds/zombie_swipe.ogg,_sounds/player_hit.ogg', 'swipe then pain')
    eq(fx.soundsFor({ kind: 'pap' }, assets)[0], '_sounds/pap_upgrade.ogg')
    eq(fx.soundsFor({ kind: 'pap_done' }, assets)[0], '_sounds/pap_ready.ogg')
    eq(fx.soundsFor({ kind: 'powerup_spawn', pkind: 'insta_kill' }, assets)[0], '_sounds/powerup_spawn.ogg')
    eq(fx.soundsFor({ kind: 'powerup_pickup', pkind: 'insta_kill' }, assets).join(','), '_sounds/powerup_grab.ogg,_sounds/ann_insta_kill.ogg,')
    eq(fx.soundsFor({ kind: 'powerup_pickup', pkind: 'max_ammo' }, assets)[2], '_sounds/max_ammo_sting.ogg', 'max ammo sting')
    eq(fx.soundsFor({ kind: 'powerup_end', pkind: 'insta_kill' }, assets)[0], '_sounds/insta_kill_end.ogg')
    eq(fx.soundUrl('_sounds/mp40_fire.ogg', '/mapdata/'), '/mapdata/_sounds/mp40_fire.ogg', 'R2 paths, base with a slash')
    eq(fx.soundUrl('mp40_fire'), '/mapdata/_sounds/mp40_fire.ogg', 'a bare key')
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

  await check('display names: manifest first (weaponByEngineName too), WaW PaP names, readable fallback; weapon class', () => {
    eq(fx.displayName('zombie_colt', false, null), 'M1911')
    eq(fx.displayName('colt', true, null, 'zombie_colt_upgraded'), 'C-3000 b1at-ch35', 'WaW’s, not Black Ops’ Mustang & Sally')
    eq(fx.displayName('mp40_upgraded', true, null), 'The Afterburner')
    eq(fx.displayName('some_custom_gun', false, null), 'Some Custom Gun')
    eq(fx.displayName('knuckle_crack', false, null, 'zombie_knuckle_crack'), 'Pack-a-Punch')
    eq(fx.displayName('#37', false, null), null, 'an unbound index has no name')
    eq(fx.displayName('mp40', false, { weapons: { mp40: { displayName: 'MP-40' } } }), 'MP-40')
    const A = { weapons: { ray_gun: { displayName: 'Ray Gun', pap: { displayName: "Porter's X2 Ray Gun", glb: null, sameWorldModelAsBase: true } } },
      weaponByEngineName: { ray_gun_upgraded: { weapon: 'ray_gun', pap: true } } }
    eq(fx.displayName('ray_gun_upgraded', true, A, 'ray_gun_upgraded'), "Porter's X2 Ray Gun", 'engine name -> manifest pap name')
    eq(fx.assetWeapon(A, 'ray_gun_upgraded').pap, true)
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
