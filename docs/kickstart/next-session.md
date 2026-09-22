# Next session — one page

Written 2026-09-22 after the join runs, rewritten at 04:55 once the freeze was fixed. If this page
and `../../STATUS.md` ever disagree, STATUS wins; it is rewritten at the end of every session.

## What was just finished

**The freeze is fixed.** The headless dedicated server now survives a real client spawning in: two
consecutive 120 s runs (`join52`, `join53`) with `CS_ACTIVE`, `referee: ROUND 1`, every
`oob.py getstatus` answered and `frame::count` still advancing at the end.

It was never a script-variable bug. The server **leaks one 0x20000 frame of the engine's
temp-memory stack per client message**, so the destination it decodes that message into
(`0x0212B2F8 + [0x046E5054]`) marches forward through the process 128 KB at a time and eventually
writes straight through `gScrVarGlob`'s child-variable pool. The endless predecessor walk in
`0x0068F090` is what happens the next time a variable hashes into a stomped slot. Full story with
every run tag: `dedi.md` §7j, section **"SOLVED (runs join31-join54)"**.

The fix is `server/components/dedicated/temp_stack_guard.cpp`: at the end of every frame, if the
temp-stack offset is above the baseline the component measured at its own first frame tick, put it
back. Safe because at a frame boundary nothing holds a temp frame — measured, not assumed.
`ENW_DEDI_NO_TEMP_GUARD=1` turns it off and the freeze comes straight back (`join54`: frozen at
frame 2200, 22 damaged slots).

Also landed: `tools/dev/varcheck.py` (checks the variable pool's chain invariant from outside the
process, and prints `[0x046E5054]` beside it), `server/components/dedicated/var_watch.cpp`
(hardware write watchpoints, `ENW_DEDI_VARWATCH=1`, off by default), and
`tools/dev/jointest-proof.ps1` (the acceptance test — a 120 s jointest with `getstatus` polled
throughout, printing PASS or FAIL).

## The next tasks

1. **Round 2 and beyond.** Milestone (d) is done and the server survives it. Nothing has ever
   watched an unattended game past round 1 — `TESTME.md` is the test and it needs B at the keyboard.
2. **The ~5,900 Hz frame rate.** With no player the server holds a flat 61 Hz with
   `+set com_maxfps 60`. Once a player is in it ramps to ~100 Hz and then, later in the run, to
   about **5,900 Hz at 70% of one core**. This predates the fix — the same ramp (61 → 102 → 123 Hz)
   is in every run right up to the moment it used to freeze — and the server answers, spawns and
   referees correctly throughout, but it is wrong and nobody has looked at it.
3. **Why the engine's own pop is skipped.** Every return path in `SV_ExecuteClientMessage`
   0x630F70 writes `[0x046E5054]` back, no `Com_Error` is raised (`error_trap.cpp` counted zero in
   the whole of `join44`), and the function returns. `ENW_DEDI_TEMP_THUNK=1` wraps the tail jump at
   0x6357AA and corrects the offset across that call: **2,502 wrapped calls, 0 corrections**, while
   the frame-boundary reset put 2,034 frames back in the same run. So the unpopped push is reached
   some other way. The guard works regardless; this is a loose end, not a risk.
4. **`wait_for_first_player()`** is still waiting while `all_players_connected` fires. Unchanged by
   any of this, still unproven — test it before believing it.

## How to prove it still works

```powershell
cd C:\Users\b\Desktop\Zombies
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 -Name dedi
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 d2 -From dedi
powershell -ExecutionPolicy Bypass -File tools\dev\jointest-proof.ps1 -Tag joinNN
```

It waits for `game.lock` rather than taking it from anyone, runs one 120 s `jointest`, polls
`oob.py getstatus` every 3 s throughout, and prints **PASS** only if the client reached `CS_ACTIVE`,
the referee logged `ROUND 1`, no probe went unanswered and `frame::count` was still moving at the
end. To watch the variable pool at the same time, run
`python tools\dev\varcheck.py <pid> --watch 100` against the server PID out of `game.lock`; a clean
run reports `orphans 0` throughout and `temp +0x0`.

## Reproduce a plain join run

One command. It takes `game.lock` once for both processes, launches the server, waits until it
actually answers on the wire, then launches a client at it, and kills only its own two PIDs.

```powershell
cd C:\Users\b\Desktop\Zombies
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 -Name dedi
powershell -ExecutionPolicy Bypass -File tools\dev\jointest.ps1 -Tag join19
```

