# Next session — one page

Written 2026-09-22 at 07:25, after the frame-escape fix. If this page and `../../STATUS.md` ever
disagree, STATUS wins; it is rewritten at the end of every session.

## Read this first, because it changes what you think is true

**The headless server simulates.** A real client connects, spawns, plays round one, the game
ends, and the server is still running three hundred seconds later with the client attached.
Two consecutive clean runs, five gates each: `dedi.md` §12.3.

```
join65 / join66   CS_ACTIVE, ROUND 1, 76 of 76 getstatus answered,
                  com_frameTime 321,127 ms and still advancing,
                  Com_Frame-body 59.0 Hz, client slot 0 CS_ACTIVE at the end,
                  4-6% of one core, RSS flat 188 MB          PASS / PASS
```

**What it was.** Every escaped frame was an **SEH unwind out of an access violation at
0x006F3E6A**, once per frame: a NULL read through the **water simulation's** ping-pong buffers
at 0x4DD0A10 / 0x4DD4AF0. Those are allocated by 0x6F13B0, reached only from the renderer's
dynamic-buffer bring-up — which `dedicated.cpp` skips on purpose. The `r_watersim_*` dvars are
why nobody looked: the prefix says renderer, but the **server** samples the water surface when a
player is near it. `watersim_pool.cpp` calls the engine's own allocator once, from the first
frame. Two megabytes, zeroed, guarded, self-verifying, `ENW_DEDI_NO_WATERSIM_POOL=1` to undo.

**`dedi.md` §11.2 is retracted in place.** "It is not an SEH unwind" was wrong, and it was wrong
for a reason worth carrying: the vectored handler logged only its **first six** exceptions, and
the first six of any run are init-time debug prints. The access violations start at #124.

**The harness has its fifth gate.** `jointest-proof.ps1` now fails a run whose engine has
stopped. Do **not** gate on the rate probe's own `delta=` field — it reads 0 on a healthy
server. Gate on `Com_Frame-body > 0 Hz` and on `com_frameTime` advancing **between** lines.

## What else was finished

- **`no_save_reload.cpp`.** With the server simulating, the game reaches game over — and T4's
  single-player death flow reloads a save that a dedicated server never wrote, which was an
  `ERR_DROP` and took the server with it. The `call G_Error` at 0x62C10D is now a counting
  `ret`, verified against the caller's own `add esp, 8`. **It does not restart the round.** It
  means you can now see what happens *after* game over. `ENW_DEDI_ALLOW_SAVE_RELOAD=1` is the
  control.
- **`jointest.ps1` collected the wrong console log.** `join59.server.console.log` is
  byte-identical to the client's: `$conSub` was built from `fs_game` and the server's console
  had moved. The dedicated server's own console output had never been read on a custom-map run.
  It now searches the home, takes the newest, and prints (and checks) the `Working directory:`
  line inside it.
- **`frame_escape_probe.cpp`** gained the three instruments that named the bug: a logging
  `__except` filter around `Com_EventLoop` (`seh-through` — the number that settled it), a
  wrapper on `Com_EventLoop`'s own `call Sys_GetEvent` (which cleared the message pump), and the
  faulting registers plus stack chain for the first six non-debug-print exceptions.

## The next tasks, in order

