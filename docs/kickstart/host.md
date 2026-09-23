# Host agent — design, how to run it, and the measured numbers

> **STATUS (2026-09-22).** **Proven against the real website**: the whole control plane — party →
> lease → boot → invite-token join → referee → signed, key-pinned replay → result → games, players,
> XP and boards, plus live spectator frames and a spool that survives the site being down
> (`node test/integration-site.js`, 0 failures). **Proven against a real `CoDWaW.exe`**: the host
> agent now launches a genuine HEADLESS dedicated server, the map loads, and it answers
> `getstatus`/`getchallenge` on the wire (`tools/dev/oob.py`, exit 0), for **0.046 of a core and
> 185 MiB with no players** — the first per-game figures that are not the simulator. §10.3. Then it
> stops cleanly, by PID, and releases the lock. **Still simulator-only**: everything a *player*
> does. No real zombies game has been refereed. ~~because no client spawns in yet~~ — **corrected
> 2026-09-22**: a real client now connects to a headless dedicated server and *does* spawn in
> (`dedi.md` §7h), but that is the `dedi` lane's own `jointest.ps1` harness, not a game this agent
> launched, and the server's frame loop stops about ten seconds after the spawn (`dedi.md` §7j).
> So every replay size and every per-game cost *under load* in §3 is still `sim/`, and what this
> lane is waiting for is now that freeze rather than the spawn. **Off by default and must stay
> that way**: local adoption (`--local` / `--adopt-local`, refused outright on a box with `--site`)
> and blind adoption of an unregistered `hello`. Cold start: `infra/host-agent/README.md`.
>
> **GAME OVER IS CLOSED (§12, 2026-09-22).** A match now completes with nobody watching:
> `game_over` -> the result kept verbatim -> the replay closed and **signed** -> `/api/gs/result`
> (spooled if the site is down) -> and then `match_end` is answered with one of the two
> dispositions the contract allows — `end` (map_restart, the instance goes **warm** and takes the
> next lease) or terminate — never neither. The box reports **idle** again, which it had never
> done. **36 checks, 0 failures** against a fresh site; all four disposition paths driven to the
> end; and a **second lease taken by the warm instance**, with its own match id in its own signed
> replay, on the same process. The referee's identity rows travel with the result: a `steamid`
> reaches the site only when somebody checked the signature, and an unverified row posts as
> attendance with no account (§12.10). Still the simulator: `game.lock` was held all night, so this
> has not been run against a real `CoDWaW.exe` (§12.9).


The **host agent** is the server software that runs on every game box. One process per box. It
starts game-server instances, talks to them over `docs/protocol/game-link-v0.md`, referees them,
records a signed replay of every game, bridges chat to the site's global channel, answers the DLL's
invite-token checks at connect, reports results to the website over the pull protocol, and serves a
local dashboard with a live 2D view.

Everything in `infra/host-agent/` is **Node 24 with zero dependencies** — `node:net`, `node:http`,
`node:crypto` (Ed25519 built in), `node:zlib` (zstd built in), SSE instead of a websocket library.
`package.json` has an empty `dependencies` block and it stays that way.

**Nothing here needs the game to exist.** A simulator (`sim/`) speaks the same protocol, so every
feature below is built, tested and measured today.

**Update, 02:0x — the whole path runs against the REAL website.** `web/` on :3200 leases from its
party rail, mints Ed25519 invite tokens, and takes back games, players, XP and the replay pointer;
this box verifies those tokens against the public half it fetched from `GET /api/gs/keys`. One
command reproduces it: `node test/integration-site.js --box box-b --secret devkey-b` — **0
failures** (§3b).

**Update, 01:02 — a real `CoDWaW.exe` has now been on the other end of the socket.** With the
foundation agent's `tools/dev/launch.ps1` and the referee build of `enw_t4.dll` deployed into
`ZombiesDev\waw-host`, `node host.js --boot 1 --game --map nazi_zombie_prototype` launched the real
game and its DLL connected and said hello:

```
info  host/inst/inst-01  start game port 28960
debug host/link          c1 connected from 127.0.0.1:52973
info  host               instance inst-01 linked (pid 22048, Sep 20 2026 00:32:31)
info  host/inst/inst-01  game PID 22048 adopted (launcher holds game.lock as "host")
debug host/inst/inst-01  launcher exited (0); game PID 22048 is up
```

So the whole chain — lease, launch, lock, PID adoption, game link — works against the real thing,
not just the simulator. The run was cut short before the map loaded, so there is still no real
per-game CPU figure; see §3d.

> **Read that with §10.3 beside it.** `--game` did not pass `+set dedicated 1` until commit
> `6c2e1a4`, so the process this run started was a **windowed single-player game** wearing a
> server's name. The chain above — lease, launch, lock, PID adoption, game link — is still what it
> proved, and it is still true. What it did **not** prove is that a dedicated server had been
> launched. Any `--game` measurement in this file taken before `6c2e1a4` is a measurement of a
> single-player game. §10.3 is the first one that is not.

---

## 1. What runs, in one picture

```
                            THE WEBSITE (mock-site/site.js stands in for zombies.enw.gg)
                            /api/gs/assignment · /status · /result · /chat-feed · /chat · /keys
                                        ^ outbound HTTP only          ^
                                        |  poll                       |  poll
              ┌─────────────────────────┴───────────┐   ┌─────────────┴────────────┐
              │        HOST AGENT (box-a)           │   │     HOST AGENT (box-b)   │
              │  host.js                            │   │            …             │
              │   ├ SiteClient   pull + chat bridge │   └──────────────────────────┘
              │   ├ TokenGuard   invite tokens      │
              │   ├ InstanceMgr  spawn/reap/sample  │
              │   ├ GameLink     TCP NDJSON :38700  │
              │   ├ Referee      one per game       │
              │   ├ ReplayWriter one per game       │
              │   └ Dashboard    HTTP+SSE :8787     │
              └───────┬───────────────┬─────────────┘
                      │ TCP           │ TCP
              ┌───────┴──────┐ ┌──────┴───────┐
              │ instance 1   │ │ instance 2   │   real CoDWaW.exe + our DLL, or sim/sim-instance.js
              └──────────────┘ └──────────────┘
```

**The site never connects out.** That is copied from ENW's CS:GO matchmaker
(`server/routes/gameserver.js`, `/api/gs/*`) and it is the single most important shape decision
here: a box behind NAT, with no inbound firewall rule and no reachable RCON, works anyway.

### Files
| Path | What |
|---|---|
| `host.js` | the agent: wiring, config, the per-game `Game` object |
| `lib/gamelink.js` | TCP NDJSON server, many instances, backpressure both ways |
| `lib/instances.js` | spawn/stop/restart/reap, per-instance logs, the game lock |
| `lib/procstat.js` | CPU + RAM per PID (persistent PowerShell worker on Windows, `/proc` elsewhere) |
| `lib/referee.js` | the rules: rounds, finishes, cap, AFK, late join, pause, the summary |
| `lib/manifests.js` | reads `referee/manifests/*.json` and evaluates `enw.referee.manifest/0` |
| `lib/replay.js` | the `.enwr` container: zstd chunks, hash chain, signed footer, seek |
| `lib/tokens.js` | invite tokens: issue (site side) and verify (box side) |
| `lib/siteclient.js` | the pull protocol + the chat drain |
| `lib/dashboard.js`, `web/dashboard.html` | the local dashboard and the live 2D view |
| `lib/gamelog.js` | optional IW4MAdmin/B3-readable `games_mp.log` mirror |
| `lib/keys.js`, `lib/util.js` | Ed25519 helpers; logging, NDJSON framing, hashing |
| `sim/engine.js`, `sim/sim-instance.js` | the fake game |
| `mock-site/site.js`, `mock-site/web.html` | the fake website + its chat UI |
| `tools/verify.js` | prove a replay is unmodified; `--tamper` shows it failing |
| `tools/recover.js` | rebuild a replay whose host died before it could sign the footer |
| `tools/measure-replay.js` | the size/cost measurement |
| `tools/density.js` | ramp instances on one agent and record what each one costs |
| `tools/soak.js` | watch a running agent over hours and record whether it drifts |
| `test/run-all.js` | 37 in-process checks of the rules and the format |
| `test/demo-network.js` | the two-box end-to-end demo (mock site) |
| `test/integration-site.js` | the full run against the REAL site on :3200 |

---

## 2. How to run it

```bash
cd infra/host-agent

# everything, end to end: a mock site, two boxes, two games, tokens, chat, replays
node test/demo-network.js

# the rules and the replay format, in-process (a few seconds)
node test/run-all.js

# one box on its own, two simulated games, dashboard on http://127.0.0.1:8787
node host.js --boot 2 --sim-players 4 --sim-max-round 30 --sim-ee-round 12 --map nazi_zombie_factory

# a box attached to the mock site (run the site first: node mock-site/site.js --port 8080)
node host.js --site http://127.0.0.1:8080 --secret devkey-a --box box-a

# prove a replay, then prove the proof
node tools/verify.js "C:\Users\b\ZombiesDev\replays\<match>.enwr" --tamper

# salvage a replay whose host was killed mid-game
node tools/recover.js "C:\Users\b\ZombiesDev\replays\<match>.enwr"

# the size/cost numbers
node tools/measure-replay.js --hours 1 --players 1,2,4 --levels 10,19

# how many games one agent carries, and what each one costs
node tools/density.js --to 20 --step 4 --players 4

# leave an agent running and record whether it drifts
node host.js --box soak --boot 6 --sim-players 4 --dash-port 8871 --link-port 38871 --base-port 29700
node tools/soak.js --dash http://127.0.0.1:8871 --every 60 --out soak.csv
```

Useful flags: `--game` (boot a real `CoDWaW.exe` through `tools/dev/launch.ps1` instead of the sim —
takes `game.lock`), `--sim-timescale N` (run a game N× faster; the 24 h cap in seconds),
`--cap-ms`, `--afk-warn-ms`, `--afk-kick-ms`, `--require-token false`, `--dash off`, `--game-log off`,
`--zstd-level`, `--chunk-ms`, `--max-instances`, `--debug`.

What happens at game over (§12): `--after-game end|terminate` (default `end` — reuse the instance),
`--games-per-instance N` (default 5), `--end-reply-ms`, `--map-reload-ms`, `--warm-idle-ms`, and
`--spool-dir` (results held on disk while the site is down — **it did nothing until 2026-09-22,
§12.8**). To drive the paths against the simulator: `--sim-games N`, `--sim-end-fails`,
`--sim-no-match-end`.

```bash
# a full game to game over, the instance reused, a second game, then torn down
node host.js --boot 1 --sim-players 2 --sim-max-round 3 --sim-timescale 30      --sim-games 2 --games-per-instance 2
```

Defaults: replays in `C:\Users\b\ZombiesDev\replays`, logs in `C:\Users\b\ZombiesDev\logs\host`,
keys in `C:\Users\b\ZombiesDev\keys`. Nothing is written inside the Steam install, ever.

---

## 3. The measured numbers

### 3a. Replay size and cost

One **simulated game-hour**, players sampled at 20 Hz and zombies at 10 Hz, real `.enwr` files
written and verified. `node tools/measure-replay.js --hours 1 --players 1,2,4 --levels 10,19`
(full output in `infra/host-agent/measurement.json`, 2026-09-20).

| Players | Round reached | Survived the hour? | Zombies alive (avg / peak) | Raw NDJSON | **Compressed (zstd-10)** | zstd-19 |
|---|---|---|---|---|---|---|
| 1 | 13 | no — wiped at 12 min | 7.6 / 22 | 5.4 MiB | **3.03 MB/game-hour** | 2.64 |
| 2 | 25 | yes | 17.0 / 24 | 54.1 MiB | **6.42 MB/game-hour** | 5.48 |
| 4 | 26 | yes | 14.4 / 24 | 72.6 MiB | **8.04 MB/game-hour** | 7.00 |

Compression is **9.0×** at 4 players. 86.0% of the raw bytes are `snap`, 13.5% are `input`, and
everything else together is 0.5%.

**These numbers are ~1.8–2× the vault's estimate, and the earlier version of this document was
wrong.** The first pass measured 5.98 MB per 4-player game-hour and said the vault's ~4–5 was
right. It was measuring a simulation that killed zombies far too quickly, so the map was half
empty for most of the hour. Four fidelity fixes (§3c) later — trains that actually form, melee
applied per swing instead of per tick, a cap on how many zombies can reach one player, and a game
that ends when everyone is down — a 4-player hour holds **14.4 zombies alive on average and peaks
at the engine's 24**, and the replay is correspondingly bigger. **Plan on ~8 MB per 4-player
game-hour, not 4–5.**

| Tier | 4p MB/game-hour | What it is |
|---|---|---|
| full | 8.04 | every event + player tracks + zombie tracks (90 days; VIP forever) |
| no zombies | 4.32 | B's "reconstruct the zombies" idea |
| events only | 0.06 | the signed event log + summary (**kept forever, everyone**) |

**B's "don't store the zombies" idea saves 3.72 MB/h (46%)** — and the vault's conclusion still
holds with the bigger numbers: at R2's $0.015/GB-month, storing the real zombies for a thousand
4-player game-hours costs **$0.055 a month**. Zombie behaviour *is* the evidence. Keep it.

**R2 at $0.015/GB-month**, full tier, 90-day retention, games running flat out 24/7:

| Concurrent games | Stored | Cost |
|---|---|---|
| 25 | 424 GB | **$6.36/month** |
| 100 | 1,696 GB | **$25.44/month** |
| 400 | 6,784 GB | **$101.76/month** |

The keep-forever event log adds **0.06 MB per game-hour** and never expires: at 25 concurrent games
that is ~13 GB a year, about **$0.20/month of growth per year of operation**. A 20-hour VIP game is
160 MB, i.e. **$0.0024/month to keep**. Reading is free on R2 (no egress charge), so watching
replays costs nothing. Even at 2× the vault's estimate the storage line is rounding error next to
the €157–257/month a box costs.

**zstd level.** Level 10 is the right default: level 19 is 12.9% smaller but costs 20 s of CPU per
game-hour recorded instead of 1.9 s — at 25 games per box that is 0.14 of a core spent on
compression rather than 0.013. If storage ever matters more than CPU, re-compress cold replays to
19 offline; the container, the chain and the signature do not change.

**Solo is the weak sample.** The solo run wipes at round 13 after 12 minutes, so its 3.03 MB/h is
a rate measured over a short game rather than a full hour (the harness divides by actual sim time,
not the hour it asked for). A competent solo player goes much further than round 13; the simulated
one does not kite well enough. Treat solo as "roughly a third of a 4-player game" and re-measure
against the real DLL.

### 3b. The full integration run, against the real website

`node test/integration-site.js` with `web/` running on :3200. Nothing is mocked on either side:
the site has its own database and its own Ed25519 invite key, the box has its own replay key, and
the only thing that passes between them is HTTP the box initiates.

