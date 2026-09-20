// Finding Call of Duty: World at War, and proving it is the real thing.
//
// Spec 13 §2 / 99 §4.3:
//   1. auto-detect through EVERY Steam route
//   2. a FORGIVING browse fallback (the player may pick the wrong folder; we search
//      up and down and correct ourselves)
//   3. validate: CoDWaW.exe present, version 1.7, looks like the Steam build, and the
//      player owns appid 10090
//
// Two rules run through all of it:
//   * Every route reports what it tried and why it accepted or rejected the result.
//     "Not found" with no explanation is the worst possible first-run experience.
//   * We only ever READ. Nothing here creates, moves or deletes a file.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getValue, queryKey } from './winreg.js'
import { parse as parseVdf, get as vget } from './vdf.js'
import * as pe from './pe.js'

export const APPID = '10090'

// From docs/dev-box.md / vault 11: B's Steam copy, build 252004, SteamStub DRM.
export const KNOWN = {
  exe: 'CoDWaW.exe',
  size: 5902336,
  sha256: '732900D158982C33E3121F0B86D22230BE79839BBCBFE3BDFC1238F408A7D64D'.toLowerCase(),
  build: 252004,
  version: '1.7',
}

// Never, ever the multiplayer exe (dev-box.md rule 2).
export const FORBIDDEN_EXE = 'codwawmp.exe'

const log = (...a) => { if (process.env.ENW_DETECT_VERBOSE) console.error('[detect]', ...a) }

// --------------------------------------------------------------------- helpers --

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

