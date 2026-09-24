# Local brief: land parties carry-over + disconnect pause/reconnect (2026-09-24)

For the **local session on B's PC**. B's pronouns are she/her. Written by the cloud session that built
both features on branch **`claude/awesome-mccarthy-v1krwc`**. Everything that runs without Windows is
built and tested there; what is left needs Windows, the game, the box, or B's go. Read `CLAUDE.md`,
`docs/kickstart/README.md` (hard rules; 17 = build from a clean detached worktree, 13 = no verified
player live before a box change, 16 = the launcher publish recipe) first.

Pointers, not pastes: `cloud-handback-parties.md`, `cloud-handback-reconnect.md` (read its "B's answers"
section: it supersedes items above it), `dedi.md` §30, the 2026-09-24 sections at the bottom of
`referee.md`, `host.md`, `web.md`, `launcher.md`.

## 1. Check the branch

```
git fetch origin claude/awesome-mccarthy-v1krwc && git log --oneline main..FETCH_HEAD
cd web && npm install && for t in <each file in npm run check>; do node $t; done   # run each: the chain stops at the
                                                                                  # pre-existing launcher-signin failure
cd launcher && node test/run-all.js
cd infra/host-agent && npm test && node test/party-carryover.js && node test/reconnect.js && node test/idle-close.js
```
Cloud results: web all 0 failed except `launcher-signin` 14/1 (Steam redirect, fails on main too);
launcher 197/5 (the same 5 fail on main in Linux; on Windows they may pass); host all pass. Run the
C++ tests under MSVC: `expected_players_test`, `reconnect_rules_test`, `pause_policy_test` (header
comments have the `cl` lines).

## 2. Verify against the dump, then build

- `0x52E910` entry bytes `A1 48 83 05 03` and the tail `0x52E995` (the `expected_players.cpp` stub's
  assumptions: ebx must be 1, the tail pops esi, ebx).
- gclient **+0x20 origin / +0x2C velocity as WRITE targets** (`spawn_rescue.cpp`): do they stick, and does
  the client need `EF_TELEPORT_BIT`?
- gclient +0x20BC..+0x20D0 writes (`set_player_stats`, the reconnect restore).
- The reconnect hand-back's "engine assumptions" 1-8; the big one: can a client load into a frozen world.
- Then build server + client DLLs from a clean detached worktree of the branch (rule 17).

## 3. Build the one piece the cloud could not: the pause screen (client DLL)

B, 2026-09-24: *"When the game's paused, the chat should be up and so should the mouse, and there should
be a button that says Continue without. Instead of the chat command. The host is the one that should
continue."*

- **Chat up, mouse free, whenever the world is frozen and the player did not cause it** (a drop hold, a
  host pause, the all-AFK pause). `chat_overlay.cpp` already knows the freeze (`pause_hold_tick`,
  `g_frozen`). On a freeze with neither the overlay nor our Esc menu open: open the overlay and release
  the cursor (the overlay's own open path, `ClipCursor(nullptr)`). When the freeze ends and the overlay
  opened itself and the player has typed nothing, close it again.
- **Do not report `enw_ui typing` for an overlay that opened itself** until the player presses a key.
  Otherwise, in solo, the auto-open becomes a `solo_chat` pause that outlives the pause that caused it.
- **The Continue without button.** `GET /api/game-chat/menu/state` (the chat pass; `pause_menu.cpp:400`
  already calls it) now returns `hold: { paused, away: [{ name, left_ms, you, returning }], match_id,
  can_continue }`. `can_continue` is true only for the party host. While `hold` is set, poll it every
  ~2 s, show "*<name>* disconnected · paused, waiting to reconnect (m:ss)" (the rail's words:
  `web/client/src/holdLabel.js`), and for the host a **Continue without** button that does
  `POST /api/game-chat/menu/continue { match_id }`. The site refuses anyone else. Draw it in the overlay
  (it is up during the freeze), in WaW's own font (chat-overlay.md §12).
- The server side is done and tested: the site hands the ask to the box once on the next live-frame reply,
  and the host lets the game go (`referee.continueWithout`, 10 s countdown).

## 4. Turn pause back on (needed for the freeze, and for B's solo pause-while-typing)

The box runs `ENW_NO_PAUSE=1` in `/home/waw/run-host.sh` since B's solo Nacht died after a chat pause
(`dedi.md` ~line 2703: `[0x3BFD478]` overwritten by the script VM's localVars copy at `0x697B97`, whether
pausing provokes it is open; `ENW_DEDI_WATCH_PROBE_SLOT=1` is there to name the writer). Solo
pause-while-typing (`enw_pchat`, `solo_chat`) is already built and worked on 0.2.13. Integrity is fine:
the freeze holds `level.time`, so a pause adds no game time (`referee.md` §15).
1. Reproduce locally: a solo dedi game, 13+ chat pauses (the 23:44 game died after 13), with the watch
   probe on. Name the writer, fix it, prove 30+ pauses with no overwrite.
2. Or, if that runs long, ask B about `ENW_PAUSE_HOST_ONLY=1` (drop holds freeze; players' own pauses do
   not) as a step, knowing solo pause-while-typing then stays off.

## 5. Two-client tests (hard rules 3, 4, 11: the game lock, own PIDs, invisible windows)

`tools/dev/jointest*.ps1`, fake IDs:
1. Round 1 waits for player 2 (DLL log `expected_players: lease 2, connecting 1 -> 2`), Nacht and Hijacked.
2. A party member joins mid-game, gets in, and lands on the floor on Hijacked (`spawn_rescue:` line).
3. A map switch moves both clients (the rail's confirm, the launcher ends the old game, follows the new).
4. Kill client 2 by its PID: the game freezes, client 1's chat opens with the mouse free, the host sees
   Continue without. (a) Relaunch client 2 with a fresh token: its points are back on the HUD and it can
   buy; everyone hears "... rejoined. Your record is no longer eligible for leaderboards past round N, but
   your stats will still track."; the result's `record_cut` has the round at the kill. (b) Press
   Continue without instead: the game resumes after 10 s, client 2's old body is gone.
5. Alt-tab and an open Esc menu are not drops; `ENW_NO_RECONNECT=1` is the old behaviour.

## 6. B's go, then ship

Box DLL + host agent (the deploy recipe in `next-session.md`; the host now takes `--drop-hold-ms`,
default 5 min), site restart (new columns migrate themselves: `parties.pending_map_key`,
`pending_since`, `assignments.switched_from`, `games.rejoined`), launcher publish by the recipe
(rule 16; new: Rejoin toast, map-switch follow, pending-map download). Merge to `main`. Update the
`next-session.md` top table and the vault Build Log (the cloud session did neither).

## 7. For B, still open

- Weapons, perks and position are not restored on a rejoin yet (points and scoreboard are): the per-map
  GSC in `referee.md` §3.3.
- The map-switch "silence" window (`SWITCH_SILENCE_MS`, 30 s) and the rescue's 500 ms "on nothing" grace
  are the cloud session's picks.
