#!/usr/bin/env python3
"""
sample_threads.py -- read-only "where is it spinning" profiler for a live CoDWaW.exe.

Attaches to a running 32-bit game process (from a 64-bit Python via Wow64GetThreadContext),
repeatedly samples each thread's EIP, and maps each sample to the nearest known function start
from the t4map index of our dump. This tells us which function the per-frame loop actually
lives in -- without patching anything.

It briefly suspends each thread to read a coherent context, then resumes immediately (standard
for GetThreadContext). Read-only otherwise; it never writes the target's memory.

Usage: python tools/re/sample_threads.py <pid> [--n 400] [--sleep 0.01]
"""
import ctypes, ctypes.wintypes as wt, sys, time, argparse, collections, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import t4map as T

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
TH32CS_SNAPTHREAD = 0x00000004
THREAD_GET_CONTEXT = 0x0008
THREAD_SUSPEND_RESUME = 0x0002
THREAD_QUERY_INFORMATION = 0x0040
WOW64_CONTEXT_CONTROL = 0x00010001


class THREADENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ThreadID", wt.DWORD),
                ("th32OwnerProcessID", wt.DWORD), ("tpBasePri", ctypes.c_long),
                ("tpDeltaPri", ctypes.c_long), ("dwFlags", wt.DWORD)]


class WOW64_FLOATING_SAVE_AREA(ctypes.Structure):
    _fields_ = [("ControlWord", wt.DWORD), ("StatusWord", wt.DWORD), ("TagWord", wt.DWORD),
                ("ErrorOffset", wt.DWORD), ("ErrorSelector", wt.DWORD), ("DataOffset", wt.DWORD),
                ("DataSelector", wt.DWORD), ("RegisterArea", ctypes.c_byte * 80),
                ("Cr0NpxState", wt.DWORD)]


class WOW64_CONTEXT(ctypes.Structure):
    _fields_ = [("ContextFlags", wt.DWORD),
                ("Dr0", wt.DWORD), ("Dr1", wt.DWORD), ("Dr2", wt.DWORD), ("Dr3", wt.DWORD),
                ("Dr6", wt.DWORD), ("Dr7", wt.DWORD),
                ("FloatSave", WOW64_FLOATING_SAVE_AREA),
                ("SegGs", wt.DWORD), ("SegFs", wt.DWORD), ("SegEs", wt.DWORD), ("SegDs", wt.DWORD),
                ("Edi", wt.DWORD), ("Esi", wt.DWORD), ("Ebx", wt.DWORD), ("Edx", wt.DWORD),
                ("Ecx", wt.DWORD), ("Eax", wt.DWORD), ("Ebp", wt.DWORD), ("Eip", wt.DWORD),
                ("SegCs", wt.DWORD), ("EFlags", wt.DWORD), ("Esp", wt.DWORD), ("SegSs", wt.DWORD),
                ("ExtendedRegisters", ctypes.c_byte * 512)]


def threads_of(pid):
    out = []
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    te = THREADENTRY32(); te.dwSize = ctypes.sizeof(te)
    if k32.Thread32First(snap, ctypes.byref(te)):
        while True:
            if te.th32OwnerProcessID == pid:
                out.append(te.th32ThreadID)
            if not k32.Thread32Next(snap, ctypes.byref(te)):
                break
    k32.CloseHandle(snap)
    return out


PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400


def _is_retaddr(img, v):
    """True if the bytes just before VA `v` are a call instruction, so `v` is a real return
    address rather than data that merely looks like a code pointer."""
    try:
        if img.u8(v - 5) == 0xE8:                     # call rel32
            return True
        b2 = img.data[img.off(v) - 2: img.off(v)]
        if len(b2) == 2 and b2[0] == 0xFF and 0xD0 <= b2[1] <= 0xD7:   # call reg
            return True
        b3 = img.data[img.off(v) - 3: img.off(v)]
        if len(b3) == 3 and b3[0] == 0xFF and (b3[1] & 0x38) == 0x10:  # call r/m (ff /2)
            return True
        b6 = img.data[img.off(v) - 6: img.off(v)]
        if len(b6) == 6 and b6[0] == 0xFF and b6[1] == 0x15:           # call [mem32]
            return True
        b7 = img.data[img.off(v) - 7: img.off(v)]
        if len(b7) == 7 and b7[0] == 0xFF and b7[1] == 0x14:           # call [base+idx*s]
            return True
    except Exception:
        return False
    return False


