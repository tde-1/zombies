#!/usr/bin/env python3
"""Map-wide asset completeness: every "Could not load" the engine has ever logged for a map
we host, classified, and traced back to the release's own files.

B, 2026-09-23 13:10: "Make sure invisible zombies can't happen on any other map. No model
should fail to load. Every model, every map, every gun, everything should load flawlessly."

    python archive/asset_audit.py                     # audit every hosted map, write the reports
    python archive/asset_audit.py --map <bsp> [...]   # just these
    python archive/asset_audit.py --pull-box          # first copy the box's console.logs down (read-only)
    python archive/asset_audit.py --no-trace          # skip the Unlinker listing (fast; logs only)

What it reads, all read-only:

  * the site DB (`web/data/zombies.db`, opened `mode=ro`): every map with a version that has
    an `fs_game`, visible or hidden, plus the four stock maps -- "hosted";
  * every server console.log we hold: the box's per-map `waw-en/mods/<bsp>/console.log` and
    `zdev/homes/*/main/console.log` (pulled into ZombiesDev/archive/logs/box-console/<date>/ by
    --pull-box), last nights' local runs `ZombiesDev/logs/dedi/*.console.log`, and the local
    shared `archive/mods/<bsp>/console.log` (the dev harness's server AND client write there,
    so it is the only place client-only kinds -- material, fx, image -- show up);
  * the release's own files (`archive/mods/<bsp>/` = what we ship, `archive/extract/<norm>/` =
    everything the installer holds) and WaW's stock zones, listed with OpenAssetTools'
    Unlinker `--list` (external program, never vendored, lists names only).

A log is cut into processes at `logfile opened on`; a process's lines are attributed to the
map zone it loads (`Loading fastfile '<map>'`), else to its `fs_game mods/<bsp>`.

Per miss it answers two questions:

  role   -- FATAL: an AI / zombie / dog / player character model or its xanims, a weapon or
            viewmodel (model, xanim, weapon file, `unknown item`), a script (`rawfile *.gsc`),
            a HUD material. COSMETIC: everything else (fx, world props, sounds, menus).
            CHRONIC: the same name is also missing on a STOCK map (Nacht/Verrueckt/Shi No
            Numa/Der Riese) in our own logs, or is in the stock list below -- every map lacks
            it, retail included, and nobody can see the difference.
  where  -- `shipped_zone` (in a zone we ship; if it still failed, that zone is not loaded or
            loads too late), `shipped_iwd`, `unshipped` (in a file of the original download we do
            NOT ship: the importer dropped it -- fixable), `stock_zone:<ff>` (only in a stock map's
            own zone, which a custom map never loads: the author's bug), `absent` (nowhere in the
            download: the author's bug), `missingasset_csv` (the author's own build said so).

Outputs ZombiesDev/archive/reports/asset-audit.json and asset-audit.md.
"""
import argparse
import collections
import csv
import datetime
import glob
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
DEV = os.path.dirname(WORK)
MODS = os.path.join(WORK, "mods")
EXTRACT = os.path.join(WORK, "extract")
REPORTS = os.path.join(WORK, "reports")
BOXLOGS = os.path.join(WORK, "logs", "box-console")
LOCAL_LOGS = os.path.join(DEV, "logs", "dedi")
STOCK_ZONE = os.path.join(DEV, "waw-base", "zone", "english")
STOCK_MAIN = os.path.join(DEV, "waw-base", "main")
UNLINKER = os.path.join(DEV, "tools", "oat", "Unlinker.exe")
# What the site serves of a map (web/server/lib/mapfiles.js ALLOWED; keep the two in step).
SERVED_EXT = {".ff", ".iwd", ".arena", ".csv", ".txt", ".cfg", ".gsc", ".csc", ".iwi", ".bik", ".menu", ".str",
              ".wav", ".mp3", ""}
# What the stock engine can read out of a mod folder at runtime with useFastFile 1: zones,
# IWDs, loose images / streamed sounds / weapon files / scripts / string & sound tables.
# (.tga/.psd/.map/.gdt/.efx/.atr are mod-tools SOURCE; the zone already holds the compiled asset.)
ENGINE_EXT = {".ff", ".iwd", ".iwi", ".wav", ".mp3", "", ".gsc", ".csc", ".csv", ".str", ".menu", ".bik", ".arena"}
CACHE = os.path.join(WORK, "cache", "asset-lists")
MANIFESTS = os.path.join(HERE, "manifests")
# The site DB the LIVE site uses. A worktree has no web/data; read the main checkout's.
DB = os.environ.get("ENW_SITE_DB", r"C:\Users\b\Desktop\Zombies\web\data\zombies.db")
HOST = "zombies-dev"

