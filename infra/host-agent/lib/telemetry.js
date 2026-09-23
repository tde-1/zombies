// TELEMETRY on the box: every instance end is a log bundle (docs/kickstart/telemetry.md §7,
// host.md §15).
//
// B, 2026-09-23: "full logging on everything so we can diagnose issues as soon as possible
// ... also whenever the server goes wrong. Store more logs rather than less. Don't sacrifice
// performance."
//
// What makes a bundle (kind `host` unless said otherwise):
//   instance_end    a game over (reused or terminated), a retire (lease gone, superseded,
//                   warm and unleased, needs the slot), a crash / unexpected exit
//   lease_refused   an instance that never started (no game copy, cap, lock)
//   pull_failed     a lease whose map the cache could not prepare (the lease is `failed`)
//   box_warning     disk free < 2 GB or MemAvailable < 300 MB (at most once an hour each)
//   daily_journal   kind `journal`: yesterday's `journalctl -u enw-host-agent` + `-k`
//
// THE PATH OF ONE BUNDLE, and why each step is where it is:
//   1. at the end, on the agent's thread: the ring lines are filtered (an array walk) and
//      the logs' TAILS are copied into staging/<id>/ with async I/O. Copying first matters:
//      the next game in the same slot truncates console.log when it starts.
//   2. when no game is booting or preparing: a child process, niced to 19, scrubs and packs
//      (lib/telemetry-build.js). Scrubbing 16 MB of text is a second of CPU; it must not be
//      a second of the agent's event loop.
//   3. outbox/<id>.tar.gz + <id>.json (the sidecar: attempts, next_at). One upload at a
//      time, streamed and throttled, never while a game boots.
// A pending job is on disk (staging/<id>/job.json, no secrets in it), so an agent restart
// between 1 and 3 builds it on the next start rather than losing it.
//
// NOTHING HERE MAY BREAK THE AGENT. Every entry point catches and logs `telemetry: ...`; an
// unreachable site only means bundles wait in the outbox (7 days / 3 GB, oldest out first).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeLog, mkdirp, ringLines, ringFormat } from './util.js'
import { scrubJson } from './telemetry/scrub.cjs'
import { buildBundle } from './telemetry-build.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUILD_JS = path.join(__dirname, 'telemetry-build.js')
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000]
const MB = 1024 * 1024
const GB = 1024 * MB
const isOff = (v) => /^(off|0|false|no|disabled?)$/i.test(String(v ?? '').trim())

/** Config from the environment (/root/enw-host.env on the box). Every key optional. */
export function configFromEnv(env = process.env, { dataDir, site } = {}) {
  const off = isOff(env.ENW_TELEMETRY)
  return {
    enabled: !off && !!site,
    whyOff: off ? 'ENW_TELEMETRY=off' : !site ? 'no site to upload to' : null,
    dir: env.ENW_TELEMETRY_DIR || path.join(dataDir || '.', 'telemetry'),
    uploadBps: Number(env.ENW_TELEMETRY_UPLOAD_MBPS ?? 8) * MB,
    maxAgeDays: Number(env.ENW_TELEMETRY_MAX_DAYS ?? 7),
    maxBytes: Number(env.ENW_TELEMETRY_MAX_GB ?? 3) * GB,
    tailBytes: Number(env.ENW_TELEMETRY_TAIL_MB ?? 16) * MB,
    diskWarnBytes: Number(env.ENW_TELEMETRY_DISK_WARN_GB ?? 2) * GB,
    memWarnBytes: Number(env.ENW_TELEMETRY_MEM_WARN_MB ?? 300) * MB,
    journal: !isOff(env.ENW_TELEMETRY_JOURNAL),
    journalUnit: env.ENW_TELEMETRY_JOURNAL_UNIT || 'enw-host-agent',
  }
}

const newId = () => crypto.randomBytes(16).toString('hex')
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)

/** Box health for manifest.host: disk, memory, load. Cheap; no child processes. */
export function boxHealth(diskPath = process.platform === 'win32' ? path.parse(process.cwd()).root : '/') {
  const h = { cores: os.cpus().length, load: os.loadavg().map((x) => Number(x.toFixed(2))), uptime_s: Math.round(os.uptime()) }
  try {
    const s = fs.statfsSync(diskPath)
    h.disk_path = diskPath
    h.disk_free_gb = Number(((s.bavail * s.bsize) / GB).toFixed(2))
    h.disk_total_gb = Number(((s.blocks * s.bsize) / GB).toFixed(2))
  } catch { /* statfs unavailable */ }
  h.mem_total_mb = Math.round(os.totalmem() / MB)
  h.mem_free_mb = Math.round(memAvailable() / MB)
  h.agent_rss_mb = Math.round(process.memoryUsage().rss / MB)
  return h
}

