#!/usr/bin/env python3
"""
Weapons, power-ups, effects and sounds for the 3D replay viewer (docs/kickstart/assets-pipeline.md).

    python tools/models/export_assets.py            # unlink (if stale) + build everything
    python tools/models/export_assets.py --force    # re-unlink and rebuild
    python tools/models/export_assets.py --list     # print what the manifest asks for and exit
    python tools/models/export_assets.py --only weapons,sounds

One command, from a game copy, deterministic. What it does:

  1. OpenAssetTools' Unlinker (GPL-3.0, run as an external program, never vendored) dumps the
     zones named in assets-manifest.yml into <ZOMBIES_DEV>/assetwork/dump/<zone>/, READ-ONLY
     over the game: xmodels as glTF, images as DDS, materials as JSON, weapon files, loaded
     sounds (.wav / .xwma), localized strings. Streamed sounds are read from the .iwd zips.
  2. Weapons: the world model (third person), the pack-a-punch world model when it is a
     different xmodel, and both viewmodels, each a static .glb (bind pose) with its tags
     (tag_flash, tag_brass, ...) as named nodes. A `*_gold` / `*_up` material whose colour
     map is the black placeholder is the pack-a-punch camo: its specular map (the gold) is
     used as the base colour, metallic. The weapon file is read back and cross-checked.
  3. Power-ups: the script models, same writer.
  4. Effects: one image per effect, PNG, with its blend mode from the material -> fx.json.
  5. Sounds: ffmpeg -> mono Vorbis .ogg, bit-exact (no random stream serials, no metadata).
  6. <ZOMBIES_DEV>/maps/_assets.json: the one manifest the viewer reads. No timestamps in
     any output, so an unchanged game gives byte-identical files; the time is in the log.

Output (served by the existing /mapdata static mount; nothing is committed, nothing is
uploaded):  maps/_weapons/<name>[_pap][_view].glb, maps/_powerups/<kind>.glb,
maps/_fx/<name>.png + fx.json, maps/_sounds/<key>.ogg, maps/_assets.json.

Frame: Unlinker's glTF is Y-up with the engine's +X forward, in engine inches -- the same as
the player models (export_models.py) and scene.js toThree. Nothing is rescaled.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs numpy and Pillow: python -m pip install numpy pillow")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import export_models  # noqa: E402  (the skinned writer, for the first-person arms)
from export_models import Gltf, q2m  # noqa: E402  (the glTF reader the player models use)
from xanim import read_xanim, pose as xanim_pose  # noqa: E402  (compiled xanim v17 reader)

DEV = Path(os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev"))


def default_game() -> Path:
    # dev-box.md: the working copy of the game is ZombiesDev\waw-base; an end user points
    # ZM_WAW at their own install. The Steam install is only read, never written.
    for p in (os.environ.get("ZM_WAW"), str(DEV / "waw-base"),
              r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"):
        if p and (Path(p) / "zone" / "english").is_dir():
            return Path(p)
    sys.exit("no game copy: set ZM_WAW to a Call of Duty: World at War install")


WAW = default_game()
OAT = Path(os.environ.get("ZM_OAT", str(DEV / "tools" / "oat" / "Unlinker.exe")))
FFMPEG = os.environ.get("ZM_FFMPEG", "ffmpeg")
WORK = Path(os.environ.get("ZM_ASSETS_WORK", str(DEV / "assetwork")))
OUT = Path(os.environ.get("ZM_ASSETS_OUT", str(DEV / "maps")))
MANIFEST = HERE / "assets-manifest.yml"

WORLD_TEX = 256          # px, long edge: a gun in a player's hand is a few pixels on screen
VIEW_TEX = 512           # px: the first-person gun fills a corner of the screen
POWERUP_TEX = 256
JPEG_QUALITY = 82
GLB_BUDGET = 450 * 1024  # bytes per world/power-up .glb; the build fails over it
VIEW_BUDGET = 700 * 1024 # bytes per viewmodel .glb (the tesla gun's is 13.8 k triangles)
ALPHA_TEX = 256          # px cap for a colour map whose alpha is used (it stays PNG)
PACK_BUDGET = 20 * 1024 * 1024   # 15 until 2026-09-23 (RV): every stock gun + PaP + the arms is ~16
DEFAULT_GRIP_POINT = [-10.5, -2.0, 0]   # a gun the manifest gives no measured grip (§3: origin ~10 u ahead)
OGG_QUALITY = "3"        # libvorbis -q:a (~80-110 kbit/s stereo, ~50 mono); a sound may override

LOG_LINES: list = []
WRITTEN: dict = {}       # output dir name -> file names written this run


def wrote(path: Path):
    WRITTEN.setdefault(path.parent.name, set()).add(path.name)


def log(*a):
    s = " ".join(str(x) for x in a)
    LOG_LINES.append(s)
    print("[export-assets]", s, flush=True)


# ---------------------------------------------------------------------------
# the manifest: a small YAML subset, so that an end user's PC needs no YAML library
# ---------------------------------------------------------------------------

def _strip_comment(line: str) -> str:
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == q:
                q = None
        elif ch in "\"'":
            q = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i].rstrip()
    return line.rstrip()


def _split_top(s: str) -> list:
    out, depth, q, cur = [], 0, None, ""
    for ch in s:
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in "\"'":
            q = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
            continue
        cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def _scalar(v: str):
    v = v.strip()
    if v.startswith("{") and v.endswith("}"):
        d = {}
        for part in _split_top(v[1:-1]):
            k, _, val = part.partition(":")
            d[k.strip()] = _scalar(val)
        return d
    if v.startswith("[") and v.endswith("]"):
        return [_scalar(x) for x in _split_top(v[1:-1])]
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"-?\d+\.\d*", v):
        return float(v)
    if v in ("true", "false"):
        return v == "true"
    if v in ("null", "~"):
        return None
    return v


def parse_yaml_subset(text: str):
    rows = []
    for raw in text.splitlines():
        s = _strip_comment(raw)
        if s.strip():
            rows.append((len(s) - len(s.lstrip(" ")), s.strip()))

    def block(i, indent):
        if rows[i][1].startswith("- "):
            out = []
            while i < len(rows) and rows[i][0] == indent and rows[i][1].startswith("- "):
                out.append(_scalar(rows[i][1][2:]))
                i += 1
            return out, i
        out = {}
        while i < len(rows) and rows[i][0] == indent:
            key, _, val = rows[i][1].partition(":")
            i += 1
            if val.strip():
                out[key.strip()] = _scalar(val)
            elif i < len(rows) and rows[i][0] > indent:
                out[key.strip()], i = block(i, rows[i][0])
            else:
                out[key.strip()] = None
        return out, i

    return block(0, rows[0][0])[0] if rows else {}


def load_manifest() -> dict:
    text = MANIFEST.read_text(encoding="utf8")
    try:
        import yaml  # optional
        return yaml.safe_load(text)
    except ImportError:
        return parse_yaml_subset(text)


# ---------------------------------------------------------------------------
# step 1 -- unlink
# ---------------------------------------------------------------------------

def unlink(zone: str, assets: str, force: bool) -> Path:
    ff = WAW / "zone" / "english" / f"{zone}.ff"
    if not ff.is_file():
        sys.exit(f"no fastfile {ff}")
    if not OAT.is_file():
        sys.exit(f"OpenAssetTools is not installed at {OAT} (replay.md §4: oat-windows.zip v0.33.0)")
    out = WORK / "dump" / zone
    stamp = out / ".unlinked"
    want = f"{assets}|{ff.stat().st_size}|{int(ff.stat().st_mtime)}"
    if stamp.is_file() and not force and stamp.read_text() == want:
        return out
    out.mkdir(parents=True, exist_ok=True)
    cmd = [str(OAT), "--model-format", "GLTF", "--image-format", "DDS",
           "--include-assets", assets,
           "--search-path", f"{WAW / 'main'};{WAW / 'zone' / 'english'}",
           "-o", str(WORK / "dump" / "?zone?"), str(ff)]
    log("unlinking:", " ".join(cmd))
    t = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Unlinker failed ({r.returncode}):\n{(r.stdout or '')[-2000:]}\n{r.stderr[-2000:]}")
    errs = [l for l in (r.stdout or "").splitlines() if l.startswith("ERROR")]
    log(f"unlinked {zone} ({assets}) in {time.time() - t:.1f}s" + (f"; OAT errors: {errs}" if errs else ""))
    stamp.write_text(want)
    return out


def dump(zone: str) -> Path:
    return WORK / "dump" / zone


def zone_list(zone: str) -> list:
    """`Unlinker --list` of a zone (every asset, in zone order), cached next to the dump. The
    order is what ties a sound alias to its loaded sound (assets-pipeline.md §4)."""
    ff = WAW / "zone" / "english" / f"{zone}.ff"
    out = WORK / "lists" / f"{zone}.txt"
    stamp = out.with_suffix(".stamp")
    want = f"{ff.stat().st_size}|{int(ff.stat().st_mtime)}"
    if not (out.is_file() and stamp.is_file() and stamp.read_text() == want):
        out.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([str(OAT), "--list", "--search-path", f"{WAW / 'main'};{WAW / 'zone' / 'english'}", str(ff)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"Unlinker --list {zone} failed ({r.returncode}): {r.stderr[-800:]}")
        out.write_text(r.stdout, encoding="utf8")
        stamp.write_text(want)
    return [l.strip() for l in out.read_text(encoding="utf8").splitlines()]


def loaded_sound_path(file: str):
    """The dumped loaded sound for a zone-list file name, in any zone dumped with loadedsound."""
    for z in sorted(p.name for p in (WORK / "dump").iterdir() if p.is_dir()):
        base = dump(z) / "sound" / file
        for p in (base, base.with_suffix(".xwma"), base.with_suffix(".wav")):
            if p.is_file():
                return z, p
    return None, None


def resolve_alias(alias: str, zones: list):
    """Sound alias -> (zone, file) by zone order: the loadedsound lines right before
    `sound, <alias>`. An alias with none right before it reuses a file loaded earlier in the zone,
    which the list cannot name -- then None, and the caller uses a stand-in (logged)."""
    if not alias:
        return None
    key = f"sound, {alias.lower()}"
    for zone in zones:
        lines = zone_list(zone)
        low = [l.lower() for l in lines]
        for i, l in enumerate(low):
            if l != key:
                continue
            files, j = [], i - 1
            while j >= 0 and low[j].startswith("loadedsound, "):
                files.insert(0, lines[j][len("loadedsound, "):])
                j -= 1
            for f in files:
                z, p = loaded_sound_path(f)
                if p is not None:
                    return z, f
    return None


# The first-person arms and the weapon's own viewmodel animation (replay.md §14). Stock zombies
# dresses every player's view in viewmodel_usa_marine_arms (_loadout.gsc, every nazi_zombie_*
# branch); the gun's viewmodel hangs on the arms' tag_weapon by its root bone j_gun, and the
# weapon file's idleAnim / adsUpAnim pose both. Bone values are LOCAL, engine frame.
FP_KEEP = ("j_gun",)


def fp_pose_of(zone: str, anim: str, frame: str, arms_bones: set):
    if not anim:
        return None
    # The weapon's own zone first, then every other dump (the Colt's anims live in `common`,
    # the zone every map loads for the starting pistol).
    p = None
    for z in [zone] + sorted(x.name for x in (WORK / "dump").iterdir() if x.is_dir() and x.name != zone):
        d = dump(z) / "xanim"
        if not d.is_dir():
            continue
        cand = [x for x in sorted(d.iterdir()) if x.name.lower() == anim.lower()]
        if cand:
            p = cand[0]
            break
    if p is None:
        return None
    a = read_xanim(p)

    def bones_at(fr):
        ps = xanim_pose(a, fr)
        out = {}
        for bone in sorted(ps):
            if bone not in arms_bones and bone not in FP_KEEP:
                continue
            v = ps[bone]
            if v["q"] is None and v["t"] is None:
                continue
            out[bone] = [None if v["q"] is None else [round(x, 5) + 0.0 for x in v["q"]],
                         None if v["t"] is None else [round(x, 4) + 0.0 for x in v["t"]]]
        return out
    if frame == "all":
        # The ADS anim is SCRUBBED by the aim fraction in the engine: frame 0 is the hip pose
        # (it is also adsDownAnim's last frame), the last frame the sights. Every frame is kept.
        return {"anim": p.name, "frames": a["frames"], "seq": [bones_at(f) for f in range(a["frames"] + 1)]}
    return {"anim": p.name, "frames": a["frames"], "bones": bones_at(0 if frame == "first" else a["frames"])}


def fp_info(zone: str, wf: dict, arms_bones: set, poses: dict) -> dict:
    """Per weapon variant: which poses to use (keys into fp_poses.json), the stand offsets and the
    ADS numbers from the weapon file."""
    f = lambda k, d=0.0: float(wf.get(k) or d)  # noqa: E731
    info = {"standMove": [f("standMoveF"), f("standMoveR"), f("standMoveU")],
            "adsZoomFov": f("adsZoomFov", 0) or None,
            "adsInMs": int(round(f("adsTransInTime") * 1000)), "adsOutMs": int(round(f("adsTransOutTime") * 1000)),
            "idle": None, "ads": None}
    for slot, anim, frame in (("idle", wf.get("idleAnim"), "first"), ("ads", wf.get("adsUpAnim"), "all")):
        if not anim:
            continue
        key = f"{anim.lower()}@{frame}"
        if key not in poses:
            pz = fp_pose_of(zone, anim, frame, arms_bones)
            if pz is None:
                log(f"  note: anim {anim} not in the {zone} dump")
                continue
            poses[key] = pz
        info[slot] = key
    return info


def build_viewhands(name: str, spec: dict, out_path: Path) -> dict:
    """The arms, skinned (the player models' writer), bind pose; the viewer poses the bones."""
    export_models.WORK = WORK          # read the arms from THIS pipeline's dump
    out_path.parent.mkdir(parents=True, exist_ok=True)
    body, bjoints, bnames, groups, _ = export_models.build_model(name, spec["zone"], "viewhands", [spec["xmodel"]], 0)
    r = export_models.write_glb(out_path, name, "viewhands", [spec["xmodel"]], body, bjoints, groups)
    wrote(out_path)
    return dict(r, xmodel=spec["xmodel"], bones=sorted(bnames), root=bnames[0])


# ---------------------------------------------------------------------------
# game data readers: weapon files, localized strings, materials
# ---------------------------------------------------------------------------

def read_weapon(zone: str, name: str) -> dict:
    p = dump(zone) / "weapons" / name
    if not p.is_file():
        sys.exit(f"weapon file {name} not in the {zone} dump")
    parts = p.read_text(encoding="latin-1").split("\\")
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}


