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
// THE STOCK FOUR HAVE NO PAYLOAD, AND THAT IS NOT A FAILURE.
//
// Nacht der Untoten, Verrückt, Shi No Numa and Der Riese are inside World at War.
// There is nothing in the archive for them and there never will be, so this used to
// answer the same `install_known: false` it gives a custom map whose bytes we have
// lost — and a launcher cannot tell those two apart. It could not, and it did not:
// on 2026-09-22 B pressed Play on Nacht der Untoten and his boot screen stopped at
// "The site has no files for nazi_zombie_prototype yet" with the server ready.
//
// So the answer now says WHY there are no files. `source: 'stock'` and
// `needs_download: false` mean "you already have this map"; `install_known: false`
// with `source: 'custom'` still means "we cannot give you this map". The source is
// the maps table's own column, not a list kept here, so a map reclassified there is
// reclassified here.
function sourceOf (bsp) {
  try { return require('./maps').byKey(String(bsp))?.source || null } catch { return null }
}

function forMap (bsp) {
  const e = read().get(String(bsp))
  const source = sourceOf(bsp)
  if (source === 'stock') {
    return {
      bsp: String(bsp),
      source: 'stock',
      stock: true,
      // There is nothing to install and nothing missing: the install IS known.
      install_known: true,
      needs_download: false,
      files: [],
      size_bytes: 0,
      note: 'This map ships with World at War. There is nothing to download.'
    }
  }
  if (!e || !e.files.length) {
    return { bsp: String(bsp), source: source || 'custom', stock: false, install_known: false, needs_download: true, files: [], size_bytes: 0 }
  }
  return {
    bsp: e.bsp,
    source: source || 'custom',
    stock: false,
    install_known: true,
    needs_download: true,
    size_bytes: e.bytes,
    files: e.files.map(f => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      kind: f.kind,
      url: `/api/maps/${encodeURIComponent(e.bsp)}/files/${encodeURIComponent(f.path)}`,
      // The maps bucket's copy (docs/kickstart/storage.md), when the site is configured
      // with one. A hint, not a promise: `url` stays the stable address, and it 302s to
      // this itself once the copy is verified present. Null when no bucket is configured.
      mirror_url: require('./bucket').mirrorUrl('maps', require('./bucket').keys.mapFile(e.bsp, f.path))
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
  return { full, size: f.size, sha256: f.sha256, bsp: e.bsp, rel: f.path.replace(/\\/g, '/') }
}

// Every servable map and its files, straight from the archive's report — no database.
// tools/s3/sync.js mirrors exactly this list into the maps bucket.
function served () {
  return [...read().values()].filter(e => e.files.length)
}

module.exports = { forMap, available, resolveFile, served, ARCHIVE }
