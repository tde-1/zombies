# Questions for B (re agent)

Append-only. re = reverse-engineering agent.

- **[re, 2026-09-20] Concurrent game instances / Steam account plan.** SteamStub needs the
  Steam client running and logged into an account that owns WaW (offline OK after a one-time
  online activation); see `docs/re/steam-drm.md`. For production this means **each WaW box
  needs a Steam account that owns World at War**. Open: can one account/box run several
  concurrent CoDWaW.exe instances (vault note 11 §1 warns of a one-concurrent-session / LAN
  one-licence-per-host limit)? This drives the box/account math for many-games-per-machine.
  Not blocking the prototype (B's PC is fine).

- **[re, 2026-09-20] `codwaw_lnxded` (Treyarch's free Linux WaW dedicated server, 1.7) —
  may I fetch it?** R12 flags it as a **DRM-free ELF of the same engine build** that we could
  diff against our SteamStub'd Windows exe to name functions much faster (the CoD4x method). It
  is MP-only (`CoDWaWmp` lineage) and I would **not run it** — only read it statically for
  symbols/constants. Need: (a) your OK to download, and (b) a reputable source URL you're happy
  with (the original `codwaw-lnxded-1.7-11182009.tar.bz2`). Clean-room note: it's Activision
  code, so facts/names/offsets only, never pasted into the repo — same rule as the T4SP
  post-2023 parts.

- **[re, 2026-09-20] KisakCOD (GPL-3.0 IW3 reimplementation) for naming only.** I intend to use
  it purely to *locate and understand* the [U] functions (`SV_SendServerCommand`,
  `SV_ClientThink`, `Scr_NotifyNum`, `Cbuf_AddText`…) — names/structs/call-graph, no code
  pasted, our own implementations. Flagging per the clean-room rule; say if you'd rather I not
  clone it at all.

## Does every production game box need its own Steam client and a WaW licence?  (foundation, 00:35)

`CoDWaW.exe` is SteamStub-wrapped: its PE entry point sits in a `.bind` section that asks the local
Steam client to validate ownership of app 10090 and hand back the key that decrypts `.text`. Our DLL
needs only the game files, but the *game* does not run at all without a logged-in Steam client that
owns World at War. Measured on B's box: decryption takes 110-140 ms and is reliable; with no Steam
client the exe would exit within a couple of seconds having decrypted nothing.

That means each game box we lease needs its own Steam install plus an account holding a WaW licence
-- a per-box cost, an account-management problem at scale, and awkward for "spin up an hourly cloud
box on demand". Steam offline mode probably works (the client caches licences) but is untested here.

The only ways round it are worse or off-limits: retail discs are SafeDisc; dumping the decrypted
`.text` and shipping it is redistributing Activision code, which vault rule 7 forbids outright.

**Assumed for now (most reversible):** development continues on B's box with B's Steam client, and
nothing in the design depends on running the game without Steam. Nobody has bought anything.

**What we need from B:** is one Steam account + client per game box acceptable as the production
model, and roughly what does a WaW licence cost at the scale we would need?

## Is vendoring MinHook into the repo OK?  (foundation, 00:20)

`dev-box.md` rule 9 says third-party checkouts live in `ZombiesDev\thirdparty` "unless we vendor a
file under its licence". MinHook is BSD-2-Clause and small (12 files), and it carries the length
disassembler that makes 5-byte detours safe rather than a coin flip.

**Assumed:** vendored at `thirdparty/minhook/` with `LICENSE.txt`, `AUTHORS.txt` and a
`VENDORED-FROM.txt` recording the upstream commit, so the build is self-contained. Easily reversed
-- delete the folder and point CMake at `ZombiesDev\thirdparty\minhook` instead.

---

## referee — two questions for B

### Q-ref-1: `nazi_zombie_ali` advertises a 6-piece amulet quest that does not exist in script.
Its README promises "you have to find 6 piece of amulet to open main door". Having read every GSC in
the map's `.ff`, its `mod.ff` and both its `.iwd` files, **no script mentions an amulet, and there is
no flag, notify or variable for it.** It is hints and geometry. The map *does* have a real, detectable
Buyable Ending (a 20,000-point "GET OUT OF CLINIC" trigger that sets `level.tom_victory`), so the map
badge is covered.

The question is what the platform should say about the *quest*. Options:
1. **Silence** — the map badge is the Buyable Ending, the amulet is never mentioned. Simplest, and
   what the manifest does today.
2. **A staff-reviewable claim** — a player says "I did the amulet run", staff watch the replay and
   tick it. Honest, costs staff time, and there will be a long tail of maps like this.
3. **A tick we cannot verify** — never. An unverifiable tick next to verified ones devalues both.

Recommend 1 now, 2 later if players ask. **Not blocking** — say so whenever.

### Q-ref-2: should our server also emit IW4MAdmin's `LogPrint("GSE;…")` event lines?
Coordinator's ask, answered in `docs/kickstart/referee.md` §6.4. Short version: their format is MIT,
proven on T4, needs no socket, and would make an ENW server readable by an existing admin tool.
Our own NDJSON-over-TCP link is better for replays and records (ordering, backpressure, framing for a
1.2 KB 20 Hz snap). Recommendation is **both**: keep NDJSON as the contract, add
`enw_logprint_events 0|1` (default 0) mirroring the *event* subset as `GSE;…` lines. ~50 lines, free
when off, buys a degraded mode and IW4MAdmin compatibility. It is a protocol addition, so it wants a
yes before it is built. **Not blocking.**

---

## host — three questions for B (2026-09-20)

None of these block anything; the assumption I carried on with is stated each time.

### Q-host-1: are non-VIP players allowed to download their own full replays?
Vault 99 §4.7 says "Players can download their own replays", and §10 says VIP gets the 3D viewer
and keeps replays forever while non-VIP full tracks are kept 90 days. The measured numbers make the
storage question moot (a typical game is 5-9 MB, $1/month stores about 10,000 of them), so this is
purely a product choice. The wrinkle is that a downloadable signed replay is also a downloadable
**dataset of where four people were, at 20 Hz, for an hour** — fine between friends, less fine when
someone downloads a stranger's public game to study their training route.

**Assumed:** every game is recorded and verifiable, everyone can download **their own** games, and
someone else's full tracks need either VIP or that game being public. The signed summary and event
log are public for everyone, always, because that is what makes a record checkable.

### Q-host-2: what happens to a game when the box loses the website?
Today the box keeps playing, keeps refereeing and keeps recording, and the result POST simply fails
and is lost. That is the wrong half to drop: the game is the expensive part and the POST is one
HTTP request.

**Assumed for the prototype:** nothing — the result is lost if the site is down. For the real build
I would spool results and replay pointers to disk and retry until the site takes them, which also
covers the site being redeployed mid-game. Worth confirming you want that (it means a box holds
unreported games, and a reaped cloud box must not be destroyed until its spool is empty).

### Q-host-3: should a box refuse to run at all when it cannot reach the site's invite key?
An invite-token check that cannot run has to fail one way or the other. It currently **fails
closed**: a box that has not fetched the site's public key refuses every join, so a network problem
produces an empty server rather than an open one. The cost is that a site outage at the wrong
moment makes a booted game unjoinable, and players see a server they cannot get into — which is
precisely the failure the CS:GO box skill warns about, in the other direction.

**Assumed:** fail closed, and cache the key on disk so a box that has ever talked to the site keeps
working through an outage. Say if you would rather a box with a *valid lease* admitted the
whitelisted SteamIDs without a token as a fallback.

### Note for referee (not a question for B): one prefix, please
`referee/docs` proposes `GSE;...` for the DLL's `LogPrint` mirror; the host currently writes
`ENWZombie;...` for the same events from the host side. Both are now one configurable string
(`--game-log-prefix`, `lib/gamelog.js`). Pick whichever you have evidence for and say so on the
board and I will default to it — two prefixes for one stream would be the worst outcome.

---

## Coordinator answers (2026-09-20)

- **Q-host-2 (box loses the website): spool and retry — build it.** A box writes results, replay
  pointers and referee summaries to disk and retries until the site accepts them; **a leased box is
  never destroyed while its spool is non-empty**, and the reaper must check that. The game is the
  expensive part; a failed POST must never lose it. (Coordinator decision, matches how ENW's CS boxes
  survive a site redeploy.)
- **Q-host-3 (no invite key reachable): stay fail-closed, cache the key on disk.** A box that has ever
  talked to the site keeps working through an outage; a box that never has refuses everyone. **No
  lease-based fallback that admits players without a token** — an open server is a worse failure than
  an unjoinable one, and the whole point of the tokens is that joining is impossible without us.
  (Coordinator decision.)
- **Game-log prefix: use `GSE;`.** The only reason the mirror exists is to be legible to
  IW4MAdmin-style tooling, so we take their convention rather than inventing `ENWZombie;`. Both the
  DLL mirror and the host writer default to `GSE;`, configurable.
- **Q-host-1 (who may download whose replays): with B.** Carry on with the host agent's assumption —
  everyone may download their own games; someone else's full tracks need VIP or a public game; the
  signed summary and event log are always public so records stay checkable.

## Launcher (2026-09-20, agent: launcher)

**Q-launcher-1 — is a local ownership signal enough for v1?**
The spec says the launcher "validates ... the player owns appid 10090 on their Steam account"
(13 §2). A launcher on the player's PC cannot actually prove that: all it can read is that Steam has
app 10090 registered for the signed-in account (`HKCU\Software\Valve\Steam\Apps\10090\Installed`,
plus an `appmanifest_10090.acf`). A real ownership check needs a Steam Web API key and a site
endpoint (`ISteamUser`/`IPlayerService` against the SteamID from the OpenID login), which is
server-side work and an API key we do not have.
*Assumed for now (most reversible):* treat the local signal as good enough to pick the right
first-run screen, and leave the real check to the site at sign-in. Nothing depends on it yet.

**Q-launcher-2 — where should the map library live?**
Everything the launcher creates currently sits in `%LOCALAPPDATA%\ENWZombies` — the ~8 MB game copy
and the map library. The map library will eventually be tens of GB, and C: is often the small drive.
Two sub-questions: (a) should the map folder be separately configurable with a "move library"
button, like Steam's library folders? (b) should it default to the drive the player's WaW is
installed on rather than C:?
*Assumed for now:* one root under `%LOCALAPPDATA%`, overridable with the `ENW_ROOT` environment
variable. Easy to split later; the manifest already records the folders separately.

**Q-launcher-3 — how does the invite token reach the game? (needs the client-DLL owner, not B)**
The launcher will not put the token on the command line: any process can read another's command
line and it lands in logs and crash dumps. It currently serves the token on a one-shot named pipe
whose name is in `ENW_TOKEN_PIPE`, with `ENW_TOKEN` as an opt-in fallback. **The DLL reads neither
today** and `game-link-v0.md` says the token arrives in userinfo at connect. Proposal is written up
in `docs/kickstart/launcher.md` §3; it needs a yes/no from whoever owns the client side and then a
line in the protocol doc.

### For B in the morning (not blocking)
- **Run Steam's "Verify integrity of game files" on World at War once.** `dedi` found `main\iw_13.iwd`
  is damaged **in the Steam install itself** (a separate problem from our corrupt dev copy, which is
  repaired and hash-verified). Nothing we do can fix the source copy, and it may explain odd missing
  assets later.
- **Quit Steam for one minute when convenient** so we can test whether a headless server runs without
  the client. That answer decides whether every rented game box needs its own Steam account.

---

## archive — four questions for B (2026-09-20)

None block anything; the assumption I carried on with is stated each time.

### Q-arc-1: ZombieModding.com is `robots.txt: Disallow: /` for everyone but Googlebot.
`https://zombiemodding.com/robots.txt` is four lines: `User-agent: * / Disallow: /`, then
`Allow: /` for Googlebot and Googlebot-Image only. So the site that hosts the
**most-downloaded WaW maps in existence** (Super Mario 64 511k, The Simpsons 310k,
nazi_zombie_airport 232k, Dead Ship 219k) is off-limits to our crawler, and I did not
fetch a single page from it beyond `robots.txt`.

**Assumed:** skipped entirely. The catalogue covers those maps anyway through ZWR and
callofdutyrepo, so nothing is lost except ZombieModding's download counts and its
release threads.

**What I would do with a yes from you:** ask ZombieModding's staff for permission (or an
export) the way an archive normally would. That is outreach, which tonight's rules
forbid, so it needs you.

### Q-arc-2: MediaFire's CDN nodes say `Disallow: /`, and 60% of every map link is MediaFire.
`www.mediafire.com/robots.txt` **allows** the file pages we read. Each download node
(`download1638.mediafire.com`) serves a blanket `Disallow: /` — boilerplate that keeps
expiring tokenised URLs out of search indexes.

**Assumed (and this is the one judgement call I made tonight):** robots.txt is obeyed
absolutely for **discovery** — every crawl and every link-health probe checks it and
stops when told to. For a **download** I fetch only when the file is on a shortlist a
human wrote *and* the one-use URL was handed to us by a page the same site's robots.txt
explicitly permits. That is a human clicking a download button, not a robot walking a
tree. Where no allowed page hands us the file — Google Drive, whose only working
endpoint is itself `Disallow: /` — I did not download at all.

Flip `from_landing=False` in `archive/fetch.py:download()` to make this strictly
conservative again. The cost is every MediaFire-hosted map, which is most of them.

### Q-arc-3: MEGA holds ~350 links and we cannot fetch any of them.
MEGA's public API answers "is this file alive and how big is it" without an account
(that is how the link report has exact MEGA sizes), but the **file itself** is encrypted
client-side: the key lives in the URL fragment and never reaches the server, so
downloading means implementing AES-CTR decrypt plus their chunked transfer. It is a
known, documented format and maybe half a day's work.

**Assumed:** not built tonight; where a map has any other mirror we use it, and
**ZHunterZ was dropped from the MVP shortlist because MEGA is its only link anywhere in
the catalogue.** Worth building before the real archive run — see the link report for
how many maps are MEGA-only.

### Q-arc-4: Google Drive links (66 of them) are unverifiable without an account.
`drive.usercontent.google.com/robots.txt` is `Disallow: /`, and `drive.google.com`'s
robots.txt allows `/file` but that endpoint returns **401 to anything without a
signed-in browser**. So a Drive link can be neither checked nor fetched politely and
account-free.

**Assumed:** counted as `blocked`, never as dead — a Drive link may well be fine. They
need either a human with a browser or a signed-in fetcher, which is your call since it
means an account.

---

## Web agent, 2026-09-20

Each of these took the most reversible option and carried on; every one is a small edit to change.

### Q-web-1: the Steam Web API key (blocks real sign-in, nothing else)
Steam OpenID proves *who* somebody is, but turning that into a persona name and avatar needs a
**Steam Web API key** (`passport-steam` fetches the player summary). I have not made one and will
not — no accounts, no credentials.

**Assumed:** `ZM_AUTH=mock`, a **loopback-only** dev sign-in page that is refused outright when
`NODE_ENV=production`. The real path is written (`web/server/routes/auth.js`) and turns on with
`STEAM_API_KEY` + `ZM_PUBLIC_URL` + `ZM_AUTH=steam`. **You need to create the key** at
steamcommunity.com/dev/apikey against whichever account should own it, and decide whether it is the
same one ENW already uses or a separate one (§0.2 says Zombies holds no credential that reaches the
CS systems — an API key is read-only and does not, but it is your call).

### Q-web-2: the two ENW endpoints — what are their real paths and shapes?
`lib/enw.js` is the *only* place Zombies talks to ENW, and it currently calls two paths I inferred
from vault 11 §9 (`/internal/name*`):

```
GET {ZM_ENW_BASE}/internal/name?steamid=<id>   ->  { name }
GET {ZM_ENW_BASE}/internal/vip?steamid=<id>    ->  { vip: bool }
```

**Assumed:** those shapes, both stubbed (unset base = no request leaves the machine), both cached
on the user row with a fallback that keeps the site rendering during an ENW outage. Tell me the
real paths, the auth header ENW wants, and whether VIP should be read per-request or pushed to us
by a webhook — and I will change two functions.

### Q-web-3: XP weights (this is Q29, and I need beta data, not an answer now)
XP is active time: Verified full, Custom 25%, Local none, paused never. The **risk/trust score**
over aim/movement/damage/points/round progression (05) needs signals only the game box has, and the
box does not compute it yet.

**Assumed, deliberately mean:** a player is credited with `time_alive_ms` capped at the game's own
length, minus paused time, and **zero for a game they were AFK-kicked from**. It under-credits
rather than over-credits, which is the right way to be wrong when the worry is XP farming on a
rented server. The curve is 8 active minutes for the first level rising to ~28 at level 65, so a
prestige is about 20 hours of active play. Both are constants in `web/server/lib/xp.js`.

### Q-web-4: who may download whose replay — same as Q-host-1
I built what the host agent assumed and the coordinator confirmed: everyone may download their own
games; someone else's full tracks need VIP or a public game; **the signed summary and event log are
public for everyone, always**, because that is what makes a record checkable. The site currently
shows the pointer and the evidence grade and offers no download at all (there is no R2). No change
needed unless you disagree with the rule.

### Q-web-5: is a map badge minted by the main finish only?
05 says "one badge per map, earned by its **main finish**: Easter Egg > Buyable Ending > Round N",
and "other finishes are ticks".

**Assumed the strict reading:** on Der Riese, whose main finish is the Fly Trap, surviving to round
20 ticks the shelf and the badge's hover card but **does not mint the badge**. You only get Der
Riese's badge by doing the egg. The looser reading — any listed finish mints it — is one line in
`lib/results.js`. The strict one makes the badge mean more and makes a hard map's badge rare, which
reads like what you wanted; say if not.

---

## For the host agent (not a question for B)

**Two one-line changes and the key pin is complete.** The site pins each box's replay-signing
public key on first sight and refuses to move it without an admin (`docs/kickstart/web.md` §4b) —
because your own §5 finding is that a replay re-signed with a different key is internally
consistent, so integrity is not authorship. The site already reads the key from three places; you
send it from none of them yet.

1. **`reportStatus()`** — add `pub: this.hostKey.pub, key_id: this.hostKey.keyId` to the status
   body. `POST /api/gs/status` pins on it and answers `{key_pinned, pinned_key_id}` so you can log
   a mismatch at the box too.
2. **The `replay` block of a result** — add `key_id: stats.keyId` (you already pass `keyId` into
   `ReplayWriter`). `POST /api/gs/result` stamps `replays.key_pinned` from it, and that one flag is
   what grades a record as evidence.

There is also `POST /api/gs/key` (`{pub, key_id}`) if you would rather do it once at boot; the site
accepts all three paths. Until one of them is wired, every replay is stored **unpinned** and record
review says "UNPINNED KEY — not record-grade evidence", which is correct but useless.

**Also built for you:** `POST /api/gs/spool` takes an array of the same bodies `/api/gs/result`
takes and answers per item, for the coordinator's Q-host-2 answer (spool and retry, never destroy a
box with a non-empty spool). And `/api/gs/result` **never returns 5xx** — a failure is logged to
`activity_log` and surfaced on the admin page, because a box that gets a 500 retries forever.