/** MemAvailable on Linux (what the kernel can give without swapping); os.freemem() elsewhere. */
export function memAvailable() {
  if (process.platform === 'linux') {
    try {
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))
      if (m) return Number(m[1]) * 1024
    } catch { /* fall through */ }
  }
  return os.freemem()
}

/** Copy the last `tailBytes` of `src` to `dest`, async. -> { size, truncated } or null if src is missing. */
async function copyTail(src, dest, tailBytes) {
  let fh
  try { fh = await fsp.open(src, 'r') } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const n = Math.min(st.size, tailBytes || st.size)
    const buf = Buffer.alloc(n)
    let off = 0
    while (off < n) {
      const { bytesRead } = await fh.read(buf, off, n - off, st.size - n + off)
      if (!bytesRead) break
      off += bytesRead
    }
    await fsp.writeFile(dest, off === n ? buf : buf.subarray(0, off))
    return { size: st.size, truncated: st.size > n, mtime: new Date(st.mtimeMs).toISOString() }
  } finally { await fh.close().catch(() => {}) }
}

async function dirBytes(p) {
  let n = 0
  try {
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) n += await dirBytes(f)
      else { try { n += (await fsp.stat(f)).size } catch { /* gone */ } }
    }
  } catch { /* gone */ }
  return n
}

/**
 * Run a command, its stdout into rotating part files of ~partBytes (split on a newline),
 * keeping only the newest `maxParts`. Niced. -> { parts, bytes, dropped_bytes, stderr, code, error }
 */
export function runToParts(bin, args, dir, prefix, { partBytes = 8 * MB, maxParts = 8, timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let child
    const parts = []
    let cur = null
    let curBytes = 0
    let bytes = 0
    let dropped = 0
    let stderr = ''
    let settled = false
    const open = () => {
      const p = path.join(dir, `${prefix}${parts.length ? `.${String(parts.length).padStart(2, '0')}` : ''}.log`)
      parts.push(p)
      cur = fs.createWriteStream(p)
      curBytes = 0
      while (parts.length > maxParts) {
        const old = parts.shift()
        try { dropped += fs.statSync(old).size; fs.unlinkSync(old) } catch { /* ignore */ }
      }
    }
    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const end = () => resolve({ parts, bytes, dropped_bytes: dropped, stderr: stderr.slice(0, 65536), ...extra })
      if (cur) cur.end(end); else end()
    }
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) { resolve({ parts: [], bytes: 0, dropped_bytes: 0, stderr: '', error: e.code || e.message }); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    timer.unref?.()
    child.on('error', (e) => finish({ error: e.code || e.message, code: null }))
    child.on('spawn', () => { try { os.setPriority(child.pid, 19) } catch { /* best effort */ } })
    child.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += d })
    child.stdout.on('data', (d) => {
      bytes += d.length
      if (!cur) open()
      let chunk = d
      if (curBytes + chunk.length > partBytes) {
        const nl = chunk.indexOf(0x0a, Math.max(0, partBytes - curBytes - 1))
        if (nl >= 0 && nl < chunk.length - 1) {
          const head = chunk.subarray(0, nl + 1)
          cur.write(head)
          cur.end()
          open()
          chunk = chunk.subarray(nl + 1)
        }
      }
      curBytes += chunk.length
      if (!cur.write(chunk)) { child.stdout.pause(); cur.once('drain', () => child.stdout.resume()) }
    })
    child.on('close', (code) => finish({ code }))
  })
}

export class Telemetry {
  constructor(o = {}) {
    this.dir = o.dir
    this.site = o.site || null
    this.boxName = o.boxName || 'box'
    this.secrets = o.secrets || (() => [])
    this.busy = o.busy || (() => false)
    this.forbiddenDirs = (o.forbiddenDirs || []).filter(Boolean).map((d) => path.resolve(d))
    this.uploadBps = o.uploadBps ?? 8 * MB
    this.maxAgeMs = (o.maxAgeDays ?? 7) * 86_400_000
    this.maxBytes = o.maxBytes ?? 3 * GB
    this.tailBytes = o.tailBytes ?? 16 * MB
    this.diskWarnBytes = o.diskWarnBytes ?? 2 * GB
    this.memWarnBytes = o.memWarnBytes ?? 300 * MB
    this.journal = o.journal !== false
    this.journalUnit = o.journalUnit || 'enw-host-agent'
    this.journalctl = o.journalctl || 'journalctl'
    this.platform = o.platform || process.platform
    this.diskPath = o.diskPath || (process.platform === 'win32' ? path.parse(path.resolve(this.dir)).root : '/')
    this.tickMs = o.tickMs ?? 60_000
    this.uploadTickMs = o.uploadTickMs ?? 30_000
    this.inProcessBuild = !!o.inProcessBuild
    this.now = o.now || (() => Date.now())
    this.log = o.log || makeLog('telemetry')
    this.outbox = path.join(this.dir, 'outbox')
    this.rejectedDir = path.join(this.dir, 'rejected')
    this.stagingDir = path.join(this.dir, 'staging')
    this.stateFile = path.join(this.dir, 'state.json')
    this.jobs = []             // built when not busy, one at a time
    this.building = false
    this.uploading = false
    this.pendingStages = new Set()
    this.state = { journal_last: null, warned: {} }
    this.stats = { queued: 0, built: 0, sent: 0, rejected: 0, failed_builds: 0, upload_errors: 0 }
  }

