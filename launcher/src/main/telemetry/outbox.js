// The telemetry outbox: `<ENW_ROOT>\telemetry\outbox\`, one entry per bundle.
//
//   <bundle_id>.json     the sidecar: { bundle_id, kind, reason, created_at, attempts,
//                        next_at, last_error, built, job, ... }
//   <bundle_id>.tar.gz   the bundle, once built
//
// A job is written BEFORE its bundle is built, so a game that ends seconds before the
// launcher quits is still bundled at the next start. Everything here is under ENW_ROOT
// and goes through assertWritable.
import fs from 'node:fs'
import path from 'node:path'
import { assertWritable } from '../paths.js'

export const DAY_MS = 24 * 3600_000
export const MAX_AGE_MS = 30 * DAY_MS
export const MAX_BYTES = 2 * 1024 ** 3
// 1 min, 5 min, 30 min, 2 h, 6 h, then every 6 h.
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000]
export const backoff = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]

const ID_RE = /^[0-9a-f]{32}$/

export class Outbox {
  constructor({ dir, rejectedDir, log = () => {}, now = Date.now, maxAgeMs = MAX_AGE_MS, maxBytes = MAX_BYTES } = {}) {
    this.dir = dir
    this.rejectedDir = rejectedDir
    this.log = log
    this.now = now
    this.maxAgeMs = maxAgeMs
    this.maxBytes = maxBytes
  }

  ensure() { fs.mkdirSync(assertWritable(this.dir), { recursive: true }) }
  sidecar(id) { return path.join(this.dir, `${id}.json`) }
  bundle(id) { return path.join(this.dir, `${id}.tar.gz`) }

  // Every entry, oldest first. A sidecar that cannot be read is removed with its bundle.
  list() {
    let names = []
    try { names = fs.readdirSync(this.dir) } catch { return [] }
    const out = []
    for (const n of names) {
      const m = /^([0-9a-f]{32})\.json$/.exec(n)
      if (!m) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))
        out.push({ id: m[1], meta, bundlePath: this.bundle(m[1]) })
      } catch (e) {
        this.log(`outbox: unreadable sidecar ${n} (${e.message}); removed`)
        this.remove({ id: m[1] })
      }
    }
    return out.sort((a, b) => String(a.meta.created_at).localeCompare(String(b.meta.created_at)))
  }

  count() { return this.list().length }

  add(meta) {
    if (!ID_RE.test(meta.bundle_id)) throw new Error('outbox: bad bundle id')
    this.ensure()
    const m = { attempts: 0, next_at: this.now(), last_error: null, built: false, created_at: new Date(this.now()).toISOString(), ...meta }
    this.save({ id: m.bundle_id, meta: m })
    return { id: m.bundle_id, meta: m, bundlePath: this.bundle(m.bundle_id) }
  }

  save(e) {
    const f = assertWritable(this.sidecar(e.id))
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(e.meta, null, 2))
    fs.renameSync(`${f}.tmp`, f)
  }

  remove(e) {
    for (const f of [this.sidecar(e.id), this.bundle(e.id), `${this.bundle(e.id)}.part`]) {
      try { fs.unlinkSync(assertWritable(f)) } catch {}
    }
  }

  // A 400: the site says it is not a bundle. Kept for a human, never retried.
  reject(e, why) {
    fs.mkdirSync(assertWritable(this.rejectedDir), { recursive: true })
    e.meta.rejected_at = new Date(this.now()).toISOString()
    e.meta.last_error = why
    try { fs.renameSync(this.bundle(e.id), assertWritable(path.join(this.rejectedDir, `${e.id}.tar.gz`))) } catch {}
    fs.writeFileSync(assertWritable(path.join(this.rejectedDir, `${e.id}.json`)), JSON.stringify(e.meta, null, 2))
    try { fs.unlinkSync(assertWritable(this.sidecar(e.id))) } catch {}
  }

  // At most 30 days and 2 GB (outbox and rejected together): the oldest go first. Logged.
  prune() {
    const now = this.now()
    const entries = []
    for (const [dir, where] of [[this.dir, 'outbox'], [this.rejectedDir, 'rejected']]) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        const m = /^([0-9a-f]{32})\.json$/.exec(n)
        if (!m) continue
        let created = 0
        try { created = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).created_at) || 0 } catch {}
        if (!created) { try { created = fs.statSync(path.join(dir, n)).mtimeMs } catch {} }
        let bytes = 0
        try { bytes = fs.statSync(path.join(dir, `${m[1]}.tar.gz`)).size } catch {}
        entries.push({ id: m[1], dir, where, created, bytes })
      }
    }
    entries.sort((a, b) => a.created - b.created)
    let total = entries.reduce((s, e) => s + e.bytes, 0)
    const dropped = []
    for (const e of entries) {
      const old = now - e.created > this.maxAgeMs
      if (!old && total <= this.maxBytes) continue
      for (const f of [`${e.id}.json`, `${e.id}.tar.gz`]) { try { fs.unlinkSync(assertWritable(path.join(e.dir, f))) } catch {} }
      total -= e.bytes
      dropped.push(e)
      this.log(`outbox: deleted ${e.where} bundle ${e.id} (${(e.bytes / 1e6).toFixed(1)} MB, made ${new Date(e.created).toISOString()}): ${old ? 'older than 30 days' : 'over the 2 GB cap'}`)
    }
    return dropped
  }
}
