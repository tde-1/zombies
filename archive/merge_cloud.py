#!/usr/bin/env python3
"""Bring the cloud archive run's maps onto B's PC (the other half of cloud_pipeline.py).

The cloud session (archive/cloud_pipeline.py) fetches, extracts and uploads every map to the
public `enw-zombies` bucket, then deletes its local copy. Its state goes to
`archive/state/extract.json` (extract.py's schema) and `archive/state/cloud_pipeline.json`
({norm: {"bsps": [...uploaded...], ...}}). Everything downstream on B's PC keys off her own
`<work>/reports/extract.json` and `<work>/mods/<bsp>/`:

  * the site lists and serves only files that exist under `m.dest` (web/server/lib/mapfiles.js
    read(): statSync per file), and the box's map cache asks the SITE for that list;
  * scan_maps.py / precheck.py read the .ff/.iwd under `<work>/mods/<bsp>/` to write the
    manifest that import-archive.js and popular.py need;
  * box_stage.py and scan_maps.py read `<work>/originals/<norm>/*.meta.json`.

So this script:
  1. fetches the cloud extract.json (+ cloud_pipeline.json, to keep only bsps really uploaded);
  2. MERGES it into <work>/reports/extract.json. It never overwrites an existing entry: a norm
     already there is left alone, and a bsp another original already owns is a conflict,
     written to <work>/reports/cloud-merge-conflicts.json for a human, never merged;
     merged mods get `dest` = <work>/mods/<bsp> (the cloud's was a Linux path);
  3. appends the newly merged bsps to archive/cloud-maps.txt (the batch list every later
     step takes: tranche.py --list, box_proof.py --map-list, import-archive.js --maps-list);
  4. fetches each new norm's original sidecar (`archive/originals/<norm>/<file>.meta.json`)
     into <work>/originals/<norm>/ (tiny; the original itself stays in the bucket);
  5. --pull-mods: downloads mods/<bsp>/<path> from the public bucket into <work>/mods/<bsp>/,
     each file checked against extract.json's size + sha256. A new map is staged beside
     mods/ and renamed in only when complete, so the site never lists half a map.

    python archive/merge_cloud.py --dry
    python archive/merge_cloud.py --pull-mods
    python archive/merge_cloud.py --pull-mods --map nazi_zombie_x      # (re)pull one map
    python archive/merge_cloud.py --from-file extract.json --status-file cloud_pipeline.json

Idempotent: a second run merges nothing new, and --pull-mods skips files already verified.
Nothing here executes anything, and no executable is downloaded (dev-box rule 3).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
BASE = os.environ.get("ENW_MAP_BUCKET_URL", "https://enw-zombies.nbg1.your-objectstorage.com").rstrip("/")
LIST = os.path.join(HERE, "cloud-maps.txt")
# Never fetched onto B's PC, whatever a list says (mapcache.js REFUSED_EXT).
REFUSED_EXT = {".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".msi", ".sh"}
SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
RETRY_SLEEP = 3   # seconds, times the attempt number
UA = ("ENWZombiesArchive/0.1 (+https://enw.gg; World at War custom-zombies map preservation; "
      "merge_cloud)")


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------ http
def http_get(url, timeout=120):
    """-> (status, iterator of bytes chunks). Replaced by the tests."""
    import requests
    r = requests.get(url, stream=True, timeout=timeout, headers={"User-Agent": UA})
    if r.status_code != 200:
        r.close()
        return r.status_code, iter(())
    return 200, r.iter_content(1 << 20)


def get_json(url):
    st, it = http_get(url)
    if st != 200:
        raise RuntimeError("GET %s -> %s" % (url, st))
    return json.loads(b"".join(it).decode("utf-8"))


def key_url(key):
    return BASE + "/" + "/".join(urllib.parse.quote(s, safe="") for s in key.split("/"))


def safe_norm(norm):
    """fetch.SAFE.sub('_', norm) without importing fetch (and its dependencies)."""
    out, prev = [], False
    for ch in norm:
        if ch in SAFE_CHARS:
            out.append(ch)
            prev = False
        elif not prev:
            out.append("_")
            prev = True
    return "".join(out)


# ------------------------------------------------------------------------------ files
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, obj, indent=2):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=indent)
    os.replace(tmp, path)


def read_list(path):
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            for ln in fh:
                b = ln.split("#")[0].strip().split()
                if b and b[0] not in out:
                    out.append(b[0])
    except OSError:
        pass
    return out


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def rel_of(bsp, f):
    """extract.json's `mods/<bsp>/<rel>` -> <rel>, or None when it is not safe to join."""
    p = str(f.get("path", "")).replace("\\", "/")
    pre = "mods/%s/" % bsp
    if not p.startswith(pre):
        return None
    rel = p[len(pre):]
    parts = rel.split("/")
    if not rel or ".." in parts or "" in parts or rel.startswith("/") or ":" in parts[0]:
        return None
    return rel


