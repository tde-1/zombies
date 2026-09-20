# Foundation: build, deploy, launch, and what the game actually does

Owner: the **foundation** agent. Milestone **E1 — our DLL prints in the game console — is done**,
and as of 01:35 **a solo game reaches a playable state with our per-frame tick running.**

Evidence, from `C:\Users\b\ZombiesDev\homes\foundation\main\console.log` (the *engine's* own log,
written by the game, not by us):

```
Build 1263 JADAMS2 350073 CL(Thu Oct 29 15:43:55 2009)
logfile opened on Sun Sep 20 00:30:57 2026

[enw] game: engine up after 47 ms (dvar 'logfile' exists)
==============================================
[ENW]^7 enw_t4 online - 9 components
      steamstub    : ^2decrypted^7 after 140 ms
      Com_Printf   : 0059A2C0 ^2verified^7
      Dvar_FindVar : 005EDE30 ^2verified^7
      game-link    : ^2connected^7
==============================================
[ENW]^7 enw_t4 loaded - build Sep 20 2026 00:30:41, pid 26712
```

That run caught the whole banner. How much of a burst survives varies with the engine's
console-channel churn during startup (§3), so the loader also re-announces once after it settles,
which is the line you can rely on:

```
   4: [enw] game: dvar system up after 47 ms ('logfile' exists)
 179: [ENW]^7 enw_t4 online - 9 components
 185: [ENW]^7 enw_t4 ready - build Sep 20 2026 01:11:13, pid 26240
```

Nine components in those runs — eleven by the end — ours plus `dedi`'s, `referee`'s and `host`'s,
all picked up by the CMake glob with no shared file edited by anybody.

And the run that got all the way in:

```
 256: [ENW]^7 enw_t4 online - 11 components
 265: [ENW]^7 enw_t4 loaded - build Sep 20 2026 01:32:31, pid 21400
2520: [ENW]^7 enw_t4 ready  - build Sep 20 2026 01:32:31, pid 21400
2681: [ENW] frames=301 subs=1  main-thread jobs ran=23 dropped=0
```

`console.log` went from 12 KB to 242 KB in that run: D3D device created, the
`code_post_gfx`/`ui`/`localized_common`/`common`/`patch` fastfiles loaded, render targets, static
model cache and particle buffer initialised, main menu ticking.

---

## 0. One fact for the spec: the stock client phones Activision on every launch

With DNS filtering on, a plain solo startup produces:

```
net: BLOCKED a DNS lookup for 'cod5-pc.auth.mmp3.demonware.net'   (x4)
```

**Stock CoDWaW.exe resolves `cod5-pc.auth.mmp3.demonware.net` four times during startup, every
launch.** That is a live dependency on Activision/Demonware infrastructure for a game released in
2008, on a service that can be switched off without notice and which we do not control.

It is **provably not needed**: we block all four lookups and the game reaches the main menu, loads
its fastfiles, renders and ticks exactly as before (301 frames measured). Nothing in the solo path
cares.

Two consequences worth carrying into the spec:

* every ENW client should ship with this blocked, not merely firewalled, so our players never
  depend on a third party's auth server being up;
* if a future Demonware shutdown would have broken stock WaW, ENW clients would have kept working.
  That is a real argument for the product, and it is now measured rather than assumed.

The block costs one IAT slot (`WSOCK32` ordinal 52, `gethostbyname`) and no engine patching. See
§11.

---

## 0b. The 65-second freeze: an unfocused game stops ticking

**If you take one operational fact from this document, take this one.**

Parking the game window off-screen (§1) so it never interrupts B made the engine decide it was not
the foreground application, and **it stopped ticking about 65 seconds after spawn**. The referee ran
two 420-second captures and both produced *exactly* 65.2 s of gameplay and then silence: player
frozen at spawn on full health, zombies still at round-1 health, snaps and DLL log simply stopping.
Nothing errored. Nothing crashed. The process stayed alive.

Every unattended measurement on this project was silently capped at about a minute, and the only
reason it was caught is that two independent runs produced identical durations.

**The fix.** `CoDWaW.exe` imports `GetActiveWindow` and `GetForegroundWindow` from USER32 **by
name** (IAT slots 0x7EB338 and 0x7EB31C) — that is how it decides whether it has focus.
`shared/core/components/focus_guard.cpp` replaces both and answers with the game's own window
handle, so the engine always believes it is the active foreground application. No engine addresses,
nothing to re-verify when the binary moves, armed in `post_load` before any engine instruction runs.
It is not throwaway harness glue either: a trusted host running games nobody is looking at needs
exactly this behaviour.

Measured, before and after:

| | before | after |
|---|---|---|
| gameplay captured | 65.2 s, twice, identically | 150 s and counting |
| frame counter | stops | 745 → 9184, no gap |
| rate | — | steady 62.5 fps |

`ENW_FOCUS_GUARD=0` restores stock behaviour if you are ever chasing a focus-related bug.

**And a heartbeat, so this can never be silent again.**
`shared/core/components/heartbeat.cpp` logs one line every 15 s —
`heartbeat: still ticking at 45 s - 2636 frames total, 62.5 fps over the last 15 s` — and sends a
`perf` message over the game link. `launch.ps1` asserts on it: any run of 30 s or more whose last
heartbeat falls more than 25 s short prints `*** THE GAME STOPPED TICKING ***` in red with the
second it died. The referee needed two identical 420 s runs to notice the freeze; this needs one.

> Three bugs of mine while building that assert, all the same shape — **a diagnostic must never be
> able to break the run it is diagnosing**:
> 1. it first read the DLL log with `Select-String`, which opens deny-write. The game still had the
>    file open, so it threw, and under `ErrorActionPreference = 'Stop'` that skipped the kill —
>    leaving the game running and the lock held.
> 2. reading share-all still came back empty while the game held the file, so it reported
>    "NO HEARTBEAT" for a run that had seven of them. It now runs **after** the kill, when the file
>    is definitely closed, inside its own try/catch.
> 3. `powershell -File launch.ps1 -GameArgs '+map','x'` does not evaluate PowerShell syntax: the
>    whole thing arrives as one literal token and the engine says `Unknown command "map,x"`.
>    `launch.ps1` now splits GameArgs on commas and whitespace.

