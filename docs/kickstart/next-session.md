# Next session — one page

Written 2026-09-22 at 09:00, after the game-over session. If this page and `../../STATUS.md` ever
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

## The six custom maps, measured

| Map | bsp | boots | client | R1 | R2 | verdict |
|---|---|---|---|---|---|---|
| Der Berg | `nazi_zombie_derberg` | yes, getstatus 3 s | no | no | no | **broken**: GSC `localVars` overflow stops the engine at 5.6 s (§13.2) |
| Leviathan | `nazi_zombie_leviathan` | loads, then GSC error | — | — | — | **broken**: `unknown item 'napalmblob'` in its own `_loadout::init_loadout()` |
| Zombie Desert | `nazi_zombie_test1` | loads, then GSC error | — | — | — | **broken**: `flag_wait` before `flag_init` (`level.flag` undefined) |
| Project Viking | `nazi_zombie_test` | loads, then GSC error | — | — | — | **broken**: same shape, `_zombiemode_ai_mech.gsc:38` |
| MW2 Rust | `mw2rust` | loads, then GSC error | — | — | — | **broken**: same shape, `mw2rust.gsc:179 flag_wait("electricity_on")` |
| Clinic of Evil | `sanatorium` | loads, then GSC error | — | — | — | **broken**: same shape, `_zombiemode_rotating_door.gsc:34` |

All six now get as far as `------ Server Initialization ------`, which is new — the mount fix did
that. All six then die in the map's own scripts. `status: "broken"` and the exact traceback are in
each `archive/manifests/<bsp>.json`. **`nazi_zombie_prototype` remains the only map that plays.**

## The next tasks, in order

1. **The host agent must answer `match_end`.** See above. Without it a finished game leaves an
   instance up for ever and the next lease never starts. `host.md`'s lane.
2. **Four maps die the same way and nobody has explained it.** `level.flag` is undefined when a
   map-provided script touches it, which means `maps/_load.gsc:97`'s
   `flag_init("all_players_connected")` has not run. All four ship their own `maps/_load.gsc`.
   It is **not** our overlay (we mount none), **not** `fs_game` (Der Berg answers getstatus with
   the same mount) and **not** a missing `.ff` (the console shows `Loading fastfile 'mod'` and the
   map fastfile on all four). The open question is why the same script survives on a listen
   server — and the cheapest way to answer it is **to run one of them on a listen server and
   diff the console**, which nobody has done.
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
