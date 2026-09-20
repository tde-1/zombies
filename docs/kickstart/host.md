# Host agent — design, how to run it, and the measured numbers

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
per-game CPU figure; see §3b.

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
| `test/run-all.js` | 37 in-process checks of the rules and the format |
| `test/demo-network.js` | the two-box end-to-end demo |

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
```

Useful flags: `--game` (boot a real `CoDWaW.exe` through `tools/dev/launch.ps1` instead of the sim —
takes `game.lock`), `--sim-timescale N` (run a game N× faster; the 24 h cap in seconds),
`--cap-ms`, `--afk-warn-ms`, `--afk-kick-ms`, `--require-token false`, `--dash off`, `--game-log off`,
`--zstd-level`, `--chunk-ms`, `--max-instances`, `--debug`.

Defaults: replays in `C:\Users\b\ZombiesDev\replays`, logs in `C:\Users\b\ZombiesDev\logs\host`,
keys in `C:\Users\b\ZombiesDev\keys`. Nothing is written inside the Steam install, ever.

---

## 3. The measured numbers

### 3a. Replay size and cost

One **simulated game-hour**, players sampled at 20 Hz and zombies at 10 Hz, real `.enwr` files
written and verified. `node tools/measure-replay.js --hours 1 --players 1,2,4 --levels 10,19`
(full output in `infra/host-agent/measurement.json`, 2026-09-20).

| Players | Round reached in the hour | Zombies alive (avg / peak) | Raw NDJSON | **Compressed (zstd-10)** | zstd-19 |
|---|---|---|---|---|---|
| 1 | 12 | 5.1 / 14 | 12.4 MiB | **0.30 MB/game-hour** | 0.26 |
| 2 | 20 | 10.9 / 21 | 35.6 MiB | **2.69 MB/game-hour** | 2.31 |
| 4 | 22 | 15.3 / 24 | 70.6 MiB | **5.98 MB/game-hour** | 5.14 |

Compression is **11.8×** at 4 players (69× solo — a solo track is very predictable). 90.9% of the
raw bytes are `snap`, 8.8% are `input`, and everything else together is 0.3%.

**The vault's ~4–5 MB per 4-player game-hour is right.** We measure 5.98 at zstd-10, 5.14 at
zstd-19 — 1.1–1.3× the estimate, same order, no change to any decision. **Solo is much cheaper than
estimated**: 0.30 MB/h against the vault's ~1.5, because a solo game reaches lower rounds and holds
far fewer zombies.

| Tier | 4p MB/game-hour | What it is |
|---|---|---|
| full | 5.98 | every event + player tracks + zombie tracks (90 days; VIP forever) |
| no zombies | 2.89 | B's "reconstruct the zombies" idea |
| events only | 0.06 | the signed event log + summary (**kept forever, everyone**) |

**B's "don't store the zombies" idea saves 3.09 MB/h (52%)** — close to the vault's ~2.7 MB/h
estimate, and the vault's conclusion is confirmed with numbers: at R2's $0.015/GB-month, storing the
real zombies for a thousand 4-player game-hours costs **$0.045 a month**. Zombie behaviour *is* the
evidence. Keep it.

**R2 at $0.015/GB-month**, full tier, 90-day retention, games running flat out 24/7:

| Concurrent games | Stored | Cost |
|---|---|---|
| 25 | 315 GB | **$4.73/month** |
| 100 | 1,261 GB | **$18.92/month** |
| 400 | 5,044 GB | **$75.67/month** |

The keep-forever event log adds **0.06 MB per game-hour** and never expires: at 25 concurrent games
that is ~13 GB a year, about **$0.20/month of growth per year of operation**. A 20-hour VIP game is
120 MB, i.e. **$0.0018/month to keep**. Reading is free on R2 (no egress charge), so watching
replays costs nothing.

**zstd level.** Level 10 is the right default: level 3 is 23% bigger for no real CPU saving, level 19
is 14% smaller but costs 17 s of CPU per game-hour recorded instead of 1.4 s — at 25 games per box
that is 0.12 of a core spent on compression rather than 0.01. If storage ever matters more than CPU,
re-compress cold replays to 19 offline; the container does not change.

### 3b. CPU and RAM per instance

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
| **Invite tokens** | **Works, fails closed.** | §4 of the demo: 2 genuine invites join, a **forged** token is refused `bad_signature`, an **expired** one `expired`. Also refused: wrong match, wrong SteamID, re-used `jti`, edited payload, and garbage. With no token or no site key, a box with checks required refuses everyone rather than becoming an open server. |
| **24 h cap + warnings + clean end** | **Works.** | Demo §6b on an 8-minute clock: warnings at 5/3/1, `end` sent, game saved with `cap_reached`, replay written and verified. Unit-tested on the real 30/10/1 schedule. VIP lobbies are genuinely uncapped. |
| **AFK warn/kick** | **Works.** | Warn at 10 min, kick at 15, active players untouched, coming back clears it, everyone-idle pauses then closes. A simulator bug found this: an "AFK" player who still typed reset their own timer — chat **is** activity, which is correct, and the sim was wrong. |
| **Replays + verification** | **Works, and the cost is trivial.** | 5.98 MB/4-player-game-hour, $4.73/month at 25 concurrent games with 90-day retention. Signed, chained, seekable, tamper demo included. A host killed mid-game leaves an unsigned file; `tools/recover.js` salvages it, clearly marked as lower-grade evidence. |
| **Pull protocol** | **Works.** | Lease → boot → `status=ready` → play → `POST /api/gs/result` with the summary and replay pointer, on two boxes at once, nonce-cached polling, site never connects out. |
| **Live view / spectating** | **Works.** | `http://127.0.0.1:8787` — instances with live CPU/RAM, round, players, a 2D top-down canvas of player and zombie positions at 4 Hz, event log, chat, and playback of a recorded replay chunk-by-chunk. This is the prototype of the web live view in 99 §4.4 and of phase 2 of the replay roadmap. |
| **Instance manager** | **Works, against the real game.** | Start/stop/restart/reap, per-instance logs, one port and id each, `ENW_HOST`/`ENW_INSTANCE`/`ENW_ROLE`, CPU+RAM sampling, PID-scoped kills only. Verified against a real `CoDWaW.exe` at 01:02: the DLL connected and the manager adopted the game's PID. It refuses cleanly when another agent holds `game.lock` (*"game.lock is held by dedi (probe p19-saved-retry) — not launching"*) without touching the lock file. |
| **Referee state machine** | **Works.** | 37 in-process checks, all green, against the referee agent's real manifests. |

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

