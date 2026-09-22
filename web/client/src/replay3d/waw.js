// World at War, as the replay viewer needs it: weapon crosshair data, HUD constants, the
// spread model, and the button layout. Every number cites where it came from.
//
// SOURCES (all read, none linked or vendored):
//   [W]  The game's own weapon files, dumped READ-ONLY from B's
//        zone\english\nazi_zombie_prototype.ff with OpenAssetTools Unlinker v0.33.0
//        (`--include-assets weapon`), 2026-09-22. The table below is those files' values,
//        nothing rounded, for every weapon the Nacht zone carries.
//   [K]  KisakCOD (SwagSoftware/KisakCOD, GPL-3.0), a source reimplementation of CoD4 --
//        the IW3 engine T4 is built on. Read for the FORMULAS only:
//          cgame/cg_draw_reticles.cpp  CG_DrawReticleSides, CG_CalcReticleSpread,
//                                      CG_CalcReticleColor, CG_DrawReticleCenter
//          bgame/bg_weapons.cpp        BG_GetSpreadForWeapon, PM_UpdateAimSpreadScale,
//                                      PM_Weapon_AddFiringAimSpreadScale,
//                                      PM_Weapon_OffHandPrepare/Hold (grenadeTimeLeft)
//          cgame/cg_draw_indicators.cpp CG_DrawFlashDamage, CG_DrawDamageDirectionIndicators,
//                                      CG_DrawGrenadeIndicators
//          cgame/cg_main.cpp           the cg_hud* / cg_crosshair* / cg_fov dvar defaults
//          bgame/bg_pmove.cpp          view heights 60 / 40 / 11, hull 15 x 70/50/30
//          qcommon/msg.h               the usercmd button bits
//        Every one of those dvar NAMES is also in B's CoDWaW.exe (strings, read-only), so the
//        HUD elements exist in T4; their DEFAULT VALUES are CoD4's and are [H] for T4.
//   [S]  The stock scripts, same dump: maps/_zombiemode.gsc (round HUD), common.ff
//        maps/_gameskill.gsc (the low-health overlay), maps/_load.gsc.
//   [I]  The HUD images, decoded read-only to LOOK AT (never shipped): side_small (8x8, a
//        1-texel white line in a 3-texel black outline, rows 2-7), center_cross (the grenade
//        reticle: four ticks at the edges), chalkmarks_1..5 (hud_chalk_*), hit_direction (a
//        red smear arc), overlay_low_health (dark red, opaque at the edges, clear centre).
//        Everything the viewer draws is procedural CSS/SVG made to match them.

// ---------------------------------------------------------------- engine constants --
export const CG_FOV = 65                     // [K] cg_main.cpp cg_fov default 65 (4:3 horizontal)
export const VIEW_HEIGHT = { stand: 60, crouch: 40, prone: 11 }   // [K] bg_pmove.cpp viewHeightTarget
export const HULL = { radius: 15, stand: 70, crouch: 50, prone: 30 } // [K] bg_pmove.cpp pm->mins/maxs
export const G_SPEED = 190                   // WaW g_speed default; ps->speed in the move-spread term
export const AIM_SPREAD_MOVE_THRESHOLD = 11  // [K] bg_misc.cpp bg_aimSpreadMoveSpeedThreshold
export const CROSSHAIR_ALPHA_MIN = 0.5       // [K] cg_crosshairAlphaMin
export const HUD = {
  damageIcon: { w: 128, h: 64, offset: 128, timeMs: 2000 },        // [K] cg_hudDamageIcon*
  flashMs: 500,                                                    // [K] CG_DamageFeedback v_dmg_time
  viewKick: { scale: 0.2, min: 5, max: 90 },                       // [K] bg_viewKick*
  grenade: {
    maxRangeFrag: 256, maxHeight: 104, offset: 50, iconW: 25, iconH: 25,
    pointerW: 25, pointerH: 12, pivot: [12, 27], pulseFreq: 1.7, pulseMax: 1.85, pulseMin: 0.3,
  },                                                               // [K] cg_hudGrenade*
  roundColor: [0.423, 0.004, 0],                                   // [S] _zombiemode.gsc hud.color
  chalkSize: 64,                                                   // [S] SetShader("hud_chalk_N", 64, 64)
  lowHealthCutoff: 0.2,   // [S] _gameskill.gsc healthOverlayCutoff "original normal"; g_gameskill 1 on the dedi (dedi.md:721)
  lowHealthPulse: 0.8,    // [S] _gameskill.gsc fadeFunc pulseTime
}

