// What a log bundle says about the machine (docs/kickstart/telemetry.md §2, `machine`,
// `events`, `dll_sha`). Every probe here is best effort: it resolves, never rejects, and
// a probe that could not run says so in its answer rather than taking the bundle with it.
//
// Cost: the GPU list is ONE PowerShell call per launcher run (10 s cap, cached); the
// event-log read is one PowerShell call per bundle (15 s cap). Neither runs while a game
// is running, because nothing in telemetry does (index.js).
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

export const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

function ps(script, timeout, run = execFile) {
  return new Promise((resolve) => {
    try {
      run(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 200) })
        resolve({ ok: true, stdout: String(stdout || '') })
      })
    } catch (e) { resolve({ ok: false, error: e.message }) }
  })
}

const asArray = (j) => (Array.isArray(j) ? j : j ? [j] : [])

// ------------------------------------------------------------------- machine --

let gpuCache = null
export function gpus({ run } = {}) {
  if (gpuCache && !run) return gpuCache
  const p = ps(
    "$ErrorActionPreference='SilentlyContinue'; $v=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM); if($v.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $v -Compress}",
    10_000, run,
  ).then((r) => {
    if (!r.ok) return { gpus: [], error: r.error }
    try {
      return { gpus: asArray(JSON.parse(r.stdout.trim() || '[]')).map((g) => `${g.Name || '?'}${g.DriverVersion ? ` (driver ${g.DriverVersion})` : ''}`) }
    } catch (e) { return { gpus: [], error: `could not parse the GPU list: ${e.message}` } }
  })
  if (!run) gpuCache = p
  return p
}

export async function machine(opts = {}) {
  const g = await gpus(opts)
  const cpus = os.cpus() || []
  const gb = (n) => Math.round((n / 1024 ** 3) * 10) / 10
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model?.trim() || null,
    cores: cpus.length || null,
    ram_gb: gb(os.totalmem()),
    ram_free_gb: gb(os.freemem()),
    gpus: g.gpus,
    ...(g.error ? { gpu_error: g.error } : {}),
  }
}

// ------------------------------------------------------ the Windows event log --

// Application-log events 1000 (Application Error), 1001 (Windows Error Reporting) and
// 1002 (Application Hang) whose text names CoDWaW.exe, from `fromMs` on (default: the
// last hour). Resolves [] on any failure, with the reason in the log line the caller
// writes, never an exception.
export async function events({ fromMs = Date.now() - 3600_000, run } = {}) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$since=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(Number(fromMs) || 0)}).LocalDateTime`,
    "$e=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001,1002;StartTime=$since} | Where-Object { $_.Message -match 'CoDWaW\\.exe' } | Select-Object -First 20 | ForEach-Object { [pscustomobject]@{id=$_.Id;time=$_.TimeCreated.ToUniversalTime().ToString('o');provider=$_.ProviderName;message=[string]$_.Message} })",
    "if($e.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $e -Compress}",
  ].join('\n')
  const r = await ps(script, 15_000, run)
  if (!r.ok) return { events: [], error: r.error }
  try {
    return { events: asArray(JSON.parse(r.stdout.trim() || '[]')).map((e) => ({ id: e.id, time: e.time, provider: e.provider, message: String(e.message || '').slice(0, 4000) })) }
  } catch (e) { return { events: [], error: `could not parse the event list: ${e.message}` } }
}

// ------------------------------------------------------------ the client DLL --

// sha256 of the ENW client actually installed in the game copy (`<ENW>\game\binkw32.dll`,
// setup.js). Streamed, and cached by size + mtime so a queue of bundles hashes it once.
const shaCache = new Map()
export function fileSha256(p) {
  return new Promise((resolve) => {
    let st
    try { st = fs.statSync(p) } catch { return resolve(null) }
    const key = `${p}|${st.size}|${st.mtimeMs}`
    if (shaCache.has(key)) return resolve(shaCache.get(key))
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(p)
    s.on('data', (d) => h.update(d))
    s.on('error', () => resolve(null))
    s.on('end', () => { const v = h.digest('hex'); shaCache.set(key, v); resolve(v) })
  })
}