STOCK_MAPS = ("nazi_zombie_prototype", "nazi_zombie_asylum", "nazi_zombie_sumpf", "nazi_zombie_factory")
# Zones that are not "the map": what loads for every map, before it.
INFRA_ZONES = {"code_post_gfx", "mod", "ui", "common", "patch", "default", "localized_common",
               "localized_code_post_gfx", "common_ignore", "code_pre_gfx"}

# ---- the log ---------------------------------------------------------------------------------
RX_MISS = [
    # Error: Could not load xanim "ai_flamethrower_stand_idle".   (lines can arrive glued to the
    # previous print, "animscripts/traverse/wall_hopError: Could ...", so search, never match)
    (re.compile(r'Could not load (xanim|xmodel|material|fx|rawfile|menufile|sound|image|weapon|'
                r'stringtable|localize|techniqueset|loadedsound|physpreset|font) "([^"]+)"'), None),
    (re.compile(r"WARNING: Could not load weapon file '([^']+)'"), "weapon"),
    (re.compile(r"ERROR: image '([^']+)' is missing"), "image"),
    # unknown item 'napalmblob': (file 'maps/_loadout.gsc', line 419) -- the script is kept
    (re.compile(r"unknown item '([^']+)'(?:: \(file '([^']+)')?"), "item"),
    (re.compile(r"Could not find zone '([^']+)'"), "zone"),
    (re.compile(r'Waited \d+ msec for missing asset "([^"]+)"'), "waited"),
    (re.compile(r"Couldn't find the sound alias '?([A-Za-z0-9_./-]+)"), "sound"),
]
RX_LOADFF = re.compile(r"Loading fastfile '([^']+)'")
RX_FSGAME = re.compile(r'(?:dvar set fs_game |fs_game ")mods/([A-Za-z0-9_.-]+)')
RX_NEWPROC = re.compile(r"^logfile opened on ")


def map_zone(z):
    z = z.lower()
    if z in INFRA_ZONES or z.startswith("localized_") or z.endswith("_patch") or z.endswith("_load"):
        return None
    return z


def parse_log(path, hosted, seen=None):
    """-> {bsp: {"processes": n, "loaded": n, "miss": {(kind, name): count}}}

    `seen` (a set shared across files) drops a process already counted from another copy of
    the same log -- a box proof's saved slice and a later pull of the same console.log."""
    out = {}
    try:
        fh = open(path, "rb")
    except OSError:
        return out
    proc = None
    seen = seen if seen is not None else set()

    def flush():
        if not proc:
            return
        bsp = proc["map"] or proc["fs"]
        if not bsp or (hosted and bsp not in hosted):
            return
        key = (proc["opened"], bsp, sum(proc["miss"].values())) if proc["opened"] else None
        if key and key in seen:
            return
        if key:
            seen.add(key)
        r = out.setdefault(bsp, {"processes": 0, "loaded": 0, "miss": collections.Counter(), "ctx": {}})
        r["processes"] += 1
        r["loaded"] += 1 if proc["map"] else 0
        r["miss"].update(proc["miss"])
        r["ctx"].update(proc["ctx"])

    with fh:
        for raw in fh:
            ln = raw.decode("latin-1").rstrip("\r\n")
            if RX_NEWPROC.search(ln) or proc is None:
                flush()
                proc = {"map": None, "fs": None, "miss": collections.Counter(), "ctx": {},
                        "opened": ln.strip() if RX_NEWPROC.search(ln) else None}
                if RX_NEWPROC.search(ln):
                    continue
            m = RX_LOADFF.search(ln)
            if m:
                z = map_zone(m.group(1))
                if z:
                    if proc["map"] and proc["map"] != z:
                        # a map_restart / next map inside one process: a new attribution unit
                        flush()
                        proc = {"map": None, "fs": proc["fs"], "miss": collections.Counter(), "ctx": {},
                                "opened": (proc["opened"] or "") + " +" + z}
                    proc["map"] = z
                continue
            m = RX_FSGAME.search(ln)
            if m:
                proc["fs"] = m.group(1).lower()
                continue
            if "ould not" not in ln and "missing" not in ln and "unknown item" not in ln \
                    and "Couldn't find" not in ln:
                continue
            for rx, kind in RX_MISS:
                for mm in rx.finditer(ln):
                    if kind is None:
                        proc["miss"][(mm.group(1), mm.group(2))] += 1
                    else:
                        proc["miss"][(kind, mm.group(1))] += 1
                        if kind == "item" and mm.group(2):
                            proc["ctx"][(kind, mm.group(1))] = mm.group(2)
        flush()
    return out


