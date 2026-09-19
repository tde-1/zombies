#!/usr/bin/env python3
"""
t4map.py -- static analysis helpers for the decrypted CoDWaW.exe image.

Everything here works on the dump produced by ``dump_image.py``, where the section raw
offsets equal the virtual ones, so ``VA == 0x400000 + file offset`` for the whole image.

This is our own tool. It reads Activision code but never copies it anywhere; it emits
addresses and facts. Derived indexes are cached next to the dump (never in the repo).

CLI:
    python tools/re/t4map.py strings <substr> [--limit N]
    python tools/re/t4map.py xref <hexva>              # who points at this address
    python tools/re/t4map.py sxref <substr>            # functions that reference a string
    python tools/re/t4map.py func <hexva>              # function bounds + callers of it
    python tools/re/t4map.py dis <hexva> [--n 40]      # disassemble
    python tools/re/t4map.py callers <hexva>
    python tools/re/t4map.py callees <hexva>
    python tools/re/t4map.py imports [substr]
    python tools/re/t4map.py check                     # sanity-check the dump
"""

import argparse
import bisect
import os
import pickle
import re
import struct
import sys

DUMP = os.environ.get("T4_DUMP", r"C:\Users\b\ZombiesDev\dumps\codwaw-1.7-a.exe")
CACHE_DIR = os.path.join(os.path.dirname(DUMP), "cache")
IMAGE_BASE = 0x400000


# ------------------------------------------------------------------ image


class Image:
    def __init__(self, path=DUMP):
        self.path = path
        with open(path, "rb") as f:
            self.data = f.read()
        self.base = IMAGE_BASE
        self._parse()
        self._idx = None

    def _parse(self):
        d = self.data
        e = struct.unpack_from("<I", d, 0x3C)[0]
        fh = e + 4
        n = struct.unpack_from("<H", d, fh + 2)[0]
        size_opt = struct.unpack_from("<H", d, fh + 16)[0]
        oh = fh + 20
        self.base = struct.unpack_from("<I", d, oh + 28)[0]
        self.entry = struct.unpack_from("<I", d, oh + 16)[0] + self.base
        self.size_of_image = struct.unpack_from("<I", d, oh + 56)[0]
        self.opt = oh
        so = oh + size_opt
        self.sections = []
        for i in range(n):
            o = so + i * 40
            name = d[o:o + 8].rstrip(b"\0").decode("ascii", "replace")
            vsize, vaddr, rsize, raddr = struct.unpack_from("<IIII", d, o + 8)
            chars = struct.unpack_from("<I", d, o + 36)[0]
            self.sections.append({"name": name, "va": self.base + vaddr, "vsize": vsize,
                                  "raddr": raddr, "rsize": rsize, "chars": chars})
        self.text = next(s for s in self.sections if s["name"] == ".text")
        self.rdata = next(s for s in self.sections if s["name"] == ".rdata")
        self.dsec = next(s for s in self.sections if s["name"] == ".data")

    # -- address helpers
    def off(self, va):
        return va - self.base

    def valid(self, va):
        return self.base <= va < self.base + self.size_of_image

    def sect(self, va):
        for s in self.sections:
            if s["va"] <= va < s["va"] + s["vsize"]:
                return s["name"]
        return "?"

    def read(self, va, n):
        o = self.off(va)
        return self.data[o:o + n]

    def u32(self, va):
        return struct.unpack_from("<I", self.data, self.off(va))[0]

    def u8(self, va):
        return self.data[self.off(va)]

    def cstr(self, va, maxlen=512):
        o = self.off(va)
        end = self.data.find(b"\0", o, o + maxlen)
        if end < 0:
            return None
        return self.data[o:end].decode("utf-8", "replace")

    def in_text(self, va):
        return self.text["va"] <= va < self.text["va"] + self.text["vsize"]

    # -- indexes
    @property
    def idx(self):
        if self._idx is None:
            self._idx = build_index(self)
        return self._idx


# ------------------------------------------------------------------ indexing

STR_RE = re.compile(rb"[\x20-\x7e]{4,}\x00")


