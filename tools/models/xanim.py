#!/usr/bin/env python3
"""
Reader for the engine's compiled xanim, version 17 (IW3 / T4) -- the file OpenAssetTools'
Unlinker writes for an `xanim` asset (`<dump>/xanim/<name>`). Our own implementation of the
layout; the field order was checked against OpenAssetTools' CompiledXAnimLoader (GPL-3.0, read,
not copied) and against the files themselves (every file in the dump parses to its last byte).

Layout (little-endian):
    u16 version (17)  u16 numFrames  u16 numBones  u8 flags  u8 assetType  u16 framerate
    flags & 1 = looped (numLoopFrames = numFrames + 1), flags & 2 = delta track follows:
        quat2 track (yaw only), then a trans track (same shapes as a bone's, below)
    if numBones:
        u8[ceil(n/8)] flipQuat bits, u8[ceil(n/8)] halfQuat bits, n NUL-terminated bone names
        per bone: quat track, then trans track
    u8 numNoteTracks, then (cstring name, u16 frame) each
Quat track: u16 count; 0 = none (half quats only); 1 = one constant; else indices (omitted when
count >= numLoopFrames; u8 when frames < 256 else u16) and `count` values. A full quat is 3 x i16
(x, y, z; w = sqrt(1 - |xyz|^2)); a half quat is 2 values stored as 1 x i16 (z; w derived) --
a rotation about Z only. Scale 1/32767. The flip bit negates the first value.
Trans track: u16 count; 0 none; 1 = 3 x f32 constant; else indices, u8 smallTrans,
f32 mins[3], f32 size[3] (x 1/255 small, 1/65535 full), then count x (u8|u16)[3]: v = mins + size*q.

Values are each bone's LOCAL rotation/translation relative to its parent, in the engine's frame
(X forward, Y left, Z up). A bone with no trans track keeps its model's own offset.
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

Q = 1.0 / 32767.0


class Reader:
    def __init__(self, b: bytes):
        self.b, self.o = b, 0

    def u8(self):
        v = self.b[self.o]; self.o += 1; return v

    def u16(self):
        v = struct.unpack_from("<H", self.b, self.o)[0]; self.o += 2; return v

    def i16(self):
        v = struct.unpack_from("<h", self.b, self.o)[0]; self.o += 2; return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]; self.o += 4; return v

    def raw(self, n):
        v = self.b[self.o:self.o + n]; self.o += n; return v

    def cstr(self):
        e = self.b.index(b"\0", self.o)
        s = self.b[self.o:e].decode("latin-1"); self.o = e + 1; return s


def _indices(r: Reader, count, loop_frames, byte_idx):
    if count >= loop_frames:
        return list(range(count))
    return [r.u8() for _ in range(count)] if byte_idx else [r.u16() for _ in range(count)]


def _full(r: Reader):
    x, y, z = r.i16(), r.i16(), r.i16()
    w2 = 0x3FFF0001 - (x * x + y * y + z * z)
    w = math.floor(math.sqrt(w2) + 0.5) if w2 > 0 else 0
    return [x, y, z, w]


def _half(r: Reader):
    z = r.i16()
    w2 = 0x3FFF0001 - z * z
    w = math.floor(math.sqrt(w2) + 0.5) if w2 > 0 else 0
    return [0, 0, z, w]


def _quat_track(r: Reader, loop_frames, byte_idx, flip, half):
    n = r.u16()
    if n == 0:
        return None
    read = _half if half else _full
    if n == 1:
        q = read(r)
        if flip:
            q = [-v for v in q]
        return {"idx": [0], "q": [q], "const": True}
    idx = _indices(r, n, loop_frames, byte_idx)
    qs = []
    for i in range(n):
        q = read(r)
        if i > 0:
            p = qs[-1]
            if sum(a * b for a, b in zip(p, q)) < 0:
                q = [-v for v in q]
        elif flip:
            q = [-v for v in q]
        qs.append(q)
    return {"idx": idx, "q": qs, "const": False}


def _trans_track(r: Reader, loop_frames, byte_idx):
    n = r.u16()
    if n == 0:
        return None
    if n == 1:
        return {"idx": [0], "t": [[r.f32(), r.f32(), r.f32()]], "const": True}
    idx = _indices(r, n, loop_frames, byte_idx)
    small = r.u8() != 0
    mins = [r.f32() for _ in range(3)]
    size = [r.f32() * (0.003921568859368563 if small else 0.00001525902189314365) for _ in range(3)]
    ts = []
    for _ in range(n):
        qv = [r.u8() for _ in range(3)] if small else [r.u16() for _ in range(3)]
        ts.append([mins[k] + size[k] * qv[k] for k in range(3)])
    return {"idx": idx, "t": ts, "const": False}


def read_xanim(path: Path) -> dict:
    """-> {frames, looped, framerate, bones: {name: {"quat": track|None, "trans": track|None}}, notes}"""
    r = Reader(Path(path).read_bytes())
    ver = r.u16()
    if ver != 17:
        raise ValueError(f"{path}: xanim version {ver}, only 17 (IW3/T4) is read here")
    num_frames, num_bones, flags, _asset_type, framerate = r.u16(), r.u16(), r.u8(), r.u8(), r.u16()
    looped = bool(flags & 1)
    loop_frames = num_frames + 1 if looped else num_frames
    frames = loop_frames - 1
    byte_idx = frames < 256
    if flags & 2:   # the delta (root motion) track: read past it
        _quat_track(r, loop_frames, byte_idx, False, True)
        _trans_track(r, loop_frames, byte_idx)
    bones = {}
    if num_bones:
        m = (num_bones + 7) // 8
        flip, half = r.raw(m), r.raw(m)
        names = [r.cstr() for _ in range(num_bones)]
        for i, nm in enumerate(names):
            f = bool(flip[i // 8] & (1 << (i % 8)))
            h = bool(half[i // 8] & (1 << (i % 8)))
            bones[nm] = {"quat": _quat_track(r, loop_frames, byte_idx, f, h),
                         "trans": _trans_track(r, loop_frames, byte_idx)}
    notes = []
    for _ in range(r.u8()):
        notes.append((r.cstr(), r.u16()))
    if r.o != len(r.b):
        raise ValueError(f"{path}: {len(r.b) - r.o} bytes left over -- not the v17 layout")
    return {"frames": frames, "looped": looped, "framerate": framerate, "bones": bones, "notes": notes}


def _sample(track, key, frame):
    """The track's value at `frame` (linear between keys; nlerp for quats)."""
    if track is None:
        return None
    idx, vals = track["idx"], track[key]
    if track["const"] or frame <= idx[0]:
        return list(vals[0])
    if frame >= idx[-1]:
        return list(vals[-1])
    for k in range(1, len(idx)):
        if idx[k] >= frame:
            a, b = idx[k - 1], idx[k]
            t = (frame - a) / (b - a) if b > a else 0.0
            return [vals[k - 1][j] + (vals[k][j] - vals[k - 1][j]) * t for j in range(len(vals[k]))]
    return list(vals[-1])


def pose(anim: dict, frame: int) -> dict:
    """{bone: {"q": [x,y,z,w] unit | None, "t": [x,y,z] | None}} at a frame (engine frame, local)."""
    out = {}
    for nm, tr in anim["bones"].items():
        q = _sample(tr["quat"], "q", frame)
        if q is not None:
            n = math.sqrt(sum(v * v for v in q)) or 1.0
            q = [v / n for v in q]
        out[nm] = {"q": q, "t": _sample(tr["trans"], "t", frame)}
    return out


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        a = read_xanim(Path(p))
        print(p, a["frames"], "frames", len(a["bones"]), "bones", "looped" if a["looped"] else "", a["notes"][:4])