# ------------------------------------------------------------------------------ merge
def merge(local, cloud, status, work):
    """Pure: -> (merged list, newly merged norms, newly merged bsps, conflicts, notes).
    Never changes an existing local entry -- except one this script merged earlier that
    carried no map (a cloud failure), which a later cloud retry may replace.
    `status` is cloud_pipeline.json or None (trust extract.json)."""
    by_norm = {e["norm"]: e for e in local}
    owner = {}
    for e in local:
        for m in e.get("mods") or []:
            owner.setdefault(m["map"], e["norm"])
    new_norms, new_bsps, conflicts, notes = [], [], [], []
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for e in sorted(cloud, key=lambda x: x.get("norm", "")):
        norm = e.get("norm")
        if not norm:
            continue
        old = by_norm.get(norm)
        if old is not None and not (old.get("cloud") and not old.get("mods")):
            continue
        if old is not None and not (e.get("mods") or []):
            continue   # still nothing: keep the first record
        uploaded = None
        if status is not None:
            rec = status.get(norm)
            uploaded = set((rec or {}).get("bsps") or [])
        entry = dict(e)
        entry["errors"] = list(e.get("errors") or [])
        mods = []
        for m in e.get("mods") or []:
            bsp = m.get("map")
            if not bsp:
                continue
            if uploaded is not None and bsp not in uploaded:
                notes.append("%s: %s not in cloud_pipeline.json's uploaded bsps; left out" % (norm, bsp))
                entry["errors"].append("cloud: mods/%s not uploaded; not merged" % bsp)
                continue
            if bsp in owner and owner[bsp] != norm:
                conflicts.append({"bsp": bsp, "cloud_norm": norm, "cloud_original": e.get("original"),
                                  "local_norm": owner[bsp], "at": stamp})
                entry["errors"].append("bsp collision: mods/%s already belongs to %s; cloud copy not merged"
                                       % (bsp, owner[bsp]))
                continue
            m = dict(m)
            m["cloud_dest"] = m.get("dest")
            m["dest"] = os.path.join(work, "mods", bsp)
            mods.append(m)
            owner[bsp] = norm
            new_bsps.append(bsp)
        entry["mods"] = mods
        entry["cloud"] = {"merged": stamp, "source": "archive/state/extract.json"}
        by_norm[norm] = entry
        new_norms.append(norm)
    return [by_norm[k] for k in sorted(by_norm)], new_norms, new_bsps, conflicts, notes


# ------------------------------------------------------------------------------ pull
def download(url, out, size, sha):
    """One file, checked on the fly. Writes <out>.part, renames on success."""
    os.makedirs(os.path.dirname(out), exist_ok=True)
    part = out + ".part"
    h = hashlib.sha256()
    n = 0
    st, it = http_get(url)
    if st != 200:
        raise RuntimeError("HTTP %s" % st)
    with open(part, "wb") as fh:
        for chunk in it:
            if chunk:
                fh.write(chunk)
                h.update(chunk)
                n += len(chunk)
    got = h.hexdigest()
    if size is not None and n != size:
        os.remove(part)
        raise RuntimeError("size %d, extract.json says %d" % (n, size))
    if sha and got != sha.lower():
        os.remove(part)
        raise RuntimeError("sha256 %s, extract.json says %s" % (got[:12], sha[:12]))
    os.replace(part, out)


def good(path, f):
    try:
        if os.path.getsize(path) != f.get("size"):
            return False
    except OSError:
        return False
    return not f.get("sha256") or sha256_of(path) == f["sha256"].lower()


