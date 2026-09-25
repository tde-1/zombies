#!/usr/bin/env python3
"""fetch_one falls through to the next mirror, and a MEGA mirror lands in originals/
with the usual sidecar. Offline: a fake session serves both hosts."""

import json
import os
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp()
os.environ["ENW_ARCHIVE_WORK"] = WORK
os.environ["ENW_ARCHIVE_DB"] = os.path.join(WORK, "catalogue.sqlite")
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import fetch  # noqa: E402
from lib import catalogue, mega  # noqa: E402
from test_mega import FakePS, Resp, make_file  # noqa: E402


class R404(Resp):
    headers = {}
    url = "https://archive.org/download/x/map.exe"

    def __init__(self):
        super().__init__(b"", 404)


class FetchMirrorTests(unittest.TestCase):
    def test_dead_mirror_then_mega(self):
        fetch.av_scan = lambda p: {"result": "clean (test stub)"}
        db = catalogue.connect(os.environ["ENW_ARCHIVE_DB"])
        key = catalogue.put_map(db, "zwr", "Test Map", source_url="https://example/t")
        plain = os.urandom(70000)
        key32, cipher, at = make_file(plain, "Test Map v2.rar")
        mega_url = "https://mega.nz/file/AbCdEfGh#" + mega.b64e(key32)
        catalogue.put_link(db, key, "https://archive.org/download/x/map.exe")
        catalogue.put_link(db, key, mega_url)
        catalogue.put_link(db, key, "https://mega.nz/file/ZzZzZzZz")      # keyless: skipped
        db.commit()
        ps = FakePS(lambda u, p: [{"s": len(plain), "at": at, "g": "https://gfs9.example/d"}],
                    {"https://gfs9.example/d": cipher,
                     "https://archive.org/download/x/map.exe": R404()})
        ps.allowed = lambda u: True
        args = types.SimpleNamespace(max_file_mb=100, max_mirrors=3)
        r = fetch.fetch_one(db, ps, catalogue.normalise("Test Map"), [1 << 30], args)
        self.assertEqual(r["status"], "ok", r)
        self.assertEqual(r["link"], mega_url)
        self.assertEqual(r["tried"][0]["status"], "download failed: HTTP 404")
        self.assertEqual(open(r["file"], "rb").read(), plain)
        meta = json.load(open(r["file"] + ".meta.json"))
        self.assertEqual(meta["download_url"], mega_url)
        self.assertNotIn("ZzZzZzZz", json.dumps(r))
        # second call reuses the stored original, no traffic
        n = len(ps.calls)
        r2 = fetch.fetch_one(db, ps, catalogue.normalise("Test Map"), [1 << 30], args)
        self.assertTrue(r2.get("reused"))
        self.assertEqual(len(ps.calls), n)


if __name__ == "__main__":
    unittest.main(verbosity=1)
