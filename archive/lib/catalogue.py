#!/usr/bin/env python3
"""The archive catalogue: a SQLite file under ZombiesDev, never in the repo.

Two tables do the work.

  maps    one row per (source, map) sighting. The same map appears once per source;
          `norm` is the normalised name used to merge sightings into one map later.
  links   one row per download link, with its health once checked.

Everything is append-or-replace by a stable key so a crawler can be re-run without
duplicating rows, and so a half-finished overnight run can be resumed.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import urllib.parse

DB_PATH = os.environ.get("ENW_ARCHIVE_DB", r"C:\Users\b\ZombiesDev\archive\catalogue.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS maps (
  key        TEXT PRIMARY KEY,   -- source|norm
  source     TEXT NOT NULL,
  name       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  source_url TEXT,
  author     TEXT,
  version    TEXT,
  released   TEXT,
  description TEXT,
  tags       TEXT,               -- JSON list
  extra      TEXT,               -- JSON object
  seen       TEXT
);
CREATE INDEX IF NOT EXISTS maps_norm ON maps(norm);
CREATE INDEX IF NOT EXISTS maps_source ON maps(source);

CREATE TABLE IF NOT EXISTS links (
  url        TEXT NOT NULL,
  map_key    TEXT NOT NULL,
  host       TEXT,
  label      TEXT,
  kind       TEXT,               -- download | page | mirror
  status     INTEGER,
  final_url  TEXT,
  size       INTEGER,
  size_exact INTEGER DEFAULT 1,     -- 0 when the host only rounds it ("612M")
  content_type TEXT,
  filename   TEXT,
  error      TEXT,
  verdict    TEXT,               -- alive | dead | unknown | blocked | skipped
  checked    TEXT,
  PRIMARY KEY (url, map_key)
);
CREATE INDEX IF NOT EXISTS links_host ON links(host);
CREATE INDEX IF NOT EXISTS links_verdict ON links(verdict);

CREATE TABLE IF NOT EXISTS runs (
  ts TEXT, what TEXT, detail TEXT
);
"""

# Version-ish tokens: "v1", "v1.2.3", "1.2". A BARE integer is deliberately KEPT --
# "Zombie Hotel 2" and "Zombie Hotel" are different maps, and "6 Feet Under" and
# "101st" would lose their names. That mistake merged 51 distinct ZWR rows on the
# first run, which is exactly the kind of quiet over-counting a link report cannot have.
_VERSION = re.compile(r"\bv\s*\d+(?:[._]\d+)*\b|\b\d+\.\d+(?:\.\d+)*\b", re.I)
_NOISE = re.compile(
    r"\b(final|release[d]?|fixed|patch|update[d]?|beta|alpha|rc\d*|"
    r"waw|world\s*at\s*war|cod5|zombies?|nazi|map|mod|by)\b", re.I)


def normalise(name: str) -> str:
    """A loose key for matching the same map across sites.

    'Nazi Zombie Leviathan v1.2 (Final)' and 'LEVIATHAN' must collide, because the
    point is counting distinct maps rather than distinct spellings. Collisions are
    reported (see report.py) and never silently merged into one row: each source
    keeps its own row, keyed source|norm.
    """
    s = name.lower().replace("’", "'").replace("&", " and ")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = _VERSION.sub(" ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = _NOISE.sub(" ", s)
    s = re.sub(r"\s+", "", s)
    return s or re.sub(r"[^a-z0-9]+", "", name.lower()) or "unnamed"


def host_of(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).netloc.lower().removeprefix("www.")
    except Exception:
        return ""


def connect(path=DB_PATH, threaded=False):
    """threaded=True hands the same connection to the link checker's per-host workers.
    Safe only because every write in check_links.py is taken under one lock."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path, timeout=60, check_same_thread=not threaded)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    cols = {r[1] for r in db.execute("PRAGMA table_info(links)")}
    if "size_exact" not in cols:
        db.execute("ALTER TABLE links ADD COLUMN size_exact INTEGER DEFAULT 1")
    return db


def put_map(db, source, name, source_url=None, author=None, version=None,
            released=None, description=None, tags=None, extra=None):
    norm = normalise(name)
    key = source + "|" + norm
    db.execute(
        "INSERT INTO maps(key,source,name,norm,source_url,author,version,released,"
        "description,tags,extra,seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET "
        " name=COALESCE(excluded.name,name), source_url=COALESCE(excluded.source_url,source_url),"
        " author=COALESCE(excluded.author,author), version=COALESCE(excluded.version,version),"
        " released=COALESCE(excluded.released,released),"
        " description=COALESCE(excluded.description,description),"
        " tags=COALESCE(excluded.tags,tags), extra=COALESCE(excluded.extra,extra),"
        " seen=excluded.seen",
        (key, source, name, norm, source_url, author, version, released, description,
         json.dumps(tags) if tags else None,
         json.dumps(extra) if extra else None,
         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    return key


def put_link(db, map_key, url, label=None, kind="download"):
    db.execute(
        "INSERT OR IGNORE INTO links(url,map_key,host,label,kind,verdict) VALUES(?,?,?,?,?,?)",
        (url, map_key, host_of(url), label, kind, None))


def record_health(db, url, map_keys, probe, verdict):
    for mk in map_keys:
        db.execute(
            "UPDATE links SET status=?,final_url=?,size=?,size_exact=?,content_type=?,"
            "filename=?,error=?,verdict=?,checked=? WHERE url=? AND map_key=?",
            (probe.get("status"), probe.get("final_url"), probe.get("size"),
             0 if probe.get("size_approx") else 1,
             probe.get("content_type"), probe.get("filename"), probe.get("error"),
             verdict, probe.get("checked"), url, mk))


def note(db, what, detail=""):
    db.execute("INSERT INTO runs(ts,what,detail) VALUES(?,?,?)",
               (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), what, detail))
    db.commit()
