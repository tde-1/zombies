#!/usr/bin/env python3
"""Easter egg / main quest / power / song guides, read out of what the archive already holds.

B (2026-09-23): "Figure out a way to explain Easter eggs. Through the stuff we archive there
might be sections or guides ... Find the Easter egg steps for as many maps as you can."

This makes NO requests. It reads, from disk only:

  cache/callofdutyrepo.com/   the release posts crawl pass C fetched (the author's own text,
                              reposted by the site; `maps.author` is the map's creator)
  cache/www.ugx-mods.com/     the release threads `fetch_ugx_threads.py` fetched — EVERY post
                              on the cached page, each with its own poster, because a reply
                              that answers "how do I do the EE?" is a guide too
  cache/www.moddb.com/        the addon pages
  catalogue.sqlite            archive.org item descriptions (their line breaks are gone, so
                              only the one-line forms can match there)
  extract/<norm>/, mods/<bsp>/  readme.txt / *.txt / *.md / *.rtf shipped inside a release
                              (PDF text is read if `pypdf` is installed; it is not, today)

and writes `reports/map_guides.json`, which `web/server/db/import-archive.js --guides` loads
into the site's `map_guides` table.

What counts as a guide is a heuristic, and it says so. A release post is mostly a FEATURE
LIST ("Easter Egg", "Buyable Ending", "Soul Boxes") and a feature list is not a guide: the
test that separates them is whether the lines under the heading are INSTRUCTIONS — an
imperative verb ("Shoot the three skulls", "Hold F on the bears"), a number ("Step 3:"), a
place. Each guide gets a confidence in [0, 1] from what it was built out of (the heading,
how many steps, how many of them are instructions, whether they are numbered) and only
medium and up (>= 0.45) are written. The low ones are counted, not shipped.

Copyright (ip-posture.md): the text is the community's, quoted with the author's handle and a
link back to where it was posted; nothing of Activision's is read or written. Steps are
capped in number and length so a guide is a quotation, never a copy of a whole post.

    python archive/easter_eggs.py              write reports/map_guides.json
    python archive/easter_eggs.py --print      and print every guide kept
    python archive/easter_eggs.py --low        print the rejected ones too (for tuning)
    python archive/easter_eggs.py --selftest   the extractor on fixed cases (web/test/guides.js runs it)
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
CACHE = os.environ.get("ENW_ARCHIVE_CACHE", os.path.join(WORK, "cache"))
DB = os.environ.get("ENW_ARCHIVE_DB", os.path.join(WORK, "catalogue.sqlite"))
OUT = os.path.join(WORK, "reports", "map_guides.json")
MANIFESTS = os.path.join(HERE, "manifests")

KEEP = 0.45          # medium and up
HIGH = 0.70
MAX_STEPS = 24
MAX_STEP_CHARS = 420
MAX_BLOCK_LINES = 45


# ------------------------------------------------------------------ text out of HTML
def decode(raw: bytes) -> str:
    for e in ("utf-8", "cp1252"):
        try:
            return raw.decode(e)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", "replace")


def to_lines(h: str) -> list[str]:
    """HTML to lines, keeping the line structure a guide lives in (li, br, p)."""
    h = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", h)
    h = re.sub(r"(?is)<!--.*?-->", " ", h)
    h = re.sub(r"(?i)<br\s*/?>", "\n", h)
    h = re.sub(r"(?i)</?(p|div|li|h[1-6]|tr|ul|ol|blockquote|dd|dt|table|section)\b[^>]*>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = html.unescape(h).replace("\xa0", " ").replace("\u200b", "")
    h = re.sub(r"\[/?(?:b|i|u|size|color|center|img|url|spoiler|quote|font)[^\]]*\]", " ", h, flags=re.I)
    out = []
    for ln in h.split("\n"):
        ln = re.sub(r"[ \t\r\f\v]+", " ", ln).strip()
        if ln:
            out.append(ln)
    return out


def cache_path(url: str) -> str:
    h = hashlib.sha1(("GET " + url).encode()).hexdigest()
    host = url.split("/")[2].lower().replace(":", "_")
    return os.path.join(CACHE, host, h + ".bin")


def cached(url: str):
    p = cache_path(url)
    if not os.path.exists(p):
        return None
    with open(p, "rb") as fh:
        return decode(fh.read())


# ------------------------------------------------------------------ the heuristics
VERBS = set("""
shoot find go head press hold knife melee collect gather buy purchase turn activate build craft
pick grab bring take kill fill feed use get hit interact place put open enter look search walk
stand throw charge complete destroy follow return wait survive defend obtain upgrade locate
unlock reach insert plant climb jump drop give offer spin ride teleport link solve inspect
examine listen answer lure protect escort carry deliver repair fix flip pull push input type
dial match light ignite burn freeze align rotate touch crouch prone sprint trigger check clear
defeat beat begin repeat hack pay recharge afford navigate kill revive capture keep dodge
stay avoid spend leave board dive slide play
""".split())
MODAL = re.compile(r"\b(?:you|then|and|must|need to|have to|should|can|will need to|to)\s+([a-z]+)\b", re.I)
LEAD_OK = re.compile(r"^(then|now|next|once|after|when|first|finally|lastly|you (?:need to|must|have to|should|can|will need to)|make sure)\b", re.I)
NUMBERED = re.compile(r"^\(?(?:step\s*)?(\d{1,2})\s*[\.\):\-–—]\s*|^step\s*(\d{1,2})\b\s*[\.\):\-–—]?\s*", re.I)
BULLET = re.compile(r"^[\-–—•*>·~+]+\s*")
# "APPEASE THE BOXES – Fill all 6 soul boxes": a titled step. The title goes, the
# instruction stays.
CAPS_TITLE = re.compile(r"^(?:\*([^*]{3,40})\*|([A-Z0-9][A-Z0-9 '’/&!?]{3,60}))\s*[–—:-]\s+(?=\S)")
PLACE = re.compile(r"\b(behind|under(?:neath)?|next to|near|inside|outside|above|below|beside|across from|room|spawn|door|wall|roof|stairs|corner|table|shelf|window|box|machine|perk|bunker|lab|building)\b", re.I)

STOP_HEAD = re.compile(
    r"^(credits?|thanks|special thanks|thank you|features?|main features|screenshots?|videos?|pictures?|gallery|"
    r"known (?:issues|bugs)|bugs?|updates?|update log|change ?log|changes|fixes|patch(?: notes)?|v?\d+(?:\.\d+)+\b.*|"
    r"downloads?|direct download|mediafire|mega|installation|install|how to install|requirements|story|description|"
    r"weapons?(?: list)?|perks?(?: list)?|about|notes?|disclaimer|info|information|contact|links?|categories.*|tags.*|"
    r"subscribe|please login.*|leave a reply|comments?|related|recent posts|follow us|post navigation|download link|"
    r"mirror|enjoy.*|have fun.*|good luck.*)\b[^a-z]{0,3}.{0,40}$",
    re.I,
)

KIND_PATTERNS = [
    # (kind, heading regex) — order matters: the first match names the guide.
    ("power", re.compile(r"\b(turn(?:ing)?\s+on\s+(?:the\s+)?power|power\s+(?:switch|on|guide|steps?)|restore\s+(?:the\s+)?power|how\s+to\s+(?:get|turn\s+on)\s+(?:the\s+)?power)\b", re.I)),
    ("song", re.compile(r"\b(songs?|music\s+(?:ee|easter)|musical\s+easter|ee\s+songs?)\b", re.I)),
    ("ending", re.compile(r"\b(buyable\s+ending|escape\s+(?:route|ending|the\s+map)|how\s+to\s+(?:end|escape|win|complete\s+the\s+map|beat\s+the\s+map|finish\s+the\s+map)|(?:strategy|how)\s+to\s+(?:defeat|beat|survive)\s+(?:this|the)\s+map|end(?:ing)?\s+steps)\b", re.I)),
    ("other", re.compile(r"\b(side\s+(?:ee|easter|quest)|pack[\s-]*a[\s-]*punch\s+(?:unlock|easter|ee|quest|steps?)|(?:unlock|open)(?:ing)?\s+(?:the\s+)?(?:pack[\s-]*a[\s-]*punch|pap)|pap\s+(?:unlock|ee|quest|steps?)|optional\s+objectives?|mini\s+(?:ee|easter)|small\s+(?:ee|easter)|wonder\s*weapon\s+(?:quest|steps?|build)|staffs?|buildables?)\b", re.I)),
    ("easter_egg", re.compile(r"\b(easter[\s-]*eggs?|main\s+(?:ee|quest|easter|objectives?|story)|ee|quest)\b|^\W*objectives\W*$", re.I)),
    ("other", re.compile(r"\b(guide|walkthrough|how\s+to\s+(?:unlock|get|open|build|obtain|find|activate))\b", re.I)),
]
GUIDEY = re.compile(r"\b(steps?|guide|walkthrough|how\s+to|tutorial|hints?|objectives?|instructions?|spoilers?|quest|strategy)\b", re.I)
# An anchor inside a changelog or a credits list is not a guide ("Fixed minor Easter Egg
# bugs", "Rorke for in game objective system", "Teddy Bear Easter Egg - Cristian_M").
NOT_ANCHOR = re.compile(r"\b(fix(?:ed|es)?|bugs?|glitch(?:es)?|added|removed|improved|changed|updated|thanks?|credits?|scripts?|scripted|scripting|made\s+by|help(?:ed)?\s+with|prefabs?|video|youtube|coming\s+soon|no\s+(?:big\s+)?easter)\b|\s[–—-]\s*[A-Za-z0-9_.]+\s*$|\bfor\s+(?:the|his|her|their|in|making|helping)\b", re.I)

REWARDS = [
    (re.compile(r"\b(end(?:s|ing)?\s+the\s+game|game\s+end|ending|escape|win(?:s|ning)?\s+the\s+game|end\s*game|beat\s+the\s+map)\b", re.I), "The ending"),
    (re.compile(r"\b(song|music|plays?\s+a\s+track)\b", re.I), "A song"),
    (re.compile(r"\b(pack[\s-]*a[\s-]*punch|\bpap\b)\b", re.I), "Pack-a-Punch"),
    (re.compile(r"\b(perk\s+slots?|more\s+than\s+\d\s+perks|extra\s+perks?)\b", re.I), "Perk slots"),
    (re.compile(r"\b(free\s+perk|all\s+perks|perma[\s-]*perks?|new\s+perk)\b", re.I), "A perk"),
    # A perk's NAME is a prize in a heading ("How to unlock Widow's Wine") and usually a
    # place in a step ("next to PHD Flopper"); reward_of() reads it in headings only.
    (PERK_NAMES := re.compile(r"\b(widow'?’?s\s+wine|electric\s+cherry|mule\s+kick|juggernog|jugg|stamin[\s-]*up|phd|deadshot|double\s+tap|quick\s+revive|speed\s+cola|who'?s\s+who|tombstone|vulture|wunderfizz)\b", re.I), "A perk"),
    (re.compile(r"\b(wonder\s*weapon|ray\s*gun|thunder\s*gun|wunderwaffe|staffs?|blundergat|monkey\s+bombs?|free\s+(?:gun|weapon)|a\s+weapon)\b", re.I), "A weapon"),
    # "1,000 points" is a prize; "the other 10 points" (Escher's Secure Points) is not
    (re.compile(r"\b(\d[\d,]{2,}\s*points|free\s+points|money|cash)\b", re.I), "Points"),
    (re.compile(r"\b(turn(?:s|ing)?\s+on\s+the\s+power|power\s+is\s+on)\b", re.I), "The power"),
]
DEFAULT_REWARD = {"power": "The power", "song": "A song", "ending": "The ending"}

TITLE = {"easter_egg": "Main quest", "power": "Power", "song": "Song", "ending": "Ending", "other": "Side quest"}


def strip_prefix(s: str):
    """Numbering, bullets and a CAPS title off the front. Returns (text, numbered, title)."""
    numbered = False
    title = None
    s = s.strip()
    s = re.sub(r"^\(optional\)\s*", "", s, flags=re.I)
    m = re.match(r"^\*([^*]{3,40})\*\s*[\u2013\u2014:-]\s+(?=\S)", s)
    if m:
        return s[m.end():].strip(), False, m.group(1).strip()
    m = NUMBERED.match(s)
    if m:
        numbered = True
        s = s[m.end():]
    else:
        s = BULLET.sub("", s)
        m = NUMBERED.match(s)
        if m:
            numbered = True
            s = s[m.end():]
    m = CAPS_TITLE.match(s)
    if m and not re.fullmatch(r"[A-Z0-9 ]{1,3}", (m.group(1) or m.group(2)).strip()):
        title = (m.group(1) or m.group(2)).strip()
        title = title.title() if title.isupper() else title
        s = s[m.end():]
    return s.strip(), numbered, title


def first_word(s: str) -> str:
    m = re.match(r"[\"'“(]*([A-Za-z][A-Za-z'-]*)", s)
    return m.group(1).lower() if m else ""


def is_instruction(s: str) -> float:
    """1.0 an imperative ("Shoot the ..."), 0.6 an instruction in other words, 0 a noun phrase."""
    w = first_word(s)
    if w in VERBS:
        return 1.0
    words = re.findall(r"[a-z]+", s.lower())[:12]
    if LEAD_OK.match(s) and any(x in VERBS for x in words[1:]):
        return 0.8
    for m in MODAL.finditer(s[:160]):
        if m.group(1).lower() in VERBS:
            return 0.6
    for sent in re.split(r"(?<=[.!?])\s+", s[:400])[1:]:
        if first_word(sent) in VERBS:
            return 0.6
    # "It'll lead you to the sewer, head down to the biggest area"
    for m in re.finditer(r"[,;]\s*(?:and\s+|then\s+)?([a-z]+)", s[:200], re.I):
        if m.group(1).lower() in VERBS:
            return 0.6
    return 0.0


DETERMINER = re.compile(r"^\W*[A-Za-z'-]+\s+(?:the|all|a|an|each|every|both|your|this|that|these|those|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b", re.I)


def strong_imperative(s: str) -> bool:
    """"Shoot the three skulls" / "Shoot Mannequins to unlock the teleporter", not "Open Map"."""
    if first_word(s) not in VERBS:
        return False
    if DETERMINER.match(s):
        return True
    return any(m.group(1).lower() in VERBS for m in MODAL.finditer(s[:200]))


def kind_of(line: str):
    for kind, rx in KIND_PATTERNS:
        if rx.search(line):
            return kind
    return None


def is_heading(line: str) -> bool:
    s = line.strip()
    if len(s) > 110:
        return False
    body = BULLET.sub("", s)
    if s.endswith(":") or s.endswith(":)") or re.search(r"[:=\-–]{1}\s*$", s):
        return True
    if GUIDEY.search(s):
        return True
    letters = re.sub(r"[^A-Za-z]", "", body)
    if len(letters) >= 6 and letters.isupper():
        return True
    # "Easter Eggs" / "Easter Egg Guide" alone on a line
    return len(body.split()) <= 5 and is_instruction(body) == 0.0


def is_stop(line: str) -> bool:
    s = BULLET.sub("", line.strip()).strip()
    return len(s) <= 60 and bool(STOP_HEAD.match(s)) and not GUIDEY.search(s)


def reward_of(kind: str, heading: str, text: str, tail: str = ""):
    """What finishing it gets you, or None when the guide does not say.

    The heading says it best ("how to unlock pap"). Then an ending anywhere in the steps,
    because a guide that ends the game says so somewhere. Then the LAST steps only, because
    a reward named halfway through is a means, not the end (Escher's quest Pack-a-Punches a
    Ray Gun on step 2 and is not a Pack-a-Punch quest) — and there a perk's NAME does not
    count, since "next to PHD Flopper" is a place, not a prize. Unknown stays unknown."""
    if kind in ("power", "song", "ending"):
        return DEFAULT_REWARD[kind]
    h = heading or ""
    if re.search(r"\bjump\s*scares?\b", h, re.I):
        return "A jumpscare"
    for rx, label in REWARDS:
        if rx.search(h):
            return label
    if REWARDS[0][0].search(text):
        return REWARDS[0][1]
    for rx, label in REWARDS:
        if label == "A perk" and rx is PERK_NAMES:
            continue
        if rx.search(tail):
            return label
    return None


def score(steps, heading, numbered_n, kind):
    n = len([s for s in steps if not s.get("head")])
    if n == 0:
        return 0.0, {}
    inst = [s["_inst"] for s in steps if not s.get("head")]
    frac = sum(inst) / n
    places = sum(1 for s in steps if PLACE.search(s["text"])) / n
    ev = {
        "steps": n,
        "instruction_ratio": round(frac, 2),
        "numbered": numbered_n,
        "guide_heading": bool(heading and GUIDEY.search(heading)),
        "kind_heading": bool(heading and kind_of(heading)),
    }
    c = 0.0
    c += 0.15 if ev["kind_heading"] else 0.0
    c += 0.15 if ev["guide_heading"] else 0.0
    c += 0.30 if n >= 3 else 0.22 if n == 2 else 0.12
    c += 0.30 * frac
    c += 0.10 if numbered_n >= 2 else 0.0
    c += 0.05 * places
    if heading and re.search(r"\bhints?\b", heading, re.I):
        c -= 0.05           # a riddle is not a walkthrough
    if frac < 0.34:
        c -= 0.30           # a feature list under an "Easter Egg" heading
    if n == 1 and frac < 1.0:
        c -= 0.15
    # One line under a bare feature heading ("Buyable Ending" / "Open Map") is a feature
    # list's line, not a guide, unless it is unmistakably an instruction.
    real = [s for s in steps if not s.get("head")]
    ev["single_strong"] = n == 1 and strong_imperative(real[0]["text"])
    if n == 1 and not ev["guide_heading"] and not ev["single_strong"]:
        c -= 0.25
    return max(0.0, min(1.0, round(c, 2))), ev


def extract(lines: list[str]):
    """Every candidate guide in one document's lines."""
    found = []
    i = 0
    used = set()
    while i < len(lines):
        ln = lines[i]
        kind = kind_of(ln) if len(ln) <= 110 else None
        if kind and is_heading(ln) and not is_stop(ln) and not NOT_ANCHOR.search(ln):
            g, j = collect(lines, i + 1, kind, ln)
            if g:
                found.append(g)
                used.update(range(i, j))
                i = j
                continue
        i += 1
    # One-line forms, anywhere not already inside a block:
    #   "Easter Egg Song: Hold F on all 3 teddy bears hidden in the map to activate the song!"
    #   "To turn on the power, shoot the ..."
    for k, ln in enumerate(lines):
        if k in used or len(ln) > MAX_STEP_CHARS:
            continue
        m = re.match(r"^[\-–—•*>\s]*([^:]{3,60}):\s*(.{12,})$", ln)
        head, rest = (m.group(1), m.group(2)) if m else (None, None)
        if head and kind_of(head) and is_instruction(rest) >= 1.0:
            kind = kind_of(head)
            steps = [{"text": clip(rest), "_inst": 1.0}]
            c, ev = score(steps, head, 0, kind)
            found.append(guide(kind, head, steps, c, ev, ln))
            continue
        # "To turn on the power, activate the 5 generators in the map."
        # "To get the ending unlocked, activate all of the face punches."
        m = re.search(r"^[\W\d]*(?:in\s+order\s+)?to\s+((?:turn\s+on|activate|restore|get|unlock|open|start|beat|complete|do|trigger|hear|play|access|reach)\s+[^,.;:]{3,60}?)\s*(?:[,:]|\s(?=you\s+(?:need|must|have|should)\b))\s*(.{12,})", ln, re.I)
        # "Shoot three teddy bears to access Pack-a-Punch" / "Find 8 teddy bears to open up packa punch"
        m2 = None if m else re.match(r"^[\-\u2013\u2014\u2022*>\s]*((?:%s)\b.{6,120}?)\s+to\s+((?:access|unlock|open(?:\s+up)?|activate|get|turn\s+on|play|hear)\s+[^.!]{3,60})(?:[.!].*)?$" % "|".join(sorted(VERBS)), ln, re.I)
        if m2:
            class _M:
                def __init__(self, g, i):
                    self._g, self._i = g, i
                def group(self, n):
                    return self._g if n == 1 else self._i
            m = _M(m2.group(2).rstrip(".!"), m2.group(1) + " to " + m2.group(2).rstrip(".!"))
        rest = None
        if m:
            rest = re.sub(r"^you\s+(?:will\s+)?(?:need|must|have|should)\s+(?:to\s+)?", "", m.group(2).strip(), flags=re.I)
            rest = rest[:1].upper() + rest[1:]
        if rest and strong_imperative(rest) and not re.search(r"(?i)(below|above|following)\s*:?$|:$", rest):
            goal = m.group(1)
            kind = kind_of(goal) or ("power" if re.search(r"\bpower\b", goal, re.I) else
                                    "ending" if re.search(r"\b(ending|end\s*game|escape)\b", goal, re.I) else
                                    "other" if re.search(r"\b(pack[\s-]*a[\s-]*punch|packa\s*punch|pap|perk|wonder|secret|room)\b", goal, re.I) else None)
            if kind:
                head = "How to " + re.sub(r"\s+(?:only|too|as\s+well)$", "", goal.strip(), flags=re.I)
                steps = [{"text": clip(rest), "_inst": 1.0}]
                c, ev = score(steps, head, 0, kind)
                g = guide(kind, head, steps, c, ev, ln)
                if kind == "other" and g["reward"] == "Pack-a-Punch":
                    g["title"] = "Pack-a-Punch"
                found.append(g)
    return found


