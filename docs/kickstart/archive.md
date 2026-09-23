# archive — crawler, link report and the MVP maps

> Agent: **archive**. Code in `archive/` (repo). Working data in `C:\Users\b\ZombiesDev\archive\`
> — map files and originals are never committed. Regenerate this file with
> `python archive/make_doc.py`; every figure below is generated from the reports, none typed by hand.

## The headline

**2276 distinct maps catalogued (1811 from the community sites),
2818 download links, and the first measurement of WaW custom-zombies link rot —
which `R3 - Map archive, legal and community` records as never having been measured.**

**Between 13.7% and 33.4% of community download links are already gone.**
Of the 1485 + 236 community links we could actually check, **13.7%
are dead**. A further 508 sit behind a Google or Microsoft sign-in we will not create
an account to pass, and if every one of those is dead too the figure is 33.4%. The truth
is somewhere in that band and the band itself is the finding: **a fifth of the scene's download
links can no longer be verified by anyone without an account.**

The per-host split matters more than the average, because it says what to mirror first:

| Host | Links | Dead |
|---|---:|---:|
| MediaFire | 1,116 | **1.4%** |
| MEGA | 608 | **35.4%** |
| OneDrive + Google Drive | 490 | unverifiable — sign-in wall |
| archive.org | 572 | 0% |

MediaFire has held up almost perfectly for fifteen years. **MEGA is where the archive is
actually dying**, and MEGA's `-16 EBLOCKED` (the uploader's account was terminated) is the
single most common cause of death in the whole catalogue.

- **1363 maps have at least one live link** — recoverable today.
  **74 maps have links and every one of them is dead.**
- **279.7 GB** of originals measured across 1362 maps (largest live mirror each), mean
  **210.3 MB** a map. That projects to **279.9 GB** for everything recoverable and
  **372.0 GB** for the whole community catalogue. The archive keeps the original *and* a
  normalised install (vault 04 rule 3), so roughly double it for the real storage bill —
  **about 0.6 TB**, the top of the vault's 0.2–0.6 TB estimate rather than the bottom.
- **107 maps have nothing but MEGA and Google Drive links.** Catalogued,
  plausibly alive, and out of this pipeline's reach until one of those two is solved.
- 813 catalogued maps have **no link recorded yet** — almost all of them
  callofdutyrepo posts whose per-map page was never fetched, because that host timed out on
  us at 02:40 and the crawler stopped, as it is supposed to. 387 of its 1,399 posts are done;
  the other 1,012 are the biggest single source of *more* links and are one resumable command
  away (`crawlers/codrepo.py --pass c --posts N`).

The pipeline then took **14 maps** end to end — fetched (6.1 GB), hashed,
AV-scanned, extracted without running a single installer, normalised to `mods/<bsp>/` and scanned
for a finish.

**What a full archive run needs next, in order:** a MEGA client-side decrypt (608 links, 35% of
them already dead, 94 maps have nothing else — this is the urgent one); ZombieModding's
permission or an export, since its `robots.txt` bans us and it hosts the most-downloaded maps in
the scene; a Drive/OneDrive-capable fetcher, which means an account and so is B's call; then the
remaining 1,012 callofdutyrepo posts and a boot-test pass on a dedicated server.

## 1. How the pipeline runs

```
crawlers/zwr.py          one page  -> ~950 maps, ~1,100 links
crawlers/codrepo.py      --pass a  list pages -> title/date/views
                         --pass b  tag pages  -> easter egg / buyable ending / top100
                         --pass c  post pages -> author, description, every download button
crawlers/ugx.py          board 29 index -> release threads: name, AUTHOR, real release date
crawlers/moddb.py        addons page 1 (the rest is robots-disallowed) + per-addon size/MD5
crawlers/archiveorg.py   search + /metadata/<id> -> exact sizes and hashes, no bytes moved

probe.py                 one-off recon: robots.txt + one index page per source, run
                         BEFORE writing a crawler so it is written against what the
                         site actually serves
fetch_ugx_threads.py     UGX release-post bodies for the shortlist only

check_links.py           per-host probes -> alive / dead / blocked / unknown + size
fixups.py                offline verdict corrections, each with its evidence (no traffic)
report.py [--md|--maps]  the link report
export.py                catalogue.json for the site

