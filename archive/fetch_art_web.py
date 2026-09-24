#!/usr/bin/env python3
"""A picture for the maps the covers missed, from each map's OWN release page. 2026-09-24.

B: "source an image for every single map". `fetch_art.py` gave ~1,450 maps the cover their
callofdutyrepo / moddb page shows; ~880 were left on the generated card. MEASURED on the
catalogue that day, the reason is the source, not a failed fetch: those maps were seen only
on zwr.gg's download table (a name and a link, no page, no picture), on UGX-Mods' release
board (whose index has no pictures; `crawlers/ugx.py` fetched few thread bodies), or as
files inside archive.org items (most of them bulk dumps that are not zombies maps at all).

So this script visits the one page per map that can show THAT map, and nothing else:

  ugx         the map's UGX release thread: the images in the FIRST post (the mapper's own
              screenshots), then the videos that post embeds (i.ytimg.com's thumbnail, once
              youtube.com/oembed confirms the video's title names the map)
  archiveorg  an archive.org item that is one map (its title names the map): the item's own
              uploaded pictures
  codrepo     a callofdutyrepo post the map has but whose card had no picture: the videos
              the post embeds (same oEmbed check)

Match discipline is the whole job (a wrong picture is worse than the card):
  * the page must be the map's own (a catalogue sighting of THIS entry, or its release post,
    or a row map_art.linked_keys() already treats as the same map);
  * a video must have a title that contains the map's title as whole words, and the word
    after it must not make it another map of a series ("X 2", "X Remastered", ...);
  * a picture must be >= 320x180, landscape (1.2..2.4 after the letterbox is cut), and not a
    logo / text card (a colour-count and contrast test), and not one that turns up in the
    first post of 3+ different threads (a mapper's signature banner, a site badge).
Searches are NOT done: youtube.com/results (and /youtubei/) are disallowed by YouTube's
robots.txt, and moddb disallows every query URL; lib/net.py honours robots, so do we.

Output, the shape fetch_art.py writes: `<work>/media/web/<stem>/cover.<ext>` + `.meta.json`
(url, page, source, sha256, size, width, height, evidence). tools/maps/map_art.py reads it
as its `web` tier. Every decision, found or not, goes to `<work>/reports/art_web.json`, and a
map already decided is skipped on a re-run (--retry to try the misses again).

  python archive/fetch_art_web.py --plan        which maps, which pages; no requests
  python archive/fetch_art_web.py --limit 20
  python archive/fetch_art_web.py               everything undecided
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import net  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
sys.path.insert(0, os.path.join(REPO, "tools", "maps"))
import map_art  # noqa: E402

from PIL import Image  # noqa: E402

WORK = os.path.abspath(os.path.join(net.CACHE_ROOT, os.pardir))
CATALOGUE = os.path.join(WORK, "reports", "catalogue.json")
REPORT = os.path.join(WORK, "reports", "art_web.json")
OUT_ROOT = map_art.WEB_ART
DB = os.path.join(REPO, "web", "data", "zombies.db")
MAX_BYTES = 8 * 1024 * 1024
CDN_DELAY = 1.5          # i.ytimg.com / i.imgur.com: static CDNs, still one request at a time

# archive.org items that are not one WaW map: bulk dumps of other games' files, packs of many
# maps, 3D-print models, the game itself, phone/PSP ports. Their pictures are not of a map.
IA_DENY = re.compile(r"une-ile-trop-loin|arrafrro|ipa-mini|czlevel|dsda|video-game-patches|thingiverse|"
                     r"nzp|nzportable|android|mobile|korea|touchhle|^call-of-duty-5-world-at-war$|"
                     r"^nazi_zombie_school$|^custom-zombie-maps$|^tmg-castle$", re.I)
# Never a map picture: the forum theme's own images.
SITE_CHROME = re.compile(r"ugx-mods\.com/(forum/Themes|beta/images|forum/Smileys|forum/avatars)", re.I)
# Image hosts that are dead or that answer us with a stand-in of their own: tinypic and
# imageshack are gone, photobucket serves an "update your account" card, and i.imgur.com
# answers this PC with its 336x478 "no longer available" png for every image (MEASURED
# 2026-09-24, sha below). The Wayback Machine holds most of these images; it is asked instead.
DEAD_HOSTS = re.compile(r"tinypic\.com|photobucket\.com|imageshack\.|imgsafe|postimg\.org|puu\.sh|imgur\.com", re.I)
GONE_SHA = {"faa24ec881e6040655c187a681d6dc496eb8aa41e1bd0652a180b3a40b457187"}
YT_RE = re.compile(r"(?:youtube(?:-nocookie)?\.com/(?:embed/|watch\?v=|v/)|youtu\.be/)([\w-]{11})")
SERIES = {"2", "3", "4", "5", "ii", "iii", "iv", "v2", "v3", "remastered", "remaster", "remake", "reimagined",
          "redux", "reloaded", "reborn", "returns", "revisited", "beta", "classic", "unlimited", "nighttime"}


def log(ps, *a):
    ps.log("[artweb]", *a)


# ---- matching --------------------------------------------------------------------------------
def words(s):
    return re.findall(r"[a-z0-9]+", html.unescape(str(s or "")).lower().replace("'", ""))


def title_word_forms(title):
    """The map's title as word lists: as given, without a (parenthetical), without a version,
    without a leading 'nazi zombie(s)'. Forms shorter than 3 letters are dropped."""
    t = html.unescape(str(title or "")).lower().replace("'", "")
    forms = [t, re.sub(r"\(.*?\)|\[.*?\]", " ", t)]
    out = []
    for f in forms:
        f = re.sub(r"\b(v(ersion)?\s*)?\d+(\.\d+)+[a-z]?\b|\bv\d+\b", " ", f)
        for g in (f, re.sub(r"^\s*nazi\s*zombies?\s*", "", f)):
            w = words(g)
            if w and len("".join(w)) >= 3 and w not in out:
                out.append(w)
    return out


def names_map(text, title):
    """True when `text` (a video title) contains one of the title's word forms as whole words
    and the next word does not make it a different map of the same series."""
    tw = words(text)
    own = set(words(title))
    for form in title_word_forms(title):
        n = len(form)
        for i in range(len(tw) - n + 1):
            if tw[i:i + n] == form:
                nxt = tw[i + n] if i + n < len(tw) else ""
                if nxt in SERIES and nxt not in own:
                    continue
                return True
    return False


# ---- picture test ----------------------------------------------------------------------------
def crop_letterbox(im):
    g = im.convert("L")
    w, h = g.size
    px = g.load()

    def dark_row(y):
        return sum(px[x, y] for x in range(0, w, max(1, w // 64))) / len(range(0, w, max(1, w // 64))) < 10

    top, bot = 0, h - 1
    while top < h // 3 and dark_row(top):
        top += 1
    while bot > h * 2 // 3 and dark_row(bot):
        bot -= 1
    return im.crop((0, top, w, bot + 1)) if (top or bot < h - 1) else im


def judge(data):
    """(ok, why, (w, h)) for a downloaded picture."""
    try:
        im = Image.open(io.BytesIO(data))
        im.seek(0)
        im = im.convert("RGB")
    except Exception as exc:
        return False, "will not decode (%s)" % exc.__class__.__name__, None
    im = crop_letterbox(im)
    w, h = im.size
    if w < 320 or h < 180:
        return False, "too small %dx%d" % (w, h), (w, h)
    ar = w / float(h)
    if not 1.2 <= ar <= 2.4:
        return False, "not a landscape picture (%.2f)" % ar, (w, h)
    small = im.resize((128, 72))
    q = {(r >> 3, g >> 3, b >> 3) for r, g, b in small.getdata()}
    lum = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in small.getdata()]
    mean = sum(lum) / len(lum)
    sd = (sum((x - mean) ** 2 for x in lum) / len(lum)) ** 0.5
    if len(q) < 180:
        return False, "too few colours for a screenshot (%d) - a logo or a text card" % len(q), (w, h)
    if sd < 14 or mean < 14:
        return False, "flat or black (mean %.0f sd %.0f)" % (mean, sd), (w, h)
    return True, "ok", (w, h)


# ---- fetching --------------------------------------------------------------------------------
def host_ready(ps, url):
    st = ps.host_state(url)
    if st.host in ("i.ytimg.com", "archive.org", "web.archive.org") and st.delay > CDN_DELAY:
        st.delay = CDN_DELAY if st.host == "i.ytimg.com" else (6.0 if st.host == "web.archive.org" else 3.0)
    return st


def get_bytes(ps, url):
    """(bytes, None) or (None, why). One request at a time per host, the host's delay, robots."""
    st = host_ready(ps, url)
    if st.dropped:
        return None, "host dropped: " + st.dropped
    try:
        if not ps.allowed(url):
            return None, "robots.txt disallows"
    except Exception as exc:
        return None, "robots: %s" % exc
    with st.lock:
        ps._sleep(st)
        try:
            r = ps.s.get(url, stream=True, timeout=net.REQUEST_TIMEOUT, allow_redirects=True)
        except Exception as exc:
            st.last = time.time()
            st.consec_errors += 1
            # MEASURED 2026-09-24: the Wayback Machine refuses connections for a while when
            # asked too often. Back off (a minute per error in a row) instead of giving up.
            if st.host == "web.archive.org" and st.consec_errors < 8:
                ps.log("[artweb] %s: %s, backing off %ds" % (st.host, exc.__class__.__name__, 60 * st.consec_errors))
                time.sleep(60 * st.consec_errors)
            elif st.consec_errors >= 4:
                ps.drop(st, "%d consecutive transport errors" % st.consec_errors)
            return None, "transport: %s" % exc.__class__.__name__
        st.last = time.time()
        st.requests_made += 1
    if r.status_code in (429, 503):
        ps.drop(st, "HTTP %d (rate limited)" % r.status_code)
        return None, "HTTP %d" % r.status_code
    if r.status_code >= 400:
        r.close()
        return None, "HTTP %d" % r.status_code
    st.consec_errors = 0
    if DEAD_HOSTS.search(r.url) and not DEAD_HOSTS.search(url):
        r.close()
        return None, "redirected to a dead host's stand-in (%s)" % r.url[:80]
    ctype = (r.headers.get("Content-Type") or "").lower()
    if not ctype.startswith("image/"):
        r.close()
        return None, "not an image: " + ctype[:40]
    data = b""
    for chunk in r.iter_content(1 << 16):
        data += chunk
        if len(data) > MAX_BYTES:
            r.close()
            return None, "over the cap"
    if hashlib.sha256(data).hexdigest() in GONE_SHA:
        return None, "the host's 'no longer available' stand-in"
    return data, None