_STRINGS: dict = {}


def strings() -> dict:
    if not _STRINGS:
        for f in sorted((WORK / "dump").glob("*/english/localizedstrings/*.str")):
            ref = None
            for line in f.read_text(encoding="latin-1").splitlines():
                m = re.match(r"\s*REFERENCE\s+(\S+)", line)
                if m:
                    ref = m.group(1)
                    continue
                m = re.match(r'\s*LANG_ENGLISH\s+"(.*)"', line)
                if m and ref:
                    _STRINGS.setdefault(ref, m.group(1).replace("\\n", "").strip())
                    ref = None
    return _STRINGS


def material_json(zone: str, name: str):
    for z in (zone, "nazi_zombie_factory", "common"):
        p = dump(z) / "materials" / f"{name}.json"
        if p.is_file():
            return json.loads(p.read_text(encoding="utf8")), z
    return None, None


def image_path(zone: str, image: str):
    for z in (zone, "nazi_zombie_factory", "common", "common_mp"):
        p = dump(z) / "images" / f"{image}.dds"
        if p.is_file():
            return p
    return None


def tex_of(mat: dict, kind: str):
    for t in mat.get("textures", []):
        if t.get("name") == kind:
            return t.get("image")
    return None


def blend_of(mat: dict) -> str:
    sb = (mat.get("stateBits") or [{}])[0]
    src, dst = sb.get("srcBlendRgb"), sb.get("dstBlendRgb")
    if (src, dst) == ("one", "one"):
        return "add"
    if (src, dst) == ("srcalpha", "invsrcalpha"):
        return "alpha"
    if src is None or sb.get("blendOpRgb") == "disabled":
        return "opaque"
    return f"{src}/{dst}"


