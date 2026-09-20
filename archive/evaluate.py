#!/usr/bin/env python3
"""Score the scanner against what the community says each map has.

"Decided without a human" is only half the question. A scanner that answers
"Round 20" for every map decides 100% of them and is useless. So this checks the
scanner's verdict against callofdutyrepo's Easter-egg and Buyable-ending tag lists --
an independent, human-made label for the same maps.

  agree        the scanner's finish matches the tag
  missed       the community tags a finish the scanner did not find (false negative)
  extra        the scanner claims a finish the community does not tag (needs a look)
  untagged     no tag either way; the scanner's answer stands unchecked

The tag lists are themselves imperfect (vault 04 section 3 marks them "not confirmed in
game"), so this is a cross-check, not a ground truth. It is still the only independent
label available without playing fourteen maps.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MANIFESTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifests")


def main():
    scan = json.load(open(os.path.join(WORK, "reports", "scan.json"), encoding="utf-8"))
    rows = []
    for r in scan["rows"]:
        mf = os.path.join(MANIFESTS, r["map"] + ".json")
        tags = []
        title = r["map"]
        if os.path.exists(mf):
            m = json.load(open(mf, encoding="utf-8"))
            tags = m["archive"]["catalogue_tags"]
            title = m.get("title") or title
        claims_ee = "easter_egg" in tags
        claims_be = "buyable_ending" in tags or "bossfight_ending" in tags
        v = r["verdict"]
        got_ee = v == "easter_egg"
        got_be = v == "buyable_ending"
        if not (claims_ee or claims_be):
            outcome = "untagged"
        elif (claims_ee and got_ee) or (claims_be and got_be):
            outcome = "agree"
        elif got_ee or got_be:
            outcome = "extra"
        elif v == "manual":
            outcome = "missed-but-flagged"
        else:
            outcome = "missed-silently"
        rows.append({"map": r["map"], "title": title,
                     "verdict_stock_only": r.get("verdict_stock_only"),
                     "verdict": v, "tags": tags, "outcome": outcome,
                     "ending_words": r.get("ending_words", []),
                     "ee_candidates": r.get("ee_candidates", []),
                     "map_specific_triggers": r.get("map_specific_triggers", [])})
    counts = {}
    for r in rows:
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
    print("%-22s %-16s %-19s %-26s %s"
          % ("map", "verdict", "outcome", "community tag", "evidence"))
    for r in rows:
        ev = (r["ee_candidates"] or r["ending_words"])[:3]
        print("%-22s %-16s %-19s %-26s %s"
              % (r["map"], r["verdict"], r["outcome"],
                 ",".join(t for t in r["tags"] if t in
                          ("easter_egg", "buyable_ending", "bossfight_ending")) or "-",
                 ", ".join(ev) or "-"))
    print("\n", counts)
    tagged = [r for r in rows if r["outcome"] != "untagged"]
    if tagged:
        agree = len([r for r in tagged if r["outcome"] == "agree"])
        flagged = len([r for r in tagged if r["outcome"] == "missed-but-flagged"])
        print("of %d maps with a community finish tag: %d agreed, %d were flagged for a "
              "human, %d were silently called Round N"
              % (len(tagged), agree, flagged,
                 len(tagged) - agree - flagged))
    out = os.path.join(WORK, "reports", "evaluate.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"counts": counts, "rows": rows}, fh, indent=2)
    print("wrote", out)


if __name__ == "__main__":
    main()
