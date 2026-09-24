#!/usr/bin/env python3
"""Give every map the site knows a picture. Re-runnable; B's ask of 2026-09-22.

"Make sure every map has an image. If they don't have an image from the websites, rip an
image from the game files or something."

For each row in the site's `maps` table, the first of these that exists wins:

  site         the archive's scraped art. The 14 pipeline maps' covers (archive §8,
               `archive/manifests/<key>.json` -> `archive.cover`) and the catalogue covers
               `archive/fetch_art.py` pulled from callofdutyrepo / moddb
               (`<work>/media/catalogue/<norm>/cover.*`).
  iwd          the map's own loading screen, out of its own .iwd (a zip) — an .iwi texture
               decoded by `iwi.py`. Looked for in the archive's normalised installs and in
               the dev homes' mods folders. Read-only: the zip is opened, never written.
  (linked)     2026-09-24: when a map has neither, the site / iwd picture of a row that is
               THE SAME MAP (`linked_keys`: `maps.superseded_by` either way, or the exact
               title AND author) — a real map borrows its hidden catalogue twin's cover. The
               manifest says `"via": <that key>`; art_source stays the picture's own kind.
               Also 2026-09-24: a real map reaches a catalogue cover through its bsp name
               only when that catalogue entry also names it (title or author) —
               `catalogue_names_map`; "Nuketown Remastered" wore 2010's Nuketown v1 cover.
  ugx / youtube / archiveorg
               the web tier, 2026-09-24: a picture `archive/fetch_art_web.py` took from the
               map's own release page (its UGX thread's first post, the video that post or
               its codrepo post embeds, its archive.org item), under that script's matching
               rules (`<work>/media/web/<stem>/cover.* + .meta.json`). Own, then linked.
               art_source is the kind (ugx | youtube | archiveorg).
  stock        WaW's own loading screens for the four Treyarch maps, out of the game's
               stock .iwd files. READ-ONLY, per hard rule 1: the Steam install is opened
               for reading and nothing is written anywhere under it.
  placeholder  a generated card on the site's zombies ground with the map's name on it.
               Deterministic: the same map always draws the same card (its hue is the
               client's own `mapHue(key)`), so a re-run changes no bytes.

When a map's picture is scraped art and its own loading screen is also available, the
loading screen is written beside it (`<stem>.loadscreen.webp`) — the map page shows it as a
second picture, since it is the one the game itself shows.

Output, into the site's media directory (`web/public/media/maps/`, served at `/media/maps`):

  <stem>.webp            960x540, the hero and the ambience source
  <stem>.thumb.webp      400x225, cards, list rows, the pool
  <stem>.loadscreen.webp 960x540, where there is one and it is not already the main picture
  manifest.json          per map: which source won, where it came from, the source's sha256

Incremental: a map whose source bytes and output files are unchanged is not re-encoded.

  python tools/maps/map_art.py                        build files + manifest, touch no DB
  python tools/maps/map_art.py --write-db             ...and set maps.art / maps.art_source
  python tools/maps/map_art.py --db path/to/zombies.db --write-db
  python tools/maps/map_art.py --only nazi_zombie_factory --force

`--write-db` writes the database this checkout's server reads (`web/data/zombies.db`
unless `--db` or ZM_DATA_DIR says otherwise). It changes two columns on `maps` and
nothing else.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import time
import zipfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iwi  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEV = os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev")
WORK = os.environ.get("ZM_ARCHIVE_WORK", os.path.join(DEV, "archive"))
ARCHIVE_MANIFESTS = os.path.join(REPO, "archive", "manifests")
STEAM_WAW = r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"
DEFAULT_OUT = os.path.join(REPO, "web", "public", "media", "maps")
WEB_ART = os.path.join(WORK, "media", "web")      # archive/fetch_art_web.py's accepted pictures
MEDIA_URL = "/media/maps"

HERO = (960, 540)
THUMB = (400, 225)

# Where a custom map's own files may be, newest-first is irrelevant: the first hit wins and
# they are all copies of the same release. The archive's normalised installs come first.
MOD_ROOTS = [os.path.join(WORK, "mods")] + sorted(glob.glob(os.path.join(DEV, "homes", "*", "mods")))

# WaW's own loading screens (measured 2026-09-22 by listing every stock .iwd). Nacht der
# Untoten's is `loadscreen_zombie1` — it predates the naming the three DLC maps use.
STOCK = {
    "nazi_zombie_prototype": ("iw_04.iwd", "images/loadscreen_zombie1.iwi"),
    "nazi_zombie_asylum": ("localized_english_iw04.iwd", "images/loadscreen_zombie_asylum.iwi"),
    "nazi_zombie_sumpf": ("localized_english_iw05.iwd", "images/loadscreen_zombie_sumpf.iwi"),
    "nazi_zombie_factory": ("localized_english_iw06.iwd", "images/loadscreen_zombie_factory.iwi"),
}
# Stock loading screens that custom maps ship copies of (Minecraft Village carries
# Verrückt's). A custom map's loading screen is never one of these.
STOCK_NAMES = {os.path.basename(v[1]).lower() for v in STOCK.values()}


def stem_of(key):
    return re.sub(r"[^a-z0-9_\-]", "_", key.lower())


def norm(k):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^nazi_zombie_", "", str(k).lower()))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def waw_main():
    for root in (os.environ.get("ZM_WAW_DIR"), STEAM_WAW, os.path.join(DEV, "waw-base")):
        if root and os.path.isfile(os.path.join(root, "main", "iw_04.iwd")):
            return os.path.join(root, "main")
    return None


# ---- sources ------------------------------------------------------------------------------
_CATALOGUE = None


def _title_forms(t):
    t = str(t or "").lower()
    forms = {t, re.sub(r"\(.*?\)|\[.*?\]", " ", t)}
    for f in list(forms):
        f = re.sub(r"\b(v(ersion)?\s*)?\d+(\.\d+)+[a-z]?\b|\bv\d+\b", " ", f)    # v1.2, 1.0.4, v2
        forms.add(f)
        forms.add(re.sub(r"^\s*nazi[\s_]*zombies?[\s_]*", "", f))
    return {re.sub(r"[^a-z0-9]", "", f) for f in forms} - {""}


def catalogue_names_map(n, row):
    """True when catalogue entry `n` names this real map: a title form in common, or the
    same author (one containing the other, as lib/catalogueTwins.js sameAuthor does)."""
    global _CATALOGUE
    if row is None:
        return True           # old callers; main() always passes the row
    if _CATALOGUE is None:
        try:
            _CATALOGUE = {m["norm"]: m for m in json.load(open(os.path.join(WORK, "reports", "catalogue.json"), encoding="utf-8"))}
        except Exception:
            _CATALOGUE = {}
    m = _CATALOGUE.get(n)
    if not m:
        return False
    mine = _title_forms(row.get("title"))
    if any(mine & _title_forms(x) for x in m.get("names") or []):
        return True
    a = _nt(row.get("author"))
    return bool(a) and any(b and (a == b or a in b or b in a) for b in (_nt(x) for x in m.get("authors") or []))


def site_source(key, row=None):
    """(bytes, origin) of the archive's scraped art for this map, or None."""
    # 1. a pipeline map's cover, named in its archive manifest
    mf = os.path.join(ARCHIVE_MANIFESTS, key + ".json")
    if os.path.isfile(mf):
        try:
            a = (json.load(open(mf, encoding="utf-8")).get("archive") or {})
        except Exception:
            a = {}
        cov = a.get("cover")
        if cov:
            p = os.path.realpath(os.path.join(WORK, cov))
            if p.startswith(os.path.realpath(WORK) + os.sep) and os.path.isfile(p):
                return open(p, "rb").read(), a.get("cover_source_url") or cov
    # 2. a catalogue cover (archive/fetch_art.py)
    n = key[4:] if key.startswith("cat:") else norm(key)
    # A real map reaches a catalogue entry only through its bsp name, which is a guess: the
    # entry whose norm is `nuketown` is 2010's "Nazi Zombie Nuketown v1", and its cover sat
    # on "Nuketown Remastered" (a different map, by different people) until 2026-09-24. So
    # the entry must also name this map: the same title, or the same author.
    if not key.startswith("cat:") and not catalogue_names_map(n, row):
        return None
    d = os.path.join(WORK, "media", "catalogue", n)
    for meta in glob.glob(os.path.join(d, "*.meta.json")):
        try:
            m = json.load(open(meta, encoding="utf-8"))
            p = os.path.join(d, m["file"])
            return open(p, "rb").read(), m.get("url") or p
        except Exception:
            continue
    return None