## 1. The commands

### From cold, on a machine that has none of this

```powershell
# 0. Prerequisites: VS BuildTools 18 with the v143/v145 x86 toolset, Steam installed
#    and logged in on an account that owns World at War (see section 8 -- the game
#    does not start without it), and Python 3 for the tooling scripts.

# 1. One-time: a full copy of the game that we are allowed to write into.
#    ~8.2 GB, a couple of minutes. The Steam folder is NEVER written to.
robocopy "C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War" `
         "C:\Users\b\ZombiesDev\waw-base" /S /E /DCOPY:DA /COPY:DAT /MT:16 /R:1 /W:1

# 2. Your own game copy: ~12 MB, junctions into waw-base for the big folders.
powershell -ExecutionPolicy Bypass -File tools\dev\new-copy.ps1 <yourname>

# 3. Build, deploy, run.
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1  -Name <yourname>
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 <yourname>
powershell -ExecutionPolicy Bypass -File tools\dev\launch.ps1 <yourname> -Role solo -TestSeconds 35
```

You should see `[ENW]^7 enw_t4 ready` in
`C:\Users\b\ZombiesDev\homes\<yourname>\main\console.log`. If you do, the whole chain works.

**Two things will bite you if you skip them.** The game must not already be running (the launcher
refuses, by design -- one game at a time). And if `build.ps1` fails on a file you did not write,
`-CoreOnly` excludes everyone else's components so you are not blocked by someone else's WIP.

**To develop without launching the game at all** -- which is most of the time --
`build\<name>\loadtest.exe` loads the DLL in a bare console process. Copy
`waw-base\binkw32.dll` next to it as `binkw32_org.dll` first (every export forwards there):

```powershell
.\build\<name>\loadtest.exe .\build\<name>\enw_t4.dll 5
```

Components register, logging works and the game-link connects; `steamstub` correctly reports
`.bind absent` and declines to touch memory. No game lock, no window, no Steam.

### Which build to use, and which is safe for a game B might start

| You want | Build | Why |
|---|---|---|
| **A game B is going to look at, or any run you want to trust** | `build.ps1 -Name you -CoreOnly` | Core only. Everything in this document is in it — the proxy loader, the frame tick, the Huffman guard, the focus guard, the heartbeat, `direct_connect`, the WinConsole refusal. **No other agent's work-in-progress can crash it.** Survives indefinitely: measured 270 s at a steady 62.5 fps, and a full build with the same core ran 540 s. |
| A client for the join test | `-CoreOnly` is enough | `direct_connect` lives in `shared/core/`, so core-only has it. Add client components only if you want the DNS filter, socket lockdown or the invite token. |
| Everything, to check the tree still compiles | `build.ps1 -Name you` (no switch) | Picks up `server/` and `client-dll/`. This is the one that breaks when somebody else's file does not compile. |

**`-CoreOnly` is the safe default.** If a run misbehaves, rebuild with it before blaming anything:
it is the difference between "our loader has a bug" and "somebody's component does".

The defaults in `launch.ps1` are all the safe ones and you should not normally override them:
invisible and never focus-stealing, modal dialogs answered, `developer 0` (see §7 — `developer 1`
makes a missing asset fatal), muted, 800x600, own `fs_homepath`, the game lock taken atomically,
and nothing reachable on the network but loopback and whatever you allow-list.

**Before you run anything**, know that the interlock will refuse you if a game is already running
anywhere on the box — that is deliberate, it names the PID, and `-Companion` is the supported way
to start a legitimate second instance.

### Reference

```powershell
# once per agent: a ~12 MB game copy (junctions into waw-base for the big folders)
powershell -ExecutionPolicy Bypass -File tools\dev\new-copy.ps1 <name>

# build the DLL (32-bit, MSVC, into build\<name>\)
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 -Name <name>

# install it into the copy as binkw32.dll (stock Bink -> binkw32_org.dll)
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 <name>

# run it: takes game.lock, windowed 800x600, muted, logs, returns the PID
powershell -ExecutionPolicy Bypass -File tools\dev\launch.ps1 <name> -Role solo -TestSeconds 35
```

Useful switches:

| Switch | Effect |
|---|---|
| `build.ps1 -CoreOnly` | leave out `server/` and `client-dll/` components — use when someone else's file breaks the build |
| `build.ps1 -Clean` / `-Config Debug` | as they sound |
| `deploy.ps1 <name> -Revert` | put the stock `binkw32.dll` back |
| `launch.ps1 -DryRun` | print the command line, start nothing |
| `launch.ps1 -Visible` | show the window. **Off by default** — see below |
| `launch.ps1 -TestSeconds N` | launch, report, kill our own PID, release the lock |
| `launch.ps1 -HomePath default` | use B's real profile dir instead of `homes\<name>` |
| `$env:ENW_LAUNCH_OK=0` | **kill switch** — `launch.ps1` then refuses to start the game at all |

**Launches are invisible by default.** B works at this machine, so `launch.ps1` sets
`vid_xpos/vid_ypos -4000` and then sweeps every top-level window owned by our PID — for the first
6 s and again throughout `-TestSeconds` — moving each one off-screen with
`SetWindowPos(... SWP_ASYNCWINDOWPOS)` and `ShowWindowAsync(SW_SHOWNOACTIVATE)` — the async
forms matter, see §9. Nothing
is ever raised or focused. That covers the splash (`CoD Splash Screen`), the render window and the
dedicated console (`Call of Duty WinConsole`); the repeated sweep also catches a window recreated by
a `vid_restart`. Modal `#32770` dialogs are deliberately left in place — someone may need to answer
one — and the launcher warns when one is up. Use `-Visible` only when you must watch it, and prefer
`launch.ps1` over starting the exe by hand.

Logs land in two places, and you want both:

* `C:\Users\b\ZombiesDev\logs\<name>\enw-<pid>.log` — ours, flushed per line.
* `C:\Users\b\ZombiesDev\homes\<name>\main\console.log` — the engine's.

## 2. Getting loaded: the proxy DLL