def clip(s: str) -> str:
    s = s.strip()
    return s if len(s) <= MAX_STEP_CHARS else s[: MAX_STEP_CHARS - 1].rsplit(" ", 1)[0] + "…"


END_PROSE = re.compile(r"^(besides|also,|p\.?s\.?\b|enjoy|have fun|good luck|hope\b|i hope|i will|i'll|i'm|i am|thank)", re.I)
STEP_WORD = re.compile(r"^[\-–—•*>\s]*step\s*\d", re.I)


def collect(lines, start, kind, heading):
    """The steps under one heading, until the next section starts.

    Four shapes are handled, all seen in the corpus: a numbered list ("1. shoot the pink
    light"), "Step N:" lines with bullet sub-lines under each (the sub-lines are the step's
    details), a titled list ("APPEASE THE BOXES - Fill all 6 soul boxes"), and plain
    instruction lines, including one sentence broken over two lines.
    """
    steps = []
    numbered_n = 0
    j = start
    detail_mode = False
    step_mode = False
    skip = 6 if GUIDEY.search(heading or "") else 1
    while j < len(lines) and j - start < MAX_BLOCK_LINES and len(steps) < MAX_STEPS:
        raw = lines[j]
        if is_stop(raw):
            break
        k2 = kind_of(raw) if len(raw) <= 110 else None
        text, numbered, title = strip_prefix(raw)
        if not text and title:
            text, title = title, None
        inst = is_instruction(text)
        # A new guide heading ends this one; a sub-heading of the same kind that carries no
        # instruction is kept as a label inside it.
        if k2 and is_heading(raw) and not numbered and not NOT_ANCHOR.search(raw) and (
                inst == 0.0 or (inst < 1.0 and raw.rstrip().endswith(":") and len(raw) <= 60)):
            if steps and (k2 != kind or GUIDEY.search(raw)):
                break
            if steps:
                steps.append({"text": clip(text.rstrip(":").strip()), "head": True, "_inst": 0})
            j += 1
            continue
        if not steps:
            if not numbered and inst < 0.8 and not title:
                # Prose right after the heading ("I will be making a video soon...") is
                # skipped for a line or three; a heading followed by nothing instructive is
                # not a guide.
                if j - start >= skip:
                    break
                j += 1
                continue
        else:
            prev = steps[-1]
            # "Step N:" lists: everything that is not the next "Step" is this step's detail.
            if step_mode and not STEP_WORD.match(raw) and not prev.get("head"):
                prev.setdefault("details", []).append(clip(text))
                j += 1
                continue
            # A list the previous step introduced ("Their locations are as follows:").
            if END_PROSE.match(text):
                break
            if detail_mode and inst < 0.8 and not title and len(text) <= MAX_STEP_CHARS:
                prev.setdefault("details", []).append(clip(text))
                j += 1
                continue
            # One sentence broken over two lines.
            if not prev.get("head") and not numbered and not title and (
                    prev["text"].endswith(",") or (text[:1].islower() and not re.search(r"[.!?)]$", prev["text"]))):
                prev["text"] = clip(prev["text"] + " " + text)
                j += 1
                continue
            if inst == 0.0 and not numbered and not title:
                if text.endswith(":") and len(text) <= 40:
                    steps.append({"text": clip(text.rstrip(":")), "head": True, "_inst": 0})
                    j += 1
                    continue
                if PLACE.search(text) and len(text) <= 160 and not prev.get("head"):
                    steps.append({"text": clip(text), "_inst": 0.3})
                    j += 1
                    continue
                break
        if numbered:
            numbered_n += 1
        if STEP_WORD.match(raw):
            step_mode = True
        st = {"text": clip(text), "_inst": inst if inst else (0.5 if numbered or title else 0)}
        if title:
            st["label"] = title
        steps.append(st)
        detail_mode = text.endswith(":")
        j += 1
    while steps and steps[-1].get("head"):
        steps.pop()
    if not steps:
        return None, j
    c, ev = score(steps, heading, numbered_n, kind)
    return guide(kind, heading, steps, c, ev, heading), j


