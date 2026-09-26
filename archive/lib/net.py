#!/usr/bin/env python3
"""Polite HTTP for the ENW map archive crawler.

Rules this module enforces, because they are not optional (docs/kickstart/overnight.md,
vault 04 section 2): one request at a time per host, a real delay between them, robots.txt
respected, an honest user agent, and a host that rate-limits or errors is DROPPED for the
rest of the run rather than retried into the ground.

Everything fetched is cached on disk under ZombiesDev\\archive\\cache so a re-run of the
crawler costs the sites nothing. Nothing is ever written into the repo.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
import urllib.parse
import urllib.robotparser

import requests

# Honest: says who we are and what we are doing. No contact email goes in a header -
# that address is B's personal one and does not belong in a request to a third party -
# so the project domain is the point of contact.
USER_AGENT = ("ENWZombiesArchive/0.1 (+https://enw.gg; World at War custom-zombies map "
              "preservation crawler; non-commercial; one request at a time)")

CACHE_ROOT = os.environ.get("ENW_ARCHIVE_CACHE", r"C:\Users\b\ZombiesDev\archive\cache")
LOG_ROOT = os.environ.get("ENW_ARCHIVE_LOGS", r"C:\Users\b\ZombiesDev\archive\logs")

DEFAULT_DELAY = 6.0          # seconds between requests to one host
MAX_CONSEC_ERRORS = 2        # then the host is dropped for the run
REQUEST_TIMEOUT = 45
LOCK_DIR = os.path.abspath(os.path.join(CACHE_ROOT, os.pardir, "hostlocks"))
LOCK_STALE = 30 * 60         # a lock older than this is assumed abandoned


def _pid_alive(pid):
    if pid <= 0:
        return False
    if os.name != "nt":      # Linux (the cloud run, the box): signal 0 probes without killing
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    try:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return False
        ctypes.windll.kernel32.CloseHandle(h)
        return True
    except Exception:
        return True          # cannot tell -> assume alive, i.e. stay polite


_META_CHARSET = __import__("re").compile(
    rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)""", __import__("re").I)


def decode(raw: bytes, content_type: str = None) -> str:
    """Decode a page the way a browser would, not the way requests defaults to.

    requests falls back to ISO-8859-1 for text/* with no charset, which silently
    mangles the curly apostrophes these forums are full of; and some of these pages
    are cp1252 served as utf-8. Header charset wins, then <meta charset>, then utf-8,
    then cp1252, and only then a lossy decode.
    """
    encs = []
    if content_type and "charset=" in content_type.lower():
        encs.append(content_type.lower().split("charset=")[1].split(";")[0].strip().strip('"'))
    m = _META_CHARSET.search(raw[:4096])
    if m:
        encs.append(m.group(1).decode("ascii", "ignore"))
    encs += ["utf-8", "cp1252"]
    for e in encs:
        if not e or e.lower() in ("iso-8859-1", "latin-1", "latin1"):
            continue
        try:
            return raw.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("cp1252", "replace")


class HostState:
    def __init__(self, host):
        self.host = host
        self.lock = threading.Lock()
        self.last = 0.0
        self.delay = DEFAULT_DELAY
        self.consec_errors = 0
        self.dropped = None       # reason string once dropped
        self.robots = None        # RobotFileParser once loaded
        self.requests_made = 0


class Dropped(Exception):
    """Host is off-limits for the rest of this run (rate limit, errors, or robots)."""


class Blocked(Exception):
    """robots.txt disallows this particular path."""


