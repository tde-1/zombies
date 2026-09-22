# Launcher: finding the game, installing the client, getting into a match

Owner: the **launcher** agent. Code: `launcher/`. Nothing outside that folder is edited.

The thing being built is the one a player double-clicks: it finds their World at War, installs the
ENW client into a folder of ours, wraps the site, and turns "press Play" into "you are in a zombies
game". Wherever the foundation agent already solved something (`tools/dev/new-copy.ps1`,
`deploy.ps1`, `launch.ps1`), this wraps that knowledge rather than re-deriving it — the differences
are noted where they exist and each one has a reason.

---

## 0. The commands

```bash
cd launcher
npm install                                   # Electron 38 (see §8 if the binary does not extract)

npm test                                      # 35 in-process checks, no Electron, no game
npm run test:launch                           # spawns a stand-in "game" and checks what it received
node src/main/detect-cli.js                   # find World at War and explain every step
node src/main/detect-cli.js --browse "C:\..." # the forgiving browse fallback, from a folder
node src/main/detect-cli.js --json            # the same as a machine-readable report
node src/main/setup-cli.js install            # install the ENW client into %LOCALAPPDATA%\ENWZombies
node src/main/setup-cli.js status
node src/main/setup-cli.js uninstall          # --delete-maps to drop the map library too
node src/main/play-cli.js --dry-run           # the exact command line, nothing started
node src/main/play-cli.js --map nazi_zombie_prototype --local --seconds 60 --stealth   # takes game.lock

npm start                                     # the actual app
ENW_SMOKE_MS=5000 npx electron .              # boot it, report what came up, quit (no window)
ENW_SMOKE_MS=5000 ENW_SMOKE_SHOT=1 npx electron .   # …and save screenshots to the log folder

node src/main/maps-cli.js list                # the archive's maps, title AND bsp
node src/main/maps-cli.js install water       # "Alcatraz", hash-verified
node test/slice.js --map nazi_zombie_leviathan   # the whole vertical slice, one run
node tools/crash-sink.js                      # the local crash endpoint (127.0.0.1:8791)
node tools/make-icons.js                      # regenerate the tray icon
```

Environment: `ENW_ROOT` moves the install folder, `ENW_SITE_URL` pins the wrapped site,
`ENW_DEV_ROOT` moves (or disables) the shared game lock.

---

## 1. Finding World at War — and proving it

`launcher/src/main/detect.js`. Every route is tried, every route reports, and the report is what the
first-run screen shows. Zero native modules: the registry is `reg.exe`, VDF and PE parsing are ours
(`vdf.js`, `pe.js`).

| Route | What it reads | On B's PC |
|---|---|---|
| `steam_registry` | `HKCU\Software\Valve\Steam\SteamPath`, `HKLM\...\WOW6432Node\Valve\Steam\InstallPath`, then the two default paths | `c:\program files (x86)\steam` |
| `steam_libraries` | `steamapps\libraryfolders.vdf` — both the current object format and the old flat one | 1 library |
| `appmanifest` | `appmanifest_10090.acf` → `installdir`, `StateFlags` | `installdir="Call of Duty World at War" StateFlags=4 (fully installed)` |
| `ownership` | `HKCU\Software\Valve\Steam\Apps\10090\Installed`, `config\loginusers.vdf` | `Installed=0x1`, signed in as `myu (76561198126330106)` |
| `hint` | a saved path, or whatever the player picked in the browse dialog | — |

**Result on B's machine: `verified` in 157 ms.**

### Validation: what "verified" means

Five checks, all shown to the player with their actual values:

| Check | B's install |
|---|---|
| `exe_size` | 5,902,336 bytes (expected 5,902,336) |
| `pe` | 32-bit PE, sections `.text .rdata .data .tls .rsrc .bind` |
| `version_1_7` | file 1.7.0.0, product 1.7.0.0 — read from the PE version resource, not a filename |
| `steam_build` | `.bind` present (SteamStub) — this *is* the Steam release, and nothing else has it |
| `sha256` | `732900d1…f408a7d64d` — the known Steam 1.7 build 252004 |

Three grades, because refusing everything that is not byte-identical would break B's "as easy to set
up as possible" rule, and accepting everything would make "verified play" meaningless:

* **verified** — exact SHA-256 match plus `main/` and `zone/`. Eligible for records.
* **accepted** — 1.7, SteamStub, right size, game data present, different hash. Playable; the UI
  says verified play may need an update.
* **rejected** — with the reason: not a Steam build / not 1.7 / no game files beside the exe.

`CoDWaWmp.exe` is never a valid target, at any grade (dev-box rule 2).

### The forgiving browse fallback

B: *"it must tolerate them choosing the wrong folder."* `searchAround()` looks **at** the folder,
**down** into it (breadth-first, depth ≤ 4, ≤ 4,000 directories), and **up** through six parents —
checking each parent, one level down from each parent, and the `steamapps\common` convention at
every level. Junctions are never followed (Windows junction loops are real). Picking the exe itself
works too.

Measured, all four corrected to the right folder:

| Player picks | Found via | Cost |
|---|---|---|
| `…\Steam` | in the folder you picked | 108 ms, 1,406 dirs |
| `…\World at War\main` | 1 level above | 3 dirs |
| `…\steamapps\common` | in the folder you picked | 19 dirs |
| `…\World at War\zone\english` | 2 levels above | 3 dirs |
| `C:\` | (finds `ZombiesDev\waw-base`) | 917 ms |
| `C:\Users\b\Desktop` | gives up at the budget | 1.5 s, nothing found |

### Ownership, honestly

A local Steam install cannot *prove* ownership offline and we do not ask for credentials. What the
launcher can say is "Steam has app 10090 registered for the signed-in account", which is enough to
choose between the three first-run screens the spec asks for: **installed**, **owned but not
installed** (`steam://install/10090`, then setup continues), and **no evidence** (link to the store
page). That distinction is `detect().state`.

---

## 2. Setup: a separate ENW folder, never the Steam install

B's decision (spec 13 §2). `launcher/src/main/setup.js` mirrors `new-copy.ps1` + `deploy.ps1`:

```
%LOCALAPPDATA%\ENWZombies\
  game\        junctions to main, zone, DirectX, Docs, installers, pb  (the player's install)
               real copies of the 9 root files
               steam_appid.txt = 10090
               binkw32.dll     = our enw_t4.dll
               binkw32_org.dll = the stock Bink, every export forwarded to it
               mods\enw\       = fs_game
  home\        fs_homepath: ENW's profile, config and console.log
  maps\        the ENW map library (spec: never inside the WaW install)
  logs\ crashes\ updates\ state\
```

**7.7 MB**, and the player's install is read-only throughout.

Two deliberate differences from the dev scripts:

1. **`CoDWaWmp.exe` is not copied.** The cheapest way to guarantee we never launch it is not to have
   it.
2. **No space in any path.** The engine parses its own `GetCommandLine()`, so
   `+set fs_homepath C:\…\ENW Zombies\home` is a failure waiting to happen on someone else's
   machine. The folder is `ENWZombies`. (This was caught by looking at a dry-run command line, not
   by a crash — worth stealing for anything else that passes a path to the engine.)

### How "we never touch your game" is enforced, not promised

* One function, `assertWritable()` in `paths.js`, guards every create/move/delete. It refuses
  anything inside a Steam root (static list plus the detected install, registered at setup time) and
  anything outside `ENW_ROOT`. Tested both ways.
* `install()` fingerprints the player's install (names, sizes, mtimes) **before and after** and
  reports the diff. Every run so far:
  `untouched: verified: nothing in <their install> changed (16 entries compared before and after)`.
* The manifest at `state\setup-manifest.json` lists every path created, so uninstall is exact rather
  than a recursive delete, and the UI can show the player precisely what changed.
* **Uninstall removes junctions with `rmdir` first**, then checks every target still exists before
  deleting anything else. Deleting recursively *through* a junction would delete the player's game;
  there is a test that creates a junction, removes our folder, and asserts the target survived.

Round trip verified on the real install: install → uninstall → Steam folder still has all 16
entries, `main/` still has 36.

---

## 3. Launch and connect

`launcher/src/main/launch.js`. The command line, from `play-cli.js --dry-run`:

```
"…\ENWZombies\game\CoDWaW.exe"
  +set fs_homepath …\ENWZombies\home
  +set com_introPlayed 1
  +set fs_game mods/enw
  +set com_startupIntroPlayed 1  +set ui_autoContinue 1
  +set cl_allowDownload 0        +set logfile 2
  <the launch baseline + the account's settings: r_mode, r_noborder, r_vsync, com_maxfps, cg_fov, … — see the 2026-09-22 section at the end of this page>
  +connect <host>
```

Environment: `SteamAppId=10090`, `SteamGameId=10090` (without these a copied exe exits(0) after
~1.5 s — dedi, board 00:35), plus game-link v0's `ENW_HOST` / `ENW_INSTANCE` / `ENW_ROLE` /
`ENW_LOGDIR`.

### The invite token is never on the command line

Any process on the machine can read another's command line, and it lands in logs, crash dumps and
screenshots. The token is a bearer credential for a match.

* The launcher opens a **one-shot named pipe** with a random name, `\\.\pipe\enw-launch-<16 hex>`,
  and passes only the *name* in `ENW_TOKEN_PIPE`. The first connection gets
  `{"v":0,"token":"…"}\n` and the pipe closes. There is a test for it.
* `ENW_TOKEN` in the environment is a fallback, off unless asked for.
* **Not wired on the game side yet.** The DLL reads neither variable today (`grep ENW_TOKEN` in
  `shared/`, `client-dll/`, `server/` finds nothing), and game-link v0 says the token arrives in
  userinfo at connect. Proposal for the protocol doc, for whoever owns the client side:

  > The client DLL reads `ENW_TOKEN_PIPE`, connects once, reads one NDJSON line `{v,token}`, and
  > puts the token in userinfo before connecting. If the variable is absent it falls back to
  > `ENW_TOKEN`, and if that is absent it connects without one (the server then refuses, which is
  > the correct behaviour for a verified match).

### The dialogs that used to stop everything

`tools/window-nanny.ps1`, driven by the launcher and emitting NDJSON so the boot screen can show
what happened. It carries three pieces of knowledge that were paid for by other agents:

* **"Set Optimal Settings?" and "Run In Safe Mode?"** are `#32770` modals that appear before the
  game is playable and block forever. Both want **No** — No keeps the settings we passed, and No
  starts normally. `PostMessage(WM_COMMAND, IDNO)`.
* **SteamStub can relaunch the game under a different pid** (referee, board 01:20), so filtering by
  our own pid alone misses the dialog. The nanny also adopts `CoDWaW*` processes that started **at
  or after** our spawn — and never one that started before it, so it cannot interfere with another
  agent's game (dev-box rule 4).
* **Every cross-process window call is the async form and time-boxed at 2 s.** A plain
  `SetWindowPos` blocks until the target's UI thread answers, and a game on a modal never answers;
  it hung a launcher for 703 s (foundation, board 01:00).

The player sees plain sentences, not the mechanism: *"World at War asked to change your graphics
settings; ENW answered No and kept yours."*

Parking windows off-screen is **dev-only** (`stealthLaunch`, or `play-cli.js --stealth`). A player
wants to see their game.

### The boot screen

`bootflow.js` is the state machine behind it: **Reserving server → Loading map → Ready → Launching
World at War → In game**, over map art. Each step is a real call:

* *Reserving* — `POST /admin/lease` to the site, which picks a box and mints an Ed25519 invite token
  bound to `(steamid, match_id)`. Verified against `infra/host-agent/mock-site` running locally.
* *Loading / Ready* — polls the host agent until the instance reports the map loaded.
* *Launching* — the spawn above.
* *In game* — the host confirms the connection.

**Anything that cannot be reached is marked `SIMULATED` in the UI, by name.** The boot screen says
which steps were not real rather than showing a green tick for a server that does not exist.

### Proving the launch without the game

Four agents contend for `game.lock` on this box and the game is the one thing this code does not
control, so `test/launch-harness.js` builds a fake game folder whose `CoDWaW.exe` is a copy of
`node.exe`, runs the **real** `GameLaunch` against it, and checks what the child actually received.
All eleven checks pass:

```
ok   the three arguments from the brief
ok   the account settings, applied over the top
ok   fs_homepath points at the ENW folder, with no space in it
ok   THE TOKEN IS NOT IN THE COMMAND LINE THE CHILD SEES
ok   the token IS delivered over the pipe
ok   the token is not in the environment either (pipe mode)
ok   SteamStub hints are set (a copied exe exits without them)
ok   game-link v0 environment is set
ok   the working directory is our game folder
ok   the game lock is released afterwards
ok   the token pipe is closed afterwards
```

It does **not** prove that the engine likes the arguments, that our `binkw32` proxy loads, or that
the map comes up. Those need the real exe and the lock.

It found three things worth recording:

1. **The first run was refused**, correctly: *"World at War is already running (process 25236).
   Close it first."* — the `__CoDWaW` marker named another agent's live game. The guard that stops a
   player launching a second instance is also what stopped this harness stepping on referee's
   capture. The harness now uses its own `LOCALAPPDATA`.
2. **`serveToken()` reported itself open forever.** It returned `{...state, …}`, so `closed` was
   frozen at `false` while `close()` updated the inner object. Harmless today, and exactly the kind
   of thing that later convinces someone a pipe has leaked. Now getters.