def guide(kind, heading, steps, conf, ev, context):
    real = [s for s in steps if not s.get("head")]
    ctx = " ".join([s["text"] + " " + " ".join(s.get("details", [])) for s in real])
    tail = " ".join([s["text"] + " " + " ".join(s.get("details", [])) for s in real[-2:]])
    clean = []
    for s in steps:
        o = {"text": s["text"]}
        if s.get("head"):
            o["head"] = True
        if s.get("label"):
            o["label"] = s["label"]
        if s.get("details"):
            o["details"] = s["details"][:8]
        clean.append(o)
    title = TITLE[kind]
    h = BULLET.sub("", (heading or "")).strip().rstrip(":-–= ").strip()
    if h and 3 <= len(h) <= 48 and not re.fullmatch(r"(?i)easter\s*eggs?|ee|power|songs?|hints?", h):
        title = re.sub(r"\s*\((?:spoilers?)\)\s*$", "", h, flags=re.I).strip("*!. ")
        title = title[:1].upper() + title[1:]
        if title.isupper():
            title = title.title()
    return {
        "kind": kind,
        "title": title,
        "heading": h or None,
        "reward": reward_of(kind, heading, ctx, tail),
        "steps": clean,
        "confidence": conf,
        "evidence": ev,
    }


# ------------------------------------------------------------------ the sources
def body_codrepo(t: str) -> list[str]:
    i = t.find('<div class="entry-content">')
    if i < 0:
        return []
    body = t[i:]
    ends = [body.find(x) for x in ("entry-footer", "wpdiscuz", "cat-links", "<footer", "sharedaddy", "post-navigation")]
    ends = [e for e in ends if e > 0]
    body = body[: min(ends)] if ends else body[:60000]
    return to_lines(body)


