// Setup: put the ENW client somewhere that is ours.
//
// B's decision (spec 13 §2, 99 §4.3): our DLL goes into a SEPARATE ENW FOLDER, never
// into the Steam install. The player's game is untouched and everything we do is
// reversible. This mirrors what tools/dev/new-copy.ps1 + deploy.ps1 already do for the
// agents, with the same reasoning:
//
//   * the big asset folders (main, zone, DirectX, Docs, installers, pb) are NTFS
//     JUNCTIONS back into the player's install, so the ENW copy costs ~12 MB, not 12 GB,
//     and the junction targets are only ever read;
//   * the root files (exe, dlls, bmp, ico, txt, inf, vdf) are real copies, so we can
//     drop our proxy DLL beside them;
//   * steam_appid.txt = 10090 stops SteamStub bouncing the launch back into the Steam
//     folder (foundation.md §7: without it the copy exits(0) after ~1.5 s);
//   * binkw32.dll is ours; the stock one becomes binkw32_org.dll and every export
//     forwards to it (foundation.md §2).
//
// Everything created is written into a manifest so the UI can say exactly what changed
// and uninstall can undo exactly that.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { P, assertWritable, protectPath, isInside, ensureDirs } from './paths.js'
import { validate } from './detect.js'

// Junctioned (big, shared, read-only). Same list as tools/dev/new-copy.ps1.
export const LINK_DIRS = ['main', 'zone', 'DirectX', 'Docs', 'installers', 'pb']

export const MOD_NAME = 'mods/enw'

const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

function fingerprintDir(dir) {
  // Names + sizes + mtimes of the top level only. Enough to prove afterwards that we
  // did not touch the player's install, and cheap enough to run every time.
  const out = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    try {
      const st = fs.lstatSync(p)
      out[e.name] = `${st.isDirectory() ? 'd' : 'f'}:${st.size}:${Math.floor(st.mtimeMs)}`
    } catch { out[e.name] = 'unreadable' }
  }
  return out
}

function diffFingerprints(before, after) {
  const changes = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changes.push(`${k}: ${before[k] ?? '(absent)'} -> ${after[k] ?? '(deleted)'}`)
  }
  return changes
}

// Find the ENW client DLL to install. In a shipped launcher it is bundled; during
// development we take the freshest build out of the repo.
export function findClientDll({ repoRoot = null, explicit = null } = {}) {
  const tried = []
  const consider = (p, via) => {
    tried.push({ path: p, via, exists: fs.existsSync(p) })
    return fs.existsSync(p) ? { path: p, via, mtime: fs.statSync(p).mtimeMs } : null
  }
  const hits = []
  if (explicit) { const h = consider(path.resolve(explicit), 'given explicitly'); if (h) hits.push(h) }

  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const launcherRoot = path.resolve(here, '..', '..')
  const bundled = path.join(launcherRoot, 'resources', 'client', 'enw_t4.dll')
  const h0 = consider(bundled, 'bundled with the launcher')
  if (h0) hits.push(h0)

  const repo = repoRoot || path.resolve(launcherRoot, '..')
  for (const name of ['launcher', 'referee', 'dedi', 'foundation']) {
    const h = consider(path.join(repo, 'build', name, 'enw_t4.dll'), `repo build/${name} (development)`)
    if (h) hits.push(h)
  }
  hits.sort((a, b) => b.mtime - a.mtime)
  return { dll: hits[0] || null, tried }
}

// ------------------------------------------------------------------- install --

