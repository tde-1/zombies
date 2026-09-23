# referee — script hook points, detection strategy, and the in-process referee

> **2026-09-23 — Verified rules and record compliance: `verified-rules.md`.**
> - The referee now sends `dvar` (24 server dvars) and `client_dvar` (each client's reported
>   `com_maxfps`). `game_over` carries `dvars`.
> - The host's `lib/verified.js` refuses a Verified record on a reported rule break.
> - Spawn cadence on our dedi was measured equal to a listen server on Nacht.
> - `wait_network_frame()` makes Shi No Numa and Der Riese spawns ping-dependent. It is not yet
>   measured and needs a decision.
> - Map eligibility table: §7 there.

> ## STATUS AT HANDOVER (2026-09-20 04:00) — read this before anything below
>
> **The safe build for B:** `build.ps1 -Name referee` then `deploy.ps1 referee`, launched with **no
> extra environment variables**. In that configuration chat injection is **off**
> (`ENW_CHAT_INJECT` unset), the `level.*` probe is **off** (`ENW_LEVELVARS` unset), and the origin
> discovery is hard-bounded. Nothing in it is known to be able to crash a game. Do **not** set
> `ENW_CHAT_INJECT=1` on a game that matters — that path is unproven (see §8.8).
>
> ### Green — measured in a live game, and still true after the retractions
> * **Replay sampling at 19.2–19.5 Hz**, six independent runs, off `SV_Frame`. Player positions,
>   health and angles; zombie tracks via `classname`+`health`. A captured zombie read **health 150**,
>   exactly stock round-1 — an independent confirmation of two offsets at once.
> * **A full 7-minute capture with a moving player** (the crash fix landed in time for one):
>   430 s, 8,340 snaps at 19.4 Hz, 11,949 zombie rows, 638 `input` events, position bbox
>   x −248..968 / y −39..1092 / z −12..190. **11.44 MB/game-hour raw, 1.01 MB/h zstd-10.** See §8.9.
> * **Flags and notifies by name.** `VM_Notify` + `re`'s string table resolve real script names
>   (`all_players_connected`, `spawned_player`, …) with `ent: "level"` correctly attributed. This is
>   the `flag_set()` → `level notify()` mechanism (§2.8) that makes ~1,000 custom maps tractable.
> * **AFK input** from `client_s.lastUsercmd`: ~4 events in 5 idle minutes, which is correct.
> * **Chat capture stays silent in an idle game** — the assertion is in the DLL, not in my memory.
> * **Per-map finish detection: 10/12** against community tags on `archive`'s 14 real custom maps,
>   5/5 on the stock maps, 15/15 campaign maps correctly rejected (§3.5a).
> * **Script extraction** (`tools/re/ff_extract.py`) and the **`waw-base` repair** (nine corrupt
>   iwds, hash-verified against Steam).
>
> ### Amber — designed and coded, not proven
> Rounds and game over *as events* (the mechanism works; no capture has yet survived to a round
> transition or a death), `level.round_number` / score / knobs (all need `level.*`, which is
> **disproved** as of §8.7 — all four extractions scored zero), pause/restore, zombie counts in a
> real fight.
>
> ### Withdrawn — claims of mine that did not survive checking
> * **Chat injection "green"** → it was the *sender* not erroring; the address was a HUD colour
>   routine and the call corrupted a ring buffer. Now rebound to the verified `0x5A9350`, off by
>   default, acceptance test is *text visible in game* (§8.8).
> * **Chat capture** → same wrong address; no verified capture site exists for T4 co-op chat.
> * **The `currentOrigin` runtime cross-check** → non-deterministic across three runs; the one
>   agreement with `re`'s +0x160 was luck. `re`'s offset stands on their evidence, not mine.
> * **Three diagnoses of the 65-second wall** (engine pause → engine crash → my stack alignment).
>   All wrong; the cause was the bad chat address. Found by *differentials* (core-only vs full,
>   bare launch vs sink attached), never by reasoning forward from a mechanism (§8.7, §8.8).
> * **"Scanner 20/20"** → that was stock maps only; it scored **0/14** on real custom maps before
>   the fixes in §3.5a.
>
> ### The one thing I would tell the next person
> Every number in §8.6 came from runs my own bug was truncating at 65 s. A figure that repeats
> *identically* across different builds is not an environment quirk, it is a systematic cause in the
> constant factor — and the constant factor was me. Rates survived that; totals did not.

Scope: `server/components/{referee,replay,chat,afk,pause,knobs}/`, `referee/manifests/`, this file.
Rules: `docs/dev-box.md`. Output contract: `docs/protocol/game-link-v0.md`.

Status legend: **[C]** confirmed by reading the real extracted script · **[M]** measured in a running
game · **[U]** inference, not yet proven.

---

## 1. Getting the scripts out (done)

`tools/re/ff_extract.py` — our own code, written from the bytes, no third-party source copied.

WaW fastfile container, as observed on the Steam 1.7 zone files:

```
0x00  8 bytes  "IWffu100"      (compressed variants also use "IWff0100")
0x08  u32 LE   0x00000183      zone version, 387 = T4 PC
0x0c  ...      one raw zlib stream -> the zone blob
```

The zone blob is the in-memory image of the zone with every pointer written as `0xFFFFFFFF`. A T4
`RawFile` is `{ const char *name; int len; const char *buffer; }`, so a rawfile appears as

```
FF FF FF FF | len (u32 LE) | FF FF FF FF | name\0 | <len bytes, no trailing NUL>
```