def loadscreen_score(key, iwd_name, entry):
    n = entry.lower()
    base = os.path.basename(n)
    if not n.startswith("images/") or not n.endswith(".iwi"):
        return 0
    stemname = base[:-4]
    bare = re.sub(r"^nazi_zombie_", "", key.lower())
    if stemname in ("loadscreen_" + key.lower(), "preview_" + key.lower()):
        return 100
    if "loadscreen" not in stemname:
        return 0
    if (base in STOCK_NAMES or "template" in stemname or stemname.endswith("_mini")
            or "loadscreen_mp_" in stemname or stemname in ("loadscreen_zombie1", "loadscreen_temp")):
        return 0
    s = 10
    if bare and bare in stemname:
        s += 70
    if os.path.splitext(iwd_name.lower())[0] == key.lower():
        s += 20
    return s


def iwd_source(key):
    """(bytes-of-png, origin) of the map's own loading screen out of its .iwd, or None."""
    if key.startswith("cat:"):
        return None
    best = None
    for root in MOD_ROOTS:
        d = os.path.join(root, key)
        if not os.path.isdir(d):
            continue
        for f in sorted(glob.glob(os.path.join(d, "*.iwd"))):
            try:
                z = zipfile.ZipFile(f)
            except Exception:
                continue
            for e in z.namelist():
                s = loadscreen_score(key, os.path.basename(f), e)
                if s and (best is None or s > best[0]):
                    best = (s, f, e)
        if best:
            break
    if not best:
        return None
    _, f, e = best
    raw = zipfile.ZipFile(f).read(e)
    try:
        im = iwi.decode(raw)
    except iwi.IwiError as exc:
        print("  ! %s: %s in %s: %s" % (key, e, os.path.basename(f), exc))
        return None
    return im, raw, "%s!%s" % (os.path.relpath(f, DEV) if f.startswith(DEV) else f, e)