def complete(m, work):
    """Every wanted file present at its recorded size (cheap; no hashing)."""
    bsp = m["map"]
    for f in m.get("files") or []:
        rel = rel_of(bsp, f)
        if rel is None or os.path.splitext(rel)[1].lower() in REFUSED_EXT:
            continue
        try:
            if os.path.getsize(os.path.join(work, "mods", bsp, *rel.split("/"))) != f.get("size"):
                return False
        except OSError:
            return False
    return True


def pull_map(m, work, tries=3):
    """-> {"bsp", "ok", "files", "fetched", "skipped", "errors"}."""
    bsp = m["map"]
    final = os.path.join(work, "mods", bsp)
    repair = os.path.isdir(final)
    root = final if repair else os.path.join(work, "mods", ".%s.cloud-staging" % bsp)
    res = {"bsp": bsp, "ok": False, "files": 0, "fetched": 0, "skipped": [], "errors": []}
    for f in m.get("files") or []:
        rel = rel_of(bsp, f)
        if rel is None:
            res["errors"].append("unsafe path %r" % f.get("path"))
            continue
        if os.path.splitext(rel)[1].lower() in REFUSED_EXT:
            res["skipped"].append(rel)
            continue
        res["files"] += 1
        out = os.path.join(root, *rel.split("/"))
        if good(out, f):
            continue
        url = key_url("mods/%s/%s" % (bsp, rel))
        err = None
        for i in range(tries):
            try:
                download(url, out, f.get("size"), f.get("sha256"))
                err = None
                break
            except Exception as exc:   # noqa: BLE001 - network, disk: retry, then report
                err = "%s: %s" % (rel, exc)
                if i + 1 < tries:
                    time.sleep(RETRY_SLEEP * (i + 1))
        if err:
            res["errors"].append(err)
        else:
            res["fetched"] += 1
    if not res["errors"]:
        if not repair:
            if os.path.isdir(root):
                os.replace(root, final)
            else:
                os.makedirs(final, exist_ok=True)
        res["ok"] = True
    return res


def pull_meta(entry, work):
    """originals/<norm>/<file>.meta.json from the bucket. -> path or raises."""
    d = os.path.join(work, "originals", safe_norm(entry["norm"]))
    name = entry["original"] + ".meta.json"
    out = os.path.join(d, name)
    if os.path.exists(out):
        return out
    meta = get_json(key_url("archive/originals/%s/%s" % (safe_norm(entry["norm"]), name)))
    write_json(out, meta)
    return out


