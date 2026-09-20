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
npm run check                     # 40 in-process checks, a few seconds, no server needed
```

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
    routes/               auth · me · maps · players · site · admin · gameserver
    middleware/auth.js    req.me, and the two different guards (signed in vs may play)
  client/                 Vite + React 18 + react-router 6
  test/run-all.js         40 checks
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
| `lib/tokens.js`, `lib/siteKeys.js` | mirrors of `infra/host-agent/lib/*` | byte-compatible by test |

### Pages
`/` home · `/maps` · `/m/<map>` · `/archive` · `/records` · `/badges` + `/badges/<slug>` ·
`/playlists` + `/playlists/<slug>` · `/id/<who>` · `/creator/<name>` · `/game/<match>` ·
`/custom` · `/admin`.

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
| **Sign-in** | `routes/auth.js` | mock provider (default) + the real Steam OpenID path behind two env vars |
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

### Stubbed, with the seam in one place
| Thing | Where | What it does today | What it needs |
|---|---|---|---|
| **Steam OpenID** | `routes/auth.js` | a local-only mock sign-in page, refused entirely when `NODE_ENV=production` | `STEAM_API_KEY` + `ZM_PUBLIC_URL`, then `ZM_AUTH=steam`. The code path is written and uses `passport-steam` (an *optional* dependency, so a missing one does not stop the server) |
| **The ENW name (SSO)** | `lib/enw.js` `refreshName` | returns the cached value; falls back to the Steam persona | `ZM_ENW_BASE` + `ZM_ENW_TOKEN`, and the real path (`/internal/name?steamid=`) confirmed |
| **VIP** | `lib/enw.js` `refreshVip` | reads the cached column; `ZM_VIP_FORCE` and the admin toggle set it locally | the same two env vars and the real path |
| **Map art** | `maps.art` | null everywhere, so cards show the engine name instead of a broken image | the archive pipeline's media step (04) |
| **Replay download / 3D viewer** | `pages/Misc.jsx` | shows the pointer, the size and the evidence grade | R2, and the VIP viewer is a separate build |
| **Play Local / launcher** | map page button | says the launcher is not installed | the launcher agent's deep-link handler |
| **Map downloads** | map page link | says so | the archive workers + a Steam login gate |

### Not built
* OG/link-preview images and share cards (13 §2d).
* Creator claims beyond the page and the row (`creators` table exists, no claim flow).
* The archive pipeline's own surfaces beyond `/archive` (crawl status, link health — the
  `archive_sources` table is there and empty).
* Badge art. Every badge renders as a hexagon with the map's engine-name stem; `badges.art` takes a
  URL when there is one, and Movement's `src/badgeForge/` is the thing to port when there is art to
  make.
* Friend suggestions from Steam ("Find Steam friends on ENW") — needs the Steam API key.
* Session storage is express-session's default MemoryStore: fine for one process, **not fine behind
  more than one**. A SQLite session store is ten lines when it matters.

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

1. **Ask the host agent for `pub` + `key_id` in its status heartbeat** (one line in
   `reportStatus()`), and for `key_id` in the `replay` block of a result. Until then a box has to
   POST `/api/gs/key` once, and every replay is stored unpinned — which is safe but useless for
   grading records. This is written up in `questions.md`.
2. **Wire the launcher**: `/api/party` already returns the player's own invite token and the connect
   string once the box says ready. That is everything the launcher needs.
3. **Badge art.** The shelf and the directory are the two most visual pages and both are currently
   hexagons full of text.
4. **OG images** for `/m/<map>` and a run card, because the funnel is YouTube descriptions.
5. **A SQLite session store** before anything runs on more than one process.
6. **Map art and the archive pipeline's rows** — the tables are there and empty.

---

## 8. Rules I worked under

No cloud, no spending, no deploys, no pushes, no production data, no commits. `npm install` only,
from npm. Nothing here calls ENW, Steam, or anything else unless an env var is set, and none of
those env vars is set. `CSGO-Matchmaker` was read only — never modified, never run, and none of its
credentials or its database was touched.
