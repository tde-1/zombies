#!/usr/bin/env python3
"""Estimate replay bytes per game-hour for the game-link v0 `snap` encoder.

WHY THIS EXISTS: the real number has to come from a captured game, and that needs
the loader (see docs/kickstart/referee.md). Until then the host agent needs *a*
number to size R2 and the retention policy, and it should be a number someone can
argue with rather than a guess. So this reproduces replay.cpp's encoder exactly --
same field set, same rounding, same "omit unchanged" rule -- over synthetic but
plausible motion, and prints raw, gzip and zstd sizes.

It is deliberately pessimistic where it is unsure: four players always alive and
always moving, and a zombie count that follows the stock curve without the lulls
a real game has between rounds.

Usage:
    python estimate_snap_bytes.py [--minutes 60] [--players 4]
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import random

SV_FPS = 20  # dedi measured sv_fps 20 on the stock dedicated server


def zombies_alive(round_no: int, players: int) -> int:
    """Stock-ish max-alive curve.

    _zombiemode.gsc scales the wave with get_players().size; 24 is the stock cap
    and customs raise it. Use the cap once the curve reaches it.
    """
    base = 6 + round_no * 2 * max(1, players) // 2
    return min(base, 24 if players <= 2 else 24 + 8 * (players - 2))


def make_snap(ms: int, players: list[dict], zoms: list[dict], zombie_frame: bool,
              prev: dict, v: dict | None = None) -> str:
    """Byte-for-byte the shape replay.cpp emits, with the trade-off variants applied."""
    v = v or {}
    nd = v.get("quant", 1)         # decimal places for positions/angles
    delta = v.get("delta", False)  # send position deltas, not absolutes
    pl = []
    for p in players:
        if delta and "pos" in prev.setdefault(p["slot"], {}):
            pp = prev[p["slot"]]["pos"]
            pos = [round(p["pos"][i] - pp[i], nd) for i in range(3)]
        else:
            pos = [round(p["pos"][i], nd) for i in range(3)]
        prev.setdefault(p["slot"], {})["pos"] = list(p["pos"])
        o = {
            "slot": p["slot"],
            "pos": pos,
            "ang": [round(p["ang"][0], nd), round(p["ang"][1], nd)],
        }
        q = prev.setdefault(p["slot"], {})
        if q.get("health") != p["health"]:
            o["health"] = p["health"]
            q["health"] = p["health"]
        if q.get("alive") != p["alive"]:
            o["alive"] = p["alive"]
            q["alive"] = p["alive"]
        if q.get("score") != p["score"]:
            o["score"] = p["score"]
            q["score"] = p["score"]
        if q.get("weapon") != p["weapon"]:
            o["weapon"] = p["weapon"]
            q["weapon"] = p["weapon"]
        pl.append(o)

    snap = {"t": "snap", "ms": ms, "players": pl}
    if zombie_frame and zoms and not v.get("no_zombies"):
        snap["zombies"] = [
            {"id": z["id"], "pos": [round(z["pos"][i], nd) for i in range(3)], "health": z["health"]}
            for z in zoms
        ]
    return json.dumps(snap, separators=(",", ":"))


# The trade-offs we can actually make, measured rather than guessed.
VARIANTS = {
    "v0":            {},
    "zombies 5 Hz":  {"zrate": 4},
    "no zombies":    {"no_zombies": True},
    "players 10 Hz": {"prate": 2},
    "1-unit pos":    {"quant": 0},
    "delta pos":     {"delta": True},
    "1-unit+delta":  {"quant": 0, "delta": True},
    "1u+delta+z5":   {"quant": 0, "delta": True, "zrate": 4},
}


def run(minutes: int, nplayers: int, seed: int = 1, variant: str = "v0",
        quiet: bool = False) -> tuple[int, int, float]:
    rng = random.Random(seed)
    frames = minutes * 60 * SV_FPS

    players = [
        {
            "slot": i,
            "pos": [rng.uniform(-2000, 2000), rng.uniform(-2000, 2000), 40.0],
            "ang": [0.0, rng.uniform(0, 360)],
            "health": 100,
            "alive": True,
            "score": 500,
            "weapon": 12,
        }
        for i in range(nplayers)
    ]
    zoms: list[dict] = []
    next_id = 100
    prev: dict = {}

    v = VARIANTS[variant]
    prate = v.get("prate", 1)
    zrate = v.get("zrate", 2)

    total = 0
    lines: list[str] = []
    for f in range(frames):
        ms = f * (1000 // SV_FPS)
        # ~55 s a round early, settling to ~90 s later: close enough for sizing.
        round_no = 1 + int(f / (SV_FPS * 60))

        for p in players:
            # A player training a train: constant motion, constant view sweep.
            p["pos"][0] += rng.uniform(-14, 14)
            p["pos"][1] += rng.uniform(-14, 14)
            p["ang"][1] = (p["ang"][1] + rng.uniform(-6, 6)) % 360
            if rng.random() < 0.05:          # a kill roughly every second
                p["score"] += 60
            if rng.random() < 0.004:         # taking a hit
                p["health"] = max(10, p["health"] - 20)
            elif p["health"] < 100 and rng.random() < 0.05:
                p["health"] = min(100, p["health"] + 20)
            if rng.random() < 0.0008:        # weapon swap
                p["weapon"] = rng.randint(1, 60)

        want = zombies_alive(round_no, nplayers)
        while len(zoms) < want:
            zoms.append({"id": next_id, "pos": [rng.uniform(-2000, 2000),
                                                rng.uniform(-2000, 2000), 40.0],
                         "health": 150 + round_no * 100})
            next_id += 1
        while len(zoms) > want:
            zoms.pop(0)
        for z in zoms:
            z["pos"][0] += rng.uniform(-10, 10)
            z["pos"][1] += rng.uniform(-10, 10)

        if f % prate:
            continue
        line = make_snap(ms, players, zoms, (f % zrate) == 0, prev, v)
        lines.append(line)
        total += len(line) + 1

    blob = ("\n".join(lines) + "\n").encode()
    gz = len(gzip.compress(blob, 6))
    try:
        import zstandard  # optional
        zs = len(zstandard.ZstdCompressor(level=10).compress(blob))
    except Exception:
        zs = None

    hours = minutes / 60
    best = zs if zs is not None else gz
    if quiet:
        return total, best, best / hours / 1024 / 1024

    def per_hour(n: int) -> str:
        return f"{n / hours / 1024 / 1024:8.1f} MB/game-hour"

    print(f"{nplayers} players, {minutes} min, {len(lines)} snaps, sv_fps {SV_FPS}, variant {variant}")
    print(f"  raw NDJSON   {total:>12,} B   {per_hour(total)}")
    print(f"  gzip -6      {gz:>12,} B   {per_hour(gz)}   ({gz/total:.1%})")
    if zs is not None:
        print(f"  zstd -10     {zs:>12,} B   {per_hour(zs)}   ({zs/total:.1%})")
    else:
        print("  zstd         (pip install zstandard for the real chunk size)")
    print(f"  mean snap    {total/len(lines):8.1f} B")
    return total, best, best / hours / 1024 / 1024


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=int, default=60)
    ap.add_argument("--players", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--variant", default="v0", choices=list(VARIANTS))
    ap.add_argument("--compare", action="store_true",
                    help="run every variant and print the trade-off table")
    args = ap.parse_args()
    if not args.compare:
        run(args.minutes, args.players, args.seed, args.variant)
        return
    base = None
    print(f"{args.players} players, {args.minutes} min, sv_fps {SV_FPS}, zstd-10")
    print(f"{'variant':16} {'MB/game-hour':>13} {'vs v0':>8}")
    for name in VARIANTS:
        _, _, mb = run(args.minutes, args.players, args.seed, name, quiet=True)
        if base is None:
            base = mb
        print(f"{name:16} {mb:13.2f} {mb/base:7.0%}")


if __name__ == "__main__":
    main()
