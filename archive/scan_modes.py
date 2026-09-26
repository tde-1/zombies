#!/usr/bin/env python3
"""scan_modes.py - find every map's pre-game choice menu (game mode, difficulty, variant).

docs/kickstart/game-modes.md. B's ask (2026-09-23): Battlestar Galactica asks for a game mode
(Classic / Gungame / Sharpshooter ...) in a menu when it starts; pick it in the launcher instead,
never show the menu, keep records per mode -- for every map "like this".

What "like this" means, mechanically: a map script that OPENS A MENU on a player and WAITS for
that player's `menuresponse` before the game goes on. So for every map in the archive this reads
every script the game would run and looks for exactly that:

    self openMenu("<name>") ... self waittill("menuresponse", menu, response)

Scripts come from two places and the loose file wins, as the game does: a .gsc inside an .iwd
(the filesystem; later .iwd names override earlier ones) beats a rawfile of the same path inside a
fastfile. Battlestar is the proof of that order: its mod.ff carries an OLD maps/_zombiemode.gsc
with no vote in it, its ugx_mod.iwd carries the UGX one, and B was shown the vote.

Known mechanisms get a full catalogue entry the site and host can use (MECHANISMS below).
Anything else that matches is listed under `other` with its menus and the response strings
found near the handler, for a human to read -- nothing unknown is ever auto-answered.

Output: web/server/data/map-modes.json  (the site's catalogue; --out to change)
        a markdown table on stdout        (--table), for the doc

Reads $ENW_ARCHIVE_WORK/mods (default C:\\Users\\b\\ZombiesDev\\archive\\mods) only. Extracted script text is the map author's:
it is parsed here in memory and never written anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "tools", "re"))
import ff_extract  # noqa: E402

MODS = os.path.join(os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive"), "mods")
DEFAULT_OUT = os.path.join(REPO, "web", "server", "data", "map-modes.json")

SCRIPT_EXT = (".gsc", ".csc", ".gsh")

# ---- known mechanisms -------------------------------------------------------------------
# UGX Mod 1.0.x (maps/ugxm_init.gsc, [UGX] Aidan). handle_vote() opens `ugxm_vote_host` on
# players[0] and `ugxm_vote_players` on everyone else, then waits on players[0]'s
# "voting_complete", which handle_vote_watcher() notifies on the response "start". The mode is
# the host's response before it: cl / gg / ar / ss / bh. Only the host's vote counts unless
# somebody picks "start_all". start_ugx_mod() ends with `level notify("ugxm_voting_complete")`.
# The allowed modes are the map's own ugxm_user_settings.gsc: set_gamemode("<mode>", true|false),
# which the menu reads as ugxm_allow_<mode>.
UGX_MODES = [
    # id, label, response, set_gamemode() keys that allow it, note
    ("classic", "Classic", "cl", ("classic",), "Stock zombies with the UGX weapons and perks."),
    ("gungame", "Gun Game", "gg", ("gungame",), "Every kill moves you to the next gun; no wall guns, box, perks cabinet or Pack-a-Punch."),
    ("arcademode", "Arcade Mode", "ar", ("arcademode",), "Classic plus UGX power-ups and boss rounds."),
    ("sharpshooter", "Sharpshooter", "ss", ("sharpshooter",), "Everyone's gun changes on a timer; 15-minute game; no buying."),
    ("bountyhunter", "Bounty Hunter", "bh", ("bountyhunter",), "Points race with a 15-minute limit."),
    # UGX Mod 1.1 only
    ("kingofthehill", "King of the Hill", "kh", ("kingofthehill",), "Two teams hold the hill; the map's own team picker shows in game for 15 seconds."),
    ("chaosmode", "Chaos Mode", "cm", ("chaos", "chaosmode"), "UGX's chaos rules with a time limit."),
]

# UGX Mod 1.1 ("Requiem"; ugxm_garage, ugxm_lostwoods, ...) reworked the vote: the host still
# gets `ugxm_vote_host`, everybody else gets `ugxm_save_settings_client` (never closed by the
# script), the watcher runs on players[0] but the script waits on `level waittill
# ("voting_complete")`, and "start" is ANY response beginning `ugx_` (the menu packs the host's
# own client preferences into it, e.g. `ugx_Hold_On_On_No`; the script reads only the prefix).
# Modes add kh / cm. Everything else (timed, mutators, game speed) stays at the map's defaults.
MECHANISMS = {
    "ugx_vote_1": {
        "label": "UGX Mod 1.0 game mode vote",
        "hide": ["ugxm_vote_host", "ugxm_vote_players"],
        "answer_menu": "ugxm_vote_host",
        "start": "start",
        "done": "ugxm_voting_complete",
    },
    "ugx_vote_11": {
        "label": "UGX Mod 1.1 game mode vote",
        "hide": ["ugxm_vote_host", "ugxm_save_settings_client"],
        "answer_menu": "ugxm_vote_host",
        "start": "ugx_start",
        "done": "ugxm_voting_complete",
    },
}

# What the scanner's `other` hits are, read by hand 2026-09-23 (game-modes.md). Keyed by script
# basename. None of these is answered automatically.
OTHER_NOTES = {
    "ugx_jukebox.gsc": "in game: the jukebox",
    "tom_music_player_unl.gsc": "in game: a music player",
    "trem_bank_2.gsc": "in game: the bank",
    "dukip_door.gsc": "in game: a door keypad",
    "ugx_elemental.gsc": "in game: UGX elemental skill tree",
    "ugxm_character.gsc": "only in UGX's separate customize-room map (no custom_character entity elsewhere)",
    "ugxm_customize_room.gsc": "only in UGX's separate customize-room map",
    "ugxm_kingofthehill.gsc": "UGX 1.1 King of the Hill: in-mode team picker, closes itself after 15 s",
    "ugxm_init.gsc": "UGX 1.1: `ugxm_save_settings_client` on non-host players -- hidden by ugx_vote_11",
    "_zmg_perks_system_functions.gsc": "in game: a perk shop",
    "_malibu_hall_of_armors.gsc": "in game: armour shop",
    "_malibu_magnificent_seven.gsc": "in game: a shop",
    "skillz_points_system.gsc": "in game: points shop",
    "nazi_zombie_tluh:weapon_loadout.gsc": "PER-PLAYER class pick at spawn (assault/medic/shotgun/special): each player's own choice, left in game",
    "ray_chirstmas_map:ray_chirstmas_map.gsc": "PER-PLAYER class pick at start (6 classes): each player's own choice, left in game",
    "nazi_zombie_fear_mc_2:_zombiemode_gamemode.gsc": "fear_mc_2: the mode is the FRONT-END dvar zomb_gamemode (0-7), never an in-game menu; "
                                "a dedicated server runs 0. The in-game menu here is the Deprived shop",
    "nazi_zombie_orbit:_zombiemode.gsc": "orbit: `mc_loadscreenorbit` on players[0] BLOCKS until any response; its gun game is the "
                       "FRONT-END dvar `gamemode`. Not a mode vote; see game-modes.md",
}

RE_OPENMENU = re.compile(r"""openmenu\s*\(\s*"([A-Za-z0-9_]+)"\s*\)""", re.I)
RE_OPENMENU_VAR = re.compile(r"""openmenu\s*\(\s*([A-Za-z_][A-Za-z0-9_.\[\]"]*)\s*\)""", re.I)
RE_MENURESP = re.compile(r"""waittill\s*\(\s*"menuresponse"\s*,""", re.I)
RE_CASE = re.compile(r"""case\s+"([^"]{1,40})"\s*:""")
RE_EQ = re.compile(r"""response\s*==\s*"([^"]{1,40})\"""", re.I)
RE_SET_GAMEMODE = re.compile(r"""set_gamemode\s*\(\s*"([a-z_]+)"\s*,\s*(true|false|1|0)\s*\)""", re.I)
RE_ZONE_HINT = re.compile(rb"menuresponse", re.I)
RE_LINE_COMMENT = re.compile(r"//[^\n]*")
RE_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def strip_comments(t: str) -> str:
    return RE_LINE_COMMENT.sub("", RE_BLOCK_COMMENT.sub("", t))


def read_scripts(mapdir: str):
    """{path: (text, source)} for every script the game would load, loose file winning."""
    out = {}
    ffs = sorted(f for f in os.listdir(mapdir) if f.lower().endswith(".ff"))
    for f in ffs:
        low = f.lower()
        if low.startswith("localized_") or low.endswith("_load.ff"):
            continue
        p = os.path.join(mapdir, f)
        try:
            zone = ff_extract.inflate_zone(p)
        except Exception as e:  # a broken or non-T4 fastfile is not our problem here
            print(f"  ! {f}: {e}", file=sys.stderr)
            continue
        if not RE_ZONE_HINT.search(zone):
            del zone
            continue
        for name, data in ff_extract.find_rawfiles(zone):
            n = name.replace("\\", "/").lower()
            if n.endswith(SCRIPT_EXT) and n not in out:
                out[n] = (data.decode("latin-1", "replace"), f)
        del zone
    # Loose files override fastfile rawfiles; among .iwds the later name wins.
    iwds = sorted(f for f in os.listdir(mapdir) if f.lower().endswith(".iwd"))
    for f in iwds:
        try:
            z = zipfile.ZipFile(os.path.join(mapdir, f))
        except Exception as e:
            print(f"  ! {f}: {e}", file=sys.stderr)
            continue
        for info in z.infolist():
            n = info.filename.replace("\\", "/").lower()
            if n.endswith(SCRIPT_EXT):
                try:
                    out[n] = (z.read(info).decode("latin-1", "replace"), f)
                except Exception:
                    pass
    return out


RE_V10 = re.compile(r"""players\[0\]\s+waittill\s*\(\s*"voting_complete"\s*\)""")
RE_V11 = re.compile(r"""prefix\s*==\s*"ugx_\"""")


def ugx_entry(scripts):
    init = scripts.get("maps/ugxm_init.gsc")
    if not init:
        return None
    t = strip_comments(init[0])
    if "ugxm_vote_host" not in t or "voting_complete" not in t:
        return None
    if RE_V11.search(t) and "ugxm_save_settings_client" in t:
        mechanism = "ugx_vote_11"
    elif RE_V10.search(t) and 'case "start"' in t:
        mechanism = "ugx_vote_1"
    else:
        return None   # a UGX we have not read: never answered blind
    # The responses this copy actually handles (a later UGX could rename them).
    handled = set(RE_CASE.findall(t))
    settings = scripts.get("maps/ugxm_user_settings.gsc")
    allowed = {}
    src = None
    if settings:
        src = f"{settings[1]}:maps/ugxm_user_settings.gsc"
        for mode, val in RE_SET_GAMEMODE.findall(strip_comments(settings[0])):
            allowed[mode.lower()] = val.lower() in ("true", "1")
    # Does the zombiemode the game will run actually call the vote? (it must, or nothing shows)
    zm = scripts.get("maps/_zombiemode.gsc")
    calls = bool(zm and "start_ugx_mod" in strip_comments(zm[0]))
    if not calls:
        return None   # the vote is never opened: offering modes would be offering nothing
    modes = []
    for mid, label, resp, keys, note in UGX_MODES:
        if resp not in handled:
            continue
        if allowed and not any(allowed.get(k, False) for k in keys):
            continue
        modes.append({"id": mid, "label": label, "response": resp, "note": note})
    if not modes:
        return None
    return {
        "mechanism": mechanism,
        "calls_vote": calls,
        "default": "classic" if any(m["id"] == "classic" for m in modes) else modes[0]["id"],
        "modes": modes,
        "options_off": sorted(k for k, v in allowed.items() if not v),
        "source": {"init": f"{init[1]}:maps/ugxm_init.gsc", "settings": src,
                   "zombiemode": f"{zm[1]}:maps/_zombiemode.gsc" if zm else None},
    }


def other_menus(scripts, mapname=""):
    """Every script that opens a menu and waits on menuresponse, excluding UGX's own vote."""
    hits = []
    for path, (text, src) in sorted(scripts.items()):
        t = strip_comments(text)
        if not RE_MENURESP.search(t):
            continue
        names = sorted(set(RE_OPENMENU.findall(t)))
        if path == "maps/ugxm_init.gsc":
            names = [n for n in names if n not in ("ugxm_vote_host", "ugxm_vote_players", "ugxm_save_settings_client")]
            if not names:
                continue
        if not names and not RE_OPENMENU_VAR.search(t):
            continue
        responses = sorted(set(RE_CASE.findall(t)) | set(RE_EQ.findall(t)))[:40]
        hits.append({"script": f"{src}:{path}", "menus": names, "responses": responses,
                     "note": OTHER_NOTES.get(f"{mapname}:{os.path.basename(path)}") or OTHER_NOTES.get(os.path.basename(path))})
    return hits


def scan(only=None):
    maps = sorted(d for d in os.listdir(MODS) if os.path.isdir(os.path.join(MODS, d)))
    if only:
        maps = [m for m in maps if m in only]
    catalogue, others, stats = {}, {}, {"maps": 0, "ugx": 0, "other": 0}
    for i, m in enumerate(maps, 1):
        t0 = time.time()
        stats["maps"] += 1
        scripts = read_scripts(os.path.join(MODS, m))
        ugx = ugx_entry(scripts)
        if ugx:
            catalogue[m] = ugx
            stats["ugx"] += 1
        oth = other_menus(scripts, m)
        if oth:
            others[m] = oth
            stats["other"] += 1
        tag = "UGX" if ugx else ("other" if oth else "-")
        print(f"[{i}/{len(maps)}] {m}: {len(scripts)} scripts, {tag} ({time.time() - t0:.1f}s)", file=sys.stderr)
    return catalogue, others, stats


def table(catalogue, others) -> str:
    rows = ["| Map | Menu | Options (response) | Mechanism |", "|---|---|---|---|"]
    for m, e in sorted(catalogue.items()):
        opts = ", ".join(f"{x['label']} (`{x['response']}`)" for x in e["modes"])
        mech = MECHANISMS[e["mechanism"]]
        menus = ", ".join(f"`{x}`" for x in mech["hide"])
        rows.append(f"| {m} | {menus} | {opts} | {e['mechanism']}: server answers `{mech['answer_menu']}` with the mode then `{mech['start']}`, confirms on `{mech['done']}` |")
    for m, hs in sorted(others.items()):
        for h in hs:
            rows.append(f"| {m} | {', '.join('`'+n+'`' for n in h['menus']) or '(variable)'} | {', '.join(h['responses'][:12]) or '?'} | not answered: {h.get('note') or 'UNREAD'} (`{h['script']}`) |")
    return "\n".join(rows)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--table", action="store_true")
    a = ap.parse_args(argv)
    catalogue, others, stats = scan(set(a.only) if a.only else None)
    doc = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generator": "archive/scan_modes.py",
        "mechanisms": MECHANISMS,
        "maps": catalogue,
        "other": others,
        "stats": stats,
    }
    if not a.only:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(doc, f, indent=1, sort_keys=True)
            f.write("\n")
        print(f"wrote {a.out}: {stats}", file=sys.stderr)
    else:
        print(json.dumps(doc, indent=1, sort_keys=True))
    if a.table:
        print(table(catalogue, others))
    return 0


if __name__ == "__main__":
    sys.exit(main())
