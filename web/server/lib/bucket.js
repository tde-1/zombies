'use strict'

// The object-storage mirror (docs/kickstart/storage.md).
//
// The site runs on B's PC behind a Cloudflare tunnel, which is fine for pages and hopeless
// for a 94 MB installer or a 1 GB map. So the big files are ALSO in two public Hetzner
// buckets, and the site answers a download with a 302 to the bucket copy when it has one.
// The site's own URL stays the stable one; the bucket is a faster place for the bytes.
//
//   S3_BUCKET_FILES   the launcher update feed's installers and blockmaps  (updates/<name>)
//   S3_BUCKET_MAPS    the map files the launcher installs                   (mods/<bsp>/<path>)
//                     and the replay viewer's exported geometry             (mapdata/<bsp>/<file>)
//   S3_ENDPOINT       default https://nbg1.your-objectstorage.com
//
// OFF unless the bucket names are in the environment (infra/site.env). The site never
// holds the S3 keys: the buckets are public, so "does the bucket have it" is an anonymous
// HEAD on the public URL, cached for five minutes either way. A bucket copy whose size
// is not the local file's size is treated as absent, so a stale or half-synced object is
// never preferred over the file on disk. Any error, timeout or miss serves locally,
// exactly as before this file existed.

const DEFAULT_ENDPOINT = 'https://nbg1.your-objectstorage.com'
const TTL_MS = 5 * 60_000
const HEAD_TIMEOUT_MS = 1500

function config (env = process.env) {
  return {
    endpoint: String(env.S3_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    files: env.S3_BUCKET_FILES || null,
    maps: env.S3_BUCKET_MAPS || null,
  }
}

// `https://<bucket>.<endpoint host>/<key>` — Hetzner's virtual-hosted public URL form.
function publicUrl (bucket, key, endpoint = config().endpoint) {
  const u = new URL(endpoint)
  const k = String(key).split('/').map(encodeURIComponent).join('/')
  return `${u.protocol}//${bucket}.${u.host}/${k}`
}

// The key layout, in one place: tools/s3/sync.js uploads to exactly these.
const keys = {
  update: (name) => `updates/${name}`,
  mapFile: (bsp, rel) => `mods/${bsp}/${String(rel).replace(/\\/g, '/')}`,
  mapdata: (rel) => `mapdata/${String(rel).replace(/\\/g, '/')}`,
}

// An anonymous HEAD on the public URL. Replaceable for the tests.
async function headPublic (url) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) })
  if (r.status !== 200) return { exists: false }
  const len = r.headers.get('content-length')
  return { exists: true, size: len == null ? null : Number(len) }
}
let head = headPublic

const cache = new Map() // url -> { at, exists, size }

async function probe (url, now) {
  const c = cache.get(url)
  if (c && now - c.at < TTL_MS) return c
  let r
  try { r = await head(url) } catch { r = { exists: false } }
  const e = { at: now, exists: !!r.exists, size: r.size ?? null }
  cache.set(url, e)
  return e
}

// THE DECISION. `kind` is 'files' or 'maps'. Returns the bucket URL to 302 to, or null
// for "serve it locally". Null when that bucket is not configured, when the object is
// not there, or when its size differs from the local file's (`localSize`, if known).
async function target (kind, key, localSize = null, { env = process.env, now = Date.now() } = {}) {
  const cfg = config(env)
  const bucket = kind === 'files' ? cfg.files : kind === 'maps' ? cfg.maps : null
  if (!bucket) return null
  const url = publicUrl(bucket, key, cfg.endpoint)
  const e = await probe(url, now)
  if (!e.exists) return null
  if (localSize != null && e.size != null && e.size !== localSize) return null
  return url
}

// The bucket copy's URL for a map file, for the download list (`mirror_url`). Unverified
// on purpose — it is a hint for a launcher that learns to use it; `url` stays the
// authority and the site route redirects there itself when the copy really exists.
function mirrorUrl (kind, key, env = process.env) {
  const cfg = config(env)
  const bucket = kind === 'files' ? cfg.files : cfg.maps
  return bucket ? publicUrl(bucket, key, cfg.endpoint) : null
}

// Express middleware: 302 a GET/HEAD for a file that exists under `dir` to its bucket
// copy. `keyOf(rel)` maps the request path to the bucket key, or null to never redirect
// it (latest.yml, the .meta.json files — small, no-cache, and served locally on purpose).
function redirectMiddleware (kind, dir, keyOf) {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(dir)
  return async (req, res, next) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      let rel
      try { rel = decodeURIComponent(req.path).replace(/^\/+/, '') } catch { return next() }
      if (!rel || rel.includes('..') || rel.includes('\\')) return next()
      const key = keyOf(rel)
      if (!key) return next()
      const full = path.resolve(root, rel)
      if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return next()
      let st
      try { st = fs.statSync(full) } catch { return next() }
      if (!st.isFile()) return next()
      const url = await target(kind, key, st.size)
      if (!url) return next()
      res.setHeader('cache-control', 'no-cache')
      return res.redirect(302, url)
    } catch { return next() }
  }
}

module.exports = {
  config, publicUrl, keys, target, mirrorUrl, redirectMiddleware, headPublic, DEFAULT_ENDPOINT, TTL_MS,
  _setHead (fn) { head = fn || headPublic; cache.clear() },
  _clear () { cache.clear() },
}
