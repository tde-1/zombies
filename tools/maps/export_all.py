#!/usr/bin/env python3
"""Replay geometry + textures for every map we host, one command.

    python tools/maps/export_all.py --maps proven          # the 5 SERVER_PROVEN maps
    python tools/maps/export_all.py --maps new             # the box-proven "New" maps
    python tools/maps/export_all.py --maps archive         # every other map in archive/mods
    python tools/maps/export_all.py --maps all             # all of the above, in that order
    python tools/maps/export_all.py --maps nazi_zombie_factory,zm_nuked
    python tools/maps/export_all.py --report               # just rewrite the results table

Per map, each step skipping itself when its output is current (so a re-run is cheap and a
stopped run resumes where it stopped; --force redoes a map):

  1. locate   the fastfile: Steam zone/english for the stock four (read-only), else
              ZombiesDev/archive/mods-staged|mods/<bsp>/<bsp>.ff (archive.md §7)
  2. unlink   OpenAssetTools' Unlinker -> xmodels, materials, images (DDS), map_ents.
              No game, no lock.
  3. world    the world shell + static-model placements, OFFLINE: our OAT build with the
              T4 GfxWorld dumper (tools/maps/oat-t4-world; export_map.unlink_world) reads
              GfxWorld straight out of the fastfile. No game, no game.lock (replay.md §15).
              `--husky` is the old fallback for a zone the dumper cannot read: Husky
              (tools/maps/husky-map.ps1) out of the RUNNING game, game.lock per map.
  4. build    export_map.build(): props + sky + shell into one raw .glb in engine units,
              textures lossless.
  5. optimize tools/maps/optimize_glb.cjs -- ENW Movement's recipe: dedup/prune, WebP
              textures <= 512 px (256 if the map is over budget), KHR_mesh_quantization on
              normals and UVs. Written to ZombiesDev/maps-staging/<bsp>/<bsp>.glb -- NOT
              the served ZombiesDev/maps (/mapdata, replay.md §7a); promotion is a copy
              the coordinator makes after the checks pass.
  6. validate bounds sane and holding the map's own pathnodes, triangle and texture counts,
              no NaN/Inf, a spawn point standing on the shell. Written into the sidecar.

Outputs never enter git (game-derived; replay.md §4). Logs: ZombiesDev/maps/_work/logs/
<bsp>.export.log. State + results table: ZombiesDev/maps/_work/export_all/{state.json,
results.md}.
"""

import argparse
import contextlib
import io
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import export_map as em  # noqa: E402
import heavylock  # noqa: E402

DEV = em.DEV
# STAGING, never the served dir. ZombiesDev/maps is what the live site serves (replay.md §7a);
# promoting a staged export there is the coordinator's step (copy <bsp>.glb + .meta.json),
# after the checks in the sidecar and web/test/map-align.js have passed on the staged file.
MAPS = Path(os.environ.get("ZM_EXPORT_OUT", DEV / "maps-staging"))
WORK = DEV / "maps" / "_work"
STATE_DIR = WORK / "export_all"
LOGS = WORK / "logs"
HUSKY_OUT = WORK / "husky"
RAW = WORK / "raw"
STOCK = ["nazi_zombie_prototype", "nazi_zombie_asylum", "nazi_zombie_sumpf", "nazi_zombie_factory"]
PROVEN = STOCK + ["nazi_zombie_fear_mc_2"]          # web/server/lib/maps.js SERVER_PROVEN
BUDGET_MB = 20.0          # per-map hard ceiling (Movement's is 30); over it -> 256 px textures
TARGET_TEX = 512
PIPELINE = "oat-0.33.0+enw-gfxworld-t4+export_map+gltf-transform-4+webp80+q8u16+meshopt-low"


# ---------------------------------------------------------------------------
# map lists
# ---------------------------------------------------------------------------

