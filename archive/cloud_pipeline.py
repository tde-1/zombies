#!/usr/bin/env python3
"""The unattended cloud archive run (2026-09-26): fetch -> bucket -> extract -> bucket -> free.

B, going to bed: "get ALL those maps, as fast as possible ... if anything fails come up with a
fix and continue". The cloud box has ~27 GB of disk and is wiped when the session ends, so
nothing may live only here: every original and every normalised install goes to the
`enw-zombies` bucket the moment it exists, and the local copy is deleted.

Per map, in order:
  1. fetch.fetch_one            original + sidecar in originals/<norm>/ (mirror fallback, MEGA)
  2. upload original            archive/originals/<norm>/<file> (+ .meta.json)
  3. extract.process            mods/<bsp>/ tree, never running anything
  4. static checks (optional)   $CLOUD_STATIC <norm> <bsp...>, whatever runs on Linux
  5. upload mods/<bsp>/<path>   same keys as tools/s3/sync.js, sha256 in object metadata
  6. record                     reports/extract.json (merged), reports/cloud_pipeline.json
  7. free                       extract/<norm>, mods/<bsp>, the original (the sidecar stays,
                                which is how fetch.py and cloud_queue.py know it is held)

Collisions: a bsp that already has objects under mods/<bsp>/ in the bucket (B's 232 maps, or
an earlier cloud map from another release) is NOT uploaded over; extract's own collision check
is seeded with the bucket's bsps, and the refusal lands in the report for a human.

State goes up every few maps to archive/state/ (extract.json, cloud_pipeline.json,
catalogue.sqlite.gz) so a fresh session, or B's PC (merge_cloud.py), carries on from it.

Fetching is serial (hosts are polite, one request at a time each); extraction and upload run
in worker threads behind it, and fetching pauses when free disk drops under --min-free-gb.

    . /home/user/zwork/env.sh; . /home/user/zwork/s3.env
    python archive/cloud_pipeline.py --queue /home/user/zwork/queue.txt
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extract  # noqa: E402
import fetch  # noqa: E402
from lib import catalogue, net  # noqa: E402

WORK = fetch.WORK
REPORTS = os.path.join(WORK, "reports")
STATUS = os.path.join(REPORTS, "cloud_pipeline.json")
LOG_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()


def log(*parts):
    with LOG_LOCK:
        print(time.strftime("%H:%M:%S"), *parts, flush=True)


# --------------------------------------------------------------------- bucket
def s3client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=os.environ.get("S3_ENDPOINT", "https://nbg1.your-objectstorage.com"),
        region_name="nbg1", aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        config=Config(retries={"max_attempts": 8, "mode": "adaptive"},
                      max_pool_connections=32))


BUCKET = os.environ.get("S3_BUCKET", "enw-zombies")


def bucket_bsps(s3):
    out, token = set(), None
    while True:
        kw = {"Bucket": BUCKET, "Prefix": "mods/", "Delimiter": "/", "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        out.update(p["Prefix"][5:-1] for p in r.get("CommonPrefixes", []))
        if not r.get("IsTruncated"):
            return out
        token = r["NextContinuationToken"]


def put(s3, path, key, sha=None, tries=5):
    """Upload unless an object of the same size (and sha, when we know it) is there."""
    size = os.path.getsize(path)
    try:
        h = s3.head_object(Bucket=BUCKET, Key=key)
        if h["ContentLength"] == size and (not sha or h.get("Metadata", {}).get("sha256") == sha):
            return "same"
    except Exception:
        pass
    extra = {"Metadata": {"sha256": sha}} if sha else {}
    for i in range(tries):
        try:
            s3.upload_file(path, BUCKET, key, ExtraArgs=extra)
            return "up"
        except Exception as exc:
            log("[s3] retry %d %s: %s" % (i + 1, key, exc))
            time.sleep(5 * (i + 1))
    raise RuntimeError("upload failed: " + key)


# --------------------------------------------------------------------- state
def load_status():
    try:
        return json.load(open(STATUS, encoding="utf-8"))
    except Exception:
        return {}


def save_status(st):
    os.makedirs(REPORTS, exist_ok=True)
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=1, sort_keys=True)
    os.replace(tmp, STATUS)


def merge_extract(entry):
    path = os.path.join(REPORTS, "extract.json")
    try:
        cur = json.load(open(path, encoding="utf-8"))
    except Exception:
        cur = []
    by = {e["norm"]: e for e in cur}
    by[entry["norm"]] = entry
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump([by[k] for k in sorted(by)], fh, indent=1)
    os.replace(tmp, path)


def push_state(s3):
    with STATE_LOCK:
        for name in ("extract.json", "cloud_pipeline.json", "fetch.json"):
            p = os.path.join(REPORTS, name)
            if os.path.exists(p):
                put(s3, p, "archive/state/" + name)
        db = os.environ.get("ENW_ARCHIVE_DB", catalogue.DB_PATH)
        if os.path.exists(db):
            gz = os.path.join(WORK, "catalogue.sqlite.gz")
            src = catalogue.connect(db)
            snap = gz[:-3] + ".snap"
            dst = __import__("sqlite3").connect(snap)
            src.backup(dst)
            dst.close()
            with open(snap, "rb") as fi, gzip.open(gz, "wb") as fo:
                shutil.copyfileobj(fi, fo)
            os.remove(snap)
            put(s3, gz, "archive/state/catalogue.sqlite.gz")


# --------------------------------------------------------------------- per map
def process_map(s3, norm, res, taken, args):
    """Steps 2-7 for one fetched map. Returns the status record."""
    rec = {"norm": norm, "name": res.get("name"), "link": res.get("link"),
           "original": os.path.basename(res["file"]), "size": res.get("size"),
           "sha256": res.get("sha256"), "bsps": [], "errors": [], "uploaded_files": 0,
           "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    orig = res["file"]
    base = "archive/originals/%s/" % fetch.SAFE.sub("_", norm)
    put(s3, orig, base + os.path.basename(orig), res.get("sha256"))
    if os.path.exists(orig + ".meta.json"):
        put(s3, orig + ".meta.json", base + os.path.basename(orig) + ".meta.json")
    report = []
    with STATE_LOCK:
        # seed collisions with every bsp the bucket already holds (and ones claimed this run)
        for b in taken:
            extract.OWNERS.setdefault(b, "(already in bucket)")
    out = extract.process(norm, orig, report)
    rec["errors"] += out["errors"]
    rec["installer_kind"] = out["installer_kind"]
    rec["executables"] = len(out["executables"])
    for m in out["mods"]:
        bsp = m["map"]
        with STATE_LOCK:
            if bsp in taken:
                rec["errors"].append("bsp collision: mods/%s already in the bucket" % bsp)
                continue
            taken.add(bsp)
            extract.OWNERS[bsp] = norm
        if args.static:
            try:
                r = subprocess.run([args.static, norm, bsp], capture_output=True, text=True,
                                   timeout=900)
                rec.setdefault("static", {})[bsp] = (r.stdout or r.stderr or "").strip()[-400:]
            except Exception as exc:
                rec.setdefault("static", {})[bsp] = "static checks failed: %s" % exc
        root = os.path.join(extract.MODS, bsp)
        for f in m["files"]:
            rel = f["path"][len("mods/%s/" % bsp):]
            put(s3, os.path.join(root, rel), "mods/%s/%s" % (bsp, rel), f["sha256"])
            rec["uploaded_files"] += 1
        rec["bsps"].append(bsp)
    with STATE_LOCK:
        merge_extract(out)
    # free the disk: the bucket holds all of it now
    shutil.rmtree(os.path.join(extract.EXTRACT, norm), ignore_errors=True)
    for m in out["mods"]:
        if m["map"] in rec["bsps"]:
            shutil.rmtree(os.path.join(extract.MODS, m["map"]), ignore_errors=True)
    if not args.keep_originals:
        try:
            os.remove(orig)
        except OSError:
            pass
    rec["ok"] = bool(rec["bsps"])
    return rec


def free_gb():
    return shutil.disk_usage(WORK).free / 2**30


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True, help="cloud_queue.py output (one name per line)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--min-free-gb", type=float, default=8)
    ap.add_argument("--max-file-mb", type=int, default=4000)
    ap.add_argument("--max-mirrors", type=int, default=4)
    ap.add_argument("--static", default=os.environ.get("CLOUD_STATIC"),
                    help="command run as <cmd> <norm> <bsp> after extraction")
    ap.add_argument("--keep-originals", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    args = ap.parse_args()

    extract.HARDLINK = True          # mods/<bsp>/ hard-linked into extract/: half the disk
    s3 = s3client()
    taken = bucket_bsps(s3)
    log("[start] bucket holds %d bsps; free %.1f GB" % (len(taken), free_gb()))
    status = load_status()
    names = []
    for ln in open(args.queue, encoding="utf-8"):
        ln = ln.split("#")[0].strip()
        if ln:
            names.append(ln)
    norms = list(dict.fromkeys(catalogue.normalise(n) for n in names))

    db = catalogue.connect()
    ps = net.PoliteSession(log_name="cloud")
    fargs = types.SimpleNamespace(max_file_mb=args.max_file_mb, max_mirrors=args.max_mirrors)
    work = queue.Queue(maxsize=args.workers * 2)
    done_count = [0]

    def worker():
        while True:
            item = work.get()
            if item is None:
                return
            norm, res = item
            try:
                rec = process_map(s3, norm, res, taken, args)
            except Exception as exc:
                rec = {"norm": norm, "ok": False, "stage": "process",
                       "errors": ["%s: %s" % (exc.__class__.__name__, exc)],
                       "trace": traceback.format_exc()[-1500:]}
            with STATE_LOCK:
                status[norm] = rec
                save_status(status)
                done_count[0] += 1
            log("[done] %-24s %s %s" % (norm, "OK " + ",".join(rec.get("bsps", [])) if rec.get("ok")
                                        else "FAIL", "; ".join(rec.get("errors", []))[:200]))
            if done_count[0] % 5 == 0:
                try:
                    push_state(s3)
                except Exception as exc:
                    log("[state] push failed: %s" % exc)
            work.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(args.workers)]
    for t in threads:
        t.start()

    for norm in norms:
        prev = status.get(norm)
        if prev and (prev.get("ok") or prev.get("final")) and not (args.retry_failed and not prev.get("ok")):
            continue
        while free_gb() < args.min_free_gb:
            log("[disk] %.1f GB free; waiting for uploads" % free_gb())
            time.sleep(20)
        try:
            res = fetch.fetch_one(db, ps, norm, [1 << 50], fargs)
        except Exception as exc:
            res = {"norm": norm, "status": "%s: %s" % (exc.__class__.__name__, exc)}
        if res.get("status") != "ok":
            with STATE_LOCK:
                status[norm] = {"norm": norm, "ok": False, "stage": "fetch", "final": True,
                                "errors": [res.get("status")], "tried": res.get("tried"),
                                "name": res.get("name")}
                save_status(status)
            log("[fetch] %-24s %s" % (norm, res.get("status")))
            continue
        if not os.path.exists(res.get("file", "")):
            # reused sidecar whose original was already uploaded and freed
            with STATE_LOCK:
                if norm not in status:
                    status[norm] = {"norm": norm, "ok": False, "stage": "fetch",
                                    "errors": ["sidecar present, original gone (already processed?)"]}
                    save_status(status)
            continue
        work.put((norm, res))

    for _ in threads:
        work.put(None)
    for t in threads:
        t.join()
    push_state(s3)
    ok = sum(1 for r in status.values() if r.get("ok"))
    log("[end] %d ok of %d recorded" % (ok, len(status)))


if __name__ == "__main__":
    main()
