'use strict'
// Shared by tools/s3/sync.js, tools/s3/check.js and launcher/tools/publish-update.js.
// docs/kickstart/storage.md is the design; web/server/lib/bucket.js owns the key layout
// and the public URL form so the site and the uploader can never disagree about them.
//
// Credentials come from infra/s3.env (git-ignored; infra/s3.env.example is the template):
//   S3_ACCESS_KEY=  S3_SECRET_KEY=
//   S3_ENDPOINT=https://nbg1.your-objectstorage.com   (optional)
//   S3_BUCKET_FILES=enw-zombies-files                  (optional)
//   S3_BUCKET_MAPS=enw-zombies-maps                    (optional)
// The process environment wins over the file.
//
// The AWS SDK lives in web/node_modules (it is web's dependency), so it is resolved from
// there rather than from wherever the caller happens to sit.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')

const REPO = path.resolve(__dirname, '..', '..')
const ENV_FILE = path.join(REPO, 'infra', 's3.env')
const webRequire = createRequire(path.join(REPO, 'web', 'package.json'))
const bucketLib = require(path.join(REPO, 'web', 'server', 'lib', 'bucket.js'))

function loadConfig () {
  const file = {}
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#') || !t.includes('=')) continue
      const k = t.slice(0, t.indexOf('=')).trim()
      const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
      file[k] = v
    }
  }
  const get = (k, d = null) => process.env[k] || file[k] || d
  const endpoint = String(get('S3_ENDPOINT', bucketLib.DEFAULT_ENDPOINT)).replace(/\/+$/, '')
  return {
    envFile: ENV_FILE,
    envFilePresent: fs.existsSync(ENV_FILE),
    accessKey: get('S3_ACCESS_KEY'),
    secretKey: get('S3_SECRET_KEY'),
    endpoint,
    // nbg1.your-objectstorage.com -> nbg1. Hetzner's signing region is the location.
    region: get('S3_REGION', new URL(endpoint).host.split('.')[0]),
    files: get('S3_BUCKET_FILES', 'enw-zombies-files'),
    maps: get('S3_BUCKET_MAPS', 'enw-zombies-maps'),
  }
}

const hasKeys = (cfg) => !!(cfg.accessKey && cfg.secretKey)

function client (cfg) {
  const { S3Client } = webRequire('@aws-sdk/client-s3')
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: false,
    // The SDK's default CRC32 "flexible checksums" (3.729+) are not something every
    // S3-compatible store accepts. Only send a checksum when the operation demands one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

const publicUrl = (cfg, bucket, key) => bucketLib.publicUrl(bucket, key, cfg.endpoint)

const TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.iwd': 'application/octet-stream',
  '.ff': 'application/octet-stream',
  '.arena': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.gsc': 'text/plain; charset=utf-8',
}
const contentType = (file) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

// ---- what goes where ------------------------------------------------------------------

// web/public/updates -> files bucket, updates/<name>. The feed (latest.yml) sorts LAST, so a
// sync never leaves a bucket feed pointing at an installer that has not arrived yet.
function updatesEntries (dir = path.join(REPO, 'web', 'public', 'updates')) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    const st = fs.statSync(file)
    if (!st.isFile()) continue
    const feed = /\.ya?ml$/i.test(name)
    out.push({
      key: bucketLib.keys.update(name), file, size: st.size, sha256: null,
      contentType: contentType(name),
      // Installers are versioned names and never change; the feed must never be cached.
      cacheControl: feed || name === 'README.txt' ? 'no-cache' : 'public, max-age=31536000, immutable',
      last: feed,
    })
  }
  return out.sort((a, b) => (a.last - b.last) || a.key.localeCompare(b.key))
}

// The files a launcher installs: exactly what the site serves at /api/maps/<bsp>/files
// (web/server/lib/mapfiles.js served()), with the archive's own sha256 for each.
function mapEntries () {
  const mapfiles = require(path.join(REPO, 'web', 'server', 'lib', 'mapfiles.js'))
  const out = []
  for (const e of mapfiles.served()) {
    for (const f of e.files) {
      const file = path.join(e.dir, f.path)
      out.push({
        key: bucketLib.keys.mapFile(e.bsp, f.path), file, size: f.size, sha256: f.sha256 || null,
        contentType: contentType(f.path), cacheControl: 'public, max-age=31536000, immutable',
      })
    }
  }
  return out
}

// The replay viewer's exported geometry (ZombiesDev\maps\<bsp>\<bsp>.glb + .meta.json).
function mapdataEntries () {
  const dir = process.env.ZM_MAPS_DIR || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'maps')
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue
    for (const name of fs.readdirSync(path.join(dir, d.name))) {
      if (!/\.glb$|\.meta\.json$/i.test(name)) continue
      const file = path.join(dir, d.name, name)
      out.push({
        key: bucketLib.keys.mapdata(`${d.name}/${name}`), file, size: fs.statSync(file).size, sha256: null,
        contentType: contentType(name),
        // Re-exported in place under the same name, so not immutable.
        cacheControl: /\.meta\.json$/i.test(name) ? 'no-cache' : 'public, max-age=3600',
      })
    }
  }
  return out
}

