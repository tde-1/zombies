#!/usr/bin/env python3
"""The asset gate (archive.md 13, 2026-09-23): no map goes on the site's list while a player
would meet a missing zombie model, box/wall weapon or script on it.

    python archive/asset_gate.py --map <bsp> [--map ...]        # fresh audit of these maps
    python archive/asset_gate.py --map <bsp> --allow-unproven   # no console log is not a refusal
    python archive/asset_gate.py --map <bsp> --from-manifest    # the recorded verdict, no audit

Exit 0 = every map passes (verdict clean or minor), 1 = at least one is blocked (hide / fix /
patch), 2 = none blocked but at least one has no console log to judge (unproven).

Where it is enforced:
  * `popular.py --apply` (the step that un-hides a tranche after its box proof) keeps a map
    hidden, with `site_hidden_reason`, unless gate() passes;
  * `precheck.py --gate` refuses (exit 1) a map whose zones already show a blocking miss;
  * `web/server/lib/assetgate.js`: import-archive.js forces `hidden` for a manifest whose
    `asset_audit.verdict` blocks, whatever `site_hidden` says.
The verdicts themselves are archive/asset_audit.py's (visible vs minor, ours vs release).
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_audit  # noqa: E402

PASS = {"clean", "minor"}
BLOCK = {"hide", "fix", "patch"}


def gate_many(bsps, allow_unproven=False, from_manifest=False, write_manifest=True):
    """-> {bsp: (ok, verdict, why)}. A fresh audit (logs + zones) unless from_manifest; the
    verdict is written back into the manifest's `asset_audit` so the importer sees it."""
    out = {}
    if from_manifest:
        for b in bsps:
            mf = os.path.join(asset_audit.MANIFESTS, b + ".json")
            m = json.load(open(mf, encoding="utf-8")) if os.path.exists(mf) else {}
            a = m.get("asset_audit") or {}
            out[b] = judge(a.get("verdict", "unproven"), a.get("visible_names", []), allow_unproven)
        return out
    rep = asset_audit.audit(bsps, trace=True)
    for b in bsps:
        m = rep["maps"].get(b.lower())
        if not m:
            out[b] = (False, "not_hosted", "no site row with an fs_game for %s" % b)
            continue
        out[b] = judge(m["verdict"], m["visible_names"], allow_unproven)
    if write_manifest:
        asset_audit.write_manifests({"at": rep["at"], "maps": {b.lower(): rep["maps"][b.lower()]
                                                                for b in bsps if b.lower() in rep["maps"]}}, set())
    return out


def judge(verdict, names, allow_unproven):
    if verdict in PASS:
        return True, verdict, "nothing a player meets is missing"
    if verdict == "unproven":
        return (allow_unproven, verdict,
                "no console log of this map loading: box_proof.py --save-console, then re-run")
    return False, verdict, "missing: " + ", ".join(names[:6])


def gate(bsp, **kw):
    return gate_many([bsp], **kw)[bsp]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[], required=True)
    ap.add_argument("--allow-unproven", action="store_true")
    ap.add_argument("--from-manifest", action="store_true")
    a = ap.parse_args()
    res = gate_many(a.map, allow_unproven=a.allow_unproven, from_manifest=a.from_manifest,
                    write_manifest=not a.from_manifest)
    rc = 0
    for b, (ok, v, why) in res.items():
        print("%-30s %-5s %-9s %s" % (b, "PASS" if ok else "BLOCK", v, why))
        if not ok:
            rc = max(rc, 2 if v == "unproven" else 1)
    if any(not ok and v != "unproven" for ok, v, _ in res.values()):
        rc = 1
    sys.exit(rc)


if __name__ == "__main__":
    main()