def build_index(img, force=False):
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = os.path.basename(img.path) + ".idx.pickle"
    cache = os.path.join(CACHE_DIR, key)
    if os.path.exists(cache) and not force:
        try:
            with open(cache, "rb") as f:
                return pickle.load(f)
        except Exception:
            pass
    idx = _build(img)
    with open(cache, "wb") as f:
        pickle.dump(idx, f, protocol=4)
    return idx


def _build(img):
    sys.stderr.write("[t4map] building index (one-off, ~30s)...\n")
    d = img.data

    # 1. strings in .rdata and .data
    strings = {}          # va -> text
    for sec in (img.rdata, img.dsec):
        lo, hi = sec["raddr"], sec["raddr"] + sec["vsize"]
        for m in STR_RE.finditer(d, lo, hi):
            va = img.base + m.start()
            strings[va] = m.group()[:-1].decode("ascii", "replace")

    # 2. call/jmp rel32 -> function starts and the call graph. A byte scan for E8/E9 with a
    #    target inside .text has almost no false positives on this binary and finds far more
    #    entry points than a prologue scan would.
    tlo, thi = img.text["raddr"], img.text["raddr"] + img.text["vsize"]
    unpack = struct.unpack_from
    calls, jmps = [], []
    tva, tend = img.text["va"], img.text["va"] + img.text["vsize"]
    o = tlo
    while o < thi - 5:
        b = d[o]
        if b == 0xE8 or b == 0xE9:
            rel = unpack("<i", d, o + 1)[0]
            tgt = img.base + o + 5 + rel
            if tva <= tgt < tend:
                (calls if b == 0xE8 else jmps).append((img.base + o, tgt))
        o += 1
    call_targets = {}
    for site, tgt in calls:
        call_targets.setdefault(tgt, []).append(site)

    # function pointers stored in .rdata/.data (command tables, vtables, builtin tables) are
    # entry points too -- scan the data sections for values that land inside .text
    fptr_from_data = {}
    for sec in (img.rdata, img.dsec):
        lo, hi = sec["raddr"], sec["raddr"] + sec["vsize"]
        for off in range(lo, hi - 4, 4):
            v = unpack("<I", d, off)[0]
            if tva <= v < tend:
                fptr_from_data.setdefault(v, []).append(img.base + off)
                call_targets.setdefault(v, [])
    starts = sorted(call_targets)
    start_set = set(starts)

    # 3. disassemble each function body and record its real operand references.
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32, CS_OP_IMM, CS_OP_MEM
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    base, top = img.base, img.base + img.size_of_image
    refs_by_func = {}     # func start -> [(site, target, kind)]
    ptr_to = {}           # target -> [site]
    ptr_from = {}         # site -> target
    for i, st in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else tend
        if end - st > 0x8000:
            end = st + 0x8000
        code = d[img.off(st):img.off(end)]
        out = []
        for ins in md.disasm(code, st):
            for op in ins.operands:
                t = None
                if op.type == CS_OP_IMM:
                    t = op.imm & 0xFFFFFFFF
                    kind = "imm"
                elif op.type == CS_OP_MEM and op.mem.base == 0 and op.mem.index == 0:
                    t = op.mem.disp & 0xFFFFFFFF
                    kind = "mem"
                elif op.type == CS_OP_MEM and op.mem.disp and op.mem.base == 0:
                    t = op.mem.disp & 0xFFFFFFFF
                    kind = "mem"
                if t is not None and base <= t < top:
                    out.append((ins.address, t, kind))
                    ptr_to.setdefault(t, []).append(ins.address)
                    ptr_from[ins.address] = t
        refs_by_func[st] = out

    idx = {
        "strings": strings,
        "str_by_text": _group_by_text(strings),
        "ptr_from": ptr_from,
        "ptr_to": ptr_to,
        "refs_by_func": refs_by_func,
        "fptr_from_data": fptr_from_data,
        "calls": calls,
        "jmps": jmps,
        "call_targets": call_targets,
        "starts": starts,
        "start_set": start_set,
    }
    sys.stderr.write("[t4map] %d strings, %d operand refs, %d calls, %d function starts\n"
                     % (len(strings), len(ptr_from), len(calls), len(starts)))
    return idx


def _group_by_text(strings):
    out = {}
    for va, s in strings.items():
        out.setdefault(s, []).append(va)
    return out


# ------------------------------------------------------------------ queries


