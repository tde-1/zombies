// ENW Zombies replay container, v0.
//
// Vault 99 §5.4 / 10 §4b ask for: a header with hashes and dvars, 60-second compressed
// chunks (players 20 Hz, zombies 10 Hz, every event), a per-chunk hash chain, a signed
// footer index, and HTTP-Range seeking. This implements exactly that with NDJSON inside
// zstd chunks (the columnar CBOR body is a later, purely internal change — the container,
// chain and signature stay the same).
//
// ON-DISK LAYOUT
//   "ENWR" u8 ver u8 flags u16 reserved u32 headerLen  header(JSON utf8)
//   repeated: u32 payloadLen | u8 chunkFlags | u32 uncompressedLen | payload
//   u32 footerLen | footer(JSON utf8) | u32 footerLen | "ENWRFOOT"
//
// HASH CHAIN
//   chain[-1] = sha256(headerBytes)
//   chain[i]  = sha256( chain[i-1] || sha256(full on-disk chunk record, header bytes included) )
//   The footer carries every chunk's hash and chain link plus `final_chain`, and the whole
//   footer (minus `sig`) is Ed25519-signed. So: change one byte anywhere in the header, in
//   a chunk, in a chunk length, or in the index, and verification fails.
//
// SEEKING
//   footer.chunks[i] = { i, off, len, ulen, t0, t1, n, hash, chain }. `off` is the absolute
//   byte offset of the chunk record, so a viewer fetches Range: bytes=off-(off+9+len-1) and
//   decodes exactly one 60-second window without reading the file.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { sha256, sha256hex, canonical, b64u, unb64u, ensureDirOf } from './util.js'
import { sign, verify, publicFromRaw } from './keys.js'

export const MAGIC = Buffer.from('ENWR', 'ascii')
export const FOOTER_MAGIC = Buffer.from('ENWRFOOT', 'ascii')
export const FORMAT_VERSION = 0
export const FILE_HEAD_LEN = 4 + 1 + 1 + 2 + 4 // 12
export const CHUNK_HEAD_LEN = 4 + 1 + 4 // 9
export const CF_ZSTD = 1

export const DEFAULT_CHUNK_MS = 60_000
export const DEFAULT_LEVEL = 10

function zstd(buf, level) {
  return zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } })
}
function unzstd(buf) { return zlib.zstdDecompressSync(buf) }

export class ReplayWriter {
  /**
   * @param {object} o
   * @param {string} o.file          output path (.enwr)
   * @param {object} o.header        JSON header: match id, map, players, dvars, hashes…
   * @param {import('node:crypto').KeyObject} o.privateKey host signing key
   * @param {string} o.pub           raw ed25519 public key, base64url (goes in the footer)
   * @param {string} o.keyId
   */
  constructor({ file, header, privateKey, pub, keyId, chunkMs = DEFAULT_CHUNK_MS, level = DEFAULT_LEVEL, maxChunkBytes = 32 * 1024 * 1024 }) {
    this.file = file
    this.privateKey = privateKey
    this.pub = pub
    this.keyId = keyId
    this.chunkMs = chunkMs
    this.level = level
    this.maxChunkBytes = maxChunkBytes

    this.headerObj = { v: FORMAT_VERSION, alg: 'ed25519', codec: 'zstd/ndjson', chunk_ms: chunkMs, key_id: keyId, pub, ...header }
    this.headerBytes = Buffer.from(canonical(this.headerObj), 'utf8')

    ensureDirOf(file)
    this.fd = fs.openSync(file, 'w')
    const head = Buffer.alloc(FILE_HEAD_LEN)
    MAGIC.copy(head, 0)
    head.writeUInt8(FORMAT_VERSION, 4)
    head.writeUInt8(CF_ZSTD, 5)
    head.writeUInt16LE(0, 6)
    head.writeUInt32LE(this.headerBytes.length, 8)
    fs.writeSync(this.fd, head)
    fs.writeSync(this.fd, this.headerBytes)

    this.offset = FILE_HEAD_LEN + this.headerBytes.length
    this.chain = sha256(this.headerBytes)
    this.index = []
    this.buf = []
    this.bufBytes = 0
    this.chunkT0 = null
    this.chunkT1 = null
    this.lastMs = 0
    this.count = 0
    this.rawBytes = 0
    this.closed = false
    this.counts = Object.create(null)
  }

  /** Append one protocol event. Rolls a chunk on the 60-second boundary of game time. */
  append(ev) {
    if (this.closed) throw new Error('writer closed')
    const ms = Number.isFinite(ev.ms) ? ev.ms : this.lastMs
    this.lastMs = ms
    if (this.chunkT0 == null) this.chunkT0 = ms
    if (ms - this.chunkT0 >= this.chunkMs || this.bufBytes >= this.maxChunkBytes) this.flushChunk()
    if (this.chunkT0 == null) this.chunkT0 = ms
    this.chunkT1 = ms
    const line = Buffer.from(JSON.stringify(ev) + '\n', 'utf8')
    this.buf.push(line)
    this.bufBytes += line.length
    this.rawBytes += line.length
    this.count++
    this.counts[ev.t] = (this.counts[ev.t] || 0) + 1
  }

