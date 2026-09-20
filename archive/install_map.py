#!/usr/bin/env python3
"""Put a normalised map where an instance can load it, without copying gigabytes.

The archive's normalised installs live in `ZombiesDev\\archive\\mods\\<bsp>\\`. The game
wants them under an `fs_homepath`'s `mods\\` (per-instance homepaths are `dev-box.md`
"Game copies"), so this makes a **directory junction** per map: one filesystem entry,
no second copy of a 500 MB install, and deleting the junction leaves the archive intact.

It never writes to B's Steam folder and never writes to B's own
`%LOCALAPPDATA%\\Activision\\CoDWaW\\mods` unless you ask for that path explicitly.
It never runs anything.

  python install_map.py --list
  python install_map.py --homepath C:\\Users\\b\\ZombiesDev\\homes\\dedi --all
  python install_map.py --homepath ... --map nazi_zombie_leviathan --map water
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
MANIFESTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifests")


def installs():
    out = []
    for name in sorted(os.listdir(MODS)) if os.path.isdir(MODS) else []:
        d = os.path.join(MODS, name)
        if not os.path.isdir(d):
            continue
        mf = os.path.join(MANIFESTS, name + ".json")
        man = json.load(open(mf, encoding="utf-8")) if os.path.exists(mf) else {}
        size = sum(os.path.getsize(os.path.join(r, f))
                   for r, _d, fs in os.walk(d) for f in fs)
        out.append({"bsp": name, "path": d, "size": size,
                    "title": man.get("title") or name,
                    "finish": (man.get("badge") or {}).get("main_finish"),
                    "needs_human": man.get("needs_human")})
    return out


def junction(link, target):
    if os.path.exists(link):
        return "exists"
    r = subprocess.run(["cmd", "/c", "mklink", "/J", link, target],
                       capture_output=True, text=True)
    return "ok" if r.returncode == 0 else "FAILED: " + (r.stdout + r.stderr).strip()[:160]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--homepath", help=r"e.g. C:\Users\b\ZombiesDev\homes\dedi")
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()

    rows = installs()
    if a.list or not a.homepath:
        print("%-26s %10s  %-16s %s" % ("bsp (fs_game mods/<bsp>)", "size", "finish", "title"))
        for r in rows:
            print("%-26s %9.0f M  %-16s %s"
                  % (r["bsp"], r["size"] / 2**20, r["finish"] or "-", r["title"]))
        if not a.homepath:
            print("\nGive --homepath to install. Launch with:")
            print("  +set fs_homepath <homepath> +set fs_game mods/<bsp> +map <bsp>")
        return

    dest_root = os.path.join(a.homepath, "mods")
    os.makedirs(dest_root, exist_ok=True)
    want = set(a.map)
    for r in rows:
        if not a.all and r["bsp"] not in want:
            continue
        print("%-26s %s" % (r["bsp"], junction(os.path.join(dest_root, r["bsp"]), r["path"])))


if __name__ == "__main__":
    main()