def func_start(img, va):
    """Best guess at the start of the function containing `va`: the nearest known call
    target at or below it."""
    starts = img.idx["starts"]
    i = bisect.bisect_right(starts, va) - 1
    return starts[i] if i >= 0 else None


def func_end(img, va):
    starts = img.idx["starts"]
    i = bisect.bisect_right(starts, va)
    return starts[i] if i < len(starts) else None


def find_strings(img, substr, limit=60, exact=False):
    out = []
    for va, s in img.idx["strings"].items():
        if (s == substr) if exact else (substr in s):
            out.append((va, s))
    out.sort()
    return out[:limit]


def string_xrefs(img, substr, exact=False, limit=60):
    """-> list of (func_start, site_va, string_va, string)"""
    res = []
    for sva, s in find_strings(img, substr, limit=10000, exact=exact):
        for site in img.idx["ptr_to"].get(sva, []):
            res.append((func_start(img, site), site, sva, s))
    res.sort(key=lambda r: (r[0] or 0, r[1]))
    return res[:limit]


def callers(img, va):
    return sorted(set(func_start(img, s) for s in img.idx["call_targets"].get(va, [])))


def summary(img, start, maxlen=0x4000):
    """Everything cheap we can say about a function: its extent, who calls it, which strings
    it mentions, which globals it touches and who it calls. This is the main identification
    primitive -- a T4 function is usually pinned down by two or three of its strings."""
    end = func_end(img, start) or (start + maxlen)
    if end - start > maxlen:
        end = start + maxlen
    strs, globs, cls = [], [], []
    for site, t, kind in img.idx["refs_by_func"].get(start, []):
        s = img.idx["strings"].get(t)
        if s is not None:
            strs.append((site, t, s))
        elif kind == "mem" or img.sect(t) in (".data", ".rdata"):
            globs.append((site, t, img.sect(t)))
    for site, tgt in img.idx["calls"]:
        if start <= site < end:
            cls.append((site, tgt))
    return {"start": start, "end": end, "size": end - start,
            "callers": [c for c in callers(img, start) if c],
            "strings": strs, "globals": globs, "calls": cls}


def print_summary(img, start, show_globals=True):
    if start not in img.idx["start_set"]:
        real = func_start(img, start)
        print("!! 0x%08X is not a known entry point; using 0x%08X" % (start, real or 0))
        start = real
    d = summary(img, start)
    print("== func 0x%08X .. 0x%08X (0x%X bytes)" % (d["start"], d["end"], d["size"]))
    print("   callers (%d): %s" % (len(d["callers"]),
                                   ", ".join("0x%08X" % c for c in d["callers"][:20])))
    for site, t, s in d["strings"]:
        print("   str  0x%08X -> 0x%08X %r" % (site, t, s[:90]))
    if show_globals:
        seen = set()
        for site, t, sec in d["globals"]:
            if t in seen:
                continue
            seen.add(t)
            print("   glob 0x%08X -> 0x%08X (%s)" % (site, t, sec))
    for site, tgt in d["calls"]:
        print("   call 0x%08X -> 0x%08X" % (site, tgt))


def callees(img, start):
    end = func_end(img, start) or (start + 0x2000)
    out = []
    for site, tgt in img.idx["calls"]:
        if start <= site < end:
            out.append((site, tgt))
    return out


# ------------------------------------------------------------------ disassembly


def disasm(img, va, count=40, show_str=True):
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = False
    code = img.read(va, max(count * 8, 64))
    lines = []
    for i, ins in enumerate(md.disasm(code, va)):
        if i >= count:
            break
        line = "0x%08X  %-24s %s %s" % (ins.address, ins.bytes.hex(), ins.mnemonic, ins.op_str)
        if show_str:
            for m in re.finditer(r"0x([0-9a-f]{6,8})", ins.op_str):
                t = int(m.group(1), 16)
                s = img.idx["strings"].get(t)
                if s:
                    line += "   ; \"%s\"" % s[:70]
        lines.append(line)
    return lines


# ------------------------------------------------------------------ imports


