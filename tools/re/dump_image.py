#!/usr/bin/env python3
"""
dump_image.py -- dump the decrypted CoDWaW.exe image out of a live process.

The Steam build of Call of Duty: World at War 1.7 ships with SteamStub (Steam DRM v2/v3):
the ``.text`` section is encrypted on disk (first dword == 0x9EF490B8) and is decrypted in
memory by the ``.bind`` stub before the real entry point runs. So the only way to look at the
engine's code is to read it back out of a running process.

What this does:
  1. Takes the shared game launch lock (``ZombiesDev\\locks\\game.lock``) -- see docs/dev-box.md
     rule 5. Other agents need the game too, so we hold it for a few seconds only.
  2. Snapshots the CoDWaW.exe PIDs that already exist (we never touch those).
  3. Launches the game windowed + small, waits for SteamStub to decrypt ``.text``.
  4. ReadProcessMemory over the whole image, section by section, at virtual sizes.
  5. Rebuilds a loadable PE where raw offsets/sizes == virtual offsets/sizes and writes it to
     ``C:\\Users\\b\\ZombiesDev\\dumps\\``, with a JSON manifest (module list, hashes, timings).
  6. Terminates only the PID(s) it started, releases the lock.

Dumps contain Activision code. They never leave ZombiesDev\\dumps and are never committed.

Usage:
    python tools/re/dump_image.py                 # launch, dump, kill
    python tools/re/dump_image.py --attach <pid>  # dump a process somebody else is holding
    python tools/re/dump_image.py --keep-running  # dump but leave the game up (keeps the lock!)
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import datetime
import hashlib
import json
import os
import struct
import sys
import time

# ---------------------------------------------------------------------------- config

STEAM_GAME_DIR = r"C:\Program Files (x86)\Steam\steamapps\common\Call of Duty World at War"
EXE_NAME = "CoDWaW.exe"
DUMP_DIR = r"C:\Users\b\ZombiesDev\dumps"
LOCK_PATH = r"C:\Users\b\ZombiesDev\locks\game.lock"
HOME_PATH = r"C:\Users\b\ZombiesDev\homes\re"
AGENT = "re"

# SteamStub leaves this dword at the start of .text while the section is still encrypted.
ENCRYPTED_MARKER = 0x9EF490B8
DECRYPT_TIMEOUT_S = 90.0
LOCK_STALE_S = 15 * 60

# ---------------------------------------------------------------------------- win32

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
PROCESS_TERMINATE = 0x0001
PROCESS_SYNCHRONIZE = 0x00100000
TH32CS_SNAPPROCESS = 0x00000002
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
MAX_PATH = 260
STILL_ACTIVE = 259
CREATE_NEW_PROCESS_GROUP = 0x00000200


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * MAX_PATH),
    ]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("th32ModuleID", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("GlblcntUsage", wt.DWORD), ("ProccntUsage", wt.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_byte)), ("modBaseSize", wt.DWORD),
        ("hModule", wt.HMODULE), ("szModule", ctypes.c_char * 256),
        ("szExePath", ctypes.c_char * MAX_PATH),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
        ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
        ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD), ("dwXCountChars", wt.DWORD),
        ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
        ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
                ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


def list_processes(name=None):
    out = []
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        pe = PROCESSENTRY32()
        pe.dwSize = ctypes.sizeof(PROCESSENTRY32)
        if not k32.Process32First(snap, ctypes.byref(pe)):
            return out
        while True:
            exe = pe.szExeFile.decode("mbcs", "replace")
            if name is None or exe.lower() == name.lower():
                out.append((pe.th32ProcessID, exe, pe.th32ParentProcessID))
            if not k32.Process32Next(snap, ctypes.byref(pe)):
                break
    finally:
        k32.CloseHandle(snap)
    return out


psapi = ctypes.WinDLL("psapi", use_last_error=True)
LIST_MODULES_ALL = 0x03
LIST_MODULES_32BIT = 0x01


class MODULEINFO(ctypes.Structure):
    _fields_ = [("lpBaseOfDll", ctypes.c_void_p), ("SizeOfImage", wt.DWORD),
                ("EntryPoint", ctypes.c_void_p)]


# ctypes defaults every un-annotated integer argument to C int, which overflows on 64-bit
# module handles; annotate the psapi imports we use.
psapi.EnumProcessModulesEx.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_void_p), wt.DWORD,
                                       ctypes.POINTER(wt.DWORD), wt.DWORD]
psapi.EnumProcessModulesEx.restype = wt.BOOL
psapi.GetModuleFileNameExW.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.LPWSTR, wt.DWORD]
psapi.GetModuleFileNameExW.restype = wt.DWORD
psapi.GetModuleInformation.argtypes = [wt.HANDLE, ctypes.c_void_p,
                                       ctypes.POINTER(MODULEINFO), wt.DWORD]
psapi.GetModuleInformation.restype = wt.BOOL


def list_modules_psapi(pid):
    """Module list via psapi. Works from 64-bit python against a WOW64 (32-bit) target,
    where CreateToolhelp32Snapshot often just returns ERROR_PARTIAL_COPY."""
    h = open_process(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
    try:
        n = 1024
        arr = (ctypes.c_void_p * n)()
        needed = wt.DWORD()
        if not psapi.EnumProcessModulesEx(h, arr, ctypes.sizeof(arr), ctypes.byref(needed),
                                          LIST_MODULES_ALL):
            raise ctypes.WinError(ctypes.get_last_error())
        count = min(n, needed.value // ctypes.sizeof(ctypes.c_void_p))
        mods = []
        for i in range(count):
            buf = ctypes.create_unicode_buffer(MAX_PATH * 2)
            psapi.GetModuleFileNameExW(h, arr[i], buf, len(buf))
            mi = MODULEINFO()
            psapi.GetModuleInformation(h, arr[i], ctypes.byref(mi), ctypes.sizeof(mi))
            path = buf.value
            mods.append({"name": os.path.basename(path), "base": mi.lpBaseOfDll or 0,
                         "size": mi.SizeOfImage, "path": path})
        return mods
    finally:
        k32.CloseHandle(h)


def list_modules(pid):
    """Module list of a 32-bit process, read from a 64-bit python."""
    try:
        mods = list_modules_psapi(pid)
        if mods:
            return mods
    except OSError:
        pass
    mods = []
    for _ in range(3):  # the loader is still mapping things; retry on ERROR_BAD_LENGTH
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if snap != -1:
            break
        time.sleep(0.05)
    else:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        me = MODULEENTRY32()
        me.dwSize = ctypes.sizeof(MODULEENTRY32)
        if not k32.Module32First(snap, ctypes.byref(me)):
            return mods
        while True:
            mods.append({
                "name": me.szModule.decode("mbcs", "replace"),
                "base": ctypes.cast(me.modBaseAddr, ctypes.c_void_p).value or 0,
                "size": me.modBaseSize,
                "path": me.szExePath.decode("mbcs", "replace"),
            })
            if not k32.Module32Next(snap, ctypes.byref(me)):
                break
    finally:
        k32.CloseHandle(snap)
    return mods


def open_process(pid, access):
    h = k32.OpenProcess(access, False, pid)
    if not h:
        raise ctypes.WinError(ctypes.get_last_error())
    return h


def read_mem(h, addr, size):
    """Read `size` bytes; returns bytes (short or zero-padded if parts are unreadable)."""
    buf = (ctypes.c_char * size)()
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, ctypes.c_size_t(size),
                               ctypes.byref(got))
    if ok and got.value == size:
        return bytes(buf)
    # Partial / failed: fall back to page-by-page so one bad page doesn't lose the section.
    out = bytearray(size)
    page = 0x1000
    for off in range(0, size, page):
        n = min(page, size - off)
        pbuf = (ctypes.c_char * n)()
        g = ctypes.c_size_t(0)
        if k32.ReadProcessMemory(h, ctypes.c_void_p(addr + off), pbuf, ctypes.c_size_t(n),
                                 ctypes.byref(g)) and g.value == n:
            out[off:off + n] = bytes(pbuf)
    return bytes(out)


def read_u32(h, addr):
    b = read_mem(h, addr, 4)
    return struct.unpack("<I", b)[0] if len(b) == 4 else None


def process_alive(pid):
    try:
        h = open_process(pid, PROCESS_QUERY_INFORMATION)
    except OSError:
        return False
    try:
        code = wt.DWORD()
        k32.GetExitCodeProcess(h, ctypes.byref(code))
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(h)


# ---------------------------------------------------------------------------- lock


def lock_take(what):
    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    if os.path.exists(LOCK_PATH):
        try:
            txt = open(LOCK_PATH, "r", encoding="utf-8").read().strip()
        except OSError:
            txt = ""
        stale = False
        age = time.time() - os.path.getmtime(LOCK_PATH)
        parts = txt.split()
        if age > LOCK_STALE_S:
            stale = True
        if len(parts) >= 2 and parts[1].isdigit() and not process_alive(int(parts[1])):
            stale = True
        if not stale:
            raise SystemExit("game.lock held by: %r (age %.0fs) -- not taking it" % (txt, age))
        print("[lock] taking stale lock %r (age %.0fs)" % (txt, age))
    _write_lock("starting", what)
    return True


def _write_lock(pid, what):
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    with open(LOCK_PATH, "w", encoding="utf-8") as f:
        f.write("%s %s %s %s\n" % (AGENT, pid, now, what))


def lock_release():
    try:
        os.remove(LOCK_PATH)
        print("[lock] released")
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------- launch


def launch_game(game_dir):
    """Start CoDWaW.exe windowed+small. Returns (pid, handle, pre_existing_pids)."""
    exe = os.path.join(game_dir, EXE_NAME)
    if not os.path.isfile(exe):
        raise SystemExit("no exe at %s" % exe)
    pre = {p for p, _, _ in list_processes(EXE_NAME)}
    if pre:
        print("[launch] NOTE %d CoDWaW.exe already running (%s) -- we will not touch them"
              % (len(pre), sorted(pre)))
    os.makedirs(HOME_PATH, exist_ok=True)
    # Windowed, small, muted, no intro. Nothing here writes to the Steam folder.
    cmdline = ('"%s" +set r_fullscreen 0 +set r_mode "800x600" +set s_volume 0 '
               '+set com_introPlayed 1 +set fs_homepath "%s"' % (exe, HOME_PATH))
    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    pi = PROCESS_INFORMATION()
    ok = k32.CreateProcessW(exe, ctypes.create_unicode_buffer(cmdline), None, None, False,
                            CREATE_NEW_PROCESS_GROUP, None, game_dir,
                            ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    k32.CloseHandle(pi.hThread)
    print("[launch] pid %d" % pi.dwProcessId)
    return pi.dwProcessId, pi.hProcess, pre


def find_relaunched(pre, ours):
    """SteamStub may restart the game through Steam. Anything that is CoDWaW.exe, was not there
    before we started and is not our pid, is a relaunch of ours -- we own it and must clean up."""
    now = {p for p, _, _ in list_processes(EXE_NAME)}
    return sorted(now - pre - {ours})


# ---------------------------------------------------------------------------- dump


def find_main_module(pid, exe_name=EXE_NAME):
    for _ in range(100):
        if not process_alive(pid):
            raise SystemExit("pid %d is gone" % pid)
        try:
            for m in list_modules(pid):
                if m["name"].lower() == exe_name.lower():
                    return m
        except OSError:
            pass
        time.sleep(0.05)
    # Last resort: CoDWaW.exe has DllCharacteristics 0 (no ASLR), so it always loads at its
    # preferred base. Verify there is an MZ there and use it.
    h = open_process(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
    try:
        if read_mem(h, 0x400000, 2) == b"MZ":
            print("[dump] module list unavailable; using fixed image base 0x400000")
            return {"name": exe_name, "base": 0x400000, "size": 0, "path": "?"}
    finally:
        k32.CloseHandle(h)
    raise SystemExit("main module never appeared in pid %d" % pid)


def parse_headers(hdr):
    """Minimal PE parse of the in-memory header page(s)."""
    e_lfanew = struct.unpack_from("<I", hdr, 0x3C)[0]
    assert hdr[e_lfanew:e_lfanew + 4] == b"PE\0\0", "no PE signature"
    fh = e_lfanew + 4
    n_sections = struct.unpack_from("<H", hdr, fh + 2)[0]
    size_opt = struct.unpack_from("<H", hdr, fh + 16)[0]
    oh = fh + 20
    image_base = struct.unpack_from("<I", hdr, oh + 28)[0]
    section_align = struct.unpack_from("<I", hdr, oh + 32)[0]
    size_of_image = struct.unpack_from("<I", hdr, oh + 56)[0]
    size_of_headers = struct.unpack_from("<I", hdr, oh + 60)[0]
    entry = struct.unpack_from("<I", hdr, oh + 16)[0]
    sect_off = oh + size_opt
    sections = []
    for i in range(n_sections):
        o = sect_off + i * 40
        name = hdr[o:o + 8].rstrip(b"\0").decode("ascii", "replace")
        vsize, vaddr, rsize, raddr = struct.unpack_from("<IIII", hdr, o + 8)
        chars = struct.unpack_from("<I", hdr, o + 36)[0]
        sections.append({"i": i, "off": o, "name": name, "vsize": vsize, "vaddr": vaddr,
                         "rsize": rsize, "raddr": raddr, "chars": chars})
    return {"e_lfanew": e_lfanew, "opt": oh, "sect_off": sect_off, "n": n_sections,
            "image_base": image_base, "section_align": section_align,
            "size_of_image": size_of_image, "size_of_headers": size_of_headers,
            "entry": entry, "sections": sections}


def wait_for_decrypt(h, base, text_va, timeout=DECRYPT_TIMEOUT_S):
    """SteamStub decrypts .text before the real OEP. Poll the first dword."""
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        v = read_u32(h, base + text_va)
        if v is not None and v != last:
            print("[wait] .text[0] = 0x%08X at t+%.2fs" % (v, time.time() - t0))
            last = v
        if v is not None and v != ENCRYPTED_MARKER and v != 0:
            return True, time.time() - t0
        time.sleep(0.05)
    return False, time.time() - t0


def dump(pid, out_stem, keep_running=False, own_handle=None):
    h = open_process(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
    try:
        mod = find_main_module(pid)
        base = mod["base"]
        print("[dump] %s base 0x%08X size 0x%X" % (mod["name"], base, mod["size"]))
        hdr = read_mem(h, base, 0x1000)
        pe = parse_headers(hdr)
        text = next(s for s in pe["sections"] if s["name"] == ".text")
        ok, waited = wait_for_decrypt(h, base, text["vaddr"])
        if not ok:
            raise SystemExit("SteamStub never decrypted .text (still 0x%08X)"
                             % (read_u32(h, base + text["vaddr"]) or 0))
        print("[dump] decrypted after %.2fs" % waited)
        # Give the stub a moment to finish the rest of its fixups, then re-read the headers.
        time.sleep(0.5)
        hdr = read_mem(h, base, 0x1000)
        pe = parse_headers(hdr)

        image = bytearray(pe["size_of_image"])
        image[0:0x1000] = hdr
        per_section = []
        for s in pe["sections"]:
            n = s["vsize"]
            if n == 0:
                continue
            end = min(s["vaddr"] + n, pe["size_of_image"])
            n = end - s["vaddr"]
            t0 = time.time()
            data = read_mem(h, base + s["vaddr"], n)
            image[s["vaddr"]:s["vaddr"] + n] = data
            nz = sum(1 for i in range(0, n, 0x1000) if data[i:i + 16] != b"\0" * 16)
            per_section.append({"name": s["name"], "vaddr": s["vaddr"], "vsize": s["vsize"],
                                "read": len(data), "nonzero_pages_sampled": nz,
                                "secs": round(time.time() - t0, 2)})
            print("[dump]  %-8s VA 0x%08X %9d bytes  (%.2fs)"
                  % (s["name"], s["vaddr"], n, time.time() - t0))

        # Rewrite the section table so raw offset/size == virtual offset/size, and make the
        # file alignment match the section alignment. The result loads and parses like a
        # normal PE with every address equal to base + file offset.
        struct.pack_into("<I", image, pe["opt"] + 36, pe["section_align"])  # FileAlignment
        for s in pe["sections"]:
            vs = s["vsize"]
            aligned = (vs + pe["section_align"] - 1) & ~(pe["section_align"] - 1)
            if s["vaddr"] + aligned > pe["size_of_image"]:
                aligned = pe["size_of_image"] - s["vaddr"]
            struct.pack_into("<II", image, s["off"] + 16, aligned, s["vaddr"])  # RawSize, RawPtr

        os.makedirs(DUMP_DIR, exist_ok=True)
        path = os.path.join(DUMP_DIR, out_stem + ".exe")
        with open(path, "wb") as f:
            f.write(image)
        digest = hashlib.sha256(image).hexdigest().upper()
        manifest = {
            "created": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "agent": AGENT,
            "source_exe": os.path.join(STEAM_GAME_DIR, EXE_NAME),
            "pid": pid,
            "module_base": base,
            "image_base": pe["image_base"],
            "size_of_image": pe["size_of_image"],
            "entry_rva": pe["entry"],
            "decrypt_wait_s": round(waited, 2),
            "dump_sha256": digest,
            "dump_bytes": len(image),
            "sections": per_section,
            "modules": list_modules(pid),
            "note": "raw offsets/sizes rewritten to equal virtual ones; "
                    "VA = image_base + file offset",
        }
        with open(os.path.join(DUMP_DIR, out_stem + ".json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print("[dump] wrote %s (%d bytes, sha256 %s)" % (path, len(image), digest))
        return path, manifest
    finally:
        k32.CloseHandle(h)


def kill(pid):
    try:
        h = open_process(pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE)
    except OSError as e:
        print("[kill] pid %d: %s" % (pid, e))
        return
    try:
        k32.TerminateProcess(h, 0)
        k32.WaitForSingleObject(h, 5000)
        print("[kill] pid %d terminated" % pid)
    finally:
        k32.CloseHandle(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir", default=STEAM_GAME_DIR)
    ap.add_argument("--attach", type=int, default=0,
                    help="dump this already-running pid instead of launching")
    ap.add_argument("--keep-running", action="store_true")
    ap.add_argument("--name", default=None, help="dump file stem")
    args = ap.parse_args()

    stem = args.name or ("codwaw-%s" % time.strftime("%Y%m%d-%H%M%S"))

    if args.attach:
        dump(args.attach, stem, keep_running=True)
        return

    lock_take("dump decrypted CoDWaW.exe image")
    pid = None
    extra = []
    try:
        pid, hproc, pre = launch_game(args.game_dir)
        _write_lock(pid, "dump decrypted CoDWaW.exe image")
        time.sleep(1.0)
        extra = find_relaunched(pre, pid)
        if extra:
            print("[launch] steam relaunched us as %s" % extra)
        target = pid if process_alive(pid) else (extra[0] if extra else None)
        if target is None:
            raise SystemExit("game exited immediately and no relaunch found")
        if target != pid:
            print("[launch] our pid died; dumping relaunched pid %d" % target)
        dump(target, stem)
    finally:
        if not args.keep_running:
            for p in ([pid] if pid else []) + extra:
                if p and process_alive(p):
                    kill(p)
            lock_release()


if __name__ == "__main__":
    sys.exit(main() or 0)
