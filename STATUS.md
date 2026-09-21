# Where things stand — 2026-09-21, end of session

## The one thing to do next

**Install `launcher\dist\ENW-Zombies-Launcher-Setup-0.1.0.exe` (built 18:02) and press Install the
ENW client.** Your client genuinely is not installed — see the correction below — and the Install
button genuinely could not work until this build. Then `TESTME.md`: Play Local on Nacht der Untoten,
get past round 1, and run `node launcher\tools\last-run.js`.

## A correction, because it was reported wrong

Earlier in the session I told B *"the client IS installed, the backend knows it, the UI is lying."*
**That was wrong, and it was wrong for an interesting reason.**

Agents run inside the Claude desktop app's MSIX container, where writes under `%LOCALAPPDATA%` are
silently redirected to `…\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\`. So an agent
running `setup install` writes into a private copy, an agent running `setup-cli.js status` then
confirms "Installed: yes" — and the launcher B starts from Explorer reads the real path and correctly
says no. Same binary, same minute, opposite answers depending on who started it.

**Retract anything of the form "I verified X under `%LOCALAPPDATA%`" from an agent session.** It was
verified in a sandbox. `npm run smoke` now detects the redirection by writing a probe file and looking
for it at the redirected path.

B's report was right twice over: the client was not installed, *and* the Install button could not
install it.

## What is live

- **https://zombies.enw.gg** — behind HTTP Basic, password `CrazyTime`. A watchdog
  (`infra/keepalive.ps1`) checks the site and the tunnel every 30 s and restarts whichever is
  missing; it has already caught three outages today.
- **Real Steam sign-in**, which turned out to need **no API key** — sign-in is OpenID and the key only
  buys persona names and avatars. Names fill in later with no migration.
- **The launcher update feed** at `/updates`, exempt from the beta gate so a friend's client can
  actually update.
- Tests: **55 + 27 + 8, zero failures.**

## Fixed today, in rough order of how much they were costing

| | |
|---|---|
| The Install wizard rendered **behind** the site's `WebContentsView` | Every click landed on a web page. One line of CSS and a missing IPC call |
| `status()` was seven disk/network fields in **one try/catch** | Any one throwing returned `{ok:false}` and the screen read "client: not installed" — an absence rendered as a fact |
| `window-nanny.ps1` **had never parsed** | A PowerShell interpolation error. Nothing has ever been answering the game's blocking modals, and a script that fails to parse prints nothing — which looks exactly like a script that saw no dialogs |
| The nanny threw away the dialog **message** | It logged the title and buttons and dropped the sentence saying what was wrong |
| `playLocal` passed an object to `path.join()` | The actual bug behind "I pressed Play and nothing happened" |
| The client DLL loaded **from inside `app.asar`** | Worked only because Electron patches `fs` for that one process |
| Four files used `new URL(import.meta.url).pathname` | Does not URL-decode: any player whose Windows username has a space gets `%20` |
| `mapPayload()` listed **provenance** files, not servable ones | Leviathan advertised a `.exe` installer as the thing to install |
| `/updates/latest.yml` returned **HTML with a 200** | The SPA catch-all swallowing the update feed; electron-updater was parsing a web page as YAML |
| Local matches lived in an **in-memory Map** | A site restart mid-run lost the game — 404, forty minutes gone |
| `rounds: "abc"` stored **NULL** with a 200 | `Number(x\|\|0)` is NaN and SQLite binds NaN as NULL silently |
| `.env` was **not gitignored** on a public repo | A key pasted into `web/.env` would have been committed |

## The dedicated server

The recorded blocker was a **misdiagnosis and has been retracted in writing** — the "stuck in a sleep
loop" stack was what a *healthy* headless server looks like. The real fault: the SP engine connects its
own local client after the map loads, co-op refuses a join-in-progress, that drops the server, and it
deadlocks on the sound driver during fallback.

10-minute soak: **37,875 frames, flat 61 Hz, 4.85% of one core, RSS unchanged from t=10 s to t=620 s,
zero errors.** Down from a runaway 515 Hz.

**A client now connects** — `CS_FREE → CS_CONNECTED`, map loaded, 275 packets. It does **not spawn in**.
Five engine gates were cleared to get there, including: T4 routes connected traffic through Demonware's
`bdSocketRouter`, which drops every packet for a second process. That is very likely why Plutonium ships
its own binary rather than patching the stock one.

## Known and unfixed

- **Only stock `nazi_zombie_prototype` is playable.** Three custom maps install perfectly, load, render,
  run at 62 fps, and their server script is dead on arrival with three different GSC errors. The
  custom-maps lane was mid-investigation; the open question is whether the maps are broken or *we load
  them wrong*. Until that verdict, no map is marked `broken` on the site — that would be a false claim.
- **Round detection past round 1 is unproven.** An unattended game never advances, so this needs a human.
- **The nanny's `message` capture is unproven against a real game modal** — only against the parser.
- **B's off-screen error boxes are not explained.** `-Park` was checked and is *not* leaking into player
  launches, so it is something else.

## Specced, deliberately not built

- **Ghosts** (`vault 13 §4a-3`) — another player's position drawn in your game. Position only, by B's
  decision. Viable: three of the four links already exist; the rendering is the new work.
- **Boards** (`vault 10 §3b`) — Vanilla / ENW-Verified / Open, on one principle: *a patch that removes a
  crash is allowed; a patch that changes difficulty is a different board.* And a warning: the round-163
  health overflow makes high rounds **easier**, so every existing record depends on it. Do not "fix" it.
