#!/usr/bin/env python3
"""Boot one archived map on the game box through the REAL lease path and say whether it
loads -- the dedi half of "does this map work".

    python archive/box_proof.py --map nuketown [--map ...] [--hold 35] [--load-wait 300]

Per map, strictly one at a time:

  1. The host agent's last `assignment changed:` line must be `idle`. B plays on this
     box: if it is not idle we wait (up to --wait-busy seconds) and otherwise SKIP; we
     never take a second instance beside a live game.
  2. `node web/tools/lease-cli.js --map <bsp> --player 76561198000000001` -- the fake
     SteamID, never a real one. That is the site's own parties.launch(), so the box
     gets exactly the assignment a party's Start would give it (fs_game from the
     map_version row the archive importer wrote).
  3. Watch the journal for `map_loaded <bsp>`; then hold --hold seconds and read the
     instance's own ENW log: `com_frameTime` must have advanced across the hold (the
     fifth gate of dedi.md 12.4 -- a map that loads and then stops simulating is not a
     pass), and the process must still be alive.
  4. `lease-cli --match <m> --cancel`, then wait for the journal to say idle again.

What this does NOT prove, and every result says so: no client joined. A client-side load
(the 32-bit client and a big zone, dedi.md 14.7) is a different question.

Results merge into ZombiesDev\\archive\\reports\\boxproof.json.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
HOST = "zombies-dev"
FAKE = "76561198000000001"   # the popular-64 run; lane 2 uses it now, so --player overrides
FAKES = {"76561198000000001", "76561198000000002", "76561198000000003",
         "76561198000000004"}   # ...0004: the asset-audit lane (archive.md "asset audit")
# --player: tranche 2 leases as ...0002 (the agent-reserved slot) so it never collides with
# lane 2's ...0001. --lease-repo: the checkout whose lease-cli (and web/data DB) the LIVE site
# runs -- a worktree has no web/data, and its web/server may hold unmerged changes.
PLAYER = [FAKE]
LEASE_REPO = [REPO]
ZDEV = "/home/waw/pfx/drive_c/zdev"
MODS = "/home/waw/waw-en/mods"


def ssh(cmd, timeout=60):
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, cmd], capture_output=True, text=True,
                       timeout=timeout)
    return r.stdout


def last_assignment():
    out = ssh("journalctl -u enw-host-agent -n 300 --no-pager | grep 'assignment changed' | tail -1")
    return ANSI.sub("", out).strip()


def is_idle(line):
    return bool(re.search(r"assignment changed: idle\b", line))


# ---- tranche 2 (2026-09-23): the box runs up to three instances now (dedi.md s19) ----------
# "idle" is no longer the question (and s20.2 says journal idle was never safe on its own).
# The question is: is a REAL, verified player in a live instance right now? If so we do not
# lease at all -- the box has ~900 MB of free RAM and a second WaW beside a player's game
# is how that game dies. Reconstructed from the host agent's own journal since it started:
#   booted inst-N match=m_x kind=game map=<bsp>   -> live
#   inst-N auth slot K <name> <id64>: ALLOW ... identity verified   -> a real player in it
#   host/inst/inst-N exit code=...                 -> gone
def live_instances():
    since = ssh("systemctl show enw-host-agent -p ActiveEnterTimestamp --value").strip()
    j = ANSI.sub("", ssh("journalctl -u enw-host-agent --since '%s' --no-pager -o cat | grep -E "
                         "'booted |identity verified|exit code='" % since, timeout=90))
    # (grep only on plain words: the agent colours its log, and an ANSI code sits between
    # `host/inst/inst-N` and `exit` -- the regexes below run after ANSI is stripped)
    live = {}
    for ln in j.splitlines():
        m = re.search(r"booted (inst-\d+) match=(m_[0-9a-f]+) kind=\S+ map=(\S+)", ln)
        if m:
            live[m.group(1)] = {"match": m.group(2), "map": m.group(3), "players": set()}
            continue
        m = re.search(r"(inst-\d+) auth slot \d+ .*?(\d{17}): ALLOW.*identity verified", ln)
        if m and m.group(1) in live:
            live[m.group(1)]["players"].add(m.group(2))
            continue
        m = re.search(r"host/inst/(inst-\d+) exit code=", ln)
        if m:
            live.pop(m.group(1), None)
    return live


def mem_available_mb():
    out = ssh("awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo").strip()
    return int(out) if out.isdigit() else 0


def box_gate(min_mem_mb=650):
    """(ok, why). No live instance may hold a verified player that is not one of our fakes,
    and the box must have min_mem_mb available for our one instance."""
    live = live_instances()
    real = {i: v for i, v in live.items() if v["players"] - FAKES}
    if real:
        return False, "real player live: " + ", ".join("%s %s %s" % (i, v["map"], ",".join(sorted(v["players"])))
                                                     for i, v in real.items())
    mem = mem_available_mb()
    if mem < min_mem_mb:
        return False, "box MemAvailable %d MB < %d MB (%d live instance(s))" % (mem, min_mem_mb, len(live))
    return True, "%d live instance(s), none with a real player; MemAvailable %d MB" % (len(live), mem)


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def journal_since(since):
    # The host agent colours its log; an ANSI code between `host/inst-02` and `map_loaded` defeats a
    # plain regex (cost the first nuketown run its pass: it loaded at +10 s).
    return ANSI.sub("", ssh("journalctl -u enw-host-agent --since '%s' --no-pager -o cat" % since, timeout=60))


def box_now():
    return ssh("date '+%Y-%m-%d %H:%M:%S'").strip()


def lease(bsp):
    p = subprocess.Popen(["node", os.path.join(LEASE_REPO[0], "web", "tools", "lease-cli.js"), "--map", bsp,
                          "--player", PLAYER[0], "--proof"], cwd=LEASE_REPO[0], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True)
    match = None
    t0 = time.time()
    lines = []
    while time.time() - t0 < 20:
        ln = p.stdout.readline()
        if not ln:
            break
        lines.append(ln.strip())
        m = re.search(r"leased (m_[0-9a-f]+)", ln)
        if m:
            match = m.group(1)
            break
    return p, match, lines


def cancel(match):
    r = subprocess.run(["node", os.path.join(LEASE_REPO[0], "web", "tools", "lease-cli.js"), "--match", match,
                        "--cancel"], cwd=LEASE_REPO[0], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def enw_evidence(inst, pid, bsp, copy=None):
    # Since the host went slot-based (dedi.md s19) instance inst-50 runs in the slot's game
    # copy (`wine: .../zdev/waw-inst-01 -> fs_homepath ...`), not in waw-inst-50: the old path
    # read nothing and reported "com_frameTime advanced only 0 ms" for a healthy run.
    log = "%s/enw-%s.log" % (copy or "%s/waw-%s" % (ZDEV, inst), pid)
    txt = ssh("grep -a -E 'com_frameTime=|Com_Error TRAPPED|Sys_Error|liveness' %s | tail -40; "
              "echo ===CONSOLE; grep -a -n -i -E 'script runtime error|error:|exceeded|need [0-9]+ more bytes|"
              "could not|unknown item' %s/%s/console.log | tail -12" % (log, MODS, bsp))
    enw, _, con = txt.partition("===CONSOLE")
    ft = [int(x) for x in re.findall(r"com_frameTime=(\d+)", enw)]
    errs = re.findall(r"Com_Error TRAPPED.*", enw)
    return {"frametime_first": ft[0] if ft else None, "frametime_last": ft[-1] if ft else None,
            "frametime_advance_ms": (ft[-1] - ft[0]) if len(ft) > 1 else 0,
            "com_error": errs[:2], "sys_error": "Sys_Error" in enw,
            "console_errors": [c.strip()[:220] for c in con.strip().splitlines()][:12]}


STOCK = {"nazi_zombie_prototype", "nazi_zombie_asylum", "nazi_zombie_sumpf", "nazi_zombie_factory"}
SAVE_CONSOLE = [None]   # --save-console DIR: keep this run's slice of the map's console.log


def console_paths(bsp):
    """The console.log(s) this map's server writes on the box. A custom map: the one shared
    `waw-en/mods/<bsp>/console.log` (all instances append). A stock map runs without fs_game,
    so each slot's `homes/*/main/console.log`."""
    if bsp in STOCK:
        return ["%s/homes/*/main/console.log" % ZDEV]
    return ["%s/%s/console.log" % (MODS, bsp)]


