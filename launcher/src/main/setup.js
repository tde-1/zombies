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
import { P, assertWritable, protectPath, isInside, ensureDirs, dirOfModule, RESOURCES, PACKAGED } from './paths.js'
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
//
// TWO RULES, both learned from a packaged build rather than guessed at:
//
//  * THE SHIPPED COPY WINS OUTRIGHT when there is one. It used to be entered into an
//    mtime race with the development candidates, which is wrong in both directions: a
//    player has no repo so the race is pointless, and on a developer's machine the
//    race silently decided which DLL a *packaged* build installed.
//  * NOTHING INSIDE app.asar IS EVER CHOSEN. `resources/**` used to be packed into the
//    archive as well as shipped beside it, so the winner was
//    `…/app.asar/resources/client/enw_t4.dll` — a path that only exists because
//    Electron patches `fs`, and only for this process. It happens to copy, and it is
//    the kind of thing that works until the day it does not. `package.json` no longer
//    packs it; this refuses it even if something else ever does.
const IN_ASAR = /[\\/]app\.asar[\\/]/i

export function findClientDll({ repoRoot = null, explicit = null } = {}) {
  const tried = []
  const consider = (p, via) => {
    if (!p) return null
    const inAsar = IN_ASAR.test(p)
    const exists = !inAsar && fs.existsSync(p)
    tried.push({ path: p, via, exists, ...(inAsar ? { skipped: 'inside app.asar' } : {}) })
    return exists ? { path: p, via, mtime: fs.statSync(p).mtimeMs } : null
  }
  if (explicit) {
    const h = consider(path.resolve(explicit), 'given explicitly')
    if (h) return { dll: h, tried }
  }

  const launcherRoot = path.resolve(dirOfModule(import.meta.url), '..', '..')

  // PACKAGED: electron-builder puts extraResources next to the app, outside app.asar.
  // This is the one that matters for a player — everything below it is development.
  // `process.resourcesPath` only exists under Electron, hence the guard.
  if (RESOURCES) {
    const h = consider(path.join(RESOURCES, 'client', 'enw_t4.dll'), 'shipped with the launcher')
    if (h) return { dll: h, tried }
  }

  // Development, newest build wins.
  const hits = []
  const h0 = consider(path.join(launcherRoot, 'resources', 'client', 'enw_t4.dll'), 'staged in the launcher folder')
  if (h0) hits.push(h0)

  // Development. PREFERENCE FIRST, THEN FRESHNESS -- the same order tools/stage-client.js
  // uses, and for the same reason: four agents build into build/<name> on this box, so
  // "newest" picks whoever compiled last rather than the build that is the client.
  // It silently installed build/dedi (a dedicated-server experiment) over a client
  // build made ninety seconds earlier.
  const repo = repoRoot || path.resolve(launcherRoot, '..')
  const PREFER = ['launcher', 'referee', 'foundation']
  for (const name of ['launcher', 'referee', 'dedi', 'foundation']) {
    const h = consider(path.join(repo, 'build', name, 'enw_t4.dll'), `repo build/${name} (development)`)
    if (h) hits.push({ ...h, rank: PREFER.indexOf(name) < 0 ? 99 : PREFER.indexOf(name) })
  }
  hits.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.mtime - a.mtime)
  return { dll: hits[0] || null, tried }
}

// The sentence a player sees when there is no client to install, with every path we
// looked at. B's report was "ENW client is not installed" and nothing else, which is
// unactionable by him and undiagnosable by us.
export function explainMissingClient(tried) {
  const lines = [
    'The ENW client (enw_t4.dll) is missing from this copy of the launcher, so there is nothing to install.',
    '',
    'This is a packaging fault, not something you did wrong — please send this message to us.',
    '',
    `Looked in ${tried.length} place${tried.length === 1 ? '' : 's'}:`,
  ]
  for (const t of tried) {
    lines.push(`  ${t.exists ? 'found' : t.skipped ? 'skipped' : 'not there'}  ${t.path}${t.skipped ? `  (${t.skipped})` : ''}`)
  }
  lines.push('', `Launcher: ${PACKAGED ? 'packaged' : 'running from a repo checkout'}; resources at ${RESOURCES || '(none — not running under Electron)'}`)
  return lines.join('\n')
}

