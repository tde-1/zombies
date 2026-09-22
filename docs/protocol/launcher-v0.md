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

### `POST /api/party/:id/progress` — the party's download bars *(signed in)*

Added 2026-09-22. Implemented site-side in `web/server/routes/site.js` +
`web/server/lib/partyProgress.js`, launcher-side in `launcher/src/main/partyprogress.js`.

```json
{ "map": "water", "bytes": 251658240, "total": 453077300,
  "state": "downloading" | "installed" | "failed", "error": "…" }
```

Every member's launcher posts its **own** download of the map the leader staged. The party
panel draws a bar per member, and the leader's **Start** stands down while any of them is
still downloading or has failed — which is the whole point: a party of four where one person
is still pulling 600 MB used to start a game three of them could join.

* **About 1 Hz while downloading, and once at every state change.** The site's floor is
  400 ms per member and a post that arrives too soon is **accepted and dropped**, never
  refused, so no launcher has to care what the ceiling is. `installed` and `failed` are
  terminal, bypass the throttle, and always land.
* **`installed` means the hash check passed**, not "the bytes stopped arriving". The
  launcher verifies every file against the SHA-256 the archive recorded as it streams and
  refuses to install a map that does not match, so the two cannot come apart.
* **Nothing is sent when the player is not in a party game.** No party, or a map other than
  the one the party staged, and the launcher makes no request at all. The gate is
  `partyprogress.attach()` and there is a test for each half.
* **Never fatal.** Every post is fire-and-forget; a 4xx, a restarted site or a dead tunnel
  in the middle of a 600 MB download must not take the download with it. The worst case is
  a bar that stops moving.
* Nothing is stored in SQLite and nothing is trusted: `bytes`/`total` are drawn and nothing
  else keys off them.

Three site-side facts the launcher's half needs, written down 2026-09-22 when the web lane
implemented it, because each one is a place the two sides could disagree silently:

* **The reply is `{ok, stored, progress, installs_ok}`.** `stored:false` is the throttle
  having dropped that post and is not an error. `installs_ok` is the leader's Start button:
  it is the one value worth reading back, and it is false while anyone in the party is
  `downloading` or `failed`.
* **Silence is not "still downloading".** A member whose launcher has never posted does
  **not** hold Start. The gate fires on what a launcher has actually said, never on what it
  has not — because today most of the people in a party are in a browser with no launcher at
  all, and a Start button that greys out until a build that does not exist reports in is a
  worse failure than the one this feature fixes.
* **The leader can always override.** `POST /api/party/ready-check {force: true}` starts the
  ready check anyway, and the refusal without it names who it is waiting on
  (`{ok:false, error, waiting:[{steam_id, name, progress}]}`). Same shape, and the same
  "THE LEADER DECIDES" rule, as launching with somebody unready (13 §4b).
* **The session cookie is the identity; the `:id` is only which party.** A caller who is not
  a member of that party gets `{ok:false}` — a launcher cannot report on anybody else's
  behalf. Progress is dropped outright when the leader changes the map (four green bars for
  a map nobody is playing) and when the party launches.

### Following somebody else's Start

Not an endpoint — a rule about an existing one, and the thing that makes a party game a
party game. **`POST /api/launcher/play` is "I am pressing Play" and only the leader may call
it.** A member has nothing to ask for: by the time they could, the site has leased the box
and minted one invite token per whitelisted SteamID, and that player's own token is already
in their `GET /api/launcher/play` body.