def stock_source(key, main_dir):
    if key not in STOCK or not main_dir:
        return None
    iwd_name, entry = STOCK[key]
    p = os.path.join(main_dir, iwd_name)
    if not os.path.isfile(p):
        return None
    raw = zipfile.ZipFile(p).read(entry)       # opened read-only; nothing is written
    return iwi.decode(raw), raw, "WaW main/%s!%s" % (iwd_name, entry)


def web_source(key):
    """(bytes, origin-url, kind) of a picture archive/fetch_art_web.py took from this map's own
    release page (kind: ugx | youtube | archiveorg), or None. That script owns the matching
    rules; this only reads what it accepted: `<work>/media/web/<stem>/cover.* + .meta.json`."""
    d = os.path.join(WEB_ART, stem_of(key))
    for meta in glob.glob(os.path.join(d, "*.meta.json")):
        try:
            m = json.load(open(meta, encoding="utf-8"))
            if m.get("rejected"):
                continue
            return open(os.path.join(d, m["file"]), "rb").read(), m.get("url"), m.get("source") or "web"
        except Exception:
            continue
    return None


def _nt(t):
    return re.sub(r"[^a-z0-9]", "", str(t or "").lower())


def linked_keys(rows):
    """key -> other rows that are THE SAME MAP, whose picture this one may borrow.

    Two links only, both already the site's own identity rules (never a fuzzy guess; B's
    rule of 2026-09-23: a series' maps are distinct maps):
      1. `superseded_by` — a catalogue twin the real map replaced, or an earlier version of
         an iterative update (lib/catalogueTwins.js and the map-series rule decide those;
         this reads their verdict). Both directions, and siblings under one superseder.
      2. the exact normalised title AND the exact normalised author, both present — the
         twin rule's auto-hide test without its "one visible real map" condition.
    """
    stock = {r["key"] for r in rows if r.get("source") == "stock" or r["key"] in STOCK}
    out = {}

    def add(a, b):
        if a != b and a not in stock and b not in stock:
            lst = out.setdefault(a, [])
            if b not in lst:
                lst.append(b)

    under = {}
    for r in rows:
        if r.get("superseded_by"):
            add(r["key"], r["superseded_by"])
            add(r["superseded_by"], r["key"])
            under.setdefault(r["superseded_by"], []).append(r["key"])
    for sibs in under.values():
        for a in sibs:
            for b in sibs:
                add(a, b)
    groups = {}
    for r in rows:
        t, a = _nt(r.get("title")), _nt(r.get("author"))
        if len(t) >= 3 and a:
            groups.setdefault((t, a), []).append(r["key"])
    for ks in groups.values():
        for a in ks:
            for b in ks:
                add(a, b)
    return out


