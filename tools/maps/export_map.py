#!/usr/bin/env python3
"""Export a stock Call of Duty: World at War map to a single web-friendly .glb.

    python tools/maps/export_map.py nazi_zombie_prototype

Idempotent: every step skips itself if its output is newer than its input, so
re-running costs a few seconds. `--force` redoes everything.

WHAT THIS PRODUCES, AND WHAT IT DOES NOT
----------------------------------------
Read `docs/kickstart/replay.md` §4 before trusting the output. The short version,
which is a *measurement* and not a guess:

  * OpenAssetTools' Unlinker (GPL-3.0) loads a T4 fastfile completely -- `--list`
    on nazi_zombie_prototype.ff reports 1 gfxworld, 1 clipmap, 1 comworld, 297
    xmodels, 542 materials, 709 images, 1 mapents.
  * It can *write* xmodel, material, image and mapents. It cannot write gfxworld,
    clipmap or comworld for T4. Asking for them is not an error, it simply emits
    nothing: `--include-assets gfxworld,clipmap,comworld -o <dir>` produced a
    directory containing only the zone source file. Measured 2026-09-22 against
    Unlinker v0.33.0.
  * The **world shell of a WaW map -- the floors, the walls, the ceiling -- lives
    in GfxWorld**, not in xmodels, so this script cannot export it. What is in
    map_ents is 54 `script_model` placements (barrels, wall weapons, the mystery
    box lid, a couch) and 127 `script_brushmodel`s, and a brushmodel is a
    reference (`*2`, `*3`, ...) into the same GfxWorld we cannot read.
  * Every tool that *does* export a WaW world -- Husky, C2M -- reads it out of the
    running game's memory, so the shell needs one game.lock hold per map.
    `--world <file.obj|.gltf>` is that seam: point it at a Husky export and this
    script merges the shell AND reads the `<same-name>.map` beside it for the
    static model placements, which is where a stock map keeps its props (1506 of
    them on Nacht against map_ents' 54).

Without --world the output is a correct, correctly-placed *prop and sky* export
with the shell missing -- an honest partial, and what the viewer draws a floor
grid for. With it, the output is the whole map. See replay.md section 4b for the
Husky run itself, which is scripted in tools/maps/run-husky.ps1.

COORDINATES
-----------
Nothing is transformed here. The .glb is written in **raw engine coordinates**:
CoD units (~1 inch), Z up, exactly the frame the referee's `snap.players[].pos`
is recorded in. The viewer does the axis swap (x, y, z) -> (x, z, -y), the same
one ENW Movement's scene.js does for Source, so a recorded position drops
straight into the scene and the player stands on the floor. Baking a swap here
would mean two conventions to keep in step instead of one.

LICENCES (also recorded in the vault's Reuse Register)
------------------------------------------------------
  * OpenAssetTools -- GPL-3.0 -- https://github.com/Laupetin/OpenAssetTools
    Release v0.33.0 (2026-08-31), prebuilt `oat-windows.zip`. Run as an external
    program only; nothing of it is linked or vendored, so its copyleft does not
    reach this repo.
  * Husky -- GPL-3.0 -- https://github.com/Scobalula/Husky, release 0.8.0.0.
    Also an external program; the world shell it produces is game-derived data
    and is subject to the same never-commit rule as everything else here.
  * Pillow -- MIT-CMU -- DDS (DXT1/3/5) decoding.
Neither the fastfile nor anything derived from it may be committed: a texture
lifted out of a stock map is a game asset however many times it has been
re-encoded. Output goes to ZombiesDev, which is git-ignored.
"""

import argparse
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