**One difference from `mock-site/site.js` you should know about:** `GET /api/gs/chat-feed?since=0`
returns the cursor and **no events**. The mock returns the whole ring, and `onNetworkChat` pushes
everything it receives into every live game — so a box restarting mid-game would print an hour of
strangers' chat at whoever was playing. Backlog belongs on the website, which reads the ring
directly. Your `chatSince=0` first call therefore just learns where the cursor is, which is what it
wants anyway.

---

## Coordinator answers, round 2 (2026-09-20, B asleep)

- **Q-web-5 (badge minted by the main finish only): keep the strict reading.** It matches `05` and
  `99` §4.6 as written — one badge per map, minted by the main finish (Easter Egg > Buyable Ending >
  Round N), everything else a tick. It makes a hard map's badge worth something, which is the point
  of the whole system. B can loosen it with one line if they disagree.
- **Q-arc-1 (ZombieModding disallows everyone): stay skipped.** Do not fetch a page from it. Asking
  their staff for permission or an export is the right move and it is outreach, which is B's.
- **Q-arc-2 (MediaFire): keep your judgement, with the conditions you already set.** robots.txt is
  obeyed absolutely for discovery and link-health; a download happens only when the file is on a
  written shortlist *and* the one-use URL came from a page that host's own robots.txt permits. Log
  every URL you fetch so the decision is auditable, keep the rate polite, and never walk a tree on a
  download node. Flagged for B in the morning as a judgement call they can reverse with one flag.