def imports(img):
    """Read the IAT out of the dump. In a dumped image the IAT holds resolved addresses,
    so we also report which loaded module each slot points into (from the dump manifest)."""
    import json
    out = []
    d = img.data
    oh = img.opt
    imp_rva, imp_size = struct.unpack_from("<II", d, oh + 96 + 8)  # DataDirectory[1] = imports
    if not imp_rva:
        return out
    manifest = img.path.rsplit(".", 1)[0] + ".json"
    mods = []
    if os.path.exists(manifest):
        mods = json.load(open(manifest, encoding="utf-8")).get("modules", [])
    mods = sorted([m for m in mods if m["base"]], key=lambda m: m["base"])

    def owner(addr):
        for m in mods:
            if m["base"] <= addr < m["base"] + m["size"]:
                return m["name"]
        return None

    o = imp_rva
    while True:
        oft, _t, _f, name_rva, first = struct.unpack_from("<IIIII", d, o)
        if not name_rva:
            break
        dll = img.cstr(img.base + name_rva, 64)
        t = oft or first
        k = 0
        while True:
            ent = struct.unpack_from("<I", d, t + k * 4)[0]
            if not ent:
                break
            if ent & 0x80000000:
                nm = "#%d" % (ent & 0xFFFF)
            else:
                nm = img.cstr(img.base + ent + 2, 128)
            slot_va = img.base + first + k * 4
            resolved = struct.unpack_from("<I", d, first + k * 4)[0]
            out.append({"dll": dll, "name": nm, "iat_va": slot_va,
                        "resolved": resolved, "module": owner(resolved)})
            k += 1
        o += 20
    return out


# ------------------------------------------------------------------ CLI


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("arg", nargs="?", default="")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--exact", action="store_true")
    ap.add_argument("--dump", default=DUMP)
    a = ap.parse_args()
    img = Image(a.dump)

    if a.cmd == "check":
        print("image base 0x%X  entry 0x%X  size 0x%X" % (img.base, img.entry, img.size_of_image))
        for s in img.sections:
            print("  %-8s VA 0x%08X vsize 0x%08X" % (s["name"], s["va"], s["vsize"]))
        print("  .text[0] = 0x%08X (0x9EF490B8 would mean still encrypted)"
              % img.u32(img.text["va"]))
        print("  %d strings indexed" % len(img.idx["strings"]))
    elif a.cmd == "strings":
        for va, s in find_strings(img, a.arg, a.limit, a.exact):
            print("0x%08X  %s  %r" % (va, img.sect(va), s))
    elif a.cmd == "sxref":
        for fs, site, sva, s in string_xrefs(img, a.arg, a.exact, a.limit):
            print("func 0x%08X  site 0x%08X  str 0x%08X  %r"
                  % (fs or 0, site, sva, s[:80]))
    elif a.cmd == "xref":
        va = int(a.arg, 16)
        for site in img.idx["ptr_to"].get(va, []):
            print("data-ptr site 0x%08X (in func 0x%08X)" % (site, func_start(img, site) or 0))
        for site in img.idx["call_targets"].get(va, []):
            print("call     site 0x%08X (in func 0x%08X)" % (site, func_start(img, site) or 0))
    elif a.cmd == "func":
        va = int(a.arg, 16)
        st = func_start(img, va)
        print("start 0x%08X  next-start 0x%08X" % (st or 0, func_end(img, va) or 0))
        print("callers: %s" % ", ".join("0x%08X" % c for c in callers(img, st) if c))
    elif a.cmd == "sum":
        print_summary(img, int(a.arg, 16))
    elif a.cmd == "callers":
        for c in callers(img, int(a.arg, 16)):
            print("0x%08X" % c)
    elif a.cmd == "callees":
        for site, tgt in callees(img, int(a.arg, 16)):
            print("0x%08X -> 0x%08X" % (site, tgt))
    elif a.cmd == "dis":
        for line in disasm(img, int(a.arg, 16), a.n):
            print(line)
    elif a.cmd == "imports":
        for e in imports(img):
            if not a.arg or a.arg.lower() in (e["name"] or "").lower() \
               or a.arg.lower() in (e["dll"] or "").lower():
                print("%-18s %-34s iat 0x%08X -> %s" % (e["dll"], e["name"], e["iat_va"],
                                                        e["module"] or "?"))
    else:
        ap.error("unknown cmd")


if __name__ == "__main__":
    main()
