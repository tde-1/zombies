// What goes into a launcher-side log bundle (docs/kickstart/telemetry.md §2, §6).
//
//   collectGameBundle(ctx, opts)      one game session: kind `client`
//   collectLauncherBundle(ctx, opts)  the launcher itself: kind `launcher`
//
// Both call writeBundle from ./bundle.cjs (the byte-identical copy of
// shared/telemetry/bundle.cjs), which scrubs every text file and the manifest. On top of
// that, JSON state files are parsed and run through scrubJson first, because a key name
// (`sitePassword`) is unambiguous where free text is not. enw_auth.cfg is never listed at
// all; the bundler's forbidden list would refuse it anyway.
//
// opts: { outPath, dirs, appVersion, secrets[], probes, noBinary, bundleId, now }
//   probes: { machine(), events({ fromMs }), wer(), dllSha(path) }  (each resolves, never throws)
import fs from 'node:fs'
import path from 'node:path'
import { writeBundle } from './bundle.cjs'
import { scrubJson } from './scrub.cjs'
import { expandEnv } from './wer.js'

export const MB = 1024 * 1024
export const LAUNCHER_LOG_TAIL = 4 * MB
// A game log is whole unless it is enormous: the DLL's console tap rotates at 16 MB.
export const GAME_LOG_TAIL = 32 * MB
const DAY = 24 * 3600_000

const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const statOf = (p) => { try { return fs.statSync(p) } catch { return null } }
const ls = (dir) => { try { return fs.readdirSync(dir) } catch { return [] } }

// A JSON state file, parsed and scrubbed by key; unparseable ones go as text (the bundler
// still scrubs them).
function jsonFile(name, p) {
  if (!exists(p)) return null
  try { return { name, text: JSON.stringify(scrubJson(JSON.parse(fs.readFileSync(p, 'utf8'))), null, 2) } } catch { return { name, path: p } }
}

// Every dump folder we know of: Windows' default, ours, and whatever WER says.
function dumpDirs(dirs, wer) {
  const out = [dirs.crashDumps, dirs.ourDumps]
  if (wer?.dump_folder) out.push(expandEnv(wer.dump_folder))
  const seen = new Set()
  return out.filter((d) => d && !seen.has(path.resolve(d).toLowerCase()) && seen.add(path.resolve(d).toLowerCase()))
}

// WER's name for a crash of this pid, in any dump folder; only a dump made during (or
// after) this session counts, because pids are reused.
export function crashDumpsFor(pid, dirs, wer, sinceMs = 0) {
  const out = []
  for (const d of dumpDirs(dirs, wer)) {
    const p = path.join(d, `CoDWaW.exe.${pid}.dmp`)
    const st = statOf(p)
    if (st && st.isFile() && st.mtimeMs >= sinceMs - 60_000) out.push(p)
  }
  return out
}

export function hangDumpsFor(pid, dirs, sinceMs = 0) {
  return ls(dirs.logs)
    .filter((f) => f.toLowerCase().startsWith(`hang-${pid}-`) && f.toLowerCase().endsWith('.dmp'))
    .map((f) => path.join(dirs.logs, f))
    .filter((p) => (statOf(p)?.mtimeMs || 0) >= sinceMs - 60_000)
}

// The client DLL's files for one game process.
function sessionFiles(pid, dirs) {
  const files = []
  for (const n of [`enw-${pid}.log`, `console-${pid}.old.log`, `console-${pid}.log`]) {
    const p = path.join(dirs.logs, n)
    if (exists(p)) files.push({ name: n, path: p, tailBytes: GAME_LOG_TAIL })
  }
  const sp = path.join(dirs.logs, `session-${pid}.json`)
  if (exists(sp)) files.push({ name: `session-${pid}.json`, path: sp })
  return files
}

function readSession(pid, dirs) {
  try { return JSON.parse(fs.readFileSync(path.join(dirs.logs, `session-${pid}.json`), 'utf8')) } catch { return null }
}

const nonEmpty = (p) => (statOf(p)?.size || 0) > 0

// The pids of the most recent game sessions, by their enw-<pid>.log.
export function recentPids(dirs, n) {
  return ls(dirs.logs)
    .map((f) => /^enw-(\d+)\.log$/i.exec(f))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), at: statOf(path.join(dirs.logs, m[0]))?.mtimeMs || 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, n)
    .map((x) => x.pid)
}

