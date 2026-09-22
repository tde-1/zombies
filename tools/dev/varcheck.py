#!/usr/bin/env python3
"""
varcheck.py -- check the INVARIANTS of T4's script-variable hash table in a running
game, from outside the process, and say the moment they first break.

Why this exists
---------------
docs/kickstart/dedi.md 7j ends with one unanswered question: *what leaves an entry in
a hash slot that is not in the chain it claims*, and one named next measurement --
"count entries that occupy a slot without being in the chain they claim (a sweep of
the pool), and sample it over the spawn to find the frame on which the first orphan
appears". This is that sweep. `varpool.py` counts what is allocated; this one checks
whether the links between them are consistent.

The structure, read off the engine (0x0068F090) and confirmed against the parent
engine's published function shapes (KisakCOD `GetNewVariableIndexInternal3`, used for
NAMES and SHAPE only -- no code taken):

  entry (0x10 bytes) at CHILD_VARS + i*0x10
      +0x0 u16 id    the RECORD this slot's variable lives in (an indirection:
                     slot != record, because collisions move records about)
      +0x2 u16 prev  previous sibling
      +0x4 u32 u     value / next-free
      +0x8 u32 w     type:5, status:2 (0x60 mask), name:24  (w >> 8)
      +0xC u16 v     v.next -- for a HEAD or MOVABLE record, the NEXT SLOT in this
                     hash bucket's circular chain
      +0xE u16 next  next sibling

  status 0x00 = free, 0x20 = MOVABLE, 0x40 = HEAD, 0x60 = EXTERNAL.

The invariant the freeze depends on: every slot whose occupant record is HEAD or
MOVABLE is a member of exactly one circular chain, so across the whole pool each such
slot must be named by exactly ONE record's `v`. A slot named by none is an ORPHAN --
it sits in the table harmlessly until something else hashes to it, and then the
predecessor search at 0x0068F3B4 walks a chain that does not contain it and never
ends. A slot named by two is the other half of the same damage.

Usage:
    python tools/dev/varcheck.py <pid>                    # one sweep
    python tools/dev/varcheck.py <pid> --watch 90 --every 1 --tag join32
Read-only: it never writes the target's memory and never suspends a thread.
"""
import argparse, collections, ctypes, struct, sys, time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400

CHILD_VARS = 0x3974700
N_CHILD = 65536
STRING_MT_BUFFER = 0x3702390

# The engine's temp-memory stack. SV_ExecuteClientMessage (0x630F70) takes the
# offset in this dword, bumps it by 0x20000, decodes the client's compressed
# message into TEMP_BASE + old_offset, and restores the dword on every return
# path. So TEMP_BASE + this value is where the next decoded client message lands,
# and whether it climbs is the difference between a stack and a runaway.
TEMP_OFFSET = 0x46E5054
TEMP_BASE = 0x212B2F8

FREE, MOVABLE, HEAD, EXTERNAL = 0x00, 0x20, 0x40, 0x60


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

    def cstr(self, a, n=64):
        d = self.read(a, n)
        z = d.find(b"\0")
        return d[:z if z >= 0 else n].decode("latin-1", "replace")


