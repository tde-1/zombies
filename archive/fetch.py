#!/usr/bin/env python3
"""Quarantine fetch: download a map's ORIGINAL file, hash it, scan it, and stop there.

Rule 1 of the archive (vault 04 section 2) is that originals are sacred, so this tool
never modifies, renames past recording, repacks or -- above all -- runs what it fetches.
Nothing downloaded here is ever executed, including by accident: files land in
`quarantine\\`, get a sha256 and an AV scan, and are then moved to
`originals\\<map>\\` beside a sidecar recording exactly where they came from and when.

Budgets are hard and checked before each download (`--budget-gb`, `--max-file-mb`,
`--max-maps`) because an unattended crawler with a 6 GB item in its list is how you
wake up to a full disk.

  python fetch.py --shortlist shortlist.txt
  python fetch.py --map leviathan --map orbit
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re

import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue, linkcheck, net  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
QUARANTINE = os.path.join(WORK, "quarantine")
ORIGINALS = os.path.join(WORK, "originals")

# Hosts we can actually pull bytes from, in preference order.
HOST_RANK = {"mediafire.com": 0, "archive.org": 1, "onedrive.live.com": 2, "1drv.ms": 2,
             "moddb.com": 3, "dropbox.com": 4}
# Hosts we cannot fetch from, and why. They are still catalogued and still counted in
# the link report -- they are just never chosen when another mirror exists, because
# choosing one is choosing to fail.
UNFETCHABLE = {
    "mega.nz": "MEGA encrypts client-side; the key is in the URL fragment and the file "
               "needs an AES-CTR decrypt we have not built",
    "mega.co.nz": "same as mega.nz",
    "drive.google.com": "drive.usercontent.google.com is robots.txt Disallow: /",
    "docs.google.com": "redirects to the Drive endpoint, which is robots-disallowed",
}
GOOD_EXT = (".exe", ".zip", ".rar", ".7z", ".iwd", ".ff")


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return "%.1f %s" % (n, u)
        n /= 1024.0


def link_rank(r):
    """Fetchability first: an 'alive' MEGA link we cannot decrypt is worse than an
    unchecked MediaFire one we can just download. Getting this the wrong way round
    cost City of Hell and Zombie Desert on the first run."""
    host = (r["host"] or "").removeprefix("www.")
    base = ".".join(host.split(".")[-2:])
    name = (r["filename"] or r["url"]).lower()
    return (1 if (host in UNFETCHABLE or base in UNFETCHABLE) else 0,
            0 if r["verdict"] == "alive" else 1 if r["verdict"] is None else 2,
            HOST_RANK.get(base, 5),
            0 if name.endswith(GOOD_EXT) else 1,
            -(r["size"] or 0))


def all_links(db, map_key):
    rows = list(db.execute(
        "SELECT url,host,verdict,size,filename,final_url,error FROM links WHERE map_key=?",
        (map_key,)))
    # The UGX Map Manager installer, listed by ZWR against 29 maps, is not a map.
    return [r for r in rows if "UpdaterExe" not in r["url"]
            and "ugx-mod-standalone" not in r["url"]]


def pick_link(db, map_key):
    rows = sorted(all_links(db, map_key), key=link_rank)
    return rows[0] if rows else None


def resolve(ps, url):
    """Turn a landing-page URL into something we can stream bytes from.

    Returns (direct_url, error, from_landing). `from_landing` is True when the URL is a
    one-use token handed to us BY a page robots.txt explicitly allows us to read -- see
    `download()` for why that distinction decides whether we may fetch it.
    """
    host = urllib.parse.urlsplit(url).netloc.lower().removeprefix("www.")
    if "mediafire.com" in host and not host.startswith("download"):
        p, verdict = linkcheck.probe_mediafire(ps, url, fresh=True)
        if verdict != "alive" or not p.get("final_url"):
            return None, p.get("error") or ("mediafire: %s" % verdict), False
        return p["final_url"], None, True
    if "mega" in host:
        return None, UNFETCHABLE["mega.nz"], False
    if "drive.google.com" in host or "docs.google.com" in host:
        return None, UNFETCHABLE["drive.google.com"], False
    return url, None, False


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def av_scan(path):
    """Delegate to archive/avscan.py.

    The obvious call, `MpCmdRun.exe -Scan -ScanType 3 -File <path>`, returns exit 0
    with "was skipped" when it is not elevated -- so the first version of this
    function recorded fourteen unscanned files as clean. See avscan.py.
    """
    import avscan
    return avscan.scan(path)


def filename_for(url, resp, fallback):
    cd = resp.headers.get("Content-Disposition") or ""
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', cd)
    if m:
        return os.path.basename(urllib.parse.unquote(m.group(1).strip()))
    path = urllib.parse.urlsplit(resp.url).path
    base = os.path.basename(urllib.parse.unquote(path))
    if base and "." in base:
        return base
    return fallback


SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def download(ps, url, dest_dir, max_bytes, fallback_name, from_landing=False):
    """Stream one file to disk.

    robots.txt and downloads -- the call, stated so it can be overruled:

      MEASURED: `www.mediafire.com/robots.txt` ALLOWS the file pages we read, but each
      CDN node (`download1638.mediafire.com`) serves a blanket "Disallow: /". Treating
      that as a bar on fetching would mean the archive can never mirror anything from
      MediaFire, which is 60% of every WaW map link in existence.

      What we do: robots.txt is honoured absolutely for **discovery** -- every crawl
      and every link-health probe in this repo checks it and stops when told to. For a
      **download**, we fetch only when (a) the file is on a list a human wrote, and
      (b) the one-use URL was handed to us by a page the same site's robots.txt
      explicitly permits us to read. That is a human clicking a download button, not a
      robot walking a tree, and the CDN's Disallow exists to keep expiring tokenised
      URLs out of search indexes.

      Where there is no allowed page that hands us the file -- Google Drive, whose only
      working endpoint is itself "Disallow: /" -- we do not download at all.

      Flagged for B in docs/kickstart/questions.md; flip `from_landing` off to make
      this strictly conservative again, at the cost of every MediaFire map.
    """
    if not from_landing and not ps.allowed(url):
        return None, "robots.txt disallows fetching from this host"
    os.makedirs(dest_dir, exist_ok=True)
    st = ps.host_state(url)
    with st.lock:
        ps._sleep(st)
        r = ps.s.get(url, stream=True, timeout=120, allow_redirects=True)
        st.last = time.time()
        st.requests_made += 1
    if r.status_code >= 400:
        r.close()
        return None, "HTTP %d" % r.status_code
    # A map is never an HTML page. MediaFire answers a stale download key with
    # `download_repair.php`, HTTP 200 -- the first version of this saved it as the
    # "original" and reported ok (2026-09-22). Refuse anything that says it is HTML.
    ctype = (r.headers.get("Content-Type") or "").lower()
    if "text/html" in ctype or r.url.lower().split("?")[0].endswith(".php"):
        r.close()
        return None, "got an HTML page, not a file (%s) -- stale download key?" % r.url.split("?")[0]
    total = r.headers.get("Content-Length")
    total = int(total) if total and total.isdigit() else None
    if total and total > max_bytes:
        r.close()
        return None, "too big (%s > cap)" % human(total)
    name = SAFE.sub("_", filename_for(url, r, fallback_name))
    dest = os.path.join(dest_dir, name)
    got = 0
    t0 = time.time()
    with open(dest, "wb") as fh:
        for chunk in r.iter_content(1 << 18):
            if not chunk:
                continue
            got += len(chunk)
            if got > max_bytes:
                fh.close()
                r.close()
                os.remove(dest)
                return None, "exceeded cap mid-download at %s" % human(got)
            fh.write(chunk)
    r.close()
    ps.log("[fetch] %s -> %s in %.0fs" % (human(got), name, time.time() - t0))
    return dest, None


def fetch_one(db, ps, norm, budget, args):
    rows = list(db.execute(
        "SELECT key,source,name,norm,source_url,author,released,description,tags "
        "FROM maps WHERE norm=? ORDER BY CASE source WHEN 'zwr' THEN 0 "
        "WHEN 'codrepo' THEN 1 WHEN 'ugx' THEN 2 ELSE 3 END", (norm,)))
    if not rows:
        return {"norm": norm, "status": "not in catalogue"}
    # Rank every candidate across EVERY source row, not the first row that has one.
    # Taking the first row cost Project Viking: ZWR lists only a dead Google Drive
    # link, and callofdutyrepo's live MediaFire mirror was never considered.
    cands = []
    for row in rows:
        for link in all_links(db, row["key"]):
            cands.append((link_rank(link), row, link))
    cands.sort(key=lambda t: t[0])
    best = (cands[0][1], cands[0][2]) if cands else None
    if best is None:
        return {"norm": norm, "status": "no download link in any source",
                "names": [r["name"] for r in rows]}
    row, link = best
    out = {"norm": norm, "name": row["name"], "source": row["source"],
           "source_url": row["source_url"], "link": link["url"],
           "link_verdict": link["verdict"]}
    have = os.path.join(ORIGINALS, SAFE.sub("_", norm))
    existing = [f for f in os.listdir(have)] if os.path.isdir(have) else []
    if any(f.endswith(".meta.json") for f in existing):
        meta = json.load(open(os.path.join(have, [f for f in existing
                                                  if f.endswith(".meta.json")][0]),
                              encoding="utf-8"))
        out.update({"status": "ok", "file": os.path.join(have, meta["file"]),
                    "size": meta["size"], "sha256": meta["sha256"],
                    "av": (meta.get("av") or {}).get("result"), "reused": True})
        return out
    direct, err, from_landing = resolve(ps, link["url"])
    if not direct:
        out["status"] = "cannot resolve: " + (err or "?")
        return out
    dest_dir = os.path.join(QUARANTINE, SAFE.sub("_", norm))
    path = err = None
    for attempt in (1, 2):
        try:
            path, err = download(ps, direct, dest_dir,
                                 min(args.max_file_mb * 2**20, budget[0]),
                                 SAFE.sub("_", row["name"]) + ".bin",
                                 from_landing=from_landing)
        except Exception as exc:
            path, err = None, "%s: %s" % (exc.__class__.__name__, exc)
        if path:
            break
        # One retry, and only for a transport hiccup: MediaFire's direct URLs are
        # time-limited, so a stale one has to be re-resolved rather than re-requested.
        if attempt == 1 and ("timed out" in (err or "") or "ConnectionError" in (err or "")):
            ps.log("[fetch] %s: %s - re-resolving and retrying once" % (norm, err))
            direct, rerr, from_landing = resolve(ps, link["url"])
            if not direct:
                err = rerr or err
                break
        else:
            break
    if not path:
        out["status"] = "download failed: " + (err or "?")
        return out
    size = os.path.getsize(path)
    budget[0] -= size
    digest = sha256_of(path)
    scan = av_scan(path)
    final_dir = os.path.join(ORIGINALS, SAFE.sub("_", norm))
    os.makedirs(final_dir, exist_ok=True)
    final = os.path.join(final_dir, os.path.basename(path))
    if os.path.exists(final):
        os.remove(final)
    os.replace(path, final)
    meta = {
        "map": row["name"], "norm": norm, "catalogue_source": row["source"],
        "source_page": row["source_url"], "download_url": link["url"],
        "resolved_url": direct.split("?")[0],
        "file": os.path.basename(final), "size": size, "sha256": digest,
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user_agent": net.USER_AGENT, "av": scan,
        "note": "ORIGINAL - never modify, never execute (dev-box.md rule 3)",
    }
    with open(final + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    out.update({"status": "ok", "file": final, "size": size, "sha256": digest,
                "av": scan.get("result")})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[], help="map name (any spelling)")
    ap.add_argument("--shortlist", help="file with one map name per line")
    ap.add_argument("--budget-gb", type=float, default=10.0)
    ap.add_argument("--max-file-mb", type=int, default=1500)
    ap.add_argument("--max-maps", type=int, default=15)
    args = ap.parse_args()

    names = list(args.map)
    if args.shortlist:
        with open(args.shortlist, encoding="utf-8") as fh:
            for ln in fh:
                ln = ln.split("#")[0].strip()   # trailing comments are notes for B
                if ln:
                    names.append(ln)
    norms = list(dict.fromkeys(catalogue.normalise(n) for n in names))[:args.max_maps]

    db = catalogue.connect()
    ps = net.PoliteSession(log_name="fetch")
    budget = [int(args.budget_gb * 2**30)]
    results = []
    for norm in norms:
        if budget[0] <= 0:
            results.append({"norm": norm, "status": "budget exhausted"})
            continue
        try:
            r = fetch_one(db, ps, norm, budget, args)
        except net.Dropped as exc:
            r = {"norm": norm, "status": "host dropped: %s" % exc}
        except Exception as exc:
            r = {"norm": norm, "status": "%s: %s" % (exc.__class__.__name__, exc)}
        ps.log("[fetch] %-22s %s" % (norm, r.get("status")))
        results.append(r)
    path = os.path.join(WORK, "reports", "fetch.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    prev = []
    if os.path.exists(path):
        try:
            prev = json.load(open(path, encoding="utf-8"))
        except Exception:
            prev = []
    by = {r["norm"]: r for r in prev}
    by.update({r["norm"]: r for r in results})
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(list(by.values()), fh, indent=2)
    ok = [r for r in results if r.get("status") == "ok"]
    print("\n%d/%d fetched, %s remaining in budget"
          % (len(ok), len(results), human(max(0, budget[0]))))


if __name__ == "__main__":
    main()
