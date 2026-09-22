# Next session — one page

Written 2026-09-22 after the join runs. If this page and `../../STATUS.md` ever disagree, STATUS
wins; it is rewritten at the end of every session.

## What was just finished

**Milestone (d) is done.** A real `CoDWaW.exe` connects to our headless dedicated server and
**spawns into the game**, and the referee calls round 1. Under three seconds from connect to
spawned, reproduced in every run from `join12` to `join18`.

```
Going from CS_CONNECTED to CS_CLIENTLOADING for anna-jpg
Going from CS_CLIENTLOADING to CS_ACTIVE for anna-jpg
referee: ROUND 1 (all_players_connected)
```

Nothing new had to be patched to get there — the five engine walls of `dedi.md` §7f/§7g were the
whole of it. Also landed: the **level-start autosave** no longer hangs a dedicated server
(`server/components/dedicated/no_autosave.cpp`), and the **join harness now caps the frame rate**,
which removed a "the server burns a whole core" claim that was never true.

## The single next task

**Find out why the frame loop stops about ten seconds after the player spawns.**

`frame::count` freezes and the CPU sits pegged at a whole core. Pegged, not idle — that is a
**spin**, not a wait, which rules out the message-pump class of bug (`dedi.md` §7c) and points at a
loop inside `Com_Frame`. It reproduces with the autosave fixed and the frame rate capped
(`join17`: 0 script errors, 0 `G_WriteGame`, 1 request dropped, froze at frame 1905).

**Do not instrument it from inside the process.** `where_is_main.cpp` suspends the main thread to
read its context, and with it on the server *died* instead of freezing — the instrument changes the
outcome it is meant to observe. Its seven samples all came from a healthy server and say nothing
about the freeze. Take a dump from **outside** the process instead: `tools/re/sample_threads.py`.

Second, behind it: `exceeded maximum number of script variables`, raised 2,151 times while every
category the engine itself reports stays flat at ~2,300 variables and 223 entities. The allocator
refuses where the accounting says there is room. `dedi.md` §7j.

## Reproduce the current state

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
