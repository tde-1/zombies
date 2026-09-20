#!/usr/bin/env python3
"""Crawl callofdutyrepo.com -- the 1,372-item WaW catalogue from vault 04 section 1.

Three passes, cheapest first, because each is useful on its own and the later ones
cost a request per map:

  A. list pages  /wawmaps/page/N/      -> title, post URL, post date, view count
                                          (~72 per page, 21 pages, so ~1,500 maps
                                           for 21 requests)
  B. tag pages   /waw-easter-egg-maps/, /waw-buyable-ending-maps/, /top-100-waw-maps/,
                 /waw-challenge-maps/, /waw-ugx-modded-maps/
                                       -> the finish tags the whole badge model needs
  C. post pages  one per map           -> author ("By: X" in the Elementor heading),
                                          description, every download link with its
                                          button label, and the WordPress tag classes

Pass C is bounded by --posts so an overnight run can take the maps that matter first
(tagged and popular ones) and leave the long tail for a later pass; the DB records
which posts have been fetched so a re-run resumes rather than restarts.
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

SOURCE = "codrepo"
BASE = "https://callofdutyrepo.com"
LIST_PATHS = ["/wawmaps/", "/waw-mods/"]
TAG_PAGES = {
    "easter_egg": "/waw-easter-egg-maps/",
    "buyable_ending": "/waw-buyable-ending-maps/",
    "top100": "/top-100-waw-maps/",
    "challenge": "/waw-challenge-maps/",
    "ugx_mod": "/waw-ugx-modded-maps/",
}

POST_RE = re.compile(r'href="(https://callofdutyrepo\.com/\d{4}/\d{2}/\d{2}/[^"#?]+)"')
TAG_RE = re.compile(r"<[^>]+>")
# One grid item: title anchor, then the date anchor, then "Views: N".
ITEM_RE = re.compile(
    r'class="element[^"]*title\s*"[^>]*>\s*<a[^>]*href="(https://callofdutyrepo\.com/\d{4}/\d{2}/\d{2}/[^"]+)"[^>]*>(.*?)</a>'
    r'(?:.{0,900}?post_date\s*"[^>]*>\s*<a[^>]*>(.*?)</a>)?'
    r'(?:.{0,600}?Views:\s*([\d,]+))?', re.S)
# Most maps head their post with "<h2>Name<br>By: Author</h2>".
BYLINE_RE = re.compile(r"<h2[^>]*elementor-heading-title[^>]*>(.*?)</h2>", re.S | re.I)
BUTTON_RE = re.compile(
    r'<a class="elementor-button[^"]*"\s+href="([^"]+)"(.*?)</a>', re.S | re.I)
ARTICLE_RE = re.compile(r'<article[^>]*class="([^"]*)"', re.I)
TIME_RE = re.compile(r'<time class="entry-date published"[^>]*datetime="([^"]+)"')
TEXT_WIDGET_RE = re.compile(
    r'elementor-widget-text-editor.*?<div class="elementor-widget-container">(.*?)</div>',
    re.S | re.I)


def text(s):
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", s or ""))).strip()


def _pages(ps, path, limit_pages=40):
    """Yield every page of a WordPress list, following /page/N/ links."""
    seen = set()
    n = 1
    while n <= limit_pages:
        url = BASE + path if n == 1 else "%s%spage/%d/" % (BASE, path, n)
        if url in seen:
            break
        seen.add(url)
        t = ps.get(url)
        if t is None:
            break
        yield url, t
        if not re.search(re.escape(path) + r"page/%d/" % (n + 1), t):
            break
        n += 1


def pass_a(db, ps, limit_pages=40):
    found = 0
    for path in LIST_PATHS:
        for url, t in _pages(ps, path, limit_pages):
            for post, title, date, views in ITEM_RE.findall(t):
                title = text(title)
                if not title:
                    continue
                extra = {"post": post, "views": int(views.replace(",", "")) if views else None,
                         "list": path}
                catalogue.put_map(db, SOURCE, title, source_url=post,
                                  released=text(date) or None, extra=extra)
                found += 1
            db.commit()
    ps.log("[codrepo] pass A: %d list entries" % found)
    return found


def pass_b(db, ps):
    """Tag pages. A map's presence on a tag list IS the tag -- these are the lists the
    vault's '~75 EE / ~245 buyable ending' counts come from, so we recount them here."""
    counts = {}
    for tag, path in TAG_PAGES.items():
        urls = []
        for _u, t in _pages(ps, path):
            urls += POST_RE.findall(t)
        urls = list(dict.fromkeys(urls))
        counts[tag] = len(urls)
        for post in urls:
            row = db.execute("SELECT key,tags FROM maps WHERE source=? AND source_url=?",
                             (SOURCE, post)).fetchone()
            if row is None:
                # The tag lists occasionally hold a post the map grid misses.
                name = post.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()
                key = catalogue.put_map(db, SOURCE, name, source_url=post,
                                        extra={"post": post, "from": "tag:" + tag})
                cur = []
            else:
                key, cur = row["key"], json.loads(row["tags"] or "[]")
            if tag not in cur:
                cur.append(tag)
            db.execute("UPDATE maps SET tags=? WHERE key=?", (json.dumps(cur), key))
        db.commit()
    ps.log("[codrepo] pass B tag counts: %s" % counts)
    catalogue.note(db, "crawl:codrepo:tags", json.dumps(counts))
    return counts


