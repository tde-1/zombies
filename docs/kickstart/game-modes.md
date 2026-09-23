# game modes — a map's own pre-game choice, picked on the site (lane UGX, 2026-09-23)

Lanes touched: a new server component (`server/components/game_mode/`), the host agent
(`infra/host-agent/lib/gamemode.js` + four call sites), the site (`web/server/lib/gameModes.js`,
parties / assignments / results / records, the rail and the map page), the archive
(`archive/scan_modes.py`) and one harness (`tools/dev/gamemode-proof.ps1`, `jointest.ps1
-ServerExtraArgs`). Owner of this doc: whoever next touches game modes.

**B's ask (2026-09-23, after his Battlestar Galactica game `m_da684190`, 14:14 UTC, inst-46):** the
map asked him to pick a game mode (Gun Game, Sharpshooter, Classic ...) in a menu when it started.
Pick it in the launcher instead, never show that menu in the game, and keep scores per mode — for
every map like this.

## 1. The mechanism (Battlestar Galactica = UGX Mod 1.0.x)

Read from the map's own files (`ugx_mod.iwd`, `mod.ff`; extracted with `tools/re/ff_extract.py`):

* `maps/_zombiemode.gsc` (the one in `ugx_mod.iwd`) calls `maps\ugxm_init::start_ugx_mod()`
  right after `flag_wait("all_players_connected")`.
* `start_ugx_mod()` → `handle_vote()`: freezes every player, opens **`ugxm_vote_host`** on
  `players[0]` and **`ugxm_vote_players`** on everyone else, and then
  **`players[0] waittill("voting_complete")`** — the whole game waits on the first player.
* `handle_vote_watcher(menu)` loops on `self waittill("menuresponse", responsemenu, response)`:
  `cl` Classic, `gg` Gun Game, `ar` Arcade Mode, `ss` Sharpshooter, `bh` Bounty Hunter, plus
  `timed` / `obj` / `t15`..`t60` toggles, and **`start`** notifies `voting_complete`.
* The menu (in `mod.ff`) is plain `scriptMenuResponse "gg"` etc.; which buttons show is the
  `ugxm_allow_<mode>` client dvars, set from the map's own `maps/ugxm_user_settings.gsc`
  (`set_gamemode("gungame", true)`). Battlestar's settings allow **all five** (B remembered three).
* Only the host's vote counts (`level.ugxm_players_voting = 1` unless somebody picks `start_all`).
  `start_ugx_mod()` ends with **`level notify("ugxm_voting_complete")`**, after the mode's own
  init ran — the proof that the pick took.

There is **no dvar** to pre-set: the choice exists only as a `menuresponse` notify from the host
player. So the server has to *be* that click.

**UGX Mod 1.1** (ugxm_garage, ugxm_lostwoods, ugxm_pax, salaj_dust2, the chal_* maps,
ugx_artemovsk, corridor_challenge) reworked it: non-hosts get `ugxm_save_settings_client` (never
closed by the script), the script waits on `level waittill("voting_complete")`, modes add `kh`
King of the Hill and `cm` Chaos Mode, and "start" is **any response starting `ugx_`** (the menu
packs the host's own client preferences into it, e.g. `ugx_Hold_On_On_No`; the script reads only
the prefix). We send `ugx_start`.

## 2. How it works now

```
site (party leader picks)          host agent                       dedicated server (DLL)
parties.game_mode ──lease──► game_mode spec ──► +set enw_game_mode \
  (only a mode the map        (re-checked:           gungame:ugxm_vote_host.ugxm_vote_players:ugxm_vote_host:gg.start:ugxm_voting_complete
   offers; default =           plain tokens,          (id : menus to hide : answered menu : responses : done notify)
   the map's own)              ONE host-owned dvar)
                                                       │
                     openMenu("ugxm_vote_*") ──► NOT SENT to any client (no 't' command)
                     +600 ms: menuresponse(ugxm_vote_host, "gg") as players[0]
                     +600 ms: menuresponse(ugxm_vote_host, "start")
                     level notify ugxm_voting_complete ──► game_mode {state:"done"} on the link
                                                       │
results: games.game_mode = the LEASE's; eligible only if game_mode_applied === true
records: board per mode (category `round@gungame`, boards.game_mode)
```

