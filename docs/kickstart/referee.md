# referee — script hook points, detection strategy, and the in-process referee

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

### 8.5 Still to run
* `<fs_homepath>\main` + a mod (§3.4 follow-up) — staged, blocked because `fs_game` makes
  `BG_LoadWeaponDef` fail before GSC compiles (`dedi` p13 is on it).
* Everything that needs the notify hook and script-VM access: round/game-over from the live `level`,
  real replay capture, chat in/out, AFK, knobs, pause.
