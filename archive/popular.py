#!/usr/bin/env python3
"""The popular-50 run (2026-09-22 evening): one table from every report it produced.

    python archive/popular.py --apply      # write each box result into its manifest
    python archive/popular.py              # print the table

Inputs, all under ZombiesDev\\archive\\reports:
  popular.json   rank_popular.py -- the ranked candidates and their popularity signal
  fetch.json     fetch.py        -- the original, its sha256 and AV verdict
  extract.json   extract.py      -- the normalised mods/<bsp>/
  precheck.json  precheck.py     -- the static read against the known killers
  boxproof.json  box_proof.py    -- the lease on the box: map_loaded + com_frameTime
  boxstage.json  (this run)      -- the box install

`--apply` writes, per map with a box result, into archive/manifests/<bsp>.json:
  pass -> dedi_status "box_map_loaded" (server only; health untouched)
  fail -> health "broken" + dedi_status "box_failed", with the reason
so `web/server/db/import-archive.js` hides a map the box could not load.
"""
import argparse
import json
import os
import re
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.environ.get("ENW_ARCHIVE_WORK", r"C:\Users\b\ZombiesDev\archive")
MANIFESTS = os.path.join(HERE, "manifests")
SITE_DB = os.path.join(REPO, "web", "data", "zombies.db")


def load(name, default):
    p = os.path.join(WORK, "reports", name)
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def rows():
    pop = load("popular.json", [])
    fetch = {f["norm"]: f for f in load("fetch.json", [])}
    ext = {e["norm"]: e for e in load("extract.json", [])}
    pre = load("precheck.json", {})
    proof = load("boxproof.json", {})
    stage = load("boxstage.json", {})
    site = {}
    try:
        db = sqlite3.connect("file:%s?mode=ro" % SITE_DB, uri=True)
        for k, h, art in db.execute("SELECT key, health, art FROM maps WHERE source='custom'"):
            site[k] = {"health": h, "art": art}
    except Exception:
        pass
    out = []
    for i, p in enumerate(pop, 1):
        n = p["norm"]
        f = fetch.get(n, {})
        e = ext.get(n, {})
        mods = e.get("mods") or []
        bsp = mods[0]["map"] if mods else None
        r = {"rank": i, "norm": n, "name": p["name"], "views": p["views"], "top100": p["top100"],
             "fetch": f.get("status"), "av": f.get("av"), "size": f.get("size"),
             "bsp": bsp, "extract_errors": e.get("errors"),
             "precheck": (pre.get(bsp) or {}).get("flags") if bsp else None,
             "zone_mb": (pre.get(bsp) or {}).get("map_zone_inflated_mb") if bsp else None,
             "stage": (stage.get(bsp) or {}).get("status") if bsp else None,
             "stage_error": (stage.get(bsp) or {}).get("error") if bsp else None,
             "box": (proof.get(bsp) or {}).get("result") if bsp else None,
             "box_reason": (proof.get(bsp) or {}).get("reason") if bsp else None,
             "match": (proof.get(bsp) or {}).get("match") if bsp else None,
             "retries": (proof.get(bsp) or {}).get("retries_not_counted") if bsp else None,
             "site": site.get(bsp, {}).get("health") if bsp else None}
        out.append(r)
    return out


def first_cause(bsp):
    """The engine's own first complaint, out of the proof's console lines (dedi.md 11.4:
    read the FIRST error; `snddriverglobals` after it is the restart, never the cause)."""
    p = (load("boxproof.json", {}).get(bsp) or {})
    for c in p.get("console_errors") or []:
        t = c.split(":", 1)[1] if ":" in c else c
        low = t.lower()
        if "[enw]" in low or "could not find zone" in low or "snddriverglobals" in low:
            continue
        if low.strip() in ("error:", "") or "started from" in low or "called from" in low or "*****" in low:
            continue
        if "error" in low or "could not" in low or "exceeded" in low or "more bytes" in low \
                or "unknown item" in low:
            return t.strip().replace("Error: ", "")[:140]
    return None


def verdict(r):
    if r["fetch"] != "ok":
        return "not fetched: %s" % (r["fetch"] or "not attempted")
    if not r["bsp"]:
        return "extract failed: %s" % "; ".join(r["extract_errors"] or ["no mods/ tree"])
    if r["stage"] == "fail":
        return "box install failed: %s" % r["stage_error"]
    if r["box"] == "pass":
        return "**PASS**" + (" (reclassified: the first run's exit was another lease's SIGTERM, "
                             "44 s after map_loaded)" if "reclassified" in (r["box_reason"] or "") else "")
    if r["box"] == "fail":
        cause = first_cause(r["bsp"])
        return "**FAIL** — %s%s%s" % (r["box_reason"], ("; first error: `%s`" % cause) if cause else "",
                                     " (1 clean run; %d retr%s pre-empted, not counted)"
                                     % (len(r["retries"]), "y" if len(r["retries"]) == 1 else "ies")
                                     if r["retries"] else "")
    if r["box"] == "skipped":
        return "not run — %s" % r["box_reason"]
    return "not run"


