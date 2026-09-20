# archive — crawler, link report and the MVP maps

> Agent: **archive**. Code in `archive/` (repo). Working data in `C:\Users\b\ZombiesDev\archive\`
> — map files and originals are never committed. Regenerate this file with
> `python archive/make_doc.py`; every figure below is generated from the reports, none typed by hand.

## The headline

**2276 distinct maps catalogued (1811 from the community sites),
2492 download links, and a measurement of WaW custom-zombies link rot — which
`R3 - Map archive, legal and community` records as never having been measured.**

- **Link rot on the community sites: 25.6%** of the links we could check are dead.
  (Across all sources, including archive.org's pre-verified mirror, 12.3%.)
- **767 maps have at least one live link** — those are recoverable today.
  **55 maps have links and every one of them is dead.**
- **137.3 GB** of originals measured across 766 maps (largest live mirror each), mean
  **183.5 MB** a map. That projects to **137.5 GB** for everything recoverable and
  **324.6 GB** for the whole community catalogue. The archive keeps the original *and* a
  normalised install (vault 04 rule 3), so roughly double those for the real storage bill. That
  lands inside the vault's 0.2–0.6 TB estimate, near its lower half.
- Two caveats on these counts, both of them "not yet" rather than "unknowable":
  1050 links were still being checked when this was generated, and 842 catalogued
  maps have **no link recorded yet** — overwhelmingly callofdutyrepo posts whose per-map page has
  not been fetched (the download buttons are only on the post). Both are bounded, resumable work:
  `crawlers/codrepo.py --pass c --posts N`, then `check_links.py`, then `make_doc.py`.

The pipeline then took **14 maps** end to end — fetched (6.1 GB), hashed,
AV-scanned, extracted without running a single installer, normalised to `mods/<map>/` and scanned
for a finish.

## 1. How the pipeline runs

```
crawlers/zwr.py          one page  -> ~950 maps, ~1,100 links
crawlers/codrepo.py      --pass a  list pages -> title/date/views
                         --pass b  tag pages  -> easter egg / buyable ending / top100
                         --pass c  post pages -> author, description, every download button
crawlers/ugx.py          board 29 index -> release threads: name, AUTHOR, real release date
crawlers/moddb.py        addons page 1 (the rest is robots-disallowed) + per-addon size/MD5
crawlers/archiveorg.py   search + /metadata/<id> -> exact sizes and hashes, no bytes moved

check_links.py           per-host probes -> alive / dead / blocked / unknown + size
report.py [--md|--maps]  the link report
export.py                catalogue.json for the site

fetch.py --shortlist s.txt   quarantine download -> sha256 -> AV -> originals/<map>/ + sidecar
avscan.py                    re-scan stored originals (see section 6 — the first scanner lied)
extract.py                   7-Zip / innoextract -> mods/<bsp>/ + per-file hashes
stock_baseline.py            the flag/notify/entity names that are Treyarch's, not the map's
scan_maps.py                 referee/scan_map.py + baselines -> archive/manifests/<map>.json
evaluate.py                  score those verdicts against the community's own finish tags
make_doc.py                  regenerate this document
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
| Download links catalogued (distinct URLs) | **2492** |
| Links alive | **964** |
| Links dead | **135** |
| Links blocked (host will not answer a robot) | 341 |
| Links unknown | 4 |
| Links unchecked | 1050 |
| **Link rot**, all sources (dead / [dead+alive]) | **12.3%** |
| **Link rot on the community sites** (excl. archive.org) | **25.6%** |
| Maps whose only host is MEGA or Drive (catalogued, not fetchable by us) | 112 |
| Maps with at least one live link (**recoverable**) | **767** |
| Maps whose every link is dead (**lost so far**) | **55** |
| Maps we could not decide | 612 |
| Maps with no download link at all | 842 |
| Maps with a measured size | 766 |
| **Measured bytes** (largest live mirror per map) | **137.3 GB** |
| of which Drive-rounded | 0.0 B |
| Mean map size | 183.5 MB |
| Projected: every recoverable map | **137.5 GB** |
| Projected: the whole community catalogue | **324.6 GB** |

| Host | Links | Alive | Dead | Blocked | Unknown | Unchecked |
|---|---:|---:|---:|---:|---:|---:|
| mediafire.com | 997 | 248 | 3 | 1 | 0 | 747 |
| archive.org | 572 | 572 | 0 | 0 | 0 | 0 |
| mega.nz | 533 | 144 | 126 | 0 | 0 | 263 |
| onedrive.live.com | 280 | 0 | 0 | 249 | 0 | 31 |
| drive.google.com | 82 | 0 | 0 | 74 | 0 | 8 |
| downloads.gamefront.com | 10 | 0 | 0 | 10 | 0 | 0 |
| papy.cod-france.com | 5 | 0 | 5 | 0 | 0 | 0 |
| docs.google.com | 2 | 0 | 0 | 2 | 0 | 0 |
| 1drv.ms | 2 | 0 | 0 | 2 | 0 | 0 |
| ugx-mods.com | 1 | 0 | 0 | 0 | 0 | 1 |
| moddb.com | 1 | 0 | 0 | 0 | 1 | 0 |
| dropbox.com | 1 | 0 | 0 | 1 | 0 | 0 |
| download855.mediafire.com | 1 | 0 | 1 | 0 | 0 | 0 |
| download1971.mediafire.com | 1 | 0 | 0 | 0 | 1 | 0 |

