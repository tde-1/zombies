# Dev box rules (B's PC)

Everyone working on this repo from B's PC (agents included) follows these. The spec lives in the
vault: `C:\Users\b\Desktop\shared-notes\ENW COD Zombies\` (start at `99 - Build Spec (for Fable).md`,
facts in `11 - Implementation Reference.md`).

## Paths
| What | Where |
|---|---|
| Repo (our code only) | `C:\Users\b\Desktop\Zombies` |
| Steam WaW install (**read-only, never write, never add files**) | `C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War` |
| Dev area (game copies, dumps, logs, tools; never committed) | `C:\Users\b\ZombiesDev` |
| Full copy of the game for dev | `C:\Users\b\ZombiesDev\waw-base` |
| Per-agent game copies | `C:\Users\b\ZombiesDev\waw-<name>` (see "Game copies") |
| Decrypted exe dumps (Activision code: never commit, never upload) | `C:\Users\b\ZombiesDev\dumps` |
| Game launch lock | `C:\Users\b\ZombiesDev\locks\game.lock` |
| Logs | `C:\Users\b\ZombiesDev\logs\<name>\` |
| B's existing custom map (a Buyable Ending map, handy for tests) | `%LOCALAPPDATA%\Activision\CoDWaW\mods\nazi_zombie_ali` |

Steam exe facts: `CoDWaW.exe` 1.7, 5,902,336 bytes, SHA-256
`732900D158982C33E3121F0B86D22230BE79839BBCBFE3BDFC1238F408A7D64D`, Steam build 252004. SteamStub DRM.

## Hard rules
1. **Never modify B's Steam install.** Copy it. Proxy DLLs, configs and experiments go in dev copies only.
2. **Never launch `CoDWaWmp.exe`.** Never connect to public servers or the Activision master server.
   Only the SP/co-op exe `CoDWaW.exe`, on localhost/LAN.
3. **Never run an `.exe` that came with a map** (e.g. `nazi_zombie_ali\gift.exe`, an unsigned 20 MB
   "gift" installer). Map files are data.
4. **Kill only processes you started, by PID.** Never `taskkill /im CoDWaW.exe` or `Stop-Process -Name`:
   another agent (or B) may be running the game.
5. **Game launch lock**: before launching the game, create `locks\game.lock` containing
   `<your name> <pid-or-"starting"> <ISO time> <what>`. Release it (delete) as soon as the experiment
   ends. A lock older than 15 minutes, or whose PID is dead, is stale and may be taken. An experiment
   that needs two instances (a server + a client) holds the one lock for both. If you learn that
   concurrent instances are safe, write it on the board; the rule may then be relaxed.
6. **Windowed, small and muted**: launch with `+set r_fullscreen 0 +set r_mode 800x600` (and mute if a
   dvar allows). B may be using the PC.
7. **Clean room** (vault `03` §6): copy from GPL/AGPL sources only (iw4x-sp, iw3sp_mod,
   T4SP-Server-Plugin at `c79450e` for code; its `main` headers for structs, CoD4x, OpenAssetTools).
   T4M / T4M-Enhanced / WAW-Community-Patch / t4-rtx are **read-only facts, never code**. Never paste
   decompiled Activision code into the repo; write our own code from understanding. Dumps stay in
   `ZombiesDev\dumps`.
8. **No money, no accounts, no passwords.** Nothing that costs money. B logs into Steam; nobody else
   touches the Steam client, account or settings.
9. **Downloads**: source repos from the projects named in rule 7, MinHook, and well-known PyPI/npm
   packages are fine. Put third-party checkouts in `C:\Users\b\ZombiesDev\thirdparty\` (not the repo)
   unless we vendor a file under its licence. Large binary tools (e.g. Ghidra): only when the
   coordinator says B approved.
10. **Don't commit.** The coordinator commits. Don't touch other agents' folders (see
    `docs/kickstart/README.md` for who owns what); if something of theirs blocks you, write it on the
    board.
11. Keep the shared C++ tree compiling. Build into your own build dir (`build\<name>`), never a shared
    one.
12. **Hooks are owned, not shared. MinHook allows exactly ONE hook per target address**, and the
    loser only finds out from a log line, so two components hooking the same function means one of
    them silently stops working. Before you hook anything, check whether the core already offers it:
    - **per-frame tick**: `#include "frame.hpp"` and `enw::frame::subscribe("you", fn)`.
      **Never hook `Com_Frame` yourself.** The core owns it (by retargeting WinMain's call site,
      which deliberately leaves `Com_Frame`'s own bytes free) and dispatches to subscribers.
    - **main-thread work** from another thread: `enw::scheduler::run_on_main(fn)`.
    If you need a hook on a function another component may also want, say so on the board first and
    put the shared version in `shared/core/`. Prefer `memory::retarget_call()` on a known call site
    over an inline detour: it cannot collide and it relocates nothing.
13. **Never pass `+set developer 1` to a game you want to keep running.** It promotes missing-asset
    warnings to fatal modal errors, and stock WaW is missing at least one image
    (`images/sun_flare.iwi`). `tools\dev\launch.ps1` has it off by default; `-Developer` opts in.

## Game copies
- `waw-base` is a full copy of the Steam folder (made once by the foundation agent).
- A per-agent copy is a folder with **junctions** to `waw-base\main`, `waw-base\zone`,
  `waw-base\DirectX`, `waw-base\Docs`, `waw-base\installers`, `waw-base\pb`, and **copies** of the
  root files (exe, dlls, bmp, ico, txt, inf, vdf). Treat junctioned folders as read-only.
  `tools\dev\new-copy.ps1 <name>` makes one (written by the foundation agent).
- Per-instance user data: try `+set fs_homepath C:\Users\b\ZombiesDev\homes\<name>` so instances don't
  share B's profile/config. Record on the board whether it works.

## Known traps
- WaW may show a **"run in safe mode?"** dialog after a crash, which blocks automation. Find the
  marker it uses and clear it, or patch the prompt out in the DLL.
- First-run dialogs (optimal settings, profile) also block. Note what appears.
- Steam may relaunch the game from its own folder instead of a copy (SteamStub). If copies can't
  run, stop and write it on the board. Don't fall back to writing in the Steam folder.