fetch.py --shortlist s.txt   quarantine download -> sha256 -> AV -> originals/<map>/ + sidecar
avscan.py                    re-scan stored originals (see section 6 — the first scanner lied)
extract.py                   7-Zip / innoextract -> mods/<bsp>/ + per-file hashes
stock_baseline.py            the flag/notify/entity names that are Treyarch's, not the map's
scan_maps.py                 referee/scan_map.py + baselines -> archive/manifests/<map>.json
evaluate.py                  score those verdicts against the community's own finish tags
install_map.py               junction a normalised map into an fs_homepath, ready to boot
make_doc.py                  regenerate this document
finish_run.sh                drain the remaining link checks, then regenerate everything
```

Politeness is in `lib/net.py` and is not optional: **one request at a time per host**, a 6 s delay
(or `robots.txt`'s `Crawl-delay`, whichever is longer), `robots.txt` checked before every fetch, an
honest user agent that says what we are, and a host that rate-limits or errors twice in a row is
**dropped for the rest of the run** rather than retried. Every response is cached on disk, so a
re-run of any crawler costs the sites nothing. The link checker runs one worker **per host** so
hosts proceed in parallel while each one still sees a single, slow, serial client.

Nothing was uploaded, no account was created, no CAPTCHA was answered, no payment was made, and no
installer was executed.

## 2. The link report

| Number | Value |
|---|---|
| Catalogue rows crawled | 3455 |
| Distinct maps (all sources) | **2276** |
| Distinct maps (community sites only) | **1811** |
| Download links catalogued (distinct URLs) | **2818** |
| Links alive | **2057** |
| Links dead | **236** |
| Links blocked (host will not answer a robot) | 508 |
| Links unknown | 3 |
| Links unchecked | 14 |
| **Link rot**, all sources (dead / [dead+alive]) | **10.3%** |
| **Link rot on the community sites**, of links we could check | **13.7%** |
| Same, if every sign-in-walled link is also dead (upper bound) | **33.4%** |
| &nbsp;&nbsp;rot at `archive.org` | 0.0% |
| &nbsp;&nbsp;rot at `mediafire.com` | 1.4% |
| &nbsp;&nbsp;rot at `mega.nz` | 35.4% |
| Maps whose only host is MEGA or Drive (catalogued, not fetchable by us) | 107 |
| Maps with at least one live link (**recoverable**) | **1363** |
| Maps whose every link is dead (**lost so far**) | **74** |
| Maps we could not decide | 26 |
| Maps with no download link at all | 813 |
| Maps with a measured size | 1362 |
| **Measured bytes** (largest live mirror per map) | **279.7 GB** |
| of which Drive-rounded | 0.0 B |
| Mean map size | 210.3 MB |
| Projected: every recoverable map | **279.9 GB** |
| Projected: the whole community catalogue | **372.0 GB** |

| Host | Links | Alive | Dead | Blocked | Unknown | Unchecked |
|---|---:|---:|---:|---:|---:|---:|
| mediafire.com | 1121 | 1092 | 15 | 3 | 0 | 11 |
| mega.nz | 609 | 393 | 215 | 0 | 0 | 1 |
| archive.org | 572 | 572 | 0 | 0 | 0 | 0 |
| onedrive.live.com | 396 | 0 | 0 | 396 | 0 | 0 |
| drive.google.com | 93 | 0 | 0 | 92 | 0 | 1 |
| downloads.gamefront.com | 10 | 0 | 0 | 10 | 0 | 0 |
| papy.cod-france.com | 5 | 0 | 5 | 0 | 0 | 0 |
| docs.google.com | 2 | 0 | 0 | 2 | 0 | 0 |
| 1drv.ms | 2 | 0 | 0 | 2 | 0 | 0 |
| moddb.com | 1 | 0 | 0 | 0 | 0 | 1 |
| dropbox.com | 1 | 0 | 0 | 1 | 0 | 0 |
| download855.mediafire.com | 1 | 0 | 1 | 0 | 0 | 0 |
| download1971.mediafire.com | 1 | 0 | 0 | 0 | 1 | 0 |
| download1655.mediafire.com | 1 | 0 | 0 | 1 | 0 | 0 |

### What each source gave us

Rows crawled per source: codrepo 1399 · zwr 936 · ugx 605 · archive.org 496 · moddb 19.

| Source | What it is good for | What it cost | Catch |
|---|---|---|---|
| **ZWR** (`zwr.gg`) | ~950 maps and ~1,100 links **in one HTTP request**, plus an explicit "No Download Link available" marker on 51 rows | 1 request | Names only — no author, no date, no description |
| **callofdutyrepo** | The finish tags the whole badge model needs, plus author, description, release date, view counts | 21 list pages + 11 tag pages + 387 of its 1,399 per-map posts | **It timed out on us at 02:40 and the crawler stopped**, so 1,012 posts (and their download links) are still to do. Its own "Direct Download" mirror is one OneDrive account whose legacy links no longer resolve (see below) |
| **UGX-Mods** board 29 | The **author** and the **real release date** — the thread's poster and post time, not a repo's re-upload date | 35 index pages | The Map Manager's catalogue is inside the app, not on the site |
| **ModDB** | Self-hosted files that do not rot, with size and MD5 published | 1 page | `robots.txt` disallows `/*?`, so **pagination is off-limits**: one page of 30, not the whole section |
| **archive.org** | Exact byte sizes and hashes from `/metadata/<id>` — **the size question answered with zero bytes transferred** | ~60 requests | Its items are file dumps, so its "maps" are filenames, not releases |
| **ZombieModding** | — | 1 request (`robots.txt`) | **`Disallow: /` for everyone but Googlebot.** Not crawled at all. See Q-arc-1 |

Community finish tags recovered: buyable_ending 245 · challenge 105 · top100 100 · top_100 100 · easter_egg 97 · ugx_mod 34 · ugx_modded 34 · t4m_req 32 · christmas_map 21 · moddb 19 · prefab 15 · leaderboard 9 · bossfight_ending 8 · multiplayer_map 2 · bo3_buyable_ending 1 · singleplayer_map 1 · weapon_skin 1.

### The three link verdicts that are not "alive" or "dead"

Counting a link we cannot see as dead would inflate the rot figure with fiction, so:

- **Google Drive** (95 links).
  `drive.usercontent.google.com/robots.txt` is `Disallow: /`, and `drive.google.com` allows `/file`
  but that endpoint returns **401 to anything without a signed-in browser**. Unverifiable politely
  and account-free. Recorded `blocked`.
- **OneDrive.** Every one of callofdutyrepo's OneDrive mirrors answers 404 to a HEAD and redirects a
  GET to `login.live.com`: Microsoft retired the `?cid=…&resid=…&authkey=…` URL shape. The files may
  well still exist. Recorded `blocked` — the first version of the checker called all 398
  of them dead, which would have put a couple of hundred imaginary corpses in the headline number.
- **GameFront.** Serves a bot "Security Check" page (HTTP 403). No CAPTCHA was attempted. The ten
  links also carry `expires=1586…` signatures from April 2020, so they are dead in practice too.

**107 maps have nothing but MEGA and Google Drive links** — catalogued, plausibly
alive, and beyond this pipeline's reach until one of those two is solved.

## 3. The MVP maps

14 of 15 attempted came through clean; 14 of
14 extracted with a usable `mods/` tree.

| Map | Original | Size | Installer | mods/ | bsp | Scanner verdict | Community tag | Match |
|---|---|---|---:|---|---|---|---|---|
| Abandoned School | `Abandoned_School.exe` | 519.1 MB | nsis | `nazi_zombie_school` | `nazi_zombie_school` | easter_egg | easter_egg,buyable_ending | agree |
| Alcatraz | `Alcatraz.exe` | 953.1 MB | nsis | `water` | `water` | easter_egg | easter_egg,buyable_ending,bossfight_ending | agree |
| BO2 Hijacked Zombies | `BO2_Hijacked_Zombies_v1.1.exe` | 189.2 MB | nsis | `nazi_zombie_hijacked` | `nazi_zombie_hijacked` | buyable_ending | buyable_ending | agree |
| City of Hell | `City_of_Hell_zm.rar` | 259.5 MB | rar | `nazi_zombie_dt2` | `nazi_zombie_dt2` | easter_egg | easter_egg,buyable_ending | agree |
| Clinic of Evil | `_clinic_of_evil_by_IZaRTaX_05_11_2018.rar` | 443.4 MB | rar | `sanatorium` | `sanatorium` | round | easter_egg,buyable_ending | missed-silently |
| Der Berg | `Derberg.exe` | 515.8 MB | nsis | `nazi_zombie_derberg` | `nazi_zombie_derberg` | buyable_ending | - | untagged |
| Zombie Desert | `Zombie_Desert.exe` | 292.5 MB | nsis | `nazi_zombie_test1` | `nazi_zombie_test1` | buyable_ending | buyable_ending | agree |
| Leviathan | `nazi_zombie_leviathan_v1.2.exe` | 432.1 MB | nsis | `nazi_zombie_leviathan` | `nazi_zombie_leviathan` | easter_egg | easter_egg,buyable_ending | agree |
| Minecraft Village Remastered | `minecraft_village.exe` | 592.9 MB | nsis | `nazi_zombie_fear_mc_2` | `nazi_zombie_fear_mc_2` | easter_egg | easter_egg,buyable_ending,bossfight_ending | agree |
| MW2 Rust Zombies | `MW2RustZombies_1.0.exe` | 294.3 MB | nsis | `mw2rust` | `mw2rust` | buyable_ending | buyable_ending | agree |
| OCTAGONAL ASCENSION | `nazi_zombie_octogonal_1.3.0.exe` | 395.7 MB | nsis | `nazi_zombie_octogonal` | `nazi_zombie_octogonal` | buyable_ending | - | untagged |
| Orbit | `ORBiT_v1.2.exe` | 455.8 MB | nsis | `nazi_zombie_orbit` | `nazi_zombie_orbit` | round | easter_egg,buyable_ending | missed-silently |
| Project Viking | `Project_Viking_Final.exe` | 504.1 MB | nsis | `nazi_zombie_test` | `nazi_zombie_test` | easter_egg | easter_egg,bossfight_ending | agree |
| UGX Requiem | `ugx_requiem.exe` | 390.5 MB | nsis | `ugx_artemovsk` | `ugx_artemovsk` | easter_egg | easter_egg,buyable_ending | agree |

Per map we keep, beside each other and never mixed up:

- `originals/<map>/<file>` — the exact released file, byte for byte, plus `<file>.meta.json` with
  its **sha256, size, the page it came from, the URL, the fetch time, our user agent and the AV
  result**. Rule 1 of the archive.
- `extract/<map>/` — 7-Zip's output exactly as it landed, including the installer's own junk
  and anything that sits *outside* the mod folder. Readmes live here (vault 04 rule 4 keeps
  them as shipped): only one of the fourteen ships one, Clinic of Evil's `readme.txt`. Thirteen
  NSIS installers carry their text in the installer UI instead, which the extractor does not
  recover — a gap worth closing, since rule 14 makes the release post and readme the map's
  description on its page.
- `mods/<bsp>/` — the normalised install, every file hashed.
- `archive/manifests/<bsp>.json` — a proposed referee manifest in the `referee/manifests/_schema.md`
  shape, carrying the scanner's evidence and its provenance.

**To boot one** (`dedi`, `referee` — this is the bit you want):

```
python archive/install_map.py --list
python archive/install_map.py --homepath C:\Users\b\ZombiesDev\homes\<you> --all
CoDWaW.exe +set fs_homepath C:\Users\b\ZombiesDev\homes\<you> +set fs_game mods/<bsp> +map <bsp>
```

`install_map.py` makes a **directory junction** per map, so fourteen 500 MB installs cost one
filesystem entry each and deleting the junction leaves the archive untouched. All fourteen are
already junctioned into `C:\Users\b\ZombiesDev\homes\archive\mods\`. **The bsp is usually not the
map's title** — Alcatraz is `water`, Zombie Desert is `nazi_zombie_test1`, Clinic of Evil is
`sanatorium`, UGX Requiem is `ugx_artemovsk` — so read the table above before typing a `+map`.

**Substitutions from the shortlist in the brief, and why:**

- **ZHunterZ dropped.** Its only catalogued link, anywhere, is MEGA — and MEGA needs a client-side
  decrypt we have not built (Q-arc-3). Replaced by **Alcatraz**, **Minecraft Village Remastered**
  and **Abandoned School**: all three are tagged Easter Egg *and* Buyable Ending on callofdutyrepo
  and all three have a live MediaFire mirror, so they exercise more of the referee than ZHunterZ
  would have.
- **Project Viking nearly failed the same way.** ZWR and UGX both list only a Google Drive link, and
  that file is gone. callofdutyrepo had a live MediaFire mirror. This is the whole argument for
  crawling several catalogues rather than the biggest one.

## 4. The scanner on real custom maps

This is the number the plan rests on, and the referee agent could only test it on n=1.
It changed twice tonight, so here is the whole sequence.

**01:50 — `referee/scan_map.py` as it stood: 0 of 14 decided, and 1 of 12 agreeing with
the community's own finish tags.**

Not a bug in the tool — a gap in what it had ever seen. On a stock install the common
zombie scripts live in `common.ff` and `patch.ff`, which the scanner is never handed; it
only gets `nazi_zombie_factory.ff`. A **custom** map ships its own copy of that whole
script set inside `mod.ff`, so Treyarch's own names — `arcademode_ending_complete`,
`dog_round_ending`, `ee_bowie_bear` — suddenly appear *inside the map* and the hint lists
fire on them. Twelve of fourteen maps returned `manual` for the same three words, and both
`easter_egg` verdicts were Der Riese's teddy bears.

**02:20 — two fixes went on the board**, with the evidence:

1. **Subtract a baseline of names that are not the map's.** `archive/stock_baseline.py`
   reads every flag, notify and entity name out of WaW's own zone files
   (2408 names) into `archive/stock-baseline.json`. On top of that, any name
   shared by ≥60% of the corpus is community boilerplate rather than evidence — that
   catches `crawler_round_ending`, which is not Treyarch's but rides in on the community
   script set half the scene builds on. (42 names met that bar here.)
2. **Read the Radiant entity list, not just the scripts.** This was the real finding.
   **Leviathan has no easter-egg flag in any of its 120 scripts** — its quest is
   `ee_step_1_switch`, `ee_step_3_trig`, `ee_testtube_activate_trig`, in plain sight in
   MapEnts. **MW2 Rust has four trigger targetnames and one of them is `end_game`** — the
   `nazi_zombie_ali` shape, invisible to the `zombie_cost` outlier test because the price
   is hardcoded in script. That test fired on **0 of 14** maps. And entity names need
   **token** matching, not substring: `vending_mulekick` contains "ending",
   `floor_three_zone` contains "ee_".

**02:25 — the referee agent rewrote `scan_map.py` to do both**, reading the baseline this
agent generates and taking an `ignore` set for corpus boilerplate, plus a
`cost = <4-6 digits>` script scan for the hardcoded prices. `archive/scan_maps.py` no
longer duplicates any of that: it builds the two inputs, calls their
`scan_map.corpus_common()`, and measures the result.

**Now, on the same 14 maps: 12 of 14 have a finish identified,
and 7 of 14 need no human judgement to award a badge.** Verdicts:
easter_egg 7, buyable_ending 5, round 2.

The accuracy check that matters is not "did it decide" but "did it decide *right*", so
`evaluate.py` scores every verdict against callofdutyrepo's own Easter-egg and
Buyable-ending tag lists — an independent, human-made label for the same maps:

| | 01:50, as it stood | now |
|---|---|---|
| Agreed with the community tag | 1 / 12 | **10 / 12** |
| Silently defaulted to Round 20 | 7 | 2 |

### The same string means everything or nothing, depending on where it was found

The `end_game` name is worth its own section, because checking it by hand produced the
sharpest result of the night:

| | `trigger_use` named `end_game` | `notify("end_game")` in a script |
|---|---|---|
| MW2 Rust, BO2 Hijacked, Zombie Desert, Octagonal Ascension | **yes** | yes |
| the other ten, incl. Minecraft Village, Leviathan, ORBiT, Clinic of Evil | no | **yes** |

`notify("end_game")` is in **14 of 14** maps — it is a line in the shared community
`_zombiemode.gsc` that nearly every custom map ships, and it means nothing. The **entity**
is in 4 of 14, has **no `zombie_cost` key at all**, and is the real buyable ending every
time; `nazi_zombie_ali` makes five. So a name's **source has to travel with it**: a
targetname on a `trigger_use` is evidence, the identical string inside a script is
furniture. Flags, notifies and entity names are still unioned before the hint test, which
throws that distinction away — it briefly made Minecraft Village a `buyable_ending` on
nothing but that notify. It is the last structural thing wrong with the heuristic.

*Measured against `referee/scan_map.py` sha256 `c7fa04e14b91` (2026-09-20T02:31:00); that file
was being improved while this ran, so every run records which version it scored.*

### Where a human is still needed

- **Every Easter Egg.** The scanner finds the state; *which combination means done* is a
  judgement the manifest schema says must never be automated. Those manifests carry
  `{"manual": true}` plus the candidate names, so the human reads six entity names rather
  than 120 scripts.
- **The two silent misses.** ORBiT and Clinic of Evil both have a finish the community
  documents and nothing in their scripts or entities names it. For exactly this case every
  manifest now carries `scanner.map_specific_triggers` — the triggers no other map in the
  corpus has. ORBiT's are `keycards`, `orbitron_lock`, `orbitron_switch`, `planet1trig`,
  `nekrogun`, `welderreward`: twenty seconds of reading instead of 199 scripts.
- **Every buyable ending, before it awards a badge.**
  `{"trigger_used": {"targetname": "end_game"}}` is decidable from the event stream, but
  "this trigger is the ending" stays an inference until a game is played.

**One caution for `referee`:** `teleport` is in the new `END_TOKENS`, and Der Berg is now
called a buyable ending on `teleport_left_lf` / `teleport_left_single_zone`. Teleporters
are ordinary furniture in these maps. It is untagged so this run cannot score it, but that
token looks like the next false positive.

## 5. What the pipeline still cannot do

| Gap | Size of it | Fix |
|---|---|---|
| **MEGA downloads** | 609 links, 94 maps have nothing else | Client-side AES-CTR decrypt with the key from the URL fragment. The *health and size* probe already works (MEGA's public API answers without an account), so only the download is missing. Half a day. |
| **Google Drive, at all** | 95 links | Needs a signed-in browser. B's call, because it means an account. |
| **OneDrive legacy links** | 398 links | Microsoft retired the URL shape. Possibly recoverable via the modern share-link API; more likely these want re-hosting from another mirror. |
| **ZombieModding** | the most-downloaded maps in the scene | `robots.txt` forbids it. Needs permission or an export — outreach, which needs B. |
| **ModDB beyond page 1** | ~30 of maybe 900 addons catalogued | `robots.txt` disallows `/*?`. Needs their API or permission. |
| **Boot-testing a map** | 0 of 14 | The pipeline stops at "extracted and scanned". `health` in every manifest is therefore unset: nothing here has been proved to *run*, let alone to survive a mid-game join. That is the dedi agent's lock to take. |
| **Version handling** | untested | Vault 04 rule 13 wants every version kept with the latest as default. We fetch one file per map; the data model (originals keyed by map, sidecar per file) supports more, the tooling does not pick between them yet. |
| **Cross-source name matching** | at least one known miss | "Octagonal Ascension" (ZWR) and "Octogonal Ascension" (callofdutyrepo) are the same map and do not merge, so that map's finish tags never reached its manifest. Normalisation is exact-match after stripping versions; it needs a fuzzy pass with a human confirming merges. |
| **Multi-map bundles** | not yet seen | ZWR lists six "Custom Map Packs". `extract.py` handles several mod folders in one archive, but nothing splits a bundle into separate catalogue entries. |

## 6. What broke

Everything here was found by the pipeline failing, and each fix is in the code with the measurement
that prompted it.

1. **The AV scan was lying.** `MpCmdRun.exe -Scan -ScanType 3 -File <path>` prints
   "Scan starting… Scan finished… **was skipped**" and exits **0** when not elevated. The first
   version read exit 0 as clean and recorded fourteen unscanned files as scanned.
   `Start-MpScan -ScanType CustomScan -ScanPath` does run unelevated; the verdict now comes from
   Defender's detection list, and a scan that cannot be proven to have happened says so.
   All 14 originals: **clean**, engine 1.459.293.0.
2. **Name normalisation merged 51 distinct maps.** Stripping every number as a "version" turned
   "6 Feet Under" into "feetunder" and "37: A Zombie Christmas Story" into "achristmasstory". Bare
   integers are part of a map's name; only `v1.2`-shaped tokens are versions.
3. **Requests decodes HTML as ISO-8859-1** when there is no charset header, which mangles the curly
   apostrophes these forums are full of. The cache now stores raw bytes and decodes header charset →
   `<meta charset>` → utf-8 → cp1252.
4. **MediaFire still serves `http://` direct links** on some file pages. A regex requiring `https://`
   silently turned "alive" into "cannot resolve" for a third of the shortlist.
5. **Picking a download from the first source that had one** cost Project Viking: ZWR's only link is
   a dead Drive file and callofdutyrepo's live MediaFire mirror was never considered. Candidates are
   now ranked across every source at once, fetchability first — an "alive" MEGA link we cannot
   decrypt is worse than an unchecked MediaFire one we can.
6. **The installer's payload folder is not the map name.** Naming the normalised install after the
   first `.ff`/`.iwd` produced `mods/buried` for MW2 Rust (it ships a perks pack called `buried.iwd`)
   and `mods/fastcompile` for UGX Requiem. The map is the fastfile with a `_load.ff` **and** a
   `_patch.ff` beside it; the mod folder is whatever the installer called it, and we rename to the
   bsp so `fs_game mods/<bsp>` is predictable.
7. **A `.rar` that contains the installer.** Clinic of Evil and City of Hell ship as archives holding
   `Clinic Of Evil.exe` and a readme. One level of recursive extraction, still never executing
   anything.
8. **SQLite across threads.** The per-host workers share one connection; it needs
   `check_same_thread=False` and a lock around every write.
9. **Two of our own processes briefly hit the same host at once.** A second
   `codrepo.py` was started while the first was still running, and the two made four
   simultaneous requests to the same small WordPress site before it was killed. The
   in-process lock only keeps *threads* apart, and this repo runs several of these tools
   at once overnight. `lib/net.py` now takes a **cross-process lockfile per host**: a
   second process that touches a host someone else has claimed is dropped for that host
   rather than doubling up, and a lock from a dead process is taken over.
10. **The link checker and the fetcher both wanted MediaFire.** Same problem, spotted
    before it happened: `check_links.py --exclude-host mediafire.com` exists so the
    checker can work on everything else while the fetcher has the host to itself.
11. **Not every link on a map's row is a download of that map.** ZWR lists the UGX Map
    Manager installer against 29 maps the Manager can install, and UGX release threads
    link UGX Mod Standalone as a prerequisite. Counted naively, one installer became 29
    "live download links" and 29 "recoverable maps". They are now `kind='prerequisite'`
    and excluded from every figure in section 2.
12. **A one-map re-run wiped the fourteen-map report.** `extract.py --norm <one>` wrote
    its results over the whole of `extract.json` instead of merging, so a smoke test with
    a name that matched nothing emptied the results table in this document. It merges by
    map now, like `fetch.py` already did. Worth checking wherever a tool writes a report
    it did not fully regenerate.
13. **A verdict is only as good as the tool version it was measured against.** The
    referee agent rewrote `scan_map.py` twice while this document was being written, so
    `scan_maps.py` now records that file's sha256 and mtime in every run. A ratio without
    the version it belongs to is not a measurement.

## 7. Where things are

| What | Where |
|---|---|
| Code | `C:\Users\b\Desktop\Zombies\archive\` |
| Catalogue (SQLite) | `C:\Users\b\ZombiesDev\archive\catalogue.sqlite` |
| Catalogue (JSON, for the site) | `C:\Users\b\ZombiesDev\archive\reports\catalogue.json` |
| Link report / scan / evaluate / fetch / extract JSON | `C:\Users\b\ZombiesDev\archive\reports\` |
| **Originals + sidecars** | `C:\Users\b\ZombiesDev\archive\originals\<map>\` |
| Raw extractions | `C:\Users\b\ZombiesDev\archive\extract\<map>\` |
| Normalised installs | `C:\Users\b\ZombiesDev\archive\mods\<bsp>\` |
| Proposed referee manifests | `C:\Users\b\Desktop\Zombies\archive\manifests\` |
| HTTP cache (so a re-run costs the sites nothing) | `C:\Users\b\ZombiesDev\archive\cache\` |
| Crawl / fetch / scan logs | `C:\Users\b\ZombiesDev\archive\logs\` |

Questions for B are in `docs/kickstart/questions.md` (Q-arc-1 … Q-arc-4): ZombieModding's robots
ban, the robots judgement call on MediaFire's CDN nodes, MEGA decryption, and Google Drive.

## 8. 2026-09-22 — making the first 14 (+ stock 4) complete on the site

Overnight pass over the 14 pipeline maps: newer-version check, description recovery, cover art,
endings evidence, and a ranked next-20. No new full-map fetches (nothing had a newer version), no
installer run, nothing outside `archive/` and `web`'s existing import path written by hand.

| Map (bsp) | Version held | Newer found? | Description | Art | Endings evidence |
|---|---|---|---|---|---|
| Abandoned School (`nazi_zombie_school`) | Patch 1.02 (codrepo desc names it) | no — MediaFire filename matches | codrepo release post (1500c) | cover fetched | tags ee+buyable, scanner `easter_egg` candidates listed |
| Alcatraz (`water`) | current | no | codrepo release post | cover fetched | tags ee+buyable+boss |
| BO2 Hijacked Zombies (`nazi_zombie_hijacked`) | current | no | codrepo release post | cover fetched | tag buyable_ending, scanner agrees |
| City of Hell (`nazi_zombie_dt2`) | current (2015 map) | **maybe** — "City of Hell: Next Station" (2023, T4M) is a same-named *sequel* map on UGX/codrepo, not a version bump of this bsp; flagged as a next-20-style candidate, not fetched | codrepo post | cover fetched | tags ee+buyable |
| Clinic of Evil (`sanatorium`) | 05/11/2018 update | no — UGX thread title confirms this is the "(updated)" release | codrepo post + shipped `readme.txt` | cover fetched | tags ee+buyable; scanner missed silently (documented gap) |
| Der Berg (`nazi_zombie_derberg`) | current | no | codrepo post (109c — genuinely short; NSIS text not recoverable without running the installer, confirmed by `strings` on the exe) | cover fetched | untagged by community; scanner says buyable_ending on `teleport_*` — flagged as a likely false positive in §4 |
| Zombie Desert (`nazi_zombie_test1`) | current | no | codrepo post | cover fetched | tag buyable_ending, scanner agrees |
| Leviathan (`nazi_zombie_leviathan`) | v1.2 | no — UGX thread title is "V1.2", matches archived exe | codrepo post | cover fetched | tags ee+buyable, scanner agrees (entity-only quest) |
| Minecraft Village Remastered (`nazi_zombie_fear_mc_2`) | v1.1 (remastered) | no — UGX thread confirms v1.1 is current; the 2015 original "Minecraft Village" is a different, earlier release, not this map | codrepo post | cover fetched | tags ee+buyable+boss |
| MW2 Rust Zombies (`mw2rust`) | current | no | codrepo post | cover fetched | tag buyable_ending, scanner agrees (`end_game` entity) |
| Octagonal / Octogonal Ascension (`nazi_zombie_octogonal`) | v1.3.0 | no — MediaFire filename matches | **recovered**: codrepo post (was empty; author/date/tags/description now filled) | cover fetched | tag buyable_ending, scanner agrees; §5's cross-source name-mismatch gap fixed for this one map |
| ORBiT (`nazi_zombie_orbit`) | v1.2 | **check** — UGX thread title says "[Added 2 polls about development of v2.0]"; no v2.0 download row found in any catalogue, so v2.0 looks unreleased, not confirmed | codrepo post | cover fetched | untagged by scanner (silent miss, documented in §4); community tags ee+buyable |
| Project Viking (`nazi_zombie_test`) | V1.1 ("Final") | no — UGX thread title matches | codrepo post | cover fetched | tags ee+boss, scanner agrees |
| UGX Requiem (`ugx_artemovsk`) | v1.1 | no — UGX thread title matches | codrepo post (171c, genuinely short — UGX Mod's own feature list lives off-page) | cover fetched | tags ee+buyable+ugx_mod |

Stock four (Nacht der Untoten, Verrückt, Shi No Numa, Der Riese) are not archive-pipeline maps —
no installer, no third-party catalogue entry, no version to check. They stay out of this table;
they are WaW's own content and already on the site by a different path.

**Descriptions**: 13 of 14 installers are NSIS; confirmed again by hand (`7z l -slt` lists no
`.nsi` script member, and a raw `strings` pass over two representative exes — Der Berg and UGX
Requiem — found only NSIS's own UI chrome, nothing resembling release notes) that their release
text is compiled into the installer's UI and not recoverable without running it, which rule 6
forbids. Fell back to the callofdutyrepo release post for all 14, which is where 12 of them
already had a full description; Octagonal Ascension was empty and is now filled. UGX-Mods thread
bodies were fetched too (`fetch_ugx_threads.py`, 14 polite requests total) but the board's SMF
skin puts ~3500 characters of forum chrome (login box, sidebar, signatures) before the actual
post inside the crawler's fixed-length extract, so the UGX text is not usable as a description yet
— left as a known gap rather than shipped as noise. Codrepo remains the good source.

**Art**: one live request per map (14 total, one host, `net.py`'s politeness), reading each
codrepo post's `og:image` and fetching it through `fetch.download()` (robots-checked,
`from_landing=True`, same as any other MediaFire-style download). All 14 covers are 82 KB–723 KB,
well under the 2 MB cap; saved to `C:\Users\b\ZombiesDev\archive\media\<bsp>\` with a
`.meta.json` sidecar (url, sha256, size, fetched). Recorded in each manifest's
`archive.cover` (relative path) and `archive.cover_source_url`. **Gap**: `web/server/db/import-archive.js`
does not read `archive.cover` yet — there is no `art` write in the importer, so the site's `maps.art`
column stays null until web's lane adds that one field read. Out of this lane's files to fix.

**Endings evidence**: already carried in each manifest's `scanner.ee_candidates` /
`hardcoded_costs` / `map_specific_triggers` plus the community's own tags from
`archive.catalogue_tags`, both with their source URL in `archive.source_page` /
`catalogue_description_source`. No manifest's `finishes[]` conditions were changed — §4's
`{"manual": true}` policy for Easter Eggs stands, and ORBiT / Clinic of Evil's documented silent
misses were not "fixed" by inventing a condition (schema: an ungated badge is worse than a
missing one).

**Import**: `node web/server/db/import-archive.js` (no `--catalogue`, the crawl index was already
current) — re-run, idempotent, `+0 maps, 14 updated, 0 catalogued, ... 4 tags`. `playable now: 19`
on the live counts, matching §4h's own figure.

**Next 20 candidates**, ranked by callofdutyrepo view count, all with a confirmed **live
MediaFire mirror** (checked against the existing link-checker data, no new probes): Cheese Cube
Unlimited (25.4k views), Bowser's Castle (25.0k), Black Ops 2 Town Remake (21.3k), McDonalds
(19.8k), Return To Stairway To Hell (18.0k), Nuketown Remastered, Spongebob Battle for Bikini
Bottom (Fixed), Kino the Rebirth (Old Release), Five Nights at Freddy's, A Day In The Life (lewl),
Alien Defense, Das Herrenhaus, Reapers Map Pack, Egypt Zombies, Bus Depot, Battlestar Galactica,
Super Mario 64, Halloween Town, 1942 Forest, Ragnarok — full ranked list with URLs and view
counts in `C:\Users\b\ZombiesDev\archive\reports\next20.json`, all 20 checked against the
existing link-checker verdicts and all 20 have a `mediafire.com: alive` row. None fetched this
run (rule: no new ~300–950 MB pulls without a plan for which ones B actually wants archived
next).

## 9. 2026-09-23 — the add-on IWDs are not extras, and the six maps stay broken

### 9.1 The theory, and why it was a good one

Four of the six maps marked `status: "broken"` die on the same shape: a map script calling
`flag_wait` before `maps\_load::main()` has run `flag_init`. `dedi.md` §14 proved that happens on a
**stock** exe with none of our code in the process, and it noted in passing that Zombie Desert's
`flag_wait` is inside `zombie_hitmarker_bythesuzho.iwd` — "a third-party add-on sitting loose in the
mod folder". That is a repack signature, and the theory it suggests is a real one: **our
`mods/<bsp>/` install ships add-on IWDs that are not the map**, either because the release we
archived is a repack or because `extract.py` swept in the installer's extras, and one of those
add-ons overrides a stock script and faults.

It is wrong, and it is wrong in three separate ways. Each one was measured.

### 9.2 Nothing was swept in: every install is the installer's own file table

7-Zip's listing of each original was read against what `extract.py` produced. For all six maps the
mod folder we install is **exactly** what the release's own installer contains — same files, same
sizes, nothing added, nothing dropped:

| Map | release | files in the installer (excl. `$PLUGINSDIR`) | our `mods/<bsp>/` |
|---|---|---|---|
| Zombie Desert | `Zombie_Desert.exe` (nsis) | 8 | identical |
| Project Viking | `Project_Viking_Final.exe` (nsis) | 6 | identical |
| MW2 Rust | `MW2RustZombies_1.0.exe` (nsis) | 9 | identical |
| Clinic of Evil | `_clinic_of_evil_..._2018.rar` -> nsis | 11 | identical |
| Leviathan | `nazi_zombie_leviathan_v1.2.exe` (nsis) | **5** | identical |
| Der Berg | `Derberg.exe` (nsis) | 4 | identical |

So "our extractor added something" is dead on inspection, with no run needed.

### 9.3 What the add-on IWDs actually are, and what they override

Every `.iwd` in the six installs was opened and its scripts listed:

| Map | add-on IWD | what is inside |
|---|---|---|
| Zombie Desert | `zombie_hitmarker_bythesuzho.iwd` (2,663 B) | 4 entries: `maps/zombie_hitmarker.gsc`, `images/hitmarker.iwi`, `materials/hitmarker`, `material_properties/hitmarker`. **Line 38 of that GSC is `flag_wait( "all_players_connected" );`** — the exact fatal frame |
| Zombie Desert | `electric_cherry.iwd` (954 KB) | Harry Bo21 Electric Cherry, 1 script (`maps/bam_bo_mod_e_cherry_standalone.gsc`) |
| MW2 Rust | `harrybo21_bo1_2_3_perks_v4.0.3.iwd` (99 MB) | 474 entries, `images/` and `weapons/` only — **zero scripts** |
| MW2 Rust | `buried.iwd` (18 MB) | BO2 Buried character pack; 17 scripts, all `aitype/` `character/` `xmodelalias/` definitions |
| Clinic of Evil | `brutus` `chara_player` `motd_zombies` `pause_mn` `weapons`.iwd | **22 bytes each — empty zips, zero entries.** Also 22 bytes inside the installer, so this is the release, not our extraction |
| Project Viking | — | none. Its 73 raw scripts, including the fatal `maps/_zombiemode_ai_mech.gsc` **and** the author's own `maps/_load.gsc` and `maps/_utility.gsc` overrides, are in the map's own `nazi_zombie_test.iwd` |
| Der Berg | — | none. `derberg.iwd` is the map's 394 MB asset pack and holds exactly **one** script, `animscripts/pain.gsc` |
| Leviathan | — | none |

No add-on anywhere in the set overrides `maps/_utility.gsc`, `maps/_zombiemode*.gsc` or
`maps/_load.gsc`. The maps' own IWDs do — that is the author's source tree, shipped raw.

### 9.4 Zombie Desert: the add-on is a HARD DEPENDENCY of the map's own script

`install.exclude[]` and `install_map.py --stage` were built for this test (§9.6). Two runs, both
dedicated, both against a reproduced baseline (`addon5`, which prints the known
`common_scripts/utility.gsc:463` fault at console line 3385):

```
addon1  the whole zombie_hitmarker iwd excluded
        dies EARLIER: "Loading fastfile 'mod'" -> ERROR: image 'images/hitmarker.iwi' is missing
        the author's own zone references the add-on's image

addon6  only maps/zombie_hitmarker.gsc dropped, the iwd's images/materials kept
        ******* Server script compile error *******
        Could not find script 'maps/zombie_hitmarker'
          (file 'maps/nazi_zombie_test1.gsc', line 135)
          maps\zombie_hitmarker::cargar_imagen_hitmarker();
```

That second run settles two things at once. The map's **own compiled script calls into the add-on**
and there is no copy of it in `mod.ff`, so the add-on cannot be removed — it is part of the author's
build, and the release page's own feature list ends "*hitmarkers". And a `Could not find script`
error only arises if the raw GSC inside the IWD was the copy the engine was using, so **stock WaW
does load raw GSC out of mod-folder IWDs** and those raw files are live code, not leftover source.
That is worth knowing for every other map in the archive.

### 9.5 The other five, one run each

| Map | what was excluded | run | result |
|---|---|---|---|
| Zombie Desert | hitmarker GSC (assets kept) | `addon6` | **worse** — `Could not find script 'maps/zombie_hitmarker'` |
| MW2 Rust | both add-on IWDs | `addon6` | **unchanged** — `flag_wait( "electricity_on" )` at `maps/mw2rust.gsc:179`, the map's own line, carrying the author's own comment `//remove line if you want it to work without power` |
| Clinic of Evil | all five empty IWDs | `addon6` | **unchanged** — `maps/_zombiemode_rotating_door.gsc:34`, a script that is in the author's `mod.ff`, not in any IWD |
| Project Viking | nothing to exclude | `addon7` | **unchanged** — same script runtime error |
| Der Berg | nothing to exclude | `addon7` | **unchanged** — `com_frameTime +0 ms over 8 probes (last 5651)`, the same 5,651 ms stop as run `mapB` |
| Leviathan | (an **addition**, see below) | `addon6` | **unchanged** — `unknown item 'napalmblob'` |

**Leviathan is the one place the "missing file" version of the theory had teeth.** Its installer
ships five files and **no `<bsp>_patch.ff` and no `<bsp>_load.ff`**, which every other release in
the set does; run `map03`'s console shows the engine falling back to `Loading fastfile 'default'`
in its place. `weapons/sp/napalmblob` exists in the stock game (`main\iw_14.iwd`), and the string
`napalmblob` is at offset 58,521 of the inflated 2,348,417 bytes of the generic 690,464-byte
custom-map patch fastfile that **Zombie Desert and Clinic of Evil both ship byte-identically**
(sha256 `d3eedd1e…`). So that file was staged in under the name `nazi_zombie_leviathan_patch.ff`.
The engine loaded it — `Loading fastfile 'nazi_zombie_leviathan_patch'`, console line 2197, where
`map03` had said `'default'` — and `unknown item 'napalmblob'` did not move. **The missing patch
fastfile is real and is now a named fact about this release; it is not what breaks the map.** The
`install.add` entry stays in the manifest with that result and `applied: false`.

### 9.6 What the test left behind, and it is the useful part

- **`install.exclude[]` / `install.add[]` in the manifest**, honoured by
  `install_map.py --stage`, which builds `ZombiesDev\archive\mods-staged\<bsp>\` out of **hard
  links**. No bytes are copied, `archive\mods\<bsp>\` is never written, and the originals stay
  byte-for-byte what the release shipped: an exclusion is a *view*, not an edit.
- **`"applied": false`** on an entry keeps an audited add-on in the record without acting on it.
  Every entry written this session carries it, with the run that decided it. An add-on that was
  suspected and then measured innocent must stay written down or the next session repeats the
  experiment; it must not stay in the install.
- **`mapmount.ps1` mounts the staged folder when one exists** and says so in yellow, and it now
  **repoints** a junction left pointing at the other install rather than silently keeping it. A run
  that boots files the caller did not ask for, and does not say so, is how a result gets quietly
  invalidated.

### 9.7 The verdict

**All six keep `status: "broken"`, and all six are broken by the map.** Three sessions have now
tried to find something of ours in the way — an overlay, a sampler, the mount, and now the install
— and there has never been anything there. The remaining honest question is the one §14 left open
and this session did not close: **why the community plays four of these anyway.** The add-on IWDs
are not the answer.

## 10. 2026-09-22 (evening) — the popular 64: fetched, extracted, on the site, and booted on the box

B's ask: *"get a bunch more maps and make sure they work — download another ~50 popular maps."*

### 10.1 How the 64 were picked

`archive/rank_popular.py` ranks the catalogue with signals the crawlers already held — no new
traffic: **UGX-Mods release-thread views** and **callofdutyrepo post views** (the larger of the
two), +25% for callofdutyrepo's `top100` tag. A map is a candidate only when it has a link
`fetch.py` can actually pull — **MediaFire or archive.org, verdict alive**, 20 MB–1.4 GB — is
not already archived, is not tagged `t4m_req` (we run the stock exe) and is not a pack.
The list is `archive/shortlist3.txt`; the ranking with its numbers is
`reports/popular.json`. UGX views dominate (they run to hundreds of thousands against
callofdutyrepo's tens of thousands), so this is in effect the UGX-Mods popularity order.
Every one of the 65 chosen links was MediaFire: archive.org's items are file dumps and none
cleared the size / name filter.

### 10.2 What went wrong on the way, and is fixed

1. **The first three "originals" were a 35 KB HTML page.** `fetch.py` resolved the MediaFire
   file page through the on-disk HTTP cache; the page was from the link check days earlier,
   its `download<N>.mediafire.com` key had expired, and MediaFire answers a stale key with
   `download_repair.php` — *"Generating new download key"*, HTTP 200. `fetch.py` saved it,
   hashed it, AV-scanned it and said `ok`. The download now reads the file page **fresh**
   (`probe_mediafire(..., fresh=True)`) and **refuses anything served as HTML**. The three bad
   files were deleted and re-fetched.
2. **Futurama became `ugxm_customize_room`.** It ships UGX Mod's customize-room zone beside
   its own, both `.ff` + `_patch.ff`, and `guess_names()` broke the tie alphabetically. The
   installer's own **`mod.arena`** names the zombies map (`gametype "zom"`) and now decides
   whenever it names a fastfile that is present. Re-checked over all 78 installs: Futurama
   was the only one it changes.
3. **Library produced a map called `images`.** Its installer has `Library/images/z_greenscope.iwd`;
   a folder *inside* another mod root is now skipped (it is already copied with its parent).
4. **A rescan would have rewritten the 14 MVP manifests** (the corpus-boilerplate set moves
   with the corpus, and a rewrite drops `archive.cover`, `install.exclude` and the dedi
   notes). `scan_maps.py --keep-existing --report scan-popular.json` scans all 78, writes a
   manifest only for a map that has none, and leaves `scan.json` — which sections 3–4 are
   generated from — as the 14-map record. `report.py`/`make_doc.py` now scope sections 1–4 to
   that set.
5. **One timeout**: Pokémon Kanto Carnage — Nighttime (`download1320.mediafire.com` read
   timeout, twice). Not retried tonight.
6. **Two box installs failed with a `JSONDecodeError`** (Futurama, Arena Challenge). Not the
   maps: `box_stage.py` passed its spec to the box as one base64 argument, and for a release
   with 73 or 163 files that argument ran past ~8 KB and the Windows ssh command line cut
   it. The spec now rides inside the script on stdin. Both installed and both passed.
7. **A proof can be pre-empted.** The box runs one assignment; anybody's lease replaces
   yours and the host SIGTERMs your instance. Mr. Freeze's first run was recorded as
   *"map_loaded, then the process exited"*. The journal shows another lane's Nacht lease
   44 s after Mr. Freeze loaded (22:33:43). Later, 23:27–23:33 box time, every lease was
   dropped to idle about 3 s after it was made (another lane's instance-slot bug, fixed by
   restarting the host agent at 23:38). `box_proof.py` now watches for both cases (a
   foreign `assignment changed: leased`, or our lease going idle before we cancel it). It
   records either as **skipped, not failed**, and a run inside that window was not counted
   as an attempt.

### 10.3 The static pre-check (`archive/precheck.py`)

Run over every new install before booting it, against the killers the dedi lane has named:

- **Add-on IWDs** (§9): 51 of 64 ship at least one IWD that is not the map's own, 42 of them
  with scripts inside. §9.4 proved those can be hard dependencies of the map's own script,
  so they are recorded and **never dropped**.
- **Client memory** (`dedi.md` §14.7): the map zone's inflated size is recorded; ORBiT's is
  137 MB and its client parks at ~1.6 GB. 22 of 64 are ≥ 110 MB and carry
  `client_memory_risk` — a prediction about the *client*, which nothing tonight could test.
- **`napalmblob`** (Leviathan): **recorded, not a flag.** The string is in every map zone
  measured, including Minecraft Village's, which passes five gates. It predicts nothing.
- **`localVars`** (Der Berg): not predictable statically; only a boot says.

It also records the **art each map ships**, for the site-art lane, in the manifest as
`archive.art`: `loadscreen` (the map's own `loadscreen_<bsp>` material — 31 of 64 have one),
every `loadscreen_*` name in its zones, and the menu/load/preview-looking images in its IWDs.
Names only; nothing converted. The importer does not read `archive.art` — it reads only
`archive.cover`, which none of the 64 has yet.

### 10.4 On the site

`node web/server/db/import-archive.js` — the documented ingestion — took all 64:
`+58 maps` on the final run (6 were imported earlier to prove the path). Each has a map row, a
version with `fs_game mods/<bsp>`, the original as a file row (sha256, source URL) and its
manifest. The launcher's download (`/api/maps/<bsp>/files`) serves from `extract.json` +
`mods/<bsp>/`, so every extracted map is installable by a player's launcher with per-file
sha256. The importer now honours a manifest's `health: "broken"`, which is how a map the box
could not load is hidden from the Maps list and refused by a lease.

**`SERVER_PROVEN` is unchanged** (`web/server/lib/maps.js`): it still means a five-gate run
*with a real client*, and none of the 64 has one. The box proofs below went through
`lease-cli.js --proof`, which widens that set **inside the CLI process only**.

**A second, weaker level, added 2026-09-23 on B's word** (*"push all the maps that
currently work so I can try them out"*): `BOX_PROVEN`, read from the generated
`web/server/lib/boxProven.json`. A map that passed the box proof is `on_server` at
`server_level: "box"`. A party **may** lease it, and the site tags it **New**, with *"loads on
our servers, not yet played with a client"* on hover. A box failure stays *Not playable*, with
a hover of *"Does not run on our servers: <reason>"*. All 548 files of the 59 passing maps are
on the maps bucket (HEAD-checked, sizes match).

### 10.5 The box proof

`archive/box_stage.py` installs a map on the box **without pushing it up B's connection**: the
box downloads the release from the same MediaFire page, refuses it unless its sha256 is the
original we fetched and scanned here, extracts it with 7-Zip (nothing run), and moves exactly
the files `extract.json` lists — matched by sha256 — into `/home/waw/waw-en/mods/<bsp>/`, the
one directory the box's three `mods` symlinks point at. Heavy steps under `nice 19 / ionice idle`.

`archive/box_proof.py` then, per map and strictly one at a time: waits for the host agent's
last `assignment changed:` to be `idle`; leases with
`lease-cli.js --map <bsp> --player 76561198000000001 --proof` (the fake SteamID); waits for
`map_loaded <bsp>` in the journal; holds 35 s; reads the instance's own ENW log and requires
**`com_frameTime` to have advanced ≥ 15 s** (the fifth gate — a map that loads and stops
simulating is not a pass) and the process alive; cancels; waits for idle again.

**Every failure got a second attempt** with `--load-wait 300` (twice the first run's 150 s,
because some big zones load slowly under Wine). A second failure is final. `popular.py --apply`
then writes each result into its manifest: pass → `dedi_status: "box_map_loaded"`, fail →
`health: "broken"` + `health_reason`, and `web/server/lib/boxProven.json`. The importer
(`import-archive.js`) turns `broken` into a map the Maps list hides and a lease refuses. The
site offers the passes to a party as **"New"** (next section).

65 ranked; 64 fetched and AV-clean; 64 extracted to a `mods/<bsp>/`; 64 booted on the box through a real lease; **59 reached `map_loaded` and kept simulating**, 5 did not; 59 are on the site's Maps list (health not `broken`).

| # | Map | UGX/codrepo views | bsp | size | pre-check | box (dedicated, lease) | site |
|---:|---|---:|---|---:|---|---|---|
| 1 | NUKETOWN REMASTERED (top 100) | 446,842 | `nuketown` | 484 MB | client_memory_risk | **PASS** | custom-only |
| 2 | NACHT DER UNTOTEN: REIMAGINED | 535,943 | `nacht_reimagined` | 294 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | playable |
| 3 | POKEMON WHERE LEGENDS BEGIN (top 100) | 403,259 | `nazi_zombie_poke` | 227 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 4 | ZOMBIE DOME | 425,536 | `nazi_zombie_dome_snow` | 383 MB | addon_iwd_with_scripts | **PASS** | playable |
| 5 | Malibu Drive Age of Apocalypse (top 100) | 315,865 | `nazi_zombie_malibu` | 353 MB | client_memory_risk | **PASS** | custom-only |
| 6 | Relinquished/Project Nova | 366,141 | `nazi_zombie_johndoe` | 336 MB | - | **PASS** | custom-only |
| 7 | UT BOX | 353,435 | `ut_box_map` | 64 MB | - | **PASS** | playable |
| 8 | Nuketown 1886 Zombies Map | 336,245 | `zm_nuked` | 468 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | custom-only |
| 9 | Killhouse IW (top 100) | 261,743 | `killhouse` | 364 MB | addon_iwd_with_scripts | **PASS** | playable |
| 10 | CRYOGENIC (top 100) | 252,778 | `cryogenic` | 466 MB | client_memory_risk | **PASS** | playable |
| 11 | THE PATH | 307,876 | `nazi_zombie_path` | 57 MB | addon_iwd_with_scripts | **PASS** | playable |
| 12 | FIVE NIGHTS AT FREDDY’S | 298,817 | `nazi_zombie_fivenights` | 231 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 13 | TOWN OF THE DEAD (top 100) | 223,765 | `zombie_town` | 483 MB | client_memory_risk | **PASS** | playable |
| 14 | FUTURAMA 1.1 | 269,663 | `futurama` | 208 MB | addon_iwd_with_scripts | **PASS** | playable |
| 15 | ZHUNTERZ (top 100) | 212,844 | `nazi_zombie_zhunterz` | 366 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | playable |
| 16 | BLOODSPORT XMAS | 241,424 | `nazi_zombie_bloodsport` | 128 MB | addon_iwd_with_scripts | **PASS** | playable |
| 17 | CARGO | 238,917 | `nazi_zombie_cargo` | 357 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | custom-only |
| 18 | NIGHTCLUB | 227,012 | `nightclub` | 480 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 19 | BRIDGE | 217,175 | `bridge_zombie` | 134 MB | client_memory_risk | **PASS** | playable |
| 20 | DEAD PALACE | 214,883 | `dead_palace` | 231 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 21 | HIGHRISE | 182,172 | `hghrise` | 205 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | playable |
| 22 | LORKEEP STATION | 181,600 | `nazi_zombie_lorkeep` | 185 MB | addon_iwd_with_scripts | **PASS** | playable |
| 23 | CUBE | 178,064 | `cube` | 315 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 24 | CHRISTMAS IN PRISON | 171,698 | `navidad_p_zombie` | 326 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 25 | Thirty Seven Christmas Zombies (top 100) | 134,511 | `thirty_seven` | 328 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 26 | Arena Challenge Map | 167,872 | `nazi_zombie_arena` | 59 MB | - | **PASS** | playable |
| 27 | DIXMOR ASYLUM (top 100) | 128,213 | `escape_asylum` | 297 MB | - | **PASS** | playable |
| 28 | PRISON MISSION V1.1 (top 100) | 126,949 | `nazi_zombie_prison` | 336 MB | client_memory_risk | **PASS** | custom-only |
| 29 | ZOMBIE REVOLUTION INFINITE | 152,822 | `nazi_zombie_shore` | 420 MB | addon_iwd_with_scripts | **FAIL** — no map_loaded within 150 s; first error: `Could not load rawfile "animscripts/dog_init.gsc".` (1 clean run; 2 retries pre-empted, not counted) | broken |
| 30 | ZOMBIE CELERIUM (TEMPLE) | 150,200 | `nazi_zombie_temple` | 622 MB | - | **PASS** | playable |
| 31 | Hotel Version 2 | 150,128 | `nazi_zombie_hotelv2` | 184 MB | addon_iwd_with_scripts | **PASS** | playable |
| 32 | DUAL WIELD CHALLENGE MAP | 147,498 | `chal_dual_wield` | 330 MB | addon_iwd_with_scripts | **PASS** | playable |
| 33 | BEACHTOWN (top 100) | 115,239 | `nazi_zombie_beachtown` | 257 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 34 | BORED | 143,532 | `nazi_zombie_bored` | 346 MB | addon_iwd_with_scripts | **PASS** | playable |
| 35 | CXCA | 143,500 | `cxca` | 155 MB | addon_iwd_with_scripts | **FAIL** — no map_loaded within 150 s; first error: `Could not load rawfile "maps/_zombiemode_dogs.gsc".` (1 clean run; 2 retries pre-empted, not counted) | broken |
| 36 | UNDEAD HOSPITAL | 141,540 | `zm_hospital` | 323 MB | - | **PASS** | playable |
| 37 | ENCLOSED | 141,113 | `nazi_zombie_enclosed` | 409 MB | addon_iwd_with_scripts | **PASS** | playable |
| 38 | ZOMBIE LIBRARY | 139,305 | `nazi_zombie_library` | 328 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 39 | PURPLE DIMENSION (top 100) | 111,076 | `nazi_zombie_pd` | 299 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | playable |
| 40 | MINECRAFT | 133,407 | `nazi_zombie_mine` | 262 MB | - | **PASS** | playable |
| 41 | ALIEN DEFENSE (top 100) | 102,851 | `aliendefense` | 276 MB | - | **PASS** | playable |
| 42 | BATTLESTAR GALACTICA (top 100) | 101,881 | `battlestar_galactica` | 213 MB | addon_iwd_with_scripts | **PASS** | playable |
| 43 | KINGDOM HEARTS | 125,690 | `kingdom_hearts` | 184 MB | addon_iwd_with_scripts | **PASS** | playable |
| 44 | Shi No Mori - Nacht der Untoten reborn (top 100) | 96,920 | `shinomori` | 771 MB | client_memory_risk, addon_iwd_with_scripts | **FAIL** — no map_loaded within 150 s; first error: `Need 36283957 more bytes of 'main' physical ram for alloc to succeed` (1 clean run; 2 retries pre-empted, not counted) | broken |
| 45 | LEGION | 120,866 | `nazi_zombie_legion` | 310 MB | client_memory_risk | **PASS** | custom-only |
| 46 | POKEMON KANTO CARNAGE - NIGHTTIME | 119,401 | - | - |  | not fetched: download failed: ConnectionError: HTTPConnectionPool(host='download1320.mediafire.com', port=80): Read timed out. | - |
| 47 | HANOI (top 100) | 95,288 | `nazi_zombie_hanoizom` | 356 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | playable |
| 48 | LEGACY | 118,834 | `nazi_zombie_denial2` | 184 MB | client_memory_risk | **PASS** | playable |
| 49 | RATS | 117,921 | `nazi_zombie_rats` | 316 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 50 | TANK YARD | 117,208 | `nazi_zombie_tank` | 266 MB | - | **PASS** | playable |
| 51 | JIGSAW | 108,230 | `jigsaw` | 164 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** | custom-only |
| 52 | HEART OF ICE (top 100) | 85,072 | `mr_freeze` | 324 MB | client_memory_risk, addon_iwd_with_scripts | **PASS** (reclassified: the first run's exit was another lease's SIGTERM, 44 s after map_loaded) | playable |
| 53 | SALOON (top 100) | 83,931 | `nazi_zombie_relax` | 196 MB | addon_iwd_with_scripts | **PASS** | playable |
| 54 | DECONTAMINATION | 101,813 | `nazi_zombie_dcv2` | 205 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 55 | SNOW GLOBE (top 100) | 78,088 | `nazi_zombie_snowglobe` | 312 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 56 | HARAMBE | 94,584 | `chal_harambe` | 337 MB | addon_iwd_with_scripts | **PASS** | playable |
| 57 | ILS: LETS GO HOME | 93,072 | `nazi_zombie_ils` | 133 MB | client_memory_risk | **PASS** | playable |
| 58 | DESCE PRO PLAY FINAL | 90,419 | `dpp` | 504 MB | client_memory_risk | **FAIL** — no map_loaded within 150 s; first error: `Need 37230375 more bytes of 'main' physical ram for alloc to succeed` (1 clean run; 2 retries pre-empted, not counted) | broken |
| 59 | BANK JOB | 87,631 | `bank_job` | 67 MB | - | **PASS** | playable |
| 60 | UNDEAD FOREST | 86,866 | `nazi_zombie_forest` | 261 MB | addon_iwd_with_scripts | **PASS** | playable |
| 61 | INFERNO | 84,179 | `nazi_zombie_inferno` | 367 MB | client_memory_risk | **FAIL** — no map_loaded within 150 s; first error: `Need 81538024 more bytes of 'main' physical ram for alloc to succeed` (1 clean run; 2 retries pre-empted, not counted) | broken |
| 62 | CHRISTMAS WITH THE JOKER (ARKHAM) | 77,417 | `nazi_zombie_arkham` | 198 MB | client_memory_risk | **PASS** | playable |
| 63 | Bowser's Castle (top 100) | 61,909 | `bcast` | 304 MB | addon_iwd_with_scripts | **PASS** | playable |
| 64 | GARAGE | 74,350 | `ugxm_garage` | 426 MB | addon_iwd_with_scripts | **PASS** | custom-only |
| 65 | THE CRAZY PLACE | 72,508 | `nazi_zombie_crazyplace` | 196 MB | addon_iwd_with_scripts | **PASS** | playable |

**What this does not prove.** No client joined any of these games. A pass here is *"the
dedicated server under Wine loads the map and keeps simulating"*. It says nothing about a
32-bit client's memory ceiling (ORBiT and UGX Requiem pass server-side and stall their client,
`dedi.md` §14.7), a mid-game join, round 2, or a finish being refereed. The 22
`client_memory_risk` maps are the ones to expect trouble from.

## 10. 2026-09-22 (evening) — a picture for every catalogued map (web-maps lane)

B: every map on the site gets an image. §8 fetched 14 covers by hand. The rest were already
half-fetched: callofdutyrepo's **list pages**, crawled in pass A, draw every post as a card with
its featured image, so the cache named a picture for most of the catalogue without one new page
request.

`archive/fetch_art.py` makes **no page requests**. It reads the cache — codrepo list-page cards
(post URL → the 768px WordPress rendition from `data-srcset`), codrepo post pages' `og:image`,
moddb addon pages' `og:image` — drops any image URL more than three pages share (a site logo, not
a map), maps each catalogue entry to its picture through its sightings, and downloads **only the
images**, through `lib/net.py`'s politeness (one request at a time per host, the 6 s delay,
robots.txt, a host that errors twice is dropped). Each lands in
`media/catalogue/<norm>/cover.<ext>` with a `.meta.json` sidecar (url, page, source, sha256,
size, content type, fetched), the same shape as §8's. `reports/art_urls.json` is the plan.
Re-runnable: a map with its sidecar is skipped without a request.

**The run:** the cache named a picture for **1,418** of 2,276 catalogue entries (1,399
callofdutyrepo, 19 moddb). Started 20:14, one image every ~6.6 s; at 22:26, 1,200 fetched,
2 failed (`logs/fetch_art.log`). The remaining ~858 entries have no page in our cache that shows
a picture.

**Final, on the live site** (`web/public/media/maps/manifest.json`, 21:51Z run of
`tools/maps/map_art.py --no-stock`, 2,348 maps): **1,449 scraped covers, 19 maps' own loading
screens, 880 generated cards, 0 stock** (ip-posture §4), plus 25 own loading screens offered as a
second picture.

The rest of the chain is the web lane's (`tools/maps/map_art.py`, web.md's dated section): scraped
art first, then the map's own loading screen out of its `.iwd` (an `.iwi` decoded by
`tools/maps/iwi.py` — IWI v6, DXT1/3/5, the full-size level is the file's tail), then WaW's stock
loading screens (read-only), then a generated card. Loading screens found in the 14 pipeline
installs: `nazi_zombie_dt2`, `nazi_zombie_fear_mc_2` (in `fortress.iwd`, beside a copy of
Verrückt's which is rejected as stock), `nazi_zombie_hijacked`, `nazi_zombie_derberg`,
`nazi_zombie_school`, `nazi_zombie_test`, `nazi_zombie_test1`, `sanatorium`, `ugx_artemovsk`,
`water`. None in Leviathan, ORBiT, MW2 Rust (only the UGX perk pack's template) or Octagonal
(only texture previews). Nazi Zombie Ali's `_load.ff` names `loadscreen_nazi_zombie_ali` and no
file in the release carries it.

**Where to widen it next:** the ~1,012 codrepo posts pass C never fetched are already on the list
pages, so they are covered; what is left uncovered is catalogue entries seen only on ZWR, UGX or
archive.org. UGX thread bodies (§8) carry attachments; archive.org items carry files. Both are a
page request per map and were not made tonight.

## 11. 2026-09-23 (early) — Easter egg steps out of what we already hold (`archive/easter_eggs.py`)

B: "Figure out a way to explain Easter eggs. Through the stuff we archive there might be sections
or guides ... Find the Easter egg steps for as many maps as you can." Branch `web-easter-eggs`.

**No requests.** The script reads the crawl cache and the extracts only:

| Source | Scanned | Guides kept |
|---|---:|---:|
| callofdutyrepo release posts (pass C cache, `entry-content` only) | 387 posts | **26** |
| UGX-Mods threads (`fetch_ugx_threads.py` cache, every post with its own poster, quotes and signatures stripped) | 12 threads, 180 posts | 0 |
| moddb addon pages | 19 | 0 (the one EE mention is a tag) |
| archive.org item descriptions (`catalogue.sqlite`, line breaks already gone) | 40 | 0 |
| readmes shipped in `extract/` and `mods/` (`*.txt/*.md/*.rtf/*.nfo`; PDF only if `pypdf` is installed — it is not, and no PDF was found) | 9 files | 0 |

**Result: 26 guides on 20 maps** (8 main quest, 2 power, 2 song, 5 ending, 9 side quest), 32
candidates, 6 rejected as low. All 20 resolve to a site map (3 playable: `battlestar_galactica`,
`cxca`, `shinomori`; 17 catalogue rows). Output `reports/map_guides.json`, schema
`enw.map_guides/1`; `web/server/db/import-archive.js --guides` loads it (web.md, same date).

**How it tells a guide from a feature list.** A release post is mostly a feature list ("Easter Egg",
"Buyable Ending", "Soul Boxes"), and a heading followed by nouns is not a guide. The test is whether
the lines under a heading are *instructions*: an imperative verb first ("Shoot the three skulls"),
"Step N", a numbered list, a titled step ("APPEASE THE BOXES – Fill all 6 soul boxes"), or a
one-liner ("To turn on the power, activate the 5 generators", "Shoot three teddy bears to access
Pack-a-Punch"). Anchors inside changelogs and credits ("Fixed minor Easter Egg bugs", "X for in
game objective system") are refused. Confidence in [0, 1] = heading (kind / guide words) + step
count + share of steps that are instructions + numbering + places named, minus a feature-list
penalty and a single-weak-line penalty; **only ≥ 0.45 (medium) is written**, ≥ 0.70 is "high".
"What it gets you" comes from the heading, else an ending anywhere, else the last two steps (a
perk's *name* only counts in a heading: "next to PHD Flopper" is a place). Unknown stays null.
`python archive/easter_eggs.py --selftest` runs eight fixed cases (kept, feature list, changelog,
credits, one-liners); `web/test/guides.js` runs it.

Sample (steps abridged here; the site quotes them with author and link):

- **xSanchez78's Der Riese Mod** — Main quest, 0.99, alaurenc9 on callofdutyrepo: link all teleporters → get monkeys → get the Hacker → obtain the Retriever → find the secret room → charge the teleporters → escape. Ends the game.
- **Escher** — Main quest, 0.90, JayJiveCertified: fill the six soul boxes → Pack-a-Punch the free Mark 3 → shoot the green door → shoot three teddy bears (locations as details) → kill the NPC → buy all 11 Secure Points. Plus a side-quest tab.
- **Unterwegs** — Ending 1.00 (8 steps, power → parts → switch → hidden buttons → buyable ending), plus Widow's Wine and perk-slot side quests.
- **Psychopath** — Power 0.77: shoot the three power towers (each located), then the door by the box opens.
- **Hello Kitty Remastered** — Song 0.74: the room with Electric Cherry, the broken TV by the stairs door, shoot it.

**Unproven / known gaps.**
- Nobody has played any of these. A guide is the author's release text, not a verified walkthrough.
- Precision was checked by reading all 26 by eye; **recall was not measured** — a probe over the
  codrepo/UGX lines with an EE word and a verb found the obvious misses (fixed) and left prose
  hints and feature lines, but guides written as flowing paragraphs mostly still fall through.
- The UGX threads gave nothing: the 12 cached threads are release posts whose EE text is not
  steps, and the replies on page 1 are not guides. Later pages and the other ~590 UGX threads
  were never fetched (a page request per thread; not made tonight).
- 1,012 codrepo posts pass C never fetched are the biggest pool of more guides (`crawlers/codrepo.py --pass c`).
- Stock maps (Nacht, Verrückt, Shi No Numa, Der Riese) get nothing: that text is Activision's
  territory and nothing in the archive covers it.
- Next, as B said: read the steps out of the map's own GSC (`referee/scan_map.py`'s flags are the
  start); those rows would come in as `origin='script'`.


## 13. 2026-09-23 (afternoon) — asset audit: every model, every map, every gun (lane A1)

B, 13:10 UK: *"Make sure invisible or broken zombies can't happen on any other map. Every model,
every map, every gun, everything should load flawlessly."* fear_mc_2's invisible/garbled zombies are
lane Z1's (`mod-compat.md` §10, next-session bug 18); this section is the rest of the catalogue.

### 13.1 What was measured

`archive/asset_audit.py` reads **every server console log we hold** — the box's per-map
`waw-en/mods/<bsp>/console.log` and `zdev/homes/*/main/console.log` (pulled read-only at 12:59 and
13:28 UK into `ZombiesDev\archive\logs\box-console\`), `box_proof.py --save-console` slices,
`ZombiesDev\logs\dedi\*.console.log` and the harness's shared `archive\mods\<bsp>\console.log` —
cuts them into processes (`logfile opened on`), attributes each to the map zone it loaded, and
collects every `Could not load xmodel|xanim|material|fx|weapon|rawfile|...`, `unknown item`,
`image ... is missing` and `Waited ... for missing asset`. 157 hosted maps (every DB map with an
fs_game, plus the stock four); 81 have at least one logged load.

Per miss it answers **where** the asset is — OpenAssetTools' Unlinker `--list` over every zone we
ship, every zone of the original download, and the stock zombies zones (cached in
`ZombiesDev\archive\cache\asset-lists`): `shipped_zone`, `shipped_iwd`, `load_zone_only` (only in
`<bsp>_load.ff`, which a real dedicated server never loads — measured on every box log),
`shipped_unloaded_zone` (in a zone nothing loads: number2 ships its dogs in `loacalized_number2.ff`),
`unshipped` (in a file of the download we do not deliver — the importer's fault), `stock_zone`
(only in Nacht/Verrückt/Shi No Numa/Der Riese's own zone), `missingasset_csv`, `absent` — and
**what a player meets**:

* **fatal role**: a character model or AI/dog xanim, a weapon (model, viewmodel xanim, weapon file,
  `unknown item`), a script, a HUD material — and not also missing on a stock map in our own logs
  (the chronic baseline: 299 names).
* **visible** (a player meets it): a zombie body/head model (not a gib/limb-spawn variant), a core
  zombie/dog locomotion or attack anim (dogs only if a loaded zone defines a dog model), a box/wall/
  loadout weapon the map's `_zombiemode*.gsc` precaches (`unknown item`), a script not in a shipped
  IWD. **Minor**: one ADS/idle anim, gib variants, a HUD icon, the perk-drink/bowie "weapons"
  (`zombie_knuckle_crack`, `zombie_bowie_flourish`: missing on maps that play fine).
* **client check** (neither: only a picture decides): player-side models — the shared `_loadout.gsc`
  precaches whole campaign sets (`mptype\player_usa_marine::precache()` beside
  `nazi_zombie_heroes` in johndoe) and a per-map `set_player_specific_viewmodel` overrides the
  default viewhands (school) — plus `fraggrenade`/`zombie_melee`.
* **owner**: `ours` (unshipped, load_zone_only), `patchable` (shipped under a name nothing loads),
  `release` (everything else: a retail listen server with the same files misses the same).

Verdict per map: `clean`, `minor`, `fix` (a visible miss we cause), `patch`, `hide` (a visible miss
that is the release's own), `unproven` (no log of the map loading). Full per-map table and every
fatal row: `ZombiesDev\archive\reports\asset-audit.md` / `.json`; each manifest carries its
verdict as `asset_audit`.

### 13.2 The answer

**Nothing we do makes a model fail on any map with a log**, with two exceptions, both fixed or
routed:

1. **Two serve-filter drops, fixed** (`web/server/lib/mapfiles.js`): loose `sound/**.wav|.mp3`
   were not in `ALLOWED` — 203 files on six maps (four_way_defense 93, nazi_zombie_house69 62,
   no_way_out 37, nazi_zombie_perk 5, neon_fighter 5, bunker 1: music-box songs, weapon fire, an
   Easter-egg song) never reached a client or the box; and `rel.includes('..')` dropped Neon
   Fighter's **`HarryBos Mysterybox Pack V1..0.0.iwd`** (6.3 MB, its box weapons) as "path
   traversal" — now a `..` *segment* is refused and a `..` inside a name is a file. All 204 are in
   the bucket (`sync.js --only maps --map <bsp>`, 13:33 UK); the box has the sounds for four maps
   (`box_stage.py --add-missing`, new: fetches only what the install lacks, never removes, safe
   beside a live game). The Mysterybox IWD goes on the box **only after the site serves it**
   (merge + site restart on B's word), or box and client hold different IWD sets. The launcher's
   `ALLOWED_EXT` gets `.wav/.mp3` too; until a launcher publish, 0.2.24 skips them with a note
   (non-fatal) — the IWD needs no launcher change.
2. **The dedicated server never loads `<bsp>_load.ff`** (a listen server does). ray_chirstmas_map
   (hidden already) keeps all 14 of its BO2 zombie bodies/heads only there — on our box its zombies
   lack their models, on retail they do not. That is the **dedi lane's** (load the map's `_load`
   zone on the dedicated server); on four live maps the load-zone-only asset is server-side only
   (`viewhands_custom`, rain fx).

Everything else visible is **the release as its author shipped it**. No importer drop was found
behind any fatal miss: of every file in 153 originals, only `zombie_rise`'s
`rise\zombie_rise_load.bik` (an installer extra outside the mod folder, a load video) is
engine-readable and not shipped.

### 13.3 The table

Counts over the 157 hosted maps (site state after the hides below):

| site state | clean | minor | fix | patch | hide | unproven | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| live | 17 | 10 | 0 | 0 | 1 | 50 | 78 |
| hidden | 21 | 9 | 1 | 0 | 28 | 20 | 79 |

Every map whose verdict is not `clean`/`unproven` (live first):

| map | site now | runs loaded | misses | fatal | visible | owner | what a player meets | verdict |
|---|---|---:|---:|---:|---:|---|---|---|
| `nazi_zombie_fear_mc_2` | custom-only | 14 | 370 | 20 | 4 | release 4 | bo1_c_viet_zombie_female_head, bo1_c_viet_zombie_napalm_head, bo1_c_viet_zombie_nva1_body, bo1_c_viet_zombie_vc_grunt_head | hide |
| `battlestar_galactica` | playable | 2 | 335 | 1 | 0 | - | (minor) viewmodel_M40a3_ADS_fire | minor |
| `bridge_zombie` | playable | 5 | 311 | 2 | 0 | - | (minor) hud_icon_kar98k, viewmodel_claymore_empty_idle | minor |
| `mw2rust` | playable | 8 | 405 | 2 | 0 | - | (minor) weapons/sp/zombie_bowie_flourish, weapons/sp/zombie_knuckle_crack | minor |
| `nacht_reimagined` | playable | 1 | 155 | 1 | 0 | - | (client check) aw_hazmat_viewhands | minor |
| `nazi_zombie_arkham` | playable | 1 | 180 | 1 | 0 | - | (client check) char_rus_guard_bodyr_m_g_upclean | minor |
| `nazi_zombie_johndoe` | custom-only | 1 | 188 | 11 | 0 | - | (client check) char_usa_marine_head1_1, char_usa_marine_head2_2, char_usa_marine_head3_3, char_usa_marine_head4_4 +6 | minor |
| `nazi_zombie_orbit` | playable | 2 | 194 | 1 | 0 | - | (minor) ai_zombie_quad_idle | minor |
| `nazi_zombie_school` | custom-only | 1 | 243 | 5 | 0 | - | (client check) viewhands_player_sas_woodland, viewhands_sas_woodland | minor |
| `ugx_artemovsk` | custom-only | 2 | 198 | 5 | 0 | - | (minor) c_zom_zombie8_body01_g_behead, c_zom_zombie_g_larmspawn, c_zom_zombie_g_llegspawn | minor |
| `zm_nuked` | custom-only | 2 | 364 | 6 | 0 | - | (client check) fraggrenade, zombie_melee | minor |
| `christmas_zombie` | playable hidden | 1 | 194 | 8 | 8 | release 8 | mine_bouncing_betty, zombie_colt, zombie_colt_upgraded, zombie_thompson +4 | hide |
| `island` | playable hidden | 1 | 158 | 1 | 1 | release 1 | jukebox_button_press | hide |
| `kri` | playable hidden | 1 | 179 | 9 | 9 | release 9 | m2_flamethrower_zombie_upgraded, panzerschrek_zombie, panzerschrek_zombie_upgraded, zombie_kar98k +5 | hide |
| `labrats2` | playable hidden | 1 | 304 | 46 | 46 | release 46 | m1garand_gl_zombie, m1garand_gl_zombie_upgraded, m2_flamethrower_zombie, m2_flamethrower_zombie_upgraded +36 | hide |
| `lewl` | playable hidden | 1 | 206 | 5 | 4 | ours 2, release 2 | crossbow_exp, crossbow_exp_upgraded, bo2_c_zom_dlc0_zom_sol_body1, bo2_c_zom_dlc0_zom_solciv_body1 | hide |
| `matrix` | playable hidden | 1 | 191 | 2 | 2 | release 2 | zombie_colt, zombie_colt_upgraded | hide |
| `nazi_zombie_decapit3` | custom-only hidden | 1 | 262 | 61 | 59 | release 59 | m1garand_gl_zombie, m1garand_gl_zombie_upgraded, m2_flamethrower_zombie, m2_flamethrower_zombie_upgraded +36 | hide |
| `nazi_zombie_dome_snow` | playable hidden | 1 | 158 | 5 | 3 | release 3 | aug, aug, zombie_cymbal_monkey | hide |
| `nazi_zombie_herren` | custom-only hidden | 1 | 189 | 19 | 2 | release 2 | char_ger_honorgd_bodyz1_1, char_ger_honorgd_bodyz2_1 | hide |
| `nazi_zombie_laboratory` | custom-only hidden | 1 | 198 | 6 | 6 | release 6 | m7_launcher_zombie, m7_launcher_zombie_upgraded, panzerschrek_zombie, panzerschrek_zombie_upgraded +2 | hide |
| `nazi_zombie_northco` | custom-only hidden | 1 | 213 | 45 | 28 | release 28 | zombie_bo_olympia_upgraded, zombie_perk_bottle_vulture, zombie_perk_bottle_vulture, zombie_dog_attack_look_down +24 | hide |
| `nazi_zombie_overlook` | playable hidden | 1 | 224 | 46 | 24 | release 24 | zombie_dog_attack_look_down, zombie_dog_attack_look_left, zombie_dog_attack_look_right, zombie_dog_attack_look_up +20 | hide |
| `nazi_zombie_pogreb` | custom-only hidden | 1 | 172 | 1 | 1 | release 1 | ptrs41_zombie_upgraded | hide |
| `nazi_zombie_projectx` | custom-only hidden | 1 | 196 | 4 | 4 | release 4 | zombie_kar98k, zombie_kar98k_upgraded, zombie_kar98k, zombie_kar98k_upgraded | hide |
| `nazi_zombie_puns` | playable hidden | 1 | 210 | 39 | 2 | release 2 | ai_zombie_window_attack_arm_l_out, ai_zombie_window_attack_arm_r_out | hide |
| `nazi_zombie_rc` | custom-only hidden | 1 | 282 | 69 | 6 | release 6 | g36c, g36c_upgraded, inter, inter_upgraded +2 | hide |
| `nazi_zombie_rooms` | playable hidden | 1 | 179 | 1 | 1 | release 1 | tesla_gun_upgraded | hide |
| `nazi_zombie_snowglobe` | custom-only hidden | 1 | 280 | 47 | 4 | release 4 | ballistic_knife_sickel, ballistic_knife_sickel_upgraded, ballistic_knife_sickel, ballistic_knife_sickel_upgraded | hide |
| `nazi_zombie_spruktbyl` | playable hidden | 1 | 293 | 109 | 109 | release 109 | aug_mp, aug_mp_upgraded, l86_mp, m1garand_gl_zombie +36 | hide |
| `nazi_zombie_test` | custom-only hidden | 4 | 272 | 13 | 11 | release 11 | sog_knife_w_bowie, zombie_evo, zombie_evo_upgraded, zombie_ksg +7 | hide |
| `nazi_zombie_test1` | playable hidden | 6 | 307 | 10 | 5 | release 5 | molotov, tesla_gun, tesla_gun_upgraded, tesla_gun +1 | hide |
| `nazi_zombie_wahnsinn` | custom-only hidden | 1 | 169 | 6 | 6 | release 6 | molotov, tesla_gun, tesla_gun_upgraded, zombie_cymbal_monkey +2 | hide |
| `necro_forest` | playable hidden | 1 | 159 | 4 | 4 | release 4 | m2_flamethrower_zombie, m2_flamethrower_zombie_upgraded, m2_flamethrower_zombie_upgraded, mine_bouncing_betty | hide |
| `no_way_out` | custom-only hidden | 1 | 179 | 3 | 3 | release 3 | m60e4_mp, t6_wpn_zmb_perk_bottle_cherry_view, t6_wpn_zmb_perk_bottle_cherry_view | hide |
| `number2` | playable hidden | 1 | 228 | 50 | 28 | patchable 24, release 4 | mk48, mk48_upgraded, mk48, mk48_upgraded +24 | hide |
| `sammycustomsbox` | playable hidden | 1 | 161 | 4 | 4 | release 4 | zombie_perk_bottle_deadshot, zombie_perk_bottle_mulekick, zombie_perk_bottle_phd, zombie_perk_bottle_staminup | hide |
| `sanatorium` | playable hidden | 6 | 237 | 21 | 4 | release 4 | enforcer, enforcer_upgraded, enforcer, enforcer_upgraded | hide |
| `zombie_seelow_v3` | playable hidden | 1 | 225 | 53 | 52 | release 52 | m1garand_gl_zombie, m1garand_gl_zombie_upgraded, molotov, panzerschrek_zombie +36 | hide |
| `ray_chirstmas_map` | playable hidden | 1 | 254 | 14 | 14 | ours 14 | bo2_c_zom_zombie1_body01, bo2_c_zom_zombie1_body02, bo2_c_zom_zombie2_body01, bo2_c_zom_zombie2_body02 +10 | fix |
| `a_room` | playable hidden | 1 | 174 | 1 | 0 | - | (minor) char_ger_zombieeye | minor |
| `ahkanto` | playable hidden | 1 | 179 | 1 | 0 | - | (minor) weapons/sp/zombie_bowie_flourish | minor |
| `chal_pistols` | playable hidden | 1 | 120 | 5 | 0 | - | (minor) c_zom_zombie8_body01_g_behead, c_zom_zombie_g_larmspawn, c_zom_zombie_g_llegspawn | minor |
| `chickn` | playable hidden | 1 | 191 | 1 | 0 | - | (minor) weapons/sp/zombie_knuckle_crack | minor |
| `corridor_challenge` | playable hidden | 1 | 120 | 5 | 0 | - | (minor) c_zom_zombie8_body01_g_behead, c_zom_zombie_g_larmspawn, c_zom_zombie_g_llegspawn | minor |
| `nacht_der_toten` | playable hidden | 1 | 155 | 1 | 0 | - | (client check) fraggrenade | minor |
| `nazi_zombie_fc2` | playable hidden | 1 | 154 | 1 | 0 | - | (client check) fraggrenade | minor |
| `salaj_dust2` | playable hidden | 1 | 120 | 5 | 0 | - | (minor) c_zom_zombie8_body01_g_behead, c_zom_zombie_g_larmspawn, c_zom_zombie_g_llegspawn | minor |
| `zombie_maze` | custom-only hidden | 1 | 160 | 1 | 0 | - | (minor) weapons/sp/zombie_bowie_flourish | minor |

The 50 live `unproven` maps (no log of them loading anywhere we hold; most were box-proven before
`--save-console` existed and the map cache has since evicted their logs) are in the re-proof queue.

### 13.4 Hidden today (live DB, 13:37 UK, backup `web/data/backup-20260923T123752Z-pre-hide`)

`maps.hidden = 1`, and `site_hidden: true` + `site_hidden_reason` in the manifest:

| map | why (all the release's own) |
|---|---|
| `nazi_zombie_dome_snow` (Zombie Dome) | box weapon `aug` and the Monkey Bomb weapon file `zombie_cymbal_monkey`: nowhere in the download |
| `nazi_zombie_snowglobe` (Snow Globe) | box weapon `ballistic_knife_sickel`: absent; also 40 Russian player-set models absent |
| `nazi_zombie_test` (Project Viking) | box weapons evo/ksg/m32/pdw exist only as loose `weapons/sp/*` in its IWD, which the engine does not read for a precache (labrats2: 46 of 46 the same); `sog_knife_w_bowie` absent |
| `nazi_zombie_test1` (Zombie Desert) | `tesla_gun` and `molotov` precached for the box, defined only in Der Riese's zone |
| `sanatorium` (Clinic of Evil) | box weapon `enforcer`: absent |

**Not hidden, though its verdict is `hide`: `nazi_zombie_fear_mc_2`.** Its release lacks
`bo1_c_viet_zombie_nva1_body` and three zombie heads (one is in its own `missingasset.csv`); B was
playing it on the box while this ran, and lane Z1 owns the map. Z1/B decide.

### 13.5 The gate

* `archive/asset_gate.py --map <bsp>` — fresh audit, exit 0 pass (`clean`/`minor`), 1 blocked
  (`hide`/`fix`/`patch`), 2 `unproven`; `--from-manifest` reads the recorded verdict.
* `archive/precheck.py --gate` refuses (exit 1) a blocked map; a never-booted map is `unproven`
  and passes there.
* `archive/popular.py --apply` (the step that un-hides a tranche after its box proof) keeps a
  blocked map hidden with `site_hidden_reason` (unproven passes: the refusal is for a miss).
* `web/server/lib/assetgate.js`: `import-archive.js` forces `hidden` for a manifest whose
  `asset_audit.verdict` blocks, whatever `site_hidden` says (test in `web/test/box-maps.js`).

Un-hiding a blocked map means fixing it and re-running the audit, not editing a flag.

### 13.6 Client screenshot recipe (for lane 13; written, not run)

What the server log cannot say: whether a player *wears* a player-set model, and every client-only
miss (materials, images). For each map on the client-check list — `nacht_reimagined`
(`aw_hazmat_viewhands`), `nazi_zombie_school` (`viewhands_sas_woodland`), `nazi_zombie_johndoe`
(`char_usa_marine_*`), `zm_nuked` (`fraggrenade`, `zombie_melee`), and the static flags
`nazi_zombie_hotelv2` / `nazi_zombie_octogonal` / `nuketown` (a weapon in the map's zone points at an
xmodel no loaded zone defines) — one local dedi + client run, off-screen, under `game.lock`, never
while B is playing on this PC (hard rules 3, 11, 12):

```
$env:ENW_TEST_NO_ACTIVATE='1'; $env:ENW_BORDERLESS_COVER='0'
$env:ENW_FRAME_CAPTURE='1'; $env:ENW_FRAME_CAPTURE_DIR='C:\Users\b\ZombiesDev\logs\dedi\a1-<bsp>'
$env:ENW_FRAME_CAPTURE_AT='12,20,30,45'
$env:ENW_FRAME_CAPTURE_CMDS='8:closemenu briefing|18:weapnext|28:weapnext|40:+melee|41:-melee|43:+frag|44:-frag'
powershell -ExecutionPolicy Bypass -File tools\dev\jointest.ps1 -Tag a1-<bsp> -Map <bsp> -ClientFrom dedi-client
```

Read: first-person hands present at 12 s and on both weapons (20, 30 s); knife and grenade at
40–45 s (zm_nuked); for johndoe a **second** client is needed to see a teammate's body. Then run
`python archive/asset_audit.py` again: the run's `archive\mods\<bsp>\console.log` is shared by
server and client, so the client-only `material`/`image` misses join the table. A hands-less or
knife-less frame makes that map's verdict `hide` by hand (`--write-manifest --hide <bsp>` after
editing the rule, or hide it in the DB with the reason in the manifest, as §13.4).

### 13.7 Unproven

* The 50 live maps with no log (queue: `ZombiesDev\archive\reports\reproof-queue.txt`, which is
  also a `box_proof.py --map-list`; leases were off, the coordinator runs it).
* The visible/minor split is a reading of names and scripts, not a picture: the client-check list
  above, and whether a missing zombie **head** variant is ever seen (it is precached; which spawns
  use it is the map's random pick).
* "Weapon files in an IWD are not read for a precache" is measured on our dedicated server
  (labrats2 46/46, nazi_zombie_test, matrix, rooms); a retail listen server was not run.
* Loose `.wav` are FS reads at play time and never produce a `Could not load` line, so no log shows
  the six maps' sounds fixed; a client listening is the proof.
* number2's misspelled `loacalized_number2.ff` (its dogs) could be staged under the loaded name
  (`install.add`, §9.6); the map is hidden for its absent `mk48` anyway.
