# Verified rules: speedrun and record compliance (2026-09-23)

B: *"parity and compliance with speedrunning and record rules, technical details in particular
with regard to entity spawning and all these weird things. Our verified mode must be compliant.
And if there are maps we host that are not speedrun-verified but become so because you can run
them with those settings, say so."*

Tags: **[C]** read from a primary source (rules text, API, our code, extracted stock scripts) ·
**[M]** measured in a real game · **[S]** search snippet only · **[U]** inference.

## 1. The answer, short

- **Verified is now compliant on every technical setting a board names, and it can prove it.**
  - The server reports its own cheat, time and movement dvars.
  - The client reports its FPS cap and is held to 20–250.
  - The host refuses a record when a reported value breaks the rules.
  - The result carries what was enforced and what was seen (§6).
  - It is not live until the coordinator deploys it: DLL to the box, launcher release.
- **Entity spawning on our dedicated server matches a listen server on Nacht [M].**
  - Same zombie count, same health, same spawn spacing to 10 ms, in rounds 1 and 2 (§5.1).
  - Our 59 Hz server loop and 20 Hz snapshots change nothing, because game time advances in exact
    50 ms steps whatever the loop does.
  - "Solo on a dedi runs co-op rules" is **false for World at War** [C + M]. Every rule branch in
    the stock scripts keys on the number of players, and a dedi with one client counts one.
- **There is one real parity gap, and it is network-dependent [C, not yet measured].**
  - On **Shi No Numa, Der Riese** and customs built on Der Riese's scripts, every spawn also waits
    for `wait_network_frame()`. That waits for a client to acknowledge a snapshot.
  - Offline solo, that is about one server frame. Over the internet it grows with ping: about
    +1 frame (50 ms) per spawn at ~60 ms, +2 at ~110 ms.
  - Nacht and Verrückt do not have it. Details §5.2; it needs a decision (§8).
- **No hosted map becomes eligible for an external board because of our settings** (§7).
  - The four stock maps were already on speedrun.com. An ENW Verified run stays submittable there
    **with a full video**, because no board accepts a server log.
  - ZWR's PC top 10 and b2 require the Plutonium client, which our settings cannot change.
  - Of the 60 customs we host, only **Prison Mission** has a community board (ZWR custom high
    rounds), and it has the same Plutonium gate.
  - All 64 hosted maps are eligible on **our own** ENW-Verified boards.

## 2. What the communities require

### 2.1 speedrun.com, `wawzombies` (the stock-map board) [C, API, ruleset of 2026-01-12]

Source: `https://www.speedrun.com/api/v2/GetGameData?gameId=w6j5y41j` and
`https://www.speedrun.com/api/v1/games/w6j5y41j/categories`.

- **Proof:**
  - Full gameplay **with game audio**, at least 360p.
  - A co-op top-3 needs every player's POV; otherwise the host's POV is enough.
- **Version:** "All runs MUST be played on the most recent version". Steam 1.7 is that.
- **Plutonium:**
  - A top-3 run on Plutonium must show `cg_flashScriptHashes 1` and `cg_drawIdentifier 1`.
  - Any run using scripts (an in-game timer, the backspeed fix) must be on Plutonium with the
    checksum on screen.
  - Plutonium is allowed but **not required**.
- **Allowed:** FOV, windowed/fullscreen, FPS (no number is given), backspeed fix, fast restart,
  in-game timers, custom resolutions, console commands if the console is shown and gains nothing.
- **Not allowed:** custom corpse count, no fog, god mode (even for sleepers or breaks), infinite
  Death Machine, zombie counter, health meters, transparent textures. AFK glitches are allowed
  only for sleepers or breaks.
- **Timing:** real time (RTA), no load removal.
  - Start: "First frame the playable area is visible during fade in."
  - End of a round category: "As soon as Round N appears on the screen."
  - Song ends on the radio static. Pack-a-Punch ends on the pickup. Fly Trap ends on the last
    item shot.
- **Categories:**
  - Solo / 2P / 3P / 4P, on each of the four maps.
  - Song; Door (Nacht only); Round 5/15/30/50/70/100.
  - Der Riese also has Pack-a-Punch and the Fly Trap EE.
  - Per-level: First Room, No Perks, No Power to R15.
