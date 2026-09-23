#!/usr/bin/env python3
"""Supply the raw weapon file a mod map's own zone already defines (lane MAPS, 2026-09-23).

THE MECHANISM (decrypted CoDWaW 1.7, tools/re/t4map.py; archive.md s14.1)

    PrecacheItem 0x522D10 -> BG_GetWeaponIndexForName 0x41D4C0
      fs_game set ([0x2122B00], registered at 0x5DDF41)   -> RAW loader 0x422DE0
          FS read "weapons/%s/%s" (0x424130); missing -> "WARNING: Could not load weapon
          file 'weapons/sp/X'" and the def of `defaultweapon` is used instead
      fs_game empty + useFastFile                           -> DB_FindXAssetHeader(weapon)
      then 0x41D538: if the DB says weapon X is a default asset (no loaded zone defines it)
          -> index 0 -> Scr_Error "unknown item 'X'" (non-fatal since script_error_retail)

So on EVERY custom map (fs_game is always set) a weapon's definition comes from its raw file,
and the zone copy is only the existence check. A release whose author compiled weapon X into
the zone but never shipped `weapons/sp/X` loose or in an IWD gives players `defaultweapon`
under X's name -- on retail exactly as on our box. Cheese Cube's wall MP40 is one.

THE FIX (data only; nothing of the release is modified): dump X's definition out of the
map's OWN zone with OpenAssetTools' Unlinker and add it as a loose `mods/<bsp>/weapons/sp/X`
file. The raw loader then finds it, the zone check still passes, and the weapon is the one
the author compiled. Both the box and every client get the same file (extract.json lists it,
so the site serves it, the bucket holds it and the host's map cache pulls it).

A weapon NO shipped zone defines (Leviathan's napalmblob, Cheese Cube Unlimited's mk6_laser)
is not fixable this way -- its models/anims are not there either -- and is left alone.

    python archive/weapon_patch.py --map nazi_zombie_ccube [--map ...] [--dry]

Reads the misses from every console log we hold for the map (box proofs, dedi runs). Writes:
  ZombiesDev/archive/mods/<bsp>/weapons/sp/<X>          the dumped definition
  ZombiesDev/archive/reports/extract.json               a file entry, "added": "zone-dump ..."
  archive/manifests/<bsp>.json  install.add[]           file, from, reason, applied: true
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
DEV = os.path.dirname(WORK)
UNLINKER = os.path.join(DEV, "tools", "oat", "Unlinker.exe")
MANIFESTS = os.path.join(HERE, "manifests")
EXTRACT = os.path.join(WORK, "reports", "extract.json")
RX_MISS = re.compile(r"Could not load weapon file 'weapons/sp/([^']+)'")


def logs_for(bsp):
    pats = [os.path.join(WORK, "logs", "box-console", "**", "%s.*console.log" % bsp),
            os.path.join(WORK, "logs", "box-console", "**", "%s.console.log" % bsp),
            os.path.join(WORK, "logs", "box-console", "*", "waw-en", "mods", bsp, "console.log"),
            os.path.join(DEV, "logs", "dedi", "*.%s.console.log" % bsp),
            os.path.join(WORK, "mods", bsp, "console.log")]
    out = []
    for p in pats:
        out += glob.glob(p, recursive=True)
    return sorted(set(out))


def misses(bsp):
    names = set()
    for f in logs_for(bsp):
        with open(f, "rb") as fh:
            for m in RX_MISS.finditer(fh.read().decode("latin-1")):
                names.add(m.group(1))
    return sorted(names)


def zone_weapons(zone):
    r = subprocess.run([UNLINKER, "--list", zone], capture_output=True, text=True, errors="replace", timeout=600)
    return {ln.split(",", 1)[1].strip() for ln in r.stdout.splitlines() if ln.startswith("weapon,")}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def patch(bsp, dry=False):
    dest = os.path.join(WORK, "mods", bsp)
    want = misses(bsp)
    res = {"map": bsp, "misses": want, "added": [], "not_in_any_zone": []}
    if not want:
        return res
    zones = sorted(glob.glob(os.path.join(dest, "*.ff")))
    where = {}
    for z in zones:
        for w in zone_weapons(z):
            where.setdefault(w, z)
    todo = [w for w in want if w in where and not os.path.exists(os.path.join(dest, "weapons", "sp", w))]
    res["not_in_any_zone"] = [w for w in want if w not in where]
    if dry or not todo:
        res["would_add"] = todo
        return res
    tmp = tempfile.mkdtemp(prefix="wpatch-")
    try:
        for z in sorted({where[w] for w in todo}):
            subprocess.run([UNLINKER, "--include-assets", "weapon", "-o", os.path.join(tmp, "?zone?"), z],
                           capture_output=True, text=True, timeout=900)
        for w in todo:
            zname = os.path.splitext(os.path.basename(where[w]))[0]
            src = os.path.join(tmp, zname, "weapons", w)
            if not os.path.exists(src):
                res["not_in_any_zone"].append(w + " (dump failed)")
                continue
            with open(src, "rb") as fh:
                if not fh.read(10).startswith(b"WEAPONFILE"):
                    res["not_in_any_zone"].append(w + " (dump not a WEAPONFILE)")
                    continue
            out = os.path.join(dest, "weapons", "sp", w)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copyfile(src, out)
            res["added"].append({"file": "weapons/sp/" + w, "from": os.path.basename(where[w]),
                                 "size": os.path.getsize(out), "sha256": sha256(out)})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if res["added"]:
        record(bsp, res["added"])
    return res


def record(bsp, added):
    ex = json.load(open(EXTRACT, encoding="utf-8"))
    for e in ex:
        for m in e.get("mods") or []:
            if m["map"] != bsp:
                continue
            have = {f["path"] for f in m["files"]}
            for a in added:
                p = "mods/%s/%s" % (bsp, a["file"])
                if p in have:
                    continue
                m["files"].append({"path": p, "size": a["size"], "sha256": a["sha256"],
                                   "added": "zone-dump of weapon %s from the release's own %s "
                                            "(archive/weapon_patch.py; not in the installer)"
                                            % (a["file"].split("/")[-1], a["from"])})
                m["bytes"] = m.get("bytes", 0) + a["size"]
    tmp = EXTRACT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(ex, fh, indent=1)
    os.replace(tmp, EXTRACT)
    mf = os.path.join(MANIFESTS, bsp + ".json")
    if os.path.exists(mf):
        m = json.load(open(mf, encoding="utf-8"))
        inst = m.setdefault("install", {})
        lst = inst.setdefault("add", [])
        have = {x.get("file") for x in lst}
        for a in added:
            if a["file"] in have:
                continue
            lst.append({"file": a["file"], "from": "%s weapon asset (OpenAssetTools Unlinker dump)" % a["from"],
                        "reason": "The release compiles this weapon into its zone but ships no raw "
                                  "weapons/sp file; with fs_game set the engine reads the raw file and "
                                  "otherwise gives defaultweapon under this name (retail too). "
                                  "archive.md s14.1.",
                        "sha256": a["sha256"], "applied": True, "by": "archive/weapon_patch.py 2026-09-23"})
        with open(mf, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[], required=True)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    for b in a.map:
        print(json.dumps(patch(b, a.dry)))


if __name__ == "__main__":
    main()
