#!/usr/bin/env python3
"""
freeze_probe.py -- read the frozen dedicated server's main thread from OUTSIDE the
process: the ordered call stack, the arguments of the frame it is spinning in, and the
script-variable list it is walking.

Written for the freeze of docs/kickstart/dedi.md 7j. `sample_threads.py` says *where*
the main thread is (0x0068F090, 150/150 samples). This says *what it is doing there*:

  * ordered return addresses from ESP upward, so the call chain is in call order rather
    than in "seen on the stack" order -- during a freeze the stack does not move, so a
    stale value scores exactly as high as a live frame and a Counter cannot tell them
    apart;
  * the innermost frame's arguments, read off EBP (0x0068F090 does the standard
    `push ebp; mov ebp, esp`, so EBP is valid mid-body);
  * a walk of the gScrVarGlob childVariables chain the loop at 0x68F3B4..0x68F3DB is
    following, which reports the ring length, whether the id the loop wants is in it,
    and each node's name resolved through the script string table.

Read-only: it suspends a thread briefly to read a coherent context (the same thing any
debugger does) and never writes the target's memory.

Usage: python tools/dev/freeze_probe.py <pid> [--depth 0x800]
"""
import argparse, bisect, ctypes, ctypes.wintypes as wt, os, struct, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "re"))
import t4map as T
import sample_threads as S

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400

CHILD_VARS = 0x3974700          # gScrVarGlob.childVariables
PARENT_VARS = 0x3914700         # gScrVarGlob (parentVariables)
INST_STRIDE = 0x16000           # entries per script instance (x0x10 = 0x160000 bytes)
STRING_MT_BUFFER = 0x3702390    # char** ; string id -> *ptr + id*0xC + 4


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
        return struct.unpack("<I", d)[0] if len(d) == 4 else None

    def u16(self, a):
        d = self.read(a, 2)
        return struct.unpack("<H", d)[0] if len(d) == 2 else None

    def cstr(self, a, n=64):
        d = self.read(a, n)
        z = d.find(b"\0")
        return d[:z if z >= 0 else n].decode("latin-1")


