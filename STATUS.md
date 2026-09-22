# Where things stand — 2026-09-22, 01:30

## The headline

**A real client now connects to the headless dedicated server and spawns into the game**, and the
referee logs `ROUND 1`. That was the milestone the whole Stage C estimate hung on and it was
written down yesterday as "2–4 days away". Reproduced in five separate runs.

```
Going from CS_CONNECTED to CS_CLIENTLOADING for anna-jpg
Going from CS_CLIENTLOADING to CS_ACTIVE for anna-jpg
referee: ROUND 1 (all_players_connected)
```

Under three seconds from connect to spawned. Nothing new had to be patched to get there — the five
engine walls cleared yesterday were the whole of it, and `join11`'s "Server connection timed out"
was the *client* giving up while the server was fine.

**And the server does not survive it.** About ten seconds after the player spawns the frame loop
stops: `frame::count` frozen, CPU pegged at a whole core. Pegged, not idle, so it is a spin rather
than a wait. That is the one thing between here and a playable dedicated game.

## The two things to do next

1. **Run `infra\firewall.ps1` once, elevated.** It stops Windows asking to allow the game every
   time an agent makes a new dev copy. One UAC prompt, and `-Remove` undoes it.
2. **Install `launcher\dist\ENW-Zombies-Launcher-Setup-0.1.0.exe` and press Install the ENW
   client**, then `TESTME.md`: Play Local on Nacht der Untoten, past round 1,
   `node launcher\tools\last-run.js`. Still the MVP's last unverified step, and it needs a human.

## Fixed today

| | |
|---|---|
| The site and the tunnel were **both down** | The watchdog had died with the previous session. Restarted; it is holding |
| The **level-start autosave hangs a dedicated server** | No profile to save into, so the save never completes, so the level script asks again every frame. 195 attempts in join13 before the frame loop stopped. Now dropped at the drain, dedicated only |
| `--game` **never passed `+set dedicated 1`** | Every "real game" the host agent had ever launched was a windowed single-player game wearing a server's name |
| `+map` came **before** `+set net_port` | The port was set on a server already listening on 28960 |
| The join harness never passed **`com_maxfps`** | So every join run measured a server free-running at ~237 Hz and "burning a core". It holds a flat 61 Hz now |
| `--timescale` **under-ran by 2.5×** | `setInterval(6)` fires at 15.65 ms on Windows. An 8-round game took 116 s against an 80 s deadline |
| `integration-site` only ever ran against a **hand-curated DB** | On a fresh site the second player is not approved and three more checks fell behind it. The site was right |

## Proven today, with evidence

- **A box goes online and the Play button lights up.** `boxes.list().some(b => b.online) === true`,
  key pinned, `/api/launcher/hello` → `"play": true`. This needed no code change; it had simply
  never been run against a site with a live box.
- **A real headless game instance, started and stopped by the host agent**, answering `getstatus`
  and `getchallenge` on the wire, lock released, only its own PID killed.
- **First honest per-game cost: 0.050 of a core, 185 MiB, 13 threads**, with no players. Two
  independent methods agree.
- **The result path, end to end on a fresh database**: party → lease → boot → invite tokens (a
  forged one refused) → referee → signed replay → result → game row, XP, home feed. 20 checks.
- **Two headless servers run at once.** `dedi.md` §9.2 was wrong about UDP 3074 — the engine falls
  back to 3075. The one-game-per-box limit is ours, not the engine's.

## Corrections to things this repo said

- **T4 has no `CS_PRIMED`.** Every note said `CS_CONNECTED → CS_PRIMED → CS_ACTIVE`; that is Quake 3
  and CoD 4. T4's middle state is **`CS_CLIENTLOADING`**. The numbers are the same, only the name
  was wrong — and a wrong name sends you looking for a function that does not exist.
- **The server was never burning a whole core.** The pacing patch was in; nothing was passing a
  frame cap.
- **`ENW_PRIVATE_PROFILE` does not work** and is not needed. An empty private profile tree makes
  the engine raise `Exceeded limit of 1 'snddriverglobals' assets` and then answer nothing.
  Reproduced three times. Leave it off.
- **My own first autosave fix was wrong.** It reported the save as done, which sent the engine to
  commit a buffer nothing had filled (`Attempting to commit an invalid save buffer`). Lying to an
  engine about a thing it is about to use only moves the failure somewhere with a worse message.

## Known and unfixed

- **The frame loop stops ~10 s after a player spawns.** The one blocker. CPU pegged, so a spin.
  `where_is_main.cpp` cannot see it — with the sampler on, the server *died* instead of freezing,
  so the instrument changes the outcome. Next attempt: a dump from outside the process.
- **A second failure mode, seen twice**: `exceeded maximum number of script variables`, raised
  2,151 times, while every category the engine itself reports stays flat at ~2,300 variables and
  223 entities. The allocator refuses where the accounting says there is room.
- **No player has ever been in a host-agent game.** Every round count and replay body outside the
  join tests is still the simulator.
- **Only stock `nazi_zombie_prototype` is playable.** Three custom maps install, load and render,
  and their server script dies with three different GSC errors. Still unresolved whether the maps
  are broken or we load them wrong — so no map is marked `broken` on the site.
- **Round detection past round 1 is unproven.** An unattended game never advances.
- The **client install** is still unverified on B's real machine. Agents run inside an MSIX
  container where `%LOCALAPPDATA%` writes are redirected, so nothing an agent "verified" there
  counts. `npm run smoke` now detects the redirection.

## Waiting on a decision

- **One game per box, or several?** The engine allows several; the host agent allows one because
  every instance shares a game copy, a homepath and the lock. Not on the MVP path — recommend
  deferring.
- **Solo on a dedicated server runs co-op rules** (revives, prices, health scaling). A solo run
  hosted by us is therefore not comparable to a solo run on your own PC. That is a records
  decision, not a bug.