def sample(pid, n, sl):
    img = T.Image()
    starts = img.idx["starts"]
    lo, hi = img.text["va"], img.text["va"] + img.text["vsize"]
    import bisect, struct
    hits = collections.Counter()          # EIP nearest-func-start -> count
    stackrefs = collections.Counter()     # in-.text return addrs on the stack -> nearest func
    eip_thread = collections.defaultdict(collections.Counter)
    ph = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    ok_reads = 0
    for _ in range(n):
        for tid in threads_of(pid):
            h = k32.OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION,
                               False, tid)
            if not h:
                continue
            try:
                k32.Wow64SuspendThread(h)
                ctx = WOW64_CONTEXT(); ctx.ContextFlags = WOW64_CONTEXT_CONTROL
                ok = k32.Wow64GetThreadContext(h, ctypes.byref(ctx))
                esp = ctx.Esp
                k32.ResumeThread(h)
                if not ok:
                    continue
                if lo <= ctx.Eip < hi:
                    fs = starts[bisect.bisect_right(starts, ctx.Eip) - 1]
                    hits[fs] += 1
                    eip_thread[tid][fs] += 1
                # shallow stack scan for in-.text return addresses (the call chain)
                if ph and esp:
                    buf = (ctypes.c_char * 0x1000)()
                    got = ctypes.c_size_t(0)
                    if k32.ReadProcessMemory(ph, ctypes.c_void_p(esp), buf,
                                             ctypes.c_size_t(0x1000), ctypes.byref(got)):
                        ok_reads += 1
                        data = bytes(buf[:got.value])
                        seen = set()
                        for off in range(0, len(data) - 4):
                            v = struct.unpack_from("<I", data, off)[0]
                            if lo <= v < hi and _is_retaddr(img, v):
                                fs = starts[bisect.bisect_right(starts, v) - 1]
                                if fs not in seen:
                                    seen.add(fs)
                                    stackrefs[fs] += 1
            finally:
                k32.CloseHandle(h)
        time.sleep(sl)
    if ph:
        k32.CloseHandle(ph)
    sys.stderr.write("[sample] stack reads ok: %d\n" % ok_reads)
    return hits, eip_thread, stackrefs


def walk(pid):
    """One ordered EBP-chain stack walk per thread (the thread that contains WinMain is main)."""
    import struct, bisect
    img = T.Image()
    starts = img.idx["starts"]
    lo, hi = img.text["va"], img.text["va"] + img.text["vsize"]
    ph = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)

    def rd(addr, n):
        buf = (ctypes.c_char * n)(); got = ctypes.c_size_t(0)
        if k32.ReadProcessMemory(ph, ctypes.c_void_p(addr), buf, ctypes.c_size_t(n), ctypes.byref(got)):
            return bytes(buf[:got.value])
        return b""

    for tid in threads_of(pid):
        h = k32.OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME, False, tid)
        if not h:
            continue
        k32.Wow64SuspendThread(h)
        ctx = WOW64_CONTEXT(); ctx.ContextFlags = WOW64_CONTEXT_CONTROL
        ok = k32.Wow64GetThreadContext(h, ctypes.byref(ctx))
        k32.ResumeThread(h); k32.CloseHandle(h)
        if not ok:
            continue
        chain = []
        eip, ebp = ctx.Eip, ctx.Ebp
        if lo <= eip < hi:
            chain.append(eip)
        for _ in range(40):
            fr = rd(ebp, 8)
            if len(fr) < 8:
                break
            newebp, ret = struct.unpack("<II", fr)
            if lo <= ret < hi:
                chain.append(ret)
            if newebp <= ebp or newebp == 0:
                break
            ebp = newebp
        if chain:
            print("tid %5d eip 0x%08X:" % (tid, ctx.Eip))
            for a2 in chain:
                fs = starts[bisect.bisect_right(starts, a2) - 1]
                print("    0x%08X  (in 0x%08X)" % (a2, fs))
    if ph:
        k32.CloseHandle(ph)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pid", type=int)
    ap.add_argument("--n", type=int, default=400)
    ap.add_argument("--sleep", type=float, default=0.01)
    ap.add_argument("--walk", action="store_true")
    a = ap.parse_args()
    if a.walk:
        walk(a.pid)
        return
    hits, per, stackrefs = sample(a.pid, a.n, a.sleep)
    print("=== top EIP buckets (func start <= EIP), in-.text only ===")
    for fs, c in hits.most_common(25):
        print("  0x%08X  %5d" % (fs, c))
    print("=== per-thread top EIP bucket ===")
    for tid, cc in per.items():
        top = cc.most_common(1)
        if top:
            print("  tid %5d -> 0x%08X (%d/%d)" % (tid, top[0][0], top[0][1], sum(cc.values())))
    print("=== most-seen in-.text return addresses on stacks (call chain) ===")
    for fs, c in stackrefs.most_common(40):
        print("  0x%08X  %5d" % (fs, c))


if __name__ == "__main__":
    main()
