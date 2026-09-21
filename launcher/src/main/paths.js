// Every path the launcher knows about, in one place, so that the "never write into the
// player's game" rule can be enforced by one function instead of by remembering.
//
// dev-box.md rule 1 is absolute: we NEVER write into the Steam install. Everything we
// create lives under ENW_ROOT, which is ours alone.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

// ------------------------------------------------------- where our own files are --
//
// THREE PACKAGED-ONLY TRAPS, all of which look fine in `npm start` and break for a
// friend who runs the installer. Every one of them cost us a real failure:
//
//  1. `new URL(import.meta.url).pathname` DOES NOT DECODE. A player called
//     "John Smith" installs to `C:\Users\John Smith\AppData\...`, the pathname comes
//     back with `%20` in it, and every path derived from it points at a folder that
//     does not exist. Use `fileURLToPath`, always. (`dirOfModule` below.)
//  2. INSIDE app.asar IS NOT A REAL FILE. Electron patches `fs` so *our* reads work,
//     but `powershell.exe -File <inside the asar>` does not, and neither does
//     anything else outside this process. Anything another program must open has to
//     be `asarUnpack`ed and addressed through `unpacked()`.
//  3. `extraResources` lands beside the asar, not inside it, so it is reached through
//     `process.resourcesPath` — which only exists under Electron.
export function dirOfModule(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl))
}

// The launcher's own root: `<repo>/launcher` in development, `…/resources/app.asar`
// when packaged. Both are real paths to *this* app's files.
export const APP_ROOT = path.resolve(dirOfModule(import.meta.url), '..', '..')

// True when we are running out of an asar archive.
export const PACKAGED = /[\\/]app\.asar([\\/]|$)/i.test(APP_ROOT)

// `process.resourcesPath` is Electron-only (it is undefined under plain `node`), and
// it is where `extraResources` lands: `…/resources/client`, `…/resources/host-agent`.
export const RESOURCES = process.resourcesPath || null

// Rewrite a path that lives inside the asar to its `asarUnpack`ed twin. Needed for
// every file handed to a program that is not us: powershell scripts, and the host
// agent, which runs in its own process.
export function unpacked(p) {
  if (!p) return p
  return String(p).replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2')
}

// "ENWZombies", not "ENW Zombies", and that is deliberate. The engine parses its own
// GetCommandLine() rather than taking an argv, and `+set fs_homepath <path with a
// space>` is exactly the kind of thing that works in a test and fails on someone
// else's machine. No space in any path we hand to the game.
//
// Overridable so tests (and B, on a small C: drive) can point it somewhere else.
export const ENW_ROOT = process.env.ENW_ROOT
  ? path.resolve(process.env.ENW_ROOT)
  : path.join(LOCAL, 'ENWZombies')

export const P = {
  root: ENW_ROOT,
  // A junction-copy of the player's WaW install. Theirs is never touched.
  game: path.join(ENW_ROOT, 'game'),
  // fs_homepath for our instance: profile/config/console.log land here, not in theirs.
  home: path.join(ENW_ROOT, 'home'),
  // Downloaded maps. This is the ONE path we write that is not ours, and it is not a
  // choice — it is the only place World at War loads a custom map from.
  //
  // dedi measured all three candidates:
  //     <fs_homepath>\mods\<bsp>                      fails silently
  //     <game copy>\mods\<bsp>                        fails silently
  //     %LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>   works
  //
  // and "fails silently" is the dangerous part: the `.iwd`s mount, the printed search
  // path looks right, and the install looks complete — but `mod.ff` is a ZONE, not a
  // filesystem asset, so putting its directory on the search path never loads it.
  // `Loading fastfile 'mod'` simply never happens and `+map` never runs.
  //
  // Because this folder is the PLAYER'S (B's own `nazi_zombie_ali` lives in it), the
  // rules in library.js are stricter than anywhere else we write: never overwrite a
  // map we did not install, record every file we add, and remove exactly those on
  // uninstall — never the directory wholesale.
  maps: path.join(LOCAL, 'Activision', 'CoDWaW', 'mods'),
  logs: path.join(ENW_ROOT, 'logs'),
  state: path.join(ENW_ROOT, 'state'),
  crashes: path.join(ENW_ROOT, 'crashes'),
  updates: path.join(ENW_ROOT, 'updates'),
  config: path.join(ENW_ROOT, 'state', 'config.json'),
  settings: path.join(ENW_ROOT, 'state', 'settings.json'),
  session: path.join(ENW_ROOT, 'state', 'session.json'),
  detection: path.join(ENW_ROOT, 'state', 'detection.json'),
  setupManifest: path.join(ENW_ROOT, 'state', 'setup-manifest.json'),
}

export function ensureDirs() {
  for (const d of [P.root, P.home, path.join(P.home, 'main'), P.maps, P.logs, P.state, P.crashes, P.updates]) {
    fs.mkdirSync(d, { recursive: true })
  }
}

// ---------------------------------------------------------------- write guard --

// Folders nothing in this app may ever write to. Steam's own root is discovered at
// runtime and added by the detector, so this is the static floor.
const FOREVER_READONLY = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
]
const extraReadonly = new Set()

export function protectPath(p) {
  if (p) extraReadonly.add(path.resolve(p).toLowerCase())
}

export function protectedRoots() {
  return [...FOREVER_READONLY.map((x) => x.toLowerCase()), ...extraReadonly]
}

export function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase()
  const p = path.resolve(parent).toLowerCase()
  if (c === p) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

// Throw rather than write. Called by every function in this app that creates, moves or
// deletes a file. It is deliberately paranoid: a bug here means damaging someone's game.
export function assertWritable(target) {
  const abs = path.resolve(target)
  for (const root of protectedRoots()) {
    if (isInside(abs, root)) {
      throw new Error(
        `Refusing to write to ${abs}: it is inside a protected game install (${root}). ` +
          'The launcher never modifies the player\'s copy of World at War.'
      )
    }
  }
  // Second belt: everything we create must be under ENW_ROOT — with one deliberate
  // exception, the map library. World at War only loads custom maps from the player's
  // own `%LOCALAPPDATA%\Activision\CoDWaW\mods` (see P.maps), so installing a map
  // means writing there. It is allowed by name, one level deep, and library.js adds
  // the rules that make it safe: never overwrite a map we did not install, and remove
  // only the files we recorded.
  if (!isInside(abs, ENW_ROOT) && !isInside(abs, P.maps)) {
    throw new Error(`Refusing to write outside the ENW folder: ${abs} (ENW root is ${ENW_ROOT}, map library is ${P.maps})`)
  }
  return abs
}