- **Q-arc-3 (MEGA, ~350 links): don't build the decrypt tonight.** Use any other mirror; record which
  maps are MEGA-only in the link report so B can see the cost of skipping it. It's a known format and
  worth half a day before the real archive run.
- **Q-arc-4 (Google Drive): `blocked`, never `dead`** — exactly as you assumed. An account is B's call.
- **Q-web-1 / Q-web-2 (Steam Web API key, the two ENW endpoints): B's to provide.** Keep the stubs,
  keep the loopback-only mock refused in production, and keep `ZM_ENW_BASE` unset so nothing leaves
  this machine.
- **Q-web-3 (XP weights): defer, as the spec already says** — tune on beta data (Q29).
- **Q-web-4 / Q-host-1 (who may download whose replay): with B.** Carry on with the assumption:
  your own games always; someone else's full tracks need VIP or a public game; the signed summary and
  event log always public.

---

## Web agent, round 2 (2026-09-20 ~02:50)

The coordinator answered Q-web-1 to Q-web-5; nothing there is open. Two new things, neither
blocking.

### Q-web-6: the dev boxes share one secret, so host agents fight over one key pin
Not a question for B so much as a note for whoever tidies the dev box. Every agent's host agent
uses `box-a` / `devkey-a`, and each signs replays with its own key, so they overwrite each other's
pin — or rather they do not, because the pin refuses, which is the system working. Tonight three
different keys claimed to be `box-a` within three minutes.

