#!/usr/bin/env python3
"""Browser queue: the maps the robot must not (or cannot) fetch, as a checklist for B.

Some hosts are off-limits to fetch.py by rule, not by bug: zombiemodding.com is
robots.txt "Disallow: /", Google Drive's only working endpoint is robots-disallowed,
OneDrive/SharePoint and HTML-answering Dropbox links need a real browser, a MediaFire
page that answered a captcha wants a human, and a MEGA folder holding several files is
a choice a human should make. Those links are still how most lost maps survive, so
instead of dropping them we hand them to B, who downloads them in her own browser into
`<work>/browser-drop/<norm>/`; ingest_browser.py then hashes, scans and files them
exactly as fetch.py would.

A map is queued when it has no original yet AND none of its links is a robot-fetchable
candidate that is not known-dead -- if fetch.py can still get it, it should. Only links
not known-dead are listed. `--fetch-report reports/fetch.json` adds maps whose robot
fetch failed in a browser-shaped way (captcha, HTML interstitial, "folder with").

  python browser_queue.py
  python browser_queue.py --fetch-report C:\\...\\reports\\fetch.json --zombiemodding-titles
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402
import fetch  # noqa: E402  (WORK, ORIGINALS, SAFE, all_links, human -- nothing that downloads)

WORK = fetch.WORK
DROP = os.path.join(WORK, "browser-drop")

# host suffix -> checklist group. Matched on the host or any parent domain.
BROWSER_HOSTS = {
    "zombiemodding.com": "ZombieModding (robots.txt Disallow: /)",
    "drive.google.com": "Google Drive",
    "docs.google.com": "Google Drive",
    "drive.usercontent.google.com": "Google Drive",
    "1drv.ms": "OneDrive",
    "onedrive.live.com": "OneDrive",
    "sharepoint.com": "OneDrive",
}
# A failure that a human in a browser gets past and a robot should not try to.
BROWSER_ERR = re.compile(r"captcha|interstitial|folder with|got an HTML page|non-browser", re.I)
SOURCE_ORDER = {"zwr": 0, "codrepo": 1, "ugx": 2}


def _host(r):
    return (r["host"] or catalogue.host_of(r["url"]) or "").lower().removeprefix("www.")


def browser_group(link, err=None):
    """The checklist group for a link the robot must leave to a browser, else None.
    `err` is a fresh error from a fetch report, which beats the stored one."""
    host = _host(link)
    for suffix, group in BROWSER_HOSTS.items():
        if host == suffix or host.endswith("." + suffix):
            return group
    e = err or link["error"] or ""
    ctype = (link["content_type"] or "").lower() if "content_type" in link.keys() else ""
    if "dropbox" in host and ("text/html" in ctype or re.search(r"\bhtml\b", e, re.I)):
        return "Dropbox (answers HTML)"
    if BROWSER_ERR.search(e):
        if "mega" in host:
            return "MEGA folder"
        if "mediafire" in host:
            return "MediaFire (captcha / interstitial)"
        return "Browser-only: " + host
    return None


def held(norm):
    d = os.path.join(fetch.ORIGINALS, fetch.SAFE.sub("_", norm))
    return os.path.isdir(d) and any(f.endswith(".meta.json") for f in os.listdir(d))


def _links(db, key):
    rows = db.execute("SELECT url,host,verdict,size,size_exact,filename,final_url,error,"
                      "content_type FROM links WHERE map_key=?", (key,))
    return [r for r in rows if "UpdaterExe" not in r["url"]
            and "ugx-mod-standalone" not in r["url"]]   # same filter as fetch.all_links


def _maps(db):
    by = {}
    for r in db.execute("SELECT key,source,name,norm,source_url,tags,extra FROM maps"):
        if r["norm"]:
            by.setdefault(r["norm"], []).append(r)
    for rows in by.values():
        rows.sort(key=lambda r: SOURCE_ORDER.get(r["source"], 3))
    return by


def popularity(rows):
    """rank_popular.py's signal, simplified: max views across sightings, +25% if top100."""
    views, tags = 0, set()
    for r in rows:
        try:
            tags.update(json.loads(r["tags"] or "[]"))
            v = json.loads(r["extra"] or "{}").get("views")
            views = max(views, int(str(v).replace(",", "")) if v is not None else 0)
        except (ValueError, TypeError, AttributeError):
            pass
    return round(views * (1.25 if tags & {"top100", "top_100"} else 1.0))


def load_report(path):
    """fetch.py's reports/fetch.json: a list of {norm, status, link?, ...}; failures read
    "cannot resolve: <err>" / "download failed: <err>". Returns {norm: (link, err)} for
    the browser-shaped ones."""
    out = {}
    with open(path, encoding="utf-8") as fh:
        rows = json.load(fh)
    for r in rows:
        st = r.get("status") or ""
        if r.get("norm") and st != "ok" and BROWSER_ERR.search(st):
            out[r["norm"]] = (r.get("link"), st)
    return out


