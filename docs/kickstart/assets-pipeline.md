# Replay game assets: weapons, power-ups, effects, sounds (lane R2, 2026-09-23)

B's ask (14:05): placeholder weapons in the players' hands in the 3D replay, and everything
around them — power-ups, muzzle flash, blood, hit marker, crosshairs, pack-a-punch, and the
sounds — extracted **repeatably** from the game files on this PC, by one script that could one
day run on a player's own PC from their own game, with no proprietary data shipped.

It exists. One command rebuilds all of it (≈ 50 s, CPU only, no game launch):

```
python tools/models/export_assets.py            # unlink if stale, build everything
python tools/models/export_assets.py --force    # re-unlink every zone first
python tools/models/export_assets.py --only weapons,sounds
python tools/models/export_assets.py --list     # what the manifest asks for
```

Environment (all optional): `ZM_WAW` (game copy; default `ZombiesDev\waw-base`, then the Steam
install, read-only), `ZOMBIES_DEV`, `ZM_OAT` (Unlinker.exe), `ZM_FFMPEG`, `ZM_ASSETS_WORK`
(default `ZombiesDev\assetwork`), `ZM_ASSETS_OUT` (default `ZombiesDev\maps`).

Needs: Python 3 + numpy + Pillow (as `export_models.py`), OpenAssetTools v0.33.0 Unlinker
(`ZombiesDev\tools\oat\`, GPL-3.0, run as a program, never vendored), ffmpeg with libvorbis
(7.1.1 gyan.dev full build here). No PyYAML: the manifest is a YAML subset the script parses
itself (PyYAML is used if present).

**Nothing game-derived is committed or uploaded.** The repo holds only the script and
`tools/models/assets-manifest.yml`, which is a list of *names*. Output stays in
`ZombiesDev\maps` (local only; the bucket was not touched — these files are not cleared for
public upload). **No decrypted executable dump is needed** (`ZombiesDev\dumps` is never read):
everything comes from the stock fastfiles and `.iwd`s.

## 1. How it works

1. **Unlink.** OpenAssetTools' Unlinker dumps, read-only over the game, only the asset types
   the manifest's `zones:` names, into `assetwork\dump\<zone>\` (≈ 15 s):

   | Zone | Assets | For |
   |---|---|---|
   | `nazi_zombie_factory` | xmodel, material, image, weapon, loadedsound, rawfile | every weapon/power-up model, weapon files, most weapon sounds, `_zombiemode_powerups.gsc` |
   | `localized_nazi_zombie_factory` | loadedsound | tesla fire, power-up, pack-a-punch, announcer, zombie whoosh |
   | `common` | material, image, loadedsound, localize | HUD (hit marker, crosshair, hurt overlay), muzzle/blood sprites, player pain, weapon names |
   | `common_mp` | loadedsound | the hit-marker sound (multiplayer's `MP_hit_alert`) |
   | `patch` | localize | pack-a-punch weapon names |

   A zone is re-unlinked only when its `.ff` size/mtime or the asset list changes (stamp file).
   The one streamed sound (the pack-a-punch jingle) is read straight out of `main\iw_27.iwd`.
2. **Weapons** (`_weapons\`). For each weapon the **weapon file** is read back and
   cross-checked against the manifest (`worldModel`, `gunModel`, `worldFlashEffect`; the build
   fails on a mismatch), and the display name comes from its `displayName` string. Each xmodel
   becomes a static `.glb` in bind pose: primitives sharing a texture merged, vertices
   compacted, NORMAL as int8 (`KHR_mesh_quantization`, as the player models), every `tag_*` bone
   written as a named empty node (`tag_flash`, `tag_brass`, `tag_weapon`, …) and repeated in
   `asset.extras.tags`. Colour maps: 256 px (world) / 512 px (viewmodel), JPEG q82, PNG only
   when the alpha is used (capped at 256 px).
   **Pack-a-punch camo**: the `_up` models use `mtl_weapon_*_gold` / `mtl_weapon_colt45_zombie_up`,
   whose colour map is the black placeholder `blackness_c` and whose gold lives in the specular
   map `~gold_spec-rgb&skins_gloss-l-11`. That spec map's RGB becomes the base colour,
   metallic 0.5 / roughness 0.4 (half, because a fully metallic surface with no environment map
   renders near-black in three.js), `extras.packAPunchCamo: true`.
3. **Power-ups** (`_powerups\`): the script models, same writer.
4. **Effects** (`_fx\`): one image per effect → PNG, and `fx.json` with its size and its blend
   mode read from the material's state bits (`add` = one/one, `alpha` = srcalpha/invsrcalpha).
5. **Sounds** (`_sounds\`): ffmpeg → Vorbis q3, mono (the jingle stereo), metadata stripped,
   `-fflags +bitexact -flags:a +bitexact -serial_offset 1` so the Ogg stream serial is fixed.
   OAT writes a loaded sound as `.wav` or `.xwma`; ffmpeg reads both.
6. **`maps\_assets.json`**: the one file the viewer reads (§3). It carries no timestamp.

**Deterministic.** Two full builds — one with `--force` re-unlinking every zone — produced
byte-identical output (85 files, 6 375 740 bytes, combined hash `e86ed776ad6ad40e`). A section
that is rebuilt owns its directory: a file this run did not write is deleted (logged).
**Logged** to stdout and appended to `assetwork\export_assets.log`. **Budgets enforced** (the
build exits non-zero): 450 KB per world/power-up `.glb`, 700 KB per viewmodel, 15 MB for the pack.

## 2. What was extracted

### Weapons (`/mapdata/_weapons/`)

| Weapon | Game name | World xmodel | KB | tris | PaP game name | PaP world xmodel | KB | view KB | PaP view KB |
|---|---|---|---:|---:|---|---|---:|---:|---:|
| `colt` | Colt M1911 | `weapon_zombie_colt45_pistol` | 37 | 608 | C-3000 b1at-ch35 | `weapon_zombie_colt45_pistol_up` | 25 | 142 | 194 |
| `m1carbine` | M1A1 Carbine | `weapon_zombie_m1carbine_rifle` | 53 | 1270 | Widdershins RC-1 | `weapon_zombie_m1carbine_rifle_up` | 55 | 160 | 254 |
| `thompson` | Thompson | `weapon_zombie_thompson_smg` | 70 | 1670 | Gibs-o-matic | `weapon_zombie_thompson_smg_up` | 72 | 208 | 300 |
| `mp40` | MP40 | `weapon_zombie_mp40_smg` | 43 | 910 | The Afterburner | `weapon_zombie_mp40_smg_up` | 36 | 132 | 197 |
| `ray_gun` | Ray Gun | `weapon_usa_ray_gun` | 231 | 3876 | Porter's X2 Ray Gun | *same as base* | – | 337 | 340 |
| `tesla_gun` | Wunderwaffe DG-2 | `weapon_usa_tesla` | 331 | 3682 | Wunderwaffe DG-3 JZ | *same as base* | – | 651 | 596 |

Files: `<name>.glb`, `<name>_pap.glb` (only where the upgraded gun has its own world model),
`<name>_view.glb`, `<name>_pap_view.glb`. Viewmodels are included because they were cheap
(the viewmodel xmodels are in the same dump).

* **Pack-a-punch**: the Colt, Carbine, Thompson and MP40 have distinct `_up` world models with
  the gold camo. **The Ray Gun and the Wunderwaffe do not** — the game's `ray_gun_upgraded` /
  `tesla_gun_upgraded` use the base `worldModel`; only their viewmodels
  (`viewmodel_zombie_raygun_up` gold, `viewmodel_zombie_tesla_up`) change. `_assets.json` says so
  (`pap.glb: null, sameWorldModelAsBase: true`).
* WaW's upgraded Colt is **"C-3000 b1at-ch35"** (the game's `PATCH_COLT45_UPGRADED`), not
  "Mustang & Sally" (that is Black Ops). Its fire sound is the M1 grenade launcher's
  (`weap_m1gren_fire_plr`), and it has no world flash effect.

### Power-ups (`/mapdata/_powerups/`)

From `maps/_zombiemode_powerups.gsc`: `add_zombie_powerup(name, model, ...)`.

| Kind | Script name | xmodel | KB | tris | Sounds |
|---|---|---|---:|---:|---|
| `max_ammo` | `full_ammo` | `zombie_ammocan` | 103 | 3168 | grab, `ann_max_ammo`, sting `full_ammo` |
| `insta_kill` | `insta_kill` | `zombie_skull` | 99 | 3454 | grab, `ann_insta_kill`, loop, end (30 s) |
| `double_points` | `double_points` | `zombie_x2_icon` | 11 | 236 | grab, `ann_double_points`, loop, end (30 s) |
| `nuke` | `nuke` | `zombie_bomb` | 12 | 348 | grab, `ann_nuke`, flash, per-zombie `nuked` |
| `carpenter` | `carpenter` | `zombie_carpenter` | 13 | 388 | grab, `ann_carpenter`, loop, end |

All five use the gold `mtl_x2icon_gold`-family materials (their colour maps are the gold).
Timings from the script: insta kill / double points **30 s**; a drop lies **15 s**, then blinks
40 times (15 × 0.5 s, 10 × 0.25 s, 15 × 0.1 s) and is deleted at **26.5 s**
(`groundLifeMs`, `blinkFromMs`). The glow is the fx `misc/fx_zombie_powerup_on`, whose sprite is
`gfx_fxt_muz_vert_gen` → `_fx/powerup_glow.png`, additive; the fx tints it green and the
`tint: #5cff5c` in `fx.json` is **by eye** (T4 fx are not dumped, §5).

**Fire Sale does not exist in World at War** (it is a Black Ops power-up): no model, sound,
string or script in any stock zone. Listed under `missing` in `_assets.json`.

### Effects (`/mapdata/_fx/`, `fx.json`)

| Name | Material / image | Zone | px | Blend | KB | Use |
|---|---|---|---|---|---:|---|
| `muzzle_rifle` | `gfx_fxt_muz_vert_gen` | common | 128² | add | 11.0 | rifles/SMGs muzzle flash |
| `muzzle_pistol` | `gfx_fxt_gas_flash` | common | 128×64 | add | 9.5 | pistol muzzle flash |
| `muzzle_heavy` | `gfx_fxt_fire_flame_clump` | common | 128² | add | 25.9 | heavy flash / flame clump |
| `muzzle_raygun` | `gfx_fxt_fx_raygun_ring` | factory | 64² | add | 4.1 | ray gun ring |
| `muzzle_tesla` | `gfx_fxt_env_electric_arc1_add` | factory | 256×64 | add | 9.5 | tesla arc |
| `powerup_glow` | `gfx_fxt_muz_vert_gen` | common | 128² | add | 11.0 | power-up glow (tint by eye) |
| `blood_burst`, `blood_burst_b`, `blood_drops`, `blood_gush` | `gfx_fxt_bio_*` | common | 128² | alpha | 4.7–14.4 | `fx_zombie_bloodsplat` on a zombie hit |
| `hurt_overlay` | `overlay_low_health` | common | 512² | alpha | 126 | red full-screen vignette when hurt (swiped) |
| `hit_direction` | `hit_direction` | common | 128×64 | alpha | 4.1 | damage direction indicator |
| `hit_marker` | `damage_feedback` | common | 32×64 | alpha | 0.5 | hit marker |
| `crosshair_side` | `reticle_side_small` | common | 8² | alpha | 0.1 | crosshair bars (every gun's `reticleSide` but the tesla) |
| `crosshair_center` | `reticle_center_cross` | factory | 32² | alpha | 0.2 | centre cross |
| `crosshair_tesla` | `hud_flamethrower_reticle` | factory | 64² | alpha | 0.6 | the tesla gun's `reticleCenter` |
| `pap_camo` | image `~gold_spec-rgb&skins_gloss-l-11` | factory | 128² | texture | 11.7 | the pack-a-punch gold |

Each weapon's `muzzle.sprite` names one of these. Which sprite a muzzle-flash fx uses is **zone
order**, not parsed (§5): an fx is listed right after the materials it pulls in, e.g.
`material gfx_fxt_muz_vert_gen` → `fx weapon/muzzleflashes/mg42hv` in `common`,
`gfx_fxt_gas_flash` → `pistolflash_ug`, `gfx_fxt_fx_raygun_ring` → the ray gun's.

### Sounds (`/mapdata/_sounds/`)

39 sounds, **1.18 MB** (the 49 s pack-a-punch jingle is 470 KB of it).

| Key | Source (zone or iwd : file) | Alias | ms | KB |
|---|---|---|---:|---:|
| `colt_fire` / `_plr` | factory `sfx/weapon/pistols/colt1911/fire/wpn_colt1911_mn` / `_st_f` | `weap_colt_fire(_plr)` | 1710 / 404 | 16.6 / 6.7 |
| `colt_pap_fire` | factory `sfx/weapon/gren/m1gren/fire/wpn_m1gren_st_f` | `weap_m1gren_fire_plr` | 1276 | 13.6 |
| `m1carbine_fire` / `_plr` | factory `.../m1_carbine/fire/mono/wpn_m1carbine_mn_00` / `wpn_m1carbine_st_f` | `weap_carbine_fire(_plr)` | 828 / 312 | 10.1 / 6.0 |
| `thompson_fire` / `_plr` | factory `.../thompson/fire/wpn_thompson_mn` / `_st_f` | `weap_thompson_fire(_plr)` | 1169 / 352 | 12.4 / 6.4 |
| `mp40_fire` / `_plr` | factory `.../mp40/fire/mono/mono_00` / `wpn_mp40_st_f` | `weap_mp40_fire(_plr)` | 592 / 580 | 8.3 / 7.6 |
| `ray_gun_fire` / `_plr` | factory `sfx/weapon/ray_gun/wpn_ray_mn` / `_st_f` | `weap_rgun_fire(_plr)` | 831 | 10.0 |
| `tesla_fire` / `_plr` | localized `sfx/weapon/tesla/new/wpn_tesla_fire_mn_f` / `_st_f` | `wpn_tesla_fire_npc/_plr` | 824 | 11.8 |
| `uber_fire` / `_plr` | factory `sfx/weapon/uber/uber_shot_m` / `_st` | `weap_*_fire_ubershot_m/_st` | 513 | 7.7 |
| `powerup_spawn`, `powerup_loop`, `powerup_grab` | localized `sfx/levels/zombie/powerups/powerup/power_up_*` | `spawn_powerup(_loop)`, `powerup_grabbed` | 962 / 2952 / 1305 | 11–29 |
| `max_ammo_sting` | localized `.../full_ammo/full_ammo` | `full_ammo` | 2730 | 24.5 |
| `insta_kill_loop` / `_end` | localized `.../insta_kill/insta_kill_loop` / `insta_kill` | same | 1663 / 2200 | 17–21 |
| `double_points_loop` / `_end` | localized `.../double_point/double_point_loop` / `_off` | `double_point_loop`, `points_loop_off` | 2427 / 6041 | 22 / 41 |
| `nuke_flash`, `nuke_zombie` | localized `sfx/amb/flare/flare_exp`, `.../nuke/nuke` | `nuke_flash`, `nuked` | 2465 / 1691 | 17–18 |
| `carpenter_loop` / `_end` | localized `.../carp/carp_loop` / `carp_end` | same | 7091 / 4694 | 69 / 30 |
| `ann_max_ammo`, `ann_insta_kill`, `ann_double_points`, `ann_nuke`, `ann_carpenter` | localized `voiceovers/zombie/ann/ann_*` (also in `localized_english_iw05/06.iwd`) | `ma_vox`, `insta_vox`, `dp_vox`, `nuke_vox`, `carp_vox` | 1.9–2.9 s | 20–28 |
| `hit_marker` | common_mp `sfx/mp/mp_hit_indication_3c` | `MP_hit_alert` | 45 | 3.9 |
| `player_hit` | common `sfx/character/player/pain_small/pain_small_00` | `player_pain_small` (1 of 8) | 494 | 7.9 |
| `zombie_swipe` | localized `sfx/levels/zombie/whoosh/whoosh_00` | `attack_whoosh` (1 of 3) | 954 | 13.1 |
| `pap_upgrade`, `pap_ready`, `pap_sting` | localized `sfx/levels/zombie/perksacola/packa_upgrade_weap`, `packa_weap_ready`, `jingle/packa_sting` | `packa_weap_upgrade`, `packa_weap_ready`, `mx_packa_sting` | 6042 / 3255 / 9758 | 21–68 |
| `pap_jingle` | **iwd** `iw_27.iwd:sound/SFX/Levels/zombie/perksacola/jingle/packa_jingle.wav` | `mx_packa_jingle` (streamed) | 49130 | 470 |

`fire` is the weapon's `fireSound` (third person, what other players hear); `fire_plr` is
`fireSoundPlayer` (first person; the stereo source downmixed to mono). Every clip was checked
non-silent (`volumedetect`: mean −8 to −23 dB, peaks at 0 to −5 dB).

### Sizes

| | Files | MB |
|---|---:|---:|
| `_weapons` | 22 `.glb` | 4.36 |
| `_powerups` | 5 `.glb` | 0.23 |
| `_fx` | 17 `.png` + `fx.json` | 0.25 |
| `_sounds` | 39 `.ogg` | 1.18 |
| `_assets.json` | 1 | 0.06 |
| **pack** | **85** | **6.08** (budget 15) |

A replay needs only its players' weapons (world ≈ 40–330 KB each) and the power-ups it shows;
the viewmodels (130–650 KB) only in first person.

## 3. `_assets.json` — what R3 builds against

Served at **`/mapdata/_assets.json`**, everything else under `/mapdata/` by the existing static
mount (`routes/replay.js mapsStatic`, `express.static` over `ZombiesDev\maps`; `_` directories
are skipped by `listMaps`). No server change: checked with a read-only GET on the running site —
`_assets.json` `application/json`, `.glb` `model/gltf-binary`, `.ogg` `audio/ogg`, `.png`
`image/png`, all 200. `.glb`s under `_weapons`/`_powerups` go through the same bucket 302 check
as the maps and, not being in the bucket, are served locally. URLs in the file are relative to
`base: "/mapdata/"`.

```
{ base, frame, build (hash of script+manifest),
  attach: { playerBone: "tag_weapon_right", weaponTag: "tag_weapon",
            localQuaternion: [0.7071,0,0,0.7071],          // engine rule, see below
            grip: { bone: "j_wrist_ri", position, quaternion, why, ... } },
  weapons: { <name>: { displayName, glb, viewGlb, world:{bytes,triangles,tags,bbox,...}, view:{...},
                       muzzle: { tag: "tag_flash", sprite, spriteUrl, position, viewPosition },
                       sounds: { fire, fire_plr, fire_pap, fire_pap_plr },
                       attach: { gripLocal: { bone: "j_wrist_ri", position, quaternion, gripPoint },
                                 engine: {...} },
                       pap: { displayName, glb | null, sameWorldModelAsBase?, viewGlb, muzzle, sounds, note? },
                       gameSounds, flashEffect, reticle } },
  powerups: { <kind>: { glb, xmodel, script, model, sounds:{pickup, announce, sting?, loop?, end?, each_zombie?},
                        glow:{sprite, spriteUrl}, spawnSound, idleLoop, groundLifeMs, blinkFromMs, durationMs? } },
  fx: { <name>: { url, w, h, blend, tint?, material?, image, zone, use } },  fxJson,
  sounds: { general: { hit_marker, player_hit, zombie_swipe, pap_*, powerup_* }, all: { <key>: { url, bytes, durationMs, source, alias } } },
  missing: { fire_sale } }
```

**Attaching a weapon to a player.** The engine's rule (`attach.playerBone`) puts the weapon's
root `tag_weapon` on the player's `tag_weapon_right`; the weapon `.glb` is already Y-up while the
player's bones are in engine orientation, so the weapon takes `localQuaternion` (+90° about X)
under the bone. **But `tag_weapon_right` is animated by the game's xanims**, and in the bind
pose — the only pose the viewer has (replay.md §9.6) — it sits 11.4 u from the wrist, beside
the hip (identical on all 19 T4 humanoid `.glb`s). So each weapon also has
**`attach.gripLocal`**: parent the weapon `.glb` to **`j_wrist_ri`** with that local
position/quaternion and its grip is in the palm, gun level and pointing the character's way in
the bind pose, following the procedural arm swing. It is `palm × translate(−grip)`: the palm
frame is the mean of `j_wrist_ri`, `j_index_ri_1`, `j_mid_ri_1` (1 u down), and the per-weapon
`grip` point (the rear pistol grip / the stock's wrist, in the weapon's frame) is **measured by
eye** on a side render with a 1-inch grid (`assets-manifest.yml`). Every stock gun's origin sits
~10 u ahead of that grip — the engine's convention, the same offset `tag_weapon_right` has. A
flat-shaded check render (Dempsey with the Thompson, a Marine with the Colt, side/top/3-4 views)
put both guns in the right hand; these are in `ZombiesDev\assetwork\shots\grip_*.png` (not
committed). **Muzzle**: the flash goes at the weapon's `tag_flash` (`muzzle.position`, weapon
frame; also a named node in the `.glb`), sprite `muzzle.spriteUrl`, additive.

## 4. How to add an asset

1. Find its zone and name: `Unlinker.exe --list --search-path "<game>\main;<game>\zone\english"
   <game>\zone\english\<zone>.ff > list.txt` (the lists this lane used are in
   `ZombiesDev\assetwork\list_*.txt`). For a sound, the loaded sound file is the
   `loadedsound, …` line(s) just before the `sound, <alias>` line; a streamed sound is a
   `sound/…` entry in an `.iwd` (`python -c "import zipfile; …"`).
2. Add a row to `tools/models/assets-manifest.yml`: a weapon block (weapon file + world/view
   xmodels + flash + muzzle sprite + sound keys + grip), a `powerups` block, an `fx` row
   (`zone`, `material` or `image`, `max`), or a `sounds` row (`zone` + `file`, or `iwd` + `file`;
   `stereo: true` to keep two channels, `quality:` to override q3). If the zone is not in
   `zones:` yet, add it with the asset types it needs (xmodel/material/image for models,
   loadedsound for sounds, localize for strings).
3. `python tools/models/export_assets.py` (add `--force` if you changed `zones:`); read the log
   line for the new asset, and check the budgets passed.
4. For a weapon, measure its grip: render it side-on with a grid (the throwaway
   `ZombiesDev\assetwork\grid_render.py`) and read the rear grip's x/y.

## 5. What could not be extracted, and why

* **Fire Sale** — not in World at War (§2).
* **Effects as effects.** OAT v0.33 does not dump T4 `fx` assets, so muzzle flashes, the
  power-up glow and the blood splat are the *sprites* the fx use, with the blend mode from their
  material; the particle behaviour (size over life, colour, count, velocity) and the
  flash→sprite pairing are **not** from the fx (zone order, §2). The power-up glow's green tint
  is by eye.
* **Sound aliases.** OAT does not dump T4 sound alias lists either, so volume, pitch variance,
  distance fall-off and the several variants of an alias (`player_pain_small` has 8,
  `attack_whoosh` 3, `mp40 act` 5) are not known; one file stands for the alias. The
  pack-a-punched guns' `weap_*_fire_ubershot_m` is taken as `uber_shot_m.wav` alone (zone order);
  the game may layer it with the base shot or the `uber_m_left/right` tails.
* **Hit-marker sound.** Stock WaW zombies has no hit marker; `damage_feedback` (the material)
  is in `common`, the sound is multiplayer's `MP_hit_alert`.
* **Swipe/hit sounds** are inferred: `attack_whoosh` and `player_pain_small` are the obvious
  aliases (the zombie melee scripts that would name them are not in these zones, and the
  notetracks in the attack xanims are not parsed).
* One image in `nazi_zombie_factory` fails to dump (`Unsupported IWI format: 9`, OAT); none of
  ours needs it.

## 6. Not proven

* **Not loaded in the viewer / three.js** (R3's lane). The `.glb`s were read back by this
  lane's own glTF reader and flat-shaded in Python (weapons, viewmodels, power-ups, the two
  held-weapon checks); `KHR_mesh_quantization` int8 normals are the same as the player models,
  which three.js loads.
* **The gold** is an approximation (spec RGB as base colour, half metallic); the game's gold is
  a specular/environment effect.
* **The grip** is by eye, and only in the bind pose; with real xanims the engine's
  `tag_weapon_right` rule is the right one.
* **Sounds not listened to** (levels checked, formats decoded).
* **Not run on another PC** or another game copy; the script's only machine-specific defaults
  are the paths above, all overridable.
