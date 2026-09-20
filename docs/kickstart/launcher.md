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
  <the account's settings: cg_fov, com_maxfps, r_fullscreen, …>
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
| **Play (our server), end to end** | **Blocked, not faked.** Everything up to and including "Ready" is real; the client cannot actually join because no WaW dedicated server accepts clients yet (dedi's Stage C). The box the launcher reserved runs `sim-instance.js`, which speaks the protocol but is not a game a client can connect to |
| Electron shell, tray, deep links, settings, idle-gated refresh | **Real** |
| Crash reporting | **Real**, to a local endpoint |
| Sign-in | **Mocked.** It reads the SteamID this PC is signed into, so the ID is real; Steam OpenID needs the site and a secret we do not have locally |
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
