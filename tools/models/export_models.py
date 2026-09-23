#!/usr/bin/env python3
"""
Player and zombie models for the 3D replay viewer (docs/kickstart/replay.md §9).

    python tools/models/export_models.py            # unlink (if stale) + build every model
    python tools/models/export_models.py --force    # redo everything
    python tools/models/export_models.py --list     # print the model table and exit

What it does:

  1. OpenAssetTools' Unlinker (GPL-3.0, run as an external program, never vendored) dumps
     xmodel + material + image + rawfile out of B's stock zombie fastfiles, READ-ONLY over
     the Steam install, into ZombiesDev/modelwork/dump/<zone>/. Unlinker writes each xmodel
     as a skinned glTF (bind pose, JOINTS_0/WEIGHTS_0, the xmodel's bones as nodes) with its
     images as DDS next to it.
  2. Each output model is one or more xmodel PARTS that the game attaches together
     (a zombie is body + head; Takeo is body + head + hat). The parts share the one T4
     humanoid rig, bone-for-bone by name, so the parts are merged onto the body's skeleton:
     a head vertex weighted to the head's `j_head` is re-pointed at the body's `j_head`.
  3. Primitives that sample the same colour texture are merged (the body xmodel alone has
     four or five materials over one texture), so a character is 2-3 draw calls.
  4. Colour textures are downscaled and re-encoded (JPEG unless the alpha is used, then
     PNG); normal/spec maps are dropped. Every model has a byte budget (BUDGET) and the
     build fails loudly if one goes over.
  5. Output: ZombiesDev/maps/_models/<id>.glb + models.json (which model is which, the
     per-map sets, sizes, built_at). The site already serves ZombiesDev/maps at /mapdata,
     so the viewer fetches /mapdata/_models/<id>.glb. Nothing here is ever committed: the
     meshes and textures are Treyarch's, re-encoded.

Frame: Unlinker's glTF is Y-up with the engine's +X forward (engine (x, y, z) -> glTF
(x, z, -y)), which is exactly scene.js's toThree, and in engine inches -- the same scale as
the recording and the (corrected, replay.md §8.12) world shell. Nothing is rescaled.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs numpy and Pillow: python -m pip install numpy pillow")

WAW = Path(os.environ.get(
    "ZM_WAW", r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"))
DEV = Path(os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev"))
OAT = DEV / "tools" / "oat" / "Unlinker.exe"
WORK = DEV / "modelwork"
OUT = Path(os.environ.get("ZM_MODELS_OUT", str(DEV / "maps" / "_models")))

ZONES = ["nazi_zombie_prototype", "nazi_zombie_asylum", "nazi_zombie_sumpf", "nazi_zombie_factory"]

BODY_TEX = 512          # px, long edge, for the sheet that covers most of the triangles
PART_TEX = 256          # px, every other sheet (heads, hats, helmets, gear, eyes)
JPEG_QUALITY = 82
BUDGET = 700 * 1024     # bytes per .glb; the build fails over it

# ---------------------------------------------------------------------------
# The model table. Every row is what the game's own character scripts attach, read out of
# the unlinked rawfiles (ZombiesDev/modelwork/dump/<zone>/character/*.gsc):
#
#   players, Nacht + Verruckt + every map not on the heroes list:
#     _loadout.gsc give_model -> mptype\player_usa_marine -> get_random_character(4) ->
#     common\character\char_usa_marine_player1..4 (body + head + helmet + gear)
#   players, Shi No Numa + Der Riese:
#     _loadout.gsc give_model -> switch(self.entity_num) -> char_zomb_player_0..3
#     (0 Dempsey, 1 Nikolai, 2 Takeo, 3 Richtofen)
#   zombies: character\char_ger_honorguard(2)_zombies (Nacht, Verruckt: body1/2_1, body1/2_2),
#     the same with the bodyz alias (Der Riese), char_jap_zombie (Shi No Numa: body5z_1/2 +
#     one of nine heads + cap); head = randomElement(zombieheadalias) of 24.
#   hellhound: character_sp_zombie_dog(_black_fur) -> zombie_wolf.
#
# (id, zone, kind, parts, lod). The first part is the body; its skeleton is the model's.
# ---------------------------------------------------------------------------
P = "nazi_zombie_prototype"
F = "nazi_zombie_factory"
S = "nazi_zombie_sumpf"
MODELS = [
    # the four generic Marines (char_usa_marine_player1..4), in the scripts' order
    ("marine_1", P, "player", ["char_usa_marine_player_body1_1", "char_usa_marine_head1_1", "char_usa_raider_helm1", "char_usa_raider_gear2"], 0),
    ("marine_2", P, "player", ["char_usa_marine_player_body2_1", "char_usa_marine_head2_2", "char_usa_raider_helm2", "char_usa_raider_gear3"], 0),
    ("marine_3", P, "player", ["char_usa_marine_player_body1_1", "char_usa_marine_head3_3", "char_usa_raider_helm2", "char_usa_raider_gear2"], 0),
    ("marine_4", P, "player", ["char_usa_marine_player_body2_1", "char_usa_marine_head4_4", "char_usa_raider_helm1", "char_usa_raider_gear3"], 0),
    # the four heroes (char_zomb_player_0..3)
    ("dempsey", F, "player", ["char_usa_marine_polonsky_zomb"], 1),
    ("nikolai", F, "player", ["char_rus_guard_chernova_zomb"], 1),
    ("takeo", F, "player", ["char_jap_impinf_officer_body_zomb", "char_jap_impinf_officer_head", "char_jap_impinf_officer_hat_zomb"], 1),
    ("richtofen", F, "player", ["char_ger_ansel_body_zomb", "char_ger_ansel_head_zomb", "char_ger_waffen_officercap1_zomb"], 1),
    # Nacht / Verruckt zombies: each body alias entry with a different head
    ("zombie_nacht_1", P, "zombie", ["char_ger_honorgd_body1_1", "char_ger_honorgd_zombiehead1_1"], 1),
    ("zombie_nacht_2", P, "zombie", ["char_ger_honorgd_body2_1", "char_ger_honorgd_zombiehead2_3"], 1),
    ("zombie_nacht_3", P, "zombie", ["char_ger_honorgd_body1_2", "char_ger_honorgd_zombiehead3_5"], 1),
    ("zombie_nacht_4", P, "zombie", ["char_ger_honorgd_body2_2", "char_ger_honorgd_zombiehead4_2"], 1),
    # Der Riese zombies (the bodyz alias)
    ("zombie_factory_1", F, "zombie", ["char_ger_honorgd_bodyz1_1", "char_ger_honorgd_zombiehead1_4"], 1),
    ("zombie_factory_2", F, "zombie", ["char_ger_honorgd_bodyz2_1", "char_ger_honorgd_zombiehead2_6"], 1),
    ("zombie_factory_3", F, "zombie", ["char_ger_honorgd_bodyz1_2", "char_ger_honorgd_zombiehead3_2"], 1),
    ("zombie_factory_4", F, "zombie", ["char_ger_honorgd_bodyz2_2", "char_ger_honorgd_zombiehead4_5"], 1),
    # Shi No Numa zombies (char_jap_zombie: body5z + head + cap)
    ("zombie_sumpf_1", S, "zombie", ["char_jap_impinf_body5z_1", "char_jap_impinf2_zombiehead1_1", "char_jap_impinf2_cap1"], 1),
    ("zombie_sumpf_2", S, "zombie", ["char_jap_impinf_body5z_2", "char_jap_impinf2_zombiehead2_2", "char_jap_impinf2_cap1"], 1),
    ("zombie_sumpf_3", S, "zombie", ["char_jap_impinf_body5z_1", "char_jap_impinf2_zombiehead3_3"], 1),
    # the hellhound
    ("hellhound", F, "dog", ["zombie_wolf"], 1),
]

MARINES = ["marine_1", "marine_2", "marine_3", "marine_4"]
HEROES = ["dempsey", "nikolai", "takeo", "richtofen"]
Z_NACHT = ["zombie_nacht_1", "zombie_nacht_2", "zombie_nacht_3", "zombie_nacht_4"]
Z_FACTORY = ["zombie_factory_1", "zombie_factory_2", "zombie_factory_3", "zombie_factory_4"]
Z_SUMPF = ["zombie_sumpf_1", "zombie_sumpf_2", "zombie_sumpf_3"]

# Per stock map: what the game dresses players and zombies in. `players` is indexed by the
# player's slot (= entity_num for the heroes, which is exactly the game's rule; the Marines
# are get_random_character(4) in the game, so slot is a stand-in there and says so).
STOCK_SETS = {
    "nazi_zombie_prototype": {"players": MARINES, "player_rule": "slot (game: random of 4)", "zombies": Z_NACHT},
    "nazi_zombie_asylum": {"players": MARINES, "player_rule": "slot (game: random of 4)", "zombies": Z_NACHT},
    "nazi_zombie_sumpf": {"players": HEROES, "player_rule": "entity_num", "zombies": Z_SUMPF, "dogs": ["hellhound"]},
    "nazi_zombie_factory": {"players": HEROES, "player_rule": "entity_num", "zombies": Z_FACTORY, "dogs": ["hellhound"]},
}
DEFAULT_SET = {"players": MARINES, "player_rule": "slot (fallback)", "zombies": Z_NACHT, "dogs": ["hellhound"]}


def log(*a):
    print("[export-models]", *a, flush=True)


# ---------------------------------------------------------------------------
# step 1 -- unlink
# ---------------------------------------------------------------------------

# Scripts only: which character a player is dressed as is decided in _loadout.gsc, which
# lives in the shared zones, not the map's.
SCRIPT_ZONES = ["common", "patch", "nazi_zombie_asylum_patch", "nazi_zombie_sumpf_patch",
                "nazi_zombie_factory_patch"]


def unlink(zone: str, force: bool, assets: str = "xmodel,material,image,rawfile") -> Path:
    ff = WAW / "zone" / "english" / f"{zone}.ff"
    if not ff.is_file():
        sys.exit(f"no fastfile {ff}")
    if not OAT.is_file():
        sys.exit(f"OpenAssetTools is not installed at {OAT} (replay.md §4: oat-windows.zip v0.33.0)")
    out = WORK / "dump" / zone
    stamp = out / ".unlinked"
    if stamp.is_file() and not force and stamp.stat().st_mtime > ff.stat().st_mtime:
        return out
    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(OAT),
        "--model-format", "GLTF",
        "--image-format", "DDS",
        "--include-assets", assets,
        "--search-path", f"{WAW / 'main'};{WAW / 'zone' / 'english'}",
        "-o", str(WORK / "dump" / "?zone?"),
        str(ff),
    ]
    log("unlinking:", " ".join(cmd))
    t = time.time()
    # READ-ONLY over the Steam install (kickstart rule 1): Unlinker opens the .ff and the
    # .iwd files and writes only under -o.
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Unlinker failed ({r.returncode}):\n{(r.stdout or '')[-2000:]}\n{r.stderr[-2000:]}")
    log(f"unlinked {zone} in {time.time() - t:.1f}s")
    stamp.write_text("ok")
    return out


# ---------------------------------------------------------------------------
# custom maps -- what does the map's own fastfile dress people in?
# ---------------------------------------------------------------------------

ARCHIVE_MODS = DEV / "archive" / "mods"
HERO_BODIES = {"char_usa_marine_polonsky_zomb", "char_rus_guard_chernova_zomb",
               "char_jap_impinf_officer_body_zomb", "char_ger_ansel_body_zomb"}


def list_xmodels(ff: Path) -> set:
    r = subprocess.run([str(OAT), "--list",
                        "--search-path", f"{WAW / 'main'};{WAW / 'zone' / 'english'}", str(ff)],
                       capture_output=True, text=True)
    out = set()
    for line in (r.stdout or "").splitlines():
        if line.startswith("xmodel, "):
            out.add(line.split(", ", 1)[1].strip().lstrip(","))
    return out


def classify_customs(force: bool) -> dict:
    """For every custom map in the archive, choose the stock set by what its own fastfiles
    carry. `Unlinker --list` only reads the zone's asset table; nothing is dumped. Cached by
    (file, size, mtime)."""
    cache_path = WORK / "customs.json"
    cache = {}
    if cache_path.is_file() and not force:
        cache = json.loads(cache_path.read_text(encoding="utf8"))
    out = {}
    if not ARCHIVE_MODS.is_dir():
        return out
    for d in sorted(ARCHIVE_MODS.iterdir()):
        if not d.is_dir():
            continue
        ffs = sorted(p for p in d.glob("*.ff"))
        bsps = [p.stem for p in ffs if p.stem != "mod" and not p.stem.lower().startswith("localized_")
                and "_patch" not in p.stem and not p.stem.endswith("_load")]
        if not bsps:
            continue
        models = set()
        for ff in ffs:
            st = ff.stat()
            key = f"{ff}|{st.st_size}|{int(st.st_mtime)}"
            if key not in cache:
                cache[key] = sorted(list_xmodels(ff))
            models.update(cache[key])
        if models & HERO_BODIES:
            players, why = "heroes", "fastfile carries the four heroes' bodies"
        elif any(m.startswith("char_rus_guard_player_body") for m in models):
            players, why = "marines", "fastfile carries Russian player bodies (not exported; Marines instead)"
        elif any(m.startswith("char_usa_marine_player_body") for m in models):
            players, why = "marines", "fastfile carries the Marine player bodies"
        else:
            players, why = "marines", "no stock player body in the fastfile (custom characters): stock Marines"
        if any(m.startswith("char_ger_honorgd_bodyz") for m in models):
            zombies = "factory"
        elif any(m.startswith("char_jap_impinf_body5z") for m in models):
            zombies = "sumpf"
        elif any(m.startswith("char_ger_honorgd_body") for m in models):
            zombies = "nacht"
        else:
            zombies = "nacht-fallback"
        custom_chars = sorted(m for m in models if m.startswith("char_") and "zombiehead" not in m
                              and not m.startswith(("char_ger_honorgd", "char_usa_marine", "char_usa_raider",
                                                    "char_jap_impinf", "char_rus_guard_chernova",
                                                    "char_ger_ansel", "char_ger_waffen_officercap1_zomb",
                                                    "char_ger_zombieeye")))
        for bsp in bsps:
            out[bsp] = {"players": HEROES if players == "heroes" else MARINES,
                        "player_rule": "entity_num" if players == "heroes" else "slot (fallback)",
                        "why": why,
                        "zombies": {"factory": Z_FACTORY, "sumpf": Z_SUMPF}.get(zombies, Z_NACHT),
                        "zombie_rule": zombies, "dogs": ["hellhound"],
                        "custom_characters": custom_chars[:12]}
    WORK.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache), encoding="utf8")
    return out


# ---------------------------------------------------------------------------
# step 2 -- read Unlinker's glTF
# ---------------------------------------------------------------------------

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def q2m(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class Gltf:
    def __init__(self, path: Path):
        self.path = path
        self.j = json.loads(path.read_text(encoding="utf8"))
        self.bufs = []
        for b in self.j["buffers"]:
            uri = b["uri"]
            if uri.startswith("data:"):
                self.bufs.append(base64.b64decode(uri.split(",", 1)[1]))
            else:
                self.bufs.append((path.parent / uri).read_bytes())
        n = self.j["nodes"]
        self.parent = {}
        for i, nd in enumerate(n):
            for c in nd.get("children", []):
                self.parent[c] = i
        # World (bind) matrix of every node, from the hierarchy's own TRS.
        self.world = [None] * len(n)
        for i in range(len(n)):
            self._w(i)
        self.by_name = {nd.get("name"): i for i, nd in enumerate(n)}

    def _w(self, i):
        if self.world[i] is not None:
            return self.world[i]
        nd = self.j["nodes"][i]
        m = np.eye(4)
        if "matrix" in nd:
            m = np.array(nd["matrix"], dtype=float).reshape(4, 4).T
        else:
            if "scale" in nd:
                m = np.diag(list(nd["scale"]) + [1.0])
            if "rotation" in nd:
                r = np.eye(4); r[:3, :3] = q2m(nd["rotation"]); m = r @ m
            if "translation" in nd:
                t = np.eye(4); t[:3, 3] = nd["translation"]; m = t @ m
        p = self.parent.get(i)
        self.world[i] = (self._w(p) @ m) if p is not None else m
        return self.world[i]

    def acc(self, i):
        a = self.j["accessors"][i]
        bv = self.j["bufferViews"][a["bufferView"]]
        dt = np.dtype(CT[a["componentType"]])
        n = NC[a["type"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride") or dt.itemsize * n
        arr = np.ndarray((a["count"], n), dtype=dt, buffer=self.bufs[bv["buffer"]], offset=off,
                         strides=(stride, dt.itemsize)).copy()
        if a.get("normalized"):
            arr = arr.astype(np.float32) / float(np.iinfo(dt).max)
        return arr

    def image_of(self, mat_index):
        """The colour map's DDS path for a material, or None."""
        if mat_index is None:
            return None
        m = self.j["materials"][mat_index]
        t = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if not t:
            return None
        img = self.j["images"][self.j["textures"][t["index"]]["source"]]
        return (self.path.parent / img["uri"]).resolve()