`CoDWaW.exe` imports 18 DLLs: `WINMM WSOCK32 faultrep binkw32 d3d9 d3dx9_37 DSOUND KERNEL32 USER32
GDI32 ADVAPI32 SHELL32 ole32 OLEAUT32 XINPUT1_3 PSAPI WS2_32 DDRAW`.

**We chose `binkw32.dll`** because it is the only one of those that already sits in the game folder,
so we shadow nothing system-wide, the original is right there to forward to, and it is a *static*
import — the loader resolves it before the PE entry point, which is the earliest possible foothold.
It has 71 exports on contiguous ordinals 1–71, all `_Name@N` stdcall.

`tools/dev/gen-proxy-def.py` reads the export table straight out of the PE (no dumpbin) and writes
`shared/core/proxy/binkw32.def`, 71 lines of `_BinkX@N = binkw32_org._BinkX@N @ordinal`. The linker
turns those into real PE forwarders, so the loader resolves them itself and the game never knows.
`deploy.ps1` renames the stock DLL to `binkw32_org.dll`, checking its SHA-256 against
`waw-base\binkw32.dll` first so it can never "back up" our own DLL over the real one.

To proxy something else instead, point the generator at another DLL and change one line in
`CMakeLists.txt`. Nothing else in the tree knows the proxy's name.

