# Kickstart — start here

You are picking up an in-flight prototype. Read this page, then `../../STATUS.md`, then the one
lane doc you are working in. Three minutes.

## Where things stand (2026-09-22, evening)

**The dedicated server runs real games to game over, on the Hetzner box, with a real player, a
signed replay and a result credited through the site's invite token.** The site is Movement's map
browser, launcher 0.2.2 is on the feed, the client is isolated from the player's own WaW data.
`next-session.md` has the one-page state; `../../STATUS.md` is the current truth; each lane doc's
newest dated section is the detail.

Corrections that pre-date you and will save you a wrong turn:

- **T4 has no `CS_PRIMED`.** The middle state is `CS_CLIENTLOADING`.
- **A `getstatus` reply is not simulation.** The water-sim access violation unwound every frame out
  of `Com_Frame` for two days while status packets kept answering. Gate 5 (`com_frameTime`
  advancing) exists for this; never call a server healthy without it.
- **WaW has no DirectInput**; the mouse is `GetCursorPos` once a frame. The raw-input port is the fix.
- **LAA / the 4 GB patch is impossible on the Steam exe** — SteamStub refuses a flagged exe.
- **A real client's userinfo has no steamid**; identity is our `enw_token` and nothing else.
- **Nothing of ours goes under the player's `Activision\CoDWaW`** — ever. Our session's data lives
  under `%LOCALAPPDATA%\ENWZombies` (the DLL redirects the engine there).

## Hard rules

The source is `../dev-box.md`. This is the short list, and none of it is negotiable.