async function common(opts) {
  const p = opts.probes || {}
  const safe = async (fn, fb) => { try { return fn ? await fn() : fb } catch { return fb } }
  const [machine, wer, dllSha] = await Promise.all([
    safe(p.machine, null),
    safe(p.wer, null),
    safe(() => p.dllSha?.(path.join(opts.dirs.game, 'binkw32.dll')), null),
  ])
  return { machine, wer, dllSha }
}

const werManifest = (w) => (w ? { local_dumps: w.local_dumps, dump_folder: w.dump_folder, ...(w.created ? { created: true } : {}) } : { local_dumps: 'unknown' })

// ------------------------------------------------------------------ the game --

// Exit classification (esc-menu.md §5: the launcher cannot tell a quit from a crash by
// itself; the absence of the quit call is the site's signal). Here: a dump made by
// Windows (WER) or by us for this pid is a crash; our hang watchdog's dump is a hang; an
// exit code other than 0 that we did not cause is a crash; anything else is an exit.
export function classifyGame({ crashDumps = [], hangDumps = [], exitCode = null, stoppedByUs = false, phase = null, session = null }) {
  const sr = String(session?.exit_reason || session?.exitReason || '')
  if (crashDumps.length) return 'game_crash'
  if (hangDumps.length || /hang/i.test(sr)) return 'game_hang'
  if (/crash|exception|fatal|error/i.test(sr)) return 'game_crash'
  if (phase === 'failed') return 'game_crash'
  if (!stoppedByUs && typeof exitCode === 'number' && exitCode !== 0) return 'game_crash'
  return 'game_exit'
}

// ctx: { pid, pids[], exitCode, signal, startedAt, endedAt, map, matchId, mode, launchLine,
//        stdout, stderr, phase, detail, stoppedByUs, steamId }
export async function collectGameBundle(ctx = {}, opts = {}) {
  const { dirs } = opts
  const pids = [...new Set([...(ctx.pids || []), ctx.pid].filter((x) => Number(x) > 0).map(Number))]
  const since = Number(ctx.startedAt) || 0
  const { machine, wer, dllSha } = await common(opts)
  const files = []
  files.push({ name: 'launcher.log', path: path.join(dirs.logs, 'launcher.log'), tailBytes: LAUNCHER_LOG_TAIL })
  for (const [n, p] of [['game-stdout.log', ctx.stdout], ['game-stderr.log', ctx.stderr]]) if (p && nonEmpty(p)) files.push({ name: n, path: p })

  let session = null
  const crash = []
  const hang = []
  for (const pid of pids) {
    files.push(...sessionFiles(pid, dirs))
    session = session || readSession(pid, dirs)
    hang.push(...hangDumpsFor(pid, dirs, since))
    crash.push(...crashDumpsFor(pid, dirs, wer, since))
  }
  if (!opts.noBinary) {
    for (const p of hang) files.push({ name: path.basename(p), path: p, binary: true })
    for (const p of crash) files.push({ name: `wer-${path.basename(p)}`, path: p, binary: true })
  }
  const s = jsonFile('settings.json', dirs.settings); if (s) files.push(s)
  if (ctx.map && /^[\w.-]+$/.test(ctx.map)) {
    const rec = jsonFile(`map-${ctx.map}.enw-installed.json`, path.join(dirs.maps, ctx.map, '.enw-installed.json'))
    if (rec) files.push(rec)
  }

  const fromMs = (Number(ctx.endedAt) || (opts.now || Date.now)()) - 3600_000
  const ev = await (opts.probes?.events ? opts.probes.events({ fromMs }).catch(() => ({ events: [] })) : { events: [] })
  const reason = classifyGame({ crashDumps: crash, hangDumps: hang, exitCode: ctx.exitCode, stoppedByUs: ctx.stoppedByUs, phase: ctx.phase, session })
  const duration = ctx.startedAt && ctx.endedAt ? Math.max(0, ctx.endedAt - ctx.startedAt) : undefined

  const manifest = {
    kind: 'client',
    reason,
    bundle_id: opts.bundleId,
    launcher_version: opts.appVersion,
    dll_sha: dllSha || undefined,
    dll_version: session?.build || session?.build_sha || session?.dll_sha || undefined,
    map: ctx.map || undefined,
    match_id: ctx.matchId || undefined,
    mode: ctx.mode || undefined,
    pid: pids[pids.length - 1] || undefined,
    exit_code: ctx.exitCode ?? undefined,
    exit_reason: session?.exit_reason || session?.exitReason || (ctx.signal ? `signal ${ctx.signal}` : ctx.detail) || undefined,
    duration_ms: duration,
    steam_id: ctx.steamId || undefined,
    machine: machine || undefined,
    launch_line: ctx.launchLine || undefined,
    session: session || undefined,
    wer: werManifest(wer),
    events: ev.events || [],
    notes: [
      pids.length > 1 ? `processes ${pids.join(', ')} (Steam restarted the game)` : null,
      ctx.stoppedByUs ? 'the launcher (or the player through it) stopped the game' : null,
      opts.noBinary ? 'rebuilt without dumps: the site refused the first build as too large' : null,
      ev.error ? `event log: ${ev.error}` : null,
    ].filter(Boolean).join('; ') || undefined,
  }
  return writeBundle(opts.outPath, { manifest, files, secrets: opts.secrets || [] })
}

