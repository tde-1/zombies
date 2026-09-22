# Next session — one page

Written 2026-09-22 at 06:30, after the frame-rate work. If this page and `../../STATUS.md` ever
disagree, STATUS wins; it is rewritten at the end of every session.

## Read this first, because it changes what you think is true

**The headless server still stops simulating about fifty seconds after a player spawns.** It no
longer *freezes* — the temp-stack fix is real and stands — but the engine's frame body stops
returning, `com_frameTime` stops advancing, and `SV_Frame` therefore never runs again. Full
evidence, with run tags: `dedi.md` §11.1.

The thing that hid this is worth knowing: **`jointest-proof.ps1` passes in exactly this state.**
All four of its gates — `CS_ACTIVE`, `referee: ROUND 1`, every `getstatus` answered,
`frame::count` still moving — are true on a server that has not simulated a frame in two minutes.
`ROUND 1` fires seconds after the spawn and `getstatus` is answered on the raw path. **Add a fifth
gate: `com_frameTime` (`[0x1F9648C]`) must still be moving at the end.** That is one read and it
would have caught this two sessions ago.

What the "~5,900 Hz frame rate" actually was: every frame entering the body and none returning.
It was never a pacing-arithmetic bug — the body clamps its own target to 1 ms, so with
`timeBeginPeriod(1)` it cannot exceed ~1,000 Hz however `com_maxfps` reads.

## What was finished

- **The CPU is fixed.** `frame_pacing.cpp` now also paces in WinMain's loop, outside `Com_Frame`,
  where nothing can jump over it. A populated server holds **59.4 Hz at 1.4–1.8% of one core**
  (`join57`, `join59`) where it used to burn ~84%. `ENW_DEDI_NO_OUTER_PACE=1` is the control.
- **Two candidate causes of the escape are dead**, measured, so do not re-derive them: it is
  **not** `longjmp` (0x7AD57C hooked, zero calls in two runs; its only three callers are
  `Com_Error`, `Sys_Error` and the script VM's 0x693CF0), and it is **not** an SEH unwind (a
  vectored handler sees only `DBG_PRINTEXCEPTION_C`, one per escaped frame). It is also not
  nesting — the stack would be gone in a minute.
- **Der Berg boots headless and answers `getstatus`** with `fs_game=mods/nazi_zombie_derberg`.
  It was failing on *our* command line, not its own script.
- **Custom-map verdicts are in the manifests.** `archive/manifests/<bsp>.json` gained
  `dedi_status` and a dated note; three maps are `map_error`, two are `untested` because the
  failure was ours.
- **`replay.cpp`** now emits `kill`, `zombies_alive`, `kills_round`, `round` on every snap, and
  `stance`, and `weapon` is a string like everything else on disk.

## The next tasks, in order

1. **Find what resets the stack.** `ENW_DEDI_ESCAPE_PROBE=1` already records the ESP each
   `Com_EventLoop` entry is made with, and counts in/out. If ESP is identical across escaped
   frames, something restores a saved stack pointer without going through `longjmp`; if it marches
   down, they are nesting after all and the process should be dying. That one number chooses the
   next move. Everything else is downstream: no `SV_Frame` means no round 2, no game over, no
   replay body, and no custom map surviving a client.
2. **Round 2 is blocked on (1), not on the referee.** A dev knob that ends a round still has to be
   executed by a script VM the server has stopped ticking. None was used tonight.
3. **Two custom maps are ours to fix, cheaply.** Zombie Desert and Project Viking die on
   `fs_game is write protected.` before the map loads, while other maps in the same batch were
   fine — leftover homepath state, because `config.cfg` archives `fs_game`. Clear
   `<fs_homepath>\main\config.cfg` before each launch and re-run `maptest.ps1`.
4. **Leviathan's `unknown item 'napalmblob'` is not the asset limit.** The 422 MB reserve is now
   implemented (`big_heap.cpp`, `ENW_DEDI_BIG_HEAP=1`) and makes no difference to it. Next lead is
   which zone should carry that weapon.

## How to run things

```powershell
cd C:\Users\b\Desktop\Zombies
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1  -Name dedi
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 d2 -From dedi

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
| `ENW_DEDI_ESCAPE_PROBE=1` | wrap `call Com_EventLoop` at 0x59DD90, hook `longjmp`, install a vectored exception handler. The instrument for task 1 |
| `ENW_DEDI_NO_OUTER_PACE=1` | turn the new WinMain-level pacer off; the 5,300 Hz spin comes back |
| `ENW_DEDI_BIG_HEAP=1` | main memory reserve 300 MB → 422 MB |
| `ENW_DEDI_NO_TEMP_GUARD=1` | turn the temp-stack fix off; the freeze comes back (`join54`) |
| `ENW_DEDI_NO_RATE_PROBE=1` | stop the five-second counter line |

## Which logs to read, in this order

All under `C:\Users\b\ZombiesDev\logs\dedi\`, collected at the end of every run.

| File | What it answers |
|---|---|
| `joinNN.txt` | The transcript. The `t=` lines carry CPU and RSS every 5 s — **read them with `frame::count`, never alone** |
| `joinNN.server.enw.log` | Ours. `CS_ACTIVE`, `referee: ROUND 1`, `dedi_rate_probe` (the four counters), `dedi_frame_escape`, and **the first `=== Com_Error TRAPPED ===` — `arg3` is the message** |
| `mapNN.<bsp>.enw.log` | Per-map boot. Same: read the **first** trapped error, not the last |
| `joinNN.server.console.log` | The engine's own words, including the GSC call stack above a script error |

## Traps that have already cost this project time

Everything in the previous edition of this page still holds. Four new ones:

- **A passing `jointest-proof.ps1` does not mean the server is simulating.** See the top of this
  page. Gate on `com_frameTime` too.
- **`Exceeded limit of 1 'snddriverglobals' assets` is a symptom, never the first cause.** Every
  custom-map failure ends there: the real error raises an `ERR_DROP`, the drop sends the engine
  back to the front end, the front end re-loads `mod.ff`, the second load of the same mod trips the
  singleton limit, and *that* raises `Sys_Error` and parks the thread. It looks exactly like the
  `ENW_PRIVATE_PROFILE` failure and is not it. Read the first trapped `Com_Error`.
- **`+set con_typewriterColorBase "1.0 1.0 1.0"` is load-bearing on custom maps.** Leave it out and
  a map's `_load.gsc` raises `SetSavedDvar(): The dvar ... does not exist` and the server script
  dies at load. That alone was Der Berg's "broken map".
- **`shared/t4/addresses.hpp` :: `t4::mem` holds instruction starts, not operand starts.** The
  immediates are at +1, +6, +6 — the vault's original numbers. `big_heap.cpp` §"CORRECTION" has the
  bytes. The guard caught it; a patch written on assumption would have written 422 MB over an
  opcode.

## Do not touch

The Steam install. `CoDWaWmp.exe`. Port 3200 and the `cloudflared` tunnel. `web/data`. Any PID you
did not start. Full list: `../dev-box.md`.