1. **Never modify B's Steam install** (`C:\Program Files (x86)\Steam\steamapps\common\Call of Duty
   World at War`). Read-only, always. Copy out, never write in.
2. **Never launch `CoDWaWmp.exe`**, and never connect to public servers or the Activision master
   server. The single-player exe `CoDWaW.exe`, on localhost or LAN, is the only one we run.
3. **Honour the game lock.** `C:\Users\b\ZombiesDev\locks\game.lock`, one game instance at a time.
   Take it, release it, never release a lock you did not take. A server-plus-client experiment
   holds the one lock for both.
4. **Kill only your own PIDs.** Never `taskkill /IM CoDWaW.exe`, never `Stop-Process -Name`.
   Another agent, or B, may be running the game.
5. **Never pass `+set developer 1`** to a game you want to keep running. It promotes missing-asset
   warnings to fatal modal errors, and it has cost us two wrong diagnoses already.
6. **Never run an `.exe` that came with a map.** Map files are data.
7. **Do not touch the live site or the tunnel.** The `node` process on port **3200** is B's public
   site and `cloudflared` is the tunnel to `zombies.enw.gg`. Do not restart either, and do not
   write to `web/data`. If you need a web server, take 3399 or another free port.
8. **No money, no accounts, no passwords.** If something costs money, stop and say so. **One
   exception, authorised by B on 2026-09-22 and no wider than its own words**: the Hetzner box
   `zombies-dev`, €7.19/month gross, [`vps.md`](vps.md). Anything that would raise that bill —
   a second box, a bigger type, a volume, a backup, a floating IP — is still rule 8.
9. **Hooks are owned, not shared.** MinHook allows exactly one hook per target address and the
   loser only finds out from a log line. Use `enw::frame::subscribe`; never hook `Com_Frame`
   yourself. `dev-box.md` rule 12 has the detail.
10. **Never write "CoolGombies"** — a voice-to-text artefact. The name is **ENW Zombies**.

One convenience, not a rule: `infra\firewall.ps1`, run **once, elevated** by B, stops Windows
prompting to allow the game every time an agent makes a new dev copy. `-Remove` undoes it.

## The docs, and who owns what

| Doc | Lane | Owns (write only here) |
|---|---|---|
| [`dedi.md`](dedi.md) | **dedi** | `server/components/dedicated/`, `server/components/net/`, `tools/dev/` — the headless dedicated server. Read §7h (the spawn), §7i (the autosave), §7j (the open freeze) first |
| [`host.md`](host.md) | **host** | `infra/host-agent/` — the Node agent that runs game instances, referees them, signs replays, talks to the site. §10 is the latest session |
| [`referee.md`](referee.md) | **referee** | `server/components/{referee,replay,chat,afk,pause,knobs}/`, `referee/` — rounds, game over, EE flags, replay sampling, chat |
| [`foundation.md`](foundation.md) | **foundation** | `shared/core/`, root `CMakeLists.txt`, `tools/dev/`, `ZombiesDev\waw-base` and the per-agent copies — the proxy-DLL loader that waits for SteamStub, logging, the game-link client, component registration |
| [`client.md`](client.md) | **client** | `client-dll/components/` — the player's game: the raw-input mouse fix for high polling rates (§1, a port of iw4x-client's `RawMouse`), and the plan for in-game settings persistence, borderless windowed and the chat overlay (§2) |
| [`launcher.md`](launcher.md) | **launcher** | `launcher/` — the Electron client: find WaW, install the ENW client, install maps, launch |
| [`web.md`](web.md) | **web** | `web/` — the site at `zombies.enw.gg`, a port of ENW Movement |
| [`replay.md`](replay.md) | **replay** | `web/client/src/replay3d/`, `web/client/src/pages/Replay.jsx`, `web/server/routes/replay.js`, `tools/maps/` — the 3D replay viewer ported from ENW Movement, and the WaW map export. Read §4 before trusting a map export: the world shell is not obtainable from a fastfile |
| [`archive.md`](archive.md) | **archive** | `archive/` — the crawler, the catalogue and the link report |
| [`vps.md`](vps.md) | **vps** | `infra/vps/` and the Hetzner box `zombies-dev` — the one Linux dev box, Wine, and the headless Windows Steam client. It is the project's **only** spend; read the cost section before touching anything there |
| [`../re/t4-sp-map.md`](../re/t4-sp-map.md) | **re** | `shared/t4/`, `docs/re/`, `tools/re/`, `ZombiesDev\dumps` — the decrypted exe, verified addresses, structs, the security audit (Huffman / OOB handlers) |

Shared, and owned by nobody:

| | |
|---|---|
| [`board.md`](board.md) | The coordination log. **Append-only**, `- HH:MM <lane>: <fact>`, newest last. Corrections go on as new lines; nothing is deleted. It ends with *What is open right now* |
| [`next-session.md`](next-session.md) | The one-page handoff. Start here if you are the next session |
| [`questions.md`](questions.md) | Things only B can answer. Append-only |
| [`../dev-box.md`](../dev-box.md) | The rules, in full, plus paths and known traps |
| [`../protocol/game-link-v0.md`](../protocol/game-link-v0.md) | The contract between the game DLL and the host agent |
| [`for-players.md`](for-players.md) | What B sends to friends. No jargon |
| [`../../QUICKSTART.md`](../../QUICKSTART.md), [`../../TESTME.md`](../../TESTME.md) | The two run books B follows by hand |

Dated and kept as written, *not* current — read them as history: [`morning.md`](morning.md) (the
2026-09-20 brief), [`overnight.md`](overnight.md) (the 2026-09-20 plan),
[`session-2026-09-21.md`](session-2026-09-21.md) (the 2026-09-21 brief), and
[`archive.md`](archive.md)'s link report, which is a measurement of one night and rots.

## How this project writes things down

Four habits, and they are the reason the docs are worth reading:

- **Evidence or it did not happen.** A call returning without error is not evidence. If you cannot
  show the effect, write "unproven".
- **Retract in writing, in place.** A wrong claim is never quietly deleted; it is left where it
  was with the correction beside it. That is how the next session avoids re-deriving it. Several
  of the most useful paragraphs in `dedi.md` are retractions.
- **Observation and inference are kept apart**, and a number taken in a sandbox says so.
- **Append to `board.md` as you go**, with your lane name and the time.

---

## The original brief (2026-09-19)

**B's ask**: build enough of the server side, locally on B's PC, to prove the product is viable and
give the real build something to start from. "Server" means our server software (the game-server DLL
plus the host agent that runs games), not a rented box. Probe every feature B described that depends
on the server (the list below) and give each one a verdict with evidence.

This is discovery that is kept: the code is prototype quality but lives in the real repo layout, so the
Fable build can pick it up.

### The features to judge (verdict + evidence each)
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

Feature 1 is **done** as far as "a client connects and spawns in"; it is not done as far as "the
server survives it". The rest of the verdicts are in each lane's doc, and `dedi.md` §10 carries the
milestone table.

### Output
Each agent keeps its own findings file current as it works (so the coordinator can read progress) and
ends with a report. The coordinator writes the verdict table into the vault (`17 - Kickstart`).
