#!/usr/bin/env python3
"""ff_extract.py - pull rawfiles (GSC/CSC/RMB/...) out of Call of Duty: World at War fastfiles.

Our own code. No Activision or third-party source was copied; the container format was
established by inspecting the bytes of the stock zone files (see docs/kickstart/referee.md).

Format, as observed on WaW 1.7 (Steam):

    offset 0   8 bytes   magic, "IWffu100" (or "IWff0100")
    offset 8   u32 LE    zone version, 0x183 (387) for T4 PC
    offset 12  ...       one raw zlib stream; inflating it yields the zone blob

The zone blob is the in-memory image of the zone's assets with every pointer written as
0xFFFFFFFF ("the data follows inline"). A T4 RawFile is

    struct RawFile { const char *name; int len; const char *buffer; };

so inside the blob a rawfile looks like

    FF FF FF FF | len (u32 LE) | FF FF FF FF | name\0 | <len bytes of file data>

`len` is the payload size and does NOT include a terminating NUL. Scanning the blob for that
signature finds every rawfile without having to parse the asset index, which is what we want:
we only need the scripts, and we need the same code to work on ~1,000 third-party fastfiles
built by ten years' worth of modding tools.

Usage:
    python ff_extract.py [-o OUTDIR] [--list] [--zone] [--min-len N] FF [FF ...]

Extracted content is Activision's or the map author's. Never commit it; the default output
root is C:\\Users\\b\\ZombiesDev\\scripts (outside the repo).
"""

from __future__ import annotations

import argparse
import os
import re
import struct
import sys
import zlib

MAGICS = (b"IWffu100", b"IWff0100")
T4_ZONE_VERSION = 0x183

# FF FF FF FF | len | FF FF FF FF | printable name | NUL
RAWFILE_SIG = re.compile(
    rb"\xff\xff\xff\xff(.{4})\xff\xff\xff\xff([\x20-\x7e]{3,200})\x00", re.S
)

MAX_RAWFILE = 16 * 1024 * 1024
DEFAULT_OUT = r"C:\Users\b\ZombiesDev\scripts"

# Extensions T4 stores as rawfiles. Anything else that matches the signature is almost
# certainly a coincidence in binary asset data, so we drop it unless --any-ext is given.
RAW_EXTS = {
    "gsc", "csc", "gsh", "rmb", "atr", "vision", "cfg", "txt", "csv", "def",
    "arena", "graph", "script",
}


def inflate_zone(path: str) -> bytes:
    """Read a .ff and return the decompressed zone blob."""
    with open(path, "rb") as fh:
        blob = fh.read()

    if len(blob) < 12:
        raise ValueError(f"{path}: too small to be a fastfile")
    magic = blob[:8]
    if magic not in MAGICS:
        raise ValueError(f"{path}: not a fastfile (magic {magic!r})")
    version = struct.unpack_from("<I", blob, 8)[0]
    if version != T4_ZONE_VERSION:
        print(
            f"  ! {os.path.basename(path)}: zone version 0x{version:x}, expected 0x183 "
            f"(T4). Trying anyway.",
            file=sys.stderr,
        )

    # Some tools emit several concatenated zlib streams; keep inflating while one follows.
    out = bytearray()
    rest = blob[12:]
    while rest:
        d = zlib.decompressobj()
        try:
            out += d.decompress(rest)
            out += d.flush()
        except zlib.error as exc:
            if not out:
                raise ValueError(f"{path}: inflate failed: {exc}") from exc
            break
        rest = d.unused_data
        # A following stream must start with a zlib header; trailing padding does not.
        if len(rest) < 2 or rest[0] & 0x0F != 8:
            break
    return bytes(out)


def find_rawfiles(zone: bytes, min_len: int = 1, any_ext: bool = False):
    """Yield (name, data) for every RawFile-looking record in the zone blob."""
    seen = set()
    for m in RAWFILE_SIG.finditer(zone):
        length = struct.unpack("<I", m.group(1))[0]
        if not (min_len <= length <= MAX_RAWFILE):
            continue
        try:
            name = m.group(2).decode("ascii")
        except UnicodeDecodeError:
            continue
        if "." not in os.path.basename(name):
            continue
        ext = name.rsplit(".", 1)[-1].lower()
        if not any_ext and ext not in RAW_EXTS:
            continue
        start = m.end()
        data = zone[start:start + length]
        if len(data) != length:
            continue
        # A rawfile is text; reject records whose payload is mostly binary.
        sample = data[:256]
        printable = sum(1 for b in sample if 9 <= b <= 13 or 32 <= b <= 126)
        if sample and printable / len(sample) < 0.90:
            continue
        key = (name, length)
        if key in seen:
            continue
        seen.add(key)
        yield name, data


def safe_join(root: str, name: str) -> str:
    """Join root with an in-zone asset path, refusing anything that escapes root."""
    parts = [p for p in re.split(r"[\\/]+", name) if p not in ("", ".", "..")]
    dest = os.path.normpath(os.path.join(root, *parts))
    if os.path.commonpath([os.path.abspath(root), os.path.abspath(dest)]) != os.path.abspath(root):
        raise ValueError(f"unsafe asset path {name!r}")
    return dest


def process(path: str, outroot: str, do_list: bool, keep_zone: bool,
            min_len: int, any_ext: bool) -> int:
    stem = os.path.splitext(os.path.basename(path))[0]
    print(f"== {path}")
    zone = inflate_zone(path)
    print(f"   zone {len(zone):,} bytes")

    dest_root = os.path.join(outroot, stem)
    if keep_zone:
        os.makedirs(dest_root, exist_ok=True)
        zpath = os.path.join(dest_root, stem + ".zone")
        with open(zpath, "wb") as fh:
            fh.write(zone)
        print(f"   zone blob -> {zpath}")

    count = 0
    total = 0
    for name, data in find_rawfiles(zone, min_len=min_len, any_ext=any_ext):
        count += 1
        total += len(data)
        if do_list:
            print(f"   {len(data):>9,}  {name}")
            continue
        dest = safe_join(dest_root, name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
    verb = "listed" if do_list else f"-> {dest_root}"
    print(f"   {count} rawfiles, {total:,} bytes {verb}")
    return count


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ff", nargs="+", help="fastfile(s) to read")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT,
                    help=f"output root (default {DEFAULT_OUT}); a subfolder per fastfile")
    ap.add_argument("--list", action="store_true", dest="do_list",
                    help="list rawfiles, write nothing")
    ap.add_argument("--zone", action="store_true",
                    help="also write the raw decompressed zone blob")
    ap.add_argument("--min-len", type=int, default=1, help="skip rawfiles smaller than this")
    ap.add_argument("--any-ext", action="store_true",
                    help="do not filter by extension (noisier)")
    args = ap.parse_args(argv)

    rc = 0
    for path in args.ff:
        try:
            if process(path, args.out, args.do_list, args.zone, args.min_len, args.any_ext) == 0:
                print(f"   ! no rawfiles found in {path}", file=sys.stderr)
        except Exception as exc:  # keep going over a batch of 1,000 maps
            print(f"   ! {path}: {exc}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
