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


### 0.2.1: tonight's client, published (2026-09-22, 05:40)

0.2.0 shipped a DLL that predates `20e47ed`, `4803fbb`, `e7bd955`, `78534c6` and `81c80d5` — the
map-install ownership fix, `setup.ensureClientDll()`'s hash-repair on every Play, the `frametime`
histogram, the raw-mouse fixes (plus opt-in `ENW_RAW_MOUSE_NOLEGACY`) and borderless reading
`rcMonitor`. Rebuilt with the full `build.ps1 -Name launcher` (no `-CoreOnly`, which would drop
`client-dll/` along with `server/`): **`enw_t4.dll` 1,501,184 B, sha256
`40a9d77434fa230f02311358c2d03d70bc42012a88f9c19bedd4fbb499e6e7ca`** — the hash the client lane
predicted, to the byte. **42** components register now (12 core, 24 server, 6 client-dll — the new
one is `frametime`); the client lane's own run read *30 of 41 online*, so expect 31 of 42 on a
player, and that line, not this one, is the evidence.

`npm test` 86 passed / 0 failed. `npm run smoke` 9 of 10 — the one failure is still the MSIX
sandbox check doing its job, so no install claim from this lane is evidence. Installer
**`launcher\dist\ENW-Zombies-Launcher-Setup-0.2.1.exe`**, 94,490,882 B, sha256
`42387a8580eba0f45e0a087ab4a2bd53a7a706a520d0c30e0f278ae5b2683344`, with that DLL verified inside
`win-unpacked\resources\client\`.

Published to `web/public/updates` (the only thing this lane writes under `web/`, and only through
`tools/publish-update.js`). **The site was not restarted.** Checked against the running site on
127.0.0.1:3200 rather than assumed:

* `GET /updates/latest.yml` → `200`, `Content-Type: text/yaml`, `version: 0.2.1` — not the React
  catch-all answering 200 with `text/html`, which is the failure this check exists for;
* `GET /updates/ENW-Zombies-Launcher-Setup-0.2.1.exe` with `Range: bytes=0-1023` → **`206 Partial
  Content`**, `Content-Range: bytes 0-1023/94490882`, and the bytes start `MZ`. That is what
  electron-updater's differential download needs;
* the feed's `sha512` recomputed from the served file matches;
* electron-updater's own `semver`: 0.1.1 → update, **0.2.0 → update**, 0.2.1 → no update.

The exe, its blockmap and `latest.yml` are all gitignored, so none of it is in a commit.

---

## The 4 GB patch: asked for, built, and REFUSED BY THE GAME (2026-09-23)

B's decision this morning was to apply the community's "4 GB patch" â€” the
`IMAGE_FILE_LARGE_ADDRESS_AWARE` bit in the PE `FileHeader.Characteristics` â€” to **our own game
copy only**, never to his Steam install, so that the big custom maps (ORBiT, UGX Requiem) stop
running the client out of address space in `CL_InitCGame` (dedi.md Â§14.7).

**It does not work, and the reason is measured rather than argued.** The spec's item 2 was "prove
SteamStub still decrypts a flagged exe; do not assume". It does not.

### The control, and the flagged run

One dev copy (`waw-c1`), one DLL, one map, **two bytes the only difference**:

```
laaON   Characteristics 0x0123   dialog answered: 'Steam Error' >> Cancel
                                 msg: Application load error 3:0000065432
                                 the server EXITED before it answered
                                 alive=False  getstatus=False
laaOFF  Characteristics 0x0103   alive=True  getstatus=True
                                 com_frameTime +15,016 ms over 4 probes
```

and from our own DLL log of the flagged run, which opens as the exe starts and outlives it by a
quarter of a second:

```
steamstub: image base 00400000, .text 00401000+3E99FF, first dword 9EF490B8, .bind present
=== enw_t4 log closed ===            (250 ms after it opened)
```

`9EF490B8` is the encrypted first dword. **The stub never decrypted anything**; it refused the
image and exited. The reasoning that led to the decision is still correct as far as it goes â€” the
flag is in the PE file header, outside the `.bind`-wrapped image, and the loader must read that
header before the stub's entry point can run â€” but SteamStub *verifies the file it wraps*, and two
bytes is enough to fail it. Working around that check means defeating the DRM, which is vault
rule 7 and out of the question.

The first real evidence was `join91`: ORBiT, flagged client, and the client was `GONE` at t=5 s for
the whole 300 s watch. Read next to `join90` (the same run, unflagged) it is unambiguous.

### The measurements the flag was supposed to fix, taken anyway

| run | map | flag | client |
|---|---|---|---|
| `join90` | ORBiT (`nazi_zombie_orbit`) | off | reaches **1,623 MB RSS** and stops â€” CPU flat from tâ‰ˆ25 s, no `CS_ACTIVE`, no `ROUND 1`, dropped to `CS_ZOMBIE` |
| `join91` | ORBiT | **on** | **never starts at all** â€” Steam Error, process gone by t=5 s |

Server side both runs were perfect and identical to `join80`: gates 2â€“5 pass, 59 Hz,
`com_frameTime` +30,013 ms, 351 MB flat. It was never the server. It is still the client, and the
32-bit ceiling is still the reason â€” the fix for it is not this.

UGX Requiem (`ugx_artemovsk`) was **not run flagged**: with ORBiT's answer in hand a second Steam
Error proves nothing new and costs 5 minutes of the shared game lock. Its unflagged behaviour is
`join81`'s, unchanged.

### What shipped instead

The code is in, tested, reversible â€” and **refuses itself on a Steam-protected exe**, by name:

* `src/main/pe.js` gains `characteristics(file)` and `setLargeAddressAware(file, on)`. Two bytes at
  `PE + 22`, idempotent (a matching bit writes nothing), and **always read back off disk**, with a
  throw if they are not what was written. A test asserts that the rest of the file is byte-identical
  afterwards â€” a 4 GB patch that rewrites a byte of `.text` is a corrupt game exe that only fails at
  launch.
* `setup.ensureLargeAddressAware()` writes the **original** `Characteristics` and the exe's sha256
  into `state\exe-patch.json` *before* the first write and never overwrites that record with a
  patched value, so `restoreGameExe()` can put the header back exactly. `assertWritable()` polices
  the path, so it can only ever touch `<ENW>\game\CoDWaW.exe`.
* â€¦and before any of that, it reads the section table: **`.bind` present â†’ refuse**, with the
  sentence above and `skipped: 'steamstub'`. Setup reports that as an answer, not a failed step.
  `ENW_LAA_FORCE=1` overrides it for an exe that is not stubbed.
* Settings has **4 GB memory for big maps**, on by default; turning it off calls `restoreGameExe()`.
  On B's machine it will report the SteamStub refusal, which is the honest thing for it to say.

So the launcher's answer to "can we give the client 4 GB" is now a measured *no, not on a Steam
copy*, in one place, with the machinery ready for a copy that is not one. The `Needs the DLL or an
exe edit â€” listed, not applied` table's LAA row stands; only its *reason* changes, from "rule 1 and
spec Â§4.5" to "rule 1, and the game refuses it anyway".

---

## Nothing of ours in the player's World at War folder (2026-09-23)

B, this morning, ahead of everything else: **"our client must never touch the user's own World at
War data."** Steam-launched vanilla WaW must see nothing of ours, and everything we add â€” maps,
config, saves, our DLL â€” lives under `%LOCALAPPDATA%\ENWZombies\` only.

Two things were violating that, and they were the same thing:

1. **map installs went into `%LOCALAPPDATA%\Activision\CoDWaW\mods\`** â€” the player's folder. That
   is why vanilla World at War's Mods menu listed ENW's maps, and it is the folder behind the
   *"already in your own World at War mods folder"* refusal B hit on 8 of 10 Install buttons.
2. `fs_homepath` moves `main/` and nothing else, so the **profile, `config.cfg`, saves, the
   `__CoDWaW` marker and the engine's own map-exists check** all resolved into the player's folder
   too (dedi.md Â§14's `fs_localAppData` finding).

### The fix is one hook, and it is the client DLL's

`client-dll/components/enw_localappdata.cpp` (new; written up in
[`client.md`](client.md) Â§4) patches the engine's `SHGetFolderPathA` **import** and returns
`ENW_LOCALAPPDATA` for the AppData CSIDLs. The engine then builds `players`, `mods`, `__CoDWaW` and
its map-exists path under our folder by itself. It is an IAT patch installed at `post_load`, before
SteamStub decrypts anything, because the profile path is resolved during very early init. Setting
the `LOCALAPPDATA` *environment variable* does nothing â€” the dedi lane measured that.

### The launcher half

| | |
|---|---|
| `paths.js` | new `P.localAppData` = `<ENW>\home\localappdata`; **`P.maps` moved** to `<P.localAppData>\Activision\CoDWaW\mods`; new `P.userGameData` naming the player's folder |
| `paths.js` | **the write-guard carve-out is gone.** `assertWritable()` used to allow the player's mods folder as the one exception to "everything under ENW_ROOT". There is no exception now, and the player's `Activision\CoDWaW` is additionally refused *by name* so this cannot be re-introduced by repointing `P.maps` |
| `launch.js` | every launch passes `ENW_LOCALAPPDATA`; the `__CoDWaW` crash-marker clean-up and the `safemode.cfg` sweep now look in **our** folder â€” the player's marker is never read and never deleted, because its pid is not ours to judge |
| `library.js` | `installDir()` follows `P.maps`, so installs land in our tree. The *"already in your own World at War mods folder"* throw is **deleted**: there is no shared folder left to collide in |
| `setup.js` | `install()` creates the tree and says so in its own step; `uninstall({keepMaps})` now skips the child that *contains* the library rather than one that *is* it (the old equality test would have deleted the maps it promised to keep) |
| `shell.js` | the "What setting up will change" list says it in the player's words |

### Proof

One real Play Local, through `play-cli.js --window player --hold` â€” the shipped path, not a stub â€”
on a custom map (`nazi_zombie_fear_mc_2`, installed through the launcher's own map library), with
the player's **whole `%LOCALAPPDATA%\Activision\CoDWaW` tree hashed before and after**: every file's
path, size, mtime and SHA-256, every directory, and every junction recorded as a link and *not*
followed (following one would hash our own archive and hide the thing being tested).

```
85 entries -> user-before.txt
[done] In game (untracked)   the map is loading on your PC: gumball is up and playable
85 entries -> user-after.txt
=== user data diff ===
IDENTICAL - the player's own Activision\CoDWaW tree is byte-for-byte unchanged
```

And the other half â€” that our session found its map and wrote its own config â€” from the DLL's log
(`enw-39728.log`) and from disk:

```
components registered: 46
enw_localappdata: LocalAppData redirected to 'C:\Users\b\AppData\Local\ENWZombies\home\localappdata'
steamstub: decrypted after 172 ms (89 polls); 0x401000 = 55 8B EC 83 E4 F8 ...
enw_localappdata: SHGetFolderPathA redirected 2 time(s) -> '...\home\localappdata'

<ENW>\home\localappdata\Activision\CoDWaW\mods\nazi_zombie_fear_mc_2     <- the map
<ENW>\home\localappdata\Activision\CoDWaW\players\profiles               <- the profile
<ENW>\home\localappdata\Activision\CoDWaW\__CoDWaW                       <- the marker
```

`redirected 2 time(s)` is the number that matters: the component warns loudly at zero precisely
because a redirect that silently did not happen looks identical to one that worked. The three paths
under our folder were created **by the engine**, not by us.

Note the `steamstub: decrypted after 172 ms` line in the same run. That is the LAA section's control
restated: an **unmodified** exe decrypts normally with all of this in place.

### The dev harness is deliberately NOT switched over yet

`tools/dev/mapmount.ps1` and `tools/dev/launch.ps1` take the same redirect behind one switch,
`ENW_USE_PRIVATE_LOCALAPPDATA=1`, and **default to today's behaviour**. That is not caution, it is
a fact: the redirect lives in a client-dll component, and the DLLs in the dev copies (`build\dedi`,
`build\vps`) were built before that component existed. Pointing the mount at a folder the running
DLL does not redirect to makes every custom-map run fail with `Can't find map` â€” and the dedi/referee
lane was mid-session while this landed. Flip the switch once those copies carry a DLL built on or
after 2026-09-23; nothing else has to change.

