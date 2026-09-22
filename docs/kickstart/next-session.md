# Next session — start here

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