def box_new():
    try:
        d = json.loads((REPO / "web" / "server" / "lib" / "boxProven.json").read_text("utf8"))["maps"]
    except Exception:
        return []
    return sorted(k for k, v in d.items() if v and v.get("result") == "pass" and k not in PROVEN)


def archive_rest():
    have = set(PROVEN) | set(box_new())
    root = em.ARCHIVE_MODS
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / f"{p.name}.ff").is_file()
                  and p.name not in have) if root.is_dir() else []


def resolve(spec):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if part == "proven":
            out += PROVEN
        elif part == "new":
            out += box_new()
        elif part == "archive":
            out += archive_rest()
        elif part == "all":
            out += PROVEN + box_new() + archive_rest()
        elif part:
            out.append(part)
    seen, res = set(), []
    for m in out:
        if m not in seen:
            seen.add(m)
            res.append(m)
    return res


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------

def load_state():
    f = STATE_DIR / "state.json"
    try:
        return json.loads(f.read_text("utf8"))
    except Exception:
        return {}


def save_state(st):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_DIR / "state.json.tmp"
    tmp.write_text(json.dumps(st, indent=1), "utf8")
    os.replace(tmp, STATE_DIR / "state.json")


class Tee(io.TextIOBase):
    def __init__(self, *s):
        self.s = s

    def write(self, x):
        for s in self.s:
            s.write(x)
            s.flush()
        return len(x)


# ---------------------------------------------------------------------------
# glb reading (validation)
# ---------------------------------------------------------------------------

def read_glb(path: Path):
    b = path.read_bytes()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    assert magic == 0x46546C67, "not a glb"
    jl, jt = struct.unpack_from("<II", b, 12)
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack_from("<II", b, off)
    return j, memoryview(b)[off + 8:off + 8 + bl]


def accessor(j, bin_, ai):
    import numpy as np
    a = j["accessors"][ai]
    v = j["bufferViews"][a["bufferView"]]
    ctype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8,
             5122: np.int16, 5120: np.int8}[a["componentType"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    item = np.dtype(ctype).itemsize * n
    stride = v.get("byteStride") or item
    start = v.get("byteOffset", 0) + a.get("byteOffset", 0)
    raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * (a["count"] - 1) + item, offset=start)
    if stride == item:
        return np.frombuffer(raw.tobytes(), dtype=ctype).reshape(a["count"], n)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(a["count"], item), strides=(stride, 1))
    return np.frombuffer(rows.copy().tobytes(), dtype=ctype).reshape(a["count"], n)


