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
  python install_map.py --stage --map nazi_zombie_test1        # honour install.exclude

`install.exclude` (2026-09-23)
------------------------------
Some releases drop third-party ADD-ON iwds into the mod folder beside the map's own
files -- a hitmarker script, a perk pack, empty placeholder iwds. A manifest may list
them:

    "install": {"exclude": [{"file": "zombie_hitmarker_bythesuzho.iwd",
                             "reason": "third-party hitmarker add-on; ..."}]}

`--stage` then builds `archive\\mods-staged\\<bsp>\\` containing a HARD LINK to every
other file. Hard links cost no bytes and the archive's own `mods\\<bsp>\\` is never
written, so the originals stay byte-for-byte what the release shipped -- the exclusion
is a *view*, not an edit. `tools\\dev\\mapmount.ps1` mounts the staged folder when one
exists. Delete `mods-staged\\<bsp>` to go back to the release as shipped.

`install.add` is the same idea pointed the other way, for a release that OMITS a file
every other release in the set ships:

    "install": {"add": [{"file": "nazi_zombie_leviathan_patch.ff",
                         "from": "nazi_zombie_test1/nazi_zombie_test1_patch.ff",
                         "reason": "..."}]}

`from` is relative to `archive\\mods\\`, and the file is hard-linked in under the name
in `file`. Nothing is downloaded and nothing is generated: it is a file this archive
already holds, put where the engine looks for it.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MODS = os.path.join(WORK, "mods")
STAGED = os.path.join(WORK, "mods-staged")
MANIFESTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifests")

# The engine writes its console.log into fs_homepath\<fs_game>\, which the junction
# makes the archive folder (dedi.md 14.4). Never carry it into a staged install.
NEVER_STAGE = {"console.log"}


def manifest_path(bsp):
    return os.path.join(MANIFESTS, bsp + ".json")


def excludes(bsp):
    """[(filename, reason)] from the manifest's install.exclude, lowercased names."""
    mf = manifest_path(bsp)
    if not os.path.exists(mf):
        return []
    man = json.load(open(mf, encoding="utf-8"))
    out = []
    for e in ((man.get("install") or {}).get("exclude") or []):
        if isinstance(e, str):
            out.append((e.lower(), ""))
            continue
        # `"applied": false` keeps an audited entry in the record without acting on it.
        # An add-on that was suspected and then MEASURED not to be the cause -- or, worse,
        # measured to be a hard dependency of the map's own scripts -- must stay written
        # down, or the next session re-runs the same experiment. It must not stay in the
        # install. Anything without the key is applied, so old manifests do not change
        # meaning.
        if e.get("applied") is False:
            continue
        out.append((str(e.get("file", "")).lower(), e.get("reason", "")))
    return [e for e in out if e[0]]


def stage(bsp):
    """Build mods-staged\\<bsp> as hard links to mods\\<bsp> minus install.exclude."""
    src = os.path.join(MODS, bsp)
    if not os.path.isdir(src):
        return "no install at " + src
    drop = dict(excludes(bsp))
    dst = os.path.join(STAGED, bsp)
    # Rebuild from scratch every time: a stale staged folder is worse than none, and
    # every entry in it is a hard link, so removing it frees nothing and loses nothing.
    if os.path.isdir(dst):
        for root, _d, fs in os.walk(dst, topdown=False):
            for f in fs:
                os.remove(os.path.join(root, f))
            if root != dst:
                os.rmdir(root)
    os.makedirs(dst, exist_ok=True)
    linked, skipped = 0, []
    for name in sorted(os.listdir(src)):
        p = os.path.join(src, name)
        if not os.path.isfile(p):
            continue
        low = name.lower()
        if low in NEVER_STAGE:
            continue
        if low in drop:
            skipped.append(name)
            continue
        try:
            os.link(p, os.path.join(dst, name))
        except OSError:                      # different volume, or no hard-link support
            import shutil
            shutil.copy2(p, os.path.join(dst, name))
        linked += 1
    # install.add: a file the release omits, taken from another install in this archive.
    added = []
    mf = manifest_path(bsp)
    man = json.load(open(mf, encoding="utf-8")) if os.path.exists(mf) else {}
    for a in ((man.get("install") or {}).get("add") or []):
        want, frm = a.get("file"), a.get("from")
        if not want or not frm:
            continue
        srcf = os.path.join(MODS, frm.replace("/", os.sep))
        if not os.path.isfile(srcf):
            added.append(want + " (SOURCE MISSING: " + frm + ")")
            continue
        target = os.path.join(dst, want)
        if os.path.exists(target):
            os.remove(target)
        try:
            os.link(srcf, target)
        except OSError:
            import shutil
            shutil.copy2(srcf, target)
        added.append("%s <- %s" % (want, frm))
        linked += 1

    missing = sorted(set(drop) - {s.lower() for s in skipped})
    note = ""
    if missing:
        note = "  (manifest excludes files that are not installed: %s)" % ", ".join(missing)
    if added:
        note += "  added: " + "; ".join(added)
    return "staged %d file(s), excluded %d: %s%s" % (
        linked, len(skipped), ", ".join(skipped) or "-", note)


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
    ap.add_argument("--stage", action="store_true",
                    help="build mods-staged/<bsp> honouring the manifest's install.exclude")
    ap.add_argument("--unstage", action="store_true",
                    help="delete mods-staged/<bsp> so the release is mounted as shipped")
    a = ap.parse_args()

    rows = installs()

    if a.stage or a.unstage:
        want = set(a.map)
        for r in rows:
            if not a.all and r["bsp"] not in want:
                continue
            if a.unstage:
                d = os.path.join(STAGED, r["bsp"])
                if os.path.isdir(d):
                    for root, _dd, fs in os.walk(d, topdown=False):
                        for f in fs:
                            os.remove(os.path.join(root, f))
                        os.rmdir(root)
                    print("%-26s unstaged" % r["bsp"])
                else:
                    print("%-26s not staged" % r["bsp"])
            else:
                print("%-26s %s" % (r["bsp"], stage(r["bsp"])))
        return

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