Defaults are server copy `waw-d2` from `build\dedi`, client copy `waw-c1` with its DLL left alone,
`nazi_zombie_prototype`, udp 28960, 120 s of watching. `-NoDeploy` skips the deploy.
`jointest.ps1` already passes `+set com_maxfps 60` — do not remove it, see the traps below.

## Which logs to read, in this order

All under `C:\Users\b\ZombiesDev\logs\dedi\`, collected automatically at the end of the run.

| File | What it answers |
|---|---|
| `join19.txt` | The transcript. Did the server answer the wire? The `t=` lines carry CPU and RSS every 5 s — **read them with `frame::count`, never alone** |
| `join19.server.enw.log` | Ours. `Going from CS_CLIENTLOADING to CS_ACTIVE`, `join_probe:` slot state, `referee: ROUND 1`, `frame::count`. This is the file that says whether the spawn worked |
| `join19.server.console.log` | The engine's own words: GSC runtime errors, `Sys_Error`, `G_WriteGame`, the `dvar set cl_network_warning 0` run that precedes every freeze |
| `join19.client.console.log` | Only when the *client* is the suspect. `Server connection timed out` here means the client gave up, not that the server failed |

Quick check that a run spawned at all:

```powershell
Select-String -Path C:\Users\b\ZombiesDev\logs\dedi\join19.server.enw.log `
  -Pattern 'CS_CLIENTLOADING to CS_ACTIVE','ROUND 1'
```

## Traps that have already cost this project time

- **"getstatus is unanswered" is not "the server froze" until it has answered once.** A server
  still loading the map answers nothing either. A detector that skipped that check called a freeze
  at t=5 s in a perfectly healthy run and sent a probe at a busy process for nothing.
- **`SV_ExecuteClientMessage` 0x630F70 does not preserve EBX** (its prologue pushes only ebp, esi,
  edi). A thunk that parked a value in EBX across the call compared against whatever the callee had
  left there and reported "balanced" 2,503 times out of 2,503. Park values on the stack, not in a
  callee-saved register you have not checked.
- **The `dvar set cl_network_warning 0` run at the end of every pre-fix console log was a red
  herring.** It is the server sending the client an ordinary per-frame server command; it is in the
  healthy logs too, it was simply the last thing printed because everything else had stopped.
- **T4 has no `CS_PRIMED`.** The middle state is `CS_CLIENTLOADING` (value 3). `CS_PRIMED` is
  Quake 3 / CoD 4, and a wrong name sends you looking for a function that does not exist.
- **Never read CPU as health without `frame::count` beside it.** `join12`'s flat, low CPU line was
  not a healthy server, it was a parked thread after `Sys_Error`.
- **Never pass `+set developer 1`.** Every interesting line on the connect path is a `Com_DPrintf`,
  and it is tempting. `developer 1` promotes missing-asset warnings to fatal modal errors and
  changes script behaviour, so anything you measure is a different game. `join_probe.cpp` mirrors
  `Com_DPrintf` instead; that is why the state table exists.
- **`ENW_PRIVATE_PROFILE` does not work and is not needed.** An empty private-profile tree makes
  the engine raise `Exceeded limit of 1 'snddriverglobals' assets` and then answer nothing at all.
  Reproduced three times. It is not needed for several instances either — UDP 3074 falls back to
  3075. Leave it off.
- **Gate on an exit code, not a grep.** An earlier harness matched `REPLY` inside `NO REPLY` and
  fired a client at a stalled server, producing a run that looked like a networking failure and was
  not. `tools\dev\oob.py` exits 0 only when the server answered.
- **`getstatus` answering is not "a client can talk to the server".** `getstatus` is answered on
  the raw path and worked from the very first headless boot. They are different questions; do not
  use one as evidence for the other.
- **Clear `%LOCALAPPDATA%\Activision\codwaw\__CoDWaW` before an automated launch**, or a modal
  "Run In Safe Mode?" box blocks the launch before any logging happens. `launch.ps1` does it.
- **A patch that "should" work is not a patch.** `no_autosave.cpp` refused to install in `join16`
  because the cleanup was at call+7, not call+5, and said so. The guard was right and the constant
  was wrong; going in on assumption would have unbalanced the stack and crashed somewhere nowhere
  near the cause.
- **Agents run inside an MSIX container** where `%LOCALAPPDATA%` writes are redirected. Nothing an
  agent "verified" under `%LOCALAPPDATA%` counts for B's real machine. `npm run smoke` detects it.

## Do not touch

The Steam install. `CoDWaWmp.exe`. Port 3200 and the `cloudflared` tunnel. `web/data`. Any PID you
did not start. Full list: `../dev-box.md`.