def validate(glb_path: Path, meta: dict):
    """Numbers, not opinions. Returns (ok, dict)."""
    import numpy as np
    j, bin_ = read_glb(glb_path)
    res = {"nan": 0, "world_tris": 0, "prop_nodes": 0, "unique_tris": 0,
           "textures": len(j.get("textures", [])), "materials": len(j.get("materials", []))}
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            if "indices" in p:
                res["unique_tris"] += j["accessors"][p["indices"]]["count"] // 3
    # every float POSITION accessor, finite
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            P = accessor(j, bin_, p["attributes"]["POSITION"])
            if P.dtype == np.float32:
                res["nan"] += int((~np.isfinite(P)).sum())
    world = next((n for n in j.get("nodes", []) if n.get("name") == "__world"), None)
    res["prop_nodes"] = sum(1 for n in j.get("nodes", []) if "mesh" in n and not n.get("name", "").startswith("__"))
    problems = []
    if res["nan"]:
        problems.append(f"{res['nan']} non-finite position components")
    if world is None:
        problems.append("no __world node (no shell)")
        res["ok"] = False
        res["problems"] = problems
        return False, res
    tris = []
    for p in j["meshes"][world["mesh"]]["primitives"]:
        P = accessor(j, bin_, p["attributes"]["POSITION"]).astype(np.float64)
        I = accessor(j, bin_, p["indices"]).reshape(-1).astype(np.int64)
        tris.append(P[I.reshape(-1, 3)])
    T = np.concatenate(tris) if tris else np.zeros((0, 3, 3))
    res["world_tris"] = int(len(T))
    if not len(T):
        problems.append("empty shell")
        res["problems"] = problems
        return False, res
    lo = T.reshape(-1, 3).min(0)
    hi = T.reshape(-1, 3).max(0)
    res["bounds"] = [[round(float(x), 1) for x in lo], [round(float(x), 1) for x in hi]]
    ext = hi - lo
    res["extent"] = [round(float(x)) for x in ext]
    # Coordinates are already inside +-65536 (export_map culls past it), so a span may reach
    # 131072: chickn / derberg / water / cargo carry terrain that wide. Scale errors are caught
    # by align_check's spawns, path nodes and window goals, not by the span.
    if max(ext) > 131072 or max(ext) < 256:
        problems.append(f"extent {res['extent']} not a map-sized box")
    # The map's own pathnodes (map_ents, engine units) must sit inside the shell's box. A shell
    # at the wrong scale (the 2.54x of replay.md §8.12) or offset fails this at once.
    nodes = np.asarray(meta.get("pathnodes") or [], dtype=np.float64).reshape(-1, 3)
    if len(nodes):
        inside = ((nodes >= lo - 64) & (nodes <= hi + 64)).all(1)
        res["pathnodes_inside"] = f"{int(inside.sum())}/{len(nodes)}"
        if inside.mean() < 0.9:
            # A note, not a failure: a map can build whole areas from props (kingdom_hearts).
            # align_check's path-node floor test (shell AND props) is the one that decides.
            res.setdefault("notes", []).append(f"only {res['pathnodes_inside']} pathnodes inside the shell box")
    # Spawn on a floor: straight down from spawn+32, a shell triangle within 256 u.
    spawns = [s for s in (meta.get("spawns") or []) if any(s)] or ([meta["spawn"]] if meta.get("spawn") and any(meta["spawn"]) else [])
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    tlo = T[:, :, :2].min(1)
    thi = T[:, :, :2].max(1)
    hits = []
    for s in spawns[:32]:
        x, y, z = s
        m = (tlo[:, 0] <= x) & (thi[:, 0] >= x) & (tlo[:, 1] <= y) & (thi[:, 1] >= y)
        best = None
        if m.any():
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
            ins = good & (u >= -1e-4) & (v >= -1e-4) & (u + v <= 1 + 1e-4)
            zz = A[:, 2] + u * (C[:, 2] - A[:, 2]) + v * (B[:, 2] - A[:, 2])
            below = ins & (zz <= z + 32) & (zz >= z - 256)
            if below.any():
                best = float(z - zz[below].max())
        hits.append(best)
    ok_sp = [h for h in hits if h is not None]
    res["spawns_tested"] = len(hits)
    res["spawns_on_floor"] = len(ok_sp)
    if ok_sp:
        res["spawn_floor_gap_median"] = round(sorted(ok_sp)[len(ok_sp) // 2], 1)
    if hits and not ok_sp:
        # Also a note: spawns may stand on props or float (align_check decides, path nodes too).
        res.setdefault("notes", []).append(f"no spawn of {len(hits)} has shell floor within 256 u below it")
    if not hits:
        res["spawn_note"] = "map_ents carry no spawn point"
    res["problems"] = problems
    res["ok"] = not problems
    return not problems, res


# ---------------------------------------------------------------------------
# the steps
# ---------------------------------------------------------------------------

def husky_obj(bsp):
    return HUSKY_OUT / "exported_maps" / "world_at_war" / "sp" / bsp / f"{bsp}.obj"


def step_husky(bsp, ff: Path, force: bool, log):
    obj = husky_obj(bsp)
    if obj.is_file() and obj.stat().st_size > 0 and not force and obj.stat().st_mtime > ff.stat().st_mtime:
        log(f"husky: shell is current ({obj.stat().st_size / 1048576:.1f} MB)")
        return obj, None
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "husky-map.ps1"),
           "-Map", bsp, "-OutDir", str(HUSKY_OUT)]
    log("husky: " + " ".join(cmd))
    t = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60 * 45)
    out = (r.stdout or "").strip().splitlines()
    for line in out[:-1]:
        log("  | " + line)
    try:
        res = json.loads(out[-1]) if out else {}
    except Exception:
        res = {"ok": False, "error": (out[-1] if out else "") + (r.stderr or "")[-800:]}
    log(f"husky: {time.time() - t:.0f}s ok={res.get('ok')} {res.get('error') or ''}")
    for l in res.get("lines") or []:
        if "Count" in l or "Loaded" in l:
            log("  husky> " + l)
    if res.get("ok") and obj.is_file():
        return obj, None
    return None, res.get("error") or "husky failed"


