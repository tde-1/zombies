// Per-instance CPU and RAM sampling.
//
// The number the whole cost model turns on is "cores per game" (vault 14: target ≤ 0.5
// core average, pass ≤ 0.4 with drawing skipped), so the host agent measures it itself
// rather than trusting a one-off look at Task Manager.
//
// Windows: ONE long-lived PowerShell child reads PID lists on stdin and prints JSON. A
// fresh `powershell.exe` per sample costs ~0.1 core-seconds, which is a measurable
// fraction of the thing we are trying to measure — hence the persistent worker.
// Linux/macOS: /proc/<pid>/stat, or `ps` as a fallback (for the Wine boxes later).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { makeLog } from './util.js'

const CORES = os.cpus().length
const isWin = process.platform === 'win32'

const PS_LOOP = `
$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $out = @()
  foreach ($id in ($line -split ',')) {
    $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
    if ($p) {
      $out += [pscustomobject]@{ pid=$p.Id; cpu=$p.TotalProcessorTime.TotalSeconds; ws=$p.WorkingSet64; pm=$p.PrivateMemorySize64; th=$p.Threads.Count }
    }
  }
  Write-Output (ConvertTo-Json -Compress -Depth 3 -InputObject @($out))
}
`

export class ProcSampler {
  constructor({ log } = {}) {
    this.log = log || makeLog('procstat')
    this.prev = new Map()     // pid -> { cpuSec, at }
    this.child = null
    this.pending = null
    this.buf = ''
    this.broken = false
  }

  startWorker() {
    if (this.child || !isWin || this.broken) return
    try {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LOOP], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      })
      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (d) => {
        this.buf += d
        let nl
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim()
          this.buf = this.buf.slice(nl + 1)
          if (!line) continue
          const p = this.pending; this.pending = null
          if (!p) continue
          try { p.resolve(JSON.parse(line)) } catch { p.resolve([]) }
        }
      })
      this.child.on('exit', () => { this.child = null; const p = this.pending; this.pending = null; p?.resolve([]) })
      this.child.on('error', (e) => { this.log.warn(`sampler worker: ${e.message}`); this.broken = true; this.child = null })
    } catch (e) { this.log.warn(`sampler worker: ${e.message}`); this.broken = true }
  }

  stop() { try { this.child?.stdin.end(); this.child?.kill() } catch { /* gone */ } this.child = null }

  async rawWin(pids) {
    this.startWorker()
    if (!this.child) return []
    if (this.pending) return []          // one sample in flight at a time
    return new Promise((resolve) => {
      const to = setTimeout(() => { if (this.pending) { this.pending = null; resolve([]) } }, 4000)
      this.pending = { resolve: (v) => { clearTimeout(to); resolve(v) } }
      try { this.child.stdin.write(pids.join(',') + '\n') } catch { this.pending = null; clearTimeout(to); resolve([]) }
    })
  }

  rawPosix(pids) {
    const hz = 100 // USER_HZ; near-universal on Linux
    const out = []
    for (const pid of pids) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const rp = st.slice(st.lastIndexOf(')') + 2).split(' ')
        const utime = Number(rp[11]), stime = Number(rp[12]), rss = Number(rp[21])
        const bytes = rss * 4096
        out.push({ pid, cpu: (utime + stime) / hz, ws: bytes, pm: bytes, th: Number(rp[17]) })
      } catch { /* process gone */ }
    }
    return out
  }

  /**
   * Sample a set of PIDs. Returns pid -> { cpuPct, cores, rssBytes, threads }.
   * cpuPct is of ONE core (so 150 means 1.5 cores); `cores` is the same as a fraction.
   */
  async sample(pids) {
    if (!pids.length) return new Map()
    const rows = isWin ? await this.rawWin(pids) : this.rawPosix(pids)
    const at = Date.now()
    const out = new Map()
    for (const r of rows) {
      const prev = this.prev.get(r.pid)
      let cores = null
      if (prev && at > prev.at) cores = Math.max(0, (r.cpu - prev.cpuSec) / ((at - prev.at) / 1000))
      this.prev.set(r.pid, { cpuSec: r.cpu, at })
      out.set(r.pid, {
        pid: r.pid,
        cores,
        cpuPct: cores == null ? null : cores * 100,
        boxPct: cores == null ? null : (cores / CORES) * 100,
        rssBytes: r.ws,
        privateBytes: r.pm,
        threads: r.th,
        cpuSecTotal: r.cpu,
      })
    }
    for (const pid of [...this.prev.keys()]) if (!pids.includes(pid)) this.prev.delete(pid)
    return out
  }
}

export const hostInfo = () => ({
  platform: process.platform,
  cores: CORES,
  cpu: os.cpus()[0]?.model || 'unknown',
  totalMemBytes: os.totalmem(),
  hostname: os.hostname(),
  node: process.version,
})