# ---- drawing --------------------------------------------------------------------------------
def cover(im, size):
    """Centre-crop to the target aspect, then resize (scraped art)."""
    im = im.convert("RGB")
    tw, th = size
    w, h = im.size
    if w * th > h * tw:
        nw = h * tw // th
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    elif w * th < h * tw:
        nh = w * th // tw
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    return im.resize(size, Image.LANCZOS)


def stretch(im, size):
    """A loading screen is authored at the screen's aspect and stored squashed into a power of
    two (1024x1024, 2048x1024); the engine stretches it back over the screen, and so do we."""
    return im.convert("RGB").resize(size, Image.LANCZOS)


def map_hue(key):
    # client/src/data/mapText.js mapHue(), exactly, so the card's wash and its card agree
    h = 0
    for ch in str(key):
        h = (h * 31 + ord(ch)) % 360
    return h


def _font(names, size, variation=None):
    for n in names:
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", n)
        try:
            f = ImageFont.truetype(p, size)
            if variation:
                try:
                    f.set_variation_by_name(variation)
                except Exception:
                    pass
            return f
        except Exception:
            continue
    return ImageFont.load_default()


SMALL = {"of", "the", "and", "a", "an", "in", "on", "at", "to", "for", "de", "der", "die", "das", "von"}


def pretty_title(title, key):
    t = (title or "").strip()
    if not t:
        return re.sub(r"^nazi_zombie_", "", key)
    if re.search(r"[a-z]", t):
        return t
    out = []
    for i, w in enumerate(t.lower().split(" ")):
        out.append(w if (i > 0 and w in SMALL) else w[:1].upper() + w[1:])
    return " ".join(out)


def _hsl(h, s, l):
    import colorsys
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return int(r * 255), int(g * 255), int(b * 255)