def step_build(bsp, dump: Path, obj, force: bool, log):
    out = RAW / bsp
    glb = out / f"{bsp}.glb"
    srcs = [dump / ".unlinked", Path(em.__file__)] + ([obj] if obj else [])
    if obj and obj.suffix.lower() == ".json":
        srcs.append(obj.with_suffix(".bin"))
    if glb.is_file() and not force and all(glb.stat().st_mtime > s.stat().st_mtime for s in srcs if s.exists()):
        meta = json.loads((out / f"{bsp}.meta.json").read_text("utf8"))
        if meta.get("world_shell") == bool(obj) and meta.get("world_source") == (obj.name if obj else None):
            log(f"build: raw glb is current ({glb.stat().st_size / 1048576:.1f} MB)")
            return glb, meta
    em.LOSSLESS_TEX = True
    t = time.time()
    meta = em.build(bsp, dump, out, obj)
    log(f"build: {time.time() - t:.0f}s raw {glb.stat().st_size / 1048576:.1f} MB")
    return glb, meta


def step_optimize(bsp, raw: Path, log, budget_mb):
    """-> (checkable.glb, served.glb, stats). Both beside the raw file, never in the served
    folder (NodeIO picks glb vs gltf+bin+images from the EXTENSION, so names end in .glb).
    checkable: float positions, what validate() and align_check read. served: the same
    document meshopt-encoded (optimize_glb.cjs decodes it again and compares bounds)."""
    chk = raw.parent / f"{bsp}.opt.glb"
    srv = raw.parent / f"{bsp}.served.glb"
    stats = None
    for size, q in ((TARGET_TEX, 80), (256, 80), (256, 60)):
        cmd = ["node", str(HERE / "optimize_glb.cjs"), str(raw), str(chk), str(size), "--quality", str(q),
               "--meshopt", str(srv)]
        t = time.time()
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("optimize failed: " + (r.stdout[-600:] + r.stderr[-1200:]))
        stats = json.loads(r.stdout.strip().splitlines()[-1])
        mb = srv.stat().st_size / 1048576
        log(f"optimize: tex {size}px q{q} -> served {mb:.2f} MB (checkable "
            f"{chk.stat().st_size / 1048576:.2f}) in {time.time() - t:.0f}s {stats}")
        stats["bytes"] = srv.stat().st_size
        if mb <= budget_mb:
            break
    stats["over_budget"] = srv.stat().st_size / 1048576 > budget_mb
    return chk, srv, stats