def sweep(p):
    """Return (blob, findings) for one coherent-enough read of the child pool.

    Not a snapshot: the game is running, so a single inconsistency seen once is
    noise. Callers should require a finding to persist across sweeps before
    believing it -- `--watch` does exactly that.
    """
    blob = b""
    for off in range(0, N_CHILD * 0x10, 0x40000):
        part = p.read(CHILD_VARS + off, 0x40000)
        if len(part) != 0x40000:
            break
        blob += part
    n = len(blob) // 0x10
    if n < 2:
        return b"", None

    status = bytearray(n)      # 0/0x20/0x40/0x60 of the RECORD this slot points at
    rec = [0] * n
    vnext = [0] * n
    w = [0] * n
    for i in range(n):
        base = i * 0x10
        rec[i] = struct.unpack_from("<H", blob, base)[0]
        w[i] = struct.unpack_from("<I", blob, base + 8)[0]
        vnext[i] = struct.unpack_from("<H", blob, base + 0xC)[0]

    # A slot is "in the table" when the record it points at is a live chain member.
    refs = collections.Counter()
    members = []
    for i in range(1, n):
        r = rec[i]
        st = w[r] & 0x60 if r < n else 0
        status[i] = st
        if st in (MOVABLE, HEAD):
            members.append(i)
            refs[vnext[r]] += 1

    memberset = set(members)
    orphans = [i for i in members if refs[i] == 0]
    dupes = [i for i in members if refs[i] > 1]
    # Two slots sharing one record: the other face of the same damage.
    byrec = collections.Counter(rec[i] for i in members)
    shared = [r for r, c in byrec.items() if c > 1]
    # A chain whose head points at itself while movables still claim it.
    selfheads = [i for i in members if status[i] == HEAD and vnext[rec[i]] == i]
    return blob, dict(n=n, members=len(memberset), orphans=orphans, dupes=dupes,
                      shared=shared, selfheads=len(selfheads), rec=rec, w=w,
                      vnext=vnext, status=status)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pid", type=int)
    ap.add_argument("--watch", type=float, default=0.0, help="seconds to keep sweeping")
    ap.add_argument("--every", type=float, default=1.0)
    ap.add_argument("--show", type=int, default=6, help="how many bad slots to detail")
    a = ap.parse_args()
    p = Proc(a.pid)
    strbase = p.u32(STRING_MT_BUFFER)

    def sname(nid):
        return p.cstr(strbase + nid * 0xC + 4) if (strbase and nid) else ""

    def hexline(blob, i):
        if not blob or (i + 1) * 0x10 > len(blob):
            return "<out of range>"
        return " ".join("%02X" % c for c in blob[i * 0x10:(i + 1) * 0x10])

    t0 = time.time()
    first_bad = None
    prev_orphans = set()
    last_clean = b""       # the newest sweep in which nothing was wrong
    reported = False
    while True:
        blob, f = sweep(p)
        if not f:
            print("pool unreadable (process gone?)")
            return 1
        el = time.time() - t0
        cur = set(f["orphans"])
        # Only report orphans that were already there last sweep: a single read of a
        # live pool catches mid-update states, and those are not damage.
        stable = sorted(cur & prev_orphans) if prev_orphans else []
        toff = p.u32(TEMP_OFFSET)
        print("[%6.1fs] members %d  orphans %d (stable %d)  dupes %d  shared-records %d"
              "  temp +0x%X -> 0x%08X"
              % (el, f["members"], len(cur), len(stable), len(f["dupes"]),
                 len(f["shared"]), toff, (TEMP_BASE + toff) & 0xFFFFFFFF))
        if stable and first_bad is None:
            first_bad = el
            print("  *** FIRST STABLE ORPHAN at t=%.1fs ***" % el)
        for i in stable[:a.show]:
            r = f["rec"][i]
            print("    orphan slot 0x%04X -> record 0x%04X status 0x%02X v.next 0x%04X "
                  "name %r" % (i, r, f["status"][i], f["vnext"][r], sname(f["w"][r] >> 8)))
        for r in f["shared"][:a.show]:
            slots = [i for i in range(1, f["n"]) if f["rec"][i] == r
                     and f["status"][i] in (MOVABLE, HEAD)]
            print("    record 0x%04X claimed by slots %s  name %r"
                  % (r, ["0x%04X" % s for s in slots[:8]], sname(f["w"][r] >> 8)))
        # The first time damage sticks, print the bytes as they were in the last
        # clean sweep beside the bytes as they are now. What changed is the whole
        # question -- a field that moved names the engine write that moved it.
        if stable and not reported and last_clean:
            reported = True
            print("  --- bytes: last clean sweep vs now ---")
            for i in sorted(set(stable) | set(f["shared"]))[:12]:
                r = f["rec"][i]
                print("    slot 0x%04X was %s" % (i, hexline(last_clean, i)))
                print("    slot 0x%04X now %s" % (i, hexline(blob, i)))
                if r != i:
                    print("    rec  0x%04X was %s" % (r, hexline(last_clean, r)))
                    print("    rec  0x%04X now %s" % (r, hexline(blob, r)))
        if not cur and not f["dupes"] and not f["shared"]:
            last_clean = blob
        prev_orphans = cur
        if time.time() - t0 >= a.watch:
            break
        time.sleep(a.every)
    if first_bad is not None:
        print("first stable orphan seen %.1fs into the watch" % first_bad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
