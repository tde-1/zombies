#!/usr/bin/env python3
"""Promote checked map exports from ZombiesDev\\maps-staging into the LIVE ZombiesDev\\maps.

    python tools/maps/promote.py nazi_zombie_asylum,bcast          # named maps
    python tools/maps/promote.py --passing                         # every staged map whose checks pass
    python tools/maps/promote.py --passing --dry-run

/mapdata serves ZombiesDev\\maps with no restart, so a promotion is live the moment the rename
lands (replay.md §7a, §10). An earlier batch wrote straight into maps\\ and overwrote live Nacht;
since then exports go to staging and only this script moves them, and only when:

  * the sidecar says `world_shell: true` (a props + sky export is never promoted over anything),
  * `align.ok` -- tools/maps/align_check.cjs on the float twin (spawns on the shell, window goals
    at walls, script_model anchors on their map_ents origins, nothing past +-65536 u), and
  * `align_served.ok` -- the same check on the SERVED meshopt bytes, when export_all recorded it.

Each file is copied beside its target under a temp name and os.replace()d into place (atomic
on NTFS), then compared byte for byte with staging. Whatever it replaces is first copied to
maps\\_work\\<bsp>.pre-geo-<stamp>\\ so any promotion can be undone by copying that back.
"""
import argparse
import filecmp
import json
import os
import shutil
import sys
import time
from pathlib import Path

DEV = Path(os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev"))
STAGING = DEV / "maps-staging"
LIVE = DEV / "maps"
BACKUP = LIVE / "_work"


def verdict(bsp: str):
    """(ok, reason, meta) for a staged export."""
    d = STAGING / bsp
    glb, mf = d / f"{bsp}.glb", d / f"{bsp}.meta.json"
    if not glb.is_file() or not mf.is_file():
        return False, "not staged", None
    meta = json.loads(mf.read_text("utf8"))
    if not meta.get("world_shell"):
        return False, "no world shell", meta
    al = meta.get("align") or {}
    if not al.get("ok"):
        return False, "align: " + "; ".join(al.get("problems") or ["not run"]), meta
    srv = meta.get("align_served")
    if srv is not None and not srv.get("ok"):
        return False, "align (served bytes): " + "; ".join(srv.get("problems") or ["failed"]), meta
    return True, "ok", meta


def promote(bsp: str, dry: bool, log=print):
    ok, why, meta = verdict(bsp)
    if not ok:
        log(f"{bsp}: NOT promoted -- {why}")
        return False
    src = STAGING / bsp
    dst = LIVE / bsp
    names = [f"{bsp}.glb", f"{bsp}.meta.json"]
    if dry:
        log(f"{bsp}: would promote ({(src / names[0]).stat().st_size / 1048576:.2f} MB)")
        return True
    if dst.is_dir() and any((dst / n).is_file() for n in names):
        if all((dst / n).is_file() and filecmp.cmp(dst / n, src / n, shallow=False) for n in names):
            log(f"{bsp}: already live (identical)")
            return True
        bk = BACKUP / f"{bsp}.pre-geo-{time.strftime('%Y%m%d-%H%M%S')}"
        bk.mkdir(parents=True, exist_ok=True)
        for n in names:
            if (dst / n).is_file():
                shutil.copy2(dst / n, bk / n)
        log(f"{bsp}: backup of the live export -> {bk}")
    dst.mkdir(parents=True, exist_ok=True)
    for n in names:
        tmp = dst / (n + ".tmp-geo")
        shutil.copy2(src / n, tmp)
        os.replace(tmp, dst / n)
    bad = [n for n in names if not filecmp.cmp(dst / n, src / n, shallow=False)]
    if bad:
        log(f"{bsp}: PROMOTED BUT DIFFERS from staging: {bad}")
        return False
    log(f"{bsp}: promoted ({(dst / names[0]).stat().st_size / 1048576:.2f} MB, built {meta.get('built_at')})")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("maps", nargs="?", default="", help="comma-separated bsp names")
    ap.add_argument("--passing", action="store_true", help="every staged map whose checks pass")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    names = [m.strip() for m in a.maps.split(",") if m.strip()]
    if a.passing:
        names += sorted(p.name for p in STAGING.iterdir() if p.is_dir() and not p.name.startswith("_"))
    names = list(dict.fromkeys(names))
    if not names:
        ap.print_help()
        return 2
    done = sum(promote(m, a.dry_run) for m in names)
    print(f"{done}/{len(names)} {'would be ' if a.dry_run else ''}promoted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