export function install({ gameDir, dllPath = null, repoRoot = null, force = false, includeSymbols = false, onProgress = () => {} } = {}) {
  const steps = []
  const created = []
  const step = (name, detail, ok = true) => { steps.push({ name, detail, ok }); onProgress({ name, detail, ok }) }

  const src = path.resolve(gameDir)
  const v = validate(src, { hash: false })
  if (!v.ok) throw new Error(`Not a usable World at War install: ${v.reason}`)

  // From this moment the player's install is off limits to every write in the process.
  protectPath(src)
  step('protect', `${src} is now read-only for this launcher (nothing may write there)`)

  const before = fingerprintDir(src)

  ensureDirs()
  const dest = P.game

  if (fs.existsSync(dest)) {
    if (!force) {
      step('exists', `${dest} already exists — re-using it (pass force to rebuild)`)
    } else {
      removeGameFolder()
      step('clean', `removed the previous ENW game folder at ${dest}`)
    }
  }
  fs.mkdirSync(assertWritable(dest), { recursive: true })

  // 1. Real copies of every file in the root of the player's install.
  //    Except CoDWaWmp.exe: ENW never starts the multiplayer executable (dev-box.md
  //    rule 2), so the simplest way to keep that true is not to have a copy of it.
  let copied = 0
  let bytes = 0
  let skipped = []
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!e.isFile()) continue
    if (e.name.toLowerCase() === 'codwawmp.exe') { skipped.push(e.name); continue }
    const from = path.join(src, e.name)
    const to = assertWritable(path.join(dest, e.name))
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) {
      fs.copyFileSync(from, to)
    }
    created.push({ kind: 'file', path: to })
    copied++
    bytes += fs.statSync(to).size
  }
  step('copy_root', `${copied} root files copied (${(bytes / 1e6).toFixed(1)} MB) — the exe and its dlls, so our own files can sit beside them` +
    (skipped.length ? `; skipped ${skipped.join(', ')} (ENW never runs the multiplayer executable)` : ''))

  // 2. Junctions for the big folders. Read-only by convention AND by assertWritable.
  const links = []
  for (const d of LINK_DIRS) {
    const from = path.join(src, d)
    if (!fs.existsSync(from)) continue
    const link = assertWritable(path.join(dest, d))
    if (fs.existsSync(link)) { links.push(d); continue }
    // 'junction' needs no admin rights, unlike a directory symlink.
    fs.symlinkSync(from, link, 'junction')
    created.push({ kind: 'junction', path: link, target: from })
    links.push(d)
  }
  step('junctions', `${links.length} folders linked, not copied (${links.join(', ')}) — they point at your install and are only ever read`)

  // 3. Any other directory in the source that we did not link gets a real copy, so a
  //    future patch folder is not silently dropped (same rule as new-copy.ps1).
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!e.isDirectory() || LINK_DIRS.includes(e.name)) continue
    const to = assertWritable(path.join(dest, e.name))
    if (!fs.existsSync(to)) {
      fs.cpSync(path.join(src, e.name), to, { recursive: true })
      created.push({ kind: 'dir', path: to })
      step('copy_extra', `copied ${e.name}/ for real (not a folder we recognise, so it is not linked)`)
    }
  }

  // 4. steam_appid.txt — stops SteamStub relaunching out of the Steam folder.
  const appidFile = assertWritable(path.join(dest, 'steam_appid.txt'))
  fs.writeFileSync(appidFile, '10090')
  created.push({ kind: 'file', path: appidFile })
  step('steam_appid', 'wrote steam_appid.txt so Windows runs our copy instead of bouncing to Steam')

  // 5. The proxy DLL. Stock binkw32.dll -> binkw32_org.dll, ours in its place.
  const found = dllPath ? { dll: { path: path.resolve(dllPath), via: 'given explicitly' }, tried: [] } : findClientDll({ repoRoot })
  if (!found.dll) {
    step('client_dll', `no enw_t4.dll found (looked in: ${found.tried.map((t) => t.path).join(', ')})`, false)
  } else {
    const proxy = assertWritable(path.join(dest, 'binkw32.dll'))
    const original = assertWritable(path.join(dest, 'binkw32_org.dll'))
    const pristine = path.join(src, 'binkw32.dll')
    if (!fs.existsSync(pristine)) throw new Error(`No binkw32.dll in ${src} — that install looks incomplete.`)
    const pristineHash = sha256File(pristine)

    if (!fs.existsSync(original)) {
      // Always take the stock DLL from the player's install, never from our copy: that
      // way we can never "back up" our own proxy over the real one.
      fs.copyFileSync(pristine, original)
      created.push({ kind: 'file', path: original })
    } else if (sha256File(original) !== pristineHash) {
      throw new Error(`${original} is not the stock Bink library. Refusing to continue; delete the ENW game folder and run setup again.`)
    }
    fs.copyFileSync(found.dll.path, proxy)
    created.push({ kind: 'file', path: proxy })
    // Symbols are 18 MB and only useful to us; off unless someone asks.
    const pdb = found.dll.path.replace(/\.dll$/i, '.pdb')
    if (includeSymbols && fs.existsSync(pdb)) {
      const to = assertWritable(path.join(dest, 'enw_t4.pdb'))
      fs.copyFileSync(pdb, to)
      created.push({ kind: 'file', path: to })
    }
    step('client_dll', `installed the ENW client (${(fs.statSync(proxy).size / 1e6).toFixed(2)} MB, from ${found.dll.via}); the stock binkw32.dll is kept as binkw32_org.dll and every call is forwarded to it`)
  }

  // 6. mods/enw — the fs_game we launch with. Empty for now; the DLL and the map
  //    installer fill it.
  const mod = assertWritable(path.join(dest, ...MOD_NAME.split('/')))
  fs.mkdirSync(mod, { recursive: true })
  created.push({ kind: 'dir', path: mod })
  step('mod_folder', `created ${MOD_NAME}/ — ENW's own game folder, so nothing we add mixes with your game files`)

  // 7. Our own home path: profiles, config and console.log land here, never in the
  //    player's %LOCALAPPDATA% profile (foundation.md §7: fs_homepath moves main/).
  fs.mkdirSync(assertWritable(path.join(P.home, 'main')), { recursive: true })
  step('home', `${P.home} will hold ENW's game settings, so your own World at War config is never modified`)

  // 8. Prove it.
  const after = fingerprintDir(src)
  const changes = diffFingerprints(before, after)
  if (changes.length) {
    step('untouched', `YOUR INSTALL CHANGED: ${changes.join('; ')}`, false)
  } else {
    step('untouched', `verified: nothing in ${src} changed (${Object.keys(before).length} entries compared before and after)`)
  }

  const manifest = {
    version: 1,
    at: new Date().toISOString(),
    source: { dir: src, grade: v.grade, version: v.version },
    enwRoot: P.root,
    gameDir: dest,
    homeDir: P.home,
    mapsDir: P.maps,
    fsGame: MOD_NAME,
    clientDll: found.dll ? { from: found.dll.path, via: found.dll.via, sha256: sha256File(path.join(dest, 'binkw32.dll')) } : null,
    created,
    links,
    steps,
    sourceUnchanged: changes.length === 0,
  }
  fs.writeFileSync(assertWritable(P.setupManifest), JSON.stringify(manifest, null, 2))
  return manifest
}