def build(db, report=None, titles=False, titles_max=300):
    """Returns {"items": [...], "titles": [...]} -- one item per browser link."""
    report = report or {}
    items, titles_out = [], []
    for norm, rows in sorted(_maps(db).items()):
        if held(norm):
            continue
        rep_url, rep_err = report.get(norm, (None, None))
        browser, robot_ok, any_live = [], False, False
        for row in rows:
            for l in _links(db, row["key"]):
                err = rep_err if l["url"] == rep_url else None
                group = browser_group(l, err)
                dead = l["verdict"] == "dead"
                any_live |= not dead
                if group:
                    if not dead:
                        browser.append((group, row, l, err or l["error"]))
                elif not dead:
                    robot_ok = True
        if not any_live:
            if titles:
                titles_out.append({"norm": norm, "name": rows[0]["name"],
                                   "sources": sorted({r["source"] for r in rows}),
                                   "source_page": rows[0]["source_url"],
                                   "popularity": popularity(rows)})
            continue
        if robot_ok and norm not in report:
            continue
        seen = set()
        for group, row, l, err in browser:
            if l["url"] in seen:
                continue
            seen.add(l["url"])
            items.append({
                "group": group, "map": rows[0]["name"], "norm": norm,
                "folder": fetch.SAFE.sub("_", norm),
                "catalogue_source": row["source"], "source_page": row["source_url"],
                "url": l["url"], "host": _host(l), "verdict": l["verdict"],
                "size": l["size"], "size_exact": bool(l["size_exact"]) if l["size"] else False,
                "size_human": fetch.human(l["size"]) if l["size"] else None,
                "filename": l["filename"], "why": err,
            })
    items.sort(key=lambda i: (i["group"], i["map"].lower()))
    titles_out.sort(key=lambda t: (-t["popularity"], t["name"].lower()))
    return {"items": items, "titles": titles_out[:titles_max]}


def write_md(q, path):
    L = ["# Browser queue (%s)" % time.strftime("%Y-%m-%d"), "",
         "Links the robot must not fetch. Download each in your own browser and save it to",
         "`%s` -- the folder name is printed on every line; make the folder first."
         % os.path.join(DROP, "<norm>"),
         "Then run `python ingest_browser.py`, which hashes, AV-scans and files it.", "",
         "**Never run anything you download** -- not the installer, not a .bat, nothing. "
         "Save it and leave it.", "",
         "%d links for %d maps." % (len(q["items"]), len({i["norm"] for i in q["items"]})), ""]
    group = None
    for i in q["items"]:
        if i["group"] != group:
            group = i["group"]
            L += ["", "## " + group, ""]
        L.append("- [ ] **%s** -> folder `%s` | page: %s | %s | %s | %s"
                 % (i["map"], i["folder"], i["source_page"] or "-", i["url"],
                    (i["size_human"] + ("" if i["size_exact"] else " approx"))
                    if i["size_human"] else "size ?", i["filename"] or "filename ?"))
    if q["titles"]:
        L += ["", "## ZombieModding title search (no live link anywhere; most popular first)", "",
              "Search zombiemodding.com for these by name; save finds to the same drop folders.", ""]
        for t in q["titles"]:
            L.append("- [ ] %s -> folder `%s` (%s%s)"
                     % (t["name"], fetch.SAFE.sub("_", t["norm"]), ", ".join(t["sources"]),
                        ", %d views" % t["popularity"] if t["popularity"] else ""))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch-report", help="fetch.py's reports/fetch.json")
    ap.add_argument("--out-dir", default=os.path.join(WORK, "reports"))
    ap.add_argument("--zombiemodding-titles", action="store_true",
                    help="also list maps with no live link at all, by popularity")
    ap.add_argument("--titles-max", type=int, default=300)
    args = ap.parse_args(argv)
    db = catalogue.connect()
    report = load_report(args.fetch_report) if args.fetch_report else None
    q = build(db, report, args.zombiemodding_titles, args.titles_max)
    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, "browser-queue.json"), "w", encoding="utf-8") as fh:
        json.dump(q, fh, indent=1)
    write_md(q, os.path.join(args.out_dir, "browser-queue.md"))
    print("%d browser links for %d maps%s -> %s" % (
        len(q["items"]), len({i["norm"] for i in q["items"]}),
        ", %d titles" % len(q["titles"]) if q["titles"] else "", args.out_dir))
    return q


if __name__ == "__main__":
    main()