// ---------------------------------------------------------------- usercmd buttons --
// [K] qcommon/msg.h; T4 agrees on B's own game (web/server/lib/wawRules.js explains how).
export const BTN = {
  ATTACK: 0x1, SPRINT: 0x2, MELEE: 0x4, USE: 0x8, RELOAD: 0x10,
  PRONE: 0x100, CROUCH: 0x200, JUMP: 0x400, ADS: 0x800, FRAG: 0x4000,
}
export const stanceOf = (btn) => ((btn & BTN.PRONE) ? 'prone' : (btn & BTN.CROUCH) ? 'crouch' : 'stand')

// ---------------------------------------------------------------- weapons [W] --
// fire: fireType; fireTime s; center/side: reticle materials; centerSize/sideSize/minOfs in
// 640x480 virtual pixels; *Min/*Max spread in degrees; decay/fireAdd/turnAdd/moveAdd per the
// pmove terms; fuse/hold s; ecr = enemyCrosshairRange (units); ccc = crosshairColorChange.
export const WEAPONS = {
  '30cal_bipod': { cls: 'mg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.096, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 4, duckMin: 3.5, proneMin: 3, standMax: 10, duckMax: 8, proneMax: 6, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.75, ecr: 720, ccc: 1 },
  'bar': { cls: 'mg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.16, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 2, duckMin: 1.8, proneMin: 1.5, standMax: 8, duckMax: 6.5, proneMax: 5, decay: 4, fireAdd: 0.56, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 1000, ccc: 1 },
  'doublebarrel': { cls: 'spread', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.283, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 4, duckMin: 4, proneMin: 4, standMax: 4, duckMax: 4, proneMax: 4, decay: 5, fireAdd: 0, turnAdd: 0, moveAdd: 0.1, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 384, ccc: 1 },
  'doublebarrel_sawed_grip': { cls: 'spread', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.283, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 6, duckMin: 4, proneMin: 4, standMax: 6, duckMax: 4, proneMax: 4, decay: 5, fireAdd: 0, turnAdd: 0, moveAdd: 0.1, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 384, ccc: 1 },
  'fg42_bipod': { cls: 'mg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.064, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 2, duckMin: 1.8, proneMin: 1.5, standMax: 8, duckMax: 6.5, proneMax: 5, decay: 4, fireAdd: 0.56, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.8, ecr: 720, ccc: 1 },
  'fraggrenade': { cls: 'grenade', type: 'grenade', inv: 'offhand', fire: 'Full Auto', fireTime: 0.4, center: 'reticle_center_cross', side: '', centerSize: 32, sideSize: 16, minOfs: 4, standMin: 0, duckMin: 0, proneMin: 0, standMax: 0, duckMax: 0, proneMax: 0, decay: 0, fireAdd: 0, turnAdd: 0, moveAdd: 0, duckDecay: 0, proneDecay: 0, sidePos: 0, fuse: 3.5, cook: 1, hold: 0.4, speed: 1, ecr: 0, ccc: 0 },
  'gewehr43': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.125, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1, duckMin: 0.75, proneMin: 0.5, standMax: 5, duckMax: 4, proneMax: 3, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1400, ccc: 1 },
  'kar98k': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.33, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 8, duckMin: 7.5, proneMin: 7, standMax: 10, duckMax: 9.5, proneMax: 9, decay: 5, fireAdd: 1, turnAdd: 0, moveAdd: 5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'kar98k_scoped_zombie': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.33, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 8, duckMin: 7.5, proneMin: 7, standMax: 10, duckMax: 9.5, proneMax: 9, decay: 5, fireAdd: 1, turnAdd: 0, moveAdd: 5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'm1carbine': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.135, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1, duckMin: 0.75, proneMin: 0.5, standMax: 5, duckMax: 4, proneMax: 3, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'm1garand': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.135, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1, duckMin: 0.75, proneMin: 0.5, standMax: 5, duckMax: 4, proneMax: 3, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'm1garand_gl': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.135, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1, duckMin: 0.75, proneMin: 0.5, standMax: 5, duckMax: 4, proneMax: 3, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'm2_flamethrower_zombie': { cls: 'gas', type: 'gas', inv: 'primary', fire: 'Full Auto', fireTime: 0.2, center: 'hud_flamethrower_reticle', side: '', centerSize: 50, sideSize: 25, minOfs: 0, standMin: 0, duckMin: 0, proneMin: 0, standMax: 0, duckMax: 0, proneMax: 0, decay: 0, fireAdd: 0, turnAdd: 0, moveAdd: 0, duckDecay: 0, proneDecay: 0, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.8, ecr: 720, ccc: 1 },
  'm7_launcher': { cls: 'grenade', type: 'projectile', inv: 'altmode', fire: 'Full Auto', fireTime: 0.5, center: 'reticle_grenade_launch', side: '', centerSize: 128, sideSize: 1, minOfs: 15, standMin: 5, duckMin: 3.5, proneMin: 2, standMax: 6, duckMax: 6, proneMax: 6, decay: 2.5, fireAdd: 0.4, turnAdd: 0, moveAdd: 2.3, duckDecay: 1.375, proneDecay: 1.6, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 1000, ccc: 1 },
  'mg42_bipod': { cls: 'mg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.064, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 3.7, duckMin: 2.5, proneMin: 1, standMax: 6, duckMax: 5, proneMax: 4, decay: 4, fireAdd: 0.6, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.75, ecr: 720, ccc: 1 },
  'mk2_frag': { cls: 'grenade', type: 'grenade', inv: 'offhand', fire: 'Full Auto', fireTime: 0.4, center: 'reticle_center_cross', side: '', centerSize: 32, sideSize: 16, minOfs: 4, standMin: 0, duckMin: 0, proneMin: 0, standMax: 0, duckMax: 0, proneMax: 0, decay: 0, fireAdd: 0, turnAdd: 0, moveAdd: 0, duckDecay: 0, proneDecay: 0, sidePos: 0, fuse: 3.5, cook: 1, hold: 0.4, speed: 1, ecr: 0, ccc: 0 },
  'molotov': { cls: 'grenade', type: 'grenade', inv: 'offhand', fire: 'Full Auto', fireTime: 0.4, center: 'reticle_center_cross', side: '', centerSize: 32, sideSize: 16, minOfs: 4, standMin: 0, duckMin: 0, proneMin: 0, standMax: 0, duckMax: 0, proneMax: 0, decay: 0, fireAdd: 0, turnAdd: 0, moveAdd: 0, duckDecay: 0, proneDecay: 0, sidePos: 0, fuse: 3.5, cook: 0, hold: 1.4, speed: 1, ecr: 0, ccc: 0 },
  'mp40': { cls: 'smg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.112, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1.5, duckMin: 1.25, proneMin: 1, standMax: 6, duckMax: 5, proneMax: 4, decay: 4, fireAdd: 0.52, turnAdd: 0, moveAdd: 4, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 720, ccc: 1 },
  'panzerschrek': { cls: 'rocketlauncher', type: 'projectile', inv: 'primary', fire: 'Full Auto', fireTime: 0.33, center: '', side: '', centerSize: 32, sideSize: 16, minOfs: 4, standMin: 4, duckMin: 3, proneMin: 2, standMax: 10, duckMax: 10, proneMax: 10, decay: 1.5, fireAdd: 0.25, turnAdd: 0, moveAdd: 0, duckDecay: 1.375, proneDecay: 1.6, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.75, ecr: 0, ccc: 0 },
  'ptrs41_zombie': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.8, center: '', side: 'reticle_side_small', centerSize: 3, sideSize: 8, minOfs: 0, standMin: 8, duckMin: 7.5, proneMin: 7, standMax: 10, duckMax: 9.5, proneMax: 9, decay: 5, fireAdd: 1, turnAdd: 0, moveAdd: 5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.75, ecr: 1000, ccc: 1 },
  'ray_gun': { cls: 'pistol', type: 'projectile', inv: 'primary', fire: 'Full Auto', fireTime: 0.33, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1, duckMin: 1, proneMin: 1, standMax: 2, duckMax: 2, proneMax: 2, decay: 3.25, fireAdd: 1, turnAdd: 0.25, moveAdd: 0.5, duckDecay: 1.25, proneDecay: 1.65, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 320, ccc: 1 },
  'shotgun': { cls: 'spread', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.283, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 4, duckMin: 4, proneMin: 4, standMax: 4, duckMax: 4, proneMax: 4, decay: 5, fireAdd: 0, turnAdd: 0, moveAdd: 0.1, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 384, ccc: 1 },
  'springfield': { cls: 'rifle', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.33, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 8, duckMin: 7.5, proneMin: 7, standMax: 10, duckMax: 9.5, proneMax: 9, decay: 5, fireAdd: 1, turnAdd: 0, moveAdd: 5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 1000, ccc: 1 },
  'stg44': { cls: 'smg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.112, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 2, duckMin: 1.8, proneMin: 1.5, standMax: 8, duckMax: 6.5, proneMax: 5, decay: 4, fireAdd: 0.56, turnAdd: 0, moveAdd: 5, duckDecay: 1.05, proneDecay: 1.1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 720, ccc: 1 },
  'stielhandgranate': { cls: 'grenade', type: 'grenade', inv: 'offhand', fire: 'Full Auto', fireTime: 0.4, center: 'reticle_center_cross', side: '', centerSize: 32, sideSize: 16, minOfs: 4, standMin: 0, duckMin: 0, proneMin: 0, standMax: 0, duckMax: 0, proneMax: 0, decay: 0, fireAdd: 0, turnAdd: 0, moveAdd: 0, duckDecay: 0, proneDecay: 0, sidePos: 0, fuse: 3.5, cook: 1, hold: 0.4, speed: 1, ecr: 0, ccc: 0 },
  'sw_357': { cls: 'pistol', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.32, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 2, duckMin: 1.5, proneMin: 1, standMax: 4, duckMax: 3, proneMax: 2, decay: 4, fireAdd: 1, turnAdd: 0, moveAdd: 4.5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 0.9, ecr: 320, ccc: 1 },
  'thompson': { cls: 'smg', type: 'bullet', inv: 'primary', fire: 'Full Auto', fireTime: 0.08, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 1.5, duckMin: 1.25, proneMin: 1, standMax: 6, duckMax: 5, proneMax: 4, decay: 4, fireAdd: 0.52, turnAdd: 0, moveAdd: 4, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 720, ccc: 1 },
  'walther': { cls: 'pistol', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.135, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 3, duckMin: 2.5, proneMin: 2, standMax: 6, duckMax: 5, proneMax: 4, decay: 4, fireAdd: 1, turnAdd: 0, moveAdd: 4.5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 320, ccc: 1 },
  'zombie_colt': { cls: 'pistol', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.075, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 3, duckMin: 2.5, proneMin: 2, standMax: 6, duckMax: 5, proneMax: 4, decay: 4, fireAdd: 1, turnAdd: 0, moveAdd: 4.5, duckDecay: 1, proneDecay: 1, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 320, ccc: 1 },
  'zombie_melee': { cls: 'pistol', type: 'bullet', inv: 'primary', fire: 'Single Shot', fireTime: 0.075, center: '', side: 'reticle_side_small', centerSize: 4, sideSize: 8, minOfs: 0, standMin: 3.5, duckMin: 3, proneMin: 2.5, standMax: 6.5, duckMax: 6, proneMax: 5.5, decay: 3.25, fireAdd: 0.75, turnAdd: 0.5, moveAdd: 5.5, duckDecay: 1.25, proneDecay: 1.65, sidePos: 0, fuse: 0, cook: 0, hold: 0, speed: 1, ecr: 320, ccc: 1 },
}

// A weapon index the recording has not proven (web/server/lib/wawRules.js WEAPON_INDEX) is
// drawn with the M1 Garand's row: the most common WaW rifle, and its hip numbers sit in the
// middle of the table. Said in the settings panel whenever it is in use.
export const DEFAULT_WEAPON = 'm1garand'

export const weaponRow = (name) => (name && WEAPONS[name]) || null

/**
 * The track's clock (replay.md §8.11): tick k happened at `tick_t[k]` ms, which is the snap's
 * own time, not t0 + k * tick_ms (server frames drift). Falls back to the regular grid for a
 * track built before tick_t existed.
 *   at(k)        -> ms of tick k
 *   index(ms)    -> fractional tick index (k + f), clamped
 */
export function trackClock(track) {
  const T = track && track.tick_t && track.tick_t.length === track.ticks ? track.tick_t : null
  const n = track ? track.ticks : 0
  const at = (k) => (T ? T[Math.max(0, Math.min(n - 1, k))] : track.t0_ms + k * track.tick_ms)
  const index = (ms) => {
    if (!n) return 0
    if (!T) return Math.max(0, Math.min(n - 1, (ms - track.t0_ms) / track.tick_ms))
    if (ms <= T[0]) return 0
    if (ms >= T[n - 1]) return n - 1
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= ms) lo = mid; else hi = mid }
    const span = T[hi] - T[lo]
    return lo + (span > 0 ? (ms - T[lo]) / span : 0)
  }
  return { at, index }
}

const DEG = Math.PI / 180
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180

/** Shot times (ms) for one player: the attack presses, expanded by the weapon's fire type. [K] */
export function shotTimes(track, p, rowAtMs) {
  const out = []
  let last = -Infinity
  for (const [d, u0] of (p.presses && p.presses.fire) || []) {
    const row = rowAtMs(d)
    if (!row || row.type === 'grenade') continue
    const step = Math.max(0.03, row.fireTime) * 1000
    const u = u0 == null ? d + step : u0
    if (row.fire === 'Full Auto') {
      for (let t = Math.max(d, last + step); t < u; t += step) { out.push(t); last = t }
    } else if (d - last >= step) {
      out.push(d); last = d
    }
  }
  return out
}

/**
 * aimSpreadScale (0..1) per tick for one player, integrated at the track's rate. [K]
 * PM_UpdateAimSpreadScale: an increase (turning, moving) and the decay are exclusive in a
 * frame; decay is decayRate x (prone|ducked decay) per second; every shot adds fireAdd; ADS
 * (fWeaponPosFrac == 1) adds nothing. Run once per track, so scrubbing is exact.
 */
export function simulateSpread(track, p, weaponNameAt) {
  const n = track.ticks
  const clk = trackClock(track)
  const out = new Float32Array(n)
  const tickOfMs = (ms) => Math.floor(clk.index(ms))
  const rowAtMs = (ms) => weaponRow(weaponNameAt(p, tickOfMs(ms)))
  const shots = shotTimes(track, p, rowAtMs)
  let si = 0
  let s = 0
  for (let k = 0; k < n; k++) {
    const tMs = clk.at(k)
    const dt = k > 0 ? Math.max(0.001, (clk.at(k) - clk.at(k - 1)) / 1000) : track.tick_ms / 1000
    const row = weaponRow(weaponNameAt(p, k))
    if (!row || !p.alive[k]) {
      s = 0
      while (si < shots.length && shots[si] <= tMs) si++
      continue
    }
    const btn = p.btn ? p.btn[k] : 0
    const ads = (btn & BTN.ADS) !== 0
    const st = stanceOf(btn)
    let inc = 0
    if (k > 0 && !ads && row.decay) {
      if (row.turnAdd) inc += Math.abs(wrap180(p.ang[k * 2 + 1] - p.ang[k * 2 - 1])) * 0.01 * row.turnAdd
      const sp = Math.hypot(p.pos[k * 3] - p.pos[k * 3 - 3], p.pos[k * 3 + 1] - p.pos[k * 3 - 2]) / dt
      if (row.moveAdd && sp > AIM_SPREAD_MOVE_THRESHOLD && sp < 1000) inc += (row.moveAdd * sp / G_SPEED) * dt
    }
    if (inc > 0) s += inc
    else if (row.decay) s -= row.decay * (st === 'prone' ? row.proneDecay : st === 'crouch' ? row.duckDecay : 1) * dt
    else s -= 1
    // PM_UpdateAimSpreadScale clamps before the weapon fires (PM_Weapon_AddFiringAimSpreadScale).
    s = Math.max(0, Math.min(1, s))
    while (si < shots.length && shots[si] <= tMs) { if (!ads) s += row.fireAdd; si++ }
    s = Math.max(0, Math.min(1, s))
    out[k] = s
  }
  return out
}

/**
 * Where the four side ticks sit, in real pixels, for a viewport `h` pixels tall. [K]
 * CG_CalcReticleSpread: spread = (min + (max - min) * aimSpreadScale) degrees, projected
 * with the view's tanHalfFovY (the 4:3 vertical of cg_fov, which is what
 * sourceFovToVertical(CG_FOV) gives the camera), clamped up to reticleMinOfs.
 * CG_CalcReticleColor: alpha = max(cg_crosshairAlphaMin, 1 - aimSpreadScale).
 */
export function reticleGeom(row, scale, stance, h) {
  const v = h / 480
  const tanHalfFovY = Math.tan((CG_FOV / 2) * DEG) * 0.75
  const lo = stance === 'prone' ? row.proneMin : stance === 'crouch' ? row.duckMin : row.standMin
  const hi = stance === 'prone' ? row.proneMax : stance === 'crouch' ? row.duckMax : row.standMax
  const deg = lo + (hi - lo) * scale
  let spread = (Math.tan(deg * DEG) * (h / 2)) / tanHalfFovY
  if (spread < row.minOfs * v) spread = row.minOfs * v
  return {
    spread,
    size: row.sideSize * v,
    alpha: Math.max(CROSSHAIR_ALPHA_MIN, 1 - scale),
    deg,
  }
}

/**
 * The frag in hand, from the recorded +frag press. [K] PM_Weapon_OffHandPrepare/Hold: the
 * fuse is armed holdFireTime after the press and runs from there whether or not the grenade
 * has left the hand (cookOffHold), so it explodes at press + hold + fuse -- in the hand if
 * the button is still down. The reticle is reticle_center_cross at reticleCenterSize plus
 * (grenadeTimeLeft % 1000) / 100 virtual pixels: a once-a-second saw-tooth, the "tick".
 */
export function cookAt(presses, tMs, row) {
  if (!row || !row.cook) return null
  for (const [d, u] of (presses && presses.frag) || []) {
    const armed = d + row.hold * 1000
    const boom = armed + row.fuse * 1000
    const up = u == null ? boom : Math.min(u, boom)
    if (tMs < d || tMs > boom + 800) continue
    const left = tMs < armed ? 0 : Math.max(0, boom - tMs)
    return {
      holding: tMs <= up,
      thrown: tMs > up && up < boom,
      armedAt: armed, releasedAt: up, explodeAt: boom,
      timeLeftMs: left,
      reticleSize: row.centerSize + (left > 0 ? (left % 1000) / 100 : 0),
    }
  }
  return null
}

/** The round counter as WaW draws it: [S] chalk_one_up(). */
export function roundGlyphs(n) {
  if (!n || n < 1) return { tallies: [] }
  if (n <= 5) return { tallies: [n] }
  if (n <= 10) return { tallies: [5, n - 5] }
  return { number: n }
}

export const wawWrap180 = wrap180
