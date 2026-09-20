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

# TOKEN hints, not substrings.
#
# MEASURED by the `archive` agent on 14 real custom maps: substring matching gives
# false hits that no amount of list-tuning fixes -- `vending_mulekick` contains
# "ending", `floor_three_zone` contains "ee_". So names are split into tokens and
# a hint has to match a WHOLE token. That also makes short hints safe: "win" no
# longer matches "window", because "window" is one token.
EE_TOKENS = {"ee", "easter", "egg", "quest", "amulet", "relic", "shard", "pylon",
             "meteor", "ritual", "step", "rune", "totem", "obelisk"}
END_TOKENS = {"ending", "escape", "endgame", "victory", "buyable", "exfil",
              "win", "won", "finale", "teleport"}
# Whole names that mean an ending regardless of how they tokenise. `end_game` is
# the shape both nazi_zombie_ali and MW2 Rust use for the ending trigger.
END_NAMES = {"end_game", "endgame", "end_trigger", "buy_ending", "buyable_ending",
             "end_level", "endmap", "end_map"}

_TOKEN_SPLIT = re.compile(r"[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])")


def tokens(name: str) -> set[str]:
    return {t.lower() for t in _TOKEN_SPLIT.split(name) if t}


def hit(name: str, tokset: set[str]) -> bool:
    n = name.lower()
    if n in END_NAMES and tokset is END_TOKENS:
        return True
    return bool(tokens(name) & tokset)


def load_baseline(path: str | None):
    """Names that are Treyarch's, not the map's.

    MEASURED, and the reason this exists: on a stock install the shared zombie
    scripts live in common.ff/patch.ff, which this tool is never handed -- it only
    gets nazi_zombie_<x>.ff. A CUSTOM map ships its own copy of that whole script
    set inside mod.ff, so Treyarch's `arcademode_ending_complete`,
    `dog_round_ending` and `ee_bowie_bear` suddenly appear *inside the map* and the
    hint lists fire on them. 12 of 14 real maps returned `manual` on those same
    three words. Subtracting a stock baseline is what makes the hints mean
    "this map's own", which is the only thing they were ever supposed to mean.
    """
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "archive", "stock-baseline.json")
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:
        return set(), set()
    names = set(d.get("flags", [])) | set(d.get("notifies", []))
    ents = set(d.get("entity_names", []))
    return names, ents

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


def corpus_common(per_map_names, threshold=0.6):
    """Names shared by >= `threshold` of the corpus are not any one map's evidence.

    MEASURED: after subtracting the stock baseline, `crawler_round_ending` and the
    trigger name `end_game` still appeared on 14 of 14 real maps and pushed every
    one of them to `buyable_ending`. They are not Treyarch's, so the baseline does
    not catch them -- they ride in on the community script set that nearly every
    custom map is built from. Anything that common describes the toolchain, not the
    map, and treating it as evidence makes the scanner say the same thing about
    everything.
    """
    from collections import Counter
    if not per_map_names:
        return set()
    c = Counter()
    for names in per_map_names:
        c.update(set(names))
    cutoff = max(2, int(len(per_map_names) * threshold))
    return {n for n, k in c.items() if k >= cutoff}


def scan(ff_paths, iwd_paths, baseline_path=None, ignore=None):
    baseline_names, baseline_ents = load_baseline(baseline_path)
    ignore = {n.lower() for n in (ignore or [])}
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

    # Entity targetnames are evidence too -- often the ONLY evidence. Leviathan has
    # no easter-egg flag in any of its 120 scripts; its quest lives in MapEnts as
    # ee_step_1_switch / ee_step_3_trig / ee_testtube_activate_trig. MW2 Rust's
    # ending is a trigger named end_game with nothing in script at all.
    ent_names = {e.get("targetname", "") for e in ents}
    ent_names |= {e.get("script_noteworthy", "") for e in ents}
    ent_names = {n for n in ent_names if n}

    def own(names, base):
        return {n for n in names if n not in base and n.lower() not in ignore}

    own_flags = own(flags, baseline_names)
    own_notifies = own(notifies, baseline_names)
    own_ents = own(ent_names, baseline_ents)

    ee = sorted({n for n in (own_flags | own_ents) if hit(n, EE_TOKENS)})
    endish = sorted({n for n in (own_flags | own_notifies | own_ents) if hit(n, END_TOKENS)})

    # Every one of the 14 real maps hardcodes its ending price in script rather than
    # in a zombie_cost key, so the entity-cost outlier below fired 0/14. Catch the
    # script form too: a four-figure-plus literal assigned to a cost variable.
    hardcoded = sorted({int(m) for text, _src in scripts.values()
                        for m in re.findall(r"\bcost\s*=\s*(\d{4,6})\b", text)})

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
                     if n and hit(n, END_TOKENS) and n not in looked_up)

    if ee:
        verdict = ("easter_egg", f"{', '.join(ee[:6])} look like easter-egg state (map's own, after "
                                 f"subtracting {len(baseline_names)} stock names); confirm which "
                                 f"combination means 'done'")
    elif endish:
        verdict = ("buyable_ending", f"{', '.join(endish[:6])} name an ending and are this map's own"
                                     + (f"; script hardcodes cost {hardcoded[-1]}" if hardcoded else ""))
    elif buyable:
        verdict = ("buyable_ending",
                   f"one purchase trigger at {buyable['zombie_cost']} points, next highest is "
                   f"{buyable['next_highest']} - almost certainly the ending")
    else:
        verdict = ("round", f"no easter egg or ending found; default Round {DEFAULT_ROUND_N}")

    return {
        "scripts": len(scripts),
        "entities": len(ents),
        "zombiemode_sha256": zm_sha,
        "common_script_overrides": overrides,
        "flags": sorted(flags),
        "own_flags": sorted(own_flags),
        "own_notifies": sorted(own_notifies),
        "own_entity_names": sorted(own_ents)[:200],
        "ee_candidates": ee,
        "ending_words": endish,
        "hardcoded_costs": hardcoded,
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
    ap.add_argument("--baseline", default=None,
                    help="stock-baseline.json (default: ../archive/stock-baseline.json)")
    ap.add_argument("--ignore", default=None,
                    help="JSON list or newline file of names to treat as not-the-map's "
                         "(the batch driver's >=60%%-of-corpus rule feeds this)")
    a = ap.parse_args()

    ignore = []
    if a.ignore:
        with open(a.ignore, encoding="utf-8") as fh:
            body = fh.read().strip()
        ignore = json.loads(body) if body.startswith("[") else body.split()

    r = scan(a.ff, a.iwd, baseline_path=a.baseline, ignore=ignore)
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
