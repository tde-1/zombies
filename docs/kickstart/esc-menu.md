# The ENW Esc menu

> **Status: BUILT on branch `esc-menu`, 2026-09-23 ~00:50–01:40 UK. Not merged, not shipped.**
> **Superseded 2026-09-23 03:30 (handoff): merged to main (`c72190f`), shipped in launcher 0.2.17, the
> box runs `restart_request` since `c0986e5e` (now `6b1ccfc5`), and the site's `POST /api/party/quit`
> exists (`web/server/routes/site.js`, `web.md` "Quit vs crash"). §8's bullets about the missing route
> are history; the rest of §8 is still unproven.**
> Esc in a box game opens ours instead of World at War's. §7 is what was run and what it showed;
> §8 is what is not proven. The chat overlay's own doc (`chat-overlay.md`) is the base this
> stands on: the draw hook, the input gate, the chat pass and the pause contract are all its.

B's ask, in his words: *"Replace the escape menu with our custom menu: a Resume button, a Restart
game button that tells the dedicated server to restart the game, an Exit game button, the chat, and
invites from your friends and friends online with what maps they're on."*

And, added while it was being built: *"When you exit the game through the escape menu it needs to
close the game AND cancel the server, so the launcher doesn't keep booting you back into the game.
If you close by clicking Quit on purpose, it closes. If the game crashes or you Alt+F4, it should
be resumable from the server card in the launcher."* That is §5.

![the menu, 1280x720 windowed](ui/esc-menu-open-1280x720.jpg)

---

## 1. What it is, file by file

| File | Lane | What |
|---|---|---|
| `client-dll/components/pause_menu.cpp` + `.hpp` | client | **All of the menu.** Esc interception, the three buttons, the friends/invites panel, its site calls, the restart request, the exit sequence, the selftest. |
| `client-dll/components/chat_overlay.cpp` | client | **Nine hook lines, each marked `[esc-menu]`**, plus a 25-line `chat_embed` block at the end: the overlay calls `pause_menu::filter()` first and `pause_menu::draw()` first, reports `paused` while the menu is up, and can draw its panel at an anchor the menu chooses. Nothing else of it changed. |
| `server/components/dedicated/restart_request.cpp` | dedi | The server half of Restart: reads `enw_req` from userinfo, forwards to the host, or restarts a solo game itself when there is no host. |
| `infra/host-agent/lib/restart.js` + 6 lines in `host.js` | host | Who may restart, ending the run as abandoned, and the successor run on the same lease. |
| `web/server/routes/gamemenu.js` + 2 lines in `index.js` | web | `/api/game-chat/menu/*`: friends online, invites, Invite / Accept / Decline, behind the chat pass. |
| `web/server/lib/results.js` (+14 lines) | web | A restarted run attaches to its lease; an abandoned-by-restart run does not close the lease. |
| `web/test/game-menu.js`, `infra/host-agent/test/restart.js` | — | 9/0 and 12/0. `game-menu.js --serve <port>` is the private site the in-game runs used. |
| `tools/dev/authhost.mjs --restart` | dev | The dev link host answers `restart_request` like the real one, for the local d2+c1 round trip. |

**Why the menu has no hook of its own.** `input_gate.hpp` allows exactly one filter and README
hard rule 9 allows one detour per address. Both belong to the chat overlay. The menu is called from
inside them, first. The overlay lane was editing `chat_overlay.cpp`/`input_gate` in parallel, so
every line added there is marked `[esc-menu]` and the merge is those lines and nothing else.

## 2. Esc, and the stock menu never appearing

The key is taken in the game window's WndProc, through the gate, **before the engine's WndProc
(0x606BE0) sees the `WM_KEYDOWN`**. So the engine's menu stack never runs: nothing is opened and
closed, and nothing is drawn under ours. The `WM_CHAR 0x1B` that `TranslateMessage` makes from the
same key is eaten too.

It opens only when all of these hold:

* CG drew in the last 500 ms (we are in a map), `clc.state >= 9`;
* `keyCatchers & 0x31 == 0` — no console, no engine menu, no stock "Say:" field;
* the chat is not open on its own (then Esc is the chat's, and closes it);
* **a box game**: `clc.serverAddress.type` (`0x300FFF8`, `t4-sp-map.md`) is not `NA_LOOPBACK`.
  A Play Local game is its own listen server on loopback and keeps World at War's menu, as the brief
  asked. `ENW_ESC_MENU=all` takes ours there too (that is how the capture runs below were done:
  no second process needed); `ENW_ESC_MENU=0` turns it off. `ENW_CHAT_OVERLAY=0` turns it off
  as well, because the overlay carries it.

Esc again, or Resume, closes it. If the map goes away under an open menu (disconnect, a load, the
overlay switching itself off after draw faults), the menu closes itself after 1 s so `enw_ui`
can never be left at `paused`.

## 3. Restart game — the contract

**Client.** Two clicks (the second within 4 s: "Click again to restart"). Then `setu enw_req
restart.<n>` and the menu closes. **Userinfo, not a client command**: the stock game prints
"Unknown cmd" on the player's HUD for one (`chat-overlay.md` §9.5), and userinfo is the channel the
pause contract already proved arrives mid-game. The menu closing sends `enw_ui clear` in the same
frame, so a solo game is running again when the server acts.

**Dedicated DLL** (`restart_request.cpp`). Polls `svs.clients[i].userinfo` (through
`referee::client`) at 10 Hz. **Acts on a change only**: the value a client connects with is a
baseline, so a key left from an earlier game cannot restart anything. One restart per 15 s.

* **Host link up** → `{"t":"restart_request","ms","slot","name","req","players","level_time"}` to
  the host, and nothing else. The DLL cannot know who is verified; the host decides. A map_restart
  the host did not order would carry one run's clock into the next, so the DLL never does one here.
* **No link** (a bare dev server: no referee, no replay, no record) → solo: `map_restart` once
  `sv_paused` is 0 (the pause gate has let go; up to 5 s, else refused). Co-op: refused.
* Either way it logs that the map restarted — the connected clients drop back into the connect
  handshake — or that nothing happened within 15 s. **Not `level.time`: it keeps counting across a
  `map_restart` on this engine** (measured in `escmenu1`: 27650 at the request, 43000 fifteen
  seconds later; the first build watched it and wrongly reported "no restart").

**Host** (`lib/restart.js`).

1. **Who**: the slot's `identity` is `verified`, **or** only one player is connected. Anybody else:
   `restart_refused` goes into the replay and nothing happens.
2. The run is flagged `abandoned` + `player_restart` and the referee's own **`end`** is sent:
   `{"t":"end","reason":"player_restart","match":"<lease>"}`. The DLL's `do_end`
   (`referee.md` §10.3) reports **first** — `game_over` with its player rows, reason
   `player_restart`, then `match_end` — and only then queues `map_restart`, resets (per-match jti
   set, name locks, round 0, recording on) and re-announces `map_loaded`.
3. `game_over` ends this run exactly as any game over does: replay closed and signed with the
   game's final word in it, result posted with `end_reason: "player_restart"`.
4. At `match_end`, synchronously, the socket goes to a **successor run on the same instance and
   the same lease with its own id `<lease>.r<n>`** — a new replay file and a new result row. Its
   summary carries `lease_match_id`, `run_of_lease`, `restart_of`. It must be synchronous: the
   `end` reply, the new `map_loaded` and the players' fresh `player_connect`s are in the same TCP
   read and must not reach a finished run.
5. **The players never left.** Their tokens were spent on the first run (TokenGuard is single-use
   per boot), so each player the abandoned run **verified** is re-admitted **once** on the new run
   after a full signature / lease / steamid check with only the single-use set bypassed. Nobody else
   gains anything.
6. Failures end in a signed run and a torn-down instance: no `match_end` within 10 s → the run is
   finished from the host's own fold and the ordinary disposition runs (a game that said nothing
   is never reused); `end` refused, or no `map_loaded` within 60 s → the instance is retired.