```
0. the real site is up            invite key b74d9a7c9874d877; /api/gs/* is 401 without the secret
1. the box comes up               fetched the invite key; the site PINNED replay key 96de531ff9d313d9
2. party -> Start                 party 3, two signed-in players, ready check, launch -> lease m_104943d2
3. the box takes the lease        seen on the next /assignment poll; slot 0 Dexter ALLOW, slot 1 Air ALLOW
4. a forged token                 refused (bad_signature) against the site key the box holds
5. the game plays out             round 8, 5m29s, replay 335.1 KiB / 6 chunks / 12,732 events
6. what the site holds            game row, both players with XP (444 and 540), replay pinned=true
7. the replay on disk             VALID against the pinned key; FAILS against any other key
8. spool and retry                POST /api/gs/spool accepted a held result; a junk result is 400, never 5xx
9. chat-feed since=0              cursor only, 0 events
```

**0 failures.** Party → lease → boot → join → referee → signed replay → result → games/players/XP,
with the invite tokens signed by the site and verified by the box and nothing hand-copied between
them.

Three things that had to change to get there, all of them worth keeping:

1. **The box now offers its replay public key on every status heartbeat** (`pub`, `key_id`) and
   puts `key_id` + `pub` in the result's `replay` block. That is the whole difference between a
   replay the site stores unpinned — which record review correctly refuses to call evidence — and
   one it grades as record-grade. The box logs `replay key … is PINNED` once, and shouts
   `KEY MISMATCH` if the site has a different key pinned for it.
2. **A box that regenerates its key looks exactly like an impostor, and the site is right to say
   so.** An early run used a throwaway key directory, the site pinned that key, and the box's real
   key then sat *pending* while every replay was stored unpinned. Resolving it is an admin action
   (Admin → Boxes → accept), which is the correct flow. The practical rule: **a box's replay key is
   its identity — it lives outside anything a test or a deploy recreates.**
3. **Spool and retry** (Q-host-2, now answered): a failed `POST /api/gs/result` goes to
   `ZombiesDev\spool\<match>.json` and is drained through their batch `POST /api/gs/spool` until
   taken. Their `/result` never 5xxs, so a **4xx is not retried** — it is moved to `spool/rejected/`
   and logged, because one permanently bad body must not wedge every good one behind it. A box with
   a non-empty spool must not be destroyed; it says so at boot.

Two of their behaviours were adopted rather than argued with, and `mock-site/site.js` now matches:
`chat-feed?since=0` returns **the cursor and no events** (the old whole-ring answer would inject an
hour of strangers' chat into a game that had just booted, because the host pushes everything that
route hands it into every live game), and `/result` never 5xxs.

### 3c. What the simulator got wrong, and how it was found

Every one of these was found by something downstream failing, not by reading the code — which is
the argument for having the referee, the replay and the site on the other end of it.

| Symptom | Cause | Fix |
|---|---|---|
| A game stuck at round 9 for 7 simulated hours | With every player down, nothing killed a zombie, so the round never ended, so nobody respawned | A team wipe now ends the game (`game_over`, `all_players_down`) — which is also what WaW does |
| A 4-player team wiping by round 14, every time | Melee damage applied once per **tick** (20×/s) instead of once per **swing** (~1.1 s) | Scale by the swing interval |
| A solo player dying under a pile | The whole train stacked on the player's exact position | At most four zombies can reach one player at once |
| Trains that were not trains | `z.lag` was assigned and never used | Zombies chase the player's position from 0.15–1.0 s ago, from a 2-second trail |

The last two are why the measured replay size moved by 35%: a map with a real 24-zombie train on it
has far more to record than one that is half empty.

### 3d. CPU and RAM per instance

The sampler is real (`lib/procstat.js`, `Get-Process` deltas over wall time, one persistent
PowerShell worker so the measurement does not measure itself), but **the numbers below are the
SIMULATOR, not World at War**, and say nothing about WaW's cost:

| | value |
|---|---|
| sim instance, 4 players, rounds 1–22 | **0.015–0.02 of a core**, 47–51 MiB RSS |
| host agent itself, 2 live games | ~0.02 core, ~60 MiB |
| replay writing | 1.4 s of CPU per game-hour at zstd-10 (0.04% of a core) |

What this *does* establish: **the host agent's own overhead is negligible** — the game-link socket,
the referee, the replay writer and the dashboard together cost well under a hundredth of a core per
game, so the vault's per-game cost model is entirely about the game process.

> **SUPERSEDED 2026-09-22 (§10.3).** It has now been measured: **0.050 of a core and
> 185 MiB, headless, map loaded, no players**, by two independent methods. And the 01:02
> launch below did *not* prove what this paragraph says it did — `+set dedicated 1` was
> never in the launch line, so the process it started was a windowed single-player game,
> not a server. The rest of this sub-section is kept as written.

**The real game has connected but has not been measured.** The 01:02 launch above proved the path
and was stopped before the map loaded (the game lock belongs to the dedi agent most of the time
tonight, and a partly-started SP exe sitting at 37 MiB tells us nothing). Everything needed is now
in place — a `waw-host` copy, the DLL deployed, the launcher invocation verified, the sampler
running — so the 0.3–0.8 core per game estimate in `14 - Server Infrastructure & Cost Model`
is one uninterrupted lock away:

```bash
node host.js --boot 1 --game --map nazi_zombie_prototype --dash-port 8787
# leave it for a few minutes, then:
curl -s http://127.0.0.1:8787/api/state    # instances[].usage.cores_avg / rss_peak_bytes
```

Boot two or three at once (`--boot 3`) and the same field gives the density number for T4 of the
vault's test plan.

Box for reference: AMD Ryzen 7 9800X3D, 16 cores, Node 24.16.0.

---

### 3e. Several games on one host agent

`node tools/density.js --to 20 --step 4 --players 4`, on a Ryzen 7 9800X3D (16 cores), with the
soak below running alongside:

| Live games | Cores total | **Core/game** | Games MiB | MiB/game | **Agent MiB** | Events/s | Drops |
|---|---|---|---|---|---|---|---|
| 4 | 0.01 | 0.0030 | 206 | 51.6 | 67.6 | 234 | 0 |
| 8 | 0.02 | 0.0024 | 414 | 51.7 | 78.9 | 473 | 0 |
| 12 | 0.03 | 0.0027 | 621 | 51.8 | 95.7 | 710 | 0 |
| 16 | 0.03 | 0.0020 | 829 | 51.8 | 111.0 | 965 | 0 |
| 20 | 0.05 | 0.0026 | 1,038 | 51.9 | 145.3 | 1,215 | 0 |

**Per-game cost is flat and the link never dropped a message.** Twenty games produce 1,215
events a second between them (~60 per game, which is what the protocol's rates predict) and the
whole agent — game-link, twenty referees, twenty replay writers, the SSE dashboard — costs
**0.05 of a core**.

The agent's own memory grows **~4.9 MiB per extra game** (67.6 MiB at four games, 145.3 at twenty).
That is the replay writers: each holds up to 60 seconds of events before it compresses a chunk.
At the vault's 45-games-per-box figure the agent would want ~300 MiB and a twentieth of a core.

**What this does NOT say.** The 51.8 MiB per instance is a Node simulator, not `CoDWaW.exe`, and
says nothing about the 0.3–0.8 core per game the cost model turns on. What it does establish is
that **the host agent is not the constraint** — it adds roughly 0.003 core and 5 MiB per game, so
whatever the density limit turns out to be, it will be set by the game process, ~~or by the
engine's hardcoded UDP 3074 party socket (`dedi`'s finding)~~ — **that half is withdrawn, §10.5**:
3074 is not an exclusive bind, the second instance takes 3075 — not by us.

### 3f. Live frames to the site's spectator view

`web/tools/live-bridge.js` was a shim: it polled this box's local dashboard and forwarded frames
to the site because the box had no reason to send them. **It can be deleted.** The box now posts
directly:

```
POST /api/gs/live { instances: [{ instance, match_id, state }] }   ~4 Hz, at most 16 per post
```

`state` is the referee's own `state()` — the same object the local dashboard draws its 2D view
from, so the site's `/live` page and the box's dashboard cannot disagree. Measured against the
real site: **87 frames in 22 seconds, 0 dropped**, and `GET /api/live/<match>` came back with
three players' positions and the zombies.

Frames are **fire and forget**. A live view is worth nothing a second later, so a failed post is
counted (`liveDropped`) and thrown away — never spooled, never retried. That is the opposite of
the result path, and deliberately so: one is a picture, the other is the record.

### 3h. The soak: does the agent drift?

`node host.js --box soak --boot 6 --sim-players 4` plus `node tools/soak.js`, left running for 24
minutes while everything else in this document was being done. Not the 20 hours vault 14 T5 asks
for, but the only continuous evidence we have, and it found something.

| | at 0 s | at 24 min | verdict |
|---|---|---|---|
| Game processes (6 × 4p) | 308.0 MiB | 315.4 MiB | **+2.4% — flat** |
| Agent RSS | 64.7 MiB | sawtooth, floor 148, peaks to 168 | **see below** |
| Agent JS heap | — | **11.6–15.0 MiB, flat** | **no JS leak** |
| CPU | 0.016 core total | 0.019 core total | flat |
| Game link | — | 518,000 events | **0 dropped** |
| Simulated frame p99 | 22.9 ms | 31–47 ms | within the 60 ms target |

**The agent's RSS more than doubled, and then started sawtoothing around a flat floor.** The last
seven samples are 155.7, 148.0, 161.2, 148.7, 148.1, 161.8, 167.7 MiB — **the troughs do not move
(148.0 / 148.7 / 148.1) while the peaks vary.** A flat trough is the thing that distinguishes a
sawtooth from a leak: if memory were genuinely being retained, the bottom of each cycle would climb
too.

The split says where it lives: `heapUsed` sits at 11.6–15.0 MiB and does not move, so ~139 MiB of
the RSS is **native, not JS** — Buffers. That is the replay path: every chunk flush concatenates
~500 KB of NDJSON and hands it to `zstdCompressSync`, six games at a time. Node reuses that arena
rather than returning it to the OS. The density ramp agrees from the other direction: twenty games
reached 145 MiB in a few minutes, six reached ~150 in twenty, so the band is set by buffer churn
rather than by game count or elapsed time.

**Read this as "no leak found in 24 minutes", not "no leak".** A flat JS heap and a flat trough are
good evidence and not proof; peaks still reached a new high on the last sample. Budget ~150–200 MiB
for the agent on a busy box. Two things would settle it properly: run the real 20 hours, and make
the chunk writer compress incrementally instead of concatenating, which removes the arena and the
question with it.

Running this again is one command each; `tools/soak.js` now records `agent_heap_mib` beside
`agent_rss_mib` so the JS-vs-native question is answered by the CSV rather than by hand.

One unbounded array was found by inspection while reading for the leak and fixed: `Referee.send()`
appended every command it ever issued to an array nothing read. Harmless in a twenty-minute test,
not harmless in a twenty-hour game, and the referee is the one object guaranteed to live as long as
the longest game. It is a 200-entry ring now.

### 3g. Two failures worth keeping in front of you

Both are the same shape: **the system was working correctly and the operator could not tell**,
because the signal was in a place nobody was looking. Neither was found by reading the code.

### A box's replay key is its identity
An early integration run pointed the box at a throwaway key directory. It generated a new Ed25519
key, the site pinned *that*, and when the box was next run with its real key the site — correctly —
treated it as an impostor: the key sat `pending`, and **every replay written in the meantime was
stored unpinned**, which record review rightly refuses to call evidence. Nothing errored. The games
played, the results posted, the boards updated, and the only symptom was a field called
`key_pinned` being `false`.

The rule that follows: **a box's replay key lives outside anything a test, a container rebuild or a
deploy recreates.** It is provisioned once, like a machine's SSH host key, and a change to it is an
admin decision (Admin → Boxes → accept), not something a restart can do quietly. The box now logs
`replay key … is PINNED` once on confirmation and `KEY MISMATCH` loudly otherwise, so the state is
visible without opening the database.

### A busy dashboard port silently stopped a box from booting
Another agent's tool had taken port 8791. The two-box demo's `box-a` bound its dashboard to that
port, failed, and exited during `start()` — before it had logged anything useful. The site then
leased the game to a *different* box that happened to be online, which played it perfectly. The
demo's assertions read the site, saw a completed game with a valid replay, and passed. The only
evidence anything was wrong was an empty artifacts directory.

Two fixes, and the second is the general one. A busy **dashboard** port no longer takes the box
down: it logs `dashboard disabled: port 8791 is already in use` and carries on, because refereeing
games is the job and the dashboard is a convenience. A busy **game-link** port still kills the box,
correctly — without it there is no game. And both harnesses now check that *their own* box came up
before believing anything they read from the site.

The general lesson for a shared machine: **a test that verifies through a shared system must first
prove the component under test is the one being exercised.** Three agents run tools on this box;
two of them collided with ports this code had hard-coded.

---

## 4. The referee, rule by rule

One `Referee` per game. It consumes protocol events and owns every decision; the game process
reports facts and never decides whether a game counts.

**The clock is game time, not wall time.** Everything is measured on the `ms` field of the events,
so a paused or stalled server does not burn a player's AFK budget, and a fast-forwarded simulator
exercises the 24-hour cap in seconds. Between events the clock free-runs at wall speed, so a game
that goes silent still hits its cap.

| Rule | Behaviour | Source |
|---|---|---|
| Rounds / game over | `round` / `game_over`; `maxRound` is what the board sees | 99 §5.3 |
| Per-map finish | `referee/manifests/*.json`, priority order, EE > Buyable Ending > Round N | 99 §4.6 |
| Late joiners | player marked `late`, **the GAME** flagged `late_join`, `records_eligible: false`, the joiner is told | 99 §4.4 |
| 24 h cap | warnings at 30/10/1 min in plain words, then `end`, then a saved summary and a signed replay; `cap_reached` flag | 99 §4.4 |
| VIP | any VIP in the lobby ⇒ no cap at all | 99 §4.4 |
| AFK | warn at 10 min of no input, kick at 15; moving, shooting or typing clears it | 99 §4.4 |
| Everyone AFK | pause, then close, flagged `all_afk`, not records-eligible | 99 §4.4 |
| Pause / resume | `pause`/`resume` to the game; in-game time excludes paused time, RTA includes it | 10 §5 |
| Solo crash | the whole game pauses for the grace window; coming back resumes and tags `resumed`; not coming back saves what there is, tagged `abandoned` | 10 §5 |
| Server crash | the instance dying unexpectedly ends the game as `server_crash` and still writes and signs the replay | 10 §4b |
| Identity on reconnect | matched on SteamID, not slot, so a returning player is the same person | 10 §5 |

The **game summary** is the row the website stores (`games` + `game_players` in vault 99 §5.5):
who, map, mode, rounds, finish, duration (in-game **and** RTA), paused time, flags, per-player
stats, `records_eligible`, `xp_multiplier` (Verified 1, Custom 0.25, Local 0), the replay pointer and
the run fingerprint.

### Crash recovery: pause, hold, resume

Vault 10 §5's promise is not "the replay survives" — `tools/recover.js` does that. It is that **the
game** survives: an engine-level pause, a grace window, a full state restore, and the result tagged
"Resumed". The referee owns *when*; the in-game half (freezing zombies without `timescale 0`,
holding bleedout and powerup timers, `freezecontrols` plus invulnerability — the `ZPauseT4` pattern,
vault 11 §3) belongs to the DLL. This is the host agent's half, so it is not invented at build time.

