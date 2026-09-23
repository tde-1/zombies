// Steam has to be running and signed in before World at War starts. (2026-09-23)
//
// CoDWaW.exe is wrapped in SteamStub (docs/re/steam-drm.md): the stub decrypts the game's
// code only once the Steam client has validated app 10090. With Steam closed, what the
// launcher used to do was start the exe anyway. MEASURED on this PC (board.md 19:12,
// 2026-09-21): the process stays alive, the code stays encrypted, and the DLL gives up
// after 60 s ("steamstub: STILL ENCRYPTED after 60000 ms ... Is the Steam client
// running"). No window ever appears. The boot screen said "World at War is running",
// then sat on "waiting for the game to connect", and every later Play was refused with
// "World at War is still running" because the stuck process was.
//
// So before a launch: read Steam's own registry state, start Steam if it is not up,
// wait for a signed-in user, give the client a moment to settle, and only then spawn
// the game. Every way this can fail ends in one short line and a Retry.
//
// The tells (HKCU\Software\Valve\Steam\ActiveProcess, written by the client itself):
//   pid         the running steam.exe; 0 (or a dead pid) when Steam is closed
//   ActiveUser  the signed-in account id; 0 while the login window is up
// Read-only: the launcher never writes Steam's registry (winreg.js).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { getValue, queryKey } from './winreg.js'
import { GAME_IMAGES } from './gameexe.js'

const KEY = 'HKCU\\Software\\Valve\\Steam'
const ACTIVE = `${KEY}\\ActiveProcess`

// The wording, in one place. Terse on purpose.
export const MSG = {
  starting: 'Starting Steam...',
  signin: 'Waiting for Steam sign-in',
  settling: 'Steam is ready',
  notInstalled: 'Steam isn\'t installed.',
  noStart: 'Steam didn\'t start.',
  notSignedIn: 'Not signed in to Steam.',
  notRunning: 'Steam isn\'t running.',
  gameRunning: 'World at War is already running.',
  gameStarting: 'World at War is still starting.',
}

// Timeouts. Starting: steam.exe up and writing its pid (a cold start with an update
// check is 10-30 s on B's PC). Sign-in: long enough to type a password and a Steam
// Guard code. Settle: vps.md §host — a game started the moment the client appears
// exits in silence, so give it a few seconds after sign-in when we had to wait.
export const TIMEOUTS = { startMs: 60_000, signInMs: 150_000, settleMs: 6_000, pollMs: 1_000 }

const num = (v) => {
  if (v === null || v === undefined) return 0
  const s = String(v).trim()
  const n = /^0x/i.test(s) ? parseInt(s, 16) : Number(s)
  return Number.isFinite(n) ? n : 0
}

