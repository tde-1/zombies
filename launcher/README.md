# launcher

The ENW Zombies launcher: the Electron app a player installs. It finds your World at War, installs
the ENW client into a folder of ours, wraps the site, and turns "press Play" into a running game.

---

## Try it (B — this is the whole thing, from nothing)

Four commands, two windows. Assumes nothing.

```powershell
# 1. the site, in its own terminal — leave it running
cd C:\Users\b\Desktop\Zombies\web
npm install
npm start                      # ENW Zombies on http://127.0.0.1:3200

# 2. the launcher, in a second terminal
cd C:\Users\b\Desktop\Zombies\launcher
npm install
npm start
```

If `npm start` says **"Electron failed to install correctly"**, see *Electron won't start* below —
it is one command.

### What you will see

1. **The launcher opens.** The site is on the left (the real one, on `:3200`), our rail on the
   right. The top bar shows `site: 127.0.0.1:3200` and `client: installed` (or not, first time).
2. **First run only — a setup screen.** It will already have found your World at War and say
   `verified`, with the exact folder, the version and the SHA-256 it matched. Press **Install the
   ENW client**. It takes a second and writes ~8 MB to `%LOCALAPPDATA%\ENWZombies`. **Your Steam
   copy of World at War is not touched** — the screen lists exactly what it changed, and the
   installer checks the folder before and after to prove it.
   *If it did not find the game*, press **It is somewhere else** and pick any folder near it —
   the Steam folder, the `common` folder, even `main` inside the game. It searches up and down and
   corrects itself. **Show everything we checked** prints every route it tried and why.
3. **Sign in** (top right). Mock sign-in: it uses the Steam account already signed in on this PC,
   so the SteamID is real. Steam OpenID needs the live site.
4. **Pick a map** in the rail. Four stock maps first, then the 14 rescued ones — *Alcatraz*,
   *Leviathan*, *CLINIC OF EVIL* and so on, each with its `bsp` name small underneath and its
   download size on the right.
5. **A rescued map you have not installed shows `Install (453 MB)` instead of Play.** Press it; it
   copies from the archive on this box and checks every file against the hash the archive recorded.
   A few seconds.
6. **Press `Play Local`.** A boot screen replaces the site: *Playing locally → Map → Ready →
   Launching World at War → In game (untracked)*. World at War opens in a small window and loads
   the map. Anything the launcher could not confirm is labelled **SIMULATED** on that screen, by
   name — if it says simulated, do not believe it.

**Play Local is the path that works today.** The big red **Play** button (our servers) gets as far
as a real server being reserved and then stops, because no dedicated server accepts clients yet.

### If something goes wrong

* **"World at War is already running"** — another agent's test game is up, or one did not exit.
  Close it and press Play again. The launcher refuses rather than starting a second one.
* **The map does not appear and the game sits there** — the boot screen will tell you where it
  installed the map. World at War loads custom maps from `%LOCALAPPDATA%\Activision\CoDWaW\mods`
  and nowhere else; anywhere else fails silently and looks fine.
* **Undo everything** — Settings → **Remove the ENW client**. It asks whether to keep your
  downloaded maps, removes only files it installed, and never touches a map you installed yourself
  (your `nazi_zombie_ali` is safe).

---

## The commands, for everyone else

```bash
cd launcher
npm install
npm test                          # 41 checks, no Electron, no game
npm run test:launch               # spawns a stand-in "game" and checks what it received
npm start                         # the app

node src/main/detect-cli.js                        # find WaW and explain every step
node src/main/detect-cli.js --browse "C:\wherever" # the forgiving browse fallback
node src/main/setup-cli.js install                 # install the ENW client
node src/main/setup-cli.js uninstall               # and put it back
node src/main/maps-cli.js list                     # the archive's maps: title AND bsp
node src/main/maps-cli.js install nazi_zombie_leviathan
node src/main/play-cli.js --dry-run                # the exact command line, nothing started
node src/main/play-cli.js --map nazi_zombie_leviathan --local \
  --fs-game mods/nazi_zombie_leviathan --visible --seconds 120     # takes game.lock
node test/slice.js --map nazi_zombie_leviathan     # site + host agent + game, one run
node tools/crash-sink.js                           # local crash endpoint (127.0.0.1:8791)

ENW_SMOKE_MS=5000 npx electron .                   # boot, report, quit — no window left
```