```
player drops                     referee: pause (solo/empty), flag crash_pause
      |                          referee emits `snapshot_wanted`
      v
host: send `snapshot_state`      <- while the level STILL HAS the state. A snapshot taken
      wait for the reply (5 s)      ten seconds later is of a game that has moved on.
      keep that player's slice, keyed to the SteamID, with a wall-clock stamp
      |
      +-- limited weapons they were holding are RESERVED (see below)
      v
player returns inside the grace  referee matches on SteamID, not slot
      referee emits `restore_wanted`
      v
host: send `restore {slot, state}`   -> the DLL puts back score, weapon (incl. _upgraded),
      release the reservation           perks, position; replies ok/error
      referee: resume COUNTDOWN, then unfreeze; game flagged `resumed`
```

Decisions this pins down, each of which would otherwise be argued about at build time:

* **Ask on the drop, not on the return.** The state has to be captured while the level still holds
  it. The host holds it, not the game — a game that crashes outright has nothing left to ask.
* **Keyed to the SteamID, never the slot.** Slots are reused, and a returning player often lands in
  a different one. The referee now moves the whole player record to the new slot, so their score,
  downs and revives come back with them rather than being split across two rows.
* **The grace window is enforced on the wall clock**, not the game clock, because the game clock is
  frozen for the whole pause.
* **A record-profile game gets the pause and NO restore.** Putting a player back by hand is not
  vanilla and would void the run on ZWR/b2, so `restoreAllowed()` is false for a record profile:
  the host does not even ask for the snapshot, and the player is told why. That is the vault's
  policy table expressed as one method rather than scattered through the code.
* **Limited weapons stay reserved.** The magic box counts Wunderwaffe and flamethrowers held by
  *connected* players, so a dropped Waffe can come out of the box again — and weapon duplication is
  a ban on every board. The held snapshot records it and `reservedWeapons()` exposes it for as long
  as the player is away. **The enforcement is the DLL's** (the box must consult the reservation);
  the host's job is to know.
* **A resume countdown, not a jump cut.** Unfreezing the instant someone reconnects hands a player
  still on the loading screen to a zombie. Ten seconds, announced.

Not done, and needing the DLL: the restore itself is only as good as the builtins behind it. Downed
state, the Bowie knife flag and other per-player flags are listed in vault 10 §5 as hard, and
nothing here can verify them. What is proven is the choreography — against a real host agent and a
real simulator, a drop captures state (`holding state for 7656…`) and a return hands it back — plus
six in-process checks covering the SteamID match, the stale window, the reservation and the
record-game refusal.

### Play Local: a game this agent did not launch

On a player's own PC the launcher owns the game process and the host agent runs beside it as
referee and replay writer. That is the exact inverse of a game box, and "accept a connection I did
not start" is the kind of thing that becomes a hole later, so it is built as three locks rather
than a flag.

**The shape is inverted from the obvious one.** Rather than adopting any `hello` that turns up, the
launcher — which knows the instance id before it launches, because it sets `ENW_INSTANCE` — tells
the agent to expect it:

```
POST /api/local/expect { instance: "l_21a50db2", match_id: "l_21a50db2", map: "nazi_zombie_leviathan" }
  -> { ok: true, instance, match_id, link: "127.0.0.1:38905", expires_in_ms: 600000 }
```

Then it launches, the game says hello as `l_21a50db2`, and the agent matches it against something
it was told to expect. The site's own local match id is used throughout, so the site, the box and
the replay all name the game the same thing.

| Lock | What it does |
|---|---|
| `--local` off by default | Without it, a `hello` from an unknown instance is ignored exactly as before, with a log line saying how to enable it |
| Registration required | `--local` accepts **only** instances registered in advance, and a registration expires after 10 minutes. `--adopt-local` additionally accepts a blind `hello`, and says `BLIND` in the log when it does |
| **Never on a game box** | `--local` combined with `--site` is refused **at startup**, with an explanation. Not "not while leased" — having a site configured at all is enough, because the gap between leases is exactly when a race would slip through. A second check refuses adoption while any leased game is live |

Everything an adopted game produces is stamped **`self_reported`**: the flag is on the summary, in
the `flags` array, and **inside the signed replay header**, so the marking travels with the
evidence and cannot be added or removed afterwards by whatever posts it. The mode is forced to
`local`, which independently zeroes XP and sets `records_eligible: false`. The site refuses to
grade local games anyway — this is the second lock on the same door, as it should be.

The adopted process is also marked **foreign**: it is sampled for CPU and RAM (knowing what a real
game costs is the point) but `stop()` will never kill it. We did not start it, so it is not ours to
end — dev-box.md rule 4's reasoning, applied to a player's own game on their own PC.

`node test/demo-local.js` proves all five behaviours, including the two refusals. The last run
adopted `l_21a50db2`, refereed it to round 8, and wrote a signed replay whose header says
`self_reported: true`.

### Manifests
`referee/manifests/` belongs to the **referee agent**; the host only reads it. `lib/manifests.js`
implements the `enw.referee.manifest/0` evaluator: `flag`, `notify`, `round_at_least`,
`trigger_used`, `dvar`, `level_var`, `all`, `any`, `seq`, `count`, `requires`, `solo_ok`, `manual`.
A map with no manifest gets the built-in default (Round 20), exactly as `_schema.md` prescribes.
`{"manual": true}` is treated as permanently false and logged loudly at map load — an ungated badge
is worse than a missing one.

Three of those conditions are tested against the referee agent's real files, and each catches a
distinct trap: Der Riese's Fly Trap needs `hide_and_seek` **before** the three bear flags (an
out-of-order burst awards nothing); Nacht awards nothing but Round N even when a fabricated
`enw_ee_complete` arrives; and `nazi_zombie_ali`'s 50,000-point `zombie_door` is a **decoy** that
registers only as a signal, with the real ending being `level.tom_victory`.

---

## 5. The replay container (`.enwr`, v0)

```
"ENWR" u8 ver u8 flags u16 pad u32 headerLen | header (JSON, uncompressed)
repeated: u32 payloadLen | u8 chunkFlags | u32 uncompressedLen | zstd(NDJSON)
u32 footerLen | footer (JSON) | u32 footerLen | "ENWRFOOT"
```

* **Header**: match id, map, mode, box, instance, `exe_sha256`, `dll_build`, the manifest and its
  `script_fingerprints`, dvars, knobs, the roster, host info, `started_at`. This is the environment
  the run happened in — the HUD fingerprint is its hash.
* **60-second chunks**, zstd, NDJSON inside. The columnar CBOR body of vault §5.4 is a later,
  purely internal change: the container, the chain and the signature do not move.
* **Hash chain**: `chain[-1] = sha256(header)`, `chain[i] = sha256(chain[i-1] ‖ sha256(chunk record))`,
  over the *whole on-disk record* including its length bytes.
* **Signed footer**: the full chunk index (`off`, `len`, `ulen`, `t0`, `t1`, `n`, `hash`, `chain`),
  `final_chain`, event counts, the game summary, and an Ed25519 signature over the canonical footer.
* **Seekable**: `off`/`len` per chunk is an HTTP Range request. The dashboard's playback fetches one
  60-second chunk at a time by offset and decodes nothing else — the same read a browser viewer
  makes against R2.

`node tools/verify.js <file> --tamper` copies the replay, flips **one bit** in the middle of a
chunk — same file size, same index, same genuine signature — and re-verifies:

```
VALID — every chunk hashes to its index entry, the chain is intact, and the footer signature checks out.
TAMPER DEMO: flipped one bit at byte 12467 (chunk 0, 0xea -> 0xeb).
INVALID — 3 problems:
  x chunk 0: content hash mismatch (bytes were modified)
  x chunk 0: hash chain broken
  x final chain hash mismatch
```

`test/run-all.js` also proves that editing the **header** breaks it, that a **truncated** file
fails, and — the one that matters for policy — that a file **re-signed with a different key** is
internally consistent and therefore *must* be checked against the box's pinned public key. Integrity
is not authorship. The site must store each box's public key and `verify.js --pub <key>` must be how
a record is checked, not a bare `verify`.

### When the host dies mid-game
The footer is written when the game ends, so a host that is killed outright leaves a header, a run
of good chunks and **no footer at all**. `verify.js` calls that "not a replay", correctly: nothing
about it can be proved. Vault 10 §5 nonetheless wants the game saved up to the crash, tagged — so
`tools/recover.js` rebuilds the index and the chain from the surviving chunks and signs the result
*now*:

```
recovered 30 chunk(s), 43872 events, 30.0 min of game time
  -> m_57dae4d5.recovered.enwr, marked recovered + partial, signed by 7332de1a
```

That signature proves only that nothing has changed **since recovery**, so the footer carries
`recovered: true` and `partial: true`, `verifyFile()` returns both flags, and `verify.js` prints
**VALID BUT RECOVERED — good enough for a badge, not record-grade evidence** instead of a plain
VALID. Anything that grades evidence must read those flags rather than just `ok`.

This is not hypothetical: it is how the case was found. On Windows `child.kill('SIGTERM')` is
`TerminateProcess`, so a host killed from another process never runs its shutdown handler and the
replay is left unsigned. On Linux (production) SIGTERM is delivered and the shutdown path closes
and signs every live game's replay first; `test/demo-network.js` now asks each box to end its games
cleanly before killing it, so the demo stops manufacturing the crash case.

---

## 6. Feature verdicts

| Feature | Verdict | Evidence |
|---|---|---|
| **Cross-server chat** | **Works.** | `test/demo-network.js` §5: a player line in game A reaches the site ring, box B's game console prints it, and a line typed on the website appears in both games. Long-poll drain (`?since=&wait=`), copied from `/api/gs/chat-feed`. |
| **Invite tokens** | **Works against the real site, fails closed.** | Tokens minted by `web/`'s Ed25519 key, verified by the box against the public half it fetched: both real players ALLOW, a forged one `bad_signature`. |
| **Invite tokens, the awkward cases** | **All refused.** | §4 of the two-box demo: 2 genuine invites join, a **forged** token is refused `bad_signature`, an **expired** one `expired`. Also refused: wrong match, wrong SteamID, re-used `jti`, edited payload, and garbage. With no token or no site key, a box with checks required refuses everyone rather than becoming an open server. |
| **24 h cap + warnings + clean end** | **Works.** | Demo §6b on an 8-minute clock: warnings at 5/3/1, `end` sent, game saved with `cap_reached`, replay written and verified. Unit-tested on the real 30/10/1 schedule. VIP lobbies are genuinely uncapped. |
| **AFK warn/kick** | **Works.** | Warn at 10 min, kick at 15, active players untouched, coming back clears it, everyone-idle pauses then closes. A simulator bug found this: an "AFK" player who still typed reset their own timer — chat **is** activity, which is correct, and the sim was wrong. |
| **Replays + verification** | **Works, and the cost is trivial.** | 5.98 MB/4-player-game-hour, $4.73/month at 25 concurrent games with 90-day retention. Signed, chained, seekable, tamper demo included. A host killed mid-game leaves an unsigned file; `tools/recover.js` salvages it, clearly marked as lower-grade evidence. |
| **Pull protocol** | **Works, against the real site.** | Lease → boot → `status=ready` → play → `POST /api/gs/result`, proven twice: two boxes against the mock, and one box against `web/` on :3200 driven by its own party rail (§3c). Results survive the site being down (spool + `POST /api/gs/spool`). |
| **Live view / spectating** | **Works.** | `http://127.0.0.1:8787` — instances with live CPU/RAM, round, players, a 2D top-down canvas of player and zombie positions at 4 Hz, event log, chat, and playback of a recorded replay chunk-by-chunk. This is the prototype of the web live view in 99 §4.4 and of phase 2 of the replay roadmap. |
| **Instance manager** | **Works, against the real game.** | Start/stop/restart/reap, per-instance logs, one port and id each, `ENW_HOST`/`ENW_INSTANCE`/`ENW_ROLE`, CPU+RAM sampling, PID-scoped kills only. Verified against a real `CoDWaW.exe` at 01:02: the DLL connected and the manager adopted the game's PID. It refuses cleanly when another agent holds `game.lock` (*"game.lock is held by dedi (probe p19-saved-retry) — not launching"*) without touching the lock file. |
| **Referee state machine** | **Works.** | 41 in-process checks, all green, against the referee agent's real manifests. |
| **Crash recovery** | **The host's half works; the game's half needs the DLL.** | State is captured on the drop, held against the SteamID with the limited weapons reserved, and handed back on return with a resume countdown; a record-profile game gets the pause and no restore. Proven against a real agent + simulator, plus six in-process checks. What cannot be verified here is whether the DLL's builtins can actually restore downed state and per-player flags (vault 10 §5 lists those as hard). |
| **Play Local** | **Works, and refuses in all the right places.** | `test/demo-local.js`: ignored by default, refused unregistered, adopted when registered, refereed and recorded with `self_reported` inside the signed header, and refused outright on a box with `--site`. |
| **Live spectator frames** | **Works; the site's shim can be deleted.** | 87 frames in 22 s to the real site, 0 dropped; `GET /api/live/<match>` returns real player positions. |
| **Density** | **The agent is not the constraint.** | 20 simulated games on one agent: 0.05 core total, flat per-game cost, 1,215 events/s, nothing dropped, ~4.9 MiB of agent memory per game. |
| **Soak** | **No leak found in 24 minutes — not the same as no leak.** | 24 min, 6 games, 518k events, 0 dropped, frame p99 inside target. Game processes flat. Agent RSS sawtooths with a **flat trough** (148.0/148.7/148.1) and a flat 12–15 MiB JS heap, so the ~139 MiB above it is native buffer churn in the replay path, not retention. The 20-hour run is still owed. |

---

## 7. Two things the protocol needed, and one thing it got wrong

Changes to `docs/protocol/game-link-v0.md` are noted on the board. In summary:

1. **`dvar` and `level_var` game→host events (added).** The manifest schema grew `{"dvar":…}` and
   `{"level_var":…}` conditions, and v0 had no event that could satisfy either. `level_var` is not
   optional: `nazi_zombie_ali`'s real ending sets `level.tom_victory`, and a plain script variable
   never notifies, so the DLL must poll a small allow-list. The dvar log is also what vault 10 asks
   the replay to carry.

2. **`notify` `"trigger"` argument shape (pinned down).** `{"t":"notify","name":"trigger","args":{"targetname":…,"zombie_cost":…}}`
   is what `{"trigger_used":…}` matches. Both manifests that use it depend on the exact spelling.

3. **"drop oldest on overflow" is wrong as written — this is the real finding.** Running the
   simulator at 300× saturated the link, the sender dropped the oldest queued messages, and `round`
   events went with them: the referee saw a game stuck at round 21 while the game was well past it.
   The summary, the badge and the record would all have been wrong, silently, with no error
   anywhere. **Only `snap`, `input` and `perf` may ever be dropped** — they are resampleable.
   Everything else is evidence and must block the sender thread instead (never the game frame). The
   same rule now applies to the host's outbound queue: `say` and `tell` are droppable, `auth`,
   `kick`, `end`, `pause`, `resume`, `exec` and `set` are not.

   A real game at 1× produces 25–40 events/second, so this never triggers in normal play. It
   triggers exactly when something is already going wrong, which is when the log matters most.

Also clarified: `input` at "at most 10 Hz, only on change" means **on a change of the
moved/turned/fire state plus a 1 Hz heartbeat while active** — a continuously-moving player would
otherwise emit 10/s forever, and AFK scoring does not need it.

---

## 8. Alignment with IW4MAdmin (MIT), and the demo-recording question