# ---------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------

def open_dds(path: Path):
    im = Image.open(path)
    im.load()
    return im


def fit(im, max_px: int):
    if max(im.size) > max_px:
        s = max_px / max(im.size)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    return im


def encode_colour(im, max_px: int):
    """-> (bytes, mime, alpha_used). JPEG unless the alpha is used (export_models.py's rule);
    an alpha-used map stays PNG and is capped at ALPHA_TEX, PNG being 5-10x a JPEG."""
    buf = io.BytesIO()
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        lo, _ = rgba.getchannel("A").getextrema()
        if lo < 128:
            fit(rgba, min(max_px, ALPHA_TEX)).save(buf, "PNG", optimize=True)
            return buf.getvalue(), "image/png", True
    fit(im, max_px).convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue(), "image/jpeg", False


# ---------------------------------------------------------------------------
# static .glb writer (weapons, power-ups)
# ---------------------------------------------------------------------------

def mat_to_quat(m):
    """3x3 rotation -> glTF quaternion [x, y, z, w]."""
    m = np.asarray(m, dtype=float)
    u, _, vt = np.linalg.svd(m)
    m = u @ vt
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    q = q / np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    return [round(float(x), 6) + 0.0 for x in q]


def r6(v):
    return [round(float(x), 4) + 0.0 for x in v]


def glb_node_worlds(path: Path):
    """(names -> index, world matrices) of a .glb's nodes, from their TRS."""
    b = path.read_bytes()
    j = json.loads(b[20:20 + struct.unpack("<I", b[12:16])[0]])
    nodes, parent = j["nodes"], {}
    for i, nd in enumerate(nodes):
        for c in nd.get("children", []):
            parent[c] = i
    world = {}

    def w(i):
        if i not in world:
            nd, m = nodes[i], np.eye(4)
            if "rotation" in nd:
                m[:3, :3] = q2m(nd["rotation"])
            if "translation" in nd:
                m[:3, 3] = nd["translation"]
            world[i] = (w(parent[i]) @ m) if i in parent else m
        return world[i]
    return {nd.get("name"): i for i, nd in enumerate(nodes)}, [w(i) for i in range(len(nodes))]


