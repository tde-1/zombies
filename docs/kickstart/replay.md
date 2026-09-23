# replay — the 3D replay viewer

**Lane owns:** `web/client/src/replay3d/`, `web/client/src/pages/Replay.jsx`,
`web/server/routes/replay.js`, `tools/maps/`, this file, and one row in
[`README.md`](README.md)'s doc table. It does **not** own `server/`, `launcher/`,
`client-dll/` or `STATUS.md`, and it touches `web/` only where a new replay route needs
wiring (three inserted lines in `App.jsx`, `server/index.js` and `vite.config.js`, plus a
Watch button on the game page).

**Where the viewer lives, and why it is not `viewer/`.** ENW Movement's replay player is
not a separate app — it is `movement-client/src/replay3d/`, a folder inside the site,
reached from `/watch` and from a modal over a record row. Porting it to a standalone
`viewer/` would have meant porting the session, the theme tokens, the asset fetcher and
the router with it. So ours is `web/client/src/replay3d/` and the page is `/replay/:matchId`.

---

## 1. Where things stand

> **§7 (2026-09-23) is newer than this section and supersedes it.** The viewer is live on
> `zombies.enw.gg`, it plays the box's own game (`m_5de3842b`), and two bugs that only a
> real replay could find are fixed. Read §7 first.

Working, on this box, against a **real signed replay**:

| | |
|---|---|
| Replay | `C:\Users\b\ZombiesDev\replays\m_cf25a5dd.enwr` — `nazi_zombie_prototype`, `mode: verified`, signed footer, 1 player, 1 h 19 m, 5 rounds |
| Track endpoint | `GET /api/replay/m_cf25a5dd/track?hz=10` — 47 662 ticks, 4.4 MB JSON, **78 KB gzipped**, built in ~180 ms |
| Map | `C:\Users\b\ZombiesDev\maps\nazi_zombie_prototype\nazi_zombie_prototype.glb` — **37.8 MB**: the **world shell** (91 002 verts, 3 741 surfaces, 163 materials), **1 560 props** (54 script_model + 1 506 static), 211 textures, the map's own sky dome |
| Page | `/replay/:matchId`, linked from the game page's Replay card |
| Picture | [`ui/replay-nacht.png`](ui/replay-nacht.png) — round 5, five zombies up, third person |

**The world shell landed** on the follow-up run (2026-09-22 06:29–06:36, one authorised
game.lock hold of about six minutes). Husky read it out of the running game and
`export_map.py --world` folds it in, so the `.glb` is now the whole map: floors, walls,
boarded windows, the debris, and 1 506 baked static models that `map_ents` never had.
The grid and the "props and sky only" note are gone; both were conditional on
`world_shell: false` and that is now `true`.

---

## 2. What was taken from ENW Movement, file by file

Source: `C:\Users\b\Desktop\CSGO-Matchmaker\movement-client\src\replay3d\`.

**Licence.** *Neither repo has a LICENCE file* — checked `C:\Users\b\Desktop\Zombies\LICENSE`
and `C:\Users\b\Desktop\CSGO-Matchmaker\LICENSE`, and neither exists, nor any
`LICENSE.md`/`COPYING`. Both are B's own private projects, same owner, so there is no
licence conflict to resolve; there is also no licence *grant*, which matters the day either
repo is published. Flagged for `questions.md`, not resolved here.

### Copied byte-for-byte, not edited

| File | Size | What it is |
|---|---|---|
| `scene.js` | 119 KB | The renderer. Owns the WebGL context, the map group, the sky, the lights, the single player capsule, all three cameras, the quality governor. Knows nothing about React or time |
| `skywall.js` | 8.6 KB | Re-materials faces textured as sky so they occlude instead of becoming windows. Unused by Nacht today (no shell) and kept because `scene.js` imports it |
| `assets.js` | 11.5 KB | The asset fetcher: multi-URL fallback, progress, an LRU byte cache, in-flight request joining |
| `Boot.jsx` + `enw-mark.png` | 1.3 KB | The black loading surface with the mark and a progress bar |

Keeping these unedited is deliberate. Every line changed in `scene.js` is a line that has
to be re-applied the next time Movement's viewer improves, and Movement's viewer is
several agent-nights ahead of anything this lane would write.

### Copied as markup and CSS, rewritten as code

- **`r3d.css`** is Movement's `theme.css` lines ~8612–8935 (the ~200 `.r3d-*` rules) with
  three changes: `--panel2` renamed to this site's `--panel-2`; everything CS:GO-only
  dropped (jumpstats, crosshair, viewmodel FOV, loadout rows); the `.r3d-zm-*` blocks at
  the bottom added. It is a separate file, not an append to this site's `theme.css`,
  because the web lane owns that file.
- **`ReplayViewer.jsx`** is new, but the chrome is Movement's class-for-class: `.r3d-top`
  with the title and the three-way camera rail, `.r3d-bar` with play/pause, two skips, a
  native `<input type="range">` scrubber, the clock, the speed cog and fullscreen. The
  playback sampler, the camera keys (1/2/3), drag-to-look and wheel-to-zoom are Movement's
  behaviour. Movement's original is 1554 lines, of which roughly 1100 are KZ jumpstats, a
  CS:GO viewmodel rig, a crosshair-string parser and footstep audio — none of which a
  zombies game has, so they are not here.

### Deliberately **not** taken

`jumpstats.js`, `jumpstats-strafe.js`, `runstats.js`, `JumpstatsHud.jsx`,
`JumpstatsPanel.jsx`, `viewmodel.js`, `vmgloves.js`, `vmmotion.js`, `crosshair.js`,
`CrosshairCanvas.jsx`, `audio.js`, `AudioControls.jsx`, `RunnerHud.jsx`, `access.js`,
`WatchButton.jsx`, `RoutePlayer.jsx`, `gokz.js`, `shavit.js`, `surftimer.js`, `decode.js`.
The three timer decoders are CS:GO demo formats; ours is NDJSON out of our own server.

### New in this lane

- **`actors.js`** — the multi-player and zombie layer. `scene.js` draws exactly one
  player, because a KZ run has one runner. This adds up to four coloured capsules with
  canvas-sprite nameplates and a health disc, plus the zombies as **one `InstancedMesh`**
  (31 separate meshes would be 31 draw calls a frame for one repeated capsule). The
  focused player stays `scene.js`'s own capsule, driven by `setPose`, because that is what
  all three cameras read — so first person from any player is free. It also carries
  `installSkyDome`, which is the WaW-shaped difference from Source: a WaW map's sky is an
  **xmodel dome** named on worldspawn (`skyboxmodel "skybox_zombie"`), not six cubemap
  faces, so it is exported as a `__sky` node, taken out of the depth buffer, and pinned to
  the camera each frame.
- **`web/server/routes/replay.js`** — the track endpoint and the `/mapdata` static mount.

### Two bugs found while porting, both fixed here

1. **StrictMode kills the WebGL context.** The scene effect runs mount → cleanup → mount
   in development. The cleanup's `renderer.dispose()` loses the context on that canvas
   *permanently*, and the second `createScene` over the same element throws
   `Cannot read properties of null (reading 'precision')`. Fixed by creating the
   `<canvas>` inside the effect and removing it in the cleanup, so the second mount gets a
   second canvas.
2. **The map loads and is never drawn.** Movement's render loop is change-driven — paused
   and clean, it returns without drawing — and nothing in the asset-loading path is an
   input event. The map, the sky and the grid sat in the scene graph un-drawn until the
   viewer happened to be resized or dragged. Invisible when a human is present (moving
   the mouse hides it) and fatal to a headless screenshot, which is how it was found.
   Fixed with one `dirtyRef.current = true` after `precompile()`.

---

## 3. The track: what is recorded, and the gaps

The on-disk format is the `.enwr` container (`infra/host-agent/lib/replay.js`,
`docs/kickstart/host.md` §5): `ENWR` header, 60-second zstd chunks of NDJSON, a hash chain
and an Ed25519-signed footer. This lane **reuses the host agent's reader** rather than
writing a second implementation, exactly as `web/server/lib/replays.js` already does.

`GET /api/replay/<match>/track?hz=10` decodes the whole file server-side and returns a
dense columnar track. Server-side, and not a range-seeking browser decoder, for one
reason: `health`, `alive`, `score`, `weapon` and `stance` are **omitted when unchanged**
(`server/components/replay/replay.cpp`), so carrying them forward is stateful from the
first byte, and a chunk fetched alone by HTTP Range would show players with no score until
the next time it changed. The format has no per-chunk keyframe despite R9 §6 calling for
one. When the columnar CBOR body of R9 §6 lands, this endpoint is what it replaces.

```
{ match_id, map, map_name, mode, hz, tick_ms, ticks, duration_ms, max_round,
  players: [{ slot, name, steamid, pos:[x,y,z,…], ang:[pitch,yaw,…],
              health:[…], score:[…], alive:[0|1,…] }],      // one entry per tick
  zombies: [{ id, t0, pos:[x,y,z,…] }],                      // t0 = first tick
  rounds:  [{ ms, n }],
  events:  [{ ms, t, slot?, delta?, why?, text?, label? }] }
```

### Gaps, for the referee lane

These are what the viewer wants and the track does not have. None of them are blockers
today; all of them would make the picture better, and two of them are cheap.

1. **No `kill` event.** Kills are inferred from `points` where `why` is `kill` or
   `headshot`. That double-counts nothing today but it is an inference, not a record, and
   it cannot attribute a kill that scored no points. The simulator already tracks `kills`
   internally (`sim/engine.js`) and never emits it. *Cheap: one event.*
2. **No zombies-remaining-this-round.** Nothing in the protocol, the DLL or the simulator
   emits it. `snap.zombies.length` is *currently alive* and is capped at the 24–31 the
   engine will have out at once, so it is not the same number. The viewer says "Zombies
   up", which is the number it actually has. *Cheap: one field on the round event, or a
   counter on `snap`.*
3. **`round` is an event, never a snap field.** The viewer rebuilds a per-tick round array
   by carrying the last `round` event forward. Correct, but it means a replay that lost
   its first chunk does not know what round it is in. A round number on `snap` — one
   byte, unchanged for thirty seconds at a time, so free after delta-coding — would make
   every chunk self-describing.
4. **No roll on the view angle.** `ang` is `[pitch, yaw]`. Fine for a zombies game; worth
   knowing before anyone tries to reproduce a first-person view exactly.
5. **`weapon` disagrees with itself.** `replay.cpp:87` writes `p.integer("weapon",
   cmd->weapon)` — the uint8 usercmd index — while every file on disk carries a string
   (`"colt"`), because every file on disk came from the simulator. One of the two is
   wrong and the viewer currently shows neither.
6. **`stance` is in the protocol table and in `referee.md`, and `replay.cpp` does not
   emit it.** Only the simulator does. The viewer therefore never draws a crouched
   capsule, and passes `false` to `setPose`'s `ducked`.
7. **No verified replay from a real DLL exists.** Every file in `ZombiesDev\replays` with
   a footer has `dll_build: "sim-*"`. The one file with a real build
   (`m_9d14dd52.enwr`, `Sep 20 2026 00:58:12`) is 1 557 bytes and unsigned. So the whole
   viewer is proven against the simulator's output and *not* against the game's.

---

## 4. The map export pipeline — `tools/maps/export_map.py`

```
python tools/maps/export_map.py nazi_zombie_prototype
```

Idempotent (each step skips when its output is newer than its input; `--force` redoes
everything). Output lands in `C:\Users\b\ZombiesDev\maps\<bsp>\` and is served by the site
from `/mapdata/<bsp>/…`. **Nothing it produces may ever be committed** — a texture lifted
out of a stock map is a game asset however many times it has been re-encoded, so
`ZombiesDev/` is git-ignored and the site mounts it rather than copying it into
`web/public`.

### Tools, licences, commands

| Tool | Licence | Version | Used for |
|---|---|---|---|
| [OpenAssetTools](https://github.com/Laupetin/OpenAssetTools) Unlinker | **GPL-3.0** | release **v0.33.0**, 2026-08-31, prebuilt `oat-windows.zip` | Reading the T4 fastfile; xmodels → glTF, materials → JSON, images → DDS, map_ents → `.ents` |
| [Husky](https://github.com/Scobalula/Husky) | **GPL-3.0** | release **0.8.0.0**, 2022-06-05, `Husky.0.8.0.0.zip` | The world shell, out of the **running game's memory**. Also writes `<map>.map`, the static model placements |
| Pillow | MIT-CMU | 12.3.0 | DDS (DXT1/3/5) decode, alpha test, resize, re-encode |

OAT lives in `C:\Users\b\ZombiesDev\tools\oat\` — **not in the repo**. It is run as an
external program and nothing of it is linked or vendored, so its copyleft does not reach
this repo. A row for it is appended to the vault's
`18 - Reuse Register (projects to mine).md`.

What the script actually runs, and what B's install sees:

```
Unlinker.exe --model-format GLTF --image-format DDS
             --include-assets xmodel,material,image,mapents
             --search-path "<WaW>\main;<WaW>\zone\english"
             -o "<work>\dump\?zone?"
             "<WaW>\zone\english\nazi_zombie_prototype.ff"
```

**Read-only over the Steam install, always** (kickstart rule 1): Unlinker opens the `.ff`
and the 35 `.iwd`s and writes only under `-o`. The game is never launched and the game
lock is never taken.

### Three facts about WaW fastfiles, measured here

- `nazi_zombie_prototype.ff` is `IWffu100` + version `387` (LE) + **one plain zlib
  stream from offset 12**. `zlib.decompress(open(ff,'rb').read()[12:])` gives an 87 MB
  zone. Confirmed on B's file; matches the zeroy wiki's CoD5 note.
- `.iwd` is a plain PKZIP. `iw_00.iwd` has 808 entries; 9 331 `.iwi` across all 35.
- WaW `.iwi` is **version 6** (`49 57 69 06`), not 8.

### Why there is no world shell, and it is not for want of trying

`Unlinker --list` on the Nacht fastfile reports the zone's contents in full:

```
297 xmodel   542 material   709 image   1 mapents
  1 gfxworld   1 clipmap   1 comworld   1 gameworldsp
```

The world **is** in there, and OAT's T4 loader reads it. OAT has no *writer* for it.
`--include-assets gfxworld,clipmap,comworld -o <dir>` is not an error — it produces a
directory containing only the zone source file. Measured 2026-09-22 against v0.33.0, and
it matches OAT's own `docs/SupportedAssetTypes.md`, which marks GfxWorld, clipMap_t,
ComWorld and GameWorldSp as ❌ for both dump and load on T4.

What is in `map_ents` is not a substitute: 54 `script_model` placements (31 explosive
barrels, two couches, the wall weapons, the mystery box lid, a radio) and 127
`script_brushmodel`s — and a brushmodel is a reference (`*2`, `*3`, …) into the same
GfxWorld nobody can read. From WaW onward the map is baked into the fastfile as
GfxWorld/clipMap_t; there is no loose lumped `.d3dbsp`, and wiki.zeroy documents the
d3dbsp lump table only for CoD 1, 2 and 4. No CoD5 spec exists to write a parser against,
which is *why* every WaW map exporter is memory-based.

**The tools that do export a WaW world, and what they cost:**

| Tool | Licence | Works? | Catch |
|---|---|---|---|
| [Husky](https://github.com/Scobalula/Husky) | GPL | Yes, WaW listed — `.obj` + `.mtl` + a `.map` of static-model placements | **Reads the running game's memory.** "run the game, load the map you want, and run Husky" |
| [C2M](https://github.com/sheilan102/C2M) | GPL | Yes, maintained successor to Husky; also dumps JSON material/model data | Same — memory-based |
| Wraith Archon | proprietary freeware | WaW yes | Memory-based, and models/animations/images only — never world geometry |
| [Greyhound](https://github.com/Scobalula/Greyhound) | GPL-3.0 | WaW yes | `Load File` handles XPAK/IPAK/IWD/SAB — **not `.ff`** — so WaW is memory-only in practice; no world geometry either way |
| [cod-asset-importer](https://github.com/mauserzjeh/cod-asset-importer) | GPL-3.0 | Blender, file-based | WaW: **XModel only, D3DBSP ✗**. Only CoD1/UO/CoD2 get BSP |

Every one of them needs the game running. That was this lane's hard no until the
coordinator authorised **one** `game.lock` hold, which is the next section.

### 4b. The Husky run — done, 2026-09-22, and how to repeat it

Authorised, time-boxed, and it took about six minutes end to end. The record, because
the next map has to do exactly this again:

```
# 1. a fresh dev copy (never waw-d2 / waw-c1 / waw-c2 -- those are other agents')
powershell -File tools\dev\new-copy.ps1 maps

