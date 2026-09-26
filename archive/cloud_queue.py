#!/usr/bin/env python3
"""Rank the maps nobody has fetched yet, for a fetch run away from B's PC (2026-09-26).

The cloud run rebuilds the catalogue from scratch, so it has no `originals/` to tell it what
B already holds. The repo does: every map that went through the pipeline has a manifest in
`archive/manifests/` naming its original's download URL and title, and every shortlist that
was fetched is committed. A catalogue map counts as held when any of these matches:

  * one of its links is a manifest's `archive.source_url` (the exact file we fetched)
  * its norm is the normalised manifest title, bsp name, or a committed shortlist line
  * an original is already in this run's `originals/` (fetch.py's own sidecar)

What is left, with a robot-fetchable link that is not known dead, is written most popular
first (browser_queue.popularity) as a shortlist fetch.py reads.

    python archive/cloud_queue.py --out /home/user/zwork/queue.txt [--limit 200]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import browser_queue  # noqa: E402
import fetch  # noqa: E402
from lib import catalogue, mega  # noqa: E402


def pc_holdings():
    urls, norms = set(), set()
    for f in glob.glob(os.path.join(HERE, "manifests", "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except ValueError:
            continue
        a = d.get("archive") or {}
        if a.get("source_url"):
            urls.add(a["source_url"].split("#")[0].rstrip("/"))
        for n in (d.get("title"), d.get("map")):
            if n:
                norms.add(catalogue.normalise(n))
    for f in glob.glob(os.path.join(HERE, "shortlist*.txt")):
        for ln in open(f, encoding="utf-8"):
            ln = ln.split("#")[0].strip()
            if ln:
                norms.add(catalogue.normalise(ln))
    return urls, norms


def fetchable(link):
    if link["verdict"] == "dead" or browser_queue.browser_group(link):
        return False
    host = (link["host"] or "").lower()
    if "mega." in host and not mega.parse(link["url"]):
        return False
    base = ".".join(host.removeprefix("www.").split(".")[-2:])
    return base not in fetch.UNFETCHABLE and host not in fetch.UNFETCHABLE


def build(db):
    urls, norms = pc_holdings()
    out, stats = [], {"catalogued": 0, "held_pc": 0, "held_here": 0, "no_robot_link": 0}
    for norm, rows in browser_queue._maps(db).items():
        stats["catalogued"] += 1
        links = [l for r in rows for l in browser_queue._links(db, r["key"])]
        if norm in norms or any(l["url"].split("#")[0].rstrip("/") in urls for l in links):
            stats["held_pc"] += 1
            continue
        if browser_queue.held(norm):
            stats["held_here"] += 1
            continue
        if not any(fetchable(l) for l in links):
            stats["no_robot_link"] += 1
            continue
        size = max((l["size"] or 0 for l in links), default=0)
        out.append({"norm": norm, "name": rows[0]["name"], "pop": browser_queue.popularity(rows),
                    "size": size})
    out.sort(key=lambda m: (-m["pop"], m["norm"]))
    stats["to_fetch"] = len(out)
    return out, stats


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    q, stats = build(catalogue.connect())
    if args.limit:
        q = q[:args.limit]
    with open(args.out, "w", encoding="utf-8") as fh:
        for m in q:
            fh.write("%s  # pop %d, %s\n" % (m["name"], m["pop"], fetch.human(m["size"])))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
