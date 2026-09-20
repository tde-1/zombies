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
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue, linkcheck, net  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
QUARANTINE = os.path.join(WORK, "quarantine")
ORIGINALS = os.path.join(WORK, "originals")
MPCMDRUN = r"C:\Program Files\Windows Defender\MpCmdRun.exe"

# Hosts we are willing to pull bytes from, in preference order. archive.org first
# because it is a preservation institution serving files it already hosts; MediaFire
# and MEGA next because that is where these maps actually live.
HOST_RANK = {"archive.org": 0, "mediafire.com": 1, "mega.nz": 2, "mega.co.nz": 2,
             "moddb.com": 3, "drive.google.com": 4, "docs.google.com": 4,
             "onedrive.live.com": 5, "dropbox.com": 5}
GOOD_EXT = (".exe", ".zip", ".rar", ".7z", ".iwd", ".ff")


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return "%.1f %s" % (n, u)
        n /= 1024.0


def pick_link(db, map_key):
    """Best download link for a map: alive first, then by host preference, then by
    a filename that looks like a map rather than an installer for someone's manager."""
    rows = list(db.execute(
        "SELECT url,host,verdict,size,filename,final_url,error FROM links WHERE map_key=?",
        (map_key,)))
    def rank(r):
        host = (r["host"] or "").removeprefix("www.")
        base = ".".join(host.split(".")[-2:])
        name = (r["filename"] or r["url"]).lower()
        return (0 if r["verdict"] == "alive" else 1 if r["verdict"] is None else 2,
                HOST_RANK.get(base, 9),
                0 if name.endswith(GOOD_EXT) else 1,
                -(r["size"] or 0))
    rows = [r for r in rows if "UpdaterExe" not in r["url"]]   # the UGX manager, not a map
    rows.sort(key=rank)
    return rows[0] if rows else None


def resolve(ps, url):
    """Turn a landing-page URL into something we can stream bytes from."""
    host = urllib.parse.urlsplit(url).netloc.lower().removeprefix("www.")
    if "mediafire.com" in host and not host.startswith("download"):
        p, verdict = linkcheck.probe_mediafire(ps, url)
        if verdict != "alive" or not p.get("final_url"):
            return None, p.get("error") or ("mediafire: %s" % verdict)
        return p["final_url"], None
    if "mega" in host:
        # MEGA needs the fragment key and a decrypt step; out of scope for tonight.
        return None, "MEGA needs a client-side decrypt - not implemented"
    if "drive.google.com" in host or "docs.google.com" in host:
        m = linkcheck.GD_ID.search(url)
        if not m:
            return None, "no drive id"
        fid = m.group(1) or m.group(2)
        return linkcheck.GD_DL % fid + "&confirm=t", None
    return url, None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def av_scan(path):
    """Windows Defender, on demand, on one file. Recorded either way."""
    if not os.path.exists(MPCMDRUN):
        return {"scanner": None, "result": "no scanner available"}
    try:
        r = subprocess.run([MPCMDRUN, "-Scan", "-ScanType", "3", "-File", path,
                            "-DisableRemediation"],
                           capture_output=True, text=True, timeout=900)
        out = (r.stdout or "") + (r.stderr or "")
        clean = "found no threats" in out.lower() or r.returncode == 0
        return {"scanner": "Windows Defender MpCmdRun", "returncode": r.returncode,
                "result": "clean" if clean else "THREAT OR ERROR",
                "output": out.strip()[-2000:]}
    except Exception as exc:
        return {"scanner": "Windows Defender MpCmdRun",
                "result": "scan failed: %s: %s" % (exc.__class__.__name__, exc)}


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


def download(ps, url, dest_dir, max_bytes, fallback_name):
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
    best = None
    for row in rows:
        link = pick_link(db, row["key"])
        if link and (best is None or link["verdict"] == "alive"):
            best = (row, link)
            if link["verdict"] == "alive":
                break
    if best is None:
        return {"norm": norm, "status": "no download link in any source",
                "names": [r["name"] for r in rows]}
    row, link = best
    out = {"norm": norm, "name": row["name"], "source": row["source"],
           "source_url": row["source_url"], "link": link["url"],
           "link_verdict": link["verdict"]}
    direct, err = resolve(ps, link["url"])
    if not direct:
        out["status"] = "cannot resolve: " + (err or "?")
        return out
    dest_dir = os.path.join(QUARANTINE, SAFE.sub("_", norm))
    path, err = download(ps, direct, dest_dir, min(args.max_file_mb * 2**20, budget[0]),
                         SAFE.sub("_", row["name"]) + ".bin")
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
            names += [ln.strip() for ln in fh
                      if ln.strip() and not ln.startswith("#")]
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