POST_SPLIT = "message_block_container postedItem"


def posts_ugx(t: str):
    """(poster, permalink, lines) per post on a cached SMF thread page."""
    out = []
    for chunk in t.split(POST_SPLIT)[1:]:
        um = re.search(r'class="username">.*?<a [^>]*>([^<]+)</a>', chunk, re.S)
        pm = re.search(r'href="(https://www\.ugx-mods\.com/forum/[^"#]+#msg\d+)"', chunk)
        i = chunk.find('class="post post-type-post"')
        if i < 0:
            continue
        e = chunk.find("message_block_bottom", i)
        body = chunk[i: e if e > 0 else i + 80000]
        body = re.sub(r'(?is)<div class="signature".*$', "", body)
        # quoted text is somebody else's post; it would be attributed to the wrong person
        body = re.sub(r'(?is)<blockquote\b.*?</blockquote>', " ", body)
        out.append((html.unescape(um.group(1)).strip() if um else None, pm.group(1) if pm else None, to_lines(body)))
    return out


def body_moddb(t: str) -> list[str]:
    for marker in ('id="readarticle"', 'class="body"', 'id="profiledescription"'):
        i = t.find(marker)
        if i > 0:
            return to_lines(t[i: i + 40000])[:400]
    m = re.search(r'<meta property="og:description" content="([^"]*)"', t)
    return to_lines(m.group(1)) if m else []