**Nothing is ever written to the Steam install.** `deploy.ps1` and `launch.ps1` both refuse paths
under `C:\Program Files (x86)\Steam\`.

## 3. Startup timing — the part that cost me three runs

This is the single most useful thing on this page.

| t | what |
|---|---|
| 0 ms | Windows loader resolves `binkw32.dll` → **our `DllMain`**. `.text` is still encrypted; every vault address is noise. We record the main thread id (DllMain runs on it) and start a loader thread. |
| ~0 ms | `post_load()` — components may start threads and read config. **No game memory.** |
| **~110–140 ms** | SteamStub finishes. `.text[0]` stops being `0x9EF490B8` and `0x401000` becomes real code. `post_unpack()` — patch and hook here. |
| | ...but **the engine has not started**. No console, no dvars, no filesystem. Console output at this point is discarded. |
| ~+45 ms | `Com_Init` has run; the dvar `logfile` exists. Not yet safe to print: the log file itself is not open. |
| ~+? ms | `sys_gpu` exists (system/renderer detection). `post_init()` — the first usable moment, and it runs **on the game's main thread**. |
| then | the *"Set Optimal Settings?"* modal appears and startup stops there (see §7). |

Four concrete gotchas:

1. **`post_unpack` is far too early for anything user-visible.** My first run printed a perfect
   banner into the void. If a human is meant to see it, it belongs in `post_init`.
2. **Com_Printf works off-thread** — 203 probe lines emitted from our own loader thread reached the
   engine's `console.log`. What is *not* reliable is the instant right after engine start, and the
   mechanism turned out to be simpler than "threads": **the engine opens
   `<fs_homepath>\main\console.log` partway through `Com_Init`, and anything printed before that
   is not in the file.** (It may still be in the in-game console buffer, which we cannot see with
   the window parked off-screen — so `console.log` is evidence of Com_Printf working, not a
   complete transcript.) `wait_for_engine()` therefore waits for the dvar `logfile` *and then* for
   `sys_gpu`, which is registered during system/renderer detection, comfortably after the file is
   open. `post_init` is still marshalled onto the main thread, because host commands need to be
   there regardless.
3. **Channels 0–6 all appear in `console.log`; channel 7 produces nothing.** (Probe: 8 channels ×
   30 rounds.) `console_print()` uses channel 0.
4. **A burst of lines during startup is only partly kept.** The engine adds and hides console
   channels while it execs `default.cfg` / `language.cfg` / the profile config, and the filter state
   moves underneath us. Measured across five runs, between **1 and 7 of the same 7 banner lines**
   reached `console.log` — same code, same build. Nothing is broken; the printing works every time.
   If you need a line to be *seen*, emit it after the churn: the loader re-announces once, three
   seconds after `post_init`, for exactly this reason.

### The per-frame tick (core-owned) and the main-thread pump

**`shared/core/frame.hpp` owns the tick. Components subscribe; nobody hooks `Com_Frame`.**
That is now rule 12 in `docs/dev-box.md`, because MinHook allows exactly one hook per target and the
loser only finds out from a log line — I cost `referee` four minutes of their frame binding proving
it.

```cpp
#include "frame.hpp"
enw::frame::subscribe("my_thing", [](uint64_t n) { /* main thread, frame boundary */ });
```

**How the core takes it, and why that matters to you:** we do *not* detour `Com_Frame`. We retarget
WinMain's `call Com_Frame` instruction at **0x5FF7BD** (the call site `re` published) to our own
stub, which calls the real `Com_Frame` and then dispatches to subscribers. `Com_Frame`'s own bytes
are untouched, so `dedicated`'s MinHook detour on it keeps working alongside us. Rewriting one rel32
cannot collide with anything and relocates no instructions — it is the safer primitive and this is
exactly what it is for.

Callbacks are SEH-guarded. One that faults is logged once and **unsubscribed**, rather than being
allowed to fault every frame forever.

Measured: **301 frames by t+5.5 s** in a solo run, `main-thread jobs ran=23 dropped=0`. Steady-state
`scheduler::run_on_main()` and inbound game-link commands work off this.

**When it does not tick.** `post_init` runs ~200 ms in, while the renderer is still coming up, so
zero frames at that point is normal and the log says so. It is *permanently* zero in **dedicated**
mode: `0x5FF4E0` (renderer/D3D bring-up, called at `WinMain+0x199`, before the loop, and **not**
gated by `com_dedicated`) never completes, so WinMain never reaches its loop. That is `dedi`'s
Stage C blocker and `re` has the exact site.

**The startup pump.** Before the frame loop runs there is still work to marshal (`post_init` itself),
so `components/main_thread.cpp` also detours **`Dvar_FindVar`** — verified, trivially
`__cdecl dvar*(const char*)`, called ~2000 times while the engine boots and then essentially never.
It is a startup pump only, and it exists purely to get `post_init` onto the game thread. Everything
after that should use `frame::subscribe`.

## 4. Addresses verified on B's exe

`CoDWaW.exe`, SHA-256 `732900d1…f408a7d64d` (matches the vault), image base `0x400000`, no ASLR,
`.text` at `0x401000` + `0x3E99FF`, `.bind` present (SteamStub v2), PE entry point `0x4EBB2ED`
(inside `.bind`, i.e. the stub's).

| Symbol | Address | First 16 bytes after decryption | Reading |
|---|---|---|---|
| `Com_Printf` | `0x59A2C0` | `B8 00 10 00 00 E8 46 5C 21 00 8B 8C 24 08 10 00` | `mov eax,0x1000; call __chkstk; mov ecx,[esp+0x1008]` — a 4 KB stack frame and **arg 2** picked up, exactly right for `Com_Printf(int channel, const char* fmt, ...)`, `__cdecl`. **Confirmed working.** |
| `Dvar_FindVar` | `0x5EDE30` | `56 57 B8 3C CF 1A 02 B9 01 00 00 00 F0 0F C1 08` | `push esi; push edi; mov eax,0x21ACF3C; mov ecx,1; lock xadd [eax],ecx` — takes a lock at `0x21ACF3C`, so it is **thread-safe by construction**. **Confirmed working.** |
| `0x401000` | — | `55 8B EC 83 E4 F8 D9 45 08 D9 E1 8B E5 5D C3 CC` | a tiny float `fabs` helper. Good decryption canary. |

Everything else in vault §2 is still unverified — that is `re`'s job.

## 5. What is in `shared/core/`

| File | What |
|---|---|
| `dllmain.cpp` | DllMain → loader thread → the four phases |
| `component.hpp/.cpp` | self-registering components (`ENW_REGISTER_COMPONENT`), iw4x-sp style, each phase SEH-guarded so one component cannot kill the others |
| `steamstub.hpp/.cpp` | the decrypt wait; never decrypts or modifies anything itself |
| `memory.hpp/.cpp` | sections, protection, patch/nop, **`retarget_call`/`retarget_jmp`** (rewrite an existing rel32 — safer than a detour and exactly what the vault's "detour site" addresses want), `find_pattern`, `looks_like_function`, `hex_dump` |
| `hook.hpp/.cpp` | RAII wrapper over MinHook; refuses to hook anything that does not look like code |
| `logger.hpp/.cpp` | file + `OutputDebugString` + game console, flushed per line |
| `scheduler.hpp/.cpp` | `run_on_main()` + `pump()` |
| `frame.hpp/.cpp` | **the core-owned per-frame tick**; `subscribe()`/`unsubscribe()` |
| `game_link.hpp/.cpp` | the TCP NDJSON client |
| `json.hpp/.cpp`, `sha256.hpp/.cpp` | no-dependency helpers |
| `game.hpp/.cpp` | the two verified addresses, `console_print`, `find_dvar`, the verification report |
| `components/hello.cpp` | proof of life + the worked example to copy |
| `components/main_thread.cpp` | the startup pump (Dvar_FindVar) |
| `components/frame_dispatch.cpp` | installs the tick and reports on it |
| `components/instance_paths.cpp` | per-instance profile via an IAT patch (off by default) |
| `components/huffman_guard.cpp` | **the bounded compressed-message decode** (§11) |
| `components/no_winconsole.cpp` | refuses the dedicated server's console window (IAT; written, not yet verified live) |
| `components/direct_connect.cpp` | the getAuthTicket short-circuit (see below) |
| `components/focus_guard.cpp` | **keeps the engine ticking when unfocused** (see the top) |
| `components/heartbeat.cpp` | one "still ticking" line every 15 s, and a `perf` message |
| `components/userinfo_guard.cpp` | sanitises player names and userinfo every frame (§11) |

`thirdparty/minhook/` is vendored verbatim (BSD-2-Clause, `LICENSE.txt` and `VENDORED-FROM.txt`
kept, upstream `8af6b4ac`). It brings its own length disassembler, which is the whole reason we are
not hand-rolling a 5-byte detour that corrupts whatever straddles byte 5.

## 6. The game-link client

`docs/protocol/game-link-v0.md`, game side. Tested end to end against a real NDJSON server before it
ever went near the game.

* One background thread; `send()` never touches the socket, just a queue.
* **Backpressure follows the protocol's revised rule** (`host`, 2026-09-20): only `snap`, `input`
  and `perf` are resampleable and may be shed. Everything else is EVIDENCE — dropping a `round`
  makes the referee award the wrong badge, silently — so `send_line(obj, droppable=false)` defaults
  to keeping it. Past the soft limit (4096) we shed the oldest *resampleable* message and otherwise
  let the queue grow; only at a hard ceiling (65536) is evidence dropped, with an `ENW_ERROR` and a
  separate `dropped_evidence` counter that should always read 0. Use `send_sample(w)` for the three
  droppable types. We never block the caller — it can be the game thread, and stalling a frame is
  worse than a growing queue.
* Reconnect with exponential backoff, 250 ms → 10 s. `hello` on every connect.
* `hello` carries `v, t, ms, instance, role, pid, exe_sha256, dll_build` — the SHA-256 is of the live
  exe, computed on the link thread, so the host can prove what is running.
* Inbound: NDJSON lines → dispatch by `t`; unknown `t` ignored (the protocol's forward-compat rule);
  a line over 1 MB with no newline drops the connection.
* Handlers default to running on the **game thread** via the scheduler; pass
  `want_game_thread=false` for something genuinely thread-safe.
* `ENW_HOST` absent ⇒ the link stays dormant and says so. That is normal for a hand-launched game.

Observed round trip: `hello` out, `say` and `exec` in, `reply` out.

## 7. Dev copies, `fs_homepath`, dialogs

**Copies run.** A junction copy at `C:\Users\b\ZombiesDev\waw-<name>` boots normally; no SteamStub
bounce back to the Steam folder was ever observed once the environment was right.

**The SteamStub trap** (found by `dedi`): a copied exe launched with no Steam hints exits(0) after
~1.5 s having written nothing — the stub asks Steam to relaunch app 10090 from the *Steam* folder.
`new-copy.ps1` drops `steam_appid.txt` and `launch.ps1` sets `SteamAppId=10090` and
`SteamGameId=10090`. With those, copies run. (Which of the three is strictly required was not
isolated; all three are cheap.)

**`fs_homepath` works, for `main` only.** `+set fs_homepath <dir>` puts `<dir>/main` first on the
search path and writes `console.log` there. It does **not** move the profile: the search path still
shows `%LOCALAPPDATA%\Activision\CoDWaW/players` and the game loads B's `anna-jpg` profile. Setting
the `LOCALAPPDATA` env var does not help either (`dedi` tested it — the engine uses
`SHGetFolderPath`, not `getenv`). **So instances get their own `main` and logs but share one
profile.** Per-instance user data still needs an answer.

Pre-create `<fs_homepath>\main\` or you may get no `console.log` at all: two runs with identical
`+set logfile 2` differed only in whether that folder already existed, and the one without it wrote
nothing. Unproven as cause, but the fix is free and both scripts now do it.

**Blocking dialogs — solved, and they were the reason no solo run ever reached the game.**
`launch.ps1` now answers them by default (`-KeepDialogs` opts out). It reads each `#32770`'s title,
body text and button ids, picks the most conservative button available (**No > Cancel > OK**) and
`PostMessage`s `WM_COMMAND`. PostMessage is asynchronous, so a wedged UI thread cannot hang us.

