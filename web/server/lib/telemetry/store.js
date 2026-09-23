'use strict'

// Where bundles live: the site's disk until the bucket has them, then the bucket
// (docs/kickstart/telemetry.md §1, §8).
//
//   <data>/telemetry/incoming/   a bundle being received (deleted on any failure)
//   <data>/telemetry/store/      received, waiting for (or failing) the bucket upload;
//                                deleted once uploaded unless ZM_TELEMETRY_KEEP_LOCAL=1
//
// The bucket: `enw-zombies` (S3_BUCKET_FILES / ZM_TELEMETRY_BUCKET), keys from infra\s3.env
// read through tools/s3/lib.cjs — the SAME file the publish tools read, so the site needs
// no new environment line and the keepalive loop needs no restart for it. Without keys a
// bundle stays on disk (`upload_state = 'local'`) and the admin page serves it from here.
//
// One upload at a time, in the background, after the HTTP answer has gone. A failure is
// retried every RETRY_MS. Nothing here ever deletes from the bucket.

const fs = require('node:fs')
const path = require('node:path')
const { db, now, DATA_DIR } = require('../../db/database')
const bucketLib = require('../bucket')

const ROOT = process.env.ZM_TELEMETRY_DIR || path.join(DATA_DIR, 'telemetry')
const DIRS = { incoming: path.join(ROOT, 'incoming'), store: path.join(ROOT, 'store') }
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true })
const RETRY_MS = 10 * 60_000
const KEEP_LOCAL = process.env.ZM_TELEMETRY_KEEP_LOCAL === '1'

// ---- the S3 side ---------------------------------------------------------------------
let s3cfg = null
function cfg () {
  if (s3cfg) return s3cfg
  if (process.env.ZM_TELEMETRY_UPLOAD === 'off') { s3cfg = { off: true }; return s3cfg }
  try {
    const lib = require('../../../../tools/s3/lib.cjs')
    const c = lib.loadConfig()
    s3cfg = { lib, c, bucket: process.env.ZM_TELEMETRY_BUCKET || process.env.S3_BUCKET_FILES || c.files, keys: lib.hasKeys(c) }
  } catch (e) {
    s3cfg = { off: true, error: e.message }
  }
  return s3cfg
}
const enabled = () => { const c = cfg(); return !c.off && c.keys && !!c.bucket }
const publicUrl = (key) => { const c = cfg(); return c.bucket && key ? bucketLib.publicUrl(c.bucket, key, (c.c && c.c.endpoint) || undefined) : null }

// PUT one object. No ACL: the bucket's own policy decides (public-read, listing refused).
async function putObject (key, { file, body, contentType }) {
  const c = cfg()
  const { Upload } = require('@aws-sdk/lib-storage')
  const s3 = c.lib.client(c.c)
  const up = new Upload({
    client: s3,
    params: { Bucket: c.bucket, Key: key, Body: file ? fs.createReadStream(file) : body, ContentType: contentType, CacheControl: 'private, max-age=0, no-store' },
    partSize: 16 * 1024 * 1024, queueSize: 2, leavePartsOnError: false,
  })
  await up.done()
  return { key, url: publicUrl(key) }
}
let put = putObject // replaceable for the tests

// ---- the queue -----------------------------------------------------------------------
let chain = Promise.resolve()
const pending = new Set()

function enqueue (incidentId) {
  if (pending.has(incidentId)) return chain
  pending.add(incidentId)
  chain = chain.then(() => uploadIncident(incidentId)).catch(() => {}).finally(() => pending.delete(incidentId))
  return chain
}

async function uploadIncident (id) {
  const row = db.prepare('SELECT id, public_id, bucket_key, local_path, upload_state FROM incidents WHERE id=?').get(id)
  if (!row || !row.local_path || row.upload_state === 'uploaded') return
  if (!fs.existsSync(row.local_path)) { db.prepare("UPDATE incidents SET upload_state='failed', upload_error=? WHERE id=?").run('the local copy is gone', id); return }
  if (!enabled()) { db.prepare("UPDATE incidents SET upload_state='local', upload_error=? WHERE id=?").run(cfg().error || 'no S3 keys (infra/s3.env)', id); return }
  try {
    await put(row.bucket_key, { file: row.local_path, contentType: 'application/gzip' })
    db.prepare("UPDATE incidents SET upload_state='uploaded', upload_error=NULL WHERE id=?").run(id)
    if (!KEEP_LOCAL) { try { fs.unlinkSync(row.local_path) } catch {} ; db.prepare('UPDATE incidents SET local_path=NULL WHERE id=?').run(id) }
  } catch (e) {
    db.prepare("UPDATE incidents SET upload_state='failed', upload_error=? WHERE id=?").run(String(e.name || '') + ' ' + String(e.message || e).slice(0, 300), id)
    console.warn(`[telemetry] upload of incident ${id} failed: ${e.name || ''} ${e.message}`)
  }
}

// Everything not yet in the bucket: after a restart, after keys arrive, after a failure.
function retryAll () {
  const rows = db.prepare("SELECT id FROM incidents WHERE upload_state IN ('pending','failed','local') AND local_path IS NOT NULL ORDER BY id LIMIT 50").all()
  for (const r of rows) enqueue(r.id)
  return rows.length
}

function start () {
  const t = setInterval(() => { try { retryAll() } catch (e) { console.warn('[telemetry] retry:', e.message) } }, RETRY_MS)
  t.unref?.()
  setTimeout(() => { try { retryAll() } catch {} }, 30_000).unref?.()
}

module.exports = {
  ROOT, DIRS, enabled, publicUrl, enqueue, retryAll, start, uploadIncident,
  put: (...a) => put(...a),
  idle: () => chain,
  _setPut (fn) { put = fn || putObject },
  _setConfig (c) { s3cfg = c },
}
