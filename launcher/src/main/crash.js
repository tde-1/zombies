// Crash reports.
//
// Spec 13 §2: "Errors (WaW crash, map fails to load, server unreachable): auto-reported
// silently (crash logs go to the existing bug-report pipeline). The player sees a short
// plain message."
//
// Silently means the player is not asked and not interrupted — it does NOT mean we send
// whatever we like. What goes in a report is listed in `redact()` below and nothing
// else, and the endpoint is local in this build (no cloud, per the overnight rules). If
// the endpoint is unreachable the report is kept on disk and sent next time.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { P, ensureDirs, assertWritable } from './paths.js'

const MAX_LOG_CHARS = 64 * 1024

// Anything that looks like a token, a key or a pipe name never leaves this machine.
export function redact(text) {
  return String(text)
    .replace(/\\\\\.\\pipe\\enw-launch-[0-9a-f]+/gi, '\\\\.\\pipe\\enw-launch-<redacted>')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{40,}\b/g, '<token redacted>')
    .replace(/("?(token|auth|secret|password|key)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1<redacted>')
}

export function build({ kind, error, context = {}, logs = [] } = {}) {
  const id = crypto.randomUUID()
  const tails = []
  for (const f of logs) {
    try {
      const st = fs.statSync(f)
      const start = Math.max(0, st.size - MAX_LOG_CHARS)
      const fd = fs.openSync(f, 'r')
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      tails.push({ file: path.basename(f), tail: redact(buf.toString('latin1')) })
    } catch {}
  }
  return {
    v: 0,
    id,
    at: new Date().toISOString(),
    kind,
    app: { name: 'enw-launcher', version: context.appVersion || '0.0.0' },
    machine: {
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
      memGB: Math.round(os.totalmem() / 1e9),
    },
    error: error ? { message: redact(error.message || String(error)), stack: redact(error.stack || '') } : null,
    context: JSON.parse(redact(JSON.stringify(context))),
    logs: tails,
  }
}

// Fire and forget. Never throws, never blocks the UI, never tells the player about the
// report itself — only about the thing that broke.
export async function report(endpoint, payload) {
  ensureDirs()
  const file = assertWritable(path.join(P.crashes, `${payload.at.replace(/[:.]/g, '-')}-${payload.kind}.json`))
  try { fs.writeFileSync(file, JSON.stringify(payload, null, 2)) } catch {}
  if (!endpoint) return { sent: false, saved: file, reason: 'no crash endpoint configured' }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) { try { fs.unlinkSync(file) } catch {}; return { sent: true } }
    return { sent: false, saved: file, reason: `the report endpoint answered ${res.status}` }
  } catch (e) {
    return { sent: false, saved: file, reason: e.message }
  }
}

// Anything that failed to send last time.
export async function flush(endpoint) {
  if (!endpoint) return { sent: 0, kept: 0 }
  let sent = 0
  let kept = 0
  let files = []
  try { files = fs.readdirSync(P.crashes).filter((f) => f.endsWith('.json')) } catch {}
  for (const f of files) {
    const full = path.join(P.crashes, f)
    try {
      const payload = JSON.parse(fs.readFileSync(full, 'utf8'))
      const r = await report(endpoint, payload)
      if (r.sent) { sent++; try { fs.unlinkSync(full) } catch {} } else kept++
    } catch { kept++ }
  }
  return { sent, kept }
}

// Windows closes a "not responding" game with this exit code (0xCFFFFFFF). B's zombie_town
// hang (2026-09-23) ended with it, after the player closed the frozen window.
export const HUNG_EXIT_CODE = 3489660927

// The one line the player sees when a game ends badly (lane CL, 2026-09-23: B's game froze
// loading Town of the Dead and the launcher said nothing at all). `session` is the DLL's
// session-<pid>.json; its `exit` is the verdict ('crash' | 'hang' | 'error' | 'quit').
// Null when there is nothing to say: a normal quit, the launcher's own stop, or an engine
// error the game already showed ('error': the lockdown screen told the player why).
export function gameEndNotice({ session = null, exitCode = null, stoppedByUs = false, map = null } = {}) {
  if (stoppedByUs) return null
  const verdict = String(session?.exit || '')
  const on = map ? ` on ${map}` : ''
  const hung = verdict === 'hang' || exitCode === HUNG_EXIT_CODE || exitCode === -805306369
  if (verdict === 'crash') return `World at War crashed${on}. We have the logs.`
  if (hung) return `World at War froze${on}. We have the logs.`
  if (verdict === 'quit' || verdict === 'error') return null
  if (typeof exitCode === 'number' && exitCode !== 0) return `World at War closed unexpectedly${on}. We have the logs.`
  return null
}

// The short plain message the player actually sees. No IDs, no stack, no apology loop.
export function playerMessage(kind) {
  switch (kind) {
    case 'game_crash': return 'World at War closed unexpectedly. We have the details; you can start another game whenever you like.'
    case 'map_failed': return 'That map would not load. We have the details — try another one, or try again in a minute.'
    case 'server_unreachable': return "We could not reach the game server. We have the details; it is worth trying again shortly."
    case 'setup_failed': return 'Setting up the ENW client did not finish. Your copy of World at War was not changed.'
    default: return 'Something went wrong and we have the details. Nothing on your PC was changed.'
  }
}