**Site** (`results.js`). A result whose `match_id` is `<lease>.r<n>` and names `lease_match_id` is
attached to that lease's assignment (party, settings) — only when the posting box holds the lease.
A result with `end_reason: "player_restart"` does **not** close the assignment: the lease and the
party's `in-game` state go on under the next run. Without this the first result would free the box
and send the party back to forming under a game that is still being played.

**Records.** The abandoned run keeps whatever it reached — a round-12 run that was restarted
reached round 12 — and it is flagged `abandoned`. The new run starts at round 0 with its own clock,
its own replay and its own id. Nothing is merged, nothing is erased.

**Also changed for it**: `onAssignment` compares `leaseId || matchId`, so the site re-sending the
same lease does not read a restarted run as a stale instance to retire.

## 4. Friends and invites

`GET /api/game-chat/menu/state` when the menu opens and every 10 s while it is open (never while
it is closed), over the chat's own site and pass. It is **the rail's own server code** —
`roster.forViewer` (Online for an approved account, Friends otherwise, decided by the site),
`parties.invitesFor` — behind the chat pass instead of the session. Each row: a coloured pip (red in
a game, gold in a lobby, green online), the name, one line of where (`In game: Der Riese`,
`Lobby: Verruckt (1/4)`, `Online`), and **Invite** / **Accept** / `IN PARTY` / `INVITED`.
Invites to me are listed first with **Accept** and **x** (decline).

* **Invite** = `parties.invite` (the rail's `requireApproved`, applied to the pass's account).
* **Accept** = the rail's Accept: `parties.join` into the inviter's party.
* **What Accept does NOT do: connect you anywhere.** The launcher's party watcher follows a match
  for the party you are in **only when no game is running** (`main.js onPlay`, the `state.flow`
  guard). So the menu says exactly that: *"Accepted mule_kicker's invite. Exit the game and the
  launcher takes you there."*
* **Known gap (site lane):** inviting somebody into a party that is already in a game puts them in
  the party, but their launcher gets no invite token for the running lease (tokens are minted per
  whitelisted SteamID at lease time), so there is nothing for it to follow until the next Start.
  Late join is not this lane's to design.

## 5. Exit game — quit vs crash (the contract, for the site lane)

B: quitting on purpose must **end** the game and stop the launcher booting you back in; a crash or
Alt+F4 must leave the game **resumable** from the server card.

**What the launcher does today** (`launcher/src/main/main.js`, read, not changed): the party watcher
polls `/api/launcher/play` at 1 Hz whenever a site is connected, and when the game process exits
(`flow` ends, `state.flow = null`) the very next poll that still shows a `match` for your party in
`reserving|loading|ready|in-game` calls `startPlay({ follow: true })` — **it boots you straight back
into the same game.** Nothing distinguishes a quit from a crash today. So the distinction has to be
made on the site, before the process exits:

**Client (built):** Exit game (two clicks) →

1. `POST <site>/api/party/quit` with `Authorization: Bearer <chat pass>`, body
   `{"match_id": "<the invite token's m>", "reason": "esc_menu_exit"}`, **2 s cap**;
2. whatever the answer: `disconnect`, then `quit` 400 ms later. The process exits; the launcher
   sees the game end as it always has.

A crash or Alt+F4 sends nothing. **The absence of the call is the signal.**

**Site (NOT built — the site lane owns `parties.js`/`assignments.js`):** `POST /api/party/quit` *(built
the same night, `9d27958`, `lib/seats.js` + `routes/site.js`; `web.md` "Quit vs crash")*

* **auth**: accept the chat pass (`gameChat.verifyPass`), because the game holds nothing else; it
  must be reachable past the beta gate for a Bearer request (like `/api/game-chat`), or live under
  that prefix. Session auth too, for a site button later.
* `match_id` optional; if given and it is not the player's current lease, answer 200 with
  `{ok:true, stale:true}` and change nothing (a quit from an old game must not end a new one).