TEXT_EXT = (".txt", ".md", ".rtf", ".nfo")
SKIP_DIR = re.compile(r"(?i)[\\/](english|localizedstrings|sound|soundaliases|maps|weapons|xanim|xmodel|images|materials|fx|mp|animtrees|character|clientscripts|ui|ui_mp|vision|shock|rumble|aitype|raw)[\\/]")


def readmes(root: str):
    if not os.path.isdir(root):
        return
    for d in sorted(os.listdir(root)):
        base = os.path.join(root, d)
        for dp, dn, fn in os.walk(base):
            if SKIP_DIR.search(dp + os.sep):
                dn[:] = []
                continue
            for f in fn:
                low = f.lower()
                p = os.path.join(dp, f)
                if low.endswith(TEXT_EXT) and os.path.getsize(p) < 400_000:
                    with open(p, "rb") as fh:
                        yield d, p, [x.strip() for x in decode(fh.read()).splitlines() if x.strip()]
                elif low.endswith(".pdf"):
                    try:
                        import pypdf  # noqa: F401  optional
                    except ImportError:
                        yield d, p, None
                        continue
                    try:
                        r = pypdf.PdfReader(p)
                        txt = "\n".join((pg.extract_text() or "") for pg in r.pages[:40])
                        yield d, p, [x.strip() for x in txt.splitlines() if x.strip()]
                    except Exception:
                        yield d, p, None


