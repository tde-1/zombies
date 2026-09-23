#!/usr/bin/env python3
"""Drive one archive TRANCHE through the existing tools, and write down what it produced.

Tranche 2 (2026-09-23, B: "archive way more maps"). The steps are the popular-64 run's
(archive.md s10), each still done by its own tool; this only sequences them for a shortlist
and keeps the tranche's own bsp list so every later step touches the tranche and nothing else.

    python archive/tranche.py extract   --shortlist archive/shortlist4.txt   # extract.py --hardlink, fetched + not yet extracted
    python archive/tranche.py list      --shortlist archive/shortlist4.txt   # -> archive/tranche2.txt (bsp per line)
    python archive/tranche.py manifests --list archive/tranche2.txt          # site_hidden + tranche + cover into each manifest
    python archive/tranche.py queue     --list archive/tranche2.txt          # lane 10: append bsp + fastfile to maps-staging/_queue.txt
    python archive/tranche.py verify    --list archive/tranche2.txt          # bsp/ff present, sizes, IWDs, served files

Nothing here downloads, boots or uploads: fetch.py, box_proof.py and tools/s3/sync.js do.
"""
import argparse
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MANIFESTS = os.path.join(HERE, "manifests")
QUEUE = os.environ.get("ENW_GEOMETRY_QUEUE", r"C:\Users\b\ZombiesDev\maps-staging\_queue.txt")
SERVED_EXT = {".ff", ".iwd", ".arena", ".csv", ".txt", ".cfg", ".gsc", ".csc", ".iwi", ".bik", ".menu", ".str", ""}


def read_list(path):
    out = []
    for ln in open(path, encoding="utf-8"):
        b = ln.split("#")[0].strip().split()
        if b and b[0] not in out:
            out.append(b[0])
    return out