def log_sources():
    """[(path, origin)] -- origin is 'box' (dedicated server only) or 'local' (a dev run; the
    archive/mods console.log is shared by the harness's server and client)."""
    src = []
    # box-console/<date>/... = --pull-box copies; box-console/proof-<date>/<bsp>.<match>.console.log
    # = box_proof.py --save-console slices (the map cache evicts a map dir, log and all)
    for p in sorted(glob.glob(os.path.join(BOXLOGS, "**", "*console.log"), recursive=True)):
        src.append((p, "box"))
    for p in glob.glob(os.path.join(LOCAL_LOGS, "*console.log")):
        src.append((p, "local"))
    for p in glob.glob(os.path.join(MODS, "*", "console.log")):
        src.append((p, "local+client"))
    return src


def pull_box(date=None):
    """Copy every console.log off the box (tar over ssh, nice'd, nothing written there)."""
    date = date or datetime.date.today().strftime("%Y%m%d")
    dst = os.path.join(BOXLOGS, date)
    os.makedirs(dst, exist_ok=True)
    cmd = ("cd /home/waw && nice -n 19 tar czf - waw-en/mods/*/console.log "
           "pfx/drive_c/zdev/homes/*/main/console.log 2>/dev/null")
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, cmd], capture_output=True, timeout=600)
    t = subprocess.run(["tar", "xzf", "-", "-C", dst], input=p.stdout, capture_output=True)
    return dst, t.returncode


# ---- the hosted set --------------------------------------------------------------------------
def hosted_maps():
    c = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True)
    rows = c.execute("""SELECT m.key, m.title, m.source, m.health, m.hidden, v.fs_game, v.health
                        FROM maps m JOIN map_versions v ON v.map_id = m.id AND v.latest = 1
                        WHERE (v.fs_game IS NOT NULL AND v.fs_game != '') OR m.source = 'stock'""").fetchall()
    out = {}
    for key, title, source, health, hidden, fs, vhealth in rows:
        bsp = fs.split("/", 1)[1].lower() if fs and fs.startswith("mods/") else key.lower()
        out[bsp] = {"key": key, "title": title, "source": source, "health": health,
                    "hidden": bool(hidden), "fs_game": fs}
    for s in STOCK_MAPS:
        out.setdefault(s, {"key": s, "title": s, "source": "stock", "health": "verified",
                           "hidden": False, "fs_game": None})
    return out


# ---- what a file holds -----------------------------------------------------------------------
REFS = {}   # zone path -> {(kind, name)} it REFERENCES but does not define


def unlinker_list(ff):
    """{(kind, name)} of the assets a zone DEFINES. OAT lists a mere reference (an asset of
    this zone points at it; it must come from a zone loaded earlier) with a leading comma:
    those go to REFS[ff]. Cached by path+size+mtime."""
    os.makedirs(CACHE, exist_ok=True)
    st = os.stat(ff)
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.relpath(ff, DEV))[-150:]
    cp = os.path.join(CACHE, key + ".json")
    if os.path.exists(cp):
        c = json.load(open(cp, encoding="utf-8"))
        if c.get("size") == st.st_size and c.get("mtime") == int(st.st_mtime) and "refs" in c:
            REFS[ff] = {tuple(x) for x in c["refs"]}
            return {tuple(x) for x in c["assets"]}
    r = subprocess.run([UNLINKER, "--list", ff], capture_output=True, text=True, errors="replace",
                       cwd=os.path.dirname(ff), timeout=600)
    assets, refs = set(), set()
    for ln in r.stdout.splitlines():
        m = re.match(r"^([a-z_]+), (.+)$", ln)
        if not m:
            continue
        name = m.group(2).strip().lower()
        if name.startswith(","):
            refs.add((m.group(1), name[1:]))
        else:
            assets.add((m.group(1), name))
    REFS[ff] = refs
    with open(cp, "w", encoding="utf-8") as fh:
        json.dump({"ff": ff, "size": st.st_size, "mtime": int(st.st_mtime),
                   "assets": sorted(assets), "refs": sorted(refs)}, fh)
    return assets


def iwd_names(p):
    try:
        with zipfile.ZipFile(p) as z:
            return [n.lower() for n in z.namelist()]
    except Exception:
        return []


# The engine's kind -> the Unlinker's kind(s)
UNL_KIND = {"xanim": ["xanim"], "xmodel": ["xmodel"], "material": ["material"], "fx": ["fx"],
            "rawfile": ["rawfile"], "menufile": ["menulist", "menu"], "sound": ["sound"],
            "image": ["image"], "weapon": ["weapon"], "item": ["weapon"], "waited": ["xanim", "xmodel"],
            "stringtable": ["stringtable"], "localize": ["localize"]}


