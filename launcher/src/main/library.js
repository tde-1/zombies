// The map library: installing real custom maps so a player can actually play one.
//
// Where they come from today: the archive agent has normalised 14 maps onto this box
// at `ZombiesDev\archive\mods\<bsp>\`, with per-file sizes and SHA-256s in
// `reports\extract.json` and a title/author/fs_game manifest per map in the repo at
// `archive\manifests\<bsp>.json`. In production this becomes a download from the site;
// the shape of what arrives is the same, which is why `install()` takes a source
// directory and a file list rather than knowing about the archive.
//
// TWO RULES, both from dev-box.md and both load-bearing:
//
//   * **The bsp name is not the title.** `water` is "Alcatraz", `nazi_zombie_test` is
//     "Project Viking", `sanatorium` is "CLINIC OF EVIL". The UI shows the title and
//     the engine gets the bsp; anything that shows a player `nazi_zombie_test1` when
//     they asked for "DESERT" is wrong.
//   * **Never copy or run an executable that came with a map** (rule 3). A map is
//     data: .ff, .iwd, .arena, .csv. An .exe in a mod folder is refused, loudly.
//
// Maps live in the ENW library, never in the WaW install. On World at War the library
// IS the mods folder (`P.maps` = `<fs_homepath>\mods`), so a map is installed straight
// to the path the engine reads: one copy on disk, no reparse points, nothing to repair.
// (The first version kept a separate `maps\` folder and junctioned each map into
// `mods\`; see paths.js for why that is gone.)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { P, assertWritable, ensureDirs } from './paths.js'

const ARCHIVE = process.env.ENW_ARCHIVE || path.join(process.env.ENW_DEV_ROOT || 'C:\\Users\\b\\ZombiesDev', 'archive')
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const MANIFEST_DIR = path.resolve(HERE, '..', '..', '..', 'archive', 'manifests')

// Data only. Anything else in a mod folder is a reason to stop, not to filter quietly.
const ALLOWED_EXT = new Set(['.ff', '.iwd', '.arena', '.csv', '.txt', '.cfg', '.gsc', '.json', '.png', '.jpg', '.dds'])
const BANNED_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.scr', '.com', '.msi', '.vbs', '.js'])

const sha256 = (file) => {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

// ------------------------------------------------------------------ catalogue --

function readManifests() {
  const out = new Map()
  let files = []
  try { files = fs.readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json')) } catch {}
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8'))
      if (m.map) out.set(m.map, m)
    } catch {}
  }
  return out
}

// The archive's extract report is the file list + hashes. Without it we can still
// install (we just cannot verify), and we say which.
function readExtractReport() {
  const byBsp = new Map()
  let rows = []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ARCHIVE, 'reports', 'extract.json'), 'utf8'))
    rows = Array.isArray(j) ? j : [j]
  } catch { return byBsp }
  for (const r of rows) {
    for (const m of r.mods || []) {
      if (!m.bsp || !m.dest) continue
      byBsp.set(m.bsp, {
        bsp: m.bsp,
        dest: m.dest,
        installerFolder: m.installer_folder || null,
        origin: r.original || null,
        // Paths in the report are "mods/<bsp>/<file>"; we want them relative to dest.
        files: (m.files || []).map((f) => ({
          rel: String(f.path).replace(/^mods[\\/][^\\/]+[\\/]/, ''),
          size: f.size,
          sha256: f.sha256,
        })),
      })
    }
  }
  return byBsp
}