* **solo** (the player is the only member of the party on that lease): cancel the lease
  (`assignments` → ended, the box told to retire the instance, which ends the run on the host as
  it does for any teardown) and dissolve the party (or return it to `forming`).
* **party**: this player leaves the party (`parties.leave`); the lease and the game go on for the
  others.
* Then `/api/launcher/play` for this player shows no match, so the watcher has nothing to follow.
* Answer fast (the client waits at most 2 s, then quits anyway — and a quit whose call did not land
  is then indistinguishable from a crash, which is the safe direction: resumable, not lost).

The in-game runs below used a **stub** of this route on the private site (`web/test/game-menu.js
--serve`), which only logs the call.

## 6. The pause contract

While the menu is open the overlay reports `enw_ui paused` (menu wins over typing:
`report_ui_state`'s one changed line), exactly what the stock Esc menu reported. So a solo game
freezes (`pause.cpp`, `solo_menu`) and co-op freezes only when every player is in a menu. The menu's
subtitle says *"Co-op: the game pauses when everyone is in the menu"* when the site says your party
has more than one member, as `chat-overlay.md` §8 asks, since the client cannot see the others'
state.

## 7. Evidence

Every run: `nazi_zombie_prototype`, off-screen at -4000,-4000, `ENW_TEST_NO_ACTIVATE=1`,
`ENW_BORDERLESS_COVER=0`, a private site on **3399** (`node web/test/game-menu.js --serve 3399`:
temp DB, invented accounts `menu_tester`, `staminup`, `deadshot`, `juggernog`, `mule_kicker`,
`quickrevive`; `web/data` and 3200 untouched; stopped afterwards). Pictures are the back buffer
(`frame_capture.cpp`) at the instant named, converted to JPG.

| lock held | run | what it showed |
|---|---|---|
| 01:18:00–01:18:58 | `c2`, Play Local, **1280x720 windowed**, `ENW_ESC_MENU=all`, selftest 1 | Esc → `pause_menu: OPEN (Esc) -- the stock pause menu never saw the key` (keyCatchers 0x0: no engine menu), `enw_ui paused`; friends panel 4 online + the invite; Accept → HTTP 200 and "Accepted mule_kicker's invite. Exit the game and the launcher takes you there."; "gl everyone" typed into the embedded chat; Restart's first click → "Click again to restart"; Esc → CLOSED, `enw_ui clear`, the game with no menu over it |
| 01:23:13–01:24:55 | **`jointest escmenu1`**: local dedicated server `host2` + client `c2`, link to `authhost.mjs --restart`, invite token for `m_escmenu1` | **No `ENW_ESC_MENU=all`: the menu opened because the address type was 4 (a real server).** Menu open → server `pause: PAUSED (solo_menu)`, close → `RESUMED ... level.time held`. Restart (two clicks) → client `enw_req restart.1` → server `restart_request: slot 0 ('menu_tester') asked to restart` → host `RESTART REQUEST ... ACCEPTED` → `end {reason:player_restart, match:m_escmenu1}` → `game_over` (reason `player_restart`, the verified row) → `match_end` → `reply ok` → `map_restart` → `map_loaded` → the client re-entered, `player_connect` → re-admitted (`was verified before the restart`) → `identity VERIFIED` → `round 1` again. One defect: the DLL's own "did it restart" check watched `level.time` and said no (§3); fixed |
| 01:25:47–01:26:45 | `c2` borderless 2560x1440 | **harness fault, no picture**: the environment still held the join test's `ENW_CLIENT_CONNECT`, so the client dialled a server that was gone and never reached a map. The capture script now clears those variables |
| 01:28:49–01:29:47 | `c2`, **borderless 2560x1440** (client 2560x1440, placement 3.0) | the same menu at B's size; Invite deadshot → "Invited deadshot", the row turns INVITED; the restart confirm |
| 01:31:51–01:33:33 | **`jointest escmenu2` against the REAL host agent** (`infra/host-agent/host.js --local`, no site, the instance registered as `m_escmenu2`), fixed DLL | `restart_request ACCEPTED from slot 0 (alone, 1 connected): run m_escmenu2 ends as abandoned` → `game over: player_restart` → `match_end` → **`restart: run m_escmenu2 closed; run m_escmenu2.r2 (lease m_escmenu2, run 2) takes the link`** → first replay closed, `SUMMARY ... flags=[paused,abandoned,player_restart,self_reported]` → `map back; run m_escmenu2.r2 is recording` → a second replay file `m_escmenu2.r2.enwr` → the player admitted into run 2. DLL: `the map restarted 688 ms after the request went to the host`. `tools/verify.js m_escmenu2.enwr`: **VALID** (475 events, footer signed). Picture: the player back in the map, round 1, 500 points, 30 s after the start |
| 01:33:37–01:33:52 | `c2` 1280x720, selftest 3 (**Exit game, for real**) | two clicks → `POST /api/party/quit -> 200` (the stub logged `from 76561198000000201 body={"reason":"esc_menu_exit"}`) → `disconnect sent` → `quit` 400 ms later → the process ended on its own 13 s after launch |

Nothing else held the lock for this lane. Every run was started only after 4 s with no `CoDWaW.exe`
and no `game.lock` (another agent was running join tests on `d2`/`c1` all through; one of this
lane's starts lost that race at 01:30:06, was refused by `deploy.ps1` before taking anything, and
was re-queued).

Tests: `web/test/game-menu.js` **9/0**, `infra/host-agent/test/restart.js` **12/0**; unchanged:
web `run-all` 121/0, `game-chat` 19/0, host `run-all` 61/0.

Pictures (`ui/`): `esc-menu-open-1280x720`, `-hover-accept-1280x720`,
`-confirm-restart-accepted-1280x720`, `-resumed-1280x720`, `-confirm-exit-1280x720`,
`-open-2560x1440-borderless`, `-confirm-restart-invited-2560x1440-borderless`, and from the real
server join: `-box-game-accepted-800x600`, `-box-game-confirm-restart-800x600`,
`-box-game-back-in-map-after-restart-800x600`. (The 1280x720 and 2560x1440 pictures are from the
build before the 4:3 layout fix and the restart-detection fix; neither changes a 16:9 frame.)

![2560x1440 borderless](ui/esc-menu-confirm-restart-invited-2560x1440-borderless.jpg)
![a real dedicated server, after Accept](ui/esc-menu-box-game-accepted-800x600.jpg)

## 8. Not proven

* **B's own hand.** Esc, move onto Invite and click, type in the chat, Restart twice, Esc; and a
  real Exit game. Every click here was posted into the game's own queue.
* **On the box, through the site.** The restart was proven against a local dedicated server with
  the real host agent in local mode (no site, no key, identity `claimed`) and with the dev link host
  (real token check, identity `verified`, carried across the restart). Not on the Hetzner box, not
  with the site ingesting two results for one lease: `results.js`'s two changes are read, not run.
  A fake-ID lease on the box was not attempted: a real game was live there tonight.
* **Co-op restart** (a second, unverified player refused; two verified players both carried): unit
  tests only.
* ~~**The quit route does not exist on the site yet** (§5).~~ It does since `9d27958` (handoff note). Until it does, Exit game quits after a
  404 and the launcher's watcher will boot the player straight back into a live lease — exactly
  B's complaint — so §5 is the site lane's next job.
* **The restarted run's site-side life**: presence, live frames and the box heartbeat carry the
  run id `<lease>.r<n>`, which nothing on the site has seen before. Read as harmless, not run.
* **Accept into a party already in a game** leaves the invitee with nothing to follow (§4).
* Exclusive fullscreen: not looked at (as for the overlay, `chat-overlay.md` §9.8).
* The second run's replay (`m_escmenu2.r2.enwr`) was not closed: the harness killed the host with
  the game. The first run's is signed and verifies.
