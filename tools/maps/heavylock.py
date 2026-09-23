#!/usr/bin/env python3
"""One heavy job machine-wide: ZombiesDev\\locks\\heavy.lock plus a memory gate.

B's PC froze on 2026-09-23 with seven agents + an export + a soak + an upload running at
once (fixed 4.8 GB pagefile). The rule since: before an export, a build or a game launch,
commit charge must be under 85 % of the commit limit and free RAM over 5 GB, and the job
holds heavy.lock (pid + purpose) so only one runs at a time. A lock whose pid is dead is
stale and is taken over.

    python tools/maps/heavylock.py run --why "oat build" -- <command...>
    python tools/maps/heavylock.py status

As a module: `with heavy("export nacht"): ...`.
"""
import ctypes
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

LOCK = Path(os.environ.get("ZOMBIES_DEV", r"C:\Users\b\ZombiesDev")) / "locks" / "heavy.lock"
MAX_COMMIT = 0.85
MIN_FREE_GB = 5.0


class _PerfInfo(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("CommitTotal", ctypes.c_size_t), ("CommitLimit", ctypes.c_size_t),
                ("CommitPeak", ctypes.c_size_t), ("PhysicalTotal", ctypes.c_size_t),
                ("PhysicalAvailable", ctypes.c_size_t), ("SystemCache", ctypes.c_size_t),
                ("KernelTotal", ctypes.c_size_t), ("KernelPaged", ctypes.c_size_t),
                ("KernelNonpaged", ctypes.c_size_t), ("PageSize", ctypes.c_size_t),
                ("HandleCount", ctypes.c_ulong), ("ProcessCount", ctypes.c_ulong), ("ThreadCount", ctypes.c_ulong)]


def memory():
    """(commit fraction, free physical GB)."""
    p = _PerfInfo()
    p.cb = ctypes.sizeof(p)
    ctypes.windll.psapi.GetPerformanceInfo(ctypes.byref(p), p.cb)
    return p.CommitTotal / p.CommitLimit, p.PhysicalAvailable * p.PageSize / 2 ** 30


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return code.value == 259  # STILL_ACTIVE


def holder():
    try:
        txt = LOCK.read_text(encoding="utf-8-sig", errors="replace").strip()
    except OSError:
        return None, ""
    try:
        return int(txt.split()[0]), txt
    except (ValueError, IndexError):
        return 0, txt


def acquire(why: str, wait_s: float = 3600, log=print):
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + wait_s
    said = None
    while True:
        pid, txt = holder()
        if pid is not None and str(pid) == os.environ.get("ZM_HEAVY_LOCK_PID") and pid_alive(pid):
            return  # re-entrant: a parent (`heavylock.py run`) already holds it for us
        if pid is not None and pid != os.getpid() and pid_alive(pid):
            msg = f"heavy.lock held: {txt}"
        else:
            if pid is not None and pid != os.getpid():
                LOCK.unlink(missing_ok=True)  # stale: its pid is gone
            commit, free = memory()
            if commit < MAX_COMMIT and free > MIN_FREE_GB:
                try:
                    fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.write(fd, f"{os.getpid()} {time.strftime('%Y-%m-%dT%H:%M:%S')} {why}".encode())
                    os.close(fd)
                    return
                except FileExistsError:
                    continue
            msg = f"memory gate: commit {commit:.0%} (max {MAX_COMMIT:.0%}), free {free:.1f} GB (min {MIN_FREE_GB})"
        if time.time() > deadline:
            raise TimeoutError(msg)
        if msg != said:
            log(f"[heavylock] waiting -- {msg}")
            said = msg
        time.sleep(10)


def release():
    pid, _ = holder()
    if pid == os.getpid():
        LOCK.unlink(missing_ok=True)


@contextmanager
def heavy(why: str, wait_s: float = 3600, log=print):
    acquire(why, wait_s, log)
    try:
        yield
    finally:
        release()


def main(argv):
    if not argv or argv[0] == "status":
        c, f = memory()
        print(f"commit {c:.1%}  free {f:.1f} GB  lock: {holder()[1] or '(free)'}")
        return 0
    if argv[0] == "run":
        why = "heavy job"
        rest = argv[1:]
        if rest[:1] == ["--why"]:
            why, rest = rest[1], rest[2:]
        if rest[:1] == ["--"]:
            rest = rest[1:]
        with heavy(why):
            # Children that take the lock themselves (export_all.py per map) see it as theirs.
            return subprocess.call(rest, env=dict(os.environ, ZM_HEAVY_LOCK_PID=str(os.getpid())))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