Both from vault `Research/R12` and `R13`.

### Event names and summary schema
IW4MAdmin's `feature/zombie-stats` (MIT) models almost exactly our data. Where it costs nothing, we
now use its field names so the two can be merged later without a mapping table. Each player in the
summary carries a `stats` block shaped like its `ZombieClientStat`:
`kills, deaths, headshots, downs, revives, points_earned, points_spent, highest_points,
time_alive_ms, rounds_played`.

**Where we deliberately differ:**
* **Transport.** Theirs is `LogPrint("PREFIX;field;field")` into the game log plus dvar polling,
  because on T4 that is the only channel GSC has (libcod does not support WaW). Ours is our own DLL
  over a TCP socket, which gives us 20 Hz position snapshots, ordering, and a reply channel — none
  of which a log line can carry. We keep the log as a **mirror**, not as the transport.
* **Damage.** They track damage and melees per client. We do not: our `points` ledger is the
  authority for scoring and a damage counter adds event volume for no board rule we have.
* **Evidence.** Their `ZombieEventLog` is a database table. Ours is a hash-chained, signed,
  seekable file. That difference is the product.
* **Per-round rows.** Their `ZombieRoundClientStat` stores a row per player per round. We store
  `rounds_played` and `time_alive_ms` and leave per-round slicing to the replay, which has it at
  20 Hz anyway.

`lib/gamelog.js` (on by default, `--game-log off`) writes a **`games_mp.log` per instance** in B3's
canonical cod5 grammar (`InitGame:`, `J;`, `Q;`, `K;`, `say;`, `ExitLevel:`) plus zombies lines under
our own `ENWZombie;` prefix. It costs a few hundred bytes a minute and means IW4MAdmin-style tooling
and log tailers can read our servers unmodified. Our own `ENWZombie;` prefix rather than theirs is
deliberate: their T4ZM stat emitter is a **closed premium plugin**, so we cannot match its prefixes,
and inventing lines under their prefix would be worse than being distinct. **The log is not
evidence** — it is unsigned plain text and nothing reads it back.

### Could the referee ship as an IW4MAdmin plugin later?
Yes, and the boundary is already right. `lib/referee.js` and `lib/manifests.js` have no I/O: they
consume plain event objects and emit plain command objects and a summary. Re-hosting them behind
an IW4MAdmin log parser means writing an adapter from its parsed lines to our event shape —
everything else transfers. The one thing that would **not** transfer is the 20 Hz position track
(a log line cannot carry it at that rate), so an IW4MAdmin-hosted referee would produce the
`events-only` replay tier, not the full one. Boards and badges would work; records-grade replays
would not. Worth keeping in mind, not worth changing anything for now.

### Server-side demo recording (`.dm_6`) — short spike, recommendation: **do not pursue now**
* The engine records demos **client-side** (`/record`, `%LOCALAPPDATA%\…\demos\*.dm_6`), one file per
  client, that client's own view only. A headless dedicated server has no client to record from.
* R13's primary source (DemosToDiscord's support matrix, MIT) states server-side demo recording
  covers **BO2 and BO1 multiplayer**, while **T4/T5 zombies are "metadata only" — unavailable**.
  That is Plutonium's implementation, not proof the engine cannot, but it points the same way as
  "there is no server-side recorder in T4".
* Even if it worked, a demo is **not evidence**: it is unsigned, unchained, not bound to a match
  id or a roster, and trivially editable. Our container exists because a record has to be provable
  without a video.
* What the demo work *is* worth: `Riyondev/cod4-dm1-tools` (MIT, TypeScript, camera-path export)
  and `Iswenzz/CoD4-DM1` (GPL-3.0) are real parsers for the parent engine's format, and a future
  3D viewer could borrow their rendering rather than their format.
* **Recommendation: keep our recorder as the plan, unchanged.** File one cheap future spike for the
  dedi agent — once a real headless server exists, try `/record` in a zombies game and see whether
  anything usable comes out. If it does, the sensible shape is **"demo for playback, our signed log
  for proof"**, with the demo as an optional VIP extra alongside the replay, never instead of it.

### `gameserve.rs`
Noted, not used. A free, key-less, CORS-open JSON API (`/servers`, `/trending`, `/activity`,
`/leaderboards/zombies`) scraped from public server-browser info with **no verification at all** —
its top zombies entry is round 21,470. If it responds, it is a good source for a "what's happening
in the wider scene" panel and a very good advertisement for verified boards. Nothing in the host
agent touches it.

---

## 9. What is not done, and what to do next

* ~~**The real game has connected but not been measured.**~~ **Done 2026-09-22, §10.3**: a real
  headless dedicated server, launched by this agent, answering `getstatus` on the wire, at
  **0.050 of a core and 185 MiB with no players**. What is still owed is a game with a **player**
  in it — the round counts, the replay contents and the cost under load are all still simulator.
* **Real-game launch notes for whoever picks this up.** The game copy is `ZombiesDev\waw-host`
  (`tools\dev\new-copy.ps1 host`), the DLL goes in with `tools\dev\deploy.ps1 host -From <build>`,
  and `launch.ps1` — not the host agent — takes `game.lock`, under the name of the copy (`host`).
  The host agent therefore checks the lock, refuses if someone else holds it, and never writes it;
  it adopts the PID `launch.ps1` prints and polls that, because the PowerShell wrapper exits while
  the game keeps running. `--dry-run` prints the exact launch line and starts nothing.
* **The sim's curves are `[approx]`, not WaW.** Round budgets, zombie health/speed, kill rate and
  round length are a plausible ramp chosen so the zombie load is realistic (15 alive average, 24
  peak, round 22 in an hour at 4 players). Replace them from the real DLL's logs; nothing else
  depends on them, but the replay size numbers do move with them — an earlier, wrong kill rate
  under-measured 4-player replays by 25%.
* **Chunk bodies are NDJSON, not columnar CBOR.** Vault §5.4's format would cut size further;
  the container, chain, signature and index are designed so that swap changes one function.
* ~~**Nothing happens at game over.**~~ **Done 2026-09-22, §12**: the replay is signed, the result
  posted, and the instance either reused (`end` -> `map_restart` -> warm) or terminated, per config.
  What is owed is running it against a **real** `CoDWaW.exe` — the logic is proven against the
  simulator and a fresh site only (§12.9).
* **No records tier.** Vault 10 phase 4 adds every usercmd (~300 MB for 20 h). The protocol has no
  `usercmd` message yet; add it when the boards need it.
* **The mock site is a mock.** In-memory, no database, one shared secret per box, `/admin/*` routes
  with no auth at all. It exists to prove the shape and must not grow into the real site.
* **Port clashes are a real failure mode on a shared machine.** Three agents run tools here and two
  of them took ports this code had hard-coded. A busy **dashboard** port no longer kills the box (it
  logs and carries on — refereeing games is the job); a busy **game-link** port still does, correctly.
  Both test harnesses now fail loudly with the port in the message instead of letting somebody
  else's box quietly take the lease.
* **The 20-hour soak still has not been run**, only 24 minutes of it (§3h). The two things it would
  settle are whether the native buffer band really is a band, and whether a single game's referee
  and replay writer drift over a full day.
* **Not tested**: a link peer that lies, the restore of downed state and per-player flags,
  and whether the DLL's builtins can put back everything the snapshot holds.
* ~~Results are lost if the site is down~~ — **done**: spooled to disk and drained through
  `POST /api/gs/spool` (§3b). A box with a non-empty spool must not be destroyed.
* **The `games_mp.log` prefix is not settled.** The referee agent proposes `GSE;` for the DLL side;
  the host writes `ENWZombie;` today. Both are one configurable string (`--game-log-prefix`). One
  of us should win — see the note at the end of `questions.md`.

---

## 10. Session 2026-09-22 — `hostlane`: the box, end to end, against a real game

Everything in this section was run tonight on B's PC. **Observation and inference are kept
apart**, and where a number is a sandbox artefact it says so.

### 10.0 The state before anything was changed

Run first, fix second. This is what the suites said on arrival:

| Suite | Result |
|---|---|
| `infra/host-agent/test/run-all.js` | **41 passed, 0 failed** |
| `infra/host-agent/test/demo-network.js` | **0 failures** (two boxes, mock site, tokens, chat, cap, AFK, 3 replays verified) |
| `infra/host-agent/test/demo-local.js` | **2 failures** then a crash — see §10.1 |
| `web/` `npm run check` | **55 + 27 + 8, 0 failed** |
| `infra/host-agent/test/integration-site.js` | **4 failures** on a fresh site — see §10.4 |

So: three of five green, and both red ones were the harness, not the product. Neither had
ever been run in a state that could expose them.

### 10.1 `--timescale` silently under-ran by 2.5x, and that is what broke `demo-local`

`test/demo-local.js` failed with `no summary` and then `replay invalid: no footer magic`.
The obvious read — the local-adoption path is broken — was wrong. The game was refereed
perfectly; it just took **116 s** of wall clock where the test waits **80 s**.

The sim paced itself with `setInterval(TICK_MS / timescale)` and a fixed batch per fire.
Nothing in that process raises the Windows timer resolution, so:

```
200 fires of setInterval(6) took 3130 ms => 15.65 ms each -> 63.9 Hz
```

`--timescale 8` asks for one 50 ms tick every 6 ms, gets one every 15.65 ms, and therefore
advances at **3.2x, not 8x**. Measured, not reasoned: the 8-round solo game reports
`sim time 6m12s` and took 116 s of wall clock. 372/116 = 3.2.

Fixed by pacing against the wall clock — each fire steps as many ticks as the elapsed time
has earned, capped at 20 s of sim time so a stalled process cannot come back and spin.
`demo-local.js` now finishes in ~46 s: **0 failures, all 13 checks**.

**Inference, not observation**: every `--sim-timescale` number in §3 was measured through
the same pacing, so anything derived from *elapsed wall time* at a high timescale was
optimistic. The replay sizes in §3a are per **game-hour** and come off the sim clock, so
they do not move. The density and soak numbers in §3e/§3h are wall-clock and were taken at
1x or low timescale, so they do not move either. Nothing in §3 is retracted — but anything
measured at timescale > 3 from here on will genuinely run faster than it used to.

### 10.2 A real box goes ONLINE and the launcher's Play button turns itself on

The launcher greys Play on `capabilities.play`, which is
`require('web/server/lib/boxes').list().some((b) => b.online)` in
`web/server/routes/launcher.js`. That was the thing to prove.

Own site on a spare port, own temp data dir, nothing near :3200 or the tunnel:

```bash
ZM_DATA_DIR=C:/Users/b/ZombiesDev/tmp-hostlane/data node web/server/db/seed.js
ZM_DATA_DIR=... ZM_PORT=3401 node web/server/index.js
node infra/host-agent/host.js --site http://127.0.0.1:3401 --secret devkey-a --box box-a \
     --link-port 38871 --dash-port 8871 --base-port 29800
```

Before the box: `GET /api/launcher/hello` -> `"play": false`. After ~10 s of polling:

```
23:36:16 info host  site invite key 6d8343c234c99b8a loaded — token checks ENFORCED
23:36:26 info host  replay key 7e9a0b0621f3c345 is PINNED at the site — replays are record-grade
```

```js
boxes.list().some(b => b.online) === true
{ "id": 1, "name": "box-a", "online": true, "last_state": "idle",
  "key": { "pinned": "7e9a0b0621f3c345", "pinned_at": 1790033786078, "pending": null } }
```

and the JSON the launcher actually receives:

```json
"capabilities": { "play": true, "settings": true, "state": true, "reports": true,
                  "live_view": true, "local": true, "map_downloads": true,
                  "replay_downloads": true, "local_resume": true, "og_cards": false }
```

**`play` is true the moment a box polls, with no release and no flag.** That half of the
MVP needs nothing further; it was already correct and had simply never been exercised
against a box on a database that had one.

Note for whoever runs this next: a site data dir under a long path fails with
`SQLITE_CANTOPEN` and the message names neither the path nor the length. Keep it short —
`C:\Users\b\ZombiesDev\tmp-...` rather than a deep scratch directory.

### 10.3 A REAL headless game, launched by the host agent, answering on the wire

This is the one that had never been done. §3d and §9 both say the real game has connected
but never been measured; that is now out of date.

**Three things were wrong with `--game`, and none of them could ever have worked:**

1. **`+set dedicated 1` was never passed at all.** `gameArgs()` emitted `fs_game`, `map`
   and `net_port` and nothing else. Every `--game` launch this agent has ever made was a
   windowed single-player game wearing a server's name. The 01:02 run in the header that
   "proved the path" proved the *launch* path; the process it started was not a server.
2. **`+map` came before `+set net_port`.** The engine runs `+` commands in command-line
   order and `+map` is the one that starts the server, so the port was set on a server that
   was already listening on 28960. A box would then probe a port nothing was on.
3. **Neither `ENW_RAW_SOCKETS` nor `ENW_DEDI_SUPPRESS_MAPSUMMARY` was set.** Both are
   proven engine blockers (dedi.md §7f wall 2 and §0), not hygiene: without the first the
   server answers nothing at all, and without the second `Com_Init` never returns.

The recipe now lives in `lib/instances.js` `gameArgs()`/`gameEnv()` with
`tools/dev/jointest.ps1`'s server half named as its source of truth.

**The run**, `waw-host` with `build/dedi` deployed, `node host.js --boot 1 --game --map
nazi_zombie_prototype --base-port 28970 --game-copy host`:

```
23:44:54 info host/inst/inst-01  start game port 28970
23:44:56 info host               instance inst-01 linked (pid 24704, Sep 20 2026 00:58:12)
[proof] udp/28970 ANSWERED after 4s (oob.py exit 0)
    getstatus      ANSWERED   674 bytes: statusResponse \mapname\nazi_zombie_prototype
                              \sv_maxclients\4 \protocol\62 \gamename\Call of Duty: World at War
    getinfo        NO REPLY
    getchallenge   ANSWERED   45 bytes: challengeResponse 1606104307 MYOMMKtyYPM=
23:44:57 info host/inst-01       map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten"
23:44:57 info host/inst-01       recording -> ZombiesDev\replays\m_58da71bb.enwr
23:45:06 info host/inst/inst-01  game PID 24704 adopted (launcher holds game.lock as "host")
```

**The gate is `oob.py`'s exit code**, never a grep — jointest.ps1's own warning, because
"REPLY" matches inside "NO REPLY".

**The first real per-game cost figures. These are `CoDWaW.exe`, not the simulator:**

| | value |
|---|---|
| CPU, headless, map loaded, no players | **0.046 of a core** (`usage.cores_avg`, over 45 s) |
| RSS | **185 MiB**, flat, peak == current |
| Time from `start game` to answering on udp | **4 s** |
| Threads | 16–18 |

That is **~7x lower than the 0.3–0.8 core per game** in vault 14's cost model, and it agrees
closely with `dedi`'s own independent soak (4.85% of a core, 186.3 MB). **The caveat that
matters: no players.** A player, zombies and 20 Hz snapshots are all still to come, so treat
0.046 as the idle floor, not the per-game figure.

**The clean stop, which is the other half of the claim:**

```
POST /api/instance/inst-01/stop -> 200
23:45:45 info host/inst/inst-01  stopping: stopped from the dashboard
23:45:46 info host/inst/inst-01  exit code=null signal=killed
lock after stop: (none — released)
CoDWaW.exe PIDs after: [none]
every PID that existed before us is still alive — we killed only our own
```

