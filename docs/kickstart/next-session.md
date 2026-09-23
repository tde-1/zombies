# Next session — start here (2026-09-23)

Written 2026-09-23 ~03:30 UK at the end-of-session handoff (the session ran from 2026-09-22 19:00
to here). If this page and `../../STATUS.md` disagree, STATUS wins. The vault
(`C:\Users\b\Desktop\shared-notes\ENW COD Zombies`) carries the same state as a story in
`19 - Build Log` ("2026-09-23 00:00–03:30") and B's decisions in `00 - Status`. Every lane doc has a
dated section for tonight; read the newest one in your lane before you touch anything.

## What is true now (checked at handoff, do not re-derive)

| | State at 2026-09-23 03:30 UK | Evidence |
|---|---|---|
| **Launcher on the feed** | *(updated 2026-09-23 14:17 UK)* **0.2.27**, client DLL **`04a3ad6d…`** = the box's binary (main **`bde7e19`**: D1 + R1 on top of C1/H1/T1; built clean in `wt-coord2`). `latest.yml` says 0.2.27 | `32deb50`; `launcher.md` release table |
| **Box `zombies-dev`** | *(updated 2026-09-23 14:17 UK)* Box DLL **`04a3ad6d…`** in all 9 `waw-*/binkw32.dll` (clean `wt-coord2` at main **`bde7e19`**, 14:13 UK; proven by Nacht `m_7ce70442`: replay header `replay_events:1`, `snap_hz:20`). Rollbacks `/home/waw/binkw32.rollback-1fda51c5.dll`, `…-974c2e8d.dll`. **Host agent `bde7e19`** deployed 14:14 (whole tree; rollback `/home/waw/host-agent.rollback-20260923T1314Z.tgz`): boot queue + RAM guard (floor 700 MB), telemetry ON (bundles reach `logs/` in the bucket), pull-on-lease map cache, `--after-game terminate`. Site `dcf0ee7`+ live since 13:54 | `dedi.md` §22.10, `host.md` §16, `telemetry.md` |
| **Site `zombies.enw.gg`** | Live on B's PC (node on 3200 + cloudflared), kept up by the **detached keepalive loop + Startup shortcut**. **Proof that works:** B's PC crashed at ~03:16; the Startup shortcut restarted the loop at 03:19:53, the site was up at 03:20:36 and the tunnel at 03:20:36 (`infra\keepalive.log`). That restart put **everything merged through `b85ee4f` live** (client bundle built 03:07). *(Updated 2026-09-23 12:34 UK: site restarted with main **`f8bc2d9`** live; gate answers 401.)* Live DB: 26 Easter-egg guides imported, 6 Movement banners imported, **0 playlists**, zombies-dev `max_instances 3` | `infra\keepalive.log`; `web.md` newest sections |
| **Storage** | One public Hetzner bucket **`enw-zombies`** (nbg1) serves installers (`updates/`) and maps (`mods/`); the site 302s to it. Replay `.glb` geometry is **not** in the bucket (B's call) | `storage.md` §1, §6 |
| **Maps** | 78 listed; 5 five-gate proven with a real client (stock four + fear_mc_2); **59 more "New"** (boot on the box, no client has joined them); 5 of the popular 64 broken and hidden. *(Updated 2026-09-23 13:37 UK, lane A1 asset audit: **5 more hidden** in the live DB — dome_snow, snowglobe, nazi_zombie_test, nazi_zombie_test1, sanatorium — the release lacks a box weapon; fear_mc_2 has verdict `hide` but stays up for Z1/B; 50 live maps have no console log at all → `ZombiesDev\archive\reports\reproof-queue.txt`)* | `dedi.md` §20, `archive.md` §10, **§13** |
| **Cloud bill** | The box €7.19/month + the bucket's base fee (~€5 net). Nothing else | README rule 8 |

## Local proofs 2026-09-23 afternoon (lane P1, 14:02–14:31 UK)

The queued in-game proofs for C1, 17b and lane 12. Every run was on the **shipped 0.2.25 client DLL
`974c2e8d…`** (sha256 `974c2e8d226576568b5be66bae01c148e1bc9de1cab23f2ca90af3a2a0875bfc`), taken out
of `launcher\dist\ENW-Zombies-Launcher-Setup-0.2.25.exe`, because `wt-coord2\build\dedi` was rebuilt
to `1fda51c5` (the D1 merge) at 14:08:56 in the middle of the session. Run p1c1c picked that one up
and is discarded. The feed has since moved to 0.2.27 (`04a3ad6d`); these verdicts are for
`974c2e8d`. Harness: `jointest.ps1` / `lockdown-proof.ps1` from d32ca88, with `nd` as the server and
`nc` as the client. Everything was invisible (`ENW_TEST_NO_ACTIVATE=1`, parked at -4000,-4000,
`ENW_BORDERLESS_COVER=0`) and used the private LocalAppData. Each run took game.lock and released
it. A private site ran on 3399 and authhost on 38795, both ours, both stopped afterwards. Logs are
in `ZombiesDev\logs\dedi\p1*.*`, captures in `ZombiesDev\logs\p1\<tag>\`, and the driver in
`ZombiesDev\logs\p1\`.

| # | Proof | Run | Verdict |
|---|---|---|---|
| 1a | C1 start-paused, fear_mc_2 (`esc-menu.md` §11.6 step 1) | `p1c1a` 14:02–14:03 | **Pass on the criterion; the close path was not exercised.** `pause_menu: the map started under an engine menu (keyCatchers 0x10, 0 ms into the map) … enw_ui stays clear; closing it at 1.5 s`. There are 0 `enw_ui paused` lines and 0 `PAUSED`/`solo_menu` lines on the server. `cap_3s` shows the map playing with no blur. **No `CLOSING the map's start menu` line:** in every harness run the 0x10 was gone by +1 s on its own (`cap_1s … keyCatchers 0x0`), so B's case, where the menu stays up until his Esc, did not reproduce locally |
| 1b | same, `ENW_MAP_START_MENU=keep` | `p1c1b` 14:07–14:08 | Same result. The menu had gone by +1 s even with `keep`, and nothing paused |
| 1c | stock Nacht (step 2) | `p1c1d` 14:13–14:14 | **Pass.** Nacht also starts with 0x10 at the first frame, and it is classified the same way. No close, no pause, nothing on the server |
| 1d | console, Verified, `-ConsoleSelftest 2` (step 3) | `p1c1q` 14:14–14:17 | **Pass.** `shadows off`, `fps: locked in a Verified game`, `fov: 65-120`, `sv_cheats: locked`, `aa 4x -- apply`, `use F, MOUSE4`, `list sh -> 4 row(s)`, and WRITE-THROUGH for sm_enable, cg_fov, r_aaSamples and the bind. Then `'/quit' -> quitting` → `EXIT game` → `POST /api/party/quit -> 200` (the stub saw `match_id m_p1c1q`, `reason esc_menu_exit`) → `disconnect sent` → `quit`. **The client ended on its own** (`quit` 0.4 s after `/quit`; the process was gone at jointest's next 5 s poll). **Finding:** the local Nacht dedi then ran ShutdownGame and re-entered the front end → `Com_Error "Exceeded limit of 1 'snddriverglobals' assets"` → Sys_Error. It parked at 0 Hz, burning ~1 core, until the harness killed it (the `dedi.md` §11.4 restart class, this time triggered by a clean player quit) |
| 2 | 17b compensations, fear_mc_2, 1 kHz synthetic, `PUMP_DRAIN=1` vs `=0` | `p1m17d1` 14:24–14:26, `p1m17d0` 14:26–14:28 | **Partial, not a controlled A/B.** B was using his mouse, and `rawprobe inject` aborted in both arms (after 285 and 16,332 moves). The INPUTSINK game saw B's real mouse. **Proven:** the `compensations --` line runs in game every ~3.6 s. The drain works: DRAIN=1 logged `pump drains 1885 carrying 163 reports` and `wheel raw 31`, while DRAIN=0 logged `pump drains 0`. Every fault counter was 0 in both arms (impossible, bad blocks, disagreements, transient, hard failures, repairs, foreign, absolute). `clip re-applied`, `edge recentres` and `menu recentres` were all 0, which is not meaningful here: the harness window is never focused, so it never clips. **Frame p99 was 6.25 ms at ~249 fps in every steady 10 s window in both arms.** DRAIN=0 had two windows at 6.50/6.75 ms and 8 frames over 16.7 ms; DRAIN=1 had none after the load window. That is weak evidence that the drain costs nothing |
| 3 | V0 `r_multiGpu 0` vs `1` picture | — | **Skipped** (coordinator: wrap up) |
| 4 | Lane-12 record line + end screen (l12c pattern) | `p1l4` 14:28–14:31 | **Pass.** `3 backlog line(s) (history=1)`. game_over → authhost `RESULT … HTTP 200 {"ok":true,"notified":1} (30 ms after game_over)` → client `system line: Your record has been uploaded.` (14:30:45.860). Our server was ended at +130 s → `the server has sent nothing for 20000 ms` → end screen *Lost the connection to the server. / Your record has been uploaded. / Back to the launcher in 3* (`p1\p1l4\enwshot-143131-lockdown-screen.png`) → `quit`, 1001 covered frames. **The client ended on its own** and jointest released the lock. (The HUD captures at +92…113 s show the ENW console still open from selftest 1, so the HUD line's evidence is the log line) |

Still not proven after P1: the start-menu **close** (it needs a menu that stays up; B's next box game
on fear_mc_2 answers it with `CLOSING the map's start menu (try 1`), 17b under a controlled 1 kHz
synthetic (it needs the desktop idle for ~2 min), 17b's clip/recentre counters (they need a focused
window, i.e. B's own session), and chat-overlay §13.6's chat line and ALLOWED decision (not run).

## What shipped tonight (2026-09-22 19:00 → 2026-09-23 03:30), one row per thing

| UK time | What | Where it is written |
|---|---|---|
| 19:07 | Keepalive detached + Startup shortcut (the site had died with an agent shell); **launcher 0.2.7** (reload reconnects the site API) | STATUS "the site went down with its shell" |
| 19:30 | `no_msgbox` on the box ("Set Optimal Settings?" auto-answered No) | `dedi.md` §17 |
| 19:36 | **0.2.8**: a join waits for a safe menu; the map's load video is refused | `client.md` §7 |
| 19:46 | **0.2.9**: frameless launcher, the site's nav is the title bar | `launcher.md` 0.2.9 |
| 19:50 | Replay parity pass (Play/First person, zombies in the track, props upright, crosshair, grenades) | `replay.md` §8.10 |
| 20:24 | **0.2.10**: nav clicks land; in-game name = ENW name. Site: **Steam-only sign-in + ENW username gate**; Movement's left rail | `launcher.md` 0.2.10; `web.md` §13 |
| 20:27–21:00 | **Dedicated-server pause** (world frozen, clocks held); proven on the box | `dedi.md` §18, `referee.md` §15 |
| 20:33 / 21:28 | `/settings` = WaW's Options menus mapped to dvars, then in Gaff's layout | `client.md` §8, `web.md` |
| 21:10 | Replay WaW HUD + position accuracy; box DLL `86f12b12` | `replay.md` §8.11, `dedi.md` §18.5 |
| 21:17 | **0.2.11**: in-game chat overlay (engine-drawn WaW chat, tabs, DMs, pause contract) | `chat-overlay.md` §9 |
| 21:26–21:38 | Movement profile with banner; card → map page, Not playable tags, Steam avatars; **0.2.12** update chip, Download, installed maps | `web.md`, `launcher.md` 0.2.12 |
| 22:34 | A picture for every map (1,449 covers / 19 own loadscreens / 880 cards / 0 stock) | `web.md`, `archive.md` §10 |
| 23:05 | **One bucket `enw-zombies`**, 26.5 GB synced, downloads 302 there (~47 MB/s) | `storage.md` §6 |
| 23:52 | **0.2.13**: chat overlay round 2 (clicks land, text box, clipboard, DM tabs) | `chat-overlay.md` §10 |
| 00:48 | Three game servers per box (`lobby_port.cpp`, box `6fccc0e0`), copies by slot (fixed the inst-05 outage) | `dedi.md` §19 |
| 00:58 | Popular 64 on the box: 59 pass, 5 broken; 59 offered as **New** | `dedi.md` §20 |
| 01:09 | **0.2.14**: Esc pauses on a box; client clock held while frozen | `chat-overlay.md` §11 |
| 01:11–01:20 | **Several games per box** (leases by party, 1 slot reserved for agents, launcher cancel can't end a live game, quit vs crash, Resume 10 min). **Pause OFF on the box** after two paused games died of the script-VM localVars overflow; guarded DLL + write probe | `web.md`, `host.md` §13, `dedi.md` §18.6, `referee.md` §15.4 |
| 01:13 / 01:26 | **0.2.15** relaunch loop gone (follow gate); **0.2.16** nav clickable straight after a game | `launcher.md` 2026-09-23 |
| 01:16 / 01:18 | Replay world 2.54× too big fixed, Tab scoreboard; **Easter egg guides** (26 on 20 maps, blurred) | `replay.md` §8.12; `web.md`, `archive.md` §11 |
| 01:29–01:45 | Direct boot (no Online Service popup, no main menu); **ENW Esc menu** (Resume / Restart / Exit, chat, friends + invites) + `restart_request` + host `restart.js` (box `c0986e5e`); mod-compat (pre-launch file check, mod-owned dvars, loose files - synced to the bucket 02:58 by `sync.js --only maps`); **0.2.17** (DLL `d26831d2`) | `client.md` §10, `esc-menu.md`, `mod-compat.md` |
| 02:15 | Overlay + Esc menu always in WaW's stock font; **0.2.18** (DLL `1b103258`); `mapmount.ps1` private LocalAppData by default | `chat-overlay.md` §12 |
| 02:25 | Host reports `ready` at `map_loaded` | `dedi.md` §21.3 |
| 02:45 | **0.2.19**: hang watchdog (stack + minidump after 8 s), stock-font search on a worker (DLL `f11dc67c`) | `chat-overlay.md` §12.4 |
| 03:03 | **Join gate fixed in three layers** (dedi gate open from registration, client retries "not ready" for 60 s, host ready at map_loaded); box `03b04bc3`; **0.2.20** (DLL `03b04bc3`) | `dedi.md` §21, `client.md` §11 |
| 03:07 | `/maps` opens on Movement's mode-home cards with a saved Cards \| List switch | `web.md` 2026-09-23 ~03:00 |
| 03:26 | **fear_mc_2 lag = stock `sv_maxRate` 7000**; `net_probe` raises it to 25000 (20 snapshots/s, 0 fragments over the internet); box **`6b1ccfc5`** | `dedi.md` §22 |

**Lane 12, 2026-09-23 12:30 (branch `worktree-agent-a3c4fdfc2d163a895`, not merged, not shipped):**
no stock main menu (an end screen covers it from the first frame, says why, repeats the site's
notice, quits to the launcher; also after 20 s of server silence, because a killed server is never
timed out by this engine), the stock console locked (scan code 0x29 + keyCatchers catcher) and the
ENW console in its place (catalogue settings only, same rules as Esc > Settings), **cg_fov was
cheat-protected in box games — the Settings tab's FOV row never worked there; now unlocked and
capped at 120**, "Your record has been uploaded." (site `gameChat.notify` at ingest → the overlay's
feed), chat window starts with the backlog (`history=1`). `esc-menu.md` §10, `chat-overlay.md` §14.
Open-bug 16's `monkeytoy 1` point is moot for players now: nobody reaches the stock console either way.

**Lane H1, 2026-09-23 ~14:30 UK (branch `worktree-agent-a05a09733de8153ac`, main `996dbc2` merged in, NOT deployed):**
the host agent's boot queue, RAM guard, players-first rule and warm handoff, after three incidents on the box between 12:12 and 12:21 UTC.
The incidents were: queued boots whose leases had been retired started anyway as orphans, and took the box to 4 MB free; a warm handoff posted a round-0 result that ended B's lease; and B's still-connected client was refused `wrong_match`.
What changed:

- A retired lease cancels its queued boot.
- A `hello` from one of our own orphaned instances kills it by our pid, and is logged as an incident.
- A player's boot goes ahead of every agent boot, and retires an agent game that is still booting (`yielded`).
- MemAvailable is checked against a 700 MB floor: agent boots wait, and a player's boot evicts warm instances, then agent games. The figure is in the heartbeat and on Admin → Boxes.
- A warm instance must take a lease within 5 s, or it is torn down and the lease boots fresh with no result posted.
- The returning player is re-admitted as `returning`.
- `--after-game terminate` is the default.
- The launcher's boot screen shows `queued` ("another game first; yours is next").

Tests: host run-all 103/0, `test/boot-queue.js` PASS, web green, launcher 170/1 (environmental).
Deploy steps: `host.md` §16.5. Proving warm reuse on the box before it goes back on: §16.7.
**Trap found:** `infra/host-agent/test/integration-site.js` defaulted to B's live site on :3200. Run bare, it pinned a replay key on the live `box-a` row (§16.8). It now refuses to run without `--site`.

## Open bugs and unproven things (one line each, with the pointer)

1. ~~**Stretched Reapers Colt viewmodel on fear_mc_2**: not reproduced locally with identical files; the box server and B's session not ruled out. `mod-compat.md` §1, §9.~~ **→ Closed 2026-09-23 13:35: `r_multiGpu 1`** (the launcher's old baseline) breaks skinned models on a single GPU; B's toggle fixed it. `r_multiGpu` is 0 for everyone, the old 1 repaired once (launcher + site). `mod-compat.md` §10.4, `launcher.md` "r_multiGpu is 0 for everyone". Ships with the next launcher; the site half on its next restart.
2. ~~**B's client writes no `console.log` since 2026-09-22 18:07**~~ *(2026-09-23 ~04:00: wrong premise - it is written per map and truncated per launch; the DLL now keeps `logs\console-<pid>.log`, `client.md` "2026-09-23 ~04:00". Chat-Enter crash = Discord hook, `chat-overlay.md` §13. Revised ~12:00: the hook is no longer refused outright; "Discord overlay" Auto/On/Off on /settings -> ENW, `ENW_DISCORD_HOOK=auto|allow|refuse`, auto lets it in only while a 50 MB block is free (§13.6). Needs a launcher publish to reach B.)* despite `+set logfile 2`, so B's reports have no engine evidence. `mod-compat.md` §1, `client.md` "2026-09-23 01:45".
3. **zm_nuked hang (0.2.18)**: not reproduced on the box; the 0.2.19+ hang watchdog writes `hang-<pid>-<time>.dmp` + stack on the next one. `chat-overlay.md` §12.4.
4. **fear_mc_2 network lag**: server side fixed and measured on the box (`dedi.md` §22.3). The launcher baseline ALREADY passes `rate 25000`, `snaps 30`, `cl_maxpackets 100` (`launcher/src/main/gamecfg.js` lines ~125-135; §22.4's "not done" was wrong) - nothing to ship. Client `net_probe_client.cpp` is in main but in no published launcher DLL (diagnostic only); a real Play with several players is unmeasured.
5. **Pause is off on the box** (`ENW_NO_PAUSE=1`): the script VM's localVars copy at 0x697B97 overran into 0x3BFD478 after pauses; whether pausing provokes it is unknown. The write probe is armed to name it. `dedi.md` §18.6, `referee.md` §15.4. **2026-09-23 (lane D1): pausing is NOT the cause** - B's unpaused fear_mc_2 game froze the same way at 12:33 UTC; see 19.
6. **Replay geometry**: Nacht's window walls from the Husky shell are missing (shots pass through); Der Riese has props only, the shell needs a Husky export under `game.lock`. `replay.md` §8.8, §8.11.
7. **Kills / downs / revives / score are not recorded** by the referee from a real game (every real game says 0); the Tab scoreboard and the profile hide or dash them. `replay.md` §8.12, `web.md` profile section. **→ Fixed in branch `worktree-agent-a2de719d7061c17aa` (2026-09-23 ~05:00; `referee.md` §16, `host.md` §14):** the counters are native gclient fields and the DLL now reads them. Live on the box only after the §16 box DLL deploy and a host-agent restart; a real kill/revive is still unproven.
8. **Easter egg guides**: 26 on 20 maps; whether the steps are right and how many were missed (crawl coverage / recall) is unknown. `archive.md` §11.
9. **Playlists**: none published in the live DB, so `/maps` cards view is only Popular + View all maps. `web.md` 2026-09-23 ~03:00.
10. **Chat overlay / Esc menu in exclusive fullscreen**: never looked at. `chat-overlay.md` §9.8, `esc-menu.md` §8.
11. **Co-op pause and typing with two real players**: unit tests and a single client only. `chat-overlay.md` §8, §11; `esc-menu.md` §8.
12. **Four instances on the box**: needs ~300 MB more RAM (Steam's browser holds ~2.3 GB) — Steam without its browser or a bigger box (rule 8). `dedi.md` §19.5.
13. **Vault git**: the vault is its own repo (`tde-1/shared-notes`); Obsidian's auto-backup commits and pushes it (last seen 03:07, level with origin). Agents never commit it by hand; check that the handoff edits were picked up by the next auto-backup.
14. **Web test timing flake**: "test server never came up on 33991" under load; passes alone. Make the wait robust.
15. **Launcher volume setting does nothing**: it writes `snd_volume`, which is not a dvar in this exe; the real one is `snd_menu_master`. `client.md` §10, `launcher/src/main/gamecfg.js`.
16. **B's real WaW profile was written by the harness twice tonight** (`launch.ps1` 01:25, `mapmount.ps1` junction into his mods folder). Both now default to the private LocalAppData (`340ea09`, `e1797e8`); `monkeytoy 1` (a map's anti-cheat) was also saved into B's account settings, so **his console is off on every map until he changes it back** in Settings. `mod-compat.md` §3.
17. Also unproven from tonight, lower: the Esc menu by B's own hand and on the box through the site (`esc-menu.md` §8); the 59 New maps with a client (19 have ≥110 MB zones; `dedi.md` §20.4); a real launcher Play against the join fix on the box (`client.md` §11b); the pre-launch mod file check through a signed-in launcher (`mod-compat.md` §9); grenade classname `grenade` on T4 (`replay.md` §8.6); four players in one game; round 2.
18. **→ Closed 2026-09-23 13:35, cause `r_multiGpu 1`** (B: dual video cards OFF fixed the zombies and most of the mouse stutter; `mod-compat.md` §10.4, same fix as bug 1; the §10.3 A/B is no longer needed for this). Original entry: ~~**fear_mc_2 zombies invisible (AA4/spec/glow on) or garbled (off)** (B, 0.2.24, 12:49 and 13:15–13:21 UK): broken skinning on the client; B always had AA4/spec/glow on (the "settings changed at 01:45" theory in `mod-compat.md` §10 is withdrawn, §10.1). Not new in the DLL on the evidence: the 00:53 stretched Colt was the same class of bug; `r_multiGpu 1` has been pinned by the launcher since 09-22 04:13. Ruled out: map files, asset errors, write-through, DLL writes into entities, model-set mismatch. Local A/B ready: `tools/dev/z1-ab.ps1` (§10.3) — V0 must reproduce first. B's toggles (r_multiGpu, Discord overlay Off) are the fastest answer.~~
19. **Asset audit (lane A1, 2026-09-23 13:40 UK, branch `worktree-agent-a4ffc5dfe41c8266c`)**: every logged `Could not load` on 157 hosted maps classified (`archive/asset_audit.py`, `archive.md` §13). Ours: two serve-filter drops — loose `.wav/.mp3` (203 files, 6 maps) and Neon Fighter's `HarryBos Mysterybox Pack V1..0.0.iwd` (`includes('..')`) — fixed in `mapfiles.js`, in the bucket; **live only after merge + site restart on B's word**, then `box_stage.py --map neon_fighter --add-missing` (queue step 0). Dedi lane: the dedicated server never loads `<bsp>_load.ff` (ray_chirstmas_map's zombies live only there). Everything else visible is the release's own; 5 hidden, gate in `asset_gate.py` / `precheck.py --gate` / `popular.py --apply` / `lib/assetgate.js`. Open: the 50 unproven live maps (re-proof queue), the client-check list (`archive.md` §13.6 recipe), a launcher publish for `.wav/.mp3`.

19. **Lane C1 (2026-09-23 ~14:30, branch `worktree-agent-afa2e08ce5b4d56e3`, not shipped)**: B's
    13:20 asks. (a) **A game started PAUSED under the map's blurred menu** — root cause in B's logs:
    fear_mc_2's own start menu holds keyCatchers 0x10 from the load and the overlay's pause rule
    read any 0x10 after 2 s in a map as the Esc menu → `enw_ui paused` at exactly +2.0 s → the
    server froze the game. Fixed (`lockdown::start_menu`: never a pause, closed 1.5 s in, box games;
    `ENW_MAP_START_MENU=keep`). (b) The ENW console: `/quit` (slash optional), `disconnect`,
    `restart`, `apply`, `bind`/`unbind`/`binds`, `help <name>`, `list`, every setting by short name
    and aliases, Tab completion, terse replies. (c) Every setting in every game, Verified included;
    only max fps is locked there; Discord switches in game (needs a launcher release for the
    read-back). Unit tests only (`lockdown_test` 196/0, `settings_model_test` 65/0); **the in-game
    proof recipe is `esc-menu.md` §11.6** and needs the lock with B away. `esc-menu.md` §11.
    **→ P1 ran it 2026-09-23 14:02–14:17 on `974c2e8d`** ("Local proofs 2026-09-23 afternoon"
    above): no paused start and the console `/quit` both pass; the close itself was not exercised,
    because the harness's menu is gone by +1 s.
19. **Host boot queue, RAM guard, warm handoff (lane H1)**: proven in the sim only (`test/boot-queue.js`), not on the box. Warm reuse (`--after-game end`) stays off until two consecutive agent games pass on the box. The 700 MB floor is a guess from the 12:13 incident. `host.md` §16.6–16.7.
20. **Dedicated-server freeze (B's fear_mc_2, 2026-09-23 12:33 UTC, round 4)**: one frame escaped through an access violation (the engine's abortframe swallows it), which left the script VM half-executed; ~5 s later `Scr_AddLocalVars` (0x697B60) pushed 33,075 names into the 2,048-slot `localVars` stack, overwrote `[0x3BFD478]`, and every frame after faulted at 0x5FFE23. Not our hooks, not pause, not the §16 NOP. **Which AV escaped first is unknown** - the new `freeze_watchdog.cpp` logs it next time (fault eip + callers + VM state per escaped frame). The watchdog also ends a frozen match through the host (`game_over` reason/flag `server_freeze`, `match_end server_alive:false`); proven locally, **not on the box** (needs the box DLL and a host-agent restart for the flag). Branch `worktree-agent-a05beaee45682f85d`. `dedi.md` §23.

21. **Replay FX (lane R3, 2026-09-23 ~15:30 UK, branch `worktree-agent-aef74e453358c99cc`, main merged, not deployed)**: the web replay now draws R2's weapons in the hands (gold PaP models), muzzle flashes, the game's hit marker and hurt vignette, the crosshair in third person too, power-up models with timed chips in tenths, and plays R2's sounds (off until Play; M mutes). It is built on R1's v1 events and asks for the track at 20 Hz. Proven on a signed fixture plus R2's real pack on a scratch site (render check 27/27, `replay-fx` 16/16). Old replays play silent with nothing new. **Unproven until a v1 game with a player in it exists.** R1's DLL `04a3ad6d` has been on the box since 14:13; its only file is the agent lease `m_7ce70442`, with no player. Also unproven until someone listens on real speakers. Live on merge plus a site restart on B's word. `replay.md` §12.

22. **Discord said "Call of Duty: World at War" (lane DP1, 2026-09-23 ~15:00 UK, branch `worktree-agent-aca6998f056dbe7df`, not published)**: Discord detects `codwaw.exe` by file name in any folder (B's launcher games 13:28 and 14:42, and every harness copy, showed as World at War) and keeps the detected game beside our IPC activity; ours is listed first, resending or `pid` hide nothing (Discord's `LocalActivityStore`). Fix: the launcher starts `ENWZombies.exe`, a byte copy of our own `CoDWaW.exe` (`gameexe.js`); watched on B's PC: no detection, only *ENW Zombies*. Needs a launcher publish; opt-out `ENW_GAME_EXE=CoDWaW.exe`. Unproven: a real Play with ENW's own Discord app id (B has not made the app, checklist in `launcher.md` "Discord rich presence"), whether Discord's overlay stays out of `ENWZombies.exe`, one firewall prompt per player on the first Play. Mock-ups for B: vault `assets/discord-mockups/` (01–09), live crops 10–12. `launcher.md` "Discord shows ENW Zombies".

23. **Lane S1 (2026-09-23 ~15:00 UK, branch `worktree-agent-a00a3348f40438924`, main merged): the dedi freeze of item 20 is FOUND and FIXED, not deployed.** B's fear_mc_2 froze again at 13:43 UTC (1 m 18 s, `m_68e3fe9e`); the box watchdog ended it (`server_freeze`, telemetry `a2c82e5d`) and named the first fault: `eip=0x4F057E` in `PlayerCmd_playLocalSound`, reading `snd_errorOnMissing` (`[0x3BE65DC]`), which only SND_Init registers, so it is NULL on a headless server. Stock `showNotifyMessage` plays the MP alias `mp_level_up` on every rank-up → alias missing → NULL deref → abortframe mid-builtin → VM overrun (§23). Fix `snd_alias_dvars.cpp` registers `snd_errorOnMissing` + `snd_reportSndAliasErrors` with the engine's own `Dvar_RegisterBool` (default 0, as a client). Test 64/0 against the dump. **DLL `6b838bdb…` for the coordinator to deploy** (`ZombiesDev\logs\dedi\s1\enw_t4-6b838bdb.dll`). Proof on the box after deploy: DLL log `dedi_snd_alias_dvars: … registered`, the alias line and `self-test … no exception`; then a real game past its first rank-up. Soak: `boxsoak.ps1`'s player is a client on B's PC, so the S1 soaks are server-only holds (no player, no rank-ups). `dedi.md` §25.

24. **Replay spectator switching (lane R4, 2026-09-23 ~16:30 UK, branch `worktree-agent-a78d984e64a050426`, merged to main by lane INT)**: in a co-op replay the right-hand panel is a spectator list. Click or tap a row to follow that player; 1–4 pick, Q/E or [ ] cycle (alive first), F toggles first/third person, Esc goes to free cam. The panel says "Following <name> · <view> · <weapon>" or "Free cam", and the HUD (crosshair, hit marker, blood, first-person gun) is the followed player's. When he goes down the camera stays on him, with a DOWN marker and "Watch <next alive> (E)"; a player counts as up only if his snapshot says alive AND no `down` event is open (`downSpans`, finished by INT from R4's uncommitted edit). Solo replays keep 1/2/3. **Digits changed meaning in co-op**, so R3's render check now clicks the camera rail. Proven with `replay-spectate` 13/13 in `npm test` and on a scratch site (`r4-render-check` 31/31, 4-player fixture `m_f0f0f0f2` plus solo `m_f0f0f0f3`). **No real co-op replay exists yet**: B's next 2+ player box game is the proof. R4's `replay.md` §13 was never written (B's PC rebooted at 15:30); this item is the record.

25. **Lane INT (2026-09-23 ~16:40–17:15 UK): the freeze fix is ON THE BOX, launcher 0.2.28 is out, the site is live with R4 + discord.env.** B's 14:00–14:27 UTC freezes (lorkeep, ils, ut_box_map) were `eip=0x51BC60` = `playSound` reading the same NULL `snd_errorOnMissing` as item 23. Box DLL **`fd3039d2`** (all 9 copies, 16:00 UTC): S1's registration + two more client-only dvars that server code reads unguarded, found by a static scan and confirmed NULL at runtime (`r_watersim_debug`: a bullet into water; `fx_enable`, registered at 0) + F1's rate scale x4 (ils lag, unproven with a player) + fault names. Proven by agent leases ≥3 min, 0 escape faults: ut_box_map 286 s, ils 186 s and 196 s, lorkeep 193 s. Launcher **0.2.28** = same DLL + DP1's `ENWZombies.exe`. Discord: `infra/discord.env` (B's file) is read by node at start; B still has to upload the `enw` art asset. Unproven: a real player past a rank-up; a bullet in water; ils lag with an internet client. `dedi.md` §26.

26. **Lane G2 (2026-09-23 ~17:00–19:30 UK, branch `worktree-agent-aac675948eb19e877`, main merged, NOT deployed): B's "one-hit downs" are a phantom water surface at z=0 on the dedicated server.** The server's water height comes from the renderer's water-sim window, which a dedi allocates (`watersim_pool.cpp`) but never fills, so every map whose floor is below 0 is under water on the server: zm_nuked (floor ~-390) drowned B at spawn (100→75→39→down in 150 ms, attacker none), nacht_reimagined (-87.6) had him swimming 35 units above the floor ("floating, missing inputs"). Fix `water_sim_off.cpp`: `r_gfxopt_water_simulation 0` on every dedi (the engine's static-grid path). Proven locally: nacht_reimagined spawns 100/100 and stands on -87.6 like a solo listen game. bridge_zombie/battlestar downs were stock (two 60-hits inside the 2.4 s regen). New every-map self-check `solo_parity.cpp` → `solo_parity: MISMATCH` → telemetry flag `solo_parity` (P2). **Open:** zm_nuked still spawns stuck at its first spawn struct (dies at +45 s) — flagged, cause unknown; ils not run with the fix. `dedi.md` §27.

## Decisions only B can make (`questions.md`, "Open at handoff")

0. **Discord card design (DP1)**: today's card (map large, ENW small, "Round 12 (3 of 4)"), alternative A (member list says the map, "Round 12 · 3 of 4 alive") or B (ENW large, map small). Also: a square 512 px map card for Discord, since the wide cards crop through their titles. Vault `assets/discord-mockups/`.

1. **Q-ip-1** — the name: keep ENW Zombies (recommended) or change before public. `ip-posture.md` §3.
2. **Q-ip-2** — what ends closed testing, and the legal contact / US DMCA agent (small fee). `ip-posture.md` §9.
3. **Q-id-1** — one ENW name store shared with drops.ws (needs a scoped secret) or mirrored rules (today). `web.md` §13.
4. **Replay `.glb` public?** — may game-derived map geometry go in the public bucket (`storage.md` §1), and should `/mapdata` go back behind the gate (Q-replay-2 note).
5. **Profile "Overall" list** — which stats that block shows (today: games, rounds, best round, time, records, member since). `web.md` profile section.
6. **Quaternius "Ultimate Guns" (CC0)** as the replay's gun model instead of the procedural placeholder; needs B's OK to download. `replay.md` §8.7.
7. **Four instances** — Steam without its browser (risks B's box login) or a bigger box (money, rule 8). `dedi.md` §19.5.
8. **Pause back on the box** — only once the write probe names the localVars writer (or B accepts the risk). `dedi.md` §18.6.

Older and still open: aim assist on Verified boards; solo-on-a-dedi follows co-op rules (a records decision); LICENSE files.

## B's own next steps (nothing here needs an agent)

1. Update to **0.2.27** (the chip top right, or restart the launcher). *(2026-09-23 14:17 UK; 0.2.25's notes below still hold)* On its first launch it repairs the Discord overlay and dual-video-card (`r_multiGpu`) settings by itself. In the game's console, `/quit` and `fov 90` now work (Tab completes), and a map no longer starts paused under its start menu.
1a. Mouse: the three one-minute runs at 1000 Hz from `client.md` §1f ("What B tests"): run 1 `ENW_FRAMETIME=1`, run 2 `ENW_FRAMETIME=1 ENW_RAW_MOUSE_WOW64FIX=0`, run 3 `ENW_FRAMETIME=1 ENW_RAW_MOUSE_BUFFER=0`; turn steadily and flick; send the three `%LOCALAPPDATA%\ENWZombies\logs\enw-<pid>.log` files and which run felt best.
2. Settings → turn the console back on (a map saved `monkeytoy 1` into your account).
3. Play fear_mc_2 on the box again: it should no longer lag. If it does, the box log now says why.
3a. fear_mc_2 broken zombies (open bug 18): in the game, Esc → Settings → Graphics → dual video cards **off → Apply** → look. Then, in a new game, site /settings → ENW → Discord overlay **Off** → look. Tell us which one fixed them (or neither). `mod-compat.md` §10.3.
4. If a game freezes, send `%LOCALAPPDATA%\ENWZombies\logs\hang-*.dmp` and the `enw-<pid>.log` beside it.

## How to run things

```powershell
# builds (never from a tree with untracked files: CMake globs every .cpp in a component folder)
tools\dev\build.ps1 -Name dedi ; tools\dev\deploy.ps1 d2 -From dedi
tools\dev\jointest-proof.ps1 -Tag joinNN -Watch 300                 # five gates, local
tools\dev\jointest.ps1 ... -ClientEarlyMs <ms> | -ServerLagMs <ms>   # join-race harness (dedi.md §21.4)
cd launcher; node test/run-all.js; node test/waw-settings.js; node test/modcompat.js
cd web; npm test                                                     # 33991 flake: rerun alone
cd infra\host-agent; node test/run-all.js
node web/tools/lease-cli.js --map nazi_zombie_prototype --player 76561198000000001   # AGENT lease (reserved slot)
node web/tools/lease-cli.js --match <id> --cancel
ssh zombies-dev 'systemctl status enw-host-agent; journalctl -u enw-host-agent -n 50'
Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | ? CommandLine -match 'keepalive.ps1'   # is the site loop alive?
```

**Publish a launcher (every release, in this order):** build the client DLL from a clean tree →
`node tools/stage-client.js --from build/<lane>/enw_t4.dll` (explicit, never "whatever is newest") →
bump `launcher/package.json` → `node test/run-all.js` (read the whole output, not `npm test`'s last
line) → `electron-builder --win --publish never` → `node tools/publish-update.js` (copies to
`web/public/updates` and uploads installer, blockmap, then `latest.yml` to the bucket) → check
`https://zombies.enw.gg/updates/latest.yml` → `git commit --only launcher/package.json` with the DLL
sha in the message → a dated line in `launcher.md`'s release table. The version test is a floor.

**Deploy a box DLL:** `git worktree add C:\Users\b\ZombiesDev\wt-<name> <main sha>` (detached, **clean:
`git status` must be empty**) → `tools\dev\build.ps1 -Name dedi` there → `sha256` → `scp` to
`zombies-dev:/tmp` → on the box, only when the journal is idle **and** no verified player is in a live
instance: copy the current DLL to `/home/waw/binkw32.rollback-<old8>.dll`, then for each of the 9
`/home/waw/pfx/drive_c/zdev/waw-*/binkw32.dll` copy to a temp name and `mv` over (atomic), `chown
waw:waw` → prove with a fake-ID agent lease (`map_loaded`, the component's log line) → cancel → write
the sha, source commit, worktree and rollback into the newest `dedi.md` section and STATUS. A running
game keeps its old DLL; new boots take the new one.

**Merge an agent worktree:** docs conflicts = keep both sides; code conflicts = the lane that owns the
file wins; run web `npm test`, host `test/run-all.js` and launcher `test/run-all.js` after every merge;
a site restart is B's word while he plays.

## Agent rules added tonight (README "Hard rules" 11–18 has the wording)

- **Test windows are invisible**: `ENW_TEST_NO_ACTIVATE=1`, off-screen (-4000,-4000), `ENW_BORDERLESS_COVER=0`, never exclusive fullscreen or desktop-sized while B is at his PC.
- **The harness uses a private LocalAppData by default** (`launch.ps1` since `340ea09`, `mapmount.ps1` since `e1797e8`); `ENW_USE_PRIVATE_LOCALAPPDATA=0` is the opt-out for a deliberately stock run, and a fresh private tree needs `players\profiles` seeded. B's `Activision\CoDWaW` is never written.
- **"Journal idle" is not a safe signal alone**: also confirm no verified player is in a live instance before a box restart, deploy or lease.
- **Agent leases use the reserved slot** (`lease-cli` is an agent lease unless `--real`), with fake IDs `76561198000000001/2/3` (one ID per concurrent game; the same ID is the same party and supersedes). Never B's SteamID.
- **The site restarts only on B's word while he plays.** The keepalive loop reads `infra\site.env` once at its own start: an env change needs the detached loop restarted (WMI), not just node.
- **Publish recipe** above, every time.
- **Never build a box DLL from a worktree with untracked files** (`f920bb39` shipped another lane's uncommitted `net_probe` that way).

## Traps that are still traps

Never `+set developer 1`; `+set logfile` changes behaviour (script VM developer mode — keep
`script_error_retail`); never `ENW_PRIVATE_PROFILE`; always pass `com_maxfps`; clear `__CoDWaW`
before a deploy; `CS_CLIENTLOADING`, never `CS_PRIMED`; a status reply is not simulation (read
`com_frameTime`); **127.0.0.1 is LAN and skips the server's rate code** — use `ENW_NET_FORCE_WAN=1`
to test internet pacing; `SendInput` at 8 kHz is discarded; agents' writes under `%LOCALAPPDATA%` may
be sandbox-redirected; the shared git index (`git commit --only <paths>`); `-Maps` must be a real
array; a mod's own dvars (`monkeytoy`, `con_external`, `sv_cheats`) are never ours to set.

---

# Previous page (2026-09-22 evening), kept as written


Rewritten 2026-09-22 (evening) by the coordinator. If this page and `../../STATUS.md` disagree,
STATUS wins. The vault (`C:\Users\b\Desktop\shared-notes\ENW COD Zombies`, note `19 - Build Log`)
carries the same state in story form; `00 - Status` has every decision B has made.

## What is true now (do not re-derive any of it)

- **The dedicated server survives players and runs to game over.** Three fixes: a 128 KB temp-memory
  leak per client message (`temp_stack_guard.cpp`), an every-frame access violation in the water
  simulation whose buffers only the renderer allocates (`watersim_pool.cpp` — this one hid behind
  `getstatus` still answering, hence gate 5), and a save-reload at game over (`no_save_reload.cpp`).
  `dedi.md` §12–14. Proof = `jointest-proof.ps1`, five gates, 300 s.
- **The Hetzner box `zombies-dev` hosts real games** from B's English game copy (`/home/waw/waw-en`)
  under Wine 11; `enw-host-agent` systemd, `--wine`, box #3 on the site, **2 instances**, 0.30 core /
  301 MB each. The account is German-region (low-violence depot only); SteamStub checks app ownership,
  so B's files decrypt. A real player from B's PC played there to game over; replay `m_5de3842b`, site
  game id 2. `vps.md`.
- **Identity = the site's signed invite token**, parsed at connect (`referee.cpp::parse_token`),
  verified by the host (`TokenGuard`); forged → `clientkick` in 27 ms; `identity: none|claimed|
  verified|refused`, only `verified` creates a `game_players` row. Bug fixed on the box tonight:
  `host.js` read `requireToken` from the `--site` argument, not `cfg.site`, so an env-configured box
  was advisory-only. `referee.md` §13, `host.md` §12.
- **Client**: raw-input mouse (iw4x port; WaW has no DirectInput), borderless, frametime probe,
  config round trip, **isolation** (`enw_localappdata.cpp` redirects LocalAppData to
  `%LOCALAPPDATA%\ENWZombies\home\localappdata`; B's own `Activision\CoDWaW` is never touched).
  Stutter is mouse-bound; the no-legacy mode awaits B's three runs. `client.md` §1e. **LAA is
  impossible on the Steam exe** (SteamStub refuses; `launcher.md`, vault R14).
- **Launcher 0.2.2** on the feed (`web/public/updates`, `/download`), DLL hash-repair on Play,
  party progress, follow-the-leader, deep links `enw-zombies://map|party`, Check for updates.
- **Site** = Movement's map browser (both views, home rows from `collections`, one theme, nav
  Maps · Records · Admin, party panel left, `/download` gate for browser Play). Demo data wiped;
  Steam-only; seven approvals. `web.md` §10–11.
- **Replay viewer** ported; Nacht GLB exported (OpenAssetTools + Husky). `replay.md`.
- **Custom maps on the dedi**: fear_mc_2 passes; ORBiT/Requiem = client 2 GB ceiling; four
  `flag_wait` maps = a third-party add-on IWD shipped beside the map (archive `install.exclude` +
  `--stage` view; retest in `archive.md`/`dedi.md`); Der Berg = engine `localVars` limit; Leviathan
  = `napalmblob`.

## Late evening additions (read with the section above)

- **Launcher on the feed: 0.2.5** (`dc1c499`); 0.2.4 fixed Play on stock maps; the left-column-only
  shell (`8da3d0d`) is committed and ships in **0.2.6** with the identity lane's work.
- **Clicks**: root cause proven (a T4 click is a mask difference; moves carry masks; `client.md`
  §6f). B's two `ENW_INPUT_TRACE=1` runs are the verdict. Never build the mask from
  `GetAsyncKeyState`; never re-centre the cursor with `SetCursorPos` while buttons are held.
- **Settings**: the account block must never shadow undefined keys; the read-back must never
  persist engine defaults; the engine's profile is whatever `players\active.txt` names.
- **Custom maps**: `+set logfile 2` was the killer (`scripts.md`); the next wall is the client's
  weapon-index check after a swallowed server-side script error (`scripts.md` §7). Proof runs
  `scr11`–`scr13` paused for B; resume when the lock is free.
- **Research**: R15 (Plutonium trawl), R16 (FPS 250 lock, controller plan, QoL list) in the vault.
- **Identity lane in flight**: ENW username from Movement's SSO redeem / picker, server-side
  userinfo `name` overwrite from the token, `+name` + `name_pin.cpp` on the client. Its dated
  section in `referee.md` / `web.md` is the truth when you read this.

## What was running when this was written (2026-09-22 evening)

Three agents, results in the newest dated section of their lane doc: the **real launcher path
against the box** (`launcher.md`), the **replay viewer live on the site** (`replay.md`), and
**cross-server chat** (Movement's chat + game-event lines + Discord link; `web.md`, plus the
in-game overlay plan `chat-overlay.md`). And the **add-on IWD retest** (`archive.md`, `dedi.md`).
Read those sections before believing anything on this page about them.

## The next tasks, in order

1. **B's morning checklist in `STATUS.md`** (0.2.2, Play Local, three mouse runs, a party game).
2. Whatever the three evening agents left UNPROVEN in their sections.
3. **Four real players in one game, and round 2** — only friends can prove these.
4. **In-game chat overlay** (`chat-overlay.md`): DLL 2D draw + input capture + solo pause. Do not
   build on `say`/`tell` injection; it is unproven (`board.md`).
5. **Big maps**: reduce peak RSS in the DLL (vault R14) — parked until a map demands it.
6. **LICENSE file** on the public repo (GPL-3.0 client / AGPL-3.0 server, decided in principle).
7. Art for 2,270 archive maps; `/maps` vs home duplication; difficulty filter data.

## How to run things

```powershell
tools\dev\build.ps1 -Name dedi ; tools\dev\deploy.ps1 d2 -From dedi
tools\dev\jointest-proof.ps1 -Tag joinNN -Watch 300                       # five gates, local
tools\dev\jointest-proof.ps1 -Tag joinNN -Watch 300 -Map nazi_zombie_fear_mc_2 -BigHeap
node tools\dev\authhost.mjs selftest                                       # token issuer vs TokenGuard
infra\vps\join-remote.ps1 ...                                              # a real client → the box
cd launcher; npm test; npm run smoke; npm run pack; node tools\publish-update.js
cd web; npm test                                                           # 120/0 before chat landed
ssh zombies-dev 'systemctl status enw-host-agent; journalctl -u enw-host-agent -n 50'
```

Diagnostics (all off by default): `ENW_DEDI_ESCAPE_PROBE=1`, `ENW_DEDI_WATCH_PROBE_SLOT=1`,
`ENW_DEDI_NO_WATERSIM_POOL=1`, `ENW_DEDI_NO_OUTER_PACE=1`, `ENW_NO_HUFFMAN_GUARD=1`,
`ENW_FRAMETIME=1`, `ENW_RAW_MOUSE=0`, `ENW_RAW_MOUSE_NOLEGACY=1`, `ENW_BORDERLESS=0`,
`ENW_DEV_KNOBS=1` (never in a Verified game).

## Traps that are still traps

Never `+set developer 1`; never `ENW_PRIVATE_PROFILE`; always pass `com_maxfps`; clear `__CoDWaW`
before a deploy; `CS_CLIENTLOADING`, never `CS_PRIMED`; a status reply is not simulation (read
`com_frameTime`); `dedi_rate_probe delta=` reads 0 on a healthy server (read two lines);
`SendInput` at 8 kHz is discarded (only a real mouse tests the mouse path); agents' writes under
`%LOCALAPPDATA%` are sandbox-redirected ("installed" from an agent means nothing); the shared git
index (`git commit --only <paths>`); `-Maps` must be a real array; **never touch B's
`Activision\CoDWaW`** — our session's data is under `%LOCALAPPDATA%\ENWZombies`.

---

# The previous page (2026-09-22 09:00 / 10:30 / 15:45), kept for the run tags


Written 2026-09-22 at 09:00 after the game-over session; the custom-map and roster sections
rewritten at 10:30 after the dedi/referee bisect. If this page and `../../STATUS.md` ever
disagree, STATUS wins; it is rewritten at the end of every session.

## Read this first, because it changes what you think is true

**The headless server simulates, plays a round, ends the game, reports the result and stays up.**
That is the whole of Stage C's feature 1 and most of feature 4. `dedi.md` §12.3 has the two
300-second five-gate runs that proved the engine; `referee.md` §10 has what game over now does.

```
join65 / join66   CS_ACTIVE, ROUND 1, 76 of 76 getstatus answered,
                  com_frameTime 321,127 ms and still advancing, Com_Frame-body 59.0 Hz,
                  client slot 0 CS_ACTIVE at the end, 4-6% of one core, RSS flat 188 MB
```

**Three claims this session retracted. Do not re-derive them.**

1. **Der Berg is not a missing dvar.** `dedi.md` §12.5 said "find the dvar at `[0x3BFD478]` and
   register it". The dvar is `r_reflectionProbeGenerate`, it was registered, and `join69` failed
   in exactly the same place — with `ecx=00000FE9` instead of `ecx=00000000`. A **data breakpoint**
   on the slot (`ENW_DEDI_WATCH_PROBE_SLOT=1`) named the writer: 0x697B97, inside the loop at
   0x697B60 that pushes a script object's child-variable ids into `scrVmPub.localVars` **with no
   bound check**. Der Berg enumerates ~3,900 children, the scratch overruns 0x28D78 bytes into
   `.bss`, and the dvar pointer is the first casualty. `dedi.md` §13.1–13.2.
2. **`fs_game is write protected` means nothing.** Every map prints it, including the ones that
   boot; so do `fs_homepath`, `sys_configureGHz` and `dedicated`. And there is no `config.cfg`
   anywhere under `ZombiesDev\homes`, so §11.4's proposed fix could never have done anything.
3. **`Can't find map` is `fs_localAppData`, not `fs_game`.** The engine's map-exists check opens
   `<fs_localAppData>\<fs_game>\<bsp>.ff` with `CreateFileA` and ignores the FS search path.
   `tools\dev\mapmount.ps1` makes that junction as well as the per-home one, and says out loud
   which path the check will open. `dedi.md` §13.3.

**And one thing that is now true and was not:** `console_command()` used to be `return false;`, so
every `referee: host asked to end the game -> map_restart` line ever logged was a lie. It is
implemented (`Cbuf_AddText` 0x594200, `text` in `eax`, `localClient` in `ecx`, nothing on the
stack). `referee.md` §10.4.

## What game over does now, and what the host agent still has to do

On game over the referee sends an enriched **`game_over`** (round, reason, duration, per-player
points/downs/revives/alive, totals), **stops the replay sampler**, and sends a new **`match_end`**
meaning *this process is idle, the instance can be reclaimed*. Then it does nothing — it never
recycles its own map, because that would destroy evidence the host had not finished writing down.

Proven in **`join73`** (prototype, 300 s, five gates, PASS): `GAME OVER at round 1 ... after
120953 ms ... Replay sampler stopped. match_end sent`, `replay: sampler stopped ... after 2057
snaps / 402486 bytes`, and the server still simulating at 59.0 Hz / `com_frameTime=321195` three
minutes later with the client attached.

**`infra/host-agent` has to answer `match_end`, and today nothing does.** Close and sign the
replay, post the result, then either send `{"t":"end","id":…}` (the referee `map_restart`s, resets
and re-announces `map_loaded` — open a new replay on that) or terminate the process. It must do one
of the two. The contract is `referee.md` §10.3 and the rows are in
`../protocol/game-link-v0.md`. **That is the single highest-value task on this page.**

## The custom maps, measured — and the "broken" suspicion is dead

**Rewritten 2026-09-22 10:30 after the bisect.** The previous version of this page asked why four
maps died the same way and said "nobody has run one of them on a listen server — that is the cheap
test". It has been run.

**`mapA`: all four boot on a STOCK `CoDWaW.exe` with the binkw32 proxy reverted — zero ENW code in
the process — as a listen server, and produce the byte-identical script runtime error.** Each map's
own `main()` starts a flag-dependent thread *before* it calls `maps\_zombiemode::main()`, which is
what calls `maps\_load::main()`, which is where `flag_init("all_players_connected")` lives. Zombie
Desert's author even labelled the block `FUNCTION CALLS - PRE _Load`. **`mapB`: Der Berg stops
simulating at `com_frameTime=5651` with `ENW_NO_SAMPLERS=1`** — no `SV_Frame` hook, no entity read,
no replay — against 5659 and 5662 with everything on. Neither the overlay hypothesis nor the
sampler hypothesis survives. `dedi.md` §14, `referee.md` §11.

| Map | bsp | verdict |
|---|---|---|
| Zombie Desert | `nazi_zombie_test1` | **broken, the map's own script order** — proven on a stock exe (`mapA`) |
| Project Viking | `nazi_zombie_test` | same (`mapA`) |
| MW2 Rust | `mw2rust` | same (`mapA`) |
| Clinic of Evil | `sanatorium` | same (`mapA`) |
| Der Berg | `nazi_zombie_derberg` | **broken, the map's own script** — `localVars` overflow with our samplers off (`mapB`) |
| Leviathan | `nazi_zombie_leviathan` | **broken on the existing evidence**; not re-tested — one `maptest.ps1 -NoEnw` run would settle it |
| **Minecraft Village Remastered** | `nazi_zombie_fear_mc_2` | **PASSES the five-gate 300 s proof with a real client (`join83`)** — the first custom map ever to |
| ORBIT | `nazi_zombie_orbit` | server gates 2-5 PASS over 320 s; **the CLIENT** stalls loading the 128 MB zone at ~1.5 GB RSS and is dropped (`join80`) |
| UGX Requiem | `ugx_artemovsk` | the same (`join81`) |
| Water / School / Hijacked / Octogonal / DT2 | | do not boot; first causes in `dedi.md` §14.6 |

**`nazi_zombie_prototype` is no longer the only map that plays.**

## The host agent gets a roster now, and it still has no identity

`player_connect` / `player_spawn` / `player_disconnect` **had never been emitted by the game** —
only by `infra/host-agent/sim/engine.js` — and `lib/referee.js` creates a player row in
`ev_player_connect` and nowhere else. That is why the box's first real game (replay `m_5de3842b`,
site game id 2) finished with **`game_players = 0`** and `result_mismatch` while every simulator
test passed. The referee emits all three now, off an edge detector over the client poll, and the
`game_over` rows carry `name` + `steamid`/`xuid`. Proven in `join85`.

**But the steam id is empty, and that is the half that matters.** `join87` printed the whole
userinfo key list a real T4 client sends: `cg_predictItems cl_punkbuster cl_voice rate snaps name
protocol challenge invited qport bdTicket bdTicketTime`. **No `xuid`, no `steamid`, no `guid`** —
the identity is inside **`bdTicket`**, the Demonware ticket. Treat the roster as *attendance* until
that is decoded, and do not award anything to it. `referee.md` §12.

## The next tasks, in order

1. **The host agent must answer `match_end`.** See above. Without it a finished game leaves an
   instance up for ever and the next lease never starts. `host.md`'s lane.
2. **Decode `bdTicket`, or bind the auth path, so a roster row has a steam id.** Without it the
   result scores an attendance list and no XP or record can attach to an account. `referee.md`
   §12.3 has the measured key list. `invited` is worth a look at the same time — it is a natural
   carrier for the invite token of feature 12.
3. **Round 2 needs a player who shoots.** A round ends when its zombies are dead; an idle client
   kills nothing and gets eaten in round one. There is no server-side substitute:
   `Scr_NotifyNum` unbound, script-variable writes unbound, and the exe has no AI-kill console
   command. Writing `health = 0` into a `gentity_s` is **not** a route (AI death comes from the
   damage path). `referee.md` §10.6.
4. **`re` has five new addresses to adopt** — `Cbuf_AddText` 0x594200 (eax/ecx, nothing on the
   stack), `Dvar_RegisterBool` 0x5EEE20 (name@edi, value@al, flags and desc on the stack),
   `gScrVmPub` 0x3BD4700 stride 0x4320 with the `localVars` scratch pointer as its first dword,
   the script variable table 0x3974700 (16-byte rows, per-instance stride 0x16000, name id at +0,
   next sibling at +2), and the `fs_localAppData` / `fs_game` / `useFastFile` dvar slots
   0x2122AF0 / 0x2122B00 / 0x1F552FC.
5. **Der Berg, if anyone wants it**: bound the push loop at 0x697B60 or give `localVars` a bigger
   buffer. It is an engine-limit job of the kind T4M exists to do, and it was not attempted.

## How to run things

```powershell
tools\dev\build.ps1  -Name dedi
tools\dev\deploy.ps1 d2 -From dedi

# the five-gate proof; -Map and -BigHeap are new, so a custom map can be proved too
tools\dev\jointest-proof.ps1 -Tag join74 -Watch 300
tools\dev\jointest-proof.ps1 -Tag join75 -Watch 300 -Map nazi_zombie_derberg -BigHeap

# boot a list of maps headless, no client, ~100 s each
& .\tools\dev\maptest.ps1 -Tag map06 -BigHeap -NoDeploy -Maps @('sanatorium','mw2rust')
```

`-Maps` must be a real array (`@('a','b')`) — `powershell -File … -Maps a,b` passes the whole thing
as one string and `map04` wasted a slot finding that out.

**Diagnostics, all off by default:** `ENW_DEDI_ESCAPE_PROBE=1` (where the frame leaves),
`ENW_DEDI_WATCH_PROBE_SLOT=1` (data breakpoint on 0x3BFD478 — the pattern to copy for any wild
write), `ENW_DEDI_NO_WATERSIM_POOL=1` and `ENW_DEDI_NO_REFLECTION_DVARS=1` (controls),
`ENW_DEV_KNOBS=1` (allows host `exec`; never in a Verified game).

**The traps that are still traps:** never `+set developer 1`; never `where_is_main.cpp`; never
`ENW_PRIVATE_PROFILE`; always pass `com_maxfps`; clear `%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW`
before a deploy; `CS_CLIENTLOADING`, never `CS_PRIMED`; a vectored handler that logs is a loop,
because the ENW logger goes out through `OutputDebugString`; and never budget a diagnostic by "the
first N events" — the first six exceptions of any run are init-time debug prints.

## Identity — added 2026-09-22 15:45 (referee lane, `referee.md` §13)

**A real player's result now carries their Steam account.** The identity is the site's invite
token, parsed server-side out of userinfo key **`enw_token`**, verified by the host, and reported
as `steamid` + `identity` on `player_connect` and on `game_over`. `join94` is the run: five gates,
PASS, `"steamid":"76561198000000042","identity":"verified"` in the `game_over` players array.
`join95` is the other half: a forged token → `DENY (bad_signature)` → `clientkick 0` → gone in
27 ms.

```powershell
# mint one the way the site does, against a SCRATCH key dir (never web\keys, never the live DB)
$t = node tools\dev\authhost.mjs mint --keydir "$env:TEMP\enw-authtest-keys" `
        --match m_id98 --steamid 76561198000000042 --name enw-tester --slot 0
# the token half of a host agent: issues with web's code, verifies with the host agent's own
node tools\dev\authhost.mjs serve --keydir "$env:TEMP\enw-authtest-keys" --match m_id98 `
        --port 38795 --out C:\Users\b\ZombiesDev\logs\dedi\join98-link.ndjson
# five gates AND an identity readout
tools\dev\jointest-proof.ps1 -Tag join98 -Watch 300 -AuthToken $t -MatchId m_id98 `
        -LinkHost 127.0.0.1:38795

node tools\dev\authhost.mjs selftest          # 8/8, site issuer vs the box's own TokenGuard
node tools\dev\authhost.mjs mint ... --forge  # the site's real signature over an edited payload
```

**A join run without `-AuthToken` is still a valid proof of everything except identity** — it
simply reports `identity=none` and nothing downstream may award to it. That is Play Local's shape
too, and the site already refuses to count it.

### The first three things to pick up

1. **The two refusals that have not been seen in a game.** `replayed_token` (a second client
   presenting the same token) and `wrong_match` (a token minted for another lease) are implemented
   and proven host-side, not in a join run — the lock went to a launcher game. `waw-c2` is
   deployed. Start `jointest.ps1 -Tag join97 -AuthToken <T> -MatchId <M> -WatchSeconds 200` and
   40 s in fire `launch.ps1 c2 -Role client -HomePath own -Companion -AuthToken <the same T>
   -EnwHost 127.0.0.1:28960` with `ENW_CLIENT_CONNECT`/`ENW_CONNECT_ADDR` set the way
   `jointest.ps1` sets them. Expect `REFUSED (replayed_token)` on the second slot.
2. **The host and web asks in `referee.md` §13.5** — carry `identity` into the posted result, do
   not award XP to a row that is not `verified`, and send `end {…, "match": …}` on a reuse so a
   warm instance can lease-check its tokens. Neither lane has a bug today; both are additive.
3. **The real launcher path has still never been exercised end to end with a dedicated server.**
   `join94` used `ENW_AUTH_TOKEN`, which is fallback #3 in `auth_token.cpp`. Production is the
   one-shot named pipe (`ENW_TOKEN_PIPE`). The pipe has its own test
   (`launcher/test/launch-harness.js`), and the two paths converge one line later at
   `setu enw_token`, but nobody has watched a launcher-minted token come out of a dedicated
   server's `game_over`.