// Turn the errno soup Windows produces into a sentence a player can act on. B's report
// was "ENW client is not installed" with no reason, and every one of these failures
// looks identical from the outside.
export function explainSetupFailure(err) {
  const msg = String(err?.message || err)
  const code = err?.code || (msg.match(/\b(EPERM|EACCES|EBUSY|ENOSPC|EXDEV|EEXIST|ENOENT|EINVAL)\b/) || [])[1]
  const plain = {
    EPERM: 'Windows would not let the launcher create the ENW folder.\n\n' +
      'Most often this is your antivirus quarantining enw_t4.dll — it is an unsigned DLL that gets ' +
      'copied next to a game executable, which is exactly the shape antivirus software dislikes. ' +
      'Allow it, or add %LOCALAPPDATA%\\ENWZombies as an exclusion, and press Install again.',
    EACCES: 'Windows refused access to a file the launcher needs.\n\n' +
      'Close World at War and Steam if they are running, then press Install again. If it keeps ' +
      'happening, your antivirus is probably holding enw_t4.dll.',
    EBUSY: 'A file is in use, so the launcher could not replace it.\n\n' +
      'Close World at War (and anything else using it), then press Install again.',
    ENOSPC: 'There is not enough space on the drive for the ENW folder.\n\n' +
      'Setup needs about 15 MB on the drive that holds %LOCALAPPDATA%. Free some space and try again.',
    ENOENT: 'A file the launcher expected was not there.\n\n' +
      'This usually means World at War moved or was uninstalled since we last looked. ' +
      'Use "Find my game" on the setup screen and point the launcher at it again.',
  }[code]
  if (!plain) return msg
  return `${plain}\n\n(Technical detail: ${code} — ${msg})`
}

// Creating an NTFS junction needs no privileges, but a policy or a filter driver can
// still refuse it, and the failure is opaque. Answered once, before we start copying
// eight megabytes we would only have to undo.
export function canMakeJunctions(dir, target) {
  // THE TARGET MUST BE THE REAL ONE, i.e. outside our folder.
  //
  // The first version of this probe linked to a scratch folder inside `dir` and
  // refused every install on B's PC. That is not a bug in the probe — it is the same
  // behaviour launcher.md §3b already recorded: on this machine a junction whose link
  // AND target are both inside the ENW folder resolves to nothing, while the identical
  // junction with either end outside it is fine. `fsutil reparsepoint query` showed
  // data identical to a working junction in both cases.
  //
  // So the probe has to be the thing we are actually about to do: a link from inside
  // our folder to the player's install. A probe that tests something else is worse
  // than no probe, because it fails on exactly the machine it was written for.
  const probe = path.join(dir, '.enw-junction-probe')
  const clear = () => {
    // rmdir, never rm -r: rmdir removes the reparse point and leaves the target alone.
    // A recursive delete THROUGH a junction deletes the player's 12 GB install, looks
    // like it worked, and is the single most dangerous thing this file can do.
    try { if (fs.lstatSync(probe).isSymbolicLink()) fs.rmdirSync(probe) } catch {}
  }
  try {
    clear()
    fs.symlinkSync(target, assertWritable(probe), 'junction')
    const ok = fs.existsSync(probe) && fs.readdirSync(probe).length >= 0
    return { ok, reason: ok ? null : `Windows created the folder link but it does not resolve (${probe} -> ${target}).` }
  } catch (e) {
    return {
      ok: false,
      reason:
        'Windows would not let the launcher create a folder link (an NTFS junction) inside ' +
        `${dir}.\n\nENW links to your World at War instead of copying 12 GB of it, so this has to ` +
        'work. It normally does without any special permissions — if it is failing, the drive is ' +
        `probably not NTFS, or a security policy is blocking it.\n\n(Technical detail: ${e.code || ''} ${e.message})`,
    }
  } finally {
    clear()
  }
}

// ------------------------------------------------------------------- install --

