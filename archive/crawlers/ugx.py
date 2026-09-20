#!/usr/bin/env python3
"""Crawl the UGX-Mods map-releases board (board 29).

UGX's Map Manager list is inside the app, not on the site, so the board index is the
crawlable face of UGX. It is the best source for two fields the other sites guess at:
the **author** (the thread's poster) and the **real release date** (the thread's post
date, not a repo's re-upload date).

The index is SMF: 20 topics per page at /forum/map-releases/29/<offset>. Thread bodies
are fetched only for maps we actually want (--threads), because they are one request
each and the index already carries name + author + date.

UGX Rule 11 forbids re-uploading a *modified* map without permission (vault 04 section 6).
Nothing here uploads anything; the crawler reads public thread listings only, at one
request every few seconds.
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

SOURCE = "ugx"
BOARD = "https://www.ugx-mods.com/forum/map-releases/29/"
PER_PAGE = 20

ROW_RE = re.compile(
    r'<h3 class="subject-topic-link"><a href="([^"]+)">(.*?)</a>.*?'
    r'<span class="sub_info">by <a[^>]*>(.*?)</a>.*?'
    r'<span class="creator-post-time"><span title="([^"]*)"', re.S)
STATS_RE = re.compile(r'<td class="stats">(\d+) Replies<br />([\d,]+) Views')
TAGSTRIP = re.compile(r"<[^>]+>")
# Sticky/administrative threads that are not map releases.
NOT_A_MAP = re.compile(r"requirements for release|how to get|rules|read this|announcement",
                       re.I)
DL_HOSTS = re.compile(
    r"mediafire\.com|mega\.nz|mega\.co\.nz|drive\.google\.com|docs\.google\.com|"
    r"dropbox\.com|onedrive\.live\.com|1drv\.ms|ugx-mods\.com/downloads|gamefront|"
    r"moddb\.com|zippyshare|sendspace|1fichier|pixeldrain|github\.com/[^\"]+/releases",
    re.I)


def text(s):
    return re.sub(r"\s+", " ", html.unescape(TAGSTRIP.sub(" ", s or ""))).strip()


def crawl_index(db, ps, max_pages=40):
    n = 0
    for page in range(max_pages):
        url = BOARD if page == 0 else BOARD + str(page * PER_PAGE)
        try:
            t = ps.get(url)
        except net.Dropped as exc:
            ps.log("[ugx] stopping: %s" % exc)
            break
        if t is None:
            break
        rows = ROW_RE.findall(t)
        if not rows:
            break
        stats = STATS_RE.findall(t)
        for i, (thread, title, author, when) in enumerate(rows):
            title = text(title)
            if not title or NOT_A_MAP.search(title):
                continue
            views = None
            if i < len(stats):
                views = int(stats[i][1].replace(",", ""))
            catalogue.put_map(db, SOURCE, title, source_url=thread,
                              author=text(author) or None, released=when or None,
                              extra={"thread": thread, "views": views})
            n += 1
        db.commit()
        if 'title="Next Page"' not in t:
            break
    ps.log("[ugx] index: %d release threads" % n)
    catalogue.note(db, "crawl:ugx:index", "threads=%d" % n)
    return n


def crawl_threads(db, ps, limit=0, only_norms=None):
    """Fetch thread bodies for download links + the release post as a description."""
    rows = list(db.execute(
        "SELECT key,name,norm,source_url,extra FROM maps WHERE source=? AND source_url IS NOT NULL",
        (SOURCE,)))
    if only_norms:
        want = set(only_norms)
        rows = [r for r in rows if r["norm"] in want]
    rows = [r for r in rows if '"body": true' not in (r["extra"] or "")]
    if limit:
        rows = rows[:limit]
    done = 0
    for row in rows:
        try:
            t = ps.get(row["source_url"])
        except net.Dropped as exc:
            ps.log("[ugx] stopping threads: %s" % exc)
            break
        if t is None:
            continue
        body = t
        i = body.find('class="post"')
        seg = body[i:i + 40000] if i > 0 else body
        desc = text(re.sub(r"<script.*?</script>", "", seg, flags=re.S))[:4000]
        links = [html.unescape(u) for u in re.findall(r'href="(https?://[^"]+)"', seg)
                 if DL_HOSTS.search(u)]
        for u in dict.fromkeys(links):
            catalogue.put_link(db, row["key"], u, label="ugx thread")
        extra = json.loads(row["extra"] or "{}")
        extra["body"] = True
        db.execute("UPDATE maps SET description=COALESCE(?,description), extra=? WHERE key=?",
                   (desc or None, json.dumps(extra), row["key"]))
        db.commit()
        done += 1
    ps.log("[ugx] threads: %d fetched" % done)
    return done


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--pages", type=int, default=40)
    a = ap.parse_args()
    db = catalogue.connect()
    ps = net.PoliteSession(log_name="crawl")
    crawl_index(db, ps, a.pages)
    if a.threads:
        crawl_threads(db, ps, a.threads)
