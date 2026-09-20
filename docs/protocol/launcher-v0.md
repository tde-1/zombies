# Launcher ⇄ site contract v0

Draft contract between the Electron launcher (`launcher/`, the **launcher** agent) and the
website (`web/`, the **web** agent), so neither has to guess. Change it by editing this file and
noting the change on the board — the same rule as `game-link-v0.md`.

Implemented site-side today: `web/server/routes/launcher.js`, `web/server/routes/me.js`.
Base URL is whatever the launcher is pointed at (`ENW_SITE_URL`, default `http://127.0.0.1:3200`).

---

## 0. The shape, and the one thing that changed from the mock

**The launcher wraps the site.** Sign-in, picking a map, the party, the ready check and Play all
happen in the wrapped page; the launcher's own chrome mirrors them. So this API is small on
purpose: it is only the things the launcher cannot get from the page, which are the **game** half
— what to install, what to launch, the invite token — and the things the site cannot see, which
are what the launcher is doing on disk.

**`POST /admin/lease` is gone.** The launcher calls it today against `mock-site/site.js`, which has
no auth at all. The real site must never let a client lease a box directly: a lease picks a game
box, mints invite tokens for a roster and burns real server time, so a client that can ask for one
turns the fleet into free hosting and lets the caller name its own Verified roster.

The flow inverts, and it is the flow 13 §4b describes anyway:

```
player presses Play  ──►  the SITE leases (it knows the party, map, mode, who is ready)
                          the site mints one invite token per whitelisted SteamID
      the LAUNCHER polls /api/launcher/play, sees a match, installs and launches
```

`POST /api/launcher/play` exists for the launcher's own corner card. It does exactly what pressing
Start in the party rail does, for the player asking, with the same guards.

---

## 1. Authentication

The session cookie. The launcher shares a cookie jar with the wrapped `WebContentsView`, so a
signed-in page means signed-in API calls from the main process — no token, no second auth path,
nothing to leak. `zm.sid`, `httpOnly`, `sameSite=lax`.

Sessions are stored in SQLite (`web/server/lib/sessionStore.js`), so **a site restart does not sign
the player out** and the launcher does not need to handle a surprise 401 after every redeploy.

---

## 2. Endpoints

### `GET /api/launcher/hello`
Once at startup. Replaces probing ports and guessing.

```json
{ "ok": true, "site": "ENW Zombies", "protocol": 0,
  "auth": "mock" | "steam",
  "sign_in_url": "/auth/mock",
  "capabilities": { "play": true, "settings": true, "state": true, "reports": true,
                    "live_view": true, "deep_links": ["/m/:map", "/live/:match", "/id/:who"],
                    "map_downloads": false, "replay_downloads": false, "og_cards": false },
  "enw": { "enabled": false, "note": "stubbed — …" },
  "you": { "steam_id": "…", "name": "…", "vip": false } | null }
```

`capabilities` is how the launcher greys a button instead of calling something and getting a 404 it
has to explain to the player. The three `false`s are honest: none of them is built.

### `GET /api/launcher/play` — the hand-off *(signed in)*
Poll this while the boot screen is up.

```json
{ "protocol": 0,
  "state": "idle|selected|ready-check|reserving|loading|ready|in-game",
  "party": { "id":1, "code":"2NXBR", "mode":"verified", "visibility":"friends",
             "members":[…], "all_ready":true, "is_leader":true } | null,
  "map":   { "key":"nazi_zombie_factory", "title":"Der Riese", "art":null, "fs_game":null,
             "version":"1.0", "version_id":3, "size_bytes":null,
             "files":[{"path":"…","sha256":"…","size":123,"kind":"pack","source_url":"…"}],
             "install_known": false, "readme":"…" } | null,
  "match": { "match_id":"m_c26fbf8a", "mode":"verified", "fs_game":null,
             "token":"<this player's invite token>", "connect":"1.2.3.4:28960",
             "state":"leased|ready|live" } | null,
  "settings": { "fov":80, "max_fps":125, … },
  "vip": false }
```

* **`state` is the boot screen's step**, decided by the site so the two cannot disagree about what
  is happening. It maps onto 13 §4b-2's wording: `reserving` = "Reserving server", `loading` =
  "Loading map", `ready` = "Ready", then "Launching World at War" is the launcher's own step.
* **`match.token` is the asking player's token and nobody else's.** A party payload never carries
  another member's. The launcher passes it to the game over the named pipe (`launcher.md` §3).