def compute_grip(attach: dict):
    """The engine's rule is tag_weapon -> tag_weapon_right, but tag_weapon_right is ANIMATED by
    the game's xanims: in the bind pose (all the viewer has, replay.md §9.6) it sits 11.4 u off
    the wrist, beside the hip. For a procedural pose the viewer needs a fixed grip in the hand:
    tag_weapon at the palm (mean of j_wrist_ri, j_index_ri_1, j_mid_ri_1, 1 u down), the gun
    level and pointing the character's way (+X) in the bind pose, expressed in j_wrist_ri's
    frame so it follows the arm. Every T4 humanoid .glb here has the same rig (checked)."""
    models = DEV / "maps" / "_models"
    out = []
    for f in sorted(models.glob("*.glb")):
        names, W = glb_node_worlds(f)
        if not all(k in names for k in ("j_wrist_ri", "j_index_ri_1", "j_mid_ri_1", attach["playerBone"])):
            continue
        wr = W[names["j_wrist_ri"]]
        palm = np.mean([W[names[k]][:3, 3] for k in ("j_wrist_ri", "j_index_ri_1", "j_mid_ri_1")], axis=0)
        palm[1] -= 1.0
        g = np.eye(4); g[:3, 3] = palm
        loc = np.linalg.inv(wr) @ g
        out.append((f.stem, loc, W[names[attach["playerBone"]]][:3, 3], wr[:3, 3]))
    if not out:
        return None
    ref = out[0][1]
    spread = max(float(np.abs(o[1] - ref).max()) for o in out)
    return {"bone": "j_wrist_ri", "palm": ref, "position": r6(ref[:3, 3]), "quaternion": mat_to_quat(ref[:3, :3]),
            "from": [o[0] for o in out], "maxDisagreement": round(spread, 4),
            "bindTagWeaponRight": r6(out[0][2]), "bindWrist": r6(out[0][3]),
            "why": "tag_weapon_right is animated in-game; in the bind pose it is 11.4 u from the wrist. "
                   "position/quaternion here are the PALM frame in j_wrist_ri (gun level, +X forward in the "
                   "bind pose); each weapon's attach.gripLocal = palm x translate(-grip) is what to parent "
                   "the weapon .glb with. Use playerBone + localQuaternion once real xanims drive the skeleton."}


def grip_local(grip, point):
    """The weapon root's transform in j_wrist_ri that puts the weapon's grip point in the palm."""
    if not grip or point is None:
        return None
    t = np.eye(4)
    t[:3, 3] = [-float(x) for x in point]
    m = grip["palm"] @ t
    return {"bone": grip["bone"], "position": r6(m[:3, 3]), "quaternion": mat_to_quat(m[:3, :3]),
            "gripPoint": r6(point), "gripPointSource": "by eye, assets-manifest.yml"}


def model_path(zone: str, xmodel: str) -> Path:
    for z in (zone, "nazi_zombie_factory"):
        p = dump(z) / "model_export" / f"{xmodel}_lod0.gltf"
        if p.is_file():
            return p
    sys.exit(f"xmodel {xmodel} is not in the {zone} dump")


