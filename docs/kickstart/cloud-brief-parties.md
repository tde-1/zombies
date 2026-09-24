# Cloud brief: parties that carry over between games (2026-09-24)

Written by the local session on B's PC for a **cloud session** to implement. B's pronouns are she/her.
You write the code and tests and run everything that runs without Windows, the game or the box. The
local session then does the Windows-only steps (§7). **Do not guess past a step you cannot run:
write it down in the hand-back (§6).**

## 0. Read first (cheap)

- `CLAUDE.md` (repo root) and `docs/kickstart/README.md`: hard rules. Never read
  `docs/kickstart/board.md` or anything under `docs/kickstart/history/`. Lane docs are huge: `grep -n '^## '`
  them and read only the spans you need.
- `docs/kickstart/dedi.md` §29 (the bottom of the file): the diagnosis behind task 1.
- Work on a branch `cloud/party-carryover`. Keep commits small, one task per commit or more. Push the branch.
  **Never push or merge to `main`.** B merges.

## 1. What you cannot do in the cloud (leave these for §7)

| Can't | Why | What you do instead |
|---|---|---|
| Build the server/client DLL | 32-bit MSVC on Windows, `tools/dev/build.ps1` | Write the C++; put the logic in a header with no engine calls, and unit-test that header with `g++ -std=c++17` (§5) |
| Check engine addresses | The unpacked exe dump (`codwaw-1.7-a.exe`) lives outside the repo | Use only the addresses in this brief, each marked `[V]` from the dump or `[unverified]`; list every one in the hand-back |
| Run World at War, two real clients, the box (`ssh zombies-dev`), the live site DB, the bucket | Windows + Steam + B's keys | Test with the unit suites, `infra/host-agent/sim` and `infra/host-agent/mock-site` |
| Publish a launcher, deploy the box, restart the site, write the Obsidian vault | outward-facing, B's call | List them in the hand-back |

## 2. The bug that started this (B + a friend on BO2 Hijacked, match `m_10ca7b6b`)

Round 1 started as soon as B had loaded, while her friend was still loading. The friend then spawned at
the map origin (0, 0, −4), outside the map. They fell to z −272 under the playable floor, where zombies
can't reach them (so they seemed invincible). The game was also scaled for one player
(`player_damageMultiplier 0.3226`; 2 players = 0.3584).

**Cause (every map, every game with 2+ players):** `_load.gsc all_players_connected()` sets the flag when
`getnumconnectedplayers() == getnumexpectedplayers()`.
- `getnumexpectedplayers` is builtin `0x52E910` [V]. If `onlinegame` (`[0x3058348]`) or `[0x30520E0]` is set,
  it counts **party** members and returns **1** when there is no party. The box runs `onlinegame 1` and has no party.
- `getnumconnectedplayers` is `0x52E9E0` [V]; it counts clients with state 4 and load state 10.

The rest of `0x52E910` [V]: the function pushes `ebx`, `esi` at entry. Every path ends at the shared tail
`0x52E995`. That tail pushes `esi` as the script return value, needs `ebx == 1`, and ends with
`pop esi; pop ebx; ret`. The first 5 bytes at `0x52E910` are `A1 48 83 05 03` (`mov eax,[0x3058348]`).
Client array: `svs.clients` `0x2547090`, stride `0x58D30`, `state` at +0 (0 free … 4 active)
(`server/components/dedicated/bots.cpp:114-123`).

## 3. B's decisions and defaults

- Parties persist across games. Someone joining a party whose leader is in a game **inherits that game**:
  their launcher downloads the map and joins.
- Changing map while a server is running **switches the party's server**, instead of refusing. We close the old
  server and open a new one rather than changing map in place (custom maps need a different `fs_game`, so a
  fresh process is needed anyway; a boot takes about 10 s).
- **Defaults. B may change these, so keep each one a named constant:**
  - A map switch takes everyone straight into the new game.
  - A normal game over returns everyone to the party screen (as today).
  - Round 1 waits up to **90 s** for the players the lease names.

## 4. The tasks, in order

### Task 1: round 1 waits for the whole party (server DLL + host agent)

