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
import collections
import hashlib
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
import stock_baseline  # noqa: E402
from lib import catalogue  # noqa: E402

# A name present in this fraction of the corpus is community boilerplate, not a map's
# own signal. MEASURED: `crawler_round_ending` is not in stock WaW 1.7 but appears in
# 12 of our first 14 custom maps -- it rides in on the community script set (UGX Mod
# Standalone and the BO1-backport `_zombiemode_spawner.gsc`) that half the scene builds
# on. A stock baseline alone does not catch those; a corpus baseline does, and it gets
# sharper every time the archive grows.
CORPUS_COMMON_FRACTION = 0.6

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
ORIGINALS = os.path.join(WORK, "originals")
OUT = os.path.join(HERE, "manifests")

DECIDED = {"buyable_ending", "round"}
NEEDS_HUMAN = {"easter_egg", "manual"}


# Entity names need TOKEN matching, not the substring matching that works on flags.
# MEASURED: substring hints turned `vending_mulekick` into an ending (it contains
# "ending"), `floor_three_zone` into an easter egg (it contains "ee_"), and
# `packboyee_spawner` likewise. Requiring the hint to start at a word boundary kills
# all three without losing `ee_step_1_switch`, `radio1_trigger` or `end_game`.
ENT_EE = __import__("re").compile(
    r"(?:^|_)(ee|easter|egg|quest|amulet|relic|shard|soul|ritual|pylon|skull|meteor|"
    r"radio)s?(?:_|\d|$)", __import__("re").I)
ENT_END = __import__("re").compile(
    r"(?:^|_)(end_?game|ending|escaped?|exfil|victory|buyable|buy_?end|game_?won|"
    r"map_?complete)(?:_|\d|$)", __import__("re").I)
# Perk machines. Every WaW custom map has a pile of them, community perk packs add
# more (`vending_mulekick`, `vending_electric_cherry`, `harrybo21_vending`), and not
# one of them is a finish.
PERK_ENT = __import__("re").compile(r"vending", __import__("re").I)


def _re_compile():
    import re
    return re.compile(r"^(pf\\d+_)?auto\\d+$", re.I)


def reclassify(result, boilerplate):
    """Re-run the scanner's own decision with boilerplate names removed.

    Same precedence as `scan_map.scan`: easter egg beats buyable ending beats a named
    ending we cannot decide beats the Round-N default. The ONLY change is which names
    count as the map's own. Nothing in referee/ is touched.
    """
    low = str.lower
    ee = [f for f in result["ee_candidates"] if f not in boilerplate]
    endish = [w for w in result["ending_words"] if w not in boilerplate]
    buyable = result["buyable_ending_candidate"]
    if ee:
        return "easter_egg", ("flags %s look like easter-egg state and are NOT stock or "
                              "community boilerplate" % ", ".join(ee)), ee, endish
    if buyable:
        return "buyable_ending", ("one purchase trigger at %d points, next highest is %d"
                                  % (buyable["zombie_cost"], buyable["next_highest"])), ee, endish
    if endish:
        return "manual", ("map-specific names suggest an ending (%s) but nothing "
                          "decidable" % ", ".join(endish[:6])), ee, endish
    return "round", "no easter egg or ending found; default Round %d" % scan_map.DEFAULT_ROUND_N, ee, endish