def build_static(xmodel: str, zone: str, out_path: Path, name: str, kind: str, max_px: int) -> dict:
    g = Gltf(model_path(zone, xmodel))
    groups = {}        # material key -> geometry lists
    mats = {}          # material key -> description
    for nd in g.j["nodes"]:
        if "mesh" not in nd:
            continue
        for prim in g.j["meshes"][nd["mesh"]]["primitives"]:
            at = prim["attributes"]
            pos = g.acc(at["POSITION"]).astype(np.float32)
            nrm = g.acc(at["NORMAL"]).astype(np.float32) if "NORMAL" in at else np.zeros_like(pos)
            uv = g.acc(at["TEXCOORD_0"]).astype(np.float32) if "TEXCOORD_0" in at else np.zeros((len(pos), 2), np.float32)
            idx = g.acc(prim["indices"]).reshape(-1).astype(np.int64)
            # Unlinker's primitives index into one shared vertex array: keep only the used ones.
            used = np.unique(idx)
            lut = np.full(len(pos), -1, np.int64); lut[used] = np.arange(len(used))
            pos, nrm, uv, idx = pos[used], nrm[used], uv[used], lut[idx]
            mname = g.j["materials"][prim["material"]]["name"] if prim.get("material") is not None else "none"
            mj, _ = material_json(zone, mname)
            colour = tex_of(mj, "colorMap") if mj else None
            spec = tex_of(mj, "specularMap") if mj else None
            # Pack-a-punch camo: the colour map is the black placeholder and the gold lives in
            # the specular map (mtl_weapon_*_gold, mtl_weapon_colt45_zombie_up).
            gold = bool(colour == "blackness_c" and spec)
            key = f"gold:{spec}" if gold else f"tex:{colour}"
            if key not in mats:
                mats[key] = {"material": mname, "colour": colour, "spec": spec, "gold": gold}
            gr = groups.setdefault(key, {"pos": [], "nrm": [], "uv": [], "idx": [], "n": 0})
            gr["idx"].append(idx + gr["n"])
            gr["n"] += len(pos)
            gr["pos"].append(pos); gr["nrm"].append(nrm); gr["uv"].append(uv)

    j = {"asset": {"version": "2.0", "generator": "ENW Zombies tools/models/export_assets.py",
                   "extras": {"id": name, "kind": kind, "xmodel": xmodel, "zone": zone,
                              "source": "Treyarch xmodel via OpenAssetTools (GPL-3.0); game asset, never commit"}},
         "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
         "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": name, "children": []}],
         "meshes": [], "materials": [], "textures": [], "images": [],
         "samplers": [{"magFilter": 9729, "minFilter": 9987}],
         "accessors": [], "bufferViews": [], "buffers": []}
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

    def accessor(v, ctype, typ, count, mn=None, mx=None, normalized=False):
        a = {"bufferView": v, "componentType": ctype, "count": count, "type": typ}
        if normalized:
            a["normalized"] = True
        if mn is not None:
            a["min"], a["max"] = mn, mx
        j["accessors"].append(a)
        return len(j["accessors"]) - 1

    prims, texbytes, tris, notes = [], 0, 0, []
    for key in sorted(groups):
        gr, md = groups[key], mats[key]
        pos = np.concatenate(gr["pos"])
        nrm = np.concatenate(gr["nrm"])
        ln = np.linalg.norm(nrm, axis=1, keepdims=True); ln[ln == 0] = 1
        # NORMAL as normalized int8, padded to 4 bytes a vertex (KHR_mesh_quantization, as the
        # player models): a quarter of the vertex data.
        n8 = np.zeros((len(nrm), 4), np.int8); n8[:, :3] = np.round(nrm / ln * 127).astype(np.int8)
        uv = np.concatenate(gr["uv"])
        idx = np.concatenate(gr["idx"])
        tris += len(idx) // 3
        at = {"POSITION": accessor(view(pos.tobytes(), 34962), 5126, "VEC3", len(pos),
                                   r6(pos.min(axis=0)), r6(pos.max(axis=0))),
              "NORMAL": accessor(view(n8.tobytes(), 34962, 4), 5120, "VEC3", len(pos), normalized=True),
              "TEXCOORD_0": accessor(view(uv.tobytes(), 34962), 5126, "VEC2", len(pos))}
        if len(pos) < 65536:
            ib, ict = idx.astype(np.uint16).tobytes(), 5123
        else:
            ib, ict = idx.astype(np.uint32).tobytes(), 5125
        ia = accessor(view(ib, 34963), ict, "SCALAR", len(idx))
        mat = {"name": md["material"], "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.7},
               "doubleSided": True}
        src_img = md["spec"] if md["gold"] else md["colour"]
        ip = image_path(zone, src_img) if src_img else None
        if ip is not None:
            try:
                im = open_dds(ip)
                if md["gold"]:
                    im = im.convert("RGB")   # the gold tint is the spec map's RGB
                data, mime, alpha = encode_colour(im, max_px)
            except Exception as e:  # noqa: BLE001 -- an undecodable image is a flat colour, logged
                data, alpha = None, False
                notes.append(f"{src_img}: {e}")
            if data:
                texbytes += len(data)
                j["images"].append({"bufferView": view(data), "mimeType": mime, "name": src_img})
                j["textures"].append({"sampler": 0, "source": len(j["images"]) - 1})
                mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(j["textures"]) - 1}
                if alpha:
                    mat["alphaMode"] = "MASK"
                    mat["alphaCutoff"] = 0.5
        else:
            notes.append(f"{md['material']}: no colour image ({src_img})")
        if "baseColorTexture" not in mat["pbrMetallicRoughness"]:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = [0.35, 0.33, 0.3, 1.0]
        if md["gold"]:
            # Half metallic, not 1.0: a fully metallic surface with no environment map (the
            # replay viewer has none) renders near-black in three.js.
            mat["pbrMetallicRoughness"]["metallicFactor"] = 0.5
            mat["pbrMetallicRoughness"]["roughnessFactor"] = 0.4
            mat["extras"] = {"packAPunchCamo": True}
        j["materials"].append(mat)
        prims.append({"attributes": at, "indices": ia, "material": len(j["materials"]) - 1, "mode": 4})
    j["meshes"].append({"name": name, "primitives": prims})
    j["nodes"].append({"name": f"{name}_mesh", "mesh": 0})
    j["nodes"][0]["children"].append(len(j["nodes"]) - 1)

    # Tags: every tag_* bone, placed by its bind-pose world matrix (same frame as the mesh).
    tags = {}
    for i, nd in enumerate(g.j["nodes"]):
        nm = nd.get("name") or ""
        if not nm.startswith("tag_") or nm in tags:
            continue
        w = g.world[i]
        tags[nm] = {"position": r6(w[:3, 3]), "quaternion": mat_to_quat(w[:3, :3])}
    for nm in sorted(tags):
        j["nodes"].append({"name": nm, "translation": tags[nm]["position"], "rotation": tags[nm]["quaternion"]})
        j["nodes"][0]["children"].append(len(j["nodes"]) - 1)
    allpos = np.concatenate([np.concatenate(g_["pos"]) for g_ in groups.values()])
    bbox = [r6(allpos.min(axis=0)), r6(allpos.max(axis=0))]
    j["asset"]["extras"].update({"tags": tags, "bbox": bbox, "triangles": tris})
    j["buffers"].append({"byteLength": len(blob)})

    js = json.dumps(j, separators=(",", ":"), sort_keys=False).encode("utf8")
    js += b" " * (-len(js) % 4)
    bn = bytes(blob) + b"\0" * (-len(blob) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bn))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(bn), 0x004E4942) + bn
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(out)
    wrote(out_path)
    gold = any(m["gold"] for m in mats.values())
    for n in notes:
        log(f"  note {name}: {n}")
    return {"bytes": len(out), "tex_bytes": texbytes, "triangles": tris, "draws": len(prims),
            "tags": tags, "bbox": bbox, "papCamo": gold, "xmodel": xmodel,
            "materials": sorted({m["material"] for m in mats.values()})}


# ---------------------------------------------------------------------------
# sounds
# ---------------------------------------------------------------------------

def sound_source(key: str, s: dict) -> Path:
    src_dir = WORK / "src_sounds"
    if "iwd" in s:
        iwd = WAW / "main" / s["iwd"]
        dst = src_dir / key / Path(s["file"]).name
        if not dst.is_file() or dst.stat().st_mtime < iwd.stat().st_mtime:
            with zipfile.ZipFile(iwd) as z:
                names = {n.lower(): n for n in z.namelist()}
                n = names.get(s["file"].lower())
                if n is None:
                    sys.exit(f"sound {key}: {s['file']} not in {iwd.name}")
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(z.read(n))
        return dst
    base = dump(s["zone"]) / "sound" / s["file"]
    for p in (base, base.with_suffix(".xwma"), base.with_suffix(".wav")):
        if p.is_file():
            return p
    sys.exit(f"sound {key}: {s['file']} not in the {s['zone']} dump (unlinked with loadedsound?)")