def export_one(bsp, st, a, log):
    rec = st.setdefault(bsp, {})
    rec.update({"map": bsp, "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "notes": []})
    notes = rec["notes"]
    ff, mod_dir = em.find_fastfile(bsp)
    if ff is None:
        rec.update(status="failed", error="no fastfile in zone/english or the archive")
        return
    log(f"fastfile {ff} ({ff.stat().st_size / 1048576:.1f} MB)")
    # 2 unlink
    try:
        dump = em.unlink(bsp, WORK, a.force)
    except SystemExit as e:
        rec.update(status="failed", error=f"unlink: {e}")
        return
    # 3 world shell -- offline first (OAT GfxWorld), Husky only when asked
    obj = em.unlink_world(bsp, WORK, a.force)
    if obj is None:
        if not em.OAT_GEO.is_file():
            notes.append(f"no shell: the OAT geo build is not installed ({em.OAT_GEO})")
        else:
            notes.append("no shell: the zone has no GfxWorld the dumper could read")
        if a.husky:
            obj, err = step_husky(bsp, ff, a.force or a.force_husky, log)
            if err:
                notes.append(f"husky: {err[:300]}")
    # 4 build
    raw, meta = step_build(bsp, dump, obj, a.force, log)
    # 5 optimize
    chk, srv, stats = step_optimize(bsp, raw, log, a.budget_mb)
    # 6 validate the checkable file (float positions); the served one is the same document
    # meshopt-encoded, and optimize_glb.cjs has already decoded it and compared bounds.
    ok, val = validate(chk, meta)
    log(f"validate: ok={ok} {json.dumps(val)}")
    dst = MAPS / bsp / f"{bsp}.glb"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(srv), str(dst))
    meta = dict(meta)
    meta.update({
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "glb_bytes": dst.stat().st_size,
        "raw_glb_bytes": raw.stat().st_size,
        "checkable_glb_bytes": chk.stat().st_size,
        "encoding": "EXT_meshopt_compression + KHR_mesh_quantization + EXT_texture_webp",
        "pipeline": PIPELINE,
        "optimize": stats,
        "validation": val,
        "fastfile": str(ff),
    })
    mf = MAPS / bsp / f"{bsp}.meta.json"
    mf.write_text(json.dumps(meta, indent=1), "utf8")
    # The §8.12 alignment check, the same code as web/test/map-align.js, on the staged file.
    r = subprocess.run(["node", str(HERE / "align_check.cjs"), str(chk), str(mf)], capture_output=True, text=True)
    try:
        al = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        al = {"ok": False, "problems": ["align_check failed: " + (r.stderr or r.stdout)[-300:]]}
    log(f"align: {json.dumps(al)}")
    meta["align"] = al
    # ...and on the SERVED bytes (meshopt + quantized), what a browser gets. mapAlign reads
    # them since 2026-09-23 (lane GEO); anchors there are checked against the node box.
    r = subprocess.run(["node", str(HERE / "align_check.cjs"), str(dst), str(mf)], capture_output=True, text=True)
    try:
        als = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        als = {"ok": False, "problems": ["align_check failed: " + (r.stderr or r.stdout)[-300:]]}
    log(f"align (served): {json.dumps(als)}")
    meta["align_served"] = als
    if meta.get("world_shell") and not als.get("ok"):
        al = dict(al, ok=False, problems=list(al.get("problems", [])) + ["served: " + p for p in als.get("problems", [])])
    mf.write_text(json.dumps(meta, indent=1), "utf8")
    if meta.get("world_shell") and not al.get("ok"):
        ok = False
        val.setdefault("problems", []).extend("align: " + p for p in al.get("problems", []))
    status = "ok" if (ok and meta.get("world_shell")) else ("partial" if not meta.get("world_shell") else "check")
    rec.update({
        "status": status, "error": None,
        "bytes": dst.stat().st_size, "raw_bytes": raw.stat().st_size,
        "world_tris": val.get("world_tris", 0), "unique_tris": val.get("unique_tris", 0),
        "textures": val.get("textures", 0), "props": meta.get("props_placed", 0),
        "static_models": meta.get("static_models_placed", 0),
        "tex_px": stats.get("texture_size"), "over_budget": stats.get("over_budget"),
        "problems": val.get("problems", []), "extent": val.get("extent"),
        "spawns": f"{val.get('spawns_on_floor', 0)}/{val.get('spawns_tested', 0)}",
        "world_extractor": meta.get("world_extractor"),
        "world_textures_missing": len(meta.get("world_missing_textures") or []),
        "align_ok": bool(meta["align"].get("ok")), "align_served_ok": bool(als.get("ok")),
        "align_windows": meta["align"].get("windows"), "align_spawns": meta["align"].get("spawns_on_floor"),
        "align_anchors": f"{meta['align'].get('anchors_on', '?')}/{meta['align'].get('anchors_checked', '?')}",
        "finished": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })


def align_file(glb: Path, mf: Path):
    r = subprocess.run(["node", str(HERE / "align_check.cjs"), str(glb), str(mf)], capture_output=True, text=True)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "problems": ["align_check failed: " + (r.stderr or r.stdout)[-300:]]}