`stop()` runs `taskkill /PID <gamePid> /T /F` — the adopted game PID, never a name — and
`releaseGameLock` only deletes a lock whose owner string matches, so it cannot free another
agent's. One gap found and fixed while proving it: `/api/state` reported only `pid`, which
for a real game is the **PowerShell wrapper** that exits seconds later. The game's own PID
is now `game_pid` in the instance info.

**`getinfo` gets NO REPLY while `getstatus` and `getchallenge` answer.** Observed on two
different instances, twice each. Not chased — `getinfo` is the server-browser heartbeat
reply and nothing we do needs it — but it is a real asymmetry and worth knowing before
somebody spends an evening on a master-list listing.

### 10.4 The result path, on a fresh site, with nothing curated by hand

`test/integration-site.js` against the temp site: **0 failures, 20 checks**, party -> lease
-> boot -> invite tokens -> referee -> signed replay -> result -> games/players/XP.

```
game    nazi_zombie_factory round 12 finish=none mode=verified eligible=true
player  Leader  score 3900  xp 1193  rounds 12
player  Mate    score 3680  xp 1193  rounds 12
replay  958891 bytes, key 96de531ff9d313d9, pinned=true
m_ef63a067.enwr: VALID against the pinned key — 12 chunks, 28631 events
...and it correctly FAILS against a key that is not the pin
```

The run reaches the home feed (`GET /api/home` -> `feed[].kind = "record"`, both players,
Der Riese), and the **replay slot is real, not a placeholder**:

```json
{"match_id":"m_ef63a067","box":"box-b","size":958891,"chunks":12,"events":28631,
 "key_id":"96de531ff9d313d9","key_pinned":true,"tier":"full","grade":"signed",
 "reason":"signed by the box's pinned key","available":false,
 "verify_command":"node infra/host-agent/tools/verify.js \"...m_ef63a067.enwr\" --pub 3nHwgv..."}
```

`available:false` is honest rather than broken: the bytes were written into the test run's
own replay dir, not the site's, and the site says so instead of pretending.

**Why it had four failures before.** On a fresh database only the **first** account to sign
in is approved (`routes/auth.js` makes it admin); everybody else is on the beta waiting list
and `requireApproved` refuses them. So the second player could not join the party, and three
more checks fell over behind it. The harness had only ever been run against a database
somebody had already curated. It now approves the mate through the admin route the leader
already has rights to, best-effort and idempotent. **The site was right and the test was
wrong** — worth saying plainly, because the first reading was "party join is broken".

### 10.5 Two headless instances on one box — measured, and it works

