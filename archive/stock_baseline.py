#!/usr/bin/env python3
"""Build the set of flag / notify names that are STOCK, so a custom map's own can be seen.

Why this exists, measured tonight on 14 real custom maps:

  `referee/scan_map.py` scores 20/20 on everything reachable locally, but on the first
  14 third-party maps it returned `manual` for 12 of them and `easter_egg` for the other
  two -- **0 decided without a human**. Every one of the 12 gave the same reason:

      names suggest an ending (arcademode_ending_complete, crawler_round_ending,
      dog_round_ending, ...) but nothing decidable

  Those three names are not the map's. They are Treyarch's, out of `_zombiemode.gsc`
  and friends. The stock maps never tripped on them because on a stock install those
  scripts live in `common.ff`/`patch.ff`, which the scanner is not handed -- it only
  gets `nazi_zombie_factory.ff`. A **custom** map ships its own copy of the whole
  common script set inside `mod.ff`, so the same words suddenly appear inside the map
  and the hint lists fire on Treyarch's code.

  So the scanner is not wrong about custom maps; it has never seen one with its scripts
  attached. The fix is a baseline: read every flag and notify out of WaW's own zone
  files once, and treat a name as evidence only if it is NOT in that set.

This file only *builds* the baseline and caches it. `scan_maps.py` applies it. Nothing
in `referee/` is modified -- that is the referee agent's tool and it stays theirs.

  python stock_baseline.py [--zone <dir>] [--out <json>]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "referee"))
sys.path.insert(0, os.path.join(REPO, "tools", "re"))
import scan_map  # noqa: E402

DEFAULT_ZONE = r"C:\Users\b\ZombiesDev\waw-base\zone\english"
DEFAULT_OUT = os.path.join(HERE, "stock-baseline.json")

# Everything a stock install loads for a zombies game. patch.ff and common.ff hold the
# shared script set; the four map zones hold Treyarch's own per-map scripts, which are
# also fair game for the baseline (a custom map that reuses Nacht's flag names is
# reusing Treyarch's code, not signalling its own easter egg).
STOCK_ZONES = [
    "common.ff", "patch.ff", "code_post_gfx.ff", "default.ff",
    "nazi_zombie_prototype.ff", "nazi_zombie_prototype_load.ff",
    "nazi_zombie_asylum.ff", "nazi_zombie_asylum_load.ff", "nazi_zombie_asylum_patch.ff",
    "nazi_zombie_sumpf.ff", "nazi_zombie_sumpf_load.ff", "nazi_zombie_sumpf_patch.ff",
    "nazi_zombie_factory.ff", "nazi_zombie_factory_load.ff", "nazi_zombie_factory_patch.ff",
]


def build(zone_dir=DEFAULT_ZONE):
    paths = [os.path.join(zone_dir, z) for z in STOCK_ZONES]
    paths = [p for p in paths if os.path.exists(p)]
    scripts = scan_map.read_scripts(paths, [])
    flags, notifies = set(), set()
    for _name, (text, _src) in scripts.items():
        flags.update(scan_map.FLAG_RE.findall(text))
        notifies.update(scan_map.NOTIFY_RE.findall(text))
    # Entity targetnames too: the same subtraction has to work on the Radiant entity
    # list, because that is where a custom map's quest usually lives (Leviathan's
    # easter egg is `ee_step_1_switch`, `ee_step_3_trig`, `ee_testtube_activate_trig`
    # -- entities, with not one easter-egg flag in any script).
    ents = set()
    for p in paths:
        for e in scan_map.read_mapents([p]):
            for k in ("targetname", "script_noteworthy", "script_label"):
                if e.get(k):
                    ents.add(e[k])
    return {
        "zones": [os.path.basename(p) for p in paths],
        "scripts": len(scripts),
        "flags": sorted(flags),
        "notifies": sorted(notifies),
        "entity_names": sorted(ents),
        "script_names": sorted(scripts),
    }


def load(path=DEFAULT_OUT):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zone", default=DEFAULT_ZONE)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    b = build(a.zone)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(b, fh, indent=1)
    print("%d stock zones, %d scripts, %d flags, %d notifies -> %s"
          % (len(b["zones"]), b["scripts"], len(b["flags"]), len(b["notifies"]), a.out))
    ee = [f for f in b["flags"] if any(h in f.lower() for h in scan_map.EE_HINTS)]
    end = [f for f in set(b["flags"]) | set(b["notifies"])
           if any(h in f.lower() for h in scan_map.END_HINTS)]
    print("  of which the scanner's EE hints would match  : %d  %s" % (len(ee), ee[:8]))
    print("  of which the scanner's END hints would match : %d  %s" % (len(end), end[:8]))


if __name__ == "__main__":
    main()
