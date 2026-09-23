#!/usr/bin/env python3
"""Install an archived map on the Hetzner game box (`zombies-dev`) WITHOUT pushing the
bytes up B's home connection.

The box fetches the release itself from the same MediaFire page the archive used, and
refuses it unless its sha256 is the sha256 of the original we fetched, AV-scanned and
extracted here. Same bytes, so the same scan. It then extracts with 7-Zip (data only,
nothing is run -- dev-box rule 6) and copies out exactly the files `extract.json`
lists for `mods/<bsp>/`, matched by sha256, into `/home/waw/waw-en/mods/<bsp>/`.
That one directory is what all three symlinks on the box point at
(`waw-inst-*/mods`, `homes/inst-*/mods`, `AppData/Local/Activision/CoDWaW/mods`,
launcher.md "three symlinks, not one"). The download and the extraction are deleted
afterwards; the box keeps only the install.

    python archive/box_stage.py --map nuketown_remastered
    python archive/box_stage.py --map nuketown_remastered --remove
    python archive/box_stage.py --map x --rsync      # fallback: push from here, 4 MB/s cap

Heavy steps run under `nice -n 19 ionice -c3`: B plays on this box.
"""
import argparse
import base64
import json
import os
import subprocess

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
HOST = "zombies-dev"
BOX_MODS = "/home/waw/waw-en/mods"
SKIP_EXT = (".exe", ".dll", ".bat", ".cmd", ".ps1", ".scr", ".msi")

REMOTE = r'''
import base64, hashlib, json, os, re, shutil, subprocess, sys, urllib.request
spec = json.loads(base64.b64decode(sys.argv[1]))
bsp, MODS = spec["bsp"], spec["mods"]
tmp = "/home/waw/zdl/" + bsp
out = {"bsp": bsp}
UA = ("ENWZombiesArchive/0.1 (+https://enw.gg; World at War custom-zombies map preservation; "
      "one request at a time)")
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()
def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120)
try:
    final = os.path.join(MODS, bsp)
    if os.path.isdir(final) and all(os.path.exists(os.path.join(final, f["rel"])) and
                                    os.path.getsize(os.path.join(final, f["rel"])) == f["size"]
                                    for f in spec["files"]):
        out.update(status="ok", note="already installed")
        raise SystemExit
    os.makedirs(tmp, exist_ok=True)
    orig = os.path.join(tmp, "original.bin")
    url = spec["url"]
    if "mediafire.com" in url and not re.match(r"https?://download\d+\.", url):
        page = get(url).read().decode("utf-8", "replace")
        m = re.search(r'href="(https?://download\d*\.mediafire\.com/[^"]+)"', page)
        if not m:
            raise RuntimeError("no download button on the MediaFire page")
        url = m.group(1)
    r = get(url)
    if "text/html" in (r.headers.get("Content-Type") or ""):
        raise RuntimeError("got HTML, not the file (%s)" % r.geturl().split("?")[0])
    with open(orig, "wb") as fh:
        shutil.copyfileobj(r, fh, 1 << 20)
    got = sha(orig)
    if got != spec["sha256"]:
        raise RuntimeError("sha256 mismatch: box got %s, archive has %s" % (got[:12], spec["sha256"][:12]))
    ex = os.path.join(tmp, "x")
    subprocess.run(["nice", "-n", "19", "ionice", "-c3", "7z", "x", "-y", "-bso0", "-bsp0", "-o" + ex, orig],
                   check=False, capture_output=True)
    need = {f["sha256"]: f for f in spec["files"]}
    found = {}
    def index(root):
        for d, _, fs in os.walk(root):
            for f in fs:
                p = os.path.join(d, f)
                sz = os.path.getsize(p)
                for n in spec["files"]:
                    if n["size"] == sz and n["sha256"] not in found and sha(p) == n["sha256"]:
                        found[n["sha256"]] = p
                        break
    index(ex)
    if len(found) < len(need):
        inner = sorted((os.path.join(d, f) for d, _, fs in os.walk(ex) for f in fs
                        if f.lower().endswith((".exe", ".rar", ".zip", ".7z"))),
                       key=os.path.getsize, reverse=True)
        for p in inner[:1]:
            subprocess.run(["nice", "-n", "19", "7z", "x", "-y", "-bso0", "-bsp0",
                            "-o" + os.path.join(ex, "_inner"), p], check=False, capture_output=True)
            index(os.path.join(ex, "_inner"))
    missing = [need[h]["rel"] for h in need if h not in found]
    if missing:
        raise RuntimeError("not in the box's extraction: %s" % ", ".join(missing[:5]))
    stage = final + ".staging"
    shutil.rmtree(stage, ignore_errors=True)
    for h, f in need.items():
        dst = os.path.join(stage, f["rel"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(found[h], dst)
    shutil.rmtree(final, ignore_errors=True)
    os.rename(stage, final)
    subprocess.run(["chown", "-R", "waw:waw", final])
    out.update(status="ok", files=len(need), bytes=sum(f["size"] for f in spec["files"]))
except SystemExit:
    pass
except Exception as e:
    out.update(status="fail", error=str(e))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
st = os.statvfs(MODS)
out["box_free_gb"] = round(st.f_bavail * st.f_frsize / 2**30, 1)
print(json.dumps(out))
'''


