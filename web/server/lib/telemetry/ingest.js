'use strict'

// Receive one bundle (docs/kickstart/telemetry.md §3): stream it to disk under a cap, read
// its manifest and text files, re-scrub, flag, write the incident row, queue the upload.
//
// The HTTP answer goes as soon as the row exists; the bucket upload happens after it.
// Reading is streaming (a 200 MB bundle is never held in memory): text files are kept as
// their LAST `TEXT_TAIL` bytes for the rules, binary files are only counted — unless the
// server-side scrub finds something the sender missed, when the bundle is rebuilt with the
// scrubbed text (binaries streamed through temp files) and the original is deleted.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { db, now } = require('../../db/database')
const { readTarGz, packTarGz } = require('../../../../shared/telemetry/tar.cjs')
const { scrubText, scrubJson, isTextName, sumHits } = require('../../../../shared/telemetry/scrub.cjs')
const { evaluate } = require('./flags')
const store = require('./store')
const incidents = require('./incidents')
const bucketLib = require('../bucket')

const MB = 1024 * 1024
const MAX_BYTES = () => (Number(process.env.ZM_TELEMETRY_MAX_MB) || 200) * MB
const TEXT_TAIL = 32 * MB
const TEXT_TOTAL = 128 * MB
const MANIFEST_MAX = 2 * MB

// Per sender, per rolling 24 h. A box sends every instance end; a launcher every game exit.
const LIMITS = {
  launcher: { n: () => Number(process.env.ZM_TELEMETRY_PER_DAY) || 40, bytes: () => (Number(process.env.ZM_TELEMETRY_GB_PER_DAY) || 2) * 1024 * MB },
  box: { n: () => 500, bytes: () => 10 * 1024 * MB },
}
const KINDS = { launcher: ['client', 'launcher'], box: ['host', 'journal'] }

class HttpError extends Error { constructor (status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra } }

const newPublicId = () => crypto.randomBytes(16).toString('hex')
const cleanId = (s) => (/^[0-9a-f]{16,64}$/i.test(String(s || '')) ? String(s).toLowerCase() : null)
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

function whoCol (who) { return who.steam_id ? ['steam_id', who.steam_id] : ['box', who.box] }

/**
 * @param req    the express request (raw body not yet read)
 * @param who    { steam_id } for a launcher, { box } for a box
 * @param source 'launcher' | 'box'
 * @returns { status, body }
 */
