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
| `game_over` | `round, reason, duration_ms, points_total, downs_total, players_alive, players:[{slot,name,connected,identity,steamid?,xuid?,party_slot?,identity_reason?,score,score_total,downs,revives,alive}]` | game over — **the final result**, in one message, so a host that loses the link a second later still has the whole answer without re-folding the stream. It is the last event of the match and the replay sampler stops on it. **A `steamid` appears on a player row here only when `identity` is `verified`** — the one message a host may post a result from must not carry an account nobody checked. *(fields added 2026-09-22, referee.md §10.2; identity 2026-09-22, §13)* |
| `match_end` | `round, reason, duration_ms, replay_closed, server_alive, awaiting` | sent immediately **after** `game_over`. Means one thing: **this game process is idle and the instance can be reclaimed.** The server is still alive (`no_save_reload.cpp`) and will sit there for ever unless the host acts. The host must close and sign the replay, post the result, and then either send `end` (reuse: the referee `map_restart`s, resets and re-announces `map_loaded`) or terminate the process. It must do one of the two. *(added 2026-09-22, referee.md §10.3)* |
| `player_connect` | `slot, name, steamid, xuid, identity, party_slot?, identity_reason?, token?` | a client connects. **`steamid` is the steamid64 the SITE put in the invite token** — the engine's userinfo carries no id at all on a real WaW client (`referee.md` §12.3). `xuid` carries the same value, because `lib/referee.js` reads `ev.steamid \|\| ev.xuid`. **`identity` is what that id is worth** and is the field a host must read before awarding anything: `none` (no token — a Local/dev run; the row is attendance, there is no `steamid`), `claimed` (a token was presented and parsed, signature NOT yet checked), `verified` (the host answered `auth allow:true` with a real check), `refused` (the host said no, or the game refused it itself — **no `steamid` is sent**, and `identity_reason` says why). `party_slot` is the seat the site sold, when the token carried one. *(identity fields added 2026-09-22, referee.md §13)* |
| `player_spawn` / `player_disconnect` | `slot` (+`reason`) | |
| `down` / `revive` / `bleedout` | `slot` (+`by`) | |
| `player_down` | `slot, name, round, downs, map?` | **the same edge as `down`, said in full.** Both are emitted; neither replaces the other. `down` is what a host's fold counts and it carries a slot and nothing else, which is everything a ruling needs and nothing a *sentence* needs — by the time a line reaches the site's chat ring, a slot is a number belonging to a game nobody reading it is in. This one carries the name, the round and the map so the site can compose "*&lt;handle&gt; just went down on round 30 on Verrückt*" (`web/server/lib/chatSystem.js`). **It carries no `steamid`**, deliberately: the host already holds the roster and the identity, and §13's rule — an account travels only on a `verified` row — is not relaxed for a chat line. A host with no handler for it must still record it (the referee's `ev_*` table has none, so it changes no ruling and goes into the replay unmodified, which is what "unknown types are ignored" has to mean for an EVIDENCE stream). *(added 2026-09-23, `server/components/referee/referee.cpp`; the host bridges it to the site as an `event`, `host.js` `onGameSystemEvent`)* |
| `points` | `slot, score` (optionally `delta, why`) | score changes |
| `chat` | `slot, text, team:bool` | a player says something |
| `notify` | `ent ("level"/"player:<slot>"/…), name, args?` | allow-listed script notifies (EE flags, buyable ending). `flag_set(x)` reaches us as `{ent:"level", name:"x"}` — that is what a manifest's `{"flag":"x"}` matches. **A trigger use is `{name:"trigger", args:{targetname, zombie_cost, …}}`**; the manifest's `{"trigger_used":{…}}` matches every named key against `args`, compared as strings |
| `dvar` | `name, value` | a watched dvar changed. Feeds manifest `{"dvar":…}` conditions and the replay's dvar log (vault 10 §4b). *(added 2026-09-20)* |
| `level_var` | `name, value` | a watched `level.<name>` script variable changed. **Not optional**: `nazi_zombie_ali`'s real ending sets `level.tom_victory`, and a plain script variable never notifies, so the DLL polls a short allow-list (the `level_var` names in the map's manifest) at ~1 Hz. *(added 2026-09-20)* |
| `snap` | `players:[{slot,pos:[x,y,z],ang:[pitch,yaw],health,score,weapon,stance,alive}]`, `zombies:[{id,pos,health}]` | players 20 Hz; zombies 10 Hz (either list may be omitted in a given snap) |
| `input` | `slot, buttons, moved:bool, turned:bool` | per client, at most 10 Hz. **"Only on change" means: on a change of the moved/turned/fire state, plus a 1 Hz heartbeat while active.** A continuously-moving player would otherwise emit 10/s forever and AFK scoring does not need it. It is ~9% of replay bytes even so |
| `perf` | `frame_ms_p50, frame_ms_p99, cpu_pct?` | every 10 s |
| `log` | `level, msg` | anything worth surfacing |
| `ui` | `slot, ui, pchat` | one client's pause-menu / chat state changed: `ui` is `paused` \| `typing` \| `clear`, `pchat` its "pause when using global chat" setting. Read from that client's userinfo keys `enw_ui` / `enw_pchat` (the contract: `chat-overlay.md` §8). Sent on change, only for an active slot; a slot that leaves sends nothing here (its `player_disconnect` is the event). *(added 2026-09-22, referee.md §15)* |
| `pause_state` | `paused, reason, players, held_ms?` | the world froze or unfroze. `reason`: `host` (the host's own `pause` hold, echoed), `solo_menu`, `solo_chat`, `all_menu`, or `none` when `paused:false`; `held_ms` on unfreeze. The host accounts every non-`host` pause as paused time (excluded from in-game time) and never answers it with `pause`/`resume`. This is also the visible PAUSED state for the site, the launcher and the overlay. *(added 2026-09-22, referee.md §15, dedi.md §18)* |
| `reply` | `id, ok, error?, value?` | answer to a host command with an `id` |

## Host → game
| `t` | Fields | Effect |
|---|---|---|
| `say` | `text, from?` | show a chat line to every player (Global chat relay, warnings) |
| `tell` | `slot, text` | chat line to one player |
| `exec` | `id, cmd` | run a console command. **DEV ONLY**: refused with `"dev knobs off (ENW_DEV_KNOBS)"` unless the game process was launched with `ENW_DEV_KNOBS=1`, which nothing that launches a Verified game sets. Single line only. *(implemented 2026-09-22, referee.md §10.5)* |
| `set` | `id, dvar, value` | set a dvar |
| `pause` / `resume` | `id` | the host's HOLD on an engine-level freeze (crash grace, everyone-AFK, an operator). Since 2026-09-22 the dedi freezes by not running `G_RunFrame` and holding `svs.time` (dedi.md §18): everything in the world stops, nothing needs pushing forward. The hold is OR-ed with the players' own pause (`pause_state`) and only `resume` releases it. Reply error `pause not armed` on a listen server or if the gate did not install. |
| `kick` | `id, slot, reason` | drop a client |
| `auth` | `slot, allow:bool, reason?` | answer to a `player_connect` token check. **Implemented game-side 2026-09-22 and until then ignored**: the host agent answers every `player_connect` with one, so every DENY it has ever sent was discarded and the client played on. Now `allow:false` clears that slot's identity to `refused`, sends `clientkick <slot>`, and the slot's `game_over` row carries no account. `allow:true` promotes `claimed` → `verified` — **except** when `reason` is `token_check_disabled`, which is what `TokenGuard` answers when it holds no site key or is not enforcing; that is not a check and does not promote. *(referee.md §13)* |
| `end` | `id, reason, match?` | end the game cleanly, **and the answer to `match_end` when the host wants to reuse the instance**. The referee reports the result first if the match had not already ended, issues `map_restart`, resets its per-match state and re-announces `map_loaded`. `reply.ok:false` means the command buffer was unavailable — the instance must be torn down, not reused. **`match` is new and the host should send it on a reuse**: the referee reads the lease id from `ENW_MATCH` at process start, and a warm instance serves a match that process never heard of, so without it the successor game cannot lease-check its invite tokens. The referee clears the id rather than keep the finished match's — a stale id would refuse every legitimate token with `wrong_match`, which is the worse failure. Its single-use token set is cleared on every reset, so match A's invites can never admit anyone to match B. *(2026-09-22; `match` added, referee.md §13)* |
| `snapshot_state` | `id` | reply `value` = full restorable state (points, weapons, perks, position per player; round). The host asks for this the moment a player DROPS, while the level still has it. |
| `restore` | `id, slot, state` | put a returning player back as they were: `state` is that player's slice of an earlier `snapshot_state` (`score`, `weapon` incl. `_upgraded`, `perks`, `pos`, `ang`). Reply ok/error. **Only ever sent for casual/badge games** — a record-profile game gets the pause and a vanilla rejoin, because restoring by hand is not vanilla and would disqualify the run (vault 10 §5). *(added 2026-09-20)* |

## Who consumes what (host side, built 2026-09-20)
`infra/host-agent` implements this whole table. The referee is driven by `round`, `game_over`,
`player_connect`/`_spawn`/`_disconnect`, `down`/`revive`/`bleedout`, `points`, `chat`, `input`,
`notify`, `dvar`, `level_var`; the live 2D view and the replay tracks come from `snap`; `perf` is
surfaced on the dashboard. `hello.exe_sha256` and `hello.dll_build` go into the signed replay
header and are what the run fingerprint is computed over, so they must be real.

**`match_end` and `end`, host side (implemented 2026-09-22, `host.md` §12).** On `match_end` the
host closes and signs the replay, posts the result from the `game_over` message, and then takes
exactly one disposition — `end` (reuse) or terminate. Three things this settled that the rows above
leave open:

- **`end` does not restart the process, so there is no second `hello`.** The link stays up straight
  through the `map_restart`, and `exe_sha256` / `dll_build` arrive only once. A host that reuses an
  instance must carry them into the next game's replay header or write two nulls into the field the
  run fingerprint is computed over.
- **`reply` to `end` and the re-announced `map_loaded` can arrive in the same TCP read.** Whatever
  is going to own the next game must own the socket *before* `end` is sent; a host that waits for
  the reply and only then hands the connection over will miss the `map_loaded` it is waiting for.
- **`match_end` is not an event of the match** and is not appended to the replay — `game_over` is
  the last event, by this table. The host carries it in the result instead
  (`summary.match_end`, `summary.reported`).

**`identity` and `end`.`match`, host side (implemented 2026-09-22, `host.md` §12.10).**

- **`summary()` is the single gate.** A `steamid` leaves the host and reaches `/api/gs/result` only
  when `identity` is `verified`. Anything less posts the row without one — name, score, `identity`,
  `identity_reason`, `claimed_steamid` — and the site writes it into `summary_json` and creates no
  `game_players` row, so nothing is credited to an account nobody checked. The game's own row wins
  over the host's fold where it sent one, because the game made the checks only it can make.
- **`auth {allow:true, reason:"token_check_disabled"}` promotes nothing.** It is an admission, not
  a check: it is what `TokenGuard` answers when it holds no site key or is not enforcing.
- **The reuse that follows a game sends `end` with NO `match`.** There is no next lease yet, and a
  stale id refuses every token with `wrong_match`. The host sends a **second `end`, carrying
  `match`**, when a lease actually arrives — one extra `map_restart`, no process start, no map
  load. An instance that will not take its new match id is torn down and a fresh one booted.
- **`sim_roster` on `end` is a SIMULATOR-ONLY field** and a real DLL must ignore it (the rule above:
  unknown fields are ignored by both sides). It hands the fake game the next party and their
  tokens, because the simulator invents its players; a real client brings its own token in its
  userinfo when it connects, so the real server needs nothing but `match`.

**System lines, host side (implemented 2026-09-23, `web.md` §12).** Three of the messages above
— `player_connect`, `player_down` and `game_over` — are additionally bridged to the SITE as a
**fact**, `POST /api/gs/event` with `{event, name, steamid?, identity, map, map_name?, round,
match_id, instance}`, and the site composes the sentence. The split is deliberate and is the same
one as everywhere else in this protocol: the box reports what happened, and the thing that holds
the user table decides whose name is on it. A `steamid` is sent only when the roster says
`verified`; a `refused` slot is never announced at all. The host also decides the one thing only
it can — **which `player_connect` is a start**: the first player to connect to a game started it
and everybody after them joined it, reset on every `map_loaded` so a warm instance's next game
does not read as five people walking into the last one.

**Reconciling `game_over`'s numbers with the host's own fold.** Both are *lower bounds* on a
monotonic counter, so the host takes the larger. `game < host` is expected and honest — the game's
figures are polls of script variables that read 0 when those are unbound (`referee.md` §10.2), and
its per-player `score` is the wallet **at game over** where a host's is the highest ever held.
`game > host` is the one direction that means evidence went missing on the link, and that is what
gets flagged.

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

## Addendum, 2026-09-23 — `name` is the account's, once identity is `verified`

**No field changed.** What changed is what one of them means, and it is worth a line so nobody
reads an old transcript and thinks the game is inconsistent.

The invite token has carried `n` (the player's ENW name) since v0. As of `referee.md` §14 the
referee **enforces** it: for a slot whose token the host verified, it overwrites the server's
copy of that client's userinfo `name` with the token's, so the roster follows the account and not
whatever the client sent.

The consequence for a reader of the link:

| message | `name` | why |
|---|---|---|
| `player_connect` | the **client's own** name | emitted at the connect edge, *before* the host's `auth {allow}` has come back. The row is `claimed`; nothing is locked yet. |
| `player_down`, `game_over` | the **account's** ENW name, for a `verified` row | the lock armed on the `auth allow`. `game_over` is the message a host may post a result from (§10.3), and it is the one the site credits. |
| anything, `identity != verified` | the client's own name | an untokened or refused client is never locked, and its row is unawardable anyway. |

So `player_connect.name` and `game_over.name` **can legitimately differ for the same slot in the
same game**, and when they do it is the lock working. The `steamid` is the join key throughout
and is unaffected.