# --from-bucket (tranche 2, 2026-09-23). B: "the bucket is the source of truth for map files".
# The box pulls exactly the files /api/maps/<bsp>/files serves, from the public bucket copy
# (mods/<bsp>/<path>, anonymous GET, nbg1 -> the box at ~47 MB/s), checks each size + sha256,
# and renames the staging dir into place, so a half-pulled map is never visible. It refuses
# to start unless the box keeps --min-free-mb free AFTER the pull: the box disk was at 99%
# (411 MB free) when this was written, and a full disk under a live game is worse than a
# skipped test. No original, no 7-Zip, nothing to clean up but the staging dir.
REMOTE_BUCKET = r'''
import base64, hashlib, json, os, shutil, subprocess, sys, urllib.request, urllib.parse
spec = json.loads(base64.b64decode(sys.argv[1]))
bsp, MODS = spec["bsp"], spec["mods"]
final = os.path.join(MODS, bsp)
stage = final + ".staging"
out = {"bsp": bsp, "via": "bucket"}
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()
def free_mb():
    st = os.statvfs(MODS)
    return st.f_bavail * st.f_frsize / 2**20
try:
    if os.path.isdir(final) and all(os.path.exists(os.path.join(final, f["rel"])) and
                                    os.path.getsize(os.path.join(final, f["rel"])) == f["size"]
                                    for f in spec["files"]):
        out.update(status="ok", note="already installed")
        raise SystemExit
    need_mb = sum(f["size"] for f in spec["files"]) / 2**20
    if free_mb() - need_mb < spec["min_free_mb"]:
        raise RuntimeError("box disk: %.0f MB free, map needs %.0f MB, keeping %d MB free"
                           % (free_mb(), need_mb, spec["min_free_mb"]))
    shutil.rmtree(stage, ignore_errors=True)
    got = 0
    for f in spec["files"]:
        dst = os.path.join(stage, f["rel"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        url = spec["base"] + "/" + urllib.parse.quote(spec["key_bsp"] + "/" + f["rel"])
        r = urllib.request.urlopen(url, timeout=120)
        with open(dst, "wb") as fh:
            shutil.copyfileobj(r, fh, 1 << 20)
        if os.path.getsize(dst) != f["size"] or sha(dst) != f["sha256"]:
            raise RuntimeError("bucket copy of %s does not match the archive (size/sha256)" % f["rel"])
        got += f["size"]
    shutil.rmtree(final, ignore_errors=True)
    os.rename(stage, final)
    subprocess.run(["chown", "-R", "waw:waw", final])
    out.update(status="ok", files=len(spec["files"]), bytes=got)
except SystemExit:
    pass
except Exception as e:
    out.update(status="fail", error=str(e)[:300])
finally:
    shutil.rmtree(stage, ignore_errors=True)
out["box_free_mb"] = round(free_mb())
print(json.dumps(out))
'''
BUCKET_BASE = "https://enw-zombies.nbg1.your-objectstorage.com/mods"


