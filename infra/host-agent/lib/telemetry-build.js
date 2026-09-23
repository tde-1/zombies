#!/usr/bin/env node
// Build ONE telemetry bundle, in its own low-priority process (lib/telemetry.js spawns it).
//
// Why a child and not the agent's own thread: writeBundle scrubs every text file in memory
// with a dozen regexes, and a 16 MB console.log is a second or so of CPU. On the agent's
// event loop that is a second in which no referee ticks, no game-link message is read and
// no heartbeat goes out. In a child niced to 19 it is a second of the idlest core.
//
// Input: the spec as JSON on STDIN (never on the command line and never on disk, because it
// carries the literal secrets the scrubber must redact):
//   { out, manifest, files: [{ name, path, tailBytes } | { name, text }], secrets: [...],
//     level, hash: [{ key, path }] }            hash: sha256 these (the replay) into manifest.notes.hashes
// Output: one JSON line on STDOUT: { ok, path, bytes, bundle_id, files, scrub_hits } or { ok: false, error }.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { writeBundle } from './telemetry/bundle.cjs'

export async function sha256File(p) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(p), async function* (src) { for await (const c of src) h.update(c) })
  return h.digest('hex')
}

export async function buildBundle(spec) {
  const manifest = { ...(spec.manifest || {}) }
  if (Array.isArray(spec.hash) && spec.hash.length) {
    const hashes = {}
    for (const h of spec.hash) {
      try {
        const st = fs.statSync(h.path)
        hashes[h.key] = { path: h.path, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), sha256: await sha256File(h.path) }
      } catch (e) { hashes[h.key] = { path: h.path, error: String(e.message || e).slice(0, 200) } }
    }
    manifest.notes = { ...(manifest.notes || {}), hashes }
  }
  // A file that has gone away since it was listed is recorded, not fatal.
  const files = (spec.files || []).filter((f) => f && (f.text != null || f.buffer || (f.path && fs.existsSync(f.path))))
  const gone = (spec.files || []).filter((f) => f && f.path && f.text == null && !fs.existsSync(f.path)).map((f) => f.name)
  if (gone.length) manifest.notes = { ...(manifest.notes || {}), missing_files: gone }
  const r = await writeBundle(spec.out, { manifest, files, secrets: spec.secrets || [], level: spec.level ?? 6 })
  return { ok: true, path: r.path, bytes: r.bytes, bundle_id: r.bundle_id, files: r.files, scrub_hits: r.scrub_hits }
}

// CLI: only when spawned as the builder, never when imported.
if (process.argv.includes('--build-from-stdin')) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => { input += d })
  process.stdin.on('end', async () => {
    try {
      const r = await buildBundle(JSON.parse(input))
      process.stdout.write(JSON.stringify(r) + '\n')
      process.exit(0)
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 500) }) + '\n')
      process.exit(1)
    }
  })
}
