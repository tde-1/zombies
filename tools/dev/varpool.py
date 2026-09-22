#!/usr/bin/env python3
"""
varpool.py -- read the T4 script child-variable pool out of a running game, from
outside the process, and say what is in it.

Why: the freeze of docs/kickstart/dedi.md 7j and the "exceeded maximum number of
script variables" error are raised by the SAME engine function (0x0068F090, error
sites 0x0068F235 / 0x0068F301), which allocates from the free list whose head is the
word at gScrVarGlob.childVariables[0].u (0x3974704). When that head is 0 the engine
prints the error and carries on with index 0, and a later predecessor search in the
same function walks a chain that no longer terminates -- the spin. So the question is
what fills the pool, and the pool itself is the place to look.

Entry (VariableValueInternal, 0x10 bytes) at 0x3974700 + id*0x10:
    +0x0 u16 hash.id        +0x2 u16 hash.prevSibling
    +0x4 u32 u (value / next-free)
    +0x8 u32 w   bitfield: type:5, status:2 (mask 0x60), unk:1, name:24 (w >> 8)
    +0xC u16 v              +0xE u16 nextSibling
Name ids resolve through the script string table: *(char**)0x3702390 + id*0xC + 4.

Usage:
    python tools/dev/varpool.py <pid>                 # one snapshot
    python tools/dev/varpool.py <pid> --watch 20 --every 2   # snapshots + deltas
Read-only; it never writes the target's memory.
"""
import argparse, ctypes, collections, struct, sys, time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400

CHILD_VARS = 0x3974700
N_CHILD = 65536
# gScrVarGlob.parentVariables[24576] sits immediately before childVariables. It has
# its OWN free list, head = word at 0x3914714, and its own exhaustion path
# (0x0068FCE0) raising the SAME "exceeded maximum number of script variables" string
# that 0x0068FE20 raises for the child pool. A child pool with room says nothing
# about this one -- which is what "the allocator refuses where the accounting says
# there is room" (dedi.md 7j) looks like from the outside.
PARENT_VARS = 0x3914700
N_PARENT = 24576
PARENT_FREE_HEAD = 0x3914714
STRING_MT_BUFFER = 0x3702390


class Proc:
    def __init__(self, pid):
        self.h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not self.h:
            raise SystemExit("OpenProcess failed: %d" % ctypes.get_last_error())

    def read(self, addr, n):
        buf = (ctypes.c_char * n)()
        got = ctypes.c_size_t(0)
        if not k32.ReadProcessMemory(self.h, ctypes.c_void_p(addr), buf,
                                     ctypes.c_size_t(n), ctypes.byref(got)):
            return b""
        return bytes(buf[:got.value])

    def u32(self, a):
        d = self.read(a, 4)
        return struct.unpack("<I", d)[0] if len(d) == 4 else 0

    def cstr(self, a, n=80):
        d = self.read(a, n)
        z = d.find(b"\0")
        return d[:z if z >= 0 else n].decode("latin-1", "replace")


def snapshot(p):
    """Return (free_head, used_count, Counter(name_id), Counter((status,type)))."""
    blob = b""
    # read in 256 KB chunks; the pool is 1 MB
    for off in range(0, N_CHILD * 0x10, 0x40000):
        part = p.read(CHILD_VARS + off, 0x40000)
        if len(part) != 0x40000:
            break
        blob += part
    free_head = struct.unpack_from("<H", blob, 4)[0] if len(blob) >= 6 else 0
    names = collections.Counter()
    kinds = collections.Counter()
    used = 0
    n = len(blob) // 0x10
    for i in range(1, n):
        w = struct.unpack_from("<I", blob, i * 0x10 + 8)[0]
        if w == 0:
            continue
        used += 1
        names[w >> 8] += 1
        kinds[(w & 0x60, w & 0x1F)] += 1
    return free_head, used, names, kinds, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pid", type=int)
    ap.add_argument("--watch", type=int, default=0, help="seconds to keep sampling")
    ap.add_argument("--every", type=float, default=2.0)
    ap.add_argument("--top", type=int, default=20)
    a = ap.parse_args()
    p = Proc(a.pid)

    def strname(nid):
        base = p.u32(STRING_MT_BUFFER)
        return p.cstr(base + nid * 0xC + 4) if (base and nid) else ""

    prev = None
    t0 = time.time()
    while True:
        free_head, used, names, kinds, n = snapshot(p)
        pblob = p.read(PARENT_VARS, N_PARENT * 0x10)
        pused = sum(1 for i in range(1, len(pblob) // 0x10)
                    if struct.unpack_from("<I", pblob, i * 0x10 + 8)[0] != 0)
        phead = struct.unpack_from("<H", pblob, 0x14)[0] if len(pblob) > 0x16 else -1
        el = time.time() - t0
        print("\n[%6.1fs] child: w!=0 %d/%d free-head %d | PARENT: w!=0 %d/%d free-head %d"
              % (el, used, n, free_head, pused, N_PARENT, phead))
        print("  by (status,type): " + ", ".join(
            "0x%02X/%d:%d" % (s, t, c) for (s, t), c in kinds.most_common(10)))
        if prev is None:
            print("  top names: " + ", ".join(
                "%r:%d" % (strname(k) or k, v) for k, v in names.most_common(a.top)))
        else:
            d = collections.Counter()
            for k, v in names.items():
                dv = v - prev.get(k, 0)
                if dv:
                    d[k] = dv
            print("  delta used %+d" % (used - prev_used))
            print("  growing names: " + ", ".join(
                "%r:%+d" % (strname(k) or k, v) for k, v in d.most_common(a.top)))
        prev, prev_used = dict(names), used
        if not a.watch or time.time() - t0 > a.watch:
            break
        time.sleep(a.every)
    return 0


if __name__ == "__main__":
    sys.exit(main())