def spec_for(bsp):
    ex = json.load(open(os.path.join(WORK, "reports", "extract.json"), encoding="utf-8"))
    for e in ex:
        for m in e.get("mods", []):
            if m["map"] != bsp:
                continue
            d = os.path.join(WORK, "originals", e["norm"])
            metas = [f for f in os.listdir(d) if f.endswith(".meta.json")]
            meta = json.load(open(os.path.join(d, metas[0]), encoding="utf-8"))
            files = []
            for f in m["files"]:
                rel = f["path"].split("/", 2)[2]
                if rel.lower().endswith(SKIP_EXT) or os.path.basename(rel).lower() == "console.log":
                    continue
                files.append({"rel": rel, "sha256": f["sha256"], "size": f["size"]})
            return {"bsp": bsp, "mods": BOX_MODS, "url": meta["download_url"],
                    "sha256": meta["sha256"], "size": meta["size"], "files": files,
                    "local_dir": m["dest"], "key_bsp": m.get("bsp") or bsp}
    raise SystemExit("no extract.json entry for %s" % bsp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True)
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--rsync", action="store_true")
    ap.add_argument("--from-bucket", action="store_true",
                    help="the box pulls mods/<bsp>/ from the public bucket (sync.js first)")
    ap.add_argument("--min-free-mb", type=int, default=400,
                    help="--from-bucket refuses a pull that would leave less than this free")
    a = ap.parse_args()
    bsp = a.map
    if not bsp or "/" in bsp or bsp in (".", "..") or " " in bsp:
        raise SystemExit("bad map name")
    if a.remove:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST,
                            "rm -rf %s/%s && echo removed %s" % (BOX_MODS, bsp, bsp)],
                           capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
        return
    spec = spec_for(bsp)
    if a.rsync:
        src = spec["local_dir"].replace("\\", "/")
        if len(src) > 1 and src[1] == ":":
            src = "/" + src[0].lower() + src[2:]
        r = subprocess.run(["rsync", "-a", "--bwlimit=4000", "--exclude=console.log", "--exclude=*.exe",
                            "--exclude=*.dll", src + "/", "%s:%s/%s/" % (HOST, BOX_MODS, bsp)],
                           capture_output=True, text=True)
        subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, "chown -R waw:waw %s/%s" % (BOX_MODS, bsp)])
        res = {"bsp": bsp, "status": "ok" if r.returncode == 0 else "fail", "error": r.stderr[-300:],
               "via": "rsync"}
        record(bsp, res)
        print(json.dumps(res))
        return
    spec.pop("local_dir")
    remote = REMOTE
    if a.from_bucket:
        # Only what the site serves (mapfiles.js ALLOWED) is in the bucket; the rest of the
        # extract (readmes, installer junk) is not map data and the box does not need it.
        allowed = {".ff", ".iwd", ".arena", ".csv", ".txt", ".cfg", ".gsc", ".csc", ".iwi", ".bik",
                   ".menu", ".str", ".wav", ".mp3", ""}
        spec["files"] = [f for f in spec["files"] if os.path.splitext(f["rel"])[1].lower() in allowed]
        spec.update(base=BUCKET_BASE, min_free_mb=a.min_free_mb)
        remote = REMOTE_BUCKET
    arg = base64.b64encode(json.dumps(spec).encode()).decode()
    # The spec rides inside the script on stdin, not on argv: a map with many files makes a
    # base64 arg past ~8 KB and the Windows ssh command line cut it (futurama, arena: JSONDecodeError).
    script = remote.replace("base64.b64decode(sys.argv[1])", "base64.b64decode(%r)" % arg)
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, "python3 -"], input=script,
                       capture_output=True, text=True, timeout=1800)
    line = (r.stdout.strip().splitlines() or [""])[-1]
    line = line or json.dumps({"bsp": bsp, "status": "fail", "error": r.stderr[-400:]})
    record(bsp, json.loads(line))
    print(line)


def record(bsp, res):
    path = os.path.join(WORK, "reports", "boxstage.json")
    rep = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    rep[bsp] = res
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=1)


if __name__ == "__main__":
    main()