class Index:
    """Where each asset name lives: shipped zones, shipped iwds, unshipped files of the
    original, stock zones."""

    def __init__(self, trace=True):
        self.trace = trace
        self.stock = {}      # (kind,name) -> [zone]
        self.stock_loaded = set()
        self.stock_iwd = set()
        if trace:
            for ff in sorted(glob.glob(os.path.join(STOCK_ZONE, "*.ff"))):
                z = os.path.basename(ff)[:-3].lower()
                if not (z in INFRA_ZONES or z.startswith("nazi_zombie") or z.startswith("localized_nazi")):
                    continue   # the zombies game never loads mp_/campaign zones
                for a in unlinker_list(ff):
                    self.stock.setdefault(a, []).append(z)
                    if z in INFRA_ZONES:
                        self.stock_loaded.add(a)
            for p in glob.glob(os.path.join(STOCK_MAIN, "*.iwd")):
                self.stock_iwd.update(iwd_names(p))

    def for_map(self, bsp, extract_entry):
        """What this map actually gets. SHIPPED = the files the site serves for it
        (extract.json's list through mapfiles.js ALLOWED, i.e. what the bucket, the box and a
        player's launcher hold). UNSHIPPED = any engine-readable file of the original download
        that is not in that set: the importer or the serve filter dropped it."""
        d = os.path.join(MODS, bsp)
        shipped = {}
        if extract_entry:
            for m in extract_entry.get("mods", []):
                if m["map"].lower() != bsp:
                    continue
                for f in m["files"]:
                    rel = f["path"].split("/", 2)[2]
                    if os.path.splitext(rel)[1].lower() in SERVED_EXT and os.path.isfile(os.path.join(d, rel)):
                        shipped[rel.replace("\\", "/").lower()] = os.path.join(d, rel)
        orig = {}
        if extract_entry:
            root = os.path.join(EXTRACT, extract_entry["norm"])
            for p in glob.glob(os.path.join(root, "**", "*"), recursive=True):
                if os.path.isfile(p) and "$pluginsdir" not in p.lower():
                    orig[p] = os.path.getsize(p)
        # a file of the original is "unshipped" when no shipped file has its name + size
        shipped_sig = {(os.path.basename(p).lower(), os.path.getsize(p)) for p in shipped.values()}
        unshipped = [p for p, sz in orig.items() if (os.path.basename(p).lower(), sz) not in shipped_sig
                     and os.path.splitext(p)[1].lower() in ENGINE_EXT]
        ix = {"zones": {}, "iwd": {}, "unshipped_zones": {}, "unshipped_iwd": {}, "loose": set(shipped),
              "unshipped_files": [os.path.relpath(p, EXTRACT) for p in unshipped],
              "missingasset_csv": set()}
        ix["refs"] = {}
        for rel, p in shipped.items():
            if rel.endswith(".ff") and self.trace:
                ix["zones"][rel] = unlinker_list(p)
                ix["refs"][rel] = REFS.get(p, set())
            elif rel.endswith(".iwd"):
                ix["iwd"][rel] = set(iwd_names(p))
            elif os.path.basename(rel) == "missingasset.csv":
                try:
                    for row in csv.reader(io.open(p, encoding="latin-1")):
                        if len(row) >= 2:
                            ix["missingasset_csv"].add((row[0].strip().lower(), row[1].strip().lower()))
                except Exception:
                    pass
        for p in unshipped:
            rel = os.path.relpath(p, EXTRACT)
            if p.lower().endswith(".ff") and self.trace:
                ix["unshipped_zones"][rel] = unlinker_list(p)
            elif p.lower().endswith(".iwd"):
                ix["unshipped_iwd"][rel] = set(iwd_names(p))
        # Can this map put a hellhound on screen at all? Only if a zone it LOADS defines the
        # dog's model; the community script set drags the dog animtree into maps that have
        # no dogs, and their missing dog xanims can never play.
        loaded = {z: a for z, a in ix["zones"].items() if not zone_unloaded(bsp, z)}
        ix["has_dogs"] = any(k == "xmodel" and re.search(r"wolf|hellhound|(^|_)dog(_|$)", n)
                             for a in loaded.values() for (k, n) in a)
        ix["unloaded_zones"] = sorted(z for z in ix["zones"] if zone_unloaded(bsp, z))
        ix["static"] = self.static_checks(bsp, ix)
        return ix

    def static_checks(self, bsp, ix):
        """What the zones alone say, no boot needed (so it covers maps with no log):

        load_zone_only -- gameplay assets (xmodel/xanim/weapon/fx) defined ONLY in <bsp>_load.ff.
            A real dedicated server never loads the load zone (nor `ui`): measured on every box
            console.log of 2026-09-23, stock and custom, while a listen server (retail solo,
            the 09-22 local "LAN server" runs) does. So the box's server lacks them.
        unresolved_refs -- an asset of a zone the server loads points at an xmodel/xanim/weapon
            that no loaded zone defines (OAT's `,name` entries): "Could not load" on every boot."""
        b = bsp.lower()
        server = {z: a for z, a in ix["zones"].items()
                  if os.path.basename(z)[:-3] in ("mod", b, b + "_patch", "localized_" + b)}
        load = {z: a for z, a in ix["zones"].items() if os.path.basename(z)[:-3] == b + "_load"}
        have = set(self.stock_loaded)
        for a in server.values():
            have |= a
        gameplay = ("xmodel", "xanim", "weapon", "fx")
        load_only = sorted({(k, n) for a in load.values() for (k, n) in a if k in gameplay and (k, n) not in have})
        unresolved = set()
        for z in server:
            for (k, n) in ix["refs"].get(z, ()):
                if k in ("xmodel", "xanim", "weapon") and (k, n) not in have:
                    unresolved.add((k, n))
        return {"load_zone_only": ["%s:%s" % x for x in load_only],
                "unresolved_refs": ["%s:%s" % x for x in sorted(unresolved)]}