  // ---- lifecycle ------------------------------------------------------------------------
  start() {
    mkdirp(this.outbox); mkdirp(this.rejectedDir); mkdirp(this.stagingDir)
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } } catch { /* first run */ }
    this.recover()
    const held = this.sidecars().length
    this.log.info(`telemetry: ON, ${this.dir}, ${held} bundle(s) in the outbox, ${this.jobs.length} to build; upload ${(this.uploadBps / MB).toFixed(0)} MB/s max, keep ${Math.round(this.maxAgeMs / 86_400_000)} d / ${(this.maxBytes / GB).toFixed(1)} GB`)
    this.tickTimer = setInterval(() => this.tick(), this.tickMs); this.tickTimer.unref?.()
    this.uploadTimer = setInterval(() => this.pump(), this.uploadTickMs); this.uploadTimer.unref?.()
    // The first maintenance tick (journal backlog, box check) a little after start, not in
    // it: the first lease of a restarted agent usually boots in the next few seconds.
    this.firstTick = setTimeout(() => this.tick(), Math.min(this.tickMs, 30_000)); this.firstTick.unref?.()
    return this
  }

  stop() {
    clearInterval(this.tickTimer); clearInterval(this.uploadTimer); clearTimeout(this.firstTick); clearTimeout(this.pumpSoon)
  }

  saveState() {
    try {
      const tmp = `${this.stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.stateFile)
    } catch (e) { this.log.warn(`telemetry: could not save ${this.stateFile}: ${e.message}`) }
  }

  /** Jobs left in staging by a previous run (job.json, no sidecar yet) are built again; the rest goes. */
  recover() {
    try {
      for (const f of fs.readdirSync(this.outbox)) if (f.endsWith('.part')) fs.rmSync(path.join(this.outbox, f), { force: true })
      for (const id of fs.readdirSync(this.stagingDir)) {
        const d = path.join(this.stagingDir, id)
        if (fs.existsSync(path.join(this.outbox, `${id}.json`)) || fs.existsSync(path.join(this.rejectedDir, `${id}.json`))) continue
        let job = null
        try { job = JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8')) } catch { /* half staged */ }
        if (job && job.id === id) { this.jobs.push(job); continue }
        fs.rmSync(d, { recursive: true, force: true })
      }
    } catch (e) { this.log.warn(`telemetry: recover: ${e.message}`) }
  }

  /** The 60 s maintenance tick: box check, the daily journal, retention, and a pump. */
  tick() {
    try { this.checkBox() } catch (e) { this.log.warn(`telemetry: box check: ${e.message}`) }
    this.journalTick().catch((e) => this.log.warn(`telemetry: journal: ${e.message}`))
    this.retention().catch((e) => this.log.warn(`telemetry: retention: ${e.message}`))
    this.pump()
  }

  // ---- the ends ----------------------------------------------------------------------------
  /**
   * An instance ended. `info` is gathered by host.js; this files it. Returns the staging
   * promise (resolves to the bundle id, or null). Never throws.
   *
   *   { reason, exit_reason, why, match_id, instance, pid, linux_pid, map, mode, since,
   *     duration_ms, exit_code, summary, summary_line, lease, replay_path, dll_path, dll_sha,
   *     dll_version, logs: [{ name, path }], ring: { instance, matches: [] }, extraSecrets: [], notes }
   */
  instanceEnd(info = {}) {
    try {
      const id = newId()
      const since = Number(info.since) || this.now() - 3600_000
      const inst = info.ring?.instance || info.instance || null
      const matches = (info.ring?.matches || [info.match_id]).filter(Boolean)
      // `inst-01` must not match `inst-010`: a word boundary on both sides.
      const instRe = inst ? new RegExp(`(^|[^\\w-])${esc(inst)}(?!\\w)`) : null
      const mine = (e) => e.t >= since - 2000 && (
        (inst && (e.tag.split('/').includes(inst) || instRe.test(e.msg))) || matches.some((m) => e.msg.includes(m)))
      const texts = [
        { name: 'host-instance.log', text: ringLines(mine).map(ringFormat).join('\n') + '\n' },
        // The whole box around it, because an instance's trouble is often its neighbour's
        // (a retire two seconds before a boot put up a modal dialog, dedi.md §17).
        { name: 'host-box-context.log', text: ringLines((e) => e.t >= since - 60_000).slice(-5000).map(ringFormat).join('\n') + '\n' },
      ]
      if (info.summary) texts.push({ name: 'summary.json', text: JSON.stringify(scrubJson(info.summary), null, 2) })
      if (info.lease) texts.push({ name: 'lease.json', text: JSON.stringify(scrubJson(info.lease), null, 2) })
      if (info.instance_info) texts.push({ name: 'instance.json', text: JSON.stringify(scrubJson(info.instance_info), null, 2) })
      const manifest = {
        kind: 'host', reason: info.reason || 'instance_end', bundle_id: id,
        box: this.boxName, instance: info.instance || null, match_id: info.match_id || null, map: info.map || null,
        mode: info.mode || null, pid: info.pid ?? null, exit_code: info.exit_code ?? null,
        exit_reason: info.exit_reason || null, duration_ms: info.duration_ms ?? null,
        dll_sha: info.dll_sha || null, dll_version: info.dll_version || null,
        summary_line: info.summary_line || null, host: boxHealth(this.diskPath),
        notes: {
          why: info.why || null, linux_pid: info.linux_pid ?? null, started_at: new Date(since).toISOString(),
          replay: info.replay_path ? { path: info.replay_path, uploaded: false, note: 'the site pulls replays from the box itself (web/server/routes/replay.js); path and sha only' } : null,
          ...(info.notes || {}),
        },
      }
      const hash = []
      if (info.replay_path) hash.push({ key: 'replay', path: info.replay_path })
      if (info.dll_path) hash.push({ key: 'dll_at_end', path: info.dll_path })
      return this.stage({ id, manifest, logs: info.logs || [], texts, hash, extraSecrets: info.extraSecrets || [] })
    } catch (e) { this.log.warn(`telemetry: instance end ${info.instance || ''}: ${e.message}`); return Promise.resolve(null) }
  }

  /** A lease whose map could not be prepared: the lease is `failed` at the site. */
  pullFailed({ asg = {}, error = null, since = null, logs = [], notes = {} } = {}) {
    try {
      const id = newId()
      const t0 = Number(since) || this.now() - 600_000
      const words = [asg.match_id, asg.map, asg.fs_game].filter(Boolean)
      const lines = ringLines((e) => e.t >= t0 - 2000 && (e.tag.includes('/maps') || words.some((w) => e.msg.includes(w))))
      const manifest = {
        kind: 'host', reason: 'pull_failed', bundle_id: id, box: this.boxName, match_id: asg.match_id || null,
        map: asg.map || null, mode: asg.mode || null, exit_reason: 'pull_failed', duration_ms: this.now() - t0,
        host: boxHealth(this.diskPath), notes: { error: String(error || '').slice(0, 2000), ...notes },
      }
      const texts = [
        { name: 'host-lease.log', text: lines.map(ringFormat).join('\n') + '\n' },
        { name: 'host-box-context.log', text: ringLines((e) => e.t >= t0 - 60_000).slice(-5000).map(ringFormat).join('\n') + '\n' },
        { name: 'lease.json', text: JSON.stringify(scrubJson(asg), null, 2) },
      ]
      return this.stage({ id, manifest, logs, texts, extraSecrets: Object.values(asg.tokens || {}) })
    } catch (e) { this.log.warn(`telemetry: pull failed bundle: ${e.message}`); return Promise.resolve(null) }
  }

  /** Disk and memory, at most once a minute (the tick); a bundle at most once an hour per condition. */
  checkBox() {
    const h = boxHealth(this.diskPath)
    const now = this.now()
    const conds = []
    if (h.disk_free_gb != null && h.disk_free_gb * GB < this.diskWarnBytes) conds.push(['disk_low', `disk free ${h.disk_free_gb} GB < ${(this.diskWarnBytes / GB).toFixed(1)} GB on ${h.disk_path}`])
    if (h.mem_free_mb * MB < this.memWarnBytes) conds.push(['mem_low', `MemAvailable ${h.mem_free_mb} MB < ${Math.round(this.memWarnBytes / MB)} MB`])
    for (const [cond, detail] of conds) {
      const last = this.state.warned?.[cond] || 0
      if (now - last < 3600_000) continue
      this.state.warned = { ...(this.state.warned || {}), [cond]: now }
      this.saveState()
      this.log.warn(`telemetry: box warning ${cond}: ${detail} - bundling`)
      this.boxWarning(cond, detail, h)
    }
    return conds.map(([c]) => c)
  }

  boxWarning(cond, detail, health = null) {
    try {
      const id = newId()
      const manifest = {
        kind: 'host', reason: 'box_warning', bundle_id: id, box: this.boxName,
        host: health || boxHealth(this.diskPath), notes: { condition: cond, detail },
      }
      const texts = [{ name: 'host-recent.log', text: ringLines().slice(-5000).map(ringFormat).join('\n') + '\n' }]
      const logs = this.platform === 'linux' ? [{ name: 'meminfo.txt', path: '/proc/meminfo' }] : []
      const cmds = this.platform === 'linux'
        ? [['df.txt', 'df', ['-h']], ['ps.txt', 'ps', ['-eo', 'pid,user,rss,vsz,pcpu,etime,comm', '--sort=-rss']]]
        : []
      return this.stage({ id, manifest, logs, texts, cmds })
    } catch (e) { this.log.warn(`telemetry: box warning bundle: ${e.message}`); return Promise.resolve(null) }
  }

  // ---- the daily journal ---------------------------------------------------------------------
  /**
   * Yesterday's journal, once: the first tick after 00:10 UTC, or the first tick after a
   * start that finds yesterday unsent. Linux only; a box without journalctl skips cleanly.
   * -> { skipped } | { queued: id } | null (nothing due)
   */
  async journalTick() {
    if (!this.journal) return { skipped: 'off' }
    if (this.platform !== 'linux') return { skipped: `not linux (${this.platform})` }
    if (this.journalMissing) return { skipped: 'no journalctl' }
    const now = this.now()
    const today = ymd(now)
    const yesterday = ymd(now - 86_400_000)
    if (now - Date.parse(`${today}T00:00:00Z`) < 10 * 60_000) return null
    if (this.state.journal_last === yesterday || this.journalRunning) return null
    if (this.busy()) return null
    this.journalRunning = true
    try {
      const id = newId()
      const dir = mkdirp(path.join(this.stagingDir, id))
      const since = `${yesterday} 00:00:00`
      const until = `${today} 00:00:00`
      const base = ['--since', since, '--until', until, '-o', 'short-iso', '--utc', '--no-pager']
      const unit = await runToParts(this.journalctl, ['-u', this.journalUnit, ...base], dir, 'journal-unit', { partBytes: 8 * MB, maxParts: 8 })
      if (unit.error === 'ENOENT') {
        fs.rmSync(dir, { recursive: true, force: true })
        this.journalMissing = true
        this.log.info(`telemetry: journal skipped: ${this.journalctl} is not on this box`)
        return { skipped: 'no journalctl' }
      }
      const kern = await runToParts(this.journalctl, ['-k', ...base], dir, 'journal-kernel', { partBytes: Infinity, maxParts: 1 })
      const files = [
        ...unit.parts.map((p) => ({ name: path.basename(p), path: p })),
        ...kern.parts.map((p) => ({ name: path.basename(p), path: p, tailBytes: 4 * MB })),
      ]
      const texts = []
      if (unit.stderr || kern.stderr) texts.push({ name: 'journalctl-stderr.txt', text: `-u ${this.journalUnit}:\n${unit.stderr}\n-k:\n${kern.stderr}\n` })
      const manifest = {
        kind: 'journal', reason: 'daily_journal', bundle_id: id, box: this.boxName, host: boxHealth(this.diskPath),
        notes: {
          day: yesterday, since, until, unit: this.journalUnit,
          unit_bytes: unit.bytes, unit_dropped_bytes: unit.dropped_bytes, unit_exit: unit.code ?? unit.error ?? null,
          kernel_bytes: kern.bytes, kernel_exit: kern.code ?? kern.error ?? null,
        },
      }
      this.state.journal_last = yesterday
      this.saveState()
      const r = await this.stage({ id, manifest, logs: [], texts, preStaged: files, dir })
      this.log.info(`telemetry: journal for ${yesterday} queued (${(unit.bytes / MB).toFixed(1)} MB unit, ${(kern.bytes / 1024).toFixed(0)} KB kernel${unit.stderr ? '; journalctl said: ' + unit.stderr.split('\n')[0].slice(0, 160) : ''})`)
      return { queued: r }
    } finally { this.journalRunning = false }
  }

  // ---- staging -> job -> build ------------------------------------------------------------------
  forbidden(p) {
    const r = path.resolve(p)
    return this.forbiddenDirs.some((d) => r === d || r.startsWith(d + path.sep)) || /(^|[\\/])enw-host\.env$/i.test(r)
  }

  /** Copy tails into staging/<id>/, write job.json, queue the build. -> Promise<id|null> */
  stage({ id, manifest, logs = [], texts = [], hash = [], cmds = [], extraSecrets = [], preStaged = null, dir = null }) {
    const p = (async () => {
      const d = dir || mkdirp(path.join(this.stagingDir, id))
      const files = [...(preStaged || [])]
      const staged = []
      const seen = new Set()
      for (const f of logs) {
        if (!f?.path) continue
        if (this.forbidden(f.path)) { staged.push({ name: f.name, source: f.path, refused: 'forbidden path' }); continue }
        let real = f.path
        try { real = await fsp.realpath(f.path) } catch { staged.push({ name: f.name, source: f.path, missing: true }); continue }
        if (seen.has(real)) continue
        seen.add(real)
        const dest = path.join(d, `${String(files.length).padStart(2, '0')}-${path.basename(f.name).replace(/[^\w.@+-]/g, '_')}`)
        const r = await copyTail(real, dest, f.tailBytes || this.tailBytes)
        if (!r) { staged.push({ name: f.name, source: f.path, missing: true }); continue }
        files.push({ name: f.name, path: dest })
        staged.push({ name: f.name, source: f.path, original_size: r.size, truncated: r.truncated, mtime: r.mtime })
      }
      for (const [name, bin, args] of cmds) {
        const r = await runToParts(bin, args, d, name.replace(/\.\w+$/, ''), { partBytes: Infinity, maxParts: 1, timeoutMs: 20_000 })
        if (r.parts[0]) files.push({ name, path: r.parts[0], tailBytes: 4 * MB })
      }
      for (const t of texts) {
        const dest = path.join(d, `${String(files.length).padStart(2, '0')}-${t.name}`)
        await fsp.writeFile(dest, t.text)
        files.push({ name: t.name, path: dest })
      }
      if (staged.length) manifest.notes = { ...(manifest.notes || {}), sources: staged }
      const job = { id, kind: manifest.kind, reason: manifest.reason, created_at: new Date(this.now()).toISOString(), dir: d, manifest, files, hash }
      await fsp.writeFile(path.join(d, 'job.json'), JSON.stringify(job))
      job.extraSecrets = extraSecrets   // memory only: never on disk
      this.jobs.push(job)
      this.stats.queued++
      this.log.info(`telemetry: queued ${job.kind}/${job.reason} ${id.slice(0, 8)}${manifest.instance ? ` for ${manifest.instance}` : ''}${manifest.match_id ? ` (${manifest.match_id})` : ''}: ${files.length} file(s)`)
      this.pump()
      return id
    })().catch((e) => { this.log.warn(`telemetry: staging ${id.slice(0, 8)} failed: ${e.message}`); return null })
    this.pendingStages.add(p)
    p.finally(() => this.pendingStages.delete(p))
    return p
  }

  /** Wait (at most `ms`) for anything still being staged: the agent's shutdown path. */
  async flush(ms = 5000) {
    const all = Promise.all([...this.pendingStages])
    await Promise.race([all, new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })])
  }

  /** Build in a niced child; `inProcessBuild` (tests) builds here. */
  runBuild(spec) {
    if (this.inProcessBuild) return buildBundle(spec)
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let child
      try {
        child = spawn(process.execPath, [BUILD_JS, '--build-from-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (e) { resolve({ ok: false, error: e.message }); return }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 5 * 60_000)
      timer.unref?.()
      child.on('spawn', () => { try { os.setPriority(child.pid, 19) } catch { /* best effort */ } })
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { if (err.length < 4000) err += d })
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = out.trim().split('\n').pop()
        try { resolve(JSON.parse(line)) } catch { resolve({ ok: false, error: `builder exited ${code}: ${(err || out).slice(0, 300)}` }) }
      })
      child.stdin.on('error', () => { /* child died early; close handles it */ })
      child.stdin.end(JSON.stringify(spec))
    })
  }

  specFor(job, { small = false } = {}) {
    const secrets = [...new Set([...(this.secrets() || []), ...(job.extraSecrets || [])].filter((s) => s && String(s).length >= 6).map(String))]
    const files = job.files.map((f) => ({ ...f, tailBytes: small ? 2 * MB : f.tailBytes }))
    const manifest = small ? { ...job.manifest, notes: { ...(job.manifest.notes || {}), rebuilt_after_413: true } } : job.manifest
    return { out: path.join(this.outbox, `${job.id}.tar.gz`), manifest, files, secrets, level: 6, hash: small ? [] : job.hash }
  }

  async buildNext() {
    if (this.building || !this.jobs.length) return false
    if (this.busy()) return false
    const job = this.jobs.shift()
    this.building = true
    try {
      const r = await this.runBuild(this.specFor(job))
      if (!r?.ok) throw new Error(r?.error || 'build failed')
      const side = {
        bundle_id: job.id, kind: job.kind, reason: job.reason, file: `${job.id}.tar.gz`, bytes: r.bytes,
        created_at: job.created_at, attempts: 0, next_at: this.now(), last_status: null, last_error: null,
        rebuilt: false, staging: job.dir, scrub_hits: r.scrub_hits,
      }
      this.writeSidecar(this.outbox, side)
      if (job.extraSecrets?.length) this.jobSecrets.set(job.id, job.extraSecrets)
      this.stats.built++
      this.log.info(`telemetry: built ${job.kind}/${job.reason} ${job.id.slice(0, 8)}: ${(r.bytes / 1024).toFixed(0)} KB, ${r.files.length} file(s), ${Object.values(r.scrub_hits || {}).reduce((a, b) => a + b, 0)} scrub hit(s)`)
      return true
    } catch (e) {
      this.stats.failed_builds++
      job.failures = (job.failures || 0) + 1
      this.log.warn(`telemetry: build ${job.id.slice(0, 8)} failed (${e.message})${job.failures < 3 ? ' - will try again' : ' - giving up on it'}`)
      if (job.failures < 3) this.jobs.push(job)
      else fs.rmSync(job.dir, { recursive: true, force: true })
      return false
    } finally { this.building = false }
  }

  get jobSecrets() { return (this._jobSecrets ||= new Map()) }

  // ---- the outbox ---------------------------------------------------------------------------
  writeSidecar(dir, side) {
    const f = path.join(dir, `${side.bundle_id}.json`)
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(side, null, 2))
    fs.renameSync(`${f}.tmp`, f)
  }

  sidecars(dir = this.outbox) {
    const out = []
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) } catch { /* half written */ }
      }
    } catch { /* no dir */ }
    return out
  }

  dropBundle(side, dir = this.outbox) {
    for (const f of [path.join(dir, `${side.bundle_id}.json`), path.join(dir, side.file || `${side.bundle_id}.tar.gz`)]) fs.rmSync(f, { force: true })
    if (side.staging) fs.rmSync(side.staging, { recursive: true, force: true })
    this.jobSecrets.delete(side.bundle_id)
  }

  /** Kick the build queue and the uploader. Cheap; safe to call from anywhere. */
  pump() {
    if (this.pumping) return
    this.pumping = true
    ;(async () => {
      try {
        while (await this.buildNext()) { /* build everything that is due, one at a time */ }
        while (await this.uploadNext()) { /* and send, one at a time */ }
      } catch (e) { this.log.warn(`telemetry: ${e.message}`) } finally {
        this.pumping = false
        // A job that arrived while we were uploading is not left for the 30 s timer.
        if (this.jobs.length && !this.building && !this.busy()) { clearTimeout(this.pumpSoon); this.pumpSoon = setTimeout(() => this.pump(), 1000); this.pumpSoon.unref?.() }
      }
    })()
  }

  /** Send the most overdue bundle. -> true when one was sent/settled and another may be due. */
  async uploadNext() {
    if (this.uploading || !this.site) return false
    if (this.busy()) return false
    const now = this.now()
    const due = this.sidecars().filter((s) => (s.next_at || 0) <= now).sort((a, b) => (a.next_at || 0) - (b.next_at || 0) || String(a.created_at).localeCompare(String(b.created_at)))
    const side = due[0]
    if (!side) return false
    const file = path.join(this.outbox, side.file)
    if (!fs.existsSync(file)) { this.dropBundle(side); return true }
    this.uploading = true
    const tag = `${side.kind}/${side.reason} ${side.bundle_id.slice(0, 8)}`
    try {
      let r
      try {
        r = await this.site.uploadTelemetry(file, { bundleId: side.bundle_id, kind: side.kind, reason: side.reason, bytesPerSec: this.uploadBps })
      } catch (e) {
        this.stats.upload_errors++
        this.retryLater(side, `network: ${e.message}`)
        this.log.info(`telemetry: ${tag} not sent (${e.message}); attempt ${side.attempts}, next in ${Math.round((side.next_at - this.now()) / 60_000)} min`)
        return false
      }
      side.last_status = r.status
      if (r.status >= 200 && r.status < 300) {
        this.dropBundle(side)
        this.stats.sent++
        this.log.info(`telemetry: sent ${tag} (${(side.bytes / 1024).toFixed(0)} KB)${r.json?.duplicate ? ' - the site already had it' : ''}${r.json?.severity != null ? `, severity ${r.json.severity}` : ''}${r.json?.flags?.length ? `, flags ${r.json.flags.join(',')}` : ''}`)
        return true
      }
      if (r.status === 400) {
        // Not a bundle, says the site. Never retried; kept aside for a human.
        side.last_error = `400 ${r.json?.error || r.text || ''}`.trim()
        side.rejected_at = new Date(this.now()).toISOString()
        fs.renameSync(file, path.join(this.rejectedDir, side.file))
        if (side.staging) { fs.rmSync(side.staging, { recursive: true, force: true }); side.staging = null }
        this.writeSidecar(this.rejectedDir, side)
        fs.rmSync(path.join(this.outbox, `${side.bundle_id}.json`), { force: true })
        this.stats.rejected++
        this.log.warn(`telemetry: the site REFUSED ${tag} (${side.last_error}); kept in ${this.rejectedDir}, not retried`)
        return true
      }
      if (r.status === 413 && !side.rebuilt && side.staging && fs.existsSync(path.join(side.staging, 'job.json'))) {
        const job = JSON.parse(fs.readFileSync(path.join(side.staging, 'job.json'), 'utf8'))
        job.extraSecrets = this.jobSecrets.get(side.bundle_id) || []
        const b = await this.runBuild(this.specFor(job, { small: true }))
        if (!b?.ok) {
          side.rebuilt = true   // one try; the next 413 sends it to rejected/
          this.retryLater(side, `413, and the rebuild failed: ${b?.error}`)
          this.log.warn(`telemetry: ${tag}: ${side.last_error}`)
          return false
        }
        this.log.warn(`telemetry: ${tag} was too big for the site (${(side.bytes / MB).toFixed(1)} MB); rebuilt at ${(b.bytes / MB).toFixed(1)} MB with 2 MB tails and no hashes`)
        Object.assign(side, { rebuilt: true, bytes: b.bytes, next_at: this.now(), last_error: '413' })
        this.writeSidecar(this.outbox, side)
        return true
      }
      if (r.status === 413) {
        side.last_error = '413 after a rebuild'
        fs.renameSync(file, path.join(this.rejectedDir, side.file))
        this.writeSidecar(this.rejectedDir, side)
        fs.rmSync(path.join(this.outbox, `${side.bundle_id}.json`), { force: true })
        if (side.staging) fs.rmSync(side.staging, { recursive: true, force: true })
        this.stats.rejected++
        this.log.warn(`telemetry: ${tag} still too big after a rebuild; moved to ${this.rejectedDir}`)
        return true
      }
      if (r.status === 429) {
        side.attempts = (side.attempts || 0) + 1
        side.next_at = this.now() + (r.retryAfterMs ?? BACKOFF_MS[Math.min(side.attempts - 1, BACKOFF_MS.length - 1)])
        side.last_error = '429'
        this.writeSidecar(this.outbox, side)
        this.log.info(`telemetry: ${tag}: the site says slow down (429); next in ${Math.round((side.next_at - this.now()) / 1000)} s`)
        return false
      }
      this.retryLater(side, `${r.status} ${r.json?.error || r.text || ''}`.trim())
      this.log.info(`telemetry: ${tag} not taken (${side.last_error}); attempt ${side.attempts}, next in ${Math.round((side.next_at - this.now()) / 60_000)} min`)
      return false
    } finally { this.uploading = false }
  }

  retryLater(side, why) {
    side.attempts = (side.attempts || 0) + 1
    side.next_at = this.now() + BACKOFF_MS[Math.min(side.attempts - 1, BACKOFF_MS.length - 1)]
    side.last_error = String(why).slice(0, 300)
    try { this.writeSidecar(this.outbox, side) } catch (e) { this.log.warn(`telemetry: sidecar: ${e.message}`) }
  }

  /** At most maxAge and maxBytes on the box, outbox + rejected + staging, oldest out first. */
  async retention() {
    const now = this.now()
    const items = []
    for (const [dir, where] of [[this.outbox, 'outbox'], [this.rejectedDir, 'rejected']]) {
      for (const s of this.sidecars(dir)) {
        let bytes = 0
        try { bytes += (await fsp.stat(path.join(dir, s.file))).size } catch { /* gone */ }
        if (s.staging) bytes += await dirBytes(s.staging)
        items.push({ at: Date.parse(s.created_at) || 0, bytes, drop: () => this.dropBundle(s, dir), what: `${where} ${s.kind}/${s.reason} ${s.bundle_id.slice(0, 8)}` })
      }
    }
    for (const j of this.jobs) {
      const bytes = await dirBytes(j.dir)
      items.push({ at: Date.parse(j.created_at) || 0, bytes, drop: () => { this.jobs = this.jobs.filter((x) => x !== j); fs.rmSync(j.dir, { recursive: true, force: true }) }, what: `unbuilt ${j.kind}/${j.reason} ${j.id.slice(0, 8)}` })
    }
    items.sort((a, b) => a.at - b.at)
    let total = items.reduce((n, i) => n + i.bytes, 0)
    let dropped = 0
    for (const i of items) {
      const old = now - i.at > this.maxAgeMs
      if (!old && total <= this.maxBytes) break
      try { i.drop(); total -= i.bytes; dropped++ } catch { /* next */ }
      this.log.warn(`telemetry: dropped ${i.what} (${old ? 'older than the keep window' : 'over the size cap'})`)
    }
    return { dropped, total }
  }

  info() {
    return { dir: this.dir, outbox: this.sidecars().length, jobs: this.jobs.length, building: this.building, uploading: this.uploading, journal_last: this.state.journal_last, ...this.stats }
  }
}

/** Hash a file (the box DLL), cached by path + size + mtime. */
const dllCache = new Map()
export async function hashFileCached(p) {
  const st = await fsp.stat(p)
  const key = `${p}|${st.size}|${st.mtimeMs}`
  if (dllCache.has(key)) return dllCache.get(key)
  const h = crypto.createHash('sha256')
  for await (const c of fs.createReadStream(p)) h.update(c)
  const sha = h.digest('hex')
  dllCache.set(key, sha)
  return sha
}
