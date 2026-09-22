#!/usr/bin/env python3
"""What is IN a map — perks, Pack-a-Punch, the box, wall buys, wonder weapons, hellhounds,
traps, teleporters, power — read out of the map's own files. For the map page.

2026-09-22 (web-maps lane). The crawl records what a forum post SAID about a map (easter egg,
buyable ending, UGX mod); it has nothing on what the map contains. For the maps whose files
we hold — WaW's four and the ones the archive pipeline extracted — the files say it plainly,
and the referee scanner (`referee/scan_map.py`) already knows how to read them: the fastfile's
MapEnts (the Radiant entity list, where a perk machine is a `zombie_vending` trigger with its
perk in `script_noteworthy`) and the map's GSC (where the box's weapon list is
`include_weapon("tesla_gun")` calls). This reuses its two readers and adds nothing to them.

What each fact is, and why it is trusted:

  perks          one `zombie_vending` trigger per machine; the perk is its script_noteworthy.
                 Not the perk SCRIPT, which every map inherits whether it places machines or not
                 (Nacht has the perk script and no machines). WaW's own four are named; any
                 other perk a custom pack adds is COUNTED, because packs reuse specialty names.
  pack_a_punch   a `zombie_vending_upgrade` trigger (Der Riese's), the one way WaW builds one.
  box            `treasure_chest_use` triggers: how many places the Mystery Box can be.
  wall_weapons   `weapon_upgrade` triggers: chalk buys on the walls.
  wonder_weapons the box list (`include_weapon`) intersected with a named list below. A weapon
                 in the list is a weapon in the box; it is not a claim about where else it is.
  dogs           the hellhound AI type is in the zone (`aitype/zombie_dog.gsc`). Verrückt's
                 script says "dogs" in a comment; the AI type is the fact.
  teleporters, traps, power   named triggers, listed in TRIGGERS below.

A map this cannot read gets no entry, and the page prints nothing for it rather than a guess.

  python tools/maps/map_features.py                 -> web/server/data/map-features.json
  python tools/maps/map_features.py --print nazi_zombie_factory
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "referee"))
import scan_map  # noqa: E402  (brings tools/re/ff_extract with it)

DEV = os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev")
WORK = os.environ.get("ZM_ARCHIVE_WORK", os.path.join(DEV, "archive"))
STEAM_WAW = r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"
OUT = os.path.join(REPO, "web", "server", "data", "map-features.json")

STOCK_KEYS = ["nazi_zombie_prototype", "nazi_zombie_asylum", "nazi_zombie_sumpf", "nazi_zombie_factory"]
MOD_ROOTS = [os.path.join(WORK, "mods")] + sorted(glob.glob(os.path.join(DEV, "homes", "*", "mods"))) \
    + sorted(glob.glob(os.path.join(DEV, "dedi-overlay*", "mods")))

# WaW's four. These specialty names mean one perk in every WaW map, because the stock perk
# script gives them their machines, jingles and effects. Custom perk packs RE-USE the other
# specialty names for whatever perk they add (`specialty_detectexplosive` is PhD in one pack
# and something else in the next), so past these four a name is not evidence of which perk
# it is. Those are counted (`other_perks`), not named.
PERKS = {
    "specialty_armorvest": "Juggernog",
    "specialty_quickrevive": "Quick Revive",
    "specialty_fastreload": "Speed Cola",
    "specialty_rof": "Double Tap",
}
WONDER = {
    "ray_gun": "Ray Gun",
    "tesla_gun": "Wunderwaffe DG-2",
    "thundergun": "Thundergun",
    "zombie_thundergun": "Thundergun",
    "freezegun": "Winter's Howl",
    "microwavegun": "Wave Gun",
    "shrink_ray": "31-79 JGb215",
    "humangun": "Human Gun",
    "sniper_explosive": "Scavenger",
    "blundergat": "Blundergat",
    "zombie_cymbal_monkey": "Monkey Bombs",
}
TRIGGERS = {
    "teleporters": re.compile(r"^trigger_teleport_pad"),
    "traps": re.compile(r"(^|_)(elec_)?trap(_|$)|electric_trap|zapper|flogger"),
    "power": re.compile(r"^use_(power|master)_switch$|^power_switch$|^master_switch$"),
}
INCLUDE_RE = re.compile(r'include_weapon\(\s*"([\w]+)"')


def find_files(key):
    """(ff paths, iwd paths, where) for one map, or None."""
    if key in STOCK_KEYS:
        for root in (os.environ.get("ZM_WAW_DIR"), STEAM_WAW, os.path.join(DEV, "waw-base")):
            z = root and os.path.join(root, "zone", "english", key + ".ff")
            if z and os.path.isfile(z):
                patch = os.path.join(root, "zone", "english", key + "_patch.ff")
                ffs = [z] + ([patch] if os.path.isfile(patch) else [])
                return ffs, [], "WaW zone/english"
        return None
    for root in MOD_ROOTS:
        d = os.path.join(root, key)
        ff = os.path.join(d, key + ".ff")
        if os.path.isfile(ff):
            ffs = [ff] + [p for p in (os.path.join(d, "mod.ff"), os.path.join(d, key + "_patch.ff")) if os.path.isfile(p)]
            return ffs, sorted(glob.glob(os.path.join(d, "*.iwd"))), os.path.relpath(d, DEV)
    return None


def features(key):
    found = find_files(key)
    if not found:
        return None
    ffs, iwds, where = found
    ents = scan_map.read_mapents(ffs)
    scripts = scan_map.read_scripts(ffs, iwds)
    if not ents and not scripts:
        return None
    tn = lambda e: (e.get("targetname") or "").lower()  # noqa: E731

    perks, other = [], set()
    for e in ents:
        if tn(e) == "zombie_vending":
            p = (e.get("script_noteworthy") or "").lower()
            if p in PERKS:
                if PERKS[p] not in perks:
                    perks.append(PERKS[p])
            elif p:
                other.add(p)
    order = list(PERKS.values())
    perks.sort(key=order.index)          # Jugg, Quick Revive, Speed Cola, Double Tap
    included = set()
    for path, (text, _src) in scripts.items():
        if path.startswith("maps/") and not path.startswith("maps/_"):
            included |= set(INCLUDE_RE.findall(text))
    wonder = []
    for w, label in WONDER.items():
        if w in included and label not in wonder:
            wonder.append(label)
    names = [tn(e) for e in ents]
    out = {
        "perks": perks,
        "other_perks": len(other),
        "pack_a_punch": any(n in ("zombie_vending_upgrade", "vending_pack_a_punch") for n in names),
        "box": sum(1 for n in names if n == "treasure_chest_use"),
        "wall_weapons": sum(1 for n in names if n == "weapon_upgrade"),
        "wonder_weapons": wonder,
        "dogs": "aitype/zombie_dog.gsc" in scripts
                or any(re.search(r"dog_spawn|spawners?_dog|zombie_spawner_dog", n) for n in names),
        "teleporters": sum(1 for n in names if TRIGGERS["teleporters"].search(n)),
        "traps": any(TRIGGERS["traps"].search(n) and not n.endswith("_fx") for n in names),
        "power_switch": any(TRIGGERS["power"].search(n) for n in names),
        "entities": len(ents),
        "scripts": len(scripts),
        "read_from": where,
    }
    return out


def all_keys():
    keys = list(STOCK_KEYS)
    for root in MOD_ROOTS:
        for d in sorted(glob.glob(os.path.join(root, "*"))):
            k = os.path.basename(d)
            if k not in keys and os.path.isfile(os.path.join(d, k + ".ff")):
                keys.append(k)
    return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="show")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    if args.show:
        print(json.dumps(features(args.show), indent=1))
        return
    res = {}
    for k in all_keys():
        f = features(k)
        if f:
            res[k] = f
            print("%-26s perks=%d+%d pap=%s box=%d wall=%d wonder=%s dogs=%s tele=%d traps=%s power=%s"
                  % (k, len(f["perks"]), f["other_perks"], f["pack_a_punch"], f["box"], f["wall_weapons"],
                     ",".join(f["wonder_weapons"]) or "-", f["dogs"], f["teleporters"], f["traps"],
                     f["power_switch"]))
        else:
            print("%-26s unreadable, left out" % k)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "tool": "tools/maps/map_features.py", "maps": res},
              open(args.out, "w", encoding="utf-8"), indent=1, sort_keys=True)
    print("wrote %d maps to %s" % (len(res), args.out))


if __name__ == "__main__":
    main()