- **Silent on:** listen vs dedicated server, what "Solo" means (menu or a one-player lobby),
  pausing, and an FPS number.

**Category Extensions** (`j1n0zydp`) add All Maps R15/R30, All Songs, 25K Points, PaP All Guns,
Peter%, Free Max Ammo and challenge rounds. "ALL RULES FROM EACH RESPECTIVE GAME APPLY."

**No speedrun.com board exists for WaW custom maps.** The API name searches found none.

### 2.2 ZWR (zwr.gg) and b2 (b2.wtf): the high-round rulebooks

From vault note 10 §2 and R6, which quote the rules pages [C]:

- **Settings:**
  - FOV ≤ 120, and FOV × `cg_fovScale` ≤ 120.
  - **FPS ≤ 250.** b2: "Max FPS changes are ALLOWED in range of 20 to 250", but no mid-game change
    to save yourself.
  - Backspeed and strafe scale ≤ 1.0.
  - `sv_cheats 0`, Regular difficulty.
- **Allowed:** automatic game and round timers; the insta-kill indicator (Nacht and Verrückt).
- **Banned:** zombie counter, end-of-spawns indicator, auto trap timer, fog or foliage removal,
  fast ray.
- **The client:**
  - Since 2026-01-27 ZWR's **PC top 10 requires Plutonium** with a verified patch.
  - Since 2025-09-18, WaW Plutonium runs must show `cg_drawIdentifier 1` and
    `cg_flashScriptHashes 1`.
  - b2: "Loading any GSC scripts other than the community patch is NOT ALLOWED"; plugins and memory
    writing are banned.
- **Proof:** full video. No board accepts logs instead.
- **Reconnects:**
  - ZWR: allowed if you are back before the round changes. Sleepers via disconnect are allowed;
    substitutes are not.
  - b2: disconnect, reconnect and pause are allowed in co-op on Plutonium.
- **Pauses:** ZWR removed its EE "pause abuse" rule on 2024-04-10 (`https://zwr.gg/news/59`).

**Re-read this pass: ZWR's rules page only renders in a browser**, and the fetch saw menus
[see R16 §2]. The 2025-09 WaW rules vote (`https://zwr.gg/news/88`) has no published result that
we found. Everything above is as of R6. **Read zwr.gg/rules in a browser before quoting ZWR to
players.**

### 2.3 Plutonium T4 (what the Plutonium boards assume)

- "'cheat state' is triggered if a client's `com_maxfps` dvar is set above 250" [C, their
  changelog, R16 §2]. **250 is the line everywhere.**
- The low-FPS doc says "shouldn't go above 250" [S].
- Plutonium runs dedicated T4 zombies servers (`https://plutonium.pw/docs/server/t4/setting-up-a-server/`).
  No evidence was found of a record set on one, and **no board has a "no dedicated server" rule** [C,
  absent from every rules text read].

### 2.4 The FPS physics, for why 250 is the line

- The engine's cap is whole milliseconds, `1000 / com_maxfps` (R16 §1, our dump `0x59DD37`). So
  240 runs at 250, and 334–500 all run at 500.
- Jump height is flat from 125 to 250 (about 41 units) and jumps at 333 (46+). Sources:
  `https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS` and R16's table.
- No sourced fire-rate or knife effect was found for WaW.

## 3. The stock server values (measured, so the rules are not guesses)

A real ENW dedicated server's own dvar dump is
`ZombiesDev\logs\dedi\maps\nazi_zombie_leviathan.console.log`. The values Verified now holds the
server to, all stock:

