'use strict'

// What is released right now (admin → Release, 2026-09-23).
//
//   * the launcher update feed: web/public/updates/latest.yml as electron-updater reads it,
//     and whether the installer it names is on disk beside it;
//   * the game DLL on each box. The site is never told the DLL's sha256: the referee hears a
//     build STAMP at `hello` (`dll_build`, __DATE__ __TIME__ of the build) and the game exe's
//     sha256, and both ride in every result's `hashes`. Those are shown as heard. The sha an
//     operator deployed (next-session.md "Deploy a box DLL") can be written down here, in the
//     `settings` table, so the panel carries it instead of a STATUS line. If a future agent
//     heartbeat carries `dll_sha256`, it is shown as reported.

const fs = require('fs')
const path = require('path')
const { db, now } = require('../db/database')
const { safeJson } = require('./util')

const UPDATES_DIR = () => process.env.ZM_UPDATES_DIR || path.join(__dirname, '..', '..', 'public', 'updates')

// latest.yml is flat and electron-builder writes it the same way every time; a YAML
// dependency for eight keys is not worth it.
function parseLatest(text) {
  const out = { files: [] }
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    let m
    if ((m = line.match(/^\s*-\s+url:\s*(.+)$/))) { cur = { url: unq(m[1]) }; out.files.push(cur); continue }
    if ((m = line.match(/^\s{2,}(\w+):\s*(.+)$/)) && cur) { cur[m[1]] = num(unq(m[2])); continue }
    if ((m = line.match(/^(\w+):\s*(.*)$/))) { cur = null; if (m[2] !== '') out[m[1]] = num(unq(m[2])) }
  }
  return out
}
const unq = (s) => String(s).trim().replace(/^['"]|['"]$/g, '')
const num = (s) => (/^\d+$/.test(s) ? Number(s) : s)

function feed() {
  const dir = UPDATES_DIR()
  const file = path.join(dir, 'latest.yml')
  let st = null
  try { st = fs.statSync(file) } catch { return { published: false, dir, note: 'no latest.yml' } }
  const y = parseLatest(fs.readFileSync(file, 'utf8'))
  const inst = y.path || (y.files[0] && y.files[0].url) || null
  let onDisk = null
  if (inst) {
    try { const s = fs.statSync(path.join(dir, path.basename(inst))); onDisk = { size: s.size, matches: !y.files[0] || !y.files[0].size || s.size === y.files[0].size } } catch { onDisk = null }
  }
  const versions = (() => {
    try {
      return fs.readdirSync(dir).map((f) => (f.match(/-(\d+\.\d+\.\d+)\.exe$/) || [])[1]).filter(Boolean)
        .sort((a, b) => cmp(b, a)).slice(0, 8)
    } catch { return [] }
  })()
  return {
    published: true,
    version: y.version || null,
    release_date: y.releaseDate || null,
    installer: inst,
    size: (y.files[0] && y.files[0].size) || null,
    sha512: y.sha512 || null,
    on_disk: onDisk,
    yml_mtime: st.mtimeMs,
    recent: versions,
    bucket: process.env.S3_BUCKET_FILES || null,
  }
}
const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }

const noteKey = (box) => `box_dll:${box}`

function noted(box) {
  const r = db.prepare('SELECT value, updated_at FROM settings WHERE key=?').get(noteKey(box))
  return r ? { ...(safeJson(r.value, {}) || {}), at: r.updated_at } : null
}

function setNote(box, { sha256, commit = null, note = null }, by) {
  const sha = String(sha256 || '').trim().toLowerCase()
  if (!/^[0-9a-f]{8,64}$/.test(sha)) return { ok: false, error: 'sha256 is 8 to 64 hex characters' }
  const value = JSON.stringify({ sha256: sha, commit: commit ? String(commit).slice(0, 40) : null, note: note ? String(note).slice(0, 200) : null, by })
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .run(noteKey(box), value, now())
  return { ok: true, noted: noted(box) }
}

function boxes() {
  const adminBoxes = require('./adminBoxes')
  return db.prepare('SELECT id, name, last_status_json, last_poll FROM boxes ORDER BY name').all().map((b) => {
    const st = safeJson(b.last_status_json, {}) || {}
    return {
      name: b.name,
      reported: st.dll_sha256 || (st.host && st.host.dll_sha256) || null,
      heard: adminBoxes.lastHashes(b.name),
      noted: noted(b.name),
    }
  })
}

function status() {
  return { feed: feed(), boxes: boxes() }
}

module.exports = { status, feed, parseLatest, setNote, noted }