1. **Pure logic** in `server/components/dedicated/expected_players_rules.hpp`:
   `int expected_players(int lease_n /*0 = unknown*/, int clients_connecting /*state > 1*/, uint32_t ms_since_map_loaded, uint32_t deadline_ms)`.
   - Before the deadline: `max(1, lease_n, clients_connecting)`.
   - After it: `max(1, clients_connecting)`. A no-show then stops blocking, and a client that is mid-load
     still gets waited for, as the stock LAN path does.
   - With `lease_n == 0`: `max(1, clients_connecting)`. That is the stock non-online branch, and already fixes tonight's case.
2. **Component** `server/components/dedicated/expected_players.cpp`, dedicated only. Model it on `solo_parity.cpp` /
   `water_sim_off.cpp` (their byte checks, `ENW_REGISTER_COMPONENT`, logging style).
   - Check the 5 bytes at `0x52E910`. If they don't match, log `NOT patching` and do nothing.
   - Otherwise write a 5-byte `jmp` to a naked stub: `push ebx; push esi; call <C++ fn>; mov esi,eax; mov ebx,1; jmp 0x52E995`.
   - Log each decision once when its value changes: `expected_players: lease 2, connecting 1 -> 2`.
   - Kill switch: `ENW_NO_EXPECTED_PLAYERS=1`.
   - **Do not put a .cpp anywhere under `server/components/` unless it belongs in the DLL:** CMake globs every .cpp there.
3. **Where `lease_n` comes from:** a game-link message from the host, `{ "t": "expected_players", "n": <lease player count> }`.
   - The DLL registers it with `link.on("expected_players", …)` (pattern: `server/components/referee/referee.cpp:291`).
   - The host sends it when the instance links and whenever a lease is handed to a warm instance. Find
     `sendToGame` in `infra/host-agent/host.js`; `host.js:1667` is the warm hand-off.
   - Add a host-agent test in `infra/host-agent/test`.
4. **Late-spawn rescue** (needed by task 2, because mid-game joiners are late by design).
   - Trigger: a player whose spawn comes **after** round 1 started, **and** (spawn x,y == 0,0, **or** "on nothing" at spawn,
     **or** more than 128 units below the spawn point within 3 s).
   - Action: move them to a spot a living teammate stood on (on world) at least 1 s ago and at least 40 units from every player now.
     Keep a small breadcrumb ring per player. Zero their velocity.
   - `solo_parity.cpp` already reads spawn position, ground entity and health per player. Reuse its reads, not new addresses.
   - Writing the origin needs a player-state field this brief does not give you. Write it, mark the offset
     `[unverified]` in code and hand-back, and put the selection logic in the rules header with tests.
   - Kill switch: `ENW_NO_SPAWN_RESCUE=1`.

### Task 2: joining a party mid-game puts you in the host's game (site + launcher)

What's there today:
- `web/server/lib/parties.js:140 join()` adds the member.
- `launchInfo()` (`parties.js:339`) gives them `token: null`, because tokens are minted only at lease time (`assignments.js:222-224`).
- The joiner's launcher already tries to follow the game: `launcher/src/main/followgate.js`, `main.js:1708 onPlay`.
- The box then refuses them for lack of a token.
- The box admits **any site-signed token for (steamid, match)**, with no box-side list (`infra/host-agent/lib/tokens.js:96`).

To do:
1. `assignments.addPlayer(matchId, { steamid, name }, by)` in `web/server/lib/assignments.js`.
   - Only for a lease in `leased|booting|ready|live`.
   - Refuse beyond 4 players ("the game is full; you'll be in the next one"); the member **stays in the party**.
   - Mint a token (`tokens.issue`), and update the row's players / whitelist / `tokens_json`.
2. Call it from `parties.join()` when the party has a live `match_id`. Tell the party (`tellParty`, kind `joined_game`).
3. **Trap to check before you write this:** how the host detects "assignment changed" (`host.js`, `lib/siteclient.js`, the lease
   `nonce`). Adding a player must **not** make the host treat the lease as new and reboot the game. If the host keys
   on the whole assignment object, keep the player list out of that key, or add an explicit "players added" path.
4. The referee already marks late joiners `late_join` (no records). Leave that alone.
5. Tests:
   - web: join a party whose lease is `live` → the joiner gets a token, and the host-visible lease is unchanged apart from players.
   - Fifth player → refused politely and still in the party.
   - launcher: follow-gate test for a joiner.

