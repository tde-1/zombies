#!/usr/bin/env python3
"""Crawl the Internet Archive for WaW custom-zombies items.

archive.org is the one source that answers the size question for free: `/metadata/<id>`
returns every file in an item with its exact byte size and its md5/sha1, so the GB total
for this source needs no HEAD requests at all and no bytes are transferred.

Two things are collected:
  * whole items that are map dumps (the 6.2 GB customcod.com collection and friends),
    recorded as one catalogue entry each with a per-file breakdown in `extra`;
  * individual map files inside those items, recorded as download links against the
    map name parsed from the filename -- which is how a dead MediaFire link gets a
    live replacement.

A broad `mediatype:(software OR data)` filter keeps out the enormous pile of Let's Play
videos that dominate a naive search for these words.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import catalogue, net  # noqa: E402

SOURCE = "archive.org"
SEARCH = "https://archive.org/advancedsearch.php"
FIELDS = ["identifier", "title", "creator", "date", "publicdate", "item_size",
          "mediatype", "downloads", "description"]

QUERIES = [
    '(zombie OR zombies) AND ("world at war" OR waw OR cod5) AND mediatype:(software OR data)',
    'nazi_zombie AND mediatype:(software OR data)',
    '"custom zombie maps" AND mediatype:(software OR data)',
    '"nazi zombie" AND ("map" OR "maps") AND mediatype:(software OR data)',
    'title:(waw OR "world at war") AND title:(zombie OR zombies) AND mediatype:(software OR data)',
]

# Files that are actually a map, not a screenshot or a torrent sidecar.
MAP_EXT = (".exe", ".zip", ".rar", ".7z", ".iwd", ".ff", ".pk3")
SKIP_NAME = re.compile(r"_(meta|files|reviews)\.(xml|sqlite)$|\.torrent$|__ia_thumb", re.I)

# Popular naming: nazi_zombie_<name>_v1.2.exe / <Name> v1.2.rar
NAME_RE = re.compile(r"^(?:nazi[_\- ]?zombie[_\- ]?)?(.+?)"
                     r"(?:[_\- ]?v?\d+(?:[._]\d+)*)?$", re.I)


def search(ps, q, rows=200, max_pages=5):
    out = {}
    for page in range(1, max_pages + 1):
        params = [("q", q), ("rows", str(rows)), ("page", str(page)), ("output", "json")]
        params += [("fl[]", f) for f in FIELDS]
        url = SEARCH + "?" + urllib.parse.urlencode(params)
        t = ps.get(url)
        if not t:
            break
        try:
            d = json.loads(t)["response"]
        except Exception as exc:
            ps.log("[ia] bad json for %s: %s" % (q[:40], exc))
            break
        for doc in d.get("docs", []):
            out[doc["identifier"]] = doc
        if page * rows >= d.get("numFound", 0):
            break
    return out


def item_files(ps, ident):
    t = ps.get("https://archive.org/metadata/" + ident)
    if not t:
        return None
    try:
        return json.loads(t)
    except Exception:
        return None


def clean_name(fname):
    stem = os.path.splitext(os.path.basename(fname))[0]
    stem = re.sub(r"[_]+", " ", stem)
    m = NAME_RE.match(stem.strip())
    name = (m.group(1) if m else stem).strip(" -_")
    return re.sub(r"\s+", " ", name).title()


def relevant(doc):
    """Is this item plausibly a WaW custom-zombies map, from its metadata alone?

    MEASURED: the first run of this crawler spent its requests on a 21-CD Ukrainian
    shareware collection and an iOS IPA dump, because 'waw' and 'data' match a lot of
    things. archive.org's relevance ranking does not help on a boolean query, so the
    filter has to be ours: the text must name zombies AND name this game.
    """
    d = doc.get("description")
    if isinstance(d, list):
        d = " ".join(str(x) for x in d)
    blob = " ".join(str(doc.get(k) or "") for k in ("identifier", "title", "creator"))
    blob = (blob + " " + (d or ""))[:6000].lower()
    zombie = "zombie" in blob
    game = any(w in blob for w in ("world at war", "worldatwar", "waw", "cod5", "cod 5",
                                   "call of duty 5", "nazi_zombie", "nazi zombie"))
    return zombie and game


def crawl(db, ps, max_items=120):
    docs = {}
    for q in QUERIES:
        docs.update(search(ps, q))
        ps.log("[ia] %d items after %r" % (len(docs), q[:50]))
    before = len(docs)
    docs = {k: v for k, v in docs.items() if relevant(v)}
    ps.log("[ia] %d candidate items (%d dropped as unrelated)" % (len(docs), before - len(docs)))

    items = 0
    map_files = 0
    total_bytes = 0
    for ident, doc in sorted(docs.items(), key=lambda kv: -(kv[1].get("item_size") or 0)):
        if items >= max_items:
            break
        meta = item_files(ps, ident)
        if not meta or not meta.get("files"):
            continue
        items += 1
        files = [f for f in meta["files"]
                 if f.get("name", "").lower().endswith(MAP_EXT) and not SKIP_NAME.search(f["name"])]
        if not files:
            continue
        isize = sum(int(f.get("size") or 0) for f in files)
        total_bytes += isize
        title = doc.get("title") or ident
        d = doc.get("description")
        if isinstance(d, list):
            d = " ".join(d)
        item_key = catalogue.put_map(
            db, SOURCE, "[item] " + str(title)[:120],
            source_url="https://archive.org/details/" + ident,
            author=str(doc.get("creator") or "") or None,
            released=(doc.get("date") or doc.get("publicdate") or "")[:10] or None,
            description=re.sub(r"<[^>]+>", " ", d or "")[:4000] or None,
            tags=["archive_item"],
            extra={"identifier": ident, "n_map_files": len(files), "map_bytes": isize,
                   "item_size": doc.get("item_size"), "downloads": doc.get("downloads")})
        server = meta.get("server")
        dirp = meta.get("dir")
        for f in files:
            map_files += 1
            url = "https://archive.org/download/%s/%s" % (ident, urllib.parse.quote(f["name"]))
            name = clean_name(f["name"])
            if len(files) == 1:
                key = item_key
            else:
                key = catalogue.put_map(
                    db, SOURCE, name,
                    source_url="https://archive.org/details/" + ident,
                    tags=["archive_file"],
                    extra={"identifier": ident, "file": f["name"]})
            catalogue.put_link(db, key, url, label="archive.org")
            # The size and hash come from the metadata, so these links start life
            # already checked: no HEAD needed and no bytes moved.
            db.execute("UPDATE links SET size=?, verdict='alive', status=200, "
                       "filename=?, checked=datetime('now') WHERE url=? AND map_key=?",
                       (int(f.get("size") or 0), os.path.basename(f["name"]), url, key))
            if f.get("sha1"):
                pass
        db.commit()
        if server and dirp:
            pass
    ps.log("[ia] %d items with map files, %d map files, %.2f GB"
           % (items, map_files, total_bytes / 2**30))
    catalogue.note(db, "crawl:archive.org",
                   "items=%d files=%d bytes=%d" % (items, map_files, total_bytes))
    return items, map_files, total_bytes


if __name__ == "__main__":
    crawl(catalogue.connect(), net.PoliteSession(log_name="crawl"))
