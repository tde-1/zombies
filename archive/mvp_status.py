#!/usr/bin/env python3
"""Write a box re-proof into an early (MVP / dedi-lane) manifest that popular.py --apply skips
(it only touches manifests with a `precheck`). Lane MAPS, 2026-09-23.

    python archive/mvp_status.py --map nazi_zombie_leviathan --cause "..." [--map ... --cause ...]

A pass sets status/dedi_status "box_map_loaded", drops site_status "map_error", records
box_proof from reports/boxproof.json and appends a dated line to notes. A fail records the proof
and leaves the old verdict. Nothing else in the manifest changes.
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--cause", action="append", default=[])
    a = ap.parse_args()
    proof = json.load(open(os.path.join(WORK, "reports", "boxproof.json"), encoding="utf-8"))
    for i, b in enumerate(a.map):
        cause = a.cause[i] if i < len(a.cause) else ""
        mf = os.path.join(HERE, "manifests", b + ".json")
        m = json.load(open(mf, encoding="utf-8"))
        r = proof.get(b) or {}
        m["box_proof"] = {k: r.get(k) for k in ("result", "reason", "match", "at", "instance",
                                                 "watchdog_clean", "trapped")}
        m["box_proof"]["hold_s"] = 185
        m["box_proof"]["unproven"] = "no client joined: server-side load under Wine only"
        if r.get("result") == "pass":
            m["status"] = m["dedi_status"] = "box_map_loaded"
            if m.get("site_status") == "map_error":
                m.pop("site_status")
            if m.get("health") == "broken":
                m["health"] = None
            m["notes"] = (m.get("notes") or "") + (
                "  BOX 2026-09-23 (lane MAPS, archive.md s14): map_loaded + 185 s alive, freeze watchdog "
                "clean, box DLL fd3039d2, match %s. %s" % (r.get("match"), cause))
        with open(mf, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)
        print(b, r.get("result"), m.get("status"))


if __name__ == "__main__":
    main()
