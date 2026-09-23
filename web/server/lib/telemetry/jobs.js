'use strict'

// The nightly jobs (docs/kickstart/telemetry.md §8), for the UTC day that just ended:
//   1. the digest   -> logs/digest/<date>.json   (the day's incidents grouped by flag)
//   2. the site log -> a `site` / `site_daily` bundle, flagged like any other, in the bucket
// Checked every 10 minutes; each runs once per day (state in <telemetry>/jobs.json), and a
// day missed while the site was down is caught up at the next start.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const store = require('./store')
const incidents = require('./incidents')
const siteLog = require('./siteLog')
const bucketLib = require('../bucket')
const { writeBundle } = require('../../../../shared/telemetry/bundle.cjs')
const { readTarGz } = require('../../../../shared/telemetry/tar.cjs')
const { evaluate } = require('./flags')

const STATE = path.join(store.ROOT, 'jobs.json')
const DIGEST_DIR = path.join(store.ROOT, 'digest')
const REPO = path.resolve(__dirname, '..', '..', '..', '..')

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const writeState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch {} }
const yesterday = (t = Date.now()) => new Date(t - 86400_000).toISOString().slice(0, 10)

async function uploadDigest (date) {
  const d = incidents.digest(date)
  const body = Buffer.from(JSON.stringify(d, null, 2))
  fs.mkdirSync(DIGEST_DIR, { recursive: true })
  fs.writeFileSync(path.join(DIGEST_DIR, `${date}.json`), body)
  const key = bucketLib.keys.digest(date)
  if (!store.enabled()) return { ok: true, local: true, key, url: null, count: d.total }
  const r = await store.put(key, { body, contentType: 'application/json' })
  return { ok: true, key, url: r.url, count: d.total }
}

async function uploadSiteLog (date) {
  const file = path.join(siteLog.LOG_DIR, `site-${date}.log`)
  if (!fs.existsSync(file)) return { ok: true, skipped: 'no site log for that day' }
  const publicId = crypto.randomBytes(16).toString('hex')
  const out = path.join(store.DIRS.store, `${publicId}.tar.gz`)
  const files = [{ name: `site-${date}.log`, path: file }]
  const keep = path.join(REPO, 'infra', 'keepalive.log')
  if (fs.existsSync(keep)) files.push({ name: 'keepalive.log', path: keep, tailBytes: 1024 * 1024 })
  const secrets = ['ZM_SITE_PASSWORD', 'ZM_SESSION_SECRET', 'ZM_ENW_TOKEN', 'STEAM_API_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'].map((k) => process.env[k]).filter(Boolean)
  const b = await writeBundle(out, { manifest: { kind: 'site', reason: 'site_daily', created_at: `${date}T23:59:59.000Z`, box: 'site' }, files, secrets })
  const texts = new Map()
  await readTarGz(out, (e) => { if (e.data) { texts.set(e.name.replace(/^files\//, ''), e.data.toString('latin1')); return } return /\.log$/.test(e.name) ? { max: 32 * 1024 * 1024 } : false })
  const f = evaluate({ manifest: b.manifest, files: b.files, texts })
  const at = Date.parse(`${date}T23:59:59Z`)
  const row = incidents.insert({
    public_id: publicId, bundle_id: b.bundle_id, source: 'site', kind: 'site', reason: 'site_daily', box: 'site', at,
    severity: f.severity, flags: f.flags, hits: f.hits, manifest: b.manifest, files: b.files, size: b.bytes,
    bucket_key: bucketLib.keys.log('site', date, 'site', publicId), local_path: out,
  })
  store.enqueue(row.id)
  return { ok: true, id: row.id }
}

let running = false
async function tick (t = Date.now()) {
  if (running) return
  running = true
  try {
    const s = readState()
    const day = yesterday(t)
    if (s.sitelog !== day) {
      try { const r = await uploadSiteLog(day); s.sitelog = day; console.log(`[telemetry] site log ${day}: ${r.skipped || `incident ${r.id}`}`) } catch (e) { console.warn(`[telemetry] site log ${day}: ${e.message}`) }
    }
    if (s.digest !== day) {
      try { const r = await uploadDigest(day); s.digest = day; console.log(`[telemetry] digest ${day}: ${r.count} incident(s) -> ${r.url || 'local only'}`) } catch (e) { console.warn(`[telemetry] digest ${day}: ${e.message}`) }
    }
    writeState(s)
  } finally { running = false }
}

function start () {
  const t = setInterval(() => { tick().catch(() => {}) }, 10 * 60_000)
  t.unref?.()
  setTimeout(() => { tick().catch(() => {}) }, 60_000).unref?.()
}

module.exports = { start, tick, uploadDigest, uploadSiteLog }
