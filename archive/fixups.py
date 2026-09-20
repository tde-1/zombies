#!/usr/bin/env python3
"""Offline corrections to link verdicts, each with the evidence that justifies it.

No network traffic. These are cases where a probe recorded a verdict we later proved
wrong by hand, and re-probing would only cost the host more requests for an answer we
already have.

  python fixups.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue  # noqa: E402

ONEDRIVE_REASON = (
    "OneDrive legacy /download?cid=&resid=&authkey= endpoint: answers HTTP 404 to a "
    "HEAD but redirects a GET to login.live.com (checked by hand on three of them, "
    "2026-09-20). Microsoft retired this URL shape, so a 404 here does not mean the "
    "file is gone - it means we cannot see it without a Microsoft account. Recorded "
    "blocked, not dead: 100+ imaginary dead links would have skewed the rot figure.")

GAMEFRONT_REASON = (
    "GameFront answers HTTP 403 with a bot 'Security Check' page. No CAPTCHA was "
    "attempted (overnight rules). Note these URLs also carry expires=1586... "
    "signatures from April 2020, so they are almost certainly dead as well - but "
    "'blocked' is what we can actually show.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    db = catalogue.connect()
    # Not map downloads: the UGX Map Manager installer (ZWR lists it against 29 maps
    # that the Manager can install) and UGX Mod Standalone (a prerequisite several
    # release threads link). Counting either as a map's download link inflates both
    # the link total and the "recoverable" count.
    PREREQ = (
        "UPDATE links SET kind='prerequisite' "
        "WHERE url LIKE '%UpdaterExe%' OR url LIKE '%ugx-mod-standalone%' "
        "OR url LIKE '%/map-manager/%'")
    todo = [
        ("prerequisites, not map downloads", PREREQ, ()),
        ("onedrive.live.com / 1drv.ms",
         "UPDATE links SET verdict='blocked', error=? "
         # Only the LEGACY shape, which is the one we proved is unverifiable. A modern
         # OneDrive share link would answer normally and must still be checked.
         "WHERE ((host LIKE '%onedrive.live.com%' AND url LIKE '%cid=%') "
         "       OR host LIKE '%1drv.ms%') "
         "AND (verdict IN ('dead','unknown') OR verdict IS NULL)",
         (ONEDRIVE_REASON,)),
        ("downloads.gamefront.com",
         "UPDATE links SET verdict='blocked', error=? "
         "WHERE host LIKE '%gamefront%' AND (verdict IS NULL OR verdict<>'alive')",
         (GAMEFRONT_REASON,)),
    ]
    for label, sql, args in todo:
        where = sql.split(" WHERE ", 1)[1]
        n = db.execute("SELECT COUNT(*) FROM links WHERE " + where).fetchone()[0]
        print("%-32s %d rows" % (label, n))
        if not a.dry_run:
            db.execute(sql, args)
    if not a.dry_run:
        db.commit()
        catalogue.note(db, "fixups", "onedrive+gamefront reclassified blocked")
        print("applied")


if __name__ == "__main__":
    main()