  flushChunk() {
    if (!this.buf.length) return null
    const raw = Buffer.concat(this.buf, this.bufBytes)
    const payload = zstd(raw, this.level)
    const ch = Buffer.alloc(CHUNK_HEAD_LEN)
    ch.writeUInt32LE(payload.length, 0)
    ch.writeUInt8(CF_ZSTD, 4)
    ch.writeUInt32LE(raw.length, 5)
    const record = Buffer.concat([ch, payload])
    fs.writeSync(this.fd, record)

    const hash = sha256(record)
    this.chain = sha256(Buffer.concat([this.chain, hash]))
    const entry = {
      i: this.index.length,
      off: this.offset,
      len: payload.length,
      ulen: raw.length,
      t0: this.chunkT0,
      t1: this.chunkT1,
      n: this.buf.length,
      hash: hash.toString('hex'),
      chain: this.chain.toString('hex'),
    }
    this.index.push(entry)
    this.offset += record.length
    this.buf = []
    this.bufBytes = 0
    this.chunkT0 = null
    return entry
  }

  /** Finish the file: flush, write the signed footer index, return stats. */
  close(extra = {}) {
    if (this.closed) return this.stats
    this.flushChunk()
    const footerNoSig = {
      v: FORMAT_VERSION,
      alg: 'ed25519',
      key_id: this.keyId,
      pub: this.pub,
      header_hash: sha256hex(this.headerBytes),
      chunks: this.index,
      final_chain: this.chain.toString('hex'),
      events: this.count,
      raw_bytes: this.rawBytes,
      event_counts: this.counts,
      duration_ms: (this.index.at(-1)?.t1 ?? 0) - (this.index[0]?.t0 ?? 0),
      signed_at: new Date().toISOString(),
      ...extra,
    }
    const signBytes = Buffer.from(canonical(footerNoSig), 'utf8')
    const footer = { ...footerNoSig, sig: b64u(sign(this.privateKey, signBytes)) }
    const footerBytes = Buffer.from(canonical(footer), 'utf8')
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32LE(footerBytes.length, 0)
    fs.writeSync(this.fd, lenBuf)
    fs.writeSync(this.fd, footerBytes)
    fs.writeSync(this.fd, lenBuf)
    fs.writeSync(this.fd, FOOTER_MAGIC)
    fs.closeSync(this.fd)
    this.closed = true
    const size = fs.statSync(this.file).size
    this.stats = {
      file: this.file, size, events: this.count, rawBytes: this.rawBytes,
      chunks: this.index.length, durationMs: footerNoSig.duration_ms,
      ratio: this.rawBytes ? this.rawBytes / size : 0, counts: this.counts,
    }
    return this.stats
  }
}

// ---- reading -------------------------------------------------------------------

export function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(FILE_HEAD_LEN)
    fs.readSync(fd, head, 0, FILE_HEAD_LEN, 0)
    if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('not an ENWR replay (bad magic)')
    const ver = head.readUInt8(4)
    const hlen = head.readUInt32LE(8)
    const hb = Buffer.alloc(hlen)
    fs.readSync(fd, hb, 0, hlen, FILE_HEAD_LEN)
    return { version: ver, headerBytes: hb, header: JSON.parse(hb.toString('utf8')), bodyOffset: FILE_HEAD_LEN + hlen }
  } finally { fs.closeSync(fd) }
}

export function readFooter(file) {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const tail = Buffer.alloc(12)
    fs.readSync(fd, tail, 0, 12, size - 12)
    if (!tail.subarray(4).equals(FOOTER_MAGIC)) throw new Error('truncated or unsigned replay (no footer magic)')
    const flen = tail.readUInt32LE(0)
    const fb = Buffer.alloc(flen)
    const off = size - 12 - flen
    fs.readSync(fd, fb, 0, flen, off)
    // `bodyEnd` is where the last chunk must stop: the 4-byte length prefix sits in
    // front of the footer JSON, and the trailer (len + magic) sits behind it.
    return { footer: JSON.parse(fb.toString('utf8')), footerOffset: off, bodyEnd: off - 4, footerBytes: fb, fileSize: size }
  } finally { fs.closeSync(fd) }
}

/** Read exactly one chunk by its index entry — the HTTP-Range path, offline. */
export function readChunk(file, entry) {
  const fd = fs.openSync(file, 'r')
  try {
    const record = Buffer.alloc(CHUNK_HEAD_LEN + entry.len)
    fs.readSync(fd, record, 0, record.length, entry.off)
    const plen = record.readUInt32LE(0)
    const flags = record.readUInt8(4)
    const ulen = record.readUInt32LE(5)
    if (plen !== entry.len) throw new Error(`chunk ${entry.i}: length mismatch (index ${entry.len}, file ${plen})`)
    const payload = record.subarray(CHUNK_HEAD_LEN)
    const raw = flags & CF_ZSTD ? unzstd(payload) : payload
    if (raw.length !== ulen) throw new Error(`chunk ${entry.i}: uncompressed length mismatch`)
    return { record, raw, events: parseNdjson(raw) }
  } finally { fs.closeSync(fd) }
}

