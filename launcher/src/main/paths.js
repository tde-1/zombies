// Every path the launcher knows about, in one place, so that the "never write into the
// player's game" rule can be enforced by one function instead of by remembering.
//
// dev-box.md rule 1 is absolute: we NEVER write into the Steam install. Everything we
// create lives under ENW_ROOT, which is ours alone.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

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
  // Downloaded maps (spec 13 §2: "a separate ENW library folder, never inside the WaW
  // install"). On World at War the map library IS the mods folder, so this is
  // `<home>\mods` — the exact path the engine reads with our `fs_homepath`.
  //
  // It was `<ENW_ROOT>\maps` with a junction per map into `<home>\mods\<bsp>`, which is
  // tidier on paper and does not survive contact: a junction whose link AND target are
  // both inside our folder resolved to nothing here, while the same junction with
  // either end outside worked. Structurally identical reparse data (checked with
  // `fsutil reparsepoint query`), so it is a filesystem-layer quirk rather than
  // anything we did wrong — and depending on a behaviour I cannot explain is worse than
  // not needing it. One folder, no reparse points, works everywhere.
  maps: path.join(ENW_ROOT, 'home', 'mods'),
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
  // Second belt: everything we create must be under ENW_ROOT.
  if (!isInside(abs, ENW_ROOT)) {
    throw new Error(`Refusing to write outside the ENW folder: ${abs} (ENW root is ${ENW_ROOT})`)
  }
  return abs
}
