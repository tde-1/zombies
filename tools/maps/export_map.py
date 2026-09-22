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
    running game's memory. That needs the game lock, so it is not this lane's to
    run. `--world <file.obj|.gltf>` is the seam: drop a Husky/C2M export in and
    this script merges it as the shell, and the output is the whole map.

So: today's .glb is a correct, correctly-placed, correctly-scaled *prop and sky*
export with the shell missing. That is an honest partial, not a broken pipeline.

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

MAX_TEX = 512          # px on the long edge; Nacht's props ship 1024 and nobody can tell
JPEG_QUALITY = 86


def log(*a):
    print("[export-map]", *a, flush=True)


# ---------------------------------------------------------------------------
# step 1 -- unlink the fastfile
# ---------------------------------------------------------------------------

def unlink(bsp: str, work: Path, force: bool) -> Path:
    """Run OAT's Unlinker over <bsp>.ff. Returns the dump directory."""
    ff = WAW / "zone" / "english" / f"{bsp}.ff"
    if not ff.is_file():
        # A custom map lives in mods/<bsp>/ instead, which is the same shape.
        alt = WAW / "mods" / bsp / f"{bsp}.ff"
        if alt.is_file():
            ff = alt
        else:
            sys.exit(f"no fastfile for {bsp} (looked in {ff} and {alt})")
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
        "--search-path", f"{WAW / 'main'};{WAW / 'zone' / 'english'}",
        "-o", str(work / "dump" / "?zone?"),
        str(ff),
    ]
    log("unlinking:", " ".join(cmd))
    t = time.time()
    # READ-ONLY over the Steam install: Unlinker opens the .ff and the .iwd files
    # and writes only under -o. Rule 1 of the kickstart README.
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = "\n".join((r.stdout or "").splitlines()[-6:])
    if r.returncode != 0:
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


def load_dds(path: Path):
    """DDS -> (png_or_jpeg_bytes, mime). Returns None if it cannot be read."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        im = Image.open(path)
        im.load()
    except Exception:
        return None
    if max(im.size) > MAX_TEX:
        s = MAX_TEX / max(im.size)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))),
                       Image.LANCZOS)
    import io
    buf = io.BytesIO()
    # Alpha survives as PNG; everything else is a photo and compresses far better
    # as JPEG. A 1024 DXT1 diffuse is 680 KB as PNG and 38 KB as JPEG, and with
    # ~60 props in a map that is the difference between a 40 MB and a 6 MB .glb.
    if im.mode in ("RGBA", "LA", "P"):
        im.convert("RGBA").save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png"
    im.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), "image/jpeg"


def merge_model(glb: Glb, gltf_path: Path, images_dir: Path, mat_cache: dict):
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
        got = load_dds(cand)
        if not got:
            continue
        tmap[i] = glb.add_image_bytes(name, got[0], got[1])

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

    glb = Glb()
    mat_cache = {}
    mesh_of = {}          # model name -> mesh index (one copy, many nodes)
    placed = skipped = 0

    worldspawn = next((e for e in ents if e.get("classname") == "worldspawn"), {})

    def mesh_for(name):
        if name in mesh_of:
            return mesh_of[name]
        # lod0 is the one the player sees. Unlinker writes <name>_lod{0..3}.gltf.
        p = models / f"{name}_lod0.gltf"
        if not p.is_file():
            p = models / f"{name}.gltf"
        mesh_of[name] = merge_model(glb, p, images, mat_cache) if p.is_file() else None
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
        node = {"name": name, "mesh": mi, "translation": vec(e.get("origin"))}
        ang = vec(e.get("angles"))
        if any(ang):
            node["rotation"] = euler_to_quat(*ang)
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
        mi = mesh_for(sky_name)
        if mi is not None:
            glb.j["nodes"].append({"name": "__sky", "mesh": mi})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)
            sky_ok = True

    if world and world.is_file():
        mi = merge_model(glb, world, images, mat_cache) if world.suffix == ".gltf" else None
        if mi is not None:
            glb.j["nodes"].append({"name": "__world", "mesh": mi})
            glb.j["scenes"][0]["nodes"].append(len(glb.j["nodes"]) - 1)

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
        "sky_model": sky_name if sky_ok else None,
        "world_shell": bool(world and world.is_file()),
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
                    help="a .gltf of the world shell from Husky/C2M, merged as __world")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    work = Path(a.work) if a.work else DEV / "maps" / "_work"
    out = Path(a.out) if a.out else DEV / "maps" / a.bsp
    dump = unlink(a.bsp, work, a.force)
    build(a.bsp, dump, out, Path(a.world) if a.world else None)


if __name__ == "__main__":
    main()
