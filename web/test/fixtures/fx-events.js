'use strict'

// Lane R3's synthetic replay: 20 s, two players, two zombies, and every replay-events-v1 kind
// (weapon, fire, hit, damage, pap, powerup: spawn / pickup / expire, all eight kinds).
// NOT a recording -- written by hand to docs/protocol/replay-events-v1.md (lane R1) so the
// viewer can be tested before a real v1 game exists. Used by web/test/replay-fx.js and by
// web/tools/make-fx-replay.mjs (which signs it into a .enwr for the scratch-site render check,
// replay.md §12).
//
// The shapes are v1's own (§2): `t` is the TYPE, `ms` the time, `slot` the player; `name` is the
// stripped gun (`colt`, `mp40`), `raw` the engine name; `hit.kill` on the lethal hit; `until` on
// insta_kill / double_points pickups only; snaps carry the engine name in `weapon`, plus `clip`
// and `ammo`; `map_loaded` carries replay_events 1, snap_hz 20, zombie_hz 20.

function fixtureEvents() {
  const ev = []
  const T0 = 500             // first snap: not 0, so the viewer's t0 offset is exercised
  const END = 20500
  ev.push({ t: 'hello', ms: 0, v: 0 })
  ev.push({ t: 'map_loaded', ms: 100, map: 'nazi_zombie_prototype', replay_events: 1, snap_hz: 20, zombie_hz: 20 })
  ev.push({ t: 'player_connect', ms: 200, slot: 0, name: 'Fixture One', steamid: '76561198000000001' })
  ev.push({ t: 'player_connect', ms: 210, slot: 1, name: 'Fixture Two', steamid: '76561198000000002' })
  ev.push({ t: 'player_spawn', ms: 400, slot: 0 })
  ev.push({ t: 'player_spawn', ms: 400, slot: 1 })
  ev.push({ t: 'round', ms: T0, n: 1 })

  // What each player holds, as the snapshot's engine name (v1 §3). Slot 0: colt, then the mp40,
  // the Pack-a-Punch knuckle crack at 5.0 s, the colt while the machine works, the upgraded mp40
  // from 9.0 s. Slot 1: the ray gun throughout.
  const held = (slot, ms) => {
    if (slot === 1) return 'ray_gun'
    if (ms < 3000) return 'zombie_colt'
    if (ms < 5000) return 'mp40'
    if (ms < 6500) return 'zombie_knuckle_crack'
    if (ms < 9000) return 'zombie_colt'
    return 'mp40_upgraded'
  }
  const health = (slot, ms) => (slot === 0 ? (ms < 6000 ? 100 : ms < 6800 ? 60 : ms < 10000 ? 20 : 100) : 100)

  // Snapshots at 20 Hz, zombies on every snap (v1 §3). Players walk slowly in Nacht's start room
  // (spawn is (0, 424, 17)).
  for (let ms = T0; ms <= END; ms += 50) {
    const s = (ms - T0) / 1000
    ev.push({
      t: 'snap', ms, round: 1,
      zombies_alive: 2,
      players: [
        { slot: 0, pos: [Math.round(40 * Math.sin(s / 3)), 424 - 6 * s, 17], ang: [0, 270], health: health(0, ms), alive: true, weapon: held(0, ms), clip: 8, ammo: 32, cmd_ang: [0, 270] },
        { slot: 1, pos: [80, 380 - 4 * s, 17], ang: [0, 250], health: health(1, ms), alive: true, weapon: held(1, ms), clip: 20, ammo: 160, cmd_ang: [0, 250] },
      ],
      zombies: [
        { id: 301, pos: [Math.round(20 - 3 * s), Math.round(120 + 3 * s), 17], yaw: 90, health: 150 },
        { id: 302, pos: [Math.round(140 - 2 * s), Math.round(100 + 4 * s), 17], yaw: 100, health: 150 },
      ],
    })
  }

  // weapon {ms, slot, name, pap, raw}
  const W = (ms, slot, name, pap, raw) => ev.push({ t: 'weapon', ms, slot, name, pap, raw })
  W(1000, 0, 'colt', false, 'zombie_colt')
  W(1000, 1, 'ray_gun', false, 'ray_gun')
  W(3000, 0, 'mp40', false, 'mp40')
  W(5000, 0, 'knuckle_crack', false, 'zombie_knuckle_crack')
  W(6500, 0, 'colt', false, 'zombie_colt')
  W(9000, 0, 'mp40', true, 'mp40_upgraded')

  // fire {ms, slot, name} and hit {ms, slot, zid, part, dmg, kill?}
  const shots = []
  for (const ms of [1500, 1800, 2100]) shots.push([0, ms, 'colt'])
  for (let ms = 3500; ms <= 4500; ms += 112) shots.push([0, ms, 'mp40'])
  for (const ms of [2000, 2330, 2660]) shots.push([1, ms, 'ray_gun'])
  for (let ms = 12500; ms <= 13300; ms += 112) shots.push([0, ms, 'mp40'])
  for (const [slot, ms, name] of shots) ev.push({ t: 'fire', ms, slot, name })
  ev.push({ t: 'hit', ms: 1510, slot: 0, zid: 301, part: 'body', dmg: 20 })
  ev.push({ t: 'hit', ms: 1810, slot: 0, zid: 301, part: 'head', dmg: 40 })
  ev.push({ t: 'hit', ms: 2010, slot: 1, zid: 302, part: 'body', dmg: 150, kill: true })
  for (let ms = 3500; ms <= 4500; ms += 224) ev.push({ t: 'hit', ms: ms + 10, slot: 0, zid: 302, part: 'body', dmg: 20 })
  ev.push({ t: 'hit', ms: 12510, slot: 0, zid: 301, part: 'head', dmg: 90, kill: true })

  // damage {ms, slot, by, hp}: the zombie swipes slot 0 twice
  ev.push({ t: 'damage', ms: 6000, slot: 0, by: 301, hp: 60 })
  ev.push({ t: 'damage', ms: 6800, slot: 0, by: 301, hp: 20 })

  // pap {ms, slot, name, raw, state}
  ev.push({ t: 'pap', ms: 5000, slot: 0, name: 'mp40', raw: 'mp40', state: 'start' })
  ev.push({ t: 'pap', ms: 9000, slot: 0, name: 'mp40', raw: 'mp40_upgraded', state: 'done' })

  // powerup {ms, id, kind, x, y, z, state, by?, until?}: `until` on insta_kill / double_points only
  const at = (x, y) => ({ x, y, z: 17 })
  const P = (ms, id, kind, xy, state, more = {}) => ev.push({ t: 'powerup', ms, id, kind, ...xy, state, ...more })
  P(7000, 1, 'insta_kill', at(-40, 300), 'spawn')
  P(8000, 1, 'insta_kill', at(-40, 300), 'pickup', { by: 0, until: 38000 })
  P(7200, 2, 'double_points', at(60, 300), 'spawn')
  P(7600, 2, 'double_points', at(60, 300), 'pickup', { by: 1, until: 37600 })
  P(10000, 3, 'max_ammo', at(0, 330), 'spawn')
  P(12000, 3, 'max_ammo', at(0, 330), 'expire')
  P(13000, 4, 'carpenter', at(-60, 340), 'spawn')
  P(14000, 5, 'nuke', at(30, 320), 'spawn')
  P(14500, 5, 'nuke', at(30, 320), 'pickup', { by: 1 })
  P(15500, 6, 'fire_sale', at(-20, 310), 'spawn')
  P(16000, 6, 'fire_sale', at(-20, 310), 'pickup', { by: 0 })
  P(16500, 7, 'death_machine', at(20, 290), 'spawn')
  P(17000, 7, 'death_machine', at(20, 290), 'pickup', { by: 1 })
  P(18000, 8, 'other', at(50, 340), 'spawn')
  P(18500, 8, 'other', at(50, 340), 'pickup', { by: 0 })
  // A second insta-kill picked up while the first runs: the script refreshes the timer, and the
  // viewer takes the latest `until` (v1 §2).
  P(18800, 9, 'insta_kill', at(-30, 320), 'spawn')
  P(19200, 9, 'insta_kill', at(-30, 320), 'pickup', { by: 0, until: 49200 })

  ev.push({ t: 'game_over', ms: END, round: 1 })
  // The container wants time order; a stable sort keeps same-ms events in the order above.
  return ev.map((e, i) => [e, i]).sort((a, b) => a[0].ms - b[0].ms || a[1] - b[1]).map(([e]) => e)
}

module.exports = { fixtureEvents }