async function receive (req, { who, source }) {
  const bundleId = cleanId(req.headers['x-enw-bundle-id'])
  const len = Number(req.headers['content-length'])
  const [col, val] = whoCol(who)

  // A retry of something already here: say so without reading a byte.
  if (bundleId) {
    const dup = db.prepare(`SELECT id, severity, flags FROM incidents WHERE bundle_id=? AND ${col}=?`).get(bundleId, val)
    if (dup) { req.resume(); return { status: 200, body: { ok: true, id: dup.id, duplicate: true, severity: dup.severity, flags: JSON.parse(dup.flags || '[]') } } }
  }
  if (!Number.isFinite(len) || len <= 0) { req.resume(); return { status: 411, body: { error: 'content-length is required' } } }
  if (len > MAX_BYTES()) { req.resume(); return { status: 413, body: { error: `a bundle is at most ${MAX_BYTES() / MB} MB`, max_bytes: MAX_BYTES() } } }
  const lim = LIMITS[source]
  const day = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM incidents WHERE ${col}=? AND source=? AND received_at > ?`).get(val, source, now() - 86400_000)
  if (day.n >= lim.n() || day.b + len > lim.bytes()) {
    req.resume()
    const oldest = db.prepare(`SELECT MIN(received_at) t FROM incidents WHERE ${col}=? AND source=? AND received_at > ?`).get(val, source, now() - 86400_000).t || now()
    const retry = Math.max(60, Math.ceil((oldest + 86400_000 - now()) / 1000))
    return { status: 429, body: { error: 'too many log bundles today; this one will go later', retry_after_s: retry }, headers: { 'retry-after': String(retry) } }
  }

  const publicId = newPublicId()
  const incoming = path.join(store.DIRS.incoming, `${publicId}.tar.gz`)
  try {
    await toFile(req, incoming, Math.min(len, MAX_BYTES()))
  } catch (e) {
    try { fs.unlinkSync(incoming) } catch {}
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } }
    throw e
  }

  let parsed
  try {
    parsed = await read(incoming)
  } catch (e) {
    try { fs.unlinkSync(incoming) } catch {}
    return { status: 400, body: { error: `not a log bundle: ${e.message}` } }
  }
  const m = parsed.manifest
  if (!m) { try { fs.unlinkSync(incoming) } catch {}; return { status: 400, body: { error: 'not a log bundle: no manifest.json' } } }
  const kind = String(m.kind || req.headers['x-enw-bundle-kind'] || '')
  if (!KINDS[source].includes(kind)) { try { fs.unlinkSync(incoming) } catch {}; return { status: 400, body: { error: `kind must be ${KINDS[source].join(' or ')}` } } }

  // Defence in depth: the sender scrubbed; scrub again with the site's own secrets.
  const secrets = siteSecrets()
  let rescrubbed = 0
  for (const [name, text] of parsed.texts) {
    const s = scrubText(text, { secrets })
    const n = sumHits(s.hits)
    if (n) { rescrubbed += n; parsed.texts.set(name, s.text); parsed.dirty.add(name) }
  }
  const manifest = scrubJson(m, { secrets })

  const storePath = path.join(store.DIRS.store, `${publicId}.tar.gz`)
  if (rescrubbed) {
    await repack(incoming, storePath, parsed)
    try { fs.unlinkSync(incoming) } catch {}
    console.warn(`[telemetry] ${source} ${val}: the server-side scrub replaced ${rescrubbed} secret(s) the sender missed; the bundle was rebuilt`)
  } else {
    fs.renameSync(incoming, storePath)
  }
  const size = fs.statSync(storePath).size

  const flagged = evaluate({ manifest: { ...manifest, kind }, files: parsed.files, texts: parsed.texts })
  const at = Date.parse(manifest.created_at) || now()
  const whoName = who.steam_id || who.box
  const row = incidents.insert({
    public_id: publicId,
    bundle_id: bundleId || cleanId(manifest.bundle_id),
    source, kind,
    reason: String(manifest.reason || req.headers['x-enw-bundle-reason'] || '').slice(0, 40) || null,
    steam_id: who.steam_id || null,
    box: who.box || manifest.box || null,
    at: Math.min(at, now()),
    launcher_version: str(manifest.launcher_version || req.headers['x-enw-launcher']),
    dll_sha: str(manifest.dll_sha || (manifest.session && manifest.session.build)),
    map_key: str(manifest.map || (manifest.session && manifest.session.last_map)),
    match_id: str(manifest.match_id),
    instance: str(manifest.instance),
    severity: flagged.severity,
    flags: flagged.flags,
    hits: flagged.hits,
    manifest: { ...manifest, server_rescrubbed: rescrubbed || undefined },
    files: parsed.files,
    size,
    bucket_key: bucketLib.keys.log(kind, dayOf(at), whoName, publicId),
    local_path: storePath,
  })
  store.enqueue(row.id)
  return { status: 200, body: { ok: true, id: row.id, duplicate: false, severity: row.severity, flags: flagged.flags } }
}

const str = (v) => (v == null || v === '' ? null : String(v).slice(0, 120))

// The site's own secrets: whatever of these it has in its environment.
function siteSecrets () {
  return ['ZM_SITE_PASSWORD', 'ZM_SESSION_SECRET', 'ZM_ENW_TOKEN', 'STEAM_API_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']
    .map((k) => process.env[k]).filter((v) => v && v.length >= 6)
}

function toFile (req, file, cap) {
  return new Promise((resolve, reject) => {
    let n = 0
    const out = fs.createWriteStream(file)
    let failed = false
    const fail = (e) => { if (failed) return; failed = true; req.unpipe(out); out.destroy(); req.resume(); reject(e) }
    req.on('data', (c) => { n += c.length; if (n > cap) fail(new HttpError(413, `the body is bigger than its content-length or the ${cap / MB} MB cap`)) })
    req.on('error', fail)
    req.on('aborted', () => fail(new HttpError(400, 'the upload was aborted')))
    out.on('error', fail)
    out.on('finish', () => { if (!failed) resolve(n) })
    req.pipe(out)
  })
}

// Manifest, text tails and the file list. Throws on a corrupt archive.
async function read (file) {
  let manifest = null
  const texts = new Map()
  const files = []
  let textBytes = 0
  await readTarGz(file, (e) => {
    if (e.data) {
      if (e.name === 'manifest.json') {
        try { manifest = JSON.parse(e.data.toString('utf8')) } catch { throw new Error('manifest.json is not JSON') }
      } else {
        const name = e.name.replace(/^files\//, '')
        texts.set(name, e.data.toString('latin1'))
        textBytes += e.data.length
        const f = files.find((x) => x.name === name)
        if (f && e.truncated) f.read_tail = e.data.length
      }
      return
    }
    if (e.name === 'manifest.json') return { max: MANIFEST_MAX }
    const name = e.name.replace(/^files\//, '')
    const text = isTextName(name)
    files.push({ name, size: e.size, binary: !text })
    if (text && textBytes < TEXT_TOTAL) return { max: Math.min(TEXT_TAIL, TEXT_TOTAL - textBytes) }
    return false
  })
  // Merge what the sender said about each file (truncated, scrub counts, original size).
  const listed = manifest && Array.isArray(manifest.files) ? manifest.files : []
  for (const f of files) {
    const l = listed.find((x) => x && x.name === f.name)
    if (l) { f.truncated = !!l.truncated; f.scrubbed = l.scrubbed || 0; if (l.original_size) f.original_size = l.original_size; if (l.mtime) f.mtime = l.mtime }
  }
  for (const l of listed) if (l && l.refused) files.push({ name: l.name, refused: l.refused })
  return { manifest, texts, files, dirty: new Set() }
}

// Rebuild the bundle with the re-scrubbed text. A text file whose tail we kept is written
// as that tail (the head is dropped rather than shipped unscrubbed); binaries are streamed
// out to temp files and back in.
async function repack (src, dst, parsed) {
  const tmp = fs.mkdtempSync(path.join(store.DIRS.incoming, 'repack-'))
  const entries = []
  try {
    let i = 0
    await readTarGz(src, (e) => {
      if (e.data) return
      const name = e.name.replace(/^files\//, '')
      if (e.name === 'manifest.json') return false
      if (parsed.texts.has(name)) { entries.push({ name: e.name, buffer: Buffer.from(parsed.texts.get(name), 'latin1') }); return false }
      const p = path.join(tmp, `b${i++}`)
      const fd = fs.openSync(p, 'w')
      entries.push({ name: e.name, path: p })
      return { sink: { write: (b) => fs.writeSync(fd, b), end: () => fs.closeSync(fd) } }
    })
    const m = scrubJson(parsed.manifest, { secrets: siteSecrets() })
    m.server_rescrubbed = true
    entries.unshift({ name: 'manifest.json', buffer: Buffer.from(JSON.stringify(m, null, 2)) })
    await packTarGz(dst, entries, { level: 6 })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { receive, read, repack, LIMITS, MAX_BYTES, HttpError }