* **`connect` is null until the box reports ready.** There is nothing to connect to before that,
  and a launcher that retries a null connect string is correct to wait.
* **`map.install_known` is false until the archive pipeline has imported a version.** An empty
  `files` list means *we cannot tell you how to install this*, not *nothing to install* — do not
  treat it as "already installed".

### `POST /api/launcher/play` — the corner card's Play *(approved)*
```json
{ "map_key": "nazi_zombie_factory", "mode": "verified", "force": false }
```
Sets the map and mode if given, then starts. Solo skips the ready check (a ready check with one
member is ceremony). In a group the leader must have run one; `force: true` is B's "start anyway",
and the members who were not ready can late-join and earn nothing from it.

`409` with `{error, party}` when it cannot start yet — not ready, not the leader, no box online.
`403` when the account is on the waiting list. The error strings are written for a player to read;
show them rather than rewriting them.

### `POST /api/launcher/cancel` *(signed in)*
Cancels the ready check, or the lease if one exists.

### `GET /api/me/settings` / `PUT /api/me/settings` *(signed in)*
The account's game settings, applied over World at War at launch. `GET` also returns `defaults`.
The player's own WaW config is never edited — this is what gets passed as `+set` dvars.

Ranges are the speedrun rule values (11 §7) so a Verified game cannot be configured out of its own
rules: `fov` 65–120, `max_fps` 20–250. `zombie_counter` is forced off in record games whatever it
says here.

### `POST /api/launcher/state` *(signed in)*
```json
{ "phase": "detecting|installing|launching|in-game|error", "detail": "…", "progress": 0.42, "map": "…" }
```
What the launcher is doing, so a party member's screen can say *"Dexter is installing the map"*
rather than showing an unexplained wait. Readable at `GET /api/launcher/state/:who`.

**`in-game` here is a hint, not a fact.** The box's roster is the fact (11 §9: a box roster beats a
lobby seat), so this only refreshes the site-side presence heartbeat; it never marks somebody as
in a game.

### `POST /api/launcher/report`
Silent error reporting (99 §4.3). `{kind, message, context}`. Lands in the moderation reports queue
under `kind: 'launcher'`, visible to staff only. **Always returns 200** — a crash reporter that can
fail is a crash reporter that produces a second crash to report. Redact tokens and pipe names
before sending; the site does not scan for them.

---

## 3. Deep links

`https://zombies.enw.gg/m/<map>` and `enwzombies://m/<map>` both mean *open this map's page with
Play ready* (13 §2d). The launcher already parses both to `{kind:'map', map}`.

Site-side, `/m/<map>` is a real route and **must never change** — it is the link that goes in a
YouTube description. Two more are worth handling:

| Path | Means |
|---|---|
| `/m/<map>` | the map page |
| `/live/<match_id>` | watch a game (no game slot; works signed out for a public lobby) |
| `/id/<name-or-steamid>` | a profile |

`/m/<map>?play=1` is reserved for "select it and open Play"; the site treats the query as harmless
today, so the launcher may send it now and it will start meaning something without breaking.

---

## 4. What the site does NOT provide yet

| | Why |
|---|---|
| Map downloads | the archive pipeline has the files; nothing serves them, and 04 rule 8 needs a Steam login gate first |
| Replay downloads | the file is on the box; there is no R2 |
| OG / run cards | not built |
| Steam ownership check | needs a Steam Web API key, which nobody has made (Q-web-1) |
| Push notifications to the launcher | it polls; a socket for `user:<steamid>` exists server-side if polling proves wasteful |

---

## 5. Open, for the launcher agent

1. **Poll rate for `/api/launcher/play`.** The site is happy with 1 Hz while a boot screen is up and
   0.2 Hz otherwise; say if you want a socket event instead and I will push on `user:<steamid>`.
2. **Do you want the site to own "Play Local"?** It is untracked by definition, so the site has no
   part in it except knowing the map exists. Currently the site's own Play Local button says the
   launcher is not installed, which is right for a browser and wrong inside the launcher — tell me
   how you would like to signal "I am the launcher" (a header, a query flag on load) and I will
   make that button call you instead.
3. **`install_known: false` everywhere** until the archive import lands. Decide whether your first
   run should refuse to launch a map it cannot verify, or launch and let the box's hash check
   refuse — I would suggest the second, because the box's check is the one that matters.