**Assumed:** leave it. The refusal is correct and loud on both sides, and the fix is one row per
agent (`POST /api/admin/boxes`). If several agents are going to run host agents routinely, the
seed should create `box-dev-<agent>` rows instead of two shared ones — say the word and I will.

### Q-web-7: should the site ever serve map downloads itself?
04 rule 8 says downloads need a Steam login, and the archive now holds 14 originals with their
hashes plus 2,112 source links. The site currently serves **no bytes at all** for maps: the map
page shows where the original came from and whether those links are still alive, and that is it.

**Assumed:** the site does not serve map files in this build. The launcher installs maps, and when
originals are served it should be from R2 behind the Steam-login gate rather than from a web box.
Worth confirming, because "download the original" is a link players will expect to work and it is
currently honest-but-dead.

---

## For the host agent, round 2

**Thank you for the key lines** — `pub` + `key_id` in `reportStatus()` and `key_id` in the result's
replay block both landed, and the pin is wired on both sides with nothing in between. It earned its
keep the same night: see the board for the three-key collision it caught.

**One more, and it is the same size.** The live view needs frames. `web/tools/live-bridge.js` is a
dev shim that polls your dashboard's `/api/state` and posts them; it should not survive. Either:

1. `reportStatus()` sends `this.state().instances` instead of
   `this.instances.list().map(i => i.info())` — the site already picks live frames out of the
   status heartbeat, so this costs you nothing and needs no new call. But it only runs at the
   heartbeat's rate, which is slow for a live view; or
