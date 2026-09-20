#!/usr/bin/env python3
"""Run the referee's scanner over every normalised map and propose a manifest.

Step HOOK of the pipeline in vault 04 section 4. It does not re-implement any analysis:
it drives `referee/scan_map.py` and turns its verdict into a manifest in the
`referee/manifests/_schema.md` shape, plus the number this whole plan rests on --

    how often the scanner decides a real custom map on its own, and how often a human
    has to read the scripts.

The referee agent could only measure that on n=1 (`nazi_zombie_ali`). Every map here is
a fresh, unseen third-party map, so the ratio is a measurement.

### What happened when we measured it (2026-09-20, in this order)

  01:50  Against `scan_map.py` as it stood, on 14 real custom maps: **0/14 decided**,
         and 1/12 agreeing with the community's own finish tags. Twelve maps returned
         `manual` citing the same three names -- `arcademode_ending_complete`,
         `dog_round_ending`, `crawler_round_ending` -- none of which belong to the map.
         On a stock install the shared zombie scripts live in `common.ff`/`patch.ff`,
         which the scanner is never handed; a CUSTOM map ships its own copy of that
         whole set inside `mod.ff`, so Treyarch's names appear *inside the map*.
  02:20  Posted to the board with two fixes: subtract a baseline of stock names, and
         read the Radiant ENTITY list (Leviathan's whole easter egg is entity names;
         MW2 Rust's ending is a trigger called `end_game` and nothing in script).
  02:25  The referee agent rewrote `scan_map.py` to do both -- reading the baseline this
         agent generates (`archive/stock-baseline.json`) and taking an `ignore` set for
         corpus boilerplate.

So this driver no longer duplicates any of that. It supplies the two inputs their
scanner asks for and measures the result:

  * `baseline_path` -> `archive/stock-baseline.json` (built by `stock_baseline.py`)
  * `ignore`        -> names shared by >=60% of the corpus, via their own
                       `scan_map.corpus_common()`

and it adds one thing their scanner does not: a **shortlist of this map's own trigger
names** for whoever reads it next. Hint words only catch finishes whose author used our
vocabulary; ORBiT's quest is `keycards` / `orbitron_lock` / `planet1trig` and Minecraft
Village's is `gumball_*`. What is reliable is that a trigger no other map in the corpus
has is this map's own, so the manifest lists those and a human spends twenty seconds
instead of reading 150 scripts.

Manifests go to `archive/manifests/` (this agent's folder). They are proposals for the
referee agent, not a replacement for `referee/manifests/`.
"""

from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "referee"))
sys.path.insert(0, os.path.join(REPO, "tools", "re"))

import scan_map  # noqa: E402  the referee agent's tool, driven not modified
import stock_baseline  # noqa: E402
from lib import catalogue  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
ORIGINALS = os.path.join(WORK, "originals")
OUT = os.path.join(HERE, "manifests")
BASELINE = os.path.join(HERE, "stock-baseline.json")

# A finish a human still has to adjudicate vs one the event stream can award alone.
# Easter eggs ALWAYS need a human: the scanner finds the state, but which combination
# means "done" is exactly the judgement `_schema.md` says must never be automated.
DECIDED = {"buyable_ending", "round"}
NEEDS_HUMAN = {"easter_egg", "manual"}

AUTO_ENT = re.compile(r"^(pf\d+_)?auto\d+$", re.I)
PERK_ENT = re.compile(r"vending", re.I)
CORPUS_FRACTION = 0.6


def provenance(norm):
    d = os.path.join(ORIGINALS, norm)
    if not os.path.isdir(d):
        return None
    for f in sorted(os.listdir(d)):
        if f.endswith(".meta.json"):
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                return json.load(fh)
    return None