# 2. windowed, on the map, never `developer 1`. launch.ps1 takes game.lock, clears
#    __CoDWaW and answers the startup dialogs.
powershell -File tools\dev\launch.ps1 maps -Role solo -Visible `
  -GameArgs '+set r_fullscreen 0','+set r_mode "1280x720"','+map nazi_zombie_prototype'

# 3. drive Husky's GUI
powershell -File tools\maps\run-husky.ps1

# 4. kill ONLY our pid, delete the lock. Then, with the lock already released:
python tools\maps\export_map.py nazi_zombie_prototype --world <...>\nazi_zombie_prototype.obj
```

**Husky has no command line**, which is the part that costs the time if you do not know
it. `tools/maps/run-husky.ps1` clicks the button for you, and here is what it had to
learn the hard way:

- Husky 0.8.0.0 is **WPF**, so the window has **no child HWNDs** — `EnumChildWindows`
  returns nothing and the `PostMessage`-a-button trick that `launch.ps1` uses on the
  engine's dialogs cannot work. It is driven through **UI Automation** instead
  (`UIAutomationClient`, `InvokePattern`).
- The window has exactly **two unnamed 47×47 buttons and a `ConsoleBox`**. The paper
  plane is the **top** one (y≈83). The bottom one (y≈447) is *About* — clicking it
  opens a modal whose two buttons are "Github Repo" and "Donate", and clicking the
  first of those opens a browser. Both were clicked before the right one was found.
- `ConsoleBox` is the progress readout. Poll its `ValuePattern` rather than watching
  the filesystem: a half-written 11 MB `.obj` looks finished to a directory listing.

What it printed, which is also the proof it worked:

```
Found supported game: Call of Duty: World At War
Loaded Gfx Map     -   maps/nazi_zombie_prototype.d3dbsp
Vertex Count       -   91002      Indices Count  -   203895
Surface Count      -   3741       Model Count    -   1506
Converted to OBJ in 0.45 seconds.
```

Output, in `exported_maps\world_at_war\sp\<map>\`:

| File | Size | What we do with it |
|---|---|---|
| `<map>.obj` | 11.5 MB | The shell. Parsed by `read_obj`, grouped by `usemtl`, one glTF primitive per material |
| `<map>.mtl` | 23 KB | 163 materials, each naming `_images\<stem>.png`. We ignore the PNG path and take `<stem>.dds` from OAT's dump — **162 of the 163 are there**; the miss is `global_black_c`, which is a flat black material with no texture to find |
| `<map>.map` | 281 KB | **1 506 `misc_model` placements** with origin/angles/modelscale, and all 70 distinct models are in OAT's `model_export`. This is the other half of what GfxWorld was hiding: a stock map's props are baked in as smodels at compile time, and `map_ents` only ever carried the 54 a script can touch |
| `<map>_search_string.txt` | 1.7 KB | A Wraith/Greyhound search string. Unused — we already have every image from OAT |

**No lightmaps.** Husky exports position, normal and UV and nothing else; there is no
second UV set and no lightmap texture in the output. So the viewer lights the map with
`scene.js`'s analytic sun and hemisphere driven by the map's own worldspawn values,
exactly as it does for a Source map, and Nacht reads as the night map it is.

**Two things that had to be checked, not assumed:**

1. **Husky keeps CoD's Z-up frame.** Measured on the export: the bounding box is
   X −16418 → 14793, Y −14724 → 14699, **Z −477 → 3739**. One axis has a range of 4 216
   against 31 211 and 29 423, and that axis is the third — so Z is up, the file is in
   the same frame as the props, `map_ents` and the recorded player positions, and
   **nothing is transformed on the way in**. (The ±16 000 extent is the outer terrain
   shell, not the playable area.)
2. **The UV V axis is flipped on the way in.** OBJ's texture origin is bottom-left,
   glTF's is top-left; Husky already flipped CoD's top-left UVs on the way out, so
   flipping again puts them back. On a brick wall this is almost invisible; check it
   against a sign.

**And one size trap.** The first full export came out at **66 MB**, over the 60 MB
target, and almost all of it was textures kept as PNG. Most of a CoD map's colour maps
are DXT5 with an alpha channel that is **solid 255** — the format was chosen for the
material, not for that texture. `load_dds` now asks "does this image *use* its alpha"
(`getchannel('A').getextrema()[0] == 255`) rather than "does it have one", which moved
211 textures mostly to JPEG and the file to **37.8 MB**.

### Coordinates

The `.glb` is written in **raw engine coordinates**: CoD units (~1 inch), **Z up**, the
exact frame `snap.players[].pos` is recorded in. The viewer does the axis swap, and it is
Movement's, unchanged — `scene.js`'s `toThree`:

```
(x, y, z) -> (x, z, -y)
```

applied as `mapGroup.rotation.x = -Math.PI / 2` rather than per vertex. There is **no
scale factor anywhere**: Source units and CoD units are both inches, `scene.js`'s near
plane of 8 and far plane of 50000 are tuned for a map measured in them, and dividing by
anything would invalidate the depth-precision reasoning in its comments.

Baking the swap into the exporter was rejected: two conventions to keep in step instead of
one, and the referee's coordinates would then match neither.

**The check that it is right:** the replay's first recorded position is
`[333.5, 374.2, 34.6]`; the map's `info_player_start` is `[-37, 202, 57]`; the zombies walk
at `z = 32`. Player origin is at the feet in T4, so a floor at ~32 and a player at 34.6 is
a player standing on it, and the two numbers come from two completely separate files.

### Sidecar

`<bsp>.meta.json` carries what is not geometry: `spawn`, the map author's own `sun`
(direction, colour, `sunlight`, `ambient` off worldspawn — Nacht's is a cold blue moon at
0.75 with 0.1 ambient, and using it is the difference between "a night map" and "a grey
room"), the 634 `node_pathnode` origins, the 44 zombie spawner origins,
`brushmodels_unresolved: 127`, and `world_shell: false`.

Converting WaW's worldspawn lighting into `scene.js`'s Source-shaped `setLighting` — a
`THREE.Color`, a VRAD `_light` brightness where 200 is a normal outdoor sun, and a unit
direction — is in `ReplayViewer.jsx` and is the only place the two engines' light
vocabularies meet.

---

## 5. What is stubbed

- **Lightmaps.** Husky does not export them (§4b), so the map is lit analytically from
  worldspawn rather than with the light the map was baked with. It is the single biggest
  remaining difference from how Nacht looks in game.
- **(Superseded by §9, 2026-09-23: players and zombies are the game's own models now.)**
- **Zombies are capsules.** The 297 xmodels in the zone include
  `char_ger_honorgd_body1_*` — the actual zombie — and it exports. Placing a skinned model
  per zombie and animating it from positions alone is a bigger job than it looks and is
  not attempted.
- **Players are capsules**, as they are in Movement. Movement puts the runner's identity
  in the chrome rather than on a model; ours adds a nameplate because there can be four.
- **Weapon and stance are decoded and carried but never drawn** — see §3 gaps 5 and 6.
- **No audio, no viewmodel, no crosshair.** Movement's, and CS:GO-shaped.
- **Track is fully materialised server-side.** Fine to about two hours of game; a 24-hour
  session (the cap in the brief) would want the chunk-range seeking R9 §6 describes.
- **The `/mapdata` mount has no cache-busting.** `maxAge: '1h'` and a stable URL; a
  re-export inside the hour serves stale bytes to a browser that already has them.

## 6. What is next

1. **The 14 customs.** Each one needs **both halves**, and the second half needs the game:
   `export_map.py <bsp>` against `mods/<bsp>/<bsp>.ff` (the fallback path is already in
   `unlink()`, but no custom fastfile has been tried), then one `game.lock` hold per map
   to run `launch.ps1 ... +set fs_game mods/<bsp> +map <bsp>` and `run-husky.ps1`. Call it
   five minutes of lock per map once the first one has gone through. The unknowns are
   whether OAT unlinks a *custom* T4 fastfile as cleanly as a stock one (custom maps are
   built with modtools and may carry assets OAT's T4 list does not cover) and whether
   Husky's signatures find a map loaded under `fs_game`. Neither has been tested.
2. **Lightmaps**, if the map is ever to look the way it does in game — §5.
3. **The referee gaps in §3**, in the order they are listed — a `kill` event and a round
   number on `snap` are both one line.
4. **A replay from the real DLL**, so the viewer is proven against the game and not the
   simulator.
5. **Multi-player in anger.** The four-slot path is written and exercised only by
   single-player data; `m_2e346de4.enwr` (Der Riese, two players, signed) is the file to
   test it with once a two-player Nacht replay exists.

---

## 7. 2026-09-23 — the viewer goes live, and two bugs that only a real game could find

The goal for this session: when B and friends finish a Nacht game on the Hetzner box, the
game's page on <https://zombies.enw.gg> links to `/replay/:matchId` and the viewer plays it
with Nacht's world geometry. It does. What follows is what is served from where, what is
proven on the live site, and what is not.

### 7a. What is served from where

| URL | Served from | Headers | Gate |
|---|---|---|---|
| `/mapdata/<bsp>/<bsp>.glb` | `C:\Users\b\ZombiesDev\maps\<bsp>\` (**outside the repo**, git-ignored; `ZM_MAPS_DIR` overrides) | `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes`, 206 on a `Range` | **exempt** |
| `/mapdata/<bsp>/<bsp>.meta.json` | the same directory | `Cache-Control: no-cache` | **exempt** |
| `/mapdata/<anything missing>` | — | `404 text/plain`, never `index.html` | **exempt** |
| `/api/replay/<match>/track?hz=10` | decoded from the `.enwr` in `C:\Users\b\ZombiesDev\replays\` | gzip, in-memory cache by (match, hz) | behind the gate |
| `/replay/:matchId` | `web/client/dist` | — | behind the gate |

The `.glb` is 37.8 MB and **must never be committed** — §4's rule is unchanged. It is not
copied into `web/public` either: there is one copy on the box and the site mounts it.

**The cache pair is one mechanism, not two settings.** A year of `immutable` on a stable URL
would serve stale bytes forever after a re-export — §5's open item. So the sidecar carries
`built_at`, the track carries the sidecar's `built_at` (`map_export`), and the page asks for
`<bsp>.glb?v=<built_at>`. A re-export is a new URL for every browser at once, and the only
file that has to revalidate is the 30 KB one that knows the answer.

**`/mapdata` is now beta-gate-exempt**, alongside `/updates`. The case for it is in
`middleware/gate.js` and so is the case against, which is real and is B's to settle: a `.glb`
built by `export_map.py` is Treyarch's geometry and Treyarch's textures re-encoded, and
exempting it puts game-derived assets on a public URL with no password in front of them.
Nothing under `/mapdata` identifies a person, a game or a record. → `questions.md`.

**The mount is decided at boot** (`index.js` checks the directory exists). Export a map the
running site has never seen and it takes one restart to appear.

### 7b. Two bugs, and why every earlier proof missed both

Both were invisible until a replay recorded by the **real DLL on the real box** was put
through the viewer. Every replay this lane had ever tested against came from the simulator,
and the simulator differs from the game in exactly the two ways that hid them.

1. **`fileFor` returned a descriptor, not a path.** `lib/replays.fileFor()` answers
   `{ path, name, size, row }`; `routes/replay.js` passed that object straight to
   `readHeader(file)`, which threw `The "path" argument must be of type string ... Received an
   instance of Object`, and the endpoint dressed it up as a **422 "unsigned or truncated
   replay"**. It only ever took that branch when the match had a `replays` row — and no
   simulator replay has one, so every test went down the fallback branch, which returns a
   string. **The viewer had never once worked for a game the site had ingested.**
2. **The timeline's zero is the first snapshot, and the viewer measured from zero.** A real
   dedicated server boots, loads the map and waits for a player before there is anything to
   snapshot: game 2's first snap is at **ms 311 355**. Ticks are relative to that (`t0_ms`,
   which the track already carried); events are absolute. So every event landed 3 113 ticks
   past the end of an 880-tick track — the round counter stayed on "—" for a game that
   reached round 1, the feed was empty for its whole length, and the round marks sat off the
   right-hand end of the scrubber. The simulator's first snap is at ms 0, so the bug was
   exactly zero ticks wide for every file it was tested against.

### 7c. A box's replay is a pointer, and the bytes were never here

`/api/gs/result` posts `file` — an absolute path on the **box's** filesystem. Game 2's row
says `/home/waw/zdev-host/replays/m_5de3842b.enwr`, which does not exist on B's PC, so the
track endpoint answered "no replay file for that match on this machine" for every real game
ever played. On the dev box this was invisible because the box and the site were one machine.

`routes/replay.js` now **pulls the file once** when it is missing: `scp` over the ssh alias
named by the box (`zombies-dev` is already a `Host` in `~/.ssh/config`), into
`ZM_REPLAY_DIR`, after which it is a local file like any other. Only the basename is used and
it must equal `<matchId>.enwr`; the destination is re-checked inside `REPLAY_DIR`; `scp` is
spawned with `execFile`, so there is no shell; a failure is cached for 60 s so a dead box is
not dialled once per request. `ZM_REPLAY_PULL=off` disables it, `ZM_REPLAY_PULL_HOSTS` is a
JSON map for boxes whose name is not their ssh alias. All three are in `infra/site.env.example`.

**This is a stopgap and should be retired.** The right answer is `lib/replays.js`'s
`object_key` seam (R2) or the host agent POSTing the bytes with the result — both other
lanes'. What it buys is that tonight's games are watchable without anybody running a command.

### 7d. The referee's new fields are now used (§3 gaps 1, 2, 3 — closed)

The 2026-09-22 DLL emits what §3 asked for, and the track and the viewer read it:

* **`kill`** is its own event (`{t:"kill", id, round, how}`) and is in `FEED_EVENTS`. It is
  drawn in the feed as `kill · <how>`. This matters more than it sounds: the first real
  game's one kill is `how: "entity_gone"` with **no `points` line beside it**, which is
  precisely the kill §3 said an inference off `points.why` could never attribute.
* **`snap.zombies_alive` and `snap.kills_round`** come down as two per-tick columns
  (delta-carried like every other snap field) behind a `has_counters` flag. The HUD says
  **"Zombies left N · killed M"** when they are present and falls back to its old
  "Zombies up N" — its own count of zombie tracks — when they are not. The two are
  different numbers and are labelled differently on purpose.
* A file recorded before the counters existed gets `null`, not `0`, so a quiet round and an
  old format are never confused.

`weapon` and `stance` are emitted now (`"#0"`, `"stand"`) and are still carried-but-not-drawn
— §5 is unchanged on that.

### 7e. A replay whose map has no export still plays

Previously a missing `.glb` threw, and the page was a red error string over black. Now the
**server says up front** whether geometry exists (`map_export` on the track), the page passes
`mapUrl: null`, and the viewer draws the actors over `scene.js`'s grid **at the lowest z any
player or zombie is recorded at** — a floor, because T4 puts a player's origin at the feet —
with the note *"No world model for `<bsp>` yet — showing players and zombies over a grid at
the floor they walked on."* A fetch that fails for any other reason lands in the same place
with the cause printed. **There is no path from here to a blank page.**

### 7f. Proven live, with URLs

The site was rebuilt and restarted four times through the authorised path (`npm run build`,
`Stop-Process` the port-3200 pid, `infra\keepalive.ps1 -Once`, which loads `infra/site.env`).
`cloudflared` was not touched and `web/data` was not written to by hand.

| Claim | Evidence |
|---|---|
| The map is served publicly, cached and range-able | `GET https://zombies.enw.gg/mapdata/nazi_zombie_prototype/nazi_zombie_prototype.glb` with `Range: bytes=0-1023` → **206**, `Content-Range: bytes 0-1023/39612576`, `Cache-Control: public, max-age=31536000, immutable`, **no password** |
| The sidecar revalidates | `.../nazi_zombie_prototype.meta.json` → 200, 30 107 B, `Cache-Control: no-cache` |
| A map with no export is a 404, not the React app | `.../mapdata/no_such/no_such.glb` → 404 `text/plain` |
| **The box's real game plays, with world geometry** | <https://zombies.enw.gg/replay/m_5de3842b> (game id 2, `nazi_zombie_prototype`, box `zombies-dev`, real DLL `Sep 22 2026 07:38:34`) — **`ui/replay-live-nacht.png`**: Nacht's walls, floor, crates and debris; the player capsule; **ROUND 1**; **Zombies left 3 · killed 1**; `1:14 kill · entity_gone` in the feed; the round mark on the scrubber; 1:15 / 1:27 |
| The track is real, not a stub | `GET /api/replay/m_5de3842b/track?hz=10` → 200, `ticks=880`, `has_counters=true`, `map_export.glb=true`, one `kill` event, `zombies_alive` peaks at 4 |
| A replay whose map has no export still plays | <https://zombies.enw.gg/replay/m_2e346de4> (`nazi_zombie_factory`) — **`ui/replay-live-noworld.png`**: two named players with scores, **ROUND 7**, a bleed-out in the feed, eight round marks, and the note. `map_export.glb=false` |
| The link from the game page exists | `/game/m_5de3842b` → the Replay card → **Watch in 3D** → `/replay/m_5de3842b` (`pages/Misc.jsx`) |