def zone_unloaded(bsp, rel):
    """A zone in the mod folder that nothing loads: the engine loads mod.ff, <bsp>.ff,
    <bsp>_patch.ff, <bsp>_load.ff and localized_<bsp>.ff for this map, nothing else
    (mod-compat.md s2: `gumball.ff` in Minecraft Village is shipped and never loaded)."""
    z = os.path.basename(rel).lower()[:-3]
    b = bsp.lower()
    return z not in ("mod", b, b + "_patch", b + "_load", "localized_" + b)


def iwd_paths(kind, name):
    n = name.lower()
    if kind == "image":
        return ["images/%s.iwi" % n]
    if kind in ("weapon", "item"):
        return ["weapons/sp/%s" % n]
    if kind == "sound":
        return []
    if kind == "rawfile":
        return [n]
    return []


def locate(kind, name, ix, index):
    """-> (where, detail)"""
    n = name.lower()
    kinds = UNL_KIND.get(kind, [kind])
    unloaded = None
    for zone, assets in ix["zones"].items():
        if any((k, n) in assets for k in kinds):
            if zone in ix["unloaded_zones"]:
                unloaded = unloaded or zone
                continue
            if os.path.basename(zone).lower().endswith("_load.ff"):
                # in the load zone, which the dedicated server never loads (static_checks)
                return "load_zone_only", zone
            return "shipped_zone", zone
    if unloaded:
        # shipped, but in a zone the engine never loads for this map (gumball.ff)
        return "shipped_unloaded_zone", unloaded
    for path in iwd_paths(kind, n):
        for iwd, names in ix["iwd"].items():
            if path in names:
                return "shipped_iwd", iwd
        if path in ix["loose"]:
            return "shipped_iwd", "(loose file)"
    for zone, assets in ix["unshipped_zones"].items():
        if any((k, n) in assets for k in kinds):
            return "unshipped", zone
    for path in iwd_paths(kind, n):
        for iwd, names in ix["unshipped_iwd"].items():
            if path in names:
                return "unshipped", iwd
    st = [z for k in kinds for z in index.stock.get((k, n), [])]
    if st:
        loaded = [z for z in st if z in INFRA_ZONES]
        if loaded:
            return "stock_loaded", ",".join(sorted(set(loaded)))
        return "stock_zone", ",".join(sorted(set(st)))
    for path in iwd_paths(kind, n):
        if path in index.stock_iwd:
            return "stock_iwd", path
    for (a, b) in ix["missingasset_csv"]:
        if b == n or a == n:
            return "missingasset_csv", a
    return "absent", None


# ---- role ------------------------------------------------------------------------------------
# Each pattern was read off the misses the logs actually show (2026-09-23, 150+ maps), and
# kept tight: "zombie_zapper_cagelight_green" and "lights_berlin_subway_hat_0" are props that
# only LOOK like a zombie and a hat.
RX_CHAR_MODEL = re.compile(
    r"^(char_|c_(zom|usa|jap|ger|rus|nzv|t\d|bo\d)|body|head|zombie_wolf|zombie_dog|viewhands|"
    r"viewmodel_hands|vh_|zom_player|zombie_player|player_)|"
    r"(_body|_head|_torso|_legs|_viewhands|_viewarms|_hands|_arms|_zombie|_player)(_?\d+|_[a-z])?$|"
    r"(^|_)(zombie|zomb)_(body|head|torso|legs|gib|eye)", re.I)
RX_WEAPON_MODEL = re.compile(r"^(viewmodel_|weapon_|worldmodel_|wpn_|t\d_wpn|zombie_wpn|t\d_.+_(world|view)$)", re.I)
RX_DOG_ANIM = re.compile(r"^(zombie_dog_|ai_dog_|dog_|ai_hellhound)", re.I)
RX_AI_ANIM = re.compile(r"^(ai_zombie|ai_zomb|ai_crawl|ai_boss|ai_panzer|ai_brutus|ai_monkey|ai_napalm|"
                        r"ai_shrieker|ch_zombie|zombie_(?!dog))", re.I)
