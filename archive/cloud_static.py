#!/usr/bin/env python3
"""Static checks for ONE freshly extracted map, run by cloud_pipeline.py on Linux.

    CLOUD_STATIC=/path/to/archive/cloud_static.py   (or --static <same>)
    archive/cloud_static.py <norm> <bsp>

Called after extract.process() and before the upload deletes the tree, with the map at
$ENW_ARCHIVE_WORK/mods/<bsp> and the release at $ENW_ARCHIVE_WORK/extract/<norm>. Reads
files only; nothing that came with a map is ever executed.

Steps (each isolated: one failing records its error and the rest still run):
  scan      referee/scan_map.py via scan_maps.pass1/manifest_for -> the proposed manifest.
            Corpus boilerplate comes from archive/corpus-ignore.json, which a full
            scan_maps.py pass writes; without it the verdict is stock-baseline only and
            the manifest says so.
  precheck  precheck.check(): zone size, add-on IWDs, _patch/_load, loadscreen art.
  modes     scan_modes: a pre-game vote/menu (UGX or other).
  assets    asset_audit/asset_gate need OAT Unlinker.exe, the site DB and a box console
            log -- none exist here, so it is recorded `unproven`, never `clean`.

Writes archive/manifests/<bsp>.json only when no manifest of that name exists (B's
hand-edited ones are never touched). Prints one compact JSON line (cloud_pipeline keeps
the last 400 characters of stdout). Exit 0 unless the map folder is missing.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import extract  # noqa: E402
import precheck  # noqa: E402
import scan_maps  # noqa: E402
import scan_modes  # noqa: E402

ASSETS_UNPROVEN = ("needs OAT Unlinker.exe (Windows), the site DB and a box console log")


def load_ignore():
    try:
        with open(scan_maps.CORPUS_IGNORE, encoding="utf-8") as fh:
            return set(json.load(fh)["names"]), True
    except Exception:
        return set(), False


def extract_entry(norm, bsp):
    """The extract.json row for this map if one exists; else rebuilt from disk the way
    extract.process() builds it (cloud_pipeline merges the report only after us)."""
    p = os.path.join(scan_maps.WORK, "reports", "extract.json")
    try:
        for e in json.load(open(p, encoding="utf-8")):
            if e.get("norm") == norm and any(m.get("map") == bsp for m in e.get("mods", [])):
                return e
    except Exception:
        pass
    e = {"norm": norm, "installer_kind": None, "executables": []}
    od = os.path.join(scan_maps.ORIGINALS, norm)
    if os.path.isdir(od):
        for f in sorted(os.listdir(od)):
            if not f.endswith(".meta.json"):
                e["installer_kind"] = extract.fingerprint(os.path.join(od, f))
                break
    exdir = os.path.join(extract.EXTRACT, norm)
    if os.path.isdir(exdir):
        e["executables"] = sorted(
            os.path.relpath(p, exdir).replace("\\", "/") for p in extract.walk(exdir)
            if p.lower().endswith((".exe", ".dll", ".bat", ".cmd", ".ps1", ".scr", ".msi")))
    return e


def main(argv):
    if len(argv) != 2:
        sys.exit("usage: cloud_static.py <norm> <bsp>")
    norm, bsp = argv
    t0 = time.time()
    d = os.path.join(scan_maps.MODS, bsp)
    out = {"bsp": bsp, "errors": []}
    if not os.path.isdir(d):
        out["errors"].append("no map folder %s" % d)
        print(json.dumps(out))
        return 1
    man, secs = None, {}

    # ------------------------------------------------------------------ scan
    t = time.time()
    try:
        base = json.load(open(scan_maps.BASELINE, encoding="utf-8"))
        stock_ents = set(base.get("entity_names", []))
        n_stock = len(set(base["flags"]) | set(base["notifies"]) | stock_ents)
        ignore, have_ignore = load_ignore()
        m = scan_maps.pass1(bsp, d)
        if m is None:
            out["errors"].append("scan: no .ff/.iwd")
        else:
            res = (scan_maps.scan_map.scan(m["ffs"], m["iwds"], baseline_path=scan_maps.BASELINE,
                                           ignore=ignore) if ignore else m["res1"])
            try:
                db = scan_maps.catalogue.connect()
            except Exception:
                db = None
            ee = extract_entry(norm, bsp)
            man = scan_maps.manifest_for(bsp, res, ee, scan_maps.provenance(norm), db,
                                         scan_maps.extras_for(m, ignore, n_stock, stock_ents))
            if not have_ignore and res["verdict"]["finish"] != "round":
                # Subtracting corpus boilerplate only ever REMOVES names, so a `round`
                # verdict stands; an ending/egg may be boilerplate (46 of 232 were:
                # `crawler_round_ending` et al.). Provisional until a corpus pass.
                man["needs_human"] = True
                man["confidence"] = "guess"
                man["notes"] += ("PROVISIONAL: archive/corpus-ignore.json was missing, so "
                                 "corpus boilerplate was not subtracted and this finish may be "
                                 "a shared-script name; scan_maps.py --keep-existing rewrites "
                                 "this manifest. ")
            man["scanner"]["run"] = {"tool": "archive/cloud_static.py", "corpus_ignore": have_ignore,
                                     "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            out["verdict"] = res["verdict"]["finish"]
            out["human"] = man["needs_human"]
            if not have_ignore:
                out["ignore"] = "missing"
    except Exception as exc:
        out["errors"].append("scan: %s" % exc)
    secs["scan"] = round(time.time() - t, 1)

    # -------------------------------------------------------------- precheck
    t = time.time()
    pc = None
    try:
        precheck.MODS = scan_maps.MODS
        pc = precheck.check(bsp)
        out["zone_mb"] = pc["map_zone_inflated_mb"]
        # A release whose map zone is missing (only mod.ff) cannot load; precheck.py
        # records has_load_ff/has_patch_ff but not this, so it is added here.
        if not any(f.lower() == bsp.lower() + ".ff" for f in os.listdir(d)):
            pc["flags"].append("no_map_ff")
        out["flags"] = pc["flags"]
        for e in pc.get("errors", []):
            out["errors"].append("precheck: %s" % e)
    except Exception as exc:
        out["errors"].append("precheck: %s" % exc)
    secs["precheck"] = round(time.time() - t, 1)

    # ----------------------------------------------------------------- modes
    t = time.time()
    modes = None
    try:
        scripts = scan_modes.read_scripts(d)
        ugx = scan_modes.ugx_entry(scripts)
        oth = scan_modes.other_menus(scripts, bsp)
        modes = {"ugx": ugx, "other": oth}
        out["modes"] = "ugx" if ugx else ("other" if oth else "-")
    except Exception as exc:
        out["errors"].append("modes: %s" % exc)
    secs["modes"] = round(time.time() - t, 1)

    out["assets"] = "unproven: " + ASSETS_UNPROVEN

    # -------------------------------------------------------------- manifest
    if man is not None:
        if pc is not None:
            man.setdefault("archive", {})["art"] = pc["art"]
            man["precheck"] = {k: pc[k] for k in ("map_zone_inflated_mb", "addon_iwds", "flags",
                                                  "has_load_ff", "has_patch_ff", "napalmblob")}
        if modes is not None and (modes["ugx"] or modes["other"]):
            man["modes"] = modes
        man["asset_audit"] = {"verdict": "unproven", "why": ASSETS_UNPROVEN,
                              "tool": "archive/cloud_static.py"}
        # hidden until a box proof un-hides it (popular.py --apply), like every tranche
        man.setdefault("site_hidden", True)
        man.setdefault("site_hidden_reason", "cloud archive run: not box-proven yet")
        mf = os.path.join(scan_maps.OUT, bsp + ".json")
        try:
            os.makedirs(scan_maps.OUT, exist_ok=True)
            # O_EXCL: never overwrite an existing manifest, even racing another worker.
            fd = os.open(mf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(man, fh, indent=2)
                fh.write("\n")
            out["manifest"] = "written"
        except FileExistsError:
            out["manifest"] = "exists"
        except Exception as exc:
            out["errors"].append("manifest: %s" % exc)
    out["s"] = secs
    out["t"] = round(time.time() - t0, 1)
    if not out["errors"]:
        del out["errors"]
    print(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