def context_of(tid):
    h = k32.OpenThread(S.THREAD_GET_CONTEXT | S.THREAD_SUSPEND_RESUME, False, tid)
    if not h:
        return None
    k32.Wow64SuspendThread(h)
    ctx = S.WOW64_CONTEXT()
    # CONTROL alone gives EIP/ESP/EBP but leaves the general registers zeroed, which
    # is not "the registers are zero" -- it is "you did not ask for them". INTEGER too.
    ctx.ContextFlags = S.WOW64_CONTEXT_CONTROL | 0x00010002
    ok = k32.Wow64GetThreadContext(h, ctypes.byref(ctx))
    k32.ResumeThread(h)
    k32.CloseHandle(h)
    return ctx if ok else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pid", type=int)
    ap.add_argument("--depth", type=lambda s: int(s, 0), default=0x1000)
    ap.add_argument("--ring", type=int, default=120, help="max ring nodes to walk")
    a = ap.parse_args()

    img = T.Image()
    starts = img.idx["starts"]
    lo, hi = img.text["va"], img.text["va"] + img.text["vsize"]
    p = Proc(a.pid)

    # --- the main thread is the one spinning in .text -------------------------------
    main_tid, main_ctx = 0, None
    for tid in S.threads_of(a.pid):
        c = context_of(tid)
        if c and lo <= c.Eip < hi:
            main_tid, main_ctx = tid, c
            break
    if not main_ctx:
        print("no thread has EIP in .text -- nothing is spinning in engine code")
        return 1
    c = main_ctx
    fs = starts[bisect.bisect_right(starts, c.Eip) - 1]
    print("main tid %d  EIP 0x%08X (in 0x%08X)" % (main_tid, c.Eip, fs))
    print("  eax %08X ebx %08X ecx %08X edx %08X esi %08X edi %08X ebp %08X esp %08X"
          % (c.Eax, c.Ebx, c.Ecx, c.Edx, c.Esi, c.Edi, c.Ebp, c.Esp))

    # --- ordered call stack ---------------------------------------------------------
    print("\n=== return addresses in stack order (innermost first) ===")
    data = p.read(c.Esp, a.depth)
    for off in range(0, len(data) - 4, 4):
        v = struct.unpack_from("<I", data, off)[0]
        if lo <= v < hi and S._is_retaddr(img, v):
            f = starts[bisect.bisect_right(starts, v) - 1]
            print("  esp+0x%04X  0x%08X  (in 0x%08X)" % (off, v, f))

    # --- the frame we are spinning in -----------------------------------------------
    print("\n=== frame at EBP 0x%08X ===" % c.Ebp)
    args = [p.u32(c.Ebp + 4 + 4 * i) for i in range(6)]
    for i, v in enumerate(args):
        print("  [ebp+0x%02X] = 0x%08X%s"
              % (4 + 4 * i, v or 0, "   (return address)" if i == 0 else ""))

    inst = args[1] if args[1] is not None else 0
    target = args[4] if args[4] is not None else 0     # [ebp+0x14], the id searched for
    print("  -> instance=%s  arg2=0x%X arg3=0x%X target([ebp+0x14])=0x%X"
          % (inst, args[2] or 0, args[3] or 0, target))

    base = CHILD_VARS + (inst * INST_STRIDE) * 0x10 if inst < 4 else CHILD_VARS

    def entry(idx):
        ea = base + idx * 0x10
        d = p.read(ea, 0x10)
        if len(d) < 0x10:
            return None
        hid, prevsib = struct.unpack_from("<HH", d, 0)
        u = struct.unpack_from("<I", d, 4)[0]
        w = struct.unpack_from("<I", d, 8)[0]
        v, nextsib = struct.unpack_from("<HH", d, 0xC)
        return dict(addr=ea, id=hid, prev=prevsib, u=u, w=w, v=v, next=nextsib,
                    type=w & 0x1F, status=w & 0x60, name=w >> 8)

    strbase = p.u32(STRING_MT_BUFFER) or 0

    def sname(nid):
        if not nid or not strbase:
            return ""
        return p.cstr(strbase + nid * 0xC + 4)

    def show(tag, idx):
        e = entry(idx)
        if not e:
            print("  %s idx=0x%04X  <unreadable>" % (tag, idx))
            return
        print("  %s idx=0x%04X @0x%08X id=0x%04X prev=0x%04X u=0x%08X w=0x%08X "
              "type=%d status=0x%02X v=0x%04X next=0x%04X name=%d %r"
              % (tag, idx, e["addr"], e["id"], e["prev"], e["u"], e["w"], e["type"],
                 e["status"], e["v"], e["next"], e["name"], sname(e["name"])))

    print("\n=== the id the loop is looking for ===")
    show("target", target & 0xFFFF)

    # --- walk the ring the loop is walking ------------------------------------------
    # cur -> childVar[ childVar[cur].v ].id, stopping when childVar[cur].v == target
    print("\n=== ring walk from the loop's current position (ECX/[esp+0x18]) ===")
    # The loop keeps its cursor in [esp+0x18] (written at 0x0068F39A / 0x0068F3C3), which
    # is readable whatever the EIP happens to be inside the loop body.
    cur = p.u32(c.Esp + 0x18)
    print("  cursor [esp+0x18] = 0x%04X   (edx/target=0x%08X ebx=0x%08X ecx=0x%08X)"
          % ((cur or 0) & 0xFFFF, c.Edx, c.Ebx, c.Ecx))
    if cur is None or cur >= 0x10000:
        print("  cursor out of range")
        return 0
    seen = {}
    found = False
    n = 0
    while n < a.ring:
        e = entry(cur)
        if not e:
            print("  node 0x%04X unreadable" % cur)
            break
        show("node%3d" % n, cur)
        if e["v"] == (target & 0xFFFF):
            found = True
            print("  -> this node's v == target: the loop WOULD stop here")
            break
        if cur in seen:
            print("  -> CYCLE: back at node 0x%04X after %d steps, target 0x%04X NOT in it"
                  % (cur, n - seen[cur], target & 0xFFFF))
            break
        seen[cur] = n
        nxt = entry(e["v"])
        if not nxt:
            print("  next node via v=0x%04X unreadable" % e["v"])
            break
        cur = nxt["id"]
        n += 1
    if not found and n >= a.ring:
        print("  -> walked %d nodes without finding the target and without repeating" % n)

    # --- who, anywhere in the pool, still points at the target? ---------------------
    tgt = target & 0xFFFF
    print("\n=== every entry in the pool that references id 0x%04X ===" % tgt)
    blob = b""
    for off in range(0, 0x10000 * 0x10, 0x40000):
        part = p.read(base + off, 0x40000)
        if len(part) != 0x40000:
            break
        blob += part
    hits = 0
    for i in range(len(blob) // 0x10):
        hid, prev = struct.unpack_from("<HH", blob, i * 0x10)
        v, nxt = struct.unpack_from("<HH", blob, i * 0x10 + 0xC)
        if tgt in (hid, prev, v, nxt) and i != tgt:
            which = ",".join(n for n, x in (("id", hid), ("prev", prev), ("v", v),
                                            ("next", nxt)) if x == tgt)
            if hits < 30:
                show("ref[%s]" % which, i)
            hits += 1
    print("  %d entries reference it" % hits)
    return 0


if __name__ == "__main__":
    sys.exit(main())
