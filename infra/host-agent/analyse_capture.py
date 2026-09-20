#!/usr/bin/env python3
"""Turn a game-link capture into the numbers the replay budget needs.

  python analyse_capture.py capture.ndjson

Reports message mix, real snap rate, and raw/gzip/zstd bytes per game-hour, so a
measured capture can be compared directly with
server/components/replay/estimate_snap_bytes.py (which models the same encoder).
"""
from __future__ import annotations

import collections
import gzip
import json
import sys


def main(path: str) -> None:
    counts = collections.Counter()
    first_ms = last_ms = None
    snap_ms: list[int] = []
    players_seen = set()
    zombie_rows = 0
    player_rows = 0
    pos_min = [1e9] * 3
    pos_max = [-1e9] * 3
    raw = open(path, "rb").read()

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            counts["<unparseable>"] += 1
            continue
        t = o.get("t", "?")
        counts[t] += 1
        ms = o.get("ms")
        if isinstance(ms, (int, float)):
            first_ms = ms if first_ms is None else min(first_ms, ms)
            last_ms = ms if last_ms is None else max(last_ms, ms)
            if t == "snap":
                snap_ms.append(ms)
        if t == "snap":
            for p in o.get("players", []):
                player_rows += 1
                players_seen.add(p.get("slot"))
                pos = p.get("pos")
                if isinstance(pos, list) and len(pos) == 3:
                    for i in range(3):
                        pos_min[i] = min(pos_min[i], pos[i])
                        pos_max[i] = max(pos_max[i], pos[i])
            zombie_rows += len(o.get("zombies", []))

    span = (last_ms - first_ms) / 1000.0 if first_ms is not None and last_ms else 0.0
    print(f"file            {path}")
    print(f"raw bytes       {len(raw):,}")
    print(f"messages        {sum(counts.values())}")
    for t, n in counts.most_common():
        print(f"   {t:16} {n}")
    if span <= 0:
        print("\nno usable timestamps - cannot compute a rate")
        return

    print(f"\nspan            {span:.1f} s")
    print(f"snaps           {counts.get('snap', 0)}  ({counts.get('snap',0)/span:.1f} Hz)")
    print(f"player rows     {player_rows}  (slots seen: {sorted(x for x in players_seen if x is not None)})")
    print(f"zombie rows     {zombie_rows}")
    if pos_max[0] > -1e9:
        print("player pos bbox "
              + "  ".join(f"{pos_min[i]:.0f}..{pos_max[i]:.0f}" for i in range(3)))

    gz = len(gzip.compress(raw, 6))
    try:
        import zstandard
        zs = len(zstandard.ZstdCompressor(level=10).compress(raw))
    except Exception:
        zs = None
    hours = span / 3600.0
    print(f"\nMEASURED bytes per game-hour")
    print(f"   raw NDJSON   {len(raw)/hours/1024/1024:8.2f} MB/h")
    print(f"   gzip -6      {gz/hours/1024/1024:8.2f} MB/h")
    if zs is not None:
        print(f"   zstd -10     {zs/hours/1024/1024:8.2f} MB/h")
    print("\nCompare with server/components/replay/estimate_snap_bytes.py --compare.")
    print("NOTE: a capture with no zombie rows is NOT comparable to the 4-player")
    print("estimate - zombie tracks are ~77% of the modelled bytes.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1])