// Every map we could install, with the title the player should see.
export function catalogue() {
  const manifests = readManifests()
  const extracts = readExtractReport()
  const out = []
  const seen = new Set()

  const add = (bsp) => {
    if (seen.has(bsp)) return
    seen.add(bsp)
    const man = manifests.get(bsp) || {}
    const ex = extracts.get(bsp)
    const src = ex?.dest || path.join(ARCHIVE, 'mods', bsp)
    const available = fs.existsSync(src)
    const files = ex?.files?.length ? ex.files : listDir(src)
    out.push({
      bsp,
      // The title, always, with the bsp only as a fallback for a map with no manifest.
      title: man.title || bsp,
      author: man.author || null,
      released: man.released || null,
      fsGame: man.fs_game || `mods/${bsp}`,
      badge: man.badge || null,
      finishes: (man.finishes || []).map((f) => f.label).filter(Boolean),
      source: src,
      available,
      verifiable: !!ex?.files?.length,
      files: files.length,
      bytes: files.reduce((n, f) => n + (f.size || 0), 0),
      installed: isInstalled(bsp),
    })
  }

  for (const bsp of extracts.keys()) add(bsp)
  for (const bsp of manifests.keys()) add(bsp)
  try { for (const d of fs.readdirSync(path.join(ARCHIVE, 'mods'), { withFileTypes: true })) if (d.isDirectory()) add(d.name) } catch {}

  out.sort((a, b) => a.title.localeCompare(b.title))
  return { archive: ARCHIVE, manifestDir: MANIFEST_DIR, maps: out }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ rel: e.name, size: fs.statSync(path.join(dir, e.name)).size, sha256: null }))
  } catch { return [] }
}

// --------------------------------------------------------------------- repairs --

// Known, specific defects in shipped custom maps that stop them loading at all.
// Spec 4.5 puts "map bug fixes where the boards accept them" in scope; this is the
// narrowest possible version of that — no rewriting, no guessing, one byte sequence.
//
// **The UTF-8 BOM in `mod.arena`.** T4's info-file parser does not skip a byte-order
// mark, so three bytes in front of the first `{` make it report
// `Missing { in info file`, the map is never registered, and `+map <bsp>` dies with
// `Can't find map "<bsp>"`. The map is perfectly good; it just cannot be reached.
// **2 of the archive's 14 maps ship this way** (`nazi_zombie_hijacked`,
// `nazi_zombie_fear_mc_2`) and are otherwise unplayable.
function repair(file, rel) {
  if (path.extname(rel).toLowerCase() !== '.arena') return null
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  if (buf.length < 3 || buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) return null
  const fixed = buf.subarray(3)
  fs.writeFileSync(file, fixed)
  return {
    what: 'removed a UTF-8 byte-order mark that stops World at War registering the map (it would fail with "Can\'t find map")',
    bytesRemoved: 3,
    sha256Before: crypto.createHash('sha256').update(buf).digest('hex'),
    sha256After: crypto.createHash('sha256').update(fixed).digest('hex'),
  }
}

// ------------------------------------------------------------------- install --

// The library and the engine's view are the same folder.
export const installDir = (bsp) => path.join(P.maps, bsp)
export const modLink = (bsp) => installDir(bsp)

export function isInstalled(bsp) {
  const d = installDir(bsp)
  try { return fs.existsSync(path.join(d, '.enw-installed.json')) && fs.readdirSync(d).length > 1 } catch { return false }
}

