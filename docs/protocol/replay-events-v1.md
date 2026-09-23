# replay-events-v1 — what a replay records for the 3D viewer's weapons, shots, hits and power-ups

Lane R1, 2026-09-23. Owner of the DLL half: `server/components/replay/` and the reads in
`server/components/referee/t4_bind.cpp`. Lanes R2/R3 (the viewer) build against this file.

**Status: built, unit-tested, one DLL compile. NOT deployed and NOT seen in a real game.**
Section 7 says what is proven by what.

---

## 1. Versioning — how a viewer tells an old file from a new one

The container (`ENWR` magic, zstd NDJSON chunks, hash chain, signed footer) is unchanged, so its
`v` stays 0 and every existing verifier still works. What changed is what the DLL writes into the
event stream, and that is announced twice:

| Where | Field | Old files | New files |
|---|---|---|---|
| `map_loaded` event (from the DLL) | `replay_events` | absent | `1` |
| | `snap_hz`, `zombie_hz` | absent | `20`, `20` |
| `.enwr` header (host copies them from `map_loaded`) | `replay_events` | absent (read as 0) | `1` |
| | `snap_hz`, `zombie_hz` | absent | `20`, `20` |

`replay_events` absent or 0 means: players at 20 Hz, zombies on every other snap (10 Hz), a
player's `weapon` is the usercmd index as `"#37"`, and none of the events in section 2 exist.
The host copies the numbers from the DLL rather than asserting them, so a header can never claim
more than the build sent.

## 2. The events

Every event is one NDJSON line in the same stream as `snap`, `round`, `kill`, `points`, ...

**Two names differ from the lane brief, deliberately.** The brief wrote the time as `t` and the
player as `pid`. In this stream `t` has always been the event TYPE and the time has always been
`ms`; the player has always been `slot`. So: **brief `t` = our `ms`, brief `pid` = our `slot`**.
`ms` is the same clock as every `snap` (ms since the game link started; the track endpoint
already rebases it). Every other field name is exactly the brief's.

| `t` | Fields | When |
|---|---|---|
| `weapon` | `ms, slot, name, pap, raw` | the first frame a player is seen / respawns, and every time the gun in their hands changes |
| `fire` | `ms, slot, name` | one per shot (EV_FIRE_WEAPON or EV_FIRE_WEAPON_LASTSHOT), capped at 40 per player per second |
| `hit` | `ms, slot, zid, part, dmg` and `kill: true` on the lethal one | a player's damage to zombie entity `zid` |
| `damage` | `ms, slot, by, hp` | the player's health went down; `hp` is after; `by` is the zombie's entity number or `null` |
| `pap` | `ms, slot, name, raw, state` | `state: "start"` when the knuckle-crack animation begins (name = the gun going in), `"done"` the first time the player holds a given `_upgraded` gun |
| `powerup` | `ms, id, kind, x, y, z, state` + `by` + `until` | `state: "spawn"`, `"pickup"` (with `by`, and `until` for timed kinds) or `"expire"` |

Field notes:

- **`name`** is the gun: the engine name with `_upgraded` stripped (it becomes `pap: true`), then a
  leading `zombie_` or trailing `_zombie` stripped. `zombie_thompson_upgraded` → `thompson`,
  `pap: true`; `ray_gun` → `ray_gun`; `ptrs41_zombie` → `ptrs41`; `colt` → `colt`.
  **`raw`** is always the engine's own name, so nothing is lost. `fire.name` is the same label; when
  the weapon table is not bound it is `"#<index>"`.
- **`weapon`** fires for every switch, including the non-guns the scripts hand out:
  `zombie_knuckle_crack` (pack-a-punch), `zombie_perk_bottle_*` (a perk), and last-stand pistols.
  Weapon index 0 ("none") emits nothing; the next real gun is a switch.