def wayback(url):
    return "https://web.archive.org/web/2016id_/" + url


def get_image(ps, url):
    """(bytes, served-from url, None) or (None, None, why). A dead host's image is asked of the
    Wayback Machine; a live host that fails is asked there too."""
    if not DEAD_HOSTS.search(url):
        data, err = get_bytes(ps, url)
        if data:
            return data, url, None
        if err and (err.startswith("robots") or err == "over the cap" or err.startswith("not an image")):
            return None, None, err
    data, err2 = get_bytes(ps, wayback(url))
    if data:
        return data, wayback(url), None
    return None, None, "wayback: %s" % err2


def get_text(ps, url):
    host_ready(ps, url)
    try:
        t = ps.get(url)
        return t, (None if t is not None else "no page (HTTP error)")
    except net.Blocked as exc:
        return None, "blocked: %s" % exc
    except net.Dropped as exc:
        return None, "dropped: %s" % exc
    except Exception as exc:
        return None, "%s: %s" % (exc.__class__.__name__, exc)


# ---- pages -------------------------------------------------------------------------------------
def ugx_first_post(t):
    """(image urls, video ids) of the first post of an SMF thread page."""
    # UGX's theme names each post twice (the header block and the body carry the same
    # id="msg_N"); the first post runs until a DIFFERENT N.
    ms = list(re.finditer(r'id="msg_(\d+)"', t))
    if not ms:
        return [], []
    first = ms[0].group(1)
    end = next((m.start() for m in ms if m.group(1) != first), ms[0].start() + 60000)
    seg = t[ms[0].start():end]
    imgs = []
    for tag in re.findall(r"<img[^>]*>", seg):
        if "bbc_img" not in tag:
            continue
        m = re.search(r'src="([^"]+)"', tag)
        if m:
            u = html.unescape(m.group(1))
            if u.startswith("//"):
                u = "https:" + u
            if u.startswith("http") and u not in imgs:
                imgs.append(u)
    vids = []
    for v in YT_RE.findall(seg):
        if v not in vids:
            vids.append(v)
    return imgs, vids