```
dialog answered: 'Set Optimal Settings?' >> No [6:Yes 7:No]
```

* *"Set Optimal Settings?"* on first run. **`+set sys_configureGHz 1` does NOT suppress it** — I
  claimed it would and I was wrong; the engine overwrites the dvar with its own measured value.
  Answering No keeps the settings we passed on the command line. Once answered, the engine persists
  the result and does not ask again.
* *"Run In Safe Mode?"* after an unclean exit. The marker is
  **`%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW`, a 4-byte file holding the PID** of the running
  instance, written at startup and deleted on a clean exit (found by `dedi`). `launch.ps1` deletes
  it when the PID inside is dead — and **refuses to launch** when that PID is a live `CoDWaW`,
  which is also our cheapest guard against two instances.

**The other thing in the way was ours.** With `+set developer 1`, a missing-asset *warning* becomes
a fatal modal error, and stock WaW is missing `images/sun_flare.iwi`. Startup died there every
single run, right after the D3D device came up. `developer` is now **0 by default**; `-Developer`
opts in. This is rule 13 in `docs/dev-box.md`. I had flagged `developer 1` as an unchecked risk in
my own open-items list several hours before it bit me, which is its own lesson.

All window handling is time-boxed at 2 s. Past that the launcher disables it for the rest of the
run and says so loudly, rather than holding `game.lock` (see §9).

### The interlock (changed — read this if you launch the game)

`__CoDWaW` used to be doing two jobs: the safe-mode crash marker *and*, in practice, the only thing
stopping two agents launching at once. That was fine until per-instance profiles moved it, which
would have removed the guard silently. **`game.lock` now does the job properly**, and it no longer
depends on any engine behaviour:

1. **a live `CoDWaW`/`CoDWaWmp` process anywhere on the box refuses the launch**, found by
   enumerating processes rather than by reading a file the game owns — so it works whatever the
   profile layout is. The refusal names the offending PID;
2. **the lock is acquired atomically** (`FileMode.CreateNew`, which fails if the file exists)
   instead of the old test-then-write, which two launchers could both win;
3. a lock whose PID is dead, or that is older than 15 minutes, or that is stuck on `starting` for
   more than 2 minutes (a launcher that died between taking the lock and writing its PID), is
   stale and gets taken once, loudly.

The `__CoDWaW` check is still there as belt and braces, and now clears the per-instance copy too.

**Two instances at once: still untested.** The interlock is what would have to be relaxed to try
it, and it is deliberately the one place to change.

### Per-instance user data (designed, implemented, NOT yet proven)

`fs_homepath` only moves `main/`, and setting `LOCALAPPDATA` does nothing because the engine asks
the shell, not the environment. Several games per box is in the cost model, so this needs solving.

**The mechanism.** `CoDWaW.exe` imports **`SHGetFolderPathA`** from SHELL32 (confirmed in the
import table) and appends the literal `\Activision\CoDWaW` to whatever it returns (that string is
at `0x47EC90`). So we replace that one import-table entry and hand back a per-instance directory
for the AppData CSIDLs. The engine then builds `<ours>\Activision\CoDWaW\players\...` itself, and
the profile, `mods/` and the `__CoDWaW` marker all become per-instance for free.

**Why an IAT patch rather than a detour, and why this is the only thing that can work.** The IAT
lives in `.rdata`, which SteamStub does not encrypt, and the Windows loader fills it in *before* the
PE entry point runs. So it can be installed at `post_load` — before the game's code is decrypted
and before any engine code executes. That matters, because the profile path is resolved during very
early init, quite possibly before `post_unpack`. Nothing that needs decrypted code could get there
in time. It is also a single pointer write with no prologue to relocate, and trivially reversible.

Implemented in `shared/core/components/instance_paths.cpp`, plus `memory::hook_import()` /
`memory::find_import()`. **Off by default**: set `ENW_PRIVATE_PROFILE=1` and
`ENW_INSTANCE_APPDATA=<dir>`.

**How confident am I?**

* *Mechanism — high.* The import is really there, the suffix string is really there, IAT patching
  before the entry point is standard and we already do PE parsing for `.text`/`.bind`. The component
  counts its own hits and says plainly if the engine never came through `SHGetFolderPathA`, so a
  wrong assumption reports itself instead of silently sharing a profile.
* *Completeness — medium.* I have not proven the engine resolves the profile *only* this way. It
  may cache the path elsewhere, or use the registry `installpath`, or the Demonware/profile code may
  have its own route. The hit counter will tell us on the first real run.
* *Second-order effects — low confidence, and this is the part to watch.* A fresh AppData means **no
  profile**, which will trigger whatever first-run profile flow exists (possibly another modal).
  The directory should be seeded by copying B's existing `players\` on first use; `new-copy.ps1`
  does not do that yet. And making `__CoDWaW` per-instance removes the single-instance interlock,
  which is probably what unblocks several games per box — but "probably" is doing real work in that
  sentence, and it is also the interlock that currently stops two agents colliding.

