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

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
ORIGINALS = os.path.join(WORK, "originals")
EXTRACT = os.path.join(WORK, "extract")
MODS = os.path.join(WORK, "mods")
SEVENZIP = r"C:\Program Files\7-Zip\7z.exe" if os.name == "nt" else (shutil.which("7z") or "7z")

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


def run_unar(path, outdir):
    """RAR (incl. RAR5) where the 7-Zip build has no RAR codec (Debian's 7zip is dfsg)."""
    exe = shutil.which("unar")
    if not exe:
        return None, "unar not installed"
    r = subprocess.run([exe, "-q", "-f", "-D", "-o", outdir, path],
                       capture_output=True, text=True, errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def fix_names(root):
    """Rename entries whose names are not UTF-8 (old zips/rars store cp1252/cp437 bytes,
    e.g. `FluchtF\xfcrdieToten`): the bucket key and extract.json need real text."""
    if os.name == "nt":
        return 0
    n = 0
    for d, dirs, files in os.walk(root, topdown=False):
        for name in files + dirs:
            try:
                name.encode("utf-8")
                continue
            except UnicodeEncodeError:
                pass
            raw = os.fsencode(name)
            for enc in ("cp1252", "cp437", "latin-1"):
                try:
                    good = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            src, dst = os.path.join(d, name), os.path.join(d, good)
            if not os.path.exists(dst):
                os.rename(src, dst)
                n += 1
    return n


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


def guess_names(folder, files):
    """Return (mod_folder_name, bsp_name).

    They are NOT the same thing and conflating them breaks the launch command. The
    engine is told `fs_game mods/<mod_folder>` and then `map <bsp>`:

      mw2rust/            mod folder "mw2rust",                bsp "mw2rust"
      ugx_requiem_public_v1.1/  mod folder with that name,     bsp "ugx_artemovsk"

    The mod folder is simply the directory the installer laid down (the one holding
    `mod.ff`). The bsp is the fastfile that has a `<name>_load.ff` or `<name>_patch.ff`
    beside it -- that pairing is what the map build produces, and it is the only
    reliable marker when the folder is called something like `ugx_requiem_public_v1.1`
    or when a map ships another mod's `.iwd` alongside it.

    MEASURED: naming the folder after the first `.ff`/`.iwd` produced "buried" for
    MW2 Rust (it ships `buried.iwd`, a perks pack) and "fastcompile" for UGX Requiem.
    """
    mod_folder = os.path.basename(folder.rstrip("\\/")) or "unknown"
    ffs = {f.lower() for f in files if f.lower().endswith(".ff")}
    stems = {f[:-3] for f in ffs}
    # The installer's own `mod.arena` names the zombies map outright (`gametype "zom"`),
    # and it wins when it names a fastfile that is actually here. MEASURED 2026-09-22:
    # Futurama ships `futurama` and UGX Mod's `ugxm_customize_room`, both .ff + _patch,
    # and the score below picked the customize room.
    arena = os.path.join(folder, "mod.arena")
    if os.path.exists(arena):
        try:
            txt = open(arena, encoding="latin-1").read()
            for blk in re.findall(r"\{(.*?)\}", txt, re.S):
                mm = re.search(r'\bmap\s+"([^"]+)"', blk)
                gt = re.search(r'\bgametype\s+"([^"]*)"', blk)
                if mm and gt and "zom" in gt.group(1).lower() and mm.group(1).lower() in stems:
                    return mod_folder, mm.group(1).lower()
        except OSError:
            pass
    scored = []
    for s in stems:
        if s in ("mod",) or s.startswith(("localized_", "common", "code_post_gfx", "ui_")):
            continue
        if s.endswith(("_load", "_patch")):
            continue
        # A map BUILD produces <map>.ff + <map>_load.ff + <map>_patch.ff. An asset or
        # perks pack shipped alongside usually has only a _patch, or nothing.
        # MEASURED: Minecraft Village ships both `gumball` (.ff + _patch) and
        # `nazi_zombie_fear_mc_2` (.ff + _load + _patch); the second is the map.
        score = (2 if s + "_load.ff" in ffs else 0) + (1 if s + "_patch.ff" in ffs else 0)
        score += 1 if s.startswith("nazi_zombie") else 0
        scored.append((score, s))
    if scored:
        scored.sort(reverse=True)
        return mod_folder, scored[0][1]
    return mod_folder, mod_folder.lower()


# --hardlink (tranche 2, 2026-09-23): mods/<bsp>/ as hard links into extract/<norm>/ instead
# of copies. Same volume, same bytes, one allocation: the popular 64 cost 25 GB of extract/ AND
# 25 GB of mods/ on a drive at 98%. Nothing ever edits either tree in place (an exclusion is
# a staged view, install_map.py --stage), so sharing the inode is safe. Falls back to a copy.
HARDLINK = False
OWNERS = {}   # mods/<slug> -> the norm whose release it came from (extract.json)


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
            if HARDLINK:
                if os.path.exists(out):
                    os.remove(out)
                try:
                    os.link(path, out)
                except OSError:
                    shutil.copy2(path, out)
            else:
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
        elif rc != 0 and kind in ("rar", "zip", "7z"):
            shutil.rmtree(exdir, ignore_errors=True)
            rc2, log2 = run_unar(original, exdir)
            if rc2 == 0:
                rc, log = 0, "7-Zip rc=%d; unar ok" % rc
            else:
                out["errors"].append("7-Zip rc=%d and unar %s: %s" % (
                    rc, rc2 if rc2 is not None else log2, log.strip()[:300]))
        elif rc != 0:
            out["errors"].append("7-Zip rc=%d: %s" % (rc, log.strip()[:400]))
    out["extract_log"] = log.strip()[-1500:]
    if os.path.isdir(exdir):
        renamed = fix_names(exdir)
        if renamed:
            out["renamed_non_utf8"] = renamed

    if not os.path.isdir(exdir):
        out["errors"].append("nothing extracted")
        report.append(out)
        return out

    out["executables"] = sorted(
        os.path.relpath(p, exdir).replace("\\", "/") for p in walk(exdir)
        if p.lower().endswith((".exe", ".dll", ".bat", ".cmd", ".ps1", ".scr", ".msi")))

    roots = find_mod_roots(exdir)
    if not roots:
        # A wrapper archive: Clinic of Evil ships as a .rar containing
        # "Clinic Of Evil.exe" plus a readme, i.e. the installer inside a courtesy
        # archive. One level of recursion, still never executing anything.
        inner = [p for p in walk(exdir)
                 if p.lower().endswith((".exe", ".zip", ".rar", ".7z"))
                 and os.path.getsize(p) > 1 << 20]
        for p in sorted(inner, key=os.path.getsize, reverse=True)[:1]:
            sub = os.path.join(exdir, "_inner")
            rc, log2 = run7z(p, sub)
            out["nested"] = {"file": os.path.relpath(p, exdir).replace("\\", "/"),
                             "kind": fingerprint(p), "rc": rc}
            out["extract_log"] += "\n[nested] " + log2.strip()[-800:]
        roots = find_mod_roots(exdir)
    if not roots:
        out["errors"].append("no .ff/.iwd found in the extraction")
        report.append(out)
        return out
    # Strip the wrapper: report how deep below the extraction root the map sat.
    for folder, files in sorted(roots.items()):
        # A folder INSIDE another mod root is already copied with it (normalise walks the
        # tree). MEASURED 2026-09-22: Library ships `Library/images/z_greenscope.iwd` and it
        # became a map called `images`.
        if any(folder != o and folder.startswith(o + os.sep) for o in roots):
            continue
        depth = len(os.path.relpath(folder, exdir).split(os.sep)) if folder != exdir else 0
        modname, bsp = guess_names(folder, files)
        # The normalised install is named after the BSP, not after whatever the
        # installer's payload folder happened to be called ("City of Hell", with
        # spaces, or "ORBiT_v1.2", with a version in it). fs_game takes any folder
        # name, so we take the predictable one -- which is also how B's existing
        # `mods/nazi_zombie_ali` is laid out.
        slug = re.sub(r"[^a-z0-9_]+", "_", bsp.lower()).strip("_") or "unknown"
        # Two releases, one bsp (tranche 2, 2026-09-23: remakes reuse names -- a second
        # "killhouse" would have been extracted OVER the first one's mods/ folder, which the
        # site serves and the bucket mirrors). Refuse; the map needs a human to pick a key.
        owner = OWNERS.get(slug)
        if owner and owner != norm:
            out["errors"].append("bsp collision: mods/%s already belongs to %s; not extracted over it"
                                 % (slug, owner))
            continue
        if not owner and os.path.isdir(os.path.join(MODS, slug)):
            out["errors"].append("bsp collision: mods/%s exists and no extract.json entry owns it" % slug)
            continue
        dest, copied = normalise_into_mods(folder, slug)
        out["mods"].append({"map": slug, "installer_folder": modname, "bsp": bsp,
                            "from": os.path.relpath(folder, exdir).replace("\\", "/"),
                            "depth": depth, "dest": dest, "files": copied,
                            "bytes": sum(f["size"] for f in copied),
                            "fs_game": "mods/" + slug})
        if out["wrapper_depth"] is None or depth < out["wrapper_depth"]:
            out["wrapper_depth"] = depth
    report.append(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--norm", action="append", default=[], help="only these (normalised) maps")
    ap.add_argument("--hardlink", action="store_true",
                    help="mods/<bsp>/ as hard links into extract/ (halves the disk cost)")
    a = ap.parse_args()
    global HARDLINK
    HARDLINK = a.hardlink
    try:
        for e in json.load(open(os.path.join(WORK, "reports", "extract.json"), encoding="utf-8")):
            for m in e.get("mods") or []:
                OWNERS.setdefault(m["map"], e["norm"])
    except Exception:
        pass
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
    # MERGE, never overwrite: `--norm one-map` used to replace the whole report
    # with a single entry (and `--norm typo` with an empty one), which silently
    # emptied the results table in docs/kickstart/archive.md.
    path = os.path.join(WORK, "reports", "extract.json")
    existing = []
    if os.path.exists(path):
        try:
            existing = json.load(open(path, encoding="utf-8"))
        except Exception:
            existing = []
    by = {e["norm"]: e for e in existing}
    by.update({e["norm"]: e for e in report})
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([by[k] for k in sorted(by)], fh, indent=2)
    print("\nwrote %s (%d maps)" % (path, len(by)))


if __name__ == "__main__":
    main()