def video_check(ps, vid, title):
    """(ok, video title or why). oEmbed is not a search and robots allows it."""
    # Not through ps.get: oEmbed answers 401/403/404 for a private, removed or
    # embedding-disabled video, and net.py would take two of those for a block.
    u = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + vid, safe="")
    st = host_ready(ps, u)
    if st.dropped:
        return False, "host dropped"
    with st.lock:
        ps._sleep(st)
        try:
            r = ps.s.get(u, timeout=net.REQUEST_TIMEOUT)
        except Exception as exc:
            st.last = time.time()
            return False, "oembed transport: %s" % exc.__class__.__name__
        st.last = time.time()
    if r.status_code == 429:
        ps.drop(st, "HTTP 429")
        return False, "oembed rate limited"
    if r.status_code != 200:
        return False, "oembed HTTP %d (video private, removed or not embeddable)" % r.status_code
    t = r.text
    try:
        vt = json.loads(t).get("title") or ""
    except Exception:
        return False, "oembed: not json (video gone?)"
    if not names_map(vt, title):
        return False, "video title does not name the map: %r" % vt[:90]
    return True, vt


def thumb_for(ps, vid):
    """A frame OF THE VIDEO, not its thumbnail. i.ytimg.com keeps three frames YouTube cut
    from every video (1, 2, 3: about a quarter, half and three quarters in), at the video's
    resolution. A custom thumbnail is the uploader's poster (a face, a stock zombie, big
    text: measured 2026-09-24 on "Zombie Defender", a stock-photo Santa); a frame from the
    middle of a gameplay video is the map. The sharpest of the three that passes judge()."""
    from PIL import ImageFilter, ImageStat
    for size in ("maxres", "sd", "hq"):
        best = None
        for n in (1, 2, 3):
            u = "https://i.ytimg.com/vi/%s/%s%d.jpg" % (vid, size, n)
            data, err = get_bytes(ps, u)
            if not data:
                if n == 1:
                    break          # this size does not exist for the video; try the next
                continue
            ok, why, wh = judge(data)
            if not ok:
                continue
            g = crop_letterbox(Image.open(io.BytesIO(data)).convert("RGB")).convert("L").resize((320, 180))
            sharp = ImageStat.Stat(g.filter(ImageFilter.FIND_EDGES)).mean[0]
            if best is None or sharp > best[0]:
                best = (sharp, u, data, wh)
        if best:
            return best[1], best[2], best[3]
    return None, None, None