export function install({ gameDir, dllPath = null, repoRoot = null, force = false, includeSymbols = false, onProgress = () => {} } = {}) {
  const steps = []
  const created = []
  const step = (name, detail, ok = true) => { steps.push({ name, detail, ok }); onProgress({ name, detail, ok }) }

  const src = path.resolve(gameDir)
  // Hash it here even though the detector may already have: the manifest is the record
  // of what we installed from, and "accepted" vs "verified" decides whether the player
  // is eligible for records.
  const v = validate(src, { hash: true })
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

  // 0. Can we link at all? Asked BEFORE eight megabytes of copying, because the
  //    junctions are what make this an ENW folder rather than a 12 GB duplicate, and
  //    "it failed at step 2" is a much worse experience than "it cannot work here".
  const j = canMakeJunctions(dest, path.join(src, LINK_DIRS[0]))
  if (!j.ok) { step('junctions', j.reason, false); throw new Error(j.reason) }

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
    step('client_dll', 'no enw_t4.dll anywhere', false)
    // Fatal. Previously this was a warning and setup carried on, so the launcher
    // reported success and then said "not installed yet" with no reason given.
    throw new Error(explainMissingClient(found.tried))
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
  // The map library lives INSIDE home (P.maps = <home>\mods), so home cannot be
  // deleted wholesale when the player asked to keep their maps. Remove its children
  // one at a time and step around the library.
  if (fs.existsSync(P.home)) {
    if (keepMaps) {
      for (const e of fs.readdirSync(P.home, { withFileTypes: true })) {
        const full = path.join(P.home, e.name)
        if (path.resolve(full).toLowerCase() === path.resolve(P.maps).toLowerCase()) continue
        fs.rmSync(assertWritable(full), { recursive: true, force: true })
      }
      done.push(`emptied ${P.home} (kept the map library)`)
    } else {
      fs.rmSync(assertWritable(P.home), { recursive: true, force: true })
      done.push(`removed ${P.home}`)
    }
  }
  for (const d of [P.logs, P.updates, P.crashes, P.state]) {
    if (fs.existsSync(d)) { fs.rmSync(assertWritable(d), { recursive: true, force: true }); done.push(`removed ${d}`) }
  }
  if (fs.existsSync(P.maps)) {
    if (keepMaps) done.push(`kept your downloaded maps in ${P.maps}`)
    else { fs.rmSync(assertWritable(P.maps), { recursive: true, force: true }); done.push(`removed ${P.maps}`) }
  }
  // Leave the root only if the maps are still in it.
  try { fs.rmdirSync(P.root); done.push(`removed ${P.root}`) } catch {}
  done.push('your copy of World at War was not touched')
  return done
}

// What is on disk, for the Storage page (spec 13 §2: "a Storage page shows sizes per
// map"). Bounded: it walks our own folders only, and a junction is reported as a link
// rather than followed — the ENW game folder would otherwise "weigh" the player's
// whole 12 GB install.
export function storage() {
  const measure = (dir) => {
    let bytes = 0
    let files = 0
    let links = 0
    const walk = (d, depth) => {
      if (depth > 12) return
      let entries = []
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(d, e.name)
        let st
        try { st = fs.lstatSync(p) } catch { continue }
        if (st.isSymbolicLink()) { links++; continue }
        if (st.isDirectory()) walk(p, depth + 1)
        else { bytes += st.size; files++ }
      }
    }
    if (fs.existsSync(dir)) walk(dir, 0)
    return { path: dir, exists: fs.existsSync(dir), bytes, files, links }
  }

  const maps = []
  if (fs.existsSync(P.maps)) {
    for (const e of fs.readdirSync(P.maps, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const m = measure(path.join(P.maps, e.name))
      let lastPlayed = null
      try { lastPlayed = fs.statSync(path.join(P.maps, e.name)).atime.toISOString() } catch {}
      maps.push({ id: e.name, ...m, lastPlayed })
    }
    maps.sort((a, b) => b.bytes - a.bytes)
  }

  const folders = {
    game: measure(P.game),
    home: measure(P.home),
    maps: measure(P.maps),
    logs: measure(P.logs),
    crashes: measure(P.crashes),
    updates: measure(P.updates),
  }
  return {
    root: P.root,
    folders,
    maps,
    total: Object.values(folders).reduce((n, f) => n + f.bytes, 0),
    note: 'Linked folders point at your own copy of World at War and are not counted here.',
  }
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