def recheck(bsp, st, log=print):
    """Re-run only the two align checks on an already staged export (after a checker change),
    and rewrite its sidecar + state row. Light: no unlink, build or optimise."""
    rec = st.get(bsp)
    mf = MAPS / bsp / f"{bsp}.meta.json"
    if not rec or not mf.is_file():
        return
    meta = json.loads(mf.read_text("utf8"))
    chk = RAW / bsp / f"{bsp}.opt.glb"
    al = align_file(chk, mf) if chk.is_file() else {"ok": False, "problems": ["no float twin"]}
    als = align_file(MAPS / bsp / f"{bsp}.glb", mf)
    meta["align"], meta["align_served"] = al, als
    mf.write_text(json.dumps(meta, indent=1), "utf8")
    val_ok = not [p for p in (meta.get("validation") or {}).get("problems", []) if not p.startswith("align")]
    ok = val_ok and al.get("ok") and als.get("ok")
    rec["problems"] = [p for p in rec.get("problems", []) if not p.startswith("align")] + \
        ["align: " + p for p in al.get("problems", []) + ["served: " + q for q in als.get("problems", [])]]
    if meta.get("world_shell"):
        rec["status"] = "ok" if ok else "check"
    rec.update({"align_ok": bool(al.get("ok")), "align_served_ok": bool(als.get("ok")),
                "align_windows": al.get("windows"), "align_spawns": al.get("spawns_on_floor"),
                "align_anchors": f"{al.get('anchors_on', '?')}/{al.get('anchors_checked', '?')}"})
    log(f"{bsp}: recheck -> {rec.get('status')} {rec['problems'][:2]}")


