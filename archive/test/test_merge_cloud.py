#!/usr/bin/env python3
"""Offline tests for archive/merge_cloud.py: a fake bucket (a dict behind merge_cloud.http_get),
temp work dirs, and extract.json entries in extract.py's own schema (process() /
normalise_into_mods()). Nothing touches the network or the real ZombiesDev folder."""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import merge_cloud  # noqa: E402


def sha(b):
    return hashlib.sha256(b).hexdigest()


def entry(norm, original, maps, dest_root="/home/user/zwork/mods", errors=None):
    """One extract.json row exactly as extract.process() writes it. maps: {bsp: {rel: bytes}}."""
    mods = []
    for bsp, files in maps.items():
        copied = [{"path": "mods/%s/%s" % (bsp, rel), "size": len(b), "sha256": sha(b)}
                  for rel, b in files.items()]
        mods.append({"map": bsp, "installer_folder": bsp, "bsp": bsp, "from": "Mods/" + bsp,
                     "depth": 1, "dest": "%s/%s" % (dest_root, bsp), "files": copied,
                     "bytes": sum(f["size"] for f in copied), "fs_game": "mods/" + bsp})
    return {"norm": norm, "original": original, "original_sha256": sha(original.encode()),
            "installer_kind": "7z", "errors": list(errors or []), "executables": [],
            "mods": mods, "wrapper_depth": 1 if mods else None}


class FakeBucket:
    def __init__(self):
        self.objects = {}   # url -> bytes
        self.gets = []

    def put(self, key, data):
        self.objects[merge_cloud.key_url(key)] = data

    def get(self, url, timeout=120):
        self.gets.append(url)
        if url not in self.objects:
            return 404, iter(())
        b = self.objects[url]
        return 200, iter([b[i:i + 7] for i in range(0, len(b), 7)])


FILES_NEW = {"mod.ff": b"FF" * 50, "nazi_zombie_new.iwd": b"IWD" * 30,
             "images/load.iwi": b"I" * 12, "weapons/sp/ray": b"weapon", "setup.exe": b"MZ"}
FILES_B = {"mod.ff": b"other" * 9}
FILES_MEGA = {"mod.ff": b"mega" * 20}


class MergeCloudTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="merge-cloud-")
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(os.path.join(self.work, "reports"))
        self.list = os.path.join(self.tmp, "cloud-maps.txt")
        # B's PC already holds one map, owned by `oldmap`.
        self.local = [entry("oldmap", "Old.rar", {"nazi_zombie_taken": {"mod.ff": b"mine"}},
                            dest_root=r"C:\Users\b\ZombiesDev\archive\mods")]
        self.write(os.path.join(self.work, "reports", "extract.json"), self.local)
        self.cloud = [
            entry("newmap", "New Map v1.2.rar", {"nazi_zombie_new": FILES_NEW}),
            # same norm as local: must not overwrite
            entry("oldmap", "Old-v2.rar", {"nazi_zombie_taken": {"mod.ff": b"theirs"}}),
            # another original claiming a bsp B's PC already has
            entry("remake", "Remake.zip", {"nazi_zombie_taken": FILES_B}),
            # MEGA-sourced, fine; plus a bsp the pipeline never uploaded
            entry("megamap", "mega map.7z", {"nazi_zombie_mega": FILES_MEGA,
                                            "nazi_zombie_half": {"mod.ff": b"x"}}),
            entry("failed", "Broken.exe", {}, errors=["nothing extracted"]),
        ]
        self.status = {"newmap": {"bsps": ["nazi_zombie_new"], "ok": True},
                       "remake": {"bsps": ["nazi_zombie_taken"], "ok": True},
                       "megamap": {"bsps": ["nazi_zombie_mega"], "ok": True},
                       "failed": {"bsps": [], "ok": False}}
        self.bucket = FakeBucket()
        self.bucket.put("archive/state/extract.json", json.dumps(self.cloud).encode())
        self.bucket.put("archive/state/cloud_pipeline.json", json.dumps(self.status).encode())
        for e in self.cloud:
            safe = merge_cloud.safe_norm(e["norm"])
            self.bucket.put("archive/originals/%s/%s.meta.json" % (safe, e["original"]),
                            json.dumps({"norm": e["norm"], "file": e["original"],
                                        "download_url": "https://example.invalid/" + e["norm"],
                                        "sha256": e["original_sha256"], "size": 1}).encode())
        for bsp, files in (("nazi_zombie_new", FILES_NEW), ("nazi_zombie_mega", FILES_MEGA)):
            for rel, b in files.items():
                self.bucket.put("mods/%s/%s" % (bsp, rel), b)
        self._get = merge_cloud.http_get
        self._sleep = merge_cloud.RETRY_SLEEP
        merge_cloud.http_get = self.bucket.get
        merge_cloud.RETRY_SLEEP = 0

    def tearDown(self):
        merge_cloud.http_get = self._get
        merge_cloud.RETRY_SLEEP = self._sleep
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers
    @staticmethod
    def write(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)

    @staticmethod
    def slurp(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()

    def run_it(self, *args):
        return merge_cloud.main(["--work", self.work, "--list", self.list, *args])

    def extract(self):
        with open(os.path.join(self.work, "reports", "extract.json"), encoding="utf-8") as fh:
            return {e["norm"]: e for e in json.load(fh)}

    # tests
    def test_merge_new_keeps_existing_and_records_conflicts(self):
        self.assertEqual(self.run_it(), 0)
        ex = self.extract()
        self.assertEqual(ex["oldmap"], self.local[0], "an existing entry must never change")
        new = ex["newmap"]["mods"][0]
        self.assertEqual(new["dest"], os.path.join(self.work, "mods", "nazi_zombie_new"))
        self.assertEqual(new["cloud_dest"], "/home/user/zwork/mods/nazi_zombie_new")
        self.assertIn("cloud", ex["newmap"])
        self.assertEqual(ex["remake"]["mods"], [])
        self.assertTrue(any("collision" in x for x in ex["remake"]["errors"]))
        self.assertEqual([m["map"] for m in ex["megamap"]["mods"]], ["nazi_zombie_mega"])
        self.assertIn("failed", ex)
        with open(os.path.join(self.work, "reports", "cloud-merge-conflicts.json")) as fh:
            conf = json.load(fh)
        self.assertEqual([(c["bsp"], c["cloud_norm"], c["local_norm"]) for c in conf],
                         [("nazi_zombie_taken", "remake", "oldmap")])
        self.assertEqual(merge_cloud.read_list(self.list), ["nazi_zombie_mega", "nazi_zombie_new"])
        meta = os.path.join(self.work, "originals", "megamap",
                            "mega map.7z.meta.json")
        self.assertTrue(os.path.exists(meta))
        # a backup of the old report was kept
        self.assertTrue(any(f.startswith("extract.json.bak-")
                            for f in os.listdir(os.path.join(self.work, "reports"))))

    def test_second_run_is_a_no_op(self):
        self.run_it()
        before = self.slurp(self.list)
        ex1 = self.extract()
        self.assertEqual(self.run_it(), 0)
        self.assertEqual(self.slurp(self.list), before)
        self.assertEqual(self.extract(), ex1)
        with open(os.path.join(self.work, "reports", "cloud-merge-conflicts.json")) as fh:
            self.assertEqual(len(json.load(fh)), 1)

    def test_a_cloud_retry_replaces_an_earlier_empty_record(self):
        self.run_it()
        self.assertEqual(self.extract()["failed"]["mods"], [])
        self.cloud[-1] = entry("failed", "Broken.exe", {"nazi_zombie_fixed": {"mod.ff": b"ok"}})
        self.status["failed"] = {"bsps": ["nazi_zombie_fixed"], "ok": True}
        self.bucket.put("archive/state/extract.json", json.dumps(self.cloud).encode())
        self.bucket.put("archive/state/cloud_pipeline.json", json.dumps(self.status).encode())
        self.run_it("--no-meta")
        self.assertEqual([m["map"] for m in self.extract()["failed"]["mods"]], ["nazi_zombie_fixed"])
        self.assertIn("nazi_zombie_fixed", merge_cloud.read_list(self.list))
        self.assertEqual(self.extract()["oldmap"], self.local[0])

    def test_dry_changes_nothing(self):
        p = os.path.join(self.work, "reports", "extract.json")
        before = self.slurp(p)
        self.assertEqual(self.run_it("--dry", "--pull-mods"), 0)
        self.assertEqual(self.slurp(p), before)
        self.assertFalse(os.path.exists(self.list))
        self.assertFalse(os.path.exists(os.path.join(self.work, "mods")))
        self.assertFalse(os.path.exists(os.path.join(self.work, "originals")))

    def test_without_status_trusts_extract_json(self):
        self.run_it("--no-status")
        self.assertIn("nazi_zombie_half", merge_cloud.read_list(self.list))

    def test_from_file(self):
        src = os.path.join(self.tmp, "cloud-extract.json")
        st = os.path.join(self.tmp, "cloud-status.json")
        self.write(src, self.cloud)
        self.write(st, self.status)
        self.bucket.objects.pop(merge_cloud.key_url("archive/state/extract.json"))
        self.assertEqual(self.run_it("--from-file", src, "--status-file", st, "--no-meta"), 0)
        self.assertEqual(merge_cloud.read_list(self.list), ["nazi_zombie_mega", "nazi_zombie_new"])

    def test_pull_mods_verifies_and_skips_executables(self):
        self.assertEqual(self.run_it("--pull-mods", "--min-free-gb", "0"), 0)
        d = os.path.join(self.work, "mods", "nazi_zombie_new")
        for rel, b in FILES_NEW.items():
            p = os.path.join(d, *rel.split("/"))
            if rel.endswith(".exe"):
                self.assertFalse(os.path.exists(p), "an .exe must never be fetched")
            else:
                self.assertEqual(open(p, "rb").read(), b)
        self.assertTrue(os.path.isfile(os.path.join(self.work, "mods", "nazi_zombie_mega", "mod.ff")))
        self.assertFalse([f for f in os.listdir(os.path.join(self.work, "mods")) if "staging" in f])
        self.assertFalse(os.path.exists(os.path.join(self.work, "mods", "nazi_zombie_taken")))
        # a re-run fetches nothing
        n = len(self.bucket.gets)
        self.assertEqual(self.run_it("--pull-mods", "--min-free-gb", "0"), 0)
        self.assertEqual(len(self.bucket.gets), n + 2)   # the two state files only

    def test_pull_refuses_bad_bytes_and_never_shows_half_a_map(self):
        self.bucket.put("mods/nazi_zombie_new/mod.ff", b"FF" * 49 + b"XX")   # right size, wrong sha
        self.assertEqual(self.run_it("--pull-mods", "--min-free-gb", "0"), 1)
        self.assertFalse(os.path.exists(os.path.join(self.work, "mods", "nazi_zombie_new")))
        self.assertTrue(os.path.isdir(os.path.join(self.work, "mods", "nazi_zombie_mega")))
        with open(os.path.join(self.work, "reports", "cloud-pull.json")) as fh:
            rec = json.load(fh)
        self.assertFalse(rec["nazi_zombie_new"]["ok"])
        self.assertIn("sha256", rec["nazi_zombie_new"]["errors"][0])
        # fixed bucket copy: the next run completes it, re-fetching only the bad file
        self.bucket.put("mods/nazi_zombie_new/mod.ff", FILES_NEW["mod.ff"])
        n = len(self.bucket.gets)
        self.assertEqual(self.run_it("--pull-mods", "--min-free-gb", "0"), 0)
        self.assertTrue(os.path.isfile(os.path.join(self.work, "mods", "nazi_zombie_new", "mod.ff")))
        self.assertEqual(len(self.bucket.gets) - n, 2 + 1)

    def test_pull_never_touches_a_local_map(self):
        self.run_it()
        self.assertEqual(self.run_it("--pull-mods", "--map", "nazi_zombie_taken", "--min-free-gb", "0"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.work, "mods", "nazi_zombie_taken")))

    def test_disk_budget_refuses(self):
        self.assertEqual(self.run_it("--pull-mods", "--min-free-gb", "1e9"), 1)
        self.assertFalse(os.path.exists(os.path.join(self.work, "mods", "nazi_zombie_new")))

    def test_unsafe_paths_are_refused(self):
        self.assertIsNone(merge_cloud.rel_of("m", {"path": "mods/m/../x.ff"}))
        self.assertIsNone(merge_cloud.rel_of("m", {"path": "mods/other/x.ff"}))
        self.assertEqual(merge_cloud.rel_of("m", {"path": "mods/m/a/HarryBos V1..0.iwd"}),
                         "a/HarryBos V1..0.iwd")

    def test_safe_norm_matches_fetch(self):
        import re
        safe = re.compile(r"[^A-Za-z0-9._-]+")
        for n in ("mega map", "a  b!!c", "ok_name-1.2", "üñí"):
            self.assertEqual(merge_cloud.safe_norm(n), safe.sub("_", n))


if __name__ == "__main__":
    unittest.main()