RX_VIEW_ANIM = re.compile(r"^(viewmodel_|pv_|vm_)", re.I)
RX_HUD = re.compile(r"^(hud_|specialty_|zom_icon|zombie_icon|menu_zombie|compass_|waypoint|objective|"
                    r"headicon|reticle|scope_overlay|overlay_|killicon|zom_hud|zombie_hud|chalk_|tally)", re.I)
RX_AI_ANIM_CHRONIC = re.compile(r"^ai_flamethrower_", re.I)


def role(kind, name, ctx=None):
    """-> (role, fatal-candidate, why). `ctx`: has_dogs (a loaded zone defines a dog model),
    zone_ref (a loaded zone of the map references this asset), script (for `unknown item`)."""
    ctx = ctx or {}
    n = name.lower()
    if kind == "rawfile":
        if n.endswith((".gsc", ".csc")):
            return "script", True, "a script the map calls is not in any loaded zone or iwd"
        return "cosmetic", False, "non-script rawfile"
    if kind == "zone":
        return "zone", False, "an optional zone (localized_*, _load) the release does not ship"
    if kind == "item":
        if (ctx.get("script") or "").lower().endswith("maps/_loadout.gsc"):
            return "loadout", False, ("PrecacheItem in the map's own _loadout.gsc for an item its zone "
                                      "lacks: the campaign default loadout (a bsp not named nazi_zombie_*). "
                                      "Identical in retail; the release's own script")
        return "weapon", True, "a script gives/precaches a weapon the map's zones do not hold"
    if kind == "weapon":
        return "weapon", True, "a weapon file the map's scripts ask for is not shipped"
    if kind == "xmodel":
        if RX_WEAPON_MODEL.search(n):
            if ctx.get("zone_ref"):
                return "weapon", True, "a weapon in the map's own zone points at this model"
            return "weapon_script", False, ("precached by script only; no weapon in the map's zones "
                                            "uses it (loadout/wall-chalk leftovers)")
        if RX_CHAR_MODEL.search(n):
            return "character", True, "a character (player/zombie/dog) model"
        return "cosmetic", False, "a prop / world model"
    if kind in ("xanim", "waited"):
        if RX_AI_ANIM_CHRONIC.search(n):
            return "cosmetic", False, "flamethrower-AI anims: no WaW zombies map has that AI"
        if RX_DOG_ANIM.search(n):
            if ctx.get("has_dogs"):
                return "character", True, "a hellhound anim, and this map has hellhounds"
            return "cosmetic", False, "a hellhound anim on a map with no hellhound model: dogs never spawn"
        if RX_VIEW_ANIM.search(n):
            return "weapon", True, "a first-person weapon anim"
        if RX_AI_ANIM.search(n):
            return "character", True, "a zombie AI anim"
        return "cosmetic", False, "a scripted / prop anim"
    if kind in ("material", "image"):
        if RX_HUD.search(n):
            return "hud", True, "a HUD material (client only)"
        return "cosmetic", False, "a surface / fx material (client only)"
    return "cosmetic", False, kind


# ---- what a player sees, and whose it is --------------------------------------------------
# A fatal-role miss is VISIBLE when a player of the map will meet it as an invisible, headless
# or default-model zombie/teammate, missing first-person hands, or a gun/grenade/knife that the
# box, a wall or the loadout cannot give. Everything else in the fatal roles (one ADS anim, a
# gib/limb-spawn variant, a HUD icon, the wonder-weapon reaction set) is MINOR: logged, shown in
# the table, never a reason to hide. Decided 2026-09-23 against the rows the logs actually hold.
RX_GIB = re.compile(r"(_g_|behead|spawn|_off|gib|upclean|lowclean|_torso_|zombieeye)", re.I)
RX_CORE_AI_ANIM = re.compile(r"^ai_zombie_(walk|run|sprint|attack|traverse|jump|climb|window|barricade|"
                             r"crawl(?!_quad)|idle(?!_quad)|death(?!_icestaff)|spawn|dog_)|^zombie_dog_(run|attack|idle|trot)",
                             re.I)
# Weapon files the community script set asks for on maps that play fine: the perk-drink knuckle
# crack and the bowie flourish are first-person "animations as weapons" (6 and 4 maps).
HELPER_WEAPONS = {"zombie_knuckle_crack", "zombie_bowie_flourish",
                  "weapons/sp/zombie_knuckle_crack", "weapons/sp/zombie_bowie_flourish"}