Screenshots are headless Edge at 1600x900 over CDP (`--headless=new --enable-unsafe-swiftshader
--use-angle=swiftshader`), driven with `Network.setCookie` for the beta gate and a
`Runtime.evaluate` that clicks the +15 s button to seek. WebGL 2 works under SwiftShader; the
only console line is `KHR_parallel_shader_compile extension not supported`.

### 7g. What is NOT proven, and what is still wrong

* **No Nacht replay with downs or a multi-player round exists.** The box's five games are all
  round 1, one player, one kill. Kills-and-downs on a Nacht map is **unproven**; the downs,
  revives and bleed-outs in `ui/replay-live-noworld.png` are the **simulator's** Der Riese
  file. Tonight's game is the first chance to see a real one.
* **Player names are missing from a real replay.** `m_5de3842b` has no `player_connect`, so
  the viewer says **"Slot 0"**. That is STATUS's open identity item, not a viewer bug — the
  referee has to derive the Steam id from the invite token before there is a name to draw.
* **The stretch was not attempted.** Verrückt, Shi No Numa and Der Riese are still unexported:
  each needs a `game.lock` hold for Husky, and the lock was held by the launcher lane
  (`launcher 31164 ... nazi_zombie_prototype`) for the whole session. `nazi_zombie_prototype`
  is the **only** map with geometry; every other replay takes the grid path of §7e.
* **The pull is untested against a box that is offline or slow.** The 60 s timeout and the
  60 s failure backoff are written; only the success path has been run.
* **The track cache outlives an export.** A track decoded before a map was exported keeps
  `map_export.glb: false` until the site restarts — the same restart §7a already needs.
* **`weapon`, `stance`, lightmaps, skinned zombies** — §5, unchanged.

---

## 8. 2026-09-22 (late) — SPEC: "functionally identical to Movement's viewer"

B watched `m_0afb449b` (Nacht, site game, box `zombies-dev`) in the launcher and listed eight
gaps. Reference: `C:\Users\b\Desktop\CSGO-Matchmaker\movement-client\src\replay3d\`. Each item
says what is wrong, *why* (measured, not guessed, where marked), what data it needs, and
where the work lands. Order and effort at the bottom.

### 8.1 First person does not switch — viewer only, ROOT CAUSE FOUND

`ReplayViewer.jsx` put the drag handler on the **wrapper** and called
`setPointerCapture` on every `pointerdown`. The wrapper contains the top rail and the
control bar, so a press on *First person* or *Play* captured the pointer to the wrapper;
the `click` then fires on the common ancestor of the down/up targets — the wrapper — and
**the button never gets its click**. Keys 1/2/3 and Space worked all along; the range
input survived because it acts on `input`, not `click`. Movement binds the drag to the
**canvas** (`onPointerDown` on `<canvas>`, `ReplayViewer.jsx` ~1218). Fix: drag only
when the press lands on the canvas.

### 8.2 Play does nothing — same root cause as 8.1

Same capture. Also: the playhead starts at tick 0, and on a real game tick 0..~74 is the
player at `[0,0,0]`, dead, before spawn (first `alive` at tick 74 on `m_0afb449b`). Start
the playhead at the first live tick (Movement starts at the run's lead-in, same idea).

### 8.3 Props at wrong transforms — FIX the export (not drop), cause measured

OAT's glTF writes vertices **Y-up** (a sandbag's `POSITION` max is `[10.5, 9.7, 16.5]`:
height in Y) and, on skinned models, a `tag_origin` root rotated −90° about X.
`merge_model` copies the meshes and **drops every node transform**, then places them in a
Z-up map with the map's own `angles`. So every prop lies on its side: its up axis points
along world −Y, which reads as chairs, crates and sandbags floating or jutting from walls.
The world shell (Husky OBJ) is Z-up and is right, which is why only props are wrong. Fix:
each placement's quaternion becomes `q_angles ⊗ Rx(+90°)`, and the `__sky` dome gets
`Rx(+90°)` too. Keeping props rather than dropping them because the cause is one
constant and the 1 506 baked static models are most of what makes Nacht look like Nacht.

### 8.4 Zombies never appear — track bug, not a DLL gap (measured)

The DLL records them: `m_0afb449b` has **995 snaps with a `zombies` list, up to 7
zombies**, each `{id, pos, health}`. `buildTrack` samples every *other* snap at 10 Hz
(`snapIndex % 2 === 0`) and reads `zombies` only from the sampled snap — and the DLL puts
the list on **even server frames**, which on this game are the **odd** snap indices. So
every zombie sample was skipped: `track.zombies.length === 0`. Fix (host-side reader in
`web/server/routes/replay.js`): carry the latest zombie list forward and sample it on the
strided tick. Then, from the DLL, per zombie: **yaw** (`currentOrigin+12`, the same read
the player uses — one float), later an **anim state** (walk/run/sprint/crawl, needs the
AI struct: `re` lane) and a **gib/crawler** flag. Alive/dead is already implicit (the
entity leaves the list) and the `kill` event marks it. Drawn as red capsules today,
oriented by yaw once it is recorded.

### 8.5 Camera flies through the outro — viewer + track

Replay `m_0afb449b` has no `game_over` event; the referee's `recording()` never stopped
the sampler, and the tail after `notify intermission` (ms 122 304) is the intermission
camera path — the player capsule "flies". Track: carry `end_ms` = first of `game_over` /
`notify intermission`. Viewer: the scrubber ends there. DLL (referee lane): stop
sampling on `intermission` as well as `game_over`, so the file itself is clean.

### 8.6 Grenades — DLL + host + viewer

Nothing records them. DLL: in the 10 Hz zombie pass, also collect entities whose
classname is `grenade` (CoD's `G_FireGrenade` classname; **unverified on T4**, so the
sampler also logs each *new* non-actor classname it sees once, and B's next game settles
it) as `snap.nades: [{id, pos}]`; when a nade id leaves the list emit
`{t:"explode", id, pos}` at its last position. Host: `nades` carried like zombies,
`explode` into the feed. Viewer: small dark-green spheres, and a short-lived orange
sphere + ring at each explosion.

### 8.7 Crosshair + placeholder viewmodel — viewer (+ one track column)

Crosshair: WaW's is four ticks around a gap that opens with movement speed and firing
and closes back at a per-class rate. Needs **speed** (derived from positions, already
there) and **fire** — `input` events carry `buttons` on change; bit `0x1` is taken as
attack (**[H]**: on `m_0afb449b` masks `1`, `8195`, `4196353` all carry it and appear
in firing moments; confirm on B's next game), carried into the track as a `fire` column.
Per-class base/max spread from the weapon name when the DLL resolves names (today the
weapon is `#<index>`, §3 gap 5), a rifle default meanwhile. Viewmodel: a **procedural
placeholder** built from three primitives in `actors.js` — no downloaded asset, no
licence question — that kicks on `fire`. If B wants a real mesh, the proposed source is
**Quaternius "Ultimate Guns" (CC0 1.0, quaternius.com / poly.pizza)**; it needs B's OK
to download. No WaW viewmodel is ported, ever.

### 8.8 Der Riese and Nacht

Nacht: 8.3 re-export. Der Riese (`nazi_zombie_factory`): the **OAT half** (props,
map_ents, sun, pathnodes) runs with no game; the **world shell needs Husky, which needs
the running game** (§4b) — forbidden while B is at his PC (no `game.lock`). So Der Riese
gets a props-and-sky export on the grid now, and the shell on the next authorised
six-minute lock hold (§4b's four commands, `+map nazi_zombie_factory`).

### 8.9 Order of work, and effort

| # | Item | Lands in | Effort |
|---|---|---|---|
| 1 | Pointer capture → canvas (8.1, 8.2) | viewer | 10 min |
| 2 | Zombie carry-forward (8.4) | `routes/replay.js` + test | 20 min |
| 3 | Outro clamp + start at first live tick (8.5, 8.2) | track + viewer | 20 min |
| 4 | Prop/sky axis fix + Nacht re-export (8.3) | `export_map.py` | 20 min |
| 5 | Crosshair + fire column + placeholder viewmodel (8.7) | track + viewer | 1 h |
| 6 | Zombie yaw + nades + explode (8.4, 8.6) | DLL `replay.cpp`, host test, viewer | 1.5 h |
| 7 | Referee stops on `intermission` (8.5) | referee lane | 15 min |
| 8 | Der Riese OAT half now; Husky half on a lock hold (8.8) | `tools/maps` | 10 min + 6 min lock |
| 9 | Zombie anim state, skinned zombies, weapon names | `re` + DLL + viewer | days |

2026-09-22 IP posture: stock-map `.glb` on `/mapdata` is a closed-testing carve-out only; before public the scene comes from a local export on the player PC via loopback or the launcher.
See [`ip-posture.md`](ip-posture.md) §4-§5 and §9 (Q-replay-2 resolved in `questions.md`).

### 8.10 Done tonight, and what is proven

| Item | State | Evidence |
|---|---|---|
| 8.1 First person | **fixed, proven** | mouse click on *First person* in a local instance of the same build (port 3399, copy of the DB, gate off): rail shows it on, placeholder gun + crosshair drawn |
| 8.2 Play | **fixed, proven** | a SECOND cause turned up: the site's `.chatdock` (fixed, z 70) spans the whole bottom edge at a narrow width and sat on the Play button (`elementFromPoint` on Play → `DIV.chatdock`). Hidden on the replay page in `r3d.css`. Mouse click on Play → clock 0:07 → 0:11 in 4 s |
| 8.3 Props | **fixed** (`export_map.py`, `Rx(+90)`), Nacht re-exported (37.8 MB, 1 560 props) and live; old file kept at `maps/_work/nazi_zombie_prototype.glb.pre-axisfix`. Sandbags on wall tops and crates on floors in the verify pane; **B's eye on the full map is the real proof** |
| 8.4 Zombies | **fixed in the track, proven**: `m_0afb449b` 0 → 13 zombie tracks; a red capsule drawn behind the player at 0:50. DLL now also writes `yaw` (deployed, not yet seen with a zombie in a file) |
| 8.5 Outro | **clamped, proven**: `end_ms` 122 304 (the `intermission` notify); scrubber 1:55 instead of 2:10; playhead starts at the first live tick (0:07) |
| 8.6 Grenades | DLL + track + viewer written; DLL deployed to all 7 box copies and booted a map (`m_10609df5`, fake player, cancelled). **Unproven**: the census on that boot saw no grenade (nobody threw one); whether T4 calls it `grenade` is B's next game — `grep census enw-*.log` |
| 8.7 Crosshair / gun | scaffold live; `fire` = `input.buttons & 1` **[H]**; every weapon uses the rifle row until names resolve |
| 8.8 Der Riese | OAT half exported (13.6 MB, 125 props + sky, `world_shell: false`) and served; the shell still needs one Husky lock hold |

The live `/replay/m_0afb449b` was **not** opened in a browser by this session: the beta gate
needs its password typed, which this agent may not do. The site was restarted on the new
build through the authorised path, `/mapdata` (ungated) answers with both maps, and the
identical build was driven in the verify instance. B's first look is the live proof.

### 8.11 2026-09-22 (evening) — WaW HUD, crosshair, grenade, damage, and position accuracy

> **Corrected by §8.12:** the Husky shell was 2.54× too big (centimetres). The position rows
> below that blame the shell ("walls missing", "zombie z", "506 floating props") were that scale.

Branch `replay-waw`. B's asks: maps clean, zombies visible and facing, WaW's round HUD with a
zombies-left counter, a crosshair "very accurate to the real game", the grenade cook, obvious
hits, and (via the coordinator) **positions that line up exactly**. Tested against the two real
replays, `m_0afb449b` (Nacht, B, 2 rounds) and `m_5de3842b` (Nacht, round 1, one hit), on a dev
copy (port 3431, a copy of the DB, a scratch map export). The live site, `web/data` and the live
map export were not touched; the game was not launched. Screenshots: `docs/kickstart/ui/replay-waw-*.png`.

**Sources, read-only.** The game's own weapon files and scripts, unlinked from B's
`nazi_zombie_prototype.ff` / `common.ff` with OpenAssetTools; the replay header's script
fingerprint (`9a260a45…d031`) is byte-identical to the extracted `_zombiemode.gsc`. The HUD
textures (`side_small`, `center_cross`, `chalkmarks_1..5`, `hit_direction`,
`overlay_low_health`, `grenadeicon`) were decoded to look at and are **not shipped** — everything
drawn is CSS/SVG. The engine formulas are from **KisakCOD** (SwagSoftware, GPL-3.0, a source
reimplementation of CoD4/IW3, which T4 is built on), read for formulas only; every HUD dvar name
used is also a string in B's `CoDWaW.exe`, so the elements exist in T4, but their **default
values are CoD4's** and are [H] for T4. No GitHub/OBS/ReShade "CoD crosshair" overlay was worth
copying: the ones found draw a static cross; the real shape and motion come from the engine code
above.

#### Position accuracy (the coordinator's item 0)

The frame is right and was right: the `.glb` is raw engine units, Z up; the map group and every
actor go through the same `(x, y, z) -> (x, z, -y)` (`mapGroup.rotation.x = -90°` and
`toThree`), no scale, no offset. WaW yaw 0 = +X, counter-clockwise; pitch positive = down —
`scene.js forwardOf` is exactly that. **Measured:** player origin minus the rendered floor under
it, median **−1.4 u** (p5 −4.0) over 218 in-game samples of `m_0afb449b`, −1.1 on `m_5de3842b`;
the recorded yaw points **inside the target zombie's 15-unit half-width on 13 of 15 aimed shots**
(errors 0.0–1.8°, 0.0° at 966 u; the 71.58 s shot is 1.8° off a zombie 183 u away that is gone
in the same 50 ms tick, and the 97.68 s and 103.59 s shots each kill within 0.4 s). What was
wrong, and by how much:

| # | Wrong | By how much | Fix |
|---|---|---|---|
| 1 | **49 brush-model islands (1 236 triangles) piled on the engine origin** — barricade planks 140 u tall and 140 u deep through the start-room floor, trim chunks, a door, the "help" sign. Husky writes a `script_brushmodel`'s geometry in its local space; the engine moves it, Husky does not. The origin is the middle of Nacht's start room, so the player "walked through" them | recorded positions within 13 u of a wall face: **23 of 217 → 3 of 217** (the 3 left are a rubble slope and a window sill) | `export_map.py drop_origin_brushmodels` |
| 2 | Eye height and hull were Source's (eye 64/46, capsule r16 × 72) | eye **4 u high** standing, 6 crouched, prone not modelled | WaW 60 / 40 / 11 and r15 × 70 / 50 / 30 (bg_pmove), per stance from the usercmd bits |
| 3 | First-person FOV was CS:GO's 90 | a 38 % wider angle than the game | `cg_fov` 65 (4:3 horizontal) |
| 4 | Zombies sampled on the other server frame from the players, and not interpolated | 50 ms behind (≈2 u walking, ≈5 u running) and stepping at 10 Hz | the track samples on the zombie frames; zombies lerp like players |
| 4b | **The time base drifted.** Tick k was drawn at `t0 + k · 100 ms`, but server frames are not exactly 50 ms apart | by the end of `m_0afb449b` the grid was **674 ms** off the snaps' own clock: every event (weapon change, hit, down, frag) sat 0.7 s away from the positions it belongs with | the track carries `tick_t` (each tick's real ms) and the viewer maps time through it; the weapon changes now land on 14 308 / 69 106 / 118 305 ms exactly |
| 5 | **View pitch is not recorded.** `ang[0]` is the player *entity's* pitch, which the engine keeps at 0: every in-game snap of both files has pitch 0 (the 24.2 / 355 values are the intermission camera) | first person always level | **DLL change**: `cmd_ang` (usercmd angles); the host calibrates delta at spawn (§ DLL below) |
| 6 | Zombie z | inside the building, median −0.4 u, p10 −12.5 u under the rendered floor | **not changed**: the map's own explosive barrels (map_ents, not Husky) sit 5–14 u under the same floors, so shell and engine ground disagree by a few units in places |
| 7 | **The Husky shell is missing walls** | 12 of 15 aimed shots pass through a rendered wall; rays west from x = −150 at 45 u find no wall for y −750..+300, though the map's `exterior_goal`s put windows at x = −266; only two ~70-u wall pieces exist there. No translation within ±64 u clears the shots, so it is missing/misplaced geometry, not an offset. The recording agrees with the map entities (zombie 256 stood 25 u from the (288, −257) window goal; B shot out of the (−266, −751) window) | **open**: needs a second Husky run (a `game.lock` hold) or C2M; `aim-above.png` looks across the rubble the shell puts on that line of fire |

