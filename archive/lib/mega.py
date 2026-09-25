"""MEGA public links: parse, list, download and decrypt, with no account.

Why this exists: 608 catalogued links are MEGA, 35% of them already dead, and 94 maps
have nothing else (archive.md "The headline"). MEGA encrypts client-side, so the bytes
its CDN serves are ciphertext; the key travels in the URL fragment and never reaches
MEGA's servers. The format is public and stable (megatools, mega.py, rclone all read it):

  link key (32 B)  k[0..7] as big-endian uint32
    aes key   = [k0^k4, k1^k5, k2^k6, k3^k7]      AES-128
    ctr nonce = [k4, k5]                          counter starts at 0
    meta mac  = [k6, k7]                          the condensed CBC-MAC of the plaintext
  attributes  = AES-CBC(aes key, iv 0) of b"MEGA{json}" zero-padded

The meta MAC is the integrity check: a download that decrypts but does not reproduce
it is corrupt (or the key is wrong), and `download()` refuses to keep it. That is the
evidence a MEGA original is the uploader's file and not a truncated or garbled copy.

Politeness is the same as every other host: the API goes through `PoliteSession.post_json`
(one request at a time, the session's delay), and the file URL is the one-use URL the API
hands us, the MEGA equivalent of a MediaFire download button (fetch.py `download()`).
MEGA meters anonymous transfer per IP (a few GB, refilling over hours). An over-quota
answer (HTTP 509, or API -17) marks MEGA exhausted for the rest of the run instead of
retrying; the next run picks up where this one stopped.

Folder links: a folder whose tree holds exactly one file (or a link naming one file
inside a folder, `/folder/<h>#<k>/file/<node>`) is fetched like a file. A folder of
several files is listed and refused with "folder with N files", because an original is
one file and we never repack; browser_queue.py picks those up.
"""

from __future__ import annotations

import base64
import json
import os
import re
import struct
import time

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:  # pragma: no cover - reported at call time, not import time
    Cipher = None

API = "https://g.api.mega.co.nz/cs"
ERRORS = {-2: "EARGS", -3: "EAGAIN (rate limited)", -9: "ENOENT (file gone)",
          -11: "EACCESS", -15: "ESID", -16: "EBLOCKED (taken down)",
          -17: "EOVERQUOTA", -18: "ETEMPUNAVAIL"}
DEAD = (-9, -16)

FILE_NEW = re.compile(r"mega(?:\.co)?\.nz/file/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{43})")
FILE_OLD = re.compile(r"mega(?:\.co)?\.nz/#!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]{43})")
FOLDER_NEW = re.compile(r"mega(?:\.co)?\.nz/folder/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{22})"
                        r"(?:/(file|folder)/([A-Za-z0-9_-]{8}))?")
FOLDER_OLD = re.compile(r"mega(?:\.co)?\.nz/#F!([A-Za-z0-9_-]{8})!([A-Za-z0-9_-]{22})"
                        r"(?:!([A-Za-z0-9_-]{8}))?")

_exhausted_until = 0.0