# ---- plan --------------------------------------------------------------------------------------
def targets(con, only=None):
    """Maps map_art would still draw a card for, with every page that is theirs."""
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT key, title, author, source, health, hidden, release_post, superseded_by FROM maps")]
    rowmap = {r["key"]: r for r in rows}
    links = map_art.linked_keys(rows)
    cat = {m["norm"]: m for m in json.load(open(CATALOGUE, encoding="utf-8"))}
    ia_count = {}
    for m in cat.values():
        for s in m["sightings"]:
            if s["source"] == "archive.org":
                i = (s.get("extra") or {}).get("identifier")
                ia_count[i] = ia_count.get(i, 0) + 1
    out = []
    for r in rows:
        k = r["key"]
        if only and k not in only:
            continue
        if r["source"] == "stock" or k in map_art.STOCK:
            continue
        chain = [k] + links.get(k, [])
        if any(map_art.site_source(x, rowmap.get(x)) for x in chain) or any(map_art.iwd_source(x) for x in chain):
            continue
        pages = []

        def add(kind, url, **kw):
            if url and not any(p["url"] == url for p in pages):
                pages.append(dict(kind=kind, url=url, **kw))

        for x in chain:
            rp = (rowmap.get(x) or {}).get("release_post") or ""
            if "ugx-mods.com/forum/" in rp:
                add("ugx", rp)
            elif "callofdutyrepo.com/" in rp:
                add("codrepo", rp)
            if x.startswith("cat:") and x[4:] in cat:
                for s in cat[x[4:]]["sightings"]:
                    ex = s.get("extra") or {}
                    if s["source"] == "ugx":
                        add("ugx", ex.get("thread") or s.get("url"))
                    elif s["source"] == "codrepo":
                        add("codrepo", ex.get("post") or s.get("url"))
                    elif s["source"] == "archive.org":
                        ident = ex.get("identifier")
                        if ident and not IA_DENY.search(ident):
                            add("archiveorg", "https://archive.org/metadata/" + ident, identifier=ident,
                                items_in_catalogue=ia_count.get(ident, 0))
        vis = 0 if (r["hidden"] == 0 and r["health"] != "broken") else 1
        pri = (vis, 0 if r["source"] != "catalogue" else 1, k)
        out.append(dict(key=k, title=r["title"], author=r["author"], pages=pages, pri=pri))
    out.sort(key=lambda t: t["pri"])
    return out