Scanning for that signature finds every script without parsing the asset index — which is what we
want, because the same code has to survive ~1,000 third-party fastfiles built by a decade of
different modding tools. GSC and CSC are **plain text** in T4 (unlike T5, where rawfiles are zlib'd).

Extracted to `C:\Users\b\ZombiesDev\scripts\<ff-stem>\` (**never the repo** — Activision / author
content):

| Fastfile | zone | rawfiles |
|---|---|---|
| `nazi_zombie_prototype.ff` | 87.2 MB | 37 |
| `nazi_zombie_asylum.ff` | 119.3 MB | 41 |
| `nazi_zombie_sumpf.ff` | 134.1 MB | 52 |
| `nazi_zombie_factory.ff` | 143.2 MB | 59 |
| `*_patch.ff` (asylum/sumpf/factory) | ~1 MB each | 19 / 46 / 49 |
| `common.ff` | 43.9 MB | 403 (this is where `_utility.gsc`, `_load.gsc`, `_laststand.gsc`, `common_scripts/utility.gsc` live) |
| `nazi_zombie_ali/mod.ff` | 43.6 MB | 4 |
| `nazi_zombie_ali/nazi_zombie_ali.ff` | 109.5 MB | 86 |

### Two things the extractor taught us that the vault did not have

1. **Maps also ship loose GSC inside their `.iwd`.** `nazi_zombie_ali.iwd` carries its own
   `maps/_zombiemode.gsc` (54,805 B) that differs from the copy in its own `.ff` (54,555 B), and the
   second iwd in the same folder (`zombie_clinic.iwd`, the ZCT MOD2_MW mod) carries yet another
   (69,495 B) plus overrides of `maps/_callbackglobal.gsc`, `_laststand.gsc`, `_loadout.gsc`,
   `_gameskill.gsc`, `_zombiemode_spawner.gsc`, `_zombiemode_powerups.gsc`, `_zombiemode_perks_WoO.gsc`
   and `maps/woo_toolkit.gsc`. **So "read the map's `_zombiemode.gsc`" means "read every copy on the
   search path and work out which one wins", not "read the one in the map fastfile".** [C]
2. **The map's entity list is plain text in the fastfile too.** Searching the zone blob for
   `"classname" "worldspawn"` finds the `MapEnts` asset — for `nazi_zombie_ali`, 1,529 entities,
   150 KB of `{ "key" "value" }` text. That is how the buyable ending on that map was found, because
   it does not exist in script at all (§4). Any map-archive pipeline should dump this: it is the only
   way to see Radiant-only mechanics. [C]

---

## 1b. Corrections to the vault — facts in `11 - Implementation Reference` that are wrong

Every one of these was checked against the real extracted scripts, not against another document.
The coordinator is folding them into note 11; recorded here with the evidence so the correction is
auditable.

| Vault `11` §4 says | Actually | Evidence |
|---|---|---|
| "The round tracker uses `new_zombie_round`" | **`new_zombie_round` does not exist in any stock WaW script.** Grep across all four stock maps + `common.ff` + `nazi_zombie_ali`: zero hits. It is a *Plutonium* notify, from JezuzLizard's T4ZM round tracker, which is what the vault's source was describing. Waiting on it would hang forever. | `grep -rn "new_zombie_round" ZombiesDev\scripts\` → nothing |
| "`level notify("end_game")` when all are down" | **Only Der Riese does that.** `nazi_zombie_prototype`, `_asylum`, `_sumpf` and `nazi_zombie_ali` call `end_game()` **directly** from the damage callback with no notify at all. A referee that waits on the notify detects game over on one map in five. | factory `_zombiemode.gsc:2653` has the notify; prototype `:1685`, asylum `:2204`, ali `:1688` are direct calls |
| (not in the vault) | **The portable game-over signal is `level.intermission = true`**, the first statement of `end_game()` on every map including the custom one. This is what the referee should watch. | all five copies of `end_game()` |
| "Der Riese EE: flags `hide_and_seek`, `ee_*`" | Right, and now exact: `hide_and_seek` is the **start** (anti-gravity), completion is **all three** of `ee_exp_monkey`, `ee_bowie_bear`, `ee_perk_bear`. | `nazi_zombie_factory.gsc:1495` `flytrap()` |
| "Every map ships its own copy of `_zombiemode.gsc`, so always read the map's copy" | True but **not sufficient**, and this is the expensive one. A map can ship *several* copies across its `.ff` and its `.iwd` files, and a co-shipped mod's copy can win the search path. `nazi_zombie_ali` has three; the one that runs is in `zombie_clinic.iwd`, not in the map. "The map's copy" is not a well-defined thing. | §4 |
| (not in the vault) | **`flag_set()` fires `level notify(<flag name>)`** — `common_scripts/utility.gsc:435`. This is the single most useful fact for the referee and it was not recorded anywhere. | §2.8 |
| Vault `11` §2 lists `g_mem` size sites `0x5F5492/0x5F54D1/0x5F54DB` | `re` found those land mid-instruction; the real operand starts are `0x5F5491/0x5F54CB/0x5F54D5`, and the stock value is `0x12C00000`, not `0x19600000`. Not my finding — noting it here because it is the same note being corrected. | `docs/re/t4-sp-map.md` |

One vault fact I could **not** confirm and one I disproved at runtime, both outside §4:

* `11 §2` tags `Com_Frame` `0x59E330` as verified and "called once per WinMain loop iter".
  **It is never called** — see §8.4. Three independent measurements.
* `11 §6`'s pause pitfalls are all real and all visible in the scripts (the stuck-zombie watchdog is
  `round_spawn_failsafe()`); nothing to correct there.

---

## 2. Hook points, from the real scripts

Line numbers are in the extracted copies under `ZombiesDev\scripts\<map>\`.

### 2.1 Rounds
`maps/_zombiemode.gsc :: round_think()` is an infinite loop. At the bottom of each iteration:

```
level.zombie_move_speed = level.round_number * 8;
level.round_number++;
level notify( "between_round_over" );
```

(prototype `:1222-1226`, asylum `:1684`, factory `:2100`, ali `:1229`.)

* `level.round_number` starts at 1 (`:942`), or 7 under the devgui shortcut (`:101`). [C]
* **`between_round_over` fires *after* the increment**, so the value read at the notify is the round
  about to start. [C]
* **`new_zombie_round` does not exist in any stock WaW script.** The vault's note came from
  JezuzLizard's T4ZM round tracker, which is a *Plutonium* thing. Do not wait on it. [C]
* Round health scaling: `ai_calculate_health()` — `+level.zombie_vars["zombie_health_increase"]` per
  round to round 9, then `+= zombie_health * zombie_health_increase_percent` from round 10. [C]

### 2.2 Game over
Two different shapes, and this is a trap:

| Map | How it ends |
|---|---|
| `nazi_zombie_factory` (Der Riese) | `level notify( "end_game" )` (`_zombiemode.gsc:2653`), a thread waits on it |
| prototype / asylum / sumpf / **ali** | `end_game()` is **called directly** from the damage callback. No notify. |

Both paths set **`level.intermission = true`** as the first statement of `end_game()`. That field is
the portable game-over signal; the `end_game` notify is a bonus on Der Riese-derived maps. [C]

`end_game()` then: `update_leaderboards()`, the "GAME OVER / You survived N rounds" HUD, `intermission()`,
`level notify("stop_intermission")`, `player_exit_level` on everyone, then `ExitLevel(false)` (coop) or
`MissionFailed()` (solo). Der Riese also does `bbPrint("zombie_epilogs: rounds %d", level.round_number)`.
A clean server-side end should fire on `level.intermission`, not wait for `ExitLevel`. [C]

### 2.3 Down / revive / bleed-out (`common.ff :: maps/_laststand.gsc`)
| Event | Signal |
|---|---|
| down | `PlayerLastStand()` runs; `self.downs++` (`:97`); `self.revivetrigger` becomes defined — `player_is_in_laststand()` is literally `IsDefined(self.revivetrigger)` |
| down (notify) | `self notify("player_downed")` **only if** the "sticks and stones" collectible is active (`:138`) — useless to us |
| revive | `self notify( "player_revived" )` (`revive_success`, `:644`), `reviver.revives++` |
| bleed-out | `laststand_bleedout()` counts `self.bleedout_time` down from `player_lastStandBleedoutTime`, then calls `level.player_becomes_zombie` |
| bleed-out (zombies) | `_zombiemode.gsc :: zombify_player()` sets `self.is_zombie = true` and does `self notify( "zombified" )` |

So: **down = `player.downs` increments or `player.revivetrigger` appears; revive = `player_revived`
notify; bleed-out = `zombified` notify.** All three are engine-readable without any script of ours. [C]

### 2.4 Points
`maps/_zombiemode_score.gsc`. `player.score` is the spendable balance, `player.score_total` is the
career-in-this-game total, `player.stats["score"]` mirrors it. `add_to_player_score(cost)` /
`minus_to_player_score(cost)` are the only two mutators, plus `player_add_points(event, mod, hitloc)`
for kills. Penalties: `player_died_penalty()` and `player_downed_penalty()` take a percentage. `onPlayerConnect` seeds 500. [C]

No notify fires on a score change, so points are a **poll**: sample `player.score` in the same tick as
the replay snapshot and emit a `points` event on change. At 20 Hz that is exact enough to attribute a
purchase. [C/U]

### 2.5 The magic box (`maps/_zombiemode_weapons.gsc`)
`treasure_chest_think()` → `self waittill("trigger", user)` → `weapon_spawn_org waittill("randomization_done")`
→ on grab, `self notify("user_grabbed_weapon")` and `weapon_spawn_org notify("weapon_grabbed")`; on
move, `treasure_chest_move()` and `level.chest_index` changes; `level.zombie_treasure_chest_cost`
holds the price. The box's own `script_noteworthy` (`magic_box_north`, `ne_magic_box`, …) identifies
which spot it is on. [C]

### 2.6 Power
| Map | Signal |
|---|---|
| asylum | `flag_set("electric_switch_used")` (`nazi_zombie_asylum.gsc:1640`), then `level notify("master_switch_activated")` (`:1655`) and four `specialty_*_power_on` notifies |
| factory | `flag_set("electricity_on")` (`nazi_zombie_factory.gsc:778`), then the `specialty_*_power_on` notifies (`:798-804`) |
| sumpf | no power switch; `nazi_zombie_sumpf_perks.gsc:63` fires `master_switch_activated` during init — **do not treat that notify as "power on" generically** |
| prototype / ali | no power at all |

### 2.7 Doors and debris (`maps/_zombiemode_blockers.gsc`)
`door_think()` / `debris_think()` wait on `self waittill("trigger", who)`, check
`who.score >= self.zombie_cost`, call `minus_to_player_score(self.zombie_cost)`, move the brushmodel,
`add_new_zombie_spawners()`, then **delete the trigger**. Debris additionally does
`flag_set( self.script_flag )` if the mapper put a `script_flag` key on the entity (`:266`). [C]

There is **no notify for "a door was bought"**. What there *is*: the engine's own `"trigger"` notify
on the trigger entity, plus the entity's script fields (`targetname`, `script_noteworthy`,
`zombie_cost`, `script_flag`). That pair is enough, and it is generic. [C for the script side, U for
the engine firing `trigger` rather than script — to confirm with the notify hook]

### 2.8 Flags — the single most useful fact in this document
`common.ff :: common_scripts/utility.gsc:435`:

```
flag_set( message )
{
    level.flag[ message ] = true;
    level notify( message );          // <<<<
    set_trigger_flag_permissions( message );
}
```

and `flag_clear()` does the same when the flag was set.

**Every flag in every CoD script — stock or custom, Treyarch's or a 2012 modder's — announces itself
as a `level notify` whose name is the flag name.** One hook on the script notify path therefore sees
every easter-egg step, every zone unlock, every power switch, on every map, with no per-map code.
`level.flag` is also a script array on `level`, so the current state is pollable as well. [C]

### 2.9 Chat, input, positions
Not script at all — engine side, `client_s` / `usercmd_s` / `gentity_s`. See §5.4–§5.6.

---

## 3. Detection strategy — the decision

**Decision: C++ first. A per-map GSC is *not* required, and a replacement of any map file is
positively forbidden. The one GSC we do ship is a uniquely-named file that our own C++ loads
alongside the map's scripts, and it is only needed for the restore path.**

Confidence: **high** for the read side (rounds, game over, flags, notifies, score, downs, positions),
**medium** for the write side (knobs, pause, restore), **low-but-testable** for the co-loaded GSC.

### 3.1 Why C++ can see everything we need
| Thing | Mechanism | Per-map work |
|---|---|---|
| round | read `level.round_number`, confirm on the `between_round_over` notify | none |
| game over | read `level.intermission`; `end_game` notify where it exists | none |
| every EE / ending / zone flag | one hook on the notify path (§2.8) | a manifest line naming the flag |
| downs / revives / bleed-out | `player.downs`, `player_revived`, `zombified` notifies | none |
| points | poll `player.score` at snapshot rate | none |
| box / doors / perks | `"trigger"` notify + the entity's script fields | none |
| positions, health, weapon, angles, stance | `g_entities` + `svs.clients[]` | none |
| chat | the `say` client command + `SV_SendServerCommand` to inject | none |
| input / AFK | `usercmd_s` in `client_s` | none |
| knobs | script vars (`level.zombie_health`, `level.zombie_move_speed`, `level.zombie_vars[...]`) + dvars | none |

The two engine capabilities this rests on are:

1. **A hook on the script notify path.** In T4 the GSC `notify` statement and engine-side notifies
   funnel through one place (`Scr_NotifyNum` / the VM's notify opcode). T4SP-Server-Plugin `c79450e`
   names `Scr_NotifyNum`; we need its address and the shape of the notify record.
   **Open ask to `re`.**
2. **Reading and writing script variables on `level` and on a player entity.** T4 keeps script
   objects in the VM's variable table (`gScrVarPub` / `gScrVarGlob`), reachable by
   `FindVariable(parentId, canonical_string_id)`. T4SP `c79450e` exposes `gScrVarPub` and the
   `Scr_Get*`/`Scr_Add*` wrappers. **Open ask to `re`: `Scr_GetVariableField`-class helpers, the
   canonical string table, and the `level` object id.**

Neither of those is exotic — they are the bread and butter of every T4/T5 server plugin — but until
`re` lands them, everything in §3.1 is *designed and coded* but not *measured*.

### 3.2 Why we must not ship our own `_zombiemode.gsc`
Every map ships its own copy, and they genuinely differ: prototype 54,407 B, asylum 90,233 B via
`_patch.ff`, factory 90,233 B, ali 54,805 B (and a *second*, 69,495 B copy in the co-shipped ZCT mod).
Overriding it would replace the map's own logic and break the map. Overriding `maps/_load.gsc`
(which every zombie map reaches through `_zombiemode::main()`) is the least-bad *fallback*, but it
still collides with the minority of customs that ship their own, and it inherits the maintenance
burden of tracking six different vintages of the file. Rejected as the primary plan.

### 3.3 The GSC we *do* want, and how it gets in without colliding
For the restore path (§5.7) we need to call script builtins with script-object arguments
(`GiveWeapon`, `SetPerk`, `set_player_score_hud`, `SetOrigin`, `SetPlayerAngles`). Doing that purely
from C++ means hand-driving the VM stack; doing it from one small GSC thread is a page of code.

The plan, which collides with nothing:

* our script lives at a name no map will ever use — `maps/enw/_referee.gsc`;
* our C++ calls `Scr_LoadScript("maps/enw/_referee")` + `Scr_ExecThread(main)` after the map's
  `GScr_PostLoadScripts`, so it runs **alongside** the map's scripts rather than replacing anything;
* it registers our `enw_event()` builtin (the vault's §5.3 plan) so the script side can push
  structured events back, and exposes `enw_restore(player, state)`.

Because the filename is unique there is no precedence question at all, which is the whole point.
**Where the file goes** is settled by §3.4: it must be inside the active `fs_game` mod folder, so
our map installer drops it into each installed map's folder (we already own that pipeline — the
launcher pre-installs maps) and the server always runs with an `fs_game` set, even on stock maps.
This is the only part of the plan that needs the loader plus two addresses.

### 3.4 fs_game precedence — what we know and what is still open
The search path the engine printed for `+set fs_game mods/enw_fs_test` (measured) is:

```
<fs_homepath>/mods/enw_fs_test
%LOCALAPPDATA%\Activision\CoDWaW/mods/enw_fs_test     <- NOT redirected by fs_homepath
%LOCALAPPDATA%\Activision\CoDWaW/usermaps
%LOCALAPPDATA%\Activision\CoDWaW/mods
<fs_homepath>/main
<gamedir>/main/*.iwd    (iw_26 … iw_00, then localized_english_iw06 … iw00)
<gamedir>/main
<gamedir>/main_shared
%LOCALAPPDATA%\Activision\CoDWaW/players
```
[M, `homes/referee/mods/enw_fs_test/console.log`, 2026-09-20]

Two facts fall straight out: **`fs_game` folders under the *real* `%LOCALAPPDATA%` are always on the
path** (so a server could be tricked by whatever is in B's Activision folder — worth locking down),
and **`fs_homepath` moves `main` but not `players`**, which matches `dedi`'s finding.

**Answered by `dedi`'s probes p09/p10** (board, 00:16), which I was about to duplicate:

* a loose `maps/_load.gsc` in `<fs_homepath>\main` is **ignored** — the `.ff` rawfile wins, even
  though `<fs_homepath>/main` is printed first on the search path;
* the same file under `<fs_homepath>\mods\<name>\maps\` **with `+set fs_game mods/<name>` is used**.

So **a loose script is only consulted when a mod is active.** Consequences:

1. The `_load.gsc` fallback of §3.2 does exist, but only inside a mod. Still rejected as the primary
   plan for the collision reasons above.
2. **Our own script must live inside the active `fs_game` folder.** For a custom map that folder is
   the map's own (`mods/nazi_zombie_ali`), so the installer writes `maps/enw/_referee.gsc` into it;
   for a stock map the server sets `fs_game mods/enw`. Either way the server never writes into the
   stock install, which is what we wanted anyway.
3. Corollary for map hosting: **any map we install can override any common script**, and
   `nazi_zombie_ali` already does (via `zombie_clinic.iwd`). A "Verified" lobby therefore cannot
   assume stock `_laststand.gsc` / `_callbackglobal.gsc` behaviour. That is an argument for the C++
   read path over any script-based one: `player.downs` is a field the map can leave alone, a
   `maps\_laststand::` call site is not.

Open follow-up (probe staged at `<fs_homepath>\main\maps\_load.gsc`): is the gate "a mod is active"
or "the file is inside the mod folder"? If it is the former, one shared copy of our script in
`<fs_homepath>\main` serves every map and the installer never touches map folders. Result in §8.

### 3.5 What ~1,000 custom maps actually cost
`referee/scan_map.py` is the answer to this question rather than a guess about it. Point it at a
map's fastfiles and iwds and it reads every GSC (fastfile rawfiles *and* iwd copies, iwd winning as
the engine does) plus the `MapEnts` entity list, and proposes a finish. On the five maps we have:

| Map | Scanner verdict | Correct? |
|---|---|---|
| `nazi_zombie_prototype` | `round` — no EE or ending found | yes |
| `nazi_zombie_asylum` | `round` | yes |
| `nazi_zombie_sumpf` | `round` | yes |
| `nazi_zombie_factory` | `easter_egg` — `ee_bowie_bear`, `ee_exp_monkey`, `ee_perk_bear` | yes, exactly the three flags |
| `nazi_zombie_ali` | `buyable_ending`, plus "! overrides common scripts: `_callbackglobal`, `_gameskill`, `_laststand`, `_loadout`" | yes — **and it found the ending my hand analysis got wrong** (§4) |

**5/5 with no hand work.** So:

| Work | Per map | Why |
|---|---|---|
| rounds, game over, downs, revives, points, box, doors, positions, chat, AFK, knobs, pause | **0 min** | generic, §3.1 |
| "round N reached" badge | **0 min** | the default finish; no manifest file needed at all |
| finish proposed by the scanner | **0 min to propose, ~2 min to confirm** | it names the flags or the trigger and shows its reasoning |
| easter egg with a non-obvious completion condition | **5–30 min** | the scanner says *which* flags; a human still decides whether "done" is all three, or the last one, or a count |
| a map whose quest is Radiant-only | **not automatable** | ali's amulet quest. `{"manual": true}`; staff review or nothing |

The honest number: **for the large majority of the archive the per-map work is zero** — they get
Round N and the generic events for free. For the minority with a real finish, the scanner does the
reading and a human spends a couple of minutes confirming. Budget **an afternoon per hundred
interesting maps**, not a person-week per map.

### 3.5a The scanner scored 0/14 on real custom maps, and what fixed it
**This is the most important correction in this document.** The 20/20 below was measured on stock
maps and one custom map. The `archive` agent ran the same tool against **14 real third-party maps
and it decided none of them** — 12 returned `manual` and 2 guessed. Everything I claimed about
"near-zero per-map work" rested on a sample that did not contain the failure mode.

The failure was structural, not a tuning problem. On a stock install the shared zombie scripts live
in `common.ff`/`patch.ff`, which the scanner is never handed — it only gets `nazi_zombie_<x>.ff`. A
**custom** map ships its own copy of that whole script set inside `mod.ff`, so Treyarch's
`arcademode_ending_complete`, `dog_round_ending` and `ee_bowie_bear` appear *inside the map* and the
hint lists fire on Treyarch's code. Twelve maps failed on the same three words.

Four fixes, each measured against the corpus:

| Fix | Why | Effect |
|---|---|---|
| **Subtract a stock baseline** (`archive/stock-baseline.json`, 827 names) | makes "hint" mean "this map's own", which is all it ever meant to mean | the whole 12/14 `manual` block |
| **Token matching, not substring** | `vending_mulekick` contains "ending"; `floor_three_zone` contains "ee_" | removes the false hits, and makes short hints safe — "win" cannot match "window" |
| **Run hints over `MapEnts` targetnames too** | Leviathan has no EE flag in any of its 120 scripts; its quest is `ee_step_1_switch` / `ee_testtube_activate_trig`. MW2 Rust's ending is a trigger named `end_game` | finds the entity-only maps |
| **Gate corpus-common names, don't drop them** | `end_game` survives the baseline and appears on 14/14. Dropping it costs three maps their real ending; keeping it makes every map identical | a corpus-common name counts only if **this map's scripts look it up** — the same orphan test that found the `nazi_zombie_ali` ending |

Plus one rule that is **not a word list**, and generalises better than one: `numbered_series()`.
City of Hell's quest is `city_part01..05`; Minecraft Village's is `gumball_switch1..5`. Neither map
contains a single easter-egg-shaped *word*, so no hint list would ever find them — but the *shape*
is unmistakable. It finds `<stem><number>` families of ≥3, excludes structural furniture by stem
(zone/spawner/clip/node/…) and requires the stem to name a plausible quest object. Left
unconstrained it fired on 14/14 and said `easter_egg` about everything, which is the same
worthless-because-universal failure the baseline was introduced to fix.

**Result: 0/14 → 10/12** against the community's own finish tags, with verdicts that discriminate
(4 buyable_ending, 8 easter_egg, 2 round) rather than all agreeing. The two remaining misses are
honest: `nazi_zombie_orbit` has only `orbitron_lock`/`orbitron_switch` (not numbered, no quest word)
and `sanatorium` has no own flags or quest-shaped entity names at all.

**And a regression the re-run caught:** subtracting the baseline from a *stock* map erases that
map's own evidence — Der Riese flipped `easter_egg` → `buyable_ending` because `ee_bowie_bear` is
*in* the baseline (which is built from the stock zones, Der Riese included). Fixed with a rule
correct for both cases: a name written in the map's **own** map script (`maps/<bsp>.gsc`, as opposed
to the shared `_zombiemode`/common set) is the map's own whatever the baseline says. Re-verified:
5/5 on the original stock maps, 15/15 campaign maps still rejected, 10/12 on the real corpus.

### 3.5b How often does the scanner need a human? — measured on stock maps only (superseded by §3.5a)
Only five zombies maps exist on this box, so I ran it over **all 20 local fastfiles**, using WaW's
15 single-player campaign maps as an adversarial negative control. That turned out to be the useful
half of the experiment.

**First run — the scanner failed badly on the campaign maps: 10 of 15 wrong** (7 false
`easter_egg`, 3 false `manual`). Campaign scripts are full of flags named after radio towers, clock
towers and collapsing towers — `ber1` proposed `clock_tower_battle_timeout`, `see2` proposed
`radio tower destroyed`, `pel2` proposed `flame_tree_*` off 140 flags. And the hints are not wrong
to match those: "tower" and "radio" *are* real easter-egg words in zombies (Shi No Numa's radios).
The heuristic cannot separate them and should not try.

**The fix is a gate, not better hints**: a zombies map loads `maps\_zombiemode`; a campaign map does
not. With that gate:

| Population | n | Correct | Needed a human |
|---|---|---|---|
| Zombies maps (4 stock + `nazi_zombie_ali`) | 5 | **5** | 0 |
| Campaign maps (adversarial negative) | 15 | **15** (all `not_a_zombies_map`) | 0 |

20/20. Results in `C:\Users\b\ZombiesDev\scripts\scan-results\*.json`.

What this does and does not tell us. It says the scanner is **safe to point at a whole archive** —
it will not invent an easter egg on something that is not a zombies map, which was the failure mode
that would actually cost us a wrongly awarded badge. It does **not** yet say how often it needs help
on *real custom zombies maps*, because n=1 (`nazi_zombie_ali`, which it got right where I did not).
That number needs the archive. My expectation, from the shape of the five: the common cases are
"no easter egg → Round N" and "one conspicuous purchase → buyable ending", both of which it nails;
the human cost is concentrated in maps that *do* have a multi-step quest, where the scanner names
the flags and a person still has to decide whether "done" means all of them, the last one, or a count.

Two caveats that are not nothing:
* The heuristics were tuned on a handful of maps and have already been narrowed twice — once because
  `rise_anim_finished` matched "finish", once by the zombies gate above. Expect to keep tuning. A
  false "manual" costs five minutes of reading; a false `easter_egg` would cost a wrongly awarded
  badge, which is why the scanner *proposes* and never commits.
* A map that overrides common scripts (ali overrides four) needs a smoke test that the *generic*
  events still fire on it. That is a test run, not authoring, and the scanner flags which maps need it.

---

## 4. `nazi_zombie_ali` — the custom test case, and what it teaches

The README advertises "you have to find 6 piece of amulet to open main door" and "Buy-able-ending".

**Read the map's own scripts and you find neither.** `maps/_zombiemode.gsc` (in the map's `.ff` and
again in `nazi_zombie_ali.iwd`) is stock Nacht der Untoten plus three `add_zombie_hint` lines;
`maps/nazi_zombie_ali.gsc` is a Script Placer template with a fan spinner and five `sethintstring`
hints; `maps/_interactive_objects.gsc` is Treyarch's stock destructibles file. The word "amulet"
appears nowhere. What *does* stand out in the entity list is one
`trigger_use targetname=zombie_door zombie_cost=50000` when every other door on the map costs
50–3,500. I spent an hour concluding that buying that door was the ending.

**That was wrong, and `referee/scan_map.py` caught it.** The folder ships a third copy of
`maps/_zombiemode.gsc`, inside `zombie_clinic.iwd` — the ZCT MOD2_MW mod the README says the map
needs. The engine printed `zombie_clinic.iwd` **first** on the search path, so its 69,495 B copy is
the one that runs, and only it has the ending:

```
_zombiemode.gsc:114    thread end_game_trig();
end_game_trig()        end_trig = getentarray( "end_game", "targetname" );
end_game_trigger()     cost = 20000;                      // hardcoded, NOT a zombie_cost key
                       "Press &&1 To ^2GET OUT OF CLINIC^3..."
                       level.tom_victory = true;  end_game();
end_game()             level.intermission = true;  level.finalcutscene = true;
                       game_over SetText( level.tom_victory ? "YOU WON" : "GAME OVER" );
```

So the detector is **`level.tom_victory == true`**, and the `trigger_use targetname=end_game` I had
written off as an orphan is the ending trigger. The 50,000-point door is a red herring. The
manifest now keys on `tom_victory` with the trigger + `intermission` pair as a fallback.

Four lessons, and the third is the expensive one:

1. **A map's advertised finish may still not be detectable.** The 6-piece amulet quest genuinely
   does not exist in script; it is hints and geometry. The manifest schema has a `{"manual": true}`
   escape hatch and a `confidence` field for exactly this. An ungated badge is worse than a missing one.
2. **Entity data matters as much as script data**, and both are plain text in the fastfile.
3. **"The map's scripts" is the wrong unit.** A custom map can ship a whole mod alongside itself and
   the mod's copy of a common file can win the search path. Anything that reads one file by name
   will get the wrong answer. This is also why the referee reads *engine* state
   (`player.downs`, `level.intermission`) rather than hooking script call sites: a mod can replace
   `maps\_laststand::PlayerLastStand`, but it is not going to stop the field being written.
4. **Automate the read.** `scan_map.py` (§3.5) gets the finish right on 5/5 of the maps we have,
   including this one, in seconds. My hand analysis got 4/5.

---

## 5. The components (`server/components/`)

All six are written against `shared/core`'s `component` / `game_link` API. Each is split into a
*logic* half that has no game dependency (and is therefore testable and reviewable now) and a *bind*
half that needs addresses from `shared/t4/`.

| Component | What it does | Blocked on |
|---|---|---|
| `referee/` | notify hook → `notify`/`round`/`game_over` events; manifest condition evaluation lives host-side | `Scr_NotifyNum`, `level` object id |
| `replay/` | 20 Hz player / 10 Hz zombie sampler → `snap` | `g_entities`, `svs`, `level.time` |
| `chat/` | capture `say`/`say_team`, inject via `SV_SendServerCommand` | `Cmd_AddCommand`, `SV_SendServerCommand` |
| `afk/` | per-client `usercmd_s` diff → `input` at ≤10 Hz | `client_s` layout |
| `knobs/` | dvar + script-var writes at runtime | script var write |
| `pause/` | engine-side freeze + `snapshot_state` | `G_RunFrame` / `SV_Frame` |

### 5.1 referee
Hook the notify path once. For each notify emit `{"t":"notify","ent":"level"|"player:<slot>"|"ent:<num>","name":...}`
subject to an **allow-list plus a novelty budget** (never flood the link: at most N distinct unseen
names per round get promoted to the wire; the rest are counted). Maintain `level.round_number` and
`level.intermission` by polling once per server frame — two reads, negligible.

Why an allow-list *and* a budget: §2.8 means we see *everything*, including per-frame animation
notifies. The interesting ones are (a) the map's manifest flags, (b) a fixed generic list
(`between_round_over`, `end_game`, `player_revived`, `zombified`, `user_grabbed_weapon`,
`weapon_grabbed`, `trigger`, `*_power_on`, `master_switch_activated`), (c) anything matching
`ee_*`/`flag`-shaped names we have not seen before — which is exactly how we'd discover an unknown
custom map's easter egg without reading its scripts.

### 5.2 replay sampling
20 Hz players / 10 Hz zombies, from the game frame. The server runs at `sv_fps 20`, so "20 Hz" is
one sample per server frame and "10 Hz" is every other frame — no interpolation, no extra thread.
Per player: slot, pos, angles, health, score, weapon, stance, alive. Per zombie: id, pos, health.
Emitted as one `snap` per tick. Size estimate and the real measurement are in §7.

### 5.3 chat
Capture: T4 routes a client's `say` through the server command handler. Register/hook it, emit
`{"t":"chat","slot":n,"text":...}` **before** the engine prints it, so the host can suppress.
Inject: `SV_SendServerCommand(client_or_NULL, "c \"...\"")` — the same path the engine uses for
`iprintln`. Cross-server relay and the 24-h warnings both ride this.

### 5.4 AFK
`client_s` holds the last `usercmd_s`. Per client per frame, compare `buttons`, `forwardmove`,
`rightmove`, `viewangles` with the previous; emit an `input` event at ≤10 Hz and only on change.
AFK scoring (the vault's "active time is a risk/trust score") is host-side; the DLL only reports.

### 5.5 knobs
Two kinds. **Dvars** (`g_speed`, `player_lastStandBleedoutTime`, `sv_fps`, …) via `Dvar_FindVar` +
set. **Script variables** — `level.zombie_health`, `level.zombie_move_speed`,
`level.zombie_vars["zombie_spawn_delay"]`, `level.zombie_vars["zombie_max_ai"]`,
`level.zombie_treasure_chest_cost`, `level.round_number` — via the script var write path. The second
kind is the interesting one, because that is where zombie health, speed, max-alive, start round and
the points economy actually live. Note `ai_calculate_health()` **recomputes** `level.zombie_health`
every round from its own previous value, so a health knob must be re-applied per round or applied as
a multiplier the referee owns.

### 5.6 pause
Vault `11 §6` lists the traps and they are all real in the scripts we now have: `timescale 0` stalls
every `wait` (and the client reports "Connection Interrupted"); map scripts re-enable controls;
`round_spawn_failsafe()` (`_zombiemode.gsc:1274+`) is the stuck-zombie watchdog that will kill frozen
zombies; board-tearing is anim-driven; box/trap timers keep running. Hence the plan is an
**engine-level** freeze in our DLL rather than a script one: skip the AI think and the player usercmd
apply in the frame hook, hold the bleedout and powerup timers by advancing their deadlines, and leave
`timescale` alone.

### 5.7 state snapshot / restore
`snapshot_state` returns, per player: score, `score_total`, weapons (`GetWeaponsListPrimaries`, with
`_upgraded` suffix = Pack-a-Punched, `has_altmelee` = Bowie), perks (`HasPerk`), position, angles,
health, downs/revives, plus `level.round_number` and the flag set. Restore is the one path that wants
the co-loaded GSC of §3.3, because `GiveWeapon`/`SetPerk`/`SetOrigin` on a player object are script
calls.

---

## 6. Prior art: IW4MAdmin's zombies model (MIT), and where we match it

Read from the actual source, cloned to `C:\Users\b\ZombiesDev\thirdparty\iw4m-admin-zombiestats`
(`RaidMax/IW4M-Admin`, branch `feature/zombie-stats`, MIT — LICENSE read). Files that matter:
`Data/Models/Zombie/ZombieEventLog.cs` (the `EventLogType` enum, 34 values),
`Plugins/ZombieStats/Events/ZombieEventParser.cs` (the wire format),
`GameFiles/GameInterface/_integration_shared.gsc` (the transport). Note their **T4 zombies emitter
itself is a closed premium plugin** — the in-game side is still ours to write, which is this job.

### 6.1 Their wire format
Semicolon-delimited lines pushed through `LogPrint()` into the game log and tailed by the admin
tool. Top-level prefix `GSE`, then a type:

```
GSE;K  ;...                           player killed
GSE;D  ;...  GSE;AD;...  GSE;AK;...   damage / zombie damage / zombie killed
GSE;RD ;...                           per-player round data
GSE;RC ;<round>                       round complete
GSE;ZP ;<player block>;<category>;... player-scoped: down revive perk powerup weapon
                                      box door trap build gum bank locker
GSE;ZW ;<kind>;<args>                 world-scoped:
       round_special;<round>;<type>
       zombies;<round>;<remaining>;<alive>
       power;<state>;<source>;[player]
       easter_egg;step;<key>          e.g. key "t4_vr_radio_1"
       easter_egg;complete;<map>
```

### 6.2 Where our manifests and events now match theirs
Our `signals[].id` values are aligned to their `EventLogType` names so a row can go either way
without a translation table:

| Ours | Theirs (`EventLogType`) |
|---|---|
| `power_on` / `power_off` | `PowerOn` / `PowerOff` |
| `door_bought` | `DoorPurchased` |
| `box_used` | `BoxTake` (their `BoxPass` / `BoxTeddy` are worth adding once we can see the box result) |
| `pap_used` | `WeaponUpgraded` |
| `perk_bought` | `PerkConsumed` |
| `ee_step` (+ a `step_key`) | `EasterEggStep` (+ `TextualValue` = step key) |
| `easter_egg` finish | `EasterEggCompleted` |
| `down` / `revive` | `Downed` / `Revived` + `WasRevived` |
| `round` | `RoundCompleted` |
| `game_over` | `MatchEnded` |

Manifest EE signals carry a `step_key` in their namespaced form (`t4_<map>_<step>`) so the two
event logs are comparable.

### 6.3 Where we deliberately differ, and why
1. **`buyable_ending` has no equivalent in their model.** Their 34 event types have no slot for it,
   because Treyarch maps do not have one — it is a custom-map and ZWR convention. Our badge model
   (`05 - Profiles, Parties & Badges`: Easter Egg > Buyable Ending > Round N) needs it, so it is a
   first-class `finishes[].id` on our side and simply absent on theirs.
2. **One badge per map, in priority order.** Theirs is a stats schema; it records everything and
   ranks nothing. Our `finishes[].priority` and `badge.main_finish` are ours; nothing to align.
3. **Their EE steps are hand-authored keys in a closed premium emitter. Ours fall out of the flag
   notify hook for free (§2.8).** That is the real difference in reach: they cover the maps someone
   wrote an emitter for; we get a step stream on every custom map in the archive without touching
   it. We keep their key *format* so a hand-curated key can override the raw flag name.
4. **`ZW;zombies;<round>;<remaining>;<alive>` is a good idea we did not have** — a periodic
   spawn-state snapshot, emitted when either count changes. It is what a live dashboard and any
   seconds-per-horde metric want, it is two reads, and our `snap` does not carry it. **Adopted**: the
   referee should emit a `zombies` event on change, at most every few seconds.
5. We drop their T6/T7-only types (bank, weapon locker, gobble gum) and `PerformanceCluster`.

### 6.4 The `LogPrint` mirror — approved and built, off by default
The case for: it is a **proven** T4 transport, it needs no socket, it survives the DLL's TCP link
being down or absent, and it makes an ENW server readable by an existing, maintained, MIT admin tool
that people already run. `libcod` does not support WaW, so `LogPrint` into the log is genuinely the
only other outbound channel that exists on this engine.

The case against it as the *primary*: it is a text log tail. No ordering guarantee against our own
events, no backpressure, no framing for a 1.2 KB 20 Hz `snap`, and the line goes through the
engine's console formatting. For replays and records — the things badges and bans hang off — we want
the socket.

**Decided (coordinator, 2026-09-20) and built.** NDJSON over TCP stays the contract; dvar
`enw_logprint_events` (default `0`) mirrors the *event* subset — never `snap`, never `input` — as
`GSE;…` lines. `server/components/referee/logprint_mirror.{hpp,cpp}`, documented in
`docs/protocol/game-link-v0.md`.

One extension: `GSE;ZW;buyable_ending;<round>;<map>`. Their parser throws on an unknown `ZW` kind
and drops the line with a warning, so it is safe against a stock IW4MAdmin. Fields are sanitised
(`;`, CR, LF → `_`, 128 chars) because a custom map's flag name is author-supplied and their parser
has no unescape step — a `;` in a flag name would silently shift every field after it.

## 7. Open asks

For **`re`** (in priority order):
1. `Scr_NotifyNum` (or whatever the VM's notify opcode calls) — address and signature. This is the
   single hook the whole referee rests on.
2. Script variable access: `gScrVarPub`/`gScrVarGlob`, `FindVariable`, the canonical-string table,
   and the object id of `level`. Enough to read `level.round_number` and write
   `level.zombie_vars["..."]`.
3. `g_entities` (0x176C6F0) + `gentity_s` layout for origin/angles/health, and `svs` (0x23D5C80) +
   `client_s` for `usercmd_s`, `name`, `userinfo`.
4. `SV_SendServerCommand` and `Cmd_AddCommand` (chat in/out).
5. `Scr_LoadScript` / `Scr_ExecThread` (the co-loaded GSC of §3.3).

For **`host`**: the manifest condition grammar is in `referee/manifests/_schema.md`; the evaluator
belongs on your side, since it must survive a game crash and be re-runnable over a stored replay.

For **B** (in `questions.md`): none blocking.

---

## 8. Measurements

### 8.1 fs_game / script precedence
Answered by `dedi` p09/p10, written up in §3.4. My own probe (`homes/referee/mods/enw_fs_test/`)
was staged and then stood down rather than duplicate the launch. The follow-up probe
(`<fs_homepath>\main\maps\_load.gsc` + an *empty* `fs_game` mod) is staged; see §8.5.

### 8.2 Search path, measured
Printed by the engine with `+set fs_game mods/enw_fs_test`
(`homes/referee/mods/enw_fs_test/console.log`, 2026-09-20) — see §3.4 for the listing. Two facts
worth acting on: **`%LOCALAPPDATA%\Activision\CoDWaW\mods`, `\usermaps` and `\mods\<fs_game>` are on
the path regardless of `fs_homepath`**, so a server inherits whatever is in the real user profile;
and `fs_homepath` redirects `main` but not `players`.

### 8.3 Replay size
Real capture needs the loader. Until then `server/components/replay/estimate_snap_bytes.py`
reproduces `replay.cpp`'s encoder exactly (same fields, 0.1-unit positions, 0.1-degree angles,
omit-unchanged) over synthetic but deliberately busy motion — four players always moving, zombie
count on the stock curve with no between-round lull, `sv_fps 20`:

| | raw NDJSON | gzip -6 | zstd -10 | mean snap |
|---|---|---|---|---|
| 4 players | 85.1 MB/game-hour | 13.2 MB | **12.1 MB** | 1,239 B |
| solo | 44.9 MB/game-hour | 6.5 MB | **5.8 MB** | 654 B |

So **~12 MB per co-op game-hour compressed**, on the v0 NDJSON-in-zstd format — roughly **double the
vault's 5 MB/hour assumption**. These are estimates with a stated method, not measurements; replace
them the moment a real game can be captured.

#### What it would cost to halve it
Measured, not guessed — `estimate_snap_bytes.py --compare` runs each trade-off through the same
encoder (4 players, 30 min, zstd-10):

| Variant | MB/game-hour | vs v0 | What you give up |
|---|---|---|---|
| v0 (players 20 Hz, zombies 10 Hz, 0.1 unit) | 11.56 | 100% | — |
| players 10 Hz | 10.07 | 87% | record fidelity, for almost nothing |
| delta positions (in text) | 10.91 | 94% | nothing — but zstd already found it |
| **1-unit positions** | 7.50 | **65%** | nothing visible: 1 WaW unit ≈ 1 inch |
| **zombies 5 Hz** | 7.36 | **64%** | slightly steppier zombie paths in the viewer |
| **1-unit + delta + zombies 5 Hz** | 4.72 | **41%** | the two above, together |
| no zombie tracks at all | 2.65 | 23% | the 2D view is players-only |

**The headline: zombie tracks are ~77% of the bytes.** Everything else is rounding error by
comparison — halving the *player* rate saves 13% and costs exactly the thing records depend on.

My recommendation, in order:
1. **Quantise positions to 1 unit everywhere, now.** 35% off, costs nothing anyone can see, and it
   applies to the columnar format too.
2. **Zombies at 5 Hz for ordinary games, 10 Hz for record and Verified games.** Another ~35%, and
   the games where zombie paths matter for verification are exactly the ones we would keep at 10 Hz.
3. **Never drop the player track or its rate.** It is the cheap part and the one that carries records.
4. Delta coding is not worth doing in the text format — zstd already captures it. It *will* pay in
   the columnar CBOR format (99 §5.4), where positions become int columns.

1+2 gives **~4.7 MB per co-op game-hour**, under the vault's assumption, before the columnar format.
Solo is 2.0 MB/hour on the same settings. The one thing I would not do is drop zombie tracks
entirely: a replay with no zombies cannot show *why* a round went wrong, which is most of what a
zombies replay is for.

### 8.4a Bindings, after `re` published the server-side sites (01:20)
`re` found why nothing ticked: the renderer bring-up at **0x5FF4E0** runs before WinMain's loop and
is not gated by `com_dedicated`, so a dedicated server never reaches the loop and `Com_Frame` is
never called. That single fact explained my three measurements in §8.4 and dedi's D3D re-entry at
once. With their addresses, a client-mode launch now logs:

```
referee/bind: notify=no scriptvars=no entities=yes clients=yes servercmd=yes chatin=yes frame=yes
game-link: connected to 127.0.0.1:28960
chat: armed (capture on, inject on)
```

| Capability | Bound on | Note |
|---|---|---|
| frame tick | `SV_Frame` 0x635CC0 | chosen over `Com_Frame` 0x59E330: server-authoritative and does not run pre-map |
| clients | `svs.clients[i]` = `0x2547090 + i*0x58D30` | name +0x11548, userinfo +0x6F0, gentity +0x11544; xuid parsed out of userinfo |
| entities | `g_entities[i]` = `0x176C6F0 + i*0x378` | positions via the discovery below |
| chat out | `SV_GameSendServerCommand` 0x648490 | `__fastcall`, ecx = clientNum, −1 broadcasts |
| chat in | `G_Say` 0x473F10 | hooked in preference to `ClientCommand`: the text is a plain argument, so no `Cmd_Argv` needed |

**The transport is proven in both directions**: my sink accepted the DLL's TCP connection and pushed
three `say` commands down it during a live game.

**Two offsets are still not published, and I did not guess either.**
* `gentity_s` currentOrigin/currentAngles — somewhere in the 0x68 bytes between `r` (+0x118) and
  `client` (+0x180). Instead of picking one, the DLL finds it at runtime: scan that window for
  triples of finite floats inside worldspace, then across 128 entities and many frames keep only the
  offset whose values *move* by a sane amount. A bounding box does not move on its own, a counter
  aliased as a float jumps absurdly, a position walks. It scans all entities rather than just the
  player because an unattended capture has a player standing still — zombies are what move. The
  winner is logged once as a measured fact for `re` to fold into `shared/t4`.
* `client_s.lastUsercmd` — needed for AFK. It falls out of `re`'s 0x630BF0 site but is not extracted
  yet, so `last_usercmd()` returns nothing rather than reading a guessed offset into a 0x58D30
  struct. Same for `gentity_s.health` and the entity classname, which is why `zombie_ents()` still
  returns 0: a replay full of mislabelled entities is worse than one with none.

### 8.4b Chasing the capture found a corrupt `waw-base` — the most useful accident of the night
Client mode kept dying before `+map` on `ERROR: image 'images/sun_flare.iwi' is missing`, which
raises a modal `Error` box the game never gets past. Rather than work around the dialog, I went
looking for the image, and the trail ended somewhere unexpected:

* `sun_flare.iwi` lives in `iw_08.iwd`.
* The engine's own search-path listing mounts **26 iwds totalling 24,419 files** — and 24,419 is
  exactly the sum of the iwds that open as valid zip archives. It silently skips the rest.
* Nine files in `waw-base\main` do not open: `iw_06, iw_08, iw_13, iw_14, iw_20, iw_23, iw_27,
  localized_english_iw03, localized_english_iw04` (~1.1 GB). They have the **right byte length** and
  a **zero-filled tail**, and they are not sparse.
* `iw_08.iwd`: Steam sha256 `1d5382dc…`, `waw-base` copy `fa8f69d2…`. `iw_00.iwd` hashes identical,
  so the copy is only partly broken.
* **B's Steam install is fine** — all 35 iwds valid, appmanifest `StateFlags 4`,
  `BytesDownloaded == BytesToDownload`. This was our copy, not her game.

Repaired by re-copying those nine from the read-only Steam install; all 35 now open, `iw_08` hashes
match, `sun_flare.iwi` is back. Per-agent copies junction to `waw-base\main`, so every agent gets the
fix without re-running `new-copy.ps1`.

**The lesson worth keeping**: the corruption had *correct file lengths*, so any size-based copy check
passes it, and the engine reports nothing at all — it just quietly mounts fewer archives and then
fails much later with a missing-asset error that points nowhere near the cause. Whatever builds
`waw-base` should verify content (a hash, or simply "does every `.iwd` open as a zip"). It is also
worth re-examining any "missing asset" failure anyone has attributed to something else.

### 8.4 The components run in a real game — and the frame source was the blocker
All six components build into `enw_t4.dll` and load in a live dedicated game
(`+set dedicated 1 +set zombiemode 1 +map nazi_zombie_prototype`, `logs/referee/enw-*.log`):

```
components registered: 9 ... post_load done (9 of 9 ok) ... post_unpack done (9 of 9 ok)
referee/bind: notify=no scriptvars=no entities=no clients=no servercmd=no dvars=no frame=yes
referee: armed / replay: sampler armed / afk: client_s not bound / chat: ... not bound
referee: first frame tick
```

Chasing the tick turned up the DLL's biggest single blocker, measured three ways:

1. **`Com_Frame` 0x59E330 is never called**, despite being `[V]` in `shared/t4/addresses.hpp`. A
   MinHook detour created and enabled on it logged nothing across two 50–75 s runs, and a read-back
   of the target 20 s in showed `E9 1B 51 9F …` — **our jmp still present**, so this is not SteamStub
   re-encrypting the page behind us; the function is simply not on the path. `foundation`'s
   `main_thread` pump moved to the same address in the same hour and logged
   `0 pump calls (queued=27 ran=0 dropped=0)`.
2. On the older `Dvar_FindVar` detour the same pump got **96 calls in 0.3 s**, and my tick ran
   continuously — I had to rate-limit it down from ~9,000/s, which is why `t4_bind` now gates itself
   to 50 ms (`sv_fps 20`) instead of trusting the pump's own rate.
3. The pump is now `Dvar_FindVar (startup only)`, so **after startup nothing in the process ticks at
   all**. Over a 150 s run my tick fired exactly once, during startup.

Everything runtime-shaped waits on this: the replay sampler, AFK input, the score/round poll, and
`game_link::pump()` — which means every host→game command (`say`, `tell`, `pause`, `set`,
`snapshot_state`) too. Candidates for `re`: whatever `WinMain` 0x5FF600 actually calls in its loop
body, `SV_Frame`, `G_RunFrame`, and `Sys_DedicatedConsolePump` 0x69DAA0 (already known to run each
frame when `com_dedicated != 0` — that one alone would give the dedicated server a tick today).

### 8.6 MEASURED IN A REAL GAME (2026-09-20 02:08) — **SUPERSEDED, SEE 8.7**

> **Read §8.7 first.** Every capture in this section was cut short at 65.2 s by a crash **in the
> referee's own diagnostic code**, which I misdiagnosed twice (first as an engine pause, then as an
> environment problem) before running the control that settled it. The snap rate below survives,
> because a rate does not care that a run was truncated. The byte figures, the zombie-row counts and
> the "no death observed" conclusion do not, and are being re-measured.


`ZombiesDev\captures\nazi_zombie_prototype-20260920-020759.ndjson`, client-mode solo, Nacht.

| What | Measured | Note |
|---|---|---|
| snap rate | **19.5 Hz** | the designed 20 Hz, off `SV_Frame`; 1,269 snaps in 65.2 s |
| player rows | 1,269, slot 0 only | after gating on `client(slot).active` |
| zombie rows | **2,060** | via `classname` starting `actor` + `health > 0` |
| player positions | bbox x −37..0, y 0..424, z 0..18 | sane for Nacht |
| zombie sample | `{"id":254,"pos":[-59.0,-1645.3,13.4],"health":150}` | **health 150 is exactly stock round-1 zombie health** — independent confirmation that `classname` and `health` are both right |
| notify names | `scriptgen_done`, `end_respawn`, `all_players_connected`, `spawned_player`, `weapon_change_complete`, `intro_hud_done`, `zombie_init_done`, `endTeleportThread` | `re`'s string-table formula **confirmed working** in a live game |
| chat capture | 0 in an idle game | the assertion that caught the bad `G_Say`; now logged by the DLL itself |
| AFK `input` | 4 events in 5 minutes idle | correct behaviour, not a broken hook |
| bytes | **11.80 MB/h raw, 1.19 gzip, 1.06 zstd-10** | see the caveat below |

#### The byte number, honestly
`estimate_snap_bytes.py` predicts **40.2 MB/h raw / 5.2 zstd** for solo; the measurement is
**11.80 / 1.06**, so the model over-predicts by ~3.4x raw. That is not the encoder disagreeing with
itself — mean snap measured 176.6 B against a modelled 585.7 B, and the capture averaged ~1.6 zombie
rows per snap where the model assumed ~8 alive. **The difference is almost entirely zombie count**,
which is exactly what §8.3 said dominates. So:

* the model is a sound **upper bound**, and its shape is confirmed;
* **this measurement is round 1 with one idle player and a handful of zombies — it is not a
  game-hour** and must not be quoted as one. A late-round 4-player game will land well above it;
* the safe planning number remains the model's, with the §8.3 trade-offs applied.

#### The `currentOrigin` cross-check
**AGREE.** With the tie-break fixed to discriminate by Z-flatness (a real origin's third component
is far flatter than its X and Y), runtime motion analysis over 128 entities independently selected
**+0x160**, matching `shared/t4`. My earlier "DISAGREE" was withdrawn: a 4-byte sliding window over a
3-float triple overlaps itself, so +0x15C/+0x160/+0x164 tied and the old tie-break took the lowest.

#### `VM_Notify`: `re`'s convention was right, the global was not
The hook fires (10,197 notifies/minute) but nothing matched `ownerId == levelId`. The 24-tuple dump
settles which assumption was wrong: `instance` is clean (0 and 1), `ownerId` is small and plausible
(3, 4, 0x5DF, 0x794), and `stringValue` **resolves to real names** — so EAX-is-instance, the argument
order, and the thunk's stack offsets are all confirmed. The fault is `levelId`, which read
**0x00000000** at 0x3882BC8 throughout. Now reading it per instance
(`gScrVarPub + instance*0x18048 + 0x20`) with a self-calibrating fallback: the first notify whose
name is level-only defines the id, so flag detection no longer rests on one global being right.

### 8.7 The 65-second wall was mine, and what it cost

Every capture tonight ended at exactly 65.2 s. I read that as an environment quirk twice — first
"the game pauses when unfocused", then "the engine crashes" — and reported both. Neither was right,
and the tell was in the data the whole time: **a figure that identical across builds with different
hook sets is evidence of a systematic cause in the constant factor**, and the constant factor was
the referee.

The control that settled it, which should have been the first move:

| Build | Result |
|---|---|
| `build.ps1 -CoreOnly` (no server components) | **alive at 200 s** |
| full build with the referee components | dead at ~70 s, every run |
| full build, heavy diagnostics off/bounded | **alive at 210 s** |
| full build, stack-alignment fix reverted, diagnostics still off | alive at 150 s → **alignment was not the cause** |

So the crash was one of two **diagnostics**, not any feature:
* the `level.*` probe — 65,536 entries × 4 extractions of `is_readable()` in one burst, **inside a
  notify handler on the game thread**; now opt-in behind `ENW_LEVELVARS=1`;
* the origin discovery — 128 entities × 26 candidates × a `VirtualQuery` **every frame**, ~200,000
  syscalls/second, running unbounded (the logs show 960, 2,544 and 3,952 passes on different runs);
  now hard-bounded.

Both were throwaway probes that quietly became permanent per-frame load on the thing they were
measuring. That is the same shape as two other bugs of mine tonight — a `finally` that released a
lock it never acquired, and a log read that could have held the game's file open — and the common
thread is **cleanup and diagnostic code carrying more authority and less budget than the feature
code it serves**. A diagnostic needs a cost ceiling and an off switch the moment it is written.

Withdrawn as a result: the `currentOrigin` runtime cross-check (non-deterministic across three runs
— AGREE +0x160, then +0x15C, then +0x148, with a different surviving candidate set each time, so
the one agreement was luck); and the claim that `foundation`'s focus guard would unblock the
captures (it works, and it was not the blocker).

### 8.8 "Chat injection works" was an over-claim, and injection may be the crash

I reported chat injection as green on the evidence that my sink pushed three `say` commands and the
DLL logged no error. That is evidence the **sender** ran. It is not evidence that any text reached a
player, and it is not evidence that the game survived the call — neither of which I checked.

The crash hunt then pointed straight back at it:

| Configuration | Outcome |
|---|---|
| core-only build, no server components | alive at 200 s |
| full build, heavy diagnostics on | dead ~70 s |
| full build, diagnostics off/bounded, **launched bare (no sink)** | alive at 210 s |
| full build, diagnostics off/bounded, **capture running (sink + injection)** | dead ~68 s, heartbeat clean to 60 s at 62.5 fps |

The sink pushes `say` at +20 s, +65 s and +110 s after connect. The crash lands at **~68 s, just
after say #2** — say #1 falls before the map is up, where it is a no-op. So the suspect is
`SV_GameSendServerCommand(ecx = -1, ...)` broadcasting in a listen/solo game.

Note what this also says about the previous section's conclusion: the 210 s "fix" was measured on a
**bare launch with no sink**, so it never exercised the culprit. The alignment fix and the
diagnostic budgets were both worth doing on their own merits and neither was the bug. Declaring the
crash fixed on a test that did not reproduce the original configuration was the mistake.

Until the isolation run (sink connected, injection disabled) says otherwise, `server_say()` should
be treated as **unsafe**, and the cross-server chat relay must not be built on `say`/`tell`.

### 8.9 THE REAL MEASUREMENT (2026-09-20 04:01) — supersedes §8.6

`ZombiesDev\captures
azi_zombie_prototype-20260920-035402.ndjson`, client-mode solo on Nacht,
taken on the fixed build (HUD-colour hook removed, injection off, diagnostics off). This is the
first capture not truncated by my own bug, and the first with a player who actually moved.

| | Measured |
|---|---|
| span | **429.9 s** (previous ceiling: 65.2 s) |
| snaps | 8,340 at **19.4 Hz** |
| player rows | 8,340, active slot only |
| zombie rows | **11,949** (~1.4 per snap) |
| `input` events | **638** — the player moved, unlike every earlier run |
| position bbox | x −248..968, y −39..1092, z −12..190 |
| **bytes** | **11.44 MB/game-hour raw · 1.16 gzip · 1.01 zstd-10** |

**Movement barely changed the byte rate** (11.44 vs 11.62–11.78 stationary), which is expected: the
v0 encoder writes a full position every snap rather than a delta, so motion costs digits, not rows.
That is worth knowing before anyone tunes the format — the §8.3 finding that **zombie count
dominates** is confirmed rather than displaced. `estimate_snap_bytes.py` predicts 40.2 MB/h raw for
solo assuming ~8 zombies alive; this run averaged ~1.4, and 11.44 is almost exactly what the model
gives at that density.

**Still a floor, for one honest reason**: a solo player on round 1–2 of Nacht with a handful of
zombies is the cheapest game that exists. A 4-player late-round game will be several times this.
The model remains the planning number; this measurement confirms the model's *shape* and its
sensitivity to zombie count, which is what it was for.

### 8.5 Still to run
* `<fs_homepath>\main` + a mod (§3.4 follow-up) — staged, blocked because `fs_game` makes
  `BG_LoadWeaponDef` fail before GSC compiles (`dedi` p13 is on it).
* Everything that needs the notify hook and script-VM access: round/game-over from the live `level`,
  real replay capture, chat in/out, AFK, knobs, pause.


---

## 9. 2026-09-22 — rounds, the replay sampler, and two answers

### 9.1 Round 2 is blocked on the dedicated server, not on this lane

Round detection past round 1 needs `between_round_over` (§2.1), which needs `round_think()` to
complete a round, which needs `SV_Frame` to keep ticking. It does not: `dedi.md` §11.1 shows the
engine's frame body stops returning about fifty seconds after a player spawns, and `SV_Frame` sits
past that point in the body. `com_frameTime` freezes and never moves again.

**No dev knob was used to force a round, and none would have worked.** Every route the docs allow
— a dev-only GSC knob, a console command on the server, a `zombie_devgui`-style spawn — has to be
executed by the script VM, and the server has stopped ticking it. `developer 1` was not used
(hard rule 5) and is not the answer either.

So the honest status of round detection is unchanged from yesterday: **`ROUND 1` is proven in every
join run since `join12`; `ROUND 2` has never been observed and cannot be until the escape in
`dedi.md` §11.1 is fixed.** When it is, the test is `TESTME.md` and it needs nobody at the
keyboard: an unattended game that survives will advance on its own.

### 9.2 `wait_for_first_player()` — answered

It waits on `level waittill("first_player_ready")`. Nothing raises that notify on a dedicated
server, while `all_players_connected` **does** fire — the referee's `ROUND 1` comes off it. The two
threads parked on it (`_utility.gsc:9539` via `_utility.gsc:9698`, and `_load.gsc:2256`) are still
parked at the end of every join run, including the ten-minute `join59`.

**It does not stop round 1 and it does not stop the map.** It is a real difference between a listen
server and ours, it has never cost us a milestone, and the board's instruction — "test it before
believing it" — is now discharged: believe that it waits, and do **not** fake the notify to make it
stop. Faking a player-ready signal on a server with no local client is the same class of mistake as
telling the engine an autosave finished when it had not (`dedi.md` §7i), which produced
`Attempting to commit an invalid save buffer` and a worse message further from the cause.

### 9.3 The replay sampler: four gaps closed, one refused

`replay.md` §3 lists six gaps against `server/components/replay/replay.cpp`. Five were in scope.

| gap | now |
|---|---|
| 1. no `kill` event | **emitted**, from entity state: a zombie in the live list one sample and gone the next. A record, not an inference — and it carries `how: "entity_gone"` and **no `slot`**, because we cannot attribute it |
| 2. no zombies-remaining | **two fields, named honestly.** `zombies_alive` is measured (live AI this sample, which the engine caps at 24–31). `kills_round` counts kills since the round changed. `zombies_remaining` is **omitted**, not faked — it is `level.zombie_total` and script variables are still unbound |
| 3. `round` only an event | **on every snap.** `t4_bind` gained one shared cell (`set_current_round` / `current_round`) written by `referee.cpp`'s `emit_round`, rather than a second counter that could disagree with the first |
| 4. no roll on `ang` | left alone — zombies does not need it |
| 5. `weapon` disagreed with itself | **one type, the string.** The index is emitted as `"#37"` until `BG_GetWeaponDef` is in `shared/t4`; the consumer can see at a glance that it is unresolved, and the type never changes under it |
| 6. `stance` never emitted | **emitted**, from the last usercmd's button mask. **The bits are not verified by us** — a contradictory mask emits nothing, and each distinct mask is logged once with the stance it produced. Crouch in a join run, read that line, and settle it |

**Gap 7 — no verified replay from a real DLL — is still open, and tonight did not close it.** The
`.enwr` container is written by the host agent (`host.md` §5), `jointest.ps1` does not run the host
agent (every join run logs `game-link: connect to 127.0.0.1:28960 failed, retrying`), and with
`SV_Frame` stopped there was nothing to sample anyway. It needs a host-agent game, which is
`host.md`'s lane, after `dedi.md` §11.1.

---

## 10. 2026-09-22, 07:30–09:00 — game over on a dedicated server, and what the host agent must do

### 10.1 Until tonight, game over did nothing

The referee has detected game over correctly since `join64` (`stop_intermission` on every map,
`end_game` on Der Riese-derived ones, §2.2) and it sent exactly one message:

```json
{"t":"game_over","ms":…,"round":1,"reason":"stop_intermission notify"}
```

That was adequate while a dedicated server **died** at game over. It no longer does:
`dedi.md` §12.3's `no_save_reload.cpp` keeps the process, the map and the connected clients alive
straight through it, and `join65`/`join66` ran 300 s each *through* game over with the client still
`CS_ACTIVE`. So after the match ended, the server kept simulating an empty intermission for ever,
the replay sampler kept writing snaps into a replay the host had already closed, nobody told the
host the lease was free, and nothing started the next match. **Three of those four are fixed here.
The fourth needs one thing from the host agent and it is specified below.**

### 10.2 What the referee does now, in order

`referee.cpp :: emit_game_over()`. It is still idempotent — the first of `level.intermission`,
`stop_intermission` or `end_game` wins and the rest are ignored.

**1. the result.** One enriched `game_over`, so a host that loses the connection a second later
still has the whole answer in one line rather than having to fold the event stream:

```json
{"t":"game_over","ms":321107,"round":7,"reason":"stop_intermission notify",
 "duration_ms":298640,"points_total":12450,"downs_total":3,"players_alive":0,
 "players":[{"slot":0,"name":"anna-jpg","connected":true,"score":6200,
             "score_total":9100,"downs":2,"revives":1,"alive":false}]}
```

A player who left mid-match still gets a row, because they are part of the result. `revives` is
counted off the `player_revived` notify (§2.3); `downs` is the poll of `self.downs`; `score` is the
poll of `player.score`. `score_total` appears only when the script read succeeds, which today it
does not (`scriptvars=no`).

**2. the replay stops.** `referee::set_recording(false)` — one shared cell in `t4_bind`, the same
shape as `set_current_round` (§9.3 gap 3), read by `replay.cpp`'s sampler, which returns
immediately from then on and says so once.

**3. the lease.** One new message, sent **after** `game_over` so the host can never see "you may
reuse this instance" before the result it is supposed to post:

```json
{"t":"match_end","ms":321107,"round":7,"reason":"stop_intermission notify",
 "duration_ms":298640,"replay_closed":true,"server_alive":true,"awaiting":"end|teardown"}
```

`match_end` means exactly one thing: **this game process is idle and the instance can be
reclaimed.** It is not a duplicate of `game_over`; `game_over` is evidence and belongs in the
replay, `match_end` is lifecycle and belongs to the scheduler.

**And then the referee does nothing at all.** It does not restart its own map on a timer. A server
that recycled itself would destroy the evidence of a game the host had not finished writing down,
and "the host was slow" is not a reason to lose a run. An idle server costs 2–6% of a core
(`dedi.md` §12.3), which is affordable; a lost record is not.

#### Proven — `join73`, `nazi_zombie_prototype`, 300 s, one real client

```
07:53:37  referee: ROUND 1 (all_players_connected)
07:55:17  referee: GAME OVER at round 1 (stop_intermission notify) after 120953 ms;
          0 point(s) over 1 player row(s), 0 down(s), 1 alive. Replay sampler stopped.
          match_end sent: the server is ALIVE and idle, waiting for the host to send
          `end` (map_restart) or to tear the instance down.
07:55:17  replay: sampler stopped at game over after 2057 snaps / 402486 bytes.
          It restarts when the referee reports a new match.
07:58:36  dedi_rate_probe: ... Com_Frame-body 59.0 Hz ... com_frameTime=321195
          com_frameTime advanced 29992 ms over the last 6 windows   simulating=True
          answered 76, unanswered-after-first-answer 0              PASS
```

The server ran for another **three minutes past game over**, still simulating at 59 Hz, with the
client attached — which is exactly the state `match_end` exists to end, and exactly why the
referee must not end it by itself.

**`0 point(s)` and `0 down(s)` are honest, not a bug.** `score` and `downs` are script-variable
reads and `scriptvars=no` in every run to date (`t4_bind.cpp`), so those fields are simply absent
from the JSON and the totals are zero. The player row itself comes from `client(slot)`, which is
bound. When script variables land, the same code fills in without changing shape.

### 10.3 THE CONTRACT — what `infra/host-agent` must do

This lane may not edit `infra/host-agent/`, so this is the specification, and
`docs/protocol/game-link-v0.md` now carries the new rows.

On receiving **`match_end`** the host agent must, in this order:

1. **finish the replay** — `game_over` is the last event of the match; close and sign the chunk.
2. **post the result** — from the `game_over` message, not from a re-fold of the stream.
3. **choose one of two dispositions, and it must choose one:**
   - **reuse the instance** — send `{"t":"end","id":"<id>","reason":"next lease"}`. The referee
     replies `{"t":"reply","id":…,"ok":true}`, issues `map_restart`, resets its per-match state
     (round back to 0, players cleared, novelty budget refilled, recording on) and **re-announces
     `map_loaded`** on the next server frame — which is the host's signal to open a new replay
     file. A `reply` with `ok:false` means the command buffer was unavailable and the instance
     **must not** be reused; tear it down.
   - **tear it down** — terminate the process. Nothing further is needed from the game side.
4. **never leave it in neither state.** An instance that gets no answer stays up for ever holding a
   UDP port and a map's worth of RSS.

`end` is also the way a host ends a game early. If it arrives before game over the referee reports
the result first (`reason` = whatever the host sent, or `"host end"`), so a forced end still leaves
a complete record instead of a hole.

**The one thing the host must NOT do** is assume `game_over` means the process is gone. It is not;
`server_alive` says so explicitly.

### 10.4 `console_command()` was a no-op, and every "-> map_restart" line was a lie

Worth writing down plainly because it invalidates an earlier claim in this file.
`t4_bind.cpp :: console_command()` was `return false;` with the comment "Cbuf_AddText is not in
shared/t4 yet". `do_end()` called it, did not distinguish the failure in its log line, and printed
`referee: host asked to end the game (…) -> map_restart`. **No `map_restart` has ever been
issued.**

It is implemented now. **`Cbuf_AddText` = 0x594200**, and it is a register-argument function, so it
is stated the way `docs/re/t4-sp-map.md` asks. Two independent signals:

```
prologue 0x594200   push ebp / push esi / push edi
                    push 0x22990F8 ; call [0x7EB138]   EnterCriticalSection
                    mov esi, eax      <- arg 1: const char* text
                    mov edi, ecx      <- arg 2: int localClient
call site 0x636157  add esp, 8 / xor ecx, ecx / call 0x594200
                    ecx is set immediately before the call and nothing is pushed for it
```

Nothing goes on the stack and nothing has to be cleaned, so a wrong guess here cannot unbalance the
caller — which is the specific risk that made `dedi` refuse to stub 0x605500. The call is made from
inline asm rather than through an invented prototype, is queued onto the game thread like
`server_say`, verifies the prologue bytes before the first call, and appends its own `\n` (without
one the command sits in the buffer until something else adds one).

**`re`: this belongs in `shared/t4/addresses.hpp` as `t4::fn::Cbuf_AddText`, with the convention
written down.** It is in `t4_bind.cpp` only because that file is not yours.

### 10.5 The `exec` dev knob — `ENW_DEV_KNOBS=1`, and off everywhere else

`exec` has been in the protocol since v0 and nothing implemented it. It is implemented now and it
is **dev-only**: the referee reads `ENW_DEV_KNOBS` from the *game process's environment* at
`post_load`, and refuses `exec` with `"dev knobs off (ENW_DEV_KNOBS)"` unless it is `1`. A command
containing a newline or carriage return is refused outright so one `exec` cannot smuggle in a
second.

The switch is deliberately **not** a dvar the host can set over the same link. A host that can run
an arbitrary console command on a server that certifies records can change the rules of a run after
it has started; the switch has to be something only whoever launched the process can set. Nothing
that launches a Verified game sets it.

### 10.6 Round 2 — still not observed, and the reason has changed

§9.1 said round 2 was blocked on `SV_Frame` stopping. **That is fixed** (`dedi.md` §12) and round 2
is still not observed, for a different and much more ordinary reason: **a round does not end until
that round's zombies are dead, and an idle client does not kill anything.** `join65`/`join66` both
ran the full 300 s; in both, round 1 was still round 1 when the player was eaten, and the game
ended correctly at round 1.

**No dev knob can substitute, and this is not a "we did not try" answer.** To end a round from the
server you need one of three things and we have none of them:

| route | what it needs | state |
|---|---|---|
| fire `between_round_over` ourselves | `Scr_NotifyNum` — raise a script notify from C++ | **unbound** (`t4_bind.cpp` header, "still missing") — and it would be a *lie to the referee*, not a real round |
| set `level.zombie_total = 0` | script-variable **writes** | **unbound**: `scriptvars=no` in every join run |
| kill the AI | `G_Damage`, or a console command that kills AI | not mapped; and the exe has **no** AI-kill command — the only `kill*` command strings in the image are `kill` and `killserver` |

Writing `health = 0` into a `gentity_s` is **not** a fourth route and must not be tried: AI death on
this engine is raised by the damage path, not by the field, so it would produce a zombie with zero
health that never dies and a round that never ends — a worse state than the one we are in.

So the honest status: **`ROUND 1` is proven in every join run since `join12`. `ROUND 2` needs a
player who shoots.** That is now a client-input question (a real person at the keyboard, or an
automated one), not a server question, and `TESTME.md` is the test.

The `exec` knob of §10.5 is still worth having — `map_restart` is a real server-side action and it
is what the `end` contract rests on — but it is honest about what it cannot do.

### 10.7 `wait_for_first_player()` — the decision, and it is "no"

§9.2 established the mechanism: `wait_for_first_player()` waits on
`level waittill("first_player_ready")`, nothing raises it on a dedicated server, and two threads
(`_utility.gsc:9539`, `_load.gsc:2256`) stay parked for the whole of every run.

**Decision: the referee will NOT raise it.** Three reasons, in order of weight:

1. **Nothing has been shown to depend on it.** The condition for implementing was "only if the
   level scripts need it". Round 1 starts (`all_players_connected`), the map runs, the client
   spawns, the game reaches game over and the result is reported — all with both threads parked,
   across every join run to date. A change with no observable failure to fix is a change that can
   only introduce one.
2. **We cannot do it today anyway.** Raising a script notify from C++ needs `Scr_NotifyNum`, which
   is one of the two things `t4_bind.cpp` has always listed as missing. "Implement it" is not a
   small change; it is the same binding that would unblock a real round knob.
3. **Faking a player-ready signal is the `no_autosave` mistake again.** `dedi.md` §7i: telling the
   engine an autosave had finished when it had not produced `Attempting to commit an invalid save
   buffer` — a worse message, further from the cause. A listen host raises `first_player_ready`
   *because a local player really is ready*. We have no local client (`local_client.cpp` keeps slot
   0 free on purpose, so `get_players()` sizes rounds correctly), so the condition is genuinely
   false and saying otherwise is a lie to the scripts.

**What would change the decision:** a map whose progression is gated behind it — a custom `_load`
that will not open a door or start a timer until `first_player_ready` fires. None of the six maps
tested tonight is such a map. If one turns up, the fix is `Scr_NotifyNum` plus raising it exactly
once, when the first client reaches `CS_ACTIVE` (that is when a listen host would have), and never
on a server that has no clients.

## 11. 2026-09-22, 09:10–10:30 — the samplers are not what breaks custom maps, and `ENW_NO_SAMPLERS`

### 11.1 The accusation, and the control that answers it

The custom-map bisect (`dedi.md` §14) put this lane in the frame twice: tonight's replay additions
(`kill` inferred from entity state, `zombies_alive`, `kills_round` on every snap) and the referee's
per-frame state read were the obvious suspects for Der Berg's `scrVmPub.localVars` overflow, which is
a **script child-variable enumeration** of ~3,900 entries.

There was no way to run without them, so there is one now. **`ENW_NO_SAMPLERS=1`** makes
`referee_component::post_unpack()` and `replay::post_unpack()` return immediately: no
`referee::bind()`, no `SV_Frame` hook, no `on_frame` subscription, no snap. The dedicated server is
otherwise untouched. It is a **measurement knob and never a shipping one** — with it set there is no
`ROUND 1`, no `game_over` and no replay, so a run that uses it can never pass the five gates. That is
the point: it answers one question and refuses to answer any other.

**Run `mapB`** — Der Berg, dedicated, `ENW_NO_SAMPLERS=1`, held 30 s — stopped simulating at
`com_frameTime=5651`, against 5659 (`join69`) and 5662 (`join59`) with everything on. **Not ours.**

### 11.2 Why it could never have been ours, stated so nobody re-tests it

* `referee::zombie_ents()` walks `g_entities[4..1024]` — a **bounded entity-array** walk reading
  `gentity_s` fields (`classname`, `health`, `currentOrigin`) straight out of memory. It does not
  enter the script VM.
* `binding_report::script_vars` has been **`no` in every run this project has ever recorded**
  (`referee.md` §10, §9.3, the `referee/bind:` line in every log). Script-variable reads and writes
  are unbound, which is why game over still reports `0 point(s)` / `0 down(s)`.
* The one thing this lane has that *does* enumerate children — `dump_level_vars()` in `t4_bind.cpp`
  — is behind **`ENW_LEVELVARS=1`**, off since all four extractions scored zero, and it reads
  `childVariables` with a `peek()` per entry rather than calling the engine's walker.

**This lane has never called 0x697B60.** The bound on that loop is still an engine-limit job and
still nobody's today.

### 11.3 What the referee can actually referee

Of fourteen archived customs, **three** boot headless, answer `getstatus` and keep the engine
simulating: `nazi_zombie_orbit`, `ugx_artemovsk`, `nazi_zombie_fear_mc_2`. The six previously marked
`broken` all die in the maps' own scripts and do so on a stock exe as well (`dedi.md` §14.2), so
there is nothing for this lane to fix in them. The five-gate results for the three that work are in
`dedi.md` §14.6.

## 12. 2026-09-22 — `game_players = 0` on the box's first real game: the roster events were never sent

### 12.1 The fault

The Hetzner box's first real game (replay `m_5de3842b`, site game id **2**) reached game over, wrote
a signed replay and produced a result row — with **`game_players = 0`** and `result_mismatch`. The
player was demonstrably in the world: `CS_ACTIVE`, `join_probe: *** slot 0 ENTERED THE WORLD`,
`referee: ROUND 1`.

**The cause is that this DLL has never emitted a roster event.** `player_connect`,
`player_spawn` and `player_disconnect` have been in `../protocol/game-link-v0.md` since v0 and the
only thing in the repository that sent them was **`infra/host-agent/sim/engine.js`**. Host-side,
`infra/host-agent/lib/referee.js` creates a player row in **`ev_player_connect` and nowhere else**:

```js
ev_player_spawn(ev)      { const p = this.players.get(ev.slot); if (!p) return; … }
ev_player_disconnect(ev) { const p = this.players.get(ev.slot); if (!p) return; … }
```

So the simulator produced full rosters and every integration test passed, and a **real** game
scored nobody. `grep -rn player_connect server/ shared/ client-dll/` returned nothing before
tonight. This is the same shape of fault as `map_loaded` (§referee.md 3) and `console_command()`
(§10.4): a protocol row that everything downstream depends on and nothing upstream ever wrote.

### 12.2 The fix, on the server side

There is no connect callback bound — no `Scr_NotifyNum`, no `SV_ClientConnect` hook — so this is an
**edge detector over the per-frame client poll that `poll_players()` already runs**.
`referee::client(slot).active` is `gentity != 0 && name non-empty`, which a client has from
`CS_CONNECTED` onward, so the connect edge lands early. That is what the host wants: `host.js`
opens the replay on the first `player_connect`.

| edge | event sent |
|---|---|
| slot becomes active | `player_connect {ms, slot, name, steamid, xuid, token?}` |
| the player entity is first alive | `player_spawn {ms, slot}` |
| slot stops being active | `player_disconnect {ms, slot, reason}` |

`steamid` and `xuid` carry the **same** value under both names, because `lib/referee.js` reads
`ev.steamid || ev.xuid` and keys identity on it; making the host guess which one a server sends is
not a contract. `token` is pulled from userinfo (`\enw_token\`, else `\token\`) and is what
`lib/tokens.js` answers with `auth`. The `game_over` player rows carry `name` and `steamid`/`xuid`
too, so a host that only stores the final result can still attach XP to an account.

**PROVEN, `join85`, prototype, real client:**

```
referee: player_connect slot 0 name='anna-jpg' steamid=(none …) token=(none)
join_probe: *** slot 0 ENTERED THE WORLD
referee: ROUND 1 (all_players_connected)
referee: player_spawn slot 0 ('anna-jpg')
referee: GAME OVER at round 1 … 0 point(s) over 1 player row(s), 0 down(s), 1 alive
```

### 12.3 WHAT IS STILL BROKEN, and it is the half that matters for XP

**The client carried no steam id.** `client_view` looks for `\xuid\`, `\steamid\` and `\guid\` in
userinfo and this client's userinfo has none of them, so `player_connect` went out with an empty
`steamid`. The host will now open a roster row — `game_players` will not be 0 any more — but that
row has **a name and no identity**, and a name cannot carry XP or a record.

A `WARN` on the connect edge prints the **key names** present in that client's userinfo (the names
only, never the values), once per connect. **MEASURED, `join87`** — this is the whole list a real
T4 client sends:

```
cg_predictItems  cl_punkbuster  cl_voice  rate  snaps  name  protocol
challenge  invited  qport  bdTicket  bdTicketTime
```

**There is no `xuid`, no `steamid` and no `guid`.** The identity is inside **`bdTicket`** — the
Demonware auth ticket, a long base64 blob, which is also why the engine printed `Connecting player
#0 has a zero GUID`. Reading a steam id out of a WaW client therefore means decoding `bdTicket`
(or binding `SV_DirectConnect`/the auth path and taking the id the engine resolves), and that is a
piece of work, not a missing string lookup. `invited` is the other key worth a look: it is a
natural carrier for the invite token of feature 12 and nothing has checked what the client puts in
it.

Until that is done, **treat the roster as *attendance*, not as *identity***, and do not let
anything downstream award XP or a record to it.

Two other things this does not do, stated so they are not assumed:

* **`score` and `downs` are still zero** in the result on a real game. They are script-variable
  reads and `scriptvars=no` (§10, §11.2). The roster fix does not change that.
* **`player_disconnect` has not been observed firing** — `join85`'s client stayed to the end. The
  edge is symmetric with the connect edge that did fire, which is an argument, not a measurement.

## 13. 2026-09-22 — a result that belongs to a Steam account

§12 ended with the half that matters unsolved: the roster had names and no identity, and nothing
downstream could award XP or a record to it. This section is that half.

### 13.1 The canonical path, decided

**The invite token is the identity, and there is no second source.** `join87` settled the question
by measurement — a real T4 client's userinfo is `cg_predictItems cl_punkbuster cl_voice rate snaps
name protocol challenge invited qport bdTicket bdTicketTime`, with no `xuid`, no `steamid` and no
`guid`. §12.3 left two candidates open, `bdTicket` and `invited`. **Both are dropped**, and for a
better reason than difficulty: an identity our own site did not issue is an identity we cannot
check. Decoding Demonware's ticket would give us a number from a dead service with no signature we
hold a key for; the invite token is signed by us, bound to a match, and short-lived.

Nothing new had to be invented — every piece of this already existed and no two of them had ever
been joined up:

```
site      web/server/lib/tokens.js :: issue()   Ed25519 over canonical({v,sid,m,iat,exp,jti,slot?,n?,k?})
          -> "<payload-b64url>.<sig-b64url>", bound to (sid, m), TTL 5 min
launcher  launcher/src/main/launch.js :: serveToken -> a one-shot named pipe; ENW_TOKEN_PIPE holds
          only the pipe's random NAME. Fallbacks: ENW_TOKEN (launcher), ENW_AUTH_TOKEN (dev)
client    client-dll/components/auth_token.cpp -> writes `setu enw_token "<token>"` into this
          instance's own main\enw_auth.cfg, +exec'd at boot. `setu` = a USERINFO dvar, so the
          token rides the connect packet. NEVER on a command line, and cleared out of the
          environment before any child could inherit it
server    server/components/referee/referee.cpp -> `\enw_token\` out of client_s.userinfo at the
          connect edge; parse; bind steamid64 + party slot to the CLIENT SLOT
host      infra/host-agent/lib/tokens.js :: TokenGuard.admit() verifies the SIGNATURE against the
          site's public half and answers `auth {slot, allow, reason}`
```

**The userinfo key is `enw_token`.** (`token` is still read as an alias; nothing writes it.)
`join87` saw no `enw_token` for the simple reason that **`jointest.ps1` launched the client with no
token at all** — it is not the launcher, it had no lease, and `auth_token.cpp` correctly does
nothing when it is offered none. That was never evidence that the token does not arrive; nobody had
ever passed one. `jointest.ps1 -AuthToken / -MatchId / -LinkHost` exist now so a join run can.

### 13.2 Where it is parsed, and why the server parses something it cannot verify

`parse_token()` in `referee.cpp` base64url-decodes the payload and reads `sid`, `m`, `jti`, `slot`
and `n`. **It does not verify the signature, and it must not**: there is no Ed25519 in this DLL
(the core has sha256 and nothing else), and more importantly the site issues and the box only ever
verifies — a game box that could check a signature is one step from a game box that holds a key,
and a stolen box must not be able to mint a join for anybody.

So the parse buys the one thing the host cannot do for us: **binding a steamid64 and a party slot
to a client slot**. Everything else is gated on a marker that says what that id is worth:

| `identity` | means | `steamid` sent? |
|---|---|---|
| `none` | no token in userinfo — Play Local, `jointest.ps1` without `-AuthToken` | no |
| `claimed` | a token was presented and parsed; nothing has checked the signature | on `player_connect` only |
| `verified` | the host answered `auth allow:true` after a real check | yes, including on `game_over` |
| `refused` | the host said no, or the game refused it itself | **no**, and `identity_reason` says why |

**An unverified `sid` is safe to read precisely because a forged one cannot survive the host.** The
signature covers the whole canonical payload, `sid` included, so editing `sid` to somebody else's
account changes the body and `check()` returns `bad_signature`. The proof of that exact claim is
`tools/dev/authhost.mjs selftest`, which takes a token the SITE issued, rewrites `sid` in the
payload, keeps the site's own signature, and watches the BOX's own `check()` refuse it. Both halves
are the shipping code; neither is a stub.

### 13.3 `auth` was in the protocol since v0 and this side ignored it

`infra/host-agent/host.js :: authPlayer()` answers **every** `player_connect` with
`auth {slot, allow, reason}`. Nothing in the game had a handler. So every DENY the host has ever
sent — a forged token, a replayed one, a token for another match, a join with no invite at all on a
box configured to require one — was read off the socket and dropped, and the client kept playing.
Same shape of fault as §12.1 and §10.4: a protocol row both sides believed in and one side never
implemented.

`do_auth()` implements it. `allow:false` refuses the slot; `allow:true` promotes `claimed` to
`verified` **unless** the reason is `token_check_disabled`, which is what `TokenGuard` answers when
it holds no site key or is not enforcing. An allow reached without checking anything is not a
verification and does not get to look like one.

### 13.4 Records safety — what the game refuses on its own

The signature is the host's. These are the game's, need no key, and hold with the link down:

* **single use, per match.** `jti_seen_` maps each token's `jti` to the slot it seated; a second
  client presenting the same token is `replayed_token`. The host's `TokenGuard` also keeps a jti
  set, but **per boot** — and, on a warm instance, across matches. This one is cleared on every
  `reset_for_next_match()`, so match A's invites can never admit anyone to match B.
* **bound to the lease.** A token whose `m` is not this process's match is `wrong_match`. The match
  id comes from `ENW_MATCH`, which the host agent sets when it starts an instance.
* **one account, one slot.** A steamid already seated in another slot is `steamid_already_seated`.

and the shape checks that stop a signed token being *misread* rather than forged: exactly one dot,
b64url alphabet only, ≤1 KiB, payload ≤4 KiB, `v == 0`, and **`sid` must be 15–20 digits** — a
well-signed token for `"1"` is not an account and must never reach a roster row.

A refusal does two things. It **clears the identity**, which is the guarantee and holds
unconditionally, and it sends `clientkick <slot>` through the command buffer bound in §10.4. The
kick is the second line of defence, not the first: if `clientkick` is not a command on this exe the
console says so, the player keeps playing, and the result still names nobody.

**`game_over` carries a `steamid` only for a `verified` row.** The host's fold takes its identity
from `player_connect` (`lib/referee.js:652` posts `p.steamid`), so this is a belt over that brace —
but `game_over` is the one message the contract says a host may post a result from without
re-folding the stream (§10.3), and that message must not carry an account nobody checked.

### 13.5 What the other lanes must do — and no code of theirs is wrong today

Nothing has to be renamed. `player_connect.steamid` was already the field `lib/referee.js` keys
identity on (`ev.steamid || ev.xuid`) and already the field `web/server/lib/results.js` inserts
`game_players` on, and that file already refuses a row with no id: *"a row keyed on a made-up id
would attach somebody's badge to nobody"*. The game simply never produced one. Two asks, both
additive:

* **host agent** — carry `identity` from `player_connect` into the posted summary's player rows,
  and send `end {..., "match": "<next match id>"}` on a reuse, so a warm instance can lease-check
  the successor game's tokens (`ENW_MATCH` is read once, at process start; the referee clears the
  id on reset rather than keep a stale one, because a stale id refuses every legitimate token).
* **web** — when `identity` is present and is not `verified`, store the row but award no XP and no
  record. Today the site would credit a `claimed` row, which is only reachable when the box itself
  was configured not to enforce.

### 13.6 The harness: `tools/dev/authhost.mjs`

The token half of a host agent and nothing else, because the real one needs a site, a lease and a
box registration that a join test has no business standing up. What it does NOT stub is the part
under test: it **issues with `web/server/lib/tokens.js`** (against a scratch `ZM_KEY_DIR`, never
`web/keys`, never the live DB) and **verifies with `infra/host-agent/lib/tokens.js :: TokenGuard`**,
both imported unmodified.

```
node tools/dev/authhost.mjs mint  --keydir <d> --match <m> --steamid <id64> [--slot N] [--forge]
node tools/dev/authhost.mjs serve --keydir <d> --match <m> --port 38795 --out <transcript>
node tools/dev/authhost.mjs selftest --keydir <d>
```

`serve` writes every line of the link in both directions to a transcript, which is where the
`player_connect` and `game_over` JSON quoted below comes from. `--forge` keeps the site's real
signature over an edited payload — a forged token, not a corrupt one, which is the case that has to
be caught.

### 13.7 Runs

**`join94` — a result that belongs to an account, five gates, PASS.** `nazi_zombie_prototype`,
300 s, one real client launched with an invite token this site's own code minted, one
`authhost.mjs serve` holding the link. Token → userinfo → referee → host → back again, with
nothing hand-copied at any step:

```
referee: identity gate armed, match=m_id94
referee: player_connect slot 0 name='anna-jpg' steamid=76561198000000042 identity=claimed
[authhost] auth slot 0 anna-jpg 76561198000000042 identity=claimed: ALLOW (ok)
referee: slot 0 identity VERIFIED by the host (steamid=76561198000000042, ok)

{"t":"game_over","ms":130344,"round":1,"reason":"stop_intermission notify","duration_ms":128594,
 "players":[{"slot":0,"name":"anna-jpg","connected":true,"steamid":"76561198000000042",
             "xuid":"76561198000000042","identity":"verified","party_slot":0,
             "revives":0,"alive":true}]}

CS_ACTIVE=1 ROUND1=1  76 of 76 getstatus answered  frame::count 59.0 Hz
com_frameTime +30004 ms over the last 30 s  Com_Frame-body 59.2 Hz  PASS
```

**That last block is the whole point of the session.** The box's first real game (site game id 2)
posted `game_players = 0`; §12 turned that into a row with a name; this is a row with an account,
carried on the one message a host may post a result from. *(The steamid is an invented
`76561198000000042`, per the standing rule that test data never carries a real person's id.)*

**`join95` — a forged token is refused, and the refusal reaches the player.** Same run, same
client, one difference: `authhost.mjs mint --forge` rewrote `sid` in the payload to
`…999999999` and kept the site's real signature over the original body.

```
referee: player_connect slot 0 name='anna-jpg' steamid=76561198999999999 identity=claimed
[authhost] auth slot 0 anna-jpg 76561198999999999 identity=claimed: DENY (bad_signature)
referee: slot 0 REFUSED (bad_signature) -- its roster row carries no steamid and nothing
         may be awarded to it. referee.md 13.
referee: console command queued: clientkick 0
referee: clientkick 0 (bad_signature) queued
referee: player_disconnect slot 0 ('anna-jpg')          <- 27 ms after the DENY
```

So `clientkick <slot>` **is** a command on this exe and the second line of defence works; the
first line (no steamid on the row) never depended on it.

**`integration-site`, host agent against a real site, 0 failures.** Run against a throwaway site
(`PORT=3277`, its own `ZM_DATA_DIR`, its own `ZM_KEY_DIR`, its own seeded DB — never :3200, never
`web/data`, never the live key) with a scratch box key dir: *"both players are on the game with
XP"*, `game_players` = **2**, 1193 XP each, replay VALID against the pinned key, step 4 *"a forged
token is still refused by the real box"* green. **Nothing in `infra/host-agent` or `web/` had to
change** — the field the site inserts `game_players` on was always `steamid`, and it was always
the game that failed to send one.

**`tools/dev/authhost.mjs selftest`, 8/8**: a site-issued token verifies at the box; a payload
edited to another steamid is `bad_signature` and is not seated; the second presentation of the
same token is `replayed`; a token for another match is `wrong_match`; a token past `exp` is
`expired`.

**Not run, and it is the one gap in §13.4:** the game-side `replayed_token` and `wrong_match`
refusals have not been seen in a join run. Both need a second client (or a deliberately mismatched
`-MatchId`) and the game lock went to a launcher-lane local game before either could be taken.
The host-side halves are measured above and the game-side code is the same edge the measured
`bad_signature` refusal runs through — **which is an argument, not a measurement**, and is written
here as one. `waw-c2` is deployed and ready; the run is
`jointest.ps1 -Tag join97 -AuthToken <the token slot 0 used> -MatchId <its match>` with a second
`launch.ps1 c2 -Role client -Companion -AuthToken <the same token>` fired 40 s in.


## 14. 2026-09-23 — the name in the game belongs to the account, and the server says so

B: *"Make people's usernames their ENW username. When they sign in, their username in World at
War is locked to the ENW name and they can't spoof another name at all. Right now it says
Unknown Soldier, which is annoying."*

### 14.1 Where "Unknown Soldier" came from, because it is not a string in this repo

It is the **engine's stock default for the `name` dvar**. Nothing ever passed `+name`, so every
client booted as "Unknown Soldier", the referee read that off the roster, the box posted it in
the result, and `web/server/lib/results.js` wrote it straight back into `users.username`:

```js
users.ensure(sid, { username: str(p.name, 64) })      // removed 2026-09-23
```

The live database proves the loop closed: the owner's row held `username = 'Unknown Soldier'`
and every other approved row held `NULL`. **The site was displaying a name the game invented
about itself.** That write-back is gone (the retraction is in place in `results.js`), the seven
approved accounts are named from the site's own approvals, and the direction is now one-way:
site → token → game, never back.

### 14.2 The engine's name path, mapped

`re` mapped the whole chain. Every address below is **[V]** in the dump and is now in
`shared/t4/addresses.hpp`:

```
client sends  userinfo "\name\whatever\rate\25000\..."
  -> SV_ExecuteClientCommand 0x6308F0   walks ucmds[] at 0x8D0348 (the "userinfo" slot 0x8D034C)
  -> SV_UpdateUserinfo_f     0x6307E0   I_strncpyz(cl+0x6F0, Cmd_Argv(1), 0x5FF)  __cdecl(client_s*)
  -> SV_UserinfoChanged      0x630650   cl->name (+0x11548, 32B) = Info_ValueForKey("name")
                                        **client_s* in ESI** -- never prototype this as cdecl
  -> ClientUserinfoChanged   0x67BCF0   __cdecl(int clientNum); re-reads cl+0x6F0, ClientCleanName
                                        0x67BC70, writes gclient+0x21F0 / +0x215C and the
                                        clientinfo record 0x18DD258 + i*0x594, name at +0xC
helpers  Info_SetValueForKey 0x5F71F0   __cdecl(char* s, key, value); MAX_INFO_STRING 0x600;
                                        SILENTLY strips backslash, ';' and '"' from the value
         Info_ValueForKey    0x5F6DF0   **infostring in ECX**, key at [esp+4], rotating static buffer
```

Two corrections fall out of this and are worth more than the feature:

* **`SV_ExecuteClientCommand = 0x4621E0 [C]` is withdrawn.** That is not the function. 0x6308F0
  is the one that dispatches `ucmds[]`, proven by the table walk.
* **`client_s.userinfo = +0x6F0` is upgraded [H] to [V]**: `ClientUserinfoChanged` computes
  `0x2547780 + i*0x58D30`, and `0x2547780 == 0x2547090 + 0x6F0`, which re-derives the clients
  base and the offset from a *second* function.

One thing is **not** proven and is written down as not proven: **there is no `CS_PLAYERS`
configstring in this SP exe.** `re` found no site that computes a configstring index as
`base + clientNum` on the userinfo path, and `ClientUserinfoChanged` never calls
`SV_SetConfigstring` (0x6311E0). The per-player scoreboard data goes into the in-process
clientinfo array at **0x18DD258, stride 0x594, name at +0xC** instead — *likely*, on two
functions agreeing (the writer above and the client-side reader 0x4E94A0), not measured.

Also worth recording, because it made an earlier search fail: **every `Com_Error`/`Com_Printf`
literal in this build is 0x15-prefixed and pushed as `stringVA - 1`**, so `t4map.py sxref`
indexes them one byte late and finds nothing for the `Info_*` helpers.

### 14.3 The lock — `server/components/referee/name_lock.cpp`

Hook **`SV_UpdateUserinfo_f` 0x6307E0**, one MinHook, owned by this component. It is the single
writer of `cl->userinfo` on the client path, it is clean `__cdecl(client_s*)`, and it fires only
on a real `userinfo` command. `SV_UserinfoChanged` and `ClientCleanName` take register arguments
and are therefore neither hooked nor prototyped (map rule 4); they are reached only through the
engine's own chain.

The original runs **first** — it is a tail-jump into `ClientUserinfoChanged`, so the client's
`rate`, `snaps` and `cl_voice` are applied in full, which is none of our business — and then, if
the name it applied is not the one this slot is locked to:

1. `Info_SetValueForKey(cl->userinfo, "name", locked)` — the server's authoritative copy
2. `cl->name` (+0x11548) = locked — what `SV_UserinfoChanged` derived
3. `ClientUserinfoChanged(slot)` — the engine rebuilds gclient and the scoreboard record **from
   the buffer we just corrected**. Nothing downstream is poked by hand.

**Only a slot whose token verified is locked.** The lock arms in `do_auth()`, on the same edge
that promotes `claimed` to `verified`, from the token's `n` — which the site now reads out of the
`users` row at lease time rather than taking from the lease caller (`lib/assignments.js`; a
caller-supplied name would be a *signed, server-enforced* impersonation, strictly worse than the
spoofing this replaces). An untokened client — Play Local, `jointest.ps1` with no `-AuthToken` —
is never locked and keeps whatever name it launched with.

`p.token_name` is kept apart from `p.name` deliberately: `p.name` is what the *engine* reports and
is therefore the spoofable one. Binding the lock to it would lock the slot to the lie.

A `tick()` in the existing per-frame poll compares `cl->name` per locked slot — a 32-byte compare
that does nothing when nothing is wrong — and shouts if the name ever drifts outside the userinfo
path. It never has.

### 14.4 Runs — `namelock1/2/3`, five gates, PASS, and what is still open

`nazi_zombie_prototype`, client launched with `+set name spoofer` **and** `ENW_PLAYER_NAME=spoofer`
(the client DLL's `name_pin` re-asserting it every 3 s), token minted by the site's own
`lib/tokens.js` naming `enw-tester`.

```
namelock: bound SV_UpdateUserinfo_f 006307E0 (Info_SetValueForKey 005F71F0,
          ClientUserinfoChanged 0067BCF0). A verified client's name is the token's.
referee: player_connect slot 0 name='anna-jpg' steamid=76561198000000042 identity=claimed
referee: slot 0 identity VERIFIED by the host (steamid=76561198000000042, ok)
namelock: slot 0 connected as something else; name set to 'enw-tester' at the connect edge
referee: slot 0 connected as 'anna-jpg' but the token says 'enw-tester' -- the token wins
[client]  name_pin: pinned `name` to 'spoofer' (re-set every 3000 ms)

{"t":"game_over","ms":137610,"round":1,"players":[{"slot":0,"name":"enw-tester",
  "steamid":"76561198000000042","identity":"verified",...}]}

CS_ACTIVE=1 ROUND1=1  com_frameTime +30009 ms  Com_Frame-body 58 Hz  PASS
```

*(`anna-jpg` rather than `spoofer` on the connect line because the client's own
`profiles/anna-jpg/config.cfg` execs `set name anna-jpg` **after** the command line is read. It
makes no difference to the test — the client asked to be called something the token does not say,
which is the whole case under test — but it is why the transcript does not read `spoofer` there.)*

**PROVEN.** The result the host posts — the one message the contract lets it build a result from
(§10.3) — names the ENW account and not the client's claim. The server's copy of the name did not
drift once in 145 s of frames while the client believed it was called `spoofer`.

**NOT PROVEN, and the counter says so out loud.** The periodic line reads

```
referee: namelock: bound, userinfo commands seen 0, names put back 1
```

**Zero.** The client sent no `userinfo` command after connect, so the hook has never been observed
firing — only the connect-edge enforcement has run. The reason is not a fault: the engine marks a
dvar modified only when the value actually *changes*, so `name_pin` re-setting `name` to the
value it already holds sends nothing. The claim "and again on every userinfo change" is therefore
**an argument from the hook being bound at the proven address, not a measurement**, and it is
written here as one. The run that settles it needs a client that changes a userinfo dvar to a
*different* value mid-game — a human typing `\name x` in the console is the cheap version — and
what it must show is that line's first number going up and `names put back` following it.

Also unproven: **what a second client's scoreboard shows.** The enforced name is rebuilt by
`ClientUserinfoChanged` into the clientinfo record, which is the right mechanism, but nobody has
watched it from another client's screen. Needs two real clients.

One ordering note for anyone reading a transcript: **`player_connect` still carries the client's
own name.** It is emitted at the connect edge, before the host's `auth allow` has come back, so
the row is `claimed` and nothing is locked yet. `game_over` is the message that carries the
enforced name, and it is the one the site credits from.

### 14.5 The harness

`jointest.ps1` and `jointest-proof.ps1` gained three pass-through parameters, all additive:
`-ClientNameDvar <name>` (puts `+set name <name>` on the CLIENT's line *and* sets
`ENW_PLAYER_NAME` for the client DLL's pin, so the client asks to be called that by every means
it has), `-ServerFrom` and `-ClientFrom` on the proof script (it could only ever deploy
`build\dedi`, which meant a lane building into its own directory — dev-box rule 11 — had no way
to take its build through the five gates).

## 15. 2026-09-22, evening — the players' pause, and why it does not touch a Verified run's time

The engine half is `dedi.md` §18: the dedicated server now really freezes (the one
`call G_RunFrame` is gated; `svs.time` and `level.time` are held together, so resume is seamless).
This section is the rule and the accounting.

### 15.1 The rule lives in the DLL, the accounting in the host

`server/components/pause/pause_policy.hpp` (pure, no engine; `server/tests/pause_policy_test.cpp`,
25 checks) decides from each client's userinfo `enw_ui` / `enw_pchat` (contract: `chat-overlay.md`
§8):

| connected | paused when | never |
|---|---|---|
| 0 | — (a disconnect counts as unpaused) | |
| 1 | `enw_ui paused` (Esc menu), or `typing` with `enw_pchat 1` | |
| 2–4 | **every** one is `paused` | `typing`, however many type |

The host's own `pause` (crash grace, everyone-AFK, operator) is a hold OR-ed on top; the players
cannot release it. The DLL reports `pause_state {paused, reason: host|solo_menu|solo_chat|all_menu|
none, players, held_ms?}` on every transition and `ui {slot, ui, pchat}` per client change.

Why the DLL and not the host: no round trip between the key and the freeze, and it works the same
whatever the link is doing. The host still sees everything and still owns *time*.

### 15.2 Paused time stays out of in-game time — for every pause, whoever asked

`infra/host-agent/lib/referee.js`:

* `ev_pause_state` with a non-`host` reason, in a **live** game → `pause(label, {fromGame:true})`:
  the pause window is recorded exactly like a host pause (`pauses[]`, `pausedMs` on resume, flag
  `paused`), but **nothing is sent back** — a `pause` echo would become a host hold that the
  player's unpausing could never release — and the solo player is not `say`-told what he just did.
* `paused:false` ends it through `resume(…, {fromGame:true})`; `pausedMs += wall time paused`.
  `elapsed()` (the boards' in-game time, `duration_ms`) excludes it; `elapsedRta()` includes it, as
  before. `records_eligible` does not look at `paused`: pausing costs a Verified run nothing.
* a `host` reason is our own hold echoed back and changes nothing; a game `paused:false` cannot end
  a host pause.
* a freeze before go-live (the load) is shown (`state().game_pause`) and not accounted — there is no
  in-game time yet to exclude.
* the last player leaving from a solo Esc pause: `maybePauseForCrash` closes the players' window and
  opens the crash hold, so the grace window and the resume countdown still apply.
* **AFK**: `resume()` now moves every player's `lastInputMs` (and `allAfkSinceMs`) forward by the
  pause's wall time. Before this, any pause over ten minutes resumed straight into an AFK warning
  and one over fifteen into a kick. This applies to host pauses too.
* no ceiling (B): `resume` logs `resumed: <why> (<game|host> pause, N s, M connected)` every time.

Six new checks in `infra/host-agent/test/run-all.js` (56 total, green): solo Esc accounted with no
echo and records intact; host echo ignored; host-hold → players hand-over; load-time freeze shown
not accounted; players' pause → crash hold; a 30-minute co-op pause does not AFK-warn.

### 15.3 Not done / not proven

* A real client sending `enw_ui` — the client DLL half is the overlay lane's (`chat-overlay.md` §8).
  Until it ships, the only way to pause a dedi is the host's `pause`.
* Replay: the sampler keeps running while frozen (identical frames, wall `ms`), so a replay includes
  the paused stretch as a still. Harmless; trimming it is a replay-lane choice.
* Two real clients (the co-op rule end to end) — not possible tonight; B was playing.

### 15.4 2026-09-23 01:10 — the box crash after a pause: what writes the slot, and the guards

**The report.** B's solo Nacht (`m_506fba68`, inst-02, `enw-3040.log`): a 24,499 ms `solo_chat`
pause at 00:01:57, then `RESUMED` at 00:02:21 with a clean `+50 ms` first frame. The game played on
for 30 s (usercmds, button masks, 50 Hz). Then at 00:02:51 `dedi_reflection_dvars: [0x03BFD478]
CHANGED from 021C1DF0 to 00005FAD`, and from 00:02:56 the frame body was dead (`Com_Frame-body 0.0
Hz`), which is §12.1's mechanism. The suspicion was that the resume path writes the pause length
(0x5FAD = 24,493) into engine memory.

**What the code writes, all of it.** No code in this repo writes a pause length into engine memory.
The DLL writes engine memory in three places, all only while frozen: `svs.time` (0x2547084), each
active client's `nextSnapshotTime` (`svs.clients[i]+0x1161C`, i < 4), and `sv_paused`'s current
value (0 or 1). `held_ms` goes only onto the game link. The AFK shift in `resume()` (§15.2) is
`infra/host-agent/lib/referee.js`, a separate Node process on the box, and it cannot touch the
game's memory.

**What does write that slot is already on record.** `dedi.md` §13.2 caught it with a data
breakpoint: `mov [ebx], esi` at 0x697B97 in 0x697B60, the script VM's child-variable enumeration.
It pushes each child's **name id** into `scrVmPub.localVars` with no bound check, and an overrun
lands on `[0x3BFD478]` first. `00005FAD` is a script string or name id, not a time. The earlier
failing game supports this. `enw-1024.log` (inst-01, 23:44, also Nacht, **13 pauses**, not zero)
wrote **`00001DE3`**, and no pause length or sum in that game matches it. Its last resume was
54 s before the write; in `enw-3040` the gap was 30 s. So 0x5FAD ≈ 24,499 is a coincidence.

**What is NOT known.** The questions still open:
- Whether the pause *causes* the VM overflow or it is Nacht's own. Two other paused games on the box
  (`enw-2876` fear_mc_2, `enw-2948` Nacht, one pause each) did not fail.
- What the script was enumerating.
- Whether `localVars` creeps across a freeze. While G is frozen, notifies raised outside
  `G_RunFrame` (ClientThink, client commands) still run script threads, so a creep would be the
  mechanism to look for.

**Changes (DLL):**
- **Write guards** (`pause_policy.hpp`, 12 new checks, 37 total):
  - The gate writes `svs.time` only if the value there is `frozen .. frozen+1000`. Anything else
    releases the freeze with `pause: GUARD …` and holds it released until every asker lets go.
  - It pulls a `nextSnapshotTime` down only if the value is `frozen+1 .. frozen+5000`.
  - It touches only `sv_maxclients` slots, clamped to 4.
  - A pointer, a string id or a wild count can never be overwritten.
- **A `localVars` probe.** It is read-only and costs one dword read, on these lines:
  - `PAUSED`, every `FROZEN` line, and `RESUMED` (current value and the value at pause start);
  - then `pause: after resume +N s: localVars …` every 5 s for a minute.

  The next repro therefore shows directly whether the pause moves the VM scratch pointer.

**Next repro, for whoever deploys this:** also set `ENW_DEDI_WATCH_PROBE_SLOT=1` on the instance
(dedi.md §13.2). It logs the EIP and registers of whatever store hits `[0x3BFD478]`, so the next
failure names its writer instead of leaving it to inference.
