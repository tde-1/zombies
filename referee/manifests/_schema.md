# Referee manifest schema `enw.referee.manifest/0`

One JSON file per map in `referee/manifests/<map>.json`. The host agent's referee state machine
evaluates it against the game-link v0 event stream (`docs/protocol/game-link-v0.md`) and decides
which badge the game earned, per the vault's one-badge-per-map model
(`05 - Profiles, Parties & Badges` §"The map badge"): **Easter Egg > Buyable Ending > Round N**.

A manifest is *only* about the things that differ per map. Rounds, game over, downs, revives,
points, connects and the box are detected generically for every map with no manifest entry at all
(see `docs/kickstart/referee.md` §3). **A map with no Easter Egg and no buyable ending needs no
manifest file**; the default (`round`, N = 20) applies.

## Top level
| Field | Type | Meaning |
|---|---|---|
| `schema` | string | always `enw.referee.manifest/0` |
| `map` | string | the BSP/map name, e.g. `nazi_zombie_factory` |
| `title` | string | display name |
| `source` | `"stock"` \| `"custom"` | |
| `fs_game` | string \| null | what the server must set, e.g. `mods/nazi_zombie_ali` |
| `script_fingerprints` | object | `path -> sha256` of the map's scripts **as actually loaded**. Used to notice that a re-uploaded version of the map changed its finish conditions. |
| `badge.main_finish` | `"easter_egg"` \| `"buyable_ending"` \| `"round"` | which finish mints the map badge |
| `badge.round_n` | int | the Round N fallback (staff-tunable, default 20) |
| `finishes` | array | see below; evaluated in `priority` order, lowest first |
| `signals` | array | extra per-map events worth recording in the replay / shown as ticks |
| `confidence` | `"verified"` \| `"read"` \| `"guess"` | how the conditions were established |
| `notes` | string | free text for the next human |

## `finishes[]`
| Field | Meaning |
|---|---|
| `id` | `easter_egg`, `buyable_ending`, `round`, or a map-specific id for a tick |
| `label` | what the hover card says ("Fly Trap", "Buyable Ending", "Round 20") |
| `priority` | 1 = Easter Egg, 2 = Buyable Ending, 3 = Round N |
| `when` | a condition (below). When it becomes true the finish is achieved. |
| `requires` | optional condition that must have been true earlier (ordering guard) |
| `solo_ok` | bool, default true — can this finish be reached solo |

## Conditions
A condition is one object. All of these are decidable from the v0 event stream.

| Form | True when |
|---|---|
| `{"flag":"name"}` | the level flag `name` is set. Seen as a `notify` with `ent:"level"`, `name:"name"` — `flag_set()` always does `level notify(<flagname>)`. |
| `{"notify":{"ent":"level","name":"x"}}` | that notify fired |
| `{"round_at_least":N}` | a `round` event with `n >= N` |
| `{"trigger_used":{"targetname":"zombie_door","zombie_cost":50000}}` | a `notify` `"trigger"` on an entity whose script fields match |
| `{"dvar":{"name":"x","equals":"1"}}` | dvar poll |
| `{"all":[...]}` / `{"any":[...]}` | boolean |
| `{"seq":[...]}` | each becomes true in order |
| `{"count":{"of":<cond>,"n":6}}` | the inner condition fired `n` distinct times |
| `{"manual":true}` | **not detectable** — needs staff review or a future per-map GSC hook. Never awards automatically. |

`{"manual":true}` is the honest escape hatch. Use it rather than inventing a condition: an ungated
badge is worse than a missing one.

## Added in v0 after the `nazi_zombie_ali` scan
| Form | True when |
|---|---|
| `{"level_var":{"name":"x","equals":true}}` | the script variable `level.x` holds that value. Needed because a custom map's ending may set a plain variable (`level.tom_victory`) rather than a flag — a flag notifies, a variable does not, so this one is a poll. |

`referee/scan_map.py` proposes a manifest for a map from its fastfiles and iwds. On the five maps we
have it gets the finish right 5/5 with no hand work, including finding the `nazi_zombie_ali` ending
that a manual read of the map's own scripts missed (it is in a co-shipped mod's iwd).
