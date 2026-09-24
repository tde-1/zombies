#!/usr/bin/env python3
"""Fetch one cover picture per catalogued map, from the pages we already crawled.

2026-09-22 (web-maps lane). §8 fetched 14 covers by hand, one `og:image` per pipeline map.
The other ~2,270 catalogue maps had none, and B's ask was that every map on the site has a
picture. Most of them already have one sitting in our own cache: callofdutyrepo's LIST pages
(`/wawmaps/page/N/`, crawled in pass A) draw every post as a card with its featured image, so
the cached HTML already names a picture for ~1,400 maps without one new page request. The
same goes for the post pages pass C fetched (their `og:image`) and moddb's addon pages.

So this script makes NO page requests. It reads the cache, maps each catalogue entry to the
image URL its own source page shows, and then downloads only the images, through
`lib/net.py`'s politeness (one request at a time per host, the host's delay, robots.txt, a
host that errors twice is dropped for the run). Every file lands in
`<work>/media/catalogue/<norm>/` with a `.meta.json` sidecar (url, page, sha256, size,
fetched), which is the same shape §8's covers have. Re-runnable: a map that already has its
file is skipped without a request.

  python archive/fetch_art.py --plan            resolve URLs only, write reports/art_urls.json
  python archive/fetch_art.py --limit 50        fetch the first 50 still missing
  python archive/fetch_art.py                   fetch everything still missing

The 768px WordPress rendition is taken where the page offers one: it is what a card or a
hero on the site needs, and it is a tenth of the bytes of the 1920px original.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import net  # noqa: E402

WORK = os.path.abspath(os.path.join(net.CACHE_ROOT, os.pardir))
CATALOGUE = os.path.join(WORK, "reports", "catalogue.json")
OUT_ROOT = os.path.join(WORK, "media", "catalogue")
PLAN = os.path.join(WORK, "reports", "art_urls.json")
MAX_BYTES = 3 * 1024 * 1024
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

# One card on a codrepo list page: the media anchor (post URL) then its lazy <img>.
CARD_RE = re.compile(
    r'element-media\s*">\s*<a[^>]*href="(https://callofdutyrepo\.com/\d{4}/\d{2}/\d{2}/[^"#?]+)"[^>]*>'
    r'\s*<img([^>]*)>', re.S)
ATTR_RE = re.compile(r'([a-zA-Z-]+)="([^"]*)"')
OG_URL = re.compile(r'<meta property="og:url" content="([^"]+)"')
OG_IMG = re.compile(r'<meta property="og:image" content="([^"]+)"')


def norm_url(u):
    return (u or "").strip().rstrip("/").lower()


def pick_rendition(attrs):
    """The 768w rendition from a srcset, else the plain src."""
    srcset = attrs.get("data-srcset") or attrs.get("srcset") or ""
    best = None
    for part in srcset.split(","):
        bits = part.strip().split()
        if len(bits) == 2 and bits[1].endswith("w"):
            w = int(bits[1][:-1] or 0)
            if 600 <= w <= 1100 and (best is None or abs(w - 768) < abs(best[0] - 768)):
                best = (w, bits[0])
    if best:
        return best[1]
    src = attrs.get("data-src") or attrs.get("src") or ""
    return src if src.startswith("http") else None


def scan_cache():
    """post/page URL (normalised) -> image URL, from every cached page we hold."""
    found = {}
    site_default = set()
    for f in glob.glob(os.path.join(net.CACHE_ROOT, "callofdutyrepo.com", "*.bin")):
        t = net.decode(open(f, "rb").read())
        for post, imgattrs in CARD_RE.findall(t):
            a = dict(ATTR_RE.findall(imgattrs))
            u = pick_rendition(a)
            if u:
                found.setdefault(norm_url(post), u)
        ou, oi = OG_URL.search(t), OG_IMG.search(t)
        if ou and oi:
            site_default.add(oi.group(1))
            found.setdefault(norm_url(html.unescape(ou.group(1))), html.unescape(oi.group(1)))
    for f in glob.glob(os.path.join(net.CACHE_ROOT, "www.moddb.com", "*.bin")):
        t = net.decode(open(f, "rb").read())
        ou, oi = OG_URL.search(t), OG_IMG.search(t)
        if ou and oi:
            found.setdefault(norm_url(html.unescape(ou.group(1))), html.unescape(oi.group(1)))
    # An og:image that more than a handful of pages share is the site's logo, not a map.
    counts = {}
    for v in found.values():
        counts[v] = counts.get(v, 0) + 1
    return {k: v for k, v in found.items() if counts[v] <= 3}


def plan():
    cat = json.load(open(CATALOGUE, encoding="utf-8"))
    byurl = scan_cache()
    out = {}
    for m in cat:
        for s in m.get("sightings") or []:
            if s.get("source") not in ("codrepo", "moddb"):
                continue
            for u in (s.get("url"), (s.get("extra") or {}).get("post")):
                img = byurl.get(norm_url(u))
                if img:
                    out.setdefault(m["norm"], {"image": img, "page": u, "source": s["source"]})
    os.makedirs(os.path.dirname(PLAN), exist_ok=True)
    json.dump(out, open(PLAN, "w", encoding="utf-8"), indent=1, sort_keys=True)
    return out


def have(norm):
    d = os.path.join(OUT_ROOT, norm)
    return bool(glob.glob(os.path.join(d, "*.meta.json")))


def fetch(ps, norm, row):
    url = row["image"]
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
    if ext not in IMG_EXT:
        return "not an image extension: " + ext
    st = ps.host_state(url)
    if st.dropped:
        raise net.Dropped(st.dropped)
    if not ps.allowed(url):
        return "robots.txt disallows"
    with st.lock:
        ps._sleep(st)
        try:
            r = ps.s.get(url, stream=True, timeout=net.REQUEST_TIMEOUT)
        except Exception as exc:  # transport error: count it, drop after two
            st.last = time.time()
            st.consec_errors += 1
            if st.consec_errors >= net.MAX_CONSEC_ERRORS:
                ps.drop(st, "%d consecutive transport errors" % st.consec_errors)
            return "transport: %s" % exc
        st.last = time.time()
        st.requests_made += 1
    if r.status_code in (429, 503):
        ps.drop(st, "HTTP %d (rate limited)" % r.status_code)
        raise net.Dropped("HTTP %d" % r.status_code)
    if r.status_code >= 400:
        r.close()
        st.consec_errors += 1 if r.status_code >= 500 else 0
        return "HTTP %d" % r.status_code
    st.consec_errors = 0
    ctype = (r.headers.get("Content-Type") or "").lower()
    if not ctype.startswith("image/"):
        r.close()
        return "not an image: " + ctype
    data = b""
    for chunk in r.iter_content(1 << 16):
        data += chunk
        if len(data) > MAX_BYTES:
            r.close()
            return "over the %d MB cap" % (MAX_BYTES >> 20)
    d = os.path.join(OUT_ROOT, norm)
    os.makedirs(d, exist_ok=True)
    name = "cover" + ext
    with open(os.path.join(d, name), "wb") as fh:
        fh.write(data)
    meta = {"url": url, "page": row.get("page"), "source": row.get("source"),
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
            "content_type": ctype, "file": name,
            "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    json.dump(meta, open(os.path.join(d, name + ".meta.json"), "w"), indent=1)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true", help="resolve URLs only, fetch nothing")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-mb", type=int, default=3, help="per-image cap (2026-09-24: one cover was 3.4 MB)")
    args = ap.parse_args()
    global MAX_BYTES
    MAX_BYTES = args.max_mb * 1024 * 1024
    p = plan()
    todo = [k for k in sorted(p) if not have(k)]
    print("art plan: %d maps have a source image, %d already fetched, %d to fetch"
          % (len(p), len(p) - len(todo), len(todo)), flush=True)
    if args.plan:
        return
    if args.limit:
        todo = todo[: args.limit]
    ps = net.PoliteSession(log_name="fetch_art")
    ok = bad = 0
    for i, k in enumerate(todo, 1):
        try:
            err = fetch(ps, k, p[k])
        except net.Dropped as e:
            ps.log("[stop] host dropped: %s" % e)
            break
        if err:
            bad += 1
            ps.log("[art] %d/%d %s: %s" % (i, len(todo), k, err))
        else:
            ok += 1
            if i % 25 == 0:
                ps.log("[art] %d/%d fetched (%d ok, %d failed)" % (i, len(todo), ok, bad))
    ps.log("[art] done: %d fetched, %d failed" % (ok, bad))
    ps.release()


if __name__ == "__main__":
    main()
