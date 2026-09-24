# Cloud hand-back: disconnect → pause → reconnect (2026-09-24)

B: *"If someone disconnects from the game, it pauses and allows people to reconnect and continue as
if nothing happened."* Built in a cloud Linux container: **no DLL was compiled, no game was run, the
box and the live site were not touched.** Every line below that says [unverified] is for the local
session on Windows.

## What the spec says (vault, read-only)

- `10 - Speedruns, Records & Crash Recovery` **§5 "Crash → auto-pause → resume"**, the policy table:
  casual/badge games auto-pause, hold the round, **5–10 min grace then a resume countdown**, full
  restore (points, weapons incl. `_upgraded`, perks, position), tag "Resumed"; record games get
  the pause and a **vanilla rejoin** (back before the round changes), every pause logged; always:
  freeze the zombie count, keep limited weapons reserved, **block rejoin-after-bleedout**. Solo:
  the whole game is held for the grace. Its last paragraph ("The pause, as built") says crash
  triggering and state restore were not built.
- `15 - Policies & Edge Cases` "Games" (a player crash), `99 - Build Spec` §4.7 "Crash recovery"
  and its acceptance line "A player crash in a casual game pauses and restores".
- `11 - Implementation Reference` §6 (pause technique: bind the token to the slot, reserve limited
  weapons, block rejoin-after-bleedout) and §4 "State-restore builtins" (GSC calls).
- Feature 11's verdict (`17 - Kickstart`): "Designed against confirmed traps, unproven".

## What existed before (base `2116a43`)

- The engine freeze and the host hold: `server/components/pause/` (`dedi.md` §18, `referee.md`
  §15), **off on the box** (`ENW_NO_PAUSE=1`, `dedi.md` §18.6); D1 later showed pausing was not the
  cause of the slot overwrite (`dedi.md` §23.2) and §25/§26 fixed the escaped frames.
- Host `lib/referee.js`: a **solo-only** crash hold on `player_disconnect`, `snapshot_state` /
  `restore` plumbing, SteamID matching of a returning player.
- DLL: `snapshot_state` read only ACTIVE slots (so it had nothing for the player who just left);
  `restore` was not implemented; a returning account was refused `steamid_already_seated` while
  its old slot was still seated; the drop was seen only at the engine's ~40 s timeout.
- Site: `seats.js` Resume on the rail (fresh token); launcher: followgate (no auto relaunch).

## What was built (branch `worktree-agent-ad429ce66fc80558e`)