# ---- one map -----------------------------------------------------------------------------------
def save(key, data, url, page, source, evidence, wh):
    d = os.path.join(OUT_ROOT, map_art.stem_of(key))
    os.makedirs(d, exist_ok=True)
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        ext = ".img"
    for f in os.listdir(d):
        os.remove(os.path.join(d, f))
    name = "cover" + ext
    open(os.path.join(d, name), "wb").write(data)
    meta = {"url": url, "page": page, "source": source, "evidence": evidence, "file": name,
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "width": wh[0], "height": wh[1],
            "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tool": "archive/fetch_art_web.py"}
    json.dump(meta, open(os.path.join(d, name + ".meta.json"), "w", encoding="utf-8"), indent=1)
    return meta


def do_map(ps, t, common):
    tried = []
    title = t["title"]
    ugx_pages = [p for p in t["pages"] if p["kind"] == "ugx"]
    # 1. the UGX thread's own screenshots, 2. the videos it embeds
    posts = []
    for p in ugx_pages:
        txt, err = get_text(ps, p["url"])
        if txt is None:
            tried.append({"page": p["url"], "why": err})
            continue
        imgs, vids = ugx_first_post(txt)
        posts.append((p["url"], imgs, vids))
    for page, imgs, _ in posts:
        for u in imgs[:8]:
            if SITE_CHROME.search(u):
                continue
            if common.get(u, 0) >= 3:
                tried.append({"img": u, "why": "in %d threads' first posts (a banner)" % common[u]})
                continue
            data, served, err = get_image(ps, u)
            if not data:
                tried.append({"img": u, "why": err})
                continue
            ok, why, wh = judge(data)
            if not ok:
                tried.append({"img": u, "why": why})
                continue
            meta = save(t["key"], data, served, page, "ugx", "first post of the map's UGX release thread", wh)
            if served != u:
                meta["original_url"] = u
                json.dump(meta, open(os.path.join(OUT_ROOT, map_art.stem_of(t["key"]), meta["file"] + ".meta.json"),
                                     "w", encoding="utf-8"), indent=1)
            return meta, tried
    for page, _, vids in posts:
        for v in vids[:4]:
            if common.get("yt:" + v, 0) >= 3:
                continue
            ok, vt = video_check(ps, v, title)
            if not ok:
                tried.append({"video": v, "why": vt})
                continue
            u, data, wh = thumb_for(ps, v)
            if not data:
                tried.append({"video": v, "why": "no usable thumbnail"})
                continue
            return save(t["key"], data, u, page, "youtube",
                        "video embedded in the map's UGX release thread, titled %r" % vt, wh), tried
    # 3. an archive.org item that is this one map
    for p in t["pages"]:
        if p["kind"] != "archiveorg":
            continue
        txt, err = get_text(ps, p["url"])
        if txt is None:
            tried.append({"page": p["url"], "why": err})
            continue
        try:
            md = json.loads(txt)
        except Exception:
            tried.append({"page": p["url"], "why": "metadata not json"})
            continue
        it = md.get("metadata") or {}
        ititle = it.get("title") or ""
        if isinstance(ititle, list):
            ititle = " ".join(ititle)
        if not (names_map(ititle, title) or names_map(title, ititle)):
            tried.append({"page": p["url"], "why": "item title %r does not name the map" % ititle[:80]})
            continue
        blob = " ".join(str(it.get(f) or "") for f in ("title", "description", "subject")).lower()
        if not re.search(r"world at war|waw|cod ?5|call of duty|nazi.?zombie", blob):
            tried.append({"page": p["url"], "why": "item does not say it is a World at War map"})
            continue
        if p.get("items_in_catalogue", 0) > 3:
            tried.append({"page": p["url"], "why": "item holds %d catalogue entries" % p["items_in_catalogue"]})
            continue
        pics = [f for f in md.get("files") or []
                if f.get("source") == "original" and re.search(r"\.(jpe?g|png|webp)$", f.get("name", ""), re.I)
                and not f["name"].startswith("__ia_thumb")]
        pics.sort(key=lambda f: -int(f.get("size") or 0))
        for f in pics[:4]:
            u = "https://archive.org/download/%s/%s" % (p["identifier"], urllib.parse.quote(f["name"]))
            data, err = get_bytes(ps, u)
            if not data:
                tried.append({"img": u, "why": err})
                continue
            ok, why, wh = judge(data)
            if not ok:
                tried.append({"img": u, "why": why})
                continue
            return save(t["key"], data, u, "https://archive.org/details/" + p["identifier"], "archiveorg",
                        "picture uploaded to the archive.org item %r" % ititle[:80], wh), tried
        if not pics:
            tried.append({"page": p["url"], "why": "item has no uploaded pictures"})
    # 4. a codrepo post's embedded videos
    for p in t["pages"]:
        if p["kind"] != "codrepo":
            continue
        txt, err = get_text(ps, p["url"])
        if txt is None:
            tried.append({"page": p["url"], "why": err})
            continue
        body = txt.split('class="entry-content', 1)[-1].split('id="comments"', 1)[0]
        for v in list(dict.fromkeys(YT_RE.findall(body)))[:3]:
            ok, vt = video_check(ps, v, title)
            if not ok:
                tried.append({"video": v, "why": vt})
                continue
            u, data, wh = thumb_for(ps, v)
            if data:
                return save(t["key"], data, u, p["url"], "youtube",
                            "video embedded in the map's callofdutyrepo post, titled %r" % vt, wh), tried
    return None, tried


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--retry", action="store_true", help="try maps decided 'none' before again")
    ap.add_argument("--only", action="append")
    ap.add_argument("--db", default=DB)
    args = ap.parse_args()
    con = sqlite3.connect("file:%s?mode=ro" % args.db.replace("\\", "/"), uri=True)
    ts = targets(con, set(args.only) if args.only else None)
    try:
        rep = json.load(open(REPORT, encoding="utf-8"))
    except Exception:
        rep = {}
    with_pages = [t for t in ts if t["pages"]]
    kinds = {}
    for t in with_pages:
        for p in t["pages"]:
            kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    print("art_web: %d maps still on the card, %d with a page of their own (%s), %d without"
          % (len(ts), len(with_pages), kinds, len(ts) - len(with_pages)), flush=True)
    if args.plan:
        return
    todo = [t for t in with_pages if args.only or t["key"] not in rep
            or (args.retry and rep[t["key"]].get("status") == "none")]
    todo = [t for t in todo if not os.path.isdir(os.path.join(OUT_ROOT, map_art.stem_of(t["key"])))
            or args.only or args.retry]
    if args.limit:
        todo = todo[: args.limit]
    ps = net.PoliteSession(log_name="fetch_art_web")
    # Pass 1: the UGX pages (cached after the first run), to learn which images and videos
    # are everyone's (banners, badges, a signature video) before choosing any.
    common = {}
    for t in todo:
        seen = set()
        for p in t["pages"]:
            if p["kind"] != "ugx":
                continue
            txt, err = get_text(ps, p["url"])
            if txt is None:
                continue
            imgs, vids = ugx_first_post(txt)
            for u in imgs + ["yt:" + v for v in vids]:
                if u not in seen:
                    seen.add(u)
                    common[u] = common.get(u, 0) + 1
    log(ps, "pass 1 done: %d distinct first-post images/videos" % len(common))
    ok = 0
    for i, t in enumerate(todo, 1):
        try:
            meta, tried = do_map(ps, t, common)
        except Exception as exc:
            meta, tried = None, [{"why": "error: %s: %s" % (exc.__class__.__name__, exc)}]
        rep[t["key"]] = {"status": "ok" if meta else "none", "title": t["title"],
                         "pages": [p["url"] for p in t["pages"]], "picked": meta, "tried": tried[:12],
                         "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if meta:
            ok += 1
            log(ps, "%d/%d %s: %s %s" % (i, len(todo), t["key"], meta["source"], meta["url"]))
        else:
            log(ps, "%d/%d %s: none (%s)" % (i, len(todo), t["key"], "; ".join(str(x.get("why") or "") for x in tried[:3])[:160]))
        if i % 10 == 0:
            json.dump(rep, open(REPORT, "w", encoding="utf-8"), indent=1, sort_keys=True)
    json.dump(rep, open(REPORT, "w", encoding="utf-8"), indent=1, sort_keys=True)
    log(ps, "done: %d of %d maps got a picture" % (ok, len(todo)))
    ps.release()


if __name__ == "__main__":
    main()