class PoliteSession:
    def __init__(self, delay=DEFAULT_DELAY, cache=True, log_name="crawl"):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = USER_AGENT
        self.s.headers["Accept-Language"] = "en-GB,en;q=0.9"
        self.hosts = {}
        self.default_delay = delay
        self.cache = cache
        os.makedirs(CACHE_ROOT, exist_ok=True)
        os.makedirs(LOG_ROOT, exist_ok=True)
        self.logpath = os.path.join(LOG_ROOT, log_name + ".log")
        self._loglock = threading.Lock()
        self._hostlock = threading.Lock()
        import atexit
        atexit.register(self.release)

    # ---------------------------------------------------------------- logging
    def log(self, *parts):
        line = time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts)
        with self._loglock:
            with open(self.logpath, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        print(line, flush=True)

    # ------------------------------------------------------------------ hosts
    def host_state(self, url):
        h = urllib.parse.urlsplit(url).netloc.lower()
        st = self.hosts.get(h)
        if st is None:
            # several fetcher threads share one session (cloud_pipeline): two of them meeting a
            # new host together must get the SAME HostState, or its lock would be doubled
            with self._hostlock:
                st = self.hosts.get(h)
                if st is None:
                    st = HostState(h)
                    st.delay = self.default_delay
                    self.hosts[h] = st
                    self._claim_host(st)
        return st

    def _claim_host(self, st):
        """Cross-process guard: one of OUR processes per host, ever.

        The in-process lock keeps threads apart, but overnight this repo runs several
        of these tools at once from different shells. MEASURED: two `codrepo.py`
        processes were briefly started together and made four simultaneous requests to
        the same WordPress site before being killed. A per-host lockfile makes that
        impossible rather than merely unlikely; a stale lock (dead pid, or older than
        LOCK_STALE) is taken over.
        """
        os.makedirs(LOCK_DIR, exist_ok=True)
        path = os.path.join(LOCK_DIR, st.host.replace(":", "_") + ".lock")
        st.lockfile = path
        mypid = os.getpid()
        for _ in range(2):
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, ("%d %f\n" % (mypid, time.time())).encode())
                os.close(fd)
                return
            except FileExistsError:
                try:
                    pid, ts = open(path).read().split()
                    pid, ts = int(pid), float(ts)
                except Exception:
                    pid, ts = -1, 0.0
                if pid == mypid:
                    return
                if time.time() - ts > LOCK_STALE or not _pid_alive(pid):
                    self.log("[lock] %s: taking over a stale lock from pid %d"
                             % (st.host, pid))
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                    continue
                self.drop(st, "another ENW process (pid %d) is already talking to this "
                              "host; refusing to double up" % pid)
                return

    def release(self):
        """Drop every host lock this session holds. Safe to call twice."""
        for st in self.hosts.values():
            path = getattr(st, "lockfile", None)
            if not path or not os.path.exists(path):
                continue
            try:
                if open(path).read().split()[0] == str(os.getpid()):
                    os.remove(path)
            except Exception:
                pass

    def _load_robots(self, st, scheme):
        rp = urllib.robotparser.RobotFileParser()
        url = scheme + "://" + st.host + "/robots.txt"
        try:
            self._sleep(st)
            r = self.s.get(url, timeout=REQUEST_TIMEOUT)
            st.last = time.time()
            st.requests_made += 1
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
                cd = rp.crawl_delay(USER_AGENT) or rp.crawl_delay("*")
                if cd:
                    st.delay = max(st.delay, float(cd))
                    self.log("[robots] %s: crawl-delay %ss -> delay %ss" % (st.host, cd, st.delay))
                self.log("[robots] %s: loaded (%d B)" % (st.host, len(r.text)))
            else:
                rp.parse([])       # no robots = allow all
                self.log("[robots] %s: HTTP %s, treating as allow-all" % (st.host, r.status_code))
        except Exception as exc:
            rp.parse([])
            self.log("[robots] %s: %s %s; treating as allow-all"
                     % (st.host, exc.__class__.__name__, exc))
        st.robots = rp

    def allowed(self, url):
        st = self.host_state(url)
        scheme = urllib.parse.urlsplit(url).scheme or "https"
        if st.robots is None:
            self._load_robots(st, scheme)
        try:
            return st.robots.can_fetch(USER_AGENT, url)
        except Exception:
            return True

    def _sleep(self, st):
        wait = st.delay - (time.time() - st.last)
        if wait > 0:
            time.sleep(wait + random.uniform(0, 0.8))

    def drop(self, st, reason):
        if not st.dropped:
            st.dropped = reason
            self.log("[DROP] %s: %s - no further requests to this host this run"
                     % (st.host, reason))

    # ---------------------------------------------------------------- caching
    def _cache_path(self, url, method):
        h = hashlib.sha1((method + " " + url).encode()).hexdigest()
        host = urllib.parse.urlsplit(url).netloc.lower().replace(":", "_")
        d = os.path.join(CACHE_ROOT, host)
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, h + (".json" if method == "HEAD" else ".bin"))

    # -------------------------------------------------------------------- get
    def get(self, url, allow_cache=True, params=None):
        """Return response text, None on a miss, or raise Dropped/Blocked."""
        full = url if not params else url + "?" + urllib.parse.urlencode(params)
        st = self.host_state(full)
        if st.dropped:
            raise Dropped(st.host + ": " + st.dropped)
        cp = self._cache_path(full, "GET")
        if self.cache and allow_cache and os.path.exists(cp):
            with open(cp, "rb") as fh:
                return decode(fh.read())
        if not self.allowed(full):
            raise Blocked("robots.txt disallows " + full)
        if st.dropped:
            raise Dropped(st.host + ": " + st.dropped)
        with st.lock:
            self._sleep(st)
            try:
                r = self.s.get(full, timeout=REQUEST_TIMEOUT)
            except Exception as exc:
                st.last = time.time()
                st.consec_errors += 1
                self.log("[err] GET %s: %s %s" % (full, exc.__class__.__name__, exc))
                if st.consec_errors >= MAX_CONSEC_ERRORS:
                    self.drop(st, "%d consecutive transport errors" % st.consec_errors)
                raise Dropped(str(exc))
            st.last = time.time()
            st.requests_made += 1
        if r.status_code in (429, 503):
            st.consec_errors += 1
            self.drop(st, "HTTP %d (rate limited)" % r.status_code)
            raise Dropped("HTTP %d" % r.status_code)
        if r.status_code in (401, 403):
            st.consec_errors += 1
            self.log("[err] GET %s: HTTP %d" % (full, r.status_code))
            if st.consec_errors >= MAX_CONSEC_ERRORS:
                self.drop(st, "repeated HTTP %d (blocked)" % r.status_code)
            return None
        if r.status_code >= 500:
            st.consec_errors += 1
            self.log("[err] GET %s: HTTP %d" % (full, r.status_code))
            if st.consec_errors >= MAX_CONSEC_ERRORS:
                self.drop(st, "%d consecutive 5xx" % st.consec_errors)
            return None
        if r.status_code >= 400:
            self.log("[miss] GET %s: HTTP %d" % (full, r.status_code))
            return None
        st.consec_errors = 0
        raw = r.content
        if self.cache:
            with open(cp, "wb") as fh:
                fh.write(raw)
        self.log("[ok] GET %s -> %d %d B" % (full, r.status_code, len(raw)))
        return decode(raw, r.headers.get("Content-Type"))

    # ------------------------------------------------------------------- post
    def post_json(self, url, payload, allow_cache=True):
        """POST a JSON body under the same politeness rules. Used for MEGA's public
        file-info API, which is the only way to tell a live MEGA link from a dead one
        without downloading the file."""
        st = self.host_state(url)
        if st.dropped:
            raise Dropped(st.host + ": " + st.dropped)
        key = url + "|" + json.dumps(payload, sort_keys=True)
        cp = self._cache_path(key, "POST")
        if self.cache and allow_cache and os.path.exists(cp):
            try:
                with open(cp, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                pass
        with st.lock:
            self._sleep(st)
            try:
                r = self.s.post(url, json=payload, timeout=REQUEST_TIMEOUT)
            except Exception as exc:
                st.last = time.time()
                st.consec_errors += 1
                if st.consec_errors >= MAX_CONSEC_ERRORS:
                    self.drop(st, "%d consecutive transport errors" % st.consec_errors)
                raise Dropped(str(exc))
            st.last = time.time()
            st.requests_made += 1
        if r.status_code in (429, 503, 509):
            self.drop(st, "HTTP %d (rate limited)" % r.status_code)
            raise Dropped("HTTP %d" % r.status_code)
        if r.status_code >= 400:
            st.consec_errors += 1
            if st.consec_errors >= MAX_CONSEC_ERRORS:
                self.drop(st, "%d consecutive HTTP %d" % (st.consec_errors, r.status_code))
            return None
        st.consec_errors = 0
        try:
            data = r.json()
        except Exception:
            return None
        if self.cache:
            try:
                with open(cp, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
            except Exception:
                pass
        return data

    # ------------------------------------------------------------------- head
    def head(self, url, allow_cache=True, allow_range_fallback=True):
        """Link health + size. Returns a dict; never raises for a dead link."""
        st = self.host_state(url)
        out = {"url": url, "status": None, "final_url": None, "size": None,
               "content_type": None, "error": None, "method": "HEAD",
               "checked": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        cp = self._cache_path(url, "HEAD")
        if self.cache and allow_cache and os.path.exists(cp):
            try:
                with open(cp, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                pass
        if st.dropped:
            out["error"] = "host dropped: " + st.dropped
            return out
        if not self.allowed(url):
            out["error"] = "robots.txt disallow"
            return out
        with st.lock:
            self._sleep(st)
            try:
                r = self.s.head(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
            except Exception as exc:
                st.last = time.time()
                st.consec_errors += 1
                out["error"] = "%s: %s" % (exc.__class__.__name__, exc)
                if st.consec_errors >= MAX_CONSEC_ERRORS:
                    self.drop(st, "%d consecutive transport errors" % st.consec_errors)
                self._cache_head(cp, out)
                return out
            st.last = time.time()
            st.requests_made += 1
        out["status"] = r.status_code
        out["final_url"] = r.url
        out["content_type"] = r.headers.get("Content-Type")
        cl = r.headers.get("Content-Length")
        if cl and cl.isdigit():
            out["size"] = int(cl)
        if r.headers.get("Content-Disposition"):
            out["content_disposition"] = r.headers["Content-Disposition"]
        if r.status_code in (429, 503):
            self.drop(st, "HTTP %d (rate limited)" % r.status_code)
            out["error"] = "rate limited"
            self._cache_head(cp, out)
            return out
        # Some hosts refuse HEAD (405) but answer a 1-byte ranged GET.
        if allow_range_fallback and (r.status_code in (405, 501)
                                     or (r.status_code < 400 and out["size"] is None)):
            with st.lock:
                self._sleep(st)
                try:
                    r2 = self.s.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True,
                                    stream=True, headers={"Range": "bytes=0-0"})
                    st.last = time.time()
                    st.requests_made += 1
                    out["method"] = "GET range"
                    out["status"] = r2.status_code
                    out["final_url"] = r2.url
                    out["content_type"] = r2.headers.get("Content-Type") or out["content_type"]
                    cr = r2.headers.get("Content-Range")
                    if cr and "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                        out["size"] = int(cr.rsplit("/", 1)[1])
                    elif r2.headers.get("Content-Length", "").isdigit():
                        n = int(r2.headers["Content-Length"])
                        if n > 1:
                            out["size"] = n
                    if r2.headers.get("Content-Disposition"):
                        out["content_disposition"] = r2.headers["Content-Disposition"]
                    r2.close()
                except Exception as exc:
                    out["error"] = "%s: %s" % (exc.__class__.__name__, exc)
        if out["status"] and out["status"] < 400:
            st.consec_errors = 0
        self._cache_head(cp, out)
        return out

    def _cache_head(self, cp, out):
        if self.cache:
            try:
                with open(cp, "w", encoding="utf-8") as fh:
                    json.dump(out, fh)
            except Exception:
                pass

    def summary(self):
        return dict((h, {"requests": s.requests_made, "delay": s.delay, "dropped": s.dropped})
                    for h, s in sorted(self.hosts.items()))