// -------------------------------------------------------------- the launcher --

// ctx: { reason: 'launcher_error'|'uncaught'|'manual'|'backlog', error: { message, stack }, where, crashFiles[] }
export async function collectLauncherBundle(ctx = {}, opts = {}) {
  const { dirs } = opts
  const now = (opts.now || Date.now)()
  const manual = ctx.reason === 'manual'
  const { machine, wer, dllSha } = await common(opts)
  const files = [{ name: 'launcher.log', path: path.join(dirs.logs, 'launcher.log'), tailBytes: LAUNCHER_LOG_TAIL }]
  if (ctx.error) {
    files.push({ name: 'error.txt', text: `${ctx.where ? `where: ${ctx.where}\n` : ''}${ctx.error.message || ''}\n\n${ctx.error.stack || ''}\n` })
  }
  for (const [n, p] of [['settings.json', dirs.settings], ['config.json', dirs.config], ['detection.json', dirs.detection]]) {
    const f = jsonFile(n, p); if (f) files.push(f)
  }
  // The game sessions around it: the last 3 for a manual send, the last one otherwise.
  for (const pid of recentPids(dirs, manual ? 3 : 1)) files.push(...sessionFiles(pid, dirs))
  // The game's stdout/stderr files of the last launches, when they hold anything.
  const std = ls(dirs.logs).filter((f) => /-(stdout|stderr)\.log$/i.test(f)).sort().reverse()
    .map((f) => path.join(dirs.logs, f)).filter(nonEmpty).slice(0, manual ? 6 : 2)
  for (const p of std) files.push({ name: `game-${path.basename(p)}`, path: p })
  // The crash reports crash.js kept on disk.
  for (const p of ctx.crashFiles || []) if (exists(p)) files.push({ name: `crash-${path.basename(p)}`, path: p })
  // Dumps from the last 24 h, newest first, at most two (a WER dump is ~75 MB and the
  // site's cap is 200 MB a bundle).
  if (manual && !opts.noBinary) {
    const dumps = []
    for (const d of [...dumpDirs(dirs, wer), dirs.logs]) {
      for (const f of ls(d)) {
        if (!/\.dmp$/i.test(f)) continue
        if (d !== dirs.logs && !/^CoDWaW\.exe\./i.test(f)) continue
        if (d === dirs.logs && !/^hang-/i.test(f)) continue
        const p = path.join(d, f)
        const st = statOf(p)
        if (st && now - st.mtimeMs < DAY) dumps.push({ p, at: st.mtimeMs })
      }
    }
    for (const x of dumps.sort((a, b) => b.at - a.at).slice(0, 2)) files.push({ name: path.basename(x.p), path: x.p, binary: true })
  }
  const ev = manual && opts.probes?.events ? await opts.probes.events({ fromMs: now - 3600_000 }).catch(() => ({ events: [] })) : { events: [] }
  const manifest = {
    kind: 'launcher',
    reason: ctx.reason || 'launcher_error',
    bundle_id: opts.bundleId,
    launcher_version: opts.appVersion,
    dll_sha: dllSha || undefined,
    steam_id: ctx.steamId || undefined,
    machine: machine || undefined,
    wer: werManifest(wer),
    events: ev.events || [],
    notes: [
      ctx.error?.message ? `error: ${String(ctx.error.message).slice(0, 500)}` : null,
      ctx.crashFiles?.length ? `${ctx.crashFiles.length} crash report(s) from crashes\\` : null,
      opts.noBinary ? 'rebuilt without dumps: the site refused the first build as too large' : null,
    ].filter(Boolean).join('; ') || undefined,
  }
  return writeBundle(opts.outPath, { manifest, files, secrets: opts.secrets || [] })
}
