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
