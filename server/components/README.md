# `server/components/` — the referee's six components

Each is one `.cpp` registered with `ENW_REGISTER_COMPONENT` (see `shared/core/component.hpp`), so
they can be added to the build without anyone editing a shared list.

| Folder | Emits / accepts (game-link v0) | Owner |
|---|---|---|
| `referee/` | `round`, `game_over`, `notify`, `points`, `down`; accepts `snapshot_state`, `end` | referee |
| `replay/` | `snap` | referee |
| `chat/` | `chat`; accepts `say`, `tell` | referee |
| `afk/` | `input` | referee |
| `knobs/` | accepts `set` | referee |
| `pause/` | accepts `pause`, `resume` | referee |
| `dedicated/`, `net/` | — | dedi |

## The one thing to know before reading the code

`server/components/referee/t4_bind.hpp` is the only place any of these touch the game. It is a
narrow interface — read a `level` field, read a player field, read an entity, send a chat line, get
a per-frame callback, get a notify callback — and **every accessor currently returns "unavailable"**,
because the `re` agent has not published `shared/t4/addresses.hpp` yet.

That is deliberate. The components run, log what they cannot do, and emit nothing, rather than
dereferencing an address from the vault on a hope and faulting the game mid-round. Wiring them up is
one file: `t4_bind.cpp`, about ten short functions, listed in its header comment.

## Why the logic sits here and the decisions sit in the host

The components report facts. Whether a game earned a badge is decided by the host agent, against
`referee/manifests/<map>.json`, because that decision has to survive the game process crashing and
has to be re-runnable over a stored replay when a manifest is corrected. See
`docs/kickstart/referee.md` §3 and `referee/manifests/_schema.md`.

## The fact the whole design rests on

`common_scripts/utility.gsc:435` — `flag_set(msg)` ends with `level notify( msg )`. Every flag in
every CoD script announces itself as a level notify named after the flag, so one hook sees every
easter-egg step on every map with no per-map code. Everything else in `referee.cpp` is bookkeeping
around that.
