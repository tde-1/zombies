# Game link protocol v0 (game process ⇄ host agent)

Draft contract so the DLL (in the game server process) and the host agent (`infra/host-agent`, Node)
can be built in parallel. Change it by editing this file and noting the change on the board.

## Transport
- The game process gets two environment variables at spawn: `ENW_HOST=127.0.0.1:<port>` and
  `ENW_INSTANCE=<id>` (also `ENW_ROLE=server|solo|client`).
- The DLL opens **one TCP connection** to `ENW_HOST` from a background thread (never block the game
  frame; queue and drop oldest on overflow; reconnect with backoff).
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
| `notify` | `ent ("level"/"player:<slot>"/…), name, args?` | allow-listed script notifies (EE flags, buyable ending) |
| `snap` | `players:[{slot,pos:[x,y,z],ang:[pitch,yaw],health,score,weapon,stance,alive}]`, `zombies:[{id,pos,health}]` | players 20 Hz; zombies 10 Hz (either list may be omitted in a given snap) |
| `input` | `slot, buttons, moved:bool, turned:bool` | per client, at most 10 Hz, only on change (AFK scoring) |
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

## Replay log (host side)
The host agent writes every received event into the replay (vault `10` §4b, `99` §5.4): chunked,
compressed, hash-chained and Ed25519-signed. v0 may use NDJSON inside zstd chunks; the columnar CBOR
format comes later. Record actual bytes per game-hour.