def extract_report():
    p = os.path.join(WORK, "reports", "extract.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else []


def by_norm():
    return {e["norm"]: e for e in extract_report()}


def by_map():
    out = {}
    for e in extract_report():
        for m in e.get("mods") or []:
            out[m["map"]] = (e, m)
    return out


def cmd_extract(a):
    done = by_norm()
    todo = []
    for n in read_list(a.shortlist):
        d = os.path.join(WORK, "originals", n)
        if glob.glob(os.path.join(d, "*.meta.json")) and (a.redo or n not in done):
            todo.append(n)
    print("extracting %d: %s" % (len(todo), " ".join(todo)))
    for i in range(0, len(todo), 10):
        args = [sys.executable, os.path.join(HERE, "extract.py"), "--hardlink"]
        for n in todo[i:i + 10]:
            args += ["--norm", n]
        subprocess.run(args, check=False)


def cmd_list(a):
    ex = by_norm()
    rank = {}
    try:
        for i, r in enumerate(json.load(open(os.path.join(WORK, "reports", a.ranking), encoding="utf-8")), 1):
            rank[r["norm"]] = (i, r)
    except Exception:
        pass
    lines, missing = [], []
    for n in read_list(a.shortlist):
        e = ex.get(n)
        mods = (e or {}).get("mods") or []
        if not mods:
            missing.append("%s: %s" % (n, "; ".join((e or {}).get("errors") or ["not fetched/extracted"])))
            continue
        for m in mods:
            lines.append("%s  # %s (%s)" % (m["map"], (rank.get(n, (0, {}))[1] or {}).get("name", n), n))
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write("# archive tranche 2 (2026-09-23): the bsp keys staged from %s. archive.md s12\n"
                 % os.path.basename(a.shortlist))
        fh.write("\n".join(lines) + "\n")
    print("wrote %s: %d maps" % (a.out, len(lines)))
    for m in missing:
        print("  not staged: " + m)


def catalogue_cover(norm):
    d = os.path.join(WORK, "media", "catalogue", norm)
    for meta in sorted(glob.glob(os.path.join(d, "*.meta.json"))):
        try:
            m = json.load(open(meta, encoding="utf-8"))
        except Exception:
            continue
        f = os.path.join(d, m.get("file") or "")
        if m.get("file") and os.path.isfile(f):
            return os.path.relpath(f, WORK).replace("\\", "/"), m.get("url")
    return None, None


def cmd_manifests(a):
    bm = by_map()
    n = 0
    for bsp in read_list(a.list):
        mf = os.path.join(MANIFESTS, bsp + ".json")
        if not os.path.exists(mf):
            print("  no manifest for %s (scan_maps.py --keep-existing first)" % bsp)
            continue
        m = json.load(open(mf, encoding="utf-8"))
        # Phase 1: hidden until the box proof says something (import-archive.js honours it,
        # popular.py --apply sets it false). Never re-hide a map that already has a result.
        if "box_proof" not in m:
            m["site_hidden"] = True
        a_ = m.setdefault("archive", {})
        a_["tranche"] = a.tranche
        e, _ = bm.get(bsp, ({}, {}))
        norm = e.get("norm")
        if norm and not a_.get("cover"):
            cov, url = catalogue_cover(norm)
            if cov:
                a_["cover"], a_["cover_source_url"] = cov, url
        with open(mf, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)
        n += 1
    print("updated %d manifests" % n)


def cmd_queue(a):
    bm = by_map()
    have = set()
    if os.path.exists(QUEUE):
        have = {ln.split()[0] for ln in open(QUEUE, encoding="utf-8") if ln.strip() and not ln.startswith("#")}
    add = []
    for bsp in read_list(a.list):
        if bsp in have or bsp not in bm:
            continue
        e, m = bm[bsp]
        ff = os.path.join(m["dest"], "%s.ff" % (m.get("bsp") or bsp))
        if not os.path.exists(ff):
            ffs = glob.glob(os.path.join(m["dest"], "*.ff"))
            ff = next((f for f in ffs if not f.endswith(("_load.ff", "_patch.ff"))), ff)
        add.append("%s  %s" % (bsp, ff))
    if add and not a.dry:
        os.makedirs(os.path.dirname(QUEUE), exist_ok=True)
        with open(QUEUE, "a", encoding="utf-8") as fh:
            fh.write("# archive tranche %s, %s (bsp  fastfile)\n" % (a.tranche, __import__("time").strftime("%Y-%m-%d %H:%M")))
            fh.write("\n".join(add) + "\n")
    print("%s %d lines to %s" % ("would append" if a.dry else "appended", len(add), QUEUE))


def cmd_verify(a):
    """bsp/ff present, the mod's IWDs, sizes, the served (bucket) set incl. loose files."""
    bm = by_map()
    pre = {}
    try:
        pre = json.load(open(os.path.join(WORK, "reports", "precheck.json"), encoding="utf-8"))
    except Exception:
        pass
    rows, bad = [], 0
    for bsp in read_list(a.list):
        if bsp not in bm:
            rows.append({"bsp": bsp, "ok": False, "why": "no extract.json entry"})
            bad += 1
            continue
        e, m = bm[bsp]
        key = m.get("bsp") or bsp
        files = m.get("files") or []
        rel = [f["path"].split("/", 2)[2] for f in files]
        lower = {r.lower() for r in rel}
        missing_disk = [r for r in rel if not os.path.exists(os.path.join(m["dest"], r))]
        served = [f for f, r in zip(files, rel) if os.path.splitext(r)[1].lower() in SERVED_EXT]
        loose = [r for r in rel if "/" in r and not r.lower().endswith((".ff", ".iwd"))]
        r = {"bsp": bsp, "norm": e["norm"],
             "ff": ("%s.ff" % key).lower() in lower, "load_ff": ("%s_load.ff" % key).lower() in lower,
             "patch_ff": ("%s_patch.ff" % key).lower() in lower,
             "iwds": sorted(x for x in rel if x.lower().endswith(".iwd")),
             "files": len(files), "bytes": m.get("bytes"),
             "served_files": len(served), "served_bytes": sum(f["size"] for f in served),
             "loose_files": len(loose), "missing_on_disk": missing_disk[:5],
             "zone_mb": (pre.get(bsp) or {}).get("map_zone_inflated_mb"),
             "flags": (pre.get(bsp) or {}).get("flags")}
        r["ok"] = r["ff"] and not missing_disk and r["served_files"] > 0
        if not r["ok"]:
            bad += 1
        rows.append(r)
    out = os.path.join(WORK, "reports", "tranche%s-verify.json" % a.tranche)
    json.dump(rows, open(out, "w", encoding="utf-8"), indent=1)
    tot = sum(r.get("served_bytes") or 0 for r in rows)
    print("verified %d maps, %d not ok, %.2f GB served (-> bucket); %s" % (len(rows), bad, tot / 1e9, out))
    for r in rows:
        if not r["ok"]:
            print("  NOT OK %s: %s" % (r["bsp"], r.get("why") or r))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("extract", "list"):
        p = sub.add_parser(name)
        p.add_argument("--shortlist", required=True)
        p.add_argument("--redo", action="store_true")
        p.add_argument("--ranking", default="popular2.json")
        p.add_argument("--out", default=os.path.join(HERE, "tranche2.txt"))
    for name in ("manifests", "queue", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--list", required=True)
        p.add_argument("--tranche", default="2")
        p.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    {"extract": cmd_extract, "list": cmd_list, "manifests": cmd_manifests, "queue": cmd_queue,
     "verify": cmd_verify}[a.cmd](a)


if __name__ == "__main__":
    main()
