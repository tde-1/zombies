#!/usr/bin/env python3
"""Ingest what B downloaded by hand: browser-drop/ -> originals/, same as fetch.py would.

browser_queue.py lists the links the robot must leave to a human. B saves each download
into `<work>/browser-drop/<norm>/` (or loose at the top, if she forgot the folder); this
tool gives it the exact treatment a robot fetch gets -- sha256, AV scan, a move into
`originals/<norm>/` and a `.meta.json` sidecar in fetch.py's schema, plus
`"fetched_by": "browser"` so the provenance is never confused.

Matching a loose file: exact byte size against a queue link's catalogued size (only
where the host reported it exactly), then filename. Anything ambiguous or unmatched is
left where it is and listed in reports/browser-ingest.json -- guessing would file a map
under the wrong name forever. `--as <norm> <file>` settles one by hand.

Nothing here executes what it handles: files are only read, hashed, scanned and moved.
HTML files and anything under 64 KiB are refused -- that is an error page saved by a
browser, not a map.

  python ingest_browser.py
  python ingest_browser.py --as "zombie hotel 2" C:\\...\\browser-drop\\hotel.rar
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402
import browser_queue  # noqa: E402
import fetch  # noqa: E402

WORK = fetch.WORK
DROP = os.path.join(WORK, "browser-drop")
MIN_BYTES = 64 * 1024


def _queue(db, path):
    """The queue B worked from if it is on disk (it may carry --fetch-report items a
    fresh build would miss), else a fresh build."""
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)["items"]
    return browser_queue.build(db)["items"]


def refuse_reason(path):
    name = path.lower()
    if name.endswith((".html", ".htm")):
        return "HTML file - an error page, not a map"
    size = os.path.getsize(path)
    if size < MIN_BYTES:
        return "only %d bytes - almost certainly an error page" % size
    with open(path, "rb") as fh:
        head = fh.read(512).lstrip().lower()
    if head.startswith((b"<!doctype html", b"<html")):
        return "contents are HTML - an error page saved under a map's name"
    return None


def match_loose(path, queue):
    """-> (item, None) or (None, why). Size first (exact sizes only), then filename."""
    size, name = os.path.getsize(path), os.path.basename(path).lower()
    named = lambda pool: [i for i in pool if (i.get("filename") or "").lower() == name]
    by_size = [i for i in queue if i.get("size_exact") and i.get("size") == size]
    for pool in ((by_size, named(by_size)) if by_size else (named(queue),)):
        if len({i["norm"] for i in pool}) == 1:
            return (named(pool) or pool)[0], None
    pool = by_size or named(queue)
    if pool:
        return None, "ambiguous: " + ", ".join(sorted({i["norm"] for i in pool}))
    return None, "no queue link with this exact size or filename"


def link_for(path, norm, queue):
    """The queue link a file in a norm folder most likely came from, or None."""
    mine = [i for i in queue if i["norm"] == norm]
    size, name = os.path.getsize(path), os.path.basename(path).lower()
    for pick in ([i for i in mine if i.get("size_exact") and i.get("size") == size],
                 [i for i in mine if (i.get("filename") or "").lower() == name],
                 mine if len(mine) == 1 else []):
        if len(pick) == 1:
            return pick[0]
    return None


def set_aside(norm):
    """Originals are never deleted: a replaced set moves to <work>/replaced/, whole."""
    src = os.path.join(fetch.ORIGINALS, fetch.SAFE.sub("_", norm))
    dst = os.path.join(WORK, "replaced", "%s-%s" % (fetch.SAFE.sub("_", norm),
                                                    time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(src, dst)


def ingest_one(db, path, norm, item, no_av):
    rows = list(db.execute("SELECT source,name,source_url FROM maps WHERE norm=?", (norm,)))
    if not rows:
        return {"file": path, "status": "unmatched", "why": "norm %r not in catalogue" % norm}
    rows.sort(key=lambda r: browser_queue.SOURCE_ORDER.get(r["source"], 3))
    row = rows[0]
    final_dir = os.path.join(fetch.ORIGINALS, fetch.SAFE.sub("_", norm))
    size = os.path.getsize(path)
    fetched = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(os.path.getmtime(path)))
    digest = fetch.sha256_of(path)
    scan = {"result": "not scanned"} if no_av else fetch.av_scan(path)
    os.makedirs(final_dir, exist_ok=True)
    final = os.path.join(final_dir, fetch.SAFE.sub("_", os.path.basename(path)))
    shutil.move(path, final)   # may cross volumes, unlike fetch.py's quarantine
    meta = {
        "map": row["name"], "norm": norm,
        "catalogue_source": item["catalogue_source"] if item else row["source"],
        "source_page": item["source_page"] if item else row["source_url"],
        "download_url": item["url"] if item else None,
        "resolved_url": None,
        "file": os.path.basename(final), "size": size, "sha256": digest,
        "fetched": fetched,   # the browser's write time, not ours
        "user_agent": None, "av": scan,
        "note": "ORIGINAL - never modify, never execute (dev-box.md rule 3)",
        "fetched_by": "browser",
    }
    with open(final + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return {"file": final, "norm": norm, "status": "ok", "size": size, "sha256": digest,
            "download_url": meta["download_url"], "av": scan.get("result")}


def run(args):
    db = catalogue.connect()
    queue = _queue(db, args.queue)
    todo = []   # (path, norm or None, forced)
    if args.as_:
        norm, path = args.as_
        todo.append((os.path.abspath(path), catalogue.normalise(norm), True))
    elif os.path.isdir(args.drop):
        for name in sorted(os.listdir(args.drop)):
            p = os.path.join(args.drop, name)
            if os.path.isfile(p):
                todo.append((p, None, False))
            elif os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for f in sorted(files):
                        todo.append((os.path.join(root, f), name, False))
    # A folder is named by SAFE(norm); map it back to the catalogue norm.
    folder_norm = {fetch.SAFE.sub("_", n): n for (n,) in db.execute("SELECT DISTINCT norm FROM maps")}
    was_held, results = {}, []
    for path, norm, forced in todo:
        why = refuse_reason(path)
        if why:
            results.append({"file": path, "status": "refused", "why": why})
            continue
        if norm is None:
            item, why = match_loose(path, queue)
            if not item:
                results.append({"file": path, "status": "unmatched", "why": why})
                continue
            norm = item["norm"]
        else:
            if not forced:
                norm = folder_norm.get(norm, norm)
            item = link_for(path, norm, queue)
        # Idempotence is judged on the state at run start, so several files in one
        # folder all land, and --replace moves the old set aside once, not per file.
        if norm not in was_held:
            was_held[norm] = browser_queue.held(norm)
            if was_held[norm] and args.replace:
                set_aside(norm)
        if was_held[norm] and not args.replace:
            results.append({"file": path, "norm": norm, "status": "skipped",
                            "why": "already ingested (use --replace)"})
            continue
        results.append(ingest_one(db, path, norm, item, args.no_av))
    os.makedirs(args.out_dir, exist_ok=True)
    report = {"ingested": [r for r in results if r["status"] == "ok"],
              "skipped": [r for r in results if r["status"] == "skipped"],
              "refused": [r for r in results if r["status"] == "refused"],
              "unmatched": [r for r in results if r["status"] == "unmatched"]}
    with open(os.path.join(args.out_dir, "browser-ingest.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    print("  ".join("%s %d" % (k, len(v)) for k, v in report.items()))
    for r in report["refused"] + report["unmatched"]:
        print("  %-9s %s: %s" % (r["status"], os.path.basename(r["file"]), r["why"]))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--drop", default=DROP)
    ap.add_argument("--queue", default=os.path.join(WORK, "reports", "browser-queue.json"))
    ap.add_argument("--out-dir", default=os.path.join(WORK, "reports"))
    ap.add_argument("--as", dest="as_", nargs=2, metavar=("NORM", "FILE"),
                    help="file this one file under this map, whatever it matches")
    ap.add_argument("--replace", action="store_true",
                    help="re-ingest a map already in originals/ (old set moved to replaced/)")
    ap.add_argument("--no-av", action="store_true", help="TESTS ONLY: skip the AV scan")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    main()