- **`part`** is `"head"` or `"body"`. Head is the engine hit locations `head`, `helmet` and `neck`.
- **`dmg`** on a non-lethal hit is the zombie's health drop over one frame (pellets in the same
  frame are summed and credited to the last attacker). On the lethal hit it is **the health the
  zombie had left** — the engine does not keep overkill.
- **`kill: true`** marks the lethal hit. It is only emitted when the engine says a player killed
  it: the zombie's `lastAttacker` is that player **and** that player's native `kills` counter moved
  within two frames (or, if the actor was already freed, the one player whose `kills` moved). A
  zombie that dies to a nuke, a trap or the round-end cleanup gets no `hit`. The existing
  `kill {id, how: "entity_gone"}` event is unchanged and still fires for every death.
- **`by`** on `damage` is the entity G_Damage recorded as the player's last attacker, when that
  entity is a zombie. Your own grenade, fall damage or a scripted health change is `by: null`.
- **`powerup.id`** is the power-up's entity number. `kind` is one of `max_ammo`, `insta_kill`,
  `double_points`, `nuke`, `carpenter`, `fire_sale`, `death_machine`, `other`, from the model:
  `zombie_ammocan`, `zombie_skull`, `zombie_x2_icon`, `zombie_bomb`, `zombie_carpenter`,
  `zombie_firesale`/`zombie_pickup_firesale`, `zombie_pickup_minigun`/`_death_machine`, any other
  `zombie_pickup_*`. Verified against `add_zombie_powerup` in every stock `_zombiemode_powerups.gsc`
  (WaW has no fire sale or death machine; those names are for custom maps and are unverified).
- **pickup vs expire**: the model entity vanished with a player within 110 units (the script grabs
  at < 64, then waits 0.1 s before `delete()`) → `pickup`, `by` = the nearest player; otherwise
  `expire` (the stock timeout is 15 s + 40 blinks ≈ 26.5 s). `until = ms + 30000` for `insta_kill`
  and `double_points` (`zombie_powerup_*_time` is 30 on every stock map; a picked-up second one
  refreshes the timer in the script, and the viewer should take the latest `until`).