#### Map clutter (ask 1) — `tools/maps/export_map.py`, Nacht re-exported to the scratch dir

| Change | Nacht |
|---|---|
| origin brush models dropped (row 1 above) | 49 islands, 1 236 triangles |
| alpha-tested materials written `alphaMode: MASK` (cut 0.5), glass `BLEND`, sky untouched — they were glTF's default OPAQUE, so foliage/branches/wire drew as **black shards** over the start room | 54 of 273 materials |
| props under 12 u on the longest axis not drawn (pebbles, rubble bits, cage lights) | 209 hidden (`props_hidden_small`) |
| props with no shell surface within 40 u below them hidden (they stand on floors the shell lacks: the sandbag rows hanging over the start room) | 506 hidden (`props_hidden_floating`); 258 kept and listed (`props_unsupported_kept`: sunk 8–40 u under a floor, or wall-hung chalk weapons) |
| duplicates | none (0 same-model same-origin pairs) |

**The live Nacht export is unchanged** (`ZombiesDev\maps`, serving the site). To ship: re-run
`python tools/maps/export_map.py nazi_zombie_prototype --world <husky obj>` into `ZombiesDev\maps`
(the coordinator's call; `built_at` changes, so browsers refetch).

#### Recorded vs inferred

| Shown | Source | Status |
|---|---|---|
| Player position, yaw | `snap.players[].pos/ang` | **recorded**, proven (above) |
| View pitch | `cmd_ang` from the new DLL; old files none | **recorded-from-next-game** (calibration at spawn is [H]); both test files: level |
| Stance (eye height, capsule) | usercmd bits 0x200 crouch / 0x100 prone (IW3 `msg.h`; on `m_0afb449b` 0x100 is held through the last stand) | **recorded** bits, meaning [H]+evidence |
| Zombie positions | `snap.zombies[]` | **recorded** |
| Zombie facing | `yaw` from the 2026-09-22-late DLL; both test files predate it | **inferred** from direction of travel (settings panel says which) |
| Round | `snap.round` / `round` event | **recorded** |
| Zombies left | stock total for (map, round, players) − zombies seen and gone this round | **computed**: `_zombiemode.gsc` round_spawning (Nacht lines 825–857; Der Riese / Verrückt variants in `lib/wawRules.js`). Matches the file: round 1 solo 4 spawned, round 2 solo 9 (3 s spawn delay: 9 lists grow 94.4 → 117.2 s) |
| Weapon | `#<usercmd index>`; Nacht #7 = zombie_colt (held 0.6 s after every spawn), #16 = m1carbine (selected 26 u from the carbine wall-buy with +use held) | **recorded index, name proven for 3 indices**; others use the M1 Garand row, flagged in the panel |
| Shots | `input` 0x1 press/release at ms, expanded by the weapon's fireType/fireTime | **recorded** presses, shots inferred for full-auto holds |
| ADS (crosshair hidden) | 0x800 | **recorded** bit, [H] meaning |
| Crosshair spread | the engine's aimSpreadScale model over the above | **computed** from recorded inputs + weapon file |
| Frag in hand / cook | +frag 0x4000 press/release; armed `holdFireTime` 0.4 s after the press, `fuseTime` 3.5 s | **recorded** presses, fuse **computed** from the weapon file. B's "5 s" is not WaW's: stielhandgranate is 3.5 s + 0.4 s |
| Grenade in flight / explosion | `snap.nades` / `explode` (new DLL, classname unverified on T4) | none in either file; the feed shows "frag … went off (inferred)" at press + 3.9 s |
| Being hit | `health` drop at 20 Hz (**recorded**: `m_5de3842b` 100 → 40 at 378 508 ms) | flash + direction; direction = nearest zombie at that instant (**inferred**, the DLL records no attacker) |
| Down | no `down` event in either file; the weapon index going to #0 while holding one | **inferred** (`m_0afb449b` 118.3 s, `m_5de3842b` 380.1 s) |

`m_0afb449b`'s end, read off the new fields: +frag pressed at 114.221 s, released 116.561 s
(cooked 1.94 s of the 3.5 s fuse), so it went off at ≈118.12 s; the player stopped dead at
117.6 s and the down is at 118.305 s with no health drop recorded in between. **Consistent with
B killing himself with his own stielhandgranate** — an inference, stated as one.

#### The HUD (ask 3) — `ReplayViewer.jsx`, `r3d.css`

- **Round**, bottom-left, colour (0.423, 0.004, 0): 1–5 chalk tallies, 6–10 a second chalk group,
  11+ the number (`_zombiemode.gsc` `create_chalk_hud` / `chalk_one_up`: left/bottom aligned,
  64 × 64 per chalk, `hud_chalk_N`). Tallies are hand-drawn SVG after `chalkmarks_1..5`.
- **Zombies left**: beside it, smaller, labelled "left". Stock WaW has no such counter; it is
  ENW's, and looks it.
- **Settings panel** (the cog): speed, then three toggles, **all on by default** and remembered per
  browser — Round + zombies left, Crosshair + grenade, Damage effects — plus which weapon row is in
  use and where the zombies-left number comes from.

#### The crosshair (ask 4) — `waw.js` from [K] + the weapon files

Four `reticle_side_small` ticks (a 1-texel white line in a 3-texel black outline, 6/8 of an
8 × 8 box, scaled by height/480); the gap is `CG_CalcReticleSpread`:
`spread° = min + (max − min) · aimSpreadScale`, projected with the 4:3 vertical of `cg_fov` 65,
clamped up to `reticleMinOfs`; alpha `max(0.5, 1 − aimSpreadScale)`. `aimSpreadScale` is
`PM_UpdateAimSpreadScale` integrated once over the track (scrub-exact): moving above 11 u/s adds
`hipSpreadMoveAdd · speed / 190` per second, turning adds `hipSpreadTurnAdd · 0.01 · Δ°`, otherwise
it decays at `hipSpreadDecayRate` (× ducked/prone decay); each shot adds `hipSpreadFireAdd`;
ADS adds nothing and hides the ticks. Stance picks the min/max row. Not drawn: the red
"enemy under the crosshair" colour (the engine traces for it; without pitch and occlusion a
horizontal guess lit it through walls). Per weapon, straight from the Nacht zone:

| weapon | index | fire | stand min/max ° | crouch | prone | decay/s | +per shot | +move | reticle |
|---|---|---|---|---|---|---|---|---|---|
| 30cal_bipod | — | Full Auto 0.096s | 4 / 10 | 3.5 / 8 | 3 / 6 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 79px @1080p |
| bar | — | Full Auto 0.16s | 2 / 8 | 1.8 / 6.5 | 1.5 / 5 | 4 | 0.56 | 5 | reticle_side_small 8px, gap 39px @1080p |
| doublebarrel | — | Single Shot 0.283s | 4 / 4 | 4 / 4 | 4 / 4 | 5 | 0 | 0.1 | reticle_side_small 8px, gap 79px @1080p |
| doublebarrel_sawed_grip | — | Single Shot 0.283s | 6 / 6 | 4 / 4 | 4 / 4 | 5 | 0 | 0.1 | reticle_side_small 8px, gap 119px @1080p |
| fg42_bipod | — | Full Auto 0.064s | 2 / 8 | 1.8 / 6.5 | 1.5 / 5 | 4 | 0.56 | 5 | reticle_side_small 8px, gap 39px @1080p |
| fraggrenade | — | Full Auto 0.4s | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | reticle_center_cross 32px, fuse 3.5s + 0.4s |
| gewehr43 | — | Single Shot 0.125s | 1 / 5 | 0.75 / 4 | 0.5 / 3 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 20px @1080p |
| kar98k | — | Single Shot 0.33s | 8 / 10 | 7.5 / 9.5 | 7 / 9 | 5 | 1 | 5 | reticle_side_small 8px, gap 159px @1080p |
| kar98k_scoped_zombie | — | Single Shot 0.33s | 8 / 10 | 7.5 / 9.5 | 7 / 9 | 5 | 1 | 5 | reticle_side_small 8px, gap 159px @1080p |
| m1carbine | #16 (proven) | Single Shot 0.135s | 1 / 5 | 0.75 / 4 | 0.5 / 3 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 20px @1080p |
| m1garand | default for unproven #n | Single Shot 0.135s | 1 / 5 | 0.75 / 4 | 0.5 / 3 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 20px @1080p |
| m1garand_gl | — | Single Shot 0.135s | 1 / 5 | 0.75 / 4 | 0.5 / 3 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 20px @1080p |
| mg42_bipod | — | Full Auto 0.064s | 3.7 / 6 | 2.5 / 5 | 1 / 4 | 4 | 0.6 | 5 | reticle_side_small 8px, gap 73px @1080p |
| mk2_frag | — | Full Auto 0.4s | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | reticle_center_cross 32px, fuse 3.5s + 0.4s |
| mp40 | — | Full Auto 0.112s | 1.5 / 6 | 1.25 / 5 | 1 / 4 | 4 | 0.52 | 4 | reticle_side_small 8px, gap 30px @1080p |
| ptrs41_zombie | — | Single Shot 0.8s | 8 / 10 | 7.5 / 9.5 | 7 / 9 | 5 | 1 | 5 | reticle_side_small 8px, gap 159px @1080p |
| ray_gun | — | Full Auto 0.33s | 1 / 2 | 1 / 2 | 1 / 2 | 3.25 | 1 | 0.5 | reticle_side_small 8px, gap 20px @1080p |
| shotgun | — | Single Shot 0.283s | 4 / 4 | 4 / 4 | 4 / 4 | 5 | 0 | 0.1 | reticle_side_small 8px, gap 79px @1080p |
| springfield | — | Single Shot 0.33s | 8 / 10 | 7.5 / 9.5 | 7 / 9 | 5 | 1 | 5 | reticle_side_small 8px, gap 159px @1080p |
| stg44 | — | Full Auto 0.112s | 2 / 8 | 1.8 / 6.5 | 1.5 / 5 | 4 | 0.56 | 5 | reticle_side_small 8px, gap 39px @1080p |
| stielhandgranate | — | Full Auto 0.4s | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | reticle_center_cross 32px, fuse 3.5s + 0.4s |
| sw_357 | — | Single Shot 0.32s | 2 / 4 | 1.5 / 3 | 1 / 2 | 4 | 1 | 4.5 | reticle_side_small 8px, gap 39px @1080p |
| thompson | — | Full Auto 0.08s | 1.5 / 6 | 1.25 / 5 | 1 / 4 | 4 | 0.52 | 4 | reticle_side_small 8px, gap 30px @1080p |
| walther | — | Single Shot 0.135s | 3 / 6 | 2.5 / 5 | 2 / 4 | 4 | 1 | 4.5 | reticle_side_small 8px, gap 59px @1080p |
| zombie_colt | #7 (proven) | Single Shot 0.075s | 3 / 6 | 2.5 / 5 | 2 / 4 | 4 | 1 | 4.5 | reticle_side_small 8px, gap 59px @1080p |
| zombie_melee | — | Single Shot 0.075s | 3.5 / 6.5 | 3 / 6 | 2.5 / 5.5 | 3.25 | 0.75 | 5.5 | reticle_side_small 8px, gap 69px @1080p |

Gaps are at 1080p, standing, at rest. Weapon rows for every Nacht weapon are in `waw.js`
`WEAPONS`; turret (`*_bipod_stand` etc.) and napalm rows are left out.

#### The grenade (ask 5)

WaW has **no cook meter**. What the game does (`CG_DrawReticleCenter`, `PM_Weapon_OffHand*`):
while the frag is held the crosshair becomes the grenade's `reticle_center_cross` (four ticks at
the edges of a 32-px box, bright at the inner end), and for a `cookOffHold` grenade the box grows
by `(grenadeTimeLeft % 1000) / 100` px — a saw-tooth that ticks once a second, not faster. The
fuse is armed `holdFireTime` (0.4 s) after the press and runs 3.5 s whether or not it has been
thrown; held past that, it goes off in the hand. That is what is drawn, from the recorded
press/release (`cook.png`). The pulsing grenade *icon + pointer* B remembers is the **danger
indicator** for a live grenade within 256 u (`CG_DrawGrenadeIndicators`, 1.7 Hz pulse); its
constants are in `waw.js HUD.grenade`, but no file has a grenade entity yet (`snap.nades` is new),
so it is not drawn. The own-throw explosion is placed in the feed only: its position is unknown.

#### Damage (ask 6)

Driven by **recorded health drops** (and the inferred down). `CG_DrawFlashDamage`: a (0.2, 0, 0)
fill, alpha `min(5, |remaining ms · kick · forwardFrac| / 500) / 5 · 0.7` for 500 ms, kick =
clamp(damage · 0.2, 5, 90) — a hit from the front flashes hard, from the side barely (as in the
game). `CG_DrawDamageDirectionIndicators`: a 128 × 64 red smear 128 px from the centre, rotated
to the attacker's side, full for 1 s then fading over the next (2 s, `cg_hudDamageIconTime`); the
attacker is the nearest recorded zombie (inferred). The low-health overlay (`_gameskill.gsc`
`redFlashingOverlay`, dark-red edges, 0.8 s pulse) shows at health ≤ 20 % (`healthOverlayCutoff`
on regular, `g_gameskill 1` per dedi.md) — `m_5de3842b`'s hit to 40 correctly does not trigger it.
`hit-flash.png` (67.27 s) and `hit-direction.png` (67.9 s, smear at the top: the zombie was in
front). The down on `m_0afb449b` flashes at 118.3 s (`down-flash.png`).

#### DLL (flagged for the coordinator: built, not deployed)

**Deployed 2026-09-22 20:12 box time** as part of the main-HEAD build `86f12b12...` (`dedi.md` §18.5). Pitch is in every replay recorded from then on.

`server/components/replay/replay.cpp`, built in this worktree (`tools\dev\build.ps1 -Name replaywaw`
→ `build\replaywaw\enw_t4.dll`, 1 611 264 B, compiles clean):

1. **`cmd_ang`** `[pitch, yaw]` on each player when it changes — the usercmd view angles, the only
   source of view pitch until `ps.viewangles`/`delta_angles` are bound. The host
   (`routes/replay.js`) zeroes the pitch offset at spawn and whenever the entity-vs-usercmd yaw
   offset jumps > 20° (teleport, last stand) — spawn points have pitch 0 on stock maps, [H].
2. **Stance bits fixed**: crouch 0x200, prone 0x100 (was 0x4 / 0x8 = melee / use).
3. **Kills**: the live/seen arrays were 256 long and real zombies are entnum 254–300+, so
   `kill` / `kills_round` missed every zombie ≥ 256 (round 1 of `m_0afb449b`: 4 died, `kills_round`
   said 1). Now 1024 (MAX_GENTITIES). The viewer no longer uses `kills_round`.

Still wanted from the DLL, not done: weapon names (`BG_GetWeaponDef`, or the weapon configstrings
the server sends — board.md "Weapon index mismatch" notes the name list is in the gamestate),
the attacker/direction of damage, `level.zombie_total` (script variables), and the grenade
classname census result.

#### Proven on the two replays (dev copy, headless Edge + the browser pane)

- Both play in all three cameras; first person at 60 u eye, cg_fov 65, crosshair with the
  zombie_colt / m1carbine numbers, hidden while ADS; the chalk round, "4 left" → "0", round 2
  "II" with "9 left" (`hud-3p`, `round2`, `aim-fp`, `settings`).
- Zombies drawn in every mode as red capsules with a facing wedge (travel direction).
- The cook reticle at 108.62 s of `m_0afb449b`; the flash and the direction smear on
  `m_5de3842b`'s recorded hit; the inferred downs in the feed.
- `npm test` in web: 94 / 33 / 14, including new checks for the round formula (both measured
  totals), zombies-left, the button edges, hits, weapon names, pitch calibration, the spread
  projection and the fuse.

#### Open

- The Husky shell (row 7): windows closed and walls missing on Nacht. The viewer is exact about
  the recording; the map it is drawn in is not, around the windows.
- The live map export and the DLL are not deployed from here.
- Weapon indices other than #0/#7/#16, and every map but Nacht, fall back to the M1 Garand row.

### 8.12 2026-09-23 — the world shell was 2.54x too big; cache-busting; the Tab scoreboard

