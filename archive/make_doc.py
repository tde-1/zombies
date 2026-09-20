#!/usr/bin/env python3
"""Assemble docs/kickstart/archive.md from the live reports.

The prose lives in archive/archive.md.tmpl; the numbers are generated, so the document
can be regenerated at any point in a long link-check run without hand-editing a single
figure. Placeholders are {{name}} and come from report.py, scan.json and evaluate.json.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
sys.path.insert(0, HERE)
import report  # noqa: E402
from lib import catalogue  # noqa: E402

TMPL = os.path.join(HERE, "archive.md.tmpl")
OUT = os.path.join(REPO, "docs", "kickstart", "archive.md")


def load(name, default=None):
    p = os.path.join(WORK, "reports", name)
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    db = catalogue.connect()
    r = report.build(db)
    scan = load("scan.json", {"rows": [], "maps": 0})
    ev = load("evaluate.json", {"counts": {}, "rows": []})
    fetch = load("fetch.json", [])
    extract = load("extract.json", [])

    tagged = [x for x in ev["rows"] if x["outcome"] != "untagged"]
    vals = {
        "link_table": report.to_md(r),
        "maps_table": report.maps_table(),
        "distinct_maps": r["distinct_maps"],
        "community_maps": r["distinct_maps_community"],
        "links": r["links_distinct"],
        "alive": r["link_verdicts"].get("alive", 0),
        "dead": r["link_verdicts"].get("dead", 0),
        "blocked": r["link_verdicts"].get("blocked", 0),
        "unchecked": r["link_verdicts"].get("unchecked", 0),
        "rot_all": "%.1f%%" % (100 * r["dead_rate_of_checked"])
                   if r["dead_rate_of_checked"] is not None else "n/a",
        "rot_community": "%.1f%%" % (100 * r["community_dead_rate"])
                         if r["community_dead_rate"] is not None else "n/a",
        "recoverable": r["maps_recoverable"],
        "lost": r["maps_lost"],
        "nolinks": r["maps_no_links"],
        "sized": r["maps_sized"],
        "bytes": report.human(r["bytes_known"]),
        "mean": report.human(r["mean_map_bytes"]),
        "proj_recoverable": report.human(r["bytes_projected_all_recoverable"]),
        "proj_all": report.human(r["bytes_projected_whole_catalogue"]),
        "only_unfetchable": r["maps_only_unfetchable_hosts"],
        "n_scanned": scan.get("maps", 0),
        "decided_raw": scan.get("decided_raw", 0),
        "decided_debiased": scan.get("decided_debiased", 0),
        "decided_entities": scan.get("decided_entities", 0),
        "verdicts_entities": ", ".join(
            "%s %d" % (k, v) for k, v in sorted(
                scan.get("verdicts_entities", {}).items(), key=lambda kv: -kv[1])),
        "tagged": len(tagged),
        "agree": len([x for x in tagged if x["outcome"] == "agree"]),
        "missed": len([x for x in tagged if x["outcome"].startswith("missed")]),
        "fetched_ok": len([f for f in fetch if f.get("status") == "ok"]),
        "fetched_total": len(fetch),
        "fetched_bytes": report.human(sum(f.get("size") or 0 for f in fetch
                                          if f.get("status") == "ok")),
        "extracted": len(extract),
        "extract_clean": len([e for e in extract if not e["errors"] and e["mods"]]),
        "by_source": " · ".join("%s %d" % (k, v) for k, v in r["by_source"].items()),
        "tags": " · ".join("%s %d" % (k, v) for k, v in sorted(
            r["tags"].items(), key=lambda kv: -kv[1]) if not k.startswith("archive_")),
    }
    with open(TMPL, encoding="utf-8") as fh:
        text = fh.read()
    missing = set(re.findall(r"\{\{(\w+)\}\}", text)) - set(vals)
    if missing:
        print("WARNING: no value for", sorted(missing))
    for k, v in vals.items():
        text = text.replace("{{%s}}" % k, str(v))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote", OUT, "(%d bytes)" % len(text))


if __name__ == "__main__":
    main()