| dvar | stock | dvar | stock |
|---|---|---|---|
| `sv_cheats` | 0 | `player_sprintSpeedScale` | 1.5 |
| `timescale` | 1 | `player_sprintUnlimited` | 0 |
| `fixedtime` | 0 | `player_sustainAmmo` | 0 |
| `developer` / `developer_script` | 0 / 0 | `player_meleeRange` | 64 |
| `g_gameskill` | 1 (Regular) | `player_lastStandBleedoutTime` | 30 |
| `g_player_maxhealth` | 100 | `perk_weapReloadMultiplier` | 0.5 |
| `jump_height` | 39 | `bg_fallDamageMaxHeight` | 350 |
| `player_backSpeedScale` | 0.7 (ZWR: ≤ 1.0) | `arcademode` | 0 |
| `player_strafeSpeedScale` | 0.8 (ZWR: ≤ 1.0) | `zombiemode` | 1 |

**Reported but not judged** (they describe the server, not the run):

- `sv_fps 20` (stock).
- `sv_maxRate`: 7000 stock, 25000 on the box, network only (dedi.md §22).
- The server's own `com_maxfps` (60, its loop pacing; dedi.md §11).
- `onlinegame` is **1** on our dedi; `systemlink` is 0. See §5.3.

`g_speed`, `g_gravity` and `ai_disableSpawn` are not in this exe's dump as registered dvars. They
are not watched.

## 4. Our build against the rules

What the DLL, the launcher and the server force or allow in a Verified game. **Status** is after
today's changes.

| What | Where | Value in Verified | Rule | Status |
|---|---|---|---|---|
| `com_maxfps` (client) | launcher `clampFps`, DLL `fps_guard` (new) | 30–250 at launch; **held to 20–250 mid-game**; reported to the server | ≤ 250 (all); b2 20–250 | **compliant, enforced + proven** (was: launch only, a console change was invisible) |
| `com_maxfps` changed mid-game | host `verified.js` | **refuses the record** (strictest reading) | b2: changes allowed inside 20–250, not "to save yourself" | compliant (stricter than b2; `verifiedAllowFpsChange` relaxes it, §8) |
| uncapped FPS (`com_maxfps 0`) | `fps_guard` → cap; host refuses | not possible | ≤ 250 | **compliant** (was: reachable from the console) |
| `cg_fov` | launcher `clampFov` 65–120 | ≤ 120 at launch | ZWR ≤ 120; SRC free | compliant at launch; **a mid-game change is not reported** (follow-up, §8) |
| `cg_fovScale` | not set | stock 1 | FOV × scale ≤ 120 | compliant unless the console changes it; **not reported** (follow-up) |
| `sv_cheats`, `timescale`, `developer*`, `fixedtime` | server | stock (table §3), **reported, judged for the whole game** | 0 / 1 / 0 | **compliant, proven** (was: never reported; `records.js` checked a dvar map that was always empty) |
| movement / survival constants (§3) | server | stock, reported, judged | backspeed/strafe ≤ 1.0; SRC: no god mode | **compliant, proven** |
| a lease's own `settings.dvars` | host `instances.js` | **refused in Verified** (new) | stock game | **compliant** (was: any dvar a lease carried went onto the server's command line) |
| `snaps 30`, `rate 25000`, `cl_maxpackets 100` (client) | launcher | network only | no rule; Plutonium's own recommendations | compliant |
| `sv_maxRate 25000` (server) | `net_probe.cpp` | network only | no rule | compliant |
| server loop 59 Hz, `sv_fps 20`, snapshots ≤ 20/s | dedi | game time in exact 50 ms steps | no rule | **compliant, measured §5.1** |
| raw mouse input | DLL `mouse_polling` | input only | no rule; Plutonium ships raw input too | compliant [U: no board names it] |
| borderless window | DLL `borderless` | display only | SRC: windowed/fullscreen allowed | compliant |
| direct boot, no intro, no message boxes | DLL `boot_direct` etc. | before the fade-in | timing starts at the fade-in | compliant |
| Esc-menu **Restart** | `restart_request.cpp` | a new match | SRC: fast restart allowed | compliant |
| chat overlay, Esc menu | DLL, drawn by the renderer | no counters, no timers, no health | banned: zombie counter, health meter, corpse count | compliant [C: no such element exists]; renderer calls use **no entity slots** |
| **pause** (solo Esc, co-op all-menu, host crash hold) | DLL `pause/`, host | in-game time excludes it, RTA includes it, every pause logged; **off on the box today** (`ENW_NO_PAUSE=1`) | SRC: RTA (pauses count); ZWR/b2: breaks allowed | **needs a decision** (§8), not changed here |
| co-op pause | DLL | freezes everything | stock online co-op has **no** pause | **non-vanilla**, needs a decision (§8) |
| crash **state restore** | not built | — | not vanilla | the record profile already forbids it (vault 10 §5) |
| ghosts / replay markers | not in game | — | entity budget | compliant (none spawned) |
| LAA flag on our exe copy | launcher | memory only | no rule | compliant [U] |
| aim assist (`aim_autoaim_enabled`, `aim_lockon_enabled`) | stock dvars; controller path | not set, not reported | not named by any board read | **unknown**, open question (questions.md) |
| client | ENW DLL on Steam 1.7 | — | ZWR PC top 10 and b2: Plutonium only | **not eligible there**, by client, whatever the settings (§7) |
| proof | signed replay + event log + `verified_env` | — | every board: full video with audio | ENW boards: our proof. External boards: **the player must also record video** |