---

## The four `flag_wait` maps: the error IS fatal, in normal play (2026-09-23)

The open question in `dedi.md` Â§14.2 was whether Zombie Desert, Project Viking, MW2 Rust and
Clinic of Evil's `flag_wait`-before-`flag_init` error is fatal *in normal play* â€” a T4 GSC
**runtime** error normally kills only the thread it happened on, and the community plays these
maps, so the suspicion was that something in our dedicated path (`logfile 2`, `developer_script`,
an assert promotion) was turning a survivable error into a stop.

**It is not ours, and it is not survivable.** Zombie Desert (`nazi_zombie_test1`), installed
through the launcher's own map library and played through the shipped path â€”
`play-cli --local --window player --hold`, a **plain windowed listen game** on B's display, no
dedicated server anywhere in the process:

```
******* script runtime error *******
undefined is not an array, string, or vector: (file 'common_scripts/utility.gsc', line 463)
 while( !level.flag[ msg ] )
(file 'maps/zombie_hitmarker.gsc', line 38)   flag_wait( "all_players_connected" );
(file 'maps/nazi_zombie_test1.gsc', line 136) thread maps\zombie_hitmarker::main();
(file 'maps/nazi_zombie_test1.gsc', line 9)   main()
Error: ************************************
[enw] === Com_Error TRAPPED ===
[enw]   called from 0068B857   arg1 = 00000005
[enw]   arg2 = ".script runtime error (see console for details) %s%s%s"
[enw]   arg3 = "undefined is not an array, string, or vector"
      dvar set com_errorMessage script runtime error
ERROR: script runtime error
----- Server Shutdown -----
      dvar set sv_running 0
----- R_Init -----
```

**`Com_Error`, then `Server Shutdown`, then `sv_running 0`, then the renderer re-initialising for
the main menu.** The map is torn down and the player is dropped back to the menu with an error box.
There is no round 1, no spawn, and `referee:` never logs a round. So this is not a thread dying
quietly: the engine promotes it to a game-ending error all by itself, on a stock listen server, with
`developer 0` and no dedicated code in the process.

**Which means our dedicated path differs in nothing that matters.** No `logfile 2` effect, no
`sv_cheats`, no `developer_script`, no assert promotion of ours â€” the dedicated runs were seeing the
engine's own behaviour. `dedi.md` Â§14.2's conclusion ("the maps do this on their own") is confirmed
from the opposite direction, and its open sub-question is now answered: the error is fatal, so the
community cannot be playing *these files* and getting away with it.

That leaves Â§14.2's repack inference, which this run adds one fact to and does not settle: the
offending script arrives in a **separate third-party add-on** sitting loose in the mod folder, and
the engine says so out loud as it mounts it â€”

```
...\mods\nazi_zombie_test1\zombie_hitmarker_bythesuzho.iwd (4 files)
```

Whether removing that `.iwd` makes the map playable was **not tested** (it is the archive/dedi
lane's call, not this one's). Written down as the obvious next experiment, and as inference.

---

## 0.2.2 (2026-09-23)

Four things: the LocalAppData redirect above (which is the one that matters), the 4 GB patch and
its refusal, a **Check for updates** button, and the **`enw-zombies://`** protocol.

### Check for updates, in Settings

`src/main/updatecheck.js`. `UpdateCheck` takes an injectable `loadUpdater`, so the whole lane is
driven against a fake `autoUpdater` in the tests rather than against a real feed. Five player-facing
lines and no errnos: `Checkingâ€¦`, `You are up to date (0.2.2)`, `Downloading 37%`, `Ready to
install`, and a failure line. **"Could not reach the update server"** is its own sentence â€” a 404, a
DNS failure and a timeout all land on it, with the technical detail in parentheses â€” because "the
feed is down" and "the launcher is broken" must not look the same to a player. A dev checkout says
so plainly instead of throwing, which is what electron-updater does there.

*Restart and update* appears only once something has downloaded, and calls `quitAndInstall()`.
Every step goes to `launcher.log` under scope `update`, with **download progress logged at
intervals, not per event** (11 lines for 101 events, asserted).

### `enw-zombies://`

`src/main/deeplink.js`, and the scheme and routes are written into
[`../protocol/launcher-v0.md`](../protocol/launcher-v0.md) Â§7 because the web lane is building the
sending side against exactly them.

| | |
|---|---|
| `enw-zombies://map/<key>` | open the launcher on that map, selected in the browser and ready to Play or Start |
| `enw-zombies://party/<id>` | open on that party, joining it if the player is invited |
| anything else | home â€” logged with a `why`, and **nothing in the parser throws** |

`app.requestSingleInstanceLock()` + `second-instance`, so a second launch **forwards the URL to the
running launcher and focuses it** instead of opening a second app; the URL is also read out of
`process.argv` on a cold start (found anywhere in argv, not only at the end) and through `open-url`.
`package.json` gains `build.protocols`, which is what makes NSIS register the scheme at install
time. Every received URL is logged under scope `deeplink`.

One measured detail that drives the parser: for a non-special scheme `new URL()` puts the route in
`hostname` and the key in `pathname`, and **does not lower-case the host**.

### Tests, build and publish

`npm test` **101 passed / 0 failed** (86 at 0.2.1; 15 new â€” 2 LAA, 1 map-library relocation
rewritten, 5 deep link, 7 update check). `npm run smoke` **9 of 10**, and the one failure is the
check doing its job: B's own 0.2.1 has held the single-instance lock since 04:53, so a packaged
smoke run would exit immediately and write nothing. That is also why the packaged deep-link test
below is unproven.

| | |
|---|---|
| DLL | `build\launcher\enw_t4.dll`, 1,570,816 B, **sha256 `3e9d44dae0eaf38e7ecd637978891399d2cfeb13ee5c1c9119fd302747aa635f`**, 46 components register (42 at 0.2.1; the new one is `enw_localappdata`), 32 of 46 online on a player |
| in the installer | `dist\win-unpacked\resources\client\enw_t4.dll`, same sha256 â€” checked, not assumed |
| installer | **`ENW-Zombies-Launcher-Setup-0.2.2.exe`**, 94,530,479 B, **sha256 `57ca81b584c6cc39292b8ca49422953f356f07a18e9471dbbb2865c201d9c65f`** |

Published to `web/public/updates` through `tools/publish-update.js` (the only thing this lane writes
under `web/`). **The site was not restarted.** Checked against the running site on 127.0.0.1:3200
rather than assumed:

* `GET /updates/latest.yml` â†’ `200`, `Content-Type: text/yaml`, `version: 0.2.2` â€” not the React
  catch-all answering 200 with `text/html`, which is the failure this check exists for;
* `GET /updates/ENW-Zombies-Launcher-Setup-0.2.2.exe` with `Range: bytes=0-1023` â†’ **`206 Partial
  Content`**, `Content-Range: bytes 0-1023/94530479`, bytes start `MZ`;
* the served file's sha256 equals the one in `launcher\dist`;
* semver: 0.2.0 â†’ update, **0.2.1 â†’ update**, 0.2.2 â†’ no update.

The exe, its blockmap and `latest.yml` are gitignored, so none of it is in a commit.

### Unproven, and named

* **The packaged deep link.** `start enw-zombies://map/nazi_zombie_prototype` was **not** run
  against the packaged 0.2.2, because B's 0.2.1 holds the single-instance lock and a second copy
  exits immediately â€” the forward would go to a launcher that does not know the scheme. The NSIS
  registry entry is likewise unproven until someone installs 0.2.2. The parse, the routing and the
  second-instance forwarding are tested against fakes only.
* **Real electron-updater.** Every update test uses a fake `autoUpdater`. That a live 404 / DNS
  failure produces a message matching "could not reach the update server" is inferred from the
  error spellings, not observed; the matcher deliberately over-matches so a new spelling still lands
  in the right sentence.
* **The rendered Settings page.** No Electron run, so the new button row is code-correct and not
  seen.


---

## 2026-09-22 evening — the real launcher path against the box

The gap this session was opened to close, in the coordinator's words: *"the real launcher path
has never been exercised end to end with a dedicated server"* — every identity proof so far used
`ENW_AUTH_TOKEN` (fallback #3 in `auth_token.cpp`) through `tools/dev/jointest.ps1`, never the
launcher's own one-shot named pipe with a token the site minted for a real lease.

It is closed. **Run `lp5`, match `m_9f7b692c`, site game id 7, replay `/replay/m_9f7b692c`.**

```
client (B's PC)   auth: invite token accepted from the launcher's one-shot pipe eyJleH…7FDg (274 chars)
                  auth: wrote the userinfo config; the launcher's +exec will register enw_token
                  auth: enw_token is registered - the token is in userinfo
box               host/inst-01 auth slot 0 Unknown Soldier 76561198126330106: ALLOW (ok) -> identity verified
                  host/inst-01 game over: stop_intermission notify, round 1, 1m
                  host/inst-01 replay closed: 39.9 KiB in 3 chunks, 2543 events, 9.7x
site              games.id 7  ·  game_players: 76561198126330106, 1 round, xp 177
```

`identity verified` on the box, driven from the launcher, is new. So is the player row: game 7 is
credited to a SteamID rather than to attendance. The replay's track names the player
(`players[0].name = "Unknown Soldier"`, with `steamid`), not `Slot 0`.

### Four things were broken between Start and the server, and all four were ours

Listed in the order a player hits them. **Every one would have stopped B and three friends
tonight**, and none had ever been exercised, because every previous proof went through the dev
harness — which does all four correctly.

**1. The box had no address, so `connect` was always `null`.** `assignments.connectFor()` prefers
`boxes.address` and falls back to the box's `host.public_ip`. The column existed, **nothing in the
codebase ever wrote it**, and the host agent's status carries no `public_ip` either — so the
fallback was never reached, because there was nothing to fall back to. Every lease answered
`connect: null` and the boot screen would have sat on *Reserving server* until it timed out.
`boxes.setAddress()` is new, `register-box.js --name <box> --address <host>` writes it, and
`zombies-dev` now answers `2.28.235.236`.

**2. `+connect <host>` is not a command this exe has.** The launcher had put it on the command line
since the first version. `CoDWaW.exe` is the single-player exe; `connect` exists only as the
*server's* out-of-band name (`docs/re/t4-sp-map.md` §5), and the game says so in its own console:

```
Unknown command "connect"
…
Failed to log on.        (forever — which reads exactly like a network fault and is not one)
```

Joining is armed through the environment instead — `launch.js :: connectEnv()`:
`ENW_CLIENT_CONNECT=<map>` fires `CL_ConnectLocal`, `ENW_CONNECT_ADDR=<host:port>` rewrites the
hard-coded `"localhost"` it pushes, and `ENW_RAW_SOCKETS=1` stops Demonware's `bdSocketRouter`
dropping every connect packet. `jointest.ps1` and `join-remote.ps1` have always done this; the
launcher never did. The `+connect` line is left in the source as a retraction with the console
output beside it. `+map` is now added **only** when there is no host, or the client boots the map
locally before it dials.

**3. The token reached the DLL and stopped there.** The pipe worked first time — *"invite token
accepted from the launcher's one-shot pipe"* — and then:

```
auth: ENW_FS_HOMEPATH is not set, so there is nowhere instance-private to put the
      userinfo config. Token NOT installed.
```

`auth_token.cpp` writes `setu enw_token "<token>"` into `<fs_homepath>\main\enw_auth.cfg` during
`post_load`, and the launcher must (a) tell it where that is and (b) pass `+exec enw_auth.cfg`. The
launcher did **neither**. Both are in `launch.js` now — `ENW_FS_HOMEPATH` in the environment, and
the `+exec` on the line whenever a token is present, filename only. A token that never reaches
userinfo is `identity: none` on the box: a game nobody is credited for.

**4. A superseded lease's instance kept running, and owned UDP 3074.** Cancel a Start and press it
again: the site marks the old lease `superseded`, but `onAssignment` returned early and nothing
retired the instance. The replacement took the second port, bound **nothing**, and parked in
`Com_Init` at `frames=0` — so the box reported `ready` on a port with no server behind it.
`host.js` now retires every instance on a different match id before booting (the site keeps exactly
one live lease per box, so a different match id *is* a dead lease), **awaits** it, and waits two
seconds for Wine to hand the sockets back — a replacement started in the same tick parks the same
way. Measured both ways.

**…and a fifth, found while proving the fourth: ghost leases ate the box.** A lease only leaves
`leased`/`ready`/`live` when a game ends with a *result*. An instance retired instead leaves its row
live for ever, and `pickFree()` counts those rows against `max_instances` — two of them on a
two-instance box and every Start after that gets **"no game box is online"** while the box sits
idle. Hit twice tonight. `boxes.reapGhostLeases()` closes any lease this box's own status report
does not mention after a 90-second grace; the box's report is the evidence, and a report carrying
no instance list at all is ignored rather than read as "nothing".

### The box now has Minecraft Village Remastered, and it needed three symlinks, not one

`nazi_zombie_fear_mc_2` was staged with `archive/install_map.py --stage` (10 files, 593 MB — the
11th is a `console.log` the stager excludes) and pushed to `/home/waw/waw-en/mods/`, hashes
compared on both ends. Putting it only in the game folder is **not enough**, and the engine says so
in two different ways:

| what failed | where the engine actually looked |
|---|---|
| `Error during initialization: Unhandled exception caught` | `<fs_homepath>\mods\<bsp>` — the instance's homepath, not the game dir |
| `Error: Can't find map "nazi_zombie_fear_mc_2"` | `%LOCALAPPDATA%\Activision\CoDWaW\mods` — the engine's own map-exists check (`dedi.md` §14's `fs_localAppData` finding, which `enw_localappdata.cpp` solves on Windows and nothing solved under Wine) |

