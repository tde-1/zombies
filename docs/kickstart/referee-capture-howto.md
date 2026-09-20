# How to run the replay capture (referee)

Everything for this is built and deployed-ready; it needs one uninterrupted ~6 minute hold of
`game.lock`, which is the only reason it has not been done. Anyone can run it.

## Prerequisites (all already true as of 01:35)
* `waw-base` repaired — all 35 iwds valid (see `referee.md` §8.4b). **Without this the client-mode
  run dies on `images/sun_flare.iwi is missing` before `+map`.**
* `build\referee\enw_t4.dll` built from current source (1,267,200 B, includes the `G_Say` chat hook
  and the multi-entity origin discovery).

## Steps
```powershell
cd C:\Users\b\Desktop\Zombies
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1  -Name referee
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 referee    # needs no game running

# then, holding game.lock, from the referee scratchpad:
#   capture.ps1 starts a game-link sink, launches a CLIENT-mode solo game,
#   answers the modal boxes, records for N seconds, kills only its own PID
#   and frees the lock.
& <scratch>\capture.ps1 -Seconds 600 -Map nazi_zombie_prototype
```

**Client mode, not dedicated.** A dedicated server with no client connected has no player entities
and `_zombiemode` never starts (`flag_wait("all_players_connected")`), so there is nothing to sample.
Dedicated is the right host once a client can connect to it; for a solo capture, client mode is.

## What to look for
In `ZombiesDev\logs\referee\enw-<pid>.log`:
* `referee/bind: ... entities=yes clients=yes servercmd=yes chatin=yes frame=yes`
* `referee/bind: gentity_s currentOrigin = +0xNN ...` — **this line is the point of the run for
  `re`**: a measured struct offset, found by motion, to fold into `shared/t4`.
* `referee: first frame tick` then `referee: N frames in M ms` — the real server tick rate.
* `chat: captured from slot ...` if anyone types.

In the sink summary: bytes, message counts per type, snap rate in Hz, and
`MB/game-hour (raw NDJSON)` — **the number that replaces the 12.1 MB/game-hour estimate in
`referee.md` §8.3 with a measurement.**

## What it will NOT show, and why
No `round`, no `game_over`, no `points`, no flags. Those all need script-variable access or the
notify hook, and neither is published yet (`referee.md` §7 asks 1 and 2). The capture measures the
replay stream and proves the transport; it does not yet exercise the referee's badge logic.
