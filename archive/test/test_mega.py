#!/usr/bin/env python3
"""Offline tests for archive/lib/mega.py: a synthetic MEGA file is encrypted exactly as
MEGA's client does (CTR + chunked CBC-MAC + attribute blob), served by a fake session,
and must come back byte-identical with the MAC checked. A flipped byte must be refused."""

import os
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from lib import mega  # noqa: E402
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: E402


def make_file(plain: bytes, name: str):
    """-> (url key32 with the real meta MAC, ciphertext, attribute blob)."""
    rnd = os.urandom(24)
    aes, nonce = rnd[:16], rnd[16:24]
    mac = mega.MacState(aes, nonce, len(plain))
    mac.update(plain)
    meta = mac.condensed()
    tail = nonce + meta                                   # k4..k7
    k = mega.a32(aes)
    t = mega.a32(tail)
    key32 = mega.from_a32([k[i] ^ t[i] for i in range(4)] + t)
    enc = Cipher(algorithms.AES(aes), modes.CTR(nonce + b"\0" * 8)).encryptor()
    cipher = enc.update(plain) + enc.finalize()
    blob = b"MEGA" + ('{"n":"%s"}' % name).encode()
    blob += b"\0" * (-len(blob) % 16)
    c = Cipher(algorithms.AES(aes), modes.CBC(b"\0" * 16)).encryptor()
    at = mega.b64e(c.update(blob) + c.finalize())
    return key32, cipher, at


class Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code = body, status

    def iter_content(self, n):
        for i in range(0, len(self.body), 7777):          # odd size: crosses chunk bounds
            yield self.body[i:i + 7777]

    def close(self):
        pass


class St:
    def __init__(self):
        self.lock = threading.Lock()
        self.last = 0
        self.requests_made = 0


class FakePS:
    def __init__(self, api, files):
        self.api, self.files, self.calls = api, files, []
        self.s = self

    def post_json(self, url, payload, allow_cache=True):
        self.calls.append((url, payload))
        return self.api(url, payload[0])

    def host_state(self, url):
        return St()

    def _sleep(self, st):
        pass

    def get(self, url, stream=True, timeout=0, **kw):
        body = self.files[url]
        return body if isinstance(body, Resp) else Resp(body)

    def log(self, *a):
        pass


def safe(n):
    return n.replace("/", "_")


