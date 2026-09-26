#!/usr/bin/env python3
"""Static pre-flight for a normalised map, against the killers the dedi lane has named.

Nothing here boots anything; it reads the install and says which of the known ways a
custom map has died on us it *could* die by, so a dedi failure can be read against it:

  * ADD-ON IWDs beside the map's own (archive.md 9, dedi.md 15): listed with how many
    scripts each carries. archive.md 9.4 proved they can be hard dependencies, so this
    is information, never a reason to drop one.
  * CLIENT MEMORY (dedi.md 14.7): ORBiT's map zone inflates to ~128 MB of DB alloc and
    parks a 32-bit client at 1.62 GB. The inflated size of the map zone is recorded;
    >= 110 MB is flagged `client_memory_risk`.
  * NAPALMBLOB (dedi.md 11.4): recorded, NOT flagged -- the string is in every map
    zone measured (9 of 9, including the passing fear_mc_2), so it predicts nothing.
  * MISSING _load / _patch zones (archive.md 9.5, Leviathan).
  * localVars (dedi.md 13.2) cannot be predicted statically; only a boot says.

It also records the ART the map ships, for the site-art lane: every `loadscreen_*`
material name in the map's zones and every image in its IWDs whose name looks like a
menu / load / preview background. Written into the manifest as `archive.art` (names
only -- nothing is converted or copied).

    python archive/precheck.py --map nuketown [--map ...] [--write-manifest] [--gate]

--gate (archive.md 13) also runs archive/asset_gate.py on the maps and exits 1 if any has a
blocking asset verdict (a zombie model, box/wall weapon or script the release lacks, or a file
we do not deliver). A map never booted is `unproven` and passes here; the box proof with
--save-console and popular.py --apply are where its log is judged.
"""
import argparse
import glob
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "tools", "re"))
import ff_extract  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
MANIFESTS = os.path.join(HERE, "manifests")
ART_RX = re.compile(r"load|preview|menu|background|splash|title|logo", re.I)
LOADSCREEN_RX = re.compile(rb"loadscreen_[A-Za-z0-9_]{2,60}")
CLIENT_RISK_MB = 110


def check(bsp):
    d = os.path.join(MODS, bsp)
    # listdir + lower(), not glob("*.ff"): glob is case-sensitive off Windows (`.FF`).
    names = sorted(os.listdir(d)) if os.path.isdir(d) else []
    ffs = {f.lower(): os.path.join(d, f) for f in names if f.lower().endswith(".ff")}
    iwds = [os.path.join(d, f) for f in names if f.lower().endswith(".iwd")]
    out = {"map": bsp, "has_load_ff": bsp + "_load.ff" in ffs,
           "has_patch_ff": bsp + "_patch.ff" in ffs, "addon_iwds": [], "napalmblob": [],
           "art": {"loadscreen_materials": [], "iwd_images": []}, "flags": []}
    zone_mb = None
    loads = set()
    for name, p in ffs.items():
        try:
            z = ff_extract.inflate_zone(p)
        except Exception as exc:
            out.setdefault("errors", []).append("%s: %s" % (name, exc))
            continue
        if name == bsp + ".ff":
            zone_mb = round(len(z) / 2**20, 1)
        for m in LOADSCREEN_RX.findall(z):
            loads.add(m.decode())
        if b"napalmblob" in z:
            out["napalmblob"].append(name)
    out["map_zone_inflated_mb"] = zone_mb
    # The map's own loadscreen is `loadscreen_<bsp>` by the mod-tools convention; the
    # rest (`loadscreen_mak`, `_locked`, `_template`) ride in on the shared script set.
    own_ls = [x for x in loads if x.lower() == "loadscreen_" + bsp.lower()]
    out["art"]["loadscreen"] = own_ls[0] if own_ls else None
    out["art"]["loadscreen_materials"] = sorted(loads)[:12]
    own = {bsp.lower()}
    for p in iwds:
        stem = os.path.splitext(os.path.basename(p))[0].lower()
        try:
            zf = zipfile.ZipFile(p)
            names = zf.namelist()
        except Exception as exc:
            out.setdefault("errors", []).append("%s: %s" % (os.path.basename(p), exc))
            continue
        scripts = [n for n in names if n.lower().endswith((".gsc", ".csc"))]
        for n in scripts:
            try:
                if b"napalmblob" in zf.read(n):
                    out["napalmblob"].append("%s:%s" % (os.path.basename(p), n))
            except Exception:
                pass
        for n in names:
            if n.lower().startswith("images/") and ART_RX.search(os.path.basename(n)):
                out["art"]["iwd_images"].append("%s:%s" % (os.path.basename(p), n))
        if stem not in own and not stem.startswith(bsp.lower()):
            out["addon_iwds"].append({"file": os.path.basename(p), "entries": len(names),
                                      "scripts": len(scripts),
                                      "bytes": os.path.getsize(p)})
    out["art"]["iwd_images"] = out["art"]["iwd_images"][:20]
    if zone_mb and zone_mb >= CLIENT_RISK_MB:
        out["flags"].append("client_memory_risk")
    # NOT a flag: measured 2026-09-22 on 9 maps, the string `napalmblob` is in EVERY
    # map zone (the community loadout script set), including fear_mc_2 which passes
    # five gates. It predicts nothing; it stays recorded for Leviathan-shaped reading.
    if not out["has_patch_ff"]:
        out["flags"].append("no_patch_ff")
    if any(a["scripts"] for a in out["addon_iwds"]):
        out["flags"].append("addon_iwd_with_scripts")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--write-manifest", action="store_true")
    ap.add_argument("--gate", action="store_true", help="refuse (exit 1) a map the asset gate blocks")
    a = ap.parse_args()
    path = os.path.join(WORK, "reports", "precheck.json")
    rep = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    for bsp in a.map:
        r = check(bsp)
        rep[bsp] = r
        print("%-26s zone=%6s MB  addons=%d  flags=%s  loadscreens=%s"
              % (bsp, r["map_zone_inflated_mb"], len(r["addon_iwds"]), ",".join(r["flags"]) or "-",
                 ",".join(r["art"]["loadscreen_materials"][:3]) or "-"))
        mf = os.path.join(MANIFESTS, bsp + ".json")
        if a.write_manifest and os.path.exists(mf):
            m = json.load(open(mf, encoding="utf-8"))
            m.setdefault("archive", {})["art"] = r["art"]
            m["precheck"] = {k: r[k] for k in ("map_zone_inflated_mb", "addon_iwds", "flags",
                                               "has_load_ff", "has_patch_ff", "napalmblob")}
            with open(mf, "w", encoding="utf-8") as fh:
                json.dump(m, fh, indent=2)
    blocked = []
    if a.gate and a.map:
        sys.path.insert(0, HERE)
        import asset_gate
        for bsp, (ok, v, why) in asset_gate.gate_many(a.map, allow_unproven=True,
                                                      write_manifest=a.write_manifest).items():
            rep.setdefault(bsp, {})["asset_gate"] = {"ok": ok, "verdict": v, "why": why}
            print("%-26s asset gate: %s %s -- %s" % (bsp, "PASS" if ok else "BLOCK", v, why))
            if not ok:
                blocked.append(bsp)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=1)
    if blocked:
        sys.exit("asset gate refused: %s (archive.md 13)" % ", ".join(blocked))


if __name__ == "__main__":
    main()