WAW = Path(os.environ.get(
    "ZM_WAW", r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"))
DEV = Path(os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev"))
OAT = DEV / "tools" / "oat" / "Unlinker.exe"

# A prop is worth a draw call if it is big enough to see. Nacht's 31 explosive
# barrels are, the shell casings are not -- but WaW has no size metadata, so the
# filter is by classname, not by size.
PLACEABLE = {"script_model", "misc_model"}

# Props smaller than this on their longest axis are not drawn (replay.md §8.11): on Nacht
# that is 321 `static_peleliu_rock_coral01_small` pebbles (9.3 u), 14 runway rubble bits
# (9.2 u), 11 `static_berlin_rubble_small_rocks` (1.9 u) and 5 cage lights (7.7 u) -- 351
# draw instances of floor speckle that read as noise at replay distance and cost a draw
# each. The engine draws them; a replay viewer does not need them.
MIN_PROP_SIZE = 12.0

# World materials that are editor tools, not surfaces (see merge_world).
TOOL_MATERIAL = re.compile(r"^(caulk|clip|nodraw|trigger|hint|skip|portal|mantle|shadow_?caster|"
                           r"ladder|volume|origin|cushion|metalclip|foliage_?clip|monster_?clip)"
                           r"|(^|_)caulk", re.I)

# Engine placeholder images Husky can report as a material's diffuse (see merge_world).
PLACEHOLDER_TEX = re.compile(r"^(case\d+|\$|default|_?identity|white$|black$|gray$|grey$|noise)", re.I)
WATERY = re.compile(r"water|puddle|mud|river|swamp|ocean|lake", re.I)

# Beyond this (engine units, any axis) nothing is reachable; see merge_world.
WORLD_LIMIT = 65536.0

# Husky's OBJ unit: centimetres (engine inches x 2.54). See merge_world.
HUSKY_OBJ_SCALE = 2.54

MAX_TEX = 512          # px on the long edge; Nacht's props ship 1024 and nobody can tell
JPEG_QUALITY = 86
# export_all.py sets this: textures leave here as lossless PNG and the optimiser
# (optimize_glb.cjs) makes them WebP, so nothing is lossy-compressed twice.
LOSSLESS_TEX = False
# Prop (xmodel) textures, px on the long edge. The shell keeps MAX_TEX.
PROP_TEX = 256


def log(*a):
    print("[export-map]", *a, flush=True)


# ---------------------------------------------------------------------------
# step 1 -- unlink the fastfile
# ---------------------------------------------------------------------------

ARCHIVE_MODS = DEV / "archive" / "mods"
ARCHIVE_STAGED = DEV / "archive" / "mods-staged"


def find_fastfile(bsp: str):
    """(fastfile, mod_dir or None). Stock maps come from the Steam install (read-only);
    a custom map from the archive's normalised install (archive.md §7), the staged copy
    first when one exists (mapmount.ps1 boots the same one), else WaW's own mods/."""
    ff = WAW / "zone" / "english" / f"{bsp}.ff"
    if ff.is_file():
        return ff, None
    for root in (ARCHIVE_STAGED, ARCHIVE_MODS, WAW / "mods"):
        alt = root / bsp / f"{bsp}.ff"
        if alt.is_file():
            return alt, alt.parent
    return None, None


def unlink(bsp: str, work: Path, force: bool) -> Path:
    """Run OAT's Unlinker over <bsp>.ff. Returns the dump directory."""
    ff, mod_dir = find_fastfile(bsp)
    if ff is None:
        sys.exit(f"no fastfile for {bsp} (zone/english, archive/mods-staged, archive/mods, WaW mods/)")
    if not OAT.is_file():
        sys.exit(f"OpenAssetTools is not installed at {OAT}\n"
                 f"  download oat-windows.zip from\n"
                 f"  https://github.com/Laupetin/OpenAssetTools/releases/tag/v0.33.0\n"
                 f"  and unzip it there (GPL-3.0; it is a tool, not a dependency)")

    out = work / "dump" / bsp
    stamp = out / ".unlinked"
    if stamp.is_file() and not force and stamp.stat().st_mtime > ff.stat().st_mtime:
        log(f"dump is current ({out})")
        return out

    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(OAT),
        "--model-format", "GLTF",
        "--image-format", "DDS",
        # The zone carries 1720 sounds and 364 animations we will never draw, and
        # dumping them is most of the wall clock. Narrow it.
        "--include-assets", "xmodel,material,image,mapents",
        # A custom map's images mostly live as loose .iwi in its own .iwd files, not in
        # the zone -- so its mod folder goes on the search path too.
        "--search-path", ";".join(str(p) for p in
                                  [WAW / "main", WAW / "zone" / "english"] + ([mod_dir] if mod_dir else [])),
        "-o", str(work / "dump" / "?zone?"),
        str(ff),
    ]
    log("unlinking:", " ".join(cmd))
    t = time.time()
    # READ-ONLY over the Steam install: Unlinker opens the .ff and the .iwd files
    # and writes only under -o. Rule 1 of the kickstart README.
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = "\n".join((r.stdout or "").splitlines()[-6:])
    # A custom zone often "finishes with N errors" (an asset type OAT's T4 writer skips);
    # that is only fatal if the map_ents never came out.
    if r.returncode != 0 and not (out / "maps" / f"{bsp}.d3dbsp.ents").is_file():
        sys.exit(f"Unlinker failed ({r.returncode}):\n{tail}\n{r.stderr[-2000:]}")
    log(f"unlinked in {time.time() - t:.1f}s -- {tail.splitlines()[-1] if tail else ''}")
    stamp.write_text("ok")
    return out


# ---------------------------------------------------------------------------
# step 2 -- map_ents
# ---------------------------------------------------------------------------

ENT_BLOCK = re.compile(r"\{(.*?)\}", re.S)
ENT_KV = re.compile(r'"([^"]*)"\s+"([^"]*)"')


def read_ents(dump: Path, bsp: str):
    f = dump / "maps" / f"{bsp}.d3dbsp.ents"
    if not f.is_file():
        sys.exit(f"no map_ents at {f} -- did the unlink step include `mapents`?")
    txt = f.read_text(encoding="utf8", errors="replace")
    return [dict(ENT_KV.findall(b)) for b in ENT_BLOCK.findall(txt)]


def vec(s, n=3, default=0.0):
    parts = str(s or "").split()
    out = [default] * n
    for i in range(min(n, len(parts))):
        try:
            out[i] = float(parts[i])
        except ValueError:
            pass
    return out


def euler_to_quat(pitch, yaw, roll):
    """CoD `angles` is "pitch yaw roll" in degrees, applied Z(yaw) Y(pitch) X(roll).

    This is Quake's convention, not glTF's, and getting it wrong rotates every
    barrel onto its side in a way that looks deliberate. Written out rather than
    pulled from a library so the order is visible.
    """
    import math
    p, y, r = (math.radians(v) for v in (pitch, yaw, roll))
    cp, sp = math.cos(p / 2), math.sin(p / 2)
    cy, sy = math.cos(y / 2), math.sin(y / 2)
    cr, sr = math.cos(r / 2), math.sin(r / 2)
    # q = qz(yaw) * qy(pitch) * qx(roll)
    return [
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    ]


# OAT's glTF is Y-UP. A sandbag's POSITION max is [10.5, 9.7, 16.5] -- its height is on
# Y -- and a skinned model's `tag_origin` root carries the -90 deg X that put it there.
# `merge_model` copies meshes and drops node transforms, so without this every prop was
# placed on its side in our Z-up map: chairs, crates and sandbags jutting out of walls
# and floating (replay.md 8.3, B's report on m_0afb449b). Rx(+90) takes Y-up back to Z-up
# and is applied BEFORE the placement's own angles.
Y_UP_TO_Z_UP = [0.7071067811865476, 0.0, 0.0, 0.7071067811865476]


def quat_mul(a, b):
    """Hamilton product a*b, glTF order [x, y, z, w]."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


# ---------------------------------------------------------------------------
# step 3 -- glTF merge
# ---------------------------------------------------------------------------

class Glb:
    """A minimal glTF 2.0 writer.

    Deliberately hand-rolled: the node is a one-file script that has to run on a
    box with no npm prefix and no Blender, and everything it needs is an accessor
    copy and a buffer concat. It never *creates* geometry -- it only re-hosts
    what Unlinker already wrote -- so there is no mesh maths here to get wrong.
    """

    def __init__(self):
        self.j = {
            "asset": {"version": "2.0", "generator": "ENW Zombies tools/maps/export_map.py"},
            "scene": 0, "scenes": [{"nodes": []}],
            "nodes": [], "meshes": [], "materials": [], "textures": [], "samplers": [],
            "images": [], "accessors": [], "bufferViews": [],
        }
        self.bin = bytearray()
        self._tex_cache = {}
        self.alpha_textures = set()   # texture indices whose PNG uses its alpha (mark_cutout)

    def _align(self, n=4):
        while len(self.bin) % n:
            self.bin.append(0)

    def add_view(self, data: bytes, target=None, stride=None):
        self._align()
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        if stride:
            v["byteStride"] = stride
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def add_image_bytes(self, key, data: bytes, mime: str):
        if key in self._tex_cache:
            return self._tex_cache[key]
        vi = self.add_view(data)
        self.j["images"].append({"bufferView": vi, "mimeType": mime})
        if not self.j["samplers"]:
            self.j["samplers"].append({"wrapS": 10497, "wrapT": 10497,
                                       "magFilter": 9729, "minFilter": 9987})
        self.j["textures"].append({"sampler": 0, "source": len(self.j["images"]) - 1})
        ti = len(self.j["textures"]) - 1
        self._tex_cache[key] = ti
        return ti

    def write(self, path: Path):
        self._align()
        self.j["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.j, separators=(",", ":")).encode("utf8")
        js += b" " * ((4 - len(js) % 4) % 4)
        binpad = bytes(self.bin) + b"\0" * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(binpad)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(binpad), 0x004E4942))
            f.write(binpad)
        return total


def read_obj(obj_path: Path):
    """Husky's OBJ -> {material: {pos, nrm, uv, idx}}, ready to become primitives.

    Written here rather than pulled from a library because the whole file is three
    line prefixes and the only subtlety is the one below.

    THE V FLIP. OBJ puts the texture origin bottom-left; glTF puts it top-left.
    Husky already flipped CoD's top-left UVs on the way out, so flipping again on
    the way in is what puts them back. Get this wrong and every texture in the map
    is mirrored vertically, which on a brick wall is almost invisible and on a sign
    is obvious -- so it is checked against a sign, not a wall.
    """
    V, VT, VN = [], [], []
    groups = {}
    cur = None
    remap = {}

    def group(name):
        nonlocal cur, remap
        if name not in groups:
            groups[name] = {'pos': [], 'nrm': [], 'uv': [], 'idx': []}
        cur = groups[name]
        remap = {}
        return cur

    group('__default')
    with open(obj_path, encoding='utf8', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                p = line.split()
                V.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('vt '):
                p = line.split()
                VT.append((float(p[1]), 1.0 - float(p[2])))
            elif line.startswith('vn '):
                p = line.split()
                VN.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith('usemtl'):
                group(line.split(None, 1)[1].strip())
            elif line.startswith('f '):
                corners = line.split()[1:]
                poly = []
                for c in corners:
                    if c not in remap:
                        bits = c.split('/')
                        vi = int(bits[0]) - 1
                        ti = int(bits[1]) - 1 if len(bits) > 1 and bits[1] else -1
                        ni = int(bits[2]) - 1 if len(bits) > 2 and bits[2] else -1
                        cur['pos'].extend(V[vi])
                        cur['uv'].extend(VT[ti] if 0 <= ti < len(VT) else (0.0, 0.0))
                        cur['nrm'].extend(VN[ni] if 0 <= ni < len(VN) else (0.0, 0.0, 1.0))
                        remap[c] = len(cur['pos']) // 3 - 1
                    poly.append(remap[c])
                # Fan-triangulate. Husky writes triangles today (67 965 faces for
                # 203 895 indices, exactly 3 each), but a quad costs one line to
                # survive and a crash to not.
                for k in range(1, len(poly) - 1):
                    cur['idx'].extend((poly[0], poly[k], poly[k + 1]))

    return {k: v for k, v in groups.items() if v['idx']}


def read_mtl(mtl_path: Path):
    """material name -> diffuse texture stem, e.g. 'global_black' -> 'global_black_c'."""
    out = {}
    cur = None
    if not mtl_path.is_file():
        return out
    for line in mtl_path.read_text(encoding='utf8', errors='replace').splitlines():
        line = line.strip()
        if line.startswith('newmtl'):
            cur = line.split(None, 1)[1].strip()
        elif line.startswith('map_Kd') and cur:
            ref = line.split(None, 1)[1].strip().replace('\\', '/')
            out[cur] = Path(ref).stem
    return out


def drop_origin_brushmodels(groups: dict):
    """Remove the script_brushmodel geometry Husky leaves piled on the engine origin.

    MEASURED 2026-09-22 (replay.md §8.11, "position accuracy"): Husky writes every
    GfxWorld surface as-is, and a *brush model* (`script_brushmodel`, model "*N" -- the
    barricade planks, the debris piles, the hinged doors) is stored in GfxWorld in its
    OWN local space, centred on its entity origin. The engine moves it into place at
    run time; Husky does not. On Nacht that is ~49 islands / ~1 200 triangles of
    `makin_door_wood2` planks, `peleliu_trim_concrete_broken` chunks and one
    `okinawa_door_wood_heavy` door, all straddling (0,0,0) -- which is the middle of
    the start room, so a player walking across it walked "through" planks.

    They cannot be put back where they belong: nothing in Husky's output says which
    island is which "*N", and 127 brushmodels share a handful of materials. So they are
    dropped. The rule is geometric and narrow on purpose: a connected island whose
    bounding box is centred within 60 units of the origin in x and y, reaches below -2 (a
    real floor piece near the origin stays at z >= 0), and is under 250 units across.
    """
    dropped_islands = dropped_tris = 0
    for name, g in groups.items():
        pos, idx = g['pos'], g['idx']
        nv = len(pos) // 3
        parent = list(range(nv))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        weld = {}
        for v in range(nv):
            k = (round(pos[3 * v], 2), round(pos[3 * v + 1], 2), round(pos[3 * v + 2], 2))
            if k in weld:
                union(v, weld[k])
            else:
                weld[k] = v
        for t in range(0, len(idx), 3):
            union(idx[t], idx[t + 1])
            union(idx[t + 1], idx[t + 2])
        lo, hi = {}, {}
        for v in range(nv):
            r = find(v)
            p = pos[3 * v:3 * v + 3]
            if r not in lo:
                lo[r] = list(p)
                hi[r] = list(p)
            else:
                for i in range(3):
                    lo[r][i] = min(lo[r][i], p[i])
                    hi[r][i] = max(hi[r][i], p[i])
        bad = set()
        for r in lo:
            a, b = lo[r], hi[r]
            # Centred on the origin (within 60 units in x and y -- brush models are
            # built round their own origin, so their bounds are near-symmetric about it:
            # a door hinged there spans x -69..0, the concrete trim faces sit at y = -4)
            # and reaching below the floor. Measured on Nacht: this catches the planks,
            # the trim chunks and their faces, the door and the "help" chalk sign, and
            # nothing else (replay.md 8.11).
            cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            # A decal riding on one of those brush models (the blood splat on the "help"
            # sign, z 23..84) does not reach below the floor, so decals are matched by
            # material name instead.
            # (Engine units, after the 1/2.54 scale: a plank is +-42 x +-6 u about the origin.)
            below = a[2] < -2 and b[2] > 0
            if (abs(cx) < 60 and abs(cy) < 60 and (below or name.startswith('decal'))
                    and max(b[k] - a[k] for k in range(3)) < 250):
                bad.add(r)
        if not bad:
            continue
        keep = []
        for t in range(0, len(idx), 3):
            if find(idx[t]) in bad:
                dropped_tris += 1
            else:
                keep += idx[t:t + 3]
        dropped_islands += len(bad)
        g['idx'] = keep
    return dropped_islands, dropped_tris


# Props that legitimately hang in the air: lamps, wires, poles, the sky.
HANGS = ("light", "lamp", "lantern", "wire", "pole", "antenna", "bomber", "__")
# Props hung on walls by design: the wall-buy chalk weapons and the box.
WALL_HUNG = ("weapon_", "chalk", "grenade_bag", "treasure")


def count_unsupported_props(glb: 'Glb'):
    """Count props with no shell surface under them (replay.md §8.11, §8.12). Nothing is hidden.

    §8.11 hid 506 of them as "floating over missing floors". That was the shell being 2.54x
    too big (§8.12), not missing floors. At the true scale 143 remain, and they are sandbags
    stacked on sandbags, trees on terrain dips and props on brush models, so they are drawn
    and only counted: `props_unsupported` (nothing within 40 u below) and
    `props_unsupported_kept` (8-40 u under the shell's floor, or wall-hung)."""
    try:
        import numpy as np
    except ImportError:
        return {}
    groups = getattr(glb, "world_groups", None)
    if not groups:
        return {}
    tris = []
    for g in groups.values():
        P = np.asarray(g["pos"], dtype=np.float64).reshape(-1, 3)
        I = np.asarray(g["idx"], dtype=np.int64).reshape(-1, 3)
        if len(I):
            tris.append(P[I])
    T = np.concatenate(tris)
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    lo = T[:, :, :2].min(1)
    hi = T[:, :, :2].max(1)
    # A coarse XY grid over the triangles, so each prop tests the few hundred triangles in
    # its cell and not all of them: a custom map is up to ~1M triangles and ~5000 props,
    # and the unindexed version was O(props x triangles).
    CELL = 256.0
    grid = {}
    c0 = np.floor(lo / CELL).astype(np.int64)
    c1 = np.floor(hi / CELL).astype(np.int64)
    for ti in range(len(T)):
        for gx in range(c0[ti, 0], c1[ti, 0] + 1):
            for gy in range(c0[ti, 1], c1[ti, 1] + 1):
                grid.setdefault((gx, gy), []).append(ti)
    grid = {k: np.asarray(v, dtype=np.int64) for k, v in grid.items()}
    hidden = {}
    unsupported = {}
    scene = glb.j["scenes"][0]["nodes"]
    keep = []
    for ni in scene:
        node = glb.j["nodes"][ni]
        name = node.get("name", "")
        t = node.get("translation")
        if not t or any(h in name for h in HANGS):
            keep.append(ni)
            continue
        x, y, z = t
        cand = grid.get((int(np.floor(x / CELL)), int(np.floor(y / CELL))))
        if cand is None:
            cand = np.zeros(0, dtype=np.int64)
        m = cand[(lo[cand, 0] <= x) & (hi[cand, 0] >= x) & (lo[cand, 1] <= y) & (hi[cand, 1] >= y)]
        ok = False
        if len(m):
            A, B, C = a[m], b[m], c[m]
            v0 = C[:, :2] - A[:, :2]
            v1 = B[:, :2] - A[:, :2]
            v2 = np.array([x, y]) - A[:, :2]
            d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1)
            d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
            den = d00 * d11 - d01 * d01
            good = np.abs(den) > 1e-9
            den = np.where(good, den, 1)
            u = (d11 * d20 - d01 * d21) / den
            v = (d00 * d21 - d01 * d20) / den
            inside = good & (u >= -1e-3) & (v >= -1e-3) & (u + v <= 1 + 1e-3)
            zz = A[:, 2] + u * (C[:, 2] - A[:, 2]) + v * (B[:, 2] - A[:, 2])
            ok = bool((inside & (zz <= z + 8) & (zz >= z - 40)).any())
            sunk = bool((inside & (zz > z + 8) & (zz <= z + 40)).any())
        else:
            sunk = False
        if ok:
            keep.append(ni)
        elif sunk or any(k in name for k in WALL_HUNG):
            # Under a floor by 8-40 units (the engine's ground and the shell disagree), or
            # hung on a wall by design: drawn, and counted.
            keep.append(ni)
            unsupported[name] = unsupported.get(name, 0) + 1
        else:
            # Nothing within 40 units below it. Counted, and KEPT (§8.12): with the shell at
            # its true scale these are sandbags stacked on sandbags, trees on terrain
            # dips, and props on brush models -- not props floating over missing floors.
            keep.append(ni)
            hidden[name] = hidden.get(name, 0) + 1
    glb.j["scenes"][0]["nodes"] = keep
    glb.hidden_floating = hidden
    glb.unsupported = unsupported
    return hidden


def merge_world(glb: 'Glb', obj_path: Path, images_dir: Path, mat_cache: dict):
    """Fold a Husky world export into `glb` as one mesh. Returns the mesh index."""
    groups = read_obj(obj_path)
    # THE SCALE (replay.md §8.12). Husky writes the world in CENTIMETRES: every vertex is the
    # engine position x 2.54. Measured on Nacht against engine-unit anchors the fastfile
    # itself carries: the upstairs floor is at z 368.3 in the OBJ and Husky's own .map puts
    # the upstairs sandbags at z 145.0 (368.3 / 2.54 = 145.0); the 12 `exterior_goal` window
    # goals sit 56-61 u outside the nearest wall at 1/2.54 and 99-483 u away at 1:1. Only the
    # shell is scaled -- the .map placements, map_ents and the recording are already in
    # engine units. Before this, a floor at z 0 matched (0 x 2.54 = 0) and everything else
    # grew 2.54x away from the origin, which is what B saw.
    for g in groups.values():
        g['pos'] = [v / HUSKY_OBJ_SCALE for v in g['pos']]
    # Tool surfaces the engine never draws (caulk_shadow casts a shadow and nothing else, clips
    # are collision only). Husky exports them with their editor texture -- on Nacht a blue
    # "caulk" checker lying on the terrain outside the start room. Not drawn here either.
    tools = [k for k in groups if TOOL_MATERIAL.search(k)]
    for k in tools:
        del groups[k]
    glb.dropped_tool_materials = tools
    isl, tris = drop_origin_brushmodels(groups)
    glb.dropped_origin_brushmodels = (isl, tris)
    if isl:
        log(f"dropped {isl} brushmodel islands ({tris} triangles) piled on the engine origin")
    # Far-flung triangles. bcast's shell has a piece at y = 1 331 200 -- twenty times past the
    # engine's own world limit -- which made the map "1.3 million units long" and would make
    # the viewer's camera frame a void. Nothing a player can reach lies beyond +-65536 u, so
    # triangles with a vertex out there are dropped (counted in the sidecar) and the vertex
    # arrays compacted, so accessor bounds describe what is drawn.
    far = 0
    for g in groups.values():
        P, I = g['pos'], g['idx']
        keep = []
        for t in range(0, len(I), 3):
            if any(abs(P[3 * I[t + k] + c]) > WORLD_LIMIT for k in range(3) for c in range(3)):
                far += 1
            else:
                keep += I[t:t + 3]
        if len(keep) != len(I):
            used = sorted(set(keep))
            remap = {v: i for i, v in enumerate(used)}
            for key, w in (('pos', 3), ('nrm', 3), ('uv', 2)):
                A = g[key]
                g[key] = [A[w * v + c] for v in used for c in range(w)]
            g['idx'] = [remap[v] for v in keep]
    glb.dropped_far_triangles = far
    if far:
        log(f"dropped {far} shell triangles beyond +-{WORLD_LIMIT} u")
    groups = {k: g for k, g in groups.items() if g['idx']}
    # Kept for the floating-prop pass in build(): every surviving world triangle.
    glb.world_groups = groups
    tex_of = read_mtl(obj_path.with_suffix('.mtl'))
    prims = []
    for name, g in groups.items():
        pos = struct.pack(f'<{len(g["pos"])}f', *g['pos'])
        nrm = struct.pack(f'<{len(g["nrm"])}f', *g['nrm'])
        uv = struct.pack(f'<{len(g["uv"])}f', *g['uv'])
        idx = struct.pack(f'<{len(g["idx"])}I', *g['idx'])
        n = len(g['pos']) // 3
        xs = g['pos'][0::3]
        ys = g['pos'][1::3]
        zs = g['pos'][2::3]

        def acc(view, ctype, count, typ, extra=None):
            a = {'bufferView': view, 'componentType': ctype, 'count': count, 'type': typ}
            if extra:
                a.update(extra)
            glb.j['accessors'].append(a)
            return len(glb.j['accessors']) - 1

        ap = acc(glb.add_view(pos, target=34962), 5126, n, 'VEC3',
                 {'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]})
        an = acc(glb.add_view(nrm, target=34962), 5126, n, 'VEC3')
        au = acc(glb.add_view(uv, target=34962), 5126, n, 'VEC2')
        ai = acc(glb.add_view(idx, target=34963), 5125, len(g['idx']), 'SCALAR')

        key = f'world:{name}'
        if key not in mat_cache:
            m = {'name': key, 'doubleSided': True,
                 'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': 0.9}}
            stem = tex_of.get(name)
            if stem and PLACEHOLDER_TEX.search(stem):
                # Husky names the material's FIRST image as its diffuse. For a water/puddle
                # technique that slot is an engine placeholder -- Nacht's `puddle_muddy_green`
                # came out as `case64blue`, a bright blue checker lying in the mud. No texture;
                # a flat colour that reads as what it is.
                m['pbrMetallicRoughness']['baseColorFactor'] = (
                    [0.16, 0.17, 0.15, 1.0] if WATERY.search(name) else [0.35, 0.35, 0.35, 1.0])
                glb.placeholder_textures = getattr(glb, 'placeholder_textures', []) + [f'{name}:{stem}']
                stem = None
            if stem:
                got = load_dds(images_dir / f'{stem}.dds')
                if got:
                    ti = glb.add_image_bytes(f'{stem}.dds', got[0], got[1])
                    m['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti}
                    if got[2]:
                        glb.alpha_textures.add(ti)
                    mark_cutout(glb, m, ti)
            glb.j['materials'].append(m)
            mat_cache[key] = len(glb.j['materials']) - 1
        prims.append({'attributes': {'POSITION': ap, 'NORMAL': an, 'TEXCOORD_0': au},
                      'indices': ai, 'material': mat_cache[key]})

    if not prims:
        return None
    glb.j['meshes'].append({'name': 'world', 'primitives': prims})
    return len(glb.j['meshes']) - 1


def load_dds(path: Path, max_tex: int = 0):
    """DDS -> (png_or_jpeg_bytes, mime, alpha_used). Returns None if it cannot be read."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        im = Image.open(path)
        im.load()
    except Exception:
        return None
    lim = max_tex or MAX_TEX
    if max(im.size) > lim:
        s = lim / max(im.size)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))),
                       Image.LANCZOS)
    import io
    buf = io.BytesIO()
    if LOSSLESS_TEX:
        # export_all.py: the optimiser re-encodes every texture to WebP, so hand it
        # lossless pixels rather than JPEG it would compress a second time. Alpha is
        # still dropped when unused -- mark_cutout keys MASK off "PNG with alpha".
        if im.mode in ("RGBA", "LA", "P"):
            rgba = im.convert("RGBA")
            if rgba.getchannel("A").getextrema()[0] < 255:
                rgba.save(buf, "PNG", compress_level=1)
                return buf.getvalue(), "image/png", True
        im.convert("RGB").save(buf, "PNG", compress_level=1)
        return buf.getvalue(), "image/png", False
    # Alpha survives as PNG; everything else is a photo and compresses far better
    # as JPEG. A 1024 DXT1 diffuse is 680 KB as PNG and 38 KB as JPEG, and with
    # ~60 props in a map that is the difference between a 40 MB and a 6 MB .glb.
    #
    # But *most* of a CoD map's colour maps are DXT5 with an alpha channel that is
    # solid 255 -- the format was chosen for the material, not for this texture --
    # and taking that at face value is what made the first full export 66 MB. So
    # the question asked is "does this image USE its alpha", not "does it have
    # one". On Nacht that moves 211 textures from mostly-PNG to mostly-JPEG.
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        lo, hi = rgba.getchannel("A").getextrema()
        if lo == 255:
            im = rgba.convert("RGB")
        else:
            rgba.save(buf, "PNG", optimize=True)
            return buf.getvalue(), "image/png", True
    im.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), "image/jpeg", False


def mark_cutout(glb, material: dict, tex_index: int):
    """An alpha-tested CoD material (foliage, branches, wire, grilles) is a card whose
    shape IS its alpha. Written without `alphaMode` it is glTF's default OPAQUE and draws as
    a solid dark polygon -- on Nacht that is the 36 bare beech trees, 35 hedgerows and the
    grass clumps outside every window, which read in the viewer as black shards hanging over
    the start room (replay.md §8.11, "map clutter"). load_dds keeps a texture as PNG exactly
    when its alpha is used, so a PNG base colour means MASK at the engine's 0.5 cut."""
    if tex_index in glb.alpha_textures:
        name = material.get("name", "")
        if "skybox" in name:
            # The sky dome is drawn first with depth off (actors.js installSkyDome); a
            # blended sky would move to the transparent pass and paint the moon over walls.
            return
        if "glass" in name:
            # Soft alpha (windows) is blended, not cut.
            material["alphaMode"] = "BLEND"
        else:
            material["alphaMode"] = "MASK"
            material["alphaCutoff"] = 0.5


def merge_model(glb: Glb, gltf_path: Path, images_dir: Path, mat_cache: dict, max_tex: int = 0):
    """Copy one Unlinker .gltf's meshes into `glb`. Returns the new mesh index."""
    src = json.loads(gltf_path.read_text(encoding="utf8"))
    bufs = []
    for b in src.get("buffers", []):
        uri = b.get("uri", "")
        if uri.startswith("data:"):
            bufs.append(base64.b64decode(uri.split(",", 1)[1]))
        else:
            bufs.append((gltf_path.parent / uri).read_bytes())

    # bufferViews -> new indices
    vmap = {}
    for i, v in enumerate(src.get("bufferViews", [])):
        data = bufs[v.get("buffer", 0)]
        off = v.get("byteOffset", 0)
        vmap[i] = glb.add_view(data[off:off + v["byteLength"]],
                               target=v.get("target"), stride=v.get("byteStride"))

    amap = {}
    for i, a in enumerate(src.get("accessors", [])):
        na = dict(a)
        if "bufferView" in na:
            na["bufferView"] = vmap[na["bufferView"]]
        glb.j["accessors"].append(na)
        amap[i] = len(glb.j["accessors"]) - 1

    # images/textures -> ours, de-duplicated across every model in the map
    tmap = {}
    for i, t in enumerate(src.get("textures", [])):
        img = src["images"][t["source"]]
        uri = img.get("uri", "")
        name = Path(uri).name
        cand = images_dir / name
        if not cand.is_file():
            continue
        # Props get PROP_TEX (B, 2026-09-23: "downscale prop textures"): a crate is a few
        # dozen pixels on screen at replay distance. Keyed apart from the shell's copy so a
        # texture both use keeps the shell's resolution there.
        got = load_dds(cand, max_tex or PROP_TEX)
        if not got:
            continue
        tmap[i] = glb.add_image_bytes(f"prop{max_tex or PROP_TEX}:{name}", got[0], got[1])
        if got[2]:
            glb.alpha_textures.add(tmap[i])

    mmap = {}
    for i, m in enumerate(src.get("materials", [])):
        key = m.get("name") or f"{gltf_path.stem}:{i}"
        if key in mat_cache:
            mmap[i] = mat_cache[key]
            continue
        nm = {"name": key, "doubleSided": True,
              "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.85}}
        pbr = m.get("pbrMetallicRoughness", {})
        bct = pbr.get("baseColorTexture")
        if bct and bct.get("index") in tmap:
            nm["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tmap[bct["index"]]}
            mark_cutout(glb, nm, tmap[bct["index"]])
        glb.j["materials"].append(nm)
        mat_cache[key] = len(glb.j["materials"]) - 1
        mmap[i] = mat_cache[key]

    prims = []
    for mesh in src.get("meshes", []):
        for p in mesh.get("primitives", []):
            np_ = {"attributes": {k: amap[v] for k, v in p["attributes"].items()
                                  if v in amap}}
            if "indices" in p:
                np_["indices"] = amap[p["indices"]]
            if p.get("material") in mmap:
                np_["material"] = mmap[p["material"]]
            # JOINTS_0/WEIGHTS_0 come along on a character model and mean nothing
            # without the skin, which we do not copy. Dropping them keeps three
            # from looking for one.
            np_["attributes"].pop("JOINTS_0", None)
            np_["attributes"].pop("WEIGHTS_0", None)
            prims.append(np_)
    if not prims:
        return None
    glb.j["meshes"].append({"name": gltf_path.stem, "primitives": prims})
    return len(glb.j["meshes"]) - 1


def build(bsp: str, dump: Path, out_dir: Path, world: Path | None):
    ents = read_ents(dump, bsp)
    models = dump / "model_export"
    images = dump / "images"

    # Husky writes a `<map>.map` beside the OBJ holding the **static** model
    # placements -- 1506 of them on Nacht against map_ents' 54. That is the other
    # half of what GfxWorld was hiding: a stock map's props are baked in at compile
    # time as smodels, and map_ents only ever carried the ones a script can touch.
    # Same `"key" "value"` shape and the same classname vocabulary (misc_model,
    # origin, angles, modelscale), so it parses with the same two regexes.
    world_models = 0
    if world:
        side = world.with_suffix(".map")
        if side.is_file():
            txt = side.read_text(encoding="utf8", errors="replace")
            extra = [dict(ENT_KV.findall(b)) for b in ENT_BLOCK.findall(txt)]
            # Appended, never prepended: the worldspawn lookup below must keep
            # finding map_ents' worldspawn, which is the one with the real sun.
            extra = [e for e in extra if e.get("classname") in PLACEABLE]
            world_models = len(extra)
            ents = ents + extra
            log(f"{world_models} static models from {side.name}")

    glb = Glb()
    mat_cache = {}
    mesh_of = {}          # model name -> mesh index (one copy, many nodes)
    placed = skipped = 0
    hidden_small = {}

    def mesh_extent(mi):
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for pr in glb.j["meshes"][mi]["primitives"]:
            a = glb.j["accessors"][pr["attributes"]["POSITION"]]
            for i in range(3):
                lo[i] = min(lo[i], a["min"][i])
                hi[i] = max(hi[i], a["max"][i])
        return max(hi[i] - lo[i] for i in range(3))

    worldspawn = next((e for e in ents if e.get("classname") == "worldspawn"), {})

    def mesh_for(name, max_tex=0):
        if name in mesh_of:
            return mesh_of[name]
        # lod0 is the one the player sees. Unlinker writes <name>_lod{0..3}.gltf.
        p = models / f"{name}_lod0.gltf"
        if not p.is_file():
            p = models / f"{name}.gltf"
        mesh_of[name] = merge_model(glb, p, images, mat_cache, max_tex) if p.is_file() else None
        return mesh_of[name]

    for e in ents:
        if e.get("classname") not in PLACEABLE:
            continue
        name = e.get("model")
        if not name:
            continue
        mi = mesh_for(name)
        if mi is None:
            skipped += 1
            continue
        sc_ = e.get("modelscale")
        try:
            s_ = float(sc_) if sc_ else 1.0
        except ValueError:
            s_ = 1.0
        if mesh_extent(mi) * s_ < MIN_PROP_SIZE:
            hidden_small[name] = hidden_small.get(name, 0) + 1
            continue
        node = {"name": name, "mesh": mi, "translation": vec(e.get("origin"))}
        ang = vec(e.get("angles"))
        node["rotation"] = quat_mul(euler_to_quat(*ang), Y_UP_TO_Z_UP)
        sc = e.get("modelscale")
        if sc:
            try:
                s = float(sc)
                if s != 1.0:
                    node["scale"] = [s, s, s]
            except ValueError:
                pass
        glb.j["nodes"].append(node)
        glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
        placed += 1

    # The sky. worldspawn names an xmodel (`skyboxmodel "skybox_zombie"`), which
    # is a real dome with the map's own moon/cloud texture on it -- not a cubemap.
    # It is emitted as a node named `__sky` and the viewer parents it to the
    # camera, so it never gets closer and never clips.
    sky_name = worldspawn.get("skyboxmodel")
    sky_ok = False
    if sky_name:
        mi = mesh_for(sky_name, MAX_TEX)   # the sky fills the screen: shell resolution
        if mi is not None:
            glb.j["nodes"].append({"name": "__sky", "mesh": mi, "rotation": Y_UP_TO_Z_UP})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
            sky_ok = True

    if world and world.is_file():
        mi = (merge_world(glb, world, images, mat_cache) if world.suffix.lower() == ".obj"
              else merge_model(glb, world, images, mat_cache))
        if mi is not None:
            glb.j["nodes"].append({"name": "__world", "mesh": mi})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
            log(f"world shell merged from {world.name}")
            floating = count_unsupported_props(glb)
            if floating:
                log(f"{sum(floating.values())} props have nothing under them within 40 u and "
                    f"{sum(glb.unsupported.values())} sit under the shell's floor or on walls "
                    f"(all kept, counted in the sidecar)")

    out_dir.mkdir(parents=True, exist_ok=True)
    size = glb.write(out_dir / f"{bsp}.glb")

    # The sidecar. Everything the viewer needs that is not geometry: where the
    # player spawns (so an empty replay still frames the map), the sun and ambient
    # the map author chose, and the placements we could NOT draw.
    meta = {
        "bsp": bsp,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "units": "cod-inches",
        "up": "z",
        "coordinate_note": "raw engine coordinates; the viewer maps (x,y,z)->(x,z,-y)",
        "glb_bytes": size,
        "props_placed": placed,
        "props_missing_model": skipped,
        "props_hidden_small": hidden_small,
        "props_unsupported": getattr(glb, "hidden_floating", {}),
        "props_unsupported_kept": getattr(glb, "unsupported", {}),
        "min_prop_size": MIN_PROP_SIZE,
        "world_obj_scale": HUSKY_OBJ_SCALE if (world and world.suffix.lower() == ".obj") else None,
        "world_tool_materials_dropped": getattr(glb, "dropped_tool_materials", []),
        "world_placeholder_textures": getattr(glb, "placeholder_textures", []),
        "world_far_triangles_dropped": getattr(glb, "dropped_far_triangles", 0),
        "world_origin_brushmodels_dropped": list(getattr(glb, "dropped_origin_brushmodels", (0, 0))),
        "sky_model": sky_name if sky_ok else None,
        "world_shell": bool(world and world.is_file()),
        "world_source": world.name if (world and world.is_file()) else None,
        "static_models_placed": world_models,
        "spawn": vec(next((e.get("origin") for e in ents
                           if e.get("classname") == "info_player_start"), "0 0 0")),
        "sun": {
            "direction": vec(worldspawn.get("sundirection")),
            "color": vec(worldspawn.get("suncolor", "1 1 1")),
            "light": float(worldspawn.get("sunlight") or 1.0),
            "ambient": float(worldspawn.get("ambient") or 0.1),
            "diffuse_fraction": float(worldspawn.get("diffusefraction") or 0.15),
        },
        # Where the zombies come from and where the players can walk: both are real
        # recorded map data and both are useful to draw while the shell is missing.
        "pathnodes": [vec(e.get("origin")) for e in ents
                      if e.get("classname", "").startswith("node_pathnode")],
        "spawners": [vec(e.get("origin")) for e in ents
                     if e.get("classname", "").startswith("actor_axis")],
        "brushmodels_unresolved": sum(1 for e in ents
                                      if e.get("classname") == "script_brushmodel"),
        # Engine-unit anchors out of map_ents, for the alignment checks (replay.md §8.12):
        # the viewer's ?r3ddebug overlay and web/test/map-align.js compare the recording and
        # the .glb against these, so a unit or placement error in the shell is a number.
        "spawns": [vec(e.get("origin")) for e in ents
                   if e.get("classname") == "info_player_start"
                   or e.get("targetname") == "initial_spawn_points"],
        "window_goals": [vec(e.get("origin")) for e in ents
                         if e.get("targetname") == "exterior_goal"],
        "anchors": [{"model": e.get("model"), "origin": vec(e.get("origin"))} for e in ents
                    if e.get("classname") == "script_model" and e.get("model")
                    and not e.get("model", "").startswith("*")][:64],
    }
    (out_dir / f"{bsp}.meta.json").write_text(json.dumps(meta, indent=1))
    log(f"{bsp}.glb  {size / 1048576:.2f} MB  "
        f"{placed} props, {len(glb.j['meshes'])} meshes, "
        f"{len(glb.j['images'])} textures, sky={'yes' if sky_ok else 'NO'}")
    if not meta["world_shell"]:
        log("NOTE: no world shell. GfxWorld is not exportable from a fastfile; see "
            "docs/kickstart/replay.md §4. Pass --world <husky.gltf> to merge one.")
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bsp", help="map name, e.g. nazi_zombie_prototype")
    ap.add_argument("--out", default=None, help="output dir (default ZombiesDev/maps/<bsp>)")
    ap.add_argument("--work", default=None, help="scratch dir (default ZombiesDev/maps/_work)")
    ap.add_argument("--world", default=None,
                    help="the world shell from Husky/C2M (.obj or .gltf), merged as __world. "
                         "A `<same-name>.map` beside it is read for static model placements")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    work = Path(a.work) if a.work else DEV / "maps" / "_work"
    out = Path(a.out) if a.out else DEV / "maps" / a.bsp
    dump = unlink(a.bsp, work, a.force)
    build(a.bsp, dump, out, Path(a.world) if a.world else None)


if __name__ == "__main__":
    main()
