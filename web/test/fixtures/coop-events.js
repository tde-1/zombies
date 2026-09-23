'use strict'

// Lane R4's synthetic co-op replay (replay.md §13): lane R3's 20 s Nacht fixture
// (fx-events.js) with two more players, so the spectator switching has four people to follow.
// NOT a recording -- no real co-op replay exists yet.
//
//   slot 0 Fixture One    R3's player: colt, mp40, Pack-a-Punch, swiped twice
//   slot 1 Fixture Two    R3's player: the ray gun
//   slot 2 Fixture Three  a Thompson; DOWN 6.0 s .. 12.0 s, revived by slot 0
//   slot 3 Fixture Four   a Kar98k; DOWN from 15.0 s to the end, bleeds out at 20.0 s
//
// Used by web/test/replay-spectate.js and written as m_f0f0f0f2.enwr by
// web/tools/make-fx-replay.mjs for the render check (web/tools/r4-render-check.mjs).

const { fixtureEvents } = require('./fx-events.js')

const DOWN2 = [6000, 12000]
const DOWN3 = 15000

function coopEvents() {
  const base = fixtureEvents()
  const ev = []
  for (const e of base) {
    if (e.t === 'player_connect' && e.slot === 1) {
      ev.push(e)
      ev.push({ t: 'player_connect', ms: 220, slot: 2, name: 'Fixture Three', steamid: '76561198000000003' })
      ev.push({ t: 'player_connect', ms: 230, slot: 3, name: 'Fixture Four', steamid: '76561198000000004' })
      continue
    }
    if (e.t === 'player_spawn' && e.slot === 1) {
      ev.push(e)
      ev.push({ t: 'player_spawn', ms: 400, slot: 2 })
      ev.push({ t: 'player_spawn', ms: 400, slot: 3 })
      continue
    }
    if (e.t === 'snap') {
      const s = (e.ms - 500) / 1000
      const down2 = e.ms >= DOWN2[0] && e.ms < DOWN2[1]
      const down3 = e.ms >= DOWN3
      ev.push({
        ...e,
        players: [
          ...e.players,
          { slot: 2, pos: [-70, 400 - 5 * (down2 ? 5.5 : s), 17], ang: [0, 290], health: down2 ? 0 : 100, alive: !down2, weapon: 'thompson', clip: 20, ammo: 200, cmd_ang: [0, 290] },
          { slot: 3, pos: [Math.round(120 - 3 * Math.min(s, 14.5)), 450, 17], ang: [0, 230], health: down3 ? 0 : 100, alive: !down3, weapon: 'kar98k', clip: 5, ammo: 50, cmd_ang: [0, 230] },
        ],
      })
      continue
    }
    ev.push(e)
  }
  ev.push({ t: 'weapon', ms: 1000, slot: 2, name: 'thompson', pap: false, raw: 'thompson' })
  ev.push({ t: 'weapon', ms: 1000, slot: 3, name: 'kar98k', pap: false, raw: 'kar98k' })
  for (let ms = 2500; ms <= 3300; ms += 100) ev.push({ t: 'fire', ms, slot: 2, name: 'thompson' })
  ev.push({ t: 'hit', ms: 2510, slot: 2, zid: 302, part: 'body', dmg: 30 })
  for (const ms of [4000, 5500, 16500]) ev.push({ t: 'fire', ms, slot: 3, name: 'kar98k' })
  ev.push({ t: 'hit', ms: 4010, slot: 3, zid: 301, part: 'head', dmg: 100 })
  ev.push({ t: 'damage', ms: 5600, slot: 2, by: 302, hp: 40 })
  ev.push({ t: 'down', ms: DOWN2[0], slot: 2 })
  ev.push({ t: 'revive', ms: DOWN2[1], slot: 2, by: 0 })
  ev.push({ t: 'damage', ms: 14600, slot: 3, by: 301, hp: 30 })
  ev.push({ t: 'down', ms: DOWN3, slot: 3 })
  ev.push({ t: 'bleedout', ms: 20000, slot: 3 })
  return ev.map((e, i) => [e, i]).sort((a, b) => a[0].ms - b[0].ms || a[1] - b[1]).map(([e]) => e)
}

module.exports = { coopEvents, DOWN2, DOWN3 }
