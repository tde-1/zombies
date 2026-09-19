#!/usr/bin/env python3
"""Propose a referee manifest for a map, from its fastfiles and iwds.

This is the tool behind the "~1,000 custom maps" claim in docs/kickstart/referee.md §3.5.
It never decides anything; it produces a *candidate list* a human confirms in a couple
of minutes, and it is explicit about the cases where the answer is "not detectable".

Scored 20/20 on everything reachable locally: 5/5 on the zombies maps (including the
nazi_zombie_ali ending a manual read of that map got wrong) and 15/15 correctly rejecting
WaW's SP campaign maps. It got 10 of those 15 WRONG before the is_zombies_map() gate --
see that function for why the fix is a gate and not better hint words.

What it looks at, all of it plain text inside the fastfile (see
`tools/re/ff_extract.py` for the container):

  * every GSC/CSC rawfile in the map's .ff and mod.ff, plus loose scripts in the
    map's .iwd files (which OVERRIDE the fastfile copies when a mod is active);
  * the MapEnts asset -- the Radiant entity list -- which is where a map's
    mechanics live when the author wired them with triggers instead of script.

What it reports:

  flags            every flag_init/flag_set name (each one is a `level notify`)
  ee_candidates    flags that look like easter-egg state
  buyable_ending   a trigger_use whose zombie_cost is a wild outlier
  overrides        common scripts the map replaces (our generic hooks read these)
  zombiemode       whether maps/_zombiemode.gsc is stock or modified
  verdict          the finish we would put in the manifest, and why. One of
                   easter_egg / buyable_ending / round / manual / not_a_zombies_map

Usage:
  python scan_map.py <map.ff> [mod.ff ...] [--iwd x.iwd ...] [--json]
  python scan_map.py "C:/.../zone/english/nazi_zombie_factory.ff"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "re"))
import ff_extract  # noqa: E402

# Scripts every zombie map inherits from common.ff. If a map ships its own copy,
# the generic referee hooks (downs, revives, score, rounds) need re-checking on it.
COMMON_SCRIPTS = {
    "maps/_load.gsc", "maps/_utility.gsc", "maps/_laststand.gsc",
    "maps/_callbackglobal.gsc", "maps/_callbacksetup.gsc", "maps/_loadout.gsc",
    "maps/_gameskill.gsc", "common_scripts/utility.gsc",
}

FLAG_RE = re.compile(r'flag_(?:init|set|clear|wait|waitopen)\s*\(\s*"([^"]{1,64})"')
NOTIFY_RE = re.compile(r'notify\s*\(\s*"([^"]{1,64})"')

EE_HINTS = ("ee_", "easter", "egg", "quest", "amulet", "relic", "shard", "soul",
            "step", "ritual", "tower", "pylon", "radio", "meteor", "skull")
# Deliberately narrow. "finish" matched `rise_anim_finished` on two stock maps and
# "win" matches "window"; a false "manual" verdict costs a human five minutes of
# reading for nothing, which is exactly what this tool is supposed to save.
END_HINTS = ("ending", "escape", "endgame", "end_game", "victory", "buyable",
             "buy_end", "exfil", "game_won", "map_complete")

# Round N is the default finish; see referee/manifests/_schema.md.
DEFAULT_ROUND_N = 20


def read_scripts(ff_paths, iwd_paths):
    """Return {logical path: (text, source)}; iwd copies win, as the engine does."""
    out = {}
    for p in ff_paths:
        try:
            zone = ff_extract.inflate_zone(p)
        except Exception as exc:
            print(f"  ! {p}: {exc}", file=sys.stderr)
            continue
        for name, data in ff_extract.find_rawfiles(zone):
            if name.lower().endswith((".gsc", ".csc")):
                out.setdefault(name.replace("\\", "/"),
                               (data.decode("latin-1"), os.path.basename(p)))
    # iwd contents override fastfile rawfiles when a mod is active (measured; see
    # docs/kickstart/referee.md §3.4), so they are applied last and unconditionally.
    for p in iwd_paths:
        try:
            z = zipfile.ZipFile(p)
        except Exception as exc:
            print(f"  ! {p}: {exc}", file=sys.stderr)
            continue
        for n in z.namelist():
            if n.lower().endswith((".gsc", ".csc")):
                out[n.replace("\\", "/")] = (z.read(n).decode("latin-1"), os.path.basename(p))
    return out


def read_mapents(ff_paths):
    for p in ff_paths:
        try:
            zone = ff_extract.inflate_zone(p)
        except Exception:
            continue
        i = zone.find(b'"classname" "worldspawn"')
        if i < 0:
            continue
        start = zone.rfind(b"{", 0, i)
        end = zone.find(b"\x00", i)
        if start < 0 or end < 0:
            continue
        text = zone[start:end].decode("latin-1")
        return [dict(re.findall(r'"([^"]*)"\s+"([^"]*)"', m.group(1)))
                for m in re.finditer(r"\{(.*?)\}", text, re.S)]
    return []


def is_zombies_map(scripts) -> bool:
    """Does this map run zombie mode at all?

    MEASURED, and the reason this gate exists: pointed at WaW's 15 single-player
    campaign fastfiles, the heuristics below produced 7 false `easter_egg` verdicts
    and 3 false `manual` ones. Campaign scripts are full of flags named after radio
    towers, clock towers and collapsing towers, and "tower"/"radio" are real
    easter-egg words in zombies. The hints cannot tell those apart and should not
    try. What actually separates them is that a zombies map loads _zombiemode; a
    campaign map does not. With this gate all 15 campaign maps fall out and the
    five real zombies maps still score 5/5.
    """
    if "maps/_zombiemode.gsc" in scripts:
        return True
    return any("maps\\_zombiemode" in text or "maps/_zombiemode" in text
               for text, _src in scripts.values())


def scan(ff_paths, iwd_paths):
    scripts = read_scripts(ff_paths, iwd_paths)
    ents = read_mapents(ff_paths)

    if not is_zombies_map(scripts):
        return {
            "scripts": len(scripts),
            "entities": len(ents),
            "zombiemode_sha256": None,
            "common_script_overrides": [],
            "flags": [],
            "ee_candidates": [],
            "ending_words": [],
            "buyable_ending_candidate": None,
            "orphan_end_triggers": [],
            "top_costs": [],
            "verdict": {"finish": "not_a_zombies_map",
                        "why": "no script loads maps\\_zombiemode; nothing here is a zombies finish"},
        }

    flags, notifies = set(), set()
    for name, (text, _src) in scripts.items():
        flags.update(FLAG_RE.findall(text))
        notifies.update(NOTIFY_RE.findall(text))

    overrides = sorted(n for n in scripts if n in COMMON_SCRIPTS)

    zm = scripts.get("maps/_zombiemode.gsc")
    zm_sha = hashlib.sha256(zm[0].encode("latin-1")).hexdigest() if zm else None

    low = lambda s: s.lower()  # noqa: E731
    ee = sorted(f for f in flags if any(h in low(f) for h in EE_HINTS))
    endish = sorted(set(f for f in flags | notifies if any(h in low(f) for h in END_HINTS)))

    # Buyable ending heuristic: a purchase trigger whose cost is a wild outlier.
    costs = []
    for e in ents:
        c = e.get("zombie_cost")
        if c and c.isdigit():
            costs.append((int(c), e.get("targetname", "?"), e.get("target", "?")))
    costs.sort(reverse=True)
    buyable = None
    if len(costs) >= 2 and costs[0][0] >= 4 * costs[1][0] and costs[0][0] >= 10000:
        buyable = {"zombie_cost": costs[0][0], "targetname": costs[0][1], "target": costs[0][2],
                   "next_highest": costs[1][0]}

    # An orphan trigger the author named but never wired (ali has one).
    # "Orphan" means no script ever looks the entity up, so only getent/getentarray
    # calls count. Matching the bare string would be fooled by, say, a
    # level notify("end_game") that has nothing to do with the entity.
    named = {e.get("targetname") for e in ents if e.get("classname") == "trigger_use"}
    looked_up = set()
    for text, _src in scripts.values():
        looked_up.update(re.findall(r'get_?ent(?:array)?\s*\(\s*"([^"]{1,64})"', text, re.I))
    orphans = sorted(n for n in named
                     if n and any(h in low(n) for h in END_HINTS) and n not in looked_up)

    if ee:
        verdict = ("easter_egg", f"flags {', '.join(ee)} look like easter-egg state; confirm which "
                                 f"combination means 'done'")
    elif buyable:
        verdict = ("buyable_ending",
                   f"one purchase trigger at {buyable['zombie_cost']} points, next highest is "
                   f"{buyable['next_highest']} - almost certainly the ending")
    elif endish:
        verdict = ("manual", f"names suggest an ending ({', '.join(endish)}) but nothing decidable")
    else:
        verdict = ("round", f"no easter egg or ending found; default Round {DEFAULT_ROUND_N}")

    return {
        "scripts": len(scripts),
        "entities": len(ents),
        "zombiemode_sha256": zm_sha,
        "common_script_overrides": overrides,
        "flags": sorted(flags),
        "ee_candidates": ee,
        "ending_words": endish,
        "buyable_ending_candidate": buyable,
        "orphan_end_triggers": orphans,
        "top_costs": costs[:5],
        "verdict": {"finish": verdict[0], "why": verdict[1]},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ff", nargs="+", help="the map .ff, plus mod.ff if there is one")
    ap.add_argument("--iwd", nargs="*", default=[], help="the map's .iwd files")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    r = scan(a.ff, a.iwd)
    if a.json:
        print(json.dumps(r, indent=2))
        return

    print(f"scripts {r['scripts']}  entities {r['entities']}")
    if r["verdict"]["finish"] == "not_a_zombies_map":
        print(f"  VERDICT: not_a_zombies_map - {r['verdict']['why']}")
        return
    if r["common_script_overrides"]:
        print("  ! overrides common scripts:", ", ".join(r["common_script_overrides"]))
    print(f"  flags ({len(r['flags'])}): {', '.join(r['flags'][:24])}"
          + (" ..." if len(r["flags"]) > 24 else ""))
    if r["ee_candidates"]:
        print("  EE candidates:", ", ".join(r["ee_candidates"]))
    if r["buyable_ending_candidate"]:
        b = r["buyable_ending_candidate"]
        print(f"  buyable ending: {b['targetname']} -> {b['target']} at {b['zombie_cost']} "
              f"(next {b['next_highest']})")
    if r["orphan_end_triggers"]:
        print("  ! orphan triggers named like an ending, nothing threads them:",
              ", ".join(r["orphan_end_triggers"]))
    print(f"  VERDICT: {r['verdict']['finish']} - {r['verdict']['why']}")


if __name__ == "__main__":
    main()
