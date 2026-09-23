// Windows Error Reporting "LocalDumps": does Windows keep a dump when CoDWaW.exe crashes,
// and where? (docs/kickstart/telemetry.md §2 `wer`, launcher.md 2026-09-23 telemetry.)
//
// WER writes a dump on a crash only when a LocalDumps key covers the exe:
//   HKLM|HKCU\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps            every exe
//   HKLM|HKCU\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\CoDWaW.exe  that exe
// with DumpFolder (default %LOCALAPPDATA%\CrashDumps), DumpCount (default 10) and DumpType
// (default 1). B's PC has the global HKLM key (made by some other app; EA and Medal have
// sub-keys there) and so already writes `%LOCALAPPDATA%\CrashDumps\CoDWaW.exe.<pid>.dmp`.
//
// When NOTHING covers CoDWaW.exe we create ONE key, in HKCU (never HKLM, which needs admin
// and is the whole machine's):
//   HKCU\...\LocalDumps\CoDWaW.exe   DumpFolder = <ENW_ROOT>\crashes\dumps
//                                    DumpCount  = 10
//                                    DumpType   = 1
// DumpType 1 is a MINIDUMP, not a full dump (2): a full dump of a 2 GB-address-space game is
// up to 2 GB per crash, over the site's 200 MB bundle cap and a real cost to a friend's disk;
// a minidump (stacks, modules, exception record; ~75 MB on B's PC) is what every crash we have
// diagnosed so far was diagnosed from (chat-overlay.md §12.4, the DiscordHook dump).
//
// THE KEY IS PER EXE NAME, NOT PER FOLDER. It therefore also covers CoDWaW.exe started from
// Steam (vanilla World at War) for this Windows user: a crash there also leaves a dump in OUR
// folder. We never write into the player's install and never read those dumps unless the
// player sends logs; launcher.md says so. The only write is those three registry values, and
// only when nothing else already covers the exe.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { queryKey } from '../winreg.js'
import { assertWritable } from '../paths.js'

export const BASE = 'Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps'
export const EXE = 'CoDWaW.exe'
const REG = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\reg.exe`
const DEFAULT_FOLDER = '%LOCALAPPDATA%\\CrashDumps'

export const expandEnv = (s) => String(s || '').replace(/%([^%]+)%/g, (m, v) => {
  const k = Object.keys(process.env).find((x) => x.toLowerCase() === v.toLowerCase())
  return k ? process.env[k] : m
})

const val = (r, name) => {
  if (!r?.ok) return null
  const k = Object.keys(r.values || {}).find((x) => x.toLowerCase() === name.toLowerCase())
  return k ? r.values[k].value : null
}

// -> { local_dumps: 'hklm' | 'hkcu-ours' | 'hkcu' | 'off', dump_folder, dump_type, keys: [...] }
export async function detectWer({ query = queryKey, ourFolder } = {}) {
  const read = async (hive, sub) => {
    try { const r = await query(`${hive}\\${BASE}${sub ? `\\${sub}` : ''}`); return r?.ok ? r : null } catch { return null }
  }
  const [lmGlobal, lmExe, cuGlobal, cuExe] = await Promise.all([read('HKLM'), read('HKLM', EXE), read('HKCU'), read('HKCU', EXE)])
  const keys = []
  if (lmGlobal) keys.push('HKLM global')
  if (lmExe) keys.push(`HKLM ${EXE}`)
  if (cuGlobal) keys.push('HKCU global')
  if (cuExe) keys.push(`HKCU ${EXE}`)
  // The per-exe key beats the global one, HKLM beats HKCU.
  const pick = (exe, glob) => val(exe, 'DumpFolder') || val(glob, 'DumpFolder') || DEFAULT_FOLDER
  const type = (exe, glob) => { const v = val(exe, 'DumpType') ?? val(glob, 'DumpType'); return v == null ? 1 : parseInt(v, 16) || Number(v) || 1 }
  if (lmGlobal || lmExe) return { local_dumps: 'hklm', dump_folder: pick(lmExe, lmGlobal), dump_type: type(lmExe, lmGlobal), keys }
  if (cuGlobal || cuExe) {
    const folder = pick(cuExe, cuGlobal)
    const ours = cuExe && ourFolder && path.resolve(expandEnv(folder)).toLowerCase() === path.resolve(ourFolder).toLowerCase()
    return { local_dumps: ours ? 'hkcu-ours' : 'hkcu', dump_folder: folder, dump_type: type(cuExe, cuGlobal), keys }
  }
  return { local_dumps: 'off', dump_folder: null, dump_type: null, keys }
}

export function regAdd(key, name, type, data, { run = execFile } = {}) {
  // HKCU only, ever. A bug that reached HKLM would be the whole machine's.
  if (!/^HKCU\\/i.test(key)) return Promise.resolve({ ok: false, error: `refusing to write ${key}: HKCU only` })
  return new Promise((resolve) => {
    run(REG, ['add', key, '/v', name, '/t', type, '/d', String(data), '/f'], { timeout: 5000, windowsHide: true }, (err, _o, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim().slice(0, 200) } : { ok: true })
    })
  })
}

// Detect; if nothing covers CoDWaW.exe, create our HKCU key. Never throws.
export async function ensureWer({ ourFolder, query = queryKey, add = regAdd, log = () => {} } = {}) {
  try {
    const d = await detectWer({ query, ourFolder })
    if (d.local_dumps !== 'off') {
      log(`WER LocalDumps: covered (${d.local_dumps}: ${d.keys.join(', ')}), dumps go to ${d.dump_folder}, DumpType ${d.dump_type}; nothing written`)
      return { ...d, created: false }
    }
    try { fs.mkdirSync(assertWritable(ourFolder), { recursive: true }) } catch (e) {
      log(`WER LocalDumps: off, and our dump folder could not be made (${e.message}); not creating the key`)
      return { ...d, created: false, error: e.message }
    }
    const key = `HKCU\\${BASE}\\${EXE}`
    const results = [
      await add(key, 'DumpFolder', 'REG_EXPAND_SZ', ourFolder),
      await add(key, 'DumpCount', 'REG_DWORD', 10),
      await add(key, 'DumpType', 'REG_DWORD', 1),
    ]
    const bad = results.find((r) => !r.ok)
    if (bad) { log(`WER LocalDumps: off; creating ${key} FAILED: ${bad.error}`); return { ...d, created: false, error: bad.error } }
    const after = await detectWer({ query, ourFolder })
    log(`WER LocalDumps: was off; created ${key} (DumpFolder ${ourFolder}, DumpCount 10, DumpType 1 minidump); now ${after.local_dumps}`)
    return { ...after, created: true }
  } catch (e) {
    log(`WER LocalDumps: could not check (${e.message})`)
    return { local_dumps: 'unknown', dump_folder: null, error: e.message, created: false }
  }
}