**Cause, in two sentences.** Husky writes the world OBJ in centimetres, so every vertex of the
shell was the engine position × 2.54, while the props (Husky's `.map`), map_ents and the
recording are in engine inches — the world grew 2.54× away from the map origin. Every earlier
check (including §8.11's "player on the floor, median −1.4 u") passed because Nacht's start-room
floor is at z ≈ 0, where 0 × 2.54 is still 0; it was never a cache problem.

The bug is as old as the Husky export (the pre-§8.11 file has it too); §8.11's "walls missing
around the windows", "zombies 8–12 u under the floor" and "506 props floating over missing
floors" were all this one scale and are withdrawn.

#### Numbers, live before vs now (`web/test/map-align.js`, `mapAlign.js`, `?r3ddebug`)

| Check | Expected (engine truth) | Live before (built 21:12) | Now (built 00:06:49, live) |
|---|---|---|---|
| World shell extent x × y (z) | Nacht with terrain and sky ≈ 12 000 across | **31 212 × 29 423** (z −478..3 739) | **12 288 × 11 584** (z −188..1 472); ratio 2.540 |
| Upstairs floor under the upstairs sandbags (Husky `.map` z 145.0) | 145 | 368.3 | 145.0 |
| 12 `exterior_goal` window goals → nearest wall (goals stand ~55–60 u outside the window) | 55–60 | median **133.8**, max **320.3** | median **57.3**, max **61.3** |
| Prop: truck `dest_opel_blitz_pristine` at map_ents (−1219, −991, −27), all 5 trucks | node at the origin | 0.00 u (props were always right) | 0.00 u |
| Spawn: `initial_spawn_points` (0, 424, 17) → floor below | ~17 (script_structs float) | 14.5 | 16.0 |
| First live tick of `m_0afb449b` (0, 424, 18) → nearest spawn | ≤ 20 u | 1.0 u | 1.0 u |
| Player origin − floor, all in-game samples | ≈ 0 | `0afb` −1.4 (z=0 coincidence) | `0afb` **0.10**, `6d80` **0.10** (p5 −0.6) |
| Zombie origin − floor | ≈ 0 | median +20.9, p5 −11.8 | median **0.18**, p95 1.1 (`6d80` 0.17 / 2.1) |
| Zombie clearance to walls | ≥ 15 (hull) | min 0.6, 16 of 346 inside walls | min **17.7**, 0 of 346 (`6d80` 17.0, 0 of 436) |
| Aimed shots (yaw within 2–3°) with a clear line from the eye (origin + 60) to the zombie | all | `0afb` 3 of 15 | `0afb` 12 of 13; `6d80` **10 of 10** |

`m_6d80aa20` has view pitch (`cmd_ang`, the §8.11 DLL): over its aimed shots the recorded pitch is
within 0.4–4° of the pitch to the target zombie's chest (1.4° or better beyond 700 u), so the
spawn calibration holds on a real game.

`map-align.js` is part of `npm test`: on a machine with the export it asserts world extent
< 20 000, spawns on a floor, window goals within 70 u of a wall, trucks at their map_ents
origins, and the first tick within 20 u of a spawn (10/10 now; the pre-fix export fails the
extent and window checks). Without an export it prints "skipped".

#### Export changes (`tools/maps/export_map.py`)

- `HUSKY_OBJ_SCALE = 2.54`: the shell is divided by it on the way in; the sidecar says
  `world_obj_scale: 2.54`. Only the shell — nothing else was ever wrong.
- The origin-piled brush-model rule restated in engine units (centred within 60 u, reaching
  below −2): still 49 islands / 1 236 triangles.
- **Props are no longer hidden as "floating".** At the true scale 143 props have nothing within
  40 u below them, and they are sandbags stacked on sandbags, trees on terrain dips and props on
  brush models; they are drawn and counted (`props_unsupported`, `props_unsupported_kept`).
  Tiny props (< 12 u) are still skipped.
- The sidecar carries `spawns`, `window_goals` and `anchors` (script_model placements) for the
  checks.
- **Re-exported into the live `ZombiesDev\maps\nazi_zombie_prototype`** at 00:06:49; the
  previous live export is kept at `maps\_work\nazi_zombie_prototype.pre-8.12\`. The running site
  serves it now (`world_obj_scale 2.54`, 39 499 488 B).

#### Cache-busting (the coordinator's item 1)

The `.glb` is served from `/mapdata` (not `/media`), and was `immutable` for a year behind
`?v=<built_at>`. Two holes, both closed:
1. The server's in-memory track cache kept the **old** `map_export.built_at` after a re-export
   until the site restarted, so every browser kept asking for — and served itself from cache —
   the old URL. A cache hit is now only a hit when the export's version is unchanged.
2. The version is now `built_at + .glb mtime + size` (`map_export.version`), and the `.glb` is
   `Cache-Control: no-cache` with an ETag (an unchanged map is a 304, one round trip). The track
   JSON is `no-cache` too.

Proven against one running dev server, no restart: version A
`2026-09-23T00:05:36Z.1790121936870.39499488` → rewrite the sidecar and touch the `.glb` →
version B `2026-09-23T00:10:45Z.1790122245938.39499488`; `Cache-Control: no-cache` on both; a
conditional GET with the ETag answers 304. Unit test: `mapVersion` differs for a new `built_at`
and for a new mtime. **The live site needs a restart onto this build** for items 1–2 (its old
process still has the old code); the geometry itself is already live.

#### The Tab scoreboard (B's ask)

Hold **Tab** (like the game) for a dark WaW panel in the round's red/Impact face; also a toggle
("Scoreboard (hold Tab)") in the settings panel, on by default. Columns are the game's own
strings (`code_post_gfx.ff` `CGAME_SB_POINTS / KILLS / DOWNS / REVIVES`), ranked by points.
What fills them:

| Column | Source | Status |
|---|---|---|
| Points | `snap.players[].score` | **not recorded by the real DLL** (`player_int("score")` is unbound) — shows "—" and says so; the track now carries `has_score` so zeros are never shown as points. **DLL field needed: per-player `score`.** |
| Kills | `kill` events (`entity_gone`, unattributed) | recorded; credited to the player in a solo game only (4 after round 1 of `m_6d80aa20`, matching its 4 zombies); with company they need a `slot` on `kill` (DLL) |
| Downs | `down` events, else the inferred last-stand weapon drop (§8.11) | inferred on both test files |
| Revives | `revive` events | none recorded yet |

The side panel's points column also shows "—" instead of 0 when the score is not recorded.

**2026-09-23 update (bug 7, referee.md §16):** the "DLL field needed" above is done. A §16 DLL reads
score, kills, downs, revives and headshots from the game's own scoreboard fields. It puts them on
snaps and on `stats` events, and the track carries a per-player `counters` timeline. With it,
Points, Kills (attributed per player), Downs and Revives (revives given, `revive.by`) all come from
the game. Files recorded before that keep the rules in this table.

Screenshots (`docs/kickstart/ui/`): `replay-812-debug-0afb.png` / `-debug-6d80.png` (the
`?r3ddebug` overlay with the numbers above), `replay-812-3p-6d80.png` (the player against the
start-room wall), `replay-812-above-0afb.png`, `replay-812-fp-0afb.png`,
`replay-812-fp-close-6d80.png` (zombie at 76 u under the crosshair), `replay-812-fp-far-6d80.png`
(an ADS shot at 771 u), `replay-812-scoreboard.png`. The `replay-waw-*` shots from §8.11 were
taken on the 2.54× shell.

## 9. 2026-09-23 — player and zombie models: extraction, formats, sizes, viewer changes, what is not proven

B's ask: "Rip the player model from the game as well as the zombie models and put them in the
3D replays." Done for every stock character a zombies map dresses people in: the four generic
Marines, the four heroes, the stock zombies of Nacht/Verrückt, Der Riese and Shi No Numa, and the
hellhound. Textured, **rigged** (the xmodel skeleton is kept as a glTF skin), placed and turned by
the recording, walking with a procedural gait. Capsules remain the fallback.

### 9.1 Extraction — `tools/models/export_models.py`

```
python tools/models/export_models.py              # unlink if stale, build all 20, write models.json
python tools/models/export_models.py --only zombie_nacht_1,dempsey
python tools/models/export_models.py --force      # re-unlink and rebuild
```

| Tool | Licence | Version | Used for |
|---|---|---|---|
| OpenAssetTools Unlinker | GPL-3.0 | v0.33.0 (the same `ZombiesDev\tools\oat\` as §4; run, never vendored) | xmodel → skinned glTF, material, image → DDS, rawfile (the character scripts); `--list` on the custom maps |
| numpy | BSD-3-Clause | 2.5.3 | accessor decode, bind-pose maths |
| Pillow | MIT-CMU | 12.3.0 | DDS (DXT1/5) decode, resize, JPEG/PNG |
| three.js `GLTFLoader`, `SkeletonUtils` | MIT | 0.185 (already a dependency) | loading, per-instance skeleton clones |

What it runs (read-only over B's Steam install; nothing is written outside `ZombiesDev`; the game
is never launched, the lock never taken; `Activision\CoDWaW` is not touched):

```
Unlinker.exe --model-format GLTF --image-format DDS --include-assets xmodel,material,image,rawfile
  --search-path "<WaW>\main;<WaW>\zone\english" -o "ZombiesDev\modelwork\dump\?zone?"
  "<WaW>\zone\english\nazi_zombie_{prototype,asylum,sumpf,factory}.ff"
Unlinker.exe ... --include-assets rawfile  common.ff patch.ff nazi_zombie_{asylum,sumpf,factory}_patch.ff
Unlinker.exe --list ... ZombiesDev\archive\mods\<map>\*.ff          # custom-map classification only
```

Work files: `ZombiesDev\modelwork\` (1.2 GB of dumps; disposable, re-created by the script).

**Which parts make which character is read from the game's own scripts**, not guessed
(`modelwork\dump\<zone>\character\*.gsc`, `xmodelalias\*.gsc`, `maps\_loadout.gsc`):

* **Players.** `_loadout.gsc give_model`: on `nazi_zombie_sumpf/factory/asylum` (and coast, paris,
  theater, test) it is `switch(self.entity_num)` → `char_zomb_player_0..3` = **Dempsey, Nikolai,
  Takeo, Richtofen**; everywhere else, including Nacht and every custom map that ships the stock
  loadout, it is `mptype\player_usa_marine` → `get_random_character(4)` → `char_usa_marine_player1..4`
  (body + head + helmet + gear). Verrückt's own zone carries only the Marine models, so it gets the
  Marines. Russian player bodies exist only in the campaign zones and no archived custom map carries
  them (9.3), so they are not exported.
* **Zombies.** `char_ger_honorguard(2)_zombies`: body alias (`body1_1`, `body2_1` / `body1_2`, `body2_2`;
  Der Riese's `bodyz` alias) + `randomElement(zombieheadalias)` of 24 heads; Shi No Numa's
  `char_jap_zombie`: `body5z_1/2` + one of 9 heads + `char_jap_impinf2_cap1`. Four variants per map
  (three for Numa), each a different body/head pairing.
* **Hellhound.** `character_sp_zombie_dog` → `zombie_wolf`.

**Merging.** A character is several xmodels the engine attaches (`attach(head, "", true)` is a
bone-merge). Each part's vertices are in its own root bone's frame, so every part is moved into
the body's bind pose (`body_world(bone) · part_world(bone)⁻¹`, per dominant joint) and its joints
re-pointed at the body's by name (a bone the body lacks goes to its nearest ancestor). The rig
check: that correction must be the same matrix for every bone of a part; the largest disagreement
over all 20 models is **0.001** (the parts are authored on the body's rig). Primitives sharing a
colour texture are merged: **3–7 draw calls** per character. Normal/spec maps are dropped; colour
maps go to **512 px** for the sheet covering ≥ 35 % of triangles, **256 px** otherwise, JPEG q82
unless the alpha is used (then PNG + `alphaMode: MASK`). NORMAL is int8 (`KHR_mesh_quantization`),
WEIGHTS u8 normalised, JOINTS u8. Budget **700 KB per model, enforced** (the build fails over it).
Marines are lod0, everything else lod1.

**Frame and scale.** Unlinker's glTF is Y-up with engine +X forward, in engine inches — exactly
`scene.js toThree` — so nothing is rescaled. §8.12's 2.54× was Husky's centimetres; these never go
through Husky. Check: model heights **71.2–73.5 u** (the 70-u hull + helmet/cap), the hellhound 59.9;
in the pictures below they stand at the height of Nacht's doors and trucks.

### 9.2 Where they are served (§7a)

`C:\Users\b\ZombiesDev\maps\_models\` → **`/mapdata/_models/<id>.glb`** and
`/mapdata/_models/models.json` (the existing `/mapdata` static mount, no server change; `_`
directories are skipped by `listMaps`). `.glb` requests go through the same bucket 302 as the maps
when the bucket holds a same-size copy under `mapdata/_models/` — **not uploaded** (the
coordinator's call). Nothing is committed. Same IP posture as the map `.glb`s (§8, `ip-posture.md`):
game-derived, closed-testing carve-out, gate-exempt like the rest of `/mapdata`.

| Model | KB | tris | draws | joints | h (u) |
|---|---:|---:|---:|---:|---:|
| marine_1 / 2 / 3 / 4 | 336 / 386 / 364 / 361 | 9.0–10.6 k | 5–7 | 79 | 71.8–72.3 |
| dempsey / nikolai / takeo / richtofen | 174 / 190 / 203 / 210 | 2.8–3.5 k | 3–4 | 79–106 | 71.2–73.5 |
| zombie_nacht_1..4 | 159–170 | 2.4–2.5 k | 3–4 | 73 | 71.4–71.5 |
| zombie_factory_1..4 | 161–166 | 2.4–2.5 k | 3–4 | 73 | 71.4–71.5 |
| zombie_sumpf_1..3 | 151–185 | 2.2–2.5 k | 3 | 73 | 71.2–71.8 |
| hellhound | 295 | 3.2 k | 3 | 58 | 59.9 |
| **all 20 + models.json** | **4.4 MB** | | | | |

A replay loads only what it can show: its players' models by slot, the map's zombie variants,
and the dog only when the track marks one. Solo Nacht: **~1.0 MB**; two-player Der Riese: ~1.0 MB.

### 9.3 Which set a map gets (`models.json`)

1. **Stock map** → `maps[<bsp>]` (9.1).
2. **Custom map** → `customs[<bsp>]`, decided at export time by what the custom's **own fastfiles**
   carry (`Unlinker --list` of `mod.ff` + `<bsp>*.ff` in `ZombiesDev\archive\mods`, cached in
   `modelwork\customs.json`): any hero body → the heroes by `entity_num`; else Marines by slot.
   Zombies → Der Riese's if it carries `char_ger_honorgd_bodyz*`, Numa's if `char_jap_impinf_body5z*`,
   else Nacht's. A custom's *own* characters (Minecraft, Mario…) are listed (`custom_characters`)
   but never drawn — the stock set stands in. Of the 85 archived customs: 71 carry the heroes,
   14 do not (→ Marines); zombies 73 Der Riese, 5 Nacht, 4 Numa, 3 with no stock body (→ Nacht).
3. **Anything else** (not in the archive at the last export) → `default`: Marines by slot + Nacht
   zombies. The bsp name is matched case-insensitively.

### 9.4 Viewer changes

* **`models.js`** (new): `loadModelSet`, `makeActor` (a `SkeletonUtils.clone` per instance, so every
  actor has its own bones), `poseActor`, `variantOf`. Materials get a little of the albedo as
  emission and no fog — the capsules' readability rule on a night map (§8.4).
* **Motion.** The track has **no animation state** (position, yaw, stance bits, alive; §3/§8.4), so
  the gait is procedural on the real skeleton: hips/knees/ankles/shoulders/spine swung about the
  character's lateral axis (expressed in each bone's own frame, so it does not depend on the rig's
  local conventions), phase = **inches walked along the track** (scrub-exact: the same instant is
  always the same pose), amplitude from speed. Zombies lean and reach; players carry. Crouch bends
  the legs and drops 18 u; prone lies face down; a player not alive lies on his back (the track does
  not say downed vs dead). Idle breathes.
* **Death.** A zombie track that ends within 1.5 s of a `kill` event for the same entity falls
  backwards over 0.55 s, arms dropping, then sinks and is gone at 2 s. A track that ends otherwise
  just vanishes. The HUD's "Zombies up" does not count the falling.
* **`actors.js`**: models replace capsules for every player — including the focused one, whose
  `scene.js` capsule is found and hidden (`scene.js` is still unedited) — and zombies come from a
  per-model pool keyed by zombie track, so a zombie keeps its body for life. In first person the
  focused player's model is hidden; the placeholder gun is unchanged. Yaw is the recorded yaw.
* **Fallback.** No `models.json`, a failed `.glb`, or `?models=off` → the old capsules, unchanged.
  `?r3ddebug` adds `window.__r3d.models()` (set, rule, who wears what) and `__r3d.seek(s)`.

### 9.5 Proof (scratch site, headless Edge; the live site, 3200 and `web/data` untouched)

Scratch instance on **3461** (this worktree's build, a `VACUUM INTO` copy of the live DB,
`ZM_REPLAY_PULL=off`), replays from `ZombiesDev\replays`. Screenshots in the worktree's
`tmp\shots\` (not committed):

| File | What |
|---|---|
| `nacht-3p-zombie-74s.png`, `nacht-3p-zombie-68s.png` | `m_6d80aa20` (real DLL, Nacht): third person, the Marine at the window, an honour-guard zombie reaching through it 63 u away |
| `nacht-3p-zombie-dies-81.4s.png` | the same, zombie 258 falling at its `kill` (81.1 s), a second zombie walking in behind |
| `nacht-fp-74s.png` | first person: the zombie at the window, the placeholder gun, no body in the lens |
| `nacht-3p-capsules-74s.png` | the same moment with `?models=off` |
| `factory-3p-heroes-254s.png`, `factory-3p-slot1-nikolai-205s.png` | `m_2e346de4` (Der Riese, 2 players, simulator file): Dempsey (slot 0), Nikolai (slot 1), Der Riese zombies |
| `custom-bloodsport-3p-25s.png` | `m_ce87b8c8` (`nazi_zombie_bloodsport`, real DLL, no world export): the custom fallback → Dempsey + Der Riese zombies over the grid |
| `lineup-front.png`, `lineup-players-front.png`, `lineup-zombies-front.png`, `lineup-walk-side.png`, `lineup-crouch.png`, `lineup-down.png`, `lineup-death.png` | every model, and every pose, on a neutral stage (`tmp\modeltest\`) |

`web` `npm test` passes (exit 0).

### 9.6 What is not proven / not done

* **No real animations.** OAT dumps the zones' xanims (582 in Der Riese: `ai_zombie_walk_v1`,
  `ai_zombie_sprint_v1`, `ai_zombie_crawl`…), but only as the engine's binary (`version 17`; a test
  dump is in `ZombiesDev\modelwork\xanimtest\`), which nothing here parses yet. That parser is the
  next step and would replace the procedural gait; the rig it needs is already in every `.glb`.
* **Walk vs run vs crawl is not recorded**, nor gibs/crawlers (§8.4 "anim state" is `re`-lane work);
  a crawler is drawn walking.
* **Hellhounds are never drawn**: the track does not say which AI is a dog (no `kind`); the model
  and the `kind === 'dog'` path are ready for when the DLL records it.
* **Marines by slot, not the game's pick** (`get_random_character(4)` is random per player and not
  recorded). Heroes by slot = `entity_num` is the game's own rule, assuming slot = entity number.
* **Downed vs dead** players look the same (on the back); last stand's pistol pose is not drawn.
* **No weapon in the players' hands** (the `weapon_zombie_*` world models are in the zones; not
  attached). *2026-09-23 R2:* extracted, with power-ups, sprites and sounds —
  [`assets-pipeline.md`](assets-pipeline.md), `/mapdata/_assets.json`; attaching them is R3's.
* **Custom maps' own character models** are not exported; the stock set stands in (9.3).
* **Not seen on the live site** (not deployed; the coordinator merges and restarts), and not on a
  real GPU — every picture is SwiftShader.

## 10. 2026-09-23 11:55 — lane 10's staged exports: checked, 7 promoted, Nacht kept

The lane-10 export (`tools/maps/export_all.py`, merged `4adbf81`) wrote **108 map dirs** to
`C:\Users\b\ZombiesDev\maps-staging\<bsp>\` before the PC froze (`_queue.txt` is tranche 2's
75-map queue and is not an export). The 04:14 incident rule applies: staging goes live only after
the align check and a viewer render check. Nothing was re-exported, the bucket was not touched,
and neither 3200, `web/data` nor the tunnel was.

### 10.1 What was checked, per map

1. **The file.** The staged `.glb` is the **served** file (`EXT_meshopt_compression`,
   `KHR_mesh_quantization`, WebP). It was decoded with gltf-transform + `MeshoptDecoder`, which is
   what a browser gets. Checks: it parses; vertex and triangle counts; world-space bounds of the
   scene and of `__world` inside ±65 536 u; strided (interleaved) buffer views counted. It is
   **byte-identical** to `_work\raw\<bsp>\<bsp>.served.glb`, and its decoded bounds match the float
   twin `_work\raw\<bsp>\<bsp>.opt.glb` to under 1 u (0.01–0.71 u on the shell maps; 16-bit
   positions). The one exception is `nazi_zombie_pd`, at 1.42 u.
2. **Align.** `mapAlign.check()` (the byteStride-aware one from `237ca5f`) on the float twin with
   the staged sidecar, the same call `web/test/map-align.js` makes. `mapAlign` cannot read meshopt,
   which is why the twin is used, and step 1 is what ties the twin to the served bytes. Pass means
   a shell inside ±65 536 u, at least one spawn standing on the shell (−2..64 u), window goals
   median ≤ 70 u and max ≤ 90 u from a wall (the Nacht test's limits), and no `script_model` anchor
   more than 1 u off its map_ents origin. For Nacht, the 10/0 test itself was also run
   (`node web/test/map-align.js <dir>`).
3. **Render.** The §9.5 harness: a scratch site on **3471** (main's server and the 11:46 client
   build, which carries the meshopt decoder), a `VACUUM INTO` copy of the live DB, `ZM_MAPS_DIR`
   set to a scratch copy of the candidates, `ZM_REPLAY_PULL=off`, and headless Edge (SwiftShader)
   over CDP. Stock maps opened their own replay (`m_6d80aa20` Nacht, `m_c645886a` Verrückt,
   `m_08420c53` Der Riese). The other maps have no replay, so they opened `m_6d80aa20` with its
   track response rewritten over CDP `Fetch` (map + `map_export`). The viewer then fetches
   `/mapdata/<bsp>/<bsp>.glb` the same way it would for a real game there ("carrier" below).
   Pass means `__world` is in the scene, meshes and textures are loaded, there is no "No world
   model" note and no page exception, the in-browser `__world` box equals the align box to 1 u,
   and an eye-level shot from the spawn in both directions shows the map (looked at, not only
   measured).

Scripts: `tmp\promote\{validate.cjs,render.mjs}` in the main checkout (untracked, not committed).
Results: `tmp\promote\results.json`, `render.log`. Shots: `tmp\promote\shots\`.

### 10.2 Result

**108 checked. 107 decode clean. 8 pass align and render, and 7 of those were promoted.** The
100 without a shell were not promoted.

| Cause | Maps | Count |
|---|---|---|
| **No world shell.** Husky's game launch (`husky-map.ps1`, `waw-geo` copy) hit a Steam Error dialog, *"Application load error 5:0000065434"*, and the game exited before the map loaded. These are props + sky only, and align cannot pass without a shell | every custom map except the four below | 99 |
| No world shell: another `CoDWaW.exe` held the lock | `nazi_zombie_beachtown` | 1 |
| …and a node 200 490 u out (scene bounds fail ±65 536) | `nazi_zombie_pd` (one of the 100) | (1) |
| Not staged at all (export failed; nothing to check) | `nazi_zombie_fear_mc_2` (optimize/prune), `bridge_zombie` (MemoryError), `water` (map_ents colour `'.77 .713 .713'`) | 3 |

`bcast` is listed as "check, extent 1 333 696" in `_work\export_all\results.md`. The staged file is
a later re-export made after `e0db3a0`'s ±65 536 cull, and it passes (9 408 × 15 936).

**Promoted** to `C:\Users\b\ZombiesDev\maps\<bsp>\`: `nazi_zombie_asylum`, `nazi_zombie_sumpf`,
`nazi_zombie_factory`, `aliendefense`, `bank_job`, `battlestar_galactica`, `bcast`. Each file was
copied to a temp name and renamed into place, then `cmp`'d against staging. Backups of the files
this replaced: `maps\_work\nazi_zombie_factory.pre-promote\` (the §8.10 props-only Der Riese,
14.3 MB) and `maps\_work\nazi_zombie_prototype.pre-promote\` (the 8.12 Nacht, identical to
`.pre-exportall`).

**Der Riese has one outlier.** 28 of 29 window goals are 52 u (median) from a wall, but the goal
at (982, −2462, 80) is 304 u from any wall and has no shell floor under it. The geometry around
it sits at z 129–917, so this goal is probably an entry from below or outside what Husky exports.
With 5/5 spawns and 41 anchors at 0.00 u it was promoted. The file it replaced had no shell at all.

**Nacht did not change.** The staged Nacht (6.95 MB, meshopt) matches the live 8.12 export on
every number: 12/0 on `map-align.js`, span 12 288 × 11 584, window goals 57.3 / 61.3 u, trucks
0.00 u, first tick 1.0 u. Its render shows the window walls and frames at both window goals,
matching the live file shot for shot (`nacht_new-*` vs `nacht_old-*`, mean pixel difference 3–8
of 255). It was promoted and then **reverted within minutes**: `web/test/map-align.js` (part of
`npm test`) reads the live `ZombiesDev\maps\nazi_zombie_prototype` file, and `mapAlign.js` has no
meshopt or int16 reader, so the test crashed (`BYTES_PER_ELEMENT`). The live file is the 8.12
export again, byte-identical to `.pre-exportall`, with its mtime kept so its URL version is
unchanged. `map-align.js` is 12/0 again. **To ship the 7 MB Nacht,** either point
`map-align.js` at `_work\raw\...\opt.glb` or give `mapAlign` a meshopt decode. Then copy
`maps-staging\nazi_zombie_prototype\*` over.

### 10.3 Live

`https://zombies.enw.gg/mapdata/<bsp>/<bsp>.glb` with `Range: bytes=0-1023` → **206** and the
promoted size, for all 7 maps, with **no password and no bucket 302** (the bucket holds none of
them). `.meta.json` → the staged `built_at`, `encoding` meshopt. Nacht → `bytes 0-15/39499488`
after the revert. The mount is the whole directory, so no restart was needed. `/replay/<id>` is
401 behind the gate, as expected. **No promoted map was opened in the live viewer**, because the
gate needs a typed password. The build that was rendered is the one the live process serves
(`dist` 11:46).

### 10.4 Not proven / for the coordinator

* **IP.** `/mapdata` is gate-exempt, so four **custom** maps (`aliendefense`, `bank_job`,
  `battlestar_galactica`, `bcast`) are now public geometry and textures, not just the stock four.
  §8's carve-out was written for stock maps. Delete those four dirs if that is not wanted.
* The 100 props + sky exports are viewer-ready (`Props and sky only.` + a grid, §8.10's old Der
  Riese path) and position-checked where they have anchors, but are **not promoted**. Their shells
  need Husky on a working `waw-geo` launch, which means a `game.lock` hold, and the Steam load
  error has to be fixed first.
* Carrier renders put Nacht's recorded actors in another map. Those shots test the geometry only.
* Every picture is SwiftShader. A real GPU and B's eye remain the proof.

| Map | MB | Align (spawns on shell · window goals median/max · anchors on origin/listed) | Render | Promoted | Why |
|---|---|---|---|---|---|
| nazi_zombie_prototype | 6.95 | spawns 5/5, windows 57.3/61.3 u, anchors 54/54 | ok: 1877 meshes, 149 tex | **no** (tried, reverted) | passes 12/0 and renders the window walls, but web/test/map-align.js reads the live file and crashes on meshopt; 8.12 export kept |
| nazi_zombie_asylum | 10.50 | spawns 9/9, windows 48.1/61.5 u, anchors 60/64 | ok: 3154 meshes, 231 tex | **yes** | replaces nothing |
| nazi_zombie_sumpf | 12.85 | spawns 5/5, windows 51.7/56.3 u, anchors 60/64 | ok: 7158 meshes, 192 tex (carrier) | **yes** | replaces nothing |
| nazi_zombie_factory | 12.28 | spawns 5/5, windows 52.3/304 u, anchors 41/64 (1 of 29 goals 304 u) | ok: 1892 meshes, 188 tex | **yes** | replaces the props-only 8.10 export; one window goal off (see below) |
| aliendefense | 1.53 | spawns 5/5, anchors 14/20 | ok: 84 meshes, 48 tex (carrier) | **yes** | new |
| bank_job | 2.42 | spawns 5/5, windows 45/45 u, anchors 25/35 | ok: 174 meshes, 75 tex (carrier) | **yes** | new |
| battlestar_galactica | 2.64 | spawns 5/5, anchors 40/40 | ok: 621 meshes, 76 tex (carrier) | **yes** | new |
| bcast | 2.65 | spawns 5/5, windows 60/60 u, anchors 62/64 | ok: 448 meshes, 120 tex (carrier) | **yes** | new |
| ahkanto | 0.56 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| batman | 1.83 | no shell; anchors 58/64 on origin | — | no | props + sky only: Husky could not start the game |
| boxmap | 0.40 | no shell; anchors 14/14 on origin | — | no | props + sky only: Husky could not start the game |
| castle | 0.78 | no shell; anchors 40/40 on origin | — | no | props + sky only: Husky could not start the game |
| chal_dual_wield | 0.59 | no shell; anchors 11/11 on origin | — | no | props + sky only: Husky could not start the game |
| chal_harambe | 0.44 | no shell; anchors 16/16 on origin | — | no | props + sky only: Husky could not start the game |
| chickn | 1.02 | no shell; anchors 38/38 on origin | — | no | props + sky only: Husky could not start the game |
| christmas_zombie | 1.04 | no shell; anchors 44/48 on origin | — | no | props + sky only: Husky could not start the game |
| cryogenic | 1.09 | no shell; anchors 62/64 on origin | — | no | props + sky only: Husky could not start the game |
| cube | 0.55 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| cxca | 0.80 | no shell; anchors 43/46 on origin | — | no | props + sky only: Husky could not start the game |
| dead_palace | 0.63 | no shell; anchors 32/32 on origin | — | no | props + sky only: Husky could not start the game |
| deadfactory | 0.75 | no shell; anchors 33/33 on origin | — | no | props + sky only: Husky could not start the game |
| dpp | 2.68 | no shell; anchors 51/52 on origin | — | no | props + sky only: Husky could not start the game |
| escape_asylum | 1.26 | no shell; anchors 53/59 on origin | — | no | props + sky only: Husky could not start the game |
| futurama | 0.35 | no shell; anchors 14/22 on origin | — | no | props + sky only: Husky could not start the game |
| hghrise | 0.78 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| island | 0.66 | no shell; anchors 45/45 on origin | — | no | props + sky only: Husky could not start the game |
| jigsaw | 1.37 | no shell; anchors 47/64 on origin | — | no | props + sky only: Husky could not start the game |
| killhouse | 2.45 | no shell; anchors 57/57 on origin | — | no | props + sky only: Husky could not start the game |
| kingdom_hearts | 1.49 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| labrats2 | 0.67 | no shell; anchors 15/15 on origin | — | no | props + sky only: Husky could not start the game |
| lewl | 1.35 | no shell; anchors 55/64 on origin | — | no | props + sky only: Husky could not start the game |
| matrix | 0.68 | no shell; anchors 30/30 on origin | — | no | props + sky only: Husky could not start the game |
| mr_freeze | 1.33 | no shell; anchors 35/42 on origin | — | no | props + sky only: Husky could not start the game |
| mw2rust | 0.56 | no shell; anchors 15/15 on origin | — | no | props + sky only: Husky could not start the game |
| nacht_der_toten | 0.54 | no shell; anchors 33/33 on origin | — | no | props + sky only: Husky could not start the game |
| nacht_reimagined | 2.20 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| navidad_p_zombie | 1.46 | no shell; anchors 58/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_arena | 0.23 | no shell; anchors 5/5 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_arkham | 2.27 | no shell; anchors 41/48 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_beachtown | 0.72 | no shell; anchors 51/51 on origin | — | no | props + sky only: Husky could not start the game (game already running) |
| nazi_zombie_bloodsport | 1.07 | no shell; anchors 40/40 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_blut | 0.73 | no shell; anchors 40/40 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_bored | 0.64 | no shell; anchors 12/12 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_cargo | 1.53 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_crazyplace | 1.03 | no shell; anchors 25/25 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_dcv2 | 1.09 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_denial2 | 1.02 | no shell; anchors 32/32 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_derberg | 1.87 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_dome_snow | 0.70 | no shell; anchors 30/30 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_dt2 | 1.44 | no shell; anchors 39/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_enclosed | 0.72 | no shell; anchors 40/40 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_fivenights | 0.63 | no shell; anchors 11/11 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_forest | 0.93 | no shell; anchors 45/47 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_hanoizom | 0.97 | no shell; anchors 56/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_herren | 1.58 | no shell; anchors 46/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_hex_tower | 0.42 | no shell; anchors 16/16 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_hijacked | 1.50 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_hotelv2 | 1.25 | no shell; anchors 39/39 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_illuminati_island | 1.71 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_ils | 2.09 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_inferno | 3.20 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_iplay2 | 0.63 | no shell; anchors 61/61 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_johndoe | 2.33 | no shell; anchors 62/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_legion | 2.19 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_leviathan | 2.09 | no shell; anchors 51/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_library | 1.41 | no shell; anchors 39/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_lorkeep | 1.71 | no shell; anchors 28/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_malibu | 2.72 | no shell; anchors 60/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_mine | 2.11 | no shell; anchors 52/52 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_monopoly | 0.71 | no shell; anchors 32/32 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_octogonal | 0.42 | no shell; anchors 16/16 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_orbit | 1.94 | no shell; anchors 57/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_path | 0.62 | no shell; anchors 13/13 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_pd | 2.74 | no shell; anchors 57/64 on origin | — | no | props-only AND a node 200 490 u out (bounds fail) |
| nazi_zombie_perk | 0.98 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_pogreb | 1.34 | no shell; anchors 57/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_poke | 1.87 | no shell; anchors 55/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_prison | 1.75 | no shell; anchors 60/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_puns | 0.91 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_rats | 1.52 | no shell; anchors 61/61 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_rc | 0.89 | no shell; anchors 32/32 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_relax | 0.55 | no shell; anchors 24/24 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_rooms | 1.80 | no shell; anchors 25/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_school | 1.97 | no shell; anchors 61/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_shore | 0.74 | no shell; anchors 23/24 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_snowglobe | 2.34 | no shell; anchors 35/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_spruktbyl | 0.87 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_tank | 2.41 | no shell; anchors 56/57 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_temple | 1.79 | no shell; anchors 48/49 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_test | 2.97 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_test1 | 0.76 | no shell; anchors 26/34 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_v2beta | 1.42 | no shell; anchors 49/50 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_wahnsinn | 1.88 | no shell; anchors 59/64 on origin | — | no | props + sky only: Husky could not start the game |
| nazi_zombie_zhunterz | 1.57 | no shell; anchors 51/59 on origin | — | no | props + sky only: Husky could not start the game |
| nightclub | 3.54 | no shell; anchors 57/64 on origin | — | no | props + sky only: Husky could not start the game |
| nuketown | 3.23 | no shell; anchors 61/64 on origin | — | no | props + sky only: Husky could not start the game |
| number2 | 1.02 | no shell; anchors 54/54 on origin | — | no | props + sky only: Husky could not start the game |
| salaj_dust2 | 0.93 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| sanatorium | 2.72 | no shell; anchors 59/64 on origin | — | no | props + sky only: Husky could not start the game |
| shinomori | 1.08 | no shell; anchors 46/58 on origin | — | no | props + sky only: Husky could not start the game |
| thirty_seven | 2.16 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| ugx_artemovsk | 1.99 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |
| ugxm_garage | 0.64 | no shell; anchors 34/34 on origin | — | no | props + sky only: Husky could not start the game |
| ut_box_map | 0.36 | no shell; anchors 11/11 on origin | — | no | props + sky only: Husky could not start the game |
| zm_hospital | 1.35 | no shell; anchors 63/64 on origin | — | no | props + sky only: Husky could not start the game |
| zm_nuked | 1.64 | no shell; anchors 60/61 on origin | — | no | props + sky only: Husky could not start the game |
| zombie_maze | 1.08 | no shell; anchors 38/39 on origin | — | no | props + sky only: Husky could not start the game |
| zombie_town | 2.16 | no shell; anchors 64/64 on origin | — | no | props + sky only: Husky could not start the game |

---

## 11. 2026-09-23 (lane R1) — the replay rate, and the events the viewer needs for guns, shots, hits and power-ups

The contract is [`../protocol/replay-events-v1.md`](../protocol/replay-events-v1.md); this is the
lane's summary. **Built and unit-tested; not deployed, not seen in a real game.**

### 11.1 The rate B saw

Read from 18 real box replays with `infra/host-agent/tools/replay-rate.js` (1,506 s of play):
**players were already 20.0 Hz** (one sample per `SV_Frame`), **zombies were ~8 Hz** (every other
frame, and absent between rounds), and the viewer asks the track endpoint for `?hz=10`
(`web/client/src/pages/Replay.jsx:38`), so on screen **everything was 10 Hz**. Two changes are
needed for 20 Hz on screen:

1. **DLL (done here):** zombies and grenades on every frame. `replay.cpp`'s `zombie_frame` is now
   always true.
2. **Viewer (not this lane, R2/R3):** request `?hz=20`. `buildTrack` strides by snap count
   (`routes/replay.js:105`, `stride = round(20 / hz)`), so `hz=20` is every snap; with a v1 file
   every snap has zombies. On an old file `hz=20` gives zombies on every other tick only —
   `replay_events` in the header says which.

Size, like for like (host writer, zstd-10): **1.43 MB per game-hour before (real files) → about
2.31 after** (x1.61: x1.48 for the 20 Hz zombies, the rest a synthetic load of the new events).
The simulator's 4-player, 24-zombie hour: 8.04 → 11.31 MB/h. Compression unchanged; details and
caveats in replay-events-v1.md §4.

### 11.2 What is recorded now

- `snap`: zombies every frame; a player's `weapon` is the engine name (`zombie_thompson_upgraded`)
  instead of `"#37"`; new `clip` and `ammo`, omitted when unchanged.
- Events: `weapon`, `fire`, `hit` (with `kill:true` on the lethal one), `damage` (with the
  zombie that did it), `pap` (`start`/`done`), `powerup` (`spawn`/`pickup`/`expire`, `until`
  for insta-kill and double points).
- The `.enwr` header gains `replay_events: 1`, `snap_hz: 20`, `zombie_hz: 20`, copied by the host
  from the DLL's own `map_loaded`.

This closes §3 gap 5 (`weapon` disagreeing with itself) once the weapon table binds, and replaces
§8.11's inferred damage direction (nearest zombie) with a recorded attacker.

### 11.3 How, in one paragraph

No new hook. After `SV_Frame` the sampler reads each player's `playerState` (weapon index,
`bg_weaponDefs` name, clip/reserve through the weapon def's indices, the 4-slot event ring where
`EV_FIRE_WEAPON` 0x1C / `_LASTSHOT` 0x1D land), each zombie's `sentient->lastAttacker` and
`actor->damageHitLoc`, and every `script_model` whose model is a power-up. Each group turns on
only if the instruction bytes that prove its offsets are in the running image (the table is in
replay-events-v1.md §5: T4SP-Server-Plugin headers, then an instruction in our dump for every
offset). The rules that turn two frames into events are pure
(`server/components/replay/replay_events_model.hpp`), 59 checks in
`server/tests/replay_events_test.cpp`.

### 11.4 Not proven

Everything that needs a player who shoots: an agent lease has no player, and B is playing, so no
game ran. The coordinator's recipe (bind line, then B's next box game checked against the
magazine arithmetic, the kills/headshots counters and the `entity_gone` kills) is
replay-events-v1.md §7.1.