def write_report(st, order):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    rows = [st[m] for m in order if m in st] + [v for k, v in sorted(st.items()) if k not in order]
    tot = sum(r.get("bytes") or 0 for r in rows)
    lines = [f"# replay geometry export -- {time.strftime('%Y-%m-%d %H:%M')}", "",
             f"{sum(1 for r in rows if r.get('status') == 'ok')} ok, "
             f"{sum(1 for r in rows if r.get('status') in ('partial', 'check'))} partial/check, "
             f"{sum(1 for r in rows if r.get('status') == 'failed')} failed; "
             f"total {tot / 1048576:.1f} MB", "",
             "| map | status | MB | shell tris | unique tris | textures | props | tex px | spawns on floor | notes |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        note = "; ".join((r.get("problems") or []) + (r.get("notes") or []) + ([r["error"]] if r.get("error") else []))
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r.get("map"), r.get("status"), f"{(r.get('bytes') or 0) / 1048576:.2f}",
            r.get("world_tris", ""), r.get("unique_tris", ""), r.get("textures", ""),
            r.get("props", ""), r.get("tex_px", ""), r.get("spawns", ""), note.replace("|", "/")[:220]))
    (STATE_DIR / "results.md").write_text("\n".join(lines) + "\n", "utf8")
    (STATE_DIR / "results.json").write_text(json.dumps(rows, indent=1), "utf8")
    return STATE_DIR / "results.md", tot


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--maps", default="proven", help="proven | new | archive | all | a,b,c (mixable)")
    ap.add_argument("--force", action="store_true", help="redo every step for these maps")
    ap.add_argument("--husky", action="store_true",
                    help="fall back to Husky (a game launch + game.lock) when the offline dumper gets no shell")
    ap.add_argument("--force-husky", action="store_true", help="with --husky: re-run the game step")
    ap.add_argument("--skip-failed", action="store_true", help="do not retry maps whose last status was failed")
    ap.add_argument("--skip-done", action="store_true", help="skip maps already ok (default: re-check, cheap)")
    ap.add_argument("--budget-mb", type=float, default=BUDGET_MB)
    ap.add_argument("--report", action="store_true", help="only rewrite results.md from state.json")
    ap.add_argument("--recheck", action="store_true",
                    help="re-run only the align checks on already staged maps (after a checker change)")
    a = ap.parse_args()

    order = resolve(a.maps)
    st = load_state()
    if a.recheck:
        for bsp in order:
            recheck(bsp, st)
        save_state(st)
        p, tot = write_report(st, order)
        print(p, f"{tot / 1048576:.1f} MB")
        return
    if a.report:
        p, tot = write_report(st, order)
        print(p, f"{tot / 1048576:.1f} MB")
        return

    # One export_all at a time: two would fight over the same _work files and the game.
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    plock = STATE_DIR / "run.lock"
    if plock.exists():
        try:
            other = int(plock.read_text().split()[0])
            import ctypes
            h = ctypes.windll.kernel32.OpenProcess(0x1000, False, other)
            alive = bool(h)
            if h:
                code = ctypes.c_ulong()
                ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
                alive = code.value == 259
                ctypes.windll.kernel32.CloseHandle(h)
        except Exception:
            alive = False
        if alive:
            sys.exit(f"another export_all is running ({plock.read_text().strip()})")
    plock.write_text(f"{os.getpid()} {time.strftime('%Y-%m-%dT%H:%M:%S')} {a.maps}")
    LOGS.mkdir(parents=True, exist_ok=True)
    try:
        for i, bsp in enumerate(order, 1):
            prev = st.get(bsp, {})
            if a.skip_done and prev.get("status") == "ok" and not a.force:
                continue
            if prev.get("status") == "failed" and a.skip_failed and not a.force:
                print(f"[{i}/{len(order)}] {bsp}: failed before ({(prev.get('error') or '')[:80]}) -- skipped")
                continue
            lf = open(LOGS / f"{bsp}.export.log", "a", encoding="utf8")

            def log(*x, _lf=lf):
                line = f"[{time.strftime('%H:%M:%S')}] " + " ".join(str(y) for y in x)
                print(f"[{bsp}] {line}", flush=True)
                _lf.write(line + "\n")
                _lf.flush()

            log(f"==== {bsp} ({i}/{len(order)}) ====")
            t = time.time()
            try:
                # One heavy job machine-wide (heavylock.py): the lock and the memory gate are
                # taken per map and released between maps, so other lanes interleave.
                with heavylock.heavy(f"GEO lane export_all: {bsp}", log=log),                         contextlib.redirect_stdout(Tee(sys.stdout, lf)):
                    export_one(bsp, st, a, log)
            except Exception as e:
                st.setdefault(bsp, {}).update(map=bsp, status="failed", error=f"{type(e).__name__}: {e}"[:400])
                log(traceback.format_exc())
            st[bsp]["seconds"] = round(time.time() - t)
            log(f"==== {bsp}: {st[bsp].get('status')} in {st[bsp]['seconds']}s "
                f"{(st[bsp].get('bytes') or 0) / 1048576:.2f} MB")
            lf.close()
            save_state(st)
            write_report(st, order)
    finally:
        try:
            plock.unlink()
        except Exception:
            pass
    p, tot = write_report(st, order)
    print(f"results: {p}  total {tot / 1048576:.1f} MB")


if __name__ == "__main__":
    main()
