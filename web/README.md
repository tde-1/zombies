# web — zombies.enw.gg

The ENW Zombies website: a port of ENW Movement with the nouns changed.
Express + better-sqlite3 + socket.io + React/Vite. Everything runs on this PC.

## Start it from cold

Paste this, top to bottom, from the repo root. It takes about a minute, mostly `npm install`.

```bash
cd C:\Users\b\Desktop\Zombies\web
npm install
npm run build
npm run seed -- --reset --demo
npm run import:archive -- --catalogue
npm run dev
```

Then open:

### http://127.0.0.1:3200

Sign in from the button in the top right. **It is not Steam** — it is a local development
page; click any name on it (Dexter is an admin) and you are that person. It makes a row in
the local database and nothing leaves this machine.

You should see **19 playable maps** (the four Treyarch ones, `nazi_zombie_ali`, and 14 the
archive pipeline rescued), **2,284 maps in the archive**, and some demo games, records and
badges so the pages are not empty.

### What each command does

| | |
|---|---|
| `npm install` | the server's four dependencies |
| `npm run build` | installs and builds the React client into `client/dist` |
| `npm run seed -- --reset --demo` | wipes and rebuilds the database from `referee/manifests/*.json`, then adds four demo players and six games so nothing is empty. Drop `--demo` for a site with no fake players in it |
| `npm run import:archive -- --catalogue` | the archive agent's 14 rescued maps, plus the 2,265-map crawl index behind the Archive page. Drop `--catalogue` for just the 14 |
| `npm run dev` | the server, on 127.0.0.1:3200 |

Nothing above reaches the internet. There is no cloud anything, no ENW call, no Steam call.

### If something looks broken

The home page carries an **Early build** notice listing what is not built yet, so you never
have to guess. `npm run check` runs 55 in-process checks in a few seconds.

To start over: `npm run seed -- --reset --demo` again (it is safe to re-run, as is the
archive import).

## What is faked

Sign-in (a local page, not Steam) · ENW names and VIP (not connected) · map art (missing, so
cards show the engine name) · badge art (a hexagon with the map name) · the launcher, so Play
Local and map downloads have nothing to launch or fetch.

Everything else — the archive, games, XP, records, badges, the live view, the game boxes and
their signed replays — is real. **`docs/kickstart/web.md` is the full account** of what runs,
what is stubbed and why.

## Working on it

```bash
npm run client        # Vite dev server on :5173, proxies /api and /socket.io to :3200
npm run check         # 55 in-process checks, no server needed
```

Licence: AGPL-3.0-or-later (vault 99 §0.3 — the server is open-sourced under AGPL because of
its network use).