- A model that is already on the map at the first look (a mapper's prop) is scenery and never
  produces events.

Examples:

```
{"t":"weapon","ms":16484,"slot":0,"name":"colt","pap":false,"raw":"zombie_colt"}
{"t":"fire","ms":20150,"slot":0,"name":"colt"}
{"t":"hit","ms":20150,"slot":0,"zid":262,"part":"body","dmg":20}
{"t":"hit","ms":20450,"slot":0,"zid":262,"part":"head","dmg":130,"kill":true}
{"t":"damage","ms":31200,"slot":0,"by":265,"hp":50}
{"t":"pap","ms":402100,"slot":0,"name":"thompson","raw":"zombie_thompson","state":"start"}
{"t":"weapon","ms":402100,"slot":0,"name":"knuckle_crack","pap":false,"raw":"zombie_knuckle_crack"}
{"t":"pap","ms":409050,"slot":0,"name":"thompson","raw":"zombie_thompson_upgraded","state":"done"}
{"t":"powerup","ms":120300,"id":412,"kind":"insta_kill","x":120.5,"y":-300.2,"z":40.1,"state":"spawn"}
{"t":"powerup","ms":124900,"id":412,"kind":"insta_kill","x":120.5,"y":-300.2,"z":40.1,"state":"pickup","by":0,"until":154900}
```

## 3. What changed in `snap`

- `zombies` (and `nades`, `zombies_alive`, `kills_round`) are on **every** snap now: 20 Hz, not 10.
- A player record's `weapon` is the **engine name** (`"zombie_thompson_upgraded"`) when the weapon
  table is bound; the old `"#<usercmd index>"` only when it is not. Omitted when unchanged, as before.
- New per-player fields, each omitted when unchanged: **`clip`** (rounds in the magazine, what
  `getcurrentweaponclipammo` returns) and **`ammo`** (reserve, `getweaponammostock`).

## 4. Rate and size, before and after

"Today's rate" (read from the files, `infra/host-agent/tools/replay-rate.js`, 18 real box games
pulled from `/home/waw/zdev-host/replays`, 1,506 s of play, rounds 1-2):

| | Players | Zombies | MB per game-hour |
|---|---|---|---|
| before (recorded) | **20.0 Hz** (one per `SV_Frame`, 50 ms ±16 ms jitter from the 60 Hz frame loop) | **~8 Hz** averaged (10 Hz while any are up: every other frame) | **1.43** pooled (0.68–2.17 per game; mean 1.47 over the 15 games longer than 30 s — B's 1.55 is this figure on his set) |
| after, projected | 20 Hz | **20 Hz** | **2.31** pooled (x1.61) |

How "after" was projected, because no real 20 Hz file exists yet: `replay-rate.js --project`
re-encodes the same events with the host's own writer (zstd-10, 60 s chunks). The re-encode of the
file as-is is 1.32 MB/h (the files on disk are 8% larger than their re-encode; the ratio, not the absolute, is what is carried over); with every odd snap given an
interpolated zombie list it is **1.96** (x1.48); adding a synthetic replay-events-v1 load (4 shots,
3 hits per player-second while zombies are up, a damage per 10 s, a weapon switch per 20 s, a
power-up per 3 minutes, and the `clip`/`ammo` fields that follow the shots) it is **2.13** (x1.61).
Scaled to the real files: **1.43 → 2.31 MB/game-hour**.

The two honest caveats: interpolated positions compress a little better than real 50 ms motion
does, and these are early-round games with at most 8 zombies. The simulator's 4-player, 24-zombie
hour (`tools/measure-replay.js --zombie-hz 20`) goes **8.04 → 11.31 MB/h (x1.41)** for the zombie
rate alone. At either number the storage cost stays in cents a month (host.md §3a: $0.015/GB).

Compression was not changed: zstd-10 over NDJSON already removes most of the doubled zombie
stream (x1.48 on the bytes, not x2). The next real saving, if one is wanted, is the columnar
body host.md §3a and replay.md §3 describe, not a lower rate.

**Not changed, and worth knowing**: on one pathological box game (`m_64fbeba8`, fear_mc_2, the
frame loop fell to 3–5 Hz) players were recorded at 11 Hz. `SV_Frame` is the sampling point, and
when the game cannot keep 20 server frames a second the replay cannot either. Sampling inside
`G_RunFrame` (0x503AB0) would keep 20 Hz of *game* time through a catch-up, at the cost of a new
hook; not done here.

## 5. Where every number comes from

No new hook. Everything is a plain read once per server frame, after `SV_Frame`, and every group
is switched on only if the instruction bytes below are found in the running image
(`bind_combat()` in `t4_bind.cpp`; the bind log line is
`referee/bind: replay-events reads: weapons=yes events=yes attacker=yes hitloc=yes models=yes`).
Struct offsets are from T4SP-Server-Plugin `main` (`src/game/structs.hpp`, `enums.hpp`, local
clone `ZombiesDev\thirdparty\T4SP-Server-Plugin` @ `25f827d`); each was then found in use in our
own dump (`tools/re/t4map.py`, `codwaw-1.7-a.exe`, SHA-256 `732900D1…`).

| Read | Offset | T4SP | Our dump (the bytes `bind_combat` checks) |
|---|---|---|---|
| player's gclient | `level.clients + slot*0x2348`, cross-checked with `g_entities[slot].client` | — | referee.md §16.3 |
| `ps.weapon` | gclient + `0x104` | `playerState_s.weapon` | `getcurrentweapon` 0x4ED890 (method table 0x83C034): `8B B6 04 01 00 00` at 0x4ED906 |
| weapon name | `*(char**)bg_weaponDefs[w]`, `bg_weaponDefs` = `0x8F6770` | `WeaponDef.szInternalName` at +0 | 0x4ED910 `8B 14 B5 70 67 8F 00`, then `mov eax,[edx]` → `Scr_AddString` |
| clip | `ps.ammoclip[def->iClipIndex]` = gclient + `0x5FC` + `[def+0x3FC]*4` | `ammoclip[128]` @ 0x5FC | `getcurrentweaponclipammo` 0x4ED960: 0x4ED9F4 `8B 88 FC 03 00 00`, 0x4ED9FA `8B 94 8E FC 05 00 00` |
| reserve | `ps.ammo[def->iAmmoIndex]` = gclient + `0x17C` + `[def+0x3F4]*4` | `ammo[128]` @ 0x17C | `getweaponammostock` 0x4F0B40: 0x4F0C29 `8B 88 F4 03 00 00`, 0x4F0C2F `8B 84 8A 7C 01 00 00` |
| event ring | `ps.eventSequence` +`0xD0` (8-bit: `and 0xFF`), `ps.events[4]` +`0xD4` | same | `BG_AddPredictableEventToPlayerstate` 0x410310: `8B 90 D0 00 00 00 0F B6 C9 83 E2 03 89 8C 90 D4 00 00 00` |
| fire event ids | `EV_FIRE_WEAPON` 0x1C, `EV_FIRE_WEAPON_LASTSHOT` 0x1D | `entity_event_t` | the fire site 0x420C8A `B9 1D 00 00 00 75 05 B9 1C 00 00 00` (ecx = last shot ? 0x1D : 0x1C, then the add-event 0x412BF0) |
| last attacker | `gentity.sentient` +`0x188` → `sentient.lastAttacker` +`0x2C` (a `gentity*`) | `gentity_s.sentient`, `sentient_s.lastAttacker` | `G_Damage` 0x4F5D70: 0x4F6511 `8B 85 88 01 00 00 85 C0 74 03 89 70 2C`; `Actor_Pain` 0x4B6A3A and `Actor_Die` 0x4B6D2F store it too |
| hit location | `gentity.actor` +`0x184` → `actor.damageHitLoc` +`0xD68`, a **script string** id ("head") | `actor_s.damageHitLoc` (T4SP types it `__int16`; it is an SL id) | `Actor_Pain` 0x4B6870: 0x4B6882 `8B 9E 84 01 00 00`, 0x4B697D `66 89 83 68 0D 00 00`; `Actor_Die` 0x4B6AA0 writes it at 0x4B6BAD |
| entity model | `gentity.model` +`0x198` (uint16 model index) | `gentity_s.model` | `G_SetModel` 0x54AE60: 0x54AE78 `66 89 86 98 01 00 00` |
| model name | script string id at `0x2350F40 + index*2` | — | `G_ModelIndex` 0x54A480 compares the name's SL id with `word[esi*2+0x2350F42]`, i = 1..0x1FF: 0x54A4B0 `0F B7 0C 75 42 0F 35 02`; then `SV_SetConfigstring(0x58E+i, name)` |

`G_Damage` also confirms the world entity: the default attacker is `0x184A000` = entity 1022.

## 6. Where the logic lives, and its tests

- `server/components/replay/replay_events_model.hpp` — all the rules above, pure (no engine, no
  `windows.h`). `server/tests/replay_events_test.cpp`: **59 checks**, built with
  `cl /EHsc /std:c++17` (the pause_policy_test pattern): labels, JSON escaping, spawn/switch/pap,
  the fire ring (8-bit wrap, >4 events in a frame, the 40/s cap), damage attribution, non-lethal
  hits, lethal hits by attacker, by the kills counter with a late headshot counter, deaths nobody
  claims, power-up baseline/spawn/pickup/expire/unbound, reconnect and new match.
- `server/components/replay/replay.cpp` — reads and emits; `t4_bind.cpp` `bind_combat`,
  `player_combat_state`, `ent_damage`, `model_ents`.
- `infra/host-agent/tools/replay-rate.js` (+ 3 tests in `test/run-all.js`) — the rate and size
  numbers in section 4.

## 7. Proven, and not

| Claim | Proven by | Status |
|---|---|---|
| The event rules | 59 unit checks | **proven (logic only)** |
| The offsets and event ids | T4SP header **and** an instruction in our dump for each (section 5); re-checked in-process at bind | **statically proven**; no in-game read yet |
| The DLL compiles with the reads | one Release build, `/W4`, no warnings in these files | proven |
| Header `replay_events` / `snap_hz` / `zombie_hz` | host code + DLL `map_loaded` | not run end to end |
| 20 Hz zombies, real bytes per hour | projection only (section 4) | **unproven in a real game** |
| `weapon`, `clip`, `ammo`, `fire`, `hit`, `damage`, `pap`, `powerup` from the engine | — | **unproven: needs a player who shoots** |

Nothing here has run in a game: B is on the box, so no game was launched on his PC and no box DLL
was touched. An agent lease boots a server with no player, so `fire`/`hit` cannot be proven there.

### 7.1 The proof recipe (for the coordinator)

1. **Build the box DLL by the rule** (kickstart rule 17): clean detached worktree at the merge
   commit, record sha + rollback in `dedi.md`. Deploy only when no verified player is live (rule 13).
2. **Bind check, no player needed** (an agent lease is enough): the server log must say
   `referee/bind: replay-events reads: weapons=yes events=yes attacker=yes hitloc=yes models=yes`
   and `replay: sampler armed (players 20 Hz, zombies 20 Hz, replay-events v1: ...)`. Any `=no`
   comes with a `replay-events '<group>' OFF -- the code at XXXXXXXX ...` line with the bytes found.
   The replay header must carry `replay_events: 1`.
3. **The events need a human shooting.** There is no scripted shooter (no `ENW_CHAT_SELFTEST`-style
   hook exists for firing). The cheapest real proof is **B's next ordinary game on the box** after
   the deploy — a few rounds on Nacht or Der Riese. Then, on the pulled `.enwr`:
   `node infra/host-agent/tools/replay-rate.js <file> --json` must show `zombieHz` ≈ 20 while
   zombies are up and `counts` with `weapon`, `fire`, `hit`, `damage` > 0; and
   - `fire` count ≈ the magazine arithmetic: the drop in `clip` across the snaps between reloads
     equals the number of `fire` events in that span (the independent check on 0x1C/0x1D);
   - every `hit` with `kill: true` has a `kill {how:"entity_gone"}` for the same `zid` within
     100 ms, and the per-player count of `kill: true` equals that player's `kills` at game over;
   - `headshots` at game over equals the count of `kill:true, part:"head"`;
   - a Der Riese game with a pack-a-punch shows `pap start` then `pap done` with `_upgraded`;
   - a power-up spawn shows `spawn` then `pickup`/`expire` at the same `id`.
4. A local alternative, only when B is **not** at his PC: `tools\dev\jointest-proof.ps1` with a
   client a human drives (game lock held, rule 11 windows), same checks. There is no headless way.

### 7.2 Known limits

- Pellets and multiple hits on one zombie in one 50 ms frame are one `hit` (summed damage, last
  attacker, last hit location).
- A non-lethal `hit` trusts `lastAttacker`: a zombie shot by a player and then hurt by a trap in a
  later frame credits the trap damage to that player (rare in stock maps: traps kill).
- More than 4 events between two samples (a player firing faster than 80 rounds/s, or firing plus
  several other events) loses the oldest; `fire_capped` and the per-type counters are in the DLL
  log line `replay: events weapon N fire N (capped N) hit N ...` at game over.
- `damage.by` is the last attacker G_Damage recorded; a health drop that did not come from
  G_Damage (a script setting health) is attributed to whoever hit the player last, if a zombie.
- The pickup radius is a heuristic (110 u); a power-up that times out while a player stands on it
  would read as a pickup.