3. **Play Local would have passed both `+map` and `+connect`.** The engine would have loaded the
   local map and then left it for the server. Play Local is now its own path through the boot flow
   (`runLocal()`): no lease, no token, no `+connect`, relabelled steps ("Playing locally", "In game
   (untracked)"), because "Reserving server" is a lie on a game that runs on your own PC.

### The real launch: it reaches a playable zombies map

`node src/main/play-cli.js --map nazi_zombie_prototype --local --seconds 60 --stealth`, out of
`%LOCALAPPDATA%\ENWZombies\game`, with the game lock held. From our DLL's own log inside the game
(`logs/enw-31680.log`):

```
enw_t4 build Sep 20 2026 01:34:03
  dll : C:\Users\b\AppData\Local\ENWZombies\game\binkw32.dll
  exe : C:\Users\b\AppData\Local\ENWZombies\game\CoDWaW.exe
  cmd : …CoDWaW.exe +set fs_homepath …\ENWZombies\home +set com_introPlayed 1
        +set fs_game mods/enw … +map nazi_zombie_prototype
game-link: exe sha256 732900d158982c33e3121f0b86d22230be79839bbcbfe3bdfc1238f408a7d64d
steamstub: decrypted after 141 ms (66 polls)
components: post_init done (12 of 12 ok)
enw_t4: PER-FRAME TICK IS LIVE (27 frames)
```

and from the engine's own log:

```
------ Server Initialization ------
Server: nazi_zombie_prototype
Waited 281 msec for asset 'maps/nazi_zombie_prototype.d3dbsp' of type 'col_map_mp'
LOADING... maps/nazi_zombie_prototype.d3dbsp
G_WriteGame 'nazi_zombie_prototype-zombie_start' 'AUTOSAVE_LEVELSTART'
```

So the folder the launcher built runs, SteamStub is satisfied by it, the exe is byte-identical to
the verified one, our proxy DLL loads and all twelve components come up, the per-frame tick runs,
and **the game reaches a playable zombies level**. `AUTOSAVE_LEVELSTART` is the signal the boot
screen now uses for "In game" — not "Loading fastfile", which the engine emits a dozen times for
`code_post_gfx`, `ui`, `common` and friends long before any map exists.

Three tailing bugs stood between the launcher and seeing that for itself. They are all in the same
40 lines and all worth knowing for anything else that reads the engine's log:

1. **With `fs_game` set, the engine writes `console.log` under the MOD folder.**
   `<fs_homepath>\mods\enw\console.log` had 12,813 lines while `<fs_homepath>\main\console.log`
   was 0 bytes. `tools\dev\launch.ps1` reports `main\console.log`, so every run with a mod loaded
   is being watched at an empty file. We now watch both and take whichever grows.
2. **Never truncate it to get a clean read.** The engine has already opened it, so everything it
   writes afterwards lands past the truncation point and the file looks empty for the whole run.
3. **The engine truncates it itself, on every launch** (`logfile opened on ...` is always line 1).
   So remembering the previous run's length and reading forward skips the entire new run: a launch
   that really did reach `AUTOSAVE_LEVELSTART` at line 7,587 was reported as "no map yet", because
   7,587 lines was fewer bytes than the file had held before. A watched file that has **shrunk**
   has been rewritten -- reset to offset 0.

**No modal dialog appeared on either run.** Every unattended run the other agents describe sat on
"Set Optimal Settings?"; these did not, and reached a live frame tick in about six seconds. The
difference is most likely `+map <map>` on the command line, which skips the front end the box
belongs to. Worth confirming, because if it holds it is a cheaper answer than answering the dialog.
The nanny is still there and still needed for the paths that do go through the menu.

### The game lock

`gamelock.js` honours `ZombiesDev\locks\game.lock` exactly as `dev-box.md` rule 5 describes: takes
it, writes the pid once the game starts, releases it on exit, treats it as stale after 15 minutes or
a dead pid, and **only ever releases its own** (if another agent has taken it since, it is left
alone). On a machine with no `ZombiesDev` the whole thing is a no-op, which is the player case.

---

## 3b. The map library

`launcher/src/main/library.js`, `maps-cli.js`. Source today: the archive agent's 14 normalised maps
at `ZombiesDev\archive\mods\<bsp>\`, with titles from `archive/manifests/<bsp>.json` and the file
list + per-file SHA-256 from `ZombiesDev\archive\reports\extract.json`. In production this becomes a
download from the site; `install()` takes a source directory and a file list, so the shape does not
change.

```
node src/main/maps-cli.js list          # every map, with the title AND the bsp
node src/main/maps-cli.js install water # "Alcatraz"
node src/main/maps-cli.js installed
node src/main/maps-cli.js verify
node src/main/maps-cli.js remove water
```

**The bsp name is not the title**, and it is not close: `water` is *Alcatraz*,
`nazi_zombie_test` is *Project Viking*, `sanatorium` is *CLINIC OF EVIL*, `nazi_zombie_test1` is
*DESERT*. The rail shows the title with the bsp small underneath — the bsp still matters, because
it is what the folder and the original download are called and what someone searching will have
seen — but a player is never shown a bsp as a name.

Install is **verified, not hopeful**: every file is checked against the SHA-256 the archive
recorded, and a mismatch deletes the file and aborts rather than leaving a half-map. BO2 Hijacked:
12 files, 198 MB, 0.4 s, all hashes matched. **No executable is ever copied** — `.exe`, `.dll`,
`.bat` and friends are refused with a line in the manifest, not filtered quietly (dev-box rule 3).

Maps install straight to `<fs_homepath>\mods\<bsp>`, which is both the ENW library and the folder
the engine reads. There is no junction between them: an earlier version kept `ENW_ROOT\maps` and
linked each map into `mods\`, and a junction whose link *and* target were both inside our folder
resolved to nothing on this machine — `fsutil reparsepoint query` showed data identical to a working
junction, and the same junction with either end outside the folder was fine. Rather than ship
something resting on a behaviour I could not explain, the need for it is gone.

### The UTF-8 BOM that makes a map unplayable

**2 of the 14 maps cannot be launched as shipped**, and the error points somewhere else entirely.

`mod.arena` is the file that registers a custom map with the engine. `nazi_zombie_hijacked` and
`nazi_zombie_fear_mc_2` both ship it with a UTF-8 byte-order mark in front of the first `{`. T4's
info-file parser does not skip a BOM, so:

```
Missing { in info file
A mod is required for custom maps
Error: Can't find map "nazi_zombie_hijacked".
```

which reads like a missing fastfile and is not — the 53 MB `nazi_zombie_hijacked.ff` is right there.
`library.js` strips the BOM at install time: **after** the archive hash is verified, only on
`.arena`, recording both hashes and the reason in `.enw-installed.json`. The other 12 maps are
clean, so this is a per-map defect rather than a convention.

---

## 3c. The vertical slice: a local game, reported to the site

`launcher/test/slice.js` drives the launcher's own modules end to end. One run, game lock taken and
released:

```
1. signed in as 76561198126330106 · site protocol 0 · local games supported
2. Leviathan (bsp nazi_zombie_leviathan) by AwesomePieMan · 453 MB, 5 files, hashes known
3. installed to %LOCALAPPDATA%\Activision\CoDWaW\mods\nazi_zombie_leviathan, every hash checked
4. match l_21a50db2 — "Local game — untracked. No badges, no records and no XP."
   watch it at http://127.0.0.1:3200/live/l_21a50db2
5. World at War running (pid 5464)
     → "the server is bringing up nazi_zombie_leviathan"
     → "Waited 879 msec for asset 'maps/nazi_zombie_leviathan.d3dbsp' of type 'col_map_mp'"
     → IN GAME: "nazi_zombie_leviathan is up and playable"
6. relay live frames        BLOCKED (below)
7. the site's verdict       BLOCKED (below)
```

**Steps 1–5 are real**, and step 5 is the first time an archived custom map has played through our
stack.

### No box secret on a player's PC

Every site call in `siteapi.js` and `localrun.js` is authenticated by the **player's own session
cookie**, shared with the wrapped page. There is no second auth path, nothing for the launcher to
hold, and `x-match-secret` appears nowhere in `launcher/`. If it ever needs to, the design is
wrong: that header belongs to a game box, and a player's machine is not one. Everything through
the three local endpoints is stamped `self_reported` by the site, which is the correct default for
anything a player's own machine says about itself.

And the thing worth repeating, because it is counter-intuitive: **a local game's replay is valid
and is still not evidence.** On this dev box the local host agent *is* the pinned box, so every
signature check passes. The signature proves the recording is unedited; the **mode** decides
whether it counts, and the mode is `local`.

### What blocks steps 6 and 7

`infra/host-agent/host.js:301`:

```js
const g = this.byInstance.get(conn.instance)
if (!g) return log.warn(`hello from unknown instance ${conn.instance} — ignoring`)
```

Our game connects to the link port and says hello; the host agent only knows instances **it**
launched from a lease, so it ignores us and there is no referee, no summary and no replay.
Observed exactly once in its log: `hello from unknown instance local-nazi_zombie_leviathan —
ignoring`.

`--boot 1 --game --dry-run` does not work around it: `launch.ps1 -DryRun` returns immediately, so
the instance is reaped as `exit code=0 (unexpected)` → `server_crash` before our game can connect.

The fix belongs on the host side and is small — adopt a hello from an instance it did not launch,
behind a flag, building the `Game` from the hello's own `instance`/`role`. That is the shape Play
Local needs anyway: **on a player's PC the launcher owns the process and the host agent is just the
referee and replay writer running beside it**, which is the inverse of a game box. `launcher/` has
not touched `infra/host-agent/` (dev-box rule 10).

`localrun.js` implements the whole `/local/start` → `/local/live` → `/local/result` → verdict
sequence already; the relay simply has nothing to send yet.

---

## 4. The shell

`src/main/main.js` + `src/renderer/`. Electron 38, `contextIsolation` on, `nodeIntegration` off, one
preload (`src/preload/preload.cjs`) that is the entire API surface.

* **It wraps the site.** The site is a native `WebContentsView`; our chrome is a normal page around
  it. At startup the launcher probes, in order: `127.0.0.1:3200` (the `web/` agent's server),
  `:5173` (its Vite dev server), `:8099`, `:8080` (the mock site), `:8787` (the host agent's
  dashboard), and falls back to a bundled placeholder page that says so. Those ports were read out
  of `web/server/index.js` and `web/client/vite.config.js`, not guessed. Pin one in Settings or with
  `ENW_SITE_URL` — **no rebuild needed to point it anywhere.**
* **No overlay, ever.** B was emphatic, so the architecture makes it impossible rather than merely
  avoided: the boot screen and first-run wizard **hide** the site view and take the window; they
  never draw over it. Nothing is ever drawn over the game.
* **The corner card** is the rail's top card: map art, mode, the selected map, **Play**, **Play
  Local** (untracked) and a Verified/Custom toggle. Picking a map anywhere updates it.
* **Window + tray.** Closing minimises to the tray so invites still arrive; quit is from the tray
  menu.
* **Deep links.** `https://zombies.enw.gg/m/<map>` and `enwzombies://m/<map>` both parse to
  `{kind:'map', map}`; a second instance forwards its link to the running one and focuses the
  window. Registered with `setAsDefaultProtocolClient`.
* **Settings** are per account with a local fallback (`settings.js`), applied over the top at launch
  as `+set` dvars. The player's own WaW config is never edited — we run our own copy with our own
  `fs_homepath`. `syncFromSite()` is the seam for when the site has `/api/me/settings`.
* **Updates**, in the two lanes B described. Site refreshes go through an `IdleGate` that blocks
  while a game is running, while an install is running, or while the site says it is busy
  (`enw.setBusy()`), and fire at the next idle moment. App/DLL updates download in the background
  and are applied in `app.whenReady()` **before anything opens** — the only moment that is never
  mid-game and never mid-action. No update server exists in this build and `updateFeed` is `null`.
* **Crash reports** go silently to `crashEndpoint` (`tools/crash-sink.js`, 127.0.0.1:8791), with
  tokens, pipe names and key/value secrets redacted first, kept on disk and retried when the
  endpoint is down. The player gets one plain sentence and no ID.
* The wrapped page gets no permissions at all (camera, mic, notifications, geolocation are all
  denied) and external links open in the real browser.

---

## 5. What is real and what is faked

| | State |
|---|---|
| WaW detection, all Steam routes | **Real**, verified on B's PC |
| Validation (size, PE, 1.7, SteamStub, SHA-256) | **Real** |
| Forgiving browse fallback | **Real**, four wrong-folder cases corrected |
| Ownership signal | **Real** as far as a local Steam install can be; not a licence check |
| Install into the ENW folder, junctions, proxy DLL | **Real**, 7.7 MB, source verified unchanged |
| Uninstall, junction-safe | **Real**, tested |
| Command line + environment | **Real**, and checked against what a child process actually receives (`test/launch-harness.js`) |
| **Play Local, end to end** | **Real and proven**: the launcher's own game folder boots, our DLL loads, and the game reaches `AUTOSAVE_LEVELSTART` on `nazi_zombie_prototype` |
| Game lock, with a heartbeat | **Real**; re-asserted every 60 s so a multi-hour game is never mistaken for a stale 15-minute lock |
| Token over a named pipe | **Real launcher-side** (a real child read it back); the DLL does not read it yet |
| Dialog answering, SteamStub pid adoption | **Real** (ported from launch.ps1 + referee's fix) |
| Reserving a server + invite token | **Real** against `mock-site`; no production site exists |
| "Loading map" / "Ready" confirmations | **Real when a host agent answers** (verified against a live box), otherwise labelled SIMULATED in the UI |
| **Play (our server), end to end** | **Blocked, not faked.** Everything up to and including "Ready" is real. ~~the client cannot actually join because no WaW dedicated server accepts clients yet (dedi's Stage C)~~ — **updated 2026-09-22**: a WaW dedicated server *does* now accept a client and spawn it in (`dedi.md` §7h), but it stops about ten seconds later (`dedi.md` §7j), so there is still nothing a player could finish a run on. The box the launcher reserved runs `sim-instance.js`, which speaks the protocol but is not a game a client can connect to |
| Electron shell, tray, deep links, settings, idle-gated refresh | **Real** |
| Crash reporting | **Real**, to a local endpoint |
| Sign-in | ~~**Mocked.** It reads the SteamID this PC is signed into, so the ID is real; Steam OpenID needs the site and a secret we do not have locally~~ — **retracted 2026-09-22**: real Steam sign-in is built and switched on (`ZM_AUTH=steam`, no Steam Web API key needed), over a loopback redirect in the player's own browser. It did not work for B, and why is the new section at the end of this page. The mock remains as the labelled fallback |
| The map list in the rail | **Placeholder**, and labelled as one in the UI |
| Map art | **Placeholder** (gradient); comes from the site |
| Storage page (folder and per-map sizes) | **Real**; junctions are reported as links, not counted, so the ENW folder does not "weigh" the player's 12 GB install |
| Real map installs (14 maps, hash-verified) | **Real**; installs to the one folder WaW reads, refuses executables, repairs the BOM defect, never overwrites a map the player installed |
| **A real archived custom map, playable** | **Real**: Leviathan installs and reaches "up and playable" from the launcher |
| Local game opened on the site (`/local/start`) | **Real**, session-authenticated, stamped self-reported |
| Live frame relay + result + the site refusing to count it | **Written, unexercised** — the host agent ignores a hello from a game it did not launch (see §3c) |
| Map downloads over the network | **Not built** — installs copy from the archive on this box |
| Uninstall asks whether to keep maps | **Real** (a three-way dialog: keep maps / remove everything / cancel) |
| In-game toasts (badge, invite, friend moments) | **Not built** — they belong in the DLL |
| Party / ready check | **Not built** |
| Auto-update server, code signing, installer | **Deliberately not built** (overnight rules: no cloud, no publishing, no signing) |

---

## 6. Questions for B

In `questions.md`. The short version:

* **Q-launcher-1** — the launcher can only say "Steam has app 10090 registered for this account", not
  "this account owns it". A real ownership check needs a Steam Web API key and a site endpoint. Is
  the local signal enough for v1?
* **Q-launcher-2** — `%LOCALAPPDATA%\ENWZombies` holds the game copy *and* the map library, and the
  map library will be tens of GB. Should the map folder be separately configurable (a "move library"
  button), and should it default to the drive the game is on rather than C:?
* **Q-launcher-3** — the token transport (§3) needs a decision from whoever owns the client DLL, and
  it changes `docs/protocol/game-link-v0.md`.

---

## 7. Things that surprised me

* **The PE version resource is worth parsing properly.** "Is it 1.7?" could have been a filename or
  a file size; reading `VS_FIXEDFILEINFO` out of the resource directory is ~40 lines and turns a
  guess into a fact. The `.bind` section is the same kind of win: it is a one-line, unfakeable
  answer to "is this the Steam build", and it comes from the same parse.
* **The most dangerous code in this whole app is `uninstall`.** Everything else fails safe. A
  recursive delete through a junction deletes someone's 12 GB game install, silently, and looks like
  it worked. It has its own test and its own paranoia check.
* **`npm install electron` can "succeed" without an Electron binary.** The 136 MB zip downloaded
  into the cache and the extract left a 964 KB `dist/` containing only `locales/`, with no error and
  exit code 0 — `npm install` reported "added 70 packages in 7s". The failure only showed up as
  "Electron failed to install correctly" at first run. Fixed by extracting the cached zip by hand
  (§8). Worth knowing before anyone else loses twenty minutes to it.
* **Hiding the site view beats layering over it**, and it happens to be exactly what B asked for.
  A native child view cannot be covered by HTML in the parent page, so "no overlay, ever" turned a
  constraint into the simplest implementation.

## 8. If Electron will not start

Symptom: `Error: Electron failed to install correctly`. Cause: the postinstall downloaded the zip
but did not extract it.

```powershell
$dist = 'launcher\node_modules\electron\dist'
Remove-Item -Recurse -Force $dist; New-Item -ItemType Directory -Force $dist
Expand-Archive "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v38.8.6-win32-x64.zip" $dist -Force
'electron.exe' | Out-File -Encoding ascii -NoNewline 'launcher\node_modules\electron\path.txt'
```

---

## On sign-in — the loopback flow, and the two clocks that broke it (2026-09-22)

B installed the launcher, pressed **Sign in**, his default browser opened, and he could not
get in. This is what that flow is, hop by hop, and which hops were wrong.

### The hops

| # | Who | What | What can fail here |
|---|---|---|---|
| 0 | launcher | `GET <site>/auth/launcher/start` with **no parameters**, as a probe | a site without the route answers 404 and the launcher falls back to the mock. A 400 means "the route is there, you sent nothing" — which is the answer we want |
| 1 | launcher | binds `127.0.0.1:0`, invents `state` + a PKCE verifier | the OS handing us a privileged port (checked) |
| 2 | launcher | `shell.openExternal(<site>/auth/launcher/start?port&state&challenge)` | the browser never opening, and nothing telling the player so |
| 3 | site | validates the three values, writes `session.launcher`, `302 /auth/steam` | **the browser is on a different origin from `ZM_PUBLIC_URL`**, so the session it writes is in a jar Steam's return never reaches |
| 4 | site | `passport-steam` `302` to `steamcommunity.com`, `return_to` + `realm` built from `ZM_PUBLIC_URL` | a wrong or unset `ZM_PUBLIC_URL` |
| 5 | Steam | **the player signs in here, and nowhere else** | Steam Guard. This hop is a human with a phone and it is not fast |
| 6 | site | `GET /auth/steam/return`, assertion verified, user row ensured | an assertion that will not verify; the player cancelling |
| 7 | site | `finishLauncherFlow` mints a single-use code, `302 http://127.0.0.1:<port>/cb?code&state` | **the flow having expired**, in which case this did not fire at all |
| 8 | launcher | checks `state`, `POST /auth/launcher/exchange {code, verifier}` **through the Electron session** | the site refusing the code; the cookie landing in the wrong jar |
| 9 | site | checks `SHA-256(verifier)`, burns the code, sets `zm.sid` on that response | — |

Hops 3, 4, 6, 7 and 8 are all exempt from the closed-beta password gate
(`web/server/middleware/gate.js`), because Steam cannot type a password and neither can a
browser the launcher has just opened for the first time.

### What was actually wrong

**1. One clock was doing two jobs, and it was sized for the wrong one.** `LAUNCHER_CODE_TTL_MS`
was 120 seconds and it governed *both* the code (hop 7 → hop 8, machine to machine, over in
milliseconds) *and* the whole browser leg (hop 3 → hop 7, which contains **a person doing a
Steam Guard login**). Two minutes is routinely not enough for that. When it ran out,
`finishLauncherFlow` silently declined to fire and the return handler fell through to
`res.redirect('/')` — and `/` **is** gated, so the last thing the player saw after pressing
Sign in was the browser's password box. Meanwhile the launcher gave up at 125 s with
"Sign-in timed out". Neither end named the real reason because neither end knew it.

Now two clocks: `LAUNCHER_FLOW_TTL_MS` = 15 min for the human leg, `LAUNCHER_CODE_TTL_MS` =
120 s for the code, and `SIGNIN_WINDOW_MS` = 10 min in the launcher — **deliberately shorter
than the site's**, so the launcher is always the party that gives up first and the message
the player reads is ours.

**2. Pressing Sign in twice used to be refused** ("a sign-in is already open"). With a
ten-minute window that would have locked a player out of their own launcher for ten minutes
with nothing to press — and `shell.openExternal` can fail quietly, so "already open" is not
always true. A second press now abandons the first listener and opens a fresh flow.

**3. A launcher pointed at the wrong origin died silently.** `siteCandidates` tries
`https://zombies.enw.gg` first, but a pinned `ZM_SITE`, an old `config.siteUrl`, or a
fallback to `http://127.0.0.1:3200` all put hop 3 on an origin that is not `ZM_PUBLIC_URL` —
and hop 6 always lands on `ZM_PUBLIC_URL`, because that is what `return_to` is built from.
Different origin, different cookie jar, flow gone. The site now **moves the browser** to the
public origin's copy of `/auth/launcher/start` (built from config plus the three
already-validated values, with `moved=1` so it cannot loop).

### Rebuilt

`npm run pack` is the installer build (**not** `npm run dist`). Version bumped 0.1.0 → 0.1.1,
because electron-updater compares versions and a rebuild at the same version is invisible to
it. The installer is at `launcher/dist/ENW-Zombies-Launcher-Setup-0.1.1.exe`; the feed was
written to a scratch directory, **not** to `web/public/updates`, so nothing was pushed at
friends before the site half of the fix is live. `node tools/publish-update.js` publishes it
when B wants it.

### Not proven

Nobody signed in to Steam for real in this pass — that needs a password and this lane does
not type one. Hops 5 and 6 with a *genuine* Steam assertion remain unexercised; everything
either side of them is covered by `web/test/launcher-signin.js` (13 checks).

---

## The launch baseline — why B got 800x600 at 60 FPS, and what runs now (2026-09-22)

B launched World at War through the launcher and got **~60 FPS at about 800x600**: a worse game
than double-clicking it in Steam. This section is the cause, the fix, and the list of what the
launcher now sets and why.

### The cause, confirmed

Nothing was broken. **We simply never told the game anything about the display**, and the game's
own opinion is a 2008 one.

`settingsArgs` pushed `cg_fov`, `com_maxfps`, `r_fullscreen`, `r_mode` and the volume — and
`r_mode` defaulted to `''`, which the code called *"leave it to the game"*. Our copy runs with its
own `fs_homepath` (by design: B's Steam config is never read or written), so on a fresh profile
"the game" means the engine's built-in defaults:

| Evidence | Where |
|---|---|
| the image carries the literals `set r_mode 800x600` and `set r_fullscreen 0` | grepped out of `ZombiesDev\dumps\codwaw-1.7-a.exe`, the decrypted 1.7 image |
| the `config.cfg` on this box reads `seta r_mode "800x600"`, `seta r_displayRefresh "60 Hz"` | `%LOCALAPPDATA%\Activision\codwaw\players\profiles\anna-jpg\config.cfg`, written 2026-09-22 03:58 |
| `com_maxfps` defaults to **85** | PCGamingWiki, and the dvar table in `dedi.md` §7 reads `0x55` = 85 out of the image |
| "Sync Every Frame" (`r_vsync`) is **on**, and clamps the frame rate to the monitor's refresh | PCGamingWiki. 60 Hz panel → 60 FPS, whatever `com_maxfps` says |
| `cg_fov` defaults to **65** | PCGamingWiki |

So: 800x600 because `r_mode` was never passed; 60 FPS because `r_vsync` was never passed and the
panel is 60 Hz; and 65 FOV whenever the account had not set one. Three dvars we were not sending.

**Not proven from inside this lane**: nobody ran the game. Two other agents hold
`ZombiesDev\locks\game.lock`, so this is read-from-the-image-and-the-config-on-disk plus
`--dry-run`, and B does the launch. The one thing a launch will settle is whether `r_noborder`
(passed, absent from vanilla) plus the DLL really produces a borderless window.

### What the launcher produces now

`node src/main/play-cli.js --dry-run --window player --local`, on B's machine (2560x1440 main
display, a 1440x2560 portrait second display at `-1440,-340`):

```
disp: Display 1 2560x1440 at 0,0 (main)   <- chosen
disp: Display 2 1440x2560 at -1440,-340
mode: borderless at 2560x1440   (windowMode player)

"…\ENWZombies\game\CoDWaW.exe"
  +set fs_homepath …\ENWZombies\home
  +set com_introPlayed 1  +set fs_game mods/enw
  +set com_startupIntroPlayed 1  +set ui_autoContinue 1
  +set cl_allowDownload 0  +set logfile 2
  +set r_fullscreen 0  +set r_mode 2560x1440  +set r_aspectRatio auto
  +set r_noborder 1  +set vid_xpos 0  +set vid_ypos 0  +set r_monitor 0
  +set r_vsync 0  +set com_maxfps 250  +set cg_fov 80
  +set m_filter 0  +set cl_mouseAccel 0
  +set r_texFilterAnisoMin 16  +set r_texFilterAnisoMax 16
  +set r_picmip 0  +set r_picmip_bump 0  +set r_picmip_spec 0
  +set r_multiGpu 1  +set sm_enable 1
  +set cl_maxpackets 100  +set snaps 30  +set rate 25000
  +set snd_volume 1
  +map <map>   /   +connect <host>

env : … ENW_BORDERLESS=1
```

`ENW_BORDERLESS` is for the client lane's `borderless.cpp`, which takes either it or a
text-matched `+set r_noborder 1` and reads its geometry from the **last** `r_mode` / `vid_xpos` /
`vid_ypos` on the line. There is a test asserting `r_mode` appears exactly once and is never
followed by another.

**`windowMode 'small'` and `'offscreen'` are unchanged** — still 800x600, muted, and `offscreen`
still parks at `-4000,-4000`. They are the dev modes; a test asserts none of the baseline reaches
them, and neither the seed nor the read-back runs for them (a dev run must never put 800x600 into
a player's account).

### The bundled fixes

Every dvar below was **grepped out of the decrypted 1.7 image** before being used, so none of them
is a guess about what this exe has. `r_noborder` is the one exception: **zero occurrences**, which
is exactly what `client.md` §2c found, and it is passed anyway because an unknown `+set` is
harmless and it is the switch the DLL reads.

| Dvar | Value | Why | Source |
|---|---|---|---|
| `r_fullscreen` | `0` | Borderless/windowed. Spec §4.3 makes Borderless the default. | Plutonium T4 borderless recipe |
| `r_mode` | `<native WxH>` | **The 800x600.** A string, not an index (`client.md` §2b). Borderless always uses the chosen display's native size. | the image's own `set r_mode 800x600` |
| `r_noborder` | `1` | Borderless. Not a vanilla dvar — the DLL does the window style. | [Plutonium](https://plutonium.pw/docs/client/t4/perfect-borderless-window/) |
| `vid_xpos` / `vid_ypos` | `<display origin>` | So a borderless window lands on the **chosen** monitor, not always the primary at 0,0. | Plutonium, as above |
| `r_monitor` | `<index>` | The monitor picker, vanilla. | `client.md` §2c |
| `r_vsync` | `0` | **The 60 FPS.** Sync Every Frame caps the game at the panel's refresh. | [PCGW](https://www.pcgamingwiki.com/wiki/Call_of_Duty:_World_at_War) |
| `com_maxfps` | `250` | Stock cap is 85. Spec §4.5 cap is 250 — **the server still enforces allowed values** for a record game. | PCGW |
| `cg_fov` | `80` | Stock is 65; 80 is the top of the in-game slider. Spec §4.5 bounds it at 120. | PCGW |
| `r_aspectRatio` | `auto` | Picks the aspect from the resolution instead of stretching 16:9 into a 4:3 frame. | PCGW (widescreen) |
| `m_filter` | `0` | "Smooth Mouse" off. Keeps the DLL's raw-input fix meaningful. | PCGW (mouse acceleration) |
| `cl_mouseAccel` | `0` | PCGW's catch: the menu's Smooth Mouse toggle only writes `m_filter`; acceleration stays on unless this is set too. | PCGW |
| `r_texFilterAnisoMin` / `Max` | `16` | Stock max is 4x. Free on any modern GPU. | PCGW (anisotropic filtering) |
| `r_picmip` / `_bump` / `_spec` | `0` | Full-resolution textures, pinned so a "Set Optimal Settings?" pass cannot leave them downscaled. | PCGW |
| `r_multiGpu` | `1` | PCGW's named fix for *"stuttering on modern systems despite a locked frame rate"* — the menu calls it Dual Video Cards. | PCGW (stuttering) |
| `sm_enable` | `1` | Shadow maps, pinned at the stock value. | PCGW |
| `cl_maxpackets` | `100` | Stock 30 is a dial-up default. Netcode only; the server clamps what it will not take. | Plutonium T4 docs |
| `snaps` | `30` | Asks for 30 snapshots/s instead of 20. The server decides what it sends. | Plutonium T4 docs |
| `rate` | `25000` | The engine maximum, already the value on this box. | Plutonium T4 docs |

Intro skipping (`com_introPlayed`, `com_startupIntroPlayed`, `ui_autoContinue`) was already passed
and is PCGW's documented `config.cfg` fix for the same thing.

**Deliberately not bundled**, so nobody re-adds them by accident (the reasons are in
`gamecfg.js` beside the list):

* `r_aaSamples 16` — PCGW records an **alt-tab hang** caused by AA above 2x on this game. A default
  that can freeze a player's game is not a fix.
* `sys_smp_allowed 0` — PCGW's multi-core workaround; it disables the render thread and on most
  machines costs frames. An opt-in at most.
* `snd_force51` / `snd_force71` — only correct when auto-detection fails.
* `r_gamma` / `r_ignorehwgamma` — a colour-profile preference, not a fix.

Nothing in the table changes what the game **simulates**. There is a test that fails if a dvar
matching `g_ / sv_ / zombie / perk / player_ / jump_ / bg_ / ai_ / cg_gun / timescale` ever appears
in it. The only two things a records rule cares about — FPS cap and FOV — are the ones the spec
already bounds, and both are clamped (`<=250`, `<=120`).

### Needs the DLL or an exe edit — listed, not applied

| | Why it is not ours |
|---|---|
| Perfect borderless window | `r_noborder` has **zero** occurrences in the image. The DLL strips the window style (`client-dll/components/borderless.cpp`). |
| LAA / 4 GB flag | A PE header bit on a 32-bit exe. dev-box rule 1 (never modify the player's install), and spec §4.5 excludes it explicitly. |
| 25-day uptime timer | An engine millisecond-counter overflow. Code, not config. |
| Raised asset / memory limits | What T4M does: a loaded module, not a dvar. |
| The audio fix | PCGW's workaround is "delete `%LOCALAPPDATA%\Activision\CoDWaW\players` and let the game rebuild". That is the **player's** profile folder; we do not delete a player's files. Our own fresh profile gets the effect for free. |
| High-polling-rate mouse | Already built, in the DLL — `client.md` §1. |

### Seeding the home folder: `+set` alone leaves the menu lying

A command-line `+set` changes the running game and nothing else. Open Video in the game's own menu
and it still reads the 2008 defaults — and **the first thing the player changes writes those stale
values back over ours.** Spec §4.3 is explicit that the in-game settings menu keeps working, so the
menu has to agree with the launch.

`gamecfg.seedHome()` writes the baseline as a real `config.cfg` under our `fs_homepath`:

```
<fs_homepath>\players\profiles\enw\config.cfg     the profile config (path string at 0x883E64)
<fs_homepath>\players\profiles\active.txt         = "enw"   -- without this the engine loads a
                                                             different profile and never reads ours
<fs_homepath>\main\config.cfg                     the plain one beside it
<fs_homepath>\players\profiles\enw\.enw-baseline.json   what we wrote, and at which version
```

It runs on a **first launch** (no `config.cfg`) and whenever `BASELINE_VERSION` changes — so a fix
added later reaches players who already have a config — and **never otherwise**. Once the player
has a config, the game owns it and we only read.

### The round trip (spec §4.3)

After the game exits — *after*, because the engine writes the file on shutdown and anything read
earlier is the previous run's (`client.md` §2b) — `applyReadBack()` parses `config.cfg` and saves
`r_mode` / `r_fullscreen` / `r_noborder` / `cg_fov` / `com_maxfps` / `r_vsync` / `sensitivity` /
`snd_volume` / `cg_drawFPS` / `r_monitor` and the `bind` lines into the account. `main.js` listens
for `settings_readback` and calls `settings.set()`. So an in-game resolution change is what the
next launch uses, with nothing pressed twice.

Two rules, both tested:

1. **Only keys the game actually wrote come back.** An absent dvar is "no opinion", not "back to
   the default" — otherwise every launch would quietly reset the settings the player changed in
   the *launcher*.
2. **Borderless is not demoted to windowed every launch.** Borderless and windowed both write
   `r_fullscreen 0`, and vanilla has no `r_noborder` to tell them apart. If that is all we see and
   the account says borderless, borderless stands; if the DLL wrote `r_noborder 0`, the player
   really did pick windowed and we believe it.

### Settings, and the UI

`settings.js` gains `display` (`'primary'` or a display id), `mode`
(`borderless` | `fullscreen` | `windowed`), `resolution` (`WxH`, blank = the chosen display's
native size) and `vsync`, with `maxFps` raised to 250 — plus `validate()`, because these end up on
a command line the engine parses itself and `+set r_mode 1920 x 1080` is three arguments. The
legacy `fullscreen` flag is kept and derived from `mode`, and an account saved before Display
settings existed gets **borderless** rather than inheriting the old `fullscreen: true` default,
which was never a choice anyone made.

The Settings page now has Monitor, Window mode, Resolution (shown only when the mode is not
borderless), FOV, Max FPS, Vsync and Show FPS. It is the existing plain list of fields, not a new
screen.

`display.js` gets the monitor list from Electron's `screen` (injected by `main.js` after
`app.whenReady()`, so the module has no static Electron dependency), caches it to
`state/displays.json`, and for plain-node callers falls back to `tools/displays.ps1`
(`SetProcessDPIAware()` **first**, or a 4K display at 150% reports 2560x1440 and `r_mode` would be
a mode the game does not have). `ENW_NO_DISPLAY_PROBE=1` turns the PowerShell probe off, which is
what the unit tests set.

### What B should do

```powershell
cd launcher
npm test                                        # 77 checks, 0 failed
node src\main\play-cli.js --dry-run --window player --local     # read the line above back
```

Then launch for real from the app, on a map you know, and check three things:

1. the window is borderless at 2560x1440 and alt-tabs cleanly;
2. `/cg_drawFPS 1` (or Show FPS in Settings) reads well above 60;
3. change the resolution in the game's **own** Video menu, quit, and press Play again — it should
   come back at what you picked. `%LOCALAPPDATA%\ENWZombies\logs\launcher.log` has a `settings`
   line naming exactly which keys were saved.

If borderless does not happen, that is the DLL half (`ENW_BORDERLESS=1` is on the environment and
`+set r_noborder 1` on the line); everything else is launcher-side and independent of it.

### Still open

* The Display UI is the plain field list, not the designed one.
* Nobody has run the game with this line. The lock is held by two other agents.
* `r_displayRefresh` is left alone. The engine's format is the string `"60 Hz"`, and guessing a
  refresh rate is how you get a black screen; it is a candidate once someone has measured it.

---

## Party downloads, a joined launch, and 0.2.0 (2026-09-22, later)

Three things, and the first two are two halves of one failure: **a party could press Start
while somebody was still downloading, and when it did, only the leader's launcher launched.**

### 1. The party can see your download

`launcher/src/main/partyprogress.js`, posting to `POST /api/party/:id/progress` (the contract
is now written into [`../protocol/launcher-v0.md`](../protocol/launcher-v0.md) §2; the site
half is `web/server/lib/partyProgress.js`, which the web lane landed tonight).

What is sent, and when:

| | |
|---|---|
| body | `{ map, bytes, total, state }`, plus `error` on a failure |
| `downloading` | about **1 Hz** while bytes are arriving. The site's floor is 400 ms per member and it *accepts and drops* anything faster rather than refusing it, so the launcher never has to care what the ceiling is |
| `installed` | once, **when the hash check has passed** — it is sent from the success path of `library.install` / `installFromSite`, and both of those throw rather than return when a file does not match the SHA-256 the archive recorded. So "installed" cannot mean "the bytes stopped arriving" |
| `failed` | once, with the reason, on a broken download, a hash mismatch **or** no source for the map at all. From the leader's side "this member cannot get the map" and "this member's download broke" are the same fact: do not press Start |
| auth | the ordinary session cookie the launcher already shares with the wrapped page. No second auth path |

**And nothing at all is sent when the player is not in a party game.** The gate is one
function — `partyprogress.attach(api, play, bsp)` — and it needs the *site* to say both that
there is a party and that this is the map that party staged. A library install, a Play Local
game, or a download of a different map never constructs a reporter, so not one request leaves
the machine. Two tests assert that, one per half.

Every post is fire-and-forget. A 4xx, a restarted site or a dead tunnel in the middle of a
600 MB download must not take the download with it; the worst case is a bar that stops moving,
and there is a test that hangs up on every request and asserts the download survives it.

### 2. Somebody else's Start is your launch

`POST /api/launcher/play` means *"I am pressing Play"*, and the site only lets the leader do
it. A member has nothing to ask for: by the time they could, the site has leased the box and
minted one invite token per whitelisted SteamID, and **that player's own token is already in
their `GET /api/launcher/play` body**.

So `BootFlow` gains a **follow mode**: skip the POST, go straight to the watching half. From
there it is the path that already existed — the same 1 Hz poll, the same boot screen steps, the
same `+connect <host>`, and the same one-shot named pipe carrying the token (§3; still never on
the command line).

What starts it is one poll of `/api/launcher/play` running whenever a site is connected
(`main.js`, `state.startPartyWatch`), doing both jobs:

1. the leader staged a map → start downloading it **now**, while the party forms, and report
   it (§1 above) so the panel has a bar to draw and Start has something to stand down for;
2. a `match` appeared for a party we are in → open the boot screen and follow it.

It is deliberately **not** "non-leaders only". A leader who presses Start in the wrapped page
rather than the launcher's corner card is in exactly the same position as everybody else: no
flow running, a match waiting. The guard is `state.flow`, so the player who pressed Play *in
the launcher* is never followed into a second launch.

The boot screen gains **one line**, `Downloading the map`, and it is drawn only when it
happened — a permanently greyed row on every launch that had the map already is noise. A map
that did not install is never launched: the `download` step fails and `launching` is never
reached (tested). The install is shared, not repeated: `ensureMapInstalled` hands a second
caller the in-flight promise, so the boot flow waits for the download the party watcher
started rather than opening a second copy into the same folder.

### 3. A new installer, with tonight's client DLL

```powershell
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 -Name launcher   # the FULL build
cd launcher
npm run pack            # NOT `npm run dist`, which does not exist
```

`build.ps1 -Name launcher` with **no `-CoreOnly`** is the player client: `-CoreOnly` turns off
`ENW_WITH_SERVER_COMPONENTS` *and* `ENW_WITH_CLIENT_COMPONENTS` (foundation §1), so it would
have shipped a DLL with neither the mouse fix nor borderless in it. The build log names
`mouse_polling.cpp` and `borderless.cpp` among the compiled files, and both strings are in the
binary.

| | |
|---|---|
| DLL | `build\launcher\enw_t4.dll`, RelWithDebInfo, Win32, 1,472,000 bytes, built 2026-09-22 03:39 UTC |
| **sha256** | `24b3bf94411da497813a4addef3ef50192fbfb7d1a6bb5ff9ce9f002284aea90` |
| staged to | `launcher\resources\client\enw_t4.dll` + `client.json` (by `tools/stage-client.js`, which refuses to build without one) |
| in the installer | `dist\win-unpacked\resources\client\enw_t4.dll`, same sha256 — checked, not assumed |
| installer | **`launcher\dist\ENW-Zombies-Launcher-Setup-0.2.0.exe`**, 94,479,989 bytes |

"Install the ENW client" needed **no change** to find it: `setup.findClientDll()` already
prefers the copy shipped beside the app (`process.resourcesPath\client`, outside `app.asar`)
outright, and in a dev checkout prefers `build/launcher` over the other agents' builds. Staging
is the whole of the wiring.

**The components the DLL registers — 39**, by where they live:

* **`shared/core` (12)** — `connect_address`, `direct_connect`, `focus_guard`, `frame_dispatch`,
  `heartbeat`, `hello`, `huffman_guard`, `instance_paths`, `main_thread`, `no_winconsole`,
  `raw_sockets`, `userinfo_guard`
* **`client-dll/components` (5)** — `auth_token`, **`borderless`**, `connect_local`,
  **`mouse_polling`**, `network` — the two in bold are tonight's
* **`server/components` (22)** — `afk`, `chat`, `dedicated`, `dedi_error_trap`,
  `dedi_frame_pacing`, `dedi_join_in_progress`, `dedi_join_probe`, `dedi_local_client`,
  `dedi_no_autosave`, `dedi_nonblocking_pump`, `dedi_nowindows`, `dedi_probe_calls`,
  `dedi_server_auth`, `dedi_temp_guard`, `dedi_varprobe`, `dedi_varwatch`, `dedi_whereis`,
  `knobs`, `net`, `pause`, `referee`, `replay`

**That is the registered list, not the logged one**, and the difference matters: 12 of the 39
override `is_supported()` and drop out at load. `mouse_polling` is `!is_dedicated_process()`,
and most of the `dedi_*` ones are the mirror of that, so the `enw_t4 online - N components`
line a *player* prints will be smaller than 39. Nobody ran the game from this lane (the game
lock is held elsewhere), so the exact N is unproven — read it off `console.log` after the first
real launch and correct this line in place.

### Tests

```
npm test         85 passed, 0 failed    (77 before; 8 new — 5 progress, 3 joined launch)
npm run smoke    9 of 10 ok
```

The one smoke failure is the sandbox check, and it is the check working: this agent runs in an
MSIX container where `%LOCALAPPDATA%` is redirected, so **nothing here may claim an install is
verified**. The `setup: the ENW client is installed` line in that run is the *redirected* copy
and still reports the 1,408,000-byte 0.1.1 DLL. B's own install is untouched and picks up the
new one from the 0.2.0 installer.

### Still open

* Nobody has run 0.2.0's installer, and no real party has run the two features above. The
  tests drive `BootFlow` and the reporter against fakes — no site, no game, nothing downloaded.
  The thing to watch on the first real party game is whether a member's poll sees
  `match.connect` before the leader's game is already loading.
* ~~The feed went to a scratch directory, not to `web/public/updates`.~~ **Superseded at
  05:05: B said publish.** `node tools/publish-update.js` wrote `latest.yml`, the exe and its
  blockmap into `web/public/updates`, so the site serves the installer at
  **`/updates/ENW-Zombies-Launcher-Setup-0.2.0.exe`** (sha256
  `71f55c9ec70a2641e2dcef5aaa7ed7abe25735fe210aa139fe8b0962a35745f3`, 94,479,989 B, identical to
  the one in `launcher\dist`). The feed's sha512 was checked against the served bytes, and
  electron-updater's own `semver` says 0.1.0 and 0.1.1 both see 0.2.0 as an update and 0.2.0
  does not. **The site was not restarted** — the web lane's restart picks the files up. All three
  files are gitignored, so there is nothing to commit for it.
* The launcher posts progress but never *reads* the party's other bars — the panel in the
  wrapped page is where a player sees them, which is the right place and is the web lane's.

---

## Three things B reported at 05:00, and what each one actually was (2026-09-22, overnight)

B, in order: *"the maps won't download when I click download"*, *"when I'm in the game there's
stuttery performance"*, and — on tonight's 0.2.0 build — the game comes up **windowed at native
size, with a frame**. The stutter is the client lane's and lives in [`client.md`](client.md) §1e.
The other two are here, and **neither was the feature being broken**. One was a predicate that
disagreed with itself; the other was a file that was never copied.

### 1. The download button that refused, every time

The chain is wired end to end and always was:

| link | where | verdict |
|---|---|---|
| the button | `src/renderer/shell.js:155` → `installSelected()` → `shell.js:189` | wired |
| preload | `src/preload/preload.cjs:43`, channel `enw:installMap` | wired |
| main | `src/main/main.js:538` `handle('installMap', …)` | wired |
| install | `library.installFromSite()` | **threw before fetching a byte** |
| the site | `GET /api/maps/:key/files` → **200**, `install_known:true`, sha256 per file | fine |
| auth | the beta Basic password only; **no session needed to download** | fine |

Measured against the live site, signed out: `/api/launcher/hello` → 200 with
`"map_downloads":true`, `/api/maps/nazi_zombie_school/files` → 200 with 6 files and a
`size_bytes` of 542,515,575, and a `Range: bytes=0-102399` on `mod.ff` → **206**. So there is
nothing for the web lane to fix, and the Steam-only sign-in leg (`web.md` §9) is a genuinely
separate bug — it is not this one.

What threw:

```
ABANDONED SCHOOL is already in your own World at War mods folder and ENW did not put it
there. Leaving it alone.                                        library.js:210
```

for **8 of the 10 maps that drew an Install button**. `isInstalled()` and `ownership()` did not
agree about the same folder. `isInstalled()` wants the record file; `ownership()` called anything
without a record `theirs` — and `%LOCALAPPDATA%\Activision\CoDWaW\mods` on this box holds:

* **seven symlinks into our own dev archive** (`mw2rust`, `nazi_zombie_derberg`,
  `nazi_zombie_fear_mc_2`, `nazi_zombie_orbit`, `nazi_zombie_school`, `sanatorium`,
  `ugx_artemovsk`), made by ENW's earlier dev tooling on 2026-09-21;
* **one empty directory** (`nazi_zombie_octogonal`, zero files).

So the UI drew *Install (543 MB)*, enabled it, and the main process refused it. Every time. A
guaranteed dead end, and the reason it shipped is that nothing covers `installFromSite` — the two
suites that look like they would (*Party download progress*, *Following somebody else pressing
Start*) both stub the install.

**Fixed in `ownership()`**: a folder is `theirs` only when it is a real directory with real files
in it. An empty folder is `absent`. A symlink that resolves inside `ZombiesDev\archive` is ours,
not the player's — and `installFromSite` **unlinks it before installing**, because writing through
it would put the download inside the archive that supplies the very SHA-256s this installer checks
against. Unlinking a symlink deletes the link, never the target.

**The guard that matters is untouched.** B's own `nazi_zombie_ali` is a real directory with 10
real files and no record; it still reports `theirs` and the installer still refuses it.

**Proven, not argued** — a map that could not be installed an hour ago:

```
ownership before: {"state":"absent","reason":"a symlink into ENW’s own dev archive",
                   "link":"C:\Users\b\ZombiesDev\archive\mods\mw2rust"}
INSTALLED: mw2rust  10 files, 308.4 MB, verified= true
isInstalled now: true   ownership: ours
```

`verified: true` means every one of the ten files matched the SHA-256 the archive recorded —
`installFromSite` throws rather than returns on a mismatch. The archive still has its own 10 files,
so nothing was written through the link.

### 2. "Windowed at native size" was an 0.1.x client in an 0.2.0 launcher

The launcher was doing its half perfectly. `play-cli --dry-run` and the game's own recorded command
line both carry `+set r_noborder 1 +set r_mode 2560x1440 +set vid_xpos 0 +set vid_ypos 0` and
`ENW_BORDERLESS=1` is on the child environment. The DLL that reads them was not there.

From B's own game log, `enw-34116.log`, 04:54:

```
enw_t4 build Sep 21 2026 16:18:51
components registered: 28
```

and **not one `borderless:` line in the whole file**. Tonight's client registers 40 and prints one.
The hashes say the rest:

| | |
|---|---|
| `<ENW>\game\binkw32.dll` | `a60d53bb…`, 1,408,000 B, built Sep 21 16:18 — **28 components** |
| `resources\client\enw_t4.dll` (0.2.0) | `24b3bf94…`, 1,472,000 B, built Sep 22 03:39 — 39 components |

**`status().installed` is three `existsSync` calls.** That is the right test for *has setup ever
run* and the wrong test for *is the installed client the one this launcher ships*. An update
replaces the DLL beside the app and nothing ever copies it into the game folder, the UI said
"installed", so nobody re-ran setup — and both of 0.2.0's client features simply were not present.
Borderless and the raw-mouse fix were never broken; they were never loaded.

`setup.ensureClientDll()` compares the two hashes and repairs it. One file copy, written beside and
renamed (a truncated `binkw32.dll` means the exe does not start at all), read back afterwards.
`binkw32_org.dll` — the player's real Bink library — is not touched, read or re-derived, so the
repair cannot reach the stock install. It is deliberately **not** a full `install()`: pressing Play
should not rebuild the folder. `status().clientDll.stale` now says so for the UI, and `startPlay()`
repairs it before every launch, with a toast when it actually copied.

86 tests pass (85 before). The new one asserts the proxy afterwards **is** the shipped hash read
back off disk, that the stock Bink library is byte-identical afterwards, that a second call copies
nothing, that no `.new` file is left behind, and that with nothing installed it refuses rather than
half-creating a game folder.

### 3. `play-cli --hold`

`--seconds` was only ever an upper bound: `flow.run()` resolves the moment the map is playable and
the old code called `stop()` there and then, so the game died about two seconds after `post_init`.
The first stutter run of the night produced a log with **zero frames in it** for exactly that
reason. `--hold` stays in the map until the window elapses, which is what makes the launch path
measurable at all.


### 4. Play to in-map, timed — and there is nothing left to kill

Five real launches tonight through `play-cli --window player --local --hold`, on
`nazi_zombie_prototype`. The clock below is the DLL's own log, which opens as the exe starts:

| from exe start | event |
|---|---|
| +0.00 s | `enw_t4 log opened`, **41 components registered** |
| +0.03 s | dvar system up (`logfile` exists) |
| +0.36 s | engine fully up (`sys_gpu` exists) |
| +0.41 s | `enw_t4: ready` — **30 of 41 online** (11 drop out on `is_supported()`, mostly the `dedi_*` ones) |
| +2.47 s | `referee: map_loaded map=nazi_zombie_prototype` |
| +2.59 s | `borderless: … window rect 2560x1440 at (0,0) … BORDERLESS` |
| **+3.05 s** | **`referee: ROUND 1` — in the map, playable** |

Three runs agree to within a few hundred milliseconds (3.05 s, 3.41 s, 4.05 s; the spread is the
`Waited 311–327 msec for asset 'maps/nazi_zombie_prototype.d3dbsp'` line and normal disk variance).
The launcher's own steps before the spawn — lock, local-run prep, boot flow — are all local and
complete without a measurable wait for a Local game: the boot screen prints
`Playing locally` → `Map` → `Ready` → `Launching World at War` with no gap, and the game lock is
stamped with the pid in the same second the log opens.

**So Play to in-map is about three and a half seconds**, and that is with our full baseline command
line, a custom `fs_homepath`, SteamStub decrypting (125 ms on this box) and the client DLL doing
its component bring-up.

**Dialogs: zero.** Every one of tonight's runs printed no `Windows dialogs answered` section at all
— `tools/window-nanny.ps1` had nothing to answer, and `__CoDWaW` is cleared before each launch so
the crash-marker prompt never appears. There is no double-prompt and no pause left on this path to
remove.

One caveat worth keeping: **`--hold` is what makes any of this measurable.** Without it the CLI
stops the game the instant `flow.run()` resolves, which is about two seconds after `post_init`.

