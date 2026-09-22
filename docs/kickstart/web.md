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
| `ZM_AUTH` | `mock` | `steam` switches to real Steam OpenID (needs the two below) |
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
