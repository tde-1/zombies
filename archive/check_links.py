#!/usr/bin/env python3
"""Check every catalogued download link: alive / dead / blocked / unknown, and its size.

This is the deliverable that sizes the archive. It is also the part most likely to
annoy a host, so:

  * one worker thread PER HOST and no more, so a host never sees two of our requests
    at once, and the per-host delay in lib/net.py still applies inside that worker;
  * hosts run in parallel with each other, which is what makes ~1,500 links finish in
    an hour instead of a day;
  * a host that rate-limits is dropped, its worker stops, and its remaining links are
    recorded as `unknown` with the reason -- never retried into a ban.

Resumable: a link with a verdict is skipped, so this can be stopped and restarted.

  python check_links.py [--limit N] [--host mediafire.com] [--recheck]
"""

from __future__ import annotations

import argparse
import collections
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import catalogue, linkcheck, net  # noqa: E402

# A link that is the SAME url for many maps is checked once (ZWR lists the UGX Map
# Manager installer against 29 different maps, for example).
SELECT = ("SELECT url, GROUP_CONCAT(map_key, char(10)) AS keys, host, COUNT(*) n "
          "FROM links WHERE %s GROUP BY url")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max links per host")
    ap.add_argument("--host", action="append", help="only these hosts")
    ap.add_argument("--recheck", action="store_true")
    ap.add_argument("--max-hosts", type=int, default=10)
    a = ap.parse_args()

    db = catalogue.connect(threaded=True)
    db.execute("PRAGMA journal_mode=WAL")
    where = "1=1" if a.recheck else "verdict IS NULL"
    rows = list(db.execute(SELECT % where))
    if a.host:
        want = set(a.host)
        rows = [r for r in rows if r["host"] in want]

    by_host = collections.defaultdict(list)
    for r in rows:
        by_host[r["host"] or "?"].append((r["url"], r["keys"].split("\n")))
    if a.limit:
        by_host = {h: v[:a.limit] for h, v in by_host.items()}

    order = sorted(by_host, key=lambda h: -len(by_host[h]))
    print("%d links across %d hosts" % (sum(len(v) for v in by_host.values()), len(order)))
    for h in order[:20]:
        print("   %5d  %s" % (len(by_host[h]), h))

    ps = net.PoliteSession(log_name="linkcheck")
    dblock = threading.Lock()
    counts = collections.Counter()
    started = time.time()

    def worker(host):
        for url, keys in by_host[host]:
            try:
                p, verdict = linkcheck.probe(ps, url)
            except net.Dropped as exc:
                p, verdict = {"url": url, "error": str(exc)}, "blocked"
            except Exception as exc:
                p, verdict = {"url": url, "error": "%s: %s" % (exc.__class__.__name__, exc)}, "unknown"
            p.setdefault("checked", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            with dblock:
                catalogue.record_health(db, url, keys, p, verdict)
                db.commit()
                counts[verdict] += 1
                counts[host + ":" + verdict] += 1
            st = ps.host_state(url)
            if st.dropped:
                # Everything left for this host is unknown-with-a-reason, not dead.
                with dblock:
                    for u2, k2 in by_host[host]:
                        cur = db.execute("SELECT verdict FROM links WHERE url=? LIMIT 1",
                                         (u2,)).fetchone()
                        if cur and cur["verdict"] is None:
                            catalogue.record_health(
                                db, u2, k2,
                                {"error": "host dropped: " + st.dropped, "checked":
                                 time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                                "unknown")
                    db.commit()
                ps.log("[check] %s worker stopped" % host)
                return

    threads = []
    for host in order[:a.max_hosts]:
        t = threading.Thread(target=worker, args=(host,), daemon=True, name="w-" + host)
        t.start()
        threads.append(t)
        time.sleep(0.3)
    # Hosts beyond max-hosts are handled after the first wave, so we never have more
    # than max-hosts sockets open at once.
    for t in threads:
        t.join()
    for host in order[a.max_hosts:]:
        worker(host)

    print("\nverdicts:", dict((k, v) for k, v in counts.items() if ":" not in k))
    print("elapsed %.1f min" % ((time.time() - started) / 60))
    catalogue.note(db, "linkcheck",
                   str(dict((k, v) for k, v in counts.items() if ":" not in k)))


if __name__ == "__main__":
    main()