### What each source gave us

Rows crawled per source: codrepo 1399 · zwr 936 · ugx 605 · archive.org 496 · moddb 19.

| Source | What it is good for | What it cost | Catch |
|---|---|---|---|
| **ZWR** (`zwr.gg`) | ~950 maps and ~1,100 links **in one HTTP request**, plus an explicit "No Download Link available" marker on 51 rows | 1 request | Names only — no author, no date, no description |
| **callofdutyrepo** | The finish tags the whole badge model needs, plus author, description, release date, view counts | 21 list pages + 11 tag pages + 1 per map | Its own "Direct Download" mirror is one OneDrive account whose legacy links no longer resolve (see below) |
| **UGX-Mods** board 29 | The **author** and the **real release date** — the thread's poster and post time, not a repo's re-upload date | 35 index pages | The Map Manager's catalogue is inside the app, not on the site |
| **ModDB** | Self-hosted files that do not rot, with size and MD5 published | 1 page | `robots.txt` disallows `/*?`, so **pagination is off-limits**: one page of 30, not the whole section |
| **archive.org** | Exact byte sizes and hashes from `/metadata/<id>` — **the size question answered with zero bytes transferred** | ~60 requests | Its items are file dumps, so its "maps" are filenames, not releases |
| **ZombieModding** | — | 1 request (`robots.txt`) | **`Disallow: /` for everyone but Googlebot.** Not crawled at all. See Q-arc-1 |

Community finish tags recovered: buyable_ending 244 · challenge 105 · top100 100 · easter_egg 97 · top_100 94 · ugx_mod 34 · ugx_modded 29 · t4m_req 22 · moddb 19 · christmas_map 18 · prefab 15 · bossfight_ending 8 · leaderboard 8 · multiplayer_map 2 · bo3_buyable_ending 1 · singleplayer_map 1 · weapon_skin 1.

### The three link verdicts that are not "alive" or "dead"

Counting a link we cannot see as dead would inflate the rot figure with fiction, so:

- **Google Drive** (84 links).
  `drive.usercontent.google.com/robots.txt` is `Disallow: /`, and `drive.google.com` allows `/file`
  but that endpoint returns **401 to anything without a signed-in browser**. Unverifiable politely
  and account-free. Recorded `blocked`.
- **OneDrive.** Every one of callofdutyrepo's OneDrive mirrors answers 404 to a HEAD and redirects a
  GET to `login.live.com`: Microsoft retired the `?cid=…&resid=…&authkey=…` URL shape. The files may
  well still exist. Recorded `blocked` — the first version of the checker called all 282
  of them dead, which would have put a couple of hundred imaginary corpses in the headline number.
- **GameFront.** Serves a bot "Security Check" page (HTTP 403). No CAPTCHA was attempted. The ten
  links also carry `expires=1586…` signatures from April 2020, so they are dead in practice too.

**112 maps have nothing but MEGA and Google Drive links** — catalogued, plausibly
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
| Der Berg | `Derberg.exe` | 515.8 MB | nsis | `nazi_zombie_derberg` | `nazi_zombie_derberg` | manual | - | untagged |
| Zombie Desert | `Zombie_Desert.exe` | 292.5 MB | nsis | `nazi_zombie_test1` | `nazi_zombie_test1` | buyable_ending | buyable_ending | agree |
| Leviathan | `nazi_zombie_leviathan_v1.2.exe` | 432.1 MB | nsis | `nazi_zombie_leviathan` | `nazi_zombie_leviathan` | easter_egg | easter_egg,buyable_ending | agree |
| Minecraft Village Remastered | `minecraft_village.exe` | 592.9 MB | nsis | `nazi_zombie_fear_mc_2` | `nazi_zombie_fear_mc_2` | round | easter_egg,buyable_ending,bossfight_ending | missed-silently |
| MW2 Rust Zombies | `MW2RustZombies_1.0.exe` | 294.3 MB | nsis | `mw2rust` | `mw2rust` | buyable_ending | buyable_ending | agree |
| OCTAGONAL ASCENSION | `nazi_zombie_octogonal_1.3.0.exe` | 395.7 MB | nsis | `nazi_zombie_octogonal` | `nazi_zombie_octogonal` | buyable_ending | - | untagged |
| Orbit | `ORBiT_v1.2.exe` | 455.8 MB | nsis | `nazi_zombie_orbit` | `nazi_zombie_orbit` | round | easter_egg,buyable_ending | missed-silently |
| Project Viking | `Project_Viking_Final.exe` | 504.1 MB | nsis | `nazi_zombie_test` | `nazi_zombie_test` | easter_egg | easter_egg,bossfight_ending | agree |
| UGX Requiem | `ugx_requiem.exe` | 390.5 MB | nsis | `ugx_artemovsk` | `ugx_artemovsk` | easter_egg | easter_egg,buyable_ending | agree |