### Task 3: changing map while a server is running switches the party's server (site + launcher)

What's there today: `web/client/src/rail.jsx:296` throws "End the game to change the map".
`parties.setMap()` (`parties.js:192`) has no state check. `assignments.lease()` rule 1 already supersedes the
party's own earlier game (`assignments.js:227`).

1. **Site.** Add `parties.switchMap(steamId, mapKey)` (leader only), which stores `pending_map_key` on the party.
   The game keeps going. Add the column the way the schema already migrates; find it in `web/server/db*.js`.
   - `/api/launcher/play` and the party projection expose `pending_map`.
   - Members' launchers pre-download it and report progress (`parties.reportProgress`).
   - When nobody is still downloading, or the leader presses **Switch now**, the site does `setMap(pending)` + everyone ready +
     `launch({ force: true })`, marking the new match `switched_from: <old match>`. The old lease is superseded by rule 1.
2. **Rail.** Replace the throw at `rail.jsx:296`.
   - Confirm: "Switch everyone to X? This game ends when everyone has the map."
   - While the switch is pending, show "Switching to X · waiting for …" with **Switch now** and **Cancel**. Terse copy, B's style.
3. **Launcher.** `followgate.decide()` refuses while our game is alive. Add one case: the site's match is a
   `switched_from` our running game's match → end **our** game by pid (the `endGame` path, `main.js:1614`), then follow.
   - Never end a game for any other reason.
   - Tests next to the existing follow-gate tests (`launcher/test/run-all.js`).
4. **Host.** Check in `infra/host-agent/sim` that a superseded live lease shuts down cleanly and the new one boots. Add a sim test if none covers it.

### Task 4: find where parties break up

On the site a party survives a game: it goes back to `forming`. The places that do this are
`assignments.js:114,329,340,373`, `results.js:501`, `seats.js:188`, `boxes.js:101`. Yet B sees parties
break up. B hasn't said when.
- Audit every caller of `/api/party/leave`, `parties.leave`, `kick`, and `/api/party/create` (`rail.jsx:243`, `rail.jsx:292`, launcher sign-out/quit).
- Also check `create()` returning the **existing** party and silently ignoring the new `mapKey` (`parties.js:120-122`).
- Write tests that a party keeps its members, leader and settings through: game over, × (close server), in-game
  Quit, a new launch, a map switch, and a site restart.
- Fix what the tests expose. List anything you suspect but can't prove in the hand-back. Don't guess fixes.

## 5. How to test here

```bash
cd web && npm test                       # a 33991 port flake: rerun that test alone
cd launcher && node test/run-all.js      # read the whole output, not the last line
cd infra/host-agent && node test/run-all.js
g++ -std=c++17 -O1 -o /tmp/ep server/tests/expected_players_test.cpp && /tmp/ep
```

Put C++ tests in `server/tests/`, never under `server/components/`. Match `server/tests/solo_parity_test.cpp`,
including its header comment with the MSVC build line. The tests must compile without Windows headers.

## 6. Hand-back

End by writing `docs/kickstart/cloud-handback-parties.md` (short, pointers not pastes):
- the branch, and each commit with one line
- the last lines of each test suite's output
- every engine address and offset you used, marked `[V]` (from this brief) or `[unverified]`
- anything you could not run or decide.

Add one dated section at the bottom of each lane doc you touched (`dedi.md`, `web.md`, `launcher.md`).
Do not edit the top table of `next-session.md`; the local session does that.

## 7. Final steps (local session / B, after the cloud branch)

1. Check every `[unverified]` offset against the dump, and the `0x52E910` stub bytes.
2. Build the DLLs (`tools/dev/build.ps1`). Run the MSVC unit tests.
3. Local two-client test (`tools/dev/jointest*.ps1`) on Nacht and Hijacked:
   - round 1 waits for player 2
   - a joiner who joins the party mid-game gets in and lands on the floor
   - a map switch moves both clients.
4. B's go: deploy the box DLL + host agent, restart the site, publish a launcher (the recipe in `next-session.md`), merge to `main`.
5. A real game with a friend on Hijacked.