# Where a miss can be changed by us (the file exists and we do not deliver it to the process
# that needs it) vs. is the release as its author built it (a retail listen server with the
# same files misses it too).
OURS = {"unshipped", "load_zone_only"}
PATCHABLE = {"shipped_unloaded_zone"}   # the release ships it under a name nothing loads


def visible(r):
    k, n, rl = r["kind"], r["name"].lower(), r["role"]
    if not r["fatal"]:
        return False
    if rl == "character" and k == "xmodel":
        return not RX_GIB.search(n)
    if rl == "character":           # xanim / waited
        return bool(RX_CORE_AI_ANIM.search(n))
    if rl == "weapon":
        if n in HELPER_WEAPONS:
            return False
        if k in ("item", "weapon"):
            return True
        if k == "xmodel":           # a weapon in the map's own zone points at it: an invisible gun
            return True
        return False                # one viewmodel anim
    if rl == "script":
        return True
    return False                    # hud


def owner(where):
    if where in OURS:
        return "ours"
    if where in PATCHABLE:
        return "patchable"
    return "release"


# ---- the audit -------------------------------------------------------------------------------
def extract_entries():
    ex = json.load(open(os.path.join(REPORTS, "extract.json"), encoding="utf-8"))
    out = {}
    for e in ex:
        for m in e.get("mods", []):
            out[m["map"].lower()] = e
    return out


def audit(maps=None, trace=True):
    hosted = hosted_maps()
    want = [m.lower() for m in maps] if maps else sorted(hosted)
    per = {b: {"processes": 0, "loaded": 0, "miss": collections.Counter(), "sources": collections.Counter(),
               "origins": set(), "ctx": {}} for b in hosted}
    miss_src = collections.defaultdict(set)   # (bsp, kind, name) -> {origin}
    seen = set()
    for path, origin in log_sources():
        for bsp, r in parse_log(path, hosted, seen).items():
            p = per[bsp]
            p["processes"] += r["processes"]
            p["loaded"] += r["loaded"]
            p["miss"].update(r["miss"])
            p["ctx"].update(r["ctx"])
            p["origins"].add(origin)
            if r["processes"]:
                p["sources"][os.path.relpath(path, DEV)] += r["processes"]
            for k in r["miss"]:
                miss_src[(bsp,) + k].add(origin)
    # chronic: what the four stock maps also miss in our own logs (retail content, retail misses)
    chronic = set()
    for s in STOCK_MAPS:
        chronic.update(per[s]["miss"].keys())
    # prevalence: how many hosted custom maps miss the same name (the shared community script set)
    prevalence = collections.Counter()
    for b, p in per.items():
        if hosted[b]["source"] != "stock":
            for k in p["miss"]:
                prevalence[k] += 1
    index = Index(trace=trace)
    ext = extract_entries()
    report = {"at": datetime.datetime.now().isoformat(timespec="seconds"),
              "hosted": len(hosted), "chronic_names": len(chronic), "maps": {}}
    for bsp in want:
        if bsp not in hosted:
            print("not hosted: %s" % bsp, file=sys.stderr)
            continue
        p = per[bsp]
        h = hosted[bsp]
        ix = index.for_map(bsp, ext.get(bsp)) if (trace and h["source"] != "stock") else None
        rows = []
        for (kind, name), cnt in sorted(p["miss"].items()):
            ctx = {"script": p["ctx"].get((kind, name))}
            if ix is not None:
                ctx["has_dogs"] = ix["has_dogs"]
                ctx["zone_ref"] = any((k, name.lower()) in refs for z, refs in ix["refs"].items()
                                      if z not in ix["unloaded_zones"] for k in UNL_KIND.get(kind, [kind]))
            rl, cand, why = role(kind, name, ctx)
            r = {"kind": kind, "name": name, "count": cnt, "role": rl, "why": why,
                 "chronic": (kind, name) in chronic, "maps_missing_it": prevalence[(kind, name)],
                 "seen_on": sorted(miss_src[(bsp, kind, name)])}
            if ctx.get("script"):
                r["script"] = ctx["script"]
            if ix is not None:
                r["zone_ref"] = ctx["zone_ref"]
                r["where"], r["where_detail"] = locate(kind, name, ix, index)
            r["fatal"] = bool(cand and not r["chronic"] and h["source"] != "stock")
            r["visible"] = visible(r)
            if r["fatal"]:
                r["owner"] = owner(r.get("where"))
            rows.append(r)
        fatal = [r for r in rows if r["fatal"]]
        vis = [r for r in fatal if r["visible"]]
        report["maps"][bsp] = {
            "key": h["key"], "title": h["title"], "source": h["source"], "health": h["health"],
            "hidden": h["hidden"], "processes": p["processes"], "map_loaded_runs": p["loaded"],
            "log_origins": sorted(p["origins"]), "log_files": dict(p["sources"].most_common(8)),
            "unshipped_files": ix["unshipped_files"] if ix else [],
            "unloaded_zones": ix["unloaded_zones"] if ix else [],
            "has_dogs": ix["has_dogs"] if ix else None,
            "static": ix["static"] if ix else {},
            "misses": len(rows), "fatal": len(fatal),
            "fatal_by_role": dict(collections.Counter(r["role"] for r in fatal)),
            "fatal_where": dict(collections.Counter(r.get("where") for r in fatal)),
            "fixable": sorted({r["where_detail"] for r in fatal if r.get("where") == "unshipped"}),
            "visible": len(vis),
            "visible_owner": dict(collections.Counter(r.get("owner") for r in vis)),
            "visible_names": ["%s:%s" % (r["kind"], r["name"]) for r in vis][:40],
            "rows": rows,
        }
        report["maps"][bsp]["verdict"] = verdict(report["maps"][bsp])
    return report


