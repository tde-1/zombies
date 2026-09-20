#!/usr/bin/env python3
"""Per-host link health probes.

A generic HEAD answers almost nothing useful here, because nearly every WaW map link
points at a *file-sharing landing page* rather than at a file:

  * MediaFire answers HTTP 200 with a human-readable "removed / invalid" page for a
    deleted file, so status alone would score every dead link as alive;
  * MEGA links carry the file id in the URL and the decryption key in the fragment,
    which never reaches the server, so the page itself says nothing at all;
  * Google Drive shows an interstitial for anything over ~100 MB.

So each host gets a probe that knows how to read that host, and everything else falls
back to HEAD (with a 1-byte ranged GET when HEAD is refused). Each probe returns the
same dict shape, plus a verdict:

  alive    the file is there, and `size` is its real size where the host will say
  dead     the host positively says it is gone
  blocked  the host will not answer us (login wall, captcha, robots)
  unknown  we could not tell -- counted separately, never silently as either
"""

from __future__ import annotations

import re
import urllib.parse

from . import net

# --------------------------------------------------------------------- MediaFire
MF_DEAD = re.compile(
    r"invalid or deleted file|file (?:has been|was) removed|the key you provided|"
    r"this file has been removed|no longer available|Error: Invalid or Deleted File",
    re.I)
MF_SIZE = re.compile(r'class="details"[^>]*>.*?\(([\d.]+)\s*([KMGT]?B)\)', re.S | re.I)
MF_SIZE2 = re.compile(r'File size:\s*</?\w*>?\s*([\d.]+)\s*([KMGT]?B)', re.I)
MF_DIRECT = re.compile(r'href="(https://download[^"]+mediafire\.com/[^"]+)"')
UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}


def _mf_size(text):
    for rx in (MF_SIZE, MF_SIZE2):
        m = rx.search(text)
        if m:
            try:
                return int(float(m.group(1)) * UNITS.get(m.group(2).upper(), 1))
            except ValueError:
                pass
    return None


def probe_mediafire(ps, url):
    out = {"url": url, "status": None, "size": None, "final_url": None,
           "content_type": None, "error": None, "filename": None}
    # A direct download<N>.mediafire.com URL is a real file; HEAD it.
    if re.match(r"https?://download\d+\.mediafire\.com/", url):
        return _generic(ps, url)
    try:
        t = ps.get(url)
    except net.Dropped as exc:
        out["error"] = str(exc)
        return out, "blocked"
    except net.Blocked as exc:
        out["error"] = str(exc)
        return out, "blocked"
    if t is None:
        out["error"] = "no page"
        return out, "dead"
    out["status"] = 200
    if MF_DEAD.search(t):
        return out, "dead"
    m = MF_DIRECT.search(t)
    if m:
        out["final_url"] = m.group(1)
    out["size"] = _mf_size(t)
    fn = re.search(r'<div class="filename">([^<]+)</div>', t)
    if fn:
        out["filename"] = fn.group(1).strip()
    if out["size"] or out["final_url"]:
        return out, "alive"
    # A MediaFire page with neither a size nor a download button is usually a
    # captcha / "prove you are human" interstitial, not a dead file.
    if re.search(r"captcha|are you a human|unusual traffic", t, re.I):
        out["error"] = "captcha interstitial"
        return out, "blocked"
    return out, "unknown"


# --------------------------------------------------------------------- MEGA
MEGA_ID = re.compile(r"mega(?:\.co)?\.nz/(?:file/|#!)([A-Za-z0-9_-]{5,})")
MEGA_FOLDER = re.compile(r"mega(?:\.co)?\.nz/(?:folder/|#F!)", re.I)
MEGA_API = "https://g.api.mega.co.nz/cs"
MEGA_ERRORS = {-2: "EARGS", -9: "ENOENT (file gone)", -11: "EACCESS",
               -15: "ESID", -16: "EBLOCKED (taken down)", -17: "EOVERQUOTA",
               -3: "EAGAIN (rate limited)"}


def probe_mega(ps, url):
    """MEGA's public file-info call: [{"a":"g","p":<handle>}].

    No account, no download -- it returns the encrypted attribute blob and, crucially
    for the size question, `s`, the exact byte size. A negative number is the error
    code, and -9 / -16 are precisely the two ways a WaW map dies on MEGA: the uploader
    deleted it, or it was taken down.
    """
    out = {"url": url, "status": None, "size": None, "final_url": None,
           "content_type": None, "error": None, "filename": None}
    if MEGA_FOLDER.search(url):
        out["error"] = "folder link (needs the folder key to enumerate)"
        return out, "unknown"
    m = MEGA_ID.search(url)
    if not m:
        out["error"] = "no file handle in URL"
        return out, "unknown"
    try:
        data = ps.post_json(MEGA_API + "?id=1", [{"a": "g", "p": m.group(1)}])
    except net.Dropped as exc:
        out["error"] = str(exc)
        return out, "blocked"
    if data is None:
        out["error"] = "no API response"
        return out, "unknown"
    if isinstance(data, int):
        out["error"] = MEGA_ERRORS.get(data, "api error %d" % data)
        return out, ("dead" if data in (-9, -16) else "unknown")
    if isinstance(data, list) and data:
        d = data[0]
        if isinstance(d, int):
            out["error"] = MEGA_ERRORS.get(d, "api error %d" % d)
            return out, ("dead" if d in (-9, -16) else "unknown")
        if isinstance(d, dict) and "s" in d:
            out["size"] = int(d["s"])
            out["status"] = 200
            return out, "alive"
    out["error"] = "unexpected api shape"
    return out, "unknown"


