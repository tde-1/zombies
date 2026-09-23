# The website — what runs, how to run it, and what is stubbed

`web/` is ENW Zombies' site: **a port of ENW Movement** (`C:\Users\b\Desktop\CSGO-Matchmaker`,
`server/` + `movement-client/`) with the nouns changed, following B's ground rule — *copy ENW
Movement, change only what zombies needs*. Same stack, same shapes: Express 4 + better-sqlite3 +
socket.io + React/Vite, one process, one SQLite file, sessions in a cookie.

**A real host agent has talked to this site.** `infra/host-agent` polled it, took a lease, verified
invite tokens the site signed, refereed a simulated game and posted the result; the site wrote the
game, the players, the XP, the map badge, the records and the feed line. That path is the point of
the whole thing, and it works end to end (§4).

---

## 1. Run it

```bash
cd web
npm install                       # 153 packages, all from npm, nothing global
npm run seed -- --reset --demo    # build the database from referee/manifests + demo players
npm run import:archive            # the archive agent's 14 pipeline maps  (--catalogue for all 2,276)
npm run build                     # build the React client into client/dist
npm run dev                       # http://127.0.0.1:3200
```

Sign in at <http://127.0.0.1:3200/auth/mock> (a dev-only page; see §5).

While working on the client, run the Vite dev server beside the API — it proxies `/api`, `/auth`
and `/socket.io` to 3200, so it is the same origin, the same cookie and the same socket:

```bash
npm run client                    # http://127.0.0.1:5173
```

Checks:

```bash
npm run check                     # both suites: 55 in-process + 26 over HTTP
npm run check:lib                 # 55 in-process checks, a few seconds, no server needed
npm run check:mvp                 # 26 HTTP checks of the local-run path (spawns a server on 33991)
```

`check:mvp` (`test/local-run.js`) is the one that covers B's MVP sentence. It spawns the
**real** server as a child process on its own port with its own `ZM_DATA_DIR`, drives
`local/start` → `local/live` → `local/result` over HTTP exactly as the launcher does,
**restarts the server mid-run**, sweeps an abandoned match, downloads a replay and checks
the bytes. None of the bugs it covers were visible to the in-process suite, because all of
them lived in the HTTP layer or in the state machine between three requests.

**A live game on the site in twenty seconds** — a real host agent, a real referee, real frames:

```bash
# terminal 2 — a box. Pick ports nobody else is on; four agents share this machine.
cd infra/host-agent
node host.js --site http://127.0.0.1:3200 --secret devkey-a --box box-a              --dash-port 8797 --link-port 38791 --base-port 29170              --sim-timescale 60 --sim-players 3 --sim-max-round 40

# terminal 3 — the dev shim that stands in for the box posting frames (§4e)
cd web && npm run live-bridge -- --dash http://127.0.0.1:8797
```

then sign in, Admin → *Lease a game by hand*, and open `/live`.

**If you run your own host agent, give it its own box row.** Every agent's default is
`box-a`/`devkey-a` and each signs with its own key, so the pin will refuse yours and every replay
you write will be stored ungradeable. `POST /api/admin/boxes {name, match_key}`, or add a row to
the seed. §4d is what that looks like when it happens.

Everything is under `web/`. The database is `web/data/zombies.db` (gitignored, always rebuildable
from `npm run seed`); the site's Ed25519 invite key is generated on first boot into `web/keys/`
(gitignored, a development key).

### Environment
| Variable | Default | What |
|---|---|---|
| `PORT` / `ZM_PORT` | 3200 | |
| `ZM_HOST` | 127.0.0.1 | bound to loopback; nothing is exposed |
| ~~`ZM_AUTH`~~ | — | **removed 2026-09-22** (§13): Steam OpenID is the only sign-in, on every box |
| `ZM_TEST_LOGIN` | unset | `1` registers the test-only `POST /auth/test-login` for `npm test`. Loopback only; the server **refuses to start** with it and `NODE_ENV=production` (§13) |
| `ZM_MOVEMENT_URL` | `https://movement.enw.gg` | where the picker reads a player's Movement name from (public, read-only); `off` disables it (the tests do) |
| `STEAM_API_KEY` | — | **B's to obtain.** Without it the Steam path stays off |
| `ZM_PUBLIC_URL` | — | the OpenID realm/return origin, e.g. `https://zombies.enw.gg` |
| `ZM_ENW_BASE` | — | the ENW name/VIP API base. **Unset = no request leaves this machine** |
| `ZM_ENW_TOKEN` | — | the narrow read-only token for the above |
| `ZM_VIP_FORCE` | — | comma-separated SteamIDs forced to VIP locally |
| `ZM_DEV_BOX_KEY` | `devkey-a` | the seeded dev box's `x-match-secret` |
| `ZM_SESSION_SECRET` | generated | persisted to `data/session-secret` so a restart is not a logout |

---

## 2. What is there

```
web/
  server/
    index.js              express + socket.io + the built client
    db/database.js        the schema (99 §5.5), additive migrations only
    db/seed.js            seeds from referee/manifests/*.json and the scanner's verdicts
    lib/                  the data layer (below)
    routes/               auth · me · maps · players · site · launcher · admin · gameserver
    middleware/auth.js    req.me, and the two different guards (signed in vs may play)
    routes/               auth · me · maps · players · site · launcher · admin · gameserver
  client/                 Vite + React 18 + react-router 6
  tools/live-bridge.js    a dev shim: the box's dashboard -> /api/gs/live (see §4e)
  test/run-all.js         51 checks
```

### The data layer, and where each piece came from
| File | Ported from | Notes |
|---|---|---|
| `lib/badges.js` | `server/lib/badges.js` | `award()` / `forPlayer()` / `heldBy` / pins. Four kinds: staff, achievement, **map**, **record** |
| `lib/achievements.js` | `server/lib/achievements.js` | the rule sweep. Never revokes, never throws into a request. Families: rounds, maps, collections |
| `lib/mapRecords.js` | `server/lib/mapRecords.js` | the HELD record badge, `onRunFinish()` fast path + periodic sweep, `badge_holds` history |
| `lib/mapWeek.js` | `server/lib/mapWeek.js` | history not a mutable row; the week IS the key |
| `lib/presence.js` | `presence.js` + `whereabouts.js` | **a box roster beats a lobby seat** |
| `lib/chatNetwork.js` | `server/lib/chatNetwork.js` | the global ring + the long-poll drain the boxes speak |
| `lib/parties.js` | `party.js` / `partyView.js` | party rail, ready check, launch |
| `lib/boxes.js` | `match_servers` + `dedicated.js` | the pull-protocol identity **plus the replay key pin** (new, §4b) |
| `lib/assignments.js` | `routes/gameserver.js` | leases, nonces, invite tokens |
| `lib/results.js` | `gameserver-log.js` | ingest: the single most important write path |
| `lib/records.js` | `leaderboard.js` + vault 10 | boards, rule profiles, submission |
| `lib/xp.js` | new | 65 levels/prestige, unlimited prestige, active time |
| `lib/enw.js` | new | **the only two runtime links to ENW**, both stubbed |
| `lib/live.js` | Movement has no equivalent | live frames, in memory, per-game socket rooms, the watch rule (§4e) |
| `lib/replays.js` | new | the evidence grade, the download rule and verification against the pin (§4f) |
| `lib/sessionStore.js` | new | sessions in SQLite, so a restart is not a logout |
| `lib/tokens.js`, `lib/siteKeys.js` | mirrors of `infra/host-agent/lib/*` | byte-compatible by test |

### Pages
`/` home · `/maps` · `/m/<map>` · `/archive` · `/records` · `/badges` + `/badges/<slug>` ·
`/playlists` + `/playlists/<slug>` · `/id/<who>` · `/creator/<name>` · `/game/<match>` ·
`/custom` · `/live` + `/live/<match>` · `/admin`.

`/m/<map>` is the deep link for YouTube descriptions (13 §2d) and must never change.

---

## 3. What the spec asked for, and where it is

| Spec | Where | State |
|---|---|---|
| **Schema** 99 §5.5 | `server/db/database.js` | every table named in §5.5, plus `boxes`, `assignments`, `chat_network`, `map_of_week`, `map_progress`, `creators` |
| **Seeded from the real artefacts** | `server/db/seed.js` | 5 maps from `referee/manifests/*.json`, sizes from the scanner's entity counts, 128 boards, 23 badges, 3 playlists, 6 presets |
| **Pull protocol** | `routes/gameserver.js` | real, proven against the host agent (§4) |
| **Box key pinning** | `lib/boxes.js` | real, TOFU with an admin-confirmed change (§4b) |
| **Home** 13 §3 | `pages/Home.jsx` | live games, friends online, map of the week + runs, featured, the records/badges feed. **No rescued counter** |
| **Maps** + 4 filters + smart search | `pages/Maps.jsx`, `lib/maps.js` | all four filters, all in the URL; search ranks name (incl. the `nazi_zombie_` alias) > author > tags > readme |
| **Map page** | `pages/MapPage.jsx` | Play/Join, Play Local, download link, description, **what counts as beating it straight from the manifest**, boards, comments, versions, thumbs, favourite, beaten-by |
| **Profile** | `pages/Profile.jsx` | map shelf with ticks and the gold record state, career strip, recent games, level + prestige, VIP tag, favourites, most played, comments, settings |
| **Records hub** | `pages/Records.jsx` | every board, filtered by category / player count / **rule profile**, with the mismatch shown |
| **Badges directory** | `pages/Badges.jsx` | the four kinds grouped, each with its `obtain` line and per-player progress |
| **Playlists** | `pages/Playlists.jsx` | curated + **automatic per creator**, completion badges via `reward_badge` |
| **Custom knobs** 13 §4c | `pages/Custom.jsx` | all eight groups with the spec's caps, presets, share codes, the four locked challenge presets |
| **Admin / mod tools** 99 §4.9 | `pages/Admin.jsx` | reports queue, infractions, bans (griefing = public-play), **record review with the replay and its evidence grade**, boxes + key warnings, waitlist, lease-by-hand |
| **Sign-in** | `routes/auth.js` | ~~mock provider (default) + the real Steam OpenID path behind two env vars~~ — **updated 2026-09-22**: Steam OpenID is **on** in production (`ZM_AUTH=steam`, `ZM_PUBLIC_URL=https://zombies.enw.gg`) and needs no Steam Web API key; the mock stays as the labelled beta fallback. Three faults in the launcher leg are fixed below (§9) |
| **VIP** | `lib/enw.js` | stub reader with the seam, plus a local force list and an admin override |
| **Theme** 06 | `client/src/themes.js`, `theme.css` | the zombies palette as the default, **Ember and Dusk as the other two**, switcher in the nav |
| **Logo A** | `components/Bits.jsx` `<Lockup>` | the ENW mark from `assets/logo-mockups.html` with ZOMBIES as the width-matched foot; the favicon is the mark alone |

---

## 4. The game link — the part that matters

### 4a. It works end to end

```bash
# terminal 1
cd web && npm run dev

# terminal 2 — the REAL host agent, pointed at the REAL site
cd infra/host-agent
node host.js --site http://127.0.0.1:3200 --secret devkey-a --box box-a \
             --link-port 38790 --base-port 29160 --sim-timescale 400 --sim-players 2 --sim-max-round 12
```

Then either lease by hand (Admin → *Lease a game by hand*) or do it the real way: sign in as two
players, make a party, pick a map, ready up, press Start. What the host agent prints:

```
info  host/site   assignment changed: leased nazi_zombie_asylum m_c645886a (nonce dc34d9681235)
info  host        lease m_c645886a: nazi_zombie_asylum verified 2p
info  host/inst-01 auth slot 0 Air  76561190000000002: ALLOW (ok)
info  host/inst-01 auth slot 1 Stew 76561190000000004: ALLOW (ok)
info  host/inst-01 game live: nazi_zombie_asylum (verified) cap 24.0h
info  host/inst-01 game over: round_target, round 12, 9.9h
info  host/inst-01 replay closed: 2.98 MiB in 598 chunks, 738968 events, 151.3x
info  host/inst-01 SUMMARY nazi_zombie_asylum round 12 finish=none 9h57m02s flags=[] eligible=true
```

and what the site then holds: the `games` row, both `game_players` rows with their XP (729 and 946),
`map_progress` for both, the records on the 2p boards, the replay pointer, the assignment closed,
and the party back to `forming`. **`auth ... ALLOW (ok)` is the load-bearing line** — those tokens
were signed by this site's Ed25519 key and verified by the box against the public half it fetched
from `GET /api/gs/keys`. Nothing was hand-copied between the two.

`npm run check` includes a contract test that imports **the host agent's own `tokens.check()`** and
verifies a token this site issued with it, plus one that asserts our `canonical()` is byte-identical
to theirs. If either side's payload shape drifts, that test fails rather than every join failing
silently in production.

### 4b. The box key pin — why it exists and what it does

`docs/kickstart/host.md` §5 records the finding: a replay **re-signed with a different key is
internally consistent**, so `verify.js` calls it VALID. Integrity is not authorship. Without a pin,
anyone who can POST to `/api/gs/result` — including a decommissioned cloud box whose secret leaked —
can hand us a flawless replay of a game that never happened.

So the site pins each box's replay-signing public key, **trust on first use, and then refuses to
move**:

* the first key a box presents is pinned with the time;
* the same key is accepted silently thereafter;
* a **different** key is parked in `boxes.replay_pub_pending`, the box is told `key_pinned: false`
  on its next status heartbeat, **every replay it posts is stored with `key_pinned = 0`**, and the
  admin page shows it as the loudest thing on the page until an admin accepts or rejects it. The
  same shape as an SSH host-key warning, because it is the same problem.

Record review (`/admin` → records) grades each replay from that one flag:

```
signed by this box’s pinned key                                  ← record-grade evidence
recovered after a host crash — good enough for a badge, not a record
UNPINNED KEY — not record-grade evidence
```

and prints the exact command a reviewer should run: `node infra/host-agent/tools/verify.js <file>
--pub <the box's pinned key>` — never a bare `verify`.

Proven locally:

```bash
curl -s -XPOST -H 'content-type: application/json' -H 'x-match-secret: devkey-a' \
  -d '{"pub":"<the box key>","key_id":"7e9a0b0621f3c345"}' http://127.0.0.1:3200/api/gs/key
# {"ok":true,"pinned":true,"changed":false,"first":true,...}
curl -s -XPOST ... -d '{"pub":"AAA...","key_id":"deadbeefdeadbeef"}' .../api/gs/key
# {"ok":true,"pinned":false,"changed":true,"pinned_key_id":"7e9a0b0621f3c345"}
```

### 4c. The endpoints

Everything the host agent's `lib/siteclient.js` calls, with its names and its shapes:

| Route | Who | What |
|---|---|---|
| `GET /api/gs/assignment` | box | the lease, nonce-cached. `{status:'idle', nonce:'idle'}` when there is nothing |
| `GET /api/gs/keys` | box | `{invite_pub, key_id, alg:'ed25519'}` — the site's invite public key |
| `POST /api/gs/status` | box | booting/ready/live/idle + instances + host info. Also **pins the key if the body carries one**, and marks every listed player as in-game |
| `POST /api/gs/result` | box | the referee summary + the replay pointer → `lib/results.ingest` |
| `GET /api/gs/chat-feed?since=&wait=` | box | the long-poll drain; a box never gets its own lines back |
| `POST /api/gs/chat` | box | a player spoke in one of our games |
| `POST /api/gs/key` | box | **new**: offer the replay-signing public key for pinning |
| `POST /api/gs/spool` | box | **new**: a batch of results held while the site was down (Q-host-2's answer) |

Two deliberate differences from `mock-site/site.js`:

1. **`chat-feed` with `since=0` returns the cursor and no events.** The mock returns the whole ring,
   and the host agent injects everything that route hands it into every live game — so a box
   restarting would replay an hour of other people's chat at whoever was mid-round. Backlog belongs
   on the website, which reads the ring directly.
2. **`/result` never 500s.** A box that gets a 500 retries forever; a failure is logged to
   `activity_log` as `result.failed` and surfaced on the admin page, and the box is told the truth.

An ingest is **idempotent** on `games.match_id`: a spooled retry updates the row and mints nothing
twice. XP is guarded by its own ledger, badges by their composite key. Tested.

---

### 4d. The key pin, and a worked example of it earning its keep

The host agent added the two lines the same night: `reportStatus()` sends `pub` and `key_id`,
`/api/gs/result`'s replay block carries `key_id`, and the box reads our `{key_pinned,
pinned_key_id}` back and logs its own error when they disagree. **No shim is involved.**

#### What happened

Three processes on this machine were running host agents. They all default to the box name
`box-a` and the dev secret `devkey-a`, and each had generated **its own** Ed25519 replay-signing
key in its own key directory. None of them was malicious; nobody had done anything wrong. The
site's `activity_log`:

```
01:24:01  box.key.pinned    box-a         {"key_id":"21b77dd1cc691669"}
01:24:25  box.key.changed   box-a         {"was":"21b77dd1cc691669","now":"d6506a40e16dd6da"}
01:26:54  box.key.changed   box-a         {"was":"21b77dd1cc691669","now":"7e9a0b0621f3c345"}
01:31:32  box.key.accepted  7656119…001   {"box":"box-a","key_id":"7e9a0b0621f3c345"}
```

and, at the same moment, one of the boxes' own logs:

```
error host  SITE: this box presented a different replay key; results are stored unpinned
            until an admin confirms it
error host  KEY MISMATCH: the site has 21b77dd1cc691669 pinned for this box but we sign with
            7e9a0b0621f3c345. Every replay we write is being stored unpinned.
```

The first key was pinned on sight. The second and third were **refused and parked** — not
rejected, not silently accepted, parked, with the box told `key_pinned: false` on its very next
heartbeat. Every replay those two boxes posted was stored `key_pinned = 0`, which makes record
review say *"UNPINNED KEY — not record-grade evidence"* and stops the run counting. The pin only
moved at 01:31:32, when an authenticated admin looked at the warning on the admin page and
accepted it — and that accept is in the log with the actor's SteamID beside it.

#### Why this is the case the pin exists for

The same thing in production is not three developers. It is:

* **a decommissioned cloud box whose secret was never rotated.** The box is gone; the secret works.
  Anything holding it can POST a result and a replay, and `verify.js` will call that replay VALID,
  because it *is* valid — it is correctly signed, by a key of the attacker's own making.
* **a box that was reimaged** and generated a fresh key. Benign, and indistinguishable from the
  above without a pin.

`docs/kickstart/host.md` §5 put it exactly right: *integrity is not authorship*. A signature proves
nothing has changed since signing. It says nothing about who signed, and a footer says whatever its
author wants it to. The only thing that can answer "who" is a key the site learned **out of band
and refuses to move** — which is why `boxes.replay_pub` is trust-on-first-use with an
admin-confirmed change, and why the pin is deliberately the same shape as an SSH host-key warning.
It is the same problem.

#### What it cost, and what it would have cost

It cost one admin click and a warning banner. Without it, two boxes' replays would have been
silently graded record-quality, and the only trace would have been a key id nobody was comparing
against anything.

**Note for anyone running a host agent against this site:** you share `box-a` with the other
agents. Give yours its own row (`POST /api/admin/boxes`, or add one to the seed) or your replays
will be stored unpinned and your log will fill with KEY MISMATCH.

---

## 4e. The live view (web spectating)

`/live` lists what you can watch; `/live/<match_id>` is the game: round, players, points, downs,
health, the cap countdown, which manifest signals have fired, and a **top-down canvas** of every
player and zombie. **It uses no game slot** — which is the whole reason it is a web page and not
in-game spectating, because on a four-slot engine a spectator costs somebody their seat.

```
box ──POST /api/gs/live {instances:[{instance, match_id, state}]}──► site
                                                    │  in memory, never SQLite
                                     socket room `live:<match_id>` ──► every watcher
```

Three decisions, all in `web/server/lib/live.js`:

* **Frames never touch SQLite.** 4 Hz of positions that are stale in 250 ms, on the same file that
  serves every page, and the durable copy already exists — it is the signed replay on the box.
  Frames live in a Map with a 30-second TTL and die with the process.
* **The box pushes; the site still never dials out.** This is the one feature that tempts you to
  poll a box, and the fleet design says no.
* **Downsampled on arrival** to ~4.5 Hz. Faster frames are accepted and dropped — accepted so the
  box is never made to care about our rate, dropped so a misconfigured box cannot make us do its
  work.

Visibility is Movement's joinability rule applied to watching: a **private** lobby is members only,
**friends** adds the leader's friends, **public** is anybody signed in or not (it is the page a
YouTuber links). A game the viewer cannot watch is **absent from the list**, not present with its
map blanked — the map name is itself information about a private game. A moderator can watch
anything and it is logged.

The canvas has no map geometry, because nothing has parsed a `.bsp` yet. It autoscales to a running
bounding box of every position seen, which has one honest consequence: **it zooms out when somebody
opens a new area and never zooms back in.** Rescaling per frame was the alternative and it makes
the map lurch every time anyone moves. When bounds exist, it becomes a fixed frame.

**The host agent does not post frames yet.** `web/tools/live-bridge.js` is a dev shim that polls its
local dashboard (`GET /api/state`) and posts them, so the feature is real and proven against a real
referee today; the ask is in `questions.md`, and it is either one line in `reportStatus()` or a
4 Hz timer. The site reads frames out of the status heartbeat too, so the one-line version works
with no new call at all.

---

## 4f. Replays: is it evidence, and who may have it

`web/server/lib/replays.js` keeps three questions apart, because conflating them is the bug:

| Question | Answered by |
|---|---|
| Is the file intact? | the Ed25519 footer — a property of the bytes, checkable by anyone |
| Who signed it? | **the site's pin**, not the footer. A footer says whatever its author wants |
| May this person download it? | Q-host-1, as the coordinator confirmed |

`GET /api/replays/<match>` is **public** — the pointer, the grade, the reason and the exact verify
command, because a record nobody can check is a record nobody should believe. The command always
names the pinned key:

```
node infra/host-agent/tools/verify.js "…/m_2e346de4.enwr" --pub S9Gh3BHj9D8mpmn2V2jqdrHx0QmfvhALlEpAJdGt_DI
```

`GET /api/replays/<match>/download` streams the bytes under the Q-host-1 rule: your own game
always, a moderator, VIP, or a game whose lobby was public; anyone else gets the reason. The stored
path comes from a box and a box is not trusted to name a path, so it is basenamed into
`ZM_REPLAY_DIR` and must end `.enwr` — there is a test that walks it through `../../../Windows`.

**Admin → records → Verify** re-reads every chunk from disk, rehashes the chain and checks the
signature **against the box's pinned key**. Proven against a real replay the host agent wrote:

```
VALID — signed by this box’s pinned key      6 chunks, 12,758 events
```

and, on a copy of the same file with **one bit flipped** in the middle of a chunk (same size, same
index, same genuine signature):

```
INVALID
  chunk 2: content hash mismatch (bytes were modified)
  chunk 2: hash chain broken … chunk 5: hash chain broken
  final chain hash mismatch
