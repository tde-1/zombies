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

Working, on this box, against a **real signed replay**:

| | |
|---|---|
| Replay | `C:\Users\b\ZombiesDev\replays\m_cf25a5dd.enwr` — `nazi_zombie_prototype`, `mode: verified`, signed footer, 1 player, 1 h 19 m, 5 rounds |
| Track endpoint | `GET /api/replay/m_cf25a5dd/track?hz=10` — 47 662 ticks, 4.4 MB JSON, **78 KB gzipped**, built in ~180 ms |
| Map | `C:\Users\b\ZombiesDev\maps\nazi_zombie_prototype\nazi_zombie_prototype.glb` — **12.6 MB**, 54 props, 18 meshes, 37 textures, the map's own sky dome |
| Page | `/replay/:matchId`, linked from the game page's Replay card |
| Picture | [`ui/replay-nacht.png`](ui/replay-nacht.png) — round 5, five zombies up, third person |

**Not working, and it is the headline:** the map has **no world shell**. No floor, no
walls, no ceiling. §4 is why, and it is a tooling wall rather than a bug. The viewer draws
a grid at the real floor height instead and says so on screen.

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
| Pillow | MIT-CMU | 12.3.0 | DDS (DXT1/3/5) decode, resize, re-encode |

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

Every one of them needs the game running, which is this lane's hard no: two agents share
`ZombiesDev\locks\game.lock` and this lane never takes it.

**So the seam is `--world`:**

```
python tools/maps/export_map.py nazi_zombie_prototype --world <husky-export>.gltf
```

It merges the shell as a `__world` node and the output is the whole map. That is a
twenty-minute job for whoever next holds the game lock: launch WaW on
`nazi_zombie_prototype`, run Husky or C2M, convert the `.obj` to `.gltf`, re-run the
script. Until then `<bsp>.meta.json` carries `"world_shell": false`, the viewer draws a
grid at the real floor height, and the page says why.

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

- **The world shell.** §4.
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

1. **The world shell**, by the route in §4. Everything else is cosmetics until this lands.
2. **The 14 customs.** Same pipeline against `mods/<bsp>/<bsp>.ff` — `export_map.py`
   already falls back to that path when the map is not in `zone/english`. Untested: no
   custom map's fastfile was exported tonight. Expect the same shell problem and the same
   fix, once per map.
3. **The referee gaps in §3**, in the order they are listed — a `kill` event and a round
   number on `snap` are both one line.
4. **A replay from the real DLL**, so the viewer is proven against the game and not the
   simulator.
5. **Multi-player in anger.** The four-slot path is written and exercised only by
   single-player data; `m_2e346de4.enwr` (Der Riese, two players, signed) is the file to
   test it with once a two-player Nacht replay exists.