# ------------------------------------------------------------------ keys
def site_keys():
    """norm -> the site key(s) a guide for it may attach to, most specific first."""
    bsp_of = {}
    manifests = {f[:-5] for f in os.listdir(MANIFESTS) if f.endswith(".json")} if os.path.isdir(MANIFESTS) else set()
    try:
        with open(os.path.join(WORK, "reports", "extract.json"), encoding="utf-8") as fh:
            for r in json.load(fh):
                for m in r.get("mods") or []:
                    b = m.get("bsp") or m.get("map")
                    if b and b in manifests:
                        bsp_of.setdefault(r["norm"], b)
    except (OSError, ValueError):
        pass
    return bsp_of


SELFTEST = [
    # (lines, the kinds that must be kept at >= KEEP; anything else kept is a failure)
    (["Easter Egg Steps:", "Step 1: Link all the teleporters", "Step 2: Shoot the three skulls behind spawn",
      "Step 3: Buy the ending in the cellar", "Credits:", "Someone - scripts"], {"easter_egg"}),
    (["Features:", "Easter Egg", "Buyable Ending", "Soul Boxes", "Custom weapons"], set()),
    (["Buyable Ending", "Open Map [lots of running space]"], set()),
    (["1.To turn on the power, activate the 5 generators in the map."], {"power"}),
    (["Changelog:", "Fixed Easter Egg bugs", "- Shoot the bear works again"], set()),
    (["- Easter Egg Song: Hold F on all 3 teddy bears in the map to play the song!"], {"song"}),
    (["How to unlock Pack-a-Punch:", "1. Shoot the pink light in the tower", "2. Find all 6 parts",
      "3. Bring them to the monkey statue"], {"other"}),
    (["Credits", "Rorke for in game objective system", "AwesomePieMan For the latest feature play to find out"], set()),
]


