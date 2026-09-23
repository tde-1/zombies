'use strict'

// Lane R3's synthetic replay: 20 s, two players, two zombies, and every R1 event kind
// (weapon, fire, hit, damage, pap, powerup: spawn / pickup / expire, all eight kinds).
// NOT a recording -- written by hand to the R1 contract (docs/protocol/replay-events-v1.md,
// lane R1) so the viewer can be built and tested before R1 lands. Used by
// web/test/replay-fx.js and by web/tools/make-fx-replay.mjs (which signs it into a .enwr for
// the scratch-site render check, replay.md §12).
//
// Field conventions are today's: {t: "<kind>", ms, slot}, plus `pid` on the R1 kinds (both
// are written, so the reader's "pid or slot" rule is exercised both ways).

function fixtureEvents() {
  const ev = []
  const T0 = 500             // first snap: not 0, so the viewer's t0 offset is exercised
  const END = 20500
  ev.push({ t: 'hello', ms: 0, v: 0 })
  ev.push({ t: 'map_loaded', ms: 100, map: 'nazi_zombie_prototype' })
  ev.push({ t: 'player_connect', ms: 200, slot: 0, name: 'Fixture One', steamid: '76561198000000001' })
  ev.push({ t: 'player_connect', ms: 210, slot: 1, name: 'Fixture Two', steamid: '76561198000000002' })
  ev.push({ t: 'player_spawn', ms: 400, slot: 0 })
  ev.push({ t: 'player_spawn', ms: 400, slot: 1 })
  ev.push({ t: 'round', ms: T0, n: 1 })

  // What each player holds, for the snapshot column (the R1 contract: snaps carry `weapon`).
  const held = (slot, ms) => {
    if (slot === 1) return 'ray_gun'
    if (ms < 3000) return 'zombie_colt'
    if (ms < 11500) return 'mp40'
    return 'mp40_upgraded'
  }
  const health = (slot, ms) => (slot === 0 ? (ms < 6000 ? 100 : ms < 6800 ? 60 : ms < 10000 ? 20 : 100) : 100)

  // Snapshots at 20 Hz. Players walk slowly in Nacht's start room (spawn is (0, 424, 17));
  // zombies are listed on every other frame (the DLL's own cadence, replay.md §8.4).
  let k = 0
  for (let ms = T0; ms <= END; ms += 50, k++) {
    const s = (ms - T0) / 1000
    const snap = {
      t: 'snap', ms, round: 1,
      players: [
        { slot: 0, pos: [Math.round(40 * Math.sin(s / 3)), 424 - 6 * s, 17], ang: [0, 270], health: health(0, ms), alive: true, weapon: held(0, ms), cmd_ang: [0, 270] },
        { slot: 1, pos: [80, 380 - 4 * s, 17], ang: [0, 250], health: health(1, ms), alive: true, weapon: held(1, ms), cmd_ang: [0, 250] },
      ],
    }
    if (k % 2 === 0) {
      snap.zombies_alive = 2
      snap.zombies = [
        { id: 301, pos: [Math.round(20 - 3 * s), Math.round(120 + 3 * s), 17], yaw: 90, health: 150 },
        { id: 302, pos: [Math.round(140 - 2 * s), Math.round(100 + 4 * s), 17], yaw: 100, health: 150 },
      ]
    }
    ev.push(snap)
  }

  // weapon {t, pid, name, pap, raw}
  ev.push({ t: 'weapon', ms: 1000, pid: 0, slot: 0, name: 'zombie_colt', pap: false, raw: '#7' })
  ev.push({ t: 'weapon', ms: 1000, pid: 1, slot: 1, name: 'ray_gun', pap: false, raw: '#21' })
  ev.push({ t: 'weapon', ms: 3000, pid: 0, slot: 0, name: 'mp40', pap: false, raw: '#12' })
  ev.push({ t: 'weapon', ms: 11500, pid: 0, slot: 0, name: 'mp40_upgraded', pap: true, raw: '#13' })

  // fire {t, pid, name} and hit {t, pid, zid, part, dmg}
  const shots = []
  for (const ms of [1500, 1800, 2100]) shots.push([0, ms, 'zombie_colt'])
  for (let ms = 3500; ms <= 4500; ms += 112) shots.push([0, ms, 'mp40'])
  for (const ms of [2000, 2330, 2660]) shots.push([1, ms, 'ray_gun'])
  for (let ms = 12500; ms <= 13300; ms += 112) shots.push([0, ms, 'mp40_upgraded'])
  for (const [pid, ms, name] of shots) ev.push({ t: 'fire', ms, pid, name })
  ev.push({ t: 'hit', ms: 1510, pid: 0, zid: 301, part: 'body', dmg: 20 })
  ev.push({ t: 'hit', ms: 1810, pid: 0, zid: 301, part: 'head', dmg: 40 })
  ev.push({ t: 'hit', ms: 2010, pid: 1, zid: 302, part: 'body', dmg: 1000 })
  for (let ms = 3500; ms <= 4500; ms += 224) ev.push({ t: 'hit', ms: ms + 10, pid: 0, zid: 302, part: 'body', dmg: 20 })
  ev.push({ t: 'hit', ms: 12510, pid: 0, zid: 301, part: 'head', dmg: 120 })

  // damage {t, pid, by, hp}: the zombie swipes slot 0 twice
  ev.push({ t: 'damage', ms: 6000, pid: 0, by: 301, hp: 60 })
  ev.push({ t: 'damage', ms: 6800, pid: 0, by: 301, hp: 20 })

  // pap {t, pid, name, state}
  ev.push({ t: 'pap', ms: 5000, pid: 0, name: 'mp40', state: 'start' })
  ev.push({ t: 'pap', ms: 9000, pid: 0, name: 'mp40', state: 'done' })

  // powerup {t, id, kind, x, y, z, state, by?, until?}
  const at = (x, y) => ({ x, y, z: 17 })
  ev.push({ t: 'powerup', ms: 7000, id: 1, kind: 'insta_kill', ...at(-40, 300), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 8000, id: 1, kind: 'insta_kill', ...at(-40, 300), state: 'pickup', by: 0, until: 38000 })
  ev.push({ t: 'powerup', ms: 7200, id: 2, kind: 'double_points', ...at(60, 300), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 7600, id: 2, kind: 'double_points', ...at(60, 300), state: 'pickup', by: 1 })
  ev.push({ t: 'powerup', ms: 15000, id: 2, kind: 'double_points', ...at(60, 300), state: 'expire' })
  ev.push({ t: 'powerup', ms: 10000, id: 3, kind: 'max_ammo', ...at(0, 330), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 12000, id: 3, kind: 'max_ammo', ...at(0, 330), state: 'expire' })
  ev.push({ t: 'powerup', ms: 13000, id: 4, kind: 'carpenter', ...at(-60, 340), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 14000, id: 5, kind: 'nuke', ...at(30, 320), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 14500, id: 5, kind: 'nuke', ...at(30, 320), state: 'pickup', by: 1 })
  ev.push({ t: 'powerup', ms: 15500, id: 6, kind: 'fire_sale', ...at(-20, 310), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 16000, id: 6, kind: 'fire_sale', ...at(-20, 310), state: 'pickup', by: 0, until: 46000 })
  ev.push({ t: 'powerup', ms: 16500, id: 7, kind: 'death_machine', ...at(20, 290), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 17000, id: 7, kind: 'death_machine', ...at(20, 290), state: 'pickup', by: 1, until: 47000 })
  ev.push({ t: 'powerup', ms: 18000, id: 8, kind: 'other', ...at(50, 340), state: 'spawn' })
  ev.push({ t: 'powerup', ms: 18500, id: 8, kind: 'other', ...at(50, 340), state: 'pickup', by: 0 })

  ev.push({ t: 'game_over', ms: END, round: 1 })
  // The container wants time order; a stable sort keeps same-ms events in the order above.
  return ev.map((e, i) => [e, i]).sort((a, b) => a[0].ms - b[0].ms || a[1] - b[1]).map(([e]) => e)
}

module.exports = { fixtureEvents }