class MegaTests(unittest.TestCase):
    def setUp(self):
        mega._exhausted_until = 0
        self.tmp = tempfile.mkdtemp()

    def _file_link(self, size, name="Map_v1.exe"):
        plain = os.urandom(size)
        key32, cipher, at = make_file(plain, name)
        url = "https://mega.nz/file/AbCdEfGh#" + mega.b64e(key32)
        api = lambda u, p: [{"s": len(plain), "at": at, "g": "https://gfs1.example/dl"}]
        return plain, url, FakePS(api, {"https://gfs1.example/dl": cipher})

    def test_roundtrip_sizes(self):
        # 0x20000*(1..8) boundaries and the 1 MiB tail, plus odd tails
        for size in (1, 15, 16, 17, 0x20000, 0x20000 + 1, 0x480000 + 3, 0x480000 + 0x250000 + 11):
            plain, url, ps = self._file_link(size)
            path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
            self.assertIsNone(err, (size, err))
            self.assertEqual(open(path, "rb").read(), plain, size)
            self.assertEqual(os.path.basename(path), "Map_v1.exe")

    def test_old_link_form(self):
        plain, url, ps = self._file_link(5000)
        url = url.replace("/file/AbCdEfGh#", "/#!AbCdEfGh!")
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIsNone(err)
        self.assertEqual(open(path, "rb").read(), plain)

    def test_corruption_refused(self):
        plain, url, ps = self._file_link(300000)
        c = bytearray(ps.files["https://gfs1.example/dl"])
        c[200000] ^= 1
        ps.files["https://gfs1.example/dl"] = bytes(c)
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIsNone(path)
        self.assertIn("MAC mismatch", err)
        self.assertFalse(os.listdir(self.tmp))                # no .part left behind

    def test_wrong_key(self):
        plain, url, ps = self._file_link(1000)
        bad = url[:-6] + ("AAAAAA" if not url.endswith("AAAAAA") else "BBBBBB")
        path, err = mega.download(ps, bad, self.tmp, 1 << 30, safe)
        self.assertIsNone(path)
        self.assertIn("wrong key", err)

    def test_dead_and_quota(self):
        _, url, _ = self._file_link(10)
        ps = FakePS(lambda u, p: -16, {})
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIn("EBLOCKED", err)
        ps = FakePS(lambda u, p: [-17], {})
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIn("EOVERQUOTA", err)
        self.assertTrue(mega.exhausted())
        n = len(ps.calls)
        mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertEqual(len(ps.calls), n)                     # no further API traffic

    def test_http_509_stops_mega(self):
        plain, url, ps = self._file_link(1000)
        ps.files["https://gfs1.example/dl"] = Resp(b"", 509)
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIn("509", err)
        self.assertTrue(mega.exhausted())

    def test_cap(self):
        plain, url, ps = self._file_link(5000)
        path, err = mega.download(ps, url, self.tmp, 100, safe)
        self.assertIn("too big", err)

    def _folder(self, nfiles, sub=False):
        fkey = os.urandom(16)

        def enc_key(k):
            return "own:" + mega.b64e(mega._ecb(fkey, k))

        def attrs(name, aes):
            blob = b"MEGA" + ('{"n":"%s"}' % name).encode()
            blob += b"\0" * (-len(blob) % 16)
            c = Cipher(algorithms.AES(aes), modes.CBC(b"\0" * 16)).encryptor()
            return mega.b64e(c.update(blob) + c.finalize())

        root_key = os.urandom(16)
        sub_key = os.urandom(16)
        nodes = [{"h": "ROOT0000", "p": "OWNER000", "t": 1, "k": enc_key(root_key),
                  "a": attrs("MyMapFolder", root_key)},
                 {"h": "SUBF0000", "p": "ROOT0000", "t": 1, "k": enc_key(sub_key),
                  "a": attrs("mods", sub_key)}]
        files, plains = {}, {}
        for i in range(nfiles):
            plain = os.urandom(4000 + i)
            key32, cipher, at = make_file(plain, "f%d.iwd" % i)
            h = "FILE%04d" % i
            nodes.append({"h": h, "p": "SUBF0000" if sub else "ROOT0000", "t": 0,
                          "k": enc_key(key32), "a": at, "s": len(plain)})
            files["https://gfs2.example/" + h] = cipher
            plains[h] = plain

        def api(u, p):
            if p["a"] == "f":
                return [{"f": nodes}]
            return [{"s": len(plains[p["n"]]), "g": "https://gfs2.example/" + p["n"]}]
        return fkey, FakePS(api, files), plains

    def test_folder_single_file(self):
        fkey, ps, plains = self._folder(1, sub=True)
        url = "https://mega.nz/folder/ROOT0000#" + mega.b64e(fkey)
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIsNone(err)
        self.assertEqual(open(path, "rb").read(), plains["FILE0000"])
        info = mega.file_info(ps, url)
        self.assertEqual(info["folder_path"], "mods/f0.iwd")   # root name dropped

    def test_folder_multi_refused_and_node_pick(self):
        fkey, ps, plains = self._folder(3)
        url = "https://mega.nz/folder/ROOT0000#" + mega.b64e(fkey)
        path, err = mega.download(ps, url, self.tmp, 1 << 30, safe)
        self.assertIsNone(path)
        self.assertIn("folder with 3 files", err)
        path, err = mega.download(ps, url + "/file/FILE0002", self.tmp, 1 << 30, safe)
        self.assertIsNone(err)
        self.assertEqual(open(path, "rb").read(), plains["FILE0002"])
        old = "https://mega.nz/#F!ROOT0000!" + mega.b64e(fkey) + "!FILE0001"
        path, err = mega.download(ps, old, self.tmp, 1 << 30, safe)
        self.assertIsNone(err)
        self.assertEqual(open(path, "rb").read(), plains["FILE0001"])

    def test_no_key(self):
        path, err = mega.download(FakePS(None, {}), "https://mega.nz/file/AbCdEfGh", self.tmp, 1, safe)
        self.assertIn("no key", err)


if __name__ == "__main__":
    unittest.main(verbosity=1)
