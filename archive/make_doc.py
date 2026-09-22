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
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
sys.path.insert(0, HERE)
import report  # noqa: E402
import popular  # noqa: E402
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

    # Sections 1-4 describe the 14-map MVP run and are measured over exactly that set
    # (scan.json's rows); later runs get their own section and their own reports.
    mvp_maps = {row["map"] for row in scan.get("rows", [])}
    extract = [e for e in extract if any(m["map"] in mvp_maps for m in e.get("mods", []))]         if mvp_maps else extract
    mvp_norms = {e["norm"] for e in extract}
    fetch = [f for f in fetch if f.get("norm") in mvp_norms] if mvp_norms else fetch
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
        "tool_sha": (scan.get("tool") or {}).get("sha256", "?")[:12],
        "tool_mtime": (scan.get("tool") or {}).get("mtime", "?"),
        "decided": scan.get("decided", 0),
        "finish_found": scan.get("finish_found", 0),
        "needs_human": scan.get("needs_human", 0),
        "stock_names": scan.get("stock_names", 0),
        "corpus_ignored": scan.get("corpus_ignored_n", 0),
        "verdicts": ", ".join(
            "%s %d" % (k, v) for k, v in sorted(
                scan.get("verdicts", {}).items(), key=lambda kv: -kv[1])),
        "verdicts_stock_only": ", ".join(
            "%s %d" % (k, v) for k, v in sorted(
                scan.get("verdicts_stock_only", {}).items(), key=lambda kv: -kv[1])),
        "tagged": len(tagged),
        "agree": len([x for x in tagged if x["outcome"] == "agree"]),
        "missed": len([x for x in tagged if x["outcome"].startswith("missed")]),
        "fetched_ok": len([f for f in fetch if f.get("status") == "ok"]),
        # the MVP run attempted 15 and lost ZHunterZ (MEGA-only then); frozen here
        # because a later run re-fetched it from MediaFire.
        "fetched_total": max(len(fetch), 15) if mvp_maps else len(fetch),
        "fetched_bytes": report.human(sum(f.get("size") or 0 for f in fetch
                                          if f.get("status") == "ok")),
        "extracted": len(extract),
        "extract_clean": len([e for e in extract if not e["errors"] and e["mods"]]),
        "n_drive": sum(h["links"] for h in r["by_host"]
                       if "google" in (h["host"] or "")),
        "n_onedrive": sum(h["links"] for h in r["by_host"]
                          if "onedrive" in (h["host"] or "") or "1drv" in (h["host"] or "")),
        "n_mega": sum(h["links"] for h in r["by_host"] if "mega" in (h["host"] or "")),
        "n_mediafire": sum(h["links"] for h in r["by_host"]
                           if "mediafire" in (h["host"] or "")),
        "only_mega": r["maps_only_mega"],
        "rot_upper": "%.1f%%" % (100 * r["community_dead_or_blocked_rate"])
                     if r.get("community_dead_or_blocked_rate") is not None else "n/a",
        "com_alive": r.get("community_alive", 0),
        "com_dead": r.get("community_dead", 0),
        "com_blocked": r.get("community_blocked", 0),
        "mediafire_rot": r.get("host_rot", {}).get("mediafire.com", "n/a"),
        "mega_rot": r.get("host_rot", {}).get("mega.nz", "n/a"),
        "by_source": " · ".join("%s %d" % (k, v) for k, v in r["by_source"].items()),
        "tags": " · ".join("%s %d" % (k, v) for k, v in sorted(
            r["tags"].items(), key=lambda kv: -kv[1]) if not k.startswith("archive_")),
    }
    vals.update(popular.doc_values())
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
