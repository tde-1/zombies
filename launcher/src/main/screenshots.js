// ENW's screenshots, the launcher half (lane SS, 2026-09-24; client.md §15, launcher.md).
//
// B: "Take over the screenshots ... And have Open image / Open screenshots folder."
//
// The game half is the client DLL (screenshot.cpp): F12 is bound to its own `enw_screenshot`
// (wawcfg.js rewrites WaW's `screenshotJPEG` binds), it grabs the finished frame, encodes JPEG q95
// 4:4:4 (or PNG) on a worker thread and writes "ENW Zombies <map> <date> <time>.jpg" into
// %USERPROFILE%\Pictures\ENW Zombies, then says "Screenshot saved" in game. The DLL tells the
// launcher nothing: the launcher WATCHES THAT FOLDER, because a file that exists is the only
// report that cannot be lost, and the folder is the same one the player opens.
//
// WHERE: <Pictures>\ENW Zombies (Electron's app.getPath('pictures') is FOLDERID_Pictures, the same
// known folder the DLL asks for), or ENW_SCREENSHOT_DIR when set (tests). The launcher passes the
// folder it chose to the game as ENW_SCREENSHOT_DIR, so the two can never disagree.
//
// WHAT THE PLAYER GETS (feedbackFor, the SOC attention rules applied to screenshots):
//   a game is running          nothing from the launcher: the in-game line said it, and nothing
//                              may disturb a game (focusguard.js). The shot is counted.
//   the game has just ended    one Windows toast if any were taken: "2 screenshots saved" with
//                              Open image (the newest) and Open folder
//   no game, launcher in front the Settings screen's Screenshots list updates; no toast
//   no game, not in front      a Windows toast with Open image / Open folder
// Settings -> Screenshots always lists the newest ones with Open image / Show in folder, and has
// Open screenshots folder.
import fs from 'node:fs'
import path from 'node:path'

// The DLL's names (screenshot_name.hpp): "ENW Zombies <map> yyyy-mm-dd hh-mm-ss[ (n)].jpg|png".
export const SHOT_RE = /^ENW Zombies .+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}(?: \(\d{1,2}\))?\.(?:jpg|png)$/i
export const isShot = (name) => typeof name === 'string' && SHOT_RE.test(name)

export function screenshotsDir({ env = process.env, pictures = '' } = {}) {
  const o = env && env.ENW_SCREENSHOT_DIR
  if (o && String(o).trim()) return path.resolve(String(o).trim())
  return path.join(pictures || '.', 'ENW Zombies')
}

// The newest `limit` shots, newest first: { name, path, size, at }.
export function listShots(dir, limit = 12) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!isShot(n)) continue
    try {
      const st = fs.statSync(path.join(dir, n))
      if (st.isFile()) out.push({ name: n, path: path.join(dir, n), size: st.size, at: st.mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1)).slice(0, limit)
}

// A name the page sends back becomes a path only if it is a shot's bare file name in the folder:
// nothing the renderer says can open anything else.
export function resolveShot(dir, name) {
  if (!isShot(name) || name !== path.basename(name) || /[\\/]/.test(name)) return null
  const p = path.join(dir, name)
  if (path.dirname(p) !== path.resolve(dir)) return null
  return fs.existsSync(p) ? p : null
}

export function feedbackFor({ gameRunning = false, inFront = false } = {}) {
  if (gameRunning) return 'count'
  return inFront ? 'panel' : 'toast'
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// Open image / Open folder are protocol activations of our own scheme (deeplink.js
// `enw-zombies://screenshot/open|folder`), which reach the running launcher through its
// single-instance hand-off; neither carries a path -- the launcher opens the newest shot it knows.
export function shotToastXml({ count = 1, name = '' } = {}) {
  const title = count > 1 ? `${count} screenshots saved` : 'Screenshot saved'
  return '<toast launch="enw-zombies://screenshot/folder" activationType="protocol">'
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(name)}</text></binding></visual>`
    + '<actions><action content="Open image" activationType="protocol" arguments="enw-zombies://screenshot/open"/>'
    + '<action content="Open folder" activationType="protocol" arguments="enw-zombies://screenshot/folder"/></actions>'
    + '<audio silent="true"/></toast>'
}

// Watch the folder. `onShot(shot)` once per new shot (the DLL writes "<name>.part" and renames it,
// so a shot appears whole). Returns { close, scan, recent }.
export function watchShots(dir, onShot, { log = () => {}, debounceMs = 150 } = {}) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { log(`screenshots: cannot create ${dir}: ${e.message}`) }
  const seen = new Set(listShots(dir, 10000).map((s) => s.name))
  let timer = null
  const scan = () => {
    for (const s of listShots(dir, 50).reverse()) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      try { onShot(s) } catch (e) { log(`screenshots: handler failed: ${e.message}`) }
    }
  }
  let w = null
  try {
    w = fs.watch(dir, { persistent: false }, (_ev, name) => {
      if (name && !isShot(String(name))) return
      clearTimeout(timer)
      timer = setTimeout(scan, debounceMs)
    })
    w.on('error', (e) => log(`screenshots: watch error: ${e.message}`))
  } catch (e) { log(`screenshots: cannot watch ${dir}: ${e.message}`) }
  return {
    close: () => { clearTimeout(timer); try { w?.close() } catch {} },
    scan,
    recent: (n = 12) => listShots(dir, n),
  }
}