def part_path(zone: str, name: str, lod: int) -> Path:
    for z in [zone] + [x for x in ZONES if x != zone]:
        for l in [lod, 0]:
            p = WORK / "dump" / z / "model_export" / f"{name}_lod{l}.gltf"
            if p.is_file():
                return p
    sys.exit(f"missing part {name} (lod{lod}) in every dump")


# ---------------------------------------------------------------------------
# step 3 -- merge the parts onto the body's skeleton, group by texture
# ---------------------------------------------------------------------------

def load_texture(path: Path, max_px: int):
    """DDS -> (bytes, mime, uses_alpha). Pillow reads DXT1/3/5 natively."""
    im = Image.open(path)
    im.load()
    if max(im.size) > max_px:
        s = max_px / max(im.size)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    buf = io.BytesIO()
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        lo, _ = rgba.getchannel("A").getextrema()
        # Most colour maps are DXT5 with a solid-255 alpha; only an alpha that is USED
        # keeps PNG (export_map.py's rule, replay.md §4).
        if lo < 128:
            rgba.save(buf, "PNG", optimize=True)
            return buf.getvalue(), "image/png", True
    im.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), "image/jpeg", False


def build_model(mid: str, zone: str, kind: str, parts: list, lod: int):
    body = Gltf(part_path(zone, parts[0], lod))
    bskin = body.j["skins"][0]
    bjoints = bskin["joints"]                            # node indices, the model's joints
    bnames = [body.j["nodes"][j]["name"] for j in bjoints]
    bindex = {n: k for k, n in enumerate(bnames)}
    if len(bnames) > 255:
        sys.exit(f"{mid}: {len(bnames)} joints do not fit JOINTS_0 u8")

    groups = {}      # image path (or None) -> lists
    worst = 0.0
    for pi, pname in enumerate(parts):
        g = body if pi == 0 else Gltf(part_path(zone, pname, lod))
        skin = g.j["skins"][0]
        pj_names = [g.j["nodes"][j]["name"] for j in skin["joints"]]
        # Part joint -> body joint, by name; a bone the body lacks goes to its nearest
        # ancestor the body has (a hat's j_helmet -> ... -> j_head).
        remap, corr = [], []
        for k, j in enumerate(skin["joints"]):
            node = j
            while node is not None and g.j["nodes"][node].get("name") not in bindex:
                node = g.parent.get(node)
            name = g.j["nodes"][node]["name"] if node is not None else bnames[0]
            remap.append(bindex[name])
            # The part's vertices are in ITS bind pose; move them into the body's. For a
            # bone-merged part authored on the same rig this is the identity (measured below).
            pw = g.world[g.by_name[name]] if name in g.by_name else np.eye(4)
            bw = body.world[bjoints[bindex[name]]]
            c = bw @ np.linalg.inv(pw)
            # A part's vertices sit in its root bone's frame (a head's j_spine4 is at its
            # origin), so c is a real move, not the identity. What must hold is that it is
            # the SAME move for every bone of the part -- i.e. the part was authored on the
            # body's rig. `worst` is the largest disagreement, in inches/unit-matrix terms.
            if corr:
                worst = max(worst, float(np.abs(c - corr[0]).max()))
            corr.append(c)
        remap = np.array(remap)
        seen_pos = {}
        for ni, nd in enumerate(g.j["nodes"]):
            if "mesh" not in nd:
                continue
            for prim in g.j["meshes"][nd["mesh"]]["primitives"]:
                at = prim["attributes"]
                pos = g.acc(at["POSITION"]).astype(np.float64)
                nrm = g.acc(at["NORMAL"]).astype(np.float64) if "NORMAL" in at else np.zeros_like(pos)
                uv = g.acc(at["TEXCOORD_0"]).astype(np.float32) if "TEXCOORD_0" in at else np.zeros((len(pos), 2), np.float32)
                jn = g.acc(at["JOINTS_0"]).astype(np.int64)
                wt = g.acc(at["WEIGHTS_0"]).astype(np.float64)
                idx = g.acc(prim["indices"]).reshape(-1).astype(np.int64)
                used = np.unique(idx)
                lut = np.full(len(pos), -1, np.int64); lut[used] = np.arange(len(used))
                pos, nrm, uv, jn, wt = pos[used], nrm[used], uv[used], jn[used], wt[used]
                idx = lut[idx]
                dom = jn[np.arange(len(jn)), wt.argmax(axis=1)]
                for k in np.unique(dom):
                    c = corr[k]
                    sel = dom == k
                    pos[sel] = pos[sel] @ c[:3, :3].T + c[:3, 3]
                    nrm[sel] = nrm[sel] @ c[:3, :3].T
                jn = remap[jn]
                key = str(g.image_of(prim.get("material")) or f"flat:{pname}")
                gr = groups.setdefault(key, {"pos": [], "nrm": [], "uv": [], "jn": [], "wt": [], "idx": [], "n": 0})
                gr["idx"].append(idx + gr["n"])
                gr["n"] += len(pos)
                for a, v in (("pos", pos), ("nrm", nrm), ("uv", uv), ("jn", jn), ("wt", wt)):
                    gr[a].append(v)
    return body, bjoints, bnames, groups, worst


