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

---

## 9. 2026-09-23 ~04:00–06:00 — the Settings tab (branch `worktree-agent-ab4af766591d2bb5c`, not merged)

B: *the Esc menu needs a SETTINGS tab that carries every setting the ENW Movement client offers,
plus World at War's own video/audio/control settings, all through our menu, and it must sync
perfectly.*

### 9.1 What it is

A fourth button, **Settings**, under Resume. It swaps the right side of the menu (friends and the
chat panel) for a settings panel drawn with the menu's own engine calls and the stock WaW font
(`stock_font::pick`, chat-overlay.md §12). **The tabs, groups, names and values are the site's
`/settings`**: Display, Graphics, Audio, Controls, Game. Toggles click, lists have `<` `>`, sliders
click/drag, a bind row captures the next key or mouse button (Esc cancels, Delete or right-click
clears; with two keys already both are released, as WaW's Controls menu does). Changes apply at
once; the foot of the panel says what happened, or the hint / reason for the row under the pointer.
Esc goes back to the friends view; Esc again resumes.

| File | What |
|---|---|
| `web/client/src/data/wawSettings.js` | **`INGAME`**: per catalogue item, `apply` (`live`, `vid_restart`, `next_launch`, `site`, `false` = never in game, with why) and `verified` (still shown in a Verified game). The one place policy lives. |
| `tools/settings/gen-ingame-schema.mjs` → `shared/settings/ingame-settings.json` | The catalogue + `settingsLayout.js` + `INGAME`, joined. CMake embeds it into the DLL as bytes. **The DLL has no list of its own.** |
| `client-dll/components/settings_model.hpp` | Pure model: load, forbidden dvars, visibility, the console text a change becomes, sliders/lists/binds. |
| `client-dll/components/settings_tab.cpp` + `.hpp` | The panel, the engine reads/writes, the write-through check, Apply. |
| `client-dll/components/pause_menu.cpp` | The button and the view; lines marked `[settings]`. The menu is not auto-closed while the tab's `vid_restart` runs. Selftests `ENW_ESC_MENU_SELFTEST=5` (drive it) / `=6` (read after relaunch). |
| `mouse_polling.cpp`, `stock_font.cpp`, `frame_capture.cpp` | Survive `vid_restart` (§9.4). |
| `launcher/src/main/wawcfg.js`, `launch.js` | Raw input in the config round trip; the read-back commits its snapshot; a catch-up read-back before each launch's merge (§9.3). |
| `tools/dev/settings-proof.ps1`, `settings-roundtrip.mjs` | The proof harness (§9.5). |

### 9.2 The list, and the dvar behind each row

81 items (every catalogue item that `/settings` places, minus two). Engine reads use the engine's
own `Dvar_ValueToString` (`0x5ECAB0`, ECX = dvar, the 16-byte value by value; the console's dvar
hint calls it for current `+0x10`, latched `+0x20` and reset `+0x30`; byte-checked).

| Tab / group | Rows (dvar) | apply | Verified |
|---|---|---|---|
| Display / screen | display mode (`r_fullscreen` + the DLL's borderless, read-only), monitor (`r_monitor`, read-only), resolution (`r_mode`, read-only when borderless), refresh rate (`r_displayRefresh`), aspect ratio (`r_aspectRatio`) | site / vid_restart | resolution, refresh, aspect hidden |
| Display / picture | field of view (`cg_fov` 65–120), brightness (`r_gamma` 0.5–3), max fps (`com_maxfps` 60/85/125/250), vsync (`r_vsync`), show fps (`cg_drawFPS` Off/Simple) | live; vsync vid_restart | max fps and vsync hidden (records rule: com_maxfps unchanged mid-game) |
| Graphics / quality | anti-aliasing (`r_aaSamples`), shadows (`sm_enable`), specular (`r_specular`), glow (`r_glow_allowed`), depth of field (`r_dof_enable`), dual video cards (`r_multiGpu`) | live; AA, multiGpu vid_restart | all hidden |
| Graphics / world | bullet impacts (`fx_marks`), dynamic foliage, ocean simulation (`r_gfxopt_*`) | live | hidden |
| Graphics / textures | anisotropy (`r_texFilterAnisoMin`), mipmaps (`r_texFilterMipMode`), texture quality (`r_picmip_manual`), texture/normal/specular detail (`r_picmip`, `_bump`, `_spec`) | aniso, mipmaps live; the rest vid_restart | aniso, mipmaps shown |
| Audio / volume | master, music, effects, voice, cinematics (`snd_menu_master`, `snd_menu_music`, `snd_menu_sfx`, `snd_menu_voice`, `snd_cinematicVolumeScale`, 0–1). **Not `snd_volume`: this exe has no such dvar** (client.md §10b) | live | shown |
| Audio / sound | line of sight occlusion (`snd_losOcclusion`) | live | hidden (hearing through walls) |
| Controls / mouse | sensitivity (`sensitivity` 1–30), invert (`ui_mousePitch` + `m_pitch` ±0.022, as the menu's uiScript), smooth mouse (`m_filter`), free look (`cl_freelook`), raw input (`enw_rawmouse`, ENW's own archived dvar) | live; raw input next launch | shown |
| Controls / move, combat, interact, look | the 41 key rows of WaW's Controls menus (`bind KEY "cmd"`), incl. aim down sights hold (`+speed_throw`) | live | shown |
| Game | mature content (`cg_mature`, + `cg_blood 1` on Unrestricted), subtitles (`cg_subtitles`), hud (`hud_enable`), crosshair (`cg_drawCrosshair`) | live | shown |

**Not in game, on purpose:** `monkeytoy` (mod-owned: a map's anti-cheat quits on it,
mod-compat.md §3) and `ai_corpseCount` (an `ai_` dvar: the server runs the AI in a box game).
`settings::forbidden_dvar` also refuses `con_external`, `sv_cheats`, `developer*`, `cg_fovscale`,
`timescale`, `name`, our userinfo keys and every `ai_ g_ sv_ player_ bg_ perk_ scr_` dvar, whatever
a schema says (a forged schema item is dropped at load; unit-tested). A dvar the running map sets
itself (its `.enw-installed.json` `modDvars.owned`, launcher `modcompat.js`) is shown read-only,
"set by this map".

**Verified game** = the invite token is present (`auth::token()`), or `ENW_SETTINGS_RESTRICTED=1`.
Only `verified: true` rows are drawn at all (sensitivity, invert, volumes, FOV ≤ 120, brightness,
show fps, crosshair, hud, subtitles, mature, anisotropy/mipmaps, raw input, every bind); nothing that
restarts the renderer, not `com_maxfps`.

**What Movement's settings page has, and why none of it is a row here.** Its list
(`CSGO-Matchmaker/movement-client/src/pages/Settings.jsx`, stored per mode in
`server/lib/playerSettings.js`, applied by the game-server plugin): HUD presets per mode, hide
players, sounds, hints, PB alerts, menu on reload, viewmodel FOV (1–120), weapon armed/hidden, name
colour (VIP), distbug/jump analysis, Steam-bot notifications, profile privacy. Every one is a CS:GO
movement-server plugin feature with no World at War equivalent; the nearest, viewmodel FOV, would be
`cg_fovscale`, which the records rules multiply into the FOV cap, so it is refused. **Movement has
no key binds and no mouse settings.** What was reused from it is the *shape*: settings stored as
key/value per account, changed in game, written back so the site shows the in-game value.
**ADS sensitivity multiplier: does not exist in this exe** (no `ads`/`zoom` sensitivity dvar in the
1.7 image; WaW scales ADS by FOV). It would be code in `mouse_polling`, not a setting; not built.

### 9.3 The sync path (the existing round trip, extended — no new channel)

1. **Apply** = the engine's own console text through `Cbuf_AddText`: `seta <dvar> "<v>"` (plus the
   menu script's companion dvars), `bind KEY "cmd"` / `unbind KEY`. Values are one quoted token; `;`,
   quotes and control characters are stripped (unit-tested).
2. **Write-through, by the engine.** `Com_Frame` (`0x59DCF0`) calls `Com_WriteConfiguration`
   (`0x59D8F0`) at the top of every frame; when `dvar_modifiedFlags` (`0x21ACF30`) has the archive bit
   it rewrites `players\profiles\<profile>\config.cfg` (the profile string at `[0x1F55284]`, the one
   `players\active.txt` names) under the redirected LocalAppData — our private profile, never B's
   `Activision\CoDWaW`. `seta` archives. A bind changes no dvar, so the tab raises the archive bit
   two frames after the bind has executed. The tab re-reads the file after every change and logs
   `WRITE-THROUGH: ... N ms after the change`. So a change is on disk within a frame or two: nothing
   is lost to a crash, to Exit game, or to a game over (none of them needs a save step).
3. **The launcher** reads the file after the game exits — crash, kill or quit — with the existing
   `readBackAccount` (client.md §8) and saves the difference to the account, which `/settings`
   shows. Extended: **raw input** travels as `seta enw_rawmouse` (the account block writes it, the
   read-back returns `rawMouse`); the read-back **commits** its snapshot, so the same file is never
   claimed twice; and **before each launch's merge** a catch-up read-back runs, so a change the game
   saved while the launcher was closed or dead is kept and saved, not overwritten by the older
   account value.

### 9.4 vid_restart

Rows marked vid_restart are set as WaW's Graphics menu sets them (the engine latches them; the row
shows the latched value with a gold `*`), and an **Apply (restart video)** button appears. It runs
`vid_restart`, as WaW's Apply does. The engine refuses it under a listen server
(`CL_Vid_Restart_f` `0x6420F0`, "Listen server cannot video restart.", sv_running `[0x1F552DC]`), so
in Play Local those rows say "applies next launch" and there is no Apply. A restart destroys the
window and the D3D device, which broke three things that are fixed here:

* **the input gate** — mouse_polling installed its subclass (and raw input, `hwndTarget`) once, on
  the first window; after a restart the chat overlay and the Esc menu would have had no input at
  all. It now re-installs on the new window.
* **the stock font** — its atlas texture belonged to the old device, and its glyph pointers to
  zones the restart reloads. It now forgets everything when the device or window changes (and from
  the moment Apply is pressed) and finds the font again; the engine's fonts are used in between.
* **frame_capture** cached the device for the swap chain's Present; it now asks the swap chain.

The menu is **not** closed during the restart (pause_menu's 1 s no-draw rule waits for it), so the
game stays paused and the menu, on the Settings tab, is back with the picture.

### 9.5 Proof

(filled in from the run below)

### 9.6 Not proven

(filled in below)

> **§9.5 note from lane 12 (2026-09-23 12:25):** the Settings tab's **FOV row could not change FOV
> in a box game** — measured, not inferred: `seta cg_fov "100"` answered *"cg_fov is cheat
> protected."* in the client console (`l12a.client.console.log`), because cg_fov carries DVAR_CHEAT
> (flags `0x81`) and a server's `sv_cheats` is 0. Fixed for the tab and the console alike in §10.2.

---

## 10. 2026-09-23 ~11:55–12:30 — lockdown: no stock main menu, no stock console, the ENW console, "Your record has been uploaded" (lane 12, branch `worktree-agent-a3c4fdfc2d163a895`)

B (04:00): *players must never reach World at War's stock main menu or the stock console; our own
restricted console (sensitivity, FOV, harmless dvars only); a chat line "your record has been
uploaded"*; plus lane 8's hand-over: the in-game chat window starts empty until the DLL asks the
feed with `history=1` (that one is `chat-overlay.md` §14).

| File | What |
|---|---|
| `client-dll/components/menu_lockdown.cpp` + `.hpp`, `menu_lockdown_model.hpp` | §10.1. The end screen over the main menu, the silent-server rule, the quit |
| `client-dll/components/restricted_console.cpp` + `.hpp`, `console_model.hpp` | §10.2. The two locks on the stock console, the ENW console, the cg_fov unlock + cap |
| `settings_tab.cpp/.hpp` (`[console]`) | `console_get/set/reset/list/names`: the console writes only through the tab's own `apply_value` |
| `pause_menu.cpp` (`[console]`, 8 lines) | calls the lockdown's input swallow and the console first in its filter and draw, and hands the console its drawing calls |
| `join_retry.cpp` (`[lockdown]`) | binds its SCR_DrawScreenField seam in **every** client process now (was: launcher joins only) and calls `menu_lockdown::draw_over()` last |
| `net_probe_client.cpp` (`[lockdown]`) | exports the time of the last in-band datagram |
| `notice_board.hpp`, `chat_overlay.cpp` (`[notice]`/`[history]`, ~12 lines) | §10.3 and `chat-overlay.md` §14 |
| `web/server/lib/gameChat.js` (`notify`, channel `notice`), `lib/results.js` (`noticeSeated`) | §10.3, the site half |
| `tools/tests/lockdown_test.cpp` (**73/0**), `web/test/record-notice.js` (**7/0**, in `npm run check`) | tests |
| `tools/dev/lockdown-proof.ps1`, `authhost.mjs --result`, `web/test/game-menu.js` `/dev/result` | the local proof harness |

### 10.1 The main menu is never shown

The boot already skips it (`client.md` §10). This is the other end of a session. When a game that
had connected (clc.state ≥ 4 seen) falls back to clc.state 2/0 — the menu — **our cover is drawn
from its first frame**: a full-screen black pic after `SCR_DrawScreenField` (the call that draws the
main menu, the console and the connect screen; `join_retry.cpp` owns that call site and calls
`draw_over()` last, so the cover is on top of everything the engine drew). After 1.5 s at the menu
(a map change passes through the same state for a frame or two and must not end a game) it says why
(`com_errorMessage` made readable: *"The server closed the game."*, *"Lost the connection to the
server."*, *"The game has ended."*, …), repeats the site's newest notice (§10.3), counts *"Back to the
launcher in 4"* down and sends `quit`. The launcher is our menu; its follow gate does not boot the
player back in, and a live game stays resumable from the server card (§5). While the screen is up
the menu under it gets no keys and no clicks (`swallow_input`, first in `pause_menu::filter`).
Covers every way to the menu: a kick or error drop, the Esc menu's Exit, Play Local's stock pause
menu *Quit*, a join that never got in.

**The silent server — measured, and the reason there are two triggers.** `l12b`: the server killed
after a game over (what the box does when it retires an instance: no disconnect is sent) left the
client **at clc.state 10 on the black game-over scoreboard for 60 s with `cl_timeout 10`** — this
engine never timed it out. So a map with no in-band datagram from the server for **20 s**
(`net_probe_client`'s recvfrom tap) is a session that has ended too: *"Lost the connection to the
server."*, same countdown, quit. The pause contract keeps snapshots flowing while frozen, and a map
change leaves state 10, so neither trips it.

Armed only where the ENW launcher (or the harness) started the game: `ENW_LOCALAPPDATA` set.
Switches: `ENW_MAIN_MENU=1` (stock behaviour), `ENW_LOCKDOWN_SILENCE_S` (0 = off), `ENW_LOCKDOWN_SHOW_MS`.

### 10.2 The stock console never opens; the ENW console does

**Two locks.** (1) The console key is the key under Esc **by scan code 0x29**, whatever the layout
(on B's UK keyboard it is `` ` ``/¬, not VK_OEM_3): its WM_KEYDOWN/KEYUP/CHAR are consumed first in
`pause_menu::filter`, before the engine's WndProc. (2) Any other way in (Backspace+Home, a
`toggleconsole` bind in a hand-edited config, an engine error) ends in keyCatchers bit 0x1 —
`Con_ToggleConsole` is `keyCatchers ^= 1` and the console is drawn only while it is set (IW3,
KisakCOD `cl_console.cpp`) — so a frame subscriber clears bit 0x1 the frame it is set, and logs it.
`ENW_STOCK_CONSOLE=1` turns both off (developers only). Note: SP's own `monkeytoy 1` also keeps the
stock console shut; the locks matter for every player whose config says `monkeytoy 0`.

**The ENW console** takes the same key, in a map, when no menu or chat is open: one input line, the
last lines of output, WaW's stock font. A line is a setting of the in-game catalogue — the Settings
tab's list, by dvar or catalogue id (`sensitivity 4`, `cg_fov 90`, `fov`, `set`/`seta`,
`list [prefix]`, `reset <x>`, `help`, `clear`, Tab completion, Up/Down history, Ctrl+V). A set runs
`settings_tab::console_set`: the same visibility (Verified game → only `verified` items; mod-owned →
read-only; `settings::forbidden_dvar` → *"sv_cheats is locked."*), the value checked against the
catalogue (slider range, list values, toggles take on/off), then the tab's own `seta` +
write-through. `;`, a second value, and anything that is not a setting are refused; **nothing typed
is ever handed to the engine as a command** (`quit`, `exec`, `bind`, `connect`, `map` … all *"not
available here"*). Binds and video stay in Esc > Settings.

**cg_fov was cheat-protected — found by the first run.** `l12a`: `seta cg_fov "100"` → *"cg_fov is
cheat protected."* (flags `0x81`: archive + DVAR_CHEAT; IW3's `Dvar_SetVariant` refuses an external
set of a cheat dvar while sv_cheats is 0). So neither this console nor the Settings tab's FOV row
could change FOV in a box game. Fixed: `restricted_console.cpp` clears **cg_fov's** 0x80 (never
cg_fovScale's) from its frame tick (again if the engine re-registers it), and because a
hand-edited bind could now set it too, **anything above 120 is set back to 120** (the records cap,
`verified-rules.md` §2.2; T4M and Plutonium unlock cg_fov the same way). A mid-game FOV is still
not reported to the host (`verified-rules.md` §8.5).

### 10.3 "Your record has been uploaded."

How the pieces learn it (`referee.md` §16, `host.md` §14): the dedicated DLL sends `game_over`, the
host finishes the run and POSTs the result to `/api/gs/result`, and the site's `results.ingest`
stores it — the POST's answer *is* the host's confirmation. The client DLL never hears the host
link, and the host's `say` into a game is not delivered to clients (`chat.cpp`'s injection is off,
`chat-overlay.md` §5). So the line goes the one way the game already listens: **the site, at ingest,
puts a private `notice` line in `chat_private` for each seated (verified) player of a box result**
(`gameChat.notify`; first arrival only — a retry is a repeat). Record-eligible Verified game:
*"Your record has been uploaded."*; anything else (Custom, late join, refused Verified run): *"Your
game has been saved. Not record-eligible."* The overlay's long-poll carries it (`kind: system`,
drawn yellow on the HUD and in the Global tab) and posts it to `notice_board`, so the end screen
repeats it if the server goes away before the player reads it. Local runs (not the box path) say
nothing in game; the launcher's own toast covers them.

### 10.4 Proof — local dedicated server + client, invisible, private LocalAppData, under the lock

Harness: `tools\dev\lockdown-proof.ps1` = `jointest.ps1` (`d2` server + `c1` client, off-screen,
`ENW_TEST_NO_ACTIVATE=1`, `ENW_BORDERLESS_COVER=0`, private LocalAppData) with an invite token for
the fake id `76561198000000201` (`authhost.mjs mint`), the link to `authhost.mjs serve --result`, and
the chat pass of a private site (`node web/test/game-menu.js --serve 3399`: temp DB; `web/data` and
3200 untouched). **What is simulated:** `authhost --result` builds the host's summary from the game's
own `game_over` rows and POSTs it to the private site's `/dev/result`, which runs the real
`results.ingest(..., {requireVerifiedIdentity:true})` — the host agent's `finish()` and the box auth
of `/api/gs/result` are not exercised. Everything else is the real DLL, engine, site code and feed.
Logs `ZombiesDev\logs\dedi\l12{a,b,c}.*`. DLL for l12c `89caa50c` (build `lane12`).

| run (lock held) | what it showed |
|---|---|
| `l12a` 12:08:34–12:11:57 | first poll `3 backlog line(s) (history=1) into the window, none on the HUD`; console OPEN on the key under Esc (*"World at War's console never saw the key"*); `sv_cheats 1` / `developer 1` → *locked*; `fov 130` → *takes 65 to 120*; `quit` → *not available here*; `cg_fov 90; sv_cheats 1` → *One setting at a time.*; `com_maxfps 125` → *locked in a Verified game*; **`cg_fov 100` → "cg_fov is cheat protected." (the finding above)**; the idle player dies, `game_over` → `RESULT ... HTTP 200 {"ok":true,"notified":1} (37 ms after game_over)` → client `system line: Your record has been uploaded.` over the long-poll; a timed `disconnect` at +175 s → `clc.state 10 -> 2` → covered from the first frame → *"The game has ended."* → `quit` 5.5 s after the fall, **295 covered frames, the client process ended on its own**. Two harness faults, both fixed: the selftest posted a WM_CHAR as well as the key (a stray `'` typed into the first line, so `sensitivity 7` failed), and with SP's own `monkeytoy 1` the engine-direct console key opened nothing, so the catcher was not exercised |
| `l12b` 12:17:41–12:21:15 | cg_fov unlocked (`flags 0x81 ... DVAR_CHEAT cleared`) → `sensitivity 7` and `cg_fov 100` both set, `engine: cg_fov is '100'`, **WRITE-THROUGH 203 ms** each; with `+set monkeytoy 0` the console key sent **straight to the engine's WndProc** opened the stock console and **`World at War's console was opened (keyCatchers 0x1) -- closed it the same frame`**; `set cg_fov 150` into the command buffer → `cg_fov was 150.0, above the records cap of 120 -- set back to 120`. The record line again. Server ended at +140 s (our PID) → **the client sat at clc.state 10 for 60 s and never timed out** → the silent-server rule |
| `l12c` 12:23:01–12:25:49 | everything in l12b again, plus: the HUD line on the game-over scoreboard (`ui/lockdown-record-uploaded-hud-800x600.jpg`); server ended at +130 s → `the server has sent nothing for 20000 ms while in the map` → end screen *"Lost the connection to the server." / "Your record has been uploaded." / "Back to the launcher in 3"* → `quit` → **the client ended on its own; jointest found both gone and released the lock** |

![the ENW console](ui/lockdown-console-open-800x600.jpg)
![the end screen after the server went away](ui/lockdown-end-screen-lost-800x600.jpg)

Also in `ui/`: `lockdown-end-screen-ended-800x600.jpg` (l12a), `lockdown-cover-800x600.jpg`.
In l12a the HUD capture 1.2 s after the line arrived did not show it; the overlay now starts a
line's HUD clock when the HUD can draw it (`chat-overlay.md` §14) and l12c shows it.

Tests: `lockdown_test` **73/0**, `settings_model_test` 55/0 unchanged, web `npm run check` all
twelve suites 0 failed (`record-notice` 7/0 new).

### 10.5 Not proven

* **On the box, through the real host agent and site.** The result POST was a dev stand-in (§10.4).
  The first real Verified game after this ships is the proof: the player's log should show
  `system line: Your record has been uploaded.` and, when the instance is retired, the end screen.
* **B's hand and B's keyboard**: the console key on a real UK keyboard (scan code 0x29 is the
  design; only posted messages were used), typing, paste; 2560x1440 borderless.
* **A real kick / Com_Error drop** (its `com_errorMessage` on the screen): only the empty-message
  paths (`disconnect`, silence) were run; `describe()` is unit-tested on the known keys.
* **Play Local's stock pause-menu Quit** → cover → quit: the same code path (clc.state 2 after a
  session) but not run.
* **The Esc menu's Exit** now meets the lockdown on its way out (disconnect → quit 400 ms later,
  before the 1.5 s debounce): read, not run.
* **Exclusive fullscreen**: not looked at.
* A server that is alive but silent for 20 s in a map (a stall that would recover) is now ended by
  us; no such stall has been seen, but it is a behaviour change.
