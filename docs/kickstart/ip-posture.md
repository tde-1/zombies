# IP posture — how ENW Zombies stays out of Activision's way (2026-09-22)

> **Not legal advice.** This is an engineering review written by an agent from public sources and
> the project's own research notes. Before any public or open phase, B should have it read by
> someone qualified. Claims are tagged **[V]** verified from a source read for this review,
> **[N]** from the vault's research notes (sources there), **[U]** unverified.

## 0. The decision (B, 2026-09-22)

1. **Everything that is Activision's reaches the player from the player's own installed copy of
   World at War, at runtime, on the player's PC.** The ENW client (DLL + launcher tooling) reads or
   converts it locally and caches it under `%LOCALAPPDATA%\ENWZombies`. It is **never uploaded and
   never served by us.**
2. **We serve only**: our own code and UI, community custom maps (third-party content, under the
   mod tools EULA — §2c), data we generate (replay tracks, records, stats), and ENW branding.
3. **Closed-testing carve-out**: while the project is invite-only (the seven approved players),
   the pre-baked assets that exist now (the Nacht `.glb` under `/mapdata`, anything else in §4
   marked "served in testing: yes") may stay. **This is temporary.** Every row in §4 has a trigger;
   the "Before public" checklist (vault `99 - Build Spec` §8) must be all ticked before the site,
   the launcher download or any replay link is opened to people outside the list.

## 1. What is Activision's and what is not

| Thing | Whose | Why it matters |
|---|---|---|
| `CoDWaW.exe` / `CoDWaWmp.exe` (with SteamStub) | Activision | Never distributed, never modified on disk; in-memory patches only (99 §0.3). SteamStub is itself an ownership check: the exe will not run without a Steam licence |
| `main/*.iwd`, `zone/**/*.ff`, sounds, videos, `localization` | Activision | Game data. Never served. The launcher junctions to the player's own install; the box runs its own Steam-licensed install |
| Stock maps (Nacht, Verrückt, Shi No Numa, Der Riese): geometry, textures, scripts, loadscreens | Activision (Treyarch) | The Nacht `.glb` on `/mapdata` is exactly this. **Largest current exposure** |
| Marks: CALL OF DUTY, WORLD AT WAR, TREYARCH, logos, key art, the CoD fonts | Activision | Never in our name, logo, domain, icon or key art. Plain-text nominative use only ("for Call of Duty: World at War") |
| "Zombies" as a word | Generic English; a CoD *game mode name* | No registration of "ZOMBIES" alone by Activision was found **[U]**; CALL OF DUTY is registered (USPTO reg. 3957781) **[V: Justia listing]**. See §3 |
| Community custom maps | Authored by mappers; **owned by Activision as derivative works** under the mod tools EULA **[V]** | Free redistribution is inside the EULA's intent; see §2c for the conditions |
| Stock assets compiled *into* a custom map's `.ff` (weapons, zombie models, `_zombiemode` scripts) | Activision | Rides inside a permitted custom map; we serve the map file as the mapper published it, never extracted |
| `enw_t4.dll`, the launcher, host agent, referee, site, replay format, viewer | **Ours** | GPL-3.0 client / AGPL-3.0 server (99 §0.3, §8: LICENSE files still to be written) |
| Addresses, struct notes, `docs/re/` | Ours (facts about an exe) | No decompiled code, no dumped Activision scripts in the repo (checked: zero `.gsc/.csc` tracked) |
| ENW mark, "ZOMBIES" wordmark in our lockup, olive/blood palette, Open Sans / Inter | Ours / open licences | Keep it that way: no CoD stencil fonts, no CoD red-and-black, no dog-tag art that copies theirs |
| Map names ("Nacht der Untoten", "Der Riese") and weapon names | Activision's titles | Nominative text use on map/record pages is fine; not in our branding |
| Third-party brands inside custom maps (Minecraft, Simpsons, MW2 Rust) | Those owners | Separate risk; rule 10 of vault 04: mirror, pull on complaint |

## 2. Precedents: what actually drew takedowns

### 2a. The pattern
Every Activision action on record hit one of three things **[N: R3 §4, R4 §5, R7]**: **(1) piracy
or play without owning** (serving or enabling game files), **(2) products competing with a current
release**, **(3) Activision assets redistributed outside the game**. Nothing on record hit a
free, ownership-requiring client that ships no game files.