export function installedMaps() {
  const out = []
  try {
    for (const e of fs.readdirSync(P.maps, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      let rec = null
      try { rec = JSON.parse(fs.readFileSync(path.join(P.maps, e.name, '.enw-installed.json'), 'utf8')) } catch {}
      if (rec) out.push(rec)
    }
  } catch {}
  return out
}

// Copy a map into the ENW library, verifying every file against the hash the archive
// recorded, then expose it to the engine as <fs_homepath>\mods\<bsp>.
export function install(bsp, { homeDir = P.home, onProgress = () => {}, verify = true } = {}) {
  const cat = catalogue()
  const entry = cat.maps.find((m) => m.bsp === bsp)
  if (!entry) throw new Error(`No map called ${bsp} in the archive.`)
  if (!entry.available) throw new Error(`${entry.title} is not on this machine yet (looked in ${entry.source}).`)

  ensureDirs()
  const src = entry.source
  const dest = assertWritable(installDir(bsp))
  fs.mkdirSync(dest, { recursive: true })

  const extracts = readExtractReport()
  const want = extracts.get(bsp)?.files?.length ? extracts.get(bsp).files : listDir(src)

  const copied = []
  const problems = []
  let bytes = 0

  for (const f of want) {
    const ext = path.extname(f.rel).toLowerCase()
    // dev-box rule 3. A map's installer is data to us; an executable inside one is not
    // something we copy anywhere, whatever its readme says.
    if (BANNED_EXT.has(ext)) {
      problems.push(`refused ${f.rel}: ENW never copies or runs an executable that came with a map`)
      continue
    }
    if (ext && !ALLOWED_EXT.has(ext)) {
      problems.push(`skipped ${f.rel}: not a file type a map needs`)
      continue
    }
    const from = path.join(src, f.rel)
    if (!fs.existsSync(from)) { problems.push(`missing from the archive: ${f.rel}`); continue }
    const to = assertWritable(path.join(dest, f.rel))
    fs.mkdirSync(path.dirname(to), { recursive: true })

    onProgress({ file: f.rel, bytes: f.size || 0, done: bytes, total: entry.bytes })
    fs.copyFileSync(from, to)

    const st = fs.statSync(to)
    if (f.size != null && st.size !== f.size) {
      problems.push(`${f.rel}: copied ${st.size} bytes, the archive recorded ${f.size}`)
    }
    if (verify && f.sha256) {
      const got = sha256(to)
      if (got !== f.sha256) {
        try { fs.unlinkSync(to) } catch {}
        throw new Error(`${f.rel} does not match the hash the archive recorded. Removed it; the map is not installed.`)
      }
    }
    // ---- repairs -------------------------------------------------------------
    // Applied AFTER the hash check, so we always verify what the archive actually
    // has and only then change it, recording both hashes. A repair is never silent
    // and never guessed: each one is a specific, known-broken thing.
    const fix = repair(to, f.rel)
    if (fix) {
      problems.push(`${f.rel}: ${fix.what}`)
      copied.push({ rel: f.rel, size: fs.statSync(to).size, sha256: f.sha256 || null, repaired: fix })
      bytes += fs.statSync(to).size
      continue
    }

    copied.push({ rel: f.rel, size: st.size, sha256: f.sha256 || null })
    bytes += st.size
  }

  if (!copied.length) throw new Error(`Nothing to install for ${entry.title}: no usable files in ${src}.`)

  // No linking step: `dest` already IS `<fs_homepath>\mods\<bsp>`, which is where the
  // engine looks. `fs_game mods/<bsp>` finds it directly.
  const record = {
    bsp,
    title: entry.title,
    author: entry.author,
    fsGame: entry.fsGame,
    installedAt: new Date().toISOString(),
    from: src,
    dir: dest,
    modLink: dest,
    files: copied,
    bytes,
    verified: verify && entry.verifiable,
    problems,
  }
  fs.writeFileSync(assertWritable(path.join(dest, '.enw-installed.json')), JSON.stringify(record, null, 2))
  return record
}

export function uninstall(bsp) {
  const done = []
  const dir = installDir(bsp)
  if (fs.existsSync(dir)) {
    fs.rmSync(assertWritable(dir), { recursive: true, force: true })
    done.push(`removed ${dir}`)
  } else {
    done.push(`${bsp} was not installed`)
  }
  return done
}

// A cheap integrity pass over the library: is every map still where its record says,
// with the right number of files? Used by the Storage page and after an update.
export function verify() {
  const out = []
  for (const rec of installedMaps()) {
    const dir = installDir(rec.bsp)
    let files = 0
    try { files = fs.readdirSync(dir).filter((f) => f !== '.enw-installed.json').length } catch {}
    out.push({
      bsp: rec.bsp,
      title: rec.title,
      ok: files === rec.files.length,
      files,
      expected: rec.files.length,
      dir,
    })
  }
  return out
}
