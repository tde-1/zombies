// Which monitors exist, and how big they are IN THE PIXELS THE GAME WANTS.
//
// Spec 99 §4.3 "Display defaults": the game launches borderless windowed at the
// native resolution of the main display. That needs three numbers the launcher did
// not have before — the display's native width/height and its origin — and getting
// them wrong is how you end up with a 1280x720 window on a 3840x2160 screen.
//
// TWO TRAPS:
//
//  1. **Electron's `bounds` are DIP, not pixels.** On a 150% display a 2560x1440
//     monitor reports 1707x960. `r_mode 1707x960` is not a mode the game has. Native
//     pixels are `bounds * scaleFactor`, and `nativeOrigin` (Electron 12+) is the
//     origin already in pixels, so prefer it when it is there.
//  2. **There is no Electron here half the time.** `play-cli.js`, `test/run-all.js`
//     and the launch harness are plain `node`, where `require('electron')` returns a
//     path string, not the API. Every function below works without it: the list is
//     cached to `state/displays.json` by the app and read back by the CLI, and if
//     there is no cache either the caller falls back to the saved resolution.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { P, ensureDirs, assertWritable, unpacked, dirOfModule } from './paths.js'

export const DISPLAY_CACHE = path.join(P.state, 'displays.json')

function normalise(d, index) {
  const sf = d.scaleFactor || 1
  const b = d.bounds || { x: 0, y: 0, width: 0, height: 0 }
  const origin = d.nativeOrigin || { x: Math.round(b.x * sf), y: Math.round(b.y * sf) }
  const width = Math.round((d.size?.width ?? b.width) * sf)
  const height = Math.round((d.size?.height ?? b.height) * sf)
  return {
    id: String(d.id ?? index),
    index,
    label: d.label || `Display ${index + 1}`,
    x: origin.x,
    y: origin.y,
    width,
    height,
    scaleFactor: sf,
    refresh: d.displayFrequency || null,
    primary: !!d.primary,
  }
}

// Electron's `screen`, handed in by main.js after `app.whenReady()`. It is injected
// rather than imported because `import 'electron'` under plain node resolves to a
// path string, and because `screen` throws if touched before the app is ready — so
// this module has no static dependency on Electron at all.
let SCREEN = null
export function useScreen(screen) {
  SCREEN = screen && typeof screen.getAllDisplays === 'function' ? screen : null
  return SCREEN
}

// Electron only. Returns null under plain node rather than throwing.
export function electronDisplays() {
  try {
    const screen = SCREEN
    if (!screen) return null
    const primary = screen.getPrimaryDisplay()
    const all = screen.getAllDisplays()
    return all.map((d, i) => normalise({ ...d, primary: d.id === primary.id }, i))
  } catch {
    return null
  }
}

// The app calls this once `app.whenReady()` has resolved, so the CLIs and the
// settings page have real geometry to work from.
export function cacheDisplays(list) {
  if (!list || !list.length) return null
  try {
    ensureDirs()
    fs.writeFileSync(assertWritable(DISPLAY_CACHE), JSON.stringify({ at: new Date().toISOString(), displays: list }, null, 2))
  } catch {}
  return list
}

export function cachedDisplays() {
  try {
    const j = JSON.parse(fs.readFileSync(DISPLAY_CACHE, 'utf8'))
    return Array.isArray(j.displays) && j.displays.length ? j.displays : null
  } catch {
    return null
  }
}

// Windows itself, for the CLIs. `play-cli.js --dry-run` is plain node with no
// Electron and, on a fresh machine, no cache either — and a dry run that cannot say
// what resolution the game will get is not worth much. System.Windows.Forms gives
// bounds and the primary flag; `SetProcessDPIAware()` FIRST is what makes them
// physical pixels rather than scaled ones (without it a 4K display at 150% reports
// 2560x1440 and `r_mode` would be a mode the game does not have).
// The script is a real file under `tools/`, not an inline `-Command`: `tools/**` is
// already `asarUnpack`ed (paths.js trap 2), and powershell.exe cannot read inside the
// asar. `unpacked()` addresses the copy beside the archive.
const DISPLAYS_PS1 = unpacked(path.resolve(dirOfModule(import.meta.url), '..', '..', 'tools', 'displays.ps1'))
// path.join, not a template literal: `SystemRoot` is a Windows path and every
// backslash in an inlined one is an escape waiting to eat the next letter.
const PWSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// One pipe-separated line per display, e.g. DISPLAY1 at 0,0 sized 3840x2160, primary.
export function parseDisplayLines(out = '') {
  const list = []
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split('|')
    if (f.length !== 6) continue
    const [name, x, y, w, h, primary] = f
    const width = Number(w)
    const height = Number(h)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) continue
    list.push({
      id: name.replace(/^[\.]+/, '') || `display${list.length}`,
      index: list.length,
      label: `Display ${list.length + 1}`,
      x: Number(x) || 0,
      y: Number(y) || 0,
      width,
      height,
      scaleFactor: 1,
      refresh: null,
      primary: String(primary).toLowerCase() === 'true',
    })
  }
  return list
}

export function windowsDisplays() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DISPLAYS_PS1], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    const list = parseDisplayLines(out)
    return list.length ? list : null
  } catch {
    return null
  }
}

// The one entry point. Electron first (always current), then the cache the app left
// behind, then Windows itself, then nothing — and "nothing" is a legitimate answer
// that callers handle by falling back to the saved resolution rather than inventing
// one.
export function listDisplays({ inject = null, probe = true } = {}) {
  if (inject) return inject.map((d, i) => (d.bounds || d.size ? normalise(d, i) : { index: i, ...d }))
  const live = electronDisplays()
  if (live && live.length) { cacheDisplays(live); return live }
  const cached = cachedDisplays()
  if (cached) return cached
  // The unit tests, and anything else that must be deterministic, set
  // ENW_NO_DISPLAY_PROBE=1: shelling out to PowerShell from a test is both slow and
  // a different answer on every machine.
  if (!probe || process.env.ENW_NO_DISPLAY_PROBE === '1') return []
  const win = windowsDisplays()
  if (win) { cacheDisplays(win); return win }
  return []
}

// `want` is what the account saved: 'primary', a display id, or an index. An unknown
// value falls back to the primary rather than failing a launch — a monitor that has
// been unplugged since the setting was saved must not stop the game starting.
export function pickDisplay(list, want = 'primary') {
  if (!list || !list.length) return null
  const primary = list.find((d) => d.primary) || list[0]
  if (want === undefined || want === null || want === 'primary' || want === '') return primary
  const byId = list.find((d) => String(d.id) === String(want))
  if (byId) return byId
  const n = Number(want)
  if (Number.isInteger(n) && list[n]) return list[n]
  return primary
}

export function resolutionOf(display) {
  if (!display || !display.width || !display.height) return null
  return `${display.width}x${display.height}`
}

// "1920x1080" and nothing else. r_mode is a STRING in T4 (client.md §2b: the image
// carries the literal `set r_mode 800x600`), so an integer here is the wrong type and
// a "1920 x 1080" with spaces would be two arguments on a command line the engine
// parses itself.
export function validResolution(v) {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d{3,5})\s*[xX]\s*(\d{3,5})$/)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < 640 || h < 480 || w > 16384 || h > 16384) return null
  return `${w}x${h}`
}