| Commit | What |
|---|---|
| `9986592` | DLL (referee lane): `reconnect_rules.hpp` + test; `player_lost`/`player_back`/`player_ready`; state as of the last input on `player_lost`/`player_disconnect`/`snapshot_state`; the ghost is kicked when the same account reconnects; `restore` queued and applied (score + counters) after the spawn; new token on a seated slot = new connection; `ENW_PAUSE_HOST_ONLY`, `world_frozen()`; `ENW_NO_RECONNECT`, `ENW_RECONNECT_LOST_MS` |
| `7897511` | Host: the drop hold for co-op and solo, per-player grace, `player_ready` before the countdown, blip resume, quits never hold (`markQuit`), `!continue`, kick at grace end, flags, `state().away`; sim + `test/reconnect.js` |
| `442c86f` | Site: `/api/gs/live` replies `quit`; `hold` on `/api/party` and `/api/launcher/play`; the rail card's words; `rejoined_while_down` voids ENW-Verified |
| `b00854f` | Launcher: a once-per-match Rejoin toast (the site's Resume, then follow at once); never an automatic relaunch |
| `352f606` | A game that cannot freeze (`pause not armed`) is never called paused; the hold still waits and restores |
| docs | `game-link-v0.md` rows; dated sections in `referee.md`, `host.md`, `web.md`, `launcher.md` |

Detail: `referee.md`, `host.md`, `web.md`, `launcher.md` → "2026-09-24 cloud: disconnect pause + reconnect".

## Tests (last lines)

```
g++ server/tests/reconnect_rules_test.cpp   reconnect_rules: 67 passed, 0 failed      (new)
g++ server/tests/pause_policy_test.cpp      pause_policy_test: 41 passed, 0 failed    (+4)
g++ solo_parity / freeze_watch / verified_env / replay_events: 21 / 134 / 43 / 66 passed, 0 failed
infra/host-agent node test/run-all.js       128 passed, 0 failed                      (+15)
infra/host-agent node test/reconnect.js     PASS reconnect                            (new, e2e)
  idle 10/0, idle-close PASS, restart 17/0, multi-lease PASS, boot-queue PASS, mapcache 22/0,
  telemetry 81/0, demo-network 0 failures
  demo-local: 1 failure "expected the hello to be ignored by default" -- SAME on base 2116a43
web (each file alone)                        all 0 failed, reconnect-hold 6/0 (new)
  launcher-signin 14/1 "/auth/steam goes to Steam" (500 vs 302, needs outbound network) -- SAME on base
  map-align skipped (no Windows export); client `vite build` clean
launcher node test/run-all.js               192 passed, 5 failed (4 new rejoin checks pass)
  the 5 = Windows paths/binaries (isInside sibling, junction removal, LocalAppData maps,
  client-DLL repair, engine-defaulted read-back) -- base 2116a43: 187 passed, 6 failed
```

The DLL files were syntax-checked with 64-bit g++ and a stub `windows.h` (only the known `__asm`
blocks and the 32-bit assert fail); **MSVC has not compiled them.**

## Engine addresses and offsets

No new hook, no new code patch, no new call-site retarget, so there is nothing to byte-check.

| Used | Where from | Tag |
|---|---|---|
| `client_s.lastUsercmd` +0x11108 (`usercmd_s` 0x38) | `dedi.md` §7h table ("from an instruction"); `t4_bind::last_usercmd` | [V] |
| `usercmd_s.serverTime` +0x0 | same; `solo_parity` "CLIENT FROZEN" uses it | [V] |
| `usercmd_s` buttons +0x4, angles +0x8, forward +0x16, right +0x17 | T4SP header (`shared/t4/structs.hpp`), read by the replay sampler | [H] (only "did any byte change" is asked of them) |
| gclient +0x20BC..+0x20D0 (score, kills, assists, downs, revives, headshots), stride 0x2348, `level.clients` 0x18F5D88, field table 0x83C568 | `referee.md` §16, re-verified at bind time | [V] read; **WRITE is new [unverified]** (`set_player_stats`) |
| `svs.time`, `nextSnapshotTime`, `G_RunFrame` gate, `level.time` 0x18F6DC8 | `pause.cpp` (unchanged) | [V] |
| `player_ent` (origin/angles/health/alive), `player_combat_state` (ps.weapon, clip/ammo) | existing reads | [V] per `referee.md` / `replay.md` |
| `clientkick <slot>` through `Cbuf` | existing `kick_slot` | [V] |

Engine BEHAVIOUR the design assumes, all [unverified]:

1. A crashed/frozen client's `lastUsercmd` stops changing; a live client's changes at least every
   5 s — **including with the ENW Esc menu open, alt-tabbed, minimized**.
2. The engine's client timeout counts `svs.time`, so a frozen world never drops the ghost (Q3/CoD4
   inference; T4's `SV_CheckTimeouts` is not located). If it counts real time, the ghost is
   dropped at ~40 s and the design still holds (the state was taken at `player_lost`).
3. **A client can connect, get the gamestate and reach CS_ACTIVE while `G_RunFrame` is gated** (a
   join during a freeze). If not, the returning player cannot load until the hold ends.
4. A returning client's usercmds change while the world is frozen (`player_ready`); if not, the
   host falls back after `readyWaitMs` (90 s).
5. Whether a relaunched client reconnects into its old slot (the engine's same-address reconnect)
   or a new one; both paths are handled (token change / ghost kick).
6. Writing gclient +0x20BC is what `self.score = x` does (the setter's store at 0x4ECF25): purchase
   checks see it at once; the points HUD (a script hudelem) may lag until the next points change.
7. 1.5 s of running world after the new body is alive is after the stock spawn script's own score
   set (`onPlayerConnect` 500 / `spectator_respawn` penalty).
8. `clientkick` of a lost slot during a freeze drops it cleanly.

## For the local session (in order)

1. **Build** the dedi DLL from a clean, detached worktree at the merged main commit (README rule
   17), `build.ps1 -Name dedi`; record sha + commit + rollback in `dedi.md`. Build and run
   `server\tests\reconnect_rules_test.cpp` and `pause_policy_test.cpp` with the `cl` lines in their
   headers.
2. **Local two-client proof** (jointest harness, `nd` server + two invisible clients, fake IDs
   `…0001`/`…0002`, private LocalAppData, game.lock held for all three; rules 3, 4, 11, 12):
   - a. co-op, kill client 2 **by its own PID**: server `player_lost slot 1 … no input for 5xxx ms`,
     host `LOST`, `pause: PAUSED (host`, client 1's chat "… lost connection. Paused for up to …";
   - b. relaunch client 2 with a fresh token (the site's Resume, or authhost): server `slot N is
     <sid> coming back; slot 1 is their lost connection and is kicked`, `player_ready`, host
     "Everyone is back. Resuming in 10 seconds", `pause: RESUMED`, `RESTORED slot N: score …`;
     check client 2's Tab board and points HUD, and that a buy works with the restored points
     (item 6 above); `game_over` rows carry one row per account;
   - c. the same solo; d. alt-tab / minimize client 2 for 10 s in co-op (must not trip, or tune
     `ENW_RECONNECT_LOST_MS`); e. Esc menu open 30 s with the other player playing (must not
     trip); f. `ENW_NO_RECONNECT=1` control (the old behaviour); g. `ENW_NO_PAUSE=1` (the box
     today): host flags `pause_unavailable`, the game runs, points still come back;
   - h. **item 3**: does client 2 load in while the world is frozen?
3. **Pause on the box**: either `ENW_PAUSE_HOST_ONLY=1` (disconnect/AFK hold only, Esc does not
   pause) or pause fully back, in `/home/waw/run-host.sh` — B's or the coordinator's call. Until
   then the hold waits and restores with the world running.
4. **Deploy**: host agent (rule 13: no verified player in a live instance), the box DLL (all
   `waw-*/binkw32.dll`, rollback kept), the site on B's word (rule 15) for the rail and the
   `quit` reply, and a launcher by the recipe (rule 16) for the Rejoin toast.
5. **A real two-player box game**: one player Alt+F4s mid-round, relaunches, presses Rejoin.

## For B to decide

1. **Grace length**: the box holds for `--idle-gone-ms` = **3 min** (your 2026-09-23 19:10 "gone
   for 3 minutes"), the spec says 5–10 min. In co-op the others now wait that long (or `!continue`).
2. **Is a Verified game a "record game"?** Nothing sets `recordProfile` in production, so every
   game restores and is tagged `resumed`, which **voids its ENW-Verified record**. Record games
   should get the pause and a vanilla rejoin instead (then only `rejoined`, which does not void).
3. **`!continue`** (players still in the game stop waiting) is my addition, not in the spec. Keep?
4. **Weapons, perks and position** are not restored (only points and the scoreboard). They need
   the co-loaded GSC (`referee.md` §3.3: a `maps/enw/_referee.gsc` in each map folder plus two
   addresses). Until then "as if nothing happened" is true for the points, not the loadout.
5. **Limited weapons** (the Waffe) stay reserved only while the ghost is seated; after a kick, or on
   a restore, they are not given back or reserved.
6. **Dropping while down** is flagged `rejoined_while_down` (no ENW-Verified record) rather than
   blocked: the server cannot stop the level's spawn script from standing them up.

Not done here: a `board.md` line (left for the merge, to avoid an end-of-file conflict with the
parallel parties branch), `next-session.md` (per the brief).
