#!/usr/bin/env node
// Put the ENW client DLL where the packager can find it, and REFUSE TO BUILD WITHOUT IT.
//
// This exists because of a real failure: the first packaged build shipped with no
// `enw_t4.dll` in it at all. `*.dll` is gitignored and the client is a build artefact,
// so nothing in the pipeline noticed. The installer ran fine, setup ran fine, and the
// launcher then said "The ENW client is not installed yet" forever, because there was
// nothing to install. An installer that cannot possibly work should not be produced.
//
// Runs from `npm run pack` (prepack). Exit non-zero and the build stops.
//
//   node tools/stage-client.js            # newest build in ../build/*/
//   node tools/stage-client.js --from ..\build\referee\enw_t4.dll
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAUNCHER = path.resolve(HERE, '..')
const REPO = path.resolve(LAUNCHER, '..')
const DEST_DIR = path.join(LAUNCHER, 'resources', 'client')
const DEST = path.join(DEST_DIR, 'enw_t4.dll')

const argv = process.argv.slice(2)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

// Variants built for one experiment are not the client. Prefer a plain build.
const PREFER = ['launcher', 'client-lane', 'referee', 'foundation']

// AND THEN CHECK ITS AGE, because the preference above shipped a stale client
// twice. 2026-09-22: `build/launcher` was preferred unconditionally, so a DLL
// built before `borderless.cpp` and the newest `mouse_polling.cpp` even existed
// went into 0.2.2 while a newer build sat in `build/c2`. B played it, reported
// "borderless is not working" and "the mouse stutter is still there", and both
// were true: the components were not in the binary he ran. A preference list is
// allowed to pick WHICH build; it is not allowed to pick an OLD one.
const SOURCE_GLOBS = ['client-dll/components', 'server/components', 'shared/core', 'shared/t4']

function newestSourceMs() {
  let newest = 0
  let file = null
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(cpp|hpp|h|c)$/i.test(e.name)) continue
      const m = fs.statSync(p).mtimeMs
      if (m > newest) { newest = m; file = p }
    }
  }
  for (const g of SOURCE_GLOBS) walk(path.join(REPO, g))
  return { newest, file }
}

function candidates() {
  const out = []
  const buildRoot = path.join(REPO, 'build')
  let dirs = []
  try { dirs = fs.readdirSync(buildRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch {}
  for (const d of dirs) {
    const p = path.join(buildRoot, d, 'enw_t4.dll')
    if (!fs.existsSync(p)) continue
    out.push({ name: d, path: p, mtime: fs.statSync(p).mtimeMs, preferred: PREFER.indexOf(d) })
  }
  // A preferred build first, then whatever is newest.
  out.sort((a, b) => {
    const ap = a.preferred < 0 ? 99 : a.preferred
    const bp = b.preferred < 0 ? 99 : b.preferred
    return ap - bp || b.mtime - a.mtime
  })
  return out
}

const explicit = val('--from')
let chosen = null
if (explicit) {
  if (!fs.existsSync(explicit)) {
    console.error(`stage-client: ${explicit} does not exist`)
    process.exit(1)
  }
  chosen = { name: 'given explicitly', path: path.resolve(explicit), mtime: fs.statSync(explicit).mtimeMs }
} else {
  chosen = candidates()[0] || null
}

if (!chosen) {
  console.error('')
  console.error('  stage-client: NO CLIENT DLL, SO THERE IS NOTHING TO SHIP.')
  console.error('')
  console.error('  The launcher installs `enw_t4.dll` into the player\'s ENW folder as the')
  console.error('  binkw32 proxy. Without it the installer builds fine, setup runs fine, and')
  console.error('  the launcher says "The ENW client is not installed yet" forever.')
  console.error('')
  console.error('  Build it first:')
  console.error('    powershell -ExecutionPolicy Bypass -File tools\\dev\\build.ps1 -Name launcher')
  console.error('')
  console.error(`  Looked in ${path.join(REPO, 'build', '*', 'enw_t4.dll')}`)
  console.error('')
  process.exit(1)
}

// THE STALENESS GATE. An installer that ships a client older than the code is
// worse than one that fails to build: it produces a player report about a
// feature that was never in the binary.
if (!argv.includes('--allow-stale')) {
  const src = newestSourceMs()
  if (src.newest && chosen.mtime < src.newest) {
    const age = ((src.newest - chosen.mtime) / 3600e3).toFixed(1)
    console.error('')
    console.error('  stage-client: THE CLIENT DLL IS OLDER THAN THE CLIENT SOURCE.')
    console.error('')
    console.error(`  ${chosen.path}`)
    console.error(`    built  ${new Date(chosen.mtime).toISOString()}`)
    console.error(`  ${src.file}`)
    console.error(`    edited ${new Date(src.newest).toISOString()}  (${age} h newer)`)
    console.error('')
    console.error('  Shipping this would put a player on a build that does not contain the')
    console.error('  components you just wrote -- which is exactly how 0.2.2 shipped without')
    console.error('  borderless.cpp in it. Rebuild first:')
    console.error('')
    console.error('    powershell -ExecutionPolicy Bypass -File tools\\dev\\build.ps1 -Name launcher')
    console.error('')
    console.error('  (--allow-stale overrides this, and you should have a reason.)')
    console.error('')
    process.exit(1)
  }
}

fs.mkdirSync(DEST_DIR, { recursive: true })
fs.copyFileSync(chosen.path, DEST)
const sha = crypto.createHash('sha256').update(fs.readFileSync(DEST)).digest('hex')
const meta = {
  from: chosen.path,
  build: chosen.name,
  built: new Date(chosen.mtime).toISOString(),
  staged: new Date().toISOString(),
  bytes: fs.statSync(DEST).size,
  sha256: sha,
}
fs.writeFileSync(path.join(DEST_DIR, 'client.json'), JSON.stringify(meta, null, 2))

console.log(`stage-client: ${chosen.path}`)
console.log(`  -> ${DEST}`)
console.log(`  ${(meta.bytes / 1e6).toFixed(2)} MB, built ${meta.built}, sha256 ${sha.slice(0, 16)}…`)
