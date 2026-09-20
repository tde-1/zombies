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
node src/main/detect-cli.js                   # find World at War and explain every step
node src/main/detect-cli.js --browse "C:\..." # the forgiving browse fallback, from a folder
node src/main/detect-cli.js --json            # the same as a machine-readable report
node src/main/setup-cli.js install            # install the ENW client into %LOCALAPPDATA%\ENWZombies
node src/main/setup-cli.js status
node src/main/setup-cli.js uninstall          # --delete-maps to drop the map library too
node src/main/play-cli.js --dry-run           # the exact command line, nothing started
node src/main/play-cli.js --map nazi_zombie_prototype --seconds 40   # takes game.lock

npm start                                     # the actual app
ENW_SMOKE_MS=5000 npx electron .              # boot it, report what came up, quit (no window)
ENW_SMOKE_MS=5000 ENW_SMOKE_SHOT=1 npx electron .   # …and save screenshots to the log folder

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

### The game lock

`gamelock.js` honours `ZombiesDev\locks\game.lock` exactly as `dev-box.md` rule 5 describes: takes
it, writes the pid once the game starts, releases it on exit, treats it as stale after 15 minutes or
a dead pid, and **only ever releases its own** (if another agent has taken it since, it is left
alone). On a machine with no `ZombiesDev` the whole thing is a no-op, which is the player case.

---

## 4. The shell

`src/main/main.js` + `src/renderer/`. Electron 38, `contextIsolation` on, `nodeIntegration` off, one
preload (`src/preload/preload.cjs`) that is the entire API surface.

* **It wraps the site.** The site is a native `WebContentsView`; our chrome is a normal page around
  it. At startup the launcher probes, in order: `127.0.0.1:8099`, `:3000` (the `web/` agent),
  `:8080` (the mock site), `:8787` (the host agent's dashboard), and falls back to a bundled
  placeholder page that says so. Pin one in Settings or with `ENW_SITE_URL` — **no rebuild needed to
  point it anywhere.**
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
| Command line + environment | **Real** |
| Token over a named pipe | **Real launcher-side**; the DLL does not read it yet |
| Dialog answering, SteamStub pid adoption | **Real** (ported from launch.ps1 + referee's fix) |
| Game lock | **Real** |
| Reserving a server + invite token | **Real** against `mock-site`; no production site exists |
| "Loading map" / "Ready" / "In game" confirmations | **Real when a host agent answers**, otherwise labelled SIMULATED in the UI |
| Electron shell, tray, deep links, settings, idle-gated refresh | **Real** |
| Crash reporting | **Real**, to a local endpoint |
| Sign-in | **Mocked.** It reads the SteamID this PC is signed into, so the ID is real; Steam OpenID needs the site and a secret we do not have locally |
| The map list in the rail | **Placeholder**, and labelled as one in the UI |
| Map art | **Placeholder** (gradient); comes from the site |
| Map downloads / Storage page | **Not built** |
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