So every member's launcher polls, and when a `match` appears for a party it is in, it opens
the boot screen and launches at `match.connect` with `match.token` over the named pipe —
without ever POSTing. Since 2026-09-22 the launcher does this (`BootFlow`'s follow mode);
before it, a party of four produced one player in the game and three watching a site that
said they were in it.

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

---

## 6. Local games (added 2026-09-20, implemented)

A Local game (13 §4) runs on the player's own PC: no lease, no box, no invite token, no server.
It is **solo only** and **untracked** — no badge, no record, no XP — and the site enforces that
rather than trusting anybody to send the right flags.

### There is no box secret on a player's PC, ever

`x-match-secret` is what lets a process post a result *as a game box*. A player holding one makes
every board on the site whatever they feel like typing. So these three are authenticated by the
**ordinary session cookie** the launcher already has from the wrapped view, and everything through
them is stamped `self_reported`.

### `POST /api/launcher/local/start` *(signed in)*
```json
{ "map_key": "nazi_zombie_leviathan" }
```
→
```json
{ "ok": true, "match_id": "l_288b1351", "solo": true,
  "map": { "key":"nazi_zombie_leviathan", "title":"Leviathan", "fs_game":"mods/nazi_zombie_leviathan",
           "version":"1.2", "files":[{"path":"…","sha256":"…","size":453077300,"kind":"original"}],
           "install_known": true, "readme":"…" },
  "settings": { "fov":80, "max_fps":125, … },
  "notice": "Local game — untracked. No badges, no records and no XP." }
```
`notice` is there so the boot screen shows the site's wording rather than inventing its own.

### `POST /api/launcher/local/live` *(signed in)*
```json
{ "match_id": "l_288b1351", "state": { …the referee's state() straight through… } }
```
~4 Hz while the game runs. The site downsamples and drops the excess; send whatever suits you.
Only the player whose game it is may push frames for it. This is what makes `/live/<match_id>`
work for a local game, so a friend can watch without using a game slot.

### `POST /api/launcher/local/result` *(signed in)*
```json
{ "summary": { …the referee's summary, with match_id set to the one from /start… },
  "replay":  { "file":"…m_10fdde2f.enwr", "size":4255305, "chunks":42, "events":98313, "key_id":"…" } }
```
→ `{ ok, game_id, match_id, tracked: false, notice }`.

**The roster is overridden to the session's player.** Whatever the summary says, the game is filed
against the account that started it — otherwise a local game could write rows against other
people's accounts.

### What the site does with it

Stores it, and counts it for nothing:

```
mode=local  records_eligible=0  xp_multiplier=0  self_reported=1
0 records · 0 XP · 0 badges · map_progress played=1 beaten=0 best_round=0
```

The replay is stored and its integrity is checkable, but it is **not evidence** — the grade is
`local`, with the reason *"it ran on the player's own PC with the console available, so the
signature proves the recording is unedited, not that the run is real."* Note that on a dev box the
local host agent **is** `box-a`, so the signing key is the pinned one and every key check passes;
the mode decides this, not the key.

### A working reference implementation of your side

**`web/tools/local-run.js`** drives all of the above against the real site over HTTP, in the order
you will: sign in, `/local/start`, relay frames from a host agent's dashboard, `/local/result`.
Read it, then delete it. A real run of it is in `docs/kickstart/web.md` §4i.

### Still open for you

* **`window.enw.playLocal(session)`** — the site's Play Local button calls this when it detects it
  is inside the launcher (`window.enw` present) and passes the whole `/local/start` response. Name
  it something else and I will change the call; it is one line in `web/client/src/pages/MapPage.jsx`.
* ~~**How you signal "I am the launcher"** more generally. `window.enw` is the current sniff. A
  request header on the wrapped view's navigations would be cleaner for server-rendered decisions;
  say which you prefer.~~ **Settled 2026-09-22 — you sent both, and the site now reads both.**
  The wrapped view stamps `X-ENW-Launcher: <version>` on every request it makes, navigations
  included (`launcher/src/main/main.js`, `onBeforeSendHeaders`), and `/api/me` answers
  `{ launcher: true, launcher_version }` when it sees it. `window.enw` is still read alongside
  it, and **either one is enough**: the header is true before any client JS has run, which is
  what a first-paint decision needs, and the bridge is the thing that can actually launch a
  game, which is what a Play button needs. They disagree honestly in both directions — a
  launcher whose preload failed still sends the header; a dev page opened straight in Electron
  has the bridge and no header — and in both of those the person **has** the launcher, which is
  the only question being asked. Nothing needs to change on your side.

---

## 7. `enw-zombies://` — the custom protocol (added 2026-09-22, implemented)

The launcher registers the scheme **`enw-zombies`** (hyphenated). This is the one the web lane
should send; §3's `enwzombies://m/<map>` is the older, unhyphenated scheme and is still parsed,
but it is not the one to build against.

Registration happens in two places, and both are needed: `app.setAsDefaultProtocolClient` at
startup (so a dev checkout and a running app claim it) and `build.protocols` in the launcher's
`package.json` (so the NSIS installer writes the registry keys and the link works on a machine
where the launcher has **never been run**).

### The routes — exactly two

| String | The launcher does |
|---|---|
| `enw-zombies://map/<key>` | selects `<key>` in the map browser and shows its card, so the player can press **Play** or **Start**. It does **not** auto-play, and it does **not** auto-install. A `<key>` the launcher has never heard of is still selected, as an unavailable row, rather than being dropped |
| `enw-zombies://party/<id>` | navigates the wrapped site view to `/party/<id>` and shows it. **Joining is yours** — the launcher does not know the invite list, so it opens the page and the site decides whether this player may join |
| anything else | opens the launcher on home. Never an error dialog, never a crash |

`<key>` is the **bsp name** (`nazi_zombie_prototype`, `water`), not the title. `<id>` is the
party id exactly as `/api/launcher/play` reports it, as a string. Both are
percent-decoded, so `enw-zombies://map/Foo%20Bar` selects `Foo Bar`.

### The exact string forms, and what is tolerated

* **Case**: the *route* is case-insensitive (`enw-zombies://MAP/x` works); the *argument* is not,
  and is passed through exactly as sent.
* **Trailing slash**: `enw-zombies://map/water/` is the same as `enw-zombies://map/water`.
* **The opaque form**: `enw-zombies:map/water` (no `//`) is accepted, because some chat clients
  rewrite links into it.
* **Empty argument**: `enw-zombies://map/` and `enw-zombies://party/` go home, and the reason is
  logged. Do not send these.
* **Unknown route**: `enw-zombies://live/<id>` goes home today. Say the word and it becomes a
  route; it is one table entry.

### One launcher, always

`app.requestSingleInstanceLock()` is held. Clicking a link while the launcher is open starts a
second process, which hands its argv to the running one and **quits** — the running window is
raised and routed. A link that arrives on a cold start (in `process.argv`) is held until the
window exists and then routed through the same path. macOS/Linux `open-url` is handled too; on
Windows it never fires.

### What is in `launcher.log`

Every URL received, under the scope `deeplink`, including the ones that go home **and why**
(`unknown route "live"`, `a map link with no map key`). A player reporting "the link just opened
the launcher" is otherwise unfixable, so if the site sends a form this launcher drops, the
evidence is already on the player's disk.

### What the SITE sends, and when (web lane, 2026-09-22)

Both routes are now emitted by `web/client/src/components/playGate.js`. Nothing new is asked of
the launcher; this is a record of what it will start receiving.

**The rule.** Any action that would put somebody into a game — **Play**, **Play Local**,
**Start**, **Ready**, **Go**, and both *Start anyway* overrides — cannot do that from a browser
tab. Pressed in a plain browser they now navigate to `/download`, carrying the map or the party,
and that page offers **"Open in the ENW Zombies launcher"** *before* it offers the installer:
somebody who already has the launcher does not need an installer, they need the app to come
forward.

| The person pressed | `/download` gets | its button sends |
|---|---|---|
| Play / Play Local, on a map page or home | `?map=<bsp key>&then=/m/<key>` | `enw-zombies://map/<key>` |
| Start / Ready / Go, in the party panel | `?party=<id>&map=<key>&then=/` | `enw-zombies://party/<id>` |

The party wins when both are present. Neither link is ever sent with an empty argument, which §7
asks for. Inside the launcher **none of this happens** — the buttons do exactly what they did.

**The fallback is a reveal, not a redirect.** There is no way to ask a browser whether a scheme
is registered, so the page navigates to the link and, if nothing has happened after 1.6 s, says
so and points at the installer. It does **not** navigate anywhere on that timer: the moment the
timer expires is precisely the moment the OS's own "open this application?" prompt is on screen,
and a page that navigated then would be fighting it.

**`/party/<id>` now exists**, because §7 said the launcher navigates there and it was a 404.
Parties live on home in a panel and have no page of their own, so the route renders **home** —
`web/client/src/App.jsx`. It deliberately does not *join* anything: §7 says joining is the
site's decision, and the site's decision is made by the invite the person already holds. If you
would rather point party links at `/` and drop the route, say so; it is one line either way.