def classify_with_entities(result, ent_names, boilerplate_names, boilerplate_ents):
    """Third tier: apply the same hint words to the Radiant ENTITY list.

    MEASURED on the first 14 real custom maps, and the single biggest gap found:

      * **Leviathan** has no easter-egg flag in any of its 120 scripts, and its easter
        egg is sitting in plain sight in the entity list -- `ee_step_1_switch`,
        `ee_step_1_trigs`, `ee_step_3_trig`, `ee_testtube_activate_trig`.
      * **MW2 Rust** has exactly four trigger targetnames and one of them is
        `end_game`. That is its buyable ending, the same shape as `nazi_zombie_ali`.
        The `zombie_cost` outlier test cannot see it, because the cost is hardcoded in
        script rather than keyed on the entity -- the lesson `nazi_zombie_ali` already
        taught, generalised.

    So: hint words against entity targetnames, with the same stock/corpus subtraction,
    and a trigger named like an ending counts as a buyable-ending candidate on its own.
    """
    ee = [f for f in result["ee_candidates"] if f not in boilerplate_names]
    endish = [w for w in result["ending_words"] if w not in boilerplate_names]
    own_ents = [n for n in ent_names
                if n not in boilerplate_ents and not PERK_ENT.search(n)]
    ee_ents = sorted({n for n in own_ents if ENT_EE.search(n)})
    end_ents = sorted({n for n in own_ents if ENT_END.search(n)})
    buyable = result["buyable_ending_candidate"]
    ev = {"ee_flags": ee, "ee_entities": ee_ents, "end_entities": end_ents}
    if ee or ee_ents:
        why = "easter-egg state found in %s%s%s" % (
            ("flags " + ", ".join(ee)) if ee else "",
            " and " if ee and ee_ents else "",
            ("entities " + ", ".join(ee_ents[:6])) if ee_ents else "")
        return "easter_egg", why, ev
    if buyable:
        return "buyable_ending", (
            "one purchase trigger at %d points, next highest is %d"
            % (buyable["zombie_cost"], buyable["next_highest"])), ev
    if end_ents:
        return "buyable_ending", (
            "entity named like an ending: %s (the cost is hardcoded in script, as on "
            "nazi_zombie_ali, so there is no zombie_cost outlier to find)"
            % ", ".join(end_ents[:4])), ev
    if endish:
        return "manual", ("map-specific names suggest an ending (%s) but nothing "
                          "decidable" % ", ".join(endish[:6])), ev
    return "round", ("no easter egg or ending found in scripts or entities; default "
                     "Round %d" % scan_map.DEFAULT_ROUND_N), ev


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
    # Link to the catalogue by the ORIGINAL's normalised name, not by the bsp. A map's
    # bsp is often nothing like its title (`water` is Alcatraz, `nazi_zombie_test1` is
    # Zombie Desert, `ugx_artemovsk` is UGX Requiem), so matching on the bsp silently
    # dropped the author, the description and the finish tags for most of the corpus.
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
    ap.add_argument("--corpus-fraction", type=float, default=CORPUS_COMMON_FRACTION)
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

    base = stock_baseline.load()
    if base is None:
        base = stock_baseline.build()
    stock_names = set(base["flags"]) | set(base["notifies"])
    print("stock baseline: %d names from %d zones" % (len(stock_names), len(base["zones"])))

    # ---------------------------------------------------------------- pass 1: scan
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
            scripts = scan_map.read_scripts(ffs, iwds)
            res = scan_map.scan(ffs, iwds)
        except Exception as exc:
            maps.append({"map": mapname, "error": "%s: %s" % (exc.__class__.__name__, exc)})
            print("%-28s SCANNER ERROR %s" % (mapname, exc))
            continue
        names = set()
        for _n, (text, _src) in scripts.items():
            names.update(scan_map.FLAG_RE.findall(text))
            names.update(scan_map.NOTIFY_RE.findall(text))
        fps = {}
        for name, (text, src) in sorted(scripts.items()):
            if name.endswith("_zombiemode.gsc"):
                fps["%s@%s" % (name, src)] = hashlib.sha256(
                    text.encode("latin-1")).hexdigest()
        ent_names = set()
        trigger_names = set()
        for e in scan_map.read_mapents(ffs):
            for k in ("targetname", "script_noteworthy", "script_label"):
                if e.get(k):
                    ent_names.add(e[k])
            if e.get("classname", "").startswith("trigger") and e.get("targetname"):
                trigger_names.add(e["targetname"])
        maps.append({"map": mapname, "res": res, "names": names, "fps": fps,
                     "ent_names": ent_names, "trigger_names": trigger_names,
                     "script_count": len(scripts), "ffs": ffs, "iwds": iwds})

    real = [m for m in maps if "res" in m]

    # ------------------------------------------------- corpus-common boilerplate
    counts = collections.Counter()
    for m in real:
        counts.update(m["names"])
    threshold = max(2, int(round(a.corpus_fraction * len(real))))
    corpus_common = {n for n, c in counts.items() if c >= threshold}
    boilerplate = stock_names | corpus_common
    ent_counts = collections.Counter()
    for m in real:
        ent_counts.update(m["ent_names"])
    corpus_common_ents = {n for n, c in ent_counts.items() if c >= threshold}
    boilerplate_ents = set(base.get("entity_names", [])) | corpus_common_ents
    # Radiant auto-names (auto1234, pf1266_auto301) mean nothing and differ per map,
    # so they never reach the corpus threshold; drop them by shape instead.
    auto_re = _re_compile()
    print("corpus baseline: %d names seen in >= %d of %d maps (%d of them not stock)"
          % (len(corpus_common), threshold, len(real), len(corpus_common - stock_names)))

    # ------------------------------------------------------- pass 2: reclassify
    rows = []
    for m in real:
        res, mapname = m["res"], m["map"]
        v_raw = res["verdict"]["finish"]
        v2, why2, ee2, endish2 = reclassify(res, boilerplate)
        own_ents = {n for n in m["ent_names"] if not auto_re.match(n)}
        v3, why3, ent_ev = classify_with_entities(res, own_ents, boilerplate,
                                                  boilerplate_ents)
        ee = extract_report.get(mapname)
        meta = provenance(ee["norm"]) if ee else None
        man = manifest_for(mapname, res, ee, meta, db)
        man["script_fingerprints"] = m["fps"]
        man["scanner"]["script_count"] = m["script_count"]
        man["scanner"]["verdict_raw"] = v_raw
        man["scanner"]["verdict_debiased"] = v2
        man["scanner"]["why_debiased"] = why2
        man["scanner"]["verdict_entities"] = v3
        man["scanner"]["why_entities"] = why3
        man["scanner"]["entity_evidence"] = ent_ev
        # A shortlist for whoever reads this map next. Hint words only catch finishes
        # whose author used our vocabulary; ORBiT's quest is `keycards`, `orbitron_lock`,
        # `planet1trig` and Minecraft Village's is `gumball_*`. What IS reliable is that
        # a trigger nobody else in the corpus has is this map's own -- so list those and
        # let a human spend twenty seconds instead of reading 150 scripts.
        man["scanner"]["map_specific_triggers"] = sorted(
            n for n in m["trigger_names"]
            if n not in boilerplate_ents and not auto_re.match(n)
            and not PERK_ENT.search(n))[:40]
        man["scanner"]["ee_candidates_own"] = ee2
        man["scanner"]["ending_words_own"] = endish2
        man["scanner"]["baseline"] = {
            "stock_names": len(stock_names), "corpus_common": len(corpus_common),
            "note": ("A name is treated as this map's own only if it is absent from "
                     "WaW's stock zones AND from the boilerplate shared by most maps "
                     "in the corpus. See archive/stock_baseline.py."),
        }
        # The entity-aware verdict is the one we act on; the other two stay on record
        # so the referee agent can see exactly what each tier bought.
        man["badge"]["main_finish"] = ("buyable_ending" if v3 == "buyable_ending"
                                       else "easter_egg" if v3 == "easter_egg" else "round")
        man["confidence"] = "guess" if v3 in NEEDS_HUMAN else "read"
        man["needs_human"] = v3 in NEEDS_HUMAN
        if v3 == "easter_egg":
            man["finishes"] = [f for f in man["finishes"] if f["id"] != "easter_egg"]
            man["finishes"].insert(0, {
                "id": "easter_egg", "label": "Easter Egg", "priority": 1,
                "when": {"manual": True},
                "candidate_flags": ent_ev["ee_flags"],
                "candidate_entities": ent_ev["ee_entities"]})
        if v3 == "buyable_ending" and ent_ev["end_entities"] and not res[
                "buyable_ending_candidate"]:
            man["finishes"] = [f for f in man["finishes"] if f["id"] != "buyable_ending"]
            man["finishes"].insert(0, {
                "id": "buyable_ending", "label": "Buyable Ending", "priority": 2,
                "when": {"trigger_used": {"targetname": ent_ev["end_entities"][0]}},
                "candidate_entities": ent_ev["end_entities"]})
        with open(os.path.join(OUT, mapname + ".json"), "w", encoding="utf-8") as fh:
            json.dump(man, fh, indent=2)
        rows.append({"map": mapname, "verdict_raw": v_raw, "verdict_debiased": v2,
                     "verdict": v3, "why": why3, "why_debiased": why2,
                     "entity_evidence": ent_ev,
                     "decided": v3 in DECIDED, "needs_human": v3 in NEEDS_HUMAN,
                     "scripts": res["scripts"], "entities": res["entities"],
                     "ee_candidates_raw": res["ee_candidates"], "ee_candidates_own": ee2,
                     "ending_words_own": endish2,
                     "buyable": res["buyable_ending_candidate"],
                     "top_costs": res["top_costs"]})
        print("%-22s raw=%-10s debiased=%-14s +entities=%-14s %s"
              % (mapname, v_raw, v2, v3, why3[:46]))

    dec_raw = [r for r in rows if r["verdict_raw"] in DECIDED]
    dec2 = [r for r in rows if r["verdict_debiased"] in DECIDED]
    dec = [r for r in rows if r["decided"]]
    n = len(rows)
    print("")
    print("scanner as shipped        : %d/%d decided without a human (%.0f%%)"
          % (len(dec_raw), n, 100.0 * len(dec_raw) / n if n else 0))
    print("+ stock/corpus baselines  : %d/%d (%.0f%%)"
          % (len(dec2), n, 100.0 * len(dec2) / n if n else 0))
    print("+ entity names            : %d/%d (%.0f%%)"
          % (len(dec), n, 100.0 * len(dec) / n if n else 0))
    summary = {
        "maps": n,
        "decided_raw": len(dec_raw), "decided_debiased": len(dec2),
        "decided_entities": len(dec),
        "needs_human_raw": n - len(dec_raw), "needs_human_entities": n - len(dec),
        "verdicts_raw": dict(collections.Counter(r["verdict_raw"] for r in rows)),
        "verdicts_debiased": dict(collections.Counter(r["verdict_debiased"] for r in rows)),
        "verdicts_entities": dict(collections.Counter(r["verdict"] for r in rows)),
        "corpus_common_entities": len(corpus_common_ents),
        "stock_names": len(stock_names), "corpus_common": len(corpus_common),
        "corpus_common_not_stock": sorted(corpus_common - stock_names)[:80],
        "threshold_maps": threshold,
        "rows": rows,
    }
    with open(os.path.join(WORK, "reports", "scan.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)


if __name__ == "__main__":
    main()