def console_sizes(bsp):
    out = ssh("for f in %s; do [ -f \"$f\" ] && echo \"$(stat -c %%s \"$f\") $f\"; done; true"
              % " ".join(console_paths(bsp)))
    sizes = {}
    for ln in out.splitlines():
        sz, _, p = ln.partition(" ")
        if sz.isdigit():
            sizes[p] = int(sz)
    return sizes


def save_console(bsp, match, since):
    """Copy the processes our run wrote (every `logfile opened on <t>` segment with t at or
    after the lease, box time) to SAVE_CONSOLE/<bsp>.<match>.console.log. The box's map
    cache evicts a map directory -- console.log included -- whenever it needs the space, so
    this is the only durable copy. (Not a byte offset: a stock slot's main/console.log is
    rewritten, not appended, by a new process.) Read-only on the box. asset_audit.py reads
    these."""
    if not SAVE_CONSOLE[0]:
        return None
    import datetime
    os.makedirs(SAVE_CONSOLE[0], exist_ok=True)
    t0 = datetime.datetime.strptime(since, "%Y-%m-%d %H:%M:%S") - datetime.timedelta(seconds=5)
    saved = []
    for p in console_sizes(bsp):
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, "cat '%s'" % p], capture_output=True, timeout=120)
        keep = []
        for seg in re.split(rb"(?=Build \d+ [^\n]*\n\s*logfile opened on )", r.stdout):
            m = re.search(rb"logfile opened on \w{3} (\w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})", seg[:400])
            if not m:
                continue
            try:
                t = datetime.datetime.strptime(re.sub(rb"\s+", b" ", m.group(1)).decode(), "%b %d %H:%M:%S %Y")
            except ValueError:
                continue
            if t >= t0:
                keep.append(seg)
        if not keep:
            continue
        tag = "" if bsp not in STOCK else "." + p.split("/homes/")[-1].split("/")[0]
        dst = os.path.join(SAVE_CONSOLE[0], "%s.%s%s.console.log" % (bsp, match, tag))
        with open(dst, "wb") as fh:
            fh.write(b"".join(keep))
        saved.append(dst)
    return saved


