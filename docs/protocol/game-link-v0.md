# Game link protocol v0 (game process ⇄ host agent)

Draft contract so the DLL (in the game server process) and the host agent (`infra/host-agent`, Node)
can be built in parallel. Change it by editing this file and noting the change on the board.

## Transport
- The game process gets two environment variables at spawn: `ENW_HOST=127.0.0.1:<port>` and
  `ENW_INSTANCE=<id>` (also `ENW_ROLE=server|solo|client`).
- The DLL opens **one TCP connection** to `ENW_HOST` from a background thread (never block the game
  frame; reconnect with backoff).
- **Backpressure — which messages may be dropped.** "Queue and drop oldest" was the original rule
  and it is wrong as written. Only **`snap`, `input` and `perf`** may be discarded when the queue
  overflows: they are resampleable, and the next one is along in 50 ms. Every other message is
  EVIDENCE — drop a `round` and the referee awards the wrong badge, silently, with no error
  anywhere. When the queue holds nothing droppable, the sender thread blocks (never the game frame).
  Host→game, the same split: `say` and `tell` are droppable, `auth`/`kick`/`end`/`pause`/`resume`/
  `exec`/`set` are not. *(Found by running the simulator at 300×: the host saw a game stuck at
  round 21 while the game was well past it. At a real 25–40 events/second this never triggers —
  it triggers exactly when something is already going wrong. host, 2026-09-20.)*
- Lines are capped at 1 MiB; a peer that sends a longer one has its connection dropped.
- Framing: **NDJSON**, one UTF-8 JSON object per line. Every message has `t` (type) and `ms`
  (game time in ms, `level.time` when known, else the DLL's monotonic clock) where it makes sense.
- Unknown `t` values are ignored by both sides.

## Game → host
| `t` | Fields | When |
|---|---|---|
| `hello` | `v:0, instance, role, pid, exe_sha256, dll_build` | on connect |
| `map_loaded` | `map, fs_game, mode ("zombies"), sv_maxclients` | map up, scripts running |
| `round` | `n` | `level.round_number` changes (`between_round_over` / `new_zombie_round`) |
| `game_over` | `round, reason` | `end_game` |
| `player_connect` | `slot, name, xuid/steamid if known, token if presented` | a client connects |
| `player_spawn` / `player_disconnect` | `slot` (+`reason`) | |
| `down` / `revive` / `bleedout` | `slot` (+`by`) | |
| `points` | `slot, score` (optionally `delta, why`) | score changes |
| `chat` | `slot, text, team:bool` | a player says something |
| `notify` | `ent ("level"/"player:<slot>"/…), name, args?` | allow-listed script notifies (EE flags, buyable ending). `flag_set(x)` reaches us as `{ent:"level", name:"x"}` — that is what a manifest's `{"flag":"x"}` matches. **A trigger use is `{name:"trigger", args:{targetname, zombie_cost, …}}`**; the manifest's `{"trigger_used":{…}}` matches every named key against `args`, compared as strings |
| `dvar` | `name, value` | a watched dvar changed. Feeds manifest `{"dvar":…}` conditions and the replay's dvar log (vault 10 §4b). *(added 2026-09-20)* |
| `level_var` | `name, value` | a watched `level.<name>` script variable changed. **Not optional**: `nazi_zombie_ali`'s real ending sets `level.tom_victory`, and a plain script variable never notifies, so the DLL polls a short allow-list (the `level_var` names in the map's manifest) at ~1 Hz. *(added 2026-09-20)* |
| `snap` | `players:[{slot,pos:[x,y,z],ang:[pitch,yaw],health,score,weapon,stance,alive}]`, `zombies:[{id,pos,health}]` | players 20 Hz; zombies 10 Hz (either list may be omitted in a given snap) |
| `input` | `slot, buttons, moved:bool, turned:bool` | per client, at most 10 Hz. **"Only on change" means: on a change of the moved/turned/fire state, plus a 1 Hz heartbeat while active.** A continuously-moving player would otherwise emit 10/s forever and AFK scoring does not need it. It is ~9% of replay bytes even so |
| `perf` | `frame_ms_p50, frame_ms_p99, cpu_pct?` | every 10 s |
| `log` | `level, msg` | anything worth surfacing |
| `reply` | `id, ok, error?, value?` | answer to a host command with an `id` |