def probe_ms(path: Path) -> int:
    ffprobe = str(Path(shutil.which(FFMPEG) or FFMPEG).with_name("ffprobe"))
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return int(round(float(r.stdout.strip()) * 1000))
    except ValueError:
        return 0


def build_sound(key: str, s: dict, out_dir: Path) -> dict:
    src = sound_source(key, s)
    out = out_dir / f"{key}.ogg"
    cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-map", "0:a:0", "-map_metadata", "-1", "-vn",
           "-ac", "2" if s.get("stereo") else "1", "-c:a", "libvorbis", "-q:a", str(s.get("quality", OGG_QUALITY)),
           "-fflags", "+bitexact", "-flags:a", "+bitexact", "-serial_offset", "1", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not out.is_file():
        sys.exit(f"ffmpeg failed for {key}: {r.stderr[-1500:]}")
    wrote(out)
    return {"url": f"_sounds/{key}.ogg", "bytes": out.stat().st_size, "durationMs": probe_ms(out),
            "channels": 2 if s.get("stereo") else 1,
            "source": (f"{s['iwd']}:{s['file']}" if "iwd" in s else f"{s['zone']}.ff:{s['file']}"),
            "sourceFormat": src.suffix.lstrip("."), "alias": s.get("alias")}


# ---------------------------------------------------------------------------
# fx
# ---------------------------------------------------------------------------

