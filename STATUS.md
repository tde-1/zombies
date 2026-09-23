# Where things stand — 2026-09-23, 03:30 UK (end-of-session handoff)

> **This file is the current state of the code.** Design and decision history: the Obsidian vault at
> `C:\Users\b\Desktop\shared-notes\ENW COD Zombies` (`19 - Build Log`). A new agent reads
> `docs/kickstart/README.md`, then `docs/kickstart/next-session.md`. **Every lane doc has a dated
> section for the night of 2026-09-22/23** — read the newest section of the lane you are in.

## State at 2026-09-23 03:30 (handoff)

The session ran from 2026-09-22 19:00 to here; the one-page version, with every row's evidence, is
**`docs/kickstart/next-session.md`**. Everything is pushed (main through `e8850db`).

| | State | Pointer |
|---|---|---|
| **Launcher on the feed** | **0.2.24** (2026-09-23 12:45 UK), client DLL **`10ba8544`** (main `ad2ea6b`, same binary as the box). Tonight: 0.2.7 → 0.2.24 | `launcher.md` release table |
| **Box DLL** | **`10ba8544`** in all 9 copies (2026-09-23 12:44 UK; clean worktree `wt-coord2` at main `ad2ea6b`: lane 17 mouse fix on top of lanes 1 + 12). Rollback `binkw32.rollback-06a2e1bd.dll`. Boot proven: agent lease `m_e7918082`, `map_loaded`. Chain: `b36fe140` → `f8a835bb` → `86f12b12` → `6fccc0e0` → `79d4317d` → `c0986e5e` → `f920bb39` (unrecorded, reverted) → `03b04bc3` → `6b1ccfc5` → `683a475c` → `134a9d0f` → `499b70c1` → `06a2e1bd` → `10ba8544` | `dedi.md` §22.6–22.8 |
| **Box host agent** | Several leases: 3 slots, 1 reserved for agents; v2 pull; `ready` at `map_loaded`; copies/lobby ports by slot; `restart.js`. `run-host.sh`: `ENW_NO_PAUSE=1`, `ENW_DEDI_WATCH_PROBE_SLOT=1` | `host.md` §13, `dedi.md` §18.6, §19, §21.3 |
| **Site** | Live on B's PC; keepalive loop detached + Startup shortcut. **Proven by accident:** the PC crashed ~03:16, the loop was back 03:19:53, site + tunnel up 03:20:36. Everything merged through `b85ee4f` is live (bundle built 03:07). Live DB: 26 EE guides, 6 Movement banners, 0 playlists | `infra\keepalive.log`, `web.md` |
| **Storage** | One bucket `enw-zombies` (installers + maps, 302 from the site); replay `.glb` not uploaded | `storage.md` §6 |

