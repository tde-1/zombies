#!/usr/bin/env python3
"""Offline tests for browser_queue.py and ingest_browser.py: a temp work dir, a temp
catalogue and fake downloads. No network, no AV (--no-av is for exactly this).

  python3 archive/test/test_browser_tools.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

TMP = tempfile.mkdtemp(prefix="enw-browser-")
os.environ["ENW_ARCHIVE_WORK"] = TMP
os.environ["ENW_ARCHIVE_DB"] = os.path.join(TMP, "catalogue.sqlite")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import catalogue  # noqa: E402
import browser_queue  # noqa: E402
import fetch  # noqa: E402
import ingest_browser  # noqa: E402

ORIG = os.path.join(TMP, "originals")
DROP = os.path.join(TMP, "browser-drop")
REPORTS = os.path.join(TMP, "reports")
BIG = 200 * 1024


def add(db, source, name, links, extra=None):
    norm = catalogue.normalise(name)
    key = "%s|%s" % (source, norm)
    db.execute("INSERT OR REPLACE INTO maps(key,source,name,norm,source_url,extra) VALUES(?,?,?,?,?,?)",
               (key, source, name, norm, "https://%s.example/%s" % (source, norm),
                json.dumps(extra or {})))
    for url, verdict, size, fn, err in links:
        db.execute("INSERT OR REPLACE INTO links(url,map_key,host,verdict,size,size_exact,filename,error)"
                   " VALUES(?,?,?,?,?,1,?,?)", (url, key, catalogue.host_of(url), verdict, size, fn, err))
    db.commit()
    return norm


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def drop(rel, size, head=b"PK\x03\x04"):
    p = os.path.join(DROP, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(head + b"\0" * (size - len(head)))
    return p


class BrowserTools(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        shutil.rmtree(TMP, ignore_errors=True)

    @classmethod
    def setUpClass(cls):
        db = cls.db = catalogue.connect(os.environ["ENW_ARCHIVE_DB"])
        cls.drive = add(db, "zwr", "Drive Only", [
            ("https://drive.google.com/file/d/abc/view", "blocked", BIG, "driveonly.rar", None),
            ("https://www.mediafire.com/file/dead1", "dead", None, None, "404")])
        cls.mf = add(db, "zwr", "Has Mediafire", [
            ("https://drive.google.com/file/d/xyz/view", None, BIG + 1, "x.rar", None),
            ("https://www.mediafire.com/file/live", "alive", BIG + 1, "x.rar", None)])
        cls.held_ = add(db, "zwr", "Already Here", [
            ("https://drive.google.com/file/d/held/view", None, BIG + 2, "held.rar", None)])
        d = os.path.join(ORIG, fetch.SAFE.sub("_", cls.held_))
        os.makedirs(d)
        with open(os.path.join(d, "held.rar.meta.json"), "w") as fh:
            fh.write("{}")
        cls.zm = add(db, "codrepo", "Zm Folder Map", [
            ("https://zombiemodding.com/index.php?topic=1", "skipped", BIG + 3, "zmmap.7z", None)])
        cls.mega = add(db, "ugx", "Mega Folder", [
            ("https://mega.nz/folder/AAA#k", "unknown", None, None, "folder with 3 files")])
        cls.captcha = add(db, "zwr", "Captcha Map", [
            ("https://www.mediafire.com/file/cap", "alive", BIG + 4, "cap.zip", None)])
        cls.lost_pop = add(db, "codrepo", "Lost Popular", [], {"views": "1,500"})
        cls.lost = add(db, "codrepo", "Lost Quiet", [
            ("https://drive.google.com/file/d/gone", "dead", None, None, None)], {"views": 10})
        rep = os.path.join(TMP, "fetch.json")
        with open(rep, "w") as fh:
            json.dump([{"norm": cls.captcha, "status": "cannot resolve: captcha interstitial",
                        "link": "https://www.mediafire.com/file/cap"},
                       {"norm": cls.mf, "status": "ok"}], fh)
        cls.q = browser_queue.main(["--fetch-report", rep, "--out-dir", REPORTS,
                                    "--zombiemodding-titles"])
        cls.norms = {i["norm"] for i in cls.q["items"]}

    # -- queue
    def test_queue_drive_only(self):
        self.assertIn(self.drive, self.norms)
        urls = [i["url"] for i in self.q["items"] if i["norm"] == self.drive]
        self.assertEqual(urls, ["https://drive.google.com/file/d/abc/view"])   # dead MF not listed

    def test_queue_skips_live_mediafire(self):
        self.assertNotIn(self.mf, self.norms)

    def test_queue_skips_fetched(self):
        self.assertNotIn(self.held_, self.norms)

    def test_queue_other_browser_hosts(self):
        self.assertIn(self.zm, self.norms)
        self.assertIn(self.mega, self.norms)
        self.assertIn(self.captcha, self.norms)   # only via --fetch-report

    def test_queue_outputs_and_titles(self):
        md = open(os.path.join(REPORTS, "browser-queue.md"), encoding="utf-8").read()
        self.assertIn("Never run anything you download", md)
        self.assertIn("browser-drop", md)
        self.assertIn("## Google Drive", md)
        self.assertIn(fetch.SAFE.sub("_", self.drive), md)
        self.assertTrue(os.path.exists(os.path.join(REPORTS, "browser-queue.json")))
        titles = [t["norm"] for t in self.q["titles"]]
        self.assertEqual(titles[:2], [self.lost_pop, self.lost])

    # -- ingest (ordered: t1.. share one drop folder)
    def ingest(self, *extra):
        return ingest_browser.main(["--no-av", "--out-dir", REPORTS,
                                    "--queue", os.path.join(REPORTS, "browser-queue.json")]
                                   + list(extra))

    def test_t1_ingest(self):
        folder = drop(os.path.join(fetch.SAFE.sub("_", self.zm), "whatever.7z"), BIG + 50)
        loose = drop("driveonly-renamed.rar", BIG)          # exact size of Drive Only's link
        nomatch = drop("mystery.zip", BIG + 999)
        html = drop("page.html", BIG, b"<html>")
        tiny = drop("tiny.rar", 1000)
        rep = self.ingest()
        ok = {r["norm"]: r for r in rep["ingested"]}
        self.assertEqual(set(ok), {self.zm, self.drive})
        self.assertFalse(os.path.exists(folder) or os.path.exists(loose))
        meta = load(os.path.join(ORIG, fetch.SAFE.sub("_", self.drive),
                                   "driveonly-renamed.rar.meta.json"))
        self.assertEqual(meta["fetched_by"], "browser")
        self.assertEqual(meta["download_url"], "https://drive.google.com/file/d/abc/view")
        self.assertEqual(meta["av"], {"result": "not scanned"})
        self.assertEqual(meta["sha256"], fetch.sha256_of(os.path.join(
            ORIG, fetch.SAFE.sub("_", self.drive), "driveonly-renamed.rar")))
        for k in ("map", "norm", "catalogue_source", "source_page", "download_url", "resolved_url",
                  "file", "size", "sha256", "fetched", "user_agent", "av", "note"):
            self.assertIn(k, meta)
        self.assertEqual([r["file"] for r in rep["unmatched"]], [nomatch])
        self.assertEqual(sorted(r["file"] for r in rep["refused"]), sorted([html, tiny]))
        for p in (nomatch, html, tiny):
            self.assertTrue(os.path.exists(p))                # left in place
        on_disk = load(os.path.join(REPORTS, "browser-ingest.json"))
        self.assertEqual(len(on_disk["unmatched"]), 1)

    def test_t2_idempotent(self):
        again = drop(os.path.join(fetch.SAFE.sub("_", self.zm), "second.7z"), BIG + 60)
        rep = self.ingest()
        self.assertEqual(rep["ingested"], [])
        self.assertIn(again, [r["file"] for r in rep["skipped"]])
        self.assertTrue(os.path.exists(again))
        rep = self.ingest("--replace")
        self.assertEqual([r["norm"] for r in rep["ingested"]], [self.zm])
        self.assertTrue(os.listdir(os.path.join(TMP, "replaced")))   # old set kept, not deleted

    def test_t3_as(self):
        p = drop("mystery.zip", BIG + 999)
        rep = self.ingest("--as", "Mega Folder", p)
        self.assertEqual([r["norm"] for r in rep["ingested"]], [self.mega])
        meta = load(os.path.join(ORIG, fetch.SAFE.sub("_", self.mega), "mystery.zip.meta.json"))
        # The MEGA folder link has no size or filename, but it is the norm's only queue link.
        self.assertEqual(meta["download_url"], "https://mega.nz/folder/AAA#k")


if __name__ == "__main__":
    unittest.main(verbosity=1)