| Case | When | What drew it | Source |
|---|---|---|---|
| alterIWnet / FourDeltaOne (MW2) | ~2012–2013 | Enabled pirated copies and DLC | [N] R3 |
| Irdeto for Activision → GitHub `armata/dwdump` | 2017-02-02 | **Dumped CoD game files in a public repo.** Closest analogue to a public `.glb` | [V] `github.com/github/dmca`, 2017/2017-02-02-Irdeto.md |
| SM2 | 2023-05-17 | C&D, no public reason; press tied the wave to piracy | [N] R3, R4 |
| X Labs (IW4x, IW6x, S1x) + BOIII self-shutdown | 2023-05-22 | C&D; all projects ended immediately. X Labs required owned copies — the letter came anyway, so ownership alone is not a shield | [V] X Labs' own shutdown notice (iw4x Tumblr, 22 May); [N] R3. (One search summary dated it 2024; the notice and R3 say 2023.) |
| H2M-Mod | 2024-08-15 | MW2 content in MWR, launching the day before BO6's window; creator says Activision cited BO6 sales | [N] R3 (GamesRadar) |
| Plutonium (T4/T5/T6/IW5) | 2023 → today | **No public C&D.** Added ownership checks ("pirate scanner") after the 2023 wave and is still operating (R15 trawled it 2026-09-22) | [V] ggrecon / Dexerto coverage; [N] R15 |
| T4M / T4M-Enhanced (WaW client patches, no licence) | 2010s → today | No takedown found | [U] absence of evidence |
| iw4x after X Labs | 2023 → | The GPL `iw4x-client` source is public on GitHub again (R16 uses it); who runs it now is unverified. **Never link its old `.dev` domain — it is now a gambling page** | [N] R16; [U] status |
| WaW custom-map sites (UGX, ZombieModding, ModDB) | 15+ years | No action found | [N] R3 [U] |

### 2b. Reading of the pattern for us
Risk rises with: serving Activision files (the `.glb` today), anything that looks like a
standalone game or a remaster, charging for access, and branding that implies affiliation. Risk
falls with: SteamStub intact, Steam ownership required, zero game files served, free, clearly
"not made or supported by Activision". X Labs shows none of this *guarantees* anything; it
changes what a letter could credibly claim, and what we would have to take down.

### 2c. The WaW mod tools EULA — read for this review [V]
Source: "End User License Agreement (Release of Map Tools to the Public for Call of Duty WW-PC).doc",
in the public re-upload `github.com/CallOfDutyModding/call_of_duty_world_at_war_mod_tools`. It says:
- Tools are licensed for "personal, non-commercial use" to create **New Game Materials** (maps, mods).
- If shared, New Game Materials must be shared **"solely without charge"**.
- They must be usable **only with the retail WaW** and **not as a stand-alone product**.
- They are **owned by Activision as derivative works**; Activision may use them.
- Each must carry the creator's name and the words **"THIS MATERIAL IS NOT MADE OR SUPPORTED BY
  ACTIVISION"** in any online description.
- "Commercial purposes" expressly include distributing New Game Materials "packaged in combination
  with the New Game Materials created by others" — i.e. **a bundle of other people's maps is fine
  only while it is free.**

**Consequences we adopt**: maps stay free forever, never behind VIP; every map page shows the
creator credit and the not-made-or-supported line; our client never makes a map run without a
retail WaW; we serve map files as published, never extracted into standalone assets.

### 2d. Other documents in play
- WaW retail licence: no distribution of the program, no reverse engineering **[N: R3]**. Our RE is
  in-memory on owned copies and ships no Activision code; this is the known, accepted exposure of
  every client of this kind.
- Steam Subscriber Agreement §2 on hosting via "modifying or adding components" **[N: vault 03 §8]**.
  Same.
- The box runs WaW under a Steam account that owns it (`iraq_loser`), several instances on one
  licence. Accepted for testing; recorded as exposure **[U]**.

## 3. The name

| Option | Risk | Notes |
|---|---|---|
| **ENW Zombies** (current) | Low **[U]** | "Zombies" is a generic word and a genre; the distinctive part is ENW. Risk comes only from pairing it with CoD trade dress |
| ENW ZM | Lowest | Short, already in 06's list; no generic word to argue about |
| ENW WaW | **Avoid** | Uses Activision's title as our brand |
| "Undead" / `undead.gg` | Lowest | Generic, loses the ENW family tie |
| Anything with CoD / Call of Duty / Nazi Zombies / Treyarch | **Never** | |