**Shipped tonight** (detail in next-session.md's table): keepalive; launcher 0.2.7–0.2.20; no_msgbox;
dedi pause (now OFF on the box); Steam-only sign-in + ENW name gate; Movement rail, map page, profile;
`/settings`; chat overlay (4 rounds); one bucket; a picture for every map; three game servers per box
and several games per box; 59 popular maps as New; Easter egg guides; replay accuracy + scale; direct
boot; ENW Esc menu with Restart/Exit and quit-vs-crash; mod-compat; stock font; hang watchdog; the
join gate in three layers; `/maps` cards view; the fear_mc_2 lag (`sv_maxRate`).

**Open bugs** (one line each in next-session.md): stretched Colt on fear_mc_2 · B's client writes no
`console.log` since 09-22 18:07 · zm_nuked hang (watchdog in 0.2.19+) · fear_mc_2 lag client half
(launcher baseline already passes `rate 25000`/`snaps 30`/`cl_maxpackets 100`, gamecfg.js) · pause off on the box (localVars overflow)
· Nacht window walls / Der Riese Husky shell · kills/downs/revives/score not recorded · EE crawl
coverage · no playlists published · overlay in exclusive fullscreen · co-op pause with two real players
· four instances need RAM · vault git (Obsidian auto-backup) · web test 33991 flake · launcher volume
writes `snd_volume` (the dvar is `snd_menu_master`) · B's real profile touched twice by the harness
(defaults fixed; his account has `monkeytoy 1`).

**Decisions for B** (`questions.md` "Open at handoff"): Q-ip-1 name · Q-ip-2 phase gate + legal ·
Q-id-1 shared name store · replay `.glb` public? · profile Overall list · Quaternius CC0 gun · four
instances (Steam without browser vs bigger box) · pause back on (after the write probe names the writer).

**Sections below that said "not merged / not deployed / not published"** and are now live were
annotated in place with *(Handoff 03:30: …)*: the 59 New maps, one-game-per-box, relaunch loop,
`/maps` view, EE guides import, nav after a game, direct boot, Esc menu, mod-compat, the join-fix
client DLL, the morning checklist, 0.2.12, web-cleanup, web-settings-2, web-dock, identity, chat
overlay, pause, profile, settings, replay WaW pass, replay scale, web-maps, no_msgbox.

* **2026-09-23 03:15 UK — "extremely laggy on the Minecraft map" is fixed on the box (`dedi.md` §22).** Stock `sv_maxRate` is 7000 bytes/s and the server paces every internet client to it; a fear_mc_2 snapshot is 600–1,100 bytes, so B got 10, then 3 (once snapshots fragmented) snapshots a second instead of 20. Local tests never saw it: 127.0.0.1 counts as LAN and skips the rate code. `net_probe.cpp` raises `sv_maxRate` to 25000 (the engine maximum) and logs the wire per client; `net_probe_client.cpp` logs snapshot arrival. Measured B's PC → box over the internet on fear_mc_2: 3–10/s, 30 of 30 fragmented at the stock cap → **20.0/s, 0 delayed, 0 fragments, 50 ms gaps** at 25000. **Box DLL `6b1ccfc5`** (main `fd29f8f`, includes the join fix). *(Coordinator 03:40: the launcher baseline already passes `rate 25000`, `snaps 30`, `cl_maxpackets 100` - `gamecfg.js` ~125-135; nothing to ship.)*
* **2026-09-23 03:00 UK — "maps cannot be joined mid-game" at the very start is fixed in three layers (`dedi.md` §21, `client.md` §11).** The dedi opened its co-op join gate by polling every 16th frame, so a connect waiting when the map finished loading was refused; the stock client then gave up for good. Now: the dvar is on from registration and `SV_DirectConnect`'s gate is unconditional (`ENW_JOIN_GATE_STOCK=1` off); the client retries a "not ready yet" refusal every 2 s for 60 s with a *Waiting for the server...* line (`join_retry.cpp`, `ENW_JOIN_RETRY=0` off); and the host reports `ready` at `map_loaded` (`46fe734`, host lane). Proven locally on Nacht, bridge_zombie and fear_mc_2 with the client started before the server, plus a forced-race control that reproduces B's error; proven on the box with a scripted connect from before the lease (`connectResponse`, never the refusal). **Box DLL `03b04bc3`** (main `81086d4`; it replaced an unrecorded `f920bb39` that carried another lane's uncommitted `net_probe`, rollback kept). Client DLL `build/client-lane` = the same `03b04bc3`, ~~**not published**~~ *(Handoff 03:30: published as launcher **0.2.20**; the box moved on to `6b1ccfc5`, line above.)*
* **2026-09-23 ~00:00 — the popular 64 on the box (`docs/kickstart/dedi.md` §20, `archive.md` §10)**: **59 pass, 5 fail**. Pass = `map_loaded` + `com_frameTime` advancing on the box, server-side only. The failures are shore and cxca (missing script) and shinomori, dpp and inferno (out of `main` memory); they are `broken`, hidden and refused a lease. The site lists 78 maps (83 before). The 59 get a new party-leasable level, **New** ("loads on our servers, not yet played with a client"; `lib/maps.js` `BOX_PROVEN` ← `boxProven.json`). ~~**Committed, not deployed**: it needs the client build and a site restart.~~ *(Handoff 03:30: live since the 01:12 site restart.)* No client has joined any of the 59, and 19 of them have ≥110 MB zones.
* **2026-09-22 late — object storage (`docs/kickstart/storage.md`)**: the site can 302 installers, blockmaps, map files and replay `.glb`s to two public Hetzner buckets (`S3_BUCKET_FILES`/`S3_BUCKET_MAPS` in `infra\site.env`, off until set); `tools/s3/sync.js`/`check.js`; `publish-update.js` uploads too. **Not live yet: the keys in `infra\s3.env` see no buckets** (the names are not found in nbg1/fsn1/hel1). **Superseded 23:05: ONE bucket `enw-zombies` created by the coordinator on B's direct instruction, public-read, installers + 26.5 GB of maps synced, site switched over (keepalive loop restarted so it read the new `site.env`), installer and map downloads 302 to the bucket at ~47 MB/s; replay `.glb`s held back. `storage.md` §6.**

* **2026-09-23 01:15 UK — several games per box, for real (host.md §13, web.md, dedi.md §19.6)**: a lease no longer supersedes anybody else's game. It replaces only the same party's or the same players' game. zombies-dev holds 3 games, and 1 slot is reserved for agent leases (lease-cli), which also give way to a real player. When the box is full, players see "No free server right now". Proven on the box: two fake-ID games up at once, the third refused, and each cancel retired only its own game. **Root cause of B's game going idle mid-round:** it was not a timer. His launcher's failed-rejoin path called `/api/launcher/cancel`, which cancelled his live match, and that route now refuses to cancel a live game. Quit from the Esc menu now cancels the server. After a crash, the rail offers **Resume** for 10 minutes. The launcher is no longer shown a follow state for a game the player is in or has left.

* **2026-09-23 00:45 UK — the box runs three game servers at once (`dedi.md` §20).** The "3074 + one fallback" limit was wrong. The engine probes 100 lobby ports, and the new dedi DLL `6fccc0e0…` (`lobby_port.cpp`) logs every bind and takes `ENW_LOBBY_PORT` (3074+slot). Three servers were proven up together, all answering, ~304 MB and ~0.33 core each, ~300 MB RAM left. Four needs Steam without its browser or a bigger box. **Fixed an outage:** after four boots the host agent failed every lease, B's Play included (23:27–23:32 box time, "no game copy at waw-inst-05"). Copies now go by slot. ~~**Still one game per box at the site**: a second Play supersedes the first, and that is the web lane's to change.~~ *(Handoff 03:30: fixed at 01:15, several leases per box, live.)*

* **2026-09-23 01:45 UK — launcher: the relaunch loop is fixed (branch `launcher-after-game`, not merged, not published).** *(Handoff 03:30: merged, shipped in **0.2.15**; the rail's Resume button exists and calls `enw.resumeMatch`.)* The party watcher re-launched the same match on every poll after the game exited (B: "keeps booting you back into the game"). A match is now followed at most once, never beside a live game of ours; only Play or the site's Resume (`enw.resumeMatch`, needs a site button) goes back in. `launcher.md`, same date.

* **2026-09-23 ~03:00 UK — `/maps` Cards | List (branch `web-maps-view`, not merged; web.md, same date).** *(Handoff 03:30: merged `b85ee4f`, live since the 03:20 restart; still 0 playlists in the live DB.)* The collection rows are gone from the top of `/maps` (Home keeps them). The default is Movement's mode home: Popular, Your maps, a row per playlist, All playlists covers, and **View all maps**. Movement's `ModeViewSwitch` sits top right. List is the filter bar plus the rows and nothing else. The choice is saved (`zm_maps_view_v1`). `?view=` and any filter force a view for that visit without saving it. The live DB has no playlists, so the cards view there is Popular + View all maps until one is published. Needs a client build and a restart.

## Box, 2026-09-23 01:20 (coordinator)

Pause is OFF on the box (`ENW_NO_PAUSE=1`): two paused Nacht games died of the script-VM localVars overflow ~30-54 s after a resume (dedi 18.6, referee 15.4); guarded DLL `79d4317d` + write probe deployed. Launcher 0.2.14 (Esc pauses on a box, client clock held) and 0.2.15 (relaunch loop gone) on the feed. Site restarted 01:12 with several-games-per-box, the launcher-cancel guard, quit-vs-crash and the 59 New maps.

* **2026-09-23 01:30 UK — Easter egg steps (branch `web-easter-eggs`, web.md + archive.md §11).** `archive/easter_eggs.py` read the cached release posts and threads without making requests and found **26 guides on 20 maps** (8 main quest). They go into a new `map_guides` table via `node web/server/db/import-archive.js --guides` (~~not yet run on the live DB~~ *(Handoff 03:30: run — the live DB has 26 rows; merged `521d94a`, live.)*. The map page shows them blurred under "What's in it" with **Show Easter egg steps**; the reveal is remembered per map, and each guide credits its author with a link. Cards and rows get an EE tag, and /admin → guides lists each guide with its confidence plus hide/delete. Unproven: whether the steps are right (they are the authors' release text), and recall.

* **2026-09-23 02:30 UK — launcher: the nav is clickable straight after a game (branch `launcher-after-game`, not merged, not published).** *(Handoff 03:30: merged `afed591`, shipped in **0.2.16**.)* 0.2.10 hid the shell's drag strip *after* showing the site, but a covered shell page does not paint, so its drag region kept the nav (Maps, Update now, the account chip) dead. In a dev window the nav stayed dead for more than 2.4 s in 15/15 trials; now it is 0 ms in all 33. `launcher.md` and `ui/2026-09-23-launcher-after-game-timing.md`.

* **2026-09-23 01:30 UK — launcher joins boot straight into zombies (`client.md` §10, branch `boot-direct`, not merged).** *(Handoff 03:30: merged `340ea09`, shipped in **0.2.17**. The `snd_volume` finding is still open.)* The "can't connect" box is the menu `popup_cannot_connect_to_dw` ("Online Service Error"), opened by the Demonware log-on after our blocked DNS lookup; `boot_direct.cpp` refuses it and its three sibling popups at their three call sites (`ENW_SHOW_ONLINE_WARNING=1` shows them). A join now connects on the first frame, with that one menu frame painted black and `snd_menu_master` muted until the first in-game frame (`ENW_DIRECT_BOOT=0` is the old menu wait). Measured on a local dedi at 1280x720: process start → in game **~5.9 s → ~4.9 s**, no menu or popup in any captured frame. Not run through the launcher, on the box or on B's screen. Also found: `snd_volume` (the launcher's volume setting) is not a dvar in this exe.

* **2026-09-23 ~01:40 UK — the ENW Esc menu (branch `esc-menu`, not merged, `docs/kickstart/esc-menu.md`).** *(Handoff 03:30: merged `c72190f`, shipped in **0.2.17**, box `restart_request` since `c0986e5e`, and `POST /api/party/quit` exists on the live site — the "route does not exist" sentence below is history.)* Esc in a box game opens ours instead of World at War's: Resume, Restart game, Exit game, the chat panel embedded, friends online with the map they are on (Invite) and invites to you (Accept). The pause contract is unchanged (`enw_ui paused`). **Restart** is proven end to end on a local dedicated server with the real host agent: the run ends as abandoned (signed replay, `player_restart`), a new run `<lease>.r2` takes over on the same lease, the player is re-admitted. **Exit game** calls `POST /api/party/quit` then quits — **the site route does not exist yet** (contract in `esc-menu.md` §5, site lane): until it does, the launcher boots a quitting player back into a live lease. Not yet on the box or through the site.

* **2026-09-23 01:45 UK — mod compatibility (`docs/kickstart/mod-compat.md`).** B's stretched Reapers Colt on Minecraft Village is **not reproduced** locally with byte-identical files and B's settings; mod files, add-on IWDs, fastfile order and dvars are ruled out, the box server is not (no leases tonight), and B's client has written no `console.log` since 09-22 18:07. Fixed: the settings read-back no longer saves dvars a map sets itself (this map's anti-cheat put `monkeytoy 1` in B's account — his console is off on every map until he changes it back); a pre-launch check re-downloads files that differ from the server's; the site and launcher now ship loose `.iwi/.csc/.bik`/weapon files (Futurama, Arena, Five Nights, 3 load videos; uploaded to the bucket 02:58 by `sync.js --only maps`). All 57 box maps: no byte differences; box Futurama is missing 4 archive files. Branch `mod-compat`. *(Handoff 03:30: merged `cccce5c`, shipped in **0.2.17**; the stretched Colt is still unexplained.)*

## B: do this first (the morning checklist)

*(Handoff 03:30: this checklist is from the 2026-09-22 morning and is superseded — B's steps now are in the handoff section at the top and in `docs/kickstart/next-session.md`.)*

1. **Install the launcher 0.2.2** (0.2.1 auto-updates; Settings has a Check-for-updates button) from `https://zombies.enw.gg/download` (or let 0.2.0 auto-update:
   the feed is live). Sign in with Steam. It repairs the game-folder DLL on every Play now — the
   "windowed at native size" you saw was a stale 0.1.x DLL that no update ever copied in.
2. **Play Local on Nacht once.** Expect: borderless 2560x1440 covering the taskbar, 250 FPS cap,
   vsync off, no dialogs, in the map in ~3 s. Map downloads work (8 of 10 refused before: a
   launcher bug, fixed).
3. **The mouse test, three one-minute runs** (`docs/kickstart/client.md` §1e): default;
   `ENW_RAW_MOUSE=0`; `ENW_RAW_MOUSE_NOLEGACY=1`. Stutter is proven to be mouse-bound (p99 6 ms
   without mouse input, 20–27 ms with your mouse). Which side of the input path costs it, only a
   real high-rate mouse can tell — an agent cannot inject input at that rate.
4. **Party game with a friend.** Home is now Movement's map browser: party panel on the left
   (download bars, ready, Start), map list under it, the selected map fills the rest. Leader
   Start → lease → the **Hetzner box** (online, 2 instances) → everyone's launcher follows.
   Verified mode is the default. **Approved:** you, jamie, zeroh, stew, jacob, air, toku.
   Give them the gate password and `/download`.
5. **Custom maps with friends**: today that is Minecraft Village Remastered plus the stock four on the box. The rest is the list under *Known and unfixed*.
6. **Replay viewer**: any finished game's page → replay. Nacht renders with full world geometry.

## 2026-09-22 (late evening): launcher 0.2.12 — update chip, Download, installed maps (branch `updates-downloads`, not merged, not published)

*(Handoff 03:30: merged `337b461` and published as 0.2.12; the feed is now 0.2.20.)*

* **Update chip, top right**: `Update 0.2.13` · Update now · Later → a bar → Restart now · Later. The
  check runs every launch; the download waits for Update now; Later hides it until next launch.
  The launcher's "site is not answering" page has the same chip.
* **Download** beside Play on the map page and small on the rail's card: Download → bar + % →
  Downloaded. In a browser it goes to /download.
* **Settings → ENW**: an Update button and an *installed maps* box (picture, title, key, size,
  largest first, select and Remove). Only maps ENW installed are listed.
* **Download bars** everywhere a download shows, bar before the %, rail-row height.
* **Proven** in a dev launcher window on a DB copy (screenshots `docs/kickstart/ui/2026-09-22-launcher-0.2.12-*`),
  tests green. **Not proven**: a real feed, a real restart. Write-ups: `launcher.md` and `web.md`, newest sections.

## 2026-09-22 (late): the rail cleaned up (branch `web-cleanup`, not merged)

*(Handoff 03:30: merged `90e21bc`, live.)*

* **The card opens the map page.** It works like Movement's, and the page has a Back that goes
  to the map list.
* **Removed:** the picker sheet, the connect field and Start anyway. The leader kicks with ×
  instead.
* **Not playable:** a tag, with the reason on hover, on every map no box runs. Today that is
  20 of 25. Play is disabled for them.
* **Steam pictures** everywhere. They come off the public profile with no API key, read at
  sign-in and at most once a day.
* **Wording:** a pass over the site's text, cut down to Movement's length.

The full write-up is `web.md`, newest section.

## 2026-09-22 (late evening): `/settings` in Gaff's shape (branch `web-settings-2`, not merged)

*(Handoff 03:30: merged `f7c3d63`, live.)*

B asked for Gaff's settings menu. `/settings` is now a rail with search and six icon tabs (Display,
Graphics, Audio, Controls, Game, ENW), small lowercase sections, one short row each: checkboxes,
segmented buttons, selects, sliders; key capture and a reset per section kept. Every WaW dvar
mapping unchanged (a test checks every item is placed once). New ENW row: *pause game while
chatting (solo)* (`pause_on_chat`). ENW tab is `EnwSection.jsx` with a slot for Installed maps +
Update. Proven on a dev port with a saved-value round trip; `web.md` last section.

## 2026-09-22 (evening): Movement's left rail on the site; the logo is just ENW (branch `web-dock`, not merged)

*(Handoff 03:30: merged `5bd4932`, live.)*

Movement's party rail is on the left of every page. It has four parts:
* **Your party**, with invite by ENW name.
* **Invites** waiting on you.
* **Online**: everyone signed in, for an approved account. Each row has invite, join or accept.
* **The server card** at the bottom, showing the map's art, with Verified/Custom and
  Private/Friends/Public above it and the one Play button on it.

Clicking the card opens Movement's picker sheet with maps in it, and picking one changes the map.
Play runs the same party flow as before, through the play gate. `PartyPanel.jsx` is deleted.
Server: invites work by name, an invite now opens a friends-only lobby, and there is decline,
take-back and kick, plus `lib/roster.js` for the online list. The ZOMBIES word is gone from the
lockup (site, and the launcher's fallback screens).

`npm test` is 142/0. Proven with three fake sessions on a private copy (`docs/kickstart/ui/rail-*.png`).
**Unproven:** a real launch from the rail (no box on the dev instance), and the rail inside the
real launcher window. Details: `docs/kickstart/web.md`, "2026-09-22 (evening)".

## Replay viewer parity pass (2026-09-22, late)

B's eight complaints about `m_0afb449b` have a spec (`docs/kickstart/replay.md` §8) and
results (§8.10). Play and First person were dead to the mouse (pointer capture on the viewer
wrapper, and the chat dock over the Play button) - fixed. Zombies were recorded all along and
dropped by the 10 Hz track sampler - fixed (0 -> 13). Props lay on their sides (OAT glTF is
Y-up) - fixed and Nacht re-exported. Replay ends at the intermission. Crosshair + placeholder
gun (procedural, no downloaded asset). DLL: zombie yaw, grenades + `explode`, classname
census - deployed to the box, booted a map, **grenades unproven** until a game with a throw.
Der Riese: props-only export; the shell needs one Husky lock hold.

## Sign-in = Steam + an ENW username (2026-09-22, evening, branch `web-identity`)

Every dev/mock login is gone (site `/auth/mock` + `ZM_AUTH`, the launcher's persona fallback); Steam
OpenID is the only sign-in; `ZM_TEST_LOGIN=1` is a test-only hook that refuses to boot in production.
A signed-in account with no ENW name gets Movement's "Choose your name" picker and is refused
everything else server-side; rules, wording and the 754-term blocklist are drops.ws's, verbatim.
`users.pub().name` is the ENW name, never the Steam persona. All seven approved accounts already have
names, so nobody sees the picker. Open: Q-id-1 (shared store vs mirrored rules); `jamie` is `Jamie`
on Movement (`tools/align-enw-names.js`). ~~Not deployed.~~ *(Handoff 03:30: merged `72a4920`, live.)* `docs/kickstart/web.md` §13.

## In-game chat overlay (2026-09-22, evening) — built, not shipped

*(Handoff 03:30: shipped in 0.2.11, round 2 in 0.2.13, round 3 in 0.2.14, round 4 (stock font) in 0.2.18.)*

T opens World at War's own chat, drawn by the engine (its renderer, its fonts, its chat anchor
`cg_hudChatPosition` 5,200), with Global / Party / DMs tabs, WaW's "Say:" line and the game's own
cursor; Enter sends, Esc closes. The mouse leaves the game while it is open. It talks to the site
directly (`/api/game-chat/*`, a 12 h chat pass the launcher hands over on the token pipe); party
lines and DMs are a separate table from the global ring. It sets `enw_ui typing` / `paused` and
`enw_pchat`, and a dedicated server was **measured** pausing and resuming on it (solo). Proven in
the running game windowed (800x600, 1024x768, 1280x720, 2560x1440) and borderless, end to end
with a private site. **Exclusive fullscreen not yet looked at**; needs a site deploy and a launcher
release to reach anyone. The draw hook turned out to be the "withdrawn" 0x6F5F10, which is
`R_AddCmdDrawText`. `docs/kickstart/chat-overlay.md` §9.

**Round 2 (after B used 0.2.12):** clicks work — the pointer was drawn 48 px (at 1440p) away from
where clicks land, because WaW draws its cursor centred and the overlay drew it from the corner.
Now a real text box (select, word/line clicks, Ctrl+A/C/X/V, Up/Down recall), selectable history
with copy, a tab per DM conversation, click a name or `/w name text` / `/r text`, hover. Proven by
logged clicks at 1280x720 windowed and 2560x1440 borderless, with test windows that never take
focus. B's one-minute hand check is `chat-overlay.md` §10.4.

**Round 3 (after B's box game on 0.2.13):** Esc now opens the pause menu on a box and freezes the
game (it was blocked all along by the name of the load video we refuse, and then the menu paused only
the client). While any pause holds, the client's clock stands still, so no twitch or FPS-meter
spike at the edges. Measured on a local dedi + client; `chat-overlay.md` §11.

**Round 4:** the overlay and the Esc menu always use World at War's own font, even on the many
custom maps that replace it (read from the player's own install; only hashes ship). Proven
pixel-identical on Nacht and on MW2 Rust; `chat-overlay.md` §12.

## Pause (2026-09-22, evening)

The dedi now really pauses: Esc solo (and typing, with the "pause when using global chat"
setting), co-op only when everyone is in the menu, typing never pauses co-op; a disconnect counts
as unpaused; no ceiling, logged. Engine-side and total (`G_RunFrame` gated, clocks held, snapshots
flowing), paused time excluded from in-game time and records untouched (`dedi.md` §18,
`referee.md` §15). **The client half is one userinfo key** (`chat-overlay.md` §8) — built with the chat overlay
and measured against a local dedi (§9.5); it reaches players with the next client DLL *(Handoff 03:30: it did, 0.2.11/0.2.14)*. Box deploy/proof: see `dedi.md` §18.4. **Pause is OFF on the box since 01:20 (`ENW_NO_PAUSE=1`, `dedi.md` §18.6).** What a
real client draws while frozen is unproven.

## Profile: Movement's, with their Movement banner (2026-09-22, late evening, branch `web-profile`, not merged)

*(Handoff 03:30: merged `2880015`, live; `import-movement-profiles.js` has been run — 6 banners in the live DB.)*

`/id/<name>` is Movement's profile: banner + identity bar, badge shelf, **Top maps / Recent maps**
(map art, time, games, best round), **Overall** (games, rounds played, best round → its game/replay,
time, records held, member since; kills/downs/revives hidden until the game reports them — today
it does not), records held, and Movement's comment wall at the foot. No skins. The banner is the
one on the player's **ENW Movement** profile, read from Movement's public profile route and the
file copied here (`lib/movementProfile.js`); no upload here, "Change banner on Movement" instead.
Six of the seven approved accounts have one. **To go live:** build + restart, then
`cd web && node tools/import-movement-profiles.js`. `docs/kickstart/web.md`, last section.

## Settings page: World at War's Options menus (2026-09-22, evening, branch `web-settings`)

`/settings` (account menu → Settings, browser and launcher) is laid out like WaW's Options menus
with every item read out of the game's own `ui.ff` (Graphics, Texture Settings, Sound, Game
Options, Look/Move/Combat/Interact key rows) plus an ENW tab (display mode, monitor, FOV, 250 cap,
Show FPS, raw mouse, DOF/glow). Saved per SteamID on the site, pushed to the launcher through the
existing bridge, put on the `+set` line and merged into the engine's `config.cfg` every launch;
in-game changes come back after exit. Proven by test, dev port and a preload harness; **in game
unproven** — `client.md` §8 (dvar table, §8d = B's one-minute check), `web.md` newest section.
Needs a launcher release + site deploy to reach players. *(Handoff 03:30: merged `fd73826`, live, in the launcher since 0.2.11.)*

**WaW pass (2026-09-22 evening, branch `replay-waw`, not merged or deployed; replay.md §8.11).** *(Handoff 03:30: merged `65addc6`, live; the DLL half went to the box in `86f12b12`, dedi.md §18.5.)*
Positions checked against the Nacht shell: frame and axes were right; wrong were 49 brush-model
islands piled on the engine origin (the start-room "walk-through" planks, dropped), Source eye/hull
heights (now WaW 60/40/11, r15 × 70/50/30), CS:GO FOV (now cg_fov 65), zombies 50 ms behind and
stepping, a **674 ms** time-base drift between events and positions (fixed with per-tick real
times), and **no view pitch in any file** (DLL change). Yaw is exact: 13 of 15 aimed shots inside
the target's half-width. Open: the Husky shell misses walls around Nacht's windows (12 of 15
shots pass through rendered walls). New: chalk round HUD + zombies-left (stock formula − deaths),
the weapon-file crosshair (engine spread model), the grenade reticle and fuse, the damage flash +
direction from recorded health, a settings panel. Map clutter: alpha-cut foliage, 209 tiny and 506
floating props hidden (scratch export only; live export unchanged). **DLL built, not deployed**:
`cmd_ang`, stance bits 0x200/0x100 (were melee/use), kill counter blind above entnum 255.

**Replay map scale (2026-09-23, replay.md §8.12).** B's "complete misalignment" was the Nacht
world shell being **2.54× too big** — Husky exports in centimetres — while props and the
recording are in engine inches; hidden until now because the start-room floor is at z = 0.
Fixed in `export_map.py` and **re-exported live** (world 31 212 → 12 288 u across; window goals
133.8 → 57.3 u from their walls; zombies 0.18 u above the floor; 22 of 23 aimed shots now have a
clear line to their zombie). Map cache-busting hardened (versioned URL from built_at + mtime +
size, `.glb` no-cache + ETag, track cache invalidated on re-export) — ~~**needs a site restart**~~ *(Handoff 03:30: merged `839bf93`, live.)*
New: hold Tab for a WaW scoreboard (points not recorded yet: DLL field `score` needed).

## Since the morning checklist was written (afternoon)

- **Isolation rule, done and proven**: our session redirects the game's LocalAppData into `%LOCALAPPDATA%\ENWZombies\home\localappdata` (DLL `enw_localappdata.cpp`); maps, config, saves, profiles all live there; B's `Activision\CoDWaW` tree is byte-identical before/after a Play Local. B's own mods folder was cleaned into `ZombiesDevackup-user-mods-20260923\`.
- **LAA / 4 GB flag: impossible on the Steam exe.** SteamStub refuses a flagged exe (`Application load error 3:0000065432`, measured). ORBiT and UGX Requiem clients therefore still stall at ~1.6 GB. The launcher refuses to flag any exe with a `.bind` section.
- **Player identity**: only the site's signed invite token; parsed at connect, verified by the host, forged → kicked in 27 ms; `identity: none|claimed|verified|refused`; the integration test scores 2 players.
- **`flag_wait` is fatal on a stock listen game too**; the fatal script arrives in an add-on IWD (`zombie_hitmarker_bythesuzho.iwd`) our archive install ships — an agent is stripping add-ons and retesting the four maps.
- **0.2.2** on the feed: LAA plumbing (off), isolation, `enw-zombies://map|party` deep links, Check for updates.
- **Web pass done** (`406607b`): Movement's list/card views, home rows from a table, one theme, Maps · Records · Admin nav, search top-left, user dropdown, browser Play → `/download`. `npm test` 120/0.
- **Box redeployed with the identity build** (`403b150`): DLL `318dfd60…` in every game copy on the box, host agent shipped, 46/46, box idle, `play: true`. A forged token against the live key → `identity refused` → kicked in 129 ms. **Bug found**: `host.js` took `requireToken` from the `--site` argument, not `cfg.site`, so the env-configured box had been advisory-only all evening; running with `--require-token true` until the one-line fix lands (evening agent).
- **Host rows** (`9506d04`): `identity` travels with the result, `steamid` only when verified; `end` carries the next match id; a warm instance took a second lease (integration 36/0).
- **Evening (B, 2026-09-22)**: three agents running for a friends' party game in two hours — the real launcher path against the box, the replay viewer live on the site for Nacht, and cross-server chat (Movement's port + game-event lines + Discord link; in-game T overlay planned in `docs/kickstart/chat-overlay.md`). **Add-on IWD retest done, negative** (`18cf472`): all six maps are broken by the maps themselves (add-ons are hard dependencies; MW2 Rust's fatal `flag_wait` is the author's own line). Tonight's set = the stock four + Minecraft Village Remastered. Also fixed: `launch.ps1` had a committed parse error; the private LocalAppData tree needs `players\profiles` seeded. Read the newest section of `launcher.md`, `replay.md`, `web.md`, `archive.md`.
- 22:35 web-maps (branch `web-maps`, not merged; *(Handoff 03:30: merged `b49cb48`, live)*): **every map has a picture** — `tools/maps/map_art.py` (scraped cover > the map's own .iwd loading screen > WaW's stock loading screen > a generated NO SCREENSHOT ON FILE card; webp + thumb + manifest, `--write-db`); counts on the dev DB: site 1,256 / iwd 0 / stock 4 / placeholder 1,024 of 2,284 with `archive/fetch_art.py` still fetching catalogue covers (1,200/1,415). **Map page is Movement's MapDashboard** (banner two-up, figures, Play, a "What's in it" strip of perks/PaP/box/wall buys/wonder weapons/dogs read from the map's fastfile, board/thread split), web-cleanup's edits kept. npm test 121/41/15/19/12. Stock loadscreens must go before public: `--no-stock` (ip-posture.md §4). web.md + archive.md §10.

## Evening (2026-09-22): the real launcher path reaches the box, and five breakers fell

`lp5`: launcher → real lease → token via the one-shot pipe → box → `identity verified` (B's SteamID) → game over → result credited (game id 7) → `/replay/m_9f7b692c` with the player's name. **Before tonight this would have failed for every friend**: (1) `boxes.address` was never written, so every lease returned `connect: null`; (2) `+connect` is not a command in this exe — join now goes through `ENW_CLIENT_CONNECT`; (3) `ENW_FS_HOMEPATH`/`+exec enw_auth.cfg` missing, the token died in the DLL; (4) a superseded instance kept UDP 3074; (5) ghost `live` leases made an idle box answer "no game box online". All in `99141a9`. Box: `requireToken` fixed properly, fear_mc_2 installed (three symlinks), tokens ENFORCED, host agent from HEAD. **Still unproven**: Steam sign-in + party UI + ready check end to end (the Start came from `web/tools/lease-cli.js`), two or more real clients, round 2, the packaged 0.2.2's deep link. The box's game DLL is the morning build, so `player_down` will not announce in chat tonight. Replay viewer live (`a0635ad`); chat dock + system lines + Discord link live (`ddaec9c`); `for-players.md` rewritten for 0.2.2.

## Launcher 0.2.3 (evening): the DLL B played was stale, and the config was seeded into a folder the engine never read

`7fcdb60`. `stage-client.js` preferred `build/launcher` regardless of age, so **0.2.2 shipped a DLL built before `borderless.cpp` and the mouse fix existed** (39 vs 47 components; a run logged neither) - hard-gated now, and the build banner prints the file's mtime/size instead of a per-TU `__DATE__`. And `players/profiles/<p>/config.cfg` resolves against the engine's LocalAppData, not `fs_homepath`: we seeded a directory that did not exist while the engine kept `r_mode 800x600` and `+toggleads_throw`; seeding now merges into the real file. Mouse: no community patch exists (T4M never touches input; Plutonium still says "125 Hz"); `RIDEV_NOLEGACY` is now default with buffered reads, no recentre under `ClipCursor` (Quake3e's pattern), and a real bug in the untested NOLEGACY path fixed. Hold ADS = `bind MOUSE2 "+speed_throw"` (no ADS dvar in T4). `r_displayRefresh` was 60 on a 240 Hz panel. `r_noborder` re-confirmed absent from the exe. Proven in a 55 s run: window rect == client rect at 2560x1440, 1,051 WM_INPUT vs 50 legacy, p99 7.25 ms. **B's three one-minute A/B runs decide the stutter** (`client.md`). 0.2.3 sha `35be221b…`, DLL `8a7b7b30…`, 47 components (includes `script_error_retail`). **Custom-map scripts** (`4986d70`, `scripts.md`): `+set logfile 2` put the script VM into developer mode, making ordinary script errors fatal; fixed in shared core. Next wall (`scr10`): weapon-index mismatch on the client from a script error the map throws during weapon registration - a dedi-only divergence; owner: weapon/asset registration. Per-map swallowed-error counts: mw2rust 2, test1 24, sanatorium 2,720, test 52,922. Five-gate runs paused for B's evening.

## 0.2.4 / 0.2.5 (evening, later): Play on a stock map, and the clicks

**0.2.4** (`0a4d431`): stock maps skip the download (`installed: stock`), a failed step says it stopped, leases release on failure/Cancel, mode defaults to Verified. **0.2.5** (`dc1c499`): **the mouse-click root cause is proven in the engine** - the WndProc sends WM_MOUSEMOVE and every button message to one handler that XORs wParam's MK_ mask against `s_wmv.oldButtonState` (0x229A0C8); the message id is never read. Measured: button messages carrying a wrong mask queue nothing, a plain move carrying MK_RBUTTON queues a full click. `IN_RecenterMouse`'s per-frame `SetCursorPos` synthesises exactly such stale-mask moves (0.2.2), and 0.2.3's synthesised buttons built the mask from `GetAsyncKeyState` (would have dropped clicks; caught before B ran it). Now raw input is the single source of button truth in both modes, every forwarded legacy message has its mask rewritten, NOLEGACY is motion-only, `ENW_INPUT_TRACE=1` counts raw transitions vs engine-queued events. T4 has no `Key_ClearStates` on focus loss (excluded). Launcher: the account settings block no longer shadows keys, read-back never persists engine defaults (B's `maxFps 60`/`fov 65` repaired to 250/80), ADS bind migrated to hold, `ENW_BORDERLESS` follows the effective mode, the launcher never raises its window mid-game. **B's two one-minute trace runs (125 Hz, 1000 Hz) give the numeric verdict** (`client.md` §6f). Research R16: lock `com_maxfps 250` for Verified; controller support ~3 days launcher, aim assist 1-2 weeks DLL (iw4x GPL runtime), glyphs likely cheap. In flight: ENW username locked in game (referee overwrites userinfo `name` from the token), left-column-only launcher shell.

## Session wrap (2026-09-22, late): everything pushed; one agent still in flight

Pushed through `8da3d0d`. **Identity lane landed**: the ENW name is set once through a Zombies-side picker (Movement's rules; Movement's SSO endpoint is steamid-out and useless for names - the real authority is drops.ws `GET /internal/name`, which needs `ZM_ENW_BASE` + `ZM_ENW_SECRET` from B); "Unknown Soldier" was the engine's stock `name` default written back into `users.username` by results.js - removed, seven accounts seeded with handles. Server lock: `SV_UpdateUserinfo_f` 0x6307E0 hooked, `SV_UserinfoChanged` 0x630650, `ClientUserinfoChanged` 0x67BCF0, `Info_SetValueForKey` 0x5F71F0; `namelock1-3` PASS with a client re-asserting `+set name spoofer` every 3 s - `game_over` says `enw-tester`. **Unproven**: the on-change hook has never been seen firing (needs a human typing `
ame x`), a second client's scoreboard, and the picker has no UI yet (API + `needs_name` live). `SV_ExecuteClientCommand` corrected to 0x6308F0; no `CS_PLAYERS` configstring in this exe. **0.2.6 published** (`711a2ce`): installer sha `09365166…`, DLL `f0a9844e…` (48 components, fresh build, no `--allow-stale`), tests 124/0. Contains the left-column-only shell, the name lock and `+name`. Vault
fully updated: `19 - Build Log` (the whole day), `00 - Status` (decision rows for FPS 250, controller,
name lock, shell, mouse, `logfile` rule), `11`, `13` §4a-4, `99`, `07`, R15, R16.
**B's to-do:** update to 0.2.5 → two one-minute trace runs (125 Hz, 1000 Hz) → play with friends;
decide aim assist on Verified boards; confirm the 250 lock.

## The headline

**The dedicated server survives a player now.** Three walls fell tonight, each proven with real
client runs: a 128 KB temp-memory leak per client message (`temp_stack_guard.cpp`), then the real
one — **an access violation once per frame in the water simulation**, whose buffers only the
renderer allocates; every frame unwound out of `Com_Frame` while `getstatus` kept answering, which
is why every earlier "proof" passed (`watersim_pool.cpp`, plus `no_save_reload.cpp` at game over).
**join65/join66: 300 s each, five gates, through game over, 4–6 % of a core.** The proof harness
now has a fifth gate (`com_frameTime` advancing) so a dead server can never pass again.

## What exists now (pushed to `github.com/tde-1/zombies` through `403b150`)

| Lane | Tonight |
|---|---|
| **web** | Home = Movement's map browser, party panel left, no right rail, map-tinted background; profiles from Movement; **all demo data wiped** (backup `web/data/backup-20260922-033847Z/`); Steam-only sign-in; 7 approvals; `POST /api/party/:id/progress`; `/download`; deployed, tunnel verified |
| **launcher** | 0.2.1 live on the feed (`/updates/`): borderless-native baseline + 13 bundled config fixes, config seeding + read-back round trip, party download progress, follow-the-leader launch, DLL hash-repair on Play, map-install ownership fix |
| **client-dll** | `mouse_polling` (iw4x raw input port), `borderless` (Borderless-Gaming technique), `frametime` (`ENW_FRAMETIME=1`), opt-in `ENW_RAW_MOUSE_NOLEGACY=1` |
| **dedi** | `temp_stack_guard`, outer pacing loop (60 Hz, 1.4 %), `watersim_pool`, `no_save_reload`, `big_heap`, harness gate 5, `maptest.ps1`. Der Berg boots; a NULL-dvar read at 5.6 s is being fixed now |
| **vps** | Box `zombies-dev` runs **B's English game copy** (SteamStub checks the app, not the depot; the account is German-region, low-violence only). Host agent as `enw-host-agent` systemd, `--wine`, **registered, online, max 2 instances** (3074/3075 is the ceiling). 0.30 core / 301 MB per instance. €7.19/mo, nothing else rented |
| **archive** | 14 customs: latest versions confirmed, cover art, descriptions, authors, endings evidence, imported; next-20 list in `ZombiesDev\archive\reports\next20.json` |
| **replay** | Movement's viewer ported (`/replay/:matchId`): timeline, cams, points/round/downs, round ticks; Nacht exported via OpenAssetTools + Husky, 37.8 MB GLB with world shell; first real signed replay `m_e455d4ba` from the box |

## Known and unfixed

- **Custom maps on the dedicated server: one passes.** Minecraft Village Remastered (`nazi_zombie_fear_mc_2`) — five gates, 300 s, real client (`join83`). ORBiT and UGX Requiem pass server-side; their *clients* stall in `CL_InitCGame` at ~1.5 GB RSS — the 32-bit address-space ceiling, i.e. the community's **LAA / 4 GB patch**, which the spec ruled out as an exe edit; on **our own game copy** it is a two-byte PE flag the launcher could set — decide. Four maps (Zombie Desert, Project Viking, MW2 Rust, Clinic of Evil) throw the identical `flag_wait` before `flag_init` on a **stock listen server too** — their `main()` starts flag threads before `_zombiemode::main()`; why the community plays them anyway is not established (is that error fatal only under `logfile`/dedicated?). Der Berg overflows `localVars` with all our code removed. Leviathan: `napalmblob`. Verdicts are in `archive/manifests/*.json`. Stock maps work.
- **Game over**: the referee now emits the full result + `match_end`, stops the replay, and the host agent finishes the match (above). Proven on the box with a real player (game id 2). Round 2 is unprovable unattended — nobody kills zombies.
- ~~The Hetzner box runs the pre-fix DLL~~ **Deployed.** A real client from B's PC joined the box over the internet, spawned, and the server survived the player joining and leaving: five gates over 300 s, 61 Hz. Host agent's game-over path (sign replay → post result → warm restart or terminate; box back to idle; 26/26 integration checks) landed in `a9f5d92` and **ran for real on the box**: a player from B's PC → game over → `match_end` → replay `m_5de3842b` signed and VALID → site game id 2 → instance warm for the next lease. **Per-player results**: the game now emits a roster (`player_connect/spawn/disconnect`, names on `game_over`, `join85`), but **identity is empty** — a real client's userinfo carries no steamid/xuid, only `bdTicket`; the referee must derive the Steam id from the invite token / `bdTicket` before anything is awarded.
- **Mouse stutter**: fix built, unproven; B's three runs decide.
- **`wait_for_first_player()`** never fires on a dedicated server; `all_players_connected` does.
- 2,270 archive maps have no cover; global chat has no page since the rail went; `/maps` is a
  second browser; neither repo has a LICENSE file (decide before any public push).

## Traps learned tonight (already in the lane docs)

- The shared git index: agents must `git commit --only <paths>`; two commits tonight carry another
  lane's diff (`5b3bd00`), content intact.
- `getstatus` answering proves nothing about simulation. Gate 5 exists for this.
- `SendInput` at 8 kHz is silently discarded on this box; only a real mouse tests the mouse path.
- `kill -9` on the box leaves `__CoDWaW` and hangs the next launch; the Wine path clears it.
- Steam's German-region accounts get depot 10097; `download_depot` of 10092 → missing license.

## 2026-09-22 late: the site went down with its shell (B could not play)

B opened the launcher after updating to 0.2.6 and got the built-in placeholder ("No site is
answering"). Cause: `zombies.enw.gg` is two processes on B's PC (node on 3200 + cloudflared) and
**nothing persistent was keeping them alive** - every `keepalive.ps1` run tonight was `-Once`, so
the site and the tunnel were children of whichever agent shell last restarted them, and died with
it (log: last start 18:38, dead by 19:00). Fixed two ways:

- The keepalive loop now runs **detached** (started via WMI, pid in `infra\keepalive.log`) and a
  shortcut in B's Startup folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ENW
  Zombies keepalive.lnk`) restarts it at logon. A scheduled task needs an elevated shell, which
  agents do not have. **Agents: never `-Once` as the only keepalive; if the loop is not running
  (`Get-Process powershell` with `keepalive.ps1` in the command line), start it detached.**
- **Launcher 0.2.7** (feed): a launcher opened while the site was down never connected the site
  API, reload button or not, so Play stayed dead until a restart. `reloadSite` now calls the
  extracted `connectSiteApi()` (stops a stale party watcher first). 124/0 tests.

B's step: restart the launcher (or Check for updates -> 0.2.7); the site pill must read
`site: 127.0.0.1:3200`, not `placeholder`.

## 2026-09-22 20:25: launcher 0.2.10 — nav clicks land; in-game name is the ENW name

On the feed (`latest.yml` 0.2.10, live tunnel 200 text/yaml), commit `5103c13`. Nav: the shell's hidden
`#chrome` strip was a drag region under the site and won `WM_NCHITTEST`; it is now `display:none`
while the site shows (the web-side underlay `2ff595c` alone does not fix it). Name: WaW sends the
active **profile's** name, not the `name` dvar — the launcher now names the profile after the ENW
name. DLL unchanged (0.2.8's). Unproven: a real mouse click in the packaged window, and `myu` over
B's head in a real game — B's first run. Detail: `docs/kickstart/launcher.md`.

## 2026-09-22 19:50: launcher 0.2.9 — no launcher bar; the site's nav is the title bar

Frameless window; the green top bar and theme are gone. Min/max/close live at the right of the
site's nav (launcher only, via `enw.win`); the nav is the drag region. Settings, client/update status,
Install and Restart-to-update are in the account menu; sign-in uses the launcher's Steam round trip;
reload is Ctrl+R / F5; an unreachable site shows a site-styled fallback. On the feed; packaged
window unproven until B updates. `launcher.md` 2026-09-22 evening, 0.2.9.

## 2026-09-22 19:35: launcher 0.2.8 — no cinematic over the game on a box join

The "intro over the HUD" was the map's **load video** (`<map>_load.bik`, open 28 s, level live at
3.3 s), not the startup intro, which never opens with our args. `connect_local` now waits for the
menu (floor 2 s, ceiling 30 s + WARN) and refuses the load video and its `default.bik` fallback for
a join. Proven in local join runs gate1..3; B's machine unproven. `client.md` §7.

## 2026-09-22 19:30: "Set Optimal Settings?" blocked a box instance — DLL fix built, not deployed

`no_msgbox.cpp` (dedi only, `ENW_NO_MSGBOX_HOOK=1` off) logs and auto-answers every engine
MessageBox; the settings prompt gets **No = keep saved settings** (verified at `0x5FE250`/`0x59C7C0`,
dedi.md §17). Dedi DLL `680ac0ae…` built from HEAD, staged on the box in `/tmp`; **box still runs
`318dfd60…`** because B was in a live game. *(Handoff 03:30: deployed 19:32 (`ca96f33`); the box is on `6b1ccfc5` now.)* Host-agent Escape belt covers it meanwhile.

## 2026-09-22: IP posture decided — nothing of Activision's served by us before public

B's decision, written up in `docs/kickstart/ip-posture.md` (not legal advice): Activision assets
reach a player only from their own WaW install, converted on their PC into
`%LOCALAPPDATA%\ENWZombies`; we serve our code/UI and community custom maps. **Closed-testing
carve-out**: the pre-baked Nacht `.glb` on `/mapdata` (currently public, gate-exempt) may stay
until the phase gate; the "Before public" checklist is ip-posture §9 = vault 99 §8 = 07 Track L.
Q-replay-2 resolved; Q-ip-1 (name) and Q-ip-2 (phase gate, legal contact) open for B.
