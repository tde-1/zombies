# Kickstart: server-side viability prototype (2026-09-19)

**B's ask**: build enough of the server side, locally on B's PC, to prove the product is viable and
give the real build something to start from. "Server" means our server software (the game-server DLL
plus the host agent that runs games), not a rented box. Probe every feature B described that depends
on the server (the list below) and give each one a verdict with evidence.

This is discovery that is kept: the code is prototype quality but lives in the real repo layout, so the
Fable build can pick it up.

## Agents and ownership
| Agent | Owns (write only here) | Goal |
|---|---|---|
| **foundation** | `shared/core/`, `CMakeLists.txt` (root), `tools/dev/`, `ZombiesDev\waw-base` + copies | Build system, dev game copies, the proxy-DLL loader that waits for SteamStub, logging, the game-link client (TCP NDJSON), component registration. Milestone **E1**: our DLL prints in the game console. |
| **re** | `shared/t4/`, `docs/re/`, `tools/re/`, `ZombiesDev\dumps` | Dump the decrypted exe, verify the vault's public addresses, map the functions/globals everyone needs, security audit (Huffman / OOB handlers). |
| **dedi** | `server/components/dedicated/`, `server/components/net/`, `docs/kickstart/dedi.md` | Stage C spike: how far `CoDWaW.exe` gets as a headless dedicated server; count crash sites; get it to load a map with no window; get a client on the same PC to connect. |
| **referee** | `server/components/{referee,replay,chat,afk,pause,knobs}/`, `referee/`, `docs/kickstart/referee.md` | Script extraction and hook points; the in-process referee (rounds, game over, EE/ending flags); replay sampling; chat capture + injection; AFK input; pause; knobs. Proven first in a solo game. |
| **host** | `infra/host-agent/`, `docs/kickstart/host.md` | The host agent (Node, zero-dependency where possible): instance manager, game-link server, referee state machine, signed replay writer, cross-server chat hub, invite tokens, pull-protocol stub, local dashboard with a live 2D view. |

Shared files: `docs/protocol/game-link-v0.md` (contract), `docs/dev-box.md` (rules), `docs/kickstart/board.md`
(the coordination board: append-only dated lines).

## The features to judge (verdict + evidence each)
1. Headless dedicated server (Stage C) boots a zombies map; clients connect.
2. Server CPU/RAM per game (render-skip).
3. Several games on one machine.
4. Rounds and game over detected server-side.
5. Easter egg / Buyable Ending detection from script flags (stock + `nazi_zombie_ali`).
6. Custom maps load on the server (`fs_game mods/<map>`).
7. Knobs: change zombie health/speed/start round/points etc. at runtime.
8. Cross-server chat: capture player chat; inject lines into the game.
9. Replays: sample players 20 Hz / zombies 10 Hz; real bytes per game-hour; signed and verifiable.
10. AFK: per-player input activity.
11. Pause / crash recovery: freeze and resume; snapshot and restore a player's state.
12. Invite-token joins: the server sees a token at connect and can reject.
13. Late joiners detectable.
14. Security: the Huffman bound (CVE-2018-10718 class) present or not in T4; OOB handlers we can close.
15. The 24 h cap / warnings / clean end.

## Output
Each agent keeps its own findings file current as it works (so the coordinator can read progress) and
ends with a report. The coordinator writes the verdict table into the vault (`17 - Kickstart`).
