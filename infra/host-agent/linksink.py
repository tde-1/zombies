#!/usr/bin/env python3
"""Minimal game-link v0 sink: accept the DLL's TCP connection, append NDJSON to a file.

Stands in for infra/host-agent while I measure replay bytes. Prints a running
summary so a capture can be watched without tailing the file.

  python linksink.py [--port 28960] [--out capture.ndjson] [--seconds 900]
"""
import argparse, collections, json, socket, sys, threading, time


def serve(port, out_path, seconds, no_say=False):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(4)
    srv.settimeout(1.0)
    print(f"listening on 127.0.0.1:{port} -> {out_path}", flush=True)

    deadline = time.time() + seconds
    counts = collections.Counter()
    total_bytes = 0
    first_ms = last_ms = None
    fh = open(out_path, "wb")

    conn = None
    buf = b""
    next_say = None
    says = 0
    while time.time() < deadline:
        if conn is None:
            try:
                conn, addr = srv.accept()
                conn.settimeout(1.0)
                next_say = time.time() + 20
                print(f"connected {addr}", flush=True)
            except socket.timeout:
                continue
        # Exercise host->game chat injection a few times during the capture.
        if (not no_say) and next_say and time.time() >= next_say and says < 3:
            says += 1
            msg = json.dumps({"t": "say", "from": "ENW",
                              "text": f"capture test {says} of 3"}) + chr(10)
            try:
                conn.sendall(msg.encode())
                print(f"  -> sent say #{says}", flush=True)
            except OSError:
                pass
            next_say = time.time() + 45

        try:
            chunk = conn.recv(65536)
        except socket.timeout:
            continue
        except OSError:
            chunk = b""
        if not chunk:
            print("peer closed", flush=True)
            conn.close()
            conn = None
            continue
        fh.write(chunk)
        fh.flush()   # so the file size is meaningful while the capture runs
        total_bytes += len(chunk)
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except Exception:
                counts["<bad json>"] += 1
                continue
            counts[o.get("t", "?")] += 1
            ms = o.get("ms")
            if isinstance(ms, (int, float)):
                first_ms = ms if first_ms is None else min(first_ms, ms)
                last_ms = ms if last_ms is None else max(last_ms, ms)
        if counts and sum(counts.values()) % 500 == 0:
            print(f"  {sum(counts.values())} msgs, {total_bytes:,} B", flush=True)

    if conn:
        conn.close()
    fh.close()
    span = (last_ms - first_ms) / 1000.0 if first_ms is not None and last_ms else 0.0
    print("\n=== capture summary ===", flush=True)
    print(f"file      {out_path}")
    print(f"bytes     {total_bytes:,}")
    print(f"messages  {sum(counts.values())}")
    for t, n in counts.most_common():
        print(f"   {t:16} {n}")
    if span > 0:
        print(f"span      {span:.1f} s")
        print(f"rate      {total_bytes/span:,.0f} B/s  =  "
              f"{total_bytes/span*3600/1024/1024:,.1f} MB/game-hour (raw NDJSON)")
        snaps = counts.get("snap", 0)
        if snaps:
            print(f"snap rate {snaps/span:.1f} Hz")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=28960)
    ap.add_argument("--out", default="capture.ndjson")
    ap.add_argument("--seconds", type=int, default=900)
    ap.add_argument("--no-say", action="store_true",
                    help="do not push test chat into the game (isolates injection as a crash cause)")
    a = ap.parse_args()
    serve(a.port, a.out, a.seconds, no_say=a.no_say)