* **The real game has connected but not been measured.** One launch got as far as `hello`; the
  next session should hold the lock long enough to load a map, get a round or two, and read
  `instances[].usage` for the per-game core and RAM figures. That is still the single most valuable
  next step, and it is now a one-liner.
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
* **No records tier.** Vault 10 phase 4 adds every usercmd (~300 MB for 20 h). The protocol has no
  `usercmd` message yet; add it when the boards need it.
* **The mock site is a mock.** In-memory, no database, one shared secret per box, `/admin/*` routes
  with no auth at all. It exists to prove the shape and must not grow into the real site.
* **Not tested**: more than 2 instances at once, a link peer that lies, a full 24-hour soak at 1×,
  or the crash-recovery *state restore* (the host asks for `snapshot_state` and the sim answers, but
  nothing puts the state back — that needs the DLL).
* **Results are lost if the site is down** when a game ends. The box plays, referees and records
  regardless, but the `POST /api/gs/result` is fire-and-forget. A spool-and-retry queue on disk is
  the obvious fix and is question Q-host-2 in `questions.md` (it means a cloud box must not be
  destroyed until its spool is empty).
* **The `games_mp.log` prefix is not settled.** The referee agent proposes `GSE;` for the DLL side;
  the host writes `ENWZombie;` today. Both are one configurable string (`--game-log-prefix`). One
  of us should win — see the note at the end of `questions.md`.