* **DLL** (`server/components/game_mode/game_mode.cpp`, pure parser `menu_answer.hpp`, test
  `server/tests/menu_answer_test.cpp` 21/0). Two engine touches, both byte-checked before arming:
  a MinHook detour on **`PlayerCmd_OpenMenu` 0x4EF840** (method table `0x83C1CC`) that reads the
  menu name from VM stack slot 0 without calling anything and, for a hidden menu, returns without
  sending `"%c %i" 't'` — so no client ever opens it; and the engine's own `menuresponse` sequence
  copied from `ClientDisconnect` 0x67C5E8: `Scr_AddString` 0x69A7E0 ×2, `Scr_NotifyNum`
  0x698CC0 with `scr_const.menuresponse` (the word at `0x1F33D92`), guarded like the engine
  (`[0x3882B88]` set, `[0x3882B7C]` clear), from the frame tick. Responses go 600 ms apart
  (UGX re-arms its waittill one server frame after each); if the done notify has not fired 4 s
  after the last one the sequence is resent (idempotent), three rounds at most. Dormant unless `enw_game_mode`
  parses; a half-valid config is refused whole (the map's own menu then shows — the
  safe failure). `is_supported()` = dedicated only.
* **Host** (`lib/gamemode.js`): `gameModeDvars(asg.game_mode)` → ONE dvar, `enw_game_mode`, every piece
  `[A-Za-z0-9_]{1,63}`, ≤ 8 items, answered menu must be hidden, else **none**. The name (and
  `enw_menu_hide/answer/done`) is in `HOST_OWNED_DVARS`, so a party's Custom `settings.dvars` can never set it. It goes on
  Verified and Custom games alike (the mode is the map's content, not a setting). A lease with a
  mode always boots fresh and its instance is never reused warm (`disposition()`), because the
  dvars are on that process's command line. The referee tracks the DLL's `game_mode` events and the
  summary carries `game_mode`, `game_mode_applied`, `game_mode_seen`; not applied → flag
  `game_mode_unconfirmed`, `records_eligible:false`. Replay header carries `game_mode`; the
  games_mp.log gets `ENWZombie;game_mode;<state>;<mode>;<menu>;<response>`.
* **Site**: catalogue `web/server/data/map-modes.json` (generated, §3) read by
  `lib/gameModes.js` (`forMap`, `resolve`, `label`, `leaseSpec`). `parties.game_mode` (NULL =
  the map's default), `POST /api/party/game-mode` (leader, forming, only a mode the map offers),
  `create` keeps a staged pick, a map change resets it. `assignments.game_mode` + the full spec
  in the box payload (rebuilt from the catalogue by id, in the nonce). `games.game_mode` is the
  **lease's** mode; the site independently refuses records unless `game_mode_applied === true`
  and the box's `game_mode` matches. `/api/launcher/play` takes `game_mode` too;
  `lease-cli.js --game-mode <id>`.
* **Records**: a board is now map + version + category + players + profile **+ mode**. The inline
  UNIQUE key cannot change without rebuilding a live table, so a mode's board carries the mode in
  its category key (`round@gungame`, label "Highest round · Gun Game") and in `boards.game_mode`.
  `forMap(key, {gameMode})`, `/api/records?game_mode=`, hub/profile rows carry `game_mode_label`.
  The **map page records tab** gets mode tabs first (map's own order, default first), then the
  existing category chips and player counts. **Best round** (career strip, profile headline) and
  **round milestones** count only a map's default mode — a Gun Game round is not the map's round.
  The map's record badge still goes to the top row of every ENW-Verified board on the map, every
  mode included.
* **UI**: the rail's lobby options get a mode picker (a select under Verified/Custom) whenever
  the staged/party map has ≥ 2 modes; it is the launcher's too (the launcher embeds the site).

**Why ONE dvar (found by the local proof, 2026-09-23 ~17:45).** The first version put four `+set`s
on the line. The harness's server line then had 32 `+` commands, and the engine **silently dropped
the 32nd — `+map`**: no map, the process fell into client init and died on `Exceeded limit of 1
'snddriverglobals' assets` (runs `gm-gungame-2`, `gm-gungame-3`; the control `gm-none-3` with 28
loaded fine). The engine keeps the exe path plus **31 `+` commands** — read, not guessed: `Com_ParseCommandLine` 0x59AFA0 starts at 1 line and stops splitting at `cmp edx, 0x20` (0x59AFC1), dropping the rest of the line; the box's own line is 25
today (B's `m_da684190`), so one more is safe and four would have been too, but a Custom lease
with a few `settings.dvars` could push any box line past 31 and lose `+map` without an error.
**For the host lane:** cap the argv (drop lease dvars, never `+map`) and log it.

**DB migration** (in `migrate()`, additive only, safe on the live DB while it serves):
`parties.game_mode TEXT`, `assignments.game_mode TEXT`, `games.game_mode TEXT`,
`boards.game_mode TEXT NOT NULL DEFAULT ''`. No table rebuilt, no backfill; every existing row
reads as "no mode", i.e. exactly what it was.

## 3. Every map in the archive (`archive/scan_modes.py`, 152 maps, 2026-09-23)

The scanner reads every script the game would run (`.gsc` in `.iwd`s win over fastfile rawfiles,
later `.iwd` names win — Battlestar's `mod.ff` has an old `_zombiemode.gsc` without the vote and B
was shown the vote, which is the proof of that order), looks for `openMenu` + `waittill
("menuresponse")`, and catalogues only mechanisms read by hand. **25 maps** have a UGX mode vote;
49 have some other `menuresponse` script, all read and classified, none a pre-game mode vote.

| Mechanism | Maps | Modes offered (from each map's own `ugxm_user_settings.gsc`) |
|---|---|---|
| `ugx_vote_1` (UGX 1.0.x): hide `ugxm_vote_host` + `ugxm_vote_players`, answer `<mode>`, `start` | battlestar_galactica, dead_palace, futurama, lewl, mr_freeze, nazi_zombie_beachtown, nazi_zombie_depot, nazi_zombie_fivenights, nazi_zombie_forest, nazi_zombie_illuminati_island, nazi_zombie_northco, nazi_zombie_overlook, nazi_zombie_snowglobe, number2, ray_chirstmas_map, thirty_seven (16) | Classic `cl`, Gun Game `gg`, Arcade Mode `ar`, Sharpshooter `ss`, Bounty Hunter `bh` |
| `ugx_vote_11` (UGX 1.1): hide `ugxm_vote_host` + `ugxm_save_settings_client`, answer `<mode>`, `ugx_start` | chal_dual_wield, chal_harambe, chal_pistols, corridor_challenge, salaj_dust2, ugx_artemovsk, ugxm_garage, ugxm_lostwoods, ugxm_pax (9) | the five above + King of the Hill `kh`, Chaos Mode `cm` |

Every one is confirmed to call `start_ugx_mod()` from the `_zombiemode.gsc` the game runs. All
defaults are Classic. Timed gameplay, objectives, mutators and game speed stay at the map's own
defaults (Sharpshooter and Bounty Hunter are 15-minute games by UGX's default).

The other hits, and why none is answered:

| What | Maps | Verdict |
|---|---|---|
| jukebox / music player / bank / door keypad / perk & armour shops / UGX elemental skill tree | many (a_room, cryogenic, dpp, island, kingdom_hearts, nazi_zombie_{arkham, crystallake, decapit3, denial2, dt2, legion, library, malibu, mine, ntc, pd, projectx, rooms, zhunterz}, sammycustomsbox, escape_asylum, the UGX 1.1 maps …) | in game, player-driven |
| `ugxm_customize_char` / `ugxm_character.gsc` | the UGX maps | only in UGX's separate customize-room map |
| UGX 1.1 King of the Hill team picker `ugxm_vote_teams` | UGX 1.1 maps | in-mode, closes itself after 15 s |
| class pick at spawn (`weapon_loadout.gsc`; `choose_class`) | nazi_zombie_tluh; ray_chirstmas_map | **per player**, each player's own choice: left in game |
| mode as a **front-end dvar** (`zomb_gamemode` 0–7; `gamemode` 1 = gun game) | nazi_zombie_fear_mc_2; nazi_zombie_orbit | never an in-game menu; a dedicated server runs the default (0). **Not implemented** — would need a `dvar` mechanism that sets the map's own dvar, which crosses the "a mod's own dvars are never ours to set" trap: B's call |
| `mc_loadscreenorbit` on `players[0]`, waits for **any** response | nazi_zombie_orbit | a blocking "press to start" screen, not a mode vote. **Not implemented**; the same component could hide/answer it with a one-mode entry if B wants |

Re-run: `python archive/scan_modes.py --table` (writes `web/server/data/map-modes.json`, prints
this table). Script text is parsed in memory and never written out.

## 4. Proofs (local, 2026-09-23 17:53–18:31 UK)

Harness `tools/dev/gamemode-proof.ps1` (new): a dedicated server (`waw-d2`) + one invisible client
(`waw-c1`, off-screen, no focus, private LocalAppData, fake SteamID `…0001` with a minted token),
DLL `build\ugx` from this branch (main merged), game link to `authhost.mjs` so every link event is
in a transcript, timed client captures at +4/12/25/45 s in the map that log `keyCatchers`. The
server's extra `+set` is produced by the real pipeline — `gameModes.leaseSpec` → the host's
`gameModeDvars` — never typed. Each run took game.lock through jointest and released it.
Everything is under `ZombiesDev\logs\gamemode\<tag>\` (proof.txt, link.ndjson, captures) and
`ZombiesDev\logs\dedi\<tag>.*`.

| Run | Mode dvar | What the transcript and the DLL say | Client, every capture | Picture |
|---|---|---|---|---|
| `gm-none-3` (control) | none | no `game_mode` events; the vote never completes (no `ugxm_voting_complete` in 60 s) | `keyCatchers 0x10` at 4, 12, 25, 45 s; the client's own start-menu closer tried Esc 3× and the vote stayed | `cap_12s.png`: the UGX vote screen, "Gamemode: Classic … Start Game" |
| `gm-gungame-4` | gungame | `hidden ugxm_vote_host ent 0` 19.69 s → `answered gg` 20.30 → `answered start` 20.91 → `notify voting_complete`, `ugxm_voting_complete` 20.94 → `done` 20.95 | `0x0` at 4, 12, 25, 45 s | `cap_25s.png`: Gun Game HUD, "Points until next gun 1000 · Current Gun 1 out of 32" |
| `gm-sharpshooter-4` | sharpshooter | hidden → `ss` → `start` → done in 1.27 s | `0x0` ×4 | `cap_25s.png`: sniper rifle, "Time until next switch 0:07", 14:37 game clock |
| `gm-classic-4` | classic | hidden → `cl` → `start` → done in 1.28 s | `0x0` ×4 | normal game |

(`0x10` for the first frame of every run, gone within 0.2 s, is the map's own loading menu that
Nacht also has; `pause_menu` logs it the same way on stock maps.)

**The result posts with the mode**: `gm-gungame-4`'s 1,226 real link events fed through the host's
own `Referee` (gameMode `gungame`) give `game_mode_applied: true`, `game_mode_seen {hidden:1,
answered:[gg,start], done:true}`, eligible; ingested by the site's own `results.ingest` on a
scratch DB after a real party → `setGameMode` → `launch` (the box payload carried the full spec):
`games.game_mode = gungame`, `records_eligible 1`, boards `round@gungame` "Highest round · Gun
Game" on all three profiles, `forMap` one Gun Game group. The control's events through the same
path: `game_mode_applied: false`, flag `game_mode_unconfirmed`, not eligible.
(`ZombiesDev\logs\gamemode\result_proof.txt`.)

Tests: web `npm test` all suites 0 failed (new `game-modes` 10/0), host `run-all` 111/0 +
mapcache 22/0 + telemetry 81/0, launcher `run-all` 171/0 (with the ignored client DLL artifact
copied into the worktree), `server/tests/menu_answer_test.cpp` 29/0, `vite build` clean.

Found on the way and fixed here: `tools/dev/launch.ps1` splits GameArgs on commas (so the lists
are '.'-separated), and the 31-command line limit above (so it is one dvar).

## 5. Deploy (nothing of this is deployed; coordinator's call)

Order matters: each layer tolerates the one before it being old, not the one after.

1. **Box DLL** (rule 17: clean detached worktree at the merge commit, `tools\dev\build.ps1 -Name
   dedi`, sha into `dedi.md`, rollback copy, 9 copies, journal idle AND no verified player). An old
   DLL ignores the dvars, the menu shows, and the referee marks the game `game_mode_unconfirmed`.
2. **Host agent** (`infra/host-agent`, restart when idle). An old agent ignores `game_mode`
   (no dvars, menu shows) and reports no `game_mode_applied` → the site refuses the record.
3. **Site** (restart on B's word; the migration runs itself at start; build the client:
   `web/client` `vite build`). Until the site is deployed nothing sends `game_mode` at all and
   everything is as before.
4. **Launcher**: nothing to publish — the picker lives in the site the launcher embeds. The
   launcher's native corner Play plays the party's mode (default Classic).

Prove on the box after 1+2: `node web/tools/lease-cli.js --map battlestar_galactica --player
76561198000000001 --game-mode gungame` (agent lease, fake id), then `ENWZombie;game_mode;done`
in `/home/waw/zdev-host/logs/host/inst-NN.games_mp.log`.

## 6. Unproven

* **The box.** Nothing is deployed; the proof after deploy is in §5.
* **A UGX 1.1 map in game** (ugxm_garage & co.): the mechanism (`ugx_start`, the hidden
  `ugxm_save_settings_client`) is read from its script and menu strings, never run.
* **Two or more players.** The answer goes to whoever is `players[0]` (the first to connect);
  non-hosts' `ugxm_vote_players` is hidden and their votes stay unconfirmed, so only the pick
  counts — read, not run.
* King of the Hill / Chaos Mode / Arcade / Bounty Hunter in game; a whole Gun Game or Sharpshooter
  game to its own end (does UGX's `end_game` read as a normal game over to the referee?).
* The site UI in a browser (the picker and the records mode tabs are built with `vite build` and
  exercised at the API by `web/test/game-modes.js`, not clicked).
* The full host agent process (the Referee and the ingest were run on the real events, the
  agent's spawn/argv path by unit test only).