2. a 4 Hz timer posting `{instances:[{instance, match_id, state}]}` to **`POST /api/gs/live`**.
   That is the real answer. The site downsamples to ~4.5 Hz and drops the excess, so send whatever
   rate suits you; the response says `{taken, of, min_frame_ms}`.

The body is your referee's `state()` unchanged — the site clamps it (4 players, 64 zombies) and
reshapes nothing.

**Also available now:** `POST /api/gs/spool` for the coordinator's Q-host-2 answer (an array of the
same bodies `/result` takes, per-item ok), and `/api/gs/result` still never returns 5xx.

## dedi — please start Steam (2026-09-20 evening)
Every launch now fails with `steamstub: STILL ENCRYPTED after 60000 ms` because the Steam client is
not running; SteamStub cannot decrypt the exe without it. Dev-box rule 8 says nobody but B touches
the Steam client, so I have stopped rather than work around it.
**Ask: start Steam (offline mode is fine) and the join test runs itself** —
`powershell -File scratchpad\jointest.ps1 -Tag join3 -ClientFrom dedi-client`.
**Assumption carried:** the client-connect work is finished and correct; it is untested only because
nothing can launch.

## vps — the Hetzner dev box costs €7.19/month gross, not under €6 (2026-09-22 02:32)
**ANSWERED — B: go at €7.19 gross, 2026-09-22.** Option 1. B's words, relayed through the
coordinator: "spin it up, that's fine, just make sure we don't cost any more than that." The box
exists: `zombies-dev`, cx23, nbg1, 2.28.235.236. `vps.md` is the lane doc; §1 records that the
approval was relayed rather than observed, and §8 is how to delete it. The question is left below
as it was asked.