```

A download was also taken through the site and re-verified with the community tool outside it —
344,012 bytes in, 344,012 bytes out, still VALID.

In production the bytes come from R2 and this file hands out a signed URL. That is the only part
of it that changes; `object_key` is the seam and is null everywhere today.

---

## 4g. The launcher seam

`docs/protocol/launcher-v0.md` is the contract, agreed against what the launcher agent has already
built (it probes `127.0.0.1:3200` and wraps the site in a `WebContentsView`). Implemented:
`GET /api/launcher/hello`, `GET|POST /api/launcher/play`, `POST /api/launcher/cancel`,
`POST /api/launcher/state`, `POST /api/launcher/report`, and `GET /api/me/settings` — which is the
exact path their `syncFromSite()` was already looking for.

**The one thing that had to change: `POST /admin/lease` is gone.** The launcher calls the mock
site's version of it today, which has no auth at all. A client that can lease a box turns the fleet
into free hosting and lets the caller name its own Verified roster. So the flow inverts, to the one
13 §4b describes anyway: the player presses Play, **the site** leases, and the launcher watches for
a match and launches. `POST /api/launcher/play` is the corner card's button and runs the same code
path as pressing Start in the rail, with the same guards.

Two site-side fixes came out of writing it down:

* **`boxes.address`.** The connect string was `null` forever on a local box, because it was built
  from `host.public_ip` which a dev box does not have — so the launcher could never have launched.
  The port still comes from the box (only it knows which instance got which), but the **address is
  provision-time data**: a box that can name its own connect address can name somebody else's.
* **Sessions in SQLite** (`lib/sessionStore.js`). The default MemoryStore signed everyone out on
  every restart, so the launcher would have hit a surprise 401 after every redeploy and
  `node --watch` was unusable. Verified: restart the server, the cookie still resolves.

## 4h. The archive, wired in

`npm run import:archive` reads the **archive** agent's work and keeps two very different things
apart, because conflating them would be the whole bug:

| Source | What it is | Becomes |
|---|---|---|
| `archive/manifests/*.json` | **14 maps the pipeline took end to end** — fetched, hashed, AV-scanned, extracted without running an installer, normalised to `mods/<map>/`, scanned for a finish | a playable map row, a version, the **original's sha256 and size**, its source URL and release post, its tags, and a referee manifest |
| `<work>/reports/catalogue.json` | **the crawl: 2,276 maps**, their names, authors, tags, release posts and 2,112 download links with the checker's alive/dead verdict | a `catalogued` row the Maps list hides and the Archive page shows, plus its links in `archive_sources` |

Calling a crawl result playable would put maps in the browser nobody has ever booted, so it does
not. Health is assigned honestly too: **nothing imported here is `verified`**, because that word
means somebody watched it run. A map the scanner could not decide (`needs_human`, or a `manual`
verdict) is `custom-only` — it will probably run, but we cannot referee a finish on it, so it must
not offer Verified play.

The Archive page (`/archive`) is now the real thing: the story, the counted numbers, which hosts
the archive rests on, the maps that do not run here, and a searchable, paginated list of
everything. It is a **list, not a wall of cards** — two thousand cards is a scrolling exercise, and
what a visitor wants here is to search one map and find out whether it still exists anywhere.

Today, from the live database:

```
catalogued 2,284 · playable here 19 · originals held 14
links 2,112 · alive 662 · dead 50 · still being checked 1,308
mediafire.com 846 (44 alive) · archive.org 572 (572 alive) · mega.nz 399 (18 alive)
```

Two things it changed elsewhere: `/api/maps?archive=1` now paginates (60 a page — it was 1.1 MB in
one response), and the author/year dropdowns describe the **playable** pool, because a filter with
nine hundred authors in it is not a filter.

It is re-runnable and idempotent, which found a real bug on the second run: `INSERT OR IGNORE`
into `map_files` had **nothing to conflict with**, so it was a plain INSERT and every re-import
duplicated every file row (63 rows where 35 were expected). There is a unique index on
`(map_version_id, path)` now and the migration de-dupes what was already there.

---

## 4i. Local games, and the site refusing to count them

13 §4: a Local game runs on the player's own PC "as just a normal client", with the full console
and cheats, and nothing is tracked — *"if they want their stuff tracked, they have to play through
our servers."* Implementing that honestly turned out to be the most interesting boundary on the
site.

### There is no box, so there is no box secret

A local game has no lease, no invite token and no server. It also must have **no
`x-match-secret`**: that header is what lets a process post a result *as a game box*, and a player
holding one makes every board on the site whatever they feel like typing. So local games get their
own door, authenticated as the **player** by the ordinary session cookie:

```
POST /api/launcher/local/start   {map_key}      -> {match_id, resumed, map{fs_game, files,
                                                    install_known, readme}, settings, notice}
POST /api/launcher/local/live    {match_id, state}   ~4 Hz while it runs -> {taken, round}
POST /api/launcher/local/result  {summary, replay}   -> {game_id, repeat, stored{rounds,map_key}, url}
GET  /api/launcher/local                             -> the caller's in-flight matches
GET  /api/launcher/local/<match>                     -> one of them, and its game if it finished
```

### A local match is a row, because a run is forty minutes long

The first version kept matches in a `Map` in `routes/launcher.js`, and that was the biggest
hole in the MVP. Reproduced on a private instance before it was fixed: start a local game,
restart the site, post the result — **`404 {"error":"not your game"}`**, and the run is gone
with nothing anywhere to recover it from. A deploy, a crash or `node --watch` on a save is
enough. So `local_matches` is a table (`lib/localMatches.js`), and three things follow:

* **A restart does not lose the run.** The result is matched against the row, and sessions
  were already in SQLite, so both halves survive.
* **A crash leaves a number.** Every live frame records the highest round reported. A run
  whose result never arrives is written out by `sweep()` with the round it reached, flagged
  `abandoned` + `frames_only` so nobody mistakes it for a refereed result — and the real
  summary **supersedes** that placeholder if it turns up later. That is the one case where a
  repeat post is allowed to change the numbers, and it is narrow by construction: only a row
  we synthesised ourselves.
* **Nothing sits live forever.** Twenty minutes without a frame having had one, or a full day
  having never had one, and the match is closed.

Two smaller ones from the same pass. A **retried** result is an idempotent `repeat: true`
rather than a 404 — a launcher whose POST succeeded and whose response was lost was being
told it had lost everything. And the **map** on a result is the site's, taken from
`local/start`: a result with no `map` used to store `map_key: ''` and appear on no page at
all. If the referee names a different map, the site keeps its own and flags `map_mismatch`.

### Nothing malformed reaches a column

`Number(x || 0)` is NaN for `"abc"`, and better-sqlite3 binds NaN to an INTEGER column as
NULL without complaining. `POST /local/result {rounds:"abc"}` therefore returned 200 and
stored a game with **no round on it** — the one number B's MVP is about. `players: "me"` was
an HTTP 500, which a box retries forever (rule 3 of `lib/results.js`, broken by the layer
above it). Every number and every string reaching a column now goes through `num`/`int`/
`str`/`parseWhen`, and the three local endpoints refuse a malformed body with a 400 that
names the problem.

Everything through that door is stamped `games.self_reported = 1`, and the roster on a result is
**overridden** to the session's player — otherwise a local game could write rows against other
people's accounts.

### The downgrade is applied twice, on purpose

The referee already returns `records_eligible: false, xp_multiplier: 0` for a local game.
`lib/results.js` does it **again** on arrival, and that is not redundant: rule 1 of that file is
that the box decides what happened and the site decides what it is worth, and *"worth nothing"* is
the one verdict the site must not be talkable out of. A result claiming `mode: 'local',
records_eligible: true` — through a bug, a fork, or a player's PC — gets zero regardless. There is
a test that posts exactly that.

### What the run produced

A real one, tonight, driven by `web/tools/local-run.js` (which is also the reference
implementation of the launcher's side):

```
signed in as Dexter
local game l_288b1351 on Leviathan          <- one of archive's 14 pipeline maps
  install known: true, fs_game mods/nazi_zombie_leviathan
  settings to apply: fov 80, max_fps 125
  watch it at http://127.0.0.1:3200/live/l_288b1351
  … 340 frames relayed, rounds 1 → 22 …
game over: round 22, Round 20
  site says: mode=local records_eligible=false self_reported=true
  replay: local — a Local game: it ran on the player's own PC …
```

and in the database afterwards:

| | |
|---|---|
| game | stored — `mode=local`, `records_eligible=0`, `xp_multiplier=0`, `self_reported=1` |
| records | **0** |
| XP ledger rows | **0** |
| badges | **0** |
| `map_progress` | `played=1`, **`beaten=0`**, **`best_round=0`** — after a round 22 game |
| replay | real: 4.06 MB, 42 chunks, 98,313 events |

### Two holes it found

1. **`best_round` was computed over every game.** A local round (console open) or a Custom round
   (a knob can *start* you at round 100) would land on the map shelf and in the profile's career
   strip, where it reads as an achievement. Both are Verified-only now. The game still appears in
   history, because the shelf is a history — `best_round` is the one field on it that is a claim.
2. **A local game's live frames carried the box name `local:<steamid>`,** and the box name is
   rendered, so the host's account id was on a page anyone could watch. It is `local` now; who
   owns the game stays server-side.

### The replay is VALID and is not evidence

Both of these are true of tonight's file and the site says both:

```
tools/verify.js   VALID — every chunk hashes to its index entry, the chain is intact,
                  and the footer signature checks out.
the site          a Local game: it ran on the player's own PC with the console available, so
                  the signature proves the recording is unedited, not that the run is real.
```

On a development box the local host agent **is** `box-a`, so the signing key is the pinned one and
every key check in §4f passes. The **mode** decides this, not the key — which is the same lesson as
§4d one turn further on: integrity is not authorship, and authorship is not legitimacy.

### Run again, 2026-09-21, after the hardening

Host agent simulator → `web/tools/local-run.js` → a private site on 3399:

```
local game l_cd19f6c08170 on Verruckt
  … 420 frames relayed, rounds 1 → 21 …
game over: round 21, Round 20
  site says: mode=local records_eligible=false self_reported=true
  replay: local — a Local game: it ran on the player's own PC …
```

and afterwards, on the site itself: `/game/l_cd19f6c08170` shows **Round 21** on Verruckt with
the local notice and the player's stats; the run is on `/m/nazi_zombie_asylum` under Recent
games and on the profile — while **HIGHEST ROUND stayed 41** (the verified number) and the
Verruckt shelf tile stayed un-ticked. The replay downloaded **through the site** is 2,363,575
bytes in and 2,363,575 out, and `tools/verify.js` on the downloaded copy says VALID; one bit
flipped in the middle of it says INVALID, chain broken from chunk 28 on.

---

## 5. What is real and what is scaffolded

### Real
* The schema, and every read and write path over it.
* The pull protocol, against the actual host agent, including invite tokens, chat both ways, status,
  results, and the key pin.
* Ingest: games, players, map progress, the map badge with its ticks and solo mark, XP with the
  Verified/Custom/Local multipliers, board submission across three rule profiles, the held record
  badge moving, the feed.
* Parties: create, join, visibility, ready check, "the leader decides", launch, per-player invite
  tokens, quick-join, the four-slot cap.
* Moderation: reports, infractions, bans, **griefing = public-play ban**, **a cheating ban wipes
  records and map badges and nothing else does**, record review with the evidence grade.
* Search, filters, ratings, favourites, comments, playlists (including the automatic per-creator
  kind), the map of the week and its weekly runs.
* Privacy: hideable history, always-public records and badges, deletion-as-anonymisation.
* The theme (three palettes) and the option-A lockup.
* **The live view**: frames from a real referee, a top-down canvas, per-game socket rooms, the
  private/friends/public rule, and the list of what you can watch.
* **Replays**: the public grade and verify command, the gated download, and admin verification
  against the pinned key — proven VALID on a real file and INVALID on a one-bit tamper.
* **The launcher API** and its contract doc, including the connect string and SQLite sessions.
* **The archive import**: 14 pipeline maps with their originals' hashes and source URLs, and the
  2,265-map crawl index behind the Archive page.

### Stubbed, with the seam in one place
| Thing | Where | What it does today | What it needs |
|---|---|---|---|
| **Steam OpenID** | `routes/auth.js` | **on** (§9); the mock page is registered only in mock mode and refused outside loopback (§10e) | `STEAM_API_KEY` + `ZM_PUBLIC_URL`, then `ZM_AUTH=steam`. The code path is written and uses `passport-steam` (an *optional* dependency, so a missing one does not stop the server) |
| **The ENW name (SSO)** | `lib/enw.js` `refreshName` | returns the cached value; falls back to the Steam persona | `ZM_ENW_BASE` + `ZM_ENW_TOKEN`, and the real path (`/internal/name?steamid=`) confirmed |
| **VIP** | `lib/enw.js` `refreshVip` | reads the cached column; `ZM_VIP_FORCE` and the admin toggle set it locally | the same two env vars and the real path |
| **Map art** | `maps.art` | ~~null everywhere~~ — **2026-09-22: 14 of 2,284 maps have a cover**, imported from the archive lane's media step and served at `/media/maps/` (§10c). The rest still show the engine name | the crawler finding covers for the other 2,270 |
| **Replay bytes in production** | `lib/replays.js` `localPath()` | served from the local replay directory, which works because the dev box IS this machine | R2, and one function changes |
| **The 3D replay viewer** | — | not started; the 2D live view is the prototype | Husky/C2M map export + three.js, a port of Movement's viewer, VIP-gated |
| **Live frames from the box** | `tools/live-bridge.js` | a dev shim polls the box's dashboard and posts them | one line in the host agent's `reportStatus()`, or a 4 Hz timer |
| **Play Local / launcher** | map page button | says the launcher is not installed | the launcher agent's deep-link handler |
| **Map downloads** | map page link | says so | the archive workers + a Steam login gate |

### Not built
* OG/link-preview images and share cards (13 §2d).
* Map downloads. The archive holds 14 originals with their hashes and 2,112 source links; nothing
  serves the bytes, and 04 rule 8 wants a Steam login gate first.
* Creator claims beyond the page and the row (`creators` table exists, no claim flow).
* The archive pipeline's own surfaces beyond `/archive` (crawl status, link health — the
  `archive_sources` table is there and empty).
* Badge art. Every badge renders as a hexagon with the map's engine-name stem; `badges.art` takes a
  URL when there is one, and Movement's `src/badgeForge/` is the thing to port when there is art to
  make.
* Friend suggestions from Steam ("Find Steam friends on ENW") — needs the Steam API key.

---

## 6. Decisions I made where the spec was silent

Each of these took the most reversible option and is one edit to change.

1. **A record is a run, not a player.** A zombies high round belongs to the team, so `records` has
   one row per run with a `roster`, and every member holds the record badge while it stands. The
   alternative — a row per player — makes a 4-player world record four rows of the same thing.
2. **External rule profiles get only the categories they have.** ZWR and speedrun.com boards are
   created for `round` and the two speedruns; the four ENW challenge brackets are ours. Posting
   everything everywhere put the same run on three boards that all said the same thing.
3. **A non-main finish ticks but does not mint.** 05 says one badge per map, earned by its main
   finish. A Round 20 on an Easter-egg map is a tick on the hover card and a shelf mark, not a
   badge.
4. **XP's active time is `time_alive_ms` capped at the game's length, minus paused time, zero for
   an AFK kick.** The real thing is a risk/trust score over signals only the box sees (usercmds,
   movement, damage, round progression) and the box does not compute it yet. This under-credits
   rather than over-credits, which is the right way to be wrong about XP farming.
5. **The manifest travels with the lease.** The box reads `referee/manifests/` off its own disk
   today, which works only because it is the same repo. A cloud box has no repo, and sending the
   manifest also means the run is refereed against the version the site thinks it leased.
6. **Level curve**: 8 active minutes for the first level rising to ~28 at level 65, ≈20 hours per
   prestige. Q29 is open; it is two constants in `lib/xp.js`.
7. **A stranger's private lobby serialises with `map: null`.** Movement's joinability rule, ported
   literally — the map name is itself information about a private game.

---

## 7. What I would do next

1. **Live frames straight from the host agent**, retiring `tools/live-bridge.js`. One line or one
   timer on their side; the site takes them either way already.
2. **Badge art.** The shelf and the badges directory are the two most visual pages and both are
   currently hexagons with the engine name in them. Movement's `src/badgeForge/` is the thing to
   port when there is art to make.
3. **OG images** for `/m/<map>` and a run card. The funnel is YouTube descriptions, so the link
   preview is the first impression and it is currently a bare title.
4. **Map art** from the archive's media step, which is the single biggest visual change available.
5. **The 3D replay viewer** (VIP). The live view's canvas and the chunked, seekable replay format
   are both already there; this is the third piece.
6. **Re-run `npm run import:archive` as the crawl finishes.** 1,308 links were still being checked
   when this was written, so the alive/dead split on the Archive page will move.

---

## 8. Rules I worked under

No cloud, no spending, no deploys, no pushes, no production data, no commits. `npm install` only,
from npm. Nothing here calls ENW, Steam, or anything else unless an env var is set, and none of
those env vars is set. `CSGO-Matchmaker` was read only — never modified, never run, and none of its
credentials or its database was touched.

---

## 9. On sign-in — what the browser leg does when it goes wrong (2026-09-22)

B could not sign in from the launcher. The launcher's own half of the flow is documented in
`launcher.md` §on sign-in with all nine hops; this is the site's half and what was wrong in
`server/routes/auth.js`.

### Measured, read-only, against the live site

```
curl -I https://zombies.enw.gg/auth/launcher/start   400  (the probe answer — route present, no params)
curl -I https://zombies.enw.gg/auth/steam            302  -> steamcommunity.com/openid/login
                                                          openid.return_to=https://zombies.enw.gg/auth/steam/return
                                                          openid.realm=https://zombies.enw.gg
curl -I https://zombies.enw.gg/auth/mode             401  WWW-Authenticate: Basic realm="ENW Zombies (closed beta)"
```

So **the gate exemptions are correct and the realm is correct.** The original hypothesis —
that Basic auth was blocking the Steam leg — is **not what was wrong**. `/auth/steam*` and
`/auth/launcher*` are exempt (`middleware/gate.js`) and answer without a password. What was
wrong is that every *unhappy* exit from those paths **left** them.

### The three faults

**a. `failureRedirect: '/'` sent every refusal to the one page it must not.** Steam
cancelled, an assertion that would not verify, a flow that had expired: all of them ended at
the site root, which is behind the beta password. The player pressed "sign in" and got a
browser password box. `/auth/*` is exempt precisely so a freshly opened browser can reach
it, and redirecting off `/auth/*` throws that exemption away.

**b. `failureRedirect` does not cover an ERROR, only a failure**, and `passport-openid`
raises `InternalOpenIDError: Failed to verify assertion` as an *error*. So it reached
Express's default handler: **HTTP 500 with a full Node stack trace**, on a path that is
deliberately reachable without the beta password. Reproduced on a private instance on 3399
with `ZM_AUTH=steam`:

```
$ curl -i http://localhost:3399/auth/steam/return?openid.mode=id_res
HTTP/1.1 500 Internal Server Error
<pre>InternalOpenIDError: Failed to verify assertion<br>    at …\node_modules\@passport-next\passport-openid\lib\…strategy.js:184:36
```

Both are fixed the same way: the return leg is wrapped in a custom `passport.authenticate`
callback, and every non-success renders `signInProblem()` **in place, on the gate-exempt
path**, naming which leg failed. No redirect, no stack. Same URL now answers `400` with a
page that says "Steam could not confirm that sign-in".

**c. One TTL was timing two completely different things.** `LAUNCHER_CODE_TTL_MS` (120 s)
governed both the single-use code *and* the browser leg — and the browser leg contains a
human doing a Steam Guard login. When it expired, `finishLauncherFlow` quietly returned
false and fault (a) took over. Split into `LAUNCHER_FLOW_TTL_MS` (15 min, the human) and
`LAUNCHER_CODE_TTL_MS` (120 s, the machine, unchanged). This is the one most likely to be
what actually bit B.

### And one that was latent

`/auth/launcher/start` now checks that the origin it was opened on is the `ZM_PUBLIC_URL`
origin, and **moves the browser there** if not. Steam's `return_to` is built from
`ZM_PUBLIC_URL` and nothing else, so a launcher that opened hop 3 on `http://127.0.0.1:3200`
(a pinned `ZM_SITE`, or the `siteCandidates` fallback) wrote its flow into a different
cookie jar from the one the return reads, and the sign-in died with no error anywhere. The
redirect is built from config plus the three already-validated values — nothing the caller
supplied reaches the `Location` header — and carries `moved=1` so a misconfigured
`ZM_PUBLIC_URL` cannot loop.

### Tests

`web/test/launcher-signin.js` (`npm run check:signin`) went from 8 checks to **13**. The new
five run against a **second server in `ZM_AUTH=steam` mode** — the old suite ran only in mock
mode, where the `/auth/steam` routes are not registered at all, so it could never have seen
any of this. They cover: `/auth/steam` really redirecting to Steam with the right
`return_to`; a bad return being explained rather than 500-ing or leaking a stack; an expired
flow getting a page instead of the password box; and the origin move, including that it
happens once. `ZM_LAUNCHER_FLOW_TTL_MS` exists only so that test need not sleep for fifteen
minutes; nothing sets it in production.

### THIS NEEDS A RESTART TO TAKE EFFECT

The live site is the `node` process on port 3200 and it is still running the old
`routes/auth.js`. Nothing here is live until it is restarted. `infra/keepalive.ps1` owns
that process — **B or the coordinator does it, not this lane** (README hard rule 7).
`web/data` was not written; the repro ran on 3399 with its own `ZM_DATA_DIR`.

---

## 10. The night home became the map browser (2026-09-22)

B's list, before bed, for the morning: home is Movement's map page, the profile is Movement's
profile, every piece of fake data goes, Steam sign-in only, seven accounts pre-approved, the
launcher gets a download-progress API, and it is all deployed. This is what each of those is now.

### 10a. Home

`client/src/pages/Home.jsx` is two regions instead of three.

* **Left column, 302px — Movement's rail measurement, not a new one.** The party panel
  (`components/PartyPanel.jsx`) on top: every member with their avatar, their name, their
  **map download**, and a ready dot; Verified/Custom and the visibility select; Start, Invite
  and Leave. Under it the **map pool** (`components/MapListPanel.jsx`), a scroller with a
  search box, drawn at Movement's pick density — a 44x26 art plate flush to the row's left
  edge, the name in the body face, author and year under it, and the row *is* the control.
* **Everything else is the selected map's own page.** Not a summary of it — `MapPage.jsx`
  exports `MapBody`, and `/m/<map>` and home's right-hand region render the same component.
  There is no second map page to keep in step, and the deep link YouTubers use still works
  and still must never change.
* **No right column.** `components/PartyRail.jsx` is deleted and `.shell` is `no-rail`.

**What came off the page, and why none of it came back:** live games, friends online, map of
the week, featured, and the records/badges feed. Every one was a list of rows, and after the
wipe there is nothing true to put in any of them. Five empty panels read as a broken site;
two thousand map rows read as an archive. When there are games worth listing they belong on
the map's own page, where "Live now" and "Recent games" already are.

**One thing went with the rail and needs a home: the global chat panel.** It is real —
`lib/chatNetwork.js`, the ring the boxes drain — and it is not on any page now. That is on
the open list below rather than quietly dropped.

### 10b. The background is the map's art

`client/src/ambience.js` plus the ambient block in `theme.css`, both **ported from Movement**
(`movement-client/src/themes.js`, `theme.css`), which is the mechanism B named. The map's own
artwork is projected huge, blurred at 64px and darkened behind the whole site on two
double-buffered layers that crossfade; over it a hue pour takes the art's two dominant
colours. Three tiers, most immediate winning: a **hover** in the list, the **open** map
(which also steps the projection up), and the **base**.

Two parts are copied rather than approximated because each is a measured answer to something
that looked wrong on a screen:

* **The grade.** Sampled colours are honest and raw. Saturation is compressed toward a
  filmic middle and capped at 52, lightness is banded so a black map cannot drag the ground
  to nothing, and hues in 58-92 degrees — the acid yellow-green — are rolled 40% toward
  olive. On this site that last one is funny and exact: the colour it rolls toward is the
  site's own ground.
* **The tween is in OKLCH, on a rAF.** HSL's midpoints are lies; halfway from blue to orange
  in HSL is a muddy grey-purple, and every map-to-map change used to drag the page through
  one. The six `--amb-*` are `@property ... inherits: false` and are written on one element,
  which on Movement was the difference between 10-11.7 ms and 0.01 ms a frame with a big map
  list mounted.

**Where the colour comes from is the one thing that changed.** Movement bakes its map colours
offline into `mapColors.json`. This site samples them **in the browser** from `maps.art` with
Movement's own extractor, copied verbatim (`client/src/data/sampleColors.js`) — because our
art arrives whenever the archive crawler finds a cover, and a baked table would be stale by
the next one. **A map with no art takes the WaW default pair** (olive 66 degrees, dried blood
4 degrees) rather than a hue invented from its name, and so does a page with no map selected
— the same pair through the same grade and tween, so picking a map reads as the map arriving
rather than as the site changing.

Proven on the live data: `/m/nazi_zombie_dt2` (City of Hell, a red cover) washes the whole
page red; `/m/nazi_zombie_school` (concrete) washes it grey-green; with nothing selected the
page is the WaW pair.

### 10c. Map art, wired in (the archive lane's media step)

`archive/manifests/*.json` now carry `archive.cover`, a path into the archive work directory.
`db/import-archive.js` **copies** the one cover per map into `web/public/media/maps/<key>.<ext>`
and writes `/media/maps/<key>.<ext>` into `maps.art`; `server/index.js` serves `/media` with a
seven-day cache. Fourteen covers, 2.5 MB, gitignored — they are derived, and
`npm run import:archive` puts them back.

A copy rather than a static mount over `ZombiesDev`, for two reasons. The site has to be
servable from a machine that is not B's PC, and a dev-box path mounted into the public web
server is a dead image on every card the day it moves. And a directory the archive pipeline
writes into is not one a public web server should read out of: a file lands there the moment
it is fetched, before it has been scanned or even finished writing. The manifest's path is
resolved against the work directory and then checked to still be inside it, and the extension
is allow-listed — `../../../Windows/win.ini` and `.html` both go nowhere.

### 10d. The wipe, and what "fake" turned out to mean

`web/tools/wipe-demo.js` (`--dry-run` says what would go). Rule 7's "do not write to
`web/data`" was lifted by B for this script on this night and nothing else.

**It is not `games.demo = 1`.** All eight games on the live database carried `demo = 0`,
because the seed did not write them — real host-agent *simulations* did, posting real results
through the real ingest path. That is what made them worth having while the pull protocol was
being proved, and it is exactly what made them indistinguishable from a Friday night's play.
So the rule is by table, not by flag.

```
backup  web/data/backup-20260922-033847Z/zombies.db   (VACUUM INTO, so the WAL is in it)
        161 rows + 4 demo accounts
        games 8 - game_players 13 - records 21 - replays 8 - local_matches 4
        badge_awards 19 - badge_holds 9 - xp_ledger 11 - map_progress 12
        comments 4 - ratings 10 - favourites 2 - feed 24 - playlists 3 + 4 maps
        parties 1 - party_members 1 - presence 3 - reports 1 - friendships 3
kept    maps 2,284 - badges 23 - boards 138 - presets 6 - boxes 2 - activity_log 7
        users (real only), admin and mod flags included
```

**The backup is the feature.** It goes through `VACUUM INTO` rather than a file copy so the
write-ahead log is checkpointed into it — a plain copy of a WAL database can be missing the
last few minutes of writes, which is the worst possible property for a backup taken
immediately before a delete. The test that matters asserts the backup **holds the rows the
wipe then removed**; a "the file exists" assertion would pass on a backup taken afterwards.

**The half that is easy to miss, and was:** the denormalised counters. `maps.plays`,
`beaten_by`, `thumbs_up/down` and every account's level, prestige, XP and pinned badges are
cached sums the deletes cannot reach. Caught by opening the page after the first run and
finding *"Beaten by 2 - 1 game - 50%"* on a map with no games anywhere in the database — which
is worse than the demo data was, because it is a number with nothing underneath it. They are
zeroed rather than recomputed, because there is nothing left to recompute from.

Seeding demo content was **already** behind `--demo` / `ZM_SEED_DEMO=1` and never happens by
default; `--demo` also refuses outright on a database holding a real game unless
`--force-demo` is given. Nothing there needed changing.

### 10e. Steam sign-in only

`routes/auth.js`. The mock page is registered **only in mock mode** now (`ZM_AUTH` unset or no
`ZM_PUBLIC_URL`), so on zombies.enw.gg those two routes do not exist; and `mockAllowed()` is
back to *never in production, otherwise loopback only*, with `ZM_ALLOW_MOCK=1` as the one
escape hatch, which exists for the test suites and is set nowhere else.

**Retracted, in place:** the §5 line that kept the mock registered beside Steam "for as long
as the closed-beta gate is up". The insurance it bought was one less way to be locked out.
What it cost was that the shared beta password — held by four people — was a way to sign in as
**anyone, including the admin**, and §9 has since shown Steam OpenID working. The launcher's
browser leg is untouched and still covered: `test/launcher-signin.js` is 14 checks now, and
one of the new ones asserts `/auth/mock` is a 404 on a Steam site, both verbs.

### 10f. Party map-download progress

`POST /api/party/:id/progress`, contract in `docs/protocol/launcher-v0.md` §2 — which the
launcher lane had already written and which the site now matches. `lib/partyProgress.js`,
and it is `lib/live.js`'s three decisions for `lib/live.js`'s reasons: **never SQLite** (a
byte count that is wrong 900 ms later, on the file that serves every page, that nothing reads
back), **the launcher pushes**, and **rate is our problem** — a post inside the 400 ms floor
is accepted and dropped rather than refused. Broadcast on the socket to each member's own
`user:<steamid>` room; there is no `party:<id>` room to keep in step with the party table.

**The rule the whole thing turns on is that silence is not "still downloading".** Writing it
the obvious way — Start enabled only when every member says `installed` — would grey the
button out for every party on the site, because today most members are in a browser with no
launcher to report from. So known-bad blocks and silence does not: Start stands down when
somebody is `downloading` or `failed`, both of which are facts. `POST /party/ready-check`
refuses for the same reason and names who, and `{force:true}` is the leader's way past it —
the same override, and the same sentence, as launching with somebody unready.

### 10g. Profiles

Nothing to do. `pages/Profile.jsx` was already Movement's: the eight-stat career strip, the
map shelf with its ticks and gold record state, the badge shelf and pinned row, recent games,
records held, most played, favourites and comments. Checked against a wiped account and every
number reads zero honestly rather than blank.

### 10h. Approvals, and the tests

`web/tools/approve.js` runs **the same two statements** `routes/admin.js` runs for
`POST /api/admin/player/:who/approve` — set `approved=1`, write a `user.approve` line into
`activity_log` — deliberately, because an approval that left no audit trail would be an
approval nobody could later account for. Seven accounts, four of which had no row yet;
`users.ensure()` makes one, which is safe because it holds nothing but the SteamID and the
default settings until Steam sign-in fills in the persona.

`npm test` (a new alias for `npm run check`) is **105 checks**: 64 in-process, 27 over HTTP,
14 sign-in. New here: seven for the progress route (a non-member refused, an unknown state
refused, the payload's per-member bars and Start gate, silence not blocking, the ready-check
refusal and its override, the map change clearing it, and the broadcast reaching both members
and nobody else) and three for the wipe (the dry run touching nothing, the backup holding
what the wipe removed, and the keep/delete split including the counters).

### 10i. Still open

* **The global chat panel has no page.** It came off with the rail. `lib/chatNetwork.js` is
  real and the boxes drain it; it needs somewhere to live — a drawer on home, or its own page.
* **Map art for the other 2,270 maps.** Fourteen have covers. Every card and every row without
  one falls back to the engine key, and the background falls back to the WaW default.
* **`/maps` is now the second map browser.** Home is the one you play from and `/maps` is the
  one with the four filters and the shareable URL. That is defensible, and it is also two
  lists of maps on one site — worth a decision rather than a drift.
* **Boards are seeded for the stock maps only**, so an archive map's page says "No boards yet"
  where it should say which boards it would have.
* **A second account holds admin.** `76561198396250036` (zeroh) was already `is_admin=1` on
  the live database before tonight; `approve.js` did not grant it and has not removed it. If
  that was not deliberate, it is one UPDATE.

### 10j. `/download` (added after the deploy, same night)

A short install page behind the beta gate: the lockup, the installer, three steps, one line
saying it is a beta. `client/src/pages/Download.jsx`, linked from the nav — Movement has no
equivalent because it has no client to install, and the other candidate (the party panel's
empty state) is only on home and only when signed out, while the person who most needs this
is a signed-in player whose launcher is out of date. It is in both places now, the nav tab
being the one on every page.

**The version is read, not written.** The page fetches `/updates/latest.yml` — the feed the
launcher lane publishes — and takes the filename, the version and the size out of it. Hard
coding `0.2.0` would mean this page and the auto-updater could disagree the moment 0.2.1
ships, and the page would be the one pointing at a file that no longer exists.

**No restart was needed and none was taken.** `/updates` was already served statically and is
gate-exempt (an installer is not a secret, and electron-updater cannot answer a password
prompt); `client/dist` is served by `express.static`, which reads from disk per request, so a
rebuild is live as soon as it lands. Verified on the public URL: `/download` served the new
bundle hash, `/updates/latest.yml` returned `version: 0.2.0` with no password, and the 94 MB
installer answered a range request with `206`, which is what the updater needs.

**Party default mode is `verified`** — confirmed in both places it could be wrong:
`parties.create()` defaults `mode = 'verified'` and the `parties.mode` column is
`TEXT NOT NULL DEFAULT 'verified'`. The panel's segmented control reflects it, so a party made
by pressing "Start a party" and then Start plays stock settings and is tracked.

---

## 11. The morning the site became Movement (2026-09-22)

B's list, in the morning, after §10: two views on the maps page with all of Movement's filters
re-worded for zombies; home rows he names; the map entry rewritten; badges into the user menu;
**one theme, Movement's**; a three-link nav with the search top-left and the account top-right.
Then two addenda during the pass: Play in a browser goes to `/download`, and a result may credit
only a `verified` player row.

### 11a. What is copied, file by file

Every row here is a copy rather than an approximation, which was the brief ("copy components and
CSS wholesale, change only zombies nouns and data"). Where a line diverges, the divergence is the
data underneath, not the drawing.

| Ours | From ENW Movement | What changed on the way over |
|---|---|---|
| `client/src/components/Nav.jsx` | `movement-client/src/components/Nav.jsx` | three links instead of six; our lockup joins the centred group |
| `client/src/components/UserMenu.jsx` | `components/UserMenu.jsx` | VIP item dropped (no Movement entitlement here); Badges kept in Movement's own slot, under Profile |
| `client/src/components/SearchBar.jsx` | `components/SearchBar.jsx` | two result kinds (maps, players) instead of four; the per-browser history is not ported; ranking is the server's |
| `client/src/components/MapCard.jsx` | `components/MapCard.jsx` | the caption is name / bsp / author / date; the tier chip and PB become nothing (see 11c) |
| `client/src/components/MapListRow.jsx` | `components/MapList.jsx` → `RecordTable density="pick"` | our columns, Movement's pick density. We do not have a records deck to render it through, so it is a row of its own at the same measurements |
| `client/src/components/MapRow.jsx` | `components/MapRow.jsx` | **verbatim**, mechanism and comments. The measured page step, the scroll-container-for-the-keyboard decision and the absent-not-disabled arrows are all its |
| `client/src/components/MapRows.jsx` | `pages/ModeHome.jsx` (its row section) | the rows come from a table, not from three hard-coded queries |
| `client/src/components/Icons.jsx` | `components/ServerIcons.jsx` | four glyphs of the set, same language |
| `client/src/pages/Maps.jsx` | `pages/Hub.jsx` + its `PickBar` | two views instead of one; our filters; the URL holds the state where Movement holds it in localStorage |
| `client/src/themes.js` | `themes.js` | one skin, no palettes |
| `client/src/theme.css` `:root` | `theme.css` `:root` ("Radio") | verbatim, including the derived OKLCH signal family and the note saying why |
| `client/src/theme.css` `.mv-nav` / `.nav-search` / `.um` | the same blocks | `--panel2` → `--panel-2`, our token spelling |
| `client/src/theme.css` `.map-card` / `.maprow` / `.rdk-bar` / `.modeview` | the same blocks | the caption is three lines rather than one; `--h` is a holding hue rather than a baked map colour |

### 11b. Two views, and one list behind them

`/maps` draws the pool as a **list** — each row is the map's page entry, with the art — or as a
**card grid**, and both are fed by the same filtered array off one request. Movement's own note
is the reason they are not two code paths: when they were, the same filter produced two different
orders depending on which way you happened to be looking.

The view is remembered per browser and can be stated on the URL (`?view=cards`), which is the only
thing this page remembers. A filter is what you are doing right now, and a pool that opened
already narrowed to last week's question is the site answering something nobody asked.

**The filters, and Movement's rule for them.** OR within a group, AND across groups, an empty
group constrains nothing — so the default is the whole pool and every tick can only narrow it.
That rule is enforced in `server/lib/maps.js`, not in the page, and it has a test, because getting
it backwards makes "Large and Hard" quietly answer "Large or Hard", which is most of the archive.

| Group | How | Notes |
|---|---|---|
| Finish | segment | Any / Easter Egg / Buyable Ending / Round-based. **This is where the words under every map went** |
| Size | chips | tag kind `size` |
| Difficulty | chips | tag kind `difficulty` — **not drawn today**, because nothing is tagged yet |
| Style | chips | tag kind `style` |
| Stock vs custom | segment | `maps.source`, which already existed |
| Playable on our server | chip | `health in (verified, playable)`. Narrower than "in the list": a `custom-only` map is a real map a real person can run at home |
| Has records | chip | a board with a record on it, **or** a stored replay |
| Author, Year, Tag | selects | a dropdown of nine hundred authors is not a filter; nine hundred chips is the same exercise with more pixels |
| Your progress | select | signed in only — signed out both options claim the whole pool or none of it |
| Include broken | chip | the archive view |

Sorts: popularity, rating, newest, release date, name.

And Movement's other rule, which is what keeps the bar honest: **a group is drawn only where the
pool actually splits on it.** Difficulty is absent rather than three chips that each empty the
page. That is also the answer to "where is difficulty" — it is implemented, it has no data, and
inventing some would be the site describing what it does not know.

### 11c. The map entry, and the words that came off it

Name first — "Clinic of Evil" — then the bsp name as the subtitle (`sanatorium`), then the author,
then the release date. `client/src/data/mapText.js` owns all four, so the card, the list row and
the search hit cannot drift.

Two small things in there that are decisions rather than formatting:

* **Titles are title-cased for display when the stored title is all caps.** The crawl recorded
  "CLINIC OF EVIL" because that is how the forum post shouted it; B writes it as Clinic of Evil.
  A title that already has case of its own — "UGX Requiem", "BO2 Hijacked Zombies" — is left
  exactly alone, and nothing is written back to the database: the crawl records what the source
  said and this is a reading of it.
* **The bsp name is printed whole**, `nazi_zombie_leviathan` and not `leviathan`. It is the
  filename the player sees in their mods folder, in a download and in the console, and a subtitle
  that quietly drops the prefix is a second spelling of the one identifier the game uses.

**"Buyable Ending · Easter Egg · Round 20" is gone from the list and the card entirely.** It is a
filter now. A label that is true of a quarter of the archive and printed under all of it is not
information. The map's own page still states what counts as beating it, out of the referee
manifest, because that is a page somebody opened to find out. The same reasoning killed an "Our
servers" chip on the list row before it shipped: it was true of twelve of nineteen rows.

### 11d. The home rows are a table

**New maps**, **Vanilla** (Nacht der Untoten, Verrückt, Shi No Numa, Der Riese) and **High
production** (seeded with Leviathan alone). They are `collections` + `collection_maps`, new tables,
additive migration, DB backed up first to `web/data/backup-20260922T144026Z/` via `VACUUM INTO`.

Two kinds: an **auto** row is a query resolved at read time, so a map imported tonight joins "New
maps" with nobody editing anything; a **manual** row is its maps in the order an admin put them.
Vanilla and High production are judgements, so they are manual.

It is deliberately **not** `playlists`. A playlist is a thing you complete for a badge — it has a
reward, a live date and per-player progress — and hanging a shelf off that machinery would make
every row on the home page a challenge somebody could be half way through.

**Edited from Admin → rows.** Show/hide, move up and down, add and remove maps; every write is
logged to `activity_log` with the actor, because a shelf that changed and nobody can say who
changed it is an argument waiting to happen. Three guards that each have a test:

* the seeder writes a row's membership **only on the visit that creates it**, so a map an admin
  removes does not come back on the next restart;
* a manual row is resolved **through `maps.list()`**, so a map that has since been marked broken
  cannot reach a shelf even though an admin put it there;
* a row that resolves to nothing is **not drawn at all** — an empty shelf reads as a broken site.

The same rows fill home's right-hand region when no map is open, which is what §10's "Pick a map"
card used to be. §10's left column — the party panel and the 302px map pool — is untouched.

### 11e. One theme

`themes.js` is one token block and an `applyTheme()`. The Zombies / Ember / Dusk dropdown is gone
from the nav and so are the other two palettes; `theme.css`'s `:root` is Movement's, verbatim,
including its derived OKLCH signal family.

**The olive was hiding in a second place and would have survived the deletion.** `ambience.js`'s
`WAW_DEFAULT` is the colour pair the ambient system pours when nothing is selected — which is how
the site opens — so every page would still have been washed the old brand green with the palette
removed. It is near-neutral now: the same two hues at a chroma low enough that the grade's own
floor is what you see. Movement's sentence, which is the whole point: *the site is grey, and the
map you are on is the colour.* The per-map tint of §10b is unchanged and still crossfades in OKLCH
on a rAF; `index.html`'s `data-theme`, `theme-color` and inline favicon moved with it.

### 11f. The nav

**Maps, Records, Admin** (Admin for staff). Search top-left where Movement's is, absolutely
positioned so the links stay centred on the bar whatever the box and the account name measure.
Account top-right with Movement's dropdown: Profile, Badges, Settings, **Sign out**.

* **Badges** was a nav tab and is now under Profile, Movement's own placement and its own reason.
* **Playlists and Custom** keep their routes and their deep links; only the permanent tab went.
  They are linked from Admin → rows → Elsewhere.
* **Sign out left the header.** It was the most destructive control on the site, drawn as a button
  in the bar at the same weight as the thing beside it.
* **Settings** is a section of your own profile (there are eight of them and they are all about
  how the game runs for you), so the menu item is `/id/<you>#settings` and that section is now an
  anchor.
* **Download left the bar too**, and did not need a replacement: every Play button in a plain
  browser now goes there by itself.

### 11g. Play in a browser goes to `/download` (B's addendum)

Nothing in a browser tab can start World at War. Before this, Play, Play Local, Start, Ready, Go
and both *Start anyway* overrides were requests that either failed on the server or succeeded into
a party the person had no way to join, and the site never said the one thing that was actually
wrong.

`client/src/components/playGate.js` is the gate. `guard(intent)` returns **true** when it has taken
the person to `/download`, so every call site reads `if (guard(...)) return` — one line, impossible
to half-apply. Inside the launcher it returns false and everything behaves exactly as it did.

**How we know.** Two signals and either is enough: `window.enw`, the preload bridge, which is the
thing that can actually launch a game; and `me.launcher`, the server's reading of the
`X-ENW-Launcher` header the wrapped view stamps on every request — **the header the launcher lane
offered us in `launcher-v0.md` §6 and which had never been taken up.** It is true before any client
JS has run, which is what a first-paint decision needs. They disagree honestly in both directions
(a launcher whose preload failed still sends the header; a dev page opened straight in Electron has
the bridge and no header) and in both of those the person **has** the launcher.

**The deep link is `enw-zombies://` — hyphenated.** `launcher-v0.md` §7 says so explicitly and says
the unhyphenated `enwzombies://` of §3 is the older spelling not to build against. Both routes we
need already exist and are implemented:

| The person pressed | `/download` gets | its button sends |
|---|---|---|
| Play / Play Local | `?map=<key>&then=/m/<key>` | `enw-zombies://map/<key>` |
| Start / Ready / Go | `?party=<id>&map=<key>&then=/` | `enw-zombies://party/<id>` |

`/download` offers **"Open in the ENW Zombies launcher" before the installer**, and says what it is
installing for: *"Install the launcher to play Clinic of Evil"*, with the title fetched rather than
taken off the URL, because a title in a query string is one somebody can rewrite and this one is
printed as fact. The fallback is a **reveal, not a redirect**: there is no way to ask a browser
whether a scheme is registered, so the page navigates to the link and after 1.6 s says nothing
happened. It does not navigate anywhere on that timer — that is exactly when the OS's own "open
this application?" prompt is on screen, and a page navigating then would be fighting it.

`then` comes off the URL and is treated as hostile: a site-relative path and nothing else.
`//evil.example` is a protocol-relative URL that a naive "starts with `/`" check lets straight
through, which is how an open redirect is usually built.

**One thing that was broken and is now fixed**: §7 says `enw-zombies://party/<id>` navigates the
wrapped view to `/party/<id>`, and the site had no such route — it was a 404. `/party/:id` now
renders home, where the party panel is. It does not join anything; §7 says joining is the site's
decision, and the site's decision is the invite the person already holds.

### 11h. Identity: who a result may credit (referee lane addendum)

`docs/protocol/game-link-v0.md`, referee commit `bd3bd59`: a result's `players[]` rows carry
`identity` — `none | claimed | verified | refused` — and a `steamid` only when `verified`.

**Only `verified` is credited.** The other three are attendance: they stay in `summary_json`,
which is the whole result exactly as the box sent it, and they get **no `game_players` row** — so
no XP, no records, no badges, no map progress, because every one of those iterates `game_players`
or the seated list. The game is untracked for them.

Three decisions worth writing down:

* **`claimed` is the dangerous one**, and it is the one that looks safe. It means a token arrived
  and *parsed* — somebody sent a well-formed blob naming an account. Until the signature has been
  checked that is a claim about who was playing, and crediting a round-40 record to it would be
  crediting it to whoever typed the loudest.
* **An absent `identity` fails closed**, treated as `none`. Every box that can post to
  `/api/gs/result` speaks the current protocol; a body without the field is either older than
  today or is not a referee, and "we could not tell" has to fail closed on the one path that hands
  out records.
* **The gate is on the box path only** (`/api/gs/result`, `/api/gs/spool`), passed in as
  `requireVerifiedIdentity`. A Local run never had a token to check, already scores zero of
  everything (`mode: 'local'` forces `records_eligible: 0` and `xp_multiplier: 0`), and its one
  consequence is the player's own "played" tick on their own machine. Gating it would delete that
  and protect nothing.

A refusal is written to `activity_log` as `result.unverified` with the box, the match and each
row's identity, and logged on the console — a player who finished a round-40 game and got nothing
will ask why, and that is the row that answers.

### 11i. Tests, screenshots and the deploy

`npm test` is **120 checks** (was 105): 75 in-process, 31 over HTTP, 14 sign-in. New:

* the filter contract — OR within a group and AND across groups, an unknown slug matching nothing
  rather than being ignored, and `?tag=<one-slug>` still meaning what it always meant;
* "our servers" being narrower than "in the list", and "has records" reading the boards and the
  replays rather than the map row;
* four on collections — the seed, a row resolving through `maps.list()` in the admin's order, a
  broken map not reaching a shelf, and **a removed map staying removed across a restart**;
* four on identity — a `claimed` row earning nothing while the result is still stored, a
  `verified` row credited exactly as before, `refused`/absent failing closed, and a Local run not
  being gated;
* four on the launcher signal — both directions, a signed-out visitor, and a 500-character header
  value being cut to 32 rather than echoed back.

Screenshots (headless Edge, 1440 wide, against a private instance on 3399 holding a copy of the
live database — `web/data` was not touched):
`ui/maps-home-rows.png`, `ui/maps-list-view.png`, `ui/maps-card-view.png`, `ui/download-gate.png`.

**The site was restarted once, via the keepalive path**, and this section says so because §10j's
did not need one and this did: the new bundle asks `/api/maps/home` for `rows`, and against the
old process every row on the page would simply have been missing. `Stop-Process` on the site's pid
then `infra\keepalive.ps1 -Once`, which is the path that loads `infra/site.env` — so the beta
password and Steam mode came back with it rather than being lost to a hand-rolled start. Verified
after: `127.0.0.1:3200` answers 401, `zombies.enw.gg` serves the same bundle hash as
`client/dist`, `/api/maps/home` returns the three rows, `?server=1` returns 12 of 19, and
`/api/me` with the launcher header answers `launcher: true`. `cloudflared` was not touched.

### 11j. Still open

* **Difficulty has no data.** The filter is built and hidden. It wants an admin tag editor, or a
  pass over the pool by somebody who has played them.
* **Art for the other 2,270 maps** — §10i's item, unchanged. Fourteen covers; every card and row
  without one falls back to the engine stem.
* **`/maps` and home are still two map browsers**, §10i's question and still a fair one. They have
  grown *closer* this morning rather than further apart — the same rows, the same card, the same
  entry text — but home is the one you play from and `/maps` is the one with the filters and the
  shareable URL.
* **The global chat panel still has no page.** §10i, unchanged.
* **Collections have no drag-reorder** — add and remove, and the row's own order is the order they
  were added in. `reorder()` exists on the server and nothing calls it.

## 12. The night chat got its dock, and the Discord link (2026-09-23)

B: *cross-server chat exactly like ENW Movement's, across every Zombies game; you see other
players launching a server and joining a map; you see friends go down ("`<name>` just downed on
round 30 on `<map>`"); a link to the ENW Discord at the top right like Movement, shown only if you
are not in the Discord.* The in-game overlay half is `chat-overlay.md` and is a plan, not code.

**§10i and §11j's open item is closed.** The global chat has been real since the first week —
`lib/chatNetwork.js`, the ring the boxes drain over `/api/gs/chat-feed` — and has had nowhere to
live since the party rail came off. It has a dock now, on every page.

### 12a. What was already built, and what tonight actually added

Most of the server side existed. This is the honest accounting, because "ported Movement's chat"
would otherwise read as more work than it was:

| | |
|---|---|
| Already there | the ring, the cursor, the long-poll drain, `POST /api/gs/chat`, `GET /api/chat`, the socket emitter, the host agent's bridge in both directions |
| New tonight | the dock (`components/ChatDock.jsx`), `kind` on a line, the system lines (`lib/chatSystem.js` + `POST /api/gs/event`), the `player_down` event in the referee and its bridge, the Discord link, `#chat` |

### 12b. A dock, not a page

A page was the wrong answer to "the chat has no page". Chat is the thing you keep half an eye on
while doing something else, and a page is the one place you cannot be while you are browsing maps.
So it is a **dock**: a tab in the bottom-right corner, **collapsed by default**, opening into
Movement's chat console. It sits above the router for the one reason the party rail did — it
survives navigation — and it is a corner rather than a column for the reason the rail was
deleted: B had just approved a map browser with no third region in it, and the launcher wraps this
site on every page.

Open/closed is remembered per browser in `localStorage`, and **`#chat` on any URL opens it**,
which is the closest thing to the page and a better one: a link somebody pastes lands them on a
real page of the site with the conversation open beside it rather than on a page that is only the
conversation.

The console is `movement-client/src/components/admin/ChatConsole.jsx`, copied in mechanism and in
reasoning: the opaque black log (*a see-through console reads as a panel with text on it*), the
`csc-*` line grammar, `[net]` printed for a line that belongs to no map, the character count, and
the scroll rule that pins to the bottom **only while the reader is already there**. What changed
on the way over is the game's nouns — no team colours (zombies has no sides), no `*DEAD*`, no
per-mode channel chips, because there is one room.

**Enter sends, and it had to be made to.** The form has a submit button, so implicit submission
should have worked, and against the live bundle it did not: Send worked and Enter silently did
nothing. Home binds the keyboard for the map rows (`MapRow.jsx`) and the dock floats over every
page, so a key pressed in the box is a key another component is also listening for. It is an
explicit `onKeyDown` with `stopPropagation` now — the second half matters too, or a line you just
sent also pages the map list behind the panel. Found by trying it, not by reading it.

### 12c. System lines: the box sends the fact, the site writes the sentence

Four lines, in the same channel as everything else, because the whole point of them is that they
read as part of the conversation — you see a friend start a game, you see them go down, you say
something about it. An activity feed beside the chat would be the same information in a column
nobody looks at.

```
  tinned_peaches started a game on Verrückt
  mule_kicker joined Verrückt
  mule_kicker just went down on round 30 on Verrückt
  tinned_peaches's game on Verrückt ended on round 30
```

**They are composed on the site, never on the box.** `POST /api/gs/event` takes
`{event, name, steamid?, identity, map, round, match_id, instance}` and `lib/chatSystem.js` writes
the prose. Two reasons and they are the same reason twice: the handle a line should carry is the
site's user for a `verified` identity and the in-game name otherwise, and only the site holds the
user table; and a box that composed its own sentence could put any sentence it liked in a channel
everybody reads. The worst a broken box can now do is claim a wrong name, which is all it could
ever claim.

**`verified` or the in-game name — the same gate as §11h.** `claimed` is the dangerous one and it
is the one that looks safe: a token arrived and *parsed*, and nothing has checked the signature.
A line printing a site handle is the site saying *this was them*, so it fails closed to the name
the server actually saw. An absent identity is treated as `none`.

Four more decisions with tests behind them:

* **`kind` is a column, not a prefix.** A marker inside the text is a marker a player can type.
* **The ring origin is the reporting box**, so the box that just watched it happen does not get
  the line back on its next drain and re-announce it to those same players.
* **Dedupe and a per-match ceiling.** The same (event, map, handle, round) inside 20 s is one
  line; no one match may produce more than 20 lines a minute. A player who goes down four times
  in a round is four lines; a box that reconnects and replays its roster is not; a looping box
  cannot make the room unusable.
* **A refused player is never announced.** A game saying somebody it just kicked joined it is the
  one system line that would be a lie.

**Which connect is a "start" is the host's decision**, because only it can make it: the first
player to connect started the game, everybody after them joined it, reset on `map_loaded` so a
warm instance's next game does not read as five people walking into the last one.

### 12d. `player_down` — a new event, and why `down` stayed

`server/components/referee/referee.cpp` already emitted `down` on the down edge, carrying a slot
and nothing else. That is everything a ruling needs and nothing a *sentence* needs: by the time a
line reaches the chat ring, a slot is a number belonging to a game nobody reading it is in.

So the referee now emits **both** on that one edge: `down` unchanged, and `player_down` with the
name, the round and the map. Not a rename — hosts fold `down`, and renaming it would silently stop
counting downs on every box not redeployed the same night. It carries **no `steamid`**: the host
already holds the roster and the identity, and §13's rule is not relaxed for a chat line. Protocol
table and the full reasoning: `docs/protocol/game-link-v0.md`.

The host's referee has no `ev_player_down`, which under the protocol's "unknown types are ignored"
means it changes no ruling — and it must still be counted and recorded, because the stream is
evidence. There is a test for exactly that, and one for the thing it would be easy to get wrong:
`down` and `player_down` arriving together is **one** down, not two.

### 12e. The Discord link — and what Movement actually has

**Correction to the brief, and it matters for what B has to supply.** Movement's top-right Discord
link is *not* on its `main`: it is `movement-client/src/components/DiscordNavLink.jsx` on the
branch `claude/pvp-url-rewrite-installer` (commit `37b7ef58`). And **its invite is a hard-coded
module constant, `https://discord.enw.gg`** — not env, not config, not a row; there is no
`discord.gg/…` literal anywhere in that repo. So there is nothing for B to supply for the link
itself: it is the same community and it is the same URL, with `ENW_DISCORD_INVITE` in
`infra/site.env` as an override for the day that changes.

The component is a port, mechanism and reasoning: shown to anybody the site has not linked to a
Discord account; shown when signed out, because signed out nobody is known to be in the Discord;
an X that hides it for 24 hours on that browser and then it comes back; a tab left open all day
gets it back on a timer rather than on a reload. Blurple (`#5865F2`) is the one branded colour on
a grey site, and it is Movement's choice for Movement's reason — it is a third party's mark, and
drawing it in our accent would be drawing our badge on their door.

**What is honestly missing: nothing writes `users.discord_id`.** The column exists
(`discord_id`, `discord_name`, `discord_linked_at`, additive), the gate exists
(`server/lib/discord.js`, surfaced as `session.discord`), and the two things that fill it in
Movement did not come over: its **OAuth link flow** (`server/lib/discordLink.js`,
`server/routes/discord.js` — scopes `identify connections`, ships dark behind
`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_REDIRECT_URI`, refuses a Discord account
whose own Steam connection names somebody else) and its **in-game verification importer**
(`discordVerifiedSync.js`). Both port straight in. Until one does, **the link shows for everyone**
— which is the failure direction that is merely untidy: an invite shown to somebody already inside
is a link they ignore, an invite hidden from somebody outside is the feature not working.

The client is never handed a URL it is not supposed to draw: `/api/me` returns
`discord: { linked, invite }` with `invite: null` once linked, so the rule lives in one place and
the nav cannot get it wrong in a second one.

### 12f. Tests, the proof, and the deploy

`npm test` is **131 checks** (was 120): 84 in-process, 33 over HTTP, 14 sign-in. New: the `kind`
column and that a player typing "system" does not make one; the four sentences; the handle gate in
all three directions; the ring origin; dedupe and the per-match ceiling; an unknown event
producing nothing; a map with no title named by its bsp rather than by a blank; the Discord gate
and the invite override refusing a nonsense value. Over HTTP: `POST /api/gs/event` refusing a
player session carrying a guessed box secret, and the ring being readable signed out — the dock is
on pages a stranger sees, so the fill must not need a session even though talking does.
`infra/host-agent`'s `run-all.js` is **49** (was 46), for `player_down`.

**The proof, and what it is not.** `ui/chat-live.png`: two sessions, three system lines, an
exchange. Session A is a browser; session B is a second session with its own cookie jar on the
same socket the dock uses, plus the box door for the system lines. It is **not** on
`zombies.enw.gg` and it could not be: the live site is `ZM_AUTH=steam` and an agent cannot sign in
as a Steam account, so two signed-in browser sessions there is something only B can do. It is a
private instance on **3401** holding a `VACUUM INTO` copy of the live database, with invented
handles set **on the copy only**; `web/data` was not touched. What *was* checked on the live site,
through the beta gate and read-only: the served bundle contains the dock and the Discord link,
`/api/me` answers `discord: { linked: false, invite: "https://discord.enw.gg" }`, `/api/chat`
answers 200 signed out, and `POST /api/gs/event` without a box secret answers 401. The live ring
is still empty — nothing of this test reached it.

**Deployed**, by the path §11i established: `npm run build` in `client`, `Stop-Process` on the
site's pid, `infra\keepalive.ps1 -Once` (which loads `infra/site.env`, so the beta password and
Steam mode came back with it). `cloudflared` was not touched.

### 12g. Still open

* **Nothing links a Discord account** — §12e. It is the one thing B has to decide about, and the
  decision is whether to create the Discord app (client id, secret, redirect URI) or to leave the
  link shown to everyone, which is not a bad state.
* **One channel.** No per-map rooms, no DMs, no channel picker. Every one of those is a schema
  change wearing a UI, and one room is what the ring holds.
* **A system line about a game nobody can watch is still announced.** The live view has a
  visibility rule (`lib/live.js` `canWatch`) and the chat does not consult it: a private party's
  game announces its start to everyone. It is a name and a map, it is what B asked for, and it is
  written down here because it is the kind of thing that is obvious only after somebody minds.
* **The unread count is per-tab and resets on reload**, because it is derived from what arrived on
  this socket rather than from a read cursor.
* **The in-game overlay** — `chat-overlay.md`, 3.5–5.5 days with the whole risk in finding T4's
  2D text draw.

## 2026-09-23 — everybody has an ENW name, and the game cannot invent one

B: *"Make people's usernames their ENW username … right now it says Unknown Soldier, which is
annoying."*

### The bug, which was on this side and not in the game

`lib/results.js` line 269 took the name the **game** reported and wrote it into the account:

```js
users.ensure(sid, { username: str(p.name, 64) })
```

Nothing ever passed `+name`, so the client booted as the engine's stock `name` default —
"Unknown Soldier" — the box posted that on the roster, and this line made it the player's site
username. The live database carried exactly that: the owner's row held `username = 'Unknown
Soldier'` and the other six approved rows held `NULL`, so `users.pub()`'s fallback chain
(`enw_name || username || steam_id`) was rendering either the engine's default or a raw SteamID.
There is no Steam Web API key by decision (99 §4.1), so `username` was never going to fill in.

That line is **removed**, with the retraction in place. `users.ensure(sid)` still runs — a
verified player who has never opened the site needs an account for XP and badges to attach to —
just without a name. Nothing downstream needed one: `game_players` is keyed on `steamid` and
always has been.

### Where the ENW name comes from — and why not from Movement's SSO

The spec says the account links to *"the ENW name via SSO (a narrow API)"* (99 §4.1, 00 Q32), and
`lib/enw.js` has been the stubbed client for it since the start. Two findings:

1. **Movement's `POST /internal/sso/redeem` cannot answer this.** It takes an opaque single-use
   **ticket** and returns the `steam_id` it was minted for — a login handoff, and its own file
   says it exposes *"NO player data, no reads"*. It is steamid-**out**; we already know the
   steamid and want the name. Wrong direction, and no amount of configuration changes that.
2. **The real name authority is drops.ws, and Movement is itself only a mirror of it.**
   `CSGO-Matchmaker/server/lib/dropsNames.js` (owner directive 2026-07-30: *"two authorities
   would mean two identities per person"*) is the production client, and the contract is

   ```
   GET /internal/name?steam_id=<id64>   ->  { name, changed_at, has_name }
   header: x-internal-secret: <the shared string>
   ```

   **Our `lib/enw.js` was guessing a different one** — `?steamid=` with an `Authorization:
   Bearer`. Wired up as it was, the day `ZM_ENW_BASE` was set every lookup would have 403'd on
   the auth and 400'd on the parameter, and `call()` swallows failures by design, so names would
   simply never have arrived and nobody would have known why. Corrected: the header is sent, both
   parameter spellings go on the query, and `ZM_ENW_SECRET` is the env var for the shared string.

**B has to supply that secret.** No secret is invented here, so the API stays switched off, and
until it is on the fallback below is the authority.

### The fallback, which is what is actually running: a first-login picker

`web/server/lib/names.js`, ported from Movement's `POST /username`, minus the half that belongs
to an authority we are not:

* **Movement's rules, character for character** — 3–20, `[A-Za-z0-9_-]`, including its deliberate
  all-digits refusal (*a number is an ADDRESS on an ENW site*), plus a small reserved list of
  ours (`admin`, `console`, `unknownsoldier`, …). A name picked here can therefore never be one
  the real authority would reject on the day the secret lands.
* **Unique case-insensitively**, across `enw_name` **and** `username`, backed by a partial
  `UNIQUE INDEX … COLLATE NOCASE WHERE enw_name IS NOT NULL AND deleted = 0` (partial so
  anonymisation frees the name rather than reserving it forever).
* **Set once.** A rename is `POST /api/admin/player/:who/username` and nothing else. That is not
  laziness: the ENW name is what the invite token carries and what the referee pins into the
  server's copy of a client's userinfo, so a self-serve rename would hand straight back the
  spoofing the lock removes. Movement can offer one because the cooldown, revert window and
  rename history live on drops.ws; we have none of that apparatus.
* **It disappears the moment the authority is live.** `names.needsName()` returns false whenever
  `enw.enabled()`, and `claim()` refuses outright with `reason: 'authority'` — writing a name
  locally that drops.ws never agreed to is the split identity the whole directive exists to
  prevent.

Routes: `GET /api/me/username/check?username=` (answers available/not, never *who* holds a name —
that would make it an account-enumeration endpoint), `POST /api/me/username`. `/api/me` now
carries `needs_name` and `name_rules` so the client can put the picker in front of everything
else on a first login.

### The token's name is the account's, not the caller's

`lib/assignments.js` used to take `p.name` from whoever asked for the lease and sign it into the
invite token's `n`. The referee now **enforces** that name server-side, which turns a
caller-supplied string into a signed, server-enforced impersonation — strictly worse than the
spoofing it replaces. It is read from the `users` row by SteamID now, through the one reader in
`names.js`. An account with no name gets `P1`..`P4` rather than a raw SteamID, and is not locked.

### The seven accounts

`web/tools/seed-enw-names.js` (idempotent, `--dry`, `--force`): the seven approved SteamIDs
mapped to the handles from the site's own approvals. Run against the live DB —
**7 named, 0 kept, 0 missing, 0 refused** — and it also cleared the one `username = 'Unknown
Soldier'` it found. `enw_name` is now set for every approved account and the string is gone from
the database.

### Tests

`web/test/run-all.js` **89/0**, four of them new and the first is the regression that matters:

* a result never writes the game's idea of a name back into the account
* a name is set once, unique case-insensitively, and only an admin renames
* the rules refuse the names that would break the infostring or an ENW link
* the invite token carries the **account's** name, not the one the caller asked for

### Still open on this side

* **The picker has no UI.** The API and the `needs_name` signal are there; no React screen reads
  them yet, so today a new account is nameless until an admin sets one or `seed-enw-names.js`
  runs. That is the next piece of web work.
* `enw.refreshName()` has never been run against a real endpoint, because there is not one.

## 2026-09-22 — IP posture pointer

Read [`ip-posture.md`](ip-posture.md) before serving anything new: no Activision asset is served
by the site before public (§4 table); `/mapdata` stock exports are a testing-only carve-out (§5);
footer disclaimer and per-map "not made or supported by Activision" line are on the Before-public list (§9).

## 2026-09-22 (evening) — every map has a picture, and the map page is Movement's

Branch `web-maps`, rebased on main after web-cleanup / web-settings-2 / storage. B's two asks:
*"make sure every map has an image — if they don't have an image from the websites, rip an image
from the game files or something"*, and *"I kind of like what we've done here, but redesign the
map page to make it look a bit nicer"* — Movement's map page, with Call of Duty facts where
Movement has surf ones.

### The picture: four sources, first one wins

`tools/maps/map_art.py` (Python + Pillow, re-runnable, incremental). For every row in `maps`:

| Order | Source | What it is |
|---|---|---|
| 1 | **site** | the archive's scraped art: the 14 pipeline covers (§10c) and the catalogue covers `archive/fetch_art.py` pulled (archive.md §10) |
| 2 | **iwd** | the map's **own loading screen**, out of its own `.iwd`: an `.iwi` texture decoded by `tools/maps/iwi.py` |
| 3 | **stock** | WaW's own loading screens for the four Treyarch maps, read (never written) out of the Steam install's stock `.iwd`s |
| 4 | **placeholder** | a generated card: the map's name on the zombies ground, in the map's own `mapHue(key)`, **NO SCREENSHOT ON FILE** printed on its face. Seeded by the key, so a re-run writes the same bytes |

Output in `web/public/media/maps/` (gitignored, like the §10c covers): `<stem>.webp` 960x540,
`<stem>.thumb.webp` 400x225 for cards, rows, the pool and search, and `<stem>.loadscreen.webp`
where a map has scraped art **and** its own loading screen (the page offers both).
`manifest.json` beside them says, per map, which source won, where it came from and the source's
sha256. `--write-db` sets `maps.art` (`/media/maps/<stem>.webp?v=<hash>`; the hash is the
cache-buster, since `/media` is served with a 7-day max-age) and the new `maps.art_source`.

**Counts, final** (the run behind the live site, `web/public/media/maps/manifest.json` generated
2026-09-22 21:51Z, `--no-stock`): **2,348 maps: site 1,449 · iwd 19 · stock 0 · placeholder 880**,
plus **25** own-loading-screen second pictures. The 19 `iwd` winners are held maps with no scraped
cover (22:51 UK, after the popular-maps fetch added held maps); stock is 0 because the stock four fall to
the generated card under ip-posture §4.

*Interim, kept for the record:* at 22:30 on the dev copy (2,284 maps, catalogue fetch at 1,200 of
1,415) it was site 1,256 · iwd 0 · stock 4 · placeholder 1,024, plus 10 second pictures. *iwd 0*
was not a miss: every map whose files we held then also had a release-post cover, which wins.

Two things measured on the first run and fixed, kept because each looks right until it is not:

* **Verrückt got a community remake's cover.** The catalogue entry whose name normalises to
  `asylum` is "Asylum v2", and the norm match put its screenshot on the stock map. A stock map now
  never takes catalogue art.
* **A stale `<stem>.loadscreen.webp`** would make the page offer the same picture twice (the server
  offers the switch when the file exists). The script removes one its manifest no longer names.

**IP posture (ip-posture.md §4).** WaW's four loading screens are Activision's images. §4 allows
them in closed testing and says *"before public: no stock loadscreen on any served page"*.
`map_art.py --no-stock` (or `ZM_NO_STOCK_ART=1`) is that switch: the stock four fall to the
generated card, one flag and a re-run. Custom maps' own loading screens are the mapper's published
art, the same class as the release-post covers.

### The server

* `maps.art_source` and `archive_sources.size_bytes`, two additive columns (`db/database.js`).
* `lib/maps.js` `project()` adds `thumb` (derived from `art` by name; a non-`map_art` URL is its
  own thumb, so a card never points at a 404) and `art_source`. `detail()` adds `loadscreen`
  (when the file exists), `features`, and `download`: the size (the original we hold, else the
  largest **live** link) and the alive/dead link counts.
* `db/import-archive.js --catalogue` stores each link's measured size and refreshes it on a
  re-import; the pipeline-cover step no longer overwrites a `map_art` picture (it would take the
  thumb away from every card).
* `features` comes from `web/server/data/map-features.json`, **committed**, written by
  `tools/maps/map_features.py`, which reuses the referee scanner's two readers
  (`referee/scan_map.py`: MapEnts + GSC) on the maps whose files we hold: perk machines
  (`zombie_vending`; WaW's four named, a custom pack's extras **counted, not named**, because packs
  reuse specialty names for different perks), Pack-a-Punch (`zombie_vending_upgrade`), box
  locations (`treasure_chest_use`), wall buys (`weapon_upgrade`), wonder weapons (the map's
  `include_weapon` list against a named set), hellhounds (the dog AI type in the zone), traps,
  teleporters, power switch. Checked against the stock four: Nacht 0 perks, 1 box, Ray Gun, no dogs,
  no power; Verrückt 4 perks, power, traps, no PaP; Shi No Numa 4 perks, Wunderwaffe, dogs; Der
  Riese PaP, 3 teleporters, dogs, Wunderwaffe, monkeys. No files, no block: the page prints nothing.

### The page

`client/src/pages/MapPage.jsx` is Movement's `MapDashboard` shape, and theme.css's `.mapdash`
block is Movement's CSS with its reasons (the old `.maphero` is struck through in place):

* **The banner**: the picture on a 16:9 floor on the left; beside it the name (+ favourite star),
  the bsp, *Created by · Released · size*, finish/tag chips, health and web-cleanup's *Not playable*,
  four figures (best round on the board with who and how many, your best, beaten by, games) and
  **Play** at the foot with Play Local (Untracked) and the rating. The picture wears a credit
  (*Screenshot from the release post / The map's own loading screen / WaW's loading screen*) and a
  **Cover | Loading screen** switch when it has both. `--map-c` is sampled from the art in the
  browser and graded by the ambience's own colourist, so each page is washed in its map's colour.
* **What's in it**: the Call of Duty facts above, as tiles, labelled *Read from the map's own files*.
* **The split**: About, Records (Movement's board chips + player-count track), Recent games, What
  counts as beating it, Download (the archived original + every link with its checker verdict) and
  Versions on the left two thirds; Live now, Friends who beat it and Comments on the right.
* **Kept from web-cleanup** (merged first, rebased onto): the `‹ Maps` back button, Play as the
  rail's Play, *Not playable* with the reason on hover and Play disabled, *Approval required* as the
  button's label, updates-downloads' Download button beside Play Local, no dead "Download original" link and no "Play needs approval" line. The two long
  empty states are now *No records yet.* and *Round 20, the default.*; a catalogued map's Play reads
  *Not playable* with the reason on hover instead of a sentence under it.
* **The two-up is keyed on the page's own width** (`.mapdash-wrap` is an inline-size container),
  not the viewport as Movement does: this body is drawn on `/m/<map>` beside the rail and in home's
  right-hand region, and a viewport query cannot tell those apart. Measured in the home frame at
  1440: 578px picture + 330px column, figures two across.
* `Recent games` / `Live now` are tables now; they had been wearing `.maprow`, which §11 turned into
  the home page's card row.

### Proof

`docs/kickstart/ui/`: `map-page-stock.png` (Der Riese: WaW loading screen, every feature tile),
`map-page-custom.png` (Leviathan: release-post screenshot, 432 MB, 9 perks = 4 + 5 custom, the
archived original and six links), `map-page-placeholder.png` (a catalogued map, generated card),
`home-cards-art.png`, `maps-cards-art.png`, `maps-list-art.png`. The Cover | Loading screen switch
was clicked in the home frame on Minecraft Village Remastered and showed its own loading screen out
of `fortress.iwd`. `npm test` after the rebase: **121 + 41 + 15 + 19 + 12, 0 failed** (three new
in-process checks: thumb/loadscreen derivation, the features block, the download size).

### Deploy (coordinator)

On B's PC after merging: `node web/server/db/import-archive.js --catalogue` (link sizes; requiring
the database runs `migrate()`, so the new columns exist first), then
`python tools/maps/map_art.py --write-db` (about 6 minutes cold, seconds incremental), then
`npm --prefix web run build`. No restart is needed for the data; the server code (`lib/maps.js`)
needs one.

### Unproven / open

* The page has not been seen signed in with runs on a board (the dev copy has no records), so Best
  round has only shown its empty state.
* The feature scan is what the entities say. City of Hell reports 1 perk machine and ORBiT 12; both
  are real `zombie_vending` counts and neither has been checked in game.
* Nazi Zombie Ali ships no loading screen in its `.iwd` (its `_load.ff` names
  `loadscreen_nazi_zombie_ali`; no file carries it). It has its callofdutyrepo cover.
* Maps with no picture in our crawl cache (callofdutyrepo posts pass C never reached, UGX threads,
  archive.org items) have the generated card; `fetch_art.py` picks more up as the crawl grows.

## 2026-09-22 (evening) — Movement's left rail, and the plain ENW logo

Branch `web-dock`. B: *the map on the left with its image, Movement's server card in the bottom
left; click it to pick a different map and the map changes; the online list, your party, the
Play button, Verified/Custom and Private/Friends/Public toggles just like Movement; invite by ENW
username and from the online list; copy more from Movement and make the flow the same. And get
rid of "Zombies" from the logo: just the ENW logo.*

**§10a's "no rail" is superseded.** The objection then was a third region on the right. This is
Movement's left spine, on every page, above the router. The nav still runs across the whole
window over it, because inside the launcher the nav is the title bar (`html.in-launcher`); the
nav component was not touched.

### What is ported, file by file

| Ours | From Movement | What changed on the way over |
|---|---|---|
| `client/src/components/PartyRail.jsx` | `components/PartyRail.jsx` | Roster, InviteBox, Invites, FriendsBlock → OnlineBlock, the lobby-options pair, Footer → ServerCard. Same class names and layers. |
| `client/src/components/MapPicker.jsx` | `components/GameModePicker.jsx` (the sheet) | Same scrim, sheet, hue wash, head, card grid and "current" pill. It holds **maps** instead of modes, adds a search box, and draws the first 60 matches. |
| `client/src/rail.jsx` | `party.jsx` | Polls `/api/party` (3 s) and `/api/party/online` (10 s). Holds the **stage** (map, mode, visibility) in localStorage until a party exists. Holds the pool once; home reads it from here. |
| `client/src/components/Icons.jsx` | `ServerIcons.jsx` | + `CopyIcon`, `CheckIcon`, `CopyGlyph` for the connect field |
| `client/src/theme.css` rail block | `theme.css` PARTY RAIL, `.rgm-*`, server card, `.copy-glyph` | `--panel2` → `--panel-2`. No `--glow` token here, so the value is written out. The rail starts under the nav. |
| `server/lib/roster.js` | the server half of `FriendsBlock` + `friendSearch` | New. See below. |

`components/PartyPanel.jsx` is **deleted**. Everything it did (members, download state, ready,
Start / Start anyway / Go / Cancel, invite, leave) is now in the roster and the server card.
Home keeps its map-pool column and the map page. Picking from the pool stages that map on the
card.

### What differs from Movement, and why

* **No game + mode bar at the top.** Movement's first card picks the game (CS:GO or CS:Source)
  and the mode (surf, bhop, KZ). Zombies has one game. Its only mode is Verified / Custom, and
  that is a lobby option, so it sits where Movement's Global/Local chat segment sits: directly
  above Private/Friends/Public, over the card.
* **The server card opens the map picker, not the map page.** On Movement, clicking the card
  opens that map's page, and opening another map stages that one. B asked for the card itself to
  change the map. "Open the current map's page" is in the picker's foot. A party member who is
  not the leader gets the map page, because only the leader can change the map.
* **Private / Friends / Public**, in B's words and B's order. Movement's labels for the same
  three values are Friends / Invite-only / Public. The API values are unchanged.
* **Play is the party flow** (`lib/parties.js`, 13 §4b), through the play gate exactly as
  before. Movement's "Spin up" boots a server and then shows you an address to copy. Here:
  * With no party, Play makes one from the stage.
  * A party of one skips the ready check (the leader is ready by pressing Play) and goes
    straight to the launch.
  * A bigger party gets the ready check. Members see **Ready**. The leader sees **Waiting for N**,
    then **Go**, with **Start anyway** and **Cancel** under it.
  * Once launched, the card shows the connect string with a copy mark, as a fallback. The
    launcher is what actually connects you.
* **The map page's Play is the rail's Play** with that page's map staged first, which is what
  Movement's map page "Spin up" is. There is one way to start a game, and the card shows where it
  has got to. `POST /api/maps/:key/play` stays for the launcher; the page no longer calls it.
* **Opening a map stages it** (Movement's flow), but only where that moves nobody else: your own
  stage when you have no party, or the leader picking from home's pool while the party is still
  forming. Reading a map page never resets a lobby.
* **Online rows join a lobby rather than copy a server address.** A Zombies lobby is a party
  that has not launched. A row sitting in one wears the lobby's map art. Its action depends on
  the lobby: **Accept** if you are invited, **Join** if you may join, `IN PARTY` / `INVITED` /
  `IN GAME` tags otherwise, or **+** to invite. Accept and Join go through the play gate, because
  B's own list names accepting an invite as a play action.
* **No collapsed mini rail.** Below 1080px the rail stacks above the page.
* **No toasts.** The site has no toast system. A refusal is a red line under the card, cleared
  after 6 s.

### Server changes

* `lib/parties.js`:
  * **An invite now opens a friends-only lobby** to the person invited. Before, it opened only a
    private one. That meant accepting an invite from somebody you are not friends with (the whole
    point of inviting by ENW name) was refused by the lobby that sent it.
  * `invite(from, to, stage)` validates the target (exists, not you, not already in, not full)
    and dedupes pending invites.
  * **An invite from somebody with no party creates the party**, carrying the rail's stage. This
    replaces Movement's "invited people join when you spin up".
  * `create()` validates mode, visibility and map rather than trusting the body.
  * New: `declineInvite`, `cancelInvite`, `kick`. `project()` carries `invited[]`, drawn as the
    roster's "invited" rows with a × to take the invite back. `invitesFor()` carries the map's
    title and art for the invite card.
* `lib/roster.js`: the online block, worked out on the server **for the reader**, which is
  Movement's rule. An approved account sees everybody online, and the block says **Online**.
  Anybody else sees only their friends, and it says **Friends**. Each row carries `lobby`
  (`joinable`, `invited`, `invite_id`, visibility, map art), `game` (a box-reported match), or
  `held` (already in or invited to your party). `search()` is the invite box: two characters
  minimum, eight rows, friends and online players first.
* Routes (`routes/site.js`):
  * `POST /api/party/invite` now takes `{steam_id}` **or `{username}`** (resolved through
    `users.resolve`, ENW name or persona), plus `stage`.
  * New: `POST /api/party/invites/:id/decline`, `POST /api/party/invites/:id/cancel`,
    `POST /api/party/kick`, `GET /api/party/online` (empty list signed out),
    `GET /api/party/invite-search?q=`.

### The logo

`Lockup` (`components/Bits.jsx`) is the ENW mark alone. The ZOMBIES foot is gone, so the nav,
the signed-out home card and `/download` all draw the plain ENW logo. The favicon was already the
mark. The launcher's own fallback screens (`launcher/src/renderer/shell.html`,
`placeholder.html`) drew `ENW` over `ZOMBIES` in text; the `ZOMBIES` span is removed from both.
That ships with the next launcher build. The product name in `<title>` and in prose is still
ENW Zombies. B asked about the logo, not the name.

### Tests and proof

`npm test` is **142/0**: 95 in-process, 33 over HTTP, 14 sign-in. That is six new in-process
checks:
* an invite with no party makes one, carrying the stage
* staged junk is not written
* an invite opens a friends-only lobby to the invitee and to nobody else
* decline, take-back and kick, each with its permission
* the online block's two scopes, `joinable` / `invited` / `held`, and the invite search

**The proof (`ui/rail-*.png`).** Headless Edge over CDP, 1440×900, against a private instance on
**3450** holding a `VACUUM INTO` copy of the live database. `web/data` and 3200 were not touched.
There were three fake accounts (`76561198000000101..103`: ghoulbait, perkaholic, raygunner), each
signed in through the dev mock with its own cookie jar and a socket held open, which is what
makes them "online". In order:
1. `rail-home`: the rail, the online list with raygunner's public lobby wearing its map.
2. `rail-map-picker`: the card clicked.
3. `rail-map-picked`: Leviathan picked, and the card, pool and page follow.
4. `rail-invite-by-name`: the invite box.
5. `rail-invited`: Custom picked, then "perkaholic" typed and Enter. This made the party and
   the invite.
6. `rail-invitee`: perkaholic's own session, with the Invites card and Accept on ghoulbait's row.
7. `rail-joined-member`: accepted. Party of 2, member view, "ghoulbait starts the game".
8. `rail-ready-check-leader` / `-member`: Play pressed.
9. `rail-go-no-box`: Go refused with "no game box is online".
10. `rail-signed-out`.

Everything that goes into a game ran with the launcher's real header (`X-ENW-Launcher`).
Without it, the same Go press lands on `/download?map=nazi_zombie_leviathan&party=23&then=/`,
which was checked.

### Unproven

* **A real launch from the rail.** No box polled the dev instance, so Go stops at "no game box is
  online", the same place the old panel stopped. The launch call is unchanged from the old panel's.
* **The member's Ready was pressed over HTTP** (curl with the member's cookie) rather than by
  clicking. The member's Ready button is in `rail-ready-check-member.png`.
* **Join on an online row** is covered by the in-process test (`joinable`) and not clicked in a
  browser.
* **Inside the real launcher window**: the rail under a frameless title bar, and the play gate
  standing down through `window.enw`.
* **Phone widths**: only the stacking rule exists; nobody has looked at it.
* **Merge note:** branch `web-identity` removes `/auth/mock`. The rail's signed-out link already
  follows `session.auth`, so it needs no change after that merge.

## 13. 2026-09-22 (evening): Steam sign-in and an ENW username, and nothing else

B: *"Remove all the dev logins and all the fake logins that don't exist any more. To be a user you
have to sign in with Steam and you have to have an ENW username, and everything you set on this
version links to your ENW account. Everyone should have the exact same ENW username … using the
design conventions set by drops.ws and ENW Movement."* Branch `web-identity`.

### 13a. What went

| Gone | Where it was | What replaced it |
|---|---|---|
| The mock provider: `GET/POST /auth/mock`, the page listing every account, "type any SteamID" | `routes/auth.js` | nothing. `/auth/mock` is a 404 on every box |
| `ZM_AUTH` (whose default was **`mock`**), `ZM_ALLOW_MOCK`, `mockAllowed()`, "first account on an empty site is the admin" | `routes/auth.js` | Steam OpenID always. With `ZM_PUBLIC_URL` unset the return origin is the process's own `http://127.0.0.1:<port>`, so a dev box signs in with real Steam too |
| "Sign in (dev)" buttons, `SIGN_IN = '/auth/mock'` | `client/src/api.js`, `UserMenu.jsx`, `Home.jsx`, the `index.js` placeholder page | `/auth/steam` |
| The launcher's fallback "sign-in" as whatever Steam account this PC is logged into, named after its persona, with no site involved | `launcher/src/main/main.js` `signIn` | an error saying the site cannot do the round trip. The loopback round trip (launcher.md) is unchanged |
| `users.pub().name` falling back to `users.username` (the Steam persona); `resolve()` matching personas; the same fallback in `badges.js`, `feed.js`, `localMatches.js` | `lib/users.js` et al. | `name = enw_name`, else the bare SteamID (a row nobody has named: a verified player who never opened the site). `username` is off the public projection |

**The test-only hook.** `npm test` spawns real servers and signs in as several players over HTTP.
`ZM_TEST_LOGIN=1` registers **`POST /auth/test-login`** `{steam_id}` (form or JSON), which does what a
verified Steam return does (`users.ensure`, the session, finish an open launcher flow) and nothing
else: no name, no approval, no admin, no GET, no page. Three locks: the server **refuses to start**
with `ZM_TEST_LOGIN=1` and `NODE_ENV=production` (tested); the route does not exist without the var
(tested: 404 on a Steam-only instance, both verbs); loopback callers only. `infra/site.env` and
`keepalive.ps1` must never carry it. `launcher/test/slice.js` and `web/tools/local-run.js` use it,
so they need a site started with it.

### 13b. The ENW username: the rules are the authority's, verbatim

| Rule | Source (cited in `lib/names.js`) | Zombies |
|---|---|---|
| 3–20 chars, `[A-Za-z0-9_-]`, trimmed first | drops.ws `csgo-server/src/utils/usernameRules.js:9-20`; Movement `CSGO-Matchmaker/server/lib/dropsNames.js:60-68` | same |
| No leading `YYYY-MM-DD` ("Invalid username") | `usernameRules.js:22`; `dropsNames.js:69` | **was missing**, added |
| Not all digits ("Usernames cannot be only numbers") | `usernameRules.js:29`; `dropsNames.js:70` | same |
| Wording of every refusal | the strings above, and drops.ws `src/routes/auth.js:134-141` for taken/blocked | **was our own** ("Your username must be…", "That username is reserved"); now theirs character for character. The picker's verdict lines are Movement's client's (`movement-client/src/pages/UsernameSetup.jsx:30-42`) |
| Static blocklist: 754 terms, exact/contains, leet folding, allowlist | drops.ws `src/utils/usernameBlocklist.js` + `src/data/reserved-usernames.csv`, `username-allowlist.txt` (4a0fa29) | **copied** to `web/server/lib/usernames/` (a port of the matcher, the two data files byte for byte). Replaces our 11-word reserved list, which only added `server` and `unknownsoldier` to what drops.ws already refuses; dropped, so no name legal on drops.ws is refused here |
| Unique, case-insensitive | drops.ws NOCASE index on `players.site_username` | `idx_users_enw_name` NOCASE on `enw_name`. **No longer also against `username`** (a persona is nobody's name now) |
| Set once; renames elsewhere | Movement `server/routes/auth.js:198-229` (409 "You already have a username"); drops.ws renames behind VIP + 14-day cooldown + revert window (`src/routes/auth.js:164`, `src/db/database.js:1095`) | set once; an admin rename (`POST /api/admin/player/:who/username`), which now also passes the blocklist. **No cooldown here** because there is no self-serve rename to cool down, the same as Movement |
| Reservations (revert windows), staff name locks | drops.ws `username_reservations`, `players.username_locked` | **not mirrorable** without drops.ws's data: a name held for somebody's revert window reads as free here. Q-id-1 |

`names.check()` answers in drops.ws's reason vocabulary (`ok | invalid | blocked | taken`), in
drops.ws's order (shape, blocklist, holder). Note: "Dexter" is on drops.ws's list (a CS pro's
handle), so the demo seed's Dexter could not pick it; the seven real names are all clear.

### 13c. The gate

* **Client** (`App.jsx` `NameGate`): signed in with `needs_name` → `pages/UsernameSetup.jsx` (a port
  of Movement's) replaces the routes, **ahead of the approval wall**, exactly Movement's order. The
  nav stays because in the launcher it is the title bar; the chat dock is hidden.
* **Server** (`middleware/auth.js`): every guard that means "a user" (`requireUser`,
  `requireApproved`, `requireMod/Admin/Archivist`) now means a *named* user and answers
  `403 {error:'Choose your ENW username first', needs_name:true}`. `requireSignedIn` is the one
  exception, for `/api/me/username`, `/api/me/username/check`, `/api/me/username/suggest` and
  `/api/me/delete`. The socket's `chat` refuses a nameless sender. So everything a user sets
  (settings, party, the lease and its invite token `n`, comments, results) hangs off a SteamID row
  that has an ENW name.
* **Approvals are untouched**: the seven-account allowlist is still the beta gate on top
  (`requireApproved`), checked after the name.
* **Launcher**: `/auth/launcher/exchange` and `/api/launcher/hello` carry `needs_name`; the launcher
  stores no name while it is true (it used to store `you.name`, which for a nameless row would have
  been the SteamID) and re-reads `hello` before every launch (`sessionWithFreshName()`), so
  `+set name` is the ENW username the moment one exists.

### 13d. Compatibility with Movement: the public read, and what it cannot do

Movement **does** expose a public read by SteamID: `GET https://movement.enw.gg/api/players/<id>/profile`
(`server/routes/players.js:93`, on the movement host's `MOVEMENT_PUBLIC` list, `server/index.js:464-480`).
No session, no credentials. `lib/movementName.js` reads it (4 s timeout, 1 h cache; `ZM_MOVEMENT_URL=off`
disables it and the tests do) and the picker **offers** it: "On ENW Movement you are **x**", pre-filled
if it passes our check. **Offered, not adopted**: `user.username` there is `publicUser()`, which is
the drops.ws name when the account has one and the Steam persona when it does not, and
`name_source` is not on the public projection. Verifying needs drops.ws `GET /internal/name`, behind
the shared secret: [`questions.md`](questions.md) **Q-id-1**.

Checked read-only for the seven approved accounts (7 public GETs, 2026-09-22): six identical,
**one differs in case only**: Zombies `jamie`, Movement `Jamie`. drops.ws treats a re-capitalisation
as a real change, so this is not the exact same name. `web/tools/align-enw-names.js` reports this
and, with `--apply`, adopts Movement's casing for case-only differences (different names are only
reported). **Not run against `web/data`** (rule 7): B's or the coordinator's call.

### 13e. Existing users

All seven live rows already have `enw_name` (`seed-enw-names.js`, earlier today), confirmed on a
`VACUUM INTO` copy: `myu`, `zeroh`, `jamie`, `stew`, `jacob`, `air`, `toku`. **Nobody on the live site
sees the picker**, B included, so no migration is needed. `myu` matches Movement exactly.

### 13f. Proof, tests

Private instance on **3431**, a `VACUUM INTO` copy of the live DB in the agent scratchpad,
`ZM_TEST_LOGIN=1`, and a local stub on 3432 standing in for movement.enw.gg's profile read (two
invented SteamIDs; `web/data` and 3200 untouched). Headless Edge over CDP:

| Screenshot (`ui/`) | What |
|---|---|
| `name-gate-fresh.png` | invented SteamID `76561198999000123` → `/maps` shows only the picker; `/api/me` `needs_name: true`, `name` = the SteamID |
| `name-gate-short.png`, `-blocked.png`, `-taken.png`, `-digits.png` | Movement's verdicts: "At least 3 characters." / "Not available." (`admin`) / "Taken." (`jamie`) / "Names cannot be only numbers."; the server said `Usernames cannot be only numbers` |
| `name-gate-available.png`, `name-gate-done.png`, `name-gate-api-me.json` | `fresh-player` → Available → Continue → the site, nav shows `fresh-player`; `/api/me` `{needs_name:false, name:"fresh-player", enw_name:"fresh-player"}` |
| `name-gate-movement-suggest.png` | a SteamID the stub knows: "On ENW Movement you are fresh-soldier.", pre-filled, Available |

`npm test`: **146/0**: run-all 94 (was 89: Movement's wording table, the blocklist mirror, the
display name never being the persona, the gate on every guard), local-run 37 (was 33: the fresh
account forced to the picker, refused settings/lease/GET settings with `needs_name`, the server's
five refusal sentences + blocked + case-insensitive taken, success reaching `/api/me` and
`/api/launcher/hello`), sign-in 15 (was 14: the test hook absent on a Steam-only site, no mock
anywhere, refuses to boot in production). Launcher `npm test` 124/1; the one failure is "this
checkout must have a client DLL to ship", a build artefact a fresh worktree does not have.

### 13g. Unproven / open

* **A real Steam sign-in landing on the picker.** Agents cannot sign in to Steam. The Steam return
  path is unchanged except that it no longer has a mock beside it; the first new friend to sign in
  is the proof.
* **The launcher changes** (no fallback, `sessionWithFreshName`) are syntax-checked and the launcher
  suite passes, but no Electron run drove them.
* **Q-id-1**: reservations and locks on drops.ws are invisible here; a name chosen here is not
  claimed on drops.ws; Movement's public name cannot be told from a persona.
* **Needs a client build + restart to go live** (`npm run build`, the keepalive path). Not done here.
* `jamie` → `Jamie` (13d) awaits a decision.

## 2026-09-22, evening — `/settings`: World at War's Options menus, per SteamID, applied at launch

B: *"Have the settings page allow you to make it look like the game's World at War settings menu,
with all the exact same settings, and make sure they all map properly and work properly."*

### What is there

* **`/settings`** (`client/src/pages/Settings.jsx`). The account menu's **Settings** item goes here
  now, in a browser and in the launcher (it used to go to `/id/<you>#settings`; the profile keeps
  chat, privacy, zombie counter and pinned badges, and its FOV / Max FPS fields became a link here).
  Laid out like the game: a column of menu names (*Options*: Graphics, Texture Settings, Sound,
  Game Options; *Controls*: Look, Move, Combat, Interact; plus **ENW**), the selected menu's rows,
  labels right-aligned in the game's uppercase, the game's `‹ value ›` list items, sliders, and key
  rows with Key / Alternate that capture the next key, mouse button or wheel notch (Escape cancels,
  Backspace clears — the game's two keys). Each row shows the dvar it writes; hover gives the source.
  Rows the launcher's baseline already sets show an **ENW** tag until the player chooses.
  Per-section **Reset to game defaults** (Controls: *Set default controls*; ENW: *Reset to ENW
  defaults*).
* **The catalogue** (`client/src/data/wawSettings.js`): every item out of the stock menus compiled
  into the game's `ui.ff`, in the menu's own order, with the dvar, the values the menu's own table
  writes, the game default and a source line. `client.md` §8 is the full dvar table and how it was
  read; unmapped items are listed on the ENW tab and in §8c, not faked.
* **Storage**: one `game` object in `users.settings_json` (`PUT /api/me/settings { game }`), shape
  `{ mode, display, resolution, vsync, fov, maxFps, showFps, sensitivity, rawMouse, waw: {dvar: value
  | null}, wawBinds: {command: [key, key]}, updatedAt }`. `lib/users.sanitizeGame` keeps it the right
  shape and size (the launcher is the strict gate: `launcher/src/main/wawcfg.js` refuses any dvar or
  value the menus do not offer). `fov` / `max_fps` at the top level follow it so nothing else on the
  site becomes a second opinion.
* **The launcher half** (all through the existing bridge — `enw.getSettings` / `enw.setSettings`,
  no new IPC): the page pushes `toLauncherPatch(game)` on every save; `components/launcherBridge.js`
  `GameSettingsSync` (mounted once in `App.jsx`) compares `updatedAt` against the launcher's
  `gameUpdatedAt` on every signed-in load and whenever the launcher says its settings changed, and
  the newer copy wins — the launcher's after a game where the player changed something in the
  game's own menus (post-exit read-back), the site's after an edit in a browser.

### How a value reaches the game (launcher files, listed for the merge)

`launcher/src/main/wawcfg.js` (new): the whitelist; `launchDvars()` lays the account's values over
the baseline **in place** (a player's `r_texFilterAnisoMin 8` replaces the bundled `16`, it does not
appear twice); `applyAccountToConfig()` merges them into the `config.cfg` the engine reads on **every**
launch (dvars case-insensitively, `reset <dvar>` for a game-default row, binds with the old key
released as the menu does, `con_hidechannel` kept last) and snapshots what it wrote;
`readBackAccount()` after exit returns exactly what differs from that snapshot. `settings.js`: new
keys `waw`, `wawBinds`, `gameUpdatedAt`, `rawMouse`, validated, merged key by key. `launch.js`:
`settingsArgs` uses `launchDvars` when anything is saved (byte-identical baseline otherwise — tested),
the merge runs after the seed, `ENW_RAW_MOUSE=0` when raw mouse is off, the read-back is folded in.
`package.json`: `npm test` also runs `test/waw-settings.js`.

Why every launch and not seed-once: `config.cfg` is exec'd during `Com_Init` and the menu reads what
it sets (launcher.md 0.2.3 §1 measured a config beating the command line), so a site change has to
reach that file. It does not undo in-game changes, because the read-back turns each one into the
saved value before the next launch writes it. The bundled community fixes stay seed-once.

### Proof

* `web npm test`: **93 / 33 / 14, 0 failed** (three new: stored per SteamID and returned in the
  launcher's shape; the blob refuses junk including a `;quit` in a bind; every item has a source,
  a section and a reset, and every dvar is in the launcher's whitelist).
* `launcher npm test`: **125 passed** (`run-all.js`, unchanged) **+ 14 passed** (`waw-settings.js`):
  values saved in the site's shape reach the `+set` list; a saved value replaces the bundled fix in
  place; game default → off the line and `reset` in config; launcher keys (vsync, sensitivity, FOV,
  Max FPS, Show FPS, windowed 1920x1080); Invert Mouse writes `ui_mousePitch` **and** `m_pitch`;
  refusals; the timestamps; the per-launch merge into an engine-shaped config (unrelated lines
  survive, old key released, ADS stays hold); the read-back claims exactly what changed.
* **Dev port** (`:3437`, its own `ZM_DATA_DIR`, mock sign-in as a demo id): in the real page, Number
  of Corpses → Large, Texture Mipmaps → Trilinear, Forward alternate → `I`, FOV → 95; `GET
  /api/me/settings` returned `{"waw":{"ai_corpseCount":"20","r_texFilterMipMode":"Force Trilinear"},
  "wawBinds":{"+forward":["W","I"]},"fov":95,…}`. That stored blob, through the launcher's real
  `settings.set/get` and `settingsArgs`, gave `+set cg_fov 95 … +set ai_corpseCount 20 +set
  r_texFilterMipMode Force Trilinear`, and merged into a **copy** of a real engine-written config
  (`ZombiesDev\homes\d2`): `seta ai_corpseCount "20"`, `seta r_texFilterMipMode "Force Trilinear"`,
  `seta cg_fov "95"`, `bind W "+forward"`, `bind I "+forward"`.
* **Bridge** — a scratch Electron harness, *not* the launcher app: the launcher's real `preload.cjs`
  on the dev site, the four IPC handlers the page uses wired to the real `settings.js` in a temp
  `ENW_ROOT` with main.js's `{ ok, data }` wrapper. On load the page pushed the site's copy into the
  launcher (`waw`, `wawBinds`, `fov 95`, `gameUpdatedAt` equal to the site's); clicking *Line of
  Sight Occlusion* → No made the page say *Saved · the launcher applies it at your next launch*, the
  launcher held `snd_losOcclusion "0"`, and the next launch line had `+set snd_losOcclusion 0`.
* Screenshots: `docs/kickstart/ui/settings-{graphics,texture,sound,game,look,combat,enw,mobile}.png`
  and `settings-in-launcher-harness.png` (window buttons in the nav = `html.in-launcher`).

### Unproven, named

* **Every row in the running game.** Nobody launched WaW for this (B was playing). `client.md` §8d
  is the one-minute check. Specifically unproven: that `reset <dvar>` in `config.cfg` does what the
  engine's own `dvar_defaults.cfg` implies; that a two-word value on the command line
  (`Force Trilinear`, `wide 16:9`) survives the engine's own argv tokenising — `config.cfg` carries
  it quoted either way.
* The packaged launcher: this rides with the next launcher release (the files above), and needs the
  site deployed. Until both, the page saves to the account and a launch does not see it.
* Mature *Reduced*: `cg_mature 0` only (client.md §8c).

## 2026-09-22, evening — `/api/game-chat`: what the in-game chat overlay speaks (client lane, for the web agents)

Added by the client lane for the in-game overlay (`chat-overlay.md` §9.4). **Not deployed.** Small
and additive; nothing that existed changed behaviour.

* **`lib/gameChat.js`** — the *chat pass* (HMAC `gc1.<payload>.<sig>` over `{steamid, expiry}`,
  key derived from the session secret via `setSecret(secret)` in `index.js`, 12 h, refused for a
  site-banned or deleted account), the **private ring** (`chat_private`: party lines and DMs,
  created with `CREATE TABLE IF NOT EXISTS` in the module — a separate table from `chat_network`
  on purpose, so no box drain, no `io.emit('chat')` and no public `GET /api/chat` can ever see a
  DM), and the long-poll over both rings. Party lines go to the party's current members; DMs only
  to friends or party members; 5 lines / 10 s per player.
* **`routes/gamechat.js`**, mounted at `/api/game-chat` next to `/api/gs`, **Bearer pass only**
  (a session cookie is not accepted): `GET /me`, `GET /feed?g=&p=&wait=`, `POST /send`.
  Gate-exempt in `middleware/gate.js` (the game cannot type the password); every route 401s
  without a pass.
* **`POST /api/launcher/chat-token`** (session, `requireUser`) — the launcher mints the pass here at
  every game launch. It stays behind the gate.
* **`DEFAULT_SETTINGS.pause_on_chat: true`** in `lib/users.js` — B's "pause when using global chat".
  `PUT /api/me/settings {pause_on_chat}` already works; **the /settings page has no toggle for it
  yet** — a web-lane job (the ENW tab is the natural home).
* **`chat-private`** is emitted to each recipient's own `user:<sid>` room, for when the site's dock
  grows Party / DM tabs; nothing on the client listens yet.
* Global lines from the game land in `chat_network` with `origin: 'game'` — the dock shows them and
  every box drains them, like a web line.
* Tests: `web/test/game-chat.js`, 19/0, added to `npm run check`; `run-all` 102/0, `local-run` 37/0,
  `launcher-signin` 15/0 unchanged. Proven end to end against a private instance on 3399 with the
  real game (`chat-overlay.md` §9.6).

## 2026-09-22, late evening — the profile is Movement's: banner, maps, Overall, the comment wall

B: *"Copy exactly the profile from ENW Movement, with the comments and the banner and everything.
Copy people's ENW profile stuff over already — if they have a banner on Movement it should show
here the same … No featured skins (this is not CS:GO). A separate comment section. Recent maps and
top maps at the top like Movement … with the map images and the time spent. And another section
with overall stats."* Branch `web-profile`.

### What is on the page, in Movement's order

`client/src/pages/Profile.jsx` is rewritten from `CSGO-Matchmaker/movement-client/src/pages/Profile.jsx`,
piece for piece and under Movement's names:

| Piece | From Movement | Zombies |
|---|---|---|
| Banner (`.prof-cover`) with the veil PNGs, Copy link, friend button | `ProfileBanner`, `FriendButton` | the banner is **the player's Movement banner, copied here** (below); with none, the auto-banner is their most-played map, named on the art (Movement, 2026-08-28) |
| Identity bar: avatar punching through the seam, presence dot, name → Steam, country code, VIP tag | `IdentityBar`, `PresenceDot` | + Admin / Mod / Archivist tags; tagline "Most played: <map>"; strip = Games, Best round, Records held (only when > 0, gold, as Movement's WRs), Time played |
| Worn badges in the bar, the shelf in the rail, hover card, click-to-pin on your own | `components/BadgeShelf.jsx` (copied) | a badge with no uploaded art draws our Hex; pins go to `PUT /api/me/pinned` |
| Sticky rail with the facts | `ProfileRail` | Date registered, Level, Total time played |
| **Top maps / Recent maps** side by side, map-art rows | `PlayedMaps` (Most played / Recently played), `.pm-*` | each row: art, title, time spent (right), games and best round (and "5h ago" on Recent) |
| **Overall** | — (B's section) | Games played, Rounds played, Best round (→ `/game/<id>`, and `/replay/<id>` when there is one), Time played, Records held, Member since; Kills / Downs / Revives **only once recorded** (below) |
| Records held | `RecordsBox` (the idea; the PB browser is not ported) | the records they hold, as map-art rows, the round in gold |
| **Comment wall**, its own section at the foot | `components/ProfileComments.jsx` + `comments.js` (copied) | the same API shape (below); live by the 60 s poll, as there is no per-profile socket room here |
| Your own privacy settings | (Movement keeps these in Settings) | kept at the foot of your own profile: history public/hidden, who can comment |

CSS: `client/src/profile.css`, lifted from Movement's `theme.css` verbatim with the source line
ranges in its header, plus a short ZOMBIES block. **Left out:** the drops.ws skins (B), the rank
rail and its five-board mode selector, the KZ band, the PB browser and tier bars, the HUD card, the
UID fact, the banner upload and crop dialog (why: next section).

### The banner: Movement's, copied, one place to change it

Movement **does** expose a public profile read by SteamID — `GET https://movement.enw.gg/api/players/<id>/profile`,
no session (§13d) — and its `user` carries `banner` (`/banners/<steamid>-<12 hex>.<ext>`, a static
mount on that host), `banner_pos` and `country`. So nothing touches Movement's database or box.

`server/lib/movementProfile.js`:

* reads that route, and **downloads the banner file** into `<data>/media/banners/<steamid>-<hash>.<ext>`
  (served at `/media/banners/`, beside the DB — runtime data, not `public/`). The type is decided by
  magic bytes (Movement's own four), 2 MB cap, and only a path of Movement's generated shape is ever
  requested. Movement's banner names are content-addressed, so an unchanged banner is never fetched
  twice and a changed one replaces the old file.
* keeps **only** `steam_id`, the Movement username (never displayed), the banner file, `banner_pos`
  and the two-letter country, in a new table `movement_profiles`. No avatar, no badges, no skins, no
  last-seen. Movement's public read carries no email, real name or Discord handle, and has no bio
  field — so there is no bio to copy.
* runs at Steam sign-in (after the redirect, like the ENW name lookups) and, in the background, on a
  profile view whose copy is older than 6 h. `ZM_MOVEMENT_URL=off` turns it off; the tests do.

**There is no banner upload here, deliberately.** A banner set on Movement shows on Movement,
drops.ws and now here; a second upload on this site would be a banner that disagrees with the other
two. On your own profile the banner's top-right says *Change banner on Movement* and links there.

**The seven approved accounts** — `web/tools/import-movement-profiles.js` (the same `refresh()` sign-in
runs, for the fixed list; `--dry` reads and writes nothing). Run against a `VACUUM INTO` copy of the
live DB: **7 on Movement, 6 with a banner** (myu, zeroh, stew, jacob, air, toku; jamie has none),
country GB for two. **Not run against `web/data`** (rule 7). The command for the live site:

```
cd web && node tools/import-movement-profiles.js
```

(it opens whatever the server opens; the site does not need a restart for it, and a sign-in does
the same thing per account anyway).

### The numbers, and what is not printed

`server/lib/profile.js`, read from `games` + `game_players`, **seeded demo games left out**:

* **Time on a map** = the game's `duration_ms` credited to each player in it; a game with none falls
  back to `ended_at - started_at`. Top maps: by time, then games. Recent: by the last game's end.
* **Best round** follows the career strip's rule: Verified, not self-reported, not joined late. The
  per-map row's best round counts every mode (it is their history).
* **Rounds played** is `SUM(game_players.rounds_played)` — every round the game ran while they were in
  it. B's list said *rounds survived*; the referee does not count survival, so the label says what
  the number is.
* **Kills, downs, revives are omitted.** The columns exist, but every real game on the live site holds
  0 for all three — including a round-2 game with 0 points: the real game does not yet emit the
  `points why:kill` event `referee.js ev_points` counts from (only the sim does). A stat is shown once
  any real game on the site has a non-zero value for it; until then a printed zero would be the site
  inventing a fact.

### API

`GET /api/players/:who` gains `movement`, `maps` (null when history is private) and `overall`;
records carry `art`. Movement's comment API shape: `GET /api/players/:who/comments` →
`{ comments:[{id, steam_id, username, avatar, body, created_at, mine, can_remove}], post_block }`
(public), `POST` → `{ ok, id, comment }` (403 for friends-only / closed), `DELETE …/comments/:id`
(own, or staff; soft, like every removal). Stored in the one `comments` table as `kind='profile',
subject=<steamid>` — the existing profile-comment rows and the reports queue stay as they are.

### Proof

Private site on **3447**, a `VACUUM INTO` copy of the live DB in the agent scratchpad, `ZM_TEST_LOGIN=1`.
Headless Edge. The seven real banners were imported from the real Movement read; an **invented**
account (`ghoulhunter`, `76561198000000123`, ten dev games on maps that have art) went through the
same import path against a local stand-in for Movement's read on 3448, and a second invented
account (`deadshot-dev`) posted on its wall through the page's own composer.

| Screenshot (`ui/`) | What |
|---|---|
| `profile-banner-maps-overall-comment.png` | full page: banner, identity bar, Top/Recent maps with art and time, Overall, the posted comment |
| `profile-own-1440.jpg` | the same profile seen by its owner: *Change banner on Movement*, presence dot |
| `profile-myu-movement-banner.png` | myu's real profile on the DB copy: **the banner from Movement**, GB, Admin/Archivist, a record held, a best round linked to its game and replay |

`npm test` **163/0**: run-all 107 (+5: Top/Recent ordering and the duration fallback with demo games
excluded; Overall and the Verified-only best round; kills omitted until recorded; Movement off;
the banner file copied, magic-checked, not re-fetched, an odd path refused, only whitelisted
fields kept), local-run 41 (+4: the profile's new blocks; post, a visitor's view, someone else's
delete refused, the author's delete), sign-in 15.

### Unproven / open

* **Deploy**: needs `npm run build` and a restart (keepalive path), then the import command above.
* **A real Steam sign-in** triggering the refresh (agents cannot sign in to Steam); the path is the
  same `refresh()` the import ran.
* Avatars are whatever `users.avatar` holds (the `web-cleanup` lane); until that lands everyone is
  Movement's lettered default.
* Movement's pinned badges are Movement's and are not copied; the shelf is zombies badges.
* Kills/downs/revives appear by themselves once the game reports kills; nobody has checked the game
  side for that event.
* The banner copy is refreshed at most every 6 h on view, so a banner changed on Movement shows here
  after the next sign-in or within 6 h.


## 2026-09-22, late: the rail cleaned up, Not playable, Steam pictures, and fewer words

Branch `web-cleanup`. B, after seeing the rail live:
1. *Clicking the map on the bottom left should take you to the map page, with a back button to
   the map list. Remove the redundant rubbish.*
2. *Mark maps that aren't playable, and get rid of that error message if it says that for no
   reason.*
3. *Remove "Start anyway" when someone hasn't got the map. You can just kick each player.*
4. *Make people's Steam profile pictures appear.*
5. *No over-explaining anywhere.*

### 1. The card opens the map page, Movement's flow exactly

* **The server card opens `/m/<key>`.** This is Movement's `openMap`. The card does nothing when
  you are already on that page (Movement's `mapAlreadyOpen`). An empty card opens `/maps`.
* **Back.** `components/BackButton.jsx` is Movement's `ModeBack`: the same `.hub-back` control
  in the page's top-left corner, reading "Maps". It returns to the list you came from, either
  `/maps` with its filters or home. Otherwise it goes to `/maps`. The card, the cards and the
  list rows all pass `state.back`.
* **Home** opens on its rows. It no longer mirrors the card's map. Picking from home's list opens
  the map in place, and a Back returns to the rows. Picking still stages the map on the card,
  as before.

**Removed**, because Movement's flow does not have them:
* `components/MapPicker.jsx` (the sheet), and all of its CSS: `.rgm-*` and `.mpk-*`.
* The "current" pill.
* The picker's foot, "Open the current map's page".
* The card's "Change map" chip (`.prail-live-change`).
* The "Pick a map" button on an empty card.
* The connect-address field with its copy and tick icons (`.prail-live-connect`,
  `.prail-live-address`, `.copy-glyph`, and `CopyIcon` / `CheckIcon` / `CopyGlyph` in
  `Icons.jsx`). The launcher connects you, so the card shows a spinner until you are in.
* Both **Start anyway** buttons.
* `force` from the rail's `play` and `go`. The server keeps its `force` parameter for the
  launcher and the tests.

**Kept**. Every one of these is Movement's or one B named:
* the roster
* invite by ENW name
* Invites
* the Online block
* Verified/Custom and Private/Friends/Public
* the card, with its × (leave)
* Play / Ready / Go
* **Cancel** in a ready check. Movement has no ready check. The ready check is B's party flow,
  and Cancel is the only way out of one.

**Every red line under the card is now the answer to a click.** The line, `R.err`, was only ever
set from a button. But it lived for 6 s above the router, so a refusal from the map page sat under
the next page's card as if that page had caused it. It is now cleared on every navigation. Two
refusals B was most likely seeing no longer happen:
* A map no box runs never sends Play (see 2), so "that map does not run on our servers yet" is gone.
* A party of one whose launch is refused ("no game box is online") goes back to Play. Before, it
  was left sitting in a ready check.

### 2. Not playable

`maps.on_server` already existed (`lib/maps.js`, `SERVER_PROVEN`, the measured five-gate list).
It was the flag, but nothing on the site showed it. So there is no new column. New:
* `lib/serverNotes.js` gives the reason, in a few words, for every map that is not on the list:
  * Der Berg, Octagonal Ascension and Alcatraz: "Hits a game engine limit on our servers"
    (dedi.md §13.2 and §16.4).
  * ORBiT and UGX Requiem: "Too big for the game's memory limit".
  * `custom-only` maps: "Play Local only".
  * Everything else: "Not tested on our servers yet".
* `maps.project()` carries `server_note`, and the party's `map` carries `on_server` and
  `server_note`.
* `NotPlayable` (`components/Bits.jsx`) is a small red tag with the reason on hover. It is on
  map cards, `/maps` list rows, home's list rows, the map page's action row and the server card.
* On the card, and on the map page, Play reads **Not playable** and is disabled, with the reason
  on hover. `rail.play()` refuses such a map without a request.
* The `/maps` filter chip "Our servers" is now **Playable**, the same word.

With today's database, **5 of 25 listed maps are playable**: the stock four and Minecraft
Village Remastered. The tag is on the other twenty, which is true.

### 3. No Start anyway; the leader kicks

A member's row shows where their copy of the map has got to: `downloading 42%`,
`download failed` or `has the map`. The leader sees a × on every other member's row, and the ×
is `POST /api/party/kick`. The card says **Waiting for downloads** until nobody is downloading.
The proof clicked the × and the member was gone.

### 4. Steam pictures, with no API key

`lib/steamAvatar.js` reads `https://steamcommunity.com/profiles/<id>?xml=1`. It takes
`<avatarFull>` (or `<avatarMedium>`), accepts only an https URL on Steam's own image hosts, and
caches it on `users.avatar`. A new column, `users.avatar_checked`, records when.
* It runs at Steam sign-in (forced) and then at most once a day, when the player's own `/api/me`
  finds it stale. It never runs per page render and never for anybody else.
* A failed read keeps the last picture and tries again in an hour.
* `ZM_STEAM_AVATARS=off` switches it off, and all three suites set that.
* Everywhere a player is drawn already read `user.avatar`, so the pictures appear in: the rail
  roster, the Online rows, invites, the invite search, the user menu, comments and the profile
  header. `Bits.Avatar` and the user menu fall back to the initial if the URL fails, as
  Movement's `Avatar` does.
* The records table uses Movement's rule (`initials={false}`): the picture or nothing.
* The map page's boards are left as they were (see the MapPage note below).

Live check: `lib/steamAvatar.parse` on the project account's real profile XML returned
`https://avatars.fastly.steamstatic.com/14d5…_full.jpg`. On the dev instance, the first
`/api/me` after sign-in stored it, and it is in `cleanup-rail-avatars.png` and
`cleanup-menu-avatar.png`.

### 5. Wording

Movement's own strings, such as "Sign in to build a party." and "Nobody else is online.", are
kept because they are Movement's. Code comments are untouched, except where a comment described
a control that was deleted. Data is not client strings, so these are left alone and listed for
B: collection blurbs ("The most recently added to the archive."), badge and preset blurbs, and a
map's readme (Der Riese's shows "Scanner verdict: …").

| File | Before | After |
|---|---|---|
| `PartyRail.jsx` | Change map (chip on the card) | (removed with the picker) |
| `PartyRail.jsx` | Pick a map (button on an empty card) | (removed; the empty card opens /maps and says Pick a map) |
| `PartyRail.jsx` | No map picked | Pick a map |
| `PartyRail.jsx` | Start anyway (twice: downloads pending, and not everyone ready) | (removed; kick with ×) |
| `PartyRail.jsx` | Waiting for the map | Waiting for downloads |
| `PartyRail.jsx` | {leader} starts the game / Ready · waiting for {leader} | Waiting for {leader} |
| `PartyRail.jsx` | Ready check · N of M ready | N of M ready |
| `PartyRail.jsx` | Reserving a server / Reserving a server… | Starting / Starting… |
| `PartyRail.jsx` | (connect address field with copy/tick icons) | (removed; the launcher connects) |
| `PartyRail.jsx` | map install failed / downloading the map | download failed / downloading |
| `PartyRail.jsx` | hover: Remove from the party / Take the invite back | hover: Kick / Cancel invite |
| `PartyRail.jsx` | hover: Stock settings, records and XP count / Your own settings, nothing counts / Only the leader can change this | hover: Records and XP count / Nothing counts / Leader only |
| `PartyRail.jsx` | Leave the party (hover) | Leave party |
| `PartyRail.jsx` | Type an ENW name. Enter invites it as typed. | Type an ENW name |
| `MapPicker.jsx` | Pick a map / Search N maps / current / Open the current map's page / … | (file deleted) |
| `MapPage.jsx` | Play needs approval. Browsing does not. | (removed; the button says Approval required) |
| `MapPage.jsx` | Download original (link that only printed "Downloads are not available yet.") | (removed) |
| `Home.jsx` | Every World at War custom zombies map, archived and playable. Refereed on our servers. | World at War custom zombies. |
| `Home.jsx` | {n} maps. Browsing needs no account. Get the launcher to play. | {n} maps · Get the launcher |
| `Home.jsx` | {n} of them, and the archive holds the rest. | (removed) |
| `Download.jsx` | Windows. You need World at War already installed. Games run in the launcher — a browser tab cannot start the game. | Windows · needs World at War |
| `Download.jsx` | Open in the ENW Zombies launcher | Open in launcher |
| `Download.jsx` | Nothing opened — you probably do not have it yet. Install it below. / Handing over to the launcher… / If it is installed, this brings it forward on this map. | Nothing opened? Install it below. / Opening… / (removed) |
| `Download.jsx` | No build is published right now. Check the feed, or ask B. | No build yet. Check the feed |
| `Download.jsx` | Looking for the latest build… | Loading… |
| `Download.jsx` | Run the installer. Windows SmartScreen will warn you — it is unsigned. More info, then Run anyway. | Run the installer. SmartScreen: More info, then Run anyway. |
| `Download.jsx` | Sign in with Steam. The launcher opens your browser, Steam sends you back, and you are signed in on the site too. | Sign in with Steam. |
| `Download.jsx` | It finds World at War and installs the ENW client. Your Steam copy is never written to — the launcher makes its own copy and patches that. Then pick a map and press Play; it downloads the map and launches the game for you. | Pick a map and press Play. Your Steam install is never changed. |
| `Download.jsx` | This is a closed beta. Things will break, and your account has to be approved before you can play — browsing does not need it. | Closed beta. Playing needs approval. |
| `Maps.jsx` | Our servers (hover: Maps our servers will host and referee) | Playable |
| `Maps.jsx` | hover: Maps with a record or a saved replay | (removed) |
| `Maps.jsx` | hover: Also show maps that are broken on our servers | (removed) |
| `Maps.jsx` | No map matches these filters. | No maps match. |
| `Settings.jsx` | Saved to your account / Saved · the launcher applies it at your next launch / Saved to your account (the launcher did not take it: restart it) / Saved to your account · applied the next time you launch from the ENW launcher | Saved / Saved · restart the launcher |
| `Settings.jsx` | Sign in to keep your World at War settings on your account. They follow you to any PC you launch from. | Sign in to save your settings. |
| `Settings.jsx` | (the stock .menu file name beside each menu title) | (removed) |
| `Settings.jsx` | ENW's own launch settings. Not in World at War's menus. / Game defaults are default_controls.cfg, with aim down sights on hold (ENW). / Changes apply at your next launch. Anything you change in the game's own menus comes back here after you quit. | Applies at next launch |
| `Settings.jsx` | In the game's menus, not mapped here (and four paragraphs of why) | (removed) |
| `Settings.jsx` | hover: ENW's launch baseline sets this until you choose | hover: ENW default |
| `Settings.jsx` | hover: The game picks this itself (reset to its registered default) | hover: Game default |
| `Settings.jsx` | (the dvar name on every row, e.g. r_picmip) | (removed) |
| `Settings.jsx` | hover on every key row: the command and its source file | (removed) |
| `Settings.jsx` | hover on every row: the dvar and its source file | (removed) |
| `wawSettings.js` | Borderless always runs at the monitor's native size; pick Fullscreen or Windowed to choose. | Borderless uses the monitor's native size. |
| `wawSettings.js` | Pick a rate your monitor has. Auto follows the display the launcher picked. | (removed) |
| `wawSettings.js` | PCGamingWiki records alt-tab hangs above 2x on this game. | Above 2x can hang on alt-tab. |
| `wawSettings.js` | ENW's baseline turns this on: PCGamingWiki's fix for stutter on modern PCs. | Fixes stutter on modern PCs. |
| `wawSettings.js` | ENW's baseline sets 16x. | (removed) |
| `wawSettings.js` | Reduced sets cg_mature 0 only; the game's own Reduced popup script was not found, so cg_blood is left as it is. | (removed) |
| `Profile.jsx` | World at War's own options, saved to your account. | (removed) |
| `Profile.jsx` | Auto (solo Global, group Local) | Auto |
| `Profile.jsx` | Records and badges stay public. | (removed) |
| `Profile.jsx` | Who can comment on your profile | Profile comments |
| `Profile.jsx` | Forced off in record games. | (removed) |
| `UsernameSetup.jsx` | This is your ENW username. Use the one you have on ENW Movement and drops.ws. | Your ENW username, the same as on ENW Movement. |
| `ChatDock.jsx` | Say something to every server | Message every game |
| `ChatDock.jsx` | goes to every ENW Zombies game as {name} | (removed) |
| `ChatDock.jsx` | Sign in to talk. Everyone can read. | Sign in to chat. |
| `SearchBar.jsx` | Maps come from the whole archive; players from everyone signed up. | (removed) |
| `TopDown.jsx` | No zombie positions in this frame — the box is not reporting them for this map. | No zombie positions |

### MapPage.jsx: the only edits (branch `web-maps` is redesigning it)

1. `MapPage()`: `<BackButton />` before `<MapBody>`. That is one line, plus an import.
2. The action row:
   * `<NotPlayable map={m} />` beside Play.
   * Play is disabled for `on_server === false`, with the reason as its title.
   * Its label is **Approval required** for a signed-in account that is not approved.
3. Removed: the "Download original" link, which only printed "Downloads are not available yet.",
   and the "Play needs approval. Browsing does not." line.

Left for `web-maps`:
* "Catalogued only. Nobody has fetched it, so it cannot be played here yet."
* "No manifest yet. The default is Round 20."
* the boards' `avatar={false}`, which could become `avatar="real"` for Movement's records rule.

### Tests and proof

`npm test` passes **157/0**: 105 in-process, 37 over HTTP and 15 sign-in. There are three new
in-process checks:
* the Not playable reason, on the list and on the party
* the XML parse and host check
* sign-in plus the once-a-day read, with a stubbed `fetch`

No test covered the picker.

**Screenshots** (`ui/cleanup-*.png`) were taken with headless Edge over CDP at 1440×900. They
ran against a private instance on **3457**, which held a `VACUUM INTO` copy of the live database
with its lobbies cleared. The "before" instance was on **3458**, a `git archive HEAD` build on
another copy. `web/data` and 3200 were not touched.

The accounts:
* Three fake accounts: `76561198000000101..103`. Their pictures are Steam's default avatar or
  none, and `avatar_checked` was set so nothing read a real profile for them.
* The project's own Steam account as `enwdev`, whose real picture was read from Steam.

The shots:
* `cleanup-home-wording-before` / `-after`, `cleanup-download-wording-before` / `-after`
* `cleanup-rail-avatars`, `cleanup-menu-avatar`
* `cleanup-card-1-maps` → `-2-map-page` (the card clicked: `/m/nazi_zombie_factory`) →
  `-3-back` (Back: `/maps`)
* `cleanup-notplayable-cards`, `-rows`, `-map-page` (the card reads "Not playable", disabled,
  with the title "Hits a game engine limit on our servers")
* `cleanup-member-no-map-kick` (perkaholic `downloading 42%` ×, ghoulbait `has the map` ×, and
  the card reads "Waiting for downloads"), then `cleanup-member-kicked`

### Unproven

* **A real sign-in through Steam storing the picture.** The dev instance signs in with
  `/auth/test-login`, which does not call `steamAvatar`. The picture came from the first
  `/api/me`, which is the daily path. The sign-in call is the same function with `force`.
* **Steam rate limits.** At most one read per player per day. Nobody has measured what Steam
  does with many.
* **The launcher window.** The back control and the card are unchecked under the frameless title
  bar.
* **The download state of a member whose launcher never reports.** It shows nothing, which is
  `partyProgress`'s "silence is not a refusal" rule. That member reads "in party" until their
  launcher posts.
* **Phone widths.**

## 2026-09-22, late evening — `/settings` cleaned up in Gaff's shape (branch `web-settings-2`)

B: *"Clean up the settings menu. It should be like my project Gaff's settings menu, split off into
little sections and really simplified."* The WaW-menu layout from the section above is replaced;
**what every row writes is unchanged** (`data/wawSettings.js`, `client.md` §8 table — nothing
remapped, nothing dropped).

### What was copied from Gaff, and from where

Read-only, from Gaff's source (B: the repo is the authority) —
`C:\Users\b\Desktop\WatchGame\app\src\components\SettingsScreen.jsx` and the `.settings-screen`,
`.ss-*`, `.seg-ctl`/`.seg-btn`, `.check-field`, `.theme-select` rules in
`WatchGame\app\src\styles.css` — cross-checked against the shipped build (`app.asar` copied to
scratch and extracted with `@electron/asar`; the install was not touched, Gaff.exe not launched):

* **One bordered screen**, a header line reading `settings`, then a **left rail** (202 px, a shade
  darker than the panel) with a **search box** on top and **icon tabs** under it (13.5 px, 9 px
  radius, the active tab on a raised fill). Search matches every row and shows `Tab › section` above
  each hit, as Gaff's `ss-crumb` does. Under 680 px the rail becomes a row of tabs (Gaff's own
  breakpoint).
* **Little sections** inside a tab: a small lowercase heading in the accent colour on a 1.5 px rule
  (`ss-section`), rows 9 px apart.
* **Row types, as Gaff draws them**: on/off → a checkbox then the label (`check-field`); a few
  choices → label left, **segmented buttons** right with the chosen one filled (`ss-seg-row` +
  `seg-ctl`); a long list → a select (`theme-select`); a number → label, slider, value at the right
  (the volume rows). Lowercase labels; a one-line grey hint (`ss-hint`) only where the value is not
  self-evident — five rows have one.
* Gaff's amber is the site's `--accent`, so the page follows the site's themes.

Ours, not Gaff's: **key rows** (label + Key / Alt capture boxes; Esc cancels, Backspace clears —
unchanged), a small **reset** at the right of every section heading (Gaff has none; the brief kept
Reset per section), and an **`auto`** segment on rows whose game default is "the game picks"
(`def: null` → `reset <dvar>`), because a checkbox cannot say it. The `‹ value ›` pickers, dvar
codes on every row, ENW tags and the per-menu footers are gone; the dvar and source are on hover.

### The sections

| Tab | Sections (rows) |
|---|---|
| Display | **screen** (display mode, monitor, resolution, refresh rate, aspect ratio) · **picture** (field of view, brightness, max fps, vsync, show fps) |
| Graphics | **quality** (anti-aliasing, shadows, specular map, glow, depth of field, dual video cards) · **world** (corpses, bullet impacts, dynamic foliage, ocean simulation) · **textures** (anisotropy, mipmaps, texture quality, texture / normal map / specular map detail — dimmed unless quality is manual, as in the game) |
| Audio | **volume** (master, music, effects, voice, cinematics) · **sound** (line of sight occlusion) |
| Controls | **mouse** (sensitivity, invert, smooth, free look, raw input) · **move** · **combat** · **interact** · **look** (41 key rows) |
| Game | **game** (mature content, subtitles, hud, crosshair, console) |
| ENW | **launcher** (client installed / version / update, inside the launcher) · **chat** (*pause game while chatting (solo)* → `pause_on_chat`, default on — the setting the overlay lane added) · **the slot** · **how settings apply** (one line + the not-mapped list) |

### Files

* `client/src/data/settingsLayout.js` (new) — tabs, sections, short labels, hints, short option
  words. Presentation only; it places catalogue ids.
* `client/src/data/wawSettings.js` — one additive helper, `defaultsFor(items)`; `sectionDefaults`
  now calls it (same result).
* `client/src/components/settings/SettingRow.jsx`, `TabIcon.jsx`, **`EnwSection.jsx`** (new).
  `pages/Settings.jsx` rewritten around them; load / save / launcher sync / key capture code is
  the same as before. `components/launcherBridge.js` untouched.
* **For branch `updates-downloads`**: the ENW tab is its own component, `EnwSection.jsx`, with a
  marked `SLOT` (`<div className="set-slot" data-slot="updates-downloads" />`) between *chat* and
  *how settings apply*. Put the Installed maps box and the Update button there as
  `<div className="set-group">` blocks with a `set-section` heading. Nothing else depends on it.
* `theme.css`: the `.waw-*` block replaced by `.set-*`.
* Old links (`/settings#texture`, `#look`, …) land on the new tab that holds those rows.

### Proof

* `web npm test` (after rebasing on main with web-profile): **112 / 41 / 15 / 19, 0 failed**. One earlier run had a single `local-run` failure in the username-claim test ("already_set"), which passed on the next three runs - not this change, likely a concurrent run; noted. New check: every catalogue item is placed in
  exactly one section, no layout id is foreign, and the union of the section resets equals
  `allDefaults()` — the regroup cannot change what a reset writes.
* **Dev port `:3462`** (own copy of the DB in scratch, `ZM_TEST_LOGIN=1`, a fake SteamID and the
  name `settings_test`), driven through the real page in headless Edge: clicked corpses → *insane*,
  mipmaps → *trilinear*, shadows → *auto*, Forward's Alt box then **I**, and unticked *pause game
  while chatting*. Status read *saved*; `GET /api/me/settings` returned
  `{"pause_on_chat":false,"waw":{"ai_corpseCount":"32","r_texFilterMipMode":"Force Trilinear","sm_enable":null},"forward":["W","I"]}`;
  after a reload the corpses row showed *insane*.
* Screenshots in `docs/kickstart/ui/`: `settings2-{display,graphics,audio,controls,game,enw}.png`,
  `settings2-search.png`, `settings2-mobile.png`, `settings2-graphics-saved.png` (after the round
  trip); Gaff for comparison, its real `SettingsScreen.jsx` rendered in a read-only Vite harness in
  scratch: `gaff-settings-{account,video,audio,personalization}.png`.

### Unproven

* **Inside the launcher.** Not run in the launcher's preload; the bridge code path is unchanged from
  the section above (which did prove it), but the ENW tab's *launcher* rows were only seen in their
  browser fallback. **In game**: nothing new — client.md §8d still stands as the check.
* `pause_on_chat` reaching the game: the row saves it; the overlay reading it is the overlay lane's
  proof (`/api/game-chat/me`).
* Not deployed, not merged.

## 2026-09-22, late evening — downloads 302 to the Hetzner buckets (`lib/bucket.js`)

B: download speed through the site (his PC + the Cloudflare tunnel, capped by his 6 MB/s
uplink) is unacceptable. Two public Hetzner Object Storage buckets now hold copies of the big
files; the full design, cost and commands are **[`storage.md`](storage.md)**.

* **`web/server/lib/bucket.js`** — the redirect decision. Off unless `S3_BUCKET_FILES` /
  `S3_BUCKET_MAPS` are in the environment (`infra\site.env`; `S3_ENDPOINT` defaults to
  `https://nbg1.your-objectstorage.com`). An anonymous `HEAD` on the public URL (1.5 s timeout),
  cached 5 minutes; the bucket copy is used only if it exists **and** has the local file's size.
  Anything else serves locally exactly as before. The site never holds the S3 keys.
* **`/updates/<installer>` and `.blockmap`** → 302 (middleware before `express.static`, after the
  gate — `/updates` is still gate-exempt). **`latest.yml` is always served locally.**
* **`/api/maps/<bsp>/files/<file>`** → 302 (still behind the gate; `x-enw-sha256` rides on the
  302). **`/mapdata/*.glb`** → 302; `.meta.json` stays local.
* **`/api/maps/<bsp>/files`** gains `mirror_url` per file (computed; `map_files` is provenance,
  not what is uploaded — storage.md §5). `mapfiles.served()` is what `tools/s3/sync.js` mirrors.
* **Tests**: `web/test/bucket.js` (in `npm test`): not configured → local; configured + exists →
  302 for installer and blockmap; latest.yml local; wrong size → local; HEAD error → local; the
  5-minute cache; and a real cross-origin follow proving `Range` survives and `Authorization` /
  `Cookie` do not.
* **To turn it on** (coordinator): add to `infra\site.env`
  `S3_BUCKET_FILES=enw-zombies-files`, `S3_BUCKET_MAPS=enw-zombies-maps` and restart the site the
  usual way (keepalive). `npm install` in `web` first: `@aws-sdk/client-s3` and
  `@aws-sdk/lib-storage` are new dependencies (only the tools use them; the site does not load
  them).


## 2026-09-22, late evening — the update chip, Download on its own, installed maps, the bar (launcher 0.2.12)

Branch `updates-downloads`. The launcher half (IPC, the updater change, what "installed" means,
the incident with the dev window) is `launcher.md`, same date. Everything here draws **only
inside the launcher** except Download, which in a browser goes to `/download` like Play.

| What | Where | Words |
|---|---|---|
| Update chip, top right of the nav, left of Discord | `components/UpdateChip.jsx` in `Nav.jsx` | `Update 0.2.13` [Update now] Later → `Updating ━━ 37%` → `Update 0.2.13 ready` [Restart now] Later; a broken download: `Update failed` [Retry] Later |
| Download beside Play on the map page | `components/MapDownload.jsx` `DownloadButton` in `pages/MapPage.jsx` | Download → Downloading ━━ 37% → ✓ Downloaded (Retry download + the reason on failure) |
| Download on the rail's server card, small | `CardDownload` in `PartyRail.jsx` (only while forming / ready check, only for a playable map) | Download → ━━ 37% → ✓ Downloaded |
| The bar | `DlBar` (same file); `.dlbar*`, `.dlrow` in `theme.css` | a slim track **then** the % in tabular mono; a standalone progress row is 54 px, the online block's row height |
| Party members downloading | `PlayerCard` / `roleOf` in `PartyRail.jsx` | the role line becomes the bar + % |
| Settings → ENW → **update** and **installed maps** | `components/LauncherBoxes.jsx`, rendered in web-settings-2's slot in `components/settings/EnwSection.jsx` | `launcher 0.2.12` [Check for updates / Update now / Updating bar / Restart now] + the launcher's own line; a little box of rows (art, title, key, size), checkboxes, Select all, `Remove 2 · 447 MB`, a confirm naming the maps and the space freed |

* **Data:** `launcherBridge.js` hooks `useUpdateStatus`, `useMapInstall(key)`, `useInstalledMaps()`;
  pure helpers `components/launcherFormat.js` (`chipPhase`, `clampPct`, `fmtSize` — binary GB with
  one decimal, MB under 1 GB, the numbers Explorer shows — `bySizeDesc`), tested in
  `web/test/run-all.js`. Art for installed maps comes from the rail's pool, else `/api/maps/<key>`.
* **Older launcher on this site:** no chip (0.2.11 has no `updateNow`); Download still works through
  `installMap` and learns Downloaded from its answer. The account menu keeps *Restart to update* and
  gains *Update now* (the way back after Later). The ENW tab's own `update` text row was removed —
  the update section says it with the button.
* **Merged over main:** web-cleanup's card (no picker, `Not playable`, the Back link) and
  web-settings-2's Gaff layout; my earlier pause-on-chat box was dropped because EnwSection's
  *chat* section already has it.
* **Tests:** `npm test` **118 / 41 / 15 / 19, 0 failed** (three new: the chip's phases and Later;
  sizes and sort; every bridge call the UI uses exists in `preload.cjs`, Download in a browser goes
  through the play gate, and EnwSection renders both sections).
* **Proof:** the launcher.md section's screenshots (`ui/2026-09-22-launcher-0.2.12-*`), on a private
  :3471 with a DB copy; the settings shots are after the rebase onto the Gaff layout.
* **Not proven:** phone widths; the chip against a real feed; a member's bar fed by a *second* real
  launcher (the shot is our own row, through the site's party-progress path).

## 2026-09-23, ~01:00–02:00 UK — several games per box, the launcher cancel that ended B's game, quit vs crash

### Several games per box (`lib/assignments.js`, "SEVERAL GAMES PER BOX")

1. A player who presses Play again replaces **their own** game: a live lease of the same party, or
   of exactly the same SteamIDs, is superseded. Nobody else's game is touched.
2. Otherwise the lease takes a free slot. `capacity(box).max` is `boxes.max_instances`, capped by
   the `max_instances` the box reports, and set to **1** for a box whose host agent does not poll
   with `?v=2`.
3. `boxes.reserve` (NULL means 1 on a box of 3 or more, else 0) is the number of slots only an
   **agent lease** may use. `assignments.agent=1` comes from `agent: true`, from lease-cli (always,
   unless `--real`), or from the admin lease route (unless `agent:false`). Real players get
   `max - reserve` slots. An agent never takes the last slot a real player is still entitled to.
   The exception is a one-slot box, where an agent may take an empty box.
4. A real lease that finds the box full, while real players are under their share, supersedes
   the **oldest agent lease**. This is the only cross-party supersede.
5. Anything else answers `{ ok:false, full:true, error:'No free server right now' }` and
   supersedes nothing. `parties.launch` passes the error through, and the launcher does not launch.

`forBox(box, {v:2})` returns every live lease (host.md §13.1). `cancel` and `ack` work by match
id. `ack` only moves forward, so a late `ready` never takes a `live` lease back. `recordStatus`
keeps the heartbeat's `instances`, `host`, `protocol` and `max_instances` across per-game posts.
`connectFor` no longer falls back to `instances[0]`, which would hand a player another party's port.
The migration adds `boxes.reserve` and `assignments.agent`, and sets zombies-dev to
`max_instances 3` once, when the column is added. `POST /api/admin/boxes/:name/capacity
{max_instances, reserve}` changes both afterwards.

### Why B's game went idle mid-round (m_6d80aa20, 23:50 UTC): not a TTL

The activity log has `assignment.cancel` for m_6d80aa20 at 23:50:09 **with B's own SteamID as
actor**. Nothing on the site expires a lease. A second launch of his, a rejoin into the same
match, failed when its game window closed at 23:50:02. The launcher's failure path
(`launcher/src/main/main.js` `releaseLease('the launch failed')`) then POSTed
`/api/launcher/cancel`, and that route cancelled the party's current match, which was B's live
game. The other "idle", m_abb67742, was an agent's `lease-cli --cancel`.
**Fix:** `assignments.release()` refuses to cancel a `live` lease (409 `{live:true}`). If the body
names a `match_id` that is not the party's current one, it does nothing. A live game ends on the
box (game over, a Quit, or the crash window below). Launcher lane: send `{match_id}` with cancel.

### Quit vs crash, and no relaunch loop (`lib/seats.js`)

The launcher's watcher launches whenever the poll phase is `reserving|loading|ready|in-game` and
no launch of its own is running. The site used to show `in-game` for as long as the lease was
live. So once a player's game went away, by quit, crash, or a flow ending while the game was
still up, the watcher launched again, about every 25 s. `seats.observe()` now records, from every
live frame, which SteamIDs are connected to which match. The phase is decided per player:

* connected → **`playing`**. This is not a follow state. Launcher lane: read `playing` as
  "connected" wherever you read `in-game` for that.
* was connected, is not, and did not quit → **`resumable`**. This is not a follow state either.
  `GET /api/party` and `/api/launcher/play` carry `resume: {match_id, left_at, until}`, and the
  rail's server card shows **Resume**.
* `POST /api/party/resume` mints a fresh token (the old one expires after 5 min, and the box
  refuses a replayed one) and sets the phase back to the lease's own (`in-game`), which the
  watcher follows. A resume that has not connected within 2 min goes back to `resumable`.
* `POST /api/party/quit {match_id}` is authenticated by the session **or the game's chat pass**,
  and is exempt from the beta gate. It is called by the Esc menu's Exit game (the client lane's
  `pause_menu.cpp`). Solo, it cancels the lease and dissolves the party. In a party, the player
  leaves it and the game goes on.
* `seats.sweep()` runs on every box status post. A live lease that everybody left 10 min ago,
  with nobody resuming, is cancelled. The referee usually ends the game first (host.md §13.3).
* The data is in memory. After a site restart, the worst case is one extra follow.

### Tests

`test/run-all.js` gained 23 checks: old-protocol refusal, own-game replace, two agent leases both
live, the v2 list, third agent refused (reserve), real-lease yield, full box supersedes nobody,
cancel by match id, forward-only ack, launcher release (live, other match, unclaimed), the status
merge, **a party polled 20 times after launch never asks for a second launch**, crash =
resumable with no relaunch, Resume once with a fresh token, solo quit, co-op quit, and the
ten-minute sweep. Result: 142/142. The other suites also pass (`game-chat` 19, `launcher-signin` 15,
`local-run` 41).

### Deploy

Restart the site and rebuild the client (the rail changed). Then deploy the host agent (host.md
§13). A site on this code with an old agent is safe: the box counts as one slot, and an agent's
lease is refused rather than kicking anybody.

Rail Resume inside the launcher: after `POST /api/party/resume`, the button calls
`window.enw.resumeMatch(match_id)`. That call is the launcher's `followgate.js` exception to
"launch each match once".

Box proof: dedi.md §19.6.

---

## 2026-09-23, early — Easter egg steps on the map page, blurred until asked for (branch `web-easter-eggs`)

B: "Have an Easter egg guide section that is blurred/obscured by default, with 'Show Easter egg
steps' ... If a map has no Easter egg steps, don't show the section."

**Where the steps come from.** `archive/easter_eggs.py` (archive.md §11) reads release posts
and threads we already hold, keeps the sections that are instructions, and writes
`<archive work>/reports/map_guides.json`. Tonight: **26 guides on 20 maps**.

**The table.** `map_guides` (db/database.js): `sig` (map|kind|title, unique), `map_key`, `kind`
(`easter_egg`|`power`|`song`|`ending`|`other`), `title`, `reward`, `steps_json`, `source_url`,
`source_site`, `source_author`, `source_file`, `confidence`, `evidence_json`, `origin`
(`archive`; `script` later), `state` (`live`|`hidden`|`deleted`), `staff_by/at`. Only
`lib/guides.js` writes it, and only from the importer or a mod's hide/delete.

**Ingestion (for the coordinator, against the live DB):**

```
python archive/easter_eggs.py                          # re-make the report (no requests)
cd web && node server/db/import-archive.js --guides --dry
node server/db/import-archive.js --guides              # or: npm run import:guides
```

`--guides` alone imports only the guides; the map import does not run. Each guide lists the site
keys it may belong to, most specific first (a pipeline bsp, then `cat:<norm>`), and the first one
that exists wins. It is re-runnable: an unchanged guide stays as it is, a changed one updates in
place, one the heuristic no longer finds is removed *unless staff touched it*, and a deleted one
stays deleted. Scraped fields are re-typed and capped, and a non-http `source_url` is dropped.

**The map page** (`MapPage.jsx` `Guides`). The section sits under "What's in it" and renders only
when `map.guides` is non-empty. The steps are drawn blurred (CSS `filter: blur(7px)`, no select,
no pointer, `aria-hidden`) under a centred **Show Easter egg steps** button. Revealing is
remembered per map in this browser (`localStorage enw.ee.shown.<key>`, try/catch), with a
**Hide** link to undo it. Steps are a numbered list: a titled step keeps its title in bold,
location lists are sub-bullets, sub-headings are not numbered. Under it: "Gets you: …" (only
when the guide says) and **From <author> on <site>**, linking to the post (ip-posture.md). Several
guides are tabs: Main quest / Power / Song / Ending / Side quest. Two side quests use their own
titles instead of a repeated tab name. Players never see the confidence.

**The EE tag.** `project()` adds `ee_guide`: a live **main-quest** guide exists. That is a
different claim from `has_ee` ("the map has one"). An EE flag sits top-left on the card picture,
a gold EE tag on the list row, and the Archive row shows EE for either claim, with a tooltip that
says which. All 8 main-quest maps are catalogue rows, so tonight the tag shows on `/archive` only.

**Admin** (`/admin` → guides; `GET /api/admin/guides[?state=]`, `POST /api/admin/guides/:id
{state}`, mods only). Every guide is listed weakest first, with its confidence (label, and the
evidence on hover), map, source, state, and **Hide / Show / Delete**. A delete asks for
confirmation, clears the steps, leaves a tombstone and writes to `activity_log`.

**Proof.** Dev site on **:3457** against a backup copy of the live DB (`better-sqlite3` backup,
read-only on the source). The media were junctioned and a throwaway mod `76561190000000999`
existed only in that copy. Screenshots were taken with headless Edge over CDP:
blurred (Escher), revealed, still revealed after reload, the side-quest tab, Unterwegs' three
tabs, Battlestar Galactica (a playable map, Ending tab), **Leviathan with no section** (no guide),
the Archive EE tag, and the admin list. `npm test` is green. The new `test/guides.js` (12 checks)
covers ingestion (key resolution, unknown map, bad rows, a `javascript:` link dropped,
idempotence, dry run, stale removal, the tombstone), the map-page payload and `ee_guide`, and the
routes over HTTP (map detail, admin 401/403/200, hide/show/delete, 400/404). It also runs the
extractor's `--selftest`.

**Not proven:** phone widths; how the blur looks with a very long guide; and whether any of these
steps are right. They are the map authors' own release text, and nobody has played them.

## 2026-09-23, ~03:00 UK — `/maps` is Movement's mode home, with a Cards | List switch (branch `web-maps-view`)

B: get rid of the strip at the top of `/maps` ("new maps / vanilla / high production"). The
default is cards, like Movement's mode home, with the playlists. A switch top right goes to the list,
and the choice is remembered. "View all maps" at the bottom goes to the list.

**Removed.** The three collection rows (`MapRows`, New maps · Vanilla · High production) that sat
above the list on `/maps`. That is the strip B named. Home still draws them, unchanged. Also removed:
the old grid drawing of the list (the `Cards` half of the old switch drew every map as a grid) and
its CSS (`.map-grid`). The brief read the strip as "collection/filter chips". The filter bar is
still there, in the list view.

**What each piece comes from (Movement → ours)**

| Ours | Movement |
|---|---|
| `pages/Maps.jsx` `MapsHome` (the cards view) | `pages/ModeHome.jsx`: rows, then a row per playlist, then "All playlists" as covers, then the browse button |
| "Popular" row (`/api/maps?sort=popular&limit=12`) | the "Popular on ENW" band, drawn as a `MapRow`. We count plays, not a week, so the tiles' facts line would have nothing to say |
| "Your maps" row (signed in, `progress=played`) and its empty line | the "Your maps" row and "Play something and it lands here." |
| a row per curated playlist, then "All playlists" | the playlist `MapRow`s and "All playlists" (`/api/playlists`, the same list `/playlists` draws). No "Play all": zombies has no playlist walk |
| `components/PlaylistCover.jsx` + `.pl-*` CSS | `components/PlaylistCover.jsx` + theme.css `.pl-cover`, copied verbatim. The tiles are our thumbs and it is a `Link` |
| "View all maps" (`.mode-browse`) | the "Browse all N surf maps" `.mode-browse` button |
| `components/ModeViewSwitch.jsx` (Cards \| List) | `components/ModeViewSwitch.jsx` (Home \| Maps), same markup and CSS |
| the list view (`.rdk-bar` + `MapListRow`) | `pages/Hub.jsx` + `MapList.jsx`, as before |

**The view rule.** The switch saves the choice to `localStorage['zm_maps_view_v1']` (Movement's
`gn_map_sort_v1` pattern) and the next visit opens on it. The old key `zm.maps.view` is ignored, so
everybody starts on cards. A URL states a view without saving it. `?view=list` or `?view=cards`
wins once, and so does any filter in the URL (the search box's "All maps matching…", a map page's
tag link), because only the list answers a filter. "View all maps" goes to `?view=list` as a push, so
Back returns to the cards. Switching to Cards drops the filters. **Movement does not do this**: its
pool dropped `?view=` when it went to one drawing (Hub.jsx, 2026-08-19), and it saves no view. The
saving is B's request, not a port.

**Proof.** Headless Edge against a private site on 3417 with a copy of the DB. Three demo playlists
were added **to the copy only**, because the live DB has **no playlists**. Checked in order: fresh
visit → cards, and the switch shows Cards · View all maps → `?view=list`, 78 rows · Back → cards ·
List switch → list, saved `list` · reload → still list · `/maps?q=nacht` → 2 rows · Cards switch →
cards, saved `cards`, URL `/maps` · reload → cards · `/maps?view=list` → list, saved value still
`cards` · `/maps` → cards. Screenshots:
`ui/2026-09-23-maps-cards-default.png`, `ui/2026-09-23-maps-view-switch.png`,
`ui/2026-09-23-maps-list-view.png`, `ui/2026-09-23-maps-list-after-reload.png`. (In the full-page
cards shot, the fixed rail's sign-in button and the chat pill show mid-page. That comes from the
capture, not the page.) `npm test` is green.

**Not proven:** signed in (the "Your maps" row was not drawn with a real account); phone widths;
the launcher's window. On the live DB the cards view is just Popular + View all maps until an admin
publishes a playlist. **Needs a client build and a site restart.**

## 2026-09-23 — map page: records tab, downloads pop-over, What's in it removed

B: make `/maps/:id` (`/m/<map>`) look more like ENW Movement. Put the records in their own tab
below, drawn like Movement's but a bit bigger, with a **Watch** button on the row ("not a
complicated flow through multiple menus"). Keep the downloads at the bottom, behind a small
pop-up. Keep About and the comments as they are. Get rid of "What's in it" for now.

**Movement, read first.** `movement-client/src/components/MapDashboard.jsx` (the board under the
banner, comments beside it), `RecordTable.jsx` `density="board"` (rank · player · time · points ·
behind · date · Watch; `.rt-board` 44px rows, 13px text, 14.5px time, 9.5px mono head) and
`replay3d/WatchButton.jsx` (Watch on the row, opens the viewer in one click).

**What changed (`client/src/pages/MapPage.jsx`, new `MapPage.css`)**

| Before | Now |
|---|---|
| "What's in it" tiles (perks, Pack-a-Punch, box, wall buys, wonder weapons, dogs, power...) | removed. `features` stays on the wire. The weapon-index idea is parked in `questions.md` → Parked ideas |
| About · Records · Recent games · What counts as beating it · Download · Versions on the left, comments on the right | two tabs under the banner. **About** is the old split with About and Comments (and Live now / Friends who beat it) untouched. **Records** is the board on its own at full width. The Records tab shows the run count. `#records` opens the page on it, and switching tabs rewrites the hash with `replaceState` |
| board: `table.data`, # · Players · Round, "Open challenges: ..." line | Movement's board grid a size up: **54px rows, 14.5px, 17px figure, 10.5px head**. Columns are # · Players (avatars) · Round · Time · Kills · Downs · Date · **Watch**. A time board leads with Time, then Round. Your own run is tinted in the map's colour |
| every board as a chip, all four player counts, even empty ones | a chip only for boards **with runs** and a button only for player counts **with runs**. With one of each they are plain labels ("Highest round" · "Solo"). No runs anywhere: "No records yet." |
| Download section (archived originals + every link + checker verdict) mid-page | **Files N** button at the foot. It opens a pop-over upward, with the install action (`DownloadButton`) on top, then one line per file: name, size, source (ENW archive / link health). It closes on Esc, a click outside, or the button again. No files: no button. Versions picker beside it when a map has more than one |
| picture credit ("Screenshot from the release post"), "Creator unknown", "N games on this map now" under Play, Recent games, the referee's finish table with its Priority column, the scanner's "Scanner verdict: ..." readme line | removed. The generated card still says NO SCREENSHOT ON FILE on its face, Play still reads Join when a game is live, and Live now is still in the right column. "Beaten by ... by reaching round N" says what counts. The scanner line was the **whole** readme on all 5 maps that have one |

**Which columns show.** Time is hidden when no row has a duration. **Kills and Downs are wired but
hidden** until a row has a value over 0. `lib/records.js rowsFor` now returns `kills`/`downs`: the
sums of that game's `game_players` rows, NULL when the game has none. Today every value is 0 (the
box does not report them yet; another agent is on it). When they arrive the columns appear with
no page change. Watch shows only where a row has `replay: true` (a `replays` row for the game).

**Watch** is a `Link` to `/replay/<match_id>`, the route replay.md §7a serves, so it takes one
click and there are no pages in between. Movement opens a modal over the page. Ours goes to the
full-bleed viewer page, which already exists and already has Back.

**Server (additive, no migration):** `rowsFor` adds `replay`, `kills`, `downs`. `GET /api/maps/:key`
asks `forMap` for 25 rows a board instead of 10. `maps.sourcesFor` adds `size_bytes` (the column
has existed since the storage pass) so the pop-over can show link sizes.

**CSS.** Everything new is in `pages/MapPage.css`, scoped under `.mapdash` and built from existing
tokens only. The global theme is another agent's and theme.css was not touched. So theme.css
still carries `.mdfeat*`, `.mapdash-credit` and `.mapdash-live` with nothing using them.
`.mapdash-feats` is still used by the Easter egg block.

**Proof.** A private site on **:3461** against a `better-sqlite3` backup of the live DB (in
`tmp/scratch-data`, read-only on the source), `ZM_REPLAY_PULL=off`, and headless Edge over CDP
(`tmp/shoot.mjs`). Nacht (stock): 1 run, columns `# | Players | Round | Time | Date | Watch`, Watch →
`/replay/m_0afb449b`, and the viewer drew Nacht and played. Minecraft Village Remastered (custom):
2 runs, both with Watch; the Files pop-over listed 2 (the archived `.exe`, 593 MB, and the
mediafire link, Held). "What's in it" appeared on neither page. Screenshots are in the worktree's
`tmp/shots/`, not committed. `npm test` is green (143 + 41 + 15 + 19 + 12 + 10 + 12).

**Not proven:** signed in (the "your run" tint and the rating were not drawn with a real account);
phone widths; a board with several player counts or categories (the live data has one solo round
board per map); Watch on a custom map's replay, because its `.enwr` is on the box and the scratch
site had the pull turned off. The generated placeholder card is cropped at its edges in the
banner, and that was already so before this change. **Needs a client build and a site restart**
(the server fields).

## 2026-09-23, ~04:30 UK — theme: black, logo, scrollbar (branch of the global layer)

B: *"a lot black or dark as the theme. Black mainly. Use the map colours very sparingly, only on the
map page. The rest of the site is dark, dark and black, very serious looking, but still a derivative
of ENW Movement."* *"Use the ENW SVG logo everywhere."* *"Clean up the scroll bar on the right."*
Global layer only: tokens, `theme.css` shared blocks, the shell, rail, nav, shared components, the
launcher's own pages. Page markup of `/m/:key`, `/admin`, `/id/:who`, `/records` was not touched;
those pages move through the tokens they inherit.

### Tokens (`theme.css :root` and `themes.js`, kept identical)

| Token | Was (Movement) | Now | How it was derived |
|---|---|---|---|
| `--bg` | `#101010` | `#080808` | Movement's ground, eight steps down |
| `--bg-grad` | `#161616 → #101010 → #0a0a0a` | `#0e0e0e → #080808 → #040404` | same angle and stops, each stop eight down |
| `--panel-solid` | `#1c1c1c` | `#141414` | `--panel` (.05 white) over the new `--bg`, resolved |
| `--panel-deep` | `#0a0a0a` | `#040404` | the gradient's foot |
| `--rail-grad` | — | white .028 → .008 → 0, top down | new: the rail's ground, what is left of the WaW default gradient (overnight decision 5) |
| `--scroll-track` / `--scroll-thumb` / `--scroll-thumb-hover` | — | `#040404` / white .12 / white .22 | new |
| `--panel`, `--panel-2`, `--line*`, `--text`, `--muted`, `--faint`, `--accent*`, signal colours | | unchanged | Movement's rule: the greys do not move |

`index.html`: `theme-color` `#080808`, an inline `html,body{background:#080808}` so nothing paints
before the CSS, and the favicon is now Movement's own (`movement-client/public/favicon.svg`: the
white mark on its `#0a0a0a` rounded plate).

**`.btn.primary` is Movement's `.btn-accent`**: near-white on the black, not `--hot` red. Red stays
for refusals and destructive actions (`.btn.danger`, `.um-danger`, `.wc-close`, `.tag.np`).
This changes Sign in, Continue and Download everywhere; the map page's own Play (`.playbtn`) keeps
the map colour.

### Map colour on the map page only

* `ambience.js`: the backdrop and pour paint **only for the open map on `/m/<key>`**
  (`onMapPage()`). Home's selected map, hover previews in the list and on cards, and a profile's
  banner leave the ground black. The calls in `Home.jsx`, `Maps.jsx`, `MapCard.jsx`,
  `MapListPanel.jsx` and `Profile.jsx` are untouched; restoring a tier is that one test.
  With nothing open, `data-amb` is removed rather than pouring a near-neutral WaW pair. §11e's
  "the site is grey and the map is the colour" still holds; the grey is now black.
* Hue washes removed outside the map page: the rail's server card and its no-art plate, the list
  view's row wash and art plate (`.mlrow`), the search panel's no-art plate, `/settings` installed
  maps' no-art plate. Kept: `.map-card` / `.pl-cover` (map cards), `.fcard.has-map` (a lobby row
  wearing its map's picture), the server card's picture, and everything on `.mapdash`.
* The rail (`.prail`) takes `--rail-grad`: near-black, top-lit, gone by the middle.

### The ENW mark

* `client/src/assets/enw-mark.svg`: Movement's file, byte for byte (the corrected box that starts
  at the E's ink, 319.75 × 156).
* `components/Enw.jsx`: `EnwWord`, Movement's `EnwWord.jsx` verbatim (the mark as the word "ENW"
  in a sentence: a mask over `currentColor`, cap height × 1.04), and `EnwName` (mark + "Zombies").
  `.enw-inline` CSS is Movement's verbatim.
* `Bits.jsx` `Mark` uses the corrected viewBox (`2.05 0 319.75 156`); the old `0 0 321.8 156` carried
  2 units of air down the left. The nav mark takes Movement's `.enw-mark-link` hover (92% → 100%).
* Text "ENW" replaced by the mark: account menu (launcher line, "Install the ENW client"), rail
  invite box ("Type an ENW name"), `/settings` ENW hint, `/archive` "Not playable on ENW",
  the name picker (both lines), `/download` heading (the mark is above it, so the heading is now
  "Install the Zombies launcher"), the 404 (mark added), the server's sign-in problem page and its
  no-build fallback (`server/lib/enwMark.js`, inline SVG, black), the launcher's loopback sign-in
  page (`main.js signInPage`), the launcher's screens strip (`shell.html`) and its "site is not
  answering" page (`placeholder.html`, the lockup and both prose mentions).
* **Not a lockup with ZOMBIES under the mark.** B took that foot off (the plain ENW logo, above).
  "ENW Zombies" in a line is the mark, a space, then "Zombies".
* Left as text on purpose: `<title>`s, `aria-label`s, input placeholders ("ENW name…"), tooltips,
  data values (`ENW-Verified`, `ENW-<fingerprint>`), Discord messages.
* **Not changed, owned by other lanes tonight:** Admin's "ENW link" section title, Profile's "No
  such player on ENW Zombies." and its banner tooltip. Each is a one-line `<EnwWord />` swap.

### Scrollbars

`theme.css`: one set of `::-webkit-scrollbar` rules for the whole document (Movement's rail thumb
made global: a pill inset 2px by a transparent border, 10px, transparent track inside containers,
`#040404` on the page itself) and, only where those pseudo-elements do not exist (Firefox),
`scrollbar-color` + `scrollbar-width: thin` (inside `@supports not selector(::-webkit-scrollbar)`,
because in Chromium 121+ `scrollbar-color` switches the pseudo-elements off). `color-scheme: dark`
on `html` for native controls. Containers that hide their bar (`.maprow-track`, `.mv-nav-center`)
still do. The launcher's site view is the site, so it inherits this; `shell.css` and
`placeholder.html` carry the same rules for the launcher's own screens.

Launcher leftovers of the old olive palette went at the same time: the boot art gradient
(`#2d3021`), the toast (`#1a1c15`), the focus ring (`rgba(123,126,88)`), and both windows'
`backgroundColor` (`#101010` → `#080808`).

### Bug 14: "test server never came up on 33991"

`test/_port.js`: `freePort(preferred)` takes 33991 when nothing holds it and an OS-assigned port
when something does; `waitHttp()` polls with a jittered backoff (150 ms → 1 s) to a 60–90 s deadline
and stops at once, with the child's stderr tail, if the child exits. `local-run.js` uses both,
awaits the old child's exit before a restart, and respawns a child that died on `EADDRINUSE`.
`launcher-signin.js` picks its three ports the same way (it used to poll 15 s and carry on
regardless). Proof: with a dummy listener holding 33991 and **two `local-run.js` running at once**,
both passed 41/0.

### Verified (headless Edge over CDP, scratch site on :3471, `VACUUM INTO` copy of the live DB)

Screenshots in the worktree's `tmp/shots/` (not committed): home signed out and signed in, home
with a map open, `/maps` cards and list, `/m/nazi_zombie_ali`, `/records`, `/archive` scrolled
(the page scrollbar), `/download`, the 404, `/settings`, the rail's invite box, the account menu,
`/id/myu`, `/admin`, the name picker, the sign-in problem page, and the launcher's placeholder
(opened as a file). Probed: `data-amb` is set on `/m/<key>` and absent on `/`, `/maps` and after a
card hover. `web npm test` green (143 / 41 / 15 / 19 / 12 / 10 / 12). A second run at 04:15 had
`map-align.js` at 4/6: it reads `ZombiesDev\maps\*.glb`, and `nazi_zombie_prototype.glb` was
re-exported at 04:13 by another lane; main's own checkout fails it the same way. Launcher
`run-all.js` 137/1, the one failure is the worktree having no built client DLL.

**Not proven:** the real launcher window (frameless title bar over the black nav, the shell's
screens); Firefox; phone widths. **Needs a client build and a site restart; the launcher pages ship
with the next launcher build.**

## 2026-09-23 — admin: parity with Movement and beyond

B: "Really clean up the admin panel. Bring it up to parity with ENW Movement, and even beyond." `/admin`
is rebuilt on Movement's operator console (`movement-client/src/pages/Admin.jsx`, `components/admin/*`,
`server/lib/adminLog.js`), plus the pages Zombies needs and Movement does not have.

**Shape (Movement's).** Header "ENW Zombies · Operator console / Administration" with live facts; one
pill tab bar with counts, **grouped** Operate · People · Content · Log (ours has twice Movement's tabs);
a to-do strip of clickable counts (at the door, reports open, key changed, no live playlists, flagged
results, boxes offline); all state in the URL (`?tab=`, `?user=`, `?filter=`, `?flag=`), old tab names
aliased. Movement's mapstaff `ConfirmDialog` guards **every** destructive action (Movement itself still
uses `window.confirm` in most places): Esc/backdrop closes, optional/required reason, a typed phrase for
the irreversible ones. Toasts after each action. One table component with search, sort and paging
(client-side, or server-side for People, Maps, Games). CSS: `pages/admin/admin.css`, all `.adm-*`,
global tokens only.

### Parity table

| Movement (tab / feature) | Ours | Notes |
|---|---|---|
| Now: health alerts, running servers, fleet, modes offline, replay gaps | **Now** (stats, boxes strip, latest log, lease a game, sweep) + **Boxes** | key-change alert is a banner on every tab |
| ServerLogPanel (roster here/was, chat, say) | **Boxes** lease rows: players with seat state, slot, CPU/RAM/uptime, Watch | no "say": the protocol has no site-to-game line per match |
| Log (lanes, search, actor, window, Load older) | **Log**, same, over `activity_log` | lanes boxes/people/moderation/records/content/other |
| audit(): 49 explicit calls | explicit `audit()` on every admin write **plus** `adminLog.guard()` catch-all (`admin.action`) | beyond: no staff write goes unlogged; secrets redacted |
| People: At the door (multi-select approve), Everyone | **People**: At the door (multi-select, approve pasted SteamID64s), Everyone (server search/filter/sort/paging), Active bans | the beta gate |
| PersonSheet: standing, holdings, bans/warnings, their log | **Person sheet**: approved/mod/admin/archivist/VIP toggles, rename (admin), ban/infraction with duration + reason, lift, games, badges, log | no self-demotion, last admin stays (server-side, Movement's rule) |
| Reports (Looking at it / Done / Dismiss, reply) | **Reports**, status chips, note, same answers | |
| Maps: reports, offline, review queue, MapPanel | **Maps**: catalogue (health chips + counts, hidden, sort, paging), health select, Hide, map of the week, row/playlist membership, guide count, our-box level | broken asks first (it refuses leases) |
| Records moderation (retire/unretire) | **Records**: replay grade, Verify vs pinned key, Void with reason, Watch | |
| Mode home: playlists + badges | **Playlists** (editor), **Rows** (home shelves), **Badges** (holders, award/revoke, new staff badge) | |
| — | **Games**: results filtered by referee flag (result_mismatch, instance_retired, …) with counts; summary JSON, DLL build, exe sha | Zombies-only |
| — | **Chat**: global channel incl. removed, search, origin, system lines, Remove/Restore | party/DM stay private |
| — | **Guides**: weakest first, Hide/Show/Delete (tombstone) | |
| — | **Release**: latest.yml (version, date, installer present + size match, sha512, bucket, earlier), DLL per box | Zombies-only |
| Videos (render/QC) | — | no equivalent |
| roles user/mod/admin/owner | mod / admin (+ archivist) | no owner tier |

### Zombies pages

* **Boxes** (admin): reads `boxes.last_status_json` (agent heartbeat), live `assignments`, `lib/seats.js`
  and `presence`. Per box: slots leased/max, agent reserve, protocol, connect address, key pin, last DLL
  build heard; Settings edits address, max games, reserve; Enable/Disable (confirm). Per lease: players
  and seat (in game / left / not joined / unknown), slot, CPU, RAM, uptime; **Retire** (cancel; the agent
  retires an unlisted lease on its next poll, host.md §13.2) and **Restart** (fresh lease for the same
  players, superseding theirs). **The guard is server-side** (`lib/adminBoxes.js`): while anybody is in,
  both answer 409 with their names until `confirm` = exactly those SteamIDs; the panel lists the names and
  wants "end it" typed. "In" = seat connected, or presence in that match < 90 s, or, for a `live` lease the
  site has no seat data on since it started, everybody leased (marked unknown). The old
  `POST /lease/:id/cancel` uses the same guard. Box creation stays in `tools/register-box.js` (secret).
* **Playlists**: list (order, Publish/Unpublish) + editor (name, blurb, hidden/live/scheduled with UTC time,
  drag or arrow order, remove, add by search, warnings for hidden/broken/not-on-our-box maps, Save/Revert,
  Delete with typed slug, admin only). New playlists start hidden.
* **Release**: `web/public/updates/latest.yml` (`ZM_UPDATES_DIR` overrides). The site is never told the
  DLL's sha256; shown: build stamp + exe sha the referee heard (last game's `summary.hashes`),
  `dll_sha256` if a future heartbeat sends it, and a **noted** deploy sha + commit (`settings` key
  `box_dll:<box>`).

### API added (`routes/admin.js`)

`GET /log`, `/log/counts` · `GET /users` · `POST /approve {steam_ids, approved}` · `GET /bans` ·
`GET /games`, `/games/:id` · `GET /chat`, `POST /chat/:id/remove|restore` · `GET /maps` ·
`GET/POST/PUT/DELETE /playlists` (keys validated, 409 on slug) · `GET /boxes/live` ·
`POST /boxes/:name/address` · `POST /leases/:matchId/retire|restart` · `GET /release`,
`POST /release/box/:name` · `GET /badges/:id/holders`. Existing paths kept; previously unlogged writes
(role, map edit, playlists, badges, report resolve, infraction, capacity, enable) now log.

**CLI to panel.** approve.js → People; lease-cli.js → Now (lease) + Boxes (retire/restart);
register-box `--address`/capacity → Boxes Settings. Stay CLI: register-box creation, wipe-demo,
adopt-account, seed/align names, import-movement-profiles, live-bridge/local-run.

### Seed the first playlists (coordinator)

Live DB has 0 playlists. `web/tools/seed-playlists.js`: additive, idempotent (existing slug left alone;
missing/broken/hidden keys skipped and named), `VACUUM INTO` backup before any write.

```
cd web
node tools/seed-playlists.js                   # dry run against web/data
node tools/seed-playlists.js --apply           # hidden; publish in Admin → Playlists
node tools/seed-playlists.js --apply --live    # or publish at once
```

Set (all maps load on our box): Stock (4), Community classics (8), Minecraft (2), Small and fast (8),
Big maps (8), Christmas (5). Proven on a copy: 6 created; second run "exists, left alone".

### Tests, proof

`test/admin.js` (in `npm test`, 23 checks): walks the router (61 routes all carry requireMod/Admin; all
401 anon and 403 player; the 28 admin-only 403 for a mod); gate, roles, bans, playlist CRUD and public
order, seed plan, map flags, chat, games by flag, release + DLL note (no secret in responses), the box
guard (409 naming who, wrong list refused, restart supersedes, unknown seats on a live game, presence),
the log (catch-all, filters, cursor, redaction). Full `npm test` green. Screenshots: headless Edge,
private profile, scratch port 3587, copy of the live DB with the seed applied and a simulated online
box-a with two leases: `tmp/admin-shots/admin-*.png` in the worktree (`admin-boxes-retire-who.png` is
the names dialog).

### Unproven

The real box (Boxes saw a simulated heartbeat only); retire/restart against zombies-dev; a moderator's
view (admin screens only); phone widths; the launcher window. Needs a client build and a site restart;
the seed is the coordinator's to run.

## 2026-09-23, early — profile/records/invites/chat dedupe

Four jobs, each compared against Movement (`C:\Users\b\Desktop\CSGO-Matchmaker`; the invites are on
**`origin/main`**. The local `main` there is 1,500 commits behind and does not have them).

### Chat: the duplicate lines on joining a game (root cause first)

B saw lines repeated in global chat when he joined a game. **The ring has no duplicate rows.** A
`VACUUM INTO` copy of the live DB shows every message once. The duplicates happened on the display
side, and three separate things caused them:

1. **The overlay's first poll replayed the ring.** `/api/game-chat/feed?g=0` answered with
   `chat.tail(20)`, and `chat_overlay.cpp` stamps each line with the moment it arrived
   (`line_from_json`, `l.arrived = GetTickCount()`). So on joining a game, the HUD showed the last
   five ring lines as if they had just been said. When B joined at 02:41, those five included two
   copies of `76561198000000001 started a game on nazi_zombie_fear_mc_2` from earlier games, with his
   own identical line under them. **Fix:** a first poll now returns the cursor and no lines. That is
   the box drain's rule (`routes/gameserver.js`, since=0). The cursor is taken *before* the wait, so a
   fresh client that waits gets exactly what was said after it asked. A client can still ask for the
   backlog with `&history=1`; every backlog line then carries `backfill: true`. The current DLL never
   asks, so its open window starts empty too. Showing history in the window but not on the HUD
   needs a DLL change (client lane).
2. **One game produced several system lines.** The live ring has `B's game … ended on round 1`,
   then `somebody's game on Nacht ended`, then `somebody's game on Unknown map ended`, all for one
   instance. The host resets its starter on the post-game `map_loaded`, and the teardown sends
   `game_over` again with nobody to name. A post-game restart also re-announced the same player's
   start. **Fix (`lib/chatSystem.js`):** started, joined and ended are said **once per match**, and
   an end with nobody to name is not said at all. The 20 s key now includes the match. Before, it did
   not, so two different games by the same player on the same map merged into one line.
3. **The web dock's merge.** The dock already deduped by id. But its fill *reset* the list, which
   dropped a live line that arrived before the backlog did, and a socket reconnect never caught up.
   **Fix:** `client/src/chatLines.js` is one merge, keyed and ordered by ring id and capped. The
   backlog, the socket, and a reconnect catch-up (`GET /api/chat?since=<newest id held>`, new) all go
   through it.

`test/chat-dedupe.js` reproduced all three first: **11 of 13 failed before the fix, 12/12 pass
after** (one check was merged). It is in `npm test`. One existing `run-all` check now uses a second
player for `joined`, because the player who started a match no longer also "joins" it.

### Records: Watch beside the row

Movement's `replay3d/WatchButton.jsx` is ported as `components/WatchButton.jsx` (`btn btn-sm
r3d-watch`; the CSS comes from Movement's theme.css and lives in `components/watch.css`). **It links
straight to `/replay/<match>`**, and the viewer route is unchanged (replay.md §7a). Movement's
button opens a modal and pushes `/watch/…`. Ours is already a route, so the button is a link, and
the browser's own right-click gives "copy link". The old flow went through the game page's "Watch in
3D". The button renders nothing when there is no replay. It appears in four places:

* `/records`
* the map page's boards (`MapPage.jsx`: one import and one `<td>`)
* the profile's Records, as Movement's `.rec-cell`, with the button beside the link rather than
  inside it
* the profile's best round

On the server, `records.rowsFor`, `hub` and `heldBy` now carry `match_id` and `replay`, which comes
from an `EXISTS` check on `replays`.

### Profile: Movement's, trimmed

* **Order:** Movement's head (banner and identity bar), then the rail, then **Most played /
  Recently played** (Movement's titles), then **Records**, then Overall, then the wall.
* **A stat with no value is hidden, not dashed.** This applies to the identity bar strip and to
  Overall. Kills, downs and revives stay hidden while the server sends null.
* **Removed as verbose, empty or duplicated:**
  * Overall's Time played, Records held and Member since (the bar and rail already show them)
  * the rail's Total time played
  * "No badges yet"
  * the empty tagline
  * the `—` durations
  * long empty-state and settings copy. Settings is now "Privacy", with "Played maps" and
    "Comments".

### Invites: Movement's party invites, on the zombies party row

Zombies already had invite by name or SteamID, decline, cancel and the rail card. What was missing,
and is now added (`lib/parties.js`, `routes/site.js`):

| | Movement | here |
|---|---|---|
| accept | `POST /api/party/invites/:id/accept` | same; used, expired and withdrawn invites are each refused by name |
| push | `invite_received`, `invite_withdrawn`, `party_updated{notice}` via `emitUser` | same names, to `user:<sid>` rooms (`parties.setEmitter`, `index.js`) |
| notices | declined, left, closed, withdrawn, removed, kicked | same, plus joined |
| party emptied | pending invitees told it closed | same |
| expiry | none | **30 min**, because an invite here also opens a friends-only or private lobby; re-inviting restarts the clock |
| link | none in movement-client (GOnext has custom-lobby join codes) | **invite link** `/party/<CODE>`: 8 characters from Movement's `codes.js` alphabet, in its own `link_code` column (not the public party code), leader can reset it, 20 lookups/min per account |

**Routes:**

* `POST /api/party/link` — any member; with no party yet, one is made from the stage
* `POST /api/party/link/reset` — leader only
* `GET /api/party/link/:code` — preview
* `POST /api/party/link/:code/join` — approved accounts only; full parties refuse

**Client:**

* **`components/InviteToasts.jsx`**, rendered by the rail provider on every page:
  * the invite toast shows who invited you, the map, size/4, time left, and Accept / Decline
  * notice lines
  * a Join card for `/party/<CODE>`, and for `/party/<id>` when an invite to that party is waiting.
    The launcher's `enw-zombies://party/<x>` opens exactly these paths, so **no launcher change was
    needed**.
* **The rail:** refreshes on the three events, accepts by invite id, and "Copy link" replaces the
  party code, which nothing could use.
* **Accept and link-Join go through the play gate.** In a browser they lead to `/download`, whose
  "Open in launcher" is `enw-zombies://party/<CODE>`.

`test/invites.js`: 15 checks over HTTP through the real router, in `npm test`.

### Tests and proof

`npm test` passes: run-all 144, local-run 41, sign-in 15, game-chat 19, bucket 12, map-align 10,
guides 12, chat-dedupe 12, invites 15. local-run was run with `ZM_TEST_PORT=34771`, because 33991
was held by another agent's process. The screenshots come from a private site on **3473** running a
`VACUUM INTO` copy of the live DB (jamie visiting, stew inviting). They are in
`C:\Users\b\Desktop\Zombies\tmp\profile-records-invites\`:

* `profile-myu-visitor.png`
* `records.png`
* `map-board-watch.png`
* `invite-toast.png`
* `invite-withdrawn-note.png`
* `invite-link-card.png`

### Unproven

* **The in-game half of the chat fix has not been seen in a game.** The server change removes the
  HUD replay whatever the DLL does, but nobody has joined a game since.
* Two browsers exchanging an invite through Steam sign-in. The proof used test sign-in on the copy.
* After a signed-out visitor signs in from the link card, they land on home, because `/auth/steam`
  has no return path.
* The Watch-to-viewer path on a map with no `.glb` export. The viewer handles it (replay.md §7e).

**Needs a client build and a site restart.** No live data was written.

## 2026-09-23, ~04:00–05:00 UK — bug 7: kills / downs / revives / score reach `game_players` (commit `872152b`)

**What the live DB said** (a read-only copy of `web/data/zombies.db`, never the file itself):
every real game has all-zero `game_players` rows — score, kills, headshots, downs, revives and
points_earned are 0 on all 17 rows (11 of B's, verified). B's `m_8a0a8e75` `summary_json.reported`
row has no score, downs or kills field at all.

**The cause is upstream** (referee.md §16): the DLL could not read the counters. The site had one
bug of its own on the path: `results.js` wrote `stats.<x>` in preference to `<x>`. A pre-fix host
put its raw fold in `stats` and the value reconciled with the game's own result at the top level,
so the reconciled value was thrown away.

**Changes:**
- `server/lib/results.js`: `game_players.kills/headshots/downs/revives` =
  **max(`stats.x`, `x`)**. Both are lower bounds on a monotonic counter, so the larger is right
  from either kind of host.
- `server/routes/replay.js` `buildTrack`: each player now carries a **`counters`** timeline
  `[[ms, kills, downs, revives, headshots], …]`, built from `stats` events and the snap fields a
  §16 DLL sends, with one entry per change. It is `null` for older files. `revive.by` is kept in
  the feed.
- `client/src/replay3d/ReplayViewer.jsx` Tab scoreboard:
  - uses `counters` when present, so kills are attributed per player even with company;
  - otherwise the old rules. The **Revives** column counts `revive.by` (revives given, like
    WaW's), falling back to `slot` for old sims.
  - Points already switch on by themselves, because `has_score` becomes true once a snap carries
    `score`.
- `server/lib/profile.js`: comment only. The "show a column once any real game has a non-zero
  value" rule turns Kills/Downs/Revives on by itself after the first real game on a §16 box.
- Tests (`test/run-all.js`, +2):
  - `game_players` takes the larger of `stats.x` and `x`;
  - the track's counters are one entry per change, keep the reviver, and are null for a
    pre-§16 file.
  
  **`npm test`: 145 / 41 / 15 / 19 / 12 / 10 / 12 passed, 0 failed** (no 33991 flake this time).

**End to end on real data** (`ZombiesDev\bug7\e2e.mjs`, scratch `ZM_DATA_DIR`): the real local-dedi
link transcript `bug7b` went through the real host `Referee` and then `results.ingest`. It gave
`game_players` `score 500, downs 2, points_earned 30`, and `profile.overallFor` returned
`recorded.downs true, downs 2`. Kills were **synthetic** (`--synthetic-kills 3`, clearly an
injected `stats` event) and gave `kills 3` with `recorded.kills true`.

**Needs:** a client build (`npm run build`) and a site restart for the viewer and route. The
writer change only matters once a host posts counters. Existing zero rows are not rewritten: the
games had no data to recover.

## 2026-09-23, ~05:30 UK: copy audit, 1,580 strings reviewed, 99 changed, before/after

B: "Do an audit over the entire site for any AI-looking over-explaining text and make sure
everything is as concisely worded as possible." Voice matched to ENW Movement: short, plain,
sentence case, British spelling, no hedging, no help text that restates its control, no prose
em-dashes, one line per state.

**Scope.** Every user-visible string in `web/client/src` (pages, components, admin, settings
data, replay viewer), `web/server` (routes, lib, middleware: errors, notices, chat system lines,
the sign-in problem pages) and `launcher/src/renderer` (shell, placeholder, password prompt).
Extracted with a throwaway script (JSX text, string literals with words, template literals),
then read file by file; multi-line JSX in the priority screens read directly. About 1,580
strings after dropping SQL, class names and SVG paths. Left alone on purpose: keys, ids, dvar
names, WaW's own menu labels, Movement's verbatim username verdicts, the host tool's replay
verdicts (`VALID — …`, shared with `infra/host-agent`), and `launcher/src/main` (another lane
owns the Steam boot-screen lines, which are already one line each). Em-dashes used as the
empty-value placeholder in tables stay.

**Already clean.** Most of the site: the name gate, `/download`, the party rail, invite toasts,
the map page, records, admin tables and confirms had been written in Movement's voice tonight.
Changes there are small.

**Counts.** 99 strings changed: launcher renderer 35, site client 44, server messages 20.
No text added. Two test assertions updated with their strings (`web/test/run-all.js`: the chat
"went down" line, the unpinned-key reason).

| # | Where | Before | After |
|---|---|---|---|
| 1 | launcher, setup | Keep ENW maps, saves, profiles and settings in that folder too — so plain Steam World at War never sees anything of ENW's, and ENW never writes to your own World at War data. / Keep ENW's game settings and logs in that folder. | Keep ENW maps, saves, profiles, settings and logs in that folder. |
| 2 | launcher, settings | Lets ENW's own copy of the game use 4 GB instead of 2 GB - the big custom maps (ORBiT, UGX Requiem) run out of memory without it. It is two bytes in the header … puts those bytes straight back. | Needed for ORBiT and UGX Requiem. Only changes ENW's copy of the game. |
| 3 | launcher, site down | Zombies lives on the site, so there is nothing to show until it is back. The launcher keeps checking when you press Try again (or Ctrl+R). | Zombies runs on the site. Try again, or press Ctrl+R. |
| 4 | launcher, password | One shared password, sent to you with the launcher. It is not your account password. | The beta password sent with the launcher. Not your Steam password. |
| 5 | launcher, password | That password was not accepted. | Wrong password. |
| 6 | launcher, installed | Press Play on a map. Nothing here needs doing. | Press Play on a map. |
| 7 | launcher, setup | What setting up will change | What this does |
| 8 | launcher, setup | Install the ENW client there as binkw32.dll, keeping the original beside it. | Install the ENW client there as binkw32.dll. The original is kept. |
| 9 | launcher, setup | You own World at War, but it is not installed / Install it through Steam. | World at War is not installed (body removed; the button says it) |
| 10 | launcher, setup | We could not find World at War | World at War not found |
| 11 | launcher, setup | It is somewhere else / Find it myself | Choose another folder / Choose folder |
| 12 | launcher, settings | Off by default: with it on the game is capped to your monitor's refresh rate. | Caps FPS to your refresh rate. |
| 13 | launcher, settings | Borderless uses the native size of that display and alt-tabs instantly. / Borderless always fills this display. | (removed) |
| 14 | launcher, settings | Records allow up to 250; the server enforces allowed values. | Records allow up to 250. |
| 15 | launcher, settings | WxH. Blank means the native size of the chosen display. | WxH. Blank for native. |
| 16 | launcher, deep link | That link opened the launcher, but it did not name a map or a party. | That link has no map or party. |
| 17 | launcher, updates | The update could not be checked. (…) | Update check failed: … |
| 18 | launcher, setup | Done, but something in your install changed. Check the log. | Done, but your install changed. Check the log. |
| 19 | /settings signed out | Sign in to keep your World at War settings on your account. They follow you to any PC you launch from. | Sign in to save your settings to your account. |
| 20 | /settings ENW | saved to your account and applied at your next launch. changes you make in the game's own menus come back here after you quit. | saved to your account, applied at next launch. in-game changes sync back when you quit. |
| 21 | /settings ENW | open this page in the ENW launcher to see the client here | open in the ENW launcher to see the client |
| 22 | /settings omitted | options_sound drives it through ui_outputConfig and engine-evaluated visibility expressions that were not decoded; … PCGamingWiki's documented way to break sound. | The game auto-detects it. Forcing it can break sound. |
| 23 | /settings omitted | Online options for Activision's own co-op and multiplayer. ENW games do not use them. | Not used in ENW games. |
| 24 | /settings maps | no maps downloaded yet. a map's Download button puts one here. | no maps downloaded. |
| 25 | /settings maps confirm | Remove X? 1.2 GB is freed. You can download it again. | Remove X? Frees 1.2 GB. |
| 26 | map page, rail card | Download tooltip: Download now, play later | (removed) |
| 27 | party rail | None of your friends are online. / Nobody else is online. | No friends online. / Nobody else online. |
| 28 | party rail | The server is kept for you for about N more minutes | Kept for N more min |
| 29 | profile comments | Nobody has posted on your profile yet. / No comments for X yet. | No comments yet. |
| 30 | profile comments | Post comment | Post |
| 31 | profile | Your banner is the one on your ENW Movement profile — change it there and it changes here | Your banner comes from ENW Movement |
| 32 | badges | You can pin 3. Unpin one to make room. | Max 3 pinned. |
| 33 | 404 | That page doesn't exist / Back to the home page | Page not found / Home |
| 34 | chat system | X just went down on round 30 on Verrückt | X went down on round 30 on Verrückt |
| 35 | sign-in page | Steam sent us back, but the answer did not check out. That is usually a sign-in that was left open too long, or Steam having a bad minute. | The sign-in was left open too long, or Steam had a problem. |
| 36 | sign-in page | The launcher opened this page more than fifteen minutes ago, so it stopped waiting. | The launcher stopped waiting after 15 minutes. |
| 37 | sign-in page | Steam did not sign you in, so nothing changed here. / … again when you are ready. | Nothing changed. / … again. |
| 38 | Local game notice | Stored as a Local game. It earns no badge, no record and no XP, and its replay is not record evidence. | Stored as a Local game. No badges, records or XP. |
| 39 | replay viewer | No world model for X yet — showing players and zombies over a grid at the floor they walked on. | No world model for X yet. Players and zombies only. |
| 40 | admin, box | It stops authenticating: no new leases, and its games cannot post results until it is enabled again. | No new leases, and its games cannot post results. |

Also changed, not in the table: the other admin confirms (restart, unknown seats, rename), the
replay grade reasons (`lib/replays.js`), the launcher-cancel refusal, the stock-map download
note, the replay scoreboard footnote, and every prose em-dash on those screens (tab titles,
`Live` heading, badge tooltips, launcher candidate cards) turned into `·` or `:`.

**Tests.** `web` `npm test`: all ten suites pass (144, 41, 15, 19, 12, 10, 12, 23, 12, 15).
`launcher` `node test/run-all.js`: 165 passed, 1 failed, the pre-existing "this checkout must
have a client DLL to ship" in a worktree; `waw-settings.js` 14/0, `modcompat.js` 6/0. Client
`vite build` clean.

**Needs a client build and a site restart; the launcher strings ship with the next launcher
release.** No live data was written.

## 2026-09-23 — admin Issues page (telemetry)

Lane T1 (telemetry) adds **Issues** to the console (Operate group, after Games): the crash/error/log
bundles from launchers, boxes and the site, flagged on arrival. Everything about the pipeline, the
routes and the flag rules is in [telemetry.md](telemetry.md) (§3 for `/api/admin/incidents…`).

* `pages/admin/Issues.jsx`: server-side table (time, who or box, kind, map, version, P1–P4, flag chips,
  size; sort on time/who/kind/severity/size; 50 a page). Filters: severity chips (multi), flag chips with
  counts from `facets`, kind/person/version/map selects, Unreviewed/Reviewed/All (default Unreviewed),
  search. Initial filters read from the URL (`?tab=issues&severity=1,2&reviewed=0`, also `flag`, `kind`,
  `who`, `version`, `map`, `q`, `incident=<id>` to open one).
* The sheet: summary, metadata (match id opens Games searched for it), each flag hit with count and
  collapsible excerpts, files, manifest; Download bundle, Copy AI brief, Mark reviewed / Reopen, the
  next-session bug line and a note (POST review). Esc closes (a person sheet on top closes first).
  Admins get "Build digest".
* `counts.incidents_p1` / `incidents_p2` (unreviewed, 30 days): tab badge, a to-do strip item and a Now
  stat, each opening Issues on unreviewed P1/P2. Games now also reads `?q=` from the URL.

## 2026-09-23, ~17:40–19:30 UK — friends across ENW, the live online list, party chat and DMs in the dock (lane SOC, branch `soc-friends`)

B: *"ENW friends need to carry over to ENW Zombies from the ENW main server, from Movement and from
drops. The whole system needs to be connected friends-wise. Every single user who's on ENW Zombies
right now should be able to see each other on the online list on the left, see if they're in a map,
invite them to parties and receive invites. Update instantly in the launcher."* The launcher half
(flash, chime, toast) is in `launcher.md` under the same date.

### Where ENW's friends actually live (checked read-only, 2026-09-23)

| Source | What is there | Imported |
|---|---|---|
| **ENW Movement** (`movement.enw.gg`, `matchmaker.db` on the web host) | `friendships` (requester/addressee/status), the table this site's own was copied from; **89 accepted pairs**. GOnext PvP already reads it read-only as its "main" DB (`pvp/server/shared.js`) | **yes** |
| **drops.ws** (`/var/www/csgo-server/database.db` → `/home/deploy/database.db`) | **no friend table** (every table listed; the only "friend" in its source is whether the Steam bot is on your Steam friends list). drops shares SteamID and the ENW username, not friends | nothing to import |
| **"The ENW main server"** | **Not identified with certainty.** Candidates checked: the enw.gg site (PHP + MySQL on shared hosting, vault `ENW.GG Website`) has no friends feature; the ENW Discord server has no friend list a bot can read. Both are identity (Steam sign-in, Discord link), not a friend graph. `questions.md` Q-soc-1 | nothing to import |

So the ENW friend graph **is** Movement's. Measured against the live accounts (read-only, counts only):
of **9** Zombies accounts, **7** have at least one Movement friend who is also here, **10** pairs in all;
this site has **0** accepted friendships of its own. Until this lane every rail here was friendless.

### The sync (`server/lib/friendSync.js`)

* **Transport**: the site on B's PC runs `ssh -o BatchMode=yes <host> "sqlite3 -readonly -bail -csv '<db>'"`
  with B's existing key and `~/.ssh/config` alias, and sends **one SELECT on stdin** (accepted pairs where
  both ends are Zombies accounts; the IN lists are built from validated 17-digit SteamIDs). `-readonly` is
  load-bearing: Movement's live DB runs `busy_timeout=0` and a plain open can write. Host and path are
  validated (a host can never be an ssh option; the path is a fixed character class). Only SteamID64s
  cross, both ways. Nothing on the Movement host is written, migrated, restarted or deployed.
* **When**: at start, every `ZM_FRIENDS_SYNC_MIN` (10) minutes, and when a socket arrives for an account
  that was not in the last sync's list (a first sign-in), 15 s floor. About 150 ssh logins a day.
* **Stored**: `friend_edges(a, b, source, synced_at)` (pair low-first, one row per source) and
  `friend_sync(source, tried_at, ok_at, edges, error, reason)`, additive `CREATE TABLE IF NOT EXISTS`,
  the only schema change. A successful sync **replaces** that source's rows, so an unfriend on Movement
  reaches us; a failed one keeps the last good rows and records the error.
* **Used**: `users.friendIds` = this site's accepted `friendships` ∪ `friend_edges`, so everything that
  asks "are these two friends" (the rail, friends-only lobbies, DMs, the Esc menu) gets both.
  `users.friendSources(a,b)` → `['zombies','movement']`. A friendship that exists only on Movement cannot
  be removed here ("You are friends on ENW Movement. Remove them there."); asking an imported friend is
  already `friends`.
* **Zombies-native requests** already existed (profile Add friend); they now push
  `friend_request_received` / `friend_request_accepted` / `friend_removed` (Movement's event names), and
  the rail has a **Friend requests** block with Accept / Decline (`GET /api/friends/requests`).
* **Admin**: `GET /api/admin/friend-sync` (sources, last ok, pairs, last error, and the places checked
  that hold no friend list), `POST /api/admin/friend-sync/run`.
* **Config** (`infra/site.env`, documented in `site.env.example`): `ZM_FRIENDS_MOVEMENT_SSH=webbox`,
  optional `ZM_FRIENDS_MOVEMENT_DB`, `ZM_FRIENDS_SYNC_MIN`. Unset = off (tests, other boxes).
  `ZM_FRIENDS_MOVEMENT_LOCAL=<file>` reads a local copy instead (the tests).
* **A cleaner follow-up for Movement's owner (not done, not ours):** a keyed, read-only
  `GET /internal/friends?ids=` on Movement returning accepted pairs among the given SteamIDs would
  replace the ssh read; Movement already has keyed internal reads (`routes/internal.js`).

### The online list

* **Everyone online, friends first.** `roster.forViewer` keeps Movement's rule (an approved account sees
  every player online; anyone else only friends) and now sorts friends first. The rail draws two
  blocks: **Friends online · n** then **Everyone else · n** (just **Online** when no friend is on).
  Each row: avatar, name, a `FRIEND` tag (hover: "Friends on ENW Movement"), a pip (green online, gold
  in a party, red in a game), one status line and the action (Invite +, Join a joinable lobby, Accept an
  invite waiting, or `in party` / `invited` / `in game`).
* **Status words** are the server's (`roster.statusOf`), the same in the rail, the Esc menu and the
  launcher: `Online` / `In launcher` / `In game on <map>, round N` / `In party on <map> (n/4)`. The round
  is the referee's live frame (`lib/live.js`), omitted when there is no fresh frame. `In launcher` comes
  from the socket handshake (`auth.client`, set when `window.enw` exists); a connected launcher socket
  counts as online even while its heartbeat is late (a hidden window).
* **Pushed, not polled.** `server/index.js` emits `online_changed` 150 ms after any socket connects or
  leaves, and once a second compares `presence.signature()` (who, from what, where, round) and emits
  when it moved, so parties, box rosters and rounds need not announce themselves. The rail refetches its
  own `/api/party/online` on the nudge (rows are per reader), coalesced; the 10 s poll became a 30 s
  safety net. Measured in `test/friends.js` against a real `index.js` + socket.io: **153–157 ms** from a
  second player's launcher socket connecting to the first player's `online_changed`.
* **Esc menu** (`routes/gamemenu.js`): the words come from `statusOf` ("In game on Der Riese, round 12",
  "In party on Verruckt (1/4)" instead of "In game: Der Riese" / "Lobby: …"); pip kinds unchanged; rows
  carry `friend`. `test/game-menu.js` updated and added to `npm test` (it was not in it).

### Party chat and DMs on the site (`ChatDock.jsx`)

The launcher chimes on a DM or a party line, so the site must show one and answer it. They are the
overlay's private ring (`lib/gameChat.js`, `chat_private`), not a new system: `GET/POST
/api/chat/private` (session; DMs to friends and party members only, the ring's 5 lines / 10 s) and the
existing `chat-private` socket event. The dock interleaves them with the global lines, tagged `[party]`
(gold) / `[dm]`; clicking a name on a private line starts a DM; a chip row over the input says where the
next line goes (All games / Party / @name ×). Private lines from others count toward the unread badge.

### Settings

`notifySound` ("Notification sound", ENW tab, group *notifications*, default on) in
`client/src/data/wawSettings.js` + `settingsLayout.js`, `users.GAME_KEYS`, `LAUNCHER_KEYS`; `INGAME`
policy `apply: false` (the launcher's chime, not the game's). `shared/settings/ingame-settings.json`
regenerated: the item is in the excluded list, no group reaches the game.

### Tests and proof

* `test/friends.js` **16/0** (in `npm test`): the ssh argv (`-readonly`, BatchMode; option injection and
  quoted paths refused), the SELECT, import of both-ends-ours accepted pairs only (pending and an
  outsider dropped; the stand-in DB's email column never read), the union, removal rules, unfriend
  reaching us, soft-fail, the rail order and words (`In launcher`, `In game on …, round 12`),
  friend-request pushes, `/api/friends/requests`, `/api/chat/private` (friend yes, stranger 400), the
  page-to-launcher mapping (`attentionEvents.js`), and part B on a real server: push latency, the row,
  a DM reaching the recipient's socket.
* Full `npm test` green: run-all 148, discord-env 3, local-run 41, launcher-signin 15, game-chat 19,
  bucket 12, map-align 12, guides 12, admin 23, chat-dedupe 12, invites 15, box-maps 12, record-notice 7,
  telemetry 40, replay-fx 16, replay-spectate 13, friends 16, game-menu 9.
* The real read, read-only, from B's PC through node's `execFile('ssh')` (Windows OpenSSH): the count
  query and the live-accounts overlap above.

### Unproven

* **The rail rendered in a browser** unless the addendum below says otherwise (memory rule: commit charge
  was 88–89%, above the 85% the rule allows for a build + headless browser). The JSX is
  syntax-checked with esbuild and the data it draws is tested.
* **The sync on the live site** until `infra/site.env` has `ZM_FRIENDS_MOVEMENT_SSH=webbox` and the
  keepalive loop is restarted (it reads site.env once). The ssh read itself is proven from this PC.
* Two real people seeing each other through Steam sign-in (the tests use the test login).

**Needs**: `npm run build` (client) + a site restart on B's word + the site.env line. No live data was
written; the only schema change is two new tables, created on the next start.