function sha256(file) {
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

// Case-insensitive directory entry lookup. Windows is case-insensitive but a path we
// build by hand from a .acf can still be wrong in other ways, and readdir is cheap.
function childNamed(dir, name) {
  try {
    const want = name.toLowerCase()
    for (const e of fs.readdirSync(dir)) if (e.toLowerCase() === want) return path.join(dir, e)
  } catch {}
  return null
}

// ----------------------------------------------------------------- validation --

// Grades one candidate folder. Returns a full verdict, never a bare boolean: the UI
// shows the player exactly what we checked.
export function validate(gameDir, { hash = true } = {}) {
  const checks = []
  const add = (id, ok, detail) => { checks.push({ id, ok, detail }); return ok }

  const dir = path.resolve(gameDir)
  if (!add('folder', isDir(dir), dir)) {
    return { ok: false, dir, exe: null, checks, reason: 'That folder does not exist.' }
  }

  const exe = childNamed(dir, KNOWN.exe)
  if (!add('exe_present', !!exe, exe || `no ${KNOWN.exe} in ${dir}`)) {
    return { ok: false, dir, exe: null, checks, reason: `No ${KNOWN.exe} in that folder.` }
  }
  // Guard rail, not a real check: if we ever find ourselves pointed at the MP exe,
  // stop. We never launch it (dev-box.md rule 2).
  if (path.basename(exe).toLowerCase() === FORBIDDEN_EXE) {
    return { ok: false, dir, exe: null, checks, reason: 'That is the multiplayer executable. ENW only uses the co-op/solo one.' }
  }

  const st = fs.statSync(exe)
  const sizeOk = st.size === KNOWN.size
  add('exe_size', sizeOk, `${st.size.toLocaleString()} bytes (expected ${KNOWN.size.toLocaleString()})`)

  const info = pe.read(exe)
  add('pe', !!info && info.pe32 && info.machine === 0x14c, info ? `32-bit PE, sections ${info.sections.join(' ')}` : 'not a readable PE file')

  const v17 = pe.isVersion17(info?.version)
  add('version_1_7', v17, info?.version ? `file ${info.version.fileString}, product ${info.version.productString}` : 'no version resource')

  const steamBuild = !!info?.hasBind
  add('steam_build', steamBuild, steamBuild
    ? '.bind section present (SteamStub) — this is the Steam release'
    : 'no .bind section — not a SteamStub-wrapped Steam build')

  let digest = null
  let known = false
  if (hash && info) {
    try {
      digest = sha256(exe)
      known = digest === KNOWN.sha256
      add('sha256', known, known ? `${digest} — the known Steam 1.7 build ${KNOWN.build}` : `${digest} — not the build we know`)
    } catch (e) {
      add('sha256', false, `could not hash: ${e.message}`)
    }
  }

  // Other things a real install has. Not fatal on their own; they catch "the player
  // picked a folder that happens to contain a renamed exe".
  const hasMain = isDir(path.join(dir, 'main'))
  const hasZone = isDir(path.join(dir, 'zone'))
  add('game_data', hasMain && hasZone, `main/=${hasMain} zone/=${hasZone}`)

  // The decision.
  //
  // "Cannot be fooled" means: the exact known build is the only thing we call VERIFIED.
  // A 1.7 SteamStub exe of the right size with the game data beside it is ACCEPTED —
  // players do have slightly different files (a different Steam depot revision) and
  // refusing them would be the "as easy to set up as possible" rule broken. Anything
  // else is rejected with the reason shown.
  let grade, ok, reason
  if (known && hasMain && hasZone) {
    grade = 'verified'
    ok = true
    reason = `Call of Duty: World at War 1.7, Steam build ${KNOWN.build}. Exact match.`
  } else if (v17 && steamBuild && sizeOk && hasMain && hasZone) {
    grade = 'accepted'
    ok = true
    reason = 'World at War 1.7 (Steam). The executable differs from the build we know, so verified play may need an update.'
  } else if (v17 && steamBuild && hasMain && hasZone) {
    grade = 'accepted_unknown'
    ok = true
    reason = 'World at War 1.7 (Steam), but the executable is a different size than expected. Modded or patched installs are not eligible for records.'
  } else if (!steamBuild) {
    grade = 'rejected'
    ok = false
    reason = 'That executable is not the Steam release of World at War (no SteamStub). ENW needs the Steam version.'
  } else if (!v17) {
    grade = 'rejected'
    ok = false
    reason = 'That copy of World at War is not version 1.7. Let Steam update it and try again.'
  } else {
    grade = 'rejected'
    ok = false
    reason = 'That folder has a World at War executable but not the game files beside it (no main/ or zone/).'
  }

  return {
    ok, grade, dir, exe, reason, checks,
    sha256: digest,
    knownBuild: known,
    size: st.size,
    version: info?.version?.fileString || null,
    steamBuild,
  }
}

// -------------------------------------------------------------- Steam plumbing --

export async function steamRoots() {
  const found = []
  const seen = new Set()
  const push = (p, via) => {
    if (!p) return
    const abs = path.resolve(p.replace(/\//g, path.sep))
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ path: abs, via, exists: isDir(abs) })
  }

  push(await getValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'), 'HKCU\\Software\\Valve\\Steam\\SteamPath')
  push(await getValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'), 'HKLM\\...\\WOW6432Node\\Valve\\Steam\\InstallPath')
  push(await getValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath', { wow64: 64 }), 'HKLM\\SOFTWARE\\Valve\\Steam\\InstallPath (64)')
  // Last resort, so a broken registry is not fatal.
  push('C:\\Program Files (x86)\\Steam', 'default path')
  push('C:\\Program Files\\Steam', 'default path')
  return found.filter((x) => x.exists)
}

// Every Steam library on the machine: the install root itself plus every entry in
// libraryfolders.vdf (both the old flat format and the current object format).
export function steamLibraries(steamRoot) {
  const libs = [{ path: path.resolve(steamRoot), via: 'Steam install root', apps: null }]
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  if (!exists(vdfPath)) return { libs, vdfPath, vdfFound: false }
  try {
    const root = parseVdf(fs.readFileSync(vdfPath, 'utf8'))
    const lf = vget(root, 'libraryfolders') || vget(root, 'LibraryFolders') || root
    for (const [k, v] of Object.entries(lf || {})) {
      if (!/^\d+(#\d+)?$/.test(k)) continue
      if (typeof v === 'string') {
        libs.push({ path: path.resolve(v), via: `libraryfolders.vdf [${k}]`, apps: null })
      } else if (v && typeof v === 'object') {
        const p = vget(v, 'path')
        const apps = vget(v, 'apps')
        if (p) libs.push({ path: path.resolve(p), via: `libraryfolders.vdf [${k}]`, apps: apps ? Object.keys(apps) : null })
      }
    }
  } catch (e) {
    log('libraryfolders.vdf unreadable:', e.message)
    return { libs, vdfPath, vdfFound: true, vdfError: e.message }
  }
  // Dedupe.
  const seen = new Set()
  return {
    vdfPath,
    vdfFound: true,
    libs: libs.filter((l) => {
      const k = l.path.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return isDir(l.path)
    }),
  }
}

// appmanifest_10090.acf -> installdir, plus the state flags that say whether the
// install actually finished.
export function readAppManifest(libPath) {
  const acf = path.join(libPath, 'steamapps', `appmanifest_${APPID}.acf`)
  if (!exists(acf)) return { acf, found: false }
  try {
    const root = parseVdf(fs.readFileSync(acf, 'utf8'))
    const st = vget(root, 'AppState') || {}
    const installdir = vget(st, 'installdir')
    const stateFlags = Number(vget(st, 'StateFlags') || 0)
    const bytes = Number(vget(st, 'SizeOnDisk') || 0)
    const dir = installdir ? path.join(libPath, 'steamapps', 'common', installdir) : null
    return {
      acf, found: true, installdir, dir, stateFlags, bytes,
      name: vget(st, 'name') || null,
      buildid: vget(st, 'buildid') || null,
      // 4 = fully installed. 1026/1030 etc. mean "update required" / "downloading".
      fullyInstalled: (stateFlags & 4) === 4,
      updating: (stateFlags & (2 | 1024 | 512)) !== 0,
    }
  } catch (e) {
    return { acf, found: true, error: e.message }
  }
}

// Does this machine's Steam think the signed-in user owns 10090?
//
// Honest about its limits: a local Steam install cannot *prove* ownership offline, and
// we are not asking the player for credentials. What we can say is "Steam has this app
// registered / installed for the logged-in account", which is what the first-run screen
// needs in order to choose between "Install via Steam" and "Get it on Steam".
export async function ownership() {
  const signals = []
  const reg = await queryKey(`HKCU\\Software\\Valve\\Steam\\Apps\\${APPID}`)
  if (reg.ok) {
    const installed = (vget(reg.values, 'Installed') || {}).value
    const name = (vget(reg.values, 'Name') || {}).value
    signals.push({
      source: `HKCU\\Software\\Valve\\Steam\\Apps\\${APPID}`,
      installed: installed === '0x1',
      detail: `Installed=${installed ?? '?'}${name ? ` Name=${name}` : ''}`,
    })
  } else {
    signals.push({ source: `HKCU\\...\\Steam\\Apps\\${APPID}`, installed: false, detail: 'no key (Steam has never run this app on this account)' })
  }
  return signals
}

export async function steamAccount() {
  for (const root of await steamRoots()) {
    const f = path.join(root.path, 'config', 'loginusers.vdf')
    if (!exists(f)) continue
    try {
      const v = parseVdf(fs.readFileSync(f, 'utf8'))
      const users = vget(v, 'users') || {}
      const out = []
      for (const [id64, u] of Object.entries(users)) {
        out.push({
          steamid: id64,
          account: vget(u, 'AccountName') || null,
          persona: vget(u, 'PersonaName') || null,
          mostRecent: vget(u, 'MostRecent') === '1',
          timestamp: Number(vget(u, 'Timestamp') || 0),
        })
      }
      out.sort((a, b) => Number(b.mostRecent) - Number(a.mostRecent) || b.timestamp - a.timestamp)
      if (out.length) return { file: f, users: out, current: out[0] }
    } catch {}
  }
  return { file: null, users: [], current: null }
}

// ------------------------------------------------------------------ the search --

// A forgiving search around a folder the player picked.
//
// B: "it must tolerate them choosing the wrong folder." So from `start` we look:
//   * AT it,
//   * DOWN into it (breadth-first, bounded depth and bounded work),
//   * UP through its parents, and down one level from each of those, plus the
//     steamapps/common convention at every level.
// Bounded everywhere so picking C:\ cannot hang the launcher.
export function searchAround(start, { maxDepth = 4, maxDirs = 4000, maxUp = 6 } = {}) {
  const tried = []
  const hits = []
  let scanned = 0
  const seen = new Set()

  const consider = (dir, how) => {
    if (!dir) return false
    const key = path.resolve(dir).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    const exe = childNamed(dir, KNOWN.exe)
    tried.push({ dir: path.resolve(dir), how, hit: !!exe })
    if (exe) { hits.push({ dir: path.resolve(dir), exe, how }); return true }
    return false
  }

  // Skip folders that are big, irrelevant, or a trap (a junctioned tree can loop).
  const SKIP = new Set(['windows', '$recycle.bin', 'system volume information', 'node_modules', 'appdata', 'programdata', 'zone', 'main', 'images', 'sound'])
  const skippable = (name) => SKIP.has(name.toLowerCase())

  function down(root, how) {
    const queue = [[root, 0]]
    while (queue.length && scanned < maxDirs) {
      const [dir, depth] = queue.shift()
      if (consider(dir, how)) return true
      if (depth >= maxDepth) continue
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      scanned++
      for (const e of entries) {
        // isDirectory() is false for a junction; isSymbolicLink() catches those, and we
        // deliberately do not follow them (a junction loop is a real thing on Windows).
        if (!e.isDirectory() || e.isSymbolicLink()) continue
        if (skippable(e.name)) continue
        queue.push([path.join(dir, e.name), depth + 1])
      }
    }
    return false
  }

  // Sometimes the player picks the exe itself.
  let origin = path.resolve(start)
  try { if (fs.statSync(origin).isFile()) origin = path.dirname(origin) } catch {}

  if (down(origin, 'in the folder you picked')) return done()

  // Up, and one level down from each parent, and the steamapps/common convention.
  let cur = origin
  for (let i = 0; i < maxUp; i++) {
    const parent = path.dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
    if (consider(cur, `${i + 1} level(s) above the folder you picked`)) return done()
    const common = path.join(cur, 'steamapps', 'common')
    if (isDir(common)) {
      if (down(common, `the Steam library at ${cur}`)) return done()
    }
    // One level down from the parent catches "they picked the sibling folder".
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || skippable(e.name)) continue
      if (consider(path.join(cur, e.name), `beside the folder you picked (in ${path.basename(cur)})`)) return done()
    }
  }

  return done()

  function done() {
    return { hits, tried, scanned, start: origin }
  }
}

// ---------------------------------------------------------------- the detector --

// Runs every route in order and returns one report. Nothing throws: a first-run
// screen that crashes is worse than one that says "we could not find it".
export async function detect({ hint = null, hash = true } = {}) {
  const started = Date.now()
  const routes = []
  const candidates = []
  const addCandidate = (dir, via, confidence) => {
    if (!dir) return
    const abs = path.resolve(dir)
    if (candidates.some((c) => c.dir.toLowerCase() === abs.toLowerCase())) return
    candidates.push({ dir: abs, via, confidence })
  }

  // Route 0: whatever the caller already believed (a saved path, or a browse result).
  if (hint) {
    const r = searchAround(hint)
    routes.push({
      route: 'hint',
      detail: `searched around ${path.resolve(hint)}`,
      found: r.hits.length,
      scanned: r.scanned,
      tried: r.tried.slice(0, 40),
    })
    for (const h of r.hits) addCandidate(h.dir, `you chose ${path.resolve(hint)} — found ${path.relative(path.resolve(hint), h.dir) || 'it there'} (${h.how})`, 90)
  }

  // Route 1: the Steam registry.
  const roots = await steamRoots()
  routes.push({
    route: 'steam_registry',
    detail: roots.length ? roots.map((r) => `${r.path} (${r.via})`).join('; ') : 'Steam not found in the registry',
    found: roots.length,
  })

  // Route 2 + 3: libraries -> appmanifest_10090.acf -> installdir.
  const libReports = []
  for (const root of roots) {
    const { libs, vdfPath, vdfFound, vdfError } = steamLibraries(root.path)
    libReports.push({ steam: root.path, vdfPath, vdfFound, vdfError, libraries: libs.map((l) => l.path) })
    for (const lib of libs) {
      const man = readAppManifest(lib.path)
      if (!man.found) continue
      routes.push({
        route: 'appmanifest',
        detail: `${man.acf}: installdir="${man.installdir}" StateFlags=${man.stateFlags}` +
          (man.fullyInstalled ? ' (fully installed)' : man.updating ? ' (Steam is still downloading/updating it)' : ' (not fully installed)'),
        found: man.dir ? 1 : 0,
      })
      if (man.dir) addCandidate(man.dir, `Steam's own records: ${man.acf}`, man.fullyInstalled ? 100 : 60)
      // The manifest can point at a folder that has been deleted or renamed by hand.
      if (man.dir && !isDir(man.dir)) {
        const around = searchAround(path.join(lib.path, 'steamapps', 'common'), { maxDepth: 2 })
        for (const h of around.hits) addCandidate(h.dir, `Steam's records pointed at a missing folder; found it nearby (${h.how})`, 70)
      }
    }
    // Even with no manifest, the convention is worth one cheap look.
    for (const lib of libs) {
      for (const name of ['Call of Duty World at War', 'Call of Duty - World at War', 'CallOfDutyWorldAtWar']) {
        const d = path.join(lib.path, 'steamapps', 'common', name)
        if (isDir(d)) addCandidate(d, `the usual folder name in the Steam library at ${lib.path}`, 80)
      }
    }
  }
  routes.push({ route: 'steam_libraries', detail: JSON.stringify(libReports), found: libReports.reduce((n, r) => n + r.libraries.length, 0) })

  // Route 4: ownership signals from the running Steam client's own records.
  const own = await ownership()
  const acct = await steamAccount()
  routes.push({
    route: 'ownership',
    detail: own.map((s) => `${s.source}: ${s.detail}`).join('; ') +
      (acct.current ? ` | signed in as ${acct.current.persona || acct.current.account} (${acct.current.steamid})` : ' | no signed-in Steam account found'),
    found: own.filter((s) => s.installed).length,
  })

  // Validate every candidate, best first.
  candidates.sort((a, b) => b.confidence - a.confidence)
  const results = candidates.map((c) => ({ ...c, ...validate(c.dir, { hash }) }))
  const accepted = results.filter((r) => r.ok)
  const best =
    accepted.find((r) => r.grade === 'verified') ||
    accepted.find((r) => r.grade === 'accepted') ||
    accepted[0] ||
    null

  const anyManifest = routes.some((r) => r.route === 'appmanifest' && r.found)
  const ownedSignal = own.some((s) => s.installed) || anyManifest

  return {
    ok: !!best,
    game: best
      ? {
          dir: best.dir,
          exe: best.exe,
          grade: best.grade,
          version: best.version,
          sha256: best.sha256,
          knownBuild: best.knownBuild,
          via: best.via,
        }
      : null,
    // What the first-run screen needs in order to pick its wording.
    state: best ? 'installed' : ownedSignal ? 'owned_not_installed' : 'unknown',
    owned: ownedSignal,
    steamAccount: acct.current,
    candidates: results.map((r) => ({
      dir: r.dir, via: r.via, ok: r.ok, grade: r.grade, reason: r.reason,
      sha256: r.sha256, version: r.version, size: r.size, checks: r.checks,
    })),
    routes,
    tookMs: Date.now() - started,
  }
}

// The browse fallback, as the UI calls it: "the player picked this folder — sort it out."
export async function fromBrowse(folder, { hash = true } = {}) {
  const around = searchAround(folder)
  const results = around.hits.map((h) => ({ ...h, ...validate(h.dir, { hash }) }))
  const accepted = results.filter((r) => r.ok)
  const best = accepted.find((r) => r.grade === 'verified') || accepted[0] || null
  return {
    ok: !!best,
    game: best ? { dir: best.dir, exe: best.exe, grade: best.grade, version: best.version, sha256: best.sha256, knownBuild: best.knownBuild } : null,
    picked: path.resolve(folder),
    corrected: best ? path.resolve(best.dir).toLowerCase() !== path.resolve(folder).toLowerCase() : false,
    how: best?.how || null,
    scanned: around.scanned,
    tried: around.tried,
    candidates: results.map((r) => ({ dir: r.dir, how: r.how, ok: r.ok, grade: r.grade, reason: r.reason, checks: r.checks })),
    reason: best
      ? best.reason
      : around.hits.length
        ? results[0].reason
        : `We looked in ${path.resolve(folder)}, inside it, and in the folders above it, and did not find ${KNOWN.exe}. Pick the folder that has ${KNOWN.exe} in it (usually "...\\steamapps\\common\\Call of Duty World at War").`,
  }
}