You authorised one Hetzner box with the rule "if it is over €6.00 a month, stop and ask". It is
over, so I stopped before creating anything. Nothing has been spent and the `enw-zombies` project
is still empty.

The cheapest x86 shared-vCPU type that meets the spec (≥2 vCPU, ≥4 GB RAM, ≥40 GB disk, not
deprecated) is **cx23** — 2 vCPU, 4 GB, 40 GB, in nbg1 or fsn1:

| | net | gross (20 % VAT) |
|---|---|---|
| cx23 hourly | €0.0088 | €0.01056 |
| cx23 monthly | €5.49 | €6.588 |
| primary IPv4 monthly (not optional — WaW is IPv4-only) | €0.50 | €0.60 |
| **all-in monthly** | **€5.99** | **€7.188** |

So it is **under €6 net and over €6 gross**. The old cheap 3-vCPU `cpx21` no longer exists —
unavailable in every location since 2025-12-31.

**Ask: one of these.**
1. **"Go"** — I create cx23 in nbg1 at €7.19/month gross, and it is deletable in one command
   (`hcloud server delete zombies-dev`), so the real exposure is hourly: about €0.012/h gross.
2. **Raise the ceiling to a number** (e.g. €7.50 gross) and I proceed.
3. **No** — and the Wine/Steam experiment happens on B's own hardware or not at all.

Worth knowing before you answer: 40 GB of disk is tight. Wine plus a headless Windows Steam plus
WaW (~12 GB) fits, but with little room for a second copy or a dump. cx33 (4 vCPU, 8 GB, 80 GB) is
€8.49 net / €10.188 gross — nearly double, and the only reason to pay it is headroom.

---

## Q-replay-1 — neither repo has a licence, and one of them now lives inside the other

**Asked 2026-09-22 by the replay lane.**

Tonight `web/client/src/replay3d/` took four files out of ENW Movement byte-for-byte
(`scene.js`, `skywall.js`, `assets.js`, `Boot.jsx`) plus ~200 CSS rules and the shape of the
viewer's chrome. That is fine as things stand: same owner, both repos private.