def build_fx(name: str, f: dict, out_dir: Path) -> dict:
    zone = f["zone"]
    blend, mname = "alpha", f.get("material")
    if mname:
        mj, _ = material_json(zone, mname)
        if not mj:
            sys.exit(f"fx {name}: material {mname} not in the {zone} dump")
        img = tex_of(mj, "colorMap")
        blend = blend_of(mj)
    else:
        img, blend = f["image"], "texture"   # a bare image (the camo swatch), no material to read
    ip = image_path(zone, img)
    if ip is None:
        sys.exit(f"fx {name}: image {img} not in the dumps")
    im = fit(open_dds(ip).convert("RGBA"), int(f.get("max", 256)))
    out = out_dir / f"{name}.png"
    im.save(out, "PNG", optimize=True)
    wrote(out)
    d = {"url": f"_fx/{name}.png", "file": f"{name}.png", "w": im.width, "h": im.height,
         "blend": blend, "bytes": out.stat().st_size, "image": img, "zone": zone, "use": f.get("use")}
    if mname:
        d["material"] = mname
    if f.get("tint"):
        d["tint"] = f["tint"]
    return d


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def check(cond, msg, problems):
    if not cond:
        problems.append(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-unlink every zone")
    ap.add_argument("--list", action="store_true", help="print the manifest's assets and exit")
    ap.add_argument("--only", help="comma-separated: weapons,powerups,fx,sounds (manifest still rewritten)")
    ap.add_argument("--unlink-only", action="store_true")
    a = ap.parse_args()
    m = load_manifest()
    t0 = time.time()

    if a.list:
        for sect in ("weapons", "powerups", "fx", "sounds"):
            for k, v in (m.get(sect) or {}).items():
                print(f"{sect:9s} {k:20s} {json.dumps(v)[:150]}")
        return

    log(f"start {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}  game={WAW}  out={OUT}")
    for zone, assets in m["zones"].items():
        unlink(zone, assets, a.force)
    if a.unlink_only:
        return

    only = set(a.only.split(",")) if a.only else None
    grip = compute_grip(m["attach"])
    if grip is None:
        log("note: no player models in maps/_models (export_models.py): no hand grip computed")
    old = {}
    manifest_path = OUT / "_assets.json"
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf8"))
    problems = []

    # --- weapons the manifest lists by weapon file only: world/view models, flash and fire
    # sounds come from the weapon file, the sounds' files from zone order (resolve_alias). A
    # sound the zone lists cannot name gets a same-class stand-in, said so in the log and in
    # _assets.json (`soundStandIn`).
    sound_zones = [z for z, t in m["zones"].items() if "loadedsound" in t]
    stand_in = m.get("sound_stand_ins") or {}
    for wname, w in m["weapons"].items():
        for variant, spec in (("base", w), ("pap", w.get("pap"))):
            if not spec:
                continue
            wf = read_weapon(w["zone"], spec["weapon"])
            spec.setdefault("world", wf.get("worldModel"))
            spec.setdefault("view", wf.get("gunModel"))
            spec.setdefault("flash", wf.get("worldFlashEffect") or "")
            spec.setdefault("muzzle", w.get("muzzle") or "muzzle_rifle")
            for key, field in (("fire", "fireSound"), ("fire_plr", "fireSoundPlayer")):
                if spec.get(key):
                    continue
                alias = wf.get(field) or ""
                if variant == "pap" and "ubershot" in alias.lower():
                    spec[key] = "uber_fire_plr" if key == "fire_plr" else "uber_fire"
                    continue
                skey = f"{wname}{'_pap' if variant == 'pap' else ''}_{key}"
                hit = resolve_alias(alias, [w["zone"]] + [z for z in sound_zones if z != w["zone"]])
                if hit:
                    m["sounds"][skey] = {"zone": hit[0], "file": hit[1], "alias": alias}
                    spec[key] = skey
                else:
                    si = (stand_in.get(w.get("cls") or "") or stand_in.get("default") or {}).get(key)
                    spec[key] = si
                    spec.setdefault("soundStandIn", {})[key] = si
                    log(f"  note {wname}/{variant}: {field} {alias!r} has no loaded sound in zone order; stand-in {si}")

    # --- sounds first: the weapons and power-ups point at them
    sounds = old.get("sounds", {}) if only and "sounds" not in only else {}
    if not only or "sounds" in only:
        sd = OUT / "_sounds"
        sd.mkdir(parents=True, exist_ok=True)
        for key in sorted(m["sounds"]):
            sounds[key] = build_sound(key, m["sounds"][key], sd)
            s = sounds[key]
            log(f"sound  {key:20s} {s['bytes'] / 1024:6.1f} KB {s['durationMs']:6d} ms  {s['source']}")

    def snd(key):
        if not key:
            return None
        if key not in m["sounds"]:
            problems.append(f"sound key {key} is not in the manifest")
            return None
        return f"_sounds/{key}.ogg"

    # --- fx
    fx = old.get("fx", {}) if only and "fx" not in only else {}
    if not only or "fx" in only:
        fd = OUT / "_fx"
        fd.mkdir(parents=True, exist_ok=True)
        for name in sorted(m["fx"]):
            fx[name] = build_fx(name, m["fx"][name], fd)
            f = fx[name]
            log(f"fx     {name:20s} {f['w']:4d}x{f['h']:<4d} {f['blend']:6s} {f['bytes'] / 1024:6.1f} KB  {f['image']}")
        (fd / "fx.json").write_text(json.dumps({"fx": fx}, indent=1, sort_keys=True), encoding="utf8")

    # --- weapons
    weapons = old.get("weapons", {}) if only and "weapons" not in only else {}
    viewhands = old.get("viewhands", {}) if only and "weapons" not in only else {}
    fp_poses = {}
    if not only or "weapons" in only:
        wd = OUT / "_weapons"
        names = strings()
        arms_bones = set()
        for hname, h in (m.get("viewhands") or {}).items():
            r = build_viewhands(f"viewhands_{hname}", h, wd / f"viewhands_{hname}.glb")
            viewhands[hname] = {"glb": f"_weapons/viewhands_{hname}.glb", "model": r, "maps": h.get("maps", "all")}
            arms_bones |= set(r["bones"])
            log(f"hands  viewhands_{hname:13s} {r['bytes'] / 1024:6.1f} KB {r['triangles']:5d} tris {r['joints']} joints  {h['xmodel']}")
        for wname, w in m["weapons"].items():
            zone = w["zone"]
            entry = {}
            for variant, spec in (("base", w), ("pap", w.get("pap"))):
                if not spec:
                    continue
                wf = read_weapon(zone, spec["weapon"])
                check(wf.get("worldModel") == spec["world"], f"{wname}/{variant}: worldModel is {wf.get('worldModel')}, manifest says {spec['world']}", problems)
                check(wf.get("gunModel") == spec["view"], f"{wname}/{variant}: gunModel is {wf.get('gunModel')}, manifest says {spec['view']}", problems)
                check(wf.get("worldFlashEffect", "") == (spec.get("flash") or ""), f"{wname}/{variant}: worldFlashEffect is {wf.get('worldFlashEffect')!r}", problems)
                display = names.get(wf.get("displayName", ""), wf.get("displayName"))
                suffix = "" if variant == "base" else "_pap"
                same_world = variant == "pap" and spec["world"] == w["world"]
                info = {"displayName": display, "weaponFile": spec["weapon"],
                        "gameSounds": {"fireSound": wf.get("fireSound"), "fireSoundPlayer": wf.get("fireSoundPlayer")},
                        "flashEffect": wf.get("worldFlashEffect") or None,
                        "reticle": {"center": wf.get("reticleCenter") or None, "side": wf.get("reticleSide") or None}}
                if not same_world:
                    r = build_static(spec["world"], zone, wd / f"{wname}{suffix}.glb", f"{wname}{suffix}", "weapon", WORLD_TEX)
                    info["glb"] = f"_weapons/{wname}{suffix}.glb"
                    info["world"] = r
                    log(f"weapon {wname + suffix:20s} {r['bytes'] / 1024:6.1f} KB {r['triangles']:5d} tris {r['draws']} draws"
                        f" camo={r['papCamo']} tags={','.join(sorted(r['tags']))}  {spec['world']}")
                else:
                    info["glb"] = None
                    info["sameWorldModelAsBase"] = True
                rv = build_static(spec["view"], zone, wd / f"{wname}{suffix}_view.glb", f"{wname}{suffix}_view", "viewmodel", VIEW_TEX)
                info["viewGlb"] = f"_weapons/{wname}{suffix}_view.glb"
                info["view"] = rv
                log(f"weapon {wname + suffix + '_view':20s} {rv['bytes'] / 1024:6.1f} KB {rv['triangles']:5d} tris {rv['draws']} draws"
                    f" camo={rv['papCamo']}  {spec['view']}")
                world_tags = (info.get("world") or entry.get("world") or {}).get("tags", {})
                info["muzzle"] = {"tag": "tag_flash", "sprite": spec["muzzle"],
                                  "spriteUrl": f"_fx/{spec['muzzle']}.png",
                                  "position": world_tags.get("tag_flash", {}).get("position"),
                                  "viewPosition": rv["tags"].get("tag_flash", {}).get("position")}
                check("tag_flash" in world_tags, f"{wname}/{variant}: world model has no tag_flash", problems)
                check(spec["muzzle"] in m["fx"], f"{wname}/{variant}: muzzle sprite {spec['muzzle']} not in fx", problems)
                info["sounds"] = {"fire": snd(spec.get("fire")), "fire_plr": snd(spec.get("fire_plr"))}
                if spec.get("soundStandIn"):
                    info["soundStandIn"] = spec["soundStandIn"]
                if arms_bones:
                    info["fp"] = fp_info(zone, wf, arms_bones, fp_poses)
                if variant == "base":
                    entry.update(info)
                else:
                    if same_world:
                        info["note"] = "the game uses the base world model for the upgraded gun; only the viewmodel changes"
                    entry["pap"] = info
            entry["attach"] = {"gripLocal": grip_local(grip, w.get("grip")),
                               "engine": {"playerBone": m["attach"]["playerBone"], "weaponTag": "tag_weapon",
                                          "localQuaternion": m["attach"]["localQuaternion"]}}
            # the shape R3 builds against: sounds.fire / sounds.fire_pap
            if entry.get("pap"):
                entry["sounds"]["fire_pap"] = entry["pap"]["sounds"]["fire"]
                entry["sounds"]["fire_pap_plr"] = entry["pap"]["sounds"]["fire_plr"]
            if w.get("aliases"):
                entry["aliases"] = list(w["aliases"])
            if not w.get("grip"):
                entry["attach"]["gripLocal"] = grip_local(grip, DEFAULT_GRIP_POINT)
                if entry["attach"]["gripLocal"]:
                    entry["attach"]["gripLocal"]["gripPointSource"] = "default (the origin sits ~10 u ahead of the grip, §3); not measured"
            weapons[wname] = entry
        if fp_poses:
            (wd / "fp_poses.json").write_text(json.dumps({"frame": "engine, bone-local: [quat xyzw | null, trans xyz | null]",
                                                          "poses": fp_poses}, separators=(",", ":"), sort_keys=True),
                                              encoding="utf8")
            wrote(wd / "fp_poses.json")
            log(f"fp     {len(fp_poses)} viewmodel poses -> _weapons/fp_poses.json "
                f"{(wd / 'fp_poses.json').stat().st_size / 1024:.1f} KB")

    # --- power-ups
    powerups = old.get("powerups", {}) if only and "powerups" not in only else {}
    if not only or "powerups" in only:
        pd = OUT / "_powerups"
        pc = m["powerup_common"]
        for kind, p in m["powerups"].items():
            r = build_static(p["xmodel"], p["zone"], pd / f"{kind}.glb", kind, "powerup", POWERUP_TEX)
            log(f"powerup {kind:19s} {r['bytes'] / 1024:6.1f} KB {r['triangles']:5d} tris  {p['xmodel']}")
            e = {"glb": f"_powerups/{kind}.glb", "xmodel": p["xmodel"], "script": p["script"], "model": r,
                 "sounds": {k: snd(p.get(k)) for k in ("pickup", "announce", "sting", "loop", "end", "each_zombie") if p.get(k)},
                 "glow": {"sprite": pc["glow"], "spriteUrl": f"_fx/{pc['glow']}.png"},
                 "spawnSound": snd(pc["spawn"]), "idleLoop": snd(pc["idle_loop"]),
                 "groundLifeMs": pc["groundLifeMs"], "blinkFromMs": pc["blinkFromMs"]}
            if p.get("durationMs"):
                e["durationMs"] = p["durationMs"]
            powerups[kind] = e

    general = {k: f"_sounds/{k}.ogg" for k in ("hit_marker", "player_hit", "zombie_swipe", "pap_upgrade",
                                                "pap_ready", "pap_sting", "pap_jingle", "powerup_spawn",
                                                "powerup_loop", "powerup_grab") if k in m["sounds"]}
    fingerprint = hashlib.sha256(MANIFEST.read_bytes() + Path(__file__).read_bytes()).hexdigest()[:16]
    manifest = {
        "about": "ENW Zombies replay assets, built by tools/models/export_assets.py from the player's own game "
                 "files (docs/kickstart/assets-pipeline.md). Game-derived: never commit, never upload.",
        "base": "/mapdata/",
        "frame": "glTF Y-up, engine +X forward, engine inches (scene.js toThree); no scale",
        "build": fingerprint,
        "attach": dict(m["attach"], grip={k: v for k, v in grip.items() if k != "palm"} if grip else None),
        "weapons": weapons,
        # The replay's `weapon` field / event is the engine name (replay-events-v1.md): look it up here.
        # `aliases` are the same gun's names on the older maps (Nacht's `thompson`, Verrückt's
        # `bar_bipod`): drawn with Der Riese's model.
        "weaponByEngineName": {**{a: {"weapon": k, "pap": False} for k, w in m["weapons"].items() for a in (w.get("aliases") or [])},
                               **{w["weapon"]: {"weapon": k, "pap": False} for k, w in m["weapons"].items()},
                               **{w["pap"]["weapon"]: {"weapon": k, "pap": True}
                                  for k, w in m["weapons"].items() if w.get("pap")}},
        "viewhands": viewhands,
        "viewhandsDefault": (m.get("viewhands_default") or (sorted(viewhands)[0] if viewhands else None)),
        "fpPoses": "_weapons/fp_poses.json" if (fp_poses or (only and "weapons" not in only and old.get("fpPoses"))) else None,
        "powerups": powerups,
        "fx": fx,
        "fxJson": "_fx/fx.json",
        "sounds": {"general": general, "all": sounds},
        "missing": m.get("missing", {}),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf8")

    # A section that was rebuilt owns its directory: anything this run did not write goes
    # (a renamed or dropped asset must not linger and be served).
    built = {"_weapons": "weapons", "_powerups": "powerups", "_fx": "fx", "_sounds": "sounds"}
    for d, sect in built.items():
        if only and sect not in only:
            continue
        for f in sorted((OUT / d).glob("*")):
            if f.is_file() and f.name not in WRITTEN.get(d, set()) and f.name != "fx.json":
                log(f"removing stale {d}/{f.name}")
                f.unlink()

    # budgets
    total, over = manifest_path.stat().st_size, []
    for d in ("_weapons", "_powerups", "_fx", "_sounds"):
        for f in sorted((OUT / d).glob("*")):
            total += f.stat().st_size
            big = f.stem.endswith("_view") or f.stem.startswith("viewhands_")
            if f.suffix == ".glb" and f.stat().st_size > (VIEW_BUDGET if big else GLB_BUDGET):
                over.append(f"{d}/{f.name} {f.stat().st_size // 1024} KB")
    log(f"pack total {total / 1024 / 1024:.2f} MB (budget {PACK_BUDGET // 1024 // 1024} MB); wrote {manifest_path}")
    log(f"done in {time.time() - t0:.1f}s")
    WORK.mkdir(parents=True, exist_ok=True)
    with open(WORK / "export_assets.log", "a", encoding="utf8") as fh:
        fh.write("\n".join(LOG_LINES) + "\n\n")
    if problems:
        sys.exit("cross-check failed:\n  " + "\n  ".join(problems))
    if over:
        sys.exit(f"over the per-glb budget ({GLB_BUDGET // 1024} KB, views {VIEW_BUDGET // 1024} KB): {', '.join(over)}")
    if total > PACK_BUDGET:
        sys.exit(f"pack is {total / 1024 / 1024:.2f} MB, over the {PACK_BUDGET // 1024 // 1024} MB budget")


if __name__ == "__main__":
    main()