**Untested end to end**, because until the startup dialogs were being answered no run ever reached a
state where the profile mattered. It is ready to test on the next run that wants it.

## 8. Does any of this need the Steam client?

**The DLL does not. The game does.**

Our half — proxy load, the decrypt *wait*, logging, components, the link — needs only the game
files. `loadtest.exe` (built alongside the DLL) `LoadLibrary`s `enw_t4.dll` in a plain console
process with no game and no Steam, and everything comes up: components register, the link connects,
`steamstub` correctly reports `.bind absent` and declines to touch memory.

But `CoDWaW.exe` itself is SteamStub-wrapped. The PE entry point is `0x4EBB2ED`, inside `.bind`;
that stub talks to the local Steam client to validate ownership of app 10090 and to get the key that
decrypts `.text`. **On a box with no Steam client:**

* The failure is in the stub, at the entry point — *before* `WinMain`, before any engine code.
* Our `DllMain` still runs (static imports resolve first), so we would load and log normally.
* `.text[0]` would stay `0x9EF490B8` forever. `wait_for_decrypt()` would time out at 60 s, log
  `STILL ENCRYPTED`, skip every component that touches game memory, and keep the link alive.
* The process would most likely exit within a couple of seconds anyway, as the stub asks Steam to
  relaunch it.

So **yes: every box that runs the game needs a Steam client, logged in, on an account that owns
World at War.** Steam *offline mode* should be fine — the client caches licences — but that has not
been tested here. Consequences worth deciding early:

* Each production game box needs its own Steam install and an account with a WaW licence. That is a
  per-box cost and an account-management problem at scale, and it interacts badly with "spin up an
  hourly cloud box on demand".
* Concurrent instances on one box share one Steam client; whether SteamStub tolerates several
  simultaneous decryptions of the same app is untested (see §7 — we have not run two at all yet).
* The alternatives are all worse or off-limits: retail discs are SafeDisc; dumping the decrypted
  `.text` and shipping it is redistributing Activision code and is **out of the question** (vault
  rule 7 — it is exactly what T4M-Enhanced does and why we do not take its code).

This deserves a decision from B before anyone designs the leasing flow. Logged in `questions.md`.

## 9. Things that surprised me

* **SteamStub is fast and boring.** 110–140 ms, entirely reliable across every run, marker exactly
  as the vault said. It was never the hard part. The hard part was that it finishes so early that
  "the game is decrypted" and "the game exists" are two very different moments.
* **The two public addresses were right.** Both `Com_Printf` and `Dvar_FindVar` matched their vault
  values on our exe and their disassembly reads exactly as the signature predicts.
* **A `std::mutex` in a logger is a trap.** Mirroring log lines to the game console *while holding
  the logger lock* deadlocked the game the moment `console_print` tried to log its own failure. The
  symptom was the worst kind: the game hung with no last log line and no crash. Mirroring now happens
  outside the lock, with a thread-local re-entrancy guard.
* **Swallowing an SEH exception silently cost an hour.** The first `console_print` nulled its
  function pointer on fault and said nothing, which turned "Com_Printf crashed" into "Com_Printf
  quietly does nothing" — an indistinguishable and much more confusing symptom. It now logs the fault
  code, the thread, and how many faults before it gives up.
* **`SetWindowPos` is a synchronous cross-process call, and it will hang you.** Parking the game
  window off-screen looked like three lines. It sends `WM_WINDOWPOSCHANGING` to the target's UI
  thread and blocks until that thread answers — and a game that is loading, or sitting on a modal
  dialog, does not answer. The launcher sat there for **703 seconds** with the game still up and the
  game lock still held. `SWP_ASYNCWINDOWPOS` + `ShowWindowAsync` post instead of send; the whole
  sweep now takes 1–4 ms. If you ever touch another process's windows, use the async forms.
* **`+set developer 1` cost me the whole evening.** It promotes a missing-asset *warning* to a
  fatal modal error, and stock WaW is missing `images/sun_flare.iwi` — so startup died right after
  the D3D device came up, every single run, and I spent hours reading that as "the engine stalls
  during init". The worst part: I had listed `developer 1` as an unchecked risk in my own open-items
  section hours earlier and did not go back to it. When something fails in a way you cannot explain,
  re-read the flags you yourself added before theorising about the other party's code.
* **A dialog nobody can see still blocks everything.** Parking windows off-screen was right for B,
  but it also meant the modal that was stopping every run was invisible to me; I only found it
  because the launcher counted `#32770` windows. Reading the dialog's title, body and button ids
  turned a week-long mystery into one line: `'Set Optimal Settings?' >> No [6:Yes 7:No]`. If you
  automate a GUI into invisibility, make it narrate.
* **The component glob works better than expected.** `dedi`, `referee` and the others dropped files
  into `server/components/` and they were compiling into the DLL within minutes, with no shared file
  touched and no coordination. 9 components at last run.

## 10. Open items

Blocked on `re`, in the order they unblock things:

1. **What does the server licence check at 0x48A250 compare?** (`CHALLENGERESPONSE: Got server
   licenseid %llx`.) If that cannot be satisfied legitimately it is the real obstacle in the
   product, not a detail. Highest priority.
2. **A userinfo write seam** — `Dvar_SetStringByName`, `Dvar_RegisterString` plus the USERINFO bit
   proven from an instruction, or `Cbuf_AddText`. Single blocker on invite-token joins.
3. **Argument lists for `CL_ConnectionlessPacket` (0x643380), `SV_ConnectionlessPacket` (0x634E90)
   and `SV_DirectConnect` (0x62E3A0)**, for the OOB lockdown and direct connect.
4. **The `dvar_s` layout**, for the saved-dvar / `activeAction` / `bind` guard (security item 5).
5. **Bypass the renderer init at 0x5FF4E0** so WinMain reaches its loop in *dedicated* mode. Solo
   gets there (301 frames measured); a dedicated server never does. Shared with `dedi`.

Ours:

6. **Prove the per-instance profile.** Implemented, seeded by `new-copy.ps1`, and now safe to try:
   `game.lock` is the interlock, so `-PrivateProfile` no longer removes the collision guard.
