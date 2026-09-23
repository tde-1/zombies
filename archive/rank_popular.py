#!/usr/bin/env python3
"""Rank the catalogue by popularity and write a fetchable shortlist.

2026-09-22 (evening): "download another ~50 popular maps". The signals the crawlers
already hold, no new traffic:

  * callofdutyrepo post views        (extra.views, 1,388 posts)
  * UGX-Mods release-thread views    (extra.views, 605 threads)
  * callofdutyrepo `top100` / `top_100` tag
  * archive.org item downloads       (extra.downloads, only 37 items -- file dumps)

score = max(codrepo views, ugx views) (+25% if tagged top100). A map is only a candidate
when it has a link fetch.py can actually pull (MediaFire or archive.org, verdict alive),
a known size under --max-mb, is not already in originals/, and is not a T4M-required
map (we run the stock exe) or a multi-map pack.

  python rank_popular.py --n 60 --out shortlist3.txt
"""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
FETCHABLE = ("mediafire.com", "archive.org")
SKIP_NAME = re.compile(r"\b(map ?pack|pack|bundle|collection|mod tools|t4m|prefab|weapon|"
                       r"script|tutorial|patch|fix only|zombie ?mod)\b", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--max-mb", type=int, default=1400)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "shortlist3.txt"))
    ap.add_argument("--report", default="popular.json",
                    help="reports/<name> to write the ranking to (tranche 2: popular2.json, so "
                         "archive.md s10's popular.json stays the record of the first 64)")
    ap.add_argument("--min-mb", type=int, default=20)
    args = ap.parse_args()

    db = catalogue.connect()
    held = set(os.listdir(os.path.join(WORK, "originals"))) if os.path.isdir(os.path.join(WORK, "originals")) else set()
    by = {}
    for r in db.execute("SELECT key,source,name,norm,tags,extra FROM maps"):
        d = by.setdefault(r["norm"], {"norm": r["norm"], "names": [], "views": 0, "src": None,
                                      "tags": set(), "keys": []})
        d["keys"].append(r["key"])
        d["names"].append(r["name"])
        d["tags"].update(json.loads(r["tags"] or "[]"))
        ex = json.loads(r["extra"] or "{}")
        v = ex.get("views")
        try:
            v = int(str(v).replace(",", "")) if v is not None else 0
        except ValueError:
            v = 0
        if v > d["views"]:
            d["views"], d["src"] = v, r["source"]
    rows = []
    for d in by.values():
        if d["norm"] in held or not d["norm"]:
            continue
        if "t4m_req" in d["tags"] or "multiplayer_map" in d["tags"]:
            continue
        if any(SKIP_NAME.search(n) for n in d["names"]):
            continue
        best = None
        for k in d["keys"]:
            for l in db.execute("SELECT url,host,verdict,size FROM links WHERE map_key=?", (k,)):
                host = (l["host"] or "").removeprefix("www.")
                if not any(host == h or host.endswith("." + h) for h in FETCHABLE):
                    continue
                if host.startswith("download"):
                    continue
                if l["verdict"] != "alive" or not l["size"]:
                    continue
                if "UpdaterExe" in l["url"] or "ugx-mod-standalone" in l["url"]:
                    continue
                if l["size"] > args.max_mb * 2**20 or l["size"] < args.min_mb * 2**20:
                    continue
                if best is None or l["size"] > best["size"]:
                    best = {"url": l["url"], "host": host, "size": l["size"]}
        if not best:
            continue
        score = d["views"] * (1.25 if d["tags"] & {"top100", "top_100"} else 1.0)
        if score <= 0:
            continue
        rows.append({"norm": d["norm"], "name": d["names"][0], "views": d["views"],
                     "views_source": d["src"], "top100": bool(d["tags"] & {"top100", "top_100"}),
                     "score": round(score), "link": best, "tags": sorted(d["tags"])})
    rows.sort(key=lambda r: -r["score"])
    rows = rows[:args.n]
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("# rank_popular.py %s -- popularity-ranked, fetchable (MediaFire/archive.org alive)\n"
                 % __import__("time").strftime("%Y-%m-%d"))
        for r in rows:
            fh.write("%s  # %s views (%s)%s, %.0f MB, %s\n" % (r["norm"], r["views"], r["views_source"],
                     " top100" if r["top100"] else "", r["link"]["size"] / 2**20, r["link"]["host"]))
    json.dump(rows, open(os.path.join(WORK, "reports", args.report), "w", encoding="utf-8"), indent=1)
    for i, r in enumerate(rows, 1):
        print("%2d %-40s %6d %-8s %s %5.0f MB %s" % (i, r["name"][:40], r["views"], r["views_source"],
              "T" if r["top100"] else " ", r["link"]["size"] / 2**20, r["link"]["host"]))
    print("total %.1f GB" % (sum(r["link"]["size"] for r in rows) / 2**30))


if __name__ == "__main__":
    main()
