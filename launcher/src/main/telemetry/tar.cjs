'use strict'
// A log bundle is a .tar.gz (docs/kickstart/telemetry.md §2). No dependency: the launcher
// ships no tar package and the host agent has no node_modules at all, and ustar is 512-byte
// headers and zero padding. Three byte-identical copies, like scrub.cjs (see its header).
//
//   packTarGz(outPath, entries, { level })   entries: [{ name, buffer } | { name, path }]
//   readTarGz(input, onEntry)                input: a path or a Readable of the .tar.gz;
//                                            onEntry({ name, size }) returns
//                                              false / undefined  -> skip the bytes
//                                              { max: n }         -> buffer at most the LAST n
//                                                                    bytes (a log's tail matters)
//                                            and is then called again as
//                                              onEntry({ name, size, data, truncated })
//
// Names are ustar (<=100, or prefix/name with a 155-byte prefix). Longer names are cut
// from the left, keeping the file name, because every name here is one we chose.

const fs = require('node:fs')
const zlib = require('node:zlib')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const BLOCK = 512

function octal (n, width) {
  const s = Math.max(0, Math.floor(n)).toString(8)
  return s.padStart(width - 1, '0').slice(-(width - 1)) + '\0'
}

function splitName (name) {
  let n = String(name).replace(/\\/g, '/').replace(/^\/+/, '')
  if (Buffer.byteLength(n) <= 100) return { name: n, prefix: '' }
  const i = n.lastIndexOf('/', n.length - 1)
  if (i > 0) {
    const pre = n.slice(0, i)
    const base = n.slice(i + 1)
    if (Buffer.byteLength(base) <= 100 && Buffer.byteLength(pre) <= 155) return { name: base, prefix: pre }
  }
  // Too long either way: keep the tail.
  n = n.slice(-100)
  return { name: n, prefix: '' }
}

function header (name, size, mtime = Date.now(), type = '0') {
  const h = Buffer.alloc(BLOCK, 0)
  const { name: n, prefix } = splitName(name)
  h.write(n, 0, 100, 'utf8')
  h.write(octal(0o644, 8), 100, 8, 'ascii')
  h.write(octal(0, 8), 108, 8, 'ascii')
  h.write(octal(0, 8), 116, 8, 'ascii')
  h.write(octal(size, 12), 124, 12, 'ascii')
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii')
  h.fill(0x20, 148, 156) // checksum placeholder: spaces
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.write('enw', 265, 32, 'ascii')
  h.write('enw', 297, 32, 'ascii')
  h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

const pad = (size) => (size % BLOCK ? Buffer.alloc(BLOCK - (size % BLOCK), 0) : null)

async function * tarStream (entries) {
  for (const e of entries) {
    if (e.buffer != null) {
      const buf = Buffer.isBuffer(e.buffer) ? e.buffer : Buffer.from(String(e.buffer), 'utf8')
      yield header(e.name, buf.length, e.mtime)
      if (buf.length) yield buf
      const p = pad(buf.length); if (p) yield p
    } else if (e.path) {
      let st
      try { st = fs.statSync(e.path) } catch { continue } // vanished between listing and packing
      // Pack exactly the size we stat'ed: a log still being written must not make the
      // header lie. Short reads are zero-filled.
      const size = st.size
      yield header(e.name, size, e.mtime || st.mtimeMs)
      let left = size
      const fd = fs.openSync(e.path, 'r')
      try {
        const chunk = Buffer.alloc(1 << 20)
        let pos = 0
        while (left > 0) {
          const want = Math.min(chunk.length, left)
          const got = fs.readSync(fd, chunk, 0, want, pos)
          if (got <= 0) { yield Buffer.alloc(left, 0); left = 0; break }
          yield Buffer.from(chunk.subarray(0, got))
          left -= got; pos += got
          // Let the event loop breathe between megabytes: this runs in a UI process.
          await new Promise((resolve) => setImmediate(resolve))
        }
      } finally { fs.closeSync(fd) }
      const p = pad(size); if (p) yield p
    }
  }
  yield Buffer.alloc(BLOCK * 2, 0)
}

/** Write entries to a .tar.gz. Returns { bytes } (compressed size). */
async function packTarGz (outPath, entries, { level = 6 } = {}) {
  const tmp = `${outPath}.part`
  await pipeline(Readable.from(tarStream(entries)), zlib.createGzip({ level }), fs.createWriteStream(tmp))
  fs.renameSync(tmp, outPath)
  return { bytes: fs.statSync(outPath).size }
}

function parseOctal (buf, off, len) {
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) : 0
}

/**
 * Stream a .tar.gz and hand each regular file to onEntry (see the header). Resolves with
 * the list of { name, size } seen. Rejects on a corrupt gzip or tar.
 */
async function readTarGz (input, onEntry) {
  const src = typeof input === 'string' ? fs.createReadStream(input) : input
  const gunzip = zlib.createGunzip()
  const seen = []
  let buf = Buffer.alloc(0)
  let cur = null // { name, size, left, want, parts, kept, padLeft }
  let ended = false

  const feed = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (ended) return
      if (cur) {
        if (cur.left > 0) {
          if (!buf.length) return
          const take = Math.min(cur.left, buf.length)
          if (cur.want) {
            cur.parts.push(buf.subarray(0, take))
            cur.kept += take
            // Keep only the LAST `max` bytes.
            while (cur.parts.length > 1 && cur.kept - cur.parts[0].length >= cur.want) { cur.kept -= cur.parts[0].length; cur.parts.shift() }
          }
          buf = buf.subarray(take)
          cur.left -= take
          if (cur.left > 0) return
        }
        if (cur.padLeft > 0) {
          const take = Math.min(cur.padLeft, buf.length)
          buf = buf.subarray(take)
          cur.padLeft -= take
          if (cur.padLeft > 0) return
        }
        if (cur.want) {
          let data = Buffer.concat(cur.parts)
          const truncated = data.length > cur.want || cur.kept < cur.size
          if (data.length > cur.want) data = data.subarray(data.length - cur.want)
          onEntry({ name: cur.name, size: cur.size, data, truncated: truncated || data.length < cur.size })
        }
        cur = null
      }
      if (buf.length < BLOCK) return
      const h = buf.subarray(0, BLOCK)
      buf = buf.subarray(BLOCK)
      if (h.every((b) => b === 0)) { ended = true; return }
      let sum = 0
      for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i]
      if (sum !== parseOctal(h, 148, 8)) throw new Error('tar: bad header checksum')
      const name0 = h.toString('utf8', 0, 100).replace(/\0.*$/s, '')
      const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '')
      const name = prefix ? `${prefix}/${name0}` : name0
      const size = parseOctal(h, 124, 12)
      const type = String.fromCharCode(h[156] || 48)
      const regular = type === '0' || type === '\0'
      let want = 0
      if (regular) {
        seen.push({ name, size })
        const r = onEntry({ name, size })
        if (r && r.max) want = Math.max(0, r.max)
      }
      cur = { name, size, left: size, want, parts: [], kept: 0, padLeft: size % BLOCK ? BLOCK - (size % BLOCK) : 0 }
      if (!want) cur.want = 0
    }
  }

  gunzip.on('data', (c) => { try { feed(c) } catch (e) { gunzip.destroy(e) } })
  await pipeline(src, gunzip)
  if (cur && cur.left > 0) throw new Error('tar: truncated archive')
  return seen
}

module.exports = { packTarGz, readTarGz, header, BLOCK }