7. **Two instances on one box** — still untested; the interlock is the one place to relax.
8. **Steam client per game box** — with B as a business decision (§8). Nobody is to test offline
   mode; that is B's to do.
9. **`referee` and `dedi` to migrate to `frame::subscribe`** when convenient. No collision either
   way: the core holds the call site, not `Com_Frame` itself.
10. **`con_minicon 1`** is still passed by `launch.ps1` and nobody has checked what it changes. Its
    neighbour `developer 1` cost us the evening, so this deserves five minutes.

## 11. Client side: joining (started)

`client-dll/` is mine; `server/components/` stays `dedi`'s and `referee`'s. Everything here reuses
`shared/core` rather than forking it.

### Security 1 — the bounded Huffman decode (done, armed)

`shared/core/components/huffman_guard.cpp`. It lives in the shared core because it protects the
server *and* the client with one hook.

`re`'s audit had the defect right and I confirmed it from our own dump, but **one detail in the
audit is wrong and it matters**: the audit says the decoder "receives a capacity argument (0x20000)
from both callers but ignores it". It receives no such argument. Reading 0x6751D0:

```
83 EC 08 53 55  8B 6C 24 14   sub esp,8; push ebx; push ebp; mov ebp,[esp+14h]
8B F0  8B F9                  mov esi,eax ; mov edi,ecx
...
8D 1C F5 00000000             lea ebx,[esi*8]      ; total_bits = 8 * src_len
88 16 / 83 C6 01              mov [esi],dl ; add esi,1
39 5C 24 10 / 7C DA           cmp [esp+10h],ebx ; jl   <- consumed bits only
2B C5                         sub eax,ebp          ; returns bytes written
```

So the real signature is `int f(int src_len /*eax*/, const void* src /*ecx*/, void* dst /*[esp+4]*/)`
— three parameters, compiler-chosen convention, every `ret` is `C3` so the caller cleans the one
stack argument. That makes it *worse* than the audit says: the function cannot bound its output
even in principle, so the fix has to be outside it.

**What we do:** interpose with a naked stub (no C++ convention can express eax/ecx/stack), decode
into our own scratch instead of the caller's buffer, and copy back at most 0x20000. The scratch is
8× the maximum input — the provable worst case, since a symbol is at least one bit — and is
followed by a `PAGE_NOACCESS` guard page, so if that reasoning is ever wrong we take a clean access
violation inside our own allocation instead of silently corrupting the game's `.data`. An overlong
decode copies nothing, returns 0 and logs loudly; failing closed is right, because a message that
expands past the window is not one we want parsed.

### ENW-only networking (partly done)

`client-dll/components/network.cpp`.

**Every socket function in the exe is imported by ORDINAL, not by name** — WSOCK32 ordinals
2,3,4,9,10,12,14,16,17,19,20,21,23,52,57,111,115 plus five from WS2_32. A name-based IAT hook finds
nothing, which is why `memory::hook_import_ordinal()` now exists. **Ordinal 52 is `gethostbyname`**,
and it is the single chokepoint for every name the game resolves. Replacing that one slot needs no
game code patched and no decrypted image, so it is armed in `post_load` before any engine
instruction runs.

It immediately earned its place. On a stock startup:

```
net: BLOCKED a DNS lookup for 'cod5-pc.auth.mmp3.demonware.net'   (x4)
```

The client tries to reach Activision's auth infrastructure on every launch. `*.activision.com`,
`*.demonware.net` and `*.treyarch.com` are blocked unconditionally; `-StrictNet` denies anything
not in `-AllowedHosts` (default `.enw.gg`); every lookup is logged either way.

### Locking where the game may talk (vault security item 4, done)

Same component, same technique, ordinals **20 (`sendto`)** and **4 (`connect`)**. Every outbound
packet leaves through one of those two, so enforcing there is **strictly stronger than locking the
`connect` console command**: it does not matter how the game is persuaded to connect — a console
command, a menu, a redirect inside a `connectResponse`, a stray `reconnect` — traffic only goes to
addresses the launcher named (`-AllowedAddrs`, plus loopback always).

Permissive by default: every new destination is logged once, so we learn what the game actually
talks to before we start dropping anything. `-StrictNet` enforces. A blocked `sendto` returns the
length as if it had sent, rather than an error, because error paths in the engine are code we have
not audited and a silent drop is the safer refusal.

This also blunts most of what the OOB filter is for: a hostile connectionless packet from an
address we do not talk to cannot get a reply out of us.

### No in-game downloads (item 6)

`cl_allowDownload 0` on the launcher's command line, and the destination lockdown above means a
download could not reach a non-allow-listed host even if something re-enabled it. iw4x's
`Download.cpp` extension/path checks are not ported and are not needed while the transport is
closed; they become relevant if we ever turn FastDL on.

### Names and userinfo (item 7, done)

`shared/core/components/userinfo_guard.cpp`. A connecting client controls its own `name` and its
whole `userinfo`, and both end up in console prints, the scoreboard, the game log, and in
backslash-delimited info strings that other code re-parses. The classic Q3-lineage bugs are a quote
or a backslash in a name (injects a key into an info string), a control character or newline
(forges a line in the game log — and IW4MAdmin-style parsers read that log), and a `%` (reaches a
printf-family format eventually).

We sanitise from the **frame tick**, sweeping the four client slots, because we have verified
offsets (`svs` 0x23D5C80, `svs.clients` +0x171410, stride 0x58D30, `userinfo` +0x6F0, `name`
+0x11548) but no verified signature for `SV_DirectConnect`. A hostile name therefore exists for at
most one frame before it is fixed, and this needs no new addresses. When `re` lands
`SV_DirectConnect`, the same check should move earlier; the sanitiser itself will not change.

**The safety rule in that file matters:** it only ever replaces bytes in place or shortens, never
grows a string. We do not know either buffer's exact capacity, so nothing there can overflow one
even if an offset turns out to be wrong — the worst case is a few harmless characters written over
something that was not what we thought. Backslashes are scrubbed from **names** (they are
structural in info strings) but deliberately **not** from `userinfo`, where they are the separators.

### Still not done, and why