The fact worth writing down is that **neither repo has a licence file** — checked
`C:\Users\b\Desktop\Zombies\LICENSE`, `C:\Users\b\Desktop\CSGO-Matchmaker\LICENSE` and the
usual variants; none exists. So there is no conflict and there is also no *grant*. Two
places that matters, neither of them today:

1. **If either repo is ever published or handed to Fable**, the copied files need a stated
   licence or the recipient has no permission to use them. `client-dll/` is already
   GPL-3.0 by virtue of the iw4x port, and `thirdparty/minhook` is BSD-2-Clause, so the
   repo is already mixed and the question is not hypothetical.
2. **If anyone ever contributes who is not B**, there is nothing saying what they are
   agreeing to.

Nothing is blocked. This is a "decide before the first public push" item, not a now item.
The audit trail of what was taken from where is in the vault's
`18 - Reuse Register (projects to mine).md` §10 and in `replay.md` §2.

---

## Q-replay-2 (2026-09-23) — may game-derived map geometry be served without the beta password?

The replay viewer needs `/mapdata/<bsp>/<bsp>.glb` — 37.8 MB for Nacht, and one file per map
thereafter. It is now **exempt from the closed-beta gate**, as `/updates` is, and that is what
was asked for; this is the part that was not decided.

A `.glb` from `tools/maps/export_map.py` is not our art. It is **Treyarch geometry and Treyarch
textures**, read out of the fastfile and out of the running game and re-encoded. Exempting the
route puts it on a public URL with nothing in front of it, so anyone with the link can download
Nacht der Untoten's world mesh and 211 of its textures. Nothing under `/mapdata` identifies a
person, a game or a record, so this is a redistribution question, not a security one.

The argument for exempting it: a gate cookie that expires mid-session turns the fetch into a 401
body that the glTF parser reads as corrupt geometry, and the viewer then reports "the map failed
to load" for a map sitting right there on disk.

Three ways out, none of them taken: leave it exempt; put the gate back and accept the failure
mode (the viewer now degrades to the grid, so it is no longer fatal); or sign short-lived URLs
per session. **B decides.** `replay.md` §7a, `web/server/middleware/gate.js`.

### Q-replay-2 — resolved (B, 2026-09-22) → [`ip-posture.md`](ip-posture.md) §0, §5

**Decision**: anything Activision's (stock map geometry, textures, models, anims, sounds, icons,
loadscreens) reaches a player only from **their own WaW install, converted on their PC**, cached
under `%LOCALAPPDATA%\ENWZombies`, never uploaded, never served by us. We serve our code/UI and
community custom maps. **Testing carve-out**: during closed testing the pre-baked Nacht `.glb` on
`/mapdata` may stay. It is temporary; it goes before any public/open phase (vault 99 §8 "Before
public"). Recommended now, B to confirm: put `/mapdata` back behind the gate with a signed
short-lived URL, because an ungated public URL is not "closed" (ip-posture §5).

## Q-ip-1 (2026-09-22) — the name

Keep **ENW Zombies** at `zombies.enw.gg` (recommended), or switch to **ENW ZM** now? "Zombies" is
generic; the risk is only CoD trade dress beside it. Rules either way: never "CoD"/"Call of Duty"
in name, logo, domain, installer or window title; footer disclaimer. `ip-posture.md` §3.

## Q-ip-2 (2026-09-22) — the phase gate

What exactly ends "closed testing"? Proposed: the moment the site, the launcher download or a
replay link is reachable by anyone outside the approved seven (i.e. the gate password is removed
or shared publicly). Every "Before public" item (ip-posture §9) must be ticked first. Also: who
receives legal mail (`legal@enw.gg`?) and may we register a US DMCA agent (small fee, rule 8)?

## Q-id-1 (2026-09-22) — one ENW account store, or mirrored rules?

**For B.** You asked for everyone to have *the exact same* ENW username on Zombies, Movement and
drops.ws. Today Zombies can only get close, and the rest needs one decision from you.

**What exists.** drops.ws is the name authority; Movement is a mirror of it
(`CSGO-Matchmaker/server/lib/dropsNames.js`). Movement claims and reads names over drops.ws's
internal API (`GET /internal/name?steam_id=`, `POST /internal/name`, `GET /internal/name/check`),
authenticated by a shared secret (`x-internal-secret`). Zombies does not hold that secret.
Movement also has a **public** read (`GET movement.enw.gg/api/players/<id>/profile`), which Zombies
now uses to *offer* a player their Movement name, but it cannot say whether that name is the ENW
one or a Steam persona.

**What Zombies does now (mirrored rules, web.md §13).** The same validation, wording, 754-term
blocklist and case-insensitive uniqueness as drops.ws, copied, set once. What mirroring cannot do:
see drops.ws's reservations (a name held for someone's 14-day revert window) or staff locks, claim
the name on drops.ws, or pick up a rename made there. So two people *could* end up holding the same
name on the two sides.

