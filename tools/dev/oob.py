#!/usr/bin/env python3
"""
oob.py -- poke a running CoD server with connectionless ("out of band") UDP queries.

Quake-lineage servers answer a datagram whose first four bytes are 0xFFFFFFFF followed
by a command name. T4's SV_ConnectionlessPacket (0x634E90) dispatches over
getstatus / getinfo / getchallenge / connect / ... so these three are the cheap way to
ask "is this server answering on the wire at all?" without a game client.

It distinguishes the three outcomes that matter and that a naive "did it reply" check
conflates:

    ANSWERED            a reply came back        -> the server is alive AND answering
    NO REPLY            timed out                -> something is listening, but silent
    PORT UNREACHABLE    ICMP                     -> nothing is bound to that port

LOCALHOST ONLY by default. dev-box.md rule 2: never touch public servers or the
Activision master. Pass --allow-remote if you ever genuinely need a LAN address.

Usage:
    python tools/dev/oob.py 28960
    python tools/dev/oob.py 28960 --host 127.0.0.1 --timeout 1.5 --commands getstatus
"""

import argparse
import socket
import sys

OOB = b"\xff\xff\xff\xff"
DEFAULT_COMMANDS = ("getstatus", "getinfo", "getchallenge")


def probe(host: str, port: int, command: str, timeout: float):
    """Return (status, detail). status is one of ANSWERED / NO REPLY / PORT UNREACHABLE."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(OOB + command.encode() + b"\n", (host, port))
        data, _ = s.recvfrom(65535)
    except socket.timeout:
        return "NO REPLY", ""
    except ConnectionResetError:
        # Windows reports ICMP port-unreachable on a connected UDP socket this way.
        return "PORT UNREACHABLE", ""
    except OSError as e:
        return "ERROR", str(e)
    finally:
        s.close()

    body = data[4:] if data.startswith(OOB) else data
    text = body.decode("utf-8", "replace").replace("\n", " | ").strip()
    return "ANSWERED", f"{len(data)} bytes: {text[:400]}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", type=int)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--timeout", type=float, default=1.0)
    ap.add_argument("--commands", nargs="*", default=list(DEFAULT_COMMANDS))
    ap.add_argument("--allow-remote", action="store_true",
                    help="permit a non-loopback host (dev-box.md rule 2: localhost/LAN only)")
    args = ap.parse_args()

    if not args.allow_remote and args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"refusing to probe {args.host}: loopback only unless --allow-remote", file=sys.stderr)
        return 2

    any_answer = False
    for cmd in args.commands:
        status, detail = probe(args.host, args.port, cmd, args.timeout)
        if status == "ANSWERED":
            any_answer = True
        print(f"{cmd:<14} {status:<18} {detail}")

    # Exit 0 only when the server actually answered something. A harness can then gate
    # on the exit code instead of grepping the text -- the previous session's readiness
    # gate matched "REPLY" inside "NO REPLY" and launched a client at a dead server.
    return 0 if any_answer else 1


if __name__ == "__main__":
    raise SystemExit(main())