## 5. Entity spawning and round timing

### 5.1 Measured: our dedicated server vs a listen server, Nacht der Untoten [M]

Tool: `tools/dev/spawncadence.mjs <replay|capture>`. A spawn is the first snapshot a zombie
entity appears in; health is read off the entity.

| Game | Server | Round 1 | Round 2 |
|---|---|---|---|
| capture `nazi_zombie_prototype-20260920-035402` (5 round-1 starts) | **listen** (solo SP, referee in process) | 4 zombies, hp 150, **3.00 s** apart (2.98–3.02) | not reached |
| replay `m_0afb449b` (inst-03, 2026-09-22, one real client) | **our dedi** | 4, hp 150, **2.997 s** mean | 9, hp 250, **2.852 s** mean |
| replay `m_6d80aa20` (inst-04, 2026-09-23, B's game) | **our dedi** | 4, hp 150, **2.999 s** mean | 9, hp 250, **2.850 s** mean |

What the stock script says [C, `nazi_zombie_prototype.ff :: maps/_zombiemode.gsc` 825–883, 1209–1224]:

- max = 24 + (players − 1) × 6 × multiplier, scaled ×0.2 in round 1 and ×0.4 in round 2. For
  solo that is **4, then 9**; for two players 6, then 12.
- Spawn delay 3 s, × 0.95 per round, so **2.85 s** in round 2.
- Health 150, then +100 per round.

The dedi matches exactly. The 2.80/2.90 alternation in round 2 is the 20 Hz sample grid
quantising 2.85 s; the mean is exact. **The count of 4 and 9 proves the dedi counts one player**:
there is no hidden host player on a headless server.

Why the server loop does not matter [C, dedi.md §18.2]:

- `SV_Frame` adds each frame's milliseconds to a residual and runs `G_RunFrame` once per whole
  50 ms, with `level.time` stepping exactly 50.
- GSC `wait()` counts `level.time`. So spawn delays, the 10 s between rounds and the 15 s
  intermission are identical at any `com_maxfps` or loop rate.
- The 59 Hz loop only decides how late in wall time each 50 ms step is delivered: at most one loop
  period (~17 ms), and never accumulated.
- Also measured: 12,000 frames in 598,765 ms wall (dedi.md, the `SV_Frame` 20.0 fps row). Game
  time kept pace with the wall clock.

### 5.2 The real gap: `wait_network_frame()` on Shi No Numa, Der Riese and their descendants [C]

`common.ff :: maps/_utility.gsc:9896`:

```
wait_network_frame()
{
    snapshot_ids = getsnapshotindexarray();
    acked = undefined;
    while (!isdefined(acked))
    {
        level waittill("snapacknowledged");
        acked = snapshotacknowledged(snapshot_ids);
    }
}
```

It returns when the clients have **acknowledged a snapshot**. Where it is in the spawn path:

| Map | round spawn loop | zombie rise | effect on a server |
|---|---|---|---|
| Nacht (`prototype`) | `wait(delay)` only | — | none |
| Verrückt (`asylum_patch`) | `wait(delay)` only | loop in `_zombiemode_spawner` 2361 | ~none for the round |
| Shi No Numa (`sumpf_patch`) | `wait(delay); wait_network_frame();` (1409) | yes (2948) | + one ack per spawn |
| Der Riese (`factory_patch`) | `wait(delay); wait_network_frame();` (1620) and after dog spawns (1605) | yes (3320) | + one ack per spawn |
| customs | most ship the mod tools' `_zombiemode.gsc`, which is Der Riese's | | same as Der Riese [U] |

How big the effect is:

- Offline solo, the ack comes over loopback, and the wait is about one server frame.
- On a server it is **one snapshot out plus one client packet back, rounded up to the next 50 ms
  server frame** [U: from the mechanism, not yet timed].
- At ~30 ms ping that is still one frame. At ~60 ms it is +1 frame (+50 ms) per spawn; at ~110 ms,
  +2.
- It barely matters early (3 s gaps). At high rounds the delay floors at 0.08 s, so an internet
  player's spawns can run **up to about half as fast** as offline solo on these maps.
- That makes round-N speedruns on Shi No Numa and Der Riese slower on any server than offline solo.
- It is not ours alone: any online game with a remote client pays the same, Plutonium co-op
  included.

**Measurement to run (the lock was free, but it needs a remote client, so it is left for the
coordinator):**

1. Lease Der Riese on the box as a Verified game, and join from a client with a known ping (the
   dashboard's per-player ping, or `ping` to the box).
2. Play rounds 1–3 (ideally to round 12+, where the delay floors).
3. `node tools/dev/spawncadence.mjs <replay>`: the mean gap minus the script delay
   (3.0 × 0.95^(r−1), floor 0.08) is the ack cost per spawn.
4. Repeat from a local client on the dev box (ping ≈ 0) as the control, and once offline
   (Play Local, a listen server) for the solo baseline.
5. Expect +0 / +50 / +100 ms per spawn at <40 / ~60 / ~110 ms ping. Anything else means the
   model above is wrong.

### 5.3 `onlinegame 1` on our dedi [C]

`maps/_callbackglobal.gsc` reads `onlinegame` and `systemlink` into `level.onlineGame` and
`level.rankedMatch`. They choose:

- the pre-game briefing menu (online) or a black screen (offline);
- whether to upload to Treyarch's leaderboards;
- `_endmission` text.

No gameplay branch reads them in the stock zombies scripts. Every rule difference is on
`get_players().size`: zombie count, Verrückt's early-round count, "never ignore a solo player", the
death text. **So a one-player game on our dedi plays by solo rules.** Vault 10's worry came from
Plutonium's T5/T6 notes (solo Quick Revive), which WaW does not have.

### 5.4 Entity budget [C]

- Nothing ENW adds spawns an entity. The referee and replay sampler only read `g_entities`, and
  the overlays draw through the renderer, not HUD elements.
- The 24 alive-at-once cap (`zombie_max_ai`), the 32-enemy spawn guard (`get_enemy_count() > 31`)
  and the 1024 `G_Spawn` limit are stock and untouched.

## 6. What changed today, and how a record now carries its proof

Commit `71eba57` (and the docs commit after it):

- **Server DLL:**
  - `dvar_get` is bound: read only, and it uses the `dvar_s` layout already proven by
    `dedicated.cpp` and `net_probe.cpp`.
  - The referee sends `dvar {name, value}` for the 24 watched server dvars
    (`verified_env.hpp kServerWatch`) at load and on every change.
  - It reads each client's userinfo `enw_fps` once a second and sends `client_dvar`.
  - `game_over` now carries `dvars:{…}`, and per player `com_maxfps`, `com_maxfps_first` and
    `com_maxfps_changes`.
- **Client DLL** `fps_guard.cpp`:
  - Reports `com_maxfps` in userinfo (`setu enw_fps`) on change.
  - With `ENW_FPS_CAP` set, puts uncapped or >cap back to the cap, and <20 to 20.
- **Launcher:** `ENW_FPS_CAP=250` on every launch (`FPS_CAP`, shared with `clampFps`).
- **Host** `lib/verified.js`:
  - Judges the reports against §3 and 20–250.
  - A Verified game with a violation at any moment gets `records_eligible: false` and the
    `env_violation` flag, and is told once in game ("Not record-eligible any more: …").
  - Every summary carries `verified_env {ruleset: "ENW-Verified-2026-09-23", ok, violations,
    unknown, enforced, observed}`, so the site stores the settings with the result.
  - A missing report (an older DLL or client) is listed under `unknown` and does not refuse the
    record, until `verifiedRequireServerEnv` / `verifiedRequireFpsReport` are switched on.
- **Host** `instances.js`: a Verified lease's `settings.dvars` are dropped and logged.

Tests:

- `server/tests/verified_env_test.cpp`: 43 checks.
- `infra/host-agent/test/run-all.js`: 79 pass, 11 new.
- `launcher/test/run-all.js`: 1 new. Its one failure, "this checkout must have a client DLL to
  ship", is environmental and fails without these changes too.
- The DLL builds (`tools/dev/build.ps1 -Name verified`).

**Not proven in a game yet:**

- That `dvar` values arrive formatted like the dump. Types 5, 6 and 7 are measured; the float and
  bool formatting (types 0 and 1) is inferred from the CoD4 order. The first deployed game's log
  lines `referee: dvar … = "…"` must equal §3; an unexpected type arrives as `?typeN:…` and is
  marked unknown, never a violation.
- That `setu enw_fps` reaches the server mid-game. It is the same channel `enw_ui` proved.

## 7. Map eligibility

Hosted = the four stock maps + Minecraft Village Remastered (`SERVER_PROVEN`) + the 59 box-proven
maps (dedi.md §20).

| Map (bsp) | Community board | Categories there | From an ENW Verified game? | ENW-Verified board |
|---|---|---|---|---|
| Nacht der Untoten (`nazi_zombie_prototype`) | speedrun.com `wawzombies`, CE; ZWR | SRC: Song, Door, R5–R100, First Room / No Perks / No Power; ZWR: high round, 30/50/70/100, challenges | **speedrun.com: yes, with a full video** (settings compliant, no client rule; Solo = one player, and our solo counts are solo counts §5). ZWR PC top 10 / b2: **no** (Plutonium only) | yes |
| Verrückt (`nazi_zombie_asylum`) | same | same, no Door | same as Nacht | yes |
| Shi No Numa (`nazi_zombie_sumpf`) | same | same | speedrun.com: yes with video, **but spawn cadence depends on ping (§5.2)**, so a round-N time is slower than offline solo; say so on submission. ZWR/b2: no | yes, with the §5.2 note |
| Der Riese (`nazi_zombie_factory`) | same; SRC also PaP and Fly Trap EE | + Pack-a-Punch, Fly Trap | as Shi No Numa. PaP and Fly Trap are objective, not spawn-bound, so they are the least affected | yes, with the §5.2 note |
| Prison Mission V1.1 (`nazi_zombie_prison`) | **ZWR custom high round** ("Prison Mission") | high round | ZWR PC: Plutonium gate as above; ZWR pins map versions and **which version it uses is unverified** | yes |
| Minecraft Village Remastered (`nazi_zombie_fear_mc_2`) | none found | — | — | yes |
| the other 58 box-proven customs (dedi.md §20.1 list) | **none found**: no speedrun.com custom board exists, and none appear on ZWR's custom high-round list (Alcatraz, Battery, Casino, Clinic Of Evil, Das Herrenhaus, Der Berg, Estate of the Dead, Kowloon, Leviathan, Lockdown, Overrun, Perish, Prison Mission, Requiem, Winter Wunderland) | — | — | yes (manifest-pinned version) |

**So, B's question: no hosted map gains an external board from our settings.** The stock four keep
the eligibility they already had (video required). Prison Mission is the one custom with a board,
and its gate is the client, not the settings.

Two open checks for this table:

- ZWR's **Box Maps / Octagonal / SAW** categories name specific maps we could not read (JS page).
  Our UT BOX, CUBE, Zombie Dome and Enclosed (BaconCube) are box-style maps and **may** be on them.
  Check `https://zwr.gg/leaderboards/custom/` in a browser.
- The ZWR list mixes WaW and BO1 customs.

**Our boards against the external ones:**

- Our timer starts at go-live, the first `round` event. It is not the fade-in frame.
- Our "round N" is the `between_round_over` notify, which is not the chalk frame. So ENW times are
  **close to but not frame-identical with** speedrun.com's.
- We have no Round-N speedrun category yet (`records.js`: highest round, EE, buyable ending,
  challenges). Adding one means using the SRC definitions and ranking by **RTA**
  (`duration_rta_ms`), since speedrun.com counts paused time.

## 8. Decisions and measurements owed

1. **Pause (not changed here, per the brief).**
   - Recommendation: keep pause allowed in Verified.
   - Rank every speedrun category by **RTA**. Pauses then buy no time, exactly as on speedrun.com.
   - Rank high-round boards by round, with pause excluded, as ZWR/b2 allow breaks.
   - Keep every pause logged on the result, as now.
   - Co-op pause is not vanilla (stock online co-op cannot pause). Either allow it and mark co-op
     results `paused` on the board, or refuse co-op pauses in Verified. My lean is allow and
     mark: ZWR already tolerates breaks via sleepers.
   - The box's `ENW_NO_PAUSE=1` costs no compliance; no board requires a pause.
2. **`wait_network_frame` parity (§5.2).** Choose one:
   - (a) Label it: Shi No Numa and Der Riese round times on a server include network
     acknowledgement, as in any online game.
   - (b) A DLL change that resolves the wait in one server frame for everyone, giving offline-solo
     parity. Under vault 10's rule "a patch that changes difficulty is a different board", that is
     a timing change and needs B.
   - Measure first (§5.2 procedure).
3. **FPS changes mid-game.** The default refuses any change after go-live (strictest). b2 allows
   changes inside 20–250. Flip `verifiedAllowFpsChange` if B prefers b2's wording.
4. **Turn the requirements on** once the box runs this DLL and players have a launcher with
   `fps_guard`: `verifiedRequireServerEnv: true`, then `verifiedRequireFpsReport: true`. Until
   then a missing report is "unknown", not a refusal.
5. **`cg_fov` / `cg_fovScale` mid-game.** Not reported. The client can read them through
   `Dvar_FindVar` the same way. It is a small follow-up once the float formatting is confirmed
   by §6's first-game check.
6. **Aim assist** on Verified (questions.md, still open). No board read names it.
7. **ZWR's current rules** must be read in a browser (JS-only page) before we quote ZWR to
   players.

## 9. Sources

- speedrun.com WaW Zombies, game rules and categories (API):
  `https://www.speedrun.com/api/v2/GetGameData?gameId=w6j5y41j`,
  `https://www.speedrun.com/api/v1/games/w6j5y41j/categories`, `https://www.speedrun.com/wawzombies`
- speedrun.com Category Extensions: `https://www.speedrun.com/api/v1/games/j1n0zydp?embed=categories,variables`
- ZWR rules / boards: `https://zwr.gg/rules/`, `https://zwr.gg/leaderboards/waw`,
  `https://zwr.gg/leaderboards/custom/custom-high-round`, `https://zwr.gg/news/59`,
  `https://zwr.gg/news/88`, `https://zwr.gg/news/20`, `https://zwr.gg/custom-downloads/waw`
- b2 T4 high-round rules: `https://b2.wtf/rules/competitive/high-round/t4`
- Plutonium T4 dedicated servers: `https://plutonium.pw/docs/server/t4/setting-up-a-server/`; the
  250 cheat line: R16 §2 (their changelog)
- FPS physics: `https://wiki.zeroy.com/index.php/Call_of_Duty_:_A_Study_on_FPS`; R16 §1
- WaW split timer (ZWR-intended): `https://github.com/lsr1006/waw-split`
- Our own: vault notes 10, R6, R16; `docs/re/t4-sp-map.md`; dedi.md §8, §11, §18, §20, §22; the
  extracted stock scripts in `ZombiesDev\scripts\` (never the repo); replays in `ZombiesDev\replays\`.