So all three are symlinks to the one copy: `waw-inst-*/mods`, `homes/inst-*/mods`, and
`drive_c/users/waw/AppData/Local/Activision/CoDWaW/mods`. With those in place:

```
host/inst-04 map_loaded nazi_zombie_fear_mc_2 -> manifest "nazi_zombie_fear_mc_2" (built-in default)
host/inst-04 recording -> …/m_8736f88c.enwr
```

Note *built-in default*: there is no `referee/manifests/nazi_zombie_fear_mc_2.json` on the box and
the site holds no manifest row for that version, so it is refereed as round-20. Honest, and worth
an entry from the referee lane before anybody claims an Easter egg on it.

### The site marks exactly five maps server-playable, and the lease enforces it

`on_server` was `health IN ('verified','playable')`, which answers "does this map work" — not "does
this map work headless, under Wine, on the box". Twelve maps passed that test, including all six the
archive lane has now confirmed broken (`18cf472`) and both whose *clients* hit the 32-bit ceiling.
`maps.js :: SERVER_PROVEN` is a measured list of five with its evidence written beside it,
`maps.onServer()` is what the browser and the list filter read, and `assignments.lease()` refuses
anything else — the UI is not the boundary. Checked against the running site, through the tunnel:

```
GET /api/maps?server=1 -> nazi_zombie_prototype, nazi_zombie_factory,
                          nazi_zombie_fear_mc_2, nazi_zombie_sumpf, nazi_zombie_asylum
```

### Signing in is the one link this session did NOT drive

The live site is `ZM_AUTH=steam` and the mock provider does not exist there, by design and for
stated reasons (`auth.js`). Steam OpenID needs a browser and a password, which an agent must not
have. So the Start press came from **`web/tools/lease-cli.js`** (new): the site's own
`parties.create/setMap/setReady/launch`, the site's own invite key, the site's own assignment row,
run as an operator on the machine that owns the database — the same shape as `register-box.js`, and
for the same reason that file already states. `play-cli.js --token` (or `ENW_LAUNCH_TOKEN`, so a
live token never sits in the process table) then carries that token into the shipped `GameLaunch`,
which serves it over the real pipe.

**So: the lease was real, the token was real, the pipe was real, the join was real, and the identity
check was real. Asking for the lease over HTTP as a signed-in player was not.** The boot screen
prints `SIMULATED` against `reserving`, which is the truth.

Covered by tests instead, and read critically: `launcher/test/run-all.js` **102/0** (new: `+exec
enw_auth.cfg` present only with a token; `connectEnv`; `+map` is local-only), `npm run test:launch`
all checks (new: the join environment, and `ENW_FS_HOMEPATH` equal to the `fs_homepath` on the
line), `infra/host-agent` **49/0**, `web` **84/33/14**. Follow-the-leader (`startPartyWatch` /
BootFlow `follow`) is tested against fakes only — *"a follower never presses Play for the party, and
launches at the match the site leased"* — and stays **unproven with a second real launcher**.

### Still unproven, and named

* **Steam sign-in, the party UI, the ready check and `/api/launcher/play`'s poll.** Nothing here
  drove them. B's own 0.2.2 is the only thing that can.
* **Two or more real clients.** `sv_maxclients 4` is on the box's command line (read off the
  running process), the site mints one token per player and the party caps at 4 — but one client is
  all that has ever joined.
* **The packaged 0.2.2.** This run used the repo's `src/main` against the same `binkw32.dll` the
  installer carries (`3e9d44da…`); B's installed 0.2.2 holds the single-instance lock.
* **The box's game DLL is `Sep 22 2026 07:38:34`** — it predates the chat lane's `player_down`
  (`ddaec9c`), so downs will not announce in chat tonight. The host agent on the box IS from HEAD.
* **Round 2.** The run ended at round 1 on `stop_intermission`; nobody kills zombies unattended.

### Tonight, step by step

**B:** open launcher 0.2.2 → *Sign in with Steam* → pick **Nacht der Untoten** (or Verrückt, Shi No
Numa, Der Riese, Minecraft Village Remastered — the map list's *on our servers* filter shows exactly
those five) → **Verified** → invite the others → wait for four green download bars → **Start**.

**A friend, first run:** `https://zombies.enw.gg/download` (HTTP Basic: any user, the password from
B) → install → *Sign in with Steam* → the launcher finds World at War and installs the ENW client →
accept B's party invite → the map downloads with a bar → **Ready** → their launcher follows B's
Start by itself. Nobody types an IP.

**If the boot screen sticks on *Reserving server*:** the box has no free slot. The ghost-lease
reaper frees it within 90 s by itself now, and pressing Start again retires whatever the box was
still holding; `node web/tools/lease-cli.js --match <id> --cancel` is the manual version.

---

## 2026-09-22, evening — 0.2.3: the config the engine actually reads, ADS on hold, and a staleness gate

B played 0.2.2 and reported the mouse stutter, toggle ADS and "borderless is not working — windowed
with a border". Two of the three had the same two causes, and neither was in the component B was
blaming. `client.md` §5 is the client side; this is the launcher's.

### 1. The seed was going to a directory the engine has never opened

`%s/players/profiles/%s/config.cfg` (the string at `0x883E64`) is resolved against the engine's
**local app data** folder — not against `fs_homepath`. Since `enw_localappdata.cpp` landed, that
folder is `<ENW>\home\localappdata`, so the file the game reads and rewrites is

```
<ENW>\home\localappdata\Activision\CoDWaW\players\profiles\<active>\config.cfg
```

and `gamecfg.js` was seeding `<ENW>\home\players\profiles\enw\config.cfg`. **`<ENW>\home\players`
did not exist on this box** after a night of play — `find` says so — and `active.txt` in the tree
the engine *does* use named `$$$`, its own default profile, because our `active.txt` was written
where it could not see it.

The consequence is not subtle, and it is measured, not argued. That profile still held:

```
seta r_mode "800x600"
seta r_displayRefresh "60 Hz"
seta vid_xpos "40"
seta vid_ypos "40"
bind MOUSE2 "+toggleads_throw"
seta cg_drawFPS "Off"
```

after a session launched with `+set r_mode 2560x1440 +set vid_xpos 0 +set vid_ypos 0`. **`config.cfg`
is exec'd during `Com_Init`, after the command line's early `+set`s, so it wins.** A borderless
window at `(40,40)` at 800x600 is what that config asks for, and "windowed with a border" is what B
saw. It also means the read-back half of the round trip had been reading a file the game never wrote.

**Fixed.** `configPaths()` now returns `engineCfg` / `engineProfileDir` / `engineActiveTxt` first,
derived from `<homeDir>\localappdata\Activision\CoDWaW`, and `activeProfile()` **reads `active.txt`
rather than imposing `enw`** — the engine creates `$$$` by itself and renaming it out from under a
player loses their binds. `readConfig()` prefers `engineCfg`. The `fs_homepath` tree is still
written, because a dev run with `ENW_LOCALAPPDATA` unset really does use it.

**The seed MERGES; it does not replace.** The engine's own `config.cfg` is ~500 lines — `unbindall`,
every key binding, several hundred `seta`s it expects to find, and a trailing `con_hidechannel`
command. Dropping our 30-line baseline on top of that would wipe the player's binds. `mergeConfigCfg()`
substitutes each baseline line where it already exists, appends the ones that are missing under a
marked comment, keeps `con_hidechannel` last, and passes everything else through untouched. There is
a test that asserts an unrelated bind and an unrelated dvar both survive.

`BASELINE_VERSION` is **3**, so this reaches everyone who already has a config once, and then the
player owns it again — the existing rule, unchanged.

### 2. Aim down sights defaults to HOLD

There is **no ADS dvar in T4** — `ads_toggle`, `cl_ads`, `cg_ads`, `ads_button` are all zero
occurrences in the decrypted image. Hold vs toggle is **which command `MOUSE2` is bound to**, and
both pairs are in the image: `+speed_throw` (hold) and `+toggleads_throw` (toggle). Stock WaW binds
the toggle one, which is what B's profile held.

So there is a new `BASELINE_BINDS` list beside `COMMUNITY_FIXES`, with the same shape (name, why,
source) and the same policy — written once per baseline version, then the player owns it:

```
bind MOUSE2 "+speed_throw"
```

This is exactly what the game's own Controls menu writes for *Aim Down Sight: Hold*, so the round
trip needs nothing new: a player who switches to Toggle in game has the engine rewrite that line and
`applyReadBack` already parses binds.

### 3. Three baseline corrections the engine's own config.cfg exposed

Reading the file the game actually writes is the first time we have seen its types.

* **`cg_drawFPS` is a string enum, not a bool.** The engine writes `seta cg_drawFPS "Off"`. We were
  pushing `1`, which is not one of its values. Now `Simple` / `Off`, and the read-back treats `Off`
  as off.
* **`r_displayRefresh` is a string with a unit** — `"60 Hz"` — and it was sitting at 60 on a 240 Hz
  panel. It now follows the chosen display, in the engine's own format, and is omitted entirely when
  the display reports no refresh rate rather than inventing one.
* **`r_autopriority 1` added.** It is a real vanilla T4 dvar (it is in that config.cfg at its stock
  0), and iw4x-client ships the same feature in the same component as its raw-mouse fix: a higher
  priority class while the window has focus, so a background process cannot take the frame the input
  arrived on. Costs nothing when nothing else is busy.

Deliberately **not** changed, and the reasons matter: `com_maxfps` stays **250** — in the Q3 lineage
only divisors of 1000 behave (125 / 250 / 333 / 500) and 250 is already one; `m_filter 0` and
`cl_mouseAccel 0` were already right; `r_vsync 0` is measured innocent (`client.md` §1e); and
**nothing toggles vsync or resolution at runtime** — the R15 trawl reports T4 crashing on that in
the in-game video menu, so both stay in the seeded config and on the command line.

