#!/usr/bin/env python3
"""Run the referee's scanner over every normalised map and propose a manifest.

This is step HOOK of the pipeline in vault 04 section 4. It does not re-implement any
analysis: it imports `referee/scan_map.py` as written and validated by the referee agent
(20/20 on everything reachable locally) and turns its verdict into a manifest in the
`referee/manifests/_schema.md` shape, plus the one number this whole plan rests on --

    how often the scanner decides a real custom map on its own, and how often a human
    has to read the scripts.

The referee agent could only measure that on n=1 real custom map (`nazi_zombie_ali`).
Every map here is a fresh, unseen third-party map, so the ratio is a measurement rather
than an estimate.

Classification, and why:
  decided    `buyable_ending` -- the scanner found one purchase trigger that is a wild
             cost outlier, which is a fact about the entity list, not a guess; and
             `round` -- it found no easter egg and no ending, so the Round-N default
             applies and there is nothing for a human to decide.
  needs_human `easter_egg` -- the scanner finds the FLAGS but cannot know which
             combination means "done", which is exactly the judgement call the schema
             says must not be automated; and `manual` -- names suggest an ending but
             nothing is decidable.
  not_a_map  the gate says nothing here loads _zombiemode.

Manifests are written to archive/manifests/ (this agent's own folder). They are
proposals for the referee agent, not a replacement for referee/manifests/.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "referee"))
sys.path.insert(0, os.path.join(REPO, "tools", "re"))

import scan_map  # noqa: E402  the referee agent's tool, used as-is
from lib import catalogue  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
ORIGINALS = os.path.join(WORK, "originals")
OUT = os.path.join(HERE, "manifests")

DECIDED = {"buyable_ending", "round"}
NEEDS_HUMAN = {"easter_egg", "manual"}


def provenance(norm):
    d = os.path.join(ORIGINALS, norm)
    if not os.path.isdir(d):
        return None
    for f in sorted(os.listdir(d)):
        if f.endswith(".meta.json"):
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                return json.load(fh)
    return None


def manifest_for(mapname, result, extract_entry, meta, db):
    """Turn a scan result into the referee manifest shape."""
    v = result["verdict"]["finish"]
    finishes = []
    if v == "buyable_ending" and result.get("buyable_ending_candidate"):
        b = result["buyable_ending_candidate"]
        finishes.append({
            "id": "buyable_ending", "label": "Buyable Ending", "priority": 2,
            "when": {"trigger_used": {"targetname": b["targetname"],
                                      "zombie_cost": b["zombie_cost"]}},
        })
    if v == "easter_egg":
        finishes.append({
            "id": "easter_egg", "label": "Easter Egg", "priority": 1,
            # Honest: the schema's escape hatch. The scanner found the flags; which
            # combination means "done" is a human judgement and must not auto-award.
            "when": {"manual": True},
            "candidate_flags": result["ee_candidates"],
        })
    finishes.append({"id": "round", "label": "Round %d" % scan_map.DEFAULT_ROUND_N,
                     "priority": 3,
                     "when": {"round_at_least": scan_map.DEFAULT_ROUND_N}})
    main = "buyable_ending" if v == "buyable_ending" else (
        "easter_egg" if v == "easter_egg" else "round")

    tags, author, released, desc, src = [], None, None, None, None
    if db is not None:
        row = db.execute(
            "SELECT name,author,released,description,source_url,tags FROM maps "
            "WHERE norm=? AND (author IS NOT NULL OR description IS NOT NULL) LIMIT 1",
            (catalogue.normalise(mapname.replace("nazi_zombie_", "")),)).fetchone()
        if row:
            author, released, desc, src = (row["author"], row["released"],
                                           row["description"], row["source_url"])
            tags = json.loads(row["tags"] or "[]")

    m = {
        "schema": "enw.referee.manifest/0",
        "map": mapname,
        "title": (meta or {}).get("map") or mapname,
        "source": "custom",
        "author": author,
        "released": released,
        "fs_game": "mods/" + mapname,
        "script_fingerprints": {},
        "badge": {"main_finish": main, "round_n": scan_map.DEFAULT_ROUND_N},
        "finishes": finishes,
        "signals": [],
        "confidence": "guess" if v in NEEDS_HUMAN else "read",
        "needs_human": v in NEEDS_HUMAN,
        "scanner": {
            "verdict": v,
            "why": result["verdict"]["why"],
            "scripts": result["scripts"],
            "entities": result["entities"],
            "ee_candidates": result["ee_candidates"],
            "ending_words": result["ending_words"],
            "orphan_end_triggers": result["orphan_end_triggers"],
            "top_costs": result["top_costs"],
            "common_script_overrides": result["common_script_overrides"],
            "zombiemode_sha256": result["zombiemode_sha256"],
        },
        "archive": {
            "original": (meta or {}).get("file"),
            "original_sha256": (meta or {}).get("sha256"),
            "original_size": (meta or {}).get("size"),
            "source_url": (meta or {}).get("download_url"),
            "source_page": (meta or {}).get("source_page") or src,
            "fetched": (meta or {}).get("fetched"),
            "av": ((meta or {}).get("av") or {}).get("result"),
            "installer_kind": (extract_entry or {}).get("installer_kind"),
            "shipped_executables": (extract_entry or {}).get("executables", []),
            "catalogue_tags": tags,
            "catalogue_description": (desc or "")[:1500] or None,
        },
        "notes": "",
    }
    if result["common_script_overrides"]:
        m["notes"] += ("This map replaces common scripts (%s); re-verify the generic "
                       "down/revive/score events on it. "
                       % ", ".join(result["common_script_overrides"]))
    if (extract_entry or {}).get("executables"):
        m["notes"] += ("Ships %d executable(s): %s. NEVER RUN THEM (dev-box.md rule 3). "
                       % (len(extract_entry["executables"]),
                          ", ".join(extract_entry["executables"][:6])))
    if v == "easter_egg":
        m["notes"] += ("Scanner found easter-egg-looking flags but cannot know which "
                       "combination means done; a human must read the scripts. The "
                       "Round %d fallback still applies meanwhile. "
                       % scan_map.DEFAULT_ROUND_N)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mods", default=MODS)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    try:
        db = catalogue.connect()
    except Exception:
        db = None
    extract_report = {}
    p = os.path.join(WORK, "reports", "extract.json")
    if os.path.exists(p):
        for e in json.load(open(p, encoding="utf-8")):
            for mm in e.get("mods", []):
                extract_report[mm["map"]] = e

    rows = []
    for mapname in sorted(os.listdir(a.mods)) if os.path.isdir(a.mods) else []:
        d = os.path.join(a.mods, mapname)
        if not os.path.isdir(d):
            continue
        ffs = sorted(glob.glob(os.path.join(d, "**", "*.ff"), recursive=True))
        iwds = sorted(glob.glob(os.path.join(d, "**", "*.iwd"), recursive=True))
        if not ffs and not iwds:
            continue
        try:
            res = scan_map.scan(ffs, iwds)
        except Exception as exc:
            rows.append({"map": mapname, "verdict": "scanner error",
                         "why": "%s: %s" % (exc.__class__.__name__, exc)})
            print("%-28s SCANNER ERROR %s" % (mapname, exc))
            continue
        ee = extract_report.get(mapname)
        meta = provenance(ee["norm"]) if ee else None
        man = manifest_for(mapname, res, ee, meta, db)
        # fingerprints of the scripts as actually loaded
        fps = {}
        try:
            import hashlib
            scripts = scan_map.read_scripts(ffs, iwds)
            for name, (text, src) in sorted(scripts.items()):
                if name in ("maps/_zombiemode.gsc",) or name.endswith("_zombiemode.gsc"):
                    fps["%s@%s" % (name, src)] = hashlib.sha256(
                        text.encode("latin-1")).hexdigest()
            man["script_fingerprints"] = fps
            man["scanner"]["script_count"] = len(scripts)
        except Exception:
            pass
        with open(os.path.join(OUT, mapname + ".json"), "w", encoding="utf-8") as fh:
            json.dump(man, fh, indent=2)
        v = res["verdict"]["finish"]
        rows.append({"map": mapname, "verdict": v,
                     "decided": v in DECIDED, "needs_human": v in NEEDS_HUMAN,
                     "scripts": res["scripts"], "entities": res["entities"],
                     "ee_candidates": res["ee_candidates"],
                     "buyable": res["buyable_ending_candidate"],
                     "why": res["verdict"]["why"]})
        print("%-28s %-18s scripts=%-4d ents=%-5d %s"
              % (mapname, v, res["scripts"], res["entities"], res["verdict"]["why"][:70]))

    real = [r for r in rows if r.get("verdict") in DECIDED | NEEDS_HUMAN]
    dec = [r for r in real if r["decided"]]
    print("\nscanner on %d real custom maps: %d decided without a human, %d need one"
          % (len(real), len(dec), len(real) - len(dec)))
    with open(os.path.join(WORK, "reports", "scan.json"), "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2)


if __name__ == "__main__":
    main()
