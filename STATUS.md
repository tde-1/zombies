# Where things stand — 2026-09-23, morning

> **This file is the current state of the code.** Design and decision history: the Obsidian vault at
> `C:\Users\b\Desktop\shared-notes\ENW COD Zombies` (`19 - Build Log`). A new agent reads
> `docs/kickstart/README.md`, then `docs/kickstart/next-session.md`. **Every lane doc has a dated
> section for the night of 2026-09-22/23** — read the newest section of the lane you are in.

## B: do this first (the morning checklist)

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

## Since the morning checklist was written (afternoon)

- **Isolation rule, done and proven**: our session redirects the game's LocalAppData into `%LOCALAPPDATA%\ENWZombies\home\localappdata` (DLL `enw_localappdata.cpp`); maps, config, saves, profiles all live there; B's `Activision\CoDWaW` tree is byte-identical before/after a Play Local. B's own mods folder was cleaned into `ZombiesDevackup-user-mods-20260923\`.
- **LAA / 4 GB flag: impossible on the Steam exe.** SteamStub refuses a flagged exe (`Application load error 3:0000065432`, measured). ORBiT and UGX Requiem clients therefore still stall at ~1.6 GB. The launcher refuses to flag any exe with a `.bind` section.
- **Player identity**: only the site's signed invite token; parsed at connect, verified by the host, forged → kicked in 27 ms; `identity: none|claimed|verified|refused`; the integration test scores 2 players.
- **`flag_wait` is fatal on a stock listen game too**; the fatal script arrives in an add-on IWD (`zombie_hitmarker_bythesuzho.iwd`) our archive install ships — an agent is stripping add-ons and retesting the four maps.
- **0.2.2** on the feed: LAA plumbing (off), isolation, `enw-zombies://map|party` deep links, Check for updates.
- **Web pass done** (`406607b`): Movement's list/card views, home rows from a table, one theme, Maps · Records · Admin nav, search top-left, user dropdown, browser Play → `/download`. `npm test` 120/0.
- **Box redeployed with the identity build** (`403b150`): DLL `318dfd60…` in every game copy on the box, host agent shipped, 46/46, box idle, `play: true`. A forged token against the live key → `identity refused` → kicked in 129 ms. **Bug found**: `host.js` took `requireToken` from the `--site` argument, not `cfg.site`, so the env-configured box had been advisory-only all evening; running with `--require-token true` until the one-line fix lands (evening agent).
- **Host rows** (`9506d04`): `identity` travels with the result, `steamid` only when verified; `end` carries the next match id; a warm instance took a second lease (integration 36/0).
- **Evening (B, 2026-09-22)**: three agents running for a friends' party game in two hours — the real launcher path against the box, the replay viewer live on the site for Nacht, and cross-server chat (Movement's port + game-event lines + Discord link; in-game T overlay planned in `docs/kickstart/chat-overlay.md`). Custom map for tonight is held for the add-on IWD retest. Read the newest section of `launcher.md`, `replay.md`, `web.md`, `archive.md`.

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