def prove(bsp, hold, wait_busy, load_wait=150):
    res = {"map": bsp, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "unproven": "no client joined; server-side load only"}
    t0 = time.time()
    while True:
        ok, why = box_gate()
        if ok:
            res["gate"] = why
            break
        print("  waiting: %s" % why, flush=True)
        if time.time() - t0 > wait_busy:
            res.update(result="skipped", reason="box busy: " + why[-160:])
            return res
        time.sleep(60)
    since = box_now()
    p, match, out = lease(bsp)
    res["match"] = match
    if not match:
        p.kill()
        res.update(result="fail", reason="lease refused: " + " | ".join(out)[-300:])
        return res
    inst = pid = copy = None
    loaded_at = None
    exited = None
    preempted = None
    deadline = time.time() + load_wait
    try:
        while time.time() < deadline:
            time.sleep(5)
            j = journal_since(since)
            # Somebody else's lease replaced ours (B, or another lane): the host SIGTERMs our
            # instance. That says nothing about the map (mr_freeze's first run, 22:33:43).
            # Multi-slot (dedi.md s19): another lane's lease no longer replaces ours, so the
            # question is only whether OURS left the host's lease set before we cancelled it.
            # `assignment changed: leased N: m_a (x), m_b (y)` lists every live lease.
            seen = dropped = False
            for ln in (x for x in j.splitlines() if "assignment changed:" in x):
                if match in ln:
                    seen = True
                elif seen:
                    dropped = True
            if dropped:
                preempted = "idle (our lease was dropped before we cancelled it)"
                break
            # A real player arrived on the box while we were testing: give the RAM back now.
            realp = [x for x in re.findall(r"auth slot \d+ .*?(\d{17}): ALLOW.*identity verified", j)
                     if x not in FAKES]
            if realp:
                preempted = "idle (a real player joined the box; our test yielded)"
                break
            m = re.search(r"booted (inst-\d+) match=%s" % match, j)
            if m:
                inst = m.group(1)
            if inst:
                m = re.search(r"instance %s linked \(pid (\d+)" % inst, j)
                if m:
                    pid = m.group(1)
                m = re.search(r"host/inst/%s\s+wine: (\S+) -> fs_homepath" % inst, j)
                if m:
                    copy = m.group(1)
                if re.search(r"%s\s+map_loaded %s\b" % (inst, re.escape(bsp)), j):
                    loaded_at = loaded_at or time.time()
                m = re.search(r"host/inst/%s exit code=(\S+) signal=(\S+)" % inst, j)
                if m:
                    exited = m.group(0)
                    break
            if loaded_at and time.time() - loaded_at >= hold:
                break
        res["instance"], res["pid"] = inst, pid
        res["map_loaded"] = bool(loaded_at)
        if inst and pid:
            res.update(enw_evidence(inst, pid, bsp, copy))
        res["exited"] = exited
        res["preempted_by"] = preempted
        if preempted:
            res.update(result="skipped", reason="pre-empted: %s%s" % (
                preempted if preempted.startswith("idle") else "another lease (%s) replaced ours" % preempted,
                " after map_loaded" if loaded_at else ""))
        elif not loaded_at:
            res.update(result="fail", reason="no map_loaded within %d s" % load_wait + (" (%s)" % exited if exited else ""))
        elif exited:
            res.update(result="fail", reason="map_loaded, then the process exited: " + exited)
        elif res.get("frametime_advance_ms", 0) < 15000:
            res.update(result="fail", reason="map_loaded, but com_frameTime advanced only %s ms "
                       "(engine stopped simulating)" % res.get("frametime_advance_ms"))
        else:
            res.update(result="pass", reason="map_loaded; com_frameTime +%d ms over the hold"
                       % res["frametime_advance_ms"])
    finally:
        try:
            res["console_saved"] = save_console(bsp, match, since)
        except Exception as exc:   # a lost log copy must never leave a lease running
            res["console_saved_error"] = str(exc)[:200]
        res["cancel"] = cancel(match)[-200:]
        p.kill()
        t1 = time.time()
        while time.time() - t1 < 90:
            if not inst or inst not in live_instances():
                break
            time.sleep(5)
        res["idle_after"] = not inst or inst not in live_instances()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--hold", type=int, default=35)
    ap.add_argument("--wait-busy", type=int, default=900)
    ap.add_argument("--load-wait", type=int, default=150,
                    help="seconds to wait for map_loaded (big zones can take >150 s on the box)")
    ap.add_argument("--player", default=FAKE, help="fake SteamID to lease as (never a real one)")
    ap.add_argument("--lease-repo", default=REPO, help="checkout whose web/tools/lease-cli.js the live site uses")
    ap.add_argument("--report", default="boxproof.json", help="reports/<name> to merge results into")
    ap.add_argument("--stage-from-bucket", action="store_true",
                    help="box_stage.py --from-bucket before each lease, --remove after (rotating: the box disk is full)")
    ap.add_argument("--map-list", help="file, one bsp per line (# comments)")
    ap.add_argument("--skip-done", action="store_true", help="skip maps already pass/fail in the report")
    ap.add_argument("--save-console", metavar="DIR",
                    help="keep each run's slice of the map's box console.log in DIR (asset_audit.py reads "
                         "ZombiesDev/archive/logs/box-console/proof-*/)")
    a = ap.parse_args()
    SAVE_CONSOLE[0] = a.save_console
    if a.player not in FAKES:
        raise SystemExit("--player must be one of the fake IDs %s" % sorted(FAKES))
    PLAYER[0], LEASE_REPO[0] = a.player, a.lease_repo
    path = os.path.join(WORK, "reports", a.report)
    rep = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    maps = list(a.map)
    if a.map_list:
        for ln in open(a.map_list, encoding="utf-8"):
            b = ln.split("#")[0].strip().split()
            if b and b[0] not in maps:
                maps.append(b[0])
    stage_py = os.path.join(HERE, "box_stage.py")
    for bsp in maps:
        if a.skip_done and (rep.get(bsp) or {}).get("result") in ("pass", "fail"):
            continue
        staged_by_us = False
        if a.stage_from_bucket:
            ok, why = box_gate()
            while not ok:
                print("  waiting before staging %s: %s" % (bsp, why), flush=True)
                time.sleep(60)
                ok, why = box_gate()
            s = subprocess.run([sys.executable, stage_py, "--map", bsp, "--from-bucket"], capture_output=True,
                               text=True, timeout=1800)
            line = (s.stdout.strip().splitlines() or ["{}"])[-1]
            try:
                st = json.loads(line)
            except ValueError:
                st = {"status": "fail", "error": (s.stdout + s.stderr)[-300:]}
            if st.get("status") != "ok":
                r = {"map": bsp, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "result": "skipped",
                     "reason": "box stage from bucket failed: %s" % st.get("error"), "stage": st}
                rep[bsp] = r
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(rep, fh, indent=1)
                print(json.dumps({k: r.get(k) for k in ("map", "result", "reason")}), flush=True)
                continue
            staged_by_us = st.get("note") != "already installed"
        r = prove(bsp, a.hold, a.wait_busy, a.load_wait)
        if a.stage_from_bucket:
            r["staged_from_bucket"] = staged_by_us
            # Rotate: take our copy off the box again, but never one that was there before us
            # and never while our instance might still be running on it.
            if staged_by_us and r.get("idle_after"):
                rm = subprocess.run([sys.executable, stage_py, "--map", bsp, "--remove"], capture_output=True,
                                    text=True)
                r["removed_after"] = rm.stdout.strip()[-120:]
        rep[bsp] = r
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, indent=1)
        print(json.dumps({k: r.get(k) for k in ("map", "result", "reason", "match", "instance",
                                                 "com_error", "idle_after")}))


if __name__ == "__main__":
    main()