# --------------------------------------------------------------------- Google Drive
GD_ID = re.compile(r"/file/d/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})")
GD_DL = "https://drive.usercontent.google.com/download?id=%s&export=download"
GD_NAMESIZE = re.compile(
    r'<span class="uc-name-size"><a[^>]*>([^<]+)</a>\s*\(([\d.]+)\s*([KMGT])\)', re.I)
SIZE_SUFFIX = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}


def probe_gdrive(ps, url):
    """Probe the DOWNLOAD endpoint, not the /view page.

    MEASURED: `drive.google.com/file/d/<id>/view` answers 401 for everything we tried,
    live files included, so it cannot tell a dead link from a live one. The
    `drive.usercontent.google.com/download` endpoint does: 404 for a deleted file,
    a redirect to accounts.google.com for one that now needs sign-in, and for a live
    file the "Download warning" interstitial, which conveniently states the filename
    and a rounded size ("New_Realism_GreenhouseV1.1.exe (612M)").
    """
    out = {"url": url, "status": None, "size": None, "final_url": None,
           "content_type": None, "error": None, "filename": None}
    m = GD_ID.search(url)
    if not m:
        return _generic(ps, url)
    fid = m.group(1) or m.group(2)
    try:
        t = ps.get(GD_DL % fid)
    except net.Dropped as exc:
        out["error"] = str(exc)
        return out, "blocked"
    if t is None:
        out["error"] = "HTTP error from Drive"
        return out, "dead"
    out["status"] = 200
    if "accounts.google.com" in t[:800] or "ServiceLogin" in t[:2000]:
        out["error"] = "needs a Google sign-in (we do not use accounts)"
        return out, "blocked"
    if re.search(r"Error 404|Sorry, unable to open the file|does not exist", t[:3000], re.I):
        out["error"] = "404 - deleted"
        return out, "dead"
    mm = GD_NAMESIZE.search(t)
    if mm:
        out["filename"] = mm.group(1)
        out["size"] = int(float(mm.group(2)) * SIZE_SUFFIX[mm.group(3).upper()])
        out["size_approx"] = True      # Drive rounds to 3 significant figures
        return out, "alive"
    if "uc-download-link" in t or "download-form" in t:
        return out, "alive"
    if len(t) < 4000 and "<html" in t[:200].lower():
        out["error"] = "unrecognised Drive page"
        return out, "unknown"
    return out, "alive"


# --------------------------------------------------------------------- generic
def _generic(ps, url):
    p = ps.head(url)
    out = {"url": url, "status": p.get("status"), "size": p.get("size"),
           "final_url": p.get("final_url"), "content_type": p.get("content_type"),
           "error": p.get("error"), "filename": None, "checked": p.get("checked")}
    cd = p.get("content_disposition")
    if cd:
        m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)', cd)
        if m:
            out["filename"] = urllib.parse.unquote(m.group(1))
    st = p.get("status")
    if st is None:
        return out, ("blocked" if "robots" in (p.get("error") or "") else "dead")
    if st in (401, 403):
        return out, "blocked"
    if st >= 400:
        return out, "dead"
    ct = (out["content_type"] or "").lower()
    # A landing page where we asked for a file is not proof of a live file, but it is
    # not proof of a dead one either.
    if "text/html" in ct and not (out["size"] and out["size"] > 2_000_000):
        return out, "unknown"
    return out, "alive"


HOSTS = {
    "mediafire.com": probe_mediafire,
    "mega.nz": probe_mega,
    "mega.co.nz": probe_mega,
    "drive.google.com": probe_gdrive,
    "docs.google.com": probe_gdrive,
}


def probe(ps, url):
    host = urllib.parse.urlsplit(url).netloc.lower().removeprefix("www.")
    base = ".".join(host.split(".")[-2:]) if host.count(".") >= 1 else host
    fn = HOSTS.get(host) or HOSTS.get(base)
    if fn is None:
        return _generic(ps, url)
    r = fn(ps, url)
    # probe_mediafire may delegate to _generic, which already returns a pair.
    return r if isinstance(r, tuple) else (r, "unknown")