def pad4(b: bytes) -> bytes:
    return b + b"\0" * (-len(b) % 4)


def write_glb(path: Path, mid: str, kind: str, parts: list, body, bjoints, groups):
    j = {"asset": {"version": "2.0", "generator": "ENW Zombies tools/models/export_models.py",
                   "extras": {"id": mid, "kind": kind, "parts": parts,
                              "source": "Treyarch xmodel via OpenAssetTools (GPL-3.0); game asset, never commit"}},
         "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
         "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [], "meshes": [], "materials": [],
         "textures": [], "images": [], "samplers": [{"magFilter": 9729, "minFilter": 9987}],
         "accessors": [], "bufferViews": [], "buffers": [], "skins": []}
    blob = bytearray()

    def view(data: bytes, target=None, stride=None):
        while len(blob) % 4:
            blob.append(0)
        bv = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            bv["target"] = target
        if stride:
            bv["byteStride"] = stride
        blob.extend(data)
        j["bufferViews"].append(bv)
        return len(j["bufferViews"]) - 1

    def accessor(v, ctype, typ, count, normalized=False, mn=None, mx=None):
        a = {"bufferView": v, "componentType": ctype, "count": count, "type": typ}
        if normalized:
            a["normalized"] = True
        if mn is not None:
            a["min"], a["max"] = mn, mx
        j["accessors"].append(a)
        return len(j["accessors"]) - 1

    # Bones: the body's joints, in skin order, with their own TRS; parented as in the source.
    new_of = {old: k + 1 for k, old in enumerate(bjoints)}
    for old in bjoints:
        src = body.j["nodes"][old]
        nd = {"name": src["name"]}
        for key in ("translation", "rotation", "scale"):
            if key in src:
                nd[key] = src[key]
        kids = [new_of[c] for c in src.get("children", []) if c in new_of]
        if kids:
            nd["children"] = kids
        j["nodes"].append(nd)
    j["nodes"].insert(0, {"name": mid, "children": []})
    roots = [new_of[o] for o in bjoints if body.parent.get(o) not in new_of]
    mesh_node = len(j["nodes"])
    j["nodes"].append({"name": f"{mid}_mesh", "mesh": 0, "skin": 0})
    j["nodes"][0]["children"] = roots + [mesh_node]
    # Inverse bind = inverse of the bone's world matrix in the bind pose, the same matrices the
    # parts were corrected with, so bind pose renders exactly the source mesh.
    ibm = np.stack([np.linalg.inv(body.world[o]).T.reshape(-1) for o in bjoints]).astype(np.float32)
    j["skins"].append({"joints": [new_of[o] for o in bjoints], "skeleton": roots[0],
                       "inverseBindMatrices": accessor(view(ibm.tobytes()), 5126, "MAT4", len(bjoints))})

    total_tris = sum(sum(len(i) for i in g["idx"]) for g in groups.values()) // 3
    prims, texbytes, tris_out = [], 0, 0
    for key, g in groups.items():
        pos = np.concatenate(g["pos"]).astype(np.float32)
        nrm = np.concatenate(g["nrm"])
        ln = np.linalg.norm(nrm, axis=1, keepdims=True); ln[ln == 0] = 1
        nrm = nrm / ln
        uv = np.concatenate(g["uv"]).astype(np.float32)
        jn = np.concatenate(g["jn"]).astype(np.uint8)
        wt = np.concatenate(g["wt"])
        wt = wt / np.maximum(wt.sum(axis=1, keepdims=True), 1e-9)
        wq = np.round(wt * 255).astype(np.int64)
        fix = 255 - wq.sum(axis=1)
        wq[np.arange(len(wq)), wq.argmax(axis=1)] += fix
        wq = wq.astype(np.uint8)
        idx = np.concatenate(g["idx"])
        n = len(pos)
        tris = len(idx) // 3
        tris_out += tris
        # NORMAL as normalized int8 (KHR_mesh_quantization), padded to 4 bytes a vertex.
        n8 = np.zeros((n, 4), np.int8); n8[:, :3] = np.round(nrm * 127).astype(np.int8)
        at = {
            "POSITION": accessor(view(pos.tobytes(), 34962), 5126, "VEC3", n,
                                 mn=pos.min(axis=0).tolist(), mx=pos.max(axis=0).tolist()),
            "NORMAL": accessor(view(n8.tobytes(), 34962, 4), 5120, "VEC3", n, normalized=True),
            "TEXCOORD_0": accessor(view(uv.tobytes(), 34962), 5126, "VEC2", n),
            "JOINTS_0": accessor(view(jn.tobytes(), 34962), 5121, "VEC4", n),
            "WEIGHTS_0": accessor(view(wq.tobytes(), 34962), 5121, "VEC4", n, normalized=True),
        }
        if n < 65536:
            ib = idx.astype(np.uint16).tobytes(); ict = 5123
        else:
            ib = idx.astype(np.uint32).tobytes(); ict = 5125
        ia = accessor(view(ib, 34963), ict, "SCALAR", len(idx))
        mat = {"name": Path(key).stem if not key.startswith("flat:") else key,
               "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.85},
               "doubleSided": True}
        if not key.startswith("flat:") and Path(key).is_file():
            max_px = BODY_TEX if tris >= 0.35 * total_tris else PART_TEX
            data, mime, alpha = load_texture(Path(key), max_px)
            texbytes += len(data)
            j["images"].append({"bufferView": view(data), "mimeType": mime, "name": Path(key).stem})
            j["textures"].append({"sampler": 0, "source": len(j["images"]) - 1})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(j["textures"]) - 1}
            if alpha:
                mat["alphaMode"] = "MASK"
                mat["alphaCutoff"] = 0.5
        else:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [0.35, 0.33, 0.3, 1.0]
        j["materials"].append(mat)
        prims.append({"attributes": at, "indices": ia, "material": len(j["materials"]) - 1, "mode": 4})
    j["meshes"].append({"name": mid, "primitives": prims})
    allpos = np.concatenate([np.concatenate(g["pos"]) for g in groups.values()])
    j["asset"]["extras"]["height"] = round(float(allpos[:, 1].max()), 1)
    j["asset"]["extras"]["triangles"] = tris_out
    j["buffers"].append({"byteLength": len(blob)})

    js = pad4(json.dumps(j, separators=(",", ":")).encode("utf8")).replace(b"\0", b" ")
    js = js + b" " * (-len(js) % 4)
    bn = pad4(bytes(blob))
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bn))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(bn), 0x004E4942) + bn
    path.write_bytes(out)
    return {"bytes": len(out), "tex_bytes": texbytes, "triangles": tris_out, "draws": len(prims),
            "joints": len(bjoints), "height": j["asset"]["extras"]["height"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--unlink-only", action="store_true")
    ap.add_argument("--only", help="comma-separated model ids")
    a = ap.parse_args()
    for z in ZONES:
        unlink(z, a.force)
    for z in SCRIPT_ZONES:
        unlink(z, a.force, "rawfile")
    if a.unlink_only:
        return
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(a.only.split(",")) if a.only else None
    manifest_path = OUT / "models.json"
    old = {}
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf8")).get("models", {})
    models = {}
    over = []
    for mid, zone, kind, parts, lod in MODELS:
        if only and mid not in only:
            if mid in old:
                models[mid] = old[mid]
            continue
        body, bjoints, bnames, groups, worst = build_model(mid, zone, kind, parts, lod)
        info = write_glb(OUT / f"{mid}.glb", mid, kind, parts, body, bjoints, groups)
        info.update({"kind": kind, "zone": zone, "parts": parts, "lod": lod, "url": f"{mid}.glb",
                     "bind_correction_max": round(worst, 4)})
        models[mid] = info
        flag = "  OVER BUDGET" if info["bytes"] > BUDGET else ""
        if flag:
            over.append(mid)
        log(f"{mid:18s} {info['bytes'] / 1024:7.1f} KB (tex {info['tex_bytes'] / 1024:6.1f})"
            f" {info['triangles']:6d} tris {info['draws']} draws {info['joints']:3d} joints"
            f" h={info['height']} corr={worst:.4f}{flag}")
    manifest = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "frame": "glTF Y-up, engine +X forward, engine inches (scene.js toThree); no scale",
        "models": models,
        "maps": STOCK_SETS,
        "default": DEFAULT_SET,
        "customs": classify_customs(a.force),
    }
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf8")
    log(f"wrote {manifest_path} ({len(models)} models)")
    if over:
        sys.exit(f"over the {BUDGET // 1024} KB budget: {', '.join(over)}")


if __name__ == "__main__":
    main()
