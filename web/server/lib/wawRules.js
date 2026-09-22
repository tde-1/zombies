// World at War facts the replay track needs and the recording does not carry.
//
// Everything here is READ OUT OF THE GAME'S OWN FILES, not remembered, and each constant says
// where. The scripts are the stock `.gsc`s the replay header fingerprints
// (`script_fingerprints["maps/_zombiemode.gsc"]`), extracted read-only from the fastfiles with
// OpenAssetTools into ZombiesDev\scripts\<map>\ -- nothing here is copied from them but numbers
// and the shape of one formula. See docs/kickstart/replay.md §8.11.
'use strict'

// ---------------------------------------------------------------- the round's zombie count --
//
// `level.zombie_total` is what the round has left to SPAWN; the HUD number people mean by
// "zombies left" is that plus the ones alive. The DLL cannot read script variables yet
// (t4_bind.cpp level_int returns nullopt), so the replay computes the round's total from the
// stock formula and subtracts the zombies it has watched die. Source, per map family:
//
//   nazi_zombie_prototype (Nacht)   maps/_zombiemode.gsc round_spawning(), lines 825-857
//                                    (sha256 9a260a45...d031, the fingerprint in both replays)
//   nazi_zombie_asylum / _sumpf     maps/_zombiemode.gsc round_spawning(), the same player term
//                                    plus the asylum-only rounds 1-2 override (line 1156)
//   nazi_zombie_factory (Der Riese) maps/_zombiemode.gsc round_spawning(), lines 1469-1525: a
//                                    SOLO player adds 0.5 * per_player instead of 0
//
//   max  = zombie_max_ai (24)
//   mult = max(1, round / 5); if round >= 10: mult *= round * 0.15
//   max += int((players - 1) * zombie_ai_per_player (6) * mult)      [factory solo: 0.5 * 6]
//   round 1: int(max * 0.2)   2: int(max * 0.4)   3: int(max * 0.6)   4: int(max * 0.8)
const ZOMBIE_MAX_AI = 24          // set_zombie_var("zombie_max_ai", 24), _zombiemode.gsc:272
const ZOMBIE_AI_PER_PLAYER = 6    // set_zombie_var("zombie_ai_per_player", 6), _zombiemode.gsc:273

function familyOf(map) {
  const m = String(map || '')
  if (m === 'nazi_zombie_prototype') return 'prototype'
  if (m === 'nazi_zombie_asylum' || m === 'nazi_zombie_sumpf') return 'asylum'
  if (m === 'nazi_zombie_factory') return 'factory'
  return null   // a custom map may have changed the formula; the caller says "estimated"
}

/**
 * @returns { total, source } -- source is 'stock-formula' for a stock map and
 *          'stock-formula-assumed' for anything else (the prototype formula, flagged).
 */
function roundTotal(map, round, players) {
  const fam = familyOf(map)
  const n = Math.max(1, players | 0)
  const r = Math.max(1, round | 0)
  let max = ZOMBIE_MAX_AI
  let mult = r / 5
  if (mult < 1) mult = 1
  if (r >= 10) mult *= r * 0.15
  if (fam === 'factory' && n === 1) max += Math.trunc(0.5 * ZOMBIE_AI_PER_PLAYER * mult)
  else max += Math.trunc((n - 1) * ZOMBIE_AI_PER_PLAYER * mult)
  if (fam === 'asylum' && map === 'nazi_zombie_asylum' && r < 3) max = n > 1 ? n * 3 + r : 6
  else if (r === 1) max = Math.trunc(max * 0.2)
  else if (r < 3) max = Math.trunc(max * 0.4)
  else if (r < 4) max = Math.trunc(max * 0.6)
  else if (r < 5) max = Math.trunc(max * 0.8)
  return { total: max, source: fam ? 'stock-formula' : 'stock-formula-assumed' }
}

// ---------------------------------------------------------------- usercmd buttons --
//
// The bit layout is IW3's (CoD4), from KisakCOD's src/qcommon/msg.h (GPL-3.0, a CoD4
// reimplementation; read, not copied). T4 is IW3's direct descendant and B's own game agrees
// with it bit for bit: on m_0afb449b 0x8 is held for the 9 s he spent rebuilding boards and is
// the frame the carbine was bought, 0x4 is one frame beside a kill (the knife), 0x4000 is held
// 2.3 s in round 2 (the first round a stielhandgranate is in the inventory), 0x100 is held
// while he is down (last stand is prone). So the table is [H]-plus-evidence, not [V].
const BTN = {
  ATTACK: 0x1, SPRINT: 0x2, MELEE: 0x4, USE: 0x8, RELOAD: 0x10,
  PRONE: 0x100, CROUCH: 0x200, JUMP: 0x400, ADS: 0x800, BREATH: 0x2000, FRAG: 0x4000, SMOKE: 0x8000,
}

// ---------------------------------------------------------------- weapon indices --
//
// `weapon` on the wire is `#<usercmd weapon index>` (replay.cpp weapon_name: BG_GetWeaponDef is
// not bound). The index is the engine's registration order, which depends on the map's scripts,
// so the table is per map and only holds indices a recording has PROVEN:
//
//   nazi_zombie_prototype  #7  zombie_colt  -- the weapon every player holds 0.6 s after
//                                              spawning, in both replays (_loadout.gsc: zombie
//                                              maps add_weapon("zombie_colt") as the switch weapon)
//                          #16 m1carbine    -- selected at ms 69 106 of m_0afb449b with the
//                                              player at (-69,-400), 26 units from the Nacht
//                                              m1carbine wall-buy trigger at (-94,-412) (map_ents)
//                                              and with 0x8 (use) held
//                          #0  (none)       -- down / dead / intermission
//
// Anything else resolves to null and the viewer uses its default row, saying so.
const WEAPON_INDEX = {
  nazi_zombie_prototype: { 0: '', 7: 'zombie_colt', 16: 'm1carbine' },
}

function weaponName(map, raw) {
  const s = String(raw == null ? '' : raw)
  if (!s.startsWith('#')) return { name: s || null, source: s ? 'recorded' : 'none' }
  const idx = Number(s.slice(1))
  const table = WEAPON_INDEX[map] || {}
  if (Object.prototype.hasOwnProperty.call(table, idx)) {
    return { name: table[idx] || null, source: table[idx] ? 'index-proven' : 'none' }
  }
  return { name: null, source: 'index-unknown' }
}

module.exports = { roundTotal, familyOf, BTN, weaponName, WEAPON_INDEX, ZOMBIE_MAX_AI, ZOMBIE_AI_PER_PLAYER }
