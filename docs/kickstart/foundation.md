# Foundation: build, deploy, launch, and what the game actually does

Owner: the **foundation** agent. Milestone **E1 — our DLL prints in the game console — is done.**

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

Nine components in both runs — ours plus `dedi`'s, `referee`'s and `host`'s, all picked up by the
CMake glob with no shared file edited by anybody.

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

### The main-thread pump, and its limit

`shared/core/components/main_thread.cpp` detours **`Dvar_FindVar` (0x5EDE30)** — verified,
trivially `__cdecl dvar*(const char*)` — and drains the scheduler and the game-link inbound queue
from it.

**Measured limit: the engine calls it ~90 times while booting and then essentially stops.** So this
is a *startup* pump, not a steady one. It is reliable enough that `post_init` always runs on the
game thread, but work queued with `scheduler::run_on_main()` after the game settles at the menu may
sit there indefinitely (the queue is bounded at 256 and drops oldest). Host commands (`exec`, `set`,
`pause`) will need something better.

**`Com_Frame` (0x59E330) measured zero calls — and the reason is the interesting bit.** I hooked
it; MinHook created and enabled the detour cleanly, the `E9` was verifiably still at the entry 20 s
later, and it ran **zero times**. `re` then found why (board 01:35, from live thread-stack samples
plus a static WinMain trace): **WinMain never reaches its loop.** `0x5FF4E0`, called at
`WinMain+0x199` right after `Com_Init` and *before* the loop at `0x5FF7B1`, runs renderer/D3D
bring-up unconditionally and is not gated by `com_dedicated`. Our solo runs stall in the same place,
on the *"Set Optimal Settings?"* modal. So there is **no per-frame tick of any kind, in any mode,
until that init is unblocked** — which is also `dedi`'s Stage C blocker. The address is right; the
loop is just never entered. `ENW_PUMP=frame` re-runs the experiment; it is off by default.

That attempt also cost the `referee` agent four minutes of silent breakage: **MinHook allows exactly
one hook per target address**, so my `MH_CreateHook(0x59E330)` won and theirs failed with
`already created`, turning their frame binding off with nothing but a log line to show for it.
Reverted; `frame=yes` confirmed back.

> **The two open items here.** (1) Bypass `0x5FF4E0` so WinMain reaches its loop — `re` has the
> exact site and `dedi` needs the same fix; then `Com_Frame` starts ticking and this whole caveat
> goes away. (2) The core should own that single hook and expose `on_frame(fn)` so components
> subscribe rather than race for the address — about 40 lines, and it makes this class of collision
> impossible. I have deliberately *not* built it unilaterally, because switching it on takes
> `Com_Frame` away from `referee` again. Nothing else depends on where `pump()` is called from.

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
| `game_link.hpp/.cpp` | the TCP NDJSON client |
| `json.hpp/.cpp`, `sha256.hpp/.cpp` | no-dependency helpers |
| `game.hpp/.cpp` | the two verified addresses, `console_print`, `find_dvar`, the verification report |
| `components/hello.cpp` | proof of life + the worked example to copy |
| `components/main_thread.cpp` | the pump |

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

**Blocking dialogs**, both Win32 `#32770`:

* *"Set Optimal Settings?"*. **`+set sys_configureGHz 1` does NOT suppress it** — I claimed it would
  and I was wrong. The engine overwrites the dvar with its own measured value
  (`dvar set sys_configureGHz 0.0297…` is the last line of console.log in every run) and shows the
  box anyway. **Every solo run so far has been sitting on this dialog**; the game never reaches the
  main menu. It does not block the DLL work — load, decrypt, verify, hook and print all happen
  around it — but do not assume you have a *running game*. `launch.ps1` now reports
  `MODAL DIALOG up (#32770 x1)` when one is present.
* *"Run In Safe Mode?"* after an unclean exit. The marker is
  **`%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW`, a 4-byte file holding the PID** of the running
  instance, written at startup and deleted on a clean exit (found by `dedi`). `launch.ps1` deletes it
  when the PID inside is dead — and **refuses to launch** when that PID is a live `CoDWaW`, which is
  also our cheapest guard against two instances.
* `dedi` also has a harness that answers either box with `PostMessage(hwnd, WM_COMMAND, IDNO=7, 0)`.

**Two instances at once: still untested**, and `__CoDWaW` being a single-instance marker is a
reason to expect trouble. Do not assume it works.

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
* **The component glob works better than expected.** `dedi`, `referee` and the others dropped files
  into `server/components/` and they were compiling into the DLL within minutes, with no shared file
  touched and no coordination. 9 components at last run.

## 10. Open items

1. **Bypass the renderer init at `0x5FF4E0`** so WinMain reaches its frame loop. Until then there is
   no per-frame tick at all and our pump is startup-only (§3). Shared blocker with `dedi`'s Stage C;
   `re` has the exact site.
2. **A core-owned frame hook with `on_frame(fn)` subscribers**, so components stop competing for one
   address under MinHook's one-hook-per-target rule. (foundation, on request)
2. **Two instances on one box** — untested, and `__CoDWaW` suggests it may fight.
3. **Per-instance profiles** — `fs_homepath` does not cover `players/`.
4. **Steam client per game box** — needs a decision from B (§8).
5. `launch.ps1` passes `+set developer 1` and `con_minicon 1`; nobody has checked whether those
   change engine behaviour in ways we would not want in a real server.