// --------------------------------------------------------------- uninstall ---

// Junctions must be removed with rmdir, which deletes the reparse point and leaves the
// target alone. Deleting recursively THROUGH a junction would delete the player's game,
// so this function does the junctions first, explicitly, and then checks the targets
// are still there before it deletes anything else.
export function removeGameFolder() {
  const dest = P.game
  if (!fs.existsSync(dest)) return { removed: false }
  assertWritable(dest)

  const targets = []
  for (const e of fs.readdirSync(dest, { withFileTypes: true })) {
    const p = path.join(dest, e.name)
    let st
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) {
      let target = null
      try { target = fs.readlinkSync(p) } catch {}
      if (target) targets.push(target)
      fs.rmdirSync(p) // removes the link, never the target
    }
  }
  // Paranoia that has earned its place: if a junction target vanished, stop before the
  // recursive delete.
  for (const t of targets) {
    if (!fs.existsSync(t)) throw new Error(`A linked folder disappeared while unlinking (${t}). Stopping before deleting anything else.`)
  }
  fs.rmSync(dest, { recursive: true, force: true })
  return { removed: true, unlinked: targets }
}

export function uninstall({ keepMaps = true } = {}) {
  const done = []
  if (fs.existsSync(P.game)) { removeGameFolder(); done.push(`removed ${P.game}`) }
  for (const d of [P.home, P.logs, P.updates, P.crashes, P.state]) {
    if (fs.existsSync(d)) { fs.rmSync(assertWritable(d), { recursive: true, force: true }); done.push(`removed ${d}`) }
  }
  if (!keepMaps && fs.existsSync(P.maps)) { fs.rmSync(assertWritable(P.maps), { recursive: true, force: true }); done.push(`removed ${P.maps}`) }
  else if (fs.existsSync(P.maps)) done.push(`kept your downloaded maps in ${P.maps}`)
  // Leave the root only if the maps are still in it.
  try { fs.rmdirSync(P.root); done.push(`removed ${P.root}`) } catch {}
  done.push('your copy of World at War was not touched')
  return done
}

export function status() {
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(P.setupManifest, 'utf8')) } catch {}
  const gameExe = path.join(P.game, 'CoDWaW.exe')
  const proxy = path.join(P.game, 'binkw32.dll')
  const original = path.join(P.game, 'binkw32_org.dll')
  return {
    installed: fs.existsSync(gameExe) && fs.existsSync(proxy) && fs.existsSync(original),
    gameDir: P.game,
    gameExe: fs.existsSync(gameExe) ? gameExe : null,
    clientDll: fs.existsSync(proxy) ? { path: proxy, size: fs.statSync(proxy).size, sha256: sha256File(proxy) } : null,
    manifest,
  }
}

// A safety net used by tests: is `p` inside a folder we are allowed to write to?
export const writable = (p) => { try { assertWritable(p); return true } catch { return false } }
export { isInside }