// Image names of running processes, lower-case, via tasklist (on every Windows box).
export function listProcesses(image) {
  return new Promise((resolve) => {
    const exe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`
    execFile(exe, ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([])
      const out = []
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/)
        if (m && m[1].toLowerCase() === image.toLowerCase()) out.push(Number(m[2]))
      }
      resolve(out)
    })
  })
}

// Where steam.exe is. `SteamExe` is the client's own record of itself; SteamPath is the
// folder. Forward slashes and lower case are how Steam writes them; both are fine.
export async function steamExe({ get = getValue, exists = fs.existsSync } = {}) {
  const cands = []
  const exe = await get(KEY, 'SteamExe')
  if (exe) cands.push(exe)
  const root = await get(KEY, 'SteamPath')
  if (root) cands.push(path.join(root, 'steam.exe'))
  cands.push('C:\\Program Files (x86)\\Steam\\steam.exe', 'C:\\Program Files\\Steam\\steam.exe')
  for (const c of cands) {
    const p = path.normalize(String(c).replace(/\//g, '\\'))
    if (exists(p)) return p
  }
  return null
}

// One reading of Steam's state.
//   { running, signedIn, pid, user }
// `running`: a steam.exe exists. `signedIn` also needs the registry's pid to BE that
// steam.exe: after a crash the key keeps the last session's pid and ActiveUser, and a
// fresh start would otherwise read as signed in before its login window has even opened.
export async function readState({ query = queryKey, processes = listProcesses } = {}) {
  const r = await query(ACTIVE)
  const v = r?.ok ? r.values : {}
  const pick = (name) => { for (const k of Object.keys(v || {})) if (k.toLowerCase() === name.toLowerCase()) return v[k].value; return null }
  const pid = num(pick('pid'))
  const user = num(pick('ActiveUser'))
  const steamPids = await processes('steam.exe')
  const running = steamPids.length > 0
  const current = running && pid > 0 && steamPids.includes(pid)
  return { running, signedIn: current && user > 0, pid: running ? (current ? pid : steamPids[0]) : 0, user: current ? user : 0 }
}

// Start the client in the tray. If it has no saved login, Steam shows its own sign-in
// window regardless of -silent, which is what the player needs to see.
export function startSteam(exe, { spawnFn = spawn } = {}) {
  const c = spawnFn(exe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: false })
  c.on?.('error', () => {})
  c.unref?.()
  return c
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Make sure Steam is up and signed in. Never throws.
//
//   onState({ state, message })   'starting' | 'signin' | 'settling'  (not called when
//                                 Steam was already fine: nothing to show)
//   cancelled()                   true to stop waiting
//
// Resolves { ok: true, waited, started } or { ok: false, reason, message }, reason one of
// 'not_installed' | 'no_start' | 'not_signed_in' | 'cancelled'.
export async function ensureSteam({
  onState = () => {},
  cancelled = () => false,
  read = readState,
  findExe = steamExe,
  start = startSteam,
  openUrl = null,
  timeouts = {},
  wait = sleep,
  now = () => Date.now(),
  allowStart = true,
} = {}) {
  const t = { ...TIMEOUTS, ...timeouts }
  const safeRead = async () => { try { return await read() } catch { return { running: false, signedIn: false } } }
  let s = await safeRead()
  if (s.signedIn) return { ok: true, waited: false, started: false }

  // A dev tool (play-cli) never starts or waits on B's Steam client: it says so and stops.
  if (!allowStart) return { ok: false, reason: s.running ? 'not_signed_in' : 'not_running', message: s.running ? MSG.notSignedIn : MSG.notRunning }

  let started = false
  if (!s.running) {
    const exe = await findExe()
    if (!exe) return { ok: false, reason: 'not_installed', message: MSG.notInstalled }
    onState({ state: 'starting', message: MSG.starting })
    try {
      start(exe)
      started = true
    } catch {
      // The protocol handler is the fallback: it reaches whatever Steam registered.
      try { if (openUrl) { openUrl('steam://open/main'); started = true } } catch {}
      if (!started) return { ok: false, reason: 'no_start', message: MSG.noStart }
    }
    const until = now() + t.startMs
    while (!s.running) {
      if (cancelled()) return { ok: false, reason: 'cancelled', message: 'cancelled' }
      if (now() >= until) return { ok: false, reason: 'no_start', message: MSG.noStart }
      await wait(t.pollMs)
      s = await safeRead()
    }
  }

  if (!s.signedIn) {
    onState({ state: 'signin', message: MSG.signin })
    const until = now() + t.signInMs
    while (!s.signedIn) {
      if (cancelled()) return { ok: false, reason: 'cancelled', message: 'cancelled' }
      if (now() >= until) return { ok: false, reason: s.running ? 'not_signed_in' : 'no_start', message: s.running ? MSG.notSignedIn : MSG.noStart }
      await wait(t.pollMs)
      s = await safeRead()
    }
  }

  // Signed in, but the client came up just now: let it finish before SteamStub asks it.
  onState({ state: 'settling', message: MSG.settling })
  await wait(t.settleMs)
  return { ok: true, waited: true, started }
}

// Any World at War process on this PC, ours or not. A second copy beside a running one is
// never what the player meant, and a copy stuck in SteamStub is invisible.
// Both names: ours run as ENWZombies.exe (gameexe.js), the player's own as CoDWaW.exe.
export async function gameProcesses({ processes = listProcesses } = {}) {
  const lists = await Promise.all(GAME_IMAGES.map((n) => processes(n)))
  return [].concat(...lists)
}
