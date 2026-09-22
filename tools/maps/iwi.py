#!/usr/bin/env python3
"""Read a World at War .iwi texture into a Pillow image.

IWI version 6 (WaW, and CoD4's is the same shape):

    0   char[3]  "IWi"
    3   u8       version, 6
    4   u8       format    1 ARGB8888, 2 RGB888, 3 ARGB4444? (not seen), 11 DXT1, 12 DXT3, 13 DXT5
    5   u8       usage/flags (mip and clamp bits; not needed to decode)
    6   u16[3]   width, height, depth
    12  u32[4]   file offsets of the mip levels, largest first (the "picmip" table)
    28           pixel data, SMALLEST mip first, so the full-size image is the file's tail

MEASURED on the stock loadscreens and fourteen custom maps (2026-09-22): every loadscreen is
DXT1 or DXT5, square or 2:1, and the full-size level is exactly the last
ceil(w/4)*ceil(h/4)*block bytes of the file whether or not mips are present — which is what
the offset table says too, so both agree and the tail is what is read.

The block decode is Pillow's own BCn decoder; nothing here is hand-rolled bit twiddling.
"""

from __future__ import annotations

import struct
import sys

from PIL import Image

FORMATS = {
    11: ("bcn", 1, 8),    # DXT1, 8 bytes per 4x4 block
    12: ("bcn", 2, 16),   # DXT3
    13: ("bcn", 3, 16),   # DXT5
}


class IwiError(ValueError):
    pass


def header(data: bytes):
    if len(data) < 28 or data[:3] != b"IWi":
        raise IwiError("not an IWI file")
    version, fmt, flags = data[3], data[4], data[5]
    w, h, d = struct.unpack_from("<3H", data, 6)
    return {"version": version, "format": fmt, "flags": flags, "width": w, "height": h, "depth": d}


def decode(data: bytes) -> Image.Image:
    hd = header(data)
    if hd["version"] != 6:
        raise IwiError("IWI version %d, only 6 (WaW) is read" % hd["version"])
    w, h, fmt = hd["width"], hd["height"], hd["format"]
    if not w or not h:
        raise IwiError("zero-sized image")
    if fmt in FORMATS:
        codec, n, block = FORMATS[fmt]
        size = ((w + 3) // 4) * ((h + 3) // 4) * block
        if len(data) - 28 < size:
            raise IwiError("truncated: need %d bytes of pixels, have %d" % (size, len(data) - 28))
        return Image.frombytes("RGBA", (w, h), data[-size:], codec, n)
    if fmt == 1:  # ARGB8888 stored B,G,R,A
        size = w * h * 4
        return Image.frombytes("RGBA", (w, h), data[-size:], "raw", "BGRA")
    if fmt == 2:  # RGB888 stored B,G,R
        size = w * h * 3
        return Image.frombytes("RGB", (w, h), data[-size:], "raw", "BGR")
    raise IwiError("IWI format %d is not decoded here" % fmt)


if __name__ == "__main__":
    # python iwi.py in.iwi out.png
    src, dst = sys.argv[1], sys.argv[2]
    raw = open(src, "rb").read()
    print(header(raw))
    decode(raw).convert("RGB").save(dst)