def verdict(m):
    """clean | minor (fatal-role misses a player never meets) | fix (a visible miss we cause:
    a file we do not deliver) | patch (the release ships it under a name nothing loads) |
    hide (a visible miss that is the release's own) | unproven (no console log: boot it)."""
    if m["source"] == "stock":
        return "clean"
    if not m["map_loaded_runs"]:
        return "unproven"
    own = m.get("visible_owner") or {}
    if own.get("release"):
        return "hide"
    if own.get("patchable"):
        return "patch"
    if own.get("ours"):
        return "fix"
    if m["fatal"]:
        return "minor"
    return "clean"


def write_md(rep, path):
    L = ["# Asset audit (%s)" % rep["at"], "",
         "Generated by `archive/asset_audit.py`. `fatal` = a character/AI model or its xanims, a weapon "
         "(model, viewmodel, xanim, weapon file, unknown item), a script, or a HUD material, that is NOT "
         "also missing on a stock map. `where`: shipped_zone / unshipped (fixable) / stock_zone (only in "
         "a stock map's zone) / absent (nowhere in the release).", "",
         "| map | site | runs (loaded) | logs | misses | fatal | visible | by role | where | verdict |",
         "|---|---|---:|---|---:|---:|---:|---|---|---|"]
    for bsp, m in sorted(rep["maps"].items(), key=lambda kv: (-kv[1]["fatal"], kv[0])):
        site = "%s%s" % (m["health"], " (hidden)" if m["hidden"] else "")
        L.append("| `%s` | %s | %d (%d) | %s | %d | %d | %d | %s | %s | %s |" % (
            bsp, site, m["processes"], m["map_loaded_runs"], "+".join(m["log_origins"]) or "-",
            m["misses"], m["fatal"], m["visible"],
            ", ".join("%s %d" % kv for kv in sorted(m["fatal_by_role"].items())) or "-",
            ", ".join("%s %d" % kv for kv in sorted(m["fatal_where"].items(), key=lambda x: str(x))) or "-",
            m["verdict"]))
    L += ["", "## Fatal misses, per map", ""]
    for bsp, m in sorted(rep["maps"].items()):
        f = [r for r in m["rows"] if r["fatal"]]
        if not f:
            continue
        L.append("### `%s` — %s" % (bsp, m["title"]))
        L.append("")
        for r in f[:60]:
            L.append("- %s%s `%s` (%s) x%d — %s%s; on %d maps" % (
                "**VISIBLE** " if r["visible"] else "", r["kind"], r["name"], r["role"], r["count"], r.get("where", "?"),
                (" `%s`" % r["where_detail"]) if r.get("where_detail") else "", r["maps_missing_it"]))
        if len(f) > 60:
            L.append("- ... %d more in the JSON" % (len(f) - 60))
        L.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--pull-box", action="store_true")
    ap.add_argument("--no-trace", action="store_true")
    ap.add_argument("--out", default=os.path.join(REPORTS, "asset-audit.json"))
    a = ap.parse_args()
    if a.pull_box:
        print("box logs -> %s (tar rc %s)" % pull_box())
    rep = audit(a.map or None, trace=not a.no_trace)
    if not a.map:
        with open(a.out, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, indent=1)
        write_md(rep, os.path.splitext(a.out)[0] + ".md")
    for bsp, m in sorted(rep["maps"].items(), key=lambda kv: (kv[1]["verdict"], kv[0])):
        print("%-30s %-6s runs=%3d loaded=%3d misses=%4d fatal=%3d visible=%3d %-34s %s" % (
            bsp, "hidden" if m["hidden"] else "LIVE", m["processes"], m["map_loaded_runs"], m["misses"],
            m["fatal"], m["visible"], json.dumps(m["visible_owner"]), m["verdict"]))


if __name__ == "__main__":
    main()