`+set logfile 2` on line 160 of `launch.js` **stays**. Note what it costs, because it is not free:
`logfile` puts the script VM into developer mode and makes a GSC runtime error fatal — that is the
custom-map breakage the scripts lane found. `shared/core/components/script_error_retail.cpp`
(`4986d70`) removes the kill and keeps the diagnostics, and it is in 0.2.3's DLL.

### 4. The staleness gate, which is the real bug behind two of B's three reports

`tools/stage-client.js` had `PREFER = ['launcher', 'referee', 'foundation']` and took
`build/launcher` **unconditionally, regardless of age**. So 0.2.2 shipped a client DLL built before
`borderless.cpp` even existed, while a newer one sat in `build/c2`. B played it, reported that
borderless did not work and that the mouse fix had not helped, and **both were true** — neither
component was in the binary he ran (`client.md` §5a has the three independent readings).

A preference list may pick *which* build. It may not pick an *old* one. `stage-client` now compares
the chosen DLL's mtime against the newest `.cpp` / `.hpp` under `client-dll/components`,
`server/components`, `shared/core` and `shared/t4`, and **refuses to stage a client older than the
source**, naming both files and the gap in hours. `--allow-stale` overrides it and you should have a
reason. The same file already refuses to build with no DLL at all, for the same class of reason.

Related, in the DLL and worth knowing here: **the build banner used to lie.** `__DATE__`/`__TIME__`
are the compile time of `dllmain.cpp`'s translation unit, so an incremental build leaves them alone
— three different DLLs all announced `build Sep 21 2026 16:18:51`. The banner now also prints the
DLL file's own last-write time and size, which cannot go stale. When a player reports a component
misbehaving, that line is the first thing to read.

### 5. 0.2.3

```
ENW-Zombies-Launcher-Setup-0.2.3.exe   94.5 MB
  sha256 35be221b12821d998e83f855d4693477d5312872e1248e1034ac0e03481628a6
client enw_t4.dll  1,577,472 B, 47 components
  sha256 8a7b7b30f5f8e97c644b3bcffa7b77328f1d3210eb55b2ea0bc9817744e843bc
```

`npm test` **107 passed, 0 failed** (five new: the engine config path, the ADS hold bind, the merge
preserving binds and unknown dvars, the `cg_drawFPS` enum, the `r_displayRefresh` format).
`npm run smoke` 9 of 10 — the one failure is the agent shell's own sandbox notice (writes under
`%LOCALAPPDATA%` from this process are redirected into a package cache; reads pass through), plus a
warning that B's launcher is running and holding the single-instance lock. Neither is a regression.
Published to `web/public/updates`; `latest.yml` reads `version: 0.2.3`.

**The DLL half is proven in the running game** — `client.md` §5f has the 17:38 run on `waw-c2`:
47 components, borderless read back as `window rect == client rect` at 2560x1440, and 1,051
`WM_INPUT` against 50 legacy `WM_MOUSEMOVE`. **The launcher half is not.** The config-path fix, the
ADS bind and the merge are proven by unit test and by reading the file the engine actually wrote;
that the new seed reaches the engine is **unproven until B's next Play**, because that run used the
dev harness's own `fs_homepath`, not the launcher's. The first Play on 0.2.3 should leave
`<ENW>\home\localappdata\Activision\CoDWaW\players\profiles\$$$\config.cfg` holding
`seta r_mode "2560x1440"`, `seta vid_xpos "0"` and `bind MOUSE2 "+speed_throw"` — that file is the
check.

---

## 2026-09-22, evening — 0.2.4: the stock map the launcher tried to download, and the launch that never said it had stopped

B pressed Play on **Nacht der Untoten** in 0.2.3 and his boot screen read:

```
1 Downloading the map     X  The site has no files for nazi_zombie_prototype yet
2 Reserving server        ok match m_dca96c74, invite token issued
3 Loading map             ok the server loaded the map
4 Ready                   ok the server is ready on 2.28.235.236:28960
5 Launching World at War  .. waiting
```

Five faults, and the first two are one sentence each.

### 1. The launcher asked the site to send it a map that ships with the game

`ensureMap` goes to `library.isInstalled`, which means **"WE installed it"** — false for a stock
map on every machine for ever. So the boot flow asked `/api/maps/nazi_zombie_prototype/files`, the
site answered `install_known: false` because it genuinely holds no files for it, and the launcher
read that as *"the site has no files for this map yet"* and stopped.

The site could not have helped, because its answer could not tell "you already have this map" apart
from "we have lost this map". It can now. `mapfiles.forMap()` reads the maps table's own `source`
column and answers a stock map with `source: 'stock'`, `stock: true`, `needs_download: false` and
`install_known: TRUE` — the install IS known; Treyarch did it. `mapPayload` carries the same three
fields into `/api/launcher/play`.

On this side, `library.js` gains `STOCK_MAPS`, `isStock()` and `mapReady()` — *"can the engine load
this map now"*, which is the question the boot flow was actually asking. `ensureMapInstalled`
returns `{ stock: true }` without a request, and **BootFlow skips the step entirely**, drawing
`Downloading the map — installed: stock`. Either source is enough: the launcher's own list, or the
site saying `source: stock`, so a launcher one release behind the map table still gets it right.

### 2. A launch that had given up looked exactly like one that was still trying

The renderer draws a step with **no record at all** as `waiting`. A failed download returned the
snapshot, so `launching` and `in_game` had no record, and the screen sat on *waiting* for ever over
a launch that had stopped a second earlier. There is no timeout behind that word.

`BootFlow.stop(why)` now writes every un-run step down as `failed — stopped: <why>`, and every
failure path goes through it. `main.js` pushes `boot_done` on a failed flow as well, so the boot
screen swaps Cancel for **Close** instead of offering to cancel something that is already over.

And a download that fails on a map that is **on disk anyway** is a broken check, not a reason to
refuse a ready server: `mapReady(bsp)` lets the launch continue and says which.

### 3. The lease was never given back — twice over

`m_dca96c74` was still `ready` on the site and still holding `inst-01` on `zombies-dev`, with Nacht
loaded for nobody, long after B closed the screen. The ghost-lease reaper cannot help: the box
**is** reporting that instance, honestly, so it is not a ghost. Nothing called
`POST /api/launcher/cancel` on a failure, and **nothing called it on Cancel either** — the cancel
button only stopped the local game.

`releaseLease()` in `main.js` now runs on all three endings (failed step, exception, Cancel), best
effort, logged either way. That lease was released by hand this session
(`node web/tools/lease-cli.js --match m_dca96c74 --cancel`; the box then logged
`assignment changed: idle`). Note what that did NOT do: the host agent leaves the instance PROCESS
up when a lease goes idle, and only the next boot on a different match id retires it. Worth a
host-lane line; not a blocker, because a closed lease no longer counts against the box.

### 4. Play defaulted to Custom

`S.mode` in `shell.js` was `'custom'`, so a stock map's card read **CUSTOM / "Untracked."** on the
verified journey — and the lease the site opened said `mode: custom` too, because that value is
what `POST /api/launcher/play` is given. The box's own line for B's game is
`host lease m_dca96c74: nazi_zombie_prototype custom 1p`. It is `'verified'` now, and `modeLabel()`
is the one spelling, used by the mode button, the map card and the boot screen. `local` gets its
own word — *Untracked* — instead of being called "Custom".

**"Unknown Soldier" is not a signed-out launcher.** `users.username` for `76561198126330106` is
literally `Unknown Soldier`; B was signed in, the token in that lease carries his SteamID, and the
header was showing the site's stored name for his account. Nothing to fix.

### 5. The launcher's loopback sign-in could not reach a mock site

Found while proving the above. `/auth/launcher/start` redirected to `/auth/steam` unconditionally,
and in mock mode that route **is not registered** — 404. So the one provider an agent can drive was
the one the loopback flow could not use. One line, inside the mode check; live is `ZM_AUTH=steam`
and is untouched (checked after the deploy: `/auth/steam` still 302s to Steam).

### What is proven, in the real UI, and what is not

Driven through the **shipped renderer** in a dev-mode launcher (`electron .`), over the DevTools
protocol — clicks on the real buttons, readings off the real DOM. Sign-in is the launcher's own
loopback flow (`ENW_SIGNIN_NO_BROWSER`, the path already in the source for exactly this), against a
private site on 3399 holding a `VACUUM INTO` copy of the live database with `ZM_AUTH=mock`, and a
**real host agent on B's PC** as the box. `web/data` was not touched.

```
Play page       mode "Verified", card "Verified", note "Records and badges count."
Play pressed -> Downloading the map     ok installed: stock
                Reserving server        ok match m_dba28b35, invite token issued
                Loading map             ok the server loaded the map
                Ready                   ok the server is ready on 127.0.0.1:28970
                Launching World at War  ok World at War is running (process 41312)
                In game                 ok connected
box             host lease m_dba28b35: nazi_zombie_prototype VERIFIED 1p
                host/inst-01 map_loaded nazi_zombie_prototype -> manifest "Nacht der Untoten"
                host/inst-01 game live: nazi_zombie_prototype (verified) cap 24.0h
Cancel pressed  host/site assignment changed: idle      <- the lease came back
                assignments row m_dba28b35 = cancelled
```

Against the **LIVE** site, read-only through the tunnel, after deploying the site half:

```
GET /api/maps/nazi_zombie_prototype/files
  -> {"source":"stock","stock":true,"install_known":true,"needs_download":false,"files":[]}
GET /api/maps/nazi_zombie_fear_mc_2/files
  -> {"source":"custom","stock":false,"install_known":true,"needs_download":true,...}
```

**Not proven, and named:** signing in to the **live** site (`ZM_AUTH=steam`; an agent must not have
a password — unchanged since lp5), a lease against the **Hetzner** box through the UI (the box
polls the live site only, and repointing it would mean touching box services), and
**game over then a result on the site** — this run was ended with Cancel, which is an abandon and
not a result. That leg is lp5's and nothing here touches it. Two real clients: still one.

### 0.2.4

```
ENW-Zombies-Launcher-Setup-0.2.4.exe   94.5 MB
  sha256 0aef3013dd2164c0c5c74456ddc5007c357f10bc9ed8079be051bc3fe8e61dc2
client enw_t4.dll  1,577,472 B
  sha256 8a7b7b30f5f8e97c644b3bcffa7b77328f1d3210eb55b2ea0bc9817744e843bc   <- byte-identical to 0.2.3
```

`npm test` **119 passed, 0 failed** (new: the stock four are ready without an install; a stock map
skips the download; the site saying `source: stock` is enough on its own; a failed download on a
map that is here still launches; a stopped launch writes its remaining steps down; the Play page
starts in Verified). `web` **85 / 33 / 14** (new: the stock payload, and the launcher flow going to
the provider the site actually has). `npm run smoke` 9 of 10 — the one failure is the agent shell's
own `%LOCALAPPDATA%` sandbox notice, exactly as in 0.2.3, plus the usual warning that B's launcher
holds the single-instance lock. Published to `web/public/updates`; `latest.yml` reads
`version: 0.2.4` and the tunnel serves it as `text/yaml`.

**Two things said out loud about this build.** `stage-client` was overridden with `--allow-stale`:
the client lane had edited `mouse_polling.cpp` half an hour earlier and the gate refuses a DLL older
than the source. Rebuilding would have shipped an untested, in-flight client change inside a
hotfix; the staged DLL is byte-identical to the one 0.2.3 proved in the running game
(`client.md` section 5f), which is what that gate exists to protect. For the same reason the
packaged `src/**` carries whatever the launcher tree held at 17:11 — including another lane's
in-flight `focusguard.js`, `gamecfg.js`, `launch.js` and `settings.js`. `npm test` and
`npm run smoke` were green on exactly that tree.