> **2026-09-23 (`dedi.md` §19): three, and the agent is fixed for it.** The engine falls forward
> up to 100 lobby ports, not just 3074 → 3075. Each game gets `ENW_LOBBY_PORT = --lobby-base +
> slot`. On the box the game copy and homepath follow the **slot** (`{slot}` = `inst-01`… by game
> port), not the ever-growing id: after four boots the old `waw-{id}` failed every lease ("no game
> copy at waw-inst-05", B's Play included). `checkSlotCopies()` caps `max-instances` at the
> copies that exist. Real games boot one at a time, each waiting for the previous `map_loaded`,
> for at most 90 s. Three were proven concurrently on the box. **The site still leases one game
> per box** (`assignments.lease` supersedes by `box_id`), so a second Play replaces the first
> game.

`dedi.md` §9.2 item 4 records this as unsolved: several games share
`%LOCALAPPDATA%\Activision\codwaw` including the single-instance `__CoDWaW` marker, and
"collide on **UDP 3074**". **The engine half of that is wrong, and the measurement is
cheap enough that nobody should have had to guess.**

Two headless dedicated servers, two game copies (`waw-host`, `waw-host2`), both on the
**shared** profile, the second launched `-Companion` so only one `game.lock` ever exists:

```
A  waw-host   PID 29044  udp 3074, 28970   ANSWERED (oob.py exit 0)   182 -> 185 MB, 10 -> 13 threads
B  waw-host2  PID 30208  udp 3075, 28971   ANSWERED (oob.py exit 0)   182 MB,        10 -> 12 threads
SIMULTANEOUS: A(udp/28970) exit 0 ANSWERED   B(udp/28971) exit 0 ANSWERED
3074 owners: 29044          (one process, not two)
```

**The engine falls back from 3074 to 3075.** It is not a hardcoded exclusive bind; the
second instance takes the next port and neither cares. Both served `getstatus` and
`getchallenge` at the same time, on their own `net_port`s, with `mapname
nazi_zombie_prototype` in both replies.

Neither instance was blocked by the `__CoDWaW` marker either. Markers **are** created (a
later launch cleared a stale one naming a dead PID), but nothing refused a launch, and
`launch.ps1 -Companion` already tolerates a marker that belongs to the experiment's first
instance.

**So the engine supports several instances per box today. The host agent does not**, and
that is now the limit:

* every game instance uses the manager's single `gameCopy`, so the same
  `ZombiesDev\waw-<copy>`, the same `fs_homepath`, and the same `game.lock` owner name;
* `launch.ps1` takes the lock exclusively, so the second launch throws.

Observed, not reasoned — `--boot 2 --game` before the fix:

```
00:10:06 info  host/inst/inst-02  start game port 28972
00:10:08 info  host/inst/inst-02  exit code=1 signal=- (unexpected)
00:10:08 warn  host/inst-02       instance exited unexpectedly — saving the game up to the crash
00:10:08 info  host/inst-02       SUMMARY null round 0 flags=[server_crash]
```

A game that never existed, recorded as a **crashed** one, because both started in the same
tick and the lock file did not exist yet for the pre-flight check. It now refuses with the
real reason and no fake crash:

```
00:11:51 warn  host/inst/inst-02  only one real game per box: inst-01 already holds game copy "host" and the game lock
```

**What it would take to lift it** (not done, and it is a design decision, not a bug fix):

1. **A game copy per instance.** `waw-host`, `waw-host2`, … — `tools\dev\new-copy.ps1` makes
   one for ~12 MB of real files plus junctions, so this is cheap. `gameCopy` moves from the
   manager to the Instance.
2. **`-Companion` for instances 2..n**, so one box still holds exactly one `game.lock`. The
   alternative — a counting lock — changes a rule three agents rely on, and should not be
   done quietly.
3. **Nothing about UDP 3074.** Measured above.
4. **Probably nothing about the profile either** — see §10.6, which is the surprise.

### 10.6 `ENW_PRIVATE_PROFILE` is not the fix, and on an unseeded copy it is the problem

`shared/core/components/instance_paths.cpp` exists to give each instance its own AppData
(an IAT patch on `SHGetFolderPathA`), gated behind `ENW_PRIVATE_PROFILE=1` and marked in
its own header as **NOT YET PROVEN END TO END**. It now has a first result, and it is a
negative one.

`launch.ps1 host -PrivateProfile`, one instance, no companion, nothing else running:

```
dialog answered: 'Error' >> Cancel [2:OK]  msg: Exceeded limit of 1 'snddriverglobals' assets.
[cpu] answered on udp/28970: False
```

**Reproduced twice, and once more inside the two-instance run.** Without `-PrivateProfile`
the identical launch line answers in 4 s. The difference is the profile directory:

| copy | `homes\<name>\appdata\Activision\CoDWaW` | with `-PrivateProfile` |
|---|---|---|
| `waw-host` (made 2026-09-20, before new-copy seeded profiles) | exists but **empty** — `launch.ps1` creates the tree, nothing fills it | **fails**, `snddriverglobals`, never answers |
| `waw-host2` (made tonight) | a full profile tree seeded from B's own | **answered** on udp/28971 |

So the reading is **"an empty private profile breaks the engine"**, not "the IAT patch is
broken" — and the failure mode is the worst kind: a modal error box that `launch.ps1`
dismisses, after which the process sits there burning a core and answering nothing. A
harness that gated on "is the process alive" would call that a healthy server.

**Recommendation: do not turn `ENW_PRIVATE_PROFILE` on to get multiple instances.** The
measurement in §10.5 says it is not needed for that, and this section says it costs a whole
new failure mode. Keep it for the case it was actually written for — a player's own PC,
where the profile genuinely must not be shared — and make `new-copy.ps1`'s seeding a hard
precondition of using it. `waw-host` should be recreated before anybody tries it again.

### 10.7 What is now proven, what is not, and what needs B

**Proven tonight, with the evidence above:**

| | |
|---|---|
| A box goes online and the launcher's Play button un-greys | §10.2 — `boxes.list().some(b => b.online) === true`, `"play": true` |
| The host agent launches a REAL headless dedicated server | §10.3 — `oob.py` exit 0, `statusResponse \mapname\nazi_zombie_prototype` |
| What an idle real server costs | **0.050 of a core, 185 MiB** — two independent measurements agreeing |
| It stops cleanly, by PID, and releases the lock | §10.3 — `taskkill /PID`, `lock after stop: (none)`, nothing else killed |
| Lease → boot → tokens → referee → signed replay → result → DB → home feed | §10.4 — 20 checks, 0 failures, on a database nobody had curated |
| Replays have a real slot, not a placeholder | §10.4 — pointer, grade, key pin, `verify_command`, download gating |
| Two headless servers coexist on one box | §10.5 — both answering, 3074 → 3075 |

**Not proven, and nobody should claim it:**

* **No player has ever been in one of these games.** Everything above is a server with an
  empty roster. The referee, the rounds, the replay contents and every per-game cost *under
  load* are still the simulator. ~~That waits on the client spawning in.~~ **The client spawning
  in happened later the same night** (`dedi.md` §7h, runs `join12`–`join18`) — but under
  `tools\dev\jointest.ps1`, not under this agent, and the server stops about ten seconds
  afterwards (`dedi.md` §7j). So what this now waits on is that freeze, and then pointing a real
  client at a game **this** agent launched.
* **0.050 of a core is the idle floor, not the per-game cost.** A player, zombies and 20 Hz
  snapshots are all still to come.
* **`getinfo` gets NO REPLY** while `getstatus` and `getchallenge` answer. Seen on every
  instance, every time. Nothing we do needs it; a server-browser listing would.
* **Three or more instances** were not tried. Two work; the port fallback suggests more
  will, but that is inference.
* **The 20-hour soak is still owed** (§3h), and now there is a real game to point it at.

**Needs a decision from B, not from us:**

1. **Does a box run one game or several?** The engine allows several (§10.5) and the host
   agent allows one. Lifting it is a copy per instance plus `-Companion`, roughly half a
   day, and it changes how `game.lock` reads on a busy box. It is not on the MVP path —
   one player, one map, one run — so it should probably wait.
2. **`waw-host` wants recreating** (`new-copy.ps1 host -Force`) so its private profile is
   seeded. Harmless either way while `ENW_PRIVATE_PROFILE` stays off, which is the
   recommendation in §10.6.

---

## 11. Session 2026-09-22 — `vps`: the agent runs on Linux, launches through Wine, and two instances fit

Written by the **vps** lane, against the Hetzner box `zombies-dev`. The full story of the box is
`docs/kickstart/vps.md` §13–§15; this section is only what changed in `infra/host-agent/`.

### 11.1 `--wine`: a second launch path, off by default

`spawnArgs()` had exactly one way to start a real game — `powershell -Command tools\dev\launch.ps1`
— and on the Linux box there is no PowerShell, no Windows game copy and no
`ZombiesDev\locks\game.lock`. Rather than fork the file, `--wine` adds a branch:

| | Windows (default) | `--wine` |
|---|---|---|
| spawned | `powershell.exe -Command & launch.ps1 …` | `wine CoDWaW.exe …`, `cwd` = the game copy |
| the PID we sample | adopted from the `PID <n>` line the launcher prints | **the child itself** |
| `game.lock` | `launch.ps1` takes it, we check and release it | none — there is no lock on Linux |
| `SteamAppId` / `WINEPREFIX` / `DISPLAY` | `launch.ps1` sets them | the agent sets them |
| instances | exactly one (shared copy, homepath and lock) | one per `{id}` path — see 11.3 |

Everything else is shared on purpose: `gameArgs()`, `gameEnv()` (`ENW_RAW_SOCKETS`,
`ENW_DEDI_SUPPRESS_MAPSUMMARY`), `ProcSampler`, stop-by-PID, the restart policy. If the two ever
disagree about how a server is launched, that is a bug, not a configuration.

Flags: `--wine`, `--wine-bin` (`wine`), `--wine-prefix` (`/home/waw/pfx`), `--wine-display`
(`:99`), `--wine-debug` (`-all`), `--wine-game-dir`, `--wine-homepath`, `--wine-maxfps` (60).
`{id}` in either path is replaced with the instance id.

`node test/run-all.js`: **41 passed, 0 failed**, unchanged. `cfg.wine` is `null` without the flag,
so the Windows path is byte-for-byte what it was.

**One thing the Windows path is missing and the Wine path has**: `+set com_maxfps 60`.
`gameArgs()` never passed one, and `jointest.ps1` is emphatic that without it a dedicated server
free-runs at ~237 Hz and burns a whole core (`dedi.md` §7j). The Wine branch passes it; the
PowerShell branch still does not, because `launch.ps1`'s own defaults are the host lane's call.
Worth settling.

### 11.2 It ran, against a real game, on Linux

```
info host/inst/inst-01  wine: /home/waw/pfx/drive_c/zdev/waw-vps1 -> fs_homepath C:\zdev\homes\vps1
info host/inst/inst-01  start game port 28960 -> CoDWaW.exe
info host                instance inst-01 linked (pid 2764, Sep 20 2026 00:58:12)
info host/inst-01        map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten" (read)
info host/inst-01        recording -> /home/waw/zdev-host/replays/m_662ac3c0.enwr (fingerprint bee9057f5a57a2bf)
```

and from **B's PC**, against the box's public address:

```
> python tools\dev\oob.py 28960 --host 2.28.235.236 --allow-remote
getstatus  ANSWERED  674 bytes: statusResponse | … \mapname\nazi_zombie_prototype\sv_maxclients\4…
OOB EXIT CODE = 0
```

Per instance, no players: **0.30 of one core, 301 MB RSS, 60.0–60.8 Hz, 11 threads, 10 s from
launch to answering.** That is **6× §10.3's 0.050 of a core** on B's PC for identical work — a
cx23's shared Skylake vCPU plus Wine, not a regression.

**Node 24 is required** (zstd, Ed25519, `node:sqlite`) and Ubuntu 24.04 ships 18.
`infra/vps/06-node-host-agent.sh` puts the official tarball in `/opt/node24` and leaves
`/usr/bin/node` alone.

### 11.3 Two instances per box, and §9's "one real game per box" is now a Windows-only rule

§9 and `instances.js` said one game per box because every instance shared a game copy, an
`fs_homepath` and the lock. On Linux, `{id}` in `--wine-game-dir` and `--wine-homepath` gives each
instance its own, and the refusal only fires when the configured paths have no `{id}` in them —
which is still the honest default.

With four per-instance copies (8 MB of real files each; `main/` and `zone/` are symlinks into one
shared tree), started **one at a time and waited on**:

| | udp | answered | fps | RSS | CPU | `oob.py` from B's PC |
|---|---|---|---|---|---|---|
| inst-01 | 28960 | 5 s | 60.6 | 301 MB | 0.281 core | **exit 0** |
| inst-02 | 28962 | 5 s | 60.3 | 301 MB | 0.286 core | **exit 0** |
| inst-03 | 28964 | never | — | 156 MB | 0.003 | exit 1 |
| inst-04 | 28966 | never | — | 44 MB | 0.036 | exit 1 |

**Two.** And the limit is not CPU (0.57 of two cores), not RAM (no OOM in `dmesg`) and not disk
(21 GB spare): it is the party/lobby layer's hard-coded **UDP 3074 with a single fallback to
3075**. `ss -ulnp` shows inst-01 on 3074, inst-02 on 3075, and instances three and four binding
**nothing at all** — they park inside `Com_Init` before they open even their game port. §10.5
measured the 3074/3075 pair and correctly said they do not collide; nobody had tried a third.

**Two operational consequences for this lane:**

1. **Start instances one at a time and gate on the wire.** `--boot 4` in a single tick is *worse*
   than sequential — it got one instance to a loaded map and left three stalled at 44 MB. The
   `--boot N` path should serialise and wait for `getstatus`, the way `jointest.ps1` does.
2. **`max_instances` for a Wine box is 2**, until somebody finds the 3074 bind site and widens it.

### 11.4 Not done: the box is not registered with the live site

`--site https://zombies.enw.gg` needs a per-box `match_key`, and the only place one can come from
is `boxes.create()` against the live site's `web/data/zombies.db`. The vps lane does not write to
`web/data`, so this stopped here. The live table holds one box, `box-a` (B's PC), with `polls: 0`.

For whoever owns the site — one call, then the box is online with no further work:

```js
require('./server/lib/boxes').create({ name: 'zombies-dev', matchKey: <fresh random secret>,
  region: 'nbg1', note: 'Hetzner cx23, Wine', maxInstances: 2 })
```

then on the box: `/home/waw/run-host.sh --boot 1 --site https://zombies.enw.gg --secret <it>`.
The site is pull-only, so no inbound rule and no firewall change is involved.

### 11.5 The box is registered and runs as a systemd service (2026-09-22 05:30)

`zombies-dev` is box **#3** at the live site, `max_instances` **2**, `enabled`, and it is **online**:

```
{"id":3,"name":"zombies-dev","online":true,"last_state":"idle","region":"nbg1",
 "max_instances":2,"key":{"pinned":"1cbc9958b50941ed"}}
capabilities.play (boxes.list().some(b => b.online)) = true
```

```
info host  site invite key b74d9a7c9874d877 loaded — token checks advisory
info host  replay key 1cbc9958b50941ed is PINNED at the site — replays from this box are record-grade
info host/site  assignment changed: idle   (nonce idle)
```

The secret came from **`web/tools/register-box.js`** (new) — a CLI twin of `POST /api/admin/boxes`, because that route needs an admin session. It backs the database up first, refuses to re-create an existing box, and writes the secret only to a 0600 file, never to stdout. It now lives at `/root/enw-host.env`, 0600 root:root, loaded by systemd as root before the unit drops to `User=waw`, so it is on no command line.

Units, all enabled for reboot: `enw-xvfb`, `enw-x11vnc`, `enw-novnc`, `enw-steam`, **`enw-host-agent`**. `infra/vps/06-host-agent.sh` installs them; `vps.md` §16 has the three that are not obvious (the env file, the `ExecStartPre` rig wait, and why `enw-steam` cannot be `Type=simple`).

**A signed replay from a real game on the box**, `tools/verify.js`:

```
match       m_e455d4ba  Nacht der Untoten  (custom)
exe sha256  732900d158982c33e3121f0b86d22230be79839bbcbfe3bdfc1238f408a7d64d
content     2 chunks, 20 events, 1m45s of game time
signed by   94a38260ca0835fa
VALID — every chunk hashes to its index entry, the chain is intact, and the footer
        signature checks out.
```

The site half — lease → result — was **not** driven from here: a lease needs `POST /api/admin/lease` or a party, both of which need a logged-in session, and pushing a synthetic game into the live boards is real XP and real records. B leases one and the box takes it; nothing further needs installing.

### 11.6 Two fixes this shook out of `instances.js`

1. **`this.wine = wine` was missing from `InstanceManager`'s constructor body.** The parameter was in the signature and the config was right the whole way in, so the manager silently had `undefined` and the first run went down the `launch.ps1` path and failed with `launch script not found`. The failure named the wrong thing, as they do.
2. **The Wine path now clears `__CoDWaW` before every launch.** `kill -9` on a game leaves that 4-byte marker behind, and the *next* launch puts up "Run In Safe Mode?" **before the engine opens `console.log`** — so the symptom is a process at ~50 MB, no console.log at all, and the DLL reporting `engine never came up within 120000 ms`. It cost a run. **The deletion is unconditional and that is correct only here**: on Windows the marker is a real single-instance interlock and `launch.ps1` rightly refuses when its PID is live; on the box the interlock is the 3074/3075 pair, every instance has its own copy and homepath, and the marker is one shared file in one Wine prefix that instance two would always find live. The comment at the deletion says so, and the Windows path is untouched.

`node test/run-all.js`: **41 passed, 0 failed** throughout.

### 11.7 One thing for this lane to settle

`tools/verify.js` prints `file undefined`, `size NaN GiB` and `content undefined chunks` on the **INVALID** path — the header is rendered before the fields it needs exist. The verdict line is right and the exit code is right; only the summary above it is nonsense. Cosmetic, but it is the tool somebody reaches for when a replay is already suspect.

---

## 12. Session 2026-09-22 — `host`: game over, end to end, with nobody watching

The referee lane shipped the other half of game over tonight (`referee.md` §10.2/§10.3): an
enriched `game_over` that carries the whole result, a replay sampler that stops, and a new
**`match_end`** that says *this process is idle and the instance can be reclaimed*. The contract it
wrote is explicit that the host must do four things and must not leave the fourth undone. This
section is this lane's side of it, and it is proven against the simulator and a fresh site rather
than reasoned about.

### 12.1 What happens now, in order, and why the order is the whole thing

```
game_over   ─▶ referee folds it, keeps it VERBATIM as summary.reported
            ─▶ finish(): wait ≤500 ms for match_end
                         close and SIGN the replay (footer carries the summary)
                         POST /api/gs/result   (spooled to disk if the site is down)
match_end   ─▶ dispose(): pick ONE of two, never neither
                 REUSE     → {"t":"end"} → reply ok → map_restart → map_loaded
                             → the instance is WARM and the box reports idle
                 TERMINATE → stop by PID, free the port and the slot, box reports idle
```

**Nothing touches the instance until the replay is signed and the result is posted.** That is not
tidiness: an `end` that lands first issues a `map_restart` and destroys the evidence of a game the
host had not finished writing down. `finish()` returns a promise, `onMatchEnd` waits on it, and
`test/integration-site.js` asserts the ordering off the log rather than trusting it
(`the replay was closed and signed BEFORE the instance was disposed of`).

**`finish()` waits up to 500 ms for `match_end` before it writes anything.** The two messages
arrive back to back, and a result that carries `match_end` is a result that says whether the
instance was left free — which is a fact an operator reading a finished game wants and can get from
nowhere else. A game that never sends one pays 500 ms and no more.

### 12.2 The disposition table, and what makes it `terminate`

`--after-game end|terminate` (default **`end`**), `--games-per-instance N` (default **5**),
`--end-reply-ms` (10 s), `--map-reload-ms` (60 s), `--warm-idle-ms` (10 min).

| condition | disposition |
|---|---|
| `foreign` instance (Play Local — the launcher owns the process) | **leave it alone** (`dev-box.md` rule 4) |
| no `match_end` at all | **terminate** — the game never said it was idle, so it cannot be assumed to be |
| `match_end` with `server_alive:false` | **terminate** |
| `server_crash` / `instance_failed` / `link_closed` / `host_shutdown` | **terminate** |
| the link is gone | **terminate** |
| `--after-game terminate` | **terminate** |
| this is the Nth game on the instance | **terminate** |
| otherwise | **reuse** |

and three ways a chosen **reuse** becomes a terminate anyway, all of them the contract's own words:

* `reply.ok:false` — "the command buffer was unavailable and the instance **must not** be reused";
* no reply within `--end-reply-ms`;
* an accepted `end` whose map never comes back within `--map-reload-ms`.

A **warm** instance that nobody leases is retired after `--warm-idle-ms`. It is not free: it holds
a UDP port, a map's worth of RSS and (on Windows) the game lock.

### 12.3 Reuse: the successor game takes the socket, not the finished one

`end` does not restart the *process*, so **the DLL never says `hello` a second time** — the link
stays up straight through the `map_restart`. Three consequences, and the first two were bugs
waiting to happen:

1. **The successor `Game` is created and takes the connection BEFORE `end` is sent.** The reply and
   the new `map_loaded` can arrive in the same TCP read, and a finished referee must not be the
   thing that sees them. `Game.detach()` exists for exactly this and removes the old game's
   listeners by reference — an anonymous arrow cannot be removed, which is why `attach()` now keeps
   them.
2. **`exe_sha256` and `dll_build` are inherited.** They arrive only in `hello`, they are what the
   run fingerprint is computed over, and they are the whole basis on which the site calls a replay
   record-grade. Without carrying them across, the second game on a warm instance would write a
   replay header with two nulls in it. The successor's replay records an `instance_reused`
   host-event saying they were inherited rather than heard.
3. **A warm instance does not open a replay at `map_loaded`.** §10.3's rule — `map_loaded` is the
   signal to open a replay — assumes the match is known, and a warm instance's next match may not
   have been leased yet. It defers to the first `player_connect`/`round`; `record()` already
   buffered everything, so the buffered `map_loaded` goes into the file it opens and nothing is
   lost. Without this the first integration run left an **unsigned 0-round stub** on disk, which
   `tools/verify.js` correctly called `truncated or unsigned replay (no footer magic)`.

### 12.4 The box goes idle again — and had never done so

`boxes.list().last_state` comes from the status heartbeat, and the heartbeat said
`this.byInstance.size ? 'live' : 'idle'`. **`byInstance` was never cleaned up**, so a box went
`live` at its first lease and reported `live` for ever afterwards — online, still leasable by
`pickFree` (which counts assignments, not the box's own state), and showing an operator a game that
had ended hours ago. It now counts **live games** — not finished ones, not warm instances — and
`retire()` removes the game as well as the instance and reports immediately.

The lease itself was already closed correctly by the site: `results.js :: closeAssignment` sets the
assignment `done` and the party back to `forming` when the result lands. So "release the lease" is
one POST the box was already making; what was missing was the box's own state.

### 12.5 The result is the GAME's, reconciled rather than overwritten

The contract says post the result **from the `game_over` message, not from a re-fold of the
stream**. It is kept verbatim as `summary.reported` (and `summary.match_end`), and each player row
now carries `reported` and `folded` side by side. The site reads the reconciled top-level fields,
so nothing there had to change.

**The reconciliation rule, and the asymmetry is the point.** For a monotonic counter both numbers
are *lower bounds*, so the larger is the better estimate and neither is a lie:

* `game < ours` is **expected and honest**. The game's figures are polls of script variables that
  read 0 when the variables are unbound — `referee.md` §10.2 is explicit that `0 point(s)` in a real
  result is honest, not a bug — and its `score` is the wallet **at game over** where ours is the
  highest wallet ever held. A player who bought a door ends below their peak, every time.
* `game > ours` means the game counted something that never reached us. **That** is flagged
  (`result_mismatch`, with the fields named in `summary.result_mismatches`), because it is the one
  direction that says evidence went missing.

Getting this wrong is cheap and silent, and the first version of it did: it compared the game's
cumulative `score_total` against our wallet peak and flagged **every** game that ever killed a
zombie. Three different quantities — wallet at end, wallet peak, cumulative earned — and they are
now three fields (`score`, `score_total`, and the untouched `stats.points_earned`).

A player the game reports and we never saw on the link is carried through, flagged, and given no
SteamID it did not arrive with.

### 12.6 The simulator survives its own game over, because the real server does

`sim/` stopped stepping at `game_over` — which is precisely the behaviour `no_save_reload.cpp`
removed from the real server (`dedi.md` §12.3). **So the host agent's game-over path had never been
exercised against a server that outlives its own game.** The sim now:

* sends the enriched `game_over` (per-player `score`, `score_total`, `downs`, `revives`, `alive`,
  `connected`, plus totals — and a row for anyone who left mid-match), then `match_end`, then goes
  **idle**, emitting a `perf` line every 10 s and nothing else, for ever;
* on `end`: reports the result first if the match had not ended, replies, then `map_restart`s,
  resets and re-announces `map_loaded` — and the roster comes back with it, because clients stay
  connected through a `map_restart`;
* counts `revives` against the **reviver**, matching `referee.js :: ev_revive`. Crediting the
  revived player is the easy mistake;
* only starts round 1 when somebody is actually in the server. It used to start 2 s after any map
  load, which produced a `round` event on an empty warm instance.

New flags, all of them there to make a failure reproducible rather than argued about:
`--games N` (matches before the process goes quiet for good), `--end-fails` (answer `end` with
`reply.ok:false`), `--no-match-end` (report the result and then say nothing — every server before
tonight). Host-side: `--sim-games`, `--sim-end-fails`, `--sim-no-match-end`.

### 12.7 The proof

**Four dispositions, each driven to the end**, `--sim-timescale 30`, two players, three rounds:

```
REUSE then TERMINATE   --sim-games 2 --games-per-instance 2
  SUMMARY round 3 ... replay closed: 88.8 KiB / 3720 events
  match_end: the game process says it is idle (server_alive=true) at round 3
  disposition: REUSE — game 1 of 2 on this instance
  instance inst-01 is WARM: nazi_zombie_asylum loaded, no match, 1 game(s) played
  [second game plays on the SAME process, second signed replay, second result]
  disposition: TERMINATE — 2 game(s) on this instance, the limit is 2

`end` REFUSED           --sim-end-fails
  disposition: REUSE — game 1 of 5 on this instance
  reuse refused (the game refused `end`: command buffer unavailable) — tearing the
  instance down instead, which is the other half of the contract

NO match_end            --sim-no-match-end
  no match_end after game over — the game may or may not still be alive, so the
  instance is torn down rather than assumed idle
  disposition: TERMINATE — no match_end — the game never said it was idle
```

**`test/integration-site.js`, against a FRESH database** (`ZM_DATA_DIR` to a new dir, `seed.js`,
`ZM_PORT=3403`; nothing near :3200 or the tunnel): **26 checks, 0 failures**, twice — once on
`box-a` and once on `box-b`. The six new ones are step 5b:

```
ok   the box saw `match_end` and knows the game process is still alive and idle
ok   disposition: REUSE (game 1 of 5 on this instance)
ok   `end` was accepted, the map came back, and the instance is WARM for the next lease
ok   the replay was closed and signed BEFORE the instance was disposed of
ok   the site's assignment for this box is now "idle" — the result closed the lease
ok   boxes.list() shows box-a online=true last_state=idle — free for the next lease
```

and out of the site's own database afterwards, which is the version that matters:

```json
"match_end": {"round":12,"reason":"round_target","duration_ms":715700,
              "replay_closed":true,"server_alive":true,"awaiting":"end_or_terminate"}
"reported":  {"round":12,"points_total":29720,"downs_total":0,"players_alive":2,
              "players":[{"slot":0,"name":"Leader","score":970,"score_total":14620,…}]}
boxes        box-a last_state=idle      assignments  m_a14a20c9 state=done
```

Every other suite is unchanged and green: `test/run-all.js` **41 passed, 0 failed**,
`test/demo-local.js` **0 failures**, `test/demo-network.js` **0 failures**.

### 12.8 Two bugs this shook out, neither of them about game over

1. **The spool was never wired up.** `SiteClient` reads `cfg.spoolDir` and **nothing ever set it**,
   so `--spool-dir` — which `test/integration-site.js` has passed all along — did nothing and
   `spool()` returned `false` on its first line. A result the site could not take was logged and
   **dropped**. Every "results are spooled, not lost" claim in this file before tonight was about
   the SiteClient's own unit behaviour, not about a running box. It defaults to
   `ZombiesDev\spool` now.
2. **`stop()` shelled out to `taskkill.exe` unconditionally** for an adopted game PID. On the Linux
   box that file does not exist, so the spawn fails and the instance believes it killed a process
   that is still running. In `--wine` mode the game is normally our own child and this branch does
   not run — but the engine prints its own `PID <n>` line on some boots, which adopts a `gamePid`
   and lands there. It is `process.kill(pid, 'SIGKILL')` off Windows now. Still by PID, still ours.

### 12.9 What is NOT proven, and must not be claimed

* **No real game has been through this.** `game.lock` was held by the dedi lane all night, so every
  line above is the simulator plus a real site. The referee's own `join73` proves the *game* side —
  `game_over`, the sampler stopping, `match_end` sent, the server still alive three minutes later —
  and this proves the *host* side, but the two halves have not yet been run against each other.
  **That is the next thing to do and it needs nothing new**: `node host.js --boot 1 --game --map
  nazi_zombie_prototype` with a client, and read the disposition line.
* **`--wine` is untested for this path.** The disposition logic sits entirely above
  `instances.js` and is launch-mode agnostic by construction; the only mode-specific code touched
  is the kill in 12.8, which is unexercised on the box. The vps lane has the box.
* ~~**A warm instance has never been handed a DIFFERENT party's lease.**~~ **Half of this is now
  proven — see §12.10.** A warm instance takes a genuinely new lease, is told its match id in a
  second `end`, and writes a second signed replay naming it, on the same process. What is still
  unproven is a different *party*, for the reason the original note gives:
  `onAssignment` will do it
  (same map only — `end` is a `map_restart`, not a map change; warm instances on other maps are
  retired), and `rebind()` gives the game its real match identity before the replay opens. But the
  simulator receives its roster in its environment **at spawn**, so a warm sim instance cannot be
  handed a new one, and nothing has proven the path. What *is* proven is a second match on the same
  process with the same roster, which is what a `map_restart` actually does to real clients.
* **`--games-per-instance 5` is a guess.** Nothing has measured what a game process costs after its
  tenth map_restart. The 20-hour soak (§3h) is still owed and is now the thing that would settle it.

### 12.10 Identity, and the second lease — the referee's two new rows (added later, same day)

`bd3bd59` gave the protocol two rows that land on this lane, and §12 predates both.

**1. `identity` travels; `steamid` does not, unless somebody checked it.** `player_connect` and
`game_over` now carry `identity` — `none` / `claimed` / `verified` / `refused` — and a `steamid`
appears on a `game_over` row **only when `identity` is `verified`** (`referee.md` §13.2). The host
folds it, TokenGuard's answer sets it, and `summary()` is the only place the gate is enforced on the
way out:

| what TokenGuard answered | identity | posted `steamid` |
|---|---|---|
| `allow:true`, a real check | `verified` | **yes** |
| `allow:true`, `token_check_disabled` | unchanged (`claimed`/`none`) | no |
| `allow:false` | `refused` (+`identity_reason`) | no |

`token_check_disabled` — what TokenGuard says when it holds no site key or is not enforcing — is an
**admission, not a check**, and deliberately promotes nothing. The game's own row wins over ours
where it sent one, because the game is what decided whether the token survived the checks only it
can make (single use, bound to the lease, one account one slot — §13.4).

A row short of `verified` still posts: the name, the score, `identity`, `identity_reason`, and
`claimed_steamid` where there was one. The site then writes it into `summary_json` and creates **no
`game_players` row**, so nothing is credited to an account nobody checked. That is the whole
mechanism, and it needed no change on the site at all.

**2. `end` carries the next match id.** The game reads its lease from `ENW_MATCH` **once, at process
start**, and clears it on every reset — so a warm instance is serving a match its process has never
heard of, and every invite token the site just minted would be `wrong_match`. So:

* the reuse that *follows a game* sends `end` with **no** `match`. There is no next lease yet, and
  the referee's own rule is that a stale id is worse than none — it refuses everybody.
* `rebind()` sends a **second `end`**, carrying `match`, when a lease actually arrives. That costs
  one more `map_restart` (no process start, no map load) and is what makes a warm instance usable.
* a warm instance that will not take its new match id is torn down and a fresh one booted. A lease
  served by a process that will refuse every token is worse than a cold start.

`onAssignment`'s warm branch is therefore asynchronous now; it returns the game immediately and
reports `ready` only once the game has acknowledged.

**The simulator matches, with one honest fudge.** It emits `identity` on `player_connect` and
`game_over`, updates it off `auth`, keeps a row for a refused player (with no account on it), takes
its lease id from `ENW_MATCH`, clears it on reset, and **admits nobody while it has none** — which
is what keeps a reused instance genuinely idle between leases instead of replaying the same party
under a match id the site never issued. The fudge: `end` also carries **`sim_roster`**, the next
party and their tokens. A real DLL ignores it (the protocol's "unknown fields are ignored by both
sides" rule guarantees that) and needs nothing but `match`, because a real client brings its own
token in its userinfo when it connects. The simulator *invents* its players, so it has to be handed
them. It is marked as simulator-only at both ends.

New sim flag `--gatecrash` seats one extra client at the start with a token that is not a token, so
a box that is enforcing has something to refuse. It joins with the lobby, not late, because a late
join flags the whole game no-records and this is a test of identity, not of the late-join rule.

**Proof.** `test/run-all.js` is **46 passed, 0 failed** — five new checks covering a verified row
carrying its steamid, a **claimed** row posting through with none, a refused row the same with its
reason, `token_check_disabled` promoting nothing, and a player the game reports that we never saw
being carried through flagged and account-less.

`test/integration-site.js` against a fresh database is **36 checks, 0 failures**, and the two new
steps are the interesting ones:

```
5a  the gatecrasher was refused (bad_signature_length) and its identity is "refused"
    both invited players came through as identity=verified (2)
5c  Start pressed again -> the site leased m_23aee3d1
    inst-01 took it WARM — no process start, no map load
    the box told the game its new match id in a second `end` before the map_restart
    the second game played out on the same process and was refereed to the end
    still 1 process start(s) for two games — the instance really was reused
7   two signed replays from one process: m_57ba6583 and m_23aee3d1, each naming its own lease
    every VERIFIED row carries its steamid into the signed, posted result
    and the 1 unverified row(s) carry NO steamid — attendance, not an account
    the site seated exactly the 2 verified players — the refused row earned nothing
```

read out of the **signed footer**, which is stronger than the API and is where it belongs:

```json
[{"n":"Leader","id":"verified","s":"76561190000000001"},
 {"n":"Mate","id":"verified","s":"76561190000000002"},
 {"n":"Gatecrasher","id":"refused","s":null}]
```

**§12.9's third bullet is retracted.** "A warm instance has never been handed a DIFFERENT party's
lease" — it has now been handed a *different lease*, with its own match id, its own tokens and its
own signed replay, on the same process, with no second boot. What is still unproven is a different
**party** on a warm instance, which needs real clients connecting rather than a simulator that
invents them; and `claimed` end to end, which a real box cannot produce because a real box always
checks — it is covered as a unit in `run-all.js` and that is the honest place for it.

## 13. Session 2026-09-23 — several leases per box, and the host is told all of them

**The bug.** B asked for "multiple in reserve so while you're testing I can also play". The box has
had three instance slots since dedi.md §19. It still ran one game at a time, because both ends
assumed one lease per box. `assignments.lease()` superseded every live lease on the box, and
`onAssignment` retired every game whose match id differed from the newest lease's. Any second
Play kicked the first, whoever pressed it. It kicked B at 19:21 and several times after.

### 13.1 The protocol: `GET /api/gs/assignment?v=2`

```
{ v: 2, status: 'leased'|'idle', nonce: <hash of the leases' nonces>, assignments: [ <old one-lease shape>, ... ] }
```

The agent polls with `?v=2`. An old site ignores the query and answers the old shape.
`lib/leases.js leaseList()` reads that shape as a list of one lease, or none. An old agent does
not send `v`. The site then gives it the newest lease alone, and holds that box to **one** live
lease (`capacity()`), so the old agent never has a lease it cannot see. Every status post now
carries `protocol: 2`, `max_instances` (after `checkSlotCopies`), and per-instance `phase`, `map`,
`map_loaded`, `warm` and `leased` (`siteclient.statusExtra`, `reportStatus`).

### 13.2 `onAssignment` → `applyLeases` (`lib/leases.js planLeases`)

* A leased game whose match id is **not in the list** is retired, as before: awaited, then 2 s for
  Wine to release the UDP ports. Warm instances and `--boot` sims are never retired this way.
* A lease in the list with no game is started (`startLease`, which is the old body: warm handoff or
  `boot()`). Each match starts **once per agent lifetime** (`startedMatches`), so a game that has
  finished is not booted again while the site is still waiting for its result.
* Games still boot one at a time behind the 90 s `map_loaded` gate in `boot()` (dedi §19). Each
  instance gets the lowest free slot, which gives it its own game copy, homepath and lobby port.
* If a lease arrives with every slot in use, the agent retires a warm instance to free one. If
  there is no warm instance, it looks again every 5 s. The site should never lease past the
  `max_instances` the box reports.
* **New on idle:** a cancelled lease now retires its game. Before, idle was ignored and the game
  ran on until the next lease superseded it. This is why the site's launcher-cancel guard
  (web.md) has to be deployed **before** or **with** this agent. Without it, a launcher's failed
  rejoin would end the player's live game at once.

### 13.3 Referee: a crash is resumable for ten minutes

`crashGraceMs` is 10 min (it was 7), which matches the site's resume window (`web/server/lib/seats.js`).
The two-minute empty close no longer fires while a crash hold is open. Before, a solo crash was
closed as `empty` at 2 min, so the 7-minute grace never applied.

### 13.4 Tests

* `test/run-all.js` "several leases per box": six planner cases, plus the crash-hold case. 68/68.
* `test/multi-lease.js`: a real agent with sims against a v2 stand-in site. Two leases give two
  instances on two ports. Cancelling one leaves the other on the same pid. A third boots beside it.
  Idle retires everything. PASS.

### 13.5 Proof on the box

See dedi.md §19.6.

## 14. Session 2026-09-23 (~04:00–05:00 UK) — bug 7: the counters, and the `game_over` no replay had

The root cause is in the DLL (referee.md §16): it never read score, kills, downs or revives. Two
host-side breaks sat downstream of it, and both are fixed here (commit `e9721bd`).

### 14.1 Measured on the box

- The `journalctl -u enw-host-agent` lines for B's real games (`m_8a0a8e75`, `m_ba9c2775.r2`,
  both `end_game notify`) say `game over: end_game notify`. So the host DID receive the game's
  `game_over`, and its summary's `reported` block holds the row (all zeros, referee.md §16.1).
- **But not one of the 52 signed replays in `/home/waw/zdev-host/replays` contains a `game_over`
  event.** The cause is the order in `host.js onGameMessage`:
  1. `referee.onEvent(m)` runs first;
  2. `ev_game_over` calls `finishGame`, which emits `'over'`, which runs `finish()`;
  3. `finish()` sets `this.finished = true` *before its first await*;
  4. only then does `this.record(m)` run, and it drops the event as a late one.

  The contract ("`game_over` is the last event of the match") was broken on every game the game
  itself ended.
- Most real games did not end through the game at all. The site ended them: `lease … is no
  longer live at the site`, or `supersedes`. `finishGame` runs host-side with no `reported`, so
  **the fold is the result for most real games.** That is why the fix had to put the counters on
  the live stream (`points` / `down` / `revive` / `stats`), not only on `game_over`.

### 14.2 Changes

- `host.js onGameMessage`: a `game_over` is **recorded before** the referee sees it. Every other
  event keeps the old order.
- `lib/referee.js`:
  - **`ev_stats`** folds `kills`, `headshots`, `downs`, `revives` and `assists` as high-water
    marks, so a `down`/`revive` edge and the absolute value that follows it count once.
  - `summary()` computes ONE reconciled value per counter (kills, headshots, downs, revives: the
    max of the fold and the game's row; `game > ours` is still flagged). It uses that value in
    **both** the row and its `stats` block. The site reads `stats` first, and `stats` used to
    carry the raw fold.
  - `folded` now includes kills and headshots, and `reported.kills_total` is carried (null, not
    0, from a DLL without the native fields).
- `test/run-all.js`: 3 new tests (the §16 DLL's exact event sequence; the reconciled counters in
  the row and in `stats`; `kills_total` null from an old DLL). **71 passed, 0 failed.**
- `test/demo-network.js`: a replay whose footer summary has `reported` must contain `game_over`.
  **0 failures**; all 3 replays carry it. `restart.js` 12/0, `multi-lease.js` PASS.

### 14.3 Deploy note for the coordinator

This is host code, so the box agent needs a restart to pick it up, on your word and under rule
13. It works with the current box DLL: the old DLL sends no `stats`, so nothing changes except
that `game_over` now reaches the replay. The counters only appear once the §16 box DLL is
deployed (referee.md §16, dedi.md).
## 14. Session 2026-09-23 — map cache: the box pulls a leased map from the bucket

B's decision, relayed by the coordinator: the bucket is the source of truth for map files. The box
downloads maps when it needs them, automatically, with nothing done by hand. The code is
`lib/mapcache.js` and `host.js prepareLease()`. The site half is two `/api/gs` routes plus the
`preparing` plumbing.

### 14.1 What it does

* **Before boot.** When a lease arrives, the agent looks up the mod dir for the lease
  (`fs_game mods/<x>`, falling back to the bsp). It asks the site for the map's file list
  (`GET /api/gs/map-files/<bsp>`: path, size, sha256) and compares the list with
  `/home/waw/waw-en/mods/<x>/`.
  * If the dir is missing, the whole map is pulled.
  * If a file is missing or has the wrong size or sha, only the bad files are re-pulled. The good
    files are hardlinked into the new copy, so they are not downloaded again.
  * If the copy is good, the game boots straight away.
  * Stock maps are skipped: no request is made and nothing is pulled.
* **Downloads.** Files come from `<ENW_MAP_BUCKET_URL>/mods/<bsp>/<path>` with an anonymous GET.
  Each file goes into `/home/waw/waw-en/.enw-mapcache/staging/`, which is on the same filesystem
  as mods/. Size and sha256 are checked as the bytes arrive, and each file is fsynced.
* **Nothing half-pulled is ever visible.** A verified directory goes into mods/ with a single
  rename. A repair is swapped in with two renames under a journal
  (`staging/<x>.swap.json`). On start, `recover()` finishes an interrupted swap and deletes
  everything else in staging. There is no partial resume: a pull that crashed starts again from
  zero on the next lease.
* **Pulls are never retried.** Each file is fetched once per pull. If a pull fails, the lease
  fails: the box posts `state: failed` and the site cancels a lease that is still `leased`. A
  stalled download is aborted after 30 s with no bytes (`ENW_MAP_STALL_S`). Two leases for the same
  map share one pull.
* **`preparing`.** While a map is checked or pulled, the lease holds an instance slot. The agent
  posts `{ state: 'preparing', match_id, preparing: { phase, bytes_done, bytes_total, percent,
  files_done, files_total } }` at most every 2 s. `phase` is one of
  listing, verifying, downloading or installing. Every heartbeat lists the lease in `instances[]`
  as `{ id: null, match_id, state: 'preparing', port: null, preparing }`. `ready` is still sent
  only at `map_loaded`.
* **Budget and eviction.** Usage is the sum of every map dir in mods/ plus the bytes that pulls in
  flight will add. A lease's pull evicts least-recently-used maps first, until both of these hold
  after the pull:
  * `usage + need <= max(budget, usage)`
  * `free - need >= ENW_MODS_MIN_FREE_GB`

  A pull therefore never grows a library that is already over budget. It evicts roughly its own
  size and nothing more. The first pull on today's 20 GB library costs one or two old maps, not
  the 5 GB above budget.
  * If only the budget half cannot be met, the pull goes ahead over budget with a warning.
  * If the disk half cannot be met, the lease fails.
* **What is never evicted:**
  * the stock four (evict() also refuses them by name);
  * any map a live, warm, booting or preparing game is on;
  * any map a live lease names;
  * a map that is being pulled.

  A stale install under a live game is booted as it is and not replaced. The next lease repairs it.
* **Trim.** One maintenance tick runs every 60 s. The first tick is 60 s after start, by which
  point the lease poll has answered. If mods/ is over budget and nothing is booting or pulling,
  the tick evicts **one** dir and logs `evicted <x> (size, last used): trim ...`.
  * Order: unpopular maps first, oldest last-use first. Popular maps come after every unpopular one,
    least popular first.
  * A map dir the cache has no record of takes its dir mtime as its last use.
  * **Trim waits until the site has answered `GET /api/gs/popular-maps` at least once.** Without
    that answer, trim would be an LRU of rsync mtimes and could remove the maps people play.
  * Expect about 5 GB to go over the first 10-20 minutes after deploy.
* **Prefetch.** When no trim was needed, the tick fetches the site's top maps. These are real leases
  over the last 30 days, not agent leases, and not stock maps. The tick takes up to
  `ENW_MAP_PREFETCH_TOP` of them that fit in 67 % of the budget, and pulls **one** missing map
  throttled to `ENW_MAP_PREFETCH_MBPS`.
  * A prefetch runs only if the map fits inside the budget and the disk reserve **without evicting
    anything**, so prefetch and trim cannot undo each other.
  * A prefetch that failed is not tried again for 6 h.
  * If a lease arrives for a map that is being prefetched, the lease joins that pull and lifts the
    throttle.
* **State.** Stored in `/home/waw/waw-en/.enw-mapcache/state.json`: last use per map, a verified
  manifest (size, mtime and sha per file, so the next lease does not hash again), and recent
  failures. The first lease for each map that was already on the box hashes its files once.
* **Stats.** Every heartbeat carries
  `map_cache: { maps, used_bytes, free_bytes, budget_bytes, pulling }`, refreshed once a minute.

### 14.2 Config (`/root/enw-host.env`; every key optional)

| key | default | meaning |
|---|---|---|
| `ENW_MAP_CACHE` | on with `--wine` and a site, off otherwise | `off` disables all of it; leases then boot whatever is on disk, as before |
| `ENW_MODS_DIR` | realpath of `<wine-game-dir inst-01>/mods` = `/home/waw/waw-en/mods` | the one shared mods dir |
| `ENW_MAP_BUCKET_URL` | `https://enw-zombies.nbg1.your-objectstorage.com` | public bucket; no keys on the box |
| `ENW_MODS_BUDGET_GB` | 15 | mods/ size target |
| `ENW_MODS_MIN_FREE_GB` | 1 | disk that must stay free after any pull |
| `ENW_MAP_PREFETCH_TOP` | 20 | 0 turns prefetch off |
| `ENW_MAP_PREFETCH_SHARE` | 0.67 | share of the budget that popular maps may hold |
| `ENW_MAP_PREFETCH_MBPS` | 10 | prefetch throttle in MB/s (lease pulls are never throttled) |
| `ENW_MAP_TRIM` | on | `off` means there is no trim; pull-time eviction still happens |
| `ENW_MAP_STALL_S` | 30 | abort a download after this long with no bytes |

### 14.3 Timing and the ready gates

These figures assume the ~47 MB/s the box gets from nbg1. That rate is the coordinator's figure;
it was not measured here.

| Map | Pull time |
|---|---|
| a typical 600 MB map | ~13 s |
| `nazi_zombie_fear_mc_2` (4.2 GB, the largest on the box) | ~90 s |

Each first lease also hashes the maps that were already on the box, once, at disk speed.

The gates a lease has to get through, in order:

1. **The site's ghost reaper** (`web/server/lib/boxes.js`, 90 s) ends a lease that the box does not
   list. The `preparing` entry in `instances[]` keeps a downloading lease alive for as long as the
   pull takes. This is the host-side extension of the ready gate. `web/test/box-maps.js` proves it.
2. **The launcher's `serverTimeoutMs`** (`launcher/src/main/bootflow.js`, 120 s from Play until
   the site says ready) is client code and was **not** changed. At 47 MB/s any map up to ~4 GB
   (pull, then boot at about 10 s) fits inside it. A slower bucket, or the largest maps, can
   outlast it. When that happens the launcher shows "did not become ready in time", but the lease
   and the pull carry on. Pressing Play again supersedes the player's own lease, and the new lease
   joins the pull already running, so the second attempt finds the map ready or nearly ready. A
   launcher release that reads `match.preparing` would fix this properly.
3. **Invite tokens** live 5 minutes from the lease. A pull plus boot longer than that would have its
   joins refused. With the numbers above this cannot happen.
4. **The client's 60 s `join_retry`** starts after `ready`, and `ready` is sent at `map_loaded`,
   so the pull time never counts against it.

### 14.4 Site side (deploy **before or with** the agent)

The site half is additive, and it is tested in `web/test/box-maps.js` (8/8):

* `GET /api/gs/map-files/:bsp`: returns `mapfiles.forMap()`. It has to live under `/api/gs`
  because the closed-beta gate answers a box on `/api/maps/<bsp>/files` with the password page.
  I checked this against zombies.enw.gg.
* `GET /api/gs/popular-maps`: `assignments.popular()`, read-only.
* `assignments.ack(box, 'failed', id, error)` cancels a lease only while it is still `leased`.
  It cannot end a ready or live game. It frees the party and logs `assignment.box_failed`.
* `parties.launchInfo().preparing` and `GET /api/launcher/play` → `match.preparing` carry
  `{ phase, bytes_done, bytes_total, percent }` for "Preparing map...". The phase the launcher
  follows is unchanged (still `reserving`), so today's launcher is not affected.

**Without the site half, the agent is safe:**

* a map already on disk boots unverified (logged);
* a map that is not on disk fails its lease, as it would have at boot anyway;
* there is no trim, because there is no popularity list;
* there is no prefetch.

### 14.5 Deploy (coordinator)

1. **Site:** deploy `web/server/routes/gameserver.js`, `web/server/lib/assignments.js`,
   `web/server/lib/parties.js` and `web/server/routes/launcher.js`. Restart the site only on B's
   word while he is playing (hard rule 15), using the keepalive recipe.
2. **Box files:**
   ```
   scp infra/host-agent/host.js zombies-dev:/home/waw/enw/infra/host-agent/host.js
   scp infra/host-agent/lib/mapcache.js infra/host-agent/lib/siteclient.js zombies-dev:/home/waw/enw/infra/host-agent/lib/
   ssh zombies-dev chown waw:waw /home/waw/enw/infra/host-agent/host.js /home/waw/enw/infra/host-agent/lib/mapcache.js /home/waw/enw/infra/host-agent/lib/siteclient.js
   ```
3. **Env:** append to `/root/enw-host.env` and keep it root 0600. Adding these lines is optional,
   because they are the defaults, but they make the configuration explicit:
   ```
   ENW_MAP_CACHE=on
   ENW_MODS_BUDGET_GB=15
   ENW_MODS_MIN_FREE_GB=1
   ENW_MAP_BUCKET_URL=https://enw-zombies.nbg1.your-objectstorage.com
   ```
4. **Restart:** `systemctl restart enw-host-agent`, and only when no verified player is in a live
   instance (hard rule 13: journal idle is not enough on its own).
5. **Verify:**
   * `journalctl -u enw-host-agent -n 50 | grep 'map cache'` shows `map cache ON: /home/waw/waw-en/mods, 59 map dir(s), ~20 GB used of a 15.0 GB budget, 1.2 GB free ...`.
   * Within about 2 minutes, lines like `evicted <x> ...: trim` appear, one a minute until usage is
     at or under 15 GB. `df -h /` should gain about 5 GB.
   * `cat /home/waw/waw-en/.enw-mapcache/state.json` exists.
   * Once trim has evicted a map that is still on the site's server list, prove a real pull. Take
     an agent lease of it with `web/tools/lease-cli.js` and fake ID `76561198000000001` (hard rule
     14). Expect `pulled <x>: N file(s), M MB in T s` and then `booted`. While it pulls, the site's
     `last_status_json` shows the `preparing` entry.
   * Rollback: set `ENW_MAP_CACHE=off` and restart, or put back the three previous files. A map
     that was evicted comes back on its next lease.

### 14.6 Tests

* `node test/mapcache.js`: 22/22 against a fake bucket on loopback. Covered:
  * pull ok;
  * sha mismatch rejected, with nothing left in mods/ or staging;
  * 404;
  * concurrent leases give one pull;
  * progress reaches 100 %;
  * oldest-first eviction;
  * live and leased maps kept;
  * stock kept;
  * an over-budget library is not halved;
  * disk reserve;
  * stale-file repair, where only the bad files are fetched and the good file keeps its inode;
  * a live map is never repaired mid-game;
  * the site is unreachable;
  * crash recovery;
  * trim order and gating;
  * prefetch never evicts, has a cooldown, and a lease lifts its throttle.
* `node test/mapcache-host.js`: a real agent with sims, a stand-in site and a slow fake bucket.
  The lease is `preparing` and listed in the heartbeat with no port while it downloads. It shows
  progress mid-download, boots only after the install, and a sha-mismatch lease is `failed` and
  never booted. PASS.
* `npm test` (run-all 68/68, plus mapcache), `test/multi-lease.js`, `test/restart.js` and
  `test/demo-network.js` all pass unchanged. `web npm run check` passes all suites, box-maps
  included. `local-run.js` failed once on "THE RESTART ... with its round" and then passed on two
  reruns. Nothing it touches was changed, so it is flaky.

### 14.7 Unproven

* **Not run on the box.** No real pull, and no Wine instance has loaded a map pulled while another
  instance was running.
* The 47 MB/s figure comes from the coordinator. The one-time hash time for the 59 maps already on
  the box was not measured.
* The launcher does not yet show `match.preparing`, and its 120 s timeout is unchanged (§14.3).
* A trim deletes files with `rm` while games run. The files are unrelated to those games, but the
  I/O effect on a live Wine server has not been measured.
* The map list comes from the site's archive report on B's PC. A map whose files the report lacks
  cannot be pulled; its lease fails and says so.

## 15. 2026-09-23 — telemetry: every instance end is a log bundle (lane T1)

The design, the triggers, the outbox, the env keys and the deploy are in
[`telemetry.md`](telemetry.md) §7 and §10; this section is what the agent does that the rest of
this doc should know about.

### 15.1 What changed in the agent

* **`lib/util.js` — the log ring.** Every `makeLog()` line (debug included, whatever the console
  level) is also pushed into a 20,000-entry circular array (`ENW_LOG_RING`). No I/O, no timers.
  `ringLines(filter)` / `ringFormat` read it. It is what lets a bundle carry *this instance's*
  host lines without a per-instance log file.
* **`host.js`.** `startTelemetry()` after `startMapCache()` (only with a site; a failure to start
  leaves the agent running without it). `retire()` calls `telemetryEnd(game)` after the process is
  gone and **before** the slot is reused (the next game truncates `console.log`); `Game.dispose()`
  files reused/warm games. Both prepare-failure paths call `telemetry.pullFailed`. At link time the
  box DLL is hashed (`hashFileCached`, once per file version) so `dll_sha` is what ran, not what is
  on disk at the end (§22.7 of dedi.md: a swapped DLL). `shutdown()` stages every live game's logs
  and flushes for ≤ 5 s; building and sending wait for the next start. `/state` has `telemetry`.
* **`lib/siteclient.js`.** `uploadTelemetry(file, { bundleId, kind, reason, bytesPerSec })`:
  `POST /api/gs/telemetry`, streamed from disk, throttled (8 MB/s default), never throws on an
  HTTP answer.
* **`mock-site/site.js`** answers `/api/gs/telemetry` (200 / duplicate; `--telemetry-status N`
  forces an answer), so a run against the mock never fills its outbox.

### 15.2 Where an instance's logs are (the bundle's sources)

| in the bundle | on the box |
|---|---|
| `instance-stdout.log` | `<logDir>/<id>.log`, the process's stdout/stderr |
| `host-games_mp.log` | `<logDir>/<id>.games_mp.log`, the agent's mirror (`lib/gamelog.js`) |
| `enw-<pid>.log` | beside the DLL in the instance's game copy (`ENW_LOGDIR` is unset under Wine); `<pid>` is the **Windows** pid from `hello`, else the newest `enw-*.log` written since the instance started |
| `engine-console.log`, `engine-games_mp.log` | `<fs_homepath>/<fs_game or main>/`, the mod's folder in the map cache, the game copy's `<fs_game>` — every candidate modified since the start, once each |
| `host-instance.log` | the ring: lines tagged with the instance, or naming the instance / match (`inst-01` never matches `inst-010`) |
| `host-box-context.log` | the ring: every line from a minute before the game (≤ 5,000); context only, no flag reads it |

### 15.3 Tests

`test/telemetry.js`, 81, in `npm test`: the `.cjs` copies; an instance end (box secret, host
private key, invite token gone from every file; the keys dir and `enw-host.env` refused; tails;
the ring lines of that instance only); the upload against a stand-in (headers, byte-for-byte
body, 200 / duplicate / 400 / 413 rebuild / 429 / 500 backoff / unreachable, busy deferral, the
throttle); the journal where there is no `journalctl`; retention; `pull_failed`, `box_warning` and
a crashed instance run through **the site's own flag rules**; a restart between staging and
building; the `host.js` wiring. The site's web test also drives the real `SiteClient.uploadTelemetry`
against the real `/api/gs/telemetry`.

### 15.4 Unproven

Not run on zombies-dev: the Wine log paths, `journalctl`, `nice`, `df`/`ps`, `/proc/meminfo`.
The first deploy should be checked with `/state` → `telemetry` and the site's Issues page.