export function parseNdjson(buf) {
  const out = []
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a corrupt line is a verification problem, not a parse crash */ }
  }
  return out
}

/** Every event in the file, in order. Convenience for tooling and the dashboard. */
export function* readEvents(file, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const { footer } = readFooter(file)
  for (const entry of footer.chunks) {
    if (entry.t1 < fromMs || entry.t0 > toMs) continue
    for (const ev of readChunk(file, entry).events) {
      if (ev.ms != null && (ev.ms < fromMs || ev.ms > toMs)) continue
      yield ev
    }
  }
}

/**
 * Prove a replay is unmodified. Recomputes every chunk hash and the whole chain from the
 * bytes on disk, then checks the Ed25519 signature over the footer.
 * @param {string} file
 * @param {object} o
 * @param {string|Buffer} [o.expectPub] pin the signing key (base64url raw). Without it we
 *        verify with the key the file carries, which proves integrity but not authorship.
 */
export function verifyFile(file, { expectPub = null } = {}) {
  const errors = []
  const ok = (cond, msg) => { if (!cond) errors.push(msg); return cond }
  let head, foot
  try { head = readHeader(file) } catch (e) { return { ok: false, errors: [e.message] } }
  try { foot = readFooter(file) } catch (e) { return { ok: false, errors: [e.message] } }
  const f = foot.footer

  ok(f.v === FORMAT_VERSION, `footer format version ${f.v} != ${FORMAT_VERSION}`)
  ok(sha256hex(head.headerBytes) === f.header_hash, 'header hash mismatch (header was modified)')

  // Walk the body exactly as the writer laid it out.
  let chain = sha256(head.headerBytes)
  let off = head.bodyOffset
  let events = 0
  const fd = fs.openSync(file, 'r')
  try {
    for (const e of f.chunks) {
      if (e.off !== off) { errors.push(`chunk ${e.i}: index offset ${e.off} != actual ${off}`); break }
      const record = Buffer.alloc(CHUNK_HEAD_LEN + e.len)
      const got = fs.readSync(fd, record, 0, record.length, e.off)
      if (got !== record.length) { errors.push(`chunk ${e.i}: file truncated`); break }
      const h = sha256hex(record)
      if (h !== e.hash) errors.push(`chunk ${e.i}: content hash mismatch (bytes were modified)`)
      chain = sha256(Buffer.concat([chain, Buffer.from(h, 'hex')]))
      if (chain.toString('hex') !== e.chain) errors.push(`chunk ${e.i}: hash chain broken`)
      // Decoding is part of the proof: a chunk that will not decompress is not a replay.
      try {
        const raw = unzstd(record.subarray(CHUNK_HEAD_LEN))
        if (raw.length !== e.ulen) errors.push(`chunk ${e.i}: uncompressed length ${raw.length} != ${e.ulen}`)
        const n = raw.length ? raw.toString('utf8').split('\n').filter(Boolean).length : 0
        if (n !== e.n) errors.push(`chunk ${e.i}: event count ${n} != ${e.n}`)
        events += n
      } catch (err) { errors.push(`chunk ${e.i}: will not decompress (${err.message})`) }
      off += record.length
    }
  } finally { fs.closeSync(fd) }

  if (off !== foot.bodyEnd) errors.push(`body ends at ${off} but the footer record starts at ${foot.bodyEnd} (${foot.bodyEnd - off} unaccounted bytes)`)
  ok(chain.toString('hex') === f.final_chain, 'final chain hash mismatch')
  ok(events === f.events, `event count ${events} != footer ${f.events}`)

  // Signature: over the footer with `sig` removed.
  const { sig, ...noSig } = f
  let sigOk = false
  try {
    const pub = publicFromRaw(f.pub)
    sigOk = verify(pub, Buffer.from(canonical(noSig), 'utf8'), unb64u(sig))
  } catch (e) { errors.push(`signature check failed to run: ${e.message}`) }
  ok(sigOk, 'Ed25519 footer signature INVALID')
  if (expectPub) ok(String(f.pub) === String(expectPub), `signed by an unexpected key (${f.pub})`)

  return {
    ok: errors.length === 0,
    errors,
    file,
    size: foot.fileSize,
    chunks: f.chunks.length,
    events: f.events,
    rawBytes: f.raw_bytes,
    durationMs: f.duration_ms,
    keyId: f.key_id,
    pub: f.pub,
    // A replay rebuilt by tools/recover.js after a host crash. It verifies, but the
    // signature was applied AFTER the fact, so it proves only that nothing changed since
    // recovery. Anything that grades evidence must read this flag, not just `ok`.
    recovered: !!f.recovered,
    partial: !!f.partial,
    recoveredNote: f.recovered_note || null,
    signedAt: f.signed_at,
    header: head.header,
    eventCounts: f.event_counts,
  }
}