* **The OOB packet filter** (`CL_ConnectionlessPacket` 0x643380). I read the prologue — a
  0x464-byte frame, register-passed state, at least one stack argument — and stopped. A wrong
  detour on the connectionless path is an intermittent crash hours later, so I want the argument
  list from `re` first.
* **The saved-dvar / `activeAction` / `bind` guard (item 5).** This one genuinely needs something
  we do not have: the `dvar_s` layout, or a dvar setter. `re` established that an enum dvar's value
  sits at `+0x10` (WinMain reads `com_dedicated` that way), which is a start, but I am not writing
  into dvar internals off a single offset inferred from a single call site. Needs
  `Dvar_SetStringByName` / `Dvar_RegisterString`, or `dvar_s` in `shared/t4/structs.hpp`.

### The invite token (done, via the engine's front door)

`client-dll/components/auth_token.cpp`. `launch.ps1 -AuthToken <t>` passes it in the
**environment**, never argv: a command line is readable by every other process on the box and ends
up in logs and crash dumps. The DLL reads it once in `post_load`, checks the `<b64url>.<b64url>`
shape, and then **clears the environment variable** so it is neither inherited by a child nor
visible to anything walking our environment afterwards. It is never logged — only fingerprinted
(`eyJ2Ij...VzdA (122 chars)`) — and it is zeroed at shutdown.

**Getting it into userinfo.** `re` supplied `DVAR_FLAG_USERINFO = 0x2` (proven from the resend gate
at 0x644B64 on `dvar_modifiedFlags` 0x21ACF30) and `Dvar_RegisterString` at 0x5EED90. I did not
call that function. Its prologue shows an `ebp` frame taking arguments at +0x08, +0x0C, +0x10,
**+0x14 (8 bytes)**, **+0x1C (8 bytes)**, +0x24, +0x28 and +0x2C — it is the generic
register-with-domain helper rather than a four-argument string register, and an eight-argument
layout inferred from a prologue is exactly the kind of guess that corrupts the dvar system quietly.

So we use the engine's own front door. `setu` is precisely the command that registers a USERINFO
dvar, so the engine sets flag 0x2 itself and resends userinfo without us writing to
`dvar_modifiedFlags` at all:

1. `post_load` (before any engine code runs) writes one line —
   `setu enw_token "<token>"` — into `<fs_homepath>\main\enw_auth.cfg`;
2. the launcher passes `+exec enw_auth.cfg`, so **argv carries only the filename**;
3. `post_init` overwrites and deletes the file, then calls `find_dvar("enw_token")` and reports
   plainly whether the dvar actually registered. Verified, not assumed.

When `re` hands over the full `Dvar_RegisterString` prototype this collapses into a direct call and
the file disappears.

### Direct connect — done, one site, five bytes

`re` traced the join path and found the client's licence check is not a wall: it parses, stores and
logs the server's 64-bit licenceId and never validates it. What gates a connect is the Demonware
**`getAuthTicket` (0x57C0E0)** call the client makes before sending `connect`, which `Com_Error`s
`PATCH_SERVER_AUTHFAIL` on failure — and that is the `demonware.net` traffic §0 shows us blocking.

**The part that would have sunk the join test.** The guard is narrower than "it's on my machine".
From our own dump at 0x642E4C:

```
mov  eax, [0x300FFF8]   ; netadr.type
cmp  eax, 2             ; NA_LOOPBACK -> skip the auth block
je   skip
test eax, eax           ; NA_BOT (0)  -> skip
je   skip
```

NA_LOOPBACK is the engine's **in-process** loopback, a listen server talking to its own client.
**A second process on the same box is NA_IP (4), even at 127.0.0.1.** So a two-instance test on one
machine takes the auth path in full, calls a service that has been dead for years, and fails in a
way that looks precisely like a networking bug.

**The fix**, `shared/core/components/direct_connect.cpp`, at 0x642E77:

```
E8 64 92 F3 FF   call 0x57C0E0     ->    B0 01 90 90 90   mov al, 1 ; nop x3
```

The two arguments are pushed before the call and cleaned by the `add esp, 8` after it, so replacing
only the call keeps the stack balanced; the result is read as `test al, al; jne ok`, so a non-zero
`al` takes the success path and skips the `Com_Error`. The component verifies both the five bytes
and that the call target really is `getAuthTicket` before writing anything, and refuses loudly
otherwise. `ENW_DIRECT_CONNECT=0` disables it.

Confirmed live: `direct_connect: getAuthTicket short-circuited at 00642E77`.

It lives in `shared/core` rather than `client-dll` deliberately — the join test uses a core-only
build, and a dedicated server never executes `CL_SendConnectPacket`, so the patch is inert there.

**This is not DRM.** SteamStub is the copy protection and we never touch it; we wait for it
(`steamstub.cpp`). This is the online-services auth ticket for joining a game server, for a service
that no longer exists, on servers we run ourselves — vault 99 §5.1's direct-connect patch.

> Pairs with §0: with ENW-only networking on, the DNS block makes `getAuthTicket` fail faster. The
> short-circuit and the DNS block are two halves of one change and must ship together.

### Survival: the ~70 s crash is not ours

Two controls, both `+map nazi_zombie_prototype`, both with the focus guard in:

| build | components | duration | result |
|---|---|---|---|
| core-only | 8, no server components at all | **270 s** | steady 62.5 fps, 16,761 frames, no crash |
| full | 19, `referee/bind: notify=yes` and notify entries firing | **540 s** | steady 62.5 fps, 33,559 frames, no crash |

So a stock-plus-core client survives well past 70 s, and so did a build with `referee`'s notify hook
live. Stated plainly: the 540 s run had `scriptvars=no` and `dvars=no`, so those paths were not
exercised — but "a notify hook exists" is not sufficient to cause the crash.


**Running two instances.** The interlock refuses a second launch by design. `-Companion` is the
supported way round it for a server+client test: it requires a live, fresh `game.lock` to exist
(so it cannot be used to bypass the interlock), joins that experiment instead of taking a lock,
leaves the lock for the holder to release, and tolerates the first instance owning the `__CoDWaW`
marker. Use that rather than habitually passing `-ForceLock`.