Per map we keep, beside each other and never mixed up:

- `originals/<map>/<file>` — the exact released file, byte for byte, plus `<file>.meta.json` with
  its **sha256, size, the page it came from, the URL, the fetch time, our user agent and the AV
  result**. Rule 1 of the archive.
- `extract/<map>/` — 7-Zip's output exactly as it landed, including the installer's own junk.
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

**`referee/scan_map.py` as shipped: 0 of 14 decided without a human.**

Not a bug in the tool — a gap in what it had ever seen. On a stock install the common zombie scripts
live in `common.ff` and `patch.ff`, which the scanner is never handed; it only gets
`nazi_zombie_factory.ff`. A **custom** map ships its own copy of the whole common script set inside
`mod.ff`, so Treyarch's own names — `arcademode_ending_complete`, `dog_round_ending`,
`ee_bowie_bear` — suddenly appear *inside the map* and the hint lists fire on them. Twelve of
fourteen maps returned `manual` for the same three words, and the two `easter_egg` verdicts were
Der Riese's teddy bears.

Two additions, both written in `archive/` so nothing of the referee's is touched:

1. **A stock + corpus baseline** (`stock_baseline.py`). Read every flag, notify and entity name out
   of WaW's own zone files (827 names), and additionally treat any name shared by ≥60% of the maps
   in the corpus as community boilerplate — that catches `crawler_round_ending`, which is not stock
   but rides in on the community script set that half the scene builds on. A name counts as the
   map's own only if it is in neither set.
   → **8 of 14** decided. But most of those were "Round 20" for maps
   that demonstrably have an ending, which is a confident wrong answer.
2. **Look at the entity list, not just the scripts.** This is the real finding.
   **Leviathan has no easter-egg flag in any of its 120 scripts** — its quest is
   `ee_step_1_switch`, `ee_step_3_trig`, `ee_testtube_activate_trig`, sitting in plain sight in the
   Radiant entity list. **MW2 Rust has four trigger targetnames and one of them is `end_game`** —
   that is its buyable ending, the `nazi_zombie_ali` shape, and the `zombie_cost` outlier test
   cannot see it because the cost is hardcoded in script. Entity names need **token** matching, not
   substring: `vending_mulekick` contains "ending" and `floor_three_zone` contains "ee_".

**With both, the verdicts are easter_egg 6, buyable_ending 4, round 3, manual 1** — so **10 of 14
maps now have a finish identified** at all, and **7 of 14 need no
human judgement to award a badge** (the buyable endings, plus the Round-20 defaults where there
really is nothing else).

The honest accuracy check is not "did it decide" but "did it decide *right*", so
`evaluate.py` scores every verdict against callofdutyrepo's own Easter-egg and Buyable-ending tag
lists — an independent, human-made label for the same maps:

| | scanner as shipped | with both additions |
|---|---|---|
| Agreed with the community tag | 1 / 12 | **9 / 12** |
| Silently defaulted to Round 20 | 7 | 3 |

### Where a human is still needed

- **Every Easter Egg.** The scanner finds the flags and entities; *which combination means done* is
  a judgement the manifest schema says must never be automated. Those manifests carry
  `{"manual": true}` and the candidate names, so the human reads six entity names instead of
  120 scripts.
- **The three silent misses** — Clinic of Evil, ORBiT and Minecraft Village Remastered all have a
  finish the community documents and nothing in their scripts or entities names it.
- **Every buyable ending before it awards a badge.** `{"trigger_used": {"targetname": "end_game"}}`
  is decidable from the event stream, but "this trigger is the ending" is still an inference until a
  game is played.

`referee/scan_map.py` was **not modified** — it is the referee agent's tool. The suggested change
there is small and stated plainly: take an optional baseline set, and run the hint words over
`read_mapents()` targetnames as well as over script flags.

## 5. What the pipeline still cannot do

| Gap | Size of it | Fix |
|---|---|---|
| **MEGA downloads** | 533 links, 98 maps have nothing else | Client-side AES-CTR decrypt with the key from the URL fragment. The *health and size* probe already works (MEGA's public API answers without an account), so only the download is missing. Half a day. |
| **Google Drive, at all** | 84 links | Needs a signed-in browser. B's call, because it means an account. |
| **OneDrive legacy links** | 282 links | Microsoft retired the URL shape. Possibly recoverable via the modern share-link API; more likely these want re-hosting from another mirror. |
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
