#!/usr/bin/env python3
"""Extract an original into a playable `mods/<map>/` tree -- without ever running it.

The rule (vault 04 section 3, dev-box.md rule 3) is absolute: a map installer is DATA.
7-Zip opens NSIS/MSI/CAB/zip/rar/7z archives directly; innoextract handles Inno Setup
without running its install script. Nothing in this file calls an extracted binary, and
every executable found inside is listed in the report so a human can see what shipped.

What it produces per map, under ZombiesDev\\archive:

  extract\\<norm>\\        the raw extraction, exactly as 7-Zip laid it out
  mods\\<mapname>\\        the normalised install: mod.ff + <map>.iwd + friends
  reports\\extract.json   per map: installer kind, file list with sha256, the
                          wrapper-folder depth that had to be stripped, every .exe
                          found, and what could not be handled

Known gotchas handled here, all of them from vault 04 section 3:
  * an extra wrapper folder nesting the map one level too deep;
  * an installer that lays out `%LOCALAPPDATA%\\Activision\\CoDWaW\\mods\\<map>` as a
    literal path inside the archive;
  * NSIS's `$PLUGINSDIR` / `$_OUTDIR` junk directories;
  * a map that ships a second mod's folder alongside it (nazi_zombie_ali ships ZCT's) --
    both are kept, because the engine loads both and the referee needs both.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
ORIGINALS = os.path.join(WORK, "originals")
EXTRACT = os.path.join(WORK, "extract")
MODS = os.path.join(WORK, "mods")
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe"

JUNK_DIRS = re.compile(r"^\$PLUGINSDIR$|^\$_OUTDIR$|^\$TEMP$|^\$INSTDIR$", re.I)
# NSIS puts the uninstaller and its own runtime in the archive root; they are not map data.
JUNK_FILES = re.compile(r"^(uninst|uninstall|\[?0\]?|\$PLUGINSDIR.*)\.(exe|dat|nsi)$", re.I)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint(path):
    """What kind of container is this? Read bytes; do not run anything."""
    with open(path, "rb") as fh:
        head = fh.read(1 << 16)
    ext = os.path.splitext(path)[1].lower()
    if head[:2] == b"MZ":
        if b"Inno Setup" in head or b"JR.Inno.Setup" in head:
            return "inno"
        if b"Nullsoft" in head or b"NSIS" in head:
            return "nsis"
        # Many WaW installers are self-extracting archives whose signature only shows
        # up further in; 7-Zip decides, and its failure is the answer.
        return "exe-unknown"
    if head[:4] == b"PK\x03\x04":
        return "zip"
    if head[:4] == b"Rar!":
        return "rar"
    if head[:6] == b"7z\xbc\xaf\x27\x1c":
        return "7z"
    if head[:8] in (b"IWffu100", b"IWff0100"):
        return "fastfile"
    return ext.lstrip(".") or "unknown"


def run7z(path, outdir):
    os.makedirs(outdir, exist_ok=True)
    r = subprocess.run([SEVENZIP, "x", "-y", "-bso0", "-bse1", "-o" + outdir, path],
                       capture_output=True, text=True, timeout=1800)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def run_innoextract(path, outdir):
    exe = shutil.which("innoextract")
    if not exe:
        return None, "innoextract not installed"
    os.makedirs(outdir, exist_ok=True)
    r = subprocess.run([exe, "-e", "-d", outdir, path],
                       capture_output=True, text=True, timeout=1800)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def walk(root):
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            yield os.path.join(dirpath, f)


def find_mod_roots(root):
    """Every directory that looks like an installed `mods/<map>` folder.

    The marker is a fastfile: a mod folder holds `mod.ff` and/or `<map>.ff`, usually
    with a same-named `.iwd`. Searching for the FILES rather than for a folder called
    `mods` is what makes this survive the zoo of layouts these installers use.
    """
    roots = {}
    for path in walk(root):
        low = os.path.basename(path).lower()
        if low.endswith(".ff") or low.endswith(".iwd"):
            roots.setdefault(os.path.dirname(path), set()).add(low)
    # A folder that only holds .iwd files and sits beside a .ff folder is usually the
    # same mod; keep both and let the caller decide.
    return {d: sorted(v) for d, v in roots.items()
            if any(x.endswith(".ff") for x in v) or any(x.endswith(".iwd") for x in v)}


def guess_map_name(folder, files):
    base = os.path.basename(folder)
    if base.lower() not in ("mods", "", "."):
        cand = base
    else:
        cand = None
    for f in files:
        m = re.match(r"(nazi_zombie_[a-z0-9_]+)\.(ff|iwd)$", f, re.I)
        if m:
            return m.group(1).lower()
    for f in files:
        if f.lower() != "mod.ff" and f.lower().endswith((".ff", ".iwd")):
            return os.path.splitext(f)[0].lower()
    return (cand or "unknown").lower()


def normalise_into_mods(src, mapname, dry=False):
    dest = os.path.join(MODS, mapname)
    if not dry:
        os.makedirs(dest, exist_ok=True)
    copied = []
    for path in walk(src):
        rel = os.path.relpath(path, src)
        if JUNK_DIRS.match(rel.split(os.sep)[0]) or JUNK_FILES.match(os.path.basename(rel)):
            continue
        out = os.path.join(dest, rel)
        if not dry:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            shutil.copy2(path, out)
        copied.append({"path": "mods/%s/%s" % (mapname, rel.replace("\\", "/")),
                       "size": os.path.getsize(path),
                       "sha256": sha256_of(path)})
    return dest, copied


def process(norm, original, report):
    kind = fingerprint(original)
    out = {"norm": norm, "original": os.path.basename(original),
           "original_sha256": sha256_of(original),
           "original_size": os.path.getsize(original),
           "installer_kind": kind, "errors": [], "executables": [],
           "mods": [], "wrapper_depth": None}
    exdir = os.path.join(EXTRACT, norm)
    if os.path.exists(exdir):
        shutil.rmtree(exdir, ignore_errors=True)

    if kind == "fastfile":
        os.makedirs(exdir, exist_ok=True)
        shutil.copy2(original, os.path.join(exdir, os.path.basename(original)))
        rc, log = 0, "loose fastfile; copied as is"
    else:
        rc, log = run7z(original, exdir)
        if rc != 0 and kind in ("inno", "exe-unknown"):
            rc2, log2 = run_innoextract(original, exdir)
            if rc2 is None:
                out["errors"].append("7-Zip failed (rc=%d) and %s" % (rc, log2))
            elif rc2 != 0:
                out["errors"].append("7-Zip rc=%d and innoextract rc=%d" % (rc, rc2))
            else:
                rc, log = 0, log2
        elif rc != 0:
            out["errors"].append("7-Zip rc=%d: %s" % (rc, log.strip()[:400]))
    out["extract_log"] = log.strip()[-1500:]

    if not os.path.isdir(exdir):
        out["errors"].append("nothing extracted")
        report.append(out)
        return out

    out["executables"] = sorted(
        os.path.relpath(p, exdir).replace("\\", "/") for p in walk(exdir)
        if p.lower().endswith((".exe", ".dll", ".bat", ".cmd", ".ps1", ".scr", ".msi")))

    roots = find_mod_roots(exdir)
    if not roots:
        out["errors"].append("no .ff/.iwd found in the extraction")
        report.append(out)
        return out
    # Strip the wrapper: report how deep below the extraction root the map sat.
    for folder, files in sorted(roots.items()):
        depth = len(os.path.relpath(folder, exdir).split(os.sep)) if folder != exdir else 0
        mapname = guess_map_name(folder, files)
        dest, copied = normalise_into_mods(folder, mapname)
        out["mods"].append({"map": mapname, "from": os.path.relpath(folder, exdir)
                            .replace("\\", "/"), "depth": depth,
                            "dest": dest, "files": copied,
                            "bytes": sum(f["size"] for f in copied)})
        if out["wrapper_depth"] is None or depth < out["wrapper_depth"]:
            out["wrapper_depth"] = depth
    report.append(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--norm", action="append", default=[], help="only these (normalised) maps")
    a = ap.parse_args()
    os.makedirs(os.path.join(WORK, "reports"), exist_ok=True)
    report = []
    names = a.norm or sorted(os.listdir(ORIGINALS)) if os.path.isdir(ORIGINALS) else []
    for norm in names:
        d = os.path.join(ORIGINALS, norm)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".meta.json"):
                continue
            r = process(norm, os.path.join(d, f), report)
            print("%-22s %-12s mods=%s exes=%d %s"
                  % (norm, r["installer_kind"],
                     ",".join(m["map"] for m in r["mods"]) or "-",
                     len(r["executables"]), "; ".join(r["errors"])))
    path = os.path.join(WORK, "reports", "extract.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print("\nwrote", path)


if __name__ == "__main__":
    main()
