#!/usr/bin/env python3
"""Crawl ModDB's Call of Duty: World at War addons.

ModDB matters for two reasons the other sources cannot cover: it still hosts the files
itself (so its links do not rot the way a 2011 MediaFire link does), and it publishes
the **file size and an MD5** on every addon page, which the link report can use without
downloading anything.

Index pass is one request per 30 addons; the detail pass is one request per addon and
is bounded by --details.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import catalogue, net  # noqa: E402

SOURCE = "moddb"
BASE = "https://www.moddb.com"
INDEX = BASE + "/games/call-of-duty-world-at-war/addons"

ROW_RE = re.compile(
    r'<div class="row rowcontent[^"]*">.*?'
    r'<h4><a href="(/games/call-of-duty-world-at-war/addons/[^"]+)">(.*?)</a></h4>.*?'
    r'<time datetime="([^"]+)".*?'
    r'<span class="subheading">\s*(.*?)\s*(?:<a|</span>).*?'
    r"<p>(.*?)</p>", re.S)
TAGSTRIP = re.compile(r"<[^>]+>")
SIZE_RE = re.compile(r"\(([\d,.]+)\s*(bytes|KB|MB|GB)\)", re.I)
MD5_RE = re.compile(r"MD5 Hash\s*</h5>\s*<[^>]*>\s*([0-9a-f]{32})", re.I | re.S)
FILENAME_RE = re.compile(r"Filename\s*</h5>\s*<[^>]*>\s*([^<]+)<", re.I | re.S)
AUTHOR_RE = re.compile(r'<h5>Uploader</h5>.*?<a href="([^"]+)"[^>]*>([^<]+)</a>', re.S | re.I)
MIRROR_RE = re.compile(r'href="(/downloads/(?:start|mirror)/\d+[^"]*)"')
UNITS = {"BYTES": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}
# Zombies maps only; ModDB's WaW section is mostly skins, weapon packs and SP maps.
ZOMBIE = re.compile(r"zombie|nazi[_ ]zombie|undead|nacht|verruckt|der riese|shi no numa", re.I)


def text(s):
    return re.sub(r"\s+", " ", html.unescape(TAGSTRIP.sub(" ", s or ""))).strip()


def crawl_index(db, ps, max_pages=25):
    seen = set()
    n = zomb = 0
    for page in range(1, max_pages + 1):
        url = INDEX if page == 1 else INDEX + "?page=%d" % page
        try:
            t = ps.get(url)
        except net.Dropped as exc:
            ps.log("[moddb] stopping: %s" % exc)
            break
        if t is None:
            break
        rows = ROW_RE.findall(t)
        if not rows:
            break
        fresh = 0
        for path, title, when, category, blurb in rows:
            if path in seen:
                continue
            seen.add(path)
            fresh += 1
            n += 1
            title, category, blurb = text(title), text(category), text(blurb)
            is_z = bool(ZOMBIE.search(title + " " + blurb + " " + category))
            if not is_z:
                continue
            zomb += 1
            catalogue.put_map(db, SOURCE, title, source_url=BASE + path,
                              released=when[:10], description=blurb or None,
                              tags=["moddb", category.lower().replace(" ", "_")],
                              extra={"path": path, "category": category})
        db.commit()
        if fresh == 0:
            break
    ps.log("[moddb] index: %d addons seen, %d look like zombies content" % (n, zomb))
    catalogue.note(db, "crawl:moddb:index", "addons=%d zombies=%d" % (n, zomb))
    return zomb


def crawl_details(db, ps, limit=60):
    rows = [r for r in db.execute(
        "SELECT key,name,source_url,extra FROM maps WHERE source=?", (SOURCE,))
        if '"detail": true' not in (r["extra"] or "")]
    done = 0
    for row in rows[:limit]:
        try:
            t = ps.get(row["source_url"])
        except net.Dropped as exc:
            ps.log("[moddb] stopping details: %s" % exc)
            break
        if t is None:
            continue
        extra = json.loads(row["extra"] or "{}")
        extra["detail"] = True
        m = SIZE_RE.search(t)
        if m:
            extra["size"] = int(float(m.group(1).replace(",", "")) * UNITS[m.group(2).upper()])
        m = MD5_RE.search(t)
        if m:
            extra["md5"] = m.group(1)
        m = FILENAME_RE.search(t)
        if m:
            extra["filename"] = m.group(1).strip()
        au = AUTHOR_RE.search(t)
        author = text(au.group(2)) if au else None
        desc = None
        dm = re.search(r'<div id="downloadsummary".*?<p>(.*?)</p>', t, re.S)
        if dm:
            desc = text(dm.group(1))[:4000]
        for mir in dict.fromkeys(MIRROR_RE.findall(t)):
            catalogue.put_link(db, row["key"], BASE + mir, label="ModDB")
            if extra.get("size"):
                db.execute("UPDATE links SET size=?, verdict='alive', status=200,"
                           " filename=?, checked=datetime('now')"
                           " WHERE url=? AND map_key=?",
                           (extra["size"], extra.get("filename"), BASE + mir, row["key"]))
        db.execute("UPDATE maps SET author=COALESCE(?,author),"
                   " description=COALESCE(?,description), extra=? WHERE key=?",
                   (author, desc, json.dumps(extra), row["key"]))
        db.commit()
        done += 1
    ps.log("[moddb] details: %d fetched" % done)
    return done


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=25)
    ap.add_argument("--details", type=int, default=60)
    a = ap.parse_args()
    db = catalogue.connect()
    ps = net.PoliteSession(log_name="crawl")
    crawl_index(db, ps, a.pages)
    if a.details:
        crawl_details(db, ps, a.details)
