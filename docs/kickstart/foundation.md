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

## 1. The commands

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

**Two instances at once: still untested****Two instances at once: still untested**, and `__CoDWaW` being a single-instance marker is a
reason to expect trouble. Do not assume it works.


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
PE entry point runs. So it can be installed at `post_load` \u2014 before the game's code is decrypted
and before any engine code executes. That matters, because the profile path is resolved during very
early init, quite possibly before `post_unpack`. Nothing that needs decrypted code could get there
in time. It is also a single pointer write with no prologue to relocate, and trivially reversible.

Implemented in `shared/core/components/instance_paths.cpp`, plus `memory::hook_import()` /
`memory::find_import()`. **Off by default**: set `ENW_PRIVATE_PROFILE=1` and
`ENW_INSTANCE_APPDATA=<dir>`.

**How confident am I?**

* *Mechanism \u2014 high.* The import is really there, the suffix string is really there, IAT patching
  before the entry point is standard and we already do PE parsing for `.text`/`.bind`. The component
  counts its own hits and says plainly if the engine never came through `SHGetFolderPathA`, so a
  wrong assumption reports itself instead of silently sharing a profile.
* *Completeness \u2014 medium.* I have not proven the engine resolves the profile *only* this way. It
  may cache the path elsewhere, or use the registry `installpath`, or the Demonware/profile code may
  have its own route. The hit counter will tell us on the first real run.
* *Second-order effects \u2014 low confidence, and this is the part to watch.* A fresh AppData means **no
  profile**, which will trigger whatever first-run profile flow exists (possibly another modal).
  The directory should be seeded by copying B's existing `players\` on first use; `new-copy.ps1`
  does not do that yet. And making `__CoDWaW` per-instance removes the single-instance interlock,
  which is probably what unblocks several games per box \u2014 but "probably" is doing real work in that
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

1. **Bypass the renderer init at `0x5FF4E0`** so WinMain reaches its loop in *dedicated* mode. Solo
   gets there fine (301 frames measured); a dedicated server never does. Shared blocker with
   `dedi`'s Stage C; `re` has the exact site.
2. **`re`: a userinfo write seam** — `Dvar_SetStringByName`, `Dvar_RegisterString` + the USERINFO
   flag, or `Cbuf_AddText`. This is the single blocker on invite-token joins (§11).
3. **`re`: argument lists for `CL_ConnectionlessPacket` (0x643380), `SV_ConnectionlessPacket`
   (0x634E90) and `SV_DirectConnect` (0x62E3A0)**, so the OOB lockdown and direct connect can be
   hooked rather than guessed at (§11).
4. **`dedi`: a listener**, then the two-instance test as one experiment under one lock.
5. **Prove the per-instance profile.** Implemented and now seeded by `new-copy.ps1`, but never run.
   **Replace the `__CoDWaW` interlock first** — turning on `ENW_PRIVATE_PROFILE=1` moves that file
   per-instance and silently disables the only thing currently stopping two launches colliding.
   `game.lock` should take that job properly.
6. **Two instances on one box** — still untested, and gated on item 5.
7. **Steam client per game box** — with B as a business decision (§8). Nobody is to test offline
   mode; that is B's to do.
8. **`referee` and `dedi` to migrate to `frame::subscribe`** when convenient. No collision either
   way: the core holds the call site, not `Com_Frame` itself.
9. `con_minicon 1` is still passed by `launch.ps1` and nobody has checked what it changes. Its
   neighbour `developer 1` cost us the evening, so this deserves five minutes.

## 11. Client side: joining (started)

`client-dll/` is mine; `server/components/` stays `dedi`'s and `referee`'s. Everything here reuses
`shared/core` rather than forking it.

### Security 1 \u2014 the bounded Huffman decode (done, armed)

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
\u2014 three parameters, compiler-chosen convention, every `ret` is `C3` so the caller cleans the one
stack argument. That makes it *worse* than the audit says: the function cannot bound its output
even in principle, so the fix has to be outside it.

**What we do:** interpose with a naked stub (no C++ convention can express eax/ecx/stack), decode
into our own scratch instead of the caller's buffer, and copy back at most 0x20000. The scratch is
8\u00d7 the maximum input \u2014 the provable worst case, since a symbol is at least one bit \u2014 and is
followed by a `PAGE_NOACCESS` guard page, so if that reasoning is ever wrong we take a clean access
violation inside our own allocation instead of silently corrupting the game's `.data`. An overlong
decode copies nothing, returns 0 and logs loudly; failing closed is right, because a message that
expands past the window is not one we want parsed.

### ENW-only networking (partly done)

`client-dll/components/network.cpp`.

**Every socket function in the exe is imported by ORDINAL, not by name** \u2014 WSOCK32 ordinals
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

**Not done:** the OOB packet filter (`CL_ConnectionlessPacket` 0x643380) and the
`connect`/`reconnect` lockdown. I read the prologue \u2014 a 0x464-byte frame, register-passed state
and at least one stack argument \u2014 and stopped. A wrong detour on the connectionless path is an
intermittent crash hours later, so I want the argument list from `re` first.

### The invite token (plumbed, one gap)

`client-dll/components/auth_token.cpp`. `launch.ps1 -AuthToken <t>` passes it in the
**environment**, never argv: a command line is readable by every other process on the box and ends
up in logs and crash dumps. The DLL reads it once in `post_load`, checks the `<b64url>.<b64url>`
shape, and then **clears the environment variable** so it is neither inherited by a child nor
visible to anything walking our environment afterwards. It is never logged \u2014 only fingerprinted
(`eyJ2Ij...VzdA (122 chars)`), and it is zeroed at shutdown.

**The gap:** getting it into userinfo. That needs `Dvar_SetStringByName`, or `Dvar_RegisterString`
plus the USERINFO flag value, or `Cbuf_AddText` (to run `setu enw_token <v>`). `Dvar_FindVar` and
`Dvar_RegisterBool/Enum` are verified; none of those are. The component warns every run rather
than failing quietly.

### Direct connect (not started \u2014 blocked)

Blocked on two things, neither of them mine to decide: the signatures above, and `dedi` having a
listener. The T4 handshake, from strings in the exe:

| Direction | String | Address |
|---|---|---|
| client \u2192 server | `getchallenge 0 "%s"` | 0x48A14C |
| server \u2192 client | `challengeResponse %i %s` | 0x486B98 |
| client \u2192 server | `connect ` + userinfo | 0x48A1AC |
| server \u2192 client | `connectResponse %s` | 0x48705C |
| server reject | `rejected connect from protocol version %i (should be %i)` | 0x486D2C |

The one that stands out: `CHALLENGERESPONSE: Got server licenseid %llx` (0x48A250). The T4 client
checks a **server licence id** in the challenge response, which iw4x's `connect_coop` has no
equivalent of. That is probably the real obstacle to direct connect here, and it is worth
understanding before anyone starts flipping protocol-version comparisons.