def _priority(row):
    """Tagged maps first, then most-viewed. The link report wants breadth, but the
    MVP wants the maps people actually play, and pass C is the expensive one."""
    tags = json.loads(row["tags"] or "[]")
    extra = json.loads(row["extra"] or "{}")
    return (0 if tags else 1, -(extra.get("views") or 0))


def pass_c(db, ps, limit=200):
    rows = [r for r in db.execute(
        "SELECT key,name,source_url,tags,extra FROM maps WHERE source=? AND source_url IS NOT NULL",
        (SOURCE,))]
    todo = [r for r in rows if '"fetched": true' not in (r["extra"] or "")]
    todo.sort(key=_priority)
    done = 0
    for row in todo[:limit]:
        try:
            t = ps.get(row["source_url"])
        except net.Dropped as exc:
            ps.log("[codrepo] stopping pass C: %s" % exc)
            break
        if t is None:
            continue
        extra = json.loads(row["extra"] or "{}")
        extra["fetched"] = True
        author = None
        desc = None
        m = BYLINE_RE.search(t)
        if m:
            h = text(m.group(1))
            bym = re.search(r"\bby\s*:?\s*(.+)$", h, re.I)
            if bym:
                author = bym.group(1).strip(" -–")
        tm = TIME_RE.search(t)
        released = tm.group(1)[:10] if tm else None
        am = ARTICLE_RE.search(t)
        tags = json.loads(row["tags"] or "[]")
        if am:
            for cls in am.group(1).split():
                if cls.startswith("tag-"):
                    tg = cls[4:].replace("waw-", "").replace("-", "_")
                    if tg not in tags:
                        tags.append(tg)
        body = t[t.find('<div class="entry-content">'):]
        for tw in TEXT_WIDGET_RE.findall(body[:60000]):
            s = text(tw)
            if len(s) > 60:
                desc = s[:4000]
                break
        n_links = 0
        for url, tail in BUTTON_RE.findall(body[:120000]):
            url = html.unescape(url)
            if not url.startswith("http") or "callofdutyrepo.com" in url:
                continue
            label = text(tail) or None
            catalogue.put_link(db, row["key"], url, label=label)
            n_links += 1
        db.execute("UPDATE maps SET author=COALESCE(?,author), released=COALESCE(?,released),"
                   " description=COALESCE(?,description), tags=?, extra=? WHERE key=?",
                   (author, released, desc, json.dumps(tags), json.dumps(extra), row["key"]))
        db.commit()
        done += 1
    ps.log("[codrepo] pass C: %d posts fetched (%d left)" % (done, max(0, len(todo) - done)))
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pass", dest="which", default="abc")
    ap.add_argument("--posts", type=int, default=200)
    a = ap.parse_args()
    db = catalogue.connect()
    ps = net.PoliteSession(log_name="crawl")
    if "a" in a.which:
        pass_a(db, ps)
    if "b" in a.which:
        pass_b(db, ps)
    if "c" in a.which:
        pass_c(db, ps, a.posts)


if __name__ == "__main__":
    main()
