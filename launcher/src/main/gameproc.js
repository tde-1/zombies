// A CoDWaW.exe already running when the player presses Play: a live game, or a stuck one?
// (2026-09-23)
//
// The stuck one is real and it is ours: a launch with Steam closed leaves a CoDWaW.exe
// that SteamStub never decrypted — alive, no window, never connected, and the DLL's log
// says `steamstub: STILL ENCRYPTED after 60000 ms` (steam.js). Before this, every later
// Play said "World at War is already running" and only Task Manager got the player out.
//
// THE RULES, in the order classify() applies them:
//   * a dedicated server (`+set dedicated` on its command line)  -> never touched
//   * a visible top-level window                                  -> live, never touched
//   * started by this launcher and it connected (engine log, map up, token pipe read)
//                                                                 -> live
//   * started by us, and its DLL log says STILL ENCRYPTED         -> stuck
//   * the dev box's game.lock names it and it is not ours         -> never touched
//   * younger than the grace period                               -> starting (refuse, do not kill)
//   * otherwise (no window, past the grace period)                -> stuck
// Only `stuck` is ended, by pid, and only after the list is read again right before.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { GAME_IMAGES } from './gameexe.js'

export const GRACE_MS = 60_000

const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

// One PowerShell call: pid, creation time (ms), command line, main window handle.
// MainWindowHandle is non-zero only for a process with a visible top-level window, which
// a game off-screen at -4000,-4000 still has. Resolves null when it cannot tell (so the
// caller refuses rather than guesses).
// `image` is one name or a list: our launches run as ENWZombies.exe (gameexe.js), the player's
// own World at War and older launchers as CoDWaW.exe, and either one blocks a Play.
export const imageFilter = (image) => [].concat(image).map((n) => `Name='${String(n).replace(/[^\w.-]/g, '')}'`).join(' OR ')
const script = (image) => [
  "$ErrorActionPreference='SilentlyContinue'",
  "$o=@(Get-CimInstance Win32_Process -Filter \"" + imageFilter(image) + "\" | ForEach-Object {",
  ' $p=Get-Process -Id $_.ProcessId;',
  ' [pscustomobject]@{pid=[int]$_.ProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();cmd=[string]$_.CommandLine;win=[int64]$p.MainWindowHandle}',
  '})',
  "if($o.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $o -Compress}",
].join('\n')

export function listGameProcesses({ run = execFile, image = GAME_IMAGES } = {}) {
  return new Promise((resolve) => {
    run(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script(image)], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(parseList(stdout))
    })
  })
}

export function parseList(stdout) {
  try {
    const j = JSON.parse(String(stdout).trim() || '[]')
    const arr = Array.isArray(j) ? j : [j]
    return arr.filter((p) => p && Number(p.pid) > 0).map((p) => ({
      pid: Number(p.pid),
      createdAt: Number(p.created) || 0,
      commandLine: String(p.cmd || ''),
      hasWindow: Number(p.win) !== 0,
    }))
  } catch { return null }
}

// The DLL writes `<ENW logs>\enw-<pid>.log` for every game this launcher starts.
export function dllLogSaysEncrypted(logsDir, pid) {
  try {
    const t = fs.readFileSync(path.join(logsDir, `enw-${pid}.log`), 'latin1')
    return /steamstub: STILL ENCRYPTED/.test(t)
  } catch { return false }
}

// proc: { pid, createdAt, commandLine, hasWindow }
// ctx:  { now, graceMs, ours: { connected, encrypted } | null, lockPid }
// -> { kind: 'live' | 'starting' | 'stuck' | 'other', ours, why }
export function classify(proc, ctx = {}) {
  const now = ctx.now ?? Date.now()
  const grace = ctx.graceMs ?? GRACE_MS
  const ours = ctx.ours || null
  const out = (kind, why) => ({ kind, ours: !!ours, why })
  if (/\+set\s+dedicated\b/i.test(proc.commandLine || '')) return out('other', 'a dedicated server')
  if (proc.hasWindow) return out('live', 'it has a window')
  if (ours?.connected) return out('live', 'it connected')
  if (ours?.encrypted) return out('stuck', 'SteamStub never decrypted it (Steam was not ready)')
  if (!ours && ctx.lockPid && ctx.lockPid === proc.pid) return out('other', 'another tool holds the game lock for it')
  const age = proc.createdAt ? now - proc.createdAt : Infinity
  if (age < grace) return out('starting', `started ${Math.round(age / 1000)} s ago`)
  return out('stuck', `no window after ${Math.round(age / 1000)} s${ours ? '' : ', never connected'}`)
}

export function endProcess(pid, { run = execFile } = {}) {
  return new Promise((resolve) => {
    const exe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`
    run(exe, ['/PID', String(pid), '/F'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err))
  })
}

// The whole decision for one Play. Returns { ok, killed, blocking, decisions }:
//   ok        nothing is left in the way (stuck ones were ended)
//   blocking  the first live/starting/other process, with `ours`, when not ok
// deps: list, classifyCtx(proc) -> ctx, end(pid), log(line)
export async function clearForPlay({ list = listGameProcesses, ctxFor = () => ({}), end = endProcess, log = () => {} } = {}) {
  const procs = await list()
  if (procs === null) return { ok: false, unknown: true, killed: [], blocking: null, decisions: [] }
  const decisions = procs.map((p) => ({ proc: p, ...classify(p, ctxFor(p)) }))
  for (const d of decisions) log(`CoDWaW.exe ${d.proc.pid}: ${d.kind} (${d.why}${d.ours ? ', started by this launcher' : ''})`)
  const blocking = decisions.find((d) => d.kind !== 'stuck') || null
  if (blocking) return { ok: false, killed: [], blocking, decisions }
  const killed = []
  if (decisions.length) {
    // Read again: a window can have appeared since. Only a pid that is STILL stuck goes.
    const again = await list()
    if (again === null) return { ok: false, unknown: true, killed, blocking: null, decisions }
    for (const d of decisions) {
      const now = again.find((p) => p.pid === d.proc.pid)
      if (!now) continue
      const re = classify(now, ctxFor(now))
      if (re.kind !== 'stuck') { log(`CoDWaW.exe ${now.pid}: not ended, it is ${re.kind} now (${re.why})`); return { ok: false, killed, blocking: { proc: now, ...re }, decisions } }
      const ok = await end(now.pid)
      log(`CoDWaW.exe ${now.pid}: ${ok ? 'ended' : 'could NOT end'} (stuck: ${re.why})`)
      if (!ok) return { ok: false, killed, blocking: { proc: now, ...re, endFailed: true }, decisions }
      killed.push(now.pid)
    }
  }
  return { ok: true, killed, blocking: null, decisions }
}