class MegaError(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


# --------------------------------------------------------------------- encoding
def b64d(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/").replace(",", "")
    return base64.b64decode(s + "=" * (-len(s) % 4))


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode().replace("+", "-").replace("/", "_").rstrip("=")


def a32(b: bytes):
    return list(struct.unpack(">%dI" % (len(b) // 4), b))


def from_a32(a) -> bytes:
    return struct.pack(">%dI" % len(a), *a)


def _need_crypto():
    if Cipher is None:
        raise MegaError("MEGA needs the 'cryptography' package: pip install cryptography")


def _ecb(key: bytes, data: bytes, decrypt=False) -> bytes:
    c = Cipher(algorithms.AES(key), modes.ECB())
    op = c.decryptor() if decrypt else c.encryptor()
    return op.update(data) + op.finalize()


# --------------------------------------------------------------------- keys
def split_file_key(key32: bytes):
    """-> (aes_key 16 B, ctr nonce 8 B, meta_mac 8 B) from a file's 32-byte node key."""
    k = a32(key32)
    aes = from_a32([k[0] ^ k[4], k[1] ^ k[5], k[2] ^ k[6], k[3] ^ k[7]])
    return aes, from_a32(k[4:6]), from_a32(k[6:8])


def decrypt_attrs(at_b64: str, aes_key: bytes):
    """MEGA node attributes -> dict (has "n", the file name), or None on a wrong key."""
    _need_crypto()
    raw = b64d(at_b64)
    raw += b"\0" * (-len(raw) % 16)
    c = Cipher(algorithms.AES(aes_key), modes.CBC(b"\0" * 16)).decryptor()
    plain = (c.update(raw) + c.finalize()).rstrip(b"\0")
    if not plain.startswith(b"MEGA{"):
        return None
    try:
        return json.loads(plain[4:].decode("utf-8", "replace"))
    except ValueError:
        return None


def decrypt_node_key(enc_b64: str, folder_key: bytes) -> bytes:
    """A folder node's `k` ("owner:key") is its key AES-ECB'd under the folder key."""
    _need_crypto()
    enc = enc_b64.split(":", 1)[-1]
    return _ecb(folder_key, b64d(enc), decrypt=True)


# --------------------------------------------------------------------- links
def parse(url: str):
    """-> dict(kind="file"|"folder", handle, key bytes, node (folder sub-node) or None),
    or None when the URL carries no usable key (a bare handle cannot be decrypted)."""
    for rx in (FILE_NEW, FILE_OLD):
        m = rx.search(url)
        if m:
            return {"kind": "file", "handle": m.group(1), "key": b64d(m.group(2)), "node": None}
    m = FOLDER_NEW.search(url)
    if m:
        return {"kind": "folder", "handle": m.group(1), "key": b64d(m.group(2)),
                "node": m.group(4)}
    m = FOLDER_OLD.search(url)
    if m:
        return {"kind": "folder", "handle": m.group(1), "key": b64d(m.group(2)),
                "node": m.group(3)}
    return None


# --------------------------------------------------------------------- MAC
def _chunks(size: int):
    """MEGA's chunk boundaries: 128 KiB, 256 KiB, ... 1 MiB, then 1 MiB each."""
    pos, i = 0, 1
    while pos < size:
        n = min(0x20000 * i if i < 8 else 0x100000, size - pos)
        yield pos, n
        pos += n
        i += 1


class MacState:
    """Streams plaintext through MEGA's per-chunk CBC-MAC and folds the chunk MACs."""

    def __init__(self, aes_key: bytes, nonce: bytes, size: int):
        self.key = aes_key
        self.init = nonce + nonce          # [iv0, iv1, iv0, iv1]
        self.bounds = list(_chunks(size))
        self.idx = 0
        self.buf = bytearray()
        self.file_mac = b"\0" * 16

    def _chunk_mac(self, data: bytes) -> bytes:
        data = bytes(data) + b"\0" * (-len(data) % 16)
        c = Cipher(algorithms.AES(self.key), modes.CBC(self.init)).encryptor()
        return (c.update(data) + c.finalize())[-16:]

    def _fold(self, cm: bytes):
        x = bytes(a ^ b for a, b in zip(self.file_mac, cm))
        self.file_mac = _ecb(self.key, x)

    def update(self, plain: bytes):
        self.buf += plain
        while self.idx < len(self.bounds) and len(self.buf) >= self.bounds[self.idx][1]:
            n = self.bounds[self.idx][1]
            self._fold(self._chunk_mac(self.buf[:n]))
            del self.buf[:n]
            self.idx += 1

    def condensed(self) -> bytes:
        if self.buf:                       # only when the stream was shorter than `size`
            self._fold(self._chunk_mac(self.buf))
            self.buf = bytearray()
        m = a32(self.file_mac)
        return from_a32([m[0] ^ m[1], m[2] ^ m[3]])


def ctr_decryptor(aes_key: bytes, nonce: bytes):
    _need_crypto()
    return Cipher(algorithms.AES(aes_key), modes.CTR(nonce + b"\0" * 8)).decryptor()


# --------------------------------------------------------------------- API
def exhausted() -> bool:
    return time.time() < _exhausted_until


def _mark_exhausted(hours=6):
    global _exhausted_until
    _exhausted_until = time.time() + hours * 3600


def _api(ps, payload, folder=None):
    url = API + "?id=%d" % int(time.time() * 1000 % 1e9)
    if folder:
        url += "&n=" + folder
    # never cached: download URLs expire, and a cached "alive" hides a takedown
    data = ps.post_json(url, [payload], allow_cache=False)
    if data is None:
        raise MegaError("no API response")
    if isinstance(data, int):
        code = data
    elif isinstance(data, list) and data and isinstance(data[0], int):
        code = data[0]
    elif isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    else:
        raise MegaError("unexpected API shape")
    if code == -17:
        _mark_exhausted()
    raise MegaError(ERRORS.get(code, "api error %d" % code), code)


def list_folder(ps, handle: str, folder_key: bytes):
    """-> list of files: dict(node, name, size, key32, path) with path relative to the root."""
    data = _api(ps, {"a": "f", "c": 1, "r": 1, "ca": 1}, folder=handle)
    nodes = data.get("f") or []
    names, parents = {}, {}
    files = []
    for n in nodes:
        try:
            key = decrypt_node_key(n["k"], folder_key)
        except Exception:
            continue
        if n.get("t") == 1:                           # folder: 16-byte key used directly
            attrs = decrypt_attrs(n.get("a", ""), key[:16]) or {}
            names[n["h"]] = attrs.get("n") or n["h"]
            parents[n["h"]] = n.get("p")
        elif n.get("t") == 0 and len(key) == 32:
            aes, _, _ = split_file_key(key)
            attrs = decrypt_attrs(n.get("a", ""), aes) or {}
            files.append({"node": n["h"], "parent": n.get("p"), "name": attrs.get("n"),
                          "size": int(n.get("s") or 0), "key32": key})
    for f in files:
        parts, p, guard = [], f["parent"], 0
        while p in names and parents.get(p) in names and guard < 64:   # root's name dropped
            parts.append(names[p])
            p, guard = parents[p], guard + 1
        f["path"] = "/".join(list(reversed(parts)) + [f["name"] or f["node"]])
    return files


def file_info(ps, url: str):
    """-> dict(name, size, dl_url, key32) for the one file a link resolves to.
    Raises MegaError ("folder with N files" for a multi-file folder)."""
    link = parse(url)
    if not link:
        raise MegaError("no key in MEGA URL (a bare handle cannot be decrypted)")
    if exhausted():
        raise MegaError("MEGA transfer quota exhausted for this run", -17)
    if link["kind"] == "file":
        key32 = link["key"]
        d = _api(ps, {"a": "g", "g": 1, "ssl": 1, "p": link["handle"]})
        aes, _, _ = split_file_key(key32)
        attrs = decrypt_attrs(d.get("at", ""), aes)
        if attrs is None:
            raise MegaError("wrong key: attributes do not decrypt")
        if not d.get("g"):
            raise MegaError("no download URL (file may be blocked)")
        return {"name": attrs.get("n"), "size": int(d["s"]), "dl_url": d["g"], "key32": key32}
    files = list_folder(ps, link["handle"], link["key"])
    if link["node"]:
        pick = [f for f in files if f["node"] == link["node"]]
        if not pick:
            raise MegaError("folder link names node %s, which is not a file in it" % link["node"])
    else:
        pick = files
    if len(pick) != 1:
        raise MegaError("folder with %d files: %s" % (
            len(pick), ", ".join(sorted(f["path"] for f in pick))[:400]))
    f = pick[0]
    d = _api(ps, {"a": "g", "g": 1, "ssl": 1, "n": f["node"]}, folder=link["handle"])
    if not d.get("g"):
        raise MegaError("no download URL (file may be blocked)")
    return {"name": f["name"], "size": int(d.get("s") or f["size"]), "dl_url": d["g"],
            "key32": f["key32"], "folder_path": f["path"]}


# --------------------------------------------------------------------- download
def download(ps, url: str, dest_dir: str, max_bytes: int, safe_name):
    """Fetch, decrypt and MAC-check one MEGA file. -> (path, None) or (None, error).

    `safe_name(name) -> str` makes the on-disk name (fetch.py's SAFE rule). The file is
    written as `<name>.part` and renamed only after the MAC matches, so a partial or
    corrupt download never looks like an original.
    """
    try:
        info = file_info(ps, url)
    except MegaError as exc:
        return None, "mega: %s" % exc
    size = info["size"]
    if size > max_bytes:
        return None, "too big (%d B > cap)" % size
    aes, nonce, meta_mac = split_file_key(info["key32"])
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, safe_name(info["name"] or "mega.bin"))
    part = dest + ".part"
    st = ps.host_state(info["dl_url"])
    with st.lock:
        ps._sleep(st)
        r = ps.s.get(info["dl_url"], stream=True, timeout=120)
        st.last = time.time()
        st.requests_made += 1
    if r.status_code == 509:
        r.close()
        _mark_exhausted()
        return None, "mega: HTTP 509 transfer quota exceeded (stopping MEGA for this run)"
    if r.status_code >= 400:
        r.close()
        return None, "mega: HTTP %d" % r.status_code
    dec = ctr_decryptor(aes, nonce)
    mac = MacState(aes, nonce, size)
    got = 0
    with open(part, "wb") as fh:
        for chunk in r.iter_content(1 << 18):
            if not chunk:
                continue
            got += len(chunk)
            if got > size:
                break
            plain = dec.update(chunk)
            mac.update(plain)
            fh.write(plain)
    r.close()
    if got != size:
        os.remove(part)
        return None, "mega: short read %d of %d B" % (got, size)
    if mac.condensed() != meta_mac:
        os.remove(part)
        return None, "mega: MAC mismatch (corrupt download or wrong key)"
    if os.path.exists(dest):
        os.remove(dest)
    os.replace(part, dest)
    ps.log("[fetch] mega %d B -> %s, MAC ok" % (size, os.path.basename(dest)))
    return dest, None