## Host → game
| `t` | Fields | Effect |
|---|---|---|
| `say` | `text, from?` | show a chat line to every player (Global chat relay, warnings) |
| `tell` | `slot, text` | chat line to one player |
| `exec` | `id, cmd` | run a console command (host-controlled only) |
| `set` | `id, dvar, value` | set a dvar |
| `pause` / `resume` | `id` | engine-level pause (players frozen and invulnerable, zombies frozen) |
| `kick` | `id, slot, reason` | drop a client |
| `auth` | `slot, allow:bool, reason?` | answer to a `player_connect` token check |
| `end` | `id, reason` | end the game cleanly |
| `snapshot_state` | `id` | reply `value` = full restorable state (points, weapons, perks, position per player; round) |

## Who consumes what (host side, built 2026-09-20)
`infra/host-agent` implements this whole table. The referee is driven by `round`, `game_over`,
`player_connect`/`_spawn`/`_disconnect`, `down`/`revive`/`bleedout`, `points`, `chat`, `input`,
`notify`, `dvar`, `level_var`; the live 2D view and the replay tracks come from `snap`; `perf` is
surfaced on the dashboard. `hello.exe_sha256` and `hello.dll_build` go into the signed replay
header and are what the run fingerprint is computed over, so they must be real.

`infra/host-agent/sim/` is a fake game that speaks this protocol at the real rates, so the DLL has
something to be diffed against: point both at the same host and compare the two streams.

## Replay log (host side)
The host agent writes every received event into the replay (vault `10` §4b, `99` §5.4): chunked,
compressed, hash-chained and Ed25519-signed. v0 may use NDJSON inside zstd chunks; the columnar CBOR
format comes later. Record actual bytes per game-hour.

## Optional: the IW4MAdmin `LogPrint` mirror (referee, added 2026-09-20)

NDJSON over TCP above is **the contract**. In addition, the DLL can mirror the *event* subset —
never `snap`, never `input` — as IW4MAdmin's semicolon-delimited `GSE;…` lines in the game log.
Controlled by the dvar **`enw_logprint_events`, default `0`**. Costs nothing when off.

Why it exists: on T4 a log line is the only outbound channel other than our socket (`libcod`, the
usual "GSC talks to MySQL/HTTP" escape hatch, does not support WaW). So this is the degraded mode
when the host agent is down or the game was launched by hand, and it makes an ENW server readable by
IW4MAdmin (MIT, maintained, ships a Plutonium T4 CO-OP/Zombies parser).

Format, read from `RaidMax/IW4M-Admin` branch `feature/zombie-stats`,
`Plugins/ZombieStats/Events/ZombieEventParser.cs` (MIT), cloned to
`C:\Users\b\ZombiesDev\thirdparty\iw4m-admin-zombiestats`:

```
GSE;RC;<round>                              round complete
GSE;ZP;<player block>;<category>;<args>     player-scoped
GSE;ZW;<kind>;<args...>                     world-scoped
     zombies;<round>;<remaining>;<alive>
     power;<state>;<source>;<round>
     easter_egg;step;<key>
     easter_egg;complete;<map>
     buyable_ending;<round>;<map>           << ENW EXTENSION
```

`buyable_ending` is ours: their 34 `EventLogType` values have no slot for one, because Treyarch maps
do not have one — it is a custom-map convention and the middle tier of our badge model. An unknown
`ZW` kind makes their parser log a warning and drop the line, so emitting it is safe against a stock
IW4MAdmin. Fields are sanitised (`;`, CR and LF become `_`, 128 chars max) because a custom map's
flag name is author-supplied and their parser has no unescape step.

Implementation: `server/components/referee/logprint_mirror.{hpp,cpp}`.