## 12. 2026-09-23 (~15:30 UK), lane R3: weapons, flashes, hits, blood, Pack-a-Punch, power-ups, sound

B's asks (14:05). In the web replay, each player holds a weapon of the right class with its name
shown. A shot shows a muzzle flash and plays the gun's sound, and a Pack-a-Punched gun sounds
different and wears the camo. A hit shows a hit marker and plays its sound. There is a crosshair. A
swipe shows the blood overlay and plays its sound. Pack-a-Punch use is shown. Power-ups are drawn as
3D pickups where they spawn, with pickup and announcer sounds, and a HUD shows which timed power-ups
are active and exactly how long each has left.

Branch `worktree-agent-aef74e453358c99cc`. It is built against lane R1's `replay-events-v1.md` (§11,
merged) and lane R2's asset pack (`assets-pipeline.md`, merged: `ZombiesDev\maps\_assets.json` plus
`_weapons/_powerups/_fx/_sounds`), and has main merged in. The viewer now asks for the track at
**20 Hz** (`pages/Replay.jsx`), at B's request. The live site, port 3200 and `web/data` were not
touched, the game was not launched, and nothing was uploaded.

### 12.1 What the viewer does, per event

| Event (v1) | Viewer | Sound (R2's `_assets.json`) |
|---|---|---|
| `weapon {slot,name,pap,raw}` | R2's world `.glb` goes in the player's right hand: j_wrist_ri with R2's measured palm frame, the gun moved by its `gripPoint`, following the arm's swing. Upgraded guns use R2's gold `_pap.glb` (Colt, Carbine, Thompson, MP40). The Ray Gun and Wunderwaffe **keep their base model, as in the game** (`sameWorldModelAsBase`). Non-guns: `knuckle_crack` is empty hands, a perk bottle is a bottle. The display name (manifest, `weaponByEngineName` for engine names) goes on a second line of the player's name tag and in a new **Weapon** column in the Tab scoreboard. Before the first `weapon` event, and on old files, the snapshot's engine name is used. The first-person gun is the watched player's weapon | — |
| `fire {slot,name}` | For **60 ms**, a muzzle flash at the gun's `tag_flash`: R2's sprite (`muzzle_rifle/pistol/raygun/tesla`), additive, with the sprite's own aspect. The first-person gun kicks. Size and roll come from a seed of the shot's time, so a paused frame looks the same every time | `sounds.fire`, positional at the shooter. The watched player's own shots in first person use `fire_plr`, 2D, as the game does. Upgraded: `pap.sounds.fire(_plr)` (the "ubershot") |
| `hit {slot,zid,part,dmg,kill}` | The game's `damage_feedback` image (R2 `_fx/hit_marker.png`), 24×48 at (−12,−12) from the crosshair, the stock script's layout ([H], CoD4 `_damagefeedback.gsc`). Full on the hit, fading over 1 s. A head hit is drawn warm. It shows only while following that player (first or third person), never in free cam. `kill` is carried in the track but not drawn differently: WaW's marker does not tell kills apart | `general.hit_marker` (multiplayer's `MP_hit_alert`: stock zombies has none, R2 §5), 2D, watched player only |
| `damage {slot,by,hp}` | The game's `overlay_low_health` vignette (R2 `_fx/hurt_overlay.png`), full on the swipe and gone by 1.2 s, stronger at lower `hp`. It shows for the watched player only and follows the "Damage effects" toggle. §8.11's flash and direction smear are unchanged | `general.zombie_swipe`, then `general.player_hit` 80 ms later, 2D, watched player only |
| `pap {slot,name,raw,state}` | A feed line on `start` ("Pack-a-Punch · MP40") and on `done` (the upgraded name, "The Afterburner"). The gold model appears from `done`, or from the `weapon` event with `pap:true` | `start`: `general.pap_upgrade` (the machine, 6 s). `done`: `general.pap_ready`. Both positional. The 49 s `pap_jingle` is not played on use; it is the machine's idle music |
| `powerup … spawn` | R2's model (`_powerups/<kind>.glb`: ammo can, skull, x2, bomb, hammer) at x,y,z inside the game's glow sprite (`powerup_glow`, R2's green tint). It hovers about 22 u up, bobs and spins, and blinks from 15 s until it goes at 26.5 s when nobody takes it (`groundLifeMs`, `blinkFromMs`; `expire` wins). Kinds R2 has no model for (fire sale, death machine: not in WaW; `other`) get a primitive stand-in | `powerups[kind].spawnSound`, positional |
| `powerup … pickup` | The pickup is removed and a feed line is added ("slot 0 Insta-Kill"). A timed kind gets a **HUD chip** at the bottom centre that counts down in **tenths of a second**, rounded down, and turns amber under 5 s. v1 sends `until` for insta-kill and double points; the manifest's `durationMs` and then 30 s cover the rest. A second pickup of the same kind shows the **latest** `until` (v1 §2) | `pickup` positional. `announce` (the announcer) and `sting` (max ammo) are 2D |
| timed effect ends | The chip goes | `powerups[kind].sounds.end` (`insta_kill_end`, `double_points_end`), once, when the last window of that kind runs out |
| `powerup … expire` | Removes a drop nobody took. It also cuts a running effect, which v1 never sends but the reducer allows for | — |

**Crosshair.** In first person it is WaW's reticle, as in §8.11. It is now also drawn in **third
person**, at the point the watched player aims at: 2000 u along his recorded yaw and pitch, projected
through this frame's camera. The hit marker sits on it there. The "follow player" camera the ask
wanted is the existing Third person mode (key 2). Free cam (3) shows neither.

**Scrub-exact.** Everything above is computed from the replay time alone (`fx.js`), in the same way as
§8.11's overlays. A paused, scrubbed or played frame at the same time shows the same thing.

### 12.2 Sound

The pattern is Movement's `replay3d/audio.js` (CSGO-Matchmaker). A **250 ms lookahead** is scheduled
from the viewer's own clock. Every queued sound is dropped on a pause, a seek, a jump, or a speed
change, and a sound the clock skipped over is **never played late**, so scrubbing through a fight
makes no noise. The scheduler (`fx.js` `CueScheduler`) is pure and unit-tested.

The audio uses three.js's own classes. An `AudioListener` sits on the viewer camera, so the camera is
the listener in every mode. A pool of 24 `PositionalAudio` objects is placed where each sound happened
(ref distance 150 u, inverse rolloff, max 6000 u), and a pool of 8 `THREE.Audio` objects plays the 2D
sounds. Playback speed stretches the schedule and does not change pitch, which is how Movement does it.
Only the samples this replay's cues can play are fetched, and only after the gesture.

**Off by default.** Nothing exists until a gesture. **Play** (the button or Space) creates the audio
context. The new speaker button in the bar, or **M**, mutes and unmutes. The mute is saved per browser
(`enw.replay3d.muted`). A replay with no cues, or no manifest, is silent, and the button is disabled
with the tooltip "No sounds for this replay".

### 12.3 Fallbacks (none of them can break the viewer)

* **No `/mapdata/_assets.json`**, which is what `?assets=off` shows: every weapon is a procedural
  placeholder of its class. `gear.js` has pistol, smg, rifle, mg, shotgun, launcher, ray gun, wonder
  weapon, flamethrower, grenade, knife, empty hands and bottle. The class comes from `waw.js`
  `WEAPONS[].cls`, then the name. The placeholder hangs in the same palm frame as R2's guns, using R2's
  measured numbers as constants. PaP puts a procedural purple camo on it. Power-ups are primitive
  stand-ins with a procedural glow, the hit marker and blood are CSS, and **there is no sound**.
* **A glb that fails to load, or is still loading**: the placeholder is drawn, and the real model
  replaces it once it lands. Models are preloaded when the manifest arrives, and a redraw is forced
  when one lands. Without that redraw, a paused viewer kept the placeholder, which the render check
  caught.
* **An old replay** (no v1 events, `replay_events` 0): `track.fx` is `[]` and every query answers
  "nothing". Held weapons still come from the snapshot column. On these files that is a `#index`:
  one §8.11 proved (Nacht #7 colt, #16 carbine) is drawn with its name, and any other index draws
  no gun. No marker, blood, pickups or chips are drawn, and it
  is silent. This was proven on the fixture with the v1 events stripped, and on the real `m_6d80aa20`.
  *Retracted 2026-09-23 (lane RV, §14.1): "silent" was the bug B reported. An old file now sounds
  from its attack presses and health drops, and a gun with no model is the fake rifle.*
* **Names**: every lookup tries the engine name, the name without `_upgraded`, v1's stripped name, and
  `zombie_`/`_zombie` forms, with R2's `weaponByEngineName` tried first. `pid` or `slot` are both
  accepted, as are `ms` or a numeric `t`.
* **Settings**: a new toggle, "Weapons, hits + power-ups" (on by default), hides all of it.

### 12.4 Files

| File | What |
|---|---|
| `web/server/routes/replay.js` | `fxOf` and `track.fx`: the six v1 kinds, compacted and time-ordered, `slot` becomes `pid`, `kill` is kept. They are **not** feed lines. `track.replay_events`, `snap_hz` and `zombie_hz` come from the header |
| `web/client/src/pages/Replay.jsx` | `/track?hz=20` |
| `web/client/src/replay3d/fx.js` (new) | The event-to-scene-state reducer: `buildFx`, `weaponAt`, `fireAge`, `hitMarkerAt`, `bloodAt`, `papBusyAt`, `powerupsAt`, `chipsAt`, `fmtTenths`, `weaponKeys`/`assetWeapon`/`displayName` (WaW's upgraded names, "C-3000 b1at-ch35" for the Colt), `weaponClass`, `CueScheduler`, `soundsFor`, `soundUrl`. No three.js, no DOM. Outputs are pooled, so nothing is allocated per frame |
| `web/client/src/replay3d/gear.js` (new) | Held weapons, flash sprites, the first-person weapon, PaP, power-up pickups (a pool of 12), the grip frame, loading `_assets.json` and glbs, and preloading. It replaces `actors.js createPlaceholderGun` in the viewer; the function is kept |
| `web/client/src/replay3d/sound.js` (new) | `ReplaySound`: listener, pools, decode, mute, and the scheduler hookup |
| `actors.js`, `models.js` | `handOf(slot)` (wrist + hand), `setPlateWeapon` (the name tag's weapon line, rebuilt only on a change), and the bone lookup |
| `ReplayViewer.jsx`, `r3d.css` | Wiring, overlays, chips, the speaker button, feed lines, the Weapon column, and `?assets=off`. It also fixes the HUD: every paused frame now updates it. The 66 ms throttle had swallowed a seek that landed right after a camera switch, and the feed and Tab scoreboard then showed the previous instant |
| `web/test/replay-fx.js` (new, in `npm test`) | **16** unit tests |
| `web/test/fixtures/fx-events.js` (new) | 20 s of Nacht, 2 players, 2 zombies, every v1 kind in v1's shapes, all eight power-up kinds, a refreshed insta-kill, and a knuckle crack |
| `web/tools/make-fx-replay.mjs` (new) | Signs the fixture into `m_f0f0f0f0.enwr` (v1 header) and `m_f0f0f0f1.enwr` (v1 stripped). It refuses the live replay dir |
| `web/tools/r3-render-check.mjs` (new) | The headless check below. It refuses port 3200 and `zombies.enw.gg` |

### 12.5 Proof

**Unit tests** (`node web/test/replay-fx.js`, **16/16**) cover:

* `fx` carries the six kinds and `kill`;
* the snapshot column's engine names at 20 Hz;
* `replay_events` and `snap_hz` from the header;
* the old-replay emptiness;
* both field conventions;
* weapon at t: `name` + `raw`, the knuckle crack, PaP from the event or a later `done`;
* a flash on at 59 ms and off at 61 ms;
* the marker fade and the head/body part;
* blood strength by hp;
* PaP cues and feed lines;
* pickups from spawn to pickup, expire or timeout, with pooled objects reused;
* chips: exact time left, tenths, the latest `until` wins, the 30 s default, `expire` cuts, the
  manifest `durationMs`, one end cue;
* sounds read from R2's shape: `fire`, `fire_plr`, upgraded, `weaponByEngineName`, swipe plus pain,
  pap, spawn, pickup, announce, sting, end;
* the scheduler: lookahead, a scrub drops the queue and plays nothing skipped, a pause, a 4x
  restretch;
* display names and classes;
* the state at t is identical whether reached by playing in 16 ms steps or by seeking.

**Render check** (`node web/tools/r3-render-check.mjs http://127.0.0.1:3487 tmp/r3shots --real m_6d80aa20`, **27/27**).
It ran against a scratch site on **3487** built from this worktree:

* `ZM_DATA_DIR` was a fresh scratch dir, and there was no password.
* `ZM_MAPS_DIR` was a scratch **copy** of Nacht's export, `_models`, and R2's pack.
* `ZM_REPLAY_DIR` held the two fixtures and a copy of `m_6d80aa20`.
* `ZM_REPLAY_PULL=off`.

The browser was headless Edge with SwiftShader, driven over CDP. The checks:

* Sound is off before any gesture. A real mouse click on Play gives a `running` context, R2's
  samples decoded and sounds played. A 10 s scrub while playing played nothing it skipped.
* R2's Colt and Ray Gun are in the hands. The flash is on at +20 ms and off at +100 ms.
* The damage_feedback marker shows on a head hit in third person, on a crosshair at the projected
  aim point.
* In first person, R2's MP40 is flashing. The hurt vignette shows after a swipe. The knuckle crack is
  empty hands.
* R2's insta-kill and x2 models are drawn at their spawn. The upgraded MP40 is R2's gold model, and
  every glb loaded.
* The chips read exactly `Insta-Kill 20.5 · Double Points 20.1 · Fire Sale 28.5 · Death Machine 29.5`.
* Tab shows `The Afterburner` / `Ray Gun`, and the feed has the pickups.
* The old fixture with `?assets=off` is silent, with procedural class placeholders from the snapshot
  column: the MP40 is `smg` with camo, the Ray Gun is `raygun`.
* The real `m_6d80aa20` plays, silent, with no page exceptions anywhere.

Screenshots are in the worktree's `tmp\r3shots\` (not committed): `r3-flash-3p`, `r3-hitmarker-3p`,
`r3-flash-fp`, `r3-blood-fp`, `r3-powerups-3p`, `r3-pap-3p`, `r3-chips`, `r3-scoreboard`,
`r3-old-3p`, `r3-real-m_6d80aa20`.

The full web `npm test` passes after merging main: every suite reports 0 failed, and `replay-fx` is
16/16.

### 12.6 What is NOT proven

* **No v1 recording with a player in it exists yet.** R1's DLL has been on the box since 14:13 UK
  (`04a3ad6d`, `dedi.md` §22.10). Its only proof so far is an agent lease, `m_7ce70442`, which has the
  `replay_events:1` header and no player, so no events. Everything here was driven by my fixture,
  written to v1's shapes. B's next box game is the proof: guns, shots, hits, a swipe, a PaP on Der
  Riese, and a power-up. Open it in the viewer on a build with this branch merged.
* **First shots after Play can be silent** while the samples decode (Ogg, ~100 ms locally). The audio
  context may only be created by the gesture. Decoding earlier through an `OfflineAudioContext` would
  fix this and has not been done.
* **Heard by nobody.** Everything ran under SwiftShader with `--mute-audio`: the graph ran and sources
  started, but no one listened. The same is true of R2's clips (R2 §6). Volumes are per-kind guesses
  (`sound.js GAIN`), because the alias volumes were not dumped (R2 §5).
* **Guns in the bind pose.** They hang at the wrist of relaxed arms, pointing the character's way:
  there is no aiming pose until real xanims exist (§9.6). Capsules (`?models=off`) use a fixed offset.
* **The first-person gun is the world model**, not R2's `viewGlb`. R2's 12 viewmodels are served and
  unused; the world model is placed in view by its grip.
* **Not done**: the zombie blood burst on a hit (R2 has the `blood_*` sprites; not asked), the ground
  loop `powerup_loop` while a drop lies there, and the insta-kill/double-points loops while active.
* **The live site** gets all this on merge plus a restart, on B's word (rule 15).

## 13. (not written) — lane R4's spectator switching

R4's own section was never written (B's PC rebooted at 15:30); `next-session.md` item 24 is its
record, and the code comments that say "replay.md §13" (spectate.js, r4-render-check.mjs) mean it.

## 14. 2026-09-23 (~17:45–19:30 UK), lane RV: the sound B could not hear, first-person arms + ADS, and a placeholder for every gun

B (17:30): "Sound's not working on the client on the 3D web replayers. Also add the hand models and
aim-down-sights, and guns that you don't have stored — use the fake gun in their place." Branch
`worktree-agent-af5a1466289b6332f` (main merged at `07d924a`). The live site, port 3200 and
`web/data` were not touched (read only: its log and a GET of three `/mapdata` URLs); the game was
not launched; nothing was uploaded.

### 14.1 Why there was no sound — two causes, both in the replays, neither in the audio code

Measured, not guessed: headless Edge (output muted) with an **AnalyserNode spliced in front of
the AudioContext destination** (a pass-through patch of `AudioNode.connect` installed before the
page's scripts), a real mouse click on Play, against a scratch site running **main's own build**
(what 3200 serves) and copies of the real files. The live site's `/mapdata/_sounds/*.ogg` answer
`200 audio/ogg`, same origin, through the tunnel too — the gate, a 302 and CORS were not it, nor
the codec (Ogg decodes in Chromium), nor the listener (it is on the camera).

| Replay (B's, today) | Main's build | Why |
|---|---|---|
| `m_abe60828` bridge_zombie, v1, the Colt | **sound** (peak 0.87, 19 sounds in 7 s) | the path §12 built works |
| `m_da684190` battlestar_galactica, v1, 17 shots of `m9` | **gunfire silent**: only 3 samples fetched (hit marker, swipe, pain), 5 sounds | a custom map's gun is not in the pack, and `soundsFor` returned nothing for it |
| `m_0c608cd9` fear_mc_2, played 12:28 UTC (before R1's DLL), the one B opened at 18:07 | **no AudioContext at all** for 22:45 (`available: false`) | no `fire`/`damage` events in the file: §12 made every old replay silent **by design** |

So "sound's not working" was true for most of what B watches: every game before 14:13 UK and
every custom map whose guns are not stock. **Fix** (`fx.js`, `ReplayViewer.jsx`, `sound.js`):

* **Cues for a file with none** (`addInferredCues`): a shot per attack press expanded by the
  weapon's fire type (§8.7's `shotTimes`, [K]; an unknown gun fires semi-auto at 0.12 s), a swipe
  per recorded health drop (`track.hits`). A player with recorded cues of a kind gets none inferred.
  §12.3's "an old replay is silent" is **retracted**; R3's render check now asserts the opposite.
* **A stand-in fire sound** (`standInWeapon`) for a gun the pack lacks: the stock gun of its
  name's class, else the M1 Carbine (a rifle, as the fake gun is drawn). Knives, grenades, bottles
  and the flamethrower stay silent.
* **A rebuilt ReplaySound is enabled** once the page has had its Play/speaker gesture (it is
  rebuilt when the manifest lands, the map loads or the cues change, and used to come back
  disabled until the next click). A context the browser suspended is resumed while playing.

After the fix, same harness, this branch: `m_da684190` peak 0.95 (22 sounds), `m_0c608cd9` peak
0.69 from its presses. **Electron**: not run (no invisible launcher window was driven); its site
view has no audio-relevant setting (`launcher/src/main/main.js`: no mute, no autoplay policy; the
permission handler refuses permission prompts, which Web Audio does not raise), so it is the same
Chromium path — unproven there.

### 14.2 First-person arms and aim-down-sights

**What the game does, read from its files.** Every stock zombies map sets
`viewmodel_usa_marine_arms` (`maps/_loadout.gsc`, the `nazi_zombie_*` branch; a custom map that
ships the stock loadout too) — the Marine arms are the only viewhands, so "per character" has
nothing to choose from. The gun's viewmodel hangs on the arms' `tag_weapon` by its root `j_gun`;
the arms' `tag_view` is the eye. The weapon file names `idleAnim` and `adsUpAnim`. **The ADS anim
is scrubbed by the aim fraction**: its frame 0 is the hip pose (tag_torso low right; it equals
`adsDownAnim`'s last frame) and its last frame the sights. Found the hard way: with the idle frame
alone the hip gun sat 6.7 u under the eye, off screen.

**Pipeline** (`export_assets.py`, `assets-pipeline.md` §7): `tools/models/xanim.py` reads the
compiled xanim v17 Unlinker dumps (our own reader; field order checked against OAT's
`CompiledXAnimLoader` and against the files: **582/582** of Der Riese's parse to the last byte).
Out: `_weapons/viewhands_marine.glb` (skinned, 70 joints, 5.8 k tris, 186 KB) and
`_weapons/fp_poses.json` (44 poses, 128 KB: each gun's idle frame and every frame of its ADS anim,
bone-local, engine frame); per weapon `fp: { idle, ads, adsZoomFov, adsInMs, adsOutMs, standMove }`.

**Viewer** (`fphands.js`, `fpmath.js`, `gear.js`): in first person the arms + the gun's own
viewmodel (R2's `viewGlb`, the upgraded one after a PaP) replace the §8.7 placeholder as soon as
all three have loaded; bones take the idle frame, the ADS anim's bones its frame at the aim
fraction; the FOV eases from cg_fov 65 to the gun's `adsZoomFov` (the viewmodel pass uses the same
FOV; `setWorldFov`/`setViewmodelFov` now allow down to 5, for the PTRS's 10). Kick is steadier
when aimed. `standMove*` is NOT applied: in the weapon file it is the pull while moving (its
siblings are `duckedOfs*`/`proneOfs*`), and applying it at rest put the gun 2.5 u too low.

**Where the aim fraction comes from.** R1 records the usercmd buttons (`input`, bit 0x800 = ADS,
checked here against a real file: held 32.834–34.079 s of `m_abe60828` while the Colt fired three
times) but not the engine's state. So, two sources:
1. **DLL (new, its own commit `5af3c78`, NOT on the box)**: the snap's per-player `ads` =
   `ps.fWeaponPosFrac` in tenths, omitted when unchanged; `replay_events` **2**. Offset `0x110`,
   bound only if `PlayerCmd_PlayerADS` 0x4EEE00's bytes are in the image (0x4EEE69
   `8B 96 80 01 00 00 D9 82 10 01 00 00` = `mov edx,[esi+0x180]; fld [edx+0x110]`, exactly what
   script `playerADS()` returns); T4SP asserts the same offset. The track carries it per tick
   (`players[].ads`, tenths; null on older files). `replay_events_test` 66/66 (7 new).
   `t4_bind.cpp`, `replay.cpp`, `referee.cpp` pass `cl /Zs /W4 /permissive-`; **not built into a
   box DLL** (rule 17) — the coordinator's step (`replay-events-v1.md` §8).
2. **Every file today**: the ADS button eased at the gun's `adsTransInTime`/`adsTransOutTime`.
   It is intent, not state (the game refuses ADS while sprinting or reloading) [H]. Fire events
   were not used: the button is better evidence and exists on every file.

### 14.3 Guns the pack does not have, and the pack

* **The fake gun** (`fx.js placeholderFor`, `gear.js`): a gun whose name the pack cannot resolve
  is the procedural rifle (§12's `rifle` placeholder), rifle-sized, with the real name on the tag
  and the Tab board (`displayName` was already name-driven); the name is logged once per page
  (`[replay] weapon not in the asset pack, drawn as the placeholder rifle: m9`) and listed in
  `__r3d.fx().gear.unknown`. A live player whose column says no weapon (`#0`, an unbound index)
  holds it too. Non-guns keep their own stand-ins; with no pack (`?assets=off`) §12's class
  placeholders stay.
* **The pack** now has **every gun Der Riese's box and walls hand out and each PaP**: .357,
  Kar98k, Gewehr 43, M1 Garand (+ launcher), STG-44, Type 100, PPSh-41, Trench gun,
  Double-barrel, BAR, FG42, .30 cal, MG42, PTRS-41, Panzerschreck, M2 flamethrower, plus R2's
  six. Older maps' names for the same guns (`thompson`, `bar_bipod`, `mg42_bipod`,
  `kar98k_scoped_zombie`...) map to them (`aliases`). Fire sounds come from zone order; 2 of 34
  had none there (Kar98k third-person, MG42 first-person: class stand-ins, said in `_assets.json`
  `soundStandIn`), and the flamethrower has no fire sound. Not in the pack: the Arisaka and the
  sawed-off (Shi No Numa's zone), the Springfield (Nacht) — they are fake guns.
* **Size**: 183 files, **17.4 MB** (budget raised 15 → 20). A replay still loads only its guns.
  **Live now**: the 99 new files were ADDED to `ZombiesDev\maps` (the 84 existing ones are
  byte-identical); `_assets.json` was replaced after a backup
  (`ZombiesDev\assetwork\backup\_assets.json.2026-09-23-pre-RV`). Main's viewer reads it unchanged
  (new fields are ignored) and gets the 17 new real guns and their sounds today; the arms, ADS,
  inferred sounds and the fake gun need this branch merged and a site restart (rule 15).

### 14.4 Proof

* `web npm test` green after merging main; **`replay-fp` 13/13** (new): the ADS ease and its
  scrub-exactness, the DLL column, the pose layering and the ADS-anim scrub, the FOV, the fake-gun
  rule, stand-in sounds, inferred cues, and the track's `ads` column.
* **`web/tools/rv-render-check.mjs` 20/20** on a scratch site (3472; this build; fresh data dir;
  copies of the real replays): signal at the destination after Play on all three real files; M
  drops it to 0; first person hip → half way (0.49 at 120 ms of the Colt's 245) → ADS (1, FOV 60
  = the Colt's `adsZoomFov`); the fixture's MP40 and its PaP viewmodel on the arms; the fake rifle
  in `m9`'s hand with the name logged; `?assets=off` keeps the placeholder. R3's check 27/27 (one
  assertion retracted, above), R4's 31/31 on the same site.
* Screenshots (scratchpad, not committed): `rv-fp-hip-colt`, `rv-fp-mid-colt`, `rv-fp-ads-colt`,
  `rv-fp-mp40`, `rv-fp-mp40-pap`, `rv-custom-fake-gun-3p`.

### 14.5 Not proven / not done

* **Heard by nobody** — the analyser proves a signal; headless output was muted. B's ears are the proof.
* **Not seen in the Electron launcher**; not on a real GPU (SwiftShader).
* **The DLL's `ads`** is compiled for syntax only and unit-tested; no game has recorded it.
* **The pack export was not re-run for byte-determinism** after its last change (the PC was at
  89 % commit); the 84 files shared with R2's pack came out byte-identical.
* Poses are the idle frame only (no idle sway, fire, reload or raise anims); no stance offsets;
  the third-person world model still has no aiming pose (§12.6).
* Inferred shots on old files follow the stock fire-type table; a custom gun is semi-auto.