def table(rs):
    L = ["| # | Map | UGX/codrepo views | bsp | size | pre-check | box (dedicated, lease) | site |",
         "|---:|---|---:|---|---:|---|---|---|"]
    for r in rs:
        L.append("| %d | %s%s | %s | %s | %s | %s | %s | %s |" % (
            r["rank"], r["name"].replace("|", "/"), " (top 100)" if r["top100"] else "",
            "{:,}".format(r["views"]), "`%s`" % r["bsp"] if r["bsp"] else "-",
            "%.0f MB" % (r["size"] / 2**20) if r["size"] else "-",
            ", ".join(r["precheck"] or []) or ("-" if r["bsp"] else ""),
            verdict(r).replace("|", "/"), r["site"] or "-"))
    return "\n".join(L)


def summary(rs):
    got = [r for r in rs if r["fetch"] == "ok"]
    ext = [r for r in got if r["bsp"]]
    ran = [r for r in ext if r["box"] in ("pass", "fail")]
    ok = [r for r in ran if r["box"] == "pass"]
    site = [r for r in ext if r["site"] and r["site"] != "broken"]
    return ("%d ranked; %d fetched and AV-clean; %d extracted to a `mods/<bsp>/`; %d booted on the box "
            "through a real lease; **%d reached `map_loaded` and kept simulating**, %d did not; "
            "%d are on the site's Maps list (health not `broken`)."
            % (len(rs), len([r for r in got if r["av"] == "clean"]), len(ext), len(ran), len(ok),
               len(ran) - len(ok), len(site)))


def doc_values():
    rs = rows()
    return {"popular_table": table(rs) if rs else "_(run not recorded)_",
            "popular_summary": summary(rs) if rs else ""}


BOX_PROVEN_JSON = os.path.join(REPO, "web", "server", "lib", "boxProven.json")


def short_note(r, cause):
    """A few words for the site's hover (lib/serverNotes.js), from the proof's own evidence."""
    c = (cause or "").lower()
    if "physical ram" in c or "more bytes" in c:
        return "runs out of memory while loading"
    m = re.search(r"could not (?:find script '([^']+)'|load rawfile \"([^\"]+)\")", cause or "", re.I)
    if m:
        return "a script it needs is missing (%s)" % (m.group(1) or m.group(2))
    if "exceeded" in c:
        return "hits an engine limit while loading"
    if "then the process exited" in (r.get("reason") or ""):
        return "stops right after loading"
    return "does not finish loading"


def write_box_proven(proof):
    """web/server/lib/boxProven.json: what lib/maps.js offers a party at the 'box' level."""
    out = {}
    for bsp, r in sorted(proof.items()):
        if r.get("result") == "pass":
            out[bsp] = {"result": "pass", "at": r.get("at"), "match": r.get("match"),
                        "com_frameTime_advance_ms": r.get("frametime_advance_ms")}
        elif r.get("result") == "fail":
            out[bsp] = {"result": "fail", "at": r.get("at"), "note": short_note(r, first_cause(bsp)),
                        "reason": r.get("reason"), "attempts": r.get("attempts", 1)}
    doc = {"_": "Generated by archive/popular.py --apply from ZombiesDev/archive/reports/boxproof.json. "
                "pass = map_loaded on the box through a real lease and com_frameTime advanced >= 15 s; "
                "server-side only, no client joined (archive.md 10.5, dedi.md 20). Do not hand-edit.",
           "maps": out}
    with open(BOX_PROVEN_JSON, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")
    print("wrote %s: %d pass, %d fail" % (BOX_PROVEN_JSON, sum(1 for v in out.values() if v["result"] == "pass"),
                                          sum(1 for v in out.values() if v["result"] == "fail")))


def apply():
    proof = load("boxproof.json", {})
    write_box_proven(proof)
    n = 0
    for bsp, r in proof.items():
        mf = os.path.join(MANIFESTS, bsp + ".json")
        if not os.path.exists(mf) or r.get("result") not in ("pass", "fail"):
            continue
        with open(mf, encoding="utf-8") as fh:
            m = json.load(fh)
        # Only the maps this run added. The 14 MVP manifests carry their own dedi history.
        if not m.get("precheck"):
            continue
        box = {"result": r["result"], "reason": r.get("reason"), "first_error": first_cause(bsp), "match": r.get("match"),
               "at": r.get("at"), "instance": r.get("instance"),
               "com_frameTime_advance_ms": r.get("frametime_advance_ms"),
               "com_error": r.get("com_error"), "console_errors": (r.get("console_errors") or [])[:6],
               "unproven": "no client joined: server-side load under Wine only"}
        if r.get("retries_not_counted"):
            box["attempts"] = r.get("attempts", 1)
            box["retries_not_counted"] = r["retries_not_counted"]
        if r.get("final_basis"):
            box["final_basis"] = r["final_basis"]
        m["box_proof"] = box
        if r["result"] == "pass":
            m["dedi_status"] = "box_map_loaded"
            if m.get("health") == "broken":
                m["health"] = None
                m.pop("health_reason", None)
        else:
            m["dedi_status"] = "box_failed"
            m["health"] = "broken"
            m["health_reason"] = "box proof: " + (r.get("reason") or "failed") + (
                "; first error: " + box["first_error"] if box["first_error"] else "") + (
                " (1 clean run; retries pre-empted)" if r.get("retries_not_counted") else "")
        with open(mf, "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=2)
        n += 1
    print("applied box results to %d manifests" % n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if a.apply:
        apply()
    rs = rows()
    print(table(rs))
    print()
    print(summary(rs))


if __name__ == "__main__":
    main()