// ---- the sync ---------------------------------------------------------------------------

async function listAll (s3, bucket, prefix) {
  const { ListObjectsV2Command } = webRequire('@aws-sdk/client-s3')
  const out = new Map()
  let token
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    for (const o of r.Contents || []) out.set(o.Key, { size: o.Size, etag: o.ETag })
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return out
}

async function remoteSha (s3, bucket, key) {
  const { HeadObjectCommand } = webRequire('@aws-sdk/client-s3')
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return (r.Metadata || {}).sha256 || null
  } catch { return null }
}

// Object ACLs: Hetzner makes a bucket public at the bucket level; public-read on the
// object as well costs nothing where it is accepted. If the store refuses ACLs, remember
// and stop sending them.
let aclRefused = false

async function uploadOne (s3, bucket, e, { onProgress } = {}) {
  const { Upload } = webRequire('@aws-sdk/lib-storage')
  const params = () => ({
    Bucket: bucket, Key: e.key, Body: fs.createReadStream(e.file),
    ContentType: e.contentType, CacheControl: e.cacheControl,
    Metadata: e.sha256 ? { sha256: e.sha256 } : {},
    ...(aclRefused ? {} : { ACL: 'public-read' }),
  })
  const run = async () => {
    const up = new Upload({ client: s3, params: params(), partSize: 16 * 1024 * 1024, queueSize: 4, leavePartsOnError: false })
    if (onProgress) up.on('httpUploadProgress', onProgress)
    return up.done()
  }
  try { return await run() } catch (err) {
    const msg = `${err.name || ''} ${err.Code || ''} ${err.message || ''}`
    if (!aclRefused && /acl|AccessControlList/i.test(msg)) { aclRefused = true; return run() }
    throw err
  }
}

// Compare local entries with the bucket and upload what is missing or different.
// Different = a different size, or (same size) a different sha256 in the object's
// metadata. Every object this uploads carries its sha256, so the second run is a no-op.
async function sync (cfg, bucket, entries, { dryRun = false, log = console.log, prefix = '' } = {}) {
  const stats = { total: entries.length, upload: 0, uploadBytes: 0, same: 0, done: 0, failed: 0, secs: 0 }
  for (const e of entries) if (!e.sha256) e.sha256 = await sha256File(e.file)

  let remote = null
  let s3 = null
  if (hasKeys(cfg)) {
    s3 = client(cfg)
    try { remote = await listAll(s3, bucket, prefix) } catch (e) {
      if (!(dryRun && e.name === 'NoSuchBucket')) throw e
      log(`  ${bucket}: does not exist yet (dry run carries on as if empty)`)
      remote = new Map()
    }
  } else if (!dryRun) {
    throw new Error(`no S3 keys: ${cfg.envFile} is ${cfg.envFilePresent ? 'missing S3_ACCESS_KEY/S3_SECRET_KEY' : 'not there'}`)
  }

  const todo = []
  for (const e of entries) {
    const r = remote ? remote.get(e.key) : null
    let why = null
    if (!r) why = remote ? 'new' : 'new (no keys: bucket not listed)'
    else if (r.size !== e.size) why = `size ${r.size} -> ${e.size}`
    else {
      const sha = await remoteSha(s3, bucket, e.key)
      if (sha !== e.sha256) why = sha ? 'content changed' : 'no sha256 on the bucket copy'
    }
    if (why) { todo.push([e, why]); stats.upload++; stats.uploadBytes += e.size } else stats.same++
  }

  log(`  ${bucket}: ${entries.length} files, ${stats.same} already there, ${todo.length} to upload (${(stats.uploadBytes / 1e9).toFixed(2)} GB)`)
  if (dryRun) {
    for (const [e, why] of todo.slice(0, 40)) log(`    would upload ${e.key}  ${(e.size / 1e6).toFixed(1)} MB  (${why})`)
    if (todo.length > 40) log(`    ... and ${todo.length - 40} more`)
    return stats
  }

  const t0 = Date.now()
  let sent = 0
  for (const [e] of todo) {
    const s = Date.now()
    try {
      await uploadOne(s3, bucket, e)
      sent += e.size
      stats.done++
      const secs = (Date.now() - s) / 1000
      const all = (Date.now() - t0) / 1000
      log(`    up ${e.key}  ${(e.size / 1e6).toFixed(1)} MB in ${secs.toFixed(1)} s  ` +
        `[${stats.done}/${todo.length}, ${(sent / 1e9).toFixed(2)}/${(stats.uploadBytes / 1e9).toFixed(2)} GB, ${(sent / 1e6 / Math.max(all, 0.001)).toFixed(1)} MB/s avg]`)
    } catch (err) {
      stats.failed++
      log(`    FAILED ${e.key}: ${err.name || ''} ${err.message}`)
    }
  }
  stats.secs = (Date.now() - t0) / 1000
  return stats
}

module.exports = {
  REPO, ENV_FILE, loadConfig, hasKeys, client, publicUrl, contentType, sha256File,
  updatesEntries, mapEntries, mapdataEntries, sync, uploadOne, bucketLib,
}