**Still open, and deliberately not in 0.2.4:** the shell's own right rail. B wants the LEFT column
to be the only place a party is managed and a map is picked (Movement's home layout), the rail gone
with Play Local / Custom / client status moved into it, the left column pinned at a fixed width,
and a default window size that shows it at first open. That is a shell rewrite and B was waiting to
play, so the Play fix shipped first.


---

## 2026-09-22, late — the right rail is gone, and the site's left column finally fits

B, looking at the launcher window: the shell's own right-hand rail — selected-map card,
Play / Play Local / Custom, the map list, a status block — has to go. The LEFT column is
the one place a party is managed and a map is picked (Movement's home layout), the site's
home already does exactly that, and *"its default window is too small for the site's left
column to appear at all."*

That last clause is the whole finding, and it is arithmetic.

### The rail was not merely duplicating the left column. It was hiding it.

`theme.css`:

```css
.home { grid-template-columns: var(--rail-w) minmax(0, 1fr); }   /* --rail-w: 302px */
@media (max-width: 1080px) { .home { grid-template-columns: 1fr; } }
```

`main.js`: the window opened at **1400** wide and the site view was given
`width - RAIL_WIDTH`, with `RAIL_WIDTH = 320`. **1400 − 320 = 1080.** Exactly the
breakpoint, on the wrong side of it — so inside the launcher, and only inside the
launcher, the home folded to one column and the party panel and map list stacked above the
map instead of standing beside it. At the old `minWidth: 1000` the site got 680 and there
was no argument at all. The rail was not competing with the left column for attention; it
was 320 px of why there was no left column.

### What was deleted, and where each thing already lived

| the rail had | it is on the site at |
|---|---|
| the map list (its own `STOCK` four + the archive catalogue) | `MapListPanel`, 19 maps, in `.home-left` |
| Play | `PartyPanel`'s **Start**, and the map page's own **Play** |
| Play Local | the map page, beside Play (`MapPage.jsx :: PlayLocal`) |
| Verified / Custom | `PartyPanel`'s mode chips |
| the status block | moved into the launcher's **Settings** screen; the summary is still a topbar pill |

**The duplication was not harmless, and there is a receipt for it.** The rail held its own
mode, and the rail's mode was the one that reached `POST /api/launcher/play` — which is how
this morning's lease came out `mode: custom` under a card the site's party thought was
Verified. One owner now: `parties.js :: create` defaults a party to `verified`, so
Verified-by-default survives the deletion.

**Pressing Start on the site already launches the game here** and always has:
`main.js :: onPlay` follows any match the site hands this player, in its own words *"a game
was started for you"*. Nothing had to be built for the Play button's removal — the path it
used was the less-travelled one.

### What the shell keeps

Only what a native app can do: finding World at War, installing the ENW client, the
first-run screens, Settings (now with Status at the top), the boot screen, the tray, and
the topbar — brand, back/forward/reload, `site:`, `client:`, the account pill, Settings.
A map deep link (`enw-zombies://map/<bsp>`) is now a navigation of the wrapped view to
`/m/<bsp>`, exactly as a party link has always been; it still presses nothing.

### The numbers, derived rather than picked

```
MIN_WIDTH      1180   > the site's 1080px fold, with 100px of slack
MIN_HEIGHT      700
DEFAULT_WIDTH  1500
DEFAULT_HEIGHT  940   fits a 1080p desktop with its taskbar
```

There is **no Movement launcher to copy** — Movement is a web client, and its layout *is*
that breakpoint, which is the better source anyway. A test asserts `MIN_WIDTH > 1080` and
that nothing subtracts a rail from the site view again.

### Proof

`docs/kickstart/ui/launcher-left-only.png` — the launcher at its **default** size, signed
in, against a private site (mock auth, `VACUUM INTO` copy; `web/data` untouched). Measured
in the running app rather than read off the picture:

```
site view innerWidth   1484        (was 1080)
.home-left             present, 302px wide
  party panel          Verified | Custom | Private | Start | Invite | Leave
  map list             19 maps
.home-right            nazi_zombie_prototype — Nacht der Untoten, ROUND 20, VERIFIED,
                       Play | Play Local | UNTRACKED
launcher chrome        #rail absent, #mapList absent
```

The screenshot is composed from the two webContents through the DevTools protocol, not
grabbed off the desktop — the launcher is one native view inside another and a desktop grab
takes whatever else is on B's screen. (It did, once. That file was deleted unviewed-by-
anyone-else and the method changed.)

`npm test` **124 passed, 0 failed** — three new: the shell draws no rail, no map list and
no Play button and must not grow one back; the shell owns no mode of its own; the window is
wide enough for the site home to be two columns. `npm run smoke` 9 of 10, the same
`%LOCALAPPDATA%` sandbox notice as every agent-shell run.

**Not published.** This is a shell commit sitting on `main` for whoever publishes next —
the client lane's 0.2.5, then identity's 0.2.6. B's installed 0.2.4 is unaffected.

### One consequence, written down rather than discovered later

**With the site unreachable the launcher now has no map list and no Play of its own.** It
keeps setup, settings and the boot screen, and the topbar says `site: placeholder` — but
the offline affordance the rail gave (pick a stock map, Play Local, with no site at all) is
gone with it. That is the cost of having one copy of the map list instead of two, and it is
the right trade while the site is the product; if it ever matters, the answer is a
placeholder page that offers the four stock maps, not a second rail.


## 2026-09-23 — `+set name`, and the end of "Unknown Soldier"

One line, and it is the whole of B's complaint. `buildArgs()` now takes `playerName` and pushes
`+set name "<ENW name>"` on **every** launch, Play Local included — a local game never reaches a
server, so the referee's lock cannot apply and this is all there is. The value defaults to
`settings.session().name`, which is what the site answered at sign-in (`users.pub().name`, i.e.
`enw_name` first), so no caller has to remember it: the name is a property of who is signed in,
not of a particular Play button. An account that has not picked a name yet gets **nothing** —
the engine's own default — rather than a SteamID dressed up as a name.

`ENW_PLAYER_NAME` goes into the child's environment with the same sanitised value, for the client
DLL's new `name_pin` component (`client-dll/components/name_pin.cpp`), which re-issues
`set name "<x>"` through `Cbuf_AddText` every 3 s so an in-game change is undone. Backslashes,
quotes and semicolons are stripped from both, because the engine's userinfo is
backslash-delimited and `set` is console input; `Info_SetValueForKey` strips the same three
server-side, so the two sides cannot disagree.

**Both are belts, not the lock.** They run in the player's own process and anyone can edit a
config or pass a different `+name`. What stops a spoof is the referee overwriting the *server's*
copy of the userinfo with the invite token's name — `docs/kickstart/referee.md` §14.

`launcher/test/run-all.js` **122/0**, three new: every launch carries `+set name` (local
included); a name cannot break out of the infostring or smuggle a second command
(`ev\il";quit` → `evilquit`); and a session with no name sets no name rather than an invented one.

**Not published.** 0.2.4 (Play fix) and 0.2.5 (client) own the version line; these changes are
committed and unversioned, for whoever publishes **0.2.6** after 0.2.5 is on `latest.yml`.

### 0.2.6 — published (2026-09-22, 18:43)

**0.2.6 is the shell rewrite (`8da3d0d`) plus `+set name` / `name_pin` (`dcc7c31`), on top of 0.2.5's
mouse and settings work.** Built from `main` at `8f0b92b`: `tools\dev\build.ps1 -Name launcher` →
`build\launcher\enw_t4.dll` 1,600,512 B, sha256 `f0a9844e413c1533f540e4f7676519587d389469a7baef1803999ac0ae4cd748`,
**48 components** (47 in 0.2.5; the new one is `name_pin` — `grep -a name_pin` finds it in this DLL
and not in `build\client-lane`'s, which is what 0.2.5 shipped). `loadtest.exe` read the banner back:
`the FILE is 2026-09-22 18:40:44` — minutes old, so `stage-client` took it with **no `--allow-stale`**,
and its own line names `build\launcher` and the same sha. That is the first release since 0.2.3 whose
client is a fresh build rather than an override.
`npm test` **124 passed, 0 failed** (the shell's three and identity's three are both in that run).
`npm run smoke` **9 of 10** — the one failure is the agent shell's `%LOCALAPPDATA%` sandbox notice,
identical to 0.2.3/0.2.4/0.2.5 and not a regression.

```
ENW-Zombies-Launcher-Setup-0.2.6.exe   94,555,781 B
  sha256 093651669ebba2f1ac47556f14e3b6bdaf63fd3e47f758a3eded07e877c08b81
  sha512 GnVkh3/L03U7UNyfCA8ke8qYTizM37oUAfTpsxGi9pmgeACZX9eEtHEPPCT4x4Jx31nribhAn6wqXX3s5B7Rpg==
```

Verified through the **live tunnel**, read-only: `GET https://zombies.enw.gg/updates/latest.yml`
→ `200`, `Content-Type: text/yaml`, `version: 0.2.6`, and the `sha512` in it is byte-for-byte the
one computed from the file on disk; a `HEAD` on the installer answers `200` with
`Content-Length: 94555781`, which is the `size` in the feed. Nothing on the site was restarted.

**Unproven, and named:** nobody has installed 0.2.6 and pressed Play. The left-column shell was
proven in a dev-mode launcher (the *late* section above) and `+set name` by unit test and by reading
the DLL; **that a player's ENW name shows over his head in a real game is still B's first run to
confirm**, and so is 0.2.3's config round trip, which no published build has yet been observed doing.

2026-09-22 IP posture: the launcher must never ship or download a game file; stock asset conversion (OAT, world-shell reader) runs locally into `%LOCALAPPDATA%\ENWZombies`.
See [`ip-posture.md`](ip-posture.md) §6-§7 and §9 (installer extension guard, LICENSE files, ownership record).


## 2026-09-22, evening — 0.2.9: no launcher bar; the site's nav is the title bar

B: get rid of the launcher's own top bar (the dark-green strip — brand, back/forward/reload,
`site:` pill, `client:` pill, account pill, Settings) and the green theme with it. The whole
launcher must look like the site, and the window buttons go into the site's nav.

**What changed**

- `main.js`: the window is `frame: false`, `TOPBAR_HEIGHT = 0` (the site view is the whole
  window), `backgroundColor #101010`. MIN/DEFAULT sizes unchanged. New IPC: `winMinimize`,
  `winMaximize` (toggle, returns the new state), `winClose` (`close()`, so the tray rule still
  decides what Close means), `winIsMaximized`, and `openScreen('settings'|'firstRun')` which the
  site uses to open a shell screen. `push()` now reaches the site view too (session, update
  status, `window` {maximized}). **Ctrl+R / F5** from either webContents reloads the SITE (the
  default menu's Ctrl+R would reload the focused view, i.e. the shell mid-setup). A main-frame
  `did-fail-load` loads `placeholder.html` instead of Chromium's error page.
- `preload.cjs`: `enw.win.{minimize,maximize,close,isMaximized,onState}`, `enw.openScreen`,
  `enw.onOpenScreen`.
- Site (`web/client`): `components/launcherBridge.js` tags `<html class="in-launcher">` only when
  `window.enw.win` exists; `WindowControls.jsx` (46 px buttons at the nav's right, panel wash on
  hover, close goes the site's one red `--bad`); `theme.css` makes `.mv-nav-bar` the drag region
  with every control `no-drag` (double-click maximises — Windows' own behaviour). `UserMenu`:
  signed in, the menu gains a status row (client installed / not, launcher version, the update
  checker's own sentence), **Install the ENW client** when missing, **Restart to update** when
  ready, and **Launcher settings**; sign-out also clears the launcher's session. Signed out in the
  launcher: **Sign in** runs the launcher's Steam round trip (`enw.signIn`, the wrapped view cannot
  follow Steam's page) plus a cog for Launcher settings. A browser gets none of it — the header
  alone is not enough to draw buttons that cannot work.
- Shell: the topbar is gone. The screens (setup, settings, boot) still hide the site; they get a
  slim site-styled strip (`#chrome`: ENW ZOMBIES lockup, **← Back to the site**, the three
  buttons) that is covered by the site view whenever the site shows. `shell.css` tokens are the
  site's palette (old token names kept). Back/forward and the `site:` pill are gone for good.
- `placeholder.html`: rewritten site-styled — nav bar as drag region, window buttons, *The site is
  not answering*, **Try again** (`reloadSite`) and **Launcher settings**. Trap found: a top-level
  `const enw` in the page is a SyntaxError (the preload's `window.enw` is non-configurable), which
  silently killed the script; it is wrapped in an IIFE.

**Proof**

- `launcher npm test` **125/0** (new: no bar ids in shell html/js, no green/olive/bone palette,
  `frame: false`, `TOPBAR_HEIGHT = 0`, the five IPC names in main and preload, buttons + drag
  region in the strip and the placeholder, Ctrl+R/F5 wired). `web npm test` 90/33/14, 0 failed.
- A scratch Electron harness (launcher preload + frameless window + the window IPC mirrored,
  offscreen, **not** the app) against the rebuilt live site at `:3200`: `html.in-launcher`,
  buttons Minimise/Maximise/Close at the nav's right (x 1347–1485 of 1500, 62 px tall — the page
  scrollbar is the last 15 px), `.mv-nav-bar` computes `drag`, `.wc` `no-drag`; clicking
  Maximise maximised the window and the glyph became **Restore**; placeholder rendered with its
  buttons. Screenshots were looked at and not committed.
- Site rebuilt and restarted (node pid → keepalive `-Once`; the detached loop was left alone).
- **0.2.9 published**: `ENW-Zombies-Launcher-Setup-0.2.9.exe`, sha512 `4XVycEic…36dszw==`;
  `https://zombies.enw.gg/updates/latest.yml` answers `200 text/yaml`, `version: 0.2.9`, sha512
  byte-equal to the file. stage-client passed without `--allow-stale` (DLL `510109dc…`, built
  18:34Z — the 0.2.8 client). A re-run minutes later was refused as stale because another lane
  was editing `server/components/replay/replay.cpp`; nothing was published by that run.
- `npm run smoke`: 9/10, the one failure is "already running" (B's launcher is open) — so the
  **packaged** 0.2.9 has not been started by anyone.

**Unproven, named:** the real packaged window — drag, Aero snap, double-click-maximise and resize
edges on a frameless window whose client area is a `WebContentsView`; the shell screens' strip
in the running app; the menu's Launcher settings / Install / Restart-to-update round trips; and
launcher sign-in from the site's button. All are B's first look after updating to 0.2.9.
Note: an accidental dev `electron .` during this session hit B's running launcher's single-instance
lock and forwarded an empty argv (it may have raised his window once).


## 2026-09-22, evening — 0.2.10: nav clicks land, and the in-game name is the ENW name

### Nav bar: the shell's strip won the hit test

B on 0.2.9: *"I can't click on any stuff on the nav bar"*. **Root cause:** the shell page (the
BrowserWindow's own webContents, under the site's `WebContentsView`) keeps its `#chrome` strip —
62 px, `-webkit-app-region: drag`, no-drag only on its own Back button and three window buttons.
On Windows the frameless window's `WM_NCHITTEST` answers from **that** page's drag regions even
where the site covers it, so every site control that did not happen to sit over one of the strip's
buttons answered `HTCAPTION` and the click became a window drag. That is why the search box
(over the strip's Back button) and the window buttons (over the strip's buttons) worked and
Maps/Records/Admin/logo/Discord/account did not. **Fix** (`main.js` `showSite()` → `shellStrip()`,
`shell.css`, `shell.html`): `html.site-shown #chrome { display:none }` while the site shows; a
shell screen brings it back. Changing only `-webkit-app-region` on the strip was **not** re-sent by
Chromium; `display:none` (a layout change) is.

**Measured, not argued.** A dev launcher (the real `main.js`, frameless, own `userData`, own
`ENW_ROOT`, protocol registration stubbed) against a scratch site on :3397, probed by sending
`WM_NCHITTEST` to the real HWND (1 = client, 2 = caption):

| x (nav y=30) | search 130 | gap 400 | logo 612 | Maps 684 | Records 766 | Admin 853 | gap 1000 | Discord 1161 | account 1277 | Min 1370 |
|---|---|---|---|---|---|---|---|---|---|---|
| strip present (0.2.9) | 1 | 2 | **2** | **2** | **2** | **2** | 2 | **2** | **2** | 1 |
| strip hidden (0.2.10) | 1 | 2 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 |

The "strip present" row was taken after the page reloaded from the dist rebuilt at 20:19 with the coordinator's web fix (`2ff595c`, `.mv-drag` underlay)
already in the served dist, so **that fix alone does not unblock B**; it is harmless with this one
and the 0.2.10 row was re-measured with it. Gaps stay `HTCAPTION`, which is what Windows needs
for drag, double-click-maximise and Aero snap. Settings screen: strip back, Back = 1, gap = 2;
Back to the site: Maps = 1 again. Clicks through Chromium's input pipeline (CDP
`Input.dispatchMouseEvent`) in the same window: Maps → `/maps`, Records → `/records`, Admin →
`/admin`, logo → `/`, search focused, account chip opened the menu. Window image:
`ui/2026-09-22-launcher-0.2.10-nav-account-menu.png`, `ui/2026-09-22-launcher-0.2.10-settings-strip.png`.

**Not done:** real-mouse clicks and a real drag/double-click. The computer-use click was
interrupted by the user at the desk, and was not retried. `WM_NCHITTEST` is the OS's own routing
decision for a real click, so this is the next-best evidence; the drag/double-click feel is B's
first look.

### In-game name: the profile, not the dvar

**Root cause:** with a named profile active, World at War sends the **profile's name** as the
userinfo `name` and ignores the `name` dvar. B's three dedi joins (zombies-dev, 18:20Z–18:28Z,
`waw-inst-01/03`) all read `player_connect slot 0 name='enw' steamid=76561198126330106` although
his client's command line carried `+set name myu`, `name_pin` logged `pinned name to 'myu'`, and
the `enw` profile's own `config.cfg` says `seta name "myu"`; the dedi counted **0** userinfo
commands, so `myu` was never sent. The profile the launcher seeds is called `enw` (`gamecfg.PROFILE`).
Same shape as referee.md §14.4 (`anna-jpg` beat `+set name spoofer`). Only the engine's `$$$`
("no profile") honoured the dvar — the old `Unknown Soldier`. Ruled out: the site (`users.pub`
and `/api/me` answer `name: "myu"`; B's row has `enw_name = myu`); the packaged 0.2.9 (it has
`+set name` and a `name_pin` DLL, and both ran); the referee's name lock (no token `n` reached the
dedi — `tokens will not be lease-checked` — so it never renamed anyone).

**Fix:** `gamecfg.usePlayerProfile()`, called by `launch.js` before the seed on every player-mode
launch: the active profile becomes `profiles/<ENW name>` (sanitised to a folder-safe name; `CON`
etc. refused), copied from the current profile on first use so binds, settings and `mpdata` come
along, with `seta name` set to match, and `active.txt` pointed at it. The seed, ADS migration and
read-back all follow `active.txt`, so they follow it too. A second account on the same PC gets its
own profile. No name → the profile is left alone. `npm test` **127/0** (two new).

**Unproven:** `myu` over B's head in a real game — nobody ran the game for this (B at his PC).
The first Play on 0.2.10 logs `player profile: now 'myu' (was 'enw', binds and settings copied
from 'enw')` in `launcher.log`, and the dedi's `player_connect` line should read `name='myu'`.

### Publish

0.2.10 = `5103c13`. DLL **unchanged**: `build\launcher\enw_t4.dll` sha256 `510109dc…` (the 0.2.8/0.2.9
client), staged with `--allow-stale` because `client-dll/components/mouse_polling.cpp` was edited
by another lane at 19:23Z, after that build; nothing in that edit ships. `npm run smoke` 9/10 (the
agent-shell sandbox notice) plus the benign "already running" warning (B's launcher is open).
`ENW-Zombies-Launcher-Setup-0.2.10.exe` 94,563,206 B, sha512 `N/6+t5rT…n/jYig==`;
`https://zombies.enw.gg/updates/latest.yml` answers `200 text/yaml`, `version: 0.2.10`. No site
restart needed or done (the feed is static). No web change in this release.

**B gets it:** leave the launcher open (or reopen it) — it checks the feed on start and the
account menu shows **Restart to update** once it has downloaded; click it. Or quit it from the
tray and run `ENW-Zombies-Launcher-Setup-0.2.10.exe`.

## 2026-09-22, late evening — `publish-update.js` also uploads to the files bucket

Design: [`storage.md`](storage.md). The installer and blockmap now reach players from a public
Hetzner bucket (`enw-zombies-files`, key `updates/<name>`) via a 302 from the site's `/updates`.

* **`npm run pack` is still one command.** After the local copy and its hash check,
  `tools/publish-update.js` uploads the installer, the blockmap and then `latest.yml` (last, so the
  bucket feed never names a missing installer) when `infra\s3.env` has keys, and prints the public
  URLs. No keys → it says so and carries on. `--no-bucket` skips it. A failed upload exits
  non-zero with `node tools/s3/sync.js --only updates` as the retry.
* **The launcher follows the 302 without a change.** Full downloads and the blockmap go through
  builder-util-runtime's `doApiRequest`, which follows any 3xx and strips `Authorization` /
  `Cookie` on a cross-origin hop (`httpExecutor.js:169-176, 286-300`; Electron path
  `electronHttpExecutor.js:64-75`). Map installs (`siteapi.js fetchRaw`, `redirect: 'follow'`)
  behave the same way — proven in `web/test/bucket.js`.
* **Caveat, not fixed:** the generic provider uses multi-range requests for differential updates
  (`providerFactory.js:53`). If the bucket does not answer multi-range, electron-updater falls back
  to a full download (`NsisUpdater.js:170`) — from the bucket. A future release can pass
  `useMultipleRangeRequest: false` to `setFeedURL` (`autoupdate.js`, `updatecheck.js`).


## 2026-09-22 21:20 — 0.2.11 (coordinator): the overlay DLL, Steam-only sign-in, settings into the config

Packaged from main by the coordinator, DLL `599fd632...` from `build/client-lane` (the chat overlay lane's
build, `chat-overlay.md` §9), plus the identity lane's launcher change (ENW name re-read from the site
before every launch; Steam-persona fallback removed) and the settings lane's `wawcfg.js` (site settings
merged into the engine config every launch, read back after exit). Tests 128/0. Published to the feed.

## 2026-09-22 23:55 — 0.2.13 (coordinator): chat overlay round 2

DLL `42ac59da...` (`chat-overlay.md` §10): the menu cursor is drawn centred as the game draws it (the
round-1 overlay drew it from the top-left, so at 2560x1440 the arrow tip sat 48 px from the click —
that is why B could not hit the 54 px tab strip); caret, selection, Ctrl+A/C/X/V via the clipboard,
history copy, wheel scroll, Tab/Shift+Tab, DM tabs, `/w` and `/r`. Tests 134/0 after the version
assertion became a floor (`ce3f453`). Published to the feed and uploaded to the bucket.

## 2026-09-22, late evening — 0.2.12: the update chip, Download on its own, installed maps, the bar

Branch `updates-downloads` (rebased on main after 0.2.11 was published from main; so this is
**0.2.12**). B's four asks: *"detect updates, show it top right, Update now / Restart now / Update
later"*; *"a Download button separate from Play … concise, like Movement"*; *"a list of maps you
have installed with a picture, the name, the title, how many gigabytes … select and remove … sort
by size, in a little box"*; *"a bar before the percentage … the size of the online-player rows"*.
The site half is `web.md`, same date.

### Updates: found by itself, downloaded when the player says

- **One state machine for the UI** (`updatecheck.js`). New: `attach()` listens to electron-updater's
  shared `autoUpdater` **without** checking; `download()` (Update now; a second press is the same
  download — electron-updater returns its in-flight promise); `later()` (a `later: true` flag in
  the status, held in the main process so a reload or the fallback page does not bring the chip
  back; a new launch does). `autoDownload` is now **false**; `describe('available')` is
  `Update 0.2.13 available` (was "…starting the download").
- **The launch-time check** is still the silent lane (`autoupdate.js`), which now takes
  `backgroundDownload` and main.js passes **false**: it finds the update, the chip shows it, and
  the download waits for Update now. Apply-on-quit is unchanged, so an update the player
  downloaded and then said Later to is installed when they quit. `main.js` attaches the chip's
  machine **before** `state.updater.start()` so the check's `update-available` reaches it (both
  lanes share the one `autoUpdater`); only when a feed exists, because `updateCheck()` is built
  once per session.
- **IPC/bridge:** `updateNow`, `updateLater`; `restartAndUpdate` now refuses while a game is
  running (toast *Finish your game first*). Shell Settings gains an **Update now** button beside
  Check for updates / **Restart now**.
- **The fallback page** (`placeholder.html`, what the window shows when the site does not
  answer) draws the same chip in its nav, so an update is reachable with the site down.
- **Dev only:** `ENW_FAKE_UPDATE=<version>` (+ `ENW_FAKE_UPDATE_STEP_MS`) swaps electron-updater
  for `updatecheck.fakeUpdater`, which finds, downloads in 20 steps and logs a fake restart. Guarded
  by `!app.isPackaged`, so no installed copy can ever show a fake update. The screenshots used it.

### Maps: state, the installed list, removal

- `library.dirBytes(dir)` (on-disk size, links not followed) and `library.installedList()`: only
  folders under `P.maps` (= `%LOCALAPPDATA%\ENWZombies\home\localappdata\Activision\CoDWaW\mods`)
  that carry **our** `.enw-installed.json` and that `ownership()` calls `ours`; stock maps never;
  largest first. The player's own WaW mods live in a different folder that nothing reads, and a
  folder in ours without our record is `theirs` and is never listed, so never removable.
- `main.js`: `state.installProgress` / `state.installErrors`; `runInstall` pushes a new
  `mapState` event at start and end. New IPC `mapState(bsp)` → `{installed, installing, pct,
  done, total, error, stock, theirs}`, `installedMaps()`, `removeMaps([bsp])` (refuses a map
  that is still downloading and anything while a game runs; otherwise `library.uninstall`, which
  removes only the files our record lists). Download uses the existing `installMap` →
  `ensureMapInstalled`, so a Download and a later Play or party auto-download share one install.
- Bridge: `mapState`, `installedMaps`, `removeMaps`, `onMapState`.

### Proof

- `npm test` **134 + 14 passed, 0 failed** (new: chip machine end to end on a fake updater — attach
  does not check, Update now before a find refuses, Later, double press = one download, Restart;
  the dev fake walks checking→available→downloading→ready; the silent lane no longer downloads by
  itself and `FAKE_UPDATE` is packaged-guarded; `installedList` is ours-only, on-disk, largest
  first, and uninstall leaves a player's folder alone; bridge names in preload and main; the
  fallback page has the chip; version 0.2.12 and both suites in `npm test`).
- **A dev launcher window** (the real `main.js`, loaded by a scratch harness that stubs protocol
  registration and gives it its own `userData`/`ENW_ROOT`) on a private site on **:3471** holding a
  `VACUUM INTO` copy of the live DB and one fake approved account. Driven over CDP. Screenshots,
  `docs/kickstart/ui/2026-09-22-launcher-0.2.12-*`:
  `update-1-available`, `update-2-downloading` (+ `2b-bar-crop`), `update-3-ready`,
  `update-4-fallback-page` (site stopped; chip on the placeholder; its **Later** hid it and after
  **Try again** the site's chip stayed hidden — `update-5-after-later-crop`); `map-1-download`,
  `map-2-downloading`, `map-2b-downloading-rebased`, `map-3-downloaded`; `settings-1-installed-maps`
  (three maps, largest first), `settings-2-selected-updating`, `settings-3-removed` (two removed;
  the folders were gone from disk and `launcher.log` says `removed 9/12 file(s) ENW installed`);
  `bars-1-page-card-row`, `bars-2-member-row`. Restart now reached `quitAndInstall(true,true)` on
  the fake (logged); no real restart.
- In a plain browser the map page's Download went to `/download?map=…&then=/m/…` and no chip drew.

### Not proven, and one incident

- **A real feed.** Nobody has seen 0.2.12 find 0.2.13 on `zombies.enw.gg/updates`; the chip's
  real path is electron-updater's events, which only the fake drove here.
- **Restart now in a packaged app** (only the fake's log line).
- **INCIDENT (B's desktop, 21:21–21:26 local):** the first two dev windows were "off-screen" at
  x=-2400; Windows/Chromium pulled them back onto B's primary monitor (measured at 810,257), and B
  clicked in them (IPC log: Update now, Restart now ×2 and Try again ×2 on the fallback page,
  Maps, `/settings#combat`). They never took focus (`showInactive`, `focus` stubbed) and
  everything they did was the dev fake and a scratch site. Fixed for the rest of the run: shown at
  **opacity 0, click-through, not focusable, no taskbar button**, tray icon blanked. Separately, one
  mis-quoted relaunch started Electron's **default app window** for about a minute (PowerShell
  `$s`/`$S` are the same variable). Both were killed by PID. Rule for the next agent: a dev
  window is either invisible like this or not started.

### Publish (coordinator)

After merge, from the main checkout: `cd C:\Users\b\Desktop\Zombies\launcher; npm test; npm run pack`
(stage-client → electron-builder → `tools/publish-update.js` into `web/public/updates`, and —
since main's `54f7a95` — up to the files bucket when `infra/s3.env` has keys), then
`node tools/publish-update.js --check` and `https://zombies.enw.gg/updates/latest.yml` must say
`version: 0.2.12`. The site half needs `web/client` rebuilt and the site restarted; deploy the
site first or together — a 0.2.11 launcher on the new site gets no chip (it lacks `updateNow`) and
a Download that still works through `installMap`.

## 2026-09-23 01:45 — the relaunch loop: a party match is followed at most once

B: *"the client keeps booting you back into the game and being really annoying"*. His launcher
started two clients for the same match 25 s apart (DLL logs `enw-35884` 01:03:38 and `enw-2200`
01:04:03, both `m_506fba68`) and the box logged a new `SV_DirectConnect` every few seconds.

**Root cause.** The party watcher (`main.js` `onPlay`) runs on **every** poll of
`GET /api/launcher/play` (0.2 Hz, 1 Hz with a boot screen) and its only guard was `state.flow`.
The site answers "your party is in-game with match X" for the whole life of the lease, so this was
a level trigger: the poll after the player's game exited — `state.flow` back to null — launched X
again, and again. A flow that gave up while the game was still running (a failed step runs
`clear()` without the process dying) had the same hole with a second game beside the first.

**Reproduced, then fixed, in a dev window** (the real `main.js`, invisible, own `ENW_ROOT`, the
poll answered "in-game, `m_loop0001`" every time, the game a stand-in that exits after 5 s through
`GameLaunch` → `BootFlow` → `ended`): HEAD launched **5 games in 45 s** (`party following
m_loop0001` every 10 s); the fix launched **1** and then logged, once, *not launching: already
launched m_loop0001 (followed, …, and that game ended at …); only Play or Resume sends the player
back in*. `resumeMatch('m_loop0001')` from the site view launched exactly one more.

**The rule** (`src/main/followgate.js`, used by `onPlay` and `startPlay`):
- a match id is followed **at most once**; the ledger records every launch whose match id is known
  (followed, Play, Play Local — `flow.on('update')`) and when it ended;
- **never while a game this launcher started is alive** — the `GameLaunch.pids` set, which includes
  a Steam-restarted pid the nanny adopted — whatever `state.flow` says. `startPlay` refuses too
  (*World at War is still running. Close it first.*), so no button can start a second game either;
- no match id, no follow;
- only the player sends us back in: Play (not gated by the ledger), or the new bridge call
  **`window.enw.resumeMatch(matchId)`** (IPC `resumeMatch`), which lifts the ledger for that match
  and follows it at once if the last poll still names it. **The site's Resume button should call
  it** (web lane);
- every decision that changes is logged once (`party launching: …` / `party not launching: …`),
  not once per poll.

**The launcher's log** is still `%LOCALAPPDATA%\ENWZombies\logs\launcher.log` (`main.js` `LOG`,
`P.logs`); the `enw-<pid>.log` files beside it are the client DLL's, one per game. Trap for agents:
inside the Claude desktop app (MSIX) this path is overlaid by a stale twin at
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\ENWZombies\logs\launcher.log`
(written by an agent on 2026-09-22 20:23), so an agent reading it sees 16 KB from yesterday, not
B's current log. B, or a process outside the container, reads the real one.

`npm test` 137 + 14, 0 failed (three new: the loop sequence incl. a Steam-restarted pid and 60
polls after exit; new match / Resume / no id; main.js wiring).

## 2026-09-23 02:30 — after a game, the nav is clickable at once

B: *"When you close the game, there's a brief period where you can't click on the launcher, like
the top navigation bar."*

**Root cause: the 0.2.10 fix depended on the shell page painting, and a covered page does not paint.**
0.2.10 hid the shell's `#chrome` strip (62 px, `-webkit-app-region: drag`) while the site shows, by
calling `showSite(true)`: `siteView.setVisible(true)` first, then toggling `html.site-shown` in the
shell. Measured in a dev window: once the site view is visible, Chromium marks the shell
page under it hidden (`document.visibilityState === 'hidden'`, `requestAnimationFrame` never
fires). A hidden page runs no lifecycle update, and the lifecycle update is where Electron sends a
frame's drag regions to the window. So the class changed, the `display:none` was never laid out,
and the strip's old drag region kept answering the window's hit test. On a frameless window the
BrowserWindow's own webContents' regions win (0.2.10), so Maps, Records, the logo, **Update now**
and the **account chip** answered `HTCAPTION` and a click became a window drag. After a game the
launcher shows its boot screen, and **Back to the site** / **Close** is the `showSite(true)` that hits
this. So does every other way out of a shell screen.

Ruled out, measured: `setIgnoreMouseEvents` (never called in the launcher); the window being
minimised or refocused late (nothing minimises it; `raiser.flush()` only raises a deferred deep
link); a site reload on exit (the site does not listen for `boot`/`boot_done`); the DLL focus guard
(the game is gone). Windows' foreground-lock would eat at most one click, and Chromium activates
on click.

**Numbers** (`ui/2026-09-23-launcher-after-game-timing.md`, WM_NCHITTEST at ~3 ms resolution):
- HEAD: the nav never came back within the 2.4 s window in 15 of 15 trials (10 settings→Back,
  5 game→boot screen→Back). It was still dead 30 s later, and the same with Chromium's native
  occlusion on.
- Fix: dead time after the site appears is **0 ms** for Maps, Update now and the account chip in
  every trial (10 + 5 with occlusion off, 10 + 3 with it on). The site appears 50–58 ms after the
  click instead of about 5 ms.

**Fix** (`main.js`):
- `showSite(true)` now hides the strip **first** (`stripGone()`: toggle the class, two
  `requestAnimationFrame`s and a 40 ms settle in the shell, which is still visible at that point;
  bounded at 300/400 ms). Only then does it call `siteView.setVisible(true)`. A generation counter
  lets a later `showSite()` cancel a pending show. So the game-ended sequence (the `ended` handler
  shows the site, then `boot_done` reopens the boot screen 15 ms later) no longer flashes the site.
- The shell's `webPreferences.backgroundThrottling: false`: the shell keeps painting while it is
  covered, so its regions reach the window whatever the order (24–37 ms on its own). The shell has
  no running animations, so it costs nothing while a game runs.
- `state.siteShown` makes a `showSite(true)` that happens while the site is already visible (deep
  links, `openSitePath`) immediate, as before.

**Proof**: dev window as in 0.2.12 (invisible, own everything), stand-in game `node` sleeping 6 s
through `GameLaunch`/`BootFlow`, a scratch site on :3419, and clicks through CDP
`Input.dispatchMouseEvent`. Screenshots: `ui/2026-09-23-launcher-after-game-1-boot-screen.png`
(what the launcher shows after the game exits) and `-2-nav-live-account-menu.png` (account chip
clicked 150 ms after Back: the menu opens and the update chip sits in the nav). `npm test`
138 + 14, 0 failed (the 0.2.10 test follows the new shape; a new test pins the order, the
generation check, the bound and `backgroundThrottling: false`).

**Unproven:**
- **B's real mouse.** WM_NCHITTEST is Windows' routing decision for a real click, so it is the best
  evidence available here.
- **Why B's window recovers "after a moment"** while the dev window never did (>30 s). Something in a
  visible, focusable window with a real mouse must make the shell paint again (an activation or
  occlusion recompute, perhaps). With the fix there is nothing left to recover from.
- **A window minimised or in the tray when the site is shown.** `stripGone()` gives up after
  300 ms and shows the site anyway. `backgroundThrottling: false` should still let the strip's
  removal reach the window, but that case was not measured.


## 2026-09-23 01:45 — mod compatibility: the files are the server's, and the mod's dvars are the mod's (`mod-compat.md`)

Two launcher changes, both small and both in `src/main/modcompat.js` (tests: `test/modcompat.js`,
6/6; `npm test` now runs it):

1. **Pre-launch check.** `ensureMapInstalled` no longer answers "already installed" on the record
   alone: `matchServer()` compares the folder with the site's file list (size, SHA-256; size+mtime
   cached after the first proof), removes a stray `.ff`/`.iwd` the server does not load, and
   re-downloads only the files that differ through `installFromSite(bsp, { only })`. Offline or no
   site: skipped.
2. **Mod-owned dvars.** Minecraft Village's anti-cheat sets `monkeytoy 1`; the read-back saved it as
   B's choice and every launch since carries `+set monkeytoy 1` (console off on every map). The
   read-back now drops changes to any dvar the map just played sets itself — found by scanning its
   fastfiles and loose scripts once, cached as `modDvars` in `.enw-installed.json`. For this map:
   `cg_fov monkeytoy cg_mature cg_blood`. B's saved `waw.monkeytoy` is not auto-repaired.

Also: `library.js ALLOWED_EXT` (and the site's `mapfiles.js ALLOWED`) take `.iwi .csc .bik .menu
.str` and extension-less weapon files — Futurama's 145 loose images/scripts, Arena's 65 and Five
Nights' loose weapon files and three load videos were on the box and never reached a player
(`mod-compat.md` §5).

## 2026-09-23 03:30 — Releases 0.2.14–0.2.20 (written at the handoff; these had commit messages and no section here)

Every one was packaged from main by the coordinator, published to the feed and uploaded to the bucket
(`publish-update.js`). The DLL column is the first 8 hex of the staged `enw_t4.dll`'s sha256, as the
release commit names it. The detail of each change is in the lane doc named.

| Version | Commit (UK) | Client DLL | What it carried | Detail |
|---|---|---|---|---|
| 0.2.14 | `2f41011` 01:09 | `567b0321` | Esc pauses on a box (the refused load video no longer swallows Esc; `cl_paused` not local-only); client clock held while the server is frozen | `chat-overlay.md` §11 |
| 0.2.15 | `ea7ac29` 01:13 | `567b0321` (same) | The relaunch loop is gone: each party match is followed at most once (`followgate.js`); `enw.resumeMatch` for the rail's Resume | this file, 2026-09-23 01:45 |
| 0.2.16 | `afed591` 01:26 | `567b0321` (same) | Nav clickable straight after a game (strip hidden and painted before the site shows) | this file, 2026-09-23 02:30 |
| 0.2.17 | `2e79ab3` 01:45 | `d26831d2` | ENW Esc menu; direct boot into zombies (no Online Service popup, no main menu); pre-launch map file check + repair; mod-owned dvars never saved from a map; loose map files | `esc-menu.md`, `client.md` §10, `mod-compat.md` |
| 0.2.18 | `58e4842` 02:15 | `1b103258` | Overlay and Esc menu always in the stock WaW font (from the player's own files, hash-checked) | `chat-overlay.md` §12 |
| 0.2.19 | `f0eff31` 02:45 | `f11dc67c` | Hang watchdog (stack + minidump after 8 s silent in a map); stock-font search on a worker thread, material span 8192 | `chat-overlay.md` §12.4 |
| **0.2.20** | `071d4d8` 03:03 | **`03b04bc3`** | Join retry: a "not ready yet" refusal waits (*Waiting for the server...*, every 2 s for 60 s) instead of a fatal error. Same binary as the box's join-fix build (main `81086d4`) | `client.md` §11, `dedi.md` §21 |

**On the feed at handoff: 0.2.20** (`https://zombies.enw.gg/updates/latest.yml`, installer 302 to
`enw-zombies.nbg1.your-objectstorage.com/updates/…`, checked 03:27 UK).

**Not in any release yet:** `net_probe_client.cpp` (main `fd29f8f`, client side of `dedi.md` §22) and
the `rate 25000` / `snaps 30` / `cl_maxpackets 100` baseline that §22.4 asks this lane for. Also still
wrong: the launcher's volume setting writes `snd_volume`, which is not a dvar in this exe (the real one
is `snd_menu_master`; `client.md` §10).

## 2026-09-23 05:00 — Discord rich presence: states, assets, setting, B's checklist

B: ENW Zombies as the app name, the ENW logo in the menus, the map's picture in a game, Solo / party
size, the round, the elapsed time, and one switch. `src/main/discord.js`, tests
`test/discord-presence.js` (22, in `npm test`).

**Prior art.** ENW Movement (`CSGO-Matchmaker`) has no Discord Rich Presence. Its only "rich
presence" is Steam's (`bot/lib/steam-real.js` `uploadRichPresence`), so there was no app id,
library or asset naming to reuse. No Zombies Discord application id was in the repo, `infra/` or the
vault, so the id is a config value (below) and B creates the app.

**No dependency.** Discord's local IPC is a named pipe (`\?\pipe\discord-ipc-0..9`). Each frame is
an 8-byte header (op, length, int32 LE) and a JSON body: handshake `{v:1, client_id}`, then
`SET_ACTIVITY {pid, activity}`. Leaving `activity` out clears it. The module also answers
ping/pong, handles CLOSE (e.g. 4000 Invalid Client ID) and treats READY as connected.

**States** (Discord shows the app name, then `details`, then `state` + party size):

| Launcher knows | details | state | party | large image | small image | timer |
|---|---|---|---|---|---|---|
| no game, no party (or a party of 1), signed out, placeholder | Browsing maps | – | – | `enw` | – | – |
| party of 2–4, no game | In a party | staged map name, else "In the lobby" | n of 4 | `enw` | – | – |
| a flow is running, game not started yet | map name | Loading | n of 4 if party | map card | `enw` | – |
| in game, solo | map name | Solo · Round 7 (or "Solo" before a round is known) | – | map card | `enw` | since the game process started |
| in game, party | map name | Round 7 (or "In game") | n of 4 | map card | `enw` | since the game process started |
| Verified | as above | as above | | | hover text "Verified" | |
| setting off | nothing (cleared) | | | | | |

- **Map name**: the flow's title, else the site's catalogue title, run through the site's own
  `prettyTitle` rule (copied, because the packaged launcher has no `web/`), else the bsp without
  `nazi_zombie_`.
- **Party size and round come from the /play poll the launcher already runs** (0.2 Hz, 1 Hz with a
  boot screen). They are only used when the poll names *this* game's match id, so a stale party never
  lends its size. The round is a new field on that poll, `match.round`, read from the live frame the
  box already pushes to the site (`lib/live.js`, in memory). Nothing polls the game. A Play Local
  run uses its own relay's `frame.round`.
- **Map picture**: `https://<site>/media/maps/<stem>.thumb.webp?v=…` (400 px) beside the catalogue's
  `art`. Discord's image proxy has to fetch it without the beta password, so `middleware/gate.js`
  now exempts **only** `^/media/maps/<stem>(.thumb)?.webp$`, the map-card picture and nothing else.
  A non-https site (dev) or a map with no art uses `enw` as the large image instead.
- **Never sent**: Steam ids, names, the server address, the match id, the party code, the invite
  token, join secrets, buttons. A test serialises the payloads and checks for each one.

**Robustness.** The Presence object is created after the window and tray, never in `startPlay`,
`BootFlow` or the Steam check. It only adds `flow.on('launched' | 'update')` listeners and one call
per poll. Every entry point is synchronous and wrapped (`refreshPresence` catches everything), and
every socket has an `'error'` handler. If Discord is not running, the launcher tries pipes 0–9 and
then retries after 2 s, 4 s, 8 s … up to 60 s. It logs once, not every time. When Discord starts
later, the next retry picks it up and sends the current activity. When Discord quits, the retries
start again. Updates are deduplicated and throttled to one every 4 s (Discord allows about 5 per
20 s); a burst sends only the last one. The game exiting returns to the menus state. Quitting the
launcher (`before-quit`) clears the activity and closes the pipe (Discord would also clear it when
the pipe closed). Turning the setting off clears it at once, closes the pipe and stops retrying.

**Setting**: `discordPresence` (default on), one switch.
- Launcher: `settings.js` `DEFAULT_SETTINGS`, `validate`, `GAME_KEYS`.
- Shared schema: web `data/wawSettings.js` `ENW_ITEMS` + `LAUNCHER_KEYS`, which is what lane 4's
  in-game Esc-menu Settings tab reads.
- Site: `lib/users.js` `GAME_KEYS`; `/settings` → ENW → "discord / rich presence"
  (`settingsLayout.js`; `Settings.jsx` now draws the ENW tab's catalogue groups under
  `EnwSection`).
- Launcher's own settings screen: "Discord rich presence".
- `setSettings` calls `refreshPresence()`, so a change applies immediately.

**The application id.** Order: `ENW_DISCORD_CLIENT_ID` env > `state/config.json` `discordClientId` >
the site's `/api/launcher/hello` `discord_client_id`, from **`ZM_DISCORD_CLIENT_ID` in
`infra/site.env`** > `config.js` `DEFAULTS.discordClientId` (empty). With no id the feature does
nothing and logs `no Discord application id configured` once. The site route means B's id reaches
every installed launcher at its next start, with no release.

### B's checklist (two minutes)

1. https://discord.com/developers/applications → **New Application** → name it **ENW Zombies**
   (this is the name Discord shows: "Playing ENW Zombies"). Set the app icon to the ENW mark too.
2. **Rich Presence → Art Assets → Add Image(s)**: the ENW mark as a PNG, at least 512×512 (e.g.
   `launcher/src/renderer/assets/icon-256.png` upscaled, or the site's mark exported to PNG). Name
   the asset **`enw`** exactly. Save. Assets can take a few minutes to appear.
3. **General Information → Application ID** → copy it. Paste it into `infra/site.env` as
   `ZM_DISCORD_CLIENT_ID=<id>`, then let the site cycle (keepalive). Every launcher picks it up at its
   next start. For one PC only, `state/config.json` `"discordClientId": "<id>"` also works.
4. Open Discord, restart the launcher. Your profile should say *Playing ENW Zombies · Browsing maps*.

### Not proven

- **A real Discord client.** Discord is not installed or running on this machine, and there is no
  application id yet. Everything above was driven against a fake Discord on a real named pipe that
  speaks the same framing. So these have never been seen on a real profile:
  - the wording as Discord renders it;
  - an https **webp** URL accepted as `large_image`. Discord has proxied external https images for
    RPC since 2023, but webp through that proxy has not been checked. If the card shows a blank
    square, the fallback is one line in `mapImage()`: return null, so it uses `enw`;
  - whether the party size shows without a `party.id` (none is sent, deliberately).
- **The real launcher window.** The wiring is covered by source tests. No dev Electron window was
  started, because B's launcher was running on this desktop.
- **`match.round` on a live box game.** The code reads the same in-memory frame as `/live`. It has
  not been watched during a real game.