def manifest_for(mapname, result, extract_entry, meta, db, extras):
    v = result["verdict"]["finish"]
    finishes = []
    if v == "easter_egg":
        finishes.append({
            "id": "easter_egg", "label": "Easter Egg", "priority": 1,
            # The schema's honest escape hatch. Never awards automatically.
            "when": {"manual": True},
            "candidates": result["ee_candidates"],
        })
    if v == "buyable_ending":
        b = result.get("buyable_ending_candidate")
        if b:
            when = {"trigger_used": {"targetname": b["targetname"],
                                     "zombie_cost": b["zombie_cost"]}}
        else:
            # The generalised nazi_zombie_ali shape: one trigger_use named like an
            # ending, with the price hardcoded in script rather than on the entity.
            named = [n for n in result["ending_words"] if n in extras["trigger_names"]]
            target = (named or result["ending_words"] or ["end_game"])[0]
            when = {"trigger_used": {"targetname": target}}
        finishes.append({"id": "buyable_ending", "label": "Buyable Ending",
                         "priority": 2, "when": when,
                         "candidates": result["ending_words"],
                         "hardcoded_costs": result.get("hardcoded_costs")})
    finishes.append({"id": "round", "label": "Round %d" % scan_map.DEFAULT_ROUND_N,
                     "priority": 3,
                     "when": {"round_at_least": scan_map.DEFAULT_ROUND_N}})
    main = v if v in ("easter_egg", "buyable_ending") else "round"

    tags, author, released, desc, src = [], None, None, None, None
    # Link to the catalogue by the ORIGINAL's normalised name, not by the bsp: a map's
    # bsp is often nothing like its title (`water` is Alcatraz, `nazi_zombie_test1` is
    # Zombie Desert, `ugx_artemovsk` is UGX Requiem).
    norm = (extract_entry or {}).get("norm") or catalogue.normalise(mapname)
    if db is not None:
        row = db.execute(
            "SELECT name,author,released,description,source_url,tags FROM maps "
            "WHERE norm=? ORDER BY (tags IS NULL), (author IS NULL), "
            "(description IS NULL) LIMIT 1", (norm,)).fetchone()
        if row:
            author, released, desc, src = (row["author"], row["released"],
                                           row["description"], row["source_url"])
        for r2 in db.execute("SELECT tags,author,description FROM maps WHERE norm=?",
                             (norm,)):
            for t in json.loads(r2["tags"] or "[]"):
                if t not in tags:
                    tags.append(t)
            author = author or r2["author"]
            desc = desc or r2["description"]

    m = {
        "schema": "enw.referee.manifest/0",
        "map": mapname,
        "title": (meta or {}).get("map") or mapname,
        "source": "custom",
        "author": author,
        "released": released,
        "fs_game": "mods/" + mapname,
        "script_fingerprints": extras["fingerprints"],
        "badge": {"main_finish": main, "round_n": scan_map.DEFAULT_ROUND_N},
        "finishes": finishes,
        "signals": [],
        "confidence": "guess" if v in NEEDS_HUMAN else "read",
        "needs_human": v in NEEDS_HUMAN,
        "health": None,      # nothing here has been booted yet; that is dedi's call
        "scanner": {
            "tool": "referee/scan_map.py",
            "verdict": v,
            "why": result["verdict"]["why"],
            "verdict_stock_baseline_only": extras["verdict_no_ignore"],
            "scripts": result["scripts"],
            "script_count": extras["script_count"],
            "entities": result["entities"],
            "ee_candidates": result["ee_candidates"],
            "ending_words": result["ending_words"],
            "hardcoded_costs": result.get("hardcoded_costs"),
            "orphan_end_triggers": result["orphan_end_triggers"],
            "top_costs": result["top_costs"],
            "buyable_ending_candidate": result["buyable_ending_candidate"],
            "common_script_overrides": result["common_script_overrides"],
            "zombiemode_sha256": result["zombiemode_sha256"],
            "map_specific_triggers": extras["map_specific_triggers"],
            "baseline": {
                "stock_names": extras["stock_names"],
                "corpus_ignored": extras["corpus_ignored"],
                "note": ("A name counts as this map's own only if it is absent from "
                         "WaW's own zone files AND from the boilerplate shared by most "
                         "maps in the corpus. Built by archive/stock_baseline.py and "
                         "fed to scan_map.scan(baseline_path=..., ignore=...)."),
            },
        },
        "archive": {
            "original": (meta or {}).get("file"),
            "original_sha256": (meta or {}).get("sha256"),
            "original_size": (meta or {}).get("size"),
            "source_url": (meta or {}).get("download_url"),
            "source_page": (meta or {}).get("source_page") or src,
            "fetched": (meta or {}).get("fetched"),
            "av": ((meta or {}).get("av") or {}).get("result"),
            "av_ran": ((meta or {}).get("av") or {}).get("ran"),
            "installer_kind": (extract_entry or {}).get("installer_kind"),
            "shipped_executables": (extract_entry or {}).get("executables", []),
            "catalogue_tags": tags,
            "catalogue_description": (desc or "")[:1500] or None,
        },
        "notes": "",
    }
    if result["common_script_overrides"]:
        m["notes"] += ("Replaces common scripts (%s); re-verify the generic "
                       "down/revive/score events on it. "
                       % ", ".join(result["common_script_overrides"]))
    if (extract_entry or {}).get("executables"):
        m["notes"] += ("Ships %d executable(s): %s. NEVER RUN THEM (dev-box.md rule 3). "
                       % (len(extract_entry["executables"]),
                          ", ".join(extract_entry["executables"][:6])))
    if v == "easter_egg":
        m["notes"] += ("The scanner found easter-egg state; WHICH combination means done "
                       "is a human's call, so the finish is {\"manual\": true} and the "
                       "Round %d fallback applies meanwhile. " % scan_map.DEFAULT_ROUND_N)
    if v == "round" and extras["map_specific_triggers"]:
        m["notes"] += ("No finish found by name. Before accepting Round %d, someone "
                       "should glance at this map's own triggers: %s. "
                       % (scan_map.DEFAULT_ROUND_N,
                          ", ".join(extras["map_specific_triggers"][:12])))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mods", default=MODS)
    ap.add_argument("--corpus-fraction", type=float, default=CORPUS_FRACTION)
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

    if not os.path.exists(BASELINE):
        with open(BASELINE, "w", encoding="utf-8") as fh:
            json.dump(stock_baseline.build(), fh, indent=1)
    base = json.load(open(BASELINE, encoding="utf-8"))
    stock_ents = set(base.get("entity_names", []))
    n_stock = len(set(base["flags"]) | set(base["notifies"]) | stock_ents)
    print("stock baseline: %d names from %d zones" % (n_stock, len(base["zones"])))

    # ---------------------------------------------------- pass 1: stock baseline only
    maps = []
    for mapname in sorted(os.listdir(a.mods)) if os.path.isdir(a.mods) else []:
        d = os.path.join(a.mods, mapname)
        if not os.path.isdir(d):
            continue
        ffs = sorted(glob.glob(os.path.join(d, "**", "*.ff"), recursive=True))
        iwds = sorted(glob.glob(os.path.join(d, "**", "*.iwd"), recursive=True))
        if not ffs and not iwds:
            continue
        try:
            res = scan_map.scan(ffs, iwds, baseline_path=BASELINE)
            scripts = scan_map.read_scripts(ffs, iwds)
        except Exception as exc:
            print("%-24s SCANNER ERROR %s" % (mapname, exc))
            continue
        trigger_names = set()
        for e in scan_map.read_mapents(ffs):
            if e.get("classname", "").startswith("trigger") and e.get("targetname"):
                trigger_names.add(e["targetname"])
        fps = {}
        for name, (text, src) in sorted(scripts.items()):
            if name.endswith("_zombiemode.gsc"):
                fps["%s@%s" % (name, src)] = hashlib.sha256(
                    text.encode("latin-1")).hexdigest()
        maps.append({"map": mapname, "res1": res, "ffs": ffs, "iwds": iwds,
                     "trigger_names": trigger_names, "fingerprints": fps,
                     "script_count": len(scripts),
                     "own": (set(res["own_flags"]) | set(res["own_notifies"])
                             | set(res["own_entity_names"]) | trigger_names)})

    # ------------------------------------------- corpus boilerplate, their own rule
    ignore = scan_map.corpus_common([m["own"] for m in maps], a.corpus_fraction)
    print("corpus ignore: %d names shared by >=%.0f%% of %d maps"
          % (len(ignore), 100 * a.corpus_fraction, len(maps)))

    # ------------------------------------------------------ pass 2: final verdicts
    rows = []
    for m in maps:
        res = scan_map.scan(m["ffs"], m["iwds"], baseline_path=BASELINE, ignore=ignore)
        mapname = m["map"]
        ee = extract_report.get(mapname)
        meta = provenance(ee["norm"]) if ee else None
        extras = {
            "fingerprints": m["fingerprints"],
            "script_count": m["script_count"],
            "trigger_names": m["trigger_names"],
            "verdict_no_ignore": m["res1"]["verdict"]["finish"],
            "stock_names": n_stock,
            "corpus_ignored": len(ignore),
            "map_specific_triggers": sorted(
                n for n in m["trigger_names"]
                if n not in ignore and not AUTO_ENT.match(n) and not PERK_ENT.search(n)
                and n not in stock_ents)[:40],
        }
        man = manifest_for(mapname, res, ee, meta, db, extras)
        with open(os.path.join(OUT, mapname + ".json"), "w", encoding="utf-8") as fh:
            json.dump(man, fh, indent=2)
        v = res["verdict"]["finish"]
        rows.append({"map": mapname, "verdict": v,
                     "verdict_stock_only": extras["verdict_no_ignore"],
                     "why": res["verdict"]["why"],
                     "decided": v in DECIDED, "needs_human": v in NEEDS_HUMAN,
                     "scripts": res["scripts"], "entities": res["entities"],
                     "ee_candidates": res["ee_candidates"],
                     "ending_words": res["ending_words"],
                     "hardcoded_costs": res.get("hardcoded_costs"),
                     "buyable": res["buyable_ending_candidate"],
                     "map_specific_triggers": extras["map_specific_triggers"],
                     "top_costs": res["top_costs"]})
        print("%-22s stock-only=%-15s final=%-15s %s"
              % (mapname, extras["verdict_no_ignore"], v, res["verdict"]["why"][:52]))

    n = len(rows)
    dec = [r for r in rows if r["decided"]]
    finish = [r for r in rows if r["verdict"] in ("easter_egg", "buyable_ending")]
    print("")
    print("%d maps: %d have a finish identified, %d need no human judgement to award"
          % (n, len(finish), len(dec)))
    # Pin the measurement to the exact tool version: the referee agent is iterating on
    # scan_map.py tonight, and a ratio without the version it was measured against is
    # not a measurement.
    sm = os.path.join(REPO, "referee", "scan_map.py")
    tool = {"path": "referee/scan_map.py",
            "sha256": hashlib.sha256(open(sm, "rb").read()).hexdigest(),
            "size": os.path.getsize(sm),
            "mtime": __import__("datetime").datetime.fromtimestamp(
                os.path.getmtime(sm)).isoformat(timespec="seconds")}
    print("measured against %s sha256 %s (%s)"
          % (tool["path"], tool["sha256"][:12], tool["mtime"]))
    summary = {
        "maps": n,
        "tool": tool,
        "decided": len(dec),
        "finish_found": len(finish),
        "needs_human": n - len(dec),
        "verdicts": dict(collections.Counter(r["verdict"] for r in rows)),
        "verdicts_stock_only": dict(collections.Counter(
            r["verdict_stock_only"] for r in rows)),
        "stock_names": n_stock,
        "corpus_ignored": sorted(ignore)[:100],
        "corpus_ignored_n": len(ignore),
        "rows": rows,
        "history": {
            "before_referee_update": {
                "when": "2026-09-20T01:50Z",
                "maps": 14, "decided": 0, "agreed_with_community_tags": "1/12",
                "note": ("measured against scan_map.py BEFORE the referee agent added "
                         "the stock baseline, token matching and entity names at 02:25"),
            },
        },
    }
    with open(os.path.join(WORK, "reports", "scan.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)


if __name__ == "__main__":
    main()