**Recommendation: keep "ENW Zombies" and `zombies.enw.gg`**, with three rules: never "CoD
Zombies" or "Call of Duty" in the name, logo, domain, app id, installer name or window title;
the footer and launcher About carry *"ENW Zombies is a free community project, not affiliated with
or endorsed by Activision or Treyarch. Call of Duty and World at War are trademarks of Activision
Publishing, Inc. Requires a Steam copy of Call of Duty: World at War."*; and keep **ENW ZM** as the
ready fallback (if a letter names the mark, rename in a day — `zm.enw.gg` already routes).
The vault folder "ENW COD Zombies" is internal and harmless; do not let it leak into any public
string.

## 4. Asset by asset

"Target" = where it comes from before public. "Testing" = may we serve it during closed testing.

| Asset | Current source | Target source | Served by us in testing | Trigger to change |
|---|---|---|---|---|
| Stock map geometry (world shell) | `export_map.py` + Husky on B's PC → `/mapdata/<bsp>.glb`, **public, gate-exempt** | Exported on the player's PC by the launcher (OAT + Husky-style read of the running game), cached `%LOCALAPPDATA%\ENWZombies\mapdata\` | Yes (Nacht only) — recommend behind the gate, see §5 | Before public; or any complaint |
| Custom map geometry | Not exported yet | Same local export. May be served from us **only** if built from the mapper's own brushes and textures (stock textures stripped, resolved locally) | Yes | Before public: stock-texture strip in place |
| xmodels (props, zombies, players) | None served (placeholders) | Local OAT dump → glTF | No | Keep at none |
| Viewmodels, animations, guns | None | Local only | No | Never served |
| Materials / skins / images | Inside the Nacht `.glb` (211 textures) | Local | Yes (in the `.glb`) | With the `.glb` |
| VIP in-game skins (Track G) | None | **Our own original art only**, or local recolours of local assets | — | Design rule now |
| Icons / HUD / perk / weapon icons | None on the site | Our own icon set; in game the engine draws its own | No | Never serve ripped icons |
| Stock map images / loadscreens | None (custom map previews only, `web/public/media/maps`, mapper-published) | Stock: local extract, or our own screenshots **[U: screenshots of a game are generally tolerated; still Activision's content]** | Custom previews: yes | Before public: no stock loadscreen on any served page |
| Sounds / music / voice | None | Local only | No | Never served |
| Fonts | Open Sans, Inter, system mono | Same | Yes (ours/open) | Never add a CoD font |
| Strings (weapon names, map names, perk names) | Text on pages | Nominative text | Yes | Fine |
| GSC scripts | Not in repo; OAT dumps stay in `ZombiesDev` | Local only | No | Never commit |
| Custom map files (`.ff`, `.iwd`) | Our mirror → launcher download | Same (§2c conditions) | Yes | Pull on any complaint (vault 15) |
| Game files for the client copy | Junctions to the player's install | Same | No | Launcher never downloads a game file |

## 5. The replay viewer

The track (positions, events) is ours. The **scene** is not. Options for the scene:

| Option | How | For | Against |
|---|---|---|---|
| A. **Local export, loopback serve** (recommended) | Launcher exports the map once on first need, writes the `.glb` under `%LOCALAPPDATA%\ENWZombies\mapdata\`, and serves it on `127.0.0.1:<port>` (it already runs a loopback server for sign-in, RFC 8252). The site's viewer asks the loopback for `<bsp>.glb?v=<built_at>` and falls back to the grid | Zero Activision bytes leave the player's PC. Ownership proof is implicit: only an install can produce the file | Needs the launcher installed; export needs a running game for the world shell (Husky reads memory — replay.md §4) or a fastfile-only degraded mesh; Chrome's Private Network Access rules for a public site calling loopback need a preflight header **[U]** |
| B. Local file pick | Viewer takes a dropped/picked `.glb` | No launcher coupling | Clumsy; players won't do it |
| C. Launcher-hosted viewer | The viewer runs inside the launcher window reading the cache directly | Simplest, no PNA issue | Replay links in a browser show the grid only |
| D. Keyed download | We serve the `.glb` only to a signed-in account with verified Steam ownership (Steam Web API `GetOwnedGames`/`CheckAppOwnership`, needs a key and a public profile), short-lived signed URL | Works in any browser | **Still us distributing Treyarch geometry**; a key costs Movement's key (vault 00, 2026-09-21: one key per Steam account); a leaked URL is a leaked file |

**Recommendation**: A for the browser (+ C as the zero-risk path in the launcher); D never for
stock maps. Custom maps may use D-less direct serving once their `.glb` carries only the mapper's
own textures. **Q-replay-2 resolved by this** (questions.md): during testing the Nacht `.glb` may
stay; recommended cheap step now is to put `/mapdata` back behind the gate with a signed
short-lived URL, since an ungated public URL is not "closed".

## 6. The launcher

- **Never distributes a game file.** It junctions the player's own `main/zone` (read-only, rule 1),
  copies the player's own exe into the player's own `%LOCALAPPDATA%` copy, and ships only
  `enw_t4.dll`, manifests and our UI. The CI/publish step must fail if the installer contains any
  `.ff`, `.iwd`, `.gsc`, `.dds`, `.iwi`, `.glb` or `.wav` (to add; not built).
- **Never modifies the Steam install or the exe on disk**; SteamStub stays intact (the LAA refusal
  proves it is live).
- **Local conversion tooling** (OAT GPL-3.0, a Husky-derived GPL-3.0 reader) runs as external
  programs on the player's PC; outputs stay in the cache; "Clear cache" deletes them.
- **Licences**: client DLL + launcher GPL-3.0, server/site AGPL-3.0 — recorded in vault 99 §0.3 and
  §8; the repo still has **no LICENSE file** (Q-replay-1). Writing them is on the Before-public list.

## 7. Ownership gate

1. **SteamStub** — the exe will not start without a Steam licence (measured: it refuses even a
   flag-bit change). This is the floor and it is free.
2. **Steam sign-in** (OpenID, no key) — identity, not ownership.
3. **Before public**: add an explicit ownership record. Cheapest honest path: the DLL reports the
   Steam `ISteamApps::BIsSubscribedApp(10090)` result (the game's own `steam_api` is loaded) through
   the invite-token handshake **[U: not probed]**; else the Web API with a *new* Steam account's key
   (never Movement's). Record `owns_waw` per account; no owned copy → no Play, no archive downloads,
   no loopback export.

## 8. DMCA / C&D response plan

- **Who receives**: a single address on the site footer and `/legal`, e.g. `legal@enw.gg` (to
  create — B's call, rule 8). B is the only person who replies. Register a DMCA designated agent
  with the US Copyright Office before public **[U: cost ~$6, needs B]**.
- **Within 4 hours of a notice naming Activision content**: take down `/mapdata` entirely (one env
  flag; the viewer degrades to the grid), any named file, and any stock-derived image. Box games
  keep running — they serve no files.
- **Within 24 hours of a notice about a custom map**: delist per vault 15 (keep the dark-archive
  original and the credit page).
- **On a C&D against the project as a whole**: stop public distribution of the launcher and pause
  the site behind the gate the same day; do not argue in public; B consults counsel before any
  reply beyond acknowledgement.
- **What we say** (acknowledgement template): *"Received. The material identified has been removed
  from [url] as of [time UTC]. ENW Zombies is a free, non-commercial community project; it serves no
  Call of Duty game files and requires a Steam copy of World at War. We are reviewing the rest of
  your letter and will respond."* Nothing else, no admissions, no counter-claims.
- Keep a log (date, sender, what, action, time) in the vault `15`.

## 9. Before public — checklist (mirrored in vault 99 §8 and 07 Track L)

- [ ] `/mapdata` no longer serves any stock-map export; the viewer loads scenes from the loopback/launcher cache (§5 A/C)
- [ ] Custom-map `.glb` exports carry no stock textures
- [ ] Launcher export tooling (OAT + world-shell reader) runs on the player's PC, cache under `%LOCALAPPDATA%\ENWZombies`
- [ ] Installer build fails on any game-file extension (§6)
- [ ] LICENSE files written (GPL-3.0 client/launcher, AGPL-3.0 server)
- [ ] Disclaimer in site footer, launcher About, download page (§3); "not made or supported by Activision" + creator on every map page (§2c)
- [ ] No CoD marks, fonts, logos, key art or ripped icons anywhere served (audit)
- [ ] Ownership record per account (§7), required for Play and downloads
- [ ] Legal contact + DMCA agent + response log live (§8)
- [ ] Name confirmed by B (§3)
- [ ] Nothing paid touches maps or play; VIP stays cosmetic and uses only original art
