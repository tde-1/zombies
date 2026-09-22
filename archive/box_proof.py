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
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
HOST = "zombies-dev"
FAKE = "76561198000000001"
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


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def journal_since(since):
    # The host agent colours its log; an ANSI code between `host/inst-02` and `map_loaded` defeats a
    # plain regex (cost the first nuketown run its pass: it loaded at +10 s).
    return ANSI.sub("", ssh("journalctl -u enw-host-agent --since '%s' --no-pager -o cat" % since, timeout=60))


def box_now():
    return ssh("date '+%Y-%m-%d %H:%M:%S'").strip()


def lease(bsp):
    p = subprocess.Popen(["node", os.path.join(REPO, "web", "tools", "lease-cli.js"), "--map", bsp,
                          "--player", FAKE, "--proof"], cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
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
    r = subprocess.run(["node", os.path.join(REPO, "web", "tools", "lease-cli.js"), "--match", match,
                        "--cancel"], cwd=REPO, capture_output=True, text=True)
    return (r.stdout + r.stderr).strip()


def enw_evidence(inst, pid, bsp):
    log = "%s/waw-%s/enw-%s.log" % (ZDEV, inst, pid)
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


def prove(bsp, hold, wait_busy, load_wait=150):
    res = {"map": bsp, "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "unproven": "no client joined; server-side load only"}
    t0 = time.time()
    while True:
        line = last_assignment()
        if is_idle(line):
            break
        if time.time() - t0 > wait_busy:
            res.update(result="skipped", reason="box busy: " + line[-120:])
            return res
        time.sleep(60)
    since = box_now()
    p, match, out = lease(bsp)
    res["match"] = match
    if not match:
        p.kill()
        res.update(result="fail", reason="lease refused: " + " | ".join(out)[-300:])
        return res
    inst = pid = None
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
            other = [x for x in re.findall(r"assignment changed: leased \S+ (m_[0-9a-f]+)", j) if x != match]
            if other:
                preempted = other[0]
                break
            # ...or our lease was dropped to idle by something other than us (23:27-23:33 on
            # 2026-09-22 every lease on the box went idle 3 s after it was made).
            after = j.split("leased %s %s" % (bsp, match), 1)
            if len(after) == 2 and re.search(r"assignment changed: idle\b", after[1]):
                preempted = "idle (our lease was dropped before we cancelled it)"
                break
            m = re.search(r"booted (inst-\d+) match=%s" % match, j)
            if m:
                inst = m.group(1)
            if inst:
                m = re.search(r"instance %s linked \(pid (\d+)" % inst, j)
                if m:
                    pid = m.group(1)
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
            res.update(enw_evidence(inst, pid, bsp))
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
        res["cancel"] = cancel(match)[-200:]
        p.kill()
        t1 = time.time()
        while time.time() - t1 < 90:
            if is_idle(last_assignment()):
                break
            time.sleep(5)
        res["idle_after"] = is_idle(last_assignment())
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--hold", type=int, default=35)
    ap.add_argument("--wait-busy", type=int, default=900)
    ap.add_argument("--load-wait", type=int, default=150,
                    help="seconds to wait for map_loaded (big zones can take >150 s on the box)")
    a = ap.parse_args()
    path = os.path.join(WORK, "reports", "boxproof.json")
    rep = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    for bsp in a.map:
        r = prove(bsp, a.hold, a.wait_busy, a.load_wait)
        rep[bsp] = r
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, indent=1)
        print(json.dumps({k: r.get(k) for k in ("map", "result", "reason", "match", "instance",
                                                 "com_error", "idle_after")}))


if __name__ == "__main__":
    main()
