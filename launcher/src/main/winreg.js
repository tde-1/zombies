// Registry reads via reg.exe. Read-only, always: the launcher never writes to the
// registry (dev-box.md rule: don't touch the Steam client or its settings), and
// reg.exe is on every Windows box so this needs no native module.
import { execFile } from 'node:child_process'

const REG = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\reg.exe`

function run(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(REG, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err })
    })
  })
}

// Returns { ok, values: {NAME: {type, value}}, error }.
export async function queryKey(key, { wow64 = null } = {}) {
  const args = ['query', key]
  if (wow64 === 32) args.push('/reg:32')
  if (wow64 === 64) args.push('/reg:64')
  const r = await run(args)
  if (!r.ok) return { ok: false, values: {}, error: (r.stderr || r.stdout).trim() || 'not found' }
  const values = {}
  for (const line of r.stdout.split(/\r?\n/)) {
    // "    SteamPath    REG_SZ    c:/program files (x86)/steam"
    const m = line.match(/^\s{4,}(\S(?:.*?\S)?)\s{2,}(REG_\w+)\s{2,}(.*)$/)
    if (m) values[m[1]] = { type: m[2], value: m[3] }
  }
  return { ok: true, values }
}

export async function getValue(key, name, opts) {
  const r = await queryKey(key, opts)
  if (!r.ok) return null
  for (const k of Object.keys(r.values)) {
    if (k.toLowerCase() === String(name).toLowerCase()) return r.values[k].value
  }
  return null
}