1. **Der Berg stops 5.6 s in, on a different fault — go and get it.** Same mechanism
   (`join68`: `seh-through` = `MISSING`, `Sys_GetEvent` in == out, `longjmps=0`), different
   address: **0x005FFE23**, `mov ecx, [0x3BFD478]` / `cmp byte [ecx+0x10], 0` with `ecx` NULL —
   **a dvar pointer the dedicated server never registered**, read on a socket-error path in the
   packet receive (0x5FFDB0, from Com_EventLoop's tail). Find out which dvar `[0x3BFD478]` is
   and register it the way `dedicated.cpp` already handles three others. Do not patch the read.
   `dedi.md` §12.5.
2. **Round 2 is no longer blocked on the frame loop.** `SV_Frame` runs now. What actually
   happens is that an idle client dies in round one, so a round-2 measurement needs either a
   client that moves or the knobs lane's zombie-health dial. That is a real experiment, not a
   blocked one.
3. **Decide what a dedicated server does at game over.** Right now: nothing. The save reload is
   suppressed, the round does not restart, the client stays connected in a finished game. A
   `map_restart` is the obvious answer and nobody has tried it.
4. **Two custom maps are still ours to fix, cheaply.** Zombie Desert and Project Viking die on
   `fs_game is write protected.` before the map loads. Clear `<fs_homepath>\main\config.cfg`
   before each launch and re-run `maptest.ps1`.
5. **Leviathan's `unknown item 'napalmblob'` is not the asset limit** — the 422 MB reserve
   (`big_heap.cpp`) makes no difference. Next lead is which zone should carry that weapon.

## How to run things

```powershell
cd C:\Users\b\Desktop\Zombies
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1  -Name dedi
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 d2 -From dedi

# the acceptance test -- five gates, and it means it now
powershell -ExecutionPolicy Bypass -File tools\dev\jointest-proof.ps1 -Tag joinNN -Watch 300

# one join run, stock map
powershell -ExecutionPolicy Bypass -File tools\dev\jointest.ps1 -Tag joinNN

# a custom map: -FsGame defaults to 'auto' = mods/<map> for anything not stock
powershell -ExecutionPolicy Bypass -File tools\dev\jointest.ps1 -Tag joinNN -Map nazi_zombie_derberg

# boot a list of maps headless, ~80 s each, no client
powershell -ExecutionPolicy Bypass -File tools\dev\maptest.ps1 -Tag mapNN -BigHeap
```

Environment switches, all off by default:

| | |
|---|---|
| `ENW_DEDI_NO_WATERSIM_POOL=1` | do not allocate the water-sim buffers. The escape of §11.1 comes straight back — the control for the fix |
| `ENW_DEDI_ALLOW_SAVE_RELOAD=1` | let `SV_LoadGame` raise its `ERR_DROP`; the server dies at game over |
| `ENW_DEDI_ESCAPE_PROBE=1` | the instrument: wrap `call Com_EventLoop` 0x59DD90 and `call Sys_GetEvent` 0x59B647, hook `longjmp`, install a VEH, log the faulting context. **Use this for task 1** |
| `ENW_DEDI_CATCH_ESCAPE=1` | with the probe on, our `__except` claims the exception instead of passing it on. A control, never a fix |
| `ENW_DEDI_NO_OUTER_PACE=1` | turn the WinMain-level pacer off |
| `ENW_DEDI_BIG_HEAP=1` | main memory reserve 300 MB → 422 MB |
| `ENW_DEDI_NO_TEMP_GUARD=1` | turn the temp-stack fix off; the freeze comes back (`join54`) |
| `ENW_DEDI_NO_RATE_PROBE=1` | stop the five-second counter line — **and with it the fifth proof gate** |

## Which logs to read, in this order

All under `C:\Users\b\ZombiesDev\logs\dedi\`, collected at the end of every run.

| File | What it answers |
|---|---|
| `joinNN-proof.txt` | The verdict and, on a failure, `failed gates:` naming which one |
| `joinNN.txt` | The transcript. `t=` lines carry CPU and RSS every 5 s — **read them with `frame::count`** |
| `joinNN.server.enw.log` | Ours. `dedi_rate_probe` (**`Com_Frame-body` and `com_frameTime` are the health of the engine**), `dedi_watersim_pool`, `dedi_frame_escape`, and the first `=== Com_Error TRAPPED ===` — `arg3` is the message |
| `joinNN.server.console.log` | The engine's own words. The collector now prints the path and the `Working directory:` it found; check it says `waw-d2` |

## Traps that have already cost this project time

Everything in the previous edition still holds. Five that are new or sharpened:

- **A vectored exception handler that logs is a loop.** The ENW logger goes out through
  `OutputDebugString`, which raises `DBG_PRINTEXCEPTION_C`, which the handler logs. `join60`
  nested 28 deep in three milliseconds and the server never answered. Guard for re-entrancy and
  ignore strings that look like ours.
- **Never budget a diagnostic by "the first N events".** Six exceptions of budget bought six
  init-time debug prints and cost a session; the access violations began at #124.
- **`r_` does not mean "renderer only".** The water simulation is sampled by the server.
  Anything the renderer-skip leaves unallocated is a candidate for the same class of bug, and
  the next one (task 1) is an unregistered dvar on the same principle.
- **`Exceeded limit of 1 'snddriverglobals' assets` is a symptom, never the first cause.** Still
  true, and §12.3 shows it downstream of `Unable to find save.` Read the *first* trapped error.
- **A green harness is only as honest as its gates.** Four gates passed for three sessions on a
  server that had not simulated in two minutes. If a run looks too good, ask which number would
  have moved.

## Do not touch

The Steam install. `CoDWaWmp.exe`. Port 3200 and the `cloudflared` tunnel. `web/data`. The
Hetzner box. Any PID you did not start. Full list: `../dev-box.md`.