# ------------------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--from-file", help="the cloud extract.json on disk instead of the bucket's")
    ap.add_argument("--status-file", help="the cloud cloud_pipeline.json on disk")
    ap.add_argument("--no-status", action="store_true",
                    help="do not filter by cloud_pipeline.json (trust extract.json's mods)")
    ap.add_argument("--list", default=LIST, help="append newly merged bsps here")
    ap.add_argument("--no-meta", action="store_true", help="skip the originals' .meta.json sidecars")
    ap.add_argument("--pull-mods", action="store_true",
                    help="download mods/<bsp>/ for the maps in --list (or --map) from the bucket")
    ap.add_argument("--map", action="append", default=[], help="with --pull-mods: only these bsps")
    ap.add_argument("--verify", action="store_true",
                    help="with --pull-mods: re-hash maps an earlier pull already verified")
    ap.add_argument("--min-free-gb", type=float, default=20.0,
                    help="--pull-mods refuses a map that would leave less than this free")
    ap.add_argument("--dry", action="store_true", help="say what would change, change nothing")
    a = ap.parse_args(argv)
    work = a.work
    reports = os.path.join(work, "reports")

    # 1. the cloud state
    if a.from_file:
        cloud = load_json(a.from_file, None)
        if cloud is None:
            raise SystemExit("cannot read %s" % a.from_file)
    else:
        cloud = get_json(key_url("archive/state/extract.json"))
    if isinstance(cloud, dict):
        cloud = [cloud]
    status = None
    if not a.no_status:
        if a.status_file:
            status = load_json(a.status_file, None)
        elif not a.from_file:
            try:
                status = get_json(key_url("archive/state/cloud_pipeline.json"))
            except Exception as exc:   # noqa: BLE001
                log("warning: no cloud_pipeline.json (%s); trusting extract.json's mods" % exc)
        if status is not None and not isinstance(status, dict):
            status = None

    # 2. merge
    path = os.path.join(reports, "extract.json")
    local = load_json(path, [])
    if isinstance(local, dict):
        local = [local]
    merged, norms, new_bsps, conflicts, notes = merge(local, cloud, status, work)
    new_norms = [e for e in merged if e["norm"] in set(norms)]
    log("cloud entries %d, local %d, newly merged norms %d, new bsps %d, conflicts %d"
        % (len(cloud), len(local), len(new_norms), len(new_bsps), len(conflicts)))
    for n in notes:
        log("  note:", n)
    for c in conflicts:
        log("  CONFLICT: %(bsp)s is %(local_norm)s's here; cloud has it from %(cloud_norm)s" % c)
    if a.dry:
        for b in new_bsps:
            log("  would merge", b)
    else:
        if new_norms:
            if os.path.exists(path):
                shutil.copy2(path, path + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
            write_json(path, merged)
            log("wrote %s (%d maps)" % (path, len(merged)))
        if conflicts:
            cp = os.path.join(reports, "cloud-merge-conflicts.json")
            old = load_json(cp, [])
            seen = {(c["bsp"], c["cloud_norm"]) for c in old}
            old += [c for c in conflicts if (c["bsp"], c["cloud_norm"]) not in seen]
            write_json(cp, old)
            log("wrote %s (%d conflicts)" % (cp, len(old)))
        if new_bsps:
            have = read_list(a.list)
            add = [b for b in new_bsps if b not in have]
            if add:
                with open(a.list, "a", encoding="utf-8") as fh:
                    fh.write("# merged %s by merge_cloud.py\n" % time.strftime("%Y-%m-%d %H:%M"))
                    fh.write("".join(b + "\n" for b in add))
                log("appended %d bsps to %s" % (len(add), a.list))

    # 3. sidecars
    if not a.no_meta:
        for e in new_norms:
            if not e.get("original"):
                continue
            if a.dry:
                log("  would fetch originals/%s/%s.meta.json" % (safe_norm(e["norm"]), e["original"]))
                continue
            try:
                pull_meta(e, work)
            except Exception as exc:   # noqa: BLE001
                log("  warning: %s meta sidecar: %s" % (e["norm"], exc))

    # 4. mods
    rc = 0
    if a.pull_mods:
        want = a.map or list(dict.fromkeys(read_list(a.list) + new_bsps))
        pulled_path = os.path.join(reports, "cloud-pull.json")
        pulled = load_json(pulled_path, {})
        mods = {}
        for e in merged:
            if not e.get("cloud"):   # only what this script merged; B's own maps are not ours
                continue
            for m in e.get("mods") or []:
                mods.setdefault(m["map"], (e, m))
        for bsp in want:
            if bsp not in mods:
                log("  %s: no cloud-merged extract.json entry; skipped" % bsp)
                continue
            e, m = mods[bsp]
            if not a.verify and pulled.get(bsp, {}).get("ok") and complete(m, work):
                continue
            need = sum(int(f.get("size") or 0) for f in m.get("files") or [])
            if a.dry:
                log("  would pull %s (%d files, %.1f MB)" % (bsp, len(m.get("files") or []), need / 1e6))
                continue
            os.makedirs(os.path.join(work, "mods"), exist_ok=True)
            free = shutil.disk_usage(os.path.join(work, "mods")).free
            if free - need < a.min_free_gb * 1e9:
                log("  %s: REFUSED, %.1f GB free and it needs %.1f GB (--min-free-gb %.0f)"
                    % (bsp, free / 1e9, need / 1e9, a.min_free_gb))
                rc = 1
                continue
            r = pull_map(m, work)
            log("  %-28s %s files=%d fetched=%d%s%s" % (
                bsp, "ok" if r["ok"] else "FAIL", r["files"], r["fetched"],
                (" skipped-exe=%d" % len(r["skipped"])) if r["skipped"] else "",
                (" " + "; ".join(r["errors"][:3])) if r["errors"] else ""))
            if not r["ok"]:
                rc = 1
            pulled[bsp] = {"ok": r["ok"], "files": r["files"], "fetched": r["fetched"],
                           "errors": r["errors"][:20], "skipped": r["skipped"],
                           "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            write_json(pulled_path, pulled, indent=1)
    return rc


if __name__ == "__main__":
    sys.exit(main())
