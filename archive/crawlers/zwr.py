#!/usr/bin/env python3
"""Crawl the ZWR (zwr.gg) custom-map library.

One page holds the whole library: 27 per-letter <table>s of

    <tr><td>MAP NAME</td><td><a class="libbtn" href="...">MediaFire</a>...</td></tr>

and rows with no <a> carry the literal text "No Download Link available ?", which ZWR
says means the creator or a copyright claim removed it. That distinction matters for the
link report: a row with no link was never recoverable from here, which is not the same
failure as a link that has rotted.

One HTTP request for ~950 maps, which makes this the cheapest source by a wide margin.
"""

from __future__ import annotations

import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import catalogue, net  # noqa: E402

URL = "https://zwr.gg/custom-downloads/waw"
SOURCE = "zwr"

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S | re.I)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
A_RE = re.compile(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S | re.I)
TAG_RE = re.compile(r"<[^>]+>")


def text(s):
    return html.unescape(TAG_RE.sub("", s)).replace("\xa0", " ").strip()


def crawl(db, ps):
    page = ps.get(URL)
    if page is None:
        ps.log("[zwr] no page")
        return 0, 0
    # The library tables sit after the intro; every library link carries class="libbtn".
    maps = links = nolink = 0
    for rm in ROW_RE.finditer(page):
        cells = CELL_RE.findall(rm.group(1))
        if len(cells) < 2:
            continue
        name = text(cells[0])
        if not name or len(name) > 90:
            continue
        rhs = cells[1]
        anchors = [(u, text(l)) for u, l in A_RE.findall(rhs) if "libbtn" in rhs[:0] or True]
        anchors = [(u, l) for u, l in anchors if u.startswith("http")]
        rhs_text = text(rhs)
        if not anchors and "no download link" not in rhs_text.lower():
            continue           # not a library row (nav table, helper list, ...)
        key = catalogue.put_map(db, SOURCE, name, source_url=URL,
                                extra={"row_note": rhs_text if not anchors else None})
        maps += 1
        if not anchors:
            nolink += 1
        for u, label in anchors:
            catalogue.put_link(db, key, html.unescape(u), label=label or None)
            links += 1
    db.commit()
    ps.log("[zwr] %d maps, %d links, %d rows with no download link" % (maps, links, nolink))
    catalogue.note(db, "crawl:zwr", "maps=%d links=%d nolink=%d" % (maps, links, nolink))
    return maps, links


if __name__ == "__main__":
    db = catalogue.connect()
    crawl(db, net.PoliteSession(log_name="crawl"))
