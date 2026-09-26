# Next session — start here (2026-09-23 evening handoff, 23:00 UK)

**Read this block first; the older sections below are history.** Coordinator session 16:30–23:00 UK
(B's PC rebooted 15:30 and killed the afternoon agents). Every lane's detail is in its lane doc and in
the vault Build Log (`19 - Build Log`, "16:30 UK — new coordinator session" roster and entries).

| | State at 23:00 UK |
|---|---|
| Launcher | **0.2.35** on the feed, client DLL `1b482aa2` |
| Box DLL | **`59577dbe`** (= `1b482aa2` + dev-gated bot fixes only), host agent **`9e9e86a`**; box still CX23 2 vCPU / 3.8 GB |
| Site | live on main (MAPS merged `ac0dac3`, restarted 23:56): **89 maps playable** on our servers (was 64 this morning); GEO + S2 merged. Catalogue twins: only exact-title twins hidden and linked (`superseded_by`, "Earlier versions"); B's series rule (memory `map-series-rule`): series maps are distinct, never auto-merged; review list `reports/catalogue-twins-review.json` |
| Replay geometry | **235 of 236 maps** with real shells + props live in `/mapdata` (was 4), extracted offline by our OAT T4 GfxWorld dumper (`tools/maps/oat-t4-world`, ~1 s/map, no game launch); median 6.9 MB, max 21 MB; not promoted: nazi_zombie_mc_maze (window goals 174–182 u off), nazi_zombie_ali (no fastfile). 231 custom maps' geometry is public on gate-free `/mapdata` (B's IP call; lane 10's 4 customs had been moved to `maps\_hold` at ~14:00 with no reason written). `replay.md` §15 |
| Fixed and live today | NULL `snd_errorOnMissing`/`r_watersim_debug`/`fx_enable` freeze class (lorkeep, ILS, ut_box, fear_mc_2); phantom z=0 water on the dedi (Nuketown drowning, nacht_reimagined floating; `water_sim_off` + `solo_parity` self-check); Wine VirtualQuery CPU cost (ILS 0.82 → 0.18 core, 24 → 61 Hz); AMD sun-flare occlusion-query hang (Town of the Dead, Nuketown, 8 maps; `gpu_query_guard`); UGX mode votes answered from the party's pick (25 maps, per-mode records); instant console restart + post-game restart window + × closes the server + idle auto-close (5 min no join / 3 min empty); friends from Movement + everyone online in the rail + launcher flash/chime/toast; replay sound, first-person arms + ADS, placeholder gun, 17 more guns; ENWZombies.exe (Discord shows ENW Zombies) + `infra/discord.env`; 31 `+`-command cap guard; the SOC blank-page ReferenceError |
| Next-session queues | MAPS resume: `archive/resume-new-maps.txt` (62 new, --hold 185) then `archive/resume-reproof-t2.txt` (34, --hold 125), fake …0005, commands in `archive.md` §14.8; 15 box-pass maps hidden by the asset gate (§14.6 by class). S2 soaks: `tools/dev/leasesoak.ps1` Nacht/Der Riese 120 min (commands `dedi.md` §27.8); bot fix proven on ut_box_map (30 min, rounds 1→16, 441 kills, 0 escapes, 61 Hz). **First task next session:** run `tools\dev\ce-proof.ps1 -Tag ce5 -Map nazi_zombie_ccube` and `-Tag ce6` (screenshot guard on Cheese Cube; the Documents redirect in `enw_localappdata.cpp` is built but unrun, so check nothing new appears under B's Documents), then publish launcher 0.2.36 with the CE DLL (merged `17f5052`). Also: `settings_model_test` has 1 failure from main (SOC settings change), fix it. |
| Archive run (2026-09-25, cloud) | **MEGA now fetchable** (`archive/lib/mega.py`, MAC-checked; needs `pip install cryptography`), `fetch.py` tries 3 mirrors, browser lane for ZombieModding/Drive/OneDrive/captcha (`browser_queue.py` → B saves into `browser-drop/<norm>/` → `ingest_browser.py`). All offline-tested only (cloud egress refused every host). The four-lane run plan (FETCH / PLAYABLE / GEOMETRY / DETAILS; box proofs are the serial bottleneck) is `archive.md` §15.4 — run it from a local session |
| Archive run (2026-09-26, cloud) | 2,024 maps catalogued, 263 held, 70 fetched in the cloud (3 in the bucket), ~820 queued. **Upload loop blocked on B's permission rule** `Bash(/home/user/zombies/archive/cloud_loop.sh)`. PC publish steps `archive.md` §16.1; browser checklist `archive/browser-queue-2026-09-26.md`; run `scan_maps.py --keep-existing` once for `corpus-ignore.json` |
| Unproven | a real player on: restart via the host path, the gungame vote answer, the water fix, Town of the Dead after the guard; S2's custom-map bot rounds; 2 h soaks |
| For B | CX33 (€10.79/mo gross) or a temporary box for soaks; dt2 visible with `asset_audit_pending` (m4a1_zm missing); 11 box-pass maps hidden by the asset gate (raw weapon patch path); Q-soc-1 "the ENW main server" for friends; `git push origin main` (agent pushes are blocked by the permission classifier) |

**CE (2026-09-24 00:15 UK, `client.md` §14):** B's "died at the end and the game crashed" (Cheese Cube, 0.2.35) was **F12**: WaW's
stock `screenshotJPEG` at 2560×1440 needs an 11 MB temp-hunk block from a 10 MB hunk → ERR_DROP → lockdown quit. Every map, any
moment, any display >3.4 MP. Fixed by `screenshot_guard.cpp` (JPEG buffer from the heap); reproduced guard-off (ce2) and proven
guard-on on Nacht through game over → end screen → clean quit (ce4). Branch `worktree-agent-ae9502ddee2a48065`, client DLL
`0657d9f2`, next launcher publish. **Open:** Cheese Cube run + the Documents redirect run (refused by the agent's permission
guard), and **delete `C:\Users\b\Documents\Activision`** (three test JPEGs this lane's runs created; the engine writes shots there).

**SS (2026-09-24 01:25 UK, `client.md` §15, `launcher.md` 2026-09-24 SS): launcher 0.2.36 is on the feed** (client DLL
`a02958f8`, clean `ZombiesDev\wt-rel11` at main `3d5ce16`; version commit `380cda5`). F12 is now ENW's own screenshot
(`enw_screenshot`; WaW's `screenshotJPEG`/`screenshot` are redirected to it, so the §14 drop and the Documents writes are
gone for players): the finished frame at Present, JPEG q95 4:4:4 (≈0.7–1.3 MB at 1440p) or PNG, to
`%USERPROFILE%\Pictures\ENW Zombies\ENW Zombies <map> <date time>.jpg`, "Screenshot saved" in game; launcher Settings >
Screenshots (Open image / Show in folder / Open screenshots folder) and a toast after a game. Proven locally at a real
2560×1440 back buffer on Nacht (ss1 our bind, ss3 WaW's bind, shipped DLL) and Cheese Cube (ss2): no drop, files right.
**Open:** render thread still pays one 4.6–9 ms Present per shot (game thread 0.02–0.4 ms; DONOTWAIT is ignored by the
driver — fix = event-query ring, `client.md` §15.2); ce5/ce6 not run (ce-proof now forces the stock path); no real
Electron run of the toast/list; `settings_model_test` fixed (3 excluded). CE's three JPEGs in B's `Documents\Activision`
are still there. `git push origin main` is B's.

# Durable: how to run things, agent rules, traps (carried from the 2026-09-23 03:30 page)

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
the sha, source commit, worktree and rollback into the newest `dedi.md` section and the next-session table. A running
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


Older handoff pages: `history/next-session-history.md` (read only when a pointer sends you there).
