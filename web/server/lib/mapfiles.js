'use strict'

// Serving the rescued map files.
//
// The archive agent normalises every map to `ZombiesDev\archive\mods\<bsp>\` and records
// each file's size and SHA-256 in `reports\extract.json`. This exposes that as a
// download list plus a byte-serving route, so a launcher on somebody else's PC can
// fetch a map and prove it got the right bytes.
//
// Three things it deliberately does NOT do:
//   * trust the caller's path — `<bsp>` and the filename are both matched against the
//     manifest, never joined into a path and hoped for;
//   * serve anything that is not a map data file — no .exe, ever (dev-box rule 3), even
//     if one is sitting in the folder;
//   * claim a map is available when the files are not on this box. `available` is
//     `fs.existsSync` on every file, not a row in a table.
//
// It reads the archive lazily and caches for a minute: the report is ~1 MB and the maps
// page asks for this list on every load.

const fs = require('node:fs')
const path = require('node:path')

const ARCHIVE = process.env.ZM_ARCHIVE ||
  path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'archive')

// Map data only. An installer that shipped inside a map folder is not ours to pass on.
const ALLOWED = new Set(['.ff', '.iwd', '.arena', '.csv', '.txt', '.cfg', '.gsc'])
const CACHE_MS = 60_000

let cache = null
let cachedAt = 0

function read () {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache

  const byBsp = new Map()
  let rows = []
  try {
    const raw = fs.readFileSync(path.join(ARCHIVE, 'reports', 'extract.json'), 'utf8')
    const j = JSON.parse(raw)
    rows = Array.isArray(j) ? j : [j]
  } catch { rows = [] }

  for (const r of rows) {
    for (const m of r.mods || []) {
      if (!m.bsp || !m.dest) continue
      const files = []
      let bytes = 0
      let missing = 0
      for (const f of m.files || []) {
        const rel = String(f.path).replace(/^mods[\\/][^\\/]+[\\/]/, '')
        if (rel.includes('..') || path.isAbsolute(rel)) continue
        if (!ALLOWED.has(path.extname(rel).toLowerCase())) continue
        const full = path.join(m.dest, rel)
        let size = null
        try { size = fs.statSync(full).size } catch { missing++; continue }
        files.push({ path: rel, size, sha256: f.sha256 || null, kind: 'map' })
        bytes += size
      }
      byBsp.set(m.bsp, { bsp: m.bsp, dir: m.dest, files, bytes, missing })
    }
  }

  cache = byBsp
  cachedAt = Date.now()
  return byBsp
}

// What the launcher needs to install a map: every file, its size and its hash.
// `install_known` is false when we cannot actually hand the bytes over, which the
// launcher shows as "Not available yet" rather than offering a download that 404s.
function forMap (bsp) {
  const e = read().get(String(bsp))
  if (!e || !e.files.length) {
    return { bsp: String(bsp), install_known: false, files: [], size_bytes: 0 }
  }
  return {
    bsp: e.bsp,
    install_known: true,
    size_bytes: e.bytes,
    files: e.files.map(f => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      kind: f.kind,
      url: `/api/maps/${encodeURIComponent(e.bsp)}/files/${encodeURIComponent(f.path)}`
    })),
    // Honest about where this is coming from: B's home connection behind a tunnel, not
    // a CDN. The launcher shows it so a slow download does not look like a hang.
    note: e.missing ? `${e.missing} file(s) recorded by the archive are not on the server` : null
  }
}

// Every map we can actually serve, for the capability flag and the maps page.
function available () {
  const out = []
  for (const e of read().values()) if (e.files.length) out.push(e.bsp)
  return out
}

// Resolve a requested file to a real path, or null. The only way a path is built.
function resolveFile (bsp, rel) {
  const e = read().get(String(bsp))
  if (!e) return null
  const want = String(rel).replace(/\\/g, '/')
  const f = e.files.find(x => x.path.replace(/\\/g, '/') === want)
  if (!f) return null
  const full = path.join(e.dir, f.path)
  // Belt and braces: the resolved path must still be inside the map's own folder.
  if (!path.resolve(full).toLowerCase().startsWith(path.resolve(e.dir).toLowerCase() + path.sep)) return null
  if (!fs.existsSync(full)) return null
  return { full, size: f.size, sha256: f.sha256 }
}

module.exports = { forMap, available, resolveFile, ARCHIVE }
