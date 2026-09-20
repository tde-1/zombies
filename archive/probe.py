#!/usr/bin/env python3
"""One-off reconnaissance: robots.txt + one index page per crawl source.

Run before writing a per-site crawler, so the crawler is written against what the site
actually serves rather than what we assume. Output goes to the cache; a short line per
source goes to stdout.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import net  # noqa: E402

SOURCES = [
    ("zwr", "https://zwr.gg/custom-downloads/waw"),
    ("codrepo-manager", "https://callofdutyrepo.com/waw-download-manager/"),
    ("codrepo-ee", "https://callofdutyrepo.com/waw-easter-egg-maps/"),
    ("codrepo-be", "https://callofdutyrepo.com/waw-buyable-ending-maps/"),
    ("codrepo-top100", "https://callofdutyrepo.com/top-100-waw-maps/"),
    ("zombiemodding", "https://zombiemodding.com/index.php?action=downloads"),
    ("ugx-mapmanager", "https://www.ugx-mods.com/map-manager/"),
    ("archive-org-item", "https://archive.org/details/WAW_CustomNaziZombieMaps"),
    ("archive-org-search", "https://archive.org/advancedsearch.php?q=world+at+war+zombies+custom+map&output=json&rows=5"),
    ("moddb", "https://www.moddb.com/games/call-of-duty-world-at-war/addons"),
]


def main():
    ps = net.PoliteSession(log_name="probe")
    for name, url in SOURCES:
        print("\n=== %s  %s" % (name, url))
        try:
            allowed = ps.allowed(url)
            print("   robots allows:", allowed)
            if not allowed:
                continue
            t = ps.get(url)
            if t is None:
                print("   MISS")
                continue
            print("   %d bytes; title=%r" % (len(t), _title(t)))
        except net.Dropped as exc:
            print("   DROPPED:", exc)
        except Exception as exc:
            print("   ERROR:", exc.__class__.__name__, exc)
    print("\nhost summary:", ps.summary())


def _title(t):
    import re
    m = re.search(r"<title[^>]*>(.{0,120}?)</title>", t, re.S | re.I)
    return m.group(1).strip() if m else None


if __name__ == "__main__":
    main()