Environment: `ENW_ROOT` moves the install folder, `ENW_SITE_URL` pins the site, `ENW_ARCHIVE`
points at the map archive, `ENW_DEV_ROOT` moves (or disables) the shared game lock.

Full notes, measurements and what is still faked: **`../docs/kickstart/launcher.md`**.

## Releasing a new version

Three friends run a packaged exe and we change things under them for weeks, so the updater is the
thing that must not break. Its rule is **check on launch, apply on the next launch** — never
mid-game, never mid-download.

```powershell
cd launcher
# 1. bump the version. This is what the updater compares against.
npm version patch --no-git-tag-version      # 0.1.0 -> 0.1.1

# 2. build
npm run pack
```

**What comes out**, in `launcher\dist\`:

| File | What to do with it |
|---|---|
| `ENW-Zombies-Launcher-<version>.exe` | the launcher. Upload it **and** send it to anyone new. |
| `latest.yml` | the feed index — version, file name, sha512. **Upload it last.** |
| `*.blockmap` | upload it if present; it lets an update download only what changed |
| `win-unpacked\` | intermediate, do not ship |

**Upload all of those to the same directory**, whatever it is: a Cloudflare R2 or Hetzner bucket,
or `web/public/updates/` on the site. That directory's URL is the feed.

Upload `latest.yml` **last**. It is the file that says "there is a new version"; if it arrives
before the exe, every launcher that checks in between tries to download something that is not there
yet. It fails soft — they stay on the version they have — but it is a pointless scare.

**Point launchers at it** with `updateFeed` in the launcher's config, or `ZM_UPDATE_FEED`. If
neither is set it uses `<site>/updates`, so putting the files under the site needs no configuration
at all.

Nothing is signed, so Windows SmartScreen will warn on a new version exactly as it did on the first.

### If an update goes wrong

It is meant not to. No feed, a bad feed, no network, a half-downloaded file: the launcher starts
and plays on the version it already had, and the rail says `Updates: could not check`. To back out
a bad release, put the previous `latest.yml` and exe back — `allowDowngrade` is off, so also bump
the version past the bad one rather than relying on people downgrading.

The rail always shows the running version, so "are you on the latest?" is one screenshot.

## Three rules this code exists to keep

* **The player's copy of World at War is never written to.** One `assertWritable()` guards every
  write, the install is fingerprinted before and after, and uninstall unlinks before it deletes.
* **The invite token is never on a command line.** It goes over a one-shot named pipe.
* **No box secret on a player's PC.** Every site call is the player's own session cookie;
  `x-match-secret` appears nowhere in this folder.

## Layout

| Path | What |
|---|---|
| `src/main/detect.js` | every Steam route, validation, the forgiving browse search |
| `src/main/setup.js` | the ENW folder: junctions, the proxy DLL, the manifest, uninstall |
| `src/main/library.js` | the map library: install, verify, repair, never touch the player's maps |
| `src/main/launch.js` | the command line, the token pipe, the dialog nanny, log watching |
| `src/main/bootflow.js` | Reserving → Loading → Ready → Launching → In game, and Play Local |
| `src/main/siteapi.js`, `localrun.js` | `docs/protocol/launcher-v0.md`, our half |
| `src/main/main.js` | window, tray, the wrapped site view, deep links, IPC |
| `src/renderer/` | the chrome: corner card, first-run wizard, boot screen, settings |
| `tools/window-nanny.ps1` | answers the modal dialogs that block an unattended boot |

## Electron won't start

Symptom: `Error: Electron failed to install correctly`. The postinstall downloaded the zip but did
not extract it.

```powershell
$dist = 'launcher\node_modules\electron\dist'
Remove-Item -Recurse -Force $dist; New-Item -ItemType Directory -Force $dist
Expand-Archive "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v38.8.6-win32-x64.zip" $dist -Force
'electron.exe' | Out-File -Encoding ascii -NoNewline 'launcher\node_modules\electron\path.txt'
```
