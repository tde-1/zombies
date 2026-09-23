'use strict'
// Build one log bundle (docs/kickstart/telemetry.md §2): manifest.json + files/<name>,
// text files scrubbed, binary files as they are, gzip'd tar. Used by the launcher and the
// host agent; byte-identical copies like scrub.cjs and tar.cjs.
//
//   const out = await writeBundle(outPath, {
//     manifest: { kind, reason, ... },            // see MANIFEST_FIELDS; bundle_id is added
//     files: [{ name, path } | { name, text } | { name, buffer, binary: true }
//             | { name, path, tailBytes }],       // tailBytes: keep only the last n bytes
//     secrets: [...],                             // literal secret values to redact
//     level: 6,
//   })
//   -> { path, bytes, bundle_id, files: [{ name, size, scrubbed, truncated, binary }], scrub_hits }
//
// A text file is read whole (after tailBytes) and scrubbed in memory: the biggest text we
// bundle is a console log of a few MB. A binary file (a .dmp) is streamed from disk.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { scrubText, scrubJson, isForbiddenFile, isTextName, sumHits } = require('./scrub.cjs')
const { packTarGz } = require('./tar.cjs')

const BUNDLE_VERSION = 1
// What a manifest may carry. Everything is optional except kind and reason.
const MANIFEST_FIELDS = [
  'kind', 'reason', 'created_at', 'bundle_id',
  'launcher_version', 'dll_sha', 'dll_version', 'build',
  'map', 'match_id', 'mode', 'box', 'instance', 'pid', 'exit_code', 'exit_reason', 'duration_ms',
  'steam_id', 'machine', 'launch_line', 'session', 'wer', 'events', 'notes', 'host', 'summary_line',
]
const KINDS = ['client', 'launcher', 'host', 'site', 'journal']

const newBundleId = () => crypto.randomBytes(16).toString('hex')

function readTail (p, tailBytes) {
  const st = fs.statSync(p)
  if (!tailBytes || st.size <= tailBytes) return { buf: fs.readFileSync(p), truncated: false, size: st.size }
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.alloc(tailBytes)
    fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes)
    return { buf, truncated: true, size: st.size }
  } finally { fs.closeSync(fd) }
}

// Names inside the archive: files/<safe name>. Two files with one basename get a suffix.
function safeName (name, used) {
  let n = String(name || 'file').replace(/\\/g, '/').split('/').filter((x) => x && x !== '..' && x !== '.').join('/')
  n = n.replace(/[^\w.@+/-]/g, '_').slice(-180) || 'file'
  let out = n
  for (let i = 2; used.has(out.toLowerCase()); i++) out = n.replace(/(\.[^./]*)?$/, `.${i}$1`)
  used.add(out.toLowerCase())
  return out
}

async function writeBundle (outPath, { manifest = {}, files = [], secrets = [], level = 6 } = {}) {
  if (!KINDS.includes(manifest.kind)) throw new Error(`bundle kind must be one of ${KINDS.join(', ')}`)
  if (!manifest.reason) throw new Error('bundle reason is required')
  const bundleId = manifest.bundle_id || newBundleId()
  const used = new Set(['manifest.json'])
  const entries = []
  const listed = []
  const hitsAll = {}
  const addHits = (h) => { for (const [k, v] of Object.entries(h || {})) hitsAll[k] = (hitsAll[k] || 0) + v }

  for (const f of files) {
    if (!f || !f.name) continue
    const origin = f.path || f.name
    if (isForbiddenFile(origin) || isForbiddenFile(f.name)) { listed.push({ name: f.name, refused: 'forbidden file' }); continue }
    const name = safeName(f.name, used)
    try {
      const binary = f.binary === true || (f.binary !== false && f.path && !isTextName(f.path) && f.text == null)
      if (binary && f.path) {
        const st = fs.statSync(f.path)
        entries.push({ name: `files/${name}`, path: f.path, mtime: st.mtimeMs })
        listed.push({ name, size: st.size, binary: true, mtime: new Date(st.mtimeMs).toISOString() })
        continue
      }
      if (binary && f.buffer) {
        entries.push({ name: `files/${name}`, buffer: f.buffer })
        listed.push({ name, size: f.buffer.length, binary: true })
        continue
      }
      let text; let truncated = false; let size; let mtime = null
      if (f.text != null) { text = String(f.text); size = Buffer.byteLength(text) } else if (f.buffer) { text = f.buffer.toString('utf8'); size = f.buffer.length } else {
        const r = readTail(f.path, f.tailBytes)
        text = r.buf.toString('latin1'); truncated = r.truncated; size = r.size
        try { mtime = new Date(fs.statSync(f.path).mtimeMs).toISOString() } catch {}
      }
      const s = scrubText(text, { secrets })
      addHits(s.hits)
      const buf = Buffer.from(s.text, f.text != null || f.buffer ? 'utf8' : 'latin1')
      entries.push({ name: `files/${name}`, buffer: buf })
      listed.push({ name, size: buf.length, original_size: size, truncated, scrubbed: sumHits(s.hits), ...(mtime ? { mtime } : {}) })
    } catch (e) {
      listed.push({ name, error: String(e && e.message || e).slice(0, 200) })
    }
  }

  const m = {}
  for (const k of MANIFEST_FIELDS) if (manifest[k] !== undefined) m[k] = manifest[k]
  m.v = BUNDLE_VERSION
  m.bundle_id = bundleId
  m.created_at = m.created_at || new Date().toISOString()
  m.files = listed
  m.scrub_hits = hitsAll
  const clean = scrubJson(m, { secrets })
  entries.unshift({ name: 'manifest.json', buffer: Buffer.from(JSON.stringify(clean, null, 2)) })

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const { bytes } = await packTarGz(outPath, entries, { level })
  return { path: outPath, bytes, bundle_id: bundleId, files: listed, scrub_hits: hitsAll, manifest: clean }
}

module.exports = { writeBundle, newBundleId, MANIFEST_FIELDS, KINDS, BUNDLE_VERSION }
