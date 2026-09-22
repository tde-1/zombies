#!/usr/bin/env python3
"""Produce the link report: how many maps, how many are recoverable, how many GB.

Counting rules, stated because every number below depends on them:

  * A **map** is a distinct normalised name. The same map seen on ZWR, callofdutyrepo
    and UGX is one map, not three. Normalisation strips version tags but keeps bare
    numbers, so "Zombie Hotel 2" stays separate from "Zombie Hotel".
  * A map is **recoverable** if at least one of its links is `alive`. A map whose only
    links are `blocked` (a host that will not answer a robot) is NOT counted as
    recoverable and NOT counted as lost -- it is unknown, and reported as such.
  * **Bytes** are counted once per distinct URL, using the largest known size for that
    URL, and only for `alive` links. For a map with several live mirrors we count the
    largest single mirror, because that is what the archive would actually store.
  * Sizes from Google Drive are rounded by Drive itself; everything else is exact.
    The report says how much of the total is approximate.

  python report.py [--md]
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")


def human(n):
    if n is None:
        return "-"
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return "%.1f %s" % (n, u)
        n /= 1024.0


def build(db):
    r = {}
    r["by_source"] = {row["source"]: row["c"] for row in db.execute(
        "SELECT source, COUNT(*) c FROM maps GROUP BY source ORDER BY c DESC")}
    r["rows_total"] = sum(r["by_source"].values())
    r["distinct_maps"] = db.execute(
        "SELECT COUNT(DISTINCT norm) FROM maps").fetchone()[0]
    # archive.org rows are files inside dumps, not community releases; count separately
    r["distinct_maps_community"] = db.execute(
        "SELECT COUNT(DISTINCT norm) FROM maps WHERE source<>'archive.org'").fetchone()[0]

    # Only real map downloads count. `kind='prerequisite'` is the UGX Map Manager
    # installer and UGX Mod Standalone, which several sources list against every map
    # they apply to; counting them would inflate both the link total and "recoverable".
    r["links_total"] = db.execute(
        "SELECT COUNT(*) FROM links WHERE kind='download'").fetchone()[0]
    r["links_distinct"] = db.execute(
        "SELECT COUNT(DISTINCT url) FROM links WHERE kind='download'").fetchone()[0]
    r["links_prerequisite"] = db.execute(
        "SELECT COUNT(DISTINCT url) FROM links WHERE kind<>'download'").fetchone()[0]

    verdicts = collections.Counter()
    for row in db.execute("SELECT verdict, COUNT(DISTINCT url) c FROM links "
                          "WHERE kind='download' GROUP BY verdict"):
        verdicts[row["verdict"] or "unchecked"] = row["c"]
    r["link_verdicts"] = dict(verdicts)

    r["by_host"] = [dict(row) for row in db.execute(
        "SELECT host, COUNT(DISTINCT url) links,"
        " SUM(CASE WHEN verdict='alive' THEN 1 ELSE 0 END) alive,"
        " SUM(CASE WHEN verdict='dead' THEN 1 ELSE 0 END) dead,"
        " SUM(CASE WHEN verdict='blocked' THEN 1 ELSE 0 END) blocked,"
        " SUM(CASE WHEN verdict='unknown' THEN 1 ELSE 0 END) unknown,"
        " SUM(CASE WHEN verdict IS NULL THEN 1 ELSE 0 END) unchecked"
        " FROM (SELECT DISTINCT url, host, verdict FROM links WHERE kind='download')"
        " GROUP BY host ORDER BY links DESC")]

    # ---- per map: best verdict and best known size
    per_map = {}
    for row in db.execute(
            "SELECT m.norm norm, l.url url, l.verdict verdict, l.size size,"
            "       l.size_exact size_exact, l.host host"
            "  FROM maps m JOIN links l ON l.map_key = m.key"
            " WHERE l.kind='download'"):
        d = per_map.setdefault(row["norm"], {"alive": 0, "dead": 0, "blocked": 0,
                                             "unknown": 0, "unchecked": 0,
                                             "best": 0, "approx": False, "hosts": set()})
        d[row["verdict"] or "unchecked"] += 1
        d["hosts"].add(row["host"])
        if row["verdict"] == "alive" and (row["size"] or 0) > d["best"]:
            d["best"] = row["size"] or 0
            d["approx"] = not row["size_exact"]

    with_links = len(per_map)
    recoverable = [n for n, d in per_map.items() if d["alive"]]
    lost = [n for n, d in per_map.items()
            if not d["alive"] and not d["unknown"] and not d["blocked"] and not d["unchecked"]
            and d["dead"]]
    unknown_only = [n for n, d in per_map.items()
                    if not d["alive"] and (d["unknown"] or d["blocked"] or d["unchecked"])]
    no_links = r["distinct_maps"] - with_links

    sized = [d["best"] for d in per_map.values() if d["best"]]
    total_bytes = sum(sized)
    approx_bytes = sum(d["best"] for d in per_map.values() if d["best"] and d["approx"])
    mean = (total_bytes / len(sized)) if sized else 0

    r["maps_with_links"] = with_links
    r["maps_no_links"] = no_links
    r["maps_recoverable"] = len(recoverable)
    r["maps_lost"] = len(lost)
    r["maps_unknown"] = len(unknown_only)
    r["maps_sized"] = len(sized)
    r["bytes_known"] = total_bytes
    r["bytes_approx_part"] = approx_bytes
    r["mean_map_bytes"] = mean
    # Projection: every recoverable map we could not size, at the measured mean.
    r["bytes_projected_all_recoverable"] = mean * len(recoverable)
    r["bytes_projected_whole_catalogue"] = mean * r["distinct_maps_community"]

    checked = sum(v for k, v in verdicts.items() if k in ("alive", "dead"))
    r["dead_rate_of_checked"] = (verdicts["dead"] / checked) if checked else None

    # Community links only: archive.org's file list is pre-verified and 572 rows of it
    # would drown the rot figure that actually matters.
    com = [h for h in r["by_host"] if h["host"] != "archive.org"]
    ca, cd = sum(h["alive"] or 0 for h in com), sum(h["dead"] or 0 for h in com)
    r["community_links"] = sum(h["links"] for h in com)
    r["community_alive"] = ca
    r["community_dead"] = cd
    cb = sum(h["blocked"] or 0 for h in com)
    r["community_blocked"] = cb
    r["community_dead_rate"] = (cd / (ca + cd)) if (ca + cd) else None
    # Upper bound: every link a host refused to answer for turns out to be dead too.
    # The truth is between the two, and the gap IS the Google/Microsoft sign-in wall.
    r["community_dead_or_blocked_rate"] = ((cd + cb) / (ca + cd + cb)
                                           if (ca + cd + cb) else None)
    r["host_rot"] = {}
    for h in r["by_host"]:
        a2, d2 = h["alive"] or 0, h["dead"] or 0
        if a2 + d2 >= 20:
            r["host_rot"][h["host"]] = "%.1f%%" % (100 * d2 / (a2 + d2))

    # Maps we could catalogue but could not fetch even though a link is alive.
    unfetchable_hosts = {"mega.nz", "mega.co.nz", "drive.google.com", "docs.google.com"}
    only_unfetchable = []
    for n, d in per_map.items():
        hosts = {h for h in d["hosts"] if h}
        if hosts and hosts <= unfetchable_hosts:
            only_unfetchable.append(n)
    r["maps_only_unfetchable_hosts"] = len(only_unfetchable)
    r["maps_only_mega"] = len([n for n, d in per_map.items()
                               if d["hosts"] and all(h and "mega" in h for h in d["hosts"])])

    r["tags"] = {}
    for row in db.execute("SELECT tags FROM maps WHERE tags IS NOT NULL"):
        for t in json.loads(row["tags"]):
            r["tags"][t] = r["tags"].get(t, 0) + 1
    return r


def to_md(r):
    L = []
    A = L.append
    A("| Number | Value |")
    A("|---|---|")
    A("| Catalogue rows crawled | %d |" % r["rows_total"])
    A("| Distinct maps (all sources) | **%d** |" % r["distinct_maps"])
    A("| Distinct maps (community sites only) | **%d** |" % r["distinct_maps_community"])
    A("| Download links catalogued (distinct URLs) | **%d** |" % r["links_distinct"])
    v = r["link_verdicts"]
    A("| Links alive | **%d** |" % v.get("alive", 0))
    A("| Links dead | **%d** |" % v.get("dead", 0))
    A("| Links blocked (host will not answer a robot) | %d |" % v.get("blocked", 0))
    A("| Links unknown | %d |" % v.get("unknown", 0))
    A("| Links unchecked | %d |" % v.get("unchecked", 0))
    if r["dead_rate_of_checked"] is not None:
        A("| **Link rot**, all sources (dead / [dead+alive]) | **%.1f%%** |"
          % (100 * r["dead_rate_of_checked"]))
    if r["community_dead_rate"] is not None:
        A("| **Link rot on the community sites**, of links we could check | **%.1f%%** |"
          % (100 * r["community_dead_rate"]))
        A("| Same, if every sign-in-walled link is also dead (upper bound) | **%.1f%%** |"
          % (100 * r["community_dead_or_blocked_rate"]))
    for h, v in sorted(r.get("host_rot", {}).items()):
        A("| &nbsp;&nbsp;rot at `%s` | %s |" % (h, v))
    A("| Maps whose only host is MEGA or Drive (catalogued, not fetchable by us) | %d |"
      % r["maps_only_unfetchable_hosts"])
    A("| Maps with at least one live link (**recoverable**) | **%d** |" % r["maps_recoverable"])
    A("| Maps whose every link is dead (**lost so far**) | **%d** |" % r["maps_lost"])
    A("| Maps we could not decide | %d |" % r["maps_unknown"])
    A("| Maps with no download link at all | %d |" % r["maps_no_links"])
    A("| Maps with a measured size | %d |" % r["maps_sized"])
    A("| **Measured bytes** (largest live mirror per map) | **%s** |" % human(r["bytes_known"]))
    A("| of which Drive-rounded | %s |" % human(r["bytes_approx_part"]))
    A("| Mean map size | %s |" % human(r["mean_map_bytes"]))
    A("| Projected: every recoverable map | **%s** |"
      % human(r["bytes_projected_all_recoverable"]))
    A("| Projected: the whole community catalogue | **%s** |"
      % human(r["bytes_projected_whole_catalogue"]))
    L.append("")
    L.append("| Host | Links | Alive | Dead | Blocked | Unknown | Unchecked |")
    L.append("|---|---:|---:|---:|---:|---:|---:|")
    for h in r["by_host"][:14]:
        L.append("| %s | %d | %d | %d | %d | %d | %d |"
                 % (h["host"], h["links"], h["alive"] or 0, h["dead"] or 0,
                    h["blocked"] or 0, h["unknown"] or 0, h["unchecked"] or 0))
    return "\n".join(L)


_BRACKET = re.compile(r"^\s*[\[(][^\])]*[\])]\s*")
_VER_TAIL = re.compile(r"\s*[vV]?\d+(?:[._]\d+)*\s*$")


def display_name(db, norm, fallback):
    """The nicest of the names our sources gave this map.

    Sources disagree in ways that look sloppy in a table: ZWR shouts ("DESERT"), UGX
    prefixes its thread titles ("[Manager] Leviathan V1.2"). Prefer a name that is not
    all-caps, has no `[tag]` prefix and no trailing version.
    """
    names = [r["name"] for r in db.execute(
        "SELECT name FROM maps WHERE norm=?", (norm,))] or [fallback]
    def score(n):
        clean = _VER_TAIL.sub("", _BRACKET.sub("", n)).strip()
        return (0 if not _BRACKET.match(n) else 1,
                0 if clean != clean.upper() else 1,
                len(clean))
    best = min(names, key=score)
    return _VER_TAIL.sub("", _BRACKET.sub("", best)).strip() or best


def maps_table():
    """The per-map results table for docs/kickstart/archive.md."""
    db = catalogue.connect()

    def load(name):
        p = os.path.join(WORK, "reports", name)
        return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None
    fetch = {r["norm"]: r for r in (load("fetch.json") or [])}
    extract = load("extract.json") or []
    scan = load("scan.json") or {"rows": []}
    ev = {r["map"]: r for r in (load("evaluate.json") or {"rows": []})["rows"]}
    byscan = {r["map"]: r for r in scan["rows"]}
    L = ["| Map | Original | Size | Installer | mods/ | bsp | Scanner verdict | Community tag | Match |",
         "|---|---|---|---:|---|---|---|---|---|"]
    for e in sorted(extract, key=lambda e: e["norm"]):
        f = fetch.get(e["norm"], {})
        for m in e["mods"]:
            # Section 3 is the 14-map MVP run, and scan.json is its record. Maps added
            # later (the popular-50 run, section 10) have their own table.
            if byscan and m["map"] not in byscan:
                continue
            s = byscan.get(m["map"], {})
            v = ev.get(m["map"], {})
            tags = ",".join(t for t in v.get("tags", [])
                            if t in ("easter_egg", "buyable_ending", "bossfight_ending"))
            L.append("| %s | `%s` | %s | %s | `%s` | `%s` | %s | %s | %s |"
                     % (display_name(db, e["norm"], f.get("name") or e["norm"]),
                        e["original"],
                        human(e["original_size"]), e["installer_kind"],
                        m["map"], m.get("bsp"),
                        s.get("verdict", "-"), tags or "-", v.get("outcome", "-")))
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", action="store_true")
    ap.add_argument("--maps", action="store_true")
    a = ap.parse_args()
    if a.maps:
        print(maps_table())
        return
    db = catalogue.connect()
    r = build(db)
    os.makedirs(os.path.join(WORK, "reports"), exist_ok=True)
    with open(os.path.join(WORK, "reports", "link-report.json"), "w", encoding="utf-8") as fh:
        json.dump(r, fh, indent=2)
    if a.md:
        print(to_md(r))
    else:
        for k, val in r.items():
            if k in ("by_host", "tags"):
                continue
            print("%-38s %s" % (k, val))
        print("\ntags:", r["tags"])


if __name__ == "__main__":
    main()