def _wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def placeholder(row):
    """The zombies card. Same map, same pixels: every choice below is a function of the key."""
    import random
    key = row["key"]
    rnd = random.Random(int(sha(key.encode())[:12], 16))
    W, H = HERO
    # The ground: the site's own WaW pair (olive 66, dried blood 4) leaning toward the map's
    # holding hue, dark and low in saturation — a card, not a paint job.
    h = map_hue(key)
    base = (66 + ((h - 66) * 0.35)) if rnd.random() < 0.6 else (4 + ((h - 4) * 0.25))
    top, bot = _hsl(base, 0.22, 0.17), _hsl(base + 12, 0.18, 0.06)
    im = Image.new("RGB", (W, H))
    px = ImageDraw.Draw(im)
    for y in range(H):
        t = y / (H - 1)
        px.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))
    # a glow somewhere up and to one side, like light through a boarded window
    glow = Image.new("L", (W, H), 0)
    gx, gy = int(W * (0.55 + rnd.random() * 0.35)), int(H * (0.15 + rnd.random() * 0.25))
    ImageDraw.Draw(glow).ellipse([gx - 260, gy - 200, gx + 260, gy + 200], fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    im = Image.composite(Image.new("RGB", (W, H), _hsl(base + 20, 0.28, 0.34)), im, glow)
    # boards: a few dark diagonal planks, the barricade every zombies map starts behind
    planks = Image.new("L", (W, H), 0)
    dp = ImageDraw.Draw(planks)
    for i in range(rnd.randint(3, 5)):
        y0 = rnd.randint(-60, H)
        slope = rnd.uniform(-0.35, 0.35)
        thick = rnd.randint(26, 44)
        dp.polygon([(-20, y0), (W + 20, y0 + slope * W), (W + 20, y0 + slope * W + thick), (-20, y0 + thick)],
                   fill=rnd.randint(22, 40))
    im = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), im, planks.filter(ImageFilter.GaussianBlur(2)))
    # grain, seeded, so it is part of the picture and not noise between runs
    noise = Image.frombytes("L", (W // 2, H // 2), bytes(rnd.randint(0, 255) for _ in range((W // 2) * (H // 2))))
    noise = noise.resize((W, H), Image.NEAREST)
    im = Image.blend(im, Image.merge("RGB", (noise, noise, noise)), 0.045)
    # vignette + a floor for the type
    vig = Image.new("L", (W, H), 0)
    ImageDraw.Draw(vig).rectangle([0, int(H * 0.45), W, H], fill=200)
    vig = vig.filter(ImageFilter.GaussianBlur(80))
    im = Image.composite(Image.new("RGB", (W, H), (6, 6, 5)), im, vig)

    d = ImageDraw.Draw(im)
    blood = _hsl(4, 0.62, 0.42)
    title = pretty_title(row.get("title"), key)
    big = _font(["bahnschrift.ttf", "segoeuib.ttf", "arialbd.ttf"], 74, "Bold Condensed")
    lines = _wrap(d, title, big, W - 120)
    size = 74
    while len(lines) > 2 and size > 44:
        size -= 6
        big = _font(["bahnschrift.ttf", "segoeuib.ttf", "arialbd.ttf"], size, "Bold Condensed")
        lines = _wrap(d, title, big, W - 120)
    lines = lines[:3]
    small = _font(["bahnschrift.ttf", "segoeui.ttf"], 22, "SemiBold")
    mono = _font(["consola.ttf"], 20)
    by = " · ".join(x for x in [row.get("author"), str(row["year"]) if row.get("year") else None] if x)
    sub = key if not key.startswith("cat:") else None
    y = H - 56 - (26 if by else 0) - (26 if sub else 0) - len(lines) * int(size * 1.02)
    d.rectangle([60, y - 22, 60 + 54, y - 17], fill=blood)
    for ln in lines:
        d.text((58, y), ln, font=big, fill=(236, 232, 222))
        y += int(size * 1.02)
    y += 8
    if sub:
        d.text((60, y), sub, font=mono, fill=(160, 158, 146))
        y += 26
    if by:
        d.text((60, y), by, font=small, fill=(196, 192, 180))
    mark = _font(["bahnschrift.ttf", "segoeuib.ttf"], 18, "Bold")
    d.text((W - 60 - d.textlength("ENW ZOMBIES", font=mark), 34), "ENW ZOMBIES", font=mark, fill=(200, 196, 184))
    # Said on the picture, so a generated card is never mistaken for the map's own art.
    note = "NO SCREENSHOT ON FILE"
    nf = _font(["consola.ttf"], 14)
    d.text((W - 60 - d.textlength(note, font=nf), H - 44), note, font=nf, fill=(120, 118, 108))
    return im


# ---- output ---------------------------------------------------------------------------------
def webp_bytes(im, q):
    b = io.BytesIO()
    im.save(b, "WEBP", quality=q, method=6)
    return b.getvalue()


def write_if_changed(path, data):
    try:
        if open(path, "rb").read() == data:
            return False
    except OSError:
        pass
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return True


def db_path(arg):
    if arg:
        return arg
    d = os.environ.get("ZM_DATA_DIR") or os.path.join(REPO, "web", "data")
    return os.path.join(d, "zombies.db")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db")
    ap.add_argument("--out", default=os.environ.get("ZM_MEDIA_DIR") and os.path.join(os.environ["ZM_MEDIA_DIR"], "maps") or DEFAULT_OUT)
    ap.add_argument("--write-db", action="store_true")
    ap.add_argument("--only", action="append", help="just these keys (repeatable)")
    ap.add_argument("--only-list", help="file: one key per line (# comments), e.g. archive/tranche2.txt")
    ap.add_argument("--force", action="store_true", help="re-encode even when unchanged")
    # docs/kickstart/ip-posture.md §4: a stock loading screen is Activision's image. It may be
    # served during closed testing; "before public: no stock loadscreen on any served page".
    # This flag is that switch — the stock four fall through to the generated card.
    ap.add_argument("--no-stock", action="store_true", default=os.environ.get("ZM_NO_STOCK_ART") == "1",
                    help="never use WaW's own loading screens (ip-posture.md §4, before public)")
    args = ap.parse_args()
    if args.only_list:
        keys = [ln.split("#")[0].split()[0] for ln in open(args.only_list, encoding="utf-8") if ln.split("#")[0].split()]
        args.only = (args.only or []) + keys

    dbp = db_path(args.db)
    con = sqlite3.connect(dbp) if args.write_db else sqlite3.connect("file:%s?mode=ro" % dbp.replace("\\", "/"), uri=True)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("SELECT key, title, author, year, source FROM maps ORDER BY key")]
    if args.only:
        rows = [r for r in rows if r["key"] in set(args.only)]
    os.makedirs(args.out, exist_ok=True)
    man_path = os.path.join(args.out, "manifest.json")
    try:
        old = json.load(open(man_path, encoding="utf-8")).get("maps", {})
    except Exception:
        old = {}
    main_dir = waw_main()
    print("maps: %d · db %s · out %s · WaW %s" % (len(rows), dbp, args.out, main_dir or "not found"))

    out = dict(old) if args.only else {}
    counts = {"site": 0, "iwd": 0, "stock": 0, "placeholder": 0}
    print("web art: %s" % WEB_ART)
    written = 0
    t0 = time.time()
    all_rows = [dict(r) for r in con.execute("SELECT key, title, author, source, superseded_by FROM maps")]
    links = linked_keys(all_rows)
    rowmap = {x["key"]: x for x in all_rows}
    iwd_memo = {}

    def own_iwd(k):
        if k not in iwd_memo:
            iwd_memo[k] = iwd_source(k)
        return iwd_memo[k]

    def fresh(key, st, fp):
        return (not args.force and old.get(key, {}).get("sha256") == fp
                and os.path.isfile(os.path.join(args.out, st + ".webp")))

    for i, r in enumerate(rows, 1):
        key = r["key"]
        st = stem_of(key)
        entry = {"source": None}
        hero = loadscreen = None
        # A stock map never takes catalogue art. MEASURED on the first run: the catalogue
        # entry whose name normalises to `asylum` is "Asylum v2", a community remake, and its
        # cover went onto Verrückt. Treyarch's four have Treyarch's own loading screens.
        # (Nor linked or web art: no tier below site/iwd applies to them.)
        is_stock = r.get("source") == "stock" or key in STOCK
        own = own_iwd(key)
        game = own or (None if args.no_stock else stock_source(key, main_dir))
        game_kind = "iwd" if own else ("stock" if game else None)
        # The order (2026-09-24, "an image for every single map"): the map's own scraped
        # cover; its own loading screen; a linked row's cover, then loading screen (the same
        # map under another row — see linked_keys); a picture from the map's own release page
        # (web_source: UGX thread, the video that thread embeds, its archive.org item); a
        # linked row's web picture. Then stock, then the generated card. Own before linked,
        # so a map that already had a picture keeps it.
        pick = None       # (kind, raw bytes, origin, image-or-None, via)
        if not is_stock:
            mine = [(key, None)]
            others = [(k, k) for k in links.get(key, [])]
            for tier, chain in (("site", mine), ("iwd", mine), ("site", others), ("iwd", others),
                                ("web", mine), ("web", others)):
                for k, via in chain:
                    if tier == "site":
                        s = site_source(k, rowmap.get(k))
                        if s:
                            pick = ("site", s[0], s[1], None, via)
                    elif tier == "iwd":
                        g = own if k == key else own_iwd(k)
                        if g:
                            pick = ("iwd", g[1], g[2], g[0], via)
                    else:
                        w = web_source(k)
                        if w:
                            pick = (w[2], w[0], w[1], None, via)
                    if pick:
                        break
                if pick:
                    break
        if pick and pick[0] != "iwd":
            kind, raw, origin, _, via = pick
            fp = sha(raw)
            entry.update(source=kind, origin=origin, sha256=fp)
            if via:
                entry["via"] = via
            if fresh(key, st, fp):
                hero = "keep"
            else:
                try:
                    hero = cover(Image.open(io.BytesIO(raw)), HERO)
                except Exception as exc:
                    print("  ! %s: scraped art will not decode (%s); falling through" % (key, exc))
                    entry = {"source": None}
                    pick = None
            if pick and game:
                im, raw2, origin2 = game
                entry["loadscreen"] = {"source": game_kind, "origin": origin2, "sha256": sha(raw2)}
                loadscreen = stretch(im, HERO)
        if pick and pick[0] == "iwd":
            _, raw2, origin2, im, via = pick
            fp = sha(raw2)
            entry.update(source="iwd", origin=origin2, sha256=fp)
            if via:
                entry["via"] = via
            hero = "keep" if fresh(key, st, fp) else stretch(im, HERO)
        if not entry["source"] and game and game_kind == "stock":
            im, raw2, origin2 = game
            fp = sha(raw2)
            entry.update(source="stock", origin=origin2, sha256=fp)
            hero = "keep" if fresh(key, st, fp) else stretch(im, HERO)
        if not entry["source"]:
            fp = sha(json.dumps([key, r.get("title"), r.get("author"), r.get("year"), "ph4"]).encode())
            entry.update(source="placeholder", sha256=fp)
            hero = "keep" if fresh(key, st, fp) else placeholder(r)
        counts[entry["source"]] = counts.get(entry["source"], 0) + 1

        if hero != "keep":
            hb = webp_bytes(hero, 80)
            written += write_if_changed(os.path.join(args.out, st + ".webp"), hb)
            written += write_if_changed(os.path.join(args.out, st + ".thumb.webp"), webp_bytes(hero.resize(THUMB, Image.LANCZOS), 76))
        ls_path = os.path.join(args.out, st + ".loadscreen.webp")
        if loadscreen is not None:
            written += write_if_changed(ls_path, webp_bytes(loadscreen, 80))
        elif os.path.isfile(ls_path) and not entry.get("loadscreen"):
            # the server offers a second picture when this file exists; a stale one would
            # offer the same picture twice
            os.remove(ls_path)
        hero_path = os.path.join(args.out, st + ".webp")
        v = sha(open(hero_path, "rb").read())[:10]
        entry["art"] = "%s/%s.webp?v=%s" % (MEDIA_URL, st, v)
        entry["thumb"] = "%s/%s.thumb.webp?v=%s" % (MEDIA_URL, st, v)
        if loadscreen is not None:
            entry["loadscreen"]["url"] = "%s/%s.loadscreen.webp?v=%s" % (MEDIA_URL, st, entry["loadscreen"]["sha256"][:10])
        out[key] = entry
        if i % 200 == 0:
            print("  %d/%d (%.0fs)" % (i, len(rows), time.time() - t0), flush=True)

    total_counts = {"total": len(out), "site": 0, "iwd": 0, "stock": 0, "placeholder": 0,
                    "loadscreens": sum(1 for e in out.values() if e.get("loadscreen"))}
    for e in out.values():
        total_counts[e["source"]] = total_counts.get(e["source"], 0) + 1
    total_counts["linked"] = sum(1 for e in out.values() if e.get("via"))
    json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "tool": "tools/maps/map_art.py", "counts": total_counts, "maps": out},
              open(man_path, "w", encoding="utf-8"), indent=1, sort_keys=True)
    print("art: %s · %d files written · %.0fs" % (json.dumps(total_counts), written, time.time() - t0))

    if args.write_db:
        cols = {c[1] for c in con.execute("PRAGMA table_info(maps)")}
        if "art_source" not in cols:          # the server's migration adds the same column
            con.execute("ALTER TABLE maps ADD COLUMN art_source TEXT")
        n = 0
        with con:
            for key, e in out.items():
                n += con.execute("UPDATE maps SET art=?, art_source=? WHERE key=?", (e["art"], e["source"], key)).rowcount
        print("db: %d maps updated in %s" % (n, dbp))


if __name__ == "__main__":
    main()
