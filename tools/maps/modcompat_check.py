"""Mod-compat check: does the client get byte-for-byte what the box serves? (mod-compat.md §5)

For every map in the archive's extract report, three file sets are compared:

  archive  every file the extract recorded (reports/extract.json), with its SHA-256
  client   what a launcher installs: the site's /api/maps/<bsp>/files list, which is the
           archive list filtered by web/server/lib/mapfiles.js ALLOWED, then the
           launcher's own ALLOWED_EXT (library.js) -- recomputed here from both sources
  box      `sha256sum` of /home/waw/waw-en/mods/<bsp>/* on zombies-dev (read-only), fed
           in as a file:  ssh zombies-dev 'cd /home/waw/waw-en/mods && find . -type f
           ! -name console.log -print0 | sort -z | xargs -0 sha256sum' > box_sha.txt

and every difference is named with its cause: a file the box has and the client never
gets (a filter drops it), a file the client gets and the box does not (install.exclude,
or never staged), or the same path with different bytes. `mod.arena` differing only by
the UTF-8 BOM the launcher strips (library.js repair) is reported as `bom` and is not a
mismatch -- the engine reads the same text.

  python tools/maps/modcompat_check.py --box box_sha.txt [--json out.json]
"""
import argparse
import hashlib
import json
import os
import re
import sys

ARCHIVE = os.environ.get("ENW_ARCHIVE", r"C:\Users\b\ZombiesDev\archive")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def js_set(path, name):
    """Read `const NAME = new Set([...])` out of a JS file, so this check follows the code."""
    src = open(path, encoding="utf-8").read()
    m = re.search(name + r"\s*=\s*new Set\(\[([^\]]*)\]\)", src)
    if not m:
        sys.exit("could not find %s in %s" % (name, path))
    return set(re.findall(r"'([^']*)'", m.group(1)))


SITE_ALLOWED = js_set(os.path.join(REPO, "web", "server", "lib", "mapfiles.js"), "ALLOWED")
LAUNCHER_ALLOWED = js_set(os.path.join(REPO, "launcher", "src", "main", "library.js"), "ALLOWED_EXT")
LAUNCHER_BANNED = js_set(os.path.join(REPO, "launcher", "src", "main", "library.js"), "BANNED_EXT")


def client_gets(rel):
    """None if a launcher installs `rel`, else the reason it does not."""
    ext = os.path.splitext(rel)[1].lower()
    # mapfiles.js refuses a `..` path SEGMENT (traversal); a `..` inside a name is a file
    # (Neon Fighter's `HarryBos Mysterybox Pack V1..0.0.iwd`, archive.md 13)
    if ".." in re.split(r"[\\/]", rel):
        return "site filter (a '..' path segment)"
    if ext not in SITE_ALLOWED:
        return "site filter (mapfiles.js ALLOWED has no '%s')" % (ext or "no extension")
    if ext in LAUNCHER_BANNED:
        return "launcher refuses '%s'" % ext
    if ext and ext not in LAUNCHER_ALLOWED:
        return "launcher filter (library.js ALLOWED_EXT has no '%s')" % ext
    return None


def load_box(path):
    box = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"^([0-9a-f]{64})\s+\*?\./([^/]+)/(.+)$", line.strip())
        if m:
            box.setdefault(m.group(2), {})[m.group(3)] = m.group(1)
    return box


def manifest_excludes(bsp):
    p = os.path.join(REPO, "archive", "manifests", bsp + ".json")
    try:
        man = json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}
    return {str(e.get("file", "")).lower(): e.get("reason", "") for e in ((man.get("install") or {}).get("exclude") or [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()

    box = load_box(a.box)
    rows = json.load(open(os.path.join(ARCHIVE, "reports", "extract.json"), encoding="utf-8"))
    out = []
    for r in rows:
        for m in r.get("mods") or []:
            bsp = m.get("bsp")
            if not bsp:
                continue
            arch = {}
            for f in m.get("files") or []:
                rel = re.sub(r"^mods[\\/][^\\/]+[\\/]", "", f["path"]).replace("\\", "/")
                arch[rel] = f.get("sha256")
            onbox = box.get(bsp)
            excl = manifest_excludes(bsp)
            issues = []
            client = {rel: h for rel, h in arch.items() if client_gets(rel) is None}
            for rel, h in sorted(arch.items()):
                why = client_gets(rel)
                if why and rel.lower().endswith(".files"):
                    # An installer's own file list (UGX/NSIS). No engine code opens it.
                    issues.append({"file": rel, "kind": "ignored", "why": "installer file list; the engine never reads it"})
                elif why and onbox is not None and rel in onbox:
                    issues.append({"file": rel, "kind": "box-only", "why": why})
                elif why:
                    issues.append({"file": rel, "kind": "never-installed", "why": why})
            if onbox is not None:
                for rel, h in sorted(client.items()):
                    if rel not in onbox:
                        why = "install.exclude: " + excl[rel.lower()] if rel.lower() in excl else "not staged on the box"
                        issues.append({"file": rel, "kind": "client-only", "why": why})
                    elif h and onbox[rel] != h:
                        kind, why = "bytes-differ", "box %s.. vs archive %s.." % (onbox[rel][:12], h[:12])
                        if rel.lower().endswith(".arena"):
                            src = os.path.join(m.get("dest") or "", rel)
                            try:
                                raw = open(src, "rb").read()
                                if raw[:3] == b"\xef\xbb\xbf" and hashlib.sha256(raw[3:]).hexdigest() == onbox[rel]:
                                    kind, why = "bom", "box has the BOM-stripped copy (same text)"
                            except OSError:
                                pass
                        issues.append({"file": rel, "kind": kind, "why": why})
                for rel in sorted(onbox):
                    if rel not in arch:
                        issues.append({"file": rel, "kind": "box-extra", "why": "on the box, not in the archive's extract record"})
            real = [i for i in issues if i["kind"] not in ("bom", "ignored") and not (onbox is None)]
            out.append({"bsp": bsp, "on_box": onbox is not None, "files": len(arch),
                        "client_files": len(client), "issues": issues, "mismatch": bool(real)})

    on = [o for o in out if o["on_box"]]
    bad = [o for o in on if o["mismatch"]]
    print("maps in archive: %d   on the box: %d   box/client mismatch: %d" % (len(out), len(on), len(bad)))
    for o in out:
        if not [i for i in o["issues"] if i["kind"] != "ignored"]:
            continue
        tag = "MISMATCH" if o["mismatch"] else ("not on box" if not o["on_box"] else "ok")
        print("\n%s  [%s]  %d archive files, client installs %d" % (o["bsp"], tag, o["files"], o["client_files"]))
        kinds = {}
        for i in o["issues"]:
            kinds.setdefault((i["kind"], i["why"]), []).append(i["file"])
        for (k, why), files in sorted(kinds.items()):
            shown = ", ".join(files[:4]) + (" (+%d more)" % (len(files) - 4) if len(files) > 4 else "")
            print("   %-15s %3d  %s -- %s" % (k, len(files), why, shown))
    if a.json:
        json.dump(out, open(a.json, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
