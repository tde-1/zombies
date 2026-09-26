#!/usr/bin/env python3
"""AV-scan the stored originals and record the result in each sidecar.

Vault 04 rule 6 says map installers are "extracted, never executed, and are AV-scanned",
so the scan has to actually happen and the result has to be recorded truthfully.

MEASURED, and the reason this is its own tool rather than a line in fetch.py:
`MpCmdRun.exe -Scan -ScanType 3 -File <path>` answers

    Scan starting... Scan finished. Scanning <path> was skipped.

and exits **0** without elevation. Treating exit 0 as "clean" -- which the first version
of fetch.py did -- records fourteen files as scanned when not one of them was looked at.
`Start-MpScan -ScanType CustomScan -ScanPath <path>` does run unelevated, so that is
what we use, and the verdict is read from Defender's detection list rather than from an
exit code. If a scan cannot be proven to have happened, the sidecar says so.

  python avscan.py [--force]
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess

WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
ORIGINALS = os.path.join(WORK, "originals")

PS = ["powershell", "-NoProfile", "-NonInteractive", "-Command"]


def defender_status():
    r = subprocess.run(PS + [
        "$s = Get-MpComputerStatus; "
        "'{0}|{1}|{2}|{3}' -f $s.AMServiceEnabled, $s.RealTimeProtectionEnabled, "
        "$s.AntivirusSignatureVersion, $s.AntivirusSignatureLastUpdated"],
        capture_output=True, text=True, timeout=120)
    return (r.stdout or "").strip()


def detections_since(ts):
    """Any Defender detection recorded after ts, as text. Empty means none."""
    q = ("Get-MpThreatDetection -ErrorAction SilentlyContinue | "
         "Where-Object { $_.InitialDetectionTime -gt [datetime]'%s' } | "
         "ForEach-Object { '{0} :: {1} :: {2}' -f $_.InitialDetectionTime, "
         "$_.ThreatID, ($_.Resources -join ',') }" % ts.strftime("%Y-%m-%dT%H:%M:%S"))
    r = subprocess.run(PS + [q], capture_output=True, text=True, timeout=180)
    return (r.stdout or "").strip()


def scan(path):
    if os.name != "nt":
        # The cloud run (Linux) has no Defender and ClamAV's signature CDN refuses it; say so,
        # and main() below re-scans every sidecar whose scan did not run, on B's PC.
        return {"scanner": "none (Linux run)", "engine": None, "ran": False,
                "result": "scan did not run", "detections_during_scan": None,
                "scanned_at": None, "output": "no AV on this host; run avscan.py on Windows"}
    started = datetime.datetime.now() - datetime.timedelta(seconds=2)
    r = subprocess.run(PS + [
        "try { Start-MpScan -ScanType CustomScan -ScanPath '%s' -ErrorAction Stop; "
        "'SCAN_OK' } catch { 'SCAN_FAIL: ' + $_.Exception.Message }"
        % path.replace("'", "''")], capture_output=True, text=True, timeout=1800)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    ok = "SCAN_OK" in out
    hits = detections_since(started) if ok else ""
    if not ok:
        result = "scan did not run"
    elif hits:
        result = "THREAT DETECTED"
    else:
        result = "clean"
    return {"scanner": "Windows Defender (Start-MpScan CustomScan, unelevated)",
            "engine": defender_status(),
            "ran": ok, "result": result,
            "detections_during_scan": hits or None,
            "scanned_at": datetime.datetime.now(datetime.timezone.utc)
                          .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "output": out[-800:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    n = 0
    for norm in sorted(os.listdir(ORIGINALS)):
        d = os.path.join(ORIGINALS, norm)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".meta.json"):
                continue
            mp = os.path.join(d, f)
            meta = json.load(open(mp, encoding="utf-8"))
            if not a.force and (meta.get("av") or {}).get("ran"):
                continue
            target = os.path.join(d, meta["file"])
            res = scan(target)
            meta["av"] = res
            with open(mp, "w", encoding="utf-8") as fh:
                json.dump(meta, fh, indent=2)
            n += 1
            print("%-28s %-16s %s" % (norm, res["result"],
                                      (res["detections_during_scan"] or "")[:60]))
    print("\n%d originals scanned" % n)


if __name__ == "__main__":
    main()
