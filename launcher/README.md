# launcher

The ENW Zombies launcher: the Electron app a player installs. It finds their copy of World at War,
installs the ENW client into a folder of ours, wraps the site, and turns "press Play" into "you are
in a zombies game".

Full notes, measurements and what is still faked: **`../docs/kickstart/launcher.md`**.

```bash
npm install                      # Electron 38; see launcher.md §8 if the binary does not extract
npm test                         # 35 checks, no Electron and no game needed
npm start                        # the app

node src/main/detect-cli.js                        # find World at War and explain every step
node src/main/detect-cli.js --browse "C:\wherever" # the forgiving browse fallback
node src/main/setup-cli.js install                 # install the client into %LOCALAPPDATA%\ENWZombies
node src/main/setup-cli.js uninstall               # and put everything back
node src/main/play-cli.js --dry-run                # the exact command line, nothing started
node tools/crash-sink.js                           # the local crash endpoint (127.0.0.1:8791)

ENW_SMOKE_MS=5000 npx electron .                   # boot, report, quit — no window left on screen
```

Two rules this code exists to keep:

* **The player's install is never written to.** One `assertWritable()` guards every write, the
  install is fingerprinted before and after, and uninstall unlinks junctions before it deletes
  anything. See `src/main/paths.js` and `src/main/setup.js`.
* **The invite token is never on a command line.** It goes over a one-shot named pipe.
  See `src/main/launch.js`.

Layout:

| Path | What |
|---|---|
| `src/main/detect.js` | every Steam route, validation, the forgiving browse search |
| `src/main/vdf.js`, `pe.js`, `winreg.js` | dependency-free VDF, PE and registry reading |
| `src/main/setup.js` | the ENW folder: junctions, the proxy DLL, the manifest, uninstall |
| `src/main/launch.js` | the command line, the token pipe, the dialog nanny, console watching |
| `src/main/bootflow.js` | Reserving server → Loading map → Ready → Launching → In game |
| `src/main/main.js` | window, tray, the wrapped site view, deep links, IPC |
| `src/renderer/` | the chrome: corner card, first-run wizard, boot screen, settings |
| `tools/window-nanny.ps1` | answers the modal dialogs that block an unattended boot |
