# Cloud hand-back: parties that carry over (2026-09-24)

Answers `cloud-brief-parties.md`. B's pronouns are she/her.

**Branch:** `claude/awesome-mccarthy-v1krwc` (the session's assigned branch; the brief asked for
`cloud/party-carryover`, which this session was not allowed to push to). Nothing pushed to `main`.

## Commits

| Commit | What |
|---|---|
| `7c8e7a9` | dedi: `expected_players.cpp` (getnumexpectedplayers stub), `spawn_rescue.cpp`, `expected_players_rules.hpp`, `server/tests/expected_players_test.cpp` (task 1) |
| `315803f` | host: `tellExpectedPlayers` (link, map_loaded, players added), `notePlayersAdded` (no reboot), sim accepts the message, `test/party-carryover.js`, `game-link-v0.md` row (tasks 1-3) |
| `43b1565` | site: `assignments.addPlayer` + `freshToken`, v2 list nonce carries players, `parties.switchMap/switchNow/cancelSwitch/maybeSwitch`, routes, rail confirm + pending card, `web/test/party-carryover.js` (tasks 2-3) |
| `947156b` | launcher: follow-gate's one "end our game" case (`switched_from`), pending-map pre-download + report, 5 tests (tasks 2-3) |
| `e4b53a6` | site: a party survives Quit, a superseded game's late result, a ghost reap and a stale rail's create (task 4) |
| (this commit) | docs: this file, `dedi.md` §30, dated sections in `host.md`, `web.md`, `launcher.md` |

## Test output (last lines)

```
g++ -std=c++17 -O1 -o /tmp/ep server/tests/expected_players_test.cpp && /tmp/ep
  expected_players_test: 42 passed, 0 failed
cd web && node test/party-carryover.js           21 passed, 0 failed
cd web && node test/run-all.js                   154 passed, 0 failed
cd web && (every other file in npm run check)    as on the base commit; launcher-signin.js 14 passed, 1 failed
                                                 (fails on the base too: "steam mode really is on", 500 !== 302)
cd launcher && node test/run-all.js              193 passed, 5 failed  (the same 5 fail on the base commit:
                                                 isInside, removing our folder, maps install under LocalAppData,
                                                 client DLL repair, read-back never persists; "an in-game change
                                                 is read back" flakes 1 in 3 on the base as well)
cd infra/host-agent && npm test                  113 passed / 22 passed / telemetry 81 passed, 0 failed
cd infra/host-agent && node test/party-carryover.js   PASS
cd web/client && npx vite build                  built, exit 0
```

Because `npm run check` chains with `&&`, the base commit's `launcher-signin.js` failure stops `npm test`
before the later files; each file was run on its own.

## Engine addresses and offsets used

| Address / offset | Use | Status |
|---|---|---|
| `0x52E910` bytes `A1 48 83 05 03` | getnumexpectedplayers entry, byte-checked, jmp written here | [V] (brief) |
| `0x52E995` | shared tail the stub jumps to (push esi return, needs ebx == 1, pop esi; pop ebx; ret) | [V] (brief) |
| `0x2547090`, stride `0x58D30`, `state` +0 | svs.clients, "connecting" = state > 1 | [V] (brief, bots.cpp) |
| `0x176C6F0`, stride `0x378`; +0x180 client, +0x1C8 health | g_entities reads for the rescue | as `solo_parity.cpp` |
| gclient +0x4 pm_type, +0x20 origin, +0x2C velocity, +0x88 groundEntityNum | reads for the rescue | as `solo_parity.cpp` (reads proven by its logs) |
| gclient **+0x20 origin, +0x2C velocity — WRITE** | the rescue's move | **[unverified]** |

The stub's calling assumptions (`answer` is `__cdecl`, preserves ebx/esi/edi/ebp; nothing else in the
builtin's frame is needed at `0x52E995` beyond ebx = 1 and the two pushes) are from the brief, not checked
against the dump here.

## Could not run or decide

- **Build and MSVC:** neither DLL was compiled. Both .cpp files were syntax-checked with host clang
  (`-fms-extensions -fasm-blocks`, a stub `windows.h`); the naked stub's asm was not assembled for x86.
- **The rescue's write** (above), and whether the client needs a teleport bit to take the jump cleanly.
- **Rescue choices made here, not in the brief:** "on nothing at spawn" also needs the player still on nothing
  500 ms later (`kOnNothingGraceMs`; 0 = the brief's literal rule); one attempt per spawn; newest valid crumb.
- **Window heuristic:** the 90 s counts from the first `getnumexpectedplayers` poll or the lease message; a poll
  after a > 5 s gap post round 1 is taken as a `map_restart`. If a map's script calls the builtin mid-game after
  such a gap it would see the lease count for up to 90 s. Unknown whether any map does.
- **Switch timing:** `SWITCH_SILENCE_MS = 30 s` is my default for "a launcher that said nothing" (an old
  launcher never reports the pending map). B may want another number.
- **Suspected, not proven:** a stale rail (`party` null while the server's party is in-game) makes `/party/create`
  return the party, then `/party/ready-check` (no state check) and a solo launch supersede its own running game.
- **Not touched:** the referee's `late_join` marking (brief: leave it).
- **Real runs:** no World at War, no two clients, no box, no live site, no Electron.

## Local (the brief's §7, for the local session / B)

1. Check `0x52E910` / `0x52E995` stub assumptions and the gclient +0x20 / +0x2C write against the dump.
2. `tools/dev/build.ps1` (clean detached worktree); run `server/tests/expected_players_test.cpp` under MSVC.
3. Two-client tests (`tools/dev/jointest*.ps1`) on Nacht and Hijacked: round 1 waits for player 2
   (`expected_players: lease 2, connecting 1 -> 2` in the DLL log); a party joiner mid-game gets in and lands on
   the floor (`spawn_rescue:` line on Hijacked); a map switch moves both clients.
4. B's go: box DLL + host agent deploy, site restart, a launcher publish by the recipe, merge to `main`.
5. A real game with a friend on Hijacked.