def selftest() -> int:
    bad = 0
    for i, (lines, want) in enumerate(SELFTEST):
        got = {g["kind"] for g in extract(lines) if g["confidence"] >= KEEP}
        ok = got == want
        bad += not ok
        print("%s  case %d: want %s, got %s" % ("ok  " if ok else "FAIL", i, sorted(want), sorted(got)))
    print("selftest: %d of %d" % (len(SELFTEST) - bad, len(SELFTEST)))
    return 1 if bad else 0


def clean_author(a):
    """codrepo's byline parse leaves the version in ("oshawat750 Version: 1.0.1")."""
    if not a:
        return None
    a = re.sub(r"\s+Version\s*:.*$", "", str(a), flags=re.I).strip(" -–")
    return a or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true")
    ap.add_argument("--low", action="store_true")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--selftest", action="store_true", help="run the extractor on fixed cases and exit")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    if a.selftest:
        sys.exit(selftest())

    db =sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    bsp_of = site_keys()
    names = {}
    cands = []   # (norm, source dict, guide)
    scanned = {"callofdutyrepo.com": 0, "ugx-mods.com": 0, "ugx-mods.com posts": 0, "moddb.com": 0,
               "archive.org": 0, "readmes": 0, "pdf_unread": 0}

    def add(norm, src, lines):
        for g in extract(lines):
            cands.append((norm, src, g))

    for r in db.execute("SELECT norm, name, source, source_url, author, description, extra FROM maps"):
        names.setdefault(r["norm"], r["name"])
        url = r["source_url"]
        if r["source"] == "codrepo" and url:
            t = cached(url)
            if t:
                scanned["callofdutyrepo.com"] += 1
                add(r["norm"], {"url": url, "site": "callofdutyrepo.com", "author": r["author"]}, body_codrepo(t))
        elif r["source"] == "ugx" and url:
            t = cached(url)
            if t:
                scanned["ugx-mods.com"] += 1
                for poster, link, lines in posts_ugx(t):
                    scanned["ugx-mods.com posts"] += 1
                    add(r["norm"], {"url": link or url, "site": "ugx-mods.com", "author": poster}, lines)
        elif r["source"] == "moddb" and url:
            t = cached(url)
            if t:
                scanned["moddb.com"] += 1
                add(r["norm"], {"url": url, "site": "moddb.com", "author": r["author"]}, body_moddb(t))
        elif r["source"] == "archive.org" and r["description"]:
            scanned["archive.org"] += 1
            add(r["norm"], {"url": url, "site": "archive.org", "author": r["author"]},
                [x for x in re.split(r"\s*(?:\n|<br\s*/?>|\u2022)\s*", r["description"]) if x.strip()])

    # Readmes shipped inside the releases. extract/<norm>/ is by catalogue norm;
    # mods/<bsp>/ is by bsp, mapped back to a norm through extract.json.
    norm_of_bsp = {b: n for n, b in bsp_of.items()}
    for root, by_bsp in ((os.path.join(WORK, "extract"), False), (os.path.join(WORK, "mods"), True)):
        for d, p, lines in readmes(root):
            if lines is None:
                scanned["pdf_unread"] += 1
                continue
            scanned["readmes"] += 1
            norm = norm_of_bsp.get(d, d) if by_bsp else d
            add(norm, {"url": None, "file": os.path.relpath(p, WORK), "site": "the map's readme", "author": None}, lines)

    # Best per (map, kind). Two sources of one guide (codrepo's repost and the UGX thread)
    # are one guide; the higher confidence wins, the author's own post on a tie.
    best = {}
    seen_sig = {}
    low = []
    for norm, src, g in cands:
        if g["confidence"] < KEEP:
            low.append((norm, src, g))
            continue
        k = (norm, g["kind"]) if g["kind"] != "other" else (norm, "other", g["title"].lower())
        # the same text posted twice (codrepo's repost of the UGX thread) is one guide
        sig = (norm, re.sub(r"\W+", "", g["steps"][0]["text"].lower())[:60])
        if sig in seen_sig and seen_sig[sig] != k:
            continue
        seen_sig.setdefault(sig, k)
        cur = best.get(k)
        rank = (g["confidence"], len(g["steps"]))
        if not cur or rank > (cur[1]["confidence"], len(cur[1]["steps"])):
            best[k] = (src, g)

    guides = []
    per_other = {}
    for key, (src, g) in sorted(best.items()):
        norm, kind = key[0], key[1]
        if kind == "other":
            per_other[norm] = per_other.get(norm, 0) + 1
            if per_other[norm] > 3:
                continue
        keys = ([bsp_of[norm]] if norm in bsp_of else []) + ["cat:" + norm]
        guides.append({
            "norm": norm,
            "map_name": names.get(norm),
            "map_keys": keys,
            "kind": kind,
            "title": g["title"],
            "reward": g["reward"],
            "steps": g["steps"],
            "source_url": src.get("url"),
            "source_file": src.get("file"),
            "source_site": src["site"],
            "source_author": clean_author(src.get("author")),
            "confidence": g["confidence"],
            "confidence_label": "high" if g["confidence"] >= HIGH else "medium",
            "evidence": g["evidence"],
        })

    maps_with = sorted({g["norm"] for g in guides})
    out = {
        "schema": "enw.map_guides/1",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "made_by": "archive/easter_eggs.py (heuristic; cache only, no requests)",
        "threshold": KEEP,
        "scanned": scanned,
        "candidates": len(cands),
        "rejected_low": len(low),
        "maps_with_guides": len(maps_with),
        "by_kind": {k: sum(1 for g in guides if g["kind"] == k) for k in TITLE},
        "guides": guides,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    if a.print:
        for g in guides:
            show(g["norm"], g["source_site"], g["source_author"], g)
    if a.low:
        print("\n==================== LOW ====================")
        for norm, src, g in low:
            show(norm, src["site"], src.get("author"), g)
    print("scanned:", json.dumps(scanned))
    print("candidates %d, kept %d guides on %d maps, rejected low %d" % (len(cands), len(guides), len(maps_with), len(low)))
    print("by kind:", json.dumps(out["by_kind"]))
    print("wrote", a.out)


def show(norm, site, author, g):
    print("\n## %s  [%s %.2f]  %s  (%s, %s)  -> %s" % (norm, g["kind"], g["confidence"], g["title"], author, site, g["reward"]))
    n = 0
    for s in g["steps"]:
        if s.get("head"):
            print("   ## " + s["text"])
            continue
        n += 1
        print("   %d. %s%s" % (n, (s["label"] + " — ") if s.get("label") else "", s["text"][:160]))
        for d in s.get("details", []):
            print("        - " + d[:120])


if __name__ == "__main__":
    main()