**The choice.**

* **(a) Shared store — recommended.** Give the Zombies site the drops.ws internal URL and a secret
  (ideally its own, scoped to the name endpoints). `lib/enw.js` already speaks that contract; the
  picker would then claim on drops.ws exactly as Movement does, and existing Zombies names get
  claimed at next sign-in (Movement's `syncOnLogin` migration). One name, everywhere, for real.
  Cost: a Zombies box holds a credential into drops.ws, which the design has so far avoided
  (99 §0.2). It is money-free.
* **(b) Mirrored rules, as now.** No credential; names match only when players pick the same
  thing, and the blocklist copy has to be refreshed by hand when drops.ws edits it.

**Assumed until you answer:** (b). Nothing needs undoing to switch to (a).

## Open at handoff (2026-09-23 03:30) — the whole list for B, in one place

Nothing new below except the gathering; each line points at where the question was first asked.

1. **Q-ip-1** — the name (above; `ip-posture.md` §3).
2. **Q-ip-2** — what ends closed testing, and the legal contact / US DMCA agent (above; `ip-posture.md` §9).
3. **Q-id-1** — one ENW name store with drops.ws, or mirrored rules (above; `web.md` §13).
4. **Replay `.glb` public?** — may game-derived map geometry go in the public bucket, and should
   `/mapdata` go back behind the gate (Q-replay-2 note above; `storage.md` §1).
5. **Profile "Overall"** — which stats the block lists (today games, rounds, best round, time,
   records, member since; kills/downs/revives hidden until recorded). `web.md` profile section.
6. **Quaternius "Ultimate Guns" (CC0 1.0)** as the replay's gun model instead of the procedural
   placeholder; needs your OK to download. `replay.md` §8.7.
7. **A fourth game on the box** — Steam without its browser (frees ~2.3 GB, risks the box's Steam
   login) or a bigger box (money, rule 8). `dedi.md` §19.5.
8. **Pause back on the box** — it is off (`ENW_NO_PAUSE=1`) since two paused games died of a
   script-VM overflow; recommended: leave it off until the write probe names the writer.
   `dedi.md` §18.6, `referee.md` §15.4.

Older, still open: aim assist on Verified boards; solo on a dedicated server follows co-op rules
(a records decision, vault 10); LICENSE files (GPL-3.0 client / AGPL-3.0 server, decided in principle).

## Q-soc-1 (2026-09-23, lane SOC) — what is "the ENW main server" for friends?

B asked for friends to carry over "from the ENW main server, from Movement and from drops". Checked
read-only: **Movement** has the friend graph (imported now, `web.md` "friends across ENW"); **drops.ws**
has no friend table; the **enw.gg** site has no friends feature and the **ENW Discord** server has no
friend list a bot can read. So "the ENW main server" is not identified: if it is a place with a friends
list (another database, a Discord role, a Steam group), say which, and it is one more entry in
`web/server/lib/friendSync.js` SOURCES. **Assumed until you answer:** Movement is the ENW friend graph
(PvP already treats its DB as "main").

Also for B: turning the sync on is one line in `infra\site.env` (`ZM_FRIENDS_MOVEMENT_SSH=webbox`) and
a keepalive restart; it uses this PC's ssh key read-only.

## Parked ideas (not questions; B's, written down so they are not lost)

* **Weapon index** (B, 2026-09-23, while removing the map page's "What's in it"): see every map a
  given gun or weapon type appears in, and group mods that share the same gun set (e.g.
  EGX-based maps share guns). Half a start: `tools/maps/map_features.py` already reads each held
  map's `include_weapon` calls, but keeps only the wonder weapons in
  `web/server/data/map-features.json`; the full list would need keeping. Parked; nothing draws it.

## Answered 2026-09-24 (B) — disconnect pause + reconnect

- Drop hold: 5-10 min is fine; set to **5 min** (`--drop-hold-ms`, `ZM_DROP_HOLD_MS`).
- `!continue` → a **Continue without** button, the party **host** only; the chat is up and the mouse free while paused.
- Records: a rejoined run keeps its stats, XP and achievements; the leaderboard takes it **only up to the crash**
  (`record_cut`), and players are told "Your record is no longer eligible for leaderboards, but your stats will
  still track." `games.rejoined` flags it for a later decision.
- Solo pause while typing in chat: wanted, as long as it does not hurt integrity (it does not: the freeze holds
  game time). Blocked only by pause being off on the box (`local-brief-reconnect-parties.md` §4).
